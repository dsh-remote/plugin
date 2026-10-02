# DSH 手机远控 · 遗留系统规格：host 侧运行时行为（plugin runtime）

> 范围：仅 host 侧（浏览器 / Node / Cordis 宿主内的插件运行时）行为契约。
> 不含：cordis 挂接细节、打包与安装流程（另有文档）。
> 线格式与中继协议见 `docs/legacy-spec/relay-and-wireformat.md`；小程序侧契约见 `docs/legacy-spec/mp-client-contract.md`。本文不重复其内容，只标注交叉引用点。
> 证据基线提交：`b026d63`。证据格式 `（证据：文件:行号）`。无代码支撑的判断显式标注「推断：」。

## 1. 会话簿记与生命周期

### 1.1 会话表结构与键

host 侧的"会话"是**每条已配对客户端连接**一条记录，与 DSH 内核里的 harness session（`ses_xxx`）**不是同一命名空间**，两者仅在 `cmd.*` payload 的 `sessionId` 字段上间接重合（证据：bridge.ts:50、relay-client.ts:297-299 `pairedClients` 只暴露 `sessionId`）。

表本体：`conversations: Map<string, Conversation>`（证据：relay-client.ts:46）。

| 字段 | 类型 | 语义 | 证据 |
|---|---|---|---|
| key | `string` | 中继分配的 conversation id（`peer-joined.sessionId`），不是 DSH 会话 id | relay-client.ts:216 |
| `sessionId` | `string` | 与 key 同值的冗余字段（便于日志/回传） | relay-client.ts:37, 217 |
| `kC2H` | `Uint8Array` | 方向密钥：client→host，host 用它**解密** | relay-client.ts:39, 218 |
| `kH2C` | `Uint8Array` | 方向密钥：host→client，host 用它**加密** | relay-client.ts:40, 219 |
| `seq` | `number` | 出站计数器，建会话时置 0 | relay-client.ts:41, 220 |

密钥由 `derivePskKey(psk, direction, sessionId)` 派生：**方向分离**（同一 PSK 得到两把不同密钥，客户端不能拿 host 的发送密钥反过来解 host 的明文）+ **以 sessionId 做上下文绑定**（同一 PSK 在不同 conversation 下密钥不同）。证据：relay-client.ts:218-219。派生细节属 `relay-and-wireformat.md` §2.3，此处不重复。

`seq` 只对**出站**递增：`sendPayload` 每发一帧 `seq: ++conv.seq`（证据：relay-client.ts:288）。**入站不校验 seq**：`enc` 分支只 `open()` 解密，不比对序号、不检查单调性、不做防重放（证据：relay-client.ts:228-237）。推断：`seq` 是给人看/给对端排障用的诊断字段，不承担协议语义；因此新实现若只把它当日志序号是安全的，但一旦要引入防重放就必须同时改两端。

### 1.2 创建时机（`peer-joined` → 按 pairingToken 取 PSK）

创建只发生在收到 `peer-joined` 帧时（证据：relay-client.ts:179-223），路径是三段判定：

1. **按 token 精确取 PSK**：读 `f.pairingToken`，在 `pendingPairs` 里查该 token 的记录，且**只有 `expiresAt >= Date.now()` 才算有效**；无论命中与否，**立即 `pendingPairs.delete(usedToken)`——配对码一次性消费**。证据：relay-client.ts:186-191。
2. **降级兜底（针对不回显 token 的老中继）**：倒序遍历 `pendingPairs`，取第一个未过期的记录，删除它并打日志 `peer-joined without a matching token; using the newest pending PSK`。证据：relay-client.ts:192-205。这是"能连通优先于精确"的取舍——选错 PSK 的代价是对端全部解不开且无提示（见下条注释）。
3. **无 PSK 即拒绝建会话**：写 `lastPairProblem`（含 `token=`、`pending=` 两个诊断量，并明说"客户端将解不开任何东西"），打日志 `peer-joined without pending pair — dropping`，**直接 return，既不建 conversation 也不回调 `onPeerJoined`**。证据：relay-client.ts:206-214。

`pendingPairs` 之所以是**表而不是单槽**，源码注释给的理由是：自动发布的码与手动 `/drc pair`（或两次 `/drc pair`）可以同时在途；"取最新的那个"会产生客户端复现不出的密钥，之后每条 payload 解密失败且无明确原因。证据：relay-client.ts:47-56。这条同时是第 3 段"loud, not silent"设计的动机（证据：relay-client.ts:207）。

**为什么不能只看 `lastPairProblem` 判活**：它只在成功建会话后才被清 null（证据：relay-client.ts:215），且它被 `HostRuntime.state.relayProblem` 透出到状态面（证据：host-runtime.ts:326-328），因为"掉线"与"配上了但死了"在手机端看起来完全一样（证据：host-runtime.ts:327-329 注释）。

建会话成功后才 `opts.onPeerJoined?.(f.sessionId, f.clientId)`（证据：relay-client.ts:222）。host-runtime 在该回调里做的三件事：记日志、`markActivity('peer-joined')` 持锁、推一次会话列表 + 单独回一条 `ev.keep_awake_state`。证据：host-runtime.ts:67-73。注意 `pushSessions` 是 `void` 不 await，而 `keepAwakeStateEvent()` 是同步发（证据：host-runtime.ts:71-72）。

### 1.3 销毁时机：`peer-left` **确实删会话**

**结论（事实）**：`peer-left` 分支就是 `if (this.conversations.delete(f.sessionId)) this.opts.onPeerLeft?.(f.sessionId, f.clientId)`（证据：relay-client.ts:225-226）。**host 侧在 peer-left 时无条件删除该 conversation**，密钥与 seq 一起消失；`onPeerLeft` 回调只在真的删掉了一条记录时才触发（`delete` 返回 true 才调用），因此 host-runtime 里 `onPeerLeft` 只打一行日志（证据：host-runtime.ts:74）不是"会话还在"，而是"已经没了，没什么可清理"。

**后果（逐条可核对）**：

1. **该客户端的出站事件全部静默丢弃**。`sendPayload` 首行 `const conv = this.conversations.get(sessionId); if (!conv || ws.readyState !== OPEN) return false`（证据：relay-client.ts:284-286）。调用方几乎都不看返回值：`host-runtime.ts:72`、`host-runtime.ts:176`、`host-runtime.ts:269-270`、`host-runtime.ts:275`、`host-runtime.ts:294`、`host-runtime.ts:308`、`bridge` 回执路径都忽略 false。所以"客户端已走"与"事件已发出"在 host 侧不可区分，且没有缓冲、没有补发、没有错误上抛。
2. **入站 `enc` 帧也静默丢弃**：`if (!conv) return`，连日志都没有（证据：relay-client.ts:229-230）。推断：如果中继在服务端仍保留 session 并转发，会出现"手机发了命令、host 收了但什么都没发生"的现象，排查只能靠 `relayProblem` / status.json，因为这里没留痕。
3. **emitTo 的定向集合会随之收敛**：`emitTo` 用 `relay.pairedClients` 过滤（证据：host-runtime.ts:170），conversation 删掉后同一 sessionId 变成"无人订阅"，于是走 `broadcast`（见 §3.7）。推断：删会话这个动作会**改变事件的可见范围**——原来只发给这一位客户端的事件，现在会广播给所有其他客户端，这是隐私面必须注意的副作用。
4. **重连不复活**：`auth-ok` 只 `connectionGeneration++`，不恢复任何 conversation（证据：relay-client.ts:156-162）。`stop()` 也整表清空 `conversations.clear()`（证据：relay-client.ts:89）。所以**同一客户端要再说话，必须重新扫一个新生成的配对码**：旧配对码在 peer-joined 时已被单用消费（证据：relay-client.ts:190），PSK 不再存在，密钥无法复现；即使 PSK 还在内存里，中继侧的 session 也已经换。
5. **未 flush 的 delta 缓冲不受影响**：`deltaBuf` 以 **sessionId（此处是 forward 事件的 sessionId，即 DSH 会话 id）** 为键，与 conversations 是两套键空间（证据：host-runtime.ts:51, 183、relay-client.ts:46）。推断：peer-left 之后缓冲里的文本照旧会 flush，只是发不出去（返回值 false 被吞）。

**否决项/易踩坑**：不要以为"peer-left 只是标记不活跃"。源码事实是**即刻销毁 + 无缓冲**。新实现如果要支持"手机切后台再回来继续"，需要显式设计（保留 conversation 一段时间 / 支持密钥恢复），这在旧实现里不存在。

### 1.4 `connectionGeneration` 的用途

- **写入**：每次 `auth-ok` 自增一次（证据：relay-client.ts:61-66, 157）。注释点明场景：**中继重启会清空它自己的 pending-pair 表，因此我们在重启前发布的配对码全部作废**；调用方靠这个值判断"我发布的码需要重新发"。
- **读出**：`HostRuntime.relayGeneration` 是纯代理 getter（证据：host-runtime.ts:141-145）。它在 host-runtime 内部不参与任何判断，只对外暴露，由配对码刷新循环消费（见 §6.2）。
- **不变量**：generation 变**不清空** `pendingPairs`（证据：relay-client.ts:56 定义、sweep 仅在 createPairing 里调用 relay-client.ts:264）。推断：后果是 host 手里攥着一批中继已不认识的 PSK，这些码会一直挂在表里直到本地 `expiresAt` 过期。这正是 §6.2 刷新判据必须包含"generation 变了"的原因——不刷新就会一直展示一个永远配不上的码。
- 与之配对的另一个跨重连字段是 `lastPairTtlMs`（中继权威 TTL，证据：relay-client.ts:57-58、172-176）和 `lastPairProblem`（证据：relay-client.ts:59-60）。三者都是"public 可变字段 + 代理 getter"的老式暴露方式。推断：新实现里它们共同构成"认证代次 + 发布码健康度"一个聚合体，不该拆成三处。

## 2. cmd 分发与幂等

### 2.1 入口与异常面

入站 payload 从 `RelayClient.onFrame` 的 `enc` 分支解出后，同步调用 `opts.onPayload(sessionId, clientId ?? '', payload)`（证据：relay-client.ts:228-237）。host-runtime 在构造 RelayClient 时给出的包装是**唯一的安全网**：

