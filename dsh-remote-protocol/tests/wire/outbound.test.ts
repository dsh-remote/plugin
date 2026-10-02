/**
 * 出站构造器的机械防线（复核 R7 要求"从注释变成跑一下就红"）。
 *
 * 这里守的是三类东西：
 * - **必发帧的必填项**（F4）：hello-ok 对客户端必须带 clientId、paired 必须带 sessionId；
 * - **禁止出现的字段**（F11）：ev.keep_awake_state / ev.session_changed 不许带 sessionId；
 * - **两条 peer-joined 路径的字段集差异**（旧事故）：给主机的必须带 pairingToken，给客户端的必须不带。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRelayFrame, relayFrame } from '../../src/wire/frames.js'
import { parseEvPayload } from '../../src/wire/payloads.js'
import {
  encBatchToClient,
  encToClient,
  helloOkForClient,
  helloOkForHost,
  keepAwakeState,
  makeError,
  messageDelta,
  paired,
  pairFail,
  pairReady,
  peerJoinedForHost,
  peerJoinedNotice,
  peerLeft,
  pong,
  result,
  runState,
  sessionChanged,
  sessionHistory,
  toolEvent,
  permissionRequest,
  questionRequest,
} from '../../src/wire/outbound.js'

const keysOf = (value: object): string[] => Object.keys(value).sort()

test('每条出站控制帧都能被对侧的 schema 解出来（自证往返）', () => {
  const outbound = [
    helloOkForClient('inst-1', 1),
    helloOkForHost('h1', 1),
    pairReady('123456', 180_000),
    paired('c_a1b2c3d4e5f6', 'h1'),
    pairFail('already_used'),
    peerJoinedForHost('c_a1b2c3d4e5f6', 'inst-1', '123456'),
    peerJoinedNotice('c_a1b2c3d4e5f6', 'h1'),
    peerLeft('c_a1b2c3d4e5f6', 'h1'),
    makeError('unknown_session'),
    makeError('bad_frame', 'binary frames are not supported'),
    pong(1234),
    encToClient('c_a1b2c3d4e5f6', 1, 'AAAA'),
    encBatchToClient('c_a1b2c3d4e5f6', [{ seq: 1, ciphertext: 'AAAA' }]),
  ]
  for (const frame of outbound) {
    assert.notEqual(parseRelayFrame(frame), null, `${frame.t} 的出站形状不合法`)
    assert.equal(relayFrame.safeParse(frame).success, true, `${frame.t} 过不了联合类型`)
  }
})

test('F4：hello-ok 对客户端必带 clientId，对主机必带 hostId，另一个都不带', () => {
  assert.deepEqual(keysOf(helloOkForClient('i')), ['clientId', 'role', 't'])
  assert.deepEqual(keysOf(helloOkForHost('h')), ['hostId', 'role', 't'])
})

test('F4：paired 必带 sessionId；pair-ready 必带正整数 ttlMs', () => {
  assert.deepEqual(keysOf(paired('c_x', 'h')), ['hostId', 'sessionId', 't'])
  assert.deepEqual(keysOf(pairReady('123456', 90_000)), ['pairingToken', 't', 'ttlMs'])
})

test('旧事故：给主机的 peer-joined 带 pairingToken，给客户端的那条不带', () => {
  assert.deepEqual(keysOf(peerJoinedForHost('c_x', 'i', '123456')), ['clientId', 'pairingToken', 'sessionId', 't'])
  assert.deepEqual(keysOf(peerJoinedNotice('c_x', 'h')), ['clientId', 'sessionId', 't'])
})

test('F11：两个"无会话归属"的载荷里不存在 sessionId 这条路', () => {
  // 编译期第一道：返回类型 EvKeepAwakeState 里根本没有 sessionId 这个属性，
  // 写 `ka.sessionId` 就通不过编译；运行期再对产物键集做一次。
  const ka = keepAwakeState({ enabled: true, active: false, platform: 'darwin', backend: 'caffeinate' })
  assert.equal('sessionId' in ka, false)
  assert.notEqual(parseEvPayload(ka), null)

  const sc = sessionChanged([{ id: 'ses_1' }])
  assert.equal('sessionId' in sc, false)
  assert.notEqual(parseEvPayload(sc), null)
  // 元素里可以有 sessionId 语义的字段吗？不行——那里叫 `id`（F3/F7）。
  assert.deepEqual(keysOf(sc), ['sessions', 't'])
})

test('出站载荷都能被解析，且字段名与 schema 一致', () => {
  const payloads = [
    messageDelta({ messageId: 'm1', delta: 'hi', sessionId: 'ses_1', done: true }),
    messageDelta({ messageId: 'm2', delta: '', done: true }),
    toolEvent({ callId: 'c1', phase: 'started', tool: 'bash' }),
    permissionRequest({ requestId: 'r1', action: '执行 bash', options: [{ id: 'approve', label: '允许' }] }),
    questionRequest({
      requestId: 'r1',
      questions: [{ id: 'q1', question: '选哪个环境？', options: [{ id: 'staging', label: '预发' }] }],
    }),
    runState({ state: 'idle', detail: 'interrupted', sessionId: 'ses_1' }),
    result('c1', true, { data: { sessions: [] } }),
    result('', false, { message: '载荷处理失败' }),
  ]
  for (const payload of payloads) {
    assert.notEqual(parseEvPayload(payload), null, `${payload.t} 不合法`)
  }
})

test('makeError：message 缺席时不留空键（否则对侧会读到 undefined 文案）', () => {
  assert.deepEqual(keysOf(makeError('internal')), ['code', 't'])
  assert.deepEqual(keysOf(makeError('internal', 'boom')), ['code', 'message', 't'])
})

test('sessionHistory：游标只在"还有更早的一页"时出现，一个字段不会自相矛盾', () => {
  const last = sessionHistory({ sessionId: 'ses_1', cmdId: 'c1', items: [] })
  assert.deepEqual(keysOf(last), ['cmdId', 'items', 'sessionId', 't'], '省略游标 = 最初的一页')
  assert.notEqual(parseEvPayload(last), null)

  const more = sessionHistory({
    sessionId: 'ses_1',
    cmdId: 'c1',
    items: [
      { t: 'ev.message_delta', messageId: 'm1', delta: 'hi', role: 'user', done: true },
      { t: 'ev.tool_event', callId: 'c1', phase: 'completed', tool: 'Bash' },
    ],
    nextBeforeSeq: 3,
  })
  assert.deepEqual(keysOf(more), ['cmdId', 'items', 'nextBeforeSeq', 'sessionId', 't'])
  assert.notEqual(parseEvPayload(more), null)
})

test('sessionHistory：条目里的 sessionId 可以缺省（外层已经带了，逐条重复只是白占帧）', () => {
  const page = sessionHistory({
    sessionId: 'ses_1',
    cmdId: 'c1',
    items: [{ t: 'ev.tool_event', callId: 'c1', phase: 'started', tool: 'Bash' }],
  })
  assert.deepEqual(keysOf(page.items[0] ?? {}), ['callId', 'phase', 't', 'tool'])
  assert.notEqual(parseEvPayload(page), null)
})
