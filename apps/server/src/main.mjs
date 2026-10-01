#!/usr/bin/env node
/**
 * dsh-remote-control relay server.
 *
 * Responsibilities (zero-knowledge relay):
 *  - Host plugin connects with a bearer token, registers a hostId.
 *  - Clients (WeChat MP / web) connect, pair with a short-lived pairing
 *    token/PSK, then join conversations.
 *  - `enc` frames are routed verbatim between peers; the server never
 *    decrypts payloads.
 *  - REST for health, host status, pairing bootstrap (QR payload is
 *    generated host-side and only relayed).
 *
 * Production behaviour (hardening):
 *  - structured JSON logs, level via DRC_LOG_LEVEL
 *  - bounded frame size (DRC_MAX_MSG_BYTES) and connection count
 *  - per-connection frame budget + attempt budgets (auth / pairing) so the
 *    6-digit pairing token cannot be brute-forced from one socket
 *  - graceful shutdown on SIGTERM/SIGINT: stop accepting, drain, exit
 *  - conversations are dropped when their host goes offline (no leak)
 *
 * Node >= 20. No DB required (in-memory by design).
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

// ── configuration ────────────────────────────────────────────────────
const PORT = Number(process.env.DRC_PORT || 8787)
// Bind loopback by default: in production a reverse proxy terminates TLS and
// talks to us over 127.0.0.1, so the relay has no business being reachable on
// the LAN. Set DRC_BIND=0.0.0.0 when the relay IS the edge (e.g. in a
// container with published ports and its own TLS).
const BIND = process.env.DRC_BIND || '127.0.0.1'
const HOST_TOKEN = process.env.DRC_HOST_TOKEN || ''
const PUBLIC_URL = process.env.DRC_PUBLIC_URL || `ws://127.0.0.1:${PORT}`
const PAIR_TTL_MS = Number(process.env.DRC_PAIR_TTL_MS || 120_000)
const IDLE_SWEEP_MS = 5_000

const MAX_MSG_BYTES = Number(process.env.DRC_MAX_MSG_BYTES || 256 * 1024)
const MAX_CONNS = Number(process.env.DRC_MAX_CONNS || 200)
const MAX_FRAMES_PER_SEC = Number(process.env.DRC_MAX_FRAMES_PER_SEC || 500)
const MAX_AUTH_ATTEMPTS = Number(process.env.DRC_MAX_AUTH_ATTEMPTS || 5)
const MAX_PAIR_ATTEMPTS = Number(process.env.DRC_MAX_PAIR_ATTEMPTS || 5)
const MAX_PAIR_ATTEMPTS_PER_SEC = Number(process.env.DRC_MAX_PAIR_ATTEMPTS_PER_SEC || 20)
const MAX_PENDING_PAIRS = Number(process.env.DRC_MAX_PENDING_PAIRS || 1000)
/** Off by default: it is an unauthenticated "is this code valid?" oracle. */
const PAIR_STATUS_ENABLED = process.env.DRC_PAIR_STATUS === '1'

if (!HOST_TOKEN) {
  console.error('[drc] DRC_HOST_TOKEN is required (long random string, e.g. `openssl rand -hex 24`).')
  process.exit(1)
}

