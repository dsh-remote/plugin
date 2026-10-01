/**
 * HarnessBridge — the seam between the relay plugin and the DSH core.
 *
 * The plugin never reaches into private内核 internals directly; it talks to
 * this interface. Two implementations exist:
 *   - `DshSessionBridge` (adapter-dsh.ts): attaches to the live cordis ctx
 *     (sessions service + session log events + agent steering).
 *   - `MockHarnessBridge` (adapter-mock.ts): in-memory harness for tests/e2e.
 */
import type { SessionSummary, Payload } from '@dsh-rc/protocol'

export interface BridgeEvents {
  onSessionsChanged?: (sessions: SessionSummary[]) => void
  onEvent?: (ev: Payload) => void
  onKeepAwakeState?: () => void
}

export interface HarnessBridge {
  listSessions(): Promise<SessionSummary[]>
  /** send a user prompt into a session (starts/resumes a run) */
  sendPrompt(sessionId: string, text: string): Promise<{ ok: boolean; message?: string }>
  /** answer an outstanding ask_user question */
  answer(sessionId: string, requestId: string, answers: unknown[]): Promise<{ ok: boolean; message?: string }>
  /** approve/reject an outstanding permission request */
  resolvePermission(sessionId: string, requestId: string, decision: string, note?: string): Promise<{ ok: boolean; message?: string }>
  /** interrupt the current run */
  interrupt(sessionId: string): Promise<{ ok: boolean; message?: string }>
  /** start streaming session events into `emit` */
  watch(emit: (ev: Payload) => void): () => void
}

/** Dispatch a decrypted client payload onto the bridge; returns optional result payload. */
export async function handlePayload(
  bridge: HarnessBridge,
  payload: Payload,
): Promise<Payload | null> {
  switch (payload.t) {
    case 'cmd.list_sessions': {
      const sessions = await bridge.listSessions()
      return { t: 'ev.result', cmdId: payload.cmdId, ok: true, data: { sessions } }
    }
    case 'cmd.send_prompt': {
      const r = await bridge.sendPrompt(payload.sessionId, payload.text)
      return { t: 'ev.result', cmdId: payload.cmdId, ok: r.ok, message: r.message }
    }
    case 'cmd.answer': {
      const r = await bridge.answer(payload.sessionId, payload.requestId, payload.answers)
      return { t: 'ev.result', cmdId: payload.cmdId, ok: r.ok, message: r.message }
    }
    case 'cmd.resolve_permission': {
      const r = await bridge.resolvePermission(payload.sessionId, payload.requestId, payload.decision, payload.note)
      return { t: 'ev.result', cmdId: payload.cmdId, ok: r.ok, message: r.message }
    }
    case 'cmd.interrupt': {
      const r = await bridge.interrupt(payload.sessionId)
      return { t: 'ev.result', cmdId: payload.cmdId, ok: r.ok, message: r.message }
    }
    case 'cmd.subscribe':
    default:
      return payload.t === 'cmd.subscribe'
        ? { t: 'ev.result', cmdId: payload.cmdId, ok: true }
        : null
  }
}
