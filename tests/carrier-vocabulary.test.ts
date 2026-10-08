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
const asTodo = (events: KernelEvent[]) =>
  events.filter((event): event is Extract<KernelEvent, { kind: 'todo' }> => event.kind === 'todo')

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

test('todo/write：整份快照原样转发（内核每次都给全量，插件不做增量）', () => {
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'todo/write',
    seq: 830,
    data: {
      todos: [
        { content: '复现问题', status: 'completed' },
        { content: '改完跑全链路', status: 'in_progress' },
        { content: '写判据', status: 'pending' },
      ],
    },
  })
  assert.equal(events.length, 1, '一条 todo/write 翻成一个事件')
  const [todo] = asTodo(events)
  assert.equal(todo?.kind, 'todo')
  assert.deepEqual(
    todo?.todos,
    [
      { content: '复现问题', status: 'completed' },
      { content: '改完跑全链路', status: 'in_progress' },
      { content: '写判据', status: 'pending' },
    ],
    'status 三元一个都不许改：手机上的勾/半满/完成全靠它',
  )
  assert.ok(MAPPED_SESSION_EVENTS.has('todo/write'), '不在映射表里 = 真机上这条事件会被丢进 unmappedEventTypes')
})

test('todo/write：空数组也要发（内核清空清单时手机必须跟着清）', () => {
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'todo/write',
    seq: 831,
    data: { todos: [] },
  })
  const [todo] = asTodo(events)
  assert.deepEqual(todo?.todos, [], '空清单不是"不发"：发了手机才收得回去')
})

test('todo/write：坏形状逐条夹——未知 status 降级、空 content 丢、超长截断', () => {
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'todo/write',
    seq: 832,
    data: {
      todos: [
        { content: '   ', status: 'pending' },
        { content: '状态不认识', status: 'done' },
        { content: 42 },
        { content: 'x'.repeat(400), status: 'pending' },
      ],
    },
  })
  const [todo] = asTodo(events)
  assert.equal(todo?.todos.length, 2, '空 content 与非字符串 content 丢掉，剩两条')
  assert.equal(todo?.todos[0]?.status, 'pending', "'done' 不在三元里 → 降级 pending，不许把未知状态透出去")
  assert.equal(todo?.todos[1]?.content.length, 200, '超长截到 200 字')
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
  for (const type of ['step/start', 'step/end', 'internal/config']) {
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

test('宿主注入的 user/message（source.kind 不是 user）一律不出站', () => {
  // 真机取证：`~/.dsh/sessions/**/session.v4.jsonl.zstd` 里，宿主把上下文快照、
  // 技能目录、模型切换通知、后台作业完成…全都写成 `user/message`，只靠 `source.kind` 区分。
  // 下面三条是逐字抄的（2026-10-02），它们在第一版里全都顶着「你的指令」那颗蓝气泡
  // 出现在手机上 —— 用户没发过那句话，这是假事实，比不显示坏得多。
  const injected: Array<[string, Record<string, unknown>]> = [
    [
      'time-context',
      {
        content: [
          {
            type: 'text',
            text: 'Time sampled while preparing turn 3, step 1: 2026-10-02T23:04:02+08:00[Asia/Shanghai]\nBrowser time zone for this request: unavailable.',
          },
        ],
        source: { kind: 'time-context', form: 'snapshot' },
        id: 'm-time',
      },
    ],
    [
      'skill-catalog',
      {
        content: [
          { type: 'text', text: '<system-reminder>\nA skill is a reusable set of task-specific instructions…' },
        ],
        source: { kind: 'skill-catalog', form: 'catalog' },
        id: 'm-skill',
      },
    ],
    [
      'model-selection',
      {
        content: [
          {
            type: 'text',
            text: '[model changed: assistant turns above this point were generated by deepseek-v4.1-flash]',
          },
        ],
        source: { kind: 'model-selection', form: 'notice' },
        id: 'm-model',
      },
    ],
  ]
  for (const [kind, data] of injected) {
    const events = sessionEventKernelEvents({ sessionId: 'session-af3f', type: 'user/message', seq: 900, data })
    assert.deepEqual(events, [], `source.kind=${kind} 是宿主注入，不许当成用户消息出站（真机上它会显示成用户发的指令）`)
  }
})

test('user/message 缺 source：按真人处理（宁可多显示一条，也不让用户的话凭空消失）', () => {
  // 判据收紧成 `source.kind === 'user'` 之后，缺 source 的旧形状就被算成注入了。
  // 那个代价是"用户发的话消失"——比多显示一条注入严重得多，所以这一支必须显式锁住。
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'user/message',
    seq: 901,
    data: { content: [{ type: 'text', text: '旧一代的形状，没有 source' }], id: 'm-legacy' },
  })
  const [delta] = asDelta(events)
  assert.equal(delta?.role, 'user', '缺 source 的 user/message 仍要当真人消息，否则用户发的话在手机上凭空消失')
  assert.equal(delta?.text, '旧一代的形状，没有 source')
})

