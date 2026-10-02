/**
 * carrier-services.test — `platform/carrier-services.ts` 的内核调用形状。
 *
 * `core/` 那几层测的是"该发什么"，这一层测的是**调内核时到底传了什么参数**。
 * 这里每一条都对应一次真机取证或一条已归档的权威签名
 * （`docs/legacy-spec/host-plugin-cordis.md` §3 表）：
 *
 * 1. `agents.resume({resumeSessionId, agentOptions})`——**agentOptions 不能省**。
 *    省掉它建出来的 Agent 没有 call configuration，回合在 prompt 装配阶段就死：
 *    `prompt variable "{{model}}" has no value for this assembly`，
 *    手机上表现为"发出去、转两下、一个字都没有"。这是 live-e2e 在本机抓到的第一条真缺陷。
 * 2. 取消的正解是 `agent.cancel({kind:'user'}, {keepInbox:true})`，
 *    **不是** `abort()`/`interrupt()`（那两个符号在全树零命中；复核 R8⑨）。
 * 3. 没有可用模型时必须**在任何内核调用之前**主动拒绝，而不是让宿主去崩
 *    （`prepareRequest` 里抛 `reading 'provider'`，那条崩溃看起来与远程控制毫无关系）。
 *
 * 夹具是一个手搓的 `ServicesBundle`：本层的全部价值就在于"传了什么"能被逐字记下来，
 * 所以这里用记录调用的假服务对象，而不是真内核。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServicesKernel, historyPageFromLog, type ServicesBundle } from '../src/platform/carrier-services.js'
import { FakeClock } from '../src/core/clock.js'

interface Calls {
  resume: Array<Record<string, unknown>>
  unarchive: string[]
  followup: unknown[]
  steer: unknown[]
  cancel: unknown[][]
}

interface Fixture {
  calls: Calls
  /** 活的 agent 是**同一个对象**：测试要能在它身上删成员（每次 get 返回新对象的话删了也没用）。 */
  readonly liveAgent: Record<string, unknown>
  bundle(overrides?: { live?: boolean; model?: { provider: string; model: string } | undefined }): ServicesBundle
  kernel(services: ServicesBundle): ReturnType<typeof createServicesKernel>
}

function fixture(): Fixture {
  const calls: Calls = { resume: [], unarchive: [], followup: [], steer: [], cancel: [] }
  const clock = new FakeClock()
  const liveAgent: Record<string, unknown> = {
    followup: (message: unknown) => calls.followup.push(message),
    steer: (message: unknown) => calls.steer.push(message),
    cancel: (...args: unknown[]) => calls.cancel.push(args),
  }
  const bundle = (
    overrides: { live?: boolean; model?: { provider: string; model: string } | undefined } = {},
  ): ServicesBundle => {
    const live = overrides.live ?? false
    const model = 'model' in overrides ? overrides.model : { provider: 'stepfun', model: 'step-5-preview' }
    return {
      sessions: { list: () => [], get: () => undefined },
      agents: {
        get: () => (live ? liveAgent : undefined),
        resume: (request: Record<string, unknown>) => {
          calls.resume.push(request)
          return Promise.resolve({ agent: liveAgent })
        },
      },
      agentDefaultModel: model ? { currentSelection: () => model } : {},
      workspaceRegistry: {
        archivedSessionIds: ['ses_arch'],
        unarchiveSession: (id: string) => {
          calls.unarchive.push(id)
          return Promise.resolve()
        },
      },
    }
  }
  return {
    calls,
    liveAgent,
    bundle,
    kernel: (services) => createServicesKernel(services, { clock, log: () => {} }),
  }
}

test('冷会话续跑必须带 agentOptions：不带模型续出来的 Agent 会让整回合在装配阶段死掉', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle())
  const ready = await kernel.ensureRunnable?.('ses_idle')
  assert.equal(ready?.ok, true, `续跑被拒：${JSON.stringify(ready)}`)
  assert.equal(f.calls.resume.length, 1, '没有调用 agents.resume：会话根本没被唤醒')
  const request = f.calls.resume[0] as {
    resumeSessionId?: string
    agentOptions?: { provider?: string; model?: string }
  }
  assert.equal(request.resumeSessionId, 'ses_idle', 'resumeSessionId 逐字传')
  assert.equal(
    request.agentOptions?.provider,
    'stepfun',
    'agentOptions.provider 缺失：这就是手机上"一个字都没有"的根因',
  )
  assert.equal(request.agentOptions?.model, 'step-5-preview', 'agentOptions.model 缺失：同上')
})

