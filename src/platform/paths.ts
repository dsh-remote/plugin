/**
 * PathsPort — 路径判定与数据目录派生，**一处**。
 *
 * ## 为什么要有它
 *
 * v2 审计在四个文件里各写了一遍"这是不是绝对路径"，而它们**彼此不一致**——
 * 这不是风格问题，是功能缺陷：
 *
 * | 位置 | 当时的写法 | 在 Windows 上会发生什么 |
 * |---|---|---|
 * | `shell/config.ts` ×2 | `configured.startsWith('/')` | `C:\Users\x\state.json` 被当成**相对路径**，于是 `path.join(statusFile 所在目录, 它)` 把它改道到别处 —— 而同一文件反复强调"不静默改道" |
 * | `shell/config.ts` 校验 | `!statusFile.startsWith('/')` 就 warn "必须是绝对路径" | 一条**完全正确**的 `C:\...` 配置被报成错 |
 * | `platform/carrier-services.ts` | `^[A-Za-z]:[\\/]` → 判非法 | 手机传来的 Windows 路径**全部**判非法 ⇒ `newSession` 的工作区推断链全落空，静默退回宿主默认目录 |
 *
 * 也就是说：同一个 `C:\Users\x\project`，在三处得到三个不同答案。
 * 四处各写一遍的分叉源，比任何一处写错都贵。
 *
 * ## 三件事，收成一处
 *
 * 1. **绝对路径判定**（`isAbsolutePath`）—— 按平台语义，而不是"以 `/` 开头"。
 * 2. **数据目录派生**（`dataDir`）—— `~/.dsh/dsh-remote-control` 这类根。
 * 3. **工作区形状判定**（`workspaceProblem`）—— 手机传来的不可信字符串能不能当目录用。
 *
 * ## 判定为什么要带**平台参数**
 *
 * `path.isAbsolute` 依赖**运行时**平台。判据必须能在 macOS 上验出 Windows 的行为，
 * 否则"C:\x 在 win32 上是对的"这件事永远只能靠真机确认。所以下面每一个判定都接一个
 * `platform` 参数（默认当前平台），判据把三平台的期望写成一张表 —— 这也是
 * `tests/paths-port.test.ts` 的形态。
 *
 * ## 为什么**不**抽 `path.win32.isAbsolute`
 *
 * 抽了它，"UNC 与设备路径"这几条就得逐条重写一遍 Windows 的语义，而我们只需要
 * "像不像一个绝对路径"这一个二值判断。**这里要的是形状判定，不是路径解析。**
 */
import path from 'node:path'
import os from 'node:os'

/** 平台标识。与 `process.platform` 同形，但可注入——判据要在 macOS 上验 win32 的行为。 */
export type Platform = 'darwin' | 'linux' | 'win32'

/** 取当前平台。抽成函数是为了让判据能覆盖"平台判断本身"。 */
export function currentPlatform(): Platform {
  return process.platform as Platform
}

const WIN_DRIVE = /^[A-Za-z]:[\\/]/
const WIN_UNC = /^\\\\[^\\/]+[\\/]/
/** Windows 上 `path.win32.isAbsolute` 认的形态：盘符、UNC、设备路径，以及根相对 `\foo`。 */
const WIN_EXTENDED = /^\\\\\?\\|^\\\\\.\\/

/**
 * 这是不是一个**该平台的**绝对路径。
 *
 * - `darwin` / `linux`：只有 `/` 开头。`C:\x` **不是**绝对路径（那里没有 C 盘），
 *   `\\host\share` 也不是。
 * - `win32`：`C:\x`、`\\host\share`、`\x`（根相对）、`\\?\C:\x` 都是；
 *   而 `/x` 在 win32 上**也算**绝对路径（`path.win32.isAbsolute('/x')` 为 true，
 *   它是"当前盘符的根"）。
 *
 * ⚠️ `\\host\share` 那一支在 POSIX 上不成立，但**它自己知道**：见 `isForeignAbsolutePath`
 * —— 我们要能说出"这串东西在别的平台上才是绝对路径"，而不是一律当相对路径改道。
 */
