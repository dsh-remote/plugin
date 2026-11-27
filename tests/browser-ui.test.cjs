'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');

// 判据扫源码前先剥注释（2026-10-08 的纪律：注释里的词不算实现）。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('UI: the pill toggles a non-modal popover instead of a modal dialog', async () => {
  const src = stripComments(await readFile('packages/plugin/browser.cjs', 'utf8'));
  assert.doesNotMatch(src, /showModal/, '模态弹窗会挡住 pill，第二次点击就收不起来');
  assert.match(src, /open\.onclick\s*=\s*\(\)\s*=>\s*toggle\(!panel\.open\)/, '点 pill 必须按当前开合状态取反');
  assert.match(src, /panel\.show\(\)/, '非模态打开，pill 保持可点');
  assert.match(src, /else if \(panel\.open\) panel\.close\(\)/, '收起分支必须真的关掉弹窗（只摘监听=关不掉）');
  assert.match(src, /addEventListener\(['"]close['"]/, 'close 事件必须把 aria-expanded 与外部点击监听一起收回');
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