test('已经有活的 agent 就不许再 resume（每条指令都重建一次 agent 会丢掉会话内状态）', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true }))
  const ready = await kernel.ensureRunnable?.('ses_live')
  assert.equal(ready?.ok, true)
  assert.equal(f.calls.resume.length, 0, `白 resume 了 ${f.calls.resume.length} 次`)
})

test('拿不到模型选择时必须拒绝续跑，并且一次内核调用都不发', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ model: undefined }))
  const ready = await kernel.ensureRunnable?.('ses_idle')
  assert.equal(ready?.ok, false, '没模型也照样 resume：宿主会在 prepareRequest 里抛 reading provider')
  assert.match(ready?.message ?? '', /模型/, '拒绝原因必须是中文且点名模型，否则手机上只有一句看不懂的英文')
  assert.equal(f.calls.resume.length, 0, '拒绝之前已经把 agent 建出来了：这条拒绝就成了空话')
  const sent = await kernel.sendPrompt('ses_live', '跑一下')
  assert.equal(sent.ok, false, '没模型也发指令：turn 会以 error 收场，而手机看不出来')
  assert.equal(f.calls.followup.length, 0)
})

test('归档会话：先 unarchive 再 resume，顺序不能反', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle())
  await kernel.ensureRunnable?.('ses_arch')
  assert.deepEqual(
    f.calls.unarchive,
    ['ses_arch'],
    '没先解归档：宿主的 archived-session-gate 会在 agent/pre-step 直接拒掉',
  )
  assert.equal(f.calls.resume.length, 1)
  assert.ok(f.calls.unarchive.length > 0, 'unarchive 必须在 resume 之前发生')
})

test('发指令优先 followup；没有 followup 才退到 steer（两者都没有要把 keys 报出来）', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true }))
  const sent = await kernel.sendPrompt('ses_live', '只回复 ok')
  assert.equal(sent.ok, true)
  assert.equal(f.calls.followup.length, 1, '有 followup 却走了别的路：followup 才是"排到下一轮"的正解')
  assert.equal(f.calls.steer.length, 0, 'followup 存在时不该用 steer（steer 是插进当前步）')
  const message = f.calls.followup[0] as { content?: Array<{ type: string; text?: string }> }
  const text = (message?.content ?? []).map((part) => part.text ?? '').join('')
  assert.equal(text, '只回复 ok', '正文必须逐字进 content：官方 apiproxy 就是 createUserMessage({content,source})')

  // 只给 steer 的一代宿主
  const steerOnly = fixture()
  delete steerOnly.liveAgent.followup
  const sent2 = await steerOnly.kernel(steerOnly.bundle({ live: true })).sendPrompt('ses_live', '换个路径')
  assert.equal(sent2.ok, true)
  assert.equal(steerOnly.calls.steer.length, 1, '没 followup 时应退回 steer')

  // 两个都没有：必须把实际形状报出来，而不是静默失败
  const neither = fixture()
  delete neither.liveAgent.followup
  delete neither.liveAgent.steer
  const sent3 = await neither.kernel(neither.bundle({ live: true })).sendPrompt('ses_live', '发不出去')
  assert.equal(sent3.ok, false)
  assert.match(sent3.message ?? '', /keys=\[/, '两个方法都没有时要列出 keys，现场才能判断这一代宿主给了什么')
})

test('中断走 cancel({kind:"user"}, {keepInbox:true})：abort/interrupt 这两个符号在平台上不存在（复核 R8⑨）', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true }))
  const done = await kernel.interrupt('ses_live')
  assert.equal(done.ok, true)
  assert.equal(f.calls.cancel.length, 1, '没走 cancel：手机点了"停止"而内核什么都没发生')
  assert.deepEqual(
    f.calls.cancel[0],
    [{ kind: 'user' }, { keepInbox: true }],
    'cancel 的参数形状必须逐字对：keepInbox 丢了会把已排队的指令一起吞掉',
  )
})

