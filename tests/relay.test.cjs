const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createRelay } = require('../packages/relay/index.cjs');
const { masterToken, tempDir, rawSocket, until } = require('./support.cjs');

async function start(t, overrides = {}) {
  const relay = createRelay({ masterToken, claimIntervalMs: 0, ...overrides });
  t.after(() => relay.close());
  return { relay, ...await relay.start() };
}

async function claim(http, hostId) {
  const reply = await fetch(http + '/api/claim-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId }),
  });
  assert.equal(reply.status, 200);
  const { token } = await reply.json();
  assert.match(token, /^[a-f0-9]{48}$/);
  return token;
}

async function host(t, ws, hostId, token = masterToken, accepted = true) {
  const peer = await rawSocket(t, ws);
  peer.send({ t: 'hello', role: 'host', protocol: 1, hostId, token });
  if (accepted) assert.equal((await peer.next('hello-ok')).hostId, hostId);
  else assert.equal((await peer.next('error')).code, 'bad_token');
  return peer;
}

async function phone(t, url, clientId, resume) {
  const peer = await rawSocket(t, url);
  peer.send({ t: 'hello', role: 'client', protocol: 1, clientId, resume });
  assert.equal((await peer.next('hello-ok')).clientId, clientId);
  return peer;
}

const clientPub = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';

async function bind(owner, client, code) {
  owner.send({ t: 'pair-begin', pairingToken: code });
  const ready = await owner.next('pair-ready');
  assert.equal(ready.pairingToken, code);
  client.send({ t: 'pair-begin-client', pairingToken: code, clientPub });
  const paired = await client.next('paired');
  const request = await owner.next('pair-request');
  assert.equal(request.sessionId, paired.sessionId);
  assert.equal(request.clientPub, clientPub);
  assert.equal((await owner.next('peer-joined')).sessionId, paired.sessionId);
  return paired.sessionId;
}

test('R1: saturated live table admits the freshly issued token and evicts the least used old entry', async (t) => {
  let clock = 10;
  const { http, ws } = await start(t, { maxHostTokens: 2, now: () => clock });
  const a = await claim(http, 'host-a');
  await (await host(t, ws, 'host-a', a)).close();
  clock += 10;
  const b = await claim(http, 'host-b');
  await (await host(t, ws, 'host-b', b)).close();
  clock += 10;
  const c = await claim(http, 'host-c');
  await host(t, ws, 'host-c', c);
  await host(t, ws, 'host-b', b);
  await host(t, ws, 'host-a', a, false);
  await host(t, ws, 'host-master');
  assert.equal((await (await fetch(http + '/healthz')).json()).hostTokens, 2);
});

test('R1: idle TTL prunes even below capacity and tokens remain scoped to the issuing host', async (t) => {
  let clock = 100;
  const { http, ws } = await start(t, { maxHostTokens: 10, hostTokenTtlMs: 100, now: () => clock });
  const old = await claim(http, 'host-old');
  await host(t, ws, 'host-other', old, false);
  clock = 180;
  const current = await claim(http, 'host-current');
  await (await host(t, ws, 'host-current', current)).close();
  clock = 201;
  await claim(http, 'host-new');
  await host(t, ws, 'host-old', old, false);
  await host(t, ws, 'host-current', current);
  const rotated = await claim(http, 'host-current');
  assert.notEqual(rotated, current);
  await host(t, ws, 'host-current', current, false);
  await host(t, ws, 'host-current', rotated);
});

test('P3/R3: only members get ciphertext, replay is ordered and explicit leave revokes access', async (t) => {
  const { ws } = await start(t);
  const owner = await host(t, ws, 'host-routing');
  const client = await phone(t, ws, 'client-owner');
  const sessionId = await bind(owner, client, '012345');
  const outsider = await phone(t, ws, 'client-outsider');
  outsider.send({ t: 'pair-begin-client', pairingToken: '012345', clientPub });
  assert.equal((await outsider.next('pair-fail')).reason, 'already_used');
  outsider.send({ t: 'enc', sessionId, ciphertext: 'YQ==' });
  assert.equal((await outsider.next('error')).code, 'not_member');
  owner.send({ t: 'enc', sessionId, seq: 200, ciphertext: 'YQ==' });
  assert.equal((await client.next('enc')).seq, 1);
  await client.close();
  owner.send({ t: 'enc', sessionId, ciphertext: 'Yg==' });
  owner.send({ t: 'enc', sessionId, ciphertext: 'Yw==' });
  const resumed = await phone(t, ws, 'client-owner', { sessionId, fromSeq: 1 });
  assert.deepEqual([await resumed.next('enc'), await resumed.next('enc')].map((x) => [x.seq, x.ciphertext]),
    [[2, 'Yg=='], [3, 'Yw==']]);
  resumed.send({ t: 'session-leave', sessionId });
  assert.equal((await owner.next('peer-left', (f) => f.unpaired)).sessionId, sessionId);
  resumed.send({ t: 'enc', sessionId, ciphertext: 'YQ==' });
  assert.equal((await resumed.next('error')).code, 'unknown_session');
});

