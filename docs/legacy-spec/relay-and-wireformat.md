# 遗留实现事实提取：中继与线格式（relay & wire format）

> 本文是**旧实现的事实档案**，不是新方案。旧代码（`packages/protocol`、`apps/server`）将被逐行重写，
> 但小程序目录 `mp/` 原样保留并必须继续能连上新中继——因此凡是 `mp/` 侧已固定的字节与帧名，
> 都是**不可协商的需求**。每条结论后挂证据锚点 `（证据：文件:行号）`；
> 无代码直接支撑的判断写作「推断：」。
>
> 阅读前提：`mp/core/codec.js` 与 `packages/protocol/src/crypto.ts` 是同一套线格式的两个实现，
> 由 `e2e/mp-crypto.test.mjs` 逐字节对拍锁定；对拍红即小程序与 host 再也说不上话
> （证据：e2e/mp-crypto.test.mjs:1-9；HANDOFF.md:157）。

---

## 1. 控制面帧清单（中继经手的明文帧）

中继的 JSON 解析与路由是唯一读取帧内容的地方；数据面帧的 `ciphertext` 对它是**不透明字符串**
（证据：apps/server/src/main.mjs:212-219、344-357；docs/SECURITY.md:10-14）。

方向记法：`H2R`=host→relay，`R2H`=relay→host，`C2R`=client→relay，`R2C`=relay→client。
`session` 指服务端为该 socket 建立的身份记录（`{role, hostId?|clientId?}`，证据：apps/server/src/main.mjs:188）。

| `t` | 方向 | 字段 | 语义 | 中继需理解载荷？ | 证据 |
|---|---|---|---|---|---|
| `hello` | C2R | `role`（必须 `'client'`）、`clientId?`、`clientMeta?` | 客户端注册身份。`role` 非 client 直接回 `error/bad_role`；缺 `clientId` 时服务端生成 `randomUUID()`；`clientMeta` 存入 `clients` 表 | 是（仅控制面字段） | main.mjs:228-233；clients 表 79-81 |
| `hello-ok` | R2C | `clientId` | 回给客户端权威 clientId（小程序会采纳并覆盖本地安装 id，见 §3.9） | 是 | main.mjs:233；mp/core/client.js:254 |
| `auth` | H2R | `role:'host'`、`token`、`hostId?`、`label?` | host 侧唯一认证入口；`token` 与 `DRC_HOST_TOKEN` 定时安全比较；`hostId` 缺省取 `randomUUID().slice(0,8)`；同 `hostId` 重连顶掉旧 socket（close 4000 `replaced`）并把已有会话重新挂到新 socket | 是 | main.mjs:236-274 |
| `auth-ok` | R2H | `hostId` | 认证成功。host 以此递增 `connectionGeneration`（中继重启会清空配对表，旧发布码作废） | 是 | main.mjs:271；plugin/src/relay-client.ts:156-162 |
| `auth-fail` | R2H | `reason:'bad_token'` | 唯一取值；失败计数达上限关 socket（4001） | 是 | main.mjs:244-252；apps/server/tests/hardening.test.mjs:91-109 |
| `pair-begin` | H2R | `pairingToken`（6 位数字）、`psk`（base64 字符串，`length>=16`）、`hostLabel?` | host 发布一次性配对码并登记 PSK。校验失败回 `error/bad_pair`；待配对表满回 `error/pair_table_full`。**`hostLabel` 由 host 发出但中继从未读取** | 是 | main.mjs:276-296；protocol/src/index.ts:29；relay-client.ts:279 |
| `pair-ready` | R2H | `pairingToken`、`ttlMs` | 服务端权威 TTL。**host 必须据此改写本地过期时间**（§2.3 硬约束 1） | 是 | main.mjs:293；relay-client.ts:167-178；HANDOFF.md:114-116 |
| `pair-begin-client` | C2R | `pairingToken` | 客户端认领配对码。要求 `session.role==='client'`，否则 `error/need_client`；**不发送 PSK** | 是 | main.mjs:298-299；mp/core/client.js:257 |
| `paired` | R2C | `hostId`、`sessionId` | 配对成功，`sessionId='c_'+12 位 hex`。双方自此以它作 convId 派生密钥 | 是 | main.mjs:326-328；mp/core/client.js:267-283；hardening 无关；relay.test.mjs:63 |
| `pair-fail` | R2C | `reason` | 取值：`rate_limited`（全局配额）、`already_used`、`invalid_or_expired`、`host_offline`；单连接错达上限关 socket（4008） | 是 | main.mjs:300-325；mp/core/client.js:356-364；hardening.test.mjs:111-129 |
| `peer-joined` | R2H（配对成功时）/ R2C（host 重连时） | `sessionId`、`clientId`、`pairingToken`（仅配对成功路径带） | 两条不同的发送路径，字段集不同：给 host 的**必须**带 `pairingToken`；给 client 的是纯通知（`clientId` 填的是 hostId，不带 token） | 是 | main.mjs:332-339（→host）与 264-270（→client）；mp/core/client.js:224-226 |
| `peer-left` | R2H / R2C | `sessionId`、`clientId` | 成员离场。host 掉线时向该会话所有 client 广播（`clientId` 填 hostId），并删除会话 | 是 | main.mjs:364、383、397 |
| `session-leave` | C2R | `sessionId` | 客户端主动离开：从会话移除、通知 host `peer-left`，会话空则删除。**未命中 sessionId 时静默无回复**；小程序实际从未发送此帧 | 是 | main.mjs:360-368；全仓 `mp/` 无 `session-leave` 发送点（仅 protocol/src/index.ts:32 与 server 有定义） |
| `enc` | H2R / C2R → 对侧 | `sessionId`、`seq`、`ciphertext`、`clientId?` | 数据面。`sessionId` 不在路由表 → `error/unknown_session`；`ciphertext` 非字符串 → `error/bad_frame`。**host→client 方向 `seq` 由服务端覆写为 `++conv.seqHost`；client→host 方向 `seq` 原样透传** | 只理解外层字段，不碰密文 | main.mjs:344-358；relay.test.mjs:71-79 |
| `enc-batch` | （定义存在，无人发送） | `sessionId`、`items:[{seq,ciphertext}]` | 批量帧。中继的 `switch` **没有这一分支**，收到即落 `default` 回 `error/unknown_frame`；但**小程序已能解**（逐项用外层 `sessionId` + `items[i].ciphertext` 送入 `open`）。host 侧 `relay-client` 也没有 `enc-batch` 分支 | 若实现则只理解外层 | protocol/src/index.ts:43-47；main.mjs:373-374；mp/core/client.js:240-247；HANDOFF.md:129 |
| `ping` | 任意→R | `ts?` | 应用层心跳，回 `pong` 原样携带 `ts`。**小程序与 host 都不发**：保活靠 WS 层 ping（§5.4） | 是 | main.mjs:370-371、419-442；全仓仅 `hardening.test.mjs:136` 发送 `ping` |
| `pong` | R→任意 | `ts?` | `ping` 的回执。host 与 client 都只是忽略它 | 是 | main.mjs:371；relay-client.ts:239；mp/core/client.js:235 |
| `error` | R→任意 | `code`、`message` | 实际出现过的 code：`bad_role`、`need_host`、`need_client`、`bad_pair`、`pair_table_full`、`unknown_session`、`bad_frame`、`rate_limited`、`bad_json`、`internal`、`unknown_frame`。客户端只对 `unknown_session` 做状态处置，其余原样冒泡成错误提示 | 是 | main.mjs:201、216、222、229、277、280、285、299、346、348、374；mp/core/client.js:227-234 |
| `session-list` | （仅声明） | `sessions: SessionSummary[]` | 帧类型与 `CONTROL_FRAME_TYPES` 里有它，但中继从未发送、从未处理，双方也都不消费 | — | protocol/src/index.ts:37、219 |

补充事实（写实现时容易当成既有行为）：

- **帧必须是文本**。服务端把 raw 直接 `String(raw)` 后 `JSON.parse`，二进制帧会变成乱码并回 `bad_json`（证据：apps/server/src/main.mjs:212-217；小程序侧只发字符串，证据：mp/core/socket.js:104-112）。
- **`enc` 不校验发送方是否是该会话成员**，只校验 `sessionId` 命中路由表；因此 sessionId 本身就是能力凭证（48 bit 随机）。匿名 socket 也能往已知会话灌密文（会被对端解密失败丢弃）（证据：apps/server/src/main.mjs:344-357）。
- **`conversations` 的 `clients` 是 Set，但没有任何代码路径能让一个会话出现第二个客户端**：每次认领都新建会话（证据：apps/server/src/main.mjs:320-327）。推断：多路广播的字段与结构留着，现实拓扑恒为 1 host : 1 client per `sessionId`。
- 源码头注释声称有「host status / pairing bootstrap」REST，实际只有 `/healthz`、`/api/info`、`/api/pair-status` 三条路由（证据：apps/server/src/main.mjs:11-12 与 126-159 的差异）。推断：以代码为准，注释是未落地意图。
- 代码注释里的交叉引用已过期：`main.mjs:329-331` 写「see HANDOFF 5.15」，实际内容在 `HANDOFF.md` §4.5（证据：main.mjs:329-331；HANDOFF.md:112-121）。

---

## 2. 配对状态机

### 2.1 完整时序（以代码为准，字段名逐字保留）

