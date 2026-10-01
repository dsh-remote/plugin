#!/usr/bin/env node
/**
 * Deployment self-check: proves the whole chain works against a REAL relay.
 *
 *   SUT = deployed relay (wss://)  +  plugin build  +  Mini Program client code
 *
 * It runs the actual Mini Program client (mp/utils/drc.js via the wx shim)
 * against a host runtime built from the installed plugin, over the network,
 * and audits that nothing but ciphertext crossed the wire.
 *
 * Usage
 *   node scripts/verify-deployment.mjs
 *   node scripts/verify-deployment.mjs --url wss://drc.example.com
 *   node scripts/verify-deployment.mjs --url wss://... --token <host token>
 *   DRC_PROFILE=~/.dsh/profiles/tui node scripts/verify-deployment.mjs
 *
 * Without --token it reads `hostToken` out of the profile's cordis.patch.yml,
 * i.e. exactly what the running plugin uses.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// ── args ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

/**
 * Two modes:
 *   (default)   spin up our own host runtime, then drive the Mini Program
 *               client through the whole loop.
 *   --pair CODE Pair against the host that is ALREADY running (your Harness).
 *   --qr TEXT   The `dshr:/p?…` line that `/drc pair` printed — supplies the
 *               server + PSK the client needs.
 * Mode 2 is the real thing: the session list it prints comes from the live
 * DSH kernel, so it also answers "carrier=dsh or mock?".
 */
const PAIR_CODE = arg('pair')
const QR_TEXT = arg('qr')
const ATTACH_MODE = Boolean(PAIR_CODE && QR_TEXT)
const PROFILE = process.env.DRC_PROFILE || path.join(homedir(), '.dsh', 'profiles', 'desktop')
const PATCH = path.join(PROFILE, 'cordis.patch.yml')

function profileValue(key) {
  if (!existsSync(PATCH)) return undefined
  const s = readFileSync(PATCH, 'utf8')
  const row = s.split(/^- id: /m).find((b) => b.startsWith('dsh-remote-control'))
  if (!row) return undefined
  return (row.match(new RegExp(`^\\s+${key}:\\s*(\\S+)`, 'm')) || [])[1]
}

const URL_ = arg('url') || profileValue('serverUrl') || 'wss://drc.provid.cc'
const TOKEN = arg('token') || process.env.DRC_HOST_TOKEN || profileValue('hostToken')
const LABEL = arg('label') || profileValue('hostLabel') || 'verify-host'

if (!TOKEN && !ATTACH_MODE) {
  console.error(`✖ 没有 host token。用 --token 传入，或让 ${PATCH} 里存在 hostToken。`)
  console.error(`  （若只是想连正在运行的主机：--pair <6位码> --qr <dshr:/p?…>）`)
  process.exit(2)
}

// ── resolve the installed plugin (what the Harness actually loads) ───
const installed = path.join(PROFILE, 'node_modules', 'dsh-remote-control', 'dist', 'src', 'index.js')
const pluginEntry = existsSync(installed) ? installed : path.join(ROOT, 'packages', 'plugin', 'dist', 'src', 'index.js')
if (!ATTACH_MODE && !existsSync(pluginEntry)) {
  console.error('✖ 找不到插件构建产物，先跑 `pnpm -r build`。')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const ok = (m) => console.log('✅', m)
const bad = (m) => {
  failures++
  console.log('❌', m)
}

console.log(`端到端自检${ATTACH_MODE ? '（连接正在运行的主机）' : '（自建临时主机）'}`)
console.log(`  relay : ${URL_}`)
console.log(`  host  : ${LABEL}`)
if (!ATTACH_MODE) {
  console.log(`  plugin: ${pluginEntry.includes('.dsh/profiles') ? '已安装到 profile' : '仓库 dist'}`)
}
console.log('')

// ── 1. relay reachable over HTTPS ────────────────────────────────────
const httpUrl = URL_.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
try {
  const r = await fetch(`${httpUrl}/healthz`, { signal: AbortSignal.timeout(10_000) })
  const body = await r.json()
  ok(`/healthz ${r.status} ${JSON.stringify(body)}`)
} catch (e) {
  bad(`/healthz 不可达：${e.message}`)
}

// ── 2. host ──────────────────────────────────────────────────────────
let rt = null
let pairing = null
if (ATTACH_MODE) {
  ok(`使用正在运行的主机的配对信息（不自建 host）`)
  pairing = { token: PAIR_CODE, qr: QR_TEXT }
} else {
  const { HostRuntime, MockHarnessBridge } = await import(pluginEntry)
  rt = new HostRuntime({
    config: { serverUrl: URL_, hostToken: TOKEN, hostLabel: LABEL, keepAwakeEnabled: false },
    bridge: new MockHarnessBridge(),
    log: () => {},
  })
  rt.start()
  for (let i = 0; i < 40 && rt.relay.status !== 'online'; i++) await sleep(250)
  if (rt.relay.status === 'online') ok(`host 已认证，hostId=${rt.relay.hostId}`)
  else bad(`host 未连上（relay status=${rt.relay.status}）—— token 或地址不对？`)
  pairing = rt.createPairing(120_000)
}

// ── 3. the real Mini Program client pairs ────────────────────────────
const { installWxShim, loadMpModules } = await import(path.join(ROOT, 'e2e', 'mp-sim.mjs'))
installWxShim()
const { crypto: mpCrypto, drc } = loadMpModules()

const events = []
const client = drc.getClient()
const off = client.on((e) => events.push(e))
const sent = []
const origSend = client.sendControl.bind(client)
client.sendControl = (f) => {
  sent.push(f)
  return origSend(f)
}

const take = async (pred, ms = 12_000, what = 'frame') => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const i = events.findIndex(pred)
    if (i >= 0) return events.splice(i, 1)[0]
    await sleep(25)
  }
  throw new Error(`等待 ${what} 超时`)
}

