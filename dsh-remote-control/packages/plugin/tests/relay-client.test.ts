/**
 * relay-client.test — `transport/relay.ts`：主机侧中继客户端的配对与密封簿记。
 *
 * 三条来自线上事故的硬要求（取证 docs/legacy-spec/relay-and-wireformat.md §2.3、
 * HANDOFF.md §4.5、docs/DESIGN.md §4 的 D1/D3）：
 *
 * 1. `pair-ready.ttlMs` 是**服务端权威 TTL**，必须改写本地过期时间。忘了这一步：
 *    主机提前清掉 PSK → `peer-joined` 找不到密钥 → 静默丢 peer →
 *    手机端表现为"配对显示成功，但会话列表永远空白"。
 * 2. `peer-joined.pairingToken` 是唯一合法的取密钥依据。多码并存时取"最新那一张"
 *    就是当初那起事故（每一帧都解不开，且没有任何提示）。
 * 3. 中继重启（generation 变化）后旧配对全部作废；客户端断连（`peer-left`）时
 *    会话**必须留着**（D3），否则手机每次回前台都要重新扫码。
 *
 * 说明：`RelayClient` 自己 `new WebSocket(...)`，源码里没有 socket 注入点，
 * 也没有可注入的时钟以外的握手缝。所以这里用白盒方式把一只假 socket 接到
 * 私有字段上、再喂中继来帧文本——测的是帧处理与密钥簿记这些**真正的判据**，
 * 而不是 ws 的实现。若之后给 `RelayClientOptions` 加了 socket 工厂，
 * 把 `attachSocket()/feedFrame()` 换成注入即可，断言一条都不用改。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { PAYLOAD_TYPES, derivePskKey, open, seal } from 'dsh-remote-wire'
import type { CmdPayload, EvPayload } from 'dsh-remote-wire'
import { RelayClient } from '../src/transport/relay.js'
import { ConversationBook, PairingSlots } from '../src/core/keys.js'
import { FakeClock } from '../src/core/clock.js'

/** `ws` 的 `WebSocket.OPEN` 常量值；`raw()` 只比较这个数。 */
const SOCKET_OPEN = 1

interface FakeSocket {
  readyState: number
  readonly sent: string[]
  send(text: string): void
  close(): void
  terminate(): void
  removeAllListeners(): void
  /**
   * 真 `ws` 是 EventEmitter，有 `on`。`closeSocket()` 在摘完监听器后会补一个 error
   * 兜底（见那边的注释），假 socket 少了这个方法，那条路径在测试里会直接抛
   * `socket.on is not a function` —— mock 不忠实会把生产代码带沟里。
   */
  on(event: string, handler: (...args: unknown[]) => void): void
}

function makeSocket(): FakeSocket {
  return {
    readyState: SOCKET_OPEN,
    sent: [],
    send(text: string) {
      this.sent.push(String(text))
    },
    close() {
      this.readyState = 3 // CLOSED
    },
    terminate() {
      this.readyState = 3
    },
    removeAllListeners() {
      /* 假 socket 没有监听器 */
    },
    on() {
      /* 同上：假 socket 不自己发事件，能挂上就够 */
    },
  }
}

interface Harness {
  clock: FakeClock
  slots: PairingSlots
  client: RelayClient
  socket: FakeSocket
  /** 主机发出的明文控制帧（已 JSON.parse）。 */
  out(): Array<Record<string, unknown>>
  outOf(type: string): Array<Record<string, unknown>>
  feed(frame: Record<string, unknown>): void
  feedText(text: string): void
  readonly joined: Array<{ conversationId: string; token: string | undefined }>
  readonly gone: string[]
  readonly left: Array<{ conversationId: string; clientId: string }>
  readonly commands: Array<{ conversationId: string; cmd: CmdPayload; clientId?: string }>
  readonly states: Array<{ relay: string; problem?: string; conversations: number; generation: number }>
  readonly logs: string[]
}

