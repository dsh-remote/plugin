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
| **中继服务** | `dsh-remote-server/` | 零知识 WebSocket 中继。生产入口是**单文件产物** `dist/bundle/main.js`（`ws`/`zod`/协议层都内联在里面，运行时零依赖）。分发只有 GitHub Release 的那个单文件与从源码构建两条：**本仓不发 npm**，`dsh-remote-server` 这个包名属于另一个无关项目，别照抄任何 `npm i -g` 的写法 |
| **Host 插件** | `dsh-remote-control/packages/plugin` | 跑在 DSH 进程里的 cordis bundle：端口/适配器分层，产物是自包含单文件。**界面上那一半已折进这个包**（`src/pill/` + 浏览器面 `client/`）：状态栏那颗写"未配对 / 已配对"的 pill 是**配对的唯一入口**（右栏自动弹码与终端文本码 2026-10-03 删除） |
| **小程序客户端** | `dsh-remote-mp/`（代码在它的 `miniprogram/` 下） | 微信小程序：配对 / 会话列表 / 对话 / 审批 / 提问 / 防休眠 |
| **测试装置** | `e2e/`（伞仓） | 本地全链路 + 逐字节对拍 + 生命周期 + 真实链路取证（见「测试」） |
| **取证脚本** | `scripts/`（伞仓） | `validate-qr.mjs`（改二维码必跑）、`check-mp-ui.mjs`、`mp-*.mjs` |
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
- 跑的是 `dsh-remote-server` 仓 **Release 已发布的产物**（线上 v1.0.6，rc1 已发布待切）：
  先 `shasum -c SHA256SUMS` 校验再从 Release 下载，scp 上线后 `/healthz` 报该版本号，
  重启后 5 秒内 `hosts` 回 1（线上宿主插件自动重连）——"能换"是这么证的。
  **私有那套编号全部作废**，四仓统一用同一个版本号（当前 `2.0.14`）。
  ⚠️ 注意 npm 上 `1.0.1`～`1.9.0`、`2.0.0`～`2.0.13` **都已被私有期占用**，不可重用；
  发版前跑 `node scripts/next-version.mjs --check`（它会算出下一个**大于**所有已发布、
  且两个包上都空着的号）。
- 1.0.6 起会话表落盘（`DRC_STATE_FILE`，中继重启不再丢配对）：`/healthz` 多五个字段
  `persistence` / `stateRestored` / `stateSavedAtSec` / `stateWrites` / `stateWriteFailures`
 （换完机器先看 `stateWriteFailures`，不是 0 就是没在写）。
- 配置与复现步骤：[`deploy/README.md`](deploy/README.md)
- 健康检查：`curl https://drc.provid.cc/healthz`

## 快速开始（开发）

四棵源码仓各自是**独立的 pnpm workspace**，没有顶层 workspace 把它们串起来（协议层是 npm 依赖
`dsh-remote-wire`，不是 git 依赖）。伞仓的 workspace 里只有 `e2e`。

