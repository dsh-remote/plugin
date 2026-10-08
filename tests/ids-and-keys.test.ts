/**
 * ids-and-keys.test — `core/keys.ts`：PairingSlots（待配对码槽）与 ConversationBook（会话密钥簿）。
 *
 * 这两本账是"零知识"能落地的唯一原因：PSK 只在主机内存里，中继只见 6 位码。
 * 一旦簿记出错，故障形状永远是同一句话——**配对显示成功，但每一帧都解不开**：
 *
 * - 取错码（用了"最新那张"而不是"手机实际用那张）：旧实现的线上事故
 *   （取证 docs/legacy-spec/relay-and-wireformat.md §2.3、HANDOFF.md §4.5、
 *   `git show 6e33017`；`docs/DESIGN.md §2.1` 的 B5 要求两把方向密钥必须不同）。
 * - 提前清掉 PSK：`peer-joined` 找不到密钥 → 静默丢 peer → 手机列表永远空白（§2.3 硬约束 1）。
 * - 表只有单槽：自动补发的码与手工 `/drc pair` 的码互相挤掉。
 * - 配对码/PSK 的**形状**也是契约：小程序只接受 `/^\d{6}$/` 的码（红线 21），
 *   并在 `paired` 之后同步 base64 解码 PSK（红线 22：非法 base64 会让它卡在"正在配对…"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { base64Text, derivePskKey, open, seal } from 'dsh-remote-wire'
import { ConversationBook, PairingSlots, type PairSlot } from '../src/core/keys.js'

/** 可推进的假时钟：过期判定必须完全确定，不能靠 sleep(1ms)。 */
function ticking(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms
    },
  }
}

test('一条配对建出两把不同的方向密钥：主机用 h2c 密封、用 c2h 打开（B5）', () => {
  const book = new ConversationBook()
  const slot = new PairingSlots(ticking().now).create(120_000)
  const conversation = book.open({ id: 'c_aaaabbbbcccc', psk: slot.psk, now: 1_700_000_000_000 })

  assert.equal(conversation.kC2H.length, 32, '会话密钥必须是 32 字节：seal 会直接抛（KEY_BYTES 校验）')
  assert.equal(conversation.kH2C.length, 32, '两个方向的密钥都必须是 32 字节')
  assert.equal(
    conversation.kC2H.some((byte, index) => byte !== conversation.kH2C[index]),
    true,
    '两把方向密钥相同 → 客户端可以拿主机的发送密钥反过来解下行，方向分离白做',
  )
  assert.deepEqual(
    [...conversation.kC2H],
    [...derivePskKey(slot.psk, 'c2h', 'c_aaaabbbbcccc')],
    'kC2H 必须与协议层派生逐字节一致：差一个字节手机端就解不开',
  )
  assert.deepEqual(
    [...conversation.kH2C],
    [...derivePskKey(slot.psk, 'h2c', 'c_aaaabbbbcccc')],
    'kH2C 必须与协议层派生逐字节一致',
  )

  // 镜像侧核对：主机密封的下行，手机用同一 PSK 派生的 h2c 密钥必须解得开。
  const record = seal(conversation.kH2C, { t: 'ev.run_state', state: 'idle' })
  assert.equal(
    open(derivePskKey('AgAAAAAAAAAAAAAAAAAAAA==', 'h2c', 'c_aaaabbbbcccc'), { ciphertext: record.ciphertext }),
    null,
    '换一把 PSK 派生的密钥必须解不开（B3 的失败形状：返回 null 而不是抛）',
  )
  assert.equal(
    open(derivePskKey(slot.psk, 'h2c', 'c_aaaabbbbcccc'), { ciphertext: record.ciphertext }) !== null,
    true,
    '手机按冻结 KDF 派生的密钥解不开主机的下行 → "配对成功但每一帧都解不开"',
  )
})

test('同一把 PSK 在不同 convId 下必须派生不同密钥（convId 参与上下文绑定）', () => {
  const psk = new PairingSlots(ticking().now).create(120_000).psk
  const one = derivePskKey(psk, 'h2c', 'c_000000000001')
  const two = derivePskKey(psk, 'h2c', 'c_000000000002')
  assert.equal(
    one.some((byte, index) => byte !== two[index]),
    true,
    'convId 没参与派生：两条配对通道的流量可以互解，配对之间不再互相隔离',
  )
})

