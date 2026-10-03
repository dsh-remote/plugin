import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * 主题（浅色 / 深色）行为。
 *
 * 这里守的是三件**静默**的事 —— 深色没生效时页面照样渲染，只是露着浅色，
 * 小屏上肉眼很容易看漏，所以每条都要有断言：
 *   - 默认是浅色（用户没选过就是浅色，不是"跟随系统"）；
 *   - 切换要落盘，且只认 light/dark 两个值；
 *   - 切换时除了改 class，还必须改导航栏与回弹区（原生组件不吃 CSS 变量）。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const themePath = path.join(here, '..', 'dsh-remote-mp', 'miniprogram', 'core', 'theme.js')

/** 装一个假的 wx，并把 storage / 导航栏调用都记下来 */
function fakeWx(opts = {}) {
  const store = new Map(Object.entries(opts.store ?? {}))
  const calls = { nav: [], bg: [] }
  const wx = {
    getStorageSync: (k) => (store.has(k) ? store.get(k) : ''),
    setStorageSync: (k, v) => {
      if (opts.storageThrows) throw new Error('存储写不进去')
      store.set(k, v)
    },
    setNavigationBarColor: (o) => calls.nav.push(o),
    setBackgroundColor: (o) => calls.bg.push(o),
  }
  if (opts.noNavApi) {
    delete wx.setNavigationBarColor
    delete wx.setBackgroundColor
  }
  return { wx, store, calls }
}

function withWx(wx, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'wx')
  const prev = globalThis.wx
  globalThis.wx = wx
  try {
    return fn()
  } finally {
    if (had) globalThis.wx = prev
    else delete globalThis.wx
  }
}

/** 每次都重新 require，避免模块级缓存把上一个用例的存储带过来 */
function loadTheme() {
  delete require.cache[require.resolve(themePath)]
  return require(themePath)
}

/** 一个假页面，只记 setData */
function fakePage() {
  const data = {}
  return { data, setData(patch) { Object.assign(data, patch) } }
}

test('没选过时是浅色 —— 不是"跟随系统"', () => {
  const { wx } = fakeWx()
  withWx(wx, () => {
    const theme = loadTheme()
    assert.equal(theme.current(), 'light')
  })
})

test('系统是深色也照样浅色：prefers-color-scheme 不参与决策', () => {
  // 主题只看自己的存储，不读任何系统 API。这里用一个"系统深色"的假 wx 验证：
  // 只要 theme.js 不去问系统，结论就必然是浅色。
  const { wx } = fakeWx()
  wx.getSystemInfoSync = () => ({ theme: 'dark' })
  wx.getAppBaseInfo = () => ({ theme: 'dark' })
  withWx(wx, () => {
    const theme = loadTheme()
    assert.equal(theme.current(), 'light')
    // 切到深色之后也不因为系统是深色而"自动变浅"
    const page = fakePage()
    theme.applyTo(page, 'dark')
    assert.equal(page.data.themeName, 'dark')
  })
})

test('切一次就换 class，再切回来（双向可切，这是本次的核心）', () => {
  const { wx } = fakeWx()
  withWx(wx, () => {
    const theme = loadTheme()
    const page = fakePage()

    const a = theme.toggle(page)
    assert.equal(a.name, 'dark')
    assert.equal(a.dark, true)
    assert.equal(page.data.themeClass, 'theme-dark', '深色时根容器要挂 theme-dark —— 变量挂在这个 class 上')

    const b = theme.toggle(page)
    assert.equal(b.name, 'light')
    assert.equal(b.dark, false)
    assert.equal(page.data.themeClass, '', '浅色时 class 要清空，不能留一个空类名在标记里')
  })
})

test('切换会落盘，重新载入后仍是切过去的那一个', () => {
  const { wx, store } = fakeWx()
  withWx(wx, () => {
    const theme = loadTheme()
    theme.toggle(fakePage())
    assert.equal(theme.current(), 'dark')
  })
  // 模拟重启：新的 require、新的模块实例，但同一个 storage
  withWx(wx, () => {
    const theme2 = loadTheme()
    assert.equal(theme2.current(), 'dark', '深色要跨启动保留，否则用户每次开 App 都要重设一遍')
    assert.ok(store.size >= 1)
  })
})

test('存储里是不认识的值时归到浅色，而不是落到一个不存在的 class 上', () => {
  const { wx } = fakeWx({ store: { 'drc.theme.v1': 'rainbow' } })
  withWx(wx, () => {
    const theme = loadTheme()
    assert.equal(theme.current(), 'light', '不认识的类名会让深色变量一条都不命中 = 切了没反应')
    const page = fakePage()
    theme.applyTo(page)
    assert.equal(page.data.themeClass, '')
  })
})

test('切换时同时改导航栏与下拉回弹区 —— 原生组件不吃 CSS 变量', () => {
  const { wx, calls } = fakeWx()
  withWx(wx, () => {
    const theme = loadTheme()
    theme.toggle(fakePage()) // → 深色
    assert.equal(calls.nav.length, 1, '不改导航栏的话，深色页面上方会留一条白顶栏')
    assert.equal(calls.bg.length, 1, '不改回弹区的话，iOS 下拉会露出刺眼的白')
    // 深色：导航栏深底白字
    assert.equal(calls.nav[0].backgroundColor, '#242424')
    assert.equal(calls.nav[0].frontColor, '#ffffff')
    assert.notEqual(calls.bg[0].backgroundColorTop, calls.bg[0].backgroundColor, 'top 与底色相同的话就没有层次')

    theme.toggle(fakePage()) // → 浅色
    assert.equal(calls.nav[1].backgroundColor, '#ffffff')
    assert.equal(calls.nav[1].frontColor, '#000000', '浅色下白字顶栏等于看不见标题')
  })
})

test('容器没有 setNavigationBarColor 时不报错（老基础库），页面本身仍要正确', () => {
  const { wx } = fakeWx({ noNavApi: true })
  withWx(wx, () => {
    const theme = loadTheme()
    const page = fakePage()
    const r = theme.toggle(page)
    assert.equal(r.name, 'dark')
    assert.equal(page.data.themeClass, 'theme-dark', '原生 API 缺失不该连累页面配色')
  })
})

test('存储写失败时如实报告 saved:false —— 界面变了但下次启动会回浅色', () => {
  const { wx } = fakeWx({ storageThrows: true })
  withWx(wx, () => {
    const theme = loadTheme()
    const page = fakePage()
    const r = theme.toggle(page)
    assert.equal(r.saved, false, '静默失败会让用户以为设置没生效')
    assert.equal(r.name, 'dark', '本次仍然生效 —— 界面已经变了')
  })
})

test('applyTo 传 page 为 null 也不炸（app 启动时只有导航栏可设）', () => {
  const { wx, calls } = fakeWx()
  withWx(wx, () => {
    const theme = loadTheme()
    assert.doesNotThrow(() => theme.applyTo(null))
    assert.equal(calls.nav.length, 1)
  })
})
