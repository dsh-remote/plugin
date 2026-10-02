/**
 * server — 零知识 WebSocket 中继的装配：http + ws + 控制面分发 + 清扫 + 停机。
 *
 * 结构上的零知识由三件事共同保证，缺一不可：
 * 1. 本进程不 import 任何密码学模块（`dsh-remote-wire/record`、`tweetnacl` 都不在依赖图里；
 *    `tests/bundle.test.mjs` 会直接断言打出来的单文件里没有 xsalsa20/secretbox 痕迹）；
 * 2. 数据面帧的 `ciphertext` 只被搬运，中继只读它的**字符集**（拒非法 base64）；
 * 3. 日志字段类型只允许标量（见 `log.ts`），控制面里出现的只有 id / 计数 / 配对码 / label。
 *
 * 与旧实现的四条行为差异（全部经用户拍板，docs/DESIGN.md §4、§8）：
 * D1 不接收 PSK、D2 配对码不落 info 日志、D3 客户端断开不删会话、
 * D4 转发前校验发送方是会话成员、D5 `auth` 并入 `hello`、D6 主机断开有宽限期。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import {
  base64Text,
  parseEndpointFrame,
  type EndpointFrame,
  type ErrorCode,
  type RelayFrame,
} from 'dsh-remote-wire/frames'
import { newHostId } from 'dsh-remote-wire/ids'
import {
  encBatchToClient,
  encToClient,
  helloOkForClient,
  helloOkForHost,
  makeError as makeErrorFrame,
  pairFail as pairFailFrameOf,
  pairReady as pairReadyFrameOf,
  paired as pairedFrameOf,
  peerJoinedForHost,
  peerJoinedNotice,
  peerLeft as peerLeftFrame,
  pong as pongFrameOf,
} from 'dsh-remote-wire/outbound'
import type { RelayConfig } from './config.js'
import { BackpressureGate, Budget, FrameRateGate } from './limits.js'
import { Log, REDACTED } from './log.js'
import { RelayState, WS_OPEN, type Sock } from './state.js'

const SHUTDOWN_FORCE_MS = 5000
/** 保留的自定义关闭码：同 hostId 顶号。客户端的重连策略不认识它，只对主机有意义。 */
const CLOSE_REPLACED = 4000

interface Peer {
  ws: WebSocket
  role: 'unknown' | 'host' | 'client'
  hostId?: string
  clientId?: string
  rate: FrameRateGate
  authAttempts: number
  /** 本连接上失败的配对尝试次数（用尽即 4008 断开）。成功一次就清零。 */
  pairAttempts: number
  /** 对端 socket 缓冲区持续超限的计时（慢消费者处置）；窗口按角色给，见 noteBackpressure。 */
  backpressure: BackpressureGate
  alive: boolean
}

export interface RelayHandle {
  http: Server
  wss: WebSocketServer
  state: RelayState
  log: Log
  health(): Record<string, string | number | boolean>
  /** 优雅停机：向所有对端发 1001，等在途连接结束。 */
  close(): Promise<void>
  startListening(): Promise<{ port: number; bind: string }>
}

