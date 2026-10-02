# 小程序端接口契约（mp/ 是唯一的接口权威）

> 适用前提：`mp/` 一行不改，`packages/protocol`、`packages/plugin`、`apps/server` 全部重写。
> 于是**手机能发什么、能解什么、能显示什么，就是系统对外的接口定义**。新中继与新 host
> 只要偏离本文任何一条，手机端的表现是「静默坏掉」而不是报错——因为客户端的绝大部分
> 容错都是「解析失败就丢掉、监听器异常就吞掉」（证据：mp/core/client.js:53-61、mp/core/client.js:199-206）。
>
> 证据格式：`（证据：文件:行号）`。行号对应仓库当前工作区内容。
> 明确标注「推断：」的条目是从代码事实外推、没有直接断言的结论。
> 权威来源仅限：`mp/core/*.js`、`mp/core/vendor/*`、`mp/pages/**`、`mp/app.*`、`mp/project.config.json`、
> `docs/MINI-PROGRAM.md`、`HANDOFF.md` §4.6/§4.7、`e2e/mp-crypto.test.mjs`、`e2e/mp-client.test.mjs`、
> `e2e/mp-platform.test.mjs`、`e2e/mp-sim.mjs`（辅助：`e2e/run.mjs`、`e2e/live-e2e.mjs`、`e2e/multi-pair.test.mjs`、
> `docs/SECURITY.md`、`docs/SELF-HOSTING.md`）。

三行摘要（WHY）：

- 线格式是**字节级**约定：`base64(nonce(24) ‖ nacl.secretbox(utf8(JSON), nonce, key))`，
  key = `SHA-512('dsh-rc/v1'␟dir␟convId␟pskRaw)[0..32]`（证据：mp/core/codec.js:4-6、22-24、60-81；docs/SECURITY.md:16）。
  小程序与 Node 侧必须逐字节对拍，测试就是这个作用（证据：e2e/mp-crypto.test.mjs:34-110、docs/MINI-PROGRAM.md:67-68）。
- 中继经手的**明文帧只有 3 种**：`hello`、`pair-begin-client`、`enc`（外加它自己的下行回帧），
  其余一切都在密文里；中继必须保持零知识（证据：e2e/run.mjs:198-213、e2e/live-e2e.mjs:274-283）。
- 页面渲染**只依赖少数字段名**，字段名改一个就是一片空白；而客户端不会告诉你它失败了。

---

## 1. 小程序会发出的一切

### 1.1 控制面明文帧（客户端总共只会发这 3 种）

| 帧 | 字段（全部） | 类型/取值 | 发出时机 | 证据 |
|---|---|---|---|---|
| `hello` | `t` | `'hello'` | socket `onOpen` 回调里，立即 | mp/core/client.js:116-124 |
| | `role` | 字面量 `'client'`（不是 `'mp'`/`'phone'`） | 同上 | mp/core/client.js:119 |
| | `protocol` | 数字 `1`（`PROTOCOL_VERSION`，永远 1） | 同上 | mp/core/client.js:19、120 |
| | `clientId` | 字符串 = installId（或中继在 `hello-ok` 里下发的值） | 同上 | mp/core/client.js:72、121、254 |
| | `clientMeta` | 对象 `{platform:'wechat-mp', label:'微信小程序'}` | 同上 | mp/core/client.js:122 |
| `pair-begin-client` | `t` | `'pair-begin-client'` | 收到 `hello-ok` 且本地有待用配对码 | mp/core/client.js:255-257 |
| | `pairingToken` | 已经过 `normalizePairingToken` 归一（去掉空格与 `-`），来自二维码 `t=` 或手输 6 位 | 同上 | mp/core/client.js:103、mp/core/codec.js:200-202 |
| `enc` | `t` | `'enc'` | 每次 `sendCmd()` | mp/core/client.js:184-190 |
| | `sessionId` | **配对通道 id**（`paired.sessionId`，`c_` 前缀），不是 DSH 会话 id | 同上 | mp/core/client.js:186、269；HANDOFF.md:109-110 |
| | `seq` | 整数，`++this.seq`，实例内存变量，从 1 起 | 同上 | mp/core/client.js:30、187 |
| | `clientId` | 同 `hello` | 同上 | mp/core/client.js:188 |
| | `ciphertext` | `base64(nonce‖box)`，见 §6.1 | 同上 | mp/core/client.js:183、mp/core/codec.js:90-100 |

**不会发的东西**（新实现不能要求）：`auth`、`subscribe`/`unsubscribe`、`ping`、应用层心跳、
`pair-begin`（那是 host 侧帧）、任何凭据（客户端配对后无二次认证，docs/SECURITY.md:131）、
任何 HTTP 轮询（协议是 WS-only，docs/MINI-PROGRAM.md:126；`/api/pair-status` 客户端不用，docs/SELF-HOSTING.md:27-29）。

### 1.2 数据面加密 cmd 清单（6 个，全部经 `sendCmd`）

每个 cmd 一定带 `t` 与 `cmdId`；`cmdId` 缺失时由客户端自动生成
`'c' + Date.now().toString(36) + '_' + 自增序号`（证据：mp/core/client.js:180-181、193-196）。

| cmd | 字段 | 类型 | 调用点（谁在什么时候发） |
|---|---|---|---|
| `cmd.list_sessions` | `t`,`cmdId` | 无其他字段 | ① `hello-ok` 恢复路径（client.js:261）；② `paired` 之后立刻要一次（client.js:287）；③ `listSessions()`：会话页下拉刷新/进入（sessions.js:144-146）、会话页 `onShow`（sessions.js:59 经 `refresh`）、聊天页 `onShow`（chat.js:51） |
| `cmd.send_prompt` | `sessionId`（DSH 会话 id）, `text` | 都是字符串 | 聊天页发送（chat.js:242 ← `onSend`） |
| `cmd.interrupt` | `sessionId` | 字符串 | 聊天页「中断」（chat.js:247，仅当 `running` 时按钮才存在，chat.wxml:78-80） |
| `cmd.resolve_permission` | `sessionId`, `requestId`, `decision` | 字符串；**decision 逐字取自主机下发的 `options[].id`** | 聊天页审批卡 chip（chat.js:256 ← chat.wxml:29-34） |
| `cmd.answer` | `sessionId`, `requestId`, `answers` | `answers` = `[{questionId, selected:[optionId…], freeText?}]`，顺序与 `questions` 一致；未填 freeText 时该键**被 JSON.stringify 丢掉** | 聊天页提问卡提交（chat.js:279-299） |
| `cmd.keep_awake` | `enabled`(bool), `idleReleaseSec`（可选，仅 `enabled` 为真时带，值固定 `600`） | 见左 | 会话页防休眠开关（sessions.js:156-160；`idleReleaseSec` 的注入逻辑在 client.js:349-353） |

字段级说明（WHY 很重要）：

- `cmd.send_prompt` **只有 `sessionId` + `text`**；协议里的 `attachments` 没有任何 UI 会填
  （证据：mp/core/client.js:321-323；docs/MINI-PROGRAM.md:123；HANDOFF.md:178）。
- `answers[].selected` 是 **option id 数组**（不是 label），`multi` 只影响 UI 单选/多选行为，
  不影响出站结构（证据：mp/pages/chat/chat.js:259-299）。
- 关闭防休眠时出站的是 `{t:'cmd.keep_awake', cmdId, enabled:false}`，**不带** `idleReleaseSec`
  （证据：mp/core/client.js:349-353、mp/pages/sessions/sessions.js:158）。
