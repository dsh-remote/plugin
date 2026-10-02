/**
 * client — DSH Remote Control 小程序客户端核心。
 *
 * 握手流程（与 e2e/run.mjs 验证过的一致）：
 *   hello(role:client) -> hello-ok
 *   pair-begin-client(token) -> paired{hostId, sessionId}
 *   keys = derivePskKey(psk, 'c2h'|'h2c', sessionId)
 *   之后每个 payload 都以 { t:'enc', sessionId, seq, ciphertext } 传输。
 *
 * 中继只能看到密文 —— 它经手的控制面帧（hello / pair / peer 事件 / error）
 * 都在这里处理。
 */
'use strict'

var codec = require('./codec.js')
var store = require('./session-store.js')
var socket = require('./socket.js')

var PROTOCOL_VERSION = 1

class DrcClient {
  constructor() {
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
    this.clientId = ''
    this.sock = null

    this._listeners = []
    this._pendingToken = null
    this._cmdSeq = 0
    this._resume = null
    this._decryptFails = 0
  }

  // ── 事件 ──────────────────────────────────────────────────────────
  on(fn) {
    this._listeners.push(fn)
    return () => {
      this._listeners = this._listeners.filter((f) => f !== fn)
    }
  }

  emit(evt) {
    for (var i = 0; i < this._listeners.length; i++) {
      try {
        this._listeners[i](evt)
      } catch (e) {
        /* 一个页面挂了不能拖垮传输层 */
      }
    }
  }

  _setStatus(status, text) {
    this.status = status
    this.statusText = text || ''
    this.emit({ kind: 'status', status: status, text: this.statusText })
  }

  // ── 启动 / 恢复 ───────────────────────────────────────────────────
  /** 载入上次持久化的内容（server + psk + convId）。 */
  hydrate() {
    this.clientId = store.installId()
    var p = store.loadPairing()
    if (p) {
      this.server = p.server
      this.psk = p.psk
      this.convId = p.convId
      this.hostId = p.hostId || ''
      this.hostLabel = p.hostLabel || ''
      this._resume = p
      this.kC2H = codec.derivePskKey(this.psk, 'c2h', this.convId)
      this.kH2C = codec.derivePskKey(this.psk, 'h2c', this.convId)
    }
    if (!this.server) this.server = store.serverUrl()
    return this
  }

  isPaired() {
    return !!this.convId && !!this.kC2H
  }

  /**
   * 打开 socket 并（重新）跑握手。
   * @param {Object} opts { server?, psk?, token? } —— token 触发一次全新配对。
   */
  connect(opts) {
    opts = opts || {}
    if (opts.server) {
      this.server = opts.server
      store.setServerUrl(opts.server)
    }
    if (opts.psk) this.psk = opts.psk
    if (opts.token) this._pendingToken = codec.normalizePairingToken(opts.token)

    if (!this.server) {
      this._setStatus('needs-pair', '请先扫码或填写中继服务地址')
      return
    }
    if (!this.clientId) this.clientId = store.installId()

    this._setStatus('connecting', '正在连接 ' + this.server)

    if (this.sock) this.sock.close()
    this.sock = socket.createSocket({
      url: this.server,
      onOpen: () => {
        this.sendControl({
          t: 'hello',
          role: 'client',
          protocol: PROTOCOL_VERSION,
          clientId: this.clientId,
          clientMeta: { platform: 'wechat-mp', label: '微信小程序' },
        })
      },
      onMessage: (data) => this._onFrame(data),
      onClose: () => {
        if (this.status !== 'needs-pair') this._setStatus('connecting', '连接已断开，正在重连…')
      },
      onError: (e) => {
        this.emit({ kind: 'error', message: (e && (e.errMsg || e.message)) || 'socket error' })
      },
    })
    this.sock.open()
  }

  disconnect() {
    if (this.sock) this.sock.close()
    this.sock = null
    this._setStatus('idle', '已断开')
  }

  /** 彻底忘记配对（主机每次新配对都会换 PSK）。 */
  unpair() {
    this.disconnect()
    this._forgetPairing()
    this.psk = ''
    this._setStatus('needs-pair', '已解除配对')
  }

  _forgetPairing() {
    store.clearPairing()
    this.convId = ''
    this.kC2H = null
    this.kH2C = null
    this._resume = null
    this.sessions = []
    this.keepAwake = null
    this._decryptFails = 0
  }

  /** 配对不可用了：丢掉并要求重新扫码。 */
  _resetPairing(why) {
    this.disconnect()
    this._forgetPairing()
    this._setStatus('needs-pair', why)
    this.emit({ kind: 'error', message: why })
  }

  // ── 发送 ──────────────────────────────────────────────────────────
  sendControl(frame) {
    return this.sock ? this.sock.send(frame) : false
  }

  /** 加密并发送一个 payload 给主机。 */
  sendCmd(cmd) {
    if (!this.isPaired() || !this.sock) {
      this.emit({ kind: 'error', message: '尚未配对，无法发送指令' })
      return false
    }
    if (!cmd.cmdId) cmd.cmdId = this.newCmdId()
    var pairing = this._resume || { psk: this.psk, convId: this.convId, nonceCounter: 0 }
    var nonce = store.nextNonceFor(pairing)
    var rec = codec.seal(this.kC2H, cmd, nonce)
    return this.sendControl({
      t: 'enc',
      sessionId: this.convId,
      seq: ++this.seq,
      clientId: this.clientId,
      ciphertext: rec.ciphertext,
    })
  }

