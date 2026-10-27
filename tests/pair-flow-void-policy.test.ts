/**
 * 「只允许一台」那条策略的作废判据（2026-10-27）。
 *
 * ## 这条策略为什么值得单独守
 *
 * 现场（生产 relay 容器日志，10-27 10:29–10:38Z）：一台主机 `drc-63a5d5717e5b`
 * 配过 **6 个不同 clientId**，每一台新手机进来就把上一台踢掉（作废发生在配成后
 * **+16.7s ～ +101.7s**，`clients=1`）。被踢的手机手里还捏着那张**已经烧掉的码**，
 * 重连再拿它认领 ⇒ 中继 `already_used` ⇒ 用户被迫反复扫码，而主机侧一条异常日志都没有。
 *
 * ⇒ 修法：**同一台手机重配 ⇒ 不作废它自己的旧通道**（判据是成员表里有它）。
 *
 * ## ⚠️ 判据纪律（2026-10-27 真踩过）
 *
 * 第一版判据**桩了一份自己的策略实现**来测 ⇒ 删掉产品里的修复行，判据**一条没红**
 * （721 条全绿）⇒ 那是「测桩不测产品」的假绿。
 * ⇒ 决策抽成纯函数（`core/void-policy.ts`），产品与判据**跑同一份代码**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectConversationsToVoid, shouldVoidConversation } from '../src/core/void-policy.js'

/** 两条旧通道：`c_same` 属于 `mv_phone_a`，`c_other` 属于 `mv_phone_b`。 */
const MEMBER_TABLE: Record<string, string[]> = {
  c_same: ['mv_phone_a'],
  c_other: ['mv_phone_b'],
}
const clientIdsOf = (id: string): string[] => MEMBER_TABLE[id] ?? []

test('同一台手机重配：它自己的旧通道**不作废**', () => {
  const toVoid = selectConversationsToVoid(['c_same', 'c_other'], 'c_new', 'mv_phone_a', clientIdsOf)
  assert.deepEqual(toVoid, ['c_other'], '同一台手机的旧通道不得被作废（它只是重配）；别的手机的通道照旧作废')
})

test('**反证**：换一台手机进来 ⇒ 旧通道**全部**被作废（「只允许一台」的原意不能丢）', () => {
  const toVoid = selectConversationsToVoid(['c_same', 'c_other'], 'c_new', 'mv_phone_c', clientIdsOf)
  assert.deepEqual(
    toVoid.sort(),
    ['c_other', 'c_same'],
    '换了一台手机 ⇒ 旧通道必须全部作废（这一条红了说明策略被改废）',
  )
})

test('查不到成员（空表）⇒ **照旧作废**（无法证明是同一台，不因信息缺失放宽策略）', () => {
  const toVoid = selectConversationsToVoid(['c_same'], 'c_new', 'mv_phone_a', () => [])
  assert.deepEqual(toVoid, ['c_same'], '成员表为空时必须照旧作废（把这里放宽 = 「只允许一台」形同虚设）')
})

test('中继没带 clientId ⇒ 退回旧行为（全部作废），不许猜', () => {
  const toVoid = selectConversationsToVoid(['c_same', 'c_other'], 'c_new', undefined, clientIdsOf)
  assert.deepEqual(toVoid.sort(), ['c_other', 'c_same'], '没有 clientId 时不许靠猜：与修复前行为一致（全部作废）')
})

test('新通道自己永远不被作废', () => {
  assert.equal(shouldVoidConversation('c_new', 'c_new', 'mv_phone_a', clientIdsOf), false)
})

test('一条都没有旧通道时 ⇒ 不作废任何东西（不凭空造事）', () => {
  assert.deepEqual(selectConversationsToVoid([], 'c_new', 'mv_phone_a', clientIdsOf), [])
})
