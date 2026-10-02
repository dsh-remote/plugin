'use strict'

var client = require('../../core/client.js')
var theme = require('../../core/theme.js')

/**
 * 会话徽标：状态不可混淆，尤其是「已归档」——
 * 主机会拒绝归档会话的每一步，必须一眼可辨（旧版漏了这个）。
 */
function badgeFor(state, running) {
  if (state === 'awaiting-permission') return { text: '待审批', theme: 'warning' }
  if (state === 'awaiting-answer') return { text: '待回答', theme: 'warning' }
  if (state === 'archived') return { text: '已归档', theme: 'default' }
  if (state === 'detached') return { text: '未加载', theme: 'default' }
  if (state === 'running' || running) return { text: '运行中', theme: 'primary' }
  return { text: '空闲', theme: 'default' }
}

function statusView(status) {
  switch (status) {
    case 'online':
      return { label: '在线', theme: 'success' }
    case 'connecting':
    case 'pairing':
      return { label: '连接中', theme: 'primary' }
    case 'error':
      return { label: '异常', theme: 'danger' }
    default:
      return { label: '未连接', theme: 'default' }
  }
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

/**
 * 会话摘要下发的是 ISO 字符串（DESIGN.md F7）。原来直接 `slice(11,19)` 只显示
 * 时分秒 —— 昨天和今天的 `14:32` 长得一模一样，看不出这个会话多久没动了。
 * 按「今天 / 昨天 / 今年 / 更早」分档，长度可控且一眼能判断新旧。
 */
function formatTime(iso) {
  if (!iso) return ''
  var d = new Date(iso)
  var t = d.getTime()
  if (isNaN(t)) return String(iso).slice(11, 19) // 认不出来的原样截一段，别把整页搞崩
  var now = new Date()
  var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  var sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return hm
  var yesterday = new Date(now.getTime() - 24 * 3600 * 1000)
  var isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  if (isYesterday) return '昨天 ' + hm
  if (d.getFullYear() === now.getFullYear()) return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

Page({
  data: {
    paired: false,
    sessions: [],
    status: 'idle',
    statusText: '',
    statusLabel: '未连接',
    statusTheme: 'default',
    hostLabel: '',
    hostId: '',
    keepAwakeOn: false,
    keepAwakeText: '',
    /** 正在连/正在配对：主机卡上要有可见的动静，别让用户以为卡死了 */
    connecting: false,
    /** 被过滤掉的归档会话数；>0 时列表底部补一句说明 */
    hiddenArchived: 0,
    hiddenText: '',
    /** 正在让主机新建会话。没有这个状态，连点会真的造出好几条空会话 */
    creating: false,
    /** 主题。themeName 用来选文案（"切换到深色" vs "切换到浅色"），
        themeClass 挂在根容器上（深色时是 theme-dark，浅色时是空串）。 */
    themeName: 'light',
    themeClass: '',
  },

  onLoad: function () {
    this.client = client.getClient()
    theme.applyTo(this)
  },

  onShow: function () {
    this._off = this.client.on(this._onEvent.bind(this))
    this._sync()
    if (!this.client.isPaired()) {
      this.setData({ paired: false })
      return
    }
    this.setData({ paired: true })
    if (this.client.status === 'online') {
      this.refresh()
    } else {
      this.client.connect()
    }
  },

  onHide: function () {
    if (this._off) {
      this._off()
      this._off = null
    }
  },

  onUnload: function () {
    if (this._off) {
      this._off()
      this._off = null
    }
  },

  onPullDownRefresh: function () {
    this.refresh()
    setTimeout(function () {
      wx.stopPullDownRefresh()
    }, 800)
  },

  _onEvent: function (evt) {
    if (evt.kind === 'payload' && evt.payload.t === 'ev.session_changed') {
      this._renderSessions(this.client.sessions)
    } else if (evt.kind === 'payload' && evt.payload.t === 'ev.keep_awake_state') {
      this._renderKeepAwake(evt.payload)
    } else if (evt.kind === 'status') {
      this._renderStatus(evt.status, evt.text)
    } else if (evt.kind === 'error') {
      wx.showToast({ title: String(evt.message || '').slice(0, 40), icon: 'none' })
    }
  },

  _sync: function () {
    this._renderStatus(this.client.status, this.client.statusText)
    this._renderKeepAwake(this.client.keepAwake)
    this._renderSessions(this.client.sessions)
    this.setData({
      hostLabel: this.client.hostLabel,
      hostId: this.client.hostId,
    })
  },

  _renderStatus: function (status, text) {
    var v = statusView(status)
    this.setData({
      status: status,
      statusText: text || '',
      statusLabel: v.label,
      statusTheme: v.theme,
      connecting: status === 'connecting' || status === 'pairing',
    })
  },

  _renderKeepAwake: function (ka) {
    if (!ka) {
      this.setData({ keepAwakeOn: false, keepAwakeText: '运行中保持主机不睡' })
      return
    }
    this.setData({
      keepAwakeOn: !!ka.enabled,
      keepAwakeText: (ka.active ? '当前持锁中' : '当前未持锁') + (ka.backend ? ' · ' + ka.backend : ''),
    })
  },

  /**
   * 归档会话**不显示**：主机对它们的每一步都直接拒绝，列出来只会让人点了才发现没用。
   * 但也不能悄无声息地消失 —— 底部留一句「已隐藏 N 个」，否则用户会以为会话丢了。
   */
  _renderSessions: function (list) {
    var items = []
    var hidden = 0
    var all = list || []
    for (var i = 0; i < all.length; i++) {
      var s = all[i]
      if (s.state === 'archived') {
        hidden++
        continue
      }
      var b = badgeFor(s.state, s.running)
      items.push({
        id: s.id,
        title: s.title || s.id,
        workspace: s.workspace || '',
        badgeText: b.text,
        badgeTheme: b.theme,
        running: b.theme === 'primary',
        updatedAt: formatTime(s.updatedAt),
      })
    }
    this.setData({
      sessions: items,
      hiddenArchived: hidden,
      hiddenText: hidden ? '已隐藏 ' + hidden + ' 个归档会话' : '',
    })
  },

  refresh: function () {
    this.client.listSessions()
  },

  onOpen: function (e) {
    var id = e.currentTarget.dataset.id
    var title = e.currentTarget.dataset.title || id
    wx.navigateTo({
      url: '/pages/chat/chat?id=' + encodeURIComponent(id) + '&title=' + encodeURIComponent(title),
    })
  },

  onToggleKeepAwake: function (e) {
    var on = !!(e.detail && e.detail.value)
    this.client.setKeepAwake(on, on ? 600 : undefined)
    wx.showToast({ title: on ? '已开启防休眠' : '已关闭防休眠', icon: 'none' })
  },

  onGoPair: function () {
    wx.navigateTo({ url: '/pages/pair/pair' })
  },

  /**
   * 切换浅色 / 深色。
   *
   * 存不下的时候**必须说一句**：界面已经变了，但下次启动会跳回浅色。不提示的话，
   * 用户会以为设置没生效、或者以为自己记错了。安静地失败是这个功能最坏的形态。
   */
  onToggleTheme: function () {
    var r = theme.toggle(this)
    if (!r.saved) {
      wx.showToast({ title: '已切换，但没存住，下次启动会变回浅色', icon: 'none', duration: 2500 })
    }
  },

  /**
   * 让主机新建一条会话。
   *
   * 三条纪律：
   * 1. **不许静默**：每一种失败都要有可读原因（没配对 / 还没连上 / 主机那一代没有这个能力 /
   *    创建失败 / 超时）。"点了什么都没发生"是这一页最难查的那种坏。
   * 2. **按钮进入"正在新建"**：创建要往主机跑一个来回，没有可见动静就会被连点，
   *    而连点会真的造出好几条空会话（主机侧没有去重）。
   * 3. **成功就直接进去**：新建就是为了马上发第一条指令，停在列表上再点一次是多余的。
   *    跳过去之后 chat 页会照常去读历史 —— 空会话读到空内容，是正常的。
   */
  onNewSession: function () {
    var self = this
    if (this.data.creating) return
    if (!this.client.isPaired()) {
      wx.showToast({ title: '还没有配对主机', icon: 'none' })
      return
    }
    if (this.data.status !== 'online') {
      wx.showToast({ title: '还没连上主机，稍后再试', icon: 'none' })
      return
    }
    this.setData({ creating: true })
    var done = function (res) {
      self.setData({ creating: false })
      if (!res || !res.ok || !res.sessionId) {
        wx.showToast({ title: String((res && res.message) || '新建会话失败').slice(0, 40), icon: 'none' })
        return
      }
      // 新会话此刻还没有名字（主机要等第一条指令之后才起标题）。这里给它一个**诚实的**
      // 占位而不是编一个假标题：列表那一侧没标题时显示 id，是同一个规矩。
      self.refresh()
      wx.navigateTo({
        url: '/pages/chat/chat?id=' + encodeURIComponent(res.sessionId) + '&title=' + encodeURIComponent('新会话'),
      })
    }
    this.client
      .newSession()
      .then(done)
      .catch(function (e) {
        done({ ok: false, message: (e && e.message) || '新建会话失败' })
      })
  },
})
