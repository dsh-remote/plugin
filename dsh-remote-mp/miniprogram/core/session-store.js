/**
 * session-store — 小程序客户端的持久化。
 *
 * 除配对 PSK 外都不是秘密；PSK 只存在下面的配对记录里（微信存储按
 * app+设备沙箱隔离）。丢了它的代价只是「重新扫码」——主机每次配对都会换 PSK。
 */
'use strict'

var codec = require('./codec.js')

var KEY_PAIRING = 'drc.pairing.v1'
var KEY_INSTALL = 'drc.installId'
var KEY_SERVER = 'drc.serverUrl'
var KEY_KEEPAWAKE = 'drc.keepAwakePref'

function read(key, fallback) {
  try {
    var v = wx.getStorageSync(key)
    return v === '' || v === undefined || v === null ? fallback : v
  } catch (e) {
    return fallback
  }
}

function write(key, value) {
  try {
    wx.setStorageSync(key, value)
    return true
  } catch (e) {
    return false
  }
}

function remove(key) {
  try {
    wx.removeStorageSync(key)
  } catch (e) {
    /* ignore */
  }
}

/**
 * 稳定的按安装 id。nonce 前缀里有它：存储被清空（计数器归零）时
 * installId 也会重新生成，同一 key 下 nonce 绝不复用。
 */
function installId() {
  var id = read(KEY_INSTALL, '')
  if (!id) {
    id = codec.randomId()
    write(KEY_INSTALL, id)
  }
  return id
}

/**
 * @typedef {Object} Pairing
 * @property {string} server    中继 ws(s):// 地址
 * @property {string} psk       base64 16B 预共享密钥（来自二维码）
 * @property {string} convId    中继分配的会话 id
 * @property {string} hostId
 * @property {string} hostLabel
 * @property {number} nonceCounter
 * @property {number} pairedAt
 */

/** @returns {Pairing|null} */
function loadPairing() {
  var p = read(KEY_PAIRING, null)
  if (!p || typeof p !== 'object') return null
  if (!p.server || !p.psk || !p.convId) return null
  return p
}

function savePairing(pairing) {
  return write(KEY_PAIRING, pairing)
}

function clearPairing() {
  remove(KEY_PAIRING)
}

/**
 * 会话内单调递增的 nonce（持久化：app 重启不能在同一 key 下重复 nonce）。
 */
function nextNonceFor(pairing) {
  var c = Number(pairing.nonceCounter || 0) + 1
  pairing.nonceCounter = c
  savePairing(pairing)
  var prefix = codec.noncePrefix(pairing.psk, pairing.convId, installId())
  return codec.buildNonce(prefix, c)
}

function serverUrl() {
  return read(KEY_SERVER, '')
}

function setServerUrl(u) {
  return write(KEY_SERVER, u)
}

function keepAwakePref() {
  return read(KEY_KEEPAWAKE, null)
}

function setKeepAwakePref(v) {
  return write(KEY_KEEPAWAKE, v)
}

module.exports = {
  installId: installId,
  loadPairing: loadPairing,
  savePairing: savePairing,
  clearPairing: clearPairing,
  nextNonceFor: nextNonceFor,
  serverUrl: serverUrl,
  setServerUrl: setServerUrl,
  keepAwakePref: keepAwakePref,
  setKeepAwakePref: setKeepAwakePref,
}
