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
 */
import { generatePsk, randomPairingToken } from 'dsh-remote-wire'
import type { Direction } from 'dsh-remote-wire'
import { derivePskKey } from 'dsh-remote-wire'

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
  generation: number
  createdAt: number
  /** 最近一次有实际收发的时刻；剪枝只看这个，不看 `createdAt`。 */
  lastActivityAt: number
}

/**
 * 一本有界的密钥簿。
 *
 * 为什么必须有界（复核 🟡8）：D3 之后配对通道跨断连长存，而**中继侧的空闲 TTL 是 7 天**
 * （`apps/server/src/config.ts` 的 `DRC_CONV_IDLE_TTL_MS`）。也就是说"中继先把它忘掉"
 * 这件事几乎不会发生，长期跑的主机会把每一条曾经配对过的通道连同一份 PSK 永远留在内存里，
 * 并且每次广播都还对它们逐个密封一遍（白做功且随天数线性增长）。
 * 剪枝只由 host 侧负责，且必须**同时通知中继与上层**（见 `RelayClient.pruneConversations`），
 * 否则手机会对着一条主机已经不认得的通道说话。
 */
export interface PrunePolicy {
  /** 距今超过这么久而没有任何收发的通道可以剪掉。 */
  idleTtlMs: number
  /** 通道数硬上界：超了就从最不活跃的开始剪（剪枝不看创建时刻，看最后活动）。 */
  maxConversations: number
}

export const DEFAULT_PRUNE_POLICY: PrunePolicy = {
  // 一天没有任何收发就认为这条通道不会再被用（手机真回来时会重新扫码，
  // 而且它会先撞上 `unknown_session` → 中文提示，而不是"永远转圈"）。
  idleTtlMs: 24 * 3600 * 1000,
  maxConversations: 64,
}

export class ConversationBook {
  private readonly byId = new Map<string, Conversation>()

  /**
   * 为一条新配对建立密钥。
   *
   * @param psk 必须来自 `PairingSlots.resolveFor(token)`——**不允许**"取最新的一个"。
   */
  open(args: { id: string; psk: string; generation: number; now: number }): Conversation {
    const conversation: Conversation = {
      id: args.id,
      clientIds: new Set<string>(),
      kC2H: derivePskKey(args.psk, C2H, args.id),
      kH2C: derivePskKey(args.psk, H2C, args.id),
      psk: args.psk,
      seqHost: 0,
      generation: args.generation,
      createdAt: args.now,
      lastActivityAt: args.now,
    }
    this.byId.set(args.id, conversation)
    return conversation
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

  close(id: string): boolean {
    return this.byId.delete(id)
  }

  /** 中继重启（generation 变化）时把旧会话全部丢掉：它们再也解不开了。 */
  closeBefore(generation: number): string[] {
    const dropped: string[] = []
    for (const [id, conversation] of [...this.byId]) {
      if (conversation.generation < generation) {
        this.byId.delete(id)
        dropped.push(id)
      }
    }
    return dropped
  }

  /**
   * 按策略剪枝，返回被剪掉的 id（调用方负责通知中继与上层，见
   * `RelayClient.pruneConversations`）。
   *
   * 两条规则都做，因为它们是两种不同的失控：
   * - 空闲超 TTL：一条通道一天没有任何收发，就不会再有人用它了；
   * - 超出硬上界：从**最不活跃**的开始剪。没有这条，一个每天配一次对的用户
   *   会在两周内攒下 260 条密钥，并且每次广播都对它们逐个密封一遍。
   */
  pruneStale(now: number, policy: PrunePolicy = DEFAULT_PRUNE_POLICY): string[] {
    const dropped: string[] = []
    for (const [id, conversation] of [...this.byId]) {
      if (now - conversation.lastActivityAt > policy.idleTtlMs) {
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
    slot.expiresAt = this.now() + ttlMs
    return true
  }

  /** 按手机实际使用的码取 PSK。取不到就是 null，调用方必须拒绝这条配对而不是猜。 */
  resolveFor(token: string | undefined): PairSlot | null {
    if (!token) return null
    const slot = this.slots.get(token)
    if (!slot || slot.expiresAt < this.now()) return null
    return slot
  }

  /** 最近一张仍有效的码（只用于 `/drc pair` 展示与状态快照，绝不用于取密钥）。 */
  latest(): PairSlot | null {
    const alive = [...this.slots.values()].filter((slot) => slot.expiresAt >= this.now())
    if (alive.length === 0) return null
    return alive.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
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
