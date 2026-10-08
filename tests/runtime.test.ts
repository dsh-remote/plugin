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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CmdPayload, EvPayload, SessionSummary } from 'dsh-remote-wire'
import { PAYLOAD_TYPES } from 'dsh-remote-wire'
import { HostRuntime, type RuntimeTransport } from '../src/core/runtime.js'
import { MAPPED_SESSION_EVENTS, sessionEventKernelEvents } from '../src/platform/carrier-services.js'
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

  hasClient(conversationId: string): boolean {
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
    sendPrompt: Array<{
      sessionId: string
      text: string
      attachments?: ReadonlyArray<{ data: string; mimeType: string }>
    }>
    interrupt: string[]
    ensureRunnable: string[]
    /** 每一次 `archiveSession(sessionId, archived)` 的实参。 */
    archive: Array<{ sessionId: string; archived: boolean }>
    unsubscribes: number
  }
  failList: boolean
  throwOnSend: boolean
  rejectSendFor: string | undefined
  /** true 时 sendPrompt 静默成功、不发任何 run-state：用来证明＂！没确认在跑就不许说 sent＂！。 */
  silentSend: boolean
  /** 非空时 interrupt 回 ok:false：用来证明＂！取消失败不假装成功＂！。 */
  rejectInterruptFor: string | undefined
  /**
   * 非空时 `runState()` 回它。**作废卡片那一帧发的是内核真相**（见 runtime 的
   * `voidStaleCard`），所以这里必须能演"回合还在跑"与"已经停了"两种收场。
   */
  runStateFor: { sessionId: string; running: boolean } | undefined
  /** true 时 `runState()` 抛：用来证明"读不到真相就退回缓存快照"那条退路。 */
  failRunState: boolean
  /** 非空时替代 SESSIONS 作为列表内容：用来证明"尾随推送带的是最新快照"。 */
  listing: SessionSummary[] | undefined
  ensureRunnableImpl: ((sessionId: string) => Promise<{ ok: boolean; message?: string }>) | undefined
  /**
   * 非空时替代默认的 archiveSession 实现：用来演"内核拒收"与"抛错"两种结局。
   * 默认（undefined）= 一律 ok:true，与真载体一致。
   */
  archiveSessionImpl: ((sessionId: string, archived: boolean) => Promise<{ ok: boolean; message?: string }>) | undefined
  feed(event: KernelEvent): void
}

function makeKernel(): FakeKernel {
  const events: Array<(event: KernelEvent) => void> = []
  const kernel: FakeKernel = {
    carrier: 'fake',
    events,
    sink: undefined,
    calls: { listSessions: [], sendPrompt: [], interrupt: [], ensureRunnable: [], archive: [], unsubscribes: 0 },
    failList: false,
    throwOnSend: false,
    rejectSendFor: undefined,
    silentSend: false,
    rejectInterruptFor: undefined,
    runStateFor: undefined,
    failRunState: false,
    listing: undefined,
    ensureRunnableImpl: undefined,
    archiveSessionImpl: undefined,
    async listSessions(limit: number) {
      kernel.calls.listSessions.push(limit)
      if (kernel.failList) throw new Error('内核读列表失败')
      const source = kernel.listing ?? SESSIONS
      return source.slice(0, limit).map((summary) => ({ summary, live: summary.state === 'running' }))
    },
    async runState(sessionId: string) {
      if (kernel.failRunState) throw new Error('内核读不到运行态')
      const override = kernel.runStateFor
      if (override !== undefined && override.sessionId === sessionId) {
        return { running: override.running, state: (override.running ? 'running' : 'idle') as SessionSummary['state'] }
      }
      return { running: false, state: 'idle' as const }
    },
    async sendPrompt(sessionId: string, text: string, attachments?: ReadonlyArray<{ data: string; mimeType: string }>) {
      if (kernel.throwOnSend) throw new Error('内核进程里炸了')
      kernel.calls.sendPrompt.push({ sessionId, text, ...(attachments?.length ? { attachments } : {}) })
      // silentSend：记了账（证明交给内核了），但不发 run-state。
      // 用来演「交出去了可内核没跑」——旧版这时已经 markSent，手机上显示在跑其实什么都没跑。
      if (kernel.silentSend) return { ok: true }
      if (kernel.rejectSendFor === sessionId) return { ok: false, message: '会话已归档，需先恢复' }
      return { ok: true }
    },
    async interrupt(sessionId: string) {
      kernel.calls.interrupt.push(sessionId)
      if (kernel.rejectInterruptFor === sessionId) return { ok: false, message: '内核不肯中断' }
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
    /**
     * ⚠️ 这个桩**不实现"运行中拒收"**：那是载体（carrier-services / mock-kernel）
     * 的责任，不在 core。core 这一层只断言"端口被调用了、失败会如实回执"，
     * 而"载体拒收"在 `carrier-services.test.ts` / `mock-kernel` 那侧单独钉。
     * 理由：把两条语义塞进一个桩里，测出来的就只是"桩自己对自己"。
     */
    async archiveSession(sessionId: string, archived: boolean) {
      kernel.calls.archive.push({ sessionId, archived })
      if (kernel.archiveSessionImpl) return kernel.archiveSessionImpl(sessionId, archived)
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
  /** 只 push message 的 `logs` 读不到"为什么"，所以带字段的每一次留痕另存一份在这里。 */
  events: Array<{ message: string; fields?: Record<string, string | number | boolean | undefined> }>
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
  const events: Array<{ message: string; fields?: Record<string, string | number | boolean | undefined> }> = []
  const runtime = new HostRuntime(kernel, transport, sleep, clock, {
    listingRefreshMs: 3_600_000,
    approvalTimeoutMs: 5_000,
    questionTimeoutMs: 5_000,
    log: (message, fields) => {
      logs.push(message)
      events.push({ message, fields })
    },
    ...options,
  })
  return { clock, kernel, transport, sleep, sleepPort, runtime, logs, events }
}

/** 把 async 桩里的 Promise 链跑完（handleCommand 与 pushSessions 都是纯微任务）。 */
async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/**
 * 造一条命令。
 *
 * ## `cmdId` 必须**逐条不同**（2026-10-07 补）
 *
 * 原来这里写死 `cmd_${t}`，于是"同一个 runtime 里发两次同类型命令"会拿到**同一个
 * cmdId** —— 而真实客户端每条命令都调 `newCmdId()` 拿一个全新的 id
 * （`dsh-remote-mp/miniprogram/core/client.js` 的 `_cmdSeq` 自增）。
 *
 * 夹具这么写一直没事，是因为主机**零去重**（GAP-4）；接上去 `IdempotencyLedger`
 * 之后它立刻变成一个陷阱：同一条命令的第二次发送被当成"重发"吞掉，于是
 * 「一次审批的 requestId 是一次性的」这类用例全红 —— 而红的**不是产品，是夹具**。
 *
 * 这条与「判据依赖的全局状态必须归一」是同一族：一个不真实的夹具会**制造**出
 * 一整片假红，而真红（重复发送被执行两遍）反而被它盖住。
 */
let cmdSeq = 0
function cmd(t: string, extra: Record<string, unknown>): CmdPayload {
  cmdSeq += 1
  // `extra` 在后 ⇒ 显式传的 cmdId 仍优先（去重那几条用例要的就是"同一个 id 发两次"）
  return { t, cmdId: `cmd_${t}_${cmdSeq}`, ...extra } as unknown as CmdPayload
}

/** 最后一条广播出去的 `ev.run_state`（手机上"挂着的卡片作废"那一帧）。 */
function lastRunState(transport: FakeTransport): Extract<EvPayload, { t: 'ev.run_state' }> | undefined {
  const beats = transport.ofType(PAYLOAD_TYPES.evRunState) as Extract<EvPayload, { t: 'ev.run_state' }>[]
  return beats[beats.length - 1]
}

/** 这一步**不许**有作废帧：断言"没有"比断言条数更直白，也更不容易被别的帧混进来。 */
function expectNoVoidBeat(transport: FakeTransport): void {
  const beats = transport.ofType(PAYLOAD_TYPES.evRunState)
  assert.equal(beats.length, 0, `不该补的帧补了 ${beats.length} 条：手机上那个"思考中"会被拨错方向`)
}

/** 最近一次"卡片作废"留痕里的那个 reason（'desktop' / 'withdrawn' / 'timeout'）。 */
function voidReason(events: Fixture['events']): unknown {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.message === 'pending card voided') return events[i]?.fields?.reason
  }
  return undefined
}

test('cmd.list_sessions 必须额外推一条 ev.session_changed：ev.result.data.sessions 手机根本不看（F8）', async () => {
  const { runtime, transport, kernel } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_000000000001')
  transport.broadcasts.length = 0

  const sentCmd = cmd(PAYLOAD_TYPES.cmdListSessions, {})
  const sentCmdId = sentCmd.cmdId
  await runtime.handleCommand(sentCmd, 'c_000000000001')
  await settle()

  const changed = transport.ofType(PAYLOAD_TYPES.evSessionChanged)
  assert.ok(changed.length >= 1, '只回了 ev.result 就完了 → 手机 sessions.js 从 ev.session_changed 取数，列表永远空白')
  const payload = changed[0] as Extract<EvPayload, { t: 'ev.session_changed' }>
  assert.equal(payload.sessions.length, 2, 'session_changed 必须是全量快照（增量手机不会合并）')
  assert.equal(payload.sessions[0]?.id, 'ses_live', 'sessions[].id 必须与载荷里的 sessionId 同名同值（F3/F11）')

  const results = transport.resultReplies()
  assert.ok(results.length >= 1, 'cmd 必须回执，否则手机等到自己超时')
  assert.equal(results[0]?.cmdId, sentCmdId, 'cmdId 不回原值 → 手机认不出这是哪条命令的回执')
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
  const sentCmd = cmd(PAYLOAD_TYPES.cmdKeepAwake, { enabled: true })
  const sentCmdId = sentCmd.cmdId
  await runtime.handleCommand(sentCmd, 'c_000000000001')
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
  const { runtime, kernel, transport, sleep, events } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_eeeeeeeeeeee')
  const controller = new AbortController()
  const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash', signal: controller.signal })
  await settle()
  controller.abort()
  assert.equal(await kernelSide, 'cancelled', '平台撤销必须转成 cancelled，不能继续挂着')
  assert.equal(sleep.liveHolds.size, 0, '撤销路径也必须释放挂锁（hold 与 release 一一对应）')
  await settle()
  assert.ok(lastRunState(transport) !== undefined, '平台撤了而手机那张卡不作废：手机上还在等一个已经没人要的决定')
  assert.equal(
    voidReason(events),
    'withdrawn',
    'reason 不是平台撤回的那一支：' + String(voidReason(events)) + '（桌面先答与平台撤回在现场是两件事）',
  )
})

/**
 * 「任意一端答完，其他端的弹窗要当场关掉」里**手机上**那一半。
 *
 * 判据是 `ev.run_state`：小程序把它当成"挂着的审批/提问卡作废"的唯一信号
 * （`pages/chat/chat.js` 的 `_onRunState` 同时清 `pendingPermission` 与 `pendingQuestion`，
 * 并停掉那条本地倒数）。而内核**不会**为"审批被别人答掉了"发状态跳变——
 * 这一回合自始至终是 running——所以这一帧只能由我们在结算点补发。
 */
test('桌面先答时必须给手机补一帧 ev.run_state，把那张作废的审批卡当场收掉', async () => {
  const { runtime, kernel, transport, logs, events } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_g1a')
  kernel.runStateFor = { sessionId: 'ses_live', running: true }
  const controller = new AbortController()
  const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash', signal: controller.signal })
  await settle()
  expectNoVoidBeat(transport)

  // 桌面先答 = `carrier-services.participate()` 用 reason 'desktop' 撤销我们这条 signal。
  controller.abort('desktop')
  assert.equal(await kernelSide, 'cancelled')
  await settle()
  const beat = lastRunState(transport)
  assert.ok(beat !== undefined, '桌面答完了而手机没收到作废帧：手机上那张卡要继续亮到它自己的倒计时走完')
  assert.equal(beat.state, 'running', '补发的那一帧必须是内核当前的真相（回合还在跑）')
  assert.equal(beat.sessionId, 'ses_live', '作废帧没有会话归属就会关掉别的会话那张卡')
  assert.equal(voidReason(events), 'desktop', '这一场是桌面先答的，留痕要说成桌面先答（同一个信号还有别的来源）')
  assert.ok(logs.includes('pending card voided'), '结算点没留痕：现场分不清"没发"与"发了没人收"')
})

test('审批超时时同样补这一帧（主机已经不等了，卡片不该还亮着）', async () => {
  const { runtime, kernel, transport, clock, events } = fixture({ approvalTimeoutMs: 1_000 })
  runtime.start()
  await settle()
  transport.pair('c_g1b')
  kernel.runStateFor = { sessionId: 'ses_live', running: false }
  const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash' })
  await settle()
  await clock.advance(1_001)
  assert.equal(await kernelSide, 'decline')
  await settle()
  const beat = lastRunState(transport)
  assert.ok(beat !== undefined, '超时后手机那张卡会一直亮着，而主机这边早就把它判掉了')
  assert.equal(beat.state, 'idle', '内核说这一回合已经停了，就不能硬发 running（手机上会凭空多一个转圈）')
  assert.equal(voidReason(events), 'timeout', '超时收的场要写成 timeout：与"桌面先答"混在一起就没法解释卡片为什么没了')
})

test('手机自己点掉时不许补这一帧：那一侧的卡由手机自己清，多发一帧会把运行态拨错方向', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_g1c')
  const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash' })
  await settle()
  const card = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evPermissionRequest) as Extract<
    EvPayload,
    { t: 'ev.permission_request' }
  >
  expectNoVoidBeat(transport)
  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdResolvePermission, { sessionId: 'ses_live', requestId: card.requestId, decision: 'approve' }),
    'c_g1c',
  )
  assert.equal(await kernelSide, 'allowed-once')
  await settle()
  expectNoVoidBeat(transport)
})

