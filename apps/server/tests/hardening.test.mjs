/**
 * Production-hardening behaviours of the relay: message/connection limits,
 * brute-force protection on the 6-digit pairing token, orphaned-conversation
 * cleanup, and graceful shutdown.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import WebSocket from 'ws'

const TOKEN = 'hardening-test-token-0123456789abcdef'

let portSeq = 18770
async function startServer(extraEnv = {}) {
  const PORT = portSeq++
  const proc = spawn(process.execPath, ['src/main.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, DRC_PORT: String(PORT), DRC_HOST_TOKEN: TOKEN, DRC_LOG_LEVEL: 'warn', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = []
  proc.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)))
  proc.stderr.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)))
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`)
      if (r.ok) return { proc, PORT, lines }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server did not come up')
}

const connect = (port) =>
  new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on('open', () => res(ws))
    ws.on('error', rej)
  })

function collect(ws) {
  const frames = []
  ws.on('message', (raw) => {
    try {
      frames.push(JSON.parse(String(raw)))
    } catch {
      /* ignore */
    }
  })
  return frames
}

function nextFrame(ws, pred, ms = 4000) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timeout waiting frame')), ms)
    const on = (raw) => {
      let f
      try {
        f = JSON.parse(String(raw))
      } catch {
        return
      }
      if (pred(f)) {
        clearTimeout(timer)
        ws.off('message', on)
        res(f)
      }
    }
    ws.on('message', on)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('oversized frames are rejected instead of buffering', async (t) => {
  const { proc, PORT } = await startServer({ DRC_MAX_MSG_BYTES: '1024' })
  t.after(() => proc.kill())
  const ws = await connect(PORT)
  const closed = once(ws, 'close')
  ws.send('x'.repeat(64 * 1024))
  const [code] = await Promise.race([
    closed,
    sleep(4000).then(() => { throw new Error('socket was not closed after oversized frame') }),
  ])
  assert.equal(code, 1009, 'ws should close with 1009 (message too big)')
})

test('repeated bad host tokens close the socket (brute-force guard)', async (t) => {
  const { proc, PORT } = await startServer({ DRC_MAX_AUTH_ATTEMPTS: '3' })
  t.after(() => proc.kill())
  const ws = await connect(PORT)
  // register the close listener BEFORE driving the socket: the server closes
  // it as soon as the last attempt lands, so attaching later would miss it
  const closed = once(ws, 'close')
  const frames = collect(ws)
  for (let i = 0; i < 3; i++) {
    ws.send(JSON.stringify({ t: 'auth', role: 'host', token: 'nope' }))
    await sleep(30)
  }
  const [code] = await Promise.race([
    closed,
    sleep(4000).then(() => { throw new Error('socket was not closed after 3 bad auth attempts') }),
  ])
  assert.equal(code, 4001)
  assert.equal(frames.filter((f) => f.t === 'auth-fail').length, 3)
})

test('repeated bad pairing codes close the socket (brute-force guard)', async (t) => {
  const { proc, PORT } = await startServer({ DRC_MAX_PAIR_ATTEMPTS: '3' })
  t.after(() => proc.kill())
  const ws = await connect(PORT)
  const closed = once(ws, 'close')
  const frames = collect(ws)
  ws.send(JSON.stringify({ t: 'hello', role: 'client', protocol: 1 }))
  await nextFrame(ws, (f) => f.t === 'hello-ok')
  for (let i = 0; i < 3; i++) {
    ws.send(JSON.stringify({ t: 'pair-begin-client', pairingToken: '00000' + i }))
    await sleep(30)
  }
  const [code] = await Promise.race([
    closed,
    sleep(4000).then(() => { throw new Error('socket was not closed after 3 bad pair attempts') }),
  ])
  assert.equal(code, 4008)
  assert.ok(frames.some((f) => f.t === 'pair-fail' && f.reason === 'invalid_or_expired'))
})

test('frame flood is rate limited', async (t) => {
  const { proc, PORT } = await startServer({ DRC_MAX_FRAMES_PER_SEC: '5' })
  t.after(() => proc.kill())
  const ws = await connect(PORT)
  const frames = collect(ws)
  for (let i = 0; i < 40; i++) ws.send(JSON.stringify({ t: 'ping', ts: i }))
  await sleep(400)
  assert.ok(
    frames.some((f) => f.t === 'error' && f.code === 'rate_limited'),
    'expected a rate_limited error frame',
  )
  ws.close()
})