- 客户端不校验主机的回复；所有 cmd 都是 fire-and-forget，重发很常见（每次进页面就是一次
  `cmd.list_sessions`）。推断：新 host 必须把 cmd 当**可重复、可乱序到达**的幂等请求处理。

---

## 2. 小程序会消费的一切

### 2.1 明文帧：`_onFrame` 的完整 switch

| 帧 `t` | 客户端读取的字段 | 行为 | 未知/缺失时的容忍 | 证据 |
|---|---|---|---|---|
| `hello-ok` | `clientId?`（有就覆盖本地 installId） | 有待用码→发 `pair-begin-client`；已配对→发 `cmd.list_sessions` 并置 `online`；否则 `needs-pair` | 字段一个都不读也能跑 | mp/core/client.js:209-210、253-265 |
| `paired` | **`sessionId`（必需）**、`hostId?` | 派生 kC2H/kH2C、落盘配对、`online`、发 `cmd.list_sessions` | `hostId` 缺→空串；`sessionId` 缺→`convId=undefined`，之后全部解密失败 | mp/core/client.js:212-213、267-288 |
| `pair-fail` | `reason`（枚举，见 §3.4） | `needs-pair` + `'配对失败：' + 中文` | 未知 reason 原样拼进文案 | mp/core/client.js:215-218、356-364 |
| `peer-left` | 不读任何字段 | 清空配对（保留 socket）+ `needs-pair '主机已断开，请重新配对'` | — | mp/core/client.js:219-223 |
| `peer-joined` | 不读 | 发 `{kind:'notice'}`；**三个页面都不处理 notice → 实际不可见** | — | mp/core/client.js:224-226；sessions.js:86-96、pair.js:98-136、chat.js:74-96 |
| `error` | `code`（`'unknown_session'` 特殊）、`message` | unknown_session→清配对+`needs-pair`；其余→`{kind:'error'}`（会话/聊天页 40 字 toast，配对页可能弹 modal） | `message`/`code` 都缺→toast 显示 `unknown error` | mp/core/client.js:227-234；sessions.js:93-95、chat.js:79-81、pair.js:118-135 |
| `pong` | 不读 | 直接返回（客户端从不发 `ping`，此分支纯属容忍） | — | mp/core/client.js:235-236 |
| `enc` | `ciphertext`（**只用这一个**；`sessionId`/`seq` 被忽略） | 用 kH2C 解密→分发 | 解密失败按 §3.1 处理 | mp/core/client.js:237-239、291-293 |
| `enc-batch` | `sessionId`（仅透传）、`items[]` 每项的 `ciphertext` | 逐项解密、按数组顺序分发 | `items` 不是数组就整批丢弃 | mp/core/client.js:240-247、291-313；HANDOFF.md:129 |
| **其他任何 `t`** | — | **静默忽略，不报错** | 可以新增帧型，但不能占用上表 9 个名字 | mp/core/client.js:248-249 |

前置容忍行为（必须知道）：非字符串 `data`（如 ArrayBuffer 二进制帧）、非法 JSON、
没有 `t` 的对象——**都在 `JSON.parse` try/catch 与 `!f.t` 处被丢弃，用户看不到任何提示**
（证据：mp/core/client.js:199-206）。推断：中继发任何非文本帧 = 手机端表现为「什么都不发生」。

### 2.2 数据面：客户端簿记的两种 payload

`_onEncrypted` 解密成功后，只对 `ev.session_changed` 与 `ev.keep_awake_state` 做簿记，
然后把**所有** payload 原样 `emit({kind:'payload', payload})` 给页面
（证据：mp/core/client.js:291-313）。

| payload | 客户端读的字段 | 落地位置 |
|---|---|---|
| `ev.session_changed` | `sessions`（数组；缺省视为 `[]` → **列表被清空**） | `client.sessions`（client.js:308-309、156） |
| `ev.keep_awake_state` | 整个 payload 对象 | `client.keepAwake`（client.js:310-311） |

### 2.3 ev.\* payload 字段表（精确到「少一个就显示不出来」）

约定：**必填** = 缺了页面就出错/显示不出来；**可选** = 有默认值；**UI 不读** = 仅测试/日志用。

#### `ev.message_delta`（聊天页流式文本，chat.js:87、99-144）

| 字段 | 类型 | 必需性 | 页面怎么用 | 少掉/改名的表现 |
|---|---|---|---|---|
| `t` | `'ev.message_delta'` | 必填 | 分发依据 | 收不到流式输出 |
| `sessionId` | 字符串（DSH 会话 id） | 可选；**有就必须等于当前页 id** | 过滤非本会话（chat.js:85） | 填错 id → 整页无输出；不带 id → 多个聊天页都会显示（串台） |
| `messageId` | 字符串，同一条助手消息内**稳定且唯一** | 事实必填 | delta 缓冲 key + 消息行定位（chat.js:101-114、131-141） | 缺失/固定值 → 不同消息的文本被拼成一段 |
| `delta` | 字符串（UTF-8，含 CJK/emoji 已在对拍测试覆盖） | 必填（可为空串） | 累加进文本气泡（chat.js:112） | 不是字符串→`+=` 出 `undefined` 字面量 |
| `done` | 布尔 | **必须有一条 `done:true`** | 结束转圈、隐藏光标（chat.js:113、142；chat.wxml:13） | 永远显示「运行中…」 |
| `part` | 数字 | UI 不读 | 仅出现在对拍测试的样例里 | 随便 |
| — | `MAX_TEXT_PER_MESSAGE=20000` 单条截断、`MAX_MESSAGES=300` 头部裁剪、`DELTA_FLUSH_MS=100`/`4096` 字符合帧 | | | |

证据：mp/pages/chat/chat.js:10-13、85-87、99-144；e2e/mp-crypto.test.mjs:78-91（`part` 字段与逐字节往返）。

#### `ev.tool_event`（工具调用行，chat.js:88、147-162）

| 字段 | 类型 | 必需性 | 用法 | 少了/改了 |
|---|---|---|---|---|
| `callId` | 字符串，同一调用稳定唯一 | **必填** | 原地更新同一行的索引 key（chat.js:153-159） | 缺失 → 所有工具事件挤进同一行，只显示最后一次状态 |
| `phase` | `'started'`/`'args'`/`'completed'`/`'failed'`（枚举，图标 ▶ · ✓ ✕） | 必填 | 图标 + 是否附 `resultPreview` 的判据（chat.js:15、149-151） | 未知值 → 图标退化为 `·`，且不显示 `resultPreview` |
| `tool` | 字符串 | 可选（缺省显示 `'tool'`） | 行文本主体 | — |
| `title` | 字符串 | 可选 | `— <title>` 后缀 | — |
| `resultPreview` | 字符串 | 可选；**只在 phase 为 completed/failed 时被显示** | `→ <preview>` | 提前发送不会显示 |
| `sessionId` | 字符串 | 同 message_delta 的过滤规则 | chat.js:85 | — |

#### `ev.permission_request`（审批卡，chat.js:89、165-183 + chat.wxml:21-36）

| 字段 | 类型 | 必需性 | 用法 | 少了/改了 |
|---|---|---|---|---|
| `requestId` | 字符串 | **必填** | 回填 `cmd.resolve_permission.requestId` | 卡片能显示但审批无效（主机认不出请求） |
| `action` | 字符串 | 可选（缺省 `'操作'`） | 卡主标题（mono） | — |
| `resource` | 字符串 | 可选（缺省 `''`，空则整行不渲染） | 第二行 | — |
| `reason` | 字符串 | 可选 | 第三行 muted | — |
| `options` | 数组 `[{id,label}]` | 可选；**空/缺失时客户端自造 `[{id:'approve',label:'允许'},{id:'reject',label:'拒绝'}]`** | chip 行；`item.id` 即回传的 `decision`（逐字） | id 改语义（例如把 `reject` 改名）→ 客户端 `decision!=='reject'` 判据失效，点「拒绝」后仍显示运行中（chat.js:255） |
| `sessionId` | 字符串 | 建议必填 | 既是过滤键，也是 `resolvePermission(sessionId,…)` 的参数（chat.js:256） | 不带 → 主机可能收到错误会话 |

