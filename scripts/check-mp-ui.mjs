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
// 开源改造后小程序住在独立仓 `dsh-remote-mp`：`app.json`/`pages`/`theme` 在 `miniprogram/` 下，
// 而 `project.config.json` 在**仓根**（`miniprogramRoot: "miniprogram/"`），两层要分开取。
const MP_REPO = path.join(here, '..', 'dsh-remote-mp')
const MP_DIR = path.join(MP_REPO, 'miniprogram')
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

// ⑤ 打包排除项必须在：TDesign 是预置产物，node_modules 不该进包。
//    `project.config.json` 现在在**仓根**，所以它里面的 ignore 路径是相对仓根的
//    （`miniprogram/core/package.json`），不再是旧 mp/ 时代的 `core/package.json`——
//    层级变了但守的还是那三样，别把它当成"检查变松了"。
const projectConfig = readJson(path.join(MP_REPO, 'project.config.json'))
const ignored = (projectConfig?.packOptions?.ignore ?? []).map((x) => x.value)
for (const must of ['node_modules', 'miniprogram/core/package.json', 'package-lock.json']) {
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
  const firstPage = pages[0]
  if (!/themeName:\s*'light'/.test(read(path.join(MP_DIR, `${firstPage}.js`)))) {
    problems.push(`${firstPage}.js: data.themeName 默认值不是 'light' —— 约定是"没选过就是浅色"`)
  }
}

