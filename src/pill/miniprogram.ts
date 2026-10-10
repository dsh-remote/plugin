/**
 * miniprogram — 官方小程序那张**静态**小程序码，以及它在磁盘上的位置。
 *
 * ## 为什么它是一张图，而不是现生成的二维码
 *
 * 微信的**小程序码**只在微信后台（或它的 `wxacode` 接口）生成，需要 appid + secret；
 * 它指向的是"哪个小程序"，不是"连哪台主机"。所以它**必须**是一张随包发布的静态图，
 * 谁也算不出来。源图在 `packages/plugin/docs/images/miniprogram-qr.jpg`
 * （430×430 JPEG，与 `README.md` 里那张是同一份文件——README 与设置页显示同一张码，
 * 换码时只该换一处）。
 *
 * ⚠️ **它与配对二维码是两件东西**，别合并：
 *
 * | | 谁生成 | 有效期 | 是凭据吗 |
 * |---|---|---|---|
 * | `pairing.png` | 宿主每次配对现渲染（带 PSK） | 几分钟 | **是**（渲成像素才离开宿主） |
 * | 这一张 | 微信后台，人手换图 | 长期 | 否（谁拿到都只能打开小程序） |
 *
 * ⇒ 两件事的缓存姿态因此相反：配对码 `no-store`，这一张可以缓存一天。
 *
 * ## 路径为什么不再"算相对深度"
 *
 * `docs/images/…` 相对**包根**，而本模块的产物位置有两种、深度不一样（表见
 * `miniprogramImagePath`）。第一版按"上两级"硬算，于是装机那条对、e2e 那条错——
 * 现在改成从模块目录往上找到含那张图的目录为止。
 *
 * ⚠️ **不用 `new URL('./x', import.meta.url)` 那种写法**：esbuild 会把它当成"静态资源引用"
 * 去改写、把图另拷一份进 `dist/bundle/`，于是同一张图在包里有两个位置，而哪个是权威
 * 没有任何东西说得清。这里就是普通的 `path.join`/`existsSync`，打包器不会碰它。
 *
 * `package.json` 的 `files` 里必须带上这张图，否则 npm 包里没有它——装机那边
 * 表现是"设置页右栏那张卡自己消失了"（路由回 204，前端把卡摘掉）。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 源图文件名。README 里引的是**同一份**文件。 */
export const MINIPROGRAM_IMAGE_NAME = 'miniprogram-qr.jpg'

/** 发出去的 Content-Type。源图是 JPEG，别跟着路由后缀写死成 image/png。 */
export const MINIPROGRAM_IMAGE_TYPE = 'image/jpeg'

/**
 * 那张图的绝对路径：**从模块所在目录往上找**，第一个含 `docs/images/<名字>` 的目录为准。
 *
 * ## 为什么不写死"往上两级"
 *
 * 本模块有两种产物布局，深度**不一样**：
 *
 * | 布局 | 谁产出 | 本模块的位置 | 到包根 |
 * |---|---|---|---|
 * | `dist/src/pill/miniprogram.js` | `tsc -p tsconfig.json`（e2e 与单测走这条） | 三级 | `../../..` |
 * | `dist/bundle/index.js` | esbuild 内联（装机走这条） | 两级 | `../..` |
 *
 * 2026-10-09 第一版写死了两级，于是**装机那条对、e2e 那条错**：`e2e/run.mjs` 打那条路由
 * 拿到 204（读不到图），而单测全绿——因为单测给的是显式的 `here`，从没验过默认路径。
 * 这种坏法的表现只是"设置页少一张卡"，没有任何东西会报错。
 *
 * 往上找最多 4 层（覆盖上面两种布局，也容得下将来多一层打包目录）；
 * `here` 可注入，判据才能在不真装一个包的前提下验它。
 */
export function miniprogramImagePath(here: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = here
  for (let up = 0; up < 4; up += 1) {
    const candidate = path.join(dir, 'docs', 'images', MINIPROGRAM_IMAGE_NAME)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // 一个都没找到时返回"按两级算"的那个路径：调用方拿到 undefined 会回 204，
  // 而排错时至少看得出它找的是哪儿（`status.json` 的 `pill.miniprogramCode` 报 missing）。
  return path.join(here, '..', '..', 'docs', 'images', MINIPROGRAM_IMAGE_NAME)
}

/** 读到的字节缓存一份：它在进程生命周期里不会变，而这张图有 97 KB。 */
let cached: Buffer | undefined

/**
 * 读出那张图；读不到返回 `undefined`（**不抛**）。
 *
 * 读不到是"这张图没随包发出去"，不是故障：路由回 204，前端把右栏那张卡摘掉，
 * 配对这条路一个字都不受影响。**失败不缓存**——包被补齐之后不需要重启宿主。
 *
 * ⚠️ 缓存只对**默认路径**（也就是真实装机那条路）生效。`here` 一旦由调用方给出，
 * 读到的就是"别处的某个文件"，缓存它会让下一个用默认路径的调用拿到别人的字节。
 */
export function readMiniprogramImage(here?: string): Buffer | undefined {
  if (here === undefined && cached && cached.length > 0) return cached
  try {
    const bytes = readFileSync(miniprogramImagePath(here))
    if (bytes.length === 0) return undefined
    if (here === undefined) cached = bytes
    return bytes
  } catch {
    return undefined
  }
}

/**
 * 看图在不在（排错与判据用，不返回内容）。
 *
 * 与 `readMiniprogramImage` 分开，是因为"这张图没发出去"与"这张图是空的"是两件事，
 * 而它们的表现都是"设置页少一张卡"——不分开就查不出来是哪种。它走自己的 `here`，
 * 所以判据可以指着一个临时目录验这两种情形。
 */
export function miniprogramImageExists(here?: string): boolean {
  try {
    return readFileSync(miniprogramImagePath(here)).length > 0
  } catch {
    return false
  }
}
