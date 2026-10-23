/**
 * pill — 状态栏那颗 pill（浏览器那一半）。抬头那句话的现行口径见 `pillLabel`：
 * 没配上是 `远程未连接`、配上了是 `已连接`（2026-10-05 用户定的，早年的"未配对 / 已配对"已废）。
 *
 * 它做三件事：往宿主的 `conversation.composer.dock` 槽位注册一颗 pill，按节拍问
 * `GET /plugins/dsh-remote-control/status` 把连接状态写在上面，点击时弹面板。
 *
 * **面板的形状**（2026-10-03 重设计、2026-10-04 删掉中间那一屏）：**未配对点开直接就是二维码页**
 * （`POST /pairing/new` + `GET /pairing.png` 画进面板），**已配对点开是状态**——抬头一行状态 +
 * 右上角那**一颗**动作按钮，下面三行**中继 / 状态 / 版本**（各自拿不到值时那一行不占地方）。
 * 那颗按钮只按"配没配上"分两种身份：没配上是 `刷新`（幂等发码：码还在就还是它、过期了才换新的），
 * 配上了是 `退出配对`（`POST /unpair`）。原来"未配对 → 先按一颗「生成配对码」才出码"那一屏
 * 与那颗按钮一起删掉了：没配上时这一屏没有任何别的内容可看，多点一次没有换到任何东西。
 * 更早那版是四行"本机 / 中继 / 状态 / 已配对"，随后收成"只剩中继"、用户嫌单薄又补两条凑三行：
 * 留下的是"连的哪一台 / 连没连上 / 跑的是哪一版"，本机名与台数不上屏——抬头那句已经是状态，
 * 台数只可能是 0 或 1。`再配一台`、`换一张` 与"倒计时走完自动补一张"也在这一轮删掉了：
 * 一张码过期后该重发还是让用户自己按。
 *
 * 颜色就是状态：灰（未启动 / 远程未连接）、黄（连接中）、绿（已连接）、**红（已断开连接）**。
 *
 * 三条形状上的决定都有据可查，不是随手挑的：
 *
 * 1. **`slots` 按宿主模板声明进 `inject`，并且留软探测当退路**。宿主自带的
 *    `templates/decoration/client.js` 就是 `inject: ['slots']` + `ctx.slots.inject(...)`；
 *    不声明的话 `apply()` 跑在槽位服务之前，那颗 pill 整颗不出现（见 `mountPill` 的注释，
 *    2026-10-03 真机踩过）。声明成闸门换来的正是"激活时机在服务之后"，而软探测与注入回调
 *    留着，是为了在"这一代宿主没把 slots 当服务给"时还能挂上、并且留下一行 warn 说清原因。
 * 2. **react 只用来 `createElement`，而且是运行期向 loader 要**（`__drcRequire`，见
 *    `scripts/bundle-plugin.mjs` 的外壳）。静态 import 的解析失败发生在 factory 顶层，
 *    那是"整页 web boot 失败"的形状（真机踩过：`web boot: N entry/entries did not activate`）；
 *    运行期拿不到就只是没有 pill。**不用 hooks**：组件只返回一个带 `ref` 的空 `<span>`，
 *    UI 全由下面那段 DOM 管——`ref` 回调身份稳定，宿主重渲染 dock 不会把我们这块拆掉重建。
 * 3. **图走同域 HTTP，不走 `dsh-resource://`**。pill 里一个 `<img>` 能不能吃那个自定义
 *    scheme 没有证据，而 `/plugins/**` 是必然可行的那条路。
 *
 * 纪律与主文件同一条：**任何一步抛出都只留一行日志，绝不把异常抛进 loader**。
 */

import { statusText, waitingText } from '../copy/zh.js'
import { resolveHostUrl } from './host-url.js'

/**
 * 状态词条从共享文案表取（`copy/zh-cn.json`，V3-PLAN §7 阶段 F2）。
 *
 * ⚠️ 2026-10-08 改版前这三句是这里写死的中文，与小程序**说得不一样**：
 * 「远程未连接 / 已断开连接 / 远程未启动」对「未连接 / 已断开 / 离线中」。
 * 同一件事在桌面上一句、在手机上一句，用户会以为那是两件事——
 * 而桌面那颗 pill 恰恰是"手机能不能用"这件事在宿主侧唯一的可见处（PRODUCT §3 第 2 条）。
 *
 * **取值失败必须让构建红**：`statusText(id)!` 的非空断言在这里是**故意的**——
 * 表里少一个 id 是事实源与代码脱节，那种错宁可编译不过，也不要界面上悄悄回退成另一句话。
 */
const ZH = {
  online: statusText('online')!,
  connecting: statusText('connecting')!,
  offline: statusText('offline')!,
  notLinked: statusText('notLinked')!,
  relayDown: statusText('relayDown')!,
  phoneAway: statusText('phoneAway')!,
  brand: statusText('brand')!,
  relayReady: statusText('relayReady')!,
  relayIdle: statusText('relayIdle')!,
}

/** pill 与设置页用到的路由（宿主侧定义在 `src/pill/routes.ts`，字符串必须一致）。 */
export const STATUS_ROUTE = '/plugins/dsh-remote-control/status'
export const NEW_ROUTE = '/plugins/dsh-remote-control/pairing/new'
const IMAGE_ROUTE = '/plugins/dsh-remote-control/pairing.png'
export const UNPAIR_ROUTE = '/plugins/dsh-remote-control/unpair'

/** 槽位与条目 id：抄 `conversation.composer.dock` 那个已验证的用法。 */
const SLOT_NAME = 'conversation.composer.dock'
const PILL_ID = 'dsh-remote-control'
/** 排在宿主自带的 stats(0) 与 provider-usage(10) 之后——加进去的东西不该挤掉原有的。 */
const PILL_ORDER = 20

const STYLE_ID = 'dsh-remote-control/pill.css'
/**
 * 插件名。**注入 `<style>` 时必须一起打上 `data-plugin`**：宿主按它认领"这份样式是谁插的"
 * （`claimStyles`），只有 `data-plugin-css` 的话这份样式会被算到别的插件头上，
 * 那个插件 HMR 时一句 `removeOwnedStyles` 就把整颗 pill 的配色一起删了（2026-10-06 修）。
 */
const PLUGIN_ID = 'dsh-remote-control'
const POLL_MS = 2000
/** 每条请求的硬超时：宿主卡住时请求必须自己收场，否则 2 秒一轮会叠成一串未决请求。 */
const FETCH_TIMEOUT_MS = 3000

interface SlotRegistry {
  inject(slotName: string, callback: () => void): unknown
  register(definition: Record<string, unknown>, component: unknown): unknown
}

interface Gettable {
  get?<T>(name: string, optional?: true): T | undefined
}

interface PillHost extends Gettable {
  /** 声明在模块的 `inject` 里之后才可读（宿主模板就是这么写的）；没声明时读它会抛。 */
  slots?: unknown
  inject?(names: string[], callback: (scoped: unknown) => void): unknown
  effect?(execute: () => (() => unknown) | void): unknown
}

/** 只用到 createElement——不需要 hooks，见文件头第 2 条。 */
export type CreateElement = (type: unknown, props: Record<string, unknown>) => unknown

interface StatusAnswer {
  relay?: unknown
  paired?: unknown
  pairings?: unknown
  serverUrl?: unknown
  version?: unknown
  waiting?: unknown
  waitingOldestSec?: unknown
}

interface NewAnswer {
  state?: unknown
  token?: unknown
  expiresInMs?: unknown
  epoch?: unknown
  reason?: unknown
  error?: unknown
  guard?: unknown
}

/**
 * 面板该显示什么：`POST /pairing/new` 的几种回答收成一个可判别的形状。
 *
 * 单独成函数是因为这里有一条**不许靠 HTTP 状态码判成败**的判据：中继不在时那条路由回的是
 * 200 + `state:"unavailable"`，按 `response.ok` 分支会把它当成功，然后弹一张没有图的白框。
 */
export function panelViewFor(answer: NewAnswer | undefined, httpStatus: number): PanelView {
  if (!answer || typeof answer !== 'object') return { kind: 'failed', detail: `HTTP ${httpStatus}` }
  if (answer.state === 'ready') {
    const token = typeof answer.token === 'string' ? answer.token : ''
    const epoch = typeof answer.epoch === 'string' ? answer.epoch : ''
    const expiresInMs = typeof answer.expiresInMs === 'number' ? answer.expiresInMs : 0
    if (token === '' || expiresInMs <= 0) return { kind: 'failed', detail: '发码回答里的码不完整' }
    // epoch 进 URL：一张码会被就地换掉，缓存任何一版都是让弹窗停在废码上。
    return { kind: 'qr', token, expiresInMs, imageSrc: `${IMAGE_ROUTE}?e=${encodeURIComponent(epoch)}` }
  }
  if (answer.state === 'unavailable') {
    return {
      kind: 'unavailable',
      reason: answer.reason === 'relay-offline' ? '中继还没连上，暂时无法配对。' : '现在发不出配对码。',
    }
  }
  return {
    kind: 'failed',
    // 把宿主说的那道守卫一起印出来：这条路由在浏览器里点，屏幕上的这句话就是唯一的现场。
    detail:
      typeof answer.error === 'string'
        ? typeof answer.guard === 'string'
          ? `${answer.error}（${answer.guard}）`
          : answer.error
        : `HTTP ${httpStatus}`,
  }
}

export type PanelView =
  | { kind: 'info' }
  | { kind: 'loading' }
  | { kind: 'qr'; token: string; expiresInMs: number; imageSrc: string }
  /** 中继不在线：**不给二维码**。一张扫了必然失败的码比没有码更糟。 */
  | { kind: 'offline' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; detail: string }

/**
 * 小程序码那张图的**加载态**（2026-10-21）。
 *
 * ## 为什么这一格需要三态
 *
 * `GET /pairing.png` 不是"本地文件"：它要**中继拿着小程序的 appSecret 去微信那边签一张码**
 * 才回得来（宿主侧 `src/shell/mp-code.ts` → 中继 → 微信 `getwxacodeunlimit`）。
 * 一次往返 1～3 秒，宿主那一侧的超时是 5 秒（`MP_CODE_TIMEOUT_MS`）。
 *
 * 而屏幕这一侧是 `<img src="/plugins/…/pairing.png">`：**浏览器自己去取那张图**。
 * 在它落地之前，`<img>` 是**空的**（连 alt 文本都只是一行小字）——
 * 用户看到的是一个 200×200（面板）/ 240×240（设置页）的**空框**，
 * 分不清"正在取"还是"取不到"，而这两种的下一步完全不同。
 *
 * ⇒ 这一格要有三态，并各给一句话：
 * · `loading` —— 图在路上：一个**等大的**占位（转圈 + 一句话）。
 * · `ready` —— 图到了：占位收掉，图露出来。
 * · `failed` —— 取不到：**不许永远转圈**，要说清"取不到"，并告诉用户下一步点哪颗按钮。
 *
 * ## 为什么状态机只有这一份
 *
 * 面板与设置页是**同一张图、同一段等待、同一句话**。两处各判一次，迟早一处改了另一处没改
 * （这一页从头到尾守着这条纪律，见 `panelViewFor` 那条注释）⇒ 抽成控制器，两处共用。
 */
export type MpCodeLoadState = 'loading' | 'ready' | 'failed'

/**
 * 那两句人话。**插件侧专用**（小程序那一端没有这一格），所以不进共享文案表
 * （`copy/zh-cn.json` 收的是两端共用的词）。
 */
const MP_CODE_LOADING_TEXT = '正在获取小程序码'
const MP_CODE_FAILED_TEXT = '小程序码取不到'
const MP_CODE_FAILED_HINT = '点上面的按钮重试'

export interface MpCodeImageController {
  /**
   * 拿到那张图的元素。**同一个 src 复用同一个元素**。
   *
   * 复用不是为了省内存：`/pairing.png` 是 `no-store`，每新建一个 `<img>` 都必然回源一次、
   * 宿主那边重新签一张码、屏幕上的图**重新加载一遍**（会闪）。
   * ⇒ 设置页那 2 秒一次的重画因此不再重取图（2026-10-21 修：那一页原先每 2 秒重建一个
   * `<img>`，于是图每 2 秒闪一次、中继每 2 秒被叫一次）。
   */
  element(src: string): HTMLImageElement
  /** 此刻的状态。 */
  state(): MpCodeLoadState
  /**
   * 丢掉当前那一张——**只在它取失败时**才真的丢。
   *
   * 为什么需要它：发码那条路由是**幂等**的（码还在就还是它），
   * 所以"点刷新重试"拿回的是**同一个 src** —— 而那个 src 刚才失败过。
   * 不丢掉它，重试就只是把同一张失败的图再摆一次。
   */
  invalidate(): void
}

