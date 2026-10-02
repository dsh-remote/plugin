# DESIGN.md 对抗性复核（阶段 B/C 开工前）

> 复核对象：`docs/DESIGN.md`（347 行）。接口权威：`docs/legacy-spec/mp-client-contract.md` 与 `mp/` 源码。
> 结论档位：🔴 必须改设计 / 🟡 建议改 / 🟢 确认无误。

## 1. 冻结契约覆盖矩阵（B1-B9 / F1-F13 / T1-T8）

锁定手段分三档：**V** = `e2e/fixtures/wire-vectors.json` + `e2e/protocol.test.mjs`（已绿，17 项）；
**U** = `packages/protocol/tests/*.test.ts`（已绿，68 项）；**B/C/D** = DESIGN §7 阶段 B/C/D 的验收命令（**目前一行都不存在**，
`apps/server/tests/*.mjs` 那 13 项与 `packages/plugin/tests/*.ts` 那 36 项都是旧实现的测试，阶段 0 会连代码一起删）。

### 1.1 字节级 B1-B9

| # | 锁定手段 | 证据 | 判定 |
|---|---|---|---|
| B1 | V（密封记录 12 组）+ U `record.test.ts:58`（外层仅 `ciphertext`）| DESIGN:39 | 🟢 |
| B2 | V（base64 8+42 组，含空串与各种填充）+ U `record.test.ts:58` + `e2e/protocol.test.mjs:230`（严格度差写成断言） | DESIGN:40 | 🟢 |
| B3 | V（`open` 短记录）+ U `record.test.ts:70,79` + `protocol.test.mjs:198` | DESIGN:41 | 🟢 |
| B4 | V（KDF 13 组 + 会话密钥 144 组）+ U `keys.test.ts:40` + **反证测试** `protocol.test.mjs:272` | DESIGN:42 | 🟢（这套唯一有反证的一条） |
| B5 | V（144 组 = 2 方向 × 3 convId × 24 PSK）+ U `keys.test.ts:64,71` | DESIGN:43 | 🟢 |
| B6 | V（nonce 前缀 12 + 计数器 nonce 12）+ U `keys.test.ts:83,98` | DESIGN:44 | 🟢 |
| B7 | U `keys.test.ts:124`（16B→24 字符、每次不同）；「每次配对轮换」是 **host 侧行为**，锁定手段在阶段 C，**目前无测试** | DESIGN:45 | 🟡 半边空 |
| B8 | V（配对 URI 33 组，含全部 null 分支）+ U `pairing.test.ts:50`（未编码 `+` 重试）、`:63`（尾部 `=`）、`:70`（带端口/路径的 server）+ §7-A④ | DESIGN:46 | 🟢 |
| B9 | 分散在 V/U 的向量里（常量出现在向量输入输出中），但**没有一条测试断言"常量清单逐字"**；`'wechat-mp'`/`'微信小程序'` 只在 `mp/core/client.js:122` 存在，新协议层的 `clientMeta` 是 `z.string().optional()`（`packages/protocol/src/frames.ts:48-51`），不校验也不产出 | DESIGN:47 | 🟡 |

### 1.2 帧与字段 F1-F13

| # | 锁定手段 | 缺口 | 判定 |
|---|---|---|---|
| F1 「既有帧名语义不得挪用」 | U `frames.test.ts:145` 只断言**入站**未知帧名被中继拒；「新增帧名必须落进小程序 `default` 分支」（`mp/core/client.js:248-249`）**没有任何测试**，§7-D② 的 12 项闭环也不注入未知帧 | 需要在阶段 D 的闭环里加一条「向真实 client 注入 `{t:'<新名>'}` 与 `{t:'auth-ok'}`，断言 status 不变、配对不丢」 | 🔴 只有文档 |
| F2 客户端只发 3 帧 | U `frames.test.ts:30,47` | — | 🟢 |
| F3 双 `sessionId` | 协议层**结构上无法测**（外层 `sessionId` 与 payload `sessionId` 分别在 `frames.encFrame` 与 `payloads`，二者不比对）。真正的执行判据在阶段 B（forward 不得改写外层）与阶段 D（聊天页过滤）。DESIGN:55 把它列为契约，§7-B① 的验收文字里**没有这一条** | 加断言：中继转发时外层 `sessionId` 逐字等于入站值；`ev.*` 内层 `sessionId` 中继永不移除也不填充 | 🔴 只有文档 |
| F4 必发 `hello-ok` / `paired` 带 `sessionId` | `paired` 有 U `frames.test.ts:117`（schema 必填）；**`hello` 之后必须 `hello-ok`** 无测试，且 schema 层面「必填」只在**构造器**路径成立——`frames.ts` 导出的是裸 zod 对象 + `makeXxxFrame` 三个，中继若 `ws.send(JSON.stringify(手搓对象))` 就不经过任何校验 | DESIGN §5.2 未规定「出站帧必须走 maker」；§7-B 验收里也没有「egress 全走 schema 自检」这条 | 🔴 机制缺位 |
| F5 `unknown_session` 字面量 / host 掉线必发 `peer-left` | 行为在阶段 B；旧实现有 `apps/server/tests/hardening.test.mjs:145`、`e2e/mp-client.test.mjs:209`，但**两者都会随阶段 0 删除** | §7-B① 的文字只写「配对状态机全路径」，没点名 `unknown_session`；§7-D⑤ 只覆盖中继重启路径 | 🟡 |
| F6 四个 reason 逐字 | U `frames.test.ts:131` + `mp/core/client.js:356-364` 映射表 | `rate_limited` 在 `frames.ts:147` 里是**第 5 个合法值**且明确「未映射会露英文」，DESIGN:58 点到了，但 §7-B 没有「不得对客户端发第 5 个 reason」的断言 | 🟡 |
| F7 `ev.session_changed` / `updatedAt` 必须 ISO | U `payloads.test.ts:142,237`（含 `isoOrUndefined` 兜底）；生产侧（host 真的只能发 ISO）在阶段 C | — | 🟢 协议侧 |
| F8 列表推送义务 | 纯 host 行为，**目前 0 测试**（旧实现靠 `e2e/run.mjs:114`、`mp-client.test.mjs:120`，阶段 0 后失效） | §7-C 的 8 条验收里**没有 F8**；只在 §3-2 的闭环里隐式覆盖（阶段 D） | 🔴 阶段 C 无验收 |
| F9 `done:true` 不可丢 | U `payloads.test.ts:117`（done 可选布尔）；合并器行为在阶段 C④（§7-C④ 明确写了「空文本 done 帧必须转发」） | 🟢 有验收命令 |
| F10 审批/提问逐字回传 | U `payloads.test.ts:72,92,183`；真机取证 = §7-D⑥ | 🟢 |
| F11 两个 payload 不许带 `sessionId` | `payloads.ts:58-63,131-138` 两个 schema 里**确实没有** `sessionId` 字段，但也**没有 `.strict()`** → 于是两条路都不安全：(a) host 不经校验直接 `seal(obj)` → 多带的 `sessionId` 上线 → 聊天页把它当别的会话丢掉（`mp/pages/chat/chat.js:85`）；(b) 若出口走 `parseEvPayload`（`payloads.ts:243-246`）→ zod 默认 **strip** 把字段静默剔掉 → 插件的 bug 被吞、测试还是绿的 | 与 F4 同一个根因：**没有出站 maker/断言**。要么给这两个 schema 加 `.strict()` 并在出口 `parse`（配一条"带 `sessionId` 必须抛"的测试），要么加一个 `assertOutgoingPayload()` 显式拒绝禁止字段 | 🔴 只有文档 |
| F12 `enc-batch` | U `frames.test.ts:99`（形状）；`mp/core/client.js:240-247` 逐项解密；**中继侧无人实现也无人测试** | 建议明确写「阶段 B 不实现批量发送」，否则实现者会顺手加上并按 per-conversation 串行改造，与 T3 打架 | 🟡 |
| F13 `seq` 不得校验单调 / `clientId` 不得当凭据 | U `frames.test.ts:92`（seq 任意起点）+ `keys.ts` 结构上不吃 `clientId`；**中继不校验单调**这件事只有阶段 B 之后才成立，且 §7-B⑤ 的文字只提 D4 成员校验，没提「不得加 seq 检查」 | 需要一条负向测试：同一 convId 用 `seq=1` 之后用 `seq=1` 再来一次必须照发 | 🟡 |

### 1.3 运行时与传输 T1-T8

| # | 锁定手段 | 判定 |
|---|---|---|
| T1 只允许文本帧 | 无测试。旧实现同样是 `String(raw)` 直接解（`apps/server/src/main.mjs:214`）。建议在阶段 B 的 hardening 里断言「中继写出的每一帧都是 `string`」——`ws.send(Buffer)` 会发 binary 帧且**不报错**，这是最容易写错的一条 | 🔴 只有文档 |
| T2 ≥256 KiB | §7-B② 有 1009 一条（旧 `hardening.test.mjs:78` 等价） | 🟢 有验收 |
| T3 per-conversation 串行 | 无验收命令。旧实现靠 `ws.send` 同步 FIFO 天然成立（`main.mjs:351-356`）；新实现 `forward.ts` 一旦引入异步队列就可能自己打破它，而 §7-B 抓不到 | 🔴 |
| T4 只能 WS 层 ping | 无测试。风险方向明确：`relay-and-wireformat.md` §5.4/§9-11 说改判应用层心跳会周期性 `terminate()` 掉空闲小程序 | 🟡 |
| T5 关闭码语义 | §7-B② 点名 1009/1013/1008/4001/4008。**但 DESIGN:75 的理由是错的**：小程序**读不到 close code**——`mp/core/socket.js:152` 与 `:202` 的 `onClose(() => {...})` 丢弃了回调参数，`mp/core/client.js:126-128` 的重连判据只看 `status !== 'needs-pair'`，退避由 `socket.js:243-252` 的计数器决定，与 code 无关。`relay-and-wireformat.md` §9-18 说「1001 → 客户端立即重连」同样是**未核实**的外推 | 🟡 结论可留、理由必须改（见 §2.5） |
| T6 WS 路径 | 无测试。**措辞会误导实现**：DESIGN:76 写「**保持**根路径与任意路径都可 upgrade」，但旧实现是 `new WebSocketServer({path:'/'})`（`apps/server/src/main.mjs:165-170`），`ws` 的 `path` 是**精确匹配**——现网 `wss://drc.provid.cc/anything` 根本升级不了。取证档案自己也写的是「推断：保持任意路径或根路径可 upgrade 最稳」（`relay-and-wireformat.md` §9-20）。而 `mp-client-contract.md` §4 末行要求「必须接受用户手填的任意 ws(s) URL，含路径」 | 🔴 这条是**扩大**而非保持，验收里要有「`/drc`、`/ws`、`/` 三种 path 都能 upgrade」 |
| T7 HTTP 端点 | §7-B② 点名 healthz 计数与 pair-status 默认 404（旧 `hardening.test.mjs:174,204`）。`/api/info{publicUrl,protocol}` 无字段集断言 | 🟡 |
| T8 中继地址来源 | 本次核对：`mp/` 全量无硬编码域名，`drc.serverUrl` 为运行时存储（`mp/core/session-store.js:13,93-99`；`pair.js:247` 只校验 `^wss?://`）。🟢 事实成立；但它与 T6 是同一件事的两面，T6 不放开 path 则 T8 落空 |