/**
 * 2026-10-04：这一条原本是 `closeBefore(generation)` 的正向测试，
 * 而 `closeBefore` 连同 `Conversation.generation` 一起被删了 ——
 * 理由见下（它把"主机自己重启"误判成"中继重启"，每次重启都自毁全部配对）。
 *
 * 现在要钉住的是**反向**判据：**簿记里没有任何"按连接代号清会话"的能力**。
 * 它必须由 `relay-client.test.ts` 的"主机重启后能续用"那一条在链路层兜住，
 * 这里只保证没有后门 —— 因为只要这个方法还在，`hello-ok` 里那行误伤随时会被加回来。
 */
test('簿记不再有"按连接代号清会话"的能力：主机重启与中继重启在这里长得一样', () => {
  const book = new ConversationBook()
  book.open({ id: 'c_keep_1', psk: 'AAAAAAAAAAAAAAAAAAAAAA==', now: 1 })
  book.open({ id: 'c_keep_2', psk: 'AgAAAAAAAAAAAAAAAAAAAA==', now: 2 })

  // `closeBefore` 曾是唯一的清理入口。现在清会话只有两条路：
  // **本端主动作废**（`close`，由解配 / 剪枝 / 解不开两次触发）与**上限剪枝**（`pruneStale`）。
  assert.equal(
    typeof (book as unknown as { closeBefore?: unknown }).closeBefore,
    'undefined',
    'closeBefore 又出现了：它无法区分主机重启与中继重启，加回来就是"每次重启都要重新扫码"',
  )
  assert.equal(typeof book.close, 'function', '本端主动作废这条路必须还在（解配与剪枝都走它）')
  assert.equal(book.size, 2, `簿里只剩 ${book.size} 条：没有任何调用方该在重建连接时清簿`)
})

test('close/has/get 对不存在的 id 都是安全的空操作：解配与断连路径不能抛', () => {
  const book = new ConversationBook()
  assert.equal(book.close('c_none'), false, 'close 不存在的会话返回了 true：调用方会以为真的掉了一条')
  assert.equal(book.has('c_none'), false)
  assert.equal(book.get('c_none'), undefined)
  assert.equal(book.size, 0)
  assert.deepEqual(book.ids(), [])

  book.open({ id: 'c_real', psk: 'AAAAAAAAAAAAAAAAAAAAAA==', now: 10 })
  assert.equal(book.close('c_real'), true, 'close 存在的会话必须返回 true')
  assert.equal(book.has('c_real'), false, 'close 之后 has 仍为真：hasPeer 会谎报有对端，审批卡发出去没人收')
  assert.equal(book.size, 0, '会话数没降下来')
})

test('同一条 convId 重复 open 是覆盖而不是并出两条：簿记键只能是 convId', () => {
  const book = new ConversationBook()
  const first = book.open({ id: 'c_dup', psk: 'AAAAAAAAAAAAAAAAAAAAAA==', now: 1 })
  const second = book.open({ id: 'c_dup', psk: 'AgAAAAAAAAAAAAAAAAAAAA==', now: 2 })
  assert.equal(book.size, 1, `一条 convId 攒出 ${book.size} 条会话：广播会给同一条通道发两遍`)
  assert.notEqual(first.psk, second.psk, '夹具自检：两次 PSK 不同')
  assert.equal(book.get('c_dup')?.psk, second.psk, '后来的那张码没覆盖：手机用新码配对，主机还攥着旧密钥')
  assert.equal(book.get('c_dup')?.createdAt, 2, 'createdAt 要跟着更新：status.json 的码年龄判据（<25s）读它')
})

