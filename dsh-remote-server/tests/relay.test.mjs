/**
 * 中继的 socket 级集成测试：真的起一个中继、真的连 socket、真的走一遍
 * 注册 → 配对 → 转发 → 断开。状态机的分支在 `state.test.mjs` 里已穷举，
 * 这里验的是"帧进出与协议契约一致"这一层。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'
import { createRelay } from '../dist/src/server.js'
import { loadConfig } from '../dist/src/config.js'

/** 一眼假的 token；测试里绝不用真实凭据。 */
const TOKEN = 'unit-test-host-token-0123456789abcdef'
const CIPHER = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

async function startRelay(overrides = {}) {
  const env = {
    ...process.env,
    DRC_HOST_TOKEN: TOKEN,
    DRC_PORT: '0',
    DRC_BIND: '127.0.0.1',
    DRC_LOG_LEVEL: 'silent',
    DRC_PAIR_TTL_MS: '30000',
    DRC_HOST_GRACE_MS: '250',
    DRC_MAX_FRAMES_PER_SEC: '500',
    ...overrides,
  }
  const { config, problems } = loadConfig(env, 'test')
  assert.equal(problems.filter((p) => p.level === 'error').length, 0, '测试配置不合法')
  const relay = createRelay(config)
  const { port } = await relay.startListening()
  const ctx = { relay, port, url: `ws://127.0.0.1:${port}`, open: [] }
  ctx.close = async () => {
    for (const peer of ctx.open) peer.ws.terminate()
    await relay.close()
  }
  return ctx
}

