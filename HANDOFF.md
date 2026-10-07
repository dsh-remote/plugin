# HANDOFF — DSH Remote Control

在手机上远程操作 **DeepSeek Harness（DSH）**：下发指令、看流式输出、审批工具调用、回答问题，
并让主机在任务跑完前保持唤醒。**载荷级端到端加密**——中继从头到尾只见
`base64(nonce‖secretbox)`，不是"我们不查"，而是密钥在协议层的依赖图上就不可达
（中继的构建产物里没有密码学代码，有判据锁住）。

> **本文 2026-10-07 晚精简重写。** 只留「现在是什么状态 / 还剩什么 / 怎么干活」。
> 逐轮叙事（哪一轮发现了什么、怎么修的）已删——要追溯看伞仓 `git log` 与四仓 `CHANGELOG.md`。
> 其它仓的代码注释里还有 `HANDOFF §0.1` 这类旧锚点引用，对照表见 §10。
>
> 读码顺序：本文 → [`README.md`](README.md) → [`docs/DESIGN.md`](docs/DESIGN.md)
> → [`dsh-remote-protocol/SPEC.md`](dsh-remote-protocol/SPEC.md)（958 行，规范正文 + 附录 D 九条 GAP）。

## 1. 四仓落位 · 读码地图

产品代码的唯一事实源是 GitHub 上**四个独立仓**（账号 `providcc`，MIT），本机是四个平行的顶层目录。
伞仓（本目录）**不再持有源码副本**，只剩不开源的取证与运维资产（`e2e/`、`scripts/`、`docs/`、`deploy/`、本文）。
四个仓各自是独立的 pnpm workspace，协议层是 **npm 依赖**（精确钉），不是 git/file 依赖。

| 组成 | 位置 | 入口文件 | 规模 |
|---|---|---|---|
| 协议层（npm `dsh-remote-wire`） | `dsh-remote-protocol/` | `src/index.ts`；`src/wire/*` | 2.9k 行 |
| 零知识中继 | `dsh-remote-server/` | `src/main.ts` → `src/server.ts` | 3.0k 行 |
| Host 插件（一包两半） | `dsh-remote-control/packages/plugin/` | `src/index.ts`（宿主面）+ `client/src/main.ts`（pill） | 9.5k 行 |
| 微信小程序 | `dsh-remote-mp/` | `miniprogram/core/client.js`、`pages/chat/chat.js` | 11.4k 行 |
| 测试装置 + 取证脚本 | `e2e/`、`scripts/`（伞仓） | `e2e/run.mjs`、`scripts/report-gates.mjs` | 15.6k 行 |

各仓内部再分层的规矩只有一条，但它是硬的：**协议与策略是纯函数，副作用全在适配器里**。
插件侧 `shell → core → ports`，只有 `platform/` 与 `shell/` 允许 import cordis 与 `@deepseek-ai/*`；
`core/` 不认识 cordis、不认识 socket，所以审批闭环、合帧顺序、剪枝策略都能在纯内存里测。
中继侧唯一可变状态在 `src/state.ts` 的四张 Map 里，`server.ts` 只是装配。

**信任模型三条**：中继持有 `DRC_HOST_TOKEN` 与配对码路由表，没有载荷密钥；
配对时主机生成 16 字节 PSK，**只经二维码**给手机（`dshr:/p?v=1&s=…&n=…&psk=…&t=<6位码>`），
PSK 从不上网；双方各自从 `(psk, 方向, convId)` 派生 `c2h`/`h2c` 两把密钥，手机用计数器 nonce
（小程序没有 CSPRNG）。威胁模型与加固清单见 [`docs/SECURITY.md`](docs/SECURITY.md)。

## 2. 当前状态（2026-10-08 07:20 实测）

### 2.1 四仓口径 —— **四仓统一 2.0.21，tag / Release / npm 都齐了**

| 仓 | manifest | tag | Release | npm | 真正在跑的那份 |
|---|---|---|---|---|---|
| `dsh-remote-protocol` | 2.0.21 | ✅ `v2.0.21` | ✅ | ✅ 2.0.21（**无 attestation**，见 §6） | —— |
| `dsh-remote-control` | 2.0.21 | ✅ `v2.0.21` | ✅ | ✅ 2.0.21（同上） | ✅ **profile 里已是 2.0.21**（见 §2.3） |
| `dsh-remote-server` | 2.0.21 | ✅ `v2.0.21` | ✅ | 不发（包名被第三方占） | ⚠️ **线上容器仍是 2.0.16，要升**（见 §3.1） |
| `dsh-remote-mp` | 2.0.21 | ✅ `v2.0.21` | 不适用（无 release workflow） | 不发 | ⚠️ **尚未上传微信后台**，见 §3.5 |

`node scripts/next-version.mjs --check` 对 2.0.21 报**红**（"已发布过"）—— **那是预期的**，
不是闸门坏了。下一个可用的号是 **2.0.22**（`node scripts/next-version.mjs` 会自己算）。

