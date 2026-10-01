import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import WebSocket from 'ws'

const PORT = 18791
const TOKEN = '***'
let proc

async function startServer() {
  proc = spawn(process.execPath, ['src/main.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, DRC_PORT: String(PORT), DRC_HOST_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.resume()
  proc.stderr.pipe(process.stderr)
  // wait until listening
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`)
      if (r.ok) return
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server did not come up')
}

const connect = () => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
  ws.on('open', () => res(ws))
  ws.on('error', rej)
})

function nextFrame(ws, pred, ms = 3000) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { ws.off('message', on); rej(new Error('timeout waiting frame')) }, ms)
    const on = (raw) => { const f = JSON.parse(String(raw)); if (pred(f)) { clearTimeout(timer); ws.off('message', on); res(f) } }
    ws.on('message', on)
  })
}

test('pairing + encrypted relay end-to-end', async (t) => {
  await startServer()
  t.after(() => proc?.kill())

  // ── host auths and issues pair token ──
  const host = await connect()
  host.send(JSON.stringify({ t: 'auth', role: 'host', token: TOKEN, hostId: 'h1', label: 'mac' }))
  const ok = await nextFrame(host, (f) => f.t === 'auth-ok')
  assert.equal(ok.hostId, 'h1')

  host.send(JSON.stringify({ t: 'pair-begin', pairingToken: '123456', psk: 'AAAAAAAAAAAAAAAAAAAAAA' }))
  assert.ok((await nextFrame(host, (f) => f.t === 'pair-ready')).pairingToken === '123456')

  // ── client claims pair token ──
  const cl = await connect()
  cl.send(JSON.stringify({ t: 'hello', role: 'client', protocol: 1, clientId: 'wx-1' }))
  await nextFrame(cl, (f) => f.t === 'hello-ok')
  cl.send(JSON.stringify({ t: 'pair-begin-client', pairingToken: '123456' }))
  const paired = await nextFrame(cl, (f) => f.t === 'paired')
  assert.match(paired.sessionId, /^c_/)

  // host sees peer-joined
  const joined = await nextFrame(host, (f) => f.t === 'peer-joined')
  assert.equal(joined.sessionId, paired.sessionId)
  assert.equal(joined.clientId, 'wx-1')

  // ── opaque enc relay, both directions, seq assigned by server ──
  cl.send(JSON.stringify({ t: 'enc', sessionId: paired.sessionId, seq: 1, ciphertext: 'Q1IfrB==x' }))
  const atHost = await nextFrame(host, (f) => f.t === 'enc')
  assert.equal(atHost.ciphertext, 'Q1IfrB==x')
  assert.equal(atHost.sessionId, paired.sessionId)

  host.send(JSON.stringify({ t: 'enc', sessionId: paired.sessionId, seq: 9, ciphertext: 'aG9zdA==' }))
  const atClient = await nextFrame(cl, (f) => f.t === 'enc')
  assert.equal(atClient.ciphertext, 'aG9zdA==')
  assert.equal(atClient.seq, 1) // server numbers host->client stream

  // ── pair token cannot be reused ──
  const cl2 = await connect()
  cl2.send(JSON.stringify({ t: 'hello', role: 'client', protocol: 1 }))
  cl2.send(JSON.stringify({ t: 'pair-begin-client', pairingToken: '123456' }))
  const fail = await nextFrame(cl2, (f) => f.t === 'pair-fail')
  assert.equal(fail.reason, 'already_used')

  // ── bad host token closes socket ──
  const bad = await connect()
  bad.send(JSON.stringify({ t: 'auth', role: 'host', token: 'wrong' }))
  const f = await nextFrame(bad, (x) => x.t === 'auth-fail')
  assert.equal(f.reason, 'bad_token')

  host.close(); cl.close(); cl2.close(); bad.close()
})

test('health endpoint', async (t) => {
  await startServer()
  t.after(() => proc?.kill())
  const r = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()
  assert.equal(r.ok, true)
})
