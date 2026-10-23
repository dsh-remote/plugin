/**
 * mock-kernel — 内存替身内核。
 *
 * 两个用途，且**只有这两个**：
 * 1. 开发机上没有可用内核面时，让插件仍能完整跑通"配对 → 列表 → 发指令 → 流式输出"，
 *    用来验证传输层与运行时逻辑（这是 `e2e/run.mjs` 那类本地闭环的对面）；
 * 2. 单元测试里当内核替身，不必再手写 cordis 假对象。
 *
 * 一条纪律：它产生的会话 id 一律以 `ses_mock` 开头。真链路验收
 * （`e2e/live-e2e.mjs`）里有专门一条断言"列表里出现 ses_mock 前缀就判失败"——
 * 因为旧实现曾靠自建主机模式假通过，掩盖了"中继说配对成功、主机却把 peer 丢了"
 * 这类真故障（取证 docs/legacy-spec/testing-and-tooling.md §2.4、§4）。
 */
import type { SessionSummary } from '@dsh-remote/protocol'
import type { QuestionItem } from '@dsh-remote/protocol'
import type {
  ApprovalDecision,
  AskUserQuestionAnswerValue,
  Clock,
  InteractionSink,
  KernelEvent,
  KernelHistoryPage,
  KernelPort,
} from '../ports/index.js'
import { HISTORY_WINDOW_EXCEEDED } from '../ports/index.js'

export interface MockKernelOptions {
  clock: Clock
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  /** 初始会话；不给就有两条默认会话（一条空闲、一条归档），够覆盖列表与恢复路径。 */
  sessions?: SessionSummary[]
  /** 手机发指令时是否自动回放一段流式输出（冒烟测试靠它验证 delta→done）。 */
  autoReply?: boolean
  /** 模拟审批：收到指令后自动挂一次审批请求。 */
  autoApproval?: boolean
  /** 假历史（seq 就是下标）。不给就用一份两轮的默认内容，够验证翻页与渲染。 */
  history?: KernelEvent[]
  /**
   * 保留窗口：只保留最近 N 条（模拟内核侧的日志截断）。
   *
   * **存在的理由**：没有它，`since` 落在窗口外那条路径在本地永远走不到
   * ——而"窗口外必须明确报错、不许静默从窗口头部开始给"恰恰是补差量最容易
   * 写错的地方（写错的后果是手机静默缺一段）。
   */
  historyWindow?: number
  /** 读历史时报错（用来验证"能力缺失要明确拒绝，而不是回一张空页"）。 */
  historyError?: string
  /** 新建会话时报错（用来验证"新建失败必须给出可读原因，不许静默"）。 */
  newSessionError?: string
}

/**
 * 默认假历史：两轮，正好覆盖四种块的组合（指令 / 步骤组 / 正文 / 用户消息）。
 * 故意不给 `done` 之外的收尾事件——历史里没有运行态。
 */
function defaultHistory(sessionId: string): KernelEvent[] {
  return [
    { kind: 'delta', sessionId, messageId: 'mock_h1', text: '看看这个项目的完成度', role: 'user', done: true },
    { kind: 'delta', sessionId, messageId: 'mock_h2', text: '我先看一下目录结构。', role: 'assistant', done: true },
    {
      kind: 'tool',
      sessionId,
      callId: 'mock_hc1',
      phase: 'completed',
      tool: 'Bash',
      title: 'ls -la',
      argsPreview: '{"command":"ls -la"}',
      resultPreview: 'total 88',
    },
    { kind: 'delta', sessionId, messageId: 'mock_h3', text: '结构清楚了。', role: 'assistant', done: true },
    { kind: 'delta', sessionId, messageId: 'mock_h4', text: '再跑一遍测试', role: 'user', done: true },
    { kind: 'delta', sessionId, messageId: 'mock_h5', text: '测试全过。', role: 'assistant', done: true },
    // 2026-10-05 补：待办快照也进历史页（wire 1.5.0）。放在最后——一页里最后一条
    // 就是那一页截止时的清单，本地全链路要真的走到这条路径，而不是只在单测里摆帧。
    {
      kind: 'todo',
      sessionId,
      todos: [
        { content: '复现用户报的问题', status: 'completed' },
        { content: '改完跑一遍本地全链路', status: 'in_progress' },
      ],
    },
  ]
}

export class MockKernel implements KernelPort {
  readonly carrier = 'mock'
  private readonly sessions: SessionSummary[]
  private readonly listeners = new Set<(event: KernelEvent) => void>()
  private sink: InteractionSink | undefined
  private readonly running = new Set<string>()
  private sequence = 0
  private readonly options: MockKernelOptions

  constructor(options: MockKernelOptions) {
    this.options = options
    this.sessions = options.sessions ?? [
      { id: 'ses_mock_idle', state: 'idle', title: '冒烟会话', workspace: '/tmp/mock', running: false },
      { id: 'ses_mock_archived', state: 'archived', title: '归档会话', workspace: '/tmp/mock', running: false },
    ]
  }