test('clientCount 数的是**手机台数**，不是会话数：解配重配会让会话变多而手机没变多', () => {
  const book = new ConversationBook()
  // 夹具自检：open() 那一刻成员表是空的，配对刚发生、还没有任何一帧过来。
  const first = book.open({ id: 'c_1', psk: 'AAAAAAAAAAAAAAAAAAAAAA==', now: 1 })
  assert.equal(book.clientCount(), 0, 'open() 里不预填成员：此刻确实还没有手机发过帧')

  first.clientIds.add('phone-1')
  assert.equal(book.clientCount(), 1, '一台手机进来了')

  // 「解除配对 → 重新配对」会开一条**新会话**，手机还是那一台。
  // 拿会话数当手机数报的话，用户解完配对看到数字反而变大 ——
  // 那个现象与"我的解配没生效"完全一致。
  const second = book.open({ id: 'c_2', psk: 'AgAAAAAAAAAAAAAAAAAAAA==', now: 2 })
  second.clientIds.add('phone-1')
  assert.equal(book.size, 2, '夹具自检：两条会话')
  assert.equal(book.clientCount(), 1, '同一台手机不能被算成两台')

  second.clientIds.add('phone-2')
  assert.equal(book.clientCount(), 2, '第二台手机进来')

  // 手机解配：会话留着（D3），但这台不再算连着 ——
  // 不摘的话没有任何东西会清掉它，那个状态会一直挂在电脑上。
  first.clientIds.delete('phone-1')
  assert.equal(book.size, 2, '解配不许删会话：手机回前台还要用同一个 convId')
  assert.equal(book.clientCount(), 2, 'phone-1 走了但它还在 c_2 里（重配那条），所以仍是两台')

  second.clientIds.delete('phone-2')
  second.clientIds.delete('phone-1')
  assert.equal(book.clientCount(), 0, '全走了就该是 0：status.json 说有人连着而实际没人，是最难查的一种错')
})

test('PairingSlots 超上限时淘汰最旧那张而不是拒绝新建：发不出去比少一张更糟', () => {
  const clock = ticking()
  const slots = new PairingSlots(clock.now, 3)
  const created: PairSlot[] = []
  for (let i = 0; i < 3; i++) {
    created.push(slots.create(60_000))
    clock.advance(1_000)
  }
  assert.equal(slots.size, 3, '夹具自检：三张码都该在表里')

  const fourth = slots.create(60_000)
  assert.equal(slots.size, 3, `超上限后表长到了 ${slots.size}：无界内存（旧实现靠运维狂敲 /drc pair 撑爆过这张表）`)
  assert.equal(
    slots.resolveFor(fourth.token)?.token,
    fourth.token,
    '新建的那张被拒了 → 用户扫出来的码主机根本不认，配对永远失败',
  )
  const [oldest, middle, newest] = created as [PairSlot, PairSlot, PairSlot]
  assert.equal(
    slots.resolveFor(oldest.token),
    null,
    `被淘汰的不是最旧那张（最旧=${oldest.token}）：Map 的插入序不可靠，必须按 createdAt 排`,
  )
  assert.equal(slots.resolveFor(middle.token) !== null, true, '只该淘汰一张：把第二张也挤掉会误杀正在配对的用户')
  assert.equal(slots.resolveFor(newest.token) !== null, true, '最新的两张都必须还在')
})

test('resolveFor 过期返回 null：过期就是过期，调用方必须拒绝这条配对而不是猜', () => {
  const clock = ticking()
  const slots = new PairingSlots(clock.now)
  const slot = slots.create(10_000)
  assert.equal(slots.resolveFor(slot.token)?.psk, slot.psk, '未到期的码必须取得到 PSK')

  clock.advance(10_001)
  assert.equal(slots.resolveFor(slot.token), null, '过期的码仍取得到 PSK：本地表会无限膨胀，且中继早就把它扫掉了')
  assert.equal(slots.resolveFor(undefined), null, '没有 token 时必须返回 null：退化成"取最新一张"就是那起多码事故')
  assert.equal(slots.resolveFor(''), null, '空串同样不许退化成"取最新一张"')
  assert.equal(slots.resolveFor('000000'), null, '本地没有这张码就报 null，让调用方拒绝配对')
})

test('applyServerTtl 用服务端权威 TTL 改写本地过期；未知 token 返回 false 并留下痕迹', () => {
  const clock = ticking()
  const slots = new PairingSlots(clock.now)
  const slot = slots.create(1_000) // 本地只给 1 秒
  clock.advance(2_000)
  assert.equal(slots.resolveFor(slot.token), null, '夹具自检：本地已经判它过期')

  assert.equal(slots.applyServerTtl(slot.token, 120_000), true, '服务端 TTL 没能落到这张码上')
  assert.equal(
    slots.resolveFor(slot.token)?.expiresAt,
    slot.createdAt + 120_000,
    // 基线统一到**发起时刻**（与 PairingWindow.applyServerTtl 同一口径）：
    // 两处各用一条基线（这里曾是"pair-ready 到达时刻"）会差一个 RTT，
    // 屏幕上那张码的过期时刻与真正取 PSK 的口径就对不上了。
    '过期时间没按服务端值改写，或基线不是 createdAt',
  )
  assert.equal(
    slots.applyServerTtl('999999', 120_000),
    false,
    '为一张本地没有的码改写 TTL 必须返回 false：那是"配对流程出现了第二份真相"的信号',
  )
})

