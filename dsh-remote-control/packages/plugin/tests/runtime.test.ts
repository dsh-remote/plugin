/**
 * runtime.test — `core/runtime.ts` 的 HostRuntime。
 *
 * 这一层是端口-适配器分层的兑现点：它**不认识 cordis、不认识 socket**，
 * 所以审批闭环、F8 的推送义务、合帧顺序、回执对答全都能在纯内存里跑出来。
 * 旧实现做不到（它的 36 项测试全靠手写 cordis 替身，取证 docs/DESIGN.md §5.3 与
 * docs/legacy-spec/host-plugin-runtime.md §7.4——那张"没有任何测试"的清单里
 * §2.2/§2.3/§3.8/§4 四条就在这里补齐）。
 *
 * 判据编号对应 docs/DESIGN.md §2.2：F7（updatedAt 只能是 ISO 字符串）、
 * F8（列表推送义务）、F9（done 帧不可丢）、F10（decision 逐字）、F11（两个无会话归属的载荷）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CmdPayload, EvPayload, SessionSummary } from 'dsh-remote-wire'
import { PAYLOAD_TYPES } from 'dsh-remote-wire'
import { HostRuntime, type RuntimeTransport } from '../src/core/runtime.js'
import { KeepAwake } from '../src/core/sleep-policy.js'
import { FakeClock } from '../src/core/clock.js'
import type {
  ApprovalDecision,
  AskUserQuestionAnswerValue,
  InteractionSink,
  KernelEvent,
  KernelPort,
  SleepPort,
} from '../src/ports/index.js'

/** 手机看到的会话行：`updatedAt` 刻意给 ISO 字符串（F7 的合法形态）。 */
const SESSIONS: SessionSummary[] = [
  {
    id: 'ses_live',
    state: 'running',
    running: true,
    title: '在跑的会话',
    workspace: '/w/live',
    updatedAt: '2026-10-02T08:00:00.000Z',
  },
  {
    id: 'ses_arch',
    state: 'archived',
    running: false,
    title: '归档会话',
    workspace: '/w/arch',
    updatedAt: '2026-10-01T07:30:00.000Z',
  },
]

class FakeTransport implements RuntimeTransport {
  readonly replies: Array<{ conversationId: string; payload: EvPayload }> = []
  readonly broadcasts: EvPayload[] = []
  readonly voided: string[] = []
  conversations: string[] = []
  peers = new Set<string>()

  reply(conversationId: string, payload: EvPayload): boolean {
    this.replies.push({ conversationId, payload })
    return this.peers.has(conversationId)
  }

  broadcast(payload: EvPayload): number {
    this.broadcasts.push(payload)
    return this.peers.size > 0 ? this.peers.size : 0
  }

  hasPeer(conversationId: string): boolean {
    return this.peers.has(conversationId)
  }

  conversationIds(): string[] {
    return [...this.conversations]
  }

  voidConversation(conversationId: string): void {
    this.voided.push(conversationId)
  }

  /** 模拟一次配对成功：有一条通道并且有活的对端。 */
  pair(conversationId: string): void {
    this.conversations.push(conversationId)
    this.peers.add(conversationId)
  }

  ofType(type: string): EvPayload[] {
    return this.broadcasts.filter((payload) => payload.t === type)
  }

  resultReplies(): Array<Record<string, unknown>> {
    return this.replies
      .map((item) => item.payload)
      .filter((payload) => payload.t === PAYLOAD_TYPES.evResult)
      .map((payload) => payload as unknown as Record<string, unknown>)
  }
}

interface FakeKernel extends KernelPort {
  readonly events: Array<(event: KernelEvent) => void>
  sink: InteractionSink | undefined
  readonly calls: {
    listSessions: number[]
    sendPrompt: Array<{ sessionId: string; text: string }>
    interrupt: string[]
    ensureRunnable: string[]
    unsubscribes: number
  }
  failList: boolean
  throwOnSend: boolean
  rejectSendFor: string | undefined
  /** 非空时替代 SESSIONS 作为列表内容：用来证明"尾随推送带的是最新快照"。 */
  listing: SessionSummary[] | undefined
  ensureRunnableImpl: ((sessionId: string) => Promise<{ ok: boolean; message?: string }>) | undefined
  feed(event: KernelEvent): void
}

function makeKernel(): FakeKernel {
  const events: Array<(event: KernelEvent) => void> = []
  const kernel: FakeKernel = {
    carrier: 'fake',
    events,
    sink: undefined,
    calls: { listSessions: [], sendPrompt: [], interrupt: [], ensureRunnable: [], unsubscribes: 0 },
    failList: false,
    throwOnSend: false,
    rejectSendFor: undefined,
    listing: undefined,
    ensureRunnableImpl: undefined,
    async listSessions(limit: number) {
      kernel.calls.listSessions.push(limit)
      if (kernel.failList) throw new Error('内核读列表失败')
      const source = kernel.listing ?? SESSIONS
      return source.slice(0, limit).map((summary) => ({ summary, live: summary.state === 'running' }))
    },
    async runState() {
      return { running: false, state: 'idle' as const }
    },
    async sendPrompt(sessionId: string, text: string) {
      if (kernel.throwOnSend) throw new Error('内核进程里炸了')
      if (kernel.rejectSendFor === sessionId) return { ok: false, message: '会话已归档，需先恢复' }
      kernel.calls.sendPrompt.push({ sessionId, text })
      return { ok: true }
    },
    async interrupt(sessionId: string) {
      kernel.calls.interrupt.push(sessionId)
      return { ok: true }
    },
    subscribe(onEvent) {
      events.push(onEvent)
      return () => {
        kernel.calls.unsubscribes += 1
      }
    },
    attachInteractionSink(sink: InteractionSink) {
      kernel.sink = sink
      return () => {
        kernel.sink = undefined
      }
    },
    async ensureRunnable(sessionId: string) {
      kernel.calls.ensureRunnable.push(sessionId)
      if (kernel.ensureRunnableImpl) return kernel.ensureRunnableImpl(sessionId)
      return { ok: true }
    },
    describe() {
      return { carrier: 'fake' }
    },
    feed(event: KernelEvent) {
      for (const listener of events) listener(event)
    },
  }
  return kernel
}

class FakeSleepPort implements SleepPort {
  starts = 0
  stops = 0
  ok = true
  message: string | undefined
  backend(): string {
    return 'fake-caffeinate'
  }
  platform(): string {
    return 'fakeos'
  }
  start(): { ok: boolean; message?: string } {
    this.starts += 1
    return { ok: this.ok, ...(this.message === undefined ? {} : { message: this.message }) }
  }
  stop(): void {
    this.stops += 1
  }
  isActive(): boolean {
    return this.starts > this.stops
  }
}

/** 记录 runtime 对锁做了什么：挂起审批必须"有 hold 必有 release"（旧实现泄漏的那条）。 */
class SpyKeepAwake extends KeepAwake {
  readonly holdIds: string[] = []
  readonly releaseIds: string[] = []
  /** 此刻仍挂着的 id：释放是幂等的（stop 与结算点会各调一次），所以只能这样核对。 */
  readonly liveHolds = new Set<string>()
  readonly enabledCalls: Array<{ enabled: boolean; idleReleaseSec: number | undefined }> = []

