#!/usr/bin/env node
/**
 * 生成 miniprogram/theme/ 下的主题变量表 —— `light.wxss`（默认）与 `dark.wxss`（切暗色时叠加）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * TDesign 的 `common/style/theme/_index.wxss` 把浅色和深色**两套变量都包在
 * `@media (prefers-color-scheme)` 里**，跟随系统。本项目的主题是**用户手动切**的
 * （默认浅色，可切深色），不是跟随系统，所以两套都得能脱离 `@media` 独立生效。
 *
 * 做法：把两段分支各自抽出来、剥掉 `@media` 外壳，交给 `app.wxss` 叠加使用：
 *   · `light.wxss` 选择器保持 `.page,page` —— **无条件生效**，与 `page` 元素同源，
 *     任何页面不切主题时都是浅色（默认态）。
 *   · `dark.wxss` 选择器改成 `.theme-dark, .theme-dark page` —— **只挂在页面根容器上**。
 *     变量会向下继承给整棵子树，所以给根 view 加一个 class 就等于整页换肤。
 *
 * ── 为什么深色挂在 class 上而不是继续用「同特异性靠源码顺序压」──────────
 * 之前固定浅色就是靠「`app.wxss` 在 `_index.wxss` 之后 import，压掉深色分支」。
 * 但那是**单向**的：只能压深色、没法再切回来。要做双向切换，就必须让两套变量
 * 各自有独立的生效条件 —— class 是唯一能做到的（`prefers-color-scheme` 是系统的意思，
 * 与「用户点了按钮」无关）。所以浅色留在 `page`（默认）、深色挂 class（按需叠加），
 * 两者靠「深色类名存在与否」区分，互不覆盖。
 *
 * ── 为什么用脚本而不是手抄 ───────────────────────────────────────────
 * 那份变量表是几 KB 的单行 CSS，手抄必漏，漏掉的变量就会退回浅色值（深色下"某一块
 * 变成白底"就是这么来的）。TDesign 升级后重跑一次即可。`--check` 在 CI 里发现
 * "忘了重新生成"。
 *
 * ── 深色表缺的那两个变量 ─────────────────────────────────────────────
 * TDesign 的深色分支**没有** `--td-shadow-4` 与 `--td-scrollbar-hover-color`
 * （实测 2026-10-02，136 个浅色变量 vs 140 个深色变量，这 2 个只在浅色里）。
 * 不补的话，深色下用到它们的地方会退回**继承浅色时的值**（因为浅色表挂在 `page` 上，
 * 仍会继承下来），表现为"深色里有一块浅色阴影"。这里按深色的观感补齐。
 *
 * ── 深色"可读性修正"（DARK_READABILITY）─────────────────────────────
 * TDesign 的深色表是给**大屏 Web** 调的，底色更浅（它的 `--td-bg-color-page`
 * 在深色分支下相当于中灰）。本项目是小屏手机屏，字号本来就小、深色底本来就
 * 更深，于是几个关键变量在真机上明显偏暗。实测（见 scripts/check-mp-contrast.mjs）：
 *
 *   变量                            浅色 →  压 #242424   深色原值 → 压 #242424
 *   --td-text-color-placeholder      #000/.4 →  2.81:1     #fff/.35  →  3.16:1
 *   --td-text-color-disabled         #000/.26 →  2.10:1     #fff/.22  →  2.51:1
 *   --td-brand-color                 #0052d9 →  4.13:1(容器) #4582e6 →  4.13:1
 *   --td-error-color-6               #d54941 →  3.99:1(浅红底) #c64751 →  2.88:1
 *
 * 前两个是"次要文字"（时间戳、路径、占位符、note）—— 用量最大，深色下几乎
 * 靠猜。后三个是"彩色字压彩色底"，深色下两端的明度差都比浅色小。
 *
 * 修法是**只调 alpha / 只换更亮的同色系值**，不重排色阶：色阶一动，
 * 组件内部的搭配（t-button 各种 variant）就全乱了。要保住的是
 * "primary 比 secondary 亮、secondary 比 placeholder 亮"这个序。
 * `DARK_READABILITY_CHECK` 会在生成时验一遍这个序，破了就报错。
 *
 * 用法：
 *   node scripts/gen-mp-theme.mjs           # 写入
 *   node scripts/gen-mp-theme.mjs --check   # 只比对，不同步则退出码 1
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(
  ROOT,
  'miniprogram/miniprogram_npm/tdesign-miniprogram/common/style/theme/_index.wxss',
)

/** TDesign 深色分支漏掉的变量。深色下必须给值，否则会继承浅色表的同名值。 */
const DARK_ONLY_FIXUPS = [
  // 深色底上的阴影要用更浅一点的**中性**阴影才看得出层次（黑上加黑等于没加）
  ['--td-shadow-4', '0 2px 8px 0 rgba(0, 0, 0, 0.35)'],
  ['--td-scrollbar-hover-color', 'rgba(255, 255, 255, 0.26)'],
]

