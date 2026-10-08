/**
 * index — cordis bundle 入口（host 侧）。
 *
 * 职责边界（取证 docs/legacy-spec/host-plugin-cordis.md §1）：这个文件只做三件事
 * —— 读配置并校验、探测内核载体、把内核端口/中继客户端/运行时/防休眠接起来并持续写状态快照。
 * 配对入口只有状态栏那颗 pill（`pill/start.ts` 那四条路由）。业务逻辑都在 `core/`，
 * 平台知识都在 `platform/`。
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
import path from 'node:path'
import { type CmdPayload, type EvPayload, buildPairingUri } from 'dsh-remote-wire'
import { HostRuntime, type RuntimeTransport } from './core/runtime.js'
import { KeepAwake } from './core/sleep-policy.js'
import { PairingSlots } from './core/keys.js'
import { PairingWindow, tokenHandle } from './core/pairing-window.js'
import { buildLogRecord } from './shell/log-line.js'
import { isoOrUndefined } from './shell/iso.js'
import { decidePairFail } from './shell/pairing-fail.js'
import { RelayClient } from './transport/relay.js'
import { SystemSleepBackend } from './platform/sleep-posix.js'
import { createServicesKernel } from './platform/carrier-services.js'
import { createOneShotTimers, DEFAULT_SYSTEM_CLOCK } from './core/clock.js'
import { StatusFile, STATUS_REFRESH_MS } from './shell/status.js'
import { resolveHostId } from './shell/host-id.js'
import { PairStore } from './shell/pair-store.js'
import {
  DEFAULT_CONFIG,
  readConfig,
  redact,
  resolvePairStoreFile,
  resolveUploadDir,
  validateConfig,
  type PluginConfig,
} from './shell/config.js'
import { startPill, type PillHandle } from './pill/start.js'
import { guardedSubscribe } from './platform/guard.js'
import { type LivePairing, type PillStatus } from './pill/routes.js'
import { PLUGIN_VERSION } from './version.js'
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
}

export interface RuntimeHandle {
  readonly config: PluginConfig
  state(): Record<string, unknown>
  createPairing(): { qr: string; token: string; psk: string; expiresAt: number } | null
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
  // 图片附件的持久存储（2026-10-06 真机事故后接上）。
  // 带图发提示必须经 `attachments.admitPromptContent()` 或 `sessionController.commands.prompt`，
  // 否则内核序列化时读 `block.attachment.attachmentId` 会把整个回合打成
  // `Cannot read properties of undefined (reading 'attachmentId')`。
  'attachments',
]

/**
 * 同时保持的配对通道硬上界：超出就从最不活跃的开始剪（空闲 TTL 之外的第二道闸）。
 *
 * 配对策略是**只允许一台**（`onPeerJoined` 里新设备一来就作废旧的），所以正常情况下
 * 这里永远只有 0 或 1 条；留着这个上界是为了在"作废链路本身出问题"时不至于无界增长。
 */
const MAX_CONVERSATIONS = 64

/**
 * 被中继限速之后的**默认**退避时长。
 *
 * 中继可以在错误帧里给 `retryAfterMs`（协议 §12.2 E2），给了就用它的；
 * 没给时用这个值。量级对着中继那条 `DRC_PAIR_GLOBAL_PER_SEC = 20` 的固定 1 秒窗口：
 * 退避必须跨过至少一个完整窗口，否则它只是把拒绝往后推一点点，
 * 而在"被拒 → 自动补码 → 再被拒"的循环里，推一点点等于没退。
 */
const PAIR_RATE_LIMIT_BACKOFF_MS = 2_000

/** 取证：同一个进程里宿主调用了几次 `apply`（bundle 被重复挂载时能看到）。 */
const APPLY_COUNT = { n: 0 }

/** 默认时钟：真实定时器。测试注入假时钟（见 core/clock.ts）。 */
export const systemClock: Clock = DEFAULT_SYSTEM_CLOCK

