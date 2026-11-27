const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTokenRecovery } = require('../packages/plugin/token-recovery.cjs');
const { fakeTimers } = require('./support.cjs');

test('R2: 5 fast attempts, a full ten-minute quiet period, a real success, and a reset after hello-ok', async () => {
  const clock = fakeTimers();
  const calls = [];
  const activated = [];
  const recovery = createTokenRecovery({
    clock,
    claim: async () => {
      calls.push(clock.now());
      return calls.length === 6 ? 'new-usable-token' : null;
    },
    activate: (token) => activated.push(token),
  });
  recovery.rejected();
  recovery.rejected();
  await clock.step(239999);
  assert.deepEqual(calls, [0, 60000, 120000, 180000]);
  await clock.step(1);
  assert.deepEqual(calls, [0, 60000, 120000, 180000, 240000]);
  assert.equal(recovery.status().mode, 'slow');
  await clock.step(599999);
  recovery.rejected();
  await clock.step(0);
  assert.equal(calls.length, 5);
  await clock.step(1);
  assert.deepEqual(calls, [0, 60000, 120000, 180000, 240000, 840000]);
  assert.deepEqual(activated, ['new-usable-token']);
  recovery.online();
  assert.deepEqual(recovery.status(), { mode: 'idle', attempts: 0 });
  recovery.rejected();
  await clock.step(0);
  assert.equal(calls.length, 7);
  assert.equal(recovery.status().attempts, 1);
  recovery.stop();
  await clock.step(600000);
  assert.equal(calls.length, 7);
});

test('R2: stopping during an in-flight claim never installs a token into a disposed host', async () => {
  let finish;
  const activated = [];
  const clock = fakeTimers();
  const recovery = createTokenRecovery({
    clock,
    claim: () => new Promise((resolve) => { finish = resolve; }),
    activate: (token) => activated.push(token),
  });
  recovery.rejected();
  const advance = clock.step(0);
  recovery.stop();
  finish('racing-token');
  await advance;
  assert.deepEqual(activated, []);
});