/**
 * 深色"可读性修正"：TDesign 给的深色值在小屏手机上偏暗，压不住。
 *
 * 每一项都标了**实测对比度**（WCAG，正文阈值 4.5:1，底色取深色下真实会碰到的
 * 那几个：页面底 #181818 / 卡片底 #242424 / 组件底 #383838）。
 * 数字不是估的，是 `scripts/check-mp-contrast.mjs` 算出来的，改完请重跑它。
 *
 * 只调 alpha 或换同色系更亮的一档，**不重排色阶** —— 色阶一动，TDesign 组件
 * 内部的搭配（t-button 的各种 variant）就全乱了。要保住的序是
 * primary > secondary > placeholder > disabled，下面 `checkReadabilityOrder` 会验。
 */
const DARK_READABILITY = [
  // 次要文字：时间戳、路径、占位符、系统提示、note。这一档用量最大，
  // 深色下 0.35 压 #242424 只有 3.16:1，晚上基本靠猜 → 提到 0.5（4.96:1）
  ['--td-text-color-placeholder', 'rgba(255, 255, 255, 0.5)', '3.16 → 4.96'],
  // disabled：置灰的按钮与"没连上"状态。0.22 只有 2.06:1，看不出是"灰"还是"看不清"
  // → 0.4（3.70:1）。它本来就该弱于 placeholder，所以不追 4.5。
  ['--td-text-color-disabled', 'rgba(255, 255, 255, 0.4)', '2.06 → 3.70'],
  // ── 语义色的 -6 档作前景（.pill.danger / .act-danger / .step-tick.failed）──
  // 压自己的 -1 深底时两端都暗。逐个提到 ≥4.5。
  ['--td-error-color-6', '#e8757d', '2.88 → 4.74'],
  ['--td-warning-color-6', '#e8894d', '3.97 → 4.83'],
  ['--td-success-color-6', '#52c29d', '4.61 → 5.69'],
]

/**
 * 新增一个变量：`--td-brand-color-on-tint` —— **品牌色作为前景、且压在品牌浅底上**
 * 时该用的颜色。
 *
 * ── 为什么必须新开一个，不能直接调亮 `--td-brand-color` ──────────────
 * `--td-brand-color` 在本项目扛**两个互斥的角色**：
 *   · 当**底色**（用户气泡、t-button--primary、DSH 徽标）→ 要**够暗**，
 *     压 `--td-text-color-anti` 的白字才够 4.5:1；
 *   · 当**字色**（.pill.primary、.section-action、.sess-badge.primary）→
 *     压在 `--td-brand-color-1` 浅底上，要**够亮**。
 * 这两个要求在数学上无解（实测：作底色需亮度 ≤0.163，作字需 ≥0.304，
 * 没有任何一个蓝色同时满足）。中途试过直接把它调亮到 #6b9dec ——
 * 字色那侧修好了，底色那侧白字从 3.43:1 掉到 2.51:1，用户气泡直接看不清。
 *
 * 所以拆开：底色那一侧继续用 `--td-brand-color`（TDesign 原值 #4582e6，
 * 白字 3.43:1 —— 见 `DARK_BRAND_BG`，那个要单独修），字色这一侧改用本变量。
 * 浅色主题里两者同值（#0052d9），所以 wxss 里换过去不影响浅色观感。
 */
