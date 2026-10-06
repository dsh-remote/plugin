/**
 * mp-client.test — **真实 `dsh-remote-mp/miniprogram/core/client.js`** 驱动的本地闭环。
 *
 * 三个真实（对照 docs/legacy-spec/testing-and-tooling.md §2）：
 * - 中继是真的（`dsh-remote-server/dist/src/main.js` 真进程）
 * - 插件运行时是真的（`dsh-remote-control/packages/plugin/dist/src/index.js` 的 `apply(ctx, injected)` 真入口）
 * - 小程序客户端是真的（`e2e/mp-sim.mjs` 把 `dsh-remote-mp/miniprogram/core/*.js` 原文件加载进 Node 驱动）
 *
 * **内核面是 mock**：`mockBridge: true` 走 `platform/mock-kernel.ts`，所以列表里的会话 id
 * 一律是 `ses_mock*`。这些用例证明的是"链路 + 字段契约通"，**不**证明真内核能跑
 * （真内核那一档是 `e2e/live-e2e.mjs`）。标题与断言里都把这句话说在前面。
 *
 * 判据来源：docs/legacy-spec/mp-client-contract.md §1/§2/§3.2/§8，
 * docs/legacy-spec/relay-and-wireformat.md §2/§5.7。
 *
 * 为什么整份文件共用一套装置：真实小程序客户端的 storage 是进程级的（`wx` shim 只装一次），
 * 而且审批流是一条连续异步链——跨用例切断它就会出现"测试红了但其实是被我们掐断的"
 * （取证 mp-client-contract §4.8 的教训），所以审批/提问各自都在**单个 test 内**跑完。
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import {
  MOCK_SESSION_ID,
  PROMPT_KEYWORDS,
  PROMPT_TEXT,
  auditRelayLogs,
  auditZeroKnowledge,
  bootHost,
  controlFrames,
  newPhone,
  outboundToRelay,
  pairPhone,
  renderSessionRow,
  assertListPushed,
  assertSessionShape,
  shutdown,
  startRelay,
  untilAsync,
} from './run.mjs'
import { until } from './mp-sim.mjs'

const SESSION_STATES = ['idle', 'running', 'detached', 'archived', 'awaiting-permission', 'awaiting-answer']

describe('真 dsh-remote-mp/miniprogram/core/client.js × 真中继 × 真插件运行时（内核面 = mock-kernel）', () => {
  const workDir = path.join(os.tmpdir(), `drc-e2e-mpclient-${process.pid}`)
  let relay = null
  let host = null
  let phone = null

  before(async () => {
    mkdirSync(workDir, { recursive: true })
    relay = await startRelay({ env: { DRC_SWEEP_MS: '1000' }, label: '本地中继（mp-client）' })
    host = await bootHost({ relayUrl: relay.url, hostId: 'e2e_mpclient_host', statusDir: workDir, pairTtlMs: 60_000, approvalTimeoutSec: 20 })
    phone = newPhone('mp-client 手机')
    await pairPhone(host, phone, { expectedRelayUrl: relay.url })
  })

  after(async () => {
    const { relayExit } = await shutdown({ phone, host, relay })
    rmSync(workDir, { recursive: true, force: true })
    assert.equal(relayExit.code, 0, `中继必须优雅退出（SIGTERM → exit 0），实际 code=${relayExit.code} signal=${relayExit.signal}`)
  })

  test('1. 握手：hello→hello-ok；pair-begin→pair-ready(正整数 ttlMs)；pair-begin-client→paired + peer-joined(带 pairingToken)', async () => {
    const hello = controlFrames('phone', 'sent', ['hello']).pop()
    assert.ok(hello, '手机没发 hello')
    assert.equal(hello.role, 'client', "hello.role 必须是字面量 'client'（不是 mp/phone）")
    assert.equal(hello.protocol, 1, 'hello.protocol 恒为 1')
    assert.equal(typeof hello.clientId, 'string')
    assert.deepEqual(hello.clientMeta, { platform: 'wechat-mp', label: '微信小程序' }, 'clientMeta 的两个字段名是固定的')
    assert.ok(!('token' in hello), '客户端不许带任何凭据（§1.1「不会发的东西」）')

    const helloOk = controlFrames('phone', 'received', ['hello-ok']).pop()
    assert.ok(helloOk, '中继没在 hello 之后回 hello-ok —— 手机会永远停在"正在连接"')
    assert.equal(typeof helloOk.clientId, 'string', 'hello-ok 要下发权威 clientId（手机会采纳）')

    const claim = controlFrames('phone', 'sent', ['pair-begin-client']).pop()
    assert.ok(claim && /^\d{6}$/.test(claim.pairingToken), `pair-begin-client 必须带 6 位归一后的码，收到 ${JSON.stringify(claim)}`)
    assert.ok(!('psk' in claim), 'PSK 绝不上网（D1）：pair-begin-client 只有 pairingToken')

    const paired = controlFrames('phone', 'received', ['paired']).pop()
    assert.ok(paired, '没收到 paired')
    assert.match(paired.sessionId, /^c_[0-9a-f]{12}$/, `paired.sessionId 必须是 c_+12 位 hex，收到 ${paired.sessionId}`)
    assert.equal(typeof paired.hostId, 'string')
    assert.equal(paired.sessionId, phone.convId, '手机存的 convId 必须就是 paired.sessionId')

    const hostHello = controlFrames('host', 'sent', ['hello']).pop()
    assert.ok(hostHello, '主机侧没发注册帧（hello with role:host）')
    assert.equal(hostHello.role, 'host')
    assert.equal(hostHello.protocol, 1)
    const ready = await until(
      () => controlFrames('host', 'received', ['pair-ready']).find((f) => f.pairingToken === claim.pairingToken) ?? null,
      { timeoutMs: 8000, trail: phone.trail, label: '主机收到这张码的 pair-ready' },
    )
    assert.ok(Number.isInteger(ready.ttlMs) && ready.ttlMs > 0, `pair-ready.ttlMs 必须是正整数（服务端权威），收到 ${JSON.stringify(ready.ttlMs)}`)

    const joined = await until(
      () => controlFrames('host', 'received', ['peer-joined']).find((f) => f.sessionId === paired.sessionId) ?? null,
      { timeoutMs: 8000, trail: phone.trail, label: '主机收到这条会话的 peer-joined' },
    )
    assert.match(joined.pairingToken, /^\d{6}$/, '发给主机的 peer-joined 必须带 pairingToken（否则主机没法按所用码取 PSK）')
    assert.equal(joined.pairingToken, claim.pairingToken, 'pairingToken 必须就是手机实际用的那张码')
    const helloOkHost = controlFrames('host', 'received', ['hello-ok']).pop()
    assert.ok(helloOkHost, '中继必须给主机回 hello-ok（generation 的起点）')
    assert.equal(helloOkHost.hostId, host.hostId)
  })

  test('2. cmd.list_sessions 之后：ev.result 与 ev.session_changed 都要有（F8：列表唯一数据源）', async () => {
    const cmdId = phone.client.newCmdId()
    assert.equal(phone.client.sendCmd({ t: 'cmd.list_sessions', cmdId }), true, 'list_sessions 没发出去')
    const result = await phone.waitForPayload('ev.result', 'list_sessions 的回执', { where: (p) => p.cmdId === cmdId, timeoutMs: 10_000 })
    const changed = await phone.waitForPayload('ev.session_changed', '列表快照被额外推过来', {
      where: (p) => Array.isArray(p.sessions) && p.sessions.length > 0,
      timeoutMs: 10_000,
    })
    assertListPushed({ resultPayload: result, sessionChangedPayload: changed, cmdId })
    // 手机**不看** ev.result.data.sessions；它只被 ev.session_changed 写入。
    assert.ok(Array.isArray(result.data?.sessions), '顺带核对：ev.result.data.sessions 也在（但手机不读它）')
    assert.equal(phone.client.sessions, changed.sessions, 'client.sessions 必须就是这条推送里的数组')
    assertSessionShape(changed.sessions)
    assert.ok(changed.sessions.every((s) => s.id.startsWith('ses_mock')), '本用例的内核面是 mock：会话 id 一律 ses_mock*')
  })

  test('3. F7 类型陷阱：updatedAt 只能是 ISO 字符串或不下发；数字时间戳必须被抓到（手机表现＝列表静默不更新）', async () => {
    const sessions = phone.lastPayload('ev.session_changed').sessions
    assert.ok(sessions.length > 0, '先要有真实下发的列表，否则这条断言是空的')
    assertSessionShape(sessions)
    for (const session of sessions) {
      assert.doesNotThrow(() => renderSessionRow(session), '真实下发的每一行都必须能被 sessions.js 的那段表达式渲染')
    }

    // 负控 1：塞一个数字时间戳进去，字段级检查必须红。
    const numeric = [{ ...sessions[0], updatedAt: 1_700_000_000_000 }]
    assert.throws(() => assertSessionShape(numeric), /ISO 字符串/, '数字类型的 updatedAt 必须被字段级检查抓到')
    // 负控 2：页面那行代码真的会抛（`s.updatedAt.slice is not a function`）。
    assert.throws(() => renderSessionRow(numeric[0]), TypeError, 'renderSessionRow 必须复现手机页面的抛错')
    // 负控 3：ISO 字符串才是手机能用的形态（页面用 slice(11,19) 取 HH:MM:SS，UTC）。
    const isoValue = new Date(1_700_000_000_000).toISOString()
    const iso = [{ ...sessions[0], updatedAt: isoValue }]
    assert.equal(renderSessionRow(iso[0]).updatedAt, isoValue.slice(11, 19))
    assert.doesNotThrow(() => assertSessionShape(iso))

    // 为什么手机上的表现是"静默"：抛错被 client.emit() 吞掉，后面的监听器照常跑，
    // 用户看不到任何提示（dsh-remote-mp/miniprogram/core/client.js:53-61）。这条用真实客户端证明"没有出口"。
    const seen = []
    const offThrowing = phone.client.on(() => {
      throw new TypeError('模拟页面渲染抛错：s.updatedAt.slice is not a function')
    })
    const offWatching = phone.client.on((event) => seen.push(event))
    assert.doesNotThrow(
      () => phone.client.emit({ kind: 'payload', payload: { t: 'ev.session_changed', sessions: numeric } }),
      '客户端必须吞掉监听器抛出的异常（这就是"静默不更新"的机制）',
    )
    assert.equal(seen.length, 1, '抛错的监听器之后的监听器照常收到 → 用户侧没有任何错误提示')
    offThrowing()
    offWatching()
  })

  test('4. F3 双 sessionId：帧外层是 c_* 通道 id，载荷里是 DSH 会话 id 且与 sessions[].id 同值', async () => {
    const uplink = phone.sent.filter((s) => s.frame.t === 'enc').pop()
    assert.ok(uplink, '没看到手机发出的 enc 帧')
    assert.match(uplink.frame.sessionId, /^c_/, '帧外层 sessionId 必须是配对通道 id')
    assert.equal(uplink.frame.sessionId, phone.convId)
    assert.equal(uplink.frame.clientId, phone.client.clientId, 'enc 帧的 clientId 必须就是 hello 用的那个')
    assert.equal(typeof uplink.frame.seq, 'number')
    assert.equal(typeof uplink.frame.ciphertext, 'string')

    const deltaBefore = phone.count('ev.message_delta')
    host.kernel().feed({ kind: 'delta', sessionId: MOCK_SESSION_ID, messageId: 'f3_probe', text: 'f3', done: false })
    const delta = await phone.waitForPayload('ev.message_delta', '探针 delta 到达', { after: deltaBefore, where: (p) => p.messageId === 'f3_probe' })
    assert.equal(delta.sessionId, MOCK_SESSION_ID, '载荷里的 sessionId 必须是 DSH 会话 id')
    assert.notEqual(uplink.frame.sessionId, delta.sessionId, '两个 sessionId 必须不同值（混淆是本协议最贵的一类 bug）')
    const changed = phone.lastPayload('ev.session_changed')
    assert.ok(changed.sessions.some((s) => s.id === delta.sessionId), '载荷 sessionId 必须与 sessions[].id 同值')
    const downlink = controlFrames('phone', 'received', ['enc']).pop()
    assert.equal(downlink.sessionId, phone.convId, '下行帧外层 sessionId 必须逐字不变（红线 4）')
  })

  test('5. 审批闭环（单用例内跑完，不断链）：send_prompt → ev.permission_request → 逐字回传 options[].id → 工具行 → delta → done:true', async () => {
    const permissionBefore = phone.count('ev.permission_request')
    const deltaBefore = phone.count('ev.message_delta')
    const resultBefore = phone.count('ev.result')
    const cmdId = phone.client.newCmdId()
    phone.client.sendCmd({ t: 'cmd.send_prompt', cmdId, sessionId: MOCK_SESSION_ID, text: PROMPT_TEXT })

    const request = await phone.waitForPayload('ev.permission_request', '审批卡到达', { after: permissionBefore, timeoutMs: 12_000 })
    assert.equal(request.sessionId, MOCK_SESSION_ID, '审批卡必须带 DSH 会话 id（聊天页按它过滤）')
    assert.equal(typeof request.requestId, 'string')
    assert.ok(request.requestId.length > 0, 'requestId 缺失时卡片能显示但审批无效（主机认不出请求）')
    assert.equal(typeof request.action, 'string')
    assert.ok(Array.isArray(request.options) && request.options.length >= 2, `options 必须是 [{id,label}]，收到 ${JSON.stringify(request.options)}`)
    for (const option of request.options) {
      assert.equal(typeof option.id, 'string')
      assert.equal(typeof option.label, 'string')
    }
    const approve = request.options.find((option) => option.id === 'approve')
    assert.ok(approve, `options[].id 里必须有 approve，收到 ${JSON.stringify(request.options.map((o) => o.id))}`)
    assert.ok(
      request.options.some((option) => option.id === 'reject'),
      "红线 14：'reject' 这个词不能改——手机用它判断点完之后界面还该不该显示运行中",
    )

    phone.client.resolvePermission(request.sessionId, request.requestId, approve.id)
    const outbound = phone.cmds.filter((c) => c.cmd.t === 'cmd.resolve_permission').pop()
    assert.equal(outbound.cmd.decision, approve.id, '回传的 decision 必须逐字等于主机下发的 options[].id')
    assert.equal(outbound.cmd.requestId, request.requestId)
    assert.equal(outbound.cmd.sessionId, MOCK_SESSION_ID)

    const tool = await phone.waitForPayload('ev.tool_event', '审批通过后 agent 继续跑（工具行到达）', { timeoutMs: 12_000 })
    assert.equal(tool.sessionId, MOCK_SESSION_ID)
    assert.equal(typeof tool.callId, 'string')
    assert.ok(tool.callId.length > 0, 'callId 缺失会让所有工具事件挤进同一行')
    assert.ok(['started', 'args', 'completed', 'failed'].includes(tool.phase), `phase 必须在枚举内，收到 ${JSON.stringify(tool.phase)}`)
    // mock 内核把 sink.approval 的返回值打进 resultPreview：证明手机上行的 'approve'
    // 被主机结算成了平台词汇 'allowed-once'（agent 确实被放行继续跑）。
    assert.equal(tool.resultPreview, 'allowed-once', `这条 decision 没被主机认领：${JSON.stringify(tool.resultPreview)}`)

    const receipt = await phone.waitForPayload('ev.result', 'send_prompt 的回执', { after: resultBefore, where: (p) => p.cmdId === cmdId, timeoutMs: 12_000 })
    assert.equal(receipt.ok, true, `send_prompt 回执 ok:false：${receipt.message ?? ''}`)

    const done = await phone.waitForPayload('ev.message_delta', '回合收尾（done:true，F9）', {
      after: deltaBefore,
      where: (p) => p.done === true && p.sessionId === MOCK_SESSION_ID,
      timeoutMs: 12_000,
    })
    assert.ok(done.messageId.startsWith('msg_'), `done 必须落在本轮的助手消息上，收到 ${done.messageId}`)
    const frames = phone.payloads('ev.message_delta').filter((p) => p.messageId === done.messageId)
    const text = frames.map((frame) => frame.delta).join('')
    assert.ok(text.includes('收到：'), `流式正文应是 mock 内核的回显，收到 ${JSON.stringify(text)}`)
    assert.ok(text.includes(PROMPT_TEXT.slice(0, 12)), '回显里必须含指令正文（它只存在于密文里，第 10 条审计它不外泄）')
    assert.equal(frames.filter((frame) => frame.done === true).length, 1, 'done 必须恰好一条')
    assert.equal(frames[frames.length - 1].done, true, 'done 必须是这条消息的最后一帧')
    for (const frame of frames) {
      assert.equal(typeof frame.delta, 'string', 'delta 不是字符串时手机会 += 出 undefined 字面量')
      assert.equal(frame.sessionId, MOCK_SESSION_ID)
    }
  })

  test('6. 提问闭环：ev.question_request → cmd.answer 回传 [{questionId,selected:[optionId]}] 并结算回内核', async () => {
    const questionBefore = phone.count('ev.question_request')
    const asked = host.kernel().askQuestion(MOCK_SESSION_ID, [
      { id: 'q1', question: '部署到哪个环境？', options: [{ id: 'staging', label: '预发' }, { id: 'prod', label: '生产' }] },
      { id: 'q2', question: '要通知谁？', multi: true, options: [{ id: 'ops', label: '运维' }, { id: 'qa', label: '测试' }] },
    ])
    const request = await phone.waitForPayload('ev.question_request', '提问卡到达', { after: questionBefore, timeoutMs: 12_000 })
    assert.equal(request.sessionId, MOCK_SESSION_ID)
    assert.equal(typeof request.requestId, 'string')
    assert.deepEqual(request.questions.map((q) => q.id), ['q1', 'q2'], 'questions[].id 必须原样下发（手机回传它）')
    assert.equal(request.questions[0].question, '部署到哪个环境？')
    assert.deepEqual(request.questions[0].options.map((o) => o.id), ['staging', 'prod'])
    assert.equal(request.questions[1].multi, true, 'multi 必须透传（手机用它决定单选/多选）')

    phone.client.answer(request.sessionId, request.requestId, [
      { questionId: 'q1', selected: ['staging'] },
      { questionId: 'q2', selected: ['ops', 'qa'], freeText: '顺便抄送值班' },
    ])
    const outbound = phone.cmds.filter((c) => c.cmd.t === 'cmd.answer').pop()
    assert.deepEqual(
      outbound.cmd.answers,
      [
        { questionId: 'q1', selected: ['staging'] },
        { questionId: 'q2', selected: ['ops', 'qa'], freeText: '顺便抄送值班' },
      ],
      `红线 15：出站 answers 的形状与顺序必须一致，收到 ${JSON.stringify(outbound.cmd.answers)}`,
    )
    const settled = await Promise.race([asked, delay(12_000).then(() => null)])
    assert.ok(settled, '手机端的答案 12s 内没结算回内核侧')
    assert.deepEqual(settled.answers.map((a) => a.id), ['q1', 'q2'])
    assert.deepEqual(settled.answers[0].selected, ['预发'], '主机必须把手机上行的 id 翻回平台用的 label')
    assert.deepEqual(settled.answers[1].selected, ['运维', '测试'])
    assert.equal(settled.answers[1].custom, '顺便抄送值班', 'freeText 必须作为整卡共享的自由文本落到 custom')
    // 未填 freeText 时该键会被 JSON.stringify 丢掉（§1.2）：这里核对第一问没有 custom。
    assert.equal('custom' in settled.answers[0], false)
  })

  test('6b. cmd.get_pending：挂起的提问按原帧重发（同一 requestId）+ 回执说清张数', async () => {
    // 背景：审批/提问卡是"一次性"的一帧，退后台/断线/停列表页时错过就没了。
    // peer-joined 重发只发生在重配对；普通重连主机收不到信号，手机主动拉一次。
    const questionBefore = phone.count('ev.question_request')
    const asked = host.kernel().askQuestion(MOCK_SESSION_ID, [
      { id: 'q1', question: '哪个版本上线？', options: [{ id: 'v1', label: 'v1' }] },
    ])
    const request = await phone.waitForPayload('ev.question_request', '提问卡到达', { after: questionBefore, timeoutMs: 12_000 })
    const dupBefore = phone.count('ev.question_request')
    // fire-and-forget：老主机不认会静默丢，新主机重发 + 回执。先断言发得出去。
    assert.equal(phone.client.getPending(MOCK_SESSION_ID), true, 'get_pending 没发出去')
    // cmdId 是 client 内部现编的，回执对答靠它——从实际发出的帧取，不自己编一串。
    const sent = phone.cmds.filter((c) => c.cmd.t === 'cmd.get_pending').pop()
    assert.ok(sent, '发出的命令没被记下来')
    const cmdId = sent.cmd.cmdId
    const dup = await phone.waitForPayload('ev.question_request', '重发到达', {
      after: dupBefore,
      where: (p) => p.requestId === request.requestId,
      timeoutMs: 10_000,
    })
    assert.equal(dup.questions[0].question, '哪个版本上线？', '重发必须原样（同一 requestId、同一题目）')
    assert.equal(dup.expiresAt, request.expiresAt, '到期时刻不许顺延')
    const result = await phone.waitForPayload('ev.result', 'get_pending 回执', {
      where: (p) => p.cmdId === cmdId,
      timeoutMs: 10_000,
    })
    assert.equal(result.ok, true)
    assert.equal(result.data.replayed, 1, '挂着一张就该报 1')
    // 收尾：答掉它，否则挂起的提问会污染后面的用例（超时也要 300 秒）。
    phone.client.answer(request.sessionId, request.requestId, [{ questionId: 'q1', selected: ['v1'] }])
    const settled = await Promise.race([asked, delay(12_000).then(() => null)])
    assert.ok(settled, '答案没结算回内核')
  })

  test('7. cmd.keep_awake → ev.keep_awake_state{enabled,active,platform,backend}（关时不带 idleReleaseSec）', async () => {
    const beforeOn = phone.count('ev.keep_awake_state')
    phone.client.setKeepAwake(true, 600)
    const on = await phone.waitForPayload('ev.keep_awake_state', '防休眠状态（开）', { after: beforeOn, where: (p) => p.enabled === true, timeoutMs: 10_000 })
    assert.equal(typeof on.active, 'boolean', 'active 必须是布尔（手机按它显示"当前持锁中/未持锁"）')
    assert.equal(on.platform, os.platform(), `platform 必须就是 host 的 os.platform()（${os.platform()}）`)
    assert.equal(typeof on.backend, 'string')
    assert.ok(on.backend.length > 0, 'backend 不能是空串：手机要显示"· 后端名"')
    assert.equal(on.sessionId, undefined, 'F11：ev.keep_awake_state 不许带 sessionId')
    assert.equal(phone.client.keepAwake, on, '客户端簿记的 keepAwake 必须就是这条 payload')

    const beforeOff = phone.count('ev.keep_awake_state')
    phone.client.setKeepAwake(false)
    const off = await phone.waitForPayload('ev.keep_awake_state', '防休眠状态（关）', { after: beforeOff, where: (p) => p.enabled === false, timeoutMs: 10_000 })
    assert.equal(off.active, false, '关掉之后必须放锁')
    const cmds = phone.cmds.filter((c) => c.cmd.t === 'cmd.keep_awake')
    assert.ok(cmds.length >= 2, `只看到 ${cmds.length} 条 cmd.keep_awake，开关没走两个方向`)
    assert.equal(cmds[0].cmd.enabled, true)
    assert.equal(cmds[0].cmd.idleReleaseSec, 600, '开启时手机会带 idleReleaseSec=600（单位是秒）')
    assert.equal(cmds[cmds.length - 1].cmd.enabled, false)
    assert.equal(cmds[cmds.length - 1].cmd.idleReleaseSec, undefined, '关闭时不许带 idleReleaseSec（§1.2 字段级要求）')
  })

  test('8. cmd.interrupt → ev.run_state{state:idle, detail:interrupted}', async () => {
    const runStateBefore = phone.count('ev.run_state')
    const permissionBefore = phone.count('ev.permission_request')
    assert.equal(phone.client.sendPrompt(MOCK_SESSION_ID, '讲一个很长的故事'), true, 'sendPrompt 没能发出去')
    const running = await phone.waitForPayload('ev.run_state', '运行中状态到达', { after: runStateBefore, where: (p) => p.state === 'running', timeoutMs: 12_000 })
    assert.equal(running.sessionId, MOCK_SESSION_ID)
    assert.equal(running.detail, undefined, 'running 不需要 detail')
    const held = await phone.waitForPayload('ev.permission_request', '这一轮的审批卡（中断后仍要能结掉）', { after: permissionBefore, timeoutMs: 12_000 })

    phone.client.interrupt(MOCK_SESSION_ID)
    const idle = await phone.waitForPayload('ev.run_state', '中断后的 idle', {
      after: runStateBefore,
      where: (p) => p.state === 'idle' && p.detail === 'interrupted',
      timeoutMs: 12_000,
    })
    assert.equal(idle.sessionId, MOCK_SESSION_ID, 'run_state 必须带 DSH 会话 id')
    assert.ok(
      phone.payloads('ev.run_state').indexOf(idle) > phone.payloads('ev.run_state').indexOf(running),
      'idle/interrupted 必须排在 running 之后（否则手机的转圈停不下来）',
    )
    assert.ok(SESSION_STATES.includes('idle'))
    // 结掉挂起的审批，别把挂起态留到收尾（见 run.mjs shutdown 的注释）。
    phone.client.resolvePermission(held.sessionId, held.requestId, 'reject')
    await until(() => phone.pendingPermissions().length === 0, { timeoutMs: 8000, trail: phone.trail, label: '挂起的审批已结清' })
    const rejected = phone.cmds.filter((c) => c.cmd.t === 'cmd.resolve_permission').pop()
    assert.equal(rejected.cmd.decision, 'reject', "红线 14：'reject' 必须逐字回传")
  })

  test('9. 顺序与合帧：12 段内核增量 → 手机拼接逐字一致、帧数不膨胀、done 收尾', async () => {
    const kernel = host.kernel()
    const chunks = Array.from({ length: 12 }, (_, index) => `段${String(index + 1).padStart(2, '0')}|`)
    const expected = chunks.join('')
    const messageId = `stream_${Date.now().toString(36)}`
    const before = phone.count('ev.message_delta')
    for (const chunk of chunks) {
      kernel.feed({ kind: 'delta', sessionId: MOCK_SESSION_ID, messageId, text: chunk, done: false })
      await delay(25)
    }
    kernel.feed({ kind: 'delta', sessionId: MOCK_SESSION_ID, messageId, text: '', done: true })
    await phone.waitForPayload('ev.message_delta', '这条流式消息收尾', { after: before, where: (p) => p.messageId === messageId && p.done === true })
    const frames = phone.payloads('ev.message_delta').slice(before).filter((p) => p.messageId === messageId)
    const merged = frames.map((frame) => frame.delta).join('')
    assert.equal(merged, expected, `顺序或内容有出入：收到 ${JSON.stringify(merged)}`)
    assert.ok(frames.length < chunks.length, `合帧没起作用：${frames.length} 帧对 ${chunks.length} 段`)
    assert.ok(frames.length <= 6, `每会话每窗口的帧数失控：${frames.length} > 6（合帧器窗口 120ms）`)
    assert.equal(frames[frames.length - 1].done, true, 'done 必须是最后一帧')
    assert.ok(frames.every((frame) => typeof frame.part === 'number'), 'part 必须单调可选在（手机不读，但审计要看得懂）')
    const parts = frames.map((frame) => frame.part)
    assert.deepEqual(parts, [...parts].sort((a, b) => a - b), 'part 必须递增（中继不得重排：per-conversation 串行）')
  })

  test('10. 零知识帧审计：手机交给中继的每一帧都是密文，命令名与正文关键词 0 命中', async () => {
    const sent = outboundToRelay('phone')
    const encSent = sent.filter((raw) => JSON.parse(raw).t === 'enc')
    assert.ok(encSent.length >= 10, `这一路跑下来手机至少该发 10 帧密文，只看到 ${encSent.length}——审计对象不足`)
    // recorder 交叉核对：审计用的每一帧都必须是 recorder 真正录到的（不许只审我们自己内存里的对象）。
    const viaRecorder = phone.recorder.frames.map((f) => f.raw)
    const missing = encSent.filter((raw) => !viaRecorder.includes(raw))
    assert.deepEqual(missing, [], `有 ${missing.length} 帧手机发出的密文没进 recorder`)
    const stats = auditZeroKnowledge({
      outbound: sent,
      observed: sent.concat(controlFrames('phone', 'received', ['enc', 'enc-batch']).map((f) => JSON.stringify(f))),
      minEnc: 10,
      minCipherBytes: 40,
      plaintextSample: { t: 'cmd.send_prompt', cmdId: 'c_probe_1', sessionId: MOCK_SESSION_ID, text: PROMPT_TEXT },
    })
    assert.ok(stats.smallestCipherBytes > 40)
    // 明文关键词确实"该被抓到"——反证这条审计不是空判定。
    const sample = JSON.stringify({ t: 'cmd.send_prompt', text: PROMPT_TEXT })
    assert.ok(sample.includes('cmd.send_prompt') && sample.includes(PROMPT_KEYWORDS[0]))
    const lines = auditRelayLogs(relay)
    assert.ok(lines > 0, `中继日志一行都没有（${lines}），日志审计等于没做`)
  })

  test('11. cmd.session_history：回帧必须**结算成 promise**（不是把帧收下就算完），且不再当普通事件发一遍', async () => {
    // 为什么占一个用例：`loadHistory` 的结算点是 `done()`，它有一道幂等守卫
    // （`if (!self._cmdWaiters[cmdId]) return`）。收帧那边若顺手先把登记删掉，
    // 守卫就永远命中 —— promise 永不 resolve，**连 15s 超时也会被同一道守卫吃掉**
    // （超时回调走的也是 done）。表现是首屏历史永远停在 loading、或「加载更早」转圈不动，
    // 而且不发错、不重试。这个 bug 真发生过一次，就是这么漏过去的：本文件当时没有历史用例，
    // mp-chat-blocks 又是桩 client，两边都看不见。
    const client = phone.client
    const payloadsBefore = phone.count('ev.session_history')
    // 有界等待：回帧正常是毫秒级。若结算被吃掉（见上面那段），`await` 会**永不返回**——
    // 那会把整个套件拖死成"跑到这里就没动静了"，比一条红难查得多。
    const page = await Promise.race([client.loadHistory(MOCK_SESSION_ID, { limit: 3 }), delay(5000).then(() => '超时未结算')])
    assert.notEqual(page, '超时未结算', '5s 内回帧没有结算成 promise —— 结算点被吃掉了（页面会永远转圈）')
    assert.ok(
      page,
      'loadHistory 没拿到页：回帧没有结算成 promise（或超时被幂等守卫吃掉）——页面上就是「正在读取主机上的历史…」永远转下去',
    )
    assert.equal(page.t, 'ev.session_history')
    assert.equal(page.sessionId, MOCK_SESSION_ID, '回执的 sessionId 必须是 DSH 会话 id（F3，帧外层那个 c_* 不是它）')
    assert.ok(Array.isArray(page.items) && page.items.length > 0, `历史页必须带条目，收到 ${JSON.stringify(page).slice(0, 200)}`)
    for (const item of page.items) {
      assert.ok(
        ['ev.message_delta', 'ev.tool_event', 'ev.todo'].includes(item.t),
        `历史条目只允许实时流那三种叶子载荷（小程序用同一条落块路径回放），收到 ${JSON.stringify(item.t)}`,
      )
    }
    // mock 历史的最后一条是待办快照（2026-10-05 加）：它必须逐字节过网——
    // 这条判据红，说明插件发出的形状与 wire 1.5.0 的 schema 对不上。
    const todoSnapshots = page.items.filter((item) => item.t === 'ev.todo')
    assert.equal(todoSnapshots.length, 1, `第一页必须带一条待办快照，实得 ${todoSnapshots.length} 条`)
    assert.deepEqual(
      todoSnapshots[0].todos,
      [
        { content: '复现用户报的问题', status: 'completed' },
        { content: '改完跑一遍本地全链路', status: 'in_progress' },
      ],
      '快照内容必须逐字节过网（全量语义，不折叠）',
    )
    const sent = phone.cmds.filter((c) => c.cmd.t === 'cmd.session_history').pop()
    assert.ok(sent, '手机没发出 cmd.session_history')
    assert.equal(sent.cmd.sessionId, MOCK_SESSION_ID, '载荷 sessionId 必须是 DSH 会话 id')
    assert.equal(sent.cmd.limit, 3, 'limit 必须原样上行')
    assert.equal(page.cmdId, sent.cmd.cmdId, 'ev.session_history.cmdId 必须原样回传（对答靠它匹配）')
    assert.equal(
      phone.count('ev.session_history'),
      payloadsBefore,
      '它是**回执**不是事件：不该再当普通事件 emit 一遍，否则页面会走两条路处理同一页历史',
    )
    assert.equal(
      Object.keys(client._cmdWaiters).length,
      0,
      '结算后登记必须清空，否则每读一页都攒一个。' +
        '注意登记在 _cmdWaiters 这张**统一**表上：取历史与新建会话都是"回执靠 cmdId 匹配"，' +
        '同一套 done()/超时/幂等守卫，没必要分两张表',
    )
  })

  test('12. 解配/断线时挂起的历史请求必须当场结算成 null（否则「正在读取主机上的历史…」永远转下去）', async () => {
    // 这条会解配，所以用**独立一台手机**，不能打掉共享装置（下一条用例还要它）。
    // 真机上的对应场景：正在读历史时用户点了「解除配对」，或链接掉了触发 _resetPairing ——
    // 两条路都走 _forgetPairing → _settleHistory。那里若"先换表再回调"，回调会在
    // done() 的幂等守卫处全部早退，挂起的请求既拿不到结果、也不会超时。
    const solo = newSoloPhone('历史断线手机')
    await pairPhone(host, solo, { expectedRelayUrl: relay.url })
    const pending = solo.client.loadHistory(MOCK_SESSION_ID, { limit: 3 })
    assert.equal(
      Object.keys(solo.client._cmdWaiters).length,
      1,
      '请求没登记上 —— 这个用例就没验到东西（登记是结算的前提）',
    )
    solo.client.unpair()
    const settled = await Promise.race([pending, delay(2000).then(() => '仍在等待')])
    assert.notEqual(settled, '仍在等待', '解配后挂起的取历史请求没被结算：页面会永远停在读取中，不发错也不重试')
    assert.equal(settled, null, '断线/解配时该结算成 null —— 页面据此显示"读不到"并允许重试，而不是"这个会话没内容"')
    assert.equal(Object.keys(solo.client._cmdWaiters).length, 0, '结算后登记必须清空')
  })

  test('12b. 手机解配后，主机侧必须知道这个客户端走了（否则电脑上一直显示"配对中"）', async () => {
    /**
     * 这条对应用户报的现象：手机上点了「解除配对」，**dsh 侧仍然显示配对中**。
     *
     * 根因不在界面：`unpair()` 原来只做本地清理 + 断线，**从不通知主机**。
     * 于是主机完全不知情 —— 中继成员表里留着这部手机，`status.json` 里的
     * 配对状态照旧，而那个状态没有任何东西会清掉。
     *
     * 走的是中继**已经实现**的 `session-leave`（客户端分支）→ 中继转 `peer-left`
     * 给主机。不新增协议帧：帧名是冻结的（F1），而中继那条路本来就在。
     *
     * 为什么用独立一台手机：解配是不可逆的，会打掉共享装置。
     */
    const solo = newSoloPhone('解配告别手机')
    await pairPhone(host, solo, { expectedRelayUrl: relay.url })

    // 先发一帧，让主机把这部手机记进成员表。
    // ⚠️ 成员是在**收到加密帧**时登记的（`onEncrypted` 里按 clientId 记），
    // 配对刚发生时成员表是空的 —— 不先发一帧，下面那条断言会因前提不成立而假红。
    solo.client.sendCmd({ t: 'cmd.list_sessions' })
    await until(() => host.state().pairedClients >= 1, {
      timeoutMs: 5_000,
      label: '主机把这部手机记进成员表（status.json 的 pairedClients）',
      trail: [{ kind: 'host-state', status: JSON.stringify(host.state().pairedClients) }],
    })
    const during = host.state().pairedClients
    assert.ok(during >= 1, `夹具自检：解配前主机应当至少看到 1 台手机（读到 ${during}）`)

    // ⚠️ 上一轮只判到`status.json` 就收工了，**漏了用户真正看的那一句**。
    // pill 抬头那句「已配对/未配对」读的是 `pillStatus().paired`，而它当时接的是
    // `conversationCount`（**会话数**）—— 会话按 D3 长存，手机解配也不删，
    // 于是那个数恒为 1，电脑上就一直显示"已配对"，用户看着毫无变化。
    // `status.json` 归零只能证明主机知道了，证明不了界面变了，所以这条必须打真路由。
    const PILL_STATUS = '/plugins/dsh-remote-control/status'
    const pillBefore = await host.callPill(PILL_STATUS)
    assert.equal(pillBefore.status, 200, JSON.stringify(pillBefore.body))
    assert.ok(pillBefore.body.paired >= 1, `夹具自检：解配前 pill 应显示已配对（读到 ${pillBefore.body.paired}）`)

    solo.client.unpair()

    // 主机侧必须真的把它摘掉。这条是本用例的全部意义，所以判据是**消失**而不是"变小了"。
    await until(() => !host.state().pairedClients, {
      timeoutMs: 5_000,
      label: '解配后主机侧不再把这台手机算作已连接',
      trail: [{ kind: 'host-state', status: JSON.stringify(host.state().pairedClients) }],
    })
    assert.equal(host.state().pairedClients, 0, '主机仍在把这台已解配的手机算作已连接')
    assert.equal(solo.client.status, 'needs-pair', '手机自己这一侧要落到"需要配对"')

    // 用户看的那一句也得跟着变。**这不是上一条断言的重复**：上面读的是
    // `status.json`（排障用的账本），这条读的是 pill 真路由（界面上的那句文案），
    // 两者取的是不同字段 —— 正是"账本对了、界面还错"这种漏法才需要两条判据。
    await untilAsync(async () => (await host.callPill(PILL_STATUS)).body.paired === 0, {
      timeoutMs: 5_000,
      label: 'pill 抬头那句从"已配对"变成"未配对"',
      trail: [{ kind: 'check', status: '打 pill status 路由读 paired' }],
    })
    // 会话必须**一起作废**（2026-10-05 用户报：「mp 端解除配对，dsh 端执行的是手机离线」）。
    //
    // 这一条原来钉的是**反面**：会话必须留着，理由是 D3。但 mp 的 unpair() 里
    // `_forgetPairing()` 已经把 convId 清了，**它再也不会带这个 convId 回来**——
    // 于是留着它就是一条永远清不掉的幽灵：pairedClients 归 0 而 conversations 恒为 1，
    // pill 于是永远停在「手机离线」，用户永远等不到「未配对」。
    //
    // D3 保的是**掉线**（切后台、断网）那条路，手机会带着同一个 convId 回来；
    // 主动解配是另一回事，它本来就是不可逆的。两条路现在由 peer-left.unpaired 分开。
    await untilAsync(async () => (await host.callPill(PILL_STATUS)).body.pairings === 0, {
      timeoutMs: 5_000,
      label: 'pill 的配对数也归零（会话已作废，不该停在「手机离线」）',
      trail: [{ kind: 'check', status: '打 pill status 路由读 pairings' }],
    })
    assert.equal(
      host.state().conversations,
      0,
      `手机已经解配、convId 也清掉了，主机却还留着这条会话（读到 ${host.state().conversations}）：它永远清不掉`,
    )
  })


  /* ── rc1 前的缺陷修复判据（2026-10-06 晚）─────────────────────────────
     都在**真 client** 上验：这几条的病根都在 client.js/session-store.js 自己，
     桩掉它们等于把要测的东西桩掉。每条都先确认过在旧实现上会红。 */

  /**
   * 造一台**有独立 installId** 的手机。
   *
   * 为什么不能直接用 `newPhone()`：夹具里所有"手机"共用同一个 wx storage，
   * 于是 `hydrate()` 读出的 installId 也一样 —— 而中继按 clientId 保证
   * "同 id 唯一活动连接"（`state.attachClient` 的顶号语义）。那会让新手机
   * 一配对就把**共享 rig 那条连接顶掉**，共享手机随后重连、撞 unknown_session、
   * 掉配对 —— 判据红在一个跟被测行为无关的抢注上（本次真踩到）。
   * 真机上每台设备的 storage 是独立的，所以这里必须显式给一个不同的 id。
   */
  function newSoloPhone(label) {
    const KEY = 'drc.installId'
    const previous = globalThis.wx.getStorageSync(KEY)
    globalThis.wx.setStorageSync(KEY, 'e2e-solo-' + encodeURIComponent(label) + '-' + Math.random().toString(36).slice(2, 8))
    const solo = newPhone(label)
    globalThis.wx.setStorageSync(KEY, previous)
    return solo
  }

  test('12c. 退避重连期解配也要断得掉：不许留下会自我重连的孤儿 socket', async () => {
    const solo = newSoloPhone('退避期解配手机')
    await pairPhone(host, solo, { expectedRelayUrl: relay.url })
    const sock = solo.client.sock
    const task = sock._task
    assert.ok(sock && task, '夹具自检：配好之后要有活的 socket')

    // 摆出"重连退避期"的样子：连接已经没了，重连排在定时器上。
    // 这就是 `sendThenClose` 会直接 return false 的那种状态。
    sock._task = null
    sock._retry = 0
    sock._scheduleReconnect()
    assert.ok(sock._reconnectTimer, '夹具自检：重连已经排上')

    const hellosBefore = solo.sent.filter((s) => s.frame.t === 'hello').length
    solo.client.unpair()
    assert.equal(solo.client.status, 'needs-pair')
    assert.equal(solo.client.statusText, '已解除配对')
    assert.equal(sock._manualClose, true, '断不掉就还有一条活着的重连链')
    assert.equal(sock._reconnectTimer, null, '重连定时器是那个孤儿 socket 的全部动力，必须清掉')
    assert.equal(solo.client._pendingToken, null, '正在配对中的那半程也要一起作废')

    // 等过一个重连窗口（首次退避 1000~1500ms）。旧实现这里会自己连回来，
    // 随后 hello-ok 把"已解除配对"改写成"请输入主机上的 6 位配对码"（探针实测）。
    await delay(1800)
    const hellosAfter = solo.sent.filter((s) => s.frame.t === 'hello').length
    assert.equal(hellosAfter, hellosBefore, '解配之后又开了一条连接：孤儿 socket 自己重连了')
    assert.equal(solo.client.statusText, '已解除配对', 'hello-ok 把"已解除配对"改写掉了')
    task.close() // 收尾：把那条真实连接关掉（页面已经不再持有它）
  })

  test('12d. 配对记录缺失时拒绝发送（绝不回退 nonce 计数器：那会复用 nonce 与密文）', async () => {
    const solo = newSoloPhone('nonce 探针手机')
    await pairPhone(host, solo, { expectedRelayUrl: relay.url })
    const saved = solo.client._resume

    // 不变式本身：同一条明文连发两次，nonce 计数器递增 → 密文必须不同。
    const plain = () => ({ t: 'cmd.list_sessions', cmdId: 'probe_same_plaintext' })
    const before = solo.sent.length
    assert.equal(solo.client.sendCmd(plain()), true)
    assert.equal(solo.client.sendCmd(plain()), true)
    const cts = solo.sent.slice(before, before + 2).map((s) => s.frame.ciphertext)
    assert.equal(cts.length, 2, '夹具自检：两条密文帧都要在')
    assert.notEqual(cts[0], cts[1], '同明文两次发送得到同一个密文：nonce 被复用了（密钥流复用）')

    // 缺 `_resume`：旧实现兜底 `{nonceCounter: 0}`，每条命令都从 0 起算 ——
    // 上面那条不变式立刻被打破。正确做法是**拒绝发送**。
    solo.client._resume = null
    const errors = []
    const off = solo.client.on((e) => {
      if (e.kind === 'error') errors.push(e)
    })
    assert.equal(
      solo.client.sendCmd({ t: 'cmd.list_sessions', cmdId: 'probe_no_resume' }),
      false,
      '缺配对记录时必须拒绝发送，而不是拿一个从 0 起算的兜底计数器发出去',
    )
    off()
    assert.equal(solo.sent.length, before + 2, '拒绝发送就不该有新的密文帧')
    assert.match(
      errors.map((e) => e.message).join('|'),
      /配对记录/,
      `拒绝时要给一句人话原因，收到 ${JSON.stringify(errors.map((e) => e.message))}`,
    )
    solo.client._resume = saved
    solo.close() // 收尾：这条连接还活着，不关掉会把进程挂在事件循环上
  })

  test('12e. 存储里的配对记录坏了：hydrate 不许抛（App.onLaunch 会因此白屏），要清掉并要求重扫码', () => {
    const KEY = 'drc.pairing.v1'
    const previous = globalThis.wx.getStorageSync(KEY)
    // 非 base64 的 psk：旧实现裸调 derivePskKey → js-base64 抛 InvalidCharacterError，
    // 而 getClient() 就在 App.onLaunch 里 —— 小程序启动即失败且无提示、无法自愈。
    globalThis.wx.setStorageSync(KEY, {
      server: 'wss://relay.example/ws',
      psk: 'not base64!!',
      convId: 'c_0123456789ab',
      nonceCounter: 3,
    })
    let client = null
    assert.doesNotThrow(() => {
      client = new phone.mp.client.DrcClient().hydrate()
    }, 'hydrate 在启动路径上，绝不许抛')
    assert.equal(client.status, 'needs-pair', '坏记录要落到"需要配对"，用户才知道该扫码')
    assert.match(String(client.statusText), /重新扫码/, '要给一条能走的出路')
    assert.equal(client.isPaired(), false, '坏记录不许算作已配对')
    assert.equal(globalThis.wx.getStorageSync(KEY), '', '坏记录必须就地清掉，否则每次启动都再坏一次')
    if (previous) globalThis.wx.setStorageSync(KEY, previous) // 别污染共享装置的存储
  })

  test('12f. pair-fail 必须清掉旧配对：界面 needs-pair 而 isPaired() 还 true 是自相矛盾的', async () => {
    const solo = newSoloPhone('配对失败手机')
    await pairPhone(host, solo, { expectedRelayUrl: relay.url })
    const KEY = 'drc.pairing.v1'
    const previous = globalThis.wx.getStorageSync(KEY)
    // 模拟"用户又扫了一张新码"：connect({psk}) 会把 this.psk 换成新密钥，
    // 旧 convId 的两把密钥再也派生不出来 —— 而旧实现不清配对，isPaired() 还是 true。
    solo.client.psk = Buffer.alloc(16, 5).toString('base64')
    solo.client._onFrame(JSON.stringify({ t: 'pair-fail', reason: 'invalid_or_expired' }))
    assert.equal(solo.client.status, 'needs-pair')
    assert.match(solo.client.statusText, /配对失败/)
    assert.equal(solo.client.isPaired(), false, '旧配对必须一起丢掉（psk 已经换了，那对密钥再也派生不出来）')
    assert.equal(globalThis.wx.getStorageSync(KEY), '', '存储里的旧配对也要清掉，否则下次启动又"配着"')
    if (previous) globalThis.wx.setStorageSync(KEY, previous)
    solo.close() // 收尾：socket 还在（pair-fail 只清配对，不关连接）
  })

  test('12g. 配对入口的校验：非 ws 地址 / 非 base64 密钥 / 非 16 字节密钥 / 非 6 位配对码都就地拒绝', () => {
    const { codec } = phone.mp
    const psk16 = Buffer.alloc(16, 9).toString('base64')

    // ① 二维码解析：非法输入拒（合法的解析结果一个字段都不许变）
    assert.equal(codec.parsePairingQr('dshr:/p?s=https://x&psk=' + psk16), null, 'http(s) 的地址连不上，不该放过去')
    assert.match(codec.pairingQrError('dshr:/p?s=https://x&psk=' + psk16), /ws/, '要说清是哪一项不对')
    assert.equal(codec.parsePairingQr('dshr:/p?s=wss://x&psk=not-base64!!'), null, '非 base64 的密钥放进去会在 derivePskKey 抛英文异常')
    assert.match(codec.pairingQrError('dshr:/p?s=wss://x&psk=not-base64!!'), /base64/)
    assert.deepEqual(
      codec.parsePairingQr(
        'dshr:/p?v=1&s=' + encodeURIComponent('wss://relay.example/ws') + '&psk=' + encodeURIComponent(psk16) + '&t=123456',
      ),
      { v: 1, server: 'wss://relay.example/ws', hostLabel: 'dsh', psk: psk16, token: '123456' },
      '合法二维码的解析结果必须逐字段不变（protocol.test.mjs 与 Node 侧对拍）',
    )

    // ② 真正的配对入口（connect）—— 校验不过就不许建连接
    const c = new phone.mp.client.DrcClient()
    c.connect({ server: 'wss://relay.example/ws', psk: 'QUJDREVGRw==', token: '123456' }) // 7 字节
    assert.equal(c.status, 'needs-pair')
    assert.match(c.statusText, /16 字节/, `psk 长度不对要说清是 16 字节，收到 ${JSON.stringify(c.statusText)}`)
    assert.equal(c.sock, null, '校验没过就不该建 socket')
    c.connect({ server: 'http://relay.example/ws', psk: psk16, token: '123456' })
    assert.match(c.statusText, /ws:\/\//, '地址形状不对要说清')
    assert.equal(c.sock, null)
    c.connect({ server: 'wss://relay.example/ws', psk: psk16, token: 'abcdef' })
    assert.match(c.statusText, /6 位/, '配对码形状不对要说清')
    assert.equal(c.sock, null)
  })

  test('12h. peer-left 只认本会话：别的会话散了不许把这次配对踢掉', async () => {
    const solo = newSoloPhone('peer-left 手机')
    await pairPhone(host, solo, { expectedRelayUrl: relay.url })
    solo.client._onFrame(JSON.stringify({ t: 'peer-left', sessionId: 'c_otherconversation', clientId: solo.client.clientId }))
    assert.equal(solo.client.status, 'online', '别的会话没了与本机这次配对无关，不许把用户无端踢回扫码页')
    assert.equal(solo.client.isPaired(), true)
    solo.client._onFrame(JSON.stringify({ t: 'peer-left', sessionId: solo.convId, clientId: solo.client.clientId }))
    assert.equal(solo.client.status, 'needs-pair', '本会话的主机走了才是真的要走')
    assert.equal(solo.client.isPaired(), false)
    solo.close() // 收尾：这条连接还开着，不关掉会把进程挂在事件循环上
  })


  test('12i. 夹具复原：共享手机会被"只允许一台"踢掉，重新配回来给后面的用例', async () => {
    /**
     * 这不是被测行为，是**装置约束**：宿主插件对 `peer-joined` 的策略是"只允许一台"
     * （index.ts 的 `onPeerJoined`：新设备一进来就把其它通道 `voidConversation`），
     * 于是上面每配一台 solo 手机，共享这台就会被主机踢掉（手机侧收到 peer-left
     * →「主机已断开，请重新配对」，这是设计如此）。
     * 原来那两条 solo 用例靠"共享手机的 socket 恰好被同 clientId 顶掉"侥幸没暴露，
     * 而 12c 的 1.8 秒等待把它变成了必现。后面的用例（13）建立在共享装置仍配对之上，
     * 所以这里显式配回来 —— 藏着一个"恰好还行"比写明白更贵。
     */
    if (!phone.client.isPaired()) {
      await pairPhone(host, phone, { expectedRelayUrl: relay.url })
    }
    assert.ok(phone.client.isPaired(), '共享装置必须回到已配对：后面的用例都建立在它之上')
  })

  test('13. 解密失败两次就永久掉配对（§3.2）：这条约束对中继是硬要求', async () => {
    // 为什么这条值得占一个用例：中继只要把 sessionId→conv 映射搞错一次（或用错 PSK 派生密钥），
    // 手机在两帧之后就会**永久**丢掉配对并要求重新扫码（dsh-remote-mp/miniprogram/core/client.js:294-304）。
    // 这里不替换任何组件：直接拿真实 client 的收帧入口 `_onEncrypted` 喂两条"格式完全正确、
    // 但用另一条通道的密钥封出来"的记录——这就是那种故障在手机上呈现的字节。
    const client = phone.client
    const convId = phone.convId
    assert.match(convId, /^c_/, '这条用例必须跑在还配着对的手机之上')
    const { codec } = phone.mp
    const failPayload = { t: 'ev.session_changed', sessions: [] }
    // 用"另一条通道的密钥"封一条合法记录：格式完全正确、就是解不开——
    // 这正是中继把 sessionId→conv 映射搞错时手机看到的东西。
    const wrongKey = codec.derivePskKey(client.psk, 'h2c', 'c_000000000000')
    const forged = codec.seal(wrongKey, failPayload, new Uint8Array(24))
    assert.ok(forged.ciphertext.length > 20)
    // 一帧坏密文：只报一次"有一条数据无法解密"，配对还在（client.js:294-304）
    client._onEncrypted({ sessionId: convId, ciphertext: forged.ciphertext })
    assert.notEqual(client.status, 'needs-pair', '一帧解不开不该立刻杀配对')
    const errorEvents = phone.events.filter((e) => e.kind === 'error' && String(e.message).includes('无法解密'))
    assert.equal(errorEvents.length, 1, `第一帧坏密文必须给出一次可读提示，收到 ${JSON.stringify(errorEvents)}`)
    client._onEncrypted({ sessionId: convId, ciphertext: forged.ciphertext })
    await until(() => client.status === 'needs-pair', { timeoutMs: 5000, trail: client.trail ?? phone.trail, label: '第二帧坏密文后进入 needs-pair' })
    assert.match(client.statusText, /重新扫码/, `文案必须是"配对已失效（密钥不匹配），请重新扫码"，收到 ${JSON.stringify(client.statusText)}`)
    assert.equal(client.convId, '', '两帧解不开必须清掉配对')
    assert.equal(client.sessions.length, 0)
    // 这条用例会把配对打掉：后面没有别的用例了（node:test 同文件按声明顺序跑），
    // 收尾由 after() 负责，中继退出码仍然必须为 0。
  })
})
