/**
 * drc — the DSH Remote Control client core for the Mini Program.
 *
 * Mirrors the handshake proven by e2e/run.mjs:
 *   hello(role:client) -> hello-ok
 *   pair-begin-client(token) -> paired{hostId, sessionId}
 *   keys = derivePskKey(psk, 'c2h'|'h2c', sessionId)
 *   then every payload travels as { t:'enc', sessionId, seq, ciphertext }
 *
 * The relay only ever sees ciphertext — everything it does see here is
 * control plane (hello / pair / peer events / errors).
 */
var crypto = require('./drc-crypto.js')
var store = require('./store.js')
var ws = require('./ws.js')

var PROTOCOL = 1

function DrcClient() {
  this.status = 'idle' // idle | connecting | pairing | online | needs-pair | error
  this.statusText = ''
  this.server = ''
  this.psk = ''
  this.convId = ''
  this.hostId = ''
  this.hostLabel = ''
  this.seq = 0
  this.kC2H = null
  this.kH2C = null
  this.sessions = []
  this.keepAwake = null
  this.listeners = []
  this.sock = null
  this.clientId = ''
  this._pendingToken = null
  this._cmdSeq = 0
  this._resume = null
}

DrcClient.prototype.on = function (fn) {
  this.listeners.push(fn)
  var self = this
  return function () {
    self.listeners = self.listeners.filter(function (f) {
      return f !== fn
    })
  }
}

DrcClient.prototype.emit = function (evt) {
  for (var i = 0; i < this.listeners.length; i++) {
    try {
      this.listeners[i](evt)
    } catch (e) {
      /* a broken page must not break the transport */
    }
  }
}

DrcClient.prototype._setStatus = function (status, text) {
  this.status = status
  this.statusText = text || ''
  this.emit({ kind: 'status', status: status, text: this.statusText })
}

/** Load whatever we persisted last time (server + psk + convId). */
DrcClient.prototype.hydrate = function () {
  this.clientId = store.installId()
  var p = store.loadPairing()
  if (p) {
    this.server = p.server
    this.psk = p.psk
    this.convId = p.convId
    this.hostId = p.hostId || ''
    this.hostLabel = p.hostLabel || ''
    this._resume = p
    this.kC2H = crypto.derivePskKey(this.psk, 'c2h', this.convId)
    this.kH2C = crypto.derivePskKey(this.psk, 'h2c', this.convId)
  }
  if (!this.server) this.server = store.serverUrl()
  return this
}

DrcClient.prototype.isPaired = function () {
  return !!this.convId && !!this.kC2H
}

/**
 * Open the socket and (re)run the handshake.
 * @param {Object} opts  { server?, psk?, token? } — token triggers a fresh pair.
 */
DrcClient.prototype.connect = function (opts) {
  opts = opts || {}
  if (opts.server) {
    this.server = opts.server
    store.setServerUrl(opts.server)
  }
  if (opts.psk) this.psk = opts.psk
  if (opts.token) this._pendingToken = crypto.normalizePairingToken(opts.token)

  if (!this.server) {
    this._setStatus('needs-pair', '请先扫码或填写中继服务地址')
    return
  }
  if (!this.clientId) this.clientId = store.installId()

  this._setStatus('connecting', '正在连接 ' + this.server)

  var self = this
  if (this.sock) this.sock.close()

  this.sock = ws.createSocket({
    url: self.server,
    onOpen: function () {
      self.sendControl({
        t: 'hello',
        role: 'client',
        protocol: PROTOCOL,
        clientId: self.clientId,
        clientMeta: { platform: 'wechat-mp', label: '微信小程序' },
      })
    },
    onMessage: function (data) {
      self._onFrame(data)
    },
    onClose: function () {
      if (self.status !== 'needs-pair') self._setStatus('connecting', '连接已断开，正在重连…')
    },
    onError: function (e) {
      self.emit({ kind: 'error', message: (e && (e.errMsg || e.message)) || 'socket error' })
    },
  })
  this.sock.open()
}

DrcClient.prototype.disconnect = function () {
  if (this.sock) this.sock.close()
  this.sock = null
  this._setStatus('idle', '已断开')
}

/** Forget the pairing entirely (host rotates PSK on every new pairing). */
DrcClient.prototype.unpair = function () {
  this.disconnect()
  store.clearPairing()
  this.convId = ''
  this.psk = ''
  this.kC2H = null
  this.kH2C = null
  this._resume = null
  this.sessions = []
  this.keepAwake = null
  this._setStatus('needs-pair', '已解除配对')
}

DrcClient.prototype.sendControl = function (frame) {
  return this.sock ? this.sock.send(frame) : false
}

/** Encrypt + send a payload to the host. */
DrcClient.prototype.sendCmd = function (cmd) {
  if (!this.isPaired() || !this.sock) {
    this.emit({ kind: 'error', message: '尚未配对，无法发送指令' })
    return false
  }
  if (!cmd.cmdId) cmd.cmdId = this.newCmdId()
  var pairing = this._resume || { psk: this.psk, convId: this.convId, nonceCounter: 0 }
  var nonce = store.nextNonceFor(pairing)
  var rec = crypto.seal(this.kC2H, cmd, nonce)
  return this.sendControl({
    t: 'enc',
    sessionId: this.convId,
    seq: ++this.seq,
    clientId: this.clientId,
    ciphertext: rec.ciphertext,
  })
}

DrcClient.prototype.newCmdId = function () {
  this._cmdSeq++
  return 'c' + Date.now().toString(36) + '_' + this._cmdSeq
}

