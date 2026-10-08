/**
 * pill-routes — 状态栏那颗 pill 用的四条同域路由，与它自带的守卫。
 *
 *   `POST /plugins/dsh-remote-control/pairing/new`  点一下要一张能用的码（幂等）
 *   `GET  /plugins/dsh-remote-control/pairing.png`  弹窗里那张二维码图
 *   `GET  /plugins/dsh-remote-control/status`       pill 抬头那句状态 + 点开那三行（中继 / 状态 / 版本）
 *   `POST /plugins/dsh-remote-control/unpair`       退出配对（作废当前那条通道）
 *
 * 四条都是**按需**的：宿主侧不再有"按节拍渲染并落盘"那一半（右栏自动弹码方案 2026-10-03 删除），
 * 图在有人要的时候现渲染，状态在 pill 问的时候现读。
 *
 * 安全姿态分两档，写在同一个文件里但**判据分开**：
 *
 * - 只读那两条：`Host` 必须环回（挡 DNS 重绑定的导航/表单请求），`Origin` 缺席放过
 *   （同源 GET 浏览器本来就可能不带，桌面宿主的转发层还会主动删掉它）。
 * - 会改状态的那**两**条（发码、解配）：跨站判据是**只有同源脚本发得出的自定义头**
 *   `x-drc-pair: 1`。不能拿 `Origin` 当凭据——2026-10-03 在真宿主上点那颗 pill 直接 403，
 *   弹窗上印着 `origin-missing`：桌面宿主转发时会把 `origin` 删掉，"Origin 必须存在"这条前提
 *   在这台宿主上永远不成立。带自定义头则跨站必然先触发 CORS 预检，而这条服务既不响应 OPTIONS
 *   也不发 `Access-Control-*`，浏览器会拦下；HTML 表单更没有设头的口子。
 *   `Origin` 存在时仍要判：环回 http(s) 或宿主自己的自定义 scheme（`dsh-app://app`）算"自己"——
 *   自定义 scheme 走的是**白名单**（`HOST_ORIGIN_SCHEMES`），别的扩展 scheme 一律不算。
 *
 * 为什么弹窗的图要我们自己出（而不是 `dsh-resource://file/...`）：那是右栏的文档预览页型
 * 认领的自定义 scheme，pill 里一个 `<img>` 能不能吃它**没有证据**，而
 * `<img src="/plugins/…/pairing.png">` 是同域 HTTP，必然可行。
 *
 * 幂等是刻意的：`ensureFresh()` 只在"当前没有仍然有效的码"时才向中继申请新的。连点三下若
 * 挂出三张有效码，中继的 pending 表就会同时认三个 PSK，而屏幕上显示的是哪一张由时序决定——
 * 那正是当初"多码事故"的形状。
 *
 * 响应里**绝不含 `psk`，也绝不含完整 `qr` URI**（那两条是配对凭据本身）。给的是 `token`
 * （6 位码，本机页面上本来就印着）与剩余寿命；码的 URI 只有渲染成像素之后才离开宿主。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { qrPng } from '../platform/qr.js'

export const PAIR_NEW_ROUTE = '/plugins/dsh-remote-control/pairing/new'
export const PAIR_IMAGE_ROUTE = '/plugins/dsh-remote-control/pairing.png'
export const PAIR_STATUS_ROUTE = '/plugins/dsh-remote-control/status'
export const PAIR_UNPAIR_ROUTE = '/plugins/dsh-remote-control/unpair'

/** 写路由的跨站判据（见文件头）。浏览器面 `client/src/pill.ts` 里是同一个字面量。 */
export const PAIR_MARKER_HEADER = 'x-drc-pair'
export const PAIR_MARKER_VALUE = '1'

/** 一版仍然有效的码（`expiresAt` 是毫秒时刻）。**不带 psk**——红线靠形状成立，不靠下游自律。 */
export interface LivePairing {
  qr: string
  token: string
  expiresAt: number
}

