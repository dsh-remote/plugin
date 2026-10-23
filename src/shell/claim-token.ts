/**
 * claim-token — 没有 host token 时向中继**认领**一枚，并落盘（`host-token.json`）。
 *
 * ## 它解决的是哪一件事
 *
 * 目标形态是「插件装完就能用」：`npm i` 之后**什么都不用配**。而 token 是主机与中继
 * 之间的共享密钥，此前唯一的入口是用户把它写进 `cordis.patch.yml` / 环境变量
 * —— 于是"装完不能用"是默认结局（用户原话：下载下来发现不能用，直接就卸载了）。
 *
 * ⇒ 启动时若 **env / patch / 用户配置 / 盘上**都没有 token，就向
 * `POST <中继>/api/claim-token` 认领一枚。
 *
 * ## 为什么是"认领"而不是"索取"（服务端那一半的理由见 relay `server.ts`）
 *
 * 中继是公网服务：一个"谁来问都给 token"的接口等于把 token 公开。所以中继那边领到的是
 * **一枚新签的** token。本文件只负责"领、验形状、落盘、下次先读盘"，不负责鉴权策略。
 *
 * ## ⚠️ 认领时必须带上 `hostId`（2026-10-11 起，C 方案）
 *
 * 旧的中继是「**全局单令牌 + 认领即轮换**」：任何一台机器认领，其他人的令牌**当场作废**，
 * 而主机侧"盘上有 token 就不再认领"⇒ 被顶掉的那台**永久连不上**。那天本机一天内被
 * 另外三台机器各顶掉一次（nginx 日志里三个公网 IP，UA 都是 `node`）。
 *
 * 现在中继按 `hostId` 一机一枚：**认领只顶掉这台机器自己旧的那一枚**。
 * ⇒ 请求体**必须**带 `{hostId}`（2026-10-11 晚起中继不带体一律回 400
 * `host_id_required`，没有"未绑定槽位"那条兼容路了 —— 那枚令牌对谁都算数，
 * 等于给无认证的认领接口留了一把能冒充任何主机的万能钥匙）。
 * 本文件因此在**没有 hostId 时直接判失败**（`no-host-id`），绝不凭空编一个身份。
 *
 * 因此落盘也记下 `hostId`：`host-id` 变了（用户删了 host-id 文件 / 换了数据目录）时，
 * 盘上那枚属于**上一个身份**，拿它去连只会一直 `bad_token`。所以 hostId 对不上时
 * 当它不存在，重新认领；而**同一身份**下令牌被别人顶掉的那种情况，由 `index.ts` 的
 * 自愈路径兜（收到 `bad_token` 就带自己的 hostId 重新认领并重连）。
 *
 * ## 三条纪律（都是本仓栽过的形状）
 *
 * 1. **落盘走 `platform/secure-file.ts`**，与 `status.json` / 密钥簿**同一条 0600 路径**。
 *    token 是凭据：新开一条写文件的路就等于新开一处会忘掉 chmod / 忘掉 fsync 的地方
 *    （A2 的整个理由）。这里连临时文件名都不自己拼。
 * 2. **认领失败不抛、不阻断启动**。没有 token 的结果是"这台主机连不上中继"，
 *    而不是"插件起不来"（`index.ts` 的红线：`apply()` 不许向外抛）。
 *    调用方拿到 `undefined` 时照旧走原来的路（有 patch token 的话压根不会走到这里）。
 * 3. **形状必须定长校验**（48 位十六进制）。中继侧 `tokenMatches` 是**定长比较**，
 *    长度变了不会报错、只会让所有已装机的主机**静默**连不上（`server.ts` 的注释）。
 *    所以"收到一个怪东西"必须当成失败，而不是原样落盘 —— 那会把一次网络故障
 *    变成一次静默的、要人去查文件的故障。
 *
 * ## 为什么落盘带 `serverUrl`
 *
 * 换一台中继（自部署 / 换域名）之后，盘上那枚 token 属于**上一台**中继。
 * 拿它去连新中继只有两种结果：被拒（白试一次），或者更糟——把旧中继的凭据
 * 送给了一台陌生的服务器。⇒ 只在 `serverUrl` 逐字相同时才认这枚 token。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { ensureSecureDir, writeSecure } from '../platform/secure-file.js'
import { dataDir } from '../platform/paths.js'

/** 认领接口的路径（中继侧 `server.ts` 里同一个字面量）。 */
const CLAIM_PATH = '/api/claim-token'

