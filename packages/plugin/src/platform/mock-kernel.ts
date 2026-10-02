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
import type { SessionSummary } from '@dsh-rc/protocol'
import type { QuestionItem } from '@dsh-rc/protocol'
import type { ApprovalDecision, AskUserQuestionAnswerValue, Clock, InteractionSink, KernelEvent, KernelPort } from '../ports/index.js'

export interface MockKernelOptions {
  clock: Clock
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  /** 初始会话；不给就有两条默认会话（一条空闲、一条归档），够覆盖列表与恢复路径。 */
  sessions?: SessionSummary[]
  /** 手机发指令时是否自动回放一段流式输出（冒烟测试靠它验证 delta→done）。 */
  autoReply?: boolean
  /** 模拟审批：收到指令后自动挂一次审批请求。 */
  autoApproval?: boolean
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
    this.sessions =
      options.sessions ?? [
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
    if (this.options.autoApproval !== false && this.sink) {
      // 冒烟路径也走一遍真实的交互协议：审批卡、decision 逐字回传、锁续持。
      const decision = await this.sink.approval({ sessionId, action: 'bash echo', reason: 'mock 审批' })
      this.emit({ kind: 'tool', sessionId, callId: `call_${++this.sequence}`, phase: 'started', tool: 'bash', title: 'echo' })
      this.emit({ kind: 'tool', sessionId, callId: `call_${this.sequence}`, phase: 'completed', tool: 'bash', resultPreview: decision })
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

  subscribe(onEvent: (event: KernelEvent) => void): () => void {
    this.listeners.add(onEvent)
    return () => this.listeners.delete(onEvent)
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

  modelSelection(): { provider: string; model: string } | undefined {
    return { provider: 'mock', model: 'mock-model' }
  }

  describe(): Record<string, string | number | boolean> {
    return { carrier: this.carrier, sessions: this.sessions.length, running: this.running.size, sinkAttached: this.sink !== undefined }
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

  async askQuestion(sessionId: string, questions: QuestionItem[]): Promise<AskUserQuestionAnswerValue | null | undefined> {
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
