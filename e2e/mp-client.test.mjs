/**
 * Full-loop test of the WeChat Mini Program client code.
 *
 * Drives mp/utils/drc.js (via the wx shim in mp-sim.mjs) against a real relay
 * server and a HostRuntime backed by MockHarnessBridge — i.e. exactly the
 * production path, minus the WeChat renderer.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { installWxShim, loadMpModules } from './mp-sim.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const rp = (p) => path.join(ROOT, p)

const PORT = 18794
const TOKEN = 'mp-sim-host-token'
const URL = `ws://127.0.0.1:${PORT}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The shim must exist before mp/utils is loaded.
installWxShim()
const { crypto: mpCrypto, drc } = loadMpModules()
// Import the compiled plugin output (NOT the stale lib/ dir that used to
// shadow it) — this is the same artifact that gets installed into a profile.
const { HostRuntime } = await import(rp('packages/plugin/dist/src/host-runtime.js'))
const { MockHarnessBridge } = await import(rp('packages/plugin/dist/src/adapter-mock.js'))

let server, bridge, rt, client, events, stopCollect
let pairingToken, shared

before(async () => {
  server = spawn(process.execPath, [rp('apps/server/src/main.mjs')], {
    env: { ...process.env, DRC_PORT: String(PORT), DRC_HOST_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  server.stdout.resume()
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`)
      if (r.ok) break
    } catch {
      /* not yet */
    }
    await sleep(100)
  }

  bridge = new MockHarnessBridge()
  rt = new HostRuntime({
    config: { serverUrl: URL, hostToken: TOKEN, hostLabel: 'mp-sim-host', keepAwakeEnabled: false },
    bridge,
    log: () => {},
  })
  rt.start()
  await sleep(300)
  assert.equal(rt.relay.status, 'online')

  events = []
  client = drc.getClient()
  stopCollect = client.on((e) => events.push(e))
})

after(() => {
  stopCollect && stopCollect()
  client && client.disconnect()
  rt && rt.stop()
  server && server.kill()
})

function take(pred, ms = 5000, what = 'event') {
  const deadline = Date.now() + ms
  return (async () => {
    while (Date.now() < deadline) {
      const i = events.findIndex(pred)
      if (i >= 0) return events.splice(i, 1)[0]
      await sleep(20)
    }
    throw new Error(`timeout waiting for ${what}; saw ${JSON.stringify(events.map((e) => e.kind + ':' + (e.payload ? e.payload.t : e.status)).slice(-8))}`)
  })()
}

/** Each test starts from a clean inbox so a leftover frame cannot satisfy it. */
function drain() {
  events.length = 0
}

async function waitUntil(fn, ms = 5000, what = 'condition') {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(20)
  }
  throw new Error('timeout waiting for ' + what)
}

test('client pairs with token + PSK taken from the host QR', async () => {
  const p = rt.createPairing(60_000)
  assert.match(p.token, /^\d{6}$/)
  pairingToken = p.token

  const qr = mpCrypto.parsePairingQr(p.qr)
  assert.ok(qr, 'mini program must parse the host QR')
  assert.equal(qr.server, URL)
  assert.ok(qr.psk)

  shared = qr
  client.connect({ server: qr.server, psk: qr.psk, token: pairingToken })

  const st = await take((e) => e.kind === 'status' && e.status === 'online', 6000, 'paired status')
  assert.ok(st)
  assert.ok(client.convId.startsWith('c_'))
  assert.ok(client.isPaired())
})

test('client receives the encrypted session list', async () => {
  drain()
  client.listSessions()
  const ev = await take((e) => e.kind === 'payload' && e.payload.t === 'ev.result' && e.payload.data, 6000, 'session list')
  const sessions = ev.payload.data.sessions
  assert.ok(Array.isArray(sessions))
  assert.ok(sessions.some((s) => s.id === 'ses_mock1'))
})

