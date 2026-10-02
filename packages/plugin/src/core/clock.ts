/**
 * clock — 时间与定时器的注入点。
 *
 * 为什么端口里要有时钟：合帧窗口、空闲放锁、重连退避、审批超时这几件事
 * 全是**时间相关的策略**，没有注入点就只能靠真等（旧实现的窗口化与持锁策略
 * 就是这么没被测到的）。测试里换成假时钟，可以把 300 秒的空闲释放压成一次 `advance()`。
 */
import type { Clock } from '../ports/index.js'

export const DEFAULT_SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/**
 * 让一个定时器**不再拖住进程退出**。
 *
 * 为什么必须要这个东西：`Clock` 端口只承诺 `setTimeout/clearTimeout`，句柄是 `unknown`，
 * 所以"别为了我留着事件循环"这件事在端口上表达不出来。而"载具探测的复查"这类定时器是
 * **顺手看一眼**的取证动作——宿主要是还活着它就照跑，进程要是已经无别的事可做，它就该
 * 立刻退，而不是被最长的那一发钉住（`node e2e/run.mjs` 1.2s 跑完却 60s 才退，就是这么来的；
 * 同理任何 headless/CLI 跑法都会白等一分钟）。
 *
 * 对 `FakeClock` 的数字句柄是**空操作**：那种场景下定时器本来就归测试掌控，
 * 没有"事件循环"可拖。所以这里只认 `unref` 存在与否，不做类型假设。
 */
export function unrefTimer(handle: unknown): void {
  const maybe = handle as { unref?: () => void } | null | undefined
  if (maybe && typeof maybe.unref === 'function') maybe.unref()
}

/**
 * 一次性定时器集合：每个建出来都 **unref**（见上），并统一登记，好让调用方在停机时一次撤掉。
 *
 * 为什么 `unref` 与"集中撤销"要成对：只 unref 不撤销，宿主没退的情况下这些复查仍会在
 * 任务结束之后去写 status.json（写的是过期的取证）；只撤销不 unref，宿主空闲时进程又被钉住。
 * 两件事都做，才既有"不拖尾"又有"任务结束就安静"。
 */
export function createOneShotTimers(clock: Clock): {
  schedule(fn: () => void, delayMs: number): void
  cancelAll(): void
} {
  const handles: unknown[] = []
  return {
    schedule(fn, delayMs) {
      const handle = clock.setTimeout(fn, delayMs)
      unrefTimer(handle)
      handles.push(handle)
    },
    cancelAll() {
      // splice 让"撤过的不再撤"：stop() 可能被 effect 与 onDispose 两条路各走一次。
      for (const handle of handles.splice(0)) clock.clearTimeout(handle)
    },
  }
}

/** 假时钟：`advance(ms)` 按到期时间依次触发定时器，完全确定。 */
export class FakeClock implements Clock {
  private at = 1_700_000_000_000
  private sequence = 0
  private readonly timers = new Map<number, { at: number; fn: () => void }>()

  now(): number {
    return this.at
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.sequence
    this.timers.set(id, { at: this.at + ms, fn })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  /** 推进时间并触发所有到期定时器（按到期顺序，处理"定时器里又装定时器"）。 */
  async advance(ms: number): Promise<void> {
    const target = this.at + ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, timer] = due
      this.timers.delete(id)
      this.at = Math.max(this.at, timer.at)
      timer.fn()
      await Promise.resolve()
    }
    this.at = target
    await Promise.resolve()
  }

  get pending(): number {
    return this.timers.size
  }
}
