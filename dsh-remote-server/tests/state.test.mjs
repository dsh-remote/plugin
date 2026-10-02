/**
 * 中继状态机的纯内存测试（不起 socket、不占端口）。
 *
 * `state.ts` 刻意不 import `ws`，所以这里可以用假 socket 把配对、成员校验、
 * 断开、宽限期、清扫全部驱动一遍——这类测试跑得快，而且红了就是状态机本身错了，
 * 不用怀疑网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayState, WS_OPEN } from '../dist/src/state.js'

const CLOSED = 3

class FakeSock {
  constructor(name) {
    this.name = name
    this.readyState = WS_OPEN
    this.sent = []
    this.closedWith = null
  }

  send(text) {
    this.sent.push(text)
  }

  close(code, reason) {
    this.closedWith = { code, reason }
    this.readyState = CLOSED
  }

  last() {
    return JSON.parse(this.sent.at(-1))
  }
}

function harness({ now = 1_000, maxPendingPairs = 100 } = {}) {
  const clock = { now }
  const state = new RelayState({ now: () => clock.now, maxPendingPairs })
  const host = new FakeSock('host')
  const client = new FakeSock('client')
  state.attachHost('h1', host, 'my-macbook')
  state.attachClient('inst-1', client)
  return { state, clock, host, client, advance: (ms) => (clock.now += ms) }
}

test('配对：认领成功才会创建会话，且 sessionId 是 c_ + 12 hex', () => {
  const { state } = harness()
  state.issuePair('h1', '123456', 180_000)
  const claimed = state.claim('123456', 'inst-1')
  assert.equal(claimed.ok, true)
  assert.match(claimed.conversationId, /^c_[0-9a-f]{12}$/)
  assert.equal(claimed.hostId, 'h1')
  assert.equal(state.conversations.size, 1)
  assert.equal(state.conversations.get(claimed.conversationId).clients.has('inst-1'), true)
})

test('D1：待配对表里根本没有地方放 PSK（类型与运行时双重确认）', () => {
  const { state } = harness()
  state.issuePair('h1', '123456', 180_000)
  const entry = state.pendingPairs.get('123456')
  assert.deepEqual(Object.keys(entry).sort(), ['expiresAt', 'hostId', 'used'])
  assert.equal('psk' in entry, false)
})

test('配对码一次性：重放得到 already_used，而不是 invalid_or_expired', () => {
  const { state, advance } = harness()
  state.issuePair('h1', '123456', 180_000)
  assert.equal(state.claim('123456', 'inst-1').ok, true)
  const replay = state.claim('123456', 'inst-1')
  assert.equal(replay.ok, false)
  assert.equal(replay.reason, 'already_used')
  // used 条目留在表里直到 TTL 清扫——否则重放会被误报成"码不存在"，手机文案就错了（F6）。
  advance(180_001)
  const gone = state.claim('123456', 'inst-1')
  assert.equal(gone.reason, 'invalid_or_expired')
})

test('多配对码并存：每张码各自独立，用哪张得到哪个主机的会话（旧事故回归）', () => {
  const clock = { now: 1_000 }
  const state = new RelayState({ now: () => clock.now })
  const hostA = new FakeSock('A')
  const hostB = new FakeSock('B')
  const clientA = new FakeSock('cA')
  const clientB = new FakeSock('cB')
  state.attachHost('hA', hostA, 'A')
  state.attachHost('hB', hostB, 'B')
  state.attachClient('iA', clientA)
  state.attachClient('iB', clientB)
  state.issuePair('hA', '111111', 180_000)
  state.issuePair('hB', '222222', 180_000)
  const first = state.claim('111111', 'iA')
  const second = state.claim('222222', 'iB')
  assert.equal(first.hostId, 'hA')
  assert.equal(second.hostId, 'hB')
  assert.equal(state.conversations.get(first.conversationId).hostId, 'hA')
  assert.equal(state.conversations.get(second.conversationId).hostId, 'hB')
})

test('配对的前置拒绝：码不存在 / 已过期 / 主机不在线', () => {
  const { state, advance } = harness()
  assert.equal(state.claim('999999', 'inst-1').reason, 'invalid_or_expired')
  state.issuePair('h1', '123456', 1_000)
  advance(2_000)
  assert.equal(state.claim('123456', 'inst-1').reason, 'invalid_or_expired')
  const h = harness()
  h.state.issuePair('h1', '123456', 180_000)
  h.host.readyState = CLOSED
  assert.equal(h.state.claim('123456', 'inst-1').reason, 'host_offline')
})

test('待配对表有界：超出上限拒绝新码，但已存在的码允许覆盖', () => {
  const { state } = harness({ maxPendingPairs: 3 })
  assert.equal(state.issuePair('h1', '111111', 1000).ok, true)
  assert.equal(state.issuePair('h1', '222222', 1000).ok, true)
  assert.equal(state.issuePair('h1', '333333', 1000).ok, true)
  const overflow = state.issuePair('h1', '444444', 1000)
  assert.equal(overflow.ok, false)
  assert.equal(overflow.full, true)
  const replace = state.issuePair('h1', '222222', 9000)
  assert.equal(replace.ok, true)
  assert.equal(replace.replaced, true)
  assert.equal(state.pendingPairs.get('222222').expiresAt, 1_000 + 9_000)
})

test('D3：客户端断开不删会话、不删成员；同一 clientId 重连后原会话直接可用', () => {
  const { state, host, client } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')
  assert.equal(state.routeFrom(conversationId, client), null)

  const notices = state.clientGone('inst-1', client)
  assert.deepEqual(notices, [{ conversationId, clientId: 'inst-1' }])
  // 旧实现在这里删会话；本版必须留着它，并且**成员关系也留着**，
  // 否则 D4 会把重连回来的合法客户端永远拒掉。
  assert.equal(state.conversations.size, 1)
  assert.equal(state.conversations.get(conversationId).clients.has('inst-1'), true)
  // 状态层只给清单，不发帧：通知谁、用什么帧是 server.ts 的事（在 relay.test.mjs 里验）。
  assert.deepEqual(host.sent, [], '状态机不直接写 socket')

  const reborn = new FakeSock('client-2')
  state.attachClient('inst-1', reborn)
  assert.equal(state.routeFrom(conversationId, reborn), null, '重连后必须重新成为可路由成员')
  const sent = state.clientSockets(conversationId)
  assert.deepEqual(sent, [reborn])
})

test('D3 竞态：同一 clientId 已有更新 socket 时，旧 socket 的 close 什么都不许做', () => {
  const { state } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')
  const newer = new FakeSock('newer')
  state.attachClient('inst-1', newer)
  const stale = new FakeSock('stale')
  assert.deepEqual(state.clientGone('inst-1', stale), [], '旧 socket 的 close 不得产生任何通知')
  assert.equal(state.clients.get('inst-1').ws, newer)
  assert.equal(state.routeFrom(conversationId, newer), null)
})

test('D4：转发前校验发送方是该会话成员，陌生 socket 与不存在的会话分别报不同 code', () => {
  const { state, client } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')
  const stranger = new FakeSock('stranger')
  assert.equal(state.routeFrom(conversationId, stranger), 'not_member')
  assert.equal(state.routeFrom('c_000000000000', client), 'unknown_session')
  assert.equal(state.routeFrom(conversationId, client), null)
  const host = state.hosts.get('h1').ws
  assert.equal(state.routeFrom(conversationId, host), null)
})

test('D6：主机断开先进宽限期，超时才判死；期间主机回来则一切照旧', () => {
  const { state, host, client, advance } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')

  assert.equal(state.hostGone('h1', host), true)
  assert.equal(state.conversations.size, 1, '宽限期内会话必须还在')
  assert.deepEqual(state.expireOfflineHosts(120_000), [], '没到宽限期不得通知客户端')

  advance(119_000)
  assert.deepEqual(state.expireOfflineHosts(120_000), [])
  advance(2_000)
  const dropped = state.expireOfflineHosts(120_000)
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].conversationId, conversationId)
  assert.deepEqual(dropped[0].clientIds, ['inst-1'])
  assert.equal(state.conversations.size, 0)

  // 回来得早：重新 attach 即撤销离线标记。
  const h2 = harness()
  h2.state.issuePair('h1', '654321', 180_000)
  h2.state.claim('654321', 'inst-1')
  h2.state.hostGone('h1', h2.host)
  const freshHost = new FakeSock('host-again')
  h2.state.attachHost('h1', freshHost, 'my-macbook')
  h2.advance(999_000)
  assert.deepEqual(h2.state.expireOfflineHosts(120_000), [], '重连成功后不得再被判死')
  void client
})

test('D6 竞态：主机重连后，旧 socket 的 close 不得把会话打成离线', () => {
  const { state, host } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')
  const newer = new FakeSock('host-new')
  const { replaced } = state.attachHost('h1', newer, 'my-macbook')
  assert.equal(replaced, host)
  assert.equal(state.hostGone('h1', host), false, '旧 socket 的 close 必须被守卫跳过')
  assert.equal(state.conversations.get(conversationId).hostOfflineSince, undefined)
})

test('会话空闲回收：touch 会续期，超时才丢；丢之后不需要通知任何人', () => {
  const { state, client, advance } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')
  state.nextHostSequence(conversationId)
  const ttl = 7 * 24 * 3600 * 1000
  assert.deepEqual(state.sweepIdle(ttl), [])
  advance(ttl)
  assert.deepEqual(state.sweepIdle(ttl), [conversationId])
  assert.equal(state.conversations.size, 0)
  // 客户端下次用旧 convId 发帧 → routeFrom 给出 unknown_session → 手机提示重配对（F5）。
  assert.equal(state.routeFrom(conversationId, client), 'unknown_session')
})

test('session-leave 只摘自己；不存在的成员返回 false', () => {
  const { state } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')
  assert.equal(state.leave('inst-1', conversationId), true)
  assert.equal(state.conversations.get(conversationId).clients.size, 0)
  assert.equal(state.conversations.size, 1, '客户端离开不该删掉主机的会话')
  assert.equal(state.leave('nobody', conversationId), false)
  assert.equal(state.leave('inst-1', 'c_ffffffffffff'), false)
})

test('过期配对码被清扫；used 与新发都算完', () => {
  const { state, advance } = harness()
  state.issuePair('h1', '111111', 1_000)
  state.issuePair('h1', '222222', 1_000)
  state.claim('111111', 'inst-1')
  advance(1_500)
  assert.deepEqual(state.expirePairs().sort(), ['111111', '222222'])
  assert.equal(state.pendingPairs.size, 0)
})

test('counts 与 reset 服务于 /healthz 与测试隔离', () => {
  const { state } = harness()
  state.issuePair('h1', '123456', 180_000)
  state.claim('123456', 'inst-1')
  assert.deepEqual(state.counts(), { hosts: 1, clients: 1, conversations: 1, pendingPairs: 1 })
  state.reset()
  assert.deepEqual(state.counts(), { hosts: 0, clients: 0, conversations: 0, pendingPairs: 0 })
})

// ── 重配（复核 🟡7）────────────────────────────────────────────────────

test('重配：同一 clientId 认领新码时，必须从旧会话的成员表里摘掉', () => {
  const { state } = harness()
  state.issuePair('h1', '111111', 180_000)
  const first = state.claim('111111', 'inst-1')
  assert.equal(first.ok, true)

  state.issuePair('h1', '222222', 180_000)
  const second = state.claim('222222', 'inst-1')
  assert.equal(second.ok, true)
  assert.notEqual(second.conversationId, first.conversationId, '每次认领都是一个新会话')
  assert.deepEqual(second.detached, [first.conversationId], '必须报告摘掉了哪个旧会话（调用方要通知主机）')

  assert.equal(
    state.conversations.get(first.conversationId).clients.has('inst-1'),
    false,
    '摘不干净的话，主机在旧会话上的流会把密文继续灌给这台已经换了钥匙的手机',
  )
  assert.equal(state.conversations.get(second.conversationId).clients.has('inst-1'), true)
  assert.equal(
    state.conversations.has(first.conversationId),
    true,
    '旧会话保留：它归主机（与客户端 session-leave 同一条原则），不该由中继删',
  )
})

test('leaveAll：一个 clientId 只会留在最后一次认领的会话里', () => {
  const { state } = harness()
  state.issuePair('h1', '111111', 180_000)
  const a = state.claim('111111', 'inst-1')
  state.issuePair('h1', '222222', 180_000)
  const b = state.claim('222222', 'inst-1')
  assert.equal(state.conversations.get(a.conversationId).clients.has('inst-1'), false)
  assert.deepEqual(state.leaveAll('inst-1'), [b.conversationId], '最后一个会话同样要能被摘掉')
  assert.equal(state.conversations.get(b.conversationId).clients.size, 0)
  assert.deepEqual(state.leaveAll('不存在的客户端'), [], '不认识的 clientId 不许抛')
})
