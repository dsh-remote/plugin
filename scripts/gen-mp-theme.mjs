#!/usr/bin/env node
/**
 * 生成 mp/theme/ 下的主题变量表 —— `light.wxss`（默认）与 `dark.wxss`（切暗色时叠加）。
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
  'mp/miniprogram_npm/tdesign-miniprogram/common/style/theme/_index.wxss',
)

/** TDesign 深色分支漏掉的变量。深色下必须给值，否则会继承浅色表的同名值。 */
const DARK_ONLY_FIXUPS = [
  // 深色底上的阴影要用更浅一点的**中性**阴影才看得出层次（黑上加黑等于没加）
  ['--td-shadow-4', '0 2px 8px 0 rgba(0, 0, 0, 0.35)'],
  ['--td-scrollbar-hover-color', 'rgba(255, 255, 255, 0.26)'],
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

const lightHeader = `/* 生成物，不要手改 —— 重新生成：node scripts/gen-mp-theme.mjs
 *
 * 来源：mp/miniprogram_npm/tdesign-miniprogram/common/style/theme/_index.wxss
 * 作用：把 TDesign 的浅色变量从 @media (prefers-color-scheme:light) 里解放出来，
 *      无条件生效。选择器与 TDesign 一样是 .page,page，所以深色分支也被压掉了 ——
 *      系统是深色也一样是白底深字。
 *
 * 共 ${lightBlocks.length} 段。
 */
`

const darkHeader = `/* 生成物，不要手改 —— 重新生成：node scripts/gen-mp-theme.mjs
 *
 * 来源：mp/miniprogram_npm/tdesign-miniprogram/common/style/theme/_index.wxss
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
    file: path.join(ROOT, 'mp/theme/light.wxss'),
    content: lightHeader + lightBlocks.join('\n') + '\n',
    desc: `浅色（默认）主题，${lightBlocks.length} 段`,
  },
  {
    file: path.join(ROOT, 'mp/theme/dark.wxss'),
    content: darkHeader + darkBlocks.map((b) => retarget(b, '.page,page', '.theme-dark,.theme-dark page')).join('\n') + '\n' + darkFixupCss + '\n',
    desc: `深色主题，${darkBlocks.length} 段 + 1 段补齐`,
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