test('prune 只清过期项并如实报数：清多了会误杀正在配对的码', () => {
  const clock = ticking()
  const slots = new PairingSlots(clock.now)
  const short = slots.create(1_000)
  clock.advance(500)
  const long = slots.create(120_000)
  clock.advance(600) // short 已过期（1100>1000），long 还剩

  const removed = slots.prune()
  assert.equal(removed, 1, `清掉了 ${removed} 张：应为 1 张`)
  assert.equal(slots.resolveFor(short.token), null, '过期的那张必须已经没了')
  assert.equal(
    slots.resolveFor(long.token) !== null,
    true,
    '未到期的那张被顺手清了：用户刚扫出来的码变成"无效或已过期"',
  )
  assert.equal(slots.prune(), 0, '第二次 prune 不该再报东西')
})

test('取密钥必须走 resolveFor，不许"拿最新那张"：用 A 码建的会话拿 B 码的 PSK 一定解不开', () => {
  const clock = ticking()
  const slots = new PairingSlots(clock.now)
  const usedByPhone = slots.create(120_000) // 屏幕上那张、手机真正扫的
  clock.advance(1_000)
  const newer = slots.create(120_000) // 自动补发的另一张

  // 夹具自检：两张不同，且"最新那张"就是 newer（展示位/取最新这条错路当年走的就是它）。
  assert.equal(newer.token !== usedByPhone.token, true, '夹具自检：两张不同')
  assert.equal(
    newer.createdAt > usedByPhone.createdAt,
    true,
    '夹具自检：newer 确实是更晚创建的那张（原来的 latest() 会给它）',
  )

  // 事故形状：会话是用 A 建的，却按"最新那张"（B）的 PSK 派生密钥。
  const book = new ConversationBook()
  const picked = slots.resolveFor(usedByPhone.token)
  assert.ok(picked !== null, '按手机实际用的那张码必须取到 PSK')
  const correct = book.open({ id: 'c_pair', psk: picked.psk, now: clock.now() })
  const mistaken = book.open({ id: 'c_wrong', psk: newer.psk, now: clock.now() })

  const record = seal(correct.kH2C, { t: 'ev.session_changed', sessions: [] })
  assert.equal(
    open(derivePskKey(newer.psk, 'h2c', 'c_wrong'), { ciphertext: record.ciphertext }),
    null,
    '取错码反而解得开：说明密钥没有真正绑定到所用那张码',
  )
  assert.equal(
    open(mistaken.kH2C, { ciphertext: record.ciphertext }),
    null,
    '取错码的结果必须是解不开（这条断言就是那次线上事故的可执行反面）',
  )
  assert.equal(
    open(correct.kH2C, { ciphertext: record.ciphertext }) !== null,
    true,
    '夹具自检：按所用那张码取的密钥必须解得开',
  )
})

test('配对码必须是 6 位数字：小程序只接受 /^\\d{6}$/，否则扫出来是"无法识别"', () => {
  const slots = new PairingSlots(ticking().now)
  for (let i = 0; i < 50; i++) {
    const token = slots.create(60_000).token
    assert.match(token, /^\d{6}$/, `生成的配对码 ${JSON.stringify(token)} 不符合手机侧的归一化判据：这条码扫了没反应`)
    assert.equal(token.length, 6, '位数变了要同时动三处（中继校验、主机生成、小程序归一化），而小程序改不了')
  }
})

