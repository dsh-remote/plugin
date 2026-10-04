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

test('wxml：标题行带工作区 chip，空目录不渲染', () => {
  const { readFileSync } = require('node:fs')
  const wxml = readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/sessions/sessions.wxml'), 'utf8')
  assert.match(wxml, /class="sess-title-row"/, '标题与 chip 要在一行（chip 不动、标题先省略）')
  assert.match(wxml, /wx:if="{{item.workspaceTag}}"[^>]*class="sess-tag"/, 'chip 只在有工作区时渲染')
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
