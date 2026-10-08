/**
 * keys — 会话密钥簿（配对通道 → 两把方向密钥）。
 *
 * 密钥全部由 `(psk, 方向, convId)` 派生（冻结项 B5），所以这本账的键只能是 convId。
 * **两个方向必须分开存**：手机用 `c2h` 发、用 `h2c` 收，主机正好相反。
 *
 * 一条来自旧实现线上事故的硬教训（取证 docs/legacy-spec/relay-and-wireformat.md §2.3）：
 * 主机挂着多张配对码时，**必须按手机实际使用的那张码取 PSK**，
 * 取错的结果是"配对显示成功、每一帧都解不开、会话列表空白"——极难定位。
 * 因此这里不提供"取最近一个"的接口，只有 `resolveFor(token)`。
 *
 * ## 跨进程存活（2026-10-04）
 *
 * 本书现在可以被快照/恢复（`snapshot()` / `restore()`），落盘由 `shell/pair-store.ts` 负责。
 * 起因是"主机重启 → 丢掉全部会话 → 手机必须重新扫码"，而这让自举迭代每次都要人回到机器前。
 * **落盘的是 `psk` 而不是两把派生密钥**：派生是纯函数（`derivePskKey`），
 * 存派生结果等于多一份要保持一致的第二真相，而它必须与 psk 永远相等。
 */
import { generatePsk, randomPairingToken } from 'dsh-remote-wire'
import type { Direction } from 'dsh-remote-wire'
import { derivePskKey } from 'dsh-remote-wire'
import type { StoredConversation } from '../shell/pair-store.js'

const C2H: Direction = 'c2h'
const H2C: Direction = 'h2c'

export interface Conversation {
  id: string
  clientIds: Set<string>
  kC2H: Uint8Array
  kH2C: Uint8Array
  psk: string
  /** host→client 方向的本地序号（中继也会编号，本端这一个是给"顺序可核对"用的）。 */
  seqHost: number
  createdAt: number
  /** 最近一次有实际收发的时刻；剪枝只看这个，不看 `createdAt`。 */
  lastActivityAt: number
  /**
   * 这条会话是不是从盘上恢复的。
   *
   * 只被剪枝读：**恢复出来的会话不能按"一天没收发就剪"处理**。那个 TTL 是给
   * "新配对但用户从此不再打开手机"设计的，而恢复出来的那条恰恰是"用户本来配好了、
   * 只是主机重启了"——按 24 小时剪掉它，等于把"免扫码重连"这个目的在长假的场景下又取消了。
   * 它该由中继自己的空闲 TTL（中继侧默认 7 天）来决定，因为**中继忘掉它的那一天
   * 本来就是手机必须重扫的那一天**（中继表一空，主机留着密钥也没人能路由）。
   */
  restored?: boolean
}

/**
 * 一本有界的密钥簿。
 *
 * 为什么必须有界（复核🟡 8）：D3 之后配对通道跨断连长存，而**中继侧的空闲 TTL 是 7 天**
 * （`apps/server/src/config.ts` 的 `DRC_CONV_IDLE_TTL_MS`）。也就是说"中继先把它忘掉"
 * 这件事几乎不会发生，长期跑的主机会把每一条曾经配对过的通道连同一份 PSK 永远留在内存里，
 * 并且每次广播都还对它们逐个密封一遍（白做功且随天数线性增长）。
 * 剪枝只由 host 侧负责，且必须**同时通知中继与上层**（见 `RelayClient.pruneConversations`），
 * 否则手机会对着一条主机已经不认得的通道说话。
 */
export interface PrunePolicy {
  /** 距今超过这么久而没有任何收发的通道可以剪掉。**不作用于恢复出来的会话**（见 `Conversation.restored`）。 */
  idleTtlMs: number
  /** 恢复出来的会话用这一条 TTL；语义是"与中继的空闲 TTL 对齐"。 */
  restoredIdleTtlMs?: number
  /** 通道数硬上界：超了就从最不活跃的开始剪（剪枝不看创建时刻，看最后活动）。 */
  maxConversations: number
}