test('PSK 必须是 16 字节的标准 base64（24 字符）：非法 base64 会让小程序卡在"正在配对…"', () => {
  const slots = new PairingSlots(ticking().now)
  for (let i = 0; i < 20; i++) {
    const psk = slots.create(60_000).psk
    assert.equal(psk.length, 24, 'PSK 的 base64 文本必须是 24 字符（B7：16 字节 → 标准带 padding）')
    assert.equal(
      base64Text.safeParse(psk).success,
      true,
      `PSK ${psk} 不是标准 base64：小程序 _onPaired 里同步解码会抛异常且不在 try 内`,
    )
    assert.equal(Buffer.from(psk, 'base64').length, 16, '解码后必须是 16 字节')
  }
})

test('两张码的 PSK 必须互不相同：PSK 每次配对轮换、单次有效（B7）', () => {
  const slots = new PairingSlots(ticking().now)
  const psks = new Set<string>()
  const tokens = new Set<string>()
  for (let i = 0; i < 100; i++) {
    const slot = slots.create(60_000)
    psks.add(slot.psk)
    tokens.add(slot.token)
  }
  assert.equal(
    tokens.size,
    100,
    `${100 - tokens.size} 次生成的配对码与已有的重复：表按 token 索引，撞码会静默覆盖前一张的 PSK → 偶发的"扫了配不上"`,
  )
  assert.equal(psks.size, 100, 'PSK 出现重复：两张码共享密钥，一次性作废失去意义')
})

test('ConversationBook 的初始簿记形状：seqHost 从 0 起、clientIds 空、时刻如实记下', () => {
  const book = new ConversationBook()
  const conversation = book.open({
    id: 'c_shape',
    psk: 'AAAAAAAAAAAAAAAAAAAAAA==',
    now: 1_700_000_999_000,
  })
  assert.equal(conversation.id, 'c_shape', '会话 id 必须逐字保留（F3：加工过一次就路由不回去）')
  assert.equal(conversation.seqHost, 0, '本端出站序号从 0 开始，第一帧发出去是 1')
  assert.equal(conversation.clientIds.size, 0, '新配对不该凭空带上客户端名单（D4 的成员校验用它）')
  assert.equal(conversation.createdAt, 1_700_000_999_000, 'createdAt 必须是传入时刻而不是 Date.now()：假时钟下要可核对')
  assert.equal(
    conversation.restored,
    undefined,
    '新配对的会话不是恢复出来的：剪枝会按它选 TTL，标错会让"用户早就配好的通道"被 24 小时规则清掉',
  )
})

test('过期判据的边界：expiresAt 恰好等于此刻时仍算有效（resolveFor 与 prune 都是严格小于）', () => {
  const clock = ticking()
  const slots = new PairingSlots(clock.now)
  const slot = slots.create(10_000)
  clock.advance(10_000) // 正好到点
  assert.equal(slot.expiresAt, clock.now(), '夹具自检：此刻正好是过期时刻')
  assert.equal(
    slots.resolveFor(slot.token) !== null,
    true,
    '边界判据必须与 prune() 一致：一处用 <= 一处用 < 会让"能显示但取不到密钥"——又是静默丢 peer',
  )
  assert.equal(slots.prune(), 0, 'prune() 与 resolveFor 在这一刻说法不一致：取密钥还说有效，剪枝却已经把这张码清了')
  clock.advance(1)
  assert.equal(slots.resolveFor(slot.token), null, '超过一刻就必须判过期')
  assert.equal(slots.prune(), 1, '超过一刻就必须剪掉：status.json 里的码年龄判据靠这条一致')
})

// ── 跨进程续用（2026-10-04）────────────────────────────────────────────
//
// 免扫码重连的全部机制：`(psk, convId)` 能重新派生方向密钥（B5），
// 而手机侧的 installId 与 convId 本来就持久化在 wx storage 里 —— 手机侧零改动。

test('snapshot → restore 之后派生的密钥逐字节相同：这是免扫码重连的唯一根据', () => {
  const slot = new PairingSlots(ticking().now).create(120_000)
  const first = new ConversationBook()
  const original = first.open({ id: 'c_persist_1', psk: slot.psk, now: 1_000 })
  original.clientIds.add('phone-1')
  original.seqHost = 7

  const second = new ConversationBook()
  const restoredIds = second.restore(first.snapshot(), 999_000)
  assert.deepEqual(
    restoredIds,
    ['c_persist_1'],
    `恢复出 ${JSON.stringify(restoredIds)} 条：手机上就会撞 unknown_session`,
  )

  const back = second.get('c_persist_1')
  assert.ok(back, '恢复后 get 不到这条会话')
  assert.deepEqual([...back.kC2H], [...original.kC2H], 'kC2H 恢复后变了：手机发的主机解不开，表现为静默黑洞')
  assert.deepEqual([...back.kH2C], [...original.kH2C], 'kH2C 恢复后变了：主机发的手机解不开')
  assert.equal(back.seqHost, 7, 'seqHost 没带过来：本地编号跳号，排查密文顺序时对不上')
})

