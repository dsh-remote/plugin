/**
 * config — 插件配置：合成、校验、夹取。
 *
 * 优先级与旧实现一致：**环境变量 > patch 注入的 config > 默认值**
 * （取证 docs/legacy-spec/host-plugin-cordis.md §5.1）。
 * **键名一律继承旧名**：这些键写在用户的 `~/.dsh/profiles/desktop/cordis.patch.yml` 里，
 * 改名等于让线上配置静默失效——那是"语义继承"允许、而"结构照抄"禁止的分界线上
 * 唯一必须站在继承一侧的维度（复核 §5.4）。
 *
 * 校验只拦"真的不能工作"的两件事（serverUrl 与 hostToken），其余一律 warn + 夹回默认值：
 * 一个 GUI 宿主里，插件因为某个可选参数写错而不加载，比带着次优参数跑起来更难排查。
 * error 时也不抛，只写一次 status.json 留下面包屑（§5.2 的原话动机：
 * 「otherwise "why is nothing happening?" has no answer」）。
 */
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'

export interface PluginConfig {
  enabled: boolean
  serverUrl: string
  hostToken: string
  /** 指向真正的 token 所在的环境变量名（token 本身不进 patch 文件也可以）。 */
  hostTokenEnv: string
  hostId: string
  hostLabel: string
  keepAwake: { enabled: boolean; idleReleaseSec: number; keepDisplay: boolean }
  mockBridge: boolean
  statusFile: string
  unarchiveOnPrompt: boolean
  /** 启动后自动发布一张配对码并把 QR 写进 status.json（验证辅助，默认关）。 */
  pairOnStartSec: number
  /** 向中继申请 PSK 有效期；服务端权威值会覆盖它（见 transport/relay.ts）。 */
  pairTtlMs: number
  /** 是否把配对二维码写成 PNG（默认**开**：文本二维码在 DSH 命令卡里扫不出来，见下方默认值注释）。 */
  qrImage: boolean
  qrOpen: boolean
  /** 是否给文本二维码套 ANSI 反色。默认关：宿主按纯文本渲染时会把转义序列打成乱码。 */
  qrAnsi: boolean
  qrStyle: 'ascii' | 'block' | 'half'
  /** 强 carrier 未到时，等多久才落到弱 carrier。 */
  carrierGraceMs: number
  /** 提问接管：会剥夺桌面 UI 的提问能力，所以默认关（见 core/runtime.ts）。 */
  takeOverQuestions: boolean
  approvalTimeoutSec: number
  listingRefreshSec: number
  /**
   * 一条配对通道多久没有任何收发就可以被剪掉（秒）。
   *
   * 为什么需要：D3 之后配对通道跨断连长存，而**中继侧的空闲 TTL 是 7 天**
   * （`DRC_CONV_IDLE_TTL_MS`），"中继先忘掉这条会话"几乎不会发生。不剪的话，
   * 每天配一次对的主机两周就能攒两百多条密钥，且每次广播都对它们逐个密封一遍。
   * 剪枝一定同时发 `session-leave`，所以手机不会因此静默转圈——它撞上的是
   * 中文的"会话已失效，请重新配对"。
   */
  conversationIdleTtlSec: number
}

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  serverUrl: 'ws://127.0.0.1:8787',
  hostToken: '',
  hostTokenEnv: 'DRC_HOST_TOKEN',
  hostId: '',
  hostLabel: 'dsh-host',
  keepAwake: { enabled: true, idleReleaseSec: 300, keepDisplay: false },
  mockBridge: false,
  statusFile: path.join(homedir(), '.dsh', 'dsh-remote-control', 'status.json'),
  unarchiveOnPrompt: true,
  pairOnStartSec: 0,
  pairTtlMs: 120_000,
  // **默认走图片**。2026-10-02 取证推翻了原判断（原判断：文本二维码在任何等宽渲染器下
  // 都能扫，图片是可有可无的旁路）：
  //   · DSH 命令卡的等宽输出块是 `white-space: pre` + `line-height: 1.6`（app bundle 里
  //     的那条规则，实测行间留白约占行高 37%），每两行模块之间被塞进一条整行宽的缝隙，
  //     半块二维码被横切成条。
  //   · 用用户真机贴出来的那段输出做受控实验：把字号行距调到 1.0 时 zxing 解得出来，
  //     调到 ≥1.15 就扫不出来；而 DSH 固定 1.6。也就是说"文本码能扫"在**唯一宿主**上不成立。
  //   · 而 ANSI 反色救不了：TerminalBlock 把每行渲染成内联 span，背景只覆盖字形盒，
  //     不覆盖行间留白（见 dsh-client-ui-primitives 的 parseAnsiLines/renderLine）。
  // 图片是自包含位图矩阵，跟宿主的行高、字体、配色都无关——这才是"扫得出来"的那条路。
  qrImage: true,
  // 写图片 ≠ 替用户打开查看器：仍然默认关（原话「不要用打开一个图片的方式」）。
  qrOpen: false,
  qrAnsi: false,
  qrStyle: 'half',
  carrierGraceMs: 5000,
  takeOverQuestions: false,
  approvalTimeoutSec: 180,
  listingRefreshSec: 15,
  conversationIdleTtlSec: 86_400,
}

