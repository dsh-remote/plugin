/**
 * sleep-policy — 什么时候持锁、什么时候放锁（纯逻辑，执行交给 `SleepPort`）。
 *
 * 为什么把策略与执行拆开：旧实现把两者写在一个 `KeepAwake` 类里（在协议包里
 * spawn 子进程），于是"空闲自动释放"和"挂起审批时续锁"这两条没有任何测试，
 * 而其中一条正是旧实现的**持锁泄漏**：它靠"收到对应的终结事件"来解除
 * 60 秒心跳续锁，但那三类事件里**没有一条带 requestId**，判据永不成立，
 * 锁一旦因审批挂起就再也不会释放（取证 docs/legacy-spec/host-plugin-runtime.md §4
 * 与 host-plugin-cordis.md §3 表第 9b 行）。
 *
 * 本实现的判据全部用**插件自己生成的 requestId**，并且每条都有单测：
 * - 有活动（文本/工具/运行中）→ `markActive`；
 * - 有挂起的人工交互 → `hold(id)`，每 `pendingRefreshMs` 续一次锁；
 * - 终结只认 `release(id)`（手机答了、被平台撤销、或超时）——**不会**因为
 *   "看到一个没有 requestId 的事件"就以为它终结了；
 * - 空闲超过 `idleReleaseMs` 且无挂起 → 放锁；`idleReleaseMs <= 0` 表示永不自动释放。
 */
import type { Clock, SleepPort } from '../ports/index.js'

export interface KeepAwakeOptions {
  /** 空闲多久后自动释放锁（毫秒）。0 或负数 = 不自动释放。 */
  idleReleaseMs: number
  keepDisplay: boolean
  /** 锁断言绑定的宿主 pid：宿主崩了锁随之消失，不会留下永不睡机的机器。 */
  ownerPid: number
  /** 有人工交互挂起时，多久续一次锁。 */
  pendingRefreshMs: number
  /** 检查节拍。 */
  tickMs: number
}

export interface KeepAwakeSnapshot {
  enabled: boolean
  active: boolean
  platform: string
  backend: string
  reason?: string
}

const DEFAULTS: KeepAwakeOptions = {
  idleReleaseMs: 300_000,
  keepDisplay: false,
  ownerPid: process.pid,
  pendingRefreshMs: 60_000,
  tickMs: 10_000,
}

/** 拿锁失败后的重试退避：第一档 10 秒（= 一个 tick），之后翻倍，封顶 5 分钟。 */
const RETRY_BASE_MS = 10_000
const RETRY_MAX_MS = 300_000

export class KeepAwake {
  private options: KeepAwakeOptions
  private enabled = false
  private held = false
  private lastActiveAt = 0
  private lastRefreshAt = 0
  private readonly holds = new Set<string>()
  private timer: unknown
  private stopped = false
  private reason: string | undefined
  /** 连续拿锁失败次数（退避用）与下一次允许重试的时刻。 */
  private failures = 0
  private nextRetryAt = 0