test('读不到内核真相时退回缓存快照；快照里也没有这条会话时报 idle', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_g1d')
  kernel.failRunState = true
  const controller = new AbortController()
  // ses_live 在缓存快照里是 running:true（夹具的 SESSIONS）。
  const live = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash', signal: controller.signal })
  await settle()
  controller.abort('desktop')
  assert.equal(await live, 'cancelled')
  await settle()
  assert.equal(lastRunState(transport)?.state, 'running', '读不到真相时要认缓存快照，不能一口咬定空闲')

  const controller2 = new AbortController()
  const unknown = kernel.sink?.approval({ sessionId: 'ses_不在列表', action: 'bash', signal: controller2.signal })
  await settle()
  controller2.abort('desktop')
  assert.equal(await unknown, 'cancelled')
  await settle()
  const beats = transport.ofType(PAYLOAD_TYPES.evRunState) as Extract<EvPayload, { t: 'ev.run_state' }>[]
  const last = beats[beats.length - 1]
  assert.equal(last?.sessionId, 'ses_不在列表')
  assert.equal(last?.state, 'idle', '两处都不知道这一回合在不在跑时报 idle：宁可少一个转圈，不能凭空多一个')
})

test('提问被撤回或超时时也要补同一帧（同一处结算点管两类卡片）', async () => {
  const { runtime, kernel, transport, clock } = fixture({ questionTimeoutMs: 1_000 })
  runtime.start()
  await settle()
  transport.pair('c_g1e')
  const controller = new AbortController()
  const asked = kernel.sink?.question({
    sessionId: 'ses_live',
    questions: [{ id: 'q1', question: '要哪个', options: [{ id: 'o1', label: '甲' }] }],
    signal: controller.signal,
  })
  await settle()
  controller.abort('desktop')
  assert.equal(await asked, null)
  await settle()
  assert.ok(
    lastRunState(transport) !== undefined,
    '提问被撤回而手机那张提问卡不作废：手机上会一直等一个已经没人要的答案',
  )

  const asked2 = kernel.sink?.question({
    sessionId: 'ses_live',
    questions: [{ id: 'q1', question: '要哪个', options: [{ id: 'o1', label: '甲' }] }],
  })
  await settle()
  await clock.advance(1_001)
  assert.equal(await asked2, null)
  await settle()
  const beats = transport.ofType(PAYLOAD_TYPES.evRunState) as Extract<EvPayload, { t: 'ev.run_state' }>[]
  assert.equal(beats.length, 2, `提问的超时也要补帧，实际一共 ${beats.length} 帧`)
})

/** 最近一条**回给某个对端**的帧（作废帧是 reply 不是 broadcast，它按 requestId 收单）。 */
function lastReplyOf(transport: FakeTransport, type: string): Record<string, unknown> | undefined {
  const hits = transport.replies.map((item) => item.payload).filter((payload) => payload.t === type)
  return hits[hits.length - 1] as Record<string, unknown> | undefined
}

/**
 * 精确作废帧这一组：`ev.permission_resolved` / `ev.question_resolved` 按 `requestId` 收单，
 * 而 `ev.run_state` 是"这一会话的卡片全收"。两条一起发：精确帧是正路（mp 1.0.1 起认），
 * run_state 只为兜住 1.0.1 以前的存量安装（那一档的分发是 `if (p.t === …)`，认不出静默忽略）。
 */
test('桌面先答时两条都要发：按 requestId 的精确作废帧，加上老版手机认的 ev.run_state', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_h1a')
  const controller = new AbortController()
  const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash', signal: controller.signal })
  await settle()
  const card = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evPermissionRequest) as Extract<
    EvPayload,
    { t: 'ev.permission_request' }
  >
  controller.abort('desktop')
  assert.equal(await kernelSide, 'cancelled')
  await settle()
  const resolved = lastReplyOf(transport, PAYLOAD_TYPES.evPermissionResolved)
  assert.ok(resolved !== undefined, '只发了粗收单那一帧：新版手机收不到"是哪一张卡作废"')
  assert.equal(resolved?.requestId, card.requestId, '作废帧必须对得上那张卡的 requestId')
  assert.equal(resolved?.sessionId, 'ses_live', '缺了 sessionId，手机无从判断该不该在这条会话的页面上收卡')
  assert.equal(resolved?.by, 'desktop', '桌面先答要说成 desktop，手机端才有得显示')
  assert.ok(lastRunState(transport) !== undefined, '老版手机只认 ev.run_state，这一帧不能省')
})

test('超时与平台撤回都发 by=cancelled：by 说的是"谁收的场"，不是答案', async () => {
  const { runtime, kernel, transport, clock } = fixture({ approvalTimeoutMs: 1_000 })
  runtime.start()
  await settle()
  transport.pair('c_h1b')
  const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash' })
  await settle()
  const card = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evPermissionRequest) as Extract<
    EvPayload,
    { t: 'ev.permission_request' }
  >
  await clock.advance(1_001)
  assert.equal(await kernelSide, 'decline')
  await settle()
  assert.equal(
    lastReplyOf(transport, PAYLOAD_TYPES.evPermissionResolved)?.by,
    'cancelled',
    '主机自己不等了就要说 cancelled：写成 desktop 会让人以为有人在桌面上答过',
  )
  assert.equal(lastReplyOf(transport, PAYLOAD_TYPES.evPermissionResolved)?.requestId, card.requestId)

  const controller = new AbortController()
  const withdrawn = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash', signal: controller.signal })
  await settle()
  controller.abort('platform')
  assert.equal(await withdrawn, 'cancelled')
  await settle()
  assert.equal(lastReplyOf(transport, PAYLOAD_TYPES.evPermissionResolved)?.by, 'cancelled', '平台撤回同样是 cancelled')
})

test('手机自己答完不许发作废帧：那张卡是手机自己收的，再发一次等于告诉它"你没答"', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_h1c')
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
    'c_h1c',
  )
  assert.equal(await kernelSide, 'allowed-once')
  await settle()
  assert.equal(
    transport.replies.filter((item) => item.payload.t === PAYLOAD_TYPES.evPermissionResolved).length,
    0,
    '手机答完还发作废帧：手机上刚收起的卡会被再收一次，而第二次收的是别的请求',
  )
})

test('ev.question_request 必须带 expiresAt：那张卡以前没有任何倒计时，而主机 300 秒就判没答上', async () => {
  const { runtime, kernel, transport } = fixture({ questionTimeoutMs: 60_000 })
  runtime.start()
  await settle()
  transport.pair('c_h1d')
  void kernel.sink?.question({
    sessionId: 'ses_live',
    questions: [{ id: 'q1', question: '要哪个', options: [{ id: 'o1', label: '甲' }] }],
  })
  await settle()
  const card = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evQuestionRequest) as Extract<
    EvPayload,
    { t: 'ev.question_request' }
  >
  assert.ok(card !== undefined, '没推出提问卡')
  assert.equal(typeof card.expiresAt, 'string', '缺了 expiresAt，手机上那张卡就是"看不见什么时候作废"')
  const left = Date.parse(card.expiresAt ?? '') - Date.now()
  assert.ok(left > 50_000 && left <= 60_000, `到期时刻要落在配置的超时窗口里，实际还剩 ${Math.round(left / 1000)} 秒`)
})

test('提问收场发 ev.question_resolved：审批那两条不能顺手把提问卡也标成已答', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_h1e')
  const controller = new AbortController()
  const asked = kernel.sink?.question({
    sessionId: 'ses_live',
    questions: [{ id: 'q1', question: '要哪个', options: [{ id: 'o1', label: '甲' }] }],
    signal: controller.signal,
  })
  await settle()
  const card = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evQuestionRequest) as Extract<
    EvPayload,
    { t: 'ev.question_request' }
  >
  assert.equal(
    lastReplyOf(transport, PAYLOAD_TYPES.evPermissionResolved),
    undefined,
    '提问挂着一张卡却发的是审批那两条帧：手机会收错那张',
  )
  controller.abort('desktop')
  assert.equal(await asked, null)
  await settle()
  const resolved = lastReplyOf(transport, PAYLOAD_TYPES.evQuestionResolved)
  assert.ok(resolved !== undefined, '提问卡没人收：手机上它会一直亮着，而主机早判没答上')
  assert.equal(resolved?.requestId, card.requestId)
  assert.equal(resolved?.by, 'desktop')
})