test('恢复出来的会话不带 clientIds：那一瞬没有人连着主机，谎报会让广播打进空会话', () => {
  const source = new ConversationBook()
  const original = source.open({ id: 'c_x', psk: 'AAAAAAAAAAAAAAAAAAAAAA==', now: 1 })
  original.clientIds.add('phone-1')
  assert.equal(source.clientCount(), 1, '夹具自检：原簿里有一台手机')

  const book = new ConversationBook()
  book.restore([{ id: 'c_x', psk: 'AAAAAAAAAAAAAAAAAAAAAA==', seqHost: 0, createdAt: 1, lastActivityAt: 1 }], 100)
  const restored = book.get('c_x')
  assert.equal(restored?.clientIds.size, 0, '把旧的成员名单也恢复了：主机一启动就往每条会话广播，手机还没回来')
  assert.equal(book.clientCount(), 0, 'clientCount 因此虚报"有手机连着"，pill 会显示已配对而实际没人')
  assert.equal(book.hasClient('c_x'), false, 'hasClient 为真 → broadcast 闸门失效，这些帧全被中继计成丢帧')
  // 但密钥必须在：有密钥才是"等着手机回来"，没密钥就真的只能重扫了。
  assert.equal(book.has('c_x'), true, '有密钥 ≠ 有人在线，这两条判据必须分开')
})

test('恢复出来的会话走另一条剪枝 TTL：长假的手机不该在主机一启动就被清掉', () => {
  const policy = { idleTtlMs: 24 * 3_600_000, restoredIdleTtlMs: 7 * 24 * 3_600_000, maxConversations: 64 }
  const record = (id: string) => ({ id, psk: 'AAAAAAAAAAAAAAAAAAAAAA==', seqHost: 0, createdAt: 0, lastActivityAt: 0 })

  // 主机重启后簿里同时有"新配对的"与"从盘上恢复的"两条，都已经 3 天没动静。
  const book = new ConversationBook()
  const fresh = book.open({ id: 'c_fresh', psk: 'AgAAAAAAAAAAAAAAAAAAAA==', now: 0 })
  fresh.lastActivityAt = 0
  book.restore([record('c_restored')], 0)

  const threeDays = 3 * 24 * 3_600_000
  const dropped = book.pruneStale(threeDays, policy)
  assert.deepEqual(
    dropped,
    ['c_fresh'],
    `剪掉的是 ${JSON.stringify(dropped)}：3 天没动就该剪新配对的那条，而恢复出来的那条必须留着 —— 它代表"用户早就配好了、只是主机重启了"`,
  )
  assert.equal(book.has('c_restored'), true, '恢复出来的会话被 24 小时规则剪了：免扫码重连在长假场景下等于没做')

  // 过了 7 天就该剪：中继的空闲 TTL 也是那个量级，那时它已经/routes 不到了，
  // 主机再攥着这份 PSK 只是白占一份密钥材料。
  book.restore([record('c_restored')], 0)
  const eightDays = 8 * 24 * 3_600_000
  const late = book.pruneStale(eightDays, policy)
  assert.ok(
    late.includes('c_restored'),
    `${eightDays / 86_400_000} 天了还不剪：已超过中继的空闲 TTL（7 天），留着它主机单方面攥着一份没人能路由的密钥`,
  )
})

test('没给 restoredIdleTtlMs 时退回 idleTtlMs：调用方不该因为少一个字段就把恢复会话立刻剪掉', () => {
  const book = new ConversationBook()
  book.restore([{ id: 'c_r', psk: 'AAAAAAAAAAAAAAAAAAAAAA==', seqHost: 0, createdAt: 0, lastActivityAt: 0 }], 0)
  const twoDays = 2 * 24 * 3_600_000
  const dropped = book.pruneStale(twoDays, { idleTtlMs: 24 * 3_600_000, maxConversations: 64 })
  assert.deepEqual(
    dropped,
    ['c_r'],
    '夹具自检的前提：默认策略下 2 天的恢复会话会被剪掉（idleTtlMs 兜底生效）。若这条红了说明兜底语义变了，需要重新评估',
  )
})

