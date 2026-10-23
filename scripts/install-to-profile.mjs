#!/usr/bin/env node
/**
 * install-to-profile — 构建插件并装进 DSH profile。
 *
 *   node scripts/install-to-profile.mjs                 # ~/.dsh/profiles/desktop
 *   DSH_PROFILE=~/.dsh/profiles/tui node scripts/install-to-profile.mjs
 *
 * ## v2 → v3：从 `.sh` 改成 `.mjs`（A4）不是风格偏好
 *
 * 三个真实理由，每一个都在 v2 里造成过或必然造成故障：
 *
 * 1. **`file.slice(0, file.lastIndexOf('/'))` 在 Windows 上得 -1**
 *    （v2 `install-to-profile.sh:123`）。于是 `dir` 变成 `''` 减 1 之前的怪东西，
 *    备份被写到**当前工作目录**而不是 profile 里——profile 的 `package.json`
 *    改坏了却"没有备份"，而那文件里带着 hostToken。
 *    ⇒ 这里用 `path.dirname` / `path.basename`，它们在三个平台上都对。
 * 2. **`sh` 在 Windows 上不存在**（Git Bash 之外）。这不是"不支持"，是 ENOENT。
 * 3. **heredoc 里的 `$` 与引号**（v2 用 `<<NODEJS` 把 JS 塞进 `node --input-type=module`）。
 *    v2 的注释记着这个坑真实踩过：任何英文双引号都会提前截断字符串，
 *    表现是"脚本静默跑完、只写了备份、什么都没改"，**退出码还是 0**。
 *    ⇒ 这里没有 heredoc：逻辑就是本文件的代码。
 *
 * ## 装的是什么
 *
 * **一个 bundle、两半产物**（2026-10-03 起；之前是两包两个 bundle）：
 *
 *   dsh-remote-control/index.js    宿主侧：配对、中继、会话，外加给状态栏那颗
 *                                  pill 挂四条同域路由（发码 / 图片 / 状态 / 退出配对）
 *   dsh-remote-control/client.cjs  浏览器面：向装载器拿 react、往
 *                                  `conversation.composer.dock` 注册那颗 pill
 *
 * 为什么折成一个包：拆包是为了"某一代宿主没有 `webServer` 时只有那一行不激活"。
 * 折成一个包之后这个隔离由代码提供——`src/pill/start.ts` 只软探测 `webServer`，
 * 拿不到就整半不起；`tests/pill-isolation.test.ts` 用**逐字段对照**锁住这件事。
 *
 * ⚠️ 2026-10-03 起**配对入口只有那颗 pill**：右栏自动弹码、终端文本码都删了，
 * `/drc` 命令更是**整条删掉**。所以"路由没挂上"= 这台主机配不了对，
 * 它会在 `status.json` 的 `problems` 里留一条 `warn:pill`。
 *
 * ## 为什么长这样（每条都是踩过坑换来的）
 *
 * 1. **只拷产物**：两半都由 esbuild 打成自包含单文件，profile 里不需要 node_modules。
 *    旧实现要靠 `pnpm add file:` 装整个包，而 pnpm 对 `file:` 依赖是硬链接拷贝，
 *    `tsc` 重建后 inode 变了、profile 里仍是旧副本。
 * 2. **不跑 pnpm add**：它会重新解析 profile 里所有依赖（含若干 GitHub tarball），
 *    网络抖一下就更新不了一个纯本地插件。
 * 3. **改代码必须重启 Harness**：HMR 只热更 `cordis.patch.yml` 的配置，不会重新 import dist。
 * 4. 首次安装才备份并改写 profile 的 `package.json`（注册进 bundles 列表），后续只换文件。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const PLUGIN = ROOT
const PROFILE = process.env.DSH_PROFILE ?? path.join(process.env.HOME ?? '~', '.dsh', 'profiles', 'desktop')
/**
 * 装进 profile 后的 bundle id —— **必须等于包的完整名**（package.json 的 name），
 * 否则 loader 解析不到模块（"文件都在，插件不加载"）。
 *
 * 2026-10-08：默认装机路径改成**标准 pnpm 依赖**（`scripts/pack-to-profile.mjs`），
 * 本脚本退为"直拷产物"的应急通道。装成 pnpm 依赖后目标目录是**软链**
 * （`node_modules/@dsh-remote/plugin -> .pnpm/...`），下面那个软链检查会直接拒绝，
 * 于是两条路不会互相踩（旧实现踩过：两份实例、两个 hostId、手机连到谁全凭运气）。
 */
const BUNDLE_ID = '@dsh-remote/plugin'

function fail(message) {
  process.stderr.write(`install-to-profile: ${message}\n`)
  process.exit(1)
}

if (!existsSync(PROFILE)) fail(`profile not found: ${PROFILE}`)

// 装 profile 只需要**产物**；类型检查是 CI 的事（pnpm -r typecheck）。
// 这里刻意不跑 tsc：类型检查失败不该挡住"把当前代码装进宿主验证一把"。
// 协议层是 workspace 依赖，被 esbuild 打包时直接内联，本脚本不再单独构建它。
process.stdout.write('→ 构建：一次 esbuild 打包产出两半（index.js + client.cjs，协议层随依赖内联）…\n')
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'bundle-plugin.mjs')], { stdio: 'inherit' })
} catch (error) {
  fail(`打包失败：${String(error?.message ?? error)}`)
}

const built = path.join(PLUGIN, 'dist', 'bundle', 'index.js')
const client = path.join(PLUGIN, 'dist', 'bundle', 'client.cjs')
const pkgPath = path.join(PLUGIN, 'package.json')
const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version
const target = path.join(PROFILE, 'node_modules', BUNDLE_ID)

