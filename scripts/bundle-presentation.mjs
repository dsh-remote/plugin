/**
 * bundle-presentation — 把 presentation 包的两半打成可安装产物。
 *
 * 与 `bundle-plugin.mjs` 同一个道理（理由见那个文件头）：装进外部 profile 的包不能指望
 * workspace 依赖，所以要打成自包含单文件；宿主注入的 `cordis` / `@deepseek-ai/*` 必须留作
 * external，打进去就是两份实例。
 *
 * 两半的产物形态不一样：
 *
 *   dist/bundle/index.js   —— 宿主侧（ESM，`main` 指向它）。与 bundle-plugin 同款。
 *   dist/bundle/client.cjs —— 浏览器侧。**必须裹在 `window.__ModuleLoader__.load({id, factory})`
 *                             里**，`id` 必须是包的完整名（`@deepseek-ai/dsh-client-modules` 按
 *                             loader entry 名去 `graphRows` 里查，名字对不上就注册不上）。
 *                             这个外壳没有别的办法生成，所以由本脚本的 banner/footer 拼出来，
 *                             并在拼完之后**逐字节校验**（见下方断言）：外壳写错的表现是
 *                             "整页 web boot 失败"，而那是要重启应用才看得见的故障，
 *                             不该等到真机才发现。
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const PKG = path.join(ROOT, 'packages', 'presentation')
const OUT_DIR = path.join(PKG, 'dist', 'bundle')
const HOST_OUT = path.join(OUT_DIR, 'index.js')
const CLIENT_OUT = path.join(OUT_DIR, 'client.cjs')
const BUNDLE_ID = 'dsh-remote-control-presentation'

const { default: esbuild } = await import(
  pathToFileURL(createRequire(path.join(PKG, 'package.json')).resolve('esbuild')).href
)

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

const hostResult = await esbuild.build({
  entryPoints: [path.join(PKG, 'src', 'entry.ts')],
  outfile: HOST_OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  minify: false,
  external: ['cordis', '@deepseek-ai/*'],
  // 同 bundle-plugin：产物是 ESM，而内联进来的 node-qrcode 是 CJS，它的 require()
  // 需要一句真 require 兜着。
  banner: {
    js: "import { createRequire as __drcCreateRequire } from 'node:module';const require = __drcCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
  metafile: true,
})

await esbuild.build({
  entryPoints: [path.join(PKG, 'client', 'src', 'main.ts')],
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

const hostBytes = statSync(HOST_OUT).size
const clientBytes = statSync(CLIENT_OUT).size
const clientText = readFileSync(CLIENT_OUT, 'utf8')

// 三个断言，都是"错了就整页起不来"的形状：
const shape = [
  [clientText.startsWith('window.__ModuleLoader__.load({'), '外壳开头不是 __ModuleLoader__.load'],
  [clientText.includes(`id: "${BUNDLE_ID}"`), `外壳里的 id 不是 ${BUNDLE_ID}`],
  [clientText.trimEnd().endsWith('});'), '外壳结尾没闭合'],
]
for (const [ok, message] of shape) {
  if (!ok) {
    console.error(`[bundle-presentation] ${message}：client.cjs 的外壳拼错了，装上去会让 web boot 失败`)
    process.exit(1)
  }
}
if (!clientText.includes('sidebarRight')) {
  console.error('[bundle-presentation] client.cjs 里看不到 sidebarRight，八成是打包入口写错了')
  process.exit(1)
}
if (hostBytes > 1024 * 1024) {
  console.error('[bundle-presentation] index.js 超过 1 MB，检查是不是把宿主包也打进去了')
  process.exit(1)
}

const inlined = Object.keys(hostResult.metafile?.inputs ?? {})
  .filter((entry) => !entry.startsWith('../presentation/') && !entry.startsWith('../../packages/presentation/'))
  .map((entry) => entry.replace('../../node_modules/.pnpm/', '').split('/node_modules/').pop())
console.log(
  `[bundle-presentation] index.js ${(hostBytes / 1024).toFixed(0)} KB（内联 ${inlined.length} 个非本包模块）、client.cjs ${(clientBytes / 1024).toFixed(0)} KB`,
)
