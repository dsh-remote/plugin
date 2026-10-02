/**
 * Relay client used by the DSH Host plugin: connects to the
 * dsh-remote-control server, maintains pairing tokens, and
 * routes E2E-encrypted payloads to/from paired clients.
 */
import { WebSocket } from 'ws'
import { createHash, randomUUID } from 'node:crypto'
import {
  seal,
  open,
  derivePskKey,
  generatePairingSecret,
  buildPairingQr,
  type WsFrame,
  type Payload,
  type SealedRecord,
} from '@dsh-rc/protocol'

export interface RelayClientOptions {
  serverUrl: string
  hostToken: string
  hostLabel: string
  onPayload?: (sessionId: string, clientId: string, payload: Payload) => void
  onPeerJoined?: (sessionId: string, clientId: string) => void
  onPeerLeft?: (sessionId: string, clientId: string) => void
  onStatus?: (s: RelayStatus) => void
  log?: (msg: string, extra?: unknown) => void
}

export type RelayStatus = 'connecting' | 'online' | 'offline' | 'auth-failed'

/** Upper bound on concurrently offered pairing codes (memory safety). */
const MAX_PENDING_PAIRS = 32

/** one paired client conversation */
interface Conversation {
  sessionId: string
  /** direction keys derived at pairing time */
  kC2H: Uint8Array // client -> host (host opens with this)
  kH2C: Uint8Array // host -> client (host seals with this)
  seq: number
}

export class RelayClient {
  private ws: WebSocket | null = null
  private conversations = new Map<string, Conversation>()
  /**
   * PSK by 6-digit token.
   *
   * NOT a single slot: several pairings can be outstanding at once (an
   * auto-published code plus a `/drc pair`, or two `/drc pair`s). Keys must be
   * derived from the PSK belonging to the token the client actually used —
   * using "the latest" produces keys the client cannot reproduce, and then
   * every payload fails to decrypt with no obvious cause.
   */
  private pendingPairs = new Map<string, { psk: string; expiresAt: number }>()
  /** TTL the relay reported for the last pairing (authoritative). */
  lastPairTtlMs: number | null = null
  /** Why the last peer-joined could not be served (null when healthy). */
  lastPairProblem: string | null = null
  /**
   * Bumped on every successful (re)authentication. A relay restart wipes its
   * pending-pair table, so anything we published before is dead — callers use
   * this to know their published pairing must be re-issued.
   */
  connectionGeneration = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private backoff = 1000
  private closed = false
  status: RelayStatus = 'offline'
  hostId = ''

  constructor(private opts: RelayClientOptions) {}

  private say = (m: string, x?: unknown) => this.opts.log?.(m, x)

  start(): void {
    this.closed = false
    this.connect()
  }

  stop(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    try {
      this.ws?.close()
    } catch { /* ignore */ }
    this.ws = null
    this.conversations.clear()
    this.setStatus('offline')
  }

  private setStatus(s: RelayStatus) {
    if (this.status !== s) {
      this.status = s
      this.opts.onStatus?.(s)
    }
  }

  private connect(): void {
    if (this.closed) return
    this.setStatus('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.serverUrl, { handshakeTimeout: 10_000 })
    } catch (e) {
      this.say('ws create failed', e)
      return this.scheduleReconnect()
    }
    this.ws = ws
    ws.on('open', () => {
      this.backoff = 1000
      this.send({ t: 'auth', role: 'host', token: this.opts.hostToken, label: this.opts.hostLabel })
    })
    ws.on('message', (raw) => {
      try {
        this.onFrame(String(raw))
      } catch (e) {
        // a malformed/odd frame must not surface as an uncaught exception
        this.say('frame handling failed', e)
      }
    })
    ws.on('error', (e) => this.say('ws error', (e as Error).message))
    ws.on('close', () => {
      if (this.ws === ws) {
        this.ws = null
        this.setStatus('offline')
        this.scheduleReconnect()
      }
    })
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const delay = this.backoff + Math.random() * 500
    this.backoff = Math.min(this.backoff * 2, 30_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private send(f: WsFrame | Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f))
  }