> **版本号为什么一路走到 2.0.21**：`dsh-remote-wire@1.0.1` 2025 年就发布过（私有期编号），
> npm 版本不可重用；`1.0.2`…`1.9.0`、`2.0.0`…`2.0.20` 也基本都被占过。
> 判据是「**大于**所有已发布版本，且两个包上都空着」。已固化成闸门 `next-version.mjs`。
> 本轮 2.0.17–2.0.21 是同一批改动**分了五个号**——因为每加一个功能就要发一次 npm，
> 而 npm 版本不可重用。**教训：把一批改动攒齐了一次发，比逐条发省号。**

### 2.2 线上中继（`wss://drc.provid.cc`，阿里云 cn-shanghai / ECS `47.100.82.15`）

- 跑的是**容器**：`dsh-remote-relay-relay-1`，镜像 `dsh-remote-relay:2.0.16`，`restart=unless-stopped`。
- **裸机 systemd 那条路已退役**：单元 `dsh-remote-control` = `not-found`，rc1 产物在 `/opt/dsh-remote-control/_retired/`。
  ⇒ **唯一的回滚路径是 `docker compose restart`，回不到 rc1 了**（那是刻意的）。
- compose 工程目录 `/opt/dsh-remote-control/dsh-remote-server/deploy/docker`，`.env` 就在那里（0600，已核）：
  `DRC_HOST_TOKEN` + `DRC_PAIR_TTL_MS=180000`（**不是默认值**，默认 120000）+ `DRC_STATE_FILE=/data/state.json`
  + `DRC_BIND=0.0.0.0`（端口只发布到回环，所以 nginx 那份 `drc.conf` 一行都不用改）。
- `/healthz` 现在 23 个字段。`stateWriteFailures` 是**落盘活着没有**的唯一判据：不是 0 就是没在写。
  `stateRestored` 是"启动时读回了几条会话"，它与 `conversations` 的组合能分清"重启后恢复"与"重启后从零开始"。

### 2.3 本机宿主（跑 DSH 的这台 Mac）

- ✅ **profile 里已是 2.0.21**（2026-10-08 06:56 重启后验证）。判据不是"文件在"，
  而是 `status.json` 的 `probe.applyCount`：**进程加载时刻 06:56:46 晚于 bundle
  部署时刻 00:13** —— 这才是"新代码在跑"的证据。
- 四个关键字段：`carrier=services` / `relay=online` / `pill.routes=registered` /
  `problems=[]`。另外 `workspaceRegistry: true` 且内核侧 `archivedSessions: 55`
  ⇒ 归档那条路在真机上有料可归档。
- 主机身份 `hostId=drc-748e9a9ce167`（落在 `~/.dsh/dsh-remote-control/host-id`，0600）。
- 排错第一入口是 `~/.dsh/dsh-remote-control/status.json`（GUI 宿主里 stdout 没人看）；
  字段含义与 pill 四条路由的写法见 [`docs/HOST-SIDE.md`](docs/HOST-SIDE.md) §5。
- ⚠️ **重启在沙箱里不能用 osascript**：`tell application "DeepSeek Harness" to quit`
  报**权限违例（-10004）**，`System Events` 同样。可行的替代：
  `pgrep -f "DeepSeek Harness"` → `kill -TERM <主pid>` → 残留子进程 `kill -9`
  → `open -a "DeepSeek Harness"`。**动手前先确认没有正在跑的活**
  （`find ~/.dsh/sessions -mmin -10` 为空 + `status.json` 的 `approvalAsked: 0`）。

### 2.4 闸门（2026-10-08 实测，全绿）

| 闸门 | 命令 | 实测 |
|---|---|---|
| 协议层 | `cd dsh-remote-protocol && pnpm test` | 168 |
| 中继 | `cd dsh-remote-server && pnpm test` | 197（1 skip） |
| 宿主插件 | `cd dsh-remote-control && pnpm test` | 524 |
| 伞仓 e2e | `node --test e2e/*.test.mjs` | 364 |
| 小程序 | `npm --prefix dsh-remote-mp run check` | 五道闸全过：verify ok / md 35 / scroll 14 / theme / contrast 304 |
| 本地全链路 | `node e2e/run.mjs` | 17 步，1.8s |
| 版本闸 | `node scripts/next-version.mjs --check` | 发版前必须绿；发版后对当前号报红是预期 |

`env -u NODE_OPTIONS pnpm gates` 会把上表跑一遍并与 [`README.md`](README.md) 的「项数」逐格比对，对不上 exit 1。
**加了判据就跑它**，照着表改 README 里两处数字。

⚠️ **`pnpm gates` 不查代码格式，而 CI 查**（`format:check` 排在 `test` 之前）。
2026-10-08 这一轮四个仓的 Release workflow 全部在 20~40 秒就红在这一步，
而本机 gates 全绿。**发版前在每个 Node 仓额外跑一次 `pnpm format:check`。**

## 3. 待办（真的还没做的）

> **2026-10-08 重写**：上一版的 §3.1–§3.4 已全部落地（见 §2 的实测），
> §3.7 已实现。下面只留**还要人做**或**还要机器做**的。

### 3.1 升线上的中继容器（唯一还差"部署"的一件事）

线上跑的是 **2.0.16**，而代码已经是 2.0.21。本轮改了中继代码
（七步分流委托 classify + 四个缺陷），所以**要重新构建并换版**：