### 1.4 缺口汇总（🔴 条目）

F1、F3、F4、F8、F11、T1、T3、T6 —— **八条只有文档、没有任何机械防线**，且其中 F4/F11 的防线
即使实现者照写也不存在（zod 的默认 strip 让"多余字段"和"禁止字段"长得一模一样）。
共同根因：§3 的三件事全部集中在**协议层与字节层**，而 F/T 表里一半的条目是**中继与 host 的行为义务**，
§7-B/§7-C 的验收文字没有逐条对齐 §2 的编号——建议把 §7 表格的验收列改写成「B1-B9/F1-F13/T1-T8 每条 → 一个测试名」的映射表，
缺号的显式写「未覆盖」，这才是 §3-3 那条"自查清单"真正能落地的形态。

## 2. D1 / D5 / D3 / D4 的兼容性漏洞

> 本节同时审 DESIGN §4/§8 与**已经在写的阶段 B 代码**（`apps/server/src/{main,config,state,server,limits,log}.ts`，
> 未提交，写于 11:34–11:40）。代码已经比 DESIGN 多出一条 **D6（主机断开宽限期 120s）+ 新错误码 `host_unavailable`**
> （`server.ts:10-12` 自称"四条行为差异"却列了 D1-D6 六条；`frames.ts` 未提交的 diff 新增 `host_unavailable`）。
> **拍板清单 §8 里没有 D6** —— 先把它补进 §4/§8，否则它就是一个没被审过的破坏性变更（下面第 2.3①条说明它为什么会静默坏掉）。

### 2.1 D1「pair-begin 去掉 psk」

**结论：对手机端零影响，🟢。中继/host/e2e 侧也无隐含依赖。** 逐处核对：

| 面 | 核对点 | 证据 | 判定 |
|---|---|---|---|
| 小程序 | PSK 只从二维码/粘贴框进来，从不上下行 | `mp/core/client.js:102`（`opts.psk` 赋值）、`:257`（`pair-begin-client` 只带 `pairingToken`）、`mp/core/codec.js:151-174`（URI 解析）、`mp/pages/pair/pair.js:165,186-201,233-235` | 🟢 |
| 小程序 `paired` 字段集 | 只读 `sessionId`/`hostId`，不读 psk | `mp/core/client.js:267-272` | 🟢 |
| 中继 | 旧实现写入后全文再未读取；新实现 `PendingPair` 结构里根本没有该字段 | `apps/server/src/main.mjs:287-292` 对比 `apps/server/src/state.ts:45-50` | 🟢 |
| host | PSK 一直在 host 本地 `Map<token,{psk,expiresAt}>`，`peer-joined` 按 token 取 | `packages/plugin/src/relay-client.ts:56,185-221,261-270` | 🟢 |
| e2e | `live-e2e.mjs:159` 的 psk 取自 status.json 里的**二维码文本**（本地文件），`multi-pair.test.mjs:105` 取自 `createPairing()` 返回值；两者都不经过中继 | 上述行号 | 🟢 |
| 日志/状态文件 | 新 `log.ts` 字段类型只允许标量 + `pair token issued {token: REDACTED}`（D2） | `apps/server/src/server.ts:183-184` | 🟢 |

**但有两条落地风险：**

1. 🔴 **`pair-begin` 的字段消失 = 旧 host 与新中继不兼容，而"回滚"是两侧独立部署的。**
   `packages/protocol/src/frames.ts:108-116` 的 `endpointFrame` 联合里已无 `auth`，`pairBeginFrame` 无 `psk`；
   旧插件发的 `auth`（`relay-client.ts:113`）会落进 `server.ts:351-354` → `error{unknown_frame}` →
   旧插件的 `default: return`（`relay-client.ts:241-242`）**把它丢掉**，于是 `RelayStatus` 永远停在 `connecting`，
   `status.json` 里 `relay` 字段也不报 auth-failed。§8 第 314 行写的"回滚 = 换回上一版产物目录 + restart"
   只在**两侧同时回滚**时成立；中继单机回滚/插件单机回滚的表现是"静默不上线"，不是"报错"。
   建议：§7-E 的验收里加一条**双向兼容矩阵**（旧插件×新中继 / 新插件×旧中继 = 必须在 60 秒内把
   `relayProblem` 写成人类可读的"版本不匹配"），或让中继保留一个只发给 host 的 `auth` 兼容分支（小程序读不到，不违反 F1）。
2. 🟡 **`bad_pair` 这个 code 在 D1 之后失去了它存在的主要理由。** `errorCodes` 仍含 `bad_pair`
   （`frames.ts:170`），而 `server.ts:169-185` 的 `handlePairBegin` 已不再有可能返回 `bad_pair`
   （token 由 schema 的 `PAIRING_TOKEN_RE` 保证）。留着不死，但 §3-3 的自查清单应写明"哪些 code 已经是死的"。

### 2.2 D5「auth 三帧并入 hello」

小程序侧的分支走向（**逐行走** `mp/core/client.js:199-251`）：

| 新中继可能下发 | 小程序走向 | 证据 | 判定 |
|---|---|---|---|
| `hello-ok{role:'client', clientId, protocol}` | `case 'hello-ok'` → `_onHelloOk` **只读 `f.clientId`**，其余字段全部忽略 | `client.js:209-211, 253-255` | 🟢 零影响 |
| `hello-ok{role:'host', hostId}` | 小程序永远不会收到（role 由 host 的 socket 决定） | `client.js:119`（role 字面量 `'client'`） | 🟢 |
| `error{code:'bad_token'}` | `case 'error'` → `code !== 'unknown_session'` → `emit({kind:'error', message: f.message \|\| f.code})` | `client.js:227-234` | 🟢 触发不到（见下） |

F5 之外的隐藏行为，逐条核过：

1. 🟢 **触发面为空**：`bad_token` 只在 `frame.role === 'host'` 分支里发（`server.ts:124-130`），
   而小程序的 role 是硬编码字面量（`client.js:119`）。除非有人把小程序的 hello 改掉，客户端拿不到这个 code。
2. 🟡 **`bad_token` 在两条路径上语义撞车**：它既是 `pair-fail.reason`（`mp/core/client.js:361` 映射为"令牌错误"），
   又是 D5 新的 `error.code`。同一个字符串在手机上一个是"配对失败文案"、一个是"toast 里的裸 code"。
   `errorCodes`（`frames.ts:165-188`）与 `pairFailFrame.reason`（`:147`）两套枚举共用一个词，
   建议在 §4-D5 里明确写"host 侧鉴权失败用 `bad_token` 仅出现在 `error.code`，且永不发给 role:'client'"。
3. 🟡 **D5 与 F1 自相矛盾**：DESIGN:53 把 `auth`/`auth-ok`/`auth-fail` 列为"既有语义不得挪用"，
   `frames.ts:7-8` 的冻结帧名清单里干脆没有 `auth*`（只剩 `hello-ok`…`error`），
   而 §4 又说这是有意删除。三处文字需要一次收敛：**F1 的冻结对象是"小程序 `switch` 里的 9 个名字"**
   （`mp/core/client-contract` §2.1 末行：「可以新增帧型，但不能占用上表 9 个名字」），
   `auth*` 从来不在小程序的消费面里 → 应把 F1 改写成"消费面 9 名冻结 + 生产面 `auth*` 随 D5 退役"。
4. 🔴 **真正没被 D5 覆盖的缺口：`hello-ok` 的"必发"义务没有机械防线。**
   F4（DESIGN:56）要求 `hello` 之后必须 `hello-ok`，因为缺了它小程序会**永远停在「正在连接 …」**
   并且 12 秒后超时重连、循环、不报错（`mp/core/socket.js:214-234`、`client.js:111`）。
   `server.ts:136,156-161` 目前确实两条分支都发，但 `helloOkFrame` 要求 `role` 必填（`frames.ts:121-128`），
   而发送处用的是 `sendToPeer(peer, {…})` **手搓对象**（`server.ts:136,156`），不经过任何 schema；
   `RelayFrame` 类型只在函数签名上约束。将来 D5 的握手一改（例如给 host 加 `graceUntil`），
   少发一个 `hello-ok` 只有真链路测试能抓到，而 §7-B 的验收文字里没有"每条 hello 必有 hello-ok"这条。
   建议：出站帧统一走 maker + `relayFrame.parse`（dev/test 下断言），并加一条 e2e：
   「真实 `mp/core/client.js` 连上新中继，`hello` 之后 2 秒内必须观测到 `hello-ok`，否则判失败」——
   这条同时是 F4 与 D5 的执行判据。

### 2.3 D3「会话跨断连存活」——五条，两条是硬洞

#### ① host 重连守卫 / client 重连守卫：新实现的守卫**已经比 DESIGN 写得多**，但缺一半

DESIGN 不变量 3（`:175`）只规定 host 侧守卫；新代码把 client 侧也补上了：
`state.ts:255-267`（`clientGone` 开头 `if (this.clients.get(clientId)?.ws !== ws) return []`）。
这条守卫**必需的**，因为小程序确实会自建重叠连接：`socket.js:214-234` 的 12 秒超时是"我这边没等到 onOpen"，
不代表中继侧那条 TCP+WS 没建立 → 旧连接仍在、新连接又发一次 `hello`。🟢。

