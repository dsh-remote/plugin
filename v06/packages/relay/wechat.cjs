'use strict';

const ROOT = 'https://api.weixin.qq.com';

function createWechat({ appId, secret, envVersion = 'release', templateId, fetchImpl = globalThis.fetch, now = Date.now }) {
  if (!appId || !secret) return null;
  const subscribers = new Map();
  const deliveries = new Map();
  let cached;
  let refreshing;

  function endpoint(path, fields) {
    const url = new URL(path, ROOT);
    for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
    return url;
  }

  function http(url, data) {
    const request = { signal: AbortSignal.timeout(10000) };
    if (data) Object.assign(request, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    return fetchImpl(url, request);
  }

  function token() {
    if (cached && cached.expiry > now()) return Promise.resolve(cached.value);
    if (!refreshing) {
      // Stable credentials coexist with the legacy token used by the v05 relay for the same AppID.
      refreshing = http(endpoint('/cgi-bin/stable_token', {}), {
        grant_type: 'client_credential', appid: appId, secret, force_refresh: false,
      })
        .then((res) => res.json())
        .then((answer) => {
          if (typeof answer.access_token !== 'string' || !answer.access_token) throw new Error('WeChat access token request failed');
          cached = { value: answer.access_token, expiry: now() + Math.max(1, Number(answer.expires_in || 7200) - 60) * 1000 };
          return cached.value;
        })
        .finally(() => { refreshing = undefined; });
    }
    return refreshing;
  }

  async function api(path, data) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const access = await token();
      const response = await http(endpoint(path, { access_token: access }), data);
      const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
      if (response.ok && ['image/jpeg', 'image/png'].includes(contentType)) {
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > 1024 * 1024 || !body.length) throw new Error('Invalid WeChat code image');
        return { body, contentType };
      }
      const answer = await response.json().catch(() => ({}));
      if (attempt === 0 && [40001, 42001].includes(answer.errcode)) {
        if (cached?.value === access) cached = undefined;
        continue;
      }
      return answer;
    }
  }

  async function code(scene) {
    if (!/^\d{6}$/.test(scene)) throw new Error('Invalid scene');
    const result = await api('/wxa/getwxacodeunlimit', {
      scene, page: 'pages/sessions/index', check_path: false, env_version: envVersion,
    });
    if (!result?.body) throw new Error('WeChat code request failed');
    return result;
  }

  async function register(clientId, codeValue, subscribed) {
    if (!templateId) return;
    const response = await http(endpoint('/sns/jscode2session', {
      appid: appId, secret, js_code: codeValue, grant_type: 'authorization_code',
    }));
    const answer = await response.json();
    if (!answer.openid || !subscribed) return;
    if (subscribers.size >= 5000 && !subscribers.has(clientId)) subscribers.delete(subscribers.keys().next().value);
    subscribers.set(clientId, answer.openid);
    if (!deliveries.has(answer.openid) && deliveries.size >= 5000) deliveries.delete(deliveries.keys().next().value);
    const previous = deliveries.get(answer.openid);
    deliveries.set(answer.openid, previous ? { ...previous, credit: 1 } : { credit: 1, sent: [], keys: [], busy: false });
  }

  async function send(clientId, items) {
    const openid = subscribers.get(clientId);
    const user = deliveries.get(openid);
    if (!user?.credit || user.busy) return;
    const current = now();
    user.sent = user.sent.filter((at) => current - at < 86400000);
    if (user.sent.length >= 10 || user.sent.filter((at) => current - at < 3600000).length >= 3
      || current - (user.sent.at(-1) ?? -Infinity) < 600000) return;
    const fresh = items.filter((item) => !user.keys.includes(item.requestId));
    if (!fresh.length) return;
    const exact = fresh.length === 1 ? fresh[0] : null;
    const approval = exact?.kind === 'approval';
    const started = new Date(fresh[0].askedAt);
    const when = (Number.isFinite(started.getTime()) ? started : new Date(current)).toISOString().slice(0, 16).replace('T', ' ');
    user.busy = true;
    try {
      const answer = await api('/cgi-bin/message/subscribe/send', {
        touser: openid, template_id: templateId, miniprogram_state: envVersion,
        page: exact ? 'pages/chat/index?id=' + encodeURIComponent(exact.sessionId) : 'pages/sessions/index',
        data: {
          thing9: { value: exact ? (approval ? 'DSH 权限审批' : 'DSH 提问') : 'DSH 有待处理任务' },
          thing10: { value: exact ? (approval ? '工具调用' : '提问') : '审批和提问' },
          thing3: { value: '打开小程序查看' }, time67: { value: when },
        },
      });
      if (answer?.errcode === 0) {
        user.credit = 0;
        user.sent.push(current);
        user.keys = [...user.keys, ...fresh.map((row) => row.requestId)].slice(-100);
      } else if (answer?.errcode === 43101) user.credit = 0;
    } finally { user.busy = false; }
  }

  return { code, ...(templateId ? { notifier: { templateId, register, send } } : {}) };
}

module.exports = { createWechat };
