#!/usr/bin/env node
/**
 * pack-to-profile —— **标准插件装机路径**（2026-10-08 起，与 archify-dsh 同形状）。
 *
 *   node scripts/pack-to-profile.mjs                     # ~/.dsh/profiles/desktop
 *   DSH_PROFILE=~/.dsh/profiles/tui node scripts/pack-to-profile.mjs
 *
 * ## 为什么不再"直拷产物"
 *
 * `install-to-profile.mjs` 那条路把 `dist/bundle/*` 直接拷进 profile 的 node_modules：
 * 快，但它**不在 profile 的 dependencies 里**，于是
 *   ① `dsh plugin --profile desktop add <pkg>` / 任何一次 `pnpm install` 都可能把它
 *      当多余目录清掉；② 屏幕上"装的是哪个版本"只剩 bundle 里那行内嵌字符串，
 *      与 profile 记录的依赖版本是两套真相。
 *
 * 现在改成和 archify-dsh 一样的两件事：
 *   1. `dependencies["@dsh-remote/plugin"] = "file:<tgz>"`
 *   2. `dsh.profile.bundles` 里有同一个名字
 * 剩下的交给 pnpm —— 与宿主自己装插件的方式完全一致（`dsh plugin add` 就是转发 pnpm）。
 *
 * ## 三条容易错的（每条都对应一种静默失败）
 *
 * 1. **tarball 要落到 profile 之外的稳定路径**。放在仓里会被 `pnpm clean` 删掉，
 *    而下一次 `pnpm install` 还要按 lockfile 去读它。这里落在
 *    `~/.dsh/plugins/dsh-remote/`（与 provider-usage 的落点同形状）。
 * 2. **装完必须回读校验**：`file:` tarball 内容变了而版本号没变时，pnpm 可能认为
 *    "已满足"而**不重新解包**——表现是"跑的是上一个构建"。所以装完读
 *    `node_modules/@dsh-remote/plugin/package.json`，版本对不上就 `--force` 重装，
 *    再对不上就**报错退出**（不许静默成功）。
 * 3. **`bundles` 里的名字必须等于包名**。旧条目 `dsh-remote-control` 要一并摘掉——
 *    留着它的表现是"插件加载了但目录下那份是旧的"。
 *
 * ## 与运行时 id 的关系（改包名不丢配对）
 *
 * 包名是 `@dsh-remote/plugin`，运行时 id 仍是 `dsh-remote-control`：
 * 数据目录 `~/.dsh/dsh-remote-control`、四条 pill 路由前缀都是硬编码常量
 * （`src/platform/paths.ts`、`src/client/pill.ts`），不随包名变。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..')
const PROFILE = process.env.DSH_PROFILE ?? path.join(process.env.HOME ?? '~', '.dsh', 'profiles', 'desktop')
/** 包的完整名 —— loader 解析模块用的就是它，必须与 package.json 的 name 一致。 */
const BUNDLE_ID = '@dsh-remote/plugin'
/** 旧装机方式留下的目录名（运行时 id），本机换装后它应当消失。 */
const LEGACY_DIR = 'dsh-remote-control'
/** tarball 的稳定落点：不能放在会被 `pnpm clean` 清掉的仓内目录。 */
const TGZ_DIR = path.join(process.env.HOME ?? '~', '.dsh', 'plugins', 'dsh-remote')

function fail(message) {
  process.stderr.write(`pack-to-profile: ${message}\n`)
  process.exit(1)
}

if (!existsSync(PROFILE)) fail(`profile not found: ${PROFILE}`)

