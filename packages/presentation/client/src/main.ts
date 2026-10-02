/**
 * client — 浏览器那一半（会被打成 `dist/bundle/client.cjs`，由 `window.__ModuleLoader__` 装载）。
 *
 * 它只做一件事：**每 2 秒问一次宿主那条只读路由"现在有没有可看的配对码"，有就把它推进右栏**。
 * 宿主那一半没有"推右栏"的能力（扩展点不存在），浏览器这一半有 `ctx.sidebarRight`
 * 却不知道什么时候该推（配对码是宿主发的）——两边各有一半，靠这条同域路由接上。
 *
 * 为什么不是"打开一个图片文件"：地址是**会话作用域**的 `dsh-resource://file/session/...`，
 * 由右栏的文档预览页型（唯一认领 `dsh-resource://file/**` 的页型）就地渲染。
 * 不换工作区、不写用户项目目录、不需要用户点任何东西。
 *
 * 三条纪律：
 *
 * 1. **apply 与轮询回调都不许把异常抛出去**。这一半的 apply 抛出会让整页 web boot 失败
 *    （`web boot: N entry/entries did not activate`）——真机上验证过：连一个写错的属性名
 *    都能让应用起不来。所以每一段都包 try。
 * 2. **`inject` 必须声明 `sidebarRight`**。宿主 ctx 是 Proxy，读一个没声明的服务是**抛错**
 *    而不是返回 undefined，`?.` 挡不住（真机取证：`cannot get property "sidebarRight" without inject`）。
 * 3. **只在成功打开之后才记 epoch**。打开失败（没有会话面板、页型拒绝）时不留痕，
 *    下一次轮询还会再试——否则会出现"记下了但屏幕上什么都没有、且再也不重试"的死局。
 */

/** 右栏服务最小面：`require()` 拿到"当前挂着的会话"，`openResource()` 把地址推进那一列。 */
interface SidebarRightLike {
  require(): { sessionId?: unknown }
  openResource(address: string): unknown
}

interface ClientContext {
  sidebarRight: SidebarRightLike
  effect?(execute: () => (() => unknown) | void): unknown
}

/** 宿主那一半注册的只读路由（见 src/route.ts 的 PAIRING_ROUTE）。 */
const ROUTE = '/plugins/dsh-remote-control-presentation/pairing'
const POLL_MS = 2000

let timer: ReturnType<typeof setInterval> | undefined
let stopped = true
let inFlight = false
/** 已经推进右栏的那一版码；同一个 epoch 不重复推开。 */
let lastEpoch: string | null = null
/** 上一次看到的会话 id；换了会话就把 epoch 忘掉（新会话的右栏是空的）。 */
let lastSessionId: string | null = null
const reported = new Set<string>()

/** 只把每种故障报一次：轮询是 2 秒一次，不去重会把日志刷成一片。 */
function report(message: string, error?: unknown): void {
  if (reported.has(message)) return
  reported.add(message)
  try {
    const detail = error instanceof Error ? (error.stack ?? error.message) : error === undefined ? '' : String(error)
    console.error(`[dsh-remote-control-presentation] ${message} ${detail}`)
  } catch {
    /* 控制台也可能不可用 */
  }
}

function safeSessionId(held: unknown): string | null {
  const id = held && typeof held === 'object' ? (held as { sessionId?: unknown }).sessionId : undefined
  return typeof id === 'string' && id !== '' ? id : null
}

async function poll(ctx: ClientContext): Promise<void> {
  if (stopped || inFlight) return
  // 页面不可见时停手：Electron 里"窗口在后台"是常态，没必要空转。
  try {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  } catch {
    /* 拿不到可见性就照常轮询 */
  }
  let sessionId: string
  try {
    const held = ctx.sidebarRight.require()
    const id = safeSessionId(held)
    // 会话面板还没挂上（例如启动中）——这不是故障，下一轮再说。
    if (id === null) return
    sessionId = id
  } catch {
    return
  }
  if (sessionId !== lastSessionId) {
    lastSessionId = sessionId
    lastEpoch = null
  }
  inFlight = true
  try {
    const response = await fetch(`${ROUTE}?session=${encodeURIComponent(sessionId)}`, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!response.ok) {
      if (response.status === 403) report('route refused the request (403): 环回守卫判定非同源')
      else if (response.status !== 404) report(`route answered ${response.status}`)
      return
    }
    const body = (await response.json()) as { state?: unknown; epoch?: unknown; address?: unknown; expiresAt?: unknown }
    if (body.state !== 'ready') return
    const epoch = typeof body.epoch === 'string' ? body.epoch : ''
    const address = typeof body.address === 'string' ? body.address : ''
    const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : 0
    if (epoch === '' || address === '' || epoch === lastEpoch) return
    // 过期判断放在本地再做一次：网络上跑了一趟，宿主那边也可能刚好翻页。
    if (expiresAt <= Date.now()) return
    try {
      ctx.sidebarRight.openResource(address)
      lastEpoch = epoch
    } catch (error) {
      report('openResource failed', error)
    }
  } catch (error) {
    report('poll failed', error)
  } finally {
    inFlight = false
  }
}

function stop(): void {
  stopped = true
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
  try {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
  } catch {
    /* 同上 */
  }
}

let current: ClientContext | undefined

function onVisibility(): void {
  if (current && !stopped) void poll(current)
}

export const name = 'dsh-remote-control-presentation'

/** cordis **服务**名列表（不是 dsh.client.inject 那份包名列表）。 */
export const inject = ['sidebarRight']

export function apply(ctx: ClientContext): void {
  try {
    current = ctx
    stopped = false
    reported.clear()
    try {
      // 回到前台立刻看一眼：用户切回来时最不希望等一个 2 秒节拍。
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    } catch {
      /* 没有 document 就当是 headless 装载 */
    }
    timer = setInterval(() => void poll(ctx), POLL_MS)
    void poll(ctx)
    try {
      ctx.effect?.(() => stop)
    } catch (error) {
      // 没有 effect 口就只留下节拍；记一条，免得排查时以为它被正确回收了。
      report('ctx.effect unavailable; poll timer will outlive this fiber', error)
    }
  } catch (error) {
    // 这一半的任何失败都不许影响整页启动。
    report('apply failed', error)
    stop()
  }
}