```
host                relay                                  client
 │ 本地: psk=16B 随机, token=6 位（Math.random）           
 │── auth{role,token,hostId?,label?} ─▶ hosts[hostId]      
 │◀─ auth-ok{hostId} ─                 generation++        
 │ 本地: pendingPairs.set(token,{psk,expiresAt})            
 │── pair-begin{pairingToken,psk} ──▶ pendingPairs[token]={hostId,psk,expiresAt:now+PAIR_TTL_MS,used:false}
 │◀─ pair-ready{pairingToken,ttlMs}   本地过期时间改用服务端 ttlMs
 │ 渲染二维码 dshr:/p?v=1&s=…&n=…&psk=…[&t=…]（PSK 不上网）
 │                                        ◀── hello{role:client,clientId,clientMeta}
 │                                        ───▶ hello-ok{clientId}
 │                          ◀── pair-begin-client{pairingToken}
 │                     全局配额 takePairBudget → pendingPairs 命中且未 used 未过期
 │                          ───▶ paired{hostId,sessionId}   双方以 sessionId 派生 kC2H/kH2C
 │◀─ peer-joined{sessionId,clientId,pairingToken} ─      
 │ 按 pairingToken 取对应 PSK，建 conversation，回执 ev.session_changed + ev.keep_awake_state
```

证据：main.mjs:236-342（服务端全部状态迁移）、relay-client.ts:155-281（host 侧 `auth-ok`/`pair-ready`/`peer-joined` 与 `createPairing`）、mp/core/client.js:117-124 与 253-288（客户端 `hello`→`pair-begin-client`→`paired`→派生密钥）、protocol/src/crypto.ts:97-99 与 151-158（PSK 生成与密钥派生）。服务端架构图同款表述见 docs/SECURITY.md:29-47。

服务端状态变化逐点：

1. `auth`：`hosts[hostId]={ws,label}`；同 hostId 旧 socket 被关闭 4000；随后遍历 `conversations` 把该 host 的会话重新 `peer-joined` 推给 client（证据：main.mjs:255-270）。
2. `pair-begin`：写 `pendingPairs[token]`，`expiresAt=Date.now()+PAIR_TTL_MS`，`used=false`；回 `pair-ready`（证据：main.mjs:287-294）。
3. `pair-begin-client`：先扣全局配额 → 查表（要求存在、`!used`、`expiresAt>=now`）→ 标 `used=true`（**保留至 TTL 清扫，好让重放报 `already_used` 而非 `invalid_or_expired`**）→ 检查 host socket `readyState===1` → 生成 `sessionId='c_'+randomBytes(6).hex` → 建 `conversations[sessionId]={hostId,clients:new Set([clientId]),seqHost:0}` → 回 `paired` → 发 `peer-joined` 给 host（证据：main.mjs:300-341）。
4. 清扫循环每 5s 删除 `expiresAt<now` 或 `used` 的条目（证据：main.mjs:42、441）。
5. 内存态、无持久化：中继重启即丢 `pendingPairs` 与 `conversations`（证据：docs/SELF-HOSTING.md:219-220；HANDOFF.md:180-181——明确决定不做持久化，理由是 PSK 落盘扩大泄露面）。

### 2.2 host / client 两侧的密钥落地

- host 在 `peer-joined` 里按 `pairingToken` 从自己的 `pendingPairs` 取 PSK，建 `conversations[sessionId]={kC2H,kH2C,seq:0}`，然后 `onPeerJoined` 推会话列表与防休眠状态（证据：relay-client.ts:179-224；host-runtime.ts:67-73）。
- client 在 `paired` 里用二维码带出的 PSK + `sessionId` 派生两把钥匙并持久化 `{server,psk,convId,hostId,hostLabel,nonceCounter,pairedAt}`（证据：mp/core/client.js:267-288；mp/core/session-store.js:66-76）。
- PSK 从未过网：只经二维码（证据：docs/SECURITY.md:51；mp 侧 `pair-begin-client` 只发 `pairingToken`，mp/core/client.js:257）。

### 2.3 HANDOFF §4.5 两个真 bug → 新实现的硬性约束

这两条是线上事故换来的，写成 MUST；违反的表现都是「配对显示成功但手机永远解不开任何一帧、会话列表空白」，极难定位（证据：HANDOFF.md:112-121；relay-client.ts:167-178、184-214 的注释）。

1. **TTL 以服务端为准**。`pair-ready` MUST 携带权威正整数 `ttlMs`，host MUST 用它改写本地 `pendingPairs[token].expiresAt`。
   反例成因：host 用「自己请求的 TTL」提前清扫 PSK → `peer-joined` 找不到 PSK → 静默丢 peer → 客户端「加密解码失败」（证据：HANDOFF.md:114-116；main.mjs:293；relay-client.ts:167-178；host-runtime.ts:136-139 暴露 `pairingTtlMs`；plugin/src/index.ts:381-394 `status.json` 的过期时间同样以服务端 ttlMs 计算）。
2. **多配对码并存**。两侧都 MUST 是 `Map<token, {psk, expiresAt}>` 而不是单槽：
   - 服务端：`pendingPairs` 以 token 为键（证据：main.mjs:82-83、287-292）；
   - host：`pendingPairs: Map<string,{psk,expiresAt}>`，并自带上限 32、超限淘汰最旧（证据：relay-client.ts:33、47-56、264-270）；
   - `peer-joined`（→host 那条）**MUST 回传 `pairingToken`**，host MUST 用它取 PSK；找不到时才降级为「最新存活条目 + 明确告警」（证据：main.mjs:332-339；relay-client.ts:186-205）。
   回归测试：`e2e/multi-pair.test.mjs`（用**较早**那个码配对，断言每一帧都能被该码的 PSK 解开，证据：e2e/multi-pair.test.mjs:61-137）。
3. **一次性 + 状态新鲜度**（同一节给出的第三条，同样是约束）：码单次使用，重放得到 `pair-fail:already_used`（证据：main.mjs:323、306-312；relay.test.mjs:81-86）；`status.json` 按定时器（3s）刷新而非按消费刷新，因此外部测试脚本必须只接受「年龄 < 25s 且本轮未用过」的码（证据：plugin/src/index.ts:417-420；HANDOFF.md:120-121；e2e/live-e2e.mjs:84-89）。

### 2.4 会话失效与恢复的既有语义（客户端已固化）

- 中继重启或 host 掉线后，客户端拿旧 `convId` 发 `enc` → 服务端 MUST 回 `error/unknown_session`，客户端见到它才清配对并提示「请重新配对」；换成别的 code 会让 UI 卡在空列表（证据：main.mjs:345-346、389-403；mp/core/client.js:227-231；hardening.test.mjs:161-172 明确断言「宁可报错也不静默消失」）。
- 客户端重连后若本地仍有配对，**不会重新走配对**，而是直接 `cmd.list_sessions` 试探原会话（证据：mp/core/client.js:258-261）。
- 任何 `peer-left` 到客户端都被解读为「主机没了，必须重扫」，客户端会直接丢弃配对（证据：mp/core/client.js:219-223）。

---

## 3. 加密与线格式的不可变契约

**总纲：本节所有字节级细节，新实现必须逐字节一致。** 依据不是风格偏好，而是 `mp/` 已发布、
不可再改：小程序侧的 `mp/core/codec.js` 是这套格式的第二份实现，两侧由对拍测试锁死
（证据：e2e/mp-crypto.test.mjs:1-9；mp/core/codec.js:1-16；HANDOFF.md:157「改线格式两边必须一起改」，而现在不能改）。

### 3.1 sealed record

- 记录 = `base64( nonce(24) ‖ nacl.secretbox( utf8(JSON), nonce, key ) )`，即 XSalsa20-Poly1305（证据：crypto.ts:5-8、67-76；mp/core/codec.js:4-5、90-100；docs/SECURITY.md:16）。
- 外层 JSON 字段名固定为 **`ciphertext`**（对象里仅此一个字段，类型 `SealedRecord`）（证据：crypto.ts:62-65；mp/core/codec.js:88-99；服务端校验也用它，证据：main.mjs:347）。
- `open` 必须拒绝长度 `< 24+16` 的记录并**返回 null 而非抛错**（证据：crypto.ts:78-90；mp/core/codec.js:103-115）。
- base64 是**标准表**（与 `Buffer.toString('base64')` 逐字节一致，含 `=` 填充、非 url-safe）（证据：e2e/mp-crypto.test.mjs:34-42；mp/core/codec.js:48-56）。解码侧容忍空白字符（证据：mp/core/codec.js:53-56）——推断：新实现不得反过来要求发送方去掉空白。

### 3.2 KDF

