/**
 * bundle-plugin — 把 host 插件打成**自包含单文件**，供 DSH profile 安装。
 *
 * 为什么要有这一步（它替掉了旧实现的两处自研）：
 * - 旧 `scripts/bundle-protocol.mjs`：手工把协议产物拷进 dist 并**改写 import specifier**，
 *   存在理由只是 `pnpm add file:` 解析不了 `workspace:*`。打包器天然就解决这件事。
 * - 旧 `qr.ts` 里手写的 CRC32 + grayscale PNG 编码器：注释写的原因是"插件装进外部
 *   profile 必须零依赖"。依赖被内联之后这个理由不成立，编码器与 PNG 都改用 node-qrcode。
 *
 * 保留 externals 的只有宿主自己提供的东西：`cordis` 与 `@deepseek-ai/*`。
 * 它们由宿主在运行时注入，打进 bundle 会造成两份实例（服务注册、事件派发都会错乱）。
 *
 * 产物：
 *   dist/bundle/index.js   —— 宿主侧（ESM，`main` 指向它）。配合生成的 package.json，
 *                            profile 里不需要 node_modules。同一份也供 e2e 直接 import。
 *   dist/bundle/client.cjs —— 浏览器面（右栏自动弹码那一半的轮询端）。**必须裹在
 *                            `window.__ModuleLoader__.load({id, factory})` 里**，`id` 必须是
 *                            包的完整名（`@deepseek-ai/dsh-client-modules` 按 loader entry 名
 *                            去 `graphRows` 里查，名字对不上就注册不上）。这个外壳生成不了，
 *                            只能由本脚本的 banner/footer 拼，拼完**逐字节校验**（见下方断言）：
 *                            外壳写错的表现是"整页 web boot 失败"，而那要重启应用才看得见。
 *
 * 2026-10-03：浏览器面原来由**第二个 cordis 条目**单独打一份 bundle（那个条目已删除）。
 * 折进主插件之后两半由同一个脚本产出——**因为它们必须同源**：宿主侧路由常量
 * （当时宿主侧那条只读路由与浏览器侧的轮询地址是同一条链的两端，现在那条链整个删了，
 * 剩下的只有 pill 的四条路由 `src/pill/routes.ts` 与 `client/src/pill.ts` 这一对，）
 * 分在两个包里各打一次时，两边改一漏一的表现是"右栏永远不弹而日志全绿"（404 在这条路上被容忍）。
 *
 * 类型检查不在这里做：`pnpm typecheck` / `tsc -p tsconfig.json` 负责，
 * esbuild 只打包不校验，"build 绿"不等于"类型对"。
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const PLUGIN = path.join(ROOT, 'packages', 'plugin')
const OUT_DIR = path.join(PLUGIN, 'dist', 'bundle')
const OUT_FILE = path.join(OUT_DIR, 'index.js')
const CLIENT_OUT = path.join(OUT_DIR, 'client.cjs')
/** 装进 profile 后这个 bundle 的 id，也是 loader 认的那个名字。 */
const BUNDLE_ID = 'dsh-remote-control'
/** pill 弹窗里那行「版本」读的就是它（`src/version.ts` 里的 `__DRC_VERSION__`）。 */
const PLUGIN_VERSION = JSON.parse(readFileSync(path.join(PLUGIN, 'package.json'), 'utf8')).version

// esbuild 是插件包自己的 devDependency，所以从包目录解析——
// 不指望根 node_modules 把它提升上来（pnpm 也不该提升未声明的依赖）。
const { default: esbuild } = await import(
  pathToFileURL(createRequire(path.join(PLUGIN, 'package.json')).resolve('esbuild')).href
)

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