注意：客户端会**同时**把 `running:false` 并振动一次（chat.js:180-182）。

#### `ev.question_request`（提问卡，chat.js:90、185-198 + chat.wxml:39-61）

| 字段 | 类型 | 必需性 | 用法 | 少了/改了 |
|---|---|---|---|---|
| `requestId` | 字符串 | **必填** | 回传 `cmd.answer.requestId` | 提交后主机无法匹配 |
| `questions` | 数组 | 必填（空数组=只有输入框） | `wx:for`，`wx:key="id"` | 字段改名 → 卡片空白 |
| `questions[].id` | 字符串 | **必填** | 回传 `answers[].questionId` | 主机收到 `questionId:undefined`，答案作废 |
| `questions[].question` | 字符串 | 必填 | 问题正文 | 空白 |
| `questions[].multi` | 布尔（真值判断） | 可选 | 多选/单选行为（chat.js:267-268） | 缺省即单选 |
| `questions[].options` | 数组 `[{id,label}]` | 可选（缺 `[]`） | chip；`o.id` 进 `selected[]` | id 与主机不一致 → 主机解不出选项 |
| `sessionId` | 字符串 | 同 delta 规则 | 过滤 + `answer(sessionId,…)` | — |

一个卡只有**一个**全局 `freeText` 输入框，提交时把同一个字符串复制给每个 question
（证据：mp/pages/chat/chat.js:196、291）。推断：主机不要指望每问独立自由文本。

#### `ev.run_state`（运行状态，chat.js:91、200-206）

| 字段 | 类型 | 必需性 | 用法 | 少了/改了 |
|---|---|---|---|---|
| `state` | `'running'` \| `'idle'`（其他值只置 `running:false`，**不清挂着的卡片**） | 必填 | 输入框「运行中…/空闲」与「中断」按钮显隐（chat.wxml:78-80） | 新增状态字符串 → 审批/提问卡不会自动消失 |
| `detail` | 字符串（现网用 `'interrupted'`） | UI 不读，仅测试断言 | e2e/mp-client.test.mjs:193-195、e2e/run.mjs:194-196 | — |
| `sessionId` | 字符串 | 建议必填 | 过滤 | — |

#### `ev.result`（命令回执，chat.js:92-95）

| 字段 | 类型 | 必需性 | 用法 | 说明 |
|---|---|---|---|---|
| `ok` | 布尔 | 必填 | `!ok && message` → toast | 失败反馈的唯一入口 |
| `message` | 字符串 | 可选 | toast 前 40 字 | — |
| `cmdId` | 字符串 | **UI 不读**（只有 e2e 用） | e2e/run.mjs:117、169 | 想验证链路可以，但手机不看 |
| `data` | 对象；`data.sessions[]`、`data.answered` | **UI 不读** | 只有测试读（e2e/mp-client.test.mjs:123-126、live-e2e.mjs:192-206） | **关键陷阱，见下** |

> **会话列表不来自 `ev.result`。** 页面只从 `client.sessions` 渲染，而 `client.sessions`
> 只被 `ev.session_changed` 写入（证据：mp/core/client.js:308-309；mp/pages/sessions/sessions.js:87-88、129-142）。
> host 必须在（a）客户端 `cmd.list_sessions` 之后、以及（b）任何改变会话状态之后
> **额外推一次 `ev.session_changed`**，否则手机列表永远为空——这正是文档里
> 「会话列表一直为空」那条故障的表现（docs/MINI-PROGRAM.md:91；且 client.js:285-287 的注释
> 明确说「主机在 peer-joined 时会推 sessions + keep-awake」）。

#### `ev.keep_awake_state`（防休眠状态，sessions.js:118-127 + sessions.wxml:17-19）

| 字段 | 类型 | 必需性 | 用法 | 少了/改了 |
|---|---|---|---|---|
| `enabled` | 布尔 | 必填（`!!` 取值） | 开关位置 | 名字改 → 开关永远灰在关 |
| `active` | 布尔 | 必填 | 文案「当前持锁中 / 当前未持锁」 | 缺省按 false 显示「未持锁」 |
| `backend` | 字符串 | 可选 | 追加 `' · ' + backend` | — |
| `platform` | 字符串 | UI 不读，**测试断言** | e2e/mp-client.test.mjs:183、e2e/run.mjs:180 | 重写后若不带会让这些测试红 |

`payload` 为 `null`（客户端初始态）时显示默认文案「运行中保持主机不睡」（sessions.js:119-121）。

#### `ev.session_changed` → `sessions[]` 元素字段表（最容易踩的一张表）

| 字段 | 类型 | 必需性 | 页面用法（sessions.js:129-142 / sessions.wxml:26-41） | 少了/改了的具体表现 |
|---|---|---|---|---|
| `id` | 字符串 | **必填、稳定、与 payload `sessionId` 同名同值** | `wx:key`、`data-id`、跳聊天页的参数、title/workspace 的兜底 | 缺失 → 标题与描述空白、`wx:key` 冲突、点进去 `id=undefined` |
| `state` | 字符串枚举：`'awaiting-permission'` `'awaiting-answer'` `'archived'` `'detached'` `'running'` `'idle'` | 必填 | 徽标文案+配色（sessions.js:9-16） | 拼错（如 `'awaiting_permission'`）→ 徽标退化为「空闲」，用户看不出这是**会被主机拒绝**的归档会话 |
| `running` | 布尔（真值判断） | 可选 | `state` 不匹配时的兜底「运行中」 | — |
| `title` | 字符串 | 可选（缺→用 `id`） | cell 标题、聊天页导航栏标题（chat.js:40 截 16 字） | — |
| `workspace` | 字符串 | 可选（缺→描述位显示 `id`） | cell 描述 | — |
| `updatedAt` | **必须是 ISO-8601 字符串**（`slice(11,19)` 取 `HH:MM:SS`） | 可选，但**给了就只能是字符串** | 时间角标（sessions.js:138） | 给数字时间戳 → `s.updatedAt.slice is not a function` 抛错；该异常被 `emit()` 吞掉（client.js:55-58）→ **整个会话列表静默不更新**，无任何提示 |

证据：mp/pages/sessions/sessions.js:9-16、129-142；mp/pages/sessions/sessions.wxml:26-41；
mp/core/client.js:53-61、308-309；e2e/live-e2e.mjs:202-206（打印 `id`/`state`/`title`，并断言不出现 `ses_mock*`）。

其他 payload 类型（`ev.*` 新名、或 host 自定义）：聊天页/会话页都不匹配 → **静默丢弃**
（证据：mp/pages/chat/chat.js:87-95 的 if 链末尾无 else；mp/core/client.js:308-312）。

---

## 3. 小程序的容错与状态机

### 3.1 状态机（唯一状态字段 `status` + 中文 `statusText`）

`idle | connecting | pairing | online | needs-pair | error`（证据：mp/core/client.js:23）。
会话页把 `online`→「在线/success」、`connecting`/`pairing`→「连接中/primary」、`error`→「异常/danger」、
其余→「未连接/default」（sessions.js:18-30）；配对页同一套但文案是「已配对/未配对」（pair.js:7-19）。

