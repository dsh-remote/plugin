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

globalThis.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: () => {},
  navigateTo: () => {},
  stopPullDownRefresh: () => {},
}

let captured = null
globalThis.Page = (cfg) => {
  captured = cfg
}
require(path.join(ROOT, 'mp/pages/sessions/sessions.js'))
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
  assert.deepEqual(ids(p), ['a', 'c'], '归档的不能出现在列表里')
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
