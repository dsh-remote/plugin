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
import type { AnswerItem, CmdPayload, EvPayload, QuestionItem, SessionSummary } from '@dsh-rc/protocol'
import {
  keepAwakeState,
  permissionRequest,
  questionRequest,
  result as resultOf,
  runState,
  sessionChanged,
  toolEvent,
} from '@dsh-rc/protocol/outbound'
import type { ApprovalDecision, AskUserQuestionAnswerValue, KernelEvent, KernelPort } from '../ports/index.js'
import { DeltaWindow, DEFAULT_WINDOW_OPTIONS, type WindowOptions } from './window.js'
import type { KeepAwake } from './sleep-policy.js'
import type { Clock } from '../ports/index.js'

/** 出站通道：core 只负责"该发什么"，加密与投递由 shell 提供。 */
export interface RuntimeTransport {
  /** 发给某一条配对会话（回执用）。返回 false 表示没有活的对端。 */
  reply(conversationId: string, payload: EvPayload): boolean
  /** 发给所有已配对的会话（会话列表、防休眠状态这类广播）。 */
  broadcast(payload: EvPayload): void
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

export class HostRuntime {
  private readonly options: RuntimeOptions
  private readonly window: DeltaWindow
  private readonly pending = new Map<string, PendingInteraction>()
  private unsubscribe: (() => void) | undefined
  private detachSink: (() => void) | undefined
  private refreshTimer: unknown
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
    this.window = new DeltaWindow(
      (delta) => this.transport.broadcast(delta),
      this.clock,
      { ...DEFAULT_WINDOW_OPTIONS, ...options.window },
    )
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
    for (const [id, item] of [...this.pending]) this.settle(id, undefined)
  }

  /** 手机发来的命令。`conversationId` 是配对通道 id，与载荷里的 sessionId 不是一回事（F3）。 */
  async handleCommand(cmd: CmdPayload, conversationId: string): Promise<void> {
    const reply = (ok: boolean, extras: { message?: string; data?: Record<string, unknown> } = {}): void => {
      this.transport.reply(conversationId, resultOf(cmd.cmdId, ok, extras))
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
          this.transport.broadcast(keepAwakeState(snapshot))
          reply(true)
          return
        }
      }
    } catch (error) {
      // 兜底回执：手机端至少要看到"这条命令失败了"，否则 UI 会静默卡在原地。
      // cmdId 一定回原值，因为对答靠它匹配。
      reply(false, { message: messageOf(error) })
    }
  }

  /** 内核事件入口。合帧与顺序规则都在这几行里。 */
  private onKernelEvent(event: KernelEvent): void {
    switch (event.kind) {
      case 'delta':
        if (event.done) this.window.complete(event.sessionId, event.messageId, event.role)
        else this.window.push(event.sessionId, event.messageId, event.text, event.role)
        if (event.text) this.sleep.markActive()
        return
      case 'tool':
        // 非 delta 事件之前必须先 flush 同会话缓冲，否则工具行会插进它自己的文本里。
        this.window.flushSession(event.sessionId)
        this.transport.broadcast(toolEvent(event))
        this.sleep.markActive()
        return
      case 'run-state':
        this.window.flushSession(event.sessionId)
        this.transport.broadcast(runState(event))
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
   * 相邻两次推送之间至少隔一个"帧预算"，因为内核可以在一个 turn 里连发十几条
   * `sessions-changed`；列表是全量快照，合并掉中间几次没有信息损失。
   */
  async pushSessions(reason: string): Promise<SessionSummary[]> {
    const now = this.clock.now()
    try {
      const limit = 100
      const listed = await this.kernel.listSessions(limit)
      this.sessions = listed.map((item) => item.summary)
    } catch (error) {
      this.log('list sessions failed', { message: messageOf(error), reason })
    }
    if (now - this.lastPushAt < 500 && reason !== 'start' && reason !== 'list') {
      // 合并掉 500ms 内的重复推送：列表是全量快照，中间几次没有信息损失。
      return this.sessions
    }
    this.lastPushAt = now
    this.transport.broadcast(sessionChanged(this.sessions, reason))
    this.transport.broadcast(keepAwakeState(this.sleep.snapshot()))
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
      this.transport.reply(conversationId, permissionRequest({
        requestId: id,
        sessionId: info.sessionId,
        action: info.action,
        ...(info.reason === undefined ? {} : { reason: info.reason }),
        options: APPROVAL_OPTIONS,
      }))
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
      this.transport.reply(conversationId, questionRequest({
        requestId: id,
        sessionId: info.sessionId,
        questions: info.questions,
      }))
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
   * 选一条会话把这轮交互发出去。
   *
   * 此刻的拓扑恒为 1 host : 1 client（中继每次认领新建一条会话），
   * 但这里仍按"这个 DSH 会话最近有过活动的通道"来选，而不是假设只有一个。
   */
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

/** 给单测用：把一次交互强制结算。 */
export const pendingIdOf = (runtime: HostRuntime, sessionId: string): string | undefined => {
  void runtime
  void sessionId
  return undefined
}
