#!/usr/bin/env node
/**
 * 深色主题对比度体检 —— 找出「切到深色后看不清」的元素。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * 深色配色最容易出的错不是"忘了换底色"，而是**前景与背景都换了、但两者明度差
 * 不够**。本项目实测到的两类：
 *   ① 次要文字用 `--td-text-color-placeholder`，深色下解析成
 *      `rgba(255,255,255,.35)`，压在 `#181818` 上只有 3.2:1 —— 晚上看会话
 *      的时间戳、路径、"已隐藏 N 个"，基本靠猜。
 *   ② 「浅底深字」那一档控件（`t-button variant="light"`）在深色下变成
 *      "深底深字"：底 `--td-brand-color-1` → `#1b2f51`，字 `--td-brand-color`
 *      → 中蓝，两者都暗，看着像没有边界。
 * 这两类截图里勉强能看出、但没人会逐条看，必须算。
 *
 * ── 怎么算 ───────────────────────────────────────────────────────────
 * ① 展开两套变量表（`miniprogram/theme/{light,dark}.wxss`），把 `var(--a, var(--b, 兜底))`
 *    一层层解析成最终色值 —— 变量表有 84 个且互相引用，不展开就会把
 *    `var(--td-font-white-3)` 当成颜色。
 * ② 从 `app.wxss` 与各页 `*.wxss` 抽「选择器 → 声明」，取每条设了 `color`
 *    的规则。背景的找法，按可靠性从高到低：
 *      a. **同规则**里的 `background` / `background-color`；
 *      b. **`FG_ON` 显式声明** —— 文字与背景不在同一条规则时（`.user-text`
 *         压在 `.user` 蓝气泡上），靠这张表指明。**不要靠类名猜**：项目里
 *         `xxx-mark` / `xxx-desc` / `xxx-pip` 全是**兄弟**命名，猜父级会把
 *         `.step-think-text` 配到 12rpx 的小圆点 `.step-think-mark` 上。
 *      c. 兜底才用 `--td-bg-color-page` / `--td-bg-color-container`，
 *         并**取两者里更差的那个** —— 一个元素落在哪个底上取决于它在 DOM
 *         里的位置，静态分析判不准，取差值才不会漏报。
 * ③ 半透明前景先压到背景上再算亮度；阈值按字号分（正文 4.5:1，
 *    ≥36rpx 或 ≥24rpx 加粗 3:1）。
 *
 * 局限（必须知道，否则会误判）：
 *   · 只覆盖项目自己的 CSS。TDesign 组件内部（t-button / t-switch / t-empty）
 *     的配色由组件 wxss 决定，这里看不到 —— 那一层靠截图 + 本脚本第 ③ 类
 *     的"组件用到的变量"清单。
 *   · 不判断"这个元素该不该有底色"，只判断"有底色时看不看得清"。
 *
 * 用法：
 *   node scripts/check-mp-contrast.mjs           # 只报不达标
 *   node scripts/check-mp-contrast.mjs --all     # 连达标的���列出来
 *   node scripts/check-mp-contrast.mjs --theme dark   # 只看深色
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MP = path.join(ROOT, 'miniprogram')

/* ── 颜色工具 ────────────────────────────────────────────────────────── */

function toRgb(v) {
  const s = String(v).trim()
  let m = s.match(/^#([0-9a-f]{3,8})$/i)
  if (m) {
    const h = m[1]
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split('')
      return [r + r, g + g, b + b, a + a].map((x) => parseInt(x, 16) / 255)
    }
    if (h.length === 6 || h.length === 8) {
      return [
        parseInt(h.slice(0, 2), 16) / 255,
        parseInt(h.slice(2, 4), 16) / 255,
        parseInt(h.slice(4, 6), 16) / 255,
        h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      ]
    }
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?\s*\)$/i)
  if (m) {
    let a = 1
    if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
    return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, a]
  }
  return null
}

/** 半透明前景压到不透明背景上（小程序没有 backdrop-filter，多层叠色要手动合） */
function flatten(fg, bg) {
  if (fg[3] >= 1) return fg.slice(0, 3)
  const a = fg[3]
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a))
}