```
onPayload: (sessionId, _clientId, payload) =>
  this.onPayload(sessionId, payload).catch((e) => this.say('payload handler failed', e))
```

（证据：host-runtime.ts:64-66）源码注释写明了理由：**在 DSH 进程里绝不能 `void` 一个 async handler 而不接 catch**——逃逸的 rejection 比一条日志严重得多（证据：host-runtime.ts:62-63）。这条是宿主共存约束（cordis 插件跑在用户内核进程里），新实现 MUST 保留同等保护（`.catch` 或者等价的 unhandledRejection 兜底）。

clientId 被显式忽略（`_clientId`，证据：host-runtime.ts:64）：host 侧路由**只认 sessionId**（中继 conversation id），不区分同一 conversation 里的具体客户端。

### 2.2 分发矩阵

`cmd.keep_awake` **不走 bridge**，在 host-runtime 内就地处理并 `return`（证据：host-runtime.ts:261-272）。其余全部交给纯函数 `handlePayload(bridge, payload)`（证据：host-runtime.ts:274、bridge.ts:40-71）。

| cmd | host 侧动作 | 回执 | 证据 |
|---|---|---|---|
| `cmd.keep_awake` | `enabled` 为真：可选 `setIdleRelease(idleReleaseSec*1000)` → `enable()` → `markActive()`；为假：`disable('client')` | **两条**：`ev.result{cmdId, ok:true}`（无 message）+ 紧跟一条 `ev.keep_awake_state` | host-runtime.ts:261-271 |
| `cmd.list_sessions` | `bridge.listSessions()` | `ev.result{cmdId, ok:true, data:{sessions}}` | bridge.ts:45-48 |
| `cmd.send_prompt` | `bridge.sendPrompt(sessionId, text)` | `ev.result{cmdId, ok:r.ok, message:r.message}`；随后 `await pushSessions(sessionId)` | bridge.ts:49-52、host-runtime.ts:277-279 |
| `cmd.answer` | `bridge.answer(sessionId, requestId, answers)` | 同上（含 `pushSessions`） | bridge.ts:53-56、host-runtime.ts:277-279 |
| `cmd.resolve_permission` | `bridge.resolvePermission(sessionId, requestId, decision, note)` | 同上（含 `pushSessions`） | bridge.ts:57-60、host-runtime.ts:277-279 |
| `cmd.interrupt` | `bridge.interrupt(sessionId)` | 同上（含 `pushSessions`） | bridge.ts:61-64、host-runtime.ts:277-279 |
| `cmd.subscribe` | **什么都不做**（无订阅表） | `ev.result{cmdId, ok:true}` | bridge.ts:65-69 |
| 其他 / 未知 `t` | 无 | **无回执**（返回 null，`if (result)` 才发） | bridge.ts:66-70、host-runtime.ts:275 |

三个必须点名的语义事实：

1. **`cmd.subscribe` 是纯确认，不改变路由**。`emitTo` 从不查任何订阅集合，只查 `relay.pairedClients`（证据：host-runtime.ts:168-180）。客户端**不能**假设"订阅之后就只收到这个会话的事件"或"没订阅就收不到"——事实是凡是已配对的 conversation 都会收到定向/广播事件。推断：这是历史遗留的协议占位，重写时若要真正实现订阅语义，属于**行为变更**，要连客户端一起改。
2. **`cmd.list_sessions` 的返回走 `ev.result.data.sessions`，而主动推送走 `ev.session_changed`**（对比 bridge.ts:47 与 host-runtime.ts:294、308）。两条路径字段名不同，客户端必须都处理。
3. **业务失败不是异常**：bridge 返回 `{ok:false, message}` 时照样发正常回执，`ok:false` 携带 message（证据：bridge.ts:51-63）。因此 `ok:false` 有两种来源——bridge 的业务拒绝（有具体 message）与 host 抛异常（`String(e.message ?? e)`，证据：host-runtime.ts:282-288）。推断：客户端文案层不能把 `ok:false` 一律渲染成"网络/系统错误"。

### 2.3 `ev.result` 的 cmdId 匹配义务与异常兜底

- 所有回执都是 `t:'ev.result'` + **原样回显 `payload.cmdId`**（证据：bridge.ts:47-63 五处、host-runtime.ts:269）。
- **异常兜底**：`catch` 里发的回执 `cmdId: (payload as {cmdId?:string}).cmdId ?? ''`、`ok:false`、`message: String(e?.message ?? e)`（证据：host-runtime.ts:282-288）。`cmdId:''` 只在 payload 结构不完整（没有 cmdId 字段）时出现。因此**客户端的匹配器必须把 `''` 当作"不属于我"**，否则一条畸形兜底会误清某个正在等待的 UI 状态。小程序侧的匹配实现细节见 `mp-client-contract.md` §5.4，此处不重复。
- **兜底的两个漏洞（事实）**：
  1. `cmd.keep_awake` 的处理在 `try` **之外**（证据：host-runtime.ts:261-272 位于 273 的 `try` 之前）。若 `setIdleRelease` / `enable` / `markActive` / `sendPayload` 中任一个抛出，只会被 §2.1 的外层 `.catch` 记成日志，**客户端收不到任何回执**，会等到自己超时。
  2. 未知 cmd 完全没有回执（§2.2 第 3 行）。推断：新实现要么对未知 cmd 也回 `ok:false`+具体 message（"host 不支持该命令"），要么明确要求客户端为每条 cmd 设超时；旧实现两者都没做。
- **一次请求可能收到多条 `ev.result`**：`cmd.keep_awake` 本身就是 1 回执 + 1 状态事件（证据：host-runtime.ts:269-270）；另外 mock bridge 的 `answer()` 会额外广播一条 `ev.result{cmdId:'srv', ok:true, data:{answered, answers}}`（证据：adapter-mock.ts:69）。`'srv'` 不是任何客户端发出去的 cmdId。推断：客户端 cmdId 匹配器必须是"按 id 查表、查不到就丢弃"，绝不能"收到 ev.result 就清掉当前 pending 提示"。

### 2.4 "可重复、可乱序到达"对 handler 的要求

事实基础：**host 侧没有任何幂等机制**——没有 cmdId 去重表、不校验入站 `seq`、不检查 `enc` 帧的重放（证据：relay-client.ts:228-237 只解密不比对；全仓 `cmdId` 在 host 侧仅出现在透传位置，证据：host-runtime.ts:269、284，bridge.ts:47-68）。每条 `enc` 帧各自起一次 async 分发，**并发/交错是常态**（证据：relay-client.ts:236 同步 fire 一个 `.catch` 包装的 async）。

由此对 handler 提出的硬要求（旧实现是靠"handler 本身近似幂等"蒙过去的）：

- `cmd.send_prompt` 重复到达 = **再跑一次 run**（bridge 只负责把 prompt 注进去，证据：bridge.ts:49-52）。旧实现不判重，所以一旦客户端重发（例如回前台补发）就会重复执行。推断：新实现要么在客户端侧禁止重发未确认的写命令，要么在 host 侧引入 cmdId 短窗去重。
- `cmd.resolve_permission` / `cmd.answer` 天然要求"一次性"：**以 requestId 为准而不是以"最后一条命令"为准**。bridge 契约里这两个都要传 `requestId`（证据：bridge.ts:30-32），real adapter 需要自己保证未知/已消费的 requestId 返回 `ok:false`。旧 mock 就是这么做的（`pendingPermissions.get(requestId)` 不存在或 sessionId 不匹配 → `unknown permission request`，证据：adapter-mock.ts:73-76；question 同理 65-68）。**这条 mock 行为就是契约**：迟到/重复的审批必须被拒而不是被静默接受。
- `cmd.interrupt` 重复应当无害（幂等终态），mock 的实现是无条件把 state 写成 `idle`（证据：adapter-mock.ts:91-96）。
- 乱序的可观测后果：`cmd.send_prompt`（后发）与 `cmd.interrupt`（先发）交错时，host 无法判定先后，只有 `seq` 但没人用（§1.1）。推断：任何依赖"我最后点的按钮生效"的 UI 逻辑都不可靠，客户端必须以 host 推来的 `ev.run_state` 为唯一真相。
- **状态刷新只回给请求方**：`pushSessions(sessionId)` 只发给触发写命令的那个客户端（证据：host-runtime.ts:277-279、291-298），其他已配对客户端只能等 15s 全量刷新（证据：host-runtime.ts:102-104）。多客户端观察同一 DSH 会话时列表会短时不一致，这是已知行为而非 bug。

## 3. 事件窗口化 / 背压

### 3.1 为什么要合并（设计意图，源码自带）

一个繁忙的 turn 会吐成百上千个极小的 delta；**每个 delta 单独一帧密文**的后果被源码写得很直白：手机 UI 卡顿，并且路径上每一个缓冲区都在长。在一个短窗口内合并，把帧率压到 **约 8 帧/秒，与模型出字速度无关**；上限的存在保证"卡住的或病态的流"不可能无界增长（证据：host-runtime.ts:11-17、150-155）。HANDOFF 把这条列为"防卡顿/内存泄漏"的既成事实并点名了三个数字（证据：HANDOFF.md:123-127）。

### 3.2 三个参数的取值与依据

| 常量 | 值 | 依据 | 证据 |
|---|---|---|---|
| `DELTA_FLUSH_MS` | `120` | 1000/120 ≈ 8.3 帧/秒，即注释里的"~8 frames/second"。这是**延迟与帧数的唯一权衡点**：手机聊天页自己还有 100ms 的二级合并（证据：HANDOFF.md:128），两级相加约 220ms 的首字延迟，人眼仍认为"在流" | host-runtime.ts:18 |
| `MAX_DELTA_CHARS` | `4096` | 提前 flush 的长度阈值，保证单帧不过大（加密/传输/小程序 setData 都吃这个数）。**单位是 JS 字符（UTF-16 码元），不是字节**：`entry.text.length >= MAX_DELTA_CHARS`（证据：host-runtime.ts:205）。中文按 3 字节 UTF-8 算，密文帧最大可达 ~12KB+。HANDOFF 写作"4KB"是不严谨的简称（证据：HANDOFF.md:125） | host-runtime.ts:19 |
| `MAX_DELTA_SESSIONS` | `32` | 同时在途缓冲的会话数上限，防无界内存（注释："hard cap ... never grow without bound"） | host-runtime.ts:20、190-191 |

