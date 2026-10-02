/**
 * HostRuntime — glues RelayClient + HarnessBridge + KeepAwake together.
 * Runs inside the DSH process (cordis plugin) or standalone with the mock
 * bridge (tests / dsh-TUI-less setups).
 */
import { KeepAwake } from '@dsh-rc/protocol'
import type { Payload, SessionSummary } from '@dsh-rc/protocol'
import { RelayClient } from './relay-client.js'
import { handlePayload, type HarnessBridge } from './bridge.js'

/**
 * Event-stream windowing. A busy turn emits hundreds of tiny deltas; one
 * encrypted frame each is what makes a phone UI stutter and grows every
 * buffer along the path. Merging inside a short window collapses that to
 * ~8 frames/second regardless of model speed, and the caps mean a stuck or
 * pathological stream can never grow without bound.
 */
const DELTA_FLUSH_MS = 120
const MAX_DELTA_CHARS = 4096
const MAX_DELTA_SESSIONS = 32

interface DeltaEntry {
  text: string
  messageId: string
  part: number
  done: boolean
  timer: NodeJS.Timeout | null
}

export interface HostRuntimeConfig {
  serverUrl: string
  hostToken: string
  hostLabel: string
  keepAwakeEnabled?: boolean
  keepAwakeIdleSec?: number
  keepDisplay?: boolean
}

export interface HostRuntimeOptions {
  config: HostRuntimeConfig
  bridge: HarnessBridge
  log?: (msg: string, extra?: unknown) => void
}

export class HostRuntime {
  readonly relay: RelayClient
  readonly keepAwake: KeepAwake
  private bridge: HarnessBridge
  private unwatch: (() => void) | null = null
  /** sessionId -> pending coalesced delta */
  private deltaBuf = new Map<string, DeltaEntry>()
  private say: (m: string, x?: unknown) => void
  private sessionsCache: SessionSummary[] = []

  constructor(opts: HostRuntimeOptions) {
    this.bridge = opts.bridge
    this.say = opts.log ?? ((m, x) => console.log('[drc-host]', m, x ?? ''))
    this.relay = new RelayClient({
      serverUrl: opts.config.serverUrl,
      hostToken: opts.config.hostToken,
      hostLabel: opts.config.hostLabel,
      // NOTE: never `void` an async handler without a catch — an escaping
      // rejection inside the DSH process is far worse than a logged error.
      onPayload: (sessionId, _clientId, payload) => {
        this.onPayload(sessionId, payload).catch((e) => this.say('payload handler failed', e))
      },
      onPeerJoined: (sessionId) => {
        this.say(`client paired into ${sessionId}`)
        this.markActivity('peer-joined')
        // push current session list to the new client
        void this.pushSessions(sessionId)
        this.relay.sendPayload(sessionId, this.keepAwakeStateEvent())
      },
      onPeerLeft: (sessionId) => this.say(`client left ${sessionId}`),
      onStatus: (s) => this.say(`relay status: ${s}`),
      log: this.say,
    })
    this.keepAwake = new KeepAwake({
      idleReleaseMs: (opts.config.keepAwakeIdleSec ?? 300) * 1000,
      keepDisplay: opts.config.keepDisplay ?? false,
      onStateChange: () => {
        this.relay.broadcast(this.keepAwakeStateEvent())
      },
    })
    if (opts.config.keepAwakeEnabled ?? true) this.keepAwake.enable()
  }

  start(): void {
    // A failure here must never take the Harness down: the plugin is an
    // optional add-on, so every startup step is individually guarded.
    try {
      this.relay.start()
    } catch (e) {
      this.say('relay failed to start', e)
    }
    try {
      this.unwatch = this.bridge.watch((ev) => this.forward(ev))
    } catch (e) {
      this.say('bridge.watch failed', e)
    }
    // periodic session refresh (cheap; bridge may be mock)
    const timer = setInterval(() => {
      this.pushSessionsToAll().catch(() => { /* already logged */ })
    }, 15_000)
    timer.unref?.()
  }

