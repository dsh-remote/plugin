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
 * 3. 客户端断连（`peer-left`）时会话**必须留着**（D3），否则手机每次回前台都要重新扫码。
 *
 * 2026-10-04：第 3 条的旧版（「中继重启即作废全部旧代配对」）已经翻转。
 * 主机侧**分不出中继重启与自己重启**，而清空必然误伤后者 —— 于是每次主机重启
 * 都自毁全部配对，自举迭代改一次代码就要人回到机器前重扫一次。
 * 现在重连一律保留会话，`generation` 只喂给发码窗口（「中继的 pending-pair 表清空了没有」）。
 * 三条对应的新判据：重连保留会话、恢复出来的密钥可用、结构性变化触发落盘。
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
  /** 解得开但形状过不了 schema 的载荷：主机**必须**按 cmdId 回一条（见 §5-9 的修）。 */
  readonly invalid: Array<{ conversationId: string; cmdId: string | undefined; payloadType: string }>
  readonly states: Array<{ relay: string; problem?: string; conversations: number; generation: number }>
  /** 会话簿**结构性**变化（新配对 / 作废）的次数：落盘由它驱动。 */
  readonly structural: number[]
  readonly logs: string[]
  /** `pair-fail` 回调收到的 (reason, pairingToken) —— 见下面那组判据。 */
  readonly pairFails: Array<{ reason: string; pairingToken: string | undefined }>
}

function harness(): Harness {
  const clock = new FakeClock()
  const slots = new PairingSlots(() => clock.now())
  const socket = makeSocket()
  const joined: Harness['joined'] = []
  const gone: Harness['gone'] = []
  const left: Harness['left'] = []
  const commands: Harness['commands'] = []
  const invalid: Harness['invalid'] = []
  const states: Harness['states'] = []
  const structural: number[] = []
  const logs: string[] = []
  const pairFails: Harness['pairFails'] = []
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
    onInvalidCommand: (conversationId, cmdId, payloadType) => {
      invalid.push({ conversationId, cmdId, payloadType })
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
    onStructuralChange: () => structural.push(structural.length),
    onPairFail: (reason, pairingToken) => pairFails.push({ reason, pairingToken }),
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
    invalid,
    states,
    structural,
    logs,
    pairFails,
  }
}

/** 起探针链（白盒，与 attachSocket 同一理由：connect() 会去建真 socket）。 */
function startProbe(client: RelayClient, socket: FakeSocket): void {
  ;(client as unknown as { startProbe(socket: FakeSocket): void }).startProbe(socket)
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
  assert.equal(client.hasClient('c_aaa111222333'), true, '会话没建起来：后续每一条下行都返回 false')
})

test('peer-joined 缺 pairingToken 时不建会话（那是重连通知，不是新客户端加入）', () => {
  const { client, slots, feed, joined } = harness()
  slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_bbb111222333', clientId: 'k_mp' })
  assert.equal(joined.length, 0, '没有 token 也建了会话：那是拿"最新那张码"的 PSK 猜密钥（多码事故的形状）')
  assert.equal(client.conversationCount, 0, `凭空建了 ${client.conversationCount} 条会话`)
  assert.equal(client.hasClient('c_bbb111222333'), false, 'hasPeer 谎报有对端')
})