- `kdfHash(parts)`：按顺序拼接每个 part（字符串先 UTF-8 编码），**每个 part 之后都追加一个 `0x1f` 单元分隔符（包括最后一个）**，对整体取 SHA-512，**截前 32 字节**（证据：crypto.ts:41-50；mp/core/codec.js:59-76；crypto.ts:8-9 说明用 `nacl.hash` 即 SHA-512 以保证跨平台）。
- 会话密钥：`SHA512('dsh-rc/v1'␟ 'c2h'|'h2c' ␟ conversationId ␟ pskBytes ␟ )[0..32]`，parts 顺序即 `['dsh-rc/v1', direction, conversationId, decodeBase64(psk)]`（证据：crypto.ts:151-158；mp/core/codec.js:22-23、79-81）。
- nonce 前缀（仅小程序侧使用）：`kdfHash(['dsh-rc/v1/nonce', installId, conversationId, pskBytes])[0..16] ‖ counter(8B 大端)` = 24 字节（证据：mp/core/codec.js:23、123-142；docs/SECURITY.md:78-81）。Node 侧 `seal` 用随机 24B nonce，不参与该公式（证据：crypto.ts:67-69）。
- 命名空间字符串的**确切拼写**：`'dsh-rc/v1'`、`'dsh-rc/v1/nonce'`、`'dsh-rc/v1/x25519'`（第三者只用于未来的 X25519 通道，小程序不用）（证据：crypto.ts:53-60、151-158；mp/core/codec.js:22-23）。
- 方向字符串只有 `'c2h'` / `'h2c'`，两把密钥 MUST 不同（证据：crypto.ts:152-158；tests/crypto.test.ts:40-45；mp-crypto.test.mjs:59-64）。
- 计数器 nonce 是唯一性保障：key 已绑定 (PSK, 会话, 方向)，计数器持久化；存储被清空时 `installId` 重新生成，前缀随之改变，故 (key,nonce) 不重复（证据：mp/core/codec.js:117-125；mp/core/session-store.js:42-53、82-91；docs/SECURITY.md:78-81）。

### 3.3 PSK

- 长度 **16 字节**，`base64` 输出（24 字符），由 Node 侧 CSPRNG 生成（证据：crypto.ts:92-99）。
- 服务端只校验 `typeof psk==='string' && psk.length>=16`——比「16 字节」宽松，是字符数（证据：main.mjs:279-281）。推断：这是可保留的宽松面；收紧成校验解码后恰 16 字节会拒绝当前实现产生的合法值之外的历史发布码，但不影响小程序（小程序从不发送 PSK）。
- 每次配对轮换、单次有效（证据：docs/SECURITY.md:51-53；relay-client.ts:261-270）。

### 3.4 配对二维码 URI

文法：`dshr:/p?v=1&s=<ws(s) url>&n=<hostLabel>&psk=<base64 16B>[&t=<6 位码>]`，参数按 `v,s,n,psk,t` 顺序由 `URLSearchParams` 生成（证据：crypto.ts:141-149）。

- `t` 为**可选**：默认不带，`--with-token`/`/drc pair` 默认内嵌（两个默认值不一致，以 host 命令侧为准）（证据：crypto.ts:107-117；relay-client.ts:261-281；plugin/src/index.ts:545-557；docs/MINI-PROGRAM.md:111-115）。
- 解析规则：必须以 `dshr:` 开头且含 `?`；`psk` 与 `s` 缺一即 `null`；`n` 缺省为 `'dsh'`；`t` 只有在 `/^\d{6}$/` 时才采纳，否则置空字符串——**返回对象的 `token` 恒存在（无码时为 `''`）**，以保证两侧深度相等对拍（证据：crypto.ts:120-139；mp/core/codec.js:151-174；mp-crypto.test.mjs:112-137；crypto.ts:108-117 注释）。
- `'+'` 号兼容解码规则（小程序侧专有，新 host 生成时必须与它兼容）：先按 `URLSearchParams` 语义（`+`→空格）解一次；**若解出的 `psk` 含空格，则改用「不做 `+`→空格替换」重解，仅当重解后的 `psk` 不含空格才采纳**，用于兼容手写/第三方二维码里未编码的 base64 `+`（证据：mp/core/codec.js:145-150、151-174、176-197）。Node 解析器只有 `URLSearchParams` 一条路（证据：crypto.ts:120-139）——事实：两侧不对称，因此**生成侧必须永远用 `URLSearchParams` 编码**（`+`→`%2B`、空格→`+`、`=`→`%3D`，实测见 `buildPairingQr` 输出），不能自己拼字符串。
- `dshr:/p` 的 `//` 被刻意省略：URI 不是 http URL，任何按 WHATWG URL 解析的实现都会丢参数。推断：新实现按「`?` 之后是 query」处理即可，与两侧现有代码一致（证据：crypto.ts:122-124；mp/core/codec.js:154-157）。

### 3.5 记录在帧里的位置

`enc` 帧的 `ciphertext` 就是 §3.1 的整串 base64；`seq` **双方都不参与解密、也不做重放校验**（host 用 `sessionId`+`ciphertext` 组记录，客户端直接把整个帧交给 `open`）（证据：relay-client.ts:228-238；mp/core/client.js:291-293；mp/core/codec.js:103-115）。

### 3.6 载荷层不保证的属性（重写时别误加依赖）

- 无前向安全：PSK 派生的会话密钥在一次配对内复用（证据：docs/SECURITY.md:57-59、126-133）。
- 服务端不记录已见 nonce，因此重放只在「换会话」维度无效（证据：docs/SECURITY.md:132）。
- 载荷无签名/无 MAC 之外的抗序：`seq` 由服务端覆写（h2c），客户端 MUST NOT 依赖其全局单调性（证据：main.mjs:350-357；§3.5）。

### 3.7 小程序专有、重写 host 时必须容忍的点

- `seal` 在小程序侧**强制要求显式 24B nonce**（无 CSPRNG），否则抛错（证据：mp/core/codec.js:13-16、90-93；docs/SECURITY.md:66-70）。
- 小程序的 vendored tweetnacl **移除了 `require('crypto')` 的 PRNG 探测且不提供 `Math.random()` 兜底**（证据：docs/SECURITY.md:66-70；docs/MINI-PROGRAM.md:56-65；HANDOFF.md:137-138）——推断：host/中继升级任何 crypto 依赖时，都不得假设对端有 `randomBytes`。

### 3.8 字符串常量清单（抄一份贴在新代码旁边）

`'dsh-rc/v1'`、`'dsh-rc/v1/nonce'`、`'dsh-rc/v1/x25519'`、`'c2h'`、`'h2c'`、`0x1f`、`'ciphertext'`、`'dshr:/p?'`、`'v','s','n','psk','t'`、`'dsh'`（hostLabel 缺省）、`'c_'`（sessionId 前缀）、`'wechat-mp'`（`clientMeta.platform`）、`'微信小程序'`（`clientMeta.label`）（证据：§3.1-3.4；main.mjs:326；mp/core/client.js:117-124；protocol/src/index.ts:49-52）。

### 3.9 clientId 的边界（易被误当作密码学输入）

`clientId` 是控制面用的弱随机 id，明确注释「不是秘密」；安装 id 由 `Date.now()` + `Math.random()` 组成（证据：mp/core/codec.js:204-212）。事实：服务端 `hello-ok` 回发的 clientId 会覆盖小程序的安装 id（证据：mp/core/client.js:254），但 nonce 前缀取的是存储里的 `installId()`，与被覆盖的 `clientId` 无关（证据：mp/core/session-store.js:89）。推断：新实现可以随意改写 clientId 分配策略（UUID/短 id/复用），不会动摇 nonce 或密钥——但 MUST NOT 反过来把服务端 clientId 掺进密钥派生。

---

## 4. 数据面 payload 目录（host ⇄ client，E2E 之后）

`Payload` 联合类型共 7 个 `cmd.*` + 9 个 `ev.*`（证据：protocol/src/index.ts:73-202）。
所有 payload 都被封进 §3.1 的记录，帧外层仍是 `{t:'enc',sessionId,seq,ciphertext}`（证据：relay-client.ts:284-290；mp/core/client.js:175-191）。

**两个 `sessionId` 不是一回事**：中继帧里的 `sessionId` 是配对通道 id（`c_xxx`），payload 里的 `sessionId` 才是 DSH 会话 id。混淆是本协议最贵的一类 bug（证据：HANDOFF.md:109-110）。

### 4.1 client → host（`cmd.*`）

| 类型 | 字段 | 必选/可选 | 语义与约束 | 证据 |
|---|---|---|---|---|
| `cmd.send_prompt` | `t` `cmdId` `sessionId` `text` `attachments?` | 前四项必选 | `sessionId` = DSH 会话 id；`attachments` 元素 `{name, mime?, dataBase64?}`，**协议有字段但小程序 UI 未做** | index.ts:92-98；HANDOFF.md:178；docs/MINI-PROGRAM.md:123 |
| `cmd.answer` | `t` `cmdId` `sessionId` `requestId` `answers` | 全必选 | `answers: Array<{questionId, selected: string[], freeText?}>`；`requestId` 来自 `ev.question_request` | index.ts:99-105；mp/core/client.js:339-347；e2e/run.mjs:167 |
| `cmd.resolve_permission` | `t` `cmdId` `sessionId` `requestId` `decision` `note?` | `note` 可选 | `decision ∈ 'approve' \| 'reject' \| 'approve_session'`——host 固定下发这三个 id 的选项卡 | index.ts:106-113；adapter-dsh.ts:361-365、468-472 |
| `cmd.interrupt` | `t` `cmdId` `sessionId` | 必选 | 中断当前 run；host 之后回 `ev.run_state{state:'idle',detail:'interrupted'}` | index.ts:114-118；adapter-mock.ts:94；e2e/run.mjs:192-196 |
| `cmd.list_sessions` | `t` `cmdId` | 必选 | 无 `sessionId`；回执 `ev.result{data:{sessions:[SessionSummary]}}` | index.ts:119；bridge.ts:45-48 |
| `cmd.keep_awake` | `t` `cmdId` `enabled` `idleReleaseSec?` | `idleReleaseSec` 可选 | **`idleReleaseSec` 单位是秒，host ×1000 后作 idle 自动释放阈值；`0` = 保持到被显式关闭** | index.ts:120-126；host-runtime.ts:261-271；keepawake.ts:18-24、108-122 |
| `cmd.subscribe` | `t` `cmdId` `sessionIds?` `includeContent?` | 均可选 | 事实上的 no-op：只回 `ev.result{ok:true}`，没有任何过滤效果（`sessionIds` 空=全部） | index.ts:127-133；bridge.ts:65-69 |

