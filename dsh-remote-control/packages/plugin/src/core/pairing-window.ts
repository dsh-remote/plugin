/**
 * pairing-window — "让屏幕上永远有一张能用的码"这条策略。
 *
 * 为什么要有这一层（而不是在启动时发一张就完事）：取证
 * `docs/legacy-spec/host-plugin-runtime.md` §6.2。旧实现把它写成挂在状态快照里的
 * 3 秒循环，并且明确记着**三条 stale 判据各自防的事故**：
 *
 * - `!active` → 防"永远没有码"（一次发布失败之后就再也不发了）；
 * - `generationChanged` → 防"中继重启后一直挂一张死码"：中继的 pending-pair 表是内存的，
 *   重启即清空，那张码的 TTL 还没到但已经没人认得了；
 * - `剩余寿命 < 半程` → 防"用户扫到一个刚刚过期的码"。半程 + 3s 轮询 ⇒ 一张码在
 *   status.json 里的实际存活期约 `ttl/2 ~ ttl`。
 *
 * 新实现再加第四条判据，它是这次重写才有的能力：
 *
 * - `consumed` → 这张码已经被某部手机用掉了（`peer-joined` 带回的就是它的 token）。
 *   旧实现只能等半程刷新，于是"第二部手机要等新码"最坏要等半个 TTL；
 *   而 e2e 连跑多轮时每一轮都要一张**新码**（一次性码不可复用），
 *   没有这条判据的话多轮取证要么很慢、要么只能靠重启宿主。
 *
 * 还有一条不可让步的**发布闸门**：`relay === 'online'` 才发。
 * 因为 `RelayClient.raw()` 对非 OPEN 的 socket 是静默丢弃（`transport/relay.ts`），
 * 断连时"本地记了一张码、远端根本没收到"= 表里多一条永远配不上的 PSK，
 * 而 status.json 里却显示它有效（取证 §6.2 第 5 行）。
 *
 * 本模块是纯逻辑：不认 socket、不认 cordis、时钟与发布动作都由调用方注入，
 * 所以上面四条判据每一条都有单测（旧实现这三条**一条都没测过**）。
 */
import type { Clock } from '../ports/index.js'

/** 当前挂在 status.json 里的那张码。 */
export interface ActivePair {
  token: string
  /** 发起 `pair-begin` 的时刻；TTL 的两条基线都以它为准（见 §6.3 末尾那条不一致的记录）。 */
  createdAt: number
  expiresAt: number
  /** 发布时中继的代次；代次变了说明中继的 pending 表已经清空，这张码是死的。 */
  generation: number
}

export interface WindowInput {
  active: ActivePair | null
  now: number
  /** 中继当前代次。 */
  generation: number
  /** 每张码的请求寿命（毫秒）；服务端 `pair-ready.ttlMs` 落地后以它为准。 */
  ttlMs: number
}

/** 需要重新发布的原因；返回 null 表示这张码仍然可用。 */
export function staleReason(input: WindowInput): string | null {
  const { active, now, ttlMs, generation } = input
  if (!active) return 'no-active-pair'
  if (active.generation !== generation) return 'relay-generation-changed'
  if (active.expiresAt < now) return 'expired'
  if (active.expiresAt < now + ttlMs / 2) return 'past-half-life'
  return null
}

export interface WindowDeps {
  clock: Clock
  /** 中继此刻是否在线。 */
  relayOnline(): boolean
  /** 中继当前代次。 */
  generation(): number
  /** 发一张新码，返回它的三个时间量；失败返回 null（保留旧码继续展示）。 */
  publish(ttlMs: number): { token: string; createdAt: number; expiresAt: number } | null
  /** 每轮最多发布几张：发布失败（socket 未 OPEN）时不许原地打转。 */
  maxPublishPerTick?: number
  log(message: string, fields?: Record<string, string | number | boolean | undefined>): void
}

/**
 * 由调用方按节拍驱动（本仓库里是 `StatusFile.start()` 的 3 秒 tick——
 * 旧实现就是挂在这里，理由是"反正每 3 秒就要写一次状态"）。
 *
 * 刻意**不自带定时器**：定时器属于宿主，一个纯策略类不该再占一只。
 */
export class PairingWindow {
  active: ActivePair | null = null
  private requestedTtlMs: number | undefined

  constructor(
    private readonly deps: WindowDeps,
    private readonly pairSec: number,
  ) {}

  /** 服务端权威 TTL（`pair-ready.ttlMs`）：落地后覆盖请求值，并修正已挂出的那张码。 */
  applyServerTtl(pairingToken: string, ttlMs: number): void {
    if (ttlMs > 0) this.requestedTtlMs = ttlMs
    if (this.active && this.active.token === pairingToken) {
      // 基线用**发起时刻**（createdAt），不是 pair-ready 到达时刻：
      // 两条基线不一致时本地会比中继早失效（偏危险方向），取证 §6.3 末尾。
      this.active = { ...this.active, expiresAt: this.active.createdAt + ttlMs }
    }
  }

  /** 这张码已被某部手机用掉（`peer-joined` 带回的 token 就是它）。 */
  markConsumed(pairingToken: string): void {
    if (this.active?.token === pairingToken) {
      this.deps.log('pairing code consumed, publishing a fresh one', { token: pairingToken })
      this.active = null
    }
  }

  /**
   * 认领一张**别处**发出去的码（手工 `/drc pair`、或 status 之外的入口）。
   * 不认领的话窗口会认为"没有活动码"而再发一张，于是同一台主机挂两张有效码——
   * 手机扫的是屏幕上那张，取错密钥就是全线解不开（多码事故的原样）。
   */
  adopt(created: { token: string; createdAt: number; expiresAt: number }): void {
    this.active = { ...created, generation: this.deps.generation() }
  }

  /** 一轮检查。返回"这一轮是否发布了新码"。 */
  tick(): boolean {
    if (this.pairSec <= 0) return false
    // 发布闸门：**不在线就一张都不发**。`RelayClient.raw()` 对非 OPEN 的 socket 是静默丢弃，
    // 只记本地就会留下"status.json 显示有效、中继那边根本没收到"的死码（取证 §6.2）。
    if (!this.deps.relayOnline()) return false
    let published = false
    const max = this.deps.maxPublishPerTick ?? 1
    for (let attempt = 0; attempt < max; attempt++) {
      const ttlMs = this.ttlMs()
      const reason = staleReason({
        active: this.active,
        now: this.deps.clock.now(),
        generation: this.deps.generation(),
        ttlMs,
      })
      if (!reason) {
        // 不需要新码，但服务端 TTL 可能刚到：把已挂出那张的过期时间按权威值重算。
        return published
      }
      const created = this.deps.publish(ttlMs)
      if (!created) {
        this.deps.log('pairing publish failed', { reason })
        return published
      }
      this.active = { ...created, generation: this.deps.generation() }
      this.deps.log('pairing published', { reason, token: created.token, ttlMs })
      published = true
    }
    return published
  }

  /** 请求值来自 `pairOnStartSec`，服务端一旦回过 `ttlMs` 就以它为准。 */
  private ttlMs(): number {
    return this.requestedTtlMs ?? Math.max(1_000, this.pairSec * 1_000)
  }
}
