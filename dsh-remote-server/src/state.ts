/**
 * state — 中继的全部可变状态。
 *
 * 四张表是这套系统唯一的"事实"，而且**全在内存**：不持久化是有意设计
 * （取证 `docs/legacy-spec/relay-and-wireformat.md` §2.1 第 5 点与 HANDOFF §6——
 * PSK 与配对关系落盘只会扩大泄露面）。
 *
 * 这里守住四条不变量，每条都有对应测试：
 *
 * 1. `conversations` 的唯一创建点是配对成功（`claim`）；`sessionId` 前缀恒为 `c_`。
 * 2. `pendingPairs` 是**多槽**表（旧实现的第一起线上事故就是单槽：主机挂着两个码时
 *    用错了 PSK）。本版更进一步——表里根本没有 psk 字段（D1）。
 * 3. `used` 标记在 TTL 窗口内保留，所以重放同一码得到 `already_used`
 *    而不是 `invalid_or_expired`——这两个 reason 在手机上是不同文案（F6）。
 * 4. **客户端断开不删会话**（D3），**主机断开只在超过宽限期后才通知客户端**（D6）。
 *    旧实现两条都做反了：客户端 socket 一关就把会话删干净，
 *    于是手机每次回前台都必须重新扫码。
 *
 * 本文件**不 import `ws`**：对端只以一个极简的 `Sock` 结构出现，
 * 所以状态机可以被纯内存的单测完整驱动，不需要真的起 socket。
 */
import { newConversationId } from 'dsh-remote-wire/ids'
import type { ClientMeta } from 'dsh-remote-wire/frames'

/** 对端 socket 的最小面（真实现是 `ws` 的 WebSocket，测试里可以是内存对象）。 */
export interface Sock {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** `ws` 的 OPEN 常量；写死避免为了一个数字引入依赖。 */
export const WS_OPEN = 1

export interface HostEntry {
  ws: Sock
  label: string
}

export interface ClientEntry {
  ws: Sock
  meta?: ClientMeta
}

/** 待配对条目。**没有 psk 字段**——中继从不知道密钥（D1）。 */
export interface PendingPair {
  hostId: string
  expiresAt: number
  used: boolean
}

export interface Conversation {
  hostId: string
  /** 成员按 clientId 记账，因此客户端重连（同一 clientId）会自动重新挂上。 */
  clients: Set<string>
  /** host→client 方向由中继重新编号（客户端不信 seq，但中继要能审计与合并）。 */
  seqHost: number
  lastActivityAt: number
  /** 主机 socket 掉线的时刻；超过宽限期才真正通知客户端（D6）。 */
  hostOfflineSince?: number
}

export type ClaimResult =
  { ok: true; conversationId: string; hostId: string; detached: string[] } | { ok: false; reason: PairRejectReason }

export type PairRejectReason = 'invalid_or_expired' | 'already_used' | 'host_offline' | 'rate_limited'

export interface Clock {
  now(): number
}

export class RelayState implements Clock {
  readonly hosts = new Map<string, HostEntry>()
  readonly clients = new Map<string, ClientEntry>()
  readonly pendingPairs = new Map<string, PendingPair>()
  readonly conversations = new Map<string, Conversation>()

  /** 测试可注入固定时钟；默认用真实时间。 */
  private readonly clock: () => number
  private readonly maxPendingPairsValue: number

  constructor(options: { now?: () => number; maxPendingPairs?: number } = {}) {
    this.clock = options.now ?? (() => Date.now())
    this.maxPendingPairsValue = options.maxPendingPairs ?? 1000
  }

  now(): number {
    return this.clock()
  }

  // ── 身份登记 ────────────────────────────────────────────────────────

  /**
   * 登记主机。同一 `hostId` 重连会顶掉旧 socket，并返回被顶掉的那一个
   * 让调用方去 close（4000）。**旧 socket 的 close 回调不得因此删掉会话**——
   * 靠的是"新 socket 先注册、回调里再比对 `hosts[id].ws === ws`"这个守卫，
   * 见 `detachHost`。
   */
  attachHost(hostId: string, ws: Sock, label: string): { replaced?: Sock } {
    const previous = this.hosts.get(hostId)
    this.hosts.set(hostId, { ws, label })
    // 主机回来了：撤销所有还在宽限期内的离线标记，并清掉它的 hostOfflineSince。
    for (const conv of this.conversations.values()) {
      if (conv.hostId === hostId) conv.hostOfflineSince = undefined
    }
    return previous && previous.ws !== ws ? { replaced: previous.ws } : {}
  }

