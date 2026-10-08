import type { KernelEvent } from '../src/ports/index.js'
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
import {
  createServicesKernel,
  historyPageFromLog,
  MAPPED_SESSION_EVENTS,
  sessionEventKernelEvents,
  type ServicesBundle,
} from '../src/platform/carrier-services.js'
import { FakeClock } from '../src/core/clock.js'
import { parseEvPayload } from 'dsh-remote-wire'
import { questionRequest } from 'dsh-remote-wire'

interface Calls {
  resume: Array<Record<string, unknown>>
  unarchive: string[]
  followup: unknown[]
  steer: unknown[]
  cancel: unknown[][]
  /** 带图提示交 `sessionController.commands.prompt` 的入参（逐字记下来）。 */
  prompt: Array<Record<string, unknown>>
  /** 带图提示交 `attachments.admitPromptContent` 的入参。 */
  admit: unknown[][]
  /**
   * `archiveSession` / `unarchiveSession` 的**完整实参列表**（不是只记 id）。
   *
   * 为什么记数组而不记 id：这一族判据的核心是"**不许传第二个参数**"
   * —— 只记 id 就看不见多出来的那个 `{stopActivity:true}`，而那正是会
   * 停掉主机上正在跑工作的那个参数。记 `args` 才测得出"只有一个参数"。
   */
  archive: Array<{ method: 'archiveSession' | 'unarchiveSession'; args: unknown[] }>
}

interface Fixture {
  calls: Calls
  /** 活的 agent 是**同一个对象**：测试要能在它身上删成员（每次 get 返回新对象的话删了也没用）。 */
  readonly liveAgent: Record<string, unknown>
  bundle(overrides?: BundleOverrides): ServicesBundle
  kernel(services: ServicesBundle): ReturnType<typeof createServicesKernel>
}

/**
 * 夹具可开关的三个面。
 *
 * 默认**两个图片面都没有**（promptFace / admitFace 都是 false）：这是"这台主机接不住图"
 * 的形状，判据里必须能拿到它——不然真机事故那一条（发图 → 回合以内核报错收场）
 * 在测试里根本复现不出来。纯文本的用例不受影响，它们本来就不看图片面。
 */
interface BundleOverrides {
  live?: boolean
  model?: { provider: string; model: string } | undefined
  /** 有 `sessionController.commands.prompt`（内核的完整入口）。 */
  promptFace?: boolean
  /** 只有 `attachments.admitPromptContent`（那座桥）。 */
  admitFace?: boolean
}

/** 一张 4 字节的最小 JPEG：够过魔数判定，不占测试体积。 */
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb]).toString('base64')

function fixture(
  options: {
    newSessionCwd?: string
    /** 这条会话此刻有没有人在等它（awaiting-* 会话状态的数据源，见 pendingKindForSession）。 */
    pendingKindForSession?: (sessionId: string) => 'approval' | 'question' | undefined
  } = {},
): Fixture {
  const calls: Calls = {
    resume: [],
    unarchive: [],
    followup: [],
    steer: [],
    cancel: [],
    prompt: [],
    admit: [],
    archive: [],
  }
  const clock = new FakeClock()
  const liveAgent: Record<string, unknown> = {
    followup: (message: unknown) => calls.followup.push(message),
    steer: (message: unknown) => calls.steer.push(message),
    cancel: (...args: unknown[]) => calls.cancel.push(args),
  }
  const bundle = (overrides: BundleOverrides = {}): ServicesBundle => {
    const live = overrides.live ?? false
    const model = 'model' in overrides ? overrides.model : { provider: 'stepfun', model: 'step-5-preview' }
    const out: ServicesBundle = {
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
        // ⚠️ 这个桩**照抄内核的签名形状**（第二个参数是 options），而不是照抄
        // 我们"应该"怎么调。它存在的意义就是：哪天有人为了"让用户少跑一趟"
        // 而补上 `{ stopActivity: true }`，`args.length` 会立刻从 1 变成 2。
        archiveSession: (...args: unknown[]) => {
          calls.archive.push({ method: 'archiveSession', args })
          return Promise.resolve()
        },
      },
    }
    if (overrides.promptFace) {
      out.sessionController = {
        commands: {
          prompt: (request: Record<string, unknown>) => {
            calls.prompt.push(request)
            return Promise.resolve({ accepted: true })
          },
        },
      }
    }
    if (overrides.admitFace) {
      // 复刻内核那座桥的**形状契约**：入口块进去、内部块出来、顺序一一对应。
      // 少了 attachment 的图片块在真机上会让内核崩（判据见下面那组测试的注释）。
      out.attachments = {
        admitPromptContent: (content: unknown[]) => {
          calls.admit.push(content)
          return Promise.resolve(
            content.map((part, index) => {
              const one = part as { type: string; text?: string; mediaType?: string; data?: string }
              if (one.type !== 'image') return { ...one }
              return {
                type: 'image',
                attachment: { attachmentId: `sha256:${'0'.repeat(56)}${index + 1}`, mediaType: one.mediaType },
              }
            }),
          )
        },
      }
    }
    return out
  }
  return {
    calls,
    liveAgent,
    bundle,
    kernel: (services) =>
      createServicesKernel(services, {
        clock,
        log: () => {},
        newSessionCwd: options.newSessionCwd,
        pendingKindForSession: options.pendingKindForSession,
      }),
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
  const listenerOptions: Record<string, unknown> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void, options?: unknown) => {
    listeners[name] = listener
    listenerOptions[name] = options
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
  // **这两个选项各治一种"卡没弹"，摘掉任何一个真机都会瞎**：
  // `global` 管"不被作用域过滤掉"，`prepend` 管"排在桌面那位应答者前面"
  // （waterfall 里第一个 hook 是外层，外层不 next() 内层永远轮不到）。
  assert.deepEqual(
    listenerOptions['approval/request'],
    { global: true, prepend: true },
    'approval/request 没带 {global:true, prepend:true}：前者会被 cordis 过滤掉，后者会排在桌面 UI 后面永远轮不到',
  )
  // 提问那条**也是参与者**（2026-10-04 改的）：以前它走 `userQuestions.registerProvider`
  // 那个单提供者口——那一代宿主上根本没有这个成员，而且"接管"意味着桌面问不了问题。
  // 现在它和审批共用同一条参与式实现，所以两个名字都要登记上、选项也要一模一样。
  assert.ok(
    listeners['user-questions/request'],
    '没有登记 user-questions/request 参与者：手机上永远不会有提问卡，而桌面的提问能力也不该被顶掉',
  )
  assert.equal(described.questionsFace, 'registered', `提问面登记状态读不出真值：${String(described.questionsFace)}`)
  assert.deepEqual(
    listenerOptions['user-questions/request'],
    { global: true, prepend: true },
    'user-questions/request 没带同一组选项：提问那条也是按 scopeTarget(agent, agent) 派发的，少了 global 就收不到',
  )
  detach()
})

/**
 * 真机上"审批卡没弹"有两种根因，现场长得一模一样，只有审计面能把它们分开：
 * 整条 waterfall 没人答（我们没被派发）vs 别人抢先答了（我们排在后面）。
 * 所以内核报的 `approval/asked` / `approval/decided` 必须原样进 status.json。
 */
test('审批审计面的两个落点要进 status.json：asked 计次、decided 记 outcome', () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  kernel.subscribe(() => {})
  const fire = listeners['session/event']
  assert.ok(fire, 'session/event 没订阅上')
  const described0 = kernel.describe() as Record<string, unknown>
  assert.equal(described0.approvalAsked, 0, '一次都没问过，计数就该是 0')
  assert.equal(described0.approvalDecided, 'not-seen', '没收到 decided 时要说 not-seen，不能空着让人以为答过了')
  fire({ id: 'ses_live' }, { type: 'approval/asked', data: { id: 'ap_1', toolName: 'write_file' } })
  fire({ id: 'ses_live' }, { type: 'approval/decided', data: { id: 'ap_1', outcome: 'unavailable' } })
  fire({ id: 'ses_live' }, { type: 'approval/asked', data: { id: 'ap_2', toolName: 'bash' } })
  fire({ id: 'ses_live' }, { type: 'approval/decided', data: { id: 'ap_2', outcome: 'rejected' } })
  const described = kernel.describe() as Record<string, unknown>
  assert.equal(described.approvalAsked, 2, `问过两次却报 ${String(described.approvalAsked)}`)
  assert.equal(described.approvalDecided, 'rejected', 'decided 要记**最后一次**的 outcome：它就是"谁答的"的证据')
})

/**
 * `approvalFace='registered'` 只说明"挂上去了"，不说明"收得到"。
 * 这两条把"收到之后走到哪一步"也钉成字段：真机上再出现审批卡没弹，
 * 看 `approvalCalls` 是 0 还是 >0 就能一句话分掉两半。
 */
test('审批 waterfall 被调用时要留下次数与落点：手机答了就记 answered-by-phone', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  const asked: string[] = []
  kernel.attachInteractionSink!({
    approval: async (info: { sessionId: string; action: string }) => {
      asked.push(`${info.sessionId}/${info.action}`)
      return 'allowed-once'
    },
    question: async () => null,
  })
  assert.equal((kernel.describe() as Record<string, unknown>).approvalCalls, 0, '一次都没派发，计数不该动')
  const outcome = await listeners['approval/request']!(
    { agent: { session: { id: 'ses_live' } }, toolName: 'write_file', reason: '要往工作区外写' },
    async () => 'unavailable',
  )
  assert.equal(outcome, 'allowed-once', '手机放行之后没把 outcome 交回瀑布')
  assert.deepEqual(asked, ['ses_live/write_file'], '交给 runtime 的会话与工具名不对：审批卡会问错东西')
  const described = kernel.describe() as Record<string, unknown>
  assert.equal(described.approvalCalls, 1, '调用次数没进 status.json：只能靠猜')
  assert.equal(
    described.approvalLast,
    'answered-by-phone(allowed-once)',
    `落点读不出来：${String(described.approvalLast)}`,
  )
})