const BRAND_ON_TINT = '--td-brand-color-on-tint'

/**
 * 深色下 `--td-brand-color` 作**底色**时的取值。
 *
 * TDesign 的深色品牌色 #4582e6 亮度偏高，白字压它只有 3.43:1 —— 这是本项目
 * 自己的问题（TDesign 面向大屏，字号大、对比要求低），必须压暗。
 * 往下调到 #2667d4（primary-color-7）：白字 4.83:1 达标，且仍是明确的蓝。
 *
 * 注意这会让 t-button--primary 的底色变深一点：深色下按钮本来就是深底，
 * 再深一档不影响观感，但**白字更清楚了**，这才是要的。
 */
/**
 * 深色下 `--td-brand-color` 作**底色**时的取值。**单元素数组**而不是裸三元组 ——
 * 形状与 `DARK_READABILITY` 保持一致，两边就能用同一个 `[...A, ...B]` 展开。
 * （曾经写成裸三元组，展开时被摊平成三个字符串，产出的 CSS 整条作废。）
 *
 * TDesign 的深色品牌色 #4582e6 亮度偏高，白字压它只有 3.43:1 —— 这是本项目
 * 自己的问题（TDesign 面向大屏，字号大、对比要求低），必须压暗。
 * 往下调到 #2667d4（primary-color-7）：白字 4.83:1 达标，且仍是明确的蓝。
 * 深色下按钮本来就是深底，再深一档不影响观感，但**白字更清楚了**。
 */
const DARK_BRAND_BG = [['--td-brand-color', '#2667d4', '3.43 → 4.83（压白字）']]
/**
 * `${BRAND_ON_TINT}` 在深色下的取值。浅色那边同值（#0052d9），所以 wxss 里
 * 无条件用这个变量、浅色观感不变。实测：压 brand-1 浅底 4.87:1、压卡片底 5.66:1。
 */
const DARK_BRAND_ON_TINT = '#6b9dec'

/**
 * 浅色侧同样的可读性修正。
 *
 * 深色那侧的问题在深色更明显，但浅色**也不达标**：TDesign 的 placeholder 是
 * `rgba(0,0,0,.4)`，压页面底 `#f3f3f3` 只有 2.81:1。这一档是"次要文字"里用量最大的
 * —— 会话时间戳、工作区路径、占位符、系统 note、"已隐藏 N 个"，在户外阳光下
 * 基本看不清。提到 `rgba(0,0,0,.54)` → 4.48:1。
 *
 * disabled 提到 0.4（2.81:1）。它本来就该弱于 placeholder（"置灰"是语义），
 * 所以不追 4.5 —— 4.5 的正文阈值是用来判**能不能读**的，而 disabled 的意思
 * 恰恰是"现在不该读"。
 */
const LIGHT_READABILITY = [
  // 0.56 而不是更高的值：这是**三个底都过 4.5 的最小改动**
  // （压页面底 4.81 / 卡片底 4.94 / 组件底 4.67）。再往上走会让这一档
  // 追上 secondary（0.6），"次要文字"与"辅助说明"就分不出层次了。
  ['--td-text-color-placeholder', 'rgba(0, 0, 0, 0.56)', '2.81 → 4.81'],
  ['--td-text-color-disabled', 'rgba(0, 0, 0, 0.4)', '1.87 → 2.81'],
  // 语义色的 -6 档压自己的 -1 浅底（.pill.success / .step-tick.completed /
  // .act-danger / .sess-badge.warning）。TDesign 给的浅色值都只差一点：
  // 4.07 / 3.90 / 4.09。各调暗一档就到 4.5 以上，改动幅度小到看不出色相变化。
  ['--td-success-color-6', '#007a4e', '4.07 → 4.88'],
  ['--td-error-color-6', '#c93c34', '3.90 → 4.53'],
  ['--td-warning-color-6', '#a84f00', '4.09 → 5.02'],
]

