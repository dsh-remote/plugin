'use strict'

var client = require('../../core/client.js')
var codec = require('../../core/codec.js')
var env = require('../../core/env.js')
var theme = require('../../core/theme.js')

function statusView(status) {
  switch (status) {
    case 'online':
      return { label: '已配对', theme: 'success' }
    case 'connecting':
    case 'pairing':
      return { label: '连接中', theme: 'primary' }
    case 'error':
      return { label: '异常', theme: 'danger' }
    default:
      return { label: '未配对', theme: 'default' }
  }
}

Page({
  data: {
    status: 'idle',
    statusText: '',
    statusLabel: '未配对',
    statusTheme: 'default',
    online: false,
    server: '',
    token: '',
    psk: '',
    hasPsk: false,
    hostLabel: '',
    showAdvanced: false,
    busy: false,
    pasteText: '',
    /** 环境自检摘要：一行，可复制 */
    diag: '',
    diagGlobal: 'wx',
    /** 容器是否有 WebSocket 能力；false 时页面直接提示，别让用户白试 */
    socketReady: true,
    /** 容器是否有扫码能力；没有就不放一个点了必然报错的按钮 */
    scanReady: true,
    /** 主题。见 sessions 页同名字段的说明。 */
    themeName: 'light',
    themeClass: '',
  },

  onLoad: function () {
    this.client = client.getClient()
    theme.applyTo(this)
    var p = env.probe()
    this.setData({
      server: this.client.server || '',
      psk: this.client.psk || '',
      hasPsk: !!this.client.psk,
      hostLabel: this.client.hostLabel || '',
      diag: env.summary(),
      diagGlobal: p.global,
      socketReady: !!p.connectSocket,
      scanReady: !!p.scanCode,
    })
    this._syncStatus()
  },

  onShow: function () {
    this._off = this.client.on(this._onEvent.bind(this))
    this._syncStatus()
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

  _syncStatus: function () {
    var c = this.client
    this._renderStatus(c.status, c.statusText)
    this.setData({ hostLabel: c.hostLabel || '' })
  },

  _renderStatus: function (status, text) {
    var v = statusView(status)
    this.setData({
      status: status,
      statusText: text || '',
      statusLabel: v.label,
      statusTheme: v.theme,
      online: status === 'online',
      busy: status === 'connecting' || status === 'pairing',
    })
  },

  _onEvent: function (evt) {
    if (evt.kind === 'status') {
      var wasPairing = this._pairingInitiated
      this._renderStatus(evt.status, evt.text)
      if (evt.status === 'online') {
        if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
        if (wasPairing) {
          // 本页发起的配对成功了：回到会话列表（没有上一页就直接跳）
          this._pairingInitiated = false
          setTimeout(function () {
            wx.navigateBack({
              fail: function () {
                wx.redirectTo({ url: '/pages/sessions/sessions' })
              },
            })
          }, 400)
        }
      }
      return
    }
    if (evt.kind === 'error') {
      var msg = String(evt.message || '')
      // 重新采集一次：失败原因常常就是环境能力，页面上的那行必须是最新的
      var p = env.probe(true)
      this.setData({
        diag: env.summary(),
        diagGlobal: p.global,
        socketReady: !!p.connectSocket,
        scanReady: !!p.scanCode,
      })
      // toast 只显示有限字数；「环境缺能力」这种必须完整看到，
      // 否则用户只知道失败了，不知道下一步做什么
      if (!p.connectSocket || msg.indexOf('SOCKET_UNAVAILABLE') >= 0 || msg.length > 40) {
        wx.showModal({ title: '连接失败', content: msg, showCancel: false })
      } else {
        wx.showToast({ title: msg.slice(0, 40), icon: 'none' })
      }
    }
  },

  /** 把环境自检整行复制走 —— 出问题时这一行就能定位原因。 */
  onCopyDiag: function () {
    wx.setClipboardData({
      data: this.data.diag || env.summary(),
      success: function () {
        wx.showToast({ title: '已复制环境自检', icon: 'none' })
      },
    })
  },

  // ── 扫码 ──────────────────────────────────────────────────────────
  onScan: function () {
    var self = this
    if (!env.probe().scanCode) {
      // 容器没有 scanCode：直接调用只会抛 "is not a function"，
      // 而用户真正能用的路径（粘贴）就写在上面那个输入框里
      wx.showModal({
        title: '当前环境无法扫码',
        content: '这个运行环境没有提供扫码能力。请把主机显示的「二维码内容」粘贴到输入框。',
        showCancel: false,
      })
      return
    }
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: function (res) {
        var parsed = codec.parsePairingQr(res.result || '')
        if (!parsed) {
          wx.showModal({
            title: '无法识别',
            content: '这不是 DSH 远程控制的配对二维码。二维码应以 dshr:/p? 开头。',
            showCancel: false,
          })
          return
        }
        self._applyParsed(parsed)
      },
      fail: function () {
        /* user cancelled */
      },
    })
  },

  /**
   * 粘贴框只记值，不立刻解析。
   * 原生 input 的 bindinput 是「每次敲键都触发」，在上面直接解析会
   * 把半截内容当失败、反复弹提示；读取动作留给失焦/回车。
   */
  onPasteInput: function (e) {
    this.setData({ pasteText: String((e.detail && e.detail.value) || '') })
  },

  /** 原生 input 没有 TDesign 的 change 事件，用 blur + confirm 兜住 */
  onPasteCommit: function () {
    this.onPaste({ detail: { value: this.data.pasteText } })
  },

  onPasteClear: function () {
    this.setData({ pasteText: '' })
  },

  /**
   * 读剪贴板。主机打印的是整段 `dshr:/p?…`，手敲不现实、长按输入框再选粘贴也绕，
   * 点一下直接取。能力缺失时给一句人话，别让它抛 TypeError。
   */
  onPasteClipboard: function () {
    var api = typeof wx !== 'undefined' ? wx : null
    if (!api || typeof api.getClipboardData !== 'function') {
      wx.showToast({ title: '当前环境不支持读取剪贴板，请长按输入框粘贴', icon: 'none' })
      return
    }
    var self = this
    api.getClipboardData({
      success: function (res) {
        var text = String((res && res.data) || '').trim()
        if (!text) {
          wx.showToast({ title: '剪贴板是空的', icon: 'none' })
          return
        }
        self.setData({ pasteText: text })
        self.onPaste({ detail: { value: text } })
      },
      fail: function () {
        wx.showToast({ title: '读取剪贴板失败，请长按输入框粘贴', icon: 'none' })
      },
    })
  },

  /**
   * 粘贴主机打印的整段 `dshr:/p?…`。
   * 模拟器没有摄像头：扫码不可能，也不该有人手敲 24 字符的 base64 PSK。
   */
  onPaste: function (e) {
    var text = String((e.detail && e.detail.value) || '').trim()
    if (!text) return
    var parsed = codec.parsePairingQr(text)
    if (!parsed) {
      // 也接受直接粘 6 位配对码 —— 人们就是这么试的
      var digits = text.replace(/\D/g, '')
      if (/^\d{6}$/.test(digits)) {
        this.setData({ token: digits, pasteText: '' })
        wx.showToast({ title: '已填入配对码', icon: 'none' })
      }
      return
    }
    this.setData({ pasteText: text })
    this._applyParsed(parsed)
  },

  _applyParsed: function (parsed) {
    this.client.hostLabel = parsed.hostLabel || ''
    var next = {
      server: parsed.server,
      psk: parsed.psk,
      hasPsk: true,
      hostLabel: parsed.hostLabel || '',
    }
    // 二维码内嵌了配对码 → 扫码/粘贴即连，不再让用户手输一遍
    if (parsed.token) next.token = parsed.token
    this.setData(next)
    if (parsed.token) {
      this._pairingInitiated = true
      this.setData({ busy: true })
      this.client.connect({ server: parsed.server, psk: parsed.psk, token: parsed.token })
      return
    }
    wx.showToast({ title: '已读取密钥，请输入配对码', icon: 'none' })
  },

  onServerInput: function (e) {
    this.setData({ server: e.detail.value })
  },

  onTokenInput: function (e) {
    // 只留数字，最多 6 位
    var v = String((e.detail && e.detail.value) || '').replace(/\D/g, '').slice(0, 6)
    this.setData({ token: v })
  },

  onPskInput: function (e) {
    this.setData({ psk: e.detail.value, hasPsk: !!e.detail.value })
  },

  toggleAdvanced: function () {
    this.setData({ showAdvanced: !this.data.showAdvanced })
  },

  // ── 配对 ──────────────────────────────────────────────────────────
  onPair: function () {
    var server = String(this.data.server || '').trim()
    var token = String(this.data.token || '').trim()
    var psk = String(this.data.psk || '').trim()

    if (!/^wss?:\/\//.test(server)) {
      wx.showToast({ title: '服务地址需以 ws:// 或 wss:// 开头', icon: 'none' })
      return
    }
    if (!psk) {
      wx.showToast({ title: '缺少配对密钥，请先扫码', icon: 'none' })
      return
    }
    if (!/^\d{6}$/.test(token)) {
      wx.showToast({ title: '请输入主机显示的 6 位配对码', icon: 'none' })
      return
    }
    this._pairingInitiated = true
    this.client.hostLabel = this.data.hostLabel
    this.setData({ busy: true })
    this.client.connect({ server: server, psk: psk, token: token })
  },

  onGoSessions: function () {
    wx.redirectTo({ url: '/pages/sessions/sessions' })
  },

  onUnpair: function () {
    var self = this
    wx.showModal({
      title: '解除配对',
      content: '解除后需要重新扫码配对。确定继续？',
      success: function (r) {
        if (r.confirm) {
          self.client.unpair()
          self.setData({ token: '', psk: '', hasPsk: false, hostLabel: '', pasteText: '' })
        }
      },
    })
  },
})
