/**
 * approval-probe — 手机侧的审批卡取证探针（人工触发，配 `scripts/approval-trigger.mjs` 或桌面 UI 用）。
 *
 *   node scripts/approval-probe.mjs                 配对后最多等 240s，等到一张审批卡
 *   node scripts/approval-probe.mjs --wait 60       只等 60s
 *   node scripts/approval-probe.mjs --decision reject   故意点"拒绝"
 *   node scripts/approval-probe.mjs --session <id> --prompt '<会撞沙箱的指令>'
 *        配对之后**由探针自己发这条指令**（桌面 App 的无障碍树在这台机器上只交出菜单栏，
 *        走不了 UI；而手机侧能做的只有 `cmd.send_prompt`，那就用它把审批问出来）。
 *   node scripts/approval-probe.mjs --hold 6 [--port 19387]
 *        卡片到达后**先压 6 秒不答**，这期间逐秒读宿主的 `GET /status`，对账
 *        "挂着一条审批时 `waiting` 到底是不是 >=1"——那一行只能在这里验，单测验的是函数。
 *        环回端口每次启动都变，默认从 `lsof` 现查，`--port` 可覆盖。
 *   node scripts/approval-probe.mjs --session new --prompt '请用 ask_user_question 工具问我一个单选问题…'
 *        等到的是**提问卡**时也走这一支：两条 waterfall（审批与提问）各有一套 status.json 读数，
 *        探针按这一轮实际等到了哪张卡去选字段名。为什么值得留这条路：这台宿主的旧会话里
 *        执行/写文件工具全都不可用（造不出审批），而 `ask_user_question` 不依赖它们。
 *   node scripts/approval-probe.mjs --no-answer [--void-wait 220]
 *        卡片到达后**不点**，让主机自己收场（审批超时默认 180s），要求手机上收到那一帧
 *        `ev.run_state` —— 判据 ⑦，"别的端先收场 → 手机上那张卡当场作废"这一半
 *        唯一能自动取证的路子（另一条要人在屏幕上点桌面那颗按钮，脚本够不着）。
 *
 * 默认那条（点卡）跑完还会核**判据 ⑥**：手机先答之后，主机有没有把交给桌面那半的
 * `request.signal` 撤销掉。撤销之后宿主的网关会向每个渲染端推 cancel，桌面那张卡由宿主
 * 自己收掉；这台机器上渲染端读不到（AX 树只有菜单栏），所以这一跳只能靠那两个字段自证。
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
import { execFileSync } from 'node:child_process'
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
/** 卡片到达后先压住不答的秒数（这期间去读 /status，对账"等 N 件事"）。 */
const HOLD_SEC = Number(getFlag('--hold') ?? 0)
/** 手机答之前主机已经撤销过几次下游 signal（判据 ⑥ 的基线）。 */
let voidedBefore = 0
/** 手机答之前 `request.signal` 有没有换成可撤销的那一份（判据 ⑥ 的另一半）。 */
let handoffAtAnswer = '?'
/** 桌面宿主那个环回端口。每次启动都会变，所以默认从 lsof 现查，`--port` 可以覆盖。 */
const PILL_PORT =
  getFlag('--port') ??
  (() => {
    try {
      const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
      return /127\.0\.0\.1:(\d+)/.exec(out.split('\n').find((line) => /DeepSeek/.test(line)) ?? '')?.[1] ?? ''
    } catch {
      return ''
    }
  })()

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
/** 提问卡（`ev.question_request`）：这台宿主的旧会话里没有执行/写文件工具，**提问是还能自动造出来的那一种**。 */
let qrequest = null
let answered = null
let callsBefore = 0
/** 提问那一面的基线（这一轮等到的是哪张卡，事先不知道，所以两套都记）。 */
let qCallsBefore = 0
/** 卡片**之后**收到的 `ev.run_state`：手机上那张卡的作废帧就在这一列里（判据 ⑦）。 */
const seen = { toolEvents: 0, results: 0, voidBeats: [], resolvedFrames: [] }
/** `--interrupt-after`：卡片到达后 N 秒发 `cmd.interrupt`，用来验"主机收场 → 手机卡片作废"那一半（判据 ⑧）。 */
const INTERRUPT_AFTER = Number(getFlag('--interrupt-after') ?? 0)
const NO_ANSWER = args.includes('--no-answer') || INTERRUPT_AFTER > 0
/** `--no-answer` 时等主机自己收场的最长秒数（默认审批超时是 180s）。 */
const VOID_WAIT = Number(getFlag('--void-wait') ?? 220) * 1000
client.on((event) => {
  const p = event?.payload
  if (!p) return
  if (p.t === 'ev.tool_event') seen.toolEvents += 1
  if (p.t === 'ev.result') seen.results += 1
  if (p.t === 'ev.run_state' && (request || qrequest)) seen.voidBeats.push(p)
  // 精确帧只有主机那一段代码会发（内核不会），所以它是"别的端收场 → 这张卡作废"唯一的无歧义证据。
  if ((p.t === 'ev.permission_resolved' || p.t === 'ev.question_resolved') && (request || qrequest)) {
    seen.resolvedFrames.push(p)
  }
  if (p.t === 'ev.question_request' && !qrequest) {
    qrequest = p
    // 同样不含凭据：卡上只有题目与选项文案。
    console.log(`  📥 ev.question_request ${JSON.stringify(p)}`)
  }
  if (p.t === 'ev.permission_request' && !request) {
    request = p
    // **不含凭据**：审批卡上只有工具名/理由/选项，没有 PSK，所以整帧打出来是安全的。
    console.log(`  📥 ev.permission_request ${JSON.stringify(p)}`)
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
  let sessionId = TARGET_SESSION === 'first' ? (client.sessions ?? [])[0]?.id : TARGET_SESSION
  if (TARGET_SESSION === 'new') {
    // 为什么要自己建一条：**旧的 API 建的会话里根本没有执行/写文件工具**
    // （模型回报 `unknown tool "run_code"`，于是永远走不到审批），
    // 而用户自己那些正在干活的会话不能拿来当实验台。新建的那条走当前的工具面。
    const created = await client.newSession()
    sessionId = created?.ok ? created.sessionId : undefined
    console.log(`  🆕 cmd.new_session → ${sessionId ?? `失败：${created?.message}`}`)
  }
  if (!check('发指令前拿到了目标会话', !!sessionId, `session=${sessionId}`)) {
    client.disconnect()
    process.exit(1)
  }
  console.log(`  📤 cmd.send_prompt session=${sessionId} text=${PROMPT.slice(0, 40)}…`)
  // 基线：本轮开始之前主机已经收到过几次派发。判据要的是"比基线多"，不是"> 0"——
  // 主机不重启的话，上一轮的计数会一直留在那里。
  callsBefore = Number(readStatus().kernel?.approvalCalls ?? 0)
  qCallsBefore = Number(readStatus().kernel?.questionsCalls ?? 0)
  client.sendPrompt(sessionId, PROMPT)
}
const got = await until(() => (request || qrequest ? true : null), {
  trail,
  label: '收到审批卡或提问卡',
  timeoutMs: WAIT_MS,
}).catch(() => null)
/** 这一轮到底等到了哪一张：两条链的判据不一样，读法也不一样。 */
const kind = request ? 'permission' : qrequest ? 'question' : 'none'
if (kind === 'question') console.log('  🃏 等到的是**提问卡**（走的是 user-questions/request 那条 waterfall，2026-10-04 才接上）')

if (got) {
  // `--hold` 存在的理由：卡片**挂着没答**的那段时间里，桌面那颗 pill 应该报"等 N 件事"。
  // 那一行的判据只能在这里对账——单测验的是函数，这条验的是"主机真的把它算进 /status 了"。
  const option = DECISION ? (request?.options ?? []).find((o) => o.id === DECISION) : (request?.options ?? [])[0]
  // 提问卡的"答"是把每道题的第一个选项勾上（协议里 `cmd.answer` 收的是 `{questionId, selected:[id]}`）。
  const qanswers = qrequest
    ? (qrequest.questions ?? []).map((q) => ({
        questionId: q.id,
        selected: [(q.options ?? [])[0]?.id ?? ''],
      }))
    : []
  if (HOLD_SEC > 0) {
    console.log(`  ⏸ 卡片先压 ${HOLD_SEC}s，这期间去 curl /status 看 waiting：`)
    for (let i = 0; i < HOLD_SEC; i++) {
      await sleep(1000)
      try {
        const s = await (await fetch(`http://127.0.0.1:${PILL_PORT}/plugins/dsh-remote-control/status`)).json()
        console.log(`     +${i + 1}s waiting=${s.waiting} oldest=${s.waitingOldestSec}s label 该说「等 ${s.waiting} 件事」`)
      } catch (error) {
        console.log(`     读 /status 失败：${String(error?.message ?? error)}`)
      }
    }
  }
  if (NO_ANSWER) {
    console.log(
      INTERRUPT_AFTER > 0
        ? `  ✋ 这一张不点：压 ${INTERRUPT_AFTER}s 之后中断这一回合（见判据 ⑧）`
        : '  ✋ --no-answer：这一张不点（等主机自己收场，见判据 ⑦）',
    )
  } else if (kind === 'question') {
    answered = client.answer(qrequest.sessionId, qrequest.requestId, qanswers)
    // 同一条判据，只是读的是**提问那一面**的字段（两条 waterfall 各有一套读数，
    // 混着看会把"审批没弹"错读成"提问没弹"）。
    voidedBefore = Number(readStatus().kernel?.questionsDesktopVoided ?? 0)
    handoffAtAnswer = String(readStatus().kernel?.questionsSignalHandoff ?? '?')
    console.log(`  📤 cmd.answer requestId=${qrequest.requestId} answers=${JSON.stringify(qanswers)}`)
  } else {
    answered = client.resolvePermission(request.sessionId, request.requestId, option?.id ?? 'approve')
    // 「桌面那张卡有没有被关掉」这件事在这台机器上没有第二双眼睛能自证
    // （宿主渲染端的 AX 树只交出菜单栏），所以把它压成主机侧那两个字段：
    // 换成功 = fused，手机先答之后计数的**这一次**才加。先取基线。
    voidedBefore = Number(readStatus().kernel?.approvalDesktopVoided ?? 0)
    handoffAtAnswer = String(readStatus().kernel?.approvalSignalHandoff ?? '?')
    console.log(`  📤 cmd.resolve_permission requestId=${request.requestId} decision=${option?.id ?? 'approve'}`)
  }
}

/**
 * `--no-answer`：这张卡**不点**，让主机自己收场（审批超时默认 180s），
 * 然后要求手机上收到那一帧 `ev.run_state`——它就是小程序认的"卡片作废"信号。
 * 这是"别的端先收场 → 手机上那张卡当场消失"这半边唯一能自动取证的路子
 * （另一条要人在屏幕上点桌面那颗按钮，脚本够不着）。
 */
if (got && NO_ANSWER && INTERRUPT_AFTER === 0) {
  console.log(`  ⏳ --no-answer：不点这张卡，最多等 ${Math.round(VOID_WAIT / 1000)}s 让主机自己收场…`)
  // 等的是**精确帧**而不是 `ev.run_state`：后者在这一会话里可能是内核自己的状态跳变
  // （回合刚开始那条也是 running），拿它当证据会把"宿主动的"错记成"我们补的"。
  const beat = await until(
    () =>
      seen.resolvedFrames.find((x) => x.requestId === (request ?? qrequest).requestId) ??
      seen.voidBeats.find((x) => !x.sessionId || x.sessionId === (request ?? qrequest).sessionId) ??
      null,
    { trail, label: '收到卡片作废帧', timeoutMs: VOID_WAIT },
  ).catch(() => null)
  let waitingAfter = null
  for (let i = 0; i < 20 && !waitingAfter; i++) {
    try {
      const s = await (await fetch(`http://127.0.0.1:${PILL_PORT}/plugins/dsh-remote-control/status`)).json()
      if (Number(s.waiting ?? 0) === 0) waitingAfter = s
    } catch {
      /* 还没刷到 */
    }
    if (!waitingAfter) await sleep(1000)
  }
  check(
    '⑦ 主机自己收场（这条是等到超时）之后，手机上那张卡收到作废帧',
    !!beat && !!waitingAfter,
    beat
      ? `frame=${JSON.stringify(beat)} waiting=${waitingAfter ? String(waitingAfter.waiting) : '还没归零'}`
      : `一张作废帧都没收到（精确帧 ${seen.resolvedFrames.length} 条、run_state ${seen.voidBeats.length} 条）`,
  )
  if (!beat) {
    console.log('     读法：没有这一帧，手机上那张卡会一直亮到它自己的倒计时走完，')
    console.log('             而主机那边 `pending` 早就作废了——点下去是空操作。')
  }
}

/**
 * 两条 waterfall 各有一套读数，所以字段名要按**这一轮等到的是哪张卡**来选。
 * 混着看的代价是真机上有过：把"提问没弹"错读成"审批没弹"，然后去查一条好着的通道。
 */
const K = kind === 'question'
  ? { face: 'questionsFace', calls: 'questionsCalls', last: 'questionsLast', voided: 'questionsDesktopVoided', handoff: 'questionsSignalHandoff', label: '提问' }
  : { face: 'approvalFace', calls: 'approvalCalls', last: 'approvalLast', voided: 'approvalDesktopVoided', handoff: 'approvalSignalHandoff', label: '审批' }
const card = request ?? qrequest ?? {}

/**
 * 判据 ⑧：`--interrupt-after` —— 这张卡**不点**，改成把这一回合中断掉，
 * 然后要求手机上收到那条**按 requestId 的**作废帧。
 * 为什么这条比 `--no-answer` 有用：等超时要 180/300 秒，而中断是立刻的；
 * 且 `ev.permission_resolved` / `ev.question_resolved` 只有主机那段代码会发，
 * 不像 `ev.run_state` 那样与内核真实的状态跳变混在一起、分不出是谁发的。
 */
if (got && INTERRUPT_AFTER > 0) {
  console.log(`  ⏸ 卡片压 ${INTERRUPT_AFTER}s 不点，然后 cmd.interrupt 中断这一回合…`)
  await sleep(INTERRUPT_AFTER * 1000)
  client.interrupt((request ?? qrequest).sessionId)
  const resolved = await until(() => seen.resolvedFrames[0] ?? null, {
    trail,
    label: '收到按 requestId 的作废帧',
    timeoutMs: 30_000,
  }).catch(() => null)
  check(
    `⑧ 主机收场（这里是中断）之后，手机上那张${K.label}卡收到精确作废帧`,
    !!resolved && resolved.requestId === (request ?? qrequest).requestId,
    resolved ? `frame=${JSON.stringify(resolved)}` : `三十秒内一张精确帧都没收到（共 ${seen.resolvedFrames.length} 条）`,
  )
  check(
    '⑧b 同一时刻还补了一帧 ev.run_state（手机上装的老版本只认它）',
    seen.voidBeats.length > 0,
    `run_state ${seen.voidBeats.length} 条`,
  )
}

if (!check(`① 手机真的收到了${K.label}卡`, !!got, got ? `${K.label === '审批' ? 'action' : 'question'}=${card.action ?? card.questions?.[0]?.question}` : '一张都没收到')) {
  const k = readStatus().kernel ?? {}
  console.log(`     主机侧：${K.face}=${k[K.face]} ${K.calls}=${k[K.calls]} ${K.last}=${k[K.last]}`)
  console.log('     读法：calls=0 且 face=registered ⇒ 监听器挂上了但**没被派发**（作用域过滤那一类）；')
  console.log('             calls>0 而手机没收到 ⇒ 断在发送或路上；face=not-attached ⇒ 还没有对端，runtime 没 start()。')
} else {
  if (kind === 'question') {
    check('② 提问卡上有题目与可选项', (card.questions ?? []).length >= 1 && (card.questions ?? []).every((q) => (q.options ?? []).length >= 1), `questions=${(card.questions ?? []).length} 道`)
  } else {
    check('② 卡上有工具名与至少两个选项', !!card.action && (card.options ?? []).length >= 2, `action=${card.action} options=${(card.options ?? []).map((o) => o.id).join(',')}`)
  }
  check(`③ 卡上有到期时间（${K.label}卡上那颗倒计时要用）`, typeof card.expiresAt === 'string' && !Number.isNaN(Date.parse(card.expiresAt)), String(card.expiresAt))
  if (!NO_ANSWER) {
    await Promise.resolve(answered).catch(() => {})
    await until(() => (seen.results > 0 ? true : null), { trail, label: '决定得到回执', timeoutMs: 20_000 }).catch(() => null)
    check('④ 决定回传后主机给了回执（cmdId 对答链路活着）', seen.results > 0, `ev.result ${seen.results} 条`)
  } else {
    console.log('  （④ 跳过：--no-answer 这条不点卡，没有回传也就没有回执）')
  }
}

const baselineCalls = kind === 'question' ? qCallsBefore : callsBefore
const k = await (async () => {
  // `status.json` 是按定时器刷的，卡片刚到就去读会读到**上一轮**的值——
  // 真机第一次跑就因此报过一句假的 `approvalCalls=0`。所以要轮，而且要对着基线轮。
  const deadline = Date.now() + 15_000
  let last = readStatus().kernel ?? {}
  while (Date.now() < deadline) {
    last = readStatus().kernel ?? {}
    if (Number(last[K.calls] ?? 0) > baselineCalls) break
    await sleep(1000)
  }
  return last
})()
console.log(
  `\n主机侧：${K.face}=${k[K.face]} ${K.calls}=${k[K.calls]}(基线 ${baselineCalls}) ` +
    `${K.last}=${k[K.last]} handoff=${k[K.handoff]} desktopVoided=${k[K.voided]}(基线 ${voidedBefore})` +
    (kind === 'question' ? '' : ` asked=${k.approvalAsked} decided=${k.approvalDecided}`),
)
if (got) {
  check(
    `⑤ 主机那一侧的${K.label}监听器**真的被派发到了**（次数要比本轮基线多）`,
    Number(k[K.calls] ?? 0) > baselineCalls,
    `${K.calls}=${k[K.calls]} last=${k[K.last]}`,
  )
} else {
  console.log('  （⑤ 跳过：本轮没收到卡，"派发到了"这条判据不成立，看上面那行主机侧读数）')
}

/**
 * ⑥ 「手机先答之后，桌面那张卡的关闭句柄有没有被按下去」。
 *
 * 这一条为什么只能在这里验：宿主是打包过的 Electron，这台机器上它的**渲染端读不到**
 * （无障碍树只交出菜单栏，capture policy 是 AX_ONLY 所以坐标点击直接报错）。
 * 而撤销之后的三步（网关推 `{type:'cancel', eventId}` → 渲染端 abort 那条 delivery signal
 * → `PendingApproval.abort()`）全是宿主自己的代码，我们能自证的只有**第一跳**：
 * 交给下游的那份 `request.signal` 是不是我们换上去的那一条，以及手机答完之后它断没断。
 */
if (got && !NO_ANSWER) {
  let k6 = readStatus().kernel ?? {}
  const deadline6 = Date.now() + 15_000
  while (Date.now() < deadline6) {
    k6 = readStatus().kernel ?? {}
    if (Number(k6.approvalDesktopVoided ?? 0) > voidedBefore) break
    await sleep(1000)
  }
  check(
    `⑥ 手机先答之后，交给桌面的那份 signal 被撤销了（桌面那张${K.label}卡的关闭句柄）`,
    String(k6[K.handoff]) === 'fused' && Number(k6[K.voided] ?? 0) > voidedBefore,
    `handoff=${k6[K.handoff]}(答之前 ${handoffAtAnswer}) desktopVoided=${k6[K.voided]}(基线 ${voidedBefore})`,
  )
  console.log('     读法：这一条过了 ⇒ 网关已经按断掉的 signal 向每个渲染端推 cancel，')
  console.log('             **屏幕上那张审批卡应当当场消失**——还挂着就是断在渲染端，不是我们这侧；')
  console.log('           handoff=failed|ignored ⇒ 请求对象的 signal 换不出去（宿主把它冻住了），')
  console.log('             桌面那张卡只能等它自己那次工具调用的生命周期结束。')
}
client.disconnect()
console.log(`\n合计 ${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