缓冲结构：`deltaBuf: Map<sessionId, DeltaEntry>`，`DeltaEntry = { text, messageId, part, done, timer }`（证据：host-runtime.ts:22-28、51）。**键是 DSH 会话 id**（来自 `ev.sessionId`，证据：host-runtime.ts:183），与 §1.1 的中继 conversation id 是两个命名空间（证据：HANDOFF.md:109-110）。

### 3.3 合并语义（每个字段怎么被合）

`bufferDelta`（证据：host-runtime.ts:182-210）：

- **命中已有条目**：`text += ev.delta`（**保序串接**，测试直接断言 `'段0段1段2'`，证据：windowing.test.ts:79）；`part = ev.part`（**覆盖成最新 part**，合并帧只报最后一个 part，中间 part 号丢失）；`done = cur.done || ev.done === true`（**sticky-OR：终态标记一旦置上不会被后面的帧冲掉**，证据：host-runtime.ts:188，测试断言 done 必须活过合并，证据：windowing.test.ts:92）。
- **`messageId` 不更新**：只在**建条目**时写入（证据：host-runtime.ts:196），合并分支（185-188）不碰它。后果：**若内核在一个窗口内换了 messageId，合并出去的文本会挂在第一个 id 上**。推断：这是旧实现的一个真实隐患，新实现要么在换 id 时先 flush，要么在合并分支检测 id 变化并立刻 flush——不能保持现状还宣称"合并无损"。
- **新建条目前的容量保护**：`if (deltaBuf.size >= 32) flushDelta(第一个键)`（证据：host-runtime.ts:191-194）。注意是 **flush（发出去），不是 drop**：淘汰最旧会话=把它的最旧窗口提前结束，文本不丢，只丢延迟。`Map` 的迭代序=插入序，所以"最旧"是"最早开始缓冲的那个会话"。

### 3.4 何时 flush（四条触发路径）

1. **收到 `done`**：`if (ev.done === true) return this.flushDelta(key)`（证据：host-runtime.ts:204）——终态标记必须立刻出去，不能等窗口。
2. **长度到顶**：`if (entry.text.length >= 4096) return this.flushDelta(key)`（证据：host-runtime.ts:205）——不等定时器。
3. **窗口到期**：`entry.timer === null` 时才 `setTimeout(flush, 120)` 并 `unref`（证据：host-runtime.ts:206-209）。**关键含义：定时器只在窗口第一个 delta 上装填，后续 delta 不续期**，所以任何字符的最坏出站延迟就是 120ms（从该窗口首字算起），不会被持续的流"喂"成永不发送。
4. **显式全量 flush**：`flushAllDeltas()` 遍历键的快照逐个 flush（证据：host-runtime.ts:231-234），唯一调用点是 `stop()` 的第一步（证据：host-runtime.ts:109，见 §5.6）。注释说"on stop / before a run-state change"，但"run-state change"那条路走的是 §3.6 的**单会话** flush，全量版只服务 stop。

定时器全部 `unref`（证据：host-runtime.ts:105、208、241）：宿主是用户的内核进程，插件不能让它赖着不退。

### 3.5 `flushDelta` 为什么不能丢空文本的 done 帧

判据表达式（这就是要保的那行代码的语义）：

```
if (!entry.text && !entry.done) return      // 只有"既无文本又非终态"才是噪声
```

（证据：host-runtime.ts:220）源码注释给出理由：**只带 done 的帧没有任何文本，但它不是空消息——它是"这一轮跑完了"的唯一信号；丢掉它手机会永远转圈**（证据：host-runtime.ts:217-219）。

- 历史事实：`flushDelta` 曾经以 `if (!entry.text) return` 开头，于是内核 `turn/end` 产生的那个空文本 done 帧被静默丢弃；**手机永远学不到 run 已经结束**，这个 bug 只在真实内核上出现，用 mock 永远测不出来（证据：windowing.test.ts:97-100）。
- 手机端具体表现：run 状态卡在 running / 输入框永久禁用 / 思考动画不停，直到下一次 `ev.run_state` 或用户手动 interrupt。客户端侧对应的 UI 逻辑见 `mp-client-contract.md` §2.3。
- 回归护栏：`windowing.test.ts:96-113`——先让一帧带文本的 delta 单独出去（等 260ms 越过窗口），再发 `delta('', true)`，断言**总帧数 2**、第二帧 `delta === ''` 且 `done === true`。这条断言是"必须保留独立 done 帧"的可执行契约。
- 反例（同一测试第 83-94 行）：done 与文本仍在同一窗口内时**必须合并**，只出 1 帧且 `done:true` 附着在带文本的帧上（证据：windowing.test.ts:83-94）。所以判据既不能写成 `if (!text) return`，也不能写成"done 一定另发一帧"。
- 该 done-only 帧的真实生产者：适配器在 `turn/end` 上先发 `{t:'ev.message_delta', messageId:'turn', part:0, delta:'', done:true}`，紧接着 `ev.run_state{id}`，注释"close the message, then the run — order matters for the phone UI"（证据：adapter-dsh.ts:962-967）。推断：`messageId:'turn'` 是合成值，不是真实消息 id，客户端不得拿它去索引消息表。

### 3.6 非 delta 事件为什么必须先 flush 同会话缓冲

`forward()` 的顺序是：先 `markActivityFor(ev)`（§4），`ev.message_delta` 走 `bufferDelta` 并 **return**；其余任何事件，若 `ev.sessionId` 存在，**先 `flushDelta(ev.sessionId)`，再 `emitTo(ev)`**（证据：host-runtime.ts:156-166）。注释写明意图："Anything else ends or describes the turn: flush first so ordering holds."（证据：host-runtime.ts:163）

WHY：缓冲里的文本比即将发出的 `ev.tool_event` / `ev.run_state` / `ev.permission_request` **更早产生**。不先 flush 的话，事件帧会插到还没发出去的文本前面，手机端就会出现"先看到工具调用、后看到调用前的说明文字"这种错乱。回归护栏：`windowing.test.ts:115-127`，序列 `delta('前半') → tool_event → delta('后半')` 断言出站类型序列严格是 `[message_delta, tool_event, message_delta]`，且文本分别是"前半""后半"（证据：windowing.test.ts:122-125）。

只 flush **同 sessionId** 的缓冲（不是全量），因此多会话并行时各自的窗口互不干扰（证据：host-runtime.ts:164）。注意 `'sessionId' in ev && ev.sessionId` 的双条件：无 sessionId 的事件不触发任何 flush（证据：host-runtime.ts:164）。

### 3.7 路由与"无人订阅时降级广播"

`emitTo(ev)`（证据：host-runtime.ts:168-180）：

- 有 sessionId：`targets = relay.pairedClients.filter(c => c.sessionId === ev.sessionId)`；`targets.length === 0` → 注释"events for sessions nobody follows yet: fan out to all clients" → `relay.broadcast(ev)`；否则逐个 `sendPayload`；无 sessionId → 直接 `broadcast`。
- **必须记录的事实：定向分支在真实链路上永不命中。** `pairedClients[].sessionId` 是**中继 conversation id**，格式 `c_<hex>`（证据：relay-client.ts:297-299 由 conversations 键映射、apps/server/src/main.mjs:326），而 `ev.sessionId` 是 **DSH 会话 id**（`ses_xxx`，证据：adapter-mock.ts:17、listing.test.ts:238、HANDOFF.md:109-110 明确"别混"）。两者不可能相等 ⇒ 过滤恒空 ⇒ **所有带 sessionId 的事件实际都走 broadcast**。
  - 后果 A（功能上无害）：单客户端（最常见形态）下 broadcast 与定向等价，所以这个 bug 长期不可见。
  - 后果 B（安全面）：**多客户端并存时，任何一个已配对手机都会收到全部 DSH 会话的明文事件**，包括它从没打开过的会话。推断：新实现若要按会话隔离，必须显式引入"conversation ↔ DSH 会话"的订阅关系，并同时改客户端；直接复用旧 `emitTo` 等于把"其实一直在广播"这个既成事实固化。
- `broadcast` 的实现就是遍历 conversations 逐个 `sendPayload`（证据：relay-client.ts:292-295），因此**广播同样受 §5.3 的静默丢弃影响**，且从不产生"有多少人在听"的反馈。

### 3.8 全量状态推送的义务

- **15s 定时全量刷新**：`start()` 里 `setInterval(() => pushSessionsToAll(), 15_000)`，注释"periodic session refresh (cheap; bridge may be mock)"，并 `unref`（证据：host-runtime.ts:101-105）。`pushSessionsToAll`：无客户端就直接 return（不白打 bridge）；`listSessions()` **失败就静默返回，不广播**（证据：host-runtime.ts:300-308）。推断：不广播空列表是刻意的——bridge 抖动一次就把手机上的会话列表清成空白，比"这一轮没更新"糟得多。这也是 `state.sessions` 数字可能陈旧的来源（证据：host-runtime.ts:317）。
- **状态变更后必须立即推送**：`cmd.send_prompt` / `cmd.resolve_permission` / `cmd.answer` / `cmd.interrupt` 成功分发后要 `await pushSessions(sessionId)`，只推给请求方（证据：host-runtime.ts:277-279、291-298）。这条义务的依据是 §5.3——事件不补发，所以客户端看到的唯一"新状态"要么来自即时快照、要么最多等 15 秒。
- `peer-joined` 时也立刻推一次列表 + 一条 `ev.keep_awake_state`（证据：host-runtime.ts:67-73）：新客户端一连上就要有内容可渲染，不能等定时刷新。
- `sessionsCache` 由两条推送路径共同覆写（证据：host-runtime.ts:293、304），没有并发保护。推断：两条路径同时跑时"最后写入者赢"，值都是同一时刻 bridge 的结果，可接受。

## 4. 防休眠策略与实现的分离

### 4.1 分层边界（这是这套设计最值得保留的一条）

