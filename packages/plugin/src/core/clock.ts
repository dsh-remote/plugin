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