  /** 登记客户端。**客户端自带 clientId 时必须原样保留**：小程序冷启动后
   * 用的还是存储里那个 installId，若这里另发一个，D3 的重挂与 D4 的成员校验
   * 会在下一次冷启动时永远对不上。
   */
  attachClient(clientId: string, ws: Sock, meta?: ClientMeta): { replaced?: Sock } {
    const previous = this.clients.get(clientId)
    this.clients.set(clientId, { ws, ...(meta ? { meta } : {}) })
    // 复核 R3：clientId 虽然不是凭据，但**同 id 必须有唯一活动连接**。
    // 旧写法直接覆盖，结果抢注方拿到路由、真手机的 socket 还"开着"（因此不会重连），
    // 表现是手机侧永久静默。顶号让双方都能立刻看到断开，各自按策略重来。
    return previous && previous.ws !== ws ? { replaced: previous.ws } : {}
  }

  /** 该 socket 当前是否仍是某个身份的活连接（close 回调的竞态守卫）。 */
  isLiveHost(hostId: string, ws: Sock): boolean {
    return this.hosts.get(hostId)?.ws === ws
  }

  isLiveClient(clientId: string, ws: Sock): boolean {
    return this.clients.get(clientId)?.ws === ws
  }

  // ── 配对 ────────────────────────────────────────────────────────────

  /**
   * 主机发布配对码。已存在的 token 允许覆盖（同码重发是正常操作），
   * 新 token 在表满时被拒。
   */
  issuePair(hostId: string, token: string, ttlMs: number): { ok: boolean; replaced: boolean; full: boolean } {
    const existed = this.pendingPairs.has(token)
    if (!existed && this.pendingPairs.size >= this.maxPendingPairsValue) {
      return { ok: false, replaced: false, full: true }
    }
    this.pendingPairs.set(token, { hostId, expiresAt: this.now() + ttlMs, used: false })
    return { ok: true, replaced: existed, full: false }
  }

  /** 客户端认领配对码：一次性、TTL 内、主机在挂。成功即创建会话。 */
  claim(token: string, clientId: string): ClaimResult {
    const pending = this.pendingPairs.get(token)
    const now = this.now()
    if (!pending || pending.expiresAt < now) return { ok: false, reason: 'invalid_or_expired' }
    // used 条目保留到 TTL 清扫，好让重放拿到 already_used 而不是 invalid_or_expired。
    if (pending.used) return { ok: false, reason: 'already_used' }
    const host = this.hosts.get(pending.hostId)
    if (!host || host.ws.readyState !== WS_OPEN) return { ok: false, reason: 'host_offline' }

    pending.used = true
    // 同一台手机重配：先把它从旧会话里摘干净（复核 🟡7，理由见 leaveAll）。
    const detached = this.leaveAll(clientId)
    const conversationId = newConversationId()
    this.conversations.set(conversationId, {
      hostId: pending.hostId,
      clients: new Set([clientId]),
      seqHost: 0,
      lastActivityAt: now,
    })
    return { ok: true, conversationId, hostId: pending.hostId, detached }
  }

  /** 主机侧的过期表：返回被清掉的 token（调用方不需要再通知任何人）。 */
  expirePairs(): string[] {
    const now = this.now()
    const dropped: string[] = []
    for (const [token, entry] of this.pendingPairs) {
      if (entry.used || entry.expiresAt < now) {
        this.pendingPairs.delete(token)
        dropped.push(token)
      }
    }
    return dropped
  }

  // ── 数据面 ──────────────────────────────────────────────────────────

  /**
   * 路由一帧密文：发送方必须是该会话的成员（D4）。
   *
   * 成员关系来自**socket 身份**（`hello`/`auth` 建立的绑定），而不是帧里写的 clientId——
   * 那个字段是非秘密的、可被任意填写的。这里刻意只接受 `(conversationId, senderSock)`。
   *
   * 返回 `null` 表示不是成员或会话不存在；`'unknown_session'` 与 `'not_member'` 的区别
   * 由调用方决定（前者必须让客户端去重配对，后者只是拒绝这一帧）。
   */
  routeFrom(
    conversationId: string,
    sender: Sock,
    senderRole: 'unknown' | 'host' | 'client' = 'unknown',
  ): 'unknown_session' | 'not_member' | null {
    const conv = this.conversations.get(conversationId)
    if (!conv) return 'unknown_session'
    const host = this.hosts.get(conv.hostId)
    if (host?.ws === sender) return null
    for (const clientId of conv.clients) {
      if (this.clients.get(clientId)?.ws === sender) return null
    }
    // 复核 R2：已登记的客户端拿到 `not_member` 是没有出口的——小程序对未知 code
    // 只会弹一句英文 toast，配对还在、会话却永远回不来。所以对"注册过但不在成员里"的
    // 客户端一律给 `unknown_session`：它会中文提示"会话已失效，请重新配对"，这条路是通的。
    if (senderRole === 'client') return 'unknown_session'
    return 'not_member'
  }

