/**
 * pill-routes — 状态栏那颗 pill（以及设置页那一栏）用的**七条**同域路由，与它自带的守卫。
 *
 *   `POST /plugins/dsh-remote-control/pairing/new`    点一下要一张能用的码（幂等）
 *   `GET  /plugins/dsh-remote-control/pairing.png`    屏幕上那张**小程序码**（中继签发，JPEG）
 *   `GET  /plugins/dsh-remote-control/status`         pill 抬头那句状态 + 点开那三行（中继 / 状态 / 版本）
 *   `POST /plugins/dsh-remote-control/pair/approve`   「数字一致，允许」（小程序码路线的放行）
 *   `POST /plugins/dsh-remote-control/unpair`         退出配对（作废当前那条通道）
 *   `GET|POST /plugins/dsh-remote-control/config`     设置页「进阶」那一栏：自部署地址 / token
 *   `POST /plugins/dsh-remote-control/client-report`  客户端观测口（页面把渲染问题回传给宿主）
 *
 * 七条都是**按需**的：图在有人要的时候现取，状态在 pill 问的时候现读。
 *
 * 安全姿态分两档，写在同一个文件里但**判据分开**：
 *
 * - 只读那**三条**（图片、状态、配置的 GET）：`Host` 必须环回（挡 DNS 重绑定的导航/表单请求），
 *   `Origin` 缺席放过（同源 GET 浏览器本来就可能不带，桌面宿主的转发层还会主动删掉它）。
 * - 其余四条里**发码 / 放行 / 解配 / 写配置**都要**只有同源脚本发得出的自定义头**
 *   `x-drc-pair: 1`（客户端上报 `client-report` 同样要它，虽然只写一份诊断文件）。
 *   不能拿 `Origin` 当凭据——2026-10-03 在真宿主上点那颗 pill 直接 403，
 *   弹窗上印着 `origin-missing`：桌面宿主转发时会把 `origin` 删掉，"Origin 必须存在"这条前提
 *   在这台宿主上永远不成立。带自定义头则跨站必然先触发 CORS 预检，而这条服务既不响应 OPTIONS
 *   也不发 `Access-Control-*`，浏览器会拦下；HTML 表单更没有设头的口子。
 *   `Origin` 存在时仍要判：环回 http(s) 或宿主自己的自定义 scheme（`dsh-app://app`）算"自己"——
 *   自定义 scheme 走的是**白名单**（`HOST_ORIGIN_SCHEMES`），别的扩展 scheme 一律不算。
 *
 * 为什么图要我们自己出（而不是 `dsh-resource://file/...`）：那是右栏的文档预览页型认领的
 * 自定义 scheme，pill 里一个 `<img>` 能不能吃它**没有证据**，而
 * `<img src="/plugins/…/pairing.png">` 是同域 HTTP，必然可行。
 *
 * 幂等是刻意的：`ensureFresh()` 只在"当前没有仍然有效的码"时才向中继申请新的。连点三下若
 * 挂出三张有效码，中继的 pending 表就会同时认三个 PSK，而屏幕上显示的是哪一张由时序决定——
 * 那正是当初"多码事故"的形状。
 *
 * 响应里**绝不含 `psk`**。给的是 `token`（6 位码，本机页面上本来就印着）与剩余寿命；
 * 而那张码本身是**中继**签发的图片，主机从头到尾没有能力把它渲成别的形状。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { configRouteHandler, PLUGIN_CONFIG_ROUTE, type ConfigRouteDeps } from './config-routes.js'

export const PAIR_NEW_ROUTE = '/plugins/dsh-remote-control/pairing/new'
export const PAIR_IMAGE_ROUTE = '/plugins/dsh-remote-control/pairing.png'
export const PAIR_STATUS_ROUTE = '/plugins/dsh-remote-control/status'
export const PAIR_APPROVE_ROUTE = '/plugins/dsh-remote-control/pair/approve'
export const PAIR_UNPAIR_ROUTE = '/plugins/dsh-remote-control/unpair'
/**
 * **不依赖会话的配对页**（2026-08-09 加）。
 *
 * 为什么需要它：pill 挂在宿主的 `conversation.composer.dock` 槽位上，而宿主那条
 * 渲染条件是 `sessionId !== void 0`（宿主产物原句）——**新会话那一屏根本不渲染这个槽位**。
 * 于是"从零开始配对"的人（尤其是 web profile：打开浏览器、还没有任何会话）
 * **找不到任何出码入口**（`/drc pair` 与自动弹码在 2026-10-03 已删）。
 *
 * ⇒ 这一条是同一批凭据的另一扇门，**安全姿态与 pill 完全一致**：
 *   页面本身是只读的 GET（环回 + Origin 守卫），发码仍由页面里的脚本
 *   带 `x-drc-pair` 头去 POST —— 那条跨站判据一个字都没放松。
 */
