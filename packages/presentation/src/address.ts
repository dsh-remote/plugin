/**
 * address — 把磁盘上的二维码 PNG 编成 DSH 右栏认得的地址。
 *
 * 为什么必须是 `session` scope：真机上唯一认领 `dsh-resource://file/**` 的页型是
 * 文档预览（`dsh-client-ui-sidebar-documentpreview`），它的 `canOpen` 只看一件事——
 * `parseFileAddress(address)?.scope === "session"`；`absolute` 形状会被当场拒绝
 * （`sidebarRight: tab type "text" refuses "..."`）。会话 scope 里**允许直接放绝对路径**：
 * 这是宿主 `fileAddressFor()` 的既定语义（工作区外的绝对路径"keeps its absolute path
 * in that Session's address"）。
 * 真机取证：把一张绝对路径下的 PNG 按会话 scope 编址，右栏直接把图渲染出来了。
 *
 * 编出来的地址现在指向**该会话工作区**下的 `<workspace>/.dsh/sidebar-qr.png`
 * （2026-10-02 改；此前是 home 下的 `~/.dsh/sidebar-qr.png`）。会话作用域仍然必须：
 * 右栏是"某个会话的右栏"，同一个文件在不同的会话里得能各自打开。
 *
 * 编码规则与 `@deepseek-ai/dsh-util-workspace-path` 的 `encodeSegment` 同口径
 * （逐段 `encodeURIComponent`，只把 `:` 留成字面量，好让 Windows 盘符不在路径里变成 `%3A`）。
 * 这份实现是照协议写的，不 import 宿主包：插件装在外部 profile 里，指望宿主内部
 * 模块的路径可见是不稳的，而这段规则只有十几行、有单测钉住形状。
 */

const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/** 单段编码：逐段转义，但保留 `:`（盘符）。 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/**
 * 会话作用域的文件地址。
 *
 * `filePath` 可以是工作区相对路径，也可以是绝对路径；两者都合法，绝对路径的**前导斜杠
 * 会原样保留**（于是地址里出现 `session/<id>//Users/...` 这样的双斜杠）——这不是笔误，
 * 是 `parseFileAddress` 把空首段还原成绝对路径所依赖的形状，改掉它会让宿主把文件
 * 解析成"工作区下的相对路径"。
 */
export function sessionFileAddress(sessionId: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const encoded = normalized.split('/').map(encodeSegment).join('/')
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encoded}`
}

/**
 * `sessionId` 是否是我们愿意编进地址里的形状。
 *
 * 路由的 `?session=` 是浏览器传上来的**外部输入**，虽然它最终只会被编成一个本地 UI
 * 地址（拿不到任何权限），但把任意字节编进地址没有意义也难排查，所以在边界上收窄：
 * 只放行 DSH 会话 id 实际用到的字符集。
 */
export function isUsableSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value)
}
