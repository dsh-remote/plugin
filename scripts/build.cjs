'use strict';

const { build, transform } = require('esbuild');
const { cp, mkdir, readdir, readFile, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');

const { loadTheme } = require('./theme.cjs');
const { buildPlugin } = require('./build-plugin.cjs');

const root = resolve(__dirname, '..');
const args = process.argv.slice(2);
const out = resolve(args[0] === '--out' && args[1] ? args[1] : join(root, 'dist'));

async function copySources(from, to) {
  await mkdir(to, { recursive: true });
  for (const file of await readdir(from, { withFileTypes: true })) {
    const input = join(from, file.name);
    const output = join(to, file.name);
    if (file.isDirectory()) await copySources(input, output);
    else if (file.name.endsWith('.js')) {
      const source = await readFile(input, 'utf8');
      await writeFile(output, (await transform(source, { target: 'es2018', sourcefile: file.name })).code);
    } else await cp(input, output);
  }
}

function bundle(entry, target, platform, extra = {}) {
  return build({
    absWorkingDir: root, entryPoints: [entry], outfile: join(out, target),
    bundle: true, platform, format: 'cjs', target: platform === 'node' ? 'node20' : 'es2018',
    legalComments: 'eof', logLevel: 'warning', ...extra,
  });
}

async function main() {
  const mini = join(out, 'miniprogram');
  const plugin = join(out, 'plugin');
  await copySources(join(root, 'packages/client/miniprogram'), mini);
  const appConfig = JSON.parse(await readFile(join(mini, 'app.json'), 'utf8'));
  const light = loadTheme('light'), dark = loadTheme('dark');
  Object.assign(appConfig.window, {
    navigationBarBackgroundColor: light.system.backgroundColor,
    backgroundColor: light.system.backgroundColorTop,
  });
  await writeFile(join(mini, 'app.json'), JSON.stringify(appConfig, null, 2) + '\n');
  await mkdir(join(mini, 'theme'), { recursive: true });
  await Promise.all([cp(light.file, join(mini, 'theme/light.wxss')), cp(dark.file, join(mini, 'theme/dark.wxss'))]);
  await writeFile(join(mini, 'theme-native.js'), 'module.exports = '
    + JSON.stringify({ light: light.system, dark: dark.system }) + ';\n');
  const protocol = join(out, 'protocol');
  await mkdir(protocol, { recursive: true });
  const files = [
    bundle('packages/protocol/wire.cjs', 'protocol/wire.cjs', 'node'),
    bundle('packages/protocol/crypto.cjs', 'protocol/crypto.cjs', 'node'),
    writeFile(join(protocol, 'index.cjs'), "module.exports = { ...require('./wire.cjs'), ...require('./crypto.cjs') };\n"),
    writeFile(join(protocol, 'package.json'), JSON.stringify({
      name: '@dsh-remote/protocol', version: '0.6.0', main: './index.cjs', license: 'MIT',
      exports: { '.': './index.cjs', './wire': './wire.cjs', './crypto': './crypto.cjs' },
    }, null, 2) + '\n'),
    cp(join(root, 'LICENSE'), join(protocol, 'LICENSE')),
    bundle('packages/relay/cli.cjs', 'relay/main.cjs', 'node'),
    buildPlugin({ out: plugin }),
    bundle('packages/client/mini-core.cjs', 'miniprogram/core.js', 'browser', { minify: true }),
    bundle('node_modules/marked/lib/marked.esm.js', 'miniprogram/marked.js', 'browser', { minify: true }),
    writeFile(join(mini, 'project.config.json'), JSON.stringify({
      appid: process.env.DRC_MP_APPID || 'touristappid',
      projectname: 'dsh-remote-v06', compileType: 'miniprogram', libVersion: '3.17.5',
      miniprogramRoot: '', setting: { es6: true, urlCheck: !process.env.DRC_MP_LOCAL, minified: true, enhance: true },
    }, null, 2) + '\n'),
    writeFile(join(mini, 'runtime-config.js'),
      'module.exports = ' + JSON.stringify({ relayUrl: process.env.DRC_SERVER_URL || '' }) + ';\n'),
  ];
  await Promise.all(files);
  console.log('Built protocol, relay, Harness plugin and mini program in ' + out);
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