  stop(): void {
    this.flushAllDeltas()
    try {
      this.unwatch?.()
    } catch (e) {
      this.say('unwatch failed', e)
    }
    this.unwatch = null
    try {
      this.keepAwake.disable('plugin-stop')
    } catch (e) {
      this.say('keepAwake.disable failed', e)
    }
    try {
      this.relay.stop()
    } catch (e) {
      this.say('relay.stop failed', e)
    }
  }

  createPairing(ttlMs?: number, opts?: { includeToken?: boolean }): { token: string; qr: string } {
    return this.relay.createPairing(ttlMs, opts)
  }

  keepAwakeStateEvent(): Payload {
    return { t: 'ev.keep_awake_state', ...this.keepAwake.state }
  }

  /** TTL the relay actually gave the last pairing (null until reported). */
  get pairingTtlMs(): number | null {
    return this.relay.lastPairTtlMs
  }

  /** Increments whenever we (re)authenticate; a changed value invalidates
   *  anything the caller published before. */
  get relayGeneration(): number {
    return this.relay.connectionGeneration
  }

  /**
   * Forward host events to the right client(s).
   *
   * Streaming deltas are COALESCED: a busy turn can emit hundreds of tiny
   * deltas per second, and forwarding each one as its own encrypted frame is
   * what makes a phone UI stutter (and grows every buffer in the path). We
   * accumulate per session and flush on a short timer, on size, or the moment
   * anything marks the turn as finished.
   */
  private forward(ev: Payload): void {
    this.markActivityFor(ev)

    if (ev.t === 'ev.message_delta') {
      this.bufferDelta(ev)
      return
    }
    // Anything else ends or describes the turn: flush first so ordering holds.
    if ('sessionId' in ev && ev.sessionId) this.flushDelta(ev.sessionId)
    this.emitTo(ev)
  }

  private emitTo(ev: Payload): void {
    if ('sessionId' in ev && ev.sessionId) {
      const targets = this.relay.pairedClients.filter((c) => c.sessionId === ev.sessionId)
      if (targets.length === 0) {
        // events for sessions nobody follows yet: fan out to all clients
        this.relay.broadcast(ev)
        return
      }
      for (const c of targets) this.relay.sendPayload(c.sessionId, ev)
      return
    }
    this.relay.broadcast(ev)
  }

  private bufferDelta(ev: Extract<Payload, { t: 'ev.message_delta' }>): void {
    const key = ev.sessionId
    const cur = this.deltaBuf.get(key)
    if (cur) {
      cur.text += ev.delta
      cur.part = ev.part
      cur.done = cur.done || ev.done === true
    } else {
      // hard cap on concurrently buffered sessions: never grow without bound
      if (this.deltaBuf.size >= MAX_DELTA_SESSIONS) {
        const oldest = this.deltaBuf.keys().next().value
        if (oldest !== undefined) this.flushDelta(oldest)
      }
      this.deltaBuf.set(key, {
        text: ev.delta,
        messageId: ev.messageId,
        part: ev.part,
        done: ev.done === true,
        timer: null,
      })
    }
    const entry = this.deltaBuf.get(key)!
    if (ev.done === true) return this.flushDelta(key)
    if (entry.text.length >= MAX_DELTA_CHARS) return this.flushDelta(key)
    if (entry.timer === null) {
      entry.timer = setTimeout(() => this.flushDelta(key), DELTA_FLUSH_MS)
      entry.timer.unref?.()
    }
  }

  private flushDelta(sessionId: string): void {
    const entry = this.deltaBuf.get(sessionId)
    if (!entry) return
    this.deltaBuf.delete(sessionId)
    if (entry.timer) clearTimeout(entry.timer)
    // A done-only frame carries no text but is NOT empty news: it is the only
    // signal that the run finished, so dropping it leaves the phone spinning
    // forever. Only a frame with neither text nor a terminal flag is noise.
    if (!entry.text && !entry.done) return
    this.emitTo({
      t: 'ev.message_delta',
      sessionId,
      messageId: entry.messageId,
      part: entry.part,
      delta: entry.text,
      done: entry.done,
    })
  }