class Peer {
  constructor(ws) {
    this.ws = ws
    this.frames = []
    this.waiters = []
    this.closeCode = null
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.closeCode = { code, reason: reason.toString() }
        resolve(this.closeCode)
      })
    })
    ws.on('message', (raw) => {
      let frame = null
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        frame = { t: '__invalid_json_text__', raw: raw.toString().slice(0, 40) }
      }
      this.frames.push(frame)
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(frame)
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    const peer = new Peer(ws)
    await new Promise((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })
    return peer
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame))
  }

  rawText(text) {
    this.ws.send(text)
  }

  rawBinary(buffer) {
    this.ws.send(Buffer.from(buffer))
  }

  /** 下一条到达的帧（不匹配就继续等）。 */
  next(timeoutMs = 2000) {
    if (this.frames.length > this.cursor) {
      const frame = this.frames[this.cursor++]
      return Promise.resolve(frame)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error(`等帧超时；已收到 ${JSON.stringify(this.frames).slice(0, 400)}`))
      }, timeoutMs)
      this.waiters.push({
        resolve: (frame) => {
          this.cursor += 1
          clearTimeout(timer)
          resolve(frame)
        },
        timer,
      })
    })
  }

  /** 等到某一类帧出现（可以在后面，也可能已经收到）。 */
  async until(match, timeoutMs = 2000) {
    const seen = this.frames.find(match)
    if (seen) return seen
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const frame = await this.next(Math.max(50, deadline - Date.now()))
      if (match(frame)) return frame
    }
    throw new Error(`没等到匹配的帧；已收到 ${JSON.stringify(this.frames).slice(0, 400)}`)
  }

  /** 反向断言：一段时间内**不许**出现匹配的帧（D3/D6 的核心判据）。 */
  async expectNone(match, ms = 400) {
    const at = Date.now()
    while (Date.now() - at < ms) {
      const hit = this.frames.find(match)
      if (hit) throw new Error(`不该出现的帧出现了：${JSON.stringify(hit)}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(true)
  }

  cursor = 0

  has(match) {
    return this.frames.some(match)
  }
}

async function pairUp(ctx, { hostLabel = 'bins', clientId = 'inst-1', token = '123456' } = {}) {
  const host = await Peer.connect(ctx.url)
  host.send({ t: 'hello', role: 'host', protocol: 1, token: TOKEN, label: hostLabel })
  const hostOk = await host.until((f) => f.t === 'hello-ok')
  assert.equal(hostOk.role, 'host')
  host.send({ t: 'pair-begin', pairingToken: token })
  const ready = await host.until((f) => f.t === 'pair-ready')
  assert.equal(ready.ttlMs, Number(process.env.DRC_PAIR_TTL_MS ?? 30000) || ready.ttlMs)

  const client = await Peer.connect(ctx.url)
  client.send({
    t: 'hello',
    role: 'client',
    protocol: 1,
    clientId,
    clientMeta: { platform: 'wechat-mp', label: '微信小程序' },
  })
  const clientOk = await client.until((f) => f.t === 'hello-ok')
  assert.equal(clientOk.clientId, clientId, '客户端自带的 clientId 必须原样保留')
  client.send({ t: 'pair-begin-client', pairingToken: token })
  const paired = await client.until((f) => f.t === 'paired')
  const joined = await host.until((f) => f.t === 'peer-joined')
  ctx.open.push(host, client)
  return { host, client, hostId: hostOk.hostId, conversationId: paired.sessionId, joined }
}

test('注册：客户端 hello 得到 hello-ok，且 relay 原样保留它带来的 clientId', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({
      t: 'hello',
      role: 'client',
      protocol: 1,
      clientId: 'mdwx-abc',
      clientMeta: { platform: 'wechat-mp' },
    })
    const ok = await client.until((f) => f.t === 'hello-ok')
    assert.deepEqual({ role: ok.role, clientId: ok.clientId }, { role: 'client', clientId: 'mdwx-abc' })
    assert.equal(ctx.relay.state.clients.get('mdwx-abc').meta.platform, 'wechat-mp')
  } finally {
    await ctx.close()
  }
})

test('注册：不带 clientId 时中继代发一个（客户端会采纳并沿用）', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', protocol: 1 })
    const ok = await client.until((f) => f.t === 'hello-ok')
    assert.ok(ok.clientId && ok.clientId.length > 0)
    assert.equal(ctx.relay.state.clients.has(ok.clientId), true)
  } finally {
    await ctx.close()
  }
})

test('鉴权：错 token 被拒并在用尽次数后断开 4001', async () => {
  const ctx = await startRelay({ DRC_HOST_AUTH_MAX_ATTEMPTS: '3' })
  try {
    const host = await Peer.connect(ctx.url)
    ctx.open.push(host)
    host.send({ t: 'hello', role: 'host', token: 'wrong-token-value-here-000000' })
    for (let i = 0; i < 3; i++) {
      host.send({ t: 'hello', role: 'host', token: 'wrong-token-value-here-00000' + i })
      const err = await host.until((f) => f.t === 'error' && f.code === 'bad_token')
      assert.ok(err)
    }
    const closed = await host.closed
    assert.equal(closed.code, 4001)
    assert.equal(ctx.relay.state.hosts.size, 0)
  } finally {
    await ctx.close()
  }
})

test('配对全流程：pair-ready 带权威 ttlMs，paired 带 sessionId，主机收到带 pairingToken 的 peer-joined', async () => {
  const ctx = await startRelay()
  try {
    const { conversationId, joined, hostId } = await pairUp(ctx)
    assert.match(conversationId, /^c_[0-9a-f]{12}$/)
    assert.equal(joined.sessionId, conversationId)
    assert.equal(joined.pairingToken, '123456', '主机必须按码取自己那份 PSK（旧事故）')
    assert.equal(joined.clientId, 'inst-1')
    assert.equal(ctx.relay.state.conversations.size, 1)
    assert.equal(ctx.relay.state.conversations.get(conversationId).hostId, hostId)
  } finally {
    await ctx.close()
  }
})

test('配对前置：pair-begin 只能由主机发，认领只能由客户端发', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'pair-begin-client', pairingToken: '123456' })
    assert.equal((await client.until((f) => f.t === 'error')).code, 'need_client')

    const anon = await Peer.connect(ctx.url)
    ctx.open.push(anon)
    anon.send({ t: 'hello', role: 'client', clientId: 'i2' })
    await anon.until((f) => f.t === 'hello-ok')
    anon.send({ t: 'pair-begin', pairingToken: '123456' })
    assert.ok(await anon.until((f) => f.t === 'error' && f.code === 'need_host'))
  } finally {
    await ctx.close()
  }
})

test('配对码：未知码 invalid_or_expired，重放 already_used（两个 reason 在理论文不同）', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', clientId: 'i3' })
    await client.until((f) => f.t === 'hello-ok')
    client.send({ t: 'pair-begin-client', pairingToken: '999999' })
    assert.equal((await client.until((f) => f.t === 'pair-fail')).reason, 'invalid_or_expired')

    const first = await pairUp(ctx, { clientId: 'i4', token: '456789' })
    first.client.send({ t: 'pair-begin-client', pairingToken: '456789' })
    assert.equal(
      (await first.client.until((f) => f.t === 'pair-fail' && f.reason === 'already_used')).reason,
      'already_used',
    )
  } finally {
    await ctx.close()
  }
})

test('下行转发：中继给 host→client 的帧编号，且密文原样搬运', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    const one = await client.until((f) => f.t === 'enc')
    assert.equal(one.sessionId, conversationId)
    assert.equal(one.ciphertext, CIPHER)
    assert.equal(one.seq, 1)
    const two = await client.next()
    assert.equal(two.seq, 2)
    assert.equal(two.ciphertext, CIPHER)
  } finally {
    await ctx.close()
  }
})

test('上行转发：客户端的 seq 原样透传，并补上是谁发的', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    client.send({ t: 'enc', sessionId: conversationId, seq: 41, clientId: 'inst-1', ciphertext: CIPHER })
    const got = await host.until((f) => f.t === 'enc')
    assert.equal(got.seq, 41, '上行 seq 是元数据，中继不改写')
    assert.equal(got.clientId, 'inst-1')
    assert.equal(got.ciphertext, CIPHER)
  } finally {
    await ctx.close()
  }
})

test('D3：客户端断开重连后，同一会话继续可路由，主机不会收到 unknown_session', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    client.ws.terminate()
    const left = await host.until((f) => f.t === 'peer-left')
    assert.equal(left.sessionId, conversationId)
    assert.equal(left.clientId, 'inst-1')
    // 会话必须还在（旧实现在这里删掉它，于是重连必然失败）。
    assert.equal(ctx.relay.state.conversations.has(conversationId), true)

    const again = await Peer.connect(ctx.url)
    ctx.open.push(again)
    again.send({ t: 'hello', role: 'client', clientId: 'inst-1' })
    await again.until((f) => f.t === 'hello-ok')
    // 续用的判据是客户端一侧：它用原 convId 发指令，必须能直达主机。
    again.send({ t: 'enc', sessionId: conversationId, seq: 1, clientId: 'inst-1', ciphertext: CIPHER })
    const arrived = await host.until((f) => f.t === 'enc' && f.clientId === 'inst-1')
    assert.equal(arrived.sessionId, conversationId)
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await again.until((f) => f.t === 'enc')).sessionId, conversationId, '下行也必须重新挂得上')
  } finally {
    await ctx.close()
  }
})

test('D6：主机短暂掉线不通知客户端；超过宽限期才发 peer-left', async () => {
  const ctx = await startRelay({ DRC_HOST_GRACE_MS: '300', DRC_SWEEP_MS: '60' })
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    host.ws.terminate()
    await client.expectNone((f) => f.t === 'peer-left', 120)
    const gone = await client.until((f) => f.t === 'peer-left', 1500)
    assert.equal(gone.sessionId, conversationId)
    assert.match(gone.clientId, /^[0-9a-f]{8}$/, 'peer-left 的 clientId 位置填的是主机 id')
    assert.equal(ctx.relay.state.conversations.has(conversationId), false)
  } finally {
    await ctx.close()
  }
})

test('宽限期判死主机：每个成员恰好收到一条 peer-left（曾经是 N² 条）', async () => {
  const ctx = await startRelay({ DRC_HOST_GRACE_MS: '200', DRC_SWEEP_MS: '50' })
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    // 中继当前一条会话只放一个客户端（认领是一次性的），所以第二台设备是"将来可能出现的
    // 形状"。直接往状态表里放进这个成员——本用例要验的是**通知条数**这条不变量，
    // 而不是认领流程（那条路在 D4 与配对用例里）。
    const second = await Peer.connect(ctx.url)
    second.send({ t: 'hello', role: 'client', protocol: 1, clientId: 'inst-2' })
    await second.until((f) => f.t === 'hello-ok')
    ctx.open.push(second)
    ctx.relay.state.conversations.get(conversationId).clients.add('inst-2')

    host.ws.terminate()
    await client.until((f) => f.t === 'peer-left', 1500)
    await second.until((f) => f.t === 'peer-left', 1500)

    // 再等几拍。旧实现把外层内层写成同一个 clientIds，每个成员会拿到 2 条：这里必须仍是 1。
    await sleep(180)
    const count = (peer) => peer.frames.filter((f) => f.t === 'peer-left').length
    assert.equal(count(client), 1, '第一个成员收到了重复的 peer-left')
    assert.equal(count(second), 1, '第二个成员收到了重复的 peer-left')
    assert.equal(ctx.relay.state.conversations.has(conversationId), false)
  } finally {
    await ctx.close()
  }
})

test('D4：注册过但不属于该会话的客户端拿到 unknown_session（有恢复出口，复核 R2）', async () => {
  const ctx = await startRelay()
  try {
    const { conversationId } = await pairUp(ctx)
    const stranger = await Peer.connect(ctx.url)
    ctx.open.push(stranger)
    stranger.send({ t: 'hello', role: 'client', clientId: 'intruder' })
    await stranger.until((f) => f.t === 'hello-ok')
    stranger.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    const err = await stranger.until((f) => f.t === 'error')
    // 不是 not_member：小程序对 not_member 只会弹一句英文 toast，
    // 而 unknown_session 会中文提示"会话已失效，请重新配对"——被拒的一方必须有出口。
    assert.equal(err.code, 'unknown_session')
    assert.equal(ctx.relay.state.conversations.has(conversationId), true, '拒绝一帧不该顺手删会话')
  } finally {
    await ctx.close()
  }
})

test('D4：从未注册的 socket 灌密文得到 not_member（它没有可恢复的配对）', async () => {
  const ctx = await startRelay()
  try {
    const { conversationId } = await pairUp(ctx)
    const blind = await Peer.connect(ctx.url)
    ctx.open.push(blind)
    blind.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await blind.until((f) => f.t === 'error')).code, 'not_member')
    assert.equal(ctx.relay.state.conversations.has(conversationId), true)
  } finally {
    await ctx.close()
  }
})

test('复核 R3：同一 clientId 的后来者顶掉前者，前者收到 4000 才会重连', async () => {
  const ctx = await startRelay()
  try {
    const { conversationId, host } = await pairUp(ctx)
    const newer = await Peer.connect(ctx.url)
    ctx.open.push(newer)
    newer.send({ t: 'hello', role: 'client', clientId: 'inst-1' })
    await newer.until((f) => f.t === 'hello-ok')
    const verdict = await ctx.open[1].closed
    assert.equal(verdict.code, 4000, '前者必须被明确关掉，否则它的 socket 还"开着"、永不重连')
    // 顶号之后新 socket 是合法成员，下行仍可路由。
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await newer.until((f) => f.t === 'enc')).sessionId, conversationId)
  } finally {
    await ctx.close()
  }
})

test('复核 R1：主机重启后 resync 未列出的会话被回收，客户端下次发帧撞上 unknown_session', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId, hostId } = await pairUp(ctx)
    // 模拟"主机进程重启"：新 socket、同一个 hostId、手里没有任何会话密钥。
    const reborn = await Peer.connect(ctx.url)
    ctx.open.push(reborn)
    reborn.send({ t: 'hello', role: 'host', protocol: 1, token: TOKEN, hostId })
    await reborn.until((f) => f.t === 'hello-ok')
    reborn.send({ t: 'resync', sessionIds: [] })
    await sleep(80)
    assert.equal(ctx.relay.state.conversations.has(conversationId), false, 'resync 没列出的会话必须删掉')
    // 关键判据：客户端不是被 peer-left 弹一句英文，而是撞 unknown_session 拿到中文提示。
    client.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await client.until((f) => f.t === 'error')).code, 'unknown_session')
    assert.ok(!client.has((f) => f.t === 'peer-left'), 'resync 不该向客户端广播 peer-left')
    void host
  } finally {
    await ctx.close()
  }
})

test('未知会话：enc 得到 unknown_session（手机端据此提示重新配对）', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', clientId: 'lonely' })
    await client.until((f) => f.t === 'hello-ok')
    client.send({ t: 'enc', sessionId: 'c_deadbeefdead', ciphertext: CIPHER })
    assert.equal((await client.until((f) => f.t === 'error')).code, 'unknown_session')
  } finally {
    await ctx.close()
  }
})

test('主机在宽限期外、会话还在但主机不接时，客户端收到的是 host_unavailable 而不是 unknown_session', async () => {
  const ctx = await startRelay({ DRC_HOST_GRACE_MS: '60000' })
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    host.ws.terminate()
    client.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    const err = await client.until((f) => f.t === 'error')
    assert.equal(err.code, 'host_unavailable')
    assert.notEqual(err.code, 'unknown_session', '把"暂时没人接"报成"会话没了"会白白丢掉配对')
  } finally {
    await ctx.close()
  }
})

test('批量帧：enc-batch 下行保持条目顺序与密文原样', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    host.send({
      t: 'enc-batch',
      sessionId: conversationId,
      items: [{ ciphertext: CIPHER }, { ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', seq: 9 }],
    })
    const batch = await client.until((f) => f.t === 'enc-batch')
    assert.equal(batch.sessionId, conversationId)
    assert.equal(batch.items.length, 2)
    assert.equal(batch.items[0].ciphertext, CIPHER)
    assert.equal(batch.items[1].ciphertext, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  } finally {
    await ctx.close()
  }
})

test('畸形输入一律被拒而不崩：非法 JSON、二进制帧、坏 base64、未知帧名、缺字段', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', clientId: 'junk' })
    await client.until((f) => f.t === 'hello-ok')

    client.rawText('{not json')
    assert.equal((await client.until((f) => f.t === 'error' && f.code === 'bad_json')).code, 'bad_json')

    client.rawBinary([1, 2, 3, 4])
    assert.equal((await client.until((f) => f.t === 'error' && f.code === 'bad_frame')).code, 'bad_frame')

    client.send({ t: 'heartbeat' })
    assert.equal((await client.until((f) => f.t === 'error' && f.code === 'unknown_frame')).code, 'unknown_frame')

    client.send({ t: 'enc', sessionId: 'c_000000000000' })
    assert.equal(
      (await client.until((f) => f.t === 'error' && f.code === 'unknown_frame')).code,
      'unknown_frame',
      '缺 ciphertext 的形状不合法',
    )

    client.send({ t: 'enc', sessionId: 'c_000000000000', ciphertext: '%%%not base64%%%' })
    assert.equal((await client.until((f) => f.t === 'error' && f.code === 'bad_frame')).code, 'bad_frame')

    assert.equal(ctx.relay.health().ok, true, '一堆坏帧之后进程仍然健康')
  } finally {
    await ctx.close()
  }
})

test('session-leave：客户端主动退出只摘自己，主机收到 peer-left，会话仍在', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    client.send({ t: 'session-leave', sessionId: conversationId })
    const left = await host.until((f) => f.t === 'peer-left')
    assert.equal(left.sessionId, conversationId)
    assert.equal(ctx.relay.state.conversations.get(conversationId).clients.size, 0)
    assert.equal(ctx.relay.state.conversations.has(conversationId), true)
  } finally {
    await ctx.close()
  }
})

test('ping/pong 原样回带 ts；两个客户端互不干扰', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx, { clientId: 'a' })
    const other = await Peer.connect(ctx.url)
    ctx.open.push(other)
    other.send({ t: 'hello', role: 'client', clientId: 'b' })
    await other.until((f) => f.t === 'hello-ok')
    other.send({ t: 'pair-begin-client', pairingToken: 'nope-nope' })
    assert.equal((await other.until((f) => f.t === 'pair-fail')).reason, 'invalid_or_expired')

    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await client.until((f) => f.t === 'enc')).sessionId, conversationId)
    await other.expectNone((f) => f.t === 'enc', 150)

    other.send({ t: 'ping', ts: 12345 })
    const pong = await other.until((f) => f.t === 'pong')
    assert.equal(pong.ts, 12345)
  } finally {
    await ctx.close()
  }
})

test('/healthz 与 /api/info 的形状是测试与运维的依赖（T7）', async () => {
  const ctx = await startRelay({ DRC_PUBLIC_URL: 'wss://drc.example.com' })
  try {
    await pairUp(ctx)
    const health = await fetch(`http://127.0.0.1:${ctx.port}/healthz`).then((r) => r.json())
    assert.equal(health.ok, true)
    assert.equal(health.hosts, 1)
    assert.equal(health.clients, 1)
    assert.equal(health.conversations, 1)
    assert.equal(health.pendingPairs, 1, '用过的码在 TTL 内仍留在表里（为了 already_used）')
    assert.equal(health.shuttingDown, false)
    assert.equal(typeof health.uptimeSec, 'number')
    assert.equal(typeof health.version, 'string')

    const info = await fetch(`http://127.0.0.1:${ctx.port}/api/info`).then((r) => r.json())
    assert.deepEqual(info, { publicUrl: 'wss://drc.example.com', protocol: 1 })

    const missing = await fetch(`http://127.0.0.1:${ctx.port}/nope`)
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), { error: 'not_found' })
  } finally {
    await ctx.close()
  }
})