export const DEFAULT_PRUNE_POLICY: PrunePolicy = {
  // 一天没有任何收发就认为这条通道不会再被用（手机真回来时会重新扫码，
  // 而且它会先撞上 `unknown_session` → 中文提示，而不是"永远转圈"）。
  idleTtlMs: 24 * 3600 * 1000,
  // 恢复出来的会话不按上面那条剪：默认给 7 天，与中继的 `DRC_CONV_IDLE_TTL_MS`
  // （`config.ts` 的 7×24h）逐字对齐 —— 中继忘掉它的那天本来就得重扫，
  // 主机提前剪只是把同一次重扫提前到用户还没察觉的时间点，反而更难解释。
  restoredIdleTtlMs: 7 * 24 * 3600 * 1000,
  maxConversations: 64,
}

export class ConversationBook {
  private readonly byId = new Map<string, Conversation>()

  /**
   * 一条落盘记录被丢弃时叫这个（2026-10-07 补）。
   *
   * 为什么要有出口而不能只静默丢弃：`restore` 的注释承诺"一条形状不合的记录
   * 整条丢弃"，而**静默丢弃**在用户眼里就是"我明明配对过，手机却要重扫"——
   * 没有任何一句话告诉他为什么。宿主侧把它记进日志，并在 `status.json` 的
   * `pairStore` 里留一个计数。
   *
   * 可选：单测直接 new 出来的 book 不接它，而那正是它可选项的原因
   * （不接时行为完全一致：丢弃，只是不留痕）。
   */
  onRestoreRejected?: (conversationId: string, reason: string) => void

  /**
   * 为一条新配对建立密钥。
   *
   * @param psk 必须来自 `PairingSlots.resolveFor(token)`——**不允许**"取最新的一个"。
   */
  open(args: { id: string; psk: string; now: number }): Conversation {
    const conversation: Conversation = {
      id: args.id,
      clientIds: new Set<string>(),
      kC2H: derivePskKey(args.psk, C2H, args.id),
      kH2C: derivePskKey(args.psk, H2C, args.id),
      psk: args.psk,
      seqHost: 0,
      createdAt: args.now,
      lastActivityAt: args.now,
    }
    this.byId.set(args.id, conversation)
    return conversation
  }

  /**
   * 从落盘记录恢复会话（跨进程续用，见 `shell/pair-store.ts`）。
   *
   * 两条刻意的选择：
   *
   * - **`clientIds` 一律置空**：那是"此刻谁连着"的瞬时态，进程刚起来时没有人连着主机。
   *   填了旧值会让主机一启动就往每条会话广播，而手机端还没重连 ——
   *   那些帧全被中继计成丢帧（`relay.ts` 的 `broadcast` 闸门当初就是为这个加的）。
   *   手机回来发的第一帧会经 `RelayClient.onEncrypted` 把它重新登记进来。
   * - **`restored: true`**：让剪枝对这条会话用另一条 TTL，理由见该字段的注释。
   *
   * 返回真正恢复出来的会话 id：**同一条 id 重复出现时后者覆盖前者**，
   * 而一条形状不合的记录整条丢弃（宁可少一条通道，也不要一条解不开的）。
   */
  restore(records: readonly StoredConversation[], now: number): string[] {
    const restored: string[] = []
    for (const record of records) {
      /**
       * **一条形状不合的记录整条丢弃**（2026-10-07 补上兑现）。
       *
       * 上面那段注释早就承诺了这件事，而实现是直接 `open()` —— 于是
       * `derivePskKey` 对一条**截断过的 psk** 抛
       * 「配对密钥（PSK）解码后必须是 16 字节，收到 9 字节」。
       *
       * 为什么这一抛是灾难级的而不仅是"少一条通道"：`restore` 的调用点
       * （`index.ts` 的 `restoreConversations`）**不在任何 try 内**，而它在
       * `applyInner` 里 —— 一次抛出就让 `handle` 变成 undefined，
       * 于是**没有 status.json、没有 pill、整条配对链路无**，
       * 只留一行 stderr。GUI 宿主里 stdout 没人看，于是用户看到的是
       * "插件好像没起来"，而根因是磁盘上一个被截断的 base64 串。
       *
       * 落盘那一层的 zod 挡不住这个：`psk: z.string().min(1)` 只要求非空，
       * 16 字节的约束在 wire 层的 `derivePskKey` 里，而它只在**派生时**才发现。
       * 所以这道校验必须在这里 —— 它是唯一同时握着"记录"与"派生"两边的地方。
       *
       * 代价：一条坏记录 = 那一台手机要重扫一次。而另一个选择是整个插件起不来。
       */
      try {
        const conversation = this.open({ id: record.id, psk: record.psk, now })
        conversation.seqHost = record.seqHost
        conversation.createdAt = record.createdAt
        conversation.lastActivityAt = record.lastActivityAt
        conversation.restored = true
        restored.push(record.id)
      } catch (error) {
        // 逐条记，不中断整批：坏的是**一条**，不是全部。
        this.onRestoreRejected?.(record.id, String((error as Error)?.message ?? error))
      }
    }
    return restored
  }

