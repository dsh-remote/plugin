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

## 2. 当前状态（2026-10-07 晚实测）

### 2.1 四仓口径 —— **manifest 都对齐了，发出去的那半没跟上**

| 仓 | manifest | 最新 tag | npm | 真正在跑的那份 |
|---|---|---|---|---|
| `dsh-remote-protocol` | 2.0.16 | ✅ `v2.0.16` | ✅ 2.0.16 | —— |
| `dsh-remote-control` | 2.0.16 | ❌ 只到 `v2.0.15` | ❌ 2.0.15 | ⚠️ **profile 里装的是 2.0.14** |
| `dsh-remote-server` | 2.0.16 | ❌ 只到 `v2.0.15` | 不发（包名被第三方占） | ✅ 线上容器 2.0.16 |
| `dsh-remote-mp` | 2.0.16 | ✅ `v2.0.16` | 不发 | 见 §3.5，要人在微信后台确认 |

`node scripts/next-version.mjs --check` 现在会报 **wire@2.0.16 已发布过** 的红 —— **那是预期的**，
不是闸门坏了（发过的号不可重用）。收口方式见 §3.2。

> **版本号为什么是 2.0.16 而不是 1.0.1**：`dsh-remote-wire@1.0.1` 2025 年就发布过（私有期编号），
> npm 版本不可重用；`1.0.2`…`1.9.0`、`2.0.0`…`2.0.13` 也基本都被占过。
> 判据是「**大于**所有已发布版本，且两个包上都空着」。已固化成闸门 `next-version.mjs`。

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

- **⚠️ `~/.dsh/profiles/desktop` 里的插件是 2.0.14**（2026-10-07 12:33 装的）。
  按 2.0.15 / 2.0.16 各自的独有标记核过：`client.cjs` 里没有 `visibilitychange`（墙钟倒计时那条修复），
  `index.js` 里没有 `encToClient`、`backoffUntil`、`IdempotencyLedger`、`cmd.workspace`。
  ⇒ **2.0.15 的八处修复与 2.0.16 的两处接线，在这台机器上一行都没生效**，而它们都已经在仓里、判据全绿。
  补齐见 §3.1。
- 主机身份 `hostId=drc-748e9a9ce167`（落在 `~/.dsh/dsh-remote-control/host-id`，0600）。
- 排错第一入口是 `~/.dsh/dsh-remote-control/status.json`（GUI 宿主里 stdout 没人看）；
  字段含义与 pill 四条路由的写法见 [`docs/HOST-SIDE.md`](docs/HOST-SIDE.md) §5。

### 2.4 闸门（本轮实测，全绿）

| 闸门 | 命令 | 实测 |
|---|---|---|
| 协议层 | `cd dsh-remote-protocol && pnpm test` | 152 |
| 中继 | `cd dsh-remote-server && pnpm test` | 177（1 skip） |
| 宿主插件 | `cd dsh-remote-control && pnpm test` | 494 |
| 伞仓 e2e | `node --test e2e/*.test.mjs` | 345 |
| 小程序 | `npm --prefix dsh-remote-mp run check` | 五道闸全过：verify ok / md 35 / scroll 14 / theme / contrast 304 |
| 本地全链路 | `node e2e/run.mjs` | 17 步，1.9s |
| 版本闸 | `node scripts/next-version.mjs --check` | 发版前必须绿；发版后对当前号报红是预期 |

`env -u NODE_OPTIONS pnpm gates` 会把上表跑一遍并与 [`README.md`](README.md) 的「项数」逐格比对，对不上 exit 1。
**加了判据就跑它**，照着表改 README 里两处数字。

## 3. 待办（真的还没做的）

### 3.1 把 2.0.16 装进 profile 并重启 Harness —— **最优先，也是真机复验的前置**

```sh
./dsh-remote-control/scripts/install-to-profile.sh
osascript -e 'tell application "DeepSeek Harness" to quit'; sleep 8; open -a "DeepSeek Harness"
```

改代码/换产物后**必须重启**：HMR 只热更 `cordis.patch.yml` 的配置，不会重新 `import` dist；
浏览器面同理，要重新加载页面才会重拉 `client.cjs`。装完看 `status.json` 的
`carrier=services` / `relay=online` / `pill.routes=registered` / `problems=[]`。

### 3.2 发版收口（外部动作，要人定）

