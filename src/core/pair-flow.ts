/**
 * pair-flow —— 配对的**认领 / 放行 / 回滚三档**（v5 R2 从 `index.ts` 抽出）。
 *
 * 住在这里的语义（都出过真机事故，注释原样跟着搬）：
 * - `onPairRequest`：小程序码认领 → SAS 挂出 → **自动放行**（确认只留手机端）；
 * - `onPeerJoined`：只允许一台（旧通道当场作废）+ **消费即补发**（码被 claim 烧掉）；
 * - `onPairFail`：只作废**真正失败**的那张（三情形判定在 `shell/pairing-fail.ts`），
 *   限速窗口内不自动补码；
 * - `onClientUnpaired`：手机解配 ⇒ 主机屏幕回到"能再配一次"（欠账 + online 补发）；
 * - `onPairReady`：服务端权威 TTL（不改写会"配对成功但全解不开"）。
 *
 * ⚠️ **行为零变化**（R2 纪律）：判据一片未动照样全绿；变异反证见提交信息。
 */
import type { Clock } from '../ports/index.js'
import { decidePairFail } from '../shell/pairing-fail.js'
import { tokenHandle } from './pairing-window.js'
import type { PairIssuance } from './pair-issuance.js'

/** 限速退避：被拒后多久内不自动补码（自动补码撞限速是自我加速的循环）。 */
const PAIR_RATE_LIMIT_BACKOFF_MS = 2_000

export interface PairFlowDeps {
  clock: Clock
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  /** SAS 挂卡 / 取走即焚的放行（`shell/pair-approval.ts`）。 */
  pairApproval: {
    offer(pairingToken: string, clientPub: string, sessionId: string): { sas: string } | null
    approve(): { hostPub: string; nonce: string; wrappedPsk: string; sessionId: string } | null
  }
  slots: { applyServerTtl(token: string, ttlMs: number): boolean }
  pairingWindow: {
    markConsumed(token: string): void
    applyServerTtl(token: string, ttlMs: number): void
    forget(token: string): void
  }
  issuance: PairIssuance
  /** 把 psk 加密送回手机（`relay.sendPairGrant`）。 */
  sendPairGrant(granted: { hostPub: string; nonce: string; wrappedPsk: string; sessionId: string }): void
  /** 只允许一台：新通道进来，其余全部作废。 */
  voidOtherConversations(keepId: string): void
  /** 新配对建立 ⇒ 运行时起来。 */
  startRuntime(): void
}

export interface PairFlow {
  onPairRequest(pairingToken: string, clientPub: string, sessionId: string): void
  onPairReady(pairingToken: string, ttlMs: number): void
  onPeerJoined(conversationId: string, pairingToken: string | undefined): void
  onPairFail(reason: string, failedToken: string | undefined): void
  onClientUnpaired(): void
  /** 放行一条挂起的申请（取走即焚）。 */
  grant(): boolean
  /** 中继限速了：进退避窗口（`onRelayError` 的 rate_limited 分支）。 */
  noteRateLimited(retryAfterMs?: number): void
  /** 中继回来了：退避与欠账一起清（`onState` 的 online 过渡）。 */
  resetRateLimitAndRetryOwed(): void
  /** 诊断读数：退避窗口到什么时候。 */
  rateLimitedUntil(): number
}

