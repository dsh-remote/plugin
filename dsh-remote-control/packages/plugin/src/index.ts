/**
 * index — cordis bundle 入口（host 侧）。
 *
 * 职责边界（取证 docs/legacy-spec/host-plugin-cordis.md §1）：这个文件只做四件事
 * —— 读配置并校验、探测内核载体、把内核端口/中继客户端/运行时/防休眠接起来、
 * 注册 `/drc` 命令并持续写状态快照。业务逻辑都在 `core/`，平台知识都在 `platform/`。
 *
 * 三条不可违反的纪律：
 *
 * 1. **`apply()` 绝不向外抛异常**。宿主加载 bundle 时若这里抛出，整个 profile 起不来。
 *    所有失败路径都收敛成"写一次 status.json + 记一条日志"。
 * 2. **不写 `inject:` 闸门**（见同目录 cordis.patch.yml 注释）：本文件对每个内核面
 *    都软探测，写闸门只会让某一代宿主缺服务时整行不激活、插件静默不加载。
 * 3. **`provide()` 无条件执行**：外部（测试、其它插件）拿到的永远是同一个句柄，
 *    runtime 还没起来时 `createPairing()` 返回 null，而不是"这个插件不存在"。
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { type CmdPayload, type EvPayload, buildPairingUri } from 'dsh-remote-wire'
import { HostRuntime, type RuntimeTransport } from './core/runtime.js'
import { KeepAwake } from './core/sleep-policy.js'
import { PairingSlots } from './core/keys.js'
import { PairingWindow } from './core/pairing-window.js'
import { RelayClient } from './transport/relay.js'
import { SystemSleepBackend } from './platform/sleep-posix.js'
import { createServicesKernel } from './platform/carrier-services.js'
import { createOneShotTimers, DEFAULT_SYSTEM_CLOCK } from './core/clock.js'
import { pairingImagePath, StatusFile, writePrivateFile } from './shell/status.js'
import { pairingPairText, PAIR_UNAVAILABLE_TEXT } from './shell/pairing-text.js'
import { DEFAULT_CONFIG, readConfig, redact, validateConfig, type PluginConfig } from './shell/config.js'
import { renderTerminalQr, qrPng } from './platform/qr.js'
import type { KernelPort, Clock } from './ports/index.js'

/** 我们只用到 ctx 的几个成员，所以不硬依赖 @deepseek-ai/cordis 的类型。 */
interface LooseContext {
  get?<T>(name: string, optional: true): T | undefined
  /**
   * `inject(names, cb)` 的回调参数**不是服务实例，而是已作用域化的上下文**（`c.get(name, true)`
   * 才拿到服务），并且这条回调 fiber 挂在我们这条 fiber 下面——我们的 fiber 一旦失败，
   * 它会连带被 dispose，回调就永远不会触发了（真机取证见 `apply()` 末尾那条纪律）。
   */
  inject?(names: string[], callback: (scoped: LooseContext) => void): unknown
  /** 事件注册口；作用域化上下文上才有，对 waterfall 是参与式监听（见 platform/guard.ts）。 */
  on?(name: string, listener: (...args: unknown[]) => void): unknown
  off?(name: string, listener: (...args: unknown[]) => void): unknown
  provide?(name: string, value: unknown): unknown
  /**
   * cordis 唯一的卸载钩子：`ctx.effect(() => disposer)`。
   * **没有 `onDispose` 这个东西**——ctx 是 Proxy，读不存在的属性名是"抛错"而不是
   * 返回 undefined，`?.` 挡不住（真机取证：`cannot get property "onDispose" without inject`
   * 让 apply 整体失败 → fiber FAILED → 六个 inject 子 fiber 全被 dispose → carrier=none）。
   */
  effect?(execute: () => (() => unknown) | void): unknown
  commands?: {
    register?(definition: {
      name: string
      description: string
      input?: { hint?: string }
      handler?: (invocation: { commandId: string; rawInput: string; agent?: unknown }) => Promise<unknown> | unknown
    }): unknown
  }
}

export interface RuntimeHandle {
  readonly config: PluginConfig
  state(): Record<string, unknown>
  createPairing(): { qr: string; token: string; psk: string; expiresAt: number } | null
  /** 某条会话的工作区目录；解析不出来是 undefined（二维码 PNG 因此退回 `~/.dsh/`）。 */
  sessionWorkspace(sessionId: string): string | undefined
  stop(): void
}

const SERVICE_NAMES = [
  'sessions',
  'sessionQuery',
  'agents',
  'agentDefaultModel',
  'workspaceRegistry',
  'userQuestions',
  'sessionController',
]

/** 同时保持的配对通道硬上界：超出就从最不活跃的开始剪（空闲 TTL 之外的第二道闸）。 */
const MAX_CONVERSATIONS = 64

/** 取证：同一个进程里宿主调用了几次 `apply`（bundle 被重复挂载时能看到）。 */
const APPLY_COUNT = { n: 0 }

/**
 * 宿主命令的返回契约（`@deepseek-ai/dsh-commands` 的 `normalizeResult`）。
 *
 * 只有两种 kind；别的值会在注册边界上 `throw TypeError("...unknown result kind...")`，
 * 整条命令失败。**把它写成类型**是为了让"写错 kind"在编译期就红，而不是等用户在
 * 真机上看到一句宿主内部错误。
 */
export type CommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

/** 默认时钟：真实定时器。测试注入假时钟（见 core/clock.ts）。 */
export const systemClock: Clock = DEFAULT_SYSTEM_CLOCK