// ── logging ──────────────────────────────────────────────────────────
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }
const LOG_LEVEL = LEVELS[(process.env.DRC_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info

/** One JSON object per line — greppable and shippable to any log pipeline. */
function log(level, msg, extra) {
  if ((LEVELS[level] ?? LEVELS.info) < LOG_LEVEL) return
  const rec = { ts: new Date().toISOString(), level, msg }
  if (extra) for (const k of Object.keys(extra)) rec[k] = extra[k]
  ;(level === 'error' ? console.error : console.log)(JSON.stringify(rec))
}

if (HOST_TOKEN.length < 24) {
  log('warn', 'DRC_HOST_TOKEN is shorter than 24 chars — use `openssl rand -hex 24`', {
    length: HOST_TOKEN.length,
  })
}

const STARTED_AT = Date.now()
/** hostId -> { ws, label } */
const hosts = new Map()
/** clientId -> { ws, meta } */
const clients = new Map()
/** pairToken -> { hostId, psk, expiresAt, used } */
const pendingPairs = new Map()
/** conversationId -> { hostId, clients:Set<clientId>, seqHost:number } */
const conversations = new Map()

let shuttingDown = false

const safeEq = (a, b) => {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

// ── rate limiters ────────────────────────────────────────────────────
/** Global bucket for pairing claims: throttles distributed brute force. */
let pairBudget = MAX_PAIR_ATTEMPTS_PER_SEC
let pairBudgetResetAt = Date.now() + 1000
function takePairBudget() {
  const now = Date.now()
  if (now >= pairBudgetResetAt) {
    pairBudget = MAX_PAIR_ATTEMPTS_PER_SEC
    pairBudgetResetAt = now + 1000
  }
  if (pairBudget <= 0) return false
  pairBudget--
  return true
}

/** Per-connection token bucket (frame flood protection). */
function makeBudget(perSec) {
  return { left: perSec, resetAt: Date.now() + 1000, perSec }
}
function takeBudget(b) {
  const now = Date.now()
  if (now >= b.resetAt) {
    b.left = b.perSec
    b.resetAt = now + 1000
  }
  if (b.left <= 0) return false
  b.left--
  return true
}

// ── HTTP ─────────────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  res.setHeader('content-type', 'application/json')
  if (url.pathname === '/healthz') {
    return void res.end(
      JSON.stringify({
        ok: true,
        version: pkg.version,
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        hosts: hosts.size,
        clients: clients.size,
        conversations: conversations.size,
        pendingPairs: pendingPairs.size,
        shuttingDown,
      }),
    )
  }
  if (url.pathname === '/api/info') {
    return void res.end(JSON.stringify({ publicUrl: PUBLIC_URL, protocol: 1 }))
  }
  if (url.pathname === '/api/pair-status' && req.method === 'GET') {
    // Opt-in only: an unauthenticated endpoint that answers "is pairing code
    // N valid?" is a ready-made oracle for sweeping the 6-digit space.
    if (!PAIR_STATUS_ENABLED) {
      res.writeHead(404)
      return void res.end(JSON.stringify({ error: 'not_found' }))
    }
    const p = pendingPairs.get(url.searchParams.get('token') || '')
    log('debug', 'pair-status query')
    return void res.end(JSON.stringify({ ok: !!p && !p.used && p.expiresAt > Date.now() }))
  }
  res.writeHead(404)
  res.end(JSON.stringify({ error: 'not_found' }))
})
// Bound plain-HTTP requests; WebSocket upgrades are unaffected.
httpServer.requestTimeout = 30_000
httpServer.headersTimeout = 15_000

// ── WS ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({
  server: httpServer,
  path: '/',
  maxPayload: MAX_MSG_BYTES,
  clientTracking: true,
})

