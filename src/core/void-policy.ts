/**
 * 「只允许一台」那条策略的**作废判据**（纯函数，2026-10-27）。
 *
 * ## 为什么抽出来
 *
 * 这条策略原先埋在 `index.ts` 的闭包里，判据只能**桩一份自己的实现**来测 ——
 * 那等于**测桩不测产品**：把产品里的那一行删掉，判据照样全绿（2026-10-27 真踩过：
 * 变异体验证时删掉修复行，721 条判据**一条没红**）。
 *
 * ⇒ 决策抽成纯函数：产品与判据**跑同一份代码**。
 *
 * ## 这条策略为什么值得单独守
 *
 * 现场（生产 relay 容器日志，10-27 10:29–10:38Z）：一台主机 `drc-63a5d5717e5b`
 * 配过 **6 个不同 clientId**，每一台新手机进来就把上一台踢掉（作废发生在配成后
 * **+16.7s ～ +101.7s**，`clients=1`）。被踢的手机手里还捏着那张**已经烧掉的码**，
 * 重连再拿它认领 ⇒ 中继 `already_used` ⇒ 用户被迫反复扫码，而主机侧一条异常日志都没有。
 *
 * ⇒ 修法：**同一台手机重配 ⇒ 不作废它自己的旧通道**（判据是成员表里有它）。
 */

/**
 * 该不该作废某条**旧**通道。
 *
 * @param conversationId 旧通道的 id
 * @param keepId 新通道的 id（新通道自己当然不作废）
 * @param joiningClientId 刚进来的那台手机（`undefined` = 中继没带这个信息）
 * @param clientIdsOf 读一条通道的成员表
 * @returns true = 该作废
 */
export function shouldVoidConversation(
  conversationId: string,
  keepId: string,
  joiningClientId: string | undefined,
  clientIdsOf: (id: string) => string[],
): boolean {
  if (conversationId === keepId) return false
  /**
   * **同一台手机重配 ⇒ 不作废它自己的旧通道**（2026-10-27）。
   *
   * 它不是「换了一台设备」，只是同一部手机重新配了一次 ⇒ 旧通道不该被踢。
   */
  if (joiningClientId !== undefined && clientIdsOf(conversationId).includes(joiningClientId)) return false
  /**
   * ⚠️ 查不到成员（空表）**不等于**「不是同一台」—— 成员表是瞬时态
   * （进程刚起来时为空，只有收到这台手机的帧之后才有）。
   * ⇒ 那时**照旧作废**：无法证明是同一台，不因为信息缺失就放宽「只允许一台」。
   */
  return true
}

/**
 * 「只允许一台」：**新通道进来，其余通道里该作废的那些**。
 *
 * ⚠️ 顺序稳定（按 `allIds` 的原序）—— 判据要能硬写期望值。
 */
export function selectConversationsToVoid(
  allIds: string[],
  keepId: string,
  joiningClientId: string | undefined,
  clientIdsOf: (id: string) => string[],
): string[] {
  return allIds.filter((id) => shouldVoidConversation(id, keepId, joiningClientId, clientIdsOf))
}
