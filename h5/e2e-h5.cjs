'use strict';
// H5 端到端自验 v2：以模拟主机侧协议信号判定成功（pair-request → grant → 手机上行 enc），
// 浏览器只负责点击与截图，避免重 evaluate。
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const nacl = require('tweetnacl');
const puppeteer = require('puppeteer-core');
const { createRelay } = require('../packages/relay/index.cjs');
const { toBase64, fromBase64, deriveKey, seal, open, makeGrant, readGrant } = require('../packages/protocol/crypto.cjs');

const WEB = 8791;
const CODE = '246813';
const HOST_ID = 'drc-e2e-h5';

async function main() {
  const relay = createRelay({ masterToken: 'e2e-master-token', bind: '127.0.0.1', port: 0 });
  const addr = await relay.start();
  console.log('relay at', addr.ws);

  const claim = await (await fetch(`${addr.http}/api/claim-token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId: HOST_ID }),
  })).json();
  const hostSecret = nacl.box.keyPair();
  const psk = toBase64(nacl.randomBytes(16));
  let sessionId = null, sas = null, phoneFrames = 0, grantOk = false;

  const host = await connect(addr.ws);
  host.send(JSON.stringify({ t: 'hello', protocol: 1, role: 'host', hostId: HOST_ID, token: claim.token, softwareVersion: '0.6.2-e2e' }));
  await host.waitFor((f) => f.t === 'hello-ok', 'host hello-ok');
  host.send(JSON.stringify({ t: 'pair-begin', pairingToken: CODE }));
  await host.waitFor((f) => f.t === 'pair-ready', 'pair-ready');
  console.log('host ready, code', CODE);

  host.on((f) => {
    if (f.t === 'pair-request' && !sessionId) {
      sessionId = f.sessionId;
      console.log('GOT pair-request (phone claimed!)');
      const grant = makeGrant(hostSecret.secretKey, fromBase64(f.clientPub), psk, nacl.randomBytes(24));
      sas = grant.sas;
      host.send(JSON.stringify({ t: 'pair-grant', sessionId, ...grant }));
    }
    if (f.t === 'enc' && sessionId) {
      // 手机上行帧：解开证明端到端加密通道双向可用
      const key = deriveKey(psk, 'c2h', sessionId);
      const plain = open(key, f.ciphertext);
      phoneFrames += 1;
      console.log('PHONE UPLINK:', JSON.stringify(plain).slice(0, 120));
      if (plain && !grantOk) {
        grantOk = true;
        // 回应会话列表（h2c）
        const reply = { t: 'ev.session_changed', sessions: [{ id: 's-e2e', title: 'E2E 测试会话', workspace: '/tmp/e2e-project', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'idle' }] };
        host.send(JSON.stringify({ t: 'enc', sessionId, seq: f.seq, ciphertext: seal(deriveKey(psk, 'h2c', sessionId), reply, nacl.randomBytes(24)) }));
      }
    }
  });

  const web = createServer(async (req, res) => {
    const path = (req.url === '/' ? '/index.html' : req.url.split('?')[0]).replace(/^[/]+/, '');
    try {
      const body = await readFile(resolve(__dirname, 'dist/web', path));
      res.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html' : 'text/javascript' });
      res.end(body);
    } catch { res.writeHead(404); res.end('nf'); }
  }).listen(WEB);

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--user-data-dir=/tmp/h5-e2e-profile'], protocolTimeout: 60000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e.message).slice(0, 160)));
  page.on('crashed', () => console.log('RENDERER CRASHED'));
  await page.evaluateOnNewDocument((relayUrl, code) => {
    localStorage.setItem('__weapp_vite_web_storage__:drc.v06.relay-url', relayUrl);
    window.prompt = () => code;
    window.confirm = () => true;   // showModal「数字一致」自动确认（真实浏览器会弹系统框）
    window.alert = () => {};
  }, addr.ws, CODE);
  await page.goto(`http://127.0.0.1:${WEB}/`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2000));

  // 点「扫码连接」（轻量 evaluate，超时兜底）
  const clicked = await Promise.race([
    page.evaluate((t) => {
      const walk = (node) => {
        for (const el of node.querySelectorAll('*')) {
          const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
          if (own === t && el.getBoundingClientRect().width > 0) { el.click(); return true; }
          if (el.shadowRoot && walk(el.shadowRoot)) return true;
        }
        return false;
      };
      return walk(document);
    }, '扫码连接'),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 8000)),
  ]).catch((e) => 'ERR ' + e.message.slice(0, 80));
  console.log('clicked:', clicked);

  // 等主机侧信号
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !sessionId) await new Promise((r) => setTimeout(r, 500));
  if (sessionId) {
    // 配对确认弹窗：点「数字一致」完成 channel 建立
    const confirmed = await Promise.race([
      page.evaluate(() => {
        const walk = (node) => {
          for (const el of node.querySelectorAll('*')) {
            const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
            if (own === '数字一致' && el.getBoundingClientRect().width > 0) { el.click(); return true; }
            if (el.shadowRoot && walk(el.shadowRoot)) return true;
          }
          return false;
        };
        return walk(document);
      }),
      new Promise((r) => setTimeout(() => r('TIMEOUT'), 6000)),
    ]).catch((e) => 'ERR ' + e.message.slice(0, 60));
    console.log('confirmed click:', confirmed);
  }
  const deadline2 = Date.now() + 20000;
  while (Date.now() < deadline2 && !grantOk) await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: '/tmp/h5-e2e.png' }).catch((e) => console.log('shot fail', e.message.slice(0, 60)));

  const ok = Boolean(sessionId && grantOk && sas);
  console.log(JSON.stringify({ paired: Boolean(sessionId), sas, phoneUplinks: phoneFrames, grantOk }));
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');
  await browser.close().catch(() => {}); web.close(); await relay.close();
  process.exit(ok ? 0 : 1);
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const frames = [], waiters = [], handlers = [];
    ws.onmessage = (e) => {
      const f = JSON.parse(e.data);
      frames.push(f);
      for (const w of waiters.splice(0)) if (w.test(f)) w.ok(f);
      for (const h of handlers) { try { h(f); } catch (err) { console.log('handler err', err.message.slice(0, 80)); } }
    };
    ws.onerror = (e) => { console.log('HOST WS-ERR', e.message); rej(e); };
    ws.onclose = (e) => console.log('HOST WS-CLOSE', e.code, e.reason);
    ws.onopen = () => res({
      send: (d) => ws.send(d),
      waitFor: (test, what) => new Promise((ok, bad) => {
        const hit = frames.find(test);
        if (hit) return ok(hit);
        waiters.push({ test, ok });
        setTimeout(() => bad(new Error('timeout: ' + what)), 8000);
      }),
      on: (h) => handlers.push(h),
    });
  });
}

main().catch((e) => { console.error('E2E CRASH', e.message); process.exit(1); });