export function apply(ctx: LooseContext, injected: Partial<PluginConfig> = {}, clock: Clock = systemClock): void {
  let handle: RuntimeHandle | undefined
  try {
    handle = applyInner(ctx, injected, clock)
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

function applyInner(ctx: LooseContext, injected: Partial<PluginConfig>, clock: Clock): RuntimeHandle | undefined {
  const config = readConfig(injected)
  // 载具探测的复查（8s/25s/60s）与载具宽限都是"宿主还活着就顺手看一眼"的一次性动作。
  // 它们必须 unref 且在停机时撤掉，否则 60s 那一发会把事件循环钉住——`node e2e/run.mjs`
  // 1.2s 跑完却 60s 才退出、任何 headless/CLI 跑法白等一分钟，都出自这里（见 core/clock.ts）。
  const oneShot = createOneShotTimers(clock)
  const status = new StatusFile(config.statusFile, clock)
  /**
   * 这一台主机的身份。配置给了就用配置的，否则读/写 status.json 旁边那个 `host-id` 文件
   * ——**不能每次加载现造**，那会让中继顶不了旧号、往换过身份的对端推帧（取证 §3.4 与
   * `shell/host-id.ts`）。`statusFile` 被清空（关掉快照）时不猜目录，退回一次性身份。
   */
  const hostId = resolveHostId(config.statusFile ? path.dirname(config.statusFile) : '', config.hostId)

  const log = (message: string, fields: Record<string, string | number | boolean | undefined> = {}): void => {
    try {
      process.stdout.write(`${JSON.stringify(buildLogRecord(message, fields, new Date().toISOString()))}\n`)
    } catch {
      /* GUI 宿主里 stdout 可能不可用 */
    }
  }

  /**
   * 配对通道的密钥簿落盘（免扫码重连，见 `shell/pair-store.ts`）。
   *
   * 在 `start()` 之前建好：主机重启后要在**第一帧 resync 之前**就把会话恢复进密钥簿，
   * 否则 resync 声明的是空列表，中继会把这些通道当成"主机已放弃"删掉，
   * 手机下次发帧就撞 `unknown_session` —— 症状与落盘没生效一模一样。
   */
  const pairStoreFile = resolvePairStoreFile(config, hostId)
  const pairStore = new PairStore({ file: pairStoreFile, hostId, log })
  const restoredAtBoot = pairStoreFile ? pairStore.load() : []
  const problems = validateConfig(config)
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
  /**
   * 状态栏那颗 pill 的四条路由（配对的唯一入口）。`undefined` = 还没起 / 起不动。
   * 它**不在主链路上**：没有 `webServer` 时它就是 undefined，配对、中继、命令一行都不受影响
   * ——这正是原来"拆成两个包"所提供的隔离，现在由 `startPill` 的软探测提供。
   */
  let pillRoutes: PillHandle | undefined
  /**
   * `start()` 内部登记的停机动作（现在只有"没有 status.json 时那只 housekeeping 节拍"）。
   *
   * 为什么不让 `start()` 自己管：它是个闭包，拿不到 `stop()`；而停机时漏清一个
   * 定时器 = 插件走了之后还在往一个已经不存在的会话簿上写盘。
   */
  const stopHooks: Array<() => void> = []
  // RelayClient 是唯一知道连接此刻怎么样的一方；状态快照读这两个值。
  let lastRelayState: 'online' | 'connecting' | 'offline' = 'connecting'
  let lastRelayProblem: string | undefined
  let lastRelayGeneration = 0
  /**
   * 限流退避到什么时候（与 `clock.now()` 同一时钟域）。
   *
   * 为什么要有它：见下面 `onPairFail` —— 自动补码撞上限速是一条会自我加速的循环，
   * 而"刚被限速"唯一的证据是 `error{code:'rate_limited'}` 那一帧
   * （配对路径上的 `reason` 已被中继折成 `invalid_or_expired`，认不出来）。
   * 连接重建时清零：配额按连接计，新 socket 是一份新配额。
   */
  let pairRateLimitedUntil = 0

  const transport: RuntimeTransport = {
    reply(conversationId: string, payload: EvPayload): boolean {
      return relay ? relay.send(conversationId, payload) : false
    },
    broadcast(payload: EvPayload): number {
      return relay ? relay.broadcast(payload) : 0
    },
    hasClient(conversationId: string): boolean {
      return relay?.hasClient(conversationId) ?? false
    },
    conversationIds(): string[] {
      return relay?.conversationIds() ?? []
    },
  }

  const start = (port: KernelPort): void => {
    if (runtime) return
    kernel = port
    startedCarrier = port.carrier
    relay = new RelayClient({
      url: config.serverUrl,
      hostId,
      label: config.hostLabel,
      token: config.hostToken,
      clock,
      log,
      lookupPairingSlot: (token) => slots.resolveFor(token),
      onPairReady: (token, ttlMs) => {
        // 服务端权威 TTL：不改写就会提前清掉 PSK，造成"配对成功但全解不开"。
        //
        // ⚠️ 这里**只能记 tokenHandle(token)**（码文本的 sha256 前 8 位）。原来记的是
        // `{ token }` —— 把 6 位配对码**原样**写进了 stdout，而同一个 stdout 上
        // `pill/routes.ts` 刻意只记 `tokenLength` + `epoch`、中继侧 D2 也为此把完整码
        // 降到 debug。§0.10.7 那条纪律在这一个调用点上没跟上：stdout 是会被翻出来贴进
        // issue 的那种地方，而这条路径**可达**——`slots.prune()` 在 3 秒节拍上会剔掉过期
        // 的槽，之后中继才把 pair-ready 送回来的那一张就正好"不认识"了。
        if (!slots.applyServerTtl(token, ttlMs)) log('pair-ready for an unknown token', { code: tokenHandle(token) })
        pairingWindow.applyServerTtl(token, ttlMs)
      },
      onPeerJoined: (conversationId, pairingToken) => {
        /**
         * **只允许一台**（2026-10-03 拍板）。中继在通知我们之前已经把这条新通道开好了
         * （`relay.ts` 的 peer-joined 先 `conversations.open` 再回调），所以这里要作废的是
         * **除它以外**的所有通道——新设备一进来，旧设备当场被踢下去。
         *
         * 走 `voidConversation` 而不是只删本地：只删本地的话，中继仍会把旧手机的密文转过来，
         * 而那台手机面对的是一个听不见的对端（R1 那个静默黑洞）。`session-leave` 发出去，
         * 旧手机端才会显示"主机已断开，请重新配对"。
         */
        for (const id of relay?.conversationIds() ?? []) {
          if (id !== conversationId) relay?.voidConversation(id)
        }
        runtime?.start()
        void runtime?.pushSessions('peer-joined')
        // 挂着的审批/提问在配对那一刻重发一遍（同一 requestId）：手机退后台、断线、
        // 停在列表页期间错过的那一帧，回来后靠这一遍补上；已结算的不在 pending 里，
        // 不会复活。重发永不抛（见 replayPending 第三条纪律），这里不包第二层 try。
        try {
          runtime?.replayPending(conversationId)
        } catch (error) {
          log('pending replay crashed peer-joined', { message: error instanceof Error ? error.message : String(error) })
        }
        // 一次性码用掉了就当场换一张新的（而不是等半程刷新）：第二部手机要的是一张新码，
        // 多轮真链路取证也靠这条才不用重启宿主。
        if (pairingToken) {
          pairingWindow.markConsumed(pairingToken)
          // status.json 里也不能再挂着这张已经用掉的码：外部脚本只看年龄，不看是否被消费。
          if (active.pairing?.token === pairingToken) active.pairing = null
          // 无论屏幕上是不是它，这张码都已经花掉——记账，之后任何一条发码路都不许再给出去。
          spendPairingToken(pairingToken)
        }
        log('client paired', { conversationId })
      },
      onClientLeft: () => {
        void runtime?.pushSessions('client-left')
      },
      onConversationGone: (conversationId) => log('conversation gone', { conversationId }),
      onCommand: (conversationId, cmd: CmdPayload) => void runtime?.handleCommand(cmd, conversationId).catch(() => {}),
      // 形状不对的载荷：**必须有人回一条**，否则手机那头是干等 12 秒的超时
      // 而真正的根因只在主机日志里（见 `runtime.handleInvalidCommand` 的头注）。
      onInvalidCommand: (conversationId, cmdId, payloadType) =>
        runtime?.handleInvalidCommand(conversationId, cmdId, payloadType),
      onState: (info) => {
        lastRelayState = info.relay
        lastRelayProblem = info.problem
        lastRelayGeneration = info.generation
        // 新连接 = 新配额：限流退避不该跨连接生效（旧窗口早就过去了，
        // 而留着它会让"重连之后配对码一直不自动补"看起来像另一个 bug）。
        if (info.relay !== 'online') return
        pairRateLimitedUntil = 0
        /**
         * **刚上线就 tick 一次**（2026-10-07 补）。
         *
         * 启动那处的 `pairingWindow.tick()` 注释写着「先 tick 一次，让
         * `pairOnStartSec>0` 的实例一起来就能看到 status.json 里有码」——
         * 而它是**恒为空操作**的：它紧跟在 `relay.connect()` 后面，那一刻
         * `emitState('connecting')` 刚把状态置成 connecting，于是 `tick()` 的
         * 第二行 `if (!this.deps.relayOnline()) return false` 必然早退。
         * 真正兜住的是 3 秒后的 housekeeping，所以症状是"配置了自动发码却要等
         * 3 秒才看到码"，而不是"没有码"。
         *
         * 为什么修在这里而不是删掉那句注释：`online` 只在 `hello-ok` 到达时出现，
         * 而那正是"发码闸门第一次打开"的时刻——那一刻不 tick，就要再等一个
         * 完整周期。（顺带：中继重启后主机重连也是同一个 `online`，
         * 那种情况下 pending-pair 表已空，同一次 tick 正好补上。）
         */
        pairingWindow.tick()
      },
      /**
       * 中继宣告"这张配对码没配上"。
       *
       * `reason` 只有四个取值（`invalid_or_expired` / `already_used` / `host_offline` /
       * `bad_token`），取自小程序那张中文映射表。处理：**清展示位 + 作废这张码 +
       * 立刻补一张**（同一时刻屏幕上必须有一张能用的）。
       *
       * ⚠️ 限速**不在 `reason` 里**：中继的配对限流是连接级配额，落到线上时被折成
       * `invalid_or_expired`（它自己的日志里仍记 `rate_limited`）。原来这里写的
       * `if (reason !== 'rate_limited')` 因此是一个**永远为真**的分支 —— 死代码，
       * 而它读起来像是"限速时我们会克制一下"。真正的信号来自 `onRelayError`：
       * 见到 `rate_limited` 就进入退避窗口，窗口内不自动补码。
       *
       * 为什么这件事要紧：自动补码撞上限速是一条会**自我加速**的循环
       *（被拒 → 补一张 → 再被拒 → 再补），而配对限流的全局配额是 20/s。
       * 于是"刚被限速"最可能的表现是主机自己把配额烧光，手机随后连普通帧都发不出去。
       */
      onPairFail: (reason, failedToken) => {
        /**
         * **只作废真正失败的那张**（2026-10-07）。
         *
         * 原来这里是"作废当前展示的那张"——而 `pair-fail` 帧原先不带 token，
         * 所以它只能拿 `active.pairing` 顶罪。多码并存时那会**作废错的那张**：
         * 屏幕上是码 B（完全有效），用户扫了一张早就过期的码 A → 中继回
         * `invalid_or_expired` → B 被记进 `spentTokens` 并 forget。
         *
         * 症状不是"多扫一次码"：B 的 PSK 被丢弃意味着那条配对通道作废，
         * 而这正是 `relay.ts` 文件头引用的那起「取错 PSK 全线解不开」的前置条件。
         *
         * 三种情形：
         * ① 中继给了 token 且它就是展示中的那张 → 作废它（与从前同一条路）；
         * ② 中继给了 token 但**不是**展示中的那张 → 那张是别人扫的旧码，
         *    **只把它记成已花**（免得窗口再补一张一样的），展示位**不动**；
         * ③ 中继没给（更老的一版）→ 退回"作废展示中的那张"，与从前一致。
         */
        //
        // 判定本身在 `shell/pairing-fail.ts`（纯函数、三种情形各有判据）：
        // 原来它内联在这儿，而这一层**测不到**——`RelayClient` 没有 socket
        // 注入点，所以"喂一帧 pair-fail 进 apply()"在当前装置下做不到，
        // 结果是这段"会不会误伤一张有效码"的逻辑一行判据都没有。
        const decision = decidePairFail(active.pairing?.token, failedToken)
        if (decision.victim) {
          spendPairingToken(decision.victim)
          pairingWindow.forget(decision.victim)
        }
        if (decision.clearShown) active.pairing = null
        log('relay rejected the pairing code', { reason })
        const waitMs = pairRateLimitedUntil - clock.now()
        if (waitMs > 0) {
          // 不补码，但**把原因记下来**：用户点「刷新」仍然随时可以（那是人的决定）。
          log('pairing republish deferred while rate limited', { waitMs })
          return
        }
        wrappedPublish()
      },
      /**
       * 中继的错误帧：主机第一次真的按 `code` 分支。
       * 目前只对限速有反应 —— 那是唯一一条"立刻重试只会更糟"的码。
       */
      onRelayError: (code, retryAfterMs) => {
        if (code !== 'rate_limited') return
        const wait = retryAfterMs ?? PAIR_RATE_LIMIT_BACKOFF_MS
        pairRateLimitedUntil = Math.max(pairRateLimitedUntil, clock.now() + wait)
        log('relay rate limited us', { waitMs: wait })
      },
      // 配对通道长存（D3）之后必须自己剪枝：中继那边的空闲 TTL 是 7 天，
      // 不剪就是无界的 PSK 簿 + 每次广播对废弃通道逐个密封。
      // 两条 TTL 分开：新配对的按 24 小时剪，从盘上恢复的按 `restoredIdleTtlSec`
      // （默认 7 天，与中继对齐）—— 理由见 config.ts 与 keys.ts 的 `Conversation.restored`。
      prunePolicy: {
        idleTtlMs: config.conversationIdleTtlSec * 1000,
        restoredIdleTtlMs: config.restoredIdleTtlSec * 1000,
        maxConversations: MAX_CONVERSATIONS,
      },
      // 结构性变化（新配对 / 作废）立刻落盘。只改了 seqHost 与 lastActivityAt 的场合
      // 由 status 的 3 秒 tick 批量落（见下面 `pairStore.markDirty()` 那一段）——
      // 挂在这里等于每广播一次写一次盘。
      onStructuralChange: () => {
        if (!pairStoreFile || !relay) return
        // **先标脏再写**：`save()` 失败（目录只读、磁盘满）时若不复位/不保持脏标记，
        // 新配对的 PSK 就静默不落盘，而且 3 秒 tick 看到 hasPendingChanges=false
        // 再也不会重试 —— 下一次重启用户面对的是"明明配过还要重新扫码"。
        pairStore.markDirty()
        pairStore.save(relay.conversations.snapshot(), clock.now())
      },
      onBookActivity: () => {
        // 只标脏：真正的写盘在 status 的 3 秒 tick 上批量做。
        pairStore.markDirty()
      },
    })
    runtime = new HostRuntime(port, transport, sleep, clock, {
      listingRefreshMs: config.listingRefreshSec * 1000,
      unarchiveOnPrompt: config.unarchiveOnPrompt,
      uploadDir: resolveUploadDir(config),
      maxFileBytes: config.maxFileBytes,
      approvalTimeoutMs: config.approvalTimeoutSec * 1000,
      log: (message, fields) => log(message, fields),
    })
    /**
     * **恢复必须发生在 `connect()` 之前**：`hello-ok` 一到就发 `resync`，
     * 而 resync 声明的列表就是密钥簿当前的内容。晚一步恢复，中继已经按空列表把
     * 这些通道删掉了 —— 表现是"落盘明明有数据，手机还是被要求重新扫码"。
     */
    const restoredIds = relay.restoreConversations(restoredAtBoot)
    if (restoredIds.length > 0) {
      /**
       * 有恢复出来的会话就**立刻启动 runtime**，不等 `onPeerJoined`。
       *
       * 原来 `runtime.start()` 只写在 `onPeerJoined` 里（下面那段），那假设了
       * "每一次有会话可用的时刻都必然伴随一次新配对"。落盘把这个假设打破了：
       * 主机重启后手机是**恢复**而不是重配，它不会发 `pair-begin-client`，
       * 于是 `onPeerJoined` 永远不来 —— 主机不订阅内核事件、不挂交互 sink、
       * 不起刷新节拍，手机却已经连上并显示"在线"。那与配对丢失在用户眼里完全一样，
       * 而且更难查（status.json 里 conversations=1、carrier 也正常）。
       */
      runtime.start()
      log('runtime started from restored conversations', { conversations: restoredIds.length })
    }
    relay.connect()
    // 自动发码走 pairingWindow，而不是启动时发一张就完事：
    // 一张码是一次性的，用完/中继重启/过半程都得换一张（判据见 core/pairing-window.ts）。
    // tick 挂在 status 的 3 秒节拍上（旧实现就是挂在这里）。
    //
    // ⚠️ 这里的 `tick()` 在启动这一轮里**必然空转**，而它原来那句注释说
    // 「先 tick 一次，让 pairOnStartSec>0 的实例一起来就能看到 status.json 里有码」——
    // 那是**一句假话**：上一行 `relay.connect()` 刚 `emitState('connecting')`，
    // 于是 `tick()` 第二行 `if (!this.deps.relayOnline()) return false` 早退。
    // 真正让"一起来就有码"成立的是 `onState` 里 `online` 分支上的那一次 tick
    // （闸门第一次打开的时刻）。这一行保留是为了让首轮状态一致，**不承担**发码。
    pairingWindow.tick()

    /**
     * 周期性 housekeeping：**剪枝 + 补码 + 批量落盘**。
     *
     * 抽出来是因为它**不属于**状态快照（2026-10-07 审计）。
     * 原来这三件事全都写在 `status.start()` 那个回调里，而 `StatusFile.start`
     * 在 `statusFile` 为空时直接 return —— 那个空值是一个**有文档的**开关
     * （HOST-SIDE §4「置空关闭状态快照」），于是关掉快照的用户同时关掉了：
     *
     * - **通道剪枝**（`pruneConversations` 是全仓唯一的 `pruneStale()` 调用方）
     *   → 密钥簿重新变回无界，`MAX_CONVERSATIONS` 与两条 TTL 全部失效：
     *   每天重新配对一次的用户两周就攒 200+ 把 PSK，每次广播逐条密封；
     * - **配对码自动换代**（`pairingWindow.tick`）→ `pairOnStartSec>0` 的实例
     *   永远只发启动那一张，用户扫完就再没有第二张（那句"要等下次刷新的二维码"）；
     * - **PSK 簿的批量落盘** → 只剩结构性变化与停机那两条写盘路。
     *
     * 一句话：**一个排错开关顺手关掉了三件与排错无关的事**，而它们全都没有任何提示。
     */
    const housekeeping = (): void => {
      pairingWindow.tick()
      relay?.pruneConversations()
      // `seqHost` 与 `lastActivityAt` 每次广播都变，挂在 `onStructuralChange` 上等于
      // 每 15 秒写一次盘；所以那些变动只标脏，这里按 3 秒节拍批量落一次。
      // 判据是 `hasPendingChanges`：**没脏就不写**，否则这条节拍
      // 会变成一个无条件写盘的心跳（而这个插件在 GUI 宿主里可能连开好几天）。
      if (pairStoreFile && pairStore.hasPendingChanges && relay) {
        pairStore.save(relay.conversations.snapshot(), clock.now())
      }
      // 配对码簿也要剪枝，理由与上面那句完全一样：一张码是一次性的，
      // 用掉/过期之后那行 slot 只是留在 Map 里，害得 `status.json` 的
      // `pendingPairs` 只增不减（实测能涨到 5 以上），而那个数字是排障时
      // 判断「中继那边攒了多少待配对条目」的唯一依据 —— 涨着就说明不了任何事。
      // `prune()` 早就写好了，只是**一直没有调用方**（`grep -rn 'prune()'` 只命中定义）。
      slots.prune()
    }
    status.start(() => {
      housekeeping()
      return state()
    })
    /**
     * **快照关掉时自己起一节拍**（同上那条纪律的另一半）。
     *
     * 刻意不塞进 `StatusFile`：那一类只管"把状态写到盘上"，让它顺带驱动剪枝与补码，
     * 就等于让"写不写排错文件"决定了"密钥簿剪不剪"。这里另起一只，
     * `stop()` 里与 `status.stop()` 一起收。
     */
    let housekeepingTimer: unknown
    if (!config.statusFile) {
      const tickHousekeeping = (): void => {
        // 先续期再干活：housekeeping 里任何一处抛出都不该让这条节拍断掉
        // （断了就等于回到"再也不会剪枝"的那个状态，而且没有任何日志）。
        housekeepingTimer = clock.setTimeout(tickHousekeeping, STATUS_REFRESH_MS)
        try {
          housekeeping()
        } catch (error) {
          log('housekeeping tick failed', { message: String((error as Error)?.message ?? error).slice(0, 160) })
        }
      }
      housekeepingTimer = clock.setTimeout(tickHousekeeping, STATUS_REFRESH_MS)
    }
    stopHooks.push(() => {
      if (housekeepingTimer !== undefined) clock.clearTimeout(housekeepingTimer)
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
      log('pairing published to a socket that is not open', { code: tokenHandle(slot.token) })
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
      // 主机身份。中继日志里认的就是它，所以"手机连不上/丢帧涨"第一件事是看这个值
      // 在两次重启之间有没有变（变了就是身份没稳住，见 shell/host-id.ts）。
      hostId,
      relay: relay ? relayState() : 'idle',
      relayProblem: relayProblem(),
      conversations: relay?.conversationCount ?? 0,
      /**
       * 当前连着的手机台数（去重的 clientId）。
       *
       * 为什么必须与 `conversations` 分开报：「解除配对 → 重新配对」会开一条**新会话**，
       * 而手机还是那一台。所以拿会话数回答"几台手机连着"，用户解完配对看到数字反而变大 ——
       * 那个现象与"我的解配没生效"完全一致，最容易让人把解配按钮当坏的。
       * `pendingPairs` 是另一个东西：那是**还挂着、还没被用掉的配对码**。
       */
      pairedClients: relay?.clientCount ?? 0,
      pendingPairs: slots.size,
      /**
       * 密钥簿落盘的排障面。
       *
       * `restored` 是"本次启动从盘上恢复了几条会话"——它与 `conversations` 的差值
       * 就是"落盘没生效"的判据：`conversations > 0 && restored === 0 && pairStore.enabled`
       * 意味着这些会话是本次运行新配出来的（正常），反过来
       * `restored > 0` 而 `conversations === 0` 才是异常。
       *
       * **`lastSavedAt` 与路径都不含 PSK**：这份快照会被外部脚本读，
       * 文件路径本身也不是凭据（里面的内容才是）。
       */
      pairStore: {
        enabled: pairStoreFile !== '',
        file: pairStoreFile || undefined,
        restored: restoredAtBoot.length,
        lastSavedAt: pairStoreFile && pairStore.lastSavedAt > 0 ? isoOrUndefined(pairStore.lastSavedAt) : undefined,
      },
      pairing: describeActivePairing(),
      keepAwake: snapshot,
      kernel: kernel?.describe() ?? null,
      // 出站计数：手机上"没收到 X"的第一现场对比点（插件没发 vs 发了但路上丢了）。
      outbound: runtime?.stats ?? null,
      probe,
      // 配对入口（那颗 pill 的四条路由）为什么没起，是"配不了对"唯一的排查入口：
      // 这里直接把软探测的结果带出来。
      pill: pillRoutes?.probe ?? { webServer: 'not-started' },
      // token 永远不出现真值；这条有测试锁住。
      hostToken: undefined,
      hostTokenShape: config.hostToken ? redact(config.hostToken) : undefined,
      mockBridgeForced: config.mockBridge,
      problems: [
        ...problems.map((problem) => `${problem.level}:${problem.field}`),
        // **每次快照现判，不在 apply 里 push 一次**。`webServer` 可能是 `ctx.inject` 的回调
        // 晚到才拿到的，apply 返回那一刻 `available` 还是 false——留在 apply 里就会写出
        // `routes:"registered"` 与 `problems:["warn:pill"]` 并存的假警报
        // （2026-10-03 真机重启后实测抓到）。为什么没挂上从同一个快照的 `pill` 探针读。
        ...(pillRoutes?.available ? [] : ['warn:pill']),
      ],
      ...(config.pairOnStartSec > 0 ? { pairOnStartWarn: 'status.json 里带着仍然有效的配对码与 PSK' } : {}),
    }
  }

  const active = { pairing: null as { qr: string; token: string; expiresAt: number } | null }
  /**
   * **已经花掉、不许再发给任何人的配对码**。
   *
   * 为什么需要这一本账：配对码是一次性的（中继 `claim()` 里 `pending.used = true`，
   * 重放拿到 `already_used`）。而 `active.pairing`——也就是 status.json 里那张、
   * 状态栏二维码那张、`/pairing/new` 发的那张——原来只由 `markConsumed` 与 `wrappedPublish`
   * 两个地方维护，于是只要没有新码顶上，屏幕上就一直挂着那张**已经花掉**的码：
   *
   * - 手机扫码 → 中继回 `already_used` → "新二维码连不上"；
   * - 而 `pairOnStartSec` 默认是 **0**（自动发码关着），所以没有任何东西会去换一张，
   *   只能干等这张码的 TTL 走完（线上中继 180 s）——用户说的"要等下次刷新的二维码才能用"。
   *
   * 判据把这三条路全钉住：消费一张、退出配对一次，`active.pairing` 都不许再是花掉的那张。
   */
  const spentTokens = new Set<string>()
  /** 这本账只用来挡住"再把花掉的码发出去"，不需要长记忆：64 条足够跨过一次批量重配。 */
  const SPENT_MAX = 64
  function spendPairingToken(token: string): void {
    if (!token) return
    spentTokens.add(token)
    while (spentTokens.size > SPENT_MAX) {
      const oldest = spentTokens.values().next().value
      if (oldest === undefined) break
      spentTokens.delete(oldest)
    }
  }
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
    // 花掉的码不许再进 status.json：外部脚本照着它拼二维码，扫了必然失败。
    if (spentTokens.has(shown.token)) return null
    return {
      token: slot.token,
      psk: slot.psk,
      // 越界时给 undefined 而不是抛：`slot.expiresAt` 来自中继给的 ttlMs，
      // 而这一行在**构造 status 快照**的路径上（见 shell/iso.ts 的文件头）。
      expiresAt: isoOrUndefined(slot.expiresAt),
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
      // 新码天生没花过：从账上摘掉（同一张 token 被重发的极端情形下也安全）。
      spentTokens.delete(created.token)
      // 手工发的那张也要让窗口认领，否则窗口以为"没有活动码"又发一张。
      pairingWindow.adopt({ token: created.token, createdAt: clock.now(), expiresAt: created.expiresAt })
    }
    return created
  }

  const createPairing = (): ReturnType<typeof wrappedPublish> => wrappedPublish()

  /**
   * 当前**仍然有效**的那张码，只读——不发新的。
   *
   * 用 `active.pairing` 而不是 `describeActivePairing()`：后者带着 `psk`，而它的返回值会被
   * 状态栏那条图片路由间接消费；这里要的只是"屏幕上现在该显示哪张"。
   * `slots.resolveFor` 顺手把已过期的剔掉，所以 `pairing.png` 在没有效码时拿到 null → 204。
   */
  function currentPairing(): LivePairing | null {
    const shown = active.pairing
    if (!shown) return null
    const slot = slots.resolveFor(shown.token)
    if (!slot) return null
    // 花掉的码一律当"没有码"：调用方（`ensureFreshPairing` 与 `pairing.png`）会去补一张新的，
    // 而不是把一张扫了必然 `already_used` 的码递给用户。
    if (spentTokens.has(shown.token)) return null
    // 过期时刻以 **slot** 为准，不是 active 里那份出码时的旧值：中继的 pair-ready 会用
    // 服务端权威 TTL 改写 slot.expiresAt（线上中继发的是 180s，本地默认 120s），
    // 而 active 没人更新。用旧值算 expiresInMs，本地过期之后 slot 还有效的那一整段里，
    // 发码路由每次都回 expiresInMs=0，pill 上就是"发码回答里的码不完整"，
    // 而且按一次撞一次（2026-10-04 用户实测：断开重连后点刷新必现）。
    return { qr: shown.qr, token: shown.token, expiresAt: slot.expiresAt }
  }

  /**
   * 幂等版发码：已经有一张能用的就给那张，没有才向中继申请新的。
   *
   * 为什么必须幂等：状态栏那颗 pill 是可以连点的，而每点一次发一张的话，
   * 中继的 pending 表里会同时挂着三个 PSK，屏幕上显示的却是其中一张——
   * 手机扫到没被显示的那张就全线解不开。那正是当初"多码事故"的形状。
   */
  function ensureFreshPairing(): LivePairing | null {
    /**
     * **"屏幕上那张还能不能用"要问窗口，不能只问本地 TTL**（2026-10-06）。
     *
     * 中继重启后它内存里的 pending-pair 表已经空了：屏幕上那张码在中继那边**已经死了**，
     * 而本地 `expiresAt` 还没到。旧实现把它直接当 fresh 返回 —— 用户点"刷新"拿到的
     * 还是同一张死码，只能干等 TTL 走完（用户报的"要等下次刷新的二维码才能用"里，
     * 最坏的一档就是这个）。`staleNow()` 复用窗口那套判据（代次变了 / 过期 / 过半程），
     * 与自动换码同一口径，两处不会分叉。
     */
    const shown = currentPairing()
    const fresh = shown && !pairingWindow.staleNow() ? shown : createPairing()
    if (!fresh) return null
    // 兜底一道：resolveFor 用 clock.now()，而路由算 expiresInMs 用 Date.now()，
    // 两个时钟之间有窗口；服务端 TTL 改写也让"还有效"这件事有两个口径。
    // 到点的码不当 fresh——现补一张（中继不在就回 null，路由那边会说 unavailable），
    // 而不是回一个 expiresInMs=0 的"完整码"让 pill 显示"码不完整"。
    if (fresh.expiresAt <= Date.now()) return createPairing()
    // **在这里就把 psk 摘掉**，而不是靠"下游记得只读那三个字段"：这条返回值会被浏览器
    // 可达的那条发码路由间接消费，红线（PSK 从不上网）要靠形状成立，不靠调用方自律。
    return { qr: fresh.qr, token: fresh.token, expiresAt: fresh.expiresAt }
  }

  /**
   * pill 抬头那句"连接状态"与点开那三行（中继 / 状态 / 版本）：中继那一行取值口径与
   * `status.json` 完全一致（同一个 `relayState()`），免得两处说两种话。
   * 这里出去的四个字段都不是凭据——6 位码、PSK、配对 URI 一个都不带。
   *
   * ⚠️ `paired` 读的是 **clientCount（手机台数）而不是 conversationCount（会话数）**，
   * 这不是随手选的：会话按 D3 长存，手机解配也不删（手机回前台要用同一个 convId 回来），
   * 于是解配之后 `conversationCount` **恒为 1**，pill 会一直显示"已配对"——
   * 用户点了手机上的「解除配对」、主机这边毫无变化，正是这个字段顶错了。
   * 主机侧的 `peer-left` 已经把 clientId 从成员表摘掉（`relay.ts`），所以这里读
   * `clientCount` 才是"现在真有手机连着吗"。
   *
   * 为什么 `clientCount` 在配对瞬间不会是 0（那会误报"未配对"）：配对成功的
   * 那一刻成员表确实是空的，手机 clientId 要等它**下一帧**才带上来 ——
   * 所以它只能靠 `onEncrypted` 登记，不能只在 `open()` 记（见 relay.ts）。
   * 好在 mp 侧 `_onPaired` 里立刻发了一帧 `cmd.list_sessions`，
   * 那帧到达时成员表就补齐了，pill 最多差一个轮询周期（3 秒）不会一直空着。
   */
  function pillStatus(): PillStatus {
    // runtime 还没起来（没有对端时它根本不 start）时按"没有事在等"说，
    // 而不是让那颗 pill 因为读不到字段而退回 `已配对`。
    const waiting = runtime?.waiting ?? { count: 0, oldestSec: 0 }
    return {
      relay: relay ? relayState() : 'idle',
      paired: relay?.clientCount ?? 0,
      // 配对簿里几条会话 = 配对还在不在。为什么必须与 paired 分开：pair-store 之后
      // 配对按 D3 长存、落盘，手机退后台只是 socket 断——只用 clientCount 回答 配没配上，
      // 用户把小程序放进后台的每一分钟，桌面那颗 pill 都会说 未配对，点开还会烧一张
      // 不需要的新码（2026-10-04 用户报的误解）。
      pairings: relay?.conversationCount ?? 0,
      serverUrl: config.serverUrl,
      version: PLUGIN_VERSION,
      waiting: waiting.count,
      waitingOldestSec: waiting.oldestSec,
    }
  }

  /**
   * 退出配对（弹窗右上角那颗按钮走的就是这里）：作废当前所有配对通道，返回条数。
   *
   * 幂等——本来没配上时返回 0，面板把 0 当成功（轮询与点击之间状态可能已经变了，
   * 把这种正常竞态报成失败只会让面板显示一句看不懂的红字）。
   * 与每条通道走 `voidConversation`，中继那边才会收到 `session-leave`、
   * 手机端才会显示"主机已断开，请重新配对"。
   *
   * **作废的同时必须换一张码**（2026-10-05 用户实测：退出配对后屏幕上那张二维码扫了没用，
   * 要等它 TTL 走完才恢复）。原来只作废通道、不管码：`active.pairing` 还挂着刚走的那部手机
   * 花掉的那一张，而 `pairOnStartSec` 默认 0（自动发码关着）于是没有任何东西去换它 ——
   * 状态栏那张图、`/pairing/new` 发的那张，全都是 `already_used`。
   *
   * 两步都是必须的：把旧码记进花名账（这样即使补发失败也不会再把死码递出去），
   * 再立刻补一张（这样状态栏上不是空白，用户点开就有能扫的）。
   */
  function unpairAll(): number {
    const ids = relay?.conversationIds() ?? []
    for (const id of ids) relay?.voidConversation(id)
    if (active.pairing) spendPairingToken(active.pairing.token)
    active.pairing = null
    wrappedPublish()
    return ids.length
  }

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
    // 未自动发码时那张"用户点出来的码"按配置的 pairTtlMs 老化（与发码时请求的 TTL 同源）。
    config.pairTtlMs,
  )

  // ── 载体探测：services > (mock) ────────────────────────────────────
  const collected: Record<string, unknown> = {}
  const hasServices = (): boolean => typeof collected.sessions === 'object' && collected.sessions !== null

  // wanted 是**布尔表**，不是字符串 —— 它回答"装没装"，值天然是 true/false。
  const probe: Record<string, string | Record<string, boolean>> = {}
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
      // newSessionCwd 透传：新建会话用哪个项目目录（见 carrier-services 的 newSession——
      // 不给的话宿主用 process.cwd() 兜底，真机上是 /，会话就不在任何用户项目里）。
      start(
        createServicesKernel(collected as never, {
          log,
          clock,
          newSessionCwd: config.newSessionCwd,
          // `awaiting-permission` / `awaiting-answer` 这两个会话状态只有 runtime 知道
          //（内核只答得出"在不在跑"），而小程序列表与「等你处理」区只认这两个字符串——
          // 不接上它们，真机上那个区永远是空的（判据见 carrier 的 pendingKindForSession
          // 注释）。collect 早于 start，所以这里传的是一个**惰性查询**而不是值。
          pendingKindForSession: (sessionId) => runtime?.pendingKindForSession(sessionId),
        }),
      )
      return
    }
    // 没有 services 载体就不启动，也不退回 apiProxy/typert：桌面态从未注册 apiProxy 服务，
    // 而它的调用信封在旧实现里整个是错的、无法验证；typert 只有 invoke()，既不能列会话
    // 也不能发指令，接上去只是一台"永远空列表"的机器。这两条**探都不探**：真要用再写，
    // 留着只是让"下一版会不会接上"变成读代码的人去猜。
    // （取证 docs/legacy-spec/host-plugin-cordis.md §2.4 表与 §3 表第 14-19 行）
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
   * 把某个上下文（根 ctx 或 `ctx.inject` 回调给的作用域上下文）的 `on`/`off` 绑到
   * 服务对象上——carrier 的 `subscribe()` 与交互面登记都读 `services.on`。
   *
   * **为什么必须单独一条，而不是塞在 `accept()` 里**（2026-10-06 真机取证）：
   * `tryStart()` 在 `ctx.get('sessions', true)` **同步可得**时会在任何 inject 回调
   * **之前**就把内核启起来，而 `collected.on` 那时还只在 `accept('sessions', …)`
   * 里绑——晚一步的后果是 `subscribe()` 读到 `services.on === undefined`，
   * 记一句 `kernel has no on(); streaming disabled` 并永久返回空退订；
   * `HostRuntime.start()` 有 started 闸门不会重试，于是**该进程内流式全黑**，
   * 而 `describe()` 的 `hasOn` 每次现读（那时 on 早绑上了）会显示 true 掩盖真相。
   * 现在：拿到任意服务、任意候选上下文时先绑一次，晚到的 inject 回调再补一次。
   *
   * 两处读取**各自包 try**：cordis 的 ctx 是 Proxy，读一个它这个作用域里没有的属性名
   * 是**抛错**而不是返回 undefined（真机：`cannot get property "off" without inject`,
   * 就是本文件 110-119 行那条结论）。`typeof`/`?.` 都挡不住 get trap，
   * 所以只能用 try——而且 off 单独一段，它抛不能把 on 的绑定一起带走。
   */
  const bindScopedEvents = (source: unknown): void => {
    if (!source || typeof source !== 'object') return
    const asContext = source as LooseContext
    /**
     * 只认"看起来像上下文"的候选（有 `get`）。回调参数里除了作用域上下文还有别的东西
     * （配置对象等），而某个**服务对象**自己也带一个同名 `on` 时，绑错了就是
     * "订阅装到了没有事件派发能力的对象上"——比没绑更难查。
     * 判别方式与 `pill/start.ts` 的 `pickFrom` 完全一致。
     */
    try {
      if (typeof asContext.get !== 'function') return
    } catch {
      return
    }
    if (typeof collected.on !== 'function') {
      try {
        if (typeof asContext.on === 'function') collected.on = asContext.on.bind(asContext)
      } catch {
        /* 这个作用域读不到 on（或它抛了）：换下一个候选 */
      }
    }
    if (typeof collected.off !== 'function') {
      try {
        if (typeof asContext.off === 'function') collected.off = asContext.off.bind(asContext)
      } catch {
        /* 同上：真机上 off 比 on 更常见地"没注入" */
      }
    }
  }
  // 根上下文先绑一次：`ctx.get` 那条同步路径拿到的服务也要能订阅（见上面那段取证）。
  bindScopedEvents(ctx)

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
    bindScopedEvents(source)
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
            // **先绑事件口再取服务**：`on` 只在这个作用域上下文上才读得到（根 ctx 上不一定有），
            // 而 `accept()` 里的 `tryStart()` 可能就在这一句之后把 runtime 启起来 ——
            // 绑晚了 subscribe() 拿到的就是 undefined（该进程内流式全黑，见 bindScopedEvents）。
            bindScopedEvents(candidate)
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
  /**
   * 一次性取证：这一代宿主到底给了 ctx 什么。猜"名字对不对"之前先看形状。
   *
   * **逐句包 try**：`Object.keys(ctx)` / `getPrototypeOf(ctx)` / `ctx.effect` / `ctx.fiber`
   * 在这台宿主上都是 Proxy 的 trap（ownKeys / getPrototypeOf / get），
   * 读不到不是返回 undefined 而是**抛错**（本文件 110-119 行那条结论；
   * `cannot get property "off" without inject` 就是同一个洞里出来的）。
   * 取证段自己抛出去的代价是整段 applyInner 中断——那正是最贵的那种故障。
   */
  try {
    probe.ctxKeys = Object.keys(ctx).slice(0, 40).join('|')
  } catch (error) {
    probe.ctxKeys = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }
  try {
    probe.ctxProtoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx) ?? {})
      .slice(0, 40)
      .join('|')
  } catch (error) {
    probe.ctxProtoKeys = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }
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
  try {
    probe.hasEffect = String(typeof (ctx as { effect?: unknown }).effect === 'function')
  } catch (error) {
    probe.hasEffect = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }
  try {
    probe.hasFiber = String(
      typeof (ctx as { fiber?: unknown }).fiber === 'function' || (ctx as { fiber?: unknown }).fiber !== undefined,
    )
  } catch (error) {
    probe.hasFiber = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }

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
    // **必须走 guard 的订阅口**（guard.ts 头注称自己是"事件订阅的唯一入口"）：
    // 这里直接 `ctx.on(...)` 是绕过白名单的旁路 —— 今天这条是 emit-mode 所以没事，
    // 但明天有人把名字改成一条 waterfall，就只有这行代码不在护栏里。
    const on = (ctx as { on?: (name: string, listener: (...args: unknown[]) => void) => unknown }).on
    if (typeof on === 'function') {
      guardedSubscribe(
        on.bind(ctx) as never,
        'internal/status',
        ((fiber: unknown, oldState: unknown) => {
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
        }) as never,
        (message, fields) => log(message, fields),
      )
    } else {
      probe.statusWatch = 'no on() on the root ctx'
    }
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
  /**
   * `probe.wanted` 逐个点名回答的包（2026-10-06 宿主能力普查后定的）。
   *
   * 为什么点名而不倒全表：loader 有 50+ 条，status.json 会截断，
   * 倒全表的那一半**看起来就像没加载**，而那正是最容易得出错结论的用法。
   * 这里问的是"在不在"，答案短、不截断、且可复算。
   */
  const PROBE_PACKAGES = [
    'dsh-token-meter',
    'dsh-session-projection',
    'dsh-compaction-basic',
    'dsh-command-compact',
    'dsh-api-workspace-files',
    'dsh-client-file-upload',
    'dsh-experimental-api-speech-to-text',
    'dsh-llm-retry',
    'dsh-tool-todo',
  ] as const

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
      // `loaderRows` 会被 status.json 的长度截断，所以**不能**拿它回答
      // "某个包到底加载了没有"——截断点之后的看起来就像没加载，而那正是
      // 最容易得出错误结论的用法（2026-10-06差点据此断言 token-meter 没挂）。
      // 要回答"装没装"用下面的 wanted：逐个点名，短、确定、不受截断影响。
      const all = rows.join(',')
      probe.wanted = Object.fromEntries(PROBE_PACKAGES.map((name) => [name, all.includes('@deepseek-ai/' + name)]))
      probe.loaderRows = all.slice(0, 2600)
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
    log('no kernel carrier available', { hint: '需要 sessions 服务，或把 mockBridge 打开做开发' })
  }

  // ── 配对入口：状态栏那颗 pill 的四条路由 ────────────────────────────
  //
  // **配对唯一入口就是这四条路由**（`/drc` 命令 2026-10-03 整个删掉了）。
  // 主链路先成立：这一半起不来时，上面接好的那些一行都不许被回滚。
  //
  // 整段再包一层 try 不是冗余：`startPill` 内部已经层层兜住，但"层层兜住"是设计不是证明。
  // 它一旦抛出，宿主会把我们这条 fiber 标 FAILED 并 dispose 掉那几个 inject 子 fiber——
  // 那就等于用一个界面功能砸了配对链路（真机取证见 `apply()` 里那条纪律）。
  try {
    pillRoutes = startPill(ctx, {
      enabled: config.pill.enabled,
      // 四条路由要的四件事：幂等发码、只读看当前码、读连接状态、退出配对。
      ensureFresh: () => ensureFreshPairing(),
      current: () => currentPairing(),
      status: () => pillStatus(),
      unpair: () => unpairAll(),
      log,
    })
  } catch (error) {
    pillRoutes = undefined
    log('pill start threw（配对链路不受影响）', {
      message: String((error as Error)?.message ?? error).slice(0, 200),
    })
  }
  // **配对入口没了必须说得出为什么**：`/drc` 命令与终端文本码都在 2026-10-03 删掉了，
  // "这台主机配不了对"如果没有一条可查的记录，表现就是静默失败。那条 `warn:pill` 由
  // `state()` 每次快照现判（理由见那里），原因本身落在同一个快照的 `pill` 探针里——
  // 通常就在软探测那一步（宿主没 `webServer`，或者路由名被占）。

  return {
    config,
    state,
    createPairing,
    stop(): void {
      // 复查定时器要先撤：停机之后它们再去写 status.json，写的是已经过期的取证。
      oneShot.cancelAll()
      // pill 那四条路由也要一起收：它是不在主链路上的旁路，所以单独一句。
      pillRoutes?.stop()
      status.stop()
      for (const hook of stopHooks) {
        try {
          hook()
        } catch {
          /* 停机动作不许拖住停机 */
        }
      }
      // **停机时补一次落盘**：正常关机是唯一能保证"3 秒 tick 之前那几秒的改动也写下去"的时机。
      // 只在有脏数据时写（`save` 内部也会因空文件路径直接返回）。
      if (pairStoreFile && relay && pairStore.hasPendingChanges) {
        pairStore.save(relay.conversations.snapshot(), clock.now())
      }
      runtime?.stop()
      relay?.stop()
      sleep.stop()
    },
  }
}

export { DEFAULT_CONFIG }
export { readConfig, validateConfig } from './shell/config.js'
export type { KernelPort, Clock } from './ports/index.js'
