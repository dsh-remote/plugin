/**
 * sleep.test — `core/sleep-policy.ts` 的 KeepAwake（策略层，执行交给 SleepPort 替身）。
 *
 * 这里守的是旧实现最贵的一条泄漏（取证 docs/legacy-spec/host-plugin-runtime.md §4.3 与
 * docs/DESIGN.md §2.2 之外的 M9/M10/N12）：旧实现靠"收到带 requestId 的终态事件"来撤销
 * 60 秒心跳，可 `ev.result`/`ev.run_state`/`ev.tool_event` 三个类型里**根本没有** requestId
 * 字段，判据永不成立 → 一次远程审批之后那台机器再也睡不着（§8.2 N12「未满足（泄漏）」）。
 * 本实现的判据只用插件自己生成的 requestId，且释放只认 `releaseHold(id)`。
 *
 * 时间全部走 `FakeClock`：300 秒的空闲释放被压成一次 `advance()`，
 * 旧实现这两条路径没有任何测试（§7.4 第 10 条：「§4 全部——无测试」）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SleepPort } from '../src/ports/index.js'
import { KeepAwake, type KeepAwakeOptions } from '../src/core/sleep-policy.js'
import { FakeClock } from '../src/core/clock.js'

interface StartCall {
  ownerPid: number
  keepDisplay: boolean
}

/** 睡眠抑制后端替身：只记"有没有真的调工具"，不 spawn。 */
class FakeBackend implements SleepPort {
  readonly starts: StartCall[] = []
  stops = 0
  startResult: { ok: boolean; message?: string } = { ok: true }
  /**
   * 非 undefined 时直接回答 `isActive()`：用来演"spawn 异步失败、子进程已经没了"
   * 这一档（真后端就是靠子进程句柄回答的，见 `platform/sleep-posix.ts`）。
   */
  activeOverride: boolean | undefined

  constructor(
    private readonly backendName = 'fake-caffeinate',
    private readonly osName = 'fakeos',
  ) {}

  backend(): string {
    return this.backendName
  }

  platform(): string {
    return this.osName
  }

  start(ownerPid: number, keepDisplay: boolean): { ok: boolean; message?: string } {
    this.starts.push({ ownerPid, keepDisplay })
    return this.startResult
  }

  stop(): void {
    this.stops += 1
  }

  isActive(): boolean {
    return this.activeOverride ?? this.starts.length > this.stops
  }
}

interface Fixture {
  clock: FakeClock
  backend: FakeBackend
  sleep: KeepAwake
}

function fixture(options: Partial<KeepAwakeOptions> = {}): Fixture {
  const clock = new FakeClock()
  const backend = new FakeBackend()
  const sleep = new KeepAwake(backend, clock, { tickMs: 10_000, pendingRefreshMs: 60_000, ...options })
  return { clock, backend, sleep }
}

test('idleReleaseSec=0 是"永不自动释放"，不是"立刻释放"：手机可以明确要求保持到被关掉', async () => {
  const { clock, backend, sleep } = fixture()
  const snapshot = sleep.setEnabled(true, 0)
  assert.equal(snapshot.enabled, true, '开关必须回显 enabled:true，手机开关才不会灰在关')
  assert.equal(
    snapshot.active,
    true,
    `拿锁结果 active=${snapshot.active}：enabled 与 active 是两个字段，手机文案靠 active 显示"当前持锁中"`,
  )
  assert.ok(backend.starts.length >= 1, '开关一开就该持锁，而不是等第一条 prompt（头几秒可能已经睡了）')

  await clock.advance(3 * 60 * 60_000) // 三个小时没有任何事件
  assert.equal(
    backend.stops,
    0,
    `idleReleaseSec=0 却在 ${3} 小时后被自动释放了 ${backend.stops} 次 → 手机上"保持到被显式关闭"这个选项形同虚设`,
  )
  assert.equal(sleep.snapshot().active, true, '永不自动释放的语义是持续持锁')
})