```sh
ssh root@47.100.82.15
cd /opt/dsh-remote-control/dsh-remote-server/deploy/docker
git pull                      # 或 scp 那份 deploy/docker
docker compose up -d --build  # build 在起新容器之前完成，中断只有 recreate 那一下
curl -s https://drc.provid.cc/healthz | grep -o '"version":"[^"]*"'   # 变了才算成
```

- **唯一的回滚动作是 `docker compose restart`**（裸机 systemd 那条路已退役）。
- ⚠️ 换版会**断一次手机通道**（主机侧会自己重连，见 `relay.ts` 的退避）；
  断线期间手机在聊天页会转圈，属正常。
- ⚠️ 本轮中继有一处**行为变化**值得留意：`pingBucketCount` 现在被夹到 ≤1024
  （默认 12，不受影响）；`pair-fail` 多了 `pairingToken` 字段，**更老的主机插件
  会 strip 掉它**——所以先升中继是安全的（向后兼容），反过来不行。

### 3.2 把 mp 2.0.21 上传微信后台并选为体验版

```sh
cd dsh-remote-mp && node scripts/mp-upload.mjs
```

⚠️ 传上去只是"开发版本"，**还要两步脚本替不了的**：
① 微信公众平台「版本管理 → 开发版本 → **选为体验版**」；
② 「成员管理」里加体验成员。
在这两步做完之前，手机上那个 2.0.16 体验版**看不到本轮的归档功能**。

### 3.3 真机复验（要真人 + 真机，e2e 覆盖不了）

1. **`node e2e/live-e2e.mjs`** 三端真链路（真小程序代码 + 真线上中继 + 真内核）。
   ⚠️ **它会把你自己手机上那条通道当场踢掉**（主机策略是「只允许一台」，
   新设备一进来就作废其余），而且**没有任何提示说这是被脚本踢的**——
   要重扫一次码才能恢复。跑之前先确认那台手机此刻不需要连着。
   `--rounds 3` 每轮独立取一张新码；`--unpair` 才会收掉测试自己那条（默认不收）。
2. **归档 / 取消归档**（本轮新功能，唯一没上过真机的路径）：
   主机侧 `workspaceRegistry: true` 且内核侧有 55 条已归档会话，所以有料可归档。
   要验的三件事：① 归档一条空闲会话 → 它从列表消失、归档区 +1；
   ② 归档一条**正在跑**的会话 → 必须被明确拒绝（那句"会话正在运行，不能归档"
   要原样弹出来，**主机上那个任务不许被停掉**）；
   ③ 取消归档 → 它回到主列表。
3. `unpair` 后 pill 从「手机离线」变「未配对」，且**不许**要求重新扫码。
4. 审批卡闭环（提问闭环已在真机上过过一轮）。
5. 长会话正文不再卡在 1MB 帧闸门。

## 4. 已经判定不做 / **别重做的**（结论留着，别再逐条审一遍）

| 位置 | 是什么 | 为什么不做 |
|---|---|---|
| mp `core/codec.js` 的 `parsePairingQr` | 只认 `dshr:` 前缀，不校验 path 必须是 `/p`（wire 的 `parsePairingUri` 会校验） | 只有第三方手工造的码才撞得上；且交叉核对只喂 `buildPairingUri` 的输出、**没有负向量**——要补先补向量 |
| mp `client.js` 15s 与宿主 `carrier-services.ts` 的 15s | 两处各写一个 15000，没有共同来源 | 两端同时到点才分叉，窗口是毫秒级 |
| `core/keys.ts` 的 `Conversation.clientIds` | 无界 Set；中继丢 `peer-left` 时会永久 `hasClient=true` | 需要"丢通知 + 手机换 clientId"同时发生。真要修就是加上界 + 时间戳 |
| `core/window.ts` 的 `partCursor` | 无界 Map（会话中断/归档时那条 `done` 永不到） | 每条约 50 字节、进程级；且**没有任何 accessor** 能观测它，先加观测再谈 |
| `pill/routes.ts` 的 `/pairing.png` | 只要 loopback Host，不要 `x-drc-pair`（比 `/pairing/new` 弱）；无缓存、无限速 | 跨站读不到字节，最多是个"屏上有没有码"的 oracle。**但这条不对称没有任何地方论证过**，下次动它要顺手写清 |
| `uploads.ts` 的 `appendFileNote` | 把手机来的 `mediaType`（64 字符、无字符集限制）插进 prompt | 只有自己的手机能配对；真要修就是过一遍 `safeSegment` |
| `uploads.ts` 的 `decodeBase64` | 宽松（截断的 base64 解成更短的"合法"文件并报成功） | 中继帧层不会转发半条帧 |
| `config.ts` 的 `resolvePairStoreFile` / `resolveUploadDir` | 相对路径不限制逃出 `statusFile` 目录（`../../etc/x` 可以） | 配置是用户自己的；HOST-SIDE 的"按所在目录解析"措辞与之不符，**属文档口径** |
| `shell/status.ts` 的刷新节拍 | 唯一没 `unref` 的定时器 | GUI 宿主本来就长驻；headless 嵌入才受影响 |
| `pill/routes.ts` 的 `pairImageHandler` catch | 可能二次 `writeHead` | 依赖宿主是否 catch 那个返回的 promise，本轮看不到 `webServer.register` 的调用方 |
| 中继 `handlePairClaim` 的全局配额 | 未认证连接以约 4 条/s 重连即可抽干共享的 20/s 配额 | 真解要按来源分账，而中继**看不到真实 IP**（那是设计）。边界应由 nginx 的 `limit_conn` 兜；真要动就给每条连接加一个本地配对配额 |
| 中继 `enc` 的错误码 | 匿名者能区分 `unknown_session` 与 `not_member`，等于一个"这个 convId 在不在"的 oracle | convId 是 48 bit，且成员校验仍挡路由；危害有限 |
| `hello.hostId` | wire schema 里**唯一没有长度上界**的自报字段 | 上限该加在**协议层**，那是另一个仓的改动 |
| `state.clientGone` | 每条客户端连接断开都全表扫 `conversations`（O(N)） | 真实部署 N 不大；要修就是加 `clientId → convIds` 反查索引 |
| `shutdownForced` | 字段**结构上恒为 0** | 已改成"去看那两行 warn"；改退出码会牵动 systemd/compose 的语义，不值得 |
| `.tmp/cross-repo-contract-audit.md` | 一份 **2.0.14 时代**的静态审计 | 它的 F1–F4（workspace 五步、出站体积闸）**已在 2.0.15/2.0.16 修掉**，别照它派活；仍开的只有 F5（上表第 1 行）、F6（见 §5）、F8（上表第 2 行） |

