'use strict'

var client = require('../../core/client.js')

/**
 * 手机上的窗口管理。两个独立的问题，两个独立的解法：
 *  - 长会话里 transcript 不能无限增长（内存）；
 *  - 每条流式 delta 一次 setData 会让界面卡顿，所以 delta 先合并、按帧刷出。
 */
var MAX_MESSAGES = 300
var MAX_TEXT_PER_MESSAGE = 20000
var DELTA_FLUSH_MS = 100
var DELTA_FLUSH_CHARS = 4096

var TOOL_ICON = {
  started: '▶',
  args: '·',
  completed: '✓',
  failed: '✕',
}

Page({
  data: {
    sessionId: '',
    title: '',
    messages: [],
    inputText: '',
    running: false,
    pendingPermission: null,
    pendingQuestion: null,
    toView: '',
    statusText: '',
  },

  onLoad: function (options) {
    this.client = client.getClient()
    var id = decodeURIComponent(options.id || '')
    var title = decodeURIComponent(options.title || id)
    this.setData({ sessionId: id, title: title })
    wx.setNavigationBarTitle({ title: title.length > 16 ? title.slice(0, 16) + '…' : title })
    this._msgIndex = {}
    this._toolIndex = {}
    this._counter = 0
    this._deltaBuf = {}
    this._deltaTimer = null
  },

  onShow: function () {
    this._off = this.client.on(this._onEvent.bind(this))
    this.setData({ statusText: this.client.statusText })
    this.client.listSessions()
  },

  onHide: function () {
    if (this._deltaTimer) {
      clearTimeout(this._deltaTimer)
      this._deltaTimer = null
    }
    this._flushDelta()
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

  // ── 入站事件 ──────────────────────────────────────────────────────
  _onEvent: function (evt) {
    if (evt.kind === 'status') {
      this.setData({ statusText: evt.text })
      return
    }
    if (evt.kind === 'error') {
      wx.showToast({ title: String(evt.message || '').slice(0, 40), icon: 'none' })
      return
    }
    if (evt.kind !== 'payload') return
    var p = evt.payload
    if (p.sessionId && p.sessionId !== this.data.sessionId) return // 不是本会话

    if (p.t === 'ev.message_delta') return this._queueDelta(p)
    if (p.t === 'ev.tool_event') return this._onTool(p)
    if (p.t === 'ev.permission_request') return this._onPermission(p)
    if (p.t === 'ev.question_request') return this._onQuestion(p)
    if (p.t === 'ev.run_state') return this._onRunState(p)
    if (p.t === 'ev.result') {
      if (!p.ok && p.message) wx.showToast({ title: String(p.message).slice(0, 40), icon: 'none' })
      return
    }
  },

  // ── 流式 delta：先合并，按帧刷 ────────────────────────────────────
  _queueDelta: function (p) {
    var buf = this._deltaBuf
    var e = buf[p.messageId]
    if (!e) {
      e = buf[p.messageId] = { text: '', done: false }
      if (!this._deltaTimer) {
        var self = this
        this._deltaTimer = setTimeout(function () {
          self._deltaTimer = null
          self._flushDelta()
        }, DELTA_FLUSH_MS)
      }
    }
    e.text += p.delta || ''
    e.done = e.done || !!p.done
    if (e.text.length >= DELTA_FLUSH_CHARS || p.done) this._flushDelta()
  },

  _flushDelta: function () {
    var buf = this._deltaBuf
    if (!buf) return
    for (var id in buf) {
      if (!Object.prototype.hasOwnProperty.call(buf, id)) continue
      var e = buf[id]
      if (!e.text && !e.done) continue
      this._applyDelta(id, e.text, e.done)
      delete buf[id]
    }
  },

  _applyDelta: function (messageId, text, done) {
    var msgs = this.data.messages.slice()
    var idx = this._msgIndex[messageId]
    if (idx === undefined || idx >= msgs.length) {
      // 新消息，或 transcript 被裁剪后旧消息又来 delta：追加在末尾
      idx = msgs.length
      this._msgIndex[messageId] = idx
      msgs.push({ key: 'm' + this._counter++, kind: 'assistant', text: text, done: done })
    } else {
      var next = msgs[idx].text + text
      if (next.length > MAX_TEXT_PER_MESSAGE) next = '…' + next.slice(next.length - MAX_TEXT_PER_MESSAGE)
      msgs[idx] = { key: msgs[idx].key, kind: 'assistant', text: next, done: done || msgs[idx].done }
    }
    if (done) this.setData({ running: false })
    this._commit(msgs)
  },

  // ── 工具事件：按 callId 原地更新一行 ──────────────────────────────
  _onTool: function (p) {
    var msgs = this.data.messages.slice()
    var text = (TOOL_ICON[p.phase] || '·') + ' ' + (p.tool || 'tool') + (p.title ? ' — ' + p.title : '')
    if ((p.phase === 'completed' || p.phase === 'failed') && p.resultPreview) {
      text += ' → ' + p.resultPreview
    }
    var idx = this._toolIndex[p.callId]
    if (idx === undefined || idx >= msgs.length) {
      idx = msgs.length
      this._toolIndex[p.callId] = idx
      msgs.push({ key: 't' + this._counter++, kind: 'tool', text: text })
    } else {
      msgs[idx] = { key: msgs[idx].key, kind: 'tool', text: text }
    }
    this._commit(msgs)
  },

  // ── 审批 / 提问 ───────────────────────────────────────────────────
  _onPermission: function (p) {
    this.setData({
      pendingPermission: {
        requestId: p.requestId,
        action: p.action || '操作',
        resource: p.resource || '',
        reason: p.reason || '',
        options:
          p.options && p.options.length
            ? p.options
            : [
                { id: 'approve', label: '允许' },
                { id: 'reject', label: '拒绝' },
              ],
      },
      running: false,
    })
    if (wx.vibrateLong) wx.vibrateLong()
  },

  _onQuestion: function (p) {
    var qs = (p.questions || []).map(function (q) {
      return {
        id: q.id,
        question: q.question,
        multi: !!q.multi,
        options: (q.options || []).map(function (o) {
          return { id: o.id, label: o.label, checked: false }
        }),
      }
    })
    this.setData({ pendingQuestion: { requestId: p.requestId, questions: qs, freeText: '' }, running: false })
    if (wx.vibrateLong) wx.vibrateLong()
  },

  _onRunState: function (p) {
    this.setData({ running: p.state === 'running' })
    if (p.state === 'running' || p.state === 'idle') {
      // 主机恢复运行/归于空闲：挂着的卡片要么已回答要么已失效
      this.setData({ pendingPermission: null, pendingQuestion: null })
    }
  },

  // ── transcript 提交：从头部裁剪，绝不在消息中间下刀 ──────────────
  _trim: function (msgs) {
    if (msgs.length <= MAX_MESSAGES) return msgs
    var dropped = msgs.length - MAX_MESSAGES
    var kept = msgs.slice(dropped)
    kept.unshift({
      key: 'trim',
      kind: 'tool',
      text: '…已省略较早的 ' + dropped + ' 条消息（仅保留最近 ' + MAX_MESSAGES + ' 条）',
    })
    return kept
  },

  _commit: function (msgs) {
    var self = this
    var trimmed = this._trim(msgs)
    this.setData({ messages: trimmed }, function () {
      if (trimmed.length) self.setData({ toView: trimmed[trimmed.length - 1].key })
    })
  },

  // ── 出站 ──────────────────────────────────────────────────────────
  onInput: function (e) {
    this.setData({ inputText: e.detail.value })
  },

  onSend: function () {
    var text = String(this.data.inputText || '').trim()
    if (!text) return
    if (!this.data.sessionId) return
    var msgs = this.data.messages.slice()
    msgs.push({ key: 'u' + this._counter++, kind: 'user', text: text })
    this.setData({ inputText: '', running: true })
    this._commit(msgs)
    this.client.sendPrompt(this.data.sessionId, text)
  },

  onInterrupt: function () {
    if (!this.data.sessionId) return
    this.client.interrupt(this.data.sessionId)
    wx.showToast({ title: '已发送中断', icon: 'none' })
  },

  onPermissionTap: function (e) {
    var decision = e.currentTarget.dataset.decision
    var perm = this.data.pendingPermission
    if (!perm) return
    this.setData({ pendingPermission: null, running: decision !== 'reject' })
    this.client.resolvePermission(this.data.sessionId, perm.requestId, decision)
  },

  onOptionTap: function (e) {
    var qi = Number(e.currentTarget.dataset.qi)
    var oi = Number(e.currentTarget.dataset.oi)
    var q = this.data.pendingQuestion
    if (!q) return
    var questions = q.questions.map(function (x, i) {
      if (i !== qi) return x
      var opts = x.options.map(function (o, j) {
        if (x.multi) return j === oi ? { id: o.id, label: o.label, checked: !o.checked } : o
        return { id: o.id, label: o.label, checked: j === oi }
      })
      return { id: x.id, question: x.question, multi: x.multi, options: opts }
    })
    this.setData({ 'pendingQuestion.questions': questions })
  },

  onFreeText: function (e) {
    this.setData({ 'pendingQuestion.freeText': e.detail.value })
  },

  onAnswer: function () {
    var q = this.data.pendingQuestion
    if (!q) return
    var answers = []
    var missing = false
    for (var i = 0; i < q.questions.length; i++) {
      var qq = q.questions[i]
      var selected = []
      for (var j = 0; j < qq.options.length; j++) {
        if (qq.options[j].checked) selected.push(qq.options[j].id)
      }
      if (!selected.length && !q.freeText) missing = true
      answers.push({ questionId: qq.id, selected: selected, freeText: q.freeText || undefined })
    }
    if (missing) {
      wx.showToast({ title: '请先选择一项', icon: 'none' })
      return
    }
    this.setData({ pendingQuestion: null, running: true })
    this.client.answer(this.data.sessionId, q.requestId, answers)
  },
})