test('拿不到会话或手机没答上时要交还桌面，并把"交还了"记进 status.json', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let sinkCalls = 0
  kernel.attachInteractionSink!({
    approval: async () => {
      sinkCalls += 1
      return 'decline'
    },
    question: async () => null,
  })
  // ① 请求里没有会话 id（宿主换了字段形状）→ 不抢答，交还。
  const noSession = await listeners['approval/request']!({ toolName: 'write_file' }, async () => 'unavailable')
  assert.equal(noSession, 'unavailable', '没有会话 id 却自己答了：会把桌面 UI 的审批权抢掉')
  assert.equal(sinkCalls, 0, '没有会话 id 还去问手机')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).approvalLast,
    'handed-back(no phone target)',
    '交还原因没进 status.json：下次又要从"为什么没弹"猜起',
  )
  // ② 手机超时（sink 回 decline）而链子末端也没人答 → 交还 'unavailable'，而不是替用户拒绝。
  const declined = await listeners['approval/request']!(
    { agent: { session: { id: 'ses_live' } }, toolName: 'write_file' },
    async () => 'unavailable',
  )
  assert.equal(declined, 'unavailable', '手机没答上时我们替用户拒绝：桌面那条链就该自己决定')
  assert.equal(sinkCalls, 1, '这一条该问到手机')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).approvalLast,
    'handed-back(neither answered)',
    '交还原因没进 status.json：下次又要从"为什么没弹"猜起',
  )
  assert.equal((kernel.describe() as Record<string, unknown>).approvalCalls, 2)
})

/**
 * 这三条钉的是同一句红线：**插件不许改变宿主自己的行为**。
 * 2026-10-04 那次只 `prepend` 不自顾地等手机，结果"手机上弹了、桌面上不弹了"——
 * 用户当场要求两边都弹。所以形状必须是：一进函数就把 `next()` 叫起来，两边赛跑。
 */
test('手机先答也必须把链子交给桌面（next() 要跑到）——不许让 DSH 少弹一个窗', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  kernel.attachInteractionSink!({ approval: async () => 'allowed-once', question: async () => null })
  let nextCalls = 0
  const never = new Promise<string>(() => {})
  const outcome = await listeners['approval/request']!(
    { agent: { session: { id: 'ses_live' } }, toolName: 'write_file' },
    () => {
      nextCalls += 1
      return never
    },
  )
  assert.equal(outcome, 'allowed-once')
  assert.equal(nextCalls, 1, '手机先答就不叫 next()：桌面那一半整个不弹了，这是改变宿主行为')
})

test('桌面先答时手机那一侧必须被撤回（signal abort），落点记 answered-by-desktop', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let phoneSignal: AbortSignal | undefined
  let releasePhone: (value: 'decline') => void = () => {}
  kernel.attachInteractionSink!({
    approval: async (info: { signal?: AbortSignal }) => {
      phoneSignal = info.signal
      // 手机一直没人点：桌面先答之后，这一侧必须被 abort 叫醒，而不是挂到 180s 超时。
      return new Promise<'decline'>((resolve) => {
        releasePhone = resolve
      })
    },
    question: async () => null,
  })
  let releaseDesktop: (value: string) => void = () => {}
  const pending = listeners['approval/request']!(
    { agent: { session: { id: 'ses_live' } }, toolName: 'write_file' },
    () =>
      new Promise<string>((resolve) => {
        releaseDesktop = resolve
      }),
  )
  await new Promise((resolve) => setImmediate(resolve))
  releaseDesktop('rejected')
  assert.equal(await pending, 'rejected', '桌面答了却不被采纳：等于我们把宿主的答案吞了')
  assert.equal(phoneSignal?.aborted, true, '桌面先答却没撤回手机那一侧：手机那张卡会继续倒计时，waiting 角标也不会归零')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).approvalLast,
    'answered-by-desktop(rejected)',
    '落点要分得清是手机答的还是桌面答的——排错时这是两件事',
  )
  releasePhone('decline')
})

test('手机超时不算答案：桌面稍后给出的真决定必须赢（不许"手机没电=自动拒绝"）', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  kernel.attachInteractionSink!({ approval: async () => 'decline', question: async () => null })
  let releaseDesktop: (value: string) => void = () => {}
  const inflight = listeners['approval/request']!(
    { agent: { session: { id: 'ses_live' } }, toolName: 'write_file' },
    () =>
      new Promise<string>((resolve) => {
        releaseDesktop = resolve
      }),
  )
  await new Promise((resolve) => setImmediate(resolve))
  releaseDesktop('allowed-once')
  assert.equal(await inflight, 'allowed-once', '手机先超时就把这一问判掉，等于替桌面做了决定')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).approvalLast,
    'answered-by-desktop(allowed-once)',
    `落点读错了：${String((kernel.describe() as Record<string, unknown>).approvalLast)}`,
  )
})

/**
 * 这三条钉的是**反方向**那一半：手机先答之后，桌面那张卡也得当场消失。
 *
 * 句柄只有一个：链子下游那份 `request.signal`。宿主的 api-gateway 在它的 signal 断掉时
 * 向每个渲染端推 `{type:'cancel', eventId}`，渲染端据此 `PendingApproval.abort()`
 * ——卡片由宿主自己的代码收，插件只是宣告"这次请求结束了"。
 * 所以这里要钉的是"我们有没有把那个句柄拿到手、并且在对的时刻按一下"。
 */
test('手机先答时必须撤销交给下游的那份 signal——那是关掉桌面那张卡的唯一句柄', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let phoneSignal: AbortSignal | undefined
  kernel.attachInteractionSink!({
    approval: async (info: { signal?: AbortSignal }) => {
      phoneSignal = info.signal
      return 'allowed-once'
    },
    question: async () => null,
  })
  const platform = new AbortController()
  const request: { agent: { session: { id: string } }; toolName: string; signal?: AbortSignal } = {
    agent: { session: { id: 'ses_live' } },
    toolName: 'write_file',
    signal: platform.signal,
  }
  // 桌面那一半**在被调用时**才读 `request.signal`（网关的 `projected.signal` 就是这么取的），
  // 所以这里也在回调里读，而不是在调用之前读一份快照。
  let downstream: AbortSignal | undefined
  const pending = listeners['approval/request']!(request, () => {
    downstream = request.signal
    // 桌面上一直没人点：手机答完之后这张卡就靠我们那一下撤销来收。
    return new Promise<string>(() => {})
  })
  assert.equal(await pending, 'allowed-once')
  assert.notEqual(
    downstream,
    platform.signal,
    '下游拿到的还是原件那份 signal：手机答完之后没有任何句柄能关掉桌面那张卡',
  )
  assert.equal(downstream?.aborted, true, '换到了句柄却没撤销：桌面那张卡照样挂着')
  const described = kernel.describe() as Record<string, unknown>
  assert.equal(
    described.approvalSignalHandoff,
    'fused',
    `换 signal 的落点读不出来：${String(described.approvalSignalHandoff)}`,
  )
  assert.equal(
    described.approvalDesktopVoided,
    1,
    '这一次撤销没进 status.json：线上就只能靠屏幕猜"桌面那张卡到底收没收"',
  )
  // 撤销**只该往下游传**：runtime 那侧的 signal 跟着断的话，手机自己点掉的这次会被
  // 当成"被撤回"再作废一遍（`settle(id,'cancelled',…)` 会把答案盖掉）。
  assert.equal(phoneSignal?.aborted, false, '我们把下游撤销了，却连 runtime 那侧一起撤了：手机的答案会被自己作废')
})

test('平台自己中断时并算后的 signal 要保住原来的取消能力（reason 也要带下去）', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let phoneSignal: AbortSignal | undefined
  kernel.attachInteractionSink!({
    approval: async (info: { signal?: AbortSignal }) => {
      phoneSignal = info.signal
      // 手机这一侧被撤回后就是"没人答"（runtime 会结掉它）。
      return new Promise<'decline'>((resolve) => {
        info.signal?.addEventListener('abort', () => resolve('decline'), { once: true })
      })
    },
    question: async () => null,
  })
  const platform = new AbortController()
  const request: { agent: { session: { id: string } }; toolName: string; signal?: AbortSignal } = {
    agent: { session: { id: 'ses_live' } },
    toolName: 'bash',
    signal: platform.signal,
  }
  let downstream: AbortSignal | undefined
  let releaseDesktop: (value: string) => void = () => {}
  const pending = listeners['approval/request']!(
    request,
    () =>
      new Promise<string>((resolve) => {
        downstream = request.signal
        releaseDesktop = resolve
      }),
  )
  await new Promise((resolve) => setImmediate(resolve))
  const reason = new Error('turn cancelled')
  platform.abort(reason)
  assert.equal(downstream?.aborted, true, '平台都中断了、下游那份却没跟着断：并算把宿主的取消能力换掉了')
  assert.equal(downstream?.reason, reason, 'reason 要原样带下去：渲染端靠它说明这张卡为什么消失')
  assert.equal(phoneSignal?.aborted, true, '手机那一侧同样要收到撤回，否则它会挂到超时')
  releaseDesktop('unavailable')
  assert.equal(await pending, 'unavailable', '平台中断且两边都没答时必须交还失败闭合（宿主自己判 cancelled）')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).approvalDesktopVoided,
    0,
    '这一场不是手机答的，那颗计数器不该动',
  )
})

test('请求对象的 signal 不可写时不许抛：换不出去就退回"卡片等它自己的生命周期"', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  kernel.attachInteractionSink!({ approval: async () => 'allowed-once', question: async () => null })
  const request: { agent: { session: { id: string } }; toolName: string; signal?: AbortSignal } = {
    agent: { session: { id: 'ses_live' } },
    toolName: 'write_file',
  }
  // 冻结这一个字段（ESM 严格模式下赋值会**抛** TypeError，那一抛会顺着 waterfall 把宿主的审批判死）。
  Object.defineProperty(request, 'signal', {
    value: new AbortController().signal,
    writable: false,
    enumerable: true,
    configurable: false,
  })
  const outcome = await listeners['approval/request']!(request, async () => 'unavailable')
  assert.equal(outcome, 'allowed-once', '换不出去也得照常把手机的答案交回去，审批不能因为我们这一行而失败')
  assert.equal(request.signal?.aborted, false, '不可写时不许碰原件那份 signal（更不许因为换不出去就把审批判死）')
  const handoff = String((kernel.describe() as Record<string, unknown>).approvalSignalHandoff)
  assert.match(
    handoff,
    /^(failed|ignored)/,
    `换不出去要说得出来（严格模式下赋值会抛，抛了就带原因）：否则"桌面那张卡为什么没关"在现场查不到`,
  )
  assert.equal((kernel.describe() as Record<string, unknown>).approvalDesktopVoided, 0)
})

/**
 * 提问那条 waterfall 的四条判据（形状与审批那组一一对应，但**每条都有自己的坑**）。
 *
 * 原来这里测的是 `userQuestions.registerProvider`——那条口在这一代宿主上不存在
 * （服务里 provider 一词零命中），而且"注册一个提供者"是单提供者语义：接管 = 桌面问不了问题。
 * 现在提问和审批共用同一条参与式实现，所以这里钉的是"两端同弹、谁先答谁算、两个方向都能收卡"。
 */