  /** Flush every buffered delta (used on stop / before a run-state change). */
  private flushAllDeltas(): void {
    for (const sessionId of [...this.deltaBuf.keys()]) this.flushDelta(sessionId)
  }

  private markActivityFor(ev: Payload): void {
    if (ev.t === 'ev.permission_request' || ev.t === 'ev.question_request') {
      this.keepAwake.markActive()
      // hold the lock while a decision is pending: heartbeat activity
      const hold = setInterval(() => this.keepAwake.markActive(), 60_000)
      hold.unref?.()
      this.pendingHolds.set(ev.requestId, hold)
    } else if (ev.t === 'ev.run_state') {
      if (ev.state === 'running') this.keepAwake.markActive()
    } else if (ev.t === 'ev.tool_event') {
      this.keepAwake.markActive()
    }
    if ((ev.t === 'ev.result' || ev.t === 'ev.run_state' || ev.t === 'ev.tool_event') && 'requestId' in ev) {
      const h = this.pendingHolds.get((ev as { requestId: string }).requestId)
      if (h) { clearInterval(h); this.pendingHolds.delete((ev as { requestId: string }).requestId) }
    }
  }

  private pendingHolds = new Map<string, NodeJS.Timeout>()

  private markActivity(_why: string): void {
    this.keepAwake.markActive()
  }

  private async onPayload(sessionId: string, payload: Payload): Promise<void> {
    if (payload.t === 'cmd.keep_awake') {
      if (payload.enabled) {
        if (payload.idleReleaseSec !== undefined) this.keepAwake.setIdleRelease(payload.idleReleaseSec * 1000)
        this.keepAwake.enable()
        this.keepAwake.markActive()
      } else {
        this.keepAwake.disable('client')
      }
      this.relay.sendPayload(sessionId, { t: 'ev.result', cmdId: payload.cmdId, ok: true })
      this.relay.sendPayload(sessionId, this.keepAwakeStateEvent())
      return
    }
    try {
      const result = await handlePayload(this.bridge, payload)
      if (result) this.relay.sendPayload(sessionId, result)
      // after a command that changes state, refresh the session list
      if (payload.t === 'cmd.send_prompt' || payload.t === 'cmd.resolve_permission' || payload.t === 'cmd.answer' || payload.t === 'cmd.interrupt') {
        await this.pushSessions(sessionId)
      }
    } catch (e) {
      this.say('payload error', e)
      this.relay.sendPayload(sessionId, {
        t: 'ev.result',
        cmdId: (payload as { cmdId?: string }).cmdId ?? '',
        ok: false,
        message: String((e as Error)?.message ?? e),
      })
    }
  }

  private async pushSessions(sessionId: string): Promise<void> {
    try {
      this.sessionsCache = await this.bridge.listSessions()
      this.relay.sendPayload(sessionId, { t: 'ev.session_changed', sessions: this.sessionsCache })
    } catch (e) {
      this.say('listSessions failed', e)
    }
  }

  private async pushSessionsToAll(): Promise<void> {
    const clients = this.relay.pairedClients
    if (clients.length === 0) return
    try {
      this.sessionsCache = await this.bridge.listSessions()
    } catch {
      return
    }
    this.relay.broadcast({ t: 'ev.session_changed', sessions: this.sessionsCache })
  }

  get state(): Record<string, unknown> {
    return {
      relay: this.relay.status,
      hostId: this.relay.hostId,
      clients: this.relay.pairedClients.length,
      keepAwake: this.keepAwake.state,
      sessions: this.sessionsCache.length,
      // Full bridge diagnostics: which face we drive, the last error we
      // swallowed, and the ACTUAL shape of the kernel services we found. A
      // bridge that silently returns [] must be distinguishable from "you
      // have no sessions".
      bridge: this.bridge.describe?.() ?? {
        carrier: this.bridge.carrier,
        lastError: this.bridge.lastError ?? null,
      },
      // A dropped peer looks exactly like "paired but dead" from the phone,
      // so surface the reason here instead of only in stdout.
      relayProblem: this.relay.lastPairProblem,
    }
  }
}
