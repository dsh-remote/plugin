/**
 * user-config — 设置页「进阶」那一栏写下的自定义项（自部署地址 / 自己的 token）。
 *
 * ## 为什么是一个**独立的落盘文件**，而不是直接改 `cordis.patch.yml`
 *
 * 用户的 profile 里那份 patch 是**宿主与别的插件共用的**、而且是有注释的 YAML：
 * 让一个网页表单去改它，等于让"点一下保存"变成一次会吃掉注释、写坏别人配置的改写。
 * 本文件是**我们自己的**一个 JSON，坏了也只坏我们这一半。
 *
 * ## 它在配置优先级里的位置
 *
 * `环境变量 > patch 注入 > 本文件 > 默认值`（`readConfig` 的第三个入参）。
 *
 * - 排在 patch **之下**：手写 `cordis.patch.yml` 的人（自部署的常态）仍然说了算，
 *   一个网页表单不许悄悄盖掉他自己写下的那一行。
 * - 排在默认值**之上**：装完就能用的默认值是官方中继，自部署的人在设置页改一次就生效。
 *
 * ⚠️ 被 patch 盖掉时**不能静默**：设置页读回来的回答里带 `source`，
 * 那一栏会写明"当前由 patch 决定"，否则用户会以为"保存没生效"（而其实是生效了、被压住了）。
 *
 * ## 三条纪律
 *
 * 1. **落盘走 `platform/secure-file.ts`**（0600 + 原子写 + fsync）——文件里可能有 token。
 * 2. **读不认识的内容一律降级成"没有自定义"**，绝不抛：`apply()` 不许向外抛。
 * 3. **写进去之前先校验**（scheme / 长度），并且**空串 = 删掉这一项**
 *    （"清空输入框再保存"必须能把一项恢复成默认，否则表单没有退路）。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { writeSecure } from '../platform/secure-file.js'
import { dataDir } from '../platform/paths.js'

/**
 * 自定义项。**只有这两项**：其余配置属于"改代码/patch 的人"，不属于设置页。
 *
 * ⚠️ 取值 `undefined` 表示**"用户要删掉这一项"**（清空输入框再保存），它只在
 * "表单 → 归一 → 落盘"这条路上有意义：落盘时 `JSON.stringify` 会丢掉这些键，
 * 而 `readConfig` 也会把它们滤掉（见那里的注释）。**从盘上读出来的对象里不会有它**。
 */
export interface UserOverrides {
  serverUrl?: string | undefined
  hostToken?: string | undefined
}

/** 落盘文件名。与 `status.json` / 密钥簿同目录。 */
const USER_CONFIG_FILE = 'user-config.json'

/** token 输入框的上限：够长（48 位是认领的形状，运维自己的可能更长），又能拦住整段粘贴。 */
const MAX_TOKEN_INPUT = 256

export type LogFn = (message: string, fields?: Record<string, string | number | boolean | undefined>) => void

/** 落点：`status.json` 同目录（`statusFile` 为空时退到运行时数据目录）。 */
export function resolveUserConfigFile(statusFile: string): string {
  const base = statusFile ? path.dirname(statusFile) : dataDir()
  return path.join(base, USER_CONFIG_FILE)
}

/**
 * 校验并归一一份**来自表单**的输入。返回 error 时不写盘，由路由回 400 + 那句话。
 *
 * ## 两个语义都靠"**key 在不在**"表达
 *
 * - **key 不在** = 表单没提交这一项 ⇒ 调用方保持原值（"只改地址、口令不动"是常态）；
 * - **key 在而取值为空串** = 用户**清空**了它 ⇒ 返回值里这一项是 `undefined`（"删掉它"）。
 *
 * ⚠️ 所以判"在不在"必须用 `in`，**不能用 `!== undefined`**：后者把
 * `{ serverUrl: '' }`（用户清空了地址）与 `{}`（没提交地址）判成同一件事，
 * 于是"恢复默认"那颗按钮会**静默什么都不做**（第一版就这么写的，判据当场抓出来）。
 */
