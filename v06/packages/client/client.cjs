'use strict';

const { version } = require('../../package.json');

const { PROTOCOL, MAX_CIPHER, MAX_TEXT, MAX_ATTACHMENTS, CONVERSATION, TOKEN, validateCommand, validDigest } = require('../protocol/wire.cjs');
const { toBase64, fromBase64, deriveKey, keyPair, readGrant, seal, open } = require('../protocol/crypto.cjs');

const PAIRING_KEY = 'drc.v06.pairing';
const INSTALL_KEY = 'drc.v06.install';
const LAST_KEY = 'drc.v06.last-known';
const maxAge = 604800000;
const errorCopy = {
  invalid_or_expired: '配对码已失效，请在电脑上刷新后重扫',
  already_used: '这张配对码已使用，请在电脑上刷新后重扫',
  host_offline: '电脑暂时离线，回来后可以再试',
  bad_token: '这张配对码不能使用，请在电脑上刷新',
  host_unavailable: '电脑离线，任务可能仍在电脑上运行',
  unknown_session: '配对已失效，请重新扫码',
  not_member: '配对已失效，请重新扫码',
  rate_limited: '操作太频繁，请稍后再试',
  unsupported_protocol: '电脑和手机的通信版本不同，请升级后重试',
};

function normalizeUrl(url) {
  const value = typeof url === 'string' ? url.trim() : '';
  if (/^wss:\/\/[A-Za-z0-9.[\]:-]+(?:\/[A-Za-z0-9_./~-]*)?$/.test(value)) return value;
  if (/^ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/[A-Za-z0-9_./~-]*)?$/.test(value)) return value;
  throw new Error('请输入 wss:// 开头的中继地址');
}