test('modelSelection 与发指令读的是同一条路径（两处各写一遍迟早分叉）', () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle())
  assert.deepEqual(kernel.modelSelection?.(), { provider: 'stepfun', model: 'step-5-preview' })
  const missing = fixture()
  const kernel2 = missing.kernel(missing.bundle({ model: undefined }))
  assert.equal(
    kernel2.modelSelection?.(),
    undefined,
    '没有 currentSelection 时必须返回 undefined，而不是抛或给半个对象',
  )
})

/**
 * 这条测的是"插件绝不带崩宿主"那一条红线在现场的形状。
 *
 * `guardedSubscribe` 只保护**注册**那一步；回调本体是裸交给 cordis 的 emit 的。
 * 一次抛出（下游 runtime/transport 里任何一环都可能）会打断这条事件的派发，
 * 严重时整条订阅被拆掉——真机表现是"回合跑到一半再也没事件"，而 status.json 一片祥和。
 * 所以：不许把异常抛回去，并且必须留下可查的痕迹。
 */
test('事件回调里的异常不许冒回内核，且必须进 status.json 的 kernel.listenerErrors', () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  kernel.subscribe(() => {
    throw new Error('下游炸了')
  })
  const sessionEvent = listeners['session/event']
  assert.ok(sessionEvent, 'session/event 没订阅上：白名单或注册口出问题')
  assert.doesNotThrow(
    () => sessionEvent({ id: 'ses_live' }, { type: 'turn/start', data: { turn: 3 } }),
    '我们的监听器把异常抛回了 cordis 的 emit：这一代 cordis 会因此拆掉整条订阅',
  )
  const described = kernel.describe() as Record<string, unknown>
  assert.match(String(described.listenerErrors), /下游炸了/, '抛错没进 status.json：线上只能靠猜')
  assert.match(String(described.listenerErrors), /^\d+×/, '要带次数：同一处抛一万次与抛一次是完全不同的问题')
})

test('人工交互两面的登记结果必须能从 status.json 读出来（审批卡没弹时的分诊入口）', () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  assert.equal(
    (kernel.describe() as Record<string, unknown>).approvalFace,
    'not-attached',
    '还没挂 sink 就说"已登记"：这条字段就成了谎',
  )
  const detach = kernel.attachInteractionSink!({ approval: async () => 'allowed-once', question: async () => null })
  const described = kernel.describe() as Record<string, unknown>
  // 审批是 **waterfall 参与者**，登记动作就是 `on('approval/request', …)`。
  assert.ok(listeners['approval/request'], '没有真正登记 approval/request 参与者')
  assert.equal(described.approvalFace, 'registered', `审批面登记状态读不出真值：${String(described.approvalFace)}`)
  // 提问默认不接管（`ctx.userQuestions` 是单提供者，接管会剥夺桌面 UI 的提问能力）。
  assert.equal(described.questionsFace, 'not-taken-over', '默认就该是 not-taken-over，否则桌面端问不了问题')
  detach()
})

test('takeOverQuestions=true 时才注册提问提供者；没有那个服务要说得出来', () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    void name
    void listener
    return () => {}
  }
  let registered = 0
  services.userQuestions = {
    registerProvider: () => {
      registered += 1
      return () => {}
    },
  }
  const clock = new FakeClock()
  const kernel = createServicesKernel(services, { clock, takeOverQuestions: true, log: () => {} })
  kernel.attachInteractionSink!({ approval: async () => 'allowed-once', question: async () => null })
  assert.equal(registered, 1, '开了接管却没注册提供者：手机端永远收不到提问，桌面端也问不了')
  assert.equal((kernel.describe() as Record<string, unknown>).questionsFace, 'registered')

  const noService = fixture()
  const bare = noService.bundle({ live: true })
  bare.on = () => () => {}
  delete bare.userQuestions
  const kernel2 = createServicesKernel(bare, { clock, takeOverQuestions: true, log: () => {} })
  kernel2.attachInteractionSink!({ approval: async () => 'allowed-once', question: async () => null })
  const face = String((kernel2.describe() as Record<string, unknown>).questionsFace)
  assert.match(face, /no registerProvider/, '接管失败要说清是缺服务还是这一代换了 API 名字')
  assert.match(face, /keys=/, '必须把服务实际暴露的成员报出来：真机上就是靠这个判断"这一代宿主没有注册口"')
})