/**
 * 建一个控制器。`onChange` 在状态变化时被调用（调用方据此重画）。
 *
 * ⚠️ 这三态是由**浏览器**推进的（`load` / `error` 事件），不是我们发请求推进的
 * ⇒ `onChange` 会在**我们没在等**的时候被调用，它必须能安全地触发一次重画。
 */
export function createMpCodeImage(doc: Document, onChange: () => void): MpCodeImageController {
  let current: { src: string; element: HTMLImageElement; state: MpCodeLoadState } | undefined
  const settle = (element: HTMLImageElement, state: MpCodeLoadState): void => {
    element.setAttribute('data-load', state)
    if (current && current.element === element) current.state = state
    onChange()
  }
  return {
    element(src: string): HTMLImageElement {
      if (current && current.src === src) return current.element
      const element = doc.createElement('img')
      element.className = 'drc-qr'
      element.setAttribute('alt', '配对二维码')
      element.setAttribute('data-load', 'loading')
      /**
       * ⚠️ 监听器**先挂上再设 src**：真实浏览器里一设 `src` 就开始取图，
       * `load` 事件在**之后**的任务里才来（所以顺序不会漏事件），
       * 但"先挂后设"是这个形状的常规写法，别让人以为顺序无所谓。
       *
       * ⚠️ 这个元素会被**面板反复重画**摘下来又挂回去（`paint()` 是
       * `replaceChildren()`，每 2 秒一次）。摘下来**不会**让请求作废：
       * 控制器**一直握着它的强引用**，浏览器不会去回收它，`load` 事件照样落在它身上。
       * 这也是"复用同一个元素"这条纪律的另一半理由——元素不回收，请求就不作废。
       */
      element.addEventListener('load', () => settle(element, 'ready'))
      element.addEventListener('error', () => settle(element, 'failed'))
      element.src = src
      current = { src, element, state: 'loading' }
      return element
    },
    state(): MpCodeLoadState {
      return current?.state ?? 'loading'
    },
    invalidate(): void {
      if (current?.state === 'failed') current = undefined
    },
  }
}

/**
 * 那一格的占位（转圈 + 一句话）。**尺寸必须与那张图一样**，否则图到了会跳一下。
 *
 * ⚠️ 失败那一档**不许再转**：转圈只表示"还在等"，而它已经不成立了——
 * 一个永远转圈的圈比一句"取不到"更让人以为插件坏了。
 */
export function mpCodeLoadingBox(doc: Document, state: MpCodeLoadState): HTMLElement {
  const box = doc.createElement('div')
  box.className = 'drc-qr-loading'
  box.setAttribute('data-state', state)
  // 屏读器要能念出这一档：它是**状态**，不是装饰。
  box.setAttribute('role', 'status')
  box.setAttribute('aria-live', 'polite')
  if (state === 'loading') {
    const spinner = doc.createElement('span')
    spinner.className = 'drc-spinner'
    spinner.setAttribute('aria-hidden', 'true')
    box.appendChild(spinner)
  }
  const label = doc.createElement('span')
  label.className = 'drc-qr-loading-text'
  label.textContent = state === 'failed' ? MP_CODE_FAILED_TEXT : MP_CODE_LOADING_TEXT
  box.appendChild(label)
  if (state === 'failed') {
    const hint = doc.createElement('span')
    hint.className = 'drc-qr-loading-hint'
    hint.textContent = MP_CODE_FAILED_HINT
    box.appendChild(hint)
  }
  return box
}

/**
 * 状态 → pill 上那一句。顺序就是优先级：先说连不上，再说配没配上。
 *
 * 抬头那句只说**结论**，不说数量也不说进度：`已连 N 台` 在那一排被压窄时会竖着断行（真屏幕
 * 踩过，见 CSS），而"配对中"这种中间态写在抬头上没人看得懂——码是不是还在、还剩几秒，
 * 点进去的弹窗里都有（面板抬头读的就是这一句，同一份来源）。所以"没配上"的两种情形
 * （没有效码 / 有码还没人扫）合成一句 `未配对`，灯跟着走灰色：灰色才是"还没配上"的颜色。
 * 2026-10-04 添了第三种：**手机离线**（簿里还有会话、一台都没连着）——配对按 D3 长存，
 * 那不是"没配上"（见下面那一支）。
 *
 * 四种 tone 就是四种颜色：`off` 灰（未启动 / 远程未连接）、`wait` 黄（连接中）、`on` 绿（已连接）、
 * `error` 红（已断开连接）。2026-10-03 用户按真屏幕要的：断链必须红，不能和"没配上"同一个灰。
 */
export function pillLabel(status: StatusAnswer | undefined): { text: string; tone: 'off' | 'wait' | 'on' | 'error' } {
  const relay = status?.relay
  if (relay === 'idle') return { text: ZH.relayDown, tone: 'off' }
  // 断链是**故障**不是"还没配"，所以它单独一档、单独一个红：灰色会被读成"还没轮到配"。
  if (relay === 'offline') return { text: ZH.offline, tone: 'error' }
  if (relay === 'connecting') return { text: ZH.connecting, tone: 'wait' }
  if (relay !== 'online') return { text: ZH.brand, tone: 'off' }
  const paired = typeof status?.paired === 'number' ? status.paired : 0
  // 2026-10-05 用户定的口径：抬头只说"连没连上"，不说"配没配"——"已配对"对
  // 第一次用的人不解释任何事，"已连接"才直接回答"现在能用了没有"。
  if (paired > 0) {
    // 有东西挂在手机上等回答时，`已配对` 这句话等于没说——那条回合正停在这台机器上，
    // 而这颗 pill 是它在桌面上唯一可能被看见的地方（判据见伞仓 docs/PRODUCT.md §3）。
    // 只在**确实配着**的时候抢这一格：手机中途掉线、挂起还没超时时，
    // 用户能做的第一件事是重新配对，那才是该说的那句。
    const waiting = waitingCount(status)
    if (waiting > 0) return { text: waitingText(waiting), tone: 'wait' }
    return { text: ZH.online, tone: 'on' }
  }
  // 一台都没连着、但密钥簿里还有会话 = **配过对，手机只是不在线**（小程序退后台、手机关屏）。
  // 配对按 D3 长存且 pair-store 落盘，手机回前台自动重连——这不是「没配上」：
  // 那一态说「未配对」是让用户去扫一个不需要扫的码（2026-10-04 用户报的误解）。
  // 灯走黄（wait）：不是故障，也不是「可以用了」，是「等它自己回来」。
  if (pairingCount(status) > 0) return { text: ZH.phoneAway, tone: 'wait' }
  // 2026-10-05 用户定的口径："远程未连接"而不是"未配对"。"配对"是内部动作，
  // 第一次装好插件的人不知道自己要"配对"；"远程未连接"直接说清了现在
  // "这台机器还没接上手机"——也顺手回答了那颗 pill 点开能看到什么。
  return { text: ZH.notLinked, tone: 'off' }
}

/** 挂在手机上等回答的件数。老版路由没给这个字段时算 0（那一行自己不占地方）。 */
function waitingCount(status: StatusAnswer | undefined): number {
  const count = status?.waiting
  return typeof count === 'number' && count > 0 ? Math.min(Math.floor(count), 99) : 0
}

/**
 * 密钥簿里还有几条会话 = 「配对还在不在」。
 *
 * 与 `paired`（此刻有几台手机连着）是两件事：手机关了小程序只是 socket 断，
 * 簿还在、回前台自动重连（pair-store，D3）。老版路由没这个字段时算 0——
 * 那一态退回「未配对」：宁可把「没配上」说轻，也不把「没配上」说成「配上了」。
 */
export function pairingCount(status: StatusAnswer | undefined): number {
  const count = status?.pairings
  return typeof count === 'number' ? count : 0
}

/** `37 秒` / `4 分 12 秒` / `12 分`。十分钟以上不再报秒——这行是扫一眼的，不是秒表。 */
/**
 * 二维码那一屏顶上那句引导。规则只有三条：**一条、短、不带符号**。
 *
 * 一条：这一屏只教一件事——码是给小程序扫的、扫完能远程控制这台电脑；
 * 短：扫一眼就要读完，长句会被当成服务条款直接跳过；
 * 不带符号：顿号冒号书名号全不用，空格就是分隔（2026-10-05 用户定的口径，
 * 括号等符号会让一行"系统提示"更像错误而不是引导）。
 */
const GUIDE_LINE = '打开小程序扫这个码 远程控制这台电脑'

function humanDuration(sec: unknown): string {
  const total = typeof sec === 'number' && sec > 0 ? Math.floor(sec) : 0
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  return minutes >= 10 ? `${minutes} 分` : `${minutes} 分 ${total % 60} 秒`
}

/**
 * 正文那一行"待处理"的值：`2 件 · 最久 4 分 12 秒`。没有事在等时返回空串（那一行不建）。
 *
 * 手机上看的是"还剩多久"（那颗倒计时），这里看的是"已经等了多久"——
 * 同一段时间，两端要回答的是两个不同的问题。
 */
export function waitingRow(status: StatusAnswer | undefined): string {
  const count = waitingCount(status)
  if (count === 0) return ''
  const oldest = typeof status?.waitingOldestSec === 'number' ? status.waitingOldestSec : 0
  return `${count} 件${oldest > 0 ? ` 最久 ${humanDuration(oldest)}` : ''}`.slice(0, 40)
}

/**
 * 中继地址只留 `host:port`：弹窗宽 240px，那条 URL 带着 scheme 和 path 会挤掉别的行，
 * 而用户排错要认的就是"连的哪一台"。这里**不用 `new URL`**——这段 DOM 也跑在单测那个 vm 里，
 * 少一个全局依赖就少一类"在 vm 里退化成整条字符串"的假象。
 */
function relayAddress(url: unknown): string {
  if (typeof url !== 'string' || url.trim() === '') return ''
  const withoutScheme = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  // authority 就是 scheme 之后、第一个 `/` 或 `?` 之前那一段。
  const authority = /^[^/?]*/.exec(withoutScheme)?.[0] ?? ''
  /**
   * **userinfo 必须剥掉**（`user:pass@host` → `host`）。
   *
   * 2026-10-06 修：原来只按"scheme 之后、第一个 `/` 或 `?` 之前"切，`wss://user:pass@host/x`
   * 会把 `user:pass@host` 整段印进面板——上面那句注释写的是"只留 host:port"，
   * 而 userinfo 恰恰是这一段里唯一可能带凭据的东西。
   */
  const host = authority.replace(/^[^@]*@/, '')
  return host.slice(0, 40)
}

/**
 * 面板正文那三行（中继 / 状态 / 版本）。每条都**拿不到就返回空串**，调用方据此不占那一行——
 * 第一次轮询还没回来时面板不该出现三个空壳。
 *
 * 2026-10-03 的历史：重设计前这里是四行（本机 / 中继 / 状态 / 已配对），随后收成"只剩中继"、
 * 用户又说太单薄、补回两条凑三行。留下的这三条各有理由，且**都不与抬头那句重复**：
 * 中继＝连的哪一台（排错第一眼）、状态＝中继这条链的细态（抬头在线时只说配没配上）、
 * 版本＝跑的是哪一版（profile 里可能就是没发布的字节）。本机名与台数仍不上屏。
 */
export function relayRow(status: StatusAnswer | undefined): string {
  return relayAddress(status?.serverUrl)
}

/** 中继那条链的细态：抬头在线时只讲"配没配上"，这条才讲"连没连上"。 */
export function relayStateRow(status: StatusAnswer | undefined): string {
  const relay = status?.relay
  // 2026-10-05 用户定的口径：弹窗这一行说"已就绪"不说"已连接"——"已连接"
  // 留给抬头那句结论（配没配上），这里讲的是中继这条链本身通了，两句话不打架。
  if (relay === 'online') return ZH.relayReady
  if (relay === 'connecting') return '连接中'
  if (relay === 'offline') return '已断开'
  if (relay === 'idle') return ZH.relayIdle
  return ''
}

/** 本机装的这一版号；宿主没给（老版路由）时这一行不占地方。 */
export function versionRow(status: StatusAnswer | undefined): string {
  const version = status?.version
  return typeof version === 'string' && version.trim() !== '' ? version.trim().slice(0, 24) : ''
}

/** 秒数说成人话：62 秒说"1 分 2 秒"——用户扫一张码不该数秒。 */
export function secondsText(ms: number): string {
  const whole = Math.max(0, Math.round(ms / 1000))
  if (whole < 60) return `${whole} 秒`
  return `${Math.floor(whole / 60)} 分 ${whole % 60} 秒`
}