export function apply(ctx: LooseContext, injected: Partial<PluginConfig> = {}): void {
  let handle: RuntimeHandle | undefined
  try {
    handle = applyInner(ctx, injected)
  } catch (error) {
    // 兜底：任何一步抛出都不许穿出去。
    try {
      process.stderr.write(`[dsh-remote-control] apply failed: ${String((error as Error)?.stack ?? error)}\n`)
    } catch {
      /* stderr 也可能不可用 */
    }
  }
  // applyInner 之后碰 ctx 的每一句都必须各自包 try。
  // 真机取证（status.json 的 probe.fiberStates）：原来这里写的是
  //   ctx.onDispose?.(() => handle?.stop())
  // 而 cordis 的 ctx 是 Proxy——读一个**它没有的**属性名不是返回 undefined，是抛错
  // （reflect.ts 的 get trap：`cannot get property "onDispose" without inject`），
  // 可选链 `?.` 只挡 null/undefined、挡不住抛错。这一句抛出被 Fiber._reload 捕获，
  // 我们的 fiber 进 FAILED → _unload 把 applyInner 里登记的六个 ctx.inject 子 fiber
  // 一起 dispose（probe.injectChildren 全在 @DISPOSED/uid=null）→ 回调永远不触发 →
  // carrier=none，哪怕 `ctx.get('sessions', true)` 两秒后一直拿得到服务。
  // 卸载钩子只能用 cordis 真存在的 `ctx.effect`（reflect.ts:220 mixin 了它）。
  try {
    ctx.provide?.('dshRemoteControl', {
      get state(): Record<string, unknown> {
        return handle?.state() ?? { relay: 'offline', carrier: 'none', reason: 'not-started' }
      },
      createPairing: (): { qr: string; token: string; psk: string; expiresAt: number } | null =>
        handle?.createPairing() ?? null,
      // presentation 那一半要按会话解析落点（右栏那张图放哪），而"会话 → 工作区"这点
      // 平台知识只在本插件里有。**在这里开一个口，而不是让那一半自己去探内核服务**：
      // 两份探测迟早分叉，而分叉的表现是"卡片说 A 地、右栏读 B 地"，很难查。
      sessionWorkspace: (sessionId: string): string | undefined => handle?.sessionWorkspace(sessionId),
    })
  } catch {
    /* 这一代宿主可能不支持 provide */
  }
  let disposeHooked = false
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => void handle?.stop())
      disposeHooked = true
    }
  } catch {
    /* 没有 effect 口的代际 */
  }
  if (!disposeHooked && 'onDispose' in ctx) {
    // `'x' in ctx` 走的是 Proxy 的 has trap，不抛错——这是在这个宿主上"探测一个属性
    // 到底有没有"的唯一安全姿势；直接点属性就等着抛。测试替身/别的代际才提供 onDispose。
    try {
      ;(ctx as { onDispose?: (fn: () => void) => void }).onDispose?.(() => void handle?.stop())
    } catch {
      /* 同上 */
    }
  }
}

