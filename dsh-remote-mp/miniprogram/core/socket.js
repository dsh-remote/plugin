/**
 * socket — 小程序 WebSocket 封装（自动重连 + 连接超时 + 双路径）。
 *
 * 两条实现路径，按运行环境自动选择：
 *   1. SocketTask（基础库 1.7.0+）：connectSocket() 返回带 onOpen/onMessage 的任务对象；
 *   2. 旧式全局回调：消息走 onSocketOpen/onSocketMessage/onSocketError/onSocketClose。
 *
 * 第 2 条不是历史包袱：手机上的体验版容器出现过 connectSocket 存在但返回
 * 对象不完整、甚至根本没有该方法的情况。多一条路径就多一种能跑起来的环境；
 * 两者都没有时，如实报「环境缺能力」并停止重连，而不是把 TypeError 抛给用户。
 *
 * 只发起一次连接：拿到对象但接口不完整时，复用这次连接去绑全局回调，
 * 不重复调用 connectSocket（部分宿主会报 "socket is already connected"）。
 */
'use strict'

var env = require('./env.js')

var RECONNECT_MIN_MS = 1000
var RECONNECT_MAX_MS = 30000
/** 没人喜欢一直转圈：连不上就明说 */
var CONNECT_TIMEOUT_MS = 12000

/**
 * 微信连非法域名时只回一句英文（`url not in domain list`），可这恰恰是
 * 真机上最常见的一种失败：中继域名没配进小程序后台的「socket 合法域名」。
 * 原文照弹，用户既看不懂，也不知道该去哪儿改 —— 于是只会觉得"连不上"。
 *
 * 开发版可以在手机上「打开调试模式」绕过域名校验，体验版和正式版不行，
 * 所以这句提示里必须点明区别，否则用户会在开发版上试通、到体验版又懵。
 */
function explainError(e) {
  var raw = (e && (e.errMsg || e.message)) || ''
  if (typeof raw === 'string' && /not in domain|domain list|非法域名/i.test(raw)) {
    var err = new Error(
      '中继域名不在小程序的 socket 合法域名里。去微信公众平台 → 开发管理 → ' +
        '开发设置 → 服务器域名，把中继域名加进 socket 合法域名。' +
        '（开发版可在手机上打开调试模式临时绕过，体验版不行）',
    )
    err.raw = raw
    return err
  }
  return e
}

class Socket {
  constructor(opts) {
    this._url = opts.url
    this._onOpen = opts.onOpen || noop
    this._onMessage = opts.onMessage || noop
    this._onClose = opts.onClose || noop
    this._onError = opts.onError || noop
    this._forceLegacy = opts.forceLegacy === true

    this._manualClose = false
    this._task = null
    this._retry = 0
    this._reconnectTimer = null
    this._openTimer = null
    /** 本次连接是否收到过 onOpen —— 连接超时判断以它为准，而不是「已绑定」 */
    this._opened = false
    /** 'task' | 'legacy' | null —— 当前实际走的实现路径 */
    this._mode = null
    this._legacyBound = false
  }

  open() {
    if (this._manualClose) return
    this._opened = false
    var host = env.hostApi()
    var api = host && host.api
    if (!api || typeof api.connectSocket !== 'function') {
      // 旧实现直接 wx.connectSocket(...)，在没有该 API 的容器里只留一句
      // "is not a function"，用户既不知道缺什么也不知道怎么办。
      this._fatal(env.unavailableError())
      return
    }

    var created = null
    var attempted = false
    if (!this._forceLegacy) {
      attempted = true
      try {
        created = api.connectSocket({
          url: this._url,
          fail: (e) => {
            this._fail(e)
            this._scheduleReconnect()
          },
        })
      } catch (e) {
        this._fail(e)
      }
      if (created && typeof created.onOpen === 'function' && typeof created.send === 'function') {
        this._bindTask(created)
        return
      }
    }

    if (env.probe().legacySocket) {
      this._bindLegacy(api, created)
      // 旧式 API 的 connectSocket 本来就不返回对象，上面那次调用已经把连接
      // 发起了；只有还没发起过才补一次 connect，否则宿主会拒绝（already connected）。
      if (!attempted) {
        try {
          api.connectSocket({ url: this._url })
        } catch (e) {
          this._fail(e)
          this._scheduleReconnect()
        }
      }
      return
    }

    if (created) {
      // 两条路都不通但连接可能已经建立 —— 关掉，别留下没人消费的 socket。
      try {
        created.close && created.close()
      } catch (e) {
        /* ignore */
      }
    }
    this._fatal(env.unavailableError())
  }

