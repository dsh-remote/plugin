/**
 * pairing-window.test — "让屏幕上永远有一张能用的码"这条策略。
 *
 * 需求与每条判据的事故来源写在 `src/core/pairing-window.ts` 文件头，取证
 * `docs/legacy-spec/host-plugin-runtime.md` §6.2。旧实现把这段挂在状态快照的
 * 3 秒循环里，而 §7.4 第 12 条明确记着**这三条判据一条都没被测过**——
 * 重写之后它必须是纯逻辑 + 有单测，否则同一段代码下一轮重写又会被改坏。
 *
 * 这里刻意只注入四样东西：时钟、在线状态、代次、发布动作。
 * 真 socket 与中继的簿记由 `transport/relay.ts` 自己的测试守。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PairingWindow, staleReason, tokenHandle, type ActivePair } from '../src/core/pairing-window.js'
import { FakeClock } from '../src/core/clock.js'

interface Harness {
  clock: FakeClock
  window: PairingWindow
  published: number[]
  logs: string[]
  /** 连字段一起留：日志里**不许**出现那个 6 位码（它就是认领凭据本身），判据要能查字段。 */
  logRecords: Array<{ message: string; fields: Record<string, unknown> }>
  setOnline(online: boolean): void
  setGeneration(generation: number): void
  failPublish(fail?: boolean): void
  tickSeconds(seconds: number): number
}

function harness(pairSec = 60, overrides: { online?: boolean; publishReturnsNow?: boolean } = {}): Harness {
  const clock = new FakeClock()
  const published: number[] = []
  const logs: string[] = []
  const logRecords: Array<{ message: string; fields: Record<string, unknown> }> = []
  const state = { online: overrides.online ?? true, generation: 1, failPublish: false }
  const window = new PairingWindow(
    {
      clock,
      relayOnline: () => state.online,
      generation: () => state.generation,
      publish: (ttlMs) => {
        if (state.failPublish) return null
        published.push(ttlMs)
        const createdAt = clock.now()
        // 真码是 6 位十进制（formatPairingToken）；这里用可预测的 6 位数，别用 'T1' 那种
        // 一眼假的占位——判据要拿真发出去的码去比对，占位符会让那条比对悄悄失效。
        return { token: String(400000 + published.length), createdAt, expiresAt: createdAt + ttlMs }
      },
      log: (message, fields) => {
        logs.push(message)
        logRecords.push({ message, fields: { ...(fields ?? {}) } })
      },
    },
    pairSec,
  )
  return {
    clock,
    window,
    published,
    logs,
    logRecords,
    setOnline: (online) => {
      state.online = online
    },
    setGeneration: (generation) => {
      state.generation = generation
    },
    failPublish: (fail = true) => {
      state.failPublish = fail
    },
    /** 模拟 status 的 3 秒节拍跑若干秒，返回这几轮里发布的张数。 */
    tickSeconds: (seconds) => {
      const before = published.length
      for (let at = 0; at < seconds; at += 3) {
        void clock.advance(3_000)
        window.tick()
      }
      return published.length - before
    },
  }
}

test('没有活动码就发一张，并把当前代次记进去（判据一：防"永远没有码"）', () => {
  const h = harness(60)
  assert.equal(h.window.tick(), true, '第一次 tick 就该发一张')
  assert.deepEqual(h.published, [60_000], 'TTL 用请求值（pairOnStartSec × 1000）')
  const active = h.window.active as unknown as ActivePair
  assert.equal(active.token, '400001')
  assert.equal(active.generation, 1, '代次必须记进去：中继重启后要靠它判死')
  assert.equal(h.window.tick(), false, '仍然有效时不该重复发：每 3 秒发一张会把中继的 pending 表打满')
})