function applyInner(ctx: LooseContext, injected: Partial<PluginConfig>): RuntimeHandle | undefined {
  const config = readConfig(injected)
  const clock = systemClock
  // 载具探测的复查（8s/25s/60s）与载具宽限都是"宿主还活着就顺手看一眼"的一次性动作。
  // 它们必须 unref 且在停机时撤掉，否则 60s 那一发会把事件循环钉住——`node e2e/run.mjs`
  // 1.2s 跑完却 60s 才退出、任何 headless/CLI 跑法白等一分钟，都出自这里（见 core/clock.ts）。
  const oneShot = createOneShotTimers(clock)
  const status = new StatusFile(config.statusFile, clock)
  const problems = validateConfig(config)
  const log = (message: string, fields: Record<string, string | number | boolean | undefined> = {}): void => {
    try {
      process.stdout.write(
        `${JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: `dsh-remote-control ${message}`, ...fields })}\n`,
      )
    } catch {
      /* GUI 宿主里 stdout 可能不可用 */
    }
  }
  for (const problem of problems) {
    log(`config ${problem.level}`, { field: problem.field, message: problem.message })
  }

  if (!config.enabled) {
    status.write({ carrier: 'none', relay: 'idle', reason: 'disabled' })
    return undefined
  }
  if (problems.some((problem) => problem.level === 'error')) {
    // 有 error 级问题就不启动，但一定留下面包屑：否则"为什么什么都没发生"没有答案。
    status.write({
      carrier: 'none',
      relay: 'idle',
      reason: 'invalid-config',
      serverUrl: config.serverUrl,
      hostToken: undefined,
      problems: problems.map((problem) => `${problem.level}:${problem.field}:${problem.message}`),
    })
    return undefined
  }

  const slots = new PairingSlots(() => clock.now())
  const sleep = new KeepAwake(new SystemSleepBackend(), clock, {
    idleReleaseMs: config.keepAwake.idleReleaseSec * 1000,
    keepDisplay: config.keepAwake.keepDisplay,
  })
  if (config.keepAwake.enabled) sleep.setEnabled(true)

  let kernel: KernelPort | undefined
  let runtime: HostRuntime | undefined
  let relay: RelayClient | undefined
  let startedCarrier = ''
  // RelayClient 是唯一知道连接此刻怎么样的一方；状态快照读这两个值。
  let lastRelayState: 'online' | 'connecting' | 'offline' = 'connecting'
  let lastRelayProblem: string | undefined
  let lastRelayGeneration = 0

  const transport: RuntimeTransport = {
    reply(conversationId: string, payload: EvPayload): boolean {
      return relay ? relay.send(conversationId, payload) : false
    },
    broadcast(payload: EvPayload): number {
      return relay ? relay.broadcast(payload) : 0
    },
    hasPeer(conversationId: string): boolean {
      return relay?.hasPeer(conversationId) ?? false
    },
    conversationIds(): string[] {
      return relay?.conversationIds() ?? []
    },
    voidConversation(conversationId: string): void {
      relay?.voidConversation(conversationId)
    },
  }

  const start = (port: KernelPort): void => {
    if (runtime) return
    kernel = port
    startedCarrier = port.carrier
    relay = new RelayClient({
      url: config.serverUrl,
      hostId: config.hostId || `h_${randomBytes(3).toString('hex')}`,
      label: config.hostLabel,
      token: config.hostToken,
      clock,
      log,
      lookupPairingSlot: (token) => slots.resolveFor(token),
      onPairReady: (token, ttlMs) => {
        // 服务端权威 TTL：不改写就会提前清掉 PSK，造成"配对成功但全解不开"。
        if (!slots.applyServerTtl(token, ttlMs)) log('pair-ready for an unknown token', { token })
        pairingWindow.applyServerTtl(token, ttlMs)
      },
      onPeerJoined: (conversationId, pairingToken) => {
        runtime?.start()
        void runtime?.pushSessions('peer-joined')
        // 一次性码用掉了就当场换一张新的（而不是等半程刷新）：第二部手机要的是一张新码，
        // 多轮真链路取证也靠这条才不用重启宿主。
        if (pairingToken) {
          pairingWindow.markConsumed(pairingToken)
          // status.json 里也不能再挂着这张已经用掉的码：外部脚本只看年龄，不看是否被消费。
          if (active.pairing?.token === pairingToken) active.pairing = null
        }
        log('client paired', { conversationId })
      },
      onClientLeft: () => {
        void runtime?.pushSessions('client-left')
      },
      onConversationGone: (conversationId) => log('conversation gone', { conversationId }),
      onCommand: (conversationId, cmd: CmdPayload) => void runtime?.handleCommand(cmd, conversationId),
      onState: (info) => {
        lastRelayState = info.relay
        lastRelayProblem = info.problem
        lastRelayGeneration = info.generation
      },
      // 配对通道长存（D3）之后必须自己剪枝：中继那边的空闲 TTL 是 7 天，
      // 不剪就是无界的 PSK 簿 + 每次广播对废弃通道逐个密封。
      prunePolicy: { idleTtlMs: config.conversationIdleTtlSec * 1000, maxConversations: MAX_CONVERSATIONS },
    })
    runtime = new HostRuntime(port, transport, sleep, clock, {
      listingRefreshMs: config.listingRefreshSec * 1000,
      unarchiveOnPrompt: config.unarchiveOnPrompt,
      approvalTimeoutMs: config.approvalTimeoutSec * 1000,
      log: (message, fields) => log(message, fields),
    })
    relay.connect()
    // 自动发码走 pairingWindow，而不是启动时发一张就完事：
    // 一张码是一次性的，用完/中继重启/过半程都得换一张（判据见 core/pairing-window.ts）。
    // tick 挂在 status 的 3 秒节拍上（旧实现就是挂在这里），并且**先 tick 一次**，
    // 让 `pairOnStartSec>0` 的实例一起来就能看到 status.json 里有码。
    pairingWindow.tick()
    status.start(() => {
      pairingWindow.tick()
      relay?.pruneConversations()
      return state()
    })
  }

  const publishPairing = (
    ttlMs = config.pairTtlMs,
  ): { qr: string; token: string; psk: string; expiresAt: number } | null => {
    if (!relay) return null
    const slot = slots.create(ttlMs)
    // 发不出去就不算一张码：`raw()` 对非 OPEN 的 socket 是静默丢弃，
    // 只记本地会留下"status.json 显示有效、中继那边根本没收到"的死码（取证 §6.2）。
    if (!relay.publishPairing(slot)) {
      log('pairing published to a socket that is not open', { token: slot.token })
      return null
    }
    const qr = buildPairingUri({
      server: config.serverUrl,
      psk: slot.psk,
      hostLabel: config.hostLabel,
      token: slot.token,
    })
    return { qr, token: slot.token, psk: slot.psk, expiresAt: slot.expiresAt }
  }

  const state = (): Record<string, unknown> => {
    const snapshot = sleep.snapshot()
    return {
      carrier: startedCarrier || (config.mockBridge ? 'mock' : 'probing'),
      serverUrl: config.serverUrl,
      hostLabel: config.hostLabel,
      relay: relay ? relayState() : 'idle',
      relayProblem: relayProblem(),
      conversations: relay?.conversationCount ?? 0,
      pendingPairs: slots.size,
      pairing: describeActivePairing(),
      keepAwake: snapshot,
      kernel: kernel?.describe() ?? null,
      // 出站计数：手机上"没收到 X"的第一现场对比点（插件没发 vs 发了但路上丢了）。
      outbound: runtime?.stats ?? null,
      probe,
      // token 永远不出现真值；这条有测试锁住。
      hostToken: undefined,
      hostTokenShape: config.hostToken ? redact(config.hostToken) : undefined,
      mockBridgeForced: config.mockBridge,
      problems: problems.map((problem) => `${problem.level}:${problem.field}`),
      ...(config.pairOnStartSec > 0 ? { pairOnStartWarn: 'status.json 里带着仍然有效的配对码与 PSK' } : {}),
    }
  }

  const active = { pairing: null as { qr: string; token: string; expiresAt: number } | null }
  /**
   * status.json 里的 `pairing` 必须是**窗口正在维护的那一张**（它的 QR 才在 active.pairing 里），
   * 不是 `slots.latest()`：手工 /drc pair 之后自动刷新会发新的一张，两者一旦分叉，
   * 外部脚本读到的是"一张没有二维码的码"。用 `resolveFor` 取密钥顺带把已过期的剔掉。
   */
  function describeActivePairing(): Record<string, unknown> | null {
    const shown = active.pairing
    if (!shown) return null
    const slot = slots.resolveFor(shown.token)
    if (!slot) return null
    return {
      token: slot.token,
      psk: slot.psk,
      expiresAt: new Date(slot.expiresAt).toISOString(),
      qr: shown.qr,
      ageSec: Math.max(0, Math.round((clock.now() - slot.createdAt) / 1000)),
    }
  }

  function relayState(): 'online' | 'connecting' | 'offline' {
    return lastRelayState
  }
  function relayProblem(): string | undefined {
    return lastRelayProblem
  }

  const wrappedPublish = (ttlMs = config.pairTtlMs): ReturnType<typeof publishPairing> => {
    const created = publishPairing(ttlMs)
    if (created) {
      active.pairing = { qr: created.qr, token: created.token, expiresAt: created.expiresAt }
      // 手工发的那张也要让窗口认领，否则窗口以为"没有活动码"又发一张。
      pairingWindow.adopt({ token: created.token, createdAt: clock.now(), expiresAt: created.expiresAt })
    }
    return created
  }

  const createPairing = (): ReturnType<typeof wrappedPublish> => wrappedPublish()

  /**
   * "让屏幕上永远有一张能用的码"这条策略（四条 stale 判据 + online 闸门，
   * 逐条动机见 `core/pairing-window.ts` 文件头）。tick 挂在 status 的 3 秒节拍上。
   */
  const pairingWindow = new PairingWindow(
    {
      clock,
      relayOnline: () => lastRelayState === 'online' && relay !== undefined,
      generation: () => lastRelayGeneration,
      publish: (ttlMs) => {
        const created = wrappedPublish(ttlMs)
        if (!created) return null
        return { token: created.token, createdAt: clock.now(), expiresAt: created.expiresAt }
      },
      log,
    },
    config.pairOnStartSec,
  )

  // ── 载体探测：services > apiproxy > (mock) ─────────────────────────
  const collected: Record<string, unknown> = {}
  const hasServices = (): boolean => typeof collected.sessions === 'object' && collected.sessions !== null
  const apiProxyOf = (): unknown => collected.apiProxy

  const probe: Record<string, string> = {}
  const injectFired: string[] = []
  let hasGet = true
  let hasInject = true
  let decided = false
  /** 取证：`ctx.inject` 返回的子 fiber，用来区分"依赖没满足"和"子 fiber 已被拆掉"。 */
  const injectChildren: [string, unknown][] = []
  /** 取证：我们这条 fiber 的生命周期轨迹（含进入 UNLOADING/DISPOSED 时的调用栈）。 */
  const states: string[] = []
  const tryStart = (): void => {
    if (runtime) return
    if (hasServices()) {
      if (decided) {
        // 服务热补丁进同一个对象：runtime 已经持有它的引用，不需要重启。
        return
      }
      decided = true
      start(createServicesKernel(collected as never, { log, takeOverQuestions: config.takeOverQuestions, clock }))
      return
    }
    // 没有 services 载体就不启动，也不再退回 apiProxy/typert：
    // 桌面态从未注册 apiProxy 服务，而它的调用信封在旧实现里整个是错的、无法验证；
    // typert 只有 invoke()，既不能列会话也不能发指令，接上去只是一台"永远空列表"的机器。
    // （取证 docs/legacy-spec/host-plugin-cordis.md §2.4 表与 §3 表第 14-19 行）
    if (typeof ctx.get?.('apiProxy', true) === 'object') {
      log('apiProxy present but unsupported by this build', { hint: '只做诊断记录，不接这条载体' })
    }
  }

  /** 关键成员先验：收下不合法的对象比不收更糟（旧实现踩过的坑）。 */
  const requiredMember: Record<string, string> = { sessions: 'list', sessionQuery: 'listSessions', agents: 'get' }
  /** 把服务对象的前几个成员拼成可读指纹；这是取证，绝不许抛。 */
  const keysOf = (value: unknown): string => {
    try {
      return Object.keys(value as object)
        .slice(0, 6)
        .join('|')
    } catch (error) {
      return `keys threw: ${String((error as Error)?.message ?? error).slice(0, 60)}`
    }
  }
  /** 一个候选来源里取出 `name`：先按"作用域上下文"读，读不到再按"直接就是服务"读。 */
  const pickFrom = (source: unknown, name: string): unknown => {
    if (!source || typeof source !== 'object') return undefined
    const asContext = source as LooseContext
    if (typeof asContext.get === 'function') {
      try {
        const got = asContext.get(name, true)
        if (got) return got
      } catch {
        /* 这个候选没有该服务 */
      }
    }
    try {
      // 直接点属性在 cordis 上下文上只在"这个名字已注入本 fiber"时成立，否则 get trap
      // 抛错（不是返回 undefined）——所以这里必须包 try。
      return (source as Record<string, unknown>)[name]
    } catch {
      return undefined
    }
  }
  /**
   * 收下探到的服务并尝试启动；`via` 只用于把"从哪条路拿到的"记进 probe。
   * 晚到的服务热补丁进同一个对象：runtime 已经持有它的引用，不需要重启。
   */
  const accept = (name: string, value: unknown, source: unknown, via: string): boolean => {
    if (!value || typeof value !== 'object') return false
    const member = requiredMember[name]
    if (member && typeof (value as Record<string, unknown>)[member] !== 'function') {
      probe[name] = `object without ${member}()`
      return false
    }
    collected[name] = value
    const asContext = source as LooseContext | undefined
    if (name === 'sessions' && typeof collected.on !== 'function' && typeof asContext?.on === 'function') {
      collected.on = asContext.on.bind(asContext)
      if (typeof asContext.off === 'function') collected.off = asContext.off.bind(asContext)
    }
    probe[name] = `${via}(${keysOf(value)})`
    tryStart()
    return true
  }

  for (const name of SERVICE_NAMES) {
    try {
      if (typeof ctx.get !== 'function') hasGet = false
      const found = ctx.get?.(name, true)
      probe[name] = found
        ? typeof found === 'object'
          ? `object(${Object.keys(found as object)
              .slice(0, 6)
              .join('|')})`
          : typeof found
        : 'none'
      if (found) collected[name] = found
    } catch (error) {
      // 这一代宿主没这个服务
      probe[name] = `get threw: ${String((error as Error)?.message ?? error).slice(0, 60)}`
    }
    try {
      // 关键：`ctx.inject(names, cb)` 的回调参数**不是服务实例，而是已作用域化的上下文**，
      // 要在回调里 `c.get(name, true)` 才拿得到东西（第一版按"回调参数=服务"写，
      // 结果六个服务全 none、carrier=none —— 这个形状错了比抛错更难查）。
      const child = ctx.inject?.([name], ((...cbArgs: unknown[]) => {
        injectFired.push(`${name}(args=${cbArgs.length})`)
        probe.injectFiredLive = injectFired.join('|')
        // 回调整段包 try：这条子 fiber 的 apply 抛出会让 cordis 把它连同我们其它
        // 五条探测一起 dispose 掉，代价是"服务明明在、carrier 却起不来"。
        try {
          // 取证：不同代际这里拿到的可能是"作用域上下文"，也可能直接就是服务。逐个试。
          let value: unknown
          let from: unknown
          for (const candidate of [cbArgs[0], ...cbArgs, ctx]) {
            value = pickFrom(candidate, name)
            if (value) {
              from = candidate
              break
            }
          }
          if (accept(name, value, from, 'via inject')) return
          if (!value) probe[name] = `${probe[name] ?? 'none'} (inject fired, empty)`
        } catch (error) {
          probe[`injectThrew:${name}`] = String((error as Error)?.message ?? error).slice(0, 160)
        }
      }) as never)
      if (child !== undefined) injectChildren.push([name, child])
    } catch (error) {
      hasInject = false
      probe[name] = `${probe[name] ?? 'none'}; inject threw: ${String((error as Error)?.message ?? error).slice(0, 60)}`
    }
  }
  probe.hasGet = String(hasGet)
  probe.hasInject = String(hasInject)
  // 一次性取证：这一代宿主到底给了 ctx 什么。猜"名字对不对"之前先看形状。
  probe.ctxKeys = Object.keys(ctx).slice(0, 40).join('|')
  probe.ctxProtoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx) ?? {})
    .slice(0, 40)
    .join('|')
  for (const candidate of ['sessions', 'agents']) {
    try {
      const strict = (ctx as { get?: (n: string) => unknown }).get?.(candidate)
      probe[`strictGet:${candidate}`] = strict ? 'object' : 'undefined'
    } catch (error) {
      probe[`strictGet:${candidate}`] = `threw: ${String((error as Error)?.message ?? error).slice(0, 70)}`
    }
  }
  // 有些代际要靠 effect/fiber 才看得到服务；有就登记一条"等一会再看"的复查。
  // 注意 `injectFiredLive`（而不是任何在 apply 同步段里取的快照）才是"回调到底有没有
  // 触发"的证据：inject 回调最快也要一个微任务之后才跑，同步取的那一笔永远是 never。
  probe.hasEffect = String(typeof (ctx as { effect?: unknown }).effect === 'function')
  probe.hasFiber = String(
    typeof (ctx as { fiber?: unknown }).fiber === 'function' || (ctx as { fiber?: unknown }).fiber !== undefined,
  )

  // ── 取证（只记录现场，不改变行为）────────────────────────────────
  // 每一次猜错都要付一次"重启 Harness"的代价，所以把定根因需要的东西一次拿全：
  // 这个 cordis root 到底注册了哪些服务、我们的 fiber 挂在哪棵树上、谁调用了 apply。
  const asRecord = (value: unknown): Record<string | symbol, unknown> =>
    value && typeof value === 'object' ? (value as Record<string | symbol, unknown>) : {}
  const liveFiberChain = (): string[] => {
    const chain: string[] = []
    const seen = new Set<unknown>()
    let fiber: unknown = asRecord(ctx).fiber
    while (fiber && !seen.has(fiber) && chain.length < 12) {
      seen.add(fiber)
      const record = asRecord(fiber)
      const entryId = asRecord(record.entry).id
      // state 数字即 cordis FiberState：0 PENDING / 1 LOADING / 2 ACTIVE / 3 DISPOSED / 4 UNLOADING
      chain.push(
        `${String(record.name ?? '?')}#${String(record.uid ?? 'null')}@${String(record.state ?? '?')}${entryId ? `[${String(entryId)}]` : ''}`,
      )
      fiber = asRecord(asRecord(record.parent).fiber === record.fiber ? null : asRecord(record.parent).fiber)
    }
    return chain
  }
  const liveStore = (): string[] => {
    const store = asRecord(asRecord(ctx).reflect).store
    const names: string[] = []
    for (const key of Object.getOwnPropertySymbols(asRecord(store))) {
      const impl = asRecord(asRecord(store)[key])
      names.push(`${String(impl.name)}@${String(asRecord(impl.fiber).state ?? '?')}`)
    }
    return names
  }
  const liveIsolate = (): string[] => {
    const map = asRecord(ctx)[Symbol.for('cordis.isolate')]
    // isolate map 是 Object.create(null) 的**原型链**，每条 loader entry 自己那一层
    // 往往是空的——只数 own key 会永远得到空串，必须用 for...in 连继承的一起看。
    const names: string[] = []
    for (const key in map as object) names.push(`${key}=${String(asRecord(map)[key])}`)
    return names
  }
  const collectForensics = (prefix: string): void => {
    try {
      probe[`${prefix}store`] = liveStore().join('|').slice(0, 900)
      probe[`${prefix}isolate`] = liveIsolate().join(',').slice(0, 900)
      probe[`${prefix}props`] = Object.getOwnPropertyNames(asRecord(asRecord(asRecord(ctx).reflect).props))
        .slice(0, 160)
        .join('|')
      probe[`${prefix}fibers`] = liveFiberChain().join(' <- ').slice(0, 600)
      for (const name of SERVICE_NAMES) {
        const got = ctx.get?.(name, true)
        probe[`${prefix}get:${name}`] = got
          ? `object(${Object.keys(got as object)
              .slice(0, 5)
              .join('|')})`
          : 'undefined'
      }
    } catch (error) {
      probe[`${prefix}forensicsThrew`] = String((error as Error)?.message ?? error).slice(0, 120)
    }
  }
  collectForensics('t0:')
  probe.injectFiredLive = injectFired.join('|') || 'never'
  // 生命周期取证：`internal/status` 是 emit-mode（cordis events.d.ts:219），订阅安全。
  // 只记自己这条 fiber；进入 UNLOADING/DISPOSED 时抓一次栈，看清是谁把我们拆掉的。
  APPLY_COUNT.n += 1
  probe.applyCount = `${String(APPLY_COUNT.n)}@${clock.now()}`
  try {
    ctx.on?.('internal/status', ((fiber: unknown, oldState: unknown) => {
      if (asRecord(fiber) !== asRecord(ctx).fiber) return
      const record = asRecord(fiber)
      const state = Number(record.state ?? -1)
      const entry = asRecord(record.entry)
      const error = record._error
      const tail = `${
        error
          ? ` err=${String((error as Error)?.name ?? '')}:${String((error as Error)?.message ?? error).slice(0, 200)} @${String(
              (error as Error)?.stack ?? '',
            )
              .split('\n')
              .slice(1, 4)
              .map((line) => line.trim().replace(/^at\s+/, ''))
              .join(' <- ')}`
          : ''
      }${
        state >= 4
          ? ` stack=${String(new Error('drc-dispose').stack ?? '')
              .split('\n')
              .slice(1, 7)
              .map((line) => line.trim().replace(/^at\s+/, ''))
              .join(' <- ')
              .slice(0, 400)}`
          : ''
      }`
      states.push(
        `${clock.now()}:${String(oldState)}->${String(state)} entry=${String(entry.id ?? '?')}/disabled=${String(entry.disabled ?? '?')}${tail}`,
      )
      probe.fiberStates = states.join(' | ').slice(0, 1800)
    }) as never)
  } catch (error) {
    probe.statusWatch = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }
  probe.processShape = [
    String((process as unknown as { type?: string }).type ?? ''),
    String((process.versions as unknown as { electron?: string }).electron ?? 'no-electron'),
    String(process.argv[2] ?? '')
      .split('/')
      .pop() ?? '',
    String(process.argv[3] ?? '')
      .split('/')
      .pop() ?? '',
  ].join('|')
  // 谁调用 apply：栈里能看出是 cordis-plugin-loader 还是别的包装层。
  probe.applyStack = String(new Error('drc-probe').stack ?? '')
    .split('\n')
    .slice(1, 9)
    .map((line) => line.trim().replace(/^at\s+/, ''))
    .join(' <- ')
    .slice(0, 900)
  try {
    const loader = ctx.get?.('loader', true) as { entries?: () => Iterable<unknown> } | undefined
    if (typeof loader?.entries === 'function') {
      const rows: string[] = []
      for (const entry of loader.entries()) {
        const options = asRecord(asRecord(entry).options)
        rows.push(`${String(options.id ?? '?')}=${String(options.name ?? '?')}`)
        if (rows.length >= 300) break
      }
      probe.loaderRows = rows.join(',').slice(0, 2600)
    } else {
      probe.loaderRows = 'no-loader-service'
    }
  } catch (error) {
    probe.loaderRows = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }
  // 服务可能晚到：8s / 25s / 60s 各复查一次，把"根本没提供"和"提供得晚"分开。
  for (const delayMs of [8_000, 25_000, 60_000]) {
    try {
      oneShot.schedule(() => {
        probe.injectFiredLive = injectFired.join('|') || 'never'
        probe.injectFired = probe.injectFiredLive
        collectForensics(`t${delayMs}:`)
        probe.injectChildren = injectChildren
          .map(([childName, child]) => {
            const record = asRecord(child)
            const store = asRecord(record.store)
            return `${childName}@${String(record.state ?? '?')}/uid${String(record.uid ?? 'null')}${store ? `[${Object.keys(store).join('|')}]` : ''}`
          })
          .join(' ')
        probe.fiberStates = states.join(' | ').slice(0, 1800)
        // 兜底：inject 子 fiber 若因任何原因没被唤醒，直接查 store——`ctx.get` 不要求
        // inject，真机取证显示它在同一个 ctx 上一直是拿得到的。
        for (const name of SERVICE_NAMES) {
          if (collected[name]) {
            // 已经收下了，但"从哪条路收的"那一笔可能没写进去（accept 里的取证写入是尽力而为）。
            if (!String(probe[name] ?? '').startsWith('via')) probe[name] = `via held(${keysOf(collected[name])})`
            continue
          }
          try {
            accept(name, ctx.get?.(name, true), ctx, 'via get@poll')
          } catch {
            /* 还是没有这个服务 */
          }
        }
        tryStart()
        status.write({ ...state(), carrier: startedCarrier || 'none', probe })
      }, delayMs)
    } catch {
      /* 时钟不可用就少一次复查，不影响主流程 */
    }
  }
  try {
    const proxy = ctx.get?.('apiProxy', true)
    if (proxy) collected.apiProxy = proxy
  } catch {
    /* desktop 态通常没注册 apiProxy */
  }
  try {
    ctx.inject?.(['apiProxy'], ((scoped: LooseContext) => {
      const value = scoped?.get?.('apiProxy', true)
      if (!value) return
      collected.apiProxy = value
      if (!decided) {
        // 先不抢跑：等宽限期，让 services 有机会先到。这发也 unref——它只是"再看一眼"，
        // 进程若已无别的事可做就不该为它多活一个宽限期。
        oneShot.schedule(tryStart, config.carrierGraceMs)
      }
      tryStart()
    }) as never)
  } catch {
    /* 同上 */
  }
  tryStart()
  if (!runtime && config.mockBridge) {
    decided = true
    // mock 载体只为开发与冒烟存在：它的会话 id 一律 `ses_mock` 前缀，
    // 真链路测试里有专门一条断言"看到 ses_mock 就判失败"。
    import('./platform/mock-kernel.js')
      .then(({ createMockKernel }) => start(createMockKernel({ log, clock })))
      .catch(() => {})
  }
  if (!runtime) {
    status.write({ ...state(), carrier: 'none', reason: 'no-carrier', probe })
    log('no kernel carrier available', { hint: '需要 sessions/apiProxy 服务，或把 mockBridge 打开做开发' })
  }

  /**
   * 这次 `/drc pair` 是在哪条会话里敲的 → 那条会话的工作区目录。
   *
   * `agent` 是宿主交给 handler 的**接收 agent**（`@deepseek-ai/dsh-commands` 的
   * `handler: ({ agent, rawInput })`），会话 id 在 `agent.session.id`——与
   * `platform/carrier-services.ts` 读审批/提问事件里那个 agent 是同一个形状。
   * 拿不到 agent、会话、工作区**都不算失败**：那时二维码退回 `~/.dsh/`，卡片上印的就是
   * 退回去的那个路径。这里绝不能"猜一个应该在的工作区"——卡片路径与真落盘路径必须同一个。
   */
  const workspaceOfInvocation = (invocation: { agent?: unknown }): string | undefined => {
    const agent = invocation?.agent as { session?: { id?: unknown } } | undefined
    const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : ''
    if (sessionId === '') return undefined
    try {
      // runtime 还没起来（carrier=none）时 kernel 是 undefined：退回家目录那条路。
      return kernel?.sessionWorkspace?.(sessionId)
    } catch {
      return undefined
    }
  }

  // ── /drc 命令 ──────────────────────────────────────────────────────
  // 拿 commands 的方式和拿内核服务完全一样：`ctx.commands` 这种"直接点属性"的读法在
  // 真 cordis 上下文上是**抛错**的（属性名不在本 fiber 的 inject 集合里，见 reflect.ts
  // 的 get trap），所以先试 `ctx.get('commands', true)`，再用 `ctx.inject` 等晚到。
  //
  // **返回值只能是 `{kind:'success', text?}` 或 `{kind:'error', text}`。**
  // 宿主在注册边界上做校验（`@deepseek-ai/dsh-commands` 的 `normalizeResult`），
  // 别的 `kind` 一律 `throw TypeError("...unknown result kind...")`——用户看到的是
  // 一条命令整个失败，而不是"格式不标准"。旧实现把这条契约写在注释里，重写时漏掉了，
  // 于是 `/drc pair` 报 `unknown result kind "text"`。
  // 现在**两道锁**：类型上 `CommandResult` 让写错 kind 编译就红（`pnpm -r typecheck`），
  // 运行时有 `tests/command-result.test.ts` 走一遍 apply() 注册出来的真 handler。
  const commandDefinition = {
    name: 'drc',
    description: 'DSH 远程控制：发布配对二维码、查看中继与内核接合状态',
    input: { hint: 'pair | status | unpair' },
    handler: async (invocation: { commandId: string; rawInput: string; agent?: unknown }): Promise<CommandResult> => {
      const argument = String(invocation.rawInput ?? '')
        .trim()
        .toLowerCase()
      if (argument.startsWith('pair')) {
        const pairing = createPairing()
        if (!pairing) return { kind: 'success', text: PAIR_UNAVAILABLE_TEXT }
        // **默认走图片**：DSH 命令卡按 `line-height:1.6` 渲染等宽输出，行间留白会把半块
        // 二维码横切成条——实测 zxing 在 ≥1.15 行距就解不出来，而宿主固定 1.6，也就是
        // 文本码在这个（唯一）宿主上扫不出来。图片是自包含位图矩阵，跟行高/字体/配色无关。
        // 只有显式关掉 qrImage 时才渲染文本码当退路（另有可粘贴的 URI 兜底）。
        const workspaceDir = workspaceOfInvocation(invocation)
        const imageFile = config.qrImage ? pairingImagePath(config.statusFile, workspaceDir) : ''
        if (imageFile) writePairingImage(imageFile, pairing.qr, config, log)
        const terminal = config.qrImage
          ? undefined
          : await renderTerminalQr(pairing.qr, { style: config.qrStyle, ansi: config.qrAnsi })
        return {
          kind: 'success',
          text: pairingPairText({
            token: pairing.token,
            qr: pairing.qr,
            expiresAt: pairing.expiresAt,
            now: clock.now(),
            qrImage: config.qrImage,
            imageFile,
            terminalQr: terminal,
          }),
        }
      }
      if (argument.startsWith('unpair')) {
        for (const id of relay?.conversationIds() ?? []) relay?.voidConversation(id)
        return { kind: 'success', text: '已解除所有配对；手机端会显示"主机已断开，请重新配对"。' }
      }
      return { kind: 'success', text: JSON.stringify(state(), null, 2) }
    },
  }
  let commandsTaken = false
  const takeCommands = (source: unknown): void => {
    if (commandsTaken || !source || typeof source !== 'object') return
    const holder = source as { register?: (definition: unknown) => unknown }
    if (typeof holder.register !== 'function') return
    holder.register(commandDefinition)
    commandsTaken = true
    probe.commands = 'registered'
  }
  try {
    // 假的/非 cordis 上下文（单元测试）直接把 commands 挂在 ctx 上；真 cordis 上这一读
    // 会抛，所以整段包 try——它不是主路径，只是兼容测试与更老一代的宿主形状。
    takeCommands(ctx.commands)
  } catch {
    /* cordis 上下文上没有注入过的属性名读不得：走下面两条路 */
  }
  try {
    takeCommands(ctx.get?.('commands', true))
  } catch {
    /* 这一代宿主没这个服务 */
  }
  try {
    const child = ctx.inject?.(['commands'], ((...cbArgs: unknown[]) => {
      for (const candidate of [cbArgs[0], ...cbArgs, ctx]) {
        takeCommands(pickFrom(candidate, 'commands'))
        if (commandsTaken) break
      }
    }) as never)
    if (child !== undefined) injectChildren.push(['commands', child])
  } catch {
    /* 没有 commands 服务的代际：静默跳过，配对仍可由 pairOnStartSec 自动发布 */
  }

  return {
    config,
    state,
    createPairing,
    sessionWorkspace(sessionId: string): string | undefined {
      try {
        return kernel?.sessionWorkspace?.(sessionId)
      } catch {
        return undefined
      }
    },
    stop(): void {
      // 复查定时器要先撤：停机之后它们再去写 status.json，写的是已经过期的取证。
      oneShot.cancelAll()
      status.stop()
      runtime?.stop()
      relay?.stop()
      sleep.stop()
    },
  }
}