/** 把 `@media (prefers-color-scheme:<kind>){ … }` 的 body 逐个抠出来（按花括号配平） */
function extractBlocks(css, kind) {
  const blocks = []
  const re = new RegExp('@media\\s*\\(prefers-color-scheme\\s*:\\s*' + kind + '\\)\\s*\\{', 'g')
  let m
  while ((m = re.exec(css))) {
    let i = re.lastIndex
    let depth = 1
    const start = i
    while (i < css.length && depth > 0) {
      const ch = css[i]
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      i += 1
    }
    if (depth !== 0) throw new Error('花括号没有配平，TDesign 的产物结构变了？')
    const body = css.slice(start, i - 1).trim()
    if (body) blocks.push(body)
    re.lastIndex = i
  }
  return blocks
}

/** 把块里 `.page,page` 这个选择器换成别的（深色要挂到 class 上） */
function retarget(css, from, to) {
  return css.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), to)
}

/** 收集块里定义过的变量名 */
function varNames(blocks) {
  const names = new Set()
  for (const b of blocks) for (const m of b.matchAll(/--td-[a-z0-9-]+(?=\s*:)/g)) names.add(m[0])
  return names
}

const src = fs.readFileSync(SRC, 'utf8')
const lightBlocks = extractBlocks(src, 'light')
const darkBlocks = extractBlocks(src, 'dark')
if (!lightBlocks.length) throw new Error(`没在 ${path.relative(ROOT, SRC)} 里找到浅色分支`)
if (!darkBlocks.length) throw new Error(`没在 ${path.relative(ROOT, SRC)} 里找到深色分支`)

// 深色补齐：TDesign 深色分支缺的变量，显式给值。
// 放在**所有深色块之后**的独立一段里，顺序上自然覆盖浅色表的继承值。
const darkFixupCss = `.theme-dark, .theme-dark page {${DARK_ONLY_FIXUPS.map(
  ([k, v]) => `${k}:${v};`,
).join('')}}`

// 深色可读性修正：同样放在最后，压过 TDesign 的深色原值。
//
// 三者形状一致（DARK_BRAND_BG / DARK_READABILITY / DARK_ONLY_FIXUPS 都是
// 「三元组数组」），所以 `[...A, ...B]` 是安全的。之前 `DARK_BRAND_BG` 是**裸三元组**，
// 展开时被摊平成三个字符串 → 模板拿到 '-:-' 当变量名 →
// 产出 `.theme-dark{-:-;#:2;3:.;…}`，这段非法声明让**整条规则作废**，
// 同规则里的 placeholder 与语义色修正跟着一起失效 —— 静默的，肉眼看不出来。
// 现在形状统一了；`checkCssSanity` 负责兜住这类事故。
const darkReadableCss = `/* 可读性修正（TDesign 深色值在小屏上偏暗，实测对比度见上） */
.theme-dark, .theme-dark page {${[...DARK_BRAND_BG, ...DARK_READABILITY]
  .map(([k, v]) => `${k}:${v};`)
  .join('')}${BRAND_ON_TINT}:${DARK_BRAND_ON_TINT};}`

/* ── 色阶序校验：primary > secondary > placeholder > disabled ──────────
   修正 alpha 时最容易犯的错是把某一档调得比上一档还亮，于是"占位符比正文还
   显眼"。这里在生成时就算一遍，破了直接报错 —— 靠肉眼看截图是看不出来的
   （两档都是灰白，差 5% 亮度在手机上几乎无法分辨）。

   浅色与深色**都要验**：两边的修正表是分开的，改了一边忘了另一边是很容易的。 */