test('多码并存时按手机实际使用的那张码取 PSK：用 A 码建的会话必须用 A 的密钥（旧事故回归）', async () => {
  const { client, clock, slots, feed, joined } = harness()
  const older = slots.create(120_000) // 自动补发的那一张
  await clock.advance(10)
  const newer = slots.create(120_000) // 用户又手工 /drc pair 了一张
  assert.equal(older.token !== newer.token, true, '夹具自检：两张码必须不同')
  assert.equal(
    newer.createdAt > older.createdAt,
    true,
    '夹具自检：newer 是更晚创建的那张（旧实现"取最新那张"取的就是它）',
  )

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
  const { client, slots, feed, commands, logs, invalid, clock } = harness()
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
  assert.equal(client.hasClient('c_dtd111222333'), true, '形状错不是密钥错，不该计入"连续两次解不开就作废"')

  /**
   * **必须交出去回一条**（2026-10-07 补，§5-9）。
   *
   * 手机在它那一端是过得了 schema 的（过不了 `sendCmd` 自己就拒了），所以"到主机这边
   * 过不去"只可能是两端版本不一致。从前这里只写一行日志就 `continue` —— 于是手机干等满
   * 12 秒的 `COMMAND_TIMEOUT_MS`，拿到一句「主机没有回应这条指令」，而根因一个字都没留下。
   */
  assert.deepEqual(
    invalid,
    [{ conversationId: 'c_dtd111222333', cmdId: 'x_1', payloadType: 'cmd.drop_everything' }],
    '形状不对的载荷没有被交出去：手机那一头只剩 12 秒超时，根因只活在主机日志里',
  )
  assert.ok(invalid[0]?.cmdId, 'cmdId 必须随载荷一起交出去 —— 没有它主机回不了执（回执是按 cmdId 结算的）')

  /**
   * 解得开就算这条会话**有活动**，与过不过 schema 无关（同一次修）。
   *
   * 原来 `lastActivityAt` 记在 schema 通过之后，于是"解得开但形状不对"的帧不会更新它，
   * 那条通道会被剪枝判成闲置。而活动的定义是"这端有人在说话"——一条真实配对客户端
   * 发来的、我们能解的帧当然算；形状不对是**协议版本**的事，不是"没人理这条通道"的事。
   *
   * ⚠️ 断言**先把时刻拨回过去**：夹具用的是假时钟（同一 tick 内不前进），直接比
   * `after >= before` 恒真，那正是本仓库反复踩到的"判据自己骗自己"。
   */
  const conversation = client.conversations.get('c_dtd111222333')
  assert.ok(conversation, '夹具自检：会话必须在场')
  const stale = clock.now() - 60_000
  conversation.lastActivityAt = stale
  feed({
    t: 'enc',
    sessionId: 'c_dtd111222333',
    ciphertext: seal(phone.kC2H, { t: 'cmd.drop_everything', cmdId: 'x_2' } as never).ciphertext,
  })
  const after = client.conversations.get('c_dtd111222333')?.lastActivityAt ?? 0
  assert.ok(after > stale, `形状不对的帧没被算成活动（停在 ${stale}），通道会被剪枝当闲置剪掉`)

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

test('重连不再清会话：hello-ok 之后 resync 必须仍然声明着这些 convId（免扫码重连的第一半）', () => {
  const { client, slots, feed, gone, outOf } = harness()
  feed({ t: 'hello-ok', role: 'host', hostId: 'h_test' })
  assert.equal(client.conversationCount, 0, '夹具自检：新连接还没有会话')

  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_fff111222333', clientId: 'k_mp', pairingToken: slot.token })
  assert.equal(client.hasClient('c_fff111222333'), true, '夹具自检：会话已建立')

  // 第二次 hello-ok = 又连上了。这在旧实现里等于 `closeBefore` 清空全部会话，
  // 而它清掉的理由是"中继重启过，它手里的 convId 全没了"—— 但主机侧分辨不出
  // 「中继重启」与「主机自己重启」，于是**每次主机重启都自毁全部配对**（自举迭代要命的正是这条）。
  feed({ t: 'hello-ok', role: 'host', hostId: 'h_test' })
  assert.equal(
    client.conversationCount,
    1,
    `重连一次就只剩 ${client.conversationCount} 条会话：手机必须重新扫码，而触发它的只是主机重启`,
  )
  assert.deepEqual(gone, [], '没有通知上层作废：手机端的"会话已失效，请重新配对"提示会凭空弹出来')

  const resync = outOf('resync')
  assert.ok(resync.length >= 2, '鉴权成功后没发 resync：中继不知道该保留哪些会话（复核 R1 的恢复路径）')
  const last = resync[resync.length - 1] as { sessionIds: string[] }
  assert.deepEqual(
    last.sessionIds,
    ['c_fff111222333'],
    `resync 声明的是 ${JSON.stringify(last.sessionIds)}：中继会照着删掉没被声明的通道，手机下次发帧就撞 unknown_session`,
  )
  assert.equal(
    client.send('c_fff111222333', { t: PAYLOAD_TYPES.evRunState, sessionId: 'ses_x', state: 'running' } as EvPayload),
    true,
    '重连后这条会话发不出去了：主机重启一次就断链一次',
  )
})

test('代次仍然每次 hello-ok 递增：发码窗口靠它判断中继的 pending-pair 表是不是清空了', () => {
  const { feed, states } = harness()
  feed({ t: 'hello-ok', role: 'host', hostId: 'h_test' })
  const first = states.at(-1)
  assert.ok(first !== undefined, '一次状态都没回调：代次无处可读')
  assert.equal(first.generation, 1, '第一次连上时代次必须是 1：PairingWindow 用它认领当前挂出的码')
  feed({ t: 'hello-ok', role: 'host', hostId: 'h_test' })
  const second = states.at(-1)
  assert.ok(second !== undefined, '夹具自检：第二次连接也该有状态回调')
  assert.equal(
    second.generation,
    2,
    '代次没推进：挂在屏幕上的那张码在中继重启后成了死码，而窗口以为它还能用（用户扫了必失败）',
  )
})

test('恢复出来的会话：密钥可用、resync 声明它、成员表从空开始（免扫码重连的第二半）', () => {
  const { client, feed, outOf } = harness()
  const psk = 'AgAAAAAAAAAAAAAAAAAAAA=='
  const convId = 'c_restore01aaaa'
  client.restoreConversations([{ id: convId, psk, seqHost: 3, createdAt: 1_000, lastActivityAt: 2_000 }])
  assert.equal(client.conversationCount, 1, '恢复出来的会话没进簿：resync 会声明空列表，中继把这条通道删掉')
  assert.equal(client.clientCount, 0, '恢复阶段就报"有手机连着"：此刻主机刚起来，没有任何客户端连着')
  assert.equal(client.hasClient(convId), false, 'hasClient 谎报有对端 → broadcast 会往没人收的通道发帧')

  feed({ t: 'hello-ok', role: 'host', hostId: 'h_test' })
  const resync = outOf('resync').at(-1) as { sessionIds: string[] }
  assert.deepEqual(resync.sessionIds, [convId], 'resync 没声明恢复出来的会话：中继据此删除它，免扫码重连失败')

  // 手机回来的第一帧：解得开 + 把 clientId 登记进成员表。
  const phoneKeys = derivePskKey(psk, 'c2h', convId)
  const record = seal(phoneKeys, { t: 'cmd.list_sessions', cmdId: 'cmd_after_restart' })
  feed({ t: 'enc', sessionId: convId, clientId: 'k_mp', ciphertext: record.ciphertext })
  assert.equal(client.clientCount, 1, '手机回来了却没被算成连着：此后每一帧 broadcast 都被闸门挡掉，手机界面永远不动')
  assert.equal(client.hasClient(convId), true, '成员表没登记：状态栏显示未配对，而用户明明连着')
})

test('会话簿的结构性变化必须立刻通知上层落盘：崩了也不能丢（新配对那一秒最脆弱）', () => {
  const { client, slots, feed, structural } = harness()
  feed({ t: 'hello-ok', role: 'host', hostId: 'h_test' })
  const before = structural.length

  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_newpair01aa', clientId: 'k_mp', pairingToken: slot.token })
  assert.equal(
    structural.length,
    before + 1,
    '新配对没有触发落盘：用户刚扫完码的那几秒里崩机，下次就要重新扫码——而重扫要人回到机器前',
  )

  const afterPair = structural.length
  client.voidConversation('c_newpair01aa')
  assert.equal(structural.length, afterPair + 1, '作废一条会话没触发落盘：盘上还留着已经作废的密钥')
})

test('连续两次解不开同一会话就主动作废：对称于手机端"两帧解不开就丢配对"', () => {
  const { client, slots, feed, gone } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_000111222333', clientId: 'k_mp', pairingToken: slot.token })

  // 一条形状合法（标准 base64）、MAC 解不开的密文——像是手机端密钥已经被换掉。
  const junk = Buffer.alloc(24 + 16 + 4, 7).toString('base64')
  feed({ t: 'enc', sessionId: 'c_000111222333', ciphertext: junk })
  assert.equal(client.hasClient('c_000111222333'), true, '一次解不开就丢配对太激进：小程序自己也给两帧机会')
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
  assert.equal(client.hasClient('c_111222333444'), true, '会话不该被误废')
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
  assert.equal(client.hasClient('c_222333444555'), true, '会话必须还在')
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
  // 两个概念必须分开断言，这正是这次改动的全部要点：
  // **会话与密钥留着**（手机回前台不用重新扫码），但**成员表要摘干净**（没人能收了）。
  assert.ok(
    client.conversationIds().includes('c_333444555666'),
    '客户端一走就把会话删了 → 手机切后台再回来必须重新扫码（旧实现的产品缺陷）',
  )
  assert.equal(
    client.hasClient('c_333444555666'),
    false,
    'peer-left 之后成员表还留着它 → 本端以为有人能收，广播与审批都会发进一条空会话',
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

  // 空会话不再出站（真机后果：手机走了之后主机每 15 秒还往里发三帧，
  // 中继每一帧计一次丢帧，`droppedFrames` 被这一路噪声主导——实测 45 秒涨 9）。
  const sentWhileEmpty = client.send('c_333444555666', {
    t: PAYLOAD_TYPES.evRunState,
    sessionId: 'ses_x',
    state: 'running',
  } as EvPayload)
  assert.equal(sentWhileEmpty, false, '没人连着还照样加密外发：中继只会把它计成丢帧')

  // 上面那条**不是**"出站路径被 peer-left 断了"——D3 要保的恰恰是这条能恢复：
  // 手机回前台时中继发一条**不带 pairingToken** 的重连通知，成员表必须因此重新长出来。
  feed({ t: 'peer-joined', sessionId: 'c_333444555666', clientId: 'k_mp' })
  assert.equal(
    client.hasClient('c_333444555666'),
    true,
    '重连通知没登记成员：手机回前台之后、在它第一次发东西之前，本端一直以为这条会话没人',
  )
  assert.equal(
    client.send('c_333444555666', {
      t: PAYLOAD_TYPES.evRunState,
      sessionId: 'ses_x',
      state: 'running',
    } as EvPayload),
    true,
    '重连之后仍然发不出去：手机切个后台就再也收不到更新，只能杀掉小程序重进',
  )
})

/**
 * 2026-10-05 用户报：「mp 端解除配对，dsh 端执行的是手机离线」。
 *
 * 手机 unpair() 发的是 session-leave，中继把它转成 peer-left —— 与「socket 断了」
 * 是**同一帧**。主机据此只摘成员、留着会话，于是 clientCount=0 而
 * conversationCount=1，pill 说「手机离线」。可手机那边 unpair() 已经 _forgetPairing()
 * 清掉 convId，**再也不会回来**：主机这条会话是条永远清不掉的幽灵。
 *
 * 所以 peer-left 多了 unpaired 标记，把这两种情况分开：
 *   - 不带（掉线）→ 上一条判据那套行为，一个字都不许变（D3 仍然成立）；
 *   - 带 true（主动解配）→ 会话一并作废，pill 回到「未配对」。
 *
 * 判据钉的是 conversationCount（pill 读的就是它），不是「内部发生了什么」。
 */
test('peer-left 带 unpaired：手机主动解配 → 会话一并作废（别再显示成「手机离线」）', () => {
  const { client, slots, feed, gone } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_444555666777', clientId: 'k_mp', pairingToken: slot.token })
  assert.equal(client.conversationCount, 1, '夹具自检：会话已建立')

  feed({ t: 'peer-left', sessionId: 'c_444555666777', clientId: 'k_mp', unpaired: true })
  assert.equal(
    client.conversationCount,
    0,
    '手机已经解配了，主机还留着这条会话 → conversationCount 恒为 1，pill 永远显示「手机离线」，用户永远等不到「未配对」',
  )
  assert.ok(!client.conversationIds().includes('c_444555666777'), '会话没作废：这条幽灵没有任何东西会清掉它')
  assert.ok(
    gone.some((id) => id === 'c_444555666777'),
    '上层没收到 onConversationGone：runtime 不会去清这条会话的运行态',
  )
})

test('peer-left 不带 unpaired（掉线）时行为一个字都不许变：D3 仍然留着会话', () => {
  const { client, slots, feed } = harness()
  const slot = slots.create(120_000)
  feed({ t: 'peer-joined', sessionId: 'c_555666777888', clientId: 'k_mp', pairingToken: slot.token })

  feed({ t: 'peer-left', sessionId: 'c_555666777888', clientId: 'k_mp' })
  assert.ok(
    client.conversationIds().includes('c_555666777888'),
    '把掉线也当成解配了：手机切一下后台就被要求重新扫码（D3 这条命脉不能动）',
  )
  assert.equal(client.conversationCount, 1, '掉线不该动 conversationCount')
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
  assert.equal(client.hasClient('c_ffffffff0000'), false, '不该顺手把陌生 convId 建成本端会话')
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

  // 真机那一幕：剩下这条会话的**手机退到后台**了（会话与密钥都还在，D3 要它活着）。
  // 原来 `hasPeer` 答的是"有没有密钥"，于是主机每 15 秒照发三帧，
  // 中继每一帧计一次丢帧——`droppedFrames` 被这一路噪声主导（实测 45 秒涨 9）。
  feed({ t: 'peer-left', sessionId: 'c_666777888999', clientId: 'k1' })
  assert.equal(client.broadcast(payload), 0, '没人连着的那条会话仍然被广播：白加密 + 中继计丢帧')
  feed({ t: 'peer-joined', sessionId: 'c_666777888999', clientId: 'k1' })
  assert.equal(client.broadcast(payload), 1, '手机回前台之后广播必须恢复（重连通知也要登记成员）')
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
  assert.equal(client.hasClient('c_888999aaabbb'), true, '会话必须还在')
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
  assert.equal(client.hasClient('c_old000000001'), false, '剪了内存却没关通道')
  assert.deepEqual(gone, ['c_old000000001'], '上层不知道：status.json 与自动补发都不会动')
  const leave = outOf('session-leave')
  assert.equal(leave.length, 1, '没发 session-leave：中继会继续把手机的密文转给一条已经没有钥匙的通道')
  assert.equal((leave[0] as { sessionId: string }).sessionId, 'c_old000000001')
  assert.equal(client.hasClient('c_new000000002'), true, '刚有收发的通道被顺手剪了')
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
  assert.equal(client.hasClient('c_cap0'), true, '刚发过数据的通道被剪：手机会突然撞上"会话已失效"')
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

/* ── liveness probe (the half-open connection found in production 2026-10-05) ── */

test('probe: asks a ping every 20s; ping/pong is a frame pair the protocol already has', async () => {
  const h = harness()
  startProbe(h.client, h.socket)
  await h.clock.advance(0)
  assert.equal(h.outOf('ping').length, 0, 'no ping right after attach')
  await h.clock.advance(20_000)
  assert.equal(h.outOf('ping').length, 1, 'one question per interval')
  const ping = h.outOf('ping')[0]
  assert.ok(ping, 'the ping must have been sent')
  assert.equal(typeof ping.ts, 'number', 'ping carries a timestamp')
  h.feed({ t: 'pong', ts: ping.ts })
  await h.clock.advance(10_000)
  assert.equal(h.socket.readyState, SOCKET_OPEN, 'answered in time must not be killed')
  await h.clock.advance(10_000)
  assert.equal(h.outOf('ping').length, 2, 'the chain reschedules itself')
})

test('probe: no pong within 10s means terminate (close never fires on a half-open socket)', async () => {
  const h = harness()
  startProbe(h.client, h.socket)
  await h.clock.advance(20_000)
  assert.equal(h.outOf('ping').length, 1)
  await h.clock.advance(10_000)
  assert.equal(
    h.socket.readyState,
    3,
    'must terminate: close() on a half-open socket waits for a handshake that never comes',
  )
  const probeLog = h.logs.filter((line) => line.indexOf('relay probe timeout') === 0)
  assert.equal(probeLog.length, 1, 'the timeout must leave a trace')
  await h.clock.advance(60_000)
  assert.equal(h.outOf('ping').length, 1, 'the chain stops once the socket is dead')
})

test('probe: stop or socket swap collects the chain, never kills the new connection', async () => {
  const h = harness()
  startProbe(h.client, h.socket)
  await h.clock.advance(20_000)
  assert.equal(h.outOf('ping').length, 1)
  h.client.stop()
  await h.clock.advance(120_000)
  assert.equal(h.outOf('ping').length, 1, 'no questions after stop')
  const last = h.states[h.states.length - 1]
  assert.ok(last, 'a state must have been emitted')
  assert.equal(last.relay, 'offline', 'stop lands the state on offline')
})

/* ── 2026-10-06 缺陷修复：重连定时器只许有一只 ──────────────────────────── */

test('握手超时那条路只许排出一次重连：双 timer 会把退避翻成 4 倍，还会掐掉刚建立的连接', async () => {
  // 现场：握手超时回调里 `terminate()` + `scheduleReconnect('握手超时')`，
  // 而 terminate() 会逼出 close 事件、那条路径再 `scheduleReconnect('closed …')` 一次。
  const h = harness()
  const priv = h.client as unknown as { scheduleReconnect(problem: string): void; connect(): void }
  let connects = 0
  priv.connect = () => {
    connects += 1
  }

  priv.scheduleReconnect('握手超时')
  priv.scheduleReconnect('closed 1006')
  assert.equal(
    h.clock.pending,
    1,
    `排了 ${h.clock.pending} 个重连定时器：两个 timer 各自到点各连一次，后一个还会掐掉前一个刚建立的连接`,
  )

  await h.clock.advance(2_000) // 退避第一档 1000ms + 抖动 ≤ 500ms
  assert.equal(connects, 1, '退避到点必须重连**一次**（双 timer 会连两次）')
  assert.equal(h.clock.pending, 0, '到点之后句柄没清：下一次重连会被"已经排着一次"那道闸挡回去')

  priv.scheduleReconnect('again')
  assert.equal(h.clock.pending, 1, '一次重连之后就再也不排了：重连永久停摆（比双 timer 更糟）')

  h.client.stop()
  assert.equal(h.clock.pending, 0, 'stop() 之后不许留下重连定时器：插件走了还去建 socket')
})

/* ── 2026-10-07 审计：作废的"出口"与出站的"体积闸" ────────────────────── */

test('作废帧没发出去就不许记账：否则「手机唯一的出口」在中继重连期间被永久堵死', () => {
  // 现场：`voidConversation` 原来先 `voided.add()` 再 `raw()`，而 `raw()` 对非 OPEN 的
  // socket 是静默 false（中继抖一下，退避最长 30 秒以上）。于是这一帧没发出去，通道却
  // 已经被标成"声明过了"，此后**任何**重试都被那道闸挡掉——包括设计上明确依赖的
  // `onEncrypted` → 「本端已无钥匙」→ 再作废一次那条路。
  //
  // 症状：中继那边路由还在，手机继续对着一个听不见的对端发帧，既无回执也撞不上
  // `unknown_session`，而 index.ts 明明承诺过"手机端会显示请重新配对"。
  const h = harness()
  h.socket.readyState = 3 // CLOSED：正好是"作废那一刻中继正在退避"

  h.client.voidConversation('c_aabbccddeeff')
  assert.equal(h.outOf('session-leave').length, 0, '前提：socket 不在 OPEN，这一帧确实没发出去')

  // 重连成功。手机还在旧 convId 上说话 —— 主机必须**再声明一次**。
  h.socket.readyState = 1 // OPEN
  h.feed({ t: 'enc', sessionId: 'c_aabbccddeeff', seq: 1, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })

  const leave = h.outOf('session-leave')
  assert.equal(leave.length, 1, '作废帧没发出去就等于"还没说过"：手机那条路必须还能重试，否则主机重启后手机永远转圈')
  assert.equal((leave[0] as { sessionId: string }).sessionId, 'c_aabbccddeeff')
  assert.ok(
    h.logs.some((line) => line.includes('session-leave not sent')),
    '没发出去要留痕：否则"声明过了"与"声明成功了"在排障时长得一模一样',
  )
})

test('出站帧超上限时当成没发出去：超限的密文会被中继整帧拒掉，而主机原来只记日志', () => {
  // `encToClient` 是协议层唯一执行 `MAX_CIPHERTEXT_BYTES` 的地方，注释写着"超过上限
  // 对侧静默丢帧"。主机原来手拼 `{t:'enc',…}`，这条路上一个体积闸都没有。
  // 而超限的后果不是"这帧没了"：中继回一条 `error{bad_frame}`，插件对 `error` 只记日志，
  // 手机于是走完 15 秒超时留下一句"读不到"——本仓库最典型的「什么也没发生」。
  const h = harness()
  const slot = h.slots.create(120_000)
  h.feed({ t: 'peer-joined', sessionId: 'c_aabbccddeeff', clientId: 'k_mp', pairingToken: slot.token })
  h.socket.sent.length = 0

  const huge: EvPayload = {
    t: 'ev.message_delta',
    sessionId: 'c_aabbccddeeff',
    messageId: 'm1',
    // base64 再 base64，密文长度 ≈ 正文的 16/9：900KB 正文必然越过 1040384 的上限。
    delta: 'x'.repeat(900_000),
  } as EvPayload
  const sent = h.client.send('c_aabbccddeeff', huge)

  assert.equal(sent, false, '过不了体积闸就必须说"没发出去"：返回 true 会让 runtime 把它记成已送达')
  assert.equal(
    h.socket.sent.filter((line) => line.includes('"t":"enc"')).length,
    0,
    '超限的 enc 帧不许交给 socket：中继的 ws.maxPayload 会因此把**整条连接**掐掉（1009）',
  )
  assert.ok(
    h.logs.some((line) => line.includes('wire size cap')),
    `体积闸要留痕（现场排障全靠这一行），实际：${h.logs.join(' | ')}`,
  )

  // 反证：正常大小的帧仍然照发——闸不能变成"什么都发不出去"。
  const small: EvPayload = {
    t: 'ev.message_delta',
    sessionId: 'c_aabbccddeeff',
    messageId: 'm2',
    delta: '正常长度的一小段正文',
  } as EvPayload
  assert.equal(h.client.send('c_aabbccddeeff', small), true, '闸只拦超限的帧：正常的流式输出必须照发')
  assert.equal(h.socket.sent.filter((line) => line.includes('"t":"enc"')).length, 1)
})

/**
 * `pair-fail` 必须把**是哪一张码**失败的交给接线方（2026-10-07 补）。
 *
 * ## 缺陷形状
 *
 * 这一帧原先只有 `reason`，而 `index.ts` 的处理是"作废**当前展示的那张**"——
 * 于是它只能拿 `active.pairing` 顶罪。多码并存时那会**作废错的那张**：
 * 屏幕上是码 B（完全有效），用户扫了一张早就过期的码 A → 中继回
 * `invalid_or_expired` → B 被记进 `spentTokens` 并 forget。
 *
 * 症状不是"多扫一次码"：B 的 PSK 被丢弃意味着那条配对通道作废，
 * 而这正是本文件头引用的那起「取错 PSK 全线解不开」的前置条件。
 *
 * 这一层只验**透传**：接线方拿它做什么是 index.ts 的责任，两条判据分开写。
 */
test('pair-fail 的 pairingToken 原样交给接线方', () => {
  const h = harness()
  h.feed({ t: 'pair-fail', reason: 'invalid_or_expired', pairingToken: '999999' })
  assert.equal(h.pairFails.length, 1, '必须回调（不回调 = 屏幕上那张死码一直挂着）')
  assert.equal(h.pairFails[0]?.reason, 'invalid_or_expired')
  assert.equal(h.pairFails[0]?.pairingToken, '999999', '必须点名是哪一张：接线方靠它避免把"当前展示的那张"误当成废码')
})

test('反向判据：中继没带 token 时给 undefined（而不是空串或猜一个）', () => {
  // 更老的中继仍在跑（升级要重启容器，插件升级只要重开 Harness）。
  // 那一侧必须让接线方**知道**"没有这个信息"，好退回旧行为；
  // 给空串会让 `forget('')` 变成一次无意义的查表，而接线方也分不出两种情况。
  const h = harness()
  h.feed({ t: 'pair-fail', reason: 'already_used' })
  assert.equal(h.pairFails.length, 1)
  assert.equal(h.pairFails[0]?.pairingToken, undefined, '缺省必须是 undefined，语义是"中继没告诉我们"')
})
