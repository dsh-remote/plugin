/**
 * mock-kernel 的两条记账纪律。
 *
 * ## 为什么这个文件存在（而不是并进 runtime.test.ts）
 *
 * mock 内核是**端到端判据的最后一公里**：`e2e/run.mjs` 那类本地闭环与
 * `e2e/live-e2e.mjs` 的"手机指定了分组真的生效了吗"都靠它当内核替身。
 * 而替身**少记一件事**时，整条链看起来完全正常——它照样回 `ok:true`、照样把
 * 新会话塞进列表，只是列表里那一行没有 workspace。于是判据只能去翻内部状态，
 * 而翻内部状态的判据正是历史上骗过自己的那一类。
 *
 * ## 这两条为什么值得钉
 *
 * 1. `newSession({workspace})` 必须把 workspace 记进摘要 —— 真载体也是这么做的
 *    （`carrier-services` 的 `freshSessions`），替身不跟就是"假实现与实现不同源"；
 * 2. `ses_mock` 前缀必须保留 —— 真链路验收里有专门一条断言看到它就判失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockKernel } from '../src/platform/mock-kernel.js'
import { FakeClock } from '../src/core/clock.js'
import type { SessionSummary } from 'dsh-remote-wire'

/** 取一条会话摘要：MockKernel.listSessions 要 limit，且它是异步的。 */
async function summaryOf(kernel: MockKernel, sessionId: string): Promise<SessionSummary | undefined> {
  const rows = await kernel.listSessions!(50)
  return rows.map((row) => row.summary).find((s: SessionSummary) => s.id === sessionId)
}

test('newSession({workspace}) 必须把工作区记进会话摘要（否则"手机指定的分组生效了"无从断言）', async () => {
  const kernel = new MockKernel({ clock: new FakeClock() })
  const made = await kernel.newSession!({ workspace: '/Users/linbin/dsh-remote-control' })
  assert.equal(made.ok, true)
  const id = made.sessionId ?? ''
  assert.ok(id, '夹具自检：新建要返回 id')
  const row = await summaryOf(kernel, id)
  assert.ok(row, '新建出来的会话必须立刻出现在列表里')
  assert.equal(
    row.workspace,
    '/Users/linbin/dsh-remote-control',
    '替身没记 workspace：列表里那一行看不出落点，e2e 断言只能去翻内部状态',
  )
})

test('不带 workspace 时不凭空造一个空串（老主机/老内核那一档）', async () => {
  const kernel = new MockKernel({ clock: new FakeClock() })
  const made = await kernel.newSession!()
  const row = await summaryOf(kernel, made.sessionId ?? '')
  assert.ok(row)
  assert.equal(row.workspace, undefined, '没有就是没有：空串会让下游以为有个空目录')
})

test('会话 id 一律带 ses_mock 前缀：真链路验收靠它判"测试替身混进了生产"', async () => {
  const kernel = new MockKernel({ clock: new FakeClock() })
  const made = await kernel.newSession!({ workspace: '/tmp/x' })
  assert.match(made.sessionId ?? '', /^ses_mock/)
  for (const row of await kernel.listSessions!(50)) {
    assert.match(row.summary.id, /^ses_mock/, `非 mock 前缀的 id 混进来了：${row.summary.id}`)
  }
})
