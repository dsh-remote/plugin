/**
 * live-e2e — 三个真实的端到端验收（本地全链路的最后一关，人工触发）。
 *
 *   node e2e/live-e2e.mjs                     完整闭环（含发一条指令）
 *   node e2e/live-e2e.mjs --rounds 3          连跑 3 轮查稳定性（每轮独立取一张新码）
 *   node e2e/live-e2e.mjs --no-prompt         只验配对/列表/防休眠
 *   node e2e/live-e2e.mjs --session <id>      指定会话（可验归档自动恢复）
 *   node e2e/live-e2e.mjs --pair <码> --qr '<dshr:/p?...>'   手动给码
 *   node e2e/live-e2e.mjs --unpair            跑完**真的解配这台设备**（默认不做，见下）
 *
 * ⚠️ `--unpair` 会作废**用户自己手机上**那条配对（README 规定同时只许配一台手机：
 * 解配之后用户的手机就掉线了，且不会有任何提示）。所以默认**不解配**，只有显式
 * 加了 `--unpair` 才做；跑之前请确认那台手机此刻不需要连着。
 *
 * "三个真实"是本仓库最高一档验收（取证 docs/legacy-spec/testing-and-tooling.md §2）：
 *   ① 真实的小程序客户端代码 —— `dsh-remote-mp/miniprogram/core/client.js` 本体经 wx shim 在 Node 里跑，
 *      绝不写"测试专用客户端"；
 *   ② 真实中继 —— 默认打线上 `wss://drc.provid.cc`（nginx TLS + 限流都在路上）；
 *   ③ 真实内核载体 —— 本机 Harness 里跑着的插件，`carrier=services`。
 *
 * 三条不可让步的纪律：
 * - **拿不到真实配对码就直接失败，绝不退化成 mock**（旧 `verify-deployment` 的自建主机模式
 *   会假通过，正是它掩盖过一次真故障）；
 * - **不许空判定**：所有"收到了 X"都带数量下界，回执一律按**本回合发出的 cmdId** 对账
 *   （全局计数会被配对那一刻的回执喂饱，等于没判）；零知识那条走 `run.mjs` 的
 *   `auditZeroKnowledge`（UTF-8 字节级比对 + 明文反证）——本文件原来那句
 *   `latin1.includes(PROMPT)` 是**空判定**：latin1 只产 U+00–FF，中文永远匹配不上；
 * - **不许用重试洗绿**：只有"一次性码被上一轮消费掉"这一类已知竞态才重试。
 * - **不许动用户自己的配对**：解配要显式 `--unpair`。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { installWxShim, loadMpModules, traceOf, until, createRecorder } from './mp-sim.mjs'
import { CMD_LITERALS, PROMPT_KEYWORDS, auditZeroKnowledge } from './run.mjs'

const RELAY_URL = process.env.DRC_LIVE_RELAY ?? 'wss://drc.provid.cc'
const STATUS_FILE = path.join(os.homedir(), '.dsh', 'dsh-remote-control', 'status.json')
/** 刻意选一条**不会调用任何工具**的极短回复：真实回合仍要跑完，但把 token 与副作用压到最低。 */
const PROMPT = process.argv.includes('--prompt') ? String(process.argv[process.argv.indexOf('--prompt') + 1]) : '只回复 ok 两个字，不要调用任何工具'

const args = process.argv.slice(2)
const getFlag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const ROUNDS = Number(getFlag('--rounds') ?? 1)
const NO_PROMPT = args.includes('--no-prompt')
const TARGET_SESSION = getFlag('--session')
const MANUAL_TOKEN = getFlag('--pair')
const MANUAL_QR = getFlag('--qr')
/**
 * 默认**不解配**：`client.unpair()` 作废的是**用户自己手机上**那条配对
 * （README 规定同时只允许配一台手机 → 跑一次就把用户踢下线，而且不给任何提示）。
 * 只有显式 `--unpair` 才做——那是"我就是要清掉这台设备"的场合。
 */