`cmdId` 由发送方生成：小程序用 `'c'+base36 时间戳_'序号'`，host 用 `randomUUID()`（证据：mp/core/client.js:193-196；relay-client.ts:306-308）。回执靠 `cmdId` 匹配，因此 MUST 原样回传（证据：bridge.ts:47-63；mp/pages/chat/chat.js:92-99）。

### 4.2 host → client（`ev.*`）

| 类型 | 字段 | 必选/可选 | 语义与小程序消费点 | 证据 |
|---|---|---|---|---|
| `ev.session_changed` | `t` `sessions` `reason?` | `sessions` 必选 | 全量快照（不是增量）；`reason` 在 `session/created`/`disposed` 时填事件名，其余为空 | index.ts:135-139；host-runtime.ts:291-309；adapter-dsh.ts:445-447；mp/core/client.js:308-310 |
| `ev.message_delta` | `t` `sessionId` `messageId` `part` `delta` `role?` `done?` | `role`/`done` 可选 | `part` 是「单调递增的分片序号，供 append-only 增量」；`role ∈ 'assistant'\|'user'\|'system'`；`done===true` 是回合结束**唯一**信号 | index.ts:140-150；mp/pages/chat/chat.js:101-114、185-206；host-runtime.ts:212-229 |
| `ev.tool_event` | `t` `sessionId` `callId` `tool` `phase` `title?` `argsPreview?` `resultPreview?` | 后三者可选 | `phase ∈ 'started'\|'args'\|'completed'\|'failed'`；UI 用 `phase` 选图标、`callId` 去重原位更新 | index.ts:151-160；mp/pages/chat/chat.js:15-20、149-160 |
| `ev.permission_request` | `t` `sessionId` `requestId` `action` `resource?` `reason?` `options?` `expiresAt?` | `action`/`requestId` 必选 | `options: [{id,label}]`，host 固定给 `approve/approve_session/reject`；**客户端在 options 缺失时兜底为 `approve`/`reject` 两键** | index.ts:161-170；adapter-dsh.ts:361-366、468-473；mp/pages/chat/chat.js:165-183 |
| `ev.question_request` | `t` `sessionId` `requestId` `questions[]` | `questions` 必选 | 每题 `{id, question, multi?, options?[{id,label}]}`；`multi` 来自内核 `multi_select===true` | index.ts:171-181；adapter-dsh.ts:373-385、476-481；mp/pages/chat/chat.js:185-198 |
| `ev.run_state` | `t` `sessionId` `state` `detail?` | `detail` 可选 | 状态串见 §4.3；`detail:'interrupted'`、`'request-cancelled'`、`'permission <decision>'` 是实际出现过的值；客户端仅在 `state` 为 `running`/`idle` 时收起挂着的审批/提问卡 | index.ts:182-187；adapter-dsh.ts:388-400、928、966；adapter-mock.ts:79；mp/pages/chat/chat.js:200-206 |
| `ev.keep_awake_state` | `t` `enabled` `active` `platform` `backend` `reason?` | 前四项必选 | 无 `sessionId`（因此广播到所有客户端）；`platform` 即 `node:os.platform()`；`backend` 取 `'caffeinate'`/`'systemd-inhibit'`/`'SetThreadExecutionState (powershell)'`/`'unsupported'`；`reason` 为最后一次失败原因 | index.ts:188-195；keepawake.ts:26-32、60-71；host-runtime.ts:132-134；mp/pages/sessions/sessions.js:120-125 |
| `ev.result` | `t` `cmdId` `ok` `message?` `data?` | `message`/`data` 可选 | 每条 `cmd` 的回执。已知 `data` 形状：`list_sessions`→`{sessions}`，mock 的 answer→`{answered, answers}` | index.ts:196-202；bridge.ts:45-69；adapter-mock.ts:69；e2e/mp-client.test.mjs:123、172 |
| （异常路径）`ev.result` | `cmdId:''` `ok:false` `message:<错误串>` | — | host 对 payload 处理抛错时兜底回执，`cmdId` 取不到时填空字符串——客户端不能假设 `cmdId` 一定有值 | index.ts:196-202；host-runtime.ts:280-288 |

### 4.3 `SessionSummary`

| 字段 | 类型 | 可选 | 语义 | 证据 |
|---|---|---|---|---|
| `id` | string | 必选 | DSH 会话 id | index.ts:54；adapter-dsh.ts:557 |
| `title` | string | 可选 | 标题，缺省时 UI 回落显示 `id` | index.ts:55；mp/pages/sessions/sessions.js:134 |
| `workspace` | string | 可选 | 取自内核 header 的 `cwd` | index.ts:56；adapter-dsh.ts:561 |
| `updatedAt` | string(ISO) | 可选 | 有则填 | index.ts:56-57；adapter-dsh.ts:562 |
| `createdAt` | string(ISO) | 可选 | 内核 header 报告的创建时间（毫秒数转 ISO） | index.ts:58-59；adapter-dsh.ts:561 |
| `origin` | string | 可选 | `'subagent'` 表示委派子会话；**services carrier 会把这些行整体过滤掉**，只在状态里计数 | index.ts:60-62；adapter-dsh.ts:543-548、570 |
| `running` | boolean | 可选 | `agents.get(id).status==='running'` | index.ts:63；adapter-dsh.ts:575-582 |
| `state` | `'idle'\|'running'\|'detached'\|'archived'\|'awaiting-permission'\|'awaiting-answer'`（类型上允许任意 string） | 可选 | 优先级：`archived` > `running` > `detached`（已持久化但未加载，仍可打开）> `idle`；`awaiting-*` 由请求取消路径产生 | index.ts:64-66；adapter-dsh.ts:564-570、388-400；mp/pages/sessions/sessions.js:9-16 |

事实：列表上限为 100 条（`MAX_LIST_SESSIONS`，超出直接截断）（证据：adapter-dsh.ts:157、552）。推断：这个 100 是加密帧大小上限（§5.3 的 256 KiB）的直接上游——一屏会话摘要装进一个 `ev.session_changed`，条数与标题长度共同决定帧大小；重写时改大它要连带复核帧上限。

### 4.4 host 侧的流式合并（字段语义的一部分，重写 host 必须保持）

- delta 合并窗口 120ms / 单条上限 4096 字符 / 最多同时缓存 32 个会话，超限先 flush 最旧（证据：host-runtime.ts:18-20、102-105、182-210）。
- **`flushDelta` 不能丢「只有 done、没有文本」的帧**：判据是 `!entry.text && !entry.done` 才丢；丢了手机端永远转圈（证据：host-runtime.ts:212-229；HANDOFF.md:126-127）。
- 非 delta 事件先 flush 同会话的缓冲再发出，以保持顺序（证据：host-runtime.ts:156-166）。
- 没人订阅某会话事件时降级为广播（证据：host-runtime.ts:168-180）。
- 15s 周期全量刷新会话列表；`cmd.send_prompt`/`resolve_permission`/`answer`/`interrupt` 之后立刻补一次推送（证据：host-runtime.ts:102-105、277-279）。
- 小程序 UI 侧自己的刷帧：100ms / 最多 300 条 / 单条截断 20000 字符（证据：mp/pages/chat/chat.js:10-13；HANDOFF.md:128）。

---

## 5. 中继的行为与加固要求

### 5.1 路由模型

- 三张内存表：`hosts: Map<hostId,{ws,label}>`、`clients: Map<clientId,{ws,meta}>`、`pendingPairs: Map<pairToken,{hostId,psk,expiresAt,used}>`、`conversations: Map<sessionId,{hostId,clients:Set<clientId>,seqHost}>`（证据：main.mjs:78-85）。
- host 与 client 的「配对到同一会话」靠 `conversations[sessionId]` 这张路由表；它的唯一创建点是 `pair-begin-client` 成功分支，`hostId` 取自 `pendingPairs[token].hostId`（证据：main.mjs:324-328）。
- 发送辅助 `sendTo(clientId,…)` / `sendToHost(hostId,…)` 都要求 `readyState===1`，静默丢弃不可写对端的帧（证据：main.mjs:409-416）。

### 5.2 认证

- `DRC_HOST_TOKEN` **只在 `auth` 帧的处理里校验一次**，没有任何 HTTP 端点或中途复查；比较用 `timingSafeEqual` + 先比长度（证据：main.mjs:236-238、89-93）。
- 无 token 则进程拒绝启动（证据：main.mjs:54-57；.github/workflows/ci.yml:58-61 专门测这条）；短于 24 字符只告警不阻止（证据：main.mjs:71-75；ci.yml:52 用 `DRC_HOST_TOKEN=ci-token` 仍能起）。
- 客户端侧无凭据：认证只有 6 位配对码，配对成功后不再有任何凭据（证据：docs/SECURITY.md:131）。
- `/healthz`、`/api/info` 无认证（证据：main.mjs:129-145）。