test('提问：手机先答时把答案对象原样交回瀑布，并撤销交给桌面那份 signal', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  const asked: string[] = []
  kernel.attachInteractionSink!({
    approval: async () => 'decline',
    question: async (info: { sessionId: string; questions: unknown[] }) => {
      asked.push(`${info.sessionId}/${(info.questions as { id: string }[]).map((q) => q.id).join(',')}`)
      return { answers: [{ id: 'q_env', selected: ['预发'] }] }
    },
  })
  const request: { agent: { session: { id: string } }; questions: unknown[]; signal?: AbortSignal } = {
    agent: { session: { id: 'ses_live' } },
    questions: [{ id: 'q_env', question: '部署到哪个环境？', options: [{ label: '预发' }, { label: '线上' }] }],
  }
  let downstream: AbortSignal | undefined
  const outcome = await listeners['user-questions/request']!(request, () => {
    downstream = request.signal
    // 桌面上一直没人点：手机答完之后这张卡靠我们那一下撤销来收。
    return new Promise<never>(() => {})
  })
  assert.deepEqual(
    outcome,
    { answers: [{ id: 'q_env', selected: ['预发'] }] },
    '手机的答案没被原样交回：宿主那边会把这次提问判成"没人答"',
  )
  assert.deepEqual(asked, ['ses_live/q_env'], '交给 runtime 的会话与题号不对：提问卡会问错东西')
  assert.equal(downstream?.aborted, true, '手机先答却没撤销下游：桌面 composer 里那张提问卡会继续挂着')
  const described = kernel.describe() as Record<string, unknown>
  assert.equal(described.questionsCalls, 1, '提问派发次数没进 status.json')
  assert.equal(described.questionsLast, 'answered-by-phone(1 项)', `落点读不出来：${String(described.questionsLast)}`)
  assert.equal(described.questionsSignalHandoff, 'fused')
  assert.equal(described.questionsDesktopVoided, 1, '这一次撤销没进 status.json：线上只能靠屏幕猜')
  // 答案正文**不进** status.json（`answered-by-phone(1 项)` 只报题数）：那是端到端加密要守的边界。
  assert.equal(JSON.stringify(described).includes('预发'), false, 'status.json 里出现了用户答的内容')
})

test('提问：桌面先答时手机那一侧要被撤回（reason desktop），落点记 answered-by-desktop', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let phoneSignal: AbortSignal | undefined
  kernel.attachInteractionSink!({
    approval: async () => 'decline',
    question: async (info: { signal?: AbortSignal }) => {
      phoneSignal = info.signal
      // 手机没人点：桌面答完之后这一侧必须被叫醒，而不是挂到 300s 超时。
      return new Promise<null>((resolve) => {
        info.signal?.addEventListener('abort', () => resolve(null), { once: true })
      })
    },
  })
  const pending = listeners['user-questions/request']!(
    { agent: { session: { id: 'ses_live' } }, questions: [{ id: 'q1', question: '要哪个？' }] },
    async () => ({ answers: [{ id: 'q1', selected: ['甲'] }] }),
  )
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['甲'] }] }, '桌面答了却被我们吞掉')
  assert.equal(phoneSignal?.aborted, true, '桌面先答却没撤回手机那一侧：runtime 不知道要作废，手机上那张卡会继续挂着')
  assert.equal(String(phoneSignal?.reason), 'desktop', 'reason 必须是 desktop：runtime 靠它分"桌面先答"与"平台撤回"')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).questionsLast,
    'answered-by-desktop(1 项)',
    '落点要分得清是手机答的还是桌面答的',
  )
  assert.equal(
    (kernel.describe() as Record<string, unknown>).questionsDesktopVoided,
    0,
    '这一场不是手机答的，那颗计数器不该动',
  )
})

test('提问：两边都没答时必须把链子末端那个 rejection 原样抛回去（吞成 undefined 会冲掉整条链）', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  kernel.attachInteractionSink!({ approval: async () => 'decline', question: async () => null })
  // 宿主那条链的末端是 `noAnswerer()`：它**抛** NO_PROVIDER，而不是回一个值。
  const nobody = (): Promise<unknown> => {
    throw new Error('no user-questions answerer accepted the request')
  }
  // 测试夹具里 `listeners` 的声明是"订阅者返回 void"（emit-mode 的形状），
  // 而参与者**必须返回值**，所以这里按参与者形状窄化一次再断言。
  const ask = listeners['user-questions/request'] as unknown as (
    request: unknown,
    next: () => Promise<unknown>,
  ) => Promise<unknown>
  await assert.rejects(
    () =>
      ask({ agent: { session: { id: 'ses_live' } }, questions: [{ id: 'q1', question: '要哪个？' }] }, () => nobody()),
    /no user-questions answerer/,
    '把"没人答"吞成 undefined：那是把内核整条 turn 搞崩的形状（见 guard.ts 里那条红线）',
  )
  assert.equal(
    (kernel.describe() as Record<string, unknown>).questionsLast,
    'no-answer',
    '没人答这条也要留落点，否则现场只能看到"手机上没弹"这一半',
  )
})

test('提问：没有会话 id 时完整交还桌面，且不问手机（插件不抢答）', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let sinkCalls = 0
  kernel.attachInteractionSink!({
    approval: async () => 'decline',
    question: async () => {
      sinkCalls += 1
      return { answers: [] }
    },
  })
  const outcome = await listeners['user-questions/request']!(
    { questions: [{ id: 'q1', question: '要哪个？' }] },
    async () => ({ answers: [{ id: 'q1', selected: ['甲'] }] }),
  )
  assert.deepEqual(outcome, { answers: [{ id: 'q1', selected: ['甲'] }] }, '没有会话 id 却自己答了：会抢掉桌面的提问')
  assert.equal(sinkCalls, 0, '没有会话 id 还去问手机')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).questionsLast,
    'handed-back(no phone target)',
    '交还原因没进 status.json',
  )
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

test('历史：**正在跑**时第一页补最新待办快照（长回合里窗口裁掉也不许丢）', () => {
  // 2026-10-06 用户实测：重进一条跑了很久的会话，顶部待办条直接消失。
  // 待办是"此刻的清单"：todo/write 在回合开头，后面跟了几十条工具事件，
  // 40 条窗口把它裁在外面，而之后没有 todo 变更就没有实时帧来补——一直缺着。
  //
  // ⚠️ 2026-10-07 起这条**只在会话正在跑的时候成立**（`running: true`）：
  // 宿主那一侧的待办是按轮清的，会话没在跑时那份快照是**上一轮**的，
  // 补给手机等于让它说一句宿主此刻没说的话（用户实测双端不一致）。
  const log = [
    { type: 'todo/write', seq: 1, data: { todos: [{ content: '做一件事', status: 'in_progress' }] } },
    ...Array.from({ length: 10 }, (_, i) => ({
      type: 'tool/call',
      seq: 2 + i,
      data: { turn: 1, step: 1 + i, callId: `call_${i}`, name: 'bash', arguments: '{"command":"x"}' },
    })),
  ]
  const page = historyPageFromLog({ sessionId: 'ses_1', events: log, limit: 3, running: true })
  const todos = page.events.filter((event) => event.kind === 'todo')
  assert.equal(todos.length, 1, '第一页没有待办：手机重进长会话，顶部条子直接消失')
  assert.equal(
    (todos[0] as { todos: Array<{ content: string }> }).todos[0]?.content,
    '做一件事',
    '必须是最新那一份快照',
  )
})

test('历史：第一页本来就有待办时不许补第二份（去重，不是越多越好）', () => {
  const log = [
    { type: 'todo/write', seq: 1, data: { todos: [{ content: '旧的', status: 'pending' }] } },
    { type: 'todo/write', seq: 2, data: { todos: [{ content: '新的', status: 'in_progress' }] } },
  ]
  // ⚠️ `running: true` 不是可有可无的：2026-10-07 起，会话**不在跑**时历史里的
  // 待办整条被丢掉（宿主按轮清，手机不该拿上一轮的当"此刻的清单"——用户实测双端不一致）。
  // 下面这几条验的是"待办在历史里怎么被承载"，那个问题只在正在跑时存在。
  const page = historyPageFromLog({ sessionId: 'ses_1', events: log, limit: 100, running: true })
  const todos = page.events.filter((event) => event.kind === 'todo')
  assert.equal(todos.length, 1, '塌缩后最新一份只留一条，兜底不能再加一条')
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
  // 永远不给 sessionId（那才会复用旧会话而不是新建）；这一版连 cwd 都不给——
  // 一条会话都没有、配置也没点名时没有可抄的目录，交给宿主默认（2026-10-04 起
  // cwd 是显式给的，见下面两条；空列表这一档退回旧行为）。
  assert.deepEqual(asked, [{}])
  assert.match(String((kernel.describe() as Record<string, unknown>).createFace), /commands\.create/)
})

test('新建会话带 cwd：不给的话宿主用 process.cwd() 兜底（真机上是 /），会话就不在任何用户项目里', async () => {
  const f = fixture()
  const asked: unknown[] = []
  const services = f.bundle({ live: true })
  // 最近一条会话在 /Users/linbin/dsh-remote-control：用户在做的项目就是它。
  services.sessionQuery = {
    listSessions: () =>
      Promise.resolve([
        {
          header: { id: 'ses_old', createdAt: 1_700_000_000_000, cwd: '/Users/linbin/dsh-remote-control' },
        },
      ]),
  }
  services.sessionController = {
    commands: {
      create: (request: unknown) => {
        asked.push(request)
        return Promise.resolve({ sessionId: 'session-xyz' })
      },
    },
  }
  const made = await f.kernel(services).newSession!()
  assert.equal(made.ok, true)
  assert.deepEqual(asked, [{ cwd: '/Users/linbin/dsh-remote-control' }], '要挂在用户此刻在做的项目上')
})

test('新建会话的 cwd：配置点名优先于"跟着最近一条会话走"', async () => {
  const f = fixture({ newSessionCwd: '/Users/linbin/other-proj' })
  const asked: unknown[] = []
  const services = f.bundle({ live: true })
  services.sessionQuery = {
    listSessions: () => Promise.resolve([{ header: { id: 'ses_old', createdAt: 1_700_000_000_000, cwd: '/w/stale' } }]),
  }
  services.sessionController = {
    commands: {
      create: (request: unknown) => {
        asked.push(request)
        return Promise.resolve({ sessionId: 'session-pinned' })
      },
    },
  }
  await f.kernel(services).newSession!()
  assert.deepEqual(asked, [{ cwd: '/Users/linbin/other-proj' }], '配置点名的目录优先')
})