  override hold(id: string): void {
    this.holdIds.push(id)
    this.liveHolds.add(id)
    super.hold(id)
  }

  override releaseHold(id: string): void {
    this.releaseIds.push(id)
    this.liveHolds.delete(id)
    super.releaseHold(id)
  }

  override setEnabled(enabled: boolean, idleReleaseSec?: number) {
    this.enabledCalls.push({ enabled, idleReleaseSec })
    return super.setEnabled(enabled, idleReleaseSec)
  }
}

interface Fixture {
  clock: FakeClock
  kernel: FakeKernel
  transport: FakeTransport
  sleep: SpyKeepAwake
  sleepPort: FakeSleepPort
  runtime: HostRuntime
  logs: string[]
}

/**
 * 组装一台"没有 cordis、没有 socket"的主机：
 * `listingRefreshMs` 默认拉到 1 小时，免得定时刷新混进断言。
 */
function fixture(options: Partial<ConstructorParameters<typeof HostRuntime>[4]> = {}): Fixture {
  const clock = new FakeClock()
  const kernel = makeKernel()
  const transport = new FakeTransport()
  const sleepPort = new FakeSleepPort()
  const sleep = new SpyKeepAwake(sleepPort, clock, { tickMs: 60_000, pendingRefreshMs: 60_000 })
  const logs: string[] = []
  const runtime = new HostRuntime(kernel, transport, sleep, clock, {
    listingRefreshMs: 3_600_000,
    approvalTimeoutMs: 5_000,
    questionTimeoutMs: 5_000,
    log: (message) => logs.push(message),
    ...options,
  })
  return { clock, kernel, transport, sleep, sleepPort, runtime, logs }
}

/** 把 async 桩里的 Promise 链跑完（handleCommand 与 pushSessions 都是纯微任务）。 */
async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function cmd(t: string, extra: Record<string, unknown>): CmdPayload {
  return { t, cmdId: `cmd_${t}`, ...extra } as unknown as CmdPayload
}

test('cmd.list_sessions 必须额外推一条 ev.session_changed：ev.result.data.sessions 手机根本不看（F8）', async () => {
  const { runtime, transport, kernel } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_000000000001')
  transport.broadcasts.length = 0

  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdListSessions, {}), 'c_000000000001')
  await settle()

  const changed = transport.ofType(PAYLOAD_TYPES.evSessionChanged)
  assert.ok(changed.length >= 1, '只回了 ev.result 就完了 → 手机 sessions.js 从 ev.session_changed 取数，列表永远空白')
  const payload = changed[0] as Extract<EvPayload, { t: 'ev.session_changed' }>
  assert.equal(payload.sessions.length, 2, 'session_changed 必须是全量快照（增量手机不会合并）')
  assert.equal(payload.sessions[0]?.id, 'ses_live', 'sessions[].id 必须与载荷里的 sessionId 同名同值（F3/F11）')

  const results = transport.resultReplies()
  assert.ok(results.length >= 1, 'cmd 必须回执，否则手机等到自己超时')
  assert.equal(
    results[0]?.cmdId,
    `cmd_${PAYLOAD_TYPES.cmdListSessions}`,
    'cmdId 不回原值 → 手机认不出这是哪条命令的回执',
  )
  assert.equal(results[0]?.ok, true)
  assert.deepEqual(results[0]?.data, { sessions: SESSIONS }, '回执里仍要带 data.sessions（e2e 读它，且旧实现如此）')
  assert.ok(kernel.calls.listSessions.length >= 1, '列表必须真的去内核取过，不是拿缓存糊弄')
})

test('session_changed 里的 updatedAt 只能是 ISO 字符串：给数字会让手机整页渲染抛错并被静默吞掉（F7）', async () => {
  const { runtime, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_000000000001')
  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdListSessions, {}), 'c_000000000001')
  await settle()

  const changed = transport.ofType(PAYLOAD_TYPES.evSessionChanged)[0] as Extract<EvPayload, { t: 'ev.session_changed' }>
  assert.ok(changed.sessions.length >= 2, '快照至少要有两行才谈得上字段形状')
  for (const session of changed.sessions) {
    if (session.updatedAt === undefined) continue // 缺省是合法的：手机不显示时间角标
    assert.equal(
      typeof session.updatedAt,
      'string',
      `updatedAt=${String(session.updatedAt)}（类型 ${typeof session.updatedAt}）→ 手机 sessions.js:138 调 .slice(11,19) 抛错`,
    )
    assert.match(String(session.updatedAt), /^\d{4}-\d{2}-\d{2}T/, '必须是 ISO-8601 文本，手机按字符串切时间')
    assert.equal(Number.isNaN(Date.parse(String(session.updatedAt))), false, 'Date.parse 认不出来的字符串同样是抛错')
    assert.ok(
      ['idle', 'running', 'detached', 'archived', 'awaiting-permission', 'awaiting-answer'].includes(
        String(session.state),
      ),
      `state=${String(session.state)} 不在枚举里 → 手机徽标退化成"空闲"，归档会话看着像正常会话`,
    )
  }
})

test('ev.session_changed 与 ev.keep_awake_state 的产物里不许存在 sessionId 键（F11）', async () => {
  const { runtime, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_000000000001')
  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdKeepAwake, { enabled: true }), 'c_000000000001')
  await settle()

  const pairs: Array<[EvPayload, string]> = [
    [transport.ofType(PAYLOAD_TYPES.evSessionChanged)[0] as EvPayload, 'ev.session_changed'],
    [transport.ofType(PAYLOAD_TYPES.evKeepAwakeState)[0] as EvPayload, 'ev.keep_awake_state'],
  ]
  for (const [payload, name] of pairs) {
    assert.ok(payload !== undefined, `${name} 根本没发出去 → 手机开关/列表停在默认态`)
    assert.equal('sessionId' in payload, false, `${name} 带了 sessionId → 聊天页按"别的会话"把它整条丢掉`)
    assert.equal(
      Array.prototype.includes.call(Object.keys(payload), 'sessionId'),
      false,
      `${name} 的键集合里出现了 sessionId`,
    )
  }
})

