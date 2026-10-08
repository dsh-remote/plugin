/**
 * 补差量在**宿主侧**的判据 —— B4 的出口。
 *
 * 协议层（B1）钉住了形状；这里钉住行为。三条，每条都对着一个真实会写错的地方：
 *
 * 1. **互斥**：`since` 与 `beforeSeq` 同时给要拒。协议层已经先拒一道，
 *    这里第二道——因为 mock 与真实载体是两条实现，只靠 schema 那一道会漏。
 * 2. **窗口外明说**：`since` 落在保留窗口之外时抛 `history_window_exceeded`，
 *    **不许**静默从窗口头部开始给。后者的后果是手机以为补齐了，
 *    中间那段永远补不回来——而用户看到的是"消息偶尔少几行"。
 * 3. **`since` 是排他下界**（取 `seq > since`）：手机记的就是它已看到的最大 seq，
 *    写成 `>=` 会把已看过的那条重发一遍。
 *
 * 为什么用 mock 载体而不是真内核：真内核在 CI 上不存在，而这三条的形状
 * 与载体无关（它们是"取值范围"的问题）。真机取证的配方在 docs/HOST-SIDE.md。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockKernel } from '../src/platform/mock-kernel.js'
import { HISTORY_WINDOW_EXCEEDED } from '../src/ports/index.js'
import { FakeClock } from '../src/core/clock.js'
import type { KernelEvent } from '../src/ports/index.js'

/** 造 n 条历史（mock 的 seq 就是下标，见 mock-kernel 的 readHistory 注释）。 */
function history(n: number): KernelEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'delta' as const,
    sessionId: 'ses_r',
    messageId: `m_${i}`,
    text: `t${i}`,
    done: false,
  }))
}

/** messageId 只在 kind==='delta' 上有——跨联合直接访问会编译不过。 */
const idOf = (e: KernelEvent): string => (e.kind === 'delta' ? e.messageId : JSON.stringify(e).slice(0, 8))

const kernelWith = (opts: { history?: KernelEvent[]; historyWindow?: number } = {}) =>
  new MockKernel({ clock: new FakeClock(), ...opts })

test('① since 与 beforeSeq 同时给要拒（两个方向一起走没有可定义的语义）', async () => {
  const kernel = kernelWith({ history: history(10) })
  await assert.rejects(
    () => kernel.readHistory!('ses_r', { since: 3, beforeSeq: 6, limit: 10 }),
    /互斥/,
    '协议层 schema 已经先拒一道，这里是第二道：mock 与真实载体是两条实现',
  )
})

test('② since 落在保留窗口之外 ⇒ 明确报错，不许静默从窗口头部开始给', async () => {
  // 20 条历史但只保留最近 8 条 ⇒ 窗口起点是 12
  const kernel = kernelWith({ history: history(20), historyWindow: 8 })
  // since=2 远早于窗口起点 ⇒ 补不回来
  await assert.rejects(
    () => kernel.readHistory!('ses_r', { since: 2, limit: 10 }),
    (error: Error) => {
      assert.match(error.message, new RegExp(HISTORY_WINDOW_EXCEEDED), '要带上那个可识别的码：宿主侧据此映射成协议错误码')
      assert.match(error.message, /窗口/, '错误信息要说清是"窗口外"，而不是笼统的"读不到"')
      return true
    },
    '静默返回窗口内的那些 = 手机以为补齐了，中间那段永远补不回来',
  )
  // 窗口内则正常工作
  const ok = await kernel.readHistory!('ses_r', { since: 12, limit: 10 })
  assert.ok(ok.events.length > 0, '窗口起点上的 since 应当能补')
})

test('③ since 是排他下界（seq > since）：手机已看过的那条不重发', async () => {
  const kernel = kernelWith({ history: history(10) })
  const page = await kernel.readHistory!('ses_r', { since: 3, limit: 100 })
  // seq 就是下标：since=3 ⇒ 取 4..9 共 6 条，第 3 条（手机已有的）不重发
  assert.equal(page.events.length, 6, 'since=3 应当补 4..9 六条，不含 3 本身')
  assert.deepEqual(
    page.events.map(idOf),
    ['m_4', 'm_5', 'm_6', 'm_7', 'm_8', 'm_9'],
    '补差量的第一条必须正好是 since 的下一条（off-by-one 在这里现形）',
  )
})

test('④ 空页也要给 latestSeq（否则手机没有可记的值）', async () => {
  const kernel = kernelWith({ history: history(5) })
  // since=4 已经是最后一条 ⇒ 空页
  const page = await kernel.readHistory!('ses_r', { since: 4, limit: 10 })
  assert.equal(page.events.length, 0, '前置条件：这一页确实是空的')
  assert.equal(
    page.latestSeq,
    4,
    '空页也必须报 latestSeq：手机靠它记"到哪了"。没有它，手机要么记 0（整段重拉）要么记陈旧值（重复收）',
  )
})

test('⑤ latestSeq 与翻页路径给的值一致（两条路必须回答同一个"到哪了"）', async () => {
  const kernel = kernelWith({ history: history(10) })
  const viaBefore = await kernel.readHistory!('ses_r', { beforeSeq: 6, limit: 2 })
  const viaSince = await kernel.readHistory!('ses_r', { since: 3, limit: 2 })
  // 两个都是 seq 4、5 那一段 ⇒ latestSeq 必须相同
  assert.deepEqual(
    viaBefore.events.map(idOf),
    viaSince.events.map(idOf),
    '同一段内容，两条路必须给出相同结果',
  )
  assert.equal(viaBefore.latestSeq, viaSince.latestSeq, 'latestSeq 必须一致：它是手机唯一的游标来源')
})

test('反向判据：把排他下界写成 >= ，上面第 ③ 条会立刻红', () => {
  // 证明它真的在测「排他」而不是碰巧
  const since = 3
  const wrong = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((seq) => seq >= since)
  const right = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((seq) => seq > since)
  assert.equal(wrong.length, 7, '写成 >= 会多补一条（seq=3）')
  assert.equal(right.length, 6, '正确的排他下界是 6 条')
})