/**
 * 宿主没给设计变量时的**兜底值** —— 收在一处，V3-PLAN F1。
 *
 * ## 为什么要收
 *
 * v2 之前这七个色值**字面量散在 CSS 模板里 21 处**，其中
 * `--dsw-alias-label-secondary` 还出现了**两个不同的兜底值**（`#6b7280` 与
 * `#5f6368`）——同一条语义在同一个组件里有两个"没有宿主变量时的颜色"，
 * 而没有任何东西会报这件事。
 *
 * ## 这些值是**兜底**，不是我们的设计
 *
 * 它们是宿主 DSH 的设计变量取不到时的替身。真正的颜色由宿主给；
 * 而宿主给的是哪一套，是宿主的事（它要看起来像"宿主亲生的"）。
 * 我们自己的语义名是 `--drc-*`（映射表见 `docs/DESIGN-TOKENS.md`），
 * **值故意与小程序不同**——两端服务不同的主人。
 */
const FALLBACK = {
  // 下面三个是 2026-08-09 重排设置页时补的：值取自宿主自己的设置分区
  // （`AgentPresetSection.module.css` 的真实 CSS——卡片 `border-l2` + `bg-layer-3`、
  // 焦点环 `brand-primary`）。照抄宿主的取值口径，不是随手挑的颜色。
  'border-l2': 'rgba(0, 0, 0, 0.16)',
  'bg-layer-3': '#ffffff',
  'brand-primary': '#247bbf',
  /**
   * 主按钮的**填充与字色**（2026-10-09 加，用户报"按钮全白"之后）。
   *
   * ⚠️ 这一对**不能自己配**，必须各拿各的宿主令牌。主按钮的填充是
   * `--dsw-alias-button-primary-fill`，它等于 `--dsw-alias-brand-primary`，
   * 而**在深色主题下那是"近白"**（neutral-bluish-50）。当时我们给这个浅填充写死了
   * FIXED_WHITE 的白字 ⇒ 白底白字，整个按钮看不见（真屏幕截图，2026-10-09）。
   * 宿主自己的写法是 `.primary{background:var(--dsw-alias-button-primary-fill);
   * color:var(--dsw-alias-label-primary-foreground)}` —— 字色是**另一个令牌**，
   * 深色下是近黑（neutral-bluish-1000）。两个一起拿，明暗两套主题才都成立。
   *
   * 这两个兜底值只在"这代宿主没有这两个令牌"时生效（那时通常是浅色主题）：
   * 蓝底 + 白字，是这套设计里最不会出错的一组。
   */
  'button-primary-fill': '#247bbf',
  'label-primary-foreground': '#ffffff',
  'state-success-primary': '#52c41a',
  'state-warn-primary': '#faad14',
  'state-error-primary': '#ff4d4f',
  'label-primary': '#1f2329',
  'label-secondary': '#6b7280',
  'label-tertiary': '#9aa0a6',
  'label-dimmed': '#9aa0a6',
  'bg-layer-1': '#ffffff',
  'border-l1': 'rgba(0, 0, 0, 0.1)',
  'interactive-bg-hover': 'rgba(0, 0, 0, 0.04)',
} as const

/**
 * **绝对的白**（2026-08-09）。两处用：二维码那张纸的底色、品牌色按钮上的字色。
 *
 * ⚠️ **故意不走主题 token**：二维码能不能被扫出来由**码点与纸的对比度**决定，
 * 而不是由用户选了明还是暗决定。走 `--dsw-alias-bg-layer-1` 的话，暗色主题下
 * 纸也跟着变暗，屏幕上就是一张扫不出来的二维码——而用户不会知道该怪谁。
 * （`e2e/design-tokens` 那条判据禁止 CSS 模板里出现裸色号，所以它必须在这里具名。）
 */
const FIXED_WHITE = '#ffffff'

/** `var(--dsw-alias-<key>, <fallback>)` —— 一处拼装，值只来自 FALLBACK。 */
const hostVar = (key: keyof typeof FALLBACK): string => `var(--dsw-alias-${key}, ${FALLBACK[key]})`