const SHOULD_UNPAIR = args.includes('--unpair')

const usedTokens = new Set()
let failures = 0
const checks = []

function check(name, ok, detail = '') {
  checks.push({ name, ok })
  if (ok) console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
  return ok
}

function readStatus() {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, 'utf8'))
  } catch (error) {
    throw new Error(`读不到 ${STATUS_FILE}：${error.message}（插件是否在跑？carrier 是什么？）`)
  }
}

/**
 * 取一张**真实可用**的一次性配对码。
 *
 * 判据一条条列出来，是为了红了以后能说清"为什么没有码"——
 * `status.json` 是按定时器刷新的，不按消费刷新，所以"还没过期"完全可能意味着"已经被上一轮用掉了"。
 */
async function acquirePairing() {
  if (MANUAL_TOKEN && MANUAL_QR) return { token: MANUAL_TOKEN, qr: MANUAL_QR, source: 'manual' }
  const deadline = Date.now() + 150_000
  let lastReason = '没试过'
  while (Date.now() < deadline) {
    let status
    try {
      status = readStatus()
    } catch (error) {
      lastReason = error.message
      await sleep(1500)
      continue
    }
    if (status.relay !== 'online') {
      lastReason = `relay=${status.relay}${status.relayProblem ? ` (${status.relayProblem})` : ''}`
    } else if (status.carrier !== 'services') {
      lastReason = `carrier=${status.carrier}，不是真内核（本测试不接受 mock 主机）`
    } else if (!status.pairing?.qr) {
      lastReason =
        'status.json 里没有 pairing.qr：配对唯一入口是状态栏那颗 pill——点它发码，或临时把 pairOnStartSec 打开，再用 --pair/--qr 喂进来'
    } else if (usedTokens.has(String(status.pairing.token))) {
      lastReason = `码 ${status.pairing.token} 本轮已用过`
    } else if ((status.pairing.ageSec ?? 999) > 25) {
      lastReason = `码已发布 ${status.pairing.ageSec}s，很可能已被消费`
    } else {
      const left = Date.parse(status.pairing.expiresAt ?? '') - Date.now()
      if (left < 60_000) lastReason = `剩余 ${Math.round(left / 1000)}s，不足以跑完一轮`
      else {
        usedTokens.add(String(status.pairing.token))
        return { token: String(status.pairing.token), qr: status.pairing.qr, source: 'status.json' }
      }
    }
    await sleep(1500)
  }
  throw new Error(`拿不到真实配对码（原因：${lastReason}）。本测试**不会**改用 mock 主机通过。`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function healthz() {
  const httpUrl = RELAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const response = await fetch(`${httpUrl.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(8000) })
  return response.json()
}

async function runRound(round) {
  console.log(`\n── 第 ${round} 轮 ─────────────────────────────`)
  const health = await healthz().catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
  if (!check('① 中继可达且 ok', health.ok === true, `hosts=${health.hosts} clients=${health.clients}`)) return

  const pairing = await acquirePairing().catch((error) => {
    console.log(`  ⛔ ${error.message}`)
    return null
  })
  if (!pairing) {
    failures += 1
    return
  }
  const beforeStatus = readStatus()
  check('② 真实主机发布了配对码', beforeStatus.carrier === 'services' && beforeStatus.relay === 'online', `carrier=${beforeStatus.carrier} token=${pairing.token} 来源=${pairing.source}`)

  const recorder = createRecorder()
  installWxShim({ recorder })
  const { codec, client: clientModule } = loadMpModules()
  const parsed = codec.parsePairingQr(pairing.qr)
  if (!check('③ 小程序解析出中继地址与 PSK', !!parsed && !!parsed.psk, `server=${parsed?.server} host=${parsed?.hostLabel}`)) return
  check('③b 二维码内嵌的地址就是要连的中继', parsed.server === RELAY_URL, `解析到 ${parsed.server}`)

  const client = new clientModule.DrcClient().hydrate()
  const trail = traceOf(client)
  const seen = { sessionChanged: 0, deltas: 0, done: 0, assistantDone: 0, idleAfterPrompt: 0, tools: 0, approvals: 0, questions: 0, keepAwake: 0, runStates: 0, results: 0 }
  /**
   * **本回合发出的每一条命令的 cmdId**，以及**收到回执的那些 cmdId**。
   *
   * 为什么不能只看 `seen.results >= 2`：那是全局计数，配对成功本身就会触发一条
   * `cmd.list_sessions` 并拿到回执——两条命令的回执一到，这个下界就满足了，
   * 哪怕我们发出去的 `cmd.send_prompt` / `cmd.keep_awake` 一条回执都没收到。
   * 判据要按 cmdId 逐条对（`ev.result.cmdId` 是主机原样回传的，见 runtime.ts:249-250）。
   *
   * 抓法：包住 `client.newCmdId()`（唯一分配点，core/client.js:243-246），只观察不改行为。
   */
  const issuedCmdIds = new Set()
  const resultCmdIds = new Set()
  const originalNewCmdId = client.newCmdId
  client.newCmdId = function (...args) {
    const cmdId = originalNewCmdId.apply(this, args)
    issuedCmdIds.add(cmdId)
    return cmdId
  }
  /**
   * **按 role 累加正文**。这条是补上去的：只看帧数会被"一帧空文本 + done"完全骗过去，
   * 而真机上就发生过一次（`assistant/message` 的正文在 `data.message.content`，
   * 插件只读了顶层 → 手机上一个字都没有，⑧⑨ 两条断言照样绿）。
   */
  const text = { assistant: '', user: '', system: '' }
  const answers = []
  /** 发出指令后置真、回合结束后置假：只有这段时间里的 idle 才算这一轮跑完了。 */
  let turnOpen = false
  client.on((event) => {
    const payload = event?.payload
    if (!payload) return
    if (payload.t === 'ev.session_changed') seen.sessionChanged += 1
    if (payload.t === 'ev.message_delta') {
      seen.deltas += 1
      seen.done += payload.done === true ? 1 : 0
      const role = payload.role === 'user' || payload.role === 'system' ? payload.role : 'assistant'
      text[role] += typeof payload.delta === 'string' ? payload.delta : ''
      // **助手的**收尾帧才是"这一轮跑完了"的判据：手机自己发出去的话会以 role=user
      // 原样回声回来、而且同样带 done:true，拿它当判据会在模型还没开始想的时候就走完。
      if (payload.done === true && role !== 'user') seen.assistantDone += 1
    }
    if (payload.t === 'ev.tool_event') seen.tools += 1
    if (payload.t === 'ev.run_state') {
      seen.runStates += 1
      // **回合结束的判据**：发完指令之后第一条 idle。
      // 助手的 done 帧不够格：一条只含 tool-call 的 `assistant/message` 同样是
      // "done 且 role≠user"，用它当判据会在模型还在调工具的时候就去解配（真机取证踩过）。
      if (turnOpen && payload.state === 'idle') seen.idleAfterPrompt += 1
    }
    if (payload.t === 'ev.result') {
      seen.results += 1
      if (typeof payload.cmdId === 'string') resultCmdIds.add(payload.cmdId)
    }
    if (payload.t === 'ev.keep_awake_state') seen.keepAwake += 1
    if (payload.t === 'ev.permission_request') {
      seen.approvals += 1
      answers.push(client.resolvePermission(payload.sessionId, payload.requestId, payload.options?.[0]?.id ?? 'approve'))
    }
    if (payload.t === 'ev.question_request') {
      seen.questions += 1
      answers.push(
        client.answer(
          payload.sessionId,
          payload.requestId,
          (payload.questions ?? []).map((question) => ({
            questionId: question.id,
            selected: [(question.options ?? [])[0]?.id].filter(Boolean),
          })),
        ),
      )
    }
  })

  client.connect({ server: parsed.server, psk: parsed.psk, token: pairing.token || undefined })
  const paired = await until(() => (client.status === 'online' ? client : null), { trail, label: '配对进入 online', timeoutMs: 30_000 }).catch(() => null)
  if (!check('④ 配对成功进入 online', !!paired, `status=${client.status} ${client.statusText}`)) {
    client.disconnect()
    return
  }

  await until(() => (seen.sessionChanged > 0 ? true : null), { trail, label: '收到 ev.session_changed', timeoutMs: 15_000 }).catch(() => null)
  const sessions = client.sessions ?? []
  check('⑤ 收到非空真实会话列表', sessions.length > 0, `${sessions.length} 条`)
  const mocked = sessions.filter((session) => String(session.id).startsWith('ses_mock'))
  check('⑤b 列表里没有 mock 会话', mocked.length === 0, mocked.map((session) => session.id).join(','))
  for (const session of sessions.slice(0, 3)) console.log(`     · ${session.id} state=${session.state} title=${session.title ?? ''}`)
  check('⑤c updatedAt 只能是 ISO 字符串或缺省（给数字会让手机静默不更新）', sessions.every((session) => session.updatedAt === undefined || (typeof session.updatedAt === 'string' && !Number.isNaN(Date.parse(session.updatedAt)))))

  client.setKeepAwake(true, 600)
  await until(() => (seen.keepAwake > 0 ? true : null), { trail, label: '防休眠状态回传', timeoutMs: 12_000 }).catch(() => null)
  const keep = client.keepAwake
  check('⑥ 防休眠开关回传', !!keep && typeof keep.enabled === 'boolean', keep ? `enabled=${keep.enabled} active=${keep.active} backend=${keep.backend} platform=${keep.platform}` : '没回传')

  if (!NO_PROMPT) {
    const target = (TARGET_SESSION && sessions.find((session) => session.id === TARGET_SESSION)) || sessions.find((session) => session.state === 'idle') || sessions[0]
    if (!target) {
      check('⑦ 有可用会话来跑回合', false, '列表里没有可发的会话')
    } else {
      if (target.state === 'archived') console.log(`     （目标是归档会话 ${target.id}：主机应自动恢复后再执行）`)
      turnOpen = true
      client.sendPrompt(target.id, PROMPT)
      // 判据是**发完指令之后的第一条 idle**。助手的 done 帧不够格：一条只含 tool-call 的
      // `assistant/message` 同样是"done 且 role≠user"，拿它当"跑完了"会在模型还在调工具时
      // 就解配走人——真机取证被这个假绿骗过一整轮（手机只收到 1 帧用户回声，
      // 正文与工具行其实几秒之后才到）。
      const streamed = await until(() => (seen.idleAfterPrompt > 0 ? true : null), { trail, label: '回合结束（发指令后的第一条 idle）', timeoutMs: 180_000 }).catch(() => null)
      turnOpen = false
      check('⑧ 回合真的跑完了（发指令后收到 idle）', !!streamed, `idleAfterPrompt=${seen.idleAfterPrompt} delta 帧=${seen.deltas} 工具事件=${seen.tools} 审批=${seen.approvals}`)
      const finished = await until(() => (seen.done > 0 ? true : null), { trail, label: '收到 done 帧', timeoutMs: 20_000 }).catch(() => null)
      check('⑨ 回合正常收尾（有 done:true，手机才会停止转圈）', !!finished, `done=${seen.done} 工具事件=${seen.tools} 审批=${seen.approvals} 提问=${seen.questions}`)
      // 判据必须落在**内容**上：一帧空文本 + done 同样满足"帧数 > 0 且 done > 0"。
      check(
        '⑧b 助手正文非空（数帧不数字会被空回复完全骗过去）',
        text.assistant.trim().length > 0,
        `${text.assistant.length} 字：${text.assistant.slice(0, 48).replace(/\n/g, ' ')}…`,
      )
      check('⑧c 这一轮不是以内核报错收尾', !text.system.includes('这一轮没有产出回复'), text.system.slice(0, 140))
    }
  }

  // 数下行帧之前必须先等到"这一轮的命令回执到齐"。手机配对后会立刻发两条命令
  // （`cmd.list_sessions` 由 `_onPaired` 触发、`cmd.keep_awake` 由本脚本触发），
  // 主机对每条回一张 `ev.result`，而**回执是最后到的帧**（主机先推列表、再回执）。
  // 不等就开始数，等于把"还没到"记成"丢了下行"：这条断言在 `--no-prompt` 模式下
  // 曾稳定假红（实测当时只数到配对那一刻的 1 次推送 = 2 帧，而随后还有第 2 次推送
  // 与两张回执共 5 帧在路上）。判据要落在内容上，不是"尽早数一眼"。
  const missingReceipts = () => [...issuedCmdIds].filter((cmdId) => !resultCmdIds.has(cmdId))
  await until(() => (missingReceipts().length === 0 ? true : null), {
    trail,
    label: `本回合发出的每条命令都拿到回执（${issuedCmdIds.size} 条：${missingReceipts().join(',') || '都到了'}）`,
    timeoutMs: 12_000,
  }).catch(() => null)
  // 逐条对账：`ev.result.cmdId` 必须能对上**我们发出去的那个 cmdId**。
  // 老写法是 `seen.results >= 2`——全局计数，配对那一刻的回执就能把它喂饱，
  // 于是"我们这一轮发的命令有没有回执"根本没被判过。
  const stillMissing = missingReceipts()
  check(
    '⑨b 本回合发出的每条命令都拿到回执（按 cmdId 逐条对账，不是全局计数）',
    issuedCmdIds.size > 0 && stillMissing.length === 0,
    issuedCmdIds.size === 0
      ? '一条命令都没发出去——这条判据没有对象可查，本身就是异常'
      : stillMissing.length === 0
        ? `${issuedCmdIds.size} 条命令（${[...issuedCmdIds].join(', ')}）全部有 ev.result`
        : `${stillMissing.length}/${issuedCmdIds.size} 条没回执：${stillMissing.join(', ')}（收到回执的 cmdId：${[...resultCmdIds].join(', ') || '无'}）`,
  )
  const downEnc = recorder.frames.filter((frame) => frame.direction === 'out' && /"t":"enc"/.test(frame.raw))
  // 主机侧 outbound 计数只是**参考**：它数的是 payload（一个合帧可以装多条），
  // 与手机侧数到的密文帧**不是同一个口径**，所以这里不做数值对账，只把它打出来。
  const hostOutbound = (() => {
    try {
      return JSON.stringify(readStatus().outbound ?? {}).slice(0, 160)
    } catch {
      return '读不到（插件不在跑？）'
    }
  })()
  check(
    '⑩c 手机侧收到的下行密文帧数有下界（只看手机侧观察；主机 outbound 是 payload 口径，仅参考）',
    downEnc.length >= (NO_PROMPT ? 4 : 6),
    `手机侧收到 ${downEnc.length} 帧下行密文（下限 ${NO_PROMPT ? 4 : 6}）；主机 outbound=${hostOutbound}；错误事件 ${JSON.stringify(recorder.errors ?? []).slice(0, 120)}`,
  )
  // 零知识审计复用 run.mjs 的 `auditZeroKnowledge`：它对**每一条交给中继的帧**做
  // 「明文 JSON 里不含业务字面量」+「密文解出的字节里不含 business 字面量的 UTF-8 序列」
  // + 「标准 base64、密文长度下界」+「明文反证」四件事。
  // 原来这里手写的那两行是**空判定**：`latin1` 只产 U+00–FF，而 PROMPT 是中文——
  // `latin.includes(PROMPT)` 永不成立，也就永远不会红（它从来没验过任何东西）。
  const sentFrames = recorder.frames.filter((frame) => frame.direction === 'in').map((frame) => frame.raw)
  let zk = null
  let zkError = null
  try {
    zk = auditZeroKnowledge({
      outbound: sentFrames,
      observed: recorder.frames.map((frame) => frame.raw),
      minEnc: 2,
      minCipherBytes: 40,
      // 业务词表：命令名 + 正文关键词 + **指令全文**。
      // 最后那一条正是原来 `latin.includes(PROMPT)` 想做的事——中文走 UTF-8 字节才判得出来。
      forbidden: [...CMD_LITERALS, ...PROMPT_KEYWORDS, PROMPT],
      plaintextSample: { t: 'cmd.send_prompt', cmdId: 'c_live_probe', text: PROMPT },
    })
  } catch (error) {
    zkError = error
  }
  check(
    '⑩ 零知识：交给中继的每一帧都不含业务明文（密文逐帧按 UTF-8 字节比对，反证在明文样本上抓得到）',
    !zkError,
    zkError
      ? String(zkError?.message ?? zkError).slice(0, 240)
      : `上交中继 ${sentFrames.length} 帧（其中 enc ${zk.encFrames} 帧，下界 2），最小密文 ${zk.smallestCipherBytes}B（下界 40B），逐帧查了 ${zk.forbiddenChecked} 个业务词`,
  )
  // `auditZeroKnowledge` 盯的是密文字节；命令名与指令正文出现在**控制帧文本**里
  // 是另一类泄漏（配对帧、hello 帧都是明文 JSON），单列一条。
  const allText = recorder.frames.map((frame) => frame.raw).join('\n')
  const namedLeaks = [...CMD_LITERALS.filter((word) => allText.includes(word)), ...(allText.includes(PROMPT) ? ['指令正文'] : [])]
  check('⑩b 观测帧序列里不许出现命令名或指令正文', namedLeaks.length === 0, namedLeaks.join('; ') || '0 命中')

  if (!SHOULD_UNPAIR) {
    console.log('  ⏭ 跳过⑪（解配）：默认**不解配**——`unpair()` 会作废用户自己手机上那条配对；要清掉这台设备就加 --unpair')
    client.disconnect()
    await sleep(200)
    return
  }
  client.unpair()
  await until(() => (client.status === 'needs-pair' ? true : null), { trail, label: '解配后进入 needs-pair', timeoutMs: 8000 }).catch(() => null)
  check('⑪ 解配后状态正确', client.status === 'needs-pair', client.status)
  client.disconnect()
  await sleep(200)
}

async function main() {
  console.log(`live-e2e → ${RELAY_URL}（真 mp 客户端代码 + 线上中继 + 真内核；rounds=${ROUNDS}）`)
  console.log(
    SHOULD_UNPAIR
      ? '  ⚠️ --unpair 已开：跑完会**真的解配**，用户自己那台手机会掉线（需要重新扫码）'
      : '  解配默认不做（不会动用户手机上那条配对）；要清掉这台设备再加 --unpair',
  )
  for (let round = 1; round <= ROUNDS; round += 1) {
    try {
      await runRound(round)
    } catch (error) {
      failures += 1
      console.log(`  ❌ 第 ${round} 轮异常：${String(error?.stack ?? error)}`)
    }
  }
  const passed = checks.filter((entry) => entry.ok).length
  console.log(`\n合计 ${checks.length} 项检查，通过 ${passed}，失败 ${failures}。`)
  if (failures > 0) {
    console.log('未通过的项：\n' + checks.filter((entry) => !entry.ok).map((entry) => `  - ${entry.name}`).join('\n'))
    process.exit(1)
  }
}

await main()