export function isAbsolutePath(raw: string, platform: Platform = currentPlatform()): boolean {
  if (raw.length === 0) return false
  if (platform === 'win32') {
    return (
      WIN_DRIVE.test(raw) || WIN_UNC.test(raw) || WIN_EXTENDED.test(raw) || raw.startsWith('/') || raw.startsWith('\\')
    )
  }
  return raw.startsWith('/')
}

/**
 * 这串东西**在别的平台上**是不是绝对路径。
 *
 * 为什么单独问：在 POSIX 主机上收到 `C:\Users\x\project`，它不是绝对路径，
 * 但也**不是**一个能安全 `join` 的相对路径 —— `path.join('/a', 'C:\\x')` 会得到
 * `/a/C:\x`，一个两边都不认的怪东西。v2 就是在 `carrier-services` 里单点硬拒了它，
 * 而 `config.ts` 没拒，于是同一串东西两处不同命。
 *
 * 用在两个地方：配置校验（**报错**而不是静默改道）与工作区形状判定（**拒绝**）。
 */
export function isForeignAbsolutePath(raw: string, platform: Platform = currentPlatform()): boolean {
  if (platform !== 'win32') {
    // POSIX 主机：只有 Windows 形态的外来绝对路径
    return WIN_DRIVE.test(raw) || WIN_UNC.test(raw)
  }
  // Windows 主机：只有 POSIX 形态的外来绝对路径
  return raw.startsWith('/')
}

/**
 * 路径的**最后一段**（日志里只留它）。
 *
 * v2 在 `carrier-services.ts` 里写的是 `raw.split('/')`，于是 Windows 路径
 * `C:\a\b\project` 会返回**整串**——它不是排错信息，它是把整条工作区路径
 * 原样塞进日志（信息泄露 + 噪音）。这里按平台切分符取，并额外收掉两种常见尾巴：
 * 结尾的分隔符、以及盘符本身（`C:\` 的 basename 是空串）。
 */
export function tailOfPath(raw: string, platform: Platform = currentPlatform()): string {
  if (raw.length === 0) return '/'
  const sep = platform === 'win32' ? /[\\/]/ : /\//
  const parts = raw.split(sep).filter((part) => part.length > 0)
  return parts[parts.length - 1] || '/'
}

/**
 * ⚠️ **按 `platform` 参数取路径语义，而不是用运行时的 `path`**（2026-10-10 修）。
 *
 * ## 这是一个真的跨平台缺陷，不是"测试写法问题"
 *
 * 本文件里每个函数都收一个 `platform` 参数，理由写在文件头上：
 * 「`path.isAbsolute` 依赖**运行时**平台。判据必须能在 macOS 上验出 Windows 的行为」。
 * 但**判定**用了参数、**拼接**却用了运行时的 `path` —— 于是同一个函数里两套语义：
 *
 *   · 在 Windows 上跑 `dataDir('darwin', { home: '/Users/x' })`
 *     ⇒ 判定按 darwin（对），拼接按 win32（错）⇒ 返回 `\Users\x\.dsh\dsh-remote-control`，
 *       一个 darwin 上根本不存在的路径。
 *   · 在 macOS 上跑 `dataDir('win32', …)` 同理，只是方向相反。
 *
 * 真机上 `platform` 恒等于运行时平台（默认参数），所以**装机不受影响** ——
 * 这正是它一直没被发现的原因：只有"显式传另一个平台"的判据会踩到，
 * 而那恰恰是本文件头声明要支持的能力。
 * 它是在四个开源仓的 CI **第一次真的在 windows-latest 上跑起来**时暴露的
 * （2026-10-10）：`dataDir` / `resolveAgainstBase` 两条判据在 Windows 上红。
 */