- **策略层**在 host-runtime：什么算"活跃"、什么时候要锁、锁要告诉客户端什么（证据：host-runtime.ts:78-85 构造 + 236-252 `markActivityFor` + 256-258 `markActivity` + 132-134 状态事件）。
- **实现层**在 `@dsh-rc/protocol` 的 `KeepAwake`：只认 `markActive() / enable() / disable() / setIdleRelease()` 四个动词，用子进程持锁，完全不知道"会话""审批"是什么（证据：keepawake.ts:34-99、183-241）。
- 平台差异被封在纯函数 `buildKeepAwakeCommand(os, ownerPid, keepDisplay)` 里，注释明写"Pure command builder — unit-testable without spawning"（证据：keepawake.ts:188-193）：
  - darwin：`/usr/bin/caffeinate`，默认 `-i -s`（禁 idle 睡眠 + 禁 AC 系统睡眠），`keepDisplay` 时换成 `-d -i -u disk,display`（**注意：开屏持锁时不再带 `-s`**），两种形态都追加 `-w <pid>`（证据：keepawake.ts:195-201）。
  - **`-w ownerPid` 是最重要的安全网**：断言的生命周期绑到宿主 pid，DSH 进程被 kill -9 / 崩溃时 caffeinate 自己退出，**不会留下孤儿断言把用户笔记本永久叫醒**。这是插件类程序唯一的正确做法，新实现 MUST 保留（Linux 侧无等价物，只能靠 `stop()` 发 SIGTERM，证据：keepawake.ts:165-176、203-214）。
  - linux：`systemd-inhibit --what=idle:sleep --who=dsh-remote-control --why=... --mode=block sleep infinity`（证据：keepawake.ts:203-214）。
  - win32：预留钩子，PowerShell P/Invoke `SetThreadExecutionState`，`keepDisplay` 只多一个 `ES_DISPLAY_REQUIRED` 位；注释标注"disabled by default"（证据：keepawake.ts:8-9、215-216、222-241）。
  - 其他平台：返回 null → `lastFailReason = 'unsupported platform'` 且**不抛**（证据：keepawake.ts:135-139、217-218）。
- 反向解耦：`KeepAwake.publish()` 把 `onStateChange` 回调包在 try 里**吞掉所有监听器异常**（证据：keepawake.ts:124-130）——广播失败绝不能把持锁逻辑带崩。
- 构造器参数与平台细节的规范表述见 `relay-and-wireformat.md` §6，本文只保留"与运行时行为耦合"的部分。

### 4.2 持锁触发条件（策略层的完整真值表）

`markActivityFor(ev)`（证据：host-runtime.ts:236-252），每个从 bridge 出来的事件在 `forward()` 第一行过一遍（证据：host-runtime.ts:157）：

| 事件 | 动作 | 证据 |
|---|---|---|
| `ev.permission_request` / `ev.question_request` | `markActive()` **并且**起一个每 60s 的 `markActive()` 心跳，按 `ev.requestId` 存进 `pendingHolds`（`unref`） | host-runtime.ts:237-242 |
| `ev.run_state` 且 `state === 'running'` | `markActive()`；**其他 state 一律不算活跃** | host-runtime.ts:243-244 |
| `ev.tool_event` | `markActive()`（任何 phase 都算） | host-runtime.ts:245-246 |
| `ev.message_delta` | **不 markActive**（完全依赖 run_state/tool_event 兜住） | host-runtime.ts:236-247 无该分支 |
| 其余（`ev.result`、`ev.session_changed`、`ev.keep_awake_state`、请求类） | 无 | 同上 |
| `peer-joined` | `markActivity('peer-joined')` → `markActive()` | host-runtime.ts:69、256-258 |
| `cmd.keep_awake{enabled:true}` | `markActive()` | host-runtime.ts:265 |

**`markActive()` 的语义是"重新拿锁"而不是"续期"**：`lastActiveAt = Date.now()`，并且 `if (enabled && proc === null) start()` ——也就是说空闲自动释放之后，下一次活动会**重新 spawn 一个 caffeinate**（证据：keepawake.ts:96-99）。所以持锁是"活动驱动 + 空闲超时自放 + 再活动再拿"的循环，注释把设计动机写清楚了：让笔记本在真正闲置时仍然能睡（证据：keepawake.ts:11-13）。

### 4.3 60s 心跳的用途，以及它实际关不掉

- **用途**：审批/提问挂起时进程可能几十分钟没有任何事件流，而 `idleReleaseMs` 默认只有 300s（§4.4）。没有心跳的话，**用户还没决定，笔记本先睡了**，手机上的审批按钮变成一块砖。注释原文："hold the lock while a decision is pending: heartbeat activity"（证据：host-runtime.ts:239-241）。
- **设计的释放路径**：收到 `ev.result` / `ev.run_state` / `ev.tool_event` 且 `requestId in ev` 时 `clearInterval` 并从 `pendingHolds` 删除（证据：host-runtime.ts:248-251）。
- **事实：这条释放路径在真实链路上永不命中。** 类型定义里 `EvResult` 只有 `cmdId`、`EvRunStateChanged` 只有 `state/detail`、`EvToolEvent` 只有 `callId`，**三者都没有 `requestId` 字段**（证据：protocol/src/index.ts:151-160、182-187、196-202）；全仓检索显示真实适配器只在 `ev.permission_request` / `ev.question_request` 上带 `requestId`（证据：adapter-dsh.ts:357、385、464、481），host 侧回执也从不补 `requestId`（证据：bridge.ts:47-68、host-runtime.ts:269、282-288）。代码里的 `(ev as { requestId: string })` 强转本身就承认了这一点（证据：host-runtime.ts:249-250）。
- **后果**：每一次审批/提问都留下一个**永不撤销的 60s 心跳**（`pendingHolds` 无上限、无过期，证据：host-runtime.ts:242、254）。只要防休眠处于 enabled，`lastActiveAt` 会被无限续期 ⇒ §4.4 的空闲自动释放**永远不再触发**，等价于"这台机器一次远程审批过就再也睡不了"。多个请求 ⇒ 多个并行心跳（一个 requestId 一个 interval；同一 requestId 重复请求会**覆盖** Map 里的旧句柄，于是旧 interval 泄漏且再也清不掉）。
- `stop()` 也不清 `pendingHolds`（证据：host-runtime.ts:108-126）。推断：唯一收口是 `keepAwake.disable()` 之后 `markActive()` 不再 spawn（证据：keepawake.ts:96-99 的 `enabled` 前置），以及 `-w` 随进程消亡。**新实现必须把"挂起请求的持锁"做成可释放的**：要么让终态事件带上 requestId，要么把心跳改成"有未决 requestId 时才活"（以 `respondables` 表为准，证据：adapter-dsh.ts:773-798 已经有这张表且已消费即删）。

### 4.4 空闲自动释放

- 参数：`idleReleaseMs = (keepAwakeIdleSec ?? 300) * 1000`（证据：host-runtime.ts:79），KeepAwake 内部默认同为 300_000（证据：keepawake.ts:46）。**`0` 语义是"永不自动释放"**（证据：keepawake.ts:19、113；客户端可用 `idleReleaseSec:0` 表达，见 protocol/src/index.ts:124-125）。
- 机制：`armSweep()` 每 **10s** 扫一次 `Date.now() - lastActiveAt > idleReleaseMs` → `stop()` + `publish()`（证据：keepawake.ts:108-122）。`timer` 只在 `start()` 成功 spawn 之后装填（证据：keepawake.ts:158），`setIdleRelease()` 会先 `clearTimer()` 再 `armSweep()` 让新阈值立刻生效（证据：keepawake.ts:89-93）。
- 因此释放粒度是 10s、最坏误差是"阈值 + 10s"。推断：10s 是"客户端改了 idleReleaseSec 多久生效"与"空转开销"的折中，不是性能约束。
- 失败可观测性：spawn `error`、子进程非 0 `exit`、不支持平台都会写 `lastFailReason` 并 `publish()`（证据：keepawake.ts:142-155、137、160-162）。**但 `disable(reason)` 的 reason 被 `void reason` 丢弃**（证据：keepawake.ts:81-87），所以 `'plugin-stop'` / `'client'` / `'shutdown'` 这三种释放原因（证据：host-runtime.ts:117、267、keepawake.ts:179）**永远不会出现在 `state.reason` 里**——`reason` 只有"拿锁失败"一种含义。客户端 UI 若把它渲染成"因为空闲而释放"是错的。

### 4.5 状态上报：哪些字段进 `ev.keep_awake_state`

`keepAwakeStateEvent()` 是 `{ t: 'ev.keep_awake_state', ...this.keepAwake.state }`（证据：host-runtime.ts:132-134），载荷形状见 `EvKeepAwakeState`（证据：protocol/src/index.ts:188-195）。字段来源逐条（证据：keepawake.ts:50-58）：

| 字段 | 来源 | 坑 |
|---|---|---|
| `enabled` | 私有 `enabled` 标志，`enable()`/`disable()` 改 | 表示"用户/配置允许持锁"，不表示"正在持锁" |
| `active` | **`this.proc !== null`** | 语义是"持锁子进程还活着"，**不是"有会话在跑"**。空闲释放后立刻变 false，即使 5 分钟后有 delta 进来（证据：keepawake.ts:53、96-99）。手机端文案必须按"当前是否正在阻止休眠"理解 |
| `platform` | `node:os.platform()` | 直接透出宿主 OS |
| `backend` | `detectBackend()` 的**静态字符串映射**（caffeinate / systemd-inhibit / SetThreadExecutionState (powershell) / unsupported） | 不探测可执行文件是否存在，所以"有 backend 名字"不等于"能拿到锁"；真失败靠 `reason`（证据：keepawake.ts:60-71、135-139） |
| `reason` | `lastFailReason`，`start()` 每次先清 undefined | 只表达失败，见 §4.4 最后一条 |

发送时机共三类：**(a)** 任何状态变化由 `onStateChange` → `relay.broadcast(...)` 广播给全部客户端（证据：host-runtime.ts:81-83，触发点见 keepawake.ts:78、86、118、145、153、159）；**(b)** `peer-joined` 时定向补一条（证据：host-runtime.ts:72）；**(c)** `cmd.keep_awake` 回执之后再定向补一条（证据：host-runtime.ts:269-270）。推断：(b)(c) 是必需的，因为广播发生在客户端连上之前，只靠 (a) 会让手机显示默认/陈旧开关。没有去重、没有节流——理论上一次抖动里多次 `publish()` 会各发一帧。