const CSS = `
.drc-pill { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 2px 8px;
  border: 0; border-radius: 999px; background: transparent; color: inherit; font: inherit;
  font-size: 12px; line-height: 18px; cursor: pointer;
  /* 宿主那一排挤不下时会自己截断（「6 轮 …」那种），我们也跟这个形状走：
     一行写完，写不下就省略号。**没有这两条**的话，flex 项会被压到「中文最小内容宽度
     = 一个字」，于是「已连 1 台」竖着排成四行（2026-10-03 真屏幕截图）。 */
  flex: 0 1 auto; white-space: nowrap; }
.drc-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.drc-pill:hover { background: ${hostVar('interactive-bg-hover')}; }
.drc-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: ${hostVar('label-dimmed')}; }
.drc-dot[data-tone="wait"] { background: ${hostVar('state-warn-primary')}; }
.drc-dot[data-tone="on"] { background: ${hostVar('state-success-primary')}; }
.drc-dot[data-tone="error"] { background: ${hostVar('state-error-primary')}; }
.drc-panel { position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 30; width: 240px;
  padding: 10px 12px; border: 1px solid ${hostVar('border-l1')}; border-radius: 12px;
  background: var(--dsw-specific-tip, ${hostVar('bg-layer-1')});
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
  color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; }
/* 抬头一行：左侧状态，右侧动作。两颗按钮都收在这个右上角（2026-10-03 重设计的要求）。 */
.drc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.drc-head-label { font-weight: 600; }
.drc-head-label[data-tone="off"] { color: ${hostVar('label-secondary')}; }
.drc-head-label[data-tone="wait"] { color: ${hostVar('state-warn-primary')}; }
.drc-head-label[data-tone="on"] { color: ${hostVar('state-success-primary')}; }
.drc-head-label[data-tone="error"] { color: ${hostVar('state-error-primary')}; }
.drc-actions { display: flex; gap: 6px; flex: 0 0 auto; }
.drc-btn { padding: 2px 10px; border: 1px solid ${hostVar('border-l1')};
  border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer;
  white-space: nowrap; }
.drc-btn:hover { background: ${hostVar('interactive-bg-hover')}; }
/* 正文那三行（中继 / 状态 / 版本）：键左值右（space-between），值被截断时省略号——
   和那颗 pill 同一套"挤不下就截文字不撑容器"。第一行带那条分隔线，后两行只留行距。 */
.drc-info { display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  white-space: nowrap; margin-top: 8px; padding-top: 6px;
  border-top: 1px solid ${hostVar('border-l1')}; }
.drc-info + .drc-info { margin-top: 2px; padding-top: 0; border-top: 0; }
.drc-key { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); }
.drc-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.drc-qr { display: block; width: 200px; height: 200px; margin: 8px auto 0; image-rendering: pixelated; }
.drc-count { margin: 8px 0 0; text-align: center; color: ${hostVar('label-secondary')};
    font-size: 12px; font-variant-numeric: tabular-nums; }
  .drc-count[data-kind="urgent"] { color: ${hostVar('state-warn-primary')}; font-weight: 600; }
  .drc-code { margin: 8px 0 0; text-align: center; font-weight: 600; font-size: 14px; letter-spacing: 2px; }
  /* 引导行：比 note 重一档（第一次用的人要看清），但不加图标不加底色——
     这一屏的主角是二维码，多一个色块就成了推销而不是引导。 */
  .drc-guide { margin: 8px 0 0; text-align: center; color: ${hostVar('label-secondary')}; font-size: 12px; }
  .drc-note { margin: 4px 0 0; text-align: center; color: var(--dsw-alias-label-tertiary); }
.drc-note[data-kind="failed"] { color: ${hostVar('state-error-primary')}; }
  /* 离线那一屏的第一行说明要跟上面那行拉开一点。**必须写在 .drc-note 之后**：
     两者特异度相同（都只一个类），后来的赢——写在前面的 margin-top 会被
     .drc-note 的 margin: 4px 0 0 整条覆盖成死规则（2026-10-06 修）。 */
  .drc-note-block { margin-top: 10px; }

/* ── 设置页那一页（settings.section）─────────────────────────────────
   取值全部照抄宿主自己的设置分区（dsh-client-ui-agent-preset 那份
   AgentPresetSection.module.css 的真实 CSS，2026-08-09 从正在跑的那份模块里抠出来的）：
   title 18px 600、卡片走 border-l2 + bg-layer-3 + radius 12px、行间细线走 border-l1。
   ⇒ 目的不是"好看"，是**看起来像宿主亲生的那一页**：指南里那条
   "Choose the rendering surface before writing any view; later styling inside the wrong
   surface cannot recover consistency"，反过来也成立——同一个面里自己发明一套就露馅。

   ⚠️⚠️ **这里每一个取值都必须写成插值形态**（2026-10-09 修）。
   2026-08-09 那一版整段把它写成了**字面文本**（少了一对美元花括号）：浏览器认不出
   那个值，**一条声明都不生效**——于是卡片没有边框、没有底色、没有圆角，标题与按钮
   也全无色。结构、类名、断言都对，屏幕上就是一列裸文本（用户报的"排版比较乱"）。
   ⇒ 判据补在 e2e/design-tokens.test.mjs：CSS 模板里出现未插值的调用一律红。
   **这仓被同一形状绊过五次以上：判据读的是"那段文字在不在"，而浏览器读的是
   "那个值合不合法"。**

   2026-10-09 的另一次重排：原来是一列垂直码放（标题 / 状态 / 二维码卡 / 四行事实 /
   一排按钮），每一块都占满 720px 而内容只有 200px 宽——大空间放小内容，视线无处落脚。
   现在改成**两栏卡片**：
     左栏 = 这台主机（配对卡 + 连接事实），右栏 = 手机端（小程序码 + 怎么用）。
   窄屏自己折成一列。
   ⚠️ 两栏用 grid 的 auto-fit + minmax 而不是媒体查询：这一页的宽度由**宿主的容器**给，
   我们不知道窗口多宽，媒体查询只能猜。268px 是"200px 的码 + 卡片内边距"能容下的下限。
   ⚠️ **已经配对**那一态左栏会短一截（配对卡只剩状态 + 一句说明 + 两颗按钮），
   左栏下方于是留出一段空白。这是**已知取舍**，不要在左栏补一张凑高度的卡：
   配对是这一页的主要场景，两栏的高度是按那一态配平的（实测 678 / 618）；
   为稳态的空白去动主要场景的版面，是本末倒置。
   ⚠️ **这一整段都在模板字符串里，一个反引号都不能出现**（出现即截断 CSS，报错长得很莫名其妙：
   tsc 会指着某个 CSS 选择器说「',' expected」）。2026-10-09 这一天已经因此栽了**两次**，
   两次都是想在注释里引用一个 CSS 属性名就顺手打了反引号。⇒ 写完扫一遍：
   awk 'NR>=380 && NR<=560 && // {print NR}' packages/plugin/src/client/pill.ts  */
.drc-sec { display: flex; flex-direction: column; gap: 14px; max-width: 720px;
  color: ${hostVar('label-primary')}; }
/* 抬头：标题 + 一句"这一页是干什么的"。副标题不是装饰——没有它，第一次进来的人
   看到的是一张没有上下文的二维码。 */
.drc-sec-header { display: flex; flex-direction: column; gap: 4px; }
.drc-sec-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.4; }
.drc-sec-sub { margin: 0; color: ${hostVar('label-secondary')}; font-size: 13px; line-height: 1.7; }
/* 四张卡直接进网格 = 一个 2×2 矩阵。
   ⚠️ 第一版是「两栏各套一个 flex 列」，两栏各排各的 ⇒ 第二行两张卡的顶边差了近 300px，
   整屏看过去像两张不相干的列表（2026-10-09 真屏幕截图）。
   ⚠️ 第二版用 align-items:start 让各卡保持自然高度 ⇒ 同一行里那张矮的卡下面空出一大块，
   右边整列看着"掉了一块"。用户要的是**同行等高**（两栏从顶到一样齐），
   所以去掉 align-items:start（grid 默认 stretch）；多出来的高度分给内容居中的那张卡。
   ⚠️ 第三版要的是一个 flex 行容器放标题+动作（第一版把 headrow 当成标题的类名用过，
   那个 flex 行根本没形成，动作又掉回底部）。见 drc-sec-headrow。 */
/**
 * 主区：默认单列；带 data-two="1" 时两栏**各占一半、底边对齐**。
 *
 * 3.2 起设置页恒为两张卡（配对 + 进阶），所以这个属性恒被设上——它留着是因为
 * 「两张并排」这件事在 DOM 上可见、可测；而窄屏下必须能退回单列（下面的媒体查询），
 * 否则卡片会被压到 180px 宽，6 位码与表单全糊在一起。
 */
.drc-sec-grid { display: grid; gap: 14px; }
/**
 * 窄栏退成一列。
 *
 * ⚠️ **必须是一个独立的 @media 而不是紧跟其后的第二条 「grid-template-columns」**：
 * 同一条规则里后写的声明会**静默覆盖**前一条（CSS 没有"两条都生效"这回事），
 * 而任何静态检查都看不出来（两条声明都合法）。
 *
 * ⚠️ 选择器要写到 [data-two="1"] 这一档：只写 .drc-sec-grid 的话特异性低于
 * 那条两栏规则，窄屏下照样是两栏（2026-10-21 实测）。
 */
@media (max-width: 620px) { .drc-sec-grid,
  .drc-sec-grid[data-two="1"] { grid-template-columns: minmax(0, 1fr); } }
/**
 * 两栏各占一半（2026-10-21）：右列放的是「进阶」那张表单，不是一张 148px 的图。
 * align-items: stretch 是用户明确要的"等高"：两张卡底边对齐，页面下半截不再是锯齿。
 */
.drc-sec-grid[data-two="1"] { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: stretch; }
/* 卡片：宿主的卡片是一条 1px 边 + 一层底 + 12px 圆角，我们照抄。 */
.drc-sec-card { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 16px;
  border: 1px solid ${hostVar('border-l2')}; border-radius: 12px;
  background: ${hostVar('bg-layer-3')}; }
/* 卡片标题比分区标题低一档：它是"这张卡的身份"，不是"这一页的身份"。 */
.drc-sec-heading { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.4; }
/* 状态那一行：灯 + 结论，比卡片标题低一档、比正文略淡。 */
/* ── 状态条：整栏最上面一行，第一眼回答「连上没有」 ── */
.drc-sec-status { display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 10px 14px; border: 1px solid ${hostVar('border-l1')};
  border-radius: 10px; background: ${hostVar('bg-layer-1')}; }
.drc-sec-statushead { display: flex; align-items: center; gap: 8px; min-width: 0; }
.drc-sec-statustext { font-size: 14px; font-weight: 600; }
.drc-sec-statushint { color: ${hostVar('label-secondary')}; font-size: 12px; }
.drc-sec-statushint:empty { display: none; }

/* ── 页脚：三步 + 元信息（第三等内容，不该各占一张卡）── */
.drc-sec-footer { display: flex; flex-direction: column; gap: 8px; }
.drc-sec-steps { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0; padding: 0;
  list-style: none; counter-reset: drc-step; font-size: 13px;
  color: ${hostVar('label-secondary')}; }
.drc-sec-step { display: flex; align-items: center; gap: 6px; }
.drc-sec-step::before { counter-increment: drc-step; content: counter(drc-step);
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border-radius: 50%;
  background: ${hostVar('bg-layer-3')}; color: ${hostVar('label-secondary')};
  font-size: 11px; line-height: 1; }
.drc-sec-footnote { margin: 0; font-size: 12px; color: ${hostVar('label-tertiary')}; }
.drc-sec-meta { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px;
  color: ${hostVar('label-tertiary')}; }
.drc-sec-meta:empty { display: none; }
.drc-sec-meta-item { display: inline-flex; gap: 6px; }
.drc-sec-meta-key { color: ${hostVar('label-secondary')}; }
/* ⚠️ 值必须比键**深**（2026-10-09 深度 review 的 D2）：这一格原先没有独立规则，
   继承了 .drc-sec-meta 的 label-tertiary，而键用的是 label-secondary ——
   于是值比键还淡，读起来像「标签是内容、值是注释」。

   ⚠️ **这段注释里不许出现反引号**：CSS 整体是一个 JS 模板字符串，反引号会**提前闭合它**
   （症状是 bundle 当场编译失败，报错还指向几百行之外的 textContent = CSS）。
   今晚在这上面栽了两次。 */
.drc-sec-meta-value { color: ${hostVar('label-primary')}; }

/* 已配对那一支：一行字就够，不占一整块 */
.drc-sec-done { display: flex; align-items: center; justify-content: center;
  min-height: 120px; font-size: 14px; }

/* 配对二维码：**绝对的白纸**（与 pill 面板同一个理由——暗色主题下码必须还是黑压白，
   跟着主题走就是一张扫不出来的码），四周留 8px 静默区。 */
.drc-sec .drc-qr { display: block; width: 240px; height: 240px; margin: 0 auto; padding: 8px;
  background: ${FIXED_WHITE}; border-radius: 10px; image-rendering: pixelated; }
/* 6 位码：扫不出来时它是唯一退路，所以单占一行、等宽数字、拉字距——
   它是一串"要念出来敲进去"的数字，不是正文里的一个词。 */
.drc-sec-code { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.drc-sec-code-label { color: ${hostVar('label-tertiary')}; font-size: 12px; }
.drc-sec .drc-code { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: 2px;
  text-align: center; font-variant-numeric: tabular-nums; }
.drc-sec .drc-count { margin: 0; text-align: center; color: ${hostVar('label-secondary')};
  font-size: 12px; font-variant-numeric: tabular-nums; }
.drc-sec .drc-count[data-kind="urgent"] { color: ${hostVar('state-warn-primary')}; font-weight: 600; }
/* 引导句与状态句分两档：前者答"怎么用"，后者答"现在什么情况"。
   合成一档的后果是"发不出配对码"和"用微信扫这张码"长得一模一样。 */
.drc-sec-guide { margin: 0; color: ${hostVar('label-tertiary')}; font-size: 13px; line-height: 1.7; }
.drc-sec-state { margin: 0; color: ${hostVar('label-secondary')}; font-size: 13px; line-height: 1.7; }
.drc-sec-state[data-kind="failed"] { color: ${hostVar('state-error-primary')}; }
/* 手机端那张小程序码：与配对二维码同一张白纸，但小一号——它答的是"去哪儿装客户端"，
   不是这一屏的主动作。两张码同时出现，尺寸与标题必须让人一眼分得清哪张是哪张。 */
.drc-mp { display: block; width: 148px; height: 148px; margin: 0 auto; padding: 8px;
  background: ${FIXED_WHITE}; border-radius: 10px; object-fit: contain; }
/* 同行等高之后，这张卡（内容只有一张小图 + 两行字）比配对卡矮一截。
   justify-content: center 把内容居中，多出来的高度上下分一半，
   而不是全堆在下面变成一块空白。 */
.drc-sec-card[data-layout="figure"] { justify-content: center; }
.drc-sec-caption { margin: 0; text-align: center; font-size: 13px; font-weight: 600;
  color: ${hostVar('label-primary')}; }
/* 这张卡里三样都居中（图、名字、那句说明）：图居中而说明左对齐会读成"两块东西"。
   说明只有一两行，居中不影响扫读——长段落才需要左对齐。 */
.drc-sec-note { margin: 0; text-align: center; color: ${hostVar('label-tertiary')};
  font-size: 12px; line-height: 1.7; }
/* 动作排在本区块**右上角**（2026-10-09 用户定的）：与状态栏那颗 pill 的抬头同一形状
   （那边是「左侧状态 + 右侧动作」），而卡片底部那一排会把下面的事实表推得更远。
   margin-left: auto 是让它们贴到标题那一行的右边——卡片是 flex 列，所以靠这条推。 */
.drc-sec-headrow { display: flex; align-items: flex-start; gap: 12px; }
.drc-sec-headrow .drc-sec-heading { min-width: 0; flex: 1 1 auto; }
.drc-sec-headrow .drc-sec-actions { flex: 0 0 auto; margin-left: auto; }
.drc-sec-btn { appearance: none; font: inherit; font-size: 13px; line-height: 20px;
  padding: 5px 14px; border: 1px solid ${hostVar('border-l1')}; border-radius: 8px;
  background: transparent; color: ${hostVar('label-primary')}; cursor: pointer; }
.drc-sec-btn:hover { background: ${hostVar('interactive-bg-hover')}; }
.drc-sec-btn:focus-visible { outline: 2px solid ${hostVar('brand-primary')}; outline-offset: 1px; }
/* 主动作填色，字用绝对白：与二维码那张纸同一个理由——白字压品牌色在明暗两套主题里都成立。
   ⚠️ **必须把 :hover / :focus-visible 一并列出来**（2026-10-09 真屏幕截图抓到的白底白字）：
   宿主有一份全局 button{background:var(--dsw-alias-interactive-bg-hover-solid)} 的 reset，
   而我们的 .drc-sec-btn:hover 与它**同为 (0,2,0)**，且那份宿主样式表**后加载**
   ⇒ 指针停在按钮上时，主动作底色被压成那块浅灰、字仍是绝对白 ⇒ 按钮整个消失。
   只写 [data-kind="primary"] 一条赢不了 :hover（同优先级、它在前）。
   !important 不许用：那是把整个宿主面都让出去，而这里只要把三个特异度对齐。 */
/* 填充与字色各拿各的宿主令牌（理由见 FALLBACK 里那两条注释）：浅底必须配深字，反之亦然。
   ⚠️ **这里不许再出现 FIXED_WHITE** —— 那张绝对白只留给二维码与小程序码那两张纸
   （能不能被扫出来由码点与纸的对比度决定，不该跟着主题走）；
   而给按钮的浅填充配白字，就是"按钮整个消失"的那个形状。 */
.drc-sec-btn[data-kind="primary"] { border-color: transparent;
  background: ${hostVar('button-primary-fill')}; color: ${hostVar('label-primary-foreground')}; }
.drc-sec-btn[data-kind="primary"]:hover { border-color: transparent;
  background: ${hostVar('button-primary-fill')}; color: ${hostVar('label-primary-foreground')}; }
.drc-sec-btn[data-kind="primary"]:focus-visible { border-color: transparent;
  background: ${hostVar('button-primary-fill')}; color: ${hostVar('label-primary-foreground')};
  outline: 2px solid ${hostVar('brand-primary')}; outline-offset: 1px; }
/* ── 小程序码还在路上：那一格的占位 ─────────────────────────────────────
   那一格不是本地文件：宿主要**中继拿着 appSecret 去微信那边签一张码**才回得来
   （一次往返 1～3 秒），而屏幕这一侧是 <img>，它在落地之前就是一个**空框**——
   分不清「正在取」与「取不到」，而这两种的下一步完全不同。
   ⇒ 用一个**等大的**占位顶住：图到了把它收掉，取不到就换成一句人话。
   ⚠️ 占位必须与图**同样大小**（面板 200×200 / 设置页 240×240 + 8px 内边距），
   否则图一到整块就跳一下。 */
.drc-qr-loading { display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; width: 200px; height: 200px; margin: 8px auto 0; padding: 0;
  background: ${FIXED_WHITE}; color: ${hostVar('label-secondary')};
  font-size: 12px; line-height: 1.6; text-align: center; }
.drc-sec .drc-qr-loading { width: 240px; height: 240px; margin: 0 auto; padding: 8px; border-radius: 10px; }
.drc-spinner { width: 18px; height: 18px; flex: 0 0 auto; border-radius: 50%;
  border: 2px solid ${hostVar('border-l1')}; border-top-color: ${hostVar('brand-primary')};
  animation: drc-spin 0.9s linear infinite; }
@keyframes drc-spin { to { transform: rotate(360deg); } }
/* 取不到就不许再转：转圈只表示「还在等」，而它已经不成立了。
   ⚠️ 失败那一档要换成一句能指路的实话（红字），不是一片灰。 */
.drc-qr-loading[data-state="failed"] { color: ${hostVar('state-error-primary')}; }
.drc-qr-loading[data-state="failed"] .drc-spinner { display: none; }
.drc-qr-loading-hint { color: ${hostVar('label-tertiary')}; }
/* 图没到之前，那个空框不许露出来（浏览器会给未加载的 img 画 alt 文本，
   失败的那一张会画成一张破图）。
   ⚠️ 这条必须排在 .drc-sec .drc-qr **之后**：两者特异度相同（都是两个类），
   后写的赢；写在前面的会被后面那条 display:block 整条覆盖掉（2026-10-06 踩过同一形状）。 */
.drc-qr[data-load="loading"], .drc-qr[data-load="failed"] { display: none; }
`

/** 认得出 slots 服务吗：`inject`（认领槽位）与 `register`（往里放组件）两个函数都得在。 */
function isSlots(value: unknown): value is SlotRegistry {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.inject === 'function' && typeof record.register === 'function'
}

/**
 * 从一个候选里认出 slots：候选本身就是服务，或者它是个能 `get('slots')` 的上下文。
 * 真 cordis 两种都会出现——`ctx.get` 给的是服务本身，而 `ctx.inject` 的回调参数是
 * **作用域化上下文**，要在它上面再 get 一次。读没声明的属性是**抛错**而不是返回
 * undefined，所以这里整段包 try（调用方还要为"抛了"留一条 warn）。
 */
function pickSlots(source: unknown): SlotRegistry | undefined {
  if (isSlots(source)) return source
  const asGettable = source as Gettable | null | undefined
  if (asGettable && typeof asGettable.get === 'function') {
    try {
      const got = asGettable.get('slots', true)
      if (isSlots(got)) return got
    } catch {
      /* 这个候选没有该服务 */
    }
  }
  return undefined
}

/**
 * 装载这份 bundle 的 `__ModuleLoader__` 传进 factory 的那个 require（见
 * `scripts/bundle-plugin.mjs` 的外壳）。这里**不用 `import`**，理由写在下面。
 */
declare const require: ((id: string) => unknown) | undefined

