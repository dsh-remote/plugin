# DESIGN — dsh-remote-control 重写（v2）

> 本文是**重写的设计与执行计划**，不是旧实现的复述。
> 前提三条，不可协商：
>
> 1. `mp/`（微信小程序）**一行不改**；它是这套系统对外的接口权威。
> 2. `packages/protocol`、`packages/plugin`、`apps/server`、`e2e/`、`scripts/`、`docs/*` 从零重写，
>    **不复用旧实现任何一行代码**。旧代码只作为需求与事实的来源，来源已固化为
>    [`docs/legacy-spec/`](legacy-spec/) 五份取证档案；本文之后每条约束都应能指回那里的锚点。
> 3. `deploy/` 的 nginx/systemd 配置与 `.github/` CI 骨架**保留**——线上实例正在使用（取证：
>    `https://drc.provid.cc/healthz` 返回 `ok, hosts:1`；本机 Harness 快照 `carrier=services`、`relay=online`）。
>
> 旧代码基线：提交 `b026d63`。取证档案里的 `文件:行号` 一律可用 `git show b026d63:<path>` 复现。

## 1. 需求来源（取证档案）

| 档案 | 覆盖 | 规模 | 在本文中的角色 |
|---|---|---|---|
| [`legacy-spec/mp-client-contract.md`](legacy-spec/mp-client-contract.md) | 小程序发出/消费的一切、状态机、环境限制 | 522 行 / 8 节 | **接口权威**，§2 冻结清单的来源 |
| [`legacy-spec/relay-and-wireformat.md`](legacy-spec/relay-and-wireformat.md) | 控制面帧、配对状态机、线格式、加固、部署事实 | 456 行 / 163 锚点 | 中继与协议层的规格 |
| [`legacy-spec/host-plugin.md`](legacy-spec/host-plugin.md) | cordis 集成红线、内核适配面、窗口化、打包约束 | 待落盘 | §5 host 层的规格 |
| [`legacy-spec/testing-and-tooling.md`](legacy-spec/testing-and-tooling.md) | 测试金字塔、live-e2e「三个真实」、工具链坑 | 674 行 / 229 锚点 | §7 验收口径，逐条继承 |
| [`legacy-spec/open-source-options.md`](legacy-spec/open-source-options.md) | 依赖选型与互操作实测 | 待落盘 | §6 依赖清单 |

已核实的一个数字：旧实现单测 **83 项**（protocol 11 + plugin 36 + server 13 + e2e 23，按 `node:test` 顶层
`test()` 逐文件计数），与 README 声称一致（取证：`legacy-spec/testing-and-tooling.md` §1）。
**这一版不会重跑旧测试套件**——对旧代码跑 build/test 与"零复用重写"相悖；新实现的绿必须由新测试自己挣，
最低门槛写死在 §7.1（≥ 旧等价覆盖）。

## 2. 冻结契约（改一条 = 手机端静默坏掉）

这一节是**唯一允许"抄语义"的地方**：下列字节与字符串不是旧实现的风格，而是 `mp/` 里已经发布出去、
无法再改的第二份实现。新代码必须逐字节产出同样结果，但由 §3 的对拍测试机械锁定，不靠人记住。

### 2.1 字节级

| # | 冻结项 | 精确规格 | 来源 |
|---|---|---|---|
| B1 | 密文记录 | `ciphertext = base64( nonce(24B) ‖ nacl.secretbox( utf8(JSON.stringify(payload)), nonce, key ) )`；外层对象**只有一个字段**，名字就叫 `ciphertext` | mp-client §8-1；relay §3.1 |
| B2 | base64 | **标准表**（`+` `/` `=`，带 padding），与 `Buffer.toString('base64')` 逐字节一致；解码侧容忍空白 | mp-client §6；relay §3.1 |
| B3 | `open` 失败语义 | 长度 `< 24+16`、MAC 不符、JSON 非法 → 一律**返回 null，不抛异常** | relay §3.1 |
| B4 | KDF | `SHA-512(p0 ‖ 0x1f ‖ p1 ‖ 0x1f ‖ … ‖ pn ‖ 0x1f)[0..32]`——**每个 part 之后都补 `0x1f`，含最后一个**，取**前** 32 字节 | mp-client §8-2；relay §3.2 |
| B5 | 会话密钥 | parts 顺序 `['dsh-rc/v1', dir, convId, pskRawBytes]`；`dir ∈ {'c2h','h2c'}`；两把密钥必须不同；`psk` 用**原始字节**而非 base64 文本 | relay §3.2 |
| B6 | 客户端 nonce | `SHA-512('dsh-rc/v1/nonce'␟installId␟convId␟pskRaw␟)[0..16] ‖ counter(8B **大端**)` = 24B；host→client 方向可用随机 nonce | mp-client §5.2；relay §3.2 |
| B7 | PSK | 16 字节 → base64 24 字符；每次配对轮换、单次有效 | relay §3.3 |
| B8 | 配对 URI | `dshr:/p?v=1&s=<ws url>&n=<label>&psk=<b64>[&t=<6位>]`；**必须用 `URLSearchParams` 生成**（`+`→`%2B`）；解析侧必须能处理"未编码 `+`"的重试路径；`t` 仅 `/^\d{6}$/` 才采纳；`n` 缺省 `'dsh'`；`v` 不校验 | mp-client §4；relay §3.4 |
| B9 | 字符串常量 | `'dsh-rc/v1'`、`'dsh-rc/v1/nonce'`、`'c2h'`、`'h2c'`、`0x1f`、`'ciphertext'`、`'dshr:/p?'`、参数名 `v/s/n/psk/t`、`'dsh'`、`'c_'`、`'wechat-mp'`、`'微信小程序'` | relay §3.8 |

### 2.2 帧与字段名