test('有对端时审批推 ev.permission_request：requestId 与 options[].id 逐字回传，reject 这个词不能改（F10）', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_aaaaaaaaaaaa')

  const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash rm -rf', reason: '要删东西' })
  assert.notEqual(kernelSide, undefined, '审批请求没走 InteractionSink → 手机上根本没有审批卡')
  await settle()

  const request = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evPermissionRequest)
  assert.ok(request !== undefined, '没有对端时也该有回退路径；有对端时必须推 ev.permission_request')
  assert.equal(request?.t, PAYLOAD_TYPES.evPermissionRequest)
  const card = request as Extract<EvPayload, { t: 'ev.permission_request' }>
  assert.equal(card.sessionId, 'ses_live', '载荷里的 sessionId 必须是 DSH 会话 id（填错 id → 整页无输出）')
  assert.equal(card.action, 'bash rm -rf')
  assert.equal(card.reason, '要删东西')
  assert.ok(
    typeof card.requestId === 'string' && card.requestId.length > 0,
    'requestId 缺失 → 卡片能显示但审批无效（主机认不出请求）',
  )
  assert.deepEqual(
    card.options,
    [
      { id: 'approve', label: '允许一次' },
      { id: 'reject', label: '拒绝' },
    ],
    "options[].id 是手机逐字回传的值；把 'reject' 改名 → 点拒绝后界面仍显示运行中",
  )

  // 手机逐字回传我们下发的 id。
  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdResolvePermission, { sessionId: 'ses_live', requestId: card.requestId, decision: 'reject' }),
    'c_aaaaaaaaaaaa',
  )
  const decision: ApprovalDecision | undefined = await kernelSide
  assert.equal(decision, 'rejected', "decision 'reject' 必须折成平台词汇 'rejected'")
  assert.equal(
    transport.replies.filter((item) => item.payload.t === PAYLOAD_TYPES.evResult).length >= 1,
    true,
    'resolve_permission 也必须回执',
  )
})

test('审批选 approve 时折成 allowed-once：手机回的是 id，不是 label', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_bbbbbbbbbbbb')
  const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'write file' })
  await settle()
  const card = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evPermissionRequest) as Extract<
    EvPayload,
    { t: 'ev.permission_request' }
  >
  assert.ok(card !== undefined, '没推出审批卡')

  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdResolvePermission, { sessionId: 'ses_live', requestId: card.requestId, decision: 'approve' }),
    'c_bbbbbbbbbbbb',
  )
  assert.equal(
    await kernelSide,
    'allowed-once',
    "'approve' 必须放行一次；返回别的值的话平台的 outcome 校验会把它当成拒绝",
  )
})

test('一次审批的 requestId 是一次性的：重复/迟到的答案被丢弃且不许崩（M4）', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_cccccccccccc')
  const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash' })
  await settle()
  const card = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evPermissionRequest) as Extract<
    EvPayload,
    { t: 'ev.permission_request' }
  >
  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdResolvePermission, { sessionId: 'ses_live', requestId: card.requestId, decision: 'approve' }),
    'c_cccccccccccc',
  )
  assert.equal(await kernelSide, 'allowed-once')

  // 手机重发（回前台补发）与一个根本不存在的 requestId。
  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdResolvePermission, { sessionId: 'ses_live', requestId: card.requestId, decision: 'reject' }),
    'c_cccccccccccc',
  )
  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdResolvePermission, { sessionId: 'ses_live', requestId: 'ap_不存在', decision: 'approve' }),
    'c_cccccccccccc',
  )
  await settle()

  const results = transport.resultReplies()
  assert.ok(results.length >= 3, `三条 resolve_permission 只回了 ${results.length} 条 → 手机 UI 挂在"提交中"`)
  assert.equal(results[1]?.ok, false, '重复的 requestId 必须回 ok:false（静默 ok:true 会让手机以为又一次审批成功了）')
  assert.equal(results[2]?.ok, false, '未知 requestId 必须回 ok:false')
  assert.equal(typeof results[2]?.message, 'string', 'ok:false 要带可读 message，手机 toast 前 40 字')
})

test('此刻没有已配对的手机时审批返回 decline，把决定权交还桌面 UI，且不推卡片', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  assert.equal(transport.conversations.length, 0, '夹具自检：此刻确实没有对端')

  const decision = await kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash' })
  assert.equal(decision, 'decline', '没对端时必须 decline（适配器据此调平台的 next()）；替用户决定=越权')
  assert.equal(
    transport.replies.filter((item) => item.payload.t === PAYLOAD_TYPES.evPermissionRequest).length,
    0,
    '没对端还推卡片=白发（也没人收）',
  )
})

test('审批超时返回 decline 并配对释放锁：手机迟迟不点时不该替用户决定', async () => {
  const { runtime, kernel, transport, clock, sleep } = fixture({ approvalTimeoutMs: 1_000 })
  runtime.start()
  await settle()
  transport.pair('c_dddddddddddd')
  const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash' })
  await settle()
  const card = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evPermissionRequest) as Extract<
    EvPayload,
    { t: 'ev.permission_request' }
  >
  assert.ok(sleep.holdIds.includes(card.requestId), '挂起审批必须 hold 住锁，否则用户还没决定笔记本先睡了')

  await clock.advance(1_001)
  assert.equal(await kernelSide, 'decline', '超时该 decline（交还桌面），而不是自行 allowed-once')
  assert.equal(
    sleep.liveHolds.size,
    0,
    `超时的审批没释放挂锁：还挂着 ${JSON.stringify([...sleep.liveHolds])} → 旧实现正是这样泄漏的`,
  )
})

test('手机平台撤销审批（AbortSignal）时结论是 cancelled，并且同样释放挂锁', async () => {
  const { runtime, kernel, transport, sleep } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_eeeeeeeeeeee')
  const controller = new AbortController()
  const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash', signal: controller.signal })
  await settle()
  controller.abort()
  assert.equal(await kernelSide, 'cancelled', '平台撤销必须转成 cancelled，不能继续挂着')
  assert.equal(sleep.liveHolds.size, 0, '撤销路径也必须释放挂锁（hold 与 release 一一对应）')
})

test('stop() 结算所有挂起交互：返回 decline 并释放每一次挂锁', async () => {
  const { runtime, kernel, transport, sleep } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffffff01')
  const first = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash 1' })
  const second = kernel.sink?.approval({ sessionId: 'ses_arch', action: 'bash 2' })
  await settle()
  assert.ok(sleep.holdIds.length >= 2, `两次审批应各挂一次锁，实际 ${sleep.holdIds.length} 次`)

  runtime.stop()
  assert.equal(await first, 'decline', '停机时挂着的审批必须立刻结算，不能让平台的 waterfall 永远等下去')
  assert.equal(await second, 'decline')
  assert.equal(sleep.liveHolds.size, 0, `停机后仍有挂锁未释放：还挂着 ${JSON.stringify([...sleep.liveHolds])}`)
})

