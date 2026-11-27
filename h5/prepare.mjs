// H5 构建壳的源准备：把 v06 构建产物（dist/miniprogram）复制进 src/，
// 1) 注入 H5 默认中继地址；
// 2) 给每个页面 json 注入 styleIsolation=apply-shared —— web 运行时把页面渲染在
//    Shadow DOM 里，默认隔离会挡掉 app.wxss 的全局布局样式（.frame/.row/button 重置），
//    apply-shared 让全局样式进入 shadow root。小程序源码一行不改。
import { cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../dist/miniprogram');
const target = resolve(here, 'src');

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });

const configPath = resolve(target, 'runtime-config.js');
let raw = await readFile(configPath, 'utf8');
const config = JSON.parse(raw.replace(/^module\.exports\s*=\s*/, '').replace(/;\s*$/, ''));
config.relayUrl = process.env.DRC_H5_RELAY_URL || 'wss://drc.provid.cc/v06';
await writeFile(configPath, 'module.exports = ' + JSON.stringify(config) + ';\n');

// 关键修复：web 运行时把 app.wxss 注入 shadow root 的 <style>，那里没有 base URL，
// @import "./theme/*.wxss" 解析失败 ⇒ 全部 --drc-* 主题变量丢失 ⇒ 布局塌掉。
// 在构建壳里把 @import 内联成实际内容，小程序源码不动。
const appWxssPath = resolve(target, 'app.wxss');
let appWxss = await readFile(appWxssPath, 'utf8');
const importRe = /@import\s+"([^"]+)";/g;
const rels = [...appWxss.matchAll(importRe)].map((m) => m[1]);
const bodies = await Promise.all(rels.map(async (rel) => {
  const body = await readFile(resolve(target, rel), 'utf8');
  return '/* inlined ' + rel + ' */\n' + body.replace(importRe, '');
}));
appWxss = appWxss.replace(importRe, () => bodies.shift());
await writeFile(appWxssPath, appWxss);

const appJson = JSON.parse(await readFile(resolve(target, 'app.json'), 'utf8'));
for (const page of appJson.pages || []) {
  const pageJsonPath = resolve(target, page + '.json');
  let json = {};
  try { json = JSON.parse(await readFile(pageJsonPath, 'utf8')); } catch { /* 页面可能没有 json */ }
  json.styleIsolation = 'apply-shared';
  await writeFile(pageJsonPath, JSON.stringify(json, null, 2) + '\n');
}
console.log('h5 src ready: relayUrl=' + config.relayUrl + ', styleIsolation applied to ' + (appJson.pages || []).length + ' pages');