const loopback = /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/
const wsUrl = /^wss?:\/\/.+/

export interface ConfigProblem {
  level: 'error' | 'warn'
  field: string
  message: string
}

/**
 * 环境变量里的数字：只收「有限的非负数」，其余折成 0（= 关）。
 *
 * 为什么不能写成 `Number(v) || 0`：`Number('Infinity')` 是 Infinity，而它是**真值**，
 * `|| 0` 放过去了——`pairOnStartSec=Infinity` 的语义是"这张仍然带着 PSK 的配对码
 * 永久有效"，正好是这条配置想避免的事。NaN 侥幸会被 `|| 0` 折掉，但那是巧合不是规则。
 */
function envSeconds(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/** 布尔开关的环境变量写法：`1`/`0`（`true`/`false` 也认）是这里的运维习惯，其余值不猜、退回上层值。 */
function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return fallback
}

/** 合成三级配置。`injected` 来自 cordis 的 patch 层。 */
export function readConfig(
  injected: Partial<PluginConfig> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PluginConfig {
  const merged: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(injected ?? {}),
    keepAwake: { ...DEFAULT_CONFIG.keepAwake, ...(injected?.keepAwake ?? {}) },
  }
  const fromEnv = (name: string): string | undefined => env[name]
  if (fromEnv('DRC_SERVER_URL')) merged.serverUrl = env.DRC_SERVER_URL as string
  if (fromEnv('DRC_HOST_LABEL')) merged.hostLabel = env.DRC_HOST_LABEL as string
  if (fromEnv('DRC_HOST_ID')) merged.hostId = env.DRC_HOST_ID as string
  if (fromEnv('DRC_PAIR_ON_START_SEC')) merged.pairOnStartSec = envSeconds(env.DRC_PAIR_ON_START_SEC)
  // 这两个开关默认就是关的，所以环境变量只用于**打开**（`=1`）；
  // 仍然接受 `=0` 显式关闭，覆盖 patch 里开的情况。
  if (fromEnv('DRC_QR_IMAGE')) merged.qrImage = envFlag(env.DRC_QR_IMAGE, merged.qrImage)
  if (fromEnv('DRC_QR_OPEN')) merged.qrOpen = envFlag(env.DRC_QR_OPEN, merged.qrOpen)
  if (fromEnv('DRC_QR_ANSI')) merged.qrAnsi = envFlag(env.DRC_QR_ANSI, merged.qrAnsi)
  if (fromEnv('DRC_QR_STYLE')) {
    const style = env.DRC_QR_STYLE as PluginConfig['qrStyle']
    // 不猜：值不认识就保留上层（patch 或默认）的值，并由 validateConfig 负责 warn。
    if (['ascii', 'block', 'half'].includes(style)) merged.qrStyle = style
  }
  if (fromEnv('DRC_MOCK_BRIDGE') === '1') merged.mockBridge = true
  if (fromEnv('DRC_TAKE_OVER_QUESTIONS') === '1') merged.takeOverQuestions = true
  // token 只从环境变量取：patch 文件是 600 权限的 yaml，但把凭据写在配置文件里
  // 比留在环境变量里更容易被顺手提交或贴进工单。
  if (merged.hostTokenEnv) merged.hostToken = env[merged.hostTokenEnv] ?? merged.hostToken
  return merged
}

const secondsSchema = z.number().finite()

