/**
 * Regression: several pairing codes outstanding at once.
 *
 * A host can legitimately offer more than one code — an auto-published code
 * plus a `/drc pair`, or two `/drc pair`s inside the TTL. The host must derive
 * the conversation keys from the PSK belonging to the token the CLIENT USED,
 * not from "the most recent one". Picking the wrong PSK produces keys the
 * client cannot reproduce: every payload fails to decrypt, so the session list
 * stays empty and the UI shows a cryptic "cannot decrypt" error.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import WebSocket from 'ws'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const rp = (p) => path.join(ROOT, p)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function startServer(port, token) {
  const proc = spawn(process.execPath, [rp('apps/server/src/main.mjs')], {
    env: { ...process.env, DRC_PORT: String(port), DRC_HOST_TOKEN: token, DRC_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.resume()
  proc.stderr.resume()
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (r.ok) return proc
    } catch {
      /* not up yet */
    }
    await sleep(100)
  }
  throw new Error('server did not start')
}

/** Minimal client: control frames in the clear, payloads PSK-encrypted. */
function makeClient(crypto, url) {
  const ws = new WebSocket(url)
  const inbox = []
  ws.on('message', (d) => inbox.push(JSON.parse(String(d))))
  const send = (f) => ws.send(JSON.stringify(f))
  const take = async (pred, ms = 6000, what = 'frame') => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const i = inbox.findIndex(pred)
      if (i >= 0) return inbox.splice(i, 1)[0]
      await sleep(30)
    }
    throw new Error(`timeout waiting for ${what}`)
  }
  return { ws, inbox, send, take }
}

test('pairing with an EARLIER token still yields working keys', async (t) => {
  const PORT = 18931
  const TOKEN = 'multi-pair-test-token-0123456789abcdef'
  const server = await startServer(PORT, TOKEN)
  t.after(() => server.kill())

  const { HostRuntime, MockHarnessBridge } = await import(rp('packages/plugin/dist/src/index.js'))
  const crypto = await import(rp('packages/protocol/dist/src/index.js'))

  const rt = new HostRuntime({
    config: {
      serverUrl: `ws://127.0.0.1:${PORT}`,
      hostToken: TOKEN,
      hostLabel: 'multi',
      keepAwakeEnabled: false,
    },
    bridge: new MockHarnessBridge(),
    log: () => {},
  })
  rt.start()
  t.after(() => rt.stop())
  for (let i = 0; i < 40 && rt.relay.status !== 'online'; i++) await sleep(100)
  assert.equal(rt.relay.status, 'online')

  // Two codes outstanding at the same time, exactly like an auto-published
  // code followed by `/drc pair`.
  const first = rt.createPairing(60_000, { includeToken: true })
  const second = rt.createPairing(60_000, { includeToken: true })
  assert.notEqual(first.token, second.token)
  await sleep(400) // let both pair-ready land

  const qr1 = crypto.parsePairingQr(first.qr)
  assert.ok(qr1, 'first QR parses')

  // The client pairs with the FIRST code — the one that is no longer "latest".
  const c = makeClient(crypto, `ws://127.0.0.1:${PORT}`)
  await new Promise((r) => c.ws.on('open', r))
  c.send({ t: 'hello', role: 'client', protocol: 1, clientId: 'mp-test' })
  await c.take((f) => f.t === 'hello-ok')
  c.send({ t: 'pair-begin-client', pairingToken: first.token })
  const paired = await c.take((f) => f.t === 'paired' || f.t === 'pair-fail')
  assert.equal(paired.t, 'paired', 'the earlier token must still be claimable')

  const sessionId = paired.sessionId
  const kC2H = crypto.derivePskKey(qr1.psk, 'c2h', sessionId)
  const kH2C = crypto.derivePskKey(qr1.psk, 'h2c', sessionId)
  let seq = 0

  // Ask for the session list. If the host used the wrong PSK it either cannot
  // decrypt this at all, or seals its reply with keys we cannot open.
  const cmd = { t: 'cmd.list_sessions', cmdId: 'multi-1' }
  c.send({
    t: 'enc',
    sessionId,
    seq: ++seq,
    clientId: 'mp-test',
    ciphertext: crypto.seal(kC2H, cmd).ciphertext,
  })

  // The host pushes keep-awake state on join; every frame it sends must be
  // openable with our keys. Take frames until the command's result arrives.
  let opened = null
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const reply = await c.take((f) => f.t === 'enc', 8000, 'encrypted reply')
    const payload = crypto.open(kH2C, { ciphertext: reply.ciphertext })
    assert.ok(payload, 'host reply must decrypt with the PSK of the code we used')
    if (payload.t === 'ev.result') {
      opened = payload
      break
    }
  }
  assert.ok(opened, 'the session list result must arrive and decrypt')
  assert.ok(Array.isArray(opened.data.sessions))

  c.ws.close()
})