test('回归：最新建的会话没有 cwd 时，往前扫一条也要给出 cwd（2026-10-06 用户报"落在未分组"）', async () => {
  // 旧实现只取 listSessions(1)[0]，而那份列表按 createdAt 排。"最新建的那条"完全可能
  // 没有 cwd——它自己就是手机在旧版本里不带 cwd 建出来的那条。于是推断落空、
  // request 变成 {}、内核退回 process.cwd()（真机上是 `/`），DSH 的列表里那条
  // 就归到**未分组**：手机侧照常能用（它按 id 过滤），用户到电脑前却找不到。
  const f = fixture()
  const asked: unknown[] = []
  const services = f.bundle({ live: true })
  services.sessionQuery = {
    listSessions: () =>
      Promise.resolve([
        { header: { id: 'ses_new_no_cwd', createdAt: 1_700_000_900_000 } }, // 最新、没有目录
        { header: { id: 'ses_with_cwd', createdAt: 1_700_000_000_000, cwd: '/Users/linbin/dsh-remote-control' } },
      ]),
  }
  services.sessionController = {
    commands: {
      create: (request: unknown) => {
        asked.push(request)
        return Promise.resolve({ sessionId: 'session-scan' })
      },
    },
  }
  const made = await f.kernel(services).newSession!()
  assert.equal(made.ok, true)
  assert.deepEqual(
    asked,
    [{ cwd: '/Users/linbin/dsh-remote-control' }],
    '往前扫到一条带 cwd 的就必须用它：request 为 {} 等于把落点交给宿主默认，也就是未分组',
  )
})

test('最后操作过的会话优先于"最新建的"：人在哪条会话里干活就在哪个分组新建', async () => {
  // createdAt 排出来的第一条是"最新建的"，而用户此刻在动的往往不是它——
  // 上午建了 10 条、下午一直在第 3 条里干活，那么"最后操作的分组"是第 3 条的目录。
  // 主机不需要任何新数据源就能知道这件事：每一条 session 事件都经过 translateSessionEvent。
  const f = fixture()
  const asked: unknown[] = []
  const services = f.bundle({ live: true })
  services.sessionQuery = {
    listSessions: () =>
      Promise.resolve([
        { header: { id: 'ses_newest', createdAt: 1_700_000_900_000, cwd: '/w/just-created' } },
        { header: { id: 'ses_working', createdAt: 1_700_000_000_000, cwd: '/w/actually-working' } },
      ]),
  }
  services.sessionController = {
    commands: {
      create: (request: unknown) => {
        asked.push(request)
        return Promise.resolve({ sessionId: 'session-touched' })
      },
    },
  }
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  // 先列一次把 sessionId → cwd 填上（真实运行时列表是被定时刷新推动的）。
  await kernel.listSessions(50)
  // ⚠️ 必须 subscribe：`session/event` 是在 subscribe 里绑的（见 bindAll），
  // 不订阅就没人调 translateSessionEvent，"最后操作"这个信号也就根本不存在。
  kernel.subscribe(() => {})
  // 用户在 ses_working 里发了一句话 —— 这条事件就是"最后操作"的全部证据。
  listeners['session/event']?.(
    { id: 'ses_working' },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '继续' }], role: 'user', id: 'u-1' } },
  )
  assert.ok(listeners['session/event'], 'session/event 没绑上（没 subscribe 就是这样）')

  await kernel.newSession!()
  assert.deepEqual(
    asked,
    [{ cwd: '/w/actually-working' }],
    '落点必须是用户最后在动的那个分组，而不是 createdAt 最新那个',
  )
})

test('没观测到任何事件时退回"往前扫"，而不是落空（未分组）', async () => {
  const f = fixture()
  const asked: unknown[] = []
  const services = f.bundle({ live: true })
  services.sessionQuery = {
    listSessions: () => Promise.resolve([{ header: { id: 'ses_a', createdAt: 2, cwd: '/w/a' } }]),
  }
  services.sessionController = {
    commands: {
      create: (request: unknown) => {
        asked.push(request)
        return Promise.resolve({ sessionId: 'session-fallback' })
      },
    },
  }
  await f.kernel(services).newSession!()
  assert.deepEqual(asked, [{ cwd: '/w/a' }], 'lastTouched 为空时必须落到扫描那一档，而不是 {}')
})

test('新建出来的会话自带落点：列表里立刻能看出它归在哪个分组', async () => {
  // 不带 cwd 的话，刚建的那条在列表里 workspace 是空的——用户会看到它孤零零地
  // 待在"未分组"那一栏，而实际上内核已经把它放在 /w/proj 下了。这与"落点选错"
  // 是同一个故障的两种表现，必须一起修。
  const f = fixture()
  const services = f.bundle({ live: true })
  services.sessionQuery = {
    listSessions: () => Promise.resolve([{ header: { id: 'ses_old', createdAt: 1, cwd: '/w/proj' } }]),
  }
  services.sessionController = { commands: { create: () => Promise.resolve({ sessionId: 'ses_fresh' }) } }
  const kernel = f.kernel(services)

  await kernel.newSession!()
  const fresh = (await kernel.listSessions(50)).find((item) => item.summary.id === 'ses_fresh')
  assert.equal(fresh?.summary.workspace, '/w/proj', '新建那条的列表摘要必须带上 cwd：空 workspace 在 DSH 侧就是未分组')
})

test('cwd 形状不对就不采用（落回下一档），而不是把脏路径交给内核', async () => {
  const f = fixture()
  const asked: unknown[] = []
  const services = f.bundle({ live: true })
  services.sessionQuery = {
    listSessions: () =>
      Promise.resolve([
        { header: { id: 'ses_bad', createdAt: 3, cwd: 'relative/not/absolute' } }, // 不是绝对路径
        { header: { id: 'ses_ok', createdAt: 2, cwd: '/w/good' } },
      ]),
  }
  services.sessionController = {
    commands: {
      create: (request: unknown) => {
        asked.push(request)
        return Promise.resolve({ sessionId: 'session-shape' })
      },
    },
  }
  await f.kernel(services).newSession!()
  assert.deepEqual(asked, [{ cwd: '/w/good' }], '相对路径不能直接交给内核，要先跳过它')
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

test('被判定为宿主注入的 user/message：不发出站，但要在 kernel.injectedUserMessages 里留痕', () => {
  // 注入内容（time-context 之类）不能出站：它在手机上会顶着「你的指令」那颗蓝气泡，
  // 而用户没发过那句话。但"我们丢掉"必须看得见，否则「手机上看不到 X」这个问题
  // 分不清是宿主没发、我们丢了、还是路上丢了。
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  const seen: KernelEvent[] = []
  kernel.subscribe((event) => seen.push(event))
  const fire = listeners['session/event']
  assert.ok(fire, 'session/event 没订阅上')

  fire(
    { id: 'ses_live' },
    {
      type: 'user/message',
      seq: 1,
      data: {
        content: [{ type: 'text', text: 'Time sampled while preparing turn 3' }],
        source: { kind: 'time-context' },
        id: 'm-1',
      },
    },
  )
  fire(
    { id: 'ses_live' },
    {
      type: 'user/message',
      seq: 2,
      data: { content: [{ type: 'text', text: '真的指令' }], source: { kind: 'user' }, id: 'm-2' },
    },
  )

  assert.deepEqual(
    seen.map((event) => event.kind),
    ['delta'],
    '只该有真人那一条的 delta：注入的那条出站就是让用户背一句他没说过的话',
  )
  const traced = String((kernel.describe() as Record<string, unknown>).injectedUserMessages)
  assert.match(traced, /time-context/, '丢掉的那条必须留痕，否则真机排错又要从头猜')
  assert.doesNotMatch(traced, /(?<!×)\buser\b(?!-)/, '真人消息不许被算进"注入"计数：那个计数是"我们丢了多少"的账')
})

/**
 * 提问卡在手机上不弹的根因：mapQuestion 产出**协议不合法**的载荷，整帧被静默丢弃。
 *
 * 协议里 questionItem.question 与 choiceOption.label 都是 nonEmpty，而旧实现
 * 写的是 String(item.question ?? '')——宿主那个字段名一旦对不上，空串就让
 * parseEvPayload 返回 null，认不出的载荷**静默丢弃**（没有任何报错）。
 * 现场长这样：dsh 弹了提问框，mp 端什么都没有，而 status.json 里
 * questionsCalls=1 / questionsLast=no-answer，两头都对不上账。
 *
 * 所以判据直接钉「产出的帧必须能过协议自己的解析器」，而不是钉某几个字段名。
 */
test('提问卡：宿主字段名对不上时，产出的帧仍必须能过协议解析（否则手机上静默不弹）', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let received: { questions: unknown[] } | undefined
  kernel.attachInteractionSink!({
    approval: async () => 'decline',
    question: async (info: { questions: unknown[] }) => {
      received = info as { questions: unknown[] }
      return { answers: [] }
    },
  })
  // 三种真实见过的畸形题面：只有 header、只有 text、以及完全没题面只有选项。
  const request = {
    agent: { session: { id: 'ses_live' } },
    questions: [
      { id: 'q1', header: '部署到哪个环境', options: [{ label: '预发' }, {}] },
      { id: 'q2', text: '要不要继续' },
      { id: 'q3', options: [{ value: 'A' }] },
    ],
  }
  await listeners['user-questions/request']!(request, async () => {
    throw new Error('桌面没答')
  })
  assert.ok(received, '提问没有派发到 sink')
  // **这一条是全部重点**：把产出的题面原样塞进协议构造器，必须解析得过。
  assert.notEqual(
    parseEvPayload(
      questionRequest({ requestId: 'q_1', sessionId: 'ses_live', questions: received.questions as never }),
    ),
    null,
    '产出的 ev.question_request 过不了协议解析：这一帧会被静默丢弃，手机上永远不弹卡',
  )
  const items = received.questions as Array<Record<string, unknown>>
  assert.equal(items.length, 3, '不该因为某一题畸形就少发一道')
  assert.equal(items[0]?.question, '部署到哪个环境', '只有 header 时要退回取 header')
  assert.equal(items[1]?.question, '要不要继续', '只有 text 时要退回取 text')
  assert.equal(items[2]?.question, '第 3 题', '完全没有题面文字时给一道稳定的占位题')
  // 选项同理：空 label 会让 choiceOption 校验失败
  assert.deepEqual(items[0]?.options, [
    { id: 'o1', label: '预发' },
    { id: 'o2', label: '选项 2' },
  ])
  assert.deepEqual(items[2]?.options, [{ id: 'o1', label: 'A' }], '只有 value 时取 value')
})

/**
 * 带图发提示必须走**内核自己的入口**，图片块是 `PromptContentPart` 的形状。
 *
 * ## 这组判据钉的是 2026-10-06 的真机事故
 *
 * 现场：手机发图 → 「这一轮没有产出回复，内核报错（UNKNOWN）：
 * Cannot read properties of undefined (reading 'attachmentId')」。
 *
 * 根因不是内核坏了，是我们把**入口形状**当成了**内部形状**发进去：
 * 内核序列化图片块时读 `block.attachment.attachmentId`
 * （`@deepseek-ai/dsh-llm-deepseek/lib/index.js:1587`），而那个 `attachment`
 * 只能由 `admitPromptContent()` 产出。旧实现既没经过它，字段名还用的是 `mimeType`
 * （内核叫 `mediaType`）—— 于是回合在请求准备阶段崩掉。
 *
 * 判据看的是**真正会被内核读到的那份内容块**，不是我们内部的中间形状。
 */
test('图片走内核入口：优先 sessionController.commands.prompt，块是 {type:image, mediaType, data}', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true, promptFace: true }))
  const sent = await kernel.sendPrompt('ses_live', '看这张报错', [{ data: TINY_JPEG, mimeType: 'image/jpeg' }])
  assert.equal(sent.ok, true, sent.message ?? '')
  assert.equal(f.calls.prompt.length, 1, '没走内核的 prompt 入口：图片会被内核当成裸块，回合必崩')
  assert.equal(f.calls.followup.length, 0, '命令入口已经投递过了，再 followup 一次就是把这张图发两遍')

  const request = f.calls.prompt[0]!
  assert.equal(request.sessionId, 'ses_live', 'sessionId 逐字传')
  assert.equal(request.mode, 'queue', 'mode 必须是 queue（有 followup 时），steer 会插进当前步')
  assert.equal(typeof request.requestId, 'string', 'requestId 必填：内核靠它做幂等去重')
  const content = request.content as Array<Record<string, unknown>>
  assert.deepEqual(
    content[0],
    { type: 'text', text: '看这张报错' },
    '第一个块必须是用户原话：追加任何东西都会让模型看到一句用户没说过的话',
  )
  assert.deepEqual(
    content[1],
    { type: 'image', mediaType: 'image/jpeg', data: TINY_JPEG },
    '图片块不是内核入口形状：字段名必须是 mediaType（内核不认 mimeType），data 必须是裸 base64',
  )
  assert.equal(content.length, 2, `正文里混进了落盘那套痕迹（附件说明、绝对路径……）——正文必须原样透传`)
  assert.ok(!JSON.stringify(content).includes('mimeType'), '内容块里还留着 mimeType：这个字段内核不读，类型判定会落空')
})