test('未知事件类型不映射但要在 kernel.unmappedEventTypes 里看得见', () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  const seen: string[] = []
  kernel.subscribe((event) => seen.push(event.kind))
  const unknownEvent = listeners['session/event']
  assert.ok(unknownEvent, 'session/event 没订阅上')
  unknownEvent({ id: 'ses_live' }, { type: 'brand/new-event', seq: 1, data: { x: 1 } })
  assert.deepEqual(seen, [], '未知类型被映射成了某个事件：F1 禁止挪用语义')
  assert.equal(
    String((kernel.describe() as Record<string, unknown>).unmappedEventTypes),
    'brand/new-event',
    '没留痕：下一次"手机上缺东西"又要从头猜',
  )
  assert.match(
    String((kernel.describe() as Record<string, unknown>).eventTypes),
    /brand\/new-event/,
    '收到过什么类型也要记：分不清"内核没发"与"我们没认"',
  )
})

// ── 历史：内核日志 → 一页条目 ────────────────────────────────────────
//
// 夹具用的是**真机日志的形状**（取证：`~/.dsh/sessions/**/session.v4.jsonl.zstd`，逐字抄），
// 不是"照着类型定义编一个"。这一层最容易犯的错就是拿想象中的形状去测自己写的解析。

/** 一轮：用户说一句、模型想一下（reasoning + tool-call）、调工具、拿到结果、给出结论。 */
function realLog(sessionId: string): Array<{ type: string; seq: number; data: Record<string, unknown> }> {
  return [
    { type: 'turn/start', seq: 5, data: { turn: 1 } },
    { type: 'step/start', seq: 7, data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      seq: 9,
      data: {
        content: [{ type: 'text', text: '看看这个项目的完成度' }],
        source: { kind: 'user' },
        role: 'user',
        id: 'u-9',
      },
    },
    {
      type: 'assistant/message',
      seq: 11,
      // 正文在 data.message.content；这一条只有 reasoning + tool-call —— 正文是空的
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先看看目录里有什么。' },
            { type: 'tool-call', id: 'call_a', name: 'run_code', arguments: '{"code":"ls"}' },
          ],
        },
      },
    },
    {
      type: 'tool/call',
      seq: 12,
      data: { turn: 1, step: 1, callId: 'call_a', name: 'Bash', arguments: '{"command":"ls -la"}' },
    },
    {
      type: 'tool/result',
      seq: 13,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call_a' },
          toolCallId: 'call_a',
          content: [{ type: 'text', text: 'total 88\ndrwxr-xr-x  20 dev' }],
        },
      },
    },
    {
      type: 'assistant/message',
      seq: 14,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '看完了。' },
            { type: 'text', text: '项目结构清楚，完成度不错。' },
          ],
        },
      },
    },
    { type: 'turn/end', seq: 15, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

test('历史：与实时流同构的日志被翻译成同一种条目，空正文与运行态都不落进页面', () => {
  const page = historyPageFromLog({ sessionId: 'ses_1', events: realLog('ses_1'), limit: 100 })
  const shape = page.events.map((e) => {
    if (e.kind === 'delta') return `delta:${e.role}:${e.text}`
    if (e.kind === 'tool') return `tool:${e.phase}:${e.callId}`
    return `other:${e.kind}`
  })
  assert.deepEqual(shape, [
    'delta:user:看看这个项目的完成度',
    // 只有 reasoning + tool-call 的那条 assistant/message **不该**产生正文块：
    // 不过滤的话历史里会插进一堆空白正文
    'tool:args:call_a',
    'tool:completed:call_a',
    'delta:assistant:项目结构清楚，完成度不错。',
  ])
  assert.equal(page.nextBeforeSeq, undefined, '整份日志一次给完，不该再给游标')
})

test('历史：思维链正文（M28）一个字节都不出站 —— 历史这条路径也必须守', () => {
  const page = historyPageFromLog({ sessionId: 'ses_1', events: realLog('ses_1'), limit: 100 })
  const dumped = JSON.stringify(page)
  assert.equal(dumped.includes('先看看目录里有什么'), false, 'reasoning 泄漏到出站结构里了')
  assert.equal(dumped.includes('看完了'), false, 'reasoning 泄漏到出站结构里了')
  assert.equal(dumped.includes('reasoning'), false)
})

test('历史：一条原始事件可能折成 0/1/2 条 —— 分页必须切在事件边界上，不能切在条目中间', () => {
  const log = realLog('ses_1')
  const all = historyPageFromLog({ sessionId: 'ses_1', events: log, limit: 100 })
  // 从最后往前一页页翻，拼起来必须与一次全给**逐字相同**
  const collected: unknown[] = []
  let cursor: number | undefined
  for (let guard = 0; guard < 20; guard++) {
    const page = historyPageFromLog({
      sessionId: 'ses_1',
      events: log,
      limit: 2,
      ...(cursor === undefined ? {} : { beforeSeq: cursor }),
    })
    collected.unshift(...page.events)
    if (page.nextBeforeSeq === undefined) break
    cursor = page.nextBeforeSeq
  }
  assert.deepEqual(collected, all.events, '翻页拼起来与一次全给不一致：中间丢或重了')
})

test('历史：翻不动的时候不许给游标（否则手机上会长出一个点了没反应的「加载更早」）', () => {
  const log = realLog('ses_1')
  const one = historyPageFromLog({ sessionId: 'ses_1', events: log, limit: 2 })
  assert.equal(typeof one.nextBeforeSeq, 'number', '还有更早的内容就必须给游标')
  const rest = historyPageFromLog({ sessionId: 'ses_1', events: log, limit: 100, beforeSeq: one.nextBeforeSeq ?? 0 })
  assert.equal(rest.nextBeforeSeq, undefined, '已经到最早了还在给游标')
  assert.ok(rest.events.length > 0)
  // 游标是**排他**上界：拿同一个游标再要一次，结果必须完全一致（幂等）
  const again = historyPageFromLog({ sessionId: 'ses_1', events: log, limit: 100, beforeSeq: one.nextBeforeSeq ?? 0 })
  assert.deepEqual(again, rest)
})

test('历史：预算再小也要给出一整组，不能产出空页（空页 + 游标 = 翻页死循环）', () => {
  const page = historyPageFromLog({ sessionId: 'ses_1', events: realLog('ses_1'), limit: 1 })
  assert.ok(page.events.length >= 1, '给了空页但游标还在动，手机端的「加载更早」会一直转')
})

test('历史：没有下文的工具调用要落成"已结束 + 说明"，不能让它一直显示"正在执行"', () => {
  const log = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '跑一下' }], role: 'user', id: 'u-1' } },
    {
      type: 'tool/call',
      seq: 2,
      data: { turn: 1, step: 1, callId: 'call_x', name: 'Bash', arguments: '{"command":"sleep 999"}' },
    },
    // 这一轮被中断：没有 tool/result，只有一条 error 收尾
    {
      type: 'turn/end',
      seq: 3,
      data: { turn: 1, reason: { kind: 'error', error: { message: 'user interrupted', code: 'ABORT' } } },
    },
  ]
  const page = historyPageFromLog({ sessionId: 'ses_1', events: log, limit: 100 })
  const tool = page.events.find((e) => e.kind === 'tool')
  assert.ok(tool && tool.kind === 'tool')
  assert.equal(tool.phase, 'completed', '停在 args/started 会让步骤组一直显示「正在执行 1 个步骤」')
  assert.match(tool.resultPreview ?? '', /中断/, '要说明为什么没有结果，不能只留一个空结果')
  // 收尾的错误文案要留下：否则手机上"这一轮什么都没发生"与"成功回合"长得一样
  const texts = page.events.filter((e) => e.kind === 'delta').map((e) => (e.kind === 'delta' ? e.text : ''))
  assert.ok(
    texts.some((t) => t.includes('user interrupted')),
    `错误原因被丢了：${JSON.stringify(texts)}`,
  )
})

