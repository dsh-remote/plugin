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

  _renderSessions: function (list) {
    var items = (list || []).map(function (s) {
      var b = badgeFor(s.state, s.running)
      return {
        id: s.id,
        title: s.title || s.id,
        workspace: s.workspace || '',
        badgeText: b.text,
        badgeTheme: b.theme,
        updatedAt: s.updatedAt ? s.updatedAt.slice(11, 19) : '',
      }
    })
    this.setData({ sessions: items })
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
