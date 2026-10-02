/**
 * runtime — HostRuntime：内核事件 → 手机载荷，以及手机命令 → 内核调用。
 *
 * 这一层**不认识 cordis**，也不认识 socket：它只通过 `KernelPort` 与
 * `RuntimeTransport` 说话，所以审批闭环、归档恢复、合帧顺序这些真正难验证的行为
 * 都能在纯内存里测出来（旧实现做不到，它的测试全靠手写 cordis 替身）。
 *
 * 四条必须在这里守住的协议义务（编号对应 docs/DESIGN.md §2）：
 *
 * - **F8 列表推送义务**：会话列表的唯一数据源是 `ev.session_changed`，
 *   `ev.result.data.sessions` 手机**不看**。所以每次 `cmd.list_sessions`、
 *   以及任何会改变会话状态的动作之后，都必须**额外推一条 session_changed**。
 * - **F9 done 帧不可丢**：文本收尾由 `DeltaWindow` 负责，本层只保证
 *   "非 delta 事件之前先 flush 同会话缓冲"，否则工具行会插到它自己的文本前面。
 * - **F10 decision 逐字**：手机端回传的是我们下发的 `options[].id`，
 *   所以这里的选项 id 必须是**稳定机器名**，且 `'reject'` 这个词不能改——
 *   小程序用它判断"拒绝之后界面该不该继续显示运行中"。
 * - **F11 两个无会话归属的载荷**：`ev.session_changed` / `ev.keep_awake_state`
 *   由 `outbound.ts` 的构造器产出，参数表里就没有 sessionId。
 */
import { randomUUID } from 'node:crypto'
import type { AnswerItem, CmdPayload, EvPayload, HistoryItem, QuestionItem, SessionSummary } from 'dsh-remote-wire'
import {
  keepAwakeState,
  messageDelta,
  permissionRequest,
  questionRequest,
  result as resultOf,
  runState,
  sessionChanged,
  sessionHistory,
  toolEvent,
} from 'dsh-remote-wire/outbound'
import type { ApprovalDecision, AskUserQuestionAnswerValue, KernelEvent, KernelPort } from '../ports/index.js'
import { DeltaWindow, DEFAULT_WINDOW_OPTIONS, type WindowOptions } from './window.js'
import type { KeepAwake } from './sleep-policy.js'
import type { Clock } from '../ports/index.js'

/** 出站通道：core 只负责"该发什么"，加密与投递由 shell 提供。 */
export interface RuntimeTransport {
  /** 发给某一条配对会话（回执用）。返回 false 表示没有活的对端。 */
  reply(conversationId: string, payload: EvPayload): boolean
  /** 发给所有已配对的会话（会话列表、防休眠状态这类广播）。返回**收到这条广播的会话数**，0 表示没发出去。 */
  broadcast(payload: EvPayload): number
  /** 此刻是否有能收这条会话消息的对端（审批要不要认领的判据）。 */
  hasPeer(conversationId: string): boolean
  /** 当前活跃的配对会话 id。 */
  conversationIds(): string[]
  /** 把一条会话标为不可用（复核 R1：解不开/没人接时主动作废）。 */
  voidConversation?(conversationId: string): void
}

export interface RuntimeOptions {
  /** 会话列表的全量刷新周期。事件驱动之外还要有一条兜底，因为旧实现断连期间会丢事件。 */
  listingRefreshMs: number
  window?: Partial<WindowOptions>
  /** 审批等待手机回应的上限；超时返回 decline，把决定权交还桌面 UI。 */
  approvalTimeoutMs: number
  /** 提问等待上限；超时返回 null（提问服务没有 next 可交还）。 */
  questionTimeoutMs: number
  /** 发指令前自动恢复归档会话。关掉它就要接受"归档会话被宿主 gate 直接拒掉"。 */
  unarchiveOnPrompt: boolean
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
}

