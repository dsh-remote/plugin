#!/usr/bin/env node
/**
 * mp 代码注入面分析（按需注入 / 用时注入）
 *
 * 为什么需要它：
 *   `lazyCodeLoading: "requiredComponents"` 只影响**注入执行**的代码量，
 *   **不影响包体积**——所以 `pnpm mp:upload` 的体积数字看不出任何变化，
 *   很容易误判成"开了没用"。这个小程序要把"哪些模块还在被注入"算清楚。
 *
 * 口径：
 *   - off：主包所有 JS 被合并注入并立刻执行（app + 全部页面 + 全部组件）
 *   - on ：app.js 可达模块 + 当前页 JS + 当前页声明的组件树（递归 usingComponents）
 *          + 上述 JS 里 require() 到的本地模块
 *   只统计 .js（真正被"注入执行"的东西）；wxml/wxss 不进这个口径。
 *
 * 用法：
 *   node scripts/mp-lazyload-report.mjs            # 全部页面
 *   node scripts/mp-lazyload-report.mjs sessions   # 只看某页
 *   node scripts/mp-lazyload-report.mjs --json     # 机器可读
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 小程序现在是独立仓 `dsh-remote-mp`，`app.json` / `pages/` 这些都在它的 `miniprogram/` 下。
const MP = path.resolve(fileURLToPath(new URL('../dsh-remote-mp/miniprogram', import.meta.url)))
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const onlyPage = args.find((a) => !a.startsWith('-'))

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const exists = (p) => fs.existsSync(p)

/** 小程序路径（/@ 或相对）→ 绝对路径（不带扩展名） */
function resolveSpecifier(spec, fromDir) {
  let base
  if (spec.startsWith('/')) base = path.join(MP, spec.slice(1))
  else if (spec.startsWith('.')) base = path.resolve(fromDir, spec)
  else return null // npm 裸包名：本项目组件不这么引，忽略
  return base
}

/** 找组件基名：/x/button/button → /x/button/button（存在 .json 即认） */
function asComponent(base) {
  return base && exists(base + '.json') ? base : null
}

/**
 * 收集一个组件的注入树。
 * 微信的注入单位是「组件」：usingComponents 声明的每个组件都会被注入并执行，
 * 所以这里沿 usingComponents 递归。
 */
function collectComponents(rootSpec, fromDir, out, seen) {
  const base = asComponent(resolveSpecifier(rootSpec, fromDir))
  if (!base) return
  const key = path.relative(MP, base)
  if (seen.has(key)) return
  seen.add(key)

  const cfg = readJson(base + '.json')
  out.set(key, { json: cfg, base })

  for (const child of Object.values(cfg.usingComponents || {})) {
    collectComponents(child, path.dirname(base), out, seen)
  }
}

/** 沿 JS 里 require('./x') 的本地引用递归，收集会被执行到的模块 */
function collectJs(spec, fromDir, out, seen) {
  let base = null
  if (spec.startsWith('/')) base = path.join(MP, spec.slice(1))
  else if (spec.startsWith('.')) base = path.resolve(fromDir, spec)
  else return
  let file = null
  if (exists(base) && fs.statSync(base).isFile()) file = base // 已带扩展名
  else if (exists(base + '.js')) file = base + '.js'
  else if (exists(path.join(base, 'index.js'))) file = path.join(base, 'index.js')
  else return
  if (seen.has(file)) return
  seen.add(file)
  out.add(file)
  for (const dep of requiresIn(file)) collectJs(dep, path.dirname(file), out, seen)
}

const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g
function requiresIn(file) {
  const src = fs.readFileSync(file, 'utf8')
  return [...src.matchAll(reqRe)].map((m) => m[1])
}

const size = (p) => (exists(p) ? fs.statSync(p).size : 0)
const kb = (n) => (n / 1024).toFixed(1)

// ── 入口 ────────────────────────────────────────────────────────────────
const appJson = readJson(path.join(MP, 'app.json'))
const pages = (appJson.pages || []).filter((p) => !onlyPage || p.includes(onlyPage))

// off：主包全部 JS
const allJs = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.js')) allJs.push(p)
  }
})(MP)

/** 全局 usingComponents（app.json）——会算进每一页 */
const globalComps = appJson.usingComponents || {}

const report = { lazyCodeLoading: appJson.lazyCodeLoading || null, pages: [] }