🔴 **但反向的"顶号"只给 host 不给 client**：`attachClient`（`state.ts:114-116`、`server.ts:152-153`）
直接 `clients.set(clientId, {ws})` 覆盖，**不返回 replaced、不关旧 socket**（对照 `attachHost`
`state.ts:100-108` + `server.ts:138` 的 `4000 replaced`）。后果分两层：

- 合法竞态：手机的旧 socket 变孤儿，被 `sweep()` 的 ping 超时 terminate（`server.ts:400-412` 遍历
  `wss.clients`，所以不漏），**期间它每 5 秒被 ping、不占死**，可接受；
- **可被利用**：`clientId` 非秘密（`mp/core/codec.js:204-212` 是 `Date.now()+Math.random()`），
  而且它会出现在中继发给 host 的 `peer-joined.clientId`（`server.ts:214-219`）与中继日志里
  （`server.ts:162`）。任何知道 clientId 的一方发一条 `hello{clientId}` 就能**把会话的下行扇出抢到自己 socket**，
  并把真手机打成 `not_member`（见 ③）——真手机的 socket 还 OPEN，所以它**不会重连、不会重新 hello、
  永远停在「已连接，正在恢复会话」**。这就是用户要的那种"静默坏掉"。
  动作：`attachClient` 与 `attachHost` 对称——返回 `replaced` 并 `close(4000)`；
  被顶掉的一侧靠 `socket.js:243-252` 的退避自动重连夺回身份。同时在 §4-D4 里补写"成员绑定的强度上限"。

#### ② 重挂逻辑会不会永远挂不上（clientId 与 installId 不一致）

**不会挂不上，但前提是"中继永不另发 clientId"**——这条已经被写进代码注释，且是对的：
`state.ts:110-113` 与 `server.ts:150-152`（`frame.clientId?.trim() || randomUUID()`）。
关键事实：小程序**总是**自带 clientId（`client.js:72` hydrate 时 `store.installId()`；
`client.js:109` 再兜一次），所以 `randomUUID()` 分支对小程序不可达；
而 `client.js:254` 采纳的是中继**回显的同值**，因此跨重启/跨冷启动恒定。
另外 nonce 前缀用的是**存储里的 installId**而不是被覆盖的 `this.clientId`
（`mp/core/session-store.js:89`），所以改写 clientId 不会动摇密钥——与 `relay-and-wireformat.md` §3.9 一致。🟢

🟡 但 **D3 的重挂判据现在写成"clientId ∈ conv.clients"，实现上等价于"谁报对这个 id 谁就是成员"**，
而 `routeFrom`（`state.ts:187-196`）的第二个判据是 `clients.get(clientId)?.ws === sender`——
一旦 ① 的顶号发生，真手机的这条判据就永远为假。所以：**判据必须是 socket→peer 的直接绑定**
（`peer.clientId` 已经是 `server.ts:155` 存的），`routeFrom(convId, senderSock)` 目前正是这么写的（好），
真正的修复点是 ① 的顶号，而不是再加一层校验。

🟡 **另一条"永远挂不上"的真实路径**：如果将来有人觉得"clientId 太长/太丑"而改成中继统一发号
（`hello-ok.clientId = randomUUID()` 而**不回显**），那么第一次配对时 conv 记的是发号 A，
手机存了 A 但**只在内存里**（`client.js:254` 不写 storage，installId 仍是 B），
小程序一旦被杀掉重进就带 B 回来 → `conv.clients` 里只有 A → 从此 `not_member`。
这一条要在 §4-D3 里写成"重挂键 = 客户端自带的 clientId，禁止中继另发"，否则阶段 C 的人会以为可以改。

#### ③ 会话 TTL 与 `unknown_session`、host 重启后密钥消失之间怎么收场——**这是本节最大的洞**

DESIGN:124-125 写的是："host 侧不再因 `peer-left` 丢弃会话与密钥，只在 host 自身重启（PSK 随之消失）
或中继重启时失效——**届时仍走既有的 `unknown_session` → 提示重扫路径**"。

这句话在协议上**不成立**：`unknown_session` 只有一个产生点，就是**中继的路由表未命中**
（`apps/server/src/state.ts:187-189` → `server.ts:231-235`；旧实现同构 `main.mjs:345-346`）。
host 重启后：

- host 的 `conversations`（含 `kC2H/kH2C`）随进程消失 → `relay-client.ts:228-230`
  `const conv = this.conversations.get(f.sessionId); if (!conv) return`——**静默丢弃，一句日志都不回**；
- 中继这边：host 在宽限期内重新 `hello{role:'host'}` → `attachHost` 把 `hostOfflineSince` 清空
  （`state.ts:100-106`）→ 会话既没删也没通知；
- 手机：`enc` 被中继当成合法成员转发给"新 host"→ 没人解、没人回 →
  `_onEncrypted` 一次都不会失败，所以**连 §3.2 那两次机会的自曝机制都不会触发**
  （`mp/core/client.js:291-314`）；状态停在 `online`「已连接，正在恢复会话」（`client.js:258-261`），
  列表空白，无 toast、无错误、无重扫提示。

**这正是 D3 想消灭的那个体验（回到电脑前重新扫码），只是把它变得更难发现。**
而 D6（120s 宽限期，`config.ts:78` `hostGraceMs`）是它的放大器：没有宽限期时 host 重启必然
`peer-left`→手机丢配对（可见、可恢复）；有了宽限期，**一次 2-5 秒的重启刚好落在窗口内**，于是永久卡死。

动作（不需要动小程序，也不需要新帧名，按代价从小到大）：

1. **host 侧兜底**（阶段 C 必须写进 §5.3 与 §7-C 验收）：host 收到 `enc`/`enc-batch`/`peer-joined`
   里的 `sessionId` 自己不认识时，向中继发一条 **`session-leave{sessionId}`**（帧名既有，
   `frames.ts:100-103`，小程序从不发它 → 零影响）；
2. **中继侧配合**：`session-leave` 现在只按 `peer.clientId` 处理（`server.ts:290-300`），
   host 发过来时 `state.leave(undefined??'', …)` 恒 false → 整条路被吞。
   必须新增"host 发起的会话作废"分支：删会话 + 向 `conv.clients` 逐个发 `peer-left`
   （`mp/core/client.js:219-223` → 明确的"主机已断开，请重新配对"）；
3. **兜底兜底**：`host_unavailable`（`server.ts:240-244`）之外，host 连续 N 次
   `undecryptable frame dropped`（`relay-client.ts:232-234`）也应触发同样的作废。

不修的话，§7-D⑤ 那条"中继重启续用取证"会**绿**，而这个 bug 会在生产上第一次 host 重启时必现——
因为它测的是中继重启（会话被清空 → `unknown_session`），不是 host 重启（会话被保留 → 黑洞）。

#### ④ `_onPaired` 覆盖已存 convId：续用路径与重新配对路径会不会互踩

会，且踩相很难看。事实链：

- `_onPaired`（`client.js:267-288`）**无条件**覆盖 `this.convId` 并 `store.savePairing({nonceCounter: 0, ...})`；
- `sendCmd`（`client.js:181-183`）用的是 `this._resume || {psk, convId, nonceCounter:0}`，
  `nextNonceFor(pairing)`（`session-store.js:85-91`）**先写回 storage 再算 nonce**，
  前缀取的是 `pairing.psk` + `pairing.convId`（`session-store.js:89`）；
- `pair.js:_applyParsed`（`pair.js:203-221`）在**旧配对还在**的时候就把新 psk 写进 `this.client.psk`
  （经 `connect({psk})` → `client.js:102`），但 `kC2H/kH2C` 仍是**旧 psk + 旧 convId** 派生的，
  `_resume` 也是旧的。

于是这三条交错：

| 场景 | 结果 | 判定 |
|---|---|---|
| 扫码→`paired` 成功 | 覆盖 convId/keys/`_resume`，`nonceCounter` 归 0；旧 conv 的 key 与 nonce 前缀（含旧 psk）都换了 → **不撞 nonce** | 🟢 |
| 扫码后**配对失败**（`pair-fail`）：`_pendingToken=null`（`client.js:216`）但 psk 已被换成新的、convId/keys/`_resume` 还是旧的 | `isPaired()` 仍 true → 下次 `hello-ok` 走"恢复"分支（`client.js:258-261`）发 `cmd.list_sessions`，**用旧 key 封、用旧 convId 路由** → host 端解得开（它那份 conv 还在）→ 手机看起来"掉回旧主机会话"，而用户以为在配新码 | 🟡 可接受但必须写进 §7-D 用例 |
| 配对过程中旧 conv 的下行帧到达（例如 host 正在推 `ev.session_changed`） | 手机已把 `kH2C` 换成新 conv 的 → 解密失败；**连续两帧即 `_resetPairing`（`client.js:296-303`）→ 连 socket 一起关（`disconnect()` 置 `_manualClose`，`socket.js:114-127`）→ 新配对也被打断**，用户看到"配对已失效（密钥不匹配），请重新扫码" | 🔴 D3 让这条更容易踩：会话存活期越长，旧 conv 在"新配对进行中"这个窗口里继续被推流的概率越大 |

动作：§7-D② 的闭环里加一条**「已配对 → 再扫新码 → 旧会话此刻仍在被推流」**的用例（host 侧
制造 5 帧 `ev.message_delta`，断言新配对成功且旧帧被丢弃但不触发 `_resetPairing`）。
中继侧的对应缓解：**会话被替换的瞬间就停止向该 socket 转发旧 conv 的下行**——
即"一个 clientId 最多只能是一个 conv 的成员"（新 `paired` 落地时从旧 conv 的 `clients` 里摘掉自己）。
这条规则 DESIGN 完全没写，但 `state.ts:154-159` 的 `claim()` 是直接新建会话、不动旧会话的，
所以现在**没有**任何一处实现它。

#### ⑤ `clients` 是 Set 但拓扑恒 1:1：`peer-left` 会不会变成"通知别人离开"

事实核过：旧实现"没有任何代码路径能让一个会话出现第二个客户端"（`relay-and-wireformat.md` §1 补充事实，
锚点 `main.mjs:320-327`；每次认领新建会话）。新实现同样在 `claim()` 里新建（`state.ts:152-160`），
所以 **1:1 仍然成立**——但 D3 之后有两个新变量：

