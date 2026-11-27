'use strict';

const PREFIX = '/plugins/dsh-remote-control';
const loopback = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i;
const allowedOrigin = /^(?:dsh-app:\/\/app|https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?)$/i;

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function object(req) {
  let size = 0;
  const parts = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) { req.resume(); throw new Error('设置请求过长'); }
    parts.push(chunk);
  }
  const answer = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('设置格式有误');
  return answer;
}

function registerRoutes(web, app) {
  let code;
  const paths = [
    ['/status', 'GET', async (_req, res) => json(res, 200, app.status())],
    ['/pairing/new', 'POST', async (_req, res) => {
      code = await app.issueCode();
      json(res, 200, { expiresAt: code.expiresAt });
    }],
    ['/pairing.png', 'GET', async (_req, res) => {
      if (!code || code.expiresAt <= Date.now()) return json(res, 404, { error: '配对码已过期' });
      const image = await app.getCodeImage(code.token);
      res.writeHead(200, { 'content-type': image.contentType, 'cache-control': 'no-store' });
      res.end(image.body);
    }],
    ['/unpair', 'POST', async (_req, res) => {
      code = undefined;
      json(res, 200, { unpaired: await app.unpair() });
    }],
    ['/config', 'GET|POST', async (req, res) => {
      if (req.method === 'POST') {
        await app.configure(await object(req));
        code = undefined;
      }
      json(res, 200, app.status());
    }],
  ];
  const off = [];
  function close() { for (const unregister of off.splice(0).reverse()) { try { unregister?.(); } catch {} } }
  try {
    for (const [suffix, methods, handler] of paths) {
      off.push(web.register({ kind: 'exact', path: PREFIX + suffix, async handler(req, res) {
        const { host, origin } = req.headers;
        if (!loopback.test(host || '') || origin && !allowedOrigin.test(origin)) return json(res, 403, { error: '请求来源不受信任' });
        if (origin) {
          res.setHeader('access-control-allow-origin', origin);
          res.setHeader('vary', 'Origin');
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'Content-Type, X-DRC-Pair' });
          res.end();
          return;
        }
        if (!methods.split('|').includes(req.method)) return json(res, 405, { error: '请求方法无效' });
        if ((req.method === 'POST' || suffix === '/pairing.png') && req.headers['x-drc-pair'] !== '1') {
          return json(res, 403, { error: '请从 Harness 的远程控制面板使用该操作' });
        }
        try { await handler(req, res); }
        catch (error) { json(res, 503, { error: error.message || '操作失败' }); }
      } }));
    }
  } catch (error) { close(); throw error; }
  return close;
}

module.exports = { registerRoutes, PREFIX };