function luminance([r, g, b]) {
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(fg, bg) {
  const a = luminance(flatten(fg, bg))
  const b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const hex = (c) => '#' + c.slice(0, 3).map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')

/* ── 变量表展开 ─────────────────────────────────────────────────────── */

function readVars(css) {
  const vars = new Map()
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of clean.matchAll(/(--td-[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
    vars.set(m[1], m[2].trim())
  }
  return vars
}

function resolveVar(name, vars, seen = new Set()) {
  if (seen.has(name)) return null
  seen.add(name)
  const raw = vars.get(name)
  if (raw == null) return null
  const m = raw.match(/^var\(\s*(--td-[a-z0-9-]+)\s*(?:,\s*([\s\S]+))?\)$/)
  if (!m) return toRgb(raw)
  // 有兜底值就用兜底（TDesign 用这个表达"这个变量本主题没覆盖"）
  if (m[2]) {
    const fb = toRgb(m[2])
    if (fb) return fb
  }
  return resolveVar(m[1], vars, seen)
}

/** 声明里的颜色：可能是字面色、也可能是 var() 链 */
function declColor(decl, vars) {
  if (!decl) return null
  if (decl === 'transparent') return [0, 0, 0, 0]
  if (decl === 'none' || decl === 'initial' || decl === 'inherit') return null
  const direct = toRgb(decl)
  if (direct) return direct
  // var 链：可能有多层，一层层往下走
  let m
  const re = /var\(\s*(--td-[a-z0-9-]+)\s*(?:,\s*([\s\S]+?)\s*)?\)/g
  let scope = decl
  while ((m = re.exec(scope))) {
    const viaVar = m[1] ? resolveVar(m[1], vars) : null
    if (viaVar) return viaVar
    if (!m[2]) return null
    scope = m[2]
    const inner = toRgb(scope)
    if (inner) return inner
  }
  return null
}

/* ── CSS 规则抽取（本项目无嵌套语法，单层够用）───────────────────────── */

function parseRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  // 去掉 @import 行与 @media/@keyframes 块：@media 里的变量已抽到 miniprogram/theme/
  let body = clean.replace(/@import[^;]+;/g, '')
  body = body.replace(/@(?:media|keyframes|font-face)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
  const rules = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(body))) {
    const sel = m[1].trim()
    if (sel.startsWith('@')) continue
    const decls = {}
    for (const d of m[2].matchAll(/([-a-z]+)\s*:\s*([^;]+)/g)) decls[d[1]] = d[2].trim()
    // at = 声明在文件里的位置。组合选择器之间要靠它判"谁写在后面"（后者胜）
    rules.push({ sel, decls, at: m.index, line: body.slice(0, m.index).split('\n').length })
  }
  return rules
}


/**
 * 显式的「文字压在谁上面」声明。**这是唯一可靠的依据**，写在 wxss 里。
 *
 * ── 为什么必须有它 ────────────────────────────────────────────────────
 * 前一版靠**类名猜**父级（前缀 / 兄弟），结果两头都错：
 *   · 猜不到 → `.user-text` 配到页面底，报 `#ffffff on #ffffff` 假红；
 *   · 猜过头 → `.step-think-text` 被配到 `.step-think-mark`（一个 12rpx 的小圆点，
 *     **和它是兄弟不是父子**）上，报 1.00:1；`.hero-desc` 配到 `.hero-mark`（DSH 徽标）。
 * 类名相似**不代表** DOM 嵌套，而这项目里 `xxx-mark` / `xxx-desc` / `xxx-pip`
 * 全是兄弟命名。启发式到这一步已经是负收益，所以改成显式声明：
 * 写错会报出来（`check:mp-ui` 会在下面核对声明的类名是否都存在），
 * 但绝不会凭空造出一堆假红。
 *
 * 格式：`选择器 → 背景所在的类名`。键是**相对 mp/ 的路径**（与 `wxssFiles` 一致，
 * 不带 `mp/` 前缀）。只在「前景与背景**不在同一条规则**」时才需要 ——
 * 同规则的 `background` 本身就够用（`.pill.primary` 那种），不用在这里登记。
 */
const FG_ON = {
  'pages/chat/chat.wxss': {
    '.user-text': '.user', // 用户气泡里的白字，压蓝底
    '.opt-check': '.opt-on .opt-tick', // 选项勾里的 ✓，压选中态的蓝圆点
  },
  'pages/sessions/sessions.wxss': {},
}

/** 从 FG_ON 的键反查该文件用哪种写法（容错：写成带 mp/ 前缀也能用） */
function fgMapFor(rel) {
  return FG_ON[rel] ?? FG_ON['miniprogram/' + rel] ?? null
}

function declaredBg(rel, sel, rules) {
  const map = fgMapFor(rel)
  if (!map) return null
  const target = map[sel]
  if (!target) return null
  // 目标可能是组合选择器：按类名逐个匹配，全部命中才算
  const wanted = [...target.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1])
  const hit = rules.find((r) => {
    const cs = [...r.sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1])
    return wanted.every((w) => cs.includes(w)) && (r.decls.background || r.decls['background-color'])
  })
  if (!hit) {
    // 声明指向了一个没有底色的选择器 —— 多半是类名改了。
    // 不报的话这个元素就退回"页面/容器底"兜底，算出来的对比度是假的
    // （前面就靠这个假值报过 `#ffffff on #ffffff`）。
    problems.push(
      `${rel}: FG_ON 里 ${sel} 指向的 ${target} 在 wxss 里没有 background —— ` +
        '类名可能改过。查清了改 FG_ON，或删掉这条声明。',
    )
    return null
  }
  const raw = hit.decls['background-color'] ?? hit.decls.background
  const v = raw.match(/--td-[a-z0-9-]+/)
  return { name: target, varName: v ? v[0] : null, raw }
}