wss.on('connection', (ws) => {
  if (shuttingDown || wss.clients.size > MAX_CONNS) {
    log('warn', 'connection rejected', {
      reason: shuttingDown ? 'shutting_down' : 'over_connection_limit',
      conns: wss.clients.size,
    })
    try {
      ws.close(1013, 'server_busy')
    } catch {
      /* ignore */
    }
    return
  }

  ws.isAlive = true
  ws.on('pong', () => (ws.isAlive = true))
  let session = null // { role, hostId?, clientId? }
  const frameBudget = makeBudget(MAX_FRAMES_PER_SEC)
  const authBudget = { left: MAX_AUTH_ATTEMPTS }
  const pairBudgetConn = { left: MAX_PAIR_ATTEMPTS }
  let rateViolations = 0

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  }

  ws.on('message', (raw) => {
    if (!takeBudget(frameBudget)) {
      rateViolations++
      send({ t: 'error', code: 'rate_limited', message: 'too many frames' })
      log('warn', 'frame budget exceeded', { role: session?.role, violations: rateViolations })
      if (rateViolations >= 3) {
        try {
          ws.close(1008, 'rate_limited')
        } catch {
          /* ignore */
        }
      }
      return
    }
    let f
    try {
      f = JSON.parse(String(raw))
    } catch {
      return send({ t: 'error', code: 'bad_json', message: 'invalid JSON frame' })
    }
    try {
      handle(f)
    } catch (e) {
      log('error', 'frame error', { message: String(e?.message || e) })
      send({ t: 'error', code: 'internal', message: String(e?.message || e) })
    }
  })

  const handle = (f) => {
    switch (f.t) {
      case 'hello': {
        if (f.role !== 'client') return send({ t: 'error', code: 'bad_role', message: 'hello is for clients' })
        session = { role: 'client', clientId: f.clientId || randomUUID() }
        clients.set(session.clientId, { ws, meta: f.clientMeta || {} })
        log('debug', 'client hello', { clientId: session.clientId })
        return send({ t: 'hello-ok', clientId: session.clientId })
      }

      case 'auth': {
        // host bearer auth
        if (f.role !== 'host' || !safeEq(String(f.token), HOST_TOKEN)) {
          authBudget.left--
          log('warn', 'host auth failed', {
            attemptsLeft: Math.max(0, authBudget.left),
            hostId: f.hostId || '-',
          })
          send({ t: 'auth-fail', reason: 'bad_token' })
          if (authBudget.left <= 0) {
            log('warn', 'closing socket: too many failed auth attempts')
            try {
              ws.close(4001, 'too_many_auth_attempts')
            } catch {
              /* ignore */
            }
          }
          return
        }
        const hostId = f.hostId || randomUUID().slice(0, 8)
        session = { role: 'host', hostId }
        // reconnect replaces the previous socket for the same hostId
        const prev = hosts.get(hostId)
        if (prev?.ws && prev.ws !== ws && prev.ws.readyState === ws.OPEN) {
          prev.ws.close(4000, 'replaced')
        }
        hosts.set(hostId, { ws, label: f.label || 'dsh-host' })
        // re-attach existing conversations to the fresh host socket
        for (const [cid, conv] of conversations) {
          if (conv.hostId === hostId) {
            for (const cl of conv.clients) {
              sendTo(cl, { t: 'peer-joined', sessionId: cid, clientId: hostId })
            }
          }
        }
        send({ t: 'auth-ok', hostId })
        log('info', 'host authed', { hostId, label: f.label || 'dsh-host' })
        return
      }

      case 'pair-begin': {
        if (session?.role !== 'host') return send({ t: 'error', code: 'need_host', message: 'auth(host) first' })
        const { pairingToken, psk } = f
        if (!/^\d{6}$/.test(String(pairingToken)) || typeof psk !== 'string' || psk.length < 16) {
          return send({ t: 'error', code: 'bad_pair', message: 'pairingToken must be 6 digits; psk base64>=16 chars' })
        }
        // bound the table so a buggy or abusive host cannot grow it without limit
        if (pendingPairs.size >= MAX_PENDING_PAIRS && !pendingPairs.has(pairingToken)) {
          log('warn', 'pending pair table full, rejecting', { size: pendingPairs.size })
          return send({ t: 'error', code: 'pair_table_full', message: 'too many pending pairings' })
        }
        pendingPairs.set(pairingToken, {
          hostId: session.hostId,
          psk,
          expiresAt: Date.now() + PAIR_TTL_MS,
          used: false,
        })
        send({ t: 'pair-ready', pairingToken, ttlMs: PAIR_TTL_MS })
        log('info', 'pair token issued', { pairingToken, hostId: session.hostId, ttlMs: PAIR_TTL_MS })
        return
      }

      case 'pair-begin-client': {
        if (session?.role !== 'client') return send({ t: 'error', code: 'need_client', message: 'send hello{role:client} first' })
        if (!takePairBudget()) {
          // global throttle: keeps the 6-digit space from being swept
          log('warn', 'pair claim throttled', { scope: 'global' })
          return send({ t: 'pair-fail', reason: 'rate_limited' })
        }
        const p = pendingPairs.get(f.pairingToken)
        if (!p || p.used || p.expiresAt < Date.now()) {
          pairBudgetConn.left--
          log('warn', 'pair claim rejected', {
            reason: p?.used ? 'already_used' : 'invalid_or_expired',
            attemptsLeft: Math.max(0, pairBudgetConn.left),
          })
          send({ t: 'pair-fail', reason: p?.used ? 'already_used' : 'invalid_or_expired' })
          if (pairBudgetConn.left <= 0) {
            log('warn', 'closing socket: too many failed pair attempts')
            try {
              ws.close(4008, 'too_many_pair_attempts')
            } catch {
              /* ignore */
            }
          }
          return
        }
        p.used = true // retained until TTL sweep so reuse reports already_used
        const host = hosts.get(p.hostId)
        if (!host || host.ws.readyState !== 1) return send({ t: 'pair-fail', reason: 'host_offline' })
        const sessionId = 'c_' + randomBytes(6).toString('hex')
        conversations.set(sessionId, { hostId: p.hostId, clients: new Set([session.clientId]), seqHost: 0 })
        send({ t: 'paired', hostId: p.hostId, sessionId })
        host.ws.send(JSON.stringify({ t: 'peer-joined', sessionId, clientId: session.clientId }))
        log('info', 'paired', { sessionId, hostId: p.hostId, clientId: session.clientId })
        return
      }

      case 'enc': {
        const conv = conversations.get(f.sessionId)
        if (!conv) return send({ t: 'error', code: 'unknown_session', message: String(f.sessionId) })
        if (typeof f.ciphertext !== 'string') {
          return send({ t: 'error', code: 'bad_frame', message: 'ciphertext must be a string' })
        }
        if (session?.role === 'host') {
          for (const cl of conv.clients) {
            sendTo(cl, { t: 'enc', sessionId: f.sessionId, seq: ++conv.seqHost, clientId: session?.hostId, ciphertext: f.ciphertext })
          }
          return
        }
        sendToHost(conv.hostId, { t: 'enc', sessionId: f.sessionId, seq: f.seq, clientId: session?.clientId, ciphertext: f.ciphertext })
        return
      }

      case 'session-leave': {
        const conv = conversations.get(f.sessionId)
        if (conv && session?.clientId) {
          conv.clients.delete(session.clientId)
          sendToHost(conv.hostId, { t: 'peer-left', sessionId: f.sessionId, clientId: session.clientId })
          if (conv.clients.size === 0) conversations.delete(f.sessionId)
        }
        return
      }

      case 'ping':
        return send({ t: 'pong', ts: f.ts })

      default:
        return send({ t: 'error', code: 'unknown_frame', message: String(f.t) })
    }
  }

  ws.on('close', (code) => {
    if (session?.role === 'client') {
      clients.delete(session.clientId)
      for (const [cid, conv] of conversations) {
        if (conv.clients.delete(session.clientId)) {
          sendToHost(conv.hostId, { t: 'peer-left', sessionId: cid, clientId: session.clientId })
        }
        if (conv.clients.size === 0) conversations.delete(cid)
      }
      log('debug', 'client disconnected', { clientId: session.clientId, code })
    }
    if (session?.role === 'host' && hosts.get(session.hostId)?.ws === ws) {
      hosts.delete(session.hostId)
      // Drop this host's conversations instead of leaving them orphaned.
      // On a reconnect the new socket is registered first, so this guard is
      // false and the conversations correctly survive.
      for (const [cid, conv] of conversations) {
        if (conv.hostId === session.hostId) {
          for (const cl of conv.clients) {
            sendTo(cl, { t: 'peer-left', sessionId: cid, clientId: session.hostId })
          }
          conversations.delete(cid)
        }
      }
      log('info', 'host offline', { hostId: session.hostId, code })
    }
  })

  ws.on('error', (e) => log('warn', 'socket error', { message: String(e?.message || e) }))
})

