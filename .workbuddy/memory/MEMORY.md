# dsh-remote-control 项目长期记忆

细节不在这里：mp 界面坑位清单见 skill `dsh-mp-ui-dev`；逐轮过程见 `.workbuddy/memory/YYYY-MM-DD.md`。

## 仓库布局

伞仓 `dsh-remote-control/` 保留 e2e/探针/文档；下面三个已独立成仓（各自 `git status`）：

| 仓 | 位置 | 备注 |
|---|---|---|
| plugin | `dsh-remote-control/packages/plugin` | 装进 `~/.dsh/profiles/desktop/node_modules/dsh-remote-control` |
| mp | `dsh-remote-mp/` | 原生小程序，**永不点「构建 npm」** |
| protocol | `dsh-remote-protocol/` | 打标签触发 GitHub Release 发 npm（OIDC，不要 token） |

- plugin 单跑：`pnpm -C packages/plugin test`（根包与 plugin **包名相同**，名字 filter 会命中两个）。
  它会先 `build`。页面逻辑测试**仍在伞仓** `e2e/mp-chat-blocks.test.mjs`，用 `require` 跨仓载入
  `dsh-remote-mp/miniprogram/pages/chat/chat.js` —— 改 chat 页两处都要动。
- plugin 一律以 `"dsh-remote-wire": "^x.y.z"` 消费 npm 版本，**不要改回 `file:`**。
  改版本后 `pnpm clean --lockfile` 再 `pnpm install`（`minimumReleaseAge` 会拦刚发布的版本）；
  pnpm 会自动往 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 加一条，**别手删**。

## 排错第一动作

`cat ~/.dsh/dsh-remote-control/status.json`：`carrier`（`services`=真内核 / `mock`=假会话）、
`relay`、`relayProblem`、`kernel.historyFace`（`readSession`=能读历史 / `absent`=不能）、
`kernel.approvalFace`（停在 `not-attached` = `attachInteractionSink` 从没被调用）、
`injectedUserMessages`（被丢弃的宿主注入消息计数，有值=该修复在生效）。

**⚠️ 缺字段 = 跑的是旧代码，不是"该功能坏了"。** `status.json` 里某个可观测字段整个消失，
唯一解释是当前进程加载的不是这份 bundle（2026-10-04 用户报"落盘没生效"即此：字段从不在，
而磁盘 bundle 里有）。比对两个时刻即可定案：插件自报 `probe.applyCount`（`1@<ms>`，
换算成时间 = 进程加载时刻）vs `index.js` 的 mtime（= 部署时刻）。
**先看字段在不在，再谈逻辑对不对。**

**四个数语义必须分开**，混了会得出相反结论：
`pairedClients`（手机台数）、`conversations`（**会话数，按 D3 长存，手机解配也不删，恒不清**）、
`pendingPairs`（还没被用掉的配对码）、`pairStore.{enabled,file,restored,lastSavedAt}`。
- 「解配 → 重配」会开**新会话**，所以拿会话数回答"几台手机"会得到"解完配对数字反而变大"。
- **凡是要回答"现在有几台手机/连着没有"，一律 `clientCount()`**（粗判据非精确在线数）。
- `restored > 0 && conversations === 0` 才是异常；`conversations > 0 && restored === 0` 是正常的本次新配对。

线上 `wss://drc.provid.cc`（ECS `47.100.82.15`）。token 两处**必须一致**：
服务器 `/etc/dsh-remote-control.env`(600) 与 `~/.dsh/profiles/desktop/cordis.patch.yml`。

### 部署：改完必须重启 Harness

HMR 只重载配置，替换 bundle **不重载**。部署 = `pnpm -C packages/plugin build` + 替换
`~/.dsh/profiles/desktop/node_modules/dsh-remote-control/`，然后**完全退出重开 Harness**。
⚠️ 已部署包是**扁平结构**（`index.js` 在该目录顶层，**没有 `dist/`**）——
按 `dist/` 去 grep 会全空，误判成"代码没部署"。`scripts/install-to-profile.sh` **已不存在**
（伞仓 `scripts/` 只剩探针与截图）。

## 免扫码重连（落盘，自举迭代的前提）

`~/.dsh/dsh-remote-control/conversations-<hostId>.json`（`shell/pair-store.ts`：
0600 + 临时文件 rename + hostId 校验；读不出/写不进一律降级**绝不抛**，插件起不来比丢配对更糟）。
落 **psk** 不落派生密钥（`derivePskKey` 是纯函数，存派生结果等于多一份必须永远相等的第二真相）。
**mp 侧零改动** —— 它的 installId/convId 本来就持久化在 wx storage。