| # | 冻结项 | 规格 | 来源 |
|---|---|---|---|
| F1 | 明文帧名 | `hello` `hello-ok` `auth` `auth-ok` `auth-fail` `pair-begin` `pair-ready` `pair-begin-client` `paired` `pair-fail` `peer-joined` `peer-left` `enc` `enc-batch` `ping` `pong` `error` 的**既有语义不得挪用**；新增帧名必须落进客户端 `default` 分支（即被静默忽略） | mp-client §2.1/§8-5 |
| F2 | 客户端只发 3 帧 | `hello{t,role:'client',protocol:1,clientId,clientMeta}`、`pair-begin-client{pairingToken}`、`enc{t,sessionId,seq,clientId,ciphertext}`。不发明帧、不发 `ping`、不发凭据、不做 HTTP 轮询 | mp-client §1.1 |
| F3 | 双 `sessionId` | 中继帧外层 `sessionId` = **配对通道 id**（`c_` + 12 hex）；payload 里的 `sessionId` = **DSH 会话 id**，且必须与 `sessions[].id` 同名同值。混用 = 聊天页过滤掉所有事件 | mp-client §8-11；relay §4 |
| F4 | 必发帧 | `hello` 之后必须 `hello-ok`；`paired` 必须带 `sessionId` | mp-client §8-6 |
| F5 | 错误分支 | `error.code === 'unknown_session'`（字面量）是客户端**唯一**据此清配对并提示重扫的 code；host 掉线必须发 `peer-left`；只断连接会让手机困在「重连中」 | mp-client §3.3 |
| F6 | 配对失败枚举 | `pair-fail.reason ∈ 'invalid_or_expired' \| 'already_used' \| 'host_offline' \| 'bad_token'`（逐字，客户端有中文映射表）；`rate_limited` 未映射会露英文 | mp-client §3.4 |
| F7 | 会话列表唯一源 | `ev.session_changed{sessions[]}`，元素字段 `id`(必填)/`state`/`running`/`title`/`workspace`/`updatedAt`；`state ∈ 'idle'\|'running'\|'detached'\|'archived'\|'awaiting-permission'\|'awaiting-answer'`；**`updatedAt` 若给则必须是 ISO-8601 字符串**（给数字会让整页渲染抛错并被静默吞掉） | mp-client §2.3 |
| F8 | 列表推送义务 | 收到 `cmd.list_sessions` 与任何会话状态变更后，**必须额外推 `ev.session_changed`**；`ev.result.data.sessions` 手机不看 | mp-client §8-10 |
| F9 | 流式收尾 | `ev.message_delta{messageId,delta,done}`：每条消息**最终必须有一条 `done:true`**，且空文本的 done 帧不可被合并逻辑丢弃 | mp-client §8-12 |
| F10 | 审批/提问回传 | `decision` 是主机下发 `options[].id` 的**逐字**值；`'reject'` 有 UI 语义；`answers=[{questionId,selected:[id],freeText?}]` 顺序同 `questions`，`freeText` 是**整卡共享** | mp-client §8-14/15 |
| F11 | 无 sessionId 的两个 payload | `ev.keep_awake_state{enabled,active,platform,backend}`、`ev.session_changed` 都**不带** `sessionId`，将来也不得加上（加了会被聊天页当别的会话丢掉） | mp-client §2.2；relay §4.2 |
| F12 | 批量帧 | 若启用，形状必须是 `{t:'enc-batch',sessionId,items:[{seq,ciphertext}]}`，`sessionId` 只在外层，客户端逐项解密并保持数组顺序 | mp-client §3.5 |
| F13 | `seq`/`clientId` 语义 | 中继**不得**校验 `seq` 单调（小程序冷启动必从 1 重来）；`clientId` 在 `enc` 上可选、是弱随机非秘密，**不得**参与密钥或当凭据 | mp-client §3.6 |

### 2.3 运行时与传输

| # | 冻结项 | 规格 | 来源 |
|---|---|---|---|
| T1 | 帧类型 | **只允许文本 JSON 帧**；binary 帧在小程序里被 `JSON.parse` 静默丢弃 | mp-client §6 |
| T2 | 帧大小上限 | ≥ 256 KiB（现网值）；超限是硬断开 1009，收紧会直接掐断流式输出 | mp-client §8-23 |
| T3 | 顺序性 | 同一会话**必须串行投递**，客户端无去重/排序能力 | mp-client §3.6 |
| T4 | 保活 | **只能靠 WS 层 ping**（客户端与 host 都不发应用层 `ping`）；改判应用层心跳会周期性踢掉空闲客户端 | relay §5.4 |
| T5 | 关闭码 | `1001` 停机、`1013` 繁忙、`1009` 超限、`1008` 限流、`4001` 鉴权爆破、`4008` 配对爆破、`4000` 顶号——客户端的重连策略依赖这些语义 | relay §9-18 |
| T6 | WS 路径 | 保持"根路径与任意路径都可 upgrade"；收窄成 `/ws` 会让已发布的地址全部连不上 | relay §9-20 |
| T7 | HTTP 端点 | `/healthz` 字段集 `ok/version/uptimeSec/hosts/clients/conversations/pendingPairs/shuttingDown`、`/api/info{publicUrl,protocol}`；`/api/pair-status` **默认必须 404**（否则给 6 位码装了免认证判定 oracle） | relay §5.6 |
| T8 | 中继地址来源 | 小程序不硬编码任何域名，地址来自二维码 `s=` 或用户手填（`ws://`/`wss://` 任意 host:port/path 都必须接受）。生产沿用 `wss://drc.provid.cc` 只为省掉微信后台 socket 白名单变更 | 本次实测：`mp/` 全量 grep 无硬编码中继地址；`drc.serverUrl` 为运行时存储 |

## 3. 冻结契约怎么被机械锁定

不靠人记住上面三张表，靠三件事：

1. **golden vectors 作为唯一事实源**（`e2e/fixtures/wire-vectors.json`）。
   向量由**保留的小程序代码**产生：`e2e/mp-sim.mjs` 的 wx shim 就位后加载真实 `mp/core/codec.js`，
   对固定 + 随机输入导出 `{psk, convId, dir, key, payload, nonce, ciphertext}` 与 QR 文本对。
   新 `@dsh-rc/protocol` 必须**逐字节复现**同一批向量。方向包含：MP 密封→Node 打开、
   Node 随机 nonce 密封→MP 打开、篡改必须拒、错钥必须拒、`open` 短记录返回 null、60KB 载荷往返。
   为什么用 fixtures 而不是每次现跑：现跑依赖 mp 模块可加载，fixtures 则让协议层单测在
   任何环境都能跑，而"mp 现跑对拍"作为独立的第二层测试继续存在（两层都要绿）。
2. **真实客户端闭环测试**（`e2e/mp-client.test.mjs` 的后继者）：加载 `mp/core/client.js` 本体
   （禁止出现"测试专用客户端"），对面接**新的** host 与中继，跑完配对→列表→delta→工具→审批→
   done→提问→回答→防休眠→中断→nonce 不重复→陈旧 conv 降级为 `needs-pair`。
   这条测试就是 F1-F13 的执行判据。
