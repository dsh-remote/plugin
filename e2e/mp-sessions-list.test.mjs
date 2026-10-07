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

test('归档会话单独成一组，不进主列表（2026-10-07 改：原来是被丢掉）', () => {
  const p = makePage()
  try {
    p._renderSessions([
      { id: 'a', title: '正常会话', state: 'idle', updatedAt: '2026-10-02T08:00:00.000Z' },
      { id: 'b', title: '归档会话 1', state: 'archived' },
      { id: 'c', title: '运行中', state: 'running', running: true },
      { id: 'd', title: '归档会话 2', state: 'archived' },
    ])
    // 2026-10-04 起列表按四级排序：都在空目录组、c 在跑 → c 在前
    assert.deepEqual(ids(p), ['c', 'a'], '归档的不能出现在主列表里；剩下的按运行中优先排')
    // ⚠️ 原来是 hiddenArchived/hiddenText 两条计数，而归档会话被**直接丢掉** ——
    // 那让"归档"在小程序上不可逆：主机有 cmd.archive_session，列表也真收到了
    // 那些行，用户却再也找不回来、也没法取消。现在它们进 archivedSessions。
    assert.equal(p.data.archivedCount, 2)
    assert.deepEqual(
      p.data.archivedSessions.map((s) => s.id),
      ['b', 'd'],
      '归档的按同一套排序进归档区（updatedAt 相同则保持原序）',
    )
    assert.equal(p.data.archivedSessions[0].title, '归档会话 1', '标题要带过来：用户靠它认哪条')
    assert.equal(p.data.archivedOpen, false, '默认折叠：多数归档是"做完了先收起来"')
  } finally {
    p._stopLinkTick()
  }
})