// ── inbound ──────────────────────────────────────────────────────────
DrcClient.prototype._onFrame = function (raw) {
  var f
  try {
    f = JSON.parse(raw)
  } catch (e) {
    return
  }
  if (!f || !f.t) return

  switch (f.t) {
    case 'hello-ok':
      if (f.clientId) this.clientId = f.clientId
      if (this._pendingToken) {
        this._setStatus('pairing', '正在配对…')
        this.sendControl({ t: 'pair-begin-client', pairingToken: this._pendingToken })
      } else if (this.isPaired()) {
        // resume attempt — the conversation may already be gone server-side
        this._setStatus('online', '已连接，正在恢复会话')
        this.sendCmd({ t: 'cmd.list_sessions', cmdId: this.newCmdId() })
      } else {
        this._setStatus('needs-pair', '请输入主机上的 6 位配对码')
      }
      return

    case 'paired':
      this._onPaired(f)
      return

    case 'pair-fail':
      this._pendingToken = null
      this._setStatus('needs-pair', '配对失败：' + translatePairFail(f.reason))
      return

    case 'peer-left':
      // host dropped; conversation is gone — a new pairing is required
      this.convId = ''
      this.kC2H = null
      this.kH2C = null
      store.clearPairing()
      this._setStatus('needs-pair', '主机已断开，请重新配对')
      return

    case 'peer-joined':
      this.emit({ kind: 'notice', text: '新的客户端加入了会话' })
      return

    case 'error':
      if (f.code === 'unknown_session') {
        this.convId = ''
        this.kC2H = null
        this.kH2C = null
        store.clearPairing()
        this._setStatus('needs-pair', '会话已失效，请重新配对')
      } else {
        this.emit({ kind: 'error', message: f.message || f.code || 'unknown error' })
      }
      return

    case 'pong':
      return

    case 'enc':
      this._onEncrypted(f)
      return

    default:
      return
  }
}

DrcClient.prototype._onPaired = function (f) {
  this._pendingToken = null
  this.convId = f.sessionId
  this.hostId = f.hostId || ''
  this.kC2H = crypto.derivePskKey(this.psk, 'c2h', this.convId)
  this.kH2C = crypto.derivePskKey(this.psk, 'h2c', this.convId)
  var pairing = {
    server: this.server,
    psk: this.psk,
    convId: this.convId,
    hostId: this.hostId,
    hostLabel: this.hostLabel,
    nonceCounter: 0,
    pairedAt: Date.now(),
  }
  this._resume = pairing
  store.savePairing(pairing)
  this._setStatus('online', '已配对到 ' + (this.hostLabel || this.hostId || '主机'))
  // the host pushes sessions + keep-awake on peer-joined, but ask anyway so
  // the list is populated even if the host is mid-flight
  this.sendCmd({ t: 'cmd.list_sessions', cmdId: this.newCmdId() })
}

DrcClient.prototype._onEncrypted = function (f) {
  if (!this.kH2C) return
  var payload = crypto.open(this.kH2C, f)
  if (!payload) {
    this.emit({ kind: 'error', message: '收到无法解密的数据（密钥不匹配？）' })
    return
  }
  // bookkeeping that every page needs, kept here so pages stay dumb
  if (payload.t === 'ev.session_changed') {
    this.sessions = payload.sessions || []
  } else if (payload.t === 'ev.keep_awake_state') {
    this.keepAwake = payload
  }
  this.emit({ kind: 'payload', payload: payload })
}

// ── convenience commands used by the pages ───────────────────────────
DrcClient.prototype.listSessions = function () {
  return this.sendCmd({ t: 'cmd.list_sessions', cmdId: this.newCmdId() })
}

DrcClient.prototype.sendPrompt = function (sessionId, text) {
  return this.sendCmd({ t: 'cmd.send_prompt', cmdId: this.newCmdId(), sessionId: sessionId, text: text })
}

DrcClient.prototype.interrupt = function (sessionId) {
  return this.sendCmd({ t: 'cmd.interrupt', cmdId: this.newCmdId(), sessionId: sessionId })
}

DrcClient.prototype.resolvePermission = function (sessionId, requestId, decision) {
  return this.sendCmd({
    t: 'cmd.resolve_permission',
    cmdId: this.newCmdId(),
    sessionId: sessionId,
    requestId: requestId,
    decision: decision,
  })
}

DrcClient.prototype.answer = function (sessionId, requestId, answers) {
  return this.sendCmd({
    t: 'cmd.answer',
    cmdId: this.newCmdId(),
    sessionId: sessionId,
    requestId: requestId,
    answers: answers,
  })
}

DrcClient.prototype.setKeepAwake = function (enabled, idleReleaseSec) {
  var cmd = { t: 'cmd.keep_awake', cmdId: this.newCmdId(), enabled: !!enabled }
  if (idleReleaseSec !== undefined && idleReleaseSec !== null) cmd.idleReleaseSec = idleReleaseSec
  return this.sendCmd(cmd)
}

function translatePairFail(reason) {
  var map = {
    invalid_or_expired: '配对码无效或已过期',
    already_used: '配对码已被使用',
    host_offline: '主机不在线',
    bad_token: '令牌错误',
  }
  return map[reason] || reason || '未知原因'
}

var singleton = null
function getClient() {
  if (!singleton) singleton = new DrcClient().hydrate()
  return singleton
}

module.exports = {
  DrcClient: DrcClient,
  getClient: getClient,
  translatePairFail: translatePairFail,
}