| 仓 | 缺什么 | 命令要点 |
|---|---|---|
| `dsh-remote-control` | 2.0.16 没发 npm、没 tag | 先跑 `next-version.mjs --check`；`npm publish --provenance=false --access public`；再 `git tag -a v2.0.16 && git push origin v2.0.16`；`gh release create` |
| `dsh-remote-server` | 2.0.16 没 tag、没 Release（代码未变） | `git tag v2.0.16 && git push origin v2.0.16`（不发 npm） |

⚠️ **两个仓的 `.github/workflows/release.yml` 在 push tag 时会自动 `npm publish`。**
本仓的"先评审、后发版"**不是默认成立的**：tag 一推就发。**评审必须在推 tag 之前做完。**
（2.0.15 那次推 tag 时已经吃过一次这个亏。）
另外两条实测踩过的坑：本地发 npm 要显式 `--provenance=false`（否则 `EUSAGE: provenance not supported`）；
**发版命令必须写绝对路径**——命令里的 `cd` 不跨调用生效，误跑会落在伞仓（private）上报 `EPRIVATE`。

### 3.3 三端把协议层的新能力接上（此前记作「待办 D 的剩余部分」）

`dsh-remote-wire@2.0.16` 导出的一整套「规范的可执行部分」，目前**只有两处有消费方**
（中继的版本闸、宿主的 `cmdId` 去重）。剩下的每一行都是「同一个知识在两个地方各写一遍」：

| 端 | 现在是什么 | 该换成 |
|---|---|---|
| 中继 | `KNOWN_FRAME_NAMES` 手抄一份（`src/server.ts:88-105`，只在 `:993` 用） | `registry` 的 `FRAME_TYPES` / `isKnownFrameType` |
| 中继 | 七步分流内联在 `:948-1005` | `classifyEndpointFrame()`（reason → 错误码的映射写在它文件头） |
| 中继 | 自带 `ciphertextsAreBase64`（`:1044-1048`） | `classify` 的同名导出 |
| 中继 | 两条手拼上行帧 `:659-665`（`enc`）、`:699`（`enc-batch`） | `encToRelay` / `encBatchToRelay`。⚠️ **`encToRelay` 没有 `clientId` 参数**，要么扩参数要么留字面量并写清为什么 |
| 中继 | 限流只回码，不带等待建议；`CLIENT_ERROR_TEXT` 里也不可能出现 `retryAfterMs` | `makeError(code, message, retryAfterMs)`（规范 §12.2 E2），与 `errors.wantsRetryAfter` 对齐 |
| 中继 | `/api/info` 的 `protocol: 1` 是字面量（`:1253`） | 已 import 的 `PROTOCOL_VERSION` |
| 宿主 | **五个地方各写一个 `512 * 1024`**（`shell/uploads.ts:55,114`、`shell/config.ts:141,360`、`core/runtime.ts:137`），外加一个 `?? 4`（`shell/uploads.ts:113`） | `limits` 的 `MAX_ATTACHMENT_BYTES` / `MAX_ATTACHMENT_TOTAL_BYTES` / `MAX_IMAGE_ATTACHMENTS` |
| 宿主 | 七处手写控制帧（`transport/relay.ts:244,287,406,453,494,690`）；`protocol: 1` 也是字面量（`:247`） | `helloForHost` / `pairBegin` / `sessionLeave` / `resync` / `ping`——参数表外的字段**类型上写不出来**，顺手消掉那个字面量 |
| 宿主 | `hello` 里不报能力 | `capabilities: CapabilityId[]`（`registry` 的注册表，规范 §5.3 C1/C3） |
| 宿主 | `error` 帧只记日志，不按码分支 | `isRetryableError` / `wantsRetryAfter`（现在只对 `rate_limited` 有反应） |
| 小程序 | **协议面不用改**（全部加性） | —— |

⚠️ 协议包里两处**注释里的行号已经过期**（`registry.ts:9` 指 `server.ts:59-76`，实际 88-105；
`classify.ts:6-10` 指 `:634-708` 与 `:733-736`，实际 `:926-1012` 与 `:1044-1048`）。接线时顺手订正。

### 3.4 文档与现网口径对齐

