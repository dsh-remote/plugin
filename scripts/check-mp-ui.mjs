#!/usr/bin/env node
/**
 * check-mp-ui — 小程序的静态结构自检。
 *
 * 为什么需要它：小程序的这两类错误**不会报错，只会静默难看**——
 *
 * 1. wxml 里用了 `<t-xxx>` 但该页 `usingComponents` 没声明 → 那个节点直接不渲染；
 * 2. wxml 里写 `class="foo"`，但没有任何 wxss 定义 `.foo` → 元素退化成裸 div，
 *    布局塌掉，而控制台一句警告都没有。
 *
 * 微信开发者工具能编译（`cli preview`）照样过，因为两边语法都对。
 * 这份自检把「引用」和「定义」对起来，专抓这两类。
 *
 * 用法：
 *   node scripts/check-mp-ui.mjs          # 报告问题，有问题则退出码 1
 *   node scripts/check-mp-ui.mjs --quiet  # 只输出结论
 *
 * 刻意不做的：解析 wxss 选择器的完整语法（只用正则扫 `.name`，宁可漏报不误报）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MP_DIR = path.join(here, '..', 'mp')
const quiet = process.argv.includes('--quiet')

const problems = []
const notes = []

function read(file) {
  return readFileSync(file, 'utf8')
}

function readJson(file) {
  try {
    return JSON.parse(read(file))
  } catch (error) {
    problems.push(`${path.relative(MP_DIR, file)}: JSON 解析失败 —— ${error.message}`)
    return null
  }
}

/** 抽出 wxss 里定义过的类名（宽松匹配，宁可把 `.a.b` 里的两个都算上）。 */
function definedClasses(wxssFile) {
  const out = new Set()
  if (!existsSync(wxssFile)) return out
  const text = read(wxssFile)
  // 去掉 @keyframes 块：里面的 `0%, 100%` 之类不是选择器
  const stripped = text.replace(/@keyframes[^{]*\{[\s\S]*?\n\}/g, '')
  for (const match of stripped.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) out.add(match[1])
  return out
}

/**
 * 从 class / hover-class 属性值里取出「可能被用到的类名」。
 * 动态部分 `{{item.kind}}` 无法静态求值 → 跳过；
 * 但三元表达式里 `? 'a' : 'b'` 的结果是确定的，必须算进来（漏了会误报）。
 *
 * 只取 `?` / `:` **后面**的字符串字面量：`{{x === 'reject' ? 'a' : 'b'}}` 里的
 * `'reject'` 是判断值不是类名，一起收进来就是误报。
 */
function usedClasses(attrValue) {
  const out = new Set()
  const dynamic = /\{\{([\s\S]*?)\}\}/g
  for (const match of attrValue.matchAll(dynamic)) {
    for (const literal of match[1].matchAll(/[?:]\s*'([^']*)'|[?:]\s*"([^"]*)"/g)) {
      const value = literal[1] ?? literal[2] ?? ''
      for (const token of value.split(/\s+/)) if (token) out.add(token)
    }
  }
  const statics = attrValue.replace(dynamic, ' ')
  for (const token of statics.split(/\s+/)) if (token) out.add(token)
  return out
}

function walkWxml(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'miniprogram_npm') continue
      out.push(...walkWxml(full))
    } else if (entry.name.endsWith('.wxml')) {
      out.push(full)
    }
  }
  return out
}

const appJson = readJson(path.join(MP_DIR, 'app.json'))
const globalClasses = definedClasses(path.join(MP_DIR, 'app.wxss'))
const globalComponents = appJson?.usingComponents ?? {}

/** 小程序内置组件——componentPlaceholder 可以直接指向它们，不必额外声明 */
const BUILTIN = new Set([
  'view', 'scroll-view', 'swiper', 'swiper-item', 'movable-area', 'movable-view',
  'cover-view', 'cover-image', 'icon', 'text', 'rich-text', 'progress', 'button',
  'checkbox', 'checkbox-group', 'form', 'input', 'label', 'picker', 'picker-view',
  'picker-view-column', 'radio', 'radio-group', 'slider', 'switch', 'textarea',
  'navigator', 'functional-page-navigator', 'audio', 'image', 'video', 'camera',
  'live-player', 'live-pusher', 'map', 'canvas', 'open-data', 'web-view', 'ad',
  'ad-custom', 'official-account', 'open-trade', 'editor', 'match-media',
  'page-container', 'share-element', 'keyboard-accessory', 'voip-room',
  'navigation-bar', 'page-meta', 'grid-view', 'list-view', 'sticky-header',
  'sticky-section', 'snapshot', 'root-portal', 'double-tap-gesture-handler',
])

