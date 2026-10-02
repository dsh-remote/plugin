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
import { type CmdPayload, type EvPayload, base64Text, open, parseRelayFrameText, seal } from '@dsh-rc/protocol'
import { ConversationBook, type PairSlot } from '../core/keys.js'
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
  /** 连接状态变化，直接进 status.json。 */
  onState: (state: RelayStateInfo) => void
  /** 重连后的第一批帧之前要不要等一会（手机端可能还在旧 convId 上发）。 */
  handshakeTimeoutMs?: number
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
      this.raw({ t: 'hello', role: 'host', protocol: 1, token: this.options.token, hostId: this.options.hostId, label: this.options.label })
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

  /** 发布一张新的配对码（PSK 留在本地，中继只拿到 6 位码）。 */
  publishPairing(slot: PairSlot): void {
    this.raw({ t: 'pair-begin', pairingToken: slot.token })
  }

  /** 向一条配对会话发一条载荷；返回 false = 这条会话已经没了或没人接。 */
  send(conversationId: string, payload: EvPayload): boolean {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return false
    const record = seal(conversation.kH2C, payload)
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

  /** 复核 R1：本端解不开的会话必须主动作废，手机才会收到"请重新配对"的中文提示。 */
  voidConversation(conversationId: string): void {
    if (!this.conversations.has(conversationId)) return
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
    if (!frame) return
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
        this.conversations.open({ id: frame.sessionId, psk: slot.psk, generation: this.generation, now: this.options.clock.now() })
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
      case 'error':
        // 中继只会把错误码发给"该对它负责"的那一端；本端把它记进状态，
        // 会话清理交给 enc 路径（那里才知道具体是哪条通道）。
        this.options.log('relay error frame', { code: frame.code, ...(frame.message === undefined ? {} : { message: frame.message }) })
        return
      case 'pong':
        return
      case 'enc':
      case 'enc-batch':
        this.onEncrypted(frame)
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
      const payload = open<CmdPayload>(conversation.kC2H, { ciphertext: record.ciphertext })
      if (!payload) {
        this.noteUndecryptable(frame.sessionId)
        continue
      }
      decryptedAny = true
      this.options.onCommand(frame.sessionId, payload, (frame as { clientId?: string }).clientId)
    }
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