// ── peer-joined 重发挂起卡（2026-10-06：手机退后台/断线/停在列表页期间错过的那一帧） ──
//
// 为什么值得测：审批/提问卡是"一次性、单会话、只在 chat 页"的一帧，错过就永远收不到，
// 而主机还阻塞着等决定（审批 180 秒、提问 300 秒），超时后结算点还会主动擦掉。
// 重发用同一个 requestId：手机按 requestId 收卡与覆盖，重发落在已有卡的手机上只是
// 原地重写，不翻倍；结算点的精确作废帧新旧两份一起收，不留幽灵卡。

test('replayPending：挂着的提问在新通道上按原样重发（同一 requestId、同一 expiresAt）', async () => {
  const { runtime, kernel, transport } = fixture({ questionTimeoutMs: 60_000 })
  runtime.start()
  await settle()
  transport.pair('c_old')
  void kernel.sink?.question({
    sessionId: 'ses_live',
    questions: [{ id: 'q1', question: '要哪个', options: [{ id: 'o1', label: '甲' }] }],
  })
  await settle()
  const first = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evQuestionRequest) as Extract<
    EvPayload,
    { t: 'ev.question_request' }
  >
  assert.ok(first !== undefined, '首帧没发出去，后面测的就不是重发')
  transport.pair('c_new')

  const replayed = runtime.replayPending('c_new')
  await settle()
  assert.equal(replayed, 1, '挂着一张提问卡，重发必须恰好 1 条')
  const again = transport.replies.filter(
    (item) => item.conversationId === 'c_new' && item.payload.t === PAYLOAD_TYPES.evQuestionRequest,
  )
  assert.equal(again.length, 1, '重发必须发到新通道（旧通道已作废）')
  const card = again[0]?.payload as Extract<EvPayload, { t: 'ev.question_request' }>
  assert.equal(card.requestId, first.requestId, '必须同一 requestId：手机按它覆盖，不翻倍')
  assert.equal(card.expiresAt, first.expiresAt, '到期时刻不许顺延：主机超时表从第一次问出就开始走')
  assert.deepEqual(card.questions, first.questions, '题目必须原样')
})

test('replayPending：挂着的审批带着 action/reason 重发', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_old')
  void kernel.sink?.approval({ sessionId: 'ses_live', action: 'rm -rf /tmp/x', reason: '清理缓存' })
  await settle()
  const first = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evPermissionRequest) as Extract<
    EvPayload,
    { t: 'ev.permission_request' }
  >
  assert.ok(first !== undefined, '首帧没发出去')
  transport.pair('c_new')

  assert.equal(runtime.replayPending('c_new'), 1)
  await settle()
  const card = transport.replies.filter(
    (item) => item.conversationId === 'c_new' && item.payload.t === PAYLOAD_TYPES.evPermissionRequest,
  )[0]?.payload as Extract<EvPayload, { t: 'ev.permission_request' }>
  assert.equal(card.requestId, first.requestId, '必须同一 requestId')
  assert.equal(card.action, 'rm -rf /tmp/x', '动作必须原样带回去，否则手机上那张卡说不清在批什么')
  assert.equal(card.reason, '清理缓存')
})

test('replayPending：没挂起时一条都不发；新通道没有活对端时也不发', async () => {
  const { runtime, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_idle')
  assert.equal(runtime.replayPending('c_idle'), 0, '没挂起还发就是无事生非')
  assert.equal(
    transport.replies.filter(
      (item) =>
        item.payload.t === PAYLOAD_TYPES.evQuestionRequest || item.payload.t === PAYLOAD_TYPES.evPermissionRequest,
    ).length,
    0,
  )
  // 通道在但对端已走（peers 里没有）：发了也只是中继计一次丢帧，还不如不发。
  assert.equal(runtime.replayPending('c_gone'), 0, '没有活对端的通道不许重发')
})

test('replayPending：已结算的不复活（settle 删掉的就该一直不在）', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_old')
  const controller = new AbortController()
  const asked = kernel.sink?.question({
    sessionId: 'ses_live',
    questions: [{ id: 'q1', question: '要哪个', options: [{ id: 'o1', label: '甲' }] }],
    signal: controller.signal,
  })
  await settle()
  controller.abort('desktop')
  assert.equal(await asked, null)
  await settle()
  transport.pair('c_new')
  assert.equal(runtime.replayPending('c_new'), 0, '桌面已经答掉的问题重发就是诈尸')
  assert.equal(
    transport.replies.filter(
      (item) => item.conversationId === 'c_new' && item.payload.t === PAYLOAD_TYPES.evQuestionRequest,
    ).length,
    0,
  )
})

// ── inbox 接线（2026-10-06 下午）：主机侧排队的用户消息进手机 ──
//
// 用户在 DSH 里敲字时这一轮还没跑完，消息排给下一轮。原来它到 switch 就被丢掉，
// 手机上"对方正在输入"的另一半永远看不见。接线复用 ev.message_delta role=user：
// 手机本来就会渲染（去重测试锁着），历史回放走同一条 user 路，不需要新载荷。

test('inbox：真人排队消息按 user role 出站（与 user/message 同一条渲染路）', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_inbox')
  kernel.feed({
    kind: 'inbox',
    sessionId: 'ses_live',
    target: 'next-turn',
    messageId: 'm1',
    text: '桌面发的',
  })
  await settle()
  const deltas = transport.broadcasts.filter((payload) => payload.t === PAYLOAD_TYPES.evMessageDelta) as Array<
    Extract<EvPayload, { t: 'ev.message_delta' }>
  >
  assert.ok(deltas.length >= 1, '排队消息到 switch 就被丢了：手机永远看不见桌面发了什么')
  const last = deltas[deltas.length - 1]!
  assert.equal(last.role, 'user', '必须是 user role，否则手机渲染成助手的话')
  assert.equal(last.delta, '桌面发的')
  assert.equal(last.done, true, '排队消息是完整的一句，必须带 done，否则手机为它一直转圈')
})

test('inbox：空正文不发（纯图片的 splice 在手机上没有载体）', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_inbox_empty')
  transport.broadcasts.length = 0
  kernel.feed({ kind: 'inbox', sessionId: 'ses_live', target: 'next-turn', messageId: 'm2', text: '' })
  await settle()
  assert.equal(
    transport.broadcasts.filter((payload) => payload.t === PAYLOAD_TYPES.evMessageDelta).length,
    0,
    '空 user 块是假事实，mp 本来也不建块，不浪费这一帧',
  )
})

// ── cmd.get_pending（2026-10-06 下午）：手机主动拉挂起卡 ──
//
// peer-joined 的重发只发生在重配对；普通 socket 重连中继不通知主机，
// 主机收不到任何信号。手机在（重）连上、进会话页时拉一次，主机把 pending 里
// 还挂着的按原请求帧重发（与 replayPending 同一构造器、同一 requestId）。

test('get_pending：挂着的提问按原帧重发 + 回执说清重发了几张', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_gp')
  void kernel.sink?.question({
    sessionId: 'ses_live',
    questions: [{ id: 'q1', question: '要哪个', options: [{ id: 'o1', label: '甲' }] }],
  })
  await settle()
  const first = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evQuestionRequest) as Extract<
    EvPayload,
    { t: 'ev.question_request' }
  >
  assert.ok(first !== undefined, '首帧没发出去，后面测的就不是重发')
  transport.replies.length = 0

  await runtime.handleCommand(cmd('cmd.get_pending', { sessionId: 'ses_live' }), 'c_gp')
  await settle()
  const cards = transport.replies
    .map((item) => item.payload)
    .filter((payload) => payload.t === PAYLOAD_TYPES.evQuestionRequest)
  assert.equal(cards.length, 1, '挂着一张就该重发一张')
  assert.equal(
    (cards[0] as Extract<EvPayload, { t: 'ev.question_request' }>).requestId,
    first.requestId,
    '必须同一 requestId：手机按它覆盖，不翻倍',
  )
  const results = transport.resultReplies()
  assert.equal(results[results.length - 1]?.ok, true)
  assert.deepEqual((results[results.length - 1]?.data as Record<string, unknown>)?.replayed, 1)
})

test('get_pending：带 sessionId 只重发那条会话的；没挂起只回 ok 不发帧', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_gp2')
  void kernel.sink?.question({
    sessionId: 'ses_live',
    questions: [{ id: 'q1', question: '要哪个', options: [{ id: 'o1', label: '甲' }] }],
  })
  await settle()
  transport.replies.length = 0

  await runtime.handleCommand(cmd('cmd.get_pending', { sessionId: 'ses_other' }), 'c_gp2')
  await settle()
  assert.equal(
    transport.replies.filter((item) => item.payload.t === PAYLOAD_TYPES.evQuestionRequest).length,
    0,
    '别的会话挂着的不关这次拉取的事',
  )
  const results = transport.resultReplies()
  assert.equal(results[results.length - 1]?.ok, true)
  assert.deepEqual((results[results.length - 1]?.data as Record<string, unknown>)?.replayed, 0)
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
  const sentCmd = cmd(PAYLOAD_TYPES.cmdKeepAwake, { enabled: false })
  const sentCmdId = sentCmd.cmdId
  await runtime.handleCommand(sentCmd, 'c_ffffffff04')
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
  assert.equal(results[results.length - 1]?.cmdId, sentCmdId, 'cmdId 必须原样回传')
})

/**
 * 内核抛异常时的回执。
 *
 * 取消排队之前这条测的是「进了队列先回 ok，失败落在 ev.queue 上」（2026-10-05）。
 * 队列取消后 send_prompt 直接调内核，异常就该**当场**回 ok:false 带原因——
 * 手机靠这条回执解锁输入框，回 ok:true 却什么都没发生是最难查的一种。
 */
