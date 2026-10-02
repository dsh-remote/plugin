#!/usr/bin/env node
/**
 * live-e2e — 真实链路的端到端闭环测试（不 mock）。
 *
 * 三个真实：
 *   1. 真实的小程序客户端代码（mp/core/client.js，靠 wx shim 在 Node 里跑）；
 *   2. 真实的中继（默认线上 wss://drc.provid.cc，nginx + TLS）；
 *   3. 真实的内核载体 —— 本机 DSH Harness 里运行的插件（carrier=services）。
 *
 * 与 scripts/verify-deployment.mjs 的区别：那个可以自建 mock 主机（会掩盖
 * 真实链路的问题），这个**必须**连真实主机，拿不到配对码就失败退出，
 * 绝不退化成 mock —— 假通过比失败更贵。
 *
 * 用法：
 *   node e2e/live-e2e.mjs                       # 完整闭环（含发一条指令）
 *   node e2e/live-e2e.mjs --no-prompt           # 只验证配对/列表/防休眠
 *   node e2e/live-e2e.mjs --rounds 3            # 连跑 3 轮（查稳定性）
 *   node e2e/live-e2e.mjs --session <id> --prompt '...'
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const rp = (p) => path.join(ROOT, p)

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name) => argv.includes(`--${name}`)

const STATUS = path.join(homedir(), '.dsh', 'dsh-remote-control', 'status.json')
const RELAY_URL = arg('url') ?? 'wss://drc.provid.cc'
const HTTP_URL = RELAY_URL.replace(/^ws/, 'http')
const ROUNDS = Number(arg('rounds') ?? 1)
const PROMPT = arg('prompt') ?? '只回复 ok 两个字，不要调用任何工具'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
let checks = 0
const ok = (m) => {
  checks++
  console.log(`  ✅ ${m}`)
}
const bad = (m) => {
  checks++
  failures++
  console.log(`  ❌ ${m}`)
}
const info = (m) => console.log(`  ℹ️  ${m}`)

/** Use an explicitly supplied pairing code (no auto-publish needed). */
function explicitPairing() {
  const token = arg('pair')
  const qrText = arg('qr')
  if (!token || !qrText) return null
  return { token, qr: qrText, left: 180 }
}

/**
 * Wait for a pairing code we have NOT used yet.
 *
 * Codes are single-use: re-offering a consumed one (status.json republishes
 * on a timer, not on consumption) makes the round fail for a bogus reason.
 */
async function waitForPairing(seconds = 150, used = new Set()) {
  const deadline = Date.now() + seconds * 1000
  let lastReason = 'status.json 不存在'
  while (Date.now() < deadline) {
    if (!existsSync(STATUS)) {
      lastReason = 'status.json 不存在（插件没跑？）'
    } else {
      try {
        const d = JSON.parse(readFileSync(STATUS, 'utf8'))
        const p = d.pairing
        if (d.relay !== 'online') lastReason = `host relay=${d.relay}`
        else if (!p?.qr) lastReason = 'status.json 里没有 pairing（pairOnStartSec 未开？）'
        else {
          const left = (Date.parse(p.expiresAt) - Date.now()) / 1000
          const ageMs = p.createdAt ? Date.now() - p.createdAt : null
          // Codes are single-use, and status.json republishes on a timer —
          // not on consumption — so an unconsumed-looking code may already be
          // spent by an earlier run. Only trust a freshly issued one.
          if (used.has(p.token)) lastReason = `配对码 ${p.token} 本轮已用过（一次性）`
          else if (ageMs !== null && ageMs > 25_000) lastReason = `配对码已发布 ${Math.round(ageMs / 1000)}s，可能已被消费`
          else if (left <= 60) lastReason = `配对码只剩 ${Math.round(left)}s`
          else return { ...p, left }
        }
      } catch (e) {
        lastReason = `status.json 解析失败：${e.message}`
      }
    }
    await sleep(1500)
  }
  throw new Error(`等不到可用的真实配对码：${lastReason}`)
}