1. `conv.clients` 里的 id **永不因断连被摘**（`state.ts:240-254` 的刻意设计），
   于是一个 conv 的成员集合会单调增长的唯一途径是"两个不同 installId 认领同一个 conv"——
   现在不存在这个入口（`claim` 只新建），所以集合大小恒为 1。**除非**将来做"多客户端挂一个会话"
   （§7.2 已明确不带）。所以这一条的**当前**风险不在成员集合，而在下面 2；
2. 🔴 **`peer-left` 的接收方判据是"广播给这个会话的对侧"**，两处代码：
   `server.ts:374-376`（客户端离开 → 发给 host，正确）与 `server.ts:415-419`
   （D6 宽限期到 → 发给 `dropped.clientIds` 每一个，正确）。
   真正危险的是**"客户端离开 → 发给其它客户端"**这个一行改动就能引入的写法；
   `state.ts:250-253` 的注释已经明确禁止，但 **§7-B 的验收里没有对应的负向用例**。
   补一条：两个 clientId 手工挂进同一个 conv（用 `RelayState` 纯内存测试即可，`state.ts` 不 import `ws`，
   这条测试成本极低），断言 A 离开时 B 的 socket 收不到任何 `peer-left`。
   代价如果漏了：B 的手机直接 `_forgetPairing()`（`client.js:219-223`）→ 无辜丢配对，就是 §9-8 那条红线。

### 2.4 D4「成员校验能不能重新建立」——四种情形 + 最易写错的一处

| 情形 | 能否重新建立 socket↔成员绑定 | 证据 |
|---|---|---|
| SocketTask 路径 | **能**。每次 `_bindTask` 都重新注册 `onOpen` → 每次连接都发一条 `hello` → `attachClient` 重绑 | `mp/core/socket.js:140-157`；`client.js:114-133`；`server.ts:149-161` |
| 旧式全局回调路径 | **能，但有两个尖角**：(a) 全局监听器只绑一次（`socket.js:185-186`），靠 `_mode`/`_task` 过滤迟到事件；(b) `closeSocket` 是**宿主全局**的（`socket.js:178-181`），一次 `connect()` 会关掉同宿主里另一条无关连接 | `socket.js:163-208`；`client.js:113` |
| 连接超时重连 | **能，但会出现双活连接**（12s 超时后手机自己新建，旧连接在中继侧可能还 OPEN）→ 依赖 2.3① 的守卫与顶号 | `socket.js:214-234, 243-252` |
| 中继重启 | **表全空**，重挂无从谈起 → 手机的 `enc` 得到 `unknown_session` → 清配对提示重扫（这是**唯一一条被文档和测试同时覆盖**的恢复路径） | `main.mjs`/`state.ts` 无持久化；`client.js:227-231`；§7-D⑤ |

🔴 **实现时最容易写错的一处**（也是现在这套代码里**已经错了半格**的地方）：
`frames.ts:170-181` 的 `errorCodes` 里 `not_member` 与 `unknown_session` 是**平级的两个 code**，
`server.ts:231-235` 把两者都直接回给发送方，包括**手机**。而手机上 `error` 分支只有
`unknown_session` 会触发恢复动作，其余一律变成一条 40 字 toast（`client.js:227-234` →
`sessions.js:93-95` / `chat.js:79-81`）。也就是说：一旦成员绑定因为任何原因丢失
（顶号、将来加的 `session-leave` 误删、conv 被 host 作废但客户端 id 忘了摘），手机拿到 `not_member`
**就是一个没有任何出口的死角**——它既不会重新 hello（socket 还开着），也不会清配对，
只会一直 toast。建议：

1. 对 `role==='client'` 的发送方，**成员丢失一律降级成 `unknown_session`**（手机上唯一自愈的字面量）；
   `not_member` 只用于非成员/匿名 socket（它的正确作用是拒绝盲灌，不是告诉合法端"你没了"）；
2. 同理 `host_unavailable`（`server.ts:243`）必须带中文 `message`——小程序优先显示 `f.message`
   （`client.js:232`），现在这条不带，用户会看到英文字面量 `host_unavailable`；
   这条通用规则值得写进 §5.2：「发给 client 的每一条 `error` 必须带 `message`，且 message 是中文」。

## 3. §5 模块边界的自相矛盾

### 3.1 🔴 「`deploy/` 与 `.github/` 保留」与新的产物形态直接冲突（这条会让线上炸）

DESIGN:10 的前提 3 说 `deploy/` 的 nginx/systemd 配置与 `.github/` CI 骨架**保留**。三处硬冲突：

1. `deploy/systemd/dsh-remote-control.service:20` 写死 `ExecStart=/usr/bin/node src/main.mjs`，
   `deploy/README.md:31,99` 写死 `scp apps/server/src/main.mjs`。
   而新中继是 TS + `pnpm build`（`apps/server/package.json:12` `tsc && tsup`）+
   `apps/server/tsup.config.ts` 的产物 `dist/bundle/main.js`。
   **阶段 0 删掉 `src/main.mjs` 的那一刻，保留下来的 systemd 单元就指向一个不存在的文件**；
   §7-E②「生产切换后 curl healthz 必须 ok」必须先改 unit + README 才能成立。
   动作：把"deploy/ 保留 = 保留 nginx 与 TLS 与参数值，**ExecStart 与 scp 清单必须重写**"写进 §7-B 或 §7-E 的交付列。
2. `apps/server/package.json:14` 的 `start` 是 `node dist/src/main.js`——这条路径运行时
   **需要** `@dsh-rc/protocol` 与 `zod`（`server.ts:17-24` import 的是 `parseEndpointFrame`/`base64Text`
   这些**运行时函数**，不是类型），而 `@dsh-rc/protocol` 在 `devDependencies` 里（`package.json:19-24`），
   部署走 `--omit=dev` → 直接 `ERR_MODULE_NOT_FOUND`。
   也就是说 **DESIGN:154「编译产物被中继当纯类型使用（devDependency）」这句是假的**：
   中继吃的是协议层的**运行时校验器**。要么把它升成 `dependencies`（与 §5.2「运行时依赖只有 `ws`」再冲突），
   要么在文档里把"只有 bundle 入口是受支持的部署产物"写死，并把 `start` 脚本改成 `start:bundle`。
3. `.github/workflows/ci.yml:41-60` 的 `relay-smoke` job 用 `npm install ws`（`:49`）+
   `node apps/server/src/main.mjs`（`:52` 与 `:60` 两处）起进程并探 `/healthz`。这条 job 的存在价值
   （"裸依赖、无构建、最低 Node 版本必须能起"）在 bundle 形态下需要整段重写为 `node dist/bundle/main.js`；
   而 `ci.yml:34` 的 `pnpm -r test` 与 `ci.yml:37` 的 `node e2e/run.mjs`（`e2e/run.mjs:14`
   import `packages/plugin/dist/src/host-runtime.js`）会在阶段 0 之后、阶段 C 完成之前一直是红的。

### 3.2 🟡 需求来源表指向不存在的文件，取证锚点写成未定义的代号

`DESIGN:9` 说"五份取证档案"，`docs/legacy-spec/` 实际有 **6** 份；`DESIGN:21` 表格里的
`legacy-spec/host-plugin.md` **不存在**（真实文件是 `host-plugin-runtime.md` 484 行与
`host-plugin-cordis.md` 629 行），且标着"待落盘"；`DESIGN:23` 把已经落盘 598 行的
`open-source-options.md` 也标成"待落盘"。更麻烦的是 `DESIGN:198` 与 `:269`（§7-C②）把 waterfall
黑名单与 carrier 能力差异的来源写成"来自 **P1** 取证"——全文没有定义 P1 是什么，
真实出处是 `host-plugin-cordis.md` §2.1（含逐个 .d.ts 路径的真实事件名清单）。
**阶段 C 的实现者按 §7-C② 去查"P1"会查不到东西**，而这条恰恰是"订阅守卫"的唯一依据。

### 3.3 🔴 §7-C⑧ 的自包含判据与 §5.3 的 externals 白名单互斥

`DESIGN:269` C⑧ 要求"在临时空目录里 `node -e "require(bundle)"` 不报缺依赖"；
`DESIGN:211` 又要求"externals 只留 cordis 与平台包"。两条同时成立只有两种可能：
bundle 顶层根本不 require cordis（不可能，插件入口必须 `import type`/取 `LooseContext` 之外的运行时符号才能注册），
或者这条断言**永远只能靠放宽判据来通过**。写法应改成**白名单式**：
在空目录里 require，捕获 `ERR_MODULE_NOT_FOUND`，断言"缺失的 specifier 集合 ⊆ {cordis, @deepseek-ai/*}"，
出现任何别的名字（`ws`/`zod`/`@dsh-rc/protocol`）即判红。这样它同时能守住"协议层确实被内联了"这条真实目标。
（对照 `apps/server/tsup.config.ts` 已有的同类做法：`noExternal: [/.*/]` + 只外置 `bufferutil`/`utf-8-validate`，
再用 `tests/bundle.test.mjs` 对产物做正则断言零密码学——插件侧应该抄这个**结构**而不是那句话。）

### 3.4 🟡 「core/ 不知道 cordis 存在」成立，但端口清单漏了 4 个必须跨界的维度

分层规则（`DESIGN:139`）说副作用全在适配器里、并且"每个窗口化参数、每条持锁策略都能在不起 cordis、
不起 socket、**不碰文件系统**的前提下被测"。`ports/` 只给了 4 个（kernel/transport/sleep/clock）。缺的：

| 缺的端口 | 谁必须用它 | 旧实现里的对应物 | 后果 |
|---|---|---|---|
| 诊断/日志 sink | `core/runtime.ts` 要报告"peer-joined 无 PSK""undecryptable frame" | `relay-client.ts:199,206-213` 的 `say()` + `lastPairProblem` | core 里要么 `console.log`（破坏可测性），要么偷偷 import `log.ts` |
| 文件系统写（0600 原子替换） | `shell/status.ts` 允许，但 **§7-C⑦ 要求 status.json 字段与 0600 原子写**，其**内容**由 core 产生 | `plugin/src/index.ts:108-131` | 结构没问题，但 `pairing/qr.ts` 写 PNG（`index.ts:155-158`，同样 0600）在 §5.3 的清单里**既不在 shell 也不在 core**，位置与规则冲突 |
| 进程派生 / 桌面"打开" | `pairing/qr.ts` 的"PNG + 打开"（`DESIGN:190,209`） | `shell/commands.ts` 只能拿到 cordis 的命令返回值（纯文本）→ 打开图片必须 `spawn` | 这是 cordis 之外的第二个平台符号，`platform/` 里没有对应适配器，端口表也没有 |
| 终端呈现能力（列宽/字形） | `pairing/qr.ts` 的 ascii/block/half 三档（`open-source-options.md` §D 倒数第 3 行明确"呈现层 15 行必须自己写，因为宿主 TUI 会吞空格/缺字形"） | 旧 `qr.ts:40-64,93-120` | 不注成端口就只能把"宿主是什么终端"写死在 core 里 |