test('/api/pair-status 默认 404：不给 6 位码留免认证的判定 oracle', async () => {
  const ctx = await startRelay()
  try {
    const response = await fetch(`http://127.0.0.1:${ctx.port}/api/pair-status?token=123456`)
    assert.equal(response.status, 404)
    const enabled = await startRelay({ DRC_PAIR_STATUS: '1' })
    try {
      await pairUp(enabled, { token: '246810' })
      const used = await enabled.relay.state.pendingPairs.get('246810')
      assert.equal(used.used, true)
      const body = await fetch(`http://127.0.0.1:${enabled.port}/api/pair-status?token=246810`).then((r) => r.json())
      assert.equal(body.ok, false)
    } finally {
      await enabled.close()
    }
  } finally {
    await ctx.close()
  }
})

// ── 复核 R7 要求补齐的机械防线（原来"只有文档没有测试"的那几条）────────

test('F1：未知的帧名不会改动任何状态（新帧名必须落进 default）', async () => {
  const ctx = await startRelay()
  try {
    const { client, conversationId } = await pairUp(ctx)
    const before = ctx.relay.health()
    for (const name of ['keepalive', 'subscribe', 'auth', 'session-list', 'peer-left', 'paired']) {
      client.send({ t: name, sessionId: conversationId })
      await client.until((f) => f.t === 'error')
    }
    // 关键：借用过的帧名（peer-left / paired）不许触发状态机
    const after = ctx.relay.health()
    assert.deepEqual(
      { hosts: after.hosts, clients: after.clients, conversations: after.conversations },
      { hosts: before.hosts, clients: before.clients, conversations: before.conversations },
    )
    assert.equal(ctx.relay.state.conversations.has(conversationId), true)
  } finally {
    await ctx.close()
  }
})