  /** 导出可落盘的记录（**不含 clientIds**，理由见 `restore`）。 */
  snapshot(): StoredConversation[] {
    return [...this.byId.values()].map((conversation) => ({
      id: conversation.id,
      psk: conversation.psk,
      seqHost: conversation.seqHost,
      createdAt: conversation.createdAt,
      lastActivityAt: conversation.lastActivityAt,
    }))
  }

  /** 有实际收发就记一笔活跃（剪枝只看这个时刻）。未知通道返回 false，不顺手建条目。 */
  touch(id: string, now: number): boolean {
    const conversation = this.byId.get(id)
    if (!conversation) return false
    conversation.lastActivityAt = now
    return true
  }

  get(id: string): Conversation | undefined {
    return this.byId.get(id)
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  /**
   * 这条会话**现在有没有活着的客户端**。
   *
   * 与 `has()` 是两件事，而且必须分开：`has()` 是"我手里有这条通道的密钥"，
   * 手机回前台时要用同一个 `convId` 回来，所以密钥**必须留着**（D3）；
   * 但"有密钥"不等于"现在有人能收到"。
   *
   * 原来只有 `has()` 一个判据，于是 `hasPeer()` 答的是"有密钥"，广播就照着它发——
   * 真机后果：手机断开之后（会话默认 7 天 TTL）主机每 15 秒仍往这条空会话发
   * `session_changed` / `model` / `keep_awake_state` 三帧，中继每一帧计一次丢帧，
   * 实测 45 秒涨 9、`/healthz` 的 `droppedFrames` 因此被这一路噪声主导（5737）。
   */
  hasClient(id: string): boolean {
    const conversation = this.byId.get(id)
    return conversation !== undefined && conversation.clientIds.size > 0
  }

  close(id: string): boolean {
    return this.byId.delete(id)
  }

  /**
   * 按策略剪枝，返回被剪掉的 id（调用方负责通知中继与上层，见
   * `RelayClient.pruneConversations`）。
   *
   * 三条规则，因为它们是三种不同的失控：
   * - 空闲超 TTL：一条通道一天没有任何收发，就不会再有人用它了；
   * - **恢复出来的会话走另一条 TTL**（`restoredIdleTtlMs`）：见 `Conversation.restored`
   *   与 `DEFAULT_PRUNE_POLICY.restoredIdleTtlMs` 的理由 —— 它不该按"新配对却没人用"的
   *   标准剪掉，否则长假之后主机一启动就把唯一那条通道清了，免扫码重连白做；
   * - 超出硬上界：从**最不活跃**的开始剪。没有这条，一个每天配一次对的用户
   *   会在两周内攒下 260 条密钥，并且每次广播都对它们逐个密封一遍。
   */
  pruneStale(now: number, policy: PrunePolicy = DEFAULT_PRUNE_POLICY): string[] {
    const dropped: string[] = []
    const restoredTtl = policy.restoredIdleTtlMs ?? policy.idleTtlMs
    for (const [id, conversation] of [...this.byId]) {
      const ttl = conversation.restored ? restoredTtl : policy.idleTtlMs
      if (now - conversation.lastActivityAt > ttl) {
        this.byId.delete(id)
        dropped.push(id)
      }
    }
    if (this.byId.size > policy.maxConversations) {
      const ordered = [...this.byId.values()].sort((a, b) => a.lastActivityAt - b.lastActivityAt)
      for (const conversation of ordered.slice(0, this.byId.size - policy.maxConversations)) {
        this.byId.delete(conversation.id)
        dropped.push(conversation.id)
      }
    }
    return dropped
  }

  ids(): string[] {
    return [...this.byId.keys()]
  }

  /**
   * 当前**真正连着**的客户端数（去重后的 clientId，不是会话数）。
   *
   * 为什么必须单独算：一条会话（convId）对应一次配对，而**同一部手机**在
   * 「解除配对再重新配对」之后会开一条新会话 —— 于是 `size`（会话数）会增长，
   * 手机却还是那一台。把 `size` 当成"有几部手机"报出去，用户解除配对后看到
   * 数字反而变大，会以为解配没生效。
   *
   * 反过来也算不准：会话被剪掉了但手机还在（`pruneStale`），
   * 所以这个数只保证"不比会话数更离谱"，不保证等于真实在线数 ——
   * 界面上它只该当"有手机连着没有"的粗判据，不该当精确计数。
   */
  clientCount(): number {
    const ids = new Set<string>()
    for (const conversation of this.byId.values()) {
      for (const clientId of conversation.clientIds) ids.add(clientId)
    }
    return ids.size
  }

  get size(): number {
    return this.byId.size
  }
}

/**
 * 待配对码槽位。
 *
 * 为什么必须是**多槽 Map** 而不是单个"当前 PSK"字段：主机可以一边自动补发一张码、
 * 一边又被用户手动 `/drc pair` 出一张新码，两张都有效；旧实现用单槽，
 * 于是手机用较早那张码配对成功、主机却拿最新那张的 PSK 派生密钥 → 全线解不开。
 * 这是线上事故换来的结论（取证 HANDOFF.md §4.5 与 e2e/multi-pair.test.mjs）。
 */
export interface PairSlot {
  token: string
  psk: string
  /** 本地认为的过期时刻；**收到中继的 `pair-ready.ttlMs` 后必须改写**（§2.3 硬约束 1）。 */
  expiresAt: number
  createdAt: number
}

export class PairingSlots {
  private readonly slots = new Map<string, PairSlot>()

