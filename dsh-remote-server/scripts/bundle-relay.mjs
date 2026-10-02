/**
 * bundle-relay — 把中继打成一个**自包含单文件**（生产唯一受支持的入口）。
 *
 * 为什么这一步要有个脚本而不是 package.json 里的一行 esbuild 命令：
 *
 * 1. **版本号必须在产物里**。生产部署是"scp 一个 main.js 到 /opt/.../server/"，
 *    文件旁边没有 package.json，于是 `readVersion()` 的两条文件探针都会落空，
 *    `/healthz` 的 version 变成 `0.0.0`——而运维恰恰是靠这个字段判断
 *    "线上跑的是哪一版"（取证 docs/legacy-spec/relay-and-wireformat.md §7.3 的告警表）。
 *    所以打包时把 `package.json` 的 version 以 define 写进产物。
 *    （这条是被自己的测试漏掉的：`bundle.test.mjs` 原来只断言 version 是 string，
 *    `0.0.0` 也算 string，于是产物级断言形同不设防。现在断言它等于包版本。）
 * 2. **CJS 内联需要真的 `require`**：产物是 ESM，而内联进来的 `ws`/`zod` 里有
 *    `require('...')`，esbuild 会把它们换成运行期抛错的兜底函数。
 * 3. 只有 `bufferutil` / `utf-8-validate` 这两个可选原生模块留在外面。
 *
 * 刻意**不做 `rm -rf dist`**：`dist/` 同时是 tsc 产物与四套测试的读取目标，
 * 清空重建在多会话并行时会把别人正在读的东西抽走（真发生过）。
 * esbuild 每次整体覆写 outfile，产物级断言不受残留影响。
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const OUT_DIR = path.join(ROOT, 'dist', 'bundle')
const OUT_FILE = path.join(OUT_DIR, 'main.js')

const requireFromRoot = createRequire(path.join(ROOT, 'noop.cjs'))
const esbuild = await import(pathToFileURL(requireFromRoot.resolve('esbuild')).href)

rmSync(OUT_FILE, { force: true })
mkdirSync(OUT_DIR, { recursive: true })

const result = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'main.ts')],
  outfile: OUT_FILE,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  minify: false,
  external: ['bufferutil', 'utf-8-validate'],
  define: { __DRC_VERSION__: JSON.stringify(String(PKG.version)) },
  banner: {
    js: "import { createRequire as __drcCreateRequire } from 'node:module';const require = __drcCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
  metafile: true,
})

// 内联进来的只有外部依赖，路径里带 node_modules 的那些。这里只把包裹名挑出来写进日志，
// 不去猜 cwd 与产物目录的相对关系（那正是旧版把本地文件也数进去的原因）。
const inputs = Object.keys(result.metafile?.inputs ?? {})
const inlined = [
  ...new Set(
    inputs
      .filter((entry) => entry.includes('node_modules'))
      .map((entry) => /node_modules\/(?:\.pnpm\/)?((?:@[^/]+\/)?[^/]+)/.exec(entry)?.[1] ?? entry),
  ),
]
const bytes = statSync(OUT_FILE).size
console.log(
  `[bundle-relay] v${PKG.version} ${path.relative(ROOT, OUT_FILE)} ${(bytes / 1024).toFixed(0)} KB，内联了 ${inlined.length} 个包${inlined.length ? `：${inlined.slice(0, 6).join(', ')}` : ''}`,
)