| 迁移 | 触发 | 关键副作用 |
|---|---|---|
| →`connecting` | `connect()` 调用即置，并写 `serverUrl` 到 storage | 关闭旧 socket、新建（client.js:96-134） |
| →`pairing` | `hello-ok` 且本地有待用配对码 | 发 `pair-begin-client`（client.js:255-257） |
| →`online` | `hello-ok`+已配对（「已连接，正在恢复会话」）或 `paired`（「已配对到 <hostLabel‖hostId‖主机>」） | 发 `cmd.list_sessions`（client.js:259-261、284-287） |
| →`needs-pair` | 无 server（「请先扫码或填写中继服务地址」）、`hello-ok`+未配对（「请输入主机上的 6 位配对码」）、`pair-fail`、`peer-left`、`unknown_session`、解密两次失败、`unpair()` | 见 §3.2-3.4 |
| →`idle` | `disconnect()`：「已断开」（client.js:136-140） | `sock.close()` → 停止重连（socket.js:114-127） |
| `onClose` 时 | 只要当前 status 不是 `needs-pair` 就重新置 `connecting`「连接已断开，正在重连…」 | client.js:126-128 |

页面 `paired` 这个 data 只在会话页 `onShow` 重算（sessions.js:50-63）；推断：`peer-left` 之后
不离开页面时，会话页仍停留在「已配对」骨架上、列表被清空，直到用户再次进入或下拉。

### 3.2 解密失败：**两次**才重置配对

`_onEncrypted` 拿不到明文时：第 1 次只 `emit error`「有一条数据无法解密，若持续出现请重新扫码配对」；
累计 `>=2` 次调 `_resetPairing('配对已失效（密钥不匹配），请重新扫码')` —— 它会 **断开 socket
（因此停止重连）+ 清配对 + `needs-pair`**（证据：mp/core/client.js:291-314、162-167、143-159）。
任何一次成功解密会把计数清零（client.js:306）。

WHY：一次坏帧不该杀一个健康配对（client.js:296-298 注释）；但密钥真错了就每帧都错，
不能让用户对着空列表发呆。**对新中继的硬约束**：只要有任何一帧到了客户端解不开（例如
`sessionId`→conv 映射搞错、host 用了错 PSK 的 key），连续两帧之后手机就**永久掉线**并要重新扫码
（docs/MINI-PROGRAM.md:90；HANDOFF.md:114-117 记录的就是这个 bug 的真实成因）。

### 3.3 `peer-left` 与 `unknown_session`：都清配对，但**不关 socket**

- `peer-left`：`_forgetPairing()`（清 convId/keys/sessions/keepAwake/decryptFails）+ `needs-pair`
  「主机已断开，请重新配对」（证据：mp/core/client.js:219-223、150-159）。
- `error.code === 'unknown_session'`（**字符串逐字比较**）：同样 `_forgetPairing()` + `needs-pair`
  「会话已失效，请重新配对」（证据：mp/core/client.js:227-231）。
- 因为 socket 没被 `close()`，它继续重连；重连后的 `hello-ok` 会把文案换成「请输入主机上的 6 位配对码」
  （证据：mp/core/client.js:126-128、259-263）。
- **对新中继的硬要求**：客户端带一个中继不认识的 `sessionId` 发 `enc` 时，中继**必须回
  `error{code:'unknown_session'}`**，不能只是丢弃、也不能只断开连接。只断开的表现是
  「连接已断开，正在重连…」循环 + 空列表，用户永远看不到「请重新配对」（证据：
  e2e/mp-client.test.mjs:209-219 断言的是 `needs-pair` 状态而不是 socket 关闭；docs/SELF-HOSTING.md:219-220）。
- host 掉线时中继必须发 `peer-left`（而非静默关闭），否则客户端会停在 `online` + 空列表
  （证据：docs/SELF-HOSTING.md:224；mp/core/client.js:219-223）。

### 3.4 `pair-fail.reason` 枚举与中文文案（逐字）

| reason（线上值） | 客户端文案（`'配对失败：' + …`） | 证据 |
|---|---|---|
| `invalid_or_expired` | `配对失败：配对码无效或已过期` | client.js:357-362、357-364；docs/MINI-PROGRAM.md:87 |
| `already_used` | `配对失败：配对码已被使用` | 同上；docs/MINI-PROGRAM.md:88 |
| `host_offline` | `配对失败：主机不在线` | 同上；docs/MINI-PROGRAM.md:89 |
| `bad_token` | `配对失败：令牌错误` | client.js:361 |
| 其他非空值 | 原样透出（`配对失败：<reason>`） | client.js:363 |
| `undefined`/空 | `配对失败：未知原因` | client.js:363 |

WHY 这段是契约：`e2e/live-e2e.mjs:170` 用正则 `/已被使用|无效或已过期|already_used|invalid_or_expired/`
决定是否换新码重试。新增 reason 不会崩，但线上真机重连策略会把它当「硬失败」（推断）。
另外这四个 reason 是配对唯一性/TTL 语义的可见面（docs/SECURITY.md:54-56、docs/SELF-HOSTING.md:18-19）。

### 3.5 `enc-batch` 必须能解

`{t:'enc-batch', sessionId, items:[{ciphertext}]}`：客户端按数组顺序逐项解密并分发；
`items` 不是数组则整批丢弃（证据：mp/core/client.js:240-247）。host 侧目前不发批量，
但中继→客户端可以合并（证据：mp/core/client.js:241 注释「协议里有定义…收到时必须能解」、HANDOFF.md:129）。
批量帧里**不需要** `seq`，客户端也不看；但每一项必须能单独用 kH2C 解开（即 `ciphertext` 内含各自 nonce）。

### 3.6 `seq` / `clientId`：客户端自己怎么用，中继能不能改语义

事实：

- `seq` 只是客户端实例上的自增整数（`++this.seq`），**入站帧的 `seq` 客户端从不读取**，
  出站 `enc` 之外没有任何地方用到它（证据：mp/core/client.js:30、187；291-313 只用 `ciphertext`）。
- `seq` 不参与密钥、不参与 nonce。
- `clientId` = installId（首次 `hydrate()` 时生成并持久化），中继若在下行 `hello-ok.clientId`
  里下发别的值，客户端会**改用它**并在后续 `enc` 帧带上（证据：mp/core/client.js:72、121、188、254）。
- `e2e/run.mjs:116` 的 `enc` 帧**不带** `clientId` 也能跑通；`e2e/multi-pair.test.mjs:112-118` 带。
  → 中继不能把 `clientId` 当必填。

结论（对新实现的约束）：

1. **中继不得按 convId 校验 `seq` 单调递增。** 小程序每次冷启动都会带同一个 convId 从 `seq=1` 重新开始
   （`hydrate()` 只恢复 server/psk/convId，不恢复 seq），强制单调会让「杀掉小程序再打开」永远失败
   （证据：mp/core/client.js:30、71-86、187）。
2. **中继不得重排或要求顺序**：客户端无去重、无排序能力；顺序性只能由「同一连接内 FIFO + host 侧单流」
   保证。推断：中继若做多路复用/异步转发，必须保证 per-conversation 串行，否则聊天文本会错序
   （`e2e/run.mjs:122-147` 断言的是「合并后顺序不乱、帧数不膨胀」）。
3. 中继**可以**自己改写/丢弃 `seq` 与 `clientId`（客户端不消费），但只要改写外层 `sessionId`
   就会让 host 侧找不到 conv → 回不了正确的 key → 触发 §3.2 的两次解密失败掉线。