const pages = appJson?.pages ?? []
if (!pages.length) problems.push('app.json: pages 为空')

for (const page of pages) {
  const rel = `${page}.wxml`
  const wxmlFile = path.join(MP_DIR, rel)
  const jsonFile = path.join(MP_DIR, `${page}.json`)

  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    const f = path.join(MP_DIR, `${page}.${ext}`)
    if (!existsSync(f)) notes.push(`${page}.${ext} 不存在（小程序可以没有 wxss，但 js/json/wxml 少了会直接报错）`)
  }
  if (!existsSync(wxmlFile)) continue

  const wxml = read(wxmlFile)
  const pageJson = readJson(jsonFile)
  const declared = { ...globalComponents, ...(pageJson?.usingComponents ?? {}) }

  // ① 组件：用了没声明 / 声明了没用
  const usedTags = new Set()
  for (const match of wxml.matchAll(/<(t-[a-z][a-z0-9-]*)[\s/>]/g)) usedTags.add(match[1])
  for (const tag of usedTags) {
    if (!(tag in declared)) {
      problems.push(`${rel}: 用了 <${tag}> 但 usingComponents 没有声明 —— 该节点不会渲染`)
    }
  }
  for (const name of Object.keys(pageJson?.usingComponents ?? {})) {
    if (!usedTags.has(name)) notes.push(`${rel}: usingComponents 里的 ${name} 没被用到（白占主包体积）`)
  }
  for (const name of Object.keys(globalComponents)) {
    if (!usedTags.has(name)) notes.push(`app.json: 全局组件 ${name} 没被任何页面用到`)
  }
  // 声明的路径必须真实存在
  for (const [name, target] of Object.entries(declared)) {
    const abs = target.startsWith('/') ? path.join(MP_DIR, target) : path.resolve(path.dirname(jsonFile), target)
    if (!existsSync(`${abs}.json`) && !existsSync(abs)) {
      problems.push(`${rel}: 组件 ${name} 指向的路径不存在 —— ${target}`)
    }
  }

  // ② 类名：用了但全局 + 本页都没定义
  const pageClasses = definedClasses(path.join(MP_DIR, `${page}.wxss`))
  const known = new Set([...globalClasses, ...pageClasses])
  const missing = new Set()
  // 只认这三种类名属性：别的 `xxx-class` 不是样式类
  const CLASS_ATTRS = new Set(['class', 'hover-class', 'placeholder-class'])
  for (const match of wxml.matchAll(/(?:^|\s)([a-z-]*class)="([^"]*)"/g)) {
    if (!CLASS_ATTRS.has(match[1])) continue
    for (const cls of usedClasses(match[2])) {
      if (!known.has(cls)) missing.add(cls)
    }
  }
  if (missing.size) {
    problems.push(`${rel}: 这些 class 没有任何 wxss 定义 —— ${[...missing].sort().join(', ')}`)
  }

  // ③ 用时注入：componentPlaceholder 必须指得着真东西
  const placeholders = pageJson?.componentPlaceholder ?? {}
  for (const [name, holder] of Object.entries(placeholders)) {
    if (!(name in (pageJson?.usingComponents ?? {}))) {
      problems.push(`${rel}: componentPlaceholder 里的 ${name} 不在本页 usingComponents —— 占位配置不会生效`)
    }
    if (!BUILTIN.has(holder) && !(holder in declared)) {
      problems.push(`${rel}: ${name} 的占位组件 "${holder}" 既不是内置组件也没在本页声明 —— 渲染时会直接抛错`)
    }
  }
}

// ④ 按需注入：开了才谈得上省；全局声明会把它抵消掉
if (appJson?.lazyCodeLoading !== 'requiredComponents') {
  problems.push(
    'app.json: lazyCodeLoading 不是 "requiredComponents" —— 主包全部 JS（含未访问页面、' +
      '未声明的组件）都会在启动时注入并执行。见 docs/MINI-PROGRAM.md',
  )
}
if (Object.keys(globalComponents).length) {
  problems.push(
    `app.json: 声明了全局 usingComponents（${Object.keys(globalComponents).join(', ')}）—— ` +
      '每一页都会被强制注入这些组件，正好抵消按需注入。挪到真正用到它的页面 json 里',
  )
}

