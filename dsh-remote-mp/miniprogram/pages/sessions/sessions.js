'use strict'

var client = require('../../core/client.js')
var codec = require('../../core/codec.js')
var env = require('../../core/env.js')
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
    /**
     * 配对相关。原来这些在单独的 pair 页，现在内联到首页 ——
     * 「首页直接扫码」比「首页点一下再跳一页」少一次导航。
     * 只有 `manualOpen` 为真时下面那些输入控件才渲染，平时不占版面。
     */
    manualOpen: false,
    busy: false,
    scanReady: true,
    socketReady: true,
    pasteText: '',
    token: '',
    psk: '',
    hasPsk: false,
    server: '',
    diag: '',
    diagGlobal: 'wx',
    /** 主题。themeName 用来选文案（"切换到深色" vs "切换到浅色"），
        themeClass 挂在根容器上（深色时是 theme-dark，浅色时是空串）。 */
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
      diag: env.summary(),
      diagGlobal: p.global,
      socketReady: !!p.connectSocket,
      scanReady: !!p.scanCode,
    })
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
      // 配对成功：状态一变，wxml 的 `wx:if` 分支自己就切到会话列表了。
      // 原来在 pair 页要 navigateBack 回首页，现在就在首页，不需要任何跳转。
      if (evt.status === 'online') {
        if (this.data.busy && wx.vibrateShort) wx.vibrateShort({ type: 'light' })
        this.setData({ paired: true, busy: false, manualOpen: false })
        this.refresh()
      }
    } else if (evt.kind === 'error') {
      // 配对失败要回到可重试的状态，否则「正在配对…」会一直停在那儿
      this.setData({ busy: false })
      var msg = String(evt.message || '')
      // 重新采集一次：失败原因常常就是环境能力，页面上那行必须是最新的
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

  /**
   * 扫主机的二维码。**首页直接扫** —— 不再跳到另一个页面。
   *
   * 主路径只有这一条：二维码里带了密钥 + 配对码，扫完即连，用户不用再手输。
   * 容器没有 scanCode（比如某些模拟器）时给一句人话并把手动输入展开，
   * 而不是让用户点了必然报错的按钮。
   */
  onScan: function () {
    if (!env.probe().scanCode) {
      this.setData({ manualOpen: true })
      wx.showModal({
        title: '当前环境无法扫码',
        content: '这个运行环境没有提供扫码能力。请把主机显示的「二维码内容」粘贴到下面的输入框。',
        showCancel: false,
      })
      return
    }
    var self = this
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

  /** 手动输入区（粘贴 / 6 位码 / 高级设置）的开关。 */
  onToggleManual: function () {
    this.setData({ manualOpen: !this.data.manualOpen })
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

  /**
   * 二维码里已经有密钥了，**能不能连只差配对码**。
   * 带了配对码就直接连；没带就把输入区展开、聚焦到配对码上，
   * 而不是让用户在一堆控件里自己找"还差什么"。
   */
  _applyParsed: function (parsed) {
    this.client.hostLabel = parsed.hostLabel || ''
    var next = {
      server: parsed.server,
      psk: parsed.psk,
      hasPsk: true,
      hostLabel: parsed.hostLabel || '',
    }
    if (parsed.token) next.token = parsed.token
    this.setData(next)
    if (parsed.token) {
      this.setData({ busy: true })
      this.client.connect({ server: parsed.server, psk: parsed.psk, token: parsed.token })
      return
    }
    this.setData({ manualOpen: true })
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
    this.client.hostLabel = this.data.hostLabel
    this.setData({ busy: true })
    this.client.connect({ server: server, psk: psk, token: token })
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

  /** 解除配对。确认框里说清后果：之后要重新扫码。 */
  onUnpair: function () {
    var self = this
    wx.showModal({
      title: '解除配对',
      content: '解除后需要重新扫码配对。确定继续？',
      success: function (r) {
        if (r.confirm) {
          self.client.unpair()
          self.setData({
            paired: false,
            token: '',
            psk: '',
            hasPsk: false,
            hostLabel: '',
            pasteText: '',
            server: self.client.server || '',
          })
        }
      },
    })
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