3. **兼容性自查清单**：§2 的每条在本阶段绿之前必须有一条对应测试或一次真链路取证。
   无法覆盖的（例如 `ev.*` 新帧名的容忍）必须显式写成"未验证"，不得默认通过。

## 4. 与旧实现的三处有意偏离

这三处**不需要改小程序**，是重写才做得到的；每一条都是旧实现自己承认比声明的边界更宽，或结构上无法达成
（取证见各条）。它们需要单独拍板，见 §8。

**D1 — PSK 不再过网。** 旧中继在 `pair-begin` 里收到 PSK，只按字符长度校验就存进 `pendingPairs`，
此后全文件再未读取该字段（取证：`legacy-spec/relay-and-wireformat.md` §5.7 与 §9-27，锚点
`main.mjs:279`、`287-292`、`305-307`）；而 `docs/SECURITY.md` 的信任表声明中继"不持有任何载荷密钥"。
改法：`pair-begin` 只带 `pairingToken`（PSK 留在 host 本地的 `Map<token,{psk,expiresAt}>`——这个多槽结构
本来就是 §4.5 事故换来的既有约束），中继仍然只按 token 路由、仍把 `pairingToken` 回给 host 取 PSK。
小程序侧无影响：`pair-begin-client` 本来就不带 PSK（`mp/core/client.js:257`），`paired` 也只回
`{hostId,sessionId}`。收益：中继内存里不再存在"TTL 窗口内的第二份密钥副本"，声明与实现一致。

**D2 — 配对码不落 info 日志。** 旧实现在 `pair-ready` 处把 6 位码写进 info 级日志
（取证：`relay-and-wireformat.md` §5.7，锚点 `main.mjs:294`），意味着"日志泄露 + 二维码泄露"两项同时到位
即可在 TTL 内完成配对。改法：默认级别只记 `pair token issued {token: '<redacted>', ttlMs}`，
完整码降到 `debug`（本地排错仍可开）。零知识审计断言不变。

**D3 — 会话跨客户端断连存活（这条是产品缺陷修复，不是加固）。** 实测：旧中继在客户端 socket 关闭时
把该 client 从所有会话移出，会话空了就删除（`apps/server/src/main.mjs:378-388`，第 385 行
`if (conv.clients.size === 0) conversations.delete(cid)`），host 侧收到 `peer-left` 后同样删掉自己那份
（`packages/plugin/src/relay-client.ts:225-226`）。而小程序明确写了续用路径——重连后拿旧 convId
直接 `cmd.list_sessions`，状态文案「已连接，正在同步会话列表」，列表到达后转为「已连接到主机」（`mp/core/client.js`）。
后果：**手机每次回前台都要重新扫码**，旧实现只能靠 host 定时重发新码（`pairOnStartSec`，默认 0=关）来绕，
那是"逼用户重新配"而不是"续上"。
改法：中继侧 `conversations` 在**客户端**断连时保留（带 TTL，如 7 天无活动则回收），
同一 `clientId` 重新 `hello` 时把它重新挂回原会话；host 侧不再因 `peer-left` 丢弃会话与密钥，
只在 host 自身重启（PSK 随之消失）或中继重启时失效——届时仍走既有的 `unknown_session` → 提示重扫路径。
兼容性：`peer-left` 的**语义收窄**为"host 离开"，客户端侧行为不变（它本来就只在收到 `peer-left` 时丢配对，
而这条只应由 host 掉线触发）。
代价与边界：convId 的生命周期变长，等于把"知道 convId"的有效期拉长；但 convId 一直是路由凭证而非密钥，
且必须配 PSK 才能解密，D4（成员校验）会把这条的收益坐实。

**D4（随 D3 一起做）— `enc` 要求发送方是该会话成员。** 旧中继只校验 `sessionId` 命中路由表，
任何匿名 socket 都能往已知会话灌密文（取证：`relay-and-wireformat.md` §1 补充事实，锚点 `main.mjs:344-357`）。
新实现按 `convId → {hostId, clientIds}` 校验；`clientId` 非秘密，所以这是**降低误灌与盲打**，不是认证，
文档必须这么写，不得夸成安全边界。注意两条兼容底线（F13）：`clientId` 在 `enc` 帧上仍是可选，
所以成员校验的落点应当是「`hello` 建立的 socket 身份 ↔ 会话成员表」，而不是「`enc` 帧里的 clientId 字段可信」。

## 5. 模块边界

分层规则只有一条，但它是硬的：**协议与策略是纯函数，副作用全在适配器里。**
这样 §2 的每条契约、每个窗口化参数、每条持锁策略都能在不起 cordis、不起 socket、不碰文件系统的前提下被测。

### 5.1 `packages/protocol` — 协议层（纯，无 I/O、无定时器、无平台符号）

| 模块 | 职责 | 冻结项 |
|---|---|---|
| `record.ts` | `seal` / `open`：记录布局与失败语义 | B1 B2 B3 |
| `keys.ts` | `kdfHash` / `derivePskKey` / `noncePrefix` / `buildNonce` | B4 B5 B6 |
| `pairing.ts` | 配对 URI 生成与解析、配对码归一化 | B7 B8 |
| `frames.ts` | 控制面帧的判别联合 + 逐帧 narrow 校验器 | F1-F6、T7 |
| `payloads.ts` | `cmd.*` / `ev.*` 类型 + 校验器 + `SessionSummary` | F7-F12 |
| `keepawake.ts` | 三平台命令构造器（纯函数，与 spawn 解耦） | relay §6 |
| `ids.ts` | `convId`（`c_`+12hex）、6 位码、host id | B9、F3 |

编译产物被中继当**纯类型**使用（devDependency），被插件**打包内联**（§5.3），被 e2e 直接 import。

### 5.2 `apps/server` — 零知识中继（运行时依赖只有 `ws`）

```
main.ts      env 校验 → http+ws 装配 → 优雅停机
config.ts    环境变量与默认值（逐项继承旧值，见 relay §5.3 表）
tables.ts    hosts / clients / pendingPairs / conversations —— 唯一可变状态所在
handlers.ts  控制面帧 → 表操作 → 下行帧（不 import 任何 crypto）
forward.ts   enc / enc-batch 路由、成员校验（D4）、per-conversation 串行（T3）
limits.ts    令牌桶、帧速率、爆破计数、大小与连接数上限
http.ts      /healthz /api/info /api/pair-status(默认 404)
log.ts       一行一 JSON；日志行的类型里**不存在**能放载荷的字段
```

