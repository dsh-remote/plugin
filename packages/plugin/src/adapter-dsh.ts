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

/**
 * The platform's own cordis services, used in-process.
 *
 * This is the primary carrier: a plugin runs INSIDE the Harness, so it can use
 * `ctx.sessions` / `ctx.agents` directly — exactly what the official
 * `@deepseek-ai/dsh-host-apiproxy` does (`ctx.sessions.list()`,
 * `agent.followup(createUserMessage(...))`). No wire protocol is involved for
 * same-process access, and no endpoint names have to be guessed.
 */
export interface InProcServices {
  sessions: {
    list(): Array<Record<string, unknown>>
    get(id: string): Record<string, unknown> | undefined
  }
  /**
   * The complete logical corpus: persisted logs merged with live sessions.
   *
   * `ctx.sessions.list()` only returns what THIS process has loaded, so a
   * conversation you have not opened is invisible there. `listSessions()` is
   * the official listing surface — `@deepseek-ai/dsh-session-query` README:
   * "reads current persistence metadata, merges live records with live
   * precedence, and returns cloned records in deterministic newest-first
   * order. `listSessions()` remains lightweight and does not load logs."
   */
  sessionQuery?: {
    listSessions(signal?: AbortSignal): Promise<SessionRecordLike[]>
    readTitleSnapshots?(
      ids: readonly string[],
      signal?: AbortSignal,
    ): Promise<SessionTitleResultLike[]>
  }
  agents?: {
    get(id: string): Record<string, unknown> | undefined
    list?(): unknown[]
    resume?(options: Record<string, unknown>): Promise<{ agent?: Record<string, unknown> } | undefined>
  }
  /**
   * Owns the registry-global archive set.
   *
   * An archived Session — or a subagent descendant of one — is refused by the
   * host's own `archived-session-gate` on `agent/pre-step`, which the loop ends
   * as `turn/end {reason:{kind:'blocked'}}` BEFORE any model call. So a prompt
   * to an archived session fails silently from the phone's point of view, and
   * the same is true in the desktop UI until the session is restored.
   * @see ctx.workspaceRegistry.archivedSessionIds / unarchiveSession
   */
  workspaceRegistry?: {
    readonly archivedSessionIds?: readonly string[]
    unarchiveSession?(sessionId: string): Promise<void>
    archiveSession?(sessionId: string): Promise<void>
  }
  /**
   * Supplies the deployment default model. A session that has never run a turn
   * has no request header, so the agent loop falls back to this — and if it
   * yields nothing the loop dies with "reading 'provider'".
   */
  agentDefaultModel?: {
    /** official API — see @deepseek-ai/dsh-agent-default-model README */
    currentSelection?(): { provider?: string; model?: string; reasoningEffort?: string } | undefined
  }
  /** cordis event bus */
  on?(event: string, listener: (...args: unknown[]) => void): (() => void) | void
}

export interface ModelSelection {
  provider?: string
  model?: string
  reasoningEffort?: string
}

export interface SessionRecordLike {
  header: { id: string; createdAt?: number; cwd?: string; parentSession?: string; origin?: string }
  /** Whether the id currently exists in `ctx.sessions`. */
  live?: boolean
  /** Whether the persistence backend currently materializes the id. */
  persisted?: boolean
}

export interface SessionTitleResultLike {
  sessionId: string
  status: 'fulfilled' | 'rejected'
  value?: { title?: { title?: string; updatedAt?: number } }
}

/**
 * Every waterfall event in the host composition (verified against desktop
 * rc.6: `agent/pre-step`, `agent/request`, `agent/request-error`,
 * `compaction/summary-error`, `connection/request`, `fs/edit-intent`,
 * `fs/write-intent`, `internal/get`, `internal/set`, `loader/patch-context`,
 * `session-telemetry/record`, `user-questions/request`,
 * `workspace/session-activity`).
 *
 * Observing one of these means PARTICIPATING in it. Read-only integrations
 * must use emit-mode events instead.
 */
export const WATERFALL_EVENTS: ReadonlySet<string> = new Set([
  'agent/pre-step',
  'agent/request',
  'agent/request-error',
  'compaction/summary-error',
  'connection/request',
  'fs/edit-intent',
  'fs/write-intent',
  'internal/get',
  'internal/set',
  'loader/patch-context',
  'session-telemetry/record',
  'user-questions/request',
  'workspace/session-activity',
])

/** Upper bounds for the listing path — a phone list, not an archive dump. */
const MAX_LIST_SESSIONS = 100
const MAX_TITLE_FETCH = 25
const TITLE_TTL_MS = 300_000
const TITLE_FETCH_TIMEOUT_MS = 4_000

