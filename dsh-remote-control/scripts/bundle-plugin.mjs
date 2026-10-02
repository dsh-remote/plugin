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
 *   dist/bundle/index.js   —— 给 profile 用（配合生成的 package.json，无需 node_modules）
 *   dist/bundle/index.js 同一份也供 e2e 直接 import（本地跑时 workspace 依赖在，行为一致）
 *
 * 类型检查不在这里做：`pnpm typecheck` / `tsc -p tsconfig.json` 负责，
 * esbuild 只打包不校验，"build 绿"不等于"类型对"。
 */
import { createRequire } from 'node:module'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const PLUGIN = path.join(ROOT, 'packages', 'plugin')
const OUT_DIR = path.join(PLUGIN, 'dist', 'bundle')
const OUT_FILE = path.join(OUT_DIR, 'index.js')

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
console.log(
  `[bundle-plugin] ${path.relative(ROOT, OUT_FILE)} ${(bytes / 1024).toFixed(0)} KB，内联了 ${bundled.length} 个非本包模块`,
)
if (bytes > 3 * 1024 * 1024) {
  console.error('[bundle-plugin] 产物超过 3 MB，检查是不是把宿主包也打进去了')
  process.exit(1)
}