const pkg = JSON.parse(readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
if (pkg.name !== BUNDLE_ID) fail(`package.json 的 name 是 ${pkg.name}，本脚本认的是 ${BUNDLE_ID}`)
const version = pkg.version

// ── 1. 构建（两半产物；协议层随 esbuild 内联）────────────────────────────
process.stdout.write(`→ 构建 ${BUNDLE_ID} @ ${version} …\n`)
try {
  execFileSync(process.execPath, [path.join(PLUGIN, 'scripts', 'bundle-plugin.mjs')], { stdio: 'inherit' })
} catch (error) {
  fail(`打包失败：${String(error?.message ?? error)}`)
}

// ── 2. npm pack → 稳定落点 ──────────────────────────────────────────────
mkdirSync(TGZ_DIR, { recursive: true })
process.stdout.write(`→ npm pack → ${TGZ_DIR} …\n`)
let packed
try {
  const out = execFileSync('npm', ['pack', '--pack-destination', TGZ_DIR], {
    cwd: PLUGIN,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  packed = out.trim().split('\n').filter(Boolean).pop()
} catch (error) {
  fail(`npm pack 失败：${String(error?.message ?? error)}`)
}
const tgz = path.join(TGZ_DIR, path.basename(String(packed)))
if (!existsSync(tgz)) fail(`npm pack 没产出预期文件：${tgz}`)
process.stdout.write(`   ${tgz}\n`)

// ── 3. 改写 profile 的 package.json ─────────────────────────────────────
const profilePkgFile = path.join(PROFILE, 'package.json')
if (!existsSync(profilePkgFile)) fail(`profile 没有 package.json：${profilePkgFile}`)
writeFileSync(`${profilePkgFile}.bak-plugin`, readFileSync(profilePkgFile))

const profilePkg = JSON.parse(readFileSync(profilePkgFile, 'utf8'))
profilePkg.dependencies = profilePkg.dependencies || {}
profilePkg.dependencies[BUNDLE_ID] = `file:${tgz}`

profilePkg.dsh = profilePkg.dsh || {}
profilePkg.dsh.profile = profilePkg.dsh.profile || {}
const list = (profilePkg.dsh.profile.bundles || []).filter((name) => name !== LEGACY_DIR)
if (!list.includes(BUNDLE_ID)) list.push(BUNDLE_ID)
profilePkg.dsh.profile.bundles = list
writeFileSync(profilePkgFile, JSON.stringify(profilePkg, null, 2) + '\n')
process.stdout.write(`→ dependencies[${BUNDLE_ID}] = file:${tgz}\n   bundles: ${list.join(', ')}\n`)

// ── 4. pnpm install（装完回读校验）─────────────────────────────────────
function installedVersion() {
  const file = path.join(PROFILE, 'node_modules', BUNDLE_ID, 'package.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')).version ?? null
  } catch {
    return null
  }
}

function pnpmInstall(extraArgs) {
  execFileSync('pnpm', ['install', ...extraArgs], { cwd: PROFILE, stdio: 'inherit' })
}

process.stdout.write('→ pnpm install（在 profile 目录里，与 `dsh plugin add` 走的是同一条）…\n')
try {
  pnpmInstall([])
  if (installedVersion() !== version) {
    // 版本号没变而 tarball 内容变了时 pnpm 会认为依赖已满足，这一遍是把它打醒的。
    process.stdout.write(`   装到的版本是 ${installedVersion()}，期望 ${version} —— 用 --force 重装一遍\n`)
    pnpmInstall(['--force'])
  }
} catch (error) {
  fail(`pnpm install 失败：${String(error?.message ?? error)}`)
}

const got = installedVersion()
if (got !== version) {
  fail(`装完回读仍是 ${got}，期望 ${version}。先确认 tarball 里确实是 ${version}：\n   tar -tzf ${tgz}\n`)
}

// ── 5. 清掉旧装机方式留下的目录 ────────────────────────────────────────
const legacy = path.join(PROFILE, 'node_modules', LEGACY_DIR)
if (existsSync(legacy)) {
  rmSync(legacy, { recursive: true, force: true })
  process.stdout.write(`→ 已删除旧直拷目录 node_modules/${LEGACY_DIR}\n`)
}

const installedDir = path.join(PROFILE, 'node_modules', BUNDLE_ID)
const installedFiles = existsSync(installedDir) ? readdirSync(installedDir).sort().join(', ') : '(缺失)'
process.stdout.write(`\n✅ 已以标准依赖方式安装 ${BUNDLE_ID} @ ${version}\n   ${installedDir}\n   ${installedFiles}\n`)
process.stdout.write('   下一步：**重启 Harness**（pnpm 换掉的文件不会被热加载；浏览器面还要刷新页面），然后看\n')
process.stdout.write('     cat ~/.dsh/dsh-remote-control/status.json\n')
process.stdout.write('   要确认的：pill.routes = registered、problems 为空、relay 能到 online。\n')
process.stdout.write('   版本那一行看 pill 弹窗（status.json 里没有版本字段，它只在 pill 面板上）。\n')