for (const page of pages) {
  const pageCfg = readJson(path.join(MP, `${page}.json`))
  const isSub = pageCfg.component === true

  // on：app.js 可达 + 该页 js 可达
  const jsFrontier = new Set()
  const jsSeen = new Set()
  collectJs('/app.js', MP, jsFrontier, jsSeen)
  if (!isSub) collectJs(`/${page}.js`, MP, jsFrontier, jsSeen)

  // on：组件树（全局声明 + 本页声明）
  const comps = new Map()
  const compSeen = new Set()
  const fromDir = path.dirname(path.join(MP, page))
  for (const spec of Object.values(globalComps)) collectComponents(spec, fromDir, comps, compSeen)
  for (const spec of Object.values(pageCfg.usingComponents || {})) {
    collectComponents(spec, fromDir, comps, compSeen)
  }

  // 组件自己的 JS 及其 require
  for (const { base } of comps.values()) {
    if (exists(base + '.js')) collectJs(base + '.js', path.dirname(base), jsFrontier, jsSeen)
  }

  const onJs = [...jsFrontier]
  const onBytes = onJs.reduce((a, p) => a + size(p), 0)

  // 用时注入：配了 componentPlaceholder 的组件在首屏渲染前不注入
  const placeheld = Object.keys(pageCfg.componentPlaceholder || {})
  const deferred = placeheld
    .map((name) => {
      const spec = (pageCfg.usingComponents || {})[name]
      const base = spec && asComponent(resolveSpecifier(spec, fromDir))
      if (!base) return null
      const sub = new Map()
      const subSeen = new Set()
      collectComponents(spec, fromDir, sub, subSeen)
      const bytes = [...sub.values()].reduce((a, { base }) => a + size(base + '.js'), 0)
      return { name, dir: path.relative(MP, base), comps: sub.size, bytes }
    })
    .filter(Boolean)

  const compBytes = [...comps.values()].reduce((a, { base }) => a + size(base + '.js'), 0)
  const deferredBytes = deferred.reduce((a, d) => a + d.bytes, 0)

  report.pages.push({
    page,
    onJsFiles: onJs.length,
    onBytes,
    componentCount: comps.size,
    componentBytes: compBytes,
    components: [...comps.keys()].sort(),
    placeheld,
    deferred,
    deferredBytes,
    firstPaintBytes: onBytes - deferredBytes,
  })
}

const offBytes = allJs.reduce((a, p) => a + size(p), 0)

/** 主包 JS 按来源分组——用来回答"省掉的到底是什么" */
function origin(p) {
  const rel = path.relative(MP, p)
  if (rel.startsWith('miniprogram_npm/')) return 'miniprogram_npm (TDesign)'
  if (rel.startsWith('pages/')) return 'pages'
  if (rel.startsWith('core/')) return 'core'
  return '根目录 (app.js)'
}
const offGroups = new Map()
for (const p of allJs) {
  const g = origin(p)
  const cur = offGroups.get(g) || { n: 0, bytes: 0 }
  offGroups.set(g, { n: cur.n + 1, bytes: cur.bytes + size(p) })
}

if (asJson) {
  console.log(JSON.stringify({ offBytes, offFiles: allJs.length, ...report }, null, 2))
} else {
  console.log(`lazyCodeLoading = ${report.lazyCodeLoading || '(未配置)'}\n`)
  console.log(`关闭按需注入：${kb(offBytes)} KB / ${allJs.length} 个 JS 全部注入并执行`)
  for (const [g, v] of [...offGroups].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${g.padEnd(28)} ${kb(v.bytes).padStart(7)} KB / ${v.n} 个`)
  }
  console.log('\u2500'.repeat(64))
  for (const p of report.pages) {
    const saved = offBytes - p.onBytes
    console.log(`\n▶ 开启后进入 ${p.page}`)
    console.log(`  注入模块   ${p.onJsFiles} 个 / ${kb(p.onBytes)} KB`)
    console.log(`  比关闭少   ${kb(saved)} KB  (${((saved / offBytes) * 100).toFixed(1)}%)`)
    console.log(`  组件树     ${p.componentCount} 个 / 组件 JS ${kb(p.componentBytes)} KB`)
    console.log(`             ${p.components.join(', ')}`)
    if (p.placeheld.length) {
      console.log(`  用时注入   ${p.placeheld.join(', ')}`)
      for (const d of p.deferred) {
        console.log(`             ${d.name} → ${d.comps} 个组件 / ${kb(d.bytes)} KB 延后`)
      }
      console.log(`  首屏注入   ${kb(p.firstPaintBytes)} KB`)
    }
  }
  console.log(`\n${'\u2500'.repeat(64)}`)
  console.log('提示：上面是"注入执行"的量，不是包体积——开这个特性包大小不会变。')
}
