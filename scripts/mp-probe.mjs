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
    // **显式 showSteps: true**：过程块是渲染层的一个开关（chat.js 的 SHOW_STEPS，
    // 默认已开），写出来是为了这条判据不依赖默认值 —— 万一有人把默认关掉，
    // 这里数到的卡片恒为 0、内容高度恒定，判据会一直红，而红的原因不是折叠坏了。
    await page.setData({
      blocks: foldFixture(8, true, 6),
      showSteps: true,
    })
    await page.waitFor(1200)

    const el = await page.$('.scroll')
    const cardsBefore = (await page.$$('.steps-card')).length
    const heightBefore = await el.scrollHeight()

    await page.callMethod('onJumpLatest')
    await page.waitFor(1500)
    const topBefore = await el.property('scrollTop')

    // 逐组点标题收起来 —— 顶栏那个全局「展开过程」按钮已经删了，
    // 折叠只剩组标题这一个入口，判据必须走用户真正会走的那条路。
    // ⚠️ 下标要用**实际位置**：foldFixture 每轮是 turn/user/steps/text 四条交错，
    // steps 组并不在 0..7 上（我第一版按 0..7 点，只收掉了 2 组，判据自己写错了）。
    const idxs = (await page.data()).blocks.map((b, i) => (b.kind === 'steps' ? i : -1)).filter((i) => i >= 0)
    for (const i of idxs) {
      await page.callMethod('onToggleSteps', { currentTarget: { dataset: { idx: i } } })
    }
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
   * 过程块**默认渲染**：数据里有步骤组，渲染层也要出节点。
   *
   * 读的是 `page.$$('.steps-card').length` —— **渲染层**节点数，不是 data 里的块数。
   * 两者混了这条断言就白写：data 与渲染层本来就是两件事（关掉渲染不能坏落块，
   * 审批要知道主机在调什么、回放要对得上 callId）。
   *
   * ⚠️ 这里**不许 setData({showSteps: …})**。写上去就等于自己把开关按住了：
   * 探针会一直绿，而页面早就是"过程不显示"的了 —— 我就这么被骗过一次
   * （把 SHOW_STEPS 改回 false，这条判据仍然 5/5 全绿）。
   * 要验的是**默认行为**，所以只摆 blocks，让 showSteps 保持页面自己的初值，
   * 并且把那个初值本身也断言出来。
   *
   * 顺带盯住那个空提示条：wx:elif 条件为假会落到末尾的 wx:else，
   * 于是每个步骤组变成一个空 note —— 页面上会多出一排空行。
   */
  steps: async (page) => {
    await page.setData({ blocks: foldFixture(4, true, 3) })
    await page.waitFor(1200)

    const data = await page.data()
    const groups = data.blocks.filter((b) => b.kind === 'steps')
    const cards = (await page.$$('.steps-card')).length
    const bars = (await page.$$('.steps-bar')).length
    const notes = (await page.$$('.note')).length
    const replies = (await page.$$('.reply')).length

    // 量宽度：automator 的 Element **没有** boundingClientRect，只有 offset()+size()，
    // 而且 size() 返回的是**字符串**（'280px'），不 parseFloat 会让比较变 NaN → 判据恒红。
    const widthOf = async (sel) => {
      const el = await page.$(sel)
      if (!el) return 0
      const box = await el.size()
      return parseFloat(box && box.width) || 0
    }
    const replyW = await widthOf('.reply')
    const stepsW = await widthOf('.steps-card')
    // 内容区宽度 = 每个 block 的外框（.blk 与 .reply/.steps-card 同宽，都是 .pad 的子级）。
    // 注意别写 .msg —— 页面上没有这个类，量不到就是 0，判据会假红。
    const threadW = await widthOf('.blk')

    return [
      [data.showSteps === true, `默认要显示过程（页面初值 showSteps=${data.showSteps}）—— 收起一行摘要、展开看细节`],
      [groups.length === 4, `data 里有 ${groups.length} 个步骤组`],
      [cards === 4, `过程卡要真的渲染出来（数到 ${cards} 张）—— 判据没按 showSteps 才有意义`],
      [bars === 4, `每一组都要有那一行（数到 ${bars} 个）`],
      [notes === 0, `不许掉进 note 分支变成空提示条（数到 ${notes} 个）`],
      [replies === 4, `正文要照常渲染（${replies} 条回复）`],

      // 宽度必须量在**渲染层**：读 CSS 源码只能证明"我写了什么"，
      // 只有量到真实像素才能证明"它真的和过程卡一样宽"。
      // 这里量的是卡片外框宽度（.reply / .steps-card），不是内部文字的排版宽度。
      [replyW > 0 && Math.abs(replyW - stepsW) <= 1,
        `正文卡要和过程卡同宽（正文 ${replyW}px vs 过程 ${stepsW}px，差${Math.abs(replyW - stepsW)}px）`],
      [replyW >= threadW - 1,
        `正文卡要通栏，宽度贴住内容区（正文 ${replyW}px vs 内容区 ${threadW}px）`],
    ]
  },
  /**
   * 模型：**顶栏里的一段只读小字**。
   *
   * 这一代主机内核的 `agentDefaultModel` 上只有 `currentSelection`（取证：
   * status.json 的 `modelFace = no-list+no-set via=currentSelection`），
   * 既列不出候选也换不了。所以这里判的是「弱化、不可点、没有手势」——
   * 长得像能点却换不了，用户只能反复点它来判断是不是自己手机坏了。
   *
   * ⚠️ 不许 `setData({modelName})` 直接塞：那会跳过 `_onModel` 的截断逻辑，
   * 判出来的是"我塞进去的东西显示出来了"。这里走页面自己的 `_onModel`。
   */
  'bar-model': async (page) => {
    await page.setData({ blocks: foldFixture(1, true, 2), atBottom: true })
    // 没给 modelName 时顶栏不该留一段空白
    await page.callMethod('onShow')
    await page.waitFor(300)
    const idleNames = (await page.$$('.bar-model')).length

    await page.callMethod('_onModel', {
      t: 'ev.model',
      model: 'deepseek-chat',
      provider: 'deepseek',
      canSwitch: false,
      reason: '主机内核只提供读取',
    })
    await page.waitFor(300)

    const el = await page.$('.bar-model')
    const nameText = el ? await el.text() : ''
    // ⚠️ automator 的 `style()` **只接受单个属性名**：传数组或空参数都会抛
    // "name must be a string"（底层的 getter 支持数组，但 style 自己先拦了）。
    // 所以只能逐个读。
    const style = el
      ? {
          size: await el.style('font-size'),
          color: await el.style('color'),
          bg: await el.style('background-color'),
        }
      : null
    const barEl = await page.$('.bar-text')
    const barTextStyle = barEl
      ? { size: await barEl.style('font-size'), color: await barEl.style('color') }
      : null

    // 「弱化」必须量在渲染层：字号更小、颜色更浅。断言只查 data 字段的话，
    // 改成一个跟状态文字一样大的胶囊也会全绿。
    const size = parseFloat(String(style && style.size) || '0')
    const barSize = parseFloat(String(barTextStyle && barTextStyle.size) || '0')
    // 不可点：模型只占顶栏的一段，不带自己的手势
    const inBar = (await page.$$('.bar .bar-model')).length
    const modelBg = String((style && style.bg) || 'rgba(0, 0, 0, 0)')

    return [
      [idleNames === 0, `主机还没给模型时顶栏不该留白（数到 ${idleNames} 段）`],
      [inBar === 1, `模型名要在顶栏里，与「已连接」同一行（数到 ${inBar} 段）`],
      [nameText === 'deepseek-chat', `要显示模型名（读到「${nameText}」）`],
      [
        modelBg === 'rgba(0, 0, 0, 0)' || modelBg === 'transparent',
        `模型不能有胶囊底色 —— 胶囊这套语言就是在说"这里能点"（读到 ${modelBg}）`,
      ],
      [size > 0 && barSize > 0 && size < barSize, `模型字号要比状态文字小（${size} vs ${barSize}）`],
      [
        style && style.color && style.color !== barTextStyle.color,
        `模型颜色要比状态文字浅（${style && style.color} vs ${barTextStyle.color}）`,
      ],
    ]
  },
  /**
   * 「思考中…」的落点：live 步骤组的实时标签，**不再单独占一行**。
   *
   * 判据落在渲染层：数 `.runbar` 节点必须为 0，读 live 步骤组的 `.steps-label`
   * 文字，并确认顶栏不含运行态文案。运行条删掉之后，"它还在动"全靠这条标签 ——
   * 所以这里要判的是"标签真的在、说的是思考中"，不是"顶栏没有那句"。
   *
   * ⚠️ 不许 setData({barText}) / setData({steps[0].label})：那是自己把要说的话按住了，
   * 判据就废了一半。这里只摆 blocks 与 running，然后走页面自己的 onShow 链。
   */
  'run-live-label': async (page) => {
    // ⚠️ live 标签**不能**靠 setData 摆出来：`foldFixture` 里的 `live` 是写死的
    // false，而 setData 不经过 `decorateSteps`，那个派生字段永远算不出来。
    // 硬塞一个 `live: true` 进去等于自己按住开关再检查它 —— 判据就废了一半。
    // 这里走页面自己的链：填输入框 → onSend → 送一帧 ev.run_state。
    // `sessionId` 必须一起给：onSend 第一道门就是它，缺了会静默 return，
    // 后面两条判据会以"没有组"的形式红掉，看着像渲染问题。
    await page.setData({ sessionId: 's1', inputText: '查一下这个仓库的完成度', atBottom: true })
    await page.callMethod('onSend')
    await page.waitFor(400)
    await page.callMethod('_onEvent', {
      kind: 'payload',
      payload: { t: 'ev.run_state', sessionId: 's1', state: 'running' },
    })
    await page.waitFor(900)

    const data = await page.data()
    const bars = (await page.$$('.runbar')).length
    const barText = await (await page.$('.bar-text')).text()
    const labels = await page.$$('.steps-label')
    let liveLabel = ''
    for (const l of labels) {
      if (((await l.attribute('class')) || '').includes('live')) liveLabel = await l.text()
    }
    // 顶栏的中断按钮：刚发出去、正文还空着的时候，这是运行态唯一的可见落点
    const stops = (await page.$$('.bar-stop')).length

    return [
      [bars === 0, `运行条已经删了，不该还渲染出节点（数到 ${bars} 条）`],
      [
        /^思考中 \d/.test(liveLabel),
        `live 步骤组的标签要说出"它还在动"，且带上耗时（读到「${liveLabel}」）`,
      ],
      [stops === 1, `运行中顶栏要有中断按钮（数到 ${stops} 个）——正文空着时它是唯一的信号`],
      [!barText.includes('思考'), `顶栏不许出现运行态文案（读到 ${JSON.stringify(barText)}）`],
      [!/思考|运行中/.test(data.barText), `barText 由 _renderBar 算出且不含运行态（${JSON.stringify(data.barText)}）`],
    ]
  },
  /**
   * 「只有 think」的组（plain）就是**一行状态**，不多给任何东西。
   *
   * 判据全在渲染层：数 `.steps-chev`、`.steps-card`、`.step-think` 节点，
   * 再读那行文字。数据层 `plain === 1` 只能证明"页面算对了"，
   * 证明不了"界面上真的没画出那些东西" —— 而后者才是用户看到的。
   *
   * ⚠️ 不许 `setData({open: true})` 之外再去点一次来"制造"折叠态：
   * 卡片那一支已经带 `!item.plain`，这里要判的是**渲染结果**，
   * 不是数据字段。
   */
  'plain-think-row': async (page) => {
    await page.setData({ sessionId: 's1', inputText: '查一下这个仓库的完成度', atBottom: true })
    await page.callMethod('onSend')
    await page.waitFor(400)
    await page.callMethod('_onEvent', {
      kind: 'payload',
      payload: { t: 'ev.run_state', sessionId: 's1', state: 'running' },
    })
    await page.waitFor(900)

    const data = await page.data()
    const g = data.blocks.filter((b) => b.kind === 'steps').at(-1)
    const bars = await page.$$('.steps-bar')
    const plainBars = await page.$$('.steps-bar-plain')
    // ⚠️ 一行写成 `(await page.$$('.steps-chev')).length` 时，**运行时**报过
    //   "chews is not defined"（声明就在同一作用域，源码与 node --check 都查不出问题）。
    // 拆成两步后不复现。这里保留注释是因为"查不出来的玄学"很容易被下一个人
    // 当成幻觉顺手改回一行 —— 那就又踩一遍。
    const chevEls = await page.$$('.steps-chev')
    const cards2 = (await page.$$('.steps-card')).length
    const thinkRows2 = (await page.$$('.step-think')).length
    // automator 的 Element **没有 parent()**，只能从选择器直接命中目标节点。
    const plainLabelEl = await page.$('.steps-bar-plain .steps-label')
    const plainLabel = plainLabelEl ? await plainLabelEl.text() : ''

    return [
      [!!g && g.plain === 1, `这一步组没有工具，应当是纯状态行（读到 plain=${g && g.plain}）`],
      [bars.length > 0 && plainBars.length === bars.length, `每个组标题都要走 plain 那一支（${plainBars.length}/${bars.length}）`],
      [chevEls.length === 0, `plain 组不该有下拉箭头 —— 它里面根本没有可展开的东西（数到 ${chevEls.length} 个）`],
      [cards2 === 0, `plain 组不该渲染卡片（数到 ${cards2} 个）`],
      [thinkRows2 === 0, `「思考中 4.0s」那条冗余状态行不该再单独出现（数到 ${thinkRows2} 行）`],
      [/^思考中 \d/.test(plainLabel), `耗时要并进标题那一行（读到「${plainLabel}」）`],
    ]
  },
  /** 跑完之后运行态要消失：live 标签收掉、中断按钮收掉，不能一直挂着"在跑" */
  'run-idle': async (page) => {
    await page.setData({ blocks: foldFixture(1, true, 2), running: false, atBottom: true })
    await page.waitFor(700)
    const bars = (await page.$$('.runbar')).length
    const stops = (await page.$$('.bar-stop')).length
    const labels = await page.$$('.steps-label')
    let live = 0
    for (const l of labels) {
      if (((await l.attribute('class')) || '').includes('live')) live += 1
    }
    return [
      [bars === 0, `空闲时不留运行条（数到 ${bars} 条）`],
      [stops === 0, `空闲时不留中断按钮（数到 ${stops} 个）`],
      [live === 0, `空闲时没有 live 步骤组（数到 ${live} 个）`],
    ]
  },
  /**
   * 发送按钮：**文字按钮，不是图标**。
   *
   * 原来那个圆形键配 CSS 三角，看着干净，但用户第一眼分不清"这个圆是能点的
   * 还是装饰"—— 而它是发消息的唯一入口。现在改成「发送」两个字。
   *
   * 判据落在渲染层：读按钮里的文字、量它的宽高。宽度要够（88rpx 的圆形键
   * 换成文字后必须仍能舒展地放下两个字，且点击区不小于 44px 逻辑尺寸），
   * 高度要与输入框齐平 —— 矮一截会显得像附属品。
   */
  send: async (page) => {
    await page.setData({ blocks: foldFixture(1, true, 2), inputText: '', atBottom: true })
    await page.waitFor(300)

    const btn = await page.$('.composer-send')
    const label = btn ? await btn.$('.send-label') : null
    const labelText = label ? await label.text() : ''
    const size = btn ? await btn.size() : null
    const pill = await page.$('.composer-pill')
    const pillSize = pill ? await pill.size() : null
    // 图标版本留下的痕迹：CSS 三角的那个空 div
    const arrows = (await page.$$('.send-arrow')).length

    const w = size ? parseFloat(size.width) : 0
    const h = size ? parseFloat(size.height) : 0
    const ph = pillSize ? parseFloat(pillSize.height) : 0
    const labelSize = label ? await label.size() : null
    const lw = labelSize ? parseFloat(labelSize.width) : 0

    return [
      [labelText.trim() === '发送', `发送按钮要有文字（读到「${labelText.trim()}」）`],
      [arrows === 0, `不该再有 CSS 画的三角图标（数到 ${arrows} 个）`],
      // 「放得下两个字」的正确判据是**文字没被挤**：按钮比文字宽出内边距的量。
      // 拍一个绝对下限（如 88px）是把某台机型上的像素当规范 —— 换机型就假红。
      [w > 0 && lw > 0 && w > lw, `按钮要比文字宽，左右留得出内边距（按钮 ${w}px / 文字 ${lw}px）`],
      [h >= 44, `按钮高度不能小于 44px 的可点下限（读到 ${h}px）`],
      [ph === 0 || Math.abs(h - ph) <= 2, `按钮要与输入框齐平（按钮 ${h}px / 输入框 ${ph}px）`],
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

    // ⚠️ **先归一到浅色**。主题在 `wx` 本地存储里、跨探针共享，而这一组判的是
    // 「默认浅色 → 切深色 → 切回浅色」；上一组（`md-dark`）跑完会留下深色，
    // 于是这里一开始就在深色：13 条里 11 条红，每一条都在说"不是浅色啊" ——
    // **看起来像代码坏了，其实是我自己没归一**。
    // 这条与 `md-dark` 开头那段归一是同一件事，两处都要写，不能只写一处：
    // 谁先跑谁都能遇到对方留下的状态。
    for (let i = 0; i < 3; i++) {
      if ((await p.data()).themeName === 'light') break
      await p.callMethod('onToggleTheme')
      await p.waitFor(500)
    }
    if ((await p.data()).themeName !== 'light') {
      return [[false, `主题归一到浅色失败（themeName=${(await p.data()).themeName}）—— 别改代码，先查存储`]]
    }

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

  /**
   * Markdown 正文：**在渲染层真的有内容**。
   *
   * 这组判据是被一个真 bug 逼出来的：`rich-text` 的 `nodes` 绑了 `wx:for`
   * 作用域里的变量（`item.mdParts[i]`）时，它渲染成**高度 0 的空块** ——
   * 界面上正文整段消失，而 data、单测、e2e **全绿**。
   * 截图上看得见：`.reply` 有卡片（那是 padding），里面什么都没有。
   *
   * ⚠️ 这正是「判据必须落在渲染层」那条的又一个例子：那一轮所有能自动跑的
   * 判据都是绿的，唯一抓住它的是 `el.size()` 读到的 **height 0**。
   *
   * 判据读的是**渲染层节点的尺寸与计算样式**，不是 data 里的 nodes ——
   * data 对而界面空，正是这个 bug 的形状。
   *
   * ⚠️ 不许 `setData({mdBodies})` 自己塞：那会跳过 `_commit`，判出来的是
   * "我塞进去的东西显示出来了"。这里走页面自己的链：onSend → ev.message_delta。
   * `sessionId` 必须给：onSend 第一道门就是它，缺了会静默 return。
   */
  md: async (page) => {
    const MD = [
      '# 结论',
      '',
      '这是**重点**，还有 `inline` 与 [链接](https://example.com)。',
      '',
      '| 列A | 列B | 列C |',
      '| --- | --- | --- |',
      '| 一 | 二 | 三 |',
      '',
      '- 列表一',
      '- 列表二',
      '',
    ].join('\n')

    await page.setData({ sessionId: 's1', inputText: '给我一份结论', atBottom: true })
    await page.callMethod('onSend')
    await page.waitFor(400)
    await page.callMethod('_onEvent', {
      kind: 'payload',
      payload: { t: 'ev.message_delta', sessionId: 's1', messageId: 'm1', role: 'assistant', delta: MD, done: true },
    })
    await page.waitFor(1500)

    const data = await page.data()
    const bodies = await page.$$('.md-body')
    const replyEl = await page.$('.reply')
    const reply = replyEl ? await replyEl.size() : null
    // ⚠️ 判据里不许写死绝对像素下限（换机型就假红）。这里用**相对关系**：
    // 有内容的 rich-text 必然比「只有 padding 的空壳」高得多，而空壳的高度
    // 就等于卡片内边距之和 —— 用同一张卡片上另一个已知矮的节点做基准更稳。
    // 直接取「> 0」不够：空块是 0，有内容是几十上百，量级差着 30 倍以上。
    const h = bodies.length ? parseFloat((await bodies[0].size()).height) || 0 : 0
    const replyH = reply ? parseFloat(reply.height) || 0 : 0
    // wxml 的 `wx:if` 走的是 `mdBodies[item.key].length`，所以 data 里必须有
    const mapKeys = Object.keys(data.mdBodies || {})
    // 参照物：`.caret` 是 4rpx 宽的光标，`height:30rpx`。正文有内容时
    // 必然远高于它；空块是 0。这个基准与机型无关（都是 rpx 定的）。
    const caret = await page.$('.caret')
    const caretH = caret ? parseFloat((await caret.size()).height) || 0 : 0

    return [
      [bodies.length === 1, `每个 text 块只渲染一个 rich-text（数到 ${bodies.length} 个）—— 多于一个说明回到按段落循环了`],
      [
        h > 0 && (caretH === 0 || h > caretH),
        `rich-text 必须真的有高度（读到 ${h}px，光标基准 ${caretH}px）—— **0 就是"nodes 绑循环项了"那个 bug 的形状**：data 里有 nodes、界面上是空的`,
      ],
      [
        replyH > h,
        `卡片要装得下 rich-text（卡片 ${replyH}px / 正文 ${h}px）`,
      ],
      [mapKeys.length >= 1, `mdBodies 里要有这一块（keys=${JSON.stringify(mapKeys)}）`],
      // 表格与正文同一个 rich-text：表格留在了 nodes 里（列宽按百分比），
      // 所以 `.md-table-scroll` 应该是 0 —— 它已不再被使用
      [(await page.$$('.md-table-scroll')).length === 0, '表格不再单独包 scroll-view（那样要两层索引，必然渲染成空块）'],
    ]
  },

  /**
   * Markdown 在**深色**下的颜色。
   *
   * 颜色是 `core/markdown.js` 在渲染时算成**具体色值**写进 nodes 的
   * （`rich-text` 不认 `var()`，本项目真机踩过"深色下字全黑"）。
   * 这里断两件事：① nodes 里确实是亮色；② **nodes 随主题重算**。
   *
   * ② 是这一条真正的价值：切主题的按钮在 sessions 页，从那儿切回来时
   * chat 页的 nodes 还是按旧主题算的 —— 而 nodes 是「派生而不落库」的，
   * 不会自动重算。不判这一条，症状是"深色卡片上压着浅色主题的字"。
   */
  'md-dark': async (page, mini) => {
    const MD = '正文一段，另有一段 **粗体**。\n\n| 列A | 列B |\n| --- | --- |\n| 一 | 二 |\n'

    // ⚠️ **先归一到浅色，再开始**。
    // 主题存在 `wx` 的本地存储里，是**跨探针共享**的：上一轮跑完若留在深色，
    // 这一轮那个 `onToggleTheme` 就把它切回浅色，于是「切到深色」那条判据
    // 报出 `themeName=light` —— **假红，而且与被测代码无关**。
    // 我就是这么被骗了一轮（反证时 5 条一起红，差点当成"改坏了"）。
    //
    // ⚠️ 归一必须在**拿 `page` 句柄之前**做完：`reLaunch` 会作废所有旧句柄，
    // 之后再用那个 `page` 会报 "page is not on top of page stack"。
    await mini.reLaunch('/pages/sessions/sessions')
    const sp0 = await mini.currentPage()
    await sp0.waitFor(600)
    for (let i = 0; i < 3; i++) {
      if ((await sp0.data()).themeName === 'light') break
      await sp0.callMethod('onToggleTheme')
      await sp0.waitFor(500)
    }
    if ((await sp0.data()).themeName !== 'light') {
      return [[false, `主题归一到浅色失败（themeName=${(await sp0.data()).themeName}）—— 别改代码，先查存储`]]
    }

    // 从 sessions 进 chat（走真实的进入路径），下面全程用 `cp` 这个句柄
    await mini.navigateTo('/pages/chat/chat?id=probe-md-dark')
    const cp = await mini.currentPage()
    await cp.waitFor(700)

    // 浅色下先排一次版，拿到"浅色主题的 nodes"作为对照
    await cp.setData({ sessionId: 's1', inputText: '看深色', atBottom: true })
    await cp.callMethod('onSend')
    await cp.waitFor(300)
    await cp.callMethod('_onEvent', {
      kind: 'payload',
      payload: { t: 'ev.message_delta', sessionId: 's1', messageId: 'm1', role: 'assistant', delta: MD, done: true },
    })
    await cp.waitFor(1200)
    const lightNodes = JSON.stringify((await cp.data()).mdBodies || {})

    // 去 sessions 页切深色，再**回到同一个 chat 页实例** ——
    // ⚠️ 必须 `navigateBack` 回原实例，不能 `navigateTo` 开新页：
    // 新页是首次加载，压根没有"已排好版的 nodes 要重排"这回事，
    // 那样测的是"新页面按新主题排版"（本来就对），不是这里要验的东西。
    await mini.navigateTo('/pages/sessions/sessions')
    const sp = await mini.currentPage()
    await sp.waitFor(600)
    await sp.callMethod('onToggleTheme')
    await sp.waitFor(800)
    const spData = await sp.data()

    await mini.navigateBack()
    const dp = await mini.currentPage()
    await dp.waitFor(900)
    // navigateBack 不会替我们调 onShow（探针不做生命周期），自己叫一次，
    // 模拟系统把这一页切回前台 —— `_retheme` 就挂在那儿
    await dp.callMethod('onShow')
    await dp.waitFor(1200)

    const darkData = await dp.data()
    const darkNodes = JSON.stringify(darkData.mdBodies || {})
    const rootClass = String((await (await dp.$('.chat-wrap')).attribute('class')) || '')
    const el = await dp.$('.md-body')
    const h = el ? parseFloat((await el.size()).height) || 0 : 0

    // 浅色的正文色 #181818 → 深色必须换掉（#e8e8e8）
    const lightHasDarkInk = /#181818|#7a7a7a|#0052d9|#f3f3f3|#fafafa|#e5e5e5/i.test(lightNodes)
    const darkHasLightInk = /#e8e8e8|#9a9a9a|#5a9bff|#242424|#1e1e1e|#3a3a3a/i.test(darkNodes)
    const darkHasLightInkGone = !/#181818|#0052d9/i.test(darkNodes)

    return [
      [spData.themeName === 'dark', `sessions 页切到深色（themeName=${spData.themeName}）`],
      [rootClass.includes('theme-dark'), `chat 页根容器挂上 theme-dark（class="${rootClass.trim()}"）`],
      // 同样用相对判据：0 高度是那个 bug 的形状，非 0 就说明渲染了
      [h > 0, `深色下 rich-text 一样要有内容（${h}px）—— 0 就是空块`],
      [lightHasDarkInk, '浅色下 nodes 里应是浅色主题的色值（sanity：证明取到过色）'],
      [darkHasLightInk, '深色下 nodes 里应换成深色主题的色值'],
      [
        darkHasLightInkGone,
        '深色下不许还留着浅色主题的色值 —— 那是「切了主题但 nodes 没重算」（颜色烘焙在 nodes 里）',
      ],
    ]
  },
}

/**
 * 把全局主题拨回浅色。
 *
 * 为什么需要它：主题存在 `wx` 本地存储里，**同一台模拟器上所有探针共享**。
 * 谁改了不还原，后面的探针就替它背锅 —— 2026-10-04 一次全量跑，
 * `theme` 那组 13 条红了 11 条，每一条都在喊"不是浅色"，而代码是好的。
 *
 * 探针自己会做归一（各组开头那个 for 循环）的话，这一个就是双保险；
 * 但**别只靠开头归一** —— 单跑一组时更该保证跑完不污染现场。
 */
async function resetThemeLight(mini) {
  await mini.reLaunch('/pages/sessions/sessions')
  const p = await mini.currentPage()
  await p.waitFor(500)
  for (let i = 0; i < 3; i++) {
    if ((await p.data()).themeName === 'light') return true
    await p.callMethod('onToggleTheme')
    await p.waitFor(400)
  }
  return (await p.data()).themeName === 'light'
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
  ]
  if ((data.sessions || []).length) {
    targets.push(['.sess-title', '会话标题'], ['.sess-sub', '会话路径'])
  }

  // 防休眠是**下线**了，但"下线"也得有判据：不然哪天有人顺手加回来，
  // 没人会发现。判据落在渲染层 —— 数节点，不是读 data 字段。
  out.push([
    (await page.$$('.keep-title')).length === 0 && (await page.$$('.keep-desc')).length === 0,
    '防休眠开关不许回到主机卡上',
  ])

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
        `  /Applications/wechatwebdevtools.app/Contents/MacOS/cli auto --project "${ROOT}/dsh-remote-mp" --trust-project --auto-port ${PORT}`,
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
      // ⚠️ 每组跑完把**全局状态**归位，不靠各组自觉。
      // 主题存在 `wx` 本地存储里、同一台模拟器上共享：不归位的话，下一组
      // 任何"默认浅色"的判据都会一片红，而那些红与它们要验的代码毫无关系
      // —— `md-dark` 跑完留下深色，紧随其后的 `theme` 就 13 条红了 11 条，
      // 看起来像代码坏了。**在这里归位，各组就都自由了**（单跑一组也干净）。
      if (!(await resetThemeLight(miniProgram))) {
        console.log('   ! 全局主题没能还原成浅色，下一组可能假红')
        failed += 1
        total += 1
      }
    }
  } finally {
    await miniProgram.disconnect()
  }
  console.log(`\n探针 ${names.length} 组，判据 ${total - failed}/${total} 成立`)
  process.exit(failed ? 1 : 0)
}

await main()
