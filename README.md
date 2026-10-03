# dsh-remote-control

在手机上远程操作 **DeepSeek Harness（DSH）**：下发指令、看流式输出、审批工具调用、回答问题，并让主机在任务跑完前**保持唤醒**。

载荷级端到端加密：中继从头到尾只看到 `base64(nonce ‖ secretbox)`，**没有任何密钥**——
不是"我们不查"，而是密钥在协议层的依赖图上就不可达（中继的构建产物里没有密码学代码，有测试锁住）。

> 这份代码是 2026-10-02 从零重写的产物：小程序 `mp/` 一行没改，其余全部重写，
> 旧实现只作为**需求与事实的来源**（`docs/legacy-spec/`）。设计与拍板见 `docs/DESIGN.md`，
> 接手请先读 `HANDOFF.md`。

## 组成

**伞仓不再持有源码副本**（2026-10-03）：产品代码的唯一事实源是 GitHub 上四个独立仓
（账号 `providcc`，MIT），在这台机器上是四个平行的顶层目录；本仓只剩**不开源的取证与运维资产**。

| 组成 | 位置 | 作用 |
|---|---|---|
| **协议层** | `dsh-remote-protocol/`（npm 包名 `dsh-remote-wire`） | 帧与载荷的 zod 定义 + E2E crypto（tweetnacl）+ 配对 URI + 防休眠命令构造器。**无 I/O、无定时器、不认识平台** |
| **中继服务** | `dsh-remote-server/` | 零知识 WebSocket 中继（`ws` + `zod`）。生产入口是**单文件产物** `dist/bundle/main.js` |
| **Host 插件** | `dsh-remote-control/packages/plugin` | 跑在 DSH 进程里的 cordis bundle：端口/适配器分层，产物是自包含单文件。**右栏自动弹码那一半已折进这个包**（`src/presentation/` + 浏览器面 `client/`，2026-10-03） |
| **小程序客户端** | `dsh-remote-mp/`（代码在它的 `miniprogram/` 下） | 微信小程序：配对 / 会话列表 / 对话 / 审批 / 提问 / 防休眠（**冻结，不改**） |
| **测试装置** | `e2e/`（伞仓） | 本地全链路 + 逐字节对拍 + 生命周期 + 真实链路取证（见「测试」） |
| **取证脚本** | `scripts/`（伞仓） | `validate-qr.mjs`（改二维码必跑）、`check-mp-ui.mjs`、`mp-*.mjs`、`read-session-log.mjs` |
| **设计与档案** | `docs/`、`HANDOFF.md`（伞仓） | 契约表 B1-B9 / F1-F13 / T1-T8、偏离 D1-D9、复核结论、旧实现事实档案 |
| **部署配置** | `deploy/`（伞仓） | nginx + systemd + 上线步骤（生产实例已运行） |

## 架构

```
┌──────────────────┐  wss + host token   ┌───────────────┐  wss + 配对码   ┌──────────────────┐
│  DSH 桌面应用      │ ─────────────────▶ │  relay server │ ◀────────────── │ 微信小程序        │
│  cordis bundle   │  只见密文与 6 位码   │               │                 │                  │
└──────────────────┘                     └───────────────┘                 └──────────────────┘
        │ caffeinate(macOS) / systemd-inhibit(Linux)；Windows 明确不实现
        ▼
   数据面载荷（dsh-remote-wire）
   cmd.list_sessions / cmd.send_prompt / cmd.interrupt / cmd.resolve_permission /
   cmd.answer / cmd.keep_awake   ⇄
   ev.session_changed / ev.message_delta / ev.tool_event / ev.permission_request /
   ev.question_request / ev.run_state / ev.keep_awake_state / ev.result
```

四棵仓的落位（这台机器上）：`dsh-remote-protocol/`、`dsh-remote-server/`、
`dsh-remote-control/`（内含 `packages/plugin`）、`dsh-remote-mp/`（内含 `miniprogram/`）。

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
- 跑的是 `dsh-remote-server` 仓 **Release 已发布的产物**（v1.0.1）：先 `shasum -c SHA256SUMS`
  校验再从 Release 下载， scp 上线后 `/healthz` 报 `version:"1.0.1"`，重启后 5 秒内 `hosts` 回 1
  （线上宿主插件自动重连）——"能换"是这么证的。私有那套 2.x 编号作废，以后只有开源的号。
- 配置与复现步骤：[`deploy/README.md`](deploy/README.md)
- 健康检查：`curl https://drc.provid.cc/healthz`

## 快速开始（开发）

四棵源码仓各自是**独立的 pnpm workspace**，没有顶层 workspace 把它们串起来（协议层是 npm 依赖
`dsh-remote-wire`，不是 git 依赖）。伞仓的 workspace 里只有 `e2e`。

```sh
# 逐仓装依赖 + 跑各自的闸门（都在仓根）
cd dsh-remote-protocol && env -u NODE_OPTIONS pnpm test                       # 82
cd ../dsh-remote-server  && env -u NODE_OPTIONS pnpm install --frozen-lockfile && pnpm test   # 78（1 skip）
cd ../dsh-remote-control && env -u NODE_OPTIONS pnpm install --frozen-lockfile && pnpm test   # 280
cd ../dsh-remote-mp      && env -u NODE_OPTIONS npm run check                                # verify/theme/contrast

# 伞仓：取证与运维
env -u NODE_OPTIONS pnpm -r test        # e2e 全部 *.test.mjs（112）+ 本地全链路 16 步
env -u NODE_OPTIONS node e2e/run.mjs    # 只跑本地全链路
```

`env -u NODE_OPTIONS` 是**必须**的：Qoder CLI 会往子 shell 注入一个 `--require` 的 CJS 代理，
Node 22 的 ESM loader 解析不了它，任何要解析依赖的调用都会挂（详见 `HANDOFF.md` §4）。