四条容易重犯的：
- **`hello-ok` 不许清会话**。原来的 `closeBefore(generation)` 把"主机自己重启"当成"中继重启"
  （`generation` 只是进程内自增计数器），于是**每次重启都自毁全部配对**。
  它现在只喂 `PairingWindow`（中继重启后 pending-pair 表空了，挂着的那张码是死码）。
- **恢复必须在 `connect()` 之前**，否则第一帧 `resync` 声明的是空列表，中继据此删通道。
- **有恢复出来的会话就立刻 `runtime.start()`**，不等 `onPeerJoined` —— 恢复不是重配，
  手机不发 `pair-begin-client`，等它就等于主机不订阅任何内核事件（症状与配对丢失一模一样，
  但 status.json 里 conversations=1、carrier 也正常）。
- 恢复出来的会话走**另一条 TTL**（`restoredIdleTtlSec`，默认 7 天对齐中继），
  不按 24 小时那条剪 —— 否则长假后主机一启动就把唯一通道清了。剪枝只在 host 侧。

## 协议不一定要改：先查服务端有没有现成的路

帧名是冻结的（F1），但**中继里往往已经有那条路**。2026-10-03 查「解配要通知主机」时，
`dsh-remote-server/src/server.ts` 的 `session-leave` **客户端分支早就实现了**（转 `peer-left`），
缺的只是小程序没发。加协议帧之前先 grep 服务端。

## 删 mp 代码前必读

伞仓 e2e 会 `require` mp 的模块并**直接摸它的内部**。「grep 不到引用 = 死代码」在这三类上会咬人：
① 被测试当**对拍 oracle** 的导出（`codec.nacl`，`protocol.test.mjs` 拿它跟 npm tweetnacl +
node:crypto 比哈希）；② 被测试**断言透传**的参数（`loadHistory` 的 `opts.limit`）；
③ **算进 oracle sha256 的注释** —— 比对 `codec.js` 整个文件的哈希，**加一行注释也必须重跑
`node e2e/tools/gen-vectors.mjs`**，且确认「只有 `_meta` 变了、向量逐字节相同」。
清理时先跑基线，删一条跑一次 e2e，别攒到最后一起验。

## 构建纪律

`env -u NODE_OPTIONS pnpm -r build` / `-r test`；`node e2e/run.mjs`；`pnpm -C e2e test`。
**`env -u NODE_OPTIONS` 不能省**（WorkBuddy 的 FS 钩子拦 pnpm 符号链接，报 `CODEBUDDY_BROKER_DENY`）。
各包测试引 `dist/`，跑 mp 测试前必须先 build，否则报 `does not provide an export named …`（假红）。
**有并行 agent 在同仓提交**：开工与交付前各 `git log --oneline -3`；判断代码对不对之前先看 mtime ——
测试跑不过可能是**别人没写完的 fixture**，不是自己改坏了。

## 判据纪律（mp 专属细节见 skill `dsh-mp-ui-dev`，那边有完整版）

跨仓的四条，任何自动判据都适用：

1. **判据红时先怀疑判据，不是先怀疑实现。** 读不存在的字段 → `undefined` → 比较变 `NaN`
   → 恒红。判据与实现不一致时**先假设判据错**（它更容易错，且错了不会误导产品）。
2. **判据里不许 `setData`/桩掉它本该验证的开关** —— 那等于自己按住开关再检查它。
   **每条新判据要单独反证一次，一个不落**（我曾反证了位置却漏了开关）。
3. **⚠️ 判据依赖的「全局状态」必须归一**（最隐蔽的一种）—— 主题/配对码/存储跨判据共享。
   `md-dark` 跑完留下深色，紧随其后的 `theme` 组 13 条红了 11 条，每条都在喊"不是浅色"，
   而代码是好的 —— 差点当成"刚改坏了"。**一次红一片，先问"是不是我的状态没归一"。**
   规矩：开头归一到已知起点 + 结尾还原，**两头都做**。
4. **⚠️ 所有自动判据全绿 ≠ 渲染对了** —— 单测 30 / e2e 129 / 对比度 260 全绿，
   而**界面上正文整段是空的**。**唯一抓住它的是 `el.size()` 读到的 0。**
   **截图要亲自看**；「元素存在」只证没被删掉，证不了有内容；排错要**逐档对照**。