test('F4：每一条 hello 都必有一个 hello-ok（错 role 也要有回应）', async () => {
  const ctx = await startRelay()
  try {
    for (const hello of [
      { t: 'hello', role: 'client', clientId: 'a1' },
      { t: 'hello', role: 'weird' },
      { t: 'hello' },
    ]) {
      const peer = await Peer.connect(ctx.url)
      ctx.open.push(peer)
      peer.send(hello)
      const reply = await peer.next()
      assert.ok(['hello-ok', 'error'].includes(reply.t), `${hello.role ?? '无 role'} 必须有明确回应`)
      if (hello.role === 'client') assert.equal(reply.t, 'hello-ok')
      else assert.equal(reply.t, 'error')
    }
  } finally {
    await ctx.close()
  }
})

test('F3：出站帧里的 sessionId 与配对时下发的逐字一致，不做任何加工', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    const paired = client.frames.find((f) => f.t === 'paired')
    assert.equal(paired.sessionId, conversationId)
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    const down = await client.until((f) => f.t === 'enc')
    assert.equal(down.sessionId, conversationId)
    assert.equal(typeof down.sessionId, 'string')
    // 上行同理：主机收到的 sessionId 必须是通道 id，而不是被换成 DSH 会话 id（F3 的事故面）
    client.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER, clientId: 'inst-1' })
    const up = await host.until((f) => f.t === 'enc')
    assert.equal(up.sessionId, conversationId)
  } finally {
    await ctx.close()
  }
})

