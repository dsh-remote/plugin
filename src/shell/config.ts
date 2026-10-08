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
import { defaultPairStoreFile } from './pair-store.js'
import { MAX_ATTACHMENT_BYTES } from 'dsh-remote-wire/limits'
import { MAX_ATTACH_TOTAL_BYTES } from './uploads.js'

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
  approvalTimeoutSec: number
  listingRefreshSec: number
  /**
   * 状态栏那颗 pill（**配对的唯一入口**）。
   *
   * 2026-10-03 这一半原来是"右栏自动弹码"（独立 cordis 条目，键名
   * `sidebarQr`，带 `imageFile`/`refreshMs` 两个落盘参数）。那套删了之后 pill 不需要任何
   * 宿主侧节拍与落盘——它要图的时候自己发请求。剩下的唯一开关就是"挂不挂那四条路由"。
   *
   * ⚠️ 这里的键**绝不能是 error 级**：error 会让主插件整个不启动，那等于把一个界面功能
   * 变成配对链路的单点。同理 `pill.enabled:false` 的代价要能被查见（见 index.ts 的 problems）。
   */
  pill: { enabled: boolean }
  /**
   * 一条配对通道多久没有任何收发就可以被剪掉（秒）。
   *
   * 为什么需要：D3 之后配对通道跨断连长存，而**中继侧的空闲 TTL 是 7 天**
   * （`DRC_CONV_IDLE_TTL_MS`），"中继先忘掉这条会话"几乎不会发生。不剪的话，
   * 每天配一次对的主机两周就能攒两百多条密钥，且每次广播都对它们逐个密封一遍。
   * 剪枝一定同时发 `session-leave`，所以手机不会因此静默转圈——它撞上的是
   * 中文的"会话已失效，请重新配对"。
   *
   * ⚠️ **这一条不作用于从盘上恢复的会话**（见 `ConversationBook.restore`）：
   * 那条走 `restoredIdleTtlSec`，默认与中继对齐到 7 天。
   */
  conversationIdleTtlSec: number
  /**
   * **从盘上恢复的**会话多久没有任何收发可以被剪掉（秒）。
   *
   * 为什么要与上面那条分开：恢复出来的会话不是"新配了却没人用"，
   * 而是"用户早就配好了、只是主机重启了"。按 24 小时剪它，
   * 等于主机每次长假后一启动就把唯一那条通道清掉——免扫码重连白做。
   *
   * 默认值 7 天，与中继的 `DRC_CONV_IDLE_TTL_MS` 对齐：**中继忘掉它的那一天，
   * 本来就是手机必须重扫的那一天**，主机提前剪只是把同一次重扫提前到用户还没察觉的时刻。
   * 别把这个值调到比中继的空闲 TTL 更长——那样主机会在中继已经/routes 不到之后
   * 还留着 PSK，白占一份密钥材料。
   */
  restoredIdleTtlSec: number
  /**
   * 密钥簿落盘路径。
   *
   * 三种取值，刻意用字符串而不是布尔开关（布尔表达不了"跟着 statusFile 走"这个默认）：
   * - `''`（默认）= **自动**：`status.json` 同目录下的 `conversations-<hostId>.json`；
   * - `'off'` = 关掉落盘，等价于旧行为（每次重启都要重新扫码）；
   * - 其它 = 显式路径，相对路径按 `statusFile` 所在目录解析。
   *
   * 文件里有全部历史会话的 PSK，因此固定 0600 + 原子写，详见 `shell/pair-store.ts`。
   */
  pairStoreFile: string
  /**
   * 图片附件的落盘目录。`''` = 自动：`status.json` 同目录下的 `uploads/`。
   *
   * 为什么要有这么一项：手机发文件时内核端口只收文本（见 `shell/uploads.ts` 的头注），
   * 主机把文件存下来、把路径写进正文。目录里会积累用户发过的每一个文件，
   * 所以要能被配置指向一个有清理策略的位置（比如 tmp），默认值偏向「找得到」而不是「省地方」。
   *
   * ⚠️ **这里没有任何清理**：会话剪枝剪的是 `core/keys.ts` 里的**密钥簿条目**，
   * 与磁盘上那些文件无关；`saveFileAttachments` 也只增不删。所以默认路径
   * （`~/.dsh/dsh-remote-control/uploads/`）在 `~/.dsh` 下，长期用这台机器会一直涨。
   * 这是取舍（自动删用户文件比占磁盘更糟），不是疏漏——但要知道它，别以为是会自动清的。
   */
  uploadDir: string
  /** 单个文件附件的字节上限。默认 512KB：中继单帧 1MB 是硬上限，而文件没有压缩这一步。 */
  maxFileBytes: number
  /**
   * 新建会话使用的项目目录（**操作者级别的钉**）。
   *
   * 它是整条推断链的第一级（carrier-services 的 `newSession`：配置 → 最后操作过的
   * 会话 → 往前扫带 cwd 的会话 → 宿主默认）。留空（默认）才让后面三级生效。
   *
   * 不给这条出路的话只剩"宿主进程 cwd"这个黑洞：真机上就是 `/`，
   * 于是 DSH 的会话列表里那条永远落在**未分组**（2026-10-04 与 2026-10-06 两次用户报）。
   *
   * 协议层另有 `cmd.new_session.workspace`（手机指明分组，可选字段），等
   * `dsh-remote-wire` 发版并改钉之后可用——接线顺序见 HANDOFF §0.10.4。
   * 那时它仍然排在**本项之下**：这是配置文件里写下的一句"这台机器的新会话一律归到这儿"，
   * 不该被任何一次手机点击盖掉。
   */
  newSessionCwd: string
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
  approvalTimeoutSec: 180,
  listingRefreshSec: 15,
  conversationIdleTtlSec: 86_400,
  // 恢复出来的会话按 7 天剪，与中继的 DRC_CONV_IDLE_TTL_MS 对齐（理由见该字段注释）。
  restoredIdleTtlSec: 604_800,
  // 密钥簿落盘：默认跟着 statusFile 走（见 `resolvePairStoreFile`）。
  pairStoreFile: '',
  // 图片附件落盘：默认 status.json 同目录的 uploads/（见 `resolveUploadDir`）。
  uploadDir: '',
  maxFileBytes: MAX_ATTACHMENT_BYTES,
  newSessionCwd: '',
  // 配对的唯一入口。关掉它 = 这台主机**没有**配对入口（`/drc pair` 与文本二维码都在
  // 2026-10-03 删掉了），所以 index.ts 会把它记成一条 warn 而不是安静地什么都不做。
  pill: { enabled: true },
}

