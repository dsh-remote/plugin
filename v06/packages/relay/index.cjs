'use strict';

const { createServer } = require('node:http');
const { isIP } = require('node:net');
const { randomBytes } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { decodeEndpoint, PROTOCOL, MAX_FRAME, HOST_ID, TOKEN } = require('../protocol/wire.cjs');
const { loadState, saveState, match, issueToken } = require('./state.cjs');

const DAY = 86400000;

function positive(value, fallback, min = 1) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min) throw new TypeError('Invalid relay limit: ' + value);
  return value;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 2048) {
      req.resume();
      return { error: 'body_too_large' };
    }
    chunks.push(chunk);
  }
  try { return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
  catch { return { error: 'invalid_json' }; }
}

function createRelay(options = {}) {
  const {
    masterToken, bind = '127.0.0.1', port = 0, now = Date.now, stateFile, observe = () => {},
    report = () => {}, miniProgramCode, notifier, trustLocalProxy = false,
  } = options;
  if (typeof masterToken !== 'string' || !masterToken) throw new TypeError('DRC_HOST_TOKEN is required');
  const maxTokens = positive(options.maxHostTokens, 5000);
  const tokenTtl = positive(options.hostTokenTtlMs, 30 * DAY);
  const pairTtl = positive(options.pairTtlMs, 120000);
  const conversationTtl = positive(options.conversationTtlMs, 7 * DAY);
  const claimInterval = positive(options.claimIntervalMs, 4000, 0);
  const replayLimit = positive(options.replayLimit, 256);
  const pairPerConnection = positive(options.maxPairAttemptsPerConn, 5);
  const pairGlobalLimit = positive(options.pairGlobalPerSec, 20);
  const maxConversations = positive(options.maxConversations, 5000);
  const { conversations, tokens } = loadState(stateFile, report);
  const restored = conversations.size;
  const pairs = new Map();
  const hosts = new Map();
  const phones = new Map();
  const claimRates = new Map();
  const codeCache = new Map();
  let replayBytes = 0;
  let pairWindowAt = 0;
  let pairCount = 0;
  let closing = false;
  let closeTask;
  let savedAt = 0;
  let saves = 0;
  let saveFailures = 0;
  let dirty = false;
  let sweep;

  function persist() {
    if (!stateFile) return true;
    try {
      saveState(stateFile, now(), conversations, tokens);
      savedAt = now();
      saves += 1;
      dirty = false;
      return true;
    } catch {
      saveFailures += 1;
      report('state write failed');
      return false;
    }
  }

  function safeObserve(frame, direction) {
    try {
      const fields = frame.t === 'hello' ? { t: frame.t, role: frame.role, protocol: frame.protocol }
        : frame.t === 'notify-register' ? { t: frame.t, subscribed: frame.subscribed } : frame;
      observe(fields, direction);
    } catch { report('observer failed'); }
  }

  function send(peer, frame) {
    if (!peer || peer.socket.readyState !== WebSocket.OPEN) return;
    if (peer.socket.bufferedAmount > 2 * MAX_FRAME) return peer.socket.close(1013, 'slow consumer');
    safeObserve(frame, 'out');
    peer.socket.send(JSON.stringify(frame), (error) => { if (error) peer.socket.terminate(); });
  }

  function failure(peer, code, sessionId) {
    send(peer, { t: 'error', code, sessionId });
  }

  function remove(id, notify = false) {
    const row = conversations.get(id);
    if (!row) return;
    replayBytes -= row.bytes;
    conversations.delete(id);
    if (notify) {
      send(hosts.get(row.hostId), { t: 'peer-left', sessionId: id, clientId: row.clientId, unpaired: true });
      send(phones.get(row.clientId), { t: 'peer-left', sessionId: id, clientId: row.clientId, unpaired: true });
    }
    dirty = true;
  }

  function cleanup() {
    const nowMs = now();
    for (const [code, entry] of pairs) {
      if (nowMs >= entry.expires) {
        pairs.delete(code);
        codeCache.delete(code);
      }
    }
    for (const [id, row] of conversations) {
      if (!hosts.has(row.hostId) && nowMs - row.activeAt >= conversationTtl) remove(id, true);
    }
    for (const [id, at] of claimRates) if (nowMs - at >= claimInterval) claimRates.delete(id);
  }

  function authenticated(token, hostId, touch = false) {
    if (match(masterToken, token)) return true;
    const entry = tokens.get(hostId);
    if (!entry || !match(entry.token, token)) return false;
    if (touch) {
      entry.lastUsedAt = Math.max(entry.lastUsedAt, now());
      dirty = true;
    }
    return true;
  }

  function rejectFor(peer, id) {
    const row = conversations.get(id);
    if (!row) return 'unknown_session';
    if (peer.role === 'host' && row.hostId === peer.id && hosts.get(peer.id) === peer) return null;
    if (peer.role === 'client' && row.clientId === peer.id && phones.get(peer.id) === peer) return null;
    return 'not_member';
  }

  function hello(peer, frame) {
    const isHost = frame.role === 'host';
    const id = isHost ? frame.hostId : (frame.clientId || 'mp-' + randomBytes(12).toString('hex'));
    if (isHost && !authenticated(frame.token, id, true)) {
      failure(peer, 'bad_token');
      peer.socket.close(4003, 'authentication failed');
      return;
    }
    clearTimeout(peer.helloDeadline);
    peer.role = frame.role;
    peer.id = id;
    peer.version = frame.softwareVersion;
    const map = isHost ? hosts : phones;
    const previous = map.get(id);
    map.set(id, peer);
    if (previous) previous.socket.close(4000, 'replaced');
    const extras = notifyExtras(isHost);
    const row = !isHost && conversations.get(frame.resume?.sessionId);
    const member = row && row.clientId === id;
    send(peer, { t: 'hello-ok', role: frame.role, protocol: PROTOCOL,
      [isHost ? 'hostId' : 'clientId']: id,
      capabilities: ['digest.v1', ...extras.capabilities], notify: extras.notify,
      summary: member ? row.summary : undefined });
    if (isHost) {
      for (const [sessionId, entry] of conversations) {
        if (entry.hostId === id) send(phones.get(entry.clientId), { t: 'host-status', sessionId, online: true });
      }
    } else if (frame.resume) {
      const { sessionId, fromSeq } = frame.resume;
      if (!member) return failure(peer, row ? 'not_member' : 'unknown_session', sessionId);
      if (fromSeq > row.sequence || (fromSeq < row.sequence && (!row.ring.length || fromSeq + 1 < row.ring[0].seq))) {
        send(peer, { t: 'resume-gap', sessionId, reason: fromSeq > row.sequence ? 'reset' : 'overflow' });
      } else {
        for (const saved of row.ring) if (saved.seq > fromSeq) send(peer, saved);
      }
    }
  }

  function notifyExtras(host) {
    return notifier?.templateId ? {
      capabilities: ['notify.v1'], notify: host ? undefined : { templateId: notifier.templateId },
    } : { capabilities: [] };
  }

  function publishPair(peer, frame) {
    cleanup();
    const existing = pairs.get(frame.pairingToken);
    if (!existing && pairs.size >= 1000) return failure(peer, 'pair_table_full');
    if (existing && (existing.hostId !== peer.id || existing.used)) {
      return send(peer, { t: 'pair-fail', pairingToken: frame.pairingToken, reason: 'already_used' });
    }
    codeCache.delete(frame.pairingToken);
    pairs.set(frame.pairingToken, { hostId: peer.id, expires: now() + pairTtl, used: false });
    send(peer, { t: 'pair-ready', pairingToken: frame.pairingToken, ttlMs: pairTtl });
  }

  function pair(peer, frame) {
    const { pairingToken, clientPub } = frame;
    const entry = pairs.get(pairingToken);
    const owner = entry && hosts.get(entry.hostId);
    let reason;
    if (!entry || entry.expires <= now()) reason = 'invalid_or_expired';
    else if (entry.used) reason = 'already_used';
    else if (!owner) reason = 'host_offline';
    if (reason) return send(peer, { t: 'pair-fail', pairingToken, reason });
    cleanup();
    const replaced = [...conversations].filter(([, row]) => row.hostId === entry.hostId || row.clientId === peer.id);
    if (conversations.size - replaced.length >= maxConversations) return failure(peer, 'pair_table_full');
    for (const [id] of replaced) remove(id, true);
    entry.used = true;
    let sessionId;
    do { sessionId = 'c_' + randomBytes(6).toString('hex'); } while (conversations.has(sessionId));
    conversations.set(sessionId, { hostId: entry.hostId, clientId: peer.id, sequence: 0, upCount: 0,
      activeAt: now(), ring: [], bytes: 0, waitingGrant: Boolean(clientPub) });
    dirty = true;
    persist();
    send(peer, { t: 'paired', sessionId, hostId: entry.hostId });
    send(owner, { t: 'peer-joined', sessionId, clientId: peer.id, pairingToken });
    if (clientPub) send(owner, { t: 'pair-request', sessionId, pairingToken, clientPub, hostId: entry.hostId });
  }

  function downlink(sessionId, row, ciphertext) {
    const frame = { t: 'enc', sessionId, seq: ++row.sequence, ciphertext };
    row.ring.push(frame);
    row.bytes += ciphertext.length;
    replayBytes += ciphertext.length;
    while (row.ring.length > replayLimit || row.bytes > 2 * MAX_FRAME || replayBytes > 32 * MAX_FRAME) {
      const old = row.ring.shift();
      row.bytes -= old.ciphertext.length;
      replayBytes -= old.ciphertext.length;
    }
    return frame;
  }

  function canPair(peer, claiming) {
    const current = now();
    if (current - pairWindowAt >= 1000) { pairWindowAt = current; pairCount = 0; }
    if (claiming && ++peer.pairClaims > pairPerConnection || pairCount >= pairGlobalLimit) {
      failure(peer, 'rate_limited');
      return false;
    }
    pairCount += 1;
    return true;
  }

  function handle(peer, frame) {
    const { t, sessionId } = frame;
    if (t === 'hello') return hello(peer, frame);
    if ((peer.role === 'host' ? hosts : phones).get(peer.id) !== peer) return;
    if (t === 'ping') return send(peer, { t: 'pong', ts: frame.ts });
    if (t === 'pair-begin') return canPair(peer, false) && publishPair(peer, frame);
    if (t === 'pair-begin-client') return canPair(peer, true) && pair(peer, frame);
    if (t === 'resync') {
      const known = new Set(frame.sessionIds);
      for (const [id, row] of conversations) if (row.hostId === peer.id && !known.has(id)) remove(id);
      if (dirty) persist();
      return;
    }
    if (t === 'notify-register') {
      if (notifier?.templateId && [...conversations.values()].some((row) => row.clientId === peer.id)) {
        void Promise.resolve(notifier.register(peer.id, frame.code, frame.subscribed === true))
          .catch(() => report('notify register failed'));
      }
      return;
    }
    const error = rejectFor(peer, sessionId);
    if (error) return failure(peer, error, sessionId);
    const row = conversations.get(sessionId);
    if (t === 'session-leave') {
      remove(sessionId, true);
      persist();
    } else if (t === 'summary') {
      row.summary = frame.summary;
      row.activeAt = now();
      dirty = true;
    } else if (t === 'pair-grant') {
      if (!row.waitingGrant) return;
      row.waitingGrant = false;
      send(phones.get(row.clientId), frame);
    } else if (t === 'notify-approval') {
      if (notifier?.templateId && !phones.has(row.clientId)) {
        void Promise.resolve(notifier.send(row.clientId, frame.items)).catch(() => report('notify send failed'));
      }
    } else if (t === 'enc' || t === 'enc-batch') {
      const items = t === 'enc' ? [frame] : frame.items;
      if (peer.role === 'client') {
        const owner = hosts.get(row.hostId);
        if (!owner) return failure(peer, 'host_unavailable', sessionId);
        send(owner, { ...frame, clientId: row.clientId });
        row.upCount += items.length;
      } else {
        const frames = items.map((item) => downlink(sessionId, row, item.ciphertext));
        const phone = phones.get(row.clientId);
        if (t === 'enc') send(phone, frames[0]);
        else send(phone, { t: 'enc-batch', sessionId, items: frames.map(({ seq, ciphertext }) => ({ seq, ciphertext })) });
      }
      row.activeAt = now();
      dirty = true;
    }
  }

  function versions(peers) {
    const result = Object.create(null);
    for (const peer of peers.values()) {
      const version = peer.version || 'unknown';
      result[version] = (result[version] || 0) + 1;
    }
    return result;
  }

  async function http(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/v06/')) url.pathname = url.pathname.slice(4);
    if (url.pathname === '/healthz' && req.method === 'GET') {
      return json(res, closing ? 503 : 200, { ok: !closing, version: '0.6.0', hosts: hosts.size, clients: phones.size,
        hostTokens: tokens.size, conversations: conversations.size, pendingPairs: pairs.size,
        hostVersions: versions(hosts), clientVersions: versions(phones), stateRestored: restored,
        persistence: stateFile ? 'on' : 'off', stateWrites: saves, stateWriteFailures: saveFailures,
        stateSavedAtSec: savedAt ? Math.floor((now() - savedAt) / 1000) : -1 });
    }
    if (closing) return json(res, 503, { error: 'stopping' });
    if (url.pathname === '/api/claim-token') {
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      const payload = await readBody(req);
      if (payload.error) {
        if (payload.error === 'body_too_large') res.setHeader('connection', 'close');
        return json(res, payload.error === 'body_too_large' ? 413 : 400, { error: payload.error });
      }
      const hostId = payload.body?.hostId;
      if (typeof hostId !== 'string' || !HOST_ID.test(hostId)) return json(res, 400, { error: 'host_id_required' });
      const nowMs = now();
      const direct = req.socket.remoteAddress || 'unknown';
      const forwarded = req.headers['x-real-ip'];
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(direct);
      const ip = trustLocalProxy && local && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : direct;
      if (claimInterval && nowMs - (claimRates.get(ip) ?? -Infinity) < claimInterval) {
        return json(res, 429, { error: 'rate_limited' });
      }
      if (claimRates.size >= 10000) claimRates.delete(claimRates.keys().next().value);
      if (claimInterval) claimRates.set(ip, nowMs);
      const old = new Map(tokens);
      const token = issueToken(tokens, hostId, nowMs, maxTokens, tokenTtl);
      if (!persist()) {
        tokens.clear();
        for (const [id, value] of old) tokens.set(id, value);
        return json(res, 503, { error: 'state_unavailable' });
      }
      return json(res, 200, { token });
    }
    if (url.pathname === '/code' && req.method === 'GET') {
      const code = url.searchParams.get('token');
      const entry = TOKEN.test(code || '') && pairs.get(code);
      if (!entry || entry.used || entry.expires <= now()) return json(res, 404, { error: 'invalid_or_expired' });
      const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
      if (!authenticated(bearer, entry.hostId)) return json(res, 403, { error: 'bad_token' });
      if (!miniProgramCode) return json(res, 503, { error: 'mp_code_unavailable' });
      try {
        if (!codeCache.has(code)) {
          const flight = Promise.resolve().then(() => miniProgramCode(code)).catch((cause) => {
            if (codeCache.get(code) === flight) codeCache.delete(code);
            throw cause;
          });
          codeCache.set(code, flight);
        }
        const result = await codeCache.get(code);
        if (entry.used || entry.expires <= now() || pairs.get(code) !== entry) {
          return json(res, 404, { error: 'invalid_or_expired' });
        }
        res.writeHead(200, { 'content-type': result.contentType, 'cache-control': 'no-store' });
        return res.end(result.body);
      } catch {
        return json(res, 502, { error: 'mp_code_unavailable' });
      }
    }
    return json(res, 404, { error: 'not_found' });
  }

  const server = createServer({ requestTimeout: 10000, headersTimeout: 10000 }, (req, res) => {
    void http(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: 'internal' });
    });
  });
  const websocket = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (closing || !['/', '/v05', '/v06'].includes(req.url?.split('?')[0]) || websocket.clients.size >= 10000) {
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(req, socket, head, (ws) => websocket.emit('connection', ws));
  });
  websocket.on('connection', (socket) => {
    const peer = { socket, role: null, id: '', messages: 0, pairClaims: 0, started: now(), alive: true };
    socket.on('pong', () => { peer.alive = true; });
    socket.owner = peer;
    peer.helloDeadline = setTimeout(() => socket.close(1008, 'hello required'), 10000);
    peer.helloDeadline.unref();
    socket.on('error', () => {});
    socket.on('message', (data, binary) => {
      if (now() - peer.started >= 1000) {
        peer.started = now();
        peer.messages = 0;
      }
      if (++peer.messages > 120) return socket.close(1008, 'rate limited');
      const { frame, error } = decodeEndpoint(binary ? null : String(data), peer.role);
      if (error) return failure(peer, error);
      safeObserve(frame, 'in');
      handle(peer, frame);
    });
    socket.on('close', () => {
      clearTimeout(peer.helloDeadline);
      const map = peer.role === 'host' ? hosts : phones;
      if (map.get(peer.id) !== peer) return;
      map.delete(peer.id);
      for (const [sessionId, row] of conversations) {
        if (peer.role === 'host' && row.hostId === peer.id) {
          send(phones.get(row.clientId), { t: 'peer-left', sessionId, clientId: peer.id });
        } else if (peer.role === 'client' && row.clientId === peer.id) {
          send(hosts.get(row.hostId), { t: 'peer-left', sessionId, clientId: peer.id });
        }
      }
    });
  });

  async function start() {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bind, () => { server.off('error', reject); resolve(); });
    });
    let lastHeartbeat = Date.now();
    sweep = setInterval(() => {
      cleanup();
      if (dirty) persist();
      if (Date.now() - lastHeartbeat < 30000) return;
      lastHeartbeat = Date.now();
      for (const socket of websocket.clients) {
        if (!socket.owner.alive) socket.terminate();
        else { socket.owner.alive = false; socket.ping(); }
      }
    }, 1000);
    sweep.unref();
    const address = server.address();
    const addressHost = bind.includes(':') ? '[' + bind + ']' : bind === '0.0.0.0' ? '127.0.0.1' : bind;
    return { port: address.port, http: 'http://' + addressHost + ':' + address.port,
      ws: 'ws://' + addressHost + ':' + address.port };
  }

  function close() {
    if (closeTask) return closeTask;
    closing = true;
    clearInterval(sweep);
    if (dirty) persist();
    for (const socket of websocket.clients) {
      socket.close(1001, 'relay stopping');
    }
    closeTask = new Promise((resolve) => {
      const hardStop = setTimeout(() => {
        for (const socket of websocket.clients) socket.terminate();
        server.closeAllConnections();
      }, 500);
      hardStop.unref();
      server.close(() => {
        clearTimeout(hardStop);
        resolve();
      });
      server.closeIdleConnections();
    });
    return closeTask;
  }

  return { start, close };
}

module.exports = { createRelay };
