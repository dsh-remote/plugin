# 安全模型

> 本文描述的是 **2026-10-02 从零重写之后**的代码（基线提交 `b026d63` 之后，`packages/protocol`、
> `apps/server`、`packages/plugin` 全部是新写的，`mp/` 是接口权威）。
> 旧实现的安全叙述里有若干条已经**作废**，逐条列在〈这一版相对旧实现改了什么安全属性〉一节。
>
> 面向的读者是"要把这套东西部署到自己机器上的人"。每条论断后面都跟着 `文件:行号`，
> 请把它当成可核对的引用而不是修辞。

## 一句话

**中继服务器是不可信的。** 它只负责把密文从 A 搬到 B，看不到任何指令内容、会话标题、
审批详情或模型输出。而且这一版比旧版更彻底：**中继连密钥本身都没有过**（见 D1）。

## 怎么读这份文档：三种证据等级

绿色测试守不住的东西，本文不会写成"已经这样了"。每个论断都标了等级：

| 标记 | 含义 |
|---|---|
| 🟩 | **已由测试守住**——后面跟着具体测试文件与行号 |
| 🟨 | **代码里成立但没有测试**——读代码可以确认，跑红了不会有人知道 |
| 🟦 | **只是设计意图/未取证**——目前没有证据，别当既有属性来依赖 |

判据的总数（按 `^test(` 逐个数源码，不跑测试）：中继 63（`apps/server/tests/`：bundle 3 +
hardening 13 + relay 32 + state 15）、协议层 81、插件 208、`e2e/` 另算。
`README.md` 测试表里写的是**实际跑出来**的条数（中继 63 / 插件 208）——两种数法现在一致，
但别当理所当然：循环或参数化生成的用例会让"数源码"和"跑一遍"分叉，对不上时先看是哪一种。

## 信任边界

| 角色 | 持有什么 | 不持有什么 |
|---|---|---|
| Host 插件（跑在你的机器上） | PSK（每次配对一张，内存里）、会话密钥、`DRC_HOST_TOKEN`、DSH 内核访问权 | — |
| 中继服务器 | `DRC_HOST_TOKEN`（只用于验证 host 身份）、配对码 → 会话 id 的路由表 | **任何载荷密钥，也从来没有过**（D1）；看不到明文 |
| 小程序客户端 | PSK（配对时从二维码拿）、会话密钥 | `DRC_HOST_TOKEN` |

载荷一律是 `base64( nonce(24) ‖ nacl.secretbox(utf8(JSON), nonce, key) )`，
外层对象只有一个字段 `ciphertext`（冻结项 B1，`packages/protocol/src/record.ts:35-47`）。
服务器看到的帧长这样：

```json
{ "t": "enc", "sessionId": "c_9f3c1a2b3d4e", "seq": 12, "ciphertext": "2Yb7…" }
```

控制面（`hello` / `pair-begin` / `pair-ready` / `paired` / `pair-fail` / `peer-joined` /
`peer-left` / `error`）是明文的，但里面没有任何业务内容。

### 中继看得到 / 看不到（元数据要说实话）

端到端加密不隐藏"谁在何时通信"。按当前实现逐条分：

| 中继看得到 | 中继看不到 |
|---|---|
| 每条连接的 role（`hello.role`，`server.ts:149-200`）、hostId、**人类可读的 host label**（`frames.ts:65`）、clientId、clientMeta（platform/label，`frames.ts:48-53`） | 任何明文载荷：指令正文、会话标题、模型输出、工具参数 |
| convId（`c_` + 12 hex，`paired`/`peer-joined` 里明文，`server.ts:248-250`） | PSK —— 从未出现在中继的进程内存、类型或产物里（D1） |
| **6 位配对码本身**（`pair-begin` 与 `pair-begin-client` 都明文带着，`server.ts:207`、`233`） | 密文的任何一个明文字节（它只校验字符集是不是合法 base64，`server.ts:443-446`、`frames.ts:43-46`） |
| 帧的到达时刻、条数、字节数、方向、每会话的 seq（下行由中继重新编号，`server.ts:282-285`） | host 的 DRC 会话 id（只在密文载荷里，F3） |
| 谁被踢（4000 顶号）、谁掉线、会话表计数（`/healthz`，`server.ts:526-534`） | — |

"配对码明文经过中继"是 D1 的**剩余面**：中继知道码的值但不知道对应的密钥，所以它拿这个码
只能占一个配对席位，解不开任何一帧。这条要写清楚，别把 D1 说成"密钥与授权都离场了"。

### 结构性零知识：现在有产物级证据 🟩

旧文档只能写"中继里没有 crypto 的调用"。这一版的保证强一档，是**依赖图上不可达 + 产物里搜不到**：

- `packages/protocol/package.json:48` 标了 `sideEffects:false`，并且把每个模块做成子路径导出
  （`:9-47`）。中继只 import `@dsh-rc/protocol/frames`、`/ids`、`/outbound`
  （`apps/server/src/server.ts:17-38`、`state.ts:22-23`），**从不** import 根入口或
  `/record`、`/keys` → `tweetnacl` 不在打包图里，tree-shaking 把它整块摇掉。
- `apps/server/tests/bundle.test.mjs:22-33` 直接读打出来的单文件，断言
  `xsalsa20 / secretbox / tweetnacl / nacl_verify / salsa20 / poly1305` **零命中**，
  同时反向断言它确实是那个东西（含 `pair-begin-client`、`/healthz`）且小于 3 MB。
- 同一个测试文件 `:94-98` 把上面那个前提本身也钉住了（`sideEffects === false`）。
- `apps/server/tests/bundle.test.mjs:35-92`：把这个单文件拷进**空目录**（没有 node_modules）
  用真子进程启动，应答 `/healthz`，`SIGTERM` 退 0。这就是生产部署的形状：scp 一个文件。

诚实的补一句：产物里唯一出现"PSK"字样的地方是一行注释
（`apps/server/dist/bundle/main.js:23562`，来自 `packages/protocol/src/frames.ts:189-190`），
它不是代码也不是数据；上面那批 marker 覆盖的是实现，不包含字符串"psk"。
`apps/server/tests/state.test.mjs:57-63` 补的是数据面那一刀：
`pendingPairs` 条目运行时只有 `['expiresAt','hostId','used']` 三个键，`'psk' in entry === false`。

### `auth` 这个帧名已经不存在 🟩

D5 之后 host 与 client 共用一条注册帧：host 发
`hello{role:'host', protocol:1, token, hostId, label}`（`packages/plugin/src/transport/relay.ts:122`、
`packages/protocol/src/frames.ts:58-69`），鉴权失败统一 `error{code:'bad_token'}`
（`apps/server/src/server.ts:160`）。`auth`/`auth-ok`/`auth-fail` 三个名字已从端点帧的判别联合里
删除（`frames.ts:138-148`）——旧文档里凡是写 `auth` 的地方都错了，包括那张握手图。
`apps/server/tests/relay.test.mjs:572-589` 把"借用的旧帧名不许触发任何状态机"做成了断言。

## 配对流程（当前实现）