### 起本地中继 / 装插件

```sh
./dsh-remote-server/scripts/relay-start.sh            # 127.0.0.1:8787，token 复用 profile 里那一份
./dsh-remote-server/scripts/relay-start.sh --bundle    # 跑单文件产物，与生产形态一致

./dsh-remote-control/scripts/install-to-profile.sh      # 构建 + 装进 ~/.dsh/profiles/desktop + 注册 bundle
# 改代码后必须重启 Harness（HMR 只热更 patch，不重新 import dist）
```

安装脚本会顺手删掉 profile 里旧的 `"dsh-remote-control": "file:…"` 依赖：那条留着，
`pnpm install` 会把插件再物化一份进 profile，于是宿主里同时跑**两个实例**
（两个 hostId、两份会话，手机连到哪个全凭运气）。

### 配对与使用

1. DSH 里执行 `/drc pair`：**默认写出二维码图片**（`qrImage` 默认开），写到**当前会话工作区**的 `.dsh/pairing-qr.png`（工作区解析不出来时才落 `~/.dsh/pairing-qr.png`），**右栏会自动弹出当前配对码**（`dsh-remote-control/packages/plugin` 里的 `src/presentation/` + 浏览器面 `client/`；宿主没有 `webServer` 服务时这一半自己不起，配对/中继不受影响）——没弹出时先查 `status.json` 的 `sidebar` 那块（它会说 `webServer=none` / `disabled` / `register threw: …`），再按卡片给的路径打开那张 PNG 扫码。图片才是主路径：DSH 命令卡的行高会把半块文本码切成条、扫不出来；卡片同时给可粘贴的 `dshr:/p?…` 一行兜底，`qrOpen`（替你打开查看器）仍默认关；
2. 微信开发者工具打开 `dsh-remote-mp/`（`project.config.json` 在仓根，代码在 `miniprogram/`；TDesign 产物已预置在 `miniprogram/miniprogram_npm/`，**不需要**「构建 npm」；`appid` 是本项目自用的，fork 必须换成自己的）；
3. 首页扫码或粘贴二维码内容 → 自动连接；
4. 真机必须 `wss://`，且域名要在小程序后台的 **socket 合法域名** 白名单里。

详见 [`docs/MINI-PROGRAM.md`](docs/MINI-PROGRAM.md)。

## 测试

| 命令 | 覆盖 | 项数 |
|---|---|---|
| `cd dsh-remote-protocol && pnpm test` | 帧与载荷 schema、crypto、配对 URI、三平台防休眠命令、**新建会话** | 82 |
| `node --test e2e/protocol.test.mjs` | 与小程序 `miniprogram/core/codec.js` **逐字节对拍**（284 条向量 + 随机新向量 + 篡改 + 反证） | 18 |
| `cd dsh-remote-server && pnpm test` | 中继闭环 + 加固（限流、帧上限、顶号、优雅停机、孤儿会话、诊断计数）+ **产物级零知识断言** | 78（1 skip） |
| `cd dsh-remote-control && pnpm test` | 合帧窗口、密钥簿、配对码窗口四判据、配置校验、状态文件、事件词汇表、carrier 调用形状、历史分页、CONNECTING 期停机、**新建会话**，以及折并进来的右栏那一半（二维码落盘判据 / `expiresAt` 两种形状 / 会话作用域地址 / 路由**防环回与防跨作用域** / 浏览器面产物形状 / **缺 webServer 时主链路逐字段对照**） | 280 |
| `npm --prefix dsh-remote-mp run check` | 小程序三道闸：verify-miniprogram、theme:check、对比度 | 242 组达标 |
| `node e2e/run.mjs` | 本地全链路：真中继进程 + 真 `apply()` 入口 + 真小程序代码（内核面 mock） | 16 步 |
| `node --test e2e/*.test.mjs` | 握手/F8/F7/F3/审批闭环/提问闭环/多码并存/**重启续用**/历史分页/chat 块流/浅深主题/配对恢复 | 112 |
| `node e2e/live-e2e.mjs` | **三个真实**：真小程序代码 + 真中继 + 真内核。拿不到真材料就失败，绝不退化 mock | 18 项/轮 |
| `node scripts/validate-qr.mjs` | 二维码用 zxing-cpp 真实解码（网页图片 / 文本字形还原 / 裸矩阵三条路径） | 28 组 ×3 |

```sh
node e2e/live-e2e.mjs                       # 默认打生产入口
node e2e/live-e2e.mjs --rounds 3            # 每轮独立取一张新码
DRC_LIVE_RELAY=ws://127.0.0.1:8787 node e2e/live-e2e.mjs   # 打本地中继
node e2e/live-e2e.mjs --session <id>        # 指定会话（可验归档自动恢复）
```

> `pairOnStartSec` 默认是 `0`（不自发出码），所以裸跑会报"没有 pairing.qr"——先在 DSH 里
> 执行一次 `/drc pair`，再用 `--pair <6位> --qr '<dshr:/p?...>'` 把码喂进去。

CI 在**四个开源仓各自**的 `.github/workflows/` 里：主作业 Node 22（typecheck + test + 产物校验），
另一个作业在 Node 20 上从**空目录**起单文件产物，验 `/healthz` 的 version、优雅停机 exit 0、
以及"缺 token 必须拒绝启动"。装/查/打包固定走 Node 22（pnpm 11.7 要 node ≥22.13），
只有 `node --test` 跑在矩阵版本上——细节见 `HANDOFF.md` §4 第 2 条。
**伞仓没有 CI**：它没有 remote，而且 `e2e/` 需要四棵平行仓在场，GitHub 上拿不到。

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
