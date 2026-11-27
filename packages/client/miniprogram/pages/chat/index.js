'use strict';

const { createMarkdown } = require('../../core.js');

const markdown = createMarkdown(() => require('../../marked.js'));
const stateCopy = {
  online: '已连接', connecting: '正在连接', offline: '连接已断开', 'host-offline': '电脑离线', unpaired: '配对已失效',
};
const call = (api, args, context) => new Promise((resolve, reject) => api({ ...args, success: resolve, fail: reject }, context));
const toolNames = new Map(Object.entries({
  bash: '执行命令', shell: '执行命令', exec_command: '执行命令',
  read: '读取文件', write: '写入文件', edit: '编辑文件', apply_patch: '修改文件',
  grep: '搜索内容', glob: '查找文件', web_search: '搜索网页', web_fetch: '读取网页',
}));

function toolTitle(row) {
  const name = row.tool || row.title || '';
  const translation = toolNames.get(name.toLowerCase());
  if (row.title && row.title.toLowerCase() !== name.toLowerCase()) return row.title;
  return translation || row.title || row.tool || '工具调用';
}

function mergeTool(previous, next) {
  const finished = ['completed', 'failed'].includes(previous.phase);
  return { ...previous, ...next,
    title: next.title || previous.title, tool: next.tool || previous.tool,
    args: next.args || previous.args, result: next.result || previous.result,
    phase: finished && !['completed', 'failed'].includes(next.phase) ? previous.phase : next.phase || previous.phase,
  };
}

function decode(value) {
  try { return decodeURIComponent(String(value || '')); } catch { return String(value || ''); }
}

function ids(event) {
  if (event.t === 'ev.message_delta' && event.messageId) return 'm-' + event.messageId;
  if (event.t === 'ev.tool_event' && event.callId) return 't-' + event.callId;
  return '';
}

function demoTimeline(id) {
  const base = { sessionId: id, t: 'ev.message_delta', done: true };
  return [
    { ...base, messageId: 'demo-user', role: 'user', delta: '检查配对流程的回归用例，确认坏码不会被自动重复认领。' },
    { t: 'ev.tool_event', sessionId: id, callId: 'demo-tool', phase: 'completed', tool: 'bash',
      argsPreview: 'npm test', resultPreview: '配对回归测试通过。' },
    { ...base, messageId: 'demo-answer', role: 'assistant', delta: '启动场景和重复认领已覆盖。\n\n**验证结果**\n\n- 打开扫码结果时只展示待连接提示\n- 已使用的码在手机端拦截\n- 新码可以继续正常配对' },
  ];
}