test('空闲超过 idleReleaseSec 必须自动放锁：用户明确要求本地空闲时机器照常睡眠', async () => {
  const { clock, backend, sleep } = fixture()
  sleep.setEnabled(true, 300) // 300 秒
  assert.equal(backend.stops, 0, '夹具自检：刚拿锁')

  await clock.advance(200_000)
  assert.equal(backend.stops, 0, '还没到阈值就放锁 → 用户还在看手机，机器已经睡了')

  await clock.advance(150_000) // 合计 350s > 300s
  assert.ok(
    backend.stops >= 1,
    `空闲 350 秒仍未放锁（stops=${backend.stops}）→ 这台笔记本再也不睡，是旧实现事故的另一半`,
  )
  assert.equal(sleep.snapshot().active, false, '释放后 active 必须立刻变 false：手机 sessions.js 按它显示"当前未持锁"')
  assert.equal(sleep.snapshot().enabled, true, '自动释放不等于用户关掉开关，enabled 必须仍是 true')
})

test('释放之后再有活动必须能重新拿锁：持锁是"活动驱动 + 空闲自放 + 再活动再拿"的循环', async () => {
  const { clock, backend, sleep } = fixture()
  sleep.setEnabled(true, 60)
  const before = backend.starts.length
  await clock.advance(120_000)
  assert.ok(backend.stops >= 1, '夹具自检：空闲已释放')

  sleep.markActive()
  assert.ok(
    backend.starts.length >= before + 1,
    `再活动没有重新拿锁（starts=${backend.starts.length}）→ 手机发下一条指令时机器是睡着的`,
  )
  assert.equal(sleep.snapshot().active, true, '重新拿锁后 active 必须回 true')
})

test('开关关掉时立刻放锁，之后的任何活动都不许再拿锁', async () => {
  const { clock, backend, sleep } = fixture()
  sleep.setEnabled(true, 0)
  assert.equal(backend.starts.length >= 1, true, '夹具自检：已经持锁')

  const snapshot = sleep.setEnabled(false)
  assert.equal(snapshot.enabled, false, 'enabled 必须回显 false')
  assert.equal(snapshot.active, false, '关掉开关必须立刻放锁：用户要的是"本地空闲时机器照常睡眠"')
  assert.equal(backend.stops, 1, `关闭时调了 ${backend.stops} 次 stop：放锁必须恰好一次，多次会让后端的计数错乱`)

  const starts = backend.starts.length
  await clock.advance(600_000)
  sleep.markActive()
  sleep.hold('ap_还在挂着的审批')
  assert.equal(backend.starts.length, starts, `关开关后仍然重新拿了锁 → 手机上关掉开关却还在阻止休眠`)
})

test('有挂起审批时每个 pendingRefreshMs 续一次锁：用户还没决定，笔记本不能先睡', async () => {
  const { clock, backend, sleep } = fixture()
  sleep.setEnabled(true, 300) // 空闲 300 秒就放
  sleep.hold('ap_1')

  // 挂 30 分钟：远超空闲阈值。旧实现在这里"心跳永不撤销"，本实现靠 hold 集合判活跃。
  await clock.advance(30 * 60_000)
  assert.equal(backend.stops, 0, `审批挂着 30 分钟期间放了 ${backend.stops} 次锁 → 手机上的审批按钮变成一块砖`)
  assert.equal(sleep.snapshot().active, true, '挂起期间必须始终持锁')

  sleep.releaseHold('ap_1')
  // 续锁把"最后一次活动"推到了释放前不到 60 秒，所以刚答完不该立刻放锁。
  assert.equal(backend.stops, 0, '刚答完就放锁 → 用户还在手机上看着输出，机器睡了')

  await clock.advance(360_000)
  assert.ok(
    backend.stops >= 1,
    `答完之后锁没能靠空闲释放（stops=${backend.stops}）：这正是旧实现"一次审批过就再也睡不了"的形状`,
  )
})

test('释放只认 releaseHold(id)：无关的 id 不放锁，看到"没有 requestId 的事件"也不许当终结', async () => {
  const { clock, backend, sleep } = fixture()
  sleep.setEnabled(true, 300)
  sleep.hold('ap_mine')

  sleep.releaseHold('ap_别人的') // 旧实现试图用一类根本不存在的字段来结算
  await clock.advance(400_000)
  assert.equal(
    backend.stops,
    0,
    `挂着的 ap_mine 被一个无关 id 的释放掉了（stops=${backend.stops}）→ 手机端审批卡还挂着，机器已经睡了`,
  )
  assert.equal(sleep.snapshot().active, true, '还有一个挂起的 requestId 时必须继续持锁')

  sleep.releaseHold('ap_mine')
  await clock.advance(360_000)
  assert.ok(backend.stops >= 1, 'releaseHold 到了就必须让空闲阈值重新生效')
})

