/**
 * mp-code — 向中继要**这一枚配对码的小程序码**（2026-10-21）。
 *
 * ## 它解决什么
 *
 * 旧路径是宿主自己把 `dshr:/p?…&psk=…` 渲成二维码：**密钥在码里**，谁扫到谁就有密钥。
 * 新路径（`docs/PAIRING-ONE-CODE.md` 的乙′）是码里**只有 6 位配对码**，密钥由主机
 * 在用户比对过 6 位确认码之后，用一次性 X25519 加密送给手机 —— 微信扫这张码
 * 直接进小程序并完成配对，中继依旧零知识。
 *
 * 小程序码由**中继**签发（它持有小程序的 appSecret）：`GET <relay>/code?token=NNNNNN`。
 * ⇒ 这一层的全部职责就是"去要一张图，要不到就说实话"，绝不自造一张。
 *
 * ## 三条形状决定
 *
 * 1. **失败必须便宜。** `pairing.png` 每次开弹窗、每次换码都会被打到，而"这台中继
 *    没配小程序"是**常态**（自部署者拿不到 appSecret）。没有负缓存就会变成
 *    "每开一次弹窗打一次外网"。⇒ 失败按原因缓存一段时间（`FAIL_TTL_MS`）。
 * 2. **成功按 token 缓存。** 一枚配对码只对应一张图，且它在几分钟内会被反复请求
 *    （`<img>` 重挂、重画）。缓存上限 `MAX_ENTRIES`，超了丢最旧的。
 * 3. **成败看字节，不看 HTTP 状态。** 与中继侧 `mpcode.ts` 同一条纪律：微信的
 *    失败回答也可能是 200 + 一段 JSON。⇒ 这里再验一次 JPEG 魔数（`FF D8`）。
 */

/** 中继上取小程序码的路径（与 `packages/relay/src/server.ts` 同一个字面量）。 */
export const MP_CODE_PATH = '/code'

/** 成功缓存的上限。配对码同时最多一枚，这个数只是防"长期不换码也不清"的兜底。 */
const MAX_ENTRIES = 8
/** 一张图的缓存时长（毫秒）：一枚配对码最长也就活几分钟，跟着它走。 */
export const IMAGE_TTL_MS = 5 * 60_000
/** 失败结论的缓存时长（毫秒）：够挡住"每次重画都打一次外网"，又不至于永久记错。 */
const FAIL_TTL_MS = 60_000
/** 单次请求的超时（毫秒）。渲染一张图的路上不许无限等。 */
export const MP_CODE_TIMEOUT_MS = 5_000