  async listSessions(limit: number): Promise<{ summary: SessionSummary; live: boolean }[]> {
    return this.sessions.slice(0, limit).map((summary) => ({ summary, live: this.running.has(summary.id) }))
  }

  async runState(sessionId: string): Promise<{ running: boolean; state: SessionSummary['state'] }> {
    const found = this.sessions.find((session) => session.id === sessionId)
    return { running: this.running.has(sessionId), state: found?.state ?? 'idle' }
  }

  async sendPrompt(sessionId: string, text: string): Promise<{ ok: boolean; message?: string }> {
    const found = this.sessions.find((session) => session.id === sessionId)
    if (!found) return { ok: false, message: `会话不存在：${sessionId}` }
    if (found.state === 'archived') return { ok: false, message: '会话已归档，需先恢复' }
    this.running.add(sessionId)
    this.emit({ kind: 'run-state', sessionId, state: 'running' })
    // 待办清单：本地闭环里也真发一遍（内核 `todo/write` 的语义是全量快照，
    // 每次整份替换）。发两份 —— 一份两条待办、一份把第一条标成进行中 ——
    // 这样"清单会变"在本地链路里也是能看见的。
    this.emit({
      kind: 'todo',
      sessionId,
      todos: [
        { content: '复现用户报的问题', status: 'completed' },
        { content: '改完跑一遍本地全链路', status: 'pending' },
      ],
    })
    this.emit({
      kind: 'todo',
      sessionId,
      todos: [
        { content: '复现用户报的问题', status: 'completed' },
        { content: '改完跑一遍本地全链路', status: 'in_progress' },
      ],
    })
    if (this.options.autoApproval !== false && this.sink) {
      // 冒烟路径也走一遍真实的交互协议：审批卡、decision 逐字回传、锁续持。
      const decision = await this.sink.approval({ sessionId, action: 'bash echo', reason: 'mock 审批' })
      this.emit({
        kind: 'tool',
        sessionId,
        callId: `call_${++this.sequence}`,
        phase: 'started',
        tool: 'bash',
        title: 'echo',
      })
      this.emit({
        kind: 'tool',
        sessionId,
        callId: `call_${this.sequence}`,
        phase: 'completed',
        tool: 'bash',
        resultPreview: decision,
      })
    }
    if (this.options.autoReply !== false) {
      const messageId = `msg_${++this.sequence}`
      for (const chunk of [`收到：`, text.slice(0, 40)]) {
        this.emit({ kind: 'delta', sessionId, messageId, text: chunk, done: false })
      }
      this.emit({ kind: 'delta', sessionId, messageId, text: '', done: true })
    }
    this.running.delete(sessionId)
    this.emit({ kind: 'run-state', sessionId, state: 'idle' })
    return { ok: true }
  }

  async interrupt(sessionId: string): Promise<{ ok: boolean; message?: string }> {
    if (!this.running.delete(sessionId)) return { ok: false, message: '这个会话现在没在跑' }
    this.emit({ kind: 'run-state', sessionId, state: 'idle', detail: 'interrupted' })
    return { ok: true }
  }

  /**
   * 假的新建会话：造一个 id、塞进内存列表，行为与真实载体一致（列表里立刻能看见）。
   * 这样"新建 → 列表出现 → 点进去"这条链在本地闭环里能真跑一遍。
   * `newSessionError` 用来演"宿主没有这个能力"那一支。
   *
   * `workspace` **要记进摘要**（2026-10-07）：真载体会把新建那条的 cwd 记进
   * `freshSessions`，下一条列表推送立刻带上它。不记的话，"手机指定的分组真的生效了"
   * 这条判据只能去翻内部状态——而那条链历史上骗过判据（判据只断言"有回执"，
   * 不断言"落在哪"，于是接线漏了也全绿）。
   */
  async newSession(args?: { workspace?: string }): Promise<{ ok: boolean; sessionId?: string; message?: string }> {
    if (this.options.newSessionError) return { ok: false, message: this.options.newSessionError }
    const sessionId = `ses_mock_new_${++this.sequence}`
    const workspace = String(args?.workspace ?? '').trim()
    this.sessions.unshift({
      id: sessionId,
      state: 'idle',
      running: false,
      ...(workspace ? { workspace } : {}),
    })
    return { ok: true, sessionId }
  }

  subscribe(onEvent: (event: KernelEvent) => void): () => void {
    this.listeners.add(onEvent)
    return () => this.listeners.delete(onEvent)
  }

