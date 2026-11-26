'use strict';

const { validateCommand, MAX_TEXT, MAX_ATTACHMENTS } = require('../protocol/wire.cjs');

const readable = new Set(['ev.message_delta', 'ev.tool_event', 'ev.todo']);
const interaction = (kind) => kind === 'permission' ? 'permission' : 'question';
const keyOf = (sessionId, requestId, kind) => JSON.stringify([sessionId, requestId, kind]);

function createRuntime({ kernel, send, broadcast, summarize, now = Date.now, awake, pendingChanged = () => {} }) {
  const receipts = new Map();
  const pending = new Map();
  const sessionPermissions = new Map();
  const history = new Map();
  const activities = new Map();
  const running = new Set();
  let disposed = false;

  function limits() {
    return {
      maxTextChars: MAX_TEXT,
      maxImageAttachments: typeof kernel.sendPrompt === 'function' ? MAX_ATTACHMENTS : 0,
      maxFileAttachments: typeof kernel.sendPrompt === 'function' ? MAX_ATTACHMENTS : 0,
      ...kernel.limits,
    };
  }

  function greet(id) {
    send(id, { t: 'ev.host_info', limits: limits(), pluginVersion: '0.6.0' });
  }

  async function list() {
    const rooms = await (kernel.listSessions?.() ?? []);
    const busy = new Map();
    for (const { card } of pending.values()) {
      const state = card.t === 'ev.permission_request' ? 'awaiting-permission' : 'awaiting-answer';
      if (!busy.has(card.sessionId) || state === 'awaiting-permission') busy.set(card.sessionId, state);
    }
    const sessions = rooms.filter((row) => row.origin !== 'subagent').slice(0, 500).map((row) => {
      const updated = Math.max(activities.get(row.id) || 0, Date.parse(row.updatedAt || '') || 0, Date.parse(row.createdAt || '') || 0);
      return { id: row.id, title: row.title, workspace: row.workspace, createdAt: row.createdAt,
        updatedAt: updated ? new Date(updated).toISOString() : undefined,
        state: row.state === 'archived' ? 'archived' : busy.get(row.id) || row.state || 'idle' };
    });
    return { t: 'ev.session_changed', sessions };
  }

  function updateDigest() {
    summarize({ at: now(), running: running.size > 0, pending: pending.size });
  }

  function emit(evt) {
    if (disposed || typeof evt?.t !== 'string' || !evt.t.startsWith('ev.')) return;
    if (evt.sessionId) {
      activities.set(evt.sessionId, now());
      if (activities.size > 1000) activities.delete(activities.keys().next().value);
    }
    if (evt.sessionId && readable.has(evt.t)) {
      let journal = history.get(evt.sessionId);
      if (!journal) {
        if (history.size >= 200) history.delete(history.keys().next().value);
        journal = { sequence: 0, rows: [] };
        history.set(evt.sessionId, journal);
      }
      journal.rows.push({ seq: ++journal.sequence, value: evt });
      if (journal.rows.length > 500) journal.rows.shift();
    }
    if (evt.t === 'ev.run_state' && evt.sessionId) {
      if (evt.state === 'running') running.add(evt.sessionId);
      else running.delete(evt.sessionId);
      awake?.activity(running.size > 0);
      updateDigest();
    }
    broadcast(evt);
  }

  function localHistory(id, { beforeSeq, since, limit = 60 }) {
    const entry = history.get(id) || { sequence: 0, rows: [] };
    if (since !== undefined && (since > entry.sequence || since + 1 < (entry.rows[0]?.seq ?? 0))) {
      return { error: 'history_window_exceeded' };
    }
    if (since !== undefined) {
      const delta = entry.rows.filter((x) => x.seq > since);
      if (delta.length > limit) return { error: 'history_window_exceeded' };
      return { latestSeq: entry.sequence, items: delta.map((x) => x.value) };
    }
    const available = beforeSeq === undefined ? entry.rows : entry.rows.filter((x) => x.seq < beforeSeq);
    const rows = available.slice(-limit);
    return {
      latestSeq: entry.sequence, nextBeforeSeq: available.length > rows.length ? rows[0].seq : undefined,
      items: rows.map((x) => x.value),
    };
  }

  function settle(row, answer, by) {
    if (!pending.delete(row.key)) return false;
    clearTimeout(row.timeout);
    row.signal?.removeEventListener('abort', row.abort);
    row.resolve(answer);
    broadcast({ t: 'ev.' + row.kind + '_resolved', sessionId: row.card.sessionId,
      requestId: row.card.requestId, by });
    pendingChanged();
    updateDigest();
    return true;
  }

  function requestDecision(request) {
    if (disposed || pending.size >= 256 || request.signal?.aborted) return Promise.resolve(null);
    const { sessionId, requestId, expiresAt } = request;
    const kind = interaction(request.kind);
    if (kind === 'permission' && request.action && sessionPermissions.get(sessionId)?.has(request.action)) {
      return Promise.resolve('approve-session');
    }
    const key = keyOf(sessionId, requestId, kind);
    if (pending.has(key)) return pending.get(key).promise;
    const expires = Date.parse(expiresAt || '');
    if (Number.isFinite(expires) && expires <= now()) return Promise.resolve(null);
    const fields = kind === 'permission'
      ? { action: request.action, reason: request.reason, resource: request.resource, options: request.options }
      : { questions: request.questions };
    const card = { t: 'ev.' + kind + '_request', sessionId, requestId, ...fields,
      ...(Number.isFinite(expires) ? { expiresAt } : {}) };
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const row = { card, kind, key, resolve, promise, signal: request.signal, opened: now() };
    row.abort = () => settle(row, null, 'cancelled');
    if (Number.isFinite(expires)) {
      row.timeout = setTimeout(row.abort, Math.min(expires - now(), 2147483647));
      row.timeout.unref?.();
    }
    pending.set(key, row);
    row.signal?.addEventListener('abort', row.abort, { once: true });
    broadcast(card);
    pendingChanged();
    updateDigest();
    return promise;
  }

  function resolveDesktop(sessionId, requestId, kind) {
    const row = pending.get(keyOf(sessionId, requestId, kind));
    return row ? settle(row, null, 'desktop') : false;
  }

  const unavailable = (name) => new Error('当前宿主未提供' + name + '能力');

  async function execute(cmd) {
    const { t, sessionId, cmdId } = cmd;
    switch (t) {
      case 'cmd.list_sessions':
        return { events: [await list()] };
      case 'cmd.get_pending':
        return { events: [...pending.values()].map(({ card }) => card).filter((card) => !sessionId || card.sessionId === sessionId) };
      case 'cmd.send_prompt': {
        if (!kernel.sendPrompt) throw unavailable('发送指令');
        const cap = limits();
        if (cmd.text.length > cap.maxTextChars) throw new Error('这台电脑最多接收 ' + cap.maxTextChars + ' 个字符');
        const images = cmd.images || [];
        const files = cmd.files || [];
        if (images.length > cap.maxImageAttachments || files.length > cap.maxFileAttachments) throw new Error('附件超过宿主能力');
        await kernel.sendPrompt(sessionId, cmd.text, { images, files });
        return {};
      }
      case 'cmd.new_session': {
        if (!kernel.newSession) throw unavailable('新建会话');
        const id = await kernel.newSession(cmd.workspace);
        if (typeof id !== 'string' || !id) throw new Error('没有收到新会话编号');
        broadcast(await list());
        return { data: { sessionId: id } };
      }
      case 'cmd.interrupt':
        if (!kernel.interrupt) throw unavailable('中断');
        await kernel.interrupt(sessionId);
        return {};
      case 'cmd.archive_session':
        if (!kernel.archiveSession) throw unavailable('归档');
        await kernel.archiveSession(sessionId, cmd.archived !== false);
        broadcast(await list());
        return {};
      case 'cmd.session_history': {
        const cursor = { beforeSeq: cmd.beforeSeq, since: cmd.since, limit: cmd.limit };
        const page = kernel.history ? await kernel.history(sessionId, cursor) : localHistory(sessionId, cursor);
        if (page.error) return { error: page.error };
        const items = [];
        let budget = 425000;
        for (let index = (page.items || []).length - 1; index >= 0; index -= 1) {
          const item = page.items[index];
          const cost = Buffer.byteLength(JSON.stringify(item));
          if (cost > budget) return { error: cmd.since === undefined ? 'history_page_too_large' : 'history_window_exceeded' };
          budget -= cost;
          items.unshift(item);
        }
        return { events: [{ t: 'ev.session_history', sessionId, cmdId, items,
          nextBeforeSeq: page.nextBeforeSeq, latestSeq: page.latestSeq }] };
      }
      case 'cmd.resolve_permission': {
        const row = pending.get(keyOf(sessionId, cmd.requestId, 'permission'));
        if (!row) throw new Error('这张审批已结束');
        const choices = row.card.options || [{ id: 'approve' }, { id: 'reject' }];
        if (!choices.some((choice) => choice.id === cmd.decision)) throw new Error('审批选项无效');
        if (cmd.decision === 'approve-session' && row.card.action) {
          if (!sessionPermissions.has(sessionId)) {
            if (sessionPermissions.size >= 200) sessionPermissions.delete(sessionPermissions.keys().next().value);
            sessionPermissions.set(sessionId, new Set());
          }
          const allowed = sessionPermissions.get(sessionId);
          if (allowed.size >= 100) allowed.delete(allowed.values().next().value);
          allowed.add(row.card.action);
        }
        settle(row, cmd.decision, 'cancelled');
        return {};
      }
      case 'cmd.answer': {
        const row = pending.get(keyOf(sessionId, cmd.requestId, 'question'));
        if (!row) throw new Error('这张提问已结束');
        for (const answer of cmd.answers) {
          const question = row.card.questions.find((item) => item.id === answer.questionId);
          if (!question || (!question.multi && answer.selected.length > 1)
            || answer.selected.some((choice) => !question.options?.some((option) => option.id === choice))) {
            throw new Error('回答选项无效');
          }
        }
        settle(row, cmd.answers, 'cancelled');
        return {};
      }
      case 'cmd.keep_awake':
        if (!awake) throw unavailable('防休眠');
        return { events: [{ t: 'ev.keep_awake_state', ...await awake.configure(cmd.enabled, cmd.idleReleaseSec) }] };
      default:
        throw new Error('Unsupported command');
    }
  }

  async function handle(cmd, channel) {
    if (disposed || !validateCommand(cmd)) {
      if (typeof cmd?.cmdId === 'string') send(channel, { t: 'ev.result', cmdId: cmd.cmdId, ok: false, message: '指令格式无效' });
      return;
    }
    const id = JSON.stringify([channel, cmd.cmdId]);
    const existing = receipts.get(id);
    if (existing && existing.type !== cmd.t) {
      send(channel, { t: 'ev.result', cmdId: cmd.cmdId, ok: false, message: '指令编号已被使用' });
      return;
    }
    if (!existing) {
      for (const [key, value] of receipts) {
        if (value.done && now() - value.done >= 300000) receipts.delete(key);
      }
      if (receipts.size >= 1024) {
        const old = [...receipts].find(([, value]) => value.done);
        if (old) receipts.delete(old[0]);
        else return send(channel, { t: 'ev.result', cmdId: cmd.cmdId, ok: false, message: '电脑正在处理过多指令' });
      }
    }
    const entry = existing || { type: cmd.t, done: 0 };
    if (!existing) {
      entry.result = Promise.resolve().then(() => execute(cmd)).catch((error) => ({ error: error.message || '电脑无法执行指令' }))
        .finally(() => { entry.done = now() || 1; });
      receipts.set(id, entry);
    }
    const outcome = await entry.result;
    if (disposed) return;
    for (const event of outcome.events || []) send(channel, event);
    send(channel, { t: 'ev.result', cmdId: cmd.cmdId, ok: !outcome.error, message: outcome.error, data: outcome.data });
  }

  const unsubscribe = kernel.subscribe?.(emit);
  return {
    emit, requestDecision, resolveDesktop, greet, handle,
    waiting: () => [...pending.values()].map(({ card, kind, opened }) => ({
      requestId: card.requestId, sessionId: card.sessionId, kind: kind === 'permission' ? 'approval' : 'question', opened,
    })),
    dispose() {
      disposed = true;
      unsubscribe?.();
      for (const row of pending.values()) settle(row, null, 'cancelled');
      awake?.dispose();
    },
  };
}

module.exports = { createRuntime };