test('cmd.answer 把手机回传的 id 反查成平台要的 label：映射错 = 桌面端解不出选项', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff02')
  const questions = [
    {
      id: 'q_env',
      question: '在哪个环境跑？',
      options: [
        { id: 'opt_prod', label: '生产' },
        { id: 'opt_test', label: '测试' },
      ],
    },
    {
      id: 'q_mode',
      question: '要不要覆盖？',
      multi: true,
      options: [
        { id: 'opt_yes', label: '覆盖' },
        { id: 'opt_no', label: '不覆盖' },
      ],
    },
  ]
  const kernelSide = kernel.sink?.question({ sessionId: 'ses_live', questions })
  await settle()
  const card = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evQuestionRequest) as Extract<
    EvPayload,
    { t: 'ev.question_request' }
  >
  assert.ok(card !== undefined, '提问卡没推给手机 → 桌面 UI 等着，手机看不见')
  assert.deepEqual(card.questions, questions, 'questions[].id/question/options[].id 必须逐字下发：手机把它原样回传')

  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdAnswer, {
      sessionId: 'ses_live',
      requestId: card.requestId,
      answers: [
        { questionId: 'q_env', selected: ['opt_prod'] },
        { questionId: 'q_mode', selected: ['opt_yes', 'opt_no'], freeText: '只今天一次' },
      ],
    }),
    'c_ffffffff02',
  )
  const answer: AskUserQuestionAnswerValue | null | undefined = await kernelSide
  assert.ok(answer !== null && answer !== undefined, '答案不能折成 null（提问服务没有 next 可交还，null=明确失败）')
  assert.equal(answer.answers.length, 2, '答案条数必须与问题条数一致（顺序同 questions）')
  assert.equal(answer.answers[0]?.id, 'q_env', 'answers[].id 是 questionId：平台靠它对号入座')
  assert.deepEqual(answer.answers[0]?.selected, ['生产'], 'selected 必须是**选项 label**：给 id 的话平台侧找不到选项')
  assert.deepEqual(
    answer.answers[1]?.selected,
    ['覆盖', '不覆盖'],
    '多选的每个 id 都要各自反查成 label，且保持手机给的顺序',
  )
  assert.equal(answer.answers[1]?.custom, '只今天一次', 'freeText 是整卡共享的，折成 custom 交给平台')

  const results = transport.resultReplies()
  assert.ok(results.length >= 1, 'cmd.answer 必须回执')
  assert.equal((results[results.length - 1]?.data as Record<string, unknown> | undefined)?.answered, card.requestId)
})

test('提问没人应答时返回 null（适配器必须转成明确失败，绝不静默挂住 agent）', async () => {
  const { runtime, kernel, clock } = fixture({ questionTimeoutMs: 1_000 })
  runtime.start()
  await settle()
  assert.equal(runtime.handleCommand !== undefined, true, '夹具自检：runtime 已起')
  const kernelSide = kernel.sink?.question({ sessionId: 'ses_live', questions: [{ id: 'q1', question: '跑哪个？' }] })
  assert.notEqual(kernelSide, undefined, '提问必须走 InteractionSink')
  const answer = await kernelSide
  assert.equal(answer, null, '此刻没有已配对的手机：提问必须是明确失败（null），不能挂住 agent，也不能替用户答')
  await clock.advance(0)
})

test('提问超时同样返回 null，并且释放挂锁', async () => {
  const { runtime, kernel, transport, sleep, clock } = fixture({ questionTimeoutMs: 1_000 })
  runtime.start()
  await settle()
  transport.pair('c_ffffffff03')
  const kernelSide = kernel.sink?.question({ sessionId: 'ses_live', questions: [{ id: 'q1', question: '跑哪个？' }] })
  await settle()
  assert.equal(sleep.holdIds.length >= 1, true, '挂起的提问同样要 hold 锁')
  await clock.advance(1_001)
  assert.equal(await kernelSide, null, '超时=没人应答，必须明确失败')
  assert.equal(sleep.liveHolds.size, 0, '提问超时也要释放挂锁')
})

test('cmd.keep_awake 关掉时不带 idleReleaseSec：带了就会覆盖用户设定的空闲阈值', async () => {
  const { runtime, transport, sleep } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff04')

  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdKeepAwake, { enabled: true, idleReleaseSec: 0 }), 'c_ffffffff04')
  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdKeepAwake, { enabled: false }), 'c_ffffffff04')
  await settle()

  assert.deepEqual(
    sleep.enabledCalls,
    [
      { enabled: true, idleReleaseSec: 0 },
      { enabled: false, idleReleaseSec: undefined },
    ],
    '关闭时手机不带这个字段，runtime 也不许凭空造一个（0 会被当成"永不自动释放"）',
  )

  const states = transport.ofType(PAYLOAD_TYPES.evKeepAwakeState)
  assert.ok(states.length >= 2, `keep_awake 状态只推了 ${states.length} 条 → 手机开关回显错误`)
  const last = states[states.length - 1] as Extract<EvPayload, { t: 'ev.keep_awake_state' }>
  assert.equal(last.enabled, false, '关掉后广播的快照必须回显 enabled:false')
  assert.equal(typeof last.platform, 'string', 'platform 是 e2e 断言字段，缺了这些测试会红')
  assert.equal(typeof last.backend, 'string', 'backend 名字要在：它区分"没锁"与"锁不了"')

  const results = transport.resultReplies()
  assert.ok(results.length >= 2, '两条 keep_awake 命令都要回执')
  assert.equal(results[results.length - 1]?.cmdId, `cmd_${PAYLOAD_TYPES.cmdKeepAwake}`, 'cmdId 必须原样回传')
})

test('命令异常必须回 ev.result{ok:false} 且 cmdId 原样：回执对答靠它，漏发就静默卡住', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff05')
  kernel.throwOnSend = true

  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdSendPrompt, { sessionId: 'ses_live', text: '你好' }), 'c_ffffffff05')
  const results = transport.resultReplies()
  assert.ok(results.length >= 1, '内核抛异常时一条回执都没有 → 手机输入框永久禁用，等到自己超时')
  assert.equal(
    results[0]?.cmdId,
    `cmd_${PAYLOAD_TYPES.cmdSendPrompt}`,
    '异常兜底的 cmdId 也必须回原值（回错了手机匹配不到）',
  )
  assert.equal(results[0]?.ok, false, '异常必须是 ok:false')
  assert.match(String(results[0]?.message), /内核进程里炸了/, 'message 要带上底层原因，手机 toast 只显示前 40 字')

  // 业务失败（不是异常）同样回 ok:false + message，而且指令没有真的进内核。
  kernel.throwOnSend = false
  kernel.rejectSendFor = 'ses_arch'
  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdSendPrompt, { sessionId: 'ses_arch', text: 'x' }), 'c_ffffffff05')
  await settle()
  const results2 = transport.resultReplies()
  assert.ok(results2.length >= 2, `业务失败没回执（只有 ${results2.length} 条）→ 手机以为指令发出去了`)
  const biz = results2.at(-1)
  assert.equal(biz?.cmdId, `cmd_${PAYLOAD_TYPES.cmdSendPrompt}`, '回执必须回原 cmdId：手机按 id 查表，查不到就丢弃')
  assert.equal(
    biz?.ok,
    false,
    'ok:false 有两种来源（业务拒绝/主机异常），手机文案层要按 message 渲染，不能一律当成网络错误',
  )
  assert.match(String(biz?.message), /需先恢复/, '业务拒绝要带具体 message')
})

test('回执之后的会话状态变化必须额外推 session_changed：发指令/中断/审批都是（F8）', async () => {
  const { runtime, transport, clock } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff06')

  for (const [type, extra] of [
    [PAYLOAD_TYPES.cmdSendPrompt, { sessionId: 'ses_live', text: '跑一下' }],
    [PAYLOAD_TYPES.cmdInterrupt, { sessionId: 'ses_live' }],
    [PAYLOAD_TYPES.cmdListSessions, {}],
  ] as Array<[string, Record<string, unknown>]>) {
    await clock.advance(600) // 越过相邻推送的合并窗口（500ms），见 pushSessions
    transport.broadcasts.length = 0
    await runtime.handleCommand(cmd(type, extra), 'c_ffffffff06')
    await settle()
    const changed = transport.ofType(PAYLOAD_TYPES.evSessionChanged)
    assert.ok(changed.length >= 1, `${type} 之后没有推 ev.session_changed → 手机列表停在旧状态，最长等 15 秒`)
    const reason = (changed[0] as Extract<EvPayload, { t: 'ev.session_changed' }>).reason
    assert.equal(typeof reason, 'string', 'session_changed 要带 reason，排错时区分是谁触发的推送')
  }
})

