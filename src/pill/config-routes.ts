/**
 * config-routes — 设置页「进阶」那一栏用的**一条**同域路由（GET 读 / POST 写）。
 *
 * ⚠️ 注册点仍在 `pill/routes.ts` 的统一入口（七条一起挂、一起回滚）。这里只放 handler
 * 与它自己的判据，因为这一条**不是配对入口**：`available`（"这台主机配不配得了对"）
 * 只由那六条决定，读数混在一起就不可读了。
 *
 * ## 它回答什么
 *
 * - `GET /plugins/dsh-remote-control/config`
 *   → 当前**生效**的中继地址、token 有没有配上（**只给脱敏形态，绝不给真值**）、
 *     两项各自**由哪一层决定**（env / patch / 设置页 / 默认 / 认领），以及落盘文件在哪。
 * - `POST /plugins/dsh-remote-control/config`（要 `x-drc-pair: 1`）
 *   → 写设置页那两项自定义。**空串 = 删掉这一项**（回落到下一层）。
 *     回答里带 `restartRequired: true`：中继地址与 token 是**建连接时读一次**的，
 *     改了要重启 Harness 才生效 —— 不说这一句，用户会以为"保存没反应"。
 *
 * ## 两条安全纪律
 *
 * 1. **GET 不许出现 token 真值**（只给 `redact()` 之后的形态与"有没有"）。
 *    这是一条浏览器可达的路由，而 token 是主机与中继之间的共享密钥
 *    （`status.json` 的同一条纪律：那个文件是被设计成"随时贴进工单"的）。
 * 2. **POST 走与发码/解配同一道跨站判据**（`x-drc-pair` 自定义头 + 环回 Host +
 *    Origin 白名单）。它改的是"这台主机连哪台中继"，是一条能改行为的写路由。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { hostIsLoopback, originIsLoopbackOrAbsent, rejectedBy } from './routes.js'
import { normalizeUserOverrides, type UserOverrides } from '../shell/user-config.js'

/** 这一条路由的路径。**与 `pill/routes.ts` 的六条同前缀、同守卫。** */
export const PLUGIN_CONFIG_ROUTE = '/plugins/dsh-remote-control/config'

/** POST body 的上限：这一条只收两个短字符串，8KB 已经宽到离谱（防的是"谁来都读进内存"）。 */
export const MAX_CONFIG_BODY_BYTES = 8 * 1024

/** 这一项当前由哪一层决定。 */
export type ConfigSource = 'env' | 'patch' | 'user' | 'claimed' | 'default' | 'none'

export interface EffectivePluginConfig {
  /** 当前生效的中继地址（会原样印在设置页上，`status.json` 里本来也有）。 */
  serverUrl: string
  /** 代码里的默认值——给"恢复默认"那颗按钮用，前端不必自己抄一份常量。 */
  defaultServerUrl: string
  serverUrlSource: ConfigSource
  /** token **有没有**配上（绝不回真值）。 */
  hostTokenSet: boolean
  /** token 的脱敏形态（`abcd…yz(48)`）——排错时靠它判断"是不是拿错了那一枚"。 */
  hostTokenShape: string
  hostTokenSource: ConfigSource
  /** 设置页写下的自定义项最终落在哪个文件（改坏了去哪儿看）。 */
  userConfigFile: string
}

export interface ConfigRouteDeps {
  /** 现读此刻生效的配置（**每次请求现算**，不在 apply 里缓存一次）。 */
  config(): EffectivePluginConfig
  /** 落盘设置页那两项。返回 error 时路由回 400 并把 `field`/`detail` 一起给出去。 */
  saveConfig(overrides: UserOverrides): { ok: true } | { ok: false; field: string; error: string }
  log(message: string, fields?: Record<string, string | number | boolean | undefined>): void
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  response.end(payload)
}

/**
 * 读 POST body 并 JSON.parse。**永不抛**：超限/坏 JSON 都回 `undefined`，由调用方回 400。
 * 超限时**不销毁连接**（这条路由是本机页面在打，没必要用 destroy 制造"连接被重置"的假象）。
 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (value: unknown): void => {
      if (done) return
      done = true
      resolve(value)
    }
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_CONFIG_BODY_BYTES) {
        finish(undefined)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        finish(text === '' ? {} : JSON.parse(text))
      } catch {
        finish(undefined)
      }
    })
    request.on('error', () => finish(undefined))
  })
}

/** `GET /config`：只读那一档守卫（Origin 缺席合法）。 */
export function configReadHandler(deps: ConfigRouteDeps) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(request.headers.host) || !originIsLoopbackOrAbsent(request.headers.origin)) {
      json(response, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      json(response, 200, deps.config())
    } catch (error) {
      json(response, 500, { error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/** `POST /config`：写路由那一档守卫（`x-drc-pair` 自定义头）。 */
export function configWriteHandler(deps: ConfigRouteDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    const guard = rejectedBy(request)
    if (guard) {
      deps.log('配置写入被守卫拒', { guard })
      json(response, 403, { error: 'request-not-trusted', guard })
      return
    }
    const body = await readJsonBody(request)
    /**
     * 数组也是 `typeof 'object'`：不显式挡掉的话 `POST [1,2,3]` 会**归一成一件事都没提交**
     * 然后回 200 `restartRequired` —— 一条"保存成功"的假回答（中继那条认领接口
     * 同一个位置就用 `!Array.isArray(parsed)` 挡着，两处口径保持一致）。
     */
    if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
      json(response, 400, { error: 'invalid', field: 'body', detail: 'body must be a JSON object' })
      return
    }
    const normalized = normalizeUserOverrides(body as { serverUrl?: unknown; hostToken?: unknown })
    if (!normalized.ok) {
      json(response, 400, { error: 'invalid', field: normalized.field, detail: normalized.error })
      return
    }
    try {
      const saved = deps.saveConfig(normalized.value)
      if (!saved.ok) {
        json(response, 400, { error: 'invalid', field: saved.field, detail: saved.error })
        return
      }
      /**
       * `restartRequired` 不是客套话：中继地址与 token 是 `RelayClient` **建连接时读一次**的
       * （`index.ts` 的 `new RelayClient({ url, token })`），运行中改盘不会重连。
       * 不说这一句，用户会以为"保存没生效"——而它其实生效了，只是要重启。
       */
      deps.log('设置页写入自定义配置', {
        serverUrlSet: normalized.value.serverUrl !== undefined,
        hostTokenSet: normalized.value.hostToken !== undefined,
      })
      json(response, 200, { state: 'ok', saved: normalized.value, restartRequired: true, config: deps.config() })
    } catch (error) {
      json(response, 500, { error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/**
 * 把 GET / POST 分发到两个 handler 上。**注册由 `pill/routes.ts` 的统一入口做**
 * （七条一起挂、一起回滚，见 `registerPillRoutes`）——这里只出 handler。
 */
export function configRouteHandler(deps: ConfigRouteDeps) {
  const read = configReadHandler(deps)
  const write = configWriteHandler(deps)
  return (request: IncomingMessage, response: ServerResponse): unknown =>
    request.method === 'POST' ? write(request, response) : read(request, response)
}