test('内核抛异常：send_prompt 当场回 ok:false 并带原因（不假装收下了）', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffff05')
  kernel.throwOnSend = true

  const sentCmd = cmd(PAYLOAD_TYPES.cmdSendPrompt, { sessionId: 'ses_live', text: '你好' })
  await runtime.handleCommand(sentCmd, 'c_ffffffff05')
  await settle()

  const results = transport.resultReplies()
  assert.ok(results.length >= 1, '一条回执都没有 → 手机输入框永久禁用，等到自己超时')
  // 对照**发出去的那一条**，不复算字符串（`cmd()` 现在逐条给新 id，见它的注释）
  assert.equal(results[0]?.cmdId, sentCmd.cmdId, '回执的 cmdId 必须回原值')
  assert.equal(results[0]?.ok, false, '内核抛了异常却回 ok:true：手机上看起来像发出去了，其实根本没到')
  assert.ok(
    String(results[0]?.message ?? '').length > 0,
    '失败回执必须带原因，否则手机上只有一句「发送失败」，无从判断该不该重试',
  )
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

// ── 模型必须在「没有轮次」时也拿得到（2026-10-06）───────────────────────
//
// commit 9511904（修提问弹窗的那个）把 `this.broadcastModel()` 从
// `pushSessions()` 里删掉了：那次重构把 broadcastModel 从「读宿主全局默认
// 模型并广播」改成「广播某个事件带来的模型」，**call site 被删掉而不是适配**。
// 于是 ev.model 只在内核发 request/header（= 会话正在跑一轮）时才出站。
// mp 那边 `modelName` 只有初始化与 `_onModel` 两处写、**没有任何清空路径**，
// 所以打开一条空闲会话时它不是"消失了"，是**从来没被设置过**。
//
// 本文件此前 model 出现 0 次——「无轮次时也要推模型」从来没有被覆盖过。

test('模型：这一轮跑完之后，后续每次列表推送都要补发 ev.model', async () => {
  // 场景就是用户报的：会话跑完一轮（request/header 报过一次模型），随后中继重启 /
  // 手机重连 → mp 重新进会话。此时内核**不会再发** request/header（它每轮一条），
  // 所以模型只能从缓存补发。没有补发的话顶栏 `modelName` 停在 ''、根本不渲染。
  const { runtime, kernel, clock, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_fffffff1')
  await settle()

  kernel.feed({ kind: 'model', sessionId: 'ses_live', model: 'space-bunny-free' })
  await settle()
  transport.broadcasts.length = 0

  // 之后每一次列表推送（含 mp 重连触发的 cmd.list_sessions）都要带上它
  await clock.advance(1_000)
  await runtime.pushSessions('list')
  await settle()

  const models = transport.ofType(PAYLOAD_TYPES.evModel)
  assert.ok(models.length >= 1, '一次都没补发：打开一条空闲会话时 mp 顶栏的模型名永远为空（用户报"当前模型不见了"）')
})

test('模型：补发的 ev.model 必须带 sessionId，且是**本会话**的模型', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_fffffff2')
  await settle()

  // 两条会话各自跑一轮，各自带上自己的模型（2026-10-05 用户报的串台就是这里）
  kernel.listing = [
    { id: 'ses_alpha', state: 'idle', running: false, title: 'A' },
    { id: 'ses_beta', state: 'idle', running: false, title: 'B' },
  ]
  kernel.feed({ kind: 'model', sessionId: 'ses_alpha', model: 'space-bunny-free' })
  await settle()
  kernel.feed({ kind: 'model', sessionId: 'ses_beta', model: 'muse-spark' })
  await settle()
  transport.broadcasts.length = 0

  await runtime.pushSessions('list')
  await settle()

  const models = transport.ofType(PAYLOAD_TYPES.evModel) as Array<{ t: string; sessionId?: string; model?: string }>
  assert.ok(models.length > 0, '补发没发生')
  // wire 1.8.0 起 sessionId 必填非空，所以补发**不能**用全局值兜底
  for (const model of models) {
    assert.ok(model.sessionId, 'sessionId 必填：空会话名的帧会被 schema 直接丢掉')
  }
  // 一条会话的模型绝不能串到另一条上
  const bySession = new Map(models.map((m) => [m.sessionId, m.model]))
  assert.equal(bySession.get('ses_alpha'), 'space-bunny-free')
  assert.equal(bySession.get('ses_beta'), 'muse-spark')
})

test('模型：没见过的会话不许补发（不能凭空造一个全局模型名）', async () => {
  const { runtime, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_fffffff3')
  await settle()
  transport.broadcasts.length = 0

  await runtime.pushSessions('list')
  await settle()

  const models = transport.ofType(PAYLOAD_TYPES.evModel)
  assert.equal(models.length, 0, '内核一次都没报过模型，补发就会显示一个猜的名字——比不显示更糟')
})

// ── 映射表不许声称映射了却没人接（2026-10-06）────────────────────────────
//
// `HostRuntime.onKernelEvent` 的 switch 是**手写枚举**：case 少了任何一个
// KernelEvent kind，那个事件就从 switch 末尾掉出去被丢弃，而且**一声不响**。
// 真实的例子：`agent/inbox/spliced` 被映射成 `{kind:'inbox'}`，ports/index.ts
// 还为它写了 35 行注释说这是"用户在 DSH 里发的消息"唯一可靠的信号，而 switch
// 里**没有 case 'inbox'**（runtime.ts 里还留着一句"见下面的 inbox 分支"的注释，
// 那个分支不存在）。它同时留在 MAPPED_SESSION_EVENTS 里，于是
// "没认就记进 unmapped"那条路径永远不会触发——**专门用来证明"内核发了我们
// 没认"的证据通道，报告的是"一切正常"**。
//
// 本文件此前只喂了 6 种 kind，model / retry / compaction / inbox 一个都没有。
// 这条判据把映射表**穷举**一遍：新增映射时忘了加 case，这里立刻红。

/**
 * 允许"映射了但故意不出站"的 kind，逐条写明理由。
 * 新增条目必须在这里显式登记——那正是"我是故意丢的"与"我忘了接"的分界。
 */
const INTENTIONAL_DROPS = new Map<string, string>([
  [
    'approval/asked',
    '只记账不翻译：审批卡片走 approval/request 那条 waterfall（attachInteractionSink），' +
      '这条内核事件只是审计面（asked 带 toolName）。见 carrier-services.ts 的对应注释。',
  ],
  ['approval/decided', '同上：decided 的 outcome 是"谁答的"的证据，进 status.json 就够了，卡片已由 waterfall 发出。'],
])

test('穷举自检：MAPPED_SESSION_EVENTS 产出的每一种 kind 都必须有出站面', async () => {
  const { runtime, kernel, transport, clock } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ffffffee')
  await settle()

  // 映射表里每一种内核事件，配一份能让它真的产出 KernelEvent 的 data。
  // 形状取自 app.asar 的 typert.host.js 声明串。
  const SAMPLES: Record<string, Record<string, unknown>> = {
    'turn/start': { turn: 1 },
    'assistant/message': { message: { content: [{ type: 'text', text: 'hi' }] } },
    'user/message': { content: [{ type: 'text', text: 'yo' }], source: { kind: 'user' }, id: 'u1' },
    'tool/call': { callId: 'c1', name: 'read_file', arguments: { path: '/x' } },
    'tool/result': { callId: 'c1' },
    'turn/end': { turn: 1 },
    'session/title': { title: '标题' },
    'approval/asked': { id: 'a1', toolName: 'write_file' },
    'approval/decided': { id: 'a1', outcome: 'allowed' },
    'todo/write': { todos: [{ content: '做一件事', status: 'pending' }] },
    // 真机形状（carrier-services.ts 的注释里有 338 条样本的统计）：
    // target 必须是 next-turn，inserted[0].source.kind 必须是 user，
    // 否则映射层会按设计返回 []（插话/机器注入/空调整都不该显示成排队）。
    'agent/inbox/spliced': {
      target: 'next-turn',
      inserted: [{ id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '桌面发的' }] }],
    },
    'request/header': { header: { config: { provider: 'p', model: 'm' } } },
    'llm/retry': { retry: 2, maxRetries: 5, failure: 'timeout' },
    'compaction/start': { compactionId: 'x', turn: 1 },
    'compaction/end': { compactionId: 'x', turn: 1 },
  }

  // 映射表里新增了一种内核事件却没给样本，等于这条判据从此不再覆盖它——
  // 所以先断言两边一一对应。这是「判据本身别腐坏」的守卫。
  const unsampled = [...MAPPED_SESSION_EVENTS].filter((type) => !(type in SAMPLES))
  assert.deepEqual(unsampled, [], `映射表新增了这些类型，判据里还没有样本：${unsampled.join('、')}`)

  const missing: string[] = []
  for (const [type, data] of Object.entries(SAMPLES)) {
    if (!MAPPED_SESSION_EVENTS.has(type)) continue
    // 先把时间推过 500ms 的合并窗口：有些 kind（title / sessions-changed）是
    // **绕道 pushSessions** 出站的，不推进时钟就会撞上合并、看起来像"没出站"。
    // 那不是丢失，是它本来就走另一条路。
    await clock.advance(1_000)
    transport.broadcasts.length = 0
    // 推进时钟会把上一轮遗留的合并定时器跑掉，那些尾随广播必须先沉淀干净——
    // 否则它们会被算成"这一条有出站面"，把漏接的 case 假通过掉。
    await settle()
    transport.broadcasts.length = 0
    const [event] = sessionEventKernelEvents({ sessionId: 'ses_live', type, seq: 1, data })
    if (!event) continue
    kernel.feed(event)
    await settle()
    const produced = transport.broadcasts.length > 0
    if (!produced && !INTENTIONAL_DROPS.has(type)) missing.push(type)
  }

  assert.deepEqual(
    missing,
    [],
    `这些内核事件映射出来了却没有任何出站面——多半是 onKernelEvent 的 switch 漏了 case：${missing.join('、')}`,
  )
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
  await settle()

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

  const sentCmd = cmd(PAYLOAD_TYPES.cmdSessionHistory, { sessionId: 'ses_live', beforeSeq: 42, limit: 3 })
  const sentCmdId = sentCmd.cmdId
  await runtime.handleCommand(sentCmd, 'c_000000000001')
  await settle()

  // 历史是**回执**不是广播：广播会把整份历史发给每一条配对通道
  const pages = transport.replies
    .map((item) => item.payload)
    .filter((payload) => payload.t === PAYLOAD_TYPES.evSessionHistory)
  assert.equal(pages.length, 1, `历史页必须只回给发起者（实得 ${pages.length} 条）`)
  const page = pages[0] as Extract<EvPayload, { t: 'ev.session_history' }>
  assert.equal(page.sessionId, 'ses_live', 'F3：载荷里的 sessionId 是 DSH 会话 id，必须逐字回原值')
  assert.equal(page.cmdId, sentCmdId, 'cmdId 不回原值 → 手机认不出这是哪次请求的页')
  assert.deepEqual(asked, [{ sessionId: 'ses_live', beforeSeq: 42, limit: 3 }], '游标与条数必须逐字传给内核端口')
  assert.deepEqual(
    page.items.map((item) => item.t),
    ['ev.message_delta', 'ev.tool_event', 'ev.message_delta'],
    '条目顺序必须保持（升序），否则手机上整段历史是倒着讲的',
  )
  assert.equal(page.nextBeforeSeq, 9, '有更早的一页就必须把游标带回去，否则「加载更早」永远点不动')
  // 运行态不许混进历史：回放历史不该去改顶栏。类型上本来就写不出来（条目只允许三种叶子载荷），
  // 这里再对**产物**查一遍——schema 是运行期才拦的，而漏掉它只会静默生效。
  assert.equal(JSON.stringify(page.items).includes('run_state'), false)
})

