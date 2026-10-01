/**
 * DshKernelBridge — adapter from live DSH cordis ctx to HarnessBridge.
 *
 * Mount points (proven against the installed rc.2 kernel and the
 * ds-harness-remote reference plugin):
 *  - `ctx.inject([...])` gates activation until carriers exist.
 *  - Typert carrier (`typertGateway`, @deepseek-ai/dsh-api-gateway):
 *      unary  gateway.invoke({namespace,method,args,signal})
 *      streams gateway.openWireStream(endpoint, payload, signal) (rc.1+)
 *              endpoint '$events' carries waterfall approval/request +
 *              user-questions/request; answered via '$events/result'.
 *  - legacy carrier (`apiProxy`): sessions.list/prompt/cancel +
 *      events.mux(req,signal) frames (approval/requested…) + respond().
 *
 * Everything is feature-detected at runtime; the bridge degrades to
 * session-list + prompt-only when the richer faces are missing, and the
 * plugin keeps working with the mock bridge when run standalone.
 */
import type { SessionSummary, Payload } from '@dsh-rc/protocol'
import type { HarnessBridge } from './bridge.js'

/** minimal structural typings — we never import cordis types at build time */
export interface GatewayLike {
  invoke(req: { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<unknown>
  /** rc.1+ wire stream; arity varies (older: (endpoint, payload, signal)) */
  openWireStream?: (...args: unknown[]) => AsyncIterable<unknown>
  wireStream?: { open?: (...args: unknown[]) => AsyncIterable<unknown> }
  supportsCarrier?: boolean
}

export interface ApiProxyLike {
  sessions: {
    list(request?: unknown): Promise<unknown>
    prompt(request: unknown): Promise<unknown>
    cancel(request: unknown): Promise<unknown>
  }
  events: {
    mux(request: unknown, signal?: AbortSignal): AsyncIterable<unknown>
    host(request?: unknown, signal?: AbortSignal): AsyncIterable<unknown>
  }
  respond(message: unknown): Promise<unknown>
  host_describe?(): Promise<unknown>
}

export interface KernelBridgeOptions {
  gateway?: GatewayLike | null
  apiProxy?: ApiProxyLike | null
  log?: (m: string, x?: unknown) => void
}

interface Respondable {
  sessionId: string
  kind: 'approval' | 'question'
  /** typert eventId or mux frame rpcId needed to answer */
  token: string
}

export class DshKernelBridge implements HarnessBridge {
  private emit: ((ev: Payload) => void) | null = null
  private respondables = new Map<string, Respondable>()
  private abort: AbortController | null = null
  private say: (m: string, x?: unknown) => void

  constructor(private opts: KernelBridgeOptions) {
    this.say = opts.log ?? (() => {})
  }

  get carrier(): 'typert' | 'apiproxy' | 'none' {
    if (this.opts.gateway) return 'typert'
    if (this.opts.apiProxy) return 'apiproxy'
    return 'none'
  }

  watch(emit: (ev: Payload) => void): () => void {
    this.emit = emit
    this.abort = new AbortController()
    if (this.carrier === 'typert') void this.pumpTypertEvents()
    else if (this.carrier === 'apiproxy') void this.pumpMuxEvents()
    return () => {
      this.abort?.abort()
      this.abort = null
      this.emit = null
    }
  }

  // ── typert carrier ─────────────────────────────────────
  private async callRc(endpoint: string, args: Record<string, unknown>): Promise<unknown> {
    const gw = this.opts.gateway
    if (!gw) throw new Error('no typert gateway')
    const [namespace, method] = endpoint.split('/')
    return gw.invoke({ namespace: namespace!, method: method!, args, signal: AbortSignal.timeout(30_000) })
  }

  private async pumpTypertEvents(): Promise<void> {
    const gw = this.opts.gateway
    if (!gw?.openWireStream) {
      this.say('typert gateway has no wire stream; approvals via $events unavailable')
      return
    }
    try {
      const stream = gw.openWireStream('$events', { args: {} }, this.abort!.signal)
      for await (const frame of stream) {
        this.handleTypertEventFrame(frame)
      }
    } catch (e) {
      this.say('typert $events pump ended', e)
    }
  }

  private handleTypertEventFrame(frame: unknown): void {
    const f = frame as {
      type?: string
      event?: string
      args?: unknown[]
      eventId?: string
      agentId?: string
      request?: Record<string, unknown>
    }
    if (!f || typeof f !== 'object') return
    if (f.type === 'waterfall' && f.event === 'approval/request' && f.eventId) {
      const req = (f.request ?? {}) as Record<string, unknown>
      const sessionId = String(f.agentId ?? req.sessionId ?? '')
      const requestId = String(f.eventId)
      this.respondables.set(requestId, { sessionId, kind: 'approval', token: requestId })
      this.emit?.({
        t: 'ev.permission_request',
        sessionId,
        requestId,
        action: String(req.tool ?? req.action ?? 'permission'),
        resource: String(req.resource ?? req.command ?? req.description ?? '') || undefined,
        reason: typeof req.reason === 'string' ? req.reason : undefined,
        options: [
          { id: 'approve', label: '允许一次' },
          { id: 'approve_session', label: '本会话允许' },
          { id: 'reject', label: '拒绝' },
        ],
      })
      return
    }
    if (f.type === 'waterfall' && f.event === 'user-questions/request' && f.eventId) {
      const req = (f.request ?? {}) as { questions?: unknown[] }
      const sessionId = String(f.agentId ?? '')
      const requestId = String(f.eventId)
      const questions = (req.questions ?? []).map((q0: unknown, i: number) => {
        const q = q0 as Record<string, unknown>
        return {
          id: String(q.id ?? `q${i}`),
          question: String(q.question ?? ''),
          multi: q.multi_select === true,
          options: Array.isArray(q.options)
            ? (q.options as Array<Record<string, unknown>>).map((o, j) => ({ id: String(o.id ?? j), label: String(o.label ?? '') }))
            : undefined,
        }
      })
      this.respondables.set(requestId, { sessionId, kind: 'question', token: requestId })
      this.emit?.({ t: 'ev.question_request', sessionId, requestId, questions })
      return
    }
    if (f.type === 'cancel' && f.eventId) {
      const r = this.respondables.get(String(f.eventId))
      if (r) {
        this.respondables.delete(String(f.eventId))
        this.emit?.({
          t: 'ev.run_state',
          sessionId: r.sessionId,
          state: r.kind === 'approval' ? 'awaiting-permission' : 'awaiting-answer',
          detail: 'request-cancelled',
        })
      }
      return
    }
    if (f.type === 'emit' && f.event) {
      this.handleNativeEvent(f.event, f.args)
    }
  }

  /** native cordis events forwarded via $events: session/event etc. */
  private handleNativeEvent(event: string, args: unknown): void {
    const arr = Array.isArray(args) ? args : [args]
    if (event === 'session/event') {
      const session = arr[0] as { id?: string } | undefined
      const ev = arr[1] as Record<string, unknown> | undefined
      const sessionId = String(session?.id ?? '')
      const type = String(ev?.type ?? '')
      const payload = (ev?.payload ?? {}) as Record<string, unknown>
      switch (type) {
        case 'message/delta':
        case 'message_delta': {
          this.emit?.({
            t: 'ev.message_delta',
            sessionId,
            messageId: String(payload.messageId ?? 'm'),
            part: Number(payload.part ?? payload.index ?? 0),
            delta: String(payload.delta ?? payload.text ?? ''),
            role: 'assistant',
          })
          return
        }
        case 'message/appended':
        case 'message': {
          // user/assistant message appended — surface user echo + final assistant
          const msg = payload as { role?: string; text?: string; content?: Array<{ type: string; text?: string }> }
          const text =
            typeof msg.text === 'string'
              ? msg.text
              : (msg.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
          if (msg.role === 'user') {
            this.emit?.({ t: 'ev.message_delta', sessionId, messageId: 'u_' + Date.now(), part: 0, delta: text, role: 'user', done: true })
          }
          return
        }
        default:
          return
      }
    }
    if (event === 'session/created' || event === 'session/disposed') {
      this.emit?.({ t: 'ev.session_changed', sessions: [] , reason: event })
    }
  }

  // ── legacy apiProxy carrier ────────────────────────────
  private async pumpMuxEvents(): Promise<void> {
    const api = this.opts.apiProxy
    if (!api) return
    try {
      for await (const frame of api.events.mux({}, this.abort!.signal)) {
        const f = frame as { rpcId?: string | number; payload?: Record<string, unknown> }
        const p = f.payload ?? {}
        const type = String(p.type ?? '')
        const sessionId = String(p.sessionId ?? '')
        if (type === 'approval/requested') {
          const requestId = String(p.approvalId ?? f.rpcId ?? '')
          this.respondables.set(requestId, { sessionId, kind: 'approval', token: String(f.rpcId ?? requestId) })
          this.emit?.({
            t: 'ev.permission_request', sessionId, requestId,
            action: String(p.tool ?? 'permission'),
            resource: String(p.command ?? p.resource ?? '') || undefined,
            reason: typeof p.reason === 'string' ? p.reason : undefined,
            options: [
              { id: 'approve', label: '允许一次' },
              { id: 'approve_session', label: '本会话允许' },
              { id: 'reject', label: '拒绝' },
            ],
          })
        } else if (type === 'question/requested') {
          const requestId = String(f.rpcId ?? p.questionRpcId ?? '')
          const questions = Array.isArray(p.questions) ? (p.questions as unknown[]).map((q0, i) => {
            const q = q0 as Record<string, unknown>
            return { id: String(q.id ?? i), question: String(q.question ?? ''), multi: q.multi_select === true }
          }) : []
          this.respondables.set(requestId, { sessionId, kind: 'question', token: String(f.rpcId ?? '') })
          this.emit?.({ t: 'ev.question_request', sessionId, requestId, questions })
        } else if (type === 'session/event' || type === 'message/delta') {
          this.handleNativeEvent('session/event', [p.session ?? { id: sessionId }, p.event ?? p])
        }
      }
    } catch (e) {
      this.say('mux pump ended', e)
    }
  }

  // ── HarnessBridge implementation ───────────────────────
  async listSessions(): Promise<SessionSummary[]> {
    if (this.carrier === 'typert') {
      try {
        const res = (await this.callRc('session/list', { _request: {} })) as
          | { sessions?: unknown[]; value?: { sessions?: unknown[] } }
          | unknown[]
        const rows = (Array.isArray(res) ? res : (res.sessions ?? (res as { value?: { sessions?: unknown[] } }).value?.sessions ?? [])) as Array<Record<string, unknown>>
        return rows.map((s) => ({
          id: String(s.id ?? s.sessionId ?? ''),
          title: typeof s.title === 'string' ? s.title : undefined,
          workspace: typeof s.workspace === 'string' ? s.workspace : (typeof s.cwd === 'string' ? s.cwd : undefined),
          updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : undefined,
          running: s.busy === true || s.running === true,
          state: String((s as Record<string, unknown>).state ?? ((s as Record<string, unknown>).busy ? 'running' : 'idle')),
        }))
      } catch (e) {
        this.say('session/list failed', e)
        return []
      }
    }
    if (this.carrier === 'apiproxy') {
      try {
        const res = (await this.opts.apiProxy!.sessions.list({})) as { sessions?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
        const rows = Array.isArray(res) ? res : res.sessions ?? []
        return rows.map((s) => ({
          id: String(s.id ?? ''),
          title: typeof s.title === 'string' ? s.title : undefined,
          workspace: typeof s.workspace === 'string' ? s.workspace : undefined,
          state: 'idle',
        }))
      } catch (e) {
        this.say('sessions.list failed', e)
        return []
      }
    }
    return []
  }

  async sendPrompt(sessionId: string, text: string): Promise<{ ok: boolean; message?: string }> {
    if (this.carrier === 'typert') {
      try {
        await this.callRc('session/prompt', {
          request: {
            requestId: 'drc_' + Date.now().toString(36),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
            clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, message: String((e as Error)?.message ?? e) }
      }
    }
    if (this.carrier === 'apiproxy') {
      try {
        await this.opts.apiProxy!.sessions.prompt({
          requestId: 'drc_' + Date.now().toString(36),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, message: String((e as Error)?.message ?? e) }
      }
    }
    return { ok: false, message: 'no DSH carrier available' }
  }

  async interrupt(sessionId: string): Promise<{ ok: boolean; message?: string }> {
    if (this.carrier === 'typert') {
      try {
        await this.callRc('session/cancel', { request: { sessionId } })
        return { ok: true }
      } catch (e) {
        return { ok: false, message: String((e as Error)?.message ?? e) }
      }
    }
    if (this.carrier === 'apiproxy') {
      try {
        await this.opts.apiProxy!.sessions.cancel({ sessionId })
        return { ok: true }
      } catch (e) {
        return { ok: false, message: String((e as Error)?.message ?? e) }
      }
    }
    return { ok: false, message: 'no DSH carrier available' }
  }

  async resolvePermission(sessionId: string, requestId: string, decision: string, note?: string): Promise<{ ok: boolean; message?: string }> {
    const r = this.respondables.get(requestId)
    if (!r || r.sessionId !== sessionId) return { ok: false, message: 'permission request not pending (or from another session)' }
    this.respondables.delete(requestId)
    const outcome = decision === 'reject' ? 'rejected' : 'allowed-once'
    if (this.carrier === 'typert') {
      try {
        // official shape: $events/result {args:{clientId,eventId,outcome}} with
        // outcome = {kind:'result', value} | {kind:'rejected', error}
        await this.callRc('$events/result', {
          args: {
            eventId: r.token,
            outcome: outcome === 'allowed-once'
              ? { kind: 'result', value: outcome }
              : { kind: 'rejected', error: note ?? 'rejected from mobile' },
          },
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, message: String((e as Error)?.message ?? e) }
      }
    }
    if (this.carrier === 'apiproxy') {
      try {
        await this.opts.apiProxy!.respond({
          type: 'client-response',
          rpcId: r.token,
          result: { ok: true, value: { sessionId, approvalId: requestId, outcome } },
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, message: String((e as Error)?.message ?? e) }
      }
    }
    return { ok: false, message: 'no DSH carrier' }
  }

  async answer(sessionId: string, requestId: string, answers: unknown[]): Promise<{ ok: boolean; message?: string }> {
    const r = this.respondables.get(requestId)
    if (!r || r.sessionId !== sessionId) return { ok: false, message: 'question not pending' }
    this.respondables.delete(requestId)
    if (this.carrier === 'typert') {
      try {
        await this.callRc('$events/result', { args: { eventId: r.token, outcome: { kind: 'result', value: { answers } } } })
        return { ok: true }
      } catch (e) {
        return { ok: false, message: String((e as Error)?.message ?? e) }
      }
    }
    if (this.carrier === 'apiproxy') {
      try {
        await this.opts.apiProxy!.respond({
          type: 'client-response',
          rpcId: r.token,
          result: { ok: true, value: { sessionId, answer: JSON.stringify(answers) } },
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, message: String((e as Error)?.message ?? e) }
      }
    }
    return { ok: false, message: 'no DSH carrier' }
  }
}