/**
 * 向装载器要 react 的 `createElement`；拿不到就是没有 pill，而不是整页起不来。
 *
 * 模块名走**变量**而不是字面量，这条不是风格问题：字面量 `require('react')` 会被打包器在
 * 构建期解析成 factory 顶层那一句，一旦宿主给不出这个模块，抛出发生在 factory 第一行——
 * 那是"web boot: N entry/entries did not activate"，整页都起不来。
 * 走变量则留在运行期，被这里的 try 接住。（`scripts/bundle-plugin.mjs` 里有一条断言
 * 盯着产物中不得出现 `require("react")` 那种静态形式。）
 */
export function findCreateElement(): CreateElement | undefined {
  try {
    if (typeof require !== 'function') return undefined
    const moduleId = 'react'
    const react = require(moduleId) as
      { createElement?: CreateElement; default?: { createElement?: CreateElement } } | undefined
    const create = react?.createElement ?? react?.default?.createElement
    return typeof create === 'function' ? create : undefined
  } catch {
    return undefined
  }
}

function warn(message: string, error?: unknown): void {
  try {
    const detail = error instanceof Error ? error.message : error === undefined ? '' : String(error)
    console.warn(`[dsh-remote-control pill] ${message} ${detail}`)
  } catch {
    /* 控制台也可能不可用 */
  }
}

/**
 * 设置分区那一半的降级留痕出口（2026-08-09）。
 *
 * 与 pill 用**同一个 console.warn 形状**但前缀不同：屏幕上少的是哪一块，日志里要能一眼分开
 * （两边都写 `[dsh-remote-control pill]` 的话，排查时得靠猜）。
 */
export function warnSection(message: string, error?: unknown): void {
  try {
    const detail = error instanceof Error ? error.message : error === undefined ? '' : String(error)
    console.warn(`[dsh-remote-control settings] ${message} ${detail}`)
  } catch {
    /* 控制台也可能不可用 */
  }
}

/**
 * 注入这张样式表（幂等：已插过就按内容对齐）。
 *
 * ⚠️ 导出给 `settings.ts` 用（2026-08-09）。**设置页必须自己调它**，不能指望 pill 先挂上：
 * 没有会话时 pill 那个槽位根本不渲染 ⇒ `buildPill` 不跑 ⇒ 样式永远不注入 ⇒
 * 设置里那一页是**完全没样式的裸文本**。而这正是它存在的场景（新会话、还没有会话）。
 * 判据 `排版：注入的 CSS 真的带着宿主分区的取值` 就是照这条写的，它抓到过这一处。
 */
export function ensureStyle(doc: Document): void {
  try {
    const existing = doc.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
    if (existing) {
      /**
       * 已经插过就**按内容对齐**，不能只看"有没有插过"就返回。
       *
       * 宿主换新版这一半时文档未必重载（HMR 只替换模块、`<head>` 里的 `<style>` 原样留着），
       * 于是新代码按新结构建 DOM、旧样式却还在生效——真屏幕上表现为整块面板错位
       * （2026-10-03 用户截图：抬头那颗按钮掉到第二行居中，那是上一版 `.drc-actions` 的
       * `justify-content: center` 在管事）。这一条就是那次事故的修法。
       */
      // `data-plugin` 也补一次：上一版只打了 `data-plugin-css`，而宿主 `claimStyles`
      // 只认 `data-plugin`——不补的话这份样式会被算到别的插件头上（见 PLUGIN_ID 的注释）。
      existing.setAttribute('data-plugin', PLUGIN_ID)
      if (existing.textContent !== CSS) existing.textContent = CSS
      return
    }
    const element = doc.createElement('style')
    // 两个属性都要：`data-plugin-css` 是我们自己的探针（按它找回来对齐内容），
    // `data-plugin` 是**宿主**认领这份样式的凭据——少了它，别的插件 HMR 会把我们这份删掉。
    element.setAttribute('data-plugin-css', STYLE_ID)
    element.setAttribute('data-plugin', PLUGIN_ID)
    element.textContent = CSS
    doc.head.appendChild(element)
  } catch (error) {
    warn('样式注入失败（pill 仍可用，只是没配色）', error)
  }
}

/**
 * 每条请求的超时信号。**拿不到 `AbortSignal.timeout` 就不带 signal**（老环境 / vm 夹具），
 * 而不是让这里抛出去——它的调用方在降级路径上，抛出去等于把"宿主卡住"升级成"面板坏了"。
 */
function requestSignal(): AbortSignal | undefined {
  try {
    const timeouts = (globalThis as { AbortSignal?: { timeout?: (ms: number) => AbortSignal } }).AbortSignal
    return typeof timeouts?.timeout === 'function' ? timeouts.timeout(FETCH_TIMEOUT_MS) : undefined
  } catch {
    return undefined
  }
}

export interface PillDeps {
  fetchImpl(input: string, init?: Record<string, unknown>): Promise<unknown>
  /** 降级留痕的出口；单测用它钉住"这条路坏了但页面还能用"。 */
  warn?(message: string): void
}

/**
 * 在 `root` 里建出那颗 pill，返回卸载函数。
 *
 * DOM 是命令式的（React 只负责给个挂载点），所以这里能把"面板开着时倒计时走完要自动换码"
 * 这种时序写成可测的分支。`fetchImpl` 是注入口：真实故障形状（200+unavailable 当成功、
 * 过期后不再重试）只有喂假回答才复现得出来。
 */