```
Host                                Relay                           小程序
 │ slots.create() → 16B PSK + 6 位码
 │   （PSK 只落本地内存，packages/plugin/src/core/keys.ts:120-128）
 │── pair-begin{pairingToken} ─────▶ 登记 (token → hostId, TTL)，**没有 psk 字段**
 │                                   （transport/relay.ts:151 / server.ts:202-218 / state.ts:45-50）
 │◀─ pair-ready{pairingToken,ttlMs} ─  服务端权威 TTL，主机必须改写本地过期
 │                                   info 日志只写 <redacted>（server.ts:216，D2）
 │  终端打印二维码 dshr:/p?…&psk=…&t=<6位>
 │                                   ◀── hello{role:client,clientId} ──（mp/core/client.js:117-123）
 │                                   ──▶ hello-ok{role:'client',clientId}
 │                                   ◀── pair-begin-client{pairingToken}（client.js:257）
 │                                 ◀── paired{sessionId,hostId} ───────（server.ts:248）
 │◀── peer-joined{sessionId,clientId,pairingToken} ──（server.ts:250：这一条**必须**带码）
 │  按这张码取 PSK → 派生（relay.ts:255-261；取不到就拒绝这条配对）
 │  双方各自派生：kC2H = KDF('dsh-rc/v1','c2h',convId,psk)[0..32]
 │               kH2C = KDF('dsh-rc/v1','h2c',convId,psk)[0..32]（protocol/src/keys.ts:66-68）
 │◀════════════════ enc 帧（密文，服务器只搬运）════════════════════════▶│
```

安全属性：

1. **PSK 每次配对都新生成**（16 字节 Node CSPRNG，`keys.ts:114-116`），只通过你眼前的二维码
   传递，**一次都不上网** 🟩：`packages/plugin/tests/relay-client.test.ts:147` 断言发出去的
   `pair-begin` 里只有一个 6 位码；`e2e/multi-pair.test.mjs:48-124` 在真链路上用"手机实际用的
   那张码"的 PSK 解开主机的每一帧下行，并且断言用"最新那张码"的密钥**一帧都解不开**。
2. **配对码单次使用**：中继把 `used` 标记留到 TTL 清扫，所以重放拿到的是 `already_used`
   而不是 `invalid_or_expired`——这两个 reason 在手机上是不同文案（F6）🟩
   （`apps/server/src/state.ts:148-166`；测试 `state.test.mjs:65`、`relay.test.mjs:248`）。
   默认寿命 120 秒（`DRC_PAIR_TTL_MS`，`apps/server/src/config.ts:102`），公网建议 60 秒。
3. **方向分离**：`c2h` / `h2c` 是两把不同的密钥 🟩（`keys.ts:66-68` +
   `packages/protocol/tests/keys.test.ts:71` + `packages/plugin/tests/ids-and-keys.test.ts:26`）。
4. **会话密钥绑定 convId**，convId 每次配对新生成（`c_` + 48 bit，
   `packages/protocol/src/ids.ts:14-16`、`state.ts:158`）🟩（`ids.test.mjs:46-56` 断言形状）。
5. **前向安全：⚠️ 仍然没有** 🟦。PSK 派生的会话密钥在一次配对里复用。
   影响范围是一次配对（convId 每次换），不是永久历史。要做到严格前向安全需要 X25519 握手，
   而这条路在小程序侧走不通（下一节）。
6. ⚠️ **默认配置下二维码就是单因子，不再是"双因子"**。旧文档写"只截获二维码并不能完成配对，
   还得在 TTL 内猜中 6 位码"——**这句已经不成立**：主机生成的 URI 默认把 6 位码内嵌进去
   （`packages/plugin/src/index.ts:271` 把 `token` 一起传给 `buildPairingUri`，
   `packages/protocol/src/pairing.ts:70-77` 只在码是 6 位数字时写 `t=`），
   而小程序读到 `t=` 就**直接发起配对，不再让用户输一遍**
   （`mp/pages/pair/pair.js:248-266`，注释原话是"扫码/粘贴即连，不再让用户手输一遍"）。
   只有 URI 不带 `t`（旧码、或有人手工去掉）时，才回到"扫码给密钥 + 手输给授权"的两步
   （`pair.js:265` 那句 toast）。

   所以诚实的说法是：**谁先拿到这张二维码，谁就先得到这台主机的一次配对席位与它的 PSK。**
   拿到之后他能读这台主机的全部下行（插件对每条配对通道都广播会话列表与流式输出，
   `transport/relay.ts:177-183`；拓扑按 1 host : 1 client 设计，`core/runtime.ts:448-460`），
   而真正的机主会拿到 `already_used`，必须回到电脑前重新发一张码。
   这条风险**依赖的是信道可见性**（拍照、截屏、终端回滚、`status.json` 与
   `pairing-qr.png` 的残留），不是密码学强度。旧文档"坦率地说这条依赖信道"的表述保留，
   但要把"双因子"那句删掉。

## 主机不认得这条 convId：`resync` 与 `session-leave`

D3/D6 让配对通道跨断连存活之后，出现了一个旧实现没有的死角：**主机进程重启**（PSK 随进程消失）
而中继不知道，于是它继续把手机发来的密文转给一个解不开的主机；手机既等不到回复，也等不到
`unknown_session`——表现是"永远转圈且没有任何提示"。这一版有协议级出口（偏离 D7，动机写在
`packages/protocol/src/frames.ts:116-132` 的 `resyncFrame` 注释里）：

- 主机在 `hello-ok` 之后**立刻**发一条 `resync{sessionIds}`，声明它此刻还持有密钥的通道
  （`packages/plugin/src/transport/relay.ts:240-243`）。中继把该主机名下**没被列出**的会话删掉，
  并且**不**向客户端发 `peer-left`——那在小程序里只有一句提示；被删掉的会话让手机下一次发帧
  自然撞上 `unknown_session`，从而拿到中文的"会话已失效，请重新扫码配对"
  （`apps/server/src/server.ts:321-332`、`state.ts:217-231`、`server.ts:111-122`）🟩
  （`relay.test.mjs:390-410`）。
- 主机还能对**具体某一条**它不认得的通道发 `session-leave{sessionId}`，中继随即向该会话所有
  客户端发 `peer-left`（`server.ts:337-365`）。主机侧的触发点是
  `RelayClient.voidConversation()`（`transport/relay.ts:205-216`）：本端**没有**这条记录时
  同样要声明——这是"主机重启之后"唯一的出口，写在注释里，也是修过的真 bug
  （`DESIGN.md:372-382` 第 3 条）。
- 另一条触发是"连续两帧解不开就作废"（`transport/relay.ts:336-341`），与手机侧
  "两帧解不开就丢配对"对称（`mp/core/client.js:294-305`）🟩
  （`packages/plugin/tests/relay-client.test.ts:288`、`:377`、`:389`）。

三种重启的实况：

| 事件 | 会话/密钥的下场 | 手机看到的 | 证据 |
|---|---|---|---|
| 手机回前台 / 客户端 socket 断连 | **都留着**（成员表按 clientId 记账，重连自动重挂） | 直接续用，不要求扫码 | 🟩 `state.ts:290-302` + `state.test.mjs:125` + `relay.test.mjs:298` + `e2e/restart-resume.test.mjs:88-127` |
| 主机 socket 抖动 | 宽限期 120s 内不通知客户端；期间回来一切照旧 | 什么都看不到 | 🟩 `state.ts:309-350` + `relay.test.mjs:324`、`:426`（`host_unavailable` 而非 `unknown_session`） |
| 主机进程重启 | PSK 全丢；新 socket 上线后 `resync{[]}` 把旧 convId **主动作废**；本地密钥簿清零 | 中文提示"重新配对" | 🟩 `transport/relay.ts:237-243`、`core/keys.ts:102-110` + `relay-client.test.ts:268` + `e2e/restart-resume.test.mjs:206-262` |
| 中继重启 | 路由表是内存的，**旧配对一律作废**；旧 convId 撞上 `unknown_session` | 中文提示"重新配对" | 🟩 `e2e/restart-resume.test.mjs:144-189`（含"错误码必须逐字 unknown_session"） |
| 手机里点"解除配对" | **谁都不通知**：小程序只清本地存储（`mp/core/client.js:143-148`，它从不发 `session-leave`，`grep session-leave mp/` 为空）；中继的成员关系与主机的密钥仍留着，直到空闲 TTL | 无 | 🟨 代码形状如此，无测试 |