export function normalizeUserOverrides(input: {
  serverUrl?: unknown
  hostToken?: unknown
}): { ok: true; value: UserOverrides } | { ok: false; field: string; error: string } {
  const value: UserOverrides = {}
  if ('serverUrl' in input) {
    if (typeof input.serverUrl !== 'string') return { ok: false, field: 'serverUrl', error: 'must be a string' }
    const trimmed = input.serverUrl.trim()
    if (trimmed === '') {
      value.serverUrl = undefined
    } else {
      // 与 `config.ts` 的 `wsUrl` 同一条判据：这里放行了，validateConfig 那边也是 error。
      if (!/^wss?:\/\/.+/.test(trimmed)) {
        return { ok: false, field: 'serverUrl', error: 'must start with ws:// or wss://' }
      }
      value.serverUrl = trimmed
    }
  }
  if ('hostToken' in input) {
    if (typeof input.hostToken !== 'string') return { ok: false, field: 'hostToken', error: 'must be a string' }
    const trimmed = input.hostToken.trim()
    if (trimmed === '') {
      value.hostToken = undefined
    } else {
      if (trimmed.length > MAX_TOKEN_INPUT) {
        return { ok: false, field: 'hostToken', error: `must be at most ${MAX_TOKEN_INPUT} characters` }
      }
      value.hostToken = trimmed
    }
  }
  return { ok: true, value }
}

/**
 * 读盘上的自定义项。**读不到 / 坏了 / 形状不对一律当"没有"**，绝不抛。
 *
 * 逐项判而不是整份丢弃：一份文件里 `serverUrl` 写对了、`hostToken` 被手改成数字，
 * 正确的做法是"用对的那一项、忽略错的那一项"，并把错的那一项记出来。
 */
export function readUserConfig(file: string, log?: LogFn): UserOverrides {
  if (!file) return {}
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    // 没写过是常态（绝大多数用户不改这一栏），不记日志。
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    log?.('user-config is not JSON, ignoring it', { file: path.basename(file) })
    return {}
  }
  if (!parsed || typeof parsed !== 'object') {
    log?.('user-config has an unknown shape, ignoring it', { file: path.basename(file) })
    return {}
  }
  const record = parsed as { serverUrl?: unknown; hostToken?: unknown }
  /**
   * **逐项判**，而不是整份一起判。
   *
   * 一份文件里 `serverUrl` 写对了、`hostToken` 被手改成数字，正确的做法是
   * "用对的那一项、忽略错的那一项"——整份丢弃会让用户"两个都要重填"。
   *
   * ⚠️ 判"这一项在不在文件里"必须用 `in`，不能靠传 `undefined` 进 `normalizeUserOverrides`：
   * 那个函数的语义是"key 在 = 用户动过它"，传一个 `hostToken: undefined` 的字面量
   * 会被判成"提交了一个不是字符串的东西" ⇒ **一份只有 serverUrl 的文件会被整份拒掉**。
   */
  const value: UserOverrides = {}
  for (const field of ['serverUrl', 'hostToken'] as const) {
    if (!(field in record)) continue
    const one = normalizeUserOverrides({ [field]: record[field] })
    if (!one.ok) {
      log?.('user-config item ignored', { field, reason: one.error })
      continue
    }
    // 空串（用户清空过、文件是手改的）在归一结果里是 `undefined`：**读回来时当它不存在**。
    // 留着它会以"把默认值抹成 undefined"的形式传下去（`readConfig` 里那条注释）。
    const kept = one.value[field]
    if (typeof kept === 'string') value[field] = kept
  }
  return value
}

/**
 * 写自定义项（0600 + 原子写）。`savedAt` 只用于排错（"这一栏是什么时候改的"）。
 * 写失败返回 false，**不抛**。
 */
export function writeUserConfig(file: string, overrides: UserOverrides, now: number, log?: LogFn): boolean {
  if (!file) return false
  const body = { version: 1, ...overrides, savedAt: now }
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeSecure(file, JSON.stringify(body, null, 2) + '\n')
    return true
  } catch (error) {
    log?.('user-config save failed', { message: String((error as Error)?.message ?? error).slice(0, 120) })
    return false
  }
}