### 5.3 限流与上限

| 机制 | 默认 | 触发行为 | 证据 |
|---|---|---|---|
| 单帧字节上限 `DRC_MAX_MSG_BYTES` | 256 KiB | 交给 `ws` 的 `maxPayload`，超限 socket 以 **1009** 关闭 | main.mjs:44、165-170；hardening.test.mjs:78-89 |
| 并发连接 `DRC_MAX_CONNS` | 200 | 新 socket 立刻 **1013** `server_busy` | main.mjs:45、172-184；hardening.test.mjs:235-251 |
| 单连接帧速率 `DRC_MAX_FRAMES_PER_SEC` | 500/s | 回 `error/rate_limited`，累计 3 次违规关 **1008** | main.mjs:46、110-123、198-211；hardening.test.mjs:131-143 |
| host 认证失败次数（单连接） | 5 | `auth-fail`，用尽关 **4001** | main.mjs:47、239-252；hardening.test.mjs:91-109 |
| 配对码尝试次数（单连接） | 5 | `pair-fail`，用尽关 **4008** | main.mjs:48、307-320；hardening.test.mjs:111-129 |
| 全局配对尝试配额 | 20/s | `pair-fail:rate_limited`（令牌桶，秒级重置） | main.mjs:49-50、96-108、300-304 |
| 待配对表上限 | 1000 | `error/pair_table_full`（已存在的 token 允许覆盖） | main.mjs:50、283-286；hardening.test.mjs:218-233 |
| HTTP 请求/头部超时 | 30s / 15s | 只约束普通 HTTP，WS upgrade 不受影响 | main.mjs:161-162 |

补：6 位码 10⁶ 空间的可枚举性与「一次 60s 窗口约 1200 次猜测、命中率 ~0.12%」的量化结论，以及「加长码需要同时改三处」的清单（证据：docs/SECURITY.md:83-100）。

### 5.4 保活与孤儿会话清理

- 每 5s（`IDLE_SWEEP_MS`）扫描：对 `clients`/`hosts` 里 `readyState===1` 的 socket 发 **WS 层 ping**，上一轮未 pong 则 `terminate()`（证据：main.mjs:42、419-440）。**这是唯一的保活机制**：host 与小程序都不发应用层 `ping`（证据：§1 的 `ping` 行；relay-client.ts 无 ping 发送点；mp/core 无 `'ping'`）。推断：新实现若把保活改成依赖应用层心跳，所有空闲小程序客户端会被周期性踢掉。
- 同一轮扫里删除过期或已使用的 `pendingPairs`（证据：main.mjs:441）。
- client socket 关闭：从 `clients` 删除，把它从每个会话移出、通知 host `peer-left`，会话空则删除（证据：main.mjs:379-388）。
- host socket 关闭：仅当 `hosts[hostId].ws === ws`（防止重连时误清）才删除 host，并**丢弃该 host 的全部会话**、通知所有 client `peer-left`——不留孤儿会话（证据：main.mjs:389-403，含注释解释守卫条件）。
- host 重连：新 socket 先注册，因此旧 socket 的 close 回调中守卫为假、会话正确存活（证据：main.mjs:257-263、389-393 的注释）。

### 5.5 优雅停机

`SIGTERM`/`SIGINT` → 置 `shuttingDown`（新连接立即 1013）→ 停清扫定时器 → 给所有 socket 发 `1001 server_shutdown` → 关 `wss` → `httpServer.close()` 后 **exit 0**；5s 兜底强退（证据：main.mjs:446-473；hardening.test.mjs:184-202 断言 exit 0 与 1001）。`uncaughtException` 记录后以 exit 1 走同一路径交给 supervisor 重启（证据：main.mjs:480-483；docs/SELF-HOSTING.md:215）。`/healthz` 在停机期间 `shuttingDown:true`，可作 readiness 探针（证据：main.mjs:129-141；docs/SELF-HOSTING.md:194-195）。

### 5.6 健康检查与信息端点

- `GET /healthz` → `{ok:true, version, uptimeSec, hosts, clients, conversations, pendingPairs, shuttingDown}`（证据：main.mjs:126-142；hardening.test.mjs:174-182 断言 `uptimeSec`/`shuttingDown`/`conversations`）。
- `GET /api/info` → `{publicUrl: DRC_PUBLIC_URL, protocol: 1}`（证据：main.mjs:143-145；docs/SELF-HOSTING.md:43-44）。
- `GET /api/pair-status?token=` → **默认 404**；仅 `DRC_PAIR_STATUS=1` 时回答 `{ok:boolean}`。否决理由写在代码与文档两处：默认开启等于给 6 位码空间装了个免认证的判定 oracle（证据：main.mjs:51-52、146-156；docs/SELF-HOSTING.md:25-29；hardening.test.mjs:204-216）。
- 其余路径 404 `{error:'not_found'}`（证据：main.mjs:157-158）。

### 5.7 零知识审计：日志里有什么、必须没有什么

日志是「一行一个 JSON」的 `{ts,level,msg,...}`，级别由 `DRC_LOG_LEVEL` 控制（证据：main.mjs:59-69；docs/SELF-HOSTING.md:198-204）。

**服务端能看到并记录**：`hostId`、host `label`、`clientId`、`sessionId`、**6 位 `pairingToken`**（`pair token issued` 一条 info 日志）、`pair-fail` 原因与剩余尝试数、限流与连接数、断开关 code、停机信号（证据：main.mjs:240-243、272、294、308-312、340、387、402、449；docs/SELF-HOSTING.md:206-215 的告警表）。推断：`pairingToken` 落 info 日志意味着「日志泄露 + 二维码泄露」两项同时到位即可在 TTL 内完成配对，重写时值得重新评估这一条的级别（旧实现选择了记下来，代价没有写明）。

**服务端必须看不到**：任何载荷明文、会话标题、审批详情、模型输出——`enc` 的 `ciphertext` 只被搬运（证据：docs/SECURITY.md:3-25；main.mjs:344-357）。审计是自动化断言：把客户端观察到的每一 `enc` 帧 base64 解码后按 latin1 搜 `cmd.send_prompt` 与指令正文，并检查所有观察到的帧 JSON 里不含中文关键词（证据：e2e/run.mjs:198-213；e2e/live-e2e.mjs:128-134、273-283）。推断：新实现必须让同类审计继续可跑——「服务端日志/帧里不出现业务文本」是回归项，不是设计口号。

**另一处零知识偏差（重要事实）**：`pair-begin` 会把 PSK 发给中继，中继只在入队时按**字符长度**校验它（`typeof psk==='string' && psk.length>=16`，main.mjs:279）并存进 `pendingPairs`（写入见 main.mjs:287-292）；此后**全文件再未读取该字段**——路由与配对只看 `p.used`/`p.expiresAt`/`p.hostId`（证据：main.mjs:305-307、323-327）。而 docs/SECURITY.md:10-13 的信任表声称中继「不持有任何载荷密钥」。事实结论：服务端内存里确实在 TTL 窗口内多带了一份 PSK 副本，它对中继毫无用处（证据：上述行号；docs/SECURITY.md:10-13）。推断：这是实现比声明的信任边界更宽松的唯一一处，收紧它不会破坏小程序（客户端从不接收服务端下发的 PSK，见 main.mjs:328、332-339 的字段集）。

### 5.8 host 侧连接与重连（中继行为的上游约束）

- host 重连：指数退避 1s → 30s，带 0-500ms 抖动；握手超时 10s（证据：relay-client.ts:100-142）。
- host 自身待配对码上限 32，超限淘汰最旧（证据：relay-client.ts:33、264-270）。
- `connectionGeneration` 只在 `auth-ok` 递增，用于让调用方知道「中继重启过，我发布过的码全废」（证据：relay-client.ts:61-66、156-162；plugin/src/index.ts:381-394）。
- 小程序：连接超时 12s、重连 1s→30s 指数退避 + 抖动、SocketTask/旧式全局回调双路径、缺能力时停止重连（证据：mp/core/socket.js:19-22、214-234、243-252；HANDOFF.md:139-141）。

---

## 6. 防休眠（keepawake）命令构造器

纯函数 `buildKeepAwakeCommand(os, ownerPid, keepDisplay)`，与 spawn 解耦以便单测（证据：keepawake.ts:188-220；tests/keepawake.test.ts:5-34）。

### 6.1 macOS

`/usr/bin/caffeinate` + `['-i','-s','-w', String(ownerPid)]`；`keepDisplay` 时改为 `['-d','-i','-u','disk,display','-w', pid]`（证据：keepawake.ts:195-201；tests/keepawake.test.ts:5-15）。

WHY（源码注释原样给出的理由）：`-i` 阻止空闲休眠、`-s` 阻止接电源时的系统休眠、`-w <pid>` 把断言的生命周期绑到宿主进程——**宿主崩了断言随之消失，不会留下永久不睡机的机器**；整套方案无需 sudo（证据：keepawake.ts:5-8、196）。事实：`keepDisplay` 分支不带 `-s`（证据：keepawake.ts:198）。推断：该分支未实测，重写时按 `-d/-u` 语义保留原样即可，别顺手「修正」。

### 6.2 Linux

`systemd-inhibit` + `['--what=idle:sleep','--who=dsh-remote-control','--why=DSH remote session active','--mode=block','sleep','infinity']`（证据：keepawake.ts:203-214；tests/keepawake.test.ts:17-22）。

