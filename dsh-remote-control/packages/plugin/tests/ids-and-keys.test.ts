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
  const conversation = book.open({ id: 'c_aaaabbbbcccc', psk: slot.psk, generation: 1, now: 1_700_000_000_000 })

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

test('closeBefore(generation) 只清掉旧代会话：中继重启不能顺手把新代的一起删了', () => {
  const book = new ConversationBook()
  book.open({ id: 'c_old_1', psk: 'AAAAAAAAAAAAAAAAAAAAAA==', generation: 1, now: 1 })
  book.open({ id: 'c_old_2', psk: 'AAAAAAAAAAAAAAAAAAAAAA==', generation: 1, now: 2 })
  book.open({ id: 'c_new_1', psk: 'AAAAAAAAAAAAAAAAAAAAAA==', generation: 2, now: 3 })

  const dropped = book.closeBefore(2)
  assert.deepEqual(
    dropped.sort(),
    ['c_old_1', 'c_old_2'],
    `清掉的是 ${JSON.stringify(dropped)}：旧代会话必须全部作废（中继重启后没人路由它们）`,
  )
  assert.equal(book.size, 1, '新代会话被一起删了 → 刚配好的手机被踢下线，要重新扫码')
  assert.deepEqual(book.ids(), ['c_new_1'], '留下的必须恰好是当前代的那一条')

  // 幂等：同一条代次再清一次不该再报任何东西。
  assert.deepEqual(book.closeBefore(2), [], '重复清理又报了一遍：上层的"配对失效"提示会被刷屏')
  assert.deepEqual(book.closeBefore(1), [], '更早的代次不该清掉当前会话')
  assert.equal(book.size, 1, 'closeBefore 不该动当代会话')
})

test('close/has/get 对不存在的 id 都是安全的空操作：解配与断连路径不能抛', () => {
  const book = new ConversationBook()
  assert.equal(book.close('c_none'), false, 'close 不存在的会话返回了 true：调用方会以为真的掉了一条')
  assert.equal(book.has('c_none'), false)
  assert.equal(book.get('c_none'), undefined)
  assert.equal(book.size, 0)
  assert.deepEqual(book.ids(), [])

  book.open({ id: 'c_real', psk: 'AAAAAAAAAAAAAAAAAAAAAA==', generation: 1, now: 10 })
  assert.equal(book.close('c_real'), true, 'close 存在的会话必须返回 true')
  assert.equal(book.has('c_real'), false, 'close 之后 has 仍为真：hasPeer 会谎报有对端，审批卡发出去没人收')
  assert.equal(book.size, 0, '会话数没降下来')
})

test('同一条 convId 重复 open 是覆盖而不是并出两条：簿记键只能是 convId', () => {
  const book = new ConversationBook()
  const first = book.open({ id: 'c_dup', psk: 'AAAAAAAAAAAAAAAAAAAAAA==', generation: 1, now: 1 })
  const second = book.open({ id: 'c_dup', psk: 'AgAAAAAAAAAAAAAAAAAAAA==', generation: 1, now: 2 })
  assert.equal(book.size, 1, `一条 convId 攒出 ${book.size} 条会话：广播会给同一条通道发两遍`)
  assert.notEqual(first.psk, second.psk, '夹具自检：两次 PSK 不同')
  assert.equal(book.get('c_dup')?.psk, second.psk, '后来的那张码没覆盖：手机用新码配对，主机还攥着旧密钥')
  assert.equal(book.get('c_dup')?.createdAt, 2, 'createdAt 要跟着更新：status.json 的码年龄判据（<25s）读它')
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
    clock.now() + 120_000,
    '过期时间没按服务端值改写（基线是 pair-ready 到达时刻）',
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

test('latest() 只用于展示，取密钥必须走 resolveFor：用 A 码建的会话拿 B 码的 PSK 一定解不开', () => {
  const clock = ticking()
  const slots = new PairingSlots(clock.now)
  const usedByPhone = slots.create(120_000) // 屏幕上那张、手机真正扫的
  clock.advance(1_000)
  const newer = slots.create(120_000) // 自动补发的另一张

  const shown = slots.latest()
  assert.equal(shown?.token, newer.token, '夹具自检：latest() 给出的是最新那张')
  assert.equal(shown?.token !== usedByPhone.token, true, '夹具自检：两张不同')

  // 事故形状：会话是用 A 建的，却按 latest()（B）的 PSK 派生密钥。
  const book = new ConversationBook()
  const picked = slots.resolveFor(usedByPhone.token)
  assert.ok(picked !== null, '按手机实际用的那张码必须取到 PSK')
  const correct = book.open({ id: 'c_pair', psk: picked.psk, generation: 1, now: clock.now() })
  assert.ok(shown !== null, '夹具自检：展示位上有码')
  const mistaken = book.open({ id: 'c_wrong', psk: shown.psk, generation: 1, now: clock.now() })

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

test('ConversationBook 的初始簿记形状：seqHost 从 0 起、clientIds 空、代次与时刻如实记下', () => {
  const book = new ConversationBook()
  const conversation = book.open({
    id: 'c_shape',
    psk: 'AAAAAAAAAAAAAAAAAAAAAA==',
    generation: 4,
    now: 1_700_000_999_000,
  })
  assert.equal(conversation.id, 'c_shape', '会话 id 必须逐字保留（F3：加工过一次就路由不回去）')
  assert.equal(conversation.seqHost, 0, '本端出站序号从 0 开始，第一帧发出去是 1')
  assert.equal(conversation.clientIds.size, 0, '新配对不该凭空带上客户端名单（D4 的成员校验用它）')
  assert.equal(conversation.generation, 4, '代次没记下来：中继重启后 closeBefore 找不出该清哪些会话')
  assert.equal(conversation.createdAt, 1_700_000_999_000, 'createdAt 必须是传入时刻而不是 Date.now()：假时钟下要可核对')
})

test('过期判据的边界：expiresAt 恰好等于此刻时仍算有效（与 resolveFor 的严格小于一致）', () => {
  const clock = ticking()
  const slots = new PairingSlots(clock.now)
  const slot = slots.create(10_000)
  clock.advance(10_000) // 正好到点
  assert.equal(slot.expiresAt, clock.now(), '夹具自检：此刻正好是过期时刻')
  assert.equal(
    slots.resolveFor(slot.token) !== null,
    true,
    '边界判据必须与 latest()/prune() 一致：一处用 <= 一处用 < 会让"能显示但取不到密钥"——又是静默丢 peer',
  )
  assert.equal(
    slots.latest() !== null,
    true,
    'latest() 与 resolveFor 在这一刻说法不一致：状态里还展示一张码，配对却取不到 PSK',
  )
  clock.advance(1)
  assert.equal(slots.resolveFor(slot.token), null, '超过一刻就必须判过期')
  assert.equal(slots.latest(), null, '超过一刻展示位也要清空：status.json 里的码年龄判据靠它')
})