## 5. 已知未修 → 2026-10-07 第二轮**已收口**（15 条修了 13 条）

这一节原是 2026-10-07 深读新发现、判过之后"留下不修"的东西。**同日已把 13 条修完并钉判据**
（逐条变异验证：把实现改回旧行为，判据必须变红）。逐条细节在三仓 `CHANGELOG.md`；
这里只留结论，好让下一个人知道"审过、修过、不用再查"。

| # | 问题 | 结果 | 落点 |
|---|---|---|---|
| 1 | 中继版本闸的注释说"它是所有帧的入口"，实际只在 `case 'hello'` | ✅ 改注释（**代码本来就是对的**，有测试钉着）+ 删掉从未被读的 `peer.protocolMissing` | 中继 `src/server.ts` |
| 2 | `resync` 删会话时**不通知**客户端 | ✅ **改判**：现在发 `peer-left`，与宽限期到期、`session-leave` 同口径；补一条反向判据防"顺手全通知" | 中继 `src/state.ts` |
| 3 | 同一条坏帧 `parseEndpointFrame` 调两遍 | ✅ 只解析一次 | 中继 `src/server.ts` |
| 4 | mp 在重连退避窗口**静默丢命令**（socket 在、task 不在） | ✅ `sendCmd` 发不出去必须返回 false 并报错 | mp `core/client.js` |
| 5 | `onInterrupt` 无条件 toast「已发送中断」 | ✅ 不看返回值就不报成功 | mp `pages/chat/chat.js` |
| 6 | 审批/回答**先清卡再发帧** | ✅ 改成先发、再清；发失败时卡留着让用户再点 | 同上 |
| 7 | `_onPaired` 丢掉 `savePairing()` 的返回值 | ✅ 写失败当场告诉用户（但**不丢 PSK**，那把是唯一一份） | mp `core/client.js` |
| 8 | `loadPairing` 不校验 `nonceCounter` | ✅ 坏记录 `dropCorrupt`——否则计数器从 1 重数 = **静默的密钥流复用** | mp `core/session-store.js` |
| 9 | `extensionOf` 不截断 / 宿主 schema 失败只记日志 | ✅ **两端都修**：mp 截到协议的 64 上界；宿主按 `cmdId` 回一条明说原因的执（从前手机干等 12 秒） | mp `chat.js` + 宿主 `runtime.ts` / `transport/relay.ts` |
| 10 | sessions 页没有 `ev.result` 分支 | ✅ 补上（只弹失败；成功回执不弹，否则每次刷新都是噪声） | mp `pages/sessions/sessions.js` |
| 11 | `_onFrame` 的 switch 没有 try/catch | ✅ 派发整段兜住：一条帧抛错不许交出**这条连接后面所有帧**的处理权 | mp `core/client.js` |
| 12 | `pong` 分支是死的（mp 没有本地半开检测） | ⏸ **刻意没做** | 见下 |
| 13 | `error` 帧的 `retryAfterMs` 没人用 | ✅ **两头都接了**：中继现在按帧闸的 1 秒窗口余量发出去，mp 据此退避且**在 `nextNonceFor` 之前**拒绝（不消耗 nonce），新连接清零 | 中继 `src/server.ts` + mp `core/client.js` |
| 14 | `cmd.keep_awake` / `ev.keep_awake_state` 在 mp 是死的（无调用方、无渲染） | ⏸ **刻意没做** | 见下 |
| 15 | `badWorkspace()` 只喂过主机自己推断的值 | ✅ **已消解**：`cmd.new_session.workspace` 接线后，它拿到的**就是**手机传来的路径 | 宿主 `carrier-services.ts` |