function buildPill(root: Element, deps: PillDeps): () => void {
  const doc = root.ownerDocument
  ensureStyle(doc)

  const button = doc.createElement('button')
  button.type = 'button'
  button.className = 'drc-pill'
  button.setAttribute('aria-haspopup', 'dialog')
  button.setAttribute('aria-expanded', 'false')
  const dot = doc.createElement('span')
  dot.className = 'drc-dot'
  dot.setAttribute('aria-hidden', 'true')
  const label = doc.createElement('span')
  label.className = 'drc-label'
  button.appendChild(dot)
  button.appendChild(label)
  root.appendChild(button)

  let panel: HTMLElement | undefined
  let statusTimer: ReturnType<typeof setInterval> | undefined
  let countTimer: ReturnType<typeof setInterval> | undefined
  let view: PanelView = { kind: 'info' }
  /**
   * 屏上那个"还剩多少"（秒数文本与"已过期"提示都读它）。
   *
   * 它是**算出来的**，不是数出来的 —— 真相是下面的 `expiresAt`（墙钟到期时刻）。
   * 见 `syncCountdown` 的注释：这一行曾经是"每个节拍减 1000"。
   */
  let expiresInMs = 0
  /** 这张码的**墙钟**到期时刻（`Date.now()` 口径）。倒计时的一切都从它重算。 */
  let expiresAt = 0
  let lastStatus: StatusAnswer | undefined
  /** 面板开着等首次 `/status`：这段时间**一颗码都不发**（见 `openPanel` 那条注释）。 */
  let awaitingStatus = false
  /** 轮询的 in-flight 守卫：上一发还没落地时，下一拍不再发（宿主卡住时才不会叠请求）。 */
  let polling = false
  /** 倒计时那一行的文本节点；每秒那一拍只改它，不整块重画面板（见 `paintCountdown`）。 */
  let countNode: HTMLElement | undefined
  let disposed = false
  /**
   * 小程序码那张图的加载态（`loading` / `ready` / `failed`）。
   *
   * 状态一变就重画：图到了要把占位收掉，取不到要把「正在转」换成一句人话。
   * ⚠️ 这个回调是**浏览器**在 `load` / `error` 事件里调的（不是我们发请求推进的），
   * 它可能在我们没在等的时候来 ⇒ 重画必须自己站得住（`disposed` 之后不许再动屏）。
   */
  const mpCode = createMpCodeImage(doc, () => {
    if (!disposed) paint()
  })

  /** 面板上那颗按钮的文案要跟着抬头那句走，所以这里读的是同一份轮询结果。 */
  /**
   * 「配没配上」读的是**密钥簿**（pairings），不是此刻有几台手机连着（paired）。
   * 2026-10-04 改的：pair-store 之后配对按 D3 长存，手机退后台只是 socket 断——
   * 用 paired 判断「配没配上」，用户把小程序放进后台的每一分钟，这四处
   * （抬头、按钮身份、点开发不发码、配好后翻不翻面）全都会说「未配对」。
   */
  const pairingNow = (): number => pairingCount(lastStatus)

  /**
   * 降级留痕：**注入的出口优先**，没接上才退回本文件那个 `warn()`。只写一处出口，
   * 免得同一条降级在控制台里出现两遍。
   *
   * `deps.warn` 曾经是个死参数：`buildPill` 的唯一生产调用点（`mountPill`）只传了
   * `fetchImpl`，于是"status 路由没挂上"这类降级在页面上一声不响（2026-10-06 修）。
   */
  const degrade = (message: string, error?: unknown): void => {
    if (!deps.warn) {
      warn(message, error)
      return
    }
    try {
      const detail = error instanceof Error ? error.message : error === undefined ? '' : String(error)
      deps.warn(`${message} ${detail}`.trim())
    } catch {
      /* 出口自己抛了也不能连累页面 */
    }
  }

  /**
   * 每条请求都带 3 秒硬超时（`AbortSignal.timeout`）。
   *
   * 2026-10-06 修：原来所有 fetch 都没有超时，而轮询是 2 秒一拍——宿主转发层卡住时
   * 表现是"每 2 秒叠一个永远不会落地的请求"，尾延迟越叠越长。
   */
  const fetchWithTimeout = (input: string, init: Record<string, unknown>): Promise<unknown> => {
    const signal = requestSignal()
    return deps.fetchImpl(input, signal ? { ...init, signal } : init)
  }

  /** 离开二维码那一屏时倒计时必须停：留着就是一个每秒还在重画的孤儿定时器。 */
  const stopCountdown = (): void => {
    if (countTimer !== undefined) {
      clearInterval(countTimer)
      countTimer = undefined
    }
    expiresInMs = 0
    expiresAt = 0
  }

  /**
   * 把"还剩多少"按**墙钟**重算一遍，返回这张码此刻还有没有效。
   *
   * ## 为什么不能是"每个节拍减 1000"（2026-10-07 审计）
   *
   * 原来那一行是 `expiresInMs -= 1000`：屏上的数字只准到"浏览器有没有按秒交出那一拍"。
   * 而**用户点开发码面板之后必然要去切走**——掏出手机打开微信扫��，这个窗口正是
   * 计时器最不可靠的时候：Chrome 对隐藏页做 intensive throttling（一分钟才醒一次），
   * Electron 还会把不可见的窗口冻起来，合上盖子则直接停摆。
   *
   * 于是最常见的用法恰好是最坏的情况：面板开着、切走两分钟、回来一看还写着
   * "2 分 5 秒后过期"，而那张码两分钟前就死了 —— 用户扫的是一个显示上"还活着"的死码，
   * 手机回一句配对失败，而面板从头到尾没说过一句"已过期"。**这正是 2026-10-05
   * 现场报的那件事**，倒计时本来就是为了治它，结果用同一个错误把它放回来了。
   *
   * 倒计时是一个**期限**的投影，不是节拍器的读数：只认墙钟，节拍只负责"什么时候重画"。
   * 单拍走飞（后台冻结）也自愈 —— 下一拍按墙钟重算，一次就补回全部欠账。
   */
  const syncCountdown = (): boolean => {
    expiresInMs = Math.max(0, expiresAt - Date.now())
    return expiresInMs > 0
  }

  /**
   * 倒计时走完的收场：停表 + **自动补一张**。
   *
   * 单独抽出来是因为**两条路**都要走到它：节拍自己走到 0，以及切回前台时
   * `resyncCountdown` 发现那张码在后台期间就已经过期（那一路才是现场那次的真实时序：
   * 面板开着切走，回来时表早就停了，`expiresInMs` 却还停在切走前那一拍）。
   *
   * **过期自动换码**（2026-10-23 用户裁决）：这里原来只画一句
   * 「配对码已过期 点右上角刷新重新生成」——2026-10-05 定的"该重发还是让用户自己按"。
   * 现场反过来：倒计时走完码就"没了"，用户以为坏了，还得自己找按钮。留在废码上
   * 比没有码更糟（用户会一直扫一张不作数的图）⇒ 过期就地换一张，与配置页
   * （`settings.ts` 的 `startCountdown`）同一口径——两边不该有两种行为。
   * 发码路复用「刷新」按钮那条（`requestPairing`）：离线守卫 / 幂等 / 失败说明
   * 都在那条路上，不另写一条。取码失败时那条路自己会把原因画出来，手动口仍在。
   */
  const expireCountdown = (): void => {
    if (countTimer !== undefined) {
      clearInterval(countTimer)
      countTimer = undefined
    }
    expiresAt = 0
    expiresInMs = 0
    // 整块重画这一拍（`<img>` 仍按 src 复用，不会多向 `/pairing.png` 要一张——
    // 每秒重画的问题见 `paintCountdown`），然后走发码。
    paint()
    void requestPairing()
  }

  const write = (): void => {
    const next = pillLabel(lastStatus)
    label.textContent = next.text
    dot.setAttribute('data-tone', next.tone)
    button.setAttribute('title', `dsh-remote-control：${next.text}`)
    button.setAttribute('aria-label', next.text)
  }

  const text = (tag: string, className: string, content: string): HTMLElement => {
    const node = doc.createElement(tag)
    node.className = className
    node.textContent = content
    return node
  }

  const buttonOf = (content: string, onClick: () => void): HTMLElement => {
    const node = doc.createElement('button')
    node.type = 'button'
    node.className = 'drc-btn'
    node.textContent = content
    node.addEventListener('click', onClick)
    return node
  }

  /** 二维码那一行的说明：没过期报剩余时间，过期了就明说要自己再按一次（不再自动补一张）。 */
  // 2026-10-05 用户定的口径：不加间隔号、不用书名号——扫一眼的行，一个多余符号
  // 就多一分"像系统消息不像人话"的感觉。"微信扫码配对"直接点名用哪个 App 扫。
  // 过期那句话现在由倒计时那行与 note 分工：倒计时说"还有多久"，note 只在
  // 已经过期时说话（还能用的时候它闭嘴——一行说一件事）。
  const qrNote = (): string => (expiresInMs > 0 ? '' : '配对码已过期 点右上角刷新重新生成')

  /**
   * 二维码顶上那行**倒计时**：还剩多久这一页就不作数了。
   *
   * 2026-10-05 线上取证：配对码服务端权威寿命 3 分钟，而旧版只有 1 秒 tick 走完后
   * note 才改口"已过期"——那之前用户看到的是一张**没有任何时间信息**的码。手机上
   * 挪聊天界面、找小程序、点扫描，三分钟经常就这么过去的，于是"显示着码却配不上"。
   * 现在剩余秒数一直在码的旁边，最后 30 秒还会变重（见 CSS 的 `data-kind`）。
   */
  const countdown = (): HTMLElement | null => {
    // 每次重画都换一个新节点，所以旧引用必须先清掉：`paintCountdown` 只认最新那一个。
    countNode = undefined
    if (view.kind !== 'qr') return null
    if (expiresInMs <= 0) return null
    const node = text('p', 'drc-count', `${secondsText(expiresInMs)}后过期`)
    if (expiresInMs <= 30_000) node.setAttribute('data-kind', 'urgent')
    countNode = node
    return node
  }

  /**
   * 倒计时那一拍：**只改这一行的文本**，不重画面板。
   *
   * 2026-10-06 修：原来每秒 `paint()` 一次，而 `paint()` 是 `panel.replaceChildren()`
   * 整块重建——`<img>` 跟着被换掉，`/pairing.png` 又是 `no-store`，于是**每秒重新请求
   * 并让服务端重新编码一整张 PNG**。现在每秒只有这一行文本在动，码与图原地不动；
   * 只有走完最后 1 秒（那屏的话要改口）才整块重画一次，而那一刻 `<img>` 仍按 src 复用
   * （见 `qrImage`），所以还是不会多请求一张图。
   */
  const paintCountdown = (): void => {
    if (!panel || view.kind !== 'qr') return
    const node = countNode
    if (!node) {
      paint()
      return
    }
    node.textContent = `${secondsText(expiresInMs)}后过期`
    if (expiresInMs <= 30_000) node.setAttribute('data-kind', 'urgent')
  }

  /**
   * 二维码那张图。**同一个 src 复用同一个元素**（理由与加载态见 `createMpCodeImage`）：
   * `/pairing.png` 是 `no-store`，每新建一个 `<img>` 都必然重新请求、服务端重新编码一整张 PNG。
   * 换码时 src 里那个 `?e=<epoch>` 会变，那时才建新元素——那时本来就该取新图。
   */
  const qrImage = (src: string): HTMLElement => mpCode.element(src)

  /**
   * 抬头一行：左边状态、右边动作。**面板唯一那颗动作按钮就收在这里**（面板的右上角）。
   *
   * 2026-10-04 这一轮把"未配对 → 先生成配对码"那一屏删掉了：**未配对时点开就是二维码页**，
   * 所以那颗按钮只剩两种身份——配上了是 `退出配对`，没配上是 `刷新`（重要一张码，
   * 走同一条幂等发码路由：码还在就还是它、过期了才换新的）。原来"生成配对码 / 刷新"
   * 是同一件事的两个说法，而删掉那一屏之后连这个歧义都不存在了。
   *
   * 状态那句话跟那颗 pill 读同一份 `pillLabel(lastStatus)`，所以面板开着时轮询一回来
   * （比如手机上刚扫完码）这句话就跟着变。
   *
   * 2026-10-05 用户报"显示着码却配不上"之后，这颗按钮的含义被第三次收紧：
   * 它现在是**唯一**的续命入口（码过期 / 中继恢复后都归它），所以码过期那一屏的
   * note 直接点名"点右上角刷新"，倒计时也常显——三分钟的权威寿命不能只由
   * 服务端知道。
   */
  const header = (): HTMLElement => {
    const head = doc.createElement('div')
    head.className = 'drc-head'
    const state = pillLabel(lastStatus)
    const stateText = text('span', 'drc-head-label', state.text)
    stateText.setAttribute('data-tone', state.tone)
    head.appendChild(stateText)
    const actions = doc.createElement('div')
    actions.className = 'drc-actions'
    const action = pairingNow() > 0 ? { label: '退出配对', run: requestUnpair } : { label: '刷新', run: requestPairing }
    actions.appendChild(buttonOf(action.label, () => void action.run()))
    head.appendChild(actions)
    return head
  }

  /**
   * 「手机离线」那一屏的解释行；不是那个状态时返回 null（不占地方）。
   *
   * **只留最要紧的六个字**（2026-10-05 用户：文案太长）。
   * 原来是「配对还在 小程序回前台会自动重连 不用重新扫码」——三句、三十多字，
   * 而用户要的行动只有一个判断：要不要去扫码。答案是不要，那就只说不要。
   *
   * 为什么不能整句删掉：它当初是为了修一个真实误解加的
   * （2026-10-04 用户看到「手机离线」就去扫一个不需要扫的码）。
   * 少了这句，用户会以为得重新配对。所以留结论、砍解释。
   */
  const offlineNote = (): HTMLElement | null => {
    if (!lastStatus) return null
    if (pillLabel(lastStatus).text !== ZH.phoneAway) return null
    return text('p', 'drc-note', '不用重新扫码')
  }

  /** 正文那几行（待处理 / 中继 / 状态 / 版本）；某一行拿不到值时它自己不占地方。 */
  const infoRows = (): HTMLElement[] => {
    if (!lastStatus) return []
    const rows: Array<[string, string]> = [
      // 排第一：它是唯一一条"看完要做点什么"的，其余三条都是"知道就行"。
      ['待处理', waitingRow(lastStatus)],
      ['中继', relayRow(lastStatus)],
      ['状态', relayStateRow(lastStatus)],
      ['版本', versionRow(lastStatus)],
    ]
    return rows
      .filter(([, value]) => value !== '')
      .map(([key, value]) => {
        const row = doc.createElement('div')
        row.className = 'drc-info'
        row.appendChild(text('span', 'drc-key', key))
        row.appendChild(text('span', 'drc-value', value))
        return row
      })
  }

  /**
   * 画当前这一屏：**抬头 + 视图主体 + 那几行正文**，三种视图都带正文那几行。
   *
   * 原来二维码那一屏是 `return` 掉的（正文只在状态屏出现），但"未配对点开就是二维码页"之后
   * 那一屏成了未配对时唯一的一屏——把正文藏起来就等于把"连的哪一台 / 连没连上 / 跑的是哪一版"
   * 和"这台机器上有没有回合被卡住"四条事实一起删了（伞仓 docs/PRODUCT.md §3 第 2 条要它们在场）。
   * `loading` 也照带：它只有几百毫秒，不带会让面板先窄后宽地跳一次。
   */
  const paint = (): void => {
    if (!panel) return
    panel.replaceChildren()
    panel.appendChild(header())
    /**
     * 确认码在**抬头之后、各屏内容之前**（2026-10-21 真机事故）。
     *
     * 原来它只画在 `qr` 那一屏（未配对态）。而面板进不进那一屏看的是
     * `pairingNow() > 0`（**密钥簿里还有几条会话**），不是"此刻有没有人在等你放行"。
     *
     * ⇒ **死锁**：主机密钥簿里只要留着**任何一条**会话（哪怕那台手机早就不在了），
     * 面板就进 `info` 态 ⇒ **确认码不渲染** ⇒ 用户无从比对
     * ⇒ 主机永远不回 `pair-grant` ⇒ 手机永远卡在"正在连接…"
     * ⇒ 而主机那边显示的是"已配对，不用再扫码"——**看起来一切正常**。
     *
     * 真机现场（2026-10-21 23:00）：中继日志里 `paired` **每次都成功**、
     * 主机 `pairApproval` 也确实挂上了申请（token 006867 / sas 325175），
     * 可用户点了半天找不到那个按钮 ⇒ 每一轮都只能换一张新码重来。
     *
     * ⇒ **确认码属于"有申请"这件事，不属于"哪一屏"。**
     * 放在抬头之后是为了保住"数字排在码之前"那条约定（用户先比对再扫，
     * 比扫完回头找数字少一次来回）。
     */
    appendApprovalBlock(panel)
    if (view.kind === 'loading') {
      // 两种 loading：等首次 `/status`（还没决定该不该发码）与正在发码。分开说，
      // 因为"正在生成配对码"在等状态那几百毫秒里是句假话（那时一个请求都还没发）。
      panel.appendChild(text('p', 'drc-note', awaitingStatus ? '正在读取主机状态' : '正在生成配对码'))
    } else if (view.kind === 'offline') {
      // 中继不在线：二维码这一屏整个不画。
      //
      // 2026-10-05 线上取证：主机半开掉线的那 10 分钟里 pill 照常画着一张码，用户
      // 扫码 → 中继 `invalid_or_expired` → 手机只说"配对失败"。那张码不是"还没扫"，
      // 是**扫了也必然失败**——比没有码更糟，因为它让人去试一件注定不成的事。
      // 所以离线这一屏只留一句人话加那颗刷新按钮，码等中继回来再说。
      panel.appendChild(text('p', 'drc-note drc-note-block', '主机还没连上中继 现在发不出配对码'))
      panel.appendChild(text('p', 'drc-note', '中继恢复后点右上角刷新 这里会出现二维码'))
    } else if (view.kind === 'qr') {
      const count = countdown()
      if (count) panel.appendChild(count)
      // 图按 src 复用：整块重画（倒计时走完那一拍、每 2 秒的轮询）都不该让浏览器重新
      // 请求一次 `/pairing.png`——那条路由是 no-store，新元素必然回源并重新编码。
      //
      // ⚠️ **先取元素、再读状态**：src 变了的时候 `element(src)` 会换一张新的、
      // 状态回到 `loading`，而状态是从**当前那一张**上读的。
      const image = qrImage(view.imageSrc)
      /**
       * 图还在路上 ⇒ 把"等大的那一格"画上（理由见 `createMpCodeImage`）：
       * `/pairing.png` 要中继去微信那边签一张码才回得来（1～3 秒），
       * 而 `<img>` 在它落地之前是**一个空框**——用户分不清"正在取"与"取不到"。
       */
      const loadState = mpCode.state()
      if (loadState !== 'ready') panel.appendChild(mpCodeLoadingBox(doc, loadState))
      panel.appendChild(image)
      // 第一次用的人唯一需要的那句话：这码是给谁扫的、扫完得到什么。
      // 一条、短、不带符号——侵入性比弹一次模态框小，但同样把人领进门
      // （2026-10-05 用户定的口径：引导但不侵入，文案要短）。
      panel.appendChild(text('p', 'drc-guide', GUIDE_LINE))
      // 6 位码仍然单独印一行（QR 扫不出来时那是唯一退路）。
      panel.appendChild(text('p', 'drc-code', view.token))
      // note 只在过期时出现（还有时间时那行闭嘴——一行说一件事）。
      const note = qrNote()
      if (note !== '') panel.appendChild(text('p', 'drc-note', note))
    } else if (view.kind === 'unavailable' || view.kind === 'failed') {
      const note =
        view.kind === 'unavailable'
          ? text('p', 'drc-note', view.reason)
          : (() => {
              const node = text('p', 'drc-note', `配对请求没成功：${view.detail}`)
              node.setAttribute('data-kind', 'failed')
              return node
            })()
      panel.appendChild(note)
    }
    for (const row of infoRows()) panel.appendChild(row)
    // 手机离线那一屏要提一句「不用重新扫码」：配对簿还在，小程序回前台自动重连。
    // 不说这句，用户看到「手机离线」会去扫一个不需要扫的码（2026-10-04 用户提的误解）。
    // 2026-10-05 用户嫌长，理由与那句文案本身见 offlineNote 的注释。
    const note = offlineNote()
    if (note) panel.appendChild(note)
  }

  const closePanel = (): void => {
    // 关面板要连倒计时一起收（`stopCountdown` 顺带把 expiresInMs 归零：
    // 再点开时那一屏要么重新发码、要么是状态页，都不该读到上一张码的剩余时间）。
    awaitingStatus = false
    stopCountdown()
    if (panel) {
      panel.remove()
      panel = undefined
    }
    button.setAttribute('aria-expanded', 'false')
  }

  /**
   * 面板点开时该进哪一屏——**只在已经有 `/status` 结果时才走这里**（没有结果时见 `openPanel`）。
   *
   * 顺序就是优先级：中继不在线 → 只给说明（发出去也是死码）；已配对（读密钥簿）→ 只给状态，
   * **一次码都不发**；其余（真没配上）→ 要一张码，那是这一屏唯一的内容。
   */
  const openPanelView = (): void => {
    const relay = lastStatus?.relay
    if (relay !== undefined && relay !== 'online') {
      stopCountdown()
      view = { kind: 'offline' }
      paint()
      return
    }
    if (pairingNow() > 0) {
      stopCountdown()
      view = { kind: 'info' }
      paint()
      return
    }
    void requestPairing()
  }

  async function requestPairing(): Promise<void> {
    if (disposed || !panel) return
    // 到这里面板已经自己决定了这一屏（loading / 二维码 / 说明），等首次状态那件事结束了。
    awaitingStatus = false
    // 中继不在线就**根本不发码**：旧实现在这里也会打一个 POST，路由回
    // `state:"unavailable"`，于是同一件事在两条路上各判一次（客户端还要猜
    // `reason` 的字符串）。"现在不可能有码"这件事轮询里早就知道——2 秒一次的
    // `lastStatus.relay`，用它拦在发请求之前，用户看到的是"主机还没连上中继"
    // 而不是一张必然扫不出来的码（2026-10-05 线上取证，见 offline 分支的注释）。
    if (lastStatus && lastStatus.relay !== 'online' && lastStatus.relay !== undefined) {
      stopCountdown()
      view = { kind: 'offline' }
      paint()
      return
    }
    view = { kind: 'loading' }
    /**
     * 重发码之前先把**上一张失败的那张**丢掉（`invalidate` 只丢失败的，成功的那张留着）。
     *
     * 为什么：发码那条路由是**幂等**的（码还在就还是它）⇒ 重试拿回的是**同一个 src**，
     * 而那个 src 刚才失败过。不丢掉它，这次"重试"只是把同一张失败的图再摆一次。
     */
    mpCode.invalidate()
    paint()
    let answer: NewAnswer | undefined
    let httpStatus = 0
    try {
      // 那个 `x-drc-pair` 头是**这条请求的 CSRF 判据**，不是装饰：桌面宿主会删掉转发请求的
      // `origin`，所以"Origin 必须存在"在真机上永远不成立（2026-10-03 那颗 pill 就是这么撞 403 的）。
      // 自定义头则只有同源脚本发得出——跨站要带它必然触发 CORS 预检，而这条服务不答应预检。
      const response = (await fetchWithTimeout(NEW_ROUTE, {
        method: 'POST',
        headers: { 'x-drc-pair': '1' },
        credentials: 'same-origin',
      })) as { status?: number; json?(): Promise<unknown> } | undefined
      httpStatus = typeof response?.status === 'number' ? response.status : 0
      answer = (await response?.json?.()) as NewAnswer | undefined
    } catch (error) {
      stopCountdown()
      view = { kind: 'failed', detail: error instanceof Error ? error.message : String(error) }
      paint()
      return
    }
    if (disposed || !panel) return
    view = panelViewFor(answer, httpStatus)
    if (view.kind !== 'qr') {
      /**
       * 非二维码的结果（`unavailable` / `failed`）：**倒计时必须停**。
       *
       * 2026-10-06 修：这条路上原来不清 `countTimer`，从二维码页切到"发不出码/失败"之后
       * 那个定时器还在每秒跑 `paint()`——一个孤儿节拍，屏上早已没有码可倒计时。
       */
      stopCountdown()
      paint()
      return
    }
    expiresInMs = view.expiresInMs
    expiresAt = Date.now() + view.expiresInMs
    if (countTimer === undefined) {
      countTimer = setInterval(() => {
        // 只判"还剩多少"，不负责推进 —— 推进是墙钟的事（见 `syncCountdown`）。
        if (!syncCountdown()) {
          // 到点**换一张的能力没有了**（2026-10-03 拍板）：不自动补、也没有「换一张」按钮。
          // 停表并就地把它说成"已过期"，重发与否由人再按一次那颗按钮决定。
          expireCountdown()
          return
        }
        paintCountdown()
      }, 1000)
    }
    paint()
  }

  /**
   * 退出配对：面板右上角那颗按钮（只在已配对时出现）。
   *
   * 乐观地把 `paired` 清零再重画，这样那句话与那颗按钮**当场**就翻过去，不用等下一次轮询
   * （轮询是 2 秒节拍，等它会让"按下没反应"成为错觉）。随后立刻补一次真轮询对账，
   * 万一宿主那边没作废掉（比如守卫拒了），下一次轮询会把真相带回来。
   */
  async function requestUnpair(): Promise<void> {
    if (disposed || !panel) return
    try {
      // 与发码同一条守卫：这是写路由，桌面宿主会删 `origin`，所以判据是那个自定义头。
      const response = (await fetchWithTimeout(UNPAIR_ROUTE, {
        method: 'POST',
        headers: { 'x-drc-pair': '1' },
        credentials: 'same-origin',
      })) as { status?: number; json?(): Promise<unknown> } | undefined
      /**
       * **回答不许丢掉**（2026-10-07 审计）。原来这里是裸 `await`：
       * 而 403 **不会**让 fetch 抛错，于是"守卫拒了"这件事一句都留不下——
       * 可 `routes.ts` 的 403 回答里**专门**带 `guard`，注释写着
       * "屏幕上那句话就是唯一的现场"。发码那条路经 `panelViewFor` 把它印了出来，
       * 唯独这里把它扔了：守卫拒 → 面板照样乐观翻面、照样跳去二维码页，
       * 用户看着一张自己没点过的码出现又消失，而控制台一声不响。
       *
       * 乐观翻面本身仍然保留（它治的是"按下没反应"的错觉），只是**不再冒充成功**：
       * 真失败会留一行 warn，下一次轮询照样把真相带回来。
       */
      const httpStatus = typeof response?.status === 'number' ? response.status : 0
      if (httpStatus !== 200) {
        const body = (await response?.json?.()) as { error?: unknown; guard?: unknown } | undefined
        const why = typeof body?.error === 'string' ? body.error : 'no response'
        const guard = typeof body?.guard === 'string' ? ` guard=${body.guard}` : ''
        degrade(`退出配对被主机拒了（HTTP ${httpStatus} ${why}${guard}；面板会靠下一次轮询对账）`)
      }
    } catch (error) {
      degrade('退出配对请求失败（面板会靠下一次轮询对账）', error)
    }
    if (disposed || !panel) return
    // 配对簿同时清零：`POST /unpair` 作废的就是全部通道（会话簿里一条不剩），
    // 只把 paired 归零会让抬头掉进"手机离线"——那是 2026-10-04 新加的第三态，
    // 此刻真正的事实是"没配上了"。
    if (lastStatus) lastStatus = { ...lastStatus, paired: 0, pairings: 0 }
    // 退完配对这一刻就"没配上"了，而没配上时这一屏唯一的内容就是下一张码（见 `openPanel` 那条分支）：
    // 直接进二维码页，不让用户退完之后再去别处找发码的入口——那个入口已经删掉了。
    //
    // 这里**故意不立刻补一次 `/status` 轮询**：乐观翻面与"对账"撞在同一个 tick 里，
    // 翻面就等于没翻（宿主那条路由是异步作废的，秒回的多半还是 `paired:1`）。
    // 对账交给下一次 2 秒节拍——那才是这句注释原来说的"真相会带回来"。
    write()
    view = { kind: 'loading' }
    paint()
    void requestPairing()
  }

  const openPanel = (): void => {
    if (panel || disposed) return
    panel = doc.createElement('div')
    panel.className = 'drc-panel'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'dsh-remote-control 配对')
    panel.tabIndex = -1
    root.appendChild(panel)
    button.setAttribute('aria-expanded', 'true')
    /**
     * **未配对 → 点开就是二维码页；已配对 → 点开只给状态**（发码这一步在 2026-10-04 删掉了：
     * 没配上的时候那颗按钮存在的唯一意义就是把人往二维码页推一步，而"未配对还点开看别的"
     * 不存在——面板上没有任何别的东西可看）。
     *
     * 这一条把 2026-10-03 那次"点开不发码"的取舍**反转了一半**：当时守的是
     * "看一眼不该消耗一张有寿命的 pending 码"，现在守的是同一件事，但只守**配上了**的那一侧——
     * 已配对时点开仍然一次码都不发（`pairingNow() > 0` 那条分支：读的是密钥簿，
     * 手机退后台离线时也算「配上了」——不放码，那一屏只有正文）。没配上时那张码就是这一屏
     * 唯一的内容，发它不算消耗，不发才是让人多点一次那颗注定要点一次的按钮。
     *
     * `POST /pairing/new` 是幂等的：码还活着就还是那一张，所以下面这句在"重复点开"时
     * 不会把 pending 表堆成一串码。
     *
     * **首次 `/status` 还没落地时（点开比第一拍轮询还早）不走上面任何一支**：那一刻
     * `pairingNow()` 恒为 0，直接发码会让**已配对的主机**也 POST `/pairing/new`，
     * 服务端真发一张新码——上面那句"已配对时点开一次码都不发"当场作废
     * （2026-10-06 修）。这时先画 loading、一颗码都不发，等首次轮询结果（≤2 秒）
     * 回来再由 `settlePanel()` 按同一套优先级决定进哪一屏。
     */
    if (!lastStatus) {
      awaitingStatus = true
      view = { kind: 'loading' }
      paint()
    } else {
      // 中继不在线时**点开就是说明页**：那几条分支都在 openPanelView 里。
      openPanelView()
    }
    try {
      panel.focus()
    } catch {
      /* 焦点进不去不是故障 */
    }
  }

  /**
   * 命中判定用鸭子类型而不是 `instanceof Node`：真浏览器里两者等价，但 vm 里没有 `Node`
   * 这个全局，`instanceof` 会抛 ReferenceError——那会被吞掉并误判成"没命中"，
   * 于是"点外面才关"变成"点哪里都关"。这条坑踩过就不留第二次。
   */
  const inside = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== 'object') return false
    try {
      return root.contains(candidate as Node) || (panel?.contains(candidate as Node) ?? false)
    } catch {
      return false
    }
  }

  const onPointerDown = (event: Event): void => {
    if (!panel) return
    if (inside(event?.target)) return
    closePanel()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closePanel()
  }

  /**
   * 轮询回来时把面板对齐到最新状态。
   *
   * **面板开着就重画**（2 秒一次，成本可控：文本节点重建，`<img>` 按 src 复用）——
   * 2026-10-06 修：原来只有 `qr → offline` 与 `qr → info` 两个跃迁会重画，普通状态变化
   * （在线↔断线、配对数、待处理数）只更新那颗 pill，面板抬头与正文几行停在旧值上，
   * 与 `header()` 那句"面板开着时轮询一回来这句话就跟着变"正好相反。
   */
  const settlePanel = (): void => {
    if (!panel || !lastStatus) return
    if (view.kind === 'qr') {
      const relay = lastStatus.relay
      if (relay !== undefined && relay !== 'online') {
        // 中继掉了：二维码那一屏整个换成说明——用户手里那张码已经发不出去，
        // 而它看上去和好码一模一样（2026-10-05 线上取证）。
        stopCountdown()
        view = { kind: 'offline' }
      } else if (pairingNow() > 0) {
        // 手机上刚扫完码：那张码配上之后就没用了，继续占着面板会让人以为"还没成功、再扫一次"。
        stopCountdown()
        view = { kind: 'info' }
      }
      paint()
      return
    }
    /**
     * **面板开着的时候配对被解除了 ⇒ 就地换成二维码页**（2026-10-23 用户报：
     * "手机端退出配对，主机端不会自动刷码" —— 面板停在「未连接」+ 那颗「刷新」按钮）。
     *
     * 为什么原来不会换：这一屏是 `info`（"已配对点开只给状态"），而 `settlePanel()`
     * 只在 `view.kind === 'qr'` 那一支里跟着状态走（中继掉了 / 手机刚配上）。
     * 手机端解配只让 `/status` 的 `pairings` 归零 —— 面板照旧画那屏状态，**没有一行代码
     * 会因为这件事回到二维码页**，用户只能自己点「刷新」。
     *
     * 判据用 `pairingNow() === 0`（配对簿为空）而不是 `paired === 0`：手机只是退到后台时
     * `paired` 也会是 0，那种情况配对还在，不该把二维码怼到用户脸上（上面那条
     * 「手机离线」的用例钉着两句话的区别）。
     *
     * `openPanelView()` 会按同一套优先级落地：中继在线上就 `requestPairing()` 发一次
     * `POST /pairing/new`（幂等 —— 主机那侧已经补好一张，这里拿到的就是它）。
     */
    if (view.kind === 'info' && pairingNow() === 0) {
      openPanelView()
      return
    }
    if (awaitingStatus) {
      // 等首次 `/status` 的那一屏：现在才知道该不该发码（见 `openPanel`）。
      awaitingStatus = false
      openPanelView()
      return
    }
    paint()
  }

  /**
   * 首次 `/status` 就失败（路由没挂上就是 404）时，等状态那一屏必须落地。
   *
   * 停在"正在生成配对码"上会让人一直等一个永远不会来的东西。这里**不发码**：
   * 连状态都读不到时 `pairingNow()` 是不是 0 无从判断，而"已配对的主机不该白吃一张新码"
   * 这条不能被"读不到状态"绕过。
   */
  const settleFailedStatus = (reason: string): void => {
    if (!panel || !awaitingStatus) return
    awaitingStatus = false
    stopCountdown()
    view = { kind: 'failed', detail: `读不到主机状态（${reason}）` }
    paint()
  }

  /**
   * 当前挂着的配对授权（小程序码路线，2026-10-21）。
   * 轮询拿到它就重画一次：6 位数字是**人**要比对的东西，晚一拍等于把人晾在错误的数字前。
   */
  let lastApproval: { sas: string; remainSec: number } | null = null

  /**
   * 画「6 位确认码」那一块。
   *
   * ⚠️ **3.2.5 起主机端没有放行按钮**：确认只留在手机端（用户裁决），主机自动放行。
   * 这一块现在只负责把数字显示出来给人比对 —— 但"必须每一屏都能显示"的理由没变。
   *
   * ## 为什么它必须能被**每一屏**调用（2026-10-21 真机事故）
   *
   * 原来它只画在 `qr` 那一屏（未配对态）。而面板进不进那一屏看的是
   * `pairingNow() > 0`（**密钥簿里还有几条会话**），不是此刻有没有人在等你放行。
   *
   * ⇒ **死锁**：主机密钥簿里只要留着**任何一条**会话（哪怕那台手机早就不在了），
   * 面板就进 `info` 态 ⇒ **那 6 位不渲染** ⇒ 用户无从比对
   * ⇒ 主机永远不回 `pair-grant` ⇒ 手机永远卡在正在连接…
   * ⇒ 而主机那边显示的是已配对，不用再扫码——**看起来一切正常**。
   * （当时的症状是"找不到那个放行按钮"；按钮后来撤了，数字不能跟着撤。）
   *
   * 真机现场（2026-10-21 23:00）：中继日志里 `paired` **每次都成功**、
   * 主机 `pairApproval` 也确实挂上了申请（token 006867 / sas 325175），
   * 可用户点了半天找不到那个按钮 ⇒ 每一轮都只能换一张新码重来。
   *
   * ⇒ **确认码属于有申请这件事，不属于哪一屏。**
   * 哪个分支需要它就调它，这样面板长什么样与人在等不等放行就解耦了。
   */
  const appendApprovalBlock = (target: HTMLElement): void => {
    if (lastApproval === null) return
    const approval = lastApproval
    target.appendChild(text('p', 'drc-sas', approval.sas))
    target.appendChild(text('p', 'drc-note drc-note-block', '手机上也显示这串数字 两处不一致就在手机上选不一致'))
  }

  async function pollStatus(): Promise<void> {
    // `polling` 是 in-flight 守卫：宿主卡住时上一发还没落地，下一拍不许再叠一个（2026-10-06 修）。
    if (disposed || polling) return
    try {
      if (doc.visibilityState === 'hidden') return
    } catch {
      /* 拿不到可见性就照常轮询 */
    }
    polling = true
    try {
      const response = (await fetchWithTimeout(`${STATUS_ROUTE}?t=${Date.now()}`, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })) as { status?: number; json?(): Promise<unknown> } | undefined
      if (!response || response.status !== 200) {
        /**
         * 路由没挂上时是持续的 404：这是一条降级说明，不是故障——**但必须留痕**。
         *
         * 2026-10-06 修：原来这里静默 `return`，一行 warn 都没有，于是"那颗 pill 一动不动"
         * 在现场没有任何线索；`deps.warn` 这个出口在生产里也从没接上过（见 `mountPill`）。
         */
        const reason = `HTTP ${typeof response?.status === 'number' ? response.status : 'no response'}`
        degrade(`status poll failed（${reason}）`)
        settleFailedStatus(reason)
        return
      }
      const body = (await response.json?.()) as StatusAnswer | undefined
      if (!body || typeof body !== 'object') {
        degrade('status poll failed（回答不是对象）')
        settleFailedStatus('回答不是对象')
        return
      }
      lastStatus = body
      /**
       * 小程序码路线的 6 位确认码（2026-10-21）：拿到就更新本地那份，`write()` 会把它画上屏。
       * 只在**内容变了**才动：每两秒轮询一次，若每次都改引用，重画会在没必要的时候发生。
       *
       * ⚠️ **两个来源，谁先有值用谁**（2026-10-21 晚，主机改自动放行之后）：
       *  · `pairApproval` —— **还挂着**的申请（还没放行）。
       *  · `lastPairApproval` —— **最近放行**的那一次（放行是"取走即焚"，但那 6 位数字
       *    还要留给用户对照一会儿：手机上弹窗一串、主机屏幕上一串，两处一致才说明
       *    中间没人换公钥）。
       * 自动放行后前者立刻变 null，只剩后者 —— 所以两个都得读。
       */
      const rawPending = (body as { pairApproval?: { sas?: unknown; remainSec?: unknown } | null }).pairApproval
      const rawLast = (body as { lastPairApproval?: { sas?: unknown; remainSec?: unknown } | null }).lastPairApproval
      const readApproval = (raw: unknown): { sas: string; remainSec: number } | null =>
        raw && typeof raw === 'object' && typeof (raw as { sas?: unknown }).sas === 'string'
          ? {
              sas: (raw as { sas: string }).sas,
              remainSec:
                typeof (raw as { remainSec?: unknown }).remainSec === 'number'
                  ? (raw as { remainSec: number }).remainSec
                  : 0,
            }
          : null
      // 还挂着的优先（它更新的数字是"用户正在等的那一串"）；没有就用最近放行的。
      const nextApproval = readApproval(rawPending) ?? readApproval(rawLast)
      const same =
        (nextApproval?.sas ?? '') === (lastApproval?.sas ?? '') &&
        (nextApproval?.remainSec ?? -1) === (lastApproval?.remainSec ?? -1)
      if (!same) lastApproval = nextApproval
      settlePanel()
      write()
    } catch (error) {
      degrade('status poll failed（pill 会停在默认文案上）', error)
      settleFailedStatus('请求失败')
    } finally {
      polling = false
    }
  }

  button.addEventListener('click', () => {
    if (panel) closePanel()
    else openPanel()
  })

  /**
   * 切回前台那一拍把倒计时对齐一次。
   *
   * **为什么墙钟锚定还不够、非要挂这一个监听**：后台被节流/冻结时那一拍可能几分钟后才来，
   * 用户却是**切回来立刻看屏**的。墙钟锚定保证"下一拍回来时数字是对的"，可那已经是几分钟后；
   * 这一拍把欠账当场补上，用户看到的第一眼就是真相。
   *
   * 只在倒计时活着时才做事：二维码那一屏之外的场合（info / failed / loading）
   * 屏上根本没有"还剩多少"，碰它只会凭空多一次重画。
   */
  const resyncCountdown = (): void => {
    if (disposed || countTimer === undefined) return
    if (!syncCountdown()) {
      expireCountdown()
      return
    }
    paintCountdown()
  }
  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('keydown', onKeyDown)
  doc.addEventListener('visibilitychange', resyncCountdown)
  write()
  void pollStatus()
  statusTimer = setInterval(() => void pollStatus(), POLL_MS)

  return () => {
    if (disposed) return
    disposed = true
    if (statusTimer !== undefined) clearInterval(statusTimer)
    closePanel()
    doc.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('keydown', onKeyDown)
    doc.removeEventListener('visibilitychange', resyncCountdown)
    button.remove()
  }
}