配置侧：`keepAwakeEnabled ?? true` ⇒ **默认开**，且 `enable()` 立刻 `markActive()` + `start()`（证据：host-runtime.ts:85、keepawake.ts:73-79）。也就是说"活动驱动"有一个例外：**插件一被构造就无条件先拿一次锁**，在没有任何会话的时候。推断：这是为了消掉"第一条 prompt 到达时才 spawn，头几秒可能已经睡了"的竞态，代价是插件常驻即持锁，只能靠 300s 空闲释放收尾。

## 5. 重连与失败面

### 5.1 退避与握手参数

| 参数 | 值 | 依据/说明 | 证据 |
|---|---|---|---|
| 初始 backoff | `1000` ms | 字段初值 | relay-client.ts:68 |
| backoff 重置点 | ws `open` 事件里 `this.backoff = 1000` | **注意是 TCP/WS 握手成功，不是 `auth-ok`**：中继能接上但鉴权失败时不会退避增长 | relay-client.ts:111-112 |
| 抖动 | `delay = backoff + Math.random()*500` | 上限实际 ~30.5s；防多个 host 同秒重试 | relay-client.ts:135 |
| 指数 | 排期时 `backoff = Math.min(backoff*2, 30_000)` | 先算 delay 再翻倍，所以第一次重连恒为 1.0~1.5s | relay-client.ts:136 |
| 重连去重 | `if (this.closed \|\| this.reconnectTimer) return` | 只有一个待发定时器；error+close 双事件不会排两次 | relay-client.ts:133-134 |
| 定时器不阻塞退出 | `reconnectTimer.unref?.()` | 宿主是 DSH 进程，不能让插件挂住事件循环 | relay-client.ts:141（同类：host-runtime.ts:105、208、241） |
| 握手超时 | `handshakeTimeout: 10_000` | 只覆盖 WS 握手；**握手后无任何超时** | relay-client.ts:105 |
| 建 socket 抛错 | 记日志后 `scheduleReconnect()` | `new WebSocket(url)` 对非法 URL 会同步抛，必须转成重连而不是崩 | relay-client.ts:104-109 |

数值口径与 `relay-and-wireformat.md` §5.8 一致（那边从中继视角写"1s→30s + 0–500ms 抖动 + 10s 握手超时"），参数选择的 WHY 见 §5.1 各行。

**没有心跳**：全文件没有 `ws.ping()` / `setInterval` 保活 / pong 超时判定；`pong` 帧收到只是 `return`（证据：relay-client.ts:239）。推断：半死链路（NAT 静默丢弃、手机切蜂窝）只能靠对端出错或中继先断才被发现，host 侧表现为 `status:'online'` 但 `sendPayload` 一直 false。新实现必须显式决定应用层保活策略，不能默认"有 pong 就是有心跳"。

### 5.2 状态机

`RelayStatus = 'connecting' | 'online' | 'offline' | 'auth-failed'`（证据：relay-client.ts:30），`setStatus` 只在值真变了时回调 `onStatus`（证据：relay-client.ts:93-98），host-runtime 把它仅降为一行日志（证据：host-runtime.ts:75）。

- `connect()` → `connecting`（证据：relay-client.ts:102）
- `auth-ok` → `online` + `connectionGeneration++` + 记录 `hostId`（证据：relay-client.ts:156-161）
- `auth-fail` → `auth-failed`，**只打日志，既不关 socket 也不排重连**（证据：relay-client.ts:163-166，日志文案直接指向 `DRC_HOST_TOKEN / serverUrl`）。后果：是否自愈完全取决于中继是否随后关闭连接——关了才走 `close` → `offline` → 重连；不关就永远停在 `auth-failed`。推断：这是"配错 token 就静默等死"的成因，新实现要么显式退避重连，要么显式硬失败并停止重试，不要保留这种依赖对端行为的中间态。
- `close` → 有 `if (this.ws === ws)` 守卫才处理（证据：relay-client.ts:124-130）。这个身份比较很关键：**被丢弃的旧 socket 迟到的 close 不会误触发一次额外重连**，也不会把新连接的 status 打回 offline。
- `error` → 仅日志，不做状态迁移（证据：relay-client.ts:123），依赖紧随的 `close`。
- `stop()` → `closed=true`、清重连定时器、`ws.close()` 包 try、`ws=null`、`conversations.clear()`、`setStatus('offline')`（证据：relay-client.ts:82-91）。注意 `stop()` **不清 `pendingPairs`、不清 `lastPairTtlMs`/`lastPairProblem`**。

### 5.3 断连期间事件：丢弃，不缓冲

事实链条：**没有任何出站队列**。

- 底层 `send()`：`if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(...)`，否则什么都不做，无返回值（证据：relay-client.ts:144-146）。
- `sendPayload()`：无 conversation **或** socket 非 OPEN → `return false`（证据：relay-client.ts:284-286）。
- `broadcast()`：遍历 conversations 逐个 `sendPayload`，返回值被丢弃（证据：relay-client.ts:292-295）。
- host-runtime 全部调用点都不检查返回值（证据：host-runtime.ts:72、176、269-270、275、294、308）。
- 唯一"看起来像缓冲"的是 `deltaBuf`（§3），但它按 120ms 定时 flush，断连期间照样 flush 掉 → 文本直接蒸发；它从不因断连而暂停（证据：host-runtime.ts:203-209、212-229，`flushDelta` 不看 relay.status）。

结论：**断连期间的 `ev.message_delta` / `ev.tool_event` / `ev.run_state` / `ev.permission_request` 全部永久丢失**，重连后不会补发。手机端在 host 抖动期间的表现就是"输出缺一段"，而 §1.3 的僵尸 conversation 又让 host 仍显示有 N 个客户端（证据：host-runtime.ts:315）。推断：任何"重连后对齐"的需求只能靠**全量快照**（`ev.session_changed` + `cmd.list_sessions`）实现，不能指望事件补发；这也解释了 §3.8 的 15s 全量刷新为什么是义务而不是优化。

### 5.4 `relayProblem` 何时被置 / 何时被清

- 唯一置位点：`peer-joined` 但取不到可用 PSK（证据：relay-client.ts:206-214）。文案包含 `token=`（中继回显的配对码，可能 `none`）与 `pending=`（本地在途码数），并明写后果"客户端将无法解密任何东西"。
- 唯一清零点：**紧接成功建立 conversation 之后**（证据：relay-client.ts:215）。
- 因此：`stop()`、重连、`peer-left`、`createPairing` 都**不会**清掉它（证据：relay-client.ts:82-91、261-281 均未涉及该字段）。推断：`status.json` 里可能长期显示一条已经过期的 `relayProblem`，读状态的人（含 live-e2e）不能把它当作"当前故障"，只能当作"最近一次配对失败的原因"。
- 透出路径：`HostRuntime.state.relayProblem` → `this.relay.lastPairProblem`（证据：host-runtime.ts:326-329），注释说明了为什么必须进状态面而不是只写 stdout：**"掉线"和"配上了但一切不通"在手机端长得一模一样**。同一 `state` 里还并列了 `relay`、`hostId`、`clients`、`keepAwake`、`sessions` 与 `bridge` 诊断（`describe?.()`，缺省退化为 `carrier`+`lastError`），意图是让"bridge 静默返回 []"与"真的没有会话"可区分（证据：host-runtime.ts:311-325）。
- 其他"沉默失败"点，排障时必须知道：畸形 JSON 直接 return 无日志（证据：relay-client.ts:148-153）、`onFrame` 抛异常只记 `frame handling failed`（证据：relay-client.ts:115-122）、解密失败只记 `undecryptable frame dropped`（证据：relay-client.ts:232-234）、**收到未知 conversation 的 `enc` 完全无日志**（证据：relay-client.ts:229-230）。

### 5.5 中继重启后 host 的行为

1. WS 断 → `offline` → 退避重连 → `auth-ok` → `connectionGeneration++`（证据：relay-client.ts:124-130、133-142、156-157）。
2. 中继的 pending-pair 表被清空，**host 之前发布的配对码全部作废**，但 host 的 `pendingPairs` 不受影响地留着（§1.4）——这些码在本地 `expiresAt` 之前一直占槽（最多 32，§6.1 第 4 步），既配不上也挤不掉新码。
3. host 的 `conversations` 也不因重连清空（§1.3 后果 4）：旧客户端在新中继上不存在，host 却仍向旧 sessionId "发送"，全部 false。
4. 唯一的自愈路径是**发布侧**：`pairOnStartSec` 循环用 `generationChanged` 判据发现"我发布的码所属的代次已经不是当前代次"，于是重新 `createPairing` 并把新 generation 记进 `activePair`（证据：index.ts:387-404，详见 §6.2）。**这条自愈只覆盖 status.json 自动码；手工 `/drc pair` 拿到的码没有任何人替它刷新。**
5. 老中继不回显 `pairingToken` 的兼容分支见 §1.2 第 2 段（证据：relay-client.ts:192-205）。TTL 与"谁说了算"的细节归 `relay-and-wireformat.md` §4.4，本文不重复。

### 5.6 启动/停止的容错

`start()` 把 relay 启动与 `bridge.watch()` 各自包 try，任一失败只记日志、绝不带崩内核（证据：host-runtime.ts:88-106，注释："A failure here must never take the Harness down"）。15s 刷新定时器 `unref`（证据：host-runtime.ts:102-105）。
`stop()` 顺序是**先 `flushAllDeltas()` 再 unwatch / disable / relay.stop**，四步各自包 try（证据：host-runtime.ts:108-126）。推断：这个顺序是有意的——先把手里缓冲的文本挤出去，此时 socket 还活着；反过来的话 flush 只会撞上已关闭的 socket。新实现 MUST 保留"flush 在 stop 之前"。注意 `stop()` 里**没有**清理 `pendingHolds` 的 60s 心跳定时器（§4.3），它们只靠 `unref` 不阻止退出。

## 6. 配对码发布

### 6.1 `createPairing` 契约（一次发布做了什么）

签名 `createPairing(ttlMs = 120_000, opts: { includeToken?: boolean } = {}): { token, qr }`（证据：relay-client.ts:261、host-runtime.ts:128-130 纯代理）。执行顺序是有意义的，六步（证据：relay-client.ts:262-280）：

