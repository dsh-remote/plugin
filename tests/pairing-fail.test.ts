/**
 * pairing-fail — 中继说"这张码没配上"时，**该作废哪一张**。
 *
 * 这一段逻辑原来内联在 `index.ts` 的 `onPairFail` 里，而**一行判据都没有**：
 * `RelayClient` 源码里没有 socket 注入点（见 `relay-client.test.ts` 的文件头），
 * 所以"喂一帧 pair-fail 进 apply()"在当前装置下做不到。抽成纯函数就是为了
 * 让它可测——一个"会不会误伤一张有效码"的地方不该没有判据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decidePairFail } from '../src/shell/pairing-fail.js'

test('情形 ①：失败的正是展示中的那张 → 作废它并清展示位', () => {
  // 这与旧行为逐字一致：屏幕上那张自己废了，用户得看新的。
  const d = decidePairFail('111111', '111111')
  assert.equal(d.victim, '111111')
  assert.equal(d.clearShown, true)
})

test('情形 ②：失败的是**另一张** → 只作废那一张，展示位**不动**', () => {
  // ⚠️ 这一条就是那次误伤。屏幕上是码 B（完全有效），用户扫了一张早就过期的
  // 码 A → 中继回 invalid_or_expired → 旧实现把 B 记成已花并 forget。
  //
  // 症状不是"多扫一次码"：B 的 PSK 被丢弃意味着那条配对通道作废，而那正是
  // 「取错 PSK 全线解不开」事故的前置条件。
  const d = decidePairFail('B-good', 'A-expired')
  assert.equal(d.victim, 'A-expired', '只作废真正失败的那张')
  assert.equal(
    d.clearShown,
    false,
    '展示位必须**不动**：清掉它等于用户手上那张有效的码被自己的机器撤回，' + '而屏幕上会换成一张他没扫过的新码',
  )
})

test('反向判据：把情形 ② 的 clearShown 写成 true —— 那正是要防的误伤', () => {
  // 单独再钉一次，让"误伤"这个形状在判据里有一个专属的名字。
  const d = decidePairFail('B-good', 'A-expired')
  assert.notEqual(d.clearShown, true, '一张有效的展示码被别人的失败牵连掉 = 本次修的那个 bug')
})

test('情形 ③：中继没给 token（更老的一版）→ 退回"作废展示中的那张"', () => {
  // 兼容那条路必须**逐字**保持旧行为：升级中继要重启容器、升级插件只要重开
  // Harness，两者节奏不同，所以"新主机 + 老中继"是真实组合。
  const d = decidePairFail('111111', undefined)
  assert.equal(d.victim, '111111', '中继没点名时只能作废自己知道的那张')
  assert.equal(d.clearShown, true)
})

test('反向判据：什么都没有时是安全的空操作（不许凭空造出一张"受害者"）', () => {
  const none = decidePairFail(undefined, undefined)
  assert.equal(none.victim, undefined, 'forget(undefined) 是一次无意义的查表')
  assert.equal(none.clearShown, false, '没有展示位可清')
  // 失败的那张有、中间没有展示位：仍要作废它（免得窗口补一张一样的）
  const orphan = decidePairFail(undefined, '999999')
  assert.equal(orphan.victim, '999999')
  assert.equal(orphan.clearShown, false)
})

test('判据不许把"中继没告诉我们"与"中继说就是这张"混成一种', () => {
  // 这两种入参在情形 ①/③ 下 victim 相同，但**语义不同**：③ 意味着"这台中继太老"，
  // ① 意味着"这张码废了"。混起来的后果是将来想按语义分支（比如 ③ 少补一张码）
  // 时没有信号可依据。
  const withoutToken = decidePairFail('x', undefined)
  const sameToken = decidePairFail('x', 'x')
  assert.equal(withoutToken.victim, sameToken.victim, '两者在这一格上结果相同')
  // 真正必须分开的是情形 ②：那里 clearShown 要不同。
  assert.notEqual(decidePairFail('x', 'y').clearShown, sameToken.clearShown, '别人的失败不许牵连自己的展示位')
})