**「账本对了」≠「界面变了」** —— 两者取的是**不同字段**，必须各有一条判据。
2026-10-03 解配即此：判据只读 `pairedClients`，界面读的是恒不清的会话数，
修完主机侧就收工，用户重启后报"还是没反应"。宿主侧对应手法：打**真路由**
`host.callPill('/plugins/dsh-remote-control/status')`。
**改 `status.json` 字段时必须同时问「谁读它」—— 改了账本没人看等于没改。**

## 打包约束

插件装进外部 pnpm 工程 `~/.dsh/profiles/desktop`，**不能有 `workspace:*`**。
`@dsh-rc/protocol` 只是 devDependency，`scripts/bundle-protocol.mjs` 在 build 后内联。
**改了 protocol 必须重新 build plugin**，否则内联的是旧的。

## 设计与协议上不可省的约定

**mp 界面约定（chat 页结构、顶栏语义、主题、组件预算、markdown/rich-text 限制、
TDesign 裁剪清单与验证）全部见 skill `dsh-mp-ui-dev`**，那里是唯一权威版本。
只记一条跨仓的、通用的数据层原则：

> **「记不记」是数据层，「显不显示」是渲染层，必须分开。**
> 隐藏过程只关 wxml 渲染，**绝不删落块逻辑** —— 审批、回执收尾、历史回放都依赖它。
> 隐藏一个分支只能用**独立 `wx:if`**，带条件的 `wx:elif` 会落到末尾 `wx:else`。

跨仓的协议与宿主侧约定：

- 审批：真实通道是 waterfall `approval/request`，**只有参与它才能到达手机**
  （`approval/asked|decided` 是审计事件，不能应答）。guard 里
  `WATERFALL_PARTICIPANTS = ['approval/request']` 是显式极窄名单。
  没有手机在线时 `participate()` 调 `next()` 交还桌面 UI。
  **`approvalFace` 停在 `not-attached` 先查 profile 里的包是不是旧副本、Harness 重启了没有，
  别急着改代码。**
- 协议：所有回执统一走 `_cmdWaiters` 按 `cmdId` 结算，**结算点只有一个**。
  `ev.session_history` 是回执不是广播。**只有游标 `nextBeforeSeq`、没有 `hasMore`**。
  回放时**去重集合不许登记自己**。插件缺 `readSession` 时**明确拒绝、不返回空页**。
- 事件语义：**事件类型相同 ≠ 语义相同**。宿主把注入内容也写成 `user/message`，
  判据只能是 `source.kind`（实测 14 种，只有 `user` 是真人）。
- 运行态只认 `ev.run_state`；思考正文永远拿不到（M28 红线）。
- 一次性定时器 **unref 与"停机集中撤销"必须成对**（`core/clock.ts`）。

## 尚未验证

真机上的审批/提问卡：本机 preset 都是 `approval/policy: never`，永不弹审批（环境问题，
非代码问题）。代码路径有单测与 mock e2e 覆盖。

## 当前发布状态（2026-10-05 01:30 更新）

- npm：dsh-remote-wire 1.4.0（ev.todo）、dsh-remote-control 2.0.2（待办/cwd/pill 文案）。
- relay 1.0.4 已部署生产（47.100.82.15，healthz 报 1.0.4；部署重启断过手机通道）。
- mp 1.1.3 已上传，等用户选体验版。19 条 Dependabot 全合（红因=分支旧 + pnpm 双版本声明，
  update-branch 即绿；控制仓 PR 4 有真冲突，本地 merge main + 重生成 lockfile 推回）。
- 用户侧三步：重启 Harness / mp 选体验版 / 手机重扫。
- todo v1 只上实时帧（不进历史回放）；微信扫码直达用户说先不改（URL Link 方案已存档）。

## current release state (updated 2026-10-05 02:00)

- npm: dsh-remote-wire 1.5.0 (historyItem widened with ev.todo), dsh-remote-control 2.0.5 (adding: pairing QR countdown + no dead code while the relay is offline). Restart Harness is REQUIRED -- the running bundle is still old (pill version 2.0.0), the liveness probe from 2.0.4 is not live and the host goes half-open every ~10 minutes..
- relay 1.0.4 in production (unchanged this round, docs only); mp 1.1.4 uploaded (todo history replay).
- user side: restart Harness / pick mp 1.1.4 as trial build / phone re-scan once.
- 19 Dependabot PRs all merged; TS 7.x typechecks clean in all four repos.