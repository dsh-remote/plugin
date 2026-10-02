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
import { type CmdPayload, type EvPayload, buildPairingUri } from '@dsh-rc/protocol'
import { HostRuntime, type RuntimeTransport } from './core/runtime.js'
import { KeepAwake } from './core/sleep-policy.js'
import { PairingSlots } from './core/keys.js'
import { RelayClient } from './transport/relay.js'
import { SystemSleepBackend } from './platform/sleep-posix.js'
import { createServicesKernel } from './platform/carrier-services.js'
import { DEFAULT_SYSTEM_CLOCK } from './core/clock.js'
import { pairingImagePath, StatusFile, writePrivateFile } from './shell/status.js'
import { DEFAULT_CONFIG, readConfig, redact, validateConfig, type PluginConfig } from './shell/config.js'
import { renderTerminalQr, qrPng } from './platform/qr.js'
import type { KernelPort, Clock } from './ports/index.js'

/** 我们只用到 ctx 的几个成员，所以不硬依赖 @deepseek-ai/cordis 的类型。 */
interface LooseContext {
  get?<T>(name: string, optional: true): T | undefined
  inject?(names: string[], callback: (...services: unknown[]) => void): unknown
  provide?(name: string, value: unknown): unknown
  commands?: {
    register?(definition: {
      name: string
      description: string
      input?: { hint?: string }
      handler?: (invocation: { commandId: string; rawInput: string }) => Promise<unknown> | unknown
    }): unknown
  }
  onDispose?(fn: () => void): void
}

export interface RuntimeHandle {
  readonly config: PluginConfig
  state(): Record<string, unknown>
  createPairing(): { qr: string; token: string; psk: string; expiresAt: number } | null
  stop(): void
}

const SERVICE_NAMES = ['sessions', 'sessionQuery', 'agents', 'agentDefaultModel', 'workspaceRegistry', 'userQuestions']

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
  try {
    ctx.provide?.('dshRemoteControl', {
      get state(): Record<string, unknown> {
        return handle?.state() ?? { relay: 'offline', carrier: 'none', reason: 'not-started' }
      },
      createPairing: (): { qr: string; token: string; psk: string; expiresAt: number } | null => handle?.createPairing() ?? null,
    })
  } catch {
    /* 这一代宿主可能不支持 provide */
  }
  ctx.onDispose?.(() => handle?.stop())
}