```sh
# 逐仓装依赖 + 跑各自的闸门（都在仓根）
cd dsh-remote-protocol && env -u NODE_OPTIONS pnpm test                       # 152
cd ../dsh-remote-server  && env -u NODE_OPTIONS pnpm install --frozen-lockfile && pnpm test   # 175（1 skip）
cd ../dsh-remote-control && env -u NODE_OPTIONS pnpm install --frozen-lockfile && pnpm test   # 494
cd ../dsh-remote-mp      && env -u NODE_OPTIONS npm run check                                # verify/theme/contrast

# 伞仓：取证与运维
env -u NODE_OPTIONS pnpm -r test        # e2e 全部 *.test.mjs（311）+ 本地全链路 17 步
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

1. **点状态栏那颗 `dsh-remote-control`**（输入框那一排，`@chaoset/provider-usage` 那颗用量 pill 旁边）：抬头那句是连接状态（`远程未启动` / `已断开连接` / `连接中` / `未配对` / `已配对`，灯分别是灰 / **红** / 黄 / 灰 / 绿——断链是故障，不跟"还没配上"共用灰）。点一下弹面板——面板刻意精简：**右上角只有一颗按钮**，它跟着当前视图走（**未配对时叫「生成配对码」、已配对时叫「退出配对」、正在出二维码时叫「刷新」**），下面三行是**中继地址 / 中继状态 / 版本号**（各自拿不到值时那一行不占地方）；面板里**没有**本机名 / 台数那几行，也**没有**「再配一台」。按下「生成配对码」后，二维码与 6 位数字出现在同一块面板里（码过期**不再自动换**，要按右上角那颗「刷新」）；按下「退出配对」当场作废主机手上的配对会话；手机上刚扫完码、面板**当场从二维码翻回状态视图**（那一张码已经没用了）。这条路走的是宿主侧**四条**同域路由（`POST …/pairing/new` 幂等发码、`GET …/pairing.png` 现渲染、`GET …/status` 抬头状态、`POST …/unpair` 退出配对）——**四条回答里都没有 `psk`，也没有完整配对 URI**；点开时**不会**顺手发码，发码必须是那一次显式的按下；
2. **同一时刻只允许配对一台**：一台新设备配对成功时，主机当场作废它手里**其它**配对会话——旧手机下一帧就撞上「需重新配对」；
3. **命令行没有配对入口**：`/drc` 命令在 2026-10-03 **整条删掉**（连更早删掉的 `/drc pair`、终端文本码、右栏自动弹码三条旧路）——命令行那条走的是"每次发一张新码"，会在 pill 那张之外再多挂一个仍然有效的 PSK，而手机扫的是屏幕上那张；
4. **那颗 pill 没出现时怎么查**：先看 `status.json` 的 `pill` 探针（`webServer:"none"` / `"get threw: …"` / `"object without register()"` / `routes:"register threw: …"` / `pill:"disabled"`）——它不是 `routes:"registered"` 时就一定同时有一条 `warn:pill`。浏览器面那一半（向装载器拿 `react`、拿 `slots`）失败只在 DevTools 里留一行 `[dsh-remote-control pill]` 开头的 warn，宿主侧看不见。图片是唯一出口：DSH 命令卡的行高会把半块文本码切成条、扫不出来；
5. 微信开发者工具打开 `dsh-remote-mp/`（`project.config.json` 在仓根，代码在 `miniprogram/`；TDesign 产物已预置在 `miniprogram/miniprogram_npm/`，**不需要**「构建 npm」；`appid` 是本项目自用的，fork 必须换成自己的）；
6. 首页扫码或粘贴二维码内容 → 自动连接；
7. 真机必须 `wss://`，且域名要在小程序后台的 **socket 合法域名** 白名单里。

详见 [`docs/MINI-PROGRAM.md`](docs/MINI-PROGRAM.md)。

## 测试