test('中继不在线时一张都不发（发布闸门：raw() 对非 OPEN 的 socket 是静默丢弃）', () => {
  const h = harness(60, { online: false })
  assert.equal(h.window.tick(), false, '断连时也发了：本地记了一张码、中继那边根本没见过它')
  assert.equal(h.window.active, null, '发不出去还记进 active：status.json 会展示一张永远配不上的码')
  h.setOnline(true)
  assert.equal(h.window.tick(), true, '恢复在线之后必须补发：否则闸门变成"永远没有码"')
})

test('发布失败要留痕且不原地打转，下一轮仍会重试', () => {
  const h = harness(60)
  h.failPublish()
  assert.equal(h.window.tick(), false)
  assert.ok(
    h.logs.some((line) => line === 'pairing publish failed'),
    `失败没有痕迹（日志：${JSON.stringify(h.logs)}）`,
  )
  assert.equal(h.window.active, null)
  h.failPublish(false)
  assert.equal(h.window.tick(), true, '一次失败之后窗口就再也不发了')
})

test('中继重启（代次变化）后那张码立刻判死并重发（判据二：防"挂着一张死码"）', () => {
  const h = harness(60)
  h.window.tick()
  assert.equal(h.published.length, 1)
  // 中继重启：pending-pair 表是内存的，我们这张码的 TTL 还没到但已经没人认得了。
  h.setGeneration(2)
  assert.equal(
    staleReason({ active: h.window.active, now: h.clock.now(), generation: 2, ttlMs: 60_000 }),
    'relay-generation-changed',
  )
  assert.equal(h.window.tick(), true, '代次变了却没重发：手机扫到的是一张中继完全不认识的码')
  assert.equal((h.window.active as unknown as ActivePair).generation, 2, '新码要记新代次')
  assert.equal(h.window.tick(), false, '换过一张之后不该再发')
})

test('剩余寿命不足半程才重发，仍在半程内不动（判据三：防"用户扫到一个刚刚过期的码"）', () => {
  const h = harness(60)
  h.window.tick()
  void h.clock.advance(20_000) // 60s 的码走了 20s：还剩 40s > 半程 30s
  assert.equal(staleReason({ active: h.window.active, now: h.clock.now(), generation: 1, ttlMs: 60_000 }), null)
  assert.equal(h.window.tick(), false, '没到半程就换码：手机上刚刷出来的二维码又变了，人永远扫不上')

  void h.clock.advance(35_000) // 累计 55s：剩余 5s < 半程
  assert.equal(
    staleReason({ active: h.window.active, now: h.clock.now(), generation: 1, ttlMs: 60_000 }),
    'past-half-life',
  )
  assert.equal(h.window.tick(), true, '过了半程不换码：等用户去扫时它已经过期了')

  void h.clock.advance(60_000) // 彻底过期
  h.window.tick()
  assert.equal(staleReason({ active: null, now: h.clock.now(), generation: 1, ttlMs: 60_000 }), 'no-active-pair')

  // 判据一与判据三的动作相同（都要换新），但**原因必须分得开**：
  // 一张走到"已过期"的码说明半程刷新没做成（多半是发布一直失败），排查方向完全不同。
  const dead: ActivePair = {
    token: '400001',
    createdAt: h.clock.now() - 120_000,
    expiresAt: h.clock.now() - 60_000,
    generation: 1,
  }
  assert.equal(
    staleReason({ active: dead, now: h.clock.now(), generation: 1, ttlMs: 60_000 }),
    'expired',
    '过期那张被报成半程：日志里"半程刷新为什么没接住"就无从查起',
  )
})

test('码被用掉就当场换一张新的，不必等半程（新实现加的第四条判据）', () => {
  const h = harness(60)
  h.window.tick()
  const first = h.window.active as unknown as ActivePair
  void h.clock.advance(1_000) // 远未到半程

  h.window.markConsumed(first.token)
  assert.equal(h.window.active, null, '用掉了还挂着：status.json 会把一次性码反复展示给外部脚本')
  assert.equal(h.window.tick(), true, '消费之后不换新的：第二部手机与下一轮取证只能等半个 TTL')
  assert.notEqual((h.window.active as unknown as ActivePair).token, first.token, '必须是一张新码（一次性码不可复用）')

  // 只认领自己那张：别的 token 被消费不该把这张搞没。
  const mine = (h.window.active as unknown as ActivePair).token
  h.window.markConsumed('T999')
  assert.equal((h.window.active as unknown as ActivePair).token, mine, '陌生 token 也清了 active：多码并存时会互相踩')
})

