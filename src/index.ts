/**
 * index — cordis bundle 入口（host 侧）。
 *
 * 职责边界（取证 docs/legacy-spec/host-plugin-cordis.md §1）：这个文件只做三件事
 * —— 读配置并校验、探测内核载体、把内核端口/中继客户端/运行时/防休眠接起来并持续写状态快照。
 * 配对入口只有状态栏那颗 pill（`pill/start.ts` 挂的那七条路由：六条配对 + 一条配置读写）。业务逻辑都在 `core/`，
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
import { type CmdPayload, type EvPayload, type NotifyItem } from '@dsh-remote/protocol'
import { HostRuntime, type RuntimeTransport } from './core/runtime.js'
import { KeepAwake } from './core/sleep-policy.js'
import { PairingSlots } from './core/keys.js'
import { createPairApproval } from './shell/pair-approval.js'
import { createMpCodeFetcher } from './shell/mp-code.js'
import { PairingWindow, tokenHandle } from './core/pairing-window.js'
import { createPairIssuance } from './core/pair-issuance.js'
import { buildLogRecord } from './shell/log-line.js'
import { isoOrUndefined } from './shell/iso.js'
import { createPairFlow } from './core/pair-flow.js'
import { createHousekeeping } from './core/housekeeping.js'
import { createCarrierProbe } from './core/carrier-probe.js'
import { SERVICE_NAMES, type HostContext as LooseContext } from './core/host-context.js'
import { RelayClient } from './transport/relay.js'
import { SystemSleepBackend } from './platform/sleep-posix.js'
import { createServicesKernel } from './platform/carrier-services.js'
import { createOneShotTimers, DEFAULT_SYSTEM_CLOCK } from './core/clock.js'
import { StatusFile, STATUS_REFRESH_MS } from './shell/status.js'
import { resolveHostId } from './shell/host-id.js'
import { PairStore } from './shell/pair-store.js'
import { describeSelfHosting } from './shell/self-hosting.js'
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
import type { ConfigSource, EffectivePluginConfig } from './pill/config-routes.js'
import { claimHostToken, readStoredHostToken, resolveHostTokenFile, writeStoredHostToken } from './shell/claim-token.js'
import { readUserConfig, resolveUserConfigFile, writeUserConfig, type UserOverrides } from './shell/user-config.js'
import { guardedSubscribe } from './platform/guard.js'
import { type LivePairing, type PillStatus } from './pill/routes.js'
import { PLUGIN_VERSION } from './version.js'
import type { KernelPort, Clock } from './ports/index.js'

/** 我们只用到 ctx 的几个成员，所以不硬依赖 @deepseek-ai/cordis 的类型。 */
export interface RuntimeHandle {
  readonly config: PluginConfig
  state(): Record<string, unknown>
  createPairing(): { token: string; psk: string; expiresAt: number } | null
  stop(): void
}

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
      createPairing: (): { token: string; psk: string; expiresAt: number } | null => handle?.createPairing() ?? null,
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
  const log = (message: string, fields: Record<string, string | number | boolean | undefined> = {}): void => {
    try {
      process.stdout.write(`${JSON.stringify(buildLogRecord(message, fields, new Date().toISOString()))}\n`)
    } catch {
      /* GUI 宿主里 stdout 可能不可用 */
    }
  }

  /**
   * **四级配置**：`默认值 < 设置页写下的自定义项 < patch 注入 < 环境变量`
   * （2026-10-11 加第三级；前两级与旧实现一致）。
   *
   * 为什么合成**两趟**：自定义项落在 `statusFile` 旁边（`user-config.json`），
   * 而 `statusFile` 本身是第一趟才读出来的。两趟都是纯函数调用（各读一次盘），
   * 代价可以忽略，换来的是"秘钥路径不靠猜"。
   *
   * ⚠️ 两趟之间**只有** `statusFile` 这一个用途；自定义项本身不含 `statusFile`
   * （设置页那一栏只有"自部署地址 / token"两项）。
   */
  const baseConfig = readConfig(injected, process.env)
  const userConfigFile = resolveUserConfigFile(baseConfig.statusFile)
  let userOverrides = readUserConfig(userConfigFile, log)
  const config = readConfig(injected, process.env, userOverrides)
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

  /**
   * ── host token：谁给的 / 盘上认领来的 / 现在去认领（2026-10-11）──────────────
   *
   * 目标形态是「插件装完就能用」：装完**什么都不用配**。所以这里的顺序是
   * ① env / patch / 设置页（`readConfig` 已经合成进 `config.hostToken`）；
   * ② 盘上那枚**认领来的** token（`host-token.json`，只在 `serverUrl` 与当前一致时才算数）；
   * ③ 都没有 ⇒ 向中继认领一枚（异步，**不阻断启动**）。
   *
   * ⚠️ 认领来的那一枚**不写回 `config.hostToken`**：那个字段的语义是"配置层合成出来的值"
   * （`state()` 与设置页都靠它区分"用户配的"与"机器自己去要的"）。生效值走
   * {@link effectiveTokenState}，两处都从那里读。
   */
  const hostTokenFile = resolveHostTokenFile(config.statusFile)
  const envToken = (config.hostTokenEnv ? (process.env[config.hostTokenEnv] ?? '') : '').trim()
  const patchToken = typeof injected?.hostToken === 'string' ? injected.hostToken.trim() : ''
  const envUrl = (process.env.DRC_SERVER_URL ?? '').trim()
  const patchUrl = typeof injected?.serverUrl === 'string' ? injected.serverUrl.trim() : ''
  /** 盘上认领来的那一枚（空 = 没有）与**它是向哪台中继领的**。 */
  let claimedToken = ''
  let claimedForUrl = ''
  /** `pending` = 认领请求还没落地，此刻**不许**打开启动闸门（RelayClient 是在构造时读 token 的）。 */
  let claimState: 'not-needed' | 'pending' | 'ok' | 'failed' = 'not-needed'
  let claimReason = ''
  let claimStatus = 0

  const effectiveTokenState = (): { token: string; source: ConfigSource } => {
    if (config.hostToken) {
      // `readConfig` 的合成顺序就是 env > patch > 用户配置，所以按同一个顺序回答来源。
      return { token: config.hostToken, source: envToken ? 'env' : patchToken ? 'patch' : 'user' }
    }
    // ⚠️ **同时判 serverUrl**：认领来的那一枚属于某一台具体的中继，换地址之后拿它去连
    // 只有两种结果——被拒，或者把上一台中继的凭据送给一台陌生的服务器（`claim-token.ts` 文件头）。
    if (claimedToken && claimedForUrl === config.serverUrl) return { token: claimedToken, source: 'claimed' }
    return { token: '', source: 'none' }
  }

  if (!config.hostToken && config.enabled) {
    // hostId 也参与判定：盘上那枚是**绑在某个身份上的**，拿别的身份的令牌去连
    // 只会一直 `bad_token`（而它盘上有令牌就不会重新认领）—— 见 `claim-token.ts` 文件头。
    const stored = readStoredHostToken(hostTokenFile, config.serverUrl, hostId, log)
    if (stored) {
      claimedToken = stored
      claimedForUrl = config.serverUrl
      log('host token restored from disk', { file: path.basename(hostTokenFile), tokenLength: stored.length })
    } else {
      // 认领是**异步**的：这一刻还没有 token，但也不该因此拒绝启动
      // （`validateConfig` 会为缺 token 报 error —— 那一条在下面被显式豁免）。
      claimState = 'pending'
    }
  }
  /**
   * "token 会有"这件事：认领在路上，或者盘上已经有一枚。
   *
   * 它只影响**一个**判断：`validateConfig` 的 `hostToken: error` 在此时**不算阻断**
   * —— 否则全新安装的机器永远走不到认领那一步（那是这条功能最核心的路径）。
   */
  const tokenWillArrive = claimState === 'pending' || claimedToken !== ''

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
  /**
   * 缺 token 那一条 error 在"认领在路上 / 盘上有一枚"时**不是问题**：它下一句就会被
   * 认领结果取代。⚠️ 必须**从数组里摘掉**，不能只跳过一次日志 —— `state()` 会把
   * `problems` 原样写进 `status.json`，留着它就会出现"token 明明认领成功、
   * 快照却写着 error:hostToken"的假警报（与 2026-10-03 那条 `warn:pill` 并存事故同形）。
   */
  if (tokenWillArrive) {
    for (let index = problems.length - 1; index >= 0; index -= 1) {
      const problem = problems[index]
      if (problem && problem.level === 'error' && problem.field === 'hostToken') problems.splice(index, 1)
    }
  }
  for (const problem of problems) {
    log(`config ${problem.level}`, { field: problem.field, message: problem.message })
  }

  if (!config.enabled) {
    status.write({ carrier: 'none', relay: 'idle', reason: 'disabled' })
    return undefined
  }
  /** error 级问题 ⇒ 不启动（面包屑一定留下）。缺 token 那一条已经在上面被摘掉了。 */
  const blocking = problems.filter((problem) => problem.level === 'error')
  if (blocking.length > 0) {
    status.write({
      carrier: 'none',
      relay: 'idle',
      reason: 'invalid-config',
      serverUrl: config.serverUrl,
      hostToken: undefined,
      problems: blocking.map((problem) => `${problem.level}:${problem.field}:${problem.message}`),
    })
    return undefined
  }
  if (claimState === 'pending') {
    // 认领期间也留下面包屑：GUI 宿主里 stdout 没人看，而这段时间屏幕上什么都没有。
    status.write({
      carrier: 'none',
      relay: 'idle',
      reason: 'claiming-token',
      serverUrl: config.serverUrl,
      problems: problems.map((problem) => `${problem.level}:${problem.field}`),
    })
  }

  /**
   * 把认领结果落定：**无论成败都打开启动闸门**。
   *
   * "没认领到"的后果是"这台主机连不上中继"（relay 会拒掉空 token），
   * **不是**"插件起不来" —— 后者会把"手机上看不到这台机器"变成"连设置页都没有"，
   * 而设置页那一栏正是用户自己填 token 的地方（进阶项）。
   */
  const settleClaim = (): void => {
    if (claimState === 'pending') return
    if (pendingPort) start(pendingPort)
    else tryStart()
    startMockIfConfigured()
    if (!runtime) reportNoCarrier()
  }
  if (claimState === 'pending') {
    // ⚠️ 必须带 `hostId`：中继从 2026-10-11 晚起**没有**"未绑定槽位"了，
    // 不带身份一律 400 `host_id_required`（那枚令牌原来对谁都算数，是一把万能钥匙）。
    void claimHostToken({ serverUrl: config.serverUrl, hostId, log }).then((outcome) => {
      if (outcome.ok) {
        claimedToken = outcome.token
        claimedForUrl = config.serverUrl
        claimState = 'ok'
        // 落盘走 `platform/secure-file.ts`（0600 + 原子写），与 status.json / 密钥簿同一条路。
        writeStoredHostToken(
          hostTokenFile,
          { token: outcome.token, serverUrl: config.serverUrl, source: 'claimed', now: clock.now(), hostId },
          log,
        )
        log('host token claimed', { serverUrl: config.serverUrl, tokenLength: outcome.token.length })
      } else {
        claimState = 'failed'
        claimReason = outcome.reason
        claimStatus = outcome.status ?? 0
        // 一条 warn 进快照：否则"手机上看不到这台机器"在 status.json 里只剩下 relay offline。
        problems.push({
          level: 'warn',
          field: 'hostToken',
          message: `没能从中继认领到 host token（${outcome.reason}）：请把中继的 DRC_HOST_TOKEN 写进 ${config.hostTokenEnv || '(hostTokenEnv 为空)'}，或在设置页「进阶」那一栏自己填一枚`,
        })
        log('host token claim failed: this host cannot connect until a token is configured', {
          reason: outcome.reason,
          status: outcome.status ?? 0,
        })
      }
      settleClaim()
    })
  }

  /**
   * ── 自愈：中继说"你这枚令牌不认" ⇒ 带自己的 hostId 重新认领一枚并重连 ──────────
   *
   * ## 为什么非有不可
   *
   * 认领接口是**无认证**的，而且它对**指定的 hostId** 会覆盖槽位（"后面的顶掉前面的"）。
   * 所以任何知道某台机器 hostId 的人，都能领一枚覆盖掉那台的令牌 ——
   * 而那台机器"盘上有 token 就不再认领"，于是**永久连不上**。
   * 这次事故的形态（2026-10-11 一天被顶掉三次）改掉的是"谁都能顶所有人"，
   * 但"定点顶掉某一台"要靠这里自愈来兜。
   *
   * ## 触发面只有一处：中继的 `error{bad_token}`
   *
   * 中继**只在主机鉴权那一处**发这个码（`server.ts` 的 `sendError(peer, 'bad_token')`），
   * 所以它无歧义地等于"你这枚 host token 被拒了"。
   *
   * ## 三条边界
   *
   * ① **只自愈"机器自己领来的"那一枚**（`effectiveTokenState().source === 'claimed'/'none'`）。
   *    env / patch / 设置页写下的令牌是**用户明确写的**：静默换掉会把"配置写错了"
   *    变成"看起来好了、重启后又坏"，而且换来的那枚压根不会被下一次启动读到
   *    （有 `config.hostToken` 时 `readStoredHostToken` 根本不参与）。
   *    那种情况只留一条可查的痕。
   * ② **有额度、有冷却**：最多 `HEAL_MAX_ATTEMPTS` 次，两次之间至少隔 `HEAL_COOLDOWN_MS`，
   *    同一时刻只允许一次请求在路上 —— 否则"中继一直拒"就变成自造 DDoS
   *    （那条接口是**无认证**的，还带 4 秒/IP 的限频）。
   *    ⚠️ 额度数的是**这一轮连续失败**（`healAttempts`），不是一生累计：一次
   *    `hello-ok` 就把它清空（见 `onState` 的 online 分支）。被顶号是**会反复发生**的事
   *    （别人重建机器、令牌表裁剪、中继重部署），用累计额度会把一台反复被顶的机器
   *    在第五次之后**永久放弃**，而那期间并没有新故障。诊断要看的累计数另有一个
   *    `healTotal`（`diagnostics.hostToken.heals`）—— 两个数服务两个读者。
   * ③ **任何一条路径上都不许留下一条挂死的 socket**：中继拒绝时不关连接，而 `hello`
   *    只在 `open` 时发一次 ⇒ "这次不重试"也必须**排一次**重连（`reconnectIn`，
   *    排在冷却窗口结束时），否则那台主机会以"连接中"的样子永远挂着 ——
   *    那正是这次要修的形状。额度用尽则**停手**（不再重连、不再认领）并留一条
   *    problem：那时候"安静地告诉人"比"每秒重试一次"更有用。
   */
  const HEAL_MAX_ATTEMPTS = 5
  const HEAL_COOLDOWN_MS = 60_000
  let healInFlight = false
  /**
   * `healAttempts` = **这一轮连续失败**的次数，只用于额度（`HEAL_MAX_ATTEMPTS`）；
   * `healTotal` = 进程一生成功自愈过几次，只给诊断看。
   *
   * ⚠️ 为什么必须是两个数（2026-10-12 review 补）：额度按"连续失败"算才有意义
   * （一次 `hello-ok` 就说明令牌能用了，之前的失败记录作废，见 `onState` 里那段）；
   * 而诊断必须**只增不减** —— 拿一个会被归零的数当诊断，"这台机器自愈过吗"
   * 就永远查不到，而那正是运维最需要的一格。
   */
  let healAttempts = 0
  let healTotal = 0
  let healBlockedUntil = 0
  let healReason = ''
  let warnedConfiguredToken = false
  let warnedHealExhausted = false

  const healHostToken = (): void => {
    if (healInFlight) return
    const source = effectiveTokenState().source
    if (source !== 'claimed' && source !== 'none') {
      // 配置层写下的令牌：不换，但一定要留痕（否则用户只看到 relay offline）。
      if (!warnedConfiguredToken) {
        warnedConfiguredToken = true
        problems.push({
          level: 'warn',
          field: 'hostToken',
          message: `中继拒绝了当前这枚 host token（来自 ${source}）。它是你配置里写下的，插件**不会**替你换掉 —— 请核对 ${config.hostTokenEnv || 'hostToken'} 或设置页「进阶」那一栏`,
        })
        log('the relay rejected a configured host token; not self-healing by design', { source })
      }
      return
    }
    const now = clock.now()
    /**
     * ⚠️ 冷却窗口里**不打那条无认证的接口**，但必须**把重连排上**（`reconnectIn`）：
     * 中继拒绝 host token 时**不关连接**，而 `hello` 只在 `open` 时发一次 —— 什么都不做
     * 就等于让这条 socket 永远挂着，正是这次要修的形状（"连接中、没反应、也没日志"）。
     * `reconnectIn` 自己会去重，所以每个 `bad_token` 都排一发也不会把窗口作废。
     */
    if (now < healBlockedUntil) {
      relay?.reconnectIn(healBlockedUntil - now, 'waiting out the host-token self-heal cooldown')
      return
    }
    if (healAttempts >= HEAL_MAX_ATTEMPTS) {
      // 额度用尽 ⇒ **停手**（不再重连、不再认领）：继续每秒打一遍中继只会刷满它的日志，
      // 而"安静地告诉人"更有用 —— 快照里那条 problem 就是留给用户的结论。
      if (!warnedHealExhausted) {
        warnedHealExhausted = true
        log('host token self-heal gave up after the attempt budget', { attempts: healAttempts, reason: healReason })
        problems.push({
          level: 'warn',
          field: 'hostToken',
          message: `host token 被中继拒绝了，自愈用满 ${HEAL_MAX_ATTEMPTS} 次还没成功（最近一次：${healReason || '未知'}）⇒ 这台主机现在连不上。查网络与 /api/claim-token，或在设置页「进阶」那一栏自己填一枚，然后重启 Harness`,
        })
      }
      return
    }
    healInFlight = true
    healAttempts += 1
    void claimHostToken({ serverUrl: config.serverUrl, hostId, log }).then((outcome) => {
      healInFlight = false
      healBlockedUntil = clock.now() + HEAL_COOLDOWN_MS
      if (!outcome.ok) {
        healReason = outcome.reason
        log('host token self-heal failed; will retry after the cooldown', {
          reason: outcome.reason,
          attempts: healAttempts,
        })
        relay?.reconnectWithBackoff('host token rejected, self-heal failed')
        return
      }
      claimedToken = outcome.token
      claimedForUrl = config.serverUrl
      claimState = 'ok'
      // 累计自愈次数（诊断用，只增不减；额度那边是 `healAttempts`，由 `online` 归零）
      healTotal += 1
      writeStoredHostToken(
        hostTokenFile,
        { token: outcome.token, serverUrl: config.serverUrl, source: 'claimed', now: clock.now(), hostId },
        log,
      )
      // 之前那条"没认领到"的 warn 已经过时：留着会让快照一直挂着一条假警报
      // （与上面 `tokenWillArrive` 摘 error 那条同一个理由）。
      for (let index = problems.length - 1; index >= 0; index -= 1) {
        if (problems[index]?.field === 'hostToken') problems.splice(index, 1)
      }
      log('host token self-healed: the relay rejected the old one', {
        attempts: healAttempts,
        tokenLength: outcome.token.length,
      })
      // 换令牌 + 立刻重连：`hello` 只在 `open` 时发一次，而中继拒绝时**不关连接**。
      relay?.replaceToken(outcome.token)
    })
  }

  const slots = new PairingSlots(() => clock.now())
  /**
   * 小程序码路线的授权状态机（2026-10-21）。
   * `pskFor` 只从**这张码自己**取 psk（resolveFor 不许退化成"取最新一张"）。
   */
  const pairApproval = createPairApproval({
    pskFor: (token) => slots.resolveFor(token)?.psk ?? null,
    now: () => clock.now(),
  })
  /**
   * 小程序码的取码器（2026-10-21）。**懒建**：它在启动路径上不碰网络，
   * 只有真的要画一张码时才向中继开口。地址每次现读 `config.serverUrl`
   * ——设置页改过中继之后不该再向旧中继要图。
   */
  let mpCode: ReturnType<typeof createMpCodeFetcher> | undefined
  const mpCodeFetcher = (): ReturnType<typeof createMpCodeFetcher> => {
    if (!mpCode) {
      mpCode = createMpCodeFetcher({
        serverUrl: config.serverUrl,
        fetchImpl:
          typeof globalThis.fetch === 'function'
            ? (input, init) => globalThis.fetch(String(input), init as RequestInit | undefined)
            : undefined,
        log,
      })
    }
    return mpCode
  }
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
   * 状态栏那颗 pill 的六条路由（配对的唯一入口）。`undefined` = 还没起 / 起不动。
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

  const transport: RuntimeTransport = {
    reply(conversationId: string, payload: EvPayload): boolean {
      return relay ? relay.send(conversationId, payload) : false
    },
    broadcast(payload: EvPayload, opts?: { includeNoClient?: boolean }): number {
      return relay ? relay.broadcast(payload, opts) : 0
    },
    hasClient(conversationId: string): boolean {
      return relay?.hasClient(conversationId) ?? false
    },
    conversationIds(): string[] {
      return relay?.conversationIds() ?? []
    },
    pushSummary(digest: { at: number; running: boolean; steps?: number; pending?: number }): number {
      // 没有中继客户端就没人可登记（本地记账为 0）：摘要是幂等快照，下次推送还会带。
      return relay ? relay.pushSummary(digest) : 0
    },
    /** 中继声明了通知面吗（`notify.v1`，2026-10-27）。没有中继 ⇒ 没有。 */
    supportsNotify(): boolean {
      return relay ? relay.supportsNotify() : false
    },
    /** 发一帧 `notify-approval`（提醒：这条会话有卡在等）。 */
    notifyApproval(conversationId: string, items: NotifyItem[]): boolean {
      return relay ? relay.notifyApproval(conversationId, items) : false
    },
  }

  /**
   * 认领还在路上时暂存的载具端口（见 `start()` 的第一段）。
   * 认领一落地就把它交给 `start()`，与"晚到的服务"走同一条路。
   */
  let pendingPort: KernelPort | undefined

  const start = (port: KernelPort): void => {
    if (runtime) return
    if (claimState === 'pending') {
      /**
       * 认领还没落地：**把端口记下来，先不建中继客户端**。
       *
       * 为什么不能"先用空 token 连上、认领到了再换"：`RelayClient` 的 token 是
       * **构造时读一次**的（`hello` 帧就在连接那一刻发出去），换 token 得重建客户端；
       * 而"空 token 先连一次"会给中继留一条必然失败的鉴权记录，把真正的故障
       * （认领失败）埋在一堆 auth failed 里。
       */
      pendingPort = port
      return
    }
    kernel = port
    startedCarrier = port.carrier
    relay = new RelayClient({
      url: config.serverUrl,
      hostId,
      label: config.hostLabel,
      /**
       * 软件版本（2026-10-23 用户裁决「report version 要开起来、不用做开关」）：
       * **无条件随 hello 发送**，不再看 `DRC_REPORT_VERSION`。中继侧同日改成"有就记"。
       * 零知识边界不动：版本是端点自报的元数据，不是内容；老中继不认识这个可选
       * 字段会把它 strip 掉（加性字段零报错）。
       */
      softwareVersion: PLUGIN_VERSION,
      // 生效值可能来自**认领**（那一枚不在 `config.hostToken` 里，见 `effectiveTokenState`）。
      token: effectiveTokenState().token,
      clock,
      log,
      lookupPairingSlot: (token) => slots.resolveFor(token),
      /**
       * 手机拿着小程序码来认领（带一次性公钥）：算出 6 位数字挂起来。
       *
       * ## 这里**自动放行**（2026-10-21，用户裁决"只保留一边确认"）
       *
       * 原来是"不自动放行"：要人去主机上点一次「数字一致，允许」，
       * 主机才把 psk 加密送回。于是**两边都要点一次**（主机点允许、手机点数字一致），
       * 而手机上那一次**才是**真正的安全动作 —— 它比对的是"主机算出来的那串"
       * 与"手机自己算出来的那串"，**这是发现中继换公钥的唯一手段**。
       *
       * 主机那一次点击**不增加任何安全性**：它只是把"用户已经看过手机上的数字"
       * 这件事说了一遍。真正的比对必须在**持有手机**的那一端做。
       *
       * ⇒ 主机改成自动放行（把 psk 送过去），**确认只留在手机端**。
       *
       * ⚠️ **安全性质没有因此降低**：中继换掉公钥时，两端算出的数字不同 ⇒
       * 手机上的弹窗会显示一个与主机屏幕上的**不一样**的数字 ⇒ 用户点"不一致"即可中止。
       * 主机界面**仍然显示那 6 位数字**（供用户对照，也供排错取证）。
       *
       * ⚠️ 手机端那一次**不许省**：省了它，中继就能换公钥而不被发现。
       */
      onPairRequest: pairFlow.onPairRequest,
      onPairReady: pairFlow.onPairReady,
      onPeerJoined: pairFlow.onPeerJoined,
      onClientLeft: () => {
        void runtime?.pushSessions('client-left')
      },
      /**
       * **手机端解配 ⇒ 主机立刻补一张能再配一次的码**（2026-10-23 用户报：
       * "手机端退出配对，主机端不会自动刷码"，pill 停在「未连接」+ 刷新按钮）。
       *
       * 为什么解配那一刻主机没有码：屏幕那张在配对成功时就被中继 `claim` 烧掉了
       * （`markConsumed` 清了 `展示位`），而自动发码 `pairOnStartSec` 默认 0
       * ⇒ `pairingWindow.tick()` 在 `active === null` 时第一行就早退，谁都不会补。
       * 主机自己那颗「退出配对」（`unpairAll`）早就会补一张 —— 两端语义要对称：
       * **不管解配是从哪一端发起的，主机的屏幕都该回到"能再配一次"的样子。**
       *
       * 中继不在线时不硬发（`publishPairing` 对非 OPEN 的 socket 是静默丢弃，
       * 本地会留下一张中继根本没收到的死码），改成记一笔欠账，`online` 之后补上。
       */
      onClientUnpaired: pairFlow.onClientUnpaired,
      /**
       * **这台手机的密钥面已经可以用来推东西了** —— 两个触发点，同一件事：
       *
       * ① **重连**（2026-10-08 接线）：手机在 `_onHelloOk` 里把上一连接的那份结论清空
       *    （新连接 = 上一代状态作废），必须有人把当前这份重新告诉它，否则重连后手机
       *    手上的限额是空的 —— 附件闸门与页面判断全部落空，并且**两端都不报错**。
       * ② **刚配对完**（2026-10-21 补）：3.2 的 psk 要等用户比对 6 位数字才装进手机，
       *    所以 `peer-joined` 那一刻推过去的一切都被静默丢掉 —— 交付点只能是
       *    "第一帧解得开的东西到了"。`relay.ts` 的 `awaitingKeys` 就是为这个加的，
       *    手机配完对立刻发的 `cmd.list_sessions` 正好触发它。
       *
       * 两个触发点在传输层是同一个判断（"第一帧解得开的密文"），所以这里只有一处接线。
       *
       * ## 刻意不做的三件事
       *
       * - **不 `voidConversation` 别的通道**：那是"只允许一台"的策略，属于
       *   **新配对**。回到自己那条会话不该把别的会话踢掉（中继重启后从盘上恢复出
       *   多条会话时，这一脚会误伤另一台正在用的手机）。
       * - **不 `runtime.start()`**：重连不是启动点。恢复出来的会话在进程启动时就已经
       *   起过内核订阅（`restoreConversations` 那条路），这里再调一次是空操作。
       *   配对那条路在 `onPeerJoined` 里已经调过，且早于本回调。
       * - **不 `pushSessions`**：手机重连后**自己会发** `cmd.list_sessions`
       *   （`_onHelloOk` / `_onPaired`），列表本来就要回来一份。再推一次只是多一帧，
       *   而这一帧在判据里长得像"主机主动推了列表"，会掩盖"那条命令到底发没发出去"。
       *
       * `sendHostInfo` 自带 try/catch 且失败返回 false：这里只留痕，不让它抛进中继的
       * 帧处理循环（那会把这一帧后面所有逻辑一起带走）。
       */
      onClientRejoined: (conversationId) => {
        if (runtime && !runtime.sendHostInfo(conversationId)) {
          log('host info not sent (client rejoined)', { conversationId })
        }
        /**
         * **挂着的审批/提问也要推一遍**（2026-10-10 补，用户报「手机不在线时卡还是会漏」）。
         *
         * ## 这一行原来只存在于「配对」那条路上
         *
         * `replayPending()` 一直只在 `onPeerJoined` 里被调用（配对那一刻），
         * 而**重连不会走 `onPeerJoined`** —— 中继只在配对那一刻通知主机。
         * 于是"手机退后台 / 断网，卡在期间产生，手机回来"这条路上，
         * 主机**从来没主动推过**：它只能等手机自己发 `cmd.get_pending`。
         *
         * 而手机那条拉取只挂在 **chat 页**（`chat.js` 的 `status==='online'` 与 `onShow`）——
         * 停在列表页时**一个字都不拉**。⇒ 卡就漏了。
         *
         * ## 为什么挂在这里是对的
         *
         * 本回调回答的是"**这台手机现在解得开了**"，而那正是"推过去它真能看见"的
         * 唯一前提 —— 三件事（能力面、挂起卡、历史差量）用的是同一个前提。
         * 3.2 之前配对那一刻手机手里**已经有** psk（码里带着），所以 `onPeerJoined`
         * 推得动；3.2 之后没有那条路了，配对也归到这里。
         *
         * ## 顺序
         *
         * 排在 `sendHostInfo` **之后**：手机 `_onHelloOk` 里会把上一连接的那份结论清空，
         * 页面按它决定附件闸门与渲染，所以那一帧必须先到。
         *
         * `replayPending` 自带 `hasClient` 守卫、永不抛（见它的第三条纪律），
         * 所以这里不包第二层 try。
         */
        runtime?.replayPending(conversationId)
      },
      onConversationGone: (conversationId) => {
        log('conversation gone', { conversationId })
        /**
         * 这条会话没了 ⇒ 那串"最近放行过的确认码"也一起没了（2026-10-21 晚）。
         *
         * **解配有两条路，都要清**：
         *  · 主机端点「退出配对」→ `unpairAll()` → 那里也清了；
         *  · **手机端解配** → 中继发 `peer-left{unpaired:true}` → `voidConversation`
         *    → **这里**（原来漏了它 ⇒ 手机解配后主机屏幕上那串数字还挂着 90 秒）。
         *
         * 它不是凭据（真凭据在密文里），但"该消失的东西留着"本身就是一种不一致 ——
         * 界面上的每一样东西都该对应当前状态。
         */
        pairApproval.clear()
      },
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
        pairFlow.resetRateLimitAndRetryOwed()
        /**
         * **自愈额度也在这里归零**（2026-10-12 review 补）。
         *
         * ## 为什么必须归零
         *
         * 自愈是"中继回 `bad_token` ⇒ 带自己的 hostId 重新认领"的兜底，而它要应付的
         * 恰恰是**会反复发生**的事件（`drf-api` 那台机器重建一次、令牌表被裁剪一次、
         * 有人重新部署一次中继）。如果额度是"进程级只增不减"，那么一台机器跨天遇到
         * 两次 `bad_token`（间隔远超冷却）就会把 5 次用尽，然后被**永久放弃**：
         * 自愈不再尝试、`problems` 一直挂着"用满 5 次"、主机再也不会自己回来 ——
         * 而这一切距离上一次成功可能已经过去几天，期间没有任何新故障。
         *
         * ⇒ 语义改成"**连续失败**才计数"：一次 `online` 就把窗口清空
         * （`hello-ok` 就是"这枚令牌现在能用"的证明）。这也让
         * `diagnostics.hostToken.heals` 的含义变回"这一轮连续自愈了几次"，
         * 而不是"进程一生自愈过几次"——后者对一个只会变大的数没用。
         *
         * ⚠️ 与 `healBlockedUntil` 的区别：那个是**冷却**，作用在"两次尝试之间"，
         * 由认领结果设置；这里是**额度**，作用在"连续失败的次数"上。两者在
         * 冷却期内不会同时起作用（online 之后也不需要冷却）。
         */
        healAttempts = 0
        healBlockedUntil = 0
        warnedHealExhausted = false
        /**
         * **并且把那几条 hostToken 的 problem 摘掉**（2026-10-12 review 补）。
         *
         * 额度用尽时 push 的那条 warn 说的是"这台主机**现在连不上**"。而走到这里
         * 说明中继**刚刚接受了我们的令牌**（`hello-ok`）⇒ 那句话已经不成立了。
         * 不摘的话会出现这个形状：用户手工换了一枚（或网络恢复）之后一切正常，
         * 而 `status.json` 里永久挂着"连不上"——正是本文件反复处理过的"假警报并存"
         * （见上面 `tokenWillArrive` 那段与 2026-10-03 的 `warn:pill` 事故）。
         *
         * ⚠️ 与自愈成功分支（`healHostToken` 里 `problems.splice` 那处）同一口径：**认领成功**与
         * **握手成功**都是"令牌现在能用"的证明，两条路都该摘。
         */
        for (let index = problems.length - 1; index >= 0; index -= 1) {
          if (problems[index]?.field === 'hostToken') problems.splice(index, 1)
        }
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
      onPairFail: pairFlow.onPairFail,
      /**
       * 中继的错误帧：主机第一次真的按 `code` 分支。
       *
       * 两个码有反应：`rate_limited`（立刻重试只会更糟，进退避窗口）与
       * `bad_token`（**唯一一处**会发它的地方是主机鉴权守卫 ⇒ 无歧义地等于
       * "这枚 host token 被拒了"，走自愈：重新认领一枚并重连）。
       */
      onRelayError: (code, retryAfterMs) => {
        if (code === 'bad_token') {
          log('the relay rejected our host token; trying to self-heal')
          healHostToken()
          return
        }
        if (code !== 'rate_limited') return
        pairFlow.noteRateLimited(retryAfterMs)
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
    // 一张码是一次性的，用完/中继重启/剩余不足安全余量都得换一张（判据见 core/pairing-window.ts）。
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
     * 周期性 housekeeping：**剪枝 + 补码 + 批量落盘**（v5 R2b 抽出 → `core/housekeeping.ts`）。
     * 三件事的"为什么"在那个模块的文件头；这里只做装配。
     */
    const housekeeping = createHousekeeping({
      clock,
      log,
      tickPairingWindow: () => pairingWindow.tick(),
      pruneConversations: () => relay?.pruneConversations(),
      pruneSlots: () => slots.prune(),
      saveIfDirty: () => {
        // `seqHost` 与 `lastActivityAt` 每次广播都变 ⇒ 只标脏、按节拍批量落；
        // 判据是 `hasPendingChanges`：**没脏就不写**。
        if (pairStoreFile && pairStore.hasPendingChanges && relay) {
          pairStore.save(relay.conversations.snapshot(), clock.now())
        }
      },
      refreshMs: STATUS_REFRESH_MS,
    })
    status.start(() => {
      housekeeping.tick()
      return state()
    })
    // 快照关掉时自己起一节拍；`stop()` 里与 `status.stop()` 一起收。
    housekeeping.startSelfTimer(Boolean(config.statusFile), (stop) => stopHooks.push(stop))
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
       * 挂着的配对授权（小程序码路线）。null = 没有人在等确认。
       * UI 只读这里：`sas` 是给人比对的 6 位数字，`remainSec` 到 0 就该收起。
       */
      pairApproval: pairApproval.current() ?? null,
      /**
       * **最近放行**的那 6 位数字（2026-10-21 晚：主机自动放行之后）。
       *
       * 放行是"取走即焚"⇒ `pairApproval` 立刻变 null ⇒ 主机界面就再也显示不出
       * 那串数字了。而它是**用户唯一能对照的东西**（手机上弹窗一串、主机屏幕上一串，
       * 两处一致才说明中间没人换公钥）⇒ 放行之后仍要留一会儿给用户对照。
       *
       * 它**不是凭据**（真正的凭据在密文里），所以过期就自动消失。
       */
      lastPairApproval: pairApproval.lastGranted() ?? null,
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
      pairing: issuance.describe(),
      keepAwake: snapshot,
      /**
       * **诊断三件套**（V3-PLAN §7 阶段 F4：自部署 / 传输 / 续传命中率）。
       *
       * 为什么单独一块而不是散进上面的字段：`relay`/`relayProblem`/`conversations`
       * 答的是"此刻是什么样"，这三组答的是"**一直**是这样吗"——而排错里最贵的问题
       * 恰恰是后一种（续传永远不生效但界面正常、链路每 3 秒重连一次但字段一直绿）。
       *
       * **每个字段都有谁读它**（F4 的判据）：`scripts/host-doctor.mjs`
       * （只读白名单 + 非 0 退出码，与 `packages/relay/scripts/relay-doctor.mjs` 同款），
       * 字段清单见 docs/HOST-SIDE.md §5。改了字段不接进 doctor 会被
       * `e2e/status-diagnostics.test.mjs` 判红。
       */
      diagnostics: {
        selfHosting: describeSelfHosting(config.serverUrl),
        transport: relay?.transport ?? null,
        resume: runtime?.resume ?? null,
        /**
         * 挂起卡（审批 / 提问）那条链的读数（2026-10-09）。
         *
         * **为什么必须出到快照**：`waiting`（张数 + 最久等了多久）早就算好了，
         * 但它只进了 pill 面板 —— 而面板恰恰是"用户在手机上根本看不到的那台机器"。
         * 症状是"手机上没有那张卡"，四种根因（手机没问 / 问了但已超时 / 主机没挂 / 手机没渲染）
         * 长得一模一样，这四个数一次分开，别再靠猜。读法见 `runtime.ts` 的 `pendingAsks`。
         */
        pendingAsks: runtime?.pendingAsks ?? null,
        /**
         * 「本次会话内始终允许」命中过几次。
         *
         * 单独成一格而不是并进 `pendingAsks`：它回答的是**为什么这次没弹审批**，
         * 而那一格回答的是"此刻有几张卡在等"——两件事，时机不同、读者也不同。
         * 计数归 runtime（`approvalScopeOf` 查表就在那一层），见那里的注释。
         */
        alwaysAllowedHits: runtime?.alwaysAllowedHits ?? 0,
        /**
         * **发帧之前就被判掉**的次数，按理由分开。
         *
         * 这一格是"手机上没有那张卡"最直接的嫌疑：现场 `permission_request` 发不出去，
         * 而其它事件（`tool_event` / `message_delta`）发得出去 —— 差的就是这一格。
         * `noClient`（一台手机都没配过 ⇒ 交还桌面）是正确行为；
         * `offlineHold`（配过、但此刻不在线 ⇒ **挂账等它回来**）是 2026-10-10 补的那一支；
         * `aborted`（平台自己撤回了请求）多半也是正确行为。
         * 混在一起数就分不出该修哪一个。
         */
        interactionDeclines: runtime?.declined ?? null,
        /**
         * 附件限额（2026-10-10 补）。⚠️ 这一格存在的理由是**用户报过两次"发不了图"**：
         * 没有它，doctor 分不清"主机报的是 0（手机拦得对）"还是"报的是 4（那才是
         * 手机/链路的锅）"，只能回去读代码。
         */
        attachmentLimits: runtime?.attachmentLimitsForDiagnostics ?? null,
        /**
         * **host token 是从哪来的 / 认领成功没有**（2026-10-11 加）。
         *
         * 为什么必须出到快照：`state()` 那一格只有 `hostTokenShape`（脱敏形态），
         * 它回答不了"这枚 token 是用户配的、还是机器自己去认领的"；
         * 而认领失败时的症状是**中继侧的 auth failed**（`relay: offline`），
         * 在 GUI 宿主里没有任何地方说得清"原因其实是没认领到"。
         *
         * `claim` 的四个取值：`not-needed`（本来就有 token，没去认领）/ `pending`
         * （请求在路上）/ `ok` / `failed`（`reason` 说清是哪一档：unreachable / http / shape /
         * bad-url / no-fetch / no-host-id）。
         * `heals` 是**进程一生成功自愈过几次**（只增不减：归零会让"自愈发生过"
         * 这件事永远查不到，而它正是运维最需要的一格）；`healFailedInRow` 是
         * **这一轮连续失败**了几次 —— 它同时是额度（满 `HEAL_MAX_ATTEMPTS` 次停手）
         * 的读数，所以会在下一次 `hello-ok` 之后归零。
         * `healReason` 是最近一次自愈失败的原因（空 = 没失败过）。
         * **绝不含 token 本身**，也绝不含它的任何片段。
         */
        hostToken: {
          source: effectiveTokenState().source,
          claim: claimState,
          claimReason: claimState === 'failed' ? claimReason : '',
          claimStatus: claimState === 'failed' ? claimStatus : 0,
          file: hostTokenFile ? path.basename(hostTokenFile) : '',
          heals: healTotal,
          healFailedInRow: healAttempts,
          healReason,
        },
      },
      kernel: kernel?.describe() ?? null,
      // 出站计数：手机上"没收到 X"的第一现场对比点（插件没发 vs 发了但路上丢了）。
      outbound: runtime?.stats ?? null,
      probe,
      // 配对入口（那颗 pill 的六条路由）为什么没起，是"配不了对"唯一的排查入口：
      // 这里直接把软探测的结果带出来。
      pill: pillRoutes?.probe ?? { webServer: 'not-started' },
      // token 永远不出现真值；这条有测试锁住。
      hostToken: undefined,
      // ⚠️ 读**生效值**（可能是认领来的那一枚），不是 `config.hostToken` ——
      // 后者只是配置层合成出来的那一份。形状（长度）是排错时"是不是拿错了变量"的唯一线索。
      hostTokenShape: effectiveTokenState().token ? redact(effectiveTokenState().token) : undefined,
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
  /** 中继连接状态（与 status.json 同一口径——两处不许说两种话）。 */
  function relayState(): 'online' | 'connecting' | 'offline' {
    return lastRelayState
  }
  function relayProblem(): string | undefined {
    return lastRelayProblem
  }

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
      /**
       * 小程序码路线的授权（2026-10-21）：有值 = 有人在等你比对 6 位数字。
       * UI 只读这一处，`remainSec` 到 0 自动消失。
       */
      pairApproval: pairApproval.current() ?? null,
      /**
       * **最近放行**的那 6 位数字（2026-10-21 晚：主机自动放行之后）。
       *
       * 放行是"取走即焚"⇒ `pairApproval` 立刻变 null ⇒ 主机界面就再也显示不出
       * 那串数字了。而它是**用户唯一能对照的东西**（手机上弹窗一串、主机屏幕上一串，
       * 两处一致才说明中间没人换公钥）⇒ 放行之后仍要留一会儿给用户对照。
       *
       * 它**不是凭据**（真正的凭据在密文里），所以过期就自动消失。
       *
       * ⚠️ **这一格与 `status.json` 那份必须同时有**（2026-10-21 晚）：
       * UI 轮询走的是 `pillStatus()`（这里），而 `status.json` 是另一份快照 ——
       * 只给 `status.json` 加、忘了这里，那主机屏幕上**照样没有**那串数字
       * （e2e 装置读的是 status.json，所以它会全绿，而真机是坏的）。
       */
      /**
       * **码龄 / 剩余寿命**（2026-10-26）：`null` = 屏幕上现在没有能用的码。
       *
       * 只给 UX 用（"这张码已经 45 秒，还有 135 秒"），**不含 token/psk**
       * —— 与 `status.json` 那份 `pairing`（0600、带凭据）刻意分开：
       * 这里是每 2 秒被宿主 UI 轮询的只读面，白名单多一条就是一次外泄面。
       */
      pairing: issuance.info(),
      lastPairApproval: pairApproval.lastGranted() ?? null,
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
   * 要等它 TTL 走完才恢复）。原来只作废通道、不管码：`展示位` 还挂着刚走的那部手机
   * 花掉的那一张，而 `pairOnStartSec` 默认 0（自动发码关着）于是没有任何东西去换它 ——
   * 状态栏那张图、`/pairing/new` 发的那张，全都是 `already_used`。
   *
   * 两步都是必须的：把旧码记进花名账（这样即使补发失败也不会再把死码递出去），
   * 再立刻补一张（这样状态栏上不是空白，用户点开就有能扫的）。
   */
  function unpairAll(): number {
    const ids = relay?.conversationIds() ?? []
    for (const id of ids) relay?.voidConversation(id)
    if (issuance.shown()) issuance.spend(issuance.shown()!.token)
    issuance.clearShown()
    /**
     * 连同那条配对申请与"最近放行"的 6 位数字一起清掉（2026-10-21 晚）。
     *
     * 解配的语义是"这条路不要了" ⇒ 屏幕上不该还挂着一串"刚才放行过的确认码"
     * —— 它是过期信息，会让人以为"刚才是这一串"。
     *
     * ⚠️ **这条以前没接上**：`pairApproval.clear()` 一直只被"换码"那条路调用，
     * 而解配走的是这里 ⇒ 解配后那串数字还会挂 90 秒。
     * （"它不是凭据"是真的，但"该消失的东西留着"本身就是不一致。）
     */
    pairApproval.clear()
    issuance.publish()
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
        const created = issuance.publish(ttlMs)
        if (!created) return null
        return { token: created.token, createdAt: clock.now(), expiresAt: created.expiresAt }
      },
      log,
    },
    config.pairOnStartSec,
    // 未自动发码时那张"用户点出来的码"按配置的 pairTtlMs 老化（与发码时请求的 TTL 同源）。
    config.pairTtlMs,
  )

  /**
   * **码的签发/展示/补发/记账**（v5 R1 抽出 → `core/pair-issuance.ts`，行为零变化）。
   *
   * 状态与语义原样搬走：花名账（spentTokens）、展示位、发码、幂等取码、status 快照。
   * 本周三起真机事故（消费后没人补 / 解配后没人补 / 过期直接消失）都住在这个模块里——
   * 现在"谁负责补码"只有一个居所。
   */
  const issuance = createPairIssuance({
    clock,
    log,
    slots,
    pairingWindow,
    pairTtlMs: config.pairTtlMs,
    publishSlot: (slot) => {
      if (!relay) return 'no-relay'
      return relay.publishPairing(slot) ? 'ok' : 'not-open'
    },
  })
  /** 对外接口用的老名字（`createPlugin` 的 handle）：语义 = 发一张新码。 */
  const createPairing = (): ReturnType<typeof issuance.publish> => issuance.publish()

  /**
   * **配对的认领/放行/回滚三档**（v5 R2 抽出 → `core/pair-flow.ts`，行为零变化）：
   * 认领自动放行（确认只留手机端）、消费即补发、只作废真正失败的那张、
   * 限速退避、解配补码欠账。`relay`/`runtime` 由惰性闭包捕获 —— 它们在 `start()` 里才诞生。
   */
  const pairFlow = createPairFlow({
    clock,
    log,
    pairApproval,
    slots,
    pairingWindow,
    issuance,
    sendPairGrant: (granted) => relay?.sendPairGrant?.(granted),
    voidOtherConversations: (keepId) => {
      for (const id of relay?.conversationIds() ?? []) {
        if (id !== keepId) relay?.voidConversation(id)
      }
    },
    startRuntime: () => runtime?.start(),
  })

  // ── 载体探测：services > (mock)（v5 R2c 抽出 → `core/carrier-probe.ts`）──
  const carrier = createCarrierProbe({
    clock,
    log,
    config: { newSessionCwd: config.newSessionCwd, mockBridge: config.mockBridge },
    startKernel: (kernel) => start(kernel as never),
    createServicesKernel: createServicesKernel as never,
    getRuntime: () => runtime,
    applyCount: APPLY_COUNT,
    ctx,
    oneShot,
    writeStatus: (extra) => status.write({ ...state(), carrier: startedCarrier || 'none', probe, ...extra }),
    isClaimPending: () => claimState === 'pending',
  })
  const { accept, bindScopedEvents, tryStart, reportNoCarrier, startMockIfConfigured, probe } = carrier
  // 构造尾句（模块注释里那条 TDZ 纪律）：装配完成、`probe` 可读之后才动手。
  tryStart()
  /**
   * ⚠️ 认领还在路上时**这两步都要等**：此刻 `runtime` 必然 undefined，照旧执行的话
   * 会写出 `no-carrier` / `claiming-token` 两条**互相矛盾**的面包屑，而认领落地后
   * `settleClaim()` 会把它们各走一遍。
   */
  if (claimState !== 'pending') {
    startMockIfConfigured()
    if (!runtime) reportNoCarrier()
  }

  // ── 配对入口：状态栏那颗 pill 的七条路由 ────────────────────────────
  //
  // **配对入口就是这几条路由**（`/drc` 命令 2026-10-03 整个删掉了）；
  // `GET|POST /config`（2026-10-11 加）是设置页「进阶」那一栏的读写口。
  // 主链路先成立：这一半起不来时，上面接好的那些一行都不许被回滚。
  //
  // 整段再包一层 try 不是冗余：`startPill` 内部已经层层兜住，但"层层兜住"是设计不是证明。
  // 它一旦抛出，宿主会把我们这条 fiber 标 FAILED 并 dispose 掉那几个 inject 子 fiber——
  // 那就等于用一个界面功能砸了配对链路（真机取证见 `apply()` 里那条纪律）。
  //
  /**
   * 设置页「进阶」那一栏读回来的东西：**每次请求现算**（`status` 那条路由的同一条纪律：
   * 状态是"此刻"的，缓存一份在 apply 里就会写出过期读数）。
   */
  const describeEffectiveConfig = (): EffectivePluginConfig => {
    const token = effectiveTokenState()
    const urlSource: ConfigSource = envUrl ? 'env' : patchUrl ? 'patch' : userOverrides.serverUrl ? 'user' : 'default'
    return {
      serverUrl: config.serverUrl,
      defaultServerUrl: DEFAULT_CONFIG.serverUrl,
      serverUrlSource: urlSource,
      hostTokenSet: token.token !== '',
      hostTokenShape: token.token ? redact(token.token) : '',
      hostTokenSource: token.source,
      userConfigFile,
    }
  }
  /**
   * 落盘设置页那两项。**合并而不是整体替换**：表单只提交它改过的那一项，
   * 而"空串 = 删掉这一项"的语义由 `normalizeUserOverrides` 保证（key 在 = 用户动过它）。
   */
  const saveUserOverrides = (input: UserOverrides): { ok: true } | { ok: false; field: string; error: string } => {
    const next: UserOverrides = { ...userOverrides }
    if ('serverUrl' in input) next.serverUrl = input.serverUrl
    if ('hostToken' in input) next.hostToken = input.hostToken
    if (!writeUserConfig(userConfigFile, next, clock.now(), log)) {
      return { ok: false, field: 'file', error: 'cannot write the config file' }
    }
    userOverrides = next
    /**
     * 立刻反映到生效值上，让用户保存完就看见新地址。
     *
     * ⚠️ **但连接不会跟着换**：中继地址与 token 是 `RelayClient` 构造时读一次的，
     * 所以路由的回答里带 `restartRequired: true`（不说这一句，用户会以为"保存没生效"）。
     * 重新合成一次而不是手写"回落到默认值"：优先级只有 `readConfig` 那一处说了算。
     */
    const fresh = readConfig(injected, process.env, userOverrides)
    config.serverUrl = fresh.serverUrl
    config.hostToken = fresh.hostToken
    return { ok: true }
  }
  try {
    pillRoutes = startPill(ctx, {
      enabled: config.pill.enabled,
      // 路由要的那几件事：幂等发码、只读看当前码、读连接状态、退出配对、那张静态小程序码。
      ensureFresh: () => issuance.ensureFresh(),
      current: () => issuance.current(),
      status: () => pillStatus(),
      /**
       * 手动放行（`POST /pair/approve`）。
       *
       * ⚠️ 3.2 起主机**自动放行**（见 `onPairRequest` 的注释）：确认只在手机端做。
       * 这条路由**留着**，因为它仍有两处用：
       * ① 自动放行没赶上（socket 不在 OPEN 状态）时，用户可以手动补一次；
       * ② 排错时它是一条"立刻放行"的开关。
       * 没有可放行的申请时返回 false（路由回 409，UI 显示"请重新扫码"）。
       */
      approvePair: (): boolean => pairFlow.grant(),
      unpair: () => unpairAll(),
      /**
       * 向中继要这一枚配对码的**小程序码**（2026-10-21，新码优先）。
       *
       * ⚠️ 地址读的是**此刻生效的** `config.serverUrl`：用户在设置页改过中继之后
       * （虽然要重启才连得上）不该再向旧中继要图。取码器自己带缓存与负缓存，
       * 所以"中继没配小程序"这种常态不会变成每开一次弹窗打一次外网。
       */
      mpCodeFor: async (token: string): Promise<Buffer | null> => {
        const issuer = mpCodeFetcher()
        return issuer ? issuer.codeFor(token) : null
      },
      // 设置页「进阶」那一栏：路由那一层**不碰文件系统**，读写都收在这里。
      config: () => describeEffectiveConfig(),
      saveConfig: (overrides) => saveUserOverrides(overrides),
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
      // pill 那七条路由也要一起收：它是不在主链路上的旁路，所以单独一句。
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
