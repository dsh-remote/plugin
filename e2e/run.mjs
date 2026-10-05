/**
 * run — 本地全链路端到端：真中继 + 真插件运行时（内核面用 mock）+ **真小程序客户端代码**。
 *
 * 三个真实（照 docs/legacy-spec/testing-and-tooling.md §2 的纪律；把"线上中继 + 真内核"
 * 换成"本地中继 + mock 内核面"的那一条由 `e2e/live-e2e.mjs` 负责，不在本文件里）：
 *
 * 1. **真中继**：spawn `dsh-remote-server/dist/src/main.js` 这个真实进程，不是内存替身。
 * 2. **真插件运行时**：调用 `dsh-remote-control/packages/plugin/dist/src/index.js` 的 `apply(ctx, injected)`
 *    真实入口（cordis 的 ctx 是假的——本机没有内核可挂）。`mockBridge: true` 让它挂
 *    `platform/mock-kernel.ts`，因此**会话 id 一律 `ses_mock*`**：这里证明的是"链路通"，
 *    绝不证明"内核通"。所有步骤输出都把这句话说在明处。
 * 3. **真小程序客户端**：`e2e/mp-sim.mjs` 把 `dsh-remote-mp/miniprogram/core/{codec,session-store,client,env,socket}.js`
 *    原文件加载进 Node 驱动。这里没有任何"测试专用客户端"。
 *
 * 两条观察缝（都不替换被测组件，只是把已经在线上跑的字节抄一份下来看）：
 * - `installFrameTap()`：包住 `ws` 的 send / message，抓进程内每一条 socket 帧，按
 *   "是不是手机那几个 socket 之一"分侧。主机侧的 `pair-ready` / `peer-joined` 只有这条看得到。
 * - `installKernelCapture()`：抓住 `apply()` 内部创建的那个 mock 内核实例，用来触发
 *   **内核发起**的提问与流式增量（`askQuestion` / `feed` 是 mock 载体自带的冒烟钩子）。
 *   抓不到就立刻红，绝不静默降级（红线：不许拿不到真实材料就换替身并通过）。
 *
 * 用法：`node e2e/run.mjs`。本文件同时是三个 `*.test.mjs` 的公共装置（被 import 时不自跑）。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import WebSocket from 'ws'
import { createRecorder, installWxShim, loadMpModules, until, traceOf } from './mp-sim.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.join(here, '..')
export const RELAY_MAIN = path.join(ROOT, 'dsh-remote-server', 'dist', 'src', 'main.js')
export const PLUGIN_ENTRY = path.join(ROOT, 'dsh-remote-control', 'packages', 'plugin', 'dist', 'src', 'index.js')
export const MOCK_KERNEL_ENTRY = path.join(
  ROOT,
  'dsh-remote-control',
  'packages',
  'plugin',
  'dist',
  'src',
  'platform',
  'mock-kernel.js',
)
/** 指令正文：含中文词，用于"这个词绝不出现在任何一帧里"的审计。 */
export const PROMPT_TEXT = '请把本周的运维情况整理成一份周报，只给三行结论'
export const PROMPT_KEYWORDS = ['周报', '运维情况']
/** 小程序会发的 6 种 cmd 的名字（mp-client-contract §1.2）：明文绝不该出现在中继经手的帧里。 */
export const CMD_LITERALS = [
  'cmd.list_sessions',
  'cmd.send_prompt',
  'cmd.interrupt',
  'cmd.resolve_permission',
  'cmd.answer',
  'cmd.keep_awake',
]
/** mock 内核的会话 id（不是 DSH 真会话；这一步的诚实前提就写在这里）。 */
export const MOCK_SESSION_ID = 'ses_mock_idle'

export const HOST_TOKEN = 'e2e-local-host-token-0123456789abcdef'
const SESSION_STATES = ['idle', 'running', 'detached', 'archived', 'awaiting-permission', 'awaiting-answer']
const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

// ── 输出 ─────────────────────────────────────────────────────────────

let stepNumber = 0
export function step(title) {
  stepNumber += 1
  process.stdout.write(`\n${stepNumber}. ${title}\n`)
  return stepNumber
}
export function note(line) {
  process.stdout.write(`   · ${line}\n`)
}

// ── 小工具 ───────────────────────────────────────────────────────────

export async function pickFreePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** 构建竞态兜底：另一个 agent 会同时重建 protocol/plugin 产物，可能把 dist 短暂清空。 */
async function importBuildArtifact(file, label, attempts = 4) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await import(pathToFileURL(file).href)
    } catch (error) {
      lastError = error
      const missing = /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/.test(String(error?.message))
      if (!missing || attempt === attempts) break
      note(`${label} 暂时取不到（${String(error.message).split('\n')[0]}），2s 后重试——像是有并发构建正在清空 dist`)
      await delay(2000)
    }
  }
  throw new Error(
    `加载${label}失败：${String(lastError?.message ?? lastError)}\n` +
      // 三棵源码仓是**彼此独立的 pnpm workspace**，伞仓的 workspace 里只有 e2e，
      // 所以这里不能再写 `pnpm --filter X build`（那个 filter 在伞仓根本匹配不到包）。
      '  先逐仓构建：cd dsh-remote-protocol && env -u NODE_OPTIONS pnpm build；' +
      'cd ../dsh-remote-control && env -u NODE_OPTIONS pnpm -r build；' +
      'cd ../dsh-remote-server && env -u NODE_OPTIONS pnpm build',
  )
}