test('同一张图连发两条：requestId 必须逐条不同（重复会让内核当成重投静默丢图）', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true, promptFace: true }))
  await kernel.sendPrompt('ses_live', '第一张', [{ data: TINY_JPEG, mimeType: 'image/jpeg' }])
  await kernel.sendPrompt('ses_live', '第二张', [{ data: TINY_JPEG, mimeType: 'image/jpeg' }])
  const ids = f.calls.prompt.map((one) => String(one.requestId))
  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1], 'requestId 重复了：内核的 hasPromptRequest 会把第二条当成重投直接返回 accepted')
})

test('没有命令入口时退回 attachments.admitPromptContent：followup 收到的是内核内部形状', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true, admitFace: true }))
  const sent = await kernel.sendPrompt('ses_live', '看这张报错', [{ data: TINY_JPEG, mimeType: 'image/jpeg' }])
  assert.equal(sent.ok, true, sent.message ?? '')
  assert.equal(f.calls.admit.length, 1, '没经过那座桥：admission 产出 attachment，绕过它内核必崩')
  assert.equal(f.calls.prompt.length, 0, '这代没有命令入口，不该去调一个不存在的方法')

  const content = (f.calls.followup[0] as { content?: Array<Record<string, unknown>> }).content ?? []
  assert.deepEqual(content[0], { type: 'text', text: '看这张报错' }, '正文原样透传')
  assert.equal(content[1]?.type, 'image')
  assert.equal(
    typeof (content[1]?.attachment as { attachmentId?: string } | undefined)?.attachmentId,
    'string',
    `图片块没有 attachment：内核序列化时读 block.attachment.attachmentId 会抛（真机现象：reading 'attachmentId'）`,
  )
  assert.equal(content[1]?.data, undefined, '入口块的 base64 原文不许漏进内部形状：它只该留在 store 里')
})

/**
 * 真机事故的正判据：**两个图片面都没有时必须明确拒绝**。
 *
 * 旧实现在这里"乐观降级"——照样把裸 `{type:'image', data, mimeType}` 塞进 followup，
 * 结果不是图被悄悄丢掉，而是整个回合在内核里以 error 收场：手机上只看到
 * 「这一轮没有产出回复，内核报错（UNKNOWN）」，图从头到尾没进过任何持久化。
 * 明确拒绝 + 指一条能走通的路（存成文件），比拿用户的回合去赌好得多。
 */
test('这台主机没有图片通路：明确拒绝，且一次内核投递都不许发生', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true }))
  const sent = await kernel.sendPrompt('ses_live', '看这张报错', [{ data: TINY_JPEG, mimeType: 'image/jpeg' }])
  assert.equal(sent.ok, false, '没有 admission 还把裸 image 块塞进去 = 真机那次崩溃')
  assert.match(sent.message ?? '', /图片/, '拒绝理由要点名图片，否则手机上只有一句看不懂的话')
  assert.match(sent.message ?? '', /文件/, '拒绝理由要指一条能走通的路（存成文件再发）')
  assert.equal(f.calls.followup.length, 0, '拒绝之后还投递：用户会以为发出去了')
  assert.equal(f.calls.steer.length, 0, '同上，steer 也是投递')
})

test('admission 没给出 attachment 时必须当失败：不能把"以为过了"的块继续往下送', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  // 复刻一个"什么都没干"的 store：返回的还是入口块（没有 attachment）。
  services.attachments = {
    admitPromptContent: (content: unknown[]) => {
      f.calls.admit.push(content)
      return Promise.resolve(content)
    },
  }
  const sent = await f
    .kernel(services)
    .sendPrompt('ses_live', '看这张报错', [{ data: TINY_JPEG, mimeType: 'image/jpeg' }])
  assert.equal(sent.ok, false, '没拿到持久引用就往下送 = 又一次真机崩溃')
  assert.equal(f.calls.followup.length, 0, '不许投递')
})

test('手机送来的图片整成内核入口形状：data-URI 前缀剥掉、类型按字节判定', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true, promptFace: true }))
  // 手机声明的是 image/png，字节其实是 JPEG：内核只认字节对应的类型与字节表里的 mediaTypes，
  // 声明错了会变成一句用户看不懂的 UNSUPPORTED_IMAGE_TYPE。
  const sent = await kernel.sendPrompt('ses_live', '', [
    { data: `data:image/jpeg;base64,${TINY_JPEG}`, mimeType: 'image/png' },
  ])
  assert.equal(sent.ok, true, sent.message ?? '')
  const content = f.calls.prompt[0]!.content as Array<Record<string, unknown>>
  assert.equal(content.length, 1, '只发图时不许塞空文本块（模型会看到一句空话）')
  assert.deepEqual(
    content[0],
    { type: 'image', mediaType: 'image/jpeg', data: TINY_JPEG },
    'data-URI 前缀必须剥掉、类型按字节判定：内核的 base64 准入要求规范 base64',
  )
})

test('非法的图片数据在进内核前就说清楚是哪一张第几张', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true, promptFace: true }))
  const bad = await kernel.sendPrompt('ses_live', '', [{ data: '这不是 base64 !!', mimeType: 'image/jpeg' }])
  assert.equal(bad.ok, false, '解不开的 base64 不该进内核（内核只会抛 INVALID_IMAGE_BASE64）')
  assert.match(bad.message ?? '', /第 1 张/, '要说清是哪一张第几张，否则用户只能反复重试')

  const bmp = await kernel.sendPrompt('ses_live', '', [
    { data: Buffer.from('BM-not-an-image').toString('base64'), mimeType: 'image/bmp' },
  ])
  assert.equal(bmp.ok, false, '内核只收 png/jpeg/webp/gif，放行 bmp 就是拿回合去换一句 UNKNOWN')
  assert.match(bmp.message ?? '', /image\/bmp/, '要说清被判成什么类型')

  assert.equal(f.calls.prompt.length, 0, '被拒的批次一条都不许进内核')
})

test('不带图的指令不许绕道命令入口：纯文本还是直接 followup', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true, promptFace: true }))
  const sent = await kernel.sendPrompt('ses_live', '只回复 ok')
  assert.equal(sent.ok, true)
  assert.equal(f.calls.prompt.length, 0, '纯文本走命令入口多绕一层，还把重试语义搞复杂')
  assert.equal(f.calls.followup.length, 1)
})
/**
 * 图片通路的探测必须进 status.json（2026-10-06 真机事故后）。
 *
 * 现场那句话「这一轮没有产出回复，内核报错（UNKNOWN）」在事故当天**无法定位**，
 * 因为 status.json 里没有任何字段能回答「这台主机到底能不能收图」。
 * 三态与 sendPrompt 的降级顺序一一对应：
 *   commands.prompt → attachments.admitPromptContent → absent(...)
 */