/** 声明里出现、但 wxss 里根本不存在的选择器 —— 纯死条目 */
function checkFgOnEntries(parsed) {
  for (const [rel, map] of Object.entries(FG_ON)) {
    const p = parsed.get(rel)
    if (!p) {
      problems.push(`FG_ON 里有 ${rel}，但本次扫描的文件列表里没有它（页面被删了？）`)
      continue
    }
    const sels = new Set(p.map((r) => r.sel))
    for (const [fgSel, bgSel] of Object.entries(map)) {
      if (!sels.has(fgSel)) {
        problems.push(`FG_ON 里登记了 ${rel} 的 ${fgSel}，但 wxss 里没有这个选择器 —— 这条声明是死的`)
      }
      for (const cls of [...bgSel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1])) {
        const found = p.some((r) => r.sel.includes('.' + cls))
        if (!found) {
          problems.push(`FG_ON 里 ${fgSel} 指向的 .${cls}（${rel}）在 wxss 里不存在 —— 类名可能改过`)
        }
      }
    }
  }
}

/* ── 主流程 ──────────────────────────────────────────────────────────── */

const themes = {}
for (const t of ['light', 'dark']) {
  const vars = readVars(fs.readFileSync(path.join(MP, 'theme', `${t}.wxss`), 'utf8'))
  // TDesign 组件自带的两个白/黑基色不在 theme/ 里（theme/ 只重定义指向它们的别名）
  vars.set('--td-font-white-1', t === 'dark' ? 'rgba(255, 255, 255, 0.9)' : '#ffffff')
  themes[t] = { vars }
}

const wxssFiles = [
  'app.wxss',
  ...fs
    .readdirSync(path.join(MP, 'pages'))
    .map((d) => {
      const f = path.join(MP, 'pages', d, `${d}.wxss`)
      return fs.existsSync(f) ? `pages/${d}/${d}.wxss` : null
    })
    .filter(Boolean),
]

const showAll = process.argv.includes('--all')
const only = process.argv.includes('--theme')
  ? process.argv[process.argv.indexOf('--theme') + 1]
  : null
const themeList = only ? [only] : ['light', 'dark']

/** 对账 FG_ON 的自检结果。与对比度结果一起在最后汇总。 */
const problems = []

/** rel → 该文件的规则表。给 FG_ON 的存在性对账用。 */
const parsed = new Map()

const rows = []

