'use strict'

var client = require('../../core/client.js')

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
  },

  onLoad: function () {
    this.client = client.getClient()
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
})
