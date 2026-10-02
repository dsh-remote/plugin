/**
 * relay — 主机侧的中继客户端：鉴权、重连、配对通道密钥簿、数据面密封。
 *
 * 三条来自线上事故的硬要求（取证 docs/legacy-spec/relay-and-wireformat.md §2.3）：
 *
 * 1. **`pair-ready.ttlMs` 是服务端权威 TTL**，必须据此改写本地过期时间。
 *    忘了这一步 → 主机提前清掉 PSK → `peer-joined` 找不到密钥 → 静默丢 peer
 *    → 手机端表现为"配对成功但列表永远空白"。
 * 2. **`peer-joined` 里的 `pairingToken` 是唯一合法的取密钥依据**。
 *    多张码同时挂着时按"手机实际用的那张"取 PSK；取不到就拒绝这条配对，
 *    绝不退化成"取最新的一个"（那正是当初的 bug）。
 * 3. **中继重启（generation 变化）后旧配对全部作废**：PSK 是主机在内存里发的，
 *    中继的会话表一清空，这些 convId 就再也没人路由了。
 *
 * 方向约定：主机用 `h2c` 密钥**加密下行**、用 `c2h` 密钥**解密上行**；
 * 与小程序侧正好互为镜像，两把密钥由同一 PSK + convId 派生（冻结项 B5）。
 */
import { WebSocket } from 'ws'
import { randomBytes } from 'node:crypto'
import {
  type CmdPayload,
  type EvPayload,
  base64Text,
  open,
  parseCmdPayload,
  parseRelayFrameText,
  seal,
} from 'dsh-remote-wire'
import { ConversationBook, DEFAULT_PRUNE_POLICY, type PairSlot, type PrunePolicy } from '../core/keys.js'
import type { Clock } from '../ports/index.js'

export interface RelayClientOptions {
  url: string
  hostId: string
  label: string
  /** 中继侧 `DRC_HOST_TOKEN` 的同值副本；只在这一条出站帧上出现。 */
  token: string
  clock: Clock
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  /** 解出一条命令（已经过 MAC 校验）。 */
  onCommand: (conversationId: string, cmd: CmdPayload, clientId?: string) => void
  /** 一条新配对建立：调用方要立刻把会话与防休眠状态推过去。 */
  onPeerJoined: (conversationId: string, pairingToken: string | undefined) => void
  /** 一条配对通道被彻底作废（本端解不开、或本端主动声明它没人接了）。 */
  onConversationGone: (conversationId: string) => void
  /** 某个客户端离开，但**会话保留**（D3）：它下次用同一个 convId 回来时还能接上。 */
  onClientLeft: (conversationId: string, clientId: string) => void
  /**
   * 按 `peer-joined` 回传的 pairingToken 取本地那张码。
   * 取不到必须返回 null 并由调用方拒绝这条配对——**不允许**退化成"取最新的一张"，
   * 那正是多码并存事故的形状。
   */
  lookupPairingSlot: (token: string) => PairSlot | null
  /** `pair-ready` 到达：调用方据此改写本地 PSK 过期时间。 */
  onPairReady: (pairingToken: string, ttlMs: number) => void
  /**
   * 中继宣告"这张配对码没配上"（`expired` / `already_used` / `rate_limited` /
   * `invalid_or_expired`）。主机侧唯一的用处是**退避自动补发**：
   * 被限速时还按原节拍发码，只会让自己继续被拒。
   */
  onPairFail?: (reason: string) => void
  /** 连接状态变化，直接进 status.json。 */
  onState: (state: RelayStateInfo) => void
  /** 重连后的第一批帧之前要不要等一会（手机端可能还在旧 convId 上发）。 */
  handshakeTimeoutMs?: number
  /** 配对通道的剪枝策略（不传用默认：空闲 24h 或超过 64 条）。 */
  prunePolicy?: PrunePolicy
}

export interface RelayStateInfo {
  relay: 'online' | 'connecting' | 'offline'
  problem?: string
  clients: number
  conversations: number
  generation: number
}

const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 30_000
const HANDSHAKE_TIMEOUT_MS = 10_000
/** 已声明作废的 convId 记住多少条：远超一次会话里可能出现的配对通道数，又不会无界增长。 */
const VOIDED_MAX = 256