test('T3：下行顺序与主机发出顺序一致，且帧数不膨胀', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    const marker = client.frames.length
    for (let i = 0; i < 12; i++) {
      host.send({
        t: 'enc',
        sessionId: conversationId,
        ciphertext: Buffer.from(`片段-${i}`, 'utf8').toString('base64'),
      })
    }
    await client.until(() => client.frames.length >= marker + 12)
    const downs = client.frames.slice(marker).filter((f) => f.t === 'enc')
    assert.equal(downs.length, 12, '既不能丢也不能重')
    for (let i = 0; i < 12; i++) {
      assert.equal(Buffer.from(downs[i].ciphertext, 'base64').toString('utf8'), `片段-${i}`)
      assert.equal(downs[i].seq, i + 1, 'seq 必须由中继连续编号')
    }
  } finally {
    await ctx.close()
  }
})

test('T6：根路径与任意自定义路径都能 upgrade（老地址不能连不上）', async () => {
  const ctx = await startRelay()
  try {
    for (const path of ['/', '/ws', '/drc', '/a/b/c']) {
      const peer = await Peer.connect(ctx.url + path)
      ctx.open.push(peer)
      peer.send({ t: 'hello', role: 'client', clientId: `p-${path}` })
      assert.equal((await peer.until((f) => f.t === 'hello-ok')).role, 'client', path)
    }
  } finally {
    await ctx.close()
  }
})