  newCmdId() {
    this._cmdSeq++
    return 'c' + Date.now().toString(36) + '_' + this._cmdSeq
  }

  // ── 接收：控制面 ──────────────────────────────────────────────────
  _onFrame(raw) {
    var f
    try {
      f = JSON.parse(raw)
    } catch (e) {
      return
    }
    if (!f || !f.t) return

    switch (f.t) {
      case 'hello-ok':
        this._onHelloOk(f)
        return
      case 'paired':
        this._onPaired(f)
        return
      case 'pair-fail':
        this._pendingToken = null
        this._setStatus('needs-pair', '配对失败：' + translatePairFail(f.reason))
        return
      case 'peer-left':
        // 主机掉了，会话没了 —— 只能重新配对
        this._forgetPairing()
        this._setStatus('needs-pair', '主机已断开，请重新配对')
        return
      case 'peer-joined':
        this.emit({ kind: 'notice', text: '新的客户端加入了会话' })
        return
      case 'error':
        if (f.code === 'unknown_session') {
          this._forgetPairing()
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
      case 'enc-batch':
        // 协议里有定义（批量帧），主机当前没发，但收到时必须能解
        if (Array.isArray(f.items)) {
          for (var i = 0; i < f.items.length; i++) {
            this._onEncrypted({ sessionId: f.sessionId, ciphertext: f.items[i].ciphertext })
          }
        }
        return
      default:
        return
    }
  }

  _onHelloOk(f) {
    if (f.clientId) this.clientId = f.clientId
    if (this._pendingToken) {
      this._setStatus('pairing', '正在配对…')
      this.sendControl({ t: 'pair-begin-client', pairingToken: this._pendingToken })
    } else if (this.isPaired()) {
      // 恢复尝试 —— 会话可能服务端已经没了
      this._setStatus('online', '已连接，正在恢复会话')
      this.sendCmd({ t: 'cmd.list_sessions', cmdId: this.newCmdId() })
    } else {
      this._setStatus('needs-pair', '请输入主机上的 6 位配对码')
    }
  }

  _onPaired(f) {
    this._pendingToken = null
    this.convId = f.sessionId
    this.hostId = f.hostId || ''
    this.kC2H = codec.derivePskKey(this.psk, 'c2h', this.convId)
    this.kH2C = codec.derivePskKey(this.psk, 'h2c', this.convId)
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
    // 主机在 peer-joined 时会推 sessions + keep-awake，但主动再要一次，
    // 保证主机正在忙的时候列表也能填上
    this.sendCmd({ t: 'cmd.list_sessions', cmdId: this.newCmdId() })
  }

  // ── 接收：数据面（密文） ──────────────────────────────────────────
  _onEncrypted(f) {
    if (!this.kH2C) return
    var payload = codec.open(this.kH2C, f)
    if (!payload) {
      // 密钥对不上意味着这个会话已经废了 —— 之后每一帧都会同样失败。
      // 别让用户对着空列表发呆：丢掉配对并明说怎么办。先给两次机会，
      // 免得一条损坏的帧误杀一个健康的配对。
      this._decryptFails++
      if (this._decryptFails >= 2) {
        this._resetPairing('配对已失效（密钥不匹配），请重新扫码')
        return
      }
      this.emit({ kind: 'error', message: '有一条数据无法解密，若持续出现请重新扫码配对' })
      return
    }
    this._decryptFails = 0
    // 每个页面都要的簿记放在这里，页面保持「哑」
    if (payload.t === 'ev.session_changed') {
      this.sessions = payload.sessions || []
    } else if (payload.t === 'ev.keep_awake_state') {
      this.keepAwake = payload
    }
    this.emit({ kind: 'payload', payload: payload })
  }

  // ── 页面用的便捷指令 ──────────────────────────────────────────────
  listSessions() {
    return this.sendCmd({ t: 'cmd.list_sessions', cmdId: this.newCmdId() })
  }

  sendPrompt(sessionId, text) {
    return this.sendCmd({ t: 'cmd.send_prompt', cmdId: this.newCmdId(), sessionId: sessionId, text: text })
  }

  interrupt(sessionId) {
    return this.sendCmd({ t: 'cmd.interrupt', cmdId: this.newCmdId(), sessionId: sessionId })
  }

  resolvePermission(sessionId, requestId, decision) {
    return this.sendCmd({
      t: 'cmd.resolve_permission',
      cmdId: this.newCmdId(),
      sessionId: sessionId,
      requestId: requestId,
      decision: decision,
    })
  }

  answer(sessionId, requestId, answers) {
    return this.sendCmd({
      t: 'cmd.answer',
      cmdId: this.newCmdId(),
      sessionId: sessionId,
      requestId: requestId,
      answers: answers,
    })
  }

  setKeepAwake(enabled, idleReleaseSec) {
    var cmd = { t: 'cmd.keep_awake', cmdId: this.newCmdId(), enabled: !!enabled }
    if (idleReleaseSec !== undefined && idleReleaseSec !== null) cmd.idleReleaseSec = idleReleaseSec
    return this.sendCmd(cmd)
  }
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
