/**
 * pairing-fail — 中继说"这张码没配上"时，**该作废哪一张**。
 *
 * ## 为什么它是一个独立文件
 *
 * 原来这段逻辑内联在 `index.ts` 的 `onPairFail` 里，而那一层**测不到**：
 * `host-wiring.test.ts` 走的是真 `apply()`，而 `RelayClient` 源码里没有
 * socket 注入点（见 `relay-client.test.ts` 的文件头），所以"喂一帧 pair-fail
 * 进 apply()"这件事在当前装置下做不到。
 *
 * 结果是这段逻辑**一行判据都没有**——而它恰好是"会不会误伤一张有效码"的地方。
 * 抽成纯函数之后三种情形都能在纯内存里驱动。
 *
 * ## 那次误伤的具体形状（2026-10-07 修）
 *
 * `pair-fail` 帧原先只有 `reason`，而这里的处理是"作废**当前展示的那张**"——
 * 于是它只能拿 `active.pairing` 顶罪。多码并存时：
 *
 *   屏幕上是码 B（完全有效）｜用户扫了一张早就过期的码 A
 *   → 中继回 `invalid_or_expired`
 *   → 旧实现把 B 记进 `spentTokens` 并 forget，再补一张 C
 *
 * 症状不是"多扫一次码"：B 的 PSK 被丢弃意味着那条配对通道作废，
 * 而那正是 `transport/relay.ts` 文件头引用的那起「取错 PSK 全线解不开」的
 * 前置条件。用户看到的是「我扫的码没用，主机又换了一张」——而他刚扫的那张
 * 其实是好的。
 */

/** 这次失败该作废哪一张、以及展示位要不要清。 */
export interface PairFailDecision {
  /** 要记成"已花"的那张码；`undefined` = 手上没有任何码可作废。 */
  readonly victim: string | undefined
  /** 展示位要不要清掉（换新码）。 */
  readonly clearShown: boolean
}

/**
 * 三种情形（判据逐条覆盖，见 `tests/pairing-fail.test.ts`）：
 *
 * ① 中继给了 token 且它就是展示中的那张 → 作废它、清展示位（与旧行为同一条路）；
 * ② 中继给了 token 但**不是**展示中的那张 → 那张是别人扫的旧码，
 *    **只把它记成已花**（免得窗口再补一张一样的），展示位**不动**；
 * ③ 中继没给（更老的一版）→ 退回"作废展示中的那张"，与旧行为逐字一致。
 *
 * @param shownToken 当前展示在屏幕上的那张（`active.pairing?.token`）
 * @param failedToken 中继点名的那张；`undefined` = 中继没告诉我们
 */
export function decidePairFail(shownToken: string | undefined, failedToken: string | undefined): PairFailDecision {
  // ⚠️ 顺序要紧：③ 必须**先**判，否则 `undefined ?? shown` 会把"中继没给"
  // 与"中继说失败的那张就是展示中的"两种情况混成一种——而它们的清展示位
  // 动作恰好相同、victim 也相同，所以这里用 `=== undefined` 显式写出来，
  // 让"中继没告诉我们"这件事在代码里看得见。
  if (failedToken === undefined) {
    return { victim: shownToken, clearShown: shownToken !== undefined }
  }
  if (shownToken !== undefined && failedToken === shownToken) {
    return { victim: failedToken, clearShown: true }
  }
  // 情形 ②：失败的是另一张（用户扫了张旧的/别人的）。
  // ⚠️ **不要**顺手 `clearShown: true` —— 那正是这次修的那个误伤。
  return { victim: failedToken, clearShown: false }
}
