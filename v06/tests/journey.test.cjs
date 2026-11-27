const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { createRelay } = require('../packages/relay/index.cjs');
const { createHost } = require('../packages/plugin/host.cjs');
const { createClient } = require('../packages/client/client.cjs');
const { random, until, tempDir, memoryStore, nodeSocket, masterToken } = require('./support.cjs');

async function createJourney(t) {
  const traces = [];
  const received = [];
  const historyQueries = [];
  const tasks = [
    { id: 'task-main', title: 'project private title', workspace: '/source/project', state: 'idle',
      updatedAt: '2026-11-26T00:00:00Z' },
  ];
  let publish;
  let host;
  const dir = await tempDir(t);
  const relay = createRelay({ masterToken, stateFile: join(dir, 'relay.json'), claimIntervalMs: 0,
    observe: (frame) => traces.push(frame) });
  t.after(async () => { await host?.stop(); await relay.close(); });
  const { ws } = await relay.start();
  const kernel = {
    limits: { maxTextChars: 100, maxImageAttachments: 0, maxFileAttachments: 2 },
    subscribe(fn) { publish = fn; return () => { publish = undefined; }; },
    async listSessions() { return tasks; },
    async sendPrompt(sessionId, text, attachments) {
      received.push({ sessionId, text, attachments });
      publish({ t: 'ev.message_delta', sessionId, messageId: 'reply-main', role: 'assistant', delta: '私密', done: false });
      publish({ t: 'ev.message_delta', sessionId, messageId: 'reply-main', role: 'assistant', delta: '回应', done: true });
    },
    async newSession(workspace) {
      tasks.push({ id: 'task-new', title: 'new task', workspace, state: 'idle' });
      return 'task-new';
    },
    async archiveSession(id, archived) {
      if (id === 'task-main') throw new Error('会话正在运行，不能归档');
      const item = tasks.find((s) => s.id === id);
      item.state = archived ? 'archived' : 'idle';
    },
    async interrupt(sessionId) { received.push({ interrupt: sessionId }); },
    async history(sessionId, cursor) {
      historyQueries.push({ sessionId, ...cursor });
      if (cursor.since === 99) return { error: 'history_window_exceeded' };
      return { latestSeq: 15, ...(cursor.beforeSeq === undefined ? { nextBeforeSeq: 10 } : {}),
        items: [{ t: 'ev.message_delta', messageId: 'm', sessionId, delta: 'private history item', done: true }] };
    },
  };
  host = createHost({ url: ws, hostId: 'host-journey', stateDir: join(dir, 'host'), kernel });
  await host.start();
  await until(() => host.status().state === 'online', 'host claim and authenticated hello');

  function makePhone(storage = memoryStore()) {
    const events = [];
    const client = createClient({ socket: nodeSocket, random, storage, reconnectDelay: 20 });
    client.subscribe((event) => events.push(event));
    t.after(() => client.disconnect());
    return { client, events, storage };
  }
  async function startPairing(client, expectedOffer = true) {
    const qr = await host.issueCode();
    assert.match(qr.token, /^[0-9]{6}$/);
    await client.pair(ws, qr.token);
    const offer = await until(() => client.snapshot().offer, 'SAS offer');
    assert.equal(offer.sas, host.status().sas);
    assert.match(offer.sas, /^[0-9]{6}$/);
    assert.notEqual(client.snapshot().state, 'online');
    if (expectedOffer) {
      assert.equal(client.confirm('another-offer'), false);
      assert.equal(client.confirm(offer.id), true);
      await until(() => client.snapshot().state === 'online', 'pairing confirmed');
    }
    return { qr, offer };
  }
  return { host, ws, traces, tasks, received, kernel, historyQueries, makePhone, startPairing };
}

test('H1/H2/W2: pair, list, choose workspace, execute exactly once, stream, interrupt and archive', async (t) => {
  const rig = await createJourney(t);
  const { client, events } = rig.makePhone();
  await rig.startPairing(client);
  await until(() => client.snapshot().sessions.length === 1, 'list from actual host');
  assert.equal(client.snapshot().sessions[0].id, 'task-main');
  assert.equal(client.snapshot().sessions[0].title, 'project private title');
  await until(() => client.snapshot().limits?.maxTextChars === 100, 'negotiated limits');
  await assert.rejects(client.command('cmd.send_prompt', { sessionId: 'task-main', text: 'x'.repeat(101) }), /100/);
  const fields = { sessionId: 'task-main', text: 'text never visible through relay',
    files: [{ name: 'hello.txt', mediaType: 'text/plain', data: 'aGk=' }] };
  const [one, two] = await Promise.all([
    client.command('cmd.send_prompt', fields, { cmdId: 'same-twice' }),
    client.command('cmd.send_prompt', fields, { cmdId: 'same-twice' }),
  ]);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  const repeated = await client.command('cmd.send_prompt', fields, { cmdId: 'same-twice' });
  assert.equal(repeated.ok, true);
  assert.deepEqual(rig.received, [{ sessionId: 'task-main', text: fields.text,
    attachments: { images: [], files: fields.files } }]);
  assert.equal(events.filter((e) => e.t === 'ev.message_delta').map((e) => e.delta).join(''), '私密回应');
  const built = await client.command('cmd.new_session', { workspace: '/chosen/project' });
  assert.equal(built.data.sessionId, 'task-new');
  await until(() => client.snapshot().sessions.some((s) => s.workspace === '/chosen/project'), 'session uses chosen path');
  assert.match((await client.command('cmd.archive_session', { sessionId: 'task-main' })).message, /正在运行/);
  assert.equal((await client.command('cmd.archive_session', { sessionId: 'task-new', archived: true })).ok, true);
  await until(() => client.snapshot().sessions.some((s) => s.id === 'task-new' && s.state === 'archived'), 'archive state');
  assert.equal((await client.command('cmd.interrupt', { sessionId: 'task-main' })).ok, true);
  assert.deepEqual(rig.received[1], { interrupt: 'task-main' });
  const trace = JSON.stringify(rig.traces);
  assert.ok(rig.traces.some((f) => f.t === 'enc'));
  for (const body of [fields.text, 'project private title', '私密', '回应', '/chosen/project', 'hello.txt']) {
    assert.equal(trace.includes(body), false, body);
  }
});