test('相邻 500ms 内的重复列表推送被合并（全量快照，合并中间几次不丢信息）', async () => {
  const { runtime, kernel, clock, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff07')
  await clock.advance(1_000)
  transport.broadcasts.length = 0

  kernel.feed({ kind: 'sessions-changed', reason: 'a' })
  await settle()
  kernel.feed({ kind: 'sessions-changed', reason: 'b' })
  await settle()

  const changed = transport.ofType(PAYLOAD_TYPES.evSessionChanged)
  assert.ok(changed.length >= 1, '第一次推送必须出去')
  assert.equal(
    changed.length,
    1,
    `同一次 500ms 内推了 ${changed.length} 条全量列表：合并规则没生效，吵闹的内核会把帧率打满`,
  )
  await clock.advance(1_000)
  kernel.feed({ kind: 'sessions-changed', reason: 'c' })
  await settle()
  assert.equal(
    transport.ofType(PAYLOAD_TYPES.evSessionChanged).length >= 2,
    true,
    '过了合并窗口就该再推：否则最后一次变化永远丢了',
  )
})

test('被合并掉的那一次必须变成尾随推送补发：合并 ≠ 丢弃（F8 的最后一环）', async () => {
  const { runtime, kernel, clock, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff09')
  await clock.advance(1_000)
  transport.broadcasts.length = 0

  kernel.feed({ kind: 'sessions-changed', reason: 'a' })
  await settle()
  // 第二次的列表内容与第一次不同：只有这样才分得出"补发的是新快照"还是"根本没补发"。
  kernel.listing = [
    {
      id: 'ses_new',
      state: 'idle',
      running: false,
      title: '刚结束的那次',
      workspace: '/w/new',
      updatedAt: '2026-10-02T09:00:00.000Z',
    },
  ]
  kernel.feed({ kind: 'sessions-changed', reason: 'b' })
  await settle()

  const during = transport.ofType(PAYLOAD_TYPES.evSessionChanged)
  assert.equal(during.length, 1, `窗口内出了 ${during.length} 条：合并没有生效`)
  assert.ok(JSON.stringify(during[0]).includes('在跑的会话'), '第一条应该是合并前的快照')

  await clock.advance(600) // 越过合并窗口
  const after = transport.ofType(PAYLOAD_TYPES.evSessionChanged)
  assert.equal(
    after.length,
    2,
    `尾随推送没补发（总共 ${after.length} 条）：最后那次变化永远没人告知手机，列表停在旧状态直到 15 秒兜底刷新`,
  )
  assert.ok(JSON.stringify(after[1]).includes('刚结束的那次'), '补发必须是**最新**快照，不是合并时刻那份旧数据')

  // 补发过一次就收手：定时器不许自我续期成"每 500ms 广播一次全量列表"。
  await clock.advance(5_000)
  assert.equal(
    transport.ofType(PAYLOAD_TYPES.evSessionChanged).length,
    2,
    '尾随推送之后又凭空多推：合并窗口变成了周期性广播',
  )
})

test('stop() 之后尾随推送不许再发：拆了 socket 就不能再往中继写东西', async () => {
  const { runtime, kernel, clock, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff10')
  await clock.advance(1_000)

  kernel.feed({ kind: 'sessions-changed', reason: 'a' })
  await settle()
  kernel.feed({ kind: 'sessions-changed', reason: 'b' }) // 这条被合并 → 装了尾随定时器
  await settle()
  transport.broadcasts.length = 0

  runtime.stop()
  await clock.advance(5_000)
  assert.equal(
    transport.ofType(PAYLOAD_TYPES.evSessionChanged).length,
    0,
    '停机后尾随定时器还在广播：中继那边 socket 已经关了',
  )
})

test('一条带正文的 done 必须把正文带上（内核没有 token 级增量：正文与 done 同到）', async () => {
  // 真机取证：`assistant/message` 是"一条消息一帧完整文本 + done"，而第一版只走 complete()，
  // complete 对缓冲区里没有这条消息的情形发的是 done-only 帧 → 回复被整个丢掉，
  // 手机上"⑧ 流式输出到达 / ⑨ 有 done"两条断言照样绿，屏幕上一个字都没有。
  const { runtime, kernel, transport, clock } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_vtext01')
  await clock.advance(1_000)
  transport.broadcasts.length = 0

  kernel.feed({
    kind: 'delta',
    sessionId: 'ses_live',
    messageId: 'msg_v',
    text: '当前有 0 个提醒。',
    role: 'assistant',
    done: true,
  })
  await clock.advance(200)
  await settle()

  const frames = transport.broadcasts.filter((payload) => payload.t === PAYLOAD_TYPES.evMessageDelta)
  assert.equal(frames.length, 1, `正文与 done 被拆成了 ${frames.length} 帧（应为 1 帧合并）或整条被吞`)
  const only = frames[0] as Extract<EvPayload, { t: 'ev.message_delta' }>
  assert.equal(only.delta, '当前有 0 个提醒。', '回复文本丢了：手机上就是一个字都没有的空消息')
  assert.equal(only.done, true, 'done 必须同帧到达')
  assert.equal(only.messageId, 'msg_v')
  assert.equal(only.role, 'assistant')
})

test('非 delta 事件之前先 flush 同会话缓冲：出站类型序列必须严格是 message_delta → tool_event → message_delta（F9）', async () => {
  const { runtime, kernel, transport, clock } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff08')
  await clock.advance(1_000)
  transport.broadcasts.length = 0

  kernel.feed({ kind: 'delta', sessionId: 'ses_live', messageId: 'msg_1', text: '我先说明一下', done: false })
  kernel.feed({ kind: 'tool', sessionId: 'ses_live', callId: 'call_1', phase: 'started', tool: 'bash', title: 'echo' })
  kernel.feed({ kind: 'delta', sessionId: 'ses_live', messageId: 'msg_1', text: '然后是补充', done: false })
  kernel.feed({ kind: 'delta', sessionId: 'ses_live', messageId: 'msg_1', text: '', done: true })
  await settle()

  const types = transport.broadcasts.map((payload) => payload.t)
  assert.deepEqual(
    types,
    [PAYLOAD_TYPES.evMessageDelta, PAYLOAD_TYPES.evToolEvent, PAYLOAD_TYPES.evMessageDelta],
    `出站顺序是 ${JSON.stringify(types)}：工具行插到了它自己的文本前面 → 手机先看到工具调用、后看到调用前的说明`,
  )
  const texts = transport
    .ofType(PAYLOAD_TYPES.evMessageDelta)
    .map((payload) => (payload as Extract<EvPayload, { t: 'ev.message_delta' }>).delta)
  assert.deepEqual(texts, ['我先说明一下', '然后是补充'], '文本必须按到达顺序分段出去，一个字符都不能少')
  const last = transport.ofType(PAYLOAD_TYPES.evMessageDelta).at(-1) as Extract<EvPayload, { t: 'ev.message_delta' }>
  assert.equal(last.done, true, '收尾的 done 帧不许丢：丢了手机永远转圈')
  assert.equal(last.messageId, 'msg_1', '同一条消息切帧不许换 messageId')
})

test('空文本的 done 帧穿过 runtime 也绝不丢（F9 在事件入口这一侧）', async () => {
  const { runtime, kernel, transport, clock } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff09')
  await clock.advance(1_000)
  transport.broadcasts.length = 0

  // 内核 turn/end 的真实形状：先一条没产生任何文本的 done（纯工具轮次），再 ev.run_state。
  kernel.feed({ kind: 'delta', sessionId: 'ses_live', messageId: 'turn', text: '', done: true })
  await settle()
  const deltas = transport.ofType(PAYLOAD_TYPES.evMessageDelta)
  assert.ok(deltas.length >= 1, 'done-only 帧在 runtime 入口就被丢了 → 手机为这一条消息一直转圈')
  const frame = deltas[0] as Extract<EvPayload, { t: 'ev.message_delta' }>
  assert.equal(frame.done, true)
  assert.equal(frame.delta, '', "delta 必须是空串：手机对 undefined 做 += 会拼出字面量 'undefined'")
  assert.equal(frame.messageId, 'turn', 'messageId 逐字回传（手机用它定位消息行）')
})

test('run-state 事件必须先 flush 缓冲再推 ev.run_state，并额外推一次会话列表（F8/F9）', async () => {
  const { runtime, kernel, transport, clock } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff0a')
  await clock.advance(1_000)
  transport.broadcasts.length = 0

  kernel.feed({ kind: 'delta', sessionId: 'ses_live', messageId: 'msg_1', text: '半句', done: false })
  kernel.feed({ kind: 'run-state', sessionId: 'ses_live', state: 'idle', detail: 'completed' })
  await settle()

  const types = transport.broadcasts.map((payload) => payload.t)
  assert.deepEqual(
    types,
    [
      PAYLOAD_TYPES.evMessageDelta,
      PAYLOAD_TYPES.evRunState,
      PAYLOAD_TYPES.evSessionChanged,
      PAYLOAD_TYPES.evKeepAwakeState,
    ],
    `实际出站序列 ${JSON.stringify(types)}：run_state 之前必须先把同会话的文本冲出去，之后补一次列表与锁状态`,
  )
  const runState = transport.ofType(PAYLOAD_TYPES.evRunState)[0] as Extract<EvPayload, { t: 'ev.run_state' }>
  assert.equal(runState.state, 'idle', "run_state 只有 'running'/'idle' 会让手机收起挂着的卡片")
  assert.equal(runState.detail, 'completed', 'detail 是 UI 不读、测试断言的字段')
  assert.equal(runState.sessionId, 'ses_live', '载荷里的 sessionId 必须是 DSH 会话 id（F3）')
})

test('title 与 sessions-changed 事件都要推列表：手机上标题/归档标记的唯一来源（F7/F8）', async () => {
  const { runtime, kernel, transport, clock } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff0b')

  await clock.advance(1_000)
  transport.broadcasts.length = 0
  kernel.feed({ kind: 'title', sessionId: 'ses_live', title: '新标题' })
  await settle()
  assert.ok(transport.ofType(PAYLOAD_TYPES.evSessionChanged).length >= 1, '改标题不推列表 → 手机列表上的标题永远是旧的')

  await clock.advance(1_000)
  transport.broadcasts.length = 0
  kernel.feed({ kind: 'sessions-changed', reason: 'created' })
  await settle()
  const changed = transport.ofType(PAYLOAD_TYPES.evSessionChanged)[0] as Extract<EvPayload, { t: 'ev.session_changed' }>
  assert.equal(changed.reason, 'created', '内核给的原因要透出来，排错时才知道是谁推的')
  assert.equal(changed.sessions.length, 2, '会话新建后推的必须是全量快照')
})

test('内核读列表失败时不许把手机上的列表清成空白：保留上一次已知的快照（M25）', async () => {
  const { runtime, kernel, transport, clock, logs } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff0c')
  await clock.advance(1_000)
  const good = transport.ofType(PAYLOAD_TYPES.evSessionChanged).at(-1) as Extract<
    EvPayload,
    { t: 'ev.session_changed' }
  >
  assert.equal(good.sessions.length, 2, '夹具自检：先拿到一份非空列表')

  kernel.failList = true
  await clock.advance(1_000)
  transport.broadcasts.length = 0
  kernel.feed({ kind: 'sessions-changed', reason: '抖动' })
  await settle()

  const after = transport.ofType(PAYLOAD_TYPES.evSessionChanged).at(-1) as Extract<
    EvPayload,
    { t: 'ev.session_changed' } | undefined
  >
  assert.ok(after !== undefined, '读失败也不能一条都不发：手机至少要看得到锁状态那一侧')
  assert.equal(after.sessions.length, 2, '内核抖一次就广播空列表 → 手机上的会话列表被清空，比"这一轮没更新"糟得多')
  assert.ok(
    logs.some((line) => line === 'list sessions failed'),
    '失败要留痕：否则"列表为什么没更新"没有答案',
  )
})

test('start() 时内核订阅失败只能降级，绝不向外抛（apply() 的红线：插件不许带崩宿主）', async () => {
  const clock = new FakeClock()
  const transport = new FakeTransport()
  const sleepPort = new FakeSleepPort()
  const sleep = new KeepAwake(sleepPort, clock)
  const broken: KernelPort = {
    carrier: 'broken',
    async listSessions() {
      throw new Error('没有这个服务')
    },
    async runState() {
      return { running: false, state: 'idle' }
    },
    async sendPrompt() {
      return { ok: false, message: '没接上' }
    },
    async interrupt() {
      return { ok: false, message: '没接上' }
    },
    subscribe() {
      throw new Error('on() 炸了')
    },
    describe() {
      return { carrier: 'broken' }
    },
  }
  const logs: string[] = []
  const runtime = new HostRuntime(broken, transport, sleep, clock, {
    listingRefreshMs: 3_600_000,
    log: (m) => logs.push(m),
  })
  assert.doesNotThrow(() => {
    runtime.start()
  }, '内核面缺失时 start() 抛了出去 → 用户的 DSH 进程起不来')
  await settle()
  assert.ok(
    logs.some((line) => line === 'kernel subscribe failed'),
    '订阅失败要留痕，不能静默',
  )
  runtime.stop()
})

test('stop() 先把缓冲里的尾句挤出去，再退订：顺序反了尾句就永久丢失（M24）', async () => {
  const { runtime, kernel, transport, clock } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff0d')
  await clock.advance(1_000)
  transport.broadcasts.length = 0

  kernel.feed({ kind: 'delta', sessionId: 'ses_live', messageId: 'msg_last', text: '尾句', done: false })
  assert.equal(transport.ofType(PAYLOAD_TYPES.evMessageDelta).length, 0, '夹具自检：尾句还在 120ms 窗口里')
  runtime.stop()

  const tail = transport.ofType(PAYLOAD_TYPES.evMessageDelta)
  assert.ok(tail.length >= 1, '停机没把缓冲冲出去 → 用户最后看到的那段输出直接蒸发')
  assert.equal((tail[0] as Extract<EvPayload, { t: 'ev.message_delta' }>).delta, '尾句')
  assert.ok(tail[0] !== undefined && 'done' in tail[0] === false, '停机不是消息收尾，不许伪造 done')
})

test('归档会话发指令前自动恢复：ensureRunnable 必须先于 sendPrompt，且这个行为可以关掉', async () => {
  const auto = fixture()
  auto.runtime.start()
  await settle()
  auto.transport.pair('c_ffffffff0e')
  await auto.runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdSendPrompt, { sessionId: 'ses_arch', text: '继续' }),
    'c_ffffffff0e',
  )
  assert.deepEqual(
    auto.kernel.calls.ensureRunnable,
    ['ses_arch'],
    '没先恢复归档会话就发指令 → 宿主 gate 直接拒掉，手机只看到一个看不懂的失败',
  )
  assert.deepEqual(
    auto.kernel.calls.sendPrompt,
    [{ sessionId: 'ses_arch', text: '继续' }],
    '恢复之后必须真的把指令送进去',
  )

  const off = fixture({ unarchiveOnPrompt: false })
  off.runtime.start()
  await settle()
  off.transport.pair('c_ffffffff0f')
  await off.runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdSendPrompt, { sessionId: 'ses_arch', text: '继续' }),
    'c_ffffffff0f',
  )
  assert.deepEqual(off.kernel.calls.ensureRunnable, [], "配置说不恢复就不许动归档状态（'配置说不就不做'）")
  assert.equal(off.kernel.calls.sendPrompt.length, 1, '关掉自动恢复时指令照发，由宿主自己决定收不收')
})

