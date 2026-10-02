# dsh-remote-control

在手机上远程操作 **DeepSeek Harness（DSH）**：下发指令、看流式输出、审批工具调用、回答问题，并让主机在任务跑完前**保持唤醒**。

载荷级端到端加密：中继服务器从头到尾只看到 `base64(nonce ‖ secretbox)`，没有任何密钥。

## 组成

| 组成 | 目录 | 作用 |
|---|---|---|
| **Host 插件** | `packages/plugin` | 跑在 DSH 进程里的 cordis bundle：连接中继、桥接内核、防休眠 |
| **线协议** | `packages/protocol` | 帧定义 + E2E crypto（tweetnacl）+ 防休眠命令构造器 |
| **中继服务** | `apps/server` | 零知识 WebSocket 中继（`node:http` + `ws`，无构建步骤） |
| **小程序客户端** | `mp/` | 微信小程序：配对 / 会话列表 / 对话 / 审批 / 提问 / 防休眠开关（TDesign UI） |
| **端到端测试** | `e2e/` | 真实链路测试（见下文「测试」） |
| **部署配置** | `deploy/` | nginx + systemd + 上线步骤（生产实例已运行） |

## 架构

```
┌──────────────────┐   wss (host token)   ┌───────────────┐   wss (配对码)  ┌──────────────────┐
│  DSH 桌面应用      │ ──────────────────▶ │  relay server │ ◀────────────── │ 微信小程序        │
│  (cordis bundle) │   审计：只见密文      │  apps/server  │                 │  mp/             │
└──────────────────┘                      └───────────────┘                 └──────────────────┘
        │ 防休眠：macOS caffeinate / Linux systemd-inhibit（Windows 预留）
        ▼
   端到端加密数据面（@dsh-rc/protocol）
   cmd.list_sessions / cmd.send_prompt / cmd.answer / cmd.resolve_permission /
   cmd.interrupt / cmd.keep_awake / cmd.subscribe   ⇄
   ev.session_changed / ev.message_delta / ev.tool_event / ev.permission_request /
   ev.question_request / ev.run_state / ev.keep_awake_state / ev.result
```

**信任模型**

- 中继持有 `DRC_HOST_TOKEN`（host 出站认证）与配对码路由表，**没有载荷密钥**。
- 配对时 host 生成 16 字节 PSK，经二维码（`dshr:/p?s=…&psk=…&t=<6位码>`）交给小程序；
  双方各自派生 `c2h` / `h2c` 两个方向的会话密钥（`derivePskKey(psk, dir, convId)`）。
- 配对码 6 位、一次性、TTL 由服务端权威下发（默认 180s）。
- TLS 由部署方负责（nginx 反代 `wss://`）。详见 [`docs/SECURITY.md`](docs/SECURITY.md)。

## 生产实例（已上线）

- 入口：`wss://drc.provid.cc`（阿里云 cn-shanghai / ECS `47.100.82.15`）
- nginx 做 TLS 终止 + 按 IP 限流；中继经 systemd 运行、只绑 `127.0.0.1:8787`
- 证书：acme.sh + 阿里云 DNS-01，自动续期
- 配置与复现步骤：[`deploy/README.md`](deploy/README.md)
- 健康检查：`curl https://drc.provid.cc/healthz`

## 快速开始（开发）

```sh
cd /Users/linbin/dsh-remote-control
env -u NODE_OPTIONS pnpm install -r      # 必须加 env -u NODE_OPTIONS，见 HANDOFF §4
env -u NODE_OPTIONS pnpm -r build
env -u NODE_OPTIONS pnpm -r test          # 83 项单测
node e2e/run.mjs                          # relay e2e 9 步
```

### 起本地中继

```sh
./scripts/relay-start.sh        # 自动从 desktop profile 的 cordis.patch.yml 读同一个 token
DRC_PORT=9000 ./scripts/relay-start.sh
```

### 安装 / 更新 host 插件

```sh
./scripts/install-to-profile.sh  # 构建 + 装进 ~/.dsh/profiles/desktop + 注册 bundle
# 改代码后必须重启 Harness 才生效（HMR 不重载 dist）
```