/** `pairStoreFile: 'off'` —— 关掉落盘的哨兵值。用字符串而不是布尔，因为它要能和路径共存。 */
const PAIR_STORE_OFF = 'off'

/**
 * 落盘路径解析：`''` 走默认（同目录 + hostId 命名），`'off'` 关掉，其余按 `statusFile`
 * 所在目录解析相对路径。
 *
 * **返回空串就是"这次不落盘"**，调用方必须照此跳过 —— 写进 `~/.dsh` 之外的路径是用户
 * 明确要求的，不该被我们因为"目录不存在"就静默改道（那会让用户以为已经配好了）。
 */
export function resolvePairStoreFile(config: PluginConfig, hostId: string): string {
  if (config.pairStoreFile === PAIR_STORE_OFF) return ''
  const configured = config.pairStoreFile.trim()
  if (!configured) return defaultPairStoreFile(config.statusFile, hostId)
  if (configured.startsWith('/')) return configured
  if (!config.statusFile) return configured
  return path.join(path.dirname(config.statusFile), configured)
}

/**
 * 图片附件落盘目录解析：与 `resolvePairStoreFile` 同一套规矩（`''` 走默认、
 * 相对路径按 statusFile 所在目录解析），但没有 off 档——这一项没有"关掉"的语义，
 * 想不落盘就把手机那侧的入口关掉（mp 只在上传成功后才会发带图的 prompt）。
 */