结构性零知识：`forward.ts` 把 `ciphertext` 当不可透明字符串搬运，中继里**没有** `tweetnacl` 依赖，
也（D1 之后）没有任何地方出现过 PSK。审计断言因此是"从依赖图上就成立"，再由 §7 的帧审计测试兜住。

不变量（写在 `tables.ts` 顶部，逐条有测试）：
1. `conversations` 的唯一创建点是配对成功；`sessionId` 前缀恒为 `c_`。
2. `pendingPairs` 是 `Map<token, {hostId, expiresAt, used}>`，多码并存；条目按服务端 TTL 清扫。
3. host 重连时新 socket 先注册，旧 socket 的 close 回调必须靠 `hosts[id].ws === ws` 守卫不误删会话。
4. 客户端断连**不再**删除会话（D3）；删除时机是 host 离开、会话 TTL 到期、或显式解配。
5. host 离开必须向该会话所有 client 发 `peer-left`；客户端离开只通知 host。

### 5.3 `packages/plugin` — host 插件（cordis bundle）

依赖方向：`shell → core → ports`，适配器实现 ports；**只有 `platform/` 与 `shell/` 允许 import cordis 与
`@deepseek-ai/*`**。`core/` 在完全不知道 cordis 存在的前提下可测（这是旧实现做不到的地方，
它的 36 项插件测试要靠手写 cordis 替身）。

```
shell/apply.ts     cordis apply() 外壳：探测 → 装配 → 降级；绝不向外抛异常
shell/config.ts    配置键、默认值、校验、warn（缺服务只降级不拒启动）
shell/status.ts    status.json 原子写（0600 + tmp 改名）
shell/commands.ts  /drc 命令注册（纯文本返回 → 二维码走 PNG+打开，见 §5.5）

ports/kernel.ts    KernelPort：listSessions / getState / sendPrompt / interrupt /
                   resolvePermission / answer / subscribe / setModel / unarchive / probe
ports/transport.ts TransportPort：connect / auth / publishPairing / sendEnc / onFrame
ports/sleep.ts     SleepPort：supported / start / stop / backend
ports/clock.ts     时钟与定时器注入（窗口化与持锁策略因此可确定性地测）

platform/carrier-services.ts   真实 cordis services 适配器（优先级最高）
platform/carrier-*.ts          其余 carrier / 降级适配器（能力差异见 P1 取证）
platform/mock-kernel.ts        测试与"内核面不可用"时的降级实现
platform/guard.ts              订阅守卫：唯一允许的 on() 入口，waterfall 事件名一律拒订
platform/sleep-caffeinate.ts / sleep-systemd-inhibit.ts / sleep-windows.ts

core/runtime.ts    HostRuntime：cmd 分发、会话簿记、F8 的推送义务、回执与幂等
core/window.ts     delta 合并器（纯，参数化：窗口时长/字符上限/会话数上限）
core/keys.ts       conv → {kC2H,kH2C} 与 seq 簿记
core/sleep-policy.ts 何时持锁/释放（策略与 backend 分离）
pairing/slots.ts   多码槽位 + 按服务端 ttlMs 改写本地过期
pairing/qr.ts      矩阵 → 终端文本 / PNG（编码器来自 npm，见 §6）
```

打包：`tsup`（esbuild）产出**自包含** bundle，externals 只留 cordis 与平台包。
这一次性消掉三个旧机制——`scripts/bundle-protocol.mjs`（存在理由只是 `pnpm add file:` 无法解析
`workspace:*`，取证：该文件头注释）、`src/vendor/qrcode-generator.ts`（数千行移植）、
`qr.ts` 里手写的 CRC32 + grayscale PNG 编码器（其注释写着"因为插件装进外部 profile 必须保持零依赖"）。
依赖被内联之后，"零依赖"这个理由不再成立，那些轮子就不必再自己造。
`install-to-profile.sh` 也随之简化：产物只有 bundle + package.json，复制即可，
且不再受"pnpm 对 `file:` 依赖是硬链接拷贝、重建后 inode 变了 profile 里仍是旧副本"这个坑影响
（取证：`HANDOFF.md:74-75`、`scripts/install-to-profile.sh` 注释）。

### 5.4 `e2e/` — 测试装置（不是产品代码，但它是契约的执行机构）

```
tools/gen-vectors.mjs        用真实 mp/core/codec.js 作 oracle 生成 golden vectors
fixtures/wire-vectors.json   冻结的字节向量（协议层测试的唯一事实源）
mp-sim.mjs                   最小 wx shim（只 shim 客户端核心真用的 API）+ createRequire 加载 mp 真身
protocol.test.mjs            新协议层 vs fixtures；以及 vs mp 现跑（两层都要）
mp-client.test.mjs           真实 client ↔ 新中继 ↔ 新 HostRuntime 全闭环
mp-platform.test.mjs         socket 能力探测与回退
relay.test.mjs               中继闭环 + 配对状态机
hardening.test.mjs           加固 10 项 + 日志零知识断言（旧实现收集了日志行却没用，本次补上）
run.mjs                      本地端到端（含帧审计，带帧数下界）
multi-pair.test.mjs          多码并存按所用码取 PSK（D1/旧 §4.5 回归）
live-e2e.mjs                 三个真实：真实 mp 代码 + 线上中继 + 真实内核，绝不退化 mock
```

### 5.5 组件与依赖数量（红线自查）

常驻组件：DSH 进程内的插件、中继进程、小程序——**3 个，与旧实现相同，不新增进程/队列/数据库**。
新增持久化：**0**（中继仍是纯内存，这是有意设计，取证：`HANDOFF.md:180-181`——PSK 落盘扩大泄露面）。

## 6. 依赖清单（原则：能用开源就不造轮子，且不为此多引一个传递依赖链）

