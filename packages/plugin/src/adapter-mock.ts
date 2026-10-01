/**
 * MockHarnessBridge — an in-memory DSH harness for tests and the e2e demo.
 * Emits realistic event payloads: deltas, tool events, permission request
 * (awaiting resolve), ask_user question (awaiting answer).
 */
import type { SessionSummary, Payload } from '@dsh-rc/protocol'
import { randomUUID } from 'node:crypto'
import type { HarnessBridge } from './bridge.js'

export class MockHarnessBridge implements HarnessBridge {
  private emit: ((ev: Payload) => void) | null = null
  private sessions: SessionSummary[] = [
    { id: 'ses_mock1', title: 'mock: 周报生成', workspace: '/tmp/weekly', state: 'idle', updatedAt: new Date().toISOString() },
    { id: 'ses_mock2', title: 'mock: 数据管道修复', workspace: '/tmp/etl', state: 'idle' },
  ]
  pendingPermissions = new Map<string, { sessionId: string; requestId: string }>()
  pendingQuestions = new Map<string, { sessionId: string; requestId: string }>()
  receivedPrompts: Array<{ sessionId: string; text: string }> = []

  async listSessions() {
    return this.sessions
  }
  watch(emit: (ev: Payload) => void) {
    this.emit = emit
    return () => { this.emit = null }
  }
  private send(ev: Payload) { this.emit?.(ev) }

  async sendPrompt(sessionId: string, text: string) {
    this.receivedPrompts.push({ sessionId, text })
    const s = this.sessions.find((x) => x.id === sessionId)
    if (!s) return { ok: false, message: 'no such session' }
    s.state = 'running'
    s.running = true
    this.send({ t: 'ev.run_state', sessionId, state: 'running' })
    const messageId = 'msg_' + randomUUID().slice(0, 6)
    // async fake run: deltas -> tool -> permission request -> pause
    void (async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 30))
        this.send({ t: 'ev.message_delta', sessionId, messageId, part: i, delta: `段${i}(${text.slice(0, 8)})` })
      }
      this.send({ t: 'ev.tool_event', sessionId, callId: 'call_1', tool: 'bash', phase: 'started', title: `echo ${text.slice(0, 12)}` })
      const requestId = 'perm_' + randomUUID().slice(0, 6)
      this.pendingPermissions.set(requestId, { sessionId, requestId })
      s.state = 'awaiting-permission'
      this.send({
        t: 'ev.permission_request', sessionId, requestId,
        action: 'bash', resource: `echo ${text.slice(0, 12)}`,
        reason: '命令不在白名单，需要批准',
        options: [
          { id: 'approve', label: '允许一次' },
          { id: 'approve_session', label: '本会话允许' },
          { id: 'reject', label: '拒绝' },
        ],
      })
    })()
    return { ok: true }
  }

  async answer(sessionId: string, requestId: string, answers: unknown[]) {
    const q = this.pendingQuestions.get(requestId)
    if (!q || q.sessionId !== sessionId) return { ok: false, message: 'unknown question' }
    this.pendingQuestions.delete(requestId)
    this.send({ t: 'ev.result', cmdId: 'srv', ok: true, data: { answered: requestId, answers } })
    return { ok: true }
  }

  async resolvePermission(sessionId: string, requestId: string, decision: string) {
    const p = this.pendingPermissions.get(requestId)
    if (!p || p.sessionId !== sessionId) return { ok: false, message: 'unknown permission request' }
    this.pendingPermissions.delete(requestId)
    const s = this.sessions.find((x) => x.id === sessionId)
    if (s) { s.state = 'running'; s.running = true }
    this.send({ t: 'ev.run_state', sessionId, state: 'running', detail: `permission ${decision}` })
    // finish the run
    void (async () => {
      await new Promise((r) => setTimeout(r, 30))
      this.send({ t: 'ev.tool_event', sessionId, callId: 'call_1', tool: 'bash', phase: decision === 'reject' ? 'failed' : 'completed', resultPreview: decision === 'reject' ? 'rejected by user' : 'ok' })
      this.send({ t: 'ev.message_delta', sessionId, messageId: 'msg_fin', part: 0, delta: decision === 'reject' ? '已按你的拒绝停止操作。' : '任务完成 ✅', done: true })
      if (s) { s.state = 'idle'; s.running = false }
      this.send({ t: 'ev.run_state', sessionId, state: 'idle' })
    })()
    return { ok: true }
  }

  async interrupt(sessionId: string) {
    const s = this.sessions.find((x) => x.id === sessionId)
    if (s) { s.state = 'idle'; s.running = false }
    this.send({ t: 'ev.run_state', sessionId, state: 'idle', detail: 'interrupted' })
    return { ok: true }
  }

  /** test helper: ask the client a question */
  raiseQuestion(sessionId: string) {
    const requestId = 'q_' + randomUUID().slice(0, 6)
    this.pendingQuestions.set(requestId, { sessionId, requestId })
    this.send({
      t: 'ev.question_request', sessionId, requestId,
      questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ id: 'prod', label: '生产' }, { id: 'staging', label: '预发' }] }],
    })
    return requestId
  }
}