test('服务端权威 TTL 覆盖请求值，并把已挂出那张的过期时间按**发起时刻**重算', () => {
  const h = harness(60)
  h.window.tick()
  const createdAt = (h.window.active as unknown as ActivePair).createdAt

  h.window.applyServerTtl('400001', 90_000) // 中继说这张还能活 90s
  assert.equal(
    (h.window.active as unknown as ActivePair).expiresAt,
    createdAt + 90_000,
    '基线必须是发起时刻：用 pair-ready 到达时刻会让本地比中继早失效',
  )

  // 之后每张都按服务端值发（请求值只在 pair-ready 落地前用）。
  h.window.markConsumed('400001')
  h.window.tick()
  assert.deepEqual(h.published, [60_000, 90_000], `第二张用的还是请求值：${JSON.stringify(h.published)}`)
})

test('手工 /drc pair 发的那张要被窗口认领，否则同一台主机会挂两张有效码', () => {
  const h = harness(60)
  h.window.adopt({ token: 'MANUAL', createdAt: h.clock.now(), expiresAt: h.clock.now() + 60_000 })
  assert.equal(h.window.tick(), false, '已经有一张有效码还再发一张：多码并存时手机取错那张就全线解不开')
  assert.equal((h.window.active as unknown as ActivePair).token, 'MANUAL')
  void h.clock.advance(55_000)
  assert.equal(h.window.tick(), true, '手工那张过半程之后窗口必须接手换新的')
})

test('pairOnStartSec=0 是关：一次都不发（这条默认关的配置绝不能默认生效）', () => {
  const h = harness(0)
  assert.equal(h.window.tick(), false)
  h.setOnline(true)
  assert.equal(h.tickSeconds(60), 0, `关着却发了 ${h.published.length} 张：带 PSK 的活码被写进 status.json`)
})

test('按 3 秒节拍跑 5 分钟：只在半程处换码，不会每 tick 发一张', () => {
  const h = harness(60)
  const fresh = harness(60)
  assert.equal(fresh.window.tick(), true)
  const count = fresh.tickSeconds(300) // 5 分钟 = 100 个 tick
  // 60s 的码在半程（30s）换一次 ⇒ 5 分钟里 60/30 → 约 10 张，绝不是一百张。
  assert.ok(count > 0 && count <= 12, `300 秒里发了 ${count} 张：要么没刷新，要么每 tick 发一张（中继配额会被打爆）`)
  assert.equal(h.published.length, 0, '夹具自检：harness() 本身不该发码')
})

/* ── 2026-10-06 缺陷修复：自动补发与"刷新已挂出去那张"是两件事 ───────────── */

test('pairOnStartSec=0（默认）时"中继重启换码"这条判据也必须生效：屏幕上的码在中继那边已经死了', () => {
  const h = harness(0)
  h.window.adopt({ token: 'SHOWN', createdAt: h.clock.now(), expiresAt: h.clock.now() + 120_000 })
  assert.equal(h.window.tick(), false, '夹具自检：同一代次、没过半程时不该换码')

  h.setGeneration(2) // 中继重启：它的 pending-pair 表是内存的，这张码已经没人认得
  assert.equal(
    h.window.tick(),
    true,
    '代次变了却不换码：用户点"刷新"拿到的还是同一张死码，只能干等 TTL（而 pairOnStartSec 默认 0）',
  )
  assert.deepEqual(h.published, [120_000], '这一档的 TTL 基线要用常规 pairTtlMs（默认 120000），不是 pairSec*1000=1s')
  assert.equal((h.window.active as unknown as ActivePair).token, '400001')
})

