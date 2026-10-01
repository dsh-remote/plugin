var drc = require('../../utils/drc.js')

function badge(state, running) {
  if (state === 'awaiting-permission') return { text: '待审批', cls: 'tag-wait' }
  if (state === 'awaiting-answer') return { text: '待回答', cls: 'tag-wait' }
  if (state === 'running' || running) return { text: '运行中', cls: 'tag-running' }
  return { text: '空闲', cls: 'tag-idle' }
}

Page({
  data: {
    sessions: [],
    status: 'idle',
    statusText: '',
    keepAwake: null,
    refreshing: false,
  },

  onLoad: function () {
    this.client = drc.getClient()
  },

  onShow: function () {
    this._off = this.client.on(this._onEvent.bind(this))
    this._sync()
    if (this.client.status === 'online') {
      this.refresh()
    } else if (!this.client.isPaired()) {
      wx.showToast({ title: '请先完成配对', icon: 'none' })
      setTimeout(function () {
        wx.navigateBack()
      }, 600)
    } else {
      this.client.connect()
    }
  },

  onHide: function () {
    if (this._off) { this._off(); this._off = null }
  },

  onUnload: function () {
    if (this._off) { this._off(); this._off = null }
  },

  onPullDownRefresh: function () {
    this.refresh()
    setTimeout(function () { wx.stopPullDownRefresh() }, 800)
  },

  _onEvent: function (evt) {
    if (evt.kind === 'payload' && evt.payload.t === 'ev.session_changed') {
      this._render(this.client.sessions)
    } else if (evt.kind === 'payload' && evt.payload.t === 'ev.keep_awake_state') {
      this.setData({ keepAwake: evt.payload })
    } else if (evt.kind === 'status') {
      this.setData({ status: evt.status, statusText: evt.text })
    } else if (evt.kind === 'error') {
      wx.showToast({ title: evt.message.slice(0, 40), icon: 'none' })
    }
  },

  _sync: function () {
    this.setData({
      status: this.client.status,
      statusText: this.client.statusText,
      keepAwake: this.client.keepAwake,
    })
    this._render(this.client.sessions)
  },

  _render: function (list) {
    var items = (list || []).map(function (s) {
      var b = badge(s.state, s.running)
      return {
        id: s.id,
        title: s.title || s.id,
        workspace: s.workspace || '',
        state: s.state || 'idle',
        badgeText: b.text,
        badgeCls: b.cls,
        updatedAt: s.updatedAt ? s.updatedAt.slice(11, 19) : '',
      }
    })
    this.setData({ sessions: items })
  },

  refresh: function () {
    if (this.data.refreshing) return
    this.setData({ refreshing: true })
    this.client.listSessions()
    var self = this
    setTimeout(function () { self.setData({ refreshing: false }) }, 1000)
  },

  onOpen: function (e) {
    var id = e.currentTarget.dataset.id
    var title = e.currentTarget.dataset.title || id
    wx.navigateTo({ url: '/pages/chat/chat?id=' + encodeURIComponent(id) + '&title=' + encodeURIComponent(title) })
  },

  onToggleKeepAwake: function (e) {
    var on = !!e.detail.value
    this.client.setKeepAwake(on, on ? 600 : undefined)
    wx.showToast({ title: on ? '已开启防休眠' : '已关闭防休眠', icon: 'none' })
  },
})
