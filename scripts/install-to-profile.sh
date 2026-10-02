#!/bin/sh
# install-to-profile.sh — 构建 host 插件并装进 DSH profile。
#
#   ./scripts/install-to-profile.sh                       # ~/.dsh/profiles/desktop
#   DSH_PROFILE=~/.dsh/profiles/tui ./scripts/install-to-profile.sh
#
# 为什么长这样（每条都是踩过坑换来的）：
# 1. **只拷一个文件**：产物是 esbuild 打出来的自包含 bundle（dist/bundle/index.js），
#    profile 里不需要 node_modules —— 旧实现要靠 `pnpm add file:` 装整个包，
#    而 pnpm 对 `file:` 依赖是硬链接拷贝，`tsc` 重建后 inode 变了、profile 里仍是旧副本。
# 2. **不跑 pnpm add**：它会重新解析 profile 里所有依赖（含若干 GitHub tarball），
#    网络抖一下就更新不了一个纯本地插件。
# 3. **改代码必须重启 Harness**：HMR 只热更 cordis.patch.yml 的配置，不会重新 import dist。
# 4. 首次安装才备份并改写 profile 的 package.json（注册 bundle），后续只换文件。
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
PLUGIN="$ROOT/packages/plugin"
PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/desktop}"
BUNDLE_ID="dsh-remote-control"

if [ ! -d "$PROFILE" ]; then
  echo "install-to-profile: profile not found: $PROFILE" >&2
  exit 1
fi

# 装 profile 只需要**产物**；类型检查是 CI 的事（pnpm -r build / --filter X typecheck）。
# 这里刻意不跑 tsc：单元测试编译失败不该挡住"把当前代码装进宿主验证一把"。
echo "→ 构建：协议层 tsc + 插件 esbuild 打包…"
(cd "$ROOT" && env -u NODE_OPTIONS pnpm --filter @dsh-rc/protocol build)
node "$ROOT/scripts/bundle-plugin.mjs"

BUILT="$PLUGIN/dist/bundle/index.js"
VERSION=$(node -p "require('$PLUGIN/package.json').version")
[ -f "$BUILT" ] || { echo "install-to-profile: 缺产物 $BUILT" >&2; exit 1; }

TARGET="$PROFILE/node_modules/$BUNDLE_ID"

# **必须是真目录，不能是指回工作区的软链**。旧实现用 `pnpm add file:.../packages/plugin`
# 安装，profile 的 package.json 里就留下一条 `"dsh-remote-control": "file:..."`；
# 只要那条还在，`pnpm install` 就会把整个工作区包再物化一份进来，
# 于是宿主里同时跑着**两个插件实例**：两个 hostId、中继里两份会话、
# 手机连到哪一个全看谁先注册——真机取证时表现为"改了的代码没生效"，
# 而 status.json 的计数来自另一个实例，怎么都对不上账（这次就是被它误导了好几轮）。
if [ -L "$TARGET" ]; then
  echo "install-to-profile: $TARGET 是软链（指向 $(readlink "$TARGET")）——profile 里还留着 file: 依赖" >&2
  echo "  先删掉 $PROFILE/package.json 的 dependencies.$BUNDLE_ID，再重跑本脚本。" >&2
  exit 1
fi
# 整个目录先删后建：只删 index.js/package.json 的话，上一次 pnpm 物化出来的
# dist/、node_modules/ 会被当成当前版本的一部分。
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp "$BUILT" "$TARGET/index.js"
# `dsh.bundle.patch` 是宿主认出这是一个 bundle 的入口字段——漏了它，
# 文件都在、profile 的 bundles 列表里也有名字，但插件根本不会被加载（踩过一次）。
cat > "$TARGET/package.json" <<JSON
{
  "name": "$BUNDLE_ID",
  "version": "$VERSION",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
JSON
cp "$PLUGIN/cordis.patch.yml" "$TARGET/cordis.patch.yml"

echo "→ 注册 bundle 到 ${BUNDLE_ID}（幂等），并清掉旧的 file: 依赖…"
node --input-type=module -e "
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const file = '$PROFILE/package.json'
if (!existsSync(file)) { console.error('profile 没有 package.json：' + file); process.exit(1) }
// 每次改写前都留一份原文：这文件里同时带着 hostToken，改坏了要能一眼回退。
writeFileSync(file + '.bak-drc-' + Math.floor(Date.now() / 1000), readFileSync(file))
const pkg = JSON.parse(readFileSync(file, 'utf8'))
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const list = pkg.dsh.profile.bundles || []
if (!list.includes('$BUNDLE_ID')) list.push('$BUNDLE_ID')
pkg.dsh.profile.bundles = list
// 旧机制退役：'file:' 依赖会让 pnpm 再物化一份插件进 profile，
// 两个实例同时挂在中继上（两个 hostId、两份会话），手机连到谁全凭运气。
// 现在的安装方式只有这一条：本目录下的单文件 bundle + bundles 列表里的名字。
let removed = false
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  if (pkg[field] && typeof pkg[field] === 'object' && '$BUNDLE_ID' in pkg[field]) {
    console.log('   删除 ' + field + '.' + '$BUNDLE_ID' + ' = ' + JSON.stringify(pkg[field]['$BUNDLE_ID']))
    delete pkg[field]['$BUNDLE_ID']
    removed = true
  }
}
writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log('   bundles:', list.join(', '))
if (removed) console.log('   （file: 依赖已删除；profile 的 node_modules 里那份 pnpm 物化的副本由本脚本重写覆盖）')
"

echo
echo "✅ 已安装 $BUNDLE_ID@$VERSION → $TARGET/index.js"
echo "   下一步：**重启 Harness**（新代码不会被热加载），然后看"
echo "     cat ~/.dsh/dsh-remote-control/status.json"
echo "   关键三字段：carrier（services=真内核 / mock=内存替身 / none=配置或载体问题）、"
echo "               relay（online/connecting/offline）、relayProblem"