  send(obj) {
    if (!this._task) return false
    try {
      this._task.send({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) })
      return true
    } catch (e) {
      return false
    }
  }

  close() {
    this._manualClose = true
    this._clearOpenTimer()
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    try {
      this._task && this._task.close()
    } catch (e) {
      /* ignore */
    }
    this._task = null
  }

  isOpen() {
    return !!this._task
  }

  /** 供界面显示当前走的是哪条实现路径 */
  transport() {
    return this._mode
  }

  // ── internals ─────────────────────────────────────────────────────

  _bindTask(t) {
    this._mode = 'task'
    this._task = t
    this._armOpenTimeout()
    t.onOpen(() => {
      this._clearOpenTimer()
      this._opened = true
      this._retry = 0
      this._onOpen()
    })
    t.onMessage((res) => this._onMessage(res && res.data))
    t.onError((e) => this._fail(e))
    t.onClose(() => {
      this._task = null
      this._onClose()
      this._scheduleReconnect()
    })
  }

  /**
   * 旧式全局回调。全局监听器整个宿主共享，重复注册会叠加回调，因此只绑
   * 一次，并用 _mode 把上一轮连接的迟到事件丢掉。
   */
  _bindLegacy(api, existing) {
    this._mode = 'legacy'
    var self = this
    this._task = {
      send: function (obj) {
        // 外层传入的已经是 { data: string }；别把包装对象再序列化一遍
        var data =
          typeof obj === 'string'
            ? obj
            : obj && typeof obj.data === 'string'
              ? obj.data
              : JSON.stringify(obj)
        if (typeof api.sendSocketMessage === 'function') api.sendSocketMessage({ data: data })
        else if (existing && typeof existing.send === 'function') existing.send({ data: data })
      },
      close: function () {
        if (typeof api.closeSocket === 'function') api.closeSocket()
        else if (existing && typeof existing.close === 'function') existing.close()
      },
    }

    this._armOpenTimeout()
    if (this._legacyBound) return
    this._legacyBound = true
    api.onSocketOpen(function () {
      if (self._mode !== 'legacy' || !self._task) return
      self._clearOpenTimer()
      self._opened = true
      self._retry = 0
      self._onOpen()
    })
    api.onSocketMessage(function (res) {
      if (self._mode !== 'legacy' || !self._task) return
      self._onMessage(res && res.data)
    })
    api.onSocketError(function (e) {
      if (self._mode !== 'legacy' || !self._task) return
      self._fail(e)
    })
    api.onSocketClose(function () {
      if (self._mode !== 'legacy') return
      self._task = null
      self._onClose()
      self._scheduleReconnect()
    })
  }

  /**
   * 连不上必须说出来。没有超时的话，握手没响应时界面会永远停在「连接中」——
   * 用户既不知道卡在哪，也没法判断是地址错、中继没起，还是容器发不出请求。
   */
  _armOpenTimeout() {
    this._clearOpenTimer()
    this._openTimer = setTimeout(() => {
      this._openTimer = null
      if (this._opened || this._manualClose) return
      try {
        this._task && this._task.close && this._task.close()
      } catch (e) {
        /* ignore */
      }
      this._task = null
      this._onError(
        new Error(
          '连接超时：' +
            CONNECT_TIMEOUT_MS / 1000 +
            ' 秒内没有建立连接。检查中继地址与网络，或主机端是否在线。',
        ),
      )
      this._scheduleReconnect()
    }, CONNECT_TIMEOUT_MS)
  }

  _clearOpenTimer() {
    if (this._openTimer) {
      clearTimeout(this._openTimer)
      this._openTimer = null
    }
  }

  _scheduleReconnect() {
    if (this._manualClose || this._reconnectTimer) return
    var delay = Math.min(RECONNECT_MIN_MS * Math.pow(2, this._retry), RECONNECT_MAX_MS)
    delay += Math.floor(Math.random() * 500)
    this._retry++
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this.open()
    }, delay)
  }

  /** 连接层面出错的统一出口：先过一遍文案归一化（见 explainError） */
  _fail(err) {
    this._onError(explainError(err))
  }

  _fatal(err) {
    // 环境缺能力：重连没有意义，停手并如实上报，避免无限刷错误
    this._manualClose = true
    this._onError(err)
  }
}

function noop() {}

function createSocket(opts) {
  return new Socket(opts)
}

module.exports = { createSocket: createSocket, CONNECT_TIMEOUT_MS: CONNECT_TIMEOUT_MS }