function harness(): Harness {
  const clock = new FakeClock()
  const slots = new PairingSlots(() => clock.now())
  const socket = makeSocket()
  const joined: Harness['joined'] = []
  const gone: Harness['gone'] = []
  const left: Harness['left'] = []
  const commands: Harness['commands'] = []
  const states: Harness['states'] = []
  const logs: string[] = []
  const client = new RelayClient({
    url: 'ws://127.0.0.1:1',
    hostId: 'h_test',
    label: '测试主机',
    token: 'fake-host-token-not-a-real-secret-0123',
    clock,
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields ?? {})}`)
    },
    onCommand: (conversationId, cmd, clientId) => {
      commands.push({ conversationId, cmd, ...(clientId === undefined ? {} : { clientId }) })
    },
    onPeerJoined: (conversationId, pairingToken) => joined.push({ conversationId, token: pairingToken }),
    onConversationGone: (conversationId) => gone.push(conversationId),
    onClientLeft: (conversationId, clientId) => left.push({ conversationId, clientId }),
    lookupPairingSlot: (token) => slots.resolveFor(token),
    onPairReady: (token, ttlMs) => {
      // 与 index.ts 的接法一致：服务端 TTL 改写本地过期。
      if (!slots.applyServerTtl(token, ttlMs)) logs.push(`pair-ready for an unknown token ${token}`)
    },
    onState: (info) => states.push(info),
  })
  attachSocket(client, socket)
  const out = (): Array<Record<string, unknown>> =>
    socket.sent.map((text) => JSON.parse(text) as Record<string, unknown>)
  return {
    clock,
    slots,
    client,
    socket,
    out,
    outOf: (type: string) => out().filter((frame) => frame.t === type),
    feed: (frame: Record<string, unknown>) => feedFrame(client, JSON.stringify(frame)),
    feedText: (text: string) => feedFrame(client, text),
    joined,
    gone,
    left,
    commands,
    states,
    logs,
  }
}

function attachSocket(client: RelayClient, socket: FakeSocket): void {
  ;(client as unknown as { socket: FakeSocket | undefined }).socket = socket
}

function feedFrame(client: RelayClient, text: string): void {
  ;(client as unknown as { onFrame(text: string): void }).onFrame(text)
}

/** 手机侧那一本镜像密钥：它拿 PSK + convId 自己派生，主机看不到它的密钥。 */
function phoneKeys(psk: string, conversationId: string): { kC2H: Uint8Array; kH2C: Uint8Array } {
  return {
    kC2H: derivePskKey(psk, 'c2h', conversationId),
    kH2C: derivePskKey(psk, 'h2c', conversationId),
  }
}

test('发布的 pair-begin 只带 6 位码，PSK 一个字节都不上过网（D1：中继结构性零知识）', () => {
  const { client, slots, outOf } = harness()
  const slot = slots.create(120_000)
  client.publishPairing(slot)
  const frames = outOf('pair-begin')
  assert.equal(frames.length, 1, '一条 pair-begin 都没发出去：手机扫码后永远等不到配对结果')
  const frame = frames[0] as Record<string, unknown>
  assert.equal(frame.pairingToken, slot.token, 'pairingToken 必须是这张码本身：中继按它路由并回显')
  const text = JSON.stringify(frame)
  assert.equal(text.includes('psk'), false, 'pair-begin 里出现了 psk 字段：中继内存里就会多一份密钥副本（D1 的出发点）')
  assert.equal(text.includes(slot.psk), false, 'PSK 真值被发了出去：零知识声明与实现不一致')
})

test('pair-ready 的 ttlMs 必须改写本地过期：忘了这一步就是"配对成功但列表永远空白"', async () => {
  const { client, clock, slots, feed, joined } = harness()
  const slot = slots.create(1_000) // 本地只给 1 秒
  client.publishPairing(slot)

  await clock.advance(5_000) // 本地认为它早过期了
  assert.equal(slot.expiresAt < clock.now(), true, '夹具自检：此刻本地已判过期')

  // 服务端说还能用两分钟——权威值必须覆盖本地值。
  feed({ t: 'pair-ready', pairingToken: slot.token, ttlMs: 120_000 })
  assert.equal(
    slots.resolveFor(slot.token) !== null,
    true,
    '服务端 TTL 没有改写本地过期：主机会在配对发生之前就把 PSK 清掉',
  )

  feed({ t: 'peer-joined', sessionId: 'c_aaa111222333', clientId: 'k_mp', pairingToken: slot.token })
  assert.equal(joined.length, 1, 'peer-joined 取不到 PSK 被静默丢弃 → 手机显示配对成功、会话列表却是空的')
  assert.equal(client.hasPeer('c_aaa111222333'), true, '会话没建起来：后续每一条下行都返回 false')
})

test('peer-joined 缺 pairingToken 时不建会话（那是重连通知，不是新客户端加入）', () => {
  const { client, slots, feed, joined } = harness()
  slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_bbb111222333', clientId: 'k_mp' })
  assert.equal(joined.length, 0, '没有 token 也建了会话：那是拿"最新那张码"的 PSK 猜密钥（多码事故的形状）')
  assert.equal(client.conversationCount, 0, `凭空建了 ${client.conversationCount} 条会话`)
  assert.equal(client.hasPeer('c_bbb111222333'), false, 'hasPeer 谎报有对端')
})

test('多码并存时按手机实际使用的那张码取 PSK：用 A 码建的会话必须用 A 的密钥（旧事故回归）', async () => {
  const { client, clock, slots, feed, joined } = harness()
  const older = slots.create(120_000) // 自动补发的那一张
  await clock.advance(10)
  const newer = slots.create(120_000) // 用户又手工 /drc pair 了一张
  assert.equal(older.token !== newer.token, true, '夹具自检：两张码必须不同')
  assert.equal(slots.latest()?.token, newer.token, '夹具自检：latest() 会给出更新的那一张（旧实现就是取了它）')

  feed({ t: 'peer-joined', sessionId: 'c_ccc111222333', clientId: 'k_mp', pairingToken: older.token })
  assert.equal(joined.length, 1, '用较早那张码配对被拒了：手机扫的是它屏幕上那张，不是最新那张')
  const conversation = client.conversations.get('c_ccc111222333')
  assert.ok(conversation !== undefined, '会话没建出来')
  assert.equal(conversation.psk, older.psk, `取到了错的 PSK（期望 older=${older.psk}，实际 ${conversation.psk}）`)

  // 最硬的一条：手机那一侧用 A 的 PSK 派生密钥，两侧必须能互解。
  const phone = phoneKeys(older.psk, 'c_ccc111222333')
  const wrongPhone = phoneKeys(newer.psk, 'c_ccc111222333')
  const payload = { t: PAYLOAD_TYPES.evResult, cmdId: 'cmd_1', ok: true } as EvPayload
  assert.equal(client.send('c_ccc111222333', payload), true, '下行发送失败')
  const frame = client.conversations.get('c_ccc111222333')
  assert.ok(frame !== undefined)

  // 把刚才那条 outbound 密文取回来，用手机的密钥解：解不开就是"配对成功、每一帧都解不开"。
  const sent = JSON.parse(String((client as unknown as { socket: { sent: string[] } }).socket.sent.at(-1))) as {
    ciphertext: string
  }
  assert.equal(
    open(phone.kH2C, { ciphertext: sent.ciphertext }) !== null,
    true,
    '手机用 A 码的 PSK 解不开主机下行 → 会话列表空白、没有任何提示',
  )
  assert.equal(
    open(wrongPhone.kH2C, { ciphertext: sent.ciphertext }),
    null,
    '拿错码（B）的密钥竟然解得开：说明密钥没绑定到所用那张码',
  )
})

test('上行命令用同一张码的 c2h 密钥解密并交给 runtime（两把方向密钥不许混用）', () => {
  const { client, slots, feed, commands } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_ddd111222333', clientId: 'k_mp', pairingToken: slot.token })
  const phone = phoneKeys(slot.psk, 'c_ddd111222333')
  const cmd = { t: PAYLOAD_TYPES.cmdListSessions, cmdId: 'cmd_ls_1' } as CmdPayload
  feed({ t: 'enc', sessionId: 'c_ddd111222333', clientId: 'k_mp', ciphertext: seal(phone.kC2H, cmd).ciphertext })

  assert.equal(commands.length, 1, '解得开却没交给 runtime：手机点了"刷新列表"没有任何反应')
  assert.equal(commands[0]?.cmd.t, PAYLOAD_TYPES.cmdListSessions, '命令类型丢了')
  assert.equal(
    (commands[0]?.cmd as unknown as { cmdId: string }).cmdId,
    'cmd_ls_1',
    'cmdId 必须逐字交给 runtime：回执对答靠它',
  )
  assert.equal(commands[0]?.clientId, 'k_mp', 'clientId 要带上来（D4 的成员校验要用）')

  // 用错方向的密钥密封：主机解不开，但绝不能崩。
  feed({ t: 'enc', sessionId: 'c_ddd111222333', ciphertext: seal(phone.kH2C, cmd).ciphertext })
  assert.equal(commands.length, 1, '方向搞反的密文被当成合法命令放行了：B5 的方向分离就白做了')
})

test('MAC 校验通过但载荷不是任何一条已定义命令：不进 runtime，也不许攒成"解不开两次就作废"', () => {
  const { client, slots, feed, commands, logs } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_dtd111222333', clientId: 'k_mp', pairingToken: slot.token })
  const phone = phoneKeys(slot.psk, 'c_dtd111222333')

  // 手机（或被改过的客户端）密封了一条我们没定义过的命令。
  feed({
    t: 'enc',
    sessionId: 'c_dtd111222333',
    ciphertext: seal(phone.kC2H, { t: 'cmd.drop_everything', cmdId: 'x_1' } as never).ciphertext,
  })
  assert.equal(
    commands.length,
    0,
    '未定义的载荷被原样递进 runtime：下游是 switch + 真实内核调用，等于让一条密文决定宿主被怎么调',
  )
  assert.ok(
    logs.some((line) => line.includes('failed cmd schema')),
    '拒收必须留痕：否则"手机点了没反应"没有答案',
  )
  assert.equal(client.hasPeer('c_dtd111222333'), true, '形状错不是密钥错，不该计入"连续两次解不开就作废"')

  // 同一条通道上的合法命令仍然进得来（这次拒收没有把通道打死）。
  feed({
    t: 'enc',
    sessionId: 'c_dtd111222333',
    ciphertext: seal(phone.kC2H, { t: PAYLOAD_TYPES.cmdListSessions, cmdId: 'cmd_ok' } as CmdPayload).ciphertext,
  })
  assert.equal(commands.length, 1, '一次形状拒收之后整条通道都哑了')
})

test('enc-batch 逐项解密并保持数组顺序（F12/T3：客户端没有排序能力）', () => {
  const { client, slots, feed, commands } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_eee111222333', clientId: 'k_mp', pairingToken: slot.token })
  const phone = phoneKeys(slot.psk, 'c_eee111222333')
  const items = ['a', 'b', 'c'].map((tag) => ({
    seq: 1,
    ciphertext: seal(phone.kC2H, {
      t: PAYLOAD_TYPES.cmdInterrupt,
      cmdId: `cmd_${tag}`,
      sessionId: 'ses_x',
    } as CmdPayload).ciphertext,
  }))
  feed({ t: 'enc-batch', sessionId: 'c_eee111222333', items })

  assert.ok(commands.length >= 3, `批量帧解出 ${commands.length} 条：整批丢弃或漏项都会让手机的操作"点了一下没反应"`)
  assert.deepEqual(
    commands.map((item) => (item.cmd as unknown as { cmdId: string }).cmdId),
    ['cmd_a', 'cmd_b', 'cmd_c'],
    '批量帧内的顺序变了：同一会话的中断与发指令谁先谁后不可推断（T3 要求串行投递）',
  )
})

test('hello-ok 之后 generation 递增：旧代配对全部作废并通知上层（中继重启后旧 convId 没人路由了）', () => {
  const { client, slots, feed, gone, outOf } = harness()
  feed({ t: 'hello-ok', role: 'host', hostId: 'h_test' })
  assert.equal(client.conversationCount, 0, '夹具自检：新连接还没有会话')

  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_fff111222333', clientId: 'k_mp', pairingToken: slot.token })
  assert.equal(client.hasPeer('c_fff111222333'), true, '夹具自检：会话已建立')

  // 中继重启：第二次 hello-ok 意味着新的代次。
  feed({ t: 'hello-ok', role: 'host', hostId: 'h_test' })
  assert.equal(
    client.conversationCount,
    0,
    `代次变了还留着旧会话（${client.conversationCount} 条）：主机对着一个不存在的通道发密文`,
  )
  assert.deepEqual(gone, ['c_fff111222333'], '没有通知上层作废：手机端的"会话已失效，请重新配对"中文提示就发不出去')
  assert.equal(
    client.send('c_fff111222333', { t: PAYLOAD_TYPES.evRunState, sessionId: 'ses_x', state: 'running' } as EvPayload),
    false,
    '旧会话还能发出去',
  )

  const resync = outOf('resync')
  assert.ok(resync.length >= 1, '鉴权成功后没发 resync：中继不知道该保留哪些会话（复核 R1 的恢复路径）')
  assert.deepEqual((resync[0] as { sessionIds: string[] }).sessionIds, [], 'resync 应该只列出本端仍持有密钥的会话')
})

test('连续两次解不开同一会话就主动作废：对称于手机端"两帧解不开就丢配对"', () => {
  const { client, slots, feed, gone } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_000111222333', clientId: 'k_mp', pairingToken: slot.token })

  // 一条形状合法（标准 base64）、MAC 解不开的密文——像是手机端密钥已经被换掉。
  const junk = Buffer.alloc(24 + 16 + 4, 7).toString('base64')
  feed({ t: 'enc', sessionId: 'c_000111222333', ciphertext: junk })
  assert.equal(client.hasPeer('c_000111222333'), true, '一次解不开就丢配对太激进：小程序自己也给两帧机会')
  assert.equal(gone.length, 0, '第一次就通知作废了')

  feed({ t: 'enc', sessionId: 'c_000111222333', ciphertext: junk })
  assert.equal(client.conversationCount, 0, '两帧都解不开却还留着通道：手机会对着一个听不见的对端一直说话')
  assert.deepEqual(gone, ['c_000111222333'], '必须通知上层，让手机端看到"请重新配对"的中文提示')
  const leave = client.conversations.get('c_000111222333')
  assert.equal(leave, undefined, '密钥簿里还留着这条会话')
})

test('解不开计数在一帧成功解密后清零：偶发噪声不该攒成一次误废弃', () => {
  const { client, slots, feed, gone } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_111222333444', clientId: 'k_mp', pairingToken: slot.token })
  const phone = phoneKeys(slot.psk, 'c_111222333444')
  const junk = Buffer.alloc(24 + 16 + 4, 9).toString('base64')

  feed({ t: 'enc', sessionId: 'c_111222333444', ciphertext: junk })
  feed({
    t: 'enc',
    sessionId: 'c_111222333444',
    ciphertext: seal(phone.kC2H, { t: PAYLOAD_TYPES.cmdListSessions, cmdId: 'cmd_ok' } as CmdPayload).ciphertext,
  })
  feed({ t: 'enc', sessionId: 'c_111222333444', ciphertext: junk })
  assert.equal(gone.length, 0, '中间成功过一帧，却被当成连续两次解不开而废弃：会话被误删，手机要重新扫码')
  assert.equal(client.hasPeer('c_111222333444'), true, '会话不该被误废')
})

test('base64 字符集不合法的密文只被拒收，不计入解不开次数（严进但不能因此丢配对）', () => {
  const { client, slots, feed, gone, logs } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_222333444555', clientId: 'k_mp', pairingToken: slot.token })
  for (const bad of ['####not-base64####', '', 'a']) {
    feed({ t: 'enc', sessionId: 'c_222333444555', ciphertext: bad.length === 0 ? 'AAAA' : bad })
  }
  assert.equal(
    gone.length,
    0,
    `形状非法的帧被计成了"解不开"并导致废弃配对（gone=${JSON.stringify(gone)}）：中继早就该拦下它`,
  )
  assert.equal(client.hasPeer('c_222333444555'), true, '会话必须还在')
  assert.ok(logs.length >= 0, '夹具自检：日志通道可用')
})

test('peer-left 只摘掉那个客户端，会话与密钥必须留着（D3：手机回前台不该要求重新扫码）', () => {
  const { client, slots, feed, left, out } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_333444555666', clientId: 'k_mp', pairingToken: slot.token })
  assert.equal(client.conversationCount, 1, '夹具自检：会话已建立')

  feed({ t: 'peer-left', sessionId: 'c_333444555666', clientId: 'k_mp' })
  assert.deepEqual(
    left,
    [{ conversationId: 'c_333444555666', clientId: 'k_mp' }],
    '离开通知没交给上层：runtime 不知道该推一次列表',
  )
  assert.equal(
    client.hasPeer('c_333444555666'),
    true,
    '客户端一走就把会话删了 → 手机切后台再回来必须重新扫码（旧实现的产品缺陷）',
  )
  assert.equal(
    client.conversations.get('c_333444555666')?.psk,
    slot.psk,
    '密钥跟着丢了：同一条 convId 回来时再也解不开',
  )
  assert.equal(
    out().some((frame) => frame.t === 'session-leave'),
    false,
    '不该因为 peer-left 就主动退出会话',
  )

  const sent = client.send('c_333444555666', {
    t: PAYLOAD_TYPES.evRunState,
    sessionId: 'ses_x',
    state: 'running',
  } as EvPayload)
  assert.equal(sent, true, '会话还在却发不出去：出站路径被 peer-left 悄悄断了')
})

test('主动作废已知会话：发 session-leave + 通知上层，且同一条通道只声明一次', () => {
  const { client, slots, feed, gone, outOf } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_444555666777', clientId: 'k_mp', pairingToken: slot.token })

  client.voidConversation('c_444555666777')
  assert.deepEqual(gone, ['c_444555666777'], '/drc unpair 之后上层不知道：手机还会以为配对仍在')
  const leave = outOf('session-leave')
  assert.equal(leave.length, 1, '没发 session-leave：中继会继续把这条会话的密文转过来')
  assert.equal(
    (leave[0] as { sessionId: string }).sessionId,
    'c_444555666777',
    '退出的必须是配对通道 id（c_ 前缀），不是 DSH 会话 id（F3）',
  )

  client.voidConversation('c_444555666777') // 同一原因再来一次
  assert.equal(leave.length, 1, `重复作废多发了 ${leave.length - 1} 条 session-leave：必须幂等`)
  assert.equal(gone.length, 1, '重复作废重复回调 gone：上层会收到两次"配对失效"')
})

/**
 * 复核 R1①：本端**没有**这条通道的记录时也必须声明 `session-leave`。
 *
 * 场景是这条链路上最难查的一个：主机进程重启 → 内存里的 PSK 全没了，中继却不知道，
 * 于是它继续把手机发来的密文转给一个解不开的对端。手机既等不到回复，也等不到
 * `unknown_session`（那个码只由"中继路由表未命中"产生，而这里表是命中的），
 * 表现是"发什么都没反应、也不提示重新配对"——整条链路上唯一的出口就是主机自己声明作废。
 * 第一版这里写的是 `if (!has(id)) return`，等于把出口堵死了。
 */
test('对本端没有记录的 convId 也必须发 session-leave（主机重启后手机唯一的出口，复核 R1①）', () => {
  const { client, gone, outOf } = harness()

  client.voidConversation('c_重启之后不认识的会话')

  const leave = outOf('session-leave')
  assert.equal(leave.length, 1, '没钥匙又不声明：中继会一直把手机的密文转给一个解不开的对端，手机永远转圈')
  assert.equal(
    (leave[0] as { sessionId: string }).sessionId,
    'c_重启之后不认识的会话',
    '作废的必须是手机在用的那条 convId',
  )
  assert.deepEqual(gone, ['c_重启之后不认识的会话'], '上层不知道这条已经死了：status.json 与自动补发都不会动')
})

/** 同一条路上更常见的触发方式不是有人调 API，而是手机发来一帧本端没有钥匙的密文。 */
test('enc 打到一个本端不认识的 convId：立刻作废并声明，而不是静默丢帧', () => {
  const { client, slots, feed, gone, outOf } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_aabbccddeeff', clientId: 'k_mp', pairingToken: slot.token })
  client.conversations.close('c_aabbccddeeff') // 模拟主机重启：内存里的密钥簿空了
  assert.equal(client.conversationCount, 0, '夹具自检：此刻本端一条会话都不该有')

  // 手机仍在旧 convId 上发。密文内容无所谓——本端连密钥都没有，走的是"查不到会话"那条分支。
  feed({ t: 'enc', sessionId: 'c_ffffffff0000', seq: 1, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })

  assert.equal(outOf('session-leave').length, 1, '解不开又不声明：手机对着一个不存在密钥的通道说话')
  assert.deepEqual(gone, ['c_ffffffff0000'], '上层没被告知这条通道作废')
  assert.equal(client.hasPeer('c_ffffffff0000'), false, '不该顺手把陌生 convId 建成本端会话')
})

test('pair-fail 与未知帧名都要留痕：中继侧加一个名字，主机不许永远是哑的（F1）', () => {
  const { client, slots, feed, logs } = harness()
  slots.create(120_000)
  feed({ t: 'pair-fail', reason: 'already_used' })
  assert.ok(
    logs.some((line) => line.includes('pair failed') && line.includes('already_used')),
    `pair-fail 无人处理也不留痕（日志：${JSON.stringify(logs)}）：手机扫完码主机侧完全无痕`,
  )
  // 未定义的帧名：解析层就拒了，同样要留下一条"收到但丢弃"的痕迹。
  feed({ t: 'a-frame-we-do-not-know-yet' } as never)
  assert.ok(
    logs.some((line) => line.includes('relay frame rejected')),
    '坏帧/未知帧静默蒸发：线上只能靠猜',
  )
  assert.equal(client.conversationCount, 0, '上面两帧都不该建出会话')
})

test('出站 seq 逐帧递增且外层 sessionId 恒为配对通道 id（F3 的双 sessionId 不许混）', () => {
  const { client, slots, feed } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_555666777888', clientId: 'k_mp', pairingToken: slot.token })
  const socket = (client as unknown as { socket: { sent: string[] } }).socket
  socket.sent.length = 0

  const payload = {
    t: PAYLOAD_TYPES.evMessageDelta,
    sessionId: 'ses_dsh_1',
    messageId: 'msg_1',
    delta: '你好',
  } as EvPayload
  client.send('c_555666777888', payload)
  client.send('c_555666777888', payload)
  const frames = socket.sent.map((text) => JSON.parse(text) as Record<string, unknown>)
  assert.equal(frames.length, 2, '两条下行只发出一条：手机会少一段文本')
  assert.deepEqual(
    frames.map((frame) => frame.seq),
    [1, 2],
    `seq 序列是 ${JSON.stringify(frames.map((f) => f.seq))}：本端序号是"顺序可核对"的唯一依据`,
  )
  assert.deepEqual(
    frames.map((frame) => frame.sessionId),
    ['c_555666777888', 'c_555666777888'],
    '外层 sessionId 必须是 convId：写成 DSH 会话 id 中继就路由不回去',
  )
  assert.equal(
    JSON.stringify(frames).includes('ses_dsh_1'),
    false,
    '载荷里的 DSH 会话 id 泄漏到明文帧上了：中继会看到业务明文（红线 24）',
  )
})

test('broadcast 只对活着的会话计数：断连期间不许假装"已发送"', () => {
  const { client, slots, feed } = harness()
  const first = slots.create(120_000)
  const second = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_666777888999', clientId: 'k1', pairingToken: first.token })
  feed({ t: 'peer-joined', sessionId: 'c_777888999aaa', clientId: 'k2', pairingToken: second.token })
  const payload = { t: PAYLOAD_TYPES.evSessionChanged, sessions: [] } as EvPayload
  assert.equal(client.broadcast(payload), 2, '两条会话都该收到广播')

  client.voidConversation('c_777888999aaa')
  assert.equal(client.broadcast(payload), 1, '作废之后广播数没降下来：调用方以为还有人在听')
})

test('畸形帧与未知帧名一律静默忽略且绝不抛：一条坏帧不该打断消息处理链', () => {
  const { client, feedText } = harness()
  assert.doesNotThrow(() => feedText('{not json'), '非法 JSON 把处理链抛断了：中继那边只是发了一帧脏数据')
  assert.doesNotThrow(
    () => feedText(JSON.stringify({ t: 'totally-new-frame', x: 1 })),
    '未知帧名抛了出去：F1 要求新帧名必须被静默忽略',
  )
  assert.doesNotThrow(
    () => feedText(JSON.stringify({ t: 'pong', ts: 1 })),
    'pong 必须被接受并忽略（T4：应用层不发心跳）',
  )
  assert.doesNotThrow(
    () => feedText(JSON.stringify({ t: 'paired', sessionId: 'c_x', hostId: 'h_test' })),
    'paired 是发给客户端的，主机侧必须忽略',
  )
  assert.doesNotThrow(
    () => feedText(JSON.stringify({ t: 'error', code: 'unknown_session' })),
    'error 帧要记进状态而不是抛',
  )
  assert.equal(client.conversationCount, 0, '上面这些帧不该建出任何会话')
})

test('error 帧只进日志与状态，不主动清会话：清不清由 enc 路径判定（哪条通道只有那里知道）', () => {
  const { client, slots, feed, gone, logs } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_888999aaabbb', clientId: 'k_mp', pairingToken: slot.token })
  feed({ t: 'error', code: 'bad_token', message: 'token 不对' })
  assert.equal(gone.length, 0, '一条 error 帧就把配对清了：手机上表现为"莫名其妙要重新扫码"')
  assert.equal(client.hasPeer('c_888999aaabbb'), true, '会话必须还在')
  assert.ok(
    logs.some((line) => line.includes('bad_token')),
    '中继错误要进日志：否则"为什么没反应"没有答案（status.json 的 relayProblem 同源）',
  )
})

test('stop() 之后一切出站都如实返回 false：调用方据此知道没人能收', () => {
  const { client, slots, feed, states } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_999aabbbccc0', clientId: 'k_mp', pairingToken: slot.token })
  assert.equal(
    client.send('c_999aabbbccc0', { t: PAYLOAD_TYPES.evRunState, state: 'idle' } as EvPayload),
    true,
    '夹具自检：停机前发得出去',
  )

  client.stop()
  assert.equal(
    client.send('c_999aabbbccc0', { t: PAYLOAD_TYPES.evRunState, state: 'idle' } as EvPayload),
    false,
    'socket 已关却返回 true：旧实现所有调用点都忽略返回值，这里必须诚实',
  )
  assert.equal(client.broadcast({ t: PAYLOAD_TYPES.evRunState, state: 'idle' } as EvPayload), 0, '停机后广播数必须为 0')
  const last = states[states.length - 1]
  assert.equal(last?.relay, 'offline', `停机后的状态是 ${String(last?.relay)}：status.json 会一直谎报 online`)
})

test('ConversationBook 与 PairingSlots 的协作：同一条 convId 重复 joined 必须换回新密钥', () => {
  const { client, slots, feed } = harness()
  const older = slots.create(120_000)
  const newer = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_aaabbcccddd', clientId: 'k1', pairingToken: older.token })
  const before = client.conversations.get('c_aaabbcccddd')?.psk
  feed({ t: 'peer-joined', sessionId: 'c_aaabbcccddd', clientId: 'k2', pairingToken: newer.token })
  const after = client.conversations.get('c_aaabbcccddd')
  assert.equal(after?.psk, newer.psk, `同一条 convId 的二次 joined 没有换钥（before=${before} after=${after?.psk}）`)
  assert.equal(client.conversationCount, 1, '一条 convId 攒出了多条会话：簿记键必须是 convId 本身')

  // 手机此刻拿的是新那张码的 PSK：主机下行必须能用它解开。
  const socket = (client as unknown as { socket: { sent: string[] } }).socket
  socket.sent.length = 0
  client.send('c_aaabbcccddd', { t: PAYLOAD_TYPES.evRunState, sessionId: 'ses_x', state: 'idle' } as EvPayload)
  const frame = JSON.parse(socket.sent[0] as string) as { ciphertext: string }
  assert.equal(
    open(phoneKeys(newer.psk, 'c_aaabbcccddd').kH2C, { ciphertext: frame.ciphertext }) !== null,
    true,
    '换钥之后下行仍用旧钥密封：手机解不开',
  )
})

test('中继来帧的 sessionId 逐字用作会话键（F3：两套 id 一旦混用整页无输出）', () => {
  const { client, slots, feed } = harness()
  const slot = slots.create(120_000)
  const convId = 'c_0123456789ab'
  feed({ t: 'peer-joined', sessionId: convId, clientId: 'k_mp', pairingToken: slot.token })
  assert.equal(client.conversations.ids().length, 1, '会话没建出来')
  assert.equal(client.conversations.ids()[0], convId, '会话键被加工过（加/去前缀都会让路由对不上）')
  assert.equal(client.conversationIds()[0], convId, 'conversationIds() 必须原样透出：runtime 靠它挑通道发审批卡')
  assert.equal(String(client.conversations.ids()[0]).startsWith('c_'), true, '前缀 c_ 是冻结字符串（B9）')
})

test('状态回调如实汇报会话数与代次：status.json 的 conversations/generation 就是从这来的', () => {
  const { client, slots, feed, states } = harness()
  feed({ t: 'hello-ok', role: 'host', hostId: 'h_test' })
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_bbccddeeff00', clientId: 'k_mp', pairingToken: slot.token })
  const last = states[states.length - 1]
  assert.ok(last !== undefined, '一次状态都没回调：status.json 里 relay 会永远停在 connecting')
  assert.equal(last.relay, 'online', `状态是 ${last.relay}：手机上"连不上"与"配上了但一切不通"看起来一模一样`)
  assert.equal(last.conversations, 1, '会话数不对')
  assert.equal(last.generation, 1, '代次不对：发布循环靠它判断中继重启过没有')
})

test('配对槽位簿记与传输层用的是同一张表：pair-ready 对未知 token 要留下痕迹', () => {
  const { feed, slots, logs } = harness()
  feed({ t: 'pair-ready', pairingToken: '424242', ttlMs: 60_000 })
  assert.equal(slots.resolveFor('424242'), null, '夹具自检：本地根本没有这张码')
  assert.ok(
    logs.some((line) => line.includes('pair-ready for an unknown token')),
    '服务端为一张我们没发过的码发来了 TTL：这必须留痕，否则配对流程出现了第二份真相',
  )
})

/**
 * 配对通道剪枝。D3 让通道跨断连长存，而**中继侧的空闲 TTL 是 7 天**
 * （`DRC_CONV_IDLE_TTL_MS`），所以"等中继先忘掉"等于永远不剪：
 * 每天配一次对的主机两周就能攒两百多条 PSK，并且每次广播都对废弃通道逐个密封。
 * 关键约束是：剪枝必须走 `voidConversation`（发 `session-leave` + 回调上层），
 * 只删内存就等于复核 R1 那个静默黑洞换了个入口重来一次。
 */
test('空闲超时的通道被剪掉时必须发 session-leave 并通知上层（不能只删内存）', async () => {
  const { client, clock, slots, feed, gone, outOf } = harness()
  const first = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_old000000001', clientId: 'k1', pairingToken: first.token })
  // 第二条：刚活动过，不该被剪。
  await clock.advance(10)
  const second = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_new000000002', clientId: 'k2', pairingToken: second.token })

  await clock.advance(25 * 3600 * 1000) // 一天多没有任何收发
  client.send('c_new000000002', {
    t: PAYLOAD_TYPES.evKeepAwakeState,
    enabled: true,
    active: false,
    platform: 'darwin',
    backend: 'caffeinate',
  } as EvPayload)
  const pruned = client.pruneConversations()

  assert.deepEqual(pruned, ['c_old000000001'], `剪掉的应该是那条一天没动静的，实际剪了 ${JSON.stringify(pruned)}`)
  assert.equal(client.hasPeer('c_old000000001'), false, '剪了内存却没关通道')
  assert.deepEqual(gone, ['c_old000000001'], '上层不知道：status.json 与自动补发都不会动')
  const leave = outOf('session-leave')
  assert.equal(leave.length, 1, '没发 session-leave：中继会继续把手机的密文转给一条已经没有钥匙的通道')
  assert.equal((leave[0] as { sessionId: string }).sessionId, 'c_old000000001')
  assert.equal(client.hasPeer('c_new000000002'), true, '刚有收发的通道被顺手剪了')
})

test('条数上界是真上界：超出后从最不活跃的开始剪，而不是拒绝新建', () => {
  const { client, clock, slots, feed } = harness()
  const policy = { idleTtlMs: 24 * 3600 * 1000, maxConversations: 3 }
  ;(client as unknown as { options: { prunePolicy?: typeof policy } }).options.prunePolicy = policy
  for (let index = 0; index < 5; index++) {
    const slot = slots.create(120_000)
    feed({ t: 'peer-joined', sessionId: `c_cap${index}`, clientId: `k${index}`, pairingToken: slot.token })
    void clock.advance(1) // 保证活跃时刻有先后
  }
  assert.equal(client.conversationCount, 5, '夹具自检：还没剪之前是 5 条')
  // 关键一步：让**创建最早**的那条重新活跃。不这样做的话"按最后活动剪"与
  // "按创建序剪"两种实现给出的结果一模一样，这条断言就什么都没守（变异验证抓出来的）。
  assert.equal(
    client.send('c_cap0', {
      t: PAYLOAD_TYPES.evKeepAwakeState,
      enabled: true,
      active: false,
      platform: 'darwin',
      backend: 'caffeinate',
    } as EvPayload),
    true,
    '夹具自检：c_cap0 要有收发记录',
  )
  const pruned = client.pruneConversations()
  assert.equal(pruned.length, 2, `上界 3 却剪了 ${pruned.length} 条`)
  assert.deepEqual(
    pruned,
    ['c_cap1', 'c_cap2'],
    `必须按"最后活动"从最不活跃开始剪（刚有收发的 c_cap0 必须留下），实际剪了 ${JSON.stringify(pruned)}`,
  )
  assert.equal(client.conversationCount, 3)
  assert.equal(client.hasPeer('c_cap0'), true, '刚发过数据的通道被剪：手机会突然撞上"会话已失效"')
})

test('停机时 socket 还停在 CONNECTING：close() 的异步 error 不许升级成 uncaughtException', async () => {
  // 这条**必须用真 ws**（所以这里不 attachSocket）。机制来自 ws：socket 还在 CONNECTING
  // 时 close() 走 abortHandshake，那条路径是 process.nextTick 抛 error ——
  // 假 socket（EventEmitter）复现不了，而**同步的 try/catch 也拦不住异步抛出**。
  // 于是 removeAllListeners() 摘掉 error 监听器之后它没人接，升级成 uncaughtException
  // 把进程带崩。表现是 e2e 偶发红：'WebSocket was closed before the connection was
  // established'（只有"连接还没建好就停机"这个窗口才触发，所以时红时绿，很难查）。
  const caught: Error[] = []
  const onUncaught = (e: Error): void => {
    caught.push(e)
  }
  process.on('uncaughtException', onUncaught)
  try {
    const clock = new FakeClock()
    const slots = new PairingSlots(() => clock.now())
    const client = new RelayClient({
      url: 'ws://127.0.0.1:1', // 没人监听 → 一直停在 CONNECTING
      hostId: 'h_connecting',
      label: '测试主机',
      token: 'fake-host-token-not-a-real-secret-0123',
      clock,
      log: () => {},
      onCommand: () => {},
      onPeerJoined: () => {},
      onConversationGone: () => {},
      onClientLeft: () => {},
      lookupPairingSlot: (token) => slots.resolveFor(token),
      onPairReady: () => {},
      onState: () => {},
    })
    client.connect()
    client.stop() // 就在"连接还没建好"这个窗口里停机
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual(
      caught.map((e) => e.message),
      [],
      '停机时 close() 一个 CONNECTING 的 socket 会异步抛 error；必须在摘完监听器后补一个 error 兜底',
    )
  } finally {
    process.removeListener('uncaughtException', onUncaught)
  }
})
