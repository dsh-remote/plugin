'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createRelay } = require('../packages/relay/index.cjs');
const { createHost } = require('../packages/plugin/host.cjs');

async function until(check, label) {
  for (let i = 0; i < 60; i += 1) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  assert.fail(label);
}

async function main() {
  const auto = require(process.env.DRC_WX_AUTOMATOR || 'miniprogram-automator');
  const port = process.env.DRC_WX_AUTOMATION_URL || 'ws://127.0.0.1:9426';
  const trace = [];
  const relay = createRelay({ masterToken: randomBytes(32).toString('hex'), observe: (frame) => trace.push(frame) });
  const path = await mkdtemp(join(tmpdir(), 'drc-wx-v06-'));
  let host, program;
  let ownsPair = false;
  try {
    const { ws } = await relay.start();
    let events;
    let received = '';
    host = createHost({
      hostId: 'sim-test-host', url: ws, stateDir: path, kernel: {
        subscribe(fn) { events = fn; return () => {}; },
        listSessions() { return [{ id: 'sim-task', title: '回环配对验证', workspace: '/example/simulator' }]; },
        history() { return { items: [], latestSeq: 0 }; },
        sendPrompt(sessionId, text) {
          received = text;
          events({ t: 'ev.message_delta', sessionId, messageId: 'result-1', role: 'assistant', delta: '已收到回环指令', done: true });
        },
      },
    });
    await host.start();
    await until(() => host.status().state === 'online', 'local Harness test port did not connect');
    program = await auto.connect({ wsEndpoint: port });
    const page = await program.reLaunch('/pages/sessions/index');
    assert.equal(await page.data('paired'), false, 'use a separate test project with no saved pairing');
    await program.evaluate((url) => {
      const app = getApp();
      app.settings.url = url;
      app.testOffers = [];
      app.testOff = app.client.subscribe((event) => {
        if (event.t === 'state' && event.offer && !app.testOffers.some((offer) => offer.id === event.offer.id)) {
          app.testOffers.push(event.offer);
        }
      });
    }, ws);
    ownsPair = true;
    const { token } = await host.issueCode();
    await program.mockWxMethod('scanCode', { path: 'pages/sessions/index?scene=' + token, result: '' });
    const scan = await page.$('.scan');
    assert.ok(scan, 'scan entry missing');
    await program.mockWxMethod('showModal', { confirm: false, cancel: true });
    await scan.tap();
    const beforeReject = await until(() => program.evaluate(() => getApp().testOffers[0]), 'scan did not reach the key handoff');
    assert.match(beforeReject.sas, /^\d{6}$/);
    await until(async () => (await page.data('linkState')) === 'unpaired', 'rejected SAS must end the attempt');
    assert.equal(await page.data('paired'), false);
    assert.equal(trace.filter((frame) => frame.t === 'pair-begin-client').length, 1);
    const next = await host.issueCode();
    await program.mockWxMethod('scanCode', { path: 'pages/sessions/index?scene=' + next.token, result: '' });
    await program.mockWxMethod('showModal', { confirm: true, cancel: false });
    await scan.tap();
    const offer = await until(() => program.evaluate(() => getApp().testOffers[1]), 'phone did not expose the pending SAS');
    assert.equal(offer.sas, host.status().sas);

    await until(async () => (await page.data('groups')).length === 1, 'confirmed phone did not receive real session list');
    assert.equal(host.status().onlinePhones, 1);
    const result = await program.evaluate(() => getApp().client.command('cmd.send_prompt', {
      sessionId: 'sim-task', text: '模拟器回环指令',
    }));
    assert.equal(result.ok, true);
    assert.equal(received, '模拟器回环指令');
    assert.equal(JSON.stringify(trace).includes(received), false, 'relay saw unencrypted content');
    console.log('模拟器已通过：扫码回调、SAS 拒绝和确认、实际回环中继、会话清单和加密指令。');
  } finally {
    if (program) {
      await program.restoreWxMethod('scanCode').catch(() => {});
      await program.restoreWxMethod('showModal').catch(() => {});
      await program.evaluate(() => getApp().testOff?.()).catch(() => {});
      if (ownsPair) await program.evaluate(() => getApp().client.unpair()).catch(() => {});
      program.disconnect();
    }
    await host?.stop();
    await relay.close();
    await rm(path, { recursive: true, force: true });
  }
}

const deadline = setTimeout(() => process.exit(3), 30000);
void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(deadline));