/**
 * 中继发出来的 token 形状：**48 位小写十六进制**（`randomBytes(24).toString('hex')`，
 * 与运维习惯的 `openssl rand -hex 24` 同一个长度口径）。
 *
 * 为什么在客户端也卡死它：见文件头第 3 条。中继那边改了长度而不改这里，
 * 表现是"新装的机器能用、已装机的机器静默连不上" —— 那正是最难查的一种。
 */
export const CLAIMED_TOKEN_PATTERN = /^[0-9a-f]{48}$/

/** 认领请求的超时（毫秒）。启动路径上的网络调用**必须有上限**。 */
const CLAIM_TIMEOUT_MS = 8_000

/** 认领落盘的文件名。与 `status.json` / 密钥簿同目录（同一个 0600 世界）。 */
const HOST_TOKEN_FILE = 'host-token.json'

/** 只用到 fetch 面里很小的一块，抽出来是为了判据能注入一个假 fetch（不联网）。 */
export type FetchLike = (
  input: string,
  init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string>; body?: string },
) => Promise<{ ok?: boolean; status?: number; json?: () => Promise<unknown> } | undefined>

export interface ClaimDeps {
  serverUrl: string
  /**
   * 本机的主机身份。**必给**（2026-10-11 晚起）：中继那边没有"未绑定槽位"了，
   * 不带 hostId 的认领会回 400 `host_id_required`。
   *
   * 为什么不在这里兜一个默认值：**凭空编一个身份**会让中继把令牌绑到错误的槽位上
   * —— 那台机器下次拿自己的 hostId 去连就是 `bad_token`，而它盘上有令牌、不会自动重领，
   * 于是"插件连不上"且看不出原因。宁可当场判失败（`no-host-id`），把问题留在明处。
   */
  hostId?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
}

export interface StoredHostToken {
  token: string
  serverUrl: string
  source: 'claimed' | 'user'
  savedAt: number
  /**
   * 认领时用的 hostId。**必需**（2026-10-11 晚起）：没有它就说不清这枚令牌属于谁，
   * 而"身份对不上还照用"的表现是那台机器永远 `bad_token`、且盘上那个文件看起来一切正常。
   * 没有老用户，所以不为"缺这个字段的旧文件"留退路 —— 缺了就当这份文件不可用。
   */
  hostId: string
}

/**
 * 认领的结果。**不用 `string | undefined`**：`status.json` 的 `diagnostics.hostToken`
 * 要回答"失败在哪一档"（网络不通 / HTTP 非 200 / 形状不对），而一个 `undefined`
 * 把三档压成了一句"没认领到"，排错时还得回去读日志。
 */
export type ClaimOutcome =
  | { ok: true; token: string }
  | { ok: false; reason: 'bad-url' | 'no-fetch' | 'unreachable' | 'http' | 'shape' | 'no-host-id'; status?: number }

const storedSchema = z.object({
  version: z.literal(1),
  token: z.string().min(1),
  serverUrl: z.string().min(1),
  source: z.enum(['claimed', 'user']),
  savedAt: z.number().finite().nonnegative(),
  /** 必需且非空：见 `StoredHostToken.hostId`。 */
  hostId: z.string().min(1),
})

/**
 * 认领接口的完整 URL：把 `ws(s)://host[:port][/path]` 换成
 * `http(s)://host[:port][/path]/api/claim-token`。
 *
 * 路径前缀**保留**再拼固定路径（`docs/RELEASE-CADENCE.md` §3.1，2026-10-23，
 * 与 `mp-code.mpCodeUrlFor` 同一条纪律）：`/v05` 这类前缀是**路由前缀**
 * （nginx 剥给后端实例），覆盖掉它 = 认领打到根路径那套实例、socket 却走 /v05，
 * 症状是"认领一直 404/认了没反应"。旧纪律"整段替换"让位 ——
 * "前缀 + 固定路径"同样兜住旧风险（无论前缀是什么，末两段固定）。
 * 非 `ws(s)://` 的地址返回 `undefined`（配置校验会另报 error）。
 */
