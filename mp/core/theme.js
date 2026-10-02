/**
 * theme — 小程序的主题（浅色 / 深色）。
 *
 * ── 为什么不用 prefers-color-scheme ───────────────────────────────────
 * 那条 media 查询是**系统**的意思，跟"用户在 App 里点了一下"是两件事。本项目要的是
 * 手动切：默认浅色，切了之后即使系统是浅色也保持深色，反之亦然。所以
 * `app.json` 写 `"darkmode": false`，两张变量表都从 @media 里解放出来（见
 * `scripts/gen-mp-theme.mjs`），用 class 决定用哪一套。
 *
 * ── 切换时必须一并改的三个地方 ────────────────────────────────────────
 * ① **页面根容器加 `theme-dark` class** —— 变量挂在这个 class 上，靠继承铺满整页。
 *    注意必须挂在**根 view** 上而不是 `page`：变量表里写的是 `.theme-dark`，
 *    挂在子树任何一个元素上都只染到那一片。
 * ② **导航栏** —— 它是原生组件，不吃 CSS 变量，也不受 `page` 上的变量影响，
 *    只能 `wx.setNavigationBarColor`。不改的话深色页面上方会留一条白顶栏。
 * ③ **下拉回弹区**（`backgroundColor` / `backgroundColorTop`）—— iOS 上把页面
 *    往下拉会露出它，深色下是刺眼的白。
 *
 * 只做 ① 的话，深色页面会有白顶栏 + 白回弹区，这是"切了但没切干净"最常见的形态。
 */
'use strict'

/** 存储键。带 v1 是为了以后改默认值时不误读旧值（见 `themeName` 的归一化）。 */
var KEY_THEME = 'drc.theme.v1'

/** 合法取值只有这两个。`light` 是默认 —— 用户没选过就是浅色。 */
var LIGHT = 'light'
var DARK = 'dark'

/** 根容器上要加的 class（空串 = 浅色，不要留一个空 class 名在标记里） */
var DARK_CLASS = 'theme-dark'

/**
 * 归一化：只认 'dark'，其余一律当浅色。
 *
 * 为什么要这么"死"：存储里的值可能是旧版本写的、也可能被人手动改过
 * （wx.getStorageSync 在开发者工具里就能改）。落到一个不认识的类名上，
 * 页面上就会是"深色变量没生效"的样子 —— 也就是切了没反应。
 */
function themeName(v) {
  return v === DARK ? DARK : LIGHT
}

/** 读当前主题。读不到、写坏了、值不认识，一律浅色。 */
function current() {
  try {
    return themeName(wx.getStorageSync(KEY_THEME))
  } catch (e) {
    return LIGHT
  }
}

/** 落盘。返回是否成功 —— 存不下时不能静默（下次启动会跳回浅色，用户以为没生效）。 */
function persist(name) {
  try {
    wx.setStorageSync(KEY_THEME, name)
    return true
  } catch (e) {
    return false
  }
}

/**
 * 切换导航栏与回弹区配色。
 *
 * 取值来自 TDesign 的深色变量表（`--td-gray-color-14` 页面底 / `--td-gray-color-13`
 * 容器底），不是随手挑的灰 —— 挑错了导航栏和页面底色之间会出现一条能看出来的接缝。
 * 这里写死而不去读 CSS 变量：小程序没有"读 CSS 自定义属性值"的 API。
 */
function applySystemBars(isDark) {
  var bar = isDark
    ? { front: '#ffffff', bg: '#242424', top: '#181818' }
    : { front: '#000000', bg: '#ffffff', top: '#f3f3f3' }
  try {
    wx.setNavigationBarColor({
      frontColor: bar.front,
      backgroundColor: bar.bg,
      success: function () {},
      fail: function () {},
    })
  } catch (e) {
    /* 老基础库没有这个 API：深色下顶栏会留白，但页面本身是对的，不该因此报错。 */
  }
  try {
    // 页面底色给 top（滚动时露出的那段），容器色给背景 —— 与 theme-dark 变量一致
    wx.setBackgroundColor({
      backgroundColor: bar.bg,
      backgroundColorTop: bar.top,
      success: function () {},
      fail: function () {},
    })
  } catch (e) {
    /* 同上 */
  }
}

/**
 * 把主题落到一个页面上。
 *
 * @param {object} page 小程序页面实例（需要 setData）
 * @param {string} [name] 指定主题；不给就用当前存储值
 * @returns {string} 实际生效的主题名
 *
 * 页面 `onLoad` 里调它就能完成首屏上色。**不要只在 onShow 里设 CSS**：首屏已经
 * 用浅色渲染过一次，用户会看到一闪的白底。
 */
function applyTo(page, name) {
  var resolved = name ? themeName(name) : current()
  applySystemBars(resolved === DARK)
  if (page && typeof page.setData === 'function') {
    page.setData({ themeName: resolved, themeClass: resolved === DARK ? DARK_CLASS : '' })
  }
  return resolved
}

/**
 * 在浅色 / 深色之间切换并立刻生效。
 *
 * @returns {{name: string, dark: boolean, saved: boolean}} 切换后的状态。
 *   `saved:false` 表示存储写失败 —— 界面已经变了，但下次启动会回浅色，
 *   调用方应该提示一句，别让用户以为设置没生效。
 */
function toggle(page) {
  var next = current() === DARK ? LIGHT : DARK
  var saved = persist(next)
  applyTo(page, next)
  return { name: next, dark: next === DARK, saved: saved }
}

module.exports = {
  LIGHT: LIGHT,
  DARK: DARK,
  DARK_CLASS: DARK_CLASS,
  themeName: themeName,
  current: current,
  applyTo: applyTo,
  toggle: toggle,
}