这条出口同时意味着两句要写进威胁模型的话：**中继重启后旧配对全部作废**；
**主机重启后它自己不认得的旧 convId 会被主动作废**。两者都落到中文提示上，这是设计目标。

## 为什么小程序用 PSK 而不是 X25519

原因很实在，而且和旧版一样是**环境约束**不是口味：

- 小程序侧不依赖容器 CSPRNG。vendored 的 `nacl-fast` 被打了补丁：
  只保留"从 globalThis 拿 crypto.getRandomValues"这一条路径，否则**让 PRNG 保持未初始化**
  （`mp/core/vendor/nacl-fast.js:2363-2388`，注释明说"宁可抛错，也不要悄悄退化成
  `Math.random()`"）。而 `codec.seal()` 强制要求显式 24 字节 nonce
  （`mp/core/codec.js:90-93`）——手机侧的加密入口根本不调用 `nacl.randomBytes()`。
- X25519 密钥生成必须有 CSPRNG，且这条链路里没有任何办法验证容器给的是不是真随机。

PSK 方案在这里成立的条件（逐条都在代码里）🟩：

- PSK 是 **Node 侧** 16 字节 CSPRNG 生成的（`packages/protocol/src/keys.ts:114-116`），
  每次配对新生成（`packages/plugin/tests/ids-and-keys.test.ts:194` 断言两张码的 PSK 互不相同）；
- 线格式与小程序那份实现**逐字节**一致，判据有两层：
  `e2e/fixtures/wire-vectors.json` 的 golden vectors（`e2e/protocol.test.mjs:61-140`，
  含 KDF 13 组、会话密钥 144 组、nonce 12 组、配对 URI 33 组）+ 现跑对拍
  （`:150` 60 组随机双向互解、`:180` 篡改任意一位两侧一致拒绝、`:272` 反证：去掉 KDF 末尾
  分隔符向量立刻全红——证明这套断言真的在守东西）。oracle 是保留下来的真
  `mp/core/codec.js`，`:56` 那条测试还断言 oracle 文件本身没被改动。

**nonce 怎么办？** 手机侧是计数器 nonce：
`SHA-512('dsh-rc/v1/nonce'␟installId␟convId␟psk␟)[0..16] ‖ counter(8B 大端)`
（`packages/protocol/src/keys.ts:77-111`；小程序侧同形态
`mp/core/session-store.js:85-91`，计数器持久化，app 重启不会在同一 key 下复用 nonce）。
唯一性论证：密钥已经绑定 (PSK, convId, 方向)，前缀又绑定 installId，而存储被清空时
installId 与配对一起消失。主机→手机方向用随机 nonce（Node 有 CSPRNG，`record.ts:35-46`）。
字节等价由 `e2e/protocol.test.mjs:110-122` 与 `:124`（同钥同 nonce 密文逐字节相同）守住 🟩。

## 6 位配对码的暴力枚举（已知风险与缓解）

码空间只有 10⁶。中继的缓解与**逐字的环境变量名**（对照 `apps/server/src/config.ts:102-115`，
三个名字相对旧版改过，见下面那张改名表）：

| 变量 | 默认 | 作用 | 触发后的表现 | 证据 |
|---|---|---|---|---|
| `DRC_PAIR_TTL_MS` | 120000 | 服务端权威寿命；主机必须按 `pair-ready.ttlMs` 改写本地过期 | 过期后 `invalid_or_expired` | 🟩 `relay.test.mjs:214`、`transport/relay.ts:231-233` |
| `DRC_PAIR_ATTEMPTS_PER_CONN` | 5 | 单连接失败次数（**成功一次即清零**，`server.ts:247`） | close 4008 | 🟩 `hardening.test.mjs:175-190` |
| `DRC_PAIR_GLOBAL_PER_SEC` | 20 | 全局令牌桶（固定窗口，1s 重置，`limits.ts:17-42`） | 拒绝 + 日志写 `rate_limited`，线上写 `invalid_or_expired` | 🟩 `hardening.test.mjs:192-216` |
| `DRC_HOST_AUTH_MAX_ATTEMPTS` | 5 | 单连接 host token 失败次数 | close 4001 | 🟩 `hardening.test.mjs:218-230` |
| `DRC_MAX_PENDING_PAIRS` | 1000 | 待配对表上界 | `error{pair_table_full}` | 🟩 `hardening.test.mjs:260-276` |
| `DRC_PAIR_STATUS` | 关 | 打开才提供 `/api/pair-status` | 默认 404 | 🟩 `relay.test.mjs:550-568` |
| `DRC_MAX_CONNS` / `DRC_MAX_FRAMES_PER_SEC` | 200 / 500 | 连接数与单连接帧速率 | 1013 / 违规 3 次后 1008 | 🟩 `hardening.test.mjs:232`、`:157` |

改名表（**旧文档里的名字全部作废**；顺带提醒 `docs/SELF-HOSTING.md:17-19` 的表格还写着旧名，
按本文这张改）：

| 旧名 | 现名 | 默认 | 出处 |
|---|---|---|---|
| `DRC_MAX_AUTH_ATTEMPTS` | `DRC_HOST_AUTH_MAX_ATTEMPTS` | 5 | `config.ts:106` |
| `DRC_MAX_PAIR_ATTEMPTS` | `DRC_PAIR_ATTEMPTS_PER_CONN` | 5 | `config.ts:107` |
| `DRC_MAX_PAIR_ATTEMPTS_PER_SEC` | `DRC_PAIR_GLOBAL_PER_SEC` | 20 | `config.ts:108` |

量化（把上界写清）：限速真正绑死的是**全局** 20/s，因为 4008 之后手机的 socket 层会自动重连、
计数按连接重新起（`mp/core/socket.js:174-178`、`:265-274`；重连不读 close code）。
一次配对窗口内能被猜的次数 ≈ 20 × TTL：默认 120s 是 2400 次 ≈ **0.24%**，
公网把 TTL 调到 60s 是 1200 次 ≈ **0.12%**。

**猜中了能得到什么（这一版要说实话）**：猜中码 ≠ 拿到明文。中继只会为这张码新建一条通道、
把发起者的 socket 记成成员；主机按这张码取出自己那份 PSK 并派生密钥，而攻击者手上没有 PSK——
他收得到下行密文但解不开，也发不出主机能解开的上行（连续两帧解不开后主机会把这条通道作废，
`transport/relay.ts:336-341`）。猜中码的实际收益是三件较弱的事：
①**抢占**这张一次性码，让真机主拿到 `already_used`（必须回到电脑前重新发码）；
②短暂占住一个配对席位，可能把审批/提问卡片的投递抢到自己那条通道上
（`core/runtime.ts:456-460` 的 `pickConversation` 取"第一条有对端的通道"），
真手机因此收不到卡片，桌面侧要等 `approvalTimeoutSec`（默认 180 秒，
`packages/plugin/src/shell/config.ts`）之后按 `decline` 处理 🟨；
③一条只对他自己有效的路由席位。