export function createPairFlow(deps: PairFlowDeps): PairFlow {
  const { clock, log, pairApproval, slots, pairingWindow, issuance } = deps
  /** 限速退避窗口的截止时刻（0 = 没被限过 / 已过窗）。 */
  let pairRateLimitedUntil = 0
  /**
   * **欠一张码**：解配/换码那一刻中继不在线，补发没能成。
   * `online` 之后补上，否则用户要点一下「刷新」才看得到码 —— 而"要点一下"正是
   * 这次报的毛病。只在 `online` 过渡时读一次，不会变成每 3 秒的发码风暴。
   */
  let pairingCodeOwed = false

  /**
   * 放行一条配对申请：把 psk 加密送回手机（2026-10-21）。
   *
   * 取走即焚：`pairApproval.approve()` 一次性的，重复调用返回 null。
   * 返回 false = 没有可放行的申请（已过期 / 已放行过 / 那边没挂着）。
   */
  function grant(): boolean {
    const granted = pairApproval.approve()
    if (!granted) return false
    deps.sendPairGrant(granted)
    return true
  }

  /**
   * 手机拿着小程序码来认领（带一次性公钥）：算出 6 位数字挂起来。
   *
   * ## 这里**自动放行**（2026-10-21，用户裁决"只保留一边确认"）
   *
   * 原来是"不自动放行"：要人去主机上点一次「数字一致，允许」，主机才把 psk 加密送回。
   * 于是**两边都要点一次**，而手机上那一次**才是**真正的安全动作 —— 它比对的是
   * "主机算出来的那串"与"手机自己算出来的那串"，**这是发现中继换公钥的唯一手段**。
   *
   * 主机那一次点击**不增加任何安全性**：它只是把"用户已经看过手机上的数字"说了一遍。
   * 真正的比对必须在**持有手机**的那一端做。⇒ 主机改成自动放行，**确认只留在手机端**。
   *
   * ⚠️ **安全性质没有因此降低**：中继换掉公钥时，两端算出的数字不同 ⇒ 手机上的弹窗
   * 会显示一个与主机屏幕上的**不一样**的数字 ⇒ 用户点"不一致"即可中止。主机界面
   * **仍然显示那 6 位数字**（供用户对照，也供排错取证）。
   */
  function onPairRequest(pairingToken: string, clientPub: string, sessionId: string): void {
    const offered = pairApproval.offer(pairingToken, clientPub, sessionId)
    if (offered === null) {
      log('pair approval ignored', { reason: 'unknown-or-expired-token' })
      return
    }
    // 只记码的摘要与数字，不记 token 原文（与既有日志纪律一致）。
    log('pair approval requested', { sas: offered.sas, epoch: tokenHandle(pairingToken) })
    // 自动放行：psk 加密送回。手机上那一次确认才是安全动作（见上面那段）。
    if (!grant()) log('pair auto-grant failed', { epoch: tokenHandle(pairingToken) })
  }

  function onPairReady(pairingToken: string, ttlMs: number): void {
    // 服务端权威 TTL：不改写就会提前清掉 PSK，造成"配对成功但全解不开"。
    //
    // ⚠️ 这里**只能记 tokenHandle(token)**（码文本的 sha256 前 8 位）。原来记的是
    // `{ token }` —— 把 6 位配对码**原样**写进了 stdout（§0.10.7 那条纪律）。
    if (!slots.applyServerTtl(pairingToken, ttlMs))
      log('pair-ready for an unknown token', { code: tokenHandle(pairingToken) })
    pairingWindow.applyServerTtl(pairingToken, ttlMs)
  }

  function onPeerJoined(conversationId: string, pairingToken: string | undefined): void {
    /**
     * **只允许一台**（2026-10-03 拍板）。中继在通知我们之前已经把这条新通道开好了
     * （`relay.ts` 的 peer-joined 先 `conversations.open` 再回调），所以这里要作废的是
     * **除它以外**的所有通道——新设备一进来，旧设备当场被踢下去。
     *
     * 走 `voidConversation` 而不是只删本地：只删本地的话，中继仍会把旧手机的密文转过来，
     * 而那台手机面对的是一个听不见的对端（R1 那个静默黑洞）。
     */
    deps.voidOtherConversations(conversationId)
    deps.startRuntime()
    /**
     * ⚠️ **这里不推任何东西**（2026-10-21 订正，3.2 配对改造的后果）。
     *
     * 3.2 起配对只有 `pair-grant` 一条路：psk 等用户比对完 6 位数字才装进手机。
     * 而 `peer-joined` 是**手机一连上就到**的（早于 pair-grant）⇒ 这一刻手机解不开
     * 任何密文（`_onEncrypted` 开头 `if (!this.kH2C) return false`，静默丢）。
     * 推东西统一由 `onClientRejoined`（"这台手机的密钥面就绪"）一次推全。
     */
    // 一次性码用掉了就当场换一张新的（而不是等半程刷新）：第二部手机要的是一张新码。
    if (pairingToken) {
      pairingWindow.markConsumed(pairingToken)
      // status.json 里也不能再挂着这张已经用掉的码：外部脚本只看年龄，不看是否被消费。
      if (issuance.shown()?.token === pairingToken) issuance.clearShown()
      // 无论屏幕上是不是它，这张码都已经花掉——记账，之后任何一条发码路都不许再给出去。
      issuance.spend(pairingToken)
      /**
       * **补发就在这里**（2026-10-23）。"当场换一张新的"原来只做了前半（清掉旧的）——
       * 重发指望 `pairingWindow.tick()`，而 tick 在 `pairOnStartSec <= 0`（默认）且
       * `active === null` 时**直接早退** ⇒ 消费之后再也没人补码：屏幕上的 QR 已经烧掉，
       * 重扫必 `already_used`（真机 2026-10-23 07:0x 实测）。
       */
      issuance.publish()
    }
    log('client paired', { conversationId })
  }

  /**
   * 中继宣告"这张配对码没配上"。处理：**清展示位 + 作废这张码 + 立刻补一张**
   * （同一时刻屏幕上必须有一张能用的）。
   *
   * ⚠️ 限速**不在 `reason` 里**：中继的配对限流落到线上时被折成 `invalid_or_expired`。
   * 真正的信号来自 `onRelayError` 的 `rate_limited`（见 `noteRateLimited`）。
   */
  function onPairFail(reason: string, failedToken: string | undefined): void {
    /**
     * **只作废真正失败的那张**（2026-10-07）：原来"作废当前展示的那张"，多码并存时
     * 会**作废错的那张**——屏幕上是码 B（有效），用户扫了旧码 A → B 被记成已花，
     * B 的 PSK 被丢弃 ⇒ 那条配对通道作废（「取错 PSK 全线解不开」事故的前置条件）。
     *
     * 三种情形的判定在 `shell/pairing-fail.ts`（纯函数、各有判据）：
     * ① 点得出 token 且就是展示中的那张 → 作废它；
     * ② 点得出 token 但不是展示中的 → 旧码被扫，只记已花，展示位不动；
     * ③ 点不出是哪一张 → 退回"作废展示中的那张"。
     */
    const decision = decidePairFail(issuance.shown()?.token, failedToken)
    if (decision.victim) {
      issuance.spend(decision.victim)
      pairingWindow.forget(decision.victim)
    }
    if (decision.clearShown) issuance.clearShown()
    log('relay rejected the pairing code', { reason })
    const waitMs = pairRateLimitedUntil - clock.now()
    if (waitMs > 0) {
      // 不补码，但**把原因记下来**：用户点「刷新」仍然随时可以（那是人的决定）。
      log('pairing republish deferred while rate limited', { waitMs })
      return
    }
    issuance.publish()
  }

  /**
   * **手机端解配 ⇒ 主机立刻补一张能再配一次的码**（2026-10-23 用户报：
   * "手机端退出配对，主机端不会自动刷码"）。主机自己那颗「退出配对」（`unpairAll`）
   * 早就会补一张 —— 两端语义要对称：不管解配从哪端发起，主机屏幕都该回到
   * "能再配一次"的样子。中继不在线时不硬发，记欠账、`online` 之后补上。
   */
  function onClientUnpaired(): void {
    const code = issuance.ensureFresh()
    pairingCodeOwed = code ? false : true
    log('client unpaired', { reissued: Boolean(code) })
  }

  function noteRateLimited(retryAfterMs?: number): void {
    const wait = retryAfterMs ?? PAIR_RATE_LIMIT_BACKOFF_MS
    pairRateLimitedUntil = Math.max(pairRateLimitedUntil, clock.now() + wait)
    log('relay rate limited us', { waitMs: wait })
  }

  function resetRateLimitAndRetryOwed(): void {
    pairRateLimitedUntil = 0
    if (pairingCodeOwed && issuance.ensureFresh()) pairingCodeOwed = false
  }

  return {
    onPairRequest,
    onPairReady,
    onPeerJoined,
    onPairFail,
    onClientUnpaired,
    grant,
    noteRateLimited,
    resetRateLimitAndRetryOwed,
    rateLimitedUntil: () => pairRateLimitedUntil,
  }
}