/** 校验 + 就地夹取。error 级问题会让上层拒绝启动 runtime（但仍留 status 面包屑）。 */
export function validateConfig(config: PluginConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = []
  if (!wsUrl.test(config.serverUrl)) {
    problems.push({
      level: 'error',
      field: 'serverUrl',
      message: `serverUrl 必须是 ws:// 或 wss:// 开头的地址，收到 ${JSON.stringify(config.serverUrl)}`,
    })
  } else if (config.serverUrl.startsWith('ws://') && !loopback.test(config.serverUrl)) {
    problems.push({
      level: 'warn',
      field: 'serverUrl',
      message: '向非回环地址走明文 ws://，配对码与密文在链路上是可见的（生产请用 wss://）',
    })
  }
  if (!config.hostToken) {
    problems.push({
      level: 'error',
      field: 'hostToken',
      message: `缺少 host token：请把中继的 DRC_HOST_TOKEN 写进环境变量 ${config.hostTokenEnv || '(hostTokenEnv 为空)'}，或在 patch 里直接给 hostToken`,
    })
  } else if (config.hostToken.length < 24) {
    problems.push({
      level: 'warn',
      field: 'hostToken',
      message: 'host token 短于 24 字符，建议 `openssl rand -hex 24`',
    })
  }
  if (!secondsSchema.safeParse(config.keepAwake.idleReleaseSec).success || config.keepAwake.idleReleaseSec < 0) {
    problems.push({
      level: 'warn',
      field: 'keepAwake.idleReleaseSec',
      message: '不是有效的非负秒数，已夹回 300（KeepAwake 绝不能拿到 NaN）',
    })
    config.keepAwake.idleReleaseSec = 300
  }
  if (config.pairTtlMs <= 0) {
    problems.push({ level: 'warn', field: 'pairTtlMs', message: '必须为正数，已夹回 120000' })
    config.pairTtlMs = 120_000
  }
  if (!secondsSchema.safeParse(config.pairOnStartSec).success || config.pairOnStartSec < 0) {
    // patch 文件里写 `pairOnStartSec: .inf` 也会走到这里：env 侧已经折掉了，注入侧不能漏。
    problems.push({ level: 'warn', field: 'pairOnStartSec', message: '必须是非负的有限秒数，已折回 0（关闭自动发码）' })
    config.pairOnStartSec = 0
  }
  if (config.qrOpen && !config.qrImage) {
    problems.push({
      level: 'warn',
      field: 'qrOpen',
      message:
        'qrOpen 需要 qrImage=true 才会写图片文件；现在只出文本二维码（文本码在 DSH 命令卡里扫不出来，见 config.ts 默认值注释）',
    })
  }
  if (!['ascii', 'block', 'half'].includes(config.qrStyle)) {
    problems.push({
      level: 'warn',
      field: 'qrStyle',
      message: `qrStyle 只认 ascii/block/half，收到 ${JSON.stringify(config.qrStyle)}，已退回 half`,
    })
    config.qrStyle = 'half'
  }
  if (!secondsSchema.safeParse(config.conversationIdleTtlSec).success || config.conversationIdleTtlSec <= 0) {
    // 0 或非法值**不表示"永不剪枝"**：永不剪枝就是那条无界的密钥簿。夹回默认值并说明。
    problems.push({
      level: 'warn',
      field: 'conversationIdleTtlSec',
      message: '必须是正数秒；这里不接受"永不剪枝"（无界的 PSK 簿是复核 🟡8 的原始缺陷），已夹回 86400',
    })
    config.conversationIdleTtlSec = 86_400
  }
  if (config.pairOnStartSec > 0) {
    problems.push({
      level: 'warn',
      field: 'pairOnStartSec',
      message: '开启后会把"仍然有效的配对码（含 PSK）"发布进 0600 的 status.json；这是验证辅助，用完请关掉',
    })
  }
  if (!config.statusFile) {
    problems.push({ level: 'warn', field: 'statusFile', message: '为空将关闭状态快照；GUI 宿主里这是唯一的排错入口' })
  }
  if (config.takeOverQuestions) {
    problems.push({
      level: 'warn',
      field: 'takeOverQuestions',
      message:
        '提问接管会**取代桌面 UI 的提问能力**（ctx.userQuestions 只允许一个活跃 provider）；手机端不在线时提问会直接失败',
    })
  }
  return problems
}

/** 令牌脱敏：日志与 status.json 里都只允许出现这个形态。 */
export function redactSecret(value: string): string {
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}…${value.slice(-2)}(${value.length})`
}

export { redactSecret as redact }