**`pair-fail` 的 reason 是冻结的消费面** 🟩：只能是小程序有中文映射的四个
`invalid_or_expired` / `already_used` / `host_offline` / `bad_token`
（`packages/protocol/src/frames.ts:176-183`，映射表 `mp/core/client.js:356-364`）。
限速原因**只进中继日志**（`apps/server/src/server.ts:226-231`）。这条有两道机械防线：
`apps/server/tests/hardening.test.mjs:192-216` 断言线上出现的 reason 一定在那四个里、
且日志里必须出现 `rate_limited`；`e2e/protocol.test.mjs:301-315` 直接从冻结源文件
`mp/core/client.js` 里**解析出映射表的键**再比对枚举，小程序加了键、或我们擅自多一个键，
测试都会红。

**仍需你在反代层做的**：按 IP 做连接与请求速率限制。中继看不到真实客户端 IP
——它从不读 `X-Forwarded-For`/`X-Real-IP`（`grep -rn X-Forwarded apps/server/src` 为空），
只有全局与单连接两种配额。仓库带的 nginx 已经配了
`limit_req 20r/s burst=40` 与 `limit_conn 8`（`deploy/nginx/drc.conf:19-20`、`:52-53`）。

要更强的保证就把码加长：三处必须一起动，而第三处改不了
（`packages/protocol/src/frames.ts:30`、`packages/protocol/src/pairing.ts:37`、
小程序 `normalizePairingToken` 的 6 位正则 `mp/core/codec.js:200-202`）。线协议本身不绑位数。

## 数据面的入口收紧

**中继侧**（全部 fail-closed，非法即拒且不崩）🟩（`relay.test.mjs:459-486`）：

- 只接受文本帧；二进制直接 `error{bad_frame}`，因为小程序会把 binary 静默丢进
  `JSON.parse`（`server.ts:405-408`，冻结项 T1）。
- 帧必须先通过 zod 判别联合（`frames.ts:138-148`）；`enc`/`enc-batch` 的每条 `ciphertext`
  还要单独过**字符集**校验（`server.ts:443-446` + `frames.ts:43-46`），理由是
  `Buffer.from(s,'base64')` 对非法字符是静默丢弃——不能让"手机能发、主机报错"这种假故障发生。
- 未知帧名 vs 形状非法是分开的两个错误码（`unknown_frame` / `bad_frame`，
  `server.ts:422-441`），而且发给手机的那一条**必须带中文 message**（`server.ts:111-127`）
  🟩（`relay.test.mjs:667-686`）。

**主机侧**（这里才是真正会碰你机器的地方）🟩：

- MAC 过了不等于形状对。入站载荷必须先过 `parseCmdPayload`，否则**不进 runtime**
  （`transport/relay.ts:312-323`）。这条是真 bug 换来的（`DESIGN.md:372-382` 第 4 条：
  "一条密文就能决定宿主被怎么调用"），测试是 `relay-client.test.ts:232`。
- 手机能让你这台机器做的事，就是 `cmdPayload` 那个封闭联合里的 **6 条**
  （`packages/protocol/src/payloads.ts:194-262`）：`cmd.send_prompt`、`cmd.interrupt`、
  `cmd.resolve_permission`、`cmd.answer`、`cmd.list_sessions`、`cmd.keep_awake`。
  旧的 `cmd.subscribe` 已删（它是个 no-op）。**没有**任意工具执行、任意文件路径、任意 shell
  ——手机能间接做到的事，取决于被恢复的会话里那个 agent 自己有什么权限。
- 宿主事件订阅只走白名单：`session/event`、`session/created`、`agent/status`、`agent/error`
  （`packages/plugin/src/platform/guard.ts:25-35`），名单外一律拒订；waterfall 事件
  （`guard.ts:47-70`，含 21 个宿主自己声明为参与式的名字）一个都不放行，只有
  `approval/request` 允许以**参与者**身份注册（`guard.ts:84`）🟩
  （`packages/plugin/tests/guard.test.ts:72`、`:93` 自校验"白名单与 waterfall 清单交集为空"）。
  这条守的不是机密性，是"插件不许把内核每个 turn 都搞崩"（旧事故：订阅 `agent/request`
  返回 undefined 冲掉了整条链，`guard.ts:8-13` 记着）。
- 回调本体也被包起来了（`guardedSubscribe` 只保护注册那一步）：异常不冒回内核，
  计数进 `status.json` 的 `kernel.listenerErrors`（`packages/plugin/src/platform/carrier-services.ts:362-378`）
  🟩（`carrier-services.test.ts:173`）。

**载体只剩两个**（偏离 D9）🟨：`services`（真内核面）与 `mock`（开发与冒烟）。
`apiProxy` / `typert` 两个弱 carrier 整个删掉了——桌面态从未注册 `apiProxy`，旧实现那条路的
参数信封整个是错的；`typert` 只有 `invoke()`，接上去是一台"永远空列表"的机器
（理由与取证在 `docs/DESIGN.md:326`；代码侧的判定在 `packages/plugin/src/index.ts` 的 `tryStart`，
它只在 `hasServices()` 为真时 start，看到 `apiProxy` 只记一条诊断日志就不再接）。
`mockBridge` 默认关（`packages/plugin/src/shell/config.ts:66`），真链路测试里有专门一条
"看到 `ses_mock*` 就判失败"（`e2e/live-e2e.mjs:207-208` 的检查 ⑤b）🟩。

## 传输层：TLS 是部署方的责任

中继自己不终止 TLS，而且**默认只绑回环**（`DRC_BIND` 缺省 `127.0.0.1`，
`apps/server/src/config.ts:100`；只有它自己就是边缘时才设 `0.0.0.0`）：

```
小程序 ──wss/TLS──▶ nginx ──ws(明文, 仅本机)──▶ relay:8787
```

`deploy/nginx/drc.conf` 里现成有 TLS 1.2/1.3 + HSTS + nosniff
（`:39-45`）与长连接所需的 `proxy_read_timeout 3600s`、`proxy_buffering off`（`:65-67`）。
即使本机那一段是明文，走的也已经是端到端密文。TLS 仍然必要：

- 防止中间人篡改控制面（例如换掉 `paired` 的 `sessionId`，或者**注入/重放下行与上行密文帧**）；
- 防止配对码与 `clientId` 在明文 `ws://` 上被顺走（插件配置会对
  "非回环地址走 ws://"给出明确 warn：`packages/plugin/src/shell/config.ts:120-124`）🟩
  （`packages/plugin/tests/config.test.ts:68`）；
- 元数据（谁在什么时候连了多久）只在这里泄露。

真机必须 `wss://` 且域名要在小程序后台的 **socket 合法域名** 白名单里。这句话的约束来源是
微信平台，不是我们的代码——`mp/pages/pair/pair.js` 只校验 `^wss?://` 形状。
`mp/core/socket.js:24-45` 那段做的事只是把微信那句英文的 `url not in domain list`
翻成人话并指明去哪儿改。

⚠️ **慢消费者断开（1008）这条要单列**：`apps/server/src/server.ts:129-145`——某条连接的发送缓冲
持续超过 `DRC_MAX_BUFFERED_BYTES`（默认 1 MiB，`config.ts:113`）**10 秒**就 `close(1008, 'slow_consumer')`。
三个诚实的限定：

1. 阈值（1 MiB / 10 s）是从参考实现（dshr 规范）搬来的**参考值，不是我们的实测值**——
   `docs/legacy-spec/open-source-options.md:597` 自己承认，`docs/DESIGN-REVIEW.md:400` 也把它列为
   "该采纳，但两点要补"。本项目 256 KiB 的帧上限下、真实大输出会话里该取多少，仍然没测。