function sendTo(clientId, frame) {
  const c = clients.get(clientId)
  if (c?.ws?.readyState === 1) c.ws.send(JSON.stringify(frame))
}
function sendToHost(hostId, frame) {
  const h = hosts.get(hostId)
  if (h?.ws?.readyState === 1) h.ws.send(JSON.stringify(frame))
}

// keepalive + expiry sweep
const sweep = setInterval(() => {
  if (shuttingDown) return
  for (const [, c] of clients) {
    if (c.ws?.readyState === 1) {
      if (!c.ws.isAlive) {
        log('debug', 'terminating unresponsive client')
        c.ws.terminate()
      } else {
        c.ws.isAlive = false
        c.ws.ping()
      }
    }
  }
  for (const [hostId, h] of hosts) {
    if (h.ws?.readyState === 1 && !h.ws.isAlive) {
      log('warn', 'host unresponsive, terminating', { hostId })
      h.ws.terminate()
    } else if (h.ws?.readyState === 1) {
      h.ws.isAlive = false
      h.ws.ping()
    }
  }
  for (const [tok, p] of pendingPairs) if (p.expiresAt < Date.now() || p.used) pendingPairs.delete(tok)
}, IDLE_SWEEP_MS)
sweep.unref?.()

// ── lifecycle ────────────────────────────────────────────────────────
function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  log('info', 'shutdown initiated', { signal })
  clearInterval(sweep)
  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'server_shutdown')
    } catch {
      /* ignore */
    }
  }
  try {
    wss.close()
  } catch {
    /* ignore */
  }
  httpServer.close(() => {
    log('info', 'shutdown complete', { signal })
    process.exit(exitCode)
  })
  // don't hang forever on a stuck socket
  const timer = setTimeout(() => {
    log('warn', 'shutdown timeout, forcing exit')
    process.exit(exitCode)
  }, 5_000)
  timer.unref?.()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (e) => {
  log('error', 'unhandledRejection', { message: String(e?.message || e) })
})
process.on('uncaughtException', (e) => {
  log('error', 'uncaughtException', { message: String(e?.message || e), stack: String(e?.stack || '') })
  shutdown('uncaughtException', 1)
})

httpServer.listen(PORT, BIND, () => {
  log('info', 'relay listening', {
    version: pkg.version,
    bind: BIND,
    port: PORT,
    publicUrl: PUBLIC_URL,
    pairTtlMs: PAIR_TTL_MS,
    limits: {
      maxConns: MAX_CONNS,
      maxMsgBytes: MAX_MSG_BYTES,
      maxFramesPerSec: MAX_FRAMES_PER_SEC,
      maxAuthAttempts: MAX_AUTH_ATTEMPTS,
      maxPairAttempts: MAX_PAIR_ATTEMPTS,
      maxPairAttemptsPerSec: MAX_PAIR_ATTEMPTS_PER_SEC,
    },
  })
})
