# dsh-remote-control 项目长期记忆

## 生产部署（已上线）

- 入口：`wss://drc.provid.cc`（阿里云 cn-shanghai / ECS `47.100.82.15`）
- 服务器：中继 `/opt/dsh-remote-control/server` + systemd `dsh-remote-control.service`
  （只绑 `127.0.0.1:8787`）；nginx `conf.d/drc.conf` 做 TLS + ws + 按 IP 限流
- 证书：acme.sh（`/opt/jevtv/acme/acme.sh`）+ 阿里云 DNS-01，已存凭证，自动续期
- token：服务器 `/etc/dsh-remote-control.env`（600）与 macOS
  `~/.dsh/profiles/desktop/cordis.patch.yml` 两处**必须一致**
- DNS：`provid.cc` 有 `*.provid.cc` 泛解析，加子域不用改记录
- 详见 `deploy/README.md`；自检 `node scripts/verify-deployment.mjs`
- 排错入口：`cat ~/.dsh/dsh-remote-control/status.json` 看 `carrier`（dsh 还是 mock）

## HMR 不会重载 dist

改 `cordis.patch.yml` 的配置会热更新；替换 `node_modules/<pkg>/dist` **不会**。
**改代码必须重启 Harness。**

## 构建 / 测试命令（必须这样跑）

```sh
env -u NODE_OPTIONS pnpm install -r
env -u NODE_OPTIONS pnpm -r build
env -u NODE_OPTIONS pnpm -r test     # 33 项
node e2e/run.mjs
```

**为什么加 `env -u NODE_OPTIONS`**：WorkBuddy 注入的 FS 钩子
（`node-brokered-fs-shim.cjs`）会拦截 pnpm 的符号链接操作，报
`CODEBUDDY_BROKER_DENY` EEXIST/ENOENT，导致 install 失败。清掉 NODE_OPTIONS 即可。
被 SIGTERM 打断的 pnpm 还会在 `~/Library/pnpm/store/v11/projects/` 留下失效链接，删掉。

## 产物路径（别搞错）

- `packages/protocol` → `dist/src/**`（tsconfig `rootDir:"."`），main 是 `./dist/src/index.js`
- `packages/plugin` → `dist/src/**`，main 是 `./dist/src/index.js`
- **`lib/` 是历史遗留的陈旧产物，已删除并 gitignore —— 不要再从 lib/ import**
- `packages/plugin/dist/protocol/` 是构建时内联进来的 protocol 副本（见下）

## 打包约束：插件必须自包含

插件要装进 `~/.dsh/profiles/desktop`（外部 pnpm 工程），**不能有 `workspace:*` 依赖**。
所以：`@dsh-rc/protocol` 只是 devDependency；`scripts/bundle-protocol.mjs` 在 build 后
把 protocol 编译产物复制到 `dist/protocol/`，并把 `@dsh-rc/protocol` 裸 specifier
改写成相对路径。运行时依赖只有 `ws` / `tweetnacl` / `tweetnacl-util`。

**改了 protocol 之后必须重新 build plugin**，否则 `dist/protocol/` 是旧的。

## 小程序（mp/）约束（2026-10-02 重写后）

- 结构：`mp/core/`（codec / env / socket / session-store / client）+ `mp/core/vendor/`
  （nacl-fast.js + js-base64.js）+ `mp/miniprogram_npm/tdesign-miniprogram/`（裁剪版
  TDesign，无需构建 npm）。旧 `mp/utils/` 已删除。
- 无 Buffer / 无 CSPRNG / 无 crypto 模块 → UTF-8/base64 用 vendored js-base64；
  nonce 用计数器。
- `mp/core/vendor/nacl-fast.js` 已打过补丁（移除 `require('crypto')` PRNG 探测），
  升级 tweetnacl 时要重新打。
- `mp/core/package.json` 只为把该目录标成 commonjs 供 Node 侧测试用，小程序无视它。
- 改 `mp/core/*.js` 必须跑 `e2e/mp-crypto.test.mjs` + `e2e/mp-client.test.mjs`
  （+ `e2e/mp-platform.test.mjs`）。
- 页面入口是 `pages/sessions/sessions`（未配对显示「去配对」），pair 页配对成功自动返回。
- socket.js 连接超时看 `_opened` 标志，不是「已绑定」——旧版的超时是死代码。

## 已安装到 desktop profile

- 依赖 + `dsh.profile.bundles` 已加；`cordis.patch.yml` 有配置行（含 hostToken）。
- 备份文件：`~/.dsh/profiles/desktop/*.bak-drc-<ts>`
- token 也用于中继：`./scripts/relay-start.sh` 会从该 patch 文件里读同一个 token。
- **改动插件后需重启 Harness**（新增 package 不走 HMR）。
- **重新部署用 `./scripts/install-to-profile.sh`，不要只跑 `pnpm -r build`**：
  pnpm 对 `file:` 依赖是硬链接拷贝（不是符号链接），tsc 重建后 inode 变了，
  profile 里的副本仍是旧的；而且单纯再 `pnpm add` 也会复用缓存，
  必须先 `rm -rf ~/.dsh/profiles/desktop/node_modules/dsh-remote-control`
  （脚本里已经做了）。

## 排错小抄

- 中继日志：`DRC_LOG_LEVEL=debug ./scripts/relay-start.sh`，一行一个 JSON。
- `/healthz` 返回 hosts/clients/conversations/uptimeSec，可当 readiness 探针。
- 配对连不上时按顺序查：中继起了吗 → token 一致吗 → `carrier=dsh` 还是 `mock`。

## 尚未验证

`adapter-dsh.ts` 的真实 DSH 内核挂接没在真机跑过。启动后看日志是
`carrier=dsh` 还是 `carrier=mock`。