| 用途 | 选型 | 进谁的运行时 | 为什么不是自研 |
|---|---|---|---|
| WebSocket 服务端/客户端 | `ws` | 中继、插件 | 旧实现已验证够用；中继部署是 `scp + npm install --omit=dev`，依赖越少越稳 |
| 密码学原语 | `tweetnacl`（+ `tweetnacl-util`） | 协议层（进插件 bundle） | 与小程序 vendored 版**同库同算法**；`nacl.hash` 就是 SHA-512，跨运行时一致。前提：§7.0 的逐字节对拍实测通过 |
| 二维码编码 + PNG | `qrcode`（node-qrcode） | 插件 bundle 内 | 旧实现试过自写编码器，被 zxing-cpp 对拍抓出系统性差异后否决（取证：`qr.ts:5-9`）；PNG 容器也无需再自写 |
| 载荷/帧校验 | **`zod@^4.6`** | 协议层（进插件 bundle） | 这条原本是"判断而非事实"（我倾向手写 60 行 narrow 函数，理由是别为十几个字段引依赖树），**被实测推翻**：zod 闭包只有 1 个包、0 运行时依赖、2.2M ops/s——是中继 500 帧/秒上限的约 4400 倍，性能与体积两条反对理由都不成立，而手写要维护两份契约并丢掉"类型从 schema 推导"。取证 `legacy-spec/open-source-options.md` §A.5.1、§C |
| 构建 | `typescript` + `tsup` | dev | 替掉自研 `bundle-protocol.mjs`；产物自包含 |
| 测试 | `node:test`（内置） | dev | 旧实现如此；避免把测试框架变成生产依赖 |
| 日志 | `log.ts`（约 20 行 `JSON.stringify` 行） | 中继 | 一行一 JSON 就是全部需求；`pino` 在这里是净增运维面（多一个依赖、多一层 flush/序列化语义） |
| 防休眠 | 系统工具 `caffeinate` / `systemd-inhibit` | 无（外部命令） | 本就不是轮子；三平台命令构造器必须自研并单测（relay §6） |

明确不用：`fastify`/`koa`（旧 HANDOFF §7 已否决，无值守环境优先降低工具链风险）、`uWebSockets.js`
（native 模块在 ECS 上的构建/升级风险）、msgpack/protobuf/binary 帧（T1：小程序只吃文本 JSON）、
X25519 握手（小程序无 CSPRNG，mp-client §6 与 HANDOFF §7）。

## 7. 分阶段执行与验收

每阶段一条硬规则：**验收命令全绿 → 立即提交 → 才进下一阶段**。红了就停在原地修，
不许绕过、不许降低判据、不许"先跳过后面补"。命令一律 `env -u NODE_OPTIONS` 前缀跑 pnpm
（取证：`HANDOFF.md:64-70`，WorkBuddy 的 FS 钩子会拦 pnpm 的符号链接操作）。

| 阶段 | 交付 | 验收（必须全绿） | 提交点 |
|---|---|---|---|
| **0 清场** | 删除 `packages/*`、`apps/`、`e2e/`、`scripts/` 旧实现；保留 `mp/`、`deploy/`、`.github/` 骨架；新 workspace/package.json/tsconfig 骨架；本设计与取证档案入库 | `pnpm install -r` 通过；新骨架能 build 出空产物；`git status` 干净（不允许有"以后再删"的旧文件残留） | `chore: 清空旧实现，落 v2 骨架` |
| **A 协议层** | `packages/protocol/src/{record,keys,pairing,frames,payloads,sleep,ids}.ts` + 单测 + `e2e/fixtures/wire-vectors.json`（由真实 `mp/core/codec.js` 作 oracle 生成） | ① 协议层单测绿；② **golden vectors 逐字节复现**；③ **mp 现跑对拍**双向绿（MP 密封→Node 打开、Node 随机 nonce→MP 打开、篡改/错钥/短记录必拒、60KB 往返、CJK/emoji 不截断）；④ QR 生成→`mp` 解析器解出等价对象（含未编码 `+` 的兼容路径） | `feat(protocol): 从零实现线格式与 payload 契约` |
| **B 中继** | `apps/server/src/*` + `tests/{relay,hardening}.test.mjs` | ① 配对状态机全路径绿（含 `pair-ready.ttlMs`、多码并存、一次性 `already_used`、4 个 reason 逐字）；② 加固 10 项（1009/1013/1008/4001/4008、帧速率、pendingPairs 有界、healthz 计数、SIGTERM 退 0 且对端收 1001、pair-status 默认 404）；③ **日志零知识断言**（旧实现收集了日志行却没有任何断言用它，本次补上）；④ D1 之后源码里不存在 `psk` 字段的读取；⑤ D3/D4：客户端断连后会话存活并可重挂，非成员灌 `enc` 被拒 | `feat(relay): 零知识中继重写（含 PSK 不过网与跨断连续用）` |
| **C 插件** | `packages/plugin/src/{shell,ports,platform,core,pairing}/**` + 单测 + tsup 打包 | ① 激活降级：任何平台符号缺失都不得抛出，`apply()` 永不外抛；② **订阅守卫**：测试断言 waterfall 事件名无法被订阅（黑名单清单来自 P1 取证）；③ carrier 探测优先级与各 carrier 能力差异；④ 窗口化 5 条（不丢文本/不重排/空文本 done 帧必须转发/异类事件先 flush/stop 要 flush）；⑤ 归档会话标记+自动恢复+可关；⑥ 配置校验只拦"真不可用"；⑦ status.json 字段与 0600 原子写；⑧ `pnpm -r build` 产物**自包含**（在临时空目录里 `node -e "require(bundle)"` 不报缺依赖） | `feat(plugin): cordis bundle 重写（端口/适配器分层）` |
| **D 真链路** | `e2e/*` 全套（新写的 mp-sim、run、multi-pair、live-e2e、restart-resume） | ① 本地 relay e2e：9 步闭环 + 帧审计（`enc` ≥10 帧、每帧密文 >40B、不含命令名与正文、整段观测不含正文关键词）；② `node e2e/mp-client.test.mjs` 用**真实 `mp/core/client.js`** 跑完 12 项闭环；③ `multi-pair` 绿；④ **live-e2e 三个真实** `--rounds 3` 全绿（每轮独立取新的一次性码，10 项/轮，出现 `ses_mock*` 即判失败，拿不到真码直接失败不退 mock）；⑤ **中继重启续用取证**：SIGTERM→重启→旧 convId 走 `unknown_session`→重新配对成功（旧实现只在文档里写，无测试）；⑥ **审批/提问真机取证**：在一个 restrictive preset 的真实会话上跑通一次审批 + 一次提问，并从内核自己的 session log 取到对应 resolve/answer 事件（做不到就如实记"未验证"并说明卡在哪，**不得用单测代替**）；⑦ 二维码 28 组 zxing-cpp 真实解码 | `test(e2e): 真实链路验收（含审批取证与重启续用取证）` |
| **E 上线** | `scripts/*` 重写、README/HANDOFF/SECURITY/SELF-HOSTING/MINI-PROGRAM 面向 v2 重写、CI 工作流更新 | ① CI 全绿（Node 20/22）；② 生产切换后 `curl https://drc.provid.cc/healthz` 为 `ok:true` 且 `hosts>=1`；③ 切换后**再跑一次** live-e2e `--rounds 3` 全绿（打的是线上中继）；④ 回滚路径可用且写进 HANDOFF（保留上一版产物目录）；⑤ 真实链路绿之后文档里的"当前状态"必须与实测一致，不得残留旧实现的数字 | `docs: v2 交付文档与部署切换` |