function checkReadabilityOrder(blocks, fixups, bgHex, label) {
  const toRgb = (v) => {
    const s = String(v).trim()
    let m = s.match(/^#([0-9a-f]{3,8})$/i)
    if (m) {
      const h = m[1]
      if (h.length === 3 || h.length === 4) {
        const [r, g, b, a] = h.split('')
        return [r + r, g + g, b + b, a + a].map((x) => parseInt(x, 16) / 255)
      }
      return [
        parseInt(h.slice(0, 2), 16) / 255,
        parseInt(h.slice(2, 4), 16) / 255,
        parseInt(h.slice(4, 6), 16) / 255,
        h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      ]
    }
    m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?\s*\)$/i)
    if (m) {
      let a = 1
      if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
      return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, a]
    }
    return null
  }
  const lum = ([r, g, b]) => {
    const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const bg = toRgb(bgHex)

  // 该主题分支的全部变量：TDesign 原值 + 本脚本的修正（修正在后，覆盖原值）
  const values = new Map()
  for (const b of blocks) {
    for (const m of b.matchAll(/(--td-[a-z0-9-]+)\s*:\s*([^;}]+)/g)) values.set(m[1], m[2].trim())
  }
  for (const [k, v] of fixups) values.set(k, v)

  /** 把一层 var() 链解析到底；解析不出来返回 null（那就跳过这一档） */
  const resolve = (name, depth = 0) => {
    if (depth > 6) return null
    const raw = values.get(name)
    if (raw == null) return null
    const m = raw.match(/^var\(\s*(--td-[a-z0-9-]+)\s*(?:,\s*([\s\S]+))?\)$/)
    if (!m) return toRgb(raw)
    if (m[2]) {
      const fb = toRgb(m[2])
      if (fb) return fb
    }
    return resolve(m[1], depth + 1)
  }

  // ── 判据用「对比度递减」，不是「亮度递增/递减」 ──────────────────────
  // 直觉上两个主题方向相反：深色白字越往后越**暗**（primary .9 → disabled .4），
  // 浅色黑字越往后越**亮**（primary .9 → disabled .4，压在浅底上亮度反而升）。
  // 两次都写错过判据（先写死"递减"→ 浅色报三条假错；改成"深色递增"→ 深色
  // 报三条假错）。**唯一两边都成立的是"正文比次要文字更醒目"**，也就是
  // 对比度递减 —— WCAG 本来就是用对比度衡量可读性的，用它当判据最自然。
  const contrast = (fg, bg) => {
    const l1 = lum(flattenOn(fg, bg))
    const l2 = lum(bg)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }
  const flattenOn = (fg, bg) => (fg[3] >= 1
    ? fg.slice(0, 3)
    : [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])))

  const chain = [
    '--td-text-color-primary',
    '--td-text-color-secondary',
    '--td-text-color-placeholder',
    '--td-text-color-disabled',
  ]
  const problems = []
  for (let i = 1; i < chain.length; i++) {
    const pf = resolve(chain[i - 1])
    const cf = resolve(chain[i])
    if (!pf || !cf) continue // 解析不出来的档位跳过，不误报
    const a = contrast(pf, bg)
    const b = contrast(cf, bg)
    if (b >= a) {
      problems.push(
        `${chain[i]}（对比度 ${b.toFixed(2)}:1）不比上一档 ${chain[i - 1]}（${a.toFixed(2)}:1）醒目`,
      )
    }
  }
  if (problems.length) {
    console.error(`${label}灰阶序被破坏（每一档都要比上一档更不醒目）：`)
    for (const p of problems) console.error('  · ' + p)
    process.exit(1)
  }
}