/**
 * 注册进宿主的槽位。返回 false 表示"**到这一刻**这颗 pill 还没挂上"（没 react / 没 slots /
 * 槽位 API 不对），调用方只关心它不外抛。
 *
 * **`slots` 什么时候到位，决定这颗 pill 存不存在**。模块的 `inject` 声明是空的时，
 * `apply()` 跑在 `slots` 服务之前，只软探一次就返回的表现是"屏幕上永远没有这颗按钮"——
 * 2026-10-03 删掉右栏那半之后在真机上就是这么打的（当时 262 项单测全绿，屏幕是空的；
 * 旧的 `inject: ['sidebarRight']` 无意中把激活时机推到了服务齐之后）。
 * 现在按宿主自带模板（`templates/decoration/client.js`：`inject: ['slots']` +
 * `ctx.slots.inject(...)`）把 `slots` 声明进闸门，同时保留两条退路：软探测，以及
 * `ctx.inject(['slots'], …)` 的晚到回调（回调里只 mount 一次）。
 */
export function mountPill(ctx: PillHost, createElement: CreateElement | undefined): boolean {
  if (!createElement) {
    warn('装载器给不出 react：配对那颗 pill 不会出现')
    return false
  }
  let mounted = false
  const mount = (slots: SlotRegistry): void => {
    if (mounted) return
    /**
     * `ref` 回调必须是**稳定身份**（模块里这一份闭包，每次渲染都同一个函数），
     * 否则 React 每次重渲染都会先 `ref(null)` 再 `ref(node)`——那颗 pill 会一闪一闪地重建。
     */
    let cleanup: (() => void) | undefined
    const attach = (node: unknown): void => {
      const element = node as Element | null
      if (element && typeof element.appendChild === 'function' && element.ownerDocument) {
        if (cleanup) return
        ;(element as HTMLElement).style.position = 'relative'
        cleanup = buildPill(element, {
          // 0.2.1 桌面版的页面在 `dsh-app://` 上：相对路径的 fetch 根本不出门（status 0）。
          // 统一经宿主 origin 解析，见 host-url.ts。
          fetchImpl: (input, init) => globalThis.fetch(resolveHostUrl(String(input)), init as RequestInit | undefined),
          // 降级留痕的出口：不接上它，"status 路由没挂上"这类降级在页面上就一声不响
          // （`deps.warn` 在那之前是个死参数，2026-10-06 修）。
          warn: (message) => {
            try {
              console.warn(`[dsh-remote-control pill] ${message}`)
            } catch {
              /* 控制台也可能不可用 */
            }
          },
        })
      } else if (cleanup) {
        cleanup()
        cleanup = undefined
      }
    }
    const component = (): unknown => createElement('span', { ref: attach })
    mounted = true
    try {
      slots.inject(SLOT_NAME, () => {
        try {
          slots.register({ name: SLOT_NAME, id: PILL_ID, order: PILL_ORDER, inject: () => ({}) }, component)
        } catch (error) {
          warn('槽位注册失败（那颗 pill 不出现）', error)
        }
      })
    } catch (error) {
      mounted = false
      warn('槽位注入失败（那颗 pill 不出现）', error)
      return
    }
    try {
      ctx.effect?.(() => () => {
        if (cleanup) {
          cleanup()
          cleanup = undefined
        }
      })
    } catch {
      /* 没有 effect 口就不登记卸载：宿主整页卸载会带走这颗 pill */
    }
  }

  let early: SlotRegistry | undefined
  try {
    // 模块 `inject: ['slots']` 声明之后，`ctx.slots` 直接可读——宿主自带的
    // `templates/decoration/client.js` 就是这个写法。后面两条是给"这一代宿主没把它
    // 当服务给"留的退路。
    early = pickSlots(ctx.slots) ?? pickSlots(ctx.get?.('slots', true))
  } catch {
    /* 这一代宿主没这个服务名，或读它就是抛 */
  }
  if (early) mount(early)

  try {
    ctx.inject?.(['slots'], ((...args: unknown[]) => {
      for (const candidate of [...args, ctx]) {
        const found = pickSlots(candidate)
        if (found) {
          mount(found)
          return
        }
      }
    }) as never)
  } catch (error) {
    warn('ctx.inject 口不可用：slots 再晚到也没人补挂', error)
  }
  if (!mounted) {
    warn('apply 时没探到 slots（已挂注入回调等它晚到）；pill 一直不出现就是这代宿主没这个服务')
  }
  return mounted
}