interface PendingInteraction {
  conversationId: string
  sessionId: string
  resolve: (value: unknown) => void
  timer: unknown
  /** 审批/提问各自的选项表，用于把手机回传的 id 翻回平台要的词汇。 */
  options?: QuestionItem[]
}

const APPROVAL_OPTIONS = [
  // 'reject' 这个词是手机端的行为分支条件，不能改（F10）。
  { id: 'approve', label: '允许一次' },
  { id: 'reject', label: '拒绝' },
]

const DEFAULTS: RuntimeOptions = {
  listingRefreshMs: 15_000,
  approvalTimeoutMs: 180_000,
  questionTimeoutMs: 300_000,
  unarchiveOnPrompt: true,
}

/** 一次列表最多给手机多少条会话（与中继侧的会话上限同源，取证 §5.3）。 */
const LISTING_LIMIT = 100
/** 一次历史翻页默认给多少条（协议上界 200，这里更保守：一帧要装得下）。 */
const HISTORY_LIMIT = 40
/** 相邻两条 `ev.session_changed` 的最小间隔；小于它就改成尾随推送。 */
const SESSION_MERGE_MS = 500

export class HostRuntime {
  private readonly options: RuntimeOptions
  private readonly window: DeltaWindow
  private readonly pending = new Map<string, PendingInteraction>()
  private unsubscribe: (() => void) | undefined
  private detachSink: (() => void) | undefined
  private refreshTimer: unknown
  /** 被合并掉的那次推送：定时器 + 最后一次触发它的原因。 */
  private mergeTimer: unknown
  private mergePendingReason = 'merged'
  private sessions: SessionSummary[] = []
  private started = false
  private stopped = false
  private lastPushAt = 0