test('cmd.session_history：待办快照也走同一条路径（一页最后一条 = 那一页截止时的清单）', async () => {
  const { runtime, transport, kernel } = fixture()
  kernel.readHistory = (sessionId) =>
    Promise.resolve({
      events: [
        { kind: 'delta', sessionId, messageId: 'm1', text: '把待办补进历史', role: 'user', done: true },
        { kind: 'todo', sessionId, todos: [{ content: '改完跑全链路', status: 'in_progress' }] },
        { kind: 'todo', sessionId, todos: [{ content: '改完跑全链路', status: 'completed' }] },
      ],
      nextBeforeSeq: 12,
    })
  runtime.start()
  await settle()
  transport.pair('c_000000000001')
  transport.replies.length = 0

  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdSessionHistory, { sessionId: 'ses_live', limit: 3 }),
    'c_000000000001',
  )
  await settle()

  const pages = transport.replies
    .map((item) => item.payload)
    .filter((payload) => payload.t === PAYLOAD_TYPES.evSessionHistory)
  assert.equal(pages.length, 1)
  const page = pages[0] as Extract<EvPayload, { t: 'ev.session_history' }>
  assert.deepEqual(
    page.items.map((item) => item.t),
    ['ev.message_delta', 'ev.todo', 'ev.todo'],
    '两条快照都要在（全量语义，不折叠）',
  )
  const last = page.items[page.items.length - 1] as Extract<EvPayload, { t: 'ev.todo' }>
  assert.deepEqual(last.todos, [{ content: '改完跑全链路', status: 'completed' }], '最后一条是那一页截止时的清单')
  assert.equal('sessionId' in last, false, '条目里不带 sessionId（外层已经带了）')
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

  const sentCmd = cmd(PAYLOAD_TYPES.cmdSessionHistory, { sessionId: 'ses_live' })
  const sentCmdId = sentCmd.cmdId
  await runtime.handleCommand(sentCmd, 'c_000000000001')
  await settle()

  const results = transport.resultReplies()
  assert.equal(results.length, 1)
  assert.equal(results[0]?.ok, false)
  assert.equal(results[0]?.cmdId, sentCmdId)
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

  const sentCmd = cmd(PAYLOAD_TYPES.cmdNewSession, {})
  const sentCmdId = sentCmd.cmdId
  await runtime.handleCommand(sentCmd, 'c_000000000001')
  await settle()
  await settle()

  const results = transport.resultReplies()
  assert.equal(results.length, 1, '新建必须回执一次且只一次')
  assert.equal(results[0]?.ok, true)
  assert.equal(results[0]?.cmdId, sentCmdId, 'cmdId 不回原值 → 手机认不出这是哪次新建的结果')
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

/* ── 图片附件：落盘 + 正文增补（wire 1.3.0 的 cmd.send_prompt.images）────────── */

/** 回给手机的那条 ev.result 串成字符串，断言拒绝原因时用。 */
const lastReplyText = (transport: FakeTransport): string => JSON.stringify(transport.replies.at(-1)?.payload ?? {})

test('send_prompt 带图片：正文里**没有路径**，图片作为附件交给内核', async () => {
  const f = fixture()
  f.runtime.start()
  await settle()
  f.transport.pair('c_ffffffff20')
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x03, 0x04, 0xff, 0xd9,
  ])
  await f.runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdSendPrompt, {
      sessionId: 'ses_img',
      text: '看这张报错',
      images: [{ name: 'shot.jpg', mediaType: 'image/jpeg', data: jpeg.toString('base64'), width: 1170, height: 800 }],
    }),
    'c_ffffffff20',
  )
  assert.equal(f.kernel.calls.sendPrompt.length, 1, '图没被拒就必须把指令送进去')
  const sent = f.kernel.calls.sendPrompt[0]!
  assert.equal(sent.sessionId, 'ses_img')
  // **这一条是全部重点**：正文里不许再出现路径。
  // 以前是「落盘 + 把绝对路径追加进正文」——路径会出现在对话里（用户和模型都看得见），
  // 还把本机目录结构泄露给模型。现在图片走宿主原生的内容块，正文保持干净。
  assert.equal(sent.text, '看这张报错', `正文被改了，多出来的正是那条路径：${sent.text}`)
  assert.doesNotMatch(sent.text, /图片附件|已存到本机|\//, '正文里还有落盘那套痕迹')
  // 图片走附件位，不是正文：base64 与 mimeType 逐字交给内核。
  assert.deepEqual(
    sent.attachments,
    [{ data: jpeg.toString('base64'), mimeType: 'image/jpeg' }],
    '图片没有作为附件交给内核：模型根本看不到这张图，而用户以为发出去了',
  )
})

test('send_prompt 只发图不发字：正文不许塞一个空文本块（模型看到的是一句空话）', async () => {
  const f = fixture()
  f.runtime.start()
  await settle()
  f.transport.pair('c_ffffffff21')
  await f.runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdSendPrompt, {
      sessionId: 'ses_img',
      text: '',
      images: [
        { name: 'a.jpg', mediaType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64') },
      ],
    }),
    'c_ffffffff21',
  )
  const sent = f.kernel.calls.sendPrompt[0]!
  assert.equal(sent.text, '', '只发图时正文保持空')
  assert.equal(sent.attachments?.length, 1, '只发图也要把图送进去')
})

/**
 * 手机说"我发了图"却一张都送不出来时，整条失败，不许把正文照发。
 *
 * 这一条与 2026-10-06 的真机事故同源：用户按了发送、照片在输入区里显示得好好的，
 * 而正文照发、图被静默丢掉，模型对这张图只字不提 —— 用户完全看不出发生过什么。
 * 明确失败至少能在聊天框里留下一句"图没送出去"，并让他重试。
 */
test('图片一条都没带出数据：整条失败，且不许把正文当成纯文本发出去', async () => {
  const f = fixture()
  f.runtime.start()
  await settle()
  f.transport.pair('c_ffffffff22')
  await f.runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdSendPrompt, {
      sessionId: 'ses_img',
      text: '看这张报错',
      images: [{ name: 'a.jpg', mediaType: 'image/jpeg', data: '' }],
    }),
    'c_ffffffff22',
  )
  assert.equal(f.kernel.calls.sendPrompt.length, 0, '正文照发了：用户会以为图也一起发出去了')
  assert.match(lastReplyText(f.transport), /false/, '必须回一条失败，手机上才有东西可看')
  assert.match(lastReplyText(f.transport), /图片/, '失败理由要点名图片')
})

/* ── 2026-10-06 缺陷修复：结算纪律 / 撤回 / 停机 / 补发口径 ──────────────── */

test('平台已经撤销（signal 已 abort）的审批：当场交还桌面，不发卡、不挂锁、不占满超时窗口', async () => {
  // 现场形状：`carrier-services.participate()` 在调用 sink **之前**就把平台撤下来的
  // signal 转成 `controller.abort('platform')`，而 runtime 收到的正是这条 controller 的
  // signal。对**已经 abort** 的 signal `addEventListener('abort', …)` 永远不会触发：
  // 旧实现照样 hold 锁、照样发卡，手机上是一张可点的死卡，宿主那条 waterfall 被堵满
  // 整个超时窗口（180s），期间手机点"允许"还会被当成真答案。
  const { runtime, kernel, transport, sleep, events } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ab0rt000001')
  const controller = new AbortController()
  controller.abort('platform')

  let settled: ApprovalDecision | undefined
  const kernelSide = kernel.sink?.approval({
    sessionId: 'ses_live',
    action: 'bash rm -rf',
    signal: controller.signal,
  })
  void kernelSide?.then((value) => {
    settled = value
  })
  await settle()

  assert.equal(settled, 'decline', '已经撤销的审批必须**立刻**交还桌面，而不是挂到超时（旧实现这里一直是 undefined）')
  assert.equal(
    transport.replies.filter((item) => item.payload.t === PAYLOAD_TYPES.evPermissionRequest).length,
    0,
    '撤销的审批还发卡：手机上多一张点了也没用的死卡',
  )
  assert.deepEqual(sleep.holdIds, [], '撤销的审批不该 hold 锁：hold 了就要等超时才 release，期间机器不睡')
  assert.equal(sleep.liveHolds.size, 0, '挂锁泄漏')
  assert.equal(
    events.some((item) => item.message === 'approval already withdrawn by the platform, handing back to the desktop'),
    true,
    '这条路径必须留痕：否则"手机上为什么没弹卡"没有任何答案',
  )
})

test('平台已经撤销的提问：当场返回 null（交还桌面），不发卡、不挂锁', async () => {
  const { runtime, kernel, transport, sleep } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_ab0rt000002')
  const controller = new AbortController()
  controller.abort('platform')

  let settled: AskUserQuestionAnswerValue | null | undefined
  const kernelSide = kernel.sink?.question({
    sessionId: 'ses_live',
    questions: [{ id: 'q1', question: '继续吗' }],
    signal: controller.signal,
  })
  void kernelSide?.then((value) => {
    settled = value
  })
  await settle()

  assert.equal(settled, null, '已经撤销的提问必须立刻返回 null，而不是挂 300 秒')
  assert.equal(
    transport.replies.filter((item) => item.payload.t === PAYLOAD_TYPES.evQuestionRequest).length,
    0,
    '撤销的提问还发卡：手机上一张 300 秒的死卡',
  )
  assert.deepEqual(sleep.holdIds, [], '撤销的提问不该 hold 锁')
})

test('审批的落点只认 approve：deny/decline/cancel 一律 rejected（fail-open 会替用户放行）', async () => {
  for (const decision of ['deny', 'decline', 'cancel', 'Allow', '']) {
    const { runtime, kernel, transport } = fixture()
    runtime.start()
    await settle()
    transport.pair('c_decision001')
    const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash' })
    await settle()
    const card = transport.replies
      .map((item) => item.payload)
      .find((payload) => payload.t === PAYLOAD_TYPES.evPermissionRequest) as Extract<
      EvPayload,
      { t: 'ev.permission_request' }
    >
    await runtime.handleCommand(
      cmd(PAYLOAD_TYPES.cmdResolvePermission, {
        sessionId: 'ses_live',
        requestId: card.requestId,
        decision,
      }),
      'c_decision001',
    )
    assert.equal(
      await kernelSide,
      'rejected',
      `decision=${JSON.stringify(decision)} 被当成了放行：未知词一律按拒绝（白名单只有 approve/reject）`,
    )
  }
})