4. `clientId` 是**非秘密**的弱随机 id（`Date.now()` + `Math.random()`），不得当中继认证凭据；
   客户端凭据只有 convId + PSK 派生密钥（证据：mp/core/codec.js:204-212；docs/SECURITY.md:131）。

---

## 4. 配对入口的 URI 契约

`parsePairingQr(text)` 的完整可接受/不可接受集合（证据：mp/core/codec.js:151-197）：

语法：`dshr:/p?v=1&s=<ws地址>&n=<label>&psk=<base64>[&t=<6位码>]`，参数顺序任意
（证据：mp/core/codec.js:145-150 注释、mp/pages/pair/pair.js:165-169 报错文案「二维码应以 `dshr:/p?` 开头」；
docs/MINI-PROGRAM.md:111-115）。

**必须满足（否则返回 `null`，页面弹「无法识别」modal）**

| 条件 | 行为 | 证据 |
|---|---|---|
| 以 `dshr:` **开头**（区分大小写、位置必须是 0） | 否则 `null`；`DSHR:` / 前有空格 / 其他 scheme 全拒 | codec.js:153-154 |
| 必须含 `?` | 否则 `null` | codec.js:155-156 |
| `psk` 非空 **且** `s` 非空 | 任一为空 → `null` | codec.js:158-160 |
| 整体不得抛异常 | 任何异常 → `null`（静默） | codec.js:171-173 |

**宽松/兼容项（新 host 生成二维码时必须照做的方向）**

| 项 | 语义 | 证据 |
|---|---|---|
| `+` 未编码兼容 | 第一遍按 URLSearchParams 把 `+` 当空格；若解出的 `psk` 含空格，则**用「`+` 不转空格」再解一遍**，第二遍的 `psk` 无空格才采用；此时若 `s` 缺失或也含空格，一并换成第二遍的值 | codec.js:147-149 注释、161-167 |
| 因此两种写法都可用：`psk=Ab+C%2F%3D`（原样 `+`）与 `psk=Ab%2BC%2F%3D`（百分号编码）；但**推荐 `%2B`** | — | 推断：由 codec.js:161-167 的重试条件（只在 psk 含空格时才重试） |
| `t` 可选且必须 `/^\d{6}$/` | 不匹配（如 `t=12`、`t=abc123`、7 位）→ `token:''`（**不报错、不透传**） | codec.js:169；e2e/mp-crypto.test.mjs:134-136 |
| `n` 可选 | 缺省 `'dsh'`；随后被写进 `client.hostLabel` 与状态文案 | codec.js:170；pair.js:204-213 |
| `v` **不校验** | 返回对象里 `v` 恒为数字 `1`，与线上值无关（所以 host 也不能靠 `v` 让旧客户端拒接） | codec.js:170 |
| 百分号编码 | `decodeURIComponent`；非法 `%` 序列不抛错而是回退原串 | codec.js:189-197 |
| 值里含 `=` | 只按第一个 `=` 切分，其余留在值里（base64 尾部 `=` 安全） | codec.js:180-184 |
| 重复键 | 后者覆盖前者 | codec.js:184 |
| 未知键 | 忽略 | codec.js:176-187 |
| 不支持 `#fragment`、不支持值里的裸 `&` | 会污染最后一个/后续参数 | 推断：codec.js:157、179 |

**配对码的另一条入口（粘贴 6 位码）**：`onPaste` 先按 `dshr:` 解；解不出就把文本里所有非数字剔掉，
凑成 6 位就当配对码填上（证据：mp/pages/pair/pair.js:186-201）。手输框同样剔非数字、截 6 位
（pair.js:227-231）。`normalizePairingToken` 只剔空格与 `-`（codec.js:200-202）。

**手工发 PSK 的兜底**：高级设置里可直接填「中继 + 密钥」，`onPair` 校验
`^wss?://`、psk 非空、`/^\d{6}$/`（证据：pair.js:242-263）。→ 新中继**必须**接受用户手填的任意
`ws://` / `wss://` URL（含路径、端口），不得要求特定 path（现网两种写法都在用：
`ws://127.0.0.1:8787`（docs/MINI-PROGRAM.md:14）与 `wss://drc.provid.cc`（live-e2e.mjs:37）、
`wss://drc.example.com/ws`（mp-crypto.test.mjs:113））。

---

## 5. nonce 与计数器语义

### 5.1 installId

- 生成：`codec.randomId()` = `Date.now().toString(36) + '-' + Math.random() 两段 base36`（**非密码学随机**）
  （证据：mp/core/codec.js:204-212；mp/core/session-store.js:46-53）。
- 持久化键：`drc.installId`（`wx.setStorageSync`，应用沙箱内）（session-store.js:13、46-53）。
- 复用面：既是控制面 `clientId`，也是 nonce 前缀的输入（session-store.js:46-53；
  client.js:72；codec.js:123-125）。

### 5.2 计数器存在哪

| storage 键 | 内容 | 证据 |
|---|---|---|
| `drc.pairing.v1` | 整个配对对象 `{server, psk, convId, hostId, hostLabel, nonceCounter, pairedAt}` | client.js:273-283；session-store.js:11、74-76 |
| `drc.installId` | installId | session-store.js:12、46-53 |
| `drc.serverUrl` | 上次连的中继地址（`connect()` 无 server 时的兜底） | session-store.js:13、93-98；client.js:84、98-100 |
| `drc.keepAwakePref` | 定义了导出 API 但**当前无任何调用方**（死键） | session-store.js:14、101-107；对 pages 的 grep 无命中 |

- `nextNonceFor(pairing)`：`counter = Number(pairing.nonceCounter||0)+1` → **先写回 storage（同步 setStorageSync）再算 nonce**
  （证据：mp/core/session-store.js:85-91）。
- nonce = `noncePrefix(psk, convId, installId)`（16B，`SHA-512('dsh-rc/v1/nonce'␟installId␟convId␟pskRaw)[0..16]`）
  ‖ `counter` 的 8 字节大端（证据：mp/core/codec.js:123-142；docs/SECURITY.md:78-81）。
- 唯一性论证（代码自述）：key 已绑定 (PSK, convId, 方向)，计数器单调；清库时 installId 一起变，前缀就变
  （证据：mp/core/codec.js:118-125；mp/core/session-store.js:42-45）。
- 每次 `sendCmd` 都取一个新计数值，**即使 socket 没开、发送返回 false 也已经消耗**
  （证据：mp/core/client.js:175-190 → 183 在 184 之前；mp/core/socket.js:104-112 无 task 时返回 false）。

### 5.3 清空的后果

- 清 storage → `installId` 重新生成 → nonce 前缀变 → 旧 (key,nonce) 组合不可能复用；同时
  `drc.pairing.v1` 也没了 → `loadPairing()` 返回 null（要求 server/psk/convId 三者齐全）→ 未配对 →
  需要重新扫码（证据：mp/core/session-store.js:67-72；mp/core/client.js:71-90；docs/SECURITY.md:120-123）。
- 只清 `drc.installId`（不可能，同一存储区）：后果同样是前缀变化，不会撞 nonce。
- 反过来说：**主机侧看到的 nonce 计数器允许出现空洞，也允许从一个任意值开始**。

### 5.4 新 host 必须配合什么（从代码事实回答）

1. **不能假设客户端 nonce 连续**：计数器在发出前就 +1，丢帧/发送失败都会造成空洞
   （mp/core/client.js:175-190、mp/core/session-store.js:85-91）。
2. **不能假设 nonce 单调可追踪**：中继可以乱序/重复投递（中继不改语义，§3.6），host 也看不到
   installId（它在 nonce 内部）。host 只能：用 kC2H 解出明文即可信。