export function resolveUploadDir(config: PluginConfig): string {
  const configured = config.uploadDir.trim()
  if (!configured) {
    const base = config.statusFile
      ? path.dirname(config.statusFile)
      : path.join(homedir(), '.dsh', 'dsh-remote-control')
    return path.join(base, 'uploads')
  }
  if (configured.startsWith('/')) return configured
  if (!config.statusFile) return configured
  return path.join(path.dirname(config.statusFile), configured)
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
    // 逐键合并：patch 里只写 `pill.enabled` 时不能把整个对象覆盖掉（虽然它现在只有一个键，
    // 但"注入对象整体替换默认对象"这个形状在 keepAwake 上已经坑过一次）。
    pill: { ...DEFAULT_CONFIG.pill, ...(injected?.pill ?? {}) },
  }
  const fromEnv = (name: string): string | undefined => env[name]
  if (fromEnv('DRC_SERVER_URL')) merged.serverUrl = env.DRC_SERVER_URL as string
  if (fromEnv('DRC_HOST_LABEL')) merged.hostLabel = env.DRC_HOST_LABEL as string
  if (fromEnv('DRC_HOST_ID')) merged.hostId = env.DRC_HOST_ID as string
  if (fromEnv('DRC_PAIR_ON_START_SEC')) merged.pairOnStartSec = envSeconds(env.DRC_PAIR_ON_START_SEC)
  // 界面那一半的开关：live 取证要"只验配对链路、不要弹图"时用它。与其余开关同样是
  // 1/0/true/false，其余值不猜、退回上层。
  if (fromEnv('DRC_PILL')) merged.pill.enabled = envFlag(env.DRC_PILL, merged.pill.enabled)
  if (fromEnv('DRC_MOCK_BRIDGE') === '1') merged.mockBridge = true
  // 新建会话的项目目录：给运维一个不改 yaml 的口子（空 = 跟着最近一条会话走）。
  if (fromEnv('DRC_NEW_SESSION_CWD')) merged.newSessionCwd = env.DRC_NEW_SESSION_CWD as string
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
  // `.inf` / NaN 也要判：`Infinity <= 0` 是 false，只判正负号会把它放过去，
  // 而 Infinity 的语义是"这张码永不过期"——与兄弟字段（pairOnStartSec 等）同一条规矩。
  if (!secondsSchema.safeParse(config.pairTtlMs).success || config.pairTtlMs <= 0) {
    problems.push({ level: 'warn', field: 'pairTtlMs', message: '必须是正的有限毫秒数，已夹回 120000' })
    config.pairTtlMs = 120_000
  }
  if (!secondsSchema.safeParse(config.pairOnStartSec).success || config.pairOnStartSec < 0) {
    // patch 文件里写 `pairOnStartSec: .inf` 也会走到这里：env 侧已经折掉了，注入侧不能漏。
    problems.push({ level: 'warn', field: 'pairOnStartSec', message: '必须是非负的有限秒数，已折回 0（关闭自动发码）' })
    config.pairOnStartSec = 0
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
  if (!secondsSchema.safeParse(config.restoredIdleTtlSec).success || config.restoredIdleTtlSec <= 0) {
    // 同上：0 不是"永不剪"，恢复出来的通道同样不许无界。
    problems.push({
      level: 'warn',
      field: 'restoredIdleTtlSec',
      message: '必须是正数秒；这里不接受"永不剪枝"（无界的 PSK 簿是复核 🟡8 的原始缺陷），已夹回 604800',
    })
    config.restoredIdleTtlSec = 604_800
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
  } else if (!config.statusFile.startsWith('/')) {
    /**
     * 相对路径必须说清楚它会落在**哪里**（2026-10-07 审计）。
     *
     * 这里原来只有 `!config.statusFile` 一道真值检查：它不 trim、也不要求绝对路径。
     * 而 `StatusFile` 是 `mkdirSync(path.dirname(file))` + `writeFileSync`，
     * 相对路径按**宿主进程的 CWD** 解析——GUI 宿主的 CWD 是 `/`，于是写不进去，
     * 失败被 `StatusFile.write` 那个空 catch 吞掉。
     *
     * 症状是这个仓里最贵的一种：插件正常加载、status.json 从不出现、
     * **没有 problems、没有日志、没有任何探针**说得出为什么 —— 而那正是
     * "唯一排错入口"消失之后的样子。
     *
     * 刻意**只告警不改道**（与 `resolvePairStoreFile` 同一条纪律）：
     * 静默改到一个用户没要求的路径，比让他看见自己写错了更难查。
     */
    problems.push({
      level: 'warn',
      field: 'statusFile',
      message:
        `必须是绝对路径：相对路径按宿主进程的当前目录解析，而 GUI 宿主的 CWD 是 /（写不进去，状态快照会静默消失）。` +
        `收到 ${JSON.stringify(config.statusFile)}，建议写成 ~/.dsh/dsh-remote-control/status.json 这样的绝对路径`,
    })
  }
  /**
   * 剩下这几个数字字段原来是**一个都不夹**的（头注却承诺"其余一律 warn + 夹回默认值"）：
   * - `approvalTimeoutSec: NaN` → `setTimeout(NaN)` 立刻触发 = 审批**瞬间超时**，
   *   而且没有任何一行日志会说这件事；
   * - `listingRefreshSec: 0` / 负值 / NaN → 刷新节拍变成热循环（0ms 自续期）；
   * - `maxFileBytes: NaN` → 每个文件都被判超限（NaN 比较恒 false，两个方向都失控）。
   * 统一走这一条：非有限或越界就 warn + 夹回默认值（与 idleReleaseSec 同形）。
   */
  clampSeconds(config, problems, 'approvalTimeoutSec', 1, 180)
  clampSeconds(config, problems, 'listingRefreshSec', 1, 15)
  if (!secondsSchema.safeParse(config.maxFileBytes).success || config.maxFileBytes < 1) {
    problems.push({
      level: 'warn',
      field: 'maxFileBytes',
      message: `必须是正的有限字节数，已夹回 ${MAX_ATTACHMENT_BYTES}（512KB）`,
    })
    config.maxFileBytes = MAX_ATTACHMENT_BYTES
  } else if (config.maxFileBytes > MAX_ATTACH_TOTAL_BYTES) {
    /**
     * **调大它不会生效**，而原来一句提示都没有（2026-10-07 审计）。
     *
     * `runtime` 传下去的是 `maxBytesPerFile: maxFileBytes` 与
     * `maxTotalBytes: MAX_ATTACH_TOTAL_BYTES`——后者是硬的（整批预算，与中继的
     * 1MB 帧上限同源）。所以把 `maxFileBytes` 设成 2MB 的结果是：一个 600KB 的文件
     * 被**整批闸**拒掉，而回给手机的话是
     * "这一批附件合计 512KB，超过整批上限 512KB（第 1 个文件让它超了，请少带几个）"
     * ——用户只带了**一个**文件，却被告知"少带几个"。
     *
     * 与 `resolvePairStoreFile` 同一条纪律：不静默改道，改道要说出来。
     */
    problems.push({
      level: 'warn',
      field: 'maxFileBytes',
      message:
        `整批附件的预算是 ${MAX_ATTACH_TOTAL_BYTES} 字节（中继 1MB 帧上限的同源口径），` +
        `单个文件的上限调过它不会生效；已夹回 ${MAX_ATTACH_TOTAL_BYTES}`,
    })
    config.maxFileBytes = MAX_ATTACH_TOTAL_BYTES
  }
  return problems
}

/** 秒数字段的统一夹取：非有限或小于 `min` 一律 warn + 夹回默认值（见 validateConfig 末尾）。 */
function clampSeconds(
  config: PluginConfig,
  problems: ConfigProblem[],
  field: 'approvalTimeoutSec' | 'listingRefreshSec',
  min: number,
  fallback: number,
): void {
  if (secondsSchema.safeParse(config[field]).success && config[field] >= min) return
  problems.push({
    level: 'warn',
    field,
    message: `必须是不小于 ${min} 的有限秒数，已夹回 ${fallback}`,
  })
  config[field] = fallback
}

/** 令牌脱敏：日志与 status.json 里都只允许出现这个形态。 */
export function redact(value: string): string {
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}…${value.slice(-2)}(${value.length})`
}