const pathFor = (platform: Platform): typeof path.posix => (platform === 'win32' ? path.win32 : path.posix)

/**
 * 数据目录：`~/.dsh/dsh-remote-control`。
 *
 * ⚠️ **这个目录名是稳定的运行时标识**，不是随手起的：宿主插件的
 * 这个前缀下的七条路由、`status.json` 的排错入口、密钥簿
 * `conversations-<hostId>.json` 都指向它。改它会让在用的装机找不到自己的状态文件
 * （见 HANDOFF §4「稳定标识」）。
 *
 * `override` 是给判据与测试用的——它**不接受**用户配置（用户能配的是
 * `statusFile` / `pairStoreFile`，见 `shell/config.ts`）。
 */
export function dataDir(platform: Platform = currentPlatform(), override?: { home?: string }): string {
  const home = override?.home ?? os.homedir()
  return pathFor(platform).join(home, '.dsh', 'dsh-remote-control')
}

/**
 * 一个不可信字符串（手机传来的 `workspace`）能不能当工作区用。返回 '' = 可以。
 *
 * ## 为什么只做**形状**判定，不 stat
 *
 * 这个进程可能被限制成看不到用户的目录树（`ProtectHome`、容器）。一次
 * `existsSync` 得到的"不存在"是**假否定**，而假否定会让新建会话直接失败——
 * 比把它交给内核、让内核按自己的规则处理要坏得多。
 *
 * ## 三条与平台无关的红线（顺序有意义）
 *
 * 1. 过长 / 含 NUL：先于一切形状判断，否则后面每条规则都要重复处理它们。
 * 2. 不是本平台绝对路径 ⇒ `not an absolute path`。
 * 3. 是**外来**平台的绝对路径 ⇒ 单列一条 `looks like a <platform> path`，
 *    因为它与上一条是**不同的病**：用户看到的提示不同，改法也不同
 *    （本平台相对路径 → 写配置；外来路径 → 手机/宿主的平台不一致）。
 */
export function workspaceProblem(raw: string, platform: Platform = currentPlatform()): string {
  if (raw.length > 1024) return 'too long'
  if (raw.includes('\0')) return 'contains NUL'
  if (isForeignAbsolutePath(raw, platform)) {
    return `looks like a ${platform === 'win32' ? 'POSIX' : 'Windows'} path`
  }
  if (!isAbsolutePath(raw, platform)) return 'not an absolute path'
  return ''
}

/**
 * 相对路径按 `base` 所在目录解析；绝对路径原样返回。
 *
 * 这是 v2 在 `config.ts` 里重复了两次的那段逻辑（`resolvePairStoreFile` 与
 * `resolveUploadDir` 各写一遍）。收进来是因为它**必须**和 `isAbsolutePath`
 * 用同一套平台语义——分开写就是下一个分叉源。
 *
 * `base` 为空（`statusFile` 未配）时原样返回：那是"用户明确要求但我们无法解析"，
 * 不该被静默改道（与 v2 同一条纪律）。
 */
export function resolveAgainstBase(configured: string, base: string, platform: Platform = currentPlatform()): string {
  // ⚠️ 外来平台的绝对路径**原样返回**，不许 join。
  // v2 的 `startsWith('/')` 会放它过去，于是 `path.join('/base', 'C:\\x')` = `/base/C:\x`
  // ——一个两边都不认的怪东西，用户以为配好了，实际落在别处。调用方（配置校验）
  // 拿到原串之后会报「这是外来平台的绝对路径」，那才是它该得到的答案。
  if (isForeignAbsolutePath(configured, platform)) return configured
  if (isAbsolutePath(configured, platform)) return configured
  if (!base) return configured
  // ⚠️ 同上：拼接必须用 `platform` 的语义。用运行时 `path` 的话，
  //    在 Windows 上问 darwin 的答案会拿到反斜杠。
  const p = pathFor(platform)
  return p.join(p.dirname(base), configured)
}
