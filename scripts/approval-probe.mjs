/**
 * approval-probe — 手机侧的审批卡取证探针（人工触发，配 `scripts/approval-trigger.mjs` 或桌面 UI 用）。
 *
 *   node scripts/approval-probe.mjs                 配对后最多等 240s，等到一张审批卡
 *   node scripts/approval-probe.mjs --wait 60       只等 60s
 *   node scripts/approval-probe.mjs --decision reject   故意点"拒绝"
 *   node scripts/approval-probe.mjs --session <id> --prompt '<会撞沙箱的指令>'
 *        配对之后**由探针自己发这条指令**（桌面 App 的无障碍树在这台机器上只交出菜单栏，
 *        走不了 UI；而手机侧能做的只有 `cmd.send_prompt`，那就用它把审批问出来）。
 *
 * 为什么单独要这么一支：**审批这条链在真机上从来没有一次走通过**，而它走不通的三种原因
 * （宿主没派发 / 我们没收到 / 收到了但手机没渲染）在屏幕上长得一模一样——都是"没弹"。
 * 全链路的 `e2e/run.mjs` 打的是 mock 内核，测不到 cordis 那条 waterfall 的**派发**；
 * `e2e/live-e2e.mjs` 打的是真宿主，但它挑会话、且回合跑完就解配，等不到人手动去点那颗按钮。
 * 这一支只做一件事：**配对着不动，把 `ev.permission_request` 原样打出来并回一个决定**，
 * 于是"主机有没有发"与"手机有没有收"第一次成为两个可以分别读到的事实。
 *
 * 判据三条，都不许让步：
 * - 用**真实的小程序客户端代码**（`core/client.js` 经 wx shim），不写测试专用客户端；
 * - 拿不到真配对码就失败，绝不退化成 mock；
 * - 结束时把主机 `status.json` 的 `kernel.approvalCalls` / `approvalLast` 一起打出来——
 *   这两个字段就是"派发到了我们这一侧"的证据，缺了它就只剩一句"屏幕上没看见"。
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { installWxShim, loadMpModules, traceOf, until, createRecorder } from '../e2e/mp-sim.mjs'

const STATUS_FILE = path.join(os.homedir(), '.dsh', 'dsh-remote-control', 'status.json')
const args = process.argv.slice(2)
const getFlag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const WAIT_MS = Number(getFlag('--wait') ?? 240) * 1000
const DECISION = getFlag('--decision')
const TARGET_SESSION = getFlag('--session')
const PROMPT = getFlag('--prompt')

const readStatus = () => JSON.parse(readFileSync(STATUS_FILE, 'utf8'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
  return ok
}

const status0 = readStatus()
check('主机在跑且是真内核', status0.carrier === 'services' && status0.relay === 'online', `carrier=${status0.carrier} relay=${status0.relay}`)
if (!status0.pairing?.qr) {
  console.log('  ⛔ status.json 里没有 pairing.qr：先 `curl -X POST -H "x-drc-pair: 1" http://127.0.0.1:<port>/plugins/dsh-remote-control/pairing/new`，')
  console.log('     或临时把 profile 的 pairOnStartSec 打开（跑完记得还原）。本探针**不会**改用 mock 主机。')
  process.exit(1)
}

installWxShim({ recorder: createRecorder() })
const { codec, client: clientModule } = loadMpModules()
const parsed = codec.parsePairingQr(status0.pairing.qr)
check('解析出中继地址与 PSK', !!parsed?.psk, `server=${parsed?.server}`)

const client = new clientModule.DrcClient().hydrate()
const trail = traceOf(client)
let request = null
let answered = null
let callsBefore = 0
const seen = { toolEvents: 0, results: 0 }
client.on((event) => {
  const p = event?.payload
  if (!p) return
  if (p.t === 'ev.tool_event') seen.toolEvents += 1
  if (p.t === 'ev.result') seen.results += 1
  if (p.t === 'ev.permission_request' && !request) {
    request = p
    // **不含凭据**：审批卡上只有工具名/理由/选项，没有 PSK，所以整帧打出来是安全的。
    console.log(`  📥 ev.permission_request ${JSON.stringify(p)}`)
    const option = DECISION ? (p.options ?? []).find((o) => o.id === DECISION) : (p.options ?? [])[0]
    answered = client.resolvePermission(p.sessionId, p.requestId, option?.id ?? 'approve')
    console.log(`  📤 cmd.resolve_permission requestId=${p.requestId} decision=${option?.id ?? 'approve'}`)
  }
})

client.connect({ server: parsed.server, psk: parsed.psk, token: status0.pairing.token || undefined })
const paired = await until(() => (client.status === 'online' ? client : null), { trail, label: '配对进入 online', timeoutMs: 30_000 }).catch(() => null)
if (!check('配对成功进入 online', !!paired, `status=${client.status} ${client.statusText}`)) {
  client.disconnect()
  process.exit(1)
}
console.log(`  … 已配对${request ? '，已经收到卡' : '，等审批卡'}（最多 ${Math.round(WAIT_MS / 1000)}s）。`)
if (TARGET_SESSION === 'list' || TARGET_SESSION === 'first') {
  await until(() => ((client.sessions ?? []).length > 0 ? true : null), { trail, label: '收到会话列表', timeoutMs: 15_000 }).catch(() => null)
  for (const s of (client.sessions ?? []).slice(0, 24)) {
    console.log(`     · ${s.id} state=${s.state} title=${String(s.title ?? '').slice(0, 24)}`)
  }
}
if (TARGET_SESSION && PROMPT && TARGET_SESSION !== 'list') {
  const sessionId = TARGET_SESSION === 'first' ? (client.sessions ?? [])[0]?.id : TARGET_SESSION
  if (!check('发指令前拿到了目标会话', !!sessionId, `session=${sessionId}`)) {
    client.disconnect()
    process.exit(1)
  }
  console.log(`  📤 cmd.send_prompt session=${sessionId} text=${PROMPT.slice(0, 40)}…`)
  // 基线：本轮开始之前主机已经收到过几次派发。判据要的是"比基线多"，不是"> 0"——
  // 主机不重启的话，上一轮的计数会一直留在那里。
  callsBefore = Number(readStatus().kernel?.approvalCalls ?? 0)
  client.sendPrompt(sessionId, PROMPT)
}
const got = await until(() => (request ? true : null), { trail, label: '收到 ev.permission_request', timeoutMs: WAIT_MS }).catch(() => null)

if (!check('① 手机真的收到了审批卡', !!got, got ? `action=${request?.action}` : '一张都没收到')) {
  const k = readStatus().kernel ?? {}
  console.log(`     主机侧：approvalFace=${k.approvalFace} approvalCalls=${k.approvalCalls} approvalLast=${k.approvalLast}`)
  console.log('     读法：calls=0 且 face=registered ⇒ 监听器挂上了但**没被派发**（作用域过滤那一类）；')
  console.log('             calls>0 而手机没收到 ⇒ 断在发送或路上；face=not-attached ⇒ 还没有对端，runtime 没 start()。')
} else {
  check('② 卡上有工具名与至少两个选项', !!request.action && (request.options ?? []).length >= 2, `action=${request.action} options=${(request.options ?? []).map((o) => o.id).join(',')}`)
  check('③ 卡上有到期时间（手机上那颗倒计时要用）', typeof request.expiresAt === 'string' && !Number.isNaN(Date.parse(request.expiresAt)), String(request.expiresAt))
  await Promise.resolve(answered).catch(() => {})
  await until(() => (seen.results > 0 ? true : null), { trail, label: '决定得到回执', timeoutMs: 20_000 }).catch(() => null)
  check('④ 决定回传后主机给了回执（cmdId 对答链路活着）', seen.results > 0, `ev.result ${seen.results} 条`)
}

const k = await (async () => {
  // `status.json` 是按定时器刷的，卡片刚到就去读会读到**上一轮**的值——
  // 真机第一次跑就因此报过一句假的 `approvalCalls=0`。所以要轮，而且要对着基线轮。
  const deadline = Date.now() + 15_000
  let last = readStatus().kernel ?? {}
  while (Date.now() < deadline) {
    last = readStatus().kernel ?? {}
    if (Number(last.approvalCalls ?? 0) > callsBefore) break
    await sleep(1000)
  }
  return last
})()
console.log(
  `\n主机侧：approvalFace=${k.approvalFace} approvalCalls=${k.approvalCalls}(基线 ${callsBefore}) ` +
    `approvalLast=${k.approvalLast} asked=${k.approvalAsked} decided=${k.approvalDecided}`,
)
if (got) {
  check(
    '⑤ 主机那一侧的监听器**真的被派发到了**（次数要比本轮基线多）',
    Number(k.approvalCalls ?? 0) > callsBefore,
    `approvalCalls=${k.approvalCalls} last=${k.approvalLast} decided=${k.approvalDecided}`,
  )
} else {
  console.log('  （⑤ 跳过：本轮没收到卡，"派发到了"这条判据不成立，看上面那行主机侧读数）')
}
client.disconnect()
console.log(`\n合计 ${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