test('恢复失败时把底层原因回给手机，且不再发指令：手机 toast 的唯一内容来源', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff10')
  kernel.ensureRunnableImpl = async () => ({ ok: false, message: '底层：归档盘不可读' })
  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdSendPrompt, { sessionId: 'ses_arch', text: '继续' }), 'c_ffffffff10')

  const result = transport.resultReplies().at(-1)
  assert.equal(result?.ok, false, '恢复失败必须 ok:false，不能假装发出去了')
  assert.match(String(result?.message), /归档盘不可读/, '底层原因要透出来，否则"为什么没反应"没有答案')
  assert.equal(kernel.calls.sendPrompt.length, 0, '恢复失败还继续发指令 → 宿主 gate 抛的错会更难懂')
})

test('挂起审批期间每 pendingRefreshMs 续锁，且 runtime 侧的 hold 与 release 严格配对（旧实现的 60s 心跳永不释放）', async () => {
  const { runtime, kernel, transport, sleep, sleepPort, clock } = fixture({ approvalTimeoutMs: 2 * 3_600_000 })
  sleep.setEnabled(true, 300) // 空闲 300 秒就该放锁
  runtime.start()
  await settle()
  transport.pair('c_ffffffff11')
  sleepPort.stops = 0 // 从这一刻起只观察"放锁"次数

  const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash' })
  await settle()
  const card = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evPermissionRequest) as Extract<
    EvPayload,
    { t: 'ev.permission_request' }
  >
  assert.ok(sleep.holdIds.includes(card.requestId), '挂起审批必须按 requestId 挂一次锁，否则用户还没决定笔记本先睡了')
  assert.equal(sleep.snapshot().active, true, '挂起期间必须正在持锁')

  // 审批挂着 30 分钟（没超时）：远超 300 秒的空闲阈值。旧实现在这里会因"事件里没有 requestId"
  // 而永远找不到释放点，把锁拖到进程结束；本实现靠 pendingRefreshMs 续锁 + releaseHold 放锁。
  await clock.advance(30 * 60_000)
  assert.equal(sleepPort.stops, 0, `审批还挂着就把锁放了（stops=${sleepPort.stops}）→ 手机上按钮还在，机器已经睡了`)

  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdResolvePermission, { sessionId: 'ses_live', requestId: card.requestId, decision: 'approve' }),
    'c_ffffffff11',
  )
  assert.equal(await kernelSide, 'allowed-once')
  assert.equal(sleep.liveHolds.size, 0, `手机答完之后仍有挂锁没释放：还挂着 ${JSON.stringify([...sleep.liveHolds])}`)

  // 答案之后没有活动：空闲阈值必须重新生效（旧实现是永久心跳）。
  // 360s 而不是 301s：节拍的粒度是 tickMs=60s，判据是严格大于，留出一次可观测的节拍。
  await clock.advance(360_000)
  assert.ok(
    sleepPort.stops >= 1,
    '审批结束后锁必须能靠空闲自动释放：这就是"这台机器一次远程审批过就再也睡不了"那条事故',
  )
})