/**
 * 一条形状不合的落盘记录必须**整条丢弃**，而不是把整个插件带崩（2026-10-07 修）。
 *
 * ## 缺陷形状
 *
 * `restore` 的注释早就承诺「一条形状不合的记录整条丢弃（宁可少一条通道，
 * 也不要一条解不开的）」，而实现是直接 `open()` —— 于是 `derivePskKey`
 * 对一条截断过的 psk 抛「配对密钥（PSK）解码后必须是 16 字节，收到 9 字节」。
 *
 * 为什么这一抛是灾难级的：`restoreConversations` 的调用点在 `index.ts` 的
 * `applyInner` 里、**不在任何 try 内** ⇒ 一次抛出就让 `handle` 变成 undefined ⇒
 * **没有 status.json、没有 pill、整条配对链路无**，只留一行 stderr。
 * 而 GUI 宿主里 stdout 没人看，用户看到的是"插件好像没起来"，
 * 根因却是磁盘上一个被截断的 base64 串。
 *
 * 落盘那层的 zod 挡不住：`psk: z.string().min(1)` 只要求非空，
 * 16 字节的约束在 wire 的 `derivePskKey` 里，只在**派生时**才发现。
 */
test('一条坏记录只丢它自己：整批里其余的照常恢复，插件不崩', () => {
  const good = 'AAAAAAAAAAAAAAAAAAAAAA==' // 16 字节
  const truncated = 'AAAA' // base64 合法但解出来只有 3 字节
  const rejected: Array<{ id: string; reason: string }> = []
  const book = new ConversationBook()
  book.onRestoreRejected = (id, reason) => rejected.push({ id, reason })

  const restored = book.restore(
    [
      { id: 'c_ok1', psk: good, seqHost: 0, createdAt: 1, lastActivityAt: 1 },
      { id: 'c_bad', psk: truncated, seqHost: 0, createdAt: 1, lastActivityAt: 1 },
      { id: 'c_ok2', psk: good, seqHost: 0, createdAt: 1, lastActivityAt: 1 },
    ],
    100,
  )

  assert.deepEqual(restored, ['c_ok1', 'c_ok2'], '坏的那条不许连累其余的（它是"一条"，不是"全部"）')
  assert.equal(book.has('c_ok1'), true)
  assert.equal(book.has('c_ok2'), true)
  assert.equal(book.has('c_bad'), false, '坏记录必须整条丢弃：留着它 = 一条解不开的通道')
  // 且必须**说出来**：静默丢弃在用户眼里就是"我明明配对过，手机却要重扫"
  assert.equal(rejected.length, 1, '丢弃必须留痕')
  assert.equal(rejected[0]?.id, 'c_bad')
  assert.match(rejected[0]?.reason ?? '', /16 字节|PSK/, '原因要带得出来，否则日志里只有一个 convId')
})

test('反向判据：全部记录都坏时，一条都不许留下，且不许抛', () => {
  const book = new ConversationBook()
  book.onRestoreRejected = () => {}
  const restored = book.restore(
    [
      { id: 'c_a', psk: 'AAAA', seqHost: 0, createdAt: 1, lastActivityAt: 1 },
      { id: 'c_b', psk: '', seqHost: 0, createdAt: 1, lastActivityAt: 1 },
    ],
    100,
  )
  assert.deepEqual(restored, [], '一条都恢复不出来是合法结局（用户全部重扫），不是崩溃')
  assert.equal(book.size, 0)
})

test('反向判据：不挂 onRestoreRejected 也照常工作（它是可选出口，不是隐式依赖）', () => {
  // 单测直接 new 出来的 book 不接它，而那正是它可选项的原因。
  // 不接时行为完全一致：丢弃，只是不留痕。
  const book = new ConversationBook()
  const restored = book.restore([{ id: 'c_bad', psk: 'AAAA', seqHost: 0, createdAt: 1, lastActivityAt: 1 }], 100)
  assert.deepEqual(restored, [])
  assert.equal(book.size, 0)
})
