/**
 * store — persistence for the Mini Program client.
 *
 * Everything here is non-secret EXCEPT the pairing PSK, which lives only in
 * the pairing record below (WeChat storage is sandboxed per app + device).
 * Losing it simply means "pair again"; the host rotates the PSK per pairing.
 */
var crypto = require('./drc-crypto.js')

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
 * Stable per-install id. Feeds the nonce prefix so that a wiped storage
 * (counter restarts at 0) can never reuse a nonce under the same key.
 */
function installId() {
  var id = read(KEY_INSTALL, '')
  if (!id) {
    id = crypto.randomId()
    write(KEY_INSTALL, id)
  }
  return id
}

/**
 * @typedef {Object} Pairing
 * @property {string} server    ws(s):// url of the relay
 * @property {string} psk       base64 16B pre-shared secret (from QR)
 * @property {string} convId    conversation / session id assigned by relay
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
 * Monotonic nonce counter for a conversation (persisted, so an app restart
 * cannot repeat a nonce under the same key).
 */
function nextNonceFor(pairing) {
  var c = Number(pairing.nonceCounter || 0) + 1
  pairing.nonceCounter = c
  savePairing(pairing)
  var prefix = crypto.noncePrefix(pairing.psk, pairing.convId, installId())
  return crypto.buildNonce(prefix, c)
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