3. **重放：既不拒绝也无法拒绝**——中继不记录已见 nonce（docs/SECURITY.md:132），客户端没有任何
   去重/序号确认（§3.6）。安全性的实际支点是「密钥按配对轮换 + 方向分离」，重放到别的会话无效
   （docs/SECURITY.md:56、132）。推断：host 侧应以 `cmdId` 做幂等（客户端生成的 cmdId 唯一性由
   时间戳+自增保证，client.js:193-196），但**不得因重放而回 `ok:false` 打搅用户**。
4. **`seal()` 强制显式 nonce**：小程序侧无 CSPRNG，任何要求客户端「随机 nonce」的新方案都跑不起来
   （mp/core/codec.js:14-15、90-93）。
5. **下行方向 host 可以用随机 nonce**（Node 侧有 CSPRNG）——现网就是这样，测试也这么断言
   （e2e/mp-crypto.test.mjs:78-91 用 `nodeSeal` 随机 nonce 连开 25 次）。
6. host **必须**为每条 `ev.message_delta` 流最终给出 `done:true`，且不能把空文本的 done 帧丢掉
   （HANDOFF.md:126-128；mp/pages/chat/chat.js:123、142）。

---

## 6. 运行环境限制 → 对新中继与新 host 的约束

| 限制（事实） | 证据 | 对新实现的约束 |
|---|---|---|
| 无 `Buffer`、无 `TextEncoder/TextDecoder`：UTF-8/base64 一律走 vendored js-base64 | mp/core/codec.js:8-12、28-56；HANDOFF.md:133 | 线格式必须是「纯 JS 可编解码」的 base64/UTF-8；不得要求客户端做 base64url、hex、msgpack、gzip、分片重组 |
| **base64 是带 padding 的标准 base64**，与 `Buffer.toString('base64')` 逐字节一致 | e2e/mp-crypto.test.mjs:34-42 | 中继/host 不得改成 base64url、不得去 padding、不得插入换行（客户端只容忍 `open()` 前的空白字符剥离：codec.js:54-56） |
| 无 CSPRNG：`nacl.randomBytes` 被主动禁用（只认 `self/globalThis.crypto`，否则不初始化，宁可抛错） | mp/core/vendor/nacl-fast.js 末尾补丁注释；docs/SECURITY.md:63-70；HANDOFF.md:133-137 | 新协议不得要求客户端生成随机数（含新 KDF、X25519、签名、随机 nonce）；docs/HANDOFF.md:186-189 已因此否决 X25519 |
| 小程序有 `require` 但**无 `crypto` 模块** → 上游 tweetnacl 的 PRNG 探测会让整文件加载即崩，故 vendor 版打了补丁；升级 tweetnacl 必须重打 | mp/core/vendor/nacl-fast.js 补丁注释；docs/MINI-PROGRAM.md:56-68；HANDOFF.md:134-137 | 「客户端不变」= 加密原语固定为 `nacl.secretbox` + `nacl.hash(SHA-512)`；换算法 = 手机坏 |
| KDF 只有一处定义：`SHA-512('dsh-rc/v1'␟dir␟convId␟pskRaw)[0..32]`，**每个部分后都补 0x1f（含末尾）**，取前 32 字节 | mp/core/codec.js:22-24、60-81 | 新 protocol 必须逐字节实现同一函数，并用对拍测试守住（e2e/mp-crypto.test.mjs:59-64） |
| WS 双路径：SocketTask（基础库 1.7.0+）与旧式全局回调 `onSocketOpen/onSocketMessage/sendSocketMessage`；探测顺序 `wx,my,tt,qq,swan,jd` | mp/core/socket.js:1-14、45-102、163-208；mp/core/env.js:18-33、76-77；e2e/mp-platform.test.mjs:65-135 | 中继必须同时接受「一个连接只服务一个 SocketTask」与「宿主全局单 socket」两种形态；旧式路径下 `send` 走全局 `sendSocketMessage`，**不得要求客户端在同一连接上并发多路** |
| 无 `connectSocket` 的容器：`_fatal()` 置 `_manualClose=true`（**停止重连**）并抛 `code:'SOCKET_UNAVAILABLE'` 的描述性错误；页面弹 modal + 可复制诊断行 | mp/core/socket.js:50-55、254-258；mp/core/env.js:120-130；mp/pages/pair/pair.js:118-135、pair.wxml:4-11；e2e/mp-platform.test.mjs:39-63 | 不存在 HTTP/长轮询兜底：中继只能做 WS（协议 WS-only，docs/MINI-PROGRAM.md:126） |
| 连接超时 12s（`CONNECT_TIMEOUT_MS`），之后主动关闭 + 指数退避重连 1s→30s（+0~500ms 抖动） | mp/core/socket.js:19-22、214-234、243-252 | 中继不能指望客户端「快速失败」；握手必须无额外往返（无 TLS client-auth、无 HTTP upgrade 挑战、无 OAuth）。重连风暴要靠中继侧配额，而不是靠客户端退避 |
| 帧必须**文本**：`onMessage` 直接把 `res.data` 交给 `JSON.parse` | mp/core/socket.js:150、194-197；mp/core/client.js:199-206 | 中继/host 禁止 binary frame；发 binary 的表现是「全部静默丢弃」 |
| 单帧上限现网 262144（超出 close 1009）；现网最大往返样例是 60KB 明文 delta | docs/SELF-HOSTING.md:14；e2e/mp-crypto.test.mjs:106-110 | 新中继的帧上限不得调低到 ~100KB 以下，否则大 delta/工具预览会被切断并触发重连循环 |
| 客户端无节流：每秒帧数配额在服务端（现网 500/s） | docs/SELF-HOSTING.md:16 | host/中继若限流，不要用 `error` 帧刷屏——每个 `error{code≠unknown_session}` 都会在会话页/聊天页变成 toast（mp/core/client.js:232；mp/pages/sessions/sessions.js:93-95） |
| 主包 2MB；TDesign 已按依赖闭包裁剪成预置产物 `miniprogram_npm/`（约 1.5MB 含 tslib）；**不要点「构建 npm」**；`node_modules/`、`core/package.json`、`package-lock.json` 已在 `packOptions.ignore` | docs/MINI-PROGRAM.md:3-5、17-21；HANDOFF.md:141-144；mp/project.config.json:43-59；mp/package.json（依赖仅 tdesign + js-base64） | 任何「需要客户端加库」的能力都无法上线（例如新压缩/新编码/新密码学）。新实现必须在现有客户端能力内闭环；`mp/core/package.json` 只是给 Node 测试标 CommonJS 的，小程序无视（docs/MINI-PROGRAM.md:39；HANDOFF.md:138） |
| `es6: true` + `minified`：class/箭头函数可用，但不能假设有 `async/await` 之外的运行时（无 polyfill 来源） | mp/project.config.json:10、13（`es6:true`、`minified:true`）；mp/core/client.js:21-28（class 语法） | 推断：新实现若要客户端配合协议演进，实际不可能——只能靠「未知帧忽略」向前兼容 |

（另：HANDOFF.md:147-148 的 `input` 组件高度约束属纯样式，与协议无关，仅作背景。）

---

## 7. UI 能力盘点

`mp/app.json` 只注册三页，入口是 `pages/sessions/sessions`（证据：mp/app.json:2-6）。。
`app.js` 持有 `DrcClient` 单例，`onShow` 时若已配对且 socket 丢了就自动 `connect()`
（证据：mp/app.js:10-19；mp/core/client.js:366-370）。