结论：分层规则**没错**，但 `pairing/` 这一层在规则里没有归属（它既 import core 的 keys 又碰 fs/spawn）。
建议 §5.3 显式把 `pairing/qr.ts` 降级为 `platform/qr-render.ts` + 纯函数 `pairing/qr-text.ts`（矩阵→字符串，可测），
并补 `DiagnosticPort` / `RevealPort`（写文件 + 打开 + 终端尺寸）两个端口。

### 3.5 🟡 fixtures 用真实 mp 代码当 oracle 与 CI 的兼容性：**兼容，且这是本项目最强的一环**

`e2e/mp-sim.mjs` 用 `createRequire` + 最小 `wx` shim 在纯 Node 里加载 `mp/core/*.js`（`mp/core/package.json`
只是把目录标成 CommonJS，小程序无视——`mp-client-contract.md` §6 末行）。CI 是 `ubuntu-latest` + Node 20/22，
不需要微信运行时 → `e2e/protocol.test.mjs` 的两层（fixtures 与 mp 现跑）、`mp-client.test.mjs`、
`mp-platform.test.mjs` 都能在 CI 跑。真正**不能**进 CI 的只有两条，而 §7.1 把它们和能跑的并列了：

- `node scripts/validate-qr.mjs`：依赖 Python venv 的 `zxingcpp`（`open-source-options.md` §A.3/§C 倒数第 4 行）→ CI 必红；
- `node e2e/live-e2e.mjs --rounds 3`：需要线上中继 + 真实内核 + 一次性真码（`relay-and-wireformat.md` §7.5 明确"不在 CI 内"）。

动作：§7.1 的代码块要分成"CI 门禁"与"发布前人工"两段，否则"全部 e2e 通过"这句话永远无法被自动判定，
而 §7 开头的硬规则（"验收命令全绿才进下一阶段"）会因为一条跑不了的命令而必须破例——破例一次，纪律就废了。

### 3.6 🟡 阶段验收命令互相依赖，导致阶段 A 当时其实没有"一条命令"可跑

`DESIGN:260` 的硬规则是"每阶段一条验收命令全绿"，`§7.1` 的第一条是 `pnpm -r test`。
现实：`pnpm -r test` 会把 `@dsh-rc/server` 的 test 脚本一起跑，而它现在写的是
`pnpm build && node --test tests/state.test.mjs tests/relay.test.mjs tests/hardening.test.mjs tests/bundle.test.mjs`
（`apps/server/package.json:15`）——**后三个文件目前不存在**，`tests/` 里只有旧的 `relay.test.mjs`/`hardening.test.mjs`
（旧实现，`main.mjs` 已删则必挂）。所以阶段 A 当初只能按 `§9:324` 写的
`pnpm --filter @dsh-rc/protocol test` 来判定（事实上也正是这么记的）。
结论：把"每阶段一条命令"改成"**每阶段一条 `pnpm --filter <本阶段的包> test` + 全量 `pnpm -r test` 只在 D/E 用**"，
否则"不许先跳过后面补"这条纪律会在第一个阶段就被合理地违反。

### 3.7 🟢 结构性零知识这条边界，新落地的形态比 DESIGN 写的更强

DESIGN:169-170 说的是"中继里没有 `tweetnacl` 依赖"。`apps/server/tsup.config.ts:16-20` 的注释
把它升级成了**产物级**保证：只 import `frames`/`ids` + `sideEffects:false` ⇒ bundle 里不含任何密码学代码，
并由 `tests/bundle.test.mjs` 对产物做正则断言。这是设计文档里没写、但值得反过来**补进 §5.2**的一条
（"审计断言从依赖图成立 → 从产物字节成立"）。

## 4. §6 依赖清单

### 4.1 表与实现已经分叉的条目

| 条目 | DESIGN 的说法 | 实际 | 判定 |
|---|---|---|---|
| `tweetnacl-util` | §6:246「`tweetnacl`（**+ `tweetnacl-util`**）」 | `packages/protocol/src/bytes.ts:4` 明确写着"为什么这里只有 Buffer/TextEncoder，没有 `tweetnacl-util`"，`packages/protocol/package.json` 只依赖 `tweetnacl`+`zod`；`open-source-options.md` §C 第 2 行与 §E.2 末行还给出"建议净减 1" | 🔴 **表格必须改**：留着会让阶段 C 的人把它再装回去（`pnpm-lock.yaml` 里旧插件仍在声明它）。顺带 §6 的"与小程序同库同算法"这句话依赖的是 `nacl.hash==SHA-512`，与 util 无关 |
| `qrcode` | §6:247 选它，理由是旧自写编码器被 zxing 否决 | 与 §6 标题里的原则「**不为此多引一个传递依赖链**」（`:241`）**直接矛盾**：`open-source-options.md` §E.2 实测 `qrcode@1.5.4` 运行时闭包 **29 包 / 2.4 MB（yargs 占 27）**，并被记为"唯一净增" | 🟡 判据要重写成**能被满足的形式**：因为产物是 tsup 自包含 bundle，真实判据是"**bundle 里内联了什么**"，而不是"npm 装了几个包"。落地写法：`tests/bundle.test.mjs` 同款思路，对插件产物断言 (a) 不含 `yargs`、(b) 含 `qrcode` 的矩阵与 `pngjs` 的编码器，即可把"29 包"变成纯 dev-time 成本。若做不到（`require('qrcode')` 的入口确实把 CLI 拉进来），那就换 `qrcode-generator@2.0.4`（0 依赖）+ 自带 UTF-8 `stringToBytes`，并按 §A.3 的解码回归钉住 |
| `zod` | §6:248 用实测推翻"手写 60 行"，闭包 1 包 / 0 依赖 / 2.2M ops/s | 已落地（`frames.ts:24`、`payloads.ts:26`）。但**同一个进程里出现了两套校验**：`config.ts:52-60` 的 `integer()` 手写 env 校验并返回 `problems[]`，而 `loadConfig` 抛错的路径（`integer` 抛 → `main()` 的 `.catch` → `exit 1`）**绕过**了 `reportProblems` 的友好输出（`main.ts:38-41, 68-71`） | 🟡 两条都自洽，但要挑一条：既然 zod 已经在运行时里，env 也收成 `z.object` 才能保住"一处契约、problems 从 issue 列表生成"；否则至少在 §5.2 里写明"config 故意不用 zod 的理由是错误文案要给人读" |
| `ws` | §6:245「运行时依赖只有 `ws`」，部署 `npm install --omit=dev` | `tsup.config.ts` 把 `ws` 也 `noExternal: [/.*/]` 打进单文件 → 部署产物**零 node_modules**；于是 `apps/server/package.json` 的 `dependencies.ws` 只服务于 `dist/src/*` 那条**测试用**路径 | 🟡 §6 的说法没有错但已经**不是部署事实**。这条恰好是 §3.1 那条 🔴 的另一面：文档要指认唯一受支持的入口 |
| `tsup` | §6:249 dev | 中继与插件都用 | 🟢 |
| `node:test` | §6:250 | 是 | 🟢 |
| 自写 `log.ts` | §6:251「pino 是净增运维面（+1 依赖 +1 层 flush/序列化语义）」 | `log.ts` 头部注释给的是**实测**理由（11 线程 vs 7、13 包），且新增了一处 DESIGN 没写的东西：`LogValue = string|number|boolean` 的**类型层面零知识** + `tail` 环形缓冲 | 🟢 这一条比设计文档更严，应回写进 §5.2 |
| 防休眠 | §6:252 系统工具 | `sleep.ts` 三平台构造器 + `sleep.test.ts` 4 条 | 🟢 |

### 4.2 §B（happy / dshr）采纳判定逐条

**已采纳（阶段 B 代码里已经能看到，但 DESIGN 未登记 → 必须补进 §4 或 §6 的"采纳清单"）：**

| # | 来源 | 采纳形态 | 代码位置 | 判定 |
|---|---|---|---|---|
| 1 | dshr §B.2 第 1 条：`bufferedAmount` 背压 + 慢消费者断开 | `maxBufferedBytes=1 MiB`、持续 10s 超限 `close(1008,'slow_consumer')` | `apps/server/src/server.ts:97-113`、`config.ts:79` | **该采纳，已采纳**。但两点要补：①阈值是 dshr 的规范值不是我们的实测值（`open-source-options.md` §E.4 第 4 条自己承认）；②1008 会被手机当普通断开重连（`socket.js:243-252` 不读 code），**慢手机会被反复踢**，而用户只看到"连接已断开，正在重连…"。要么把窗口拉到 > 手机的 12s 连接超时 + 30s 退避上限，要么对 `role:'client'` 只降级为"停止 host→client 扇出的合并加速"而不是断开 |
| 2 | dshr §B.2 第 4、5 条：入站 fail-closed + golden vector 文件 | `frames.ts` zod 全量校验 + `base64Text` 字符集预检（`server.ts:356-359`）；`e2e/fixtures/wire-vectors.json` 284 条 | 已落地 | **该采纳，已采纳** 🟢 |
| 3 | happy §B.1.6 A5：目标不存在时"等重连宽限 + 明确失败"，绝不静默排队 | `hostGraceMs=120s` + 新错误码 `host_unavailable` | `config.ts:78`、`server.ts:240-244`、`state.ts:59,274-306` | **该采纳、已采纳，但这就是 §2.3③ 那个 🔴 洞的来源**：宽限期把"host 重启"从可见失败变成了永久静默；而且 D6 **完全不在 DESIGN §4/§8 的拍板清单里** |
| 4 | happy A1：共享 wire 包（只放 types+schema+helper，禁业务逻辑） | `packages/protocol` 八模块 + `sideEffects:false` + 子路径导出（`package.json:9-21`） | 已落地 | 🟢 |
| 5 | happy A2：持久 `update(seq)` vs 瞬时 `ephemeral` 二分 | 中继仍不持久化任何 presence；`seq` 只做审计编号（`state.ts:56,198-205`） | 已落地 | 🟢 **不值得再动**：mp 冻结了 `enc` 的字段面（F2/F13），把二分法做成协议变更 = 手机端坏 |

