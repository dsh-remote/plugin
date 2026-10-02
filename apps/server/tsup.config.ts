/**
 * tsup 配置：产出一个**自包含单文件** `dist/bundle/main.js`。
 *
 * 为什么要有这一步（而不是直接部署 `dist/src/*.js`）：
 * 生产部署方式是 `scp` 上去 + systemd 拉起，今天已经是"拷 main.mjs + package.json，
 * 然后 npm install --omit=dev"。把协议层与 ws 一起打进一个文件之后，
 * 服务器上是**一个 .js 文件、零 node_modules**——少一步 npm，也就少一类
 * "服务器上的依赖树和 CI 不一致"的故障。
 *
 * 顺带拿到一条可以测试的结构性保证：协议层标了 `sideEffects: false`，
 * 中继只 import `frames` 与 `ids`，所以打包结果里**不含任何密码学代码**
 * （`tests/bundle.test.mjs` 直接对产物做正则断言）。零知识不再只是"代码里没调用"，
 * 而是产物里就没有。
 */
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts'],
  outDir: 'dist/bundle',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  // 全部内联：部署包里没有 node_modules。
  noExternal: [/.*/],
  // 这两个是 ws 的可选原生加速器，服务器上不存在，也不该在构建期解析。
  external: ['bufferutil', 'utf-8-validate'],
  sourcemap: false,
  minify: false,
  splitting: false,
  // 产物是 ESM，而内联进来的 `ws` 是 CJS：esbuild 会把它的 `require('events')`
  // 之类换成一个"运行期抛错"的兜底函数（Dynamic require is not supported）。
  // 补一句真 require 就行——这是保持"单文件 + ESM + 零 node_modules"部署形态的代价，
  // 另一个选择是退回 CJS 产物或让 ws 走 npm install，两者都比这行注释贵。
  banner: {
    js: "import { createRequire as __drcCreateRequire } from 'node:module';const require = __drcCreateRequire(import.meta.url);",
  },
  target: 'node20',
  clean: true,
})