| 文档 | 哪里不对 | 实测是什么 |
|---|---|---|
| [`docs/HOST-SIDE.md`](docs/HOST-SIDE.md) | `statusFile`（:114）与 `maxFileBytes`（:118）两行**没写**新的告警口径 | `shell/config.ts` 现在会对相对路径发 `warn:statusFile`、对超预算的 `maxFileBytes` 发 `warn:maxFileBytes` 并夹回。配置是"写了不报错、不告警、不生效"那一类，表里少一句就是一个没人知道的开关 |
| [`docs/HOST-SIDE.md`](docs/HOST-SIDE.md) | :18 写产物 `index.js 1242 KB / client.cjs 18 KB` | 实测 **1333 KB / 29 KB**（1.1.0 时代的值） |
| [`README.md`](README.md) | :60「线上 v1.0.6，rc1 已发布待切」 | 线上是容器 **2.0.16** |
| [`README.md`](README.md) | :63「四仓统一用同一个版本号（当前 `2.0.14`）」 | **2.0.16** |
| [`README.md`](README.md) | :86「e2e 全部 `*.test.mjs`（**311**）」 | **345**（同文件 :129 写的就是 345，自相矛盾） |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | :92「rc1 已上传为开发版本」 | mp 已到 2.0.16 |

`pnpm gates` **抓不到上面这些**：它只锚 8 个"项数"格子。改完这几处顺手把 `docs/EXPANSION-PLAN.md` 的
P5 那行一起看（它把"HANDOFF 记账"列在收口清单里）。

### 3.5 真机复验（要真人 + 真机，e2e 覆盖不了）

1. **`node e2e/live-e2e.mjs`** 三端真链路（三个真实：真小程序代码 + 真线上中继 + 真内核）。
   ⚠️ **它会把你自己手机上那条通道当场踢掉**（主机策略是「只允许一台」，新设备一进来就作废其余），
   而且没有任何提示说这是被脚本踢的——要重扫一次码才能恢复。跑之前先确认那台手机此刻不需要连着。
   `--rounds 3` 每轮独立取一张新码；`--unpair` 才会收掉测试自己那条（默认不收）。
2. `unpair` 后 pill 从「手机离线」变「未配对」，且**不许**要求重新扫码（真机复验遗留项）。
3. 审批卡闭环（提问闭环已在真机上过过一轮）。
4. 手机选图 → 发送 → 模型真的看见图（图片附件那条链**只在代码上审过，没上过真机**）。
5. 长会话正文不再卡在 1MB 帧闸门。
6. **mp 选为体验版**：`node scripts/mp-upload.mjs` 传开发版本后，还要在微信公众平台
   「版本管理 → 开发版本 → 选为体验版」，再在「成员管理」里加体验成员。**这两步脚本替不了。**
   ⚠️ `dsh-remote-mp` 仓里 `v2.0.16` tag **不含**「新建会话落进指定分组」那笔
   （提交 `a989513` 在 tag 之后，`CHANGELOG.md` 记在 `[未发布]`）——后台上传的到底是哪一份，
   **要在微信后台对一次**，别照 tag 推断。

### 3.6 刻意不做（写下来是为了不用每次重新吵）

`ev.host_info`（能力/限额上报，规范 §13.2 / 附录 D·GAP-5）、v2 消息棘轮（前向保密，§7.6）、
`dshr:` 按 RFC 7595 注册（§6.1.4 / GAP-9）。

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

## 5. 已知未修（按现状记账，**不是**待办清单）

这一节是 2026-10-07 本轮深读新发现的、判过之后**留下不修**的东西。列在这里是为了让下一个接手人
不必重跑一遍同样的调查，而不是催谁去改。

