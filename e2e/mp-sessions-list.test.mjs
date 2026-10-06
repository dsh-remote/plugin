/**
 * mp-sessions-list — sessions 页会话列表的对照测试。
 *
 * 核心是一条产品决定：**归档会话不显示**（主机对它们的每一步都直接拒绝，
 * 列出来只会让人点了才发现没用），但也不能悄无声息地消失 ——
 * 底部要留一句「已隐藏 N 个」，否则用户会以为会话丢了。
 */
import { createRequire } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 主题与系统栏调用：存的是深色，导航栏/回弹区的每次调用都记账（onShow 要重设）。
const barCalls = []
globalThis.wx = {
  getStorageSync: (k) => (k === 'drc.theme.v1' ? 'dark' : ''),
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: () => {},
  navigateTo: () => {},
  stopPullDownRefresh: () => {},
  setNavigationBarColor: (o) => barCalls.push({ kind: "nav", front: o.frontColor, bg: o.backgroundColor }),
  setBackgroundColor: (o) => barCalls.push({ kind: "bg", bg: o.backgroundColor, top: o.backgroundColorTop }),
  createSelectorQuery: () => ({
    select: () => ({
      boundingClientRect: (cb) => {
        if (cb) cb({ height: 600 })
      },
      exec: () => {},
    }),
  }),
}