// ── 历史：手机打开会话时要读到主机上已有的内容 ──────────────────────

test('cmd.session_history：条目走与实时流同一批出站构造器，游标原样带回去', async () => {
  const { runtime, transport, kernel } = fixture()
  const asked: Array<{ sessionId: string; beforeSeq?: number; limit: number }> = []
  kernel.readHistory = (sessionId, options) => {
    asked.push({ sessionId, ...options })
    return Promise.resolve({
      events: [
        { kind: 'delta', sessionId, messageId: 'm1', text: '看看完成度', role: 'user', done: true },
        { kind: 'tool', sessionId, callId: 'c1', phase: 'completed', tool: 'Bash', resultPreview: 'total 88' },
        { kind: 'delta', sessionId, messageId: 'm2', text: '结构清楚。', role: 'assistant', done: true },
      ],
      nextBeforeSeq: 9,
    })
  }
  runtime.start()
  await settle()
  transport.pair('c_000000000001')
  transport.broadcasts.length = 0
  transport.replies.length = 0

  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdSessionHistory, { sessionId: 'ses_live', beforeSeq: 42, limit: 3 }),
    'c_000000000001',
  )
  await settle()

  // 历史是**回执**不是广播：广播会把整份历史发给每一条配对通道
  const pages = transport.replies
    .map((item) => item.payload)
    .filter((payload) => payload.t === PAYLOAD_TYPES.evSessionHistory)
  assert.equal(pages.length, 1, `历史页必须只回给发起者（实得 ${pages.length} 条）`)
  const page = pages[0] as Extract<EvPayload, { t: 'ev.session_history' }>
  assert.equal(page.sessionId, 'ses_live', 'F3：载荷里的 sessionId 是 DSH 会话 id，必须逐字回原值')
  assert.equal(page.cmdId, `cmd_${PAYLOAD_TYPES.cmdSessionHistory}`, 'cmdId 不回原值 → 手机认不出这是哪次请求的页')
  assert.deepEqual(asked, [{ sessionId: 'ses_live', beforeSeq: 42, limit: 3 }], '游标与条数必须逐字传给内核端口')
  assert.deepEqual(
    page.items.map((item) => item.t),
    ['ev.message_delta', 'ev.tool_event', 'ev.message_delta'],
    '条目顺序必须保持（升序），否则手机上整段历史是倒着讲的',
  )
  assert.equal(page.nextBeforeSeq, 9, '有更早的一页就必须把游标带回去，否则「加载更早」永远点不动')
  // 运行态不许混进历史：回放历史不该去改顶栏。类型上本来就写不出来（条目只允许两种叶子载荷），
  // 这里再对**产物**查一遍——schema 是运行期才拦的，而漏掉它只会静默生效。
  assert.equal(JSON.stringify(page.items).includes('run_state'), false)
})