2. 它和小程序的重连节拍可能形成**循环**：手机侧连接超时 12 s、退避上限 30 s
   （`mp/core/socket.js:19-22`），而 `socket.js:174-178`/`:224-228` 的 `onClose` 回调**丢弃了
   close code**——所以 1008 对手机就是"一次普通断开"，它会带着指数退避回来，慢的手机会被
   反复踢，用户只看到"连接已断开，正在重连…"。`docs/DESIGN-REVIEW.md:529` 记的就是这条。
3. 判定点是"**刚发过帧的那一方**的缓冲"（`server.ts:453` 在消息处理末尾调用），不是"接收方
   拥塞时由中继主动判"。一个只收不发的拥塞订阅者不会被这条机制回收。🟨 整条机制**没有任何测试**
   （`grep -rn 'slow_consumer\|bufferedAmount' apps/server/tests e2e` 为空）。

保活同理：只走 WS 层 ping（`server.ts:482-499`，每 `DRC_SWEEP_MS`＝5 秒一轮，上一轮没回
pong 就 `terminate()`）。改判应用层心跳会周期性踢掉空闲客户端（冻结项 T4）。
🟨 这条也**没有测试**，而且**微信小程序容器是否自动回 pong 没有取证**
（`e2e/mp-sim.mjs:23,62` 用的是 Node `ws`，它一定回；真机回不回是平台行为）。

## 密钥与凭据存放在哪

**Host 侧**

- PSK 与两把方向密钥只在内存：`PairingSlots`（`packages/plugin/src/core/keys.ts:150-212`，
  多槽表，超上限淘汰最旧那张）与 `ConversationBook`（同文件 `:59-145`）。进程重启即失效——
  这正是上面"主机重启会主动作废 convId"那节的原因。
- **这本账现在有上界了**（复核 🟡8，`docs/DESIGN-REVIEW.md:526`；旧实现与 HEAD 版本没有）🟩：
  `PrunePolicy{ idleTtlMs, maxConversations }`（`core/keys.ts:43-47`）、默认
  **空闲 24h 或超过 64 条**（`core/keys.ts:50-54`）、`pruneStale()` 按 `lastActivityAt` 从最
  不活跃的剪（`core/keys.ts:122`），剪的时候**必须同时**发 `session-leave` 并回调上层
  （`transport/relay.ts:161-167`），否则手机会对着一条主机已经不认得的通道说话。
  调用点挂在 `status.json` 的 3 秒节拍上（`packages/plugin/src/index.ts:254-258`），
  TTL 由配置项 `conversationIdleTtlSec`（默认 86400，`shell/config.ts:81`）喂进
  `prunePolicy`（`index.ts:241`），且校验**明确拒绝"永不剪枝"**
  （`shell/config.ts:181-184`）。测试：`packages/plugin/tests/relay-client.test.ts:548`、`:572-574`。
  🟨 值得点名的残余：**没有独立定时器**——剪枝依赖 `status.json` 的刷新节拍，把 `statusFile`
  设成空串（关闭状态快照，`shell/status.ts:57-58`、`config.test.ts:133`）就等于关掉了剪枝。
- `status.json`（默认 `~/.dsh/dsh-remote-control/status.json`）：0600 + 临时文件改名原子替换
  （`packages/plugin/src/shell/status.ts:33-47`）🟩（`packages/plugin/tests/status.test.ts:34`、`:45`）。
  里面**绝不含 host token 真值**，只有 `hostTokenShape: redact(token)`
  （`packages/plugin/src/index.ts:292-293`）🟩（`status.test.ts:64`、
  `packages/plugin/tests/config.test.ts:145`）。但要注意 `redact()` 的形态是
  "前 4 个字符 + 后 2 个 + 长度"（`shell/config.ts:168-171`），泄露的是形状而不是秘密；
  以及 `status.json` 的 `pairing` 字段在**有活动配对码时带着 PSK 明文**
  （`packages/plugin/src/index.ts:313`，`describeActivePairing`），
  这正是 `pairOnStartSec > 0` 会被 warn 的原因（`shell/config.ts:176-181` 一带的告警、
  `packages/plugin/tests/config.test.ts:122`）。`pairOnStartSec` 默认 **0=关**
  （`shell/config.ts:71`），关掉时这里不会长期挂着码。
- 二维码图片：`/drc pair` **默认**写出 `<会话工作区>/.dsh/pairing-qr.png`（0600，
  `shell/status.ts:104-108`；工作区解析不出来时退回 `~/.dsh/pairing-qr.png`）并把
  它的路径给用户——因为 DSH 命令卡按 `line-height:1.6` 渲染等宽输出，会把半块文本二维码
  横切成条（实测 zxing 在 ≥1.15 行距即失败），文本码在这个宿主上扫不出来。`qrOpen` 仍然
  **默认关**：写图 ≠ 替用户打开查看器（`shell/config.ts`，`qrImage` 默认 true / `qrOpen` 默认
  false / `qrStyle` 默认 `half`，后者只在显式关掉 `qrImage` 时当退路；命令段见
  `packages/plugin/src/index.ts`）。旧版"默认写 PNG 并 **open**"里自动打开的那半仍然不存在。
- `/drc unpair` 会把手里所有通道作废（对每条走 `voidConversation`，
  `packages/plugin/src/index.ts:720`）🟩（`relay-client.test.ts:352`），这是主机侧的主动解配。

**小程序侧**：PSK、convId、nonce 计数器存在 `wx.setStorageSync` 的
`drc.pairing.v1` 里（`mp/core/session-store.js:11-13,74-76`；写入点 `mp/core/client.js:273-283`，
key 是 `c2h`/`h2c` 派生后的**会话密钥**在内存里，PSK 留在存储）。
丢失它的代价只是重新配对，不会有历史泄露。installId（`clientId`）是
`Math.random()` 拼出来的**弱随机、非秘密**串（`mp/core/codec.js:205-211`）——
协议也明确要求它不得参与密钥、不得当凭据（冻结项 F13，`docs/DESIGN.md:65`）。

**`DRC_HOST_TOKEN`**：中继侧没配就直接拒绝启动（`apps/server/src/main.ts:48-50`，
`config.ts:80-88`；短于 24 字符只 warn）🟩（`hardening.test.mjs:97-106`）。
比较走 `timingSafeEqual`（`server.ts:74-79`）。主机侧的取值优先级是
**环境变量 > patch 注入 > 默认值**（`packages/plugin/src/shell/config.ts:121-134` 一带；
`hostTokenEnv` 默认 `DRC_HOST_TOKEN`）🟩（`config.test.ts:25`、`:42`）。
生产凭据绝不进仓库：只在 profile 的 `cordis.patch.yml`（600）与服务器的
`/etc/dsh-remote-control.env`（600）（`HANDOFF.md:112-114`）。

### 具体地说，凭据泄露等于什么