let captured = null
globalThis.Page = (cfg) => {
  captured = cfg
}
require(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/sessions/sessions.js'))
assert.ok(captured, 'Page() 没被调用 —— 页面代码没加载起来')

function makePage() {
  const ctx = { ...captured }
  ctx.data = JSON.parse(JSON.stringify(captured.data))
  ctx.setData = (patch) => {
    for (const p in patch) ctx.data[p] = patch[p]
  }
  return ctx
}

const ids = (ctx) => ctx.data.sessions.map((s) => s.id)

test('归档会话被过滤掉，数量与说明都对得上', () => {
  const p = makePage()
  p._renderSessions([
    { id: 'a', title: '正常会话', state: 'idle', updatedAt: '2026-10-02T08:00:00.000Z' },
    { id: 'b', title: '归档会话 1', state: 'archived' },
    { id: 'c', title: '运行中', state: 'running', running: true },
    { id: 'd', title: '归档会话 2', state: 'archived' },
  ])
  // 2026-10-04 起列表按四级排序：都在空目录组、c 在跑 → c 在前
  assert.deepEqual(ids(p), ['c', 'a'], '归档的不能出现在列表里；剩下的按运行中优先排')
  assert.equal(p.data.hiddenArchived, 2)
  assert.equal(p.data.hiddenText, '已隐藏 2 个归档会话', '不能悄无声息地少掉，要留一句话')
})

test('没有归档时不显示说明', () => {
  const p = makePage()
  p._renderSessions([{ id: 'x', state: 'idle' }])
  assert.equal(p.data.hiddenArchived, 0)
  assert.equal(p.data.hiddenText, '')
})

test('空列表与非归档状态不报错', () => {
  const p = makePage()
  p._renderSessions([])
  assert.deepEqual(p.data.sessions, [])

  p._renderSessions([{ id: 'y', state: 'awaiting-permission' }, { id: 'z', state: 'detached' }])
  assert.deepEqual(ids(p), ['y', 'z'])
  assert.deepEqual(
    p.data.sessions.map((s) => s.badgeText),
    ['待审批', '未加载'],
  )
})

/* ── 工作区 tag + 四级排序（2026-10-04 用户要的）────────────────────────── */

test('排序：工作区 → 运行中优先 → 时间新的在前 → 名称；空目录排最后', () => {
  const p = makePage()
  p._renderSessions([
    // 故意乱序：同工作区内跨状态、跨时间；再加一个空目录的插在中段
    { id: 'b1', title: '乙项目旧会话', workspace: '/w/b', state: 'idle', updatedAt: '2026-10-01T10:00:00.000Z' },
    { id: 'a2', title: '甲项目运行时', workspace: '/w/a', state: 'running', running: true, updatedAt: '2026-10-03T09:00:00.000Z' },
    { id: 'none', title: '没目录的', workspace: '', state: 'running', running: true, updatedAt: '2026-10-04T09:00:00.000Z' },
    { id: 'a1', title: '甲项目新会话', workspace: '/w/a', state: 'idle', updatedAt: '2026-10-04T08:00:00.000Z' },
    { id: 'a3', title: '甲项目 B', workspace: '/w/a', state: 'idle', updatedAt: '2026-10-01T10:00:00.000Z' },
    { id: 'b2', title: '乙项目新会话', workspace: '/w/b', state: 'idle', updatedAt: '2026-10-04T07:00:00.000Z' },
    { id: 'b3', title: '乙项目运行中', workspace: '/w/b', state: 'running', running: true, updatedAt: '2026-10-01T06:00:00.000Z' },
    { id: 'a4', title: '甲项目 A', workspace: '/w/a', state: 'idle', updatedAt: '2026-10-01T10:00:00.000Z' },
  ])
  assert.deepEqual(
    ids(p),
    // 甲项目：运行中第一，然后新的在前，同一秒的两个按名称定序（A/B 结尾，不赌 collation 对中文的口径）
    ['a2', 'a1', 'a4', 'a3',
     // 乙项目：同样先运行中，再新的在前
     'b3', 'b2', 'b1',
     // 空目录最后（哪怕它更新最新、还在运行）
     'none'],
    '四级排序：工作区 → 状态 → 时间 → 名称',
  )
})

test('工作区 tag：完整路径取最后一段，空路径不出 chip；sortAt 不进渲染数据', () => {
  const p = makePage()
  p._renderSessions([
    { id: 'a', title: '一', workspace: '/Users/linbin/dsh-remote-control', state: 'idle' },
    { id: 'b', title: '二', workspace: '/Users/linbin/proj/', state: 'idle' },
    { id: 'c', title: '三', workspace: '', state: 'idle' },
  ])
  const byId = Object.fromEntries(p.data.sessions.map((s) => [s.id, s]))
  assert.equal(byId.a.workspaceTag, 'dsh-remote-control')
  assert.equal(byId.b.workspaceTag, 'proj', '目录末尾的斜杠要能容忍')
  assert.equal(byId.c.workspaceTag, '', '没挂目录的会话不出 chip')
  assert.equal(byId.a.workspace, '/Users/linbin/dsh-remote-control', '完整路径还在，只是弱化显示')
  for (const s of p.data.sessions) {
    assert.ok(!('sortAt' in s), '排序用的原始时间戳不该进渲染层（两处口径会分叉）')
  }
})

test('wxml/wxss：路径去掉只留项目名；项目是品牌色圆点 + 24rpx 深灰文字', () => {
  const { readFileSync } = require('node:fs')
  const page = path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/sessions')
  const wxml = readFileSync(path.join(page, 'sessions.wxml'), 'utf8')
  const wxss = readFileSync(path.join(page, 'sessions.wxss'), 'utf8')

  // ① 路径整个去掉（2026-10-05 用户：去掉路径只保留项目标签）。
  //    不再渲染 workspace 全路径，也不再有 .sess-sub 这条规则。
  assert.ok(!wxml.includes('sess-sub'), '全路径不许再渲染：用户要求只保留项目名')
  assert.ok(!/\.sess-sub\s*\{/.test(wxss), '.sess-sub 规则要删掉')

  // ② 项目名换成 圆点 + 文字，不再是胶囊（用户：不一定要用标签形式）。
  //    所以 .sess-tag / border / padding / border-radius 那套全不许回来。
  assert.ok(!wxml.includes('sess-tag'), '胶囊形态的 class 不许回来')
  assert.ok(!/\.sess-tag\s*\{/.test(wxss), '.sess-tag 规则要删掉')
  assert.match(
    wxml,
    /<view[^>]*class="sess-project">[\s\S]*?<view class="sess-project-dot"><\/view>[\s\S]*?<text class="sess-project-name ellipsis">/,
    '第二行 = 圆点 + 项目名文字（不再是 pill）',
  )

  // ③ 强化在字号和字色：24rpx 比原来的 20rpx 大一档，字色深一档。
  //    层级必须是 标题30 > 项目24 > 时间20，反了就是在抢标题。
  const nameRule = (wxss.match(/\.sess-project-name\s*\{([^}]*)\}/) || [, ''])[1]
  assert.ok(nameRule.length > 0, '找不到 .sess-project-name 规则')
  assert.match(nameRule, /font-size:\s*24rpx/, '项目名要 24rpx（原胶囊只有 20rpx）')
  assert.match(
    nameRule,
    /--td-text-color-secondary/,
    '项目名字色要用 secondary（比 placeholder 深一档，读得清）',
  )
  assert.match(
    wxss,
    /\.sess-title\s*\{[^}]*font-size:\s*30rpx/,
    '标题要维持 30rpx：项目名不能反超标题',
  )
  assert.match(
    wxss,
    /\.sess-time\s*\{[^}]*font-size:\s*20rpx/,
    '时间要维持 20rpx：三级层级 标题>项目>时间',
  )

  // ④ 圆点是 CSS 画的实心圆（不用图标字体——真机缺字形）。
  assert.match(wxss, /\.sess-project-dot\s*\{[^}]*border-radius:\s*50%/, '圆点要画成正圆')
  assert.match(wxss, /\.sess-project-dot\s*\{[^}]*background:/, '圆点要有实心底色')

  // ⑤ 项目名可收缩（长名字不能把时间戳顶出屏幕）。
  assert.match(nameRule, /min-width:\s*0/, '项目名要能收缩')
  assert.match(nameRule, /text-overflow:\s*ellipsis/, '项目名超长要省略')

  // ⑥ 时间戳贴最右。靠 margin-left:auto——路径去掉后第二行没有 flex:1 的项了，
  //    不写 auto 时间会紧贴在项目名后面。
  assert.match(wxss, /\.sess-time\s*\{[^}]*margin-left:\s*auto/, '时间要靠 auto 外边距顶到行尾')
})


test('系统栏每次 onShow 都要重设：从 chat 返回时微信会用静态白把顶栏冲掉（用户实测）', () => {
  const p = makePage()
  p.onLoad()
  assert.equal(barCalls.length > 0, true, 'onLoad 至少要设一次（首屏上色）')
  const lastNav = barCalls.filter((c) => c.kind === 'nav').pop()
  assert.deepEqual(lastNav, { kind: 'nav', front: '#ffffff', bg: '#242424' }, '深色下导航栏要深底白字')
  const afterLoad = barCalls.length
  // 从别的页返回：onLoad 不再跑（页面实例活着），微信把静态配色（app.json 的 #ffffff）盖回来
  p.onShow()
  assert.ok(barCalls.length > afterLoad, 'onShow 必须再设一次系统栏，否则返回这一页头顶是白的')
  const navAfterShow = barCalls.filter((c) => c.kind === 'nav').pop()
  assert.deepEqual(navAfterShow, { kind: 'nav', front: '#ffffff', bg: '#242424' }, '返回这一页也要是深底白字')
  assert.equal(p.data.themeClass, 'theme-dark', 'class 也要在（页面本体跟着深色）')
})
test('状态徽标规则必须整套在：缺了 flex 容器，脉冲点会挤到文字上面', () => {
  const wxss = fs.readFileSync(
    path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/sessions/sessions.wxss'),
    'utf8',
  )
  // 1.1.18 改样式时把这一整块连坐删掉，只剩 .sess-badge.primary .pulse。
  // 后果：徽标退回普通块级盒子，里面的 .pulse 独占一行，
  // "运行中"被挤到下一行——用户看到的就是"运行中前面的点错位了，点跑上面去了"。
  const rule = (wxss.match(/\.sess-badge\s*\{([^}]*)\}/) || [, ''])[1]
  assert.ok(rule.length > 0, '.sess-badge 基础规则整块不见了（1.1.18 丢过一次）')
  assert.match(rule, /display:\s*flex/, '徽标必须是 flex 容器，否则圆点和文字会折行')
  assert.match(rule, /align-items:\s*center/, '必须垂直居中，点才会跟文字对齐')
  assert.match(rule, /padding:/, '徽标要有内边距，撑成胶囊')
  assert.match(rule, /border-radius:/, '徽标要圆角')
  assert.match(rule, /background:/, '徽标要填色——状态靠颜色说，不靠点')

  // 三个主题变体都要在，否则某些会话的徽标会褪成灰色
  for (const theme of ['primary', 'warning']) {
    assert.ok(
      new RegExp('\\.sess-badge\\.' + theme + '\\s*\\{').test(wxss),
      theme + ' 主题的徽标规则不见了',
    )
  }
})

test('一行只留一颗点：徽标里不放脉冲点，项目名那颗就够', () => {
  const wxml = fs.readFileSync(
    path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/sessions/sessions.wxml'),
    'utf8',
  )
  // 用户 2026-10-05：一行两个点看起来有点怪。原先徽标里有 pulse 圆点，
  // 第二行项目名左侧也有一颗——两颗点挨着两行，重复又晃眼。
  assert.ok(!wxml.includes('class="pulse"'), '徽标里不许再放脉冲点')
  // 项目名那颗要留着，它是"这是哪一间屋子"的视觉锚点
  assert.ok(wxml.includes('sess-project-dot'), '项目名圆点要留着')
})

test('死规则不许留下：没人引用的 .pulse 规则要删掉', () => {
  const wxss = fs.readFileSync(
    path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/sessions/sessions.wxss'),
    'utf8',
  )
  assert.ok(!/\.pulse\s*\{/.test(wxss), '.pulse 已无 wxml 引用，规则要删')
  // 但 dot-blink 是共享的（聊天页在跑圆点、顶栏连接点都在用），不能一起删
  const app = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/app.wxss'), 'utf8')
  assert.match(app, /@keyframes dot-blink/, 'dot-blink 是共享关键帧，要留在 app.wxss')
})

// ── 列表页的跨会话提示（2026-10-06：停在列表页时 chat 页不在，卡无处可弹） ──
//
// 现场：主机提问/等审批时用户停在会话列表，ev.question_request /
// ev.permission_request 到达后没有任何表现——主机阻塞等决定，手机毫无痕迹。
// chat 页跨会话已有 toast（另一条会话），列表页对称处理：不弹卡（卡属于某条会话），
// 但必须让人知道，点进对应会话即收原卡（原卡还在主机 pending 里，重配对还会重发）。

test('列表页：提问帧不许静默吞掉（给提示，点进会话即收原卡）', () => {
  const p = makePage()
  const toasts = []
  const original = wx.showToast
  wx.showToast = (opts) => toasts.push(opts.title)
  try {
    p._onEvent({
      kind: 'payload',
      payload: {
        t: 'ev.question_request',
        sessionId: 'ses_other',
        requestId: 'rq_other',
        questions: [{ id: 'q1', question: '要继续吗', options: [{ id: 'a', label: 'A' }] }],
      },
    })
    assert.equal(toasts.length, 1, '静默吞掉了：主机等着回答，停在列表页的用户完全不知道')
    assert.match(toasts[0], /提问/, '提示必须说清是什么事')
  } finally {
    wx.showToast = original
  }
})

test('列表页：审批帧与提问对称（不许静默吞掉）', () => {
  const p = makePage()
  const toasts = []
  const original = wx.showToast
  wx.showToast = (opts) => toasts.push(opts.title)
  try {
    p._onEvent({
      kind: 'payload',
      payload: { t: 'ev.permission_request', sessionId: 'ses_other', requestId: 'rq_other' },
    })
    assert.equal(toasts.length, 1, '静默吞掉了：主机白等 180 秒')
    assert.match(toasts[0], /审批/, '提示必须说清是什么事')
  } finally {
    wx.showToast = original
  }
})

// ── G5 链路活跃度（2026-10-06 下午）：最近一帧什么时候到的 ──
//
// 只说时间不说内容（零知识承诺）。每一帧载荷盖戳，15 秒 tick 重算显示，
// 状态走掉清掉——frozen 的"5 秒前"等于假事实。

test('G5：收到载荷就盖戳，主机卡那行拼出"刚刚有消息"', () => {
  const p = makePage()
  p.setData({ status: 'online' })
  p._onEvent({ kind: 'payload', payload: { t: 'ev.question_request', sessionId: 's1', requestId: 'r1' } })
  try {
    assert.equal(p.data.linkAgeText, ' · 刚刚有消息')
  } finally {
    p._stopLinkTick()
  }
})

test('G5：离线清掉（frozen 的"几秒前"等于假事实）', () => {
  const p = makePage()
  p.setData({ status: 'online', linkAgeText: ' · 刚刚有消息' })
  p._onEvent({ kind: 'status', status: 'idle' })
  try {
    assert.equal(p.data.linkAgeText, '', '断了还留着"刚刚有消息"，用户会以为链路还活着')
  } finally {
    p._stopLinkTick()
  }
})

test('G5：tick 只在页内跑（onHide/onUnload 必须停掉，否则带到别的页）', () => {
  const p = makePage()
  p._startLinkTick()
  assert.ok(p._linkTimer, 'tick 没起来')
  p.onHide()
  assert.equal(p._linkTimer, null, 'onHide 不停表，定时器会带到别的页继续 setData')
})

// ── G1 待办优先（2026-10-06 下午）：挂起的审批/提问抢首屏 ──
//
// 首屏必须是"有什么在等你"，不是"上次聊到哪儿"。awaiting 的会话在列表上方
// 另起「等你处理」区，每件带是哪条会话，点开即进（onOpen 同一套）。
// 下面完整列表照旧，两边是同一批数据。

test('G1：awaiting 的会话进"等你处理"区，完整列表照旧', () => {
  const p = makePage()
  p._renderSessions([
    { id: 's1', title: '跑着的活', state: 'running', updatedAt: '2026-10-06T10:00:00' },
    { id: 's2', title: '等你批', state: 'awaiting-permission', updatedAt: '2026-10-06T11:00:00' },
    { id: 's3', title: '等你答', state: 'awaiting-answer', updatedAt: '2026-10-06T12:00:00' },
    { id: 's4', title: '归档', state: 'archived', updatedAt: '2026-10-06T09:00:00' },
  ])
  try {
    assert.equal(p.data.pendingCount, 2, '两件在等的必须进优先区')
    assert.deepEqual(
      p.data.pending.map((r) => r.id),
      ['s3', 's2'],
      '优先区与列表同一套排序（新的在前）',
    )
    assert.equal(p.data.pending[1].badgeText, '待审批')
    assert.equal(p.data.pending[0].badgeText, '待回答')
    assert.equal(p.data.sessions.length, 3, '完整列表照旧（归档隐藏，其余都在）')
  } finally {
    p._stopLinkTick()
  }
})

test('G1：没有在等的，优先区整块不占地方', () => {
  const p = makePage()
  p._renderSessions([{ id: 's1', title: '空闲', state: 'idle', updatedAt: '2026-10-06T10:00:00' }])
  try {
    assert.equal(p.data.pendingCount, 0)
    assert.deepEqual(p.data.pending, [])
    const wxml = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/sessions/sessions.wxml'), 'utf8')
    assert.match(wxml, /wx:if="\{\{pendingCount\}\}"/, '优先区必须按 pendingCount 整块开关')
  } finally {
    p._stopLinkTick()
  }
})