// ⑤ 打包排除项必须在：TDesign 是预置产物，node_modules 不该进包
const projectConfig = readJson(path.join(MP_DIR, 'project.config.json'))
const ignored = (projectConfig?.packOptions?.ignore ?? []).map((x) => x.value)
for (const must of ['node_modules', 'core/package.json', 'package-lock.json']) {
  if (!ignored.includes(must)) problems.push(`project.config.json: packOptions.ignore 少了 ${must}`)
}

// ⑥ 主题接线：深色靠根容器的 class 生效，这里盯住那条链的每一环。
//    这些都是"接错一环就整页失效"的地方，而且**全是静默的**——深色变量没命中时
//    页面照样渲染，只是一块一块露着浅色，肉眼在小屏上很容易看漏。
{
  const appWxss = read(path.join(MP_DIR, 'app.wxss'))
  // **只认真正的 @import 行**。直接 indexOf 会命中注释里的文件名 ——
  // 上面的说明注释恰好先提到 light.wxss，于是无论顺序怎么颠倒都能匹配到注释那处，
  // 断言就成了永远为假的死代码（反证时才发现）。
  const importOf = (name) => {
    const m = appWxss.match(new RegExp(`^\\s*@import\\s+['"][^'"]*${name.replace('.', '\\.')}['"]`, 'm'))
    return m ? m.index : -1
  }
  const lightIdx = importOf('light.wxss')
  const darkIdx = importOf('dark.wxss')
  if (lightIdx < 0) {
    problems.push('app.wxss: 没有 import theme/light.wxss —— 浅色（默认主题）变量不会生效')
  }
  if (darkIdx < 0) {
    problems.push('app.wxss: 没有 import theme/dark.wxss —— 切了深色也不会变（切了没反应）')
  } else if (lightIdx >= 0 && darkIdx < lightIdx) {
    // 顺序是**语义的一部分**：浅色表写在 .page,page 上会向下继承，
    // 深色表必须靠后用同特异性压掉它。反过来的话深色永远压不住浅色。
    problems.push('app.wxss: theme/dark.wxss 必须在 theme/light.wxss **之后** import —— ' + '深色表靠"同特异性下源码顺序靠后的胜出"压掉浅色表')
  }

  // 生成物是否与 TDesign 同步（忘重新生成 = 深色下有变量漏着浅色值）
  const darkWxss = read(path.join(MP_DIR, 'theme/dark.wxss'))
  if (!/\.theme-dark/.test(darkWxss)) {
    problems.push('theme/dark.wxss: 没有 .theme-dark 选择器 —— 深色变量没有生效条件。重新生成：node scripts/gen-mp-theme.mjs')
  }
  const lightWxss = read(path.join(MP_DIR, 'theme/light.wxss'))
  if (!/\.page/.test(lightWxss)) {
    problems.push('theme/light.wxss: 没有 .page,page 选择器 —— 浅色变量挂不上 page。重新生成：node scripts/gen-mp-theme.mjs')
  }

  // 每个页面的根容器都要挂 themeClass，否则该页切了主题没反应
  for (const page of pages) {
    const wxml = read(path.join(MP_DIR, `${page}.wxml`))
    if (!/themeClass/.test(wxml)) {
      problems.push(
        `${page}.wxml: 根容器没有 {{themeClass}} —— 这一页在深色下不会变。` +
          '深色变量挂在 .theme-dark 类上，class 只能由根容器给',
      )
    }
    const js = read(path.join(MP_DIR, `${page}.js`))
    if (!/theme\.applyTo\(/.test(js)) {
      problems.push(`${page}.js: onLoad 里没有 theme.applyTo(this) —— 导航栏与下拉回弹区不会跟着换色`)
    }
  }

  // 默认必须是浅色：用户没选过时
  if (!/themeName:\s*'light'/.test(read(path.join(MP_DIR, `${pages[0]}.js`)))) {
    problems.push(`${PAGES[0]}.js: data.themeName 默认值不是 'light' —— 约定是"没选过就是浅色"`)
  }
}

if (!quiet) {
  if (notes.length) {
    console.log('提示（不算错）：')
    for (const n of notes) console.log(`  · ${n}`)
    console.log('')
  }
}

if (problems.length) {
  console.log(`小程序结构自检：${problems.length} 个问题`)
  for (const p of problems) console.log(`  ✗ ${p}`)
  process.exit(1)
}
console.log('小程序结构自检通过：组件声明、类名定义、注入配置、打包排除项都对得上。')
