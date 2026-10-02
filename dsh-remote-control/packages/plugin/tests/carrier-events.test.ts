/**
 * carrier-events.test — 内核 `turn/end` 的映射（`platform/carrier-services.ts`）。
 *
 * 这一条不是"顺手补的测试"，而是**真机取证抓出来的缺陷**：
 * 本机 Harness 里跑真插件时，宿主在 prompt 装配阶段抛
 * `prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`，
 * 而插件把 `turn/end` 的 `data.reason` **整个丢掉**，只发 done + idle。结果：
 * 手机上"一个字都没有的失败回合"与"成功的回合"长得一模一样，
 * live-e2e 十五项断言全绿，实际一个字的回复都没有（取证 scripts/read-session-log.mjs 的 turn/end 行）。
 *
 * 所以这里守的是两件事：
 * 1. **失败必须可见**（中文 + 原始原因），且不破坏 F9 的"done 永不丢、先 done 后 idle"；
 * 2. 成功路径**不许被顺带改坏**（不能凭空多出错误文本，也不能把 done 挪位）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { turnEndKernelEvents } from '../src/platform/carrier-services.js'
import type { KernelEvent } from '../src/ports/index.js'

const deltas = (events: KernelEvent[]) =>
  events.filter((event): event is Extract<KernelEvent, { kind: 'delta' }> => event.kind === 'delta')
const runStates = (events: KernelEvent[]) =>
  events.filter((event): event is Extract<KernelEvent, { kind: 'run-state' }> => event.kind === 'run-state')

test('成功回合：只有 done 一条 delta + 一条 idle，不凭空造错误文本', () => {
  const events = turnEndKernelEvents({ sessionId: 'ses_1', seq: 7, data: { reason: { kind: 'completed' } } })
  assert.equal(events.length, 2, `成功回合产出了 ${events.length} 条事件：多出来的每一条都会变成手机上的一行`)
  const [delta] = deltas(events)
  assert.equal(delta?.text, '', '成功回合的收尾 delta 必须是空串')
  assert.equal(delta?.done, true, 'done 不能丢（F9：手机靠它停止转圈）')
  assert.equal(delta?.messageId, 'turn_7', 'seq 要落进 messageId：同一条回合一串事件共用一个消息行')
  const [state] = runStates(events)
  assert.equal(state?.state, 'idle')
  assert.equal(state?.detail, undefined, '成功回合不许带 detail')
  assert.deepEqual(
    events.map((event) => event.kind),
    ['delta', 'run-state'],
    '顺序必须是先 done 再 idle：反过来手机的转圈会一直停在那里',
  )
})

test('失败回合：中文 + 原始内核原因都要出现在手机上（这就是当初看不见的那个东西）', () => {
  const events = turnEndKernelEvents({
    sessionId: 'ses_1',
    seq: 8,
    data: {
      reason: {
        kind: 'error',
        error: { message: 'prompt variable "{{model}}" has no value for this assembly', code: 'UNKNOWN' },
      },
    },
  })
  const written = deltas(events)
  assert.equal(written.length, 2, `失败回合只产出 ${written.length} 条 delta：错误文本没进 delta，手机上就什么都看不见`)
  const [notice, tail] = written
  assert.match(notice?.text ?? '', /这一轮没有产出回复/, '必须是中文打底的句子，不是英文栈')
  assert.match(notice?.text ?? '', /\{\{model\}\}/, '原始原因要照抄：只说"失败了"用户无从下手')
  assert.match(notice?.text ?? '', /has no value/, '原因里的关键短句不能被我自己的加工吃掉')
  assert.match(notice?.text ?? '', /UNKNOWN/, '错误码也带上，便于对照内核 session log')
  assert.equal(notice?.role, 'system', '错误通知是系统口吻，不能伪装成助手回答')
  assert.equal(notice?.done, false, '错误文本自己不是收尾帧')
  assert.equal(tail?.done, true, 'done 仍然必须是最后一条（F9 不因这次改动而松动）')
  assert.equal(tail?.text, '', '收尾 delta 仍是空串')
  assert.deepEqual(
    written.map((event) => event.messageId),
    ['turn_8', 'turn_8'],
    '两条必须同一个 messageId：DeltaWindow 靠它把错误文本与 done 合进同一个消息行',
  )
  const [state] = runStates(events)
  assert.equal(state?.state, 'idle')
  assert.equal(state?.detail, 'turn-error', 'run_state 要带 detail：手机的状态行与排错入口都读它')
})

test('内核 message 又长又带换行时夹住长度并压成一行（一帧不能顶到中继上限，也不能刷爆手机屏幕）', () => {
  const long = `Error: ${'x'.repeat(5_000)}\n  at Object.<anonymous> (/Users/someone/secret-path/index.js:1:1)`
  const events = turnEndKernelEvents({
    sessionId: 'ses_1',
    seq: 1,
    data: { reason: { kind: 'error', error: { message: long } } },
  })
  const [notice] = deltas(events)
  const text = notice?.text ?? ''
  assert.ok(text.length < 400, `错误文本 ${text.length} 字符：没夹长度`)
  assert.equal(text.includes('\n'), false, '换行没压掉：手机上会顶出一段看不清的栈')
  assert.match(text, /这一轮没有产出回复/, '夹长度之后中文主干仍在')
})

test('reason 缺字段时不许出现 undefined 字样：拿不到原因也要说一句人话', () => {
  const inputs: Array<Record<string, unknown>> = [
    { reason: { kind: 'aborted' } }, // 用户中断：本来就没有回复，不该造出错误文本
    { reason: { kind: 'error', error: { code: 'E' } } }, // 有 code 没 message
    { reason: { kind: 'error' } }, // 什么都没有
    {}, // reason 整个缺失
  ]
  for (const data of inputs) {
    const events = turnEndKernelEvents({ sessionId: 'ses_1', seq: 2, data })
    const text = deltas(events)
      .map((event) => event.text)
      .join('')
    assert.equal(text.includes('undefined'), false, `错误文本里出现了 undefined：${text}`)
    assert.ok(
      deltas(events).some((event) => event.done === true),
      `无论 reason 长成什么样，done 都不能丢：${JSON.stringify(data)}`,
    )
  }
})
