'use strict';

const name = typeof __DRC_PLUGIN_NAME__ === 'string' ? __DRC_PLUGIN_NAME__ : '@dsh-remote/plugin';
const inject = ['slots'];
const prefix = '/plugins/dsh-remote-control';

function endpoint(path) {
  return new URL(prefix + path, globalThis.__DSH_TRANSPORT__?.streamBaseUrl || document.baseURI).toString();
}

async function request(path, body) {
  const result = await fetch(endpoint(path), {
    method: body ? 'POST' : 'GET', headers: { 'x-drc-pair': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  if (!result.ok) {
    const error = await result.json().catch(() => ({}));
    throw new Error(error.error || '电脑端无法处理请求');
  }
  return path.endsWith('.png') ? result.blob() : result.json();
}

const style = [
  '.drc06-link{appearance:none;display:inline-flex;align-items:center;border:0;border-radius:999px;padding:2px 7px;color:var(--dsw-alias-label-secondary,inherit);background:transparent;cursor:pointer;font:inherit;font-size:12px;line-height:18px;white-space:nowrap}',
  '.drc06-link:hover,.drc06-link[aria-expanded="true"]{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,#8080801a)}',
  '.drc06-link:focus-visible,.drc06-panel button:focus-visible,.drc06-panel input:focus-visible{outline:2px solid var(--dsw-alias-border-selected,#2f4bd6);outline-offset:2px}',
  '.drc06-panel{color:var(--dsw-alias-label-secondary,#161928);background:var(--dsw-specific-menu,#eff2f7);backdrop-filter:var(--dsw-menu-backdrop-filter,none);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,#dfe5ef);border:0;border-radius:var(--dsw-radius-lg,16px);box-shadow:var(--dsw-elevation-prominent,0 12px 32px #16192824);padding:16px;min-width:275px;max-width:380px;box-sizing:border-box;font-size:13px;line-height:18px}',
  '.drc06-panel h2{color:var(--dsw-alias-label-primary,#161928);font-size:15px;font-weight:500;margin:0 0 10px;padding-right:30px}.drc06-panel p{margin:8px 0;line-height:1.5}',
  '.drc06-panel .close{position:absolute;top:10px;right:10px;width:26px;height:26px;min-height:0;padding:0;display:grid;place-items:center;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:13px;line-height:1}',
  '.drc06-panel .close:hover{background:var(--dsw-alias-interactive-bg-hover,#8080801a);color:var(--dsw-alias-label-primary,#161928)}',
  '.drc06-panel .link{background:var(--dsw-alias-bg-layer-2,#e5ebf5);color:var(--dsw-alias-label-primary,#161928);border-left:4px solid var(--dsw-alias-border-selected,#2f4bd6);border-radius:10px;padding:10px;font-weight:650}',
  '.drc06-panel button{border:.5px solid var(--dsw-alias-border-l2,#b7ced2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#161928);padding:7px 11px;font:inherit;cursor:pointer;min-height:34px}',
  '.drc06-panel button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#e5ebf5)}',
  '.drc06-panel button.primary{background:var(--dsw-alias-button-elevated-fill,#2f4bd6);color:var(--dsw-alias-button-elevated-text,#fff);border-color:transparent}.drc06-panel button:disabled{opacity:.5;cursor:wait}',
  '.drc06-panel .actions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}',
  '.drc06-panel label{display:block;margin:10px 0 5px;font-size:12px;font-weight:650;color:var(--dsw-alias-label-secondary,#161928)}',
  '.drc06-panel input{display:block;width:100%;padding:8px 9px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2,#cbd3e3);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#161928);font:inherit}',
  '.drc06-panel .digits{font:700 24px system-ui;letter-spacing:.14em;font-variant-numeric:tabular-nums;text-align:center;color:var(--dsw-alias-label-primary,#2f4bd6)}',
  '.drc06-panel img{width:146px;height:146px;display:block;margin:10px auto;border-radius:9px;background:#fff}',
  '.drc06-panel .error{color:var(--dsw-alias-state-error-primary,#a62f45)}.drc06-panel details{margin-top:12px}.drc06-panel summary{cursor:pointer}',
  '.drc06-panel summary,.drc06-panel h2{color:var(--dsw-alias-label-primary,#161928)}',
  'dialog.drc06-panel{position:fixed;inset:auto 18px 65px auto;max-width:calc(100vw - 36px);margin:0;z-index:10000}',
  '.drc06-panel::backdrop{background:var(--dsw-alias-bg-mask-1,#16192844)}',
].join('');

function mount(container, inline) {
  if (!document.getElementById('drc06-css')) {
    const css = document.createElement('style');
    css.id = 'drc06-css';
    css.textContent = style;
    document.head.append(css);
  }
  const el = (tag, text, className) => {
    const value = document.createElement(tag);
    if (tag === 'button') value.type = 'button';
    if (text) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  const panel = el(inline ? 'section' : 'dialog', '', 'drc06-panel');
  const label = el('h2', '远程控制');
  const link = el('p', '正在读取连接', 'link');
  link.setAttribute('aria-live', 'polite');
  const wait = el('p', '');
  const error = el('p', '', 'error');
  error.setAttribute('role', 'status');
  const pair = el('button', '生成配对码', 'primary');
  const reset = el('button', '解除配对');
  const toolbar = el('div', '', 'actions');
  const figure = el('div');
  const qr = el('img');
  qr.alt = '微信小程序配对码';
  qr.hidden = true;
  qr.style.display = 'none';
  const check = el('p', '', 'digits');
  const advanced = el('details');
  const url = el('input');
  const token = el('input');
  token.type = 'password';
  token.placeholder = '可选，留空保留原值';
  const urlLabel = el('label', '中继地址');
  urlLabel.append(url);
  const tokenLabel = el('label', '主机令牌');
  tokenLabel.append(token);
  const save = el('button', '保存连接设置', 'primary');
  const clearToken = el('button', '使用自动认领令牌');
  const settingsActions = el('div', '', 'actions');
  settingsActions.append(save, clearToken);
  advanced.append(el('summary', '连接设置'), urlLabel, tokenLabel, settingsActions);
  toolbar.append(pair, reset);
  if (!inline) {
    const close = el('button', '✕', 'close');
    close.setAttribute('aria-label', '关闭');
    close.onclick = () => panel.close();
    panel.append(close);
  }
  figure.append(qr, check);
  panel.append(label, link, wait, toolbar, figure, error, advanced);
  let objectUrl;
  let previousUrl;
  let expiry = 0;
  let inactive = false;
  let online = false;
  let refreshing = false;
  let activeButton;
  let actionVersion = 0;
  let detach = () => {};

  function syncControls() {
    const busy = !!activeButton;
    pair.disabled = busy || !online;
    pair.textContent = activeButton === pair ? '正在生成…' : '生成配对码';
    for (const button of [reset, save, clearToken]) button.disabled = busy;
  }

  function paint(state) {
    if (inactive) return;
    const serverUrl = state.serverUrl || '';
    online = state.state === 'online';
    const titles = { online: state.onlinePhones ? '手机已连接' : state.paired ? '手机暂时离线' : '电脑已上线，等待配对',
      connecting: '正在连接中继', offline: '电脑未连上中继' };
    link.textContent = titles[state.state] || '连接状态未知';
    wait.textContent = state.relayProblem || (state.waiting ? '有 ' + state.waiting + ' 项任务等待处理' : '');
    reset.hidden = !state.paired;
    if (url.value === '' || url.value === previousUrl) url.value = serverUrl;
    if (objectUrl && (!online || serverUrl !== previousUrl)) clearCode();
    previousUrl = serverUrl;
    url.disabled = state.serverLocked === true;
    check.textContent = state.sas ? '核对码 ' + state.sas : '';
    syncControls();
  }

  function clearCode() {
    expiry = 0;
    qr.hidden = true;
    qr.style.display = 'none';
    qr.removeAttribute('src');
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  async function update() {
    if (inactive || (!inline && !panel.open)) return;
    if (expiry && Date.now() >= expiry) clearCode();
    if (refreshing || activeButton) return;
    refreshing = true;
    const version = actionVersion;
    try {
      const state = await request('/status');
      if (version === actionVersion) paint(state);
    } catch (issue) {
      if (!inactive && version === actionVersion) {
        online = false;
        link.textContent = '暂时无法读取连接';
        wait.textContent = issue.message;
        syncControls();
      }
    } finally { refreshing = false; }
  }

  async function action(button, run) {
    if (inactive || activeButton || button.disabled) return;
    activeButton = button;
    actionVersion += 1;
    syncControls();
    error.textContent = '';
    try { await run(); }
    catch (issue) { if (!inactive) error.textContent = issue.message; }
    finally {
      activeButton = undefined;
      if (!inactive) {
        syncControls();
        await update();
      }
    }
  }

  pair.onclick = () => action(pair, async () => {
    clearCode();
    const { expiresAt } = await request('/pairing/new', {});
    if (inactive) return;
    const image = await request('/pairing.png').catch(() => {
      throw new Error('暂时无法生成微信码，请检查中继的小程序配置后重试。');
    });
    if (inactive) return;
    if (expiresAt <= Date.now()) throw new Error('配对码已过期，请重新生成');
    expiry = expiresAt;
    objectUrl = URL.createObjectURL(image);
    qr.src = objectUrl;
    qr.style.display = 'block';
    qr.hidden = false;
  });
  reset.onclick = () => {
    if (!reset.disabled && confirm('解除手机与这台电脑的配对？')) void action(reset, async () => {
      await request('/unpair', {});
      clearCode();
    });
  };
  async function saveConfig(settings) {
    const state = await request('/config', settings);
    clearCode();
    paint(state);
  }

  save.onclick = () => action(save, async () => {
    const hostToken = token.value;
    await saveConfig({ ...(url.disabled ? {} : { serverUrl: url.value }), hostToken });
    if (token.value === hostToken) token.value = '';
  });
  clearToken.onclick = () => action(clearToken, () => saveConfig({ clearHostToken: true }));
  if (inline) container.append(panel);
  else {
    const open = el('button', '远程控制', 'drc06-link');
    open.setAttribute('aria-haspopup', 'dialog');
    open.setAttribute('aria-expanded', 'false');
    const outside = (event) => {
      if (!panel.open) return;
      if (panel.contains(event.target) || open.contains(event.target)) return;
      toggle(false);
    };
    const syncOpen = () => {
      open.setAttribute('aria-expanded', String(panel.open));
      if (panel.open) document.addEventListener('pointerdown', outside, true);
      else document.removeEventListener('pointerdown', outside, true);
    };
    const toggle = (next) => {
      if (next) panel.show();
      else if (panel.open) panel.close();
      syncOpen();
      if (panel.open) void update();
    };
    panel.addEventListener('close', syncOpen);
    panel.onkeydown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      toggle(false);
      open.focus();
    };
    open.onclick = () => toggle(!panel.open);
    container.append(open, panel);
    detach = () => {
      panel.removeEventListener('close', syncOpen);
      toggle(false);
    };
  }
  syncControls();
  void update();
  const timer = setInterval(update, 1500);
  return () => {
    inactive = true;
    clearInterval(timer);
    clearCode();
    detach();
    container.replaceChildren();
  };
}

function apply(ctx) {
  try {
    const moduleName = 'react';
    const react = require(moduleName);
    const slots = ctx.slots;
    for (const [slot, inline] of [['conversation.composer.dock', false], ['settings.section', true]]) {
      const attach = (container) => {
        if (!container) {
          cleanup?.();
          cleanup = undefined;
        } else if (!cleanup) cleanup = mount(container, inline);
      };
      let cleanup;
      slots.inject(slot, () => slots.register({ name: slot, id: 'drc06-' + slot, order: 30,
        ...(inline ? { label: () => '远程控制' } : { inject: () => ({}) }) }, () => react.createElement('div', { ref: attach })));
    }
  } catch (error) { console.warn('[drc-v06] remote-control UI unavailable', error.message); }
}

module.exports = { name, inject, apply };