| 泄露的东西 | 能做什么 | 不能做什么 |
|---|---|---|
| 一张未过期的配对二维码（PSK + `t=`） | 抢在机主之前完成这次配对（一次性），并读取这台主机的会话列表与全部流式输出（拓扑按 1:1 设计） | 解密**别人那次**配对建立的会话（convId 不同 ⇒ 密钥不同） |
| `DRC_HOST_TOKEN` | 用 `hello{role:'host'}` 注册任意 hostId 并**顶掉**真主机的 socket（`server.ts:164-170`、4000），拿到该主机所有会话的下行密文；对任意自己的会话发 `session-leave`（`server.ts:346-355`）；往会话里灌解不开的密文，触发主机"两击作废"（`transport/relay.ts:336-341`） | 读到任何明文（PSK 不在中继，也不在他那里） |
| 某个 `clientId`（明文出现在 `hello` 与每条 `enc` 里） | 抢先注册同一个 clientId → 真手机的 socket 被 4000 顶掉（`state.ts:114-121`，测试 `relay.test.mjs:372`、`:717`），并且**接管该 clientId 在所有会话里的成员席位**（`state.ts:192-209`），于是能往里灌密文、能收下行 | 解密（没有 PSK）；效果是**会话级 DoS**，不是明文读取 |
| 中继进程本身被攻陷 | 选择性丢弃 / 重放 / 改路由（它是唯一的裁判），读全部元数据表 | 解密载荷；也拿不到 PSK——它从来没收到过（D1） |

关于"重放"要写得比旧文档更直白：**同一条会话内没有重放防护** 🟨。
载荷层不记录已见 nonce（`record.ts:56-72` 只验 MAC），runtime 不按 `cmdId` 去重
（`core/runtime.ts:158-214`），中继也不许校验 seq 单调（冻结项 F13）。所以一个能注入或重放的
位置（被攻陷的中继、明文 `ws://` 上的中间人）可以把**观察到的**上行密文帧原样再投一次，
主机这边 MAC 校验通过、命令会被**再执行一遍**（例如 `cmd.send_prompt` 重复发一条提示）。
唯一的边界是它只能重放到"这条帧原本要去的那条会话"，且不能改内容（改了 MAC 就不过）。
旧文档"重放到别的会话无效"那句仍然对，但别读成"重放被防住了"。

## 这一版相对旧实现改了什么安全属性

编号沿用 `docs/DESIGN.md` §4（D1-D4）与 §4.5（D5-D9）。

| 编号 | 变更 | 旧的真实状态 | 现在的状态 | 手机端影响 |
|---|---|---|---|---|
| **D1** | **PSK 从不上网** | 旧中继在 `pair-begin` 里收到 PSK，只按字符长度校验就存进 `pendingPairs`，此后全文件再未读取（取证 `git show b026d63:apps/server/src/main.mjs` 的 279-292 行）。也就是说**旧中继的内存里在 TTL 窗口内确实有第二份密钥副本**，而旧 `SECURITY.md` 的信任表却声明中继"不持有任何载荷密钥"——声明比实现宽 | 类型里就没有 psk 字段（`state.ts:45-50`）；主机只发 6 位码（`transport/relay.ts:151`）；产物级断言零 crypto（`bundle.test.mjs:22-33`）。PSK 只出现在二维码 URI 里，由手机扫码获得 | 无：`pair-begin-client` 本来就不带 PSK（`mp/core/client.js:257`），`paired` 也只回 `{hostId,sessionId}` |
| **D2** | 配对码不落 info 日志 | 旧实现在 `pair-ready` 处把 6 位码写进 info 日志（`git show b026d63:apps/server/src/main.mjs:294`）→ "日志泄露 + 二维码泄露"同时到位即可在 TTL 内配对 | info 只写 `<redacted>`，完整码降到 debug（`server.ts:216-217`）🟩（`hardening.test.mjs:278-332`，含"debug 也不许出现密文内容"） | 无 |
| **D3** | 会话跨客户端断连存活 | 旧实现在客户端 socket 关闭时把该 client 移出所有会话、会话空了就删（`git show b026d63:apps/server/src/main.mjs:378-388`），而小程序明确写了续用路径 → 手机每次回前台都要重新扫码 | 客户端断连**不删会话也不删成员**（`state.ts:290-302`），同 clientId 重连自动重挂；回收时机是空闲 TTL（`DRC_CONV_IDLE_TTL_MS`，默认 7 天，`config.ts:110`）🟩（`state.test.mjs:125`、`relay.test.mjs:298`、`e2e/restart-resume.test.mjs`） | 正向：**回前台不再要求扫码**。代价是 convId 生命周期变长（它是路由凭证，仍必须配 PSK 才能解密） |
| **D4** | `enc` 要求发送方是该会话成员 | 旧中继只校验 `sessionId` 命中路由表，任何匿名 socket 都能往已知会话灌密文 | 成员校验落在"socket 身份 ↔ 成员表"，不看帧里的 `clientId`（`state.ts:192-209`）；上行转发时中继用**自己的 socket 身份**覆写 `clientId`（`server.ts:277`）🟩（`state.test.mjs:159`、`relay.test.mjs:339`、`:358`）。这是**降低误灌与盲打，不是认证**：见上一节"某个 clientId 泄露"那行 |
| **D5** | `auth`/`auth-ok`/`auth-fail` 并入 `hello`/`hello-ok` | 两套注册路径做同一件事 | host 发 `hello{role:'host',token,…}`，失败统一 `error{code:'bad_token'}`（`frames.ts:58-69`、`server.ts:149-200`）🟩（`relay.test.mjs:195`、`hardening.test.mjs:218`） | 无：小程序只发 `hello{role:'client'}`，`hello-ok` 上多出的 `role` 它不读 |
| **D6 / D6b** | 主机 socket 断开先进宽限期（`DRC_HOST_GRACE_MS`，默认 120s，`config.ts:111`）；新错误码 `host_unavailable` | 一次网络抖动就逼用户回到电脑前扫码 | `state.ts:309-350`、`server.ts:268-279` 🟩（`relay.test.mjs:324`、`:426`）。`host_unavailable` 与 `unknown_session` **必须**区分：后者会让客户端丢配对，前者只是"稍后再试" | 正向 |
| **D7** | 新增 `resync{sessionIds}` + 主机可发 `session-leave` 作废会话 | 主机重启 → 手机对着没有钥匙的对端**永久静默**，`unknown_session` 永不发生 | 见〈主机不认得这条 convId〉一节 🟩（`relay.test.mjs:390`、`:688`、`relay-client.test.ts:377`、`e2e/restart-resume.test.mjs:206-262`） | 正向 |
| **D8** | 删 `session-list` 帧、`cmd.subscribe` 载荷 | 前者从未被发送/处理，后者是 no-op | 联合里就没有这两个名字（`frames.ts:138-148`、`payloads.ts:248-262`） | 无 |
| **D9** | 移除 `apiProxy` / `typert` 两个弱 carrier | 桌面态从未注册 `apiProxy`，旧实现那条路的参数信封整个是错的；`typert` 只有 `invoke()` | 只剩 `services` 与 `mock`（见〈数据面的入口收紧〉） | 无（这两条路在真机上从未成功执行过） |

**旧文档里被判定作废的论断，逐条点名**：