test('describe 里有 attachmentFace：能走哪条图片通路三态都要能说出来', () => {
  const both = fixture()
    .kernel(fixture().bundle({ promptFace: true, admitFace: true }))
    .describe() as Record<string, unknown>
  assert.equal(both.attachmentFace, 'commands.prompt', '有命令入口就该报它：那是内核的完整通路')

  const bridge = fixture()
    .kernel(fixture().bundle({ admitFace: true }))
    .describe() as Record<string, unknown>
  assert.equal(bridge.attachmentFace, 'attachments.admitPromptContent', '只有那座桥时报它')

  const none = fixture().kernel(fixture().bundle()).describe() as Record<string, unknown>
  assert.match(
    String(none.attachmentFace),
    /^absent \(commands=.*attachments=/,
    `两个面都没有时报不出来：现场就分不清"这台主机发不了图"和"我们没调对"（拿到的值：${String(none.attachmentFace)}）`,
  )
})

/**
 * 上下文占用的探测必须进 status.json（2026-10-06）。
 *
 * 判据钉的是**三态都要能说出来**，而不是「有就读到」：
 *   absent          —— 这一代没有 tokenMeter
 *   no-measure(...) —— 服务在，但没有 measure 方法（代际不符）
 *   measure ok      —— 真调一次没抛
 *
 * 为什么值得单独钉：现场拿到「mp 上没有占用」这个现象时，第一步要分清
 * 是宿主没这个能力、还是它挂错地方、还是我们没调对——三者的下一步完全不同。
 * 这就是 approvalCalls=0 那次踩过的坑（判据红了却说不清是哪一层）。
 */
test('describe 里有 contextUsageFace：占用探测的三态都要能说出来', () => {
  const described = fixture().kernel(fixture().bundle()).describe() as Record<string, unknown>
  const face = String(described.contextUsageFace)
  assert.match(
    face,
    /^(absent|no-measure|measure ok|measure threw: )/,
    `contextUsageFace 的取值不在约定内：${face}。现场看到看不懂的值就等于没这个字段`,
  )
})

/**
 * 这一代没有 tokenMeter 时必须**照常报 absent**，不能把整个载体判死。
 *
 * 依赖「可选能力缺失就降级」这条纪律：它是一个锦上添花的读数，
 * 拿不到不该让列会话、发指令、审批全挂——那才是把一个显示问题放大成停机。
 */
test('没有 tokenMeter 的那一代：describe 正常，只是脸面说 absent', () => {
  const f = fixture()
  const bundle = f.bundle()
  delete (bundle as Record<string, unknown>).tokenMeter
  const described = f.kernel(bundle).describe() as Record<string, unknown>
  assert.equal(described.contextUsageFace, 'absent', '宿主没有这一代能力时要如实说 absent')
  // 其余能力一点没受影响：载体仍然能列会话
  assert.equal(typeof described.carrier, 'string', '一个读数缺失就把整个载体拖垮了')
})
/**
 * 重试 → 手机看得见（2026-10-06）。
 *
 * 真机取证：内核 `llm/retry` 带 retry / maxRetries / failure。
 * 以前插件没映射它，手机上模型卡住时一片空白——用户以为它死了。
 *
 * 判据钉三件容易做错的事：
 *   1. 失败原因取 code 而不是 message（「Connection error.」对人没有信息量）；
 *   2. policyKey 那段策略 JSON **不许**出站；
 *   3. 没有 failure 时不编一个空原因（渲染出来是「因为：」这种半截话）。
 */
test('llm/retry → 一次重试带「第几次 / 共几次 / 什么原因」', () => {
  const events = sessionEventKernelEvents({
    sessionId: 'ses_live',
    type: 'llm/retry',
    seq: 1774,
    data: {
      retryId: 'f13bae00',
      turn: 11,
      step: 13,
      provider: 'stepfun',
      mode: 'normal',
      policyKey: '["normal",5,[...]]',
      retry: 2,
      maxRetries: 5,
      delayMs: 507.3,
      failure: { message: 'Connection error.', code: 'TRANSPORT' },
    },
  })
  assert.deepEqual(events, [{ kind: 'retry', sessionId: 'ses_live', attempt: 2, max: 5, reason: 'TRANSPORT' }])
})

test('llm/retry：没有 failure 就不给 reason（不许编一个空原因）', () => {
  const events = sessionEventKernelEvents({
    sessionId: 'ses_live',
    type: 'llm/retry',
    seq: 2,
    data: { retry: 1, maxRetries: 5 },
  })
  assert.equal(events.length, 1)
  assert.equal(
    'reason' in (events[0] as Record<string, unknown>),
    false,
    '没有失败原因却给了一个空串：手机上会渲染成「因为：」这种半截话',
  )
})

/**
 * 压缩 → 手机看得见（2026-10-06）。
 *
 * 真机取证：`compaction/start` 带 {compactionId, turn}；
 * `compaction/end` 带同样两个**外加可选 error**（见过
 * `summarization produced no text summary content`）。
 *
 * failed 与 ended 必须是两个状态：上下文已经烂掉而用户以为一切正常，
 * 比看不见更糟。
 */
test('compaction：start/end 成对，end 带 error 时是 failed 不是 ended', () => {
  const start = sessionEventKernelEvents({
    sessionId: 'ses_live',
    type: 'compaction/start',
    seq: 2170,
    data: { compactionId: '03324cec', turn: 11 },
  })
  assert.deepEqual(start, [{ kind: 'compaction', sessionId: 'ses_live', state: 'started' }])

  const ok = sessionEventKernelEvents({
    sessionId: 'ses_live',
    type: 'compaction/end',
    seq: 2171,
    data: { compactionId: '03324cec', turn: 11 },
  })
  assert.deepEqual(ok, [{ kind: 'compaction', sessionId: 'ses_live', state: 'ended' }])

  const bad = sessionEventKernelEvents({
    sessionId: 'ses_live',
    type: 'compaction/end',
    seq: 2172,
    data: { compactionId: 'd036a23e', turn: 11, error: 'summarization produced no text summary content' },
  })
  assert.equal(bad[0]?.kind, 'compaction')
  assert.equal(
    (bad[0] as { state?: string }).state,
    'failed',
    '压缩失败被当成压缩完了：上下文已经烂掉，而用户以为一切正常',
  )
})

// ── 待办要活过历史页（2026-10-06）────────────────────────────────────────
//
// 曾经的现场：`isHistoryWorthy` 只放行 delta 与 tool，`todo` 在**进历史页之前**
// 就被丢掉了。于是 `runtime.ts` 里 `historyWireItem` 的 todo 分支是死代码，
// mp 的 `_replayTodos` 恒为 undefined，顶部那颗待办条**只在页面正好开着、
// 真机又正好推来一帧实时 ev.todo 时才会出现**——打开一条已有会话就什么都没有。
//
// 而且在这个文件里，realLog fixture 从来没有 todo，todo 出现次数为 0，
// 所以整条链路上没有一条判据断言过 todo 能活过 historyPageFromLog。
// 这就是它能一直静默的原因。

function logWithTodos(): Array<{ type: string; seq: number; data: Record<string, unknown> }> {
  const log = realLog('ses_1')
  const last = log[log.length - 1]!.seq
  return [
    ...log,
    // 三条**全量**快照：内核每轮 todo 工具调用都发一整份（真机形状）
    { type: 'todo/write', seq: last + 1, data: { todos: [{ content: '读 handoff', status: 'completed' }] } },
    {
      type: 'todo/write',
      seq: last + 2,
      data: {
        todos: [
          { content: '读 handoff', status: 'completed' },
          { content: '实现落盘', status: 'in_progress' },
        ],
      },
    },
    { type: 'todo/write', seq: last + 3, data: { todos: [{ content: '实现落盘', status: 'completed' }] } },
  ]
}

const todosIn = (page: { events: KernelEvent[] }): KernelEvent[] => page.events.filter((e) => e.kind === 'todo')

test('历史：todo/write 要活过 historyPageFromLog（以前被 isHistoryWorthy 挡掉了）', () => {
  // ⚠️ `running: true` 不是可有可无的：2026-10-07 起，会话**不在跑**时历史里的
  // 待办整条被丢掉（宿主按轮清，手机不该拿上一轮的当"此刻的清单"——用户实测双端不一致）。
  // 下面这几条验的是"待办在历史里怎么被承载"，那个问题只在正在跑时存在。
  const page = historyPageFromLog({ sessionId: 'ses_1', events: logWithTodos(), limit: 100, running: true })
  assert.ok(todosIn(page).length > 0, '一条待办都没活下来 —— mp 于是永远等不到历史快照')
})

test('历史：一页只留**最后一份**待办快照（全量语义，冗余的会把正文挤出 charBudget）', () => {
  // ⚠️ `running: true` 不是可有可无的：2026-10-07 起，会话**不在跑**时历史里的
  // 待办整条被丢掉（宿主按轮清，手机不该拿上一轮的当"此刻的清单"——用户实测双端不一致）。
  // 下面这几条验的是"待办在历史里怎么被承载"，那个问题只在正在跑时存在。
  const page = historyPageFromLog({ sessionId: 'ses_1', events: logWithTodos(), limit: 100, running: true })
  const todos = todosIn(page) as Array<{ todos: Array<{ content: string }> }>
  assert.equal(todos.length, 1, '三条全量快照应当塌缩成一条')
  assert.equal(todos[0]!.todos[0]!.content, '实现落盘', '留的是最后那一份')
})

test('历史：待办不占正文的位置（正文字数一条都不能少）', () => {
  const bare = historyPageFromLog({ sessionId: 'ses_1', events: realLog('ses_1'), limit: 100 })
  const withTodo = historyPageFromLog({ sessionId: 'ses_1', events: logWithTodos(), limit: 100, running: true })
  const deltas = (page: typeof bare) => page.events.filter((e) => e.kind === 'delta').length
  assert.equal(deltas(withTodo), deltas(bare), '待办把正文挤出去了')
})

test('历史：空清单也是一份快照，照样保留（用户拍板取最后一份，内核清空后 mp 就不显示）', () => {
  const log = [...realLog('ses_1')]
  const last = log[log.length - 1]!.seq
  log.push({ type: 'todo/write', seq: last + 1, data: { todos: [{ content: 'x', status: 'pending' }] } })
  log.push({ type: 'todo/write', seq: last + 2, data: { todos: [] } })
  // ⚠️ `running: true` 不是可有可无的：2026-10-07 起，会话**不在跑**时历史里的
  // 待办整条被丢掉（宿主按轮清，手机不该拿上一轮的当"此刻的清单"——用户实测双端不一致）。
  // 下面这几条验的是"待办在历史里怎么被承载"，那个问题只在正在跑时存在。
  const page = historyPageFromLog({ sessionId: 'ses_1', events: log, limit: 100, running: true })
  const todos = todosIn(page) as Array<{ todos: unknown[] }>
  assert.equal(todos.length, 1)
  assert.equal(todos[0]!.todos.length, 0, '最后一份是空的（内核清空了清单），这就是用户拍板的语义')
})

// ── inbox：已接线，证据必须说"已接"（2026-10-06 下午）────────────────────
//
// `agent/inbox/spliced` 映射成 `{kind:'inbox'}`，HostRuntime 的 switch 里有了
// case 'inbox'（按 user role 进合帧窗口，复用 ev.message_delta）。
// 撤出映射表是接线完成前的临时状态，现在回到映射表；出站面由
// runtime.test.ts 的穷举自检盯着。

test('inbox 已接线：必须回到映射表，不再记成 unmapped', () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  kernel.subscribe(() => {})
  const fire = listeners['session/event']!
  assert.ok(fire, 'session/event 没订阅上')

  fire(
    { id: 'ses_live' },
    {
      type: 'agent/inbox/spliced',
      data: {
        target: 'next-turn',
        inserted: [{ id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '桌面发的' }] }],
      },
    },
  )

  const described = kernel.describe() as Record<string, string | undefined>
  assert.equal(
    String(described.unmappedEventTypes ?? '').includes('agent/inbox/spliced'),
    false,
    '已经接线还记成 unmapped，证据通道就又说谎了',
  )
  assert.ok(MAPPED_SESSION_EVENTS.has('agent/inbox/spliced'), '接线完成就必须回到映射表里')
})