test('历史：未知事件类型既不映射也不炸（内核一直在加新事件）', () => {
  const page = historyPageFromLog({
    sessionId: 'ses_1',
    events: [
      { type: 'brand/new-event', seq: 1, data: { x: 1 } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '在' }], role: 'user', id: 'u-2' } },
    ],
    limit: 100,
  })
  assert.equal(page.events.length, 1)
  assert.equal(page.events[0]!.kind, 'delta')
})

test('历史：空日志给空页、且不给游标（"这个会话没有内容"与"读不出来"必须分得清）', () => {
  const page = historyPageFromLog({ sessionId: 'ses_1', events: [], limit: 100 })
  assert.deepEqual(page.events, [])
  assert.equal(page.nextBeforeSeq, undefined)
})

test('读历史走 sessionQuery.readSession，把它给的整份事件交给分页', async () => {
  const f = fixture()
  const asked: unknown[] = []
  const services = f.bundle({ live: true })
  services.sessionQuery = {
    readSession: (id: string) => {
      asked.push(id)
      return Promise.resolve({ session: { id }, events: realLog(id) })
    },
  }
  const kernel = f.kernel(services)
  const page = await kernel.readHistory!('ses_1', { limit: 100 })
  assert.deepEqual(asked, ['ses_1'], '读历史必须点名那条会话')
  assert.equal(page.events.length, 4)
  assert.match(String((kernel.describe() as Record<string, unknown>).historyFace), /readSession/)
})