/**
 * 拼出来的 CSS 必须是**合法**的 —— 非法的一小段会让整条规则被解析器丢弃，
 * 连带同一规则里的其他修正全部静默失效。
 *
 * 真踩过：`DARK_BRAND_BG` 的元素写成两项而不是 `[名, 值, 备注]` 三元组，
 * 模板把"备注"当值拼进去，产出 `.theme-dark{…-:-;#:2;3:.;…}`。
 * 肉眼看源文件完全正常，生成物里那段也不显眼，但**整条规则作废** ——
 * 于是"修好了"的 placeholder 与语义色其实一个都没生效，
 * 只有那句注释还在说"已修正"。这里把这类错误挡在生成阶段。
 */
function checkCssSanity(name, css) {
  const problems = []
  for (const m of css.matchAll(/\{([^}]*)\}/g)) {
    for (const decl of m[1].split(';')) {
      const s = decl.trim()
      if (!s) continue
      if (!s.startsWith('--')) {
        problems.push(`规则里出现了不以 -- 开头的声明：${JSON.stringify(s.slice(0, 60))}`)
        continue
      }
      const c = s.indexOf(':')
      if (c < 0) {
        problems.push(`声明缺冒号：${JSON.stringify(s.slice(0, 60))}`)
        continue
      }
      const key = s.slice(0, c).trim()
      const val = s.slice(c + 1).trim()
      if (!/^--[a-z0-9-]+$/.test(key)) problems.push(`变量名不合法：${JSON.stringify(key)}`)
      if (!val) problems.push(`${key} 没有值`)
      // 值里含裸分号 / 花括号 = 拼接事故（三元组写成两项就会这样）
      if (/[;{}]/.test(val)) problems.push(`${key} 的值里有非法字符：${JSON.stringify(val.slice(0, 40))}`)
    }
  }
  const open = (css.match(/\{/g) ?? []).length
  const close = (css.match(/\}/g) ?? []).length
  if (open !== close) problems.push(`花括号没配平：${open} 个 { vs ${close} 个 }`)

  if (problems.length) {
    console.error(`${name} 生成的 CSS 不合法（会被解析器整条丢弃，且是静默的）：`)
    for (const p of problems) console.error('  · ' + p)
    process.exit(1)
  }
}

checkReadabilityOrder(
  darkBlocks,
  [...DARK_ONLY_FIXUPS, ...DARK_BRAND_BG, ...DARK_READABILITY],
  '#242424',
  '深色',
)
checkCssSanity('dark.wxss 的可读性修正段', darkReadableCss)

// 浅色也要声明 ${BRAND_ON_TINT}，值与 --td-brand-color 相同 ——
// 不声明的话浅色下这个变量不存在，wxss 里的 var() 会回退到兜底色，
// 而各处兜底色五花八门（有 #0052d9 有 #4582e6），浅色就会深浅不一。
// 可读性修正同样要落在浅色上：TDesign 的 placeholder 在浅色下也只有 2.81:1。
const lightBrandCss = `.page,page{${BRAND_ON_TINT}:var(--td-brand-color,#0052d9);${LIGHT_READABILITY.map(
  ([k, v]) => `${k}:${v};`,
).join('')}}`
checkCssSanity('light.wxss 的品牌字色与可读性修正段', lightBrandCss)

// 序校验：深色压深色卡片底 #242424，浅色压浅色页面底 #f3f3f3。
// 底选错会算出相反的结论（深色那套黑字公式在浅色上是反的）。
checkReadabilityOrder(
  lightBlocks,
  LIGHT_READABILITY,
  '#f3f3f3',
  '浅色',
)

const lightHeader = `/* 生成物，不要手改 —— 重新生成：node scripts/gen-mp-theme.mjs
 *
 * 来源：miniprogram/miniprogram_npm/tdesign-miniprogram/common/style/theme/_index.wxss
 * 作用：把 TDesign 的浅色变量从 @media (prefers-color-scheme:light) 里解放出来，
 *      无条件生效。选择器与 TDesign 一样是 .page,page，所以深色分支也被压掉了 ——
 *      系统是深色也一样是白底深字。
 *
 * 共 ${lightBlocks.length} 段。
 */
`

