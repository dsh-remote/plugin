# dsh-remote-control

在手机上远程操作 **DeepSeek Harness（DSH）**：下发指令、看流式输出、审批工具调用、回答问题，并让主机在任务跑完前**保持唤醒**。

载荷级端到端加密：中继从头到尾只看到 `base64(nonce ‖ secretbox)`，**没有任何密钥**——
不是"我们不查"，而是密钥在协议层的依赖图上就不可达（中继的构建产物里没有密码学代码，有测试锁住）。

> 这份代码是 2026-10-02 从零重写的产物：小程序 `mp/` 一行没改，其余全部重写，
> 旧实现只作为**需求与事实的来源**（`docs/legacy-spec/`）。设计与拍板见 `docs/DESIGN.md`，
> 接手请先读 `HANDOFF.md`。

## 组成

| 组成 | 目录 | 作用 |
|---|---|---|
| **协议层** | `packages/protocol` | 帧与载荷的 zod 定义 + E2E crypto（tweetnacl）+ 配对 URI + 防休眠命令构造器。**无 I/O、无定时器、不认识平台** |
| **中继服务** | `apps/server` | 零知识 WebSocket 中继（`ws` + `zod`）。生产入口是**单文件产物** `dist/bundle/main.js` |
| **Host 插件** | `packages/plugin` | 跑在 DSH 进程里的 cordis bundle：端口/适配器分层，产物是自包含单文件 |
| **小程序客户端** | `mp/` | 微信小程序：配对 / 会话列表 / 对话 / 审批 / 提问 / 防休眠（**冻结，不改**） |
| **测试装置** | `e2e/` | 本地全链路 + 真实链路取证（见「测试」） |
| **部署配置** | `deploy/` | nginx + systemd + 上线步骤（生产实例已运行） |

## 架构

```
┌──────────────────┐  wss + host token   ┌───────────────┐  wss + 配对码   ┌──────────────────┐
│  DSH 桌面应用      │ ─────────────────▶ │  relay server │ ◀────────────── │ 微信小程序        │
│  cordis bundle   │  只见密文与 6 位码   │  apps/server  │                 │  mp/             │
└──────────────────┘                     └───────────────┘                 └──────────────────┘
        │ caffeinate(macOS) / systemd-inhibit(Linux)；Windows 明确不实现
        ▼
   数据面载荷（@dsh-rc/protocol）
   cmd.list_sessions / cmd.send_prompt / cmd.interrupt / cmd.resolve_permission /
   cmd.answer / cmd.keep_awake   ⇄
   ev.session_changed / ev.message_delta / ev.tool_event / ev.permission_request /
   ev.question_request / ev.run_state / ev.keep_awake_state / ev.result
```

**信任模型**

- 中继持有 `DRC_HOST_TOKEN`（主机注册凭据）与配对码路由表，没有载荷密钥。
- 配对时主机生成 16 字节 PSK，只经**二维码**交给手机（`dshr:/p?v=1&s=…&n=…&psk=…&t=<6位码>`）；
  PSK 从不上网（这是与旧实现最大的不同，`docs/DESIGN.md` §4 的 D1）。
- 双方各自从 `(psk, 方向, convId)` 派生 `c2h` / `h2c` 两把密钥；手机用计数器 nonce，
  因为小程序没有 CSPRNG（冻结项 B6）。
- 配对码 6 位、一次性、TTL 由**服务端权威**下发。
- TLS 由部署方负责（nginx 反代 `wss://`）。威胁模型与加固清单见 [`docs/SECURITY.md`](docs/SECURITY.md)。

## 生产实例（已上线）

- 入口：`wss://drc.provid.cc`（阿里云 cn-shanghai / ECS `47.100.82.15`）
- 跑的是重写后的单文件产物（`version` 可在 `/healthz` 里核对）
- 配置与复现步骤：[`deploy/README.md`](deploy/README.md)
- 健康检查：`curl https://drc.provid.cc/healthz`

## 快速开始（开发）

```sh
env -u NODE_OPTIONS pnpm install            # 必须 env -u NODE_OPTIONS，见 HANDOFF §4
env -u NODE_OPTIONS pnpm -r typecheck       # 类型（build 绿不等于类型对）
env -u NODE_OPTIONS pnpm -r test            # 协议 76 / 中继 62 / 插件 173 / e2e 50
env -u NODE_OPTIONS node e2e/run.mjs        # 本地全链路 13 步
```

### 起本地中继 / 装插件

```sh
./scripts/relay-start.sh            # 127.0.0.1:8787，token 复用 profile 里那一份
./scripts/relay-start.sh --bundle    # 跑单文件产物，与生产形态一致

./scripts/install-to-profile.sh      # 构建 + 装进 ~/.dsh/profiles/desktop + 注册 bundle
# 改代码后必须重启 Harness（HMR 只热更 patch，不重新 import dist）
```

安装脚本会顺手删掉 profile 里旧的 `"dsh-remote-control": "file:…"` 依赖：那条留着，
`pnpm install` 会把插件再物化一份进 profile，于是宿主里同时跑**两个实例**
（两个 hostId、两份会话，手机连到哪个全凭运气）。

