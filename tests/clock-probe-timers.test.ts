/**
 * clock-probe-timers — 一次性的诊断/宽限定时器不许拖住宿主退出。
 *
 * 需求来源：HANDOFF.md §5 第 3 条——「`node e2e/run.mjs` 1.2s 就打完全绿，但进程约 60s
 * 后才退出」。这一条当时把嫌疑记成"e2e 装置里某个 ~60s 的一次性定时器"；用探针
 * （包一层 global.setTimeout 记创建栈）实测后，拖尾的是 `index.ts` 里载具探测的三次复查
 * （8s / 25s / 60s，走 `clock.setTimeout`）：它们既没有 unref，也没有在 `stop()` 里撤掉，
 * 于是 60s 那一发把事件循环钉住。
 *
 * 影响面比 e2e 大：**任何短命的跑法都会白等最长的那一发**（headless/CLI、CI、`dsh
 * --profile headless "..."`）。真宿主里事件循环本来就有别的事撑着，unref 不改变取证行为
 * ——60s 后那次复查照跑。
 *
 * 三条要守的：
 * 1. 每个一次性定时器**创建后立刻 unref**（"别为了我留着进程"）。
 * 2. `cancelAll()` 必须把它们**全部**撤掉，且可重复调用（stop 走两遍不该出错）。
 * 3. 假时钟（`FakeClock` 的句柄是**数字**，没有 unref）**不许因此抛错**——那是
 *    "定时器归测试掌控"的正常场景，数字句柄上调用 unref 必须是安全的空操作。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOneShotTimers, FakeClock, unrefTimer } from '../src/core/clock.js'
import type { Clock } from '../src/ports/index.js'

/** 记录"哪些句柄被 unref / 被清理"的时钟；句柄是对象，所以能验 unref 是否真被调用。 */
class SpyClock implements Clock {
  readonly created: Array<{ ms: number; handle: { unrefed: boolean } }> = []
  readonly cleared: unknown[] = []
  now(): number {
    return 1_700_000_000_000
  }
  setTimeout(_fn: () => void, ms: number): unknown {
    const handle = { unrefed: false, unref: (): void => void (handle.unrefed = true) }
    this.created.push({ ms, handle })
    return handle
  }
  clearTimeout(handle: unknown): void {
    this.cleared.push(handle)
  }
}

test('一次性定时器创建后立刻 unref：60s 那一发不许把进程钉住', () => {
  const clock = new SpyClock()
  const timers = createOneShotTimers(clock)
  for (const delayMs of [8_000, 25_000, 60_000]) timers.schedule(() => {}, delayMs)

  assert.equal(clock.created.length, 3, `应当建出 3 个复查定时器，实际 ${clock.created.length}`)
  for (const { ms, handle } of clock.created) {
    assert.equal(
      handle.unrefed,
      true,
      `${ms}ms 的定时器没有 unref —— 它会把事件循环钉住到 ${ms}ms（e2e 的 ~60s 尾巴就是这么来的）`,
    )
  }
})

test('cancelAll 撤掉全部：任务结束后不该再有复查去写 status.json', () => {
  const clock = new SpyClock()
  const timers = createOneShotTimers(clock)
  for (const delayMs of [8_000, 25_000, 60_000]) timers.schedule(() => {}, delayMs)

  timers.cancelAll()
  assert.deepEqual(
    clock.cleared,
    clock.created.map((item) => item.handle),
    'cancelAll 必须把登记过的句柄逐个 clearTimeout 掉',
  )
  // 可重复调用：stop() 可能被 effect 与 onDispose 两条路各走一次。
  timers.cancelAll()
  assert.equal(clock.cleared.length, 3, '第二次 cancelAll 不该重复清理（也不该抛错）')
})

test('假时钟的数字句柄上 unref 是空操作：测试不该为了这件事改成对象句柄', () => {
  const fake = new FakeClock()
  const timers = createOneShotTimers(fake)
  assert.doesNotThrow(() => timers.schedule(() => {}, 60_000), '数字句柄（FakeClock）上调用 unref 不许抛错')
  assert.equal(fake.pending, 1, 'FakeClock 应该照常记着这个定时器')
  timers.cancelAll()
  assert.equal(fake.pending, 0, 'cancelAll 对假时钟同样要生效')
})

test('unrefTimer 对没有 unref 的句柄一律安静：数字、null、undefined 都不该抛', () => {
  for (const handle of [1, 0, null, undefined, {}, 'handle']) {
    assert.doesNotThrow(() => unrefTimer(handle), `unrefTimer(${JSON.stringify(handle)}) 抛错了`)
  }
})
