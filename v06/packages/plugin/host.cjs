'use strict';

const { randomBytes, randomInt } = require('node:crypto');
const { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } = require('node:fs');
const { dirname, join } = require('node:path');
const WebSocket = require('ws');
const { HOST_ID, CONVERSATION, PROTOCOL, MAX_FRAME } = require('../protocol/wire.cjs');
const { toBase64, fromBase64, deriveKey, makeGrant, seal, open } = require('../protocol/crypto.cjs');
const { createTokenRecovery, systemClock } = require('./token-recovery.cjs');
const { createRuntime } = require('./runtime.cjs');

function read(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function write(file, value) {
  const name = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(name, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx', flush: true });
    renameSync(name, file);
  } finally {
    try { unlinkSync(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function httpEndpoint(url, suffix) {
  const address = new URL(url);
  if (!['ws:', 'wss:'].includes(address.protocol) || address.username || address.password) throw new Error('中继地址无效');
  address.protocol = address.protocol === 'ws:' ? 'http:' : 'https:';
  address.pathname = address.pathname.replace(/\/+$/, '') + suffix;
  address.search = '';
  address.hash = '';
  return address.toString();
}

function createHost({ url, hostId, label = 'DSH', token: manualToken, kernel, stateDir, fetchImpl = globalThis.fetch,
  clock = systemClock, awake, onStatus = () => {}, log = () => {} }) {
  const endpoint = httpEndpoint(url, '/api/claim-token');
  if (!HOST_ID.test(hostId || '')) throw new Error('Host id is required');
  if (!kernel || !stateDir) throw new Error('Kernel port and state directory are required');
  const stateFile = join(stateDir, 'channels-v06.json');
  const tokenFile = join(stateDir, 'host-token.json');
  const statusFile = join(stateDir, 'status.json');
  let token = manualToken || '';
  let source = token ? 'manual' : 'none';
  const known = read(tokenFile);
  if (!token && known?.hostId === hostId && known.serverUrl === url && /^[0-9a-f]{48}$/.test(known.token)) {
    token = known.token;
    source = 'claimed';
  }
  const channels = new Map();
  const saved = read(stateFile);
  if (saved && saved.hostId === hostId && saved.serverUrl === url && Array.isArray(saved.channels)) {
    for (const row of saved.channels.slice(0, 256)) {
      try {
        if (CONVERSATION.test(row.sessionId) && fromBase64(row.psk).length === 16) {
          channels.set(row.sessionId, { psk: row.psk, joined: false });
        }
      } catch { /* an invalid channel will be removed by resync */ }
    }
  }
  const codes = new Map();
  let active;
  let sas = '';
  let sasUntil = 0;
  let state = 'offline';
  let problem = '';
  let socket;
  let retry;
  let startTask;
  let started = false;
  let stopping = false;
  let blocked = false;
  let retryDelay = 250;
  let notifyEnabled = false;
  let notifyTimer;
  let digest;
  let helloTimer;

  function status() {
    return {
      state, relay: state, relayProblem: problem, serverUrl: url, version: '0.6.0', hostId,
      paired: channels.size, onlinePhones: [...channels.values()].filter((row) => row.joined).length,
      waiting: runtime.waiting().length, sas: sasUntil > clock.now() ? sas : '', pairing: active ? { expiresAt: active.expiresAt } : null,
      hostToken: { source, ...recovery.status() },
    };
  }

  function revise(nextState, reason = '') {
    state = nextState;
    problem = reason;
    recordStatus();
  }

  function recordStatus() {
    const snapshot = status();
    try { write(statusFile, snapshot); } catch { log('cannot write host status'); }
    onStatus(snapshot);
  }

  function persistChannels() {
    try { write(stateFile, { hostId, serverUrl: url,
      channels: Array.from(channels, ([sessionId, row]) => ({ sessionId, psk: row.psk })) }); }
    catch { log('cannot persist host pairing'); }
  }

  function send(frame) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const raw = JSON.stringify(frame);
    if (Buffer.byteLength(raw) > MAX_FRAME || socket.bufferedAmount > 2 * MAX_FRAME) return false;
    socket.send(raw);
    return true;
  }

  function sendEvent(sessionId, event) {
    const row = channels.get(sessionId);
    if (!row || state !== 'online') return;
    const ciphertext = seal(deriveKey(row.psk, 'h2c', sessionId), event, randomBytes(24));
    if (!send({ t: 'enc', sessionId, ciphertext })) log('could not deliver host event');
  }

  function sendSummary(value) {
    digest = value;
    if (state !== 'online') return;
    for (const sessionId of channels.keys()) send({ t: 'summary', sessionId, summary: value });
  }

  function planNotify() {
    clearTimeout(notifyTimer);
    if (!notifyEnabled || state !== 'online' || stopping || !channels.size) return;
    const waiting = runtime.waiting();
    if (!waiting.length) return;
    const due = Math.max(0, Math.min(...waiting.map((row) => row.opened + 60000)) - clock.now());
    notifyTimer = setTimeout(() => {
      const items = runtime.waiting().filter((row) => clock.now() - row.opened >= 60000).slice(0, 10)
        .map(({ opened, ...row }) => ({ ...row, askedAt: new Date(opened).toISOString() }));
      if (!items.length) return;
      for (const [sessionId, row] of channels) if (!row.joined) send({ t: 'notify-approval', sessionId, items });
    }, due || 1);
    notifyTimer.unref?.();
  }

  const runtime = createRuntime({
    kernel, awake, now: clock.now, send: sendEvent, summarize: sendSummary,
    broadcast(event) { for (const id of channels.keys()) sendEvent(id, event); },
    pendingChanged() { planNotify(); recordStatus(); },
  });

  async function claim() {
    try {
      const result = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostId }), signal: AbortSignal.timeout(8000) });
      if (!result.ok) return null;
      const answer = await result.json();
      return typeof answer.token === 'string' && /^[0-9a-f]{48}$/.test(answer.token) ? answer.token : null;
    } catch { return null; }
  }

  function takeToken(value) {
    token = value;
    source = 'claimed';
    try { write(tokenFile, { version: 1, hostId, serverUrl: url, source, token, savedAt: clock.now() }); }
    catch { log('cannot persist host token'); }
  }

  const recovery = createTokenRecovery({
    clock, claim, change: recordStatus,
    activate(value) {
      takeToken(value);
      blocked = false;
      const previous = socket;
      socket = undefined;
      clearTimeout(helloTimer);
      if (previous?.readyState === WebSocket.CONNECTING) previous.terminate();
      else previous?.close();
      openSocket();
    },
  });

  function scheduleReconnect() {
    if (stopping || blocked || retry !== undefined) return;
    retry = clock.set(retryDelay, () => {
      retry = undefined;
      openSocket();
    });
    retryDelay = Math.min(15000, 2 * retryDelay);
  }

  function dropCode(code, reason) {
    const item = codes.get(code);
    if (!item) return;
    codes.delete(code);
    clearTimeout(item.timer);
    item.reject?.(new Error(reason));
  }

  function handleFrame(frame) {
    if (frame.t === 'hello-ok' && frame.role === 'host' && frame.protocol === PROTOCOL) {
      clearTimeout(helloTimer);
      blocked = false;
      retryDelay = 250;
      recovery.online();
      revise('online');
      send({ t: 'resync', sessionIds: [...channels.keys()] });
      notifyEnabled = frame.capabilities?.includes('notify.v1') === true;
      if (digest) sendSummary(digest);
      planNotify();
      return;
    }
    if (frame.t === 'error' && frame.code === 'bad_token') {
      blocked = true;
      revise('offline', manualToken ? '中继拒绝了设置中的主机令牌' : '主机令牌失效，正在重新认领');
      if (!manualToken) recovery.rejected();
      return;
    }
    if (frame.t === 'error' && frame.code === 'unknown_session' && channels.delete(frame.sessionId)) {
      persistChannels();
      recordStatus();
      return;
    }
    if (state !== 'online') return;
    if (frame.t === 'pair-ready') {
      const row = codes.get(frame.pairingToken);
      if (!row || !Number.isSafeInteger(frame.ttlMs) || frame.ttlMs <= 0 || frame.ttlMs > 2592000000) return;
      clearTimeout(row.timer);
      row.expiresAt = clock.now() + frame.ttlMs;
      active = { ...row, token: frame.pairingToken };
      row.resolve?.({ token: frame.pairingToken, expiresAt: row.expiresAt });
      row.resolve = row.reject = undefined;
      recordStatus();
      return;
    }
    if (frame.t === 'pair-fail') {
      dropCode(frame.pairingToken, '无法签发配对码，再试一次');
      return;
    }
    if (frame.t === 'pair-request') {
      const row = codes.get(frame.pairingToken);
      if (!row || row.expiresAt <= clock.now() || !CONVERSATION.test(frame.sessionId)) return;
      try {
        const { sas: digits, ...grant } = makeGrant(randomBytes(32), fromBase64(frame.clientPub), row.psk, randomBytes(24));
        if (!send({ t: 'pair-grant', sessionId: frame.sessionId, ...grant })) return;
        sas = digits;
        sasUntil = clock.now() + 90000;
        channels.set(frame.sessionId, { psk: row.psk, joined: false });
        codes.delete(frame.pairingToken);
        if (active?.token === frame.pairingToken) active = undefined;
        persistChannels();
        recordStatus();
      } catch { log('invalid key in pairing request'); }
      return;
    }
    if (frame.t === 'peer-left') {
      const row = channels.get(frame.sessionId);
      if (!row) return;
      if (frame.unpaired) {
        channels.delete(frame.sessionId);
        sas = '';
        persistChannels();
      } else row.joined = false;
      planNotify();
      recordStatus();
      return;
    }
    if (frame.t !== 'enc' && frame.t !== 'enc-batch') return;
    const row = channels.get(frame.sessionId);
    if (!row) return;
    const key = deriveKey(row.psk, 'c2h', frame.sessionId);
    for (const record of frame.t === 'enc' ? [frame] : frame.items || []) {
      const cmd = open(key, record.ciphertext);
      if (!cmd) continue;
      if (!row.joined) {
        row.joined = true;
        runtime.greet(frame.sessionId);
        recordStatus();
      }
      void runtime.handle(cmd, frame.sessionId).catch(() => log('host command failed'));
    }
  }

  function openSocket() {
    if (!started || stopping || blocked || !token || socket) return;
    let current;
    try { current = new WebSocket(url, { maxPayload: MAX_FRAME, handshakeTimeout: 8000, perMessageDeflate: false }); }
    catch { revise('offline', '无法连接中继'); scheduleReconnect(); return; }
    socket = current;
    revise('connecting');
    helloTimer = setTimeout(() => current.terminate(), 10000);
    helloTimer.unref();
    current.on('open', () => {
      if (socket === current) send({ t: 'hello', role: 'host', protocol: PROTOCOL, hostId, token, label, softwareVersion: '0.6.0' });
    });
    current.on('message', (data, binary) => {
      if (binary || socket !== current) return;
      try { handleFrame(JSON.parse(String(data))); } catch { log('host ignored an invalid relay frame'); }
    });
    current.on('error', () => {});
    current.on('close', () => {
      if (socket !== current) return;
      socket = undefined;
      clearTimeout(helloTimer);
      for (const row of channels.values()) row.joined = false;
      if (!blocked && !stopping) {
        revise('offline', '中继连接断开');
        scheduleReconnect();
      }
    });
  }

  function start() {
    if (startTask) return startTask;
    started = true;
    startTask = (async () => {
      if (!token) {
        revise('connecting', '正在认领主机令牌');
        const issued = await claim();
        if (stopping) return;
        if (issued) takeToken(issued);
        else {
          revise('offline', '无法认领主机令牌，正在重试');
          recovery.rejected();
          return;
        }
      }
      openSocket();
    })();
    return startTask;
  }

  function issueCode() {
    if (state !== 'online') return Promise.reject(new Error('主机还未连上中继'));
    for (const [code, row] of codes) if (row.expiresAt && row.expiresAt <= clock.now()) dropCode(code, '配对码已过期');
    if (codes.size >= 8) return Promise.reject(new Error('配对码签发过于频繁，稍后再试'));
    let pairingToken;
    do { pairingToken = String(randomInt(0, 1000000)).padStart(6, '0'); } while (codes.has(pairingToken));
    return new Promise((resolve, reject) => {
      const item = { psk: toBase64(randomBytes(16)), expiresAt: 0, resolve, reject };
      codes.set(pairingToken, item);
      item.timer = setTimeout(() => dropCode(pairingToken, '签发配对码超时'), 3000);
      item.timer.unref();
      if (!send({ t: 'pair-begin', pairingToken })) dropCode(pairingToken, '无法发送配对请求');
    });
  }

  async function getCodeImage(code) {
    const route = new URL(httpEndpoint(url, '/code'));
    route.searchParams.set('token', code);
    const answer = await fetchImpl(route, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) });
    if (!answer.ok) throw new Error('中继无法生成小程序码');
    const contentType = answer.headers.get('content-type');
    if (!['image/jpeg', 'image/png'].includes(contentType)) throw new Error('中继返回了无效的小程序码');
    return { contentType, body: Buffer.from(await answer.arrayBuffer()) };
  }

  function unpairAll() {
    const ids = [...channels.keys()];
    for (const sessionId of ids) send({ t: 'session-leave', sessionId });
    channels.clear();
    sas = '';
    persistChannels();
    recordStatus();
    return ids.length;
  }

  let stopTask;
  function stop() {
    if (stopTask) return stopTask;
    stopping = true;
    clearTimeout(notifyTimer);
    clearTimeout(helloTimer);
    if (retry !== undefined) clock.clear(retry);
    recovery.stop();
    for (const code of codes.keys()) dropCode(code, '主机已停止');
    const current = socket;
    socket = undefined;
    revise('offline', '宿主已经停止');
    runtime.dispose();
    stopTask = new Promise((resolve) => {
      if (!current || current.readyState === WebSocket.CLOSED) return resolve();
      const deadline = setTimeout(() => current.terminate(), 500);
      current.once('close', () => { clearTimeout(deadline); resolve(); });
      if (current.readyState === WebSocket.CONNECTING) current.terminate();
      else current.close(1001);
    });
    return stopTask;
  }

  return { start, stop, status, issueCode, getCodeImage, unpairAll, requestDecision: runtime.requestDecision,
    resolveDesktop: runtime.resolveDesktop, emit: runtime.emit };
}

module.exports = { createHost, httpEndpoint, read, write };