test('跨类结算必须拒掉：拿审批的 requestId 去答提问（或反过来）回 ok:false 且两边都还挂着', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_cross000001')

  const approvalSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash' })
  const questionSide = kernel.sink?.question({ sessionId: 'ses_live', questions: [{ id: 'q1', question: '继续吗' }] })
  await settle()
  const approvalCard = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evPermissionRequest) as Extract<
    EvPayload,
    { t: 'ev.permission_request' }
  >
  const questionCard = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evQuestionRequest) as Extract<
    EvPayload,
    { t: 'ev.question_request' }
  >
  assert.ok(approvalCard && questionCard, '夹具自检：两类卡都要发出去')

  // 用**提问的** requestId 去答审批。
  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdResolvePermission, {
      sessionId: 'ses_live',
      requestId: questionCard.requestId,
      decision: 'approve',
    }),
    'c_cross000001',
  )
  await settle()
  assert.equal(
    transport.resultReplies().at(-1)?.ok,
    false,
    '跨类结算回了 ok:true：手机上那张提问卡会被一个审批答案收掉，而平台拿到一个它没问过的决定',
  )

  // 反向：用**审批的** requestId 去答提问。
  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdAnswer, {
      sessionId: 'ses_live',
      requestId: approvalCard.requestId,
      answers: [{ questionId: 'q1', selected: ['o1'] }],
    }),
    'c_cross000001',
  )
  await settle()
  assert.equal(transport.resultReplies().at(-1)?.ok, false, '拿审批的 id 答提问同样必须拒')
  assert.equal(runtime.waiting.count, 2, `跨类结算把挂起项吃掉了：waiting=${runtime.waiting.count}（应当仍是 2）`)

  // 两边仍能被自己的那一类正常结算（证明前面拒掉的是"跨类"，不是"全都答不了"）。
  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdResolvePermission, {
      sessionId: 'ses_live',
      requestId: approvalCard.requestId,
      decision: 'approve',
    }),
    'c_cross000001',
  )
  assert.equal(await approvalSide, 'allowed-once')
  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdAnswer, {
      sessionId: 'ses_live',
      requestId: questionCard.requestId,
      answers: [{ questionId: 'q1', selected: ['o1'] }],
    }),
    'c_cross000001',
  )
  assert.notEqual(await questionSide, null, '正类结算也必须还能用')
})

test('空 answers 不是答案：cmd.answer 回 ok:false，提问仍挂着（回一条"答过了"是假事实）', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_emptyans0001')
  const kernelSide = kernel.sink?.question({ sessionId: 'ses_live', questions: [{ id: 'q1', question: '继续吗' }] })
  await settle()
  const card = transport.replies
    .map((item) => item.payload)
    .find((payload) => payload.t === PAYLOAD_TYPES.evQuestionRequest) as Extract<
    EvPayload,
    { t: 'ev.question_request' }
  >
  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdAnswer, { sessionId: 'ses_live', requestId: card.requestId, answers: [] }),
    'c_emptyans0001',
  )
  await settle()
  assert.equal(transport.resultReplies().at(-1)?.ok, false, 'answers: [] 被当成有效答案回了 ok:true')
  assert.equal(runtime.waiting.count, 1, '空答案把挂起项结算掉了：手机上那张卡还亮着，平台却收到"答过了"')

  // 真答案仍然有效。
  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdAnswer, {
      sessionId: 'ses_live',
      requestId: card.requestId,
      answers: [{ questionId: 'q1', selected: ['o1'] }],
    }),
    'c_emptyans0001',
  )
  assert.notEqual(await kernelSide, null, '补一条真答案必须还能答上')
})

test('stop() 结算挂起项要发"作废帧"：停机时通道还活着，手机上那张卡必须当场收掉', async () => {
  const { runtime, kernel, transport, sleep, events } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_stopvoid0001')
  const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash' })
  await settle()

  runtime.stop()
  await settle()

  assert.equal(await kernelSide, 'decline', '停机仍要立刻结算挂起的审批')
  assert.equal(sleep.liveHolds.size, 0, '停机后仍挂着锁')
  const resolved = transport.ofType(PAYLOAD_TYPES.evPermissionResolved)
  assert.ok(
    resolved.length >= 1 || lastRunState(transport) !== undefined,
    '停机没发作废帧：手机上那张卡会一直亮到 TTL 走完（停机顺序里 relay 还没停，发得出去）',
  )
  assert.equal(voidReason(events), 'withdrawn', '停机收场该说"被撤回"而不是"桌面答了"（by 字段决定手机上那句话）')
})

test('审批/提问的 executor 抛出（reply 抛）也必须 releaseHold：挂锁不能因为一次异常永久泄漏', async () => {
  const { runtime, kernel, transport, sleep } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_throwhold0001')
  // 发卡那一步抛（socket 刚断、加密失败……任何一处）。旧写法里 releaseHold 排在 await 之后，
  // executor 抛出 → promise reject → releaseHold 永不执行 → 这台机器再也不睡。
  transport.reply = (): boolean => {
    throw new Error('socket 已经没了')
  }
  const kernelSide = kernel.sink?.approval({ sessionId: 'ses_live', action: 'bash' })
  await assert.rejects(() => kernelSide as Promise<unknown>, '异常必须原样传出去（不许吞成一次静默的 decline）')
  assert.equal(
    sleep.liveHolds.size,
    0,
    `executor 抛出后仍挂着锁：${JSON.stringify([...sleep.liveHolds])} → caffeinate 永久泄漏`,
  )
})

test('attachInteractionSink 抛出时不许"半启动且不可重试"：下一次 start() 必须还能挂上', async () => {
  const { runtime, kernel, transport } = fixture()
  const original = kernel.attachInteractionSink!.bind(kernel)
  let fail = true
  kernel.attachInteractionSink = (sink) => {
    if (fail) throw new Error('这一代宿主 register 抛了')
    return original(sink)
  }

  runtime.start()
  await settle()
  assert.equal(kernel.sink === undefined, true, '夹具自检：第一轮确实没挂上')

  fail = false
  runtime.start() // 旧实现：started 已经是 true → 直接 return，这条 runtime 永远没有交互面
  await settle()
  assert.ok(kernel.sink !== undefined, 'sink 抛出之后 start() 不可重试：手机上永远不会有审批/提问卡')

  transport.pair('c_attach000001')
  const kernelSide = kernel.sink!.approval({ sessionId: 'ses_live', action: 'bash' })
  await settle()
  assert.notEqual(kernelSide, undefined, '重试之后审批面必须真的能用')
})

test('pushSessions 的广播段抛出不许变成未捕获拒绝：调用点全是 void，一旦漏出去就是进程被终止', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_pushcrash001')
  transport.broadcast = (): number => {
    throw new Error('加密或写 socket 炸了')
  }
  await assert.doesNotReject(() => runtime.pushSessions('list'), 'pushSessions 抛出=未捕获拒绝=Node 默认终止宿主进程')

  // 调用点（内核事件）那一侧同样：feed 是同步的，拒绝只能靠 .catch 兜。
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => {
    rejections.push(reason)
  }
  process.on('unhandledRejection', onRejection)
  try {
    kernel.feed({ kind: 'title', sessionId: 'ses_live', title: 'x' })
    await settle()
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.off('unhandledRejection', onRejection)
  }
  assert.deepEqual(rejections, [], `内核事件触发的推送出现了未捕获拒绝：${String(rejections[0])}`)
})

test('模型补发只带**当前列表里**的会话：缓存里的旧会话不许每次都往手机上灌', async () => {
  const { runtime, kernel, transport } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_modelcap0001')
  // 三条会话各报过一次模型，但列表里只留一条（另两条已经掉出 LIMIT 截断）。
  kernel.feed({ kind: 'model', sessionId: 'ses_keep', model: 'keep-model' })
  kernel.feed({ kind: 'model', sessionId: 'ses_gone1', model: 'gone-1' })
  kernel.feed({ kind: 'model', sessionId: 'ses_gone2', model: 'gone-2' })
  await settle()
  kernel.listing = [{ id: 'ses_keep', state: 'idle', running: false, title: '留着' }]
  transport.broadcasts.length = 0

  await runtime.pushSessions('list')
  await settle()

  const models = transport.ofType(PAYLOAD_TYPES.evModel) as Array<{ sessionId?: string; model?: string }>
  assert.equal(models.length, 1, `补发了 ${models.length} 条模型帧：缓存里的旧会话每次状态变化都要占一帧`)
  assert.equal(models[0]?.sessionId, 'ses_keep', '补发的必须是列表里那条')
  assert.equal(models[0]?.model, 'keep-model', '补发的模型值不许串台')
})

test('待办双端一致：新一轮开始时，手机上**上一轮**的待办必须被收掉', async () => {
  // 2026-10-07 用户实测：这一轮没写待办，手机上还挂着上一轮的清单，宿主此刻是空的。
  //
  // 内核**不会**为"这一轮没有待办"专门发一帧 `todo/write`，所以指望不到它来清。
  // 宿主那一侧是按轮清的（这一轮没写就是空），手机要一致就得由宿主在
  // **轮次开始**时补一帧空快照——这也是 host 侧唯一知道"轮次换了"的位置。
  //
  // 与历史快照那条（carrier-services 的 historyPageFromLog）是同一个病的两条通路：
  // 那条治"重进会话时"，这条治"不重进、同一页里跑下一轮"。
  const { runtime, transport, kernel, clock } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_0000000000ff')
  await settle()

  const todos = (): Array<Extract<EvPayload, { t: 'ev.todo' }>> =>
    transport.ofType(PAYLOAD_TYPES.evTodo) as Array<Extract<EvPayload, { t: 'ev.todo' }>>

  // ── 第一轮：内核写了待办 ────────────────────────────────────────
  await clock.advance(1_000)
  kernel.feed({ kind: 'todo', sessionId: 'ses_live', todos: [{ content: '上一轮要做的事', status: 'in_progress' }] })
  await settle()
  assert.deepEqual(
    todos().at(-1)?.todos,
    [{ content: '上一轮要做的事', status: 'in_progress' }],
    '夹具自检：第一轮待办到了手机',
  )

  // ── 第二轮开始：这一轮不写待办 ──────────────────────────────────
  await clock.advance(1_000)
  transport.broadcasts.length = 0
  kernel.feed({ kind: 'run-state', sessionId: 'ses_live', state: 'running' })
  await settle()
  assert.deepEqual(
    todos().at(-1)?.todos,
    [],
    '新一轮开始却没把上一轮的待办收掉：手机显示一件没在发生的事，宿主此刻是空的（双端不一致）',
  )

  // ── 这一轮真的写了待办：照常显示 ────────────────────────────────
  await clock.advance(1_000)
  kernel.feed({ kind: 'todo', sessionId: 'ses_live', todos: [{ content: '这一轮要做的事', status: 'pending' }] })
  await settle()
  assert.deepEqual(
    todos().at(-1)?.todos,
    [{ content: '这一轮要做的事', status: 'pending' }],
    '这一轮的待办要能正常上来',
  )

  // ── 内核把清单清空（发一帧空）之后：下一轮开始**不该**再补一帧空 ──
  // 这是"只在真有清单时才补"那半句的判据。少了它，实现把空清单也记进
  // todoShown 之后，从第二轮起每轮都会白发一帧——单看"清空"那几条是绿的。
  await clock.advance(1_000)
  kernel.feed({ kind: 'todo', sessionId: 'ses_live', todos: [] })
  await settle()
  await clock.advance(1_000)
  transport.broadcasts.length = 0
  kernel.feed({ kind: 'run-state', sessionId: 'ses_live', state: 'running' })
  await settle()
  assert.equal(
    transport.ofType(PAYLOAD_TYPES.evTodo).length,
    0,
    '清单已经是空的了，下一轮开始还补一帧空：每轮白发一帧只是白花渲染',
  )

  // ── 从没用过待办的会话：同样不许收到空清单 ──────────────────────
  await clock.advance(1_000)
  transport.broadcasts.length = 0
  kernel.feed({ kind: 'run-state', sessionId: 'ses_other', state: 'running' })
  await settle()
  assert.equal(
    transport.ofType(PAYLOAD_TYPES.evTodo).length,
    0,
    '这个会话压根没用过待办，却收到了一帧空清单：每轮白发一帧只是白花渲染',
  )
})