| 旧 SECURITY.md | 判定 |
|---|---|
| 信任表"中继持有…配对码 → 会话 id 的路由表"下面那行"不持有任何载荷密钥" | 现在**才**真的成立（D1）；旧实现不成立 |
| 握手图 `pair-begin{token, psk}` | **作废**。现在是 `pair-begin{pairingToken}`，PSK 只进二维码 |
| "控制面（`hello` / **`auth`** / …）" | **作废**。`auth` 帧名已退役（D5） |
| "双因子：二维码给密钥，6 位码给授权…只截获二维码并不能完成配对" | **作废**。默认 URI 内嵌 `t=`，手机读到即连（`pair.js:248-266`、`index.ts:271`） |
| "服务器内存里有密钥副本"类表述 / "前向安全：⚠️ 没有" | 前者按 D1 改写；后者**保留**，仍然没有 |
| "实现引用：改 `relay-client.ts` 与 `normalizePairingToken`" | **作废**。配对码生成在 `packages/protocol/src/pairing.ts:41-48`（`randomPairingToken`，拒绝采样：24 bit 抽到 `< 16000000` 再取模，无模偏差），主机侧调用点 `core/keys.ts:215` 一带；`relay-client.ts` 这个文件已不存在 |
| "单连接 `DRC_MAX_PAIR_ATTEMPTS` / 全局 `DRC_MAX_PAIR_ATTEMPTS_PER_SEC` / `DRC_MAX_AUTH_ATTEMPTS`" | 改名，见上面那张改名表 |
| "`e2e/run.mjs` 最后一步审计…断言里面不出现 `cmd.send_prompt`" | 仍然成立且更强：`e2e/run.mjs:545-602` 带**帧数下界**（`enc ≥ 10`、每帧解出 > 40 B、标准 base64 能字节级往返、明文样本反证空判定），步骤在 `run.mjs:943`。旧实现收集了日志行却没有断言用它，本次补上了（`hardening.test.mjs:278`）🟩 |
| "小程序里没有成熟 x25519，tweetnacl 的 randombytes 已被主动禁用（见 `mp/core/vendor/nacl-fast.js` 末尾的补丁注释）" | 保留，但措辞校准：补丁是"没 CSPRNG 就**不初始化** PRNG"（`nacl-fast.js:2363-2388`），且这条路径本来就不会被调用（`codec.js:90-93`） |
| "中继的关闭码语义被客户端的重连策略依赖"（`DESIGN.md:75` 的 T5 同款理由） | **作废**。小程序**读不到 close code**：`mp/core/socket.js:174-178`、`:224-228` 的 `onClose` 丢弃了回调参数，退避只看计数器（`:265-274`）。关闭码对**主机**与**运维**仍有意义（4000 顶号、4001/4008 爆破），对手机只是"断了，重连" |

### 回滚必须是"中继产物 + 插件产物**成对**"

这不是运维偏好，是线格式决定的。我核对过两侧的实现：

- **新 host → 旧中继：注册这一步就断。** 新主机发的是 `hello{role:'host'}`
  （`packages/plugin/src/transport/relay.ts:122`），而旧中继的 `hello` 分支硬性要求
  `f.role === 'client'`，否则回 `error{code:'bad_role'}`
  （`git show b026d63:apps/server/src/main.mjs:229`）→ 新主机永远成不了 host。
  就算能注册，下一步 `pair-begin` 也会因缺字段被拒：旧中继要求
  `typeof psk === 'string' && psk.length >= 16`，否则 `error{code:'bad_pair'}`
  （`git show b026d63:apps/server/src/main.mjs:279-280`）。新主机的 `pair-begin` 只有
  `pairingToken`（`transport/relay.ts:151`）。
- **旧 host → 新中继：同样断。** 旧主机发的是 `auth`
  （`git show b026d63:packages/plugin/src/relay-client.ts:113`），而新中继的端点帧联合里
  没有 `auth`（`packages/protocol/src/frames.ts:138-148`）→ 解析返回 null →
  `error{unknown_frame}`（`apps/server/src/server.ts:434-441`）→ 旧主机也成不了 host。
  （字段层面 `psk` 确实会被 zod 剥掉而不报错，但**帧名**这一层过不去。
  所以"旧 host + 新中继兼容"只在**字段**意义上成立，按帧名读是不成立的。
  `HANDOFF.md` §3 的 D1/D5 两条与本节点口径一致——两边都不兼容。）

结论：两个方向都断，而且断得比 D1 更早（在 D5 那一刀上）。所以
**中继的 `apps/server/dist/bundle/main.js` 与插件的 `packages/plugin/dist/bundle/index.js`
必须成对切换、成对回滚**（DESIGN.md 的拍板表也写了"切换与插件重装必须同一次完成"，
`:314`）。回滚动作就是换回上一版的两个产物目录 + `systemctl restart` + 重装 profile 里的插件，
少一边都会得到"手机扫了码但主机侧完全无痕"的现场。

## 三条清单（收尾）

**A. 已由测试守住** 🟩（按主题给代表判据，不穷举）

- 字节级线格式：`e2e/protocol.test.mjs`（golden vectors + 现跑对拍 + 反证），`packages/protocol/tests/{record,keys,pairing}.test.ts`
- PSK 不上网：`packages/plugin/tests/relay-client.test.ts:147`、`apps/server/tests/state.test.mjs:57`、`apps/server/tests/bundle.test.mjs:22`
- 多码并存按所用码取密钥：`e2e/multi-pair.test.mjs:48-124`
- 配对状态机与四个 reason：`apps/server/tests/{state,relay}.test.mjs`、`apps/server/tests/hardening.test.mjs:192`、`e2e/protocol.test.mjs:301`
- 加固与关闭码（1009/1013/1008/4001/4008/4000、`pair-status` 默认 404、SIGTERM→1001→exit 0、产物 version）：`hardening.test.mjs:123-260`、`relay.test.mjs:550`
- 日志零知识 + D2：`hardening.test.mjs:278-332`、`e2e/run.mjs:605-612`
- D3/D4/D6/D7 的路由与恢复：`apps/server/tests/relay.test.mjs:298/324/339/358/390/426/688/704`、`e2e/restart-resume.test.mjs`
- 主机侧入站收紧（形状校验、两击作废、generation 清零、剪枝）：`packages/plugin/tests/relay-client.test.ts:232/268/288/377/389/548/572`、`ids-and-keys.test.ts:50`
- 订阅守卫与"回调不许冒回内核"：`packages/plugin/tests/guard.test.ts:72/93/165`、`carrier-services.test.ts:173`
- 凭据不落盘：`packages/plugin/tests/status.test.ts:34/45/64`、`config.test.ts:68/122/145`
- 真链路零知识审计（带帧数下界）：`e2e/run.mjs:943`、`e2e/live-e2e.mjs:272-288`

**B. 代码里成立但没有测试** 🟨

- 慢消费者 1008 整条机制（含"判定点在发送方缓冲"这个局限）
- WS 层 ping/pong 存活判定与 `terminate()`（`server.ts:487-499`）
- `timingSafeEqual` 前那个**长度提前比较**（`server.ts:74-79`）会泄露 token 长度，
  而同一行上的注释写的是"别把长度与时序泄露出去"——注释比实现乐观
- 宽限期到期时向该会话所有客户端发 `peer-left` 的那个循环写重复了一层
  （`server.ts:502-509` 里嵌套了两个同名 `for`）：n 个客户端会收到 n² 条 `peer-left`。
  现有测试只有 1 个客户端（`relay.test.mjs:324`），所以这条测不出来。语义无害（手机端的
  `peer-left` 只会把配对清掉并停在提示上），但它是"广播被放大"的形状
- 主机重连时中继向客户端重放 `peer-joined{clientId:hostId}`（`server.ts:171-177`）：
  借用了一个冻结帧名来表达"主机回来了"，小程序只会显示"新的客户端加入了会话"
  （`mp/core/client.js:224-226`）——不丢配对，但语义不精确
- `pairFail()` 构造器的参数类型仍然接受 `'rate_limited'`（`packages/protocol/src/outbound.ts:59`），
  而线上 schema 不接受（`frames.ts:182`）。今天没有任何调用点会传它（`state.ts:148-166` 的
  `claim()` 产不出这个值，`server.ts:229` 写死 `invalid_or_expired`），**但这扇类型门没被机械挡住**——
  只有"调用点恰好正确"。补一条 `outbound` 层面的断言比再写一遍文档可靠