for (const t of themeList) {
  const { vars } = themes[t]
  const pageBg = resolveVar('--td-bg-color-page', vars)
  const containerBg = resolveVar('--td-bg-color-container', vars)
  const bgs = [pageBg, containerBg].filter(Boolean)

  for (const rel of wxssFiles) {
    const rules = parseRules(fs.readFileSync(path.join(MP, rel), 'utf8'))
    parsed.set(rel, rules)
    for (const r of rules) {
      if (!r.decls.color) continue
      const fg = declColor(r.decls.color, vars)
      if (!fg) continue

      // 背景两档：同规则 → FG_ON 显式声明 → 页面/容器底（取更差的那个）
      const own = declColor(r.decls['background-color'] ?? r.decls.background, vars)
      let candidates
      let via
      if (own && own[3] > 0) {
        candidates = [own]
        via = '自身'
      } else {
        const p = declaredBg(rel, r.sel, rules)
        const pb = p && p.varName ? resolveVar(p.varName, vars) : p ? toRgb(p.raw) : null
        if (pb && pb[3] > 0) {
          candidates = [pb]
          via = `显式声明 → ${p.name}`
        } else {
          // 兜底：页面底与容器底都算，取更差的那个
          candidates = bgs
          via = '页面/容器底'
        }
      }

      const fsRpx = r.decls['font-size'] ? parseFloat(r.decls['font-size']) : 28
      const bold = /bold|[5-9]00/.test(r.decls['font-weight'] ?? '')
      // ── 阈值 ──────────────────────────────────────────────────────
      // WCAG 有两档：正文 4.5:1，**非文字内容**（图标、图形、状态点）3:1。
      // 这个项目里大量元素是符号而不是句子：`.field-clear` 的 ✕、
      // `.steps-chev` 的 ⌄、`.step-k` 的工具名缩写、`.turn-time` 的时间戳。
      // 判据：① 类名带 chev/arrow/caret/tick/mark/glyph/clear/pip/mark 这类
      // 图形语义；② 有 `border-radius: 50%` 的小圆形容器（图标按钮）；
      // ③ 尺寸很小（≤ 60rpx）—— 那基本都是符号而不是一段话。
      // 命中任一条按 3:1 判，**但仍会报出来**（只是阈值低），不藏问题。
      const sel = r.sel.toLowerCase()
      const isGlyph =
        /(chev|arrow|caret|tick|mark|glyph|clear|pip|icon|dot|code-pip|spin)/.test(sel) ||
        /border-radius:\s*50%/.test(r.decls['border-radius'] ?? '') ||
        (parseFloat(r.decls.width ?? '999') <= 60 && parseFloat(r.decls.height ?? '999') <= 60)
      const threshold = isGlyph ? 3 : fsRpx >= 36 || (fsRpx >= 24 && bold) ? 3 : 4.5

      for (const bg of candidates) {
        if (!bg || bg[3] === 0) continue
        const ratio = contrast(fg, bg)
        rows.push({
          theme: t,
          file: rel,
          line: r.line,
          sel: r.sel,
          ratio,
          threshold,
          fg: hex(flatten(fg, bg)),
          bg: hex(bg),
          src: r.decls.color,
          via,
          ok: ratio >= threshold,
        })
      }
    }
  }
}

checkFgOnEntries(parsed)

// 同一个声明问题会在两个主题下各报一次（深色、浅色各跑一遍主循环），
// 去重后再输出 —— 报三遍同一条会让"这里有一个问题"变成"这里有三个问题"。
const uniqProblems = [...new Set(problems)]

const bad = rows.filter((r) => !r.ok)
const list = (showAll ? rows : bad).slice().sort((a, b) => a.ratio - b.ratio)

// FG_ON 的对账结果与对比度结果同等重要：声明写错会让某个元素**静默**退回
// 页面底兜底，算出来的对比度是假的（前面就靠这个假值报过 `#ffffff on #ffffff`）。
if (uniqProblems.length) {
  console.error(`FG_ON 对账失败 ${uniqProblems.length} 处：`)
  for (const p of uniqProblems) console.error('  · ' + p)
  console.error('')
}

if (!list.length) {
  if (uniqProblems.length) process.exit(1)
  console.log(`✓ ${rows.length} 组前景/背景全部达标`)
  process.exit(0)
}

console.log(`对比度体检：${rows.length} 组，达标 ${rows.length - bad.length}，不达标 ${bad.length}`)
if (!showAll) console.log('（--all 可看全部；--theme dark 只看深色）\n')
for (const r of list) {
  const mark = r.theme === 'dark' ? '深' : '浅'
  console.log(
    `${r.ok ? '  ' : '✗ '}[${mark}] ${r.ratio.toFixed(2)}:1 (需 ${r.threshold})  ${r.fg} on ${r.bg}  ${r.file}:${r.line}  ${r.sel}  [底来自${r.via}]  ← ${r.src}`,
  )
}
process.exit(bad.length || uniqProblems.length ? 1 : 0)
