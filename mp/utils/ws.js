/**
 * ws — 小程序 WebSocket 封装（带重连）。
 *
 * 支持两种实现路径，按运行环境自动选择：
 *   1. SocketTask（基础库 1.7.0+）：`connectSocket()` 返回带 onOpen/onMessage 的任务对象；
 *   2. 旧式全局回调：消息走 `onSocketOpen/onSocketMessage/onSocketError/onSocketClose`。
 *
 * 第 2 条不是历史包袱：手机上的体验版容器出现过 `connectSocket` 存在但返回对象不完整、
 * 甚至根本没有该方法的情况（`wx.connectSocket is not a function`）。多一条路径，
 * 就多一种能跑起来的环境；两者都没有时，如实报「环境缺能力」并停止重连，
 * 而不是把一句 TypeError 抛给用户。
 *
 * 只发起一次连接：拿到对象但接口不完整时，复用这次连接去绑全局回调，
 * 不重复调用 connectSocket（部分宿主会报 "socket is already connected"）。
 */
var platform = require('./platform.js')

var RECONNECT_MIN = 1000
var RECONNECT_MAX = 30000

function createSocket(opts) {
  var url = opts.url
  var onOpen = opts.onOpen || function () {}
  var onMessage = opts.onMessage || function () {}
  var onClose = opts.onClose || function () {}
  var onError = opts.onError || function () {}
  var manualClose = false
  var task = null
  var retry = 0
  var timer = null
  /** 'task' | 'legacy' | null —— 当前实际使用的实现路径 */
  var mode = null
  var legacyBound = false

  function scheduleReconnect() {
    if (manualClose || timer) return
    var delay = Math.min(RECONNECT_MIN * Math.pow(2, retry), RECONNECT_MAX)
    delay = delay + Math.floor(Math.random() * 500)
    retry++
    timer = setTimeout(function () {
      timer = null
      open()
    }, delay)
  }

  function fatal(err) {
    // 环境缺能力：重连没有意义，停手并如实上报，避免无限刷错误
    manualClose = true
    onError(err)
  }

  function bindTask(t) {
    mode = 'task'
    task = t
    t.onOpen(function () {
      retry = 0
      onOpen()
    })
    t.onMessage(function (res) {
      onMessage(res && res.data)
    })
    t.onError(function (e) {
      onError(e)
    })
    t.onClose(function () {
      task = null
      onClose()
      scheduleReconnect()
    })
  }

  /**
   * 旧式全局回调。
   *
   * 全局监听器是整个宿主共享的，重复注册会叠加回调，因此只绑定一次，
   * 并用 `mode` 标记把上一轮连接的迟到事件丢掉。
   */
  function bindLegacy(api, existing) {
    mode = 'legacy'
    task = {
      send: function (obj) {
        // 外层 send 传入的已经是 { data: string }；别把包装对象再序列化一遍
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

    if (legacyBound) return
    legacyBound = true
    api.onSocketOpen(function () {
      if (mode !== 'legacy' || !task) return
      retry = 0
      onOpen()
    })
    api.onSocketMessage(function (res) {
      if (mode !== 'legacy' || !task) return
      onMessage(res && res.data)
    })
    api.onSocketError(function (e) {
      if (mode !== 'legacy' || !task) return
      onError(e)
    })
    api.onSocketClose(function () {
      if (mode !== 'legacy') return
      task = null
      onClose()
      scheduleReconnect()
    })
  }

  function open() {
    if (manualClose) return
    var host = platform.hostApi()
    var api = host && host.api
    if (!api || typeof api.connectSocket !== 'function') {
      // 旧实现直接 `wx.connectSocket(...)`，在没有该 API 的容器里只留一句
      // "is not a function"，用户既不知道缺什么也不知道怎么办。
      fatal(platform.unavailableError())
      return
    }

    var created = null
    var attempted = false
    if (opts.forceLegacy !== true) {
      attempted = true
      try {
        created = api.connectSocket({
          url: url,
          fail: function (e) {
            onError(e)
            scheduleReconnect()
          },
        })
      } catch (e) {
        onError(e)
      }
      if (created && typeof created.onOpen === 'function' && typeof created.send === 'function') {
        bindTask(created)
        return
      }
    }

    if (platform.probe().legacySocket) {
      bindLegacy(api, created)
      // 只有还没发起过才补一次 connect：旧式 API 的 connectSocket 本来就不返回对象，
      // 上面那次调用已经把连接发起了，再调一次会被宿主拒绝（"already connected"）。
      if (!attempted) {
        try {
          api.connectSocket({ url: url })
        } catch (e) {
          onError(e)
          scheduleReconnect()
        }
      }
      return
    }

    if (created) {
      // 对象不完整又只有全局回调可用时上面已经处理；走到这里说明两条路都不通，
      // 但连接可能已经建立 —— 关掉它，别留下一个没人消费的 socket。
      try {
        created.close && created.close()
      } catch (e) {
        /* ignore */
      }
    }
    fatal(platform.unavailableError())
  }

  return {
    open: open,
    send: function (obj) {
      if (!task) return false
      try {
        task.send({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) })
        return true
      } catch (e) {
        return false
      }
    },
    close: function () {
      manualClose = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      try {
        task && task.close()
      } catch (e) {
        /* ignore */
      }
      task = null
    },
    isOpen: function () {
      return !!task
    },
    /** 供界面显示当前走的是哪条实现路径 */
    transport: function () {
      return mode
    },
  }
}

module.exports = { createSocket: createSocket }