1. `psk = generatePairingSecret()`（协议层的 CSPRNG 路径，证据：relay-client.ts:262）。
2. **`token = String(Math.floor(Math.random()*1_000_000)).padStart(6,'0')`——六位数字码由 `Math.random()` 生成，不是 CSPRNG**（证据：relay-client.ts:263）。样本空间 1e6、可预测。事实：安全强度全押在"中继必须对 token 尝试做限速/一次性"上，host 侧没有任何限流。推断：新实现若继续用 6 位数字做人类可输入的码，限速只能放在服务端；若把码变长则破坏"手机手输"的可用性，属产品决策，不在本文范围。`Math.random` 与 PSK 的 `generatePairingSecret` 用不同强度，本身就是不一致信号。
3. `sweepPendingPairs()` 先清过期（证据：relay-client.ts:264、248-253）。
4. 容量上限：`if (pendingPairs.size >= MAX_PENDING_PAIRS /*32*/) 删第一个键`（证据：relay-client.ts:33、265-269）。**淘汰最旧**依赖 `Map` 的插入序迭代（`keys().next()`），语义是"运维狂敲 `/drc pair` 不能把这表撑爆"（注释原文，证据：relay-client.ts:265）。与 §3.3 的 deltaBuf 淘汰同构：都是"提前结束最旧的"，不是丢数据。
5. `pendingPairs.set(token, { psk, expiresAt: Date.now()+ttlMs })` + **`lastPairTtlMs = null`**（证据：relay-client.ts:270-271）。清 null 的含义是"等服务端告诉我真实 TTL"；在 `pair-ready` 落地之前，`pairingTtlMs` getter 返回 null（证据：host-runtime.ts:136-139），发布循环会退回"用请求的 TTL"（证据：index.ts:382-385）。
6. `buildPairingQr({ v:1, server: serverUrl, hostLabel, psk, token: includeToken ? token : '' })` 生成二维码文本，随后 `send({t:'pair-begin', pairingToken: token, psk, hostLabel})`（证据：relay-client.ts:272-279）。
   - `includeToken` 的取舍在源码注释里：把码嵌进 QR，让**没有摄像头的客户端（微信模拟器、CLI）一次粘贴即可配对**；**默认关**（证据：relay-client.ts:256-260）。嵌进去等于 QR 里同时含"地址 + PSK + 码"，谁扫到谁就能配对，所以只在受控通道里开。
   - `send()` 对非 OPEN 的 socket **静默丢弃且无返回值**（证据：relay-client.ts:144-146）⇒ `createPairing` 在断连时"本地成功、远端无效"：表里多了一条永远配不上的 PSK，返回值照样给出 token 与 QR。**这就是发布侧必须自己 gate 在 online 状态上的原因**（§6.2）。
   - 手工取码路径（slash command / `ctx.provide` 句柄）不在本文范围：`packages/plugin/src/index.ts:519`（不传 opts ⇒ token 不入 QR）与 :553，见 `docs/legacy-spec/host-plugin-cordis.md`。
   - QR URI 与 `PairingQr.token` 字段的规范表述见 `relay-and-wireformat.md` §3.4，本文不重复。

### 6.2 `pairOnStartSec` 刷新循环的判据

配置：`pairOnStartSec`，默认 `0 = 关`，来自 `DRC_PAIR_ON_START_SEC`（证据：index.ts:65、90）。循环挂在状态快照里，每 **3s** 跑一次并 `unref`（证据：index.ts:411-419）。判据全文（证据：index.ts:381-395）：

- `ttlMs = runtime.pairingTtlMs ?? pairSec*1000`：**服务端 `pair-ready.ttlMs` 优先**，未落地前退回请求值（证据：index.ts:382-385，理由见 §6.3）。
- `expiresAt = (activePair?.createdAt ?? 0) + ttlMs`（证据：index.ts:386）。
- `generationChanged = activePair !== null && runtime !== null && activePair.generation !== runtime.relayGeneration`（证据：index.ts:389-390，注释："A relay restart wipes its pending-pair table: our published code is dead even though its TTL has not run out."）。
- `stale = !activePair || generationChanged || expiresAt < Date.now() + ttlMs/2`（证据：index.ts:393-394）——三选一即刷新：**无活动码 / 代次变了 / 剩余寿命不足半程**。半程刷新的注释理由是"Only publish once the relay is up ... and refresh at half-life so a stale code never survives"（证据：index.ts:391-392）。
- 发布闸门：`pairSec > 0 && runtime && runtime.state.relay === 'online' && stale`（证据：index.ts:395）。`runtime.state.relay` 就是 `relay.status`（证据：host-runtime.ts:313）。
- 动作：`createPairing(pairSec*1000, { includeToken: true })`（**自动码强制嵌 token**，因为消费方 `status.json` 是无摄像头的 CLI/e2e），并记下 `createdAt`、`expiresAt`（ISO）、`generation: runtime.relayGeneration`（证据：index.ts:396-404）。
- `createPairing` 抛错只 `console.warn`，**保留旧 activePair 继续展示**（证据：index.ts:405-407）。
- 不满足 stale 的分支：只把 `activePair.expiresAt` 按当前 ttl 重算覆写（证据：index.ts:408-410）——即 `pair-ready` 迟到后用服务端 TTL 修正已发布的过期时间。

**三条判据各自防的事故**：`!activePair` 防"永远没有码"；`generationChanged` 防"中继重启后一直挂一个死码"（§5.5）；`剩余 < 半程` 防"用户扫到一个刚刚过期的码"。半程 + 3s 轮询 ⇒ 一个码在 status.json 里的实际存活期约 `ttlMs/2 ~ ttlMs`。

### 6.3 TTL 归属：为什么必须听服务端

`pair-ready` 带 `ttlMs`，host 必须**用它覆写本地记录的 `expiresAt = Date.now() + ttlMs`**（证据：relay-client.ts:167-177）。源码注释写明了反例成因：host 用"自己请求的 TTL"提前清扫 PSK ⇒ `peer-joined` 找不到 PSK ⇒ §1.2 第 3 段静默丢 peer ⇒ 客户端永远"加密解码失败"、会话列表为空（证据：relay-client.ts:168-171、HANDOFF.md:114-116）。这是被点名的两个真 bug 之一（证据：HANDOFF.md:112），规范条款见 `relay-and-wireformat.md` §2.3。

两个必须记录的时间基线不一致（**事实 + 推断**）：

- `relay-client` 的 `expiresAt` 基线是 **`pair-ready` 到达时刻**（证据：relay-client.ts:175）。
- `status.json` 里 `activePair.expiresAt` 的基线是 **`createdAt`（发起 `pair-begin` 时刻）**（证据：index.ts:386、401-402）。
- 推断：`pair-ready` 慢到几十毫秒以上时，本地 PSK 存活期会比中继的略长（偏保守方向反过来，会导致 host 认为还活着但中继已扫——又落回 §1.2 第 3 段的静默丢 peer）。半程刷新把窗口压小了，但没有消除。新实现应当只用一个基线（发起时刻），并把服务端 TTL 当作"从发起算起的时长"。

### 6.4 一次性与"发布侧不随消费刷新"

配对码**一次性**：`peer-joined` 无论命中与否都 `pendingPairs.delete(usedToken)`（证据：relay-client.ts:190）。但 `status.json` 里的 `pairing` 字段**按定时器刷新，不按消费刷新**——码被用掉之后 status.json 仍会展示它直到下一次 3s 快照里的 stale 判定（证据：index.ts:393-394、HANDOFF.md:120-121）。后果是消费方必须自己判"新发布的码"：live-e2e 因此只接受 `age < 25s` 且本轮未用过的码（证据：HANDOFF.md:121）。推断：这是"状态文件当广播介质"的固有缺陷；新实现若保留 status.json，要么把已消费事件回写，要么把 age 判据固化为契约。

## 7. 测试在守护什么

### 7.1 `windowing.test.ts` 的夹具决定了它测得到什么

夹具三件事（证据：windowing.test.ts:21-59）：

- bridge 是一个纯 stub：`carrier:'stub'`、`listSessions: async () => []`、四个动作全部 `async () => ({ok:true})`、`watch` 把 emit 句柄交给测试（证据：windowing.test.ts:23-37）。⇒ **只有 `forward()` 之后的路径被覆盖**，`onPayload` / `handlePayload` / 配对 / 重连完全没碰。
- `serverUrl: 'ws://127.0.0.1:1'`，注释"dead port: connects, fails, retries"，`keepAwakeEnabled: false`（证据：windowing.test.ts:44-47）。⇒ 连接永远不成功，`conversations` 永远为空。
- **`rt.relay.broadcast` 被整体替换成 `seen.push`**（证据：windowing.test.ts:52-56），注释："no clients are paired in a unit test, so every payload lands in broadcast"。⇒ **`sendPayload` 与 `pairedClients` 定向分支一次都没被执行**。结合 §3.7（定向分支在生产里也永不命中），这层夹具与生产实际走的是同一条广播路径——巧合地"测的就是跑的"，但也意味着**新实现一旦真的实现定向路由，这五个测试会全部失去覆盖**。

### 7.2 五条断言 ↔ 真实行为

| # | 断言 | 守护的真实行为 | 证据 |
|---|---|---|---|
| 1 | 3 个 delta 在 260ms 后**只剩 1 帧**，`delta === '段0段1段2'` | 窗口内合并生效（1 帧/窗口，不是 3 帧）；**合并不得丢字、不得乱序**——串接顺序就是用户读到的顺序 | windowing.test.ts:70-81（阈值 260ms > `DELTA_FLUSH_MS` 120ms，见 host-runtime.ts:18） |
| 2 | 文本帧之后同窗口内来 `delta('', true)`：**仍 1 帧**、`delta === '答案'`、`done === true` | 终态标记能"搭车"：合并必须保留 sticky-OR 的 done，不能另发一帧、也不能把 done 弄丢 | windowing.test.ts:83-94 ↔ host-runtime.ts:188、204 |
| 3 | 文本先单独出去（跨过窗口），再发 `delta('', true)`：**共 2 帧**，第二帧 `delta === ''` 且 `done === true` | **空文本的 done 帧必须转发**（§3.5）。注释点名历史回归：`flushDelta` 曾以 `if (!entry.text) return` 开头，把内核 `turn/end` 的空 done 帧吃掉，手机永远转圈，且"**只在真实内核上暴露，mock 永远测不出来**" | windowing.test.ts:96-113 ↔ host-runtime.ts:217-220 ↔ adapter-dsh.ts:962-967 |
| 4 | `delta('前半') → tool_event → delta('后半')` 的出站类型序列严格 `['ev.message_delta','ev.tool_event','ev.message_delta']`，且第 1/3 帧文本分别是前半/后半 | **非 delta 事件之前必须先 flush 同会话缓冲**（§3.6），否则事件帧会插到已产生的文本前面 | windowing.test.ts:115-127 ↔ host-runtime.ts:163-165 |
| 5 | `delta('尾巴')` 后立刻 `rt.stop()`（未跨过窗口）⇒ 仍有 1 帧 `'尾巴'` | **`stop()` 的第一步是 `flushAllDeltas()`，此时 socket 与 conversations 还没被拆**（§5.6）；顺序反了就永久丢尾句 | windowing.test.ts:129-136 ↔ host-runtime.ts:108-126 |