### 两条**刻意没做**的（都不是"漏了"，是取舍）

- **#12 本地半开检测**：mp 侧加一个 `ping`+超时探针，能把"发现死连接"从 ~120 秒
  （中继 sweep 兜底：60s ping、2 次判死）压到几秒。但探针**必须只在前台发**——
  后台定时器被微信节流，那时打一个必超时的探针只会制造无谓的断连重连。
  另一个选择是把那个死分支删掉、把"发现"如实写成中继的职责。**需要一次取舍，不适合顺手做。**
- **#14 `keep_awake`**：要它活就得**加界面**（状态 + 开关），外加 mp 的 UI/对比度两道闸；
  要删就得连同协议里的字面量一起拿掉，而那是**破坏性**变更。
  它现在"闸绿着但没接"，正是 wire-surface 只比字面量、比不出"这个分支会不会被走到"的实例。

### 这一轮顺手记下两条**判据纪律**

- **桩没还原，会把失败挪到几条用例之外**：`installHost` 把 `globalThis.wx` **整个**换成
  `getStorageSync: () => ''`，之后每条读配对记录的用例都读到空——症状是"一半断言看着正好"，
  而真正的失败原因在几条用例之前。修在装置里（`beforeEach` 把真存储装回去），不是改产品。
- **夹具自己先发过帧时，"发出去没有"要按差值判**：`justPaired()` 在 `_onPaired` 末尾就
  发过一条 `cmd.list_sessions`，断言写死 `frames.length === 1` 会撞上它。

## 5.5 2026-10-08 全库 review 的结论（15 条，全修完并钉了判据）

> 这一节记的是**"审过、修过、不用再查"**，与 §4（判定不做）和 §5（上一轮）同性质。
> 逐条细节在四仓 `CHANGELOG.md` 的 2.0.21 段。

**全部是"注释承诺了 X，代码做的是 Y"，而症状一律静默。** 每一条都配了
可变异验证的判据（把实现改回旧行为，判据必须变红）。

| # | 缺陷 | 症状 |
|---|---|---|
| 1 | 插件 `settledReplies` 无界增长 | 注释说"与台账同生共死"，实现只问台账"我自己那一个键还在不在"。实测 900 条命令后台账 256、回执表 900（每条 `list_sessions` 的回执带最多 100 条会话摘要） |
| 2 | 插件：一条坏落盘记录带崩插件 | 注释说"整条丢弃"，实现直接 `open()`。调用点不在 try 内 ⇒ **无 status.json、无 pill、配对链路全无** |
| 3 | 插件：越界时刻停更 status.json | `toISOString` 在时刻绝对值 > 8.64e15 ms 时抛，而它在**构造快照**的路径上，外面包着一个（正确的）空 catch ⇒ 唯一排错入口永久停更 |
| 4 | 插件：误伤一张有效的配对码 | `pair-fail` 原先不带 token，主机只能作废"当前展示的那张"。多码并存时作废错的那张 → 那条通道的 PSK 没了 |
| 5 | 中继：ping 桶数没有上界 | `Array.from({length})` 是照单分配。interval=MAX_SAFE_INTEGER → RangeError，而 **loadConfig 报 0 条 problem**（异常在 createRelay 里）⇒ 照文档调 tick 就启动即崩 |
| 6 | 中继：观测面计数只增不减 | 每收一个 hello 就 +1、close 只 −1，而 re-hello 是设计内行为 ⇒ "当前没有对端"永久失效 |
| 7 | 中继：re-hello 留下幽灵成员 | `clientGone` 刻意不动成员表（D3），但换身份时旧 id 永不回来 ⇒ **sweepEmpty（30 分钟回收空会话）完全失效** |
| 8 | 中继：「配对表满」逐帧写日志 | 绕过本文件自己建的三道闩锁。400 个 pair-begin = 400 行 journald |
| 9 | 中继：`portNumber` 漏了"只认十进制字面量" | `DRC_PORT=0x22` → 34，三种写法都 0 条 problem |
| 10 | mp：「＋新建会话」每次都发 `[object Object]` | `bindtap` 把**事件对象**当第一个实参 ⇒ 三级兜底永远走不到。`String({})` 不是空串所以照发 |
| 11 | mp：退避被打回零 | `onShow` 里 `else { connect() }`，而 connect 会造一个退避重置为 0 的新 socket ⇒ 指数退避永远顶格 1s |
| 12 | mp：needs-pair 没归零 | 只清 3 个字段，其中 2 个已经不再被写 |
| 13 | 判据：一条恒绿的占位断言 | `assert.match(wxml, /x/ === null ? /x/ : /x/, '占位')` —— 正则永不为 null，对任何文本都通过 |
| 14 | 判据：两条方向相反的判据会**同时**恒绿 | 抽字抽空时 `unknown` 与 `unused` 都必为空，而第二条**没有**兜底 |
| 15 | 判据：三条判据有两份逐字副本 | 把 `pnpm gates` 的项数灌了 3 —— 而那是发现"忘了改文档"的唯一机制 |

### 这一轮顺手记下两条**判据纪律**（与 §5 那两条同族）