/**
 * pill 上那句"连接状态"与点开看到的那几行（中继 / 状态 / 版本 / 等你处理）：六个非凭据字段，别的一律不出。
 *
 * `serverUrl` 是**已经印在手机上看到的东西**（配对 URI 里就带着它，`status.json` 也有），
 * `version` 是本机装的这一版号，都不是凭据；红线仍然成立——这里没有 `psk`，没有 6 位码，
 * 也没有那条 URI 的任何片段。
 *
 * 本机名（`hostLabel`）2026-10-03 从面板上撤了：它是配置里那个名字，配对时手机上已经看到，
 * 留在弹窗里只是占一行。抬头那句"已配对/未配对"由 `paired`（几台手机连着）与 `pairings`（密钥簿几条会话）两个字段一起决定。
 * 同一轮里 `version` 是**后补的**：面板收成"只有中继一行"之后用户嫌单薄，要凑够三行，
 * 而"跑的是哪一版"在这项目尤其值钱（profile 里可能就是没发布的字节）。
 */
export interface PillStatus {
  /** 与 `status.json` 的 `relay` 同一取值集合：`idle` 是"runtime 还没起来"，不是"断了"。 */
  relay: 'online' | 'connecting' | 'offline' | 'idle'
  /** 当前配对着的手机数量。只允许配一台，所以它是 0 或 1；抬头那句与右上角那颗按钮都读它。 */
  paired: number
  /**
   * 密钥簿里还有几条会话 = 配对还在不在。与 paired（此刻有几台手机连着）是两件事：
   * 手机关了小程序只是 socket 断，簿还在、回前台自动重连（pair-store，D3）。
   * 抬头那句 未配对 / 手机离线 / 已配对 三态与右上角那颗按钮都靠这两个字段分。
   */
  pairings: number
  /** 中继地址（原样），弹窗里那一行要说清连的是哪台。 */
  serverUrl: string
  /** 本机装的这一版号（打包时注入，源码直跑时是 `dev`）。 */
  version: string
  /**
   * 挂在手机上等回答的审批/提问**件数**（0 = 没有）。
   *
   * 这条为什么值得占一个字段：一张挂起的审批阻塞着远端一条正在跑的回合，
   * 而"已配对"这个状态原来把这件事完全遮住——桌面那颗 pill 是它唯一可能被看见的地方。
   * 判据见伞仓 `docs/PRODUCT.md` §3（30 秒原则第 1、2 条）。
   */
  waiting: number
  /** 最久的那一件已经等了多久（秒）。与 `waiting` 成对出现，`waiting=0` 时它是 0。 */
  waitingOldestSec: number
}

export interface PillRouteDeps {
  /**
   * 幂等地保证"有一张能用的码"：已有就直接给现有的，没有才向中继申请。
   * 中继不在线 / runtime 没起来时返回 null（这**不是**错误，是"现在发不出码"）。
   */
  ensureFresh(): LivePairing | null
  /** 只读地看当前有没有仍然有效的码（图片路由用，绝不顺手发码）。 */
  current(): LivePairing | null
  /** 连接状态（pill 抬头那句 + 弹窗那三行）。 */
  status(): PillStatus
  /** 退出配对：作废当前所有配对通道，返回作废的条数。幂等，没有可配对的通道时返回 0。 */
  unpair(): number
  log(message: string, fields?: Record<string, string | number | boolean | undefined>): void
}

/**
 * 一版码的标识：**码文本的 sha256 前 16 位**。
 *
 * 为什么不用 token 本身：这条 epoch 会出现在浏览器可达的路由响应与图片 URL 里，
 * 而码里带着一次性 token 与 PSK。哈希足以判断"换没换"，且泄不出任何可用的东西。
 * 只此一处定义——发码回答、图片 `ETag`、以及 pill 拼的图片 URL 必须同一个口径，
 * 否则弹窗会以为每次都是新码而反复重画。
 */
export function pairingEpoch(qr: string): string {
  return createHash('sha256').update(qr).digest('hex').slice(0, 16)
}

/**
 * 按需现渲染一张码。渲染失败由调用方（图片路由）兜成 500，不许抛到宿主。
 * 编码器只有 `platform/qr.ts` 那一份——它与伞仓 `scripts/validate-qr.mjs` 对拍的是同一个产物。
 */
export async function renderPairingPng(qr: string): Promise<Buffer> {
  return qrPng(qr)
}

// ── 守卫 ────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * 宿主自己的自定义 scheme——**白名单**，不是"非 http(s) 一律放过"。
 *
 * 原来那条写的是 `url.protocol !== 'http:' && url.protocol !== 'https:'` 就放行，
 * 于是 `chrome-extension://<别的扩展>`、`file://`、甚至任何自造 scheme 都算"宿主自己"
 * （2026-10-06 修）。写路由靠 `x-drc-pair` 那个自定义头挡跨站，而装了扩展的浏览器里
 * 扩展页面本来就发得出自定义头——Origin 这道就剩白名单这一层必须准。
 */
