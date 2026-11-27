'use strict';

const { randomUUID, randomBytes } = require('node:crypto');
const { mkdir, writeFile, rm } = require('node:fs/promises');
const { basename, join, isAbsolute, win32 } = require('node:path');

function service(ctx, name) {
  try { return ctx.get?.(name, true) || ctx[name]; } catch { return undefined; }
}

const iso = (value) => {
  if (value === null || value === undefined || !Number.isFinite(new Date(value).getTime())) return undefined;
  return new Date(value).toISOString();
};

function contentOf(data) {
  const message = data.message || data;
  return Array.isArray(message.content)
    ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    : String(message.text || data.delta || '');
}

function preview(value, limit) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return undefined;
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function argumentsPreview(value) {
  if (typeof value === 'string') {
    try { return preview(JSON.parse(value), 800); } catch {}
  }
  return preview(value, 800);
}

function wireEvents(sessionId, event) {
  if (!event?.type) return [];
  const data = event.data || {};
  const msg = data.message || data;
  const messageId = String(msg.id || data.messageId || 'log-' + event.seq);
  const emit = (t, fields) => [{ t: 'ev.' + t, sessionId, ...fields }];
  switch (event.type) {
    case 'turn/start': return emit('run_state', { state: 'running' });
    case 'turn/end': return emit('run_state', { state: 'idle', detail: data.error?.message || data.reason?.kind });
    case 'user/message':
      if (msg.source?.kind !== 'user') return [];
      return emit('message_delta', { messageId, role: 'user', delta: contentOf(data), done: true });
    case 'assistant/message': {
      const delta = contentOf(data).replace(/<(?:[a-zA-Z0-9_-]+:)?(?:tool_call|function_calls)\b[^>]*>[\s\S]*?<\/(?:[a-zA-Z0-9_-]+:)?(?:tool_call|function_calls)>/g, '');
      return emit('message_delta', { messageId, role: 'assistant', delta, done: true });
    }
    case 'assistant/delta':
    case 'assistant/message-delta':
      return emit('message_delta', { messageId, role: 'assistant', part: data.part,
        delta: String(data.delta || ''), done: data.done === true });
    case 'tool/call':
    case 'tool/result': {
      const callId = String(data.callId || data.toolCallId || msg.toolCallId || msg.source?.callId || '');
      if (!callId) return [];
      return emit('tool_event', { callId, tool: data.toolName || data.name || msg.toolName,
        phase: event.type === 'tool/call' ? 'started' : data.error || msg.isError ? 'failed' : 'completed',
        title: data.title,
        argsPreview: event.type === 'tool/call' ? argumentsPreview(data.arguments ?? data.args) : undefined,
        resultPreview: event.type === 'tool/result'
          ? preview(data.result ?? data.error?.message ?? data.error ?? contentOf(data), 1200) : undefined });
    }
    case 'request/header':
      if (!data.config?.model) return [];
      return emit('model', { model: data.config.model, provider: data.config.provider });
    case 'todo/write': return Array.isArray(data.todos) ? emit('todo', { todos: data.todos }) : [];
    case 'llm/retry':
      return emit('retry', { attempt: data.retry || 1, max: data.maxRetries, delayMs: data.delayMs, code: data.failure?.code });
    case 'compaction/start': return emit('compaction', { state: 'started' });
    case 'compaction/end': return emit('compaction', { state: data.error ? 'failed' : 'ended', error: data.error?.message });
    default: return [];
  }
}

function mapQuestions(rows) {
  return rows.map((row, index) => ({
    id: String(row.id || 'q' + index), question: String(row.question || row.prompt || row.title || '请选择'),
    multi: row.multi === true || row.multiple === true,
    options: Array.isArray(row.options) ? row.options.map((option, optionIndex) => ({
      id: String(option.id || option.value || 'option-' + optionIndex), label: String(option.label || option.title || option),
    })) : undefined,
  }));
}

async function participate(host, kind, request, next) {
  const id = request?.agent?.session?.id;
  if (!id || !host.status().paired || typeof next !== 'function') return next?.();
  const original = request.signal;
  const controller = new AbortController();
  const requestId = randomUUID();
  try { request.signal = original ? AbortSignal.any([original, controller.signal]) : controller.signal; } catch {}
  const desktop = Promise.resolve().then(() => next()).then(
    (value) => ({ side: 'desktop', yes: value != null && value !== 'unavailable' && value !== 'cancelled', value }),
    (error) => ({ side: 'desktop', yes: false, error }),
  );
  const payload = kind === 'permission'
    ? { action: request.toolName, reason: request.reason, options: [
      { id: 'approve', label: '允许一次' }, { id: 'approve-session', label: '会话内允许' }, { id: 'reject', label: '拒绝' },
    ] }
    : { questions: mapQuestions(request.questions || []) };
  const phone = Promise.resolve(host.requestDecision({
    kind, sessionId: id, requestId, ...payload, signal: original, expiresAt: iso(request.expiresAt),
  })).then((value) => ({ side: 'phone', yes: value != null, value }), () => ({ side: 'phone', yes: false }));
  const stalled = new Promise(() => {});
  try {
    const result = await Promise.race([
      desktop.then((x) => x.yes ? x : stalled),
      phone.then((x) => x.yes ? x : stalled),
      Promise.all([desktop, phone]).then(([x, y]) => y.yes ? y : x),
    ]);
    if (result.side === 'desktop') host.resolveDesktop(id, requestId, kind);
    else controller.abort();
    if (result.error) throw result.error;
    if (kind !== 'permission') {
      if (result.side === 'desktop' || !result.value) return result.value;
      return { answers: result.value.map((answer) => {
        const question = payload.questions.find((item) => item.id === answer.questionId);
        return {
          id: answer.questionId,
          selected: (question?.options || []).filter((option) => answer.selected.includes(option.id)).map((option) => option.label),
          ...(answer.freeText === undefined ? {} : { custom: answer.freeText }),
        };
      }) };
    }
    if (result.side === 'desktop') return result.value ?? 'unavailable';
    return result.value === 'reject' ? 'rejected' : 'allowed-once';
  } finally {
    if (!controller.signal.aborted) controller.abort();
    try { request.signal = original; } catch {}
  }
}