test('P2: an expired code does not pair; a newly published code survives unrelated failures', async (t) => {
  let now = 100;
  const { ws } = await start(t, { now: () => now, pairTtlMs: 40 });
  const owner = await host(t, ws, 'host-expiry');
  const client = await phone(t, ws, 'client-expiry');
  owner.send({ t: 'pair-begin', pairingToken: '111111' });
  assert.equal((await owner.next('pair-ready')).ttlMs, 40);
  now = 141;
  owner.send({ t: 'pair-begin', pairingToken: '222222' });
  await owner.next('pair-ready');
  client.send({ t: 'pair-begin-client', pairingToken: '111111', clientPub });
  assert.equal((await client.next('pair-fail')).reason, 'invalid_or_expired');
  client.send({ t: 'pair-begin-client', pairingToken: '222222', clientPub });
  assert.equal((await client.next('paired')).hostId, 'host-expiry');
});

test('R3: snapshots preserve token, member, cursor and sanitized summary across a relay restart', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'state.json');
  const first = await start(t, { stateFile: file });
  const token = await claim(first.http, 'host-restart');
  const owner = await host(t, first.ws, 'host-restart', token);
  const client = await phone(t, first.ws, 'client-restart');
  const sessionId = await bind(owner, client, '123523');
  owner.send({ t: 'summary', sessionId, summary: { at: 100, running: true, title: 'secret never persisted' } });
  assert.equal((await owner.next('error')).code, 'bad_frame');
  owner.send({ t: 'summary', sessionId, summary: { at: 101, running: true, pending: 2 } });
  owner.send({ t: 'enc', sessionId, ciphertext: 'YQ==' });
  await client.next('enc');
  await first.relay.close();
  const snapshot = await readFile(file, 'utf8');
  assert.equal(snapshot.includes('secret never persisted'), false);
  assert.equal(snapshot.includes('ciphertext'), false);

  const second = await start(t, { stateFile: file });
  const resumed = await rawSocket(t, second.ws);
  resumed.send({ t: 'hello', role: 'client', protocol: 1, clientId: 'client-restart', resume: { sessionId, fromSeq: 0 } });
  assert.deepEqual((await resumed.next('hello-ok')).summary, { at: 101, running: true, pending: 2 });
  assert.equal((await resumed.next('resume-gap')).reason, 'overflow');
  resumed.send({ t: 'enc', sessionId, ciphertext: 'Yg==' });
  assert.equal((await resumed.next('error')).code, 'host_unavailable');
  const rejoined = await host(t, second.ws, 'host-restart', token);
  resumed.send({ t: 'enc', sessionId, ciphertext: 'Yw==' });
  assert.equal((await rejoined.next('enc')).ciphertext, 'Yw==');
  rejoined.send({ t: 'enc', sessionId, ciphertext: 'ZA==' });
  assert.equal((await resumed.next('enc')).seq, 2);
});

test('O2: code endpoint allows the owner of a current code and passes only the scene to the provider', async (t) => {
  const requests = [];
  const { ws, http } = await start(t, {
    miniProgramCode: async (scene) => {
      requests.push(scene);
      return { body: Buffer.from('sample'), contentType: 'image/jpeg' };
    },
  });
  const token = await claim(http, 'host-code');
  const other = await claim(http, 'host-other-code');
  const peer = await host(t, ws, 'host-code', token);
  peer.send({ t: 'pair-begin', pairingToken: '916285' });
  await peer.next('pair-ready');
  const url = http + '/code?token=916285';
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer ' + other } })).status, 403);
  const result = await fetch(url, { headers: { authorization: 'Bearer ' + token } });
  assert.equal(await result.text(), 'sample');
  assert.equal(result.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(requests, ['916285']);
});

test('R1: explicit reverse proxy trust uses source IP while untrusted headers cannot skip rate limits', async (t) => {
  const unchecked = await start(t, { claimIntervalMs: 4000 });
  const trusted = await start(t, { claimIntervalMs: 4000, trustLocalProxy: true });
  async function call(http, hostId, ip) {
    return fetch(http + '/v06/api/claim-token', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-real-ip': ip,
    }, body: JSON.stringify({ hostId }) });
  }
  assert.equal((await call(unchecked.http, 'proxy-a', '192.0.2.1')).status, 200);
  assert.equal((await call(unchecked.http, 'proxy-b', '192.0.2.2')).status, 429);
  assert.equal((await call(trusted.http, 'proxy-a', '192.0.2.1')).status, 200);
  assert.equal((await call(trusted.http, 'proxy-b', '192.0.2.2')).status, 200);
  assert.equal((await call(trusted.http, 'proxy-c', '192.0.2.2')).status, 429);
});

test('P2: malformed or expired code attempts have a finite per-connection budget', async (t) => {
  const { ws } = await start(t, { maxPairAttemptsPerConn: 2 });
  const client = await phone(t, ws, 'client-attempt-limit');
  for (const pairingToken of ['121232', '343434']) {
    client.send({ t: 'pair-begin-client', pairingToken, clientPub });
    assert.equal((await client.next('pair-fail')).reason, 'invalid_or_expired');
  }
  client.send({ t: 'pair-begin-client', pairingToken: '123232', clientPub });
  assert.equal((await client.next('error')).code, 'rate_limited');
});