/** 定时安全比较：host token 是唯一凭据，别把长度与时序泄露出去。 */
function tokenMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(got, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function createRelay(config: RelayConfig): RelayHandle {
  const log = new Log(config.logLevel)
  const state = new RelayState({ maxPendingPairs: config.maxPendingPairs })
  const startedAt = Date.now()
  const pairBudget = new Budget(config.pairGlobalBudgetPerSec)
  const peers = new WeakMap<WebSocket, Peer>()
  let shuttingDown = false
  let sweepTimer: NodeJS.Timeout | undefined
  let lastPingAt = 0

  /**
   * 诊断计数（复核 A8）。`/healthz` 是运维唯一的观测面，而"帧被丢了""谁把谁踢了"
   * 以前只进日志——线上排"为什么手机不更新"时只能翻 journalctl。
   *
   * 三条都**只增不减**：它们是"自本次启动以来发生过多少次"，不是状态快照，
   * 所以不复用 `state.counts()`（那是瞬时值，会随连接进出上下浮动）。
   * 归零只发生在进程重启，这本身就是有意义的判据（"重启后计数没动"证明症状是存量问题）。
   *
   * - `droppedFrames`：中继**收下却没送出去**的帧（收件人不在），即 R1 那个静默黑洞的可见面。
   *   注意它不含路由被拒（`unknown_session`/`not_member`）——那些会回错误给发送方，不静默。
   * - `slowConsumers`：因发送缓冲超限被 1008 断开的对端。
   * - `rejectedPairs`：中继回过 `pair-fail` 的配对尝试次数（码错/过期/已用过/额度耗尽）。
   */
  const counters = { droppedFrames: 0, slowConsumers: 0, rejectedPairs: 0 }

  // ── 发送 ────────────────────────────────────────────────────────────

  function sendTo(sock: Sock | undefined, frame: RelayFrame | Record<string, unknown>): void {
    if (!sock || sock.readyState !== WS_OPEN) return
    try {
      sock.send(JSON.stringify(frame))
    } catch (e) {
      log.warn('send failed', { message: String((e as Error)?.message ?? e) })
    }
  }

  function sendToPeer(peer: Peer | undefined, frame: RelayFrame | Record<string, unknown>): void {
    if (peer) sendTo(peer.ws, frame)
  }

  /**
   * 发给手机侧的**每一条 error 都必须带中文 message**（复核 R2）。
   * 客户端对未知 code 的处理是 `f.message || f.code`，没有 message 就是一条
   * 40 字宽的英文 toast——用户既看不懂也没有下一步。
   */
  const CLIENT_ERROR_TEXT: Partial<Record<ErrorCode, string>> = {
    unknown_session: '会话已失效，请重新扫码配对',
    not_member: '这条指令不属于当前会话，请重新配对',
    host_unavailable: '主机暂时不在线，请稍后重试',
    rate_limited: '操作太快，请稍后再试',
    bad_frame: '有一帧数据不合法，已丢弃',
    bad_json: '收到无法解析的数据，已丢弃',
    unknown_frame: '对端版本不认识这个帧',
    pair_table_full: '配对表已满，请稍后再试',
    need_client: '需要先从手机侧发起配对',
    internal: '中继内部错误',
  }

  function sendError(peer: Peer | undefined, code: ErrorCode, message?: string): void {
    const text = message ?? (peer?.role === 'client' ? CLIENT_ERROR_TEXT[code] : undefined)
    sendToPeer(peer, makeErrorFrame(code, text))
  }

  /**
   * 慢消费者：发送缓冲**连续**超限达到**本角色的窗口**才断开，而不是无限堆积把中继内存吃掉。
   *
   * 两个关键点都是 DESIGN-REVIEW 第 11 条读码取证出来的（窗口的推导见 limits.ts）：
   * 1. 判定必须**定时驱动**（由 `sweep()` 调），不能只挂在 `ws.on('message')` 上：
   *    静默的慢客户端从不发帧，挂在入站路径上等于永不评估、缓冲区一直挂着；
   *    而"爱说话"的慢客户端反而被踢——判定挂错了地方，结果刚好是反的。
   * 2. 窗口必须**按角色给**：客户端侧的对端是"断开即重连"且 `onOpen` 会把退避清零，
   *    窗口短于它的重连周期就形成永不升级的 ~11s 抖动；而手机不读关闭码，
   *    用户只看到一句"连接已断开，正在重连…"，永远等不到恢复。
   */
  function noteBackpressure(peer: Peer, now: number): void {
    const buffered = (peer.ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0
    const windowMs = peer.role === 'client' ? config.slowConsumerClientMs : config.slowConsumerHostMs
    const verdict = peer.backpressure.check(buffered, config.maxBufferedBytes, now, windowMs)
    if (!verdict.shouldClose) return
    counters.slowConsumers += 1
    log.warn('slow consumer disconnected', {
      clientId: peer.clientId,
      hostId: peer.hostId,
      role: peer.role,
      buffered,
      overMs: verdict.overMs,
    })
    peer.ws.close(1008, 'slow_consumer')
  }

  // ── 控制面 ──────────────────────────────────────────────────────────

  function handleHello(peer: Peer, frame: Extract<EndpointFrame, { t: 'hello' }>): void {
    if (frame.role === 'host') {
      if (!config.hostToken) {
        sendError(peer, 'internal', 'relay has no host token configured')
        peer.ws.close(1011)
        return
      }
      if (!frame.token || !tokenMatches(config.hostToken, frame.token)) {
        peer.authAttempts += 1
        // 只记"第几次失败"，绝不记token 的任何片段。
        log.warn('host auth failed', { attempts: peer.authAttempts })
        sendError(peer, 'bad_token')
        if (peer.authAttempts >= config.maxHostAuthAttempts) peer.ws.close(4001, 'too_many_auth_attempts')
        return
      }
      const hostId = frame.hostId?.trim() || newHostId()
      const { replaced } = state.attachHost(hostId, peer.ws, frame.label ?? '')
      peer.role = 'host'
      peer.hostId = hostId
      sendToPeer(peer, helloOkForHost(hostId, frame.protocol))
      log.info('host online', { hostId, label: frame.label ?? '', replaced: replaced ? 1 : 0 })
      if (replaced) replaced.close(CLOSE_REPLACED, 'replaced_by_newer_socket')
      // 主机重连：把它名下的会话作为"有对端在听"的通知重放给已连接的客户端，
      // 让客户端知道可以继续用原 convId（D3/D6 的续用面）。
      for (const conversationId of state.conversationIdsForHost(hostId)) {
        for (const sock of state.clientSockets(conversationId)) {
          sendTo(sock, { t: 'peer-joined', sessionId: conversationId, clientId: hostId })
        }
      }
      return
    }

    if (frame.role === 'client') {
      // 客户端自带 clientId 时**原样保留**：小程序冷启动后仍会用存储里那个 installId，
      // 若这里另发一个，D3 的重挂与 D4 的成员校验会在下次冷启动时永远对不上。
      const clientId = frame.clientId?.trim() || randomUUID()
      const { replaced } = state.attachClient(clientId, peer.ws, frame.clientMeta)
      peer.role = 'client'
      peer.clientId = clientId
      if (replaced) {
        // 复核 R3：同 clientId 的旧连接必须被顶掉，否则真手机的 socket 还"开着"
        // 却再也收不到路由，而且因为它不觉得断开，也不会重连。
        log.warn('client replaced by newer socket', { clientId })
        replaced.close(CLOSE_REPLACED, 'replaced_by_newer_socket')
      }
      sendToPeer(peer, helloOkForClient(clientId, frame.protocol))
      log.info('client online', { clientId, platform: frame.clientMeta?.platform })
      return
    }

    sendError(peer, 'bad_role')
  }

  function handlePairBegin(peer: Peer, frame: Extract<EndpointFrame, { t: 'pair-begin' }>): void {
    if (peer.role !== 'host' || !peer.hostId) {
      sendError(peer, 'need_host')
      return
    }
    const issued = state.issuePair(peer.hostId, frame.pairingToken, config.pairTtlMs)
    if (!issued.ok) {
      sendError(peer, 'pair_table_full')
      log.warn('pair table full', { hostId: peer.hostId })
      return
    }
    // **服务端权威 TTL**：主机必须据此改写本地过期时间（旧实现的第一起事故）。
    sendToPeer(peer, pairReadyFrameOf(frame.pairingToken, config.pairTtlMs))
    // D2：info 级不落完整配对码。需要排错时开 debug。
    log.info('pair token issued', { hostId: peer.hostId, token: REDACTED, ttlMs: config.pairTtlMs })
    log.debug('pair token issued (debug)', { hostId: peer.hostId, pairingToken: frame.pairingToken })
  }

  function handlePairClaim(peer: Peer, frame: Extract<EndpointFrame, { t: 'pair-begin-client' }>): void {
    if (peer.role !== 'client' || !peer.clientId) {
      sendError(peer, 'need_client')
      return
    }
    if (!pairBudget.take(Date.now())) {
      // 手机上 `translatePairFail` 只认四个 reason（F6 的冻结消费面），所以我们不能把
      // 内部原因 `rate_limited` 直接写进 pair-fail —— 那会把英文字面量弹给用户。
      // 对用户有意义且成立的只有"这张码现在配不上"，真正的限速原因进日志给运维。
      counters.rejectedPairs += 1
      sendToPeer(peer, pairFailFrameOf('invalid_or_expired'))
      log.warn('pair budget exhausted (global)', { clientId: peer.clientId, reason: 'rate_limited' })
      return
    }
    const claimed = state.claim(frame.pairingToken, peer.clientId)
    if (!claimed.ok) {
      peer.pairAttempts += 1
      counters.rejectedPairs += 1
      sendToPeer(peer, pairFailFrameOf(claimed.reason))
      log.info('pair failed', {
        clientId: peer.clientId,
        reason: claimed.reason,
        attemptsLeft: Math.max(0, config.maxPairAttemptsPerConn - peer.pairAttempts),
      })
      if (peer.pairAttempts >= config.maxPairAttemptsPerConn) {
        peer.ws.close(4008, 'too_many_pair_attempts')
      }
      return
    }
    peer.pairAttempts = 0
    // 同一台手机重配到新会话时，它在旧会话里的成员记录已经被 claim 摘掉了（🟡7）。
    // 这里补上对旧主机的告知：与"客户端显式 session-leave"走同一条通知（`peer-left`），
    // 主机才知道少了这个观众，不必再往那个会话里推。（会话本身仍归主机。）
    for (const old of claimed.detached) {
      sendTo(state.hostSocket(old), peerLeftFrame(old, peer.clientId))
    }
    sendToPeer(peer, pairedFrameOf(claimed.conversationId, claimed.hostId))
    // 发给主机的那一条**必须带 pairingToken**：主机按它取自己那份 PSK（多码并存事故）。
    sendToPeer(peerOfHost(claimed.hostId), peerJoinedForHost(claimed.conversationId, peer.clientId, frame.pairingToken))
    log.info('paired', {
      sessionId: claimed.conversationId,
      hostId: claimed.hostId,
      clientId: peer.clientId,
      ...(claimed.detached.length > 0 ? { detachedFrom: claimed.detached.length } : {}),
    })
  }

  function peerOfHost(hostId: string): Peer | undefined {
    const entry = state.hosts.get(hostId)
    return entry ? peers.get(entry.ws as unknown as WebSocket) : undefined
  }

  // ── 数据面 ──────────────────────────────────────────────────────────

  function forwardEnc(peer: Peer, frame: Extract<EndpointFrame, { t: 'enc' }>): void {
    const rejected = state.routeFrom(frame.sessionId, peer.ws, peer.role)
    if (rejected) {
      sendError(peer, rejected)
      if (rejected === 'not_member') log.warn('enc from non-member', { sessionId: frame.sessionId })
      return
    }
    if (peer.role === 'client') {
      // 上行：原样透传给主机，并补上"是哪个客户端"（主机按它做 per-client 回调）。
      const host = state.hostSocket(frame.sessionId)
      if (!host) {
        // 会话还在、主机暂时不在（宽限期内）。这里**绝不能**回 `unknown_session`——
        // 客户端见到它就会丢配对、要求重新扫码，而它只要等主机回来再发一次即可。
        counters.droppedFrames += 1
        sendError(peer, 'host_unavailable')
        return
      }
      sendTo(host, {
        t: 'enc',
        sessionId: frame.sessionId,
        seq: frame.seq,
        clientId: peer.clientId,
        ciphertext: frame.ciphertext,
      })
      state.touchConversation(frame.sessionId)
      return
    }
    // 下行：中继重新编号（客户端不信 seq 的单调性，但编号让审计与合并可写）。
    const seq = state.nextHostSequence(frame.sessionId)
    const sockets = state.clientSockets(frame.sessionId)
    // 会话还在、一个观众都没有：这一帧没有收件人。**必须计数**——R1 的静默黑洞
    // 就是"主机往一个没有钥匙的对端推"，它在日志里不留痕，只能靠这个计数被发现。
    if (sockets.length === 0) counters.droppedFrames += 1
    for (const sock of sockets) {
      if (seq !== undefined) sendTo(sock, encToClient(frame.sessionId, seq, frame.ciphertext))
    }
  }

  function forwardEncBatch(peer: Peer, frame: Extract<EndpointFrame, { t: 'enc-batch' }>): void {
    const rejected = state.routeFrom(frame.sessionId, peer.ws, peer.role)
    if (rejected) {
      sendError(peer, rejected)
      return
    }
    // 小程序逐项只读 `items[i].ciphertext` 并复用外层 sessionId，所以外层必须保持单个。
    const clients = state.clientSockets(frame.sessionId)
    if (peer.role === 'client') {
      const host = state.hostSocket(frame.sessionId)
      if (!host) {
        counters.droppedFrames += 1
        state.touchConversation(frame.sessionId)
        return
      }
      sendTo(host, { t: 'enc-batch', sessionId: frame.sessionId, items: frame.items })
      state.touchConversation(frame.sessionId)
      return
    }
    // 下行批量帧由中继逐条编号（客户端只看 ciphertext，但编号让"帧数不膨胀、顺序不乱"
    // 这类审计断言可写）。编号失败说明会话在飞行中被删了——那这一批就不该再发出去。
    if (clients.length === 0) counters.droppedFrames += 1
    const items: Array<{ seq: number; ciphertext: string }> = []
    for (const item of frame.items) {
      const seq = state.nextHostSequence(frame.sessionId)
      if (seq === undefined) return
      items.push({ seq, ciphertext: item.ciphertext })
    }
    for (const sock of clients) sendTo(sock, encBatchToClient(frame.sessionId, items))
  }

  function handleFrame(peer: Peer, frame: EndpointFrame): void {
    switch (frame.t) {
      case 'hello':
        return handleHello(peer, frame)
      case 'pair-begin':
        return handlePairBegin(peer, frame)
      case 'pair-begin-client':
        return handlePairClaim(peer, frame)
      case 'resync': {
        // 复核 R1：主机(重)启动后声明它还持有密钥的会话。
        // 没列出的会话直接删掉，**不发 peer-left**——客户端下次发帧会撞上
        // unknown_session，从而得到中文的"会话已失效，请重新配对"提示。
        if (peer.role !== 'host' || !peer.hostId) {
          sendError(peer, 'need_host')
          return
        }
        const { kept, dropped } = state.resync(peer.hostId, frame.sessionIds)
        if (dropped.length > 0)
          log.info('conversations dropped at host resync', { hostId: peer.hostId, kept, dropped: dropped.length })
        return
      }
      case 'enc':
        return forwardEnc(peer, frame)
      case 'enc-batch':
        return forwardEncBatch(peer, frame)
      case 'session-leave': {
        /**
         * 两条完全不同的路，共用一帧（复核 R1）：
         * - 客户端发：它离开这个会话，主机收到 peer-left 只是"少了一个观众"，会话保留；
         * - 主机发：**作废**这个会话。主机重启后密钥没了、或它连续解不开某一会话时走这条。
         *   此时必须向该会话的所有客户端发 peer-left，手机才会中文提示"主机已断开，
         *   请重新配对"并停在这里等用户，而不是继续把密文发给一个没有钥匙的对端
         *   ——那才是真正的静默黑洞。
         */
        if (peer.role === 'host' && peer.hostId) {
          const conv = state.conversations.get(frame.sessionId)
          if (!conv || conv.hostId !== peer.hostId) return
          const dropped = state.dropConversation(frame.sessionId)
          for (const clientId of dropped?.clientIds ?? []) {
            sendTo(state.clients.get(clientId)?.ws, peerLeftFrame(frame.sessionId, peer.hostId))
          }
          log.info('conversation voided by host', {
            sessionId: frame.sessionId,
            clients: (dropped?.clientIds ?? []).length,
          })
          return
        }
        if (!peer.clientId) {
          sendError(peer, 'need_client')
          return
        }
        const removed = state.leave(peer.clientId, frame.sessionId)
        if (removed) {
          sendTo(state.hostSocket(frame.sessionId), peerLeftFrame(frame.sessionId, peer.clientId))
        }
        return
      }
      case 'ping':
        return sendToPeer(peer, pongFrameOf(frame.ts))
      default:
        return sendError(peer, 'unknown_frame', String((frame as { t?: string }).t))
    }
  }

  // ── 连接生命周期 ────────────────────────────────────────────────────

  function onConnection(ws: WebSocket): void {
    if (shuttingDown) {
      ws.close(1013, 'server_shutdown')
      return
    }
    if (wss.clients.size + 1 > config.maxConnections) {
      ws.close(1013, 'server_busy')
      return
    }
    const peer: Peer = {
      ws,
      role: 'unknown',
      rate: new FrameRateGate(config.maxFramesPerSec),
      authAttempts: 0,
      pairAttempts: 0,
      backpressure: new BackpressureGate(),
      alive: true,
    }
    peers.set(ws, peer)
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      const verdict = peer.rate.check(Date.now())
      if (!verdict.allowed) {
        if (verdict.shouldReport) sendError(peer, 'rate_limited')
        if (verdict.shouldClose) {
          log.warn('frame flood disconnected', { clientId: peer.clientId, hostId: peer.hostId })
          ws.close(1008, 'rate_limited')
        }
        return
      }
      // 帧必须是文本：小程序把 onMessage 的 data 直接交给 JSON.parse，
      // 收到二进制就是静默丢弃。所以这里必须明确拒绝，并且报得比"JSON 坏了"更准。
      if (isBinary) {
        sendError(peer, 'bad_frame', 'binary frames are not supported')
        return
      }
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : undefined
      if (text === undefined) {
        sendError(peer, 'bad_frame', 'unsupported frame payload type')
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        sendError(peer, 'bad_json')
        return
      }
      // 配对码格式不对时给对端一个"用得上的"错误：客户端会把 pair-fail 的 reason
      // 翻成中文文案（F6），而 error{unknown_frame} 只会是一句看不懂的提示。
      const declaredType = (parsed as { t?: unknown } | null)?.t
      if (typeof declaredType === 'string' && !parseEndpointFrame(parsed)) {
        if (declaredType === 'pair-begin-client') {
          counters.rejectedPairs += 1
          sendToPeer(peer, pairFailFrameOf('invalid_or_expired'))
          return
        }
        if (declaredType === 'pair-begin') {
          sendError(peer, 'bad_pair')
          return
        }
      }
      const frame = parseEndpointFrame(parsed)
      if (!frame) {
        // 区分两种"看不懂"：帧名根本不认识（unknown_frame）与
        // 名字对但形状不合法（bad_frame）。手机端会把它们当普通错误提示，
        // 但排错时这个区别很值钱——前者是对端版本不对，后者是它发了坏数据。
        const name = (parsed as { t?: unknown } | null)?.t
        sendError(peer, typeof name === 'string' ? 'unknown_frame' : 'bad_json')
        return
      }
      if ((frame.t === 'enc' || frame.t === 'enc-batch') && !ciphertextsAreBase64(frame)) {
        sendError(peer, 'bad_frame', 'ciphertext must be standard base64')
        return
      }
      try {
        handleFrame(peer, frame)
      } catch (e) {
        log.error('frame handler threw', { t: frame.t, message: String((e as Error)?.message ?? e) })
        sendError(peer, 'internal')
      }
    })
    ws.on('pong', () => {
      peer.alive = true
    })
    ws.on('close', () => {
      peers.delete(ws)
      if (peer.role === 'client' && peer.clientId) {
        for (const notice of state.clientGone(peer.clientId, ws)) {
          sendTo(state.hostSocket(notice.conversationId), peerLeftFrame(notice.conversationId, notice.clientId))
        }
        log.info('client disconnected', { clientId: peer.clientId })
      }
      if (peer.role === 'host' && peer.hostId) {
        // 只有"这个 socket 仍是该主机的活连接"才打离线标记；重连时新 socket 已先注册。
        if (state.hostGone(peer.hostId, ws)) log.info('host offline (grace started)', { hostId: peer.hostId })
      }
    })
    ws.on('error', (e: Error) => log.warn('socket error', { message: String(e?.message ?? e) }))
  }

  /** 密文字符集预检。Buffer 对非法 base64 是静默丢弃，所以这层必须在转发前把关。 */
  function ciphertextsAreBase64(frame: { ciphertext?: string; items?: Array<{ ciphertext: string }> }): boolean {
    const list = frame.items ?? (frame.ciphertext === undefined ? [] : [frame])
    return list.every((item) => base64Text.safeParse(item.ciphertext).success)
  }

  // ── 清扫与保活 ──────────────────────────────────────────────────────

  function sweep(): void {
    const expired = state.expirePairs()
    if (expired.length > 0) log.debug('pair tokens expired', { count: expired.length })
    // 保活只走 WS 层 ping：主机与小程序都不发应用层 ping，改判应用层心跳会
    // 周期性踢掉空闲客户端（取证 relay-and-wireformat.md §5.4）。
    for (const [ws, peer] of peersOfSockets()) {
      if (!peer.alive) {
        log.warn('heartbeat timeout', { clientId: peer.clientId, hostId: peer.hostId })
        ws.terminate()
        continue
      }
      peer.alive = false
      try {
        ws.ping()
      } catch {
        /* 已关闭 */
      }
    }
    lastPingAt = Date.now()
    // 慢消费者判定：**定时驱动**，不看这一轮有没有入站帧（见 noteBackpressure 的注释）。
    // 只对 OPEN 的连接读 bufferedAmount——已关闭的连接读它是无意义的。
    const backpressureAt = Date.now()
    for (const [ws, peer] of peersOfSockets()) {
      if (ws.readyState === WS_OPEN) noteBackpressure(peer, backpressureAt)
    }
    // D6：超过宽限期仍没回来的主机，才真正通知它的客户端重配对。
    for (const dropped of state.expireOfflineHosts(config.hostGraceMs)) {
      // 这里曾经误写成**嵌套两层同一个 clientIds**（外层内层同名），于是每个客户端收到
      // N 条 `peer-left` 而不是 1 条：帧数随成员数平方增长，手机还会把同一次"主机离开"
      // 重复处理。有测试锁住"每个成员恰好一条"。
      for (const clientId of dropped.clientIds) {
        sendTo(state.clients.get(clientId)?.ws, peerLeftFrame(dropped.conversationId, dropped.hostId))
      }
      log.info('host grace expired', { hostId: dropped.hostId, sessions: dropped.conversationId })
    }
    for (const conversationId of state.sweepIdle(config.conversationIdleTtlMs)) {
      log.info('conversation idle-dropped', { sessionId: conversationId })
    }
  }

  function peersOfSockets(): Array<[WebSocket, Peer]> {
    const out: Array<[WebSocket, Peer]> = []
    wss.clients.forEach((ws) => {
      const peer = peers.get(ws)
      if (peer) out.push([ws, peer])
    })
    return out
  }

  // ── HTTP ────────────────────────────────────────────────────────────

  function health(): Record<string, string | number | boolean> {
    return {
      ok: !shuttingDown,
      version: config.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      // 瞬时快照（会上下浮动）与累计计数（只增不减）分开：混在一起会让
      // "手机不更新"这类排查分不清"现在是空的"和"一直送不出去"。
      ...state.counts(),
      ...counters,
      lastPingAgo: lastPingAt === 0 ? -1 : Math.round((Date.now() - lastPingAt) / 1000),
      shuttingDown,
    }
  }

  function httpHandler(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    res.setHeader('content-type', 'application/json; charset=utf-8')
    if (url.pathname === '/healthz') {
      res.end(JSON.stringify(health()))
      return
    }
    if (url.pathname === '/api/info') {
      res.end(JSON.stringify({ publicUrl: config.publicUrl, protocol: 1 }))
      return
    }
    if (url.pathname === '/api/pair-status') {
      // 默认 404：开等于给 6 位码空间装了个免认证的判定 oracle。
      if (!config.pairStatusEnabled) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'not_found' }))
        return
      }
      const token = url.searchParams.get('token') ?? ''
      const entry = state.pendingPairs.get(token)
      res.end(JSON.stringify({ ok: !!entry && !entry.used && entry.expiresAt >= Date.now() }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not_found' }))
  }

  const http = createServer(httpHandler)
  http.headersTimeout = 30_000
  http.requestTimeout = 30_000
  http.keepAliveTimeout = 15_000
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxMessageBytes,
    // 不发库自带的 ping：保活由 sweep() 显式 ping + pong 判活 + terminate 承担，
    // 这样"上一轮没回 pong"这个判据才在我们手里（取证 relay-and-wireformat.md §5.4）。
  })

  http.on('upgrade', (req, socket, head) => {
    if (shuttingDown) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    // 路径不设限：已发布的地址里既有根路径也有 /ws 之类，收窄会让老地址全部连不上。
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })
  wss.on('connection', (ws) => onConnection(ws))

  async function close(): Promise<void> {
    if (sweepTimer) clearInterval(sweepTimer)
    shuttingDown = true
    wss.clients.forEach((ws) => ws.close(1001, 'server_shutdown'))
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }

  function startListening(): Promise<{ port: number; bind: string }> {
    sweepTimer = setInterval(sweep, config.sweepMs)
    sweepTimer.unref()
    return new Promise((resolve, reject) => {
      http.once('error', reject)
      http.listen(config.port, config.bind, () => {
        http.off('error', reject)
        // 传 0 时由系统分配端口——测试要用随机端口，不能猜。
        const actual = http.address()
        const port = typeof actual === 'object' && actual ? actual.port : config.port
        resolve({ port, bind: config.bind })
      })
    })
  }

  return { http, wss, state, log, health, close, startListening }
}

/** 供测试与 main 共用：把 ws 的 OPEN 常量与 Sock 形状暴露出去。 */
export { WS_OPEN, type Sock }
export const WEBSOCKET_OPEN = WebSocket.OPEN