- **`String(fn)` 会丢掉参数名**：想从已加载的函数反查签名会拿到
  `function () { … }`，正则取到的"第一参"是 `function`，一次产出 17 个假阳性。
  要读**源码文本**。
- **变异必须能编译**：`if (a && !b)` 改成 `if (true)` 时 `else if` 变成不可达分支，
  **tsc 直接红、判据根本没跑**——看起来像"变异没被抓到"，实际是它压根没执行。
  与 §6「判据红了先查判据」同族：先确认变异**跑起来了**。

## 6. 环境坑与硬纪律

- **所有 pnpm/node 命令带 `env -u NODE_OPTIONS`**：Qoder CLI 会往子 shell 注入一个 `--require` 的 CJS 代理，
  Node 22 的 ESM loader 解析不了它，任何要解析依赖的调用都会挂。
- **`install-to-profile.sh` 要给绝对路径的 `DSH_PROFILE`**：DSH 这个 shell 里
  `DSH_PROFILE` 被导成**裸的 `desktop`**（不是路径），而脚本第一行就是
  `PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/desktop}"` —— 变量一旦有值，那个默认路径
  整个被绕开，于是报 `install-to-profile: profile not found: desktop` 就退出。
  两种写法都行：显式 `DSH_PROFILE="$HOME/.dsh/profiles/desktop"`，或 `env -u DSH_PROFILE`。
  **症状是"脚本报找不到 profile"，看着像路径写错了，其实环境里已经有一个同名变量。**
- **改完立刻 commit。** 这台机器上未提交的工作树被清掉过两次（一次已订正为人工 `git stash` + `checkout`，
  不是神秘外部进程）。`git reflog` 里留下的直接证据：`reset: moving to HEAD` 与一笔外部提交。
  **同一个工作树上不要同时有两个人**：一边发版清场、一边在同一目录改造，两边各自都合理，合起来互相踩。
- 装/查/打包固定走 **Node 22**（pnpm 11 要 22.13+）；`node --test` 跑的是 `dist`，**先 build**
  （插件的 build 第一步就是 `clean`）。`e2e/run.mjs` 启动时会做 **src↔dist 新鲜度闸门**：
  任一 `.ts` 比它的 `dist/src/*.js` 新就直接红并打印该跑哪条 build——**闸门只报错，不替你 build**。
- ⚠️ **`pnpm gates` 不查代码格式，而 CI 查** —— 而且 `format:check` 排在 `test`
  **之前**。2026-10-08 四个仓的 Release workflow 全部在 20~40 秒就红在这一步
  （本机 gates 全绿），其中 `dsh-remote-protocol/src/wire/negotiate.ts` 的缩进错位
  来自**更早的提交**，也就是说 main 上已经红了一段时间。
  **发版前在每个 Node 仓额外跑 `env -u NODE_OPTIONS pnpm format:check`。**
- ⚠️ **本机发的 npm 包没有 attestation** ⇒ 两个发 npm 的仓会在
  "Verify provenance landed" 那步红，**而它排在 `Create GitHub Release` 之前**
  ⇒ Release 建不出来（publish 那步是幂等的，所以它绿、然后 provenance 红、Release 缺失）。
  恢复路径：`gh release create v2.0.21 --generate-notes --verify-tag` 手工补。
  2026-10-08 已手工补了 wire 与 control 两个。
- ⚠️ **在沙箱里重启 Harness 不能用 osascript**：`tell application "DeepSeek Harness" to quit`
  报权限违例（-10004），`System Events` 同样。可行替代：
  `pgrep -f "DeepSeek Harness"` → `kill -TERM <主pid>` → 残留子进程 `kill -9`
  → `open -a "DeepSeek Harness"`。**动手前先确认没有正在跑的活**
  （`find ~/.dsh/sessions -mmin -10` 为空 + `status.json` 的 `approvalAsked: 0`）。
- **判据红了先查判据，再查实现。** 变异验证必须**作用在被测的那段逻辑上**且**能编译**——
  否则测的是上一个产物（真的发生过：`pnpm build` 失败、判据却全绿）。
  **"把修复整段删掉它照样绿"说明这条判据是假的**，比没有判据更糟。
- **不真实的夹具会制造一整片假红，而真问题被它遮住**（`runtime.test.ts` 的 `cmd()` 助手曾写死
  `cmdId`，同类型命令发两次拿到同一个 id，接上台账后审批/提问/历史全红——红的是夹具不是产品）。
- **假实现与实现同源出错，比没有假实现更糟**：`wx.chooseMessageFile` 给的是 `path` 而不是
  `tempFilePath`，而当时的夹具照抄了 `chooseMedia` 的形状，于是"每一个文件都读不出来"这条功能
  一次都没通过过、判据却一路绿灯。
- **单次事件 + 小样本，绿几次说明不了任何事**（曾据"连跑 22 次全绿"推断出错误的诱因；那是巧合）。
- `systemctl status` 看不出来的东西，`stateWriteFailures` 看得出。ProtectSystem 那套教训现在的形态是
  **容器卷的属主**：状态目录属主不对时，配对表面完全正常，唯一信号是 `stateRestored:0` 配 `conversations:0`。
  **正确顺序是"先停服务、再 chown"**（systemd 的 `StateDirectory=` 会在停机时按 `User=` 把属主改回去）。
