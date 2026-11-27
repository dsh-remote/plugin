const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tempDir } = require('./support.cjs');

test('O1/U2: isolated distribution builds, starts the standalone relay and registers real mini-program pages', async (t) => {
  const out = await tempDir(t);
  const build = spawnSync(process.execPath, ['scripts/build.cjs', '--out', out], { encoding: 'utf8', timeout: 15000 });
  assert.equal(build.status, 0, build.stderr);
  const bundle = await readFile(join(out, 'relay', 'main.cjs'), 'utf8');
  assert.doesNotMatch(bundle, /secretbox|nacl-fast|tweetnacl/);
  const version = spawnSync(process.execPath, [join(out, 'relay', 'main.cjs'), '--version'], { encoding: 'utf8', timeout: 4000 });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '0.6.0');
  const plugin = require(join(out, 'plugin', 'index.cjs'));
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(plugin.name, '@dsh-remote/plugin');
  const mp = join(out, 'miniprogram');
  const config = JSON.parse(await readFile(join(mp, 'app.json'), 'utf8'));
  assert.deepEqual(config.pages, ['pages/sessions/index', 'pages/chat/index', 'pages/reward/index']);
  let app;
  const pages = [];
  globalThis.App = (options) => { app = options; };
  globalThis.Page = (options) => pages.push(options);
  globalThis.getApp = () => app;
  let sockets = 0;
  let scan;
  globalThis.wx = { getStorageSync() {}, connectSocket() { sockets += 1; },
    scanCode(handlers) { scan = handlers; } };
  require(join(mp, 'app.js'));
  app.onLaunch({ scene: 1089, query: { scene: '123456' } });
  app.onShow({ scene: 1089, query: { scene: '123456' } });
  const claims = [];
  app.settings.url = 'ws://127.0.0.1:8900';
  app.client.pair = (_url, token) => claims.push(token);
  for (const name of config.pages) require(join(mp, name + '.js'));
  const sessions = { ...pages[0], data: { ...pages[0].data }, setData(patch) { Object.assign(this.data, patch); } };
  sessions.onLoad({ scene: '123456' });
  sessions.onShow();
  assert.equal(sockets, 0, 'resurfacing an old scene must not start pairing');
  assert.deepEqual(claims, []);
  sessions.onScan();
  await scan.success({ path: 'pages/sessions/index?scene=012345', result: '' });
  assert.deepEqual(claims, ['012345'], 'scan success claims directly');
  app.entry = { scene: 1047, query: { scene: '234567' } };
  await sessions.onShow();
  await sessions.onShow();
  assert.deepEqual(claims, ['012345', '234567'], 'new external scan claims once on entry');
  const markup = await readFile(join(mp, 'pages/sessions/index.wxml'), 'utf8');
  assert.doesNotMatch(markup, /onManual|onCode|maxlength="6"/);
  const chatMarkup = await readFile(join(mp, 'pages/chat/index.wxml'), 'utf8');
  assert.match(chatMarkup, /<textarea[^>]+show-confirm-bar="{{false}}"/);
  assert.match(chatMarkup, /<textarea[^>]+adjust-position="{{false}}"[^>]+bindkeyboardheightchange="onComposerKeyboard"/);
  const chat = { ...pages[1], data: { ...pages[1].data }, setData(patch) { Object.assign(this.data, patch); } };
  chat.onLoad({ id: 's1' });
  chat.onComposerKeyboard({ detail: { height: 292 } });
  assert.equal(chat.data.keyboardHeight, 292);
  chat.onComposerBlur();
  assert.equal(chat.data.keyboardHeight, 0);
  chat.accept({ t: 'ev.tool_event', callId: 'call', phase: 'started', tool: 'bash', argsPreview: 'npm test' });
  chat.accept({ t: 'ev.tool_event', callId: 'call', phase: 'completed', resultPreview: 'All tests passed.' });
  chat.renderTimeline();
  const row = () => chat.data.timeline[0];
  assert.equal(row().title, '执行命令');
  assert.equal(row().expanded, false);
  chat.onToggleTool({ currentTarget: { dataset: { id: row().id } } });
  assert.equal(row().expanded, true);
  assert.equal(row().args, 'npm test');
  assert.equal(row().result, 'All tests passed.');
  chat.accept({ t: 'ev.tool_event', callId: 'call', phase: 'started', tool: 'bash' });
  chat.renderTimeline();
  assert.equal(row().phase, '已完成');
  assert.equal(row().result, 'All tests passed.');
  chat.onToggleTool({ currentTarget: { dataset: { id: row().id } } });
  assert.equal(row().expanded, false);
  chat.onUnload();
  sessions.onHide();
  assert.equal(pages.length, 3);
});

test('O2: WeChat code requests use the independent stable token and expose only the six-digit scene', async () => {
  const { createWechat } = require('../packages/relay/wechat.cjs');
  const reads = [];
  const client = createWechat({
    appId: 'sample-app', secret: 'sample-secret', envVersion: 'trial',
    fetchImpl: async (url, init) => {
      const address = new URL(url);
      reads.push({ path: address.pathname, method: init?.method, query: address.search,
        body: init?.body ? JSON.parse(init.body) : null });
      if (address.pathname === '/cgi-bin/stable_token') return Response.json({ access_token: 'fake', expires_in: 7200 });
      assert.equal(address.pathname, '/wxa/getwxacodeunlimit');
      return new Response(Buffer.from([255, 216, 255, 217]), { headers: { 'content-type': 'image/jpeg' } });
    },
  });
  const image = await client.code('001234');
  await client.code('001235');
  assert.equal(image.contentType, 'image/jpeg');
  assert.deepEqual(reads[0], { path: '/cgi-bin/stable_token', method: 'POST', query: '', body: {
    grant_type: 'client_credential', appid: 'sample-app', secret: 'sample-secret', force_refresh: false,
  } });
  assert.equal(reads.filter((r) => r.path === '/cgi-bin/stable_token').length, 1);
  assert.deepEqual(reads[1].body, { scene: '001234', page: 'pages/sessions/index', check_path: false, env_version: 'trial' });
});