test('send prompt -> deltas -> permission card -> approve -> completion', async () => {
  drain()
  // The mock harness runs one continuous flow: deltas, a tool call, then a
  // permission request that pauses the run. Keep it in ONE test so the
  // boundary never splits the flow in half.
  client.sendPrompt('ses_mock1', '生成周报并跑测试')

  const d0 = await take((e) => e.kind === 'payload' && e.payload.t === 'ev.message_delta', 6000, 'first delta')
  assert.ok(d0.payload.delta.includes('段0'))

  const t = await take((e) => e.kind === 'payload' && e.payload.t === 'ev.tool_event', 6000, 'tool event')
  assert.equal(t.payload.tool, 'bash')

  const req = await take((e) => e.kind === 'payload' && e.payload.t === 'ev.permission_request', 6000, 'permission_request')
  assert.equal(req.payload.sessionId, 'ses_mock1')
  assert.ok(req.payload.options.some((o) => o.id === 'approve'))

  client.resolvePermission(req.payload.sessionId, req.payload.requestId, 'approve')

  const done = await take(
    (e) => e.kind === 'payload' && e.payload.t === 'ev.message_delta' && e.payload.done === true,
    8000,
    'final delta',
  )
  assert.ok(done.payload.delta.includes('完成'))
  await waitUntil(() => bridge.pendingPermissions.size === 0, 5000, 'pendingPermissions drained')

  // the host refreshes sessions after a state-changing command; the client
  // must have folded that into its own store
  await waitUntil(() => client.sessions.some((s) => s.id === 'ses_mock1'), 6000, 'client.sessions populated')
})

test('question card -> answer -> host confirms', async () => {
  drain()
  const requestId = bridge.raiseQuestion('ses_mock1')
  const q = await take((e) => e.kind === 'payload' && e.payload.t === 'ev.question_request', 6000, 'question_request')
  assert.equal(q.payload.requestId, requestId)
  assert.ok(q.payload.questions[0].question.includes('部署'))

  client.answer('ses_mock1', requestId, [{ questionId: 'q1', selected: ['staging'] }])
  // the mock bridge echoes the answered requestId — wait for THAT, not for any
  // generic ok result (previous commands leave their own ev.result behind)
  await take(
    (e) => e.kind === 'payload' && e.payload.t === 'ev.result' && e.payload.data && e.payload.data.answered === requestId,
    6000,
    'answer echo',
  )
  await waitUntil(() => bridge.pendingQuestions.size === 0, 5000, 'pendingQuestions drained')
})

test('keep-awake toggle is reflected back to the client', async () => {
  drain()
  client.setKeepAwake(true, 60)
  const st = await take((e) => e.kind === 'payload' && e.payload.t === 'ev.keep_awake_state' && e.payload.enabled === true, 6000, 'keep_awake on')
  assert.equal(st.payload.platform, process.platform)
  client.setKeepAwake(false)
  await take((e) => e.kind === 'payload' && e.payload.t === 'ev.keep_awake_state' && e.payload.enabled === false, 6000, 'keep_awake off')
})

test('interrupt stops the run', async () => {
  drain()
  await bridge.sendPrompt('ses_mock1', '长任务')
  await sleep(50)
  client.interrupt('ses_mock1')
  const st = await take((e) => e.kind === 'payload' && e.payload.t === 'ev.run_state' && e.payload.detail === 'interrupted', 6000, 'interrupted')
  assert.equal(st.payload.state, 'idle')
})

test('nonce counter never repeats across many sends', async () => {
  const seen = new Set()
  for (let i = 0; i < 30; i++) {
    const pairing = client._resume
    const nonce = loadStoreNextNonce(pairing)
    const b64 = mpCrypto.encodeBase64(nonce)
    assert.ok(!seen.has(b64), 'nonce repeated!')
    seen.add(b64)
  }
  assert.equal(seen.size, 30)
})

test('stale conversation is reported as needs-pair, not a crash', async () => {
  drain()
  // simulate the relay forgetting the conversation (host restart / app relaunch)
  client.convId = 'c_deadbeef'
  client.kC2H = mpCrypto.derivePskKey(shared.psk, 'c2h', 'c_deadbeef')
  client.kH2C = mpCrypto.derivePskKey(shared.psk, 'h2c', 'c_deadbeef')
  client.seq = 0
  client.sendCmd({ t: 'cmd.list_sessions', cmdId: 'stale1' })
  const st = await take((e) => e.kind === 'status' && e.status === 'needs-pair', 6000, 'needs-pair status')
  assert.ok(st.text.includes('重新配对') || st.text.includes('失效'))
})

// small helper: go through the same code path the client uses
function loadStoreNextNonce(pairing) {
  const store = requireStore()
  return store.nextNonceFor(pairing)
}
function requireStore() {
  return loadMpModules().store
}