test('两条审批同时挂着：只答完一条时另一条仍然保锁', async () => {
  const { clock, backend, sleep } = fixture()
  sleep.setEnabled(true, 300)
  sleep.hold('ap_1')
  sleep.hold('ap_2')
  assert.ok(backend.starts.length >= 1, '夹具自检：已持锁')

  sleep.releaseHold('ap_1')
  await clock.advance(400_000)
  assert.equal(backend.stops, 0, '第二条审批还没答完就放锁 → 那一条卡死了')

  sleep.releaseHold('ap_2')
  await clock.advance(360_000)
  assert.ok(backend.stops >= 1, '最后一条挂起交互也答完了，锁必须能释放')
})

test('挂起期间的续锁只认 pendingRefreshMs 这个参数：改小它，空闲阈值就更快被重新点起', async () => {
  const { clock, backend, sleep } = fixture({ pendingRefreshMs: 20_000 })
  sleep.setEnabled(true, 300)
  sleep.hold('ap_1')
  const starts = backend.starts.length
  // 每 20 秒续一次：节拍必须真的在跑（旧实现是 60 秒写死且永不撤销）。
  await clock.advance(100_000)
  assert.equal(backend.stops, 0, '挂起期间被空闲阈值放了锁 → 审批卡还在，机器已经睡了')
  assert.equal(backend.starts.length, starts, '续锁不该反复 spawn：已经持锁时只刷新活动时间，锁的开销必须是有界的')
  sleep.releaseHold('ap_1')
  await clock.advance(360_000)
  assert.ok(backend.stops >= 1, '释放后空闲阈值必须重新生效')
})

test('后端 start 失败时 reason 必须带得上原因，且 active 如实为 false', () => {
  const clock = new FakeClock()
  const backend = new FakeBackend('caffeinate', 'fakeos')
  backend.startResult = { ok: false, message: 'caffeinate 不在 PATH 里' }
  const sleep = new KeepAwake(backend, clock, { tickMs: 10_000 })

  const snapshot = sleep.setEnabled(true, 300)
  assert.equal(snapshot.active, false, 'start 失败却报 active:true → 手机显示"当前持锁中"，机器照睡，这是骗人')
  assert.equal(
    snapshot.reason,
    'caffeinate 不在 PATH 里',
    '失败原因要进 ev.keep_awake_state.reason：这是手机上唯一能看到"为什么没锁上"的地方',
  )
  assert.equal(snapshot.enabled, true, '用户确实打开了开关，enabled 不该因为失败而翻成 false')

  // 成功后必须把上一次的失败原因清掉：留着会让手机一直显示已经好了的故障。
  backend.startResult = { ok: true }
  sleep.setEnabled(false)
  const again = sleep.setEnabled(true, 300)
  assert.equal(again.active, true, '重新打开后应能拿到锁')
  assert.equal(
    'reason' in again,
    false,
    `拿锁成功后仍带着 reason=${String(again.reason)}：旧实现的 reason 只表达失败，残留会误导排错`,
  )
})

test('快照必须带 platform 与 backend：platform 是 e2e 断言字段，backend 区分"没锁"与"锁不了"', () => {
  const clock = new FakeClock()
  const backend = new FakeBackend('systemd-inhibit', 'linux')
  const sleep = new KeepAwake(backend, clock)
  const snapshot = sleep.setEnabled(true, 300)
  assert.equal(snapshot.platform, 'linux', 'platform 缺了 → mp-client.test.mjs / run.mjs 那两条断言会红')
  assert.equal(snapshot.backend, 'systemd-inhibit', 'backend 名字要如实透出')
  assert.equal(typeof snapshot.enabled, 'boolean', 'enabled 必须是布尔：手机 sessions.js 用 !! 取值，字符串会永远为真')
  assert.equal(typeof snapshot.active, 'boolean', 'active 必须是布尔，缺省会被显示成"未持锁"')
})