// ⑦ 配对入口：删掉过独立的配对页，配对就发生在**首页**。
//    如果哪天首页又没有扫码入口了，用户会遇到「装好了却没有任何办法连上」——
//    而编译、预览、单测全都照常通过，是最难发现的一种坏。
{
  const home = pages[0]
  const homeWxml = read(path.join(MP_DIR, `${home}.wxml`))
  const homeJs = read(path.join(MP_DIR, `${home}.js`))
  // 「定义」在 js 里，「有人点」在 wxml 里。两边都要有：只有 js 有 = 死代码，
  // 只有 wxml 有 = 点了报 "does not have a method"（真机控制台才看得到）。
  // 属性值要**闭合**：只匹配 `bindtap="onScan` 会连 `bindtap="onScanXXX"` 一起命中，
  // 反证时才发现这条断言形同虚设。
  const checks = [
    ['扫码', /wx\.scanCode\(\{/, /bindtap="onScan"/],
    ['解除配对', /onUnpair:\s*function/, /bindtap="onUnpair"/],
  ]
  for (const [what, inJs, inWxml] of checks) {
    if (!inJs.test(homeJs)) {
      problems.push(
        `${home}.js: 首页没有实现${what} —— 配对必须在首页完成。` +
          '配对曾经是独立一页，删掉后能力必须内联回来，不能凭空消失',
      )
    }
    if (!inWxml.test(homeWxml)) {
      problems.push(`${home}.wxml: 没有任何元素 bindtap 到${what} —— 用户没有入口`)
    }
  }
  // 未配对与已配对必须分成两态渲染，且已配对分支要显式带条件：
  // 写成 wx:else 就没法断言"两态都在"，将来有人改成单态就会静默少一块。
  if (!/wx:if="\{\{paired\}\}"/.test(homeWxml)) {
    problems.push(`${home}.wxml: 缺少 wx:if="{{paired}}" 的已配对分支 —— 未配对与已配对要分成两态`)
  }
}

// ⑧ 分支链不许有"用 wx:elif 关掉一支、却让内容落到后面兜底 else"的组合。
//    wxml 的规则：wx:elif 条件为假会**落到后面的 wx:else**，而不是什么都不渲染。
//    于是「用 wx:elif 加条件把某一支关掉」的结果是：那一支被末尾的 else 接手，
//    渲染出一排本不该出现的元素。真踩过 —— 隐藏过程块时每个步骤组变成一个空提示条，
//    而且编译、单测、逻辑全对，只有渲染层看得见。
//    正确写法：被条件关掉的那一支用**独立 wx:if**，不匹配就什么都不渲染。
//
//    两种正当写法**不能**误报（第一版就误报了三处）：
//    · 多分支互斥链且**末尾没有 else**：loading / error / hasMore / ok 那种，各条互斥，
//      条件为假自然什么都不渲染。
//    · 末尾的 else 与**紧邻的 if 恰好互补**：`wx:if="{{pasteText}}"` / `wx:else`、
//      `think` / `tool` 这种二选一。
//    所以判据收紧成一条：**有兜底 else，且它前面存在"带逻辑运算的 wx:elif"** ——
//    只有这个组合才会真的画出别的东西。
{
  for (const page of pages) {
    const rel = `${page}.wxml`
    const abs = path.join(MP_DIR, rel)
    if (!existsSync(abs)) continue
    // 先剥掉注释：注释里写"wx:else"是常事（这条自检的说明里就有），
    // 不剥会把它当成真标签。
    const wxml = read(abs).replace(/<!--[\s\S]*?-->/g, '')

    // 判据只认一种形态：**块流按 kind 分派时，用 wx:elif 加条件关掉某一种 kind**。
    // 这种写法下条件为假会落到同链末尾的 wx:else，于是被关掉的那一种 kind
    // 会被末尾的 else 接手渲染 —— 过程块变成一排空提示条就是这么来的。
    //
    // 不做通用语法分析：互斥链（loading/error/hasMore/ok）与二元 else
    // （think/tool、pasteText/粘贴）都是对的，不该报。
    // 判据 = 「有按 item.kind 的 wx:elif 且条件带逻辑运算」+「有裸 wx:else」，
    // 两者同文件即可疑（真出问题就是这个组合）。
    const kindElif = [...wxml.matchAll(/wx:elif="\{\{\s*item\.kind\s*===[^"]*(&&|\|\|)[^"]*\}\}"/g)]
    const catchAll = /<view\s+wx:else[\s>]/.test(wxml)
    if (kindElif.length && catchAll) {
      problems.push(
        `${rel}: 用「wx:elif + 逻辑运算」按 item.kind 关掉某一种块，而文件里还有裸 wx:else —— ` +
          `被关掉的那一种会落到 else 被渲染出来（命中 ${kindElif.length} 处）。` +
          "要隐藏某一种块就用独立的 wx:if=\"{{item.kind === 'xxx' && 条件}}\"，不匹配就什么都不渲染",
      )
    }
  }
}

if (!quiet) {
  if (notes.length) {
    console.log('提示（不算错）：')
    for (const n of notes) console.log(`  · ${n}`)
    console.log('')
  }
}

// ── 主题：挂在根容器上的 .theme-dark 必须自己声明正文色 ────────────────
// 这条是**真机截图逼出来的**：深色模式下主机名、会话标题凡是没显式写 color 的
// 文字全变成了近黑字压在深底上，看着像"深色配色坏了"。
// 根因不是某处写错了颜色，而是 `page { color: var(--td-text-color-primary) }`：
// CSS 自定义属性在**声明它的元素上**解析，而 `page` 自己身上没有 .theme-dark
// （那个 class 挂在页面的根容器 view 上），所以 var() 取到浅色表的 #1f2329；
// 算出的 color 作为**计算值**继承给后代，后代重定义了变量也不会重算 ——
// 继承来的计算值与变量的当前值是两回事。
// 修法：在挂了 .theme-dark 的那个节点上重新声明一次 color。
//
// 这里只做**结构**断言（挂 class 的节点有没有声明 color）。它抓不到具体色值，
// 色值由 scripts/mp-probe.mjs 在渲染层读真实计算样式来判。
{
  // 页面根容器 = wxml 里第一个带 {{themeClass}} 的节点；它用的类就是主题挂载点。
  const pageDirs = readdirSync(path.join(MP_DIR, 'pages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  for (const page of pageDirs) {
    const wxmlPath = path.join(MP_DIR, 'pages', page, `${page}.wxml`)
    if (!existsSync(wxmlPath)) continue
    const wxml = read(wxmlPath).replace(/<!--[\s\S]*?-->/g, '')

    // 找出所有同时出现 {{themeClass}} 的 class="..."，取其第一个类名作为挂载点
    const mounts = new Set()
    for (const m of wxml.matchAll(/class="([^"]*\{\{\s*themeClass\s*\}\}[^"]*)"/g)) {
      const first = m[1].trim().split(/\s+/)[0]
      if (first) mounts.add(first)
    }
    if (!mounts.size) {
      problems.push(
        `pages/${page}/${page}.wxml: 没有任何节点挂 {{themeClass}} —— 这一页不会跟着主题切换`,
      )
      continue
    }

    // 挂载点类名可能定义在本页 wxss，也可能定义在 app.wxss（.page-pad 就是）
    const localWxss = path.join(MP_DIR, 'pages', page, `${page}.wxss`)
    const appWxss = path.join(MP_DIR, 'app.wxss')
    const haystacks = [localWxss, appWxss].filter(existsSync).map((f) => ({
      file: f,
      text: read(f).replace(/\/\*[\s\S]*?\*\//g, ''),
    }))

    for (const cls of mounts) {
      // 取该类的规则块（到下一个 `}` 为止），看里面有没有 color
      const found = haystacks.some(({ text }) => {
        const re = new RegExp(`\\.${cls}\\s*(,[^{]*)?\\{([^}]*)\\}`)
        const m = text.match(re)
        return m && /(^|[;{\s])color\s*:/.test(m[2])
      })
      if (!found) {
        problems.push(
          `pages/${page}: 主题挂载点 .${cls} 没有声明 color —— ` +
            '深色下所有没显式写 color 的文字会继承 page 的浅色计算值（近黑），在深底上等于隐形。' +
            `在 .${cls} 的规则里加 color: var(--td-text-color-primary);`,
        )
      }
    }
  }
}

if (problems.length) {
  console.log(`小程序结构自检：${problems.length} 个问题`)
  for (const p of problems) console.log(`  ✗ ${p}`)
  process.exit(1)
}
console.log('小程序结构自检通过：组件声明、类名定义、注入配置、打包排除项都对得上。')