export function frameT(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ── 观察缝 1：进程里**每一副本** ws 的帧抓取 ──────────────────────────

/**
 * 为什么这里要装"多副本"：私有树时期 e2e 与插件同属一个 pnpm workspace，`ws` 去重成同一个
 * 物理文件，本文件 `import 'ws'` 拿到的类对象就是插件用的那个，补丁打一次两侧都看得见。
 * 开源改造后插件住在 `dsh-remote-control/`（独立 workspace、独立 store），它解析到的是
 * `dsh-remote-control/node_modules/.pnpm/ws@8.22.0/…`，与 e2e 那份是**两个不同的类对象**——
 * `WebSocket.prototype` 上的补丁对它完全无效。表现极有迷惑性：中继日志里 `pair token issued`
 * 在跳（说明 pair-begin 真的发出去了、配对码真的建了），而 e2e 断言却报"主机没发 hello /
 * 等不到 pair-ready"，`tap.frames` 甚至是空的。那是**装置坏了**，不是产品坏了。
 *
 * 取副本按"被测产物实际解析到的位置"取（`createRequire(PLUGIN_ENTRY).resolve('ws')`），
 * 不写死 store 路径：产物搬家这里自动跟上。解析不到就抛，绝不静默少装——少装一份等于
 * 把主机侧断言全变成"看不到帧"，而最坏的一种通过就是绿得没有依据。
 */
const tapMarker = Symbol.for('drc.e2e.frameTap.patched')

export const tap = { frames: [], installed: false, phoneSocketLists: [], patched: [] }

function patchWsClass(cls, label) {
  const proto = cls?.prototype
  if (!proto || proto[tapMarker] === true) return false
  const originalSend = proto.send
  const originalEmit = proto.emit
  proto.send = function patchedSend(data, ...rest) {
    tap.frames.push({ side: sideOf(this), dir: 'sent', raw: String(data), at: Date.now() })
    return originalSend.call(this, data, ...rest)
  }
  proto.emit = function patchedEmit(event, ...args) {
    if (event === 'message') {
      const raw = Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : String(args[0])
      tap.frames.push({ side: sideOf(this), dir: 'received', raw, at: Date.now() })
    }
    return originalEmit.apply(this, [event, ...args])
  }
  Object.defineProperty(proto, tapMarker, { value: true, enumerable: false, configurable: true })
  tap.patched.push(label)
  return true
}

export function installFrameTap() {
  if (tap.installed) return tap
  // ① 本文件这份：手机侧（mp-sim 的 `wx.connectSocket`）用的就是它。
  patchWsClass(WebSocket, 'e2e 自身（手机 shim）')
  // ② 插件产物解析到的那份：主机侧的帧只有装了补丁才看得见。
  const requireFromPlugin = createRequire(PLUGIN_ENTRY)
  let pluginModule
  try {
    pluginModule = requireFromPlugin('ws')
  } catch (error) {
    throw new Error(
      `装帧抓取失败：从 ${PLUGIN_ENTRY} 解析 'ws' 不通过（${String(error?.message ?? error)}）。` +
        '要么插件的依赖没装（cd dsh-remote-control && env -u NODE_OPTIONS pnpm install），要么产物位置又变了。',
    )
  }
  patchWsClass(pluginModule?.WebSocket ?? pluginModule, '插件产物（dsh-remote-control）')
  // 判据写成"两侧各自用的类都带补丁标记"，而不是"装了几份"：
  // 若哪天 pnpm 把两份 ws 去重成同一个物理文件，只数份数会假红一次（而那份数本身也不是产品事实）。
  assert.equal(
    WebSocket.prototype[tapMarker],
    true,
    '手机侧用的 ws 类没被装上帧抓取——手机侧断言将全部没有依据',
  )
  assert.equal(
    (pluginModule?.WebSocket ?? pluginModule).prototype[tapMarker],
    true,
    '主机侧（插件产物）用的 ws 类没被装上帧抓取——主机侧断言将全部没有依据',
  )
  tap.installed = true
  return tap
}

function sideOf(socket) {
  for (const list of tap.phoneSocketLists) {
    if (list.includes(socket)) return 'phone'
  }
  return 'host'
}

export function tappedFrames(side, dir) {
  return tap.frames.filter((f) => (!side || f.side === side) && (!dir || f.dir === dir))
}

/** 某一侧"交给中继"的帧文本（零知识审计的对象必须是这一类）。 */
export function outboundToRelay(side) {
  return tappedFrames(side, 'sent').map((f) => f.raw)
}

export function controlFrames(side, dir, names) {
  return tappedFrames(side, dir)
    .map((f) => frameT(f.raw))
    .filter((f) => f && names.includes(f.t))
}

// ── 观察缝 2：抓住 apply() 内部创建的 mock 内核 ───────────────────────

export const kernels = []
let captureInstalled = false

export async function installKernelCapture() {
  if (captureInstalled) return kernels
  const module = await importBuildArtifact(MOCK_KERNEL_ENTRY, 'mock 内核模块')
  assert.equal(typeof module.MockKernel, 'function', 'mock-kernel 必须导出 MockKernel 类')
  const originalSubscribe = module.MockKernel.prototype.subscribe
  module.MockKernel.prototype.subscribe = function captured(onEvent) {
    kernels.push(this)
    return originalSubscribe.call(this, onEvent)
  }
  captureInstalled = true
  return kernels
}

/** 第 n 个内核实例；没抓到就是装置坏了，必须红而不是跳过。 */
export function kernelAt(index) {
  const kernel = kernels[index]
  assert.ok(kernel, `没抓到第 ${index + 1} 个 mock 内核实例（subscribe 钩子失效，或 runtime 根本没启动）`)
  return kernel
}

// ── 真中继 ───────────────────────────────────────────────────────────

export async function startRelay({ port, env = {}, label = '中继' } = {}) {
  installFrameTap()
  const chosen = port ?? (await pickFreePort())
  const child = spawn(process.execPath, [RELAY_MAIN], {
    env: {
      ...process.env,
      DRC_HOST_TOKEN: HOST_TOKEN,
      DRC_PORT: String(chosen),
      DRC_BIND: '127.0.0.1',
      DRC_LOG_LEVEL: 'info',
      DRC_SWEEP_MS: '1000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const logLines = []
  const stderr = []
  const exit = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  let pending = ''
  let earlyExit = null
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  child.on('exit', (code, signal) => {
    earlyExit = { code, signal }
  })
  const collectLine = (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) if (line) logLines.push(line)
  }
  child.stdout.on('data', collectLine)
  /**
   * 端口确认有两条路：
   * 1. 解析 `relay listening` 那行（默认 info 级，能拿到 DRC_PORT=0 时系统分配的端口）；
   * 2. 拿不到就把固定端口问一遍 `/healthz`（`DRC_LOG_LEVEL=warn` 时第 1 条必然没有）。
   * 两条都失败才算起不来，并把 stdout/stderr 一起报出来。
   */
  async function resolvePort() {
    const deadline = Date.now() + 6000
    while (Date.now() < deadline) {
      if (earlyExit) break
      const line = logLines.find((entry) => entry.includes('"relay listening"'))
      if (line) {
        const record = frameT(line)
        if (record?.port) return record.port
      }
      try {
        const response = await fetch(`http://127.0.0.1:${chosen}/healthz`, { signal: AbortSignal.timeout(500) })
        if (response.status === 200) return chosen
      } catch {
        /* 还没起来 */
      }
      await delay(50)
    }
    throw new Error(
      `${label} 起不来（端口 ${chosen}）：exit=${JSON.stringify(earlyExit)} stdout=${JSON.stringify(logLines.slice(-6))} stderr=${JSON.stringify(stderr)}`,
    )
  }
  const actualPort = await resolvePort().catch((error) => {
    child.kill('SIGKILL')
    throw error
  })
  const url = `ws://127.0.0.1:${actualPort}`
  const handle = {
    label,
    port: actualPort,
    url,
    logLines,
    stderr,
    child,
    async health() {
      const response = await fetch(`http://127.0.0.1:${actualPort}/healthz`)
      assert.equal(response.status, 200, `${label} /healthz 应当返回 200`)
      return await response.json()
    },
    stop(signal = 'SIGTERM') {
      child.kill(signal)
      return exit
    },
    exited: exit,
  }
  const health = await handle.health()
  assert.equal(health.ok, true, `${label} /healthz 必须 ok:true（收到 ${JSON.stringify(health)}）`)
  return handle
}

// ── 真插件运行时（内核面 = mock）─────────────────────────────────────

/** 路由回答尽力按 JSON 解析；解析不动就原样给字符串（断言要能印出来说话）。 */
function safeJson(chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** 一版码的标识：URI 文本的 sha256 前 16 位。与插件里 `pairingEpoch` 同一口径（两处各写一遍，
 * 对不上就是 e2e 与产物在骗同一个 epoch）。 */
function sha256_16(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

let hostSequence = 0

export async function bootHost({
  relayUrl,
  hostId,
  statusDir,
  pairTtlMs = 60_000,
  approvalTimeoutSec = 30,
  /**
   * 密钥簿落盘路径。默认 `''` = 跟着 statusFile 走（真机行为，见 src/shell/pair-store.ts）。
   * 传 `'off'` 关掉，用于对照"重启后必须重新扫码"的旧行为。
   *
   * **这个入参存在的理由**：默认开启落盘之后，"主机重启"这一族用例的判据整个翻了个面
   * （不再 needs-pair，而是同一条 convId 继续用）。不提供关掉的开关，就再也钉不住
   * 落盘关闭时那条路**仍然**是干净的 —— 那正是有人会误以为"落盘顺手修好了静默黑洞"的场景。
   */
  pairStoreFile = '',
  /**
   * 自动发码间隔秒。默认 0（关）——与真机默认配置一致，且开着它会让"屏幕上永远有码"
   * 干扰冒烟步骤。配对窗口这一族用例（离线重连/退出配对后码还能不能用）要传 > 0。
   */
  pairOnStartSec = 0,
} = {}) {
  installFrameTap()
  await installKernelCapture()
  const kernelCountBefore = kernels.length
  const { apply } = await importBuildArtifact(PLUGIN_ENTRY, '插件入口 apply()')
  assert.equal(typeof apply, 'function', '插件必须导出 apply(ctx, injected)')

  const provided = {}
  /**
   * 注册出去的**命令**个数。`/drc` 整条已删（2026-10-03），所以这里必须恒为 0——
   * 留着它不是"还能注册"，而是钉住"命令注册这条路上不该再有东西"。
   */
  let commandCount = 0
  const disposers = []
  /**
   * 假 `webServer`：状态栏那颗 pill 的四条路由要挂在它上面（宿主没这个服务时那一半整个不起）。
   * 这里给一个真的注册表，是为了让本链路能**带着真中继在线**去点那四条——
   * 单测里的发码分支永远是"中继不可达"，那条路在 e2e 之前从没被走过。
   */
  const routes = new Map()
  const context = {
    get: (name) =>
      name === 'webServer'
        ? {
            register: (route) => {
              routes.set(route.path, route)
              return () => routes.delete(route.path)
            },
          }
        : undefined,
    inject: () => undefined,
    provide: (name, value) => {
      provided[name] = value
    },
    commands: {
      register: () => {
        commandCount += 1
      },
    },
    on: () => () => undefined,
    off: () => undefined,
    onDispose: (fn) => disposers.push(fn),
  }
  hostSequence += 1
  const statusFile = path.join(statusDir ?? path.join(os.tmpdir(), 'drc-e2e'), `host-${process.pid}-${hostSequence}.json`)
  const id = hostId ?? `e2e_host_${process.pid.toString(36)}_${hostSequence}`

  apply(context, {
    enabled: true,
    serverUrl: relayUrl,
    hostToken: HOST_TOKEN,
    hostId: id,
    hostLabel: 'e2e-mock-host',
    mockBridge: true,
    statusFile,
    // 下面两条是这套装置的前提，不是可调项：自动发码一开，「屏幕上永远有一张码」就不再是
    // 「点一下配对」那条路径，冒烟步骤会互相干扰；防休眠在 CI 上更不许真去 caffeinate。
    // 以前它们是 bootHost 的入参，而没有任何调用点传过。
    pairOnStartSec,
    pairTtlMs,
    keepAwake: { enabled: false, idleReleaseSec: 300, keepDisplay: false },
    listingRefreshSec: 15,
    carrierGraceMs: 1000,
    approvalTimeoutSec,
    unarchiveOnPrompt: true,
    // 落盘路径必须显式传下去（含 `''` 与 `'off'` 两个值）：不传就用 apply() 的默认，
    // 那这条用例就分不清"落盘生效了"与"参数根本没送到"。
    pairStoreFile,
  })

  const service = provided.dshRemoteControl
  assert.ok(service, 'apply() 必须 provide("dshRemoteControl")，否则外部拿不到 createPairing')
  const state = () => service.state
  await until(() => state().relay === 'online', {
    timeoutMs: 12_000,
    label: '插件连上中继（状态快照 relay=online）',
    trail: [{ kind: 'host-state', status: JSON.stringify(state()).slice(0, 200) }],
  })
  assert.equal(state().carrier, 'mock', '本链路挂的是 mock 内核面，carrier 必须是 mock')
  assert.equal(state().mockBridgeForced, true)
  assert.equal(state().hostToken, undefined, '状态快照绝不能带出 host token 真值')
  assert.ok(!JSON.stringify(state()).includes(HOST_TOKEN), '状态快照序列化后不得含 token')

  return {
    hostId: id,
    state,
    /** 注册出去的命令个数：恒为 0（`/drc` 已删）。 */
    commandCount: () => commandCount,
    /** 主机发布一张新配对码（真 relay-client → 中继 pair-begin）。 */
    createPairing() {
      const pairing = service.createPairing()
      assert.ok(pairing, 'createPairing() 返回 null：中继还没连上')
      assert.match(pairing.qr, /^dshr:\/p\?/, '配对 URI 必须以 dshr:/p? 开头（红线 21）')
      assert.match(pairing.token, /^\d{6}$/, '配对码必须是 6 位数字')
      return pairing
    },
    kernelIndex: kernelCountBefore,
    kernel() {
      return kernelAt(kernelCountBefore)
    },
    /** pill 挂上去的那四条路由（路径 → {kind, path, handler}）。 */
    pillRoutes: routes,
    /**
     * 打一条 pill 路由：真 handler、真 req/res 对，返回 {status, headers, body}。
     * `body` 对 JSON 是解析过的对象，对图片是 Buffer。
     */
    async callPill(path, { method = 'GET', headers } = {}) {
      const route = routes.get(path)
      assert.ok(route?.handler, `pill 路由 ${path} 没挂上（挂上的：${[...routes.keys()].join(', ') || '无'}）`)
      // 浏览器发出的每一条请求都必然带 `Host`，环回守卫判的就是它——所以这里默认给一个，
      // 让"忘了传"不至于伪装成"守卫把合法请求拒了"。
      const requestHeaders = { host: '127.0.0.1:19387', ...(headers ?? {}) }
      let status = 0
      let headersOut = {}
      let chunk
      const response = {
        writeHead(code, extra) {
          status = code
          headersOut = { ...(extra ?? {}) }
          return response
        },
        end(data) {
          chunk = data
          return response
        },
      }
      await route.handler({ method, url: path, headers: requestHeaders }, response)
      const isImage = String(headersOut['Content-Type'] ?? '').startsWith('image/')
      return {
        status,
        headers: headersOut,
        body: isImage ? Buffer.from(chunk ?? []) : safeJson(chunk),
        raw: Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? '')),
      }
    },
    stop() {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 停机尽力而为，不掩盖主断言 */
        }
      }
    },
  }
}

// ── 真小程序客户端 ───────────────────────────────────────────────────

let phoneRig
export function installPhoneRig() {
  if (phoneRig) return phoneRig
  installFrameTap()
  const recorder = createRecorder()
  const shim = installWxShim({ recorder })
  // 顺序硬要求：先装 wx shim，再加载 dsh-remote-mp/miniprogram/core（mp-sim 的注释里写了为什么）。
  const mp = loadMpModules()
  assert.equal(typeof mp.client.DrcClient, 'function', '必须加载到真实 dsh-remote-mp/miniprogram/core/client.js 的 DrcClient')
  assert.equal(typeof mp.codec.parsePairingQr, 'function', '必须加载到真实 dsh-remote-mp/miniprogram/core/codec.js')
  tap.phoneSocketLists.push(shim.sockets)
  phoneRig = { mp, recorder, shim }
  return phoneRig
}

export function newPhone(label = '手机') {
  const { mp, recorder } = installPhoneRig()
  const client = new mp.client.DrcClient()
  client.hydrate()
  const events = []
  const sent = []
  const cmds = []
  client.on((event) => events.push(event))
  const trail = traceOf(client)
  // live-e2e 同款机制（testing-and-tooling §2.5）：包住 sendControl，
  // 把每一个"交给中继的帧"录下来——审计只能盯这一份。
  const originalSendControl = client.sendControl.bind(client)
  client.sendControl = (frame) => {
    sent.push({ at: Date.now(), raw: JSON.stringify(frame), frame: JSON.parse(JSON.stringify(frame)) })
    return originalSendControl(frame)
  }
  // 出站 cmd 的明文侧写：sendCmd 会先把 cmdId 补进对象再密封，所以快照在调用之后取。
  // 只用来做"字段级要求"的断言（decision 逐字、answers 形状、idleReleaseSec 该不该在）；
  // 零知识审计的对象永远是上面的 sent（真正交给中继的那一帧）。
  const originalSendCmd = client.sendCmd.bind(client)
  client.sendCmd = (cmd) => {
    const ok = originalSendCmd(cmd)
    cmds.push({ at: Date.now(), cmd: JSON.parse(JSON.stringify(cmd)), sentOk: ok })
    return ok
  }
  const phone = {
    label,
    mp,
    client,
    recorder,
    events,
    trail,
    sent,
    cmds,
    get convId() {
      return client.convId
    },
    get status() {
      return client.status
    },
    payloads(type) {
      return events.filter((e) => e.kind === 'payload' && (!type || e.payload.t === type)).map((e) => e.payload)
    },
    lastPayload(type) {
      const list = phone.payloads(type)
      return list[list.length - 1]
    },
    async waitForStatus(status, what, timeoutMs = 8000) {
      await until(() => client.status === status, { timeoutMs, trail, label: `${what}（手机 status=${status}）` })
      return client
    },
    /**
     * 等到某条载荷到达。`after` 是"这种类型此前已知的条数"——
     * 没有它，任何"等一条新事件"的断言都可能被上一轮的旧事件满足（假绿）。
     */
    async waitForPayload(type, what, { timeoutMs = 8000, where, after = 0 } = {}) {
      const matched = () => phone.payloads(type).slice(after).filter((p) => (where ? where(p) : true))
      await until(() => matched().length > 0, { timeoutMs, trail, label: `${what}（${type}，跳过前 ${after} 条）` })
      const list = matched()
      return list[list.length - 1]
    },
    /** 这种载荷当前已有多少条（配对 `waitForPayload` 的 `after`）。 */
    count(type) {
      return phone.payloads(type).length
    },
    /** 还挂着、手机没答的审批请求（收尾时要结掉）。 */
    pendingPermissions() {
      const answered = new Set(phone.cmds.filter((c) => c.cmd.t === 'cmd.resolve_permission').map((c) => c.cmd.requestId))
      return phone.payloads('ev.permission_request').filter((p) => !answered.has(p.requestId))
    },
    settlePermissions() {
      const pending = phone.pendingPermissions()
      for (const request of pending) phone.client.resolvePermission(request.sessionId, request.requestId, 'reject')
      return pending.length
    },
    /** 等到中继/主机发来某一类明文控制帧。 */
    async waitForControl(name, what, { timeoutMs = 8000 } = {}) {
      const seen = () => controlFrames('phone', 'received', [name])
      await until(() => seen().length > 0, { timeoutMs, trail, label: `${what}（明文帧 ${name}）` })
      const list = seen()
      return list[list.length - 1]
    },
    close() {
      try {
        client.disconnect()
      } catch {
        /* 已经断了 */
      }
    },
  }
  return phone
}

/** 手机扫码配对：用真实 parsePairingQr 解 QR → connect → online。 */
export async function pairPhone(host, phone, { pairing, expectedRelayUrl } = {}) {
  const used = pairing ?? host.createPairing()
  const parsed = phone.mp.codec.parsePairingQr(used.qr)
  assert.ok(parsed, '真实 parsePairingQr 必须能解出这张二维码')
  assert.equal(parsed.token, used.token, '二维码内嵌的 t= 必须就是主机发布的那张码')
  assert.equal(parsed.psk, used.psk, '二维码里的 PSK 必须与主机本地那张一致（PSK 从不上网）')
  if (expectedRelayUrl) assert.equal(parsed.server, expectedRelayUrl, '二维码里的中继地址必须就是我们要打的那个')
  phone.client.connect({ server: parsed.server, psk: parsed.psk, token: parsed.token })
  await phone.waitForStatus('online', '配对完成', 12_000)
  return { pairing: used, parsed }
}

/**
 * 收尾：先结掉挂起的审批，再停机。
 *
 * 这个顺序是有意义的，不是洁癖：如果挂起的审批是在 `host.stop()` 的瞬间才被结算，
 * `KeepAwake.stop()` 之后的 `releaseHold() → evaluate() → ensureTimer()` 会再装一个
 * 10 秒自循环定时器，而 `stop()` 有 `stopped` 守卫、之后再也清不掉 —— 进程永不退出
 * （本次回报的源码 bug 之一，取证 dsh-remote-control/packages/plugin/src/core/sleep-policy.ts:136-141、156-162）。
 * 装置按"先结清、再停机"避开它，而不是把挂起态留到最后一步。
 */
export async function shutdown({ phone, host, relay } = {}) {
  const settled = phone ? phone.settlePermissions() : 0
  if (settled > 0) await delay(400)
  if (phone) phone.close()
  if (host) host.stop()
  const relayExit = relay ? await relay.stop() : { code: null, signal: null }
  return { settledPermissions: settled, relayExit }
}

/**
 * `until()` 的异步判定版（要轮询 `/healthz` 这类异步事实时用）。
 * 失败同样打印事件轨迹——"红了但不知道为什么红"最贵。
 */
export async function untilAsync(predicate, { timeoutMs = 10_000, intervalMs = 100, label = '条件', trail = [] } = {}) {
  const at = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - at > timeoutMs) {
      const tail = trail.slice(-8).map((entry) => `${entry.kind ?? entry.t ?? ''}:${entry.status ?? entry.text ?? ''}`)
      throw new Error(`等不到${label}（${timeoutMs}ms）。事件轨迹：[${tail.join(' | ')}]`)
    }
    await delay(intervalMs)
  }
}