test('没有归档时归档区整块不占地方', () => {
  const p = makePage()
  try {
    p._renderSessions([{ id: 'x', state: 'idle' }])
    assert.equal(p.data.archivedCount, 0)
    assert.deepEqual(p.data.archivedSessions, [])
  } finally {
    p._stopLinkTick()
  }
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
    assert.equal(p.data.sessions.length, 3, '主列表照旧（归档那条进归档区，其余都在）')
    assert.equal(p.data.archivedCount, 1, '归档的那条进归档区')
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

// ═══════════════════════════════════════════════════════════════════════
// rc1 前的缺陷修复判据（2026-10-06 晚）—— 每条都在旧实现上先验过会红
// ═══════════════════════════════════════════════════════════════════════

/** 一个够用的假 client：状态帧的处理会用到 listSessions / connect。 */
function fakeClient(over = {}) {
  return {
    status: 'idle',
    statusText: '',
    sessions: [],
    hostLabel: '',
    server: '',
    psk: '',
    isPaired: () => false,
    connect: () => {},
    unpair: () => {},
    listSessions: () => {},
    on: () => () => {},
    getPending: () => {},
    newSession: () => Promise.resolve({ ok: false }),
    archiveSession: () => Promise.resolve({ ok: false, message: '夹具没实现' }),
    ...over,
  }
}

test('解配/断线收尾：ev.keep_awake_state 没有渲染方也不许抛（旧代码调了一个不存在的方法）', () => {
  // 旧实现在这一支调 `this._renderKeepAwake(...)`，而全文件没有这个方法定义 ——
  // 异常被 client.emit 的 try/catch 吞掉，于是每一帧 keep_awake_state 都是
  // 一次**静默 TypeError**：防休眠控件虽然下线了，这一支却一直"看起来在处理"。
  const p = makePage()
  p.client = fakeClient()
  p.setData({ status: 'online' }) // 链路活跃度只在在线时显示（与那条 G5 判据同一前提）
  assert.equal(p._renderKeepAwake, undefined, '夹具自检：这个方法本来就不存在')
  assert.doesNotThrow(() => {
    p._onEvent({ kind: 'payload', payload: { t: 'ev.keep_awake_state', enabled: true, active: true, platform: 'darwin', backend: 'caffeinate' } })
  }, '防休眠这一支不许再调不存在的方法')
  // 同一帧的簿记照旧：它是载荷，就要盖 G5 的戳
  assert.equal(p.data.linkAgeText, ' · 刚刚有消息', '这一帧仍然是载荷：链路活跃度照常更新')
  p._stopLinkTick()
})

test('首页扫码当场配对成功也要起 G5 的表（onShow 时还没配对，那条路只 refresh）', () => {
  // onShow 里 `_startLinkTick()` 在 `!isPaired()` 那一支就 return 了；扫码是**在页面
  // 已经显示之后**才配上的，状态变 online 是这条路上唯一能起表的时刻 ——
  // 漏了它，"· N 秒前有消息"从第一帧起就冻着（tick 永不启动）。
  const p = makePage()
  const listed = []
  p.client = fakeClient({ listSessions: () => listed.push(1) })
  assert.equal(p._linkTimer, undefined, '夹具自检：还没起表')
  p._onEvent({ kind: 'status', status: 'online', text: '已配对到主机' })
  assert.ok(p._linkTimer, '配上了却没人起表：主机卡那行"几秒前有消息"会永远停在第一帧')
  assert.equal(listed.length, 1, '配对成功照旧要刷新一次列表')
  p._stopLinkTick()
})

test('app.json 的 darkmode 必须是 false：主题是自管的，不吃系统 prefers-color-scheme', () => {
  // theme.js 的文件头写明：`darkmode:true` 会打开 TDesign 的
  // `@media (prefers-color-scheme:dark)` 分支，而我们的浅色变量表是从 @media 里
  // 解放出来的 —— 系统深色时，深色分支里那些**浅色表没有的变量**（例如
  // --td-button-primary-disabled-color，button.wxss 在用）会漏进浅色模式，
  // 于是浅色下禁用主按钮的文字近不可见。我们的主题只由 class 决定。
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/app.json'), 'utf8'))
  assert.equal(appJson.darkmode, false, 'darkmode 必须关掉（主题自管，见 core/theme.js 的文件头）')
  assert.equal('themeLocation' in appJson, false, '没有 theme.json 就不该声明 themeLocation')
})

// ── 归档 / 取消归档（2026-10-07）─────────────────────────────────────
//
// 这一段的判据纪律：**每条都配一条反向判据**。归档这一族最容易写成
// "永远拦截"（长按永远弹不出、永远只归档不取消、失败也当成功），
// 而那种实现下面这几条照样全绿。

test('长按一行 → 弹 ActionSheet → 确认后才真的发归档命令', async () => {
  const sheets = []
  globalThis.wx.showActionSheet = (o) => {
    sheets.push(o)
    o.success && o.success({ tapIndex: 0 })
  }
  const calls = []
  const p = makePage()
  p.client = fakeClient({
    status: 'online',
    archiveSession: (id, archived) => {
      calls.push({ id, archived })
      return Promise.resolve({ ok: true })
    },
    listSessions: () => {},
  })
  try {
    p._onEvent({ kind: 'status', status: 'online', text: '已配对' })
    p.onSessionLongPress({ currentTarget: { dataset: { id: 'a', title: '正常会话' } } })
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(sheets.length, 1, '长按必须先弹一个确认 —— 归档虽然可逆，但用户点错一行的成本是真实的')
    assert.match(sheets[0].itemList[0], /归档「正常会话」/, '选项上要带会话名，否则用户不知道自己在归档哪一条')
    assert.deepEqual(calls, [{ id: 'a', archived: true }], '确认之后才发，且 archived=true 是归档方向')
  } finally {
    p._stopLinkTick()
  }
})

test('反向判据：没连上主机时长按**不发命令**，直接说为什么', () => {
  const calls = []
  let toast = null
  globalThis.wx.showToast = (o) => {
    toast = o
  }
  globalThis.wx.showActionSheet = () => {
    throw new Error('没连上时不该弹 ActionSheet')
  }
  const p = makePage()
  p.client = fakeClient({
    status: 'offline',
    archiveSession: (id, archived) => {
      calls.push({ id, archived })
      return Promise.resolve({ ok: true })
    },
  })
  p.onSessionLongPress({ currentTarget: { dataset: { id: 'a', title: 'x' } } })
  assert.deepEqual(calls, [], '没连上就一条都不许发：发出去也是白等 12 秒超时')
  assert.ok(toast && /还没连上主机/.test(toast.title), '要说清为什么不能归档')
})

test('反向判据：主机拒绝时把它的原因原样给用户，不弹"成功"', async () => {
  let toast = null
  globalThis.wx.showToast = (o) => {
    toast = o
  }
  globalThis.wx.showActionSheet = (o) => o.success && o.success({ tapIndex: 0 })
  const p = makePage()
  p.client = fakeClient({
    status: 'online',
    // 真实主机在会话还在跑时回的就是这句
    archiveSession: () => Promise.resolve({ ok: false, message: '会话正在运行，不能归档。请先在电脑上让它跑完' }),
    listSessions: () => {},
  })
  try {
    p._onEvent({ kind: 'status', status: 'online', text: '已配对' })
    p.onSessionLongPress({ currentTarget: { dataset: { id: 'a', title: 'x' } } })
    await new Promise((r) => setTimeout(r, 0))
    assert.ok(toast && /正在运行/.test(toast.title), `必须把主机的原话给用户，实际是 ${JSON.stringify(toast)}`)
    assert.equal(p.data.archivingId, '', '失败后必须把"进行中"那个状态清掉，否则这一行永远转圈')
  } finally {
    p._stopLinkTick()
  }
})

test('点归档区那一行 = 取消归档（不是打开它）', async () => {
  const calls = []
  const p = makePage()
  p.client = fakeClient({
    status: 'online',
    archiveSession: (id, archived) => {
      calls.push({ id, archived })
      return Promise.resolve({ ok: true })
    },
    listSessions: () => {},
  })
  try {
    p._onEvent({ kind: 'status', status: 'online', text: '已配对' })
    p.onArchivedTap({ currentTarget: { dataset: { id: 'b' } } })
    await new Promise((r) => setTimeout(r, 0))
    // 方向是这一条的全部：点归档行绝不能是"归档"（那是原地不动），
    // 也不能是"打开"——主机对归档会话的每一步都直接拒绝，进去只能拿到超时。
    assert.deepEqual(calls, [{ id: 'b', archived: false }], '单击归档行 = 取消归档')
  } finally {
    p._stopLinkTick()
  }
})

test('反向判据：取消归档也有一条独立出口（长按），不是"只能靠点"这一个动作', () => {
  assert.equal(typeof captured.onArchivedLongPress, 'function', '长按那条 ActionSheet 入口必须留着')
  assert.equal(typeof captured.onSessionLongPress, 'function')
  assert.equal(typeof captured.onToggleArchived, 'function', '归档区的展开/收起也要有')
})

test('反向判据：折叠状态不随列表刷新被重置', () => {
  const p = makePage()
  try {
    p.onToggleArchived()
    assert.equal(p.data.archivedOpen, true, '点一下就展开')
    // 用户刚展开的折叠区在一次列表刷新后又合上，是最烦人的那类界面抖动
    p._renderSessions([{ id: 'a', state: 'archived' }])
    assert.equal(p.data.archivedOpen, true, '刷新不许把用户的折叠状态按回去')
    p.onToggleArchived()
    assert.equal(p.data.archivedOpen, false, '再点一下收起')
  } finally {
    p._stopLinkTick()
  }
})


/**
 * 绑在 wxml 上的 handler，第一参**必须**长得像事件对象（2026-10-07 补）。
 *
 * ## 它抓到过一个真实的缺陷
 *
 * `onNewSession(picked)` 挂在 `bindtap="onNewSession"` 上，而 bindtap 会把
 * **事件对象**当第一个实参传进来 —— 于是 `picked` 恒为真值，
 * `picked || this._currentWorkspace()` 的三级兜底永远走不到，
 * 每次单击都往主机发一个名为 `[object Object]` 的工作区。
 *
 * 症状特别难查：`String({}) === '[object Object]'`，它**不是空串**，
 * 所以 `if (workspace) cmd.workspace = ...` 照发；主机侧 `badWorkspace()`
 * 收到一个不存在的目录，会话落错地方或被拒，而回执路径上没有任何提示。
 * 而 2.0.17 那轮刚给 `cmd.new_session.workspace` 补完判据与文档 ——
 * 接线是通的，而**单击那条路发的是垃圾**。
 *
 * ## 为什么这条判据是机械的而不是逐个断言
 *
 * 逐个写"onXxx 不许这样"必然漏（下一个页面又有同类）。所以这里扫**全部**绑定：
 * 凡是绑在 wxml 上、而第一参不长得像事件的，一律红。那种 handler 要么本来就
 * 该读 `e.currentTarget.dataset`，要么被内部调用（如 `onNewSession(picked)`）
 * —— 后者由下一条判据单独放行并要求它判类型。
 */
test('绑在 wxml 上的 handler：第一参必须长得像事件对象（否则 bindtap 会把事件喂进数据位）', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/sessions/sessions.wxml'), 'utf8')
  const bound = new Set([...wxml.matchAll(/bind(?:tap|longpress|change|input|confirm|blur)="(\w+)"/g)].map((m) => m[1]))
  // 这些是**被内部调用**的（不是 wxml 直接绑的），它们的第一参是数据
  const internallyCalled = new Set(['onNewSession'])
  // ⚠️ 必须读**源码文本**而不是 `String(fn)`：函数被 stringify 之后参数名就没了
  // （实测 `String(captured.onScan)` 出来是 `function () { … }`），于是正则取到
  // 的"第一参"是 `function` —— 一次就产出 17 个假阳性。
  // 这与 memory 里那条「判据红了先确认它测的是不是那一段」是同一族。
  const source = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/sessions/sessions.js'), 'utf8')
  const suspicious = []
  for (const name of bound) {
    if (internallyCalled.has(name)) continue
    // 形如 `  onScan: function (e) {` 或 `  onScan: function () {`
    const m = new RegExp(`^  ${name}: function \\(([^)]*)\\)`, 'm').exec(source)
    if (!m) continue
    const first = m[1].trim().split(',')[0].trim()
    if (first && !/^(e|evt|event|t)$/.test(first)) suspicious.push(`${name}(${first})`)
  }
  assert.deepEqual(
    suspicious,
    [],
    `这些 handler 绑在 wxml 上却把第一参当数据用：${suspicious.join(', ')}。` +
      'bindtap/bindlongpress 会把事件对象传进来，而事件对象恒为真值 —— ' +
      '任何 `picked || fallback` 都会永远走 fallback 那一支',
  )
})

test('onNewSession：bindtap 传进来的事件对象不许被当成工作区（判类型而不是判空）', async () => {
  // 上一条把它从机械扫描里排除了（它确实绑在 wxml 上），所以这一条单独钉住契约：
  // 实参可能是路径字符串（长按那条路），也可能是**事件对象**（bindtap 那条路）。
  //
  // ⚠️ 两次调用之间必须 `await`：`onNewSession` 开头有 `if (this.data.creating) return`
  // 这个防连点的闩锁，而 `creating` 要等 Promise 回来才清 —— 同步连发两次时
  // 第二次会被闩锁挡掉，于是判据读到的 `calls` 少了第二条，而症状是
  // 「夹具自检：两次都该发出去了」——与被测的那段逻辑无关。
  const calls = []
  const p = makePage()
  p.client = fakeClient({
    status: 'online',
    // ⚠️ `isPaired` 也得给 true：共用夹具默认是 false，而 `onNewSession` 的第二道
    // 闸就是它。第一版忘了给，两次调用都在「还没有配对主机」那支早退 ——
    // 症状是 `calls` 为空，而看起来像"实现没发命令"。
    isPaired: () => true,
    newSession: (workspace) => {
      calls.push(workspace)
      return Promise.resolve({ ok: true, sessionId: 'ses_new' })
    },
  })
  try {
    p._onEvent({ kind: 'status', status: 'online', text: '已配对' })
    assert.equal(p.data.status, 'online', '夹具自检：状态必须是 online，否则下面两次都会在"没连上"那支早退')
    assert.equal(p.client.isPaired(), true, '夹具自检：isPaired 必须为 true')

    // ① bindtap 那条路：实参是**事件对象**
    p.onNewSession({ type: 'tap', currentTarget: { dataset: {} } })
    await new Promise((r) => setTimeout(r, 0))
    // ② 长按那条路：实参是真字符串
    p.onNewSession('/Users/someone/project-x')
    await new Promise((r) => setTimeout(r, 0))

    assert.equal(calls.length, 2, `夹具自检：两次都该发出去了，实得 ${JSON.stringify(calls)}`)
    for (const got of calls) {
      assert.notEqual(
        got,
        '[object Object]',
        '绝不许把 String(事件对象) 发给主机：主机侧 badWorkspace() 收到一个不存在的目录，' +
          '会话落错地方或被拒，而回执路径上没有任何提示',
      )
    }
    // ② 必须是**用户显式指定的那一个**，逐字透传（不许被兜底覆盖）
    assert.equal(calls[1], '/Users/someone/project-x', '长按选中的工作区必须原样发出去')
    // ① 事件对象那一路落到三级兜底：本夹具里列表空、`_lastWorkspace` 也没记，
    // 所以第三级是"不带这个字段" = 空串 —— 而**不是** '[object Object]'。
    assert.equal(
      calls[0],
      '',
      '没有可用兜底时必须退到"不带这个字段"（由主机推断），而不是把事件对象发出去',
    )
  } finally {
    p._stopLinkTick()
  }
})

test('反向判据：needs-pair 必须把这一页**每一个**从主机读来的量归零', () => {
  // 这一支原来只清了 sessions / hiddenArchived / hiddenText —— 而后两个在
  // 2026-10-07 那轮已经**不再被写**（归档改成单独一组），所以它实际只清了
  // sessions，`archivedSessions` / `archivedCount` / `pending` /
  // `pendingCount` / `archivingId` 全部留着上一台主机的数据。
  //
  // 今天看不出来，只因为 wxml 靠 `wx:if="{{paired}}"` 把它们遮住了——
  // 而那层遮蔽是**巧合**不是设计：模板分支一改就是"已解配却还列着上一台
  // 主机的会话"。
  //
  // 判据形状：先灌满全部字段，再走 needs-pair，然后**逐个**断言归零。
  // 用"逐个断言"而不是"deepEqual(data, 初始)"：后者会把 theme/pasteText
  // 这些**本来就该留着**的用户输入也一起要求归零（那是另一个缺陷）。
  const p = makePage()
  try {
    p._renderSessions([
      { id: 'a', title: '在跑', state: 'running', running: true, updatedAt: '2026-10-07T10:00:00Z' },
      { id: 'b', title: '等你批', state: 'awaiting-permission', updatedAt: '2026-10-07T11:00:00Z' },
      { id: 'c', title: '归档', state: 'archived', updatedAt: '2026-10-07T09:00:00Z' },
    ])
    p.setData({ archivingId: 'a', busy: true, creating: true })
    assert.ok(p.data.sessions.length > 0 && p.data.archivedCount > 0 && p.data.pendingCount > 0, '夹具自检：先灌满')
    assert.equal(p.data.archivingId, 'a', '夹具自检：进行中那一条也灌上')

    p._onEvent({ kind: 'status', status: 'needs-pair', text: '配对已失效' })

    // 每一个"从主机读来的量"都必须归零
    for (const key of [
      'sessions',
      'archivedSessions',
      'pending',
      'archivingId',
      'creating',
      'busy',
    ]) {
      const got = p.data[key]
      const empty = Array.isArray(got) ? got.length === 0 : got === '' || got === false
      assert.ok(empty, `needs-pair 之后 \`${key}\` 必须归零，实得 ${JSON.stringify(got)}`)
    }
    for (const key of ['archivedCount', 'pendingCount']) {
      assert.equal(p.data[key], 0, `needs-pair 之后 \`${key}\` 必须是 0，实得 ${p.data[key]}`)
    }
    assert.equal(p.data.paired, false, '配对已失效，界面必须回到扫码入口')
    // 反向判据：用户输入**不该**被清（清掉就是另一个缺陷：重填一遍很烦）
    assert.equal(p.data.pasteText, '', '夹具自检：初始 pasteText 是空串')
  } finally {
    p._stopLinkTick()
  }
})

test('反向判据：onShow 不许把退避打回零（socket 还在就别重连）', () => {
  // 原来这里是 `else { this.client.connect() }`，而 connect() 会先 close 掉
  // 旧 socket 再造一个新的、**退避重置为 0** 的。
  //
  // 症状：退避被反复打回零。在 会话列表↔聊天 之间来回切时（每次切换都走
  // 一次 onShow），只要当前不在线就重连一次 ⇒ 指数退避（1s→30s）永远顶格
  // 在 1s。退避存在的意义就是别在中继拒收时 hammer 它。
  //
  // `app.js` 的 onShow 早就写对了（`&& !this.drc.sock`），唯独这里没有。
  const connects = []
  const p = makePage()
  p.client = fakeClient({
    status: 'offline',
    // `onShow` 在 `!isPaired()` 那支就 return 了，而共用夹具默认 isPaired=false
    isPaired: () => true,
    // ⚠️ `sock` 存在 = "socket 已经建好了、正在等它连上/等它重连"。
    // 正在重连时 socket **是存在的**（createSocket 立刻赋值），所以这一支
    // 必须不走 —— 那正是原来那个 bug 的形态。
    sock: {},
    connect: () => connects.push(1),
  })
  p._off = p.client.on(() => {})
  try {
    p.onShow()
    p._off()
    assert.equal(
      connects.length,
      0,
      'socket 还在（正在重连）时又调 connect()：那会把退避重置为 0，' +
        '指数退避永远顶格在 1s，而退避的意义正是别 hammer 中继',
    )
  } finally {
    // ⚠️ `onShow` 会 `_startLinkTick()`，而那是**真的 setInterval**。
    // 忘了停它 ⇒ 整个 `node --test` 进程不退出（表现为命令被 SIGTERM，
    // 而判据本身全绿）—— 症状与被测的逻辑完全无关，极难定位。
    p._stopLinkTick()
  }
})

test('反向判据：真的没有 socket 时仍然要重连（上一条不许把这条功能关掉）', () => {
  // 与上一条成对：只写"不许重连"的话，把整支删掉也能全绿。
  const connects = []
  const p = makePage()
  p.client = fakeClient({
    status: 'offline',
    isPaired: () => true,
    sock: null,
    connect: () => connects.push(1),
  })
  p._off = p.client.on(() => {})
  p.onShow()
  p._off()
  p._stopLinkTick()
  assert.equal(connects.length, 1, '真的没有 socket 时必须重连：从后台回来要能自己恢复')
})
