#!/bin/sh
# relay-start.sh — 在本地起一个中继（开发/真链路取证用）。
#
#   ./scripts/relay-start.sh                     # 127.0.0.1:8787，token 从 profile 的 patch 里读
#   DRC_PORT=9000 ./scripts/relay-start.sh
#   ./scripts/relay-start.sh --bundle            # 跑单文件产物，与生产形态一致
#
# 为什么默认复用 profile patch 里那一份 token：主机插件与中继必须同一份凭据，
# 手工同步两次就会有一边改了另一边没改，表现是"永远 bad_token"。
# 生产部署走的是另一条路（`deploy/` 里 systemd + /etc/dsh-remote-control.env），
# 这个脚本只服务本地。
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/desktop}"
PATCH_FILE="$PROFILE/cordis.patch.yml"
PORT="${DRC_PORT:-8787}"
ARTIFACT="$ROOT/apps/server/dist/src/main.js"
BUNDLE="$ROOT/apps/server/dist/bundle/main.js"

if [ "$1" = "--bundle" ]; then
  ARTIFACT="$BUNDLE"
fi

if [ -z "$DRC_HOST_TOKEN" ] && [ -f "$PATCH_FILE" ]; then
  # 从 patch 里抓 hostToken: 那一行（值可能是引号包裹的）。
  DRC_HOST_TOKEN=$(grep -oE 'hostToken:[[:space:]]*"?[^"[:space:]]+"?' "$PATCH_FILE" | head -1 | sed -E 's/^hostToken:[[:space:]]*"?//; s/"$//')
  [ -n "$DRC_HOST_TOKEN" ] && echo "relay-start: 从 $PATCH_FILE 读到 hostToken（前 4 位 ${DRC_HOST_TOKEN%"${DRC_HOST_TOKEN#????}"}…，完整值不外泄）"
fi

if [ -z "$DRC_HOST_TOKEN" ]; then
  echo "relay-start: 没有 DRC_HOST_TOKEN，也没在 $PATCH_FILE 里找到 hostToken。" >&2
  echo "             显式给一个：DRC_HOST_TOKEN=xxx ./scripts/relay-start.sh" >&2
  exit 1
fi

if [ ! -f "$ARTIFACT" ]; then
  echo "relay-start: 缺产物 $ARTIFACT —— 先跑 env -u NODE_OPTIONS pnpm --filter @dsh-rc/server build" >&2
  exit 1
fi

export DRC_HOST_TOKEN DRC_PORT="$PORT" DRC_BIND="${DRC_BIND:-127.0.0.1}"
export DRC_LOG_LEVEL="${DRC_LOG_LEVEL:-debug}"
export DRC_PAIR_TTL_MS="${DRC_PAIR_TTL_MS:-120000}"
echo "relay-start: $ARTIFACT 监听 $DRC_BIND:$DRC_PORT"
exec node "$ARTIFACT"