test('持锁断言必须绑到宿主 pid 与 keepDisplay 选项上（macOS 的 -w 是唯一的孤儿锁防线）', () => {
  const clock = new FakeClock()
  const backend = new FakeBackend()
  const sleep = new KeepAwake(backend, clock, { ownerPid: 4242, keepDisplay: true })
  sleep.setEnabled(true, 300)
  assert.equal(backend.starts.length, 1, '夹具自检：应该恰好拿一次锁')
  const call = backend.starts[0]
  assert.equal(call?.ownerPid, 4242, 'ownerPid 传错 → 宿主被 kill -9 时 caffeinate 变成孤儿断言，用户的笔记本永久不睡')
  assert.equal(call?.keepDisplay, true, 'keepDisplay 必须透到后端：它决定 caffeinate 用 -d -i -u 还是 -i -s')
})

test('stop() 放锁并撤掉节拍定时器：不许留下吊住宿主的定时器', async () => {
  const { clock, backend, sleep } = fixture()
  sleep.setEnabled(true, 300)
  assert.ok(clock.pending >= 1, '夹具自检：节拍定时器应该装着（每 tickMs 一次 evaluate）')
  const pendingBefore = clock.pending

  sleep.stop()
  assert.equal(backend.stops, 1, `停机没放锁（stops=${backend.stops}）→ 插件走了，锁留下了`)
  assert.equal(
    clock.pending,
    0,
    `停机后还剩 ${pendingBefore} 个定时器：宿主是用户的内核进程，插件不能让它赖着不退（M23）`,
  )

  const starts = backend.starts.length
  await clock.advance(600_000)
  assert.equal(backend.starts.length, starts, '停机之后节拍必须真的停了')
})

test('未打开开关时任何活动与挂起审批都不许拿锁（默认关的一台机器不该被插件叫醒）', async () => {
  const { clock, backend, sleep } = fixture()
  sleep.markActive()
  sleep.hold('ap_1')
  await clock.advance(600_000)
  assert.equal(
    backend.starts.length,
    0,
    `enabled=false 却拿了 ${backend.starts.length} 次锁 → 用户没开功能，机器却不睡`,
  )
  assert.equal(sleep.snapshot().active, false, '没开关时 active 必须是 false')
  assert.equal(clock.pending, 1, '夹具自检：evaluate 会装一个节拍定时器，stop() 必须能撤掉它')
  sleep.stop()
  assert.equal(clock.pending, 0, '定时器必须可撤')
})

test('enabled 与 active 是两个字段：自动释放后开关仍是开的', async () => {
  const { clock, backend, sleep } = fixture()
  sleep.setEnabled(true, 120)
  await clock.advance(200_000)
  assert.ok(backend.stops >= 1, '夹具自检：空闲应已释放')
  const snapshot = sleep.snapshot()
  assert.equal(snapshot.enabled, true, "enabled 表示'用户允许持锁'，不能因为释放就翻成 false")
  assert.equal(snapshot.active, false, "active 表示'此刻正在阻止休眠'；把它当成'有会话在跑'是 N11 明令禁止的误读")
})

test('重复的 releaseHold 必须幂等：不许把后端的停止计数打乱', async () => {
  const { clock, backend, sleep } = fixture()
  sleep.setEnabled(true, 300)
  sleep.hold('ap_1')
  sleep.releaseHold('ap_1')
  sleep.releaseHold('ap_1')
  await clock.advance(360_000)
  assert.equal(
    backend.stops,
    1,
    `同一个 requestId 释放了两次，后端却停了 ${backend.stops} 次：幂等性破了会让 sleep 后端的计数不可信`,
  )
})

/**
 * 停机纪律。这一条是 e2e 那"60 秒尾巴"的根因，也是真机上会咬人的泄漏：
 * `releaseHold()` 完全可能在 `stop()` **之后**才到达（超时结算、平台撤销、手机迟迟不点），
 * 而 `releaseHold → evaluate → ensureTimer` 会再装一个自循环定时器。没有 `stopped` 闸门时
 * 这个定时器永远清不掉：插件已经拆了 socket，节拍还在续锁——
 * 表现一是"进程永不退出"（`node e2e/run.mjs` 打完全绿之后要再等一分钟），
 * 表现二是用户关了远程控制、机器的 caffeinate 还挂着不让睡。
 */