  constructor(
    private readonly kernel: KernelPort,
    private readonly transport: RuntimeTransport,
    private readonly sleep: KeepAwake,
    private readonly clock: Clock,
    options: Partial<RuntimeOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options }
    this.window = new DeltaWindow((delta) => this.broadcast(delta), this.clock, {
      ...DEFAULT_WINDOW_OPTIONS,
      ...options.window,
    })
  }

  /** 挂接内核。任何一步失败都只降级，不抛（外层 apply() 的红线）。 */
  start(): void {
    if (this.started) return
    this.started = true
    try {
      this.unsubscribe = this.kernel.subscribe((event) => this.onKernelEvent(event))
    } catch (error) {
      this.log('kernel subscribe failed', { message: messageOf(error) })
    }
    const detach = this.kernel.attachInteractionSink?.({
      approval: (info) => this.onApprovalRequest(info),
      question: (info) => this.onQuestionRequest(info),
    })
    if (detach) this.detachSink = detach
    void this.pushSessions('start')
    this.refreshTimer = this.clock.setTimeout(() => this.refreshLoop(), this.options.listingRefreshMs)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.window.stop()
    try {
      this.unsubscribe?.()
    } catch {
      /* 退订失败无所谓，进程要走了 */
    }
    this.detachSink?.()
    if (this.refreshTimer !== undefined) this.clock.clearTimeout(this.refreshTimer)
    if (this.mergeTimer !== undefined) {
      this.clock.clearTimeout(this.mergeTimer)
      this.mergeTimer = undefined
    }
    for (const [id, item] of [...this.pending]) this.settle(id, undefined)
  }

  /** 手机发来的命令。`conversationId` 是配对通道 id，与载荷里的 sessionId 不是一回事（F3）。 */
  async handleCommand(cmd: CmdPayload, conversationId: string): Promise<void> {
    const reply = (ok: boolean, extras: { message?: string; data?: Record<string, unknown> } = {}): void => {
      this.replyTo(conversationId, resultOf(cmd.cmdId, ok, extras))
    }
    try {
      switch (cmd.t) {
        case 'cmd.list_sessions': {
          const sessions = await this.pushSessions('list')
          reply(true, { data: { sessions } })
          return
        }
        case 'cmd.send_prompt': {
          if (this.options.unarchiveOnPrompt && this.kernel.ensureRunnable) {
            const ready = await this.kernel.ensureRunnable(cmd.sessionId)
            if (!ready.ok) {
              reply(false, { message: ready.message ?? '会话无法恢复' })
              return
            }
          }
          const sent = await this.kernel.sendPrompt(cmd.sessionId, cmd.text)
          reply(sent.ok, sent.message ? { message: sent.message } : {})
          if (sent.ok) {
            this.sleep.markActive()
            void this.pushSessions('prompt') // F8：状态变了就要额外推一次
          }
          return
        }
        case 'cmd.interrupt': {
          const done = await this.kernel.interrupt(cmd.sessionId)
          reply(done.ok, done.message ? { message: done.message } : {})
          void this.pushSessions('interrupt')
          return
        }
        case 'cmd.resolve_permission': {
          const settled = this.settleApproval(cmd.requestId, cmd.decision)
          reply(settled, settled ? {} : { message: '这个审批请求已经不在挂起状态' })
          void this.pushSessions('permission')
          return
        }
        case 'cmd.answer': {
          const settled = this.settleQuestion(cmd.requestId, cmd.answers)
          reply(settled, settled ? { data: { answered: cmd.requestId } } : { message: '这个提问已经不在挂起状态' })
          return
        }
        case 'cmd.keep_awake': {
          const snapshot = this.sleep.setEnabled(cmd.enabled, cmd.idleReleaseSec)
          this.broadcast(keepAwakeState(snapshot))
          reply(true)
          return
        }
        case 'cmd.new_session': {
          // 能力缺失时**明确拒绝**（与 cmd.session_history 同一条原则）：回一个假的
          // sessionId 让手机一路走下去，失败点会跑到很远的地方 —— 用户看到的是
          // "新建了一个会话，但发什么都失败"，而病根在宿主没有这个服务。
          const create = this.kernel.newSession
          if (!create) {
            reply(false, { message: '主机这一代不支持新建会话（内核端口没有 newSession 能力）' })
            return
          }
          const made = await create.call(this.kernel)
          if (!made.ok || !made.sessionId) {
            reply(false, { message: made.message ?? '新建会话失败' })
            return
          }
          reply(true, { data: { sessionId: made.sessionId } })
          // 状态变了就要额外推一次列表（F8）：手机新建完回到列表时那条会话必须已经在，
          // 靠 15 秒的兜底刷新等它出现是不可接受的。
          void this.pushSessions('new-session')
          return
        }
        case 'cmd.session_history': {
          // 能力缺失时**明确拒绝**：回一张空页在手机上是"这个会话没内容"，
          // 那是一个会让人查错方向的假事实。能力面差异是真实存在的（见 KernelPort）。
          const read = this.kernel.readHistory
          if (!read) {
            reply(false, { message: '主机这一代不支持读取历史（内核端口没有 readHistory 能力）' })
            return
          }
          const page = await read.call(this.kernel, cmd.sessionId, {
            ...(cmd.beforeSeq === undefined ? {} : { beforeSeq: cmd.beforeSeq }),
            limit: cmd.limit ?? HISTORY_LIMIT,
          })
          // 条目走**与实时流同一批出站构造器**：形状一致才谈得上"同一套渲染路径"。
          const items: HistoryItem[] = []
          for (const event of page.events) {
            const item = historyWireItem(event)
            if (item) items.push(item)
          }
          this.replyTo(
            conversationId,
            sessionHistory({
              sessionId: cmd.sessionId,
              cmdId: cmd.cmdId,
              items,
              ...(page.nextBeforeSeq === undefined ? {} : { nextBeforeSeq: page.nextBeforeSeq }),
            }),
          )
          return
        }
      }
    } catch (error) {
      // 兜底回执：手机端至少要看到"这条命令失败了"，否则 UI 会静默卡在原地。
      // cmdId 一定回原值，因为对答靠它匹配。
      reply(false, { message: messageOf(error) })
    }
  }

  /**
   * 出站计数（进 status.json 的 `outbound`）。
   *
   * 为什么必须有：真机取证时手机报"没收到工具行"，第一件要分清楚的事是
   * **插件到底没发，还是发了但路上丢了**。没有这组计数，这个问题只能靠猜。
   * `*_no_peer` 是"发了但回执说没有对端"，那是另一种故障（配对已经不在了）。
   */
  private readonly outboundCount: Record<string, number> = {}
  get stats(): Record<string, number> {
    return { ...this.outboundCount }
  }

  private countOutbound(payload: EvPayload, sent?: boolean): void {
    const key = payload.t.replace(/^ev\./, '')
    this.outboundCount[key] = (this.outboundCount[key] ?? 0) + 1
    if (sent === false) this.outboundCount[`${key}_no_peer`] = (this.outboundCount[`${key}_no_peer`] ?? 0) + 1
  }

  private broadcast(payload: EvPayload): void {
    // 广播也要报"有没有人收到"：只数帧不数对端，就会在真机上出现
    // "计数说发了 4 帧、手机一帧都没收到"这种无从对账的局面。
    this.countOutbound(payload, this.transport.broadcast(payload) > 0)
  }

  private replyTo(conversationId: string, payload: EvPayload): void {
    this.countOutbound(payload, this.transport.reply(conversationId, payload))
  }

  /** 内核事件入口。合帧与顺序规则都在这几行里。 */
  private onKernelEvent(event: KernelEvent): void {
    switch (event.kind) {
      case 'delta': {
        // **一条带正文的 done 必须先把正文推进窗口**。内核没有 token 级增量：一条消息
        // 就是一条完整的 `assistant/message`（正文与 done 同到）。第一版在这里只走
        // `complete()`，而 complete 对"缓冲区里根本没有这条消息"的情形发的是 **done-only 帧**
        // ——于是 `textOf` 辛苦读出来的回复被整个丢掉，手机上收到一帧空文本 + done，
        // 而"⑧ 流式输出到达 / ⑨ 有 done"两条断言照样绿（真机取证抓到的正是这个）。
        if (event.text) this.window.push(event.sessionId, event.messageId, event.text, event.role)
        if (event.done) this.window.complete(event.sessionId, event.messageId, event.role)
        if (event.text) this.sleep.markActive()
        return
      }
      case 'tool':
        // 非 delta 事件之前必须先 flush 同会话缓冲，否则工具行会插进它自己的文本里。
        this.window.flushSession(event.sessionId)
        this.broadcast(toolEvent(event))
        this.sleep.markActive()
        return
      case 'run-state':
        this.window.flushSession(event.sessionId)
        this.broadcast(runState(event))
        if (event.state === 'running') this.sleep.markActive()
        void this.pushSessions('run-state')
        return
      case 'title':
        void this.pushSessions('title')
        return
      case 'sessions-changed':
        void this.pushSessions(event.reason ?? 'changed')
        return
    }
  }

  /**
   * 推一次全量会话列表（F7/F8）。
   *
   * 相邻两次推送之间至少隔一个"合并窗口"，因为内核可以在一个 turn 里连发十几条
   * `sessions-changed`；列表是全量快照，合并掉中间几次没有信息损失。
   *
   * **但"合并"不等于"丢掉"**（第一版就是把它写成了丢掉）：被合并的那一次必须变成一次
   * 尾随推送，否则最后那次变化永远没人告知手机——F8 要求"任何会改变会话状态的动作
   * 之后都必须额外推一条 session_changed"，而手机不看 `ev.result.data.sessions`，
   * 于是"发完指令列表却停在旧状态"最长要等到 15 秒的兜底刷新。
   */
  async pushSessions(reason: string): Promise<SessionSummary[]> {
    if (this.stopped) return this.sessions
    try {
      const listed = await this.kernel.listSessions(LISTING_LIMIT)
      this.sessions = listed.map((item) => item.summary)
    } catch (error) {
      // 读失败时**保留上一次已知的快照**再照常广播：把列表清成空白比停在旧状态更糟
      // （手机会以为会话全没了），而 keep_awake 那一侧的状态仍然必须送达（M25）。
      this.log('list sessions failed', { message: messageOf(error), reason })
    }
    // 判窗口用的是"数据到手"的时刻，不是进入函数的时刻：内核读列表可能很慢，
    // 用进入时刻会让一次 400ms 的读直接吃掉整个合并窗口。
    const now = this.clock.now()
    const sinceLast = now - this.lastPushAt
    if (sinceLast < SESSION_MERGE_MS && reason !== 'start' && reason !== 'list') {
      this.mergePendingReason = reason
      if (this.mergeTimer === undefined) {
        this.mergeTimer = this.clock.setTimeout(() => {
          this.mergeTimer = undefined
          void this.pushSessions(this.mergePendingReason)
        }, SESSION_MERGE_MS - sinceLast)
      }
      return this.sessions
    }
    this.lastPushAt = now
    if (this.mergeTimer !== undefined) {
      // 这一条全量快照已经把待推的内容覆盖到了，尾随推送不必再发（否则会多发一条重复列表）。
      this.clock.clearTimeout(this.mergeTimer)
      this.mergeTimer = undefined
    }
    this.broadcast(sessionChanged(this.sessions, reason))
    this.broadcast(keepAwakeState(this.sleep.snapshot()))
    return this.sessions
  }

  private refreshLoop(): void {
    if (this.stopped) return
    void this.pushSessions('refresh')
    this.window.flushRound()
    this.refreshTimer = this.clock.setTimeout(() => this.refreshLoop(), this.options.listingRefreshMs)
  }

  // ── 人工交互：审批与提问 ────────────────────────────────────────────

  /**
   * 平台发起一次审批。
   *
   * **没有在线对端就返回 `'decline'`**，让适配器去调平台的 `next()` 把决定权交还桌面 UI；
   * 超时同样返回 `'decline'`（我们已经把卡片发出去了，但手机迟迟没点，
   * 与其替用户决定，不如让桌面去决定）。
   */
  private async onApprovalRequest(info: {
    sessionId: string
    action: string
    reason?: string
    signal?: AbortSignal
  }): Promise<ApprovalDecision> {
    const conversationId = this.pickConversation(info.sessionId)
    if (!conversationId || !this.transport.hasPeer(conversationId)) return 'decline'
    const id = `ap_${randomUUID().slice(0, 8)}`
    this.sleep.hold(id)
    const answered = await new Promise<ApprovalDecision>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        this.pending.delete(id)
        resolve('decline')
      }, this.options.approvalTimeoutMs)
      this.pending.set(id, {
        conversationId,
        sessionId: info.sessionId,
        resolve: (value) => resolve(value === undefined ? 'decline' : (value as ApprovalDecision)),
        timer,
      })
      info.signal?.addEventListener('abort', () => this.settle(id, 'cancelled'), { once: true })
      this.replyTo(
        conversationId,
        permissionRequest({
          requestId: id,
          sessionId: info.sessionId,
          action: info.action,
          ...(info.reason === undefined ? {} : { reason: info.reason }),
          options: APPROVAL_OPTIONS,
        }),
      )
    })
    this.sleep.releaseHold(id)
    // 结算点（settleApproval）已经把手机的 'approve'/'reject' 翻成平台词汇了，
    // 这里不再翻第二次——两处映射表迟早会分叉。
    return answered
  }

  private async onQuestionRequest(info: {
    sessionId: string
    questions: QuestionItem[]
    signal?: AbortSignal
  }): Promise<AskUserQuestionAnswerValue | null> {
    const conversationId = this.pickConversation(info.sessionId)
    if (!conversationId || !this.transport.hasPeer(conversationId)) return null
    const id = `q_${randomUUID().slice(0, 8)}`
    this.sleep.hold(id)
    const answer = await new Promise<AskUserQuestionAnswerValue | null>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, this.options.questionTimeoutMs)
      this.pending.set(id, {
        conversationId,
        sessionId: info.sessionId,
        resolve: (value) => resolve((value as AskUserQuestionAnswerValue | undefined) ?? null),
        timer,
        options: info.questions,
      })
      info.signal?.addEventListener('abort', () => this.settle(id, null), { once: true })
      this.replyTo(
        conversationId,
        questionRequest({
          requestId: id,
          sessionId: info.sessionId,
          questions: info.questions,
        }),
      )
    })
    this.sleep.releaseHold(id)
    return answer
  }

  private settleApproval(requestId: string, decision: string): boolean {
    const item = this.pending.get(requestId)
    if (!item) return false
    // F10：手机逐字回传我们下发的 options[].id；'reject' 之外的一律视为放行一次。
    const outcome: ApprovalDecision = decision === 'reject' ? 'rejected' : 'allowed-once'
    this.settle(requestId, outcome)
    return true
  }

  private settleQuestion(requestId: string, answers: AnswerItem[]): boolean {
    const item = this.pending.get(requestId)
    if (!item) return false
    // 平台的答案里 selected 装的是**选项 label**（不是我们的 id），所以这里要翻回去。
    const byQuestion = new Map((item.options ?? []).map((question) => [question.id, question]))
    const value: AskUserQuestionAnswerValue = {
      answers: answers.map((answer) => {
        const question = byQuestion.get(answer.questionId)
        const selected = (question?.options ?? [])
          .filter((option) => answer.selected.includes(option.id))
          .map((option) => option.label)
        return {
          id: answer.questionId,
          selected,
          ...(answer.freeText === undefined ? {} : { custom: answer.freeText }),
        }
      }),
    }
    this.settle(requestId, value)
    return true
  }

  private settle(id: string, value: unknown): void {
    const item = this.pending.get(id)
    if (!item) return
    this.pending.delete(id)
    this.clock.clearTimeout(item.timer)
    item.resolve(value)
  }

  /**
   * 挑一条配对通道把这轮交互发出去。
   *
   * 为什么不能按 sessionId 精确定位：手机是在**配对通道**上收消息的，
   * 而"哪个 DSH 会话属于哪条通道"只有手机端知道（它按 payload.sessionId 过滤显示）。
   * 现网拓扑恒为 1 host : 1 client，所以"挑一条有对端的通道"就是正解；
   * 将来若真要一个主机配多部手机，需要的是**广播给所有通道**再让手机按 sessionId 过滤。
   */
  private pickConversation(_sessionId: string): string | undefined {
    const ids = this.transport.conversationIds()
    if (ids.length === 0) return undefined
    return ids.find((id) => this.transport.hasPeer(id)) ?? ids[0]
  }

  private log(message: string, fields?: Record<string, string | number | boolean | undefined>): void {
    this.options.log?.(message, fields)
  }
}

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

/**
 * `KernelEvent` → 历史条目。
 *
 * 运行态 / 标题 / 列表变化在历史里没有位置——它们是"此刻"的事，回放历史不该去改顶栏；
 * 返回 `undefined` 由调用方丢掉。
 *
 * `done` 恒为 `true`：历史里的消息是**已经写完的**。不置的话手机上正文末尾会挂着一个
 * 一直闪的光标，看起来像还在生成。
 */
function historyWireItem(event: KernelEvent): HistoryItem | undefined {
  if (event.kind === 'delta') {
    return messageDelta({
      messageId: event.messageId,
      delta: event.text,
      done: true,
      ...(event.role === undefined ? {} : { role: event.role }),
    })
  }
  if (event.kind === 'tool') {
    return toolEvent({
      callId: event.callId,
      phase: event.phase,
      ...(event.tool === undefined ? {} : { tool: event.tool }),
      ...(event.title === undefined ? {} : { title: event.title }),
      ...(event.argsPreview === undefined ? {} : { argsPreview: event.argsPreview }),
      ...(event.resultPreview === undefined ? {} : { resultPreview: event.resultPreview }),
    })
  }
  return undefined
}