export class RelayClient {
  readonly conversations = new ConversationBook()
  private socket: WebSocket | undefined
  private generation = 0
  private attempts = 0
  private stopped = false
  private reconnectTimer: unknown
  private handshakeTimer: unknown
  /** 连续解不开的会话：解不开说明这端已经没有对应密钥，留着它只会让手机永远转圈。 */
  private readonly undecryptable = new Map<string, number>()
  /** 已经向中继声明过的 convId（防重复 `session-leave`）；有上界，见 {@link VOIDED_MAX}。 */
  private readonly voided = new Set<string>()

  constructor(private readonly options: RelayClientOptions) {}

  /** 已配对的会话数（`status.json` 与"有没有人能收"的判据都读它）。 */
  get conversationCount(): number {
    return this.conversations.size
  }

  connect(): void {
    if (this.stopped) return
    this.closeSocket()
    this.options.log('relay connecting', { url: this.options.url })
    let socket: WebSocket
    try {
      socket = new WebSocket(this.options.url)
    } catch (error) {
      this.scheduleReconnect(`socket 创建失败：${messageOf(error)}`)
      return
    }
    this.socket = socket
    this.emitState('connecting')
    const timeout = this.options.clock.setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        this.options.log('relay handshake timeout')
        socket.terminate()
        this.scheduleReconnect('握手超时')
      }
    }, this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS)
    this.handshakeTimer = timeout

    socket.on('open', () => {
      this.options.clock.clearTimeout(timeout)
      this.attempts = 0
      // D5：主机与客户端共用一条注册帧。PSK 从不上网（D1），这里只有 host token。
      this.raw({
        t: 'hello',
        role: 'host',
        protocol: 1,
        token: this.options.token,
        hostId: this.options.hostId,
        label: this.options.label,
      })
    })
    socket.on('message', (raw) => this.onFrame(String(raw)))
    socket.on('close', (code, reason) => {
      this.options.clock.clearTimeout(timeout)
      this.emitState('offline', `连接关闭 ${code} ${reason ? reason.toString() : ''}`.trim())
      this.options.log('relay closed', { code })
      this.scheduleReconnect(`closed ${code}`)
    })
    socket.on('error', (error) => {
      this.options.log('relay socket error', { message: messageOf(error) })
      this.emitState('offline', messageOf(error))
    })
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) this.options.clock.clearTimeout(this.reconnectTimer)
    this.closeSocket()
    this.emitState('offline', 'stopped')
  }

  /** 发布一张新的配对码（PSK 留在本地，中继只拿到 6 位码）。
   *
   * 返回 false = socket 不在 OPEN 状态、这条 `pair-begin` **根本没上过网**。
   * 调用方不能把这张码记成"有效"，否则 status.json 会展示一张中继没见过的码，
   * 而手机扫它必然失败（取证 docs/legacy-spec/host-plugin-runtime.md §6.2）。
   */
  publishPairing(slot: PairSlot): boolean {
    return this.raw({ t: 'pair-begin', pairingToken: slot.token })
  }

  /**
   * 按策略剪掉"再也不会被用"的配对通道（一天没收发，或超出条数上界）。
   *
   * 必须**同时**告诉中继与上层：只删本地内存的话，中继仍会把手机的密文转过来，
   * 而手机看到的是一个不再有人应答的对端——正是复核 R1 那个静默黑洞的另一个入口。
   * 所以这里走 `voidConversation`（发 `session-leave` + 回调 `onConversationGone`）。
   */
  pruneConversations(now = this.options.clock.now()): string[] {
    const dropped = this.conversations.pruneStale(now, this.options.prunePolicy ?? DEFAULT_PRUNE_POLICY)
    for (const id of dropped) this.voidConversation(id)
    if (dropped.length > 0)
      this.options.log('pruned stale conversations', { count: dropped.length, remaining: this.conversations.size })
    return dropped
  }

  /** 向一条配对会话发一条载荷；返回 false = 这条会话已经没了或没人接。 */
  send(conversationId: string, payload: EvPayload): boolean {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return false
    const record = seal(conversation.kH2C, payload)
    conversation.lastActivityAt = this.options.clock.now()
    return this.raw({ t: 'enc', sessionId: conversationId, seq: ++conversation.seqHost, ciphertext: record.ciphertext })
  }

  broadcast(payload: EvPayload): number {
    let sent = 0
    for (const id of this.conversations.ids()) {
      if (this.send(id, payload)) sent += 1
    }
    return sent
  }

  hasPeer(conversationId: string): boolean {
    return this.conversations.has(conversationId)
  }

  conversationIds(): string[] {
    return this.conversations.ids()
  }

  /**
   * 作废一条配对通道：本地删密钥 + 告诉中继"这条别再转给我了" + 通知上层。
   *
   * **本端没有记录时同样要发 `session-leave`**（复核 R1①）。这是"主机重启之后"的出口：
   * PSK 随进程没了，中继却还留着会话并继续把手机的密文转过来。若这里因为
   * `!has(id)` 直接 return（第一版就是这么写的），中继永远不知道该删这条会话，
   * 手机也就永远撞不上 `unknown_session` → 表现是"发什么都没反应、也不提示重新配对"，
   * 而这是整条链路上唯一能让手机脱身的机制。
   *
   * 幂等：同一条通道只声明一次（`voided` 有上界，避免长会话里堆内存）。
   * 重新配对（`peer-joined`）会清掉这条记录，所以下次作废仍能声明。
   */
  voidConversation(conversationId: string): void {
    if (this.voided.has(conversationId)) return
    if (this.voided.size >= VOIDED_MAX) {
      const oldest = this.voided.values().next().value
      if (oldest !== undefined) this.voided.delete(oldest)
    }
    this.voided.add(conversationId)
    this.undecryptable.delete(conversationId)
    this.conversations.close(conversationId)
    this.raw({ t: 'session-leave', sessionId: conversationId })
    this.options.onConversationGone(conversationId)
  }

  private raw(frame: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    try {
      this.socket.send(JSON.stringify(frame))
      return true
    } catch (error) {
      this.options.log('relay send failed', { message: messageOf(error) })
      return false
    }
  }

  private onFrame(text: string): void {
    const frame = parseRelayFrameText(text)
    if (!frame) {
      // 只记形状不记内容：坏帧的原文可能是半条配对码，日志里不许出现凭据与业务明文。
      this.options.log('relay frame rejected', { bytes: text.length })
      return
    }
    switch (frame.t) {
      case 'hello-ok': {
        this.generation += 1
        // 中继重启过：它手里的 convId 全没了，本地留着也只会解不开。
        const dropped = this.conversations.closeBefore(this.generation)
        for (const id of dropped) this.options.onConversationGone(id)
        this.emitState('online')
        this.raw({ t: 'resync', sessionIds: this.conversations.ids() })
        this.options.log('relay online', { generation: this.generation, conversations: this.conversations.size })
        return
      }
      case 'pair-ready':
        this.options.onPairReady(frame.pairingToken, frame.ttlMs)
        return
      case 'peer-joined': {
        // 只有带 pairingToken 的那一条才是"新客户端加入"；重连通知没有 token（客户端的 id 填在 clientId 位）。
        if (!frame.pairingToken) return
        const slot = this.options.lookupPairingSlot(frame.pairingToken)
        if (!slot) {
          this.options.log('peer-joined without a known pairing token', { sessionId: frame.sessionId })
          return
        }
        this.conversations.open({
          id: frame.sessionId,
          psk: slot.psk,
          generation: this.generation,
          now: this.options.clock.now(),
        })
        // 这条通道现在又有密钥了：清掉"已声明作废"的记号，否则下次真要作废时发不出去。
        this.voided.delete(frame.sessionId)
        this.raw({ t: 'resync', sessionIds: this.conversations.ids() })
        this.emitState('online')
        this.options.onPeerJoined(frame.sessionId, frame.pairingToken)
        return
      }
      case 'peer-left':
        // 发给主机的这一帧含义是"某个客户端走了"，会话**必须留着**（D3）：
        // 手机回前台时用同一个 convId 回来，成员表还在，路由就能重建。
        // 反过来，发给客户端的 peer-left 只有一个合法触发（主机离开），
        // 那由中继侧保证，本端不猜。
        this.options.onClientLeft(frame.sessionId, frame.clientId)
        this.emitState('online')
        return
      case 'paired':
        return
      case 'pair-fail':
        // 第一版这个 case 根本没有：手机扫码后中继回了"这张码已用过/已过期"，
        // 主机一侧完全无痕，status.json 也看不出配对为什么没成。
        // 清槽是安全的：这张码的 PSK 已经不可能再被用上了。
        this.options.log('pair failed', { reason: frame.reason })
        this.options.onPairFail?.(frame.reason)
        return
      case 'error':
        // 中继只会把错误码发给"该对它负责"的那一端；本端把它记进状态，
        // 会话清理交给 enc 路径（那里才知道具体是哪条通道）。
        this.options.log('relay error frame', {
          code: frame.code,
          ...(frame.message === undefined ? {} : { message: frame.message }),
        })
        return
      case 'pong':
        return
      case 'enc':
      case 'enc-batch':
        this.onEncrypted(frame)
        return
      default:
        // F1 的纪律：新帧名必须被静默忽略、不许破坏状态，但**必须留痕**。
        // 没有这一条的话，中继侧加一个名字、主机侧永远是哑的，只能靠猜。
        this.options.log('relay frame ignored (no handler)', { t: (frame as { t?: string }).t ?? '?' })
        return
    }
  }

  private onEncrypted(frame: { sessionId: string; ciphertext?: string; items?: Array<{ ciphertext: string }> }): void {
    const conversation = this.conversations.get(frame.sessionId)
    if (!conversation) {
      // 本端已经没有这把钥匙：留着通道只会让手机对着一个听不见的对端说话。
      this.voidConversation(frame.sessionId)
      return
    }
    const records = frame.items ?? (frame.ciphertext === undefined ? [] : [{ ciphertext: frame.ciphertext }])
    let decryptedAny = false
    for (const record of records) {
      if (!base64Text.safeParse(record.ciphertext).success) continue
      const decrypted = open<unknown>(conversation.kC2H, { ciphertext: record.ciphertext })
      if (!decrypted) {
        // 解不开 = 这端已经没有对应密钥，交给"两次就作废"那条出口。
        this.noteUndecryptable(frame.sessionId)
        continue
      }
      // MAC 过了不等于形状对。`onCommand` 下游是 `switch (cmd.t)` + 真实内核调用，
      // 把未校验的对象直接递下去 = 让手机用一条密文决定宿主被怎么调用。
      const cmd = parseCmdPayload(decrypted)
      if (!cmd) {
        const name =
          typeof (decrypted as { t?: unknown }).t === 'string' ? String((decrypted as { t?: unknown }).t) : '?'
        this.options.log('inbound payload failed cmd schema', { sessionId: frame.sessionId, t: name })
        continue
      }
      decryptedAny = true
      this.options.onCommand(frame.sessionId, cmd, (frame as { clientId?: string }).clientId)
    }
    // 有实际收发就不算"闲置"：剪枝看的是最后活动时刻，不是创建时刻。
    if (decryptedAny) conversation.lastActivityAt = this.options.clock.now()
    if (decryptedAny) this.undecryptable.delete(frame.sessionId)
  }

  /** 两次解不开就作废（与手机端"两帧解不开就丢配对"对称，避免一端永久静默）。 */
  private noteUndecryptable(conversationId: string): void {
    const count = (this.undecryptable.get(conversationId) ?? 0) + 1
    this.undecryptable.set(conversationId, count)
    this.options.log('inbound frame could not be decrypted', { conversationId, count })
    if (count >= 2) this.voidConversation(conversationId)
  }

  private scheduleReconnect(problem: string): void {
    if (this.stopped) return
    this.emitState('offline', problem)
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempts)
    this.attempts += 1
    const delay = base + Math.floor((randomBytes(2).readUInt16BE(0) / 65536) * 500)
    this.reconnectTimer = this.options.clock.setTimeout(() => this.connect(), delay)
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = undefined
    if (this.handshakeTimer !== undefined) {
      this.options.clock.clearTimeout(this.handshakeTimer)
      this.handshakeTimer = undefined
    }
    if (!socket) return
    socket.removeAllListeners()
    // 摘完监听器必须补一个 error 兜底，**不能只靠下面的 try/catch**。
    // 原因：socket 还在 CONNECTING 时 ws 的 close() 会走 abortHandshake，那条路径是
    // `process.nextTick(emitErrorAndClose, ...)` —— 错误是**异步**发出来的，
    // 同步的 try/catch 根本拦不到；而此时 removeAllListeners() 已经把 error 监听器
    // 一起摘了，于是它无人接手、升级成 uncaughtException 把进程带崩。
    // 表现就是 e2e 偶发红：'WebSocket was closed before the connection was established'
    // （只有在"连接还没建好就停机"这个窗口里才触发，所以时红时绿）。
    socket.on('error', () => {})
    try {
      socket.close()
    } catch {
      /* 已经关了 */
    }
  }

  private emitState(relay: RelayStateInfo['relay'], problem?: string): void {
    this.options.onState({
      relay,
      ...(problem === undefined ? {} : { problem }),
      clients: this.conversations.size,
      conversations: this.conversations.size,
      generation: this.generation,
    })
  }
}

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error)
}