- 中继的 `enc.ciphertext` schema 上限是 512 KiB（`frames.ts:96`），而 `ws` 的 `maxPayload`
  是 256 KiB（`config.ts:103`）：超限实际由 socket 层以 1009 切断，schema 那层到不了
- `DRC_PAIR_STATUS=1` 之后 `/api/pair-status` 就是免认证 oracle（`server.ts:547-557`），
  只有默认关这条有测试，"开着时的行为"没有告警

**C. 只是设计意图 / 未取证** 🟦

- 严格前向安全（需要 X25519，小程序侧条件不具备）
- 审批卡与提问卡的**真机**端到端闭环：`approvalFace="registered"`，但这些会话的策略从不发起
  审批；提问这一代宿主没暴露提供者（`questionsFace="no userQuestions provider"`）。
  两条卡片的闭环只在本地全链路里验过（`docs/DESIGN.md:447-454`）
- 多手机 / 多主机拓扑：`core/runtime.ts:448-460` 明写现网恒为 1 host : 1 client，
  `pickConversation` 的"取第一条有对端的通道"在多机场景下会把交互投错地方
- Windows 防休眠的真实实现（只到命令构造器字符串层面）
- "TLS 由部署方终止"这一步本身没有端到端测试，`deploy/nginx/drc.conf` 是配置事实而不是判据

## 已知弱点 / 未加固项（诚实清单）

按"给运维的注意力"排序，不是按严重度粉饰过：

1. **二维码=单因子**（D1 的直接后果）。默认 URI 内嵌 `t=`，扫到即配对即得 PSK。
   防护只有 TTL、一次性、以及"这张码只在你的屏幕上出现过"。别把二维码截图发群里、
   别让它进聊天窗口回滚历史。
2. **无重放防护**（同会话内）。载荷层不记 nonce、runtime 不按 `cmdId` 去重、F13 禁止中继校验
   seq 单调 ⇒ 被攻陷的中继或明文 `ws://` 上的中间人可以重投已观察到的上行帧。
   只有 TLS + 配对轮换是防线。
3. **`clientId` 是自报的非秘密身份，但成员表按它记账**。冒用同一 clientId 能顶掉真手机的
   socket 并接管它的成员席位，进而灌入解不开的密文、触发主机两击作废该会话——
   **一次不需要任何密钥的会话级 DoS**。恢复路径是重新扫码。协议同时冻结了"clientId
   不得当凭据"（F13），所以现实的补法只有：对"同一 clientId 短时间反复顶号"做限流/告警，
   或把主机侧的"两击作废"改成"N 次 + 时间窗"。
4. **`DRC_HOST_TOKEN` 是主机唯一的凭据，且不绑定 hostId**。拿到它的人可以声称任意 hostId、
   顶掉真主机、收走那条主机所有会话的下行密文（解不开）、作废它们的会话。
   hostId 到 token 的映射如果要做，需要新帧与新表——现在没有。
5. **慢消费者断开阈值（1008）的取值来自参考实现而不是实测**：1 MiB / 持续 10 秒
   （`server.ts:129-145`、`config.ts:113`）搬自 dshr 规范，
   `docs/legacy-spec/open-source-options.md:597` 与 `docs/DESIGN-REVIEW.md:400` 都记着
   "这是参考值，不是我们的实测值"。它与手机侧 12 s 连接超时 / 30 s 退避上限
   （`mp/core/socket.js:19-22`）可能形成循环：慢手机被反复踢，而它读不到 close code、
   只会显示"连接已断开，正在重连…"。整条机制无测试，且判定点在发送方的缓冲上。
   自己部署时如果见过"聊着聊着周期性掉线"，先去看这个阈值，再怀疑网络。
6. **host 侧密钥簿的上界是这一轮才补的**（复核 🟡8 的原始缺陷就是"没有上界"）。
   现状：`pruneStale` 空闲 24h / 最多 64 条（`core/keys.ts:43-54,122`）、剪时同时发
   `session-leave`（`transport/relay.ts:161-167`）、配置项不许写"永不剪枝"
   （`shell/config.ts:181-184`）、有测试（`relay-client.test.ts:548,572`）。
   剩下的两点要如实说：剪枝**寄生在 `status.json` 的 3 秒刷新节拍上**
   （`index.ts:254-258`），把 `statusFile` 设空就一并关掉了；以及 HEAD 版本（提交
   `296e919`）**还没有**这套剪枝——`git show 296e919:packages/plugin/src/core/keys.ts` 里
   `ConversationBook` 只有 `closeBefore`，没有 TTL 也没有条数上界。回滚到那个产物就等于
   把无界的 PSK 簿放回去。
7. **手机里的"解除配对"是本地动作**：不通知中继也不通知主机（`mp/core/client.js:143-148`，
   小程序从不发 `session-leave`）。中继的成员关系最长活到空闲 TTL（默认 7 天）。
   真正干净的解配要在主机侧 `/drc unpair`（`index.ts:720`）。
8. **中继进程以 root 运行**（`deploy/systemd/dsh-remote-control.service:25`）。
   同文件有 `NoNewPrivileges` / `ProtectSystem=strict` / `ProtectHome` /
   `RestrictAddressFamilies` / `MemoryMax=512M`（`:37-47`），但没有 dedicated user、
   没有 `RestrictNamespaces`/seccomp。它的运行时依赖只有 `ws`
   （`apps/server/package.json` 的 `dependencies`），攻击面确实小，但"小"不等于"没提权面"。
9. **配对码与 convId 的强度是有形的**：码 10⁶、convId 48 bit、TTL 默认 120 秒。
   本文给的 0.24% / 0.12% 是**全局配额下**的窗口概率，前提是你把 nginx 的 per-IP 限制
   配上了；没配的话上限只由 `DRC_PAIR_GLOBAL_PER_SEC` 决定。
10. **`/api/pair-status` 一旦打开就是免认证判定 oracle**（默认关，`config.ts:115`）。
    保持它关着。
11. **status.json / pairing-qr.png 是本地敏感文件**，0600 + 原子改名是代码里的硬要求
    （`shell/status.ts:33-47`），但 `pairOnStartSec > 0` 或刚跑过 `/drc pair` 时里面可能躺着
    一张仍然有效的 PSK（`index.ts:313`）。用完请关掉 `pairOnStartSec`（默认就是 0）。
    `/drc pair` 那张 PNG 落在 `<会话工作区>/.dsh/pairing-qr.png`（解析不出工作区时落
    `~/.dsh/pairing-qr.png`），右栏那份落在 `<会话工作区>/.dsh/sidebar-qr.png`（同理有 home 兜底），
    同样按敏感文件对待（用完即一次性失效）。
12. **元数据没有保护**：中继（以及路上任何能看到 TLS 之外信息的人）知道谁在什么时候连了多久、
    帧的条数与字节数、host label、clientId、convId、6 位配对码。要更强的话需要
    padding 与覆盖控制面字段端到端的封装——都不在冻结面之外做不了，因为小程序一行不改。
13. **文档与实现的漂移**：`docs/SELF-HOSTING.md:17-19` 的环境变量表还是旧名字
    （`DRC_MAX_AUTH_ATTEMPTS` / `DRC_MAX_PAIR_ATTEMPTS` / `DRC_MAX_PAIR_ATTEMPTS_PER_SEC`）。
    以本文那张改名表与 `apps/server/src/config.ts:102-115` 为准；照旧名写进
    `/etc/dsh-remote-control.env` 会**静默落回默认值**（解析器不认未知变量，也不报"没读过这个变量"）。

## 报告安全问题

请直接开 issue 或联系维护者，不要公开披露。