阶段依赖：A→B→C 严格串行（B 要 A 的帧类型，C 要 A+B 的产物）；C 的 `core/` 与 `platform/` 可并行开发
（端口是契约）；D 依赖 C 的全部完成；E 依赖 D。

## 7.1 "全部 e2e 通过"的定义（收尾判据）

只有下面这组命令全部绿，才算完成：

```sh
env -u NODE_OPTIONS pnpm -r test          # 协议层 / 插件 / 中继 单测（≥83 项等价覆盖，逐文件可数）
node e2e/protocol.test.mjs                # 新协议层 vs golden fixtures + vs 真实 mp 现跑（逐字节）
node e2e/mp-client.test.mjs               # 真实 mp/core/client.js ↔ 新中继 ↔ 新 HostRuntime 闭环
node e2e/mp-platform.test.mjs             # socket 能力探测与回退
node e2e/multi-pair.test.mjs              # 多码并存按所用码取 PSK
node e2e/run.mjs                          # 本地 9 步闭环 + 零知识帧审计（带帧数下界）
node e2e/restart-resume.test.mjs          # 中继重启 → unknown_session → 重新配对成功
node e2e/live-e2e.mjs --rounds 3          # 三个真实：真实 mp 代码 + 线上中继 + 真实内核
node scripts/validate-qr.mjs              # 28 组 zxing-cpp 真实解码（含 CJK / 公网 URL）
```

三条结构性红线从旧实现原样继承，并在测试代码里体现（取证：`legacy-spec/testing-and-tooling.md` §8.3）：
**禁止拿不到真实材料就换替身并通过**；**禁止空判定**（所有"收到了 X"必须带数量下界）；
**禁止重试洗绿**（重试只允许覆盖一次性码的已知竞态）。

## 7.2 明确不做（本次）

- Windows 防休眠的真实实现（本机无 Windows，最多做到命令构造器字符串层面，实机无法取证 → 列为后续项）。
- 图片/文件附件、多主机切换（两者都需要动 `mp/`，与"小程序一行不改"直接冲突）。
- 中继持久化（PSK/配对关系落盘扩大泄露面，`HANDOFF.md:180-181` 的既有否决）。
- 引入常驻组件（第 3/第 4 个进程、队列、数据库）与运行时新增重型框架。

## 8. 拍板记录（2026-10-02）

| 项 | 决定 | 执行含义 |
|---|---|---|
| D1 PSK 不过网 | **做** | `pair-begin` 只带 `pairingToken`；PSK 留在 host 本地多槽表；中继源码里不存在 `psk` 读取，测试断言这一点 |
| D2 配对码不落 info 日志 | **做** | 默认级别 `<redacted>`，完整码降到 `debug` |
| D3 会话跨断连存活 | **做** | 客户端断连不删会话（TTL 7 天无活动）；同 `clientId` 重连重挂；host 不再因 `peer-left` 丢会话与密钥 |
| D4 `enc` 成员校验 | **做**（随 D3） | 校验落点是"socket 身份 ↔ 成员表"，不改 F13 的兼容底线（`clientId` 仍可选、仍非凭据） |
| 审批/提问卡真机取证 | **带** | 阶段 D 第 ⑥ 项；做不到就写"未验证 + 卡点"，不得用单测交差 |
| 中继重启续用取证 | **带** | 新增 `e2e/restart-resume.test.mjs` |
| Windows 防休眠 / 附件 / 多主机 | **不带** | 见 §7.2 |
| 生产切换 | **本地全绿后直接切** | D1 改了 `pair-begin` 字段 → 旧 host 插件与新中继不兼容，**切换与插件重装必须同一次完成**；回滚 = 换回上一版产物目录 + restart |
| 本机 Harness 重启 | **授权按需重启** | 阶段 C/D 我需要重启使插件生效，重启后从 `status.json` 取证 `carrier=services` |

### 4.5 实现期新增的偏离（需一并记账，复核 R6 指出 §8 原本漏登记）

| 编号 | 变更 | 为什么 | 手机端影响 |
|---|---|---|---|
| D5 | `auth`/`auth-ok`/`auth-fail` 并入 `hello`/`hello-ok`，鉴权失败统一 `error{code:'bad_token'}` | 旧中继里 host 与 client 各有一套注册路径，是同一件事的两份代码 | 无：小程序只发 `hello{role:'client'}`，`hello-ok` 上多出的 `role` 字段它不读 |
| D6 | 主机 socket 断开先进**宽限期**（`DRC_HOST_GRACE_MS`，默认 120s），超时才向客户端发 `peer-left` | 没有它，一次网络抖动就逼用户回电脑前重新扫码 | 无：`peer-left` 的语义收窄为"主机真的走了"，正是客户端已有的解读方式 |
| D6b | 新错误码 `host_unavailable`（会话在、主机暂时不接） | 与 `unknown_session` 必须区分：后者会让客户端**丢掉配对**，前者只是"稍后再试" | 正向：避免把"暂时没人接"升级成"你得重新扫码" |
| D7 | 新增帧 `resync{sessionIds}` + 允许主机发 `session-leave{sessionId}` 作废会话 | 复核 R1：D3/D6 之后出现新死角——**主机重启**丢了 PSK 而中继仍保留会话，手机会对着没有钥匙的对端永远转圈，且 `unknown_session` 永不发生 | 正向：两条路径都保证手机最终拿到中文的"请重新配对"提示 |
| D8 | 删除 `session-list` 帧、`cmd.subscribe` 载荷、`enc-batch` 的 `unknown_frame` 命运（中继现在真的支持批量） | 前者从未被发送/处理/消费，后者是 no-op | 无 |
| D9 | 移除 `apiProxy` 与 `typert` 两个载体 | 桌面态从未注册 `apiProxy`，旧实现那条路的参数信封整个是错的（读 `res.sessions` 而平台返回 `result.items`；发指令缺 `payload` 包装）；`typert` 只有 `invoke()`，不能列会话也不能发指令 | 无（这两条路在真机上从未成功执行过）；代价是"若未来某代宿主只提供 apiProxy"需要重新实现——那时按取证表写对信封即可 |