test('宿主没有 sessionQuery.readSession 时必须**抛**，不许回一张空页', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true })) // bundle 里根本没有 sessionQuery
  await assert.rejects(
    () => kernel.readHistory!('ses_1', { limit: 10 }),
    /不能读会话历史/,
    '回空页在手机上是"这个会话没内容"——一个会让人查错方向的假事实',
  )
  assert.match(String((kernel.describe() as Record<string, unknown>).historyFace), /absent/)
})

// ── 新建会话 ────────────────────────────────────────────────────────

test('新建会话走 sessionController.commands.create({})：一个字段都不许自己塞', async () => {
  const f = fixture()
  const asked: unknown[] = []
  const services = f.bundle({ live: true })
  services.sessionController = {
    commands: {
      create: (request: unknown) => {
        asked.push(request)
        // 真实签名（commands.js 的 `async create`）：`{ sessionId, ...(agentPreset ? {agentPreset} : {}) }`
        return Promise.resolve({ sessionId: 'session-abc' })
      },
    },
  }
  const kernel = f.kernel(services)
  const made = await kernel.newSession!()
  assert.deepEqual(made, { ok: true, sessionId: 'session-abc' })
  // 空对象而不是 `{cwd: ...}` / `{sessionId: ...}`：不给 sessionId 才让内核分配新的，
  // 不给 cwd/workspaceId 才用宿主自己的默认项目目录（两者同时给会被内核当场拒）。
  assert.deepEqual(asked, [{}])
  assert.match(String((kernel.describe() as Record<string, unknown>).createFace), /commands\.create/)
})

test('新建的空会话必须出现在列表里 —— 持久化那面还没它，而它已经不是"不存在"', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  // 持久化那面（sessionQuery.listSessions）扫的是会话**日志**，一条还没有任何消息的
  // 新会话根本没有日志。这里就模拟这个局面：它永远报不出新建的那条。
  services.sessionQuery = {
    listSessions: () => Promise.resolve([{ header: { id: 'ses_old', createdAt: 1_700_000_000_000, cwd: '/w/old' } }]),
  }
  services.sessionController = { commands: { create: () => Promise.resolve({ sessionId: 'ses_fresh' }) } }
  const kernel = f.kernel(services)

  const before = await kernel.listSessions(50)
  assert.deepEqual(
    before.map((item) => item.summary.id),
    ['ses_old'],
  )

  await kernel.newSession!()

  const after = await kernel.listSessions(50)
  const ids = after.map((item) => item.summary.id)
  assert.equal(
    ids.includes('ses_fresh'),
    true,
    `新建的会话不在列表里（实得 ${JSON.stringify(ids)}）→ 用户回到列表会以为没建上`,
  )
  assert.equal(ids.length, 2, '补进来的应该正好是新那一条，不能重复')
})

test('持久化那面追上之后，本地那条临时记录要退休（不能一直盖着真数据）', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const rows: Array<{ header: { id: string; createdAt: number; cwd?: string } }> = [
    { header: { id: 'ses_old', createdAt: 1_700_000_000_000, cwd: '/w/old' } },
  ]
  services.sessionQuery = { listSessions: () => Promise.resolve(rows) }
  services.sessionController = { commands: { create: () => Promise.resolve({ sessionId: 'ses_fresh' }) } }
  const kernel = f.kernel(services)
  await kernel.newSession!()
  assert.equal((await kernel.listSessions(50)).length, 2, '临时记录先顶上')

  // 宿主把这条落盘了 → 下一次列表里它由持久化那面给出（带 cwd 等真数据）
  rows.push({ header: { id: 'ses_fresh', createdAt: 1_700_000_001_000, cwd: '/w/proj' } })
  const real = await kernel.listSessions(50)
  assert.equal(real.length, 2, '两边都有它的时候不许出现两条')
  const fresh = real.find((item) => item.summary.id === 'ses_fresh')
  assert.equal(fresh?.summary.workspace, '/w/proj', '要让位给真数据，而不是继续用本地那条没 workspace 的')
})