export function trailDump(phone, limit = 14) {
  return phone.trail
    .slice(-limit)
    .map((entry) => `${entry.kind ?? entry.t}:${entry.status ?? entry.text ?? ''}`)
    .join(' | ')
}

/**
 * `Promise.race` 的卫生版：超时那一发**在胜负分晓后一定被撤掉**。
 *
 * 为什么不能直接写 `await Promise.race([p, delay(ms)])`：`Promise.race` 只认先到的结果，
 * **不会取消输家**。`delay(ms)` 的定时器是 ref 着的，于是进程要一直等到它自然到期——
 * 实测代价就是"1.3s 打完全绿、进程 ~10s 后才退出"，而拖尾的正是提问卡那一步输掉的
 * `delay(10_000)`（它走 `node:timers/promises`，连包 global.setTimeout 的探针都看不见）。
 *
 * 产品侧同款写法在 `dsh-remote-control/packages/plugin/src/platform/carrier-services.ts` 的 `withTimeout`：
 * 那里 `finally` 里清了，所以没有这个问题——e2e 这边漏了，补齐。
 */
export async function raceWithTimeout(promise, ms) {
  let timer
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ── 零知识帧审计 ─────────────────────────────────────────────────────

/**
 * 零知识审计（禁止空判定）：
 * - `enc` 帧数量下界（一帧都没发也能"通过"的审计是假的）
 * - 每帧密文解出的字节 > minCipherBytes，并且必须是标准 base64（能字节级往返）
 * - 每帧：明文 JSON 文本里不含业务字面量；解出的字节里不含业务字面量的 UTF-8 / latin1 序列
 * - 整段观测帧序列 JSON 化后不含正文中文关键词
 * - 反证：同一批关键词必须能在"明文样本"里抓到，否则这条断言是空判定
 */
export function auditZeroKnowledge({
  outbound,
  observed,
  minEnc = 10,
  minCipherBytes = 40,
  forbidden = [...CMD_LITERALS, ...PROMPT_KEYWORDS],
  plaintextSample,
} = {}) {
  const encFrames = []
  for (const raw of outbound) {
    const frame = frameT(raw)
    assert.ok(frame, `发给中继的帧不是合法 JSON：${raw.slice(0, 120)}`)
    if (frame.t === 'enc') encFrames.push(frame)
    const leaked = forbidden.filter((word) => raw.includes(word))
    assert.deepEqual(leaked, [], `发给中继的帧里出现了业务字面量 ${leaked.join('/')}：${raw.slice(0, 160)}`)
  }
  assert.ok(
    encFrames.length >= minEnc,
    `只看到 ${encFrames.length} 帧发给中继的 enc 密文，下界是 ${minEnc}——帧数不足时这条审计等于没做`,
  )
  let smallest = Number.POSITIVE_INFINITY
  for (const frame of encFrames) {
    assert.match(frame.ciphertext, STANDARD_BASE64, `密文不是标准 base64（红线 1）：${String(frame.ciphertext).slice(0, 40)}`)
    const bytes = Buffer.from(frame.ciphertext, 'base64')
    assert.equal(bytes.toString('base64'), frame.ciphertext, 'base64 必须能字节级往返')
    smallest = Math.min(smallest, bytes.length)
    assert.ok(
      bytes.length > minCipherBytes,
      `有一帧密文解出只有 ${bytes.length}B（下界 ${minCipherBytes}B）——太短等于没有载荷：${frame.ciphertext.slice(0, 40)}`,
    )
    for (const word of forbidden) {
      const asUtf8 = Buffer.from(word, 'utf8')
      assert.equal(bytes.indexOf(asUtf8), -1, `密文解出的字节里含"${word}"的 UTF-8 序列——它没被加密`)
      // latin1 只对**足够长**的序列才有判定力。汉字经 latin1 编码会压成 2 字节
      // （每码点取低 8 位："周报" → 68 A5），而 2 字节序列在几百字节的**随机**密文里
      // 有约 N/65536 的概率被撞上 —— 18 帧累计 1~3%，实测撞过一次（偏移 30），
      // 报出来却是"它没被加密"，纯假红。UTF-8 那条已覆盖中文词（每字 3 字节，
      // 撞上概率 2^-48 量级），所以短序列跳过 latin1 不损失任何判定力。
      const asLatin1 = Buffer.from(word, 'latin1')
      if (asLatin1.length >= 4) {
        assert.equal(bytes.indexOf(asLatin1), -1, `密文解出的字节里含"${word}"的 latin1 序列——它没被加密`)
      }
    }
  }
  const observedText = JSON.stringify(observed)
  for (const word of PROMPT_KEYWORDS) {
    assert.equal(observedText.includes(word), false, `整段观测帧序列里出现了正文关键词"${word}"`)
  }
  if (plaintextSample !== undefined) {
    const sample = typeof plaintextSample === 'string' ? plaintextSample : JSON.stringify(plaintextSample)
    const caught = forbidden.filter((word) => sample.includes(word))
    assert.ok(caught.length > 0, `关键词在明文样本里一个都不含——这条审计是空判定：${sample.slice(0, 120)}`)
  }
  return { encFrames: encFrames.length, smallestCipherBytes: smallest, forbiddenChecked: forbidden.length }
}

/** 中继日志的零知识取证：一行一条 JSON，只允许 id / 计数 / reason 这类字段。 */
export function auditRelayLogs(relay, { forbidden = [...CMD_LITERALS, ...PROMPT_KEYWORDS] } = {}) {
  const text = relay.logLines.join('\n')
  for (const word of forbidden) {
    const line = text.split('\n').find((entry) => entry.includes(word))
    assert.equal(line, undefined, `中继日志里出现了业务明文"${word}"：${line}`)
  }
  return relay.logLines.length
}

// ── 载荷/字段级断言辅助 ───────────────────────────────────────────────

/**
 * F7：会话行渲染。逐字照抄 `dsh-remote-mp/miniprogram/pages/sessions/sessions.js:9-16、129-142` 的表达式，
 * 特别是 `s.updatedAt.slice(11, 19)`——它就是"数字时间戳会让整屏列表静默不更新"的那一行。
 */
export function renderSessionRow(s) {
  const badge = (state, running) => {
    if (state === 'awaiting-permission') return '待审批'
    if (state === 'awaiting-answer') return '待回答'
    if (state === 'archived') return '已归档'
    if (state === 'detached') return '未加载'
    if (state === 'running' || running) return '运行中'
    return '空闲'
  }
  return {
    id: s.id,
    title: s.title || s.id,
    workspace: s.workspace || '',
    badgeText: badge(s.state, s.running),
    updatedAt: s.updatedAt ? s.updatedAt.slice(11, 19) : '',
  }
}

/** F7 字段级契约：id 必填、state 在枚举内、updatedAt 只能是 ISO 字符串或不下发。 */
export function assertSessionShape(sessions, { label = 'ev.session_changed.sessions' } = {}) {
  assert.ok(Array.isArray(sessions) && sessions.length > 0, `${label} 必须是非空数组，收到 ${JSON.stringify(sessions)?.slice(0, 160)}`)
  for (const session of sessions) {
    assert.equal(typeof session.id, 'string', `${label}[].id 必须是字符串`)
    assert.ok(session.id.length > 0, `${label}[].id 不能是空串`)
    if (session.state !== undefined) {
      assert.ok(SESSION_STATES.includes(session.state), `${label}[].state=${JSON.stringify(session.state)} 不在枚举 ${SESSION_STATES.join('/')} 内`)
    }
    if (session.updatedAt !== undefined) {
      assert.equal(
        typeof session.updatedAt,
        'string',
        `${label}[].updatedAt 必须是 ISO 字符串，收到 ${typeof session.updatedAt}=${JSON.stringify(session.updatedAt)}；手机的表现是"列表静默不更新"`,
      )
      assert.equal(/^\d+$/.test(session.updatedAt), false, `${label}[].updatedAt 像是数字时间戳的字符串形态：${session.updatedAt}`)
    }
    assert.ok(renderSessionRow(session).title.length > 0, `${label}[].title 渲染后不能为空`)
  }
  return sessions
}

/** F8：会话列表的唯一数据源是 ev.session_changed，不是 ev.result.data.sessions。 */
export function assertListPushed({ resultPayload, sessionChangedPayload, cmdId, label = 'cmd.list_sessions' }) {
  assert.ok(
    sessionChangedPayload,
    `只收到 ev.result 而没收到 ev.session_changed —— F8 违约：${label} 之后主机必须额外推一次列表快照`,
  )
  assert.ok(Array.isArray(sessionChangedPayload.sessions), 'ev.session_changed.sessions 必须是数组')
  if (resultPayload) {
    assert.equal(resultPayload.ok, true, `${label} 回执 ok:false：${resultPayload.message ?? ''}`)
    assert.equal(resultPayload.cmdId, cmdId, 'ev.result.cmdId 必须原样回传（对答靠它匹配）')
  }
}

// ── 主脚本 ───────────────────────────────────────────────────────────

export async function main() {
  const started = Date.now()
  const workDir = path.join(os.tmpdir(), `drc-e2e-run-${process.pid}`)
  mkdirSync(workDir, { recursive: true })
  let relay = null
  let host = null
  let phone = null
  let failures = 0

  const run = async (title, fn) => {
    step(title)
    try {
      await fn()
      process.stdout.write('   ✓\n')
    } catch (error) {
      failures += 1
      process.stdout.write(`   ✗ ${String(error?.message ?? error).split('\n').join('\n     ')}\n`)
      if (phone) process.stdout.write(`     事件轨迹：${trailDump(phone, 24)}\n`)
    }
  }

  try {
    await run('起真中继（dsh-remote-server/dist/src/main.js）并证明 /healthz 可达', async () => {
      relay = await startRelay({ env: { DRC_SWEEP_MS: '1000' }, label: '本地中继' })
      const health = await relay.health()
      note(`中继 ${relay.url}：hosts=${health.hosts} clients=${health.clients} conversations=${health.conversations} version=${health.version}`)
    })

    await run('起真插件运行时（真 apply() 入口 + mockBridge；内核面是 mock，不是真内核）', async () => {
      host = await bootHost({ relayUrl: relay.url, hostId: 'e2e_run_host', statusDir: workDir, pairTtlMs: 60_000 })
      const health = await relay.health()
      assert.equal(health.hosts, 1, `中继必须正好挂着 1 台主机，收到 ${health.hosts}`)
      assert.equal(host.state().carrier, 'mock')
      note(`hostId=${host.hostId} carrier=${host.state().carrier} relay=${host.state().relay} conversations=${host.state().conversations}`)
      note('内核面 = platform/mock-kernel：会话 id 一律 ses_mock*，本步不证明真内核（真内核见 e2e/live-e2e.mjs）')
    })

    await run('命令这条路上没有东西：/drc 整条已删，一个命令都不该注册进 ctx.commands', async () => {
      // 2026-10-03 拍板：配对唯一入口是状态栏那颗 pill（那四条路由），命令行兜底整条拔掉。
      // 这条不是"没报错就行"——它钉的是"命令注册这条路不该再被碰"，而当初的线上事故
      // （`command "drc" returned unknown result kind "text"`）正是从这条边界上来的。
      assert.equal(
        host.commandCount(),
        0,
        'apply() 一个命令都不该注册（/drc 已删）；注册了就说明旧那条没拔干净',
      )
      note('ctx.commands 上 0 条注册；配对入口只有 pill 那四条路由')
    })

    await run('点一下配对：pill 那四条路由在真中继在线时发码、出图、说实话、能解配', async () => {
      const marker = { host: '127.0.0.1:19387', 'x-drc-pair': '1' }
      const NEW = '/plugins/dsh-remote-control/pairing/new'
      const PNG = '/plugins/dsh-remote-control/pairing.png'
      const STATUS = '/plugins/dsh-remote-control/status'
      const UNPAIR = '/plugins/dsh-remote-control/unpair'
      assert.deepEqual(
        [...host.pillRoutes.keys()].sort(),
        [NEW, PNG, STATUS, UNPAIR].sort(),
        '四条路由都要挂上（假 webServer 在场）',
      )

      // 1) 抬头那句：在线、没配过手机、此刻还没有效码。字段集合就那七个（全是非凭据；本机名 2026-10-03 撤了）。
      const before = await host.callPill(STATUS)
      assert.equal(before.status, 200)
      assert.equal(before.body.relay, 'online', `pill 要说实话：${JSON.stringify(before.body)}`)
      assert.deepEqual(
        Object.keys(before.body).sort(),
        ['paired', 'pairings', 'relay', 'serverUrl', 'version', 'waiting', 'waitingOldestSec'],
        '状态路由多一个字段就要重新审一遍（这七个全是非凭据；waiting 是抬头那句"等 N 件事"的来源，pairings 是"手机离线 / 未配对"的分界）',
      )
      assert.equal(before.body.waiting, 0, '一次交互都没发生过，抬头不该凭空报"有事在等"')

      // 2) 点一下：真向中继申请一张码。回答带 token/epoch，**不带 psk、不带完整 URI**。
      const minted = await host.callPill(NEW, { method: 'POST', headers: marker })
      assert.equal(minted.status, 200, JSON.stringify(minted.body))
      assert.equal(minted.body.state, 'ready')
      assert.match(String(minted.body.token), /^\d{6}$/, '6 位码要给——弹窗上"或手输这 6 位数字"靠它')
      assert.match(String(minted.body.epoch), /^[0-9a-f]{16}$/, 'epoch 必须是码文本 sha256 的前 16 位')
      assert.ok(Number(minted.body.expiresInMs) > 0, '剩余寿命必须是正数')
      assert.doesNotMatch(JSON.stringify(minted.body), /psk|dshr:/, '发码回答里不许出现凭据（红线 D1）')

      // 3) 幂等：连点两次是同一张码（多码事故的原形状就是这里退化成"每次一张"）。
      const again = await host.callPill(NEW, { method: 'POST', headers: marker })
      assert.equal(again.body.token, minted.body.token, '连点必须复用那张仍然有效的码')
      assert.equal(again.body.epoch, minted.body.epoch)

      // 4) 图：真 PNG 字节 + 不许缓存 + ETag 与 epoch 同一个口径。
      const image = await host.callPill(PNG)
      assert.equal(image.status, 200)
      assert.equal(image.headers['Content-Type'], 'image/png')
      assert.equal(image.headers['Cache-Control'], 'no-store')
      assert.equal(String(image.headers.ETag).replace(/"/g, ''), minted.body.epoch, 'ETag 与发码回答的 epoch 必须同一个')
      assert.deepEqual([...image.raw.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 魔数字节')

      // 5) 守卫：缺那个头 → 403；跨站 Origin → 403；GET 打写路由 → 405。
      assert.equal((await host.callPill(NEW, { method: 'POST', headers: { host: marker.host } })).status, 403)
      assert.equal(
        (await host.callPill(NEW, { method: 'POST', headers: { ...marker, origin: 'https://evil.example.com' } })).status,
        403,
      )
      assert.equal((await host.callPill(NEW, { method: 'GET', headers: marker })).status, 405)
      assert.equal(
        (await host.callPill(NEW, { method: 'POST', headers: { ...marker, origin: 'dsh-app://app' } })).status,
        200,
        '宿主自己的自定义 scheme 算"自己"（真机上文档 origin 就是这个形状）',
      )

      // 6) 这张码就是主机在维护的那一张：token 对得上、URI 的哈希对得上 epoch。
      //    路由**故意不返回完整 URI**（那里面带着 PSK），所以只能从主机内部对回来——
      //    对不上就说明"屏幕上是一张、中继认的是另一张"，那正是多码事故的形状。
      const active = host.state().pairing
      assert.ok(active?.qr, '点一下之后主机必须在维护一张有效码')
      assert.equal(active.token, minted.body.token, 'pill 发的码与窗口维护的必须是同一张')
      assert.equal(sha256_16(active.qr), minted.body.epoch, 'epoch 就是这张码 URI 的哈希，同一个口径')
      assert.ok(String(active.qr).includes(`t=${minted.body.token}`), 'URI 里那位 6 位码要和回答一致')

      // 7) 退出配对：此刻还没配上手机，unpaired=0 也是成功（不是错误）。
      //    守卫与发码那条同一档：GET → 405、少了自定义头 → 403。
      const unpaired = await host.callPill(UNPAIR, { method: 'POST', headers: marker })
      assert.equal(unpaired.status, 200, JSON.stringify(unpaired.body))
      assert.deepEqual(unpaired.body, { state: 'ok', unpaired: 0 }, '这台没配上时 unpaired=0，是幂等成功')
      assert.equal((await host.callPill(UNPAIR, { method: 'GET', headers: marker })).status, 405)
      assert.equal((await host.callPill(UNPAIR, { method: 'POST', headers: { host: marker.host } })).status, 403)

      note(`pill：status=online → 发码 token=${minted.body.token}（幂等复点同码、与主机维护的那张同 URI）→ PNG ${image.raw.length}B → 守卫各回 403/403/405 → unpair ${JSON.stringify(unpaired.body)}`)
    })

    await run('主机发布配对码 → pair-ready 带正整数 ttlMs → 手机用真实 dsh-remote-mp/miniprogram/core 代码配对', async () => {
      phone = newPhone('主链路手机')
      const pairing = host.createPairing()
      const ready = await until(
        () => controlFrames('host', 'received', ['pair-ready']).find((f) => f.pairingToken === pairing.token),
        {
          timeoutMs: 8000,
          label: '主机收到自己那张码的 pair-ready',
          trail: tap.frames.slice(-8).map((f) => ({ kind: `frame-${f.side}-${f.dir}`, text: String(f.raw).slice(0, 40) })),
        },
      )
      assert.ok(Number.isInteger(ready.ttlMs) && ready.ttlMs > 0, `pair-ready.ttlMs 必须是正整数，收到 ${JSON.stringify(ready.ttlMs)}`)
      note(`pair-begin(${pairing.token}) → pair-ready ttlMs=${ready.ttlMs}ms（服务端权威，主机据此改写本地过期）`)
      await pairPhone(host, phone, { pairing, expectedRelayUrl: relay.url })
      note(`paired：convId=${phone.convId} statusText="${phone.client.statusText}"`)
    })

    await run('握手明文帧逐条对号：hello→hello-ok、pair-begin-client→paired + peer-joined(带 pairingToken)', async () => {
      const hello = controlFrames('phone', 'sent', ['hello']).pop()
      assert.ok(hello, '手机没发 hello')
      assert.equal(hello.role, 'client', "hello.role 必须是字面量 'client'")
      assert.equal(hello.protocol, 1)
      assert.equal(typeof hello.clientId, 'string')
      assert.deepEqual(hello.clientMeta, { platform: 'wechat-mp', label: '微信小程序' })
      const helloOk = controlFrames('phone', 'received', ['hello-ok']).pop()
      assert.ok(helloOk, '中继必须在 hello 之后必发 hello-ok（红线 6）')
      const claim = controlFrames('phone', 'sent', ['pair-begin-client']).pop()
      assert.ok(claim && /^\d{6}$/.test(claim.pairingToken), '手机必须发 pair-begin-client 且带 6 位码')
      const paired = controlFrames('phone', 'received', ['paired']).pop()
      assert.ok(paired, '没收到 paired')
      assert.match(paired.sessionId, /^c_[0-9a-f]{12}$/, `paired.sessionId 必须是 c_ + 12 位 hex，收到 ${paired.sessionId}`)
      assert.equal(paired.sessionId, phone.convId, '手机存的 convId 必须就是 paired.sessionId')
      const joined = await until(
        () => controlFrames('host', 'received', ['peer-joined']).find((f) => f.sessionId === paired.sessionId) ?? null,
        {
          timeoutMs: 8000,
          trail: phone.trail,
          label: '主机收到这条会话的 peer-joined（中继先回 paired、后通知主机，所以要等）',
        },
      )
      assert.match(joined.pairingToken, /^\d{6}$/, '发给主机的 peer-joined 必须带 pairingToken（多码并存事故的根）')
      assert.equal(joined.pairingToken, claim.pairingToken, 'pairingToken 必须就是手机用的那张码')
      assert.equal(joined.sessionId, phone.convId)
      note(`hello(clientId=${hello.clientId}) → hello-ok → pair-begin-client(${claim.pairingToken}) → paired(${paired.sessionId}) + peer-joined(token=${joined.pairingToken})`)
    })

    await run('cmd.list_sessions → 必须收到 ev.session_changed（F8：列表唯一数据源）', async () => {
      // 手机的真实行为：进会话页 + 下拉刷新 = 两次 list_sessions（§1.2 调用点清单）。
      for (const trigger of ['进入会话页', '下拉刷新']) {
        const cmdId = phone.client.newCmdId()
        assert.equal(phone.client.sendCmd({ t: 'cmd.list_sessions', cmdId }), true, `${trigger}的 list_sessions 没发出去`)
        // 主机的顺序是"先推列表、再回 ev.result"，但两帧相对顺序不作要求：两条都单独等到。
        const result = await phone.waitForPayload('ev.result', `${trigger}的回执`, { where: (p) => p.cmdId === cmdId, timeoutMs: 10_000 })
        const changed = await phone.waitForPayload('ev.session_changed', '会话列表被推过来', {
          where: (p) => Array.isArray(p.sessions) && p.sessions.length > 0,
          timeoutMs: 10_000,
        })
        assertListPushed({ resultPayload: result, sessionChangedPayload: changed, cmdId })
        assertSessionShape(changed.sessions)
        assert.ok(changed.sessions.some((s) => s.id === MOCK_SESSION_ID), 'mock 内核的空闲会话该在列表里')
        assert.ok(
          changed.sessions.some((s) => s.state === 'archived'),
          '归档会话必须标成 archived（拼错会让手机把它当普通空闲会话）',
        )
        assert.equal(phone.client.sessions.length, changed.sessions.length, '客户端簿记的 sessions 必须来自这条推送')
        note(`${trigger}：sessions=${changed.sessions.map((s) => `${s.id}/${s.state}`).join(', ')}`)
      }
      note('列表里的 ses_mock* 恰恰证明这是 mock 内核；真内核列表非空由 live-e2e 取证')
    })

    await run('cmd.new_session → 真 mp 代码 newSession 拿到新会话 id，且它立刻出现在列表里', async () => {
      // 这一步为什么必须有：用户报过「新建会话用不了」，而当时的修法只落在**插件侧**
      // （`sessionController.commands.create`）。链路层从没跑过这条命令 ——
      // 单测能过、插件能应答，都不代表「手机点一下真能拿到 id」：
      // 中继是否放行 `cmd.new_session`、`ev.result` 有没有回传、waiter 能不能结算，
      // 这三件事只有真中继 + 真插件 + 真 mp 代码串起来才算验过。
      //
      // 判据分三段，缺一段都可能出现"点了没反应"：
      //   ① 真的发出去过（`cmd.new_session` 上行，且带 cmdId）；
      //   ② 真的结算了（`ok:true` 且 sessionId 是非空字符串）；
      //   ③ 真的建出来了（主机推的列表里出现这个新 id —— 只回执不落库的话，
      //      手机跳进 chat 页会看到一个不存在的会话，历史页永远空着）。
      const before = phone.client.sessions.length
      const created = await phone.client.newSession()
      assert.ok(created, 'newSession() 返回 null = waiter 没结算（超时/断线/未被 ev.result 命中）')
      const sent = phone.cmds.filter((c) => c.cmd.t === 'cmd.new_session').pop()
      assert.ok(sent, '手机没发出 cmd.new_session')
      assert.ok(sent.cmd.cmdId, 'cmd.new_session 必须带 cmdId（回执按它对答，缺了就永远等不到）')
      assert.equal(created.ok, true, `新建失败：${created.message}`)
      assert.equal(typeof created.sessionId, 'string', 'ok:true 时必须给 sessionId')
      assert.ok(created.sessionId.length > 0, 'sessionId 不能是空串')
      assert.notEqual(created.sessionId, MOCK_SESSION_ID, '新会话不能是那条既有的 mock 会话（那说明回执串了）')

      // ③ 主机必须把新会话推回列表。列表是唯一数据源（F8），不推的话手机刷新也看不到它。
      const pushed = await until(
        () => phone.client.sessions.find((s) => s.id === created.sessionId),
        { timeoutMs: 8000, label: `主机把新会话 ${created.sessionId} 推进列表` },
      )
      assert.ok(pushed, '主机回了 ev.result 但列表里没有这条会话（建了但没落库，手机会跳进一个不存在的会话）')
      assert.ok(
        phone.client.sessions.length > before,
        `会话数应该变多：${before} → ${phone.client.sessions.length}`,
      )

      // 拿历史读一次：新会话的历史**该是空的**（用户还没发第一条指令），
      // 但这一条要验的不是"空"而是"读得通"—— 返回 null 才是问题，
      // 那正是用户「新建后进去一直转圈 / 空白」的路径。
      //
      // 注意别断言 items.length === 0：mock 内核的 readHistory 无条件返回
      // `defaultHistory(sessionId)`（见 mock-kernel.ts），对**任何** sessionId 都给 3 条。
      // 那是 mock 的简化，不是缺陷 —— 空会话真读出空内容由 live-e2e 在真内核上取证。
      const emptyPage = await phone.client.loadHistory(created.sessionId, { limit: 3 })
      assert.ok(emptyPage, '新会话的 loadHistory 返回 null（走不通的会话进 chat 页会一直转圈）')
      assert.equal(emptyPage.sessionId, created.sessionId, '历史页的 sessionId 要与请求的一致')
      assert.ok(Array.isArray(emptyPage.items), `新会话的历史页必须有 items 字段，收到 ${JSON.stringify(emptyPage).slice(0, 120)}`)
      note(
        `new_session → ${created.sessionId}（列表 ${before}→${phone.client.sessions.length} 条；` +
          `新会话历史页读得通，${emptyPage.items.length} 条 —— mock 恒返回 defaultHistory，空会话为空要靠真内核取证）`,
      )
    })

    await run('cmd.session_history → 真 mp 代码 loadHistory 拿到一页历史，且游标能真的往前翻', async () => {
      // 主机上**已有的**对话要能同步到手机：这一条走的是真 `dsh-remote-mp/miniprogram/core/client.js` 的
      // `loadHistory`（不是测试自己拼帧），验的就是两端对 `cmd/ev.session_history` 的口径一致。
      const first = await phone.client.loadHistory(MOCK_SESSION_ID, { limit: 3 })
      assert.ok(first, 'loadHistory 返回 null = 这一页没拿到（未配对 / 超时 / 断线）')
      const sent = phone.cmds.filter((c) => c.cmd.t === 'cmd.session_history').pop()
      assert.ok(sent, '手机没发出 cmd.session_history')
      assert.equal(sent.cmd.sessionId, MOCK_SESSION_ID, '载荷 sessionId 必须是 DSH 会话 id（F3）')
      assert.equal(sent.cmd.limit, 3, 'limit 必须原样上行')
      assert.equal(first.cmdId, sent.cmd.cmdId, 'ev.session_history.cmdId 必须原样回传（对答靠它匹配）')
      assert.ok(first.sessionId === MOCK_SESSION_ID, '回执的 sessionId 也必须逐字相同')
      assert.ok(
        Array.isArray(first.items) && first.items.length > 0,
        `历史页必须带 items，收到 ${JSON.stringify(first).slice(0, 200)}`,
      )
      for (const item of first.items) {
        assert.ok(
          ['ev.message_delta', 'ev.tool_event', 'ev.todo'].includes(item.t),
          `历史条目只允许实时流那三种叶子载荷（小程序用同一条分发路径回放），收到 ${JSON.stringify(item.t)}`,
        )
      }
      // 待办快照：本地全链路要真的走到它（mock 历史的最后一条）。这条过不了，
      // 说明 wire 1.5.0 的 historyItem 扩员与插件实际发出的形状对不上——
      // 单测各摆各的帧，发现不了这种跨仓分叉。
      const todoSnapshots = first.items.filter((item) => item.t === 'ev.todo')
      assert.equal(todoSnapshots.length, 1, `第一页必须带一条待办快照，实得 ${todoSnapshots.length} 条`)
      assert.deepEqual(
        todoSnapshots[0].todos,
        [
          { content: '复现用户报的问题', status: 'completed' },
          { content: '改完跑一遍本地全链路', status: 'in_progress' },
        ],
        '快照内容必须逐字节过网（全量语义，不折叠）',
      )
      // 翻页：游标**由主机给、手机原样回传**。第二页必须存在、内容不同、且游标严格前移。
      assert.equal(typeof first.nextBeforeSeq, 'number', 'mock 历史比一页长，第一页必须给出更早的游标')
      const second = await phone.client.loadHistory(MOCK_SESSION_ID, { beforeSeq: first.nextBeforeSeq, limit: 3 })
      assert.ok(second, '带游标再取一页失败（loadHistory 返回 null）')
      const sent2 = phone.cmds.filter((c) => c.cmd.t === 'cmd.session_history').pop()
      assert.equal(sent2.cmd.beforeSeq, first.nextBeforeSeq, '第二页必须把主机给的游标原样回传')
      const fingerprint = (page) => page.items.map((i) => `${i.t}:${i.callId ?? i.messageId ?? i.delta ?? ''}`).join('|')
      assert.notEqual(
        fingerprint(second),
        fingerprint(first),
        '第二页与第一页内容逐字相同 = 游标没起作用（手机上会无限重复同一段）',
      )
      const nextCursor = typeof second.nextBeforeSeq === 'number' ? second.nextBeforeSeq : -1
      assert.ok(nextCursor < first.nextBeforeSeq, `游标没有往前移：${nextCursor} 不 < ${first.nextBeforeSeq}`)
      note(
        `limit=3 → items=${first.items.length} nextBeforeSeq=${first.nextBeforeSeq} → 再一页 items=${second.items.length} nextBeforeSeq=${second.nextBeforeSeq ?? '（到底）'}`,
      )
    })

    await run('F3：帧外层 sessionId(c_*) ≠ 载荷 sessionId(DSH 会话 id)，且与 sessions[].id 同值', async () => {
      const frame = phone.sent.filter((s) => s.frame.t === 'enc').pop()
      assert.ok(frame, '没看到手机发出的 enc 帧')
      assert.match(frame.frame.sessionId, /^c_/, '帧外层 sessionId 必须是配对通道 id')
      assert.equal(frame.frame.sessionId, phone.convId)
      assert.equal(frame.frame.clientId, phone.client.clientId)
      assert.equal(typeof frame.frame.seq, 'number', 'seq 必须是整数（中继不参与解密，但必须在）')
      const kernel = host.kernel()
      kernel.feed({ kind: 'delta', sessionId: MOCK_SESSION_ID, messageId: 'f3_probe', text: 'f3', done: false })
      const delta = await phone.waitForPayload('ev.message_delta', 'F3 探针 delta 到达', { where: (p) => p.messageId === 'f3_probe' })
      assert.equal(delta.sessionId, MOCK_SESSION_ID, '载荷里的 sessionId 必须是 DSH 会话 id')
      assert.notEqual(frame.frame.sessionId, delta.sessionId, '两个 sessionId 必须不同值（混淆是本协议最贵的一类 bug）')
      const changed = phone.lastPayload('ev.session_changed')
      assert.ok(changed.sessions.some((s) => s.id === delta.sessionId), '载荷 sessionId 必须与 sessions[].id 同值')
      const down = controlFrames('phone', 'received', ['enc']).pop()
      assert.equal(down.sessionId, phone.convId, '下行帧外层 sessionId 必须逐字不变（红线 4）')
      note(`外层 ${frame.frame.sessionId} ≠ 载荷 ${delta.sessionId} === sessions[].id`)
    })

    await run('cmd.send_prompt → 审批卡 → 逐字回传 options[].id → 工具行 → delta 流 → done:true', async () => {
      const permissionBefore = phone.count('ev.permission_request')
      const deltaBefore = phone.count('ev.message_delta')
      phone.client.sendPrompt(MOCK_SESSION_ID, PROMPT_TEXT)
      const request = await phone.waitForPayload('ev.permission_request', '审批卡到达', { after: permissionBefore, timeoutMs: 10_000 })
      assert.equal(request.sessionId, MOCK_SESSION_ID, '审批卡必须带 DSH 会话 id（手机按它过滤）')
      assert.ok(Array.isArray(request.options) && request.options.length >= 2, `审批卡必须给出 options[]，收到 ${JSON.stringify(request.options)}`)
      const approve = request.options.find((option) => option.id === 'approve')
      assert.ok(approve, `options[].id 里必须有 approve，收到 ${JSON.stringify(request.options)}`)
      phone.client.resolvePermission(request.sessionId, request.requestId, approve.id)
      const answered = phone.cmds.filter((c) => c.cmd.t === 'cmd.resolve_permission').pop()
      assert.ok(answered, '手机没发出 cmd.resolve_permission')
      assert.equal(answered.cmd.decision, approve.id, '红线 14：回传的 decision 必须逐字等于主机下发的 options[].id')
      assert.equal(answered.cmd.requestId, request.requestId, 'requestId 必须原样回传')
      assert.equal(answered.cmd.sessionId, MOCK_SESSION_ID)
      const tool = await phone.waitForPayload('ev.tool_event', '审批通过后 agent 继续跑（工具行到达）', { timeoutMs: 10_000 })
      assert.equal(tool.sessionId, MOCK_SESSION_ID)
      assert.equal(typeof tool.callId, 'string')
      assert.ok(['started', 'args', 'completed', 'failed'].includes(tool.phase), `phase 必须在枚举内，收到 ${JSON.stringify(tool.phase)}`)
      // mock 内核把 sink.approval 的返回值打在 resultPreview 上：主机把手机上行的
      // 'approve' 翻成了平台词汇 'allowed-once'，证明这条 decision 真的被认领、agent 继续跑了。
      assert.equal(tool.resultPreview, 'allowed-once', `decision 没被主机结算，工具行拿到的是 ${JSON.stringify(tool.resultPreview)}`)
      const done = await phone.waitForPayload('ev.message_delta', '回合收尾（done:true）', {
        after: deltaBefore,
        where: (p) => p.done === true && p.sessionId === MOCK_SESSION_ID,
        timeoutMs: 10_000,
      })
      assert.ok(done.messageId.startsWith('msg_'), `这条 done 必须属于本轮的助手消息，收到 ${done.messageId}`)
      const messageId = done.messageId
      const frames = phone.payloads('ev.message_delta').filter((p) => p.messageId === messageId)
      const text = frames.map((p) => p.delta).join('')
      assert.ok(text.includes('收到：'), `流式正文应是 mock 内核的回显，收到 ${JSON.stringify(text)}`)
      assert.ok(text.includes(PROMPT_TEXT.slice(0, 12)), `回显里必须含指令正文（明文只存在于密文里，第 11 步审计它不外泄）：${JSON.stringify(text)}`)
      assert.equal(frames.filter((p) => p.done === true).length, 1, 'done 必须恰好一条')
      assert.equal(frames[frames.length - 1].done, true, 'done 必须是这条消息的最后一帧（F9）')
      note(`approval(${request.requestId}) → decision=${approve.id} → tool(${tool.callId}/${tool.phase}) → delta×${frames.length} → done:true`)
    })

    await run('流式顺序与合帧：12 段内核增量 → 手机拼接逐字一致、帧数不膨胀、done 收尾', async () => {
      const kernel = host.kernel()
      const chunks = Array.from({ length: 12 }, (_, i) => `段${String(i + 1).padStart(2, '0')}|`)
      const expected = chunks.join('')
      const messageId = `stream_${Date.now().toString(36)}`
      for (const chunk of chunks) {
        kernel.feed({ kind: 'delta', sessionId: MOCK_SESSION_ID, messageId, text: chunk, done: false })
        await delay(25)
      }
      kernel.feed({ kind: 'delta', sessionId: MOCK_SESSION_ID, messageId, text: '', done: true })
      await phone.waitForPayload('ev.message_delta', '这条流式消息收尾', { where: (p) => p.messageId === messageId && p.done === true, timeoutMs: 10_000 })
      const frames = phone.payloads('ev.message_delta').filter((p) => p.messageId === messageId)
      const merged = frames.map((frame) => frame.delta).join('')
      assert.equal(merged, expected, `顺序或内容有出入：收到 ${JSON.stringify(merged)}`)
      assert.ok(frames.length < chunks.length, `合帧没起作用：${frames.length} 帧对 ${chunks.length} 段`)
      assert.ok(frames.length <= 6, `每会话每窗口的帧数失控：${frames.length} > 6`)
      assert.equal(frames[frames.length - 1].done, true, 'done 必须是最后一帧')
      note(`${chunks.length} 段增量合成 ${frames.length} 帧，拼接逐字相等`)
    })

    await run('ev.question_request → cmd.answer 回传 [{questionId,selected:[id]}]', async () => {
      const kernel = host.kernel()
      const asked = kernel.askQuestion(MOCK_SESSION_ID, [
        { id: 'q1', question: '部署到哪个环境？', options: [{ id: 'staging', label: '预发' }, { id: 'prod', label: '生产' }] },
      ])
      const request = await phone.waitForPayload('ev.question_request', '提问卡到达', { timeoutMs: 10_000 })
      // 卡片发出去的那一刻，主机侧的 `waiting` 就必须看得见（抬头那句"等 N 件事"的唯一来源）。
      // 这条不是锦上添花：挂起没被记进计数，桌面就永远说"已配对"，而一条回合正停在这台机器上。
      const during = await host.callPill('/plugins/dsh-remote-control/status')
      assert.ok(during.body.waiting >= 1, `卡已经发出去了，/status 的 waiting 却还是 ${during.body.waiting}`)
      assert.ok(during.body.waitingOldestSec >= 0, `waitingOldestSec 必须是个数，收到 ${during.body.waitingOldestSec}`)
      assert.equal(request.sessionId, MOCK_SESSION_ID)
      assert.ok(Array.isArray(request.questions) && request.questions.length === 1, `questions 必须原样到达，收到 ${JSON.stringify(request.questions)}`)
      const question = request.questions[0]
      assert.equal(question.id, 'q1', 'questions[].id 必须原样下发（手机回传它）')
      assert.equal(question.question, '部署到哪个环境？')
      assert.deepEqual(question.options.map((o) => o.id), ['staging', 'prod'])
      phone.client.answer(request.sessionId, request.requestId, [{ questionId: question.id, selected: [question.options[0].id] }])
      const answeredCmd = phone.cmds.filter((c) => c.cmd.t === 'cmd.answer').pop()
      assert.deepEqual(
        answeredCmd.cmd.answers,
        [{ questionId: 'q1', selected: ['staging'] }],
        `红线 15：出站 answers 必须是 [{questionId,selected:[optionId]}]，收到 ${JSON.stringify(answeredCmd.cmd.answers)}`,
      )
      // 用 raceWithTimeout 而不是裸的 Promise.race：`asked` 先赢时，输掉的那发
      // `delay(10_000)` 会 ref 着把进程多钉 ~10s（见 raceWithTimeout 的说明）。
      const settled = await raceWithTimeout(asked, 10_000)
      assert.ok(settled, '手机端的答案 10s 内没结算到内核侧')
      assert.deepEqual(settled.answers.map((a) => a.id), ['q1'], '内核侧必须按 questionId 对上问题')
      assert.deepEqual(settled.answers[0].selected, ['预发'], '主机必须把手机回传的 id 翻回平台用的 label（红线 15）')
      // 结算完必须**清零**。挂起条目删不掉的话，那颗 pill 会永远挂着"等 1 件事"——
      // 一个不会消失的角标比没有角标更坏（用户从此不看它）。
      const after = await host.callPill('/plugins/dsh-remote-control/status')
      assert.equal(after.body.waiting, 0, `答完之后 waiting 没归零：${JSON.stringify(after.body)}`)
      assert.equal(after.body.waitingOldestSec, 0, `没有事在等时时长也要回到 0，收到 ${after.body.waitingOldestSec}`)
      note(`question_request(${request.requestId}) → answer(${JSON.stringify(settled.answers)})`)
    })

    await run('cmd.keep_awake → ev.keep_awake_state{enabled,active,platform,backend}', async () => {
      const stateBefore = phone.count('ev.keep_awake_state')
      phone.client.setKeepAwake(true, 600)
      const on = await phone.waitForPayload('ev.keep_awake_state', '防休眠状态回传（开）', {
        after: stateBefore,
        where: (p) => p.enabled === true,
        timeoutMs: 10_000,
      })
      assert.equal(typeof on.active, 'boolean', 'active 必须是布尔（手机按它显示"当前持锁中/未持锁"）')
      assert.equal(on.platform, os.platform(), 'platform 必须就是 host 的 os.platform()')
      assert.equal(typeof on.backend, 'string')
      assert.ok(on.backend.length > 0, 'backend 不能是空串')
      assert.equal(on.sessionId, undefined, 'F11：ev.keep_awake_state 不带 sessionId')
      note(`keep_awake on → enabled=${on.enabled} active=${on.active} platform=${on.platform} backend=${on.backend}${on.reason ? ` reason=${on.reason}` : ''}`)
      const afterOn = phone.count('ev.keep_awake_state')
      phone.client.setKeepAwake(false)
      const off = await phone.waitForPayload('ev.keep_awake_state', '防休眠状态回传（关）', {
        after: afterOn,
        where: (p) => p.enabled === false,
        timeoutMs: 10_000,
      })
      assert.equal(off.active, false, '关掉之后必须放锁')
      const keepAwakeCmds = phone.cmds.filter((c) => c.cmd.t === 'cmd.keep_awake')
      assert.ok(keepAwakeCmds.length >= 2, `只看到 ${keepAwakeCmds.length} 条 cmd.keep_awake，开关没走两个方向`)
      assert.equal(keepAwakeCmds[0].cmd.idleReleaseSec, 600, '开启时手机会带 idleReleaseSec=600（§1.2）')
      assert.equal(keepAwakeCmds[keepAwakeCmds.length - 1].cmd.idleReleaseSec, undefined, '关闭时不许带 idleReleaseSec（§1.2 字段级要求）')
      assert.equal(keepAwakeCmds[keepAwakeCmds.length - 1].cmd.enabled, false)
    })

    await run('cmd.interrupt → ev.run_state{state:idle, detail:interrupted}', async () => {
      const runStateBefore = phone.count('ev.run_state')
      const permissionBefore = phone.count('ev.permission_request')
      assert.equal(phone.client.sendPrompt(MOCK_SESSION_ID, '讲一个很长的故事'), true, 'sendPrompt 没能发出去')
      // 必须等"这一轮新产生的 running"，否则上一轮的同名状态会把这条断言喂成假绿。
      const running = await phone.waitForPayload('ev.run_state', '运行中状态到达', {
        after: runStateBefore,
        where: (p) => p.state === 'running',
        timeoutMs: 10_000,
      })
      assert.equal(running.sessionId, MOCK_SESSION_ID)
      phone.client.interrupt(MOCK_SESSION_ID)
      const idle = await phone.waitForPayload('ev.run_state', '中断后的 idle', {
        after: runStateBefore,
        where: (p) => p.state === 'idle' && p.detail === 'interrupted',
        timeoutMs: 10_000,
      })
      assert.equal(idle.sessionId, MOCK_SESSION_ID, 'run_state 必须带 DSH 会话 id')
      assert.ok(
        phone.payloads('ev.run_state').indexOf(idle) > phone.payloads('ev.run_state').indexOf(running),
        'idle/interrupted 必须排在 running 之后',
      )
      note(`run_state: running → ${idle.state}/${idle.detail}`)
      // 这一轮 mock 内核还挂着一次审批（sendPrompt 默认先要一次批准）；按 UI 的"拒绝"结掉它。
      assert.ok(phone.count('ev.permission_request') > permissionBefore || phone.pendingPermissions().length > 0, '审批卡没到')
      assert.ok(phone.settlePermissions() >= 1, '没结掉任何挂起的审批，收尾会留下解不开的挂起态')
      await delay(400)
    })

    await run('零知识帧审计：手机交给中继的每一帧都是密文，命令名与正文关键词 0 命中', async () => {
      const sentViaTap = outboundToRelay('phone')
      const encSent = sentViaTap.filter((raw) => JSON.parse(raw).t === 'enc')
      // 交叉核对：sendControl 录制（权威）与 mp-sim recorder 必须看到的是同一批帧。
      const viaRecorder = phone.recorder.frames.filter((f) => f.raw.includes('"ciphertext"')).map((f) => f.raw)
      assert.ok(
        encSent.every((raw) => viaRecorder.includes(raw)),
        `有 ${encSent.filter((raw) => !viaRecorder.includes(raw)).length} 帧手机发出的密文没进 recorder——审计对象漏了`,
      )
      const stats = auditZeroKnowledge({
        outbound: sentViaTap,
        observed: tap.frames.map((f) => f.raw),
        minEnc: 10,
        minCipherBytes: 40,
        plaintextSample: { t: 'cmd.send_prompt', cmdId: 'c_probe', sessionId: MOCK_SESSION_ID, text: PROMPT_TEXT },
      })
      note(`手机→中继 enc 帧 ${stats.encFrames} 发（下界 10），最小密文 ${stats.smallestCipherBytes}B（下界 40B），逐帧查了 ${stats.forbiddenChecked} 个业务词`)
      const lines = auditRelayLogs(relay)
      note(`中继日志 ${lines} 行，业务明文 0 命中`)
      assert.ok(tap.frames.length > 30, `帧抓取只有 ${tap.frames.length} 条——审计对象本身就没录到东西`)
    })

    await run('收尾：解配 → needs-pair；中继 SIGTERM 优雅退出', async () => {
      phone.client.unpair()
      await phone.waitForStatus('needs-pair', '解配后要求重新配对', 5000)
      assert.equal(phone.client.convId, '', '解配必须清掉 convId')
      note(`unpair → statusText="${phone.client.statusText}"`)
    })
  } finally {
    const { relayExit } = await shutdown({ phone, host, relay })
    note(`中继退出 code=${relayExit.code} signal=${relayExit.signal ?? '-'}`)
    if (relayExit.code !== 0) failures += 1
    rmSync(workDir, { recursive: true, force: true })
    process.stdout.write(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，失败 ${failures} 步\n`)
  }

  if (failures > 0) {
    process.stdout.write('本地全链路未通过（内核面是 mock；真内核另见 e2e/live-e2e.mjs）\n')
    process.exitCode = 1
  } else {
    process.stdout.write('本地全链路通过：真中继 + 真插件运行时（内核面 mock）+ 真小程序客户端代码\n')
  }
}

const executedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (executedDirectly) {
  main().catch((error) => {
    process.stdout.write(`\n本地全链路异常：${String(error?.stack ?? error)}\n`)
    process.exitCode = 1
  })
}