| 页面 | 做的事 | 依赖的协议能力 |
|---|---|---|
| sessions（入口） | 主机状态标签 + 防休眠开关 + 会话列表（含徽标）+ 下拉刷新 + 去配对/重新配对 | `ev.session_changed`、`ev.keep_awake_state`、`cmd.list_sessions`、`cmd.keep_awake`、status 事件（sessions.js:50-63、86-160） |
| pair | 扫码 / 粘贴 `dshr:` / 粘贴 6 位码 / 高级设置手填中继+PSK / 配对 / 解除配对 / 环境自检复制 | `hello`、`pair-begin-client`、`paired`、`pair-fail`、`parsePairingQr`、`env.summary`（pair.js:139-281） |
| chat | 流式气泡 + 工具行 + 审批卡 + 提问卡 + 中断 + 输入区（`confirm-type=send`） | `cmd.send_prompt`、`cmd.interrupt`、`cmd.resolve_permission`、`cmd.answer`、`ev.message_delta`、`ev.tool_event`、`ev.permission_request`、`ev.question_request`、`ev.run_state`、`ev.result`（chat.js:74-299） |

**已有 UI 且已真机验证**：配对（含二维码内嵌 `t=` 扫码即连）、会话列表（含 `已归档` 徽标）、
发指令、流式输出、工具行、防休眠开关、中断、解除配对。
（证据：HANDOFF.md:19-21「工具型指令真实执行回传 ✅、归档会话自动恢复 ✅」；
docs/MINI-PROGRAM.md:111-115；sessions.js:12 的 archived 分支是「旧版漏了」补上的。）

**协议里有字段、但没有任何 UI**（新实现不要指望手机能操作它们）：

| 能力 | 现状 | 证据 |
|---|---|---|
| `cmd.send_prompt.attachments`（图片/文件） | 客户端从不填这个字段；`sendPrompt(sessionId, text)` 只有两个参数 | client.js:321-323；docs/MINI-PROGRAM.md:123；HANDOFF.md:178 |
| 多主机切换 | 单配对存储（`drc.pairing.v1` 只有一个对象），重新配对直接覆盖 | session-store.js:11、74-76；client.js:273-283；HANDOFF.md:178 |
| 会话标题/重命名、归档/取消归档、删除 | 无 UI；归档只能靠 host 侧在发指令时自动恢复 | 全 pages grep 无相关 cmd；HANDOFF.md:104-106 |
| 模型选择、preset、权限策略配置 | 无 UI、无 cmd | client.js:317-353 的便捷方法就是全部出站能力 |
| `ev.result.data`（含 `data.sessions`）、`cmdId` | **有数据无 UI**：列表页不看 `ev.result` | client.js:308-309；sessions.js:87-88；对照 e2e/mp-client.test.mjs:123-126 |
| `ev.message_delta.part`、`ev.run_state.detail`、`ev.keep_awake_state.platform` | 有字段无 UI（`platform`/`detail` 仅测试用） | chat.js:99-144、200-206；e2e/mp-client.test.mjs:183、193-195 |
| `peer-joined` 的 notice | 客户端发了 `{kind:'notice'}`，**没有页面处理 → 用户看不到「新客户端加入」** | client.js:224-226；三页 `_onEvent` 均无 notice 分支 |
| 消息历史持久化 | 只有内存流，页面卸载即丢（300 条上限 + 头部裁剪 + 一条省略提示） | chat.js:10、209-219；docs/MINI-PROGRAM.md:125 |

**已实现但从未在真机验证过的 UI**：**审批卡**与**提问卡**。
原因写在案：本机所有会话 preset 都是 `danger-full-access` + `approval/policy: never`，永远不弹
（证据：HANDOFF.md:22、HANDOFF.md:175-177「代码路径有单测和 mock e2e 覆盖，但真机没跑过」）。
→ 新 host 改这两条链路时，回归只能靠 `e2e/mp-client.test.mjs:129-177` 与 `e2e/run.mjs:149-172`
这两个 **mock/真代码混跑**的用例；它们对字段名的断言是：`sessionId`、`requestId`、
`options[].id==='approve'`、`questions[0].question`、回传 `[{questionId:'q1',selected:['staging']}]`
（证据：e2e/mp-client.test.mjs:142-168；e2e/run.mjs:151-171）。

---

## 8. 兼容红线清单（新实现逐条自查）

改动任何一条 → 手机端的具体表现列在最后。