- 删掉一个部署目录之后**必须复查开机自启链**：旧单元曾是 `enabled` 而 `ExecStart` 指向已删文件，
  只删目录不复查的话，机器一重启 systemd 起单元失败、容器**不会**被拉起（`restart: unless-stopped`
  只管容器自己崩，不管宿主机重启）⇒ 重启后中继彻底没了，且报错只说"单元起不来"。

## 7. 命令速查

```sh
# 逐仓闸门（都在各自仓根；env -u NODE_OPTIONS 是必须的）
env -u NODE_OPTIONS pnpm -C dsh-remote-control test          # 宿主插件（含 build）
env -u NODE_OPTIONS pnpm -C dsh-remote-server test           # 中继
env -u NODE_OPTIONS pnpm -C dsh-remote-protocol test         # 协议层

# ⚠️ 发版前额外跑这一条：CI 查格式而 pnpm gates 不查，且它排在 test 之前
env -u NODE_OPTIONS pnpm -C dsh-remote-protocol format:check
env -u NODE_OPTIONS pnpm -C dsh-remote-server format:check
env -u NODE_OPTIONS pnpm -C dsh-remote-control format:check
npm --prefix dsh-remote-mp run check                         # 小程序五道闸
env -u NODE_OPTIONS pnpm gates                               # 全部闸门各跑一遍 + README 逐格比对
env -u NODE_OPTIONS node e2e/run.mjs                         # 本地全链路 17 步
env -u NODE_OPTIONS node scripts/next-version.mjs --check     # 发版前必跑

# 真相入口
curl -s https://drc.provid.cc/healthz                        # 线上中继（看 version / stateWriteFailures / stateRestored）
cat ~/.dsh/dsh-remote-control/status.json                    # 插件侧（按定时器刷：读数要轮询 + 带基线）
node scripts/mp-preview.mjs                                  # 改完 mp 先让用户扫码看
node scripts/mp-shots.mjs --pages sessions                   # 截图验收

# 本机开发：起本地中继 / 装插件
./dsh-remote-server/scripts/relay-start.sh                   # 127.0.0.1:8787，token 复用 profile 里那份
./dsh-remote-server/scripts/relay-start.sh --bundle          # 跑单文件产物（与生产形态一致）
DSH_PROFILE="$HOME/.dsh/profiles/desktop" \
  ./dsh-remote-control/scripts/install-to-profile.sh      # 构建 + 装进 profile（装完必须重启 Harness）
# 重启（⚠️ 沙箱里 osascript 会吃 -10004，见 §6 那条）：
#   pgrep -f "DeepSeek Harness" → kill -TERM <主pid> → 残留子进程 kill -9 → open -a "DeepSeek Harness"

# 线上中继：容器形态（部署手册在 dsh-remote-server/deploy/docker/README.md）
ssh root@47.100.82.15
cd /opt/dsh-remote-control/dsh-remote-server/deploy/docker
docker compose ps                                            # 看健康
docker compose up -d --build                                 # 换版：build 在起新容器之前完成，中断只有 recreate 那一下
docker compose restart                                       # 唯一可用的回滚动作
curl -s https://drc.provid.cc/healthz                        # 版本号变了才算成
```

## 8. 宿主能力面：P0 / P1（已核实，不是推测）

完整版（30 服务 / 140 方法的来源与理由）见 [`docs/HOST-CAPABILITIES.md`](docs/HOST-CAPABILITIES.md)。

**怎么查的**（别再靠猜）：

```sh
# 1. 每个宿主包带一份机器可读的调用契约：lib/typert.host.js（服务 + 方法 + 参数 + 返回）
# 2. 每个包还有 README.md（人话版签名、语义、已知限制）
# 3. 线上到底挂了什么：status.json 的 probe.wanted（逐个点名，回答 true/false）
# 4. 事件到底发不发、长什么样：真机 session log 解压后统计
#    ls -t ~/.dsh/sessions/*/*/session.v4.jsonl.zstd | head -12 | xargs -I{} /opt/homebrew/bin/zstd -dc {}
```

### ⚠️ 两个取证陷阱（都踩过）

1. **`probe.loaderRows` 不能用来判断"某包装没装"**——它被我们自己 `slice(0, 2600)` 过，
   截断点之后的看起来就像没加载。用 `probe.wanted`：逐个点名，短、不截断、可复算。
2. **判据红了先确认变异真的改变了行为**：从 `MAPPED_SESSION_EVENTS` 里删掉一条**不会**让判据变红
   （那张表只管 `status.json` 记账，`switch` 照样跑）。**变异必须作用在被测的那段逻辑上。**

