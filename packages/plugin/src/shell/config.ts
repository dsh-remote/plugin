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
  qrImage: boolean
  qrOpen: boolean
  qrStyle: 'ascii' | 'block' | 'half'
  /** 强 carrier 未到时，等多久才落到弱 carrier。 */
  carrierGraceMs: number
  /** 提问接管：会剥夺桌面 UI 的提问能力，所以默认关（见 core/runtime.ts）。 */
  takeOverQuestions: boolean
  approvalTimeoutSec: number
  listingRefreshSec: number
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
  qrImage: true,
  qrOpen: true,
  qrStyle: 'ascii',
  carrierGraceMs: 5000,
  takeOverQuestions: false,
  approvalTimeoutSec: 180,
  listingRefreshSec: 15,
}

const loopback = /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/
const wsUrl = /^wss?:\/\/.+/

export interface ConfigProblem {
  level: 'error' | 'warn'
  field: string
  message: string
}

/** 合成三级配置。`injected` 来自 cordis 的 patch 层。 */
export function readConfig(injected: Partial<PluginConfig> | undefined, env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const merged: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(injected ?? {}),
    keepAwake: { ...DEFAULT_CONFIG.keepAwake, ...(injected?.keepAwake ?? {}) },
  }
  const fromEnv = (name: string): string | undefined => env[name]
  if (fromEnv('DRC_SERVER_URL')) merged.serverUrl = env.DRC_SERVER_URL as string
  if (fromEnv('DRC_HOST_LABEL')) merged.hostLabel = env.DRC_HOST_LABEL as string
  if (fromEnv('DRC_HOST_ID')) merged.hostId = env.DRC_HOST_ID as string
  if (fromEnv('DRC_PAIR_ON_START_SEC')) merged.pairOnStartSec = Number(env.DRC_PAIR_ON_START_SEC) || 0
  if (fromEnv('DRC_QR_IMAGE') === '0') merged.qrImage = false
  if (fromEnv('DRC_QR_OPEN') === '0') merged.qrOpen = false
  if (fromEnv('DRC_QR_STYLE')) {
    const style = env.DRC_QR_STYLE as PluginConfig['qrStyle']
    merged.qrStyle = ['ascii', 'block', 'half'].includes(style) ? style : 'ascii'
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
    problems.push({ level: 'error', field: 'serverUrl', message: `serverUrl 必须是 ws:// 或 wss:// 开头的地址，收到 ${JSON.stringify(config.serverUrl)}` })
  } else if (config.serverUrl.startsWith('ws://') && !loopback.test(config.serverUrl)) {
    problems.push({ level: 'warn', field: 'serverUrl', message: '向非回环地址走明文 ws://，配对码与密文在链路上是可见的（生产请用 wss://）' })
  }
  if (!config.hostToken) {
    problems.push({
      level: 'error',
      field: 'hostToken',
      message: `缺少 host token：请把中继的 DRC_HOST_TOKEN 写进环境变量 ${config.hostTokenEnv || '(hostTokenEnv 为空)'}，或在 patch 里直接给 hostToken`,
    })
  } else if (config.hostToken.length < 24) {
    problems.push({ level: 'warn', field: 'hostToken', message: 'host token 短于 24 字符，建议 `openssl rand -hex 24`' })
  }
  if (!secondsSchema.safeParse(config.keepAwake.idleReleaseSec).success || config.keepAwake.idleReleaseSec < 0) {
    problems.push({ level: 'warn', field: 'keepAwake.idleReleaseSec', message: '不是有效的非负秒数，已夹回 300（KeepAwake 绝不能拿到 NaN）' })
    config.keepAwake.idleReleaseSec = 300
  }
  if (config.pairTtlMs <= 0) {
    problems.push({ level: 'warn', field: 'pairTtlMs', message: '必须为正数，已夹回 120000' })
    config.pairTtlMs = 120_000
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
      message: '提问接管会**取代桌面 UI 的提问能力**（ctx.userQuestions 只允许一个活跃 provider）；手机端不在线时提问会直接失败',
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