  /**
   * 主机重启后声明它还持有密钥的会话（复核 R1）。
   * 没被列出的会话被删除，但**不通知客户端**——客户端下一次发帧会撞上
   * `unknown_session`，从而拿到中文的"请重新配对"提示。
   * 不这么做的后果是永久静默：中继表命中、主机解不开、手机没有任何反馈。
   */
  resync(hostId: string, sessionIds: readonly string[]): { kept: number; dropped: string[] } {
    const claimed = new Set(sessionIds)
    const dropped: string[] = []
    for (const [conversationId, conv] of [...this.conversations]) {
      if (conv.hostId !== hostId) continue
      if (claimed.has(conversationId)) {
        conv.hostOfflineSince = undefined
        conv.lastActivityAt = this.now()
        continue
      }
      this.conversations.delete(conversationId)
      dropped.push(conversationId)
    }
    return { kept: claimed.size - dropped.length, dropped }
  }

  /** host→client 方向由中继编号；客户端从不读它（F13）。 */
  nextHostSequence(conversationId: string): number | undefined {
    const conv = this.conversations.get(conversationId)
    if (!conv) return undefined
    conv.seqHost += 1
    conv.lastActivityAt = this.now()
    return conv.seqHost
  }

  touchConversation(conversationId: string): void {
    const conv = this.conversations.get(conversationId)
    if (conv) conv.lastActivityAt = this.now()
  }

  /** 主机在某次配对后拿到了哪些活跃客户端（转发时用）。 */
  clientSockets(conversationId: string): Sock[] {
    const conv = this.conversations.get(conversationId)
    if (!conv) return []
    const out: Sock[] = []
    for (const clientId of conv.clients) {
      const entry = this.clients.get(clientId)
      if (entry && entry.ws.readyState === WS_OPEN) out.push(entry.ws)
    }
    return out
  }

  hostSocket(conversationId: string): Sock | undefined {
    const conv = this.conversations.get(conversationId)
    if (!conv) return undefined
    const entry = this.hosts.get(conv.hostId)
    return entry && entry.ws.readyState === WS_OPEN ? entry.ws : undefined
  }

  /** 该主机会话里的 clientId 列表（诊断与测试用）。 */
  conversationIdsForHost(hostId: string): string[] {
    const out: string[] = []
    for (const [id, conv] of this.conversations) if (conv.hostId === hostId) out.push(id)
    return out
  }

  // ── 离场（D3 / D6 的落点）───────────────────────────────────────────

  /**
   * 客户端 socket 关闭。
   *
   * 两件刻意的事：
   * 1. **成员表不动**。`conv.clients` 继续留着这个 clientId——这正是 D3 重挂的机制：
   *    小程序重连后仍用存储里那个 clientId 发 `hello`，`clients` 表拿到新 socket，
   *    会话里的成员关系原样接上。若在这里删掉成员，D4 的成员校验会把重连后的
   *    合法客户端永远拒之门外。
   * 2. **不删会话**（旧实现 `if (conv.clients.size === 0) conversations.delete(id)`
   *    就是"手机每次回前台都要重新扫码"的根因）。真正回收它的是 `sweepIdle()` 的空闲 TTL。
   *
   * 返回需要通知主机的清单。注意：**不许**因此向其它客户端发 `peer-left`——
   * 对客户端而言 `peer-left` 只有一个合法触发（主机离开），混用会让别人的手机
   * 无辜丢掉配对（F5）。
   */
  clientGone(clientId: string, ws: Sock): Array<{ conversationId: string; clientId: string }> {
    const notices: Array<{ conversationId: string; clientId: string }> = []
    // 竞态守卫：同一 clientId 已有更新的 socket 时，旧 socket 的 close 什么都不能做。
    if (this.clients.get(clientId)?.ws !== ws) return notices
    this.clients.delete(clientId)
    for (const [conversationId, conv] of this.conversations) {
      if (conv.clients.has(clientId)) {
        conv.lastActivityAt = this.now()
        notices.push({ conversationId, clientId })
      }
    }
    return notices
  }