export function claimUrlFor(serverUrl: string): string | undefined {
  let url: URL
  try {
    url = new URL(serverUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  const prefix = url.pathname.replace(/\/+$/, '')
  url.pathname = prefix + CLAIM_PATH
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * 认领落盘的位置：`status.json` 同目录下的 `host-token.json`
 * （`statusFile` 被清空时退到运行时的数据目录 `~/.dsh/dsh-remote-control`——
 * 与 `pair-store` / `uploads` 的兜底同一条规矩）。
 */
export function resolveHostTokenFile(statusFile: string): string {
  const base = statusFile ? path.dirname(statusFile) : dataDir()
  return path.join(base, HOST_TOKEN_FILE)
}

/**
 * 读盘上那枚 token。**只在 `serverUrl` 与 `hostId` 都逐字相同时才算数**（理由见文件头）。
 *
 * 读不到 / 坏了 / 形状不对 / 属于另一台中继 / 属于另一个身份，一律返回 `undefined`
 * 并记一行日志 —— 调用方据此走"认领"那条路，绝不抛（`apply()` 的红线）。
 *
 * ⚠️ `hostId` 是**必需入参**（2026-10-11 晚起）：没有它就无法判断"盘上这枚是不是我的"，
 * 而按它比对正是"换了数据目录 / 删了 host-id 文件之后不会永久连不上"的那条保证。
 * 没有老用户 ⇒ 也不再有"文件里没写 hostId 就照旧用"的退路（那种文件现在直接不可用）。
 */
export function readStoredHostToken(
  file: string,
  serverUrl: string,
  hostId: string,
  log?: ClaimDeps['log'],
): string | undefined {
  if (!file) return undefined
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    // 最常见的原因是"还没写过"（第一次装），所以不记 —— 否则每次启动都刷一条假警报。
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    log?.('host-token file is not JSON, ignoring it', { file: path.basename(file) })
    return undefined
  }
  const shape = storedSchema.safeParse(parsed)
  if (!shape.success) {
    log?.('host-token file has an unknown shape, ignoring it', { file: path.basename(file) })
    return undefined
  }
  if (shape.data.serverUrl !== serverUrl) {
    // 换中继（自部署 / 换域名）是正常操作，不是错误：那枚 token 属于上一台中继。
    log?.('host-token belongs to another relay, ignoring it', {
      fileRelay: shape.data.serverUrl.slice(0, 80),
      currentRelay: serverUrl.slice(0, 80),
    })
    return undefined
  }
  if (!CLAIMED_TOKEN_PATTERN.test(shape.data.token)) {
    // 长度/字符集不对 ⇒ 拿它去连只会"静默连不上"（定长比较），所以当没有。
    log?.('host-token shape is unexpected, ignoring it', { tokenLength: shape.data.token.length })
    return undefined
  }
  /**
   * 盘上那枚是**绑在某个身份上的**：身份对不上就当它不存在（调用方会重新认领）。
   *
   * 拿 A 的令牌去连 B 的槽位只会一直 `bad_token`，而插件有令牌就不再认领 ——
   * 那台机器会**永久连不上**，且盘上那个文件看起来一切正常。
   */
  if (shape.data.hostId !== hostId) {
    log?.('host-token was issued for another host id, ignoring it', {
      // 两个 id 都不是秘密（它们本来就出现在中继日志里），但要截断以防被塞进超长串。
      storedHostId: shape.data.hostId.slice(0, 64),
      currentHostId: hostId.slice(0, 64),
    })
    return undefined
  }
  return shape.data.token
}

/**
 * 落盘一枚 token（0600 + 原子写，走 `SecureFilePort`）。
 *
 * 返回是否写成功。**写失败不抛**：本次运行仍能用这枚 token 连上，
 * 只是下次重启要重新认领一次 —— 那是可接受的退化（与 `pair-store` 同一条纪律）。
 */
export function writeStoredHostToken(
  file: string,
  entry: { token: string; serverUrl: string; source: 'claimed' | 'user'; now: number; hostId: string },
  log?: ClaimDeps['log'],
): boolean {
  if (!file) return false
  if (!entry.hostId) {
    // 空身份落盘 = 写一份下次一定读不出来的文件（`storedSchema` 要 `min(1)`）⇒ 当场不写。
    log?.('host-token save skipped: this host has no host id')
    return false
  }
  const body: StoredHostToken & { version: 1 } = {
    version: 1,
    token: entry.token,
    serverUrl: entry.serverUrl,
    source: entry.source,
    savedAt: entry.now,
    hostId: entry.hostId,
  }
  try {
    ensureSecureDir(path.dirname(file))
    writeSecure(file, JSON.stringify(body, null, 2) + '\n')
    return true
  } catch (error) {
    // 日志里**绝不出现 token 本身**（长度足够回答"是不是它没写进去"）。
    log?.('host-token save failed (the claim will be redone after the next restart)', {
      message: String((error as Error)?.message ?? error).slice(0, 120),
      tokenLength: entry.token.length,
    })
    return false
  }
}

/**
 * 向中继认领一枚 token。**永不抛**：失败返回 `{ok:false, reason}`，由调用方决定怎么降级。
 *
 * 判失败的四档各记一条不同的日志（排错时要能一眼分开）：
 * 地址不是 ws(s) / 这一代宿主没有 fetch / 网络不通 / HTTP 不是 200 / 200 但形状不对。
 */
export async function claimHostToken(deps: ClaimDeps): Promise<ClaimOutcome> {
  const { serverUrl, log } = deps
  /**
   * **没有身份就不认领**（2026-10-11 晚）。中继那边不带 hostId 会回 400，
   * 但我们在这里就先停：一条"缺身份"的日志比一条 HTTP 400 更说得清发生了什么，
   * 而且绝不会去动中继上的任何槽位。
   */
  const hostId = deps.hostId?.trim()
  if (!hostId) {
    log?.('cannot claim a host token: this host has no host id')
    return { ok: false, reason: 'no-host-id' }
  }
  const url = claimUrlFor(serverUrl)
  if (!url) {
    log?.('cannot claim a host token: serverUrl is not a ws(s):// address', { serverUrl: serverUrl.slice(0, 80) })
    return { ok: false, reason: 'bad-url' }
  }
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
  if (typeof fetchImpl !== 'function') {
    // 这一代宿主没有 fetch（老 Electron 主进程就是这样）。不是错误，只是认领这条路不可用。
    log?.('cannot claim a host token: this host has no fetch()')
    return { ok: false, reason: 'no-fetch' }
  }
  const timeoutMs = deps.timeoutMs ?? CLAIM_TIMEOUT_MS
  let signal: AbortSignal | undefined
  try {
    // `typeof X` 对**未声明**的标识符是安全的，`X?.y` 不是（ReferenceError）——
    // 老宿主的全局里可能真没有 AbortSignal。
    signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined
  } catch {
    signal = undefined
  }
  let status = 0
  let body: unknown
  /**
   * 请求体带上 `hostId`（见文件头）：中继据此把令牌**绑到这一台**，
   * 于是别人认领时顶不掉我们。上面已经挡掉了"没有 hostId"那种情况，
   * 所以这里**恒**带体 —— 中继那边不带体会回 400（没有"未绑定槽位"那条路）。
   */
  const init: { method: string; signal?: AbortSignal; headers?: Record<string, string>; body?: string } = {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId }),
  }
  try {
    const response = await fetchImpl(url, init)
    status = typeof response?.status === 'number' ? response.status : 0
    if (response?.ok === true) {
      try {
        body = await response.json?.()
      } catch {
        body = undefined
      }
    }
  } catch (error) {
    log?.('host token claim failed: the relay is unreachable', {
      message: String((error as Error)?.message ?? error).slice(0, 120),
    })
    return { ok: false, reason: 'unreachable' }
  }
  if (status !== 200) {
    // 429 是限频（正常运维信号）、404 是中继没有这条接口（版本太旧）、503 是停机中。
    // 三种都归"这次没领到"，由调用方降级。
    log?.('host token claim failed: the relay answered with a non-200', { status })
    return { ok: false, reason: 'http', status }
  }
  const token = (body as { token?: unknown } | undefined)?.token
  if (typeof token !== 'string' || !CLAIMED_TOKEN_PATTERN.test(token)) {
    // ⚠️ **不许原样落盘**：中继换成长度而这里没跟上时，症状是"新装的能用、
    // 已装机的静默连不上"（定长比较）。宁可这次不用，也不要埋一颗定时炸弹。
    log?.('host token claim failed: the relay sent an unexpected token shape', {
      tokenLength: typeof token === 'string' ? token.length : 0,
    })
    return { ok: false, reason: 'shape' }
  }
  // 中继会把 hostId 原样回给我们。对不上说明**我们问的不是这一台**（配置被改、
  // 中间有代理改写），留一条日志；令牌仍然可用（鉴权由中继按它记的槽位判定）。
  const echoed = (body as { hostId?: unknown } | undefined)?.hostId
  if (hostId && typeof echoed === 'string' && echoed !== hostId) {
    log?.('the relay bound the token to a different host id', {
      sent: hostId.slice(0, 64),
      echoed: echoed.slice(0, 64),
    })
  }
  return { ok: true, token }
}