/* ── 2026-10-06 缺陷修复：on 晚到 / 历史形状 / 提问 id 兜底 ─────────────── */

test('on 晚一步才挂上来时订阅要能补上：否则该进程内流式全黑，只有重启宿主才能恢复', () => {
  // 现场形状：`tryStart()` 在 `ctx.get('sessions', true)` 同步可得时会在任何
  // `ctx.inject` 回调之前把内核启起来，那一刻 `services.on` 还是 undefined
  // （on 要等作用域上下文那条注入回调才绑上来）。旧实现这时永久返回空退订。
  const f = fixture()
  const clock = new FakeClock()
  const services = f.bundle()
  const kernel = createServicesKernel(services, { clock, log: () => {} })
  const seen: string[] = []
  kernel.subscribe((event) => seen.push(event.kind))
  assert.ok(typeof services.on !== 'function', '夹具自检：第一次订阅时 on 还不在服务对象上（这就是真机上那个时序）')

  // 注入回调到了：on 挂上来（index.ts 的 bindScopedEvents 做的就是这一句）。
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  clock.advance(10) // 补绑窗口（0/50/250/1000ms 的第一档）

  assert.ok(
    typeof listeners['session/event'] === 'function',
    'on 从无到有之后没有补订阅：该进程内事件流全黑，而 status.json 里 hasOn 早已是 true',
  )
  listeners['session/created']?.()
  assert.deepEqual(seen, ['sessions-changed'], '补上的订阅必须是真的接上了（回调要能到 core）')
})

test('on 晚到时的补绑窗口不会留下吊住宿主的定时器：四档用光就收手', async () => {
  const f = fixture()
  const clock = new FakeClock()
  const services = f.bundle() // 这份 bundle 里永远没有 on
  const kernel = createServicesKernel(services, { clock, log: () => {} })
  const unsubscribe = kernel.subscribe(() => {})
  assert.ok(clock.pending > 0, '夹具自检：补绑窗口应当装着一次重试')
  await clock.advance(10_000)
  assert.equal(clock.pending, 0, `四档之后仍有 ${clock.pending} 个定时器：插件会吊住宿主的进程退出`)
  unsubscribe()
})

test('交互面也对 on 晚到做补绑：审批/提问卡不许因为一次时序就永远不弹', () => {
  const f = fixture()
  const clock = new FakeClock()
  const services = f.bundle()
  const kernel = createServicesKernel(services, { clock, log: () => {} })
  kernel.attachInteractionSink!({ approval: async () => 'decline', question: async () => null })
  assert.equal(
    (kernel.describe() as Record<string, unknown>).approvalFace,
    'no on()',
    '夹具自检：第一轮确实登记不上（这个字面量本身也是给现场看的那条读数）',
  )

  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  clock.advance(10)
  assert.equal(
    typeof listeners['approval/request'],
    'function',
    'on 晚到之后审批 waterfall 没有补登记：手机上永远不会有审批卡',
  )
  assert.equal(typeof listeners['user-questions/request'], 'function', '提问那条同样要补上')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).approvalFace,
    'registered',
    '补登记之后 status.json 的那条读数也要跟着变成 registered，否则排错时看不出已经好了',
  )
})

test('readSession 没回 events 数组时必须抛，不许静默回一张空页（空页是假事实）', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  services.sessionQuery = {
    // 形状变了：不是 {events: [...]}。旧实现把它当成"零条历史"，手机上是"这个会话没内容"。
    readSession: () => Promise.resolve({ session: { id: 'ses_1' }, items: [] }),
  }
  const kernel = f.kernel(services)
  await assert.rejects(
    () => kernel.readHistory!('ses_1', { limit: 10 }),
    /没回 events 数组/,
    'events 非数组却回了一张空页：用户以为这个会话没内容，而真相是我们读不懂宿主的返回',
  )
})

test('提问 id 为空串时补一个稳定值：协议是 nonEmpty，空 id 会让**整帧**被静默丢弃', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let received: { questions: Array<Record<string, unknown>> } | undefined
  kernel.attachInteractionSink!({
    approval: async () => 'decline',
    question: async (info) => {
      received = info as { questions: Array<Record<string, unknown>> }
      return { answers: [] }
    },
  })
  await listeners['user-questions/request']!(
    {
      agent: { session: { id: 'ses_live' } },
      questions: [
        { id: '', question: '第一条' },
        { id: '   ', question: '第二条' },
      ],
    },
    async () => {
      throw new Error('桌面没答')
    },
  )
  assert.ok(received, '提问没有派发到 sink')
  const ids = received.questions.map((item) => item.id)
  assert.deepEqual(ids, ['q1', 'q2'], `空 id 没有兜底：${JSON.stringify(ids)} → 整帧 question_request 会被 zod 拒掉`)
  assert.notEqual(
    parseEvPayload(
      questionRequest({ requestId: 'q_1', sessionId: 'ses_live', questions: received.questions as never }),
    ),
    null,
    '产出的整帧过不了协议解析：手机上永远不弹这张卡',
  )
})

// ── awaiting-* 会话状态（2026-10-06 接上）─────────────────────────────────
//
// 协议里 `SESSION_STATES` 一直有 awaiting-permission / awaiting-answer，
// 小程序的会话列表与「等你处理」区也只认这两个字符串；而 carrier 只产出
// archived | running | idle —— 于是那两个状态在真机上永不出现，那个区是
// "测试绿、真机空"（e2e 里是自造状态喂进去的）。数据源只有 runtime 的挂起表。

function sessionsWith(id: string, running = false): ServicesBundle {
  return {
    sessions: {
      list: () => [{ id, title: '一条', updatedAt: 1_700_000_000_000, running }],
      get: () => undefined,
    },
    agents: { get: () => ({ status: running ? 'running' : 'idle' }) },
    sessionQuery: { listSessions: () => Promise.resolve([{ header: { id, createdAt: 1_700_000_000_000 } }]) },
    agentDefaultModel: {},
    workspaceRegistry: { archivedSessionIds: [] },
  } as unknown as ServicesBundle
}

test('会话状态：挂着的审批压过"在跑" → awaiting-permission（小程序只认这个字符串）', async () => {
  const f = fixture({ pendingKindForSession: () => 'approval' })
  const kernel = f.kernel(sessionsWith('ses_a', true))
  const rows = await kernel.listSessions(50)
  assert.equal(rows[0]!.summary.state, 'awaiting-permission', `实得 ${String(rows[0]!.summary.state)}`)
  assert.equal(rows[0]!.summary.running, true, 'running 字段另说"在不在跑"，不能被状态覆盖掉')
})

test('会话状态：挂着的提问 → awaiting-answer', async () => {
  const f = fixture({ pendingKindForSession: () => 'question' })
  const kernel = f.kernel(sessionsWith('ses_q', true))
  const rows = await kernel.listSessions(50)
  assert.equal(rows[0]!.summary.state, 'awaiting-answer')
})

test('会话状态：两项都挂时审批优先（它 180s 超时，提问 300s）', async () => {
  const f = fixture({ pendingKindForSession: () => 'question' })
  const kernel = f.kernel(sessionsWith('ses_both', true))
  assert.equal((await kernel.listSessions(50))[0]!.summary.state, 'awaiting-answer')
  const g = fixture({ pendingKindForSession: () => 'approval' })
  assert.equal(
    (await g.kernel(sessionsWith('ses_both', true)).listSessions(50))[0]!.summary.state,
    'awaiting-permission',
  )
})

test('会话状态：没人等就是修复前的口径（idle / running / archived），回调没有也照常', async () => {
  const none = fixture()
  const kernel = none.kernel(sessionsWith('ses_idle'))
  assert.equal((await kernel.listSessions(50))[0]!.summary.state, 'idle')
  const running = none.kernel(sessionsWith('ses_run', true))
  assert.equal((await running.listSessions(50))[0]!.summary.state, 'running')
  // 回调抛也不能让列表坏掉：当成没人等。
  const boom = fixture({
    pendingKindForSession: () => {
      throw new Error('boom')
    },
  })
  assert.equal((await boom.kernel(sessionsWith('ses_x')).listSessions(50))[0]!.summary.state, 'idle')
})

test('runState 也报同一个状态（它与列表必须一致）', async () => {
  const f = fixture({ pendingKindForSession: () => 'approval' })
  const kernel = f.kernel(sessionsWith('ses_a', true))
  assert.equal((await kernel.runState('ses_a')).state, 'awaiting-permission')
})

