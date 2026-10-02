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
import { createServicesKernel, type ServicesBundle } from '../src/platform/carrier-services.js'
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
  const bundle = (overrides: { live?: boolean; model?: { provider: string; model: string } | undefined } = {}): ServicesBundle => {
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
  const request = f.calls.resume[0] as { resumeSessionId?: string; agentOptions?: { provider?: string; model?: string } }
  assert.equal(request.resumeSessionId, 'ses_idle', 'resumeSessionId 逐字传')
  assert.equal(request.agentOptions?.provider, 'stepfun', 'agentOptions.provider 缺失：这就是手机上"一个字都没有"的根因')
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
  assert.deepEqual(f.calls.unarchive, ['ses_arch'], '没先解归档：宿主的 archived-session-gate 会在 agent/pre-step 直接拒掉')
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
  assert.deepEqual(f.calls.cancel[0], [{ kind: 'user' }, { keepInbox: true }], 'cancel 的参数形状必须逐字对：keepInbox 丢了会把已排队的指令一起吞掉')
})

test('modelSelection 与发指令读的是同一条路径（两处各写一遍迟早分叉）', () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle())
  assert.deepEqual(kernel.modelSelection?.(), { provider: 'stepfun', model: 'step-5-preview' })
  const missing = fixture()
  const kernel2 = missing.kernel(missing.bundle({ model: undefined }))
  assert.equal(kernel2.modelSelection?.(), undefined, '没有 currentSelection 时必须返回 undefined，而不是抛或给半个对象')
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
  const sessionEvent = listeners["session/event"]
  assert.ok(sessionEvent, "session/event 没订阅上：白名单或注册口出问题")
  assert.doesNotThrow(
    () => sessionEvent({ id: "ses_live" }, { type: "turn/start", data: { turn: 3 } }),
    '我们的监听器把异常抛回了 cordis 的 emit：这一代 cordis 会因此拆掉整条订阅',
  )
  const described = kernel.describe() as Record<string, unknown>
  assert.match(String(described.listenerErrors), /下游炸了/, '抛错没进 status.json：线上只能靠猜')
  assert.match(String(described.listenerErrors), /^\d+×/, '要带次数：同一处抛一万次与抛一次是完全不同的问题')
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
  const unknownEvent = listeners["session/event"]
  assert.ok(unknownEvent, "session/event 没订阅上")
  unknownEvent({ id: "ses_live" }, { type: "brand/new-event", seq: 1, data: { x: 1 } })
  assert.deepEqual(seen, [], '未知类型被映射成了某个事件：F1 禁止挪用语义')
  assert.equal(String((kernel.describe() as Record<string, unknown>).unmappedEventTypes), 'brand/new-event', '没留痕：下一次"手机上缺东西"又要从头猜')
  assert.match(String((kernel.describe() as Record<string, unknown>).eventTypes), /brand\/new-event/, '收到过什么类型也要记：分不清"内核没发"与"我们没认"')
})