test('R2：发给手机的 error 一律带中文 message（英文 code 不可能是用户看到的全部）', async () => {
  const ctx = await startRelay()
  try {
    const { conversationId } = await pairUp(ctx)
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', clientId: 'reader' })
    await client.until((f) => f.t === 'hello-ok')
    client.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    const err = await client.until((f) => f.t === 'error')
    assert.equal(err.code, 'unknown_session')
    assert.match(err.message, /配对|会话/, `客户端侧的中文提示缺失：${JSON.stringify(err)}`)

    client.send({ t: 'heartbeat' })
    const second = await client.until((f) => f.t === 'error' && f.code === 'unknown_frame')
    assert.ok(second.message, 'unknown_frame 也要带可读文案')
  } finally {
    await ctx.close()
  }
})

test('R1：主机主动作废会话时，它的客户端收到 peer-left 而不是继续对着没钥匙的对端发密文', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    host.send({ t: 'session-leave', sessionId: conversationId })
    const left = await client.until((f) => f.t === 'peer-left')
    assert.equal(left.sessionId, conversationId)
    assert.equal(ctx.relay.state.conversations.has(conversationId), false)
    // 客户端此后拿旧 convId 发帧：既有 peer-left 的即时提示，也有兜底的 unknown_session
    client.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await client.until((f) => f.t === 'error')).code, 'unknown_session')
  } finally {
    await ctx.close()
  }
})