const darkHeader = `/* 生成物，不要手改 —— 重新生成：node scripts/gen-mp-theme.mjs
 *
 * 来源：miniprogram/miniprogram_npm/tdesign-miniprogram/common/style/theme/_index.wxss
 * 作用：深色主题变量。选择器从 TDesign 的 .page,page 换成 .theme-dark ——
 *      **挂在页面根容器的 class 上**，而不是 page 上。
 *
 * 为什么不能继续用 page：page 上已经挂着浅色表（那是默认态），两套都写 page
 * 就只能靠"源码顺序"决胜，而那是单向的 —— 压得住深色、切不回浅色。挂 class 之后
 * "用不用深色"由根容器的 class 说了算，与系统深色无关（这才是"用户手动切"）。
 *
 * 必须在 theme/light.wxss **之后** import：浅色表写在 page 上会向下继承，
 * 本文件靠"同特异性下靠后胜出"把它压掉。
 *
 * 共 ${darkBlocks.length} 段 + 1 段补齐（TDesign 深色分支缺 --td-shadow-4 与
 * --td-scrollbar-hover-color，不补会继承到浅色值，深色里就有一块浅色阴影）。
 */
`

const outputs = [
  {
    file: path.join(ROOT, 'miniprogram/theme/light.wxss'),
    content: lightHeader + lightBlocks.join('\n') + '\n' + lightBrandCss + '\n',
    desc: `浅色（默认）主题，${lightBlocks.length} 段`,
  },
  {
    file: path.join(ROOT, 'miniprogram/theme/dark.wxss'),
    content: darkHeader + darkBlocks.map((b) => retarget(b, '.page,page', '.theme-dark,.theme-dark page')).join('\n') + '\n' + darkFixupCss + '\n' + darkReadableCss + '\n',
    desc: `深色主题，${darkBlocks.length} 段 + ${DARK_ONLY_FIXUPS.length} 段补齐 + ${DARK_READABILITY.length} 项可读性修正`,
  },
]

// 变量覆盖对账：深色必须能定义浅色定义过的每一个变量，否则那个位置会露出浅色。
// 这条断言的价值在于"TDesign 升级后"—— 新增变量忘了进深色分支，这里会报出来。
{
  const lightNames = varNames(lightBlocks)
  const darkNames = varNames(darkBlocks)
  const missing = [...lightNames].filter((n) => !darkNames.has(n) && !DARK_ONLY_FIXUPS.some(([k]) => k === n))
  if (missing.length) {
    console.error('以下变量浅色有、深色没有（会在深色下露出浅色值）：')
    for (const m of missing) console.error('  · ' + m)
    console.error('若是 TDesign 新增的，补进 DARK_ONLY_FIXUPS 或等它修深色分支。')
    process.exit(1)
  }
}

/** 可读性修正项也要对账：改了一个不存在的变量名，等于什么都没改（静默失效） */
for (const [k] of DARK_READABILITY) {
  if (!varNames(darkBlocks).has(k)) {
    console.error(`DARK_READABILITY 里的 ${k} 在 TDesign 深色分支里不存在 —— 这条修正是无效的`)
    console.error('（可能是 TDesign 改名了。确认后改掉这里的键名，或删掉这条。）')
    process.exit(1)
  }
}

const check = process.argv.includes('--check')
let failed = false

for (const out of outputs) {
  const rel = path.relative(ROOT, out.file)
  const current = fs.existsSync(out.file) ? fs.readFileSync(out.file, 'utf8') : null
  if (check) {
    if (current === out.content) {
      console.log(`${rel} 已同步（${out.desc}）。`)
    } else {
      failed = true
      console.error(`${rel} 与 TDesign 不一致 —— 跑一下：node scripts/gen-mp-theme.mjs`)
    }
  } else {
    fs.mkdirSync(path.dirname(out.file), { recursive: true })
    fs.writeFileSync(out.file, out.content)
    console.log(`${current === out.content ? '无需改动' : '已写入'} ${rel}（${out.desc}）`)
  }
}

if (failed) process.exit(1)
