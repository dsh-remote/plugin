/**
 * carrier-vocabulary.test — 内核会话事件 → 插件事件的**形状**映射。
 *
 * 这里的每一个 data 都是从本机真机 session log 里逐字抄下来的
 * （`node scripts/read-session-log.mjs <sessionId>`，desktop profile，2026-10-02 取证）。
 *
 * 为什么必须拿真形状写测试：第一版的 `textOf()` 只读 `data.content`，而
 * `assistant/message` 的正文在 `data.message.content` —— 于是助手回复被折成空串，
 * 而手机上"⑧ 流式输出到达 / ⑨ 回合正常收尾（done:true）"两条断言**照样通过**
 * （帧数够、done 在），屏幕上一个字都没有。判据数的是帧而不是内容，就会被这样骗过去。
 * `tool/call` 的参数字段同理：真机叫 `arguments`，不叫 `args`。
 *
 * 未识别的类型（`step/start`、`request/header`、`agent/inbox/spliced`…）一律返回空数组：
 * **不映射、不猜语义**（F1：挪用既有名字的语义才是危险的），但调用方要留痕
 * （`kernel.unmappedEventTypes` 进 status.json）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAPPED_SESSION_EVENTS, sessionEventKernelEvents } from '../src/platform/carrier-services.js'
import type { KernelEvent } from '../src/ports/index.js'

const asDelta = (events: KernelEvent[]) =>
  events.filter((event): event is Extract<KernelEvent, { kind: 'delta' }> => event.kind === 'delta')
const asTool = (events: KernelEvent[]) =>
  events.filter((event): event is Extract<KernelEvent, { kind: 'tool' }> => event.kind === 'tool')

test('assistant/message：正文在 data.message.content，不在顶层', () => {
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'assistant/message',
    seq: 824,
    data: {
      turn: 9,
      step: 2,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'The bash tool is not available in this session…' },
          { type: 'text', text: '当前会话里没有可用的 bash 工具' },
        ],
        id: '60ea9f79-f8f7-4895-942f-ed7535d7e6d8',
      },
    },
  })
  assert.equal(events.length, 1, `一条 assistant/message 翻成 ${events.length} 个事件`)
  const [delta] = asDelta(events)
  assert.equal(delta?.text, '当前会话里没有可用的 bash 工具', '回复文本丢了：手机上就是一个字都没有的空消息')
  assert.equal(delta?.role, 'assistant', 'role 必须是 assistant，不能与用户回声混')
  assert.equal(delta?.messageId, '60ea9f79-f8f7-4895-942f-ed7535d7e6d8', 'messageId 在 message.id 上，顶层没有')
  assert.equal(delta?.done, true, '一条消息一条完整 delta（内核没有 token 级增量）')
  assert.equal(delta?.text.includes('The bash tool'), false, 'reasoning 内容泄漏进正文')
})

test('assistant/message 只有 tool-call 片段时正文为空，但不许凭空造字', () => {
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'assistant/message',
    seq: 819,
    data: {
      turn: 9,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'chatcmpl-tool-1', name: 'bash', arguments: '{"command":"echo x"}' }],
      },
    },
  })
  const [delta] = asDelta(events)
  assert.equal(delta?.text, '', '没有 text 片段时正文就是空串（造字比空更糟）')
  assert.ok(delta?.messageId, '即便如此也要有 messageId，否则手机把这条挂到别的消息行上')
})

test('user/message 的正文在顶层（与 assistant 不同形状，两处都要读）', () => {
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'user/message',
    seq: 799,
    data: {
      content: [{ type: 'text', text: '只回复 ok 两个字，不要调用任何工具' }],
      source: { kind: 'user' },
      role: 'user',
      id: '1957861b',
    },
  })
  const [delta] = asDelta(events)
  assert.equal(delta?.text, '只回复 ok 两个字，不要调用任何工具', '用户回声读不到顶层 content → 手机上发出去的话不显示')
  assert.equal(delta?.role, 'user')
  assert.equal(delta?.messageId, '1957861b')
})

test('tool/call：真机给的是 arguments 不是 args；工具名、参数预览、标题都要落到手机上', () => {
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'tool/call',
    seq: 820,
    data: {
      turn: 9,
      step: 1,
      callId: 'chatcmpl-tool-9bf174521b5e2480',
      name: 'bash',
      arguments: '{"command":"echo drc-approval-probe"}',
    },
  })
  const [tool] = asTool(events)
  assert.equal(events.length, 1)
  assert.equal(tool?.callId, 'chatcmpl-tool-9bf174521b5e2480', 'callId 逐字传：结果行要能对上调用行')
  assert.equal(tool?.tool, 'bash')
  assert.equal(tool?.phase, 'args', 'phase 停在 started 说明没读到 arguments：手机看不到参数')
  assert.match(tool?.argsPreview ?? '', /echo drc-approval-probe/, '参数预览丢了')
  assert.match(tool?.title ?? '', /echo drc-approval-probe/, '标题行是手机上唯一看得见的东西')

  // 只有调用、还没参数的一代形状
  const started = asTool(
    sessionEventKernelEvents({ sessionId: 'ses_1', type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'bash' } }),
  )
  assert.equal(started[0]?.phase, 'started', '没有参数时应停在 started')
})

test('tool/result：callId 藏在 message.toolCallId，正文在 message.content', () => {
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'tool/result',
    seq: 821,
    data: {
      turn: 9,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'chatcmpl-tool-9bf174521b5e2480' },
        toolCallId: 'chatcmpl-tool-9bf174521b5e2480',
        content: [{ type: 'text', text: 'Error: unknown tool "bash"' }],
      },
    },
  })
  const [tool] = asTool(events)
  assert.equal(tool?.callId, 'chatcmpl-tool-9bf174521b5e2480', 'callId 对不上调用行：手机上结果与调用各成一行')
  assert.equal(tool?.phase, 'completed')
  assert.match(tool?.resultPreview ?? '', /unknown tool/, '结果预览丢了：手机只看到工具跑完，不知道跑出了什么')
})

test('未识别的类型返回空数组且不抛（不映射、不猜语义）', () => {
  for (const type of ['step/start', 'step/end', 'request/header', 'agent/inbox/spliced', 'internal/config']) {
    assert.equal(MAPPED_SESSION_EVENTS.has(type), false, `${type} 被登记成已映射，但映射表里没有它`)
    assert.deepEqual(
      sessionEventKernelEvents({ sessionId: 'ses_1', type, seq: 1, data: { anything: true } }),
      [],
      `${type} 被映射成了别的东西`,
    )
  }
})

test('approval/asked 与 approval/decided 只触发列表刷新（卡片本身走 waterfall 参与者路径）', () => {
  for (const type of ['approval/asked', 'approval/decided']) {
    assert.deepEqual(
      sessionEventKernelEvents({ sessionId: 'ses_1', type, seq: 1, data: {} }),
      [{ kind: 'sessions-changed', reason: type }],
      `${type} 的映射不对`,
    )
  }
})

test('session/title 只在 title 是字符串时才产出事件（否则手机上出现 undefined 标题）', () => {
  assert.deepEqual(
    sessionEventKernelEvents({ sessionId: 'ses_1', type: 'session/title', seq: 1, data: { title: '新标题' } }),
    [{ kind: 'title', sessionId: 'ses_1', title: '新标题' }],
  )
  assert.deepEqual(
    sessionEventKernelEvents({ sessionId: 'ses_1', type: 'session/title', seq: 1, data: { title: 42 } }),
    [],
  )
  assert.deepEqual(sessionEventKernelEvents({ sessionId: 'ses_1', type: 'session/title', seq: 1, data: {} }), [])
})

test('turn/start 只报运行态：它是手机上"正在思考…"的唯一来源', () => {
  assert.deepEqual(sessionEventKernelEvents({ sessionId: 'ses_1', type: 'turn/start', seq: 1, data: { turn: 3 } }), [
    { kind: 'run-state', sessionId: 'ses_1', state: 'running' },
  ])
})