  constructor(
    private readonly now: () => number,
    private readonly maxSlots = 32,
  ) {}

  /** 新建一张码。超上限时淘汰最旧的（而不是拒绝新建），因为"发不出去"比"少一张"更糟。 */
  create(ttlMs: number): PairSlot {
    if (this.slots.size >= this.maxSlots) {
      const oldest = [...this.slots.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest) this.slots.delete(oldest.token)
    }
    const created: PairSlot = {
      token: randomToken(),
      psk: generatePskValue(),
      expiresAt: this.now() + ttlMs,
      createdAt: this.now(),
    }
    this.slots.set(created.token, created)
    return created
  }

  /**
   * 用服务端权威 TTL 改写本地过期时间。
   * 忘了这一步的后果：主机在配对发生之前就清掉了 PSK，
   * `peer-joined` 找不到密钥 → 静默丢 peer → 手机永远解不开。
   */
  applyServerTtl(token: string, ttlMs: number): boolean {
    const slot = this.slots.get(token)
    if (!slot) return false
    // **基线统一到 `createdAt`**（2026-10-06）：`PairingWindow.applyServerTtl` 用的是
    // 发起时刻，这里原来用"pair-ready 到达时刻"（`now()`）。同一条 ttlMs 两条基线，
    // 差的正好是一个 RTT —— 屏幕上那张码的过期时刻（窗口口径）与真正取 PSK 的口径
    // （本方法）会差那么久，表现是"码显示还有效、点了却说无效"或反过来。
    slot.expiresAt = slot.createdAt + ttlMs
    return true
  }

  /** 按手机实际使用的码取 PSK。取不到就是 null，调用方必须拒绝这条配对而不是猜。 */
  resolveFor(token: string | undefined): PairSlot | null {
    if (!token) return null
    const slot = this.slots.get(token)
    if (!slot || slot.expiresAt < this.now()) return null
    return slot
  }

  prune(): number {
    const before = this.slots.size
    for (const [token, slot] of [...this.slots]) {
      if (slot.expiresAt < this.now()) this.slots.delete(token)
    }
    return before - this.slots.size
  }

  get size(): number {
    return this.slots.size
  }
}

/** 6 位配对码：直接用协议层的 CSPRNG 实现，避免在两处各写一遍拒绝采样。 */
function randomToken(): string {
  return randomPairingToken()
}

function generatePskValue(): string {
  return generatePsk()
}
