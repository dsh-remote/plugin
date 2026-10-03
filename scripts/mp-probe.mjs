#!/usr/bin/env node
/**
 * mp-probe — 对**渲染层行为**做交互验证。
 *
 * 为什么需要它：`mp-shots` 只能证明"长得对"，`mp-chat-blocks` 只能证明"逻辑算得对"，
 * 而「点一下到底有没有用」这两者都证明不了 —— 它发生在渲染层：
 *
 *   - `scroll-into-view` 找不到目标节点时**不报错、不重试**，只是不滚。
 *     chat 页的锚点曾写成 `<view id="{{toView}}">`（同一个元素跟着 toView 改名），
 *     要赌"元素改名"与"scroll-into-view 生效"谁先落到渲染层上 —— 赌输了就是
 *     「回到最新」点了没反应。这个 bug 截图和单测都抓不到，只有真的点一下才看得见。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   node scripts/mp-probe.mjs                 跑全部探针
 *   node scripts/mp-probe.mjs --case jump     只跑「回到最新」
 *
 * ── 前置：自动化端口不是常开的 ────────────────────────────────────────
 *   /Applications/wechatwebdevtools.app/Contents/MacOS/cli quit
 *   /Applications/wechatwebdevtools.app/Contents/MacOS/cli auto \
 *     --project "$(pwd)/mp" --trust-project --auto-port 9420
 *
 * 退出码：任一条判据不成立 → 非零。
 */
import { createRequire } from 'node:module'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function flag(name, fallback) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  const eq = hit.indexOf('=')
  if (eq !== -1) return hit.slice(eq + 1)
  // 空格分隔形式（`--case theme`）：下一个 token 就是值。
  // 原来这里一律返回 true，于是 `--case theme` 被当成"case = 真"，
  // 报出 `没有这个探针：true` —— 报错信息完全指不到真正的原因。
  const i = process.argv.indexOf(hit)
  const next = process.argv[i + 1]
  if (next !== undefined && !next.startsWith('--')) return next
  return true
}

const PORT = Number(flag('port', process.env.MP_AUTO_PORT || 9420))
const ONLY = String(flag('case', '')).trim()

function resolveAutomator() {
  const candidates = [
    'miniprogram-automator',
    path.join(ROOT, 'node_modules/miniprogram-automator'),
    path.join(ROOT, 'e2e/node_modules/miniprogram-automator'),
    path.join(
      process.env.HOME || '',
      '.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator',
    ),
  ]
  for (const c of candidates) {
    try {
      return require(c)
    } catch {
      /* 继续找下一个 */
    }
  }
  return null
}