  /**
   * 主机 socket 关闭：只在"这个 socket 仍是该 hostId 的活连接"时打离线标记。
   * 主机重连时新 socket 先注册，旧 socket 的 close 回调据此被跳过，会话因此存活；
   * 这条守卫是旧实现里唯一做对了的竞态处理，语义继承（`main.mjs:389-393` 的注释）。
   */
  hostGone(hostId: string, ws: Sock): boolean {
    if (!this.isLiveHost(hostId, ws)) return false
    this.hosts.delete(hostId)
    const now = this.now()
    for (const conv of this.conversations.values()) {
      if (conv.hostId === hostId && conv.hostOfflineSince === undefined) conv.hostOfflineSince = now
    }
    return true
  }

  /** 主机主动作废某条会话（R1）：返回被摘掉的客户端，调用方据此发 peer-left。 */
  dropConversation(conversationId: string): { conversationId: string; clientIds: string[] } | undefined {
    const conv = this.conversations.get(conversationId)
    if (!conv) return undefined
    const clientIds = [...conv.clients]
    this.conversations.delete(conversationId)
    return { conversationId, clientIds }
  }

  /** 立即判死某个主机（用于主机主动解配或会话被清）。返回需要向客户端发 peer-left 的清单。 */
  dropHost(hostId: string): Array<{ conversationId: string; hostId: string; clientIds: string[] }> {
    const dropped: Array<{ conversationId: string; hostId: string; clientIds: string[] }> = []
    for (const [conversationId, conv] of [...this.conversations]) {
      if (conv.hostId !== hostId) continue
      dropped.push({ conversationId, hostId, clientIds: [...conv.clients] })
      this.conversations.delete(conversationId)
    }
    this.hosts.delete(hostId)
    return dropped
  }

  /** 宽限期到期的主机：判死并交出需要通知客户端的会话清单。 */
  expireOfflineHosts(graceMs: number): Array<{ conversationId: string; hostId: string; clientIds: string[] }> {
    const now = this.now()
    const overdue = new Set<string>()
    for (const conv of this.conversations.values()) {
      if (conv.hostOfflineSince !== undefined && now - conv.hostOfflineSince >= graceMs) overdue.add(conv.hostId)
    }
    const out: Array<{ conversationId: string; hostId: string; clientIds: string[] }> = []
    for (const hostId of overdue) out.push(...this.dropHost(hostId))
    return out
  }

  /** 客户端显式 `session-leave`：只摘自己，会话仍归主机。 */
  leave(clientId: string, conversationId: string): boolean {
    const conv = this.conversations.get(conversationId)
    if (!conv || !conv.clients.delete(clientId)) return false
    conv.lastActivityAt = this.now()
    return true
  }

  /**
   * 把一个 clientId 从**所有**会话的成员表里摘掉，返回受影响的会话。
   *
   * 重新配对时必须走这条（复核 🟡7）。一个 clientId 同时只该属于一个会话——拓扑恒 1:1，
   * 手机自己也只记一个 convId（`_onPaired` 会覆盖旧的）。不摘的话，主机在旧会话上的流
   * 会把密文继续灌给这台**已经换了钥匙**的手机：解不开 → 连错两次即 `_resetPairing`
   * 连 socket 一起关，于是"刚配对成功就被旧流打断"。
   *
   * 会话本身**保留**（与 `leave` 同一条原则：会话归主机）。主机可能还在这个会话上跑着
   * 一轮输出，中继没有理由替它删；会回收交给 `sweepIdle` 与主机侧的上界。
   */
  leaveAll(clientId: string): string[] {
    const touched: string[] = []
    for (const [conversationId, conv] of this.conversations) {
      if (conv.clients.delete(clientId)) touched.push(conversationId)
    }
    return touched
  }

  /**
   * 空闲清扫：回收长期没人用的会话（D3 的另一半——续用不是无限期）。
   * 返回被回收的会话与其客户端，调用方**不需要**给客户端发什么：
   * 它下次用这个 convId 发帧时自然收到 `unknown_session`，从而提示重新配对（F5）。
   */
  sweepIdle(ttlMs: number): string[] {
    const now = this.now()
    const dropped: string[] = []
    for (const [conversationId, conv] of [...this.conversations]) {
      if (now - conv.lastActivityAt >= ttlMs) {
        this.conversations.delete(conversationId)
        dropped.push(conversationId)
      }
    }
    return dropped
  }

  /** 测试与诊断：把内部计数摊平成 `/healthz` 需要的形状。 */
  counts(): { hosts: number; clients: number; conversations: number; pendingPairs: number } {
    return {
      hosts: this.hosts.size,
      clients: this.clients.size,
      conversations: this.conversations.size,
      pendingPairs: this.pendingPairs.size,
    }
  }

  /** 全量清空（优雅停机或测试重置）。 */
  reset(): void {
    this.hosts.clear()
    this.clients.clear()
    this.pendingPairs.clear()
    this.conversations.clear()
  }
}