### 2.4 F1 的准确口径（复核指出 F1 与 D5 冲突，改写为两侧分别冻结）

- **消费面冻结**：`mp/core/client.js:208-250` 的 `case` 白名单（9 个帧名 + `enc`/`enc-batch` + `default` 忽略）
  一个都不许改语义——这是小程序实际会解释的东西。
- **生产面可退役**：`auth`/`auth-ok`/`auth-fail` 不在小程序的 case 表里（它从不发送也从不消费），
  随 D5 退役；新增帧名（`resync`）只出现在 host↔relay 之间，落进小程序的 `default` 分支被忽略。
- 判别依据很简单：**一个帧名如果出现在 `mp/core/client.js` 的 switch 里，它就是冻结的**；否则是我的内部协议。

## 9. 执行日志（按日期追加，只记实测结果，不记计划）

### 2026-10-02 · 阶段 A 完成

`packages/protocol` 从零写完（`bytes` / `keys` / `record` / `pairing` / `frames` / `payloads` /
`sleep` / `ids` / `index`，8 个模块 + 284 条 golden 向量）。实测：

- `pnpm --filter @dsh-rc/protocol test` → **68 项全绿**；
- `node --test e2e/protocol.test.mjs` → **17 项全绿**，含
  ① 284 条向量逐字节复现（UTF-8/base64 8+42、KDF 13、会话密钥 144、nonce 前缀 12、
  计数器 nonce 12、密封记录 12、配对 URI 33、配对码归一化 8）；
  ② 60 组随机向量两侧**双向互解**且同钥同 nonce 密文逐字节相同；
  ③ 篡改 7 个不同位置，两侧**结论一致**地拒；
  ④ 原语层三方一致：npm `tweetnacl`、小程序 vendored `nacl-fast`、`node:crypto` 的 SHA-512；
  ⑤ 反证测试：把 KDF 末尾分隔符去掉后向量立刻不匹配（证明这套断言真的在守东西，不是空判定）。

顺带证实/修正的三件事：

1. **小程序的 `seal()` 强制要求显式 nonce**（`mp/core/codec.js:90-93` 抛错），
   所以"小程序加密 → 我们解密"这一方向的对拍必须显式喂 nonce；这是 B6"无 CSPRNG"约束的直接体现。
2. **入站 base64 的严格度差**不只含空白，还含空串：`js-base64` 会先剔空白再解，
   `Buffer.from(s,'base64')` 对非法字符静默丢弃，而协议层的 `frames.base64Text` 两者都拒。
   测试把"我们只能更严、且严在哪"写成了断言，而不是留成口头结论。
3. **D5（新增一条偏离）**：`auth`/`auth-ok`/`auth-fail` 三帧并入 `hello`/`hello-ok` 一条注册路径，
   失败统一 `error{code:'bad_token'}`。理由与影响见 `packages/protocol/src/frames.ts` 文件头——
   小程序从不发 `auth`，因此这条改动**对手机端零影响**，省掉一整套重复的握手分支。
   同时删掉两个从未被使用的声明：`session-list` 帧与 `cmd.subscribe` 载荷。
4. **zod 取代手写校验**（§6 那条"判断而非事实"被实测推翻，见 §6 表格更新）。

### 2026-10-02 · 阶段 B 完成（中继）

`apps/server` 从零写完：`config` / `log` / `limits` / `state` / `server` / `main` + `tsup`→`esbuild` 产物。
实测 `pnpm --filter @dsh-rc/server test` → **62 项全绿**（state 单测 + relay 端到端 + hardening + bundle 产物级断言）。
复核落地的那几条都在这一批里有了机械防线：R1 的 `resync`/`session-leave` 路由、R2 的中文 `message`、
R3 的 client 顶号（4000 replaced）、R5 的 bundle 唯一入口、R7 的 F1/F3/F4/F11/T1/T3/T6 逐条成测。

### 2026-10-02 · 阶段 C 收口：7 个"测试全绿但行为是错的"

第一版插件写完时有 129 项单测**全绿**，而其中 7 条行为是错的——这是本次重写最贵的一课：
绿色的测试套件不等于行为正确，判据必须能**杀掉**实现里的错。逐条修掉并各配一条红测试，
再用变异验证（把实现改回错的形状，看有没有测试失败）确认每条都被真正锁住：

| # | 缺陷 | 后果（手机上看得见的那一面） | 变异验证 |
|---|---|---|---|
| 1 | `StatusFile.start()` 的 tick 只调 `refresh()`、把返回值丢掉 | status.json 永远停在启动那一版：`carrier`/`relay` 不再更新，而 live-e2e 取配对码读的就是这个文件 | `status-no-write` → 定时刷新那条红 |
| 2 | `pushSessions` 的 500ms 合并把被合并的那次**丢弃**（不补发） | F8 要求"状态变了必须额外推 session_changed"，丢掉就变成"发完指令列表停在旧状态，最长等 15 秒兜底刷新" | `runtime-merge-dropped` → 尾随推送那条红 |
| 3 | `voidConversation` 对本地没有记录的 convId 直接 `return` | 复核 R1 的出口被堵死：主机重启后中继仍把手机密文转过来，手机既等不到回复也等不到 `unknown_session`，表现是"永远转圈且没有任何提示" | `relay-void-noop-unknown` → 两条红（主动声明 + enc 撞上陌生 convId） |
| 4 | 入站载荷只验 MAC 不验形状（`open<CmdPayload>` 直接递给 runtime），且 `switch` 缺 `default` | 一条密文就能决定宿主被怎么调用；同时 `pair-fail` 这个 case 根本没有——手机扫完码主机侧完全无痕 | `relay-no-cmd-schema` → 形状拒收那条红 |
| 5 | `maxCharsPerFrame` 只当"何时 flush"，没当"多大" | 一次到达 5 万字符仍出一帧 5 万字符，可能顶到中继 `MAX_FRAME_BYTES` 被断链：手机表现为"聊着聊着掉线" | `window-no-hard-cap` → 硬上限那条红 |
| 6 | flush 删掉 entry 后重建，`part` 归零 | 一条长回答的所有分片都是 `part:0`，"分片是否连续"这个唯一判据形同不存在 | `window-part-reset` → 连续性那条红 |
| 7 | `Number(env) \|\| 0` 放行 `Infinity`（它是真值） | `DRC_PAIR_ON_START_SEC=Infinity` = 这张带着 PSK 的配对码永久有效，正好是这条配置想避免的事 | `config-or-zero` → 非有限值那条红 |

