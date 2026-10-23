/**
 * pair-issuance —— 配对码的**签发 / 展示 / 补发 / 记账**（v5 R1 从 `index.ts` 抽出）。
 *
 * 这一块是"屏幕上那张码"的全部状态机：花名账（spentTokens）、展示位（shown）、
 * 发码（publish）、幂等取码（ensureFresh）、状态快照（describe）。
 * 本周三起真机事故（码被消费后没人补 / 解配后没人补 / 过期直接消失）全部住在这里 ——
 * 抽成一个模块的目的就是让"谁负责补码"这件事只有一个居所。
 *
 * ⚠️ **行为零变化**（R1 纪律）：本文件是从 `index.ts` 原样搬出来的，连注释一起搬；
 * 判据一片未动照样全绿（`relay-client` / `host-wiring` / `client-bundle` / `pairing-refresh`）。
 */
import type { Clock } from '../ports/index.js'
import { isoOrUndefined } from '../shell/iso.js'
import type { PairSlot, PairingSlots } from './keys.js'
import { tokenHandle, type PairingWindow } from './pairing-window.js'

/** 屏幕上那张码（`status.json` / pill 二维码 / `/pairing/new` 的共同口径）。 */
export interface LivePair {
  token: string
  expiresAt: number
}

export interface PairIssuanceDeps {
  clock: Clock
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  slots: Pick<PairingSlots, 'create' | 'resolveFor'>
  pairingWindow: Pick<PairingWindow, 'adopt' | 'staleNow'>
  /**
   * 把一张码发给中继。三态而不是 boolean：`no-relay`（还没连上）是静默的，
   * `not-open`（socket 不是 OPEN）要记日志 —— 两者原样保留 `index.ts` 的老行为。
   */
  publishSlot(slot: PairSlot): 'ok' | 'not-open' | 'no-relay'
  /** 未显式给 TTL 时的默认寿命。 */
  pairTtlMs: number
}

export interface PairIssuance {
  /** 这张码已经花掉（认领/作废），不许再发给任何人。 */
  spend(token: string): void
  /** 屏幕上现在那张（不发新的）。 */
  shown(): LivePair | null
  /** 清掉展示位（码被消费 / 被判死时）。 */
  clearShown(): void
  /** status.json 的 `pairing` 快照（含 psk，**只给本地状态面**，绝不上网）。 */
  describe(): Record<string, unknown> | null
  /** 当前仍然有效的那张，只读。 */
  current(): LivePair | null
  /** 发一张新的（登记展示位 + 认领进窗口）。 */
  publish(ttlMs?: number): { token: string; psk: string; expiresAt: number } | null
  /** 幂等版发码：已经有能用的就给那张，没有才向中继申请。 */
  ensureFresh(): LivePair | null
}