  private onFrame(raw: string): void {
    let f: WsFrame
    try {
      f = JSON.parse(raw) as WsFrame
    } catch {
      return
    }
    switch (f.t) {
      case 'auth-ok':
        this.connectionGeneration++
        this.hostId = f.hostId
        this.setStatus('online')
        this.say(`relay online as host ${f.hostId}`)
        // re-offer pairing automatically when host restarts with pending pair
        return
      case 'auth-fail':
        this.setStatus('auth-failed')
        this.say('relay auth failed — check DRC_HOST_TOKEN / serverUrl')
        return
      case 'pair-ready':
        // The SERVER owns the expiry. Recording our REQUESTED ttl is how a
        // code got swept host-side while the relay still honoured it: the
        // client then paired successfully and the host had already forgotten
        // the PSK, so it dropped the peer and no payload ever came back.
        if (typeof f.ttlMs === 'number' && f.ttlMs > 0) {
          this.lastPairTtlMs = f.ttlMs
          const rec = this.pendingPairs.get(f.pairingToken)
          if (rec) rec.expiresAt = Date.now() + f.ttlMs
        }
        this.say(`pairing token ${f.pairingToken} ready (server ttl ${f.ttlMs}ms)`)
        return
      case 'peer-joined': {
        // host side: the conversation was created server-side; psk was ours
        // The PSK is the one we offered for THIS token. With several pairings
        // outstanding, "the most recent token" is not necessarily the one the
        // client used — picking that one yields keys it cannot reproduce, and
        // then every payload fails to decrypt with no obvious cause.
        let psk: string | null = null
        const usedToken = (f as { pairingToken?: string }).pairingToken
        if (usedToken) {
          const rec = this.pendingPairs.get(usedToken)
          if (rec && rec.expiresAt >= Date.now()) psk = rec.psk
          this.pendingPairs.delete(usedToken) // single-use
        }
        if (!psk) {
          // Relays older than this change do not echo the token. Fall back to
          // the newest live entry and say so — better than dropping the peer.
          for (const [k, rec] of [...this.pendingPairs].reverse()) {
            if (rec.expiresAt >= Date.now()) {
              psk = rec.psk
              this.pendingPairs.delete(k)
              this.say('peer-joined without a matching token; using the newest pending PSK', {
                sessionId: f.sessionId,
              })
              break
            }
          }
        }
        if (!psk) {
          // Loud, not silent: this used to look like "paired but nothing works".
          this.lastPairProblem =
            `peer-joined for ${f.sessionId} had no matching PSK ` +
            `(token=${usedToken ?? 'none'}, pending=${this.pendingPairs.size}). ` +
            'The client will be unable to decrypt anything.'
          this.say('peer-joined without pending pair — dropping', f.sessionId)
          return
        }
        this.lastPairProblem = null
        this.conversations.set(f.sessionId, {
          sessionId: f.sessionId,
          kC2H: derivePskKey(psk, 'c2h', f.sessionId),
          kH2C: derivePskKey(psk, 'h2c', f.sessionId),
          seq: 0,
        })
        this.opts.onPeerJoined?.(f.sessionId, f.clientId)
        return
      }
      case 'peer-left':
        if (this.conversations.delete(f.sessionId)) this.opts.onPeerLeft?.(f.sessionId, f.clientId)
        return
      case 'enc': {
        const conv = this.conversations.get(f.sessionId)
        if (!conv) return
        const payload = open<Payload>(conv.kC2H, { ciphertext: f.ciphertext })
        if (!payload) {
          this.say('undecryptable frame dropped', f.sessionId)
          return
        }
        this.opts.onPayload?.(f.sessionId, f.clientId ?? '', payload)
        return
      }
      case 'pong':
        return
      default:
        return
    }
  }

  // ── pairing ─────────────────────────────────────────────
  /** Drop expired pairing codes. */
  private sweepPendingPairs(): void {
    const now = Date.now()
    for (const [token, rec] of this.pendingPairs) {
      if (rec.expiresAt < now) this.pendingPairs.delete(token)
    }
  }

  /**
   * Issue a one-time pairing token (6-digit) + PSK; returns QR text for display.
   * @param includeToken embed the code in the QR so a camera-less client
   *   (WeChat simulator, CLI) can pair from one paste. Off by default — see
   *   `PairingQr.token` for the trade-off.
   */
  createPairing(ttlMs = 120_000, opts: { includeToken?: boolean } = {}): { token: string; qr: string } {
    const psk = generatePairingSecret()
    const token = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
    this.sweepPendingPairs()
    // cap: an operator hammering `/drc pair` must not grow this without bound
    if (this.pendingPairs.size >= MAX_PENDING_PAIRS) {
      const oldest = this.pendingPairs.keys().next().value
      if (oldest !== undefined) this.pendingPairs.delete(oldest)
    }
    this.pendingPairs.set(token, { psk, expiresAt: Date.now() + ttlMs })
    this.lastPairTtlMs = null // re-learned from the next pair-ready
    const qr = buildPairingQr({
      v: 1,
      server: this.opts.serverUrl,
      hostLabel: this.opts.hostLabel,
      psk,
      token: opts.includeToken ? token : '',
    })
    this.send({ t: 'pair-begin', pairingToken: token, psk, hostLabel: this.opts.hostLabel })
    return { token, qr }
  }

  // ── outbound encrypted stream ───────────────────────────
  sendPayload(sessionId: string, payload: Payload): boolean {
    const conv = this.conversations.get(sessionId)
    if (!conv || this.ws?.readyState !== WebSocket.OPEN) return false
    const rec: SealedRecord = seal(conv.kH2C, payload)
    this.send({ t: 'enc', sessionId, seq: ++conv.seq, ciphertext: rec.ciphertext })
    return true
  }

  /** broadcast to every paired client */
  broadcast(payload: Payload): void {
    for (const sessionId of this.conversations.keys()) this.sendPayload(sessionId, payload)
  }

  get pairedClients(): Array<{ sessionId: string }> {
    return [...this.conversations.values()].map((c) => ({ sessionId: c.sessionId }))
  }

  /** stable short fingerprint for display (sha256 of token, first 8) */
  static tokenFingerprint(token: string): string {
    return createHash('sha256').update(token).digest('hex').slice(0, 8)
  }

  newCmdId(): string {
    return randomUUID()
  }
}