顺带两处机械卫生：三个包的 `test` 脚本原本**手写测试文件名清单**（插件那份还列着不存在的
`qr.test.js`，`pnpm test` 直接 MODULE_NOT_FOUND），改成 `node --test "dist/tests/*.test.js"` 后
新增文件不可能被静默跳过；`pnpm-workspace.yaml` 里 `allowBuilds.esbuild` 被留成 pnpm 报错模板原文
（`set this to true or false`），改成布尔 `true`。

实测：协议层 **76** 项、中继 **62** 项、插件 **138** 项全绿。
唯一仍然红的不是判据本身，而是 `packages/plugin/src/index.ts` 里在改的载体探测块引用了未定义的
`scoped`（5 处 TS2304）——`tsconfig` 的 `noEmitOnError: true` 因此不产出 JS，插件的 `pnpm test`
（含 build）暂不能跑通；上表的插件断言是先编译再 `node --test` 跑的。这条随真机 carrier 取证一起收。





### 2026-10-02 · 阶段 C/D 完成 + 生产切换（真实链路证伪了两条判据）

**载体探测**：cordis 的 `ctx` 是 Proxy，读它没有的属性名是**抛错**，`?.` 挡不住。
`ctx.onDispose?.()` 因此把我们的 fiber 打进 FAILED，并连带 dispose 六个 `ctx.inject` 子 fiber
→ 服务明明在、`carrier=none`。改用真存在的 `ctx.effect`；探测属性存在性用 `'x' in ctx`
（走 has trap，不抛）。真机现在报 `carrier=services`、六个服务全在、`hasOn=true`、25 个归档会话。

**活码策略**（`core/pairing-window.ts`）：`pairOnStartSec` 的语义是"保持一张活码可用"。
旧实现挂在 3s 状态循环里的三条 stale 判据（无码 / 中继代次变了 / 过半程）一条都没被测过
（`legacy-spec/host-plugin-runtime.md` §7.4 第 12 条自己记着这件事）；重写后抽成纯策略，
并加第四条——**码已被消费**就当场换一张（多轮取证因此不必重启宿主）。
10 条断言逐条变异验证。配套 `publishPairing` 改为返回"是否真的上过网"：
本地记一张中继没收到的码，是最难查的一种谎。

**真实链路取证抓出的四处"测试全绿而手机上看不见"**，共同形状是**判据数的是帧而不是内容**：

1. `assistant/message` 的正文在 `data.message.content`，第一版只读顶层 → 回复折成空串；
2. runtime 对"正文与 done 同到"的一条完整消息只走 `complete()`，而 complete 对缓冲区里没有
   这条消息的情形发的是 **done-only 帧** → 辛苦读出来的正文被丢掉。内核没有 token 级增量，
   所以这本来就是主路径；
3. `tool/call` 的参数叫 `arguments` 不叫 `args`；`tool/result` 的 callId 在 `message.toolCallId`、
   正文在 `message.content`；
4. 事件回调是裸交给 cordis 的 emit 的（`guardedSubscribe` 只保护注册那一步），
   一次抛错会打断派发甚至拆掉整条订阅 → 表现是"回合跑到一半再也没事件"而 status.json 一片祥和。

①② 最可怕的地方是 `live-e2e` 的"⑧ 流式输出到达 / ⑨ 有 done"两条断言**照样通过**。
所以判据也改了：⑧ 等"发完指令之后的第一条 idle"（手机自己那条回声同样带 done:true）；
⑧b 断言助手正文非空；⑧c 断言这一轮不是以内核报错收尾；⑩c 用 B5 的 h2c 密钥在测试侧
自解每一帧下行密文，与主机 `outbound` 计数对账——"手机没收到"从此能分清是没发、没转、还是没解。
status.json 新增六个字段：`outbound` / `eventTypes` / `unmappedEventTypes` / `listenerErrors` /
`approvalFace` / `questionsFace`。

**部署与安装**：profile 的 package.json 里残留 `"dsh-remote-control": "file:…"`，
`pnpm install` 会把插件再物化一份进 profile，于是宿主里同时跑**两个实例**
（两个 hostId、两份会话，手机连到哪个全凭运气），而 status.json 的计数来自另一个实例——
这条误导了整整几轮排查。安装器现在拒软链、整目录先删后建、并删掉那条依赖。
CI 与 systemd 改指单文件产物（复核 R4/R5 的破口补齐），三个包统一 `typecheck`；
中继版本改由打包 define 注入（旧断言只验"version 是个字符串"，`0.0.0` 也算过）。
`pair-fail.reason` 枚举收回小程序能翻译的四个（F6），限速原因只进日志。

**实测**：`pnpm -r typecheck` 三包全绿；协议 76 / 中继 62 / 插件 173 / e2e 50 全绿，
`pnpm -r test` 全绿；`run.mjs` 13 步全绿；二维码 zxing 真实解码 28/28；
生产 `wss://drc.provid.cc` 切换后真链路 **18 项全绿**（助手正文与 2 条工具行确实到达手机），
本地中继 `--rounds 3` **36 项全绿**，每轮一张不同的新码。

**仍未取证（按未验证记账，不写作已通过）**：真机上的审批卡与提问卡。
审批参与者登记在真宿主上是 `approvalFace="registered"`，但这些会话的策略从不发起审批；
提问这一代宿主没暴露提供者（`questionsFace="no userQuestions provider"`，
模型自己也说没有 AskUserQuestion 工具）。两条卡片的闭环只在本地全链路里验过
（`e2e/mp-client.test.mjs` 第 5/6 条、`run.mjs` 第 7/9 步）。
§7-C 那两条硬验收（⑨ 中断走 cancel、⑩ 审批/提问订阅取证到的真实通道）里，
⑨ 已按 `agent.cancel({kind:'user'},{keepInbox:true})` 落地并有调用形状断言；
⑩ 的"真实通道"这一半只到登记成功，端到端仍未在真机取证。
