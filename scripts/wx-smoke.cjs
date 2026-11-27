'use strict';

const assert = require('node:assert/strict');
const { mkdir, stat } = require('node:fs/promises');
const { resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { loadTheme } = require('./theme.cjs');

const screens = resolve(process.env.DRC_WX_SCREENSHOTS || 'dist/screenshots');
const url = process.env.DRC_WX_AUTOMATION_URL || 'ws://127.0.0.1:9426';
const sdk = process.env.DRC_WX_AUTOMATOR || 'miniprogram-automator';

async function main() {
  const automation = require(sdk);
  await mkdir(screens, { recursive: true });
  const program = await automation.connect({ wsEndpoint: url });
  try {
    const screenshot = async (name) => {
      const path = resolve(screens, name + '.png');
      await delay(180);
      await program.screenshot({ path });
      assert.ok((await stat(path)).size > 1500, name + ': empty screenshot');
    };
    async function visibleWidth(page, selector) {
      const element = await page.$(selector);
      assert.ok(element, 'missing ' + selector);
      return (await element.size()).width;
    }
    async function checkDecisionColor(page, selector, theme) {
      const element = await page.$(selector);
      assert.ok(element, 'missing ' + selector);
      const hex = loadTheme(theme).token('td-brand-color-light').toLowerCase();
      const color = String(await element.style('background-color')).toLowerCase();
      const rgb = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16));
      assert.ok(color === hex || color === 'rgb(' + rgb.join(', ') + ')',
        selector + ' uses the inherited cool accent. Got ' + color);
    }
    async function control(page, selector) {
      const element = await page.$(selector);
      assert.ok(element, 'missing ' + selector);
      await element.tap();
      await delay(180);
    }
    const home = await program.reLaunch('/pages/sessions/index');
    await delay(600);
    assert.equal(await home.data('paired'), false, 'use a simulator project without a test pairing');
    if (await home.data('theme') !== 'light') await control(home, '.theme-button');
    assert.equal(await home.data('linkTitle'), '连接你的电脑');
    assert.ok(await visibleWidth(home, '.frame') > 280, 'light root fills the simulator screen');
    assert.ok(await visibleWidth(home, '.signal') > 250, 'pairing card spans the main content');
    await screenshot('pairing-light');

    await control(home, '.signal-demo');
    assert.equal(await home.data('demo'), true);
    assert.equal((await home.data('groups')).length, 2);
    await checkDecisionColor(home, '.pending-row', 'light');
    await screenshot('sessions-light');
    await control(home, '.theme-button');
    assert.equal(await home.data('theme'), 'dark');
    assert.ok(await visibleWidth(home, '.frame') > 280);
    await checkDecisionColor(home, '.pending-row', 'dark');
    await screenshot('sessions-dark');

    async function openChat(theme) {
      await control(await program.currentPage(), '.pending-row');
      let page;
      for (let i = 0; i < 20; i += 1) {
        page = await program.currentPage();
        if (page.path === 'pages/chat/index') break;
        await delay(100);
      }
      assert.equal(page.path, 'pages/chat/index');
      assert.equal(await page.data('theme'), theme);
      assert.equal((await page.data('timeline')).length, 3);
      assert.equal((await page.data('pending')).length, 1);
      assert.ok(await visibleWidth(page, '.frame') > 280);
      await checkDecisionColor(page, '.decision', theme);
      await screenshot('chat-' + theme);
    }
    await openChat('dark');
    const secondHome = await program.reLaunch('/pages/sessions/index');
    await delay(300);
    assert.equal(await secondHome.data('theme'), 'dark');
    await control(secondHome, '.theme-button');
    await control(secondHome, '.signal-demo');
    await openChat('light');
    console.log('微信模拟器通过：配对入口、会话演示、两套主题、聊天和待审批。');
  } finally {
    await program.disconnect();
  }
}

const deadline = setTimeout(() => process.exit(3), 25000);
void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(deadline));