const result = await esbuild.build({
  entryPoints: [path.join(PLUGIN, 'src', 'index.ts')],
  outfile: OUT_FILE,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  minify: false,
  // 宿主注入的东西绝不能打进包。
  external: ['cordis', '@deepseek-ai/*', 'bufferutil', 'utf-8-validate'],
  // 版本号只有打包这一刻才知道：`src/version.ts` 探不到这个 define 时退回 `'dev'`，
  // 于是"装进 profile 的 bundle"与"仓里直跑的源码"在 pill 上不是同一种字样。
  define: { __DRC_VERSION__: JSON.stringify(PLUGIN_VERSION) },
  // 产物是 ESM，而内联进来的 tweetnacl / ws 是 CJS：esbuild 会把它们的
  // `require('crypto')` 之类换成"运行期抛错"的兜底函数（Dynamic require is not supported）。
  // 补一句真 require。这条不是可选优化——烟测里插件加载即崩过一次。
  banner: {
    js: "import { createRequire as __drcCreateRequire } from 'node:module';const require = __drcCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
  metafile: true,
})

const bytes = statSync(OUT_FILE).size
const bundled = Object.keys(result.metafile?.inputs ?? {})
  .filter((entry) => !entry.startsWith('../../packages/plugin/'))
  .map((entry) => entry.replace('../../node_modules/.pnpm/', '').split('/node_modules/').pop())

// ── 浏览器面（右栏自动弹码的轮询端）────────────────────────────────────
await esbuild.build({
  entryPoints: [path.join(PLUGIN, 'client', 'src', 'main.ts')],
  outfile: CLIENT_OUT,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'chrome120',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
  banner: {
    js:
      `window.__ModuleLoader__.load({\n` +
      `  id: ${JSON.stringify(BUNDLE_ID)},\n` +
      `  factory: (require) => {\n` +
      `    var module = { exports: {} };\n` +
      `    var exports = module.exports;\n`,
  },
  footer: {
    js: `\n    return module.exports;\n  },\n});\n`,
  },
})

const clientBytes = statSync(CLIENT_OUT).size
const clientText = readFileSync(CLIENT_OUT, 'utf8')

// 三条都是"错了就整页起不来"的形状，所以留在构建脚本里而不是单测里：
// 单测跑的是源码，而外壳是**这一步**拼出来的产物。
const shape = [
  [clientText.startsWith('window.__ModuleLoader__.load({'), '外壳开头不是 __ModuleLoader__.load'],
  [clientText.includes(`id: "${BUNDLE_ID}"`), `外壳里的 id 不是 ${BUNDLE_ID}`],
  [clientText.trimEnd().endsWith('});'), '外壳结尾没闭合'],
]
for (const [ok, message] of shape) {
  if (!ok) {
    console.error(`[bundle-plugin] ${message}：client.cjs 的外壳拼错了，装上去会让 web boot 失败`)
    process.exit(1)
  }
}
if (!clientText.includes('conversation.composer.dock')) {
  console.error('[bundle-plugin] client.cjs 里看不到那个槽位名，八成是打包入口写错了（pill 没进 bundle？）')
  process.exit(1)
}
// 状态栏那颗 pill 要向装载器拿 react。它**必须**是运行期那一句（模块名走变量），
// 不能是构建期解析出来的 `require("react")`：后者会被提到 factory 顶层，宿主给不出这个
// 模块时抛出发生在 factory 第一行——表现是"web boot: N entry/entries did not activate"，
// 连已经在生产跑的右栏自动弹码一起没。运行期那一句最坏只少一颗 pill。
if (/require\(["']react["']\)/.test(clientText)) {
  console.error('[bundle-plugin] client.cjs 里出现了静态 require("react")：那会让装载失败变成整页起不来')
  process.exit(1)
}
// 反向也钉一条：react 被**内联**进来同样致命（宿主那份与我们这份是两套 fiber，钩子互相
// 不认识，一点 dock 就白屏）。内联的产物体积会跳一个数量级，所以这里用体积上限当探针。
if (clientBytes > 128 * 1024) {
  console.error(
    `[bundle-plugin] client.cjs ${(clientBytes / 1024).toFixed(0)} KB，超过 128 KB 上限：` +
      '浏览器那一半只该有轮询 + pill 那点代码，超了八成是把 react 打进来了',
  )
  process.exit(1)
}

console.log(
  `[bundle-plugin] ${path.relative(ROOT, OUT_FILE)} ${(bytes / 1024).toFixed(0)} KB（内联了 ${bundled.length} 个非本包模块）、client.cjs ${(clientBytes / 1024).toFixed(0)} KB`,
)
if (bytes > 3 * 1024 * 1024) {
  console.error('[bundle-plugin] 产物超过 3 MB，检查是不是把宿主包也打进去了')
  process.exit(1)
}