function createClient({ socket: openSocket, random, storage, now = Date.now, reconnectDelay = 500, commandTimeout = 10000 }) {
  const listeners = new Set();
  const requests = new Map();
  const pending = new Map();
  const dead = new Map();
  const historySeq = new Map();
  const read = (name) => { try { return storage.read(name); } catch { return null; } };
  const write = (name, value) => { try { storage.write(name, value); return true; } catch { return false; } };
  const forget = (name) => { try { storage.remove(name); } catch {} };
  let clientId = read(INSTALL_KEY);
  if (typeof clientId !== 'string' || clientId.length > 128) clientId = null;
  let identity;
  let channel = read(PAIRING_KEY);
  try {
    if (!channel || !CONVERSATION.test(channel.sessionId) || fromBase64(channel.psk).length !== 16) throw new Error();
    normalizeUrl(channel.url);
    if (!clientId || channel.clientId !== clientId) throw new Error();
  } catch {
    channel = null;
  }
  let url = channel?.url || '';
  let relaySeq = Number.isSafeInteger(channel?.relaySeq) ? Math.max(0, channel.relaySeq) : 0;
  const remembered = read(LAST_KEY);
  const known = channel && remembered?.sessionId === channel.sessionId && now() - remembered.at <= maxAge ? remembered : null;
  let sessions = Array.isArray(known?.sessions) ? known.sessions : [];
  let recordedAt = known?.at || 0;
  let summary = null;
  let limits = null;
  let notify = null;
  let state = channel ? 'offline' : 'unpaired';
  let problem = '';
  let connection;
  let reconnect;
  let delay = reconnectDelay;
  let attempt;
  let offer;
  let revision = 0;
  let lastFlush = 0;
  let flushTimer;
  let abortingLeave;
  let transportReady = false;
  let handshakeTimer;
  let probeTimer;

  function emit(event) {
    for (const listener of listeners) {
      try { listener(event); } catch {}
    }
  }

  function snapshot() {
    return { state, problem, sessions, pending: [...pending.values()], limits, summary, notify, recordedAt, url,
      paired: !!channel, hostId: channel?.hostId, offer: offer ? { id: offer.id, sas: offer.sas } : null };
  }

  function update(next, issue = '') {
    if (next) state = next;
    problem = issue;
    emit({ t: 'state', ...snapshot() });
  }

  function rememberCode(code) {
    if (!code) return;
    dead.delete(code);
    dead.set(code, now());
    while (dead.size > 8) dead.delete(dead.keys().next().value);
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (!channel) return;
    write(PAIRING_KEY, { ...channel, relaySeq, clientId });
    lastFlush = now();
  }

  function scheduleFlush() {
    if (now() - lastFlush >= 250) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, 250);
  }

  function removeChannel() {
    clearTimeout(flushTimer);
    channel = null;
    relaySeq = recordedAt = 0;
    pending.clear();
    historySeq.clear();
    sessions = [];
    limits = null;
    summary = null;
    notify = null;
    forget(PAIRING_KEY);
    forget(LAST_KEY);
  }

  function clearAttempt() {
    clearTimeout(attempt?.timer);
    offer = null;
    attempt = null;
  }

  function currentError(text) {
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(text));
    }
    requests.clear();
  }

  function closeSocket() {
    clearTimeout(handshakeTimer);
    clearTimeout(probeTimer);
    const old = connection;
    connection = undefined;
    transportReady = false;
    old?.transport?.close();
  }

  function send(frame) {
    return connection?.transport?.send(JSON.stringify(frame)) === true;
  }

  async function installation() {
    if (clientId) return;
    if (!identity) {
      identity = Promise.resolve(random(18)).then((bytes) => {
        clientId = 'mp-' + toBase64(bytes).replace(/[+/=]/g, '_');
        write(INSTALL_KEY, clientId);
      }).finally(() => { identity = undefined; });
    }
    await identity;
  }

  function probe() {
    clearTimeout(probeTimer);
    if (!channel || !transportReady || attempt) return;
    const current = connection;
    void command('cmd.list_sessions', {}, { internal: true }).then((reply) => {
      if (connection === current && reply.ok) {
        update('online');
        void command('cmd.get_pending', {}, { internal: true }).catch(() => {});
      }
    }).catch(() => {
      if (connection === current && state === 'host-offline') armProbe();
    });
  }

  function armProbe() {
    if (!probeTimer && connection && channel) {
      probeTimer = setTimeout(() => { probeTimer = undefined; probe(); }, 6000);
    }
  }

  function applyRecord(frame, item) {
    if (!channel || frame.sessionId !== channel.sessionId) return;
    const event = open(deriveKey(channel.psk, 'h2c', channel.sessionId), item.ciphertext);
    if (!event || typeof event.t !== 'string' || !event.t.startsWith('ev.')) return;
    if (Number.isSafeInteger(item.seq)) {
      if (item.seq <= relaySeq) return;
      relaySeq = item.seq;
      scheduleFlush();
    }
    if (event.t === 'ev.host_info' && event.limits && typeof event.limits === 'object') {
      limits = { ...event.limits };
    } else if (event.t === 'ev.session_changed' && Array.isArray(event.sessions)) {
      sessions = event.sessions.filter((row) => row && typeof row.id === 'string').slice(0, 500);
      recordedAt = now();
      write(LAST_KEY, { sessionId: channel.sessionId, at: recordedAt, sessions });
    }
    if (['ev.question_request', 'ev.permission_request', 'ev.question_resolved', 'ev.permission_resolved'].includes(event.t)) {
      const key = JSON.stringify([event.sessionId, event.requestId, event.t.split('_')[0]]);
      if (event.t.endsWith('_request')) pending.set(key, event);
      else pending.delete(key);
    }
    if (event.t === 'ev.session_history') {
      if (Number.isSafeInteger(event.latestSeq)) historySeq.set(event.sessionId, event.latestSeq);
      const listener = requests.get(event.cmdId);
      if (listener) listener.history = event;
    }
    if (event.t === 'ev.result') {
      const listener = requests.get(event.cmdId);
      if (listener) {
        requests.delete(event.cmdId);
        clearTimeout(listener.timer);
        listener.resolve(listener.history ? { ...event, history: listener.history } : event);
      }
    }
    emit(event);
    if (['ev.host_info', 'ev.session_changed'].includes(event.t) || /_request$|_resolved$/.test(event.t)) update(state);
  }

  function pairingFailed(reason) {
    const code = attempt?.code;
    if (['invalid_or_expired', 'already_used'].includes(reason)) rememberCode(code);
    const consumed = !!attempt?.sessionId;
    clearAttempt();
    if (consumed) removeChannel();
    closeSocket();
    if (channel) { url = channel.url; scheduleReconnect(); }
    update(channel ? 'offline' : 'unpaired', errorCopy[reason] || '配对已中断，请重试');
  }

  function handle(frame) {
    if (!frame || typeof frame.t !== 'string') return;
    if (frame.t === 'hello-ok') {
      if (frame.protocol !== PROTOCOL || frame.role !== 'client') return;
      clearTimeout(handshakeTimer);
      transportReady = true;
      delay = reconnectDelay;
      if (typeof frame.clientId === 'string' && frame.clientId !== clientId) {
        clientId = frame.clientId;
        write(INSTALL_KEY, clientId);
        flush();
      }
      const capabilities = Array.isArray(frame.capabilities) ? frame.capabilities : [];
      notify = capabilities.includes('notify.v1') && typeof frame.notify?.templateId === 'string'
        ? frame.notify : null;
      if (capabilities.includes('digest.v1') && validDigest(frame.summary)) summary = frame.summary;
      if (attempt && !attempt.sent) {
        attempt.sent = true;
        update('pairing');
        send({ t: 'pair-begin-client', pairingToken: attempt.code, clientPub: toBase64(attempt.keys.publicKey) });
      } else if (channel) probe();
      else update('unpaired');
      return;
    }
    if (frame.t === 'pair-fail' && attempt && (!frame.pairingToken || frame.pairingToken === attempt.code)) {
      return pairingFailed(frame.reason);
    }
    if (frame.t === 'paired' && attempt?.sent && !attempt.sessionId && CONVERSATION.test(frame.sessionId)) {
      attempt.sessionId = frame.sessionId;
      attempt.hostId = frame.hostId;
      rememberCode(attempt.code);
      return;
    }
    if (frame.t === 'pair-grant' && attempt?.sessionId && attempt.sessionId === frame.sessionId && !offer) {
      const decoded = readGrant(attempt.keys.secretKey, frame);
      if (!decoded) return pairingFailed('bad_token');
      offer = { ...decoded, id: frame.sessionId + ':' + frame.hostPub };
      update('verifying');
      return;
    }
    if (frame.t === 'enc') return applyRecord(frame, frame);
    if (frame.t === 'enc-batch' && Array.isArray(frame.items)) {
      for (const item of frame.items) applyRecord(frame, item);
      return;
    }
    if (frame.t === 'resume-gap' && frame.sessionId === channel?.sessionId) {
      if (frame.reason === 'reset') { relaySeq = 0; flush(); }
      emit(frame);
      return;
    }
    if (frame.t === 'peer-left' && frame.sessionId === channel?.sessionId) {
      if (frame.unpaired) {
        removeChannel();
        abortingLeave?.();
        if (!attempt) update('unpaired', '原配对已解除');
      } else if (!attempt) {
        currentError(errorCopy.host_unavailable);
        update('host-offline', errorCopy.host_unavailable);
        armProbe();
      }
      return;
    }
    if (frame.t === 'host-status' && frame.sessionId === channel?.sessionId && frame.online) return probe();
    if (frame.t === 'error') {
      if (attempt) return pairingFailed(frame.code);
      if (frame.code === 'host_unavailable') {
        currentError(errorCopy.host_unavailable);
        update('host-offline', errorCopy.host_unavailable);
        armProbe();
      } else if (['unknown_session', 'not_member'].includes(frame.code)) {
        removeChannel();
        currentError(errorCopy[frame.code]);
        update('unpaired', errorCopy[frame.code]);
      } else update(state, errorCopy[frame.code] || '中继暂时无法处理这次请求');
    }
  }

  function scheduleReconnect() {
    if (reconnect !== undefined || !channel) return;
    reconnect = setTimeout(() => {
      reconnect = undefined;
      if (channel && !connection) boot();
    }, delay);
    delay = Math.min(delay * 2, 12000);
  }

  function boot() {
    closeSocket();
    const owner = {};
    connection = owner;
    limits = null;
    update(attempt ? 'pairing' : 'connecting');
    try {
      owner.transport = openSocket(url, {
        open() {
          if (connection !== owner) return;
          send({ t: 'hello', role: 'client', protocol: PROTOCOL, clientId,
            clientMeta: { platform: 'wechat-mp', label: '微信小程序' }, softwareVersion: version,
            resume: !attempt && channel ? { sessionId: channel.sessionId, fromSeq: relaySeq } : undefined });
        },
        message(raw) {
          if (connection !== owner || typeof raw !== 'string') return;
          try { handle(JSON.parse(raw)); } catch {}
        },
        close() {
          if (connection !== owner) return;
          closeSocket();
          currentError('连接已断开，请稍后再试');
          if (attempt) pairingFailed('network');
          else {
            update(channel ? 'offline' : 'unpaired', '连接已断开');
            scheduleReconnect();
          }
        },
        error() { /* the close callback owns retry */ },
      });
      handshakeTimer = setTimeout(() => {
        if (connection !== owner || transportReady) return;
        closeSocket();
        if (attempt) pairingFailed('network');
        else {
          update('offline', '连接中继超时');
          scheduleReconnect();
        }
      }, 8000);
    } catch {
      if (attempt) pairingFailed('network');
      else {
        closeSocket();
        update(channel ? 'offline' : 'unpaired', '无法建立中继连接');
        scheduleReconnect();
      }
    }
  }

  async function connect(address = channel?.url) {
    if (!channel) return false;
    const selected = normalizeUrl(address);
    if (channel.url !== selected) throw new Error('当前配对属于另一台中继，请重新扫码');
    if (attempt || connection) return false;
    const epoch = ++revision;
    await installation();
    if (epoch !== revision) return false;
    clearTimeout(reconnect);
    reconnect = undefined;
    url = selected;
    boot();
    return true;
  }

  async function pair(address, code) {
    const selected = normalizeUrl(address);
    if (typeof code !== 'string' || !TOKEN.test(code)) throw new Error('请输入六位配对码');
    if (dead.has(code)) throw new Error('配对码已失效，请在电脑上刷新后重扫');
    if (attempt) return false;
    const epoch = ++revision;
    await installation();
    const keys = keyPair(await random(32));
    if (epoch !== revision || attempt) return false;
    clearTimeout(reconnect);
    reconnect = undefined;
    currentError('开始新的配对');
    url = selected;
    attempt = { code, keys, sent: false };
    attempt.timer = setTimeout(() => pairingFailed('network'), 25000);
    boot();
    return true;
  }

  function confirm(id) {
    if (!offer || offer.id !== id || !attempt?.sessionId) return false;
    clearTimeout(flushTimer);
    const replacement = { url, sessionId: attempt.sessionId, hostId: attempt.hostId, psk: offer.psk, clientId, relaySeq: 0 };
    if (!write(PAIRING_KEY, replacement)) {
      update('verifying', '无法保存配对，请释放手机存储后再试');
      return false;
    }
    channel = replacement;
    sessions = [];
    pending.clear();
    historySeq.clear();
    summary = null;
    limits = null;
    relaySeq = recordedAt = lastFlush = 0;
    forget(LAST_KEY);
    clearAttempt();
    update('online');
    probe();
    return true;
  }

  function reject(id) {
    if (!offer || offer.id !== id || !attempt?.sessionId) return false;
    send({ t: 'session-leave', sessionId: attempt.sessionId });
    pairingFailed('cancelled');
    return true;
  }

  function disconnect() {
    revision += 1;
    clearTimeout(reconnect);
    reconnect = undefined;
    clearAttempt();
    flush();
    currentError('手机已断开连接');
    closeSocket();
    update(channel ? 'offline' : 'unpaired');
  }

  async function unpair() {
    const id = channel?.sessionId;
    if (id && transportReady) {
      await new Promise((resolve) => {
        const timeout = setTimeout(done, 1000);
        function done() {
          clearTimeout(timeout);
          abortingLeave = undefined;
          resolve();
        }
        abortingLeave = done;
        if (!send({ t: 'session-leave', sessionId: id })) done();
      });
    }
    removeChannel();
    disconnect();
  }

  async function command(t, args = {}, options = {}) {
    if (!channel || !transportReady || (!options.internal && state !== 'online')) {
      throw new Error(state === 'host-offline' || state === 'offline' ? '电脑离线，稍后再试' : '还未连上电脑');
    }
    const epoch = connection;
    const activeChannel = channel;
    const cmdId = options.cmdId || 'cmd-' + toBase64(await random(18)).replace(/[+/=]/g, '_');
    const existing = requests.get(cmdId);
    if (existing) return existing.promise;
    const frame = { ...args, t, cmdId };
    if (t === 'cmd.send_prompt') {
      const length = typeof frame.text === 'string' ? frame.text.length : 0;
      const cap = limits?.maxTextChars ?? MAX_TEXT;
      if (length > cap) throw new Error('这台电脑最多接收 ' + cap + ' 个字符');
      if ((frame.images?.length || 0) > (limits?.maxImageAttachments ?? MAX_ATTACHMENTS)
        || (frame.files?.length || 0) > (limits?.maxFileAttachments ?? MAX_ATTACHMENTS)) throw new Error('附件超过电脑支持的数量');
    }
    if (!validateCommand(frame)) throw new Error('指令或附件格式不正确');
    if (requests.size >= 64) throw new Error('正在等待太多请求');
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => {
      requests.delete(cmdId);
      reject(new Error('电脑没有及时响应，请稍后重试'));
    }, commandTimeout);
    const entry = { promise, resolve, reject, timer };
    requests.set(cmdId, entry);
    void Promise.resolve().then(async () => {
      const nonce = await random(24);
      const ciphertext = seal(deriveKey(activeChannel.psk, 'c2h', activeChannel.sessionId), frame, nonce);
      if (ciphertext.length > MAX_CIPHER) throw new Error('消息超过传输大小，请减少附件');
      if (connection !== epoch || channel !== activeChannel || !requests.has(cmdId)
        || !send({ t: 'enc', sessionId: activeChannel.sessionId, ciphertext })) throw new Error('连接已断开，请稍后再试');
    }).catch((error) => {
      if (requests.get(cmdId) === entry) {
        requests.delete(cmdId);
        clearTimeout(timer);
        reject(error);
      }
    });
    return promise;
  }

  async function history(sessionId, cursor = {}) {
    const result = await command('cmd.session_history', { sessionId, ...cursor });
    if (!result.ok && result.message === 'history_window_exceeded' && cursor.since !== undefined) {
      return history(sessionId, { limit: cursor.limit });
    }
    if (!result.ok || !result.history) throw new Error(result.message || '无法读取会话历史');
    return result.history;
  }

  return {
    snapshot, connect, pair, confirm, reject, disconnect, unpair, command, history,
    knownDead: (code) => dead.has(code),
    historyCursor: (sessionId) => historySeq.get(sessionId),
    registerNotification: (code) => !!notify && typeof code === 'string' && send({ t: 'notify-register', code, subscribed: true }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

module.exports = { createClient, normalizeUrl };