/** 只用到 fetch 面里很小的一块，抽出来是为了判据能注入一个假 fetch（不联网）。 */
export type MpCodeFetch = (
  input: string,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<{ ok?: boolean; status?: number; arrayBuffer?: () => Promise<unknown> } | undefined>

export interface MpCodeDeps {
  /** 中继地址（`ws(s)://…`；换成 `http(s)` 去取码）。 */
  serverUrl: string
  fetchImpl?: MpCodeFetch
  timeoutMs?: number
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
}

/** 取码接口**为什么返回 undefined**：地址不是 ws(s)，拼不出 http(s) URL（配置校验会另报）。 */
export function mpCodeUrlFor(serverUrl: string): string | undefined {
  let url: URL
  try {
    url = new URL(serverUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  /**
   * 路径前缀**保留**再拼固定路径（`docs/RELEASE-CADENCE.md` §3.1，2026-10-23）。
   *
   * 旧纪律是"路径整个替换"（防地址尾巴带杂路径拼出不存在的路由）——但 `/v05`
   * 这类路径分段是**路由前缀**（nginx 剥前缀转给验证/生产实例），覆盖掉它会让
   * 取码打到根路径那套实例、配对却走 /v05 ⇒ 码根本认领不到（"扫了没反应"）。
   * "前缀 + 固定路径"的形状同样兜住旧风险：无论前缀是什么，最终都是 `<前缀>/code`。
   * 与 `claim-token.claimUrlFor` 同一条纪律（那边是 /api/claim-token）。
   */
  const prefix = url.pathname.replace(/\/+$/, '')
  url.pathname = prefix + MP_CODE_PATH
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** 失败的原因分类：`status.json` 的读数只认这几种，排错时够定位在哪一档。 */
export type MpCodeState =
  'unknown' | 'ok' | 'bad-url' | 'no-fetch' | 'unreachable' | 'not-configured' | 'http' | 'shape'

interface Entry {
  /** 有图才非 null；null 表示"这一档失败"，`state` 说清是哪一档。 */
  bytes: Buffer | null
  state: MpCodeState
  at: number
}

/**
 * 建一个取码器。
 *
 * `codeFor(token)` **永不抛**，取不到返回 `null` —— 调用方（`pairing.png`）据此回
 * **503 `mp_code_unavailable`**。3.2 起**没有回落**：屏幕上的码只有这一种来源，
 * 取不到就是这一格空着（回落会让用户对着一张"看起来能扫、其实不是同一件事"的图）。
 */
export function createMpCodeFetcher(deps: MpCodeDeps) {
  const cache = new Map<string, Entry>()
  /** 不依赖具体是哪一枚码的失败结论（地址错 / 没配 / 连不上），按整台中继记一份。 */
  let globalFail: Entry | undefined
  const timeoutMs = deps.timeoutMs ?? MP_CODE_TIMEOUT_MS
  const log = deps.log

  const prune = (now: number): void => {
    for (const [key, entry] of cache) {
      if (now - entry.at > IMAGE_TTL_MS) cache.delete(key)
    }
    if (cache.size > MAX_ENTRIES) {
      const oldest = [...cache.keys()].slice(0, cache.size - MAX_ENTRIES)
      for (const key of oldest) cache.delete(key)
    }
  }

  const alive = (entry: Entry | undefined, now: number, ttl: number): Entry | undefined =>
    entry && now - entry.at <= ttl ? entry : undefined

  return {
    /**
     * 最近一次的结果状态。
     *
     * 只读缓存，绝不发请求：`/status` 是 2 秒一次的热路径，在这里等一次外网就是给整页 UI
     * 装一个随机卡顿。3.2 起没有 `kindFor()` 了——那玩意回答的是"屏幕上该放小程序码还是
     * 旧码"，而旧码已经不存在，它只剩一个恒真的分支。
     */
    state(): MpCodeState {
      const now = Date.now()
      for (const entry of cache.values()) if (entry && now - entry.at <= IMAGE_TTL_MS) return entry.state
      return alive(globalFail, now, FAIL_TTL_MS)?.state ?? 'unknown'
    },

    async codeFor(token: string): Promise<Buffer | null> {
      const now = Date.now()
      prune(now)

      // 负缓存优先：这台中继刚说过"没有/连不上"，就别再打一次外网。
      const failed = alive(globalFail, now, FAIL_TTL_MS)
      if (failed) return null

      const hit = alive(cache.get(token), now, IMAGE_TTL_MS)
      if (hit) return hit.bytes

      const base = mpCodeUrlFor(deps.serverUrl)
      if (!base) {
        globalFail = { bytes: null, state: 'bad-url', at: now }
        return null
      }
      const fetchImpl = deps.fetchImpl
      if (!fetchImpl) {
        globalFail = { bytes: null, state: 'no-fetch', at: now }
        return null
      }

      let state: MpCodeState = 'unknown'
      try {
        const signal =
          typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(timeoutMs)
            : undefined
        const response = await fetchImpl(`${base}?token=${encodeURIComponent(token)}`, {
          method: 'GET',
          ...(signal ? { signal } : {}),
        })
        const status = typeof response?.status === 'number' ? response.status : 0
        if (response?.ok === true) {
          const buffer = await response.arrayBuffer?.()
          const bytes = buffer instanceof ArrayBuffer ? Buffer.from(new Uint8Array(buffer)) : undefined
          /**
           * 成败看字节：中继在"微信没给图"时回的是 502，但**自己也可能有别的 200 回答**。
           * JPEG 魔数 `FF D8` 是唯一可信的判据（与中继侧 `mpcode.ts` 同一条）。
           */
          if (bytes && bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
            cache.set(token, { bytes, state: 'ok', at: Date.now() })
            return bytes
          }
          state = 'shape'
        } else {
          // 501 = 这台中继没配 appId/secret（自部署的常态，不是故障）。
          state = status === 501 ? 'not-configured' : 'http'
        }
      } catch {
        state = 'unreachable'
      }

      globalFail = { bytes: null, state, at: Date.now() }
      log?.('取小程序码失败：这一格会空着（503 mp_code_unavailable）', { state })
      return null
    },
  }
}
