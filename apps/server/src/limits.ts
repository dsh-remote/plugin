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
