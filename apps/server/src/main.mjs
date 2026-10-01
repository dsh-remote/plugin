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
 * Node >= 20. No DB required (in-memory + optional JSON snapshot).
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url)
const pkg = require('../package.json')
const PORT = Number(process.env.DRC_PORT || 8787)
const HOST_TOKEN = process.env.DRC_HOST_TOKEN || ''
const PUBLIC_URL = process.env.DRC_PUBLIC_URL || `ws://127.0.0.1:${PORT}`
const PAIR_TTL_MS = Number(process.env.DRC_PAIR_TTL_MS || 120_000)
const IDLE_SWEEP_MS = 5_000

if (!HOST_TOKEN) {
  console.error('[drc] DRC_HOST_TOKEN is required (long random string, e.g. `openssl rand -hex 24`).')
  process.exit(1)
}

/** hostId -> { ws, label, pskByPair, conversations } */
const hosts = new Map()
/** clientId -> { ws, meta } */
const clients = new Map()
/** pairToken -> { hostId, psk, expiresAt, used } */
const pendingPairs = new Map()
/** conversationId -> { hostId, clients:Set<clientId>, seqHost:number } */
const conversations = new Map()

const log = (...a) => console.log(new Date().toISOString(), ...a)
const safeEq = (a, b) => {
  const ba = Buffer.from(a), bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

// ── HTTP ─────────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  res.setHeader('content-type', 'application/json')
  if (url.pathname === '/healthz') {
    return void res.end(JSON.stringify({ ok: true, version: pkg.version, hosts: hosts.size, clients: clients.size, conversations: conversations.size }))
  }
  if (url.pathname === '/api/info') {
    return void res.end(JSON.stringify({ publicUrl: PUBLIC_URL, protocol: 1 }))
  }
  if (url.pathname === '/api/pair-status' && req.method === 'GET') {
    const p = pendingPairs.get(url.searchParams.get('token') || '')
    return void res.end(JSON.stringify({ ok: !!p && !p.used && p.expiresAt > Date.now() }))
  }
  res.writeHead(404)
  res.end(JSON.stringify({ error: 'not_found' }))
})