### 7.3 `listing.test.ts`：15 个 test（`grep -c '^test('` = 15），其中与 host 运行时相关的部分

这个文件整体是 **cordis 适配器**的护栏（`DshKernelBridge` / `resolveAgentFrom` / `WATERFALL_EVENTS`），实现细节归 `docs/legacy-spec/host-plugin-cordis.md`。下表只列"约束本文 §1–§6 行为"的那些断言，其余标注为适配器面（不展开）。

| 断言 | 真实行为 | 与运行时的耦合 | 证据 |
|---|---|---|---|
| 列表顺序 `'live-1','cold-1'` 注释 "newest first" | `listSessions()` 必须按 `createdAt` 倒序 | 这就是 `ev.session_changed.sessions` 与 `cmd.list_sessions → ev.result.data.sessions` 的顺序契约，手机端直接按数组序渲染 | listing.test.ts:60-64 |
| `cold.state === 'detached'`（"persisted-but-unloaded is openable, not missing"）、`archived.state === 'archived'`（与 detached 必须区分，否则"用户会去追一个超时"） | 状态枚举必须能表达"能打开/被宿主 gate 拒" | `SessionSummary.state` 同时是 `ev.run_state.state` 的取值域（protocol/src/index.ts:185），而 `ev.run_state` 是 §4.2 里唯一触发持锁的状态迁移 | listing.test.ts:66-67、348-361 |
| `cold.workspace === '/w/a'`、`cold.title === 'title-cold-1'`、`live.updatedAt === new Date(...).toISOString()`、`live.running === true` | 行的每个字段都得填出来 | 缺字段就是手机上一片空白；`updatedAt` 必须是 ISO 字符串 | listing.test.ts:66-74 |
| `desc.services.hasSessionQuery === true` / `listingSource` 含 `/attached only/` / `hiddenSubagents === 1` / `archivedSessions === 1` / `lastError` 匹配 `/persistence unreadable/` | `describe()` 必须把"探测到了哪些内核面 + 上一次吞掉的错误 + 被隐藏了多少行"报出来 | **正是 `host-runtime.ts:311-325` 里 `state.bridge` 的用途**——"bridge 静默返回 [] 必须能和'你真的没有会话'区分开"。删掉 describe() 就等于删掉这条可观测性 | listing.test.ts:75-76、96-98、267、360 ↔ host-runtime.ts:322-325 |
| 语料库读失败时**退回 `ctx.sessions`** 而不是返回空（"degrades to the live store instead of returning nothing"） | 列表读取要有降级路径 | 与 §3.8 的"`listSessions` 失败就**不广播**"配套：一条路径降级、另一条路径宁可不发 | listing.test.ts:79-99 ↔ host-runtime.ts:305-307 |
| `readTitleSnapshots` 抛错 ⇒ `list.length === 1` 且 `title === undefined`（"a title failure never costs the session list"） | 局部字段失败不得毁掉整行 | 同上一条：手机上"列表变空"永远比"少个标题"严重 | listing.test.ts:101-115 |
| 无模型的活 agent ⇒ `resolveAgentFrom` 返回 `{agent:null, note:/no model/i}`（"refusing beats starting a turn that cannot work"） | 发 prompt 前的前置校验 | 走的是 `sendPrompt → {ok:false, message}` ⇒ `ev.result{ok:false,message}`（§2.2），**不是异常**，所以不会掉进 §2.3 的兜底回执 | listing.test.ts:117-130 ↔ bridge.ts:49-52 |
| 可用的活 agent 直接复用，`resumed === 0`（"a usable live agent must not be re-resumed"） | 重复 `cmd.send_prompt` 到同一会话不应产生额外副作用（在 agent 解析这一层） | §2.4 幂等要求的**唯一**一处实现级缓解 | listing.test.ts:132-149 |
| 冷会话用部署默认模型 resume：`options.resumeSessionId`、`agentOptions` 三字段（provider/model/reasoningEffort）逐字 | 冷启动必须能配上模型 | `cmd.send_prompt` 对 `state:'detached'` 行的隐含承诺 | listing.test.ts:151-169 |
| resume 抛错 ⇒ `{agent:null, note:/agent preset unmountable/}`（"reported rather than thrown"） | **适配器不许抛**，一律折成 `ok:false + message` | 这条纪律是 §2.3 兜底回执"几乎不会触发"的原因；新实现若允许适配器抛，客户端就会看到无 message 的系统错误 | listing.test.ts:171-185 |
| `assistant/message` 里 `reasoning` part **不出站**（`delta === 'ok'`，注释"chain of thought must not ship"）、`done === false`、`sessionId === 's-1'` | 只有 `text` part 变成输出 | 思维链属于不得跨 E2E 边界的内容（§3.7 的广播副作用会放大它）——**红线** | listing.test.ts:210-218、235-238 ↔ adapter-dsh.ts:931-936 |
| `turn/start → ev.run_state(running)`、`tool/call → tool_event(started)`、`tool/result → tool_event(completed)`、`turn/end → message_delta(done:true) + run_state(idle, detail:'completed')`，**类型序列逐位断言** | 事件解码的确定性序与字段 | 这条序就是 §4.2 真值表的输入（run_state(running) 持锁、tool_event 持锁、done 帧结束 UI），也正是 §3.5 done-only 帧的上游 | listing.test.ts:223-246 ↔ adapter-dsh.ts:927-930、962-967 |
| 子代理会话**不出现在列表里**且 `hiddenSubagents === 1`，对它发 prompt ⇒ `ok:false` + `/subagent/i` | 宿主不给的东西不许给手机看 | 手机看到的"可选目标集合"由此决定；与 §2.2 的 `ok:false` 语义绑定 | listing.test.ts:249-272 |
| 归档会话：列出为 `archived`；发 prompt 前**先 unarchive**（`calls === ['unarchive:s-arch']`，"restore precedes the prompt"）；`unarchiveOnPrompt:false` 时**拒绝且不动归档**；恢复失败时 message 带上底层原因 | 写命令的副作用顺序与"配置说不就不做" | 属于 §2.4 "handler 要求"的一部分：手机端点一次发送可能引发 host 端的**状态突变**，必须可关、必须回原因 | listing.test.ts:348-397 |
| 两条 waterfall 护栏：`watch()` 注册的事件名集合里**不得**出现 `WATERFALL_EVENTS` 成员，且 denylist 必须含 `agent/request` 与 `agent/pre-step`；即便被加回列表也要跳过 | **纯 cordis 面**（观测性订阅会冲掉 waterfall 链、让进程内每个 turn 崩） | 与本文无直接耦合，但它是"插件绝不能崩宿主"这条总则的最强例证，§2.1 的 `.catch` 纪律同源 | listing.test.ts:276-316 ↔ HANDOFF.md:90-93 |

### 7.4 新实现必须重新覆盖、但旧代码库**没有任何测试**的运行时行为

事实：以下行为只存在于源码，`windowing.test.ts` / `listing.test.ts` 都没断言（`apply.test.ts` 测的是启动门、`qr.test.ts` 测的是 URI 编解码、`e2e/multi-pair.test.mjs` 是唯一覆盖配对选择逻辑的测试）。清单按本文小节排序：

1. §1.1 合并帧的 `messageId` 取窗口**首**值、`part` 取窗口**末**值——无测试（证据：host-runtime.ts:185-196；`e2e/multi-pair.test.mjs` 也不看这两个字段）。
2. §1.2 `peer-joined` 的三段 PSK 判定（精确命中 / 老中继兜底取最新 / 无 PSK 丢弃并写 `lastPairProblem`）。`multi-pair.test.mjs` 只测"较早那个码仍然可以被认领"：两个码同时在途、用**第一个**码配对、断言 host 回的每一帧都能被它的 `kH2C` 解开、最终拿到 `ev.result.data.sessions` 是数组（证据：e2e/multi-pair.test.mjs:85-134、HANDOFF.md:117-119）。**"取错 PSK 会导致对端解不开"正是它断言的反面**（证据：relay-client.ts:47-56、181-184）。未覆盖：兜底分支、无 PSK 分支。
3. §1.3 `peer-left` **删除 conversation**、之后出站 `sendPayload` 返回 false 被吞、入站 `enc` 无日志丢弃——无测试。
4. §1.4 / §5.5 `connectionGeneration` 驱动的重发码自愈——无测试（证据：index.ts:389-390 与 relay-client.ts:157 之间没有任何测试连接）。
5. §2.2 六种 cmd 的回执形状、`cmd.subscribe` 是空 ack、未知 cmd **无回执**——无测试。
6. §2.3 `cmdId:''` 兜底、`cmd.keep_awake` 在 try 之外——无测试。
7. §3.3/§3.4 的 `MAX_DELTA_CHARS=4096` 提前 flush 与 `MAX_DELTA_SESSIONS=32` 淘汰 flush——**两条上限路径都没有测试**（windowing.test.ts 只用 3 个小 delta）。
8. §3.7 定向 vs 广播（含"定向分支永不命中"这一事实）——无测试，且夹具把它永久藏起来（§7.1 第 3 点）。
9. §3.8 15s 全量刷新、"无客户端就不查 bridge"、"查询失败不广播"——无测试。
10. §4 全部：持锁真值表、60s 心跳永不释放的泄漏、`active` 字段语义、`disable` 的 reason 被丢弃——无测试（`keepAwakeEnabled:false` 在两个运行时测试里都是关的，证据：windowing.test.ts:47、multi-pair.test.mjs:75）。
11. §5 全部：backoff/jitter 序列、`handshakeTimeout`、`auth-fail` 不重连、`if (this.ws === ws)` 陈旧 socket 守卫、断连期间事件丢失、`relayProblem` 不清——无测试（dead port 夹具只让 `status` 停在非 online，从未断言过渡）。
12. §6 全部：`pairOnStartSec` 的三条 stale 判据、`pair-ready` 覆写 `expiresAt`、32 槽淘汰最旧、`lastPairTtlMs` 置 null 的窗口期——无测试。