**该采纳但设计里还没有（都是纯 host/中继侧，不碰 mp 契约）：**

| # | 来源 | 为什么现在缺 | 动作 |
|---|---|---|---|
| 6 | happy A6「状态落地后才 emit」 | §5.3 的 `core/runtime.ts` 描述只有"cmd 分发、F8 推送义务、回执与幂等"，`§7-C` 八条验收里没有时序条目；而 §7-C④ 的窗口化恰恰是"先 flush 缓冲再发异类事件"的时序问题（`relay-and-wireformat.md` §4.4 第 3 条） | 给 §7-C 加第 9 条：`ev.session_changed` 必须在簿记落地后发，测试断言"命令回执与列表推送的相对顺序" |
| 7 | happy A7「presence 去抖 + 批量」 | 15s 全量刷新 + 每次状态变更即推（`relay-and-wireformat.md` §4.4 末段）是旧事实；新设计的 `core/window.ts` 只合并 delta，**不合并 `ev.session_changed`** | 明确写"session_changed 不去抖"或"去抖 500ms"，二选一；现状是没写 |
| 8 | happy A8：`/healthz` 里补"活跃连接 / 丢弃帧数 / 慢消费者次数" | 新 `health()` 只加了 `lastPingAgo`（`server.ts:444`），背压与拒绝计数都没出口 | 加 `droppedFrames`/`slowConsumers`/`rejectedPairs` 计数；同时 §2.3 的 T7 要写明"字段集只增不减"，否则"字段集冻结"与"加诊断计数"两条互相打架 |
| 9 | dshr §B.2 第 2 条「限额公开成协议常量 + 配套错误码」 | env 默认值都在（`config.ts:71-82`），但**没有一张成文的常量表**说明"超限时对端会看到什么" | §5.2 末尾补一张「限额 → 触发帧/关闭码 → 对端可见表现」表；这张表同时也是 §1 里 F/T 覆盖矩阵缺的那一列 |
| 10 | dshr §B.2 第 7 条「文档地位条款：示例与文档冲突时不得反向修改协议语义」 | DESIGN §2 与 `mp-client-contract.md` 谁权威只在**用户口述**里说清楚了，DESIGN:6 只说"唯一允许抄语义的地方" | 在 DESIGN 顶部加两行：「与 `mp-client-contract.md` 冲突时以它为准；与 `mp/` 源码冲突时以源码为准」 |

**明确不采纳（写清楚，免得阶段 B/C 有人"顺手加"）：**

- happy A3（每账户单调 seq + 断线全量重取）：`seq` 单调校验是 **F13 明令禁止**的（DESIGN:65），
  "断线全量重取"在手机上已经由 `client.js:258-261` 的 `cmd.list_sessions` 承担 → **因小程序冻结不可采纳**；
- happy A4（`expectedVersion` 乐观并发）：本系统没有多写者争用同一个版本化字段（会话状态由内核单方面决定），
  加字段虽被允许（加字段不动帧名），但**没有消费者**（mp 不读新字段，`client.js:208-250` 的 switch 之外什么都不看）→ 不值得；
- happy A9（诊断独立屏）/B4（账号体系）/B5（Socket.IO）/B6（9 事件扁平协议）/B7（push、WebRTC）/B8（Prisma/Postgres/Redis）/B9（pino+fastify-type-provider）：
  全部**因小程序不能改或红线（不新增常驻组件）不可采纳**（`open-source-options.md` §B.1.6 B 组已逐条给因）；
- dshr 的 Noise IK / X25519 pinning / WebRTC / 分片重组：**不可采纳**（mp 无 CSPRNG，`mp/core/codec.js:13-16,90-93`；
  DESIGN:254-256 的"明确不用"与此一致）。
  ⚠ 注意 §B.2 不采纳清单里那句"`@deepseek-ai/schemastery` 仅记录：宿主自带，配置校验可考虑不引第三方"——
  阶段 C 的 `shell/config.ts`（DESIGN:187）会正好撞上这个选择，**现在就要定**：用宿主自带的 schemastery、用已引入的 zod、还是手写，
  三选一并写进 §5.3，否则会出现"配置校验"在 shell 与协议层各一套的分裂（阶段 B 的 `config.ts` 已经是手写，见 §4.1 第 4 行）。

## 5. 零复用承诺检查

**基线判断：目前为止的重写不是照抄。** 具体差异是可信的、可指认的：`state.ts` 把四张表收进类里并注入
`Clock`（`state.ts:69-90`，因此状态机可在不起 socket 的前提下被纯内存测试，`state.ts:19-20` 明说这点），
对端被抽象成 `Sock`（`state.ts:26-30`，旧代码是直接用 `ws.readyState===1` 散在各处），
`limits.ts` 把"是否回错误帧"和"是否断开"拆成 `RateResult` 两个布尔并做窗口去重（`limits.ts:66-90`，
旧实现是 `rateViolations++` 每帧都回 `error`，`main.mjs:199-211`），`log.ts` 用 `LogValue` 类型把
"日志字段只能是标量"变成编译期约束（`log.ts:20-24`）。这些都是**分层不同 + 行为等价**的正例。

**但有三处（外加一处半）最可能滑成"照抄"**，而且都不是"抄得多像"，是"抄了却没登记为外部契约，
于是既不能声称继承、也不能声称重写"：

### 5.1 日志行的形状 `{ts, level, msg, …}` —— 与 `main.mjs:63-69` 逐字段同形

`log.ts:48-56` 造的记录是 `{ts: new Date().toISOString(), level, msg}` 再摊平 fields，
和旧 `log()` 一模一样；等级权重表同源（10/20/30/40，`main.mjs:60` vs `config.ts:40`，只有 `silent` 从 100 变 99）。
`level`/`msg` 是**运维契约**（`SELF-HOSTING.md` 的告警表 + `journalctl -p warning`，
取证 `relay-and-wireformat.md` §7.3 与 §5.7），所以"行为相同"是对的，但现在**没有任何一处写着它是契约**，
而 §7-B③ 新加的"日志零知识断言"目前只能靠**正则搜 msg 的英文措辞**来写 —— 措辞一变断言就失效。

> 改成分层不同、行为相同：把 `msg` 拆成 **稳定事件码 + 人读文本**两字段
> （`{ts, level, event:'pair.claim.rejected', reason:'already_used', text:'…'}`），事件码收成枚举并与
> `errorCodes`（`frames.ts:165-181`）对齐；同时保留一版 `msg` 别名写进 SELF-HOSTING 的迁移说明。
> 收益：零知识断言从"搜明文"升级成"按事件码白名单校验字段集"（**可穷举、不可绕过**），
> 而外部 `journalctl -p warning` 的行为一字不变。

### 5.2 `handleFrame` 的 switch —— 与 `main.mjs:226-375` 同形（case 顺序 + 每个 case 内联拼对象 send）

`server.ts:278-306` 的分支次序是 hello → pair-begin → pair-begin-client → enc → enc-batch → session-leave →
ping → default(`unknown_frame`)，与旧实现的 case 次序一致；并且**每个 case 里手搓出站对象**
（`server.ts:136,156,212,214,246,253,294,302`）—— 这正是 §1-F4 那个"出站无机械校验"缺口的成因，
两处是**同一个毛病的两个症状**：照抄了旧的 switch，就照抄了"帧是拼出来的而不是造出来的"。

> 改成分层不同、行为相同：**表驱动** `const ROUTES: Record<EndpointFrame['t'], (peer, frame) => void>`
> 与 `frames.ts` 的 `discriminatedUnion` 对齐（新增帧名时编译期就要求登记，等于把 F1 的
> "新帧名必须落进 default"从注释变成类型检查），出站一律经 `makeXxxFrame` + 一次 `relayFrame.parse`
> （dev/test 断言，生产热路径可对 `enc` 关掉）。行为等价可以这样证明：
> 用同一份"入帧脚本"跑新旧两个中继，比对**出帧序列**（帧名 + 字段集 + 顺序），而不是比对源码。

### 5.3 停机与保活这两段"时序" —— 抄了顺序，没抄成可测的机器

- 停机：`main.ts:47-56` + `server.ts:499-504` 的五步（置标志 → 停清扫 → 1001 广播 → `http.close` → 5s 兜底 exit 0）
  与 `main.mjs:446-473` 同序。可这是**外部可观测契约**（§7-B② 要求"exit 0 且对端收 1001"），行为必须相同。
  物证是没消化干净：`server.ts:31` 的 `const SHUTDOWN_FORCE_MS = 5000` **声明后从未被使用**
  （真正的兜底定时器在 `main.ts:50` 又写了一遍 5000）。
- 保活：`server.ts:395-413` 的"每 5s 遍历 → 上轮没 pong 就 `terminate()` → 否则 `alive=false; ping()`"
  与 `main.mjs:419-442` 同构，连字段名 `alive` 都对上旧代码的 `ws.isAlive`。T4 要求它必须等价。

> 改成分层不同、行为相同：把这两段做成**注入时钟 + 注入 `Sock` 的小状态机**
> （`Draining→Closed` / `Alive→Unanswered→Terminated`，两轮一个周期），放在 `state.ts` 已经证明可行的那个模式里，
> 于是 §7-B② 的两条判据（exit 0、对端收 1001、空闲客户端不被踢）都能用纯内存单测跑，
> 只有"真的 SIGTERM 子进程"留一条集成测试；`SHUTDOWN_FORCE_MS` 删掉或接进 `RelayConfig`。
> 反面风险：不改的话，阶段 B 的 hardening 测试只能像旧实现那样起子进程测停机（慢 + flaky），
> 一旦某天为了变绿把 5s 兜底调大，就是悄悄改了运维可观测行为。

### 5.4 🟡 语义继承清单要写全，并补"环境变量名"这一维