export interface KernelBridgeOptions {
  services?: InProcServices | null
  /**
   * Restore an archived session before prompting it. Sending a prompt IS the
   * explicit "I want to use this session" action, and the alternative is a
   * `blocked` turn that looks like a bug. Set false to refuse instead.
   */
  unarchiveOnPrompt?: boolean
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
  private unsubscribe: (() => void) | null = null
  /** archive-set snapshot from the last listing, for diagnostics */
  private archivedCount = 0
  /** sessions restored by us, so the phone can be told what changed */
  private restoredIds = new Set<string>()
  /** event name -> delivery count, for status.json diagnostics */
  private eventCounts = new Map<string, number>()
  /** last payload sample per event name, truncated */
  private eventSamples = new Map<string, string>()
  /** sessionId -> folded title, so a 15s refresh does not re-read logs */
  private titleCache = new Map<string, { title?: string; updatedAt?: number; at: number }>()
  /** which surface produced the current list (diagnostics only) */
  private listingSource = 'unknown'
  /** subagent children seen in the last listing (fenced, hidden from clients) */
  private subagentIds = new Set<string>()
  /** agents this plugin resumed itself — used to attribute agent/error events */
  private resumedIds = new Set<string>()
  /** last error we swallowed — surfaced through status.json */
  lastError: string | null = null

  private unarchiveOnPrompt: boolean

  constructor(private opts: KernelBridgeOptions) {
    this.say = opts.log ?? (() => {})
    this.unarchiveOnPrompt = opts.unarchiveOnPrompt !== false
  }

  /** Ids the registry currently reports as archived. */
  private archivedIds(): Set<string> {
    const raw = this.opts.services?.workspaceRegistry?.archivedSessionIds
    this.archivedCount = Array.isArray(raw) ? raw.length : 0
    return new Set(Array.isArray(raw) ? raw.map(String) : [])
  }

  private fail(what: string, e: unknown): void {
    const err = e as { message?: string; stack?: string } | string
    const msg = typeof err === 'string' ? err : String(err?.message ?? err)
    const where = typeof err === 'string' ? '' : String(err?.stack ?? '').split('\n').slice(1, 5).map((l) => l.trim()).join(' | ')
    this.lastError = `${what}: ${msg}${where ? `\n  ${where}` : ''}`
    this.say(what, e)
  }

  /**
   * Shape probe for status.json. When a kernel face is present but not the
   * shape we expect, "missing member" beats a silent empty list.
   */
  describe(): Record<string, unknown> {
    const keys = (v: unknown): string[] => {
      try {
        return v && typeof v === 'object' ? Object.keys(v as object).slice(0, 40) : []
      } catch {
        return []
      }
    }
    const a = this.opts.apiProxy as Record<string, any> | null | undefined
    const g = this.opts.gateway as Record<string, any> | null | undefined
    const svc = this.opts.services as Record<string, any> | null | undefined
    return {
      carrier: this.carrier,
      lastError: this.lastError,
      events: Object.fromEntries(this.eventCounts),
      eventSamples: Object.fromEntries(this.eventSamples),
      services: svc
        ? {
            keys: keys(svc),
            hasSessionsList: typeof svc.sessions?.list === 'function',
            hasAgents: typeof svc.agents?.get === 'function',
            hasResume: typeof svc.agents?.resume === 'function',
            hasDefaultModel: typeof svc.agentDefaultModel?.currentSelection === 'function',
            hasSessionQuery: typeof svc.sessionQuery?.listSessions === 'function',
            hiddenSubagents: this.subagentIds.size,
            resumedByUs: this.resumedIds.size,
            archivedSessions: this.archivedCount,
            restoredByUs: this.restoredIds.size,
            hasWorkspaceRegistry: typeof svc.workspaceRegistry?.unarchiveSession === 'function',
            defaultSelection: this.defaultSelection(),
            hasTitleSnapshots: typeof svc.sessionQuery?.readTitleSnapshots === 'function',
            listingSource: this.listingSource,
          }
        : null,
      apiProxy: a
        ? {
            keys: keys(a),
            hasSessionsList: typeof a.sessions?.list === 'function',
            hasPrompt: typeof a.sessions?.prompt === 'function',
            hasMux: typeof a.events?.mux === 'function',
            hasRespond: typeof a.respond === 'function',
          }
        : null,
      typertGateway: g
        ? { keys: keys(g), hasWireStream: typeof g.openWireStream === 'function' }
        : null,
    }
  }

