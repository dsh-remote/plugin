/**
 * e2e: relay server + host runtime (mock harness) + simulated mini-program
 * client over real WebSockets, exercising the FULL loop:
 *   pairing (token+PSK) -> session list -> send prompt -> stream deltas ->
 *   permission request -> approve -> completion -> keep-awake toggle ->
 *   interrupt -> E2E audit (server frames must be opaque).
 */
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { derivePskKey, seal, open, parsePairingQr } from '../packages/protocol/dist/src/index.js'
import { HostRuntime } from '../packages/plugin/lib/host-runtime.js'
import { MockHarnessBridge } from '../packages/plugin/lib/adapter-mock.js'

const PORT = 18793
const TOKEN = '***'
const url = `ws://127.0.0.1:${PORT}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function step(name, fn) {
  return fn().then(
    () => { results.push(['PASS', name]); console.log('✅', name) },
    (e) => { results.push(['FAIL', name, e.message]); console.log('❌', name, e.message); throw e },
  )
}

async function waitHealth() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return } catch { /* not yet */ }
    await sleep(100)
  }
  throw new Error('server did not boot')
}

// ── simulated MP client ─────────────────────────────────────────
class MpClient {
  constructor() {
    this.ws = new WebSocket(url)
    this.inbox = []
    this.serverFrames = [] // raw observed frames (for the opaque-relay audit)
    this.ws.on('message', (raw) => {
      const f = JSON.parse(String(raw))
      this.serverFrames.push(f)
      if (f.t === 'enc' && this.conv) {
        const p = open(this.conv.kH2C, f) // everything arriving at the client is host->client sealed
        if (p) this.inbox.push(p)
      } else this.inbox.push(f)
    })
    this.open = new Promise((res) => this.ws.on('open', res))
  }
  send(o) { this.ws.send(JSON.stringify(o)) }
  async until(pred, ms = 5000, what = 'frame') {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const hit = this.inbox.find(pred)
      if (hit) { this.inbox = this.inbox.filter((x) => x !== hit); return hit }
      await sleep(20)
    }
    throw new Error('timeout waiting ' + what + ' ; saw ' + JSON.stringify(this.serverFrames.slice(-5)))
  }
  close() { this.ws.close() }
}

const server = spawn(process.execPath, ['apps/server/src/main.mjs'], {
  env: { ...process.env, DRC_PORT: String(PORT), DRC_HOST_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'inherit'],
})
server.stdout.resume()

try {
  await waitHealth()

  await step('boot host runtime with mock bridge', async () => {
    globalThis.__bridge = new MockHarnessBridge()
    globalThis.__rt = new HostRuntime({
      config: { serverUrl: url, hostToken: TOKEN, hostLabel: 'e2e-host', keepAwakeEnabled: false },
      bridge: globalThis.__bridge,
      log: () => {},
    })
    globalThis.__rt.start()
    await sleep(300)
    assert.equal(globalThis.__rt.relay.status, 'online')
  })

  await step('pairing via token + QR psk', async () => {
    globalThis.__pair = globalThis.__rt.createPairing(60_000)
    assert.match(globalThis.__pair.token, /^\d{6}$/)
    const qr = parsePairingQr(globalThis.__pair.qr)
    assert.ok(qr?.psk)
    globalThis.__qr = qr

    const mp = (globalThis.__mp = new MpClient())
    await mp.open
    mp.send({ t: 'hello', role: 'client', protocol: 1, clientId: 'wx-e2e', clientMeta: { platform: 'wechat-mp' } })
    await mp.until((f) => f.t === 'hello-ok', 3000, 'hello-ok')
    mp.send({ t: 'pair-begin-client', pairingToken: globalThis.__pair.token })
    const paired = await mp.until((f) => f.t === 'paired', 3000, 'paired')
    mp.conv = {
      sessionId: paired.sessionId,
      kH2C: derivePskKey(qr.psk, 'h2c', paired.sessionId), // host->client, MP opens
      kC2H_reverse: derivePskKey(qr.psk, 'c2h', paired.sessionId), // MP seals (client->host)
    }
    globalThis.__cid = paired.sessionId
  })

  await step('client asks session list, receives encrypted sessions', async () => {
    const mp = globalThis.__mp
    mp.send({ t: 'enc', sessionId: mp.conv.sessionId, seq: 1, ciphertext: seal(mp.conv.kC2H_reverse, { t: 'cmd.list_sessions', cmdId: 'c1' }).ciphertext })
    const ev = await mp.until((p) => p.t === 'ev.result' && p.cmdId === 'c1', 4000, 'ev.result')
    assert.ok(Array.isArray(ev.data.sessions))
    assert.ok(ev.data.sessions.some((s) => s.id === 'ses_mock1'))
  })

  await step('send prompt -> deltas stream to client', async () => {
    const mp = globalThis.__mp
    const cmd = { t: 'cmd.send_prompt', cmdId: 'p1', sessionId: 'ses_mock1', text: '生成周报并跑测试' }
    mp.send({ t: 'enc', sessionId: mp.conv.sessionId, seq: 2, ciphertext: seal(mp.conv.kC2H_reverse, cmd).ciphertext })
    const d0 = await mp.until((p) => p.t === 'ev.message_delta', 5000, 'first delta')
    assert.ok(d0.delta.includes('段0'))
  })

  await step('permission request reaches client; approve resumes run to completion', async () => {
    const mp = globalThis.__mp
    const perm = await mp.until((p) => p.t === 'ev.permission_request', 5000, 'permission_request')
    assert.equal(perm.sessionId, 'ses_mock1')
    assert.ok(perm.options.some((o) => o.id === 'approve'))
    globalThis.__permReq = perm.requestId
    const cmd = { t: 'cmd.resolve_permission', cmdId: 'r1', sessionId: perm.sessionId, requestId: perm.requestId, decision: 'approve' }
    mp.send({ t: 'enc', sessionId: mp.conv.sessionId, seq: 3, ciphertext: seal(mp.conv.kC2H_reverse, cmd).ciphertext })
    const done = await mp.until((p) => p.t === 'ev.message_delta' && p.done === true, 6000, 'final delta')
    assert.ok(done.delta.includes('完成'))
    assert.equal(globalThis.__bridge.pendingPermissions.size, 0)
  })

  await step('question request + answer loop', async () => {
    const mp = globalThis.__mp
    const reqId = globalThis.__bridge.raiseQuestion('ses_mock1')
    const q = await mp.until((p) => p.t === 'ev.question_request' && p.requestId === reqId, 4000, 'question_request')
    assert.equal(q.questions[0].question.includes('部署'), true)
    const cmd = { t: 'cmd.answer', cmdId: 'a1', sessionId: 'ses_mock1', requestId: reqId, answers: [{ questionId: 'q1', selected: ['staging'] }] }
    mp.send({ t: 'enc', sessionId: mp.conv.sessionId, seq: 4, ciphertext: seal(mp.conv.kC2H_reverse, cmd).ciphertext })
    const r = await mp.until((p) => p.t === 'ev.result' && p.cmdId === 'a1', 4000, 'answer result')
    assert.equal(r.ok, true)
    assert.equal(globalThis.__bridge.pendingQuestions.size, 0)
  })

  await step('keep-awake command reflected back (state event)', async () => {
    const mp = globalThis.__mp
    const cmd = { t: 'cmd.keep_awake', cmdId: 'k1', enabled: true, idleReleaseSec: 60 }
    mp.send({ t: 'enc', sessionId: mp.conv.sessionId, seq: 5, ciphertext: seal(mp.conv.kC2H_reverse, cmd).ciphertext })
    const st = await mp.until((p) => p.t === 'ev.keep_awake_state', 4000, 'keep_awake_state')
    assert.equal(st.enabled, true)
    assert.equal(st.platform, process.platform)
    // disable again
    const cmd2 = { t: 'cmd.keep_awake', cmdId: 'k2', enabled: false }
    mp.send({ t: 'enc', sessionId: mp.conv.sessionId, seq: 6, ciphertext: seal(mp.conv.kC2H_reverse, cmd2).ciphertext })
    const st2 = await mp.until((p) => p.t === 'ev.keep_awake_state' && p.enabled === false, 4000, 'keep_awake off')
    assert.equal(st2.active, false)
  })

  await step('interrupt command works', async () => {
    const mp = globalThis.__mp
    await globalThis.__bridge.sendPrompt('ses_mock1', '长任务')
    await sleep(50)
    const cmd = { t: 'cmd.interrupt', cmdId: 'i1', sessionId: 'ses_mock1' }
    mp.send({ t: 'enc', sessionId: mp.conv.sessionId, seq: 7, ciphertext: seal(mp.conv.kC2H_reverse, cmd).ciphertext })
    const st = await mp.until((p) => p.t === 'ev.run_state' && p.detail === 'interrupted', 4000, 'interrupt state')
    assert.equal(st.state, 'idle')
  })

  await step('zero-knowledge audit: relay only ever saw opaque ciphertext', async () => {
    const mp = globalThis.__mp
    const dataFrames = mp.serverFrames.filter((f) => f.t === 'enc')
    assert.ok(dataFrames.length >= 10)
    for (const f of dataFrames) {
      const buf = Buffer.from(f.ciphertext, 'base64')
      assert.ok(buf.length > 40)
      // the plaintext markers must NOT appear in any server-observed frame
      const asText = buf.toString('latin1')
      assert.ok(!asText.includes('cmd.send_prompt'), 'plaintext leaked into relay frame!')
      assert.ok(!asText.includes('生成周报'), 'plaintext leaked into relay frame!')
    }
    // also control-plane JSON never carries payload text
    const all = JSON.stringify(mp.serverFrames)
    assert.ok(!all.includes('周报'))
  })

  console.log(`\ne2e: ${results.filter((r) => r[0] === 'PASS').length}/${results.length} steps passed`)
} finally {
  globalThis.__rt?.stop()
  globalThis.__mp?.close()
  server.kill()
}
const failed = results.filter((r) => r[0] === 'FAIL')
if (failed.length) { console.error('E2E FAILED:', failed.map((f) => f[1]).join(', ')); process.exit(1) }