if (!existsSync(built)) fail(`缺宿主侧产物 ${built}`)
if (!existsSync(client)) fail(`缺浏览器面产物 ${client}`)

/**
 * **必须是真目录，不能是指回工作区的软链**。旧实现用
 * `pnpm add file:.../packages/plugin` 安装，profile 的 package.json 里就留下一条
 * `"dsh-remote-control": "file:..."`；只要那条还在，`pnpm install` 就会把整个工作区包
 * 再物化一份进来，于是宿主里同时跑着**两个插件实例**：两个 hostId、中继里两份会话、
 * 手机连到哪一个全看谁先注册——真机取证时表现为"改了的代码没生效"，
 * 而 status.json 的计数来自另一个实例，怎么都对不上账（那次就是被它误导了好几轮）。
 */
try {
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    fail(
      `${target} 是软链——这个插件现在是**标准 pnpm 依赖**（2026-10-08 起）。\n` +
        `  请改用：node scripts/pack-to-profile.mjs（打 tgz → pnpm install）。\n` +
        `  确实要退回直拷：先删掉 ${path.join(PROFILE, 'package.json')} 的 dependencies.${BUNDLE_ID}，再重跑本脚本。`,
    )
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

// 整个目录先删后建：只删 index.js/package.json 的话，上一次 pnpm 物化出来的
// dist/、node_modules/ 会被当成当前版本的一部分。顺带清掉手工调试留下的残渣。
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(built, path.join(target, 'index.js'))
cpSync(client, path.join(target, 'client.cjs'))
cpSync(path.join(PLUGIN, 'cordis.patch.yml'), path.join(target, 'cordis.patch.yml'))

/**
 * `dsh.bundle.patch` 是宿主认出这是一个 bundle 的入口字段——漏了它，文件都在、
 * profile 的 bundles 列表里也有名字，但插件根本不会被加载（踩过一次）。
 * 浏览器面多两个字段：`exports["./client"]` 指向产物，`dsh.client.platform` 表明它是 web 面。
 * `dsh.client.inject` 是**包名**列表（模块到达顺序），不是 cordis 服务名——空数组即可。
 */
writeFileSync(
  path.join(target, 'package.json'),
  JSON.stringify(
    {
      name: BUNDLE_ID,
      version,
      type: 'module',
      main: './index.js',
      exports: {
        '.': './index.js',
        './client': './client.cjs',
        './cordis.patch.yml': './cordis.patch.yml',
        './package.json': './package.json',
      },
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web', inject: [] },
      },
    },
    null,
    2,
  ) + '\n',
)
process.stdout.write(`   已写入 ${target}\n     ${BUNDLE_ID} @ ${version}（含浏览器面 client.cjs）\n`)

process.stdout.write('→ 注册 bundle 到 profile 的 bundles 列表（幂等）…\n')
// ⚠️ 这一段在 v2 是 heredoc 里的 JS，而那段代码有个真实的静默失败：
// 「脚本跑完、只写了备份、什么都没改，退出码还是 0」。现在它是本文件的普通代码，
// 失败就是失败（throw ⇒ 非 0 退出），那类"静默成功"从结构上不再可能。
{
  const file = path.join(PROFILE, 'package.json')
  if (!existsSync(file)) fail(`profile 没有 package.json：${file}`)

  // 改写前留一份原文：这文件里同时带着 hostToken，改坏了要能一眼回退。
  // 只留**一份**滚动备份。以前每次运行都写一个「.bak-drc-<时间戳>」，
  // 本机跑过 83 次就是 83 份带凭据的副本躺在 profile 里——那不是"能回退"，
  // 那是把凭据多复制了 83 遍。所以先把历史遗留的时间戳副本一起清掉。
  const dir = path.dirname(file)
  const base = path.basename(file)
  for (const stale of readdirSync(dir).filter((name) => name.startsWith(`${base}.bak-drc`))) {
    rmSync(path.join(dir, stale))
  }
  writeFileSync(`${file}.bak-drc`, readFileSync(file))

  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  const list = pkg.dsh.profile.bundles || []
  if (!list.includes(BUNDLE_ID)) list.push(BUNDLE_ID)
  pkg.dsh.profile.bundles = list
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  process.stdout.write(`   bundles: ${list.join(', ')}\n`)
}

process.stdout.write(`\n✅ 已安装 ${BUNDLE_ID}（两半产物）→ ${path.join(PROFILE, 'node_modules')}\n`)
process.stdout.write('   下一步：**重启 Harness**（新代码不会被热加载；浏览器面还要重新加载页面），然后看\n')
process.stdout.write('     cat ~/.dsh/dsh-remote-control/status.json\n')
process.stdout.write('   关键四字段：carrier（services=真内核 / mock=内存替身 / none=配置或载体问题）、\n')
process.stdout.write('               relay（online/connecting/offline）、relayProblem、\n')
process.stdout.write(
  '               pill（配对入口那四条路由的软探测结果：routes=registered / webServer=none / disabled）\n',
)
process.stdout.write('   配对：点状态栏那颗 dsh-remote-control（输入框那一排）。**命令行没有配对入口了**——\n')
process.stdout.write('     /drc 命令整条删掉（一个命令都不再注册），右栏自动弹码与终端文本码也都已删除。\n')
process.stdout.write('     那颗 pill 没出现时：先看 status.json 的 problems 里有没有 warn:pill（宿主侧没挂上路由，\n')
process.stdout.write('     原因在 pill 那块探针里），再看 DevTools 控制台里 [dsh-remote-control pill] 开头的\n')
process.stdout.write('     console.warn（那是浏览器面拿不到 react 或探不到 slots）。\n')