// ── cmd.new_session 的 workspace（2026-10-07 接线）─────────────────────
//
// 这一段曾经**刻意不写**，理由是"插件钉的那份 wire 还没有这个字段，而 parseCmdPayload
// 会把不认识的键 strip 掉" —— 写出来的是一段永远读到 undefined 的代码。
// 那个前提在 2.0.14 已经不成立（字段在 schema 里、钉也已经跟上），而**不接线的后果**
// 不会被任何人发现：手机指定了分组，主机在自己推断的目录里建，回执照样 ok:true。
// "用户选了 A，它落在 B" —— 没有错误、没有日志、手机上完全看不出发生了什么。

test('cmd.new_session：手机指定的 workspace 必须原样交给内核端口', async () => {
  const { runtime, transport, kernel, clock } = fixture()
  const seen: Array<{ workspace?: string } | undefined> = []
  kernel.newSession = (args?: { workspace?: string }) => {
    seen.push(args)
    return Promise.resolve({ ok: true, sessionId: 'ses_made' })
  }
  runtime.start()
  await settle()
  transport.pair('c_000000000001')
  await clock.advance(1_000)

  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdNewSession, { workspace: '/Users/linbin/some-project' }),
    'c_000000000001',
  )
  await settle()

  assert.equal(seen.length, 1, '夹具自检：newSession 被调了一次')
  assert.equal(
    seen[0]?.workspace,
    '/Users/linbin/some-project',
    '手机指定的落点被丢掉了：会话会建在主机自己推断的目录里，而回执照样 ok:true（无错、无日志、手机上看不出来）',
  )
})

test('cmd.new_session：老手机不带 workspace 时端口收到 undefined（向后兼容那一档）', async () => {
  // 反证：接线不能变成"没有 workspace 也造一个空串塞进去"——那会让载体以为
  // 手机指定了一个空目录，而 `cmd.workspace ? … : undefined` 正是为此留的。
  const { runtime, transport, kernel, clock } = fixture()
  const seen: Array<{ workspace?: string } | undefined> = []
  kernel.newSession = (args?: { workspace?: string }) => {
    seen.push(args)
    return Promise.resolve({ ok: true, sessionId: 'ses_made' })
  }
  runtime.start()
  await settle()
  transport.pair('c_000000000001')
  await clock.advance(1_000)

  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdNewSession, {}), 'c_000000000001')
  await settle()

  assert.equal(seen[0], undefined, '没带就等于没带：载体会退回它那三级推断，行为与接线之前完全一致')
})

/* ── `cmdId` 去重（规范 §10.2 / GAP-4）────────────────────────────────────
 *
 * 故障是既有的、且**随机**：手机 12 秒收不到回执就报超时并允许重发，断线重连后
 * 也会补发，而主机此前零去重 ⇒ `cmd.send_prompt` 可能执行两次（用户说一遍、
 * 模型回两遍）。快网络下几乎不复现，慢网络或切后台时必现，于是排错时永远
 * 找不到"那次重复发送"是谁发起的。
 *
 * 四条断言各自钉一个方向，且**两条是反向的**——那两条最要紧：
 * 「重发必须重放上一次的回执」与「窗口外/不同 cmdId 仍要照常执行」。
 * 没有它们，一个"一律拒绝重复命令"的实现也能让前两条变绿，而那个实现会把
 * 用户真的重发（例如换了个内容但忘了换 cmdId）一起拦掉。
 * ─────────────────────────────────────────────────────────────────────── */

test('同一条 cmd.send_prompt 重发只执行一次（超时的补发不许变成第二次发言）', async () => {
  const { runtime, transport, kernel } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_000000000001')

  const payload = cmd(PAYLOAD_TYPES.cmdSendPrompt, {
    sessionId: 'ses_live',
    text: '只说 ok',
    // 显式给一个稳定的 cmdId：手机重发时用的是**同一个** cmdId（它重发的是那条请求）
    cmdId: 'cmd_dup_1',
  } as never)
  await runtime.handleCommand(payload, 'c_000000000001')
  await settle()
  assert.equal(kernel.calls.sendPrompt.length, 1, '前置条件：第一条应当执行一次')
  const firstReply = transport.resultReplies().at(-1)

  // 模拟"手机没收到回执，12 秒后补发同一条"
  await runtime.handleCommand(payload, 'c_000000000001')
  await settle()

  assert.equal(
    kernel.calls.sendPrompt.length,
    1,
    `重发之后 kernel.sendPrompt 被调了 ${kernel.calls.sendPrompt.length} 次 —— 用户说了一遍、模型回两遍，` +
      '而这正是这条去重要防的那件事。',
  )
  assert.equal(
    transport.resultReplies().length,
    2,
    '重发也必须回执：不回执的话手机上那个 Promise 会一直转到自己超时，' + '用户看到的是"点了没反应"。',
  )
  assert.deepEqual(
    transport.resultReplies().at(-1),
    firstReply,
    '重发必须**重放上一次的回执**，不是回一句新的 ok:true —— ' +
      '新回执会让超时的那个 Promise 正常 resolve，而那条命令可能根本没执行成功。',
  )
})

test('不同 cmdId 照常执行（去重不能变成"拒绝一切重复命令"）', async () => {
  const { runtime, transport, kernel } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_000000000001')

  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdSendPrompt, { sessionId: 'ses_live', text: '第一条', cmdId: 'cmd_a' } as never),
    'c_000000000001',
  )
  await settle()
  await runtime.handleCommand(
    cmd(PAYLOAD_TYPES.cmdSendPrompt, { sessionId: 'ses_live', text: '第二条', cmdId: 'cmd_b' } as never),
    'c_000000000001',
  )
  await settle()

  assert.equal(kernel.calls.sendPrompt.length, 2, '两个不同 cmdId 是两条命令，都必须执行')
  assert.deepEqual(
    kernel.calls.sendPrompt.map((c) => c.text),
    ['第一条', '第二条'],
  )
})

test('出了去重窗口的同一条命令重新算新命令（窗口是幂等有效期，不是安全边界）', async () => {
  const { runtime, transport, kernel, clock } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_000000000001')

  const payload = cmd(PAYLOAD_TYPES.cmdSendPrompt, {
    sessionId: 'ses_live',
    text: '很久以后又发一次',
    cmdId: 'cmd_window',
  } as never)
  await runtime.handleCommand(payload, 'c_000000000001')
  await settle()

  // 走过整个去重窗口（默认 5 分钟，见协议层 IDEMPOTENCY_WINDOW_MS）。
  // ⚠️ `advance` 是 **async** 的：不 await 的话时间根本没动，台账还在窗口内 ——
  // 那时这条判据红的是"忘了 await"，而不是"实现把窗口当成了永久"，两者不能混。
  await clock.advance(10 * 60_000)
  await runtime.handleCommand(payload, 'c_000000000001')
  await settle()

  assert.equal(
    kernel.calls.sendPrompt.length,
    2,
    '过了窗口的同一条命令没有重新执行 —— 那意味着**永久**去重：' +
      'cmdId 重复（手机重发）会被拦，可一条真实的重复命令也会被拦。',
  )
})

test('停机不重置台账（重发跨越一次 stop/start 仍不该执行第二遍）', async () => {
  // 这条钉的是"台账的生命周期与 runtime 一致"：如果 stop() 里顺手清空台账，
  // 那么"主机刚好在命令执行后、回执发出前重启"这一档就会执行两次 ——
  // 而那恰恰是最容易发生重启的时刻（用户刚发出指令就合上电脑）。
  const { runtime, transport, kernel } = fixture()
  runtime.start()
  await settle()
  transport.pair('c_000000000001')

  const payload = cmd(PAYLOAD_TYPES.cmdSendPrompt, {
    sessionId: 'ses_live',
    text: '发完就合盖',
    cmdId: 'cmd_sleep',
  } as never)
  await runtime.handleCommand(payload, 'c_000000000001')
  await settle()
  await runtime.stop()

  // 重连（同一条命令被补发）
  transport.pair('c_000000000001')
  await runtime.handleCommand(payload, 'c_000000000001')
  await settle()

  assert.equal(kernel.calls.sendPrompt.length, 1, '跨 stop/start 的重发又执行了一遍')
})

/**
 * 形状过不了 schema 的载荷：主机**必须回一条**（2026-10-07 补，§5-9）。
 *
 * 手机在它那一端是过得了 schema 的，所以"到主机这边过不去"只可能意味着两端版本不一致。
 * 从前这一路只写一行日志就 `continue`，于是手机干等满 12 秒的 `COMMAND_TIMEOUT_MS`
 * 再拿到一句「主机没有回应这条指令」——**根因一个字都没留下**。
 */
test('主机认不出的指令：按 cmdId 回 ev.result{ok:false}，并说清该怎么办', async () => {
  const { runtime, transport } = fixture()
  transport.pair('c_000000000001')

  // ① 主机这一代**根本没有**这个命令（将来手机先升级、主机没跟上的形状）。
  //
  // ⚠️ 这里原来拿 `cmd.archive_session` 当例子，而它 2026-10-07 已经发版了 ——
  // 于是判据红在一个**与本次改动毫无字面关系**的地方（症状与改动点不同文件同仓）。
  // 判据的意图是"一个协议里不存在的命令名"，所以必须用一个**真的不存在**的名字，
  // 而且它得是"看起来像一条合法命令"的形状（`cmd.` 前缀 + 小写下划线）——
  // 随便写个 `garbage` 会让 `isKnownPayloadType` 分支变得太容易过。
  runtime.handleInvalidCommand('c_000000000001', 'cmd_future', 'cmd.archive_session_v2')
  // ② 命令名认识、**字段**过不去（最典型：mediaType 超过 schema 的 64 上界）。
  runtime.handleInvalidCommand('c_000000000001', 'cmd_shape', PAYLOAD_TYPES.cmdSendPrompt)

  const results = transport.resultReplies()
  const [unknownCommand, badShape] = results
  assert.equal(results.length, 2, '两处都必须回执：不回 = 手机端只剩 12 秒超时，根因只活在主机日志里')
  assert.ok(unknownCommand && badShape, '夹具自检：两条回执都必须取得到')

  assert.equal(unknownCommand.cmdId, 'cmd_future', 'cmdId 必须原样带回去（手机按它结算 waiter）')
  assert.equal(unknownCommand.ok, false)
  assert.match(String(unknownCommand.message), /主机这一代不支持/, '没发版的命令要说"插件太旧"，而不是笼统地失败')
  assert.match(String(unknownCommand.message), /升到最新版/, '必须给出可执行的下一步，而不只是"失败了"')

  assert.equal(badShape.cmdId, 'cmd_shape')
  assert.equal(badShape.ok, false)
  assert.match(
    String(badShape.message),
    /协议版本不一致/,
    '同一句失败对"命令不存在"与"字段不认识"必须能分开——那是两种完全不同的排错方向',
  )
  assert.match(String(badShape.message), /升到最新版/, '同上：给可执行的下一步')
  // 这条 message 是**直接 toast 给用户**的（ev.result.ok:false → chat 页弹它），
  // 所以至少要有一句中文在解释"该做什么"；主机那边抛了什么留在日志里。
  for (const result of results) {
    assert.match(String(result.message), /[一-龥]/, `message 必须是能直接给用户看的中文：${String(result.message)}`)
  }
})

