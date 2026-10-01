var crypto = require('../../utils/drc-crypto.js')
var drc = require('../../utils/drc.js')
var platform = require('../../utils/platform.js')

Page({
  data: {
    status: 'idle',
    statusText: '',
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
    /** 这个容器是否有 WebSocket 能力；false 时页面直接提示，别让用户白试 */
    socketReady: true,
  },

  onLoad: function () {
    this.client = drc.getClient()
    var s = this.client.server
    var p = platform.probe()
    this.setData({
      server: s || '',
      psk: this.client.psk || '',
      hasPsk: !!this.client.psk,
      hostLabel: this.client.hostLabel || '',
      diag: platform.summary(),
      diagGlobal: p.global,
      socketReady: !!p.connectSocket,
    })
    this._syncStatus()
  },

  onShow: function () {
    this._off = this.client.on(this._onEvent.bind(this))
    this._syncStatus()
    // Already paired (fresh start with a stored conversation): jump straight in
    if (this.client.status === 'online') {
      this.setData({ busy: false })
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

  _onEvent: function (evt) {
    if (evt.kind === 'status') {
      this.setData({ status: evt.status, statusText: evt.text, busy: evt.status === 'connecting' || evt.status === 'pairing' })
      if (evt.status === 'online' && wx.vibrateShort) wx.vibrateShort({ type: 'light' })
    } else if (evt.kind === 'error') {
      var msg = String(evt.message || '')
      // 重新采集一次：失败原因常常就是环境能力，页面上的那一行必须是最新的
      var p = platform.probe(true)
      this.setData({ diag: platform.summary(), diagGlobal: p.global, socketReady: !!p.connectSocket })
      // toast 只显示 40 字，像「环境缺 WebSocket 能力」这种必须完整看到，
      // 否则用户只知道失败了，不知道下一步做什么。
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
      data: this.data.diag || platform.summary(),
      success: function () {
        wx.showToast({ title: '已复制环境自检', icon: 'none' })
      },
    })
  },

  _syncStatus: function () {
    var c = this.client
    this.setData({
      status: c.status,
      statusText: c.statusText,
      hostLabel: c.hostLabel || '',
      busy: c.status === 'connecting' || c.status === 'pairing',
    })
  },

  // ── 扫码 ──────────────────────────────────────────────────────────
  onScan: function () {
    var self = this
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: function (res) {
        var parsed = crypto.parsePairingQr(res.result || '')
        if (!parsed) {
          wx.showModal({
            title: '无法识别',
            content: '这不是 DSH 远程控制的配对二维码。二维码应以 dshr:/p? 开头。',
            showCancel: false,
          })
          return
        }
        self.setData({
          server: parsed.server,
          psk: parsed.psk,
          hasPsk: true,
          hostLabel: parsed.hostLabel || '',
        })
        self.client.hostLabel = parsed.hostLabel || ''
        // 二维码内嵌了配对码 → 扫码即连，不要再让用户手输一遍
        if (parsed.token) {
          self.setData({ token: parsed.token, busy: true })
          self.client.connect({ server: parsed.server, psk: parsed.psk, token: parsed.token })
          return
        }
        wx.showToast({ title: '已读取密钥，请输入配对码', icon: 'none' })
      },
      fail: function () {
        /* user cancelled */
      },
    })
  },

  /**
   * Paste the whole `dshr:/p?…` string the host prints.
   * Needed because the simulator has no camera: scanning is impossible there,
   * and nobody should have to retype a 24-char base64 PSK by hand.
   */
  onPaste: function (e) {
    var text = String(e.detail.value || '').trim()
    if (!text) return
    var parsed = crypto.parsePairingQr(text)
    if (!parsed) {
      // also accept a bare 6-digit code pasted here — that is what people try
      var digits = text.replace(/\D/g, '')
      if (/^\d{6}$/.test(digits)) {
        this.setData({ token: digits, pasteText: '' })
        wx.showToast({ title: '已填入配对码', icon: 'none' })
      }
      return
    }
    var next = {
      server: parsed.server,
      psk: parsed.psk,
      hasPsk: true,
      hostLabel: parsed.hostLabel || '',
      pasteText: text,
    }
    // if the QR ever carries the token, use it and skip the manual step
    if (parsed.token) next.token = parsed.token
    this.client.hostLabel = parsed.hostLabel || ''
    this.setData(next)
    if (parsed.token) {
      // 内嵌配对码 → 粘贴即连
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
    // keep digits only, max 6
    var v = String(e.detail.value || '').replace(/\D/g, '').slice(0, 6)
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
    this.setData({ busy: true })
    this.client.hostLabel = this.data.hostLabel
    this.client.connect({ server: server, psk: psk, token: token })
  },

  onGoSessions: function () {
    wx.navigateTo({ url: '/pages/sessions/sessions' })
  },

  onUnpair: function () {
    var self = this
    wx.showModal({
      title: '解除配对',
      content: '解除后需要重新扫码配对。确定继续？',
      success: function (r) {
        if (r.confirm) {
          self.client.unpair()
          self.setData({ token: '', psk: '', hasPsk: false, hostLabel: '' })
        }
      },
    })
  },

  onCopyServer: function () {
    wx.setClipboardData({ data: this.data.server })
  },
})
