#!/usr/bin/env node
/**
 * next-version — 发版前的版本号闸门。
 *
 * ## 为什么需要它（2026-10-07 实际卡住过一次）
 *
 * 发 1.0.1 时才发现 **npm 上 `1.0.1` 早就被私有期占用了**（`dsh-remote-wire@1.0.1`
 * 存在于 2025 年，`dsh-remote-control` 上没有）。npm 的版本**不可重用**，
 * 于是"发 1.0.1"这件事根本做不到——而这件事在动手之前是查一条命令就能知道的。
 *
 * 更隐蔽的是第二个坑：
 *
 * > control 上 **2.0.8 是空的**（当年 2.0.7 之后直接跳到 2.0.9）。
 * > 但发 2.0.8 是**版本号倒退**——2.0.13 已经发出去了，`latest` 会退到 2.0.8，
 * > 而 `^2.0.0` 的消费方**拿不到** 2.0.8（npm 按 semver 比大小，不按发布时间）。
 *
 * 所以正确判据不是"这个版本号空着吗"，而是
 *
 * > **大于所有已发布版本，且两个包上都空着。**
 *
 * ## 用法
 *
 *   node scripts/next-version.mjs            # 打印建议版本号（退出码 0）
 *   node scripts/next-version.mjs --major    # 跳到下一个大版本
 *   node scripts/next-version.mjs --check    # 拿各仓 package.json 里的版本号
 *                                           # 过一遍这道闸；没过退出码 1
 *
 * `--check` 是发版前**必须**跑的那一步：它比的是"仓里写的"与"npm 上有的"，
 * 所以谁改了版本号、忘了发，或者发到一半改了主意，都会被挡下来。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 两个要发到 npm 的包，与它们各自所在的仓。 */
const PUBLISHED = [
  { pkg: 'dsh-remote-wire', repo: 'dsh-remote-protocol', manifest: 'package.json' },
  { pkg: 'dsh-remote-control', repo: 'dsh-remote-control', manifest: 'packages/plugin/package.json' },
]

/** 与上面同一发版、版本号必须一致的那些仓（不发 npm，只是跟着长）。 */
const FOLLOWERS = [
  { repo: 'dsh-remote-server', manifest: 'package.json' },
  { repo: 'dsh-remote-mp', manifest: 'package.json' },
]

/** 伞仓自己不对外发版，不参与版本一致性。 */

/**
 * 把版本号拆成可比较的三元组。
 *
 * **预发布排在同版本的正式版之前**（semver 规定）：`1.0.0-rc.1 < 1.0.0`。
 * 不这么排的话，`latest` 从 `1.0.0-rc.1` 切到 `1.0.0` 时会被判成"倒退"。
 */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim())
  if (!m) throw new Error(`版本号形状不对：${JSON.stringify(v)}（要 x.y.z 或 x.y.z-tag）`)
  const [, major, minor, patch, pre] = m
  return { parts: [Number(major), Number(minor), Number(patch)], pre: pre ?? null }
}

export function formatVersion({ parts, pre }) {
  return `${parts.join('.')}${pre ? `-${pre}` : ''}`
}

/** a 是否严格大于 b。 */
export function isGreater(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (x.parts[i] !== y.parts[i]) return x.parts[i] > y.parts[i]
  }
  // 三元组相同：没有预发布标记的更大
  if (x.pre === y.pre) return false
  if (x.pre === null) return true
  if (y.pre === null) return false
  return x.pre > y.pre
}

/** npm 上某个包的全部已发布版本。 */
export function publishedVersions(pkg) {
  const out = execFileSync('npm', ['view', pkg, 'versions', '--json'], { encoding: 'utf8', maxBuffer: 1 << 24 })
  const parsed = JSON.parse(out)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/**
 * 下一个可用版本号：**大于**所有已发布版本，且两个包上都空着。
 *
 * @param {string[][]} perPackage 每个包已发布的版本
 * @param {{bumpMajor?: boolean}} [options]
 */
export function nextVersion(perPackage, options = {}) {
  const taken = new Set(perPackage.flat())
  // 从"所有已发布里最大的那个"往上找——而不是从 1.0.1 起步。
  // 这是 2.0.8 那个坑的正解：空着的号可能**比已发的还小**。
  let best = { parts: [0, 0, 0], pre: null }
  for (const v of taken) {
    const parsed = parseVersion(v)
    if (isGreater(formatVersion(parsed), formatVersion(best))) best = parsed
  }
  let parts = [...best.parts]
  if (options.bumpMajor) {
    parts = [parts[0] + 1, 0, 0]
  }
  for (let i = 0; i < 200; i += 1) {
    parts[2] += 1
    const candidate = formatVersion({ parts, pre: null })
    if (!taken.has(candidate)) return candidate
  }
  throw new Error('200 个连续版本号都被占用了——先查是不是 semver 解析出了问题')
}

function readManifest(repo, manifest) {
  return JSON.parse(readFileSync(path.join(ROOT, repo, manifest), 'utf8'))
}

function main(argv) {
  if (argv.includes('--check')) {
    const problems = []
    const versions = new Set()
    for (const entry of [...PUBLISHED, ...FOLLOWERS]) {
      const version = readManifest(entry.repo, entry.manifest).version
      versions.add(version)
      if (!PUBLISHED.some((p) => p.repo === entry.repo)) continue
      const taken = publishedVersions(entry.pkg)
      // ⚠️ 这里**不能**因为"还没发过"就 `continue`：2.0.8 在 control 上是空的
      // （当年 2.0.7 之后直接跳到 2.0.9），而它**小于**已发布的 2.0.13。
      // 第一版就写成 `if (!taken.includes(version)) continue`，于是这道闸**放行了 2.0.8**
      // ——恰好是它被写出来要防的那个坑。两件事各判各的，谁也不替谁短路。
      if (taken.includes(version)) {
        problems.push(
          `${entry.pkg}@${version} **已经发布过** —— npm 版本不可重用，换一个号（node scripts/next-version.mjs 拿建议）`,
        )
      }
      const greatest = taken.reduce((a, b) => (isGreater(b, a) ? b : a), taken[0])
      if (!isGreater(version, greatest)) {
        problems.push(
          `${entry.pkg}@${version} **不大于**已发布的最大版本 ${greatest} —— ` +
            '发出去等于版本号倒退：latest 会退回去，`^x.y.z` 的消费方拿不到',
        )
      }
    }
    if (versions.size > 1) {
      problems.push(`各仓版本号不一致：${[...versions].join(' / ')} —— 发版时它们必须同一个号`)
    }
    if (problems.length) {
      console.error('❌ 版本号过不了发版闸：\n')
      for (const p of problems) console.error('   ' + p)
      console.error('\n   建议：node scripts/next-version.mjs')
      return 1
    }
    console.log(`✅ 版本号可用：${[...versions].join(' / ')}`)
    return 0
  }

  const perPackage = PUBLISHED.map((entry) => publishedVersions(entry.pkg))
  const suggestion = nextVersion(perPackage, { bumpMajor: argv.includes('--major') })
  for (const [i, entry] of PUBLISHED.entries()) {
    const taken = perPackage[i]
    const greatest = taken.reduce((a, b) => (isGreater(b, a) ? b : a), taken[0])
    console.log(`${entry.pkg}：已发布 ${taken.length} 个，最大 ${greatest}`)
  }
  console.log(`\n→ 建议版本号：${suggestion}`)
  console.log('  （必须**大于**所有已发布版本，且两个包上都空着）')
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)))
}