## 8. 条款汇总（MUST / MUST NOT）

锚点指向本文小节；「旧实现状态」列说明现网是否已经满足（不满足的即重写时必须主动决策的项）。

### 8.1 MUST

| # | 条款 | 锚点 | 旧实现状态 |
|---|---|---|---|
| M1 | 每条 `cmd.*`（除未知 `t`）必须以原 `cmdId` 回一条 `ev.result`，且回执必须与业务成败无关地发出 | §2.2、§2.3 | 部分满足（`cmd.keep_awake` 在 try 外） |
| M2 | 桥接层异常必须折成 `ev.result{cmdId, ok:false, message}`；`cmdId` 缺失时才允许 `''` | §2.3 | 满足（host-runtime.ts:282-288） |
| M3 | 异步入站 handler 必须挂 `.catch`，任何异常都不得逃逸成 unhandled rejection（宿主是用户内核进程） | §2.1 | 满足 |
| M4 | 审批/提问的 `requestId` 必须按"一次性、以 requestId 为准"处理：未知或已消费的 id 要回 `ok:false` | §2.4 | 契约存在于 mock（adapter-mock.ts:65-76） |
| M5 | 每条 `ev.message_delta` 流最终必须给出一个 `done:true`，且**空文本的 done 帧不得被丢弃**（判据 `if (!text && !done) return`） | §3.5 | 满足，有回归测试（windowing.test.ts:96-113）；另见 `mp-client-contract.md` §5.4 第 6 条 |
| M6 | 任何非 delta 事件（`ev.run_state` / `ev.tool_event` / `ev.permission_request` / `ev.question_request` / `ev.result`）在发给某会话之前，必须先 flush **该会话**的 delta 缓冲 | §3.6 | 满足，有测试 |
| M7 | 合并必须保序串接文本，且 `done` 用 sticky-OR 传递；`DELTA_FLUSH_MS` 定时器只在窗口首字装填（不得被后续 delta 续期） | §3.3、§3.4 | 满足 |
| M8 | 两个上限（4096 字符、32 会话）必须以**提前 flush** 实现，不得以丢数据实现 | §3.3、§3.4 | 满足，但无测试 |
| M9 | 运行中（`ev.run_state:running`）、工具活动（`ev.tool_event`）、挂起审批/提问三种情形必须持有防休眠锁；pending 期间每 60s 续期 | §4.2、§4.3 | 满足（续期部分见 M-11/N4） |
| M10 | 空闲自动释放必须实现（默认 300s，`0`=永不释放），且释放后 `markActive()` 能重新拿锁 | §4.4 | 满足 |
| M11 | macOS 持锁必须以 `-w <ownerPid>` 绑定宿主进程生命周期（进程死 → 断言自动消失） | §4.1 | 满足 |
| M12 | 防休眠状态变化必须广播 `ev.keep_awake_state`；`peer-joined` 与 `cmd.keep_awake` 之后必须**定向补发**一次 | §4.5 | 满足 |
| M13 | 出站载荷必须由 `KeepAwake` 之类的能力层承担，策略层（host-runtime）不得直接 spawn 平台命令 | §4.1 | 满足 |
| M14 | `peer-joined` 必须按 `pairingToken` 精确取 PSK；多码必须并存（表，不是单槽）；配对码必须一次性消费 | §1.2 | 满足，`e2e/multi-pair.test.mjs` 守护 |
| M15 | 取不到 PSK 时必须留下可读诊断（`lastPairProblem`）并透出到状态面，不得静默丢 peer | §1.2、§5.4 | 满足 |
| M16 | 配对 TTL 必须以中继 `pair-ready.ttlMs` 为权威，并据此更新本地过期时间 | §6.3 | 满足 |
| M17 | `pair-begin` 只能在 `relay === 'online'` 时发送（否则被 `send()` 静默丢弃） | §6.1、§6.2 | 满足（自动码路径）；手工路径无 gate |
| M18 | 发布循环必须覆盖三条 stale 判据：无活动码 / `connectionGeneration` 变化 / 剩余不足 `ttl/2` | §6.2 | 满足，无测试 |
| M19 | 待配对码表必须有上限（32）并按插入序淘汰最旧 | §6.1 | 满足 |
| M20 | 重连必须指数退避 + 抖动（1s→30s，0–500ms），且同时只有一个待发定时器 | §5.1 | 满足（数值同 `relay-and-wireformat.md` §5.8） |
| M21 | `new WebSocket()` 与每一帧的解析/处理都必须包 try，畸形帧与处理器异常不得打断连接循环 | §5.2、§5.4 | 满足 |
| M22 | `close` 处理必须做 socket 身份比较（`this.ws === ws`），陈旧 socket 的迟到事件必须忽略 | §5.2 | 满足 |
| M23 | 所有插件侧定时器必须 `unref`（不得让宿主进程无法退出） | §3.4、§5.1 | 满足 |
| M24 | `stop()` 必须先 flush delta 缓冲，再拆 socket / 清会话 / 释放锁；每一步各自包 try | §5.6 | 满足，有测试（windowing.test.ts:129-136） |
| M25 | `listSessions()` 失败时**不得**向客户端广播空列表 | §3.8 | 满足（pushSessionsToAll） |
| M26 | 改变状态的四条写命令（send_prompt / resolve_permission / answer / interrupt）之后必须向请求方推一次会话快照 | §3.8 | 满足 |
| M27 | 必须提供 `describe()` 级别的内核面诊断，使"适配器静默返回 []"与"确实没有会话"可区分，并进入 `state.bridge` | §5.4、§7.3 | 满足（listing.test.ts 守护） |
| M28 | 思维链（`reasoning` part）与子代理/被宿主拒绝的会话不得进入出站事件与列表 | §7.3 | 满足（listing.test.ts:210-218、249-272） |

### 8.2 MUST NOT

| # | 条款 | 锚点 | 旧实现状态 |
|---|---|---|---|
| N1 | 不得假设"配上了就一直在线"：`peer-left` 之后该 conversation 的密钥、seq、订阅全部即刻消失 | §1.3 | 现状即如此 |
| N2 | 不得依赖入站 `seq` 做任何顺序/防重放判断（host 根本不读它） | §1.1、§2.4 | 现状：不读 |
| N3 | 不得假设客户端命令按序、不重复到达；写命令 handler 必须能挺住重放与乱序 | §2.4 | **未满足**（无去重），必须主动决策 |
| N4 | 不得在重放时回 `ok:false` 打搅用户（幂等要在 handler 内部解决）——见 `mp-client-contract.md` §5.4 第 3 条 | §2.4 | 未满足 |
| N5 | 不得假设未知 `cmd.t` 会被回执——旧实现静默无回执，客户端不得永久挂起等待 | §2.3 | **未满足**（既无回执也无超时约定） |
| N6 | 不得把 `cmd.subscribe` 当作路由开关（它只是一个 `ok:true` 空 ack） | §2.2 | 现状即如此 |
| N7 | 不得把 `cmdId` 为空串的兜底回执当成"我那一条" | §2.3 | 未定义（客户端义务，见 `mp-client-contract.md` §5.4） |
| N8 | 不得因窗口合并而改写/新建 `messageId` 归属：合并帧的 `messageId` 是窗口首值，`part` 是窗口末值——不得假装这两者都精确 | §3.3 | 现状即如此（隐患） |
| N9 | 不得把 `flushDelta` 的判据写成"没有文本就丢"（`if (!text) return`），也不得写成"done 必须独占一帧" | §3.5 | 满足（曾违反，已回归） |
| N10 | 不得用 `emitTo` 的"定向"分支来保证会话隔离：它的过滤键与事件键是两个命名空间，实际恒走广播 | §3.7 | **未满足**（多客户端互听，安全面缺陷） |
| N11 | 不得把 `ev.keep_awake_state.active` 解释为"有会话在跑"，也不得把 `reason` 解释为"释放原因"（`disable` 的 reason 被丢弃） | §4.4、§4.5 | 现状语义如此（易被误用） |
| N12 | 不得让持锁心跳成为不可释放的资源：`pendingHolds` 的释放条件在旧实现里永不成立 | §4.3 | **未满足**（泄漏） |
| N13 | 不得在断连期间依赖事件补发——没有出站队列，事件就是丢了 | §5.3 | 现状即如此 |
| N14 | 不得假设 `auth-failed` 会自动重试；自愈仅在中继主动断链时发生 | §5.2 | 现状即如此（隐患） |
| N15 | 不得把 `relayProblem` 当"当前故障"读：它只在成功建会话时清零，`stop()`/重连都不清 | §5.4 | 现状即如此 |
| N16 | 不得在中继重启后继续使用旧 `connectionGeneration` 下发布的配对码 | §1.4、§5.5 | 满足（判据在 index.ts） |
| N17 | 不得用 `Math.random()` 生成任何需要密码学强度的东西——旧实现的 6 位配对码就是一例，其安全性完全依赖服务端限速 | §6.1 | **违反**（现状，需在重写时明确处置） |
| N18 | 不得让 `createPairing` 在本地 `expiresAt` 与展示 `expiresAt` 上使用两套时间基线 | §6.3 | **违反**（relay-client 以 `pair-ready` 到达为基，status.json 以 `createdAt` 为基） |
| N19 | 不得把带 `includeToken` 的 QR/配对信息写到非 0600 的文件里（自动码嵌 PSK+码，见 `relay-and-wireformat.md` §7.4 与 index.ts 的配置告警） | §6.1、§6.2 | 由 cordis 侧文档约束 |
| N20 | 不得对"列表读取失败"退化到"广播空列表"，也不得在没有任何客户端时还去查 bridge | §3.8 | 满足 |