test('cmd.session_history：内核没有这个能力时明确拒绝，绝不回一张空页', async () => {
  const { runtime, transport, kernel } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_000000000001')
  transport.broadcasts.length = 0
  transport.replies.length = 0
  assert.equal(kernel.readHistory, undefined, '夹具有 readHistory 的话这条断言就失去意义了')

  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdSessionHistory, { sessionId: 'ses_live' }), 'c_000000000001')
  await settle()

  const pages = transport.replies.map((item) => item.payload).filter((p) => p.t === PAYLOAD_TYPES.evSessionHistory)
  assert.equal(pages.length, 0, '能力缺失却回了一张空页 → 手机上显示"这个会话没内容"，一个会让人查错方向的假事实')
  const results = transport.resultReplies()
  assert.equal(results[0]?.ok, false)
  assert.match(String(results[0]?.message ?? ''), /历史/, '拒绝原因必须点名"历史"，否则手机上只有一句看不懂的话')
})

test('cmd.session_history：读历史时炸了也必须回执失败（手机不能对着转圈干等）', async () => {
  const { runtime, transport, kernel } = fixture()
  kernel.readHistory = () => Promise.reject(new Error('这一代宿主不能读会话历史'))
  runtime.start()
  await settle()
  transport.pair('c_000000000001')
  transport.replies.length = 0

  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdSessionHistory, { sessionId: 'ses_live' }), 'c_000000000001')
  await settle()

  const results = transport.resultReplies()
  assert.equal(results.length, 1)
  assert.equal(results[0]?.ok, false)
  assert.equal(results[0]?.cmdId, `cmd_${PAYLOAD_TYPES.cmdSessionHistory}`)
  assert.match(String(results[0]?.message ?? ''), /不能读会话历史/)
})

test('cmd.session_history：不带游标 = 要最新一页（不该把 beforeSeq 塞成 undefined 传给内核）', async () => {
  const { runtime, transport, kernel } = fixture()
  let seen: Record<string, unknown> | undefined
  kernel.readHistory = (sessionId, options) => {
    seen = { sessionId, ...options }
    return Promise.resolve({ events: [] })
  }
  runtime.start()
  await settle()
  transport.pair('c_000000000001')

  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdSessionHistory, { sessionId: 'ses_live' }), 'c_000000000001')
  await settle()
  assert.deepEqual(
    seen,
    { sessionId: 'ses_live', limit: 40 },
    '省掉 beforeSeq 才是"最新一页"；多一个 undefined 键会让内核侧的判空走岔',
  )
})

// ── 新建会话：手机上那个「＋ 新建」 ──────────────────────────────────

test('cmd.new_session：回执带上主机分配的 id，并额外推一次列表（F8）', async () => {
  const { runtime, transport, kernel, clock } = fixture()
  let calls = 0
  kernel.newSession = () => {
    calls += 1
    return Promise.resolve({ ok: true, sessionId: 'ses_made' })
  }
  runtime.start()
  await settle()
  transport.pair('c_000000000001')
  // 越过合并窗口再动手：否则这一次列表推送会被合并成尾随推送（窗口是 500ms 的防抖），
  // 而这条用例要看的是"新建之后有没有推列表"，不是"防抖还灵不灵"（那条另有用例）。
  await clock.advance(1_000)
  transport.broadcasts.length = 0
  transport.replies.length = 0

  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdNewSession, {}), 'c_000000000001')
  await settle()

  const results = transport.resultReplies()
  assert.equal(results.length, 1, '新建必须回执一次且只一次')
  assert.equal(results[0]?.ok, true)
  assert.equal(results[0]?.cmdId, `cmd_${PAYLOAD_TYPES.cmdNewSession}`, 'cmdId 不回原值 → 手机认不出这是哪次新建的结果')
  assert.equal(
    (results[0]?.data as { sessionId?: string } | undefined)?.sessionId,
    'ses_made',
    '新会话的 id 必须回给手机：它是接下来所有命令的 sessionId',
  )
  assert.equal(calls, 1)
  // F8：状态变了就要额外推一次列表。不推的话，用户新建完回到列表，那条会话最长要等
  // 15 秒的兜底刷新才出现 —— 表现就是"新建了但列表没变"。
  const changed = transport.ofType(PAYLOAD_TYPES.evSessionChanged)
  assert.ok(changed.length >= 1, '新建之后没有额外推 session_changed → 列表停在旧快照')
})

test('cmd.new_session：内核没有这个能力时明确拒绝（不许回一个编出来的 id）', async () => {
  const { runtime, transport, kernel } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_000000000001')
  transport.broadcasts.length = 0
  transport.replies.length = 0
  assert.equal(kernel.newSession, undefined, '夹具有 newSession 的话这条断言就失去意义了')

  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdNewSession, {}), 'c_000000000001')
  await settle()

  const results = transport.resultReplies()
  assert.equal(results.length, 1)
  assert.equal(results[0]?.ok, false)
  assert.equal((results[0]?.data as { sessionId?: string } | undefined)?.sessionId, undefined, '拒绝时绝不能带 id')
  assert.match(
    String(results[0]?.message ?? ''),
    /新建会话/,
    '拒绝原因必须点名"新建会话"，否则手机上只有一句看不懂的话',
  )
})

test('cmd.new_session：创建炸了也回执失败，且不推列表（手机不能对着转圈干等）', async () => {
  const { runtime, transport, kernel, clock } = fixture()
  kernel.newSession = () => Promise.reject(new Error('workspace 挂不上'))
  runtime.start()
  await settle()
  transport.pair('c_000000000001')
  // 同样越过合并窗口：这样"零条 session_changed"才是"没推"，而不是"被防抖吃了"。
  await clock.advance(1_000)
  transport.broadcasts.length = 0
  transport.replies.length = 0

  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdNewSession, {}), 'c_000000000001')
  await settle()
  await clock.advance(1_000) // 就算有尾随推送也该落地了

  const results = transport.resultReplies()
  assert.equal(results.length, 1)
  assert.equal(results[0]?.ok, false)
  assert.match(String(results[0]?.message ?? ''), /workspace 挂不上/, '内核给的原因要原样透传，别换一句更含糊的')
  assert.equal(
    transport.ofType(PAYLOAD_TYPES.evSessionChanged).length,
    0,
    '没造出会话却推列表 = 让手机去刷新一个没变的东西',
  )
})
