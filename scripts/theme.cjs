'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function loadTheme(name) {
  if (!['light', 'dark'].includes(name)) throw new Error('Unknown theme: ' + name);
  const file = join(__dirname, '..', 'packages', 'client', 'theme', name + '.wxss');
  const css = readFileSync(file, 'utf8');
  const declarations = new Map();
  for (const [, key, value] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/--([\w-]+)\s*:\s*([^;{}]+)[;]/g)) {
    declarations.set(key, value.trim());
  }
  function token(key) {
    const original = key;
    const visited = new Set();
    while (declarations.has(key) && !visited.has(key)) {
      visited.add(key);
      const value = declarations.get(key);
      const alias = /^var\(--([\w-]+)\)$/.exec(value);
      if (!alias) return value;
      key = alias[1];
    }
    throw new Error('Theme token is missing or circular: ' + original);
  }
  return {
    file, token,
    system: {
      frontColor: name === 'dark' ? '#ffffff' : '#000000',
      backgroundColor: token('drc-surface-card'), backgroundColorTop: token('drc-surface-page'),
    },
  };
}

module.exports = { loadTheme };