WHY：`--what=idle:sleep` 同时抑制「空闲触发挂起」和「挂起本身」两件事；`--mode=block` 是硬阻塞（默认的 `delay` 只推迟、策略仍可让机器睡），符合「远程会话进行中」的语义；末尾的 `sleep infinity` 是 `systemd-inhibit` 的惯用法——抑制剂持有锁直到被 hold 的命令退出（证据：keepawake.ts:6-7、203-214 的参数结构）。推断：`--who/--why` 是给用户与 `systemd-inhibit --list` 看的标签，值本身不参与协议，重写可换文案。

### 6.3 Windows（预留状态）

`buildKeepAwakeCommand('win32', …)` 会返回 `windowsExecutionStateCommand(keepDisplay)`：`powershell -NoProfile -Command` 内联 `Add-Type` 生成 `drc-execstate.exe`（`LibraryExecutable`）并执行，调用 `kernel32!SetThreadExecutionState`，标志位 `keepDisplay ? 0x80000003 : 0x80000001` = `ES_CONTINUOUS | ES_SYSTEM_REQUIRED [| ES_DISPLAY_REQUIRED]`（证据：keepawake.ts:222-240；tests/keepawake.test.ts:24-30）。

状态：**构造器存在且被单测覆盖到字符串层面，但整条路径从未在真机验证，被列为待办**（证据：HANDOFF.md:182「Windows 防休眠（`SetThreadExecutionState`）预留未实现」；keepawake.ts:9「disabled by default」）。推断：新实现应继续把它当作「未验证特性」，不要假设它可用；`detectBackend()` 在 win32 上报的字符串 `'SetThreadExecutionState (powershell)'` 会直接显示在手机界面上（证据：keepawake.ts:66-67；mp/pages/sessions/sessions.js:124-125）。

### 6.4 生命周期与状态上报（重写 host 的行为约束）

- 默认 `idleReleaseMs = 300_000`、`keepDisplay = false`（证据：keepawake.ts:44-48；plugin/src/index.ts:86）。
- 每 10s 检查空闲，超阈值 `stop()` 并 `publish()`；`idleReleaseMs<=0` 表示永不自动释放（证据：keepawake.ts:108-122；protocol/src/index.ts:124-125）。
- `markActive()` 会在持锁已被空闲释放的情况下重新拉起（证据：keepawake.ts:95-99）。
- 子进程 `stdio:'ignore'` + `unref()`，`stop()` 用 `SIGTERM`；失败原因记录 `exit code` 或 spawn error，随 `ev.keep_awake_state.reason` 上报（证据：keepawake.ts:141-163、165-176）。
- 活动驱动：`ev.tool_event`/`ev.permission_request`/`ev.question_request`/`ev.run_state{running}` 都算活动；有 pending 审批/提问时额外每 60s 打一次心跳式 `markActive()`，收到对应 `requestId` 的终结事件后停掉（证据：host-runtime.ts:236-254）。

---

## 7. 部署事实

### 7.1 生产入口与拓扑

| 项 | 值 | 证据 |
|---|---|---|
| 公网入口 | `wss://drc.provid.cc`（小程序真机强制 `wss://`，域名须在微信后台 socket 合法域名白名单） | deploy/README.md:9；docs/SECURITY.md:116；docs/MINI-PROGRAM.md:11-15 |
| 服务器 | 阿里云 cn-shanghai ECS `i-uf62gq3vjcvqzi8f9ozj` / `47.100.82.15` / Alibaba Cloud Linux 4（自带 node 22） | deploy/README.md:10、24；HANDOFF.md:171 |
| 中继目录 | `/opt/dsh-remote-control/server`（只拷 `src/main.mjs` + `package.json`，`npm install --omit=dev`） | deploy/README.md:11、29-34 |
| 反代 | nginx 1.30，`/etc/nginx/conf.d/drc.conf` | deploy/README.md:12、62-67 |
| 证书 | Let's Encrypt，acme.sh（`/opt/jevtv/acme/acme.sh`）+ 阿里云 DNS-01（`dns_ali`，凭证在 `~/.acme.sh/account.conf` 的 `SAVED_Ali_Key/Secret`），ECC，自动续期，`--install-cert` 落到 `/etc/nginx/ssl/drc.provid.cc.{crt,key}` + `systemctl reload nginx` | deploy/README.md:13、49-60 |
| DNS | 复用 `*.provid.cc` 泛解析，无新增记录 | deploy/README.md:17 |
| 暴露面 | 安全组只放 22/80/443；**8787 不对公网** | deploy/README.md:102-108、14 |
| 生产参数 | `DRC_PORT=8787`、`DRC_PUBLIC_URL=wss://…`、`DRC_PAIR_TTL_MS=90000`（公网收紧，默认是 120000）、`DRC_LOG_LEVEL=info` | deploy/README.md:37-43；docs/SELF-HOSTING.md:12；main.mjs:41 |

### 7.2 nginx 要点（TLS 终止 + 按 IP 限流）

- `map $http_upgrade $connection_upgrade` 标准两值（`upgrade`/`close`）（证据：deploy/nginx/drc.conf:12-15）。
- 按 IP 的两个 zone：`limit_req_zone $binary_remote_addr zone=drc:10m rate=20r/s`、`limit_conn_zone $binary_remote_addr zone=drc_conn:10m`；location 内 `limit_req zone=drc burst=40 nodelay` + `limit_conn drc_conn 8`（证据：deploy/nginx/drc.conf:17-20、52-53）。**为什么必须做在反代**：中继只有全局与单连接两级配额，看不到真实客户端 IP（证据：deploy/README.md:69-70；docs/SECURITY.md:95-96）。
- WS 升级三件套 `proxy_http_version 1.1` + `Upgrade`/`Connection` 头，并透传 `Host`、`X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto`（证据：deploy/nginx/drc.conf:55-62）。
- 长连接：`proxy_read_timeout 3600s`、`proxy_send_timeout 3600s`、`proxy_buffering off`（证据：deploy/nginx/drc.conf:64-67；docs/SELF-HOSTING.md:83-86）。
- TLS：`listen 443 ssl` + `http2 on`、`TLSv1.2 TLSv1.3`、`ssl_prefer_server_ciphers off`、session cache 10m/1d、HSTS `max-age=31536000`、`X-Content-Type-Options nosniff`；80 端口仅 301 跳转（证据：deploy/nginx/drc.conf:22-45、31-42）。
- 独立访问/错误日志：`/var/log/nginx/drc.access.log`、`drc.error.log`（证据：deploy/nginx/drc.conf:47-48）。
- 备选：Caddy 一条 `reverse_proxy 127.0.0.1:8787` 即可，自动证书（证据：docs/SELF-HOSTING.md:49-58）。

### 7.3 systemd 单元要点

`/etc/systemd/system/dsh-remote-control.service`：`Type=simple`、`User=root`、`WorkingDirectory=/opt/dsh-remote-control/server`、`EnvironmentFile=/etc/dsh-remote-control.env`、`ExecStart=/usr/bin/node src/main.mjs`、`Restart=always`、`RestartSec=3`；停机语义与代码对齐：`KillSignal=SIGTERM`、`TimeoutStopSec=15`（代码自身 5s 强退，留余量）；沙箱：`NoNewPrivileges`、`PrivateTmp`、`ProtectSystem=strict` + `ReadWritePaths=/opt/dsh-remote-control`、`ProtectHome`、`ProtectKernelTunables/Modules/ControlGroups`、`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`、`MemoryMax=512M`；日志进 journal，`SyslogIdentifier=dsh-remote-control`（证据：deploy/systemd/dsh-remote-control.service:9-44）。

**只绑回环**：单元里**没有** `DRC_BIND`，因此走代码默认 `127.0.0.1:8787`；注释明确「TLS 由反代终止，中继没理由出现在局域网里；只有自己就是边缘（容器发布端口）时才设 `DRC_BIND=0.0.0.0`」（证据：deploy/systemd/dsh-remote-control.service:6-7；main.mjs:34-38；docs/SELF-HOSTING.md:94-116 的模板同样不含 DRC_BIND）。
运维：`journalctl -u dsh-remote-control -p warning` 只看暴力破解/心跳超时类告警；改代码后 `scp main.mjs` + `systemctl restart`，重启丢配对是有意为之（证据：deploy/README.md:89-100；docs/SELF-HOSTING.md:217-225）。

### 7.4 密钥与配置存放位置（本文不记录任何真实值）