// 2026-10-04 用户截图报的三件事：聊天框里的 XML / title 是 JSON / 结果是乱码
// data 形状都从本机 session log（~/.dsh/sessions/**/session.v4.jsonl.zstd）逐字抄来。

test('assistant/message：正文里的 XML 是传输副本，剥掉后只留正文', () => {
  const xml = [
    '<tool_call>',
    '<function=run_code>',
    '<parameter=command=true, description=false/>',
    '<parameter=code>',
    'const y = 2',
    '</parameter>',
    '<parameter=description>试一下</parameter>',
    '</function>',
    '</tool_call>',
  ].join('\n')
  const prose = '三个问题都收到，先定位代码路径：'
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'assistant/message',
    seq: 429,
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '……' },
          {
            type: 'tool-call',
            id: 'chatcmpl-tool-1',
            name: 'run_code',
            arguments: '{"code":"const x = 1","description":"试一下"}',
          },
          { type: 'text', text: prose + xml },
        ],
      },
    },
  })
  const [delta] = asDelta(events)
  assert.equal(delta?.text, prose, 'XML 没剥干净：手机上聊天框挂着一段 tool_call 原文')
  assert.equal(delta?.text?.includes('<'), false, 'XML 的尖括号漏过来了')
})
test('assistant/message：整条只有一个工具调用时剥成空正文，但 messageId 还在', () => {
  const xml = [
    '<tool_call>',
    '<function=run_code>',
    '<parameter=code>',
    'const y = 2',
    '</parameter>',
    '</function>',
    '</tool_call>',
  ].join('\n')
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'assistant/message',
    seq: 206,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: xml }] } },
  })
  const [delta] = asDelta(events)
  assert.equal(delta?.text, '', '纯工具调用剥完必须是空串：留一个换行 mp 也会建出一条空白块')
  assert.ok(delta?.messageId, '空正文也要带 messageId，否则下一条带字的消息被挂到这一行上')
})
test('assistant/message：正文里提到的标签不是块，一个字都不许删', () => {
  const OPEN = '<tool_call>'
  const prose =
    '插件侧根因已清楚（不过滤 tool_call XML）。桌面上出现原始 ' + OPEN + ' 标签也不该被当成块：其后这三个都要改。'
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'assistant/message',
    seq: 499,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: prose }] } },
  })
  const [delta] = asDelta(events)
  assert.equal(delta?.text, prose, '把正文里的提到当成块开头，从那儿往后的真正文被删光了')
})
test('assistant/message：尾部未闭合的块（流被掐断）也要剥，但不许吃掉正文', () => {
  const cut = ['结论先说：修插件。', '<tool_call>', '<function=run_code>', '<parameter=code>', 'const z = 3'].join('\n')
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'assistant/message',
    seq: 998,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: cut }] } },
  })
  const [delta] = asDelta(events)
  assert.equal(delta?.text, '结论先说：修插件。\n', '未闭合块没剥掉，或者把块前的正文一起吞了')
})
test('tool/call：title 取 arguments 里的 description，不贴 455 字符 JSON', () => {
  const args = JSON.stringify({
    code: 'const res = await tools.bash({})\nreturn res',
    description: '检查部署产物新鲜度与未发布提交',
  })
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'tool/call',
    seq: 820,
    data: { callId: 'chatcmpl-tool-1', name: 'run_code', arguments: args },
  })
  const [tool] = asTool(events)
  assert.equal(
    tool?.title,
    '检查部署产物新鲜度与未发布提交',
    'title 还是整串 JSON：步骤卡片上每个 run_code 都挂着一段看不懂的参数',
  )
  assert.match(tool?.argsPreview ?? '', /检查部署产物新鲜度与未发布提交/, '参数预览丢了')
  assert.equal(tool?.argsPreview?.includes('\n'), true, '参数预览是真 JSON：美化后应当有真换行')
})
test('tool/result：正文是 part 数组时取文本，不许 stringify 成字面量乱码', () => {
  const events = sessionEventKernelEvents({
    sessionId: 'session-af3f',
    type: 'tool/result',
    seq: 821,
    data: {
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'chatcmpl-tool-1' },
        toolCallId: 'chatcmpl-tool-1',
        content: [{ type: 'text', text: '{\n  "kind": "foreground",\n  "stdout": { "text": "wire 1.2.0" }\n}' }],
      },
    },
  })
  const [tool] = asTool(events)
  assert.match(tool?.resultPreview ?? '', /wire 1\.2\.0/, '结果预览丢了')
  assert.equal(
    tool?.resultPreview?.includes('\\n'),
    false,
    '还有字面量反斜杠n：手机上就是一片乱码（JSON.stringify 的痕迹）',
  )
  assert.equal(tool?.resultPreview?.includes('\\"'), false, '还有字面量反斜杠引号：同上')
  assert.equal(tool?.resultPreview?.includes('[{"type"'), false, '把 part 数组的壳也贴给了用户')
})