| 命令 | 覆盖 | 项数 |
|---|---|---|
| `cd dsh-remote-protocol && pnpm test` | 帧与载荷 schema、crypto、配对 URI、三平台防休眠命令、**新建会话** | 152 |
| `node --test e2e/protocol.test.mjs` | 与小程序 `miniprogram/core/codec.js` **逐字节对拍**（284 条向量 + 随机新向量 + 篡改 + 反证） | 18 |
| `cd dsh-remote-server && pnpm test` | 中继闭环 + 加固（限流、帧上限、顶号、优雅停机、孤儿会话、诊断计数）+ **产物级零知识断言** + **分发决策闸门**（本仓不发 npm：`private` 必须为 true、工作流里不许出现 publish 步骤；运行时依赖为空、shebang 在第一行）+ **容器产物闸门**（两条 FROM 同源、非 root、HEALTHCHECK 判 `ok` 字段、runtime 阶段零依赖、产物断言在构建里、端口只发布回环、`DRC_STATE_FILE` 与卷成对、加固项与 systemd 同口径、`.dockerignore` 该裁的裁该留的留）+ **本轮深审**（两条未认证崩溃打崩进程 / 三处日志洪水 / 配对码一次性与归属 / 落盘 fsync 与未来时间戳 / 时钟回拨冻死限流 / 配置原型链与空串 / 停机排空 / `--version`） | 175（1 skip） |
| `cd dsh-remote-control && pnpm test` | 合帧窗口、密钥簿、配对码窗口四判据、配置校验、状态文件、事件词汇表、carrier 调用形状、历史分页、CONNECTING 期停机、**新建会话**、**cmdId 去重**（GAP-4），以及界面上那一半（pill 的四条路由：发码幂等 / 解配幂等 / 写路由的跨站判据是**同源才发得出的自定义头**而不是 `Origin` / 回答里不许出现凭据 / 半途挂不上要回滚已挂的 / 浏览器面产物形状 / **缺 webServer 时主链路逐字段对照 + 一个命令都不许注册 + 配对入口不可用必须留 warn + `webServer` 晚到时 warn 必须自己消失** / **`slots` 晚到时那颗 pill 必须补挂** / **dock 挤不下时那颗 pill 只许省略号不许逐字断行** / **样式表按内容对齐：宿主热更这一半而文档没重载时旧 CSS 必须被换掉** / **配上之后面板从二维码翻回状态视图** / **正文就那三行（中继/状态/版本）且各自拿不到值时不占地方** / **`状态` 按 relay 取值翻译**) | 494 |
| `npm --prefix dsh-remote-mp run check` | 小程序**五道闸**（`check` = verify + md + scroll + theme:check + contrast）：verify-miniprogram 结构自检（JSON / 页面 / 组件引用 / 自研 JS 的声明一致性）、markdown 渲染（35 项）、**滚动策略（14 项，纯函数层）**、theme:check（主题文件与生成器同步）、对比度（304 组） | 全过 |
| `node e2e/run.mjs` | 本地全链路：真中继进程 + 真 `apply()` 入口 + 真小程序代码（内核面 mock）。**跑之前先过产物新鲜度闸门**（逐文件比对 src↔dist 的 mtime：改了 src 没 build 时直接红，测的不是旧产物） | 17 步 |
| `node --test e2e/*.test.mjs` | 握手/F8/F7/F3/审批闭环/提问闭环/多码并存/**重启续用**/历史分页/chat 块流/浅深主题/配对恢复/**本轮深审**（nonce 复用 / 弱密钥 / 状态撕裂 / 畸形帧 / 帧预算转义膨胀 / 带附件回放漏去重 / 重连视口 / 秒表冻住 / 附件入口守卫）+ **容器化的部署同步**（`deploy/docker/` 逐字节镜像 + bind/回环发布/状态目录属主三条硬约束）+ **握手面加性判据**（老 schema 收新 hello / 依赖 zod strip 语义 / 能力 id 不进帧路由 / 未知能力照收 / MIN ≤ PROTOCOL） | 341 |
| `node e2e/live-e2e.mjs` | **三个真实**：真小程序代码 + 真中继 + 真内核。拿不到真材料就失败，绝不退化 mock ⚠️ **会把你自己那台手机踢下线**（见下方用法块前的警告） | 18 项/轮 |
| `node scripts/next-version.mjs --check` | 发版前的**版本号闸**：该号在两个 npm 包上都**没发过**，且**大于**所有已发布版本，各仓版本号一致（否则 `latest` 退回去，或 npm 直接拒绝）。**发版之后它会对当前版本号报红——那是正确的**，因为已发过的号不能再发一遍 | 退出码 |
| `node scripts/validate-qr.mjs` | 二维码用 zxing-cpp 真实解码（**图片 PNG / 裸矩阵两条路径**；文本字形那条已随文本码一起删掉） | 28 组 ×2 |

> ⚠️ **这一组命令会把你自己手机上的那条通道当场踢掉。** 它用的是你本机 Harness 里跑着的
> **真插件**，而主机的配对策略是「只允许一台」（新设备一进来就作废其余通道，
> 见 `index.ts` 的 `onPeerJoined`）。于是用户手机会显示「主机已断开，请重新配对」，
> 而且**没有任何提示说这是被这个脚本踢的**——要重扫一次码才能恢复。
>
> 这不是 `--unpair` 造成的（那个只在跑完之后收掉测试自己那条，默认不收），
> 是**配对本身**造成的。跑之前先确认那台手机此刻不需要连着。

```sh
node e2e/live-e2e.mjs                       # 默认打生产入口
node e2e/live-e2e.mjs --rounds 3            # 每轮独立取一张新码
DRC_LIVE_RELAY=ws://127.0.0.1:8787 node e2e/live-e2e.mjs   # 打本地中继
node e2e/live-e2e.mjs --session <id>        # 指定会话（可验归档自动恢复）
```

> `pairOnStartSec` 默认是 `0`（**启动时不自动发码**；点 pill 发的那张照样会写进 `status.json` 的
> `pairing`），所以裸跑会报"没有 pairing.qr"——先在 DSH 里点一下状态栏那颗 pill
> （或临时开 `pairOnStartSec` 让它启动就发一张），再用 `--pair <6位> --qr '<dshr:/p?...>'` 把码喂进去。

CI 在**四个开源仓各自**的 `.github/workflows/` 里：主作业 Node 22（typecheck + test + 产物校验），
另一个作业在 Node 20 上从**空目录**起单文件产物，验 `/healthz` 的 version、优雅停机 exit 0、
以及"缺 token 必须拒绝启动"。装/查/打包固定走 Node 22（pnpm 11.7 要 node ≥22.13），
只有 `node --test` 跑在矩阵版本上——细节见 `HANDOFF.md` §4 第 2 条。
**伞仓没有 CI**：它没有 remote，而且 `e2e/` 需要四棵平行仓在场，GitHub 上拿不到。

### 上面那张表怎么不漂

「项数」那一列只在你真跑过之后才知道，而跑一遍要四个仓各自 build+test——所以它过去
漂过好几次（92→106、448→457、255→262、对比度 302→304、471→490→494、311→334→341、132→164→175），每次都是"加了判据忘了改文档"。
为此有一条命令：

```sh
env -u NODE_OPTIONS pnpm gates        # = node scripts/report-gates.mjs
```

它把上表六道闸门**各跑一遍**，打印实测值并与 README 逐格比对，对不上就 **exit 1**
（锚点失效也会红，并把失效的锚点打出来）。所以：加完判据跑一次它，照着表里的数改
「快速开始」那一节的行尾注释和测试表两处，然后它就是绿的。

它**没有**进 `pnpm -r test`——它自己就要跑那五道闸门，塞进去会递归。定位是
"发版前 / 改完判据后跑一次"。

### 不跑也能核的那部分：readme-claims

伞仓里另有三条同类判据，都不需要跑一遍就能核对，但每一类都是"**静默失配**"：

| 判据 | 守住什么 |
|---|---|
| `e2e/readme-claims.test.mjs` | README 与 `docs/PRODUCT.md`：四条宿主路由的条数与路径、`/healthz` 落盘五字段、mp `check` 链上的每一道闸都被点名、本地全链路步数、「文档」小节的链接、四份文档的表格没有残缺行；`docs/SECURITY.md` 的每一条代码引用都指向真实文件；PRODUCT.md 不把**已实现**的事留在「明确不做/待办」里；以及 `scripts/` 与 `e2e/` 下每个 `.mjs` 都能被 `node --check` 解析、README 提到的每个 `scripts/*.mjs` 都真的存在（这些开发工具一行判据都没有，坏掉要等到有人真的需要它那天） |
| `e2e/wire-surface.test.mjs` | 小程序引用的每个 `ev.*` / `cmd.*` 在协议层都存在，且协议层的每个都被小程序引用过——分发是一条**没有 else** 的 if 链，失配的表现是「什么都不发生」；以及附件条数上限在协议层 / 小程序 / 主机三处是同一个数（各写一遍的 `4`，没有任何东西连着） |
| `e2e/frame-budget.test.mjs` | 生产端三处体积预算（mp 附件顶格 / 一帧流式增量 / 一整页历史）与中继那条 1 MiB 硬帧上限的关系，用**真实 `seal()`** 量而不是公式估；以及 mp 发送前的帧闸必须装得下附件能产出的最坏帧 |
| `e2e/host-config-docs.test.mjs` | `docs/HOST-SIDE.md` 配置表与 `shell/config.ts` 逐项对齐：表里的键代码里存在、代码里的键表里点名、`DRC_*` 双向对得上——插件配置是"写了不报错、不告警、不生效"那一类 |

它的由来是一次真实漂移：`check` 实际是四道闸而 README 写着「三道」、那个「32 项」
其实属于 markdown 闸——两句都读起来完全合理，靠"看一眼"发现不了，只有**数一遍**才会现形。

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
`relay` + `relayProblem`、`outbound`（按载荷类型的出站计数）、`pairing`（**只要屏幕上挂着一张码就有**：点 pill 发的那张同样会写进去，`pairOnStartSec` 只决定"启动时要不要自动发一张"）、
`kernel.eventTypes` / `kernel.unmappedEventTypes`（分清"内核没发"还是"我们没认"）、
`kernel.listenerErrors`、`kernel.approvalFace` / `questionsFace`（人工交互两面到底登记上没有）。

## 文档

- [`HANDOFF.md`](HANDOFF.md) — **交接文档**：当前状态、踩坑清单、读码顺序、待办（先读这个）
- [`docs/DESIGN.md`](docs/DESIGN.md) — 重写设计：冻结契约表、偏离清单 D1-D9、分层与阶段门禁
- [`docs/DESIGN-REVIEW.md`](docs/DESIGN-REVIEW.md) — 对设计的独立复核（哪几处判据不足以守住什么）
- [`docs/legacy-spec/`](docs/legacy-spec/) — 旧实现的**需求与事实档案**（不是参考代码）
- [`docs/SECURITY.md`](docs/SECURITY.md) / [`docs/MINI-PROGRAM.md`](docs/MINI-PROGRAM.md)
- [`docs/HOST-SIDE.md`](docs/HOST-SIDE.md) — **本机宿主侧**：profile 安装、配置键表、`status.json` 排错、pill 四条路由与真机取证配方
- [`docs/PRODUCT.md`](docs/PRODUCT.md) — **产品定义**：三条承诺与由它们推出的「30 秒原则」判据，以及现在还差什么
- [`docs/HOST-CAPABILITIES.md`](docs/HOST-CAPABILITIES.md) — 宿主能力面（30 服务 / 140 方法）的取证来源与 P0/P1 结论
- [`docs/BOOTSTRAP-ASSESSMENT.md`](docs/BOOTSTRAP-ASSESSMENT.md) — 2026-10-04 对"免扫码重连 + appid 自适应配对"的评估（结论已落地，是**决策记录**不是待办）
- [`docs/EXPANSION-PLAN.md`](docs/EXPANSION-PLAN.md) — 2026-10-07 的**扩展示划**：多 profile（web/tui）、三平台（win/linux/mac）、自建中继的取证与计划。含终端 ASCII 二维码的实测数据（行高 1.0 可解、TUI 的投递面只有一行）。**是计划与决策记录，尚未实现**
- 中继侧部署手册在开源仓：[`dsh-remote-server/docs/SELF-HOSTING.md`](dsh-remote-server/docs/SELF-HOSTING.md)（伞仓那份旧命名副本 2026-10-03 已删）
- [`deploy/README.md`](deploy/README.md) — 生产部署

## License

MIT — 见 [`LICENSE`](LICENSE)。