test('R1 边界：客户端发的 session-leave 只摘自己，不得把主机侧会话删掉（与主机发起的那条相对）', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    client.send({ t: 'session-leave', sessionId: conversationId })
    await host.until((f) => f.t === 'peer-left')
    assert.equal(ctx.relay.state.conversations.has(conversationId), true, '客户端离开不该删会话')
    void client
  } finally {
    await ctx.close()
  }
})

test('R3：被顶号的旧 socket 会重连并重新拿到身份（不靠人工干预）', async () => {
  const ctx = await startRelay()
  try {
    const { conversationId, host } = await pairUp(ctx)
    const first = ctx.open[1]
    const newer = await Peer.connect(ctx.url)
    ctx.open.push(newer)
    newer.send({ t: 'hello', role: 'client', clientId: 'inst-1' })
    await newer.until((f) => f.t === 'hello-ok')
    assert.equal((await first.closed).code, 4000)
    // 小程序的 socket 层在收到 close 后会自动重连；这里模拟它重连回来的那条连接
    const reconnected = await Peer.connect(ctx.url)
    ctx.open.push(reconnected)
    reconnected.send({ t: 'hello', role: 'client', clientId: 'inst-1' })
    await reconnected.until((f) => f.t === 'hello-ok')
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await reconnected.until((f) => f.t === 'enc')).sessionId, conversationId)
  } finally {
    await ctx.close()
  }
})

// ── 慢消费者（DESIGN-REVIEW 第 11 条 🟡）────────────────────────────────

/**
 * 把服务端这个 socket 的发送缓冲"钉"在超限状态。
 *
 * 为什么不真去堵 TCP：真堵法是 `client._socket.pause()`，但被暂停的 socket 读不了
 * ping，保活（两个扫掠周期就 terminate）会先于背压闸动手，于是测的不是背压闸。
 * 真机上的"慢消费者"恰恰是**还在应答、只是排不快**的那种，这个桩才是它的忠实替身。
 */
function pinBuffered(sock, bytes) {
  Object.defineProperty(sock, 'bufferedAmount', { get: () => bytes, configurable: true })
}

const closedWithin = (peer, ms) => Promise.race([peer.closed, sleep(ms).then(() => null)])

test('慢消费者：静默的对端同样会被定时扫描评估（判定不再挂在入站帧上）', async () => {
  const ctx = await startRelay({
    DRC_MAX_BUFFERED_BYTES: '4096',
    DRC_SWEEP_MS: '150',
    DRC_SLOW_CONSUMER_HOST_MS: '400',
  })
  try {
    const { host, conversationId } = await pairUp(ctx)
    const hostSock = ctx.relay.state.hostSocket(conversationId)
    assert.ok(hostSock, '主机 socket 必须能在 state 里取到')

    // 配对之后主机一个帧都不发：旧实现只挂在 ws.on('message') 上，永远不会评估它。
    pinBuffered(hostSock, 1_000_000)

    assert.equal(await closedWithin(host, 250), null, '未到窗口不许断（不是"超限即断"）')

    const closed = await closedWithin(host, 4_000)
    assert.ok(closed, '超限持续超过窗口后必须被断开；宿主静默 ⇒ 旧实现会永远不评估')
    assert.equal(closed.code, 1008)
    assert.equal(closed.reason, 'slow_consumer')
  } finally {
    await ctx.close()
  }
})

test('慢消费者：同样超限 1 秒，主机该断、客户端不该断（🟡11 的端到端回归点）', async () => {
  const ctx = await startRelay({
    DRC_MAX_BUFFERED_BYTES: '4096',
    DRC_SWEEP_MS: '150',
    DRC_SLOW_CONSUMER_HOST_MS: '300',
    // 客户端窗口远大于主机：这正是被修掉的那台"踢了就重连"的循环发动机
    DRC_SLOW_CONSUMER_CLIENT_MS: '3000',
  })
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    pinBuffered(ctx.relay.state.hostSocket(conversationId), 1_000_000)
    pinBuffered(ctx.relay.state.clients.get('inst-1').ws, 1_000_000)

    const hostClosed = await closedWithin(host, 3_000)
    assert.ok(hostClosed, '主机超限 ~0.3s 就该断（原有行为，不许被这次修复改掉）')
    assert.equal(hostClosed.code, 1008)

    await sleep(1_000)
    assert.equal(client.closeCode, null, '客户端超限 1 秒不许断：10s 这类短窗口正是把手机打进重连循环的原因')
  } finally {
    await ctx.close()
  }
})