/**
 * agent/inbox/spliced：**主机侧排队消息的唯一入口**（2026-10-05 取证后补）。
 *
 * 真实负载（真机 session log 逐条统计，338 条）：
 *   target     'next-turn' 163 / 'next-step' 175
 *   inserted   180 条有内容 / 158 条空数组
 *   source.kind user 92 / ptc-mode 51 / repeat-tool-reminder 29 /
 *               user-approval 4 / tool-jobs 4
 *
 * 三道过滤的判据都在下面：**少一道，手机上就会多出一条用户没排过的假消息**。
 */
const inboxSplice = (data: Record<string, unknown>) => ({
  sessionId: 'ses_1',
  type: 'agent/inbox/spliced',
  seq: 7,
  data,
})

test('inbox：next-turn + source.kind=user 才出站，正文与内核 id 原样带出', () => {
  const [ev] = sessionEventKernelEvents(
    inboxSplice({
      target: 'next-turn',
      start: 0,
      inserted: [
        {
          content: [{ type: 'text', text: '读handoff获取足够上下文' }],
          source: { kind: 'user', rpcId: 'rpc_1' },
          role: 'user',
          id: 'msg_abc',
        },
      ],
    }),
  )
  assert.deepEqual(ev, {
    kind: 'inbox',
    sessionId: 'ses_1',
    target: 'next-turn',
    messageId: 'msg_abc',
    text: '读handoff获取足够上下文',
  })
})

test('inbox：next-step 是插话不是排队，不出站', () => {
  assert.deepEqual(
    sessionEventKernelEvents(
      inboxSplice({
        target: 'next-step',
        inserted: [{ content: [{ type: 'text', text: '顺便查下这个' }], source: { kind: 'user' }, id: 'm2' }],
      }),
    ),
    [],
  )
})

test('inbox：inserted 为空数组不算消息（真机 158/338 条是这样）', () => {
  assert.deepEqual(sessionEventKernelEvents(inboxSplice({ target: 'next-turn', inserted: [] })), [])
  assert.deepEqual(sessionEventKernelEvents(inboxSplice({ target: 'next-turn' })), [])
})

test('inbox：非 user 来源一律不出站（图片回传/后台任务/内核提醒/策略变更）', () => {
  for (const kind of ['ptc-mode', 'tool-jobs', 'repeat-tool-reminder', 'user-approval']) {
    assert.deepEqual(
      sessionEventKernelEvents(
        inboxSplice({
          target: 'next-turn',
          inserted: [{ content: [{ type: 'text', text: '机器塞的话' }], source: { kind }, id: 'm_' + kind }],
        }),
      ),
      [],
      kind + ' 不是人写的，不该显示成用户排的消息',
    )
  }
})

test('inbox：没有 id 时用 seq 兜底，保证 messageId 永不为空', () => {
  const [ev] = sessionEventKernelEvents(
    inboxSplice({
      target: 'next-turn',
      inserted: [{ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
    }),
  )
  assert.equal(ev?.kind, 'inbox', '应该映射成 inbox')
  assert.equal(ev?.kind === 'inbox' ? ev.messageId : null, 'i7', '没有 id 时用 seq 兜底')
})

// 这条断言 2026-10-06 被**反转**过一次（撤出映射表让证据说真话），
// 2026-10-06 下午随接线（control 2.0.13，runtime `case 'inbox'`）再反转回来。
// 出站面由 runtime.test.ts 的穷举自检盯着（样本已配好，漏了 case 就红）。
test('inbox：已接线就必须留在 MAPPED_SESSION_EVENTS（撤出是临时的）', () => {
  assert.equal(MAPPED_SESSION_EVENTS.has('agent/inbox/spliced'), true)
})

test('request/header 映射成按会话的 model（2026-10-05 用户实测：会话模型串台）', () => {
  const [ev] = sessionEventKernelEvents({
    sessionId: 'ses_1',
    type: 'request/header',
    seq: 20,
    data: { header: { config: { provider: 'space-bunny', model: 'space-bunny-free', maxTokens: 32000 } } },
  })
  assert.deepEqual(ev, { kind: 'model', sessionId: 'ses_1', model: 'space-bunny-free', provider: 'space-bunny' })
})

test('request/header：没有 config.model 时不出站（宁可这轮不更新，也不显示错的）', () => {
  assert.deepEqual(
    sessionEventKernelEvents({ sessionId: 'ses_1', type: 'request/header', seq: 1, data: { header: {} } }),
    [],
  )
  assert.deepEqual(sessionEventKernelEvents({ sessionId: 'ses_1', type: 'request/header', seq: 1, data: {} }), [])
})

test('request/header 登记进 MAPPED_SESSION_EVENTS', () => {
  assert.equal(MAPPED_SESSION_EVENTS.has('request/header'), true)
})