async function runRound(n) {
  console.log(`\n=== 第 ${n} 轮 · ${RELAY_URL} ===`)

  // 1. relay reachable
  const health = await (await fetch(`${HTTP_URL}/healthz`)).json()
  if (health.ok) ok(`中继可达（hosts=${health.hosts} clients=${health.clients}）`)
  else bad('中继 /healthz 不健康')

  // 2. real host must offer a code
  const pair = explicitPairing() ?? (await waitForPairing(150, usedTokens))
  usedTokens.add(pair.token)
  ok(`真实主机发布配对码 ${pair.token}（剩余 ${Math.round(pair.left)}s）`)

  // 3. real mini-program client code
  const { installWxShim, loadMpModules } = await import(rp('e2e/mp-sim.mjs'))
  installWxShim()
  const { crypto: mpCrypto, drc } = loadMpModules()
  const qr = mpCrypto.parsePairingQr(pair.qr)
  if (!qr) throw new Error('二维码解析失败')
  if (qr.server !== RELAY_URL) bad(`二维码里的地址 ${qr.server} 与期望的 ${RELAY_URL} 不一致`)
  else ok(`小程序解析出中继地址与 PSK${qr.token ? '（二维码内嵌配对码 ✓）' : ''}`)

  const client = drc.getClient()
  const events = []
  const off = client.on((e) => events.push(e))

  // zero-knowledge audit: capture every outbound control frame
  const outbound = []
  const origSend = client.sendControl.bind(client)
  client.sendControl = (f) => {
    outbound.push(f)
    return origSend(f)
  }

  const take = async (pred, ms, what) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const i = events.findIndex(pred)
      if (i >= 0) return events.splice(i, 1)[0]
      await sleep(40)
    }
    throw new Error(`超时：${what}`)
  }

  // 4. pair — retry with a fresh code when the one we grabbed was already
  // spent (codes are single-use and another client may have claimed it).
  // A genuine failure still fails: only "already used / expired" retries.
  let online = null
  let lastErr = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = attempt === 1 ? pair : await waitForPairing(150, usedTokens)
    usedTokens.add(code.token)
    const parsed = attempt === 1 ? qr : mpCrypto.parsePairingQr(code.qr)
    const t0 = Date.now()
    events.length = 0
    client.connect({
      server: parsed.server,
      psk: parsed.psk,
      token: parsed.token || code.token,
    })
    try {
      online = await take((e) => e.kind === 'status' && e.status === 'online', 25_000, '配对完成')
      ok(`配对成功（${Date.now() - t0}ms）${online.text ? ' · ' + online.text : ''}`)
      break
    } catch (e) {
      const err = events.find((x) => x.kind === 'error')
      const msg = err?.message || e.message
      lastErr = msg
      const retryable = /已被使用|无效或已过期|already_used|invalid_or_expired/.test(msg)
      const tail = events.slice(-8).map((x) => `${x.kind}:${x.status ?? (x.payload?.t ?? '')}`)
      if (!retryable || attempt === 3) {
        bad(`配对失败：${msg}`)
        info(`事件轨迹：${tail.join(' → ') || '(空)'}`)
        off()
        return
      }
      info(`第 ${attempt} 次配对码已失效，换新码重试（${msg}）`)
      client.disconnect()
      await sleep(1000)
    }
  }
  if (!online) {
    bad(`配对失败（已重试）：${lastErr}`)
    off()
    return
  }

  // 5. session list — must be non-empty and come from the real kernel
  client.listSessions()
  let sessions = []
  try {
    const ev = await take(
      (e) => e.kind === 'payload' && e.payload.t === 'ev.result' && e.payload.data,
      20_000,
      '会话列表',
    )
    sessions = ev.payload.data.sessions || []
    if (sessions.length === 0) bad('会话列表为空（真实内核应有会话）')
    else {
      ok(`收到会话列表 ${sessions.length} 个（真实内核）`)
      for (const s of sessions.slice(0, 5)) {
        console.log(`       · ${s.id.slice(0, 12)}… ${s.state || '?'} ${s.title || ''}`)
      }
      const mockish = sessions.filter((s) => s.id.startsWith('ses_mock'))
      if (mockish.length) bad(`列表里出现 mock 会话（说明连到了 mock 主机）`)
    }
  } catch (e) {
    bad(`会话列表失败：${e.message}`)
  }

  // 6. keep-awake round trip
  try {
    client.setKeepAwake?.(true, 60)
    const ev = await take((e) => e.kind === 'payload' && e.payload.t === 'ev.keep_awake_state', 15_000, '防休眠状态')
    ok(`防休眠开关回传：${JSON.stringify(ev.payload)}`.slice(0, 120))
  } catch (e) {
    bad(`防休眠开关无回传：${e.message}`)
  }

  // 7. drive a real turn
  if (!has('no-prompt') && sessions.length) {
    const target = arg('session') || sessions.find((s) => s.state === 'idle')?.id || sessions[0].id
    const chosen = sessions.find((s) => s.id === target)
    if (chosen?.state === 'archived') info('该会话是归档状态 —— 主机应自动恢复后再执行')
    info(`向会话 ${target.slice(0, 12)}… 发送指令：${PROMPT}`)
    client.sendPrompt(target, PROMPT)
    let done = null
    let answered = false
    const deadline = Date.now() + 90_000
    try {
      while (Date.now() < deadline) {
        const ev = await take(
          (e) =>
            e.kind === 'payload' &&
            (e.payload.t === 'ev.message_delta' ||
              e.payload.t === 'ev.permission_request' ||
              e.payload.t === 'ev.question_request' ||
              e.payload.t === 'ev.run_state' ||
              e.payload.t === 'ev.tool_event'),
          20_000,
          '回合事件',
        )
        const p = ev.payload
        if (p.t === 'ev.permission_request') {
          ok(`审批卡到达：${p.action} ${p.resource || ''}`)
          client.resolvePermission(p.sessionId, p.requestId, 'approve')
          answered = true
          continue
        }
        if (p.t === 'ev.question_request') {
          ok(`提问卡到达：${(p.questions?.[0]?.question || '').slice(0, 40)}`)
          const q = p.questions?.[0]
          client.answer(p.sessionId, p.requestId, q ? [{ questionId: q.id, selected: [q.options?.[0]?.id] }] : [])
          answered = true
          continue
        }
        if (p.t === 'ev.message_delta') {
          if (!done) ok(`流式输出到达：${JSON.stringify((p.delta || '').slice(0, 60))}`)
          if (p.done) {
            done = p
            break
          }
        }
      }
      if (done) ok(`回合正常收尾（审批/提问：${answered ? '有' : '无'}）`)
      else bad('回合未在 90s 内收尾（没有收到 done）')
    } catch (e) {
      bad(`回合失败：${e.message}`)
    }
  }

  // 8. zero-knowledge audit
  const encFrames = outbound.filter((f) => f && f.t === 'enc')
  const leaked = encFrames.filter((f) => {
    const raw = Buffer.from(String(f.ciphertext || ''), 'base64').toString('latin1')
    return raw.includes(PROMPT) || raw.includes('cmd.send_prompt')
  })
  if (encFrames.length >= 2 && leaked.length === 0) {
    ok(`零知识：${encFrames.length} 个上行帧全为密文（含明文与命令名检查）`)
  } else {
    bad(`密文审计异常（${encFrames.length} 帧，${leaked.length} 帧泄露）`)
  }

  // 9. unpair
  client.unpair()
  await sleep(400)
  if (client.status === 'needs-pair' || client.status === 'idle') ok('解除配对后状态正确')
  else bad(`解除配对后状态异常：${client.status}`)

  off()
}

const usedTokens = new Set()
console.log(`真实链路端到端测试\n  relay : ${RELAY_URL}\n  轮次  : ${ROUNDS}`)
for (let i = 1; i <= ROUNDS; i++) {
  try {
    await runRound(i)
  } catch (e) {
    bad(`第 ${i} 轮异常终止：${e.message}`)
  }
}

console.log('')
console.log(`检查项 ${checks} 个，失败 ${failures} 个`)
if (failures > 0) {
  console.error('❌ 端到端测试未通过')
  process.exit(1)
}
console.log('🎉 端到端测试全部通过（真实客户端 + 真实中继 + 真实内核）')