/** 写路由的跨站判据（见文件头）。浏览器面 `src/client/pill.ts` 里是同一个字面量。 */
export const PAIR_MARKER_HEADER = 'x-drc-pair'

/**
 * 客户端半的自报通道（2026-10-20）：浏览器那一半把"apply 看到了什么"POST 回来，
 * 落到 `~/.dsh/dsh-remote-control/client-report.json`。
 *
 * 为什么需要它：客户端半在宿主里**没有任何可观测出口**（console 只有人打开 DevTools
 * 才看得到），于是"pill 没出现"只能靠猜。这条路由把猜变成读数。
 */
export const CLIENT_REPORT_ROUTE = '/plugins/dsh-remote-control/client-report'
export const PAIR_MARKER_VALUE = '1'

/**
 * 一版仍然有效的码（`expiresAt` 是毫秒时刻）。**不带 psk**——红线靠形状成立，不靠下游自律。
 *
 * 3.2 起这里没有 `qr` 了：屏幕上那张图由**中继**签发（`mpCodeFor(token)`），主机手里
 * 从来没有一段"码的文本"。要判断"换没换"只需 `token`（每张码唯一）。
 */
export interface LivePairing {
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
   * 挂着的配对授权（小程序码路线）：`null` = 没有人在等确认。
   *
   * ⚠️ 2026-10-21 晚起主机**自动放行**，所以这一格只在"还没放行"的那一瞬间有值 ——
   * UI 现在主要读的是 `lastPairApproval`（下面那格）。
   */
  pairApproval: { sas: string; remainSec: number } | null
  /**
   * **最近放行**的那 6 位数字（2026-10-21 晚，主机自动放行之后）：`null` = 这次会话里还没放行过。
   *
   * 放行是"取走即焚"⇒ `pairApproval` 立刻变 null ⇒ 主机界面就再也显示不出那串数字。
   * 而它是**用户唯一能对照的东西**（手机上弹窗一串、主机屏幕上一串，两处一致才说明
   * 中间没人换公钥）⇒ 放行之后仍要留 90 秒给用户对照（`remainSec` 到 0 就该收起）。
   *
   * 它**不是凭据**（真正的凭据在密文里）。
   */
  lastPairApproval: { sas: string; remainSec: number } | null
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
  /**
   * 用户点了「数字一致，允许」（2026-10-21）。
   *
   * 返回 false = 没有可放行的申请（已过期 / 已放行过）——**不能**当成成功，
   * 否则用户会以为配对开始了，而那张申请其实早就作废。
   */
  approvePair(): boolean
  /**
   * 向中继要**这一枚配对码的小程序码**（2026-10-21）。
   *
   * 拿不到返回 `null`（中继没配小程序 / 连不上 / 地址不是 ws(s)）。**不再回落**：
   * 3.2 起码只有这一种，取不到就是"这一格空着"，由 `pairing.png` 回 503。
   */
  mpCodeFor(token: string): Promise<Buffer | null>
  log(message: string, fields?: Record<string, string | number | boolean | undefined>): void
}

/**
 * 一版码的标识：`sha256('dsh-rc/mp-code:' + token)` 的前 16 位。
 *
 * 只回答一件事：**屏幕上这张码换没换**。发码回答里的 `epoch` 与图片路由的 `ETag` 必须同一个
 * 口径，否则弹窗会以为每次都是新码而反复重画。
 *
 * 为什么是哈希而不是 token 本身：ETag 会进浏览器缓存键、可能被截图与日志带走，而 6 位码是
 * **可以直接输进手机**的凭据。哈希不减少任何保密性（`pairing/new` 的回答里本来就给 token），
 * 只是别让"缓存标识"与"可输入的凭据"长成同一个字符串。
 *
 * 域分离前缀 `dsh-rc/mp-code:` 与 `dsh-rc/sas`、`dsh-rc/psk-wrap` 同一套纪律：同一个 sha256
 * 在不同用途上不许撞出同一个值。
 */