test('H3/R3: disconnected phone returns to pending cards and a decision closes the exact request', async (t) => {
  const rig = await createJourney(t);
  const { client, storage, events } = rig.makePhone();
  await rig.startPairing(client);
  await until(() => client.snapshot().sessions.length, 'last known list');
  client.disconnect();
  assert.equal(client.snapshot().sessions[0].id, 'task-main');
  const permission = rig.host.requestDecision({ kind: 'permission', sessionId: 'task-main', requestId: 'approval',
    action: 'Confirm tools', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] });
  await client.connect(rig.ws);
  await until(() => client.snapshot().pending.some((e) => e.requestId === 'approval'), 'unanswered card after reconnect');
  assert.equal(events.find((e) => e.requestId === 'approval').expiresAt, undefined);
  await until(() => client.snapshot().state === 'online', 'host confirms it can take decisions');
  assert.equal((await client.command('cmd.resolve_permission', { sessionId: 'wrong', requestId: 'approval', decision: 'approve' })).ok, false);
  assert.equal((await client.command('cmd.resolve_permission', { sessionId: 'task-main', requestId: 'approval', decision: 'approve' })).ok, true);
  assert.equal(await permission, 'approve');
  await until(() => !client.snapshot().pending.length, 'card closes');
  client.disconnect();

  const question = rig.host.requestDecision({ kind: 'question', sessionId: 'task-main', requestId: 'question',
    questions: [{ id: 'q1', question: 'Which option?' }] });
  const reopened = rig.makePhone(storage).client;
  await reopened.connect(rig.ws);
  await until(() => reopened.snapshot().pending.some((e) => e.requestId === 'question'), 'persisted pairing and second card');
  await until(() => reopened.snapshot().state === 'online', 'restored phone is connected');
  assert.equal(rig.host.resolveDesktop('task-main', 'question', 'question'), true);
  assert.equal(await question, null);
  await until(() => !reopened.snapshot().pending.length, 'desktop decision voids phone card');
  assert.equal((await reopened.command('cmd.answer', { sessionId: 'task-main', requestId: 'question',
    answers: [{ questionId: 'q1', selected: [], freeText: 'late' }] })).ok, false);
  await reopened.unpair();
  assert.equal(reopened.snapshot().state, 'unpaired');
  await until(() => rig.host.status().paired === 0, 'unpaired on host');
});

test('H4: history uses host cursors for earlier pages and explicit fallback outside the delta window', async (t) => {
  const rig = await createJourney(t);
  const { client } = rig.makePhone();
  await rig.startPairing(client);
  const latest = await client.history('task-main');
  assert.equal(latest.nextBeforeSeq, 10);
  assert.equal(latest.latestSeq, 15);
  const older = await client.history('task-main', { beforeSeq: latest.nextBeforeSeq });
  assert.equal(older.nextBeforeSeq, undefined);
  const recovered = await client.history('task-main', { since: 99 });
  assert.equal(recovered.latestSeq, 15);
  assert.deepEqual(rig.historyQueries.map((q) => [q.beforeSeq, q.since]),
    [[undefined, undefined], [10, undefined], [undefined, 99], [undefined, undefined]]);
});

test('P1/R3: consumed code is rejected before socket open and host outage preserves the last known list', async (t) => {
  const rig = await createJourney(t);
  const { client } = rig.makePhone();
  const { qr } = await rig.startPairing(client);
  await until(() => client.snapshot().sessions.length, 'list before outage');
  const claims = rig.traces.filter((f) => f.t === 'pair-begin-client').length;
  await assert.rejects(client.pair(rig.ws, qr.token), /失效/);
  assert.equal(rig.traces.filter((f) => f.t === 'pair-begin-client').length, claims);
  await rig.host.stop();
  await until(() => client.snapshot().state === 'host-offline', 'host disconnect surfaced');
  assert.equal(client.snapshot().sessions[0].id, 'task-main');
  await assert.rejects(client.command('cmd.interrupt', { sessionId: 'task-main' }), /离线/);
});
