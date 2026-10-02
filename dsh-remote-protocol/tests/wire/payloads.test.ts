/**
 * 载荷 schema 的边界。这些载荷是"解密之后"的东西，所以拒不收意味着
 * 一个坏载荷会一路走到分发器；收得太紧又会让手机的一个合法命令被丢掉。
 * 两边都有测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PAYLOAD_TYPES,
  SESSION_STATES,
  cmdAnswer,
  cmdKeepAwake,
  cmdNewSession,
  cmdResolvePermission,
  cmdSendPrompt,
  cmdSessionHistory,
  isoOrUndefined,
  parseCmdPayload,
  parseEvPayload,
} from '../../src/wire/payloads.js'

test('八个命令逐个通过；t 拼错的载荷必须被拒（不认识的命令不能当命令执行）', () => {
  assert.ok(parseCmdPayload({ t: 'cmd.send_prompt', cmdId: 'c1', sessionId: 'ses_1', text: '只回复 ok' }))
  assert.ok(parseCmdPayload({ t: 'cmd.list_sessions', cmdId: 'c2' }))
  assert.ok(parseCmdPayload({ t: 'cmd.interrupt', cmdId: 'c3', sessionId: 'ses_1' }))
  assert.ok(
    parseCmdPayload({
      t: 'cmd.resolve_permission',
      cmdId: 'c4',
      sessionId: 'ses_1',
      requestId: 'r1',
      decision: 'approve',
    }),
  )
  assert.ok(
    parseCmdPayload({
      t: 'cmd.answer',
      cmdId: 'c5',
      sessionId: 'ses_1',
      requestId: 'r1',
      answers: [{ questionId: 'q1', selected: ['staging'] }],
    }),
  )
  assert.ok(parseCmdPayload({ t: 'cmd.keep_awake', cmdId: 'c6', enabled: true }))
  assert.ok(parseCmdPayload({ t: 'cmd.session_history', cmdId: 'c7', sessionId: 'ses_1' }))
  assert.ok(parseCmdPayload({ t: 'cmd.new_session', cmdId: 'c8' }))
  assert.equal(parseCmdPayload({ t: 'cmd.send_promt', cmdId: 'c1', sessionId: 's', text: '' }), null)
  assert.equal(parseCmdPayload({ t: 'cmd.subscribe', cmdId: 'c1' }), null, '已删除的 no-op 命令不再被认')
})

test('cmd.new_session：只带 cmdId，命名与 id 都归主机', () => {
  assert.ok(cmdNewSession.safeParse({ t: 'cmd.new_session', cmdId: 'c' }).success)
  // cmdId 是回执对答的钥匙（手机靠它认出"这是我那次新建的结果"），空的会让回执无处可归
  assert.equal(cmdNewSession.safeParse({ t: 'cmd.new_session', cmdId: '' }).success, false)
  assert.equal(cmdNewSession.safeParse({ t: 'cmd.new_session' }).success, false)
  // 手机不自带 sessionId / 标题：id 由内核分配、名字由内核起（第一次发指令后会自己改）。
  // 多余字段会被剥掉而不是悄悄流到内核 —— 剥掉是"我们没打算传"的证据，透传则是隐患。
  const stripped = cmdNewSession.parse({ t: 'cmd.new_session', cmdId: 'c', sessionId: 'ses_x', title: '我编的名字' })
  assert.equal('sessionId' in stripped, false)
  assert.equal('title' in stripped, false)
})

test('session_history：beforeSeq/limit 都可省（省 = 要最新一页），limit 上界 200', () => {
  assert.ok(cmdSessionHistory.safeParse({ t: 'cmd.session_history', cmdId: 'c', sessionId: 's' }).success)
  assert.ok(cmdSessionHistory.safeParse({ t: 'cmd.session_history', cmdId: 'c', sessionId: 's', beforeSeq: 0 }).success)
  assert.ok(cmdSessionHistory.safeParse({ t: 'cmd.session_history', cmdId: 'c', sessionId: 's', limit: 200 }).success)
  // 0 是合法游标（最小 seq），但 0 条不是一个合法的"每页条数"
  assert.equal(
    cmdSessionHistory.safeParse({ t: 'cmd.session_history', cmdId: 'c', sessionId: 's', limit: 0 }).success,
    false,
  )
  assert.equal(
    cmdSessionHistory.safeParse({ t: 'cmd.session_history', cmdId: 'c', sessionId: 's', limit: 201 }).success,
    false,
  )
  assert.equal(
    cmdSessionHistory.safeParse({ t: 'cmd.session_history', cmdId: 'c', sessionId: 's', beforeSeq: -1 }).success,
    false,
  )
  assert.equal(cmdSessionHistory.safeParse({ t: 'cmd.session_history', cmdId: 'c', sessionId: '' }).success, false)
})

test('ev.session_history：条目只允许实时流那两种叶子载荷（不递归、不夹带运行态）', () => {
  const ok = {
    t: 'ev.session_history',
    sessionId: 'ses_1',
    cmdId: 'c1',
    items: [
      { t: 'ev.message_delta', messageId: 'm1', delta: '你好', role: 'user', done: true },
      { t: 'ev.tool_event', callId: 't1', phase: 'completed', tool: 'Bash', resultPreview: 'ok' },
    ],
    nextBeforeSeq: 9,
  }
  assert.notEqual(parseEvPayload(ok), null)

  // 历史里出现第三种载荷（例如运行态）必须被拒：回放历史不该去动顶栏状态
  assert.equal(parseEvPayload({ ...ok, items: [{ t: 'ev.run_state', sessionId: 'ses_1', state: 'running' }] }), null)
  // 递归（历史里套历史）也要被拒
  assert.equal(parseEvPayload({ ...ok, items: [ok] }), null)
})

test('ev.session_history：只有游标、没有 hasMore —— 一个字段就没有"自相矛盾"这种状态', () => {
  const base = { t: 'ev.session_history', sessionId: 'ses_1', cmdId: 'c1', items: [] }
  assert.notEqual(parseEvPayload(base), null, '没有游标 = 这是最初的一页')
  assert.notEqual(parseEvPayload({ ...base, nextBeforeSeq: 7 }), null)
  assert.notEqual(parseEvPayload({ ...base, nextBeforeSeq: 0 }), null, '0 是合法游标（最小 seq）')
  assert.equal(parseEvPayload({ ...base, nextBeforeSeq: -2 }), null)
  assert.equal(parseEvPayload({ ...base, nextBeforeSeq: 1.5 }), null)
  assert.equal(parseEvPayload({ ...base, items: 'x' }), null)
})

test('命令必填项缺一即拒（cmdId 是回执对答的唯一凭据）', () => {
  for (const bad of [
    { t: 'cmd.send_prompt', sessionId: 's', text: 'x' },
    { t: 'cmd.send_prompt', cmdId: 'c', text: 'x' },
    { t: 'cmd.send_prompt', cmdId: 'c', sessionId: '', text: 'x' },
    { t: 'cmd.answer', cmdId: 'c', sessionId: 's', requestId: 'r' },
    { t: 'cmd.answer', cmdId: 'c', sessionId: 's', requestId: 'r', answers: 'q1' },
    { t: 'cmd.answer', cmdId: 'c', sessionId: 's', requestId: 'r', answers: [{ questionId: 'q1' }] },
    { t: 'cmd.keep_awake', cmdId: 'c' },
    { t: 'cmd.resolve_permission', cmdId: 'c', sessionId: 's', requestId: 'r' },
  ]) {
    assert.equal(parseCmdPayload(bad), null, JSON.stringify(bad))
  }
})

test('keep_awake：idleReleaseSec 允许 0（含义是永不自动释放），拒负数与小数', () => {
  assert.ok(cmdKeepAwake.safeParse({ t: 'cmd.keep_awake', cmdId: 'c', enabled: true, idleReleaseSec: 0 }).success)
  assert.ok(cmdKeepAwake.safeParse({ t: 'cmd.keep_awake', cmdId: 'c', enabled: true, idleReleaseSec: 600 }).success)
  assert.equal(
    cmdKeepAwake.safeParse({ t: 'cmd.keep_awake', cmdId: 'c', enabled: true, idleReleaseSec: -1 }).success,
    false,
  )
  assert.equal(
    cmdKeepAwake.safeParse({ t: 'cmd.keep_awake', cmdId: 'c', enabled: true, idleReleaseSec: 1.5 }).success,
    false,
  )
  assert.equal(cmdKeepAwake.safeParse({ t: 'cmd.keep_awake', cmdId: 'c', enabled: 'yes' }).success, false)
})

test('decision 不做枚举收紧：手机回传的是主机下发的 options[].id，逐字', () => {
  const parsed = cmdResolvePermission.safeParse({
    t: 'cmd.resolve_permission',
    cmdId: 'c',
    sessionId: 's',
    requestId: 'r',
    decision: 'approve_session',
  })
  assert.equal(parsed.success, true)
  assert.equal((parsed.data as { decision: string }).decision, 'approve_session')
  const custom = cmdResolvePermission.safeParse({
    t: 'cmd.resolve_permission',
    cmdId: 'c',
    sessionId: 's',
    requestId: 'r',
    decision: 'allow-once',
  })
  assert.equal(custom.success, true, '将来加自定义选项时不该被协议层挡掉')
})

test('answer 的 freeText 可以整个缺席（小程序只在用户填了才带上）', () => {
  assert.ok(
    cmdAnswer.safeParse({
      t: 'cmd.answer',
      cmdId: 'c',
      sessionId: 's',
      requestId: 'r',
      answers: [{ questionId: 'q1', selected: [], freeText: '环境选 staging' }],
    }).success,
  )
  assert.ok(
    cmdAnswer.safeParse({
      t: 'cmd.answer',
      cmdId: 'c',
      sessionId: 's',
      requestId: 'r',
      answers: [{ questionId: 'q1', selected: [] }],
    }).success,
  )
})

test('send_prompt 的 text 允许空串（"只带附件"这类将来态不该被协议层拒）', () => {
  assert.ok(cmdSendPrompt.safeParse({ t: 'cmd.send_prompt', cmdId: 'c', sessionId: 's', text: '' }).success)
})

test('事件：message_delta 必须有 messageId；done 是可选布尔；delta 允许空串', () => {
  assert.ok(parseEvPayload({ t: 'ev.message_delta', messageId: 'm1', delta: 'hi' }))
  assert.ok(parseEvPayload({ t: 'ev.message_delta', messageId: 'm1', delta: '', done: true }))
  assert.equal(parseEvPayload({ t: 'ev.message_delta', delta: 'hi' }), null)
  assert.equal(parseEvPayload({ t: 'ev.message_delta', messageId: 'm1' }), null, 'delta 缺省不行')
  assert.equal(parseEvPayload({ t: 'ev.message_delta', messageId: 'm1', delta: 3 }), null)
})

test('事件：tool_event 的 phase 是封闭枚举，callId 必填', () => {
  assert.ok(parseEvPayload({ t: 'ev.tool_event', callId: 'x', phase: 'started' }))
  assert.ok(parseEvPayload({ t: 'ev.tool_event', callId: 'x', phase: 'completed', resultPreview: 'ok' }))
  for (const phase of ['done', 'error', 'COMPLETE', '']) {
    assert.equal(parseEvPayload({ t: 'ev.tool_event', callId: 'x', phase }), null, phase)
  }
  assert.equal(parseEvPayload({ t: 'ev.tool_event', phase: 'started' }), null)
})

test('事件：run_state 只认 running/idle 两个值（第三种状态会让卡片挂在手机上不消失）', () => {
  assert.ok(parseEvPayload({ t: 'ev.run_state', state: 'running' }))
  assert.ok(parseEvPayload({ t: 'ev.run_state', state: 'idle', detail: 'interrupted' }))
  for (const state of ['waiting', 'aborted', 'error', 'RUNNING', '']) {
    assert.equal(parseEvPayload({ t: 'ev.run_state', state }), null, state)
  }
})

test('事件：session_changed 的 sessions 是必填数组，元素 state 也是封闭枚举', () => {
  assert.ok(parseEvPayload({ t: 'ev.session_changed', sessions: [] }))
  assert.equal(parseEvPayload({ t: 'ev.session_changed' }), null)
  assert.equal(parseEvPayload({ t: 'ev.session_changed', sessions: 'a,b' }), null)
  assert.equal(
    parseEvPayload({ t: 'ev.session_changed', sessions: [{ state: 'idle' }] }),
    null,
    '缺 id 的元素必须整条拒——手机上没有 id 的会话行点了没反应',
  )
  assert.equal(
    parseEvPayload({
      t: 'ev.session_changed',
      sessions: [{ id: 's1', state: 'awaiting_permission' }],
    }),
    null,
    '下划线写法必须被拒（F7 的枚举是连字符）',
  )
  assert.equal(SESSION_STATES.length, 6)
  assert.ok(
    parseEvPayload({
      t: 'ev.session_changed',
      sessions: [{ id: 's1', state: 'archived', title: 'T', workspace: '/w', running: false }],
    }),
  )
})

test('事件：keep_awake_state 的四个必填字段一个都不能少（手机靠它们回显开关）', () => {
  const full = { t: 'ev.keep_awake_state', enabled: true, active: false, platform: 'darwin', backend: 'caffeinate' }
  assert.ok(parseEvPayload(full))
  for (const key of ['enabled', 'active', 'platform', 'backend']) {
    const partial = { ...full } as Record<string, unknown>
    delete partial[key]
    assert.equal(parseEvPayload(partial), null, `少了 ${key} 必须拒`)
  }
  const stripped = parseEvPayload({ ...full, sessionId: 'ses_1' })
  assert.ok(stripped)
  assert.equal('sessionId' in stripped, false, 'sessionId 会被剥掉：这个 payload 按契约不带会话归属（F11）')
})

test('事件：permission/question 的 requestId 与 questions[].id 是回传映射的锚', () => {
  assert.equal(parseEvPayload({ t: 'ev.permission_request', action: '执行 bash' }), null)
  assert.ok(
    parseEvPayload({
      t: 'ev.permission_request',
      requestId: 'r1',
      action: '执行 bash',
      options: [
        { id: 'approve', label: '允许' },
        { id: 'reject', label: '拒绝' },
      ],
    }),
  )
  assert.equal(
    parseEvPayload({
      t: 'ev.permission_request',
      requestId: 'r1',
      action: 'x',
      options: [{ id: 'approve' }],
    }),
    null,
    '选项少了 label 会渲染成空白按钮',
  )
  assert.ok(
    parseEvPayload({
      t: 'ev.question_request',
      requestId: 'q',
      questions: [
        { id: 'q1', question: '部署到哪个环境？', multi: false, options: [{ id: 'staging', label: '预发' }] },
      ],
    }),
  )
  assert.equal(parseEvPayload({ t: 'ev.question_request', requestId: 'q', questions: [{}] }), null)
})

test('事件：result 的 cmdId 允许空串（host 兜底回执拿不到 cmdId 时就是这么发）', () => {
  assert.ok(parseEvPayload({ t: 'ev.result', cmdId: '', ok: false, message: '载荷处理失败' }))
  assert.ok(parseEvPayload({ t: 'ev.result', cmdId: 'c1', ok: true, data: { sessions: [] } }))
  assert.equal(parseEvPayload({ t: 'ev.result', cmdId: 'c1', ok: 'true' }), null)
})

test('未知载荷类型一律拒（新增名字要在协议层登记，不能靠"猜形状"）', () => {
  assert.equal(parseEvPayload({ t: 'ev.whatever', x: 1 }), null)
  assert.equal(parseCmdPayload(null), null)
  assert.equal(parseCmdPayload('cmd.list_sessions'), null)
  assert.equal(parseEvPayload({}), null)
})

test('PAYLOAD_TYPES 与 schema 里的字面量一致（防止常量与实现分叉）', () => {
  const declared = Object.values(PAYLOAD_TYPES)
  for (const t of declared) {
    assert.equal(/^(cmd|ev)\.[a-z_]+$/.test(t), true, t)
  }
  assert.equal(new Set(declared).size, declared.length, '常量表里不许有重复值')
})

test('isoOrUndefined：数字转 ISO、ISO 串原样、垃圾值省略字段（F7 的生产侧兜底）', () => {
  const iso = new Date(1_700_000_000_000).toISOString()
  assert.equal(isoOrUndefined(1_700_000_000_000), iso)
  assert.equal(isoOrUndefined(iso), iso)
  for (const bad of [undefined, null, '', 'not a date', {}, [], Number.NaN, Infinity, true]) {
    assert.equal(isoOrUndefined(bad), undefined, String(bad))
  }
})
