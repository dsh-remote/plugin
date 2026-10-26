#!/usr/bin/env node
/**
 * 产出**无 scope 名** `dsh-remote-control@<当前版本>` 的 tarball。
 *
 * 为什么要有这个脚本（2026-10-26 裁决）：
 * npm 上的 `dsh-remote-control`（无 scope）在 providcc 名下，是这份产品**唯一**的
 * 无 scope 品牌位；竞对只能用 `@copylee/…`、`@mazov2love/…`（已核实两个仓的
 * package.json），拿不到它。但它的 1.x/2.x 是 2026-10 之前的老线，
 * 一旦 `latest` 落回那里，`dsh plugin add dsh-remote-control` 装到的就是旧代码
 * ——「给竞对做嫁衣」的机制就是这个：名字是我们的，装出来的是僵尸。
 * ⇒ 每次发 0.5.x，必须把它一起发出去（`latest` 指过去）。
 *
 * 四处必须同时改成无 scope 名，少一处就是"文件都在、插件不加载"：
 *   1. `package.json` 的 `name`（loader 按包名解析模块）
 *   2. `cordis.patch.yml` 的 `insert.name`（同上）
 *   3. `scripts/bundle-plugin.mjs` 的 `BUNDLE_ID`（写进 client.cjs 外壳的 id）
 *   4. `src/client/main.ts` 的 `export const name`（模块自报的名字）
 *
 * 用法：
 *   node scripts/pack-unscoped.mjs            # 产出 tarball 并还原源码
 *   node scripts/pack-unscoped.mjs --rename    # 只改名 + 构建，**不还原**（CI 用，见 release.yml）
 *   node scripts/pack-unscoped.mjs --keep-dist # 还原源码后不重建 dist
 *
 * `--rename` 是给 Actions 用的：改名构建之后**就地 `pnpm publish`**，
 * 走与 scoped 包完全同一条路（同一个 OIDC 交换、同一份 provenance），
 * 之后由工作流 `git checkout --` 还原再重建。**别在本地用它**——会留下半改的工作树。
 *
 * 产物默认落在系统临时目录，打印绝对路径；本机发布用
 *   npm publish <tarball> --tag latest --provenance=false
 * 注意 `--provenance=false`：本机不是受支持的 CI，开着会直接 EUSAGE 失败。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const UNSCOPED = 'dsh-remote-control'
const SCOPED = '@dsh-remote/plugin'
const keepDist = process.argv.includes('--keep-dist')
const renameOnly = process.argv.includes('--rename')

/** 要改的四份文件；每份给出「原文 → 无 scope」的精确替换对。 */
const EDITS = [
  ['package.json', `"name": "${SCOPED}"`, `"name": "${UNSCOPED}"`],
  ['cordis.patch.yml', `name: '${SCOPED}'`, `name: '${UNSCOPED}'`],
  ['scripts/bundle-plugin.mjs', `const BUNDLE_ID = '${SCOPED}'`, `const BUNDLE_ID = '${UNSCOPED}'`],
  ['src/client/main.ts', `export const name = '${SCOPED}'`, `export const name = '${UNSCOPED}'`],
]

const version = JSON.parse(readFileSync(path.join(PLUGIN, 'package.json'), 'utf8')).version
const backupDir = mkdtempSync(path.join(tmpdir(), 'drc-unscoped-'))
const outDir = mkdtempSync(path.join(tmpdir(), 'drc-tarball-'))

/** 不继承 NODE_OPTIONS：宿主环境里那串参数会让 tsc/esbuild 走错 loader。 */
const env = { ...process.env }
delete env.NODE_OPTIONS

const build = () => execFileSync('pnpm', ['run', 'build'], { cwd: PLUGIN, env, stdio: 'inherit' })

// 备份 → 替换 → 构建 → 打包 → 还原。任一步抛错都必须还原，否则工作树留下半改状态。
const backups = []
try {
  for (const [rel, from] of EDITS) {
    const abs = path.join(PLUGIN, rel)
    const text = readFileSync(abs, 'utf8')
    if (!text.includes(from)) {
      throw new Error(`${rel} 里找不到 ${JSON.stringify(from)} —— 命名约定变了，先改这个脚本`)
    }
    const bak = path.join(backupDir, rel.replaceAll('/', '__'))
    copyFileSync(abs, bak)
    backups.push([abs, bak])
  }

  for (const [rel, from, to] of EDITS) {
    const abs = path.join(PLUGIN, rel)
    const text = readFileSync(abs, 'utf8')
    if (text.split(from).length !== 2) {
      throw new Error(`${rel} 里 ${JSON.stringify(from)} 出现次数不是 1 —— 替换会有歧义`)
    }
    // 用 Node 自己替换而不是 `perl -pi -e`：包名里的 `@` 与 `/` 会被 perl 的
    // 数组符号和 s/// 分隔符吃掉，套一层环境变量也只是把坑挪到 shell（2026-10-26 踩过）。
    writeFileSync(abs, text.replace(from, to))
  }

  console.log(`[pack-unscoped] 构建 ${UNSCOPED}@${version} …`)
  build()

  const manifest = JSON.parse(readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
  if (manifest.name !== UNSCOPED) throw new Error(`package.json 没改成 ${UNSCOPED}`)
  const client = readFileSync(path.join(PLUGIN, 'dist', 'bundle', 'client.cjs'), 'utf8')
  if (!client.includes(`id: "${UNSCOPED}"`)) throw new Error('client.cjs 外壳 id 没改成无 scope 名')
  if (!client.includes(`var name = "${UNSCOPED}"`)) throw new Error('client 模块自报名没改成无 scope 名')
  const patch = readFileSync(path.join(PLUGIN, 'cordis.patch.yml'), 'utf8')
  if (!patch.includes(`name: '${UNSCOPED}'`)) throw new Error('cordis.patch.yml 的 insert.name 没改')

  if (renameOnly) {
    // CI 模式：改完就交给紧接着的 `pnpm publish`，由工作流负责还原（见 release.yml）。
    console.log(`[pack-unscoped] 已就地改为 ${UNSCOPED}@${version} 并构建完毕，源码保持改名状态`)
    console.log('[pack-unscoped] CI：紧接着 pnpm publish；之后必须 git checkout 还原这四个文件')
  } else {
    const packed = execFileSync('npm', ['pack', '--pack-destination', outDir], {
      cwd: PLUGIN,
      env,
      encoding: 'utf8',
    })
    const tarball = path.join(outDir, packed.trim().split('\n').pop())
    console.log(`[pack-unscoped] 产物：${tarball}`)
    console.log('[pack-unscoped] 下一步：npm publish 上面这个文件 --tag latest --provenance=false')
  }
} finally {
  if (!renameOnly) {
    for (const [abs, bak] of backups) copyFileSync(bak, abs)
    rmSync(backupDir, { recursive: true, force: true })
    if (backups.length && !keepDist) {
      // dist 是无 scope 变体，还原 dist 免得本机装着跑的是"另一个包名"的产物。
      build()
    }
  }
}