// ── WS ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: '/' })
wss.on('connection', (ws, req) => {
  ws.isAlive = true
  ws.on('pong', () => (ws.isAlive = true))
  let session = null // { role, hostId? , clientId? }

  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)) }

  ws.on('message', (raw) => {
    let f
    try { f = JSON.parse(String(raw)) } catch { return send({ t: 'error', code: 'bad_json', message: 'invalid JSON frame' }) }
    try { handle(f) } catch (e) { log('frame error', e); send({ t: 'error', code: 'internal', message: String(e?.message || e) }) }
  })

  const handle = (f) => {
    switch (f.t) {
      case 'hello': {
        session = { role: f.role, clientId: f.clientId || randomUUID() }
        if (f.role === 'client') clients.set(session.clientId, { ws, meta: f.clientMeta || {} })
        return send({ t: 'hello-ok', clientId: session.clientId })
      }
      case 'auth': { // host bearer auth
        if (f.role !== 'host' || !safeEq(String(f.token), HOST_TOKEN)) {
          send({ t: 'auth-fail', reason: 'bad_token' })
          return ws.close(4001, 'bad_token')
        }
        const hostId = f.hostId || randomUUID().slice(0, 8)
        session = { role: 'host', hostId }
        // reconnect replaces previous socket for same hostId
        const prev = hosts.get(hostId)
        if (prev?.ws && prev.ws !== ws && prev.ws.readyState === ws.OPEN) prev.ws.close(4000, 'replaced')
        hosts.set(hostId, { ws, label: f.label || 'dsh-host' })
        // re-attach existing conversations to the fresh host socket
        for (const [cid, conv] of conversations) {
          if (conv.hostId === hostId) {
            conv.hostId = hostId
            for (const cl of conv.clients) {
              clients.get(cl)?.ws && sendTo(cl, { t: 'peer-joined', sessionId: cid, clientId: hostId })
            }
          }
        }
        for (const [, p] of pendingPairs) if (p.hostId === hostId) { /* keep */ }
        send({ t: 'auth-ok', hostId })
        log('host authed', hostId)
        return
      }
      case 'pair-begin': { // host offers a pairing token + psk
        if (session?.role !== 'host') return send({ t: 'error', code: 'need_host', message: 'hello(host)+auth first' })
        const { pairingToken, psk } = f
        if (!/^\d{6}$/.test(String(pairingToken)) || typeof psk !== 'string' || psk.length < 16) {
          return send({ t: 'error', code: 'bad_pair', message: 'pairingToken must be 6 digits; psk base64>=16 chars' })
        }
        pendingPairs.set(pairingToken, { hostId: session.hostId, psk, expiresAt: Date.now() + PAIR_TTL_MS, used: false })
        send({ t: 'pair-ready', pairingToken, ttlMs: PAIR_TTL_MS })
        log('pair token issued', pairingToken, 'host', session.hostId)
        return
      }
      case 'pair-begin-client': { // client claims a pairing token
        if (session?.role !== 'client') return send({ t: 'error', code: 'need_client', message: 'send hello{role:client} first' })
        const p = pendingPairs.get(f.pairingToken)
        if (!p || p.used || p.expiresAt < Date.now()) return send({ t: 'pair-fail', reason: p?.used ? 'already_used' : 'invalid_or_expired' })
        p.used = true // retained until TTL sweep so reuse reports already_used
        const host = hosts.get(p.hostId)
        if (!host || host.ws.readyState !== 1) return send({ t: 'pair-fail', reason: 'host_offline' })
        // create a conversation (sessionId) shared by host <-> this client
        const sessionId = 'c_' + randomBytes(6).toString('hex')
        conversations.set(sessionId, { hostId: p.hostId, clients: new Set([session.clientId]), seqHost: 0 })
        send({ t: 'paired', hostId: p.hostId, sessionId })
        host.ws.send(JSON.stringify({ t: 'peer-joined', sessionId, clientId: session.clientId }))
        log('paired', sessionId, 'host', p.hostId, 'client', session.clientId)
        return
      }
      case 'enc': {
        const conv = conversations.get(f.sessionId)
        if (!conv) return send({ t: 'error', code: 'unknown_session', message: f.sessionId })
        if (session?.role === 'host') {
          for (const cl of conv.clients) sendTo(cl, { t: 'enc', sessionId: f.sessionId, seq: ++conv.seqHost, clientId: session?.hostId, ciphertext: f.ciphertext })
          return
        }
        // client -> host: relay with per-conversation counter
        sendToHost(conv.hostId, { t: 'enc', sessionId: f.sessionId, seq: f.seq, clientId: session?.clientId, ciphertext: f.ciphertext })
        return
      }
      case 'session-leave': {
        const conv = conversations.get(f.sessionId)
        if (conv && session?.clientId) {
          conv.clients.delete(session.clientId)
          sendToHost(conv.hostId, { t: 'peer-left', sessionId: f.sessionId, clientId: session.clientId })
        }
        return
      }
      case 'ping': return send({ t: 'pong', ts: f.ts })
      default:
        return send({ t: 'error', code: 'unknown_frame', message: String(f.t) })
    }
  }

  ws.on('close', () => {
    if (session?.role === 'client') {
      clients.delete(session.clientId)
      for (const [cid, conv] of conversations) {
        if (conv.clients.delete(session.clientId)) {
          sendToHost(conv.hostId, { t: 'peer-left', sessionId: cid, clientId: session.clientId })
        }
        if (conv.clients.size === 0 && conv.hostId) conversations.delete(cid)
      }
    }
    if (session?.role === 'host' && hosts.get(session.hostId)?.ws === ws) {
      hosts.delete(session.hostId)
      for (const [cid, conv] of conversations) if (conv.hostId === session.hostId) {
        for (const cl of conv.clients) sendTo(cl, { t: 'peer-left', sessionId: cid, clientId: session.hostId })
      }
      log('host offline', session.hostId)
    }
  })
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
setInterval(() => {
  for (const [, c] of clients) if (c.ws?.readyState === 1) { if (!c.ws.isAlive) c.ws.terminate(); else { c.ws.isAlive = false; c.ws.ping() } }
  for (const [tok, p] of pendingPairs) if (p.expiresAt < Date.now() || p.used) pendingPairs.delete(tok)
}, IDLE_SWEEP_MS).unref?.()

httpServer.listen(PORT, () => {
  log(`dsh-remote-control relay v${pkg.version} listening on :${PORT} (public: ${PUBLIC_URL})`)
})
