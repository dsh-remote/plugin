/**
 * mp-client.test — **真实 `mp/core/client.js`** 驱动的本地闭环。
 *
 * 三个真实（对照 docs/legacy-spec/testing-and-tooling.md §2）：
 * - 中继是真的（`apps/server/dist/src/main.js` 真进程）
 * - 插件运行时是真的（`packages/plugin/dist/src/index.js` 的 `apply(ctx, injected)` 真入口）
 * - 小程序客户端是真的（`e2e/mp-sim.mjs` 把 `mp/core/*.js` 原文件加载进 Node 驱动）
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
} from './run.mjs'
import { until } from './mp-sim.mjs'

const SESSION_STATES = ['idle', 'running', 'detached', 'archived', 'awaiting-permission', 'awaiting-answer']

describe('真 mp/core/client.js × 真中继 × 真插件运行时（内核面 = mock-kernel）', () => {
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
    // 用户看不到任何提示（mp/core/client.js:53-61）。这条用真实客户端证明"没有出口"。
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
    // （`if (!self._historyWaiters[cmdId]) return`）。收帧那边若顺手先把登记删掉，
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
        ['ev.message_delta', 'ev.tool_event'].includes(item.t),
        `历史条目只允许实时流那两种（小程序用同一条落块路径回放），收到 ${JSON.stringify(item.t)}`,
      )
    }
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
    assert.equal(Object.keys(client._historyWaiters).length, 0, '结算后登记必须清空，否则每读一页都攒一个')
  })

  test('12. 解配/断线时挂起的历史请求必须当场结算成 null（否则「正在读取主机上的历史…」永远转下去）', async () => {
    // 这条会解配，所以用**独立一台手机**，不能打掉共享装置（下一条用例还要它）。
    // 真机上的对应场景：正在读历史时用户点了「解除配对」，或链接掉了触发 _resetPairing ——
    // 两条路都走 _forgetPairing → _settleHistory。那里若"先换表再回调"，回调会在
    // done() 的幂等守卫处全部早退，挂起的请求既拿不到结果、也不会超时。
    const solo = newPhone('历史断线手机')
    await pairPhone(host, solo, { expectedRelayUrl: relay.url })
    const pending = solo.client.loadHistory(MOCK_SESSION_ID, { limit: 3 })
    assert.equal(
      Object.keys(solo.client._historyWaiters).length,
      1,
      '请求没登记上 —— 这个用例就没验到东西（登记是结算的前提）',
    )
    solo.client.unpair()
    const settled = await Promise.race([pending, delay(2000).then(() => '仍在等待')])
    assert.notEqual(settled, '仍在等待', '解配后挂起的取历史请求没被结算：页面会永远停在读取中，不发错也不重试')
    assert.equal(settled, null, '断线/解配时该结算成 null —— 页面据此显示"读不到"并允许重试，而不是"这个会话没内容"')
    assert.equal(Object.keys(solo.client._historyWaiters).length, 0, '结算后登记必须清空')
  })

  test('13. 解密失败两次就永久掉配对（§3.2）：这条约束对中继是硬要求', async () => {
    // 为什么这条值得占一个用例：中继只要把 sessionId→conv 映射搞错一次（或用错 PSK 派生密钥），
    // 手机在两帧之后就会**永久**丢掉配对并要求重新扫码（mp/core/client.js:294-304）。
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