/**
 * 图片版是**默认路径**（`qrImage` 默认 true）。
 *
 * 为什么翻转：DSH 命令卡把等宽输出按 `line-height:1.6` 渲染，行间留白把半块二维码
 * 横切成条；用真机输出做的受控实验里，行距 1.0 时 zxing 解得出来、≥1.15 就扫不出来。
 * 文本码在这个宿主上不可用，所以主产物只能是图片。
 *
 * 落到磁盘的仍然是**旁路**：命令 API 只收纯文本，我们写 PNG + 把**路径**写进卡片，
 * 但绝不替用户打开查看器——`qrOpen` 默认关（原话「不要用打开一个图片的方式」）。
 *
 * `file` 由调用方按会话工作区解析好（`pairingImagePath`）后传进来，本函数只管写。
 */
function writePairingImage(
  file: string,
  qrText: string,
  config: PluginConfig,
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void,
): void {
  if (!config.qrImage || !file) return
  qrPng(qrText)
    .then((buffer) => {
      if (!writePrivateFile(file, buffer)) {
        log('qr png write failed', { file })
        return
      }
      if (!config.qrOpen) return
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
      const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file]
      execFile(opener, args, () => {
        /* 打不开就算了：卡片里仍有图片路径与可粘贴的 URI */
      })
    })
    .catch((error: unknown) => log('qr png render failed', { message: String((error as Error)?.message ?? error) }))
}

export { DEFAULT_CONFIG }
export { readConfig, validateConfig } from './shell/config.js'
export type { KernelPort, Clock } from './ports/index.js'