DESIGN:161 说 config 的默认值"逐项继承旧值（见 relay §5.3 表）"。默认值确实逐项对上了
（256 KiB / 200 / 500 / 5 / 5 / 20 / 1000 / 120000 / 默认 404，`config.ts:71-82`）。但**变量名换了三个**：

| 旧（`main.mjs:47-50`） | 新（`config.ts:76-78`） |
|---|---|
| `DRC_MAX_AUTH_ATTEMPTS` | `DRC_HOST_AUTH_MAX_ATTEMPTS` |
| `DRC_MAX_PAIR_ATTEMPTS` | `DRC_PAIR_ATTEMPTS_PER_CONN` |
| `DRC_MAX_PAIR_ATTEMPTS_PER_SEC` | `DRC_PAIR_GLOBAL_PER_SEC` |

线上 `/etc/dsh-remote-control.env` 目前只设了未改名的四项（`relay-and-wireformat.md` §7.1 生产参数行），
所以现在不炸；但 `SELF-HOSTING.md` 记录的旧名字会变成静默失效（`integer()` 只读新名字）。
**这是"语义继承"与"结构照抄"的正当分界线上唯一没被登记的维度。**
动作：§5.2 加一行「env 名允许改，但必须在 SELF-HOSTING 的迁移表里列出旧名 → 新名 + 一次启动告警」，
或者干脆保持旧名（继承名字本来就是允许的）。

## 6. 结论清单

### 🔴 必须改设计（8 条，按"开工前必须动"的次序）

| # | 问题 | 证据（文件:行号） | 建议动作 |
|---|---|---|---|
| R1 | **D3+D6 合起来造出一个永久静默黑洞：host 重启后，中继保留会话、host 丢了密钥，手机被路由到"没有钥匙的对端"，`unknown_session` 永远不会发生**（DESIGN §4 D3 那句"届时仍走既有的 unknown_session → 提示重扫"在协议上不成立，因为 `unknown_session` 只由中继路由表未命中产生） | `docs/DESIGN.md:124-125`；`apps/server/src/state.ts:187-189`（唯一 unknown_session 产生点）；`packages/plugin/src/relay-client.ts:228-230`（`if (!conv) return` 静默丢帧）；`apps/server/src/state.ts:100-108`（宽限期内回归即清除离线标记）；`apps/server/src/config.ts:78`（`hostGraceMs=120s` 刚好罩住一次重启） | 三件套写进 §5.2/§5.3 并各配一条测试：① host 对**不认识的 convId** 的 `enc`/`peer-joined` 回 `session-leave{sessionId}`（既有帧名、小程序从不发它，`frames.ts:100-103`）；② 中继收到 host 发起的 `session-leave` → 删会话 + 向 `conv.clients` 逐个发 `peer-left`（现在这条路径被吞：`server.ts:290-300` 用 `peer.clientId`，host 侧恒 `undefined`）；③ host 连续 N 次 `undecryptable`（`relay-client.ts:232-234`）同样触发 ①。§7-D⑤ 的"中继重启续用取证"**测不到这个洞**，必须新增"host 重启续用取证" |
| R2 | **成员校验失败对手机是死胡同**：`not_member` 与 `host_unavailable` 都不是 `unknown_session`，手机上只会变成一条 40 字英文 toast，既不重连也不清配对 | `mp/core/client.js:227-234`；`apps/server/src/server.ts:231-235,243`；`packages/protocol/src/frames.ts:165-181` | 规则写进 §5.2：「发给 `role:'client'` 的每一条 `error` 必须 (a) 带中文 `message`；(b) 凡是"这个会话对这个 socket 已经不可用"的情形一律降级成 `unknown_session`，`not_member` 只用于匿名/非成员 socket」 |
| R3 | **clientId 可以被人抢注**：`attachClient` 覆盖注册但不顶号（不对称：host 有 4000 replaced），抢注者拿到全部下行扇出，真手机被踢成 `not_member` 且**不会重连**（它的 socket 还开着） | `apps/server/src/state.ts:114-116`；`apps/server/src/server.ts:152-153`；对照 `state.ts:100-108`+`server.ts:138`；clientId 非秘密：`mp/core/codec.js:204-212`，且它会外泄到 host 与日志：`server.ts:162,214-219` | `attachClient` 返回 `replaced` 并 `close(4000)`（与 host 对称，被顶者靠 `mp/core/socket.js:243-252` 自动重连接回身份）；§4-D4 补写这条绑定的强度上限（"降低误灌，不是认证"），并把"不得由中继另发 clientId"写成 MUST（否则 `mp/core/client.js:254` 的采纳行为会让重挂永远对不上，见 §2.3②） |
| R4 | **`deploy/` 与 `.github/` "保留"承诺与新的产物形态冲突**：systemd 与 scp 清单写死 `src/main.mjs`；CI 的 `relay-smoke` 写死同一个文件；`pnpm -r test`/`e2e/run.mjs` 会在阶段 0 之后长期红 | `docs/DESIGN.md:10`；`deploy/systemd/dsh-remote-control.service:20`；`deploy/README.md:31,99`；`.github/workflows/ci.yml:41-60,34,37`；`apps/server/package.json:12-15` | 把「deploy/ 保留 = 保留 nginx/TLS/参数值；`ExecStart`、scp 清单、`relay-smoke` 必须重写」写进 §7-B 交付列；§7 的"每阶段一条验收命令"改成 `pnpm --filter <本阶段包> test`，全量只在 D/E（见 §3.1/§3.6） |
| R5 | **「协议层被中继当纯类型使用」是假的**：中继运行时 import `parseEndpointFrame`/`base64Text`；`@dsh-rc/protocol` 在 devDependencies，`node dist/src/main.js` 这条 `start` 路径在生产 `--omit=dev` 下必炸 | `docs/DESIGN.md:154,156`；`apps/server/src/server.ts:17-24`；`apps/server/package.json:13,19-24` | 二选一并写死为唯一事实：(a) `@dsh-rc/protocol` 升 `dependencies`，§5.2 的"运行时依赖只有 ws"改成"只有 `ws` + 协议层（纯 JS、无密码学）"；(b) 宣告 bundle 是唯一受支持入口，删掉 `start` 脚本、在 §7-B 加一条"从空目录跑 bundle 必须能起 + `/healthz` 必须 ok" |
| R6 | **§8 的拍板清单少了一条已被实现的偏离（D6 + `host_unavailable`），且 F1 与 D5 互相矛盾** | `docs/DESIGN.md:98-136,303-316`（只有 D1-D5）；`apps/server/src/server.ts:10-12`（自称"四条差异"列出 D1-D6）；`packages/protocol/src/frames.ts:15-19`（未提交 diff 新增 `host_unavailable`）；`docs/DESIGN.md:53`（把 `auth*` 列为"语义不得挪用"）vs `frames.ts:7-8`（清单里没有 `auth*`） | 补 §4-D6（含 120s 的取值依据、与 `mp/core/socket.js:214-234` 的 12s 超时/30s 退避的关系）；把 F1 重写为「消费面 9 名冻结（`mp/core/client.js:208-250` 的 case 白名单）+ 生产面 `auth*` 随 D5 退役」；`host_unavailable` 的中文 message 规则并入 R2 |
| R7 | **§2 的三张表有 8 条只有文档、没有任何机械防线**（F1/F3/F4/F8/F11/T1/T3/T6），其中 F11 的防线即使照写也不存在（zod 默认 strip 让"禁止的字段"和"多余的字段"长得一样），T6 被写成"保持"而实际是扩大（旧实现只允许根路径） | `docs/DESIGN.md:53,55,56,60,63,71,73,76`；`packages/protocol/src/payloads.ts`（默认 strip，无 `.strict()`）；`apps/server/src/main.mjs:165-170`（`path:'/'` 精确匹配）；`docs/legacy-spec/relay-and-wireformat.md` §9-20（自己标"推断"）；`docs/legacy-spec/mp-client-contract.md` §4 末行 | §7 的验收列改成「B/F/T 编号 → 测试名」的映射表，缺号显式写"未覆盖"；具体补的测试：注入未知帧名不断状态（F1）、出站 `sessionId` 逐字不变（F3）、每条 hello 必有 hello-ok（F4）、`session_changed`/`keep_awake_state` 带 `sessionId` 必须被 schema 拒（F11，改成 `.strip()`→ 显式断言或 `.strict()`）、出站全 `string`（T1）、per-conv 串行（T3）、`/`、`/ws`、`/drc` 三种 path 都能 upgrade（T6） |
| R8 | **阶段 C 的验收表（§7-C 八条）不含已经取证到的两处内核面必坏缺陷**，因此插件可以全绿而真机"中断"与"审批/提问"仍然是坏的；而 §7-D⑥ 的判据是"做不到就记未验证"= 允许带着已知缺陷上线 | `docs/DESIGN.md:269,270,311`；`docs/legacy-spec/host-plugin-cordis.md:265`（`agent.abort/interrupt` 全树零命中，正解 `agent.cancel({kind:'user'},{keepInbox:true})`，"services carrier 下实际永远走错误分支"）；`docs/legacy-spec/host-plugin-cordis.md:267`（`permission/requested`/`question/requested` **未取证到**，"推断：这是旧实现的未修缺陷"）；消费者在手机上：`mp/pages/chat/chat.js:245-249,165-183` | §7-C 加两条硬验收：⑨ `cmd.interrupt` 必须走 `cancel({kind:'user'},{keepInbox:true})` 并从内核 session log 取到取消事件；⑩ 审批/提问必须订阅**取证到的真实通道**（`approval/requested` 帧类型 / `approval/request` waterfall 的合法对侧），并允许 §7-D⑥ 的"未验证"出口**不适用于这两条**（它们是已知缺陷，不是未知风险） |

### 🟡 建议改（12 条，一句话一条）

