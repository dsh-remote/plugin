'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTheme } = require('../scripts/theme.cjs');

function parts(css) {
  if (css[0] === '#') {
    let hex = css.slice(1);
    if (hex.length === 3) hex = hex.split('').map((value) => value.repeat(2)).join('');
    return [...hex.match(/../g).map((byte) => Number.parseInt(byte, 16)), 1];
  }
  return css.match(/[\d.]+/g).map(Number);
}

function luminance(rgb) {
  const [r, g, b] = rgb.slice(0, 3).map((byte) => byte / 255)
    .map((n) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
}

function ratio(foreground, background) {
  const back = parts(background);
  const rgba = parts(foreground);
  const alpha = rgba[3] ?? 1;
  const filled = rgba.slice(0, 3).map((channel, i) => channel * alpha + (1 - alpha) * back[i]);
  const values = [luminance(filled), luminance(back)].sort((x, y) => y - x);
  return (values[0] + .05) / (values[1] + .05);
}

test('U1: preserve the old project surface swatches, geometry scale, and native bar pairing exactly', () => {
  const light = loadTheme('light'), dark = loadTheme('dark');
  for (const [theme, expected] of [[light, ['#eff2f7', '#ffffff', '#e5ebf5', '#2f4bd6']],
    [dark, ['#0a0b10', '#141822', '#1c2130', '#3f5bf6']]]) {
    assert.deepEqual(['surface-page', 'surface-card', 'surface-sunken', 'surface-brand']
      .map((key) => theme.token('drc-' + key).toLowerCase()), expected);
    assert.deepEqual(['space-1', 'space-3', 'space-4', 'radius-md', 'font-md', 'font-display']
      .map((key) => theme.token('drc-' + key)), ['8rpx', '24rpx', '32rpx', '16rpx', '28rpx', '56rpx']);
    assert.equal(theme.system.backgroundColor, expected[1]);
    assert.equal(theme.system.backgroundColorTop, expected[0]);
  }
});

test('U1: visible text, actions and status colors keep the original accessible pairings', () => {
  for (const name of ['dark', 'light']) {
    const { token } = loadTheme(name);
    const pairs = [
      ['drc-fg-primary', 'drc-surface-page'], ['drc-fg-primary', 'drc-surface-card'],
      ['drc-fg-muted', 'drc-surface-page'], ['drc-fg-muted', 'drc-surface-card'],
      ['drc-fg-brand', 'drc-surface-page'], ['drc-fg-anti', 'drc-surface-brand'],
      ['drc-fg-brand', 'td-brand-color-light'], ['drc-fg-danger', 'td-error-color-1'],
    ];
    for (const [fg, bg] of pairs) assert.ok(ratio(token(fg), token(bg)) >= 4.5, name + ' ' + fg + '/' + bg);
  }
});
