/**
 * platform — 运行环境探测。
 *
 * 背景：把小程序的发布版本放到手机上跑时，出现过
 * `wx.connectSocket is not a function`。这说明**运行容器并没有实现完整的 wx API**
 * （体验版容器不等同于微信正式运行时）。在此之前，代码是直接调用 `wx.connectSocket`，
 * 于是失败变成一句 TypeError，既看不出缺什么、也不知道下一步该做什么。
 *
 * 这里做两件事：
 *   1. 启动时（以及配对失败时）把「这个容器到底有什么」采集下来，压成一行可复制文本；
 *   2. 让传输层可以据此选择实现路径，而不是假设某个 API 一定存在。
 *
 * 所有读取都做了防御：探测本身绝不允许抛异常。
 */

/** 各平台宿主对象的名字，按可能性排序。 */
var HOST_NAMES = ['wx', 'my', 'tt', 'qq', 'swan', 'jd']

/** 取当前宿主对象（wx / my / tt …），取不到返回 null。 */
function hostApi() {
  for (var i = 0; i < HOST_NAMES.length; i++) {
    var name = HOST_NAMES[i]
    try {
      var candidate = typeof globalThis !== 'undefined' ? globalThis[name] : undefined
      if (!candidate && typeof global !== 'undefined') candidate = global[name]
      if (candidate && typeof candidate === 'object') return { name: name, api: candidate }
    } catch (e) {
      /* 某些容器会对 globalThis 取属性抛错，忽略继续 */
    }
  }
  return null
}

function has(api, name) {
  try {
    return !!api && typeof api[name] === 'function'
  } catch (e) {
    return false
  }
}

function call(api, name) {
  try {
    return has(api, name) ? api[name]() : undefined
  } catch (e) {
    return undefined
  }
}

/**
 * 采集能力清单（原始采集，见 probe 的缓存包装）。
 * @returns {object} 各能力是否可用，以及可供诊断的原始信息。
 */
function collect() {
  var host = hostApi()
  var api = host ? host.api : null
  var info = call(api, 'getSystemInfoSync') || {}

  var socketNames = []
  try {
    if (api) {
      var keys = Object.keys(api)
      for (var i = 0; i < keys.length && socketNames.length < 12; i++) {
        if (/socket/i.test(keys[i])) socketNames.push(keys[i])
      }
    }
  } catch (e) {
    /* 某些容器不允许枚举 */
  }

  return {
    global: host ? host.name : '(none)',
    sdkVersion: info.SDKVersion || '',
    platform: info.platform || '',
    system: info.system || '',
    connectSocket: has(api, 'connectSocket'),
    // 旧式全局回调 API：connectSocket 只负责发起，消息走 wx.onSocketMessage
    legacySocket:
      has(api, 'onSocketOpen') && has(api, 'onSocketMessage') && has(api, 'sendSocketMessage'),
    request: has(api, 'request'),
    storage: has(api, 'getStorageSync') && has(api, 'setStorageSync'),
    scanCode: has(api, 'scanCode'),
    showToast: has(api, 'showToast'),
    navigateTo: has(api, 'navigateTo'),
    socketApis: socketNames,
  }
}

/** 压成一行，方便用户直接复制发回来。 */
function summary() {
  var p = probe()
  var parts = [
    'GLOBAL=' + p.global,
    'SDK=' + (p.sdkVersion || '?'),
    'PLATFORM=' + (p.platform || '?'),
    'SOCKET=' + (p.connectSocket ? 'yes' : 'NO'),
    'LEGACY=' + (p.legacySocket ? 'yes' : 'no'),
    'REQUEST=' + (p.request ? 'yes' : 'no'),
    'STORAGE=' + (p.storage ? 'yes' : 'no'),
    'SCAN=' + (p.scanCode ? 'yes' : 'no'),
  ]
  if (p.socketApis.length) parts.push('SOCKET_APIS=' + p.socketApis.join('|'))
  else parts.push('SOCKET_APIS=(none)')
  return parts.join(' ')
}

/**
 * 传输层不可用时的错误。
 *
 * 带上能力摘要：出问题时用户只需要把这一行发回来，就能判断是容器缺 API、
 * 还是域名白名单/网络被拦。
 */
function unavailableError() {
  var err = new Error(
    '当前运行环境没有 WebSocket 能力（' +
      probe().global +
      '.connectSocket 不存在），无法连接中继。\n诊断：' +
      summary() +
      '\n可用微信开发者工具，或用自己的 AppID 以真机调试方式运行。',
  )
  err.code = 'SOCKET_UNAVAILABLE'
  return err
}

/** 缓存：探测要枚举宿主对象，没必要每次重连都做一遍。 */
var cachedProbe = null

/**
 * 采集能力清单（带缓存）。
 * @param {boolean} [force] 传 true 强制重新采集。
 * @returns {object} 能力清单。
 */
function probe(force) {
  if (cachedProbe && force !== true) return cachedProbe
  cachedProbe = collect()
  return cachedProbe
}

module.exports = {
  HOST_NAMES: HOST_NAMES,
  hostApi: hostApi,
  probe: probe,
  summary: summary,
  unavailableError: unavailableError,
}