| 项 | 位置 | 权限 | 证据 |
|---|---|---|---|
| 中继侧 host token 与环境 | 服务器 `/etc/dsh-remote-control.env`（`DRC_HOST_TOKEN=<由 openssl rand -hex 32 生成；此处不记录>`） | `chmod 600` | deploy/README.md:15、37-44；HANDOFF.md:165 |
| 插件侧 host token | macOS `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `hostToken` + `serverUrl` | 600；**与服务器那一份必须逐字一致** | HANDOFF.md:166；deploy/README.md:15、72-78 |
| 插件状态快照 | `~/.dsh/dsh-remote-control/status.json`（排错第一入口：`carrier`/`relay`/`relayProblem`/`probe`） | 写入用 0600 + `tmp` 改名原子替换 | HANDOFF.md:24-25、167；plugin/src/index.ts:108-131 |
| 配对二维码 PNG | `status.json` 同目录 `pairing-qr.png` | 写入 0600 | plugin/src/index.ts:155-158 |
| profile 备份 | `~/.dsh/profiles/desktop/*.bak-drc-<ts>` | — | HANDOFF.md:168 |
| PSK | host 只在内存（`pendingPairs`），进程重启即失效；小程序在 `wx.setStorageSync` 沙箱内（key `drc.pairing.v1`） | 不落盘 | docs/SECURITY.md:120-123；mp/core/session-store.js:11-14、42-76 |
| 告警 | `pairOnStartSec>0` 会把「带 PSK 的活码」发布进 0600 的 `status.json`，配置校验时专门 warn | — | plugin/src/index.ts:59-65、230-236 |
| host token 传参卫生 | 测试脚本里的 token 全为占位值（如 `***`）；CI 冒烟用 `DRC_HOST_TOKEN=ci-token` | — | apps/server/tests/relay.test.mjs:8；hardening.test.mjs:12；.github/workflows/ci.yml:52 |

### 7.5 CI 事实（旧实现的验收线，重写后需要等价覆盖）

Node 20/22 矩阵 + pnpm 9 + `pnpm install --frozen-lockfile` → `pnpm -r build` → `pnpm -r test` → `node e2e/run.mjs`；另有独立 `relay-smoke`：只用 `npm install ws`、Node 20 裸跑 `main.mjs` 并探 `/healthz`，且断言「没有 `DRC_HOST_TOKEN` 必须起不来」（证据：.github/workflows/ci.yml:1-61）。`live-e2e` 不在 CI 内（需要真实内核与线上课），是发布前人工跑的最高标准（证据：HANDOFF.md:19、150-155）。

---

## 8. 依赖与工具链清单

### 8.1 第三方库

| 库 | 声明 → 锁定 | 用在哪 | 为什么选它 |
|---|---|---|---|
| `ws` | `^8.18.0` → `8.22.0` | 中继唯一运行时依赖；host 与 e2e 也用 | 「零依赖构建的 Node 服务，只需要 ws」（证据：apps/server/package.json:12-14；docs/SELF-HOSTING.md:3；pnpm-lock.yaml:18-31） |
| `tweetnacl` | `^1.0.3` → `1.0.3` | protocol（`secretbox`/`hash`/`box.before`）；host 依赖同款 | 纯 JS、跨运行时语义一致：`nacl.hash` 就是 SHA-512，Node/小程序都有；避免依赖平台 hash（证据：packages/protocol/package.json:17-20；crypto.ts:1-13；pnpm-lock.yaml:85-86） |
| `tweetnacl-util` | `^0.15.1` → `0.15.1` | base64 编解码 | 与 tweetnacl 配套；注意它是 CJS，ESM 里必须默认导入后解构、不能具名导入（证据：crypto.ts:11-13；HANDOFF.md:87） |
| `@types/ws` | `^8.5.12` → `8.18.2`（dev） | host 类型 | 证据：packages/plugin/package.json:36-41；pnpm-lock.yaml:51-53 |
| `typescript` / `@types/node` | `^5.6.3`→`5.9.3` / `^22.9.0`→`22.20.4`（dev） | protocol、plugin 编译 | 中继刻意保持 `.mjs` 无构建（证据：package.json:14-17；pnpm-lock.yaml:9-16；apps/server/package.json:9 `"build": "true"`） |
| `tdesign-miniprogram` | `^1.10.0` | `mp/` UI | 开源组件库；产物按依赖闭包裁剪预置（约 1.5MB，含内嵌 tslib），**不要点「构建 npm」**（证据：mp/package.json:6-9；HANDOFF.md:142-144；docs/MINI-PROGRAM.md:17-21） |
| `js-base64` | `^3.7.7`（vendor 进 `mp/core/vendor/js-base64.js`） | 小程序 UTF-8/base64 | 小程序无 Buffer/TextEncoder，需纯 JS（证据：mp/package.json:8；mp/core/codec.js:8-12；HANDOFF.md:133-134） |
| tweetnacl（vendor 为 `mp/core/vendor/nacl-fast.js`） | 打过小程序补丁 | 小程序 crypto | 移除 `require('crypto')` PRNG 探测否则加载即崩；**不提供 `Math.random()` 兜底，宁可抛错**；升级 tweetnacl 需重新打补丁（证据：docs/SECURITY.md:66-70；docs/MINI-PROGRAM.md:56-65；HANDOFF.md:135-138） |
| `qrcode-generator` 1.4.4（vendor `packages/plugin/src/vendor/qrcode-generator.ts`，MIT） | vendored | host 端二维码编码 | 自己写 QR 编码器曾试过，被 zxing-cpp 对拍抓出系统性差异后否决（证据：plugin/src/qr.ts:1-16；docs/MINI-PROGRAM.md:117） |
| zxing-cpp + pillow + segno（Python venv，仅校验期） | 不在运行时依赖 | `scripts/validate-qr.mjs` 真实解码渲染结果 | 「校验不靠肉眼」，28 组含 CJK 与公网 URL 全绿（证据：scripts/validate-qr.mjs:8-14、34；docs/MINI-PROGRAM.md:118-119） |

Node 内置即可、无需库的地方：`node:http`、`node:crypto`（`randomUUID`/`randomBytes`/`timingSafeEqual`）、`node:module` 的 `createRequire`（读 package.json 版本号）、`node:zlib.deflateSync`（手写 PNG 的 IDAT）（证据：main.mjs:24-30、130-141；plugin/src/qr.ts:15、162-199）。

### 8.2 工具链与工作区形态

- pnpm workspace 成员：`packages/*`、`apps/*`、`e2e`；**`mp/` 不是成员**（证据：pnpm-workspace.yaml:1-4；目录含 `mp/package.json` 却不在列表）。推断：刻意为之，避免构建工具碰小程序目录。
- `engines.node >= 20`，根 `type:module`；协议与插件都 `main: ./dist/src/index.js`（tsconfig `rootDir:"."`，产物落在 `dist/src/**`）（证据：package.json:6-8；apps/server/package.json:5-6、15；packages/protocol/package.json:6-7；HANDOFF.md:79-81）。
- tsconfig 基线：`ES2022` / `module: NodeNext` / `strict` / `noUncheckedIndexedAccess` / `declaration` / `sourceMap` / `esModuleInterop` / `resolveJsonModule`（证据：tsconfig.base.json:2-15）。
- 测试：`node --test`；**传目录会 MODULE_NOT_FOUND，必须给文件或 glob**（证据：HANDOFF.md:85；apps/server/package.json:10；packages/plugin/package.json:29）。
- 插件必须能装进外部 profile：`@dsh-rc/protocol` **只能是 devDependency**，构建后由 `scripts/bundle-protocol.mjs` 把协议产物内联到 `dist/protocol/` 并改写裸 specifier；改了 protocol 必须重新 build 插件（证据：packages/plugin/package.json:31-41；HANDOFF.md:82-84）。
- 已知环境坑：本机跑 pnpm 一律 `env -u NODE_OPTIONS`（FS 钩子拦符号链接）；改插件代码必须重启 Harness（HMR 不重 import dist）；重装用 `scripts/install-to-profile.sh`（pnpm 对 `file:` 依赖是硬链接拷贝）（证据：HANDOFF.md:64-76）。
- 被评估并否决的中继技术选型：**Fastify 迁移 / server 上 TypeScript**——无值守环境下优先降低工具链风险；**配对改 X25519 握手**——小程序无 CSPRNG 且无成熟纯 JS 实现；**独立 CLI bin**——配对必须由运行中的 host 生成 PSK（证据：HANDOFF.md:184-189；docs/SECURITY.md:61-71）。

### 8.3 重写时可以直接继续用开源的地方（原则：能用开源就不造轮子）

证据支撑的判断：旧实现已经在这些点上遵守该原则，并留下了两处「试过自己造、最后回到开源」的记录。

- 可以继续用开源：**`ws`**（WS 服务端/客户端）、**`tweetnacl` + `tweetnacl-util`**（secretbox/hash/base64；注意 §3 的字节契约是包装层，不是算法本身）、**二维码编码器 `qrcode-generator`**（否决自写，证据：plugin/src/qr.ts:1-12）、**TDesign**（UI，证据：docs/MINI-PROGRAM.md:3-5）、**js-base64**（小程序 UTF-8/base64）。
- 旧实现自己造、且必须继续自己造（因为字节语义已固定，换库反而要重新对拍）：KDF 的 0x1f 分隔与截断、`{ciphertext}` 记录布局、计数器 nonce（证据：crypto.ts:41-50、151-158；mp/core/codec.js:117-142）。
- 旧实现自造的边缘件：手写 grayscale PNG 编码器（为了让插件装进外部 profile 时零依赖）与终端 QR 渲染的三种风格（证据：plugin/src/qr.ts:162-199、40-64、93-120）。

---

## 9. 重写时的兼容性风险清单

「新实现在这里自由发挥就会把小程序弄坏」的点，按破坏面排序。

1. **记录布局** `base64(nonce24 ‖ secretbox)` 与外层字段名 **`ciphertext`**。改名字或改成两段字段，小程序 `open` 直接返回 null，表现为「配对成功但一切解不开」（证据：mp/core/codec.js:88-99；crypto.ts:62-76；docs/SECURITY.md:16）。
2. **KDF 逐字节**：`SHA-512`、**每个 part 之后**补 `0x1f`（含最后一个）、截**前 32 字节**、parts 顺序 `['dsh-rc/v1', dir, convId, pskBytes]`、方向串 `'c2h'`/`'h2c'`、nonce 命名空间 `'dsh-rc/v1/nonce'` 且顺序 `['dsh-rc/v1/nonce', installId, convId, pskBytes]`。少一个分隔符、改成 `0x00`、或截后 32 字节都会静默产出不同密钥（证据：crypto.ts:41-50、151-158；mp/core/codec.js:59-81、123-125）。
3. **base64 必须是标准表**（`+` `/` `=`），不是 url-safe（证据：e2e/mp-crypto.test.mjs:34-42；mp/core/codec.js:48-56）。
4. **`peer-joined` 发给 host 的那一份必须带 `pairingToken`**；发往 client 的那一份必须**不**被当作 PSK 查找触发（它的 `clientId` 填的是 hostId）。多发/漏发都会踩 §2.3 的第二个 bug（证据：main.mjs:264-270、332-339；relay-client.ts:179-214）。
5. **`pair-ready` 必须带正数 `ttlMs`**，host 必须据此改写本地过期；否则 host 提前清扫 PSK → 静默丢 peer（证据：main.mjs:293；relay-client.ts:167-178；HANDOFF.md:114-116）。
6. **配对两侧都必须是 `Map<token,{psk,expiresAt}>` 多槽**，服务端 `pendingPairs` 的 value 形状含 `hostId/psk/expiresAt/used`（证据：main.mjs:82-83、287-292；relay-client.ts:47-56）。
7. **`error.code` 与 `pair-fail.reason` 是 UI 分支条件**：`unknown_session` 才让小程序清配对并提示重扫；其余 code 原样冒泡。`pair-fail` 已翻译的 reason 为 `invalid_or_expired`/`already_used`/`host_offline`/`bad_token`，`rate_limited` 未映射会露出英文原文（证据：mp/core/client.js:227-234、356-364；main.mjs:300-325）。
8. **`peer-left` 到客户端 = 丢弃配对**。绝不能因为「某个客户端离开」而向其他客户端广播 `peer-left`（证据：mp/core/client.js:219-223）。
9. **`paired{hostId, sessionId}` 与 `sessionId` 前缀 `c_`**：小程序把 `sessionId` 当 convId 持久化并用于密钥派生与后续所有 `enc`（证据：main.mjs:326-328；mp/core/client.js:267-283；relay.test.mjs:63）。
10. **`hello`/`hello-ok` 的 clientId 语义**：客户端可自带 `clientId`，服务端可覆盖（`hello-ok.clientId`）；但 clientId 绝不能参与 nonce 或密钥派生（小程序的 nonce 前缀只认存储里的 installId）（证据：main.mjs:230-233；mp/core/client.js:254；mp/core/session-store.js:82-91）。
11. **保活只能是 WS 层 ping**：host 与小程序都不发应用层 `ping`；若新中继改判应用层心跳，空闲客户端会被周期性 terminate（证据：main.mjs:419-442；§1 `ping` 行）。
12. **`enc` 的路由不变量**：`ciphertext` 必须逐字搬运；h2c 方向服务端覆写 `seq`、c2h 方向原样透传；转发到 host 时必须带 `clientId`（host 用它做 per-client 回调）。任一侧都不校验 seq 单调性，所以 seq 只是元数据（证据：main.mjs:344-357；relay-client.ts:228-238；mp/core/client.js:291-293）。
13. **帧大小上限不能低于旧默认 256 KiB**：单条 delta 合并上限 4096 字符，但对拍测试跑过 60 KB 载荷；`maxPayload` 超限是**硬断开 1009**，收紧会直接掐断流式输出（证据：main.mjs:44、165-170；hardening.test.mjs:78-89；host-runtime.ts:18-20；e2e/mp-crypto.test.mjs:106-110）。
14. **`enc-batch` 的形状**：若要启用，必须是 `{t:'enc-batch', sessionId, items:[{seq, ciphertext}]}`，且 `sessionId` 只在外层——小程序逐项只读 `items[i].ciphertext` 并复用外层 `sessionId`。今天中继完全没有这个分支（收到即 `unknown_frame`），host 侧也完全没有（证据：protocol/src/index.ts:43-47；main.mjs:373-374；mp/core/client.js:240-247；relay-client.ts:155-244）。
15. **配对二维码 URI 与 `'+'` 规则**：`dshr:/p?` 前缀、参数名 `v/s/n/psk/t`、`t` 仅在 6 位数字时被采纳、缺 `n` 回落 `'dsh'`、必须用 `URLSearchParams` 生成（`+`→`%2B`）。生成侧改成裸拼或 url-safe，小程序的 `+` 兼容重试会解出错的 PSK（证据：crypto.ts:120-149；mp/core/codec.js:145-174）。
16. **6 位配对码**：`pair-begin` 的 `/^\d{6}$/`、`protocol/src/index.ts` 的 `formatPairingToken`、小程序 `normalizePairingToken`（去掉空格与连字符后按 6 位正则采纳）三处耦合；位数变了这三处必须一起动，而小程序改不了（证据：main.mjs:279-281；protocol/src/index.ts:243-250；mp/core/codec.js:169、200-202；docs/SECURITY.md:98-100）。
17. **`pair-begin-client` 不带 PSK**：任何「要求客户端提交 PSK」的改动都会让小程序配对失败（证据：mp/core/client.js:257；main.mjs:298-342）。
18. **关闭码语义被客户端依赖**：`1001`（停机→立即重连）、`1013`（繁忙/拒绝→客户端指数退避）、`1009`（超限）、`1008`（限流）、`4001`/`4008`（爆破防护）、`4000 replaced`（同 hostId 顶号）。换成自定义码会让重连策略失去依据（证据：main.mjs:179、205、248、260、316、453；hardening.test.mjs:88、107、127、201、247；mp/core/socket.js:243-252）。
19. **端点形状**：`/healthz` 的 `ok/version/uptimeSec/hosts/clients/conversations/pendingPairs/shuttingDown` 与 `/api/info{publicUrl,protocol}` 被测试与 `live-e2e` 直接消费；`/api/pair-status` 默认必须 404（证据：main.mjs:126-156；hardening.test.mjs:174-182、204-216；e2e/live-e2e.mjs:106-108）。
20. **WS 路径为 `/`**：`WebSocketServer({path:'/'})`，而用户手上已有各种 `serverUrl`（含根路径与带自定义路径的样例）。推断：新实现若把 path 收窄成 `/ws` 之类，已发布在 `status.json`/二维码/用户收藏里的地址会全部连不上——保持「任意路径或根路径可 upgrade」最稳（证据：main.mjs:165-170；e2e/mp-crypto.test.mjs:113 使用 `wss://drc.example.com/ws` 作为样例 server 值；docs/SELF-HOSTING.md:90）。
21. **载荷级双 `sessionId`**：中继帧 `sessionId`=通道 id，payload `sessionId`=DSH 会话 id；host 转发时把两者混淆会让客户端聊天页过滤掉所有事件（聊天页按 `p.sessionId !== 当前会话` 丢弃）（证据：HANDOFF.md:109-110；mp/pages/chat/chat.js:85）。
22. **`done` 帧不可丢**：`ev.message_delta{done:true}` 是唯一结束信号，且可以不带文本；小程序据此停止转圈（证据：host-runtime.ts:212-229；HANDOFF.md:126-127；mp/pages/chat/chat.js:101-114）。
23. **`ev.keep_awake_state` / `ev.session_changed` 不带 `sessionId`**（因此必须能被聊天页之外的入口消费，且不能突然加上 `sessionId`——加上就会被聊天页当作「别的会话」丢掉）（证据：index.ts:135-139、188-195；mp/pages/chat/chat.js:85）。
24. **零知识可审计性**：日志与帧里绝不出现业务明文；控制面里能出现的只有 id/计数/配对码/label。重写时若把 `clientMeta.label` 或 payload 片段带进日志，`e2e/run.mjs` 与 `live-e2e` 的审计步骤会红（证据：main.mjs:272、294、340；docs/SECURITY.md:22-25；e2e/run.mjs:198-213；e2e/live-e2e.mjs:273-283）。
25. **纯内存、重启即失效是设计而非缺陷**：客户端靠 `unknown_session` + `peer-left` 得知并要求重扫；给中继加持久化会同时改变 `connectionGeneration` 与 `used` 标记的语义（证据：docs/SELF-HOSTING.md:219-220；HANDOFF.md:180-181；relay-client.ts:61-66）。
26. **`String(raw)` + `JSON.parse`**：帧是文本；发送方（小程序）也只发字符串。新中继若只接受 Buffer 或改用二进制帧，双方直接失联（证据：main.mjs:212-217；mp/core/socket.js:104-112）。
27. **PSK 目前会过网一次**（`pair-begin`），但中继从未读取；新实现若改为「PSK 完全不过网」则协议字段必须仍兼容（`pair-begin` 仍要带 `pairingToken`），且 host 侧仍要能拿到 token（证据：main.mjs:278-292 与全文无 `p.psk` 读取；docs/SECURITY.md:10-13）。推断：这是唯一一处「旧实现比声明的信任边界更宽松」的地方，重写时收紧不会破坏小程序。