| # | 能力 | 状态 |
|---|---|---|
| P0-1 | `tokenMeter` 上下文占用 | ❌ **这个 profile 没挂**（依赖的 `session-projection` 在，它自己不在）。宿主发布清单里有，是 profile 没引；**要启用得改 profile 的 bundle 声明**，影响面比改我们的代码大得多 |
| P0-2 | `workspace/changes` 改了哪些文件 | ❌ **做不了**。真机 66 个样本**全是 `{turn:N}`**——只是"本轮有改动"的宣告，文件清单在认证 Web 路由里，中继够不到。只报"改了文件"却不给哪些文件，比不说更糟 |
| P0-3 | 压缩可见 `compaction/*` | ✅ 已做（真机 18 次） |
| P0-4 | 重试可见 `llm/retry` | ✅ 已做（真机 18 次） |
| P1-5 | 文件附件走 receipt（`client-file-upload`） | ❌ **没挂** ⇒ 印证了文件附件那条路确实够不到 |
| P1-6 | 模型下拉能用（`llm.discoverModels` 等） | 🟡 **待验**。`agentDefaultModel` 那侧确认只有 `currentSelection`，但 `llm` 服务本身已加载，有没有可用枚举入口要单独验 |
| P1-7 | `workspaceFiles.*` 手机看文件 | ❌ **没挂** |

## 9. 冻结契约里真正会静默坏的几条

完整三张表（B1–B9 字节级 / F1–F13 帧与字段 / T1–T8 传输）在 [`docs/DESIGN.md`](docs/DESIGN.md) §2，
由 `e2e/protocol.test.mjs` 的逐字节对拍机械锁定。**改协议前先读那三张表**，这里只挑最容易踩的：

| 项 | 规格 | 踩了会怎样 |
|---|---|---|
| **F3 双 `sessionId`** | 中继帧外层 `sessionId` = 配对通道 id（`c_` + 12 hex）；载荷里的 `sessionId` = DSH 会话 id，与 `sessions[].id` 同名同值 | 混用 ⇒ 聊天页过滤掉所有事件，一条都不显示 |
| **F5 错误分支** | `error.code === 'unknown_session'` 是客户端**唯一**据此清配对并提示重扫的码；host 掉线必须发 `peer-left` | 只断连接不发 `peer-left` ⇒ 手机困在「重连中」 |
| **F6 配对失败枚举** | 只有 `invalid_or_expired` / `already_used` / `host_offline` / `bad_token` 四个（小程序有中文映射表） | 漏出第五个取值 ⇒ 手机弹英文（中继把配对限流折成 `invalid_or_expired` 正是为此） |
| **F9 流式收尾** | 每条消息**最终必须有一条 `done:true`**，空文本的 done 帧不可被合并逻辑丢弃 | 正文收尾不掉 ⇒ 手机上挂着一个一直闪的光标 |
| **T1 / T2 帧形态与大小** | 只允许文本 JSON 帧（binary 会被小程序静默丢弃）；大小上限 ≥ 256 KiB（现网值），超限是**硬断开 1009** | 收紧上限会直接掐断流式输出 |
| **T3 顺序性** | 同一会话必须串行投递 | 客户端没有去重/排序能力，乱序就是乱序 |
| **T5 关闭码** | `1001` 停机 / `1013` 繁忙 / `1009` 超限 / `1008` 限流 / `4001` 鉴权爆破 / `4008` 配对爆破 / `4000` 顶号 | 客户端的重连策略依赖这些语义 |
| **T7 `/api/pair-status`** | **默认必须 404** | 否则给 6 位码装了一个免认证的判定 oracle |

## 10. 旧锚点对照（其它仓的注释里还在引用）

| 旧锚点 | 讲的是什么 | 现在在哪 |
|---|---|---|
| §0.1 | `ProtectSystem=strict` 少了 `StateDirectory` ⇒ EROFS，"配对正常但永远不落盘" | §6 最后两条 + `dsh-remote-server/deploy/docker/README.md` |
| §0.2 | 未提交的工作树会被清掉 | §6「改完立刻 commit」 |
| §0.3 / §0.9 / §0.13 | 假通过判据、夹具同源出错、小样本不能推断诱因 | §6 的纪律那几条 |
| §0.7 | e2e 产物新鲜度闸门；`live-e2e` 改成显式 `--unpair` | §6 第 3 条 + §3.5 |
| §0.10.4 | `cmd.new_session.workspace` 的五步接线 | **已完成**；剩余见 §3.3 的表尾 |
| §0.10.6 | `pnpm gates` | §2.4 |
| §0.10.9 | 四条机械判据（gates / readme-claims / wire-surface / host-config-docs） | §2.4 |
| §0.10.10 | 图片附件那条链的审计结论 | **已审毕**（结论：分层对、整批先验后返、两个面都没有时明确拒绝）；只差真机，见 §3.5 |
| §0.10.16 / §0.10.17 / §0.10.18 / §0.10.19 | 2.0.15 深审八条、中继可靠性 + 容器化、协议层落地、遗留清单收口 | 逐轮叙事看 `git log` 与四仓 `CHANGELOG.md`；**未完成的部分已全部搬进 §3** |
| §1.1 | 中继会话表落盘 | **已完成并上线**；判据语义见 §2.2 |
| §1.2 / §1.3 | unpair 真机复验 / mp 选体验版 | §3.5 |
| §3.3 / §3.4 / §5 / §9.10 / §9.11 / §9.15 | 中继强化、宿主身份、真机审批取证 | 这些锚点在本次重写前就已经指不到了；内容分别落在 §8、`docs/HOST-SIDE.md` §5 与 `docs/SECURITY.md` |