  /**
   * 假历史：`seq` 就是下标，从后往前切一页。
   * 翻页语义与真实载体一致（`beforeSeq` 是**排他**上界、省略游标=到底了），
   * 所以小程序侧的翻页逻辑能在本地闭环里真跑一遍。
   *
   * ## 补差量（`since`，V3-PLAN §7 B1/B4）
   *
   * - `since` 与 `beforeSeq` **互斥**：同时给要抛（协议层已先拒一道，这里是第二道）。
   * - `since` 是**排他下界**（取 `seq > since`）：手机记的就是"已看到的最大 seq"，
   *   把它再发一次就是重复收。
   * - 落在**保留窗口**之外要抛 `history_window_exceeded`，不许静默从窗口头部开始给
   *   ——那样手机会以为补齐了，中间那段永远补不回来。
   */
  async readHistory(
    sessionId: string,
    options: { beforeSeq?: number; since?: number; limit: number },
  ): Promise<KernelHistoryPage> {
    if (this.options.historyError) throw new Error(this.options.historyError)
    if (options.since !== undefined && options.beforeSeq !== undefined) {
      throw new Error('since 与 beforeSeq 互斥：两个方向一起走没有可定义的语义')
    }
    const log = this.options.history ?? defaultHistory(sessionId)
    const window = this.options.historyWindow ?? log.length
    const earliest = Math.max(0, log.length - window)

    // 向前补差量
    if (options.since !== undefined) {
      if (options.since < earliest) {
        // 窗口外：明确说"补不回来"，让手机改拉历史
        throw new Error(`${HISTORY_WINDOW_EXCEEDED}: since=${options.since} 早于窗口起点 ${earliest}`)
      }
      const from = Math.max(earliest, Math.min(log.length, options.since + 1))
      const upTo = Math.min(log.length, from + Math.max(1, options.limit))
      const events = log.slice(from, upTo)
      return {
        events,
        // ⚠️ mock 的 `seq` 就是**下标**（见文件头"假历史：seq 就是下标"），
        // 而 `KernelEvent` 本身不带 seq——真实载体那边 seq 来自内核事件
        // （carrier-services.ts:2162 的 `{seq, events}` 分组）。所以这里按下标算，
        // 别去找 event.seq（找不到，那是 mock 与真实载体的形状差异，不是 bug）。
        latestSeq: events.length > 0 ? upTo - 1 : options.since,
      }
    }

    const upTo = options.beforeSeq === undefined ? log.length : Math.max(0, Math.min(log.length, options.beforeSeq))
    const from = Math.max(0, upTo - Math.max(1, options.limit))
    const events = log.slice(from, upTo)
    return {
      events,
      ...(from > 0 ? { nextBeforeSeq: from } : {}),
      // 空页也要给 latestSeq（手机靠它记"到哪了"）；空页时就是这一页的上界
      latestSeq: events.length > 0 ? upTo - 1 : Math.max(0, upTo - 1),
    }
  }

  attachInteractionSink(sink: InteractionSink): () => void {
    this.sink = sink
    return () => {
      if (this.sink === sink) this.sink = undefined
    }
  }

  async ensureRunnable(sessionId: string): Promise<{ ok: boolean; message?: string }> {
    const found = this.sessions.find((session) => session.id === sessionId)
    if (!found) return { ok: false, message: `会话不存在：${sessionId}` }
    if (found.state === 'archived') {
      found.state = 'idle'
      this.emit({ kind: 'sessions-changed', reason: 'unarchived' })
    }
    return { ok: true }
  }

  /**
   * 归档 / 取消归档（与 `carrier-services` 的同名方法同语义）。
   *
   * mock 也要**如实复现内核那条"运行中拒收"**，否则这一条路径只会在真机上第一次
   * 被走到——而那正是最不该第一次就走到的地方（用户在手机上点归档，
   * 主机上正在跑的任务被停掉）。
   *
   * 与真载体一样：**没有 `stopActivity` 参数**。见 `ports/index.ts` 的注释。
   */
  async archiveSession(sessionId: string, archived: boolean): Promise<{ ok: boolean; message?: string }> {
    const found = this.sessions.find((session) => session.id === sessionId)
    if (!found) return { ok: false, message: `会话不存在：${sessionId}` }
    if (archived && this.running.has(sessionId)) {
      return { ok: false, message: '会话正在运行，不能归档。请先在电脑上让它跑完' }
    }
    found.state = archived ? 'archived' : 'idle'
    this.emit({ kind: 'sessions-changed', reason: archived ? 'archived' : 'unarchived' })
    return { ok: true }
  }

  modelSelection(): { provider: string; model: string } | undefined {
    return { provider: 'mock', model: 'mock-model' }
  }

  describe(): Record<string, string | number | boolean> {
    return {
      carrier: this.carrier,
      sessions: this.sessions.length,
      running: this.running.size,
      sinkAttached: this.sink !== undefined,
    }
  }

  /** 测试/冒烟用：手动注入一条内核事件。 */
  feed(event: KernelEvent): void {
    this.emit(event)
  }

  /** 测试用：让一次审批由外部结算（返回手机回传的 decision）。 */
  async askApproval(sessionId: string, action: string): Promise<ApprovalDecision | undefined> {
    if (!this.sink) return undefined
    return this.sink.approval({ sessionId, action, reason: 'mock 审批' })
  }

  async askQuestion(
    sessionId: string,
    questions: QuestionItem[],
  ): Promise<AskUserQuestionAnswerValue | null | undefined> {
    if (!this.sink) return undefined
    return this.sink.question({ sessionId, questions })
  }

  private emit(event: KernelEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* 一个监听器坏了不能影响其它监听器 */
      }
    }
  }
}

export function createMockKernel(options: MockKernelOptions): KernelPort {
  return new MockKernel(options)
}