不要只跑 `pnpm add`：pnpm 对 `file:` 依赖是硬链接拷贝，tsc 重建后 inode 变化，
profile 里仍是旧副本——脚本里已处理（先删再装）。

### 配对与使用

1. DSH 里执行 `/drc pair`（终端直接渲染可扫二维码，默认内嵌 6 位配对码）；
2. 微信开发者工具打开 `mp/`（appid 已配置；TDesign 产物已预置在
   `mp/miniprogram_npm/`，**不需要**「构建 npm」）；
3. 小程序首页扫码或粘贴二维码内容 → 自动连接；
4. 真机必须 `wss://`，且域名要在小程序后台 **socket 合法域名** 白名单里。

详见 [`docs/MINI-PROGRAM.md`](docs/MINI-PROGRAM.md)。

## 测试

| 命令 | 覆盖 | 项数 |
|---|---|---|
| `pnpm -r test`（protocol） | 加密、篡改检测、配对 QR、三平台防休眠命令 | 11 |
| `pnpm -r test`（plugin） | 激活降级、carrier 选择、配置校验、状态文件、终端二维码、会话列表/归档、事件窗口 | 36 |
| `pnpm -r test`（server） | 中继闭环 + 加固行为（限流、帧上限、优雅停机、孤儿会话清理） | 13 |
| `node --test e2e/mp-crypto.test.mjs` | 小程序 crypto 与 Node **逐字节对拍** | 11 |
| `node --test e2e/mp-client.test.mjs` | 真实小程序客户端代码（wx shim）走完整闭环 | 8 |
| `node --test e2e/mp-platform.test.mjs` | 无 `connectSocket` 容器的探测与回退 | 3 |
| `node --test e2e/multi-pair.test.mjs` | 多配对码并存时按码取 PSK（回归） | 1 |
| `node e2e/run.mjs` | 真实 server + HostRuntime + 模拟小程序 + 零知识审计 | 9 步 |
| `node e2e/live-e2e.mjs` | **三个真实**：真实 mp 客户端代码 + 线上中继 + 真实内核，绝不退化 mock | 10 项/轮 |
| `node scripts/validate-qr.mjs` | 二维码 zxing-cpp 真实解码 | 28 组 |

`live-e2e` 是最有说服力的一条——配对 → 真实会话列表 → 真实发指令 → 流式输出 → 零知识审计：

```sh
node e2e/live-e2e.mjs                      # 完整闭环
node e2e/live-e2e.mjs --rounds 3           # 连跑查稳定性
node e2e/live-e2e.mjs --session <id>       # 指定会话（可测归档会话自动恢复）
node e2e/live-e2e.mjs --pair <码> --qr '<dshr:…>'   # 手动给码
```

CI：`.github/workflows/ci.yml`（Node 20 / 22）。

## 防休眠

`KeepAwake` 只在「会话运行中 / 有审批或提问挂起」时持锁，空闲 `idleReleaseSec`
（默认 300s）后自动释放，本地空闲时机器照常睡眠。

| 平台 | 实现 |
|---|---|
| macOS | `/usr/bin/caffeinate -i -s -w <pid>`（无需 sudo） |
| Linux | `systemd-inhibit --what=idle:sleep --mode=block` |
| Windows | 预留（默认关闭） |

## 运行状态自检

插件写状态快照 `~/.dsh/dsh-remote-control/status.json`（Harness 是 GUI，stdout 没人看）：

```sh
cat ~/.dsh/dsh-remote-control/status.json
# 关键字段：carrier（services=真实内核 / mock=假会话）、relay、relayProblem、sessions
```

## 文档

- [`HANDOFF.md`](HANDOFF.md) — **交接文档**：当前状态、踩坑清单、读码顺序、待办（开发 agent 先读这个）
- [`docs/SECURITY.md`](docs/SECURITY.md) — 威胁模型与加固清单
- [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) — 自托管中继
- [`docs/MINI-PROGRAM.md`](docs/MINI-PROGRAM.md) — 小程序客户端结构、握手流程、故障表
- [`deploy/README.md`](deploy/README.md) — 生产部署
- [`packages/plugin/README.md`](packages/plugin/README.md) — 插件配置项

## License

MIT — 见 [`LICENSE`](LICENSE)。