test('重配：旧会话的密文不许再灌给已经重配的手机（🟡7）', async () => {
  // 与 CIPHER 只差首字符：同一个字符集、同一处填充，但字节不同。
  // 探针必须用**与正控不同的**密文——`expectNone` 会翻整段历史，
  // 用同一个密文就会命中正控那一帧，把"修好了"误判成"没修"。
  const CIPHER_PROBE = 'BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)

    // 正控：重配之前，旧会话这条通道本来就是活的
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await client.until((f) => f.t === 'enc')).ciphertext, CIPHER)

    // 同一台手机（同一 clientId、同一 socket）重配到新会话
    host.send({ t: 'pair-begin', pairingToken: '999888' })
    await host.until((f) => f.t === 'pair-ready')
    client.send({ t: 'pair-begin-client', pairingToken: '999888' })
    // `until` 会先翻已经收到过的帧，所以必须点名"换了一个会话"的那条 paired
    const paired = await client.until((f) => f.t === 'paired' && f.sessionId !== conversationId)
    const nextConv = paired.sessionId
    assert.notEqual(nextConv, conversationId)

    // 旧主机必须被告知这个观众走了：与"客户端显式 session-leave"同一条通知，
    // 否则主机以为还有人在看，会继续往这个会话里推。
    const left = await host.until((f) => f.t === 'peer-left' && f.sessionId === conversationId)
    assert.equal(left.clientId, 'inst-1')

    // 主机在旧会话上继续发：手机必须先被摘掉，一帧都不该到达
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER_PROBE })
    await client.expectNone((f) => f.t === 'enc' && f.ciphertext === CIPHER_PROBE, 500)

    // 新会话照常送达——上一条断言不是"整个通道死了"的假绿
    host.send({ t: 'enc', sessionId: nextConv, ciphertext: CIPHER_PROBE })
    assert.equal((await client.until((f) => f.t === 'enc' && f.ciphertext === CIPHER_PROBE)).sessionId, nextConv)
  } finally {
    await ctx.close()
  }
})

test('/healthz 诊断计数：丢弃帧 / 慢消费者 / 被拒配对 都有出口（A8）', async () => {
  const ctx = await startRelay({
    DRC_MAX_BUFFERED_BYTES: '4096',
    DRC_SWEEP_MS: '150',
    DRC_SLOW_CONSUMER_HOST_MS: '400',
  })
  try {
    const healthOf = () => fetch(`http://127.0.0.1:${ctx.port}/healthz`).then((r) => r.json())
    const counters = async () => {
      const h = await healthOf()
      return { dropped: h.droppedFrames, slow: h.slowConsumers, rejected: h.rejectedPairs }
    }

    // 起点必须归零，否则后面的"增量"断言是假的。
    assert.deepEqual(await counters(), { dropped: 0, slow: 0, rejected: 0 }, '刚起来时三个计数都必须是 0')

    // ① 被拒配对：拿一个不存在的 6 位码去配，中继会回 pair-fail。
    const bogus = await Peer.connect(ctx.url)
    ctx.open.push(bogus)
    bogus.send({
      t: 'hello',
      role: 'client',
      protocol: 1,
      clientId: 'inst-bogus',
      clientMeta: { platform: 'wechat-mp' },
    })
    await bogus.until((f) => f.t === 'hello-ok')
    bogus.send({ t: 'pair-begin-client', pairingToken: '000000' })
    await bogus.until((f) => f.t === 'pair-fail')
    assert.equal((await counters()).rejected, 1, '被拒的配对必须有出口，否则线上只能靠翻日志')

    // ② 丢弃帧：观众退场后会话仍在（会话归主机），主机继续下行 —— 这一帧没有收件人。
    //    R1 的"静默黑洞"正是这个形状，它必须至少在 /healthz 上可见。
    const { host, client, conversationId } = await pairUp(ctx)
    client.send({ t: 'session-leave', sessionId: conversationId })
    await host.until((f) => f.t === 'peer-left' && f.sessionId === conversationId)
    host.send({ t: 'enc', sessionId: conversationId, seq: 1, ciphertext: CIPHER })
    await sleep(250)
    assert.equal((await counters()).dropped, 1, '没有收件人的帧必须计数')

    // ③ 慢消费者：钉住主机的发送缓冲，越过窗口就会被 1008 断开。
    pinBuffered(ctx.relay.state.hostSocket(conversationId), 1_000_000)
    assert.ok(await closedWithin(host, 4_000), '主机应被断开（前一条测试已锁语义，这里只借它产生计数）')
    assert.equal((await counters()).slow, 1, '被断开的慢消费者必须计数')
  } finally {
    await ctx.close()
  }
})