### 配对与使用

1. DSH 里执行 `/drc pair`：**二维码直接出在命令的文本输出里**（半块字符，另附可粘贴的 `dshr:/p?…` 一行）；写图片与打开查看器是 `qrImage`/`qrOpen` 显式开启才有的旁路，默认关；
2. 微信开发者工具打开 `mp/`（TDesign 产物已预置在 `mp/miniprogram_npm/`，**不需要**「构建 npm」）；
3. 首页扫码或粘贴二维码内容 → 自动连接；
4. 真机必须 `wss://`，且域名要在小程序后台的 **socket 合法域名** 白名单里。

详见 [`docs/MINI-PROGRAM.md`](docs/MINI-PROGRAM.md)。

## 测试

| 命令 | 覆盖 | 项数 |
|---|---|---|
| `pnpm --filter @dsh-rc/protocol test` | 帧与载荷 schema、crypto、配对 URI、三平台防休眠命令 | 76 |
| `node --test e2e/protocol.test.mjs` | 与小程序 `mp/core/codec.js` **逐字节对拍**（284 条向量 + 随机新向量 + 篡改 + 反证） | 18 |
| `pnpm --filter @dsh-rc/server test` | 中继闭环 + 加固（限流、帧上限、顶号、优雅停机、孤儿会话）+ **产物级零知识断言** | 62 |
| `pnpm --filter dsh-remote-control test` | 合帧窗口、密钥簿、配对码窗口四判据、配置校验、状态文件、事件词汇表、carrier 调用形状 | 173 |
| `node e2e/run.mjs` | 本地全链路：真中继进程 + 真 `apply()` 入口 + 真小程序代码（内核面 mock） | 13 步 |
| `node --test e2e/*.test.mjs` | 握手/F8/F7/F3/审批闭环/提问闭环/多码并存/**重启续用**（客户端重连、中继重启、主机重启） | 50 |
| `node e2e/live-e2e.mjs` | **三个真实**：真小程序代码 + 真中继 + 真内核。拿不到真材料就失败，绝不退化 mock | 18 项/轮 |
| `node scripts/validate-qr.mjs` | 二维码用 zxing-cpp 真实解码（终端矩阵 + PNG） | 28 组 |

```sh
node e2e/live-e2e.mjs                       # 默认打生产入口
node e2e/live-e2e.mjs --rounds 3            # 每轮独立取一张新码
DRC_LIVE_RELAY=ws://127.0.0.1:8787 node e2e/live-e2e.mjs   # 打本地中继
node e2e/live-e2e.mjs --session <id>        # 指定会话（可验归档自动恢复）
```

CI：`.github/workflows/ci.yml`——主作业 Node 22（`pnpm -r typecheck` + `pnpm -r test` + 三层 e2e），
另一个作业在 Node 20 上从**空目录**起单文件产物，验 `/healthz` 的 version、优雅停机 exit 0、
以及"缺 token 必须拒绝启动"。

## 防休眠

`KeepAwake` 只在「会话运行中 / 有审批或提问挂起」时持锁，空闲 `idleReleaseSec`（默认 300s）后释放。

| 平台 | 实现 |
|---|---|
| macOS | `/usr/bin/caffeinate -i -s -w <pid>`（无需 sudo） |
| Linux | `systemd-inhibit --what=idle:sleep --mode=block` |
| Windows | **明确不实现**（拍板记录在 `docs/DESIGN.md` §8），`sleepInhibit` 返回 null |

## 运行状态自检

插件写状态快照 `~/.dsh/dsh-remote-control/status.json`（GUI 宿主里 stdout 没人看，这是唯一排错入口）：

```sh
cat ~/.dsh/dsh-remote-control/status.json
```

值得看的字段：`carrier`（`services`=真内核 / `mock`=内存替身 / `none`=没起来）、
`relay` + `relayProblem`、`outbound`（按载荷类型的出站计数）、`pairing`（开 `pairOnStartSec` 时才有）、
`kernel.eventTypes` / `kernel.unmappedEventTypes`（分清"内核没发"还是"我们没认"）、
`kernel.listenerErrors`、`kernel.approvalFace` / `questionsFace`（人工交互两面到底登记上没有）。

## 文档

- [`HANDOFF.md`](HANDOFF.md) — **交接文档**：当前状态、踩坑清单、读码顺序、待办（先读这个）
- [`docs/DESIGN.md`](docs/DESIGN.md) — 重写设计：冻结契约表、偏离清单 D1-D9、分层与阶段门禁
- [`docs/DESIGN-REVIEW.md`](docs/DESIGN-REVIEW.md) — 对设计的独立复核（哪几处判据不足以守住什么）
- [`docs/legacy-spec/`](docs/legacy-spec/) — 旧实现的**需求与事实档案**（不是参考代码）
- [`docs/SECURITY.md`](docs/SECURITY.md) / [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) / [`docs/MINI-PROGRAM.md`](docs/MINI-PROGRAM.md)
- [`deploy/README.md`](deploy/README.md) — 生产部署

## License

MIT — 见 [`LICENSE`](LICENSE)。