/** 端口开着的话，HTTP 请求会被要求 Upgrade 到 WebSocket（426） */
function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/version', timeout: 2500 },
      (res) => {
        res.resume()
        resolve(res.statusCode === 426 || res.statusCode === 101 || res.statusCode === 200)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/** 一屏装不下的长内容 —— 有距离可滚，才谈得上"滚没滚到" */
function longBlocks(rounds) {
  const out = []
  for (let i = 1; i <= rounds; i++) {
    out.push({ key: 'r' + i, kind: 'turn', label: `第 ${i} 轮`, time: '14:00' })
    out.push({
      key: 'm' + i,
      kind: 'text',
      text: `第 ${i} 轮回复正文。这一行是为了把内容撑过一屏，好让"回到最新"有距离可滚。`,
      done: true,
    })
  }
  return out
}

/** 一组跑满 steps 步的步骤组；展示字段（label/tools/live）得自己写 —— 走 setData 不经过 decorateSteps */
function stepsGroup(key, open, steps) {
  const items = []
  for (let i = 1; i <= steps; i++) {
    items.push({
      key: key + 't' + i,
      type: 'tool',
      callId: key + 'c' + i,
      phase: 'completed',
      tool: 'read_file',
      title: `src/a-${i}.tsx`,
      args: `{"path":"a/${i}"}`,
      result: `ok ${i}`,
      open: false,
      preview: `ok ${i}`,
    })
  }
  return {
    key,
    kind: 'steps',
    open,
    closed: true,
    live: false,
    tools: steps,
    thinkMs: 0,
    tailId: '',
    label: `已完成 ${steps} 个步骤`,
    items,
  }
}

/** 反复用到的长会话：每轮 = 轮次分隔 + 指令 + 步骤组 + 正文。展开态下比一屏长得多 */
function foldFixture(rounds, open, steps) {
  const out = []
  for (let i = 1; i <= rounds; i++) {
    out.push({ key: 'r' + i, kind: 'turn', label: `第 ${i} 轮`, time: '14:00' })
    out.push({ key: 'u' + i, kind: 'user', text: `第 ${i} 条指令，说点东西把这一页撑长。`, confirmed: true })
    out.push(stepsGroup('x' + i, open, steps))
    out.push({ key: 'm' + i, kind: 'text', text: `第 ${i} 轮回复。` + '撑高用的正文。'.repeat(3), done: true })
  }
  return out
}

const CASES = {
  /**
   * 「回到最新」：滚到底部的浮标点下去，scroll-view 的 scrollTop 必须真的变。
   * 这是**唯一**能证明这个按钮可用的判据 —— 它读的是 scroll-view 自己的位置，
   * 不是页面 data 里那个"我以为我滚了"的 toView。
   */
  jump: async (page) => {
    await page.setData({ blocks: longBlocks(14), atBottom: false })
    await page.waitFor(900)

    const el = await page.$('.scroll')
    const height = await el.scrollHeight()

    // 先滚到底、再回顶：制造"用户往上回看过"的真实处境
    await el.scrollTo(0, 999999)
    await page.waitFor(800)
    const bottom = await el.property('scrollTop')
    await el.scrollTo(0, 0)
    await page.waitFor(800)
    const before = await el.property('scrollTop')

    await page.callMethod('onJumpLatest')
    await page.waitFor(1500)
    const after = await el.property('scrollTop')
    const data = await page.data()

    const viewport = (await el.size()).height
    const reachedBottom = after + viewport >= height - 30
    const checks = [
      [bottom > 100, `内容要够长（手动滚到底 = ${bottom}，内容高 ${Math.round(height)}）`],
      [before === 0, `要先回到顶部（scrollTop = ${before}）`],
      [after > before, `点完之后 scrollTop 必须变大（${before} → ${after}）`],
      [reachedBottom, `必须真的到底（${after} + 视口 ${Math.round(viewport)} ≥ ${Math.round(height)} - 30）`],
      [data.atBottom === true, 'atBottom 要跟着变 true'],
    ]
    return checks
  },

  /**
   * 「收起过程不能留下空白」。
   *
   * 用户报的是「展开过程后再收起过程，过程内容不见了，但是**所占的位置还在**」。
   * 那个残留读页面 data 是看不出来的（`open` 老老实实变成了 false），截图也只是一片白，
   * 只有拿渲染层的数字才说得清：折叠后 scrollTop 必须落在**新的**合法范围里，
   * 否则下面就是一段滚不到任何内容的空白（`blank > 0`）。
   *
   * 判据分两段，缺一不可：
   *   ① 卡片节点真的没了 + 内容高度真的矮了（"内容不见了"这半句）；
   *   ② scrollTop 落在新的底部、blank ≈ 0（"位置还在"这半句的反面）。
   * 只查①的话，一个"内容没了但视口停在旧高度"的 bug 照样全绿。
   */
  fold: async (page) => {
    // **必须显式 showSteps: true**。过程块默认不渲染（chat.js 的 SHOW_STEPS=false），
    // 不打开的话这里数到的卡片恒为 0、内容高度恒定 —— 判据会一直红，
    // 而红的原因不是折叠坏了，是"根本没有过程可折"。
    // 打开开关之后，折叠这套行为仍然要成立（那是留下来的代码），所以继续守。
    await page.setData({
      blocks: foldFixture(8, true, 6),
      foldable: 8,
      expanded: true,
      showSteps: true,
    })
    await page.waitFor(1200)

    const el = await page.$('.scroll')
    const cardsBefore = (await page.$$('.steps-card')).length
    const heightBefore = await el.scrollHeight()

    await page.callMethod('onJumpLatest')
    await page.waitFor(1500)
    const topBefore = await el.property('scrollTop')

    await page.callMethod('onToggleAll')
    await page.waitFor(1800)

    const cardsAfter = (await page.$$('.steps-card')).length
    const heightAfter = await el.scrollHeight()
    const topAfter = await el.property('scrollTop')
    const viewport = (await el.size()).height
    // 内容比视口高出来的部分 = scrollTop 的合法上限；scrollTop 追不上它 = 底下留白
    const blank = Math.max(0, Math.round(heightAfter - viewport - topAfter))
    const data = await page.data()
    const groups = data.blocks.filter((b) => b.kind === 'steps')

    return [
      [cardsBefore === 8, `折叠前 8 张过程卡片都在（数到 ${cardsBefore}）`],
      [topBefore > 100, `折叠前确实贴着底（scrollTop = ${topBefore}）`],
      [cardsAfter === 0, `折叠后卡片节点必须全部消失（还剩 ${cardsAfter} 张）`],
      [heightBefore - heightAfter > 1000, `内容要真的矮下来（${Math.round(heightBefore)} → ${Math.round(heightAfter)}）`],
      [groups.length === 8 && groups.every((g) => !g.open), 'data 里每一组都变成收起的'],
      [blank <= 4, `底下不许剩空白（blank = ${blank}px，scrollTop ${topAfter} / 上限 ${Math.round(heightAfter - viewport)}）`],
    ]
  },
  /**
   * 过程默认**不显示**（本轮的产品决定）：数据里有步骤组，渲染层却一个节点都不出。
   *
   * 这条判据读的是 `page.$$('.steps-card').length` —— **渲染层**的节点数，
   * 不是 data 里的块数。两者混了这条断言就白写：data 里当然还有 steps 块
   * （审批要知道主机在调什么、回放要对得上 callId），那是故意的。
   *
   * 顺带盯住那个空提示条：wx:elif 条件为假会落到末尾的 wx:else，
   * 于是每个步骤组变成一个空 note —— 页面上会多出一排空行。
   */
  plain: async (page) => {
    await page.setData({ blocks: foldFixture(4, true, 3), showSteps: false })
    await page.waitFor(1200)

    const data = await page.data()
    const groups = data.blocks.filter((b) => b.kind === 'steps')
    const cards = (await page.$$('.steps-card')).length
    const bars = (await page.$$('.steps-bar')).length
    const notes = (await page.$$('.note')).length
    const replies = (await page.$$('.reply')).length

    return [
      [groups.length === 4, `data 里仍要有步骤组（${groups.length} 个）—— 不显示 ≠ 不记录`],
      [cards === 0, `默认态不许渲染过程卡（数到 ${cards} 张）`],
      [bars === 0, `过程那一行也不该出现（数到 ${bars} 个）`],
      [notes === 0, `不许掉进 note 分支变成空提示条（数到 ${notes} 个）`],
      [replies === 4, `正文要照常渲染（${replies} 条回复）`],
    ]
  },
  /**
   * 主题切换：点一下浅色/深色，**渲染层真的换了底色**才算过。
   *
   * 为什么必须读渲染层：变量挂在一个 class 上，class 加对了、页面 data 也对了，
   * 仍可能一行都没生效（选择器写错、import 顺序颠倒、变量表没重新生成）。
   * 这几种都不会报错，页面照常渲染 —— 只是颜色是浅的。所以判据只能看
   * 元素**实际算出来的** backgroundColor。
   *
   * 必须在 sessions 页测：切换按钮在那儿，而按钮能不能点是两件事（这里只管后者）。
   */
  theme: async (page, mini) => {
    await mini.reLaunch('/pages/sessions/sessions')
    const p = await mini.currentPage()
    await p.waitFor(600)

    // 造出「已配对 + 有会话」的状态：字色判据要读主机名、会话标题那些节点，
    // 没配对时它们根本不渲染 —— 那样判据会静默退化成"跳过"，看起来全绿。
    // 这里只摆**渲染需要的字段**，不碰 themeClass（主题要走真实切换链）。
    await p.setData({
      paired: true,
      status: 'online',
      hostLabel: 'Linbin 的 MacBook',
      statusLabel: '在线',
      statusTheme: 'success',
      statusText: '已连接到主机',
      keepAwakeOn: true,
      keepAwakeText: '当前持锁中 · caffeinate',
      sessions: [
        {
          id: 'p-1',
          title: '探针用的会话标题',
          workspace: '/Users/linbin/dsh-remote-control',
          badgeText: '空闲',
          badgeTheme: 'default',
          running: false,
          updatedAt: '23:40',
        },
      ],
    })
    await p.waitFor(400)

    // 默认态：没选过就是浅色
    const root0 = await p.$('.page-pad')
    const bg0 = await root0.style('background-color')
    const data0 = await p.data()

    // 真点一下（不是 setData 塞 themeClass —— 那会绕过整条链，恰好漏掉
    // "存储读到了吗 / applyTo 调了吗 / class 挂对了吗"这三件事）
    await p.callMethod('onToggleTheme')
    await p.waitFor(800)

    const root1 = await p.$('.page-pad')
    const bg1 = await root1.style('background-color')
    const data1 = await p.data()
    const rootClass = (await root1.attribute('class')) || ''

    // 字色必须在**深色态**读 —— 切回浅色之后再读就全绿了，等于没测。
    const inkChecks = await darkInkChecks(p)

    // 再点回来，验证**双向**（这是本次的核心：之前"固定浅色"只能压住深色、切不回来）
    await p.callMethod('onToggleTheme')
    await p.waitFor(800)
    const bg2 = await (await p.$('.page-pad')).style('background-color')
    const data2 = await p.data()

    /** #rrggbb → 相对亮度。判"深色底"比判"某个具体值"稳，换 TDesign 版本也不会假红。 */
    const lum = (c) => {
      const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(c))
      if (!m) return null
      const [r, g, b] = [1, 2, 3].map((i) => Number(m[i]) / 255)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const l0 = lum(bg0)
    const l1 = lum(bg1)
    const l2 = lum(bg2)

    return [
      [data0.themeName === 'light', `默认是浅色（themeName = ${data0.themeName}）`],
      [l0 !== null && l0 > 0.6, `默认底色是亮的（亮度 ${l0?.toFixed(2)}，${bg0}）`],
      [data1.themeName === 'dark', `点一下切到深色（themeName = ${data1.themeName}）`],
      [
        String(rootClass).includes('theme-dark'),
        `根容器挂上 theme-dark（class = "${String(rootClass).trim()}"）`,
      ],
      [l1 !== null && l1 < 0.25, `底色真的变暗了（亮度 ${l1?.toFixed(2)}，${bg1}）`],
      [l1 !== null && l0 !== null && l1 < l0 - 0.4, `深浅差得开（亮度 ${l0?.toFixed(2)} → ${l1?.toFixed(2)}）`],
      [data2.themeName === 'light', '再点一下切回浅色（双向可切）'],
      [l2 !== null && l0 !== null && Math.abs(l2 - l0) < 0.02, `切回来的底色与初始一致（亮度 ${l2?.toFixed(2)} vs ${l0?.toFixed(2)}）`],

      // ── 字色（补上「深色下字全黑了」那个真机缺陷）──────────────────────
      // 上面那组只验底色，漏了这个：底色确实变深了、class 也挂对了、页面 data 也对，
      // 但**正文颜色**没跟着变 —— 主机名、会话标题凡是没显式写 color 的文字
      // 全是近黑字压在深底上。根因是 `page { color: var(--td-text-color-primary) }`：
      // page 自己身上没有 .theme-dark，var() 在那儿就解析成浅色表的近黑色，
      // 算出的 color 作为**计算值**继承下去，后代重定义变量也不会重算。
      //
      // 所以判据必须落在**具体文字节点**上，且要与它所在容器的底色比：
      // 底色验对了不代表字色验对了，这两件事互不蕴含。
      ...inkChecks,
    ]
  },
}

/**
 * 深色下逐个读文字节点的实际 color，与所在卡片底色比亮度。
 * 挑的每个类名都是**故意没写 color** 的（靠继承），也就是这个 bug 的受害者；
 * 一旦有人在这些类上补了显式 color，判据依然成立（读了真值再比），不会假红。
 */
async function darkInkChecks(page) {
  // 主机名与列表标题只有在已配对、有会话时才渲染得出；没有就跳过（不判 ≠ 判过）
  const data = await page.data()
  if (!data.paired) return [[true, '未配对，跳过字色判据（这一组只在有主机卡时成立）']]

  const lum = (c) => {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(c))
    if (!m) return null
    const [r, g, b] = [1, 2, 3].map((i) => Number(m[i]) / 255)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  const out = []
  const targets = [
    ['.host-name', '主机名'],
    ['.host-sub', '主机副标题'],
    ['.keep-title', '防休眠标题'],
    ['.keep-desc', '防休眠说明'],
  ]
  if ((data.sessions || []).length) {
    targets.push(['.sess-title', '会话标题'], ['.sess-sub', '会话路径'])
  }

  const card = await page.$('.card')
  const bgRaw = card ? await card.style('background-color') : null
  const lBg = lum(bgRaw)

  for (const [sel, label] of targets) {
    const el = await page.$(sel)
    if (!el) {
      out.push([false, `${label}（${sel}）没渲染出来，无法验字色`])
      continue
    }
    const fg = await el.style('color')
    const lFg = lum(fg)
    // 关键判据：深色底上字必须**比底亮**。反过来（字比底暗）就是隐形字。
    out.push([
      lFg !== null && lBg !== null && lFg > lBg,
      `${label}的字要比底色亮（字 ${fg} 亮度 ${lFg?.toFixed(2)} vs 底 ${bgRaw} 亮度 ${lBg?.toFixed(2)}）`,
    ])
  }
  return out
}

async function main() {
  const automator = resolveAutomator()
  if (!automator) {
    console.error(
      '没找到 miniprogram-automator。装一份再跑：\n' +
        '  npm i miniprogram-automator --prefix ~/.workbuddy/binaries/node/workspace',
    )
    process.exit(1)
  }
  if (!(await probePort(PORT))) {
    console.error(
      `自动化端口 ${PORT} 没开。先让 IDE 以自动化模式启动：\n` +
        '  /Applications/wechatwebdevtools.app/Contents/MacOS/cli quit\n' +
        `  /Applications/wechatwebdevtools.app/Contents/MacOS/cli auto --project "${ROOT}/mp" --trust-project --auto-port ${PORT}`,
    )
    process.exit(1)
  }

  const names = ONLY ? [ONLY] : Object.keys(CASES)
  for (const n of names) {
    if (!CASES[n]) {
      console.error(`没有这个探针：${n}（可选：${Object.keys(CASES).join(' / ')}）`)
      process.exit(1)
    }
  }

  const miniProgram = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${PORT}` })
  miniProgram.on('exception', (err) => console.error('页面异常:', err.message))
  let failed = 0
  let total = 0
  try {
    for (const name of names) {
      await miniProgram.reLaunch(`/pages/chat/chat?id=probe-${name}`)
      const page = await miniProgram.currentPage()
      await page.waitFor(500)
      const checks = await CASES[name](page, miniProgram)
      total += checks.length
      const bad = checks.filter(([ok]) => !ok)
      failed += bad.length
      console.log(`${bad.length ? '✗' : '✓'} ${name}  ${checks.length - bad.length}/${checks.length}`)
      for (const [ok, label] of checks) console.log(`   ${ok ? '·' : '✗'} ${label}`)
    }
  } finally {
    await miniProgram.disconnect()
  }
  console.log(`\n探针 ${names.length} 组，判据 ${total - failed}/${total} 成立`)
  process.exit(failed ? 1 : 0)
}

await main()