test('pairOnStartSec=0 时"过半程"同样要换：那张码按常规 TTL 老化，不会每 tick 换一张', async () => {
  const h = harness(0)
  h.window.adopt({ token: 'SHOWN', createdAt: h.clock.now(), expiresAt: h.clock.now() + 120_000 })
  await h.clock.advance(59_000)
  assert.equal(h.window.tick(), false, '还没过半程就换码：用户刚看到的码立刻作废')
  await h.clock.advance(2_000)
  assert.equal(h.window.tick(), true, '过半程之后不换：手机扫到一张刚刚过期的码')
})

test('staleNow() 与 tick() 同一套判据：刷新按钮据此拒发死码，且它自己不改状态', () => {
  const h = harness(0)
  assert.equal(h.window.staleNow(), 'no-active-pair', '没有活动码时 staleNow 必须说得出原因')
  h.window.adopt({ token: 'SHOWN', createdAt: h.clock.now(), expiresAt: h.clock.now() + 120_000 })
  assert.equal(h.window.staleNow(), null, '有效期内必须是 null（刷新按钮据此原样返回那张码）')
  assert.equal(h.published.length, 0, 'staleNow 不许发布任何东西')
  h.setGeneration(5)
  assert.equal(h.window.staleNow(), 'relay-generation-changed', '代次变了必须能判出来（这就是那条死码）')
})

test('日志里不许出现那个 6 位码（它就是认领凭据本身），只留一个可对账的代号', async () => {
  // 与 `pill/routes.ts` 的 `tokenLength + epoch` 同一条纪律：`stdout` 是会被翻出来
  // 贴进 issue 的那种地方，中继侧 D2 也为此把完整码降到 debug。本文件与 index.ts
  // 的 publishPairing 当时漏了，于是同一个 stdout 上一半守纪律一半不守。
  //
  // ⚠️ 断言必须覆盖**三条**会带上码的路径（被用掉 / 被中继拒 / 发布新码），且那条
  // "发布"要拿真发出去的那张码来比——第一版只断言了两个手写的码，而 publish 走的是
  // 夹具给的 `T1`，于是把发布那行改回 `token:` 变异验证时判据**没红**。
  // 判据自己骗自己比没有判据更糟（§0.3 第 2 条）。
  const h = harness(60)
  const used = '418302'
  const rejected = '905517'
  h.window.adopt({ token: used, createdAt: h.clock.now(), expiresAt: h.clock.now() + 120_000 })
  h.window.markConsumed(used)
  h.window.adopt({ token: rejected, createdAt: h.clock.now(), expiresAt: h.clock.now() + 120_000 })
  h.window.forget(rejected)
  h.window.tick()
  const published = h.window.active?.token ?? ''
  h.window.markConsumed(published)

  assert.ok(
    [used, rejected, published].every((code) => /^\d{6}$/.test(code)),
    `三条路径上的码都得是真实的 6 位数（实得 ${used} / ${rejected} / ${published}），否则下面那条比对等于没做`,
  )
  assert.ok(h.logRecords.length >= 4, `这三条路径都没留日志（实得 ${h.logRecords.length} 条），判据自己没跑到点上`)
  const blob = JSON.stringify(h.logRecords)
  for (const secret of [used, rejected, published]) {
    assert.ok(
      !blob.includes(secret),
      `日志里出现了完整的配对码 ${secret}：凭据与"屏幕上的那张码"两项同时到位即可在 TTL 内配对（D2 的原话）`,
    )
  }
  // 代号必须真的能用：同一个码的各条日志要能串起来，不同的码不能撞成同一个。
  assert.equal(tokenHandle(used), tokenHandle(used), '同一个码的代号必须稳定')
  assert.notEqual(tokenHandle(used), tokenHandle(rejected), '不同码的代号不能一样')
  assert.match(tokenHandle(used), /^[0-9a-f]{8}$/, '代号固定 8 位十六进制：够对账，又推不回 10^6 空间里的任何一码')
})
