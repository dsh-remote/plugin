'use strict';

const { build } = require('esbuild');
const { cp, mkdir, readFile, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');

const root = resolve(__dirname, '..');
const primaryName = '@dsh-remote/plugin';

async function buildPlugin({ out, name = primaryName }) {
  if (name !== primaryName && name !== 'dsh-remote-control') throw new Error('Invalid release package name');
  const version = require('../package.json').version;
  await mkdir(out, { recursive: true });
  const patch = await readFile(join(root, 'packages/plugin/cordis.patch.yml'), 'utf8');
  const common = {
    absWorkingDir: root, bundle: true, format: 'cjs', legalComments: 'inline', logLevel: 'warning',
    define: { __DRC_PLUGIN_NAME__: JSON.stringify(name) },
  };
  await Promise.all([
    build({
      ...common, entryPoints: ['packages/plugin/index.cjs'], outfile: join(out, 'index.cjs'),
      platform: 'node', target: 'node20',
    }),
    build({
      ...common, entryPoints: ['packages/plugin/browser.cjs'], outfile: join(out, 'client.cjs'),
      platform: 'browser', target: 'chrome120',
      banner: { js: [
        'window.__ModuleLoader__.load({',
        '  id: ' + JSON.stringify(name) + ',',
        '  factory: (require) => {',
        '    var module = { exports: {} };',
        '    var exports = module.exports;',
      ].join('\n') },
      footer: { js: '    return module.exports;\n  },\n});' },
    }),
    cp(join(root, 'LICENSE'), join(out, 'LICENSE')),
    cp(join(root, 'README.for-ai.md'), join(out, 'README.md')),
    writeFile(join(out, 'cordis.patch.yml'), patch.replace("name: '" + primaryName + "'", "name: '" + name + "'")),
    writeFile(join(out, 'index.mjs'), "import plugin from './index.cjs';\nexport const { name, apply } = plugin;\n"),
    writeFile(join(out, 'package.json'), JSON.stringify({
      name, version, license: 'MIT', main: './index.mjs',
      description: 'DeepSeek Harness remote control with end-to-end encrypted WeChat pairing',
      repository: { type: 'git', url: 'git+https://github.com/dsh-remote/plugin.git' },
      publishConfig: { access: 'public', tag: 'next' },
      exports: {
        '.': { import: './index.mjs', require: './index.cjs' }, './client': './client.cjs',
        './cordis.patch.yml': './cordis.patch.yml', './package.json': './package.json',
      },
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', immediately: true } },
      engines: { node: '>=20' },
    }, null, 2) + '\n'),
  ]);
}

if (require.main === module) {
  const [, , ...args] = process.argv;
  const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  void buildPlugin({ out: resolve(value('--out') || join(root, 'dist/plugin')), name: value('--name') })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { buildPlugin };