function createKernel(ctx, { newSessionCwd, stateDir, log = () => {} } = {}) {
  const fresh = new Map();
  const lastSeen = new Map();
  let currentDirectory;
  const get = (name) => service(ctx, name);
  const running = (id) => get('agents')?.get?.(id)?.status === 'running';

  async function listSessions() {
    const query = get('sessionQuery');
    let known = [];
    try { known = (await query?.listSessions?.())?.map((row) => row.header || row) || []; }
    catch { log('persistent session list unavailable'); }
    const live = get('sessions')?.list?.() || [];
    const rows = new Map([...fresh, ...[...known, ...live].filter((r) => r?.id).map((r) => [r.id, r])]);
    const headings = new Map();
    const ids = [...rows.keys()].slice(0, 500);
    if (query?.readTitleSnapshots) {
      for (let offset = 0; offset < ids.length; offset += 25) {
        try {
          for (const observation of await query.readTitleSnapshots(ids.slice(offset, offset + 25))) {
            if (observation.status === 'fulfilled') headings.set(observation.sessionId, observation.value?.title);
          }
        } catch { log('session titles unavailable'); }
      }
    }
    const archived = new Set(get('workspaceRegistry')?.archivedSessionIds || []);
    return ids.map((id) => {
      const row = rows.get(id);
      const heading = headings.get(id);
      if (row.cwd) lastSeen.set(id, row.cwd);
      return { id, title: heading?.title || row.title?.title || (typeof row.title === 'string' ? row.title : undefined),
        updatedAt: iso(heading?.updatedAt ?? row.updatedAt ?? row.createdAt),
        createdAt: iso(row.createdAt), workspace: row.cwd, origin: row.origin,
        state: archived.has(id) ? 'archived' : running(id) ? 'running' : 'idle' };
    });
  }

  async function newSession(preferred) {
    const registry = get('workspaceRegistry');
    const commands = get('sessionController')?.commands;
    if (!commands?.create) throw new Error('当前宿主不能新建会话');
    let cwd = preferred || newSessionCwd || currentDirectory;
    if (!cwd) cwd = (await listSessions()).find((row) => row.workspace)?.workspace;
    if (!cwd) cwd = registry?.list?.()?.find((item) => item.path)?.path;
    if (cwd && (/[\x00-\x1F]/.test(cwd) || !(process.platform === 'win32' ? win32.isAbsolute(cwd) : isAbsolute(cwd)))) {
      throw new Error('指定的工作区路径无效');
    }
    const { sessionId } = await commands.create(cwd ? { cwd } : {});
    if (!sessionId) throw new Error('宿主没有返回新会话编号');
    fresh.set(sessionId, { id: sessionId, cwd, createdAt: Date.now() });
    if (fresh.size > 100) fresh.delete(fresh.keys().next().value);
    if (cwd) {
      try { await (await registry?.create?.(cwd))?.attachSession?.(sessionId); }
      catch { log('cannot attach a new session to the workspace'); }
    }
    return sessionId;
  }

  async function sendPrompt(sessionId, text, { images, files }) {
    const commands = get('sessionController')?.commands;
    if (images.length && !commands?.prompt && !get('attachments')?.admitPromptContent) throw new Error('这台电脑不支持图片附件');
    if (images.some((image) => !image.data.startsWith('/9j/'))) throw new Error('图片附件需要是 JPEG');
    const content = text ? [{ type: 'text', text }] : [];
    let folder;
    try {
      if (files.length) {
        if (!stateDir) throw new Error('这台电脑不支持文件附件');
        folder = join(stateDir, 'uploads', randomBytes(10).toString('hex'));
        await mkdir(folder, { mode: 0o700, recursive: true });
        for (const [index, file] of files.entries()) {
          const name = basename(file.name.replace(/\\/g, '/')).replace(/[\x00-\x1F<>:"|?*]/g, '_').replace(/^[. ]+/, '');
          const path = join(folder, (index + 1) + '-' + (name.slice(-90) || 'file'));
          await writeFile(path, Buffer.from(file.data, 'base64'), { mode: 0o600, flag: 'wx' });
          content.push({ type: 'text', text: '用户附件：' + path });
        }
      }
      for (const image of images) content.push({ type: 'image', mediaType: image.mediaType, data: image.data });
      if (commands?.prompt) {
        const requestId = randomUUID();
        await commands.prompt({ requestId, sessionId, mode: 'queue', content }, { kind: 'user', rpcId: requestId });
      } else {
        const agents = get('agents');
        let agent = agents?.get?.(sessionId);
        if (!agent) {
          const model = get('agentDefaultModel')?.currentSelection?.();
          if (!model || !agents?.resume) throw new Error('宿主无法恢复会话或取得默认模型');
          if (get('workspaceRegistry')?.archivedSessionIds?.includes(sessionId)) {
            await get('workspaceRegistry')?.unarchiveSession?.(sessionId);
          }
          agent = (await agents.resume({ resumeSessionId: sessionId, agentOptions: model })).agent || agents.get?.(sessionId);
        }
        const method = agent?.followup || agent?.steer;
        if (!method) throw new Error('当前宿主无法接收指令');
        const admitted = images.length ? await get('attachments').admitPromptContent(content) : content;
        await method.call(agent, { id: randomUUID(), content: admitted, source: { kind: 'user' } });
      }
    } catch (error) {
      if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async function archiveSession(id, archived) {
    const registry = get('workspaceRegistry');
    const method = archived ? registry?.archiveSession : registry?.unarchiveSession;
    if (!method) throw new Error('当前宿主不支持此归档操作');
    if (archived && running(id)) throw new Error('会话正在运行，不能归档');
    try { await method.call(registry, id); }
    catch (error) {
      if (error.name === 'WorkspaceActiveSessionError' || /active session/i.test(error.message)) {
        throw new Error('会话正在运行，不能归档');
      }
      throw error;
    }
  }

  async function history(id, { beforeSeq, since, limit = 60 }) {
    const query = get('sessionQuery');
    if (!query?.readSession) throw new Error('当前宿主无法读取已保存的历史');
    const result = await query.readSession(id);
    if (!Array.isArray(result?.events)) throw new Error('宿主返回了无效的历史数据');
    const raw = result.events.filter((event) => Number.isSafeInteger(event.seq)).sort((a, b) => a.seq - b.seq);
    const latestSeq = raw.at(-1)?.seq || 0;
    if (since !== undefined && (since > latestSeq || (since > 0 && since + 1 < (raw[0]?.seq || 0)))) {
      return { error: 'history_window_exceeded' };
    }
    const entries = raw.filter((event) => (since === undefined || event.seq > since)
      && (beforeSeq === undefined || event.seq < beforeSeq)).map((event) => ({
      seq: event.seq, events: wireEvents(id, event).filter((x) => ['ev.message_delta', 'ev.tool_event', 'ev.todo'].includes(x.t)),
    })).filter((entry) => entry.events.length);
    if (since !== undefined && entries.length > limit) return { error: 'history_window_exceeded' };
    const visible = entries.slice(-limit);
    return { latestSeq, nextBeforeSeq: entries.length > visible.length ? visible[0].seq : undefined,
      items: visible.flatMap((entry) => entry.events) };
  }

  function subscribe(consumer) {
    const offs = [];
    function on(name, fn) {
      try {
        const off = ctx.on?.(name, (...args) => {
          try { fn(...args); } catch { log('invalid host event'); }
        });
        if (typeof off === 'function') offs.push(off);
      } catch { log('host event unavailable: ' + name); }
    }
    on('session/event', (session, event) => {
      if (!session?.id) return;
      currentDirectory = session.cwd || lastSeen.get(session.id) || currentDirectory;
      for (const mapped of wireEvents(session.id, event)) consumer(mapped);
    });
    on('session/created', () => {
      void listSessions().then((sessions) => consumer({ t: 'ev.session_changed', sessions })).catch(() => {});
    });
    on('agent/status', ({ agent, status }) => {
      if (agent?.session?.id) consumer({ t: 'ev.run_state', sessionId: agent.session.id,
        state: status === 'running' ? 'running' : 'idle' });
    });
    return () => { for (const off of offs) off(); };
  }

  const kernel = { listSessions, newSession, sendPrompt, archiveSession, history, subscribe,
    async interrupt(id) {
      const agent = get('agents')?.get?.(id);
      if (!agent?.cancel) throw new Error('这条会话没有可以中断的任务');
      await agent.cancel({ kind: 'user' }, { keepInbox: true });
    },
  };
  Object.defineProperty(kernel, 'limits', { get: () => ({
    maxTextChars: 20000,
    maxImageAttachments: get('sessionController')?.commands?.prompt || get('attachments')?.admitPromptContent ? 4 : 0,
    maxFileAttachments: stateDir ? 4 : 0,
  }) });
  return kernel;
}

module.exports = { service, createKernel, wireEvents, participate };