  constructor(
    private readonly port: SleepPort,
    private readonly clock: Clock,
    options: Partial<KeepAwakeOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options }
    this.lastActiveAt = this.clock.now()
  }

  /**
   * 开关。关掉时立刻放锁——用户明确要求过"本地空闲时机器照常睡眠"。
   * `idleReleaseSec`（协议字段，单位秒）在这里换算；`0` 传进来表示不自动释放。
   */
  setEnabled(enabled: boolean, idleReleaseSec?: number): KeepAwakeSnapshot {
    this.enabled = enabled
    if (typeof idleReleaseSec === 'number') {
      this.options = { ...this.options, idleReleaseMs: idleReleaseSec * 1000 }
    }
    if (!enabled) this.stopLock()
    else {
      // 用户**显式**把开关打开：把失败退避清零，这一次要真去试（否则"刚打开就说没锁上、
      // 还要等退避窗口"看起来就是坏的）。
      this.failures = 0
      this.nextRetryAt = 0
      this.markActive()
    }
    return this.snapshot()
  }

  /** 任何内核活动都算一次"还活着"。 */
  markActive(): void {
    this.lastActiveAt = this.clock.now()
    this.evaluate()
  }

  /** 一次人工交互挂起（审批或提问）。id 必须是插件自己生成的 requestId。 */
  hold(id: string): void {
    this.holds.add(id)
    this.lastActiveAt = this.clock.now()
    this.evaluate()
  }

  /** 一次人工交互结束了（手机答了 / 平台撤销 / 超时）。 */
  releaseHold(id: string): void {
    this.holds.delete(id)
    this.evaluate()
  }

  /**
   * 判定此刻该不该持锁，并启动/维持节拍定时器。
   * 拆成单独方法是为了能被单测直接驱动（注入假时钟，不真的等 300 秒）。
   */
  evaluate(): KeepAwakeSnapshot {
    // 停机之后一律惰性：不持锁、不装定时器，只回一份"已经关了"的快照。
    if (this.stopped) return this.snapshot()
    const now = this.clock.now()
    const idleExpired = this.options.idleReleaseMs > 0 && now - this.lastActiveAt > this.options.idleReleaseMs
    const shouldHold = this.enabled && (this.holds.size > 0 || !idleExpired)
    if (shouldHold && !this.held) this.acquire()
    if (!shouldHold && this.held) this.stopLock()
    if (this.enabled && this.holds.size > 0 && now - this.lastRefreshAt >= this.options.pendingRefreshMs) {
      // 挂起期间续锁：即使空闲计时已过期，也不能因为"手机还没点"就放锁。
      this.lastRefreshAt = now
      this.lastActiveAt = now
      if (!this.held) this.acquire()
    }
    this.ensureTimer()
    return this.snapshot()
  }

  tick(): void {
    this.evaluate()
  }

  snapshot(): KeepAwakeSnapshot {
    this.reconcile()
    return {
      enabled: this.enabled,
      active: this.held,
      platform: this.port.platform(),
      backend: this.port.backend(),
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    }
  }

  /**
   * 停机：放锁并撤掉节拍。
   *
   * `stopped` 这个闸门不是洁癖。审批的 `releaseHold()` 可能在 `stop()` **之后**才到达
   * （手机端迟迟没点、平台撤销、超时结算三条路都可能），而 `releaseHold → evaluate →
   * ensureTimer` 会再装一个 `tickMs` 自循环定时器——没有这个标记时它永远清不掉：
   * 插件已经拆了 socket，节拍还在续锁，表现是"进程永不退出"（e2e 里那 60 秒的尾巴）
   * 和"用户关了远程控制，caffeinate 还在拦住机器睡眠"。
   */
  stop(): void {
    this.stopped = true
    this.stopLock()
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private acquire(): void {
    const now = this.clock.now()
    // 退避窗口内不再向后端发问：原来同步失败（没有受支持的平台、命令构造失败）会每
    // 10 秒原样重试一次，日志刷屏、也无谓地反复 spawn。
    if (now < this.nextRetryAt) return
    const started = this.port.start(this.options.ownerPid, this.options.keepDisplay)
    this.held = started.ok
    this.reason = started.message
    this.lastRefreshAt = now
    if (started.ok) {
      this.failures = 0
      this.nextRetryAt = 0
      return
    }
    this.failures += 1
    // 指数退避，封顶 5 分钟：一次失败之后间隔翻倍，但不会退到"再也不试"。
    this.nextRetryAt = now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failures - 1))
  }

  /**
   * 用后端的真实状态校正 `held`。
   *
   * 为什么必须有这一条：`port.start()` 的同步 `ok` 只说明"命令发出去了"——
   * macOS 上 spawn 失败是**异步** `'error'` 事件（见 `platform/sleep-posix.ts`），
   * 那一刻 `held` 还是 true，于是 status.json 与手机上的 `active` 一直谎报
   * "已开启防休眠"，而且因为 `held===true` 再也不会重试。`isActive()` 本来就是
   * 为对账准备的（后端只有它知道子进程还在不在），生产里此前没有人调。
   */
  private reconcile(): void {
    if (!this.held) return
    let alive = true
    try {
      alive = this.port.isActive()
    } catch {
      // 读不出来就别乱改状态：宁可多报一次"持锁中"，也不能把真的锁报成没了。
      return
    }
    if (alive) return
    this.held = false
    this.reason = '防休眠后端报告未持锁（spawn 失败或进程已退出）'
    // 下一个 tick 的 evaluate() 会按退避重新 acquire；这里不立刻重试，避免抖动。
    if (this.nextRetryAt === 0) this.nextRetryAt = this.clock.now() + RETRY_BASE_MS
  }

  private stopLock(): void {
    if (!this.held) return
    this.port.stop()
    this.held = false
  }

  private ensureTimer(): void {
    if (this.stopped || this.timer !== undefined) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      if (this.stopped) return
      this.tick()
    }, this.options.tickMs)
  }
}
