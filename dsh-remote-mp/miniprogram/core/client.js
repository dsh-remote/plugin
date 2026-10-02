/**
 * client — DSH Remote Control 小程序客户端核心。
 *
 * 握手流程（字节级契约见 dsh-remote-protocol）：
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

/**
 * 一页历史等多久算超时。主机会把整份会话日志读出来再切片（真机实测 4 轮 713 行是毫秒级），
 * 但长会话 + 慢磁盘可能到秒级，所以给得比普通命令宽。超时**resolve(null)** 而不是 reject：
 * 页面只需要分得清"拿到了 / 没拿到"，用 reject 会让每个调用点都要写 try/catch。
 */
var HISTORY_TIMEOUT_MS = 15000
/** 一次普通命令（目前只有新建会话）等回执的上限。比读历史短：创建是本地操作，不该慢。 */
var COMMAND_TIMEOUT_MS = 12000

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
    /**
     * cmdId → done(payload)。**回执类**载荷（它只回答我们发出的那一次请求，不是广播）：
     * 取历史（`ev.session_history`）与命令结果（`ev.result`，目前只有新建会话用）都在这里。
     * 一张表按 cmdId 分派，是因为"结算点只有一个"这条纪律不好维护第二份。
     */
    this._cmdWaiters = {}
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
    // 还挂着的回执类请求不会有回音了：就地结算掉，否则页面的「历史读取中」会一直转
    this._settleWaiters(null)
  }

  /**
   * 把所有挂起的**回执类**请求按同一个结果结算（断线/解配时用）。
   *
   * **不能"先换表再回调"**：`done()` 里的幂等守卫查的是 `self._cmdWaiters[cmdId]`，
   * 表一旦先被换成空的，每个回调都会在守卫处早退 —— 连超时那条路也一起被吃掉，
   * 于是断线时页面上的「正在读取主机上的历史…」会永远转下去（不发错、不重试，最难查）。
   * 结算点只有 `done()` 一个，让它自己删自己那一行。
   */
  _settleWaiters(payload) {
    var ids = Object.keys(this._cmdWaiters)
    for (var i = 0; i < ids.length; i++) this._cmdWaiters[ids[i]](payload)
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
      this._setStatus('online', '已连接，正在同步会话列表')
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
    // 回执类载荷：它是**回答我们某一次请求**的，不是一条事件。所以先结算那个 Promise，
    // 并且不再往下当普通事件发一遍 —— 否则页面会同时走两条路处理同一页历史。
    //
    // `ev.result` 也走这里：它有 `cmdId`，所以是"对答"（新建会话在等它），
    // 只有**没有** waiter 时才当普通事件发下去（那是别的命令的回执，页面按老规矩弹提示）。
    if (payload.t === 'ev.session_history' || payload.t === 'ev.result') {
      var waiter = this._cmdWaiters[payload.cmdId]
      // **不要在这里 delete**：结算点只有一个，就是各自 done() 里的那一处。
      // 两边都删过一次 => done() 里的幂等守卫（`if (!self._cmdWaiters[cmdId]) return`）
      // 永远命中，Promise 永不 resolve —— 真机与本地闭环的表现都是「加载更早」转圈不动、
      // 或首屏历史永远停在 loading（超时同样会被这个早退吃掉）。
      if (waiter) {
        waiter(payload)
        return
      }
    }
    // 每个页面都要的簿记放在这里，页面保持「哑」
    if (payload.t === 'ev.session_changed') {
      this.sessions = payload.sessions || []
      // 列表到了，上面那句就该退休。原来它一直挂着不动 —— DESIGN-REVIEW.md
      // 早就点过名（「永远停在『已连接，正在恢复会话』，这就是静默坏掉」）。
      // 何况协议里根本没有取历史的帧，写"恢复会话"会让人以为历史会回来，
      // 然后点进会话看到空白，只能判断成"坏了"。
      if (this.statusText === '已连接，正在同步会话列表') {
        this._setStatus('online', '已连接到主机')
      }
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

  /**
   * 读一页主机上已有的历史。
   *
   * 分页游标**由主机给**：返回的 `nextBeforeSeq` 原样回传进下一次调用即可拿更早的一页；
   * 它不在就表示到最早了。页面不要自己按条数推算——一条原始内核事件可能被折叠成
   * 0/1/2 条这里看到的条目，按条数翻页迟早会跳过或重发一段。
   *
   * @returns Promise<page|null>。`null` = 没拿到（未配对 / 发送失败 / 超时 / 断线），
   *          页面据此显示"读不到"并允许重试，而不是显示成"这个会话没内容"。
   */
  loadHistory(sessionId, opts) {
    opts = opts || {}
    var self = this
    if (!this.isPaired() || !this.sock) return Promise.resolve(null)
    var cmdId = this.newCmdId()
    return new Promise(function (resolve) {
      var timer = null
      // 结算点只有一个：删掉登记因此是幂等的，超时与回帧谁先到都只生效一次
      var done = function (payload) {
        if (!self._cmdWaiters[cmdId]) return
        delete self._cmdWaiters[cmdId]
        if (timer) clearTimeout(timer)
        // 断线/解配时 `_settleWaiters(null)` 会喂进一个 null，那也是"没拿到"
        resolve(payload && payload.t === 'ev.session_history' ? payload : null)
      }
      timer = setTimeout(function () {
        done(null)
      }, HISTORY_TIMEOUT_MS)
      self._cmdWaiters[cmdId] = done

      var cmd = { t: 'cmd.session_history', cmdId: cmdId, sessionId: sessionId }
      if (opts.beforeSeq !== undefined && opts.beforeSeq !== null) cmd.beforeSeq = opts.beforeSeq
      if (opts.limit) cmd.limit = opts.limit
      if (!self.sendCmd(cmd)) done(null)
    })
  }

  /**
   * 让主机新建一条会话，返回主机分配的 id。
   *
   * 与 `loadHistory` 同一套回执机制：按 `cmdId` 登记 waiter，回帧（这里是 `ev.result`）
   * 或超时只结算一次，断线时由 `_settleWaiters` 就地结算 —— 三个出口都要有结果，
   * 否则页面会永远停在"正在新建…"。
   *
   * @returns Promise<{ok: boolean, sessionId?: string, message?: string}>。
   *          `ok:false` 一定带可读原因：主机那一代没有这个能力、创建失败、超时、断线，
   *          四种都要能说出来，"新建没反应"是最难查的那种表现。
   */
  newSession() {
    var self = this
    if (!this.isPaired() || !this.sock) {
      return Promise.resolve({ ok: false, message: '还没有连上主机' })
    }
    var cmdId = this.newCmdId()
    return new Promise(function (resolve) {
      var timer = null
      var done = function (payload) {
        if (!self._cmdWaiters[cmdId]) return
        delete self._cmdWaiters[cmdId]
        if (timer) clearTimeout(timer)
        if (payload && payload.t === 'ev.result') {
          var data = payload.data || {}
          var id = typeof data.sessionId === 'string' ? data.sessionId : ''
          if (payload.ok && id) resolve({ ok: true, sessionId: id })
          else resolve({ ok: false, message: payload.message || '新建会话失败' })
          return
        }
        // 超时 / 断线：两种都不该说成"失败了"就完事，得让人知道是哪种
        resolve({ ok: false, message: '主机没有回应（超时或已断开）' })
      }
      timer = setTimeout(function () {
        done(null)
      }, COMMAND_TIMEOUT_MS)
      self._cmdWaiters[cmdId] = done
      if (!self.sendCmd({ t: 'cmd.new_session', cmdId: cmdId })) done(null)
    })
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
