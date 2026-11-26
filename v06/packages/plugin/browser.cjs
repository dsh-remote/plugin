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
  '.drc06-link{border:1px solid #cbd3e3;border-radius:8px;padding:6px 11px;color:inherit;background:transparent;cursor:pointer;font:inherit}',
  '.drc06-link:focus-visible,.drc06-panel button:focus-visible,.drc06-panel input:focus-visible{outline:2px solid #2f4bd6;outline-offset:2px}',
  '.drc06-panel{color:#161928;background:#eff2f7;border:1px solid #dfe5ef;border-radius:16px;padding:18px;min-width:275px;max-width:380px;box-sizing:border-box;font:14px system-ui,sans-serif}',
  '.drc06-panel h2{font-size:20px;margin:0 0 12px}.drc06-panel p{margin:8px 0;line-height:1.5}',
  '.drc06-panel .link{background:#e5ebf5;color:#161928;border-left:5px solid #2f4bd6;border-radius:10px;padding:11px;font-weight:650}',
  '.drc06-panel button{border:1px solid #b7ced2;border-radius:8px;background:#fff;color:#161928;padding:7px 11px;font:inherit;cursor:pointer;min-height:34px}',
  '.drc06-panel button.primary{background:#2f4bd6;color:#fff;border-color:#2f4bd6}.drc06-panel button:disabled{opacity:.5;cursor:wait}',
  '.drc06-panel .actions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}',
  '.drc06-panel label{display:block;margin:10px 0 5px;font-size:13px;font-weight:650}',
  '.drc06-panel input{display:block;width:100%;padding:8px 9px;box-sizing:border-box;border:1px solid #cbd3e3;border-radius:8px;font:inherit}',
  '.drc06-panel .digits{font:700 24px system-ui;letter-spacing:.14em;font-variant-numeric:tabular-nums;text-align:center;color:#2f4bd6}',
  '.drc06-panel img{width:146px;height:146px;display:block;margin:10px auto;border-radius:9px;background:#fff}',
  '.drc06-panel .error{color:#a62f45}.drc06-panel details{margin-top:12px}.drc06-panel summary{cursor:pointer}',
  'dialog.drc06-panel{position:fixed;inset:auto 18px 65px auto;max-width:calc(100vw - 36px);margin:0;z-index:10000;box-shadow:0 12px 32px #16192824}',
  '.drc06-panel::backdrop{background:#16192844}',
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
    const close = el('button', '关闭');
    close.onclick = () => panel.close();
    toolbar.append(close);
  }
  figure.append(qr, check);
  panel.append(label, link, wait, toolbar, figure, error, advanced);
  let objectUrl;
  let previousUrl;
  let expiry = 0;
  let inactive = false;
  let refreshing = false;

  function paint(state) {
    if (inactive) return;
    const titles = { online: state.onlinePhones ? '手机已连接' : state.paired ? '手机暂时离线' : '电脑已上线，等待配对',
      connecting: '正在连接中继', offline: '电脑未连上中继' };
    link.textContent = titles[state.state] || '连接状态未知';
    wait.textContent = state.relayProblem || (state.waiting ? '有 ' + state.waiting + ' 项任务等待处理' : '');
    pair.disabled = state.state !== 'online';
    reset.hidden = !state.paired;
    if (url.value === '' || url.value === previousUrl) url.value = state.serverUrl || '';
    previousUrl = state.serverUrl || '';
    url.disabled = state.serverLocked === true;
    check.textContent = state.sas ? '核对码 ' + state.sas : '';
    if (expiry && Date.now() >= expiry) clearCode();
  }

  function clearCode() {
    expiry = 0;
    qr.style.display = 'none';
    qr.removeAttribute('src');
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  async function update() {
    if (inactive || refreshing || (!inline && !panel.open)) return;
    refreshing = true;
    try { paint(await request('/status')); }
    catch (issue) { if (!inactive) error.textContent = issue.message; }
    finally { refreshing = false; }
  }

  async function action(button, run) {
    button.disabled = true;
    error.textContent = '';
    try { await run(); }
    catch (issue) { error.textContent = issue.message; }
    finally { button.disabled = false; await update(); }
  }

  pair.onclick = () => action(pair, async () => {
    clearCode();
    const ready = await request('/pairing/new', {});
    expiry = ready.expiresAt;
    try {
      objectUrl = URL.createObjectURL(await request('/pairing.png'));
      qr.src = objectUrl;
      qr.style.display = 'block';
      qr.hidden = false;
    } catch { error.textContent = '暂时无法生成微信码，请检查中继的小程序配置后重试。'; }
  });
  reset.onclick = () => {
    if (confirm('解除手机与这台电脑的配对？')) void action(reset, async () => {
      await request('/unpair', {});
      clearCode();
    });
  };
  save.onclick = () => action(save, async () => {
    await request('/config', { ...(url.disabled ? {} : { serverUrl: url.value }), hostToken: token.value });
    token.value = '';
    clearCode();
  });
  clearToken.onclick = () => action(clearToken, () => request('/config', { clearHostToken: true }));
  if (inline) container.append(panel);
  else {
    const open = el('button', '远程控制', 'drc06-link');
    open.onclick = () => { panel.showModal(); void update(); };
    container.append(open, panel);
  }
  void update();
  const timer = setInterval(update, 1500);
  return () => {
    inactive = true;
    clearInterval(timer);
    clearCode();
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
