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

/** pill 用到的四条路由（宿主侧定义在 `src/pill/routes.ts`，字符串必须一致）。 */
export const STATUS_ROUTE = '/plugins/dsh-remote-control/status'
export const NEW_ROUTE = '/plugins/dsh-remote-control/pairing/new'
export const IMAGE_ROUTE = '/plugins/dsh-remote-control/pairing.png'
export const UNPAIR_ROUTE = '/plugins/dsh-remote-control/unpair'

/** 槽位与条目 id：抄 `conversation.composer.dock` 那个已验证的用法。 */
export const SLOT_NAME = 'conversation.composer.dock'
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
  if (relay === 'idle') return { text: '远程未启动', tone: 'off' }
  // 断链是**故障**不是"还没配"，所以它单独一档、单独一个红：灰色会被读成"还没轮到配"。
  if (relay === 'offline') return { text: '已断开连接', tone: 'error' }
  if (relay === 'connecting') return { text: '连接中', tone: 'wait' }
  if (relay !== 'online') return { text: '远程控制', tone: 'off' }
  const paired = typeof status?.paired === 'number' ? status.paired : 0
  // 2026-10-05 用户定的口径：抬头只说"连没连上"，不说"配没配"——"已配对"对
  // 第一次用的人不解释任何事，"已连接"才直接回答"现在能用了没有"。
  if (paired > 0) {
    // 有东西挂在手机上等回答时，`已配对` 这句话等于没说——那条回合正停在这台机器上，
    // 而这颗 pill 是它在桌面上唯一可能被看见的地方（判据见伞仓 docs/PRODUCT.md §3）。
    // 只在**确实配着**的时候抢这一格：手机中途掉线、挂起还没超时时，
    // 用户能做的第一件事是重新配对，那才是该说的那句。
    const waiting = waitingCount(status)
    if (waiting > 0) return { text: `等 ${waiting} 件事`, tone: 'wait' }
    return { text: '已连接', tone: 'on' }
  }
  // 一台都没连着、但密钥簿里还有会话 = **配过对，手机只是不在线**（小程序退后台、手机关屏）。
  // 配对按 D3 长存且 pair-store 落盘，手机回前台自动重连——这不是「没配上」：
  // 那一态说「未配对」是让用户去扫一个不需要扫的码（2026-10-04 用户报的误解）。
  // 灯走黄（wait）：不是故障，也不是「可以用了」，是「等它自己回来」。
  if (pairingCount(status) > 0) return { text: '手机离线', tone: 'wait' }
  // 2026-10-05 用户定的口径："远程未连接"而不是"未配对"。"配对"是内部动作，
  // 第一次装好插件的人不知道自己要"配对"；"远程未连接"直接说清了现在
  // "这台机器还没接上手机"——也顺手回答了那颗 pill 点开能看到什么。
  return { text: '远程未连接', tone: 'off' }
}