export function pairingEpoch(token: string): string {
  return createHash('sha256').update(`dsh-rc/mp-code:${token}`).digest('hex').slice(0, 16)
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

/**
 * 跨源应答（2026-10-20，DSH 0.2.1 桌面版）。
 *
 * 桌面页面在自定义 scheme `dsh-app://` 上，而路由在宿主 HTTP origin 上 ⇒ **每一个请求都是跨源**：
 *  - `fetch(url, {headers:{'x-drc-pair':...}})` 带自定义头 ⇒ 浏览器先发 `OPTIONS` 预检；
 *    原来没有预检分支，回 405 ⇒ 预检失败 ⇒ `fetch` 直接 reject（用户看到的「请求失败」）；
 *  - 即使预检过了，响应缺 `Access-Control-Allow-Origin` 也会被浏览器挡在 JS 之外。
 *
 * **只对"像这台宿主自己"的 Origin 回声**（环回 http(s) 与 `dsh-app:` 白名单，与 `rejectedBy`
 * 同一套判据）：这不让任意网页借道——它们过不了那条 Origin 判据，写路由还有 `x-drc-pair`。
 */
function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request?.headers?.origin
  if (origin === undefined || origin.trim() === '' || !originLooksLikeTheHostItself(origin)) return
  // 夹具里的 response 可能只有 `writeHead/end`（真 ServerResponse 才一定有 `setHeader`）：
  // CORS 是增强项，缺这个能力就安静跳过，不许把"路由本身能应答"变成 500。
  if (typeof response.setHeader !== 'function') return
  try {
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'content-type, x-drc-pair')
    response.setHeader('Access-Control-Max-Age', '600')
  } catch {
    /* 同上：CORS 头写不进去不影响业务应答 */
  }
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
      /**
       * 日志里**不写那个 6 位码**：它就是认领凭据本身，而 stdout 是会被翻出来贴进 issue 的
       * 那种地方（`status.json` 的启动快照同样承诺不含 token，见 `src/pill/start.ts` 那一侧
       * 的 status 快照口径）。排查只需要知道"经状态栏发出了一张码、是哪一版"——epoch 与长度
       * 足够回答这两件事，且都不是凭据。
       */
      const epoch = pairingEpoch(pairing.token)
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