test('stop() 之后到达的 releaseHold 不许再装节拍定时器，也不许重新持锁', async () => {
  const { clock, backend, sleep } = fixture()
  sleep.setEnabled(true, 300)
  sleep.hold('ap_1')
  sleep.hold('ap_2')
  const startsWhileHolding = backend.starts.length
  assert.ok(startsWhileHolding >= 1, '夹具自检：挂起期间应当持锁')

  sleep.stop()
  const startsAfterStop = backend.starts.length
  const stopsAfterStop = backend.stops
  assert.equal(stopsAfterStop, 1, 'stop() 必须放锁一次')

  // 停机之后结算一次挂起（审批超时/撤销的真实顺序就是这样）。
  sleep.releaseHold('ap_1')
  sleep.releaseHold('ap_2')
  sleep.markActive()
  sleep.setEnabled(true, 300)
  await clock.advance(600_000) // 十个 tick 的时间

  assert.equal(
    backend.starts.length,
    startsAfterStop,
    `停机之后又持了一次锁（starts 从 ${startsAfterStop} 涨到 ${backend.starts.length}）：用户关了远程控制，机器还是不睡`,
  )
  assert.equal(sleep.snapshot().active, false, '停机之后快照不许谎报"仍在持锁"')
  assert.equal(
    clock.pending,
    0,
    `停机之后还剩 ${clock.pending} 个定时器：节拍没停，e2e 进程因此多活一分钟，宿主里则是关不掉的锁`,
  )
})

test('stop() 之后再 advance 也不许有任何事件被处理（闸门在 evaluate 入口，不在调用方自觉）', async () => {
  const { clock, backend, sleep } = fixture({ idleReleaseMs: 1 })
  sleep.setEnabled(true, 0)
  assert.equal(sleep.snapshot().active, true, '夹具自检：正在持锁')
  sleep.stop()
  const before = backend.starts.length + backend.stops
  await clock.advance(1_000_000)
  assert.equal(backend.starts.length + backend.stops, before, '停机后节拍仍在驱动拿锁/放锁')
  assert.equal(clock.pending, 0, '停机后仍有定时器存活')
})

/* ── 2026-10-06 缺陷修复：与后端对账 + 失败退避 ─────────────────────────── */

test('后端异步失败（spawn error 之后子进程没了）时 snapshot 必须校正 held，不许一直谎报"已开启防休眠"', () => {
  const { clock, backend, sleep } = fixture()
  sleep.setEnabled(true, 300)
  assert.equal(sleep.snapshot().active, true, '夹具自检：同步 ok 时先按持锁报')

  // 现场：`port.start()` 的同步 ok 只说明命令发出去了，macOS 上 spawn 失败是**异步**
  // 'error' 事件（见 platform/sleep-posix.ts）——那一刻后端已经没有子进程了。
  // 旧实现不看 `isActive()`（生产无人调），held 永远是 true：status.json 与手机上
  // 一直说"已开启防休眠"，而且因为 held===true 再也不会重试。
  backend.activeOverride = false
  const snapshot = sleep.snapshot()
  assert.equal(snapshot.active, false, '后端都没锁了还报 active:true：手机上显示"已开启防休眠"，机器照睡')
  assert.match(String(snapshot.reason ?? ''), /未持锁|后端/, '要对账就要说得出原因，否则用户只看到一个突然变灰的开关')
  assert.ok(clock.pending >= 1, '校正之后节拍还在：下一个 tick 要能按退避重试')
})

test('后端同步失败之后按指数退避重试：不许每 10 秒原样刷一次，也不许试两下就停用', async () => {
  const { clock, backend, sleep } = fixture()
  backend.startResult = { ok: false, message: 'caffeinate 不在 PATH 里' }
  // 0 = 不自动放锁：这条测的是退避，不想让"空闲释放"混进来。
  sleep.setEnabled(true, 0)
  const first = backend.starts.length
  assert.ok(first >= 1, '夹具自检：第一轮应当真的试过一次')

  // 退避序列是 0s / 10s / 30s / 70s…：头一分钟最多 3 次。
  // 旧实现每个 tick（10 秒）原样重试一次 = 6 次。
  await clock.advance(60_000)
  const inMinute = backend.starts.length - first
  assert.ok(inMinute <= 3, `头一分钟试了 ${inMinute} 次：没有退避，每 10 秒原样重试会一直刷日志`)

  // 但退避不许退化成"停用"：封顶之后后端恢复了必须还能拿回锁。
  await clock.advance(600_000)
  assert.ok(backend.starts.length > first + inMinute, '退避封顶之后再也不试：后端恢复了也拿不回锁')
  backend.startResult = { ok: true }
  await clock.advance(600_000)
  assert.equal(sleep.snapshot().active, true, '后端恢复之后必须能真的持锁')
})
