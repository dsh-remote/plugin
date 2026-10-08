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
 *    配对入口在这类宿主上不存在（`/drc pair` 与文本码同日删了）：宿主侧那四条路由挂没挂，
 *    `status.json` 的 `pill` 探针查得到；浏览器这一半只能靠 DevTools 里那行 warn。
 * 3. **拿不到 `react` 就什么都不做**。装载器给不出 react 时 `mountPill` 返回 false，
 *    这里只留一行 warn——它不许变成抛错。
 */

import { findCreateElement, mountPill } from './pill.js'

interface ClientContext {
  slots?: unknown
  get?<T>(name: string, optional?: true): T | undefined
  inject?(names: string[], callback: (scoped: unknown) => void): unknown
  effect?(execute: () => (() => unknown) | void): unknown
}

export const name = 'dsh-remote-control'

/**
 * cordis 服务名列表（不是 `dsh.client.inject` 那份**包名**列表，那份只管装载顺序）。
 *
 * 照宿主自带模板写：`templates/decoration/client.js` 就是 `inject: ['slots']` 然后
 * `ctx.slots.inject(...)`。这条声明决定激活时机——空列表时 `apply()` 跑在槽位服务之前，
 * 那颗 pill 整颗不出现（2026-10-03 真机取证，见 `pill.ts` 的 `mountPill`）。
 * `mountPill` 里仍留软探测与注入回调两条退路，所以这一条闸门不是单点。
 */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  try {
    mountPill(ctx, findCreateElement())
  } catch (error) {
    // 到这一步只能是 mountPill 自己没兜住的意外；它不许变成"整页起不来"。
    try {
      console.error('[dsh-remote-control] pill 挂载抛错（已吞掉）：', error)
    } catch {
      /* 控制台也可能不可用 */
    }
  }
}