| # | 位置 | 症状 | 判断 |
|---|---|---|---|
| 1 | 中继 `server.ts:775-781` 的注释说版本闸是"所有帧的入口"，而 `acceptProtocol` 的调用在 `case 'hello'` 里面（`:782`） | 业务帧从不校验版本；`peer.protocol` 实际只喂 `/healthz` 计数；`peer.protocolMissing` 是**死字段** | **行为是有意的**（`tests/handshake.test.mjs` 那条测试就叫「版本闸只挡 hello」）。坏的是注释，不是代码 |
| 2 | 中继 `resync` 删会话时**不通知**客户端（`state.ts:293-294`） | 那些手机要等到自己发下一帧撞 `unknown_session` 才知道 | 已有出口（`unknown_session` → 提示重扫），且少一条主动帧 |
| 3 | 中继 `:967` 与 `:978` 各调一次 `parseEndpointFrame` | 同一条坏帧解析两遍 | 只在**坏帧**路径上，正常路径不受影响；性能上无所谓 |
| 4 | mp `client.js:307-310` 是 `sendCmd` 唯一的错误出口 | **socket 对象还在、底层 task 不在**（重连退避窗口）时 `send()` 返回 false，命令被静默丢弃、**不报任何错**；而 `interrupt` / `resolvePermission` / `answer` / `listSessions` / `getPending` 都不看返回值 | 真机已观察到。**这一条最值得优先修**：它是"点了没反应"的又一个来源。注意 nonce 仍然被消耗（是丢帧，不是复用） |
| 5 | mp `chat.js:2828-2832` | `onInterrupt` **无条件** toast「已发送中断」，不看 `client.interrupt()` 的返回值 | 与上一条同源；两条一起修才有意义 |
| 6 | mp `chat.js:2838` / `:2885` | 审批/回答**先把卡清掉再发帧**；若那条帧被静默丢弃，主机继续阻塞 180s/300s 而用户手上已经没有卡了 | 同上 |
| 7 | mp `client.js:482` | `savePairing()` 的返回值被丢掉：存储写失败时配对只在内存里，重启后表现成"从没配过" | 与 `nextNonceFor` 那条纪律同源（那个检查了，这个没检查） |
| 8 | mp `session-store.js:79-86` | `loadPairing` 不校验 `nonceCounter`，而 `nextNonceFor` 是 `Number(x \|\| 0) + 1` | 手工改过/截断写坏的记录会让计数器回到 1 ⇒ 同一 psk+convId 下**密钥流复用**，正是该文件头承诺的不变量。没有任何路径能发现它 |
| 9 | mp `chat.js:277-282` 的 `extensionOf` 不截断 | 超长扩展名会做出 `mediaType > 64` 的载荷，而宿主 `relay.ts:592-598` 对 schema 失败的载荷**只记日志、不回执** | 两头都该修：主机不回执 = 手机干等满 12 秒才说"主机没有回应"，根因一个字都不留 |
| 10 | mp `sessions.js` 没有 `ev.result` 分支 | 列表页发起的命令（如 `cmd.list_sessions`）失败**完全不可见** | 只有 chat 页会把 `ok:false` 弹出来 |
| 11 | mp `client.js:344-350` | `_onFrame` 的 switch **没有 try/catch**（只有 `JSON.parse` 被包住）；case 里抛出会逃进 wx 回调 | `enc-batch` 的逐项守卫就是为这一类加的，但通用风险还在 |
| 12 | mp `client.js:386-387` 的 `pong` 分支是死的 | 手机从不发应用层 `ping`；半开连接只能靠中继的 sweep 发现，本地永远不知道 | 与宿主侧那条存活探针不对称（宿主是**专门为此**加的 20s ping） |
| 13 | mp `client.js:383` | `error` 帧只 toast `f.message \|\| f.code`，`retryAfterMs` 完全没用上；`rate_limited` 没有退避 | 协议层已经把可重试性写好了（`errors.ts`），这一端没用 |
| 14 | mp `ev.keep_awake_state` / `cmd.keep_awake` **是死的** | 帧没有任何页面渲染，`setKeepAwake` 没有调用方 | ⚠️ 而 `e2e/wire-surface.test.mjs` **照样绿**——那道闸只比字面量，比不出"这个分支到底会不会被走到"。这是它能力边界的一个实例 |
| 15 | 宿主 `platform/carrier-services.ts` 的 `badWorkspace()` | 它按"手机传来的 workspace 是不可信输入"写的，实际只喂过主机自己推断的值 | `cmd.new_session.workspace` 接线后它才第一次拿到真·手机输入 |

## 6. 环境坑与硬纪律

- **所有 pnpm/node 命令带 `env -u NODE_OPTIONS`**：Qoder CLI 会往子 shell 注入一个 `--require` 的 CJS 代理，
  Node 22 的 ESM loader 解析不了它，任何要解析依赖的调用都会挂。
- **改完立刻 commit。** 这台机器上未提交的工作树被清掉过两次（一次已订正为人工 `git stash` + `checkout`，
  不是神秘外部进程）。`git reflog` 里留下的直接证据：`reset: moving to HEAD` 与一笔外部提交。
  **同一个工作树上不要同时有两个人**：一边发版清场、一边在同一目录改造，两边各自都合理，合起来互相踩。
- 装/查/打包固定走 **Node 22**（pnpm 11 要 22.13+）；`node --test` 跑的是 `dist`，**先 build**
  （插件的 build 第一步就是 `clean`）。`e2e/run.mjs` 启动时会做 **src↔dist 新鲜度闸门**：
  任一 `.ts` 比它的 `dist/src/*.js` 新就直接红并打印该跑哪条 build——**闸门只报错，不替你 build**。
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
./dsh-remote-control/scripts/install-to-profile.sh           # 构建 + 装进 profile（装完必须重启 Harness）

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