function applyInner(ctx: LooseContext, injected: Partial<PluginConfig>): RuntimeHandle | undefined {
  const config = readConfig(injected)
  const clock = systemClock
  const status = new StatusFile(config.statusFile, clock)
  const problems = validateConfig(config)
  const log = (message: string, fields: Record<string, string | number | boolean | undefined> = {}): void => {
    try {
      process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: `dsh-remote-control ${message}`, ...fields })}\n`)
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

  const transport: RuntimeTransport = {
    reply(conversationId: string, payload: EvPayload): boolean {
      return relay ? relay.send(conversationId, payload) : false
    },
    broadcast(payload: EvPayload): void {
      relay?.broadcast(payload)
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
      },
      onPeerJoined: (conversationId) => {
        runtime?.start()
        void runtime?.pushSessions('peer-joined')
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
      },
    })
    runtime = new HostRuntime(port, transport, sleep, clock, {
      listingRefreshMs: config.listingRefreshSec * 1000,
      unarchiveOnPrompt: config.unarchiveOnPrompt,
      approvalTimeoutMs: config.approvalTimeoutSec * 1000,
      log: (message, fields) => log(message, fields),
    })
    relay.connect()
    if (config.pairOnStartSec > 0) publishPairing()
    status.start(() => state())
  }

  const publishPairing = (): { qr: string; token: string; psk: string; expiresAt: number } | null => {
    if (!relay) return null
    const slot = slots.create(config.pairTtlMs)
    relay.publishPairing(slot)
    const qr = buildPairingUri({ server: config.serverUrl, psk: slot.psk, hostLabel: config.hostLabel, token: slot.token })
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
      // token 永远不出现真值；这条有测试锁住。
      hostToken: undefined,
      hostTokenShape: config.hostToken ? redact(config.hostToken) : undefined,
      mockBridgeForced: config.mockBridge,
      problems: problems.map((problem) => `${problem.level}:${problem.field}`),
      ...(config.pairOnStartSec > 0 ? { pairOnStartWarn: 'status.json 里带着仍然有效的配对码与 PSK' } : {}),
    }
  }

  const active = { pairing: null as { qr: string; token: string; expiresAt: number } | null }
  function describeActivePairing(): Record<string, unknown> | null {
    const slot = slots.latest()
    if (!slot) return null
    return {
      token: slot.token,
      psk: slot.psk,
      expiresAt: new Date(slot.expiresAt).toISOString(),
      qr: active.pairing?.qr ?? '',
      ageSec: Math.max(0, Math.round((clock.now() - slot.createdAt) / 1000)),
    }
  }

  function relayState(): 'online' | 'connecting' | 'offline' {
    return lastRelayState
  }
  function relayProblem(): string | undefined {
    return lastRelayProblem
  }

  const wrappedPublish = (): ReturnType<typeof publishPairing> => {
    const created = publishPairing()
    if (created) active.pairing = { qr: created.qr, token: created.token, expiresAt: created.expiresAt }
    return created
  }

  const createPairing = (): ReturnType<typeof wrappedPublish> => wrappedPublish()

  // ── 载体探测：services > apiproxy > (mock) ─────────────────────────
  const collected: Record<string, unknown> = {}
  const hasServices = (): boolean => typeof collected.sessions === 'object' && collected.sessions !== null
  const apiProxyOf = (): unknown => collected.apiProxy

  let decided = false
  const tryStart = (): void => {
    if (decided || runtime) return
    if (hasServices()) {
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

  for (const name of SERVICE_NAMES) {
    try {
      const found = ctx.get?.(name, true)
      if (found) collected[name.toLowerCase()] = found
    } catch {
      /* 这一代宿主没这个服务 */
    }
    try {
      ctx.inject?.([name], ((...services: unknown[]) => {
        const value = services[0]
        if (!value) return
        // 晚到的服务热补丁进同一个对象：runtime 已经持有它的引用，不需要重启。
        Object.assign(collected, { [name.toLowerCase()]: value })
        tryStart()
      }) as never)
    } catch {
      /* inject 不可用就靠 get 的快照 */
    }
  }
  try {
    const proxy = ctx.get?.('apiProxy', true)
    if (proxy) collected.apiProxy = proxy
  } catch {
    /* desktop 态通常没注册 apiProxy */
  }
  try {
    ctx.inject?.(['apiProxy'], ((...services: unknown[]) => {
      if (!services[0]) return
      collected.apiProxy = services[0]
      if (!decided) {
        // 先不抢跑：等宽限期，让 services 有机会先到。
        clock.setTimeout(tryStart, config.carrierGraceMs)
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
    status.write({ ...state(), carrier: 'none', reason: 'no-carrier' })
    log('no kernel carrier available', { hint: '需要 sessions/apiProxy 服务，或把 mockBridge 打开做开发' })
  }

  // ── /drc 命令 ──────────────────────────────────────────────────────
  try {
    ctx.commands?.register?.({
      name: 'drc',
      description: 'DSH 远程控制：发布配对二维码、查看中继与内核接合状态',
      input: { hint: 'pair | status | unpair' },
      handler: async (invocation) => {
        const argument = String(invocation.rawInput ?? '').trim().toLowerCase()
        if (argument.startsWith('pair')) {
          const pairing = createPairing()
          if (!pairing) return { kind: 'text', text: '中继还没连上，暂时无法发布配对码。看 status.json 的 relayProblem。' }
          writePairingImage(pairing.qr, config, log)
          const terminal = await renderTerminalQr(pairing.qr, { style: config.qrStyle })
          return {
            kind: 'text',
            text: [
              `配对码 ${pairing.token}（${Math.max(0, Math.round((pairing.expiresAt - clock.now()) / 1000))} 秒内有效）`,
              '在小程序里扫码或手输这 6 位数字。',
              terminal,
            ].join('\n'),
          }
        }
        if (argument.startsWith('unpair')) {
          for (const id of relay?.conversationIds() ?? []) relay?.voidConversation(id)
          return { kind: 'text', text: '已解除所有配对；手机端会显示"主机已断开，请重新配对"。' }
        }
        return { kind: 'text', text: JSON.stringify(state(), null, 2) }
      },
    })
  } catch {
    /* 没有 commands 服务的代际：静默跳过，配对仍可由 pairOnStartSec 自动发布 */
  }

  return {
    config,
    state,
    createPairing,
    stop(): void {
      status.stop()
      runtime?.stop()
      relay?.stop()
      sleep.stop()
    },
  }
}

/**
 * PNG 优先：命令 API 只接受纯文本结果（没有图片/附件返回类型），
 * 所以把二维码写成文件并交给系统打开，比任何文本渲染都好扫。
 * 文本渲染保留作兜底（PNG 写不出来时仍能在终端里扫）。
 */
function writePairingImage(
  qrText: string,
  config: PluginConfig,
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void,
): void {
  if (!config.qrImage) return
  const file = pairingImagePath(config.statusFile)
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
        /* 打不开就算了：终端里仍有文本二维码 */
      })
    })
    .catch((error: unknown) => log('qr png render failed', { message: String((error as Error)?.message ?? error) }))
}

export { DEFAULT_CONFIG }
export { readConfig, validateConfig } from './shell/config.js'
export type { KernelPort, Clock } from './ports/index.js'
