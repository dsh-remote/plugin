/**
 * client — 浏览器那一半（会被打成 `dist/bundle/client.cjs`，由 `window.__ModuleLoader__` 装载）。
 *
 * 2026-10-03 这一半原来做两件事：每 2 秒轮宿主那条只读路由、把当前配对码推进右栏
 * （`sidebarRight.openResource`），外加状态栏那颗 pill。右栏自动弹码那套整个删了——
 * 配对入口只剩 pill，而 pill 要图的时候自己发请求（`./pill.ts`）。所以这个文件剩下的
 * 全部职责就是一句话：**把 pill 挂上去，挂不上也不许影响任何东西**。
 *
 * 三条纪律：
 *
 * 1. **apply 不许把异常抛出去**。这一半抛出会让整页 web boot 失败
 *    （`web boot: N entry/entries did not activate`）——真机上验证过：连一个写错的属性名
 *    都能让应用起不来。
 * 2. **`slots` 按宿主模板声明进 `inject`，`mountPill` 里再留软探测与晚到回调两条退路**。
 *    只靠软探测（`inject: []`）的表现是"屏幕上永远没有这颗 pill"：apply 跑在槽位服务之前，
 *    2026-10-03 删掉右栏那半之后在真机上被打中（当时 262 项单测全绿）。写进闸门换来正确的
 *    激活时机；退路留着，是为了在"这一代宿主没把 slots 当服务给"时还能挂上并留下一行 warn。
 *    配对入口在这类宿主上不存在（`/drc pair` 与文本码同日删了）：宿主侧那六条路由挂没挂，
 *    `status.json` 的 `pill` 探针查得到；浏览器这一半只能靠 DevTools 里那行 warn。
 * 3. **拿不到 `react` 就什么都不做**。装载器给不出 react 时 `mountPill` 返回 false，
 *    这里只留一行 warn——它不许变成抛错。
 */

import { findCreateElement, mountPill } from './pill.js'
import { resolveHostUrl } from './host-url.js'
import { mountSettingsSection } from './settings.js'

interface ClientContext {
  slots?: unknown
  get?<T>(name: string, optional?: true): T | undefined
  inject?(names: string[], callback: (scoped: unknown) => void): unknown
  effect?(execute: () => (() => unknown) | void): unknown
}

/** 必须与包的完整名一致：装载器按 loader entry 名（= 包名）来认这一半。 */
export const name = '@dsh-remote/plugin'

/**
 * **服务声明：`slots`**（2026-10-20 复核后恢复）。
 *
 * 时间线把两次判断都记在这里，免得下一个人再走一遍：
 *
 * 1. 0.2.1 的 boot 会对**任何 pending 条目**抛
 *    `web boot: N entry/entries did not activate` ⇒ 我先把这条声明撤掉，想彻底
 *    避免"等服务"。
 * 2. **实测不成立**：撤掉之后 pill 与设置页**都不出现**（用户在 desktop 上验的）。
 *    原因：`inject: []` 时这一半的 `apply()` 跑在槽位服务之前，`ctx.slots` 读不到
 *    （cordis 的 Proxy 对未声明的属性是**抛**），而 `ctx.inject(['slots'], cb)` 这条
 *    晚到回调在 0.2.1 上并没有把 pill 挂上来。
 * 3. 0.2.1 官方客户端插件**照样声明** `inject: ["slots"]` 并用 `ctx.slots.inject(...)`
 *    注册（`dsh-client-ui-conversation` 的 `conversation-queue-dock` 就是
 *    `inject: ["slots", "conversation", ...]`）⇒ `slots` 是这一代的稳定服务名，
 *    声明它是**与官方同款**的写法，而不是赌。
 *
 * ⚠️ 真正会让条目 pending 的是**包图边**（清单里的 `dsh.client.inject` 包名列表：
 * 那条边指向的客户端包若不在 boot 图里，本条目就永远等不到）—— 那一格已删。
 * 服务名这条留着。
 */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  const createElement = findCreateElement()

  // ① 会话里那颗 pill（`conversation.composer.dock`，需要会话才渲染）。
  //
  // 到这一步只能是 mountPill 自己没兜住的意外；它不许变成"整页起不来"。
  let pillMounted = false
  try {
    pillMounted = mountPill(ctx, createElement)
  } catch (error) {
    swallow('pill 挂载抛错（已吞掉）', error)
  }

  /**
   * ② 设置页里的「远程控制」分区（`settings.section`，**不需要会话**）。
   *
   * 这一条是配对的**正门**：pill 挂的槽位只在有会话时渲染（宿主那条条件是
   * `sessionId !== void 0`），所以"打开浏览器、还没有任何会话"的人找不到出码入口
   * （2026-08-09 用户报的就是这个）。设置页是 root 作用域，两端都渲染。
   *
   * ⚠️ 两块**各自 try**：一个挂不上不许把另一个带走。宿主遇到抛出的组件会把那一条
   * 整块清空，而这里连"挂不上"都不该发生（两个 mount 都自带兜底）。
   */
  let settingsMounted = false
  try {
    settingsMounted = mountSettingsSection(ctx, createElement)
  } catch (error) {
    swallow('设置分区挂载抛错（已吞掉）', error)
  }
  // 诊断自报：宿主侧没有别的观测量能回答"客户端半到底跑到哪一步"。
  reportClient({
    createElement: createElement !== undefined,
    pillMounted,
    settingsMounted,
    hasSlotsCtx: (() => {
      try {
        return (ctx as { slots?: unknown }).slots !== undefined
      } catch {
        return false
      }
    })(),
    transport: (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ !== undefined,
  })
}

/** 把这一半的观测结果 POST 回宿主（`/plugins/dsh-remote-control/client-report`）。绝不抛。 */
function reportClient(fields: Record<string, unknown>): void {
  try {
    void fetch(resolveHostUrl('/plugins/dsh-remote-control/client-report'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-drc-pair': '1' },
      // 与其余请求同一条纪律：宿主卡住时它自己收场，不挂住页面。
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(3000) : undefined,
      body: JSON.stringify({
        ...fields,
        href: typeof location !== 'undefined' ? String(location.href).slice(0, 120) : '',
      }),
    }).catch(() => {})
  } catch {
    /* 诊断通道本身不许成为故障源 */
  }
}

/** 降级留痕：任何一条路抛错都只留一行日志，绝不把异常递回宿主。 */
function swallow(what: string, error: unknown): void {
  try {
    console.error(`[dsh-remote-control] ${what}：`, error)
  } catch {
    /* 控制台也可能不可用 */
  }
}
