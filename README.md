# dsh-remote-control

[![CI](https://github.com/providcc/dsh-remote-control/actions/workflows/ci.yml/badge.svg)](https://github.com/providcc/dsh-remote-control/actions/workflows/ci.yml)
[![npm: dsh-remote-control](https://img.shields.io/npm/v/dsh-remote-control.svg)](https://www.npmjs.com/package/dsh-remote-control)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**DSH Remote Control** 的宿主侧——跑在 DeepSeek Harness 里的 cordis 插件。它把本机的 DSH 与
零知识中继配对，让微信小程序可以**发指令、看流式输出、回答审批**，全程载荷级端到端加密。

> EN: the host-side plugin for DSH Remote Control (a cordis bundle for DeepSeek Harness).
> Pair your DSH over a zero-knowledge relay and drive it from a WeChat Mini Program —
> send prompts, watch streaming output, approve tool calls. Payload-level end-to-end encrypted.

本仓**只有一个包**：`dsh-remote-control`（发 npm）。它一次构建产出**两半产物**——宿主侧
`dist/bundle/index.js` 与浏览器面 `dist/bundle/client.cjs`，都由
[`scripts/install-to-profile.sh`](./scripts/install-to-profile.sh) 装进 profile：

| 路径                                   | 包名                 | 分发方式         | 作用                                                                                                                                                                    |
| -------------------------------------- | -------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/plugin`](./packages/plugin) | `dsh-remote-control` | **npm** + bundle | 主插件：配对、中继连接、会话与命令、审批转发、防休眠，**外加**界面上的那一半：状态栏那颗写"未配对 / 已配对 / 已断开连接"的 pill（四条同域路由 + 浏览器面 `client.cjs`） |

> 界面上那一半原来是一个独立的 cordis 条目（包名带 `-presentation` 后缀，从未发到 npm）。
> 拆包只是为了"某一代宿主没有 `webServer` 服务时，只有那一行不激活、配对/中继一行都不受影响"；
> 折成一个包之后同样的隔离由代码提供——`src/pill/start.ts` 只软探测 `webServer`，
> 拿不到就整半不起，`tests/pill-isolation.test.ts` 用逐字段对照把这条钉住。
> 那一半原来还带着"右栏自动弹码"（宿主按节拍渲染 PNG 落到会话工作区、浏览器面轮询后顶开右栏）；
> 2026-10-03 连终端文本码一起删了，**配对入口只剩这颗 pill**。

其余两半在各自仓库：[`dsh-remote-server`](https://github.com/providcc/dsh-remote-server)（零知识中继）、
[`dsh-remote-mp`](https://github.com/providcc/dsh-remote-mp)（微信小程序客户端）。三者共用
[`dsh-remote-protocol`](https://github.com/providcc/dsh-remote-protocol)（线协议；npm 包名 `dsh-remote-wire`，本插件以 npm 依赖消费）。

```
┌──────────────────┐  wss + host token   ┌────────────────┐  wss + 配对码   ┌────────────────┐
│  DSH 桌面主机      │ ─────────────────▶ │  relay server  │ ◀────────────── │ 微信小程序客户端  │
│  (本仓：插件)      │   只见密文与 6 位码   │                │                 │                │
└──────────────────┘                     └────────────────┘                 └────────────────┘
```

## 加密模型

中继看到的每个载荷都是 `base64(nonce ‖ secretbox)`，它**没有密钥**。载荷密钥（PSK）在本机生成，
只经配对二维码交给手机，从不上网。密钥派生、密封记录与配对 URI 的字节级契约由
`dsh-remote-wire` 冻结，本仓只消费它。

插件侧的关键约束：**host token 只从环境变量读**（`hostTokenEnv`，默认 `DRC_HOST_TOKEN`）。
它不写进 patch 文件——配置文件比环境变量更容易被顺手提交或贴进工单。

## 安装到 DSH profile

### 前置条件

`dsh-remote-wire` 是 npm 依赖，本仓以 `^1.8.0` 消费它，`pnpm-lock.yaml` 已提交、CI 用
`pnpm install --frozen-lockfile`。协议升版时走这三步：改 `packages/plugin/package.json` 里的版本
→ 跑一次 `pnpm install` → 把更新后的 `pnpm-lock.yaml` 一起提交。

插件不进 `node_modules`，而是打成**自包含单文件**装进 profile：

```sh
pnpm install          # 装依赖（含 npm 上的 dsh-remote-wire，按 lockfile 冻结）
sh scripts/install-to-profile.sh
# DSH_PROFILE=~/.dsh/profiles/tui sh scripts/install-to-profile.sh   # 指定其它 profile
```

脚本做三件事：用 esbuild 把两个包各打成一个文件 → 拷进 `$DSH_PROFILE/node_modules/<包名>/` →
把包名注册进 profile `package.json` 的 `dsh.profile.bundles`（幂等），并删除遗留的 `file:` 依赖
（那个会让 profile 里同时跑起**两个插件实例**）。

> **改代码后必须重启 Harness。** HMR 只热更 `cordis.patch.yml` 的配置，不会重新 import 产物；
> 浏览器面要**重新加载页面**才会重新拉 `client.cjs`。

配对：**点状态栏那颗 `dsh-remote-control`**（输入框那一排）。**未配对时点开直接就是二维码页**
（2026-10-04：中间那一屏"先按一颗 `生成配对码` 才出码"删掉了——没配上时面板上没有别的可看，
多那一次点击换不到任何东西），**已配对时点开只给状态**：抬头一行是状态，**右上角就一颗动作按钮**，
下面是**待处理（只在有事在等时出现，且排第一）/ 中继 `host:port` / 中继状态 / 版本号**
（各自拿不到值时那一行不占地方；本机名与台数不上屏；**二维码那一屏也带着这几行**，
"连的哪一台 / 连没连上 / 跑的是哪一版"在未配对时同样要在场）。那颗按钮只按配没配上分两种身份：
**没配上是 `刷新`**（同一条幂等发码路由：码还在就还是它、过期了才换新的），
**配上了是 `退出配对`**（当场作废主机手上的那条通道，退完就地回到二维码页）。
二维码与 6 位数字在同一块面板里（扫不出来时手输是唯一退路）；**码不自动续**，
过期后就地写"已过期、点右上角重新生成"，重发与否由人再按一次。那颗 pill 平时显示的是连接状态：
`远程未启动` / `已断开连接` / `连接中` / `未配对` / `已配对`（灰 / 红 / 黄 / 灰 / 绿；
断链是**故障**，所以它单独一个红，不跟"还没配上"共用灰色；绿灯只留给真配上了一台）。
**同一时刻只允许配对一台**：新设备配上时主机当场踢掉旧的那条通道，而面板也会从二维码翻回状态视图。

**命令行没有配对入口了**（2026-10-03 拍板）：`/drc` 命令**整条删掉**，一个命令都不再注册。
删掉 `/drc pair` 不是嫌它多余——它走的是"每次发一张新码"，会在 pill 那张之外再多挂一个仍然有效的
PSK，而手机扫的是屏幕上那张，取错密钥就全线解不开（当初"多码事故"的原样）；留着 `status`/`unpair`
又会让"配对入口只有一个"这句话变成假的。终端文本码同日删除：DSH 命令卡按 `line-height:1.6`
渲染等宽输出，行间留白会把半块码横切成条，实测 zxing 在 ≥1.15 行距就解不出来。

配对入口不可用时**必须查得到为什么**：宿主没有 `webServer`、或那四条路由挂不上、
或 `pill.enabled:false`，都会在 `status.json` 里留下 `problems: ["warn:pill"]`
与 `pill` 那块探针（`webServer:"none"` / `routes:"register threw: …"` / `pill:"disabled"`）。
这条 warn 是**每次写快照时现判**的：`webServer` 可能经 `ctx.inject` 晚到，一次性判断会留下
"路由已 `registered` 却仍报配对入口不可用"的假警报（2026-10-03 真机抓到）。
浏览器面那一半（拿 `react`、拿 `slots`）失败只在 DevTools 里留一行 `[dsh-remote-control pill]` 的 warn；
`slots` 按宿主模板声明在 client 模块的 `inject` 里（**空列表 = apply 跑在槽位服务之前 = 屏幕上没有
那颗 pill**），软探测与晚到回调只是退路。

## 配置

插件读 `~/.dsh/profiles/<name>/cordis.patch.yml` 里的那一行，优先级为
**环境变量 > patch 里的 `config` > 内置默认值**。分发包自带的默认行见
[`packages/plugin/cordis.patch.yml`](./packages/plugin/cordis.patch.yml)。

| 键                         | 默认                  | 说明                                                                                                                                                                                         |
| -------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                  | `true`                | 关掉即整行不干活                                                                                                                                                                             |
| `serverUrl`                | `ws://127.0.0.1:8787` | 中继地址。生产必须 `wss://`（写非回环的 `ws://` 只 warn 不拦，但明文链路上配对码可见）                                                                                                       |
| `hostTokenEnv`             | `DRC_HOST_TOKEN`      | **token 所在的环境变量名**。token 本身不进 patch                                                                                                                                             |
| `hostLabel`                | `dsh-host`            | 手机上显示的主机名                                                                                                                                                                           |
| `keepAwake.enabled`        | `true`                | 有会话时阻止系统休眠                                                                                                                                                                         |
| `keepAwake.idleReleaseSec` | `300`                 | 空闲多久后释放防休眠                                                                                                                                                                         |
| `unarchiveOnPrompt`        | `true`                | 收到指令时自动取消会话归档                                                                                                                                                                   |
| ~~`takeOverQuestions`~~    | —                     | **已删除**：提问改成像审批那样**参与** `user-questions/request` 这条 waterfall，两端同弹、谁先答谁算，不再有「接管」这回事（patch 里还留着这个键不报错也不生效，删掉即可）                   |
| `approvalTimeoutSec`       | `180`                 | 审批等待上限                                                                                                                                                                                 |
| `pairTtlMs`                | `120000`              | 向中继申请 PSK 的有效期；**服务端权威值会覆盖它**                                                                                                                                            |
| `pill.enabled`             | `true`                | 状态栏那颗 pill = **配对的唯一入口**。关掉它这台主机就没有配对入口，会留一条 `warn:pill`                                                                                                     |
| `conversationIdleTtlSec`   | `86400`               | 空闲多久剪掉一条配对通道（不接受"永不剪枝"）                                                                                                                                                 |
| `uploadDir`                | 空                    | **文件**附件落盘目录。空 = **自动**（`status.json` 同目录的 `uploads/`，`resolveUploadDir()`）——**不是"拒收"**；**图片不走这里**（走原生内容块）                                             |
| `maxFileBytes`             | `524288`              | 单个**文件**附件上限（512KB）；整批总量再卡一道 512KB（与 mp 侧 `MAX_ATTACH_TOTAL_BYTES` 同口径），超了整帧会被中继掐掉                                                                      |
| `newSessionCwd`            | 空                    | 新建会话用的项目目录。空 = 跟着**最近一条会话**的目录走；一条会话都没有时才退回宿主默认（`process.cwd()`，真机上是 `/`——会话会挂在不属于任何用户项目的目录里，GUI 列表按项目分组就看不见它） |

对应的环境变量覆盖见
[`packages/plugin/src/shell/config.ts`](./packages/plugin/src/shell/config.ts)（`DRC_SERVER_URL`、
`DRC_HOST_LABEL`、`DRC_PILL`、`DRC_MOCK_BRIDGE` 等）。**留下的那些键名刻意继承旧名**：它们写在
用户的 profile 里，改名等于让线上配置静默失效。已经删掉的键（`qrImage`/`qrOpen`/`qrAnsi`/
`qrStyle`/`sidebarQr`）就是删了：留在 patch 里不产生任何效果，也不会有 warn——那套路不会再回来
（取证在 `src/platform/qr.ts` 文件头与 CHANGELOG 的 1.2.0）。

排错入口是状态快照 `~/.dsh/dsh-remote-control/status.json`（0600）；关键字段 `carrier`
（`services` = 真内核 / `mock` = 内存替身 / `none`）、`relay`、`relayProblem`。

## 开发

```sh
pnpm install
pnpm typecheck        # tsc --noEmit（宿主侧 + 浏览器面两套 tsconfig）
pnpm test             # 先 build 再对 dist/tests 跑 node --test
pnpm build            # tsc + esbuild → packages/plugin/dist/bundle/{index.js,client.cjs}
pnpm format:check     # prettier --check
```

测试就是普通的 `node --test` 文件，没有测试框架，运行期不做转译。动到界面那一半时盯住三组：

- `pill-routes.test.ts` — 四条路由的判据：发码幂等、解配幂等（没配上时回 `{state:'ok',unpaired:0}`
  而不是 500）、写路由（发码与解配）的跨站判据是那个
  **同源才发得出的 `x-drc-pair` 头而不是 `Origin`**（桌面宿主会删 `origin`，真机量过）、
  回答里不许出现 `psk`/完整 URI、图片路由真的渲染出 PNG 字节、半途挂不上要回滚已挂的那几条。
- `pill-isolation.test.ts` — 对照：同一份假上下文跑两遍 `apply()`，只差有没有
  `webServer`，主链路可观察字段**逐个相等**、`/status` 的字段集合**逐个相同**，
  差别只许出现在 `pill` 探针与那一条 `warn:pill` 上；两边都**一个命令都不许注册**
  （`/drc` 整条已删）。
  含一条 `lateWeb`：`webServer` 由注入回调**晚到**时，挂上之后 `warn:pill` 必须自己消失。
- `client-bundle.test.ts` — 在 vm 里真跑**打出来的** `client.cjs`：pill 注册进
  `conversation.composer.dock`、点开只给状态（按钮随视图/配对态换文案）、
  正文是**待处理（有事在等才出现、且排第一）/ 中继 / 状态 / 版本**（拿不到值的那行不占地方、
  `状态` 按 `relay` 取值翻译）、有东西在等时抬头说 `等 N 件事` 且优先级是
  `已断开连接` > `等 N 件事` > `已配对` > `未配对`、
  二维码页那颗按钮叫 `刷新`、配上之后面板从二维码翻回状态视图、
  样式表**按内容对齐**（宿主热更这一半而文档没重载时，上一版的 CSS 必须被换掉——
  2026-10-03 真屏幕上的整块错位就是旧样式在管事），
  以及拿不到 react / 探不到 slots 时**只许降级成"没有 pill"、绝不抛出 apply**。
  假上下文的 `slots` 既能同步给、也能演"晚到"（`lateSlots` + `flushInject`）——
  只给同步那条的 fixture 演不出"屏幕上没有那颗 pill"，2026-10-03 真机就是这么漏的。

动到**宿主桥**那一半时盯住另外两组：

- `carrier-services.test.ts` — 真实宿主那一代的软探测面。最贵的一条是**审批那条 waterfall
  登记时必须带 `{ global: true, prepend: true }`**：`global` 管"不被 cordis 的作用域过滤掉"
  （宿主按 `scopeTarget(req.agent, …)` 派发，插件那条 fiber 是它的兄弟），`prepend` 管
  "排在桌面那位应答者前面"（外层不 `next()` 内层永远轮不到）。两个各摘一个就会红，
  而**真机上两种缺法表现完全一样：审批卡不弹、`approvalFace` 却照报 `registered`**。
  同一文件还钉 `approvalCalls` / `approvalLast` / `approvalAsked` / `approvalDecided`
  四条读数（"没人答"与"别人抢先答了"只有 `decided` 分得开）。
- `host-id.test.ts` — 主机身份必须**跨重启稳定**。`config.hostId` 为空时按
  "磁盘旧值 > 现造并落盘" 定身份（0600，已存在绝不改写）；每次加载现造一个会让中继
  顶不掉旧 socket、手机那条会话指向"没有钥匙的对端"，`droppedFrames` 一直涨。

二维码编码器本身的防回归在伞仓：`node scripts/validate-qr.mjs`（zxing-cpp 真解码，
PNG 与裸矩阵两条路径）。

## 安全

报告漏洞的流程见仓库根的 [`SECURITY.md`](./SECURITY.md)。**请不要为安全报告开公开 issue。**

可验证的安全边界就写在上面「加密模型」一节里：载荷密钥只经配对二维码交给手机、
从不上网，`hostToken` 只从环境变量读。重写期的设计推导不随本仓发布。

## 许可

[MIT](./LICENSE) © providcc