| # | 红线（不可改） | 违反后手机端表现 | 证据 |
|---|---|---|---|
| 1 | 线格式字节级：`ciphertext = base64(nonce(24) ‖ secretbox(utf8(JSON), nonce, key))`，标准 base64 带 padding，字段名就叫 `ciphertext` | 每一帧解密失败；两帧后掉到「配对已失效…请重新扫码」 | codec.js:90-115；e2e/mp-crypto.test.mjs:66-104 |
| 2 | KDF：`SHA-512('dsh-rc/v1'␟dir␟convId␟pskRaw␟)[0..32]`（**每段后都补 0x1f**，psk 用**原始字节**不是 base64 文本），方向串字面量 `'c2h'`/`'h2c'` | 双向全部无法解密 → 空列表 + 掉线；表现同 #1 | codec.js:22-24、60-81 |
| 3 | nonce 前缀：`SHA-512('dsh-rc/v1/nonce'␟installId␟convId␟pskRaw␟)[0..16]` + 8 字节**大端**计数器 | 只是前缀改变不会立即崩，但 host 若试图推断/校验计数器就会误杀；改字节序 → 新旧端 nonce 复用风险 | codec.js:118-142；e2e/mp-crypto.test.mjs:139-157 |
| 4 | 帧必须是**文本 JSON**；明文帧字段名 `t`；`enc` 外层 `sessionId`=convId（`c_` 前缀） | 二进制/非 JSON 静默丢弃（手机永远转圈）；外层 sessionId 错 → host 用错 key → 触发 #1 | client.js:199-206、184-190；HANDOFF.md:109-110 |
| 5 | 帧名枚举：`hello-ok` / `paired` / `pair-fail` / `peer-left` / `peer-joined` / `error` / `pong` / `enc` / `enc-batch` 的既有语义不得挪用；新帧名必须落在 `default` 分支 | 名字被复用 = 客户端执行错误状态机（例：把心跳响应叫 `peer-left` → 每次心跳就丢配对） | client.js:208-250 |
| 6 | `hello-ok` **必发**（`hello` 之后）；`paired.sessionId` **必发** | 无 `hello-ok`：永远停在「正在连接 …」（12s 后超时重连循环，但不会报错）；无 `sessionId`：convId 变 `undefined`，后续全崩 | client.js:253-288；socket.js:214-234 |
| 7 | `error.code` 用字面量 `'unknown_session'`（会话丢失时）、`peer-left`（host 掉线时）必须发到客户端 | 只断连接 → 用户看到「连接已断开，正在重连…」+ 空列表，永远不知道要重新扫码 | client.js:219-231；docs/SELF-HOSTING.md:219-224 |
| 8 | `pair-fail.reason` 枚举值：`invalid_or_expired` / `already_used` / `host_offline` / `bad_token` | 中文文案退化成裸 reason（能看但不可读）；`live-e2e` 的重试判据失效 | client.js:356-364；e2e/live-e2e.mjs:170 |
| 9 | `ev.session_changed{sessions:[…]}` 是列表的**唯一**数据源；元素字段 `id`/`state`/`running`/`title`/`workspace`/`updatedAt` 名字与类型固定；`state` 枚举含 `awaiting-permission`、`awaiting-answer`、`archived`、`detached`、`running`、`idle`；`updatedAt` 只能是 ISO 字符串或不下发 | 列表全空；或（`updatedAt` 给数字）整次渲染抛错被吞 → 列表**静默**不更新；`archived` 拼错 → 归档会话看起来像普通空闲会话，用户发指令被主机拒但毫无提示 | client.js:308-309；sessions.js:9-16、129-142 |
| 10 | host 必须在 `cmd.list_sessions` 与任何状态变更后**额外推 `ev.session_changed`**（`ev.result.data.sessions` 手机不看） | 会话列表永远为空（就是 FAQ 里那条） | client.js:285-287；sessions.js:87-88；docs/MINI-PROGRAM.md:91 |
| 11 | 数据面 payload 的 `sessionId` = **DSH 会话 id**（与 `sessions[].id` 同名同值），不是 convId | 聊天页 `p.sessionId !== this.data.sessionId` 全部过滤掉 → 页面完全无输出 | chat.js:85；HANDOFF.md:109-110 |
| 12 | `ev.message_delta` 字段名 `messageId`/`delta`/`done`；每条消息必须最终有 `done:true`（含空文本 done 帧不得被合并逻辑吞掉） | 转圈永不结束（「运行中…」卡死）；`messageId` 缺失/重名 → 不同消息串成一段 | chat.js:85、99-144；HANDOFF.md:126-128 |
| 13 | `ev.tool_event` 的 `phase` 枚举 `started/args/completed/failed`；`callId` 稳定唯一；`resultPreview` 只在终态显示 | 工具行只剩一行、图标全 `·`、预览不出现 | chat.js:15、147-162 |
| 14 | 审批：`requestId` 必填、`options[].{id,label}`；**回传的 `decision` 就是主机下发的 `options[].id` 逐字值**；`'reject'` 有 UI 语义（非 reject 视为继续运行） | 手机点允许后主机解不出 decision → 回合卡死；把 `reject` 改名 → 点「拒绝」后界面仍显示运行中 | chat.js:165-183、251-257；e2e/run.mjs:151-156 |
| 15 | 提问：`requestId`、`questions[].{id,question,multi,options[].{id,label}}`；回传 `answers=[{questionId,selected:[id],freeText?}]`（顺序同 `questions`，`freeText` 是**整卡共享**、可为缺省） | 提交后主机无法映射问题 → 提问卡不消失 | chat.js:185-198、279-299；e2e/mp-client.test.mjs:161-176 |
| 16 | `ev.run_state.state` 只有 `'running'`/`'idle'` 会清挂着的审批/提问卡 | 引入新状态值 → 卡片挂在屏幕上不消失 | chat.js:200-206 |
| 17 | `ev.keep_awake_state.{enabled,active,backend}`；`platform` 供测试 | 开关状态回显错误 | sessions.js:118-127；e2e/mp-client.test.mjs:179-186 |
| 18 | `enc-batch{sessionId, items:[{ciphertext}]}` 必须逐项可解、保持数组顺序 | 批量帧整批丢弃或单项失败计数 → #1 | client.js:240-247 |
| 19 | `seq` 不得按 convId 校验单调（冷启动必从 1 重来）；`clientId` 在 `enc` 帧上**可选**（`e2e/run.mjs` 就不带）；`seq`/`clientId` 都不参与安全 | 强制单调 = 杀掉小程序再打开就永远连不上；把 clientId 当凭据 = 伪造/清空即锁死 | client.js:30、71-86、184-190；e2e/run.mjs:116；e2e/multi-pair.test.mjs:112-118 |
| 20 | 不得要求客户端新增任何控制帧/心跳/凭据/认证流程；不得要求客户端生成随机数或跑新 KDF；不得要求 binary/压缩/新编码 | 客户端无法配合 = 功能在手机上直接不存在 | client.js:116-134（只发 hello）；codec.js:14-15；socket.js:104-112；docs/SECURITY.md:63-76 |
| 21 | 配对 URI：`dshr:` 前缀 + `?` + `s`&`psk` 必填 + `n` 缺省 `'dsh'` + `t` 必须 6 位数字否则丢弃 + `v` 不校验 + 未编码 `+` 需能被重试解出 | 扫不出来 = 「无法识别」modal，用户连配对页都过不去 | codec.js:151-197；pair.js:165-171；e2e/mp-crypto.test.mjs:112-137 |
| 22 | PSK 必须是**合法标准 base64（16B）**；`paired` 之后客户端会 `derivePskKey` 里同步解码 | 非法 base64 → `_onPaired` 抛异常且不在 try/catch 内（socket 回调栈） → 消息处理中断，界面卡在「正在配对…」 | codec.js:79-81、54-56；client.js:271-272 |
| 23 | 单帧上限保持 ≥256KB、文本帧、per-conversation 串行 | 大 delta 被 1009 切断 → 重连循环；乱序 → 文本错序 | docs/SELF-HOSTING.md:14；e2e/mp-crypto.test.mjs:106-110；e2e/run.mjs:130-147 |
| 24 | 中继保持零知识：控制面不得携带任何业务明文 | 泄露（现网用帧审计断言 `cmd.send_prompt`、指令正文不出现在任何服务端可见帧里） | e2e/run.mjs:198-213；e2e/live-e2e.mjs:274-283；docs/SECURITY.md:19-26 |
| 25 | 不得把「需要客户端加依赖/构建 npm」当方案（主包 2MB、TDesign 已裁剪 1.5MB、`packOptions.ignore` 生效） | 上传包超限或产物被全量包覆盖，直接发不出版本 | docs/MINI-PROGRAM.md:3-5、17-21；HANDOFF.md:141-144；mp/project.config.json |

**「新实现能通过什么测试」的最小判据**（这些测试真的在跑 `mp/core` 源码，不是仿真）：

- `e2e/mp-sim.mjs` 提供最小 `wx` shim（storage 三件套 + `connectSocket`→`ws` 包 SocketTask +
  四个 no-op UI API），`loadMpModules()` **绕过 require 缓存加载真实 `mp/core/*.js`**
  （证据：e2e/mp-sim.mjs:21-77）。所以任何新 host/中继只要偏离本文，这些用例会红。
- `e2e/mp-crypto.test.mjs`（11 项）：base64/UTF-8 与 Buffer/TextEncoder 对拍、双向 KDF、
  MP密封→Node打开、Node密封→MP打开、篡改与错 key 必须返回 `null`、60KB 载荷、QR 双端解析一致
  （含内嵌 `t` 与畸形 `t`）、nonce 前缀稳定性与 24B 单调（证据：该文件 34-157）。
- `e2e/mp-client.test.mjs`（8 项）：真实 client 跑完整闭环——配对→列表→delta→tool→审批→批准→done→
  提问→回答→防休眠→中断→nonce 不重复→陈旧 conv 报 `needs-pair`（证据：该文件 101-219；
  注意 §4.8 的教训「测试别跨边界切断连续异步链」，所以审批流必须在一个 test 内，见 129-159）。
- `e2e/mp-platform.test.mjs`（3 项）：无 `connectSocket` 必须给描述性错误（`code:'SOCKET_UNAVAILABLE'`、
  绝不抛 TypeError、只报一次）；只有旧式全局回调的容器必须能连能发；probe 必须认出非 `wx` 宿主（证据：该文件 39-135）。
- 真链路判据：`e2e/live-e2e.mjs`（真实 mp 代码 + 线上中继 + 真实内核，拿不到真码就失败，绝不退 mock）
  （证据：e2e/live-e2e.mjs:1-19、102-292；HANDOFF.md:150-155）。