test('会话摘要的 updatedAt 是**最后活动时刻**，不是创建时刻（2026-10-06 审计）', async () => {
  // `ev.session_history` / 手机会话列表一直取的是 `ListedSession.headerTime`，而那个值是
  // 内核会话头的 **createdAt**。后果有两条，且都用户可见：
  //   - mp 的 `sessionRank` 注释管它叫"最后消息时间"，于是三天前建、今天刚用过的会话
  //     排在自己分组的最下面；
  //   - `formatTime` 显示的也是创建时间，而它对今天的显示 `HH:mm`、对更早的显示日期，
  //     读起来就是"我刚用过它，却显示成三天前"。
  //
  // 主机本来就有这个信号且一直在收：任何一条 `session/event` 都经过 translateSessionEvent。
  const CREATED = 1_700_000_000_000
  const f = fixture()
  const services = f.bundle({ live: true })
  services.sessionQuery = {
    listSessions: () =>
      Promise.resolve([
        { header: { id: 'ses_old', createdAt: CREATED, cwd: '/w/p' } },
        { header: { id: 'ses_idle', createdAt: CREATED + 10_000, cwd: '/w/p' } },
      ]),
  }
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  // 自建时钟而不是用夹具那份：夹具的 FakeClock 从 0 起，记下来的"最后活动时刻"会是 0，
  // 而 `iso()` 对 0 返回 undefined —— 那正是"不要编造时刻"的既定行为，反而让这条判据测不到。
  const clock = new FakeClock()
  await clock.advance(CREATED + 60_000)
  const kernel = createServicesKernel(services, { clock, log: () => {} })
  kernel.subscribe(() => {})

  // 只在 ses_idle 上发一条事件：它"最后活动"得更晚，但**创建**得更早。
  listeners['session/event']?.(
    { id: 'ses_idle' },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '跑一下' }], role: 'user', id: 'u-1' } },
  )

  const rows = await kernel.listSessions(50)
  const idle = rows.find((r) => r.summary.id === 'ses_idle')
  assert.ok(idle, '夹具自检：列表里要有 ses_idle')
  assert.ok(idle.summary.updatedAt, '这条刚有事件，updatedAt 不该是空的')
  assert.ok(
    Date.parse(String(idle.summary.updatedAt)) > CREATED + 10_000,
    `updatedAt 仍是创建时刻（${String(idle.summary.updatedAt)} vs createdAt=${CREATED + 10_000}）：` +
      '手机会把它排成"最后消息时间"，而实际排的是创建时间',
  )

  // 没有活动的会话不能被编一个时刻出来——它是 undefined，而不是 createdAt。
  const old = rows.find((r) => r.summary.id === 'ses_old')
  assert.equal(
    old?.summary.updatedAt,
    undefined,
    '从没见过活动的会话不该凭空多一个 updatedAt：那是它**创建**的时刻，不是我们知道的事实',
  )
})

test('待办双端一致：会话没在跑时，历史里那份旧快照**不许**被当成此刻的清单补给手机', async () => {
  // 2026-10-07 用户实测：这一轮没写待办，手机上却还挂着上一轮的清单，
  // 而宿主此刻是空的——用户看到一件没在发生的事。
  //
  // 根因在 `historyPageFromLog`：它**无条件**往第一页塞一份历史里的待办快照
  // （那是 2026-10-06 为了治"重进正在跑的长会话时条子消失"加的）。
  // 而"条子消失"那种症状只在**正在跑**时才成立，所以收窄到 running 之后
  // 既一致、又不回归那条修复。
  const CREATED = 1_700_000_000_000
  const f = fixture()
  const services = f.bundle()
  services.sessionQuery = {
    readSession: () =>
      Promise.resolve({
        events: [
          { type: 'turn/start', seq: 1, data: {} },
          {
            type: 'todo/write',
            seq: 2,
            data: { todos: [{ content: '上一轮的第一件事', status: 'completed' }] },
          },
          { type: 'turn/end', seq: 3, data: {} },
          {
            type: 'user/message',
            seq: 4,
            data: { id: 'm-1', message: { role: 'user', content: [{ type: 'text', text: '这一轮' }] } },
          },
        ],
      }),
    listSessions: () => Promise.resolve([{ header: { id: 'ses_x', createdAt: CREATED, cwd: '/w' } }]),
  }
  const kernel = createServicesKernel(services, { clock: new FakeClock(), log: () => {} })

  // 会话**不在跑**（没有 running 的 agent）：手机不该拿到任何待办。
  // 这条日志里 todo/write 就落在第一页窗口内——所以要验的是"整条丢掉"，
  // 而不是"只是别补快照"（补快照那条路只管被窗口裁掉的情况）。
  const idle = await kernel.readHistory!('ses_x', { limit: 50 })
  assert.equal(
    idle.events.some((e) => e.kind === 'todo'),
    false,
    '会话不在跑却把上一轮的待办当此刻的清单补给手机了：双端不一致，用户看到一件没在发生的事',
  )
  assert.ok(idle.events.length >= 1, '夹具自检：别的内容还在——别把整页丢空')

  // 正在跑的时候**仍然要补**——那是 2026-10-06 那条修复的正当场景，
  // 收窄不能把它一起收掉（"重进一条正在跑的长会话，顶部条子直接消失"）。
  const running = historyPageFromLog({
    sessionId: 'ses_x',
    events: [
      {
        type: 'todo/write',
        seq: 2,
        data: { todos: [{ content: '正在做的事', status: 'in_progress' }] },
      },
      { type: 'turn/end', seq: 3, data: {} },
      {
        type: 'user/message',
        seq: 4,
        data: { id: 'm-1', message: { role: 'user', content: [{ type: 'text', text: 'x' }] } },
      },
    ],
    limit: 50,
    running: true,
  })
  assert.equal(
    running.events.some((e) => e.kind === 'todo'),
    true,
    '会话正在跑却没有把待办快照补给手机：收窄过头了，2026-10-06 那条症状会回来',
  )
})

// ── 归档 / 取消归档（cmd.archive_session 的落点，2026-10-07）────────────
//
// 这一段钉住三条**只有载体这一层能钉**的纪律：
// 1. **绝不传 `stopActivity`**（规范 A1/A4）——它会停掉主机上正在跑的工作；
// 2. **运行中的会话明确拒绝**，且拒绝前一次内核调用都不发；
// 3. **方向不能反**：归档走 archiveSession、取消归档走 unarchiveSession。

test('归档：调 workspaceRegistry.archiveSession，且**只传一个参数**（规范 A1/A4）', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle())
  const res = await kernel.archiveSession?.('ses_a', true)
  assert.equal(res?.ok, true, `实得 ${JSON.stringify(res)}`)
  assert.equal(f.calls.archive.length, 1, '必须调内核的 archiveSession')
  const call = f.calls.archive[0]!
  assert.equal(call.method, 'archiveSession')
  assert.equal(call.args[0], 'ses_a')
  // ⚠️ 这是本文件里最重要的一条断言。内核的签名是
  // `archiveSession(sessionId, { stopActivity })`，而 `stopActivity: true`
  // 会**停掉主机上正在跑的工作**——用户在手机上误点一下的不可逆代价。
  // 只记 id 的桩看不见多出来的第二个参数，所以上面记的是**完整实参列表**。
  assert.equal(
    call.args.length,
    1,
    `实得 ${call.args.length} 个参数：第二个就是 stopActivity，它会停掉主机上正在跑的工作（规范 A1）`,
  )
})

test('取消归档：走 unarchiveSession 而不是 archiveSession（方向不能反）', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle())
  const res = await kernel.archiveSession?.('ses_arch', false)
  assert.equal(res?.ok, true)
  assert.equal(f.calls.unarchive.length, 1, '取消归档必须走 unarchiveSession')
  assert.equal(f.calls.archive.length, 0, '反向判据：把取消归档也调 archiveSession = 用户永远拿不回那条会话')
})

test('运行中的会话：明确拒绝，且**一次内核调用都不发**', async () => {
  const f = fixture()
  const bundle = f.bundle({ live: true })
  // `agentStatus` 读的是 agent 上的 `status` 字段，而共用夹具里的 `liveAgent`
  // **没有**这个字段（它只被 `ensureRunnable` 那几条用例用到，那里不关心状态）。
  // 所以这里就地补上，而不是去改共用夹具 —— 改它会让依赖"无 status ⇒ idle"的
  // 那些用例跟着变，而那正是「判据依赖的全局状态必须归一」的另一面。
  bundle.agents = {
    ...bundle.agents,
    get: () => ({ status: 'running', followup: () => {}, steer: () => {}, cancel: () => {} }),
  } as unknown as ServicesBundle['agents']
  const kernel = f.kernel(bundle)
  const res = await kernel.archiveSession?.('ses_live', true)
  assert.equal(res?.ok, false, '运行中的会话绝不能被归档：内核会抛，而兜底传 stopActivity 就是停掉它')
  assert.match(res?.message ?? '', /正在运行/, '拒绝原因必须是人话：WorkspaceActiveSessionError 这个类名对用户毫无意义')
  assert.equal(f.calls.archive.length, 0, '拒绝之前就把归档发出去 = "说了不做"，而内核那边可能已经停了它')
  // 反向判据：非归档方向（取消归档）不受这条限制
  f.calls.archive.length = 0
  const back = await kernel.archiveSession?.('ses_live', false)
  assert.equal(back?.ok, true, '取消归档不受"运行中"限制：它不是破坏性动作')
})

test('这一代内核没有归档能力：明确拒绝并点名缺的那个方法（规范 A2）', async () => {
  const f = fixture()
  const bundle = f.bundle()
  // 真实的"更老的内核"形状：workspaceRegistry 在，但只有 unarchiveSession
  delete (bundle.workspaceRegistry as { archiveSession?: unknown }).archiveSession
  const kernel = f.kernel(bundle)
  const res = await kernel.archiveSession?.('ses_a', true)
  assert.equal(res?.ok, false, '静默成功会让用户以为归档了，而列表里那条还在')
  assert.match(res?.message ?? '', /archiveSession/, '要点名缺的那个成员：排错时不必去猜')
})

test('内核抛 WorkspaceActiveSessionError 时翻成一句人话（不是把类名甩给用户）', async () => {
  const f = fixture()
  const bundle = f.bundle()
  bundle.workspaceRegistry = {
    ...bundle.workspaceRegistry,
    archiveSession: () => Promise.reject(new Error('WorkspaceActiveSessionError: ses_a is active')),
  } as ServicesBundle['workspaceRegistry']
  const kernel = f.kernel(bundle)
  const res = await kernel.archiveSession?.('ses_a', true)
  assert.equal(res?.ok, false)
  assert.match(res?.message ?? '', /正在运行/, '必须翻成人话')
  assert.ok(
    !/WorkspaceActiveSessionError/.test(res?.message ?? ''),
    '类名会原样弹到用户手机上（core 把 message 直接 toast 出去）',
  )
})

test('内核抛别的错时也如实上报，不吞掉（不假装成功）', async () => {
  const f = fixture()
  const bundle = f.bundle()
  bundle.workspaceRegistry = {
    ...bundle.workspaceRegistry,
    archiveSession: () => Promise.reject(new Error('EACCES: permission denied')),
  } as ServicesBundle['workspaceRegistry']
  const kernel = f.kernel(bundle)
  const res = await kernel.archiveSession?.('ses_a', true)
  assert.equal(res?.ok, false)
  assert.match(res?.message ?? '', /归档会话失败/, '失败要说明是"归档"这一步失败的')
  assert.match(res?.message ?? '', /EACCES/, '底层原因要带出来：日志与用户那头都能查')
})