Page({
  data: {
    theme: 'light', title: '会话', connection: 'connecting', status: '正在连接', sessionId: '',
    timeline: [], pending: [], todos: [], attachments: [], input: '', textCount: 0, max: 20000,
    imageCap: 4, fileCap: 4, inputHint: '给电脑发送指令', running: false, canWrite: false, demo: false,
    drawingWidth: 1, drawingHeight: 1, scrollTarget: '', loading: false, older: false, historyError: '', keyboardHeight: 0,
  },

  onLoad(options = {}) {
    this.app = getApp();
    this.client = this.app.client;
    this.transcript = new Map();
    this.expandedTools = new Set();
    this.answers = new Map();
    this.nextPage = undefined;
    this.follow = true;
    this.id = decode(options.id);
    this.isDemo = options.demo === '1' && this.id.startsWith('demo-');
    const draft = this.isDemo ? '' : this.app.storage.read('drc.v06.draft.' + this.id) || '';
    this.setData({ sessionId: this.id, title: decode(options.title) || '会话', demo: this.isDemo, input: draft, textCount: draft.length });
    if (this.isDemo) {
      for (const event of demoTimeline(this.id)) this.accept(event);
      if (this.id === 'demo-consent') this.setData({ pending: [{
        requestId: 'demo-card', permission: true, action: '读取脚本测试结果',
        options: [{ id: 'reject', label: '拒绝' }, { id: 'approve', label: '允许一次' }],
      }] });
      this.renderTimeline();
    }
  },

  onShow() {
    this.app.applyTheme();
    this.off?.();
    if (!this.isDemo) this.off = this.client.subscribe((event) => this.onEvent(event));
    this.sync();
    if (!this.isDemo && this.client.snapshot().state === 'online') this.syncHistory(this.initialized);
  },
  onHide() { this.off?.(); this.off = null; },
  onUnload() {
    this.removed = true;
    this.onHide();
    clearTimeout(this.drawTimer);
  },

  sync() {
    const view = this.client.snapshot();
    const oldConnection = this.data.connection;
    const connection = this.isDemo ? 'online' : view.state;
    const canWrite = !this.isDemo && connection === 'online' && !!this.id;
    const info = view.sessions.find((row) => row.id === this.id);
    const cards = view.pending.filter((event) => event.sessionId === this.id).map((card) => ({
      ...card, permission: card.t === 'ev.permission_request',
      options: card.options || [{ id: 'reject', label: '拒绝' }, { id: 'approve', label: '允许一次' }],
      expiry: card.expiresAt && new Date(card.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    }));
    this.setData({
      theme: this.app.settings.theme, connection, canWrite, title: info?.title || this.data.title,
      status: this.isDemo ? '演示' : stateCopy[connection] || '正在连接',
      ...(this.isDemo ? {} : { pending: cards }),
      max: view.limits?.maxTextChars ?? 20000, imageCap: view.limits?.maxImageAttachments ?? 4,
      fileCap: view.limits?.maxFileAttachments ?? 4,
      inputHint: canWrite ? '给电脑发送指令' : this.isDemo ? '演示会话' : '电脑上线后可以发送',
    });
    if (canWrite && oldConnection !== 'online') this.syncHistory(this.initialized);
  },

  onEvent(event) {
    if (event.t === 'state') { this.sync(); return; }
    if (event.t === 'resume-gap') {
      this.gap = true;
      this.syncHistory(true);
      return;
    }
    if (event.sessionId !== this.id) return;
    this.accept(event);
  },

  accept(event, model = this.transcript) {
    const id = ids(event);
    if (id) {
      const row = model.get(id) || { id, type: id[0] === 'm' ? 'message' : 'tool', text: '', parts: new Set() };
      if (event.t === 'ev.message_delta') {
        if (Number.isSafeInteger(event.part)) {
          if (row.parts.has(event.part)) return;
          row.parts.add(event.part);
        }
        row.role = event.role || row.role || 'assistant';
        row.text += event.delta || '';
        row.done = event.done === true;
        model.set(id, row);
      } else model.set(id, mergeTool(row, { title: event.title, tool: event.tool, phase: event.phase,
        args: event.argsPreview, result: event.resultPreview }));
      if (model === this.transcript) this.queueRender();
    }
    if (event.t === 'ev.run_state') this.setData({ running: event.state !== 'idle', runDetail: event.detail || '' });
    if (event.t === 'ev.model') this.setData({ model: event.model });
    if (event.t === 'ev.todo' && Array.isArray(event.todos)) this.setData({ todos: event.todos });
    if (event.t === 'ev.retry') this.setData({ runDetail: '正在重试，第 ' + event.attempt + ' 次' });
    if (event.t === 'ev.compaction') this.setData({ runDetail: event.state === 'started' ? '正在整理上下文' : event.error || '' });
  },

  queueRender() {
    if (!this.drawTimer) this.drawTimer = setTimeout(() => {
      this.drawTimer = null;
      if (!this.removed) this.renderTimeline(this.follow);
    }, 40);
  },

  renderTimeline(follow = false) {
    const timeline = [...this.transcript.values()].slice(-350).filter((row) => row.type !== 'message' || row.text)
      .map((row, index) => ({
        id: row.id, target: 'line-' + index, type: row.type, role: row.role,
        label: row.role === 'user' ? '我的指令' : row.role === 'system' ? '系统' : '电脑回复',
        nodes: row.type === 'message' ? markdown(row.text) : null,
        title: row.type === 'tool' ? toolTitle(row) : '',
        expanded: this.expandedTools.has(row.id),
        args: row.args || '', result: row.result || '',
        phase: row.phase === 'completed' ? '已完成' : row.phase === 'failed' ? '失败' : '进行中',
      }));
    this.setData({ timeline, ...(follow && timeline.length ? { scrollTarget: timeline[timeline.length - 1].target } : {}) });
  },

  async syncHistory(reconnect = false, earlier = false) {
    if (this.removed || this.isDemo || !this.id || this.loading || this.client.snapshot().state !== 'online') return;
    if (earlier && this.nextPage === undefined) return;
    this.loading = true;
    this.setData({ loading: true, historyError: '' });
    try {
      const since = reconnect ? this.client.historyCursor(this.id) : undefined;
      const cursor = earlier ? { beforeSeq: this.nextPage, limit: 35 } : since !== undefined ? { since, limit: 60 } : { limit: 35 };
      const page = await this.client.history(this.id, cursor);
      if (this.removed) return;
      const additions = new Map();
      for (const item of page.items) this.accept(item, additions);
      if (earlier || since === undefined) {
        for (const [id, row] of this.transcript) {
          const historical = additions.get(id);
          if (historical && row.type === 'tool') additions.set(id, mergeTool(historical, row));
          else if (!historical || row.text.length > historical.text.length) additions.set(id, row);
        }
        this.transcript = additions;
      } else {
        for (const [id, row] of additions) {
          const current = this.transcript.get(id);
          if (current && row.type === 'tool') this.transcript.set(id, mergeTool(current, row));
          else if (!current || row.text.length >= current.text.length) this.transcript.set(id, row);
        }
      }
      if (earlier || since === undefined) this.nextPage = page.nextBeforeSeq;
      this.initialized = true;
      this.gap = false;
      this.setData({ older: this.nextPage !== undefined });
      this.renderTimeline(!earlier && this.follow);
      if (!earlier) void this.client.command('cmd.get_pending', { sessionId: this.id }).catch(() => {});
    } catch (error) {
      if (!this.removed) this.setData({ historyError: error.message });
    } finally {
      this.loading = false;
      if (!this.removed) this.setData({ loading: false });
    }
  },

  onScroll(event) {
    const scroll = event.detail;
    this.follow = scroll.scrollHeight - scroll.scrollTop - (this.viewportHeight || 500) < 110;
  },
  onAtBottom() { this.follow = true; },
  onReady() {
    wx.createSelectorQuery?.().select('.transcript').boundingClientRect((rect) => {
      if (rect) this.viewportHeight = rect.height;
    }).exec();
  },
  onOlder() {
    this.follow = false;
    void this.syncHistory(false, true);
  },
  onHistoryRetry() { void this.syncHistory(this.initialized); },

  onToggleTool(event) {
    const { id } = event.currentTarget.dataset;
    if (this.expandedTools.has(id)) this.expandedTools.delete(id);
    else this.expandedTools.add(id);
    this.follow = false;
    this.renderTimeline();
  },

  onComposerKeyboard(event) {
    const height = event.detail.height;
    if (Number.isFinite(height) && height >= 0) this.setData({ keyboardHeight: height });
  },
  onComposerBlur() { this.setData({ keyboardHeight: 0 }); },

  onInput(event) {
    const input = event.detail.value;
    this.setData({ input, textCount: input.length });
    try { this.app.storage.write('drc.v06.draft.' + this.id, input); } catch {}
  },

  async onSend() {
    if (!this.data.canWrite || this.data.sending || (!this.data.input.trim() && !this.data.attachments.length)) return;
    const text = this.data.input;
    const attach = this.data.attachments;
    this.setData({ sending: true });
    try {
      const args = { sessionId: this.id, text, images: attach.filter((x) => x.image).map((x) => x.record),
        files: attach.filter((x) => !x.image).map((x) => x.record) };
      const reply = await this.client.command('cmd.send_prompt', args);
      if (!reply.ok) throw new Error(reply.message);
      this.setData({ input: '', textCount: 0, attachments: [] });
      try { this.app.storage.remove('drc.v06.draft.' + this.id); } catch {}
    } catch (error) { this.app.toast(error.message || '指令发送失败'); }
    finally { this.setData({ sending: false }); }
  },

  onInterrupt() {
    wx.showModal({
      title: '中断当前任务？', content: '电脑会保留排队的指令。',
      confirmText: '中断', success: (result) => {
        if (result.confirm) void this.request('cmd.interrupt');
      },
    });
  },

  async request(t, fields = {}) {
    try {
      const reply = await this.client.command(t, { sessionId: this.id, ...fields });
      if (!reply.ok) throw new Error(reply.message);
    } catch (error) { this.app.toast(error.message || '电脑未接受这次操作'); }
  },

  onDecision(event) {
    if (!this.data.canWrite) return this.app.toast(this.isDemo ? '演示不会发送审批' : '电脑上线后可以审批');
    const { requestId, decision } = event.currentTarget.dataset;
    void this.request('cmd.resolve_permission', { requestId, decision });
  },

  onChoice(event) {
    const { requestId, questionId } = event.currentTarget.dataset;
    const card = this.data.pending.find((item) => item.requestId === requestId);
    const question = card?.questions.find((x) => x.id === questionId);
    if (!question) return;
    const selected = Array.isArray(event.detail.value) ? event.detail.value : [event.detail.value];
    const draft = this.answers.get(requestId) || {};
    this.answers.set(requestId, { ...draft, [questionId]: { ...draft[questionId], selected } });
  },
  onAnswerText(event) {
    const { requestId, questionId } = event.currentTarget.dataset;
    const draft = this.answers.get(requestId) || {};
    this.answers.set(requestId, { ...draft, [questionId]: { ...draft[questionId], freeText: event.detail.value } });
  },
  onAnswer(event) {
    if (!this.data.canWrite) return;
    const { requestId } = event.currentTarget.dataset;
    const draft = this.answers.get(requestId) || {};
    const answers = Object.entries(draft).map(([questionId, item]) => ({ questionId, selected: [], ...item }))
      .filter((item) => item.selected.length || item.freeText?.trim());
    if (!answers.length) return this.app.toast('选择一个答案或填写文字');
    void this.request('cmd.answer', { requestId, answers });
  },

  onAttach() {
    if (!this.data.canWrite) return;
    const types = [];
    if (this.data.imageCap) types.push('image');
    if (this.data.fileCap) types.push('file');
    if (!types.length) return this.app.toast('这台电脑暂不支持附件');
    wx.showActionSheet({ itemList: types.map((type) => type === 'image' ? '照片' : '文件'),
      success: ({ tapIndex }) => { if (types[tapIndex]) void this.chooseAttachment(types[tapIndex]); },
    });
  },
  async chooseAttachment(type) {
    const image = type === 'image';
    try {
      const cap = image ? this.data.imageCap : this.data.fileCap;
      if (this.data.attachments.filter((x) => x.image === image).length >= cap) throw new Error('已达到附件数量上限');
      const picked = image
        ? await call(wx.chooseMedia, { count: 1, mediaType: ['image'], sourceType: ['album', 'camera'] })
        : await call(wx.chooseMessageFile, { count: 1, type: 'file' });
      const file = picked.tempFiles[0];
      const filePath = image ? await this.jpeg(file.tempFilePath) : file.path;
      const fs = wx.getFileSystemManager();
      const read = await call(fs.readFile.bind(fs), { filePath, encoding: 'base64' });
      const data = read.data;
      const size = (value) => value.length * .75 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
      const sum = this.data.attachments.reduce((n, item) => n + size(item.record.data), 0);
      if (sum + size(data) > 524288) throw new Error('附件总计最多 512 KB，请减少文件或照片');
      const name = image ? '照片-' + (this.data.attachments.length + 1) + '.jpg' : file.name;
      const item = { id: Date.now() + '-' + name, name, image, record: { name, data, ...(image ? { mediaType: 'image/jpeg' } : {}) } };
      this.setData({ attachments: [...this.data.attachments, item] });
    } catch (error) { if (!/cancel/i.test(error.errMsg || '')) this.app.toast(error.message || '无法读取附件'); }
  },
  async jpeg(src) {
    const image = await call(wx.getImageInfo, { src });
    const ratio = Math.min(1, 1280 / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * ratio));
    const height = Math.max(1, Math.round(image.height * ratio));
    await new Promise((resolve) => this.setData({ drawingWidth: width, drawingHeight: height }, resolve));
    const context = wx.createCanvasContext('jpeg');
    context.setFillStyle('#fff');
    context.fillRect(0, 0, width, height);
    context.drawImage(image.path || src, 0, 0, width, height);
    await new Promise((resolve) => context.draw(false, resolve));
    const file = await call(wx.canvasToTempFilePath, { canvasId: 'jpeg', width, height, destWidth: width, destHeight: height,
      fileType: 'jpg', quality: .7 }, this);
    return file.tempFilePath;
  },
  onRemoveAttachment(event) {
    this.setData({ attachments: this.data.attachments.filter((x) => x.id !== event.currentTarget.dataset.id) });
  },
});
