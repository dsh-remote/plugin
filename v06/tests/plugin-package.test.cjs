'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { tempDir } = require('./support.cjs');

for (const name of ['@dsh-remote/plugin', 'dsh-remote-control']) {
  test('release package matches the Harness runtime and browser loader names: ' + name, async (t) => {
    const out = await tempDir(t);
    const result = spawnSync(process.execPath, ['scripts/build-plugin.cjs', '--out', out, '--name', name],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const meta = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'));
    assert.equal(meta.name, name);
    assert.equal(meta.version, '0.6.0');
    assert.equal(meta.publishConfig.tag, 'next');
    assert.equal(await readFile(join(out, 'README.md'), 'utf8'), await readFile('README.for-ai.md', 'utf8'));
    assert.equal(require(join(out, 'index.cjs')).name, name);
    assert.match(await readFile(join(out, 'cordis.patch.yml'), 'utf8'), new RegExp("name: '" + name + "'"));
    const registrations = [];
    let entry;
    const browser = await readFile(join(out, 'client.cjs'), 'utf8');
    runInNewContext(browser, { window: { __ModuleLoader__: { load(value) { entry = value; } } }, console });
    assert.equal(entry.id, name);
    const plugin = entry.factory((moduleName) => {
      assert.equal(moduleName, 'react');
      return { createElement() {} };
    });
    assert.equal(plugin.name, name);
    assert.deepEqual(Array.from(plugin.inject), ['slots']);
    plugin.apply({ slots: { inject(_slot, callback) { callback(); }, register({ name }) { registrations.push(name); } } });
    assert.deepEqual(registrations, ['conversation.composer.dock', 'settings.section']);
  });
}