test('host going offline drops its conversations (no orphaned state)', async (t) => {
  const { proc, PORT } = await startServer()
  t.after(() => proc.kill())

  const host = await connect(PORT)
  host.send(JSON.stringify({ t: 'auth', role: 'host', token: TOKEN, hostId: 'hh' }))
  await nextFrame(host, (f) => f.t === 'auth-ok')
  host.send(JSON.stringify({ t: 'pair-begin', pairingToken: '555555', psk: 'AAAAAAAAAAAAAAAAAAAAAA' }))
  await nextFrame(host, (f) => f.t === 'pair-ready')

  const cl = await connect(PORT)
  cl.send(JSON.stringify({ t: 'hello', role: 'client', protocol: 1, clientId: 'cc' }))
  await nextFrame(cl, (f) => f.t === 'hello-ok')
  cl.send(JSON.stringify({ t: 'pair-begin-client', pairingToken: '555555' }))
  const paired = await nextFrame(cl, (f) => f.t === 'paired')

  // client sees the host leave...
  const left = nextFrame(cl, (f) => f.t === 'peer-left')
  host.close()
  await left

  // ...and the conversation is gone, so the client gets a clear error
  // instead of frames silently vanishing
  cl.send(JSON.stringify({ t: 'enc', sessionId: paired.sessionId, seq: 1, ciphertext: 'aGk=' }))
  const err = await nextFrame(cl, (f) => f.t === 'error')
  assert.equal(err.code, 'unknown_session')
  cl.close()
})

test('health endpoint reports uptime and live counters', async (t) => {
  const { proc, PORT } = await startServer()
  t.after(() => proc.kill())
  const body = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()
  assert.equal(body.ok, true)
  assert.equal(typeof body.uptimeSec, 'number')
  assert.equal(body.shuttingDown, false)
  assert.equal(body.conversations, 0)
})

test('SIGTERM triggers a graceful shutdown with exit code 0', async (t) => {
  const { proc, PORT } = await startServer({ DRC_LOG_LEVEL: 'info' })
  t.after(() => proc.kill())
  const ws = await connect(PORT)
  const closed = once(ws, 'close')

  proc.kill('SIGTERM')
  const [exitCode] = await Promise.race([
    once(proc, 'exit'),
    sleep(8000).then(() => { throw new Error('server did not exit after SIGTERM') }),
  ])
  assert.equal(exitCode, 0, 'graceful shutdown must exit 0')
  // clients are drained, not left hanging
  const [clientCode] = await Promise.race([
    closed,
    sleep(3000).then(() => { throw new Error('connected client was not closed on shutdown') }),
  ])
  assert.equal(clientCode, 1001)
})

test('pair-status endpoint is off by default (no token oracle)', async (t) => {
  const { proc, PORT } = await startServer()
  t.after(() => proc.kill())
  const off = await fetch(`http://127.0.0.1:${PORT}/api/pair-status?token=123456`)
  assert.equal(off.status, 404, 'must not answer by default')
})

test('pair-status works when explicitly enabled', async (t) => {
  const { proc, PORT } = await startServer({ DRC_PAIR_STATUS: '1' })
  t.after(() => proc.kill())
  const r = await (await fetch(`http://127.0.0.1:${PORT}/api/pair-status?token=123456`)).json()
  assert.equal(r.ok, false, 'no such pending pair')
})

test('pending pair table is bounded', async (t) => {
  const { proc, PORT } = await startServer({ DRC_MAX_PENDING_PAIRS: '2' })
  t.after(() => proc.kill())
  const host = await connect(PORT)
  host.send(JSON.stringify({ t: 'auth', role: 'host', token: TOKEN, hostId: 'hh' }))
  await nextFrame(host, (f) => f.t === 'auth-ok')

  for (const tok of ['111111', '222222']) {
    host.send(JSON.stringify({ t: 'pair-begin', pairingToken: tok, psk: 'AAAAAAAAAAAAAAAAAAAAAA' }))
    await nextFrame(host, (f) => f.t === 'pair-ready' && f.pairingToken === tok)
  }
  host.send(JSON.stringify({ t: 'pair-begin', pairingToken: '333333', psk: 'AAAAAAAAAAAAAAAAAAAAAA' }))
  const err = await nextFrame(host, (f) => f.t === 'error')
  assert.equal(err.code, 'pair_table_full')
  host.close()
})

test('connection cap rejects excess sockets', async (t) => {
  const { proc, PORT } = await startServer({ DRC_MAX_CONNS: '2' })
  t.after(() => proc.kill())
  const a = await connect(PORT)
  const b = await connect(PORT)
  const c = await connect(PORT)
  const cClosed = once(c, 'close')
  // the third socket is closed by the server (1013 try-again-later)
  const [code] = await Promise.race([
    cClosed,
    sleep(3000).then(() => { throw new Error('excess socket was not rejected') }),
  ])
  assert.equal(code, 1013)
  a.close()
  b.close()
  c.close()
})