test('没有 cmdId 时只能留日志：不许造一个假回执去结算手机上别的等待', async () => {
  const { runtime, transport, logs } = fixture()
  transport.pair('c_000000000001')

  runtime.handleInvalidCommand('c_000000000001', undefined, 'cmd.future_thing')

  assert.equal(
    transport.resultReplies().length,
    0,
    '没有 cmdId 就无从回执；编一个出来会把手机上某一条**别的**等待误结算',
  )
  assert.ok(
    logs.some((line) => line.includes('unanswerable command rejected')),
    '这一档必须留痕：否则"手机点了没反应"连日志里都没有答案',
  )
})

test('被拒的指令**不许**进台账：没做过的事不许记成"已执行"，真命令来时照常执行', async () => {
  const { runtime, transport } = fixture()
  transport.pair('c_000000000001')

  // 同一个 cmdId 先被拒一次（形状不对）。
  runtime.handleInvalidCommand('c_000000000001', 'cmd_shared', PAYLOAD_TYPES.cmdListSessions)
  transport.replies.length = 0

  // 同一个 cmdId 再来一条**合法**的命令：它必须真的执行，而不是被当成重发回放。
  await runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdListSessions, { cmdId: 'cmd_shared' } as never), 'c_000000000001')

  const results = transport.resultReplies()
  const [executed] = results
  assert.ok(results.length === 1 && executed, `这条命令本身必须回执（实际 ${results.length} 条）`)
  assert.equal(executed.ok, true, '被拒的那次把 cmdId 记进了台账 ⇒ 这条真命令被当成"已执行过"直接回放')
  assert.doesNotMatch(
    String(executed.message),
    /已执行过/,
    '拒收与执行是两条路：把"没做过的事"记进"已执行"的台账是撒谎',
  )
})

/**
 * `cmd.archive_session`（2026-10-07 加）。
 *
 * 这一族的三条纪律，各由下面各自的判据钉住：
 * 1. **core 只转发，语义在载体**：core 断言"端口被调用、失败如实回执"，
 *    而"运行中拒收 / stopActivity 绝不传"由 `carrier-services.test.ts` 单独钉
 *    ——把它们塞进同一个桩里，测出来的就只是"桩自己对自己"。
 * 2. **不许静默成功**（规范 A2）：端口缺能力时必须回 ok:false。
 * 3. **成功后必须补推列表**（规范 A3）：本端不消费 `workspace/changes`
 *    （那是一帧 `{turn:N}`，推不出归档了哪一条）。
 */
test('cmd.archive_session：转发到端口、成功回执，并补推一次列表（规范 A3）', async () => {
  const { runtime, transport, kernel } = fixture()
  transport.pair('c_000000000001')
  const before = transport.ofType(PAYLOAD_TYPES.evSessionChanged).length

  runtime.handleCommand(cmd('cmd.archive_session' as CmdPayload['t'], { sessionId: 's1' }), 'c_000000000001')
  await settle()

  assert.deepEqual(
    kernel.calls.archive,
    [{ sessionId: 's1', archived: true }],
    '缺省就是归档：core 必须把"缺省"翻译成显式的 archived=true 交给端口（端口不认 undefined）',
  )
  const [res] = transport.resultReplies()
  assert.ok(res, '必须有回执')
  assert.equal(res.ok, true, '成功要回 ok:true —— 手机靠它关掉那个转圈')
  assert.equal(
    transport.ofType(PAYLOAD_TYPES.evSessionChanged).length,
    before + 1,
    '成功后必须补推一次列表：用户点完就该看到列表变了，等下一次 15 秒刷新等于"点了没反应"',
  )
})

test('cmd.archive_session：archived:false 是取消归档，方向不能反', async () => {
  const { runtime, transport, kernel } = fixture()
  transport.pair('c_000000000001')
  runtime.handleCommand(
    cmd('cmd.archive_session' as CmdPayload['t'], { sessionId: 's1', archived: false }),
    'c_000000000001',
  )
  await settle()
  assert.deepEqual(
    kernel.calls.archive,
    [{ sessionId: 's1', archived: false }],
    '反向判据：把 false 当成 true 就是"取消归档变成了再归档一次"，用户永远拿不回那条会话',
  )
})

test('cmd.archive_session：端口拒收时如实回 ok:false 并带出原因（规范 A2）', async () => {
  const { runtime, transport, kernel } = fixture()
  transport.pair('c_000000000001')
  // 真载体在会话还在跑时回的就是这句（`stopActivity` 我们刻意不传）
  kernel.archiveSessionImpl = async () => ({ ok: false, message: '会话正在运行，不能归档。请先在电脑上让它跑完' })
  const before = transport.ofType(PAYLOAD_TYPES.evSessionChanged).length

  runtime.handleCommand(cmd('cmd.archive_session' as CmdPayload['t'], { sessionId: 's1' }), 'c_000000000001')
  await settle()

  const [res] = transport.resultReplies()
  assert.ok(res)
  assert.equal(res.ok, false, '失败必须说失败：假装成功会让用户以为归档了，而列表里那条还在')
  assert.match(String(res.message), /正在运行/, '原因要原样透出，mp 那边直接 toast 它')
  assert.equal(
    transport.ofType(PAYLOAD_TYPES.evSessionChanged).length,
    before,
    '失败时不许推列表：推了就是"列表没变"与"操作成功"两个互相矛盾的信号',
  )
})

test('反向判据：这一代主机没有归档能力时**明确拒绝**，不许静默成功', async () => {
  // 缺口的语义：`archiveSession?` 是可选方法，缺它 = 这一代内核没有这个能力。
  // core 这一层必须把它变成一条明说原因的 ok:false，而不是"跳过这一条 case"
  // （那会让手机干等 12 秒的 COMMAND_TIMEOUT_MS 再报一句"主机没有回应"）。
  const { runtime, transport, kernel } = fixture()
  transport.pair('c_000000000001')
  // 刻意制造"没有这个方法"的载体（真实场景：更老的内核）。
  // 不用 @ts-expect-error：`delete` 一个可选成员在 TS 里本来就合法。
  delete (kernel as { archiveSession?: unknown }).archiveSession
  const cmdId = 'cmd_no_archive'
  runtime.handleCommand({ t: 'cmd.archive_session', cmdId, sessionId: 's1' } as CmdPayload, 'c_000000000001')
  await settle()

  const [res] = transport.resultReplies()
  assert.ok(res, '必须回执：静默丢弃 = 手机端只剩 12 秒超时')
  assert.equal(res.cmdId, cmdId, '按 cmdId 结算，cmdId 必须原样带回')
  assert.equal(res.ok, false)
  assert.match(String(res.message), /不支持归档/, '要说清是"主机这一代没有"，而不是"失败了"')
  assert.match(String(res.message), /archiveSession/, '要点名缺的那个能力，排错时不必去猜')
})

/**
 * `settledReplies` 必须与台账**同生共死**（2026-10-07 修）。
 *
 * ## 缺陷形状
 *
 * 台账（协议层 `IdempotencyLedger`）按**窗口 + 容量**两路淘汰，而
 * `settledReplies` 是 core 里另一张独立的 Map。原来的"让它同生共死"实现是
 * `forgetWhenOutOfWindow(cmdId, now)`：登记完那一条之后**顺手问一次台账还在不在**。
 *
 * 而 `ledger.has(cmdId, now)` 里的 `prune(now)` **只对台账自己的 entries 生效**——
 * 它删的是台账的键，`settledReplies` 里其余的键从此再没有任何代码碰过。
 * 于是台账稳在 256 条，而回执表等于"进程活多久就长多大"。
 *
 * 症状不是"内存涨一点"：`cmd.list_sessions` 的回执带 `data.sessions`（最多 100 条
 * 会话摘要），每一条都常驻；而 mp 每次重连/刷新列表都会发一次那条命令。
 * 长跑进程（GUI 宿主本来就长驻）持续涨内存，且**没有任何一行日志**说这件事。
 *
 * ## 为什么不能用"再问一次"来补
 *
 * 把 `forgetWhenOutOfWindow` 改成遍历全表是 O(n) 每条命令，而 n 正是要解决的问题。
 * 正确形状是**在台账淘汰之后，把台账已经没有的键从回执表里删掉**——
 * 而这件事的时机只能是"台账刚发生过一次结构性淘汰"时。
 */
test('settledReplies 不许无界增长：它必须与台账一起收缩', async () => {
  const { runtime, transport } = fixture({ listingRefreshMs: 3_600_000 })
  transport.pair('c_000000000001')
  // 连发 900 条（> IDEMPOTENCY_CAPACITY = 256），每条都带回执。
  // 用 list_sessions 是因为它的回执带 data，最能体现"每条都常驻"的代价。
  for (let i = 0; i < 900; i++) {
    runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdListSessions, {}), 'c_000000000001')
    if (i % 50 === 0) await settle()
  }
  await settle()
  const size = (runtime as unknown as { settledReplies: Map<string, unknown> }).settledReplies.size
  assert.ok(
    size <= 256,
    `settledReplies 长到 ${size} 条：台账容量是 256，这张表与它"同生共死"的承诺没有成立。` +
      '每条 cmd.list_sessions 的回执还带最多 100 条会话摘要',
  )
})

test('反向判据：容量淘汰掉的那条，重发时必须回"回执已不在"而不是静默', async () => {
  // 上一条钉住"表会收缩"；这一条钉住"收缩之后那条路径仍然有话可说"。
  // 两者是一对：只写前一条的话，把 delete 换成"什么都不做"也能全绿。
  const { runtime, transport } = fixture({ listingRefreshMs: 3_600_000 })
  transport.pair('c_000000000001')
  const stale = cmd(PAYLOAD_TYPES.cmdListSessions, {})
  runtime.handleCommand(stale, 'c_000000000001')
  await settle()
  // 把它挤出容量：再发 300 条不同的
  for (let i = 0; i < 300; i++) {
    runtime.handleCommand(cmd(PAYLOAD_TYPES.cmdListSessions, {}), 'c_000000000001')
    if (i % 50 === 0) await settle()
  }
  await settle()
  const replies = transport.resultReplies()
  const last = replies[replies.length - 1]
  // 无论它是"重放了旧回执"还是"回执已不在"，都必须是**一条 ok 的明说**，
  // 而不能是"手机继续转到超时"。
  assert.ok(last, '夹具自检：至少要收到一条回执')
  assert.equal(last.t, PAYLOAD_TYPES.evResult)
  assert.ok(
    last.ok === true,
    `重发一条已被容量淘汰的命令时必须回一条 ok 的明说（"已执行过但回执不在"），实得 ${JSON.stringify(last)}`,
  )
})