export function createPairIssuance(deps: PairIssuanceDeps): PairIssuance {
  const { clock, log, slots, pairingWindow, pairTtlMs } = deps
  const shownState: { pairing: LivePair | null } = { pairing: null }

  /**
   * **已经花掉、不许再发给任何人的配对码**。
   *
   * 为什么需要这一本账：配对码是一次性的（中继 `claim()` 里 `pending.used = true`，
   * 重放拿到 `already_used`）。而展示位——也就是 status.json 里那张、
   * 状态栏二维码那张、`/pairing/new` 发的那张——原来只由 `markConsumed` 与发码
   * 两个地方维护，于是只要没有新码顶上，屏幕上就一直挂着那张**已经花掉**的码：
   *
   * - 手机扫码 → 中继回 `already_used` → "新二维码连不上"；
   * - 而 `pairOnStartSec` 默认是 **0**（自动发码关着），所以没有任何东西会去换一张，
   *   只能干等这张码的 TTL 走完（线上中继 180 s）——用户说的"要等下次刷新的二维码才能用"。
   *
   * 判据把这三条路全钉住：消费一张、退出配对一次，展示位都不许再是花掉的那张。
   */
  const spentTokens = new Set<string>()
  /** 这本账只用来挡住"再把花掉的码发出去"，不需要长记忆：64 条足够跨过一次批量重配。 */
  const SPENT_MAX = 64
  function spend(token: string): void {
    if (!token) return
    spentTokens.add(token)
    while (spentTokens.size > SPENT_MAX) {
      const oldest = spentTokens.values().next().value
      if (oldest === undefined) break
      spentTokens.delete(oldest)
    }
  }

  /**
   * status.json 里的 `pairing` 必须是**窗口正在维护的那一张**（它的 QR 才在展示位里），
   * 不是 `slots.latest()`：手工 /drc pair 之后自动刷新会发新的一张，两者一旦分叉，
   * 外部脚本读到的是"一张没有二维码的码"。用 `resolveFor` 取密钥顺带把已过期的剔掉。
   */
  function describe(): Record<string, unknown> | null {
    const shown = shownState.pairing
    if (!shown) return null
    const slot = slots.resolveFor(shown.token)
    if (!slot) return null
    // 花掉的码不许再进 status.json：外部脚本照着它拼二维码，扫了必然失败。
    if (spentTokens.has(shown.token)) return null
    return {
      token: slot.token,
      psk: slot.psk,
      // 越界时给 undefined 而不是抛：`slot.expiresAt` 来自中继给的 ttlMs，
      // 而这一行在**构造 status 快照**的路径上（见 shell/iso.ts 的文件头）。
      expiresAt: isoOrUndefined(slot.expiresAt),
      ageSec: Math.max(0, Math.round((clock.now() - slot.createdAt) / 1000)),
    }
  }

  function publish(ttlMs = pairTtlMs): { token: string; psk: string; expiresAt: number } | null {
    const slot = slots.create(ttlMs)
    const outcome = deps.publishSlot(slot)
    if (outcome === 'no-relay') return null
    // 发不出去就不算一张码：`raw()` 对非 OPEN 的 socket 是静默丢弃，
    // 只记本地会留下"status.json 显示有效、中继那边根本没收到"的死码（取证 §6.2）。
    if (outcome === 'not-open') {
      log('pairing published to a socket that is not open', { code: tokenHandle(slot.token) })
      return null
    }
    const created = { token: slot.token, psk: slot.psk, expiresAt: slot.expiresAt }
    shownState.pairing = { token: created.token, expiresAt: created.expiresAt }
    // 新码天生没花过：从账上摘掉（同一张 token 被重发的极端情形下也安全）。
    spentTokens.delete(created.token)
    // 手工发的那张也要让窗口认领，否则窗口以为"没有活动码"又发一张。
    pairingWindow.adopt({ token: created.token, createdAt: clock.now(), expiresAt: created.expiresAt })
    return created
  }

  /**
   * 当前**仍然有效**的那张码，只读——不发新的。
   *
   * 用展示位而不是 `describe()`：后者带着 `psk`，而它的返回值会被
   * 状态栏那条图片路由间接消费；这里要的只是"屏幕上现在该显示哪张"。
   * `slots.resolveFor` 顺手把已过期的剔掉，所以 `pairing.png` 在没有效码时拿到 null → 204。
   */
  function current(): LivePair | null {
    const shown = shownState.pairing
    if (!shown) return null
    const slot = slots.resolveFor(shown.token)
    if (!slot) return null
    // 花掉的码一律当"没有码"：调用方（`ensureFresh` 与 `pairing.png`）会去补一张新的，
    // 而不是把一张扫了必然 `already_used` 的码递给用户。
    if (spentTokens.has(shown.token)) return null
    // 过期时刻以 **slot** 为准，不是展示位里那份出码时的旧值：中继的 pair-ready 会用
    // 服务端权威 TTL 改写 slot.expiresAt（线上中继发的是 180s，本地默认 120s），
    // 而展示位没人更新。用旧值算 expiresInMs，本地过期之后 slot 还有效的那一整段里，
    // 发码路由每次都回 expiresInMs=0，pill 上就是"发码回答里的码不完整"，
    // 而且按一次撞一次（2026-10-04 用户实测：断开重连后点刷新必现）。
    return { token: shown.token, expiresAt: slot.expiresAt }
  }

  /**
   * 幂等版发码：已经有一张能用的就给那张，没有才向中继申请新的。
   *
   * 为什么必须幂等：状态栏那颗 pill 是可以连点的，而每点一次发一张的话，
   * 中继的 pending 表里会同时挂着三个 PSK，屏幕上显示的却是其中一张——
   * 手机扫到没被显示的那张就全线解不开。那正是当初"多码事故"的形状。
   */
  function ensureFresh(): LivePair | null {
    /**
     * **"屏幕上那张还能不能用"要问窗口，不能只问本地 TTL**（2026-10-06）。
     *
     * 中继重启后它内存里的 pending-pair 表已经空了：屏幕上那张码在中继那边**已经死了**，
     * 而本地 `expiresAt` 还没到。旧实现把它直接当 fresh 返回 —— 用户点"刷新"拿到的
     * 还是同一张死码，只能干等 TTL 走完（用户报的"要等下次刷新的二维码才能用"里，
     * 最坏的一档就是这个）。`staleNow()` 复用窗口那套判据（代次变了 / 过期 / 过半程），
     * 与自动换码同一口径，两处不会分叉。
     */
    const shown = current()
    const fresh = shown && !pairingWindow.staleNow() ? shown : publish()
    if (!fresh) return null
    // 兜底一道：resolveFor 用 clock.now()，而路由算 expiresInMs 用 Date.now()，
    // 两个时钟之间有窗口；服务端 TTL 改写也让"还有效"这件事有两个口径。
    // 到点的码不当 fresh——现补一张（中继不在就回 null，路由那边会说 unavailable），
    // 而不是回一个 expiresInMs=0 的"完整码"让 pill 显示"码不完整"。
    if (fresh.expiresAt <= Date.now()) return publish()
    // **在这里就把 psk 摘掉**，而不是靠"下游记得只读那三个字段"：这条返回值会被浏览器
    // 可达的那条发码路由间接消费，红线（PSK 从不上网）要靠形状成立，不靠调用方自律。
    return { token: fresh.token, expiresAt: fresh.expiresAt }
  }

  return {
    spend,
    shown: () => shownState.pairing,
    clearShown: () => {
      shownState.pairing = null
    },
    describe,
    current,
    publish,
    ensureFresh,
  }
}