/** 挂在手机上等回答的件数。老版路由没给这个字段时算 0（那一行自己不占地方）。 */
export function waitingCount(status: StatusAnswer | undefined): number {
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

export function humanDuration(sec: unknown): string {
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
export function relayAddress(url: unknown): string {
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
  if (relay === 'online') return '已就绪'
  if (relay === 'connecting') return '连接中'
  if (relay === 'offline') return '已断开'
  if (relay === 'idle') return '未启动'
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

const CSS = `
.drc-pill { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 2px 8px;
  border: 0; border-radius: 999px; background: transparent; color: inherit; font: inherit;
  font-size: 12px; line-height: 18px; cursor: pointer;
  /* 宿主那一排挤不下时会自己截断（「6 轮 …」那种），我们也跟这个形状走：
     一行写完，写不下就省略号。**没有这两条**的话，flex 项会被压到「中文最小内容宽度
     = 一个字」，于是「已连 1 台」竖着排成四行（2026-10-03 真屏幕截图）。 */
  flex: 0 1 auto; white-space: nowrap; }
.drc-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.drc-pill:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04)); }
.drc-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--dsw-alias-label-dimmed, #9aa0a6); }
.drc-dot[data-tone="wait"] { background: var(--dsw-alias-state-warn-primary, #faad14); }
.drc-dot[data-tone="on"] { background: var(--dsw-alias-state-success-primary, #52c41a); }
.drc-dot[data-tone="error"] { background: var(--dsw-alias-state-error-primary, #ff4d4f); }
.drc-panel { position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 30; width: 240px;
  padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1)); border-radius: 12px;
  background: var(--dsw-specific-tip, var(--dsw-alias-bg-layer-1, #ffffff));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
  color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; }
/* 抬头一行：左侧状态，右侧动作。两颗按钮都收在这个右上角（2026-10-03 重设计的要求）。 */
.drc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.drc-head-label { font-weight: 600; }
.drc-head-label[data-tone="off"] { color: var(--dsw-alias-label-secondary, #6b7280); }
.drc-head-label[data-tone="wait"] { color: var(--dsw-alias-state-warn-primary, #faad14); }
.drc-head-label[data-tone="on"] { color: var(--dsw-alias-state-success-primary, #52c41a); }
.drc-head-label[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #ff4d4f); }
.drc-actions { display: flex; gap: 6px; flex: 0 0 auto; }
.drc-btn { padding: 2px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer;
  white-space: nowrap; }
.drc-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04)); }
/* 正文那三行（中继 / 状态 / 版本）：键左值右（space-between），值被截断时省略号——
   和那颗 pill 同一套"挤不下就截文字不撑容器"。第一行带那条分隔线，后两行只留行距。 */
.drc-info { display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  white-space: nowrap; margin-top: 8px; padding-top: 6px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08)); }
.drc-info + .drc-info { margin-top: 2px; padding-top: 0; border-top: 0; }
.drc-key { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); }
.drc-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.drc-qr { display: block; width: 200px; height: 200px; margin: 8px auto 0; image-rendering: pixelated; }
.drc-count { margin: 8px 0 0; text-align: center; color: var(--dsw-alias-label-secondary, #5f6368);
    font-size: 12px; font-variant-numeric: tabular-nums; }
  .drc-count[data-kind="urgent"] { color: var(--dsw-alias-state-warn-primary, #faad14); font-weight: 600; }
  .drc-code { margin: 8px 0 0; text-align: center; font-weight: 600; font-size: 14px; letter-spacing: 2px; }
  /* 引导行：比 note 重一档（第一次用的人要看清），但不加图标不加底色——
     这一屏的主角是二维码，多一个色块就成了推销而不是引导。 */
  .drc-guide { margin: 8px 0 0; text-align: center; color: var(--dsw-alias-label-secondary, #5f6368); font-size: 12px; }
  .drc-note { margin: 4px 0 0; text-align: center; color: var(--dsw-alias-label-tertiary); }
.drc-note[data-kind="failed"] { color: var(--dsw-alias-state-error-primary, #ff4d4f); }
  /* 离线那一屏的第一行说明要跟上面那行拉开一点。**必须写在 .drc-note 之后**：
     两者特异度相同（都只一个类），后来的赢——写在前面的 margin-top 会被
     .drc-note 的 margin: 4px 0 0 整条覆盖成死规则（2026-10-06 修）。 */
  .drc-note-block { margin-top: 10px; }
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

function ensureStyle(doc: Document): void {
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
export function buildPill(root: Element, deps: PillDeps): () => void {
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
  /** 二维码那张 `<img>` 与它的 src：同一个 src 复用同一个元素（见 `qrImage`）。 */
  let imageNode: HTMLImageElement | undefined
  let imageSrc = ''
  let disposed = false

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
   * 倒计时走完的收场：停表 + 整块重画（note 要改口"已过期"）。
   *
   * 单独抽出来是因为**两条路**都要走到它：节拍自己走到 0，以及切回前台时
   * `resyncCountdown` 发现那张码在后台期间就已经过期（那一路才是现场那次的真实时序：
   * 面板开着切走，回来时表早就停了，`expiresInMs` 却还停在切走前那一拍）。
   */
  const expireCountdown = (): void => {
    if (countTimer !== undefined) {
      clearInterval(countTimer)
      countTimer = undefined
    }
    expiresAt = 0
    expiresInMs = 0
    // 走完最后 1 秒才整块重画这一屏（note 要改口"已过期"）。这一拍 `<img>` 仍按
    // src 复用，所以不会多向 `/pairing.png` 要一张——每秒重画的问题见 `paintCountdown`。
    paint()
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
   * 二维码那张图。**同一个 src 复用同一个元素**：`/pairing.png` 是 `no-store`，
   * 每新建一个 `<img>` 都必然重新请求、服务端重新编码一整张 PNG。
   * 换码时 src 里那个 `?e=<epoch>` 会变，那时才建新元素——那时本来就该取新图。
   */
  const qrImage = (src: string): HTMLElement => {
    if (imageNode && imageSrc === src) return imageNode
    const image = doc.createElement('img')
    image.className = 'drc-qr'
    image.setAttribute('alt', '配对二维码')
    image.src = src
    imageNode = image
    imageSrc = src
    return image
  }

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
    if (pillLabel(lastStatus).text !== '手机离线') return null
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
      panel.appendChild(qrImage(view.imageSrc))
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
          fetchImpl: (input, init) => globalThis.fetch(input, init as RequestInit | undefined),
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
