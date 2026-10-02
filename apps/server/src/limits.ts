/**
 * limits — 令牌桶与尝试计数。
 *
 * 为什么不引限流库（`rate-limiter-flexible` 虽 0 依赖）：它为分布式与多存储后端设计，
 * 而中继是单进程、内存计数即正确。~40 行换来的是"限流语义可被穷举测试"。
 *
 * 三条预算各有不同的失败表现，这个区别是协议的一部分：
 * - 单连接帧速率超限 → 回 `error{rate_limited}`，累计 3 次违规断开（1008）；
 *   不能每帧都回 error，否则一条洪水会变成一条错误洪水。
 * - 配对尝试：单连接计数（用尽 4008）+ 全局配额（超出只回 `pair-fail{rate_limited}`）。
 *   6 位码只有 10^6 空间，全局配额是唯一的暴力破解防线——取证
 *   `docs/legacy-spec/relay-and-wireformat.md` §5.3 与 docs/SECURITY.md 的量化段落。
 * - 主机鉴权：单连接计数，用尽 4001。
 *
 * 第四条预算（背压）特殊在**它是时间驱动的，不是事件驱动的**，见 `BackpressureGate`。
 */

/** 固定窗口配额：每秒重置一次。比漏桶更省，也更符合"每秒 N 次"的语义。 */
export class Budget {
  private windowAt = 0
  private left = 0

  constructor(
    private readonly perWindow: number,
    private readonly windowMs = 1000,
  ) {}

  /** 取一个配额；成功 true，用尽 false。 */
  take(now: number): boolean {
    if (now - this.windowAt >= this.windowMs) {
      this.windowAt = now
      this.left = this.perWindow
    }
    if (this.left <= 0) return false
    this.left -= 1
    return true
  }

  /** 当前窗口剩余（只为诊断与测试可读）。 */
  peek(now: number): number {
    if (now - this.windowAt >= this.windowMs) return this.perWindow
    return this.left
  }
}

/** 违规计数 + 达到上限即断开。 */
export class Violations {
  count = 0
  constructor(private readonly limit: number) {}

  hit(): boolean {
    this.count += 1
    return this.count >= this.limit
  }

  get exhausted(): boolean {
    return this.count >= this.limit
  }
}

/**
 * 单连接帧速率闸：窗口内超额返回 `over`，并告诉调用方这是不是第 N 次超额。
 * 把"是否要回错误帧"和"是否要断开"分开返回，避免调用方靠猜。
 */
export interface RateResult {
  allowed: boolean
  /** 本次是否触发了错误回复（窗口内首次超额才回，避免错误洪水）。 */
  shouldReport: boolean
  /** 本次是否应当断开连接。 */
  shouldClose: boolean
}

export class FrameRateGate {
  private readonly budget: Budget
  private readonly violations: Violations
  private reportedWindow = -1

  constructor(perSec: number, closeAfterViolations = 3) {
    this.budget = new Budget(perSec)
    this.violations = new Violations(closeAfterViolations)
  }

  check(now: number): RateResult {
    const allowed = this.budget.take(now)
    if (allowed) return { allowed: true, shouldReport: false, shouldClose: false }
    const window = Math.floor(now / 1000)
    const shouldReport = this.reportedWindow !== window
    if (shouldReport) this.reportedWindow = window
    return { allowed: false, shouldReport, shouldClose: this.violations.hit() }
  }
}

/**
 * 背压窗口：主机的对端是浏览器/内核，卡住它就是卡住所有人，所以沿用原来的 10s。
 */
export const HOST_SLOW_CONSUMER_MS = 10_000

/**
 * 背压窗口（客户端）：**必须严格大于对端自己的重连周期**，否则中继就成了一台
 * "永远在踢、手机永远在重连"的循环发动机。
 *
 * 推导（常量取自 `mp/core/socket.js`，本文件不复制它们的值，只在这里写算式）：
 *   CONNECT_TIMEOUT_MS(12s) + RECONNECT_MAX_MS(30s) + 抖动上限(0.5s) ≈ 42.5s → 取 45s
 * 为什么是这一串：手机被踢后 `onClose` 不读关闭码，`onOpen` 又把退避重置为 0，
 * 所以它最快 ~1s 就回来；只有把窗口放到"对端连一次带退避的完整周期"之外，
 * 才能区分"真的消费不动"和"只是刚重连上、积压还没排完"。
 * 这个不变量由 `tests/limits.test.mjs` 直接读 mp 源码的常量来锁——对端一改，这里就红。
 */
export const CLIENT_SLOW_CONSUMER_MS = 45_000

export interface BackpressureResult {
  /** 连续超限是否已超过窗口。 */
  shouldClose: boolean
  /** 已连续超限多久（ms）；未超限时为 0，写日志用。 */
  overMs: number
}

/**
 * 背压闸：缓冲量连续超限**达到窗口**才判定该断；中途降回限内则计时清零。
 *
 * 为什么不是"超限就断"：发送积压常有毫秒级尖峰（一次大帧、一次 GC），
 * 用瞬时值判定会把健康连接打成断续。为什么是"连续"而不是"累计"：
 * 累计会让一个偶尔超限的连接在长时间后被莫名踢掉，且踢掉的时机与原因无关。
 *
 * 为什么窗口由调用方传：中继是按 `role` 选窗口（主机 10s / 客户端 45s），
 * 把角色判定留在 server.ts，这个类才能保持纯函数式、可穷举测试。
 */
export class BackpressureGate {
  private overSince: number | null = null

  check(buffered: number, limit: number, now: number, windowMs: number): BackpressureResult {
    if (buffered <= limit) {
      this.overSince = null
      return { shouldClose: false, overMs: 0 }
    }
    if (this.overSince === null) this.overSince = now
    const overMs = now - this.overSince
    return { shouldClose: overMs >= windowMs, overMs }
  }
}
