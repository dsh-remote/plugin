'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { runInNewContext } = require('node:vm');

// 判据扫源码前先剥注释（2026-10-08 的纪律：注释里的词不算实现）。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function browserHarness(src, overrides = {}) {
  function createElement(tag) {
    return Object.assign(new EventTarget(), {
      tag, children: [], attributes: new Map(), style: {}, open: false, value: '', disabled: false,
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; },
      contains(target) { return this === target || this.children.some((child) => child.contains(target)); },
      setAttribute(key, value) { this.attributes.set(key, value); },
      removeAttribute(key) { this.attributes.delete(key); },
      show() { this.open = true; },
      close() { this.open = false; },
      focus() { this.focused = true; },
    });
  }
  const listeners = new Map();
  const document = {
    baseURI: 'http://localhost/', head: createElement(), createElement,
    getElementById(id) { return this.head.children.find((element) => element.id === id); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  const container = createElement();
  let poll;
  const mount = runInNewContext(src + '\nmount', {
    module: {}, document, URL, AbortSignal, fetch: async () => Response.json({ state: 'online' }),
    setInterval(callback) { poll = callback; return 1; }, clearInterval() {}, ...overrides,
  });
  return { container, listeners, mount, poll: () => poll() };
}

test('UI: the pill opens, closes, and detaches its dialog across composer mounts', async () => {
  const src = await readFile('packages/plugin/browser.cjs', 'utf8');
  const { container, listeners, mount } = browserHarness(src);
  const detach = mount(container, false);
  const [pill, dialog] = container.children;
  pill.onclick();
  assert.equal(dialog.open, true);
  assert.equal(pill.attributes.get('aria-expanded'), 'true');
  pill.onclick();
  assert.equal(dialog.open, false);
  assert.equal(listeners.has('pointerdown'), false);

  pill.onclick();
  dialog.dispatchEvent(new Event('close'));
  assert.equal(dialog.open, true, 'a delayed close event must preserve a reopened dialog');
  listeners.get('pointerdown')({ target: dialog.children[0] });
  assert.equal(dialog.open, true);
  listeners.get('pointerdown')({ target: container });
  assert.equal(dialog.open, false);
  assert.equal(pill.attributes.get('aria-expanded'), 'false');

  pill.onclick();
  const escape = new Event('keydown', { cancelable: true });
  Object.defineProperty(escape, 'key', { value: 'Escape' });
  dialog.onkeydown(escape);
  assert.equal(dialog.open, false);
  assert.equal(pill.focused, true);

  pill.onclick();
  detach();
  assert.equal(dialog.open, false);
  assert.equal(listeners.size, 0);
  assert.deepEqual(container.children, []);
  const detachAgain = mount(container, false);
  container.children[0].onclick();
  assert.equal(container.children[1].open, true);
  detachAgain();
});

test('UI: status polling preserves the pairing action and a settings change clears the old code', async () => {
  const src = await readFile('packages/plugin/browser.cjs', 'utf8');
  const requests = [];
  const revoked = [];
  const state = { state: 'online', serverUrl: 'wss://relay.example/v06', paired: 1 };
  let finishStatus, finishImage;
  const image = new Promise((resolve) => { finishImage = resolve; });
  let status;
  class ImageURL extends URL {
    static createObjectURL() { return 'blob:pairing-code'; }
    static revokeObjectURL(value) { revoked.push(value); }
  }
  const { container, mount, poll } = browserHarness(src, {
    URL: ImageURL,
    async fetch(url) {
      const path = new URL(url).pathname.slice('/plugins/dsh-remote-control'.length);
      requests.push(path);
      if (path === '/status') return status || Response.json(state);
      if (path === '/pairing/new') return Response.json({ expiresAt: Date.now() + 60000 });
      if (path === '/pairing.png') return image;
      assert.equal(path, '/config');
      return Response.json(state);
    },
  });
  const detach = mount(container, true);
  try {
    const panel = container.children[0];
    const toolbar = panel.children.find((node) => node.className === 'actions');
    const [pair, reset] = toolbar.children;
    const settings = panel.children.find((node) => node.tag === 'details');
    const [, clearToken] = settings.children.find((node) => node.className === 'actions').children;
    const qr = panel.children.find((node) => node.tag === 'div' && node.children[0]?.tag === 'img').children[0];
    await new Promise(setImmediate);
    assert.equal(pair.disabled, false);

    status = new Promise((resolve) => { finishStatus = resolve; });
    const olderStatus = poll();
    const generating = pair.onclick();
    status = undefined;
    finishStatus(Response.json(state));
    await olderStatus;

    assert.equal(pair.disabled, true);
    assert.equal(pair.textContent, '正在生成…');
    assert.equal(reset.disabled, true);
    assert.equal(clearToken.disabled, true);
    await pair.onclick();
    await clearToken.onclick();
    assert.equal(requests.filter((path) => path === '/pairing/new').length, 1);
    assert.equal(requests.includes('/config'), false);

    finishImage(new Response(new Blob(['image']), { headers: { 'content-type': 'image/png' } }));
    await generating;
    assert.equal(qr.hidden, false);
    assert.equal(pair.disabled, false);
    await clearToken.onclick();
    assert.equal(qr.hidden, true);
    assert.deepEqual(revoked, ['blob:pairing-code']);
  } finally { detach(); }
});

test('UI: the close control is a compact ✕ pinned to the panel top-right', async () => {
  const src = stripComments(await readFile('packages/plugin/browser.cjs', 'utf8'));
  assert.match(src, /el\('button', '✕', 'close'\)/, '关闭键用 ✕ 图标，不再混在工具条文字按钮里');
  assert.match(src, /setAttribute\('aria-label', '关闭'\)/, '图标键必须有可读标签');
  const closeRule = src.match(/'\.drc06-panel \.close\{[^']*'/);
  assert.ok(closeRule, '关闭键样式必须是一条独立规则');
  assert.match(closeRule[0], /position:absolute;top:10px;right:10px/, '钉在面板右上角');
  assert.match(closeRule[0], /width:26px;height:26px;min-height:0/, '紧凑尺寸，不吃工具条按钮的 34px 下限');
  assert.doesNotMatch(src, /toolbar\.append\(close\)/, '旧的“关闭”文字键不能留在工具条里');
});

test('UI: the popover paints with native DSW tokens, not hardcoded light-theme colors', async () => {
  const src = stripComments(await readFile('packages/plugin/browser.cjs', 'utf8'));
  const panelRule = src.match(/'\.drc06-panel\{[^']*'/);
  assert.ok(panelRule, '面板样式必须还是单条 .drc06-panel 规则');
  for (const token of ['--dsw-specific-menu', '--dsw-elevation-prominent', '--dsw-alias-border-l1',
    '--dsw-menu-backdrop-filter', '--dsw-radius-lg', '--dsw-alias-label-secondary']) {
    assert.match(panelRule[0], new RegExp('var\\(' + token.replace(/-/g, '\\-')), '面板缺原生令牌：' + token);
  }
  assert.match(src, /--dsw-alias-state-error-primary/, '错误色必须走原生令牌，深浅主题都要站得住');
  assert.match(src, /--dsw-alias-label-primary/, '标题与状态行用主文字令牌');
  assert.doesNotMatch(panelRule[0], /background:#eff2f7[^)]*$/, '底色不能退回硬编码浅色');
});