/**
 * `GET /pairing.png`：电脑上那张**小程序码**（2026-10-21 起只有这一种）。
 *
 * 码由**中继**签发（它持有小程序 appSecret）：`GET <relay>/code?token=NNNNNN`。
 * 码里只有 6 位配对码，**没有密钥** —— 密钥是主机在用户比对过两端那 6 位数字之后
 * 用 X25519 加密送回手机的（`pair-request` → `pair-grant`）。
 *
 * ⚠️ 旧的"本机渲 `dshr:` 二维码"那条路已于 3.2 删除：码里带密钥这份形态
 * 既不能微信一扫即入，也把密钥暴露在拍照、截屏、投屏里。
 */
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
        // 204 而不是 404：路由在、只是现在没有码。
        response.writeHead(204)
        response.end()
        return
      }
      const bytes = await deps.mpCodeFor(pairing.token)
      /**
       * 取不到就 **503 + 一句明确的原因**，不回落。
       *
       * 回落成"另一张码"意味着屏幕上会出现一张**用户以为能扫、其实不是同一件事**的图
       * —— 那正是 3.1.x 里两次现场投诉的形状。宁可这一格空着并说清。
       */
      if (!bytes || bytes.length === 0) {
        json(response, 503, { error: 'mp_code_unavailable' })
        return
      }
      response.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': bytes.length,
        // 一张码会被就地换掉（半程刷新、被手机用掉），所以绝不许缓存。
        'Cache-Control': 'no-store',
        ETag: `"${pairingEpoch(pairing.token)}"`,
      })
      if (request.method === 'HEAD') response.end()
      else response.end(bytes)
    } catch (error) {
      json(response, 500, { error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/**
 * `GET /status`：pill 抬头那句连接状态（只读，守卫与图片那条同一档）。 */
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
        // 白名单**逐字**列字段：漏一条就是功能不通，多一条就是凭据外泄。
        pairApproval: status.pairApproval,
        // 2026-10-21 晚：主机自动放行之后，最近放行的那 6 位数字改由这一格带着
        // （放行是"取走即焚"，`pairApproval` 立刻变 null ⇒ 主机界面再也显示不出那串数字，
        // 而它是用户唯一能对照的东西）。它**不是凭据**（真凭据在密文里）。
        //
        // ⚠️ 白名单是**逐字**列的 ⇒ 少列这一条，UI 就读不到它（而 status.json 里有，
        // 于是 e2e 全绿、真机是坏的 —— 这条判据就是为它准备的）。
        lastPairApproval: status.lastPairApproval,
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
/**
 * `POST /pair/approve`：用户确认两端数字一致（2026-10-21）。
 *
 * 与解配同一个守卫形状（`x-drc-pair` + 回环源），**绝不接受跨站来源**：
 * 这一步是"放行 psk"，被跨站页面调一次就等于把零知识交给别人的页面。
 */
export function pairApproveHandler(deps: PillRouteDeps): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    const guard = rejectedBy(request)
    if (guard) {
      deps.log('配对放行被守卫拒', { guard })
      json(response, 403, { error: 'request-not-trusted', guard })
      return
    }
    try {
      const approved = deps.approvePair()
      deps.log('经状态栏放行配对', { approved })
      if (!approved) {
        // 没有申请可放行：给 409 而不是 200+false —— 让 UI 显示"申请已过期，请重新扫码"。
        json(response, 409, { state: 'stale' })
        return
      }
      json(response, 200, { state: 'ok' })
    } catch (error) {
      json(response, 500, { error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

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
 * 挂上这七条路由；返回一个注销函数（七条一起摘，一条抛了也不许把其余留在宿主上）。
 *
 * ⚠️ 半途失败也必须干净：`webServer.register` 会因为"路由名已被占用"抛错，而七条是**依次**挂的。
 * 不加这层回滚的话，第二条挂不上时第一条就永久留在宿主上、`stop()` 再也拿不到它的注销函数——
 * 表现是"重载一次之后那条路由再也挂不上"（右栏方案当年踩过同一形状，见 install 脚本的退役逻辑）。
 *
 * ⚠️ **配置那一条排在最后**（2026-10-11）：它不是配对入口，排在前面会让"第 N 条就抛了"
 * 那几条判据的编号含义整体错位（那些判据是照"发码先挂"写的）。
 */
/**
 * `POST /client-report`：客户端半的自报（诊断用，写文件，不回任何凭据）。
 *
 * 守卫与其它写路由同一档（回环 + 自定义头）：它虽然是"只写自己的一份诊断"，
 * 但没有理由让任意网页往宿主磁盘上写东西。
 */
function clientReportHandler(): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(request.headers.host) || !originIsLoopbackOrAbsent(request.headers.origin)) {
      json(response, 403, { error: 'request-not-trusted' })
      return
    }
    if (request.headers[PAIR_MARKER_HEADER] === undefined) {
      json(response, 403, { error: 'request-not-trusted' })
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      // 诊断报文不许无界：超了直接截断（它只用来回答"apply 看到了什么"）。
      if (size <= 4096) chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const path = require('node:path') as typeof import('node:path')
        const fs = require('node:fs') as typeof import('node:fs')
        const dir = path.join(process.env.HOME ?? '', '.dsh', 'dsh-remote-control')
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        fs.writeFileSync(
          path.join(dir, 'client-report.json'),
          `${JSON.stringify({ at: Date.now(), bytes: size, body: Buffer.concat(chunks).toString('utf8').slice(0, 4096) })}\n`,
          { mode: 0o600 },
        )
        json(response, 200, { ok: true })
      } catch (error) {
        json(response, 500, { error: String((error as Error)?.message ?? error).slice(0, 200) })
      }
    })
  }
}

export function registerPillRoutes(webServer: WebServerLike, deps: PillRouteDeps & ConfigRouteDeps): () => void {
  const off: Array<() => void> = []
  const definitions = [
    { kind: 'exact' as const, path: PAIR_NEW_ROUTE, handler: pairNewHandler(deps) },
    { kind: 'exact' as const, path: PAIR_IMAGE_ROUTE, handler: pairImageHandler(deps) },
    { kind: 'exact' as const, path: PAIR_STATUS_ROUTE, handler: pillStatusHandler(deps) },
    { kind: 'exact' as const, path: PAIR_UNPAIR_ROUTE, handler: unpairHandler(deps) },
    { kind: 'exact' as const, path: PLUGIN_CONFIG_ROUTE, handler: configRouteHandler(deps) },
    { kind: 'exact' as const, path: CLIENT_REPORT_ROUTE, handler: clientReportHandler() },
    // 2026-10-21 加：用户确认「数字一致」后的放行口。**排在最后**，前面各条的编号语义不变。
    { kind: 'exact' as const, path: PAIR_APPROVE_ROUTE, handler: pairApproveHandler(deps) },
  ]
  /**
   * 每条路由都过一遍 CORS，并把预检就地答掉（`OPTIONS` 不进 handler）：
   * 预检不带自定义头也不带 body，走业务守卫只会回 403/405，而浏览器要的是 2xx + 那几个头。
   */
  const wrapped = definitions.map((definition) => ({
    ...definition,
    handler: (request: IncomingMessage, response: ServerResponse) => {
      applyCors(request, response)
      if (request?.method === 'OPTIONS') {
        response.writeHead(204)
        response.end()
        return
      }
      // ⚠️ 必须**把内层的返回值传出去**：这些 handler 有几条是 async，
      // 不 return 的话调用方 await 到的是一个已完成的空 promise，
      // 而 `writeHead` 还没发生 ⇒ 表现是"路由挂了、但调用方读到 HTTP 0"。
      return definition.handler(request, response)
    },
  }))
  try {
    for (const definition of wrapped) off.push(webServer.register(definition))
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
