#!/usr/bin/env node
/**
 * 生成 mp/theme/fixed-light.wxss —— 一份「不跟随系统」的浅色变量表。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * TDesign 的 `common/style/theme/_index.wxss` 把浅色和深色**两套变量都包在
 * `@media (prefers-color-scheme)` 里**，跟随系统。本项目要固定白色主题。
 *
 * 做法：把「浅色」那几段抽出来、剥掉 `@media` 外壳，再由 `app.wxss` 在
 * `_index.wxss` **之后** import。两份规则的选择器都是 `.page,page`（特异性相同），
 * 于是靠「同特异性下后出现的胜」压过深色分支 —— 不管系统是不是深色。
 *
 * ── 为什么用脚本而不是手抄 ───────────────────────────────────────────
 * 那份变量表是几 KB 的单行 CSS，手抄必漏，漏掉的变量就会退回深色值。
 * TDesign 升级后重跑一次即可。`--check` 用来在 CI 里发现"忘了重新生成"。
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
const OUT = path.join(ROOT, 'mp/theme/fixed-light.wxss')

/** 把 `@media (prefers-color-scheme:light){ … }` 的 body 逐个抠出来（按花括号配平） */
function extractLightBlocks(css) {
  const blocks = []
  const re = /@media\s*\(prefers-color-scheme\s*:\s*light\)\s*\{/g
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

const src = fs.readFileSync(SRC, 'utf8')
const blocks = extractLightBlocks(src)
if (!blocks.length) throw new Error(`没在 ${path.relative(ROOT, SRC)} 里找到浅色分支`)

const header = `/* 生成物，不要手改 —— 重新生成：node scripts/gen-mp-theme.mjs
 *
 * 来源：mp/miniprogram_npm/tdesign-miniprogram/common/style/theme/_index.wxss
 * 作用：把 TDesign 的浅色变量从 @media (prefers-color-scheme:light) 里解放出来，
 *      无条件生效。app.wxss 在 _index.wxss 之后 import 本文件，
 *      靠「同特异性下源码顺序靠后的胜出」压过深色分支 —— 系统是深色也一样是白底深字。
 *
 * 共 ${blocks.length} 段。
 */
`
const output = header + blocks.join('\n') + '\n'

const check = process.argv.includes('--check')
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null

if (check) {
  if (current === output) {
    console.log(`固定浅色主题已同步（${blocks.length} 段）。`)
  } else {
    console.error('mp/theme/fixed-light.wxss 与 TDesign 的浅色变量不一致 —— 跑一下：')
    console.error('  node scripts/gen-mp-theme.mjs')
    process.exit(1)
  }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, output)
  const changed = current !== output
  console.log(
    `${changed ? '已写入' : '无需改动'} ${path.relative(ROOT, OUT)}（${blocks.length} 段，${output.length} 字节）`,
  )
}
