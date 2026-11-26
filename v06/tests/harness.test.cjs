const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createKernel, wireEvents, participate } = require('../packages/plugin/harness.cjs');

test('H1/H2: current Harness service shapes preserve timestamps and call native commands with requested workspace', async () => {
  const createRequests = [];
  const prompts = [];
  const cancelled = [];
  const attached = [];
  const registry = {
    archivedSessionIds: [],
    create: async (path) => ({ attachSession: (id) => attached.push([path, id]) }),
    list: () => [{ path: '/registry/first' }],
    archiveSession: async (...args) => { throw Object.assign(new Error('busy'), { name: 'WorkspaceActiveSessionError', args }); },
  };
  const services = {
    sessionQuery: {
      listSessions: async () => [{ header: { id: 's1', cwd: '/chosen/project', createdAt: 1000 } }],
      readTitleSnapshots: async () => [{ sessionId: 's1', status: 'fulfilled', value: { title: { title: 'Name', updatedAt: 2000 } } }],
      readSession: async () => ({ events: [{ type: 'user/message', seq: 15,
        data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Actual message' }] } }] }),
    },
    sessionController: { commands: {
      create: async (request) => { createRequests.push(request); return { sessionId: 's2' }; },
      prompt: async (request) => prompts.push(request),
    } },
    agents: { get: () => ({ status: 'idle', cancel: (...args) => cancelled.push(args) }) },
    workspaceRegistry: registry,
  };
  const kernel = createKernel({ get: (name) => services[name] }, { newSessionCwd: '/default/project' });
  assert.deepEqual((await kernel.listSessions()).map((s) => [s.id, s.title, s.updatedAt, s.workspace]),
    [['s1', 'Name', '1970-01-01T00:00:02.000Z', '/chosen/project']]);
  assert.equal(await kernel.newSession('/chosen/project'), 's2');
  assert.equal(createRequests[0].cwd, '/chosen/project');
  assert.deepEqual(attached, [['/chosen/project', 's2']]);
  await kernel.sendPrompt('s1', 'hi', { images: [{ name: 'image.jpg', mediaType: 'image/jpeg', data: '/9j/2Q==' }], files: [] });
  assert.deepEqual(prompts[0].content, [{ type: 'text', text: 'hi' }, { type: 'image', mediaType: 'image/jpeg', data: '/9j/2Q==' }]);
  await kernel.interrupt('s1');
  assert.deepEqual(cancelled, [[{ kind: 'user' }, { keepInbox: true }]]);
  await assert.rejects(kernel.archiveSession('s1', true), /正在运行/);
  assert.equal((await kernel.history('s1', { since: 14 })).items[0].delta, 'Actual message');
});

test('H2: event translation separates human messages, stream updates and tool steps', () => {
  assert.deepEqual(wireEvents('s', { type: 'user/message', seq: 1, data: { source: { kind: 'time-context' }, text: 'internal' } }), []);
  const [model] = wireEvents('s', { type: 'request/header', seq: 2, data: { config: { model: 'deepseek', provider: 'example' } } });
  assert.equal(model.t, 'ev.model');
  assert.equal(model.model, 'deepseek');
  const [tool] = wireEvents('s', { type: 'tool/call', seq: 3, data: { toolCallId: 'call', name: 'read' } });
  assert.equal(tool.callId, 'call');
  assert.equal(tool.phase, 'started');
});

test('H3: real waterfall hook starts desktop concurrently; phone answer aborts only desktop signal', async () => {
  let finishPhone;
  let downstream;
  const request = { agent: { session: { id: 's' } }, toolName: 'file-read', signal: new AbortController().signal };
  const original = request.signal;
  const host = {
    status: () => ({ paired: 1 }),
    requestDecision: () => new Promise((resolve) => { finishPhone = resolve; }),
    resolveDesktop: () => assert.fail('phone won'),
  };
  const result = participate(host, 'permission', request, () => {
    downstream = request.signal;
    return new Promise((resolve) => downstream.addEventListener('abort', () => resolve('unavailable')));
  });
  await Promise.resolve();
  assert.ok(downstream);
  finishPhone('approve-session');
  assert.equal(await result, 'allowed-once');
  assert.equal(downstream.aborted, true);
  assert.equal(original.aborted, false);
});

test('O3: keep-awake acquires once during work and releases after the configured idle period', async () => {
  const { createAwake } = require('../packages/plugin/awake.cjs');
  const { fakeTimers } = require('./support.cjs');
  const clock = fakeTimers();
  const events = [];
  const awake = createAwake({ clock, idleReleaseSec: 20, acquire: () => { events.push('hold'); return () => events.push('release'); } });
  awake.activity(true);
  awake.activity(true);
  awake.activity(false);
  await clock.step(19999);
  assert.deepEqual(events, ['hold']);
  await clock.step(1);
  assert.deepEqual(events, ['hold', 'release']);
  await awake.configure(false);
  awake.activity(true);
  assert.deepEqual(events, ['hold', 'release']);
  awake.dispose();
});

test('H3: question response maps wire choice IDs back to native labeled answers', async () => {
  const host = {
    status: () => ({ paired: 1 }),
    requestDecision: async ({ questions }) => [{ questionId: questions[0].id, selected: [questions[0].options[0].id], freeText: '短说明' }],
    resolveDesktop: () => assert.fail('phone decided'),
  };
  const request = {
    agent: { session: { id: 's' } },
    questions: [{ id: 'feature', question: 'Choose one', options: [{ id: 'a', label: '选项 A' }] }],
  };
  const result = await participate(host, 'question', request, () => new Promise((resolve) => {
    request.signal.addEventListener('abort', () => resolve(undefined));
  }));
  assert.deepEqual(result, { answers: [{ id: 'feature', selected: ['选项 A'], custom: '短说明' }] });
});

test('H3: allow for session remembers the named operation within that session only', async () => {
  const { createRuntime } = require('../packages/plugin/runtime.cjs');
  const cards = [];
  const runtime = createRuntime({ kernel: {}, send() {}, summarize() {}, broadcast: (event) => cards.push(event) });
  try {
    const options = [{ id: 'approve', label: '允许一次' }, { id: 'approve-session', label: '会话内允许' }];
    const initial = runtime.requestDecision({ kind: 'permission', sessionId: 's1', requestId: 'a', action: 'read-file', options });
    await runtime.handle({ t: 'cmd.resolve_permission', cmdId: 'decide', sessionId: 's1', requestId: 'a', decision: 'approve-session' }, 'c');
    assert.equal(await initial, 'approve-session');
    const repeats = runtime.requestDecision({ kind: 'permission', sessionId: 's1', requestId: 'b', action: 'read-file', options });
    assert.equal(cards.some((event) => event.requestId === 'b'), false, 'same session and operation is already allowed');
    assert.equal(await repeats, 'approve-session');
    const distinct = runtime.requestDecision({ kind: 'permission', sessionId: 's2', requestId: 'c', action: 'read-file', options });
    assert.ok(cards.some((event) => event.t === 'ev.permission_request' && event.requestId === 'c'));
    runtime.resolveDesktop('s2', 'c', 'permission');
    assert.equal(await distinct, null);
  } finally { runtime.dispose(); }
});
