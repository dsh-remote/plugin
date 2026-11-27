const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sceneToken, createPairingUI } = require('../packages/client/pairing-ui.cjs');
const { selectSessions } = require('../packages/client/view-model.cjs');
const { createMarkdown } = require('../packages/client/markdown.cjs');

test('P1: an actual scan launches one claim directly; stale launch values cannot start one', async () => {
  const attempts = [];
  const ui = createPairingUI({ pair: (code) => attempts.push(code), knownDead: (code) => code === '111111' });
  assert.equal(sceneToken({ scene: 1047, query: { scene: '%30%31%32%33%34%35' } }), '012345');
  assert.equal(sceneToken({ scene: 1089, query: { scene: '012345' } }), '');
  assert.equal(sceneToken({ scene: '012345' }), '');
  await ui.launch({ scene: 1089, query: { scene: '012345' } });
  await ui.launch({ scene: 1047, query: { scene: '111111' } });
  assert.deepEqual(attempts, []);
  const entry = { scene: 1047, query: { scene: '012345' } };
  await ui.launch(entry);
  await ui.launch(entry);
  assert.deepEqual(attempts, ['012345']);
  await ui.scan({ path: 'pages/sessions/index?scene=444555', result: '' });
  assert.deepEqual(attempts, ['012345', '444555']);
});

test('P2: a late or substituted grant cannot change the SAS the user is approving', async () => {
  const dialogs = [];
  const accepted = [];
  const declined = [];
  const ui = createPairingUI({
    pair: () => {},
    showSas: (sas) => new Promise((resolve) => dialogs.push({ sas, resolve })),
    accept: (id) => accepted.push(id),
    reject: (id) => declined.push(id),
  });
  const a = ui.grant({ id: 'offer-a', sas: '012345' });
  const duplicate = ui.grant({ id: 'offer-a', sas: '012345' });
  const substituted = ui.grant({ id: 'offer-b', sas: '654321' });
  assert.deepEqual(dialogs.map((d) => d.sas), ['012345']);
  dialogs[0].resolve(true);
  await Promise.all([a, duplicate, substituted]);
  assert.deepEqual(accepted, ['offer-a']);
  assert.deepEqual(declined, []);
  await ui.grant({ id: 'offer-a', sas: '012345' });
  assert.equal(dialogs.length, 1);
});

test('P2: a fresh explicit claim can open a dialog after rejection; a failed dialog stays retryable', async () => {
  const rejected = [];
  const accepted = [];
  let transient = true;
  const ui = createPairingUI({
    pair: () => {},
    showSas: async () => {
      if (transient) {
        transient = false;
        throw new Error('page temporarily hidden');
      }
      return rejected.length === 1;
    },
    accept: (id) => accepted.push(id),
    reject: (id) => rejected.push(id),
  });
  await ui.scan({ path: 'pages/sessions/index?scene=123111' });
  await ui.grant({ id: 'first', sas: '123456' });
  await ui.grant({ id: 'first', sas: '123456' });
  assert.deepEqual(rejected, ['first']);
  await ui.scan({ path: 'pages/sessions/index?scene=123222' });
  await ui.grant({ id: 'second', sas: '123456' });
  assert.deepEqual(accepted, ['second']);
});

test('U1: ordering, unique project paths, pins, pending and archived counts are independent', () => {
  const items = [
    { id: 'a', state: 'idle', workspace: '/one/project', updatedAt: '2026-01-02T00:00:00Z' },
    { id: 'b', state: 'running', workspace: '/two/project', updatedAt: '2026-01-04T00:00:00Z' },
    { id: 'c', state: 'awaiting-permission', workspace: '/one/project', updatedAt: '2026-01-03T00:00:00Z' },
    { id: 'd', state: 'archived', workspace: '/archived', updatedAt: '2026-01-05T00:00:00Z' },
    { id: 'e', state: 'idle', workspace: '/pinned-only', updatedAt: '2026-01-01T00:00:00Z' },
  ];
  const view = selectSessions(items, ['e']);
  assert.deepEqual(view.groups.map((g) => [g.path, g.items.map((i) => i.id)]),
    [[null, ['e']], ['/two/project', ['b']], ['/one/project', ['c', 'a']]]);
  assert.deepEqual(view.projects.map((p) => p.path), ['/two/project', '/one/project', '/pinned-only']);
  assert.deepEqual(view.pending.map((s) => s.id), ['c']);
  assert.equal(view.archivedCount, 1);
  assert.equal(view.groups[2].items[1].badge, '');
  assert.equal(items[0].badge, undefined);
});

test('U2: a parser load error preserves text, and supported engines still render rich headings', () => {
  const plain = createMarkdown(() => { throw new SyntaxError('unsupported regex'); });
  const model = plain('# 标题\n\n**正文**\n第二行');
  assert.deepEqual(model.map((node) => node.children[0].text), ['# 标题', '**正文**\n第二行']);
  const rich = createMarkdown(() => require('marked'));
  assert.equal(rich('# 标题')[0].name, 'h1');
  assert.equal(JSON.stringify(rich('<script>alert(1)</script>')).includes('"name":"script"'), false);
});

test('P2: authenticated requests after confirmation use the key from the exact SAS displayed', async () => {
  const { createClient } = require('../packages/client/client.cjs');
  const { fromBase64, makeGrant, deriveKey, open } = require('../packages/protocol/crypto.cjs');
  const { memoryStore, random, until } = require('./support.cjs');
  let receiver;
  const transcript = [];
  const client = createClient({ storage: memoryStore(), random, socket(_url, events) {
    receiver = events;
    return { send(line) { transcript.push(JSON.parse(line)); return true; }, close() {} };
  } });
  try {
    const url = 'ws://127.0.0.1:9999';
    const sessionId = 'c_001122334455';
    await client.pair(url, '012345');
    receiver.open();
    const hello = transcript[0];
    const push = (value) => receiver.message(JSON.stringify(value));
    push({ t: 'hello-ok', role: 'client', protocol: 1, clientId: hello.clientId });
    const publicKey = fromBase64(transcript[1].clientPub);
    push({ t: 'paired', sessionId, hostId: 'host-original' });
    const key1 = 'AAECAwQFBgcICQoLDA0ODw==';
    const key2 = 'ECAwQFBgcICQoLDA0ODwAA==';
    const first = makeGrant(random(32), publicKey, key1, random(24));
    const other = makeGrant(random(32), publicKey, key2, random(24));
    push({ t: 'pair-grant', sessionId, ...first });
    const shown = client.snapshot().offer;
    assert.equal(shown.sas, first.sas);
    push({ t: 'pair-grant', sessionId, ...other });
    assert.equal(client.confirm(shown.id), true);
    const sent = await until(() => transcript.find((f) => f.t === 'enc'), 'client list request');
    assert.equal(open(deriveKey(key1, 'c2h', sessionId), sent.ciphertext).t, 'cmd.list_sessions');
    assert.equal(open(deriveKey(key2, 'c2h', sessionId), sent.ciphertext), null);
  } finally { client.disconnect(); }
});
