'use strict';
// H5 无头验收：打开 drch5.provid.cc，收集 console 错误、未捕获异常，截图。
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e.message || e).slice(0, 300)));
  page.on('requestfailed', (r) => errors.push('REQFAIL: ' + r.url().slice(0, 160) + ' ' + (r.failure() || {}).errorText));
  try {
    await page.goto('https://drch5.provid.cc/', { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (e) {
    errors.push('NAVIGATE: ' + e.message);
  }
  await new Promise((r) => setTimeout(r, 3000));
  const report = await page.evaluate(() => {
    const roots = [document.body];
    const walk = (node, out) => {
      for (const el of node.children || []) {
        const r = el.getBoundingClientRect();
        out.push({ tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || '').trim().slice(0, 40) });
        if (el.shadowRoot) walk(el.shadowRoot, out);
      }
    };
    const els = [];
    walk(document.body, els);
    return {
      title: document.title,
      url: location.href,
      custom: [...new Set(els.map((e) => e.tag).filter((t) => t.includes('-')))].slice(0, 10),
      visible: els.filter((e) => e.w > 0 && e.h > 0).length,
      total: els.length,
      texts: els.filter((e) => e.w > 0 && e.h > 0 && e.text).slice(0, 15),
    };
  });
  console.log(JSON.stringify({ report, errors: errors.slice(0, 20) }, null, 2));
  await page.screenshot({ path: '/tmp/h5-verify.png', fullPage: true });
  await browser.close();
})().catch((e) => { console.error('SCRIPT-FAIL', e.message); process.exit(1); });