const HOST_ORIGIN_SCHEMES = new Set(['dsh-app:'])

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

export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOf(host))
}

/** 只读路由用：Origin 缺席是合法的（同源 GET 常常不带，宿主转发时还会删掉）。 */
export function originIsLoopbackOrAbsent(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  return originLooksLikeTheHostItself(origin)
}

/**
 * Origin 存在时它必须像"这台宿主自己"：环回的 http(s)，或**白名单里**那个宿主自定义 scheme。
 * `dsh-app://app` 这类只有宿主自己能产生；`null`（file:// 文档开的页）与别的扩展 scheme 都不算。
 */
function originLooksLikeTheHostItself(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (HOST_ORIGIN_SCHEMES.has(url.protocol)) return true
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/**
 * 写路由到底被哪一道拦下的，分开报：**403 回答里要带上它**。
 * 这条路由在浏览器里点，宿主 stdout 又不落盘，屏幕上那句话就是唯一的现场。
 * 返回 undefined 表示放行。
 */
export function rejectedBy(request: IncomingMessage): string | undefined {
  if (!hostIsLoopback(request.headers.host)) return 'host-not-loopback'
  if (request.headers[PAIR_MARKER_HEADER] !== PAIR_MARKER_VALUE) return 'pair-marker-missing'
  const origin = request.headers.origin
  if (origin !== undefined && origin.trim() !== '' && !originLooksLikeTheHostItself(origin)) return 'origin-not-trusted'
  return undefined
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  response.end(payload)
}

// ── handler ─────────────────────────────────────────────────────────

/** `POST /pairing/new`：点一下配对。 */
export function pairNewHandler(deps: PillRouteDeps): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (request.method !== 'POST') {
      // 只接受 POST：这条会改状态。GET 请走 `/status` 或图片那条。
      json(response, 405, { error: 'method not allowed' })
      return
    }
    const guard = rejectedBy(request)
    if (guard) {
      deps.log('发码请求被守卫拒', { guard })
      json(response, 403, { error: 'request-not-trusted', guard })
      return
    }
    try {
      const pairing = deps.ensureFresh()
      if (!pairing) {
        // 中继没在线就发不出码。回 200 + 一个明确状态，让 pill 能显示"未连接"，
        // 而不是让前端把 5xx 当成插件坏了。
        json(response, 200, { state: 'unavailable', reason: 'relay-offline' })
        return
      }
      const epoch = pairingEpoch(pairing.qr)
      /**
       * 日志里**不写那个 6 位码**：它就是认领凭据本身，而 stdout 是会被翻出来贴进 issue 的
       * 那种地方（`status.json` 的启动快照同样承诺不含 token，见 `src/pill/start.ts` 那一侧
       * 的 status 快照口径）。排查只需要知道"经状态栏发出了一张码、是哪一版"——epoch 与长度
       * 足够回答这两件事，且都不是凭据。
       */
      deps.log('配对码经状态栏发出', { epoch: epoch.slice(0, 8), tokenLength: pairing.token.length })
      json(response, 200, {
        state: 'ready',
        epoch,
        token: pairing.token,
        expiresInMs: Math.max(0, pairing.expiresAt - Date.now()),
      })
    } catch (error) {
      json(response, 500, { error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/** `GET /pairing.png`：弹窗里那张图，按需现渲染（不依赖磁盘，也不依赖任何侧边栏）。 */
export function pairImageHandler(deps: PillRouteDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(request.headers.host) || !originIsLoopbackOrAbsent(request.headers.origin)) {
      json(response, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      const pairing = deps.current()
      if (!pairing) {
        // 204 而不是 404：路由在、只是现在没有码。pill 据此显示"点一下生成"。
        response.writeHead(204)
        response.end()
        return
      }
      if (request.method === 'HEAD') {
        // HEAD 只回头：**跳过渲染**。原来这里照样编码一整张 PNG 再丢掉，
        // 而探活的请求会按节拍打过来（2026-10-06 修）。Content-Length 也一并省掉——
        // HEAD 允许不带它，要拿到它就得先渲染，那正是这一条要避免的事。
        response.writeHead(200, {
          'Content-Type': 'image/png',
          // 一张码会被就地换掉（半程刷新、被手机用掉），所以绝不许缓存。
          'Cache-Control': 'no-store',
          ETag: `"${pairingEpoch(pairing.qr)}"`,
        })
        response.end()
        return
      }
      const png = await renderPairingPng(pairing.qr)
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': png.length,
        // 一张码会被就地换掉（半程刷新、被手机用掉），所以绝不许缓存。
        // ETag 只是这一版的哈希（排错用）：**pill 判断"换没换码"靠的是 URL 上那个
        // `?e=<epoch>`**，`<img>` 拿不到 ETag，响应本身也是 no-store。
        'Cache-Control': 'no-store',
        ETag: `"${pairingEpoch(pairing.qr)}"`,
      })
      response.end(png)
    } catch (error) {
      json(response, 500, { error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/** `GET /status`：pill 抬头那句连接状态（只读，守卫与图片那条同一档）。 */
export function pillStatusHandler(deps: PillRouteDeps) {
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
      const status = deps.status()
      json(response, 200, {
        relay: status.relay,
        paired: status.paired,
        pairings: status.pairings,
        serverUrl: status.serverUrl,
        version: status.version,
        waiting: status.waiting,
        waitingOldestSec: status.waitingOldestSec,
      })
    } catch (error) {
      json(response, 500, { error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/**
 * `POST /unpair`：弹窗右上角那颗"退出配对"。
 *
 * 与发码同一条守卫（`x-drc-pair`），因为它是写路由：一条跨站请求若能让主机解配，
 * 就等于让任意网页把用户自己的远程通道踢掉。
 *
 * 回 **200 + `{state:'ok', unpaired:n}`**：`n=0` 也是成功（本来就没配上），不是错误——
 * 那颗按钮在"已配对"时才出现，但轮询与点击之间状态可能已经变了，把这种正常竞态
 * 报成 500 只会让面板显示一句看不懂的红字。
 */
export function unpairHandler(deps: PillRouteDeps): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    const guard = rejectedBy(request)
    if (guard) {
      deps.log('解配请求被守卫拒', { guard })
      json(response, 403, { error: 'request-not-trusted', guard })
      return
    }
    try {
      const unpaired = deps.unpair()
      deps.log('经状态栏退出配对', { unpaired })
      json(response, 200, { state: 'ok', unpaired })
    } catch (error) {
      json(response, 500, { error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

// ── 注册 ────────────────────────────────────────────────────────────

/** 最小可注入的 webServer 面（只用到 register，返回值是注销函数）。 */
export interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => unknown
  }): () => void
}

/**
 * 挂上这四条路由；返回一个注销函数（四条一起摘，一条抛了也不许把其余留在宿主上）。
 *
 * ⚠️ 半途失败也必须干净：`webServer.register` 会因为"路由名已被占用"抛错，而四条是**依次**挂的。
 * 不加这层回滚的话，第二条挂不上时第一条就永久留在宿主上、`stop()` 再也拿不到它的注销函数——
 * 表现是"重载一次之后那条路由再也挂不上"（右栏方案当年踩过同一形状，见 install 脚本的退役逻辑）。
 */
export function registerPillRoutes(webServer: WebServerLike, deps: PillRouteDeps): () => void {
  const off: Array<() => void> = []
  const definitions = [
    { kind: 'exact' as const, path: PAIR_NEW_ROUTE, handler: pairNewHandler(deps) },
    { kind: 'exact' as const, path: PAIR_IMAGE_ROUTE, handler: pairImageHandler(deps) },
    { kind: 'exact' as const, path: PAIR_STATUS_ROUTE, handler: pillStatusHandler(deps) },
    { kind: 'exact' as const, path: PAIR_UNPAIR_ROUTE, handler: unpairHandler(deps) },
  ]
  try {
    for (const definition of definitions) off.push(webServer.register(definition))
  } catch (error) {
    for (const unregister of off.splice(0)) {
      try {
        unregister()
      } catch {
        /* 回滚途中再抛就没别的办法了：下面把原始错误抛回去 */
      }
    }
    throw error
  }
  return () => {
    for (const unregister of off) {
      try {
        unregister()
      } catch {
        /* 宿主可能已经先一步拆了 webServer */
      }
    }
  }
}