const PROMPT = arg('prompt') || '端到端自检：生成周报'
try {
  const qr = mpCrypto.parsePairingQr(pairing.qr)
  if (!qr) throw new Error('二维码内容解析失败')
  ok(`配对码 ${pairing.token}，二维码 server=${qr.server}`)

  client.connect({ server: qr.server, psk: qr.psk, token: pairing.token })
  await take((e) => e.kind === 'status' && e.status === 'online', 15_000, '配对完成')
  ok(`小程序配对成功，convId=${client.convId}`)

  client.listSessions()
  const list = await take((e) => e.kind === 'payload' && e.payload.t === 'ev.result' && e.payload.data, 12_000, '会话列表')
  const sessions = list.payload.data.sessions
  const mockish = sessions.filter((s) => /mock/i.test(s.id) || /^mock/i.test(s.title || ''))
  ok(`收到加密会话列表（${sessions.length} 个会话）`)
  for (const s of sessions.slice(0, 8)) {
    const bits = [s.id, s.state || '', s.title || '', s.workspace || ''].filter(Boolean)
    console.log(`     · ${bits.join('  ')}`)
  }
  if (ATTACH_MODE) {
    if (mockish.length === sessions.length && sessions.length > 0) {
      bad(`会话看起来全部来自 mock 桥接 —— 真实内核没挂上（详见 docs/SECURITY.md / HANDOFF.md）`)
    } else if (sessions.length === 0) {
      console.log('ℹ️  会话列表为空：可能是内核没挂上，也可能真的没有会话')
    } else {
      ok(`会话来自真实内核（不是 mock 桥接）`)
    }
  }

  // Sending a prompt to a REAL host starts a real agent run in the user's
  // session (tokens, workspace, tool calls). So when attaching to a live
  // host that must be opted into explicitly.
  const maySend = !ATTACH_MODE || argv.includes('--send-prompt')
  if (!maySend) {
    console.log('')
    console.log('ℹ️  已跳过发送指令 —— 对真实会话发指令会真的触发一次 agent 运行。')
    console.log('   要继续请加 --send-prompt，并用 --prompt "…" 指定内容。')
  } else {
    const targetSession =
      arg('session') || sessions.find((s) => s.id === 'ses_mock1')?.id || sessions[0]?.id
    if (!targetSession) throw new Error('主机没有可用会话，无法发送指令')
    console.log(`     → 发送到 ${targetSession}`)
    client.sendPrompt(targetSession, PROMPT)
    const d = await take((e) => e.kind === 'payload' && e.payload.t === 'ev.message_delta', 30_000, '流式输出')
    ok(`流式输出到达：${JSON.stringify(d.payload.delta.slice(0, 120))}`)

    // The host coalesces deltas inside a short window, so the model's text and
    // the terminal flag often arrive in the SAME frame. Treating the first
    // frame as "text only" and then blocking on a second one turns a finished
    // run into a timeout.
    if (d.payload.done === true) {
      ok('回合已收尾（首帧即含 done）')
    } else {
      // A prompt that asks for no tools produces no approval card at all, so
      // race the two ways a run can continue and report which one happened.
      const next = await take(
        (e) =>
          e.kind === 'payload' &&
          (e.payload.t === 'ev.permission_request' ||
            (e.payload.t === 'ev.message_delta' && e.payload.done)),
        30_000,
        '审批请求或收尾',
      )

      if (next.payload.t === 'ev.permission_request') {
        ok(`审批卡到达：${next.payload.action} ${next.payload.resource || ''}`)
        client.resolvePermission(next.payload.sessionId, next.payload.requestId, 'approve')
        const done = await take(
          (e) => e.kind === 'payload' && e.payload.t === 'ev.message_delta' && e.payload.done,
          30_000,
          '任务完成',
        )
        ok(`审批通过后任务完成：${JSON.stringify(done.payload.delta.slice(0, 120))}`)
      } else {
        ok('本轮无需审批（prompt 未触发工具）—— 回合已正常收尾')
      }
    }
  }

  // ── 4. zero-knowledge audit on the public path ────────────────────
  // Frames sent so far: list_sessions (+ subscribe). A prompt adds more, but
  // in attach-mode without --send-prompt two frames is a complete run.
  const enc = sent.filter((f) => f && f.t === 'enc')
  const leaked = enc.filter((f) => {
    const bytes = Buffer.from(f.ciphertext, 'base64')
    return bytes.toString('latin1').includes(PROMPT) || bytes.toString('latin1').includes('cmd.')
  })
  if (enc.length >= 1 && leaked.length === 0) ok(`零知识：${enc.length} 个上行帧全为密文（无明文/无命令名）`)
  else bad(`密文审计失败（${enc.length} 帧，${leaked.length} 帧泄露明文）`)
} catch (e) {
  bad(`端到端流程失败：${e.message}`)
} finally {
  off()
  client.disconnect()
  rt?.stop()
}

console.log('')
if (failures) {
  console.log(`❌ 自检失败：${failures} 项`)
  process.exit(1)
}
console.log('🎉 端到端自检全部通过')
