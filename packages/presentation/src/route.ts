/**
 * route — 同域只读路由：把"当前这一版配对码在右栏该怎么打开"告诉浏览器那一半。
 *
 * 为什么必须有一条自己的路由：宿主没有"把右栏推开"这种扩展点，能推右栏的只有**浏览器
 * 那一半**的 `ctx.sidebarRight`；而"什么时候该推"这件事只有宿主知道（配对码是宿主发的）。
 * 两个半侧之间没有别的单向通道——转发到前端的事件白名单是写死的 27 条、外挂插件加不进去。
 * 同域只读路由是这条边界上既有的、已被验证的姿势（`@chaoset/provider-usage` 的用量
 * 路由就是这么做的）。
 *
 * 安全姿态**照抄用量路由那一套**（两份实现各自独立、不互相 import，漂移时宁可各自拒绝）：
 * Host 必须环回（挡 DNS 重绑定的导航/表单请求）+ Origin 必须环回或缺席（挡跨站读）。
 * 桌面宿主里 Electron 会在更外层把 `host` / `origin` 头删掉并注入鉴权 cookie
 * （lib/main.js 的 forwardWebRequest），所以这里两条都自然成立；这一层是给
 * "DSH 被当 Web 服务暴露在局域网上"那种挂载方式兜底。
 *
 * 回答的形状：**未知/无码一律 200 + `state:"none"`，不是 404**——客户端要能区分
 * "没有码"和"路由不存在/被拦"，前者是正常状态（没在配对），后者是配置事故。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isUsableSessionId, sessionFileAddress } from './address.js'
import type { PairingSnapshot } from './presenter.js'

export const PAIRING_ROUTE = '/plugins/dsh-remote-control-presentation/pairing'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** 去掉端口与 IPv6 方括号，只留主机名。 */
function hostnameOf(host: string): string {
  const trimmed = host.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end === -1) return trimmed
    const rest = trimmed.slice(end + 1)
    if (rest !== '' && !/^:\d+$/.test(rest)) return trimmed
    return trimmed.slice(0, end + 1)
  }
  const colon = trimmed.lastIndexOf(':')
  if (colon !== -1 && !trimmed.slice(0, colon).includes(':') && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon)
  }
  return trimmed
}

function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOf(host))
}

/** Origin 缺席是合法的：同源 GET 上浏览器本来就可能不带它。 */
function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined) return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  response.end(payload)
}

export interface PairingRouteOptions {
  /** 二维码 PNG 落盘在哪（地址就是按它编的）。 */
  imageFile: string
  /** 当前快照：由宿主侧节拍维护，路由只读。 */
  snapshot(): PairingSnapshot
}

/**
 * 一次配对码查询。
 *
 * `?session=` 由浏览器那一半带上来——**只有它知道自己是哪个会话**。宿主不拿这个值去查
 * 任何东西，只是把它编进地址（编之前按会话 id 的字面形状收窄）。
 */
export function pairingHandler(options: PairingRouteOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    if (request.method !== 'GET') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(request.headers.host) || !originIsLoopback(request.headers.origin)) {
      json(response, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      const url = new URL(request.url ?? '/', 'http://dsh.invalid')
      const sessionId = url.searchParams.get('session')
      const snapshot = options.snapshot()
      if (snapshot.state !== 'ready') {
        json(response, 200, { state: 'none' })
        return
      }
      if (!isUsableSessionId(sessionId)) {
        json(response, 400, { state: 'none', error: 'session parameter required' })
        return
      }
      json(response, 200, {
        state: 'ready',
        epoch: snapshot.epoch,
        address: sessionFileAddress(sessionId, options.imageFile),
        expiresAt: snapshot.expiresAt,
      })
    } catch (error) {
      json(response, 500, { error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/** 最小可注入的 webServer 面（只用到 register，返回值是注销函数）。 */
export interface WebServerLike {
  register(route: { kind: 'exact'; path: string; handler: (request: IncomingMessage, response: ServerResponse) => unknown }): () => void
}

/** 挂上路由；返回注销函数。调用方负责在 fiber 卸载时调它。 */
export function registerPairingRoute(webServer: WebServerLike, options: PairingRouteOptions): () => void {
  return webServer.register({ kind: 'exact', path: PAIRING_ROUTE, handler: pairingHandler(options) })
}