1. §1 表指向不存在的 `legacy-spec/host-plugin.md` 并两处标"待落盘"，且"五份档案"实为 6 份（`docs/DESIGN.md:9,21,23`）。
2. §5.3/§7-C② 的依据写成未定义的代号"P1 取证"（`docs/DESIGN.md:198,269`，真实出处 `host-plugin-cordis.md` §2.1）。
3. T5 的理由错：小程序读不到 close code（`mp/core/socket.js:152,202` 丢弃回调参数、`client.js:126-128` 只看 status），"客户端重连策略依赖这些语义"应改成"对 host/运维有意义；对手机只有'必须发帧'才有意义"。
4. D5 后 `bad_token` 同时是 `error.code` 与 `pair-fail.reason`，两个 UI 面语义不同（`frames.ts:147,165-181`；`mp/core/client.js:227-234,361`）。
5. `bad_pair` 在 D1 之后是死 code，但仍留在 `errorCodes` 里（`frames.ts:170` vs `server.ts:169-185`）。
6. §4-D3 缺一条 MUST：**中继不得为 hello 另发 clientId**，且"重挂键只能是客户端自带的 clientId"不得改成按 hostId 找最近会话（`state.ts:110-116`）。
7. `_onPaired` 覆盖 convId 与"新配对进行中旧 conv 仍在推流"会互踩，两帧解密失败即 `_resetPairing` 连 socket 一起关（`mp/core/client.js:267-288,291-314`）→ 中继应在 `paired` 落地时把该 clientId 从旧 conv 的成员表摘掉（现在 `state.ts:152-160` 不动旧会话）。
8. 中继 `sweepIdle()` 删会话时不通知 host（`state.ts:316-331`），host 侧 `conversations` 因此没有上界（`relay-client.ts:216-221`，D3 后不再被 `peer-left` 删）→ 需要 host 侧 TTL 或"中继 idle-drop 时给 host 发 `session-leave` 的镜像"。
9. `qrcode` 与 §6 标题的原则"不为此多引一个传递依赖链"直接矛盾（`docs/DESIGN.md:241,247`；`open-source-options.md` §E.2 实测 29 包），判据应改成"bundle 内联了什么"。
10. §6 仍写"+ `tweetnacl-util`"，实现已明确不用（`docs/DESIGN.md:246` vs `packages/protocol/src/bytes.ts:4`）。
11. 慢消费者 1008 会与手机的 12s 超时/30s 退避形成循环（`server.ts:97-113,334-335`；阈值是 dshr 的参考值不是实测值，`open-source-options.md` §E.4 第 4 条）。
12. `/healthz` 加了 `lastPingAgo`（`server.ts:444`）与 T7"字段集"表述冲突；应写成"只增不减 + 新增项进 A8 的诊断计数"。

### 🟢 确认无误（抽查通过，可照写）

- B1-B6、B8 全部有逐字节向量 + 68 项协议单测 + 反证测试兜着（`e2e/protocol.test.mjs:56-272`）。
- D1 对手机端零影响，且中继/host/e2e 没有任何一处隐含"中继见过 psk"（逐处核过：`mp/core/client.js:102,257`、`relay-client.ts:56,185-221,261-270`、`live-e2e.mjs:159`、`multi-pair.test.mjs:105`、新 `state.ts:45-50`）。
- D5 的 `hello-ok{role}` 对小程序不可见（`mp/core/client.js:253-255` 只读 `clientId`）。
- T8 事实成立（`mp/` 无硬编码域名，`session-store.js:13,93-99`，`pair.js:247` 只校验 `^wss?://`）。
- fixtures + mp 现跑两层都能在 CI（无微信运行时）跑（`e2e/mp-sim.mjs` 用 `createRequire` 加载真身）。
- 结构性零知识这一环比设计更强：产物级断言（`apps/server/tsup.config.ts:16-20` + `tests/bundle.test.mjs`）。
- 阶段 B 的 `state.ts` 已经写对的两条最难的东西：client close 的 socket 守卫（`state.ts:255-258`，旧实现缺失）
  与"客户端离开绝不向其它客户端发 `peer-left`"（`state.ts:250-253` 注释 + `server.ts:374-376` 的落点）——
  但后者还需要 §7-B 的一条负向用例才算被锁住（F5/§9-8 红线）。

### 总判

**不能直接按这份 DESIGN 开工实现中继；但阶段 B 的骨架可以继续写。**
最先必须补的是 **R1**：D3 的续用承诺在"host 重启"这一条最常见的路径上会变成**没有出口的静默黑洞**，
而它恰好是这次重写唯一的产品级卖点（回前台不再重新扫码）；
`unknown_session` 由中继产生、密钥在 host 手里，这句话必须变成一条协议级机制（host 用 `session-leave` 作废会话 + 中继据此发 `peer-left`），
**并补一条"host 重启续用取证"**——现在 §7-D⑤ 只测中继重启，测不到它。
次高优先：R2/R3（同一族：成员丢失后的恢复出口与顶号）与 R4/R5（"零破坏"承诺在部署面的两处破口）。

## 7. 复核补遗（第二人独立复核：对上文的两处更正 + 五条未覆盖项）

### 7.1 更正（阶段 B 的测试已经补上，R7/§1 的两条 🔴 现在是过判）

- **F12（enc-batch）已绿**：`apps/server/tests/relay.test.mjs:383`「批量帧：enc-batch 下行保持条目顺序与密文原样」→ 本文 §1 若把 F12 列为"只有文档"，应降级；但**§7-B① 的验收文字里仍没有 F12**（DESIGN:268 全文不提批量帧），所以"写进验收表"这个动作仍然要做。
- **F13（seq 不得校验单调）已绿**：`relay.test.mjs:287-289`（上行 seq 41 原样透传）+ `relay.test.mjs:305-317`（terminate → 重连 → 同一 convId 上 `seq:1` 必须直达主机、下行也要重新挂得上）正好是我原先要的"活会话 + 回退 seq"负例 → **撤销**。
- **§2.2① 的客户端 socket 守卫也已修**：`apps/server/src/state.ts:255-258` 的 `clientGone(clientId, ws)` 先做 `this.clients.get(clientId)?.ws !== ws` 竞态守卫，且注释明确"不许因此向其它客户端发 `peer-left`"（`:250-253`）→ 该项从 🔴 降为"已实现，缺 §7-B 负向用例锁住"。

### 7.2 未覆盖项（5 条，都带可核对锚点）

| # | 项 | 证据 | 建议 |
|---|---|---|---|
| N1 | **F5（host 掉线必发 `peer-left`）在 §7 B② 的"加固 10 项"里仍无点名**，而 §5.2 不变量 5 声称逐条有测试；旧测有这条（`apps/server/tests/hardening.test.mjs:162`），阶段 0 后会消失 | `docs/DESIGN.md:177,268`；`docs/legacy-spec/mp-client-contract.md:263-264` | B② 增列"host close → 该会话全部 client 收到 `peer-left`，且会话被删"，并保留 `relay.test.mjs:305-309` 那种"客户端 close 不得误发"的对偶断言 |
| N2 | **订阅守卫继承黑名单，而取证结论是"必须改白名单"**：13 项黑名单缺 `approval/request`、`llm/stream`、`system-prompt/assemble`、`tools/pre-execute`/`execute`/`post-execute`/`code-dispatch-log`、`internal/config`、`internal/update`；失守代价是内核每个 turn 崩 | `docs/legacy-spec/host-plugin-cordis.md:40-46,112-127`；`docs/DESIGN.md:200,269`（`guard.ts` 与 C② 仍是黑名单口径，且依据写成未定义的"P1"） | `platform/guard.ts` 改为"只允许订阅列举过的 emit-mode 事件，其余一律拒订并告警"；C② 同时继承旧实现的**自校验**（`packages/plugin/tests/listing.test.ts:299-300`：黑名单/白名单本身必须非空且含已知项），否则 §7.1 的"禁止空判定"会被这条绕过 |
| N3 | **§8 把 D1 的兼容方向写反**：旧 host + 新中继其实**兼容**（新 `pairBeginFrame` 无 `psk` 字段，zod 默认 strip 掉多余键，`packages/protocol/src/frames.ts:72-76`）；真正硬失败的是**新 host + 旧中继**（旧 `main.mjs:279` 要求 `typeof psk==='string' && psk.length>=16`，缺字段即 `bad_pair`） | `docs/DESIGN.md:314`；`apps/server/src/main.mjs:279`；`packages/plugin/src/relay-client.ts:279` | §8 的回滚单位改成"中继产物 + 插件产物**成对**回滚"；§7 E④ 的回滚验证必须做一次真配对，而不是只 `curl /healthz` |
| N4 | **阶段 0 的"清场"事实上没做，但 A/B 已开工**：旧 `apps/server/src/main.mjs`（19 KB）与新 `main.ts/server.ts/state.ts` 并存、旧 `packages/plugin/src/` 整套仍在、`pnpm -r test` 里旧 server 测试与新测试混跑 | `docs/DESIGN.md:266`（阶段 0 判据原文"不允许有'以后再删'的旧文件残留"） | 按原判据补做清除（旧实现只需留在 `git show b026d63:<path>`，DESIGN:13 已约定这种方式），否则"不复用任何一行"在事后**无法证明**，且 §7.1 的"全绿"含义被旧测试污染 |
| N5 | **`tsup` 是 §6 里唯一没有任何实测支撑、却已被两个包采用的选型**：`legacy-spec/open-source-options.md` §A/§C/§E 逐项实测了 ws/zod/valibot/qrcode/pino/tweetnacl/@noble/libsodium/uWS/rate-limiter，唯独没有 tsup/esbuild；它替代的只是 60 行的 `scripts/bundle-protocol.mjs`（`docs/DESIGN.md:211` 自称理由仅是 `file:` 解析不了 `workspace:*`）。它带进来的链（`cac`/`chokidar`/`bundle-require`/`tree-kill`/`resolve-from`，**未核实**）比被它替掉的脚本重，而 §6 标题的原则恰是"不为此多引一个传递依赖链" | `docs/DESIGN.md:241,249`；`apps/server/package.json`（devDep 有 tsup）、`apps/server/tsup.config.ts`；`packages/protocol/package.json` 的 build 却用 tsc | 要么按 §A.5.3 的规格补一次闭包实测并写进 §6，要么改成 `esbuild` + `tsc --noEmit`（顺带解掉 §3.3 的"esbuild 不做类型检查 → build 绿 ≠ 类型正确"）；同时说明"protocol 用 tsc、server 用 tsc+tsup、plugin 待定"是有意还是遗漏 |

### 7.3 补遗后的优先级

上文的 R1（host 重启 → 永久静默）仍是第一。补遗里 **N2（黑名单）**与 **N4（阶段 0 未清场）**要并列进"开工前必须动"：
前者是"全绿也能把内核搞崩"的唯一剩余路径，后者是"零复用"这条用户硬指令**目前唯一无法举证**的地方。