  /**
   * Which kernel face we are driving.
   *
   * `services` (in-process cordis services) is preferred: same-process access
   * needs no protocol, and it is what the official API Proxy itself uses.
   * Types
   *
   * Per the official `@deepseek-ai/dsh-api-gateway` README, the host's shared
   * `/api` surface is split: "the handler dispatches claimed endpoints to
   * Gateway and unclaimed endpoints to API Proxy", and only "Business Services
   * extend `TypertRemoteService` and mark methods with `@Remote`" are callable
   * through the Gateway. `SessionStore` is a plain `Service` with no `@Remote`
   * methods, so session listing / prompting live on the **API Proxy** side.
   *
   * Confirmed empirically on desktop rc.6: `session/list` is not a registered
   * endpoint, so the Typert carrier silently returned an empty session list.
   * The Gateway is still used where it IS the documented surface — the
   * incremental `$events` named stream (`openWireStream`).
   */
  get carrier(): 'services' | 'apiproxy' | 'typert' | 'none' {
    if (this.opts.services) return 'services'
    if (this.opts.apiProxy) return 'apiproxy'
    if (this.opts.gateway) return 'typert'
    return 'none'
  }

  watch(emit: (ev: Payload) => void): () => void {
    this.emit = emit
    this.abort = new AbortController()
    if (this.carrier === 'services') this.subscribeServiceEvents()
    else if (this.carrier === 'typert') void this.pumpTypertEvents()
    else if (this.carrier === 'apiproxy') void this.pumpMuxEvents()
    return () => {
      this.unsubscribe?.()
      this.unsubscribe = null
      this.abort?.abort()
      this.abort = null
      this.emit = null
    }
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
      this.fail('mux pump ended', e)
    }
  }

  // ── HarnessBridge implementation ───────────────────────
  async listSessions(): Promise<SessionSummary[]> {
    if (this.carrier === 'services') {
      try {
        return await this.listViaServices()
      } catch (e) {
        this.fail('session listing failed', e)
        return []
      }
    }
    if (this.carrier === 'apiproxy') {
      const api = this.opts.apiProxy as Record<string, any> | null | undefined
      if (typeof api?.sessions?.list !== 'function') {
        this.fail('apiProxy.sessions.list missing', `keys=[${Object.keys(api ?? {}).join(',')}]`)
        return []
      }
      try {
        const res = (await api.sessions.list({})) as { sessions?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
        const rows = Array.isArray(res) ? res : res.sessions ?? []
        return rows.map((s) => ({
          id: String(s.id ?? ''),
          title: typeof s.title === 'string' ? s.title : undefined,
          workspace: typeof s.workspace === 'string' ? s.workspace : undefined,
          state: 'idle',
        }))
      } catch (e) {
        this.fail('sessions.list failed', e)
        return []
      }
    }
    return []
  }

  // ── session listing (services carrier) ─────────────────

  /**
   * List conversations.
   *
   * `ctx.sessionQuery.listSessions()` is preferred: it merges the persisted
   * corpus with live sessions, so a chat created in the DSH UI shows up even
   * though this plugin never opened it. `ctx.sessions.list()` only knows what
   * this process has loaded, which is why a fresh Harness could report a
   * single command session and nothing else.
   */
  private async listViaServices(): Promise<SessionSummary[]> {
    const svc = this.opts.services!
    const all = await this.sessionRecords(svc)
    // Subagent children are fenced by the platform: the official resolver
    // refuses to hand out an owner for them (apiRemoteSubagentOwnershipError),
    // and a prompt lands as turn/end{blocked}. Listing them would only offer
    // the phone rows that cannot be driven, so they are hidden — but counted,
    // so the omission is visible in status.json instead of looking like loss.
    this.subagentIds.clear()
    const records = all.filter((r) => {
      if (r.header.origin !== 'subagent') return true
      this.subagentIds.add(String(r.header.id))
      return false
    })
    const titles = await this.titlesFor(records.map((r) => String(r.header.id)))
    const archived = this.archivedIds()

    return records.slice(0, MAX_LIST_SESSIONS).map((r) => {
      const id = String(r.header.id)
      const running = this.isRunning(svc, id)
      const t = titles.get(id)
      const isArchived = archived.has(id)
      return {
        id,
        title: t?.title,
        workspace: r.header.cwd,
        createdAt: r.header.createdAt ? new Date(r.header.createdAt).toISOString() : undefined,
        updatedAt: t?.updatedAt ? new Date(t.updatedAt).toISOString() : undefined,
        running,
        // `archived` wins over the others: it is the one state that makes a
        // prompt impossible, and the phone must not have to guess why a turn
        // produced nothing.
        // `detached` = persisted but not loaded in this process; it is still
        // openable (the kernel resumes it on demand), just not live yet.
        state: isArchived ? 'archived' : running ? 'running' : r.live === false ? 'detached' : 'idle',
        ...(r.header.origin === 'subagent' ? { origin: 'subagent' } : {}),
      }
    })
  }

  private isRunning(svc: InProcServices, id: string): boolean {
    try {
      const agent = svc.agents?.get?.(id) as { status?: string } | undefined
      return agent?.status === 'running'
    } catch {
      return false
    }
  }

  private async sessionRecords(svc: InProcServices): Promise<SessionRecordLike[]> {
    const q = svc.sessionQuery
    if (typeof q?.listSessions === 'function') {
      try {
        const records = await q.listSessions()
        if (Array.isArray(records)) {
          this.listingSource = 'sessionQuery.listSessions (persisted + live)'
          return records
            .filter((r) => r && r.header && typeof r.header.id === 'string')
            .sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))
        }
      } catch (e) {
        this.fail('sessionQuery.listSessions failed; falling back to ctx.sessions', e)
      }
    }
    this.listingSource = 'ctx.sessions.list (attached only)'
    const rows = svc.sessions.list() as Array<Record<string, any>>
    return rows.map((s) => {
      const header = (s.header ?? {}) as Record<string, any>
      return {
        header: {
          id: String(s.id),
          createdAt: typeof header.createdAt === 'number' ? header.createdAt : undefined,
          cwd: header.cwd as string | undefined,
          parentSession: header.parentSession as string | undefined,
          origin: header.origin as string | undefined,
        },
        live: true,
        persisted: false,
      }
    })
  }

  /**
   * Fold titles for a batch of ids, cached.
   *
   * Titles live in `session/title` events, so reading them means reading the
   * log. They change rarely, so a cache keeps a 15s session refresh from
   * hammering the disk; misses are remembered too so an untitled session is
   * not retried on every cycle.
   */
  private async titlesFor(ids: string[]): Promise<Map<string, { title?: string; updatedAt?: number }>> {
    const out = new Map<string, { title?: string; updatedAt?: number }>()
    const now = Date.now()
    const missing: string[] = []
    for (const id of ids) {
      const hit = this.titleCache.get(id)
      if (hit && now - hit.at < TITLE_TTL_MS) {
        if (hit.title) out.set(id, { title: hit.title, updatedAt: hit.updatedAt })
      } else {
        missing.push(id)
      }
    }
    const q = this.opts.services?.sessionQuery
    if (missing.length > 0 && typeof q?.readTitleSnapshots === 'function') {
      try {
        const batch = missing.slice(0, MAX_TITLE_FETCH)
        const res = await withTimeout(q.readTitleSnapshots(batch), TITLE_FETCH_TIMEOUT_MS)
        for (const r of res ?? []) {
          if (!r || r.status !== 'fulfilled') continue
          const t = r.value?.title
          const rec = { title: t?.title, updatedAt: t?.updatedAt }
          this.titleCache.set(r.sessionId, { ...rec, at: now })
          if (rec.title) out.set(r.sessionId, rec)
        }
      } catch (e) {
        this.say('readTitleSnapshots failed (listing continues untitled)', e)
      }
    }
    for (const id of missing) if (!this.titleCache.has(id)) this.titleCache.set(id, { at: now })
    return out
  }

  async sendPrompt(sessionId: string, text: string): Promise<{ ok: boolean; message?: string }> {
    if (this.carrier === 'services') {
      const svc = this.opts.services!
      if (typeof svc.agents?.get !== 'function') {
        return { ok: false, message: 'ctx.agents is not available in this composition' }
      }
      const archived = this.archivedIds()
      if (archived.has(sessionId)) {
        const reg = this.opts.services!.workspaceRegistry
        if (!this.unarchiveOnPrompt) {
          return {
            ok: false,
            message:
              'session ' + sessionId + ' is archived; restore it in DSH (设置 → 已归档会话) or ' +
              'enable unarchiveOnPrompt to let this plugin restore it on demand.',
          }
        }
        if (typeof reg?.unarchiveSession !== 'function') {
          return {
            ok: false,
            message:
              'session ' + sessionId + ' is archived and this composition exposes no ' +
              'unarchiveSession; restore it in DSH first.',
          }
        }
        try {
          await reg.unarchiveSession(sessionId)
          this.restoredIds.add(sessionId)
          this.say('unarchived session before prompting', sessionId)
        } catch (e) {
          return {
            ok: false,
            message: 'could not restore archived session ' + sessionId + ': ' + String((e as Error)?.message ?? e),
          }
        }
      }
      if (this.subagentIds.has(sessionId)) {
        return {
          ok: false,
          message:
            'session ' + sessionId + ' is a subagent child session; the host does not hand it to ' +
            'a remote client. Pick a top-level conversation instead.',
        }
      }
      try {
        const { agent, note } = await this.resolveAgent(sessionId)
        if (!agent) {
          return { ok: false, message: note ?? `no agent available for ${sessionId}` }
        }
        const message = await buildUserMessage(text)
        if (typeof agent.followup === 'function') {
          agent.followup(message)
          return { ok: true }
        }
        if (typeof agent.steer === 'function') {
          agent.steer(message)
          return { ok: true }
        }
        return { ok: false, message: `agent exposes neither followup nor steer (keys=[${Object.keys(agent).join(',')}])` }
      } catch (e) {
        return { ok: false, message: String((e as Error)?.message ?? e) }
      }
    }
    if (this.carrier === 'apiproxy') {
      const api = this.opts.apiProxy as Record<string, any> | null | undefined
      if (typeof api?.sessions?.prompt !== 'function') {
        return { ok: false, message: `apiProxy.sessions.prompt missing (keys=[${Object.keys(api ?? {}).join(',')}])` }
      }
      try {
        await api.sessions.prompt({
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
    return { ok: false, message: 'no usable DSH kernel face (session.* lives on the API Proxy)' }
  }

  async interrupt(sessionId: string): Promise<{ ok: boolean; message?: string }> {
    if (this.carrier === 'services') {
      try {
        const agent = this.opts.services!.agents?.get(sessionId) as Record<string, any> | undefined
        if (!agent) return { ok: false, message: `no live agent for ${sessionId}` }
        if (typeof agent.abort === 'function') {
          agent.abort()
          return { ok: true }
        }
        if (typeof agent.interrupt === 'function') {
          agent.interrupt()
          return { ok: true }
        }
        return { ok: false, message: `agent cannot be interrupted (keys=[${Object.keys(agent).join(',')}])` }
      } catch (e) {
        return { ok: false, message: String((e as Error)?.message ?? e) }
      }
    }
    if (this.carrier === 'apiproxy') {
      const api = this.opts.apiProxy as Record<string, any> | null | undefined
      if (typeof api?.sessions?.cancel !== 'function') {
        return { ok: false, message: 'apiProxy.sessions.cancel missing' }
      }
      try {
        await api.sessions.cancel({ sessionId })
        return { ok: true }
      } catch (e) {
        return { ok: false, message: String((e as Error)?.message ?? e) }
      }
    }
    return { ok: false, message: 'no usable DSH kernel face (session.* lives on the API Proxy)' }
  }

  async resolvePermission(sessionId: string, requestId: string, decision: string, note?: string): Promise<{ ok: boolean; message?: string }> {
    const r = this.respondables.get(requestId)
    if (!r || r.sessionId !== sessionId) return { ok: false, message: 'permission request not pending (or from another session)' }
    this.respondables.delete(requestId)
    const outcome = decision === 'reject' ? 'rejected' : 'allowed-once'
    if (this.carrier === 'apiproxy') {
      const api = this.opts.apiProxy as Record<string, any> | null | undefined
      if (typeof api?.respond !== 'function') return { ok: false, message: 'apiProxy.respond missing' }
      try {
        await api.respond({
          type: 'client-response',
          rpcId: r.token,
          result: { ok: true, value: { sessionId, approvalId: requestId, outcome } },
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, message: String((e as Error)?.message ?? e) }
      }
    }
    return { ok: false, message: 'no usable DSH kernel face (session.* lives on the API Proxy)' }
  }

  async answer(sessionId: string, requestId: string, answers: unknown[]): Promise<{ ok: boolean; message?: string }> {
    const r = this.respondables.get(requestId)
    if (!r || r.sessionId !== sessionId) return { ok: false, message: 'question not pending' }
    this.respondables.delete(requestId)
    if (this.carrier === 'apiproxy') {
      const api = this.opts.apiProxy as Record<string, any> | null | undefined
      if (typeof api?.respond !== 'function') return { ok: false, message: 'apiProxy.respond missing' }
      try {
        await api.respond({
          type: 'client-response',
          rpcId: r.token,
          result: { ok: true, value: { sessionId, answer: JSON.stringify(answers) } },
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, message: String((e as Error)?.message ?? e) }
      }
    }
    return { ok: false, message: 'no usable DSH kernel face (session.* lives on the API Proxy)' }
  }

  /** Deployment default model, as status.json diagnostics. */
  private defaultSelection(): string {
    try {
      const sel = this.opts.services?.agentDefaultModel?.currentSelection?.()
      return sel?.provider && sel.model ? sel.provider + '/' + sel.model : '(none)'
    } catch (e) {
      return '(threw: ' + String((e as Error)?.message ?? e) + ')'
    }
  }

  /** Resolve a live agent, resuming a cold session with the default model. */
  private async resolveAgent(
    sessionId: string,
  ): Promise<{ agent: Record<string, any> | null; note?: string }> {
    const res = await resolveAgentFrom(this.opts.services!, sessionId)
    if (res.note) this.say(`resolveAgent(${sessionId}): ${res.note}`)
    if (res.agent && res.note) this.resumedIds.add(sessionId)
    return res
  }

  /**
   * Subscribe to the platform's own event bus (same process, no wire).
   *
   * WATERFALL EVENTS ARE NEVER OBSERVED. In cordis, `ctx.on(name, fn)` on a
   * waterfall registers a PARTICIPATING listener: whatever it returns replaces
   * the value handed to the next listener. An observer that returns
   * `undefined` therefore erases the chain.
   *
   * That is exactly what happened here: this plugin subscribed to
   * `agent/request`, whose waterfall produces the request config used by
   * `ReactLoopAgent.prepareRequest`. Our listener returned undefined, so
   * `proposedConfig` became undefined and the very next line
   * (`if (!proposedConfig.provider ...)`) threw
   * "Cannot read properties of undefined (reading 'provider')" —
   * for EVERY turn in the process, including the ones started from the DSH
   * desktop UI. A remote-control add-on must never be able to do that.
   */
  private subscribeServiceEvents(): void {
    const svc = this.opts.services
    if (typeof svc?.on !== 'function') {
      this.say('services carrier has no event bus; streaming unavailable')
      return
    }
    const names = [
      'session/event',
      'session/created',
      'agent/status',
      'agent/error',
      'permission/requested',
      'question/requested',
    ]
    const offs: Array<() => void> = []
    for (const name of names) {
      if (WATERFALL_EVENTS.has(name)) {
        // defence in depth: a future edit must not silently break every turn
        this.say('refusing to observe a waterfall event', name)
        continue
      }
      try {
        const off = svc.on(name, (...args: unknown[]) => this.handleServiceEvent(name, args))
        if (typeof off === 'function') offs.push(off)
      } catch {
        /* event not declared in this composition */
      }
    }
    this.unsubscribe = () => {
      for (const off of offs) {
        try {
          off()
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * `session/event(session, event)` — the platform's append-only log feed.
   *
   * Vocabulary verified against a real desktop session log: turn/start,
   * step/start, user/message, assistant/message, tool/call, tool/result,
   * step/end, turn/end, session/title, agent/inbox/spliced, request/header.
   *
   * There is NO token-level delta event in the log, so a reply arrives as one
   * `assistant/message` per step. It is surfaced as a single delta keyed by
   * the event's seq, so a client that appends by messageId still renders a
   * growing message, and `turn/end` closes the run.
   */
  private onSessionEvent(args: unknown[]): void {
    const session = args[0] as Record<string, any> | undefined
    const sessionId = String(session?.id ?? '')
    if (!sessionId) return
    const appended = args[1]
    const batch: Array<Record<string, any>> = Array.isArray(appended)
      ? appended
      : appended && typeof appended === 'object'
        ? [appended as Record<string, any>]
        : []
    for (const ev of batch) this.emitSessionEvent(sessionId, ev)
  }

  private onSessionCreated(args: unknown[]): void {
    const session = args[0] as Record<string, any> | undefined
    if (session?.id) this.say('session created', String(session.id))
  }

  private emitSessionEvent(sessionId: string, ev: Record<string, any>): void {
    const type = String(ev?.type ?? '')
    const data = (ev?.data ?? {}) as Record<string, any>
    const seq = typeof ev?.seq === 'number' ? ev.seq : 0

    if (type === 'turn/start') {
      this.emit?.({ t: 'ev.run_state', sessionId, state: 'running' })
      return
    }
    if (type === 'assistant/message') {
      const text = assistantTextOf(data.message)
      if (text) {
        this.emit?.({ t: 'ev.message_delta', sessionId, messageId: 'm' + seq, part: 0, delta: text, done: false })
      }
      return
    }
    if (type === 'tool/call') {
      this.emit?.({
        t: 'ev.tool_event',
        sessionId,
        callId: String(data.callId ?? data.id ?? 'c' + seq),
        tool: String(data.name ?? data.tool ?? 'tool'),
        phase: 'started',
        title: truncateText(String(data.description ?? ''), 120),
        argsPreview: previewOf(data.arguments ?? data.args ?? data.argsPreview),
      })
      return
    }
    if (type === 'tool/result') {
      const failed = data.ok === false || data.error !== undefined
      this.emit?.({
        t: 'ev.tool_event',
        sessionId,
        callId: String(data.callId ?? data.id ?? 'c' + seq),
        tool: String(data.name ?? data.tool ?? 'tool'),
        phase: failed ? 'failed' : 'completed',
        resultPreview: previewOf(data.result ?? data.output ?? data.error),
      })
      return
    }
    if (type === 'turn/end') {
      const reason = String((data.reason && data.reason.kind) || '') || undefined
      // close the message, then the run — order matters for the phone UI
      this.emit?.({ t: 'ev.message_delta', sessionId, messageId: 'turn', part: 0, delta: '', done: true })
      this.emit?.({ t: 'ev.run_state', sessionId, state: 'idle', detail: reason })
      return
    }
  }

  private handleServiceEvent(name: string, args: unknown[]): void {
    this.eventCounts.set(name, (this.eventCounts.get(name) ?? 0) + 1)
    if (this.eventSamples.size < 12) this.eventSamples.set(name, safeSample(args))
    try {
      if (name === 'session/event') this.onSessionEvent(args)
      else if (name === 'session/created') this.onSessionCreated(args)
      else if (name === 'permission/requested') this.handleNativeEvent('permission/requested', args as never)
      else if (name === 'question/requested') this.handleNativeEvent('question/requested', args as never)
      else if (name === 'agent/status') {
        // declared as (agent, status) — be tolerant about the first argument
        const [subject, status] = args as [Record<string, any>, unknown]
        const sessionId = String(
          subject?.id ?? subject?.sessionId ?? subject?.session?.id ?? '',
        )
        const running = status === 'running' || subject?.status === 'running'
        if (sessionId) {
          this.emit?.({ t: 'ev.run_state', sessionId, state: running ? 'running' : 'idle' })
        }
      } else if (name === 'agent/error') {
        // declared payload: { agent, turn, step, error }
        const payload = (args[0] ?? {}) as Record<string, any>
        const err = payload.error as { message?: string; stack?: string } | undefined
        const text = String(err?.message ?? err ?? 'unknown agent error')
        // Attribution matters: "reading 'provider'" is thrown by the platform's
        // OWN loop when an agent was built without loop options, and the same
        // text appears whether the turn came from the desktop UI or from us.
        const agentId = String(payload.agent?.id ?? payload.agent ?? payload.sessionId ?? '')
        const ours = this.resumedIds.size > 0 && (this.resumedIds.has(agentId) || !agentId)
        const agentOptions = payload.agent?.options as { provider?: string; model?: string } | undefined
        const who =
          'agent=' + (agentId || '?') +
          ' ours=' + String(ours) +
          ' agentOptions=' + (agentOptions ? JSON.stringify({ provider: agentOptions.provider, model: agentOptions.model }) : '(absent)')
        // keep the stack: "reading 'provider'" is useless without the frame
        const where = String(err?.stack ?? '')
          .split('\n')
          .slice(0, 6)
          .map((l) => l.trim())
          .join(' | ')
        this.lastError = `agent error (turn ${payload.turn}, step ${payload.step}): ${text}\n  ${who}${where ? `\n  ${where}` : ''}`
        this.say('agent error event', text)
      }
    } catch (e) {
      this.fail(`event ${name} handling failed`, e)
    }
  }
}

/** Build a user message with the platform's own helper when reachable. */
async function buildUserMessage(text: string): Promise<unknown> {
  try {
    const mod = (await import('@deepseek-ai/dsh-llm' as string)) as {
      createUserMessage?: (x: unknown) => unknown
    }
    if (typeof mod.createUserMessage === 'function') {
      return mod.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    }
  } catch {
    /* fall through to the plain shape */
  }
  return {
    id: 'drc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * Join the visible text parts of one assistant message.
 *
 * Reasoning parts are deliberately dropped: they are chain-of-thought, not
 * output, and shipping them to a phone would be both noisy and leaky.
 */
function assistantTextOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => (part as { type?: string } | undefined)?.type === 'text')
    .map((part) => String((part as { text?: string } | undefined)?.text ?? ''))
    .join('')
}

function truncateText(text: string, max: number): string | undefined {
  if (!text) return undefined
  return text.length > max ? text.slice(0, max - 1) + '\u2026' : text
}

function previewOf(v: unknown): string | undefined {
  try {
    const text = typeof v === 'string' ? v : JSON.stringify(v)
    return truncateText(String(text ?? ''), 200)
  } catch {
    return undefined
  }
}

/**
 * Compact, size-bounded sample of an event payload for status.json.
 * Returns a STRING always — JSON.parse round-tripping here used to turn every
 * circular payload into the useless literal "[unserialisable]".
 */
function safeSample(args: unknown[]): string {
  try {
    const seen = new WeakSet<object>()
    const text = JSON.stringify(args, (_k, v) => {
      if (typeof v === 'function') return '[fn]'
      if (typeof v === 'string' && v.length > 200) return v.slice(0, 200) + '…'
      if (v && typeof v === 'object') {
        if (seen.has(v as object)) return '[circular]'
        seen.add(v as object)
      }
      return v
    })
    if (typeof text !== 'string') return `[${typeof args[0]}]`
    return text.length > 1600 ? text.slice(0, 1600) + '…' : text
  } catch (e) {
    return `[unserialisable: ${String((e as Error)?.message ?? e)}]`
  }
}

/** The model a session's loop will call, taken from its own request header. */
function selectionOfAgent(agent: Record<string, any> | undefined): ModelSelection | undefined {
  try {
    const logged = (agent?.session as { requestHeader?(): { config?: Record<string, any> } } | undefined)
      ?.requestHeader?.()?.config
    if (logged?.provider) {
      return {
        provider: logged.provider,
        model: logged.model,
        ...(logged.reasoningEffort ? { reasoningEffort: logged.reasoningEffort } : {}),
      }
    }
  } catch {
    /* the session face differs per generation */
  }
  return undefined
}

/**
 * Resolve the agent for one session, mirroring the platform's own resolver
 * (`createApiRemoteAgentResolver` in `@deepseek-ai/dsh-api-remotes`):
 *
 *  1. a LIVE agent is used as-is;
 *  2. otherwise the session is inspected and RESUMED with the deployment's
 *     default model (`ctx.agentDefaultModel.currentSelection()`).
 *
 * The deviation is that we REFUSE instead of starting a doomed turn. An agent
 * whose loop carries no model dies inside `prepareRequest` with
 * "Cannot read properties of undefined (reading 'provider')", which reaches
 * the phone as an opaque "本输运行失败". The official `turnAgentFor` refuses this
 * case too (`model-unavailable`); we refuse it with text a human can act on.
 */
export async function resolveAgentFrom(
  services: InProcServices,
  sessionId: string,
): Promise<{ agent: Record<string, any> | null; note?: string }> {
  let fallback: ModelSelection | undefined
  try {
    fallback = services.agentDefaultModel?.currentSelection?.()
  } catch {
    fallback = undefined
  }
  const agentOptions =
    fallback?.provider && fallback.model
      ? {
          provider: fallback.provider,
          model: fallback.model,
          ...(fallback.reasoningEffort ? { reasoningEffort: fallback.reasoningEffort } : {}),
        }
      : undefined

  const live = services.agents?.get?.(sessionId) as Record<string, any> | undefined
  if (live) {
    const selection = selectionOfAgent(live) ?? fallback
    if (!selection?.provider) {
      return {
        agent: null,
        note:
          'Session ' + sessionId + ' has no model: it never ran a turn and this deployment ' +
          'exposes no usable default selection. Open the session in DSH and pick a model, ' +
          'or use a session that has actually been chatted in.',
      }
    }
    return { agent: live }
  }

  if (typeof services.agents?.resume !== 'function') {
    return { agent: null, note: 'ctx.agents.resume is unavailable in this composition' }
  }
  try {
    const resumed = await services.agents.resume({ resumeSessionId: sessionId, agentOptions })
    const agent = (resumed?.agent as Record<string, any> | undefined) ?? null
    return agent
      ? { agent, note: 'resumed cold session' }
      : { agent: null, note: 'resume returned no agent for ' + sessionId }
  } catch (e) {
    return { agent: null, note: 'resume failed for ' + sessionId + ': ' + String((e as Error)?.message ?? e) }
  }
}

/** Resolve after `ms` at the latest, so a stalled kernel call cannot wedge a listing. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p,
    new Promise<undefined>((resolve) => {
      const t = setTimeout(() => resolve(undefined), ms)
      t.unref?.()
    }),
  ])
}