test('宿主没有 sessionController：明确说出缺什么，不许编一个 id 出来', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true }))
  const made = await kernel.newSession!()
  assert.equal(made.ok, false)
  assert.equal(made.sessionId, undefined, '拒绝时绝不能带 id')
  assert.match(String(made.message), /sessionController/, '要说清楚缺的是哪一层，否则只有一句看不懂的话')
  assert.match(String((kernel.describe() as Record<string, unknown>).createFace), /absent/)
})

test('sessionController 在、但 commands.create 不在：也要点名到成员一级', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  services.sessionController = { commands: { rename: () => undefined } }
  const made = await f.kernel(services).newSession!()
  assert.equal(made.ok, false)
  assert.match(String(made.message), /create/, '缺到哪一层就要报到哪一层（这个对象上有 rename 但没有 create）')
})

test('创建返回里没有 sessionId：按失败处理，不把 undefined 当成一个 id 往下传', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  services.sessionController = { commands: { create: () => Promise.resolve({ agentPreset: 'x' }) } }
  const made = await f.kernel(services).newSession!()
  assert.equal(made.ok, false)
  assert.match(String(made.message), /sessionId/)
})

/**
 * `sessionWorkspace` 是二维码 PNG 落点的唯一依据（`/drc pair` 卡片与右栏那条路由都用它）。
 * 它必须是**同步、零成本、绝不抛**的：调用点一个在命令 handler 里（用户等着出卡片），
 * 一个在每 2 秒一次的轮询请求里。
 */
test('sessionWorkspace：认活会话头里的 cwd，认不出来就 undefined（调用方退回 ~/.dsh/）', () => {
  const f = fixture()
  const services = f.bundle()
  services.sessions = {
    list: () => [],
    get: (id: string) => {
      if (id === 'ses_ws') return { header: { id: 'ses_ws', cwd: '/Users/u/project' } }
      // 另一代把会话折叠成扁平记录（listSessions 的 sessions.list 分支就是这么读的）。
      if (id === 'ses_flat') return { id: 'ses_flat', cwd: '/Users/u/flat' }
      if (id === 'ses_nocwd') return { header: { id: 'ses_nocwd' } }
      return undefined
    },
  }
  const kernel = f.kernel(services)
  assert.equal(kernel.sessionWorkspace?.('ses_ws'), '/Users/u/project', '真身是 session.header.cwd')
  assert.equal(kernel.sessionWorkspace?.('ses_flat'), '/Users/u/flat', '扁平记录形态（顶层 cwd）也要认')
  assert.equal(
    kernel.sessionWorkspace?.('ses_nocwd'),
    undefined,
    '没有 cwd 就是 undefined，不许回空串（空串会被 path.join 拼到进程 CWD）',
  )
  assert.equal(kernel.sessionWorkspace?.('ses_gone'), undefined, '查不到就是 undefined')
  assert.equal(kernel.sessionWorkspace?.(''), undefined, '空 id 不去问内核')
  assert.match(String((kernel.describe() as Record<string, unknown>).workspaceFace), /sessions\.get/)
})

test('宿主没有 sessions.get：返回 undefined 而不是抛（卡片退回 ~/.dsh/ 那条路）', () => {
  const f = fixture()
  const services = f.bundle()
  services.sessions = { list: () => [] }
  const kernel = f.kernel(services)
  assert.doesNotThrow(() => kernel.sessionWorkspace?.('ses_any'))
  assert.equal(kernel.sessionWorkspace?.('ses_any'), undefined)
  assert.match(String((kernel.describe() as Record<string, unknown>).workspaceFace), /absent/)
})

test('sessions.get 抛错（cordis Proxy 读不到成员就是抛）：折成 undefined，不许打断 /drc pair', () => {
  const f = fixture()
  const services = f.bundle()
  services.sessions = {
    list: () => [],
    get: () => {
      throw new Error('cannot get property "x" without inject')
    },
  }
  const kernel = f.kernel(services)
  assert.doesNotThrow(() => kernel.sessionWorkspace?.('ses_boom'))
  assert.equal(kernel.sessionWorkspace?.('ses_boom'), undefined)
})
