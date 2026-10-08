# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [2.0.21] - 2026-10-08

> 收口发布。实质内容见下面 2.0.16 之后各段的累计；这一版把 `dsh-remote-wire`
> 钉到 2.0.21（一次安装拿到 2.0.17–2.0.20 那一整串）。

本轮累计（按发现顺序，每一条都配了可变异验证的判据）：

### 接线协议层（HANDOFF §3.3）

- **七个出站控制帧**改用协议层构造器（`helloForHost` / `pairBegin` /
  `sessionLeave` / `resync` / `ping`）。参数表以外的字段在类型上写不出来。
- **`hello` 报能力**（规范 §5.3）：报的是**真实接上了的** 12 个，刻意不列
  `drc.host.info`（还没做）与 `drc.crypto.v2`（规划中的破坏性变更）——
  列一个没实现的能力 = 手机按"支持"表现而实际干等 12 秒，比不列更糟。
- **`error` 帧按码分支**：接 `isRetryableError`。⚠️ 刻意**不**自动重发——
  `bad_frame` / `unknown_frame` 标的是对端的 bug，把它们当可重试会让主机在
  一条永远不会自愈的连接上无限重试，而重试有额度，它会把额度耗在"重发同一条
  坏帧"上。
- **四处 `512 * 1024` + 一处 `?? 4`** 改引用 `limits` 的常量。那个数此前在
  本仓被抄了四遍，改一处不会让另外三处变红，而症状是"手机按 512KB 算、
  主机按 256KB 算"这类只有真机才看得见的分叉。

### `cmd.archive_session`：会话归档 / 取消归档

小程序此前收到过 archived 行却**直接丢掉**（底部只显示"已隐藏 N 个"），
而内核本来就有 `archiveSession`（真机上 55 条已归档会话就是它做的）。

- ⚠️ **协议里刻意没有 `stopActivity`**：内核在会话还在跑时抛
  `WorkspaceActiveSessionError`，除非传 `stopActivity: true`——而那会**停掉主机上
  正在跑的工作**。用户在手机上误点一下换主机上一个任务被停掉，不可逆。
  规范 A1 要求明确拒绝，判据里有一条专门钉住"这个参数必须被 zod strip 掉"。
- 成功后**补推一次列表**：本端不消费 `workspace/changes`（那是一帧 `{turn:N}`，
  推不出归档了哪一条）。复用 `pushSessions` 而不是自己 `listSessions`——
  那条路上还有"读失败保留快照"与"整段包 try"两件事。

### 四个实测缺陷（都是"注释承诺了 X，代码做的是 Y"）

| # | 缺陷 | 症状 |
|---|---|---|
| 1 | `settledReplies` 无界增长 | 台账按窗口+容量淘汰，而那张表只会问自己那一个键。实测 900 条命令后台账 256、回执表 900；每条 `list_sessions` 的回执带最多 100 条会话摘要 |
| 2 | 一条坏落盘记录带崩插件 | 注释承诺"整条丢弃"，实现是直接 `open()`。调用点在 `applyInner` 里不在 try 内 ⇒ **无 status.json、无 pill、配对链路全无** |
| 3 | 越界时刻停更 status.json | `toISOString` 在时刻的绝对值 > 8.64e15 ms 时抛，而它在**构造快照**的路径上，外面包着空 catch ⇒ 整个 status.json 永久停更（唯一的排错入口） |
| 4 | 误伤一张有效的配对码 | `pair-fail` 原先不带 token，主机只能作废"当前展示的那张"。多码并存时作废错的那张 → 那条通道的 PSK 没了 |

另修：启动那处 `pairingWindow.tick()` **恒为空操作**（注释说"先 tick 一次让
一起来就有码"，而它紧跟 `connect()` 之后必然早退）—— 真正让它成立的是
`onState` 的 `online` 分支。两处注释都订正了。


## [2.0.16] - 2026-10-07

依赖与版本对齐，外加**把协议层的一个能力真正接上**（`cmdId` 去重）。

### 新增

- **`cmdId` 去重接线**（规范 §10.2 / GAP-4）：协议层的 `IdempotencyLedger` 此前
  **零个消费方在用**，而主机**完全没有**去重。故障是既有的且**随机**：手机 12 秒收不到
  回执就报超时并允许重发，断线重连后也会补发 ⇒ 同一条命令可能执行两次 ——
  `cmd.send_prompt` 两次就是「用户说了一遍、模型回了两遍」；`cmd.resolve_permission`
  两次则落在已关闭的请求上，表现为「点了没反应」，且与真正的失败无法区分。
  快网络下几乎不复现，慢网络或切后台时必现，于是排错时永远找不到那次重复发送是谁发起的。

  三处设计取舍：
  - 台账放在 `handleCommand` **最前面**（命令的唯一入口）——放里面某几个 case 就会漏，
    而漏掉的恰好是最不能重复执行的那几条；
  - 重发时**重放上一次的回执**，不是回一句新的 `ok:true`。这一点协议层的台账做不到
    （它只存时刻，刻意不存载荷），所以另有一张 `settledReplies`，**同生共死**于台账
    （登记时顺手核一次台账还在不在），不给"台账清了这张还在"留机会 ——
    否则长会话里每条消息都会留一份回执，是个无界增长；
  - 台账在内存里，主机重启即清空 —— 而主机重启本来就会作废全部会话（`resync{[]}`），
    所以这条边界恰好与安全边界重合。

  它是**幂等性**机制而不是防重放：真正的防重放依赖密封记录的 Poly1305 与通道成员校验。

判据 490 → **494**（+4）。四条里有**两条是反向的**（不同 cmdId 照常执行 / 窗口外重算新命令），
它们最要紧：没有它们，一个「一律拒绝重复命令」的实现也能让前两条变绿，
而那个实现会把用户真的重发一起拦掉。

> ⚠️ 接上它时踩到的一件事，值得单独记：**判据夹具本身不真实**。
> `runtime.test.ts` 的 `cmd()` 助手写死 `cmdId: cmd_${t}`，于是同一个 runtime 里发两次
> 同类型命令会拿到**同一个 cmdId** —— 而真实客户端每条都调 `newCmdId()` 拿全新的 id。
> 主机零去重时这看不出问题，接上台账后它立刻变成一片假红（审批、提问、历史、新建会话
> 全红），**而红的不是产品、是夹具**；真红（重复发送被执行两遍）反而被它盖住。
> 已让 `cmd()` 逐条给新 id，并把那几处断言从「复算字符串」改成「对照发出去的那一条」。
> 这与「判据依赖的全局状态必须归一」是同一族：**不真实的夹具会制造一整片假红，
> 而真问题被它遮住。**

### 变更

- 依赖 `dsh-remote-wire` 从 `2.0.14` 钉到 **`2.0.16`**（精确钉，不用 caret ——
  caret 会解析到更高的 1.9.0，那就不是这一代协议了），lockfile 重新解析。
- 版本号 2.0.15 → 2.0.16（2.0.15 已被占用，见 `scripts/next-version.mjs`）。

### 这一版为什么值得单独记一笔

wire 2.0.16 带的是**协议层的握手面改造**（`hello.capabilities`、`MIN_SUPPORTED_PROTOCOL`
等九个新模块）。它当时的状态是「已发 npm、没人评审、零个消费方在用」，
所以发这一版之前补了两件事：

- **握手面加性的论证**（伞仓 `e2e/wire-handshake-compat.test.mjs`，7 条）：
  最要紧的一条是「**老 schema（2.0.14）收新 hello**」—— 用 zod 默认 `.object()`
  逐字段复刻旧版形状实测通过（未知键被 strip），并用一条反向判据把
  「我们**依赖** zod 的 strip 语义」变成显式契约：将来谁把 schema 收紧成
  `.strict()`，新字段就会拒掉老对端，而**发出去的包收不回来**（npm 版本号不可重用）。
- **中继侧真的用上了那份判定**（本轮新增，`tests/handshake.test.mjs` 6 条）：
  改造之前 `hello.protocol` **从未被任何一端校验过** —— 实测发一份
  `hello{protocol: 999}` 会照常收到 `hello-ok`。于是协议不兼容的现场表现是
  「连上了、界面正常、什么都不发生」，没有一层会报错。

### 形状不对的载荷必须回执（HANDOFF §5-9，本轮）

手机发出去的是**加密**的：它在那一端过得了 schema（过不了 `sendCmd` 自己就拒了），
所以"到主机这边过不去"只可能意味着**两端协议版本不一致**。最典型的两档是
`fileAttachment.mediaType > 64`，以及手机先升级、送过来一条主机这一代还没发版的命令
（将来加的 `cmd.archive_session` 就是这个形状）。

从前这条路只写一行日志就 `continue`：**手机干等满 12 秒的 `COMMAND_TIMEOUT_MS`**，
再拿到一句「主机没有回应这条指令」——根因一个字都没留下，而真正的那句话
（`inbound payload failed cmd schema`）只活在主机日志里。用户看得见的只是"点了没反应"。

现在拆成两层：

- `transport/relay.ts` 新增 `onInvalidCommand` 出口，把 `cmdId` 与载荷名一起交出去
  （没有它就无从回执，见下）；
- `runtime.handleInvalidCommand()` 按 `cmdId` 回一条 `ev.result{ok:false}`，
  消息按 `isKnownPayloadType` 分两种——**命令不存在** ⇒ 插件太旧；**字段不认识** ⇒ 两端版本不一致。
  这两句话指向完全不同的排错方向，合成一句就等于没说。

两件**刻意不做的事**：**不进台账**（这条命令没有被执行，把没做过的事记成"已执行"是撒谎——
重发时会回放一个从来没有发生过的结果）；**没有 `cmdId` 就只留日志**（回执按 `cmdId` 结算，
编一个假的会把手机上**别的**等待误结算，那比不回执更糟）。

顺带修一处连带的：`lastActivityAt` 原来记在 schema **通过**之后，于是"解得开但形状不对"的帧
不算活动，那条通道会被剪枝判成闲置。活动的定义是"这端有人在说话"，形状不对是协议版本的事，
不是"没人理这条通道"的事。

### 判据

宿主 490 → **497**（`cmdId` 去重 +4、形状拒收回执 +3，既有 490 条**逐条不变**）；
中继 164 → **178**（协议版本闸与错误码文案 +11、HANDOFF §5 收口 +3）；
伞仓 334 → **341**（握手面加性 +7）。协议 152 条不变。

本轮新增的 7 条判据（中继 6 + 宿主 4 里跨仓的那几处）**逐条做过变异验证**：把实现改回旧行为，
判据必须变红；其中 4 次首次即中，2 次修过装置后才中。

## [2.0.15] - 2026-10-07

串行深审一轮（四个分片并行逐行读完约 1.2 万行源码 + 判据）的产出。**八处修复全部先红后绿，
且逐个做过变异验证**；其中两处第一版判据恒真，被变异当场抓住后重写（详见提交说明）。

### 修复

- **浏览器面倒计时不再漂移**：原来那一行是 `expiresInMs -= 1000`，而用户点开发码面板
  之后必然要切走去手机上扫码 —— 那个窗口正是计时器最不可靠的时候（Chrome 对隐藏页
  intensive throttling 一分钟一醒、Electron 冻不可见窗口、合盖直接停摆）。回来还写着
  "2 分 5 秒后过期"而那张码两分钟前就死了，用户扫的是一个显示上"还活着"的死码。
  改为按墙钟重算 + `visibilitychange` 那一拍当场补上欠账。
  **这正是 2026-10-05 现场报的那件事，倒计时本来就是为了治它。**
- **`POST /unpair` 的回答不再被整个丢掉**：`routes.ts` 的 403 回答里**专门**带 `guard`，
  注释写着"屏幕上那句话就是唯一的现场"，而退出配对这条路裸 `await` ——
  403 不会让 fetch 抛错，于是那句现场一句都留不下，而面板已经乐观地把 `paired` 清零。
- **配对码不再原样进 stdout**：`log('pair-ready for an unknown token', { token })`
  是 §0.10.7 那条纪律漏掉的第四个调用点，而这条路径**可达**（`slots.prune()` 剔掉
  过期槽之后，中继才把 pair-ready 送回来的那张就正好"不认识"了）。
- **`voidConversation` 改为先发再记账**：原来 `voided.add()` 在 `raw()` 之前，
  而 `raw()` 对非 OPEN 的 socket 静默 false（中继抖一下，退避最长 30 秒以上）。
  于是这一帧没发出去、通道却已被标成"声明过了"，此后任何重试都被挡住 ——
  包括设计上明确依赖的 `onEncrypted` → 再作废一次那条路。
- **出站帧恢复体积闸**：`encToClient` 是协议层唯一执行 `MAX_CIPHERTEXT_BYTES` 的地方，
  而主机原来手拼 `{t:'enc',…}`，这条路上一个闸都没有。超限的后果不是"这帧没了"：
  中继回 `error{bad_frame}`，而插件对 `error` 只记日志 —— 手机走完 15 秒超时留下一句
  "读不到"。顺带把 `lastActivityAt` 挪到闸门之后（一条注定发不出去的帧不该把通道"用活"）。
- **关掉状态快照不再顺手关掉三件与排错无关的事**：剪枝 / 配对码自动换代 / PSK 簿批量落盘
  全都寄生在 `status.start()` 的回调里，而 `StatusFile.start` 在没有文件时直接 return。
  `statusFile: ''` 是**有文档**的开关，于是那台主机同时失去了通道剪枝
  （全仓唯一的 `pruneStale()` 调用方 → 密钥簿重新变回无界，`MAX_CONVERSATIONS` 与两条
  TTL 形同虚设）。**没有任何提示。**
- **两个"写了不报错、不告警、不生效"的配置**：`statusFile` 相对路径按宿主 CWD 解析
  （GUI 宿主上是 `/`）→ **唯一排错入口静默消失**；`maxFileBytes` 调过整批预算不会生效，
  而报错还会让只带了一个文件的用户"少带几个"。
- **写到一半失败不再留一批孤儿文件**：`writeFileSync` 中途抛（ENOSPC/EACCES）时，
  已落盘的 1~3 个文件留着，重试一次文件名就变成 `first-2.txt`、`first-3.txt`……一直涨。

### 新增

- **`cmd.new_session.workspace` 接线**（HANDOFF §0.10.4 的第 3 步，阻塞条件已解除）：
  字段在 `dsh-remote-wire@2.0.14` 的 schema 里、钉也已经跟上，而主机一直没读它 ——
  手机指定了分组，会话建在主机自己推断的目录里，回执照样 `ok:true`，**无错、无日志、
  手机上完全看不出**。现在：端口接 `args.workspace`；载体多一级取值
  （`⓪ 手机指明的工作区`，排在运维配置那一句钉之上 —— 那句钉是"手机没说话时的默认"，
  而用户这一次是明确说了）；仍然过 `badWorkspace()`，形状不合法就**明确失败而不是静默改道**。
  老手机不带这个字段 → 载体自己推断，行为与接线之前完全一致。
- **限速退避换掉一个恒真的死分支**：`onPairFail` 里写的是 `if (reason !== 'rate_limited')`，
  而 `pair-fail.reason` 的四个取值里**没有** `rate_limited`（中继把配对限流折成
  `invalid_or_expired`）—— 实测 `parseRelayFrameText` 对它返回 `null`。那个分支读起来像
  "限速时我们会克制一下"，实际上从不克制；而自动补码撞上限流是一条会**自我加速**的循环
  （被拒 → 补一张 → 再被拒 → 再补）。真正的信号 `error{code:'rate_limited'}` 此前只被记进日志，
  主机从不按 `code` 分支。现在它开一个退避窗口，窗口内不自动补码（用户点「刷新」仍随时可以）。

判据：471 → **490**。

## [2.0.14] - 2026-10-07

> 与 `dsh-remote-wire@2.0.14` 同一发版；依赖钉从 `1.0.0-rc.1` 跟着换成 `2.0.14`。

### 修复

- **待办双端一致**：手机不许把上一轮的清单说成"此刻在做什么"。宿主那一侧的待办是
  **按轮**清的（上一轮写过、这一轮没写，它就是空的），而内核不会为"这一轮没有待办"
  专门发一帧 `todo/write`，于是手机上留着上一轮的清单 —— 用户看到一件**没在发生的事**。
  现在新一轮开始时补一帧空快照（且只在上一轮确实有过清单时才补）。
- **`updatedAt` 不再是创建时刻**：它一直是 `createdAt`，而手机管它叫"最后消息时间"。
- **日志值的长度上界**：`message:` 三处一个都没截断，而它们旁边的 `slice(0,120/200)`
  说明作者知道要截。抽出 `shell/log-line.ts` 纯函数。
- **新建会话不再落在未分组**（三级取值：配置钉 → 最后操作过的那条会话 → 往前扫）；
  切帧不劈代理对（emoji 的代理对被硬切成两半 → 两片各带一个孤立代理出站，
  表情凭空消失且没有任何一层报错）；配对码不进 info 日志。
- **带图请求不许被悄悄降级成纯文本**：手机说发了 N 张图却一张都送不出数据时整条失败。

判据：448 → 471。

## [2.0.13] - 2026-10-06

### 新增：`cmd.get_pending`——手机主动拉还挂着的审批/提问（wire 1.9.0）

`peer-joined` 的重发（2.0.12）只发生在重配对；普通 socket 重连中继不通知主机，
主机收不到任何信号。手机在进会话页、重连成功时各拉一次，主机把 `pending` 里
还挂着的按原请求帧重发（与 `replayPending` 同一构造器、同一 `requestId`），
没有只回 `ev.result{ok:true, replayed:0}`。`sessionId` 可选（带了只重发那条会话的）。

### 新增：inbox 接线——主机侧排队的用户消息进手机

内核 `agent/inbox/spliced`（用户在 DSH 里敲字、排给下一轮）原来产出 `{kind:'inbox'}`
后在 switch 里没有 case，从此掉出去被丢弃（还撤出过映射表让证据说真话）。
现在按 user role 推进合帧窗口，复用 `ev.message_delta`：手机本来就会渲染 role=user，
历史回放走同一条 user 路——**不需要新协议载荷，mp 一行不用改**。

### 修复：历史第一页恒带最新待办快照

待办是"此刻的清单"：`todo/write` 在回合开头，后面跟几十条工具事件，
40 条窗口把它裁在外面，手机重进长会话顶部条子直接消失，之后没有 todo 变更
就没有实时帧来补。第一页（且仅第一页）没有就把最新一份 append 进去；
快照很小，不计分页预算。

## [2.0.12] - 2026-10-06

### 新增：配对那一刻重发还挂着的审批/提问（`replayPending`）

2026-10-06 中午用户实测：主机问了问题，手机上什么都没弹，最后超时无应答。
帧确实发出去了（`outbound.question_request=1`，无 `_no_peer`），但审批/提问卡是
"一次性、单会话、只在 chat 页"的一帧——手机退后台、断线、停在列表页或别的会话时，
这一帧过去就没了，而主机还阻塞着等决定（审批 180 秒、提问 300 秒）。

现在 `peer-joined` 之后把 `pending` 里还挂着的按原样重发一遍：同一 `requestId`
（手机按它覆盖，不翻倍；结算点的精确作废帧新旧两份一起收，不留幽灵卡），
到期时刻用最初那一帧的（不顺延——主机超时表从第一次问出就开始走），
已结算的不在 `pending` 里、不会复活，重发永不抛（走在配对流程里）。
为此 `pending` 里多存了审批的 `action`/`reason` 与两类的 `expiresAt`。

判据：`runtime.test.ts` +4（同一 requestId/同一 expiresAt/无活对端不发/已结算不复活）。

## [2.0.11] - 2026-10-06

### 新增：`tokenMeter` 探针进 `status.json`（`d6ba43f`）+ 按名查包（`597872f`）

10-06 主机普查发现 `ctx.tokenMeter` 一直坐在出货 composition 里
（`dsh-token-meter` 及其 `sessionProjections` 依赖都在 `desktop-runtime.json`）：
重放 durable 会话日志量上下文压力，不调模型、不添模型可见物。
这一跳只加探针、不加手机可见的数字——顺序是刻意的：
真机上第一问是"到底读不读得到"，答不上来就和 `approvalCalls=0` 那次一样，
红了也不知道是哪一层坏的。探针调一次无会话 `measure`
（抛了在这里现形，而不是在手机上变成一个静默的 0），
只报可读性、不报数值（每条消息都变的数，落进 `status.json` 只会闪）。

紧接着修掉探针自己的误报（`597872f`）：包在不在原来读的是截到 2600 字的
`loaderRows`，截断点之后的一律读成"没加载"——当天差点据此断言 token-meter 缺席。
现在 `probe.wanted` 按名逐包答 `true/false`：短、不截断、能从同一份 loader 条目重算。

### 新增：重试与压缩上屏（`93b4009`，依赖抬到 `dsh-remote-wire ^1.8.1`）

真机十二份日志里 `llm/retry` 与 `compaction/end` 各出现 18 次，插件两条都不认——
明明在重试 / 压缩的一回合，在手机上与死掉长得一模一样，用户读成卡死就手工打断。

- `llm/retry` 取 `retry / maxRetries / failure.{code,message}`，
手机拼出"retrying 2/5: TRANSPORT"；原因取 `code` 不取 `message`
（"Connection error." 对人不说明任何事），`policyKey` 那坨策略 JSON 留在主机；
- `compaction/end` 带可选 `error`
（见过 `summarization produced no text summary content`），
失败与完成是两个状态，不合并；
- `workspace/changes` 故意不接：66 个样本全只带 `{turn}`，
文件清单在中继够不着的鉴权路由后面，"变了但说不出是哪些"比不说更糟。

### 修复：顶栏"当前模型"补发 + 待办在历史回放里整块消失（`4213374`）

两个都是"只在跑起来的那一轮才有数据"的字段，打开已有会话就空着。

模型是 `9511904` 的附带损伤：那次修提问弹窗（`mapQuestion` 不能吐空 question/label，
否则 `nonEmpty` 把整帧静默丢掉、mp 卡不出来），顺手把 `broadcastModel()` 从
"读宿主全局默认模型并广播"改成"广播这个事件带来的模型"，
而 `pushSessions()` 里那个 call site 被删掉、没有跟着改。
后果是模型只剩内核 `request/header` 一个数据源，而它每轮一条——
空闲会话永远不发，mp 的 `modelName` 从 `''` 起算、顶栏直接不渲染。
修法是 per-session 缓存 + 随会话列表补发（不是退回读
`agentDefaultModel.currentSelection()`：那是"新建会话用哪个"，
别的会话切一次模型本会话就跟着变——2026-10-05 用户实测的串台
`space-bunny-free` 变 `muse-spark` 就是它）。
挂在 `pushSessions` 上是因为它本来就是"状态变了就推一次"的唯一入口，
而 `reason: 'list'`（mp 重连发 `cmd.list_sessions` 时）不走合并窗口，重连那路白拿；
缓存不按会话列表裁剪（`LISTING_LIMIT=100` 截断会误删，
换 `MODEL_CACHE_MAX=256` 与 voided / PairingSlots 同一套上限）。

待办是 `isHistoryWorthy` 只放行 delta 与 tool，`todo` 在进历史页之前就被丢掉——
`historyWireItem` 的 todo 分支是死代码，`_replayTodos` 恒为 undefined，
顶部那颗条子只在"页面正好开着、又正好推来一帧实时 `ev.todo`"时才出现。
修法是放行 + 一页只留最后一份（全量快照直接放行会塞几十条冗余、把正文挤出预算；
塌缩必须在预算循环之前，否则丢掉的已经计进账面）。
"最后一份"是用户拍板的：**空清单也是一份快照**，照样保留——
内核清空后历史里最后一份就是空的，mp 因此不显示那颗条子，
这是忠实语义不是漏数据，判据里钉死了，免得下次有人"顺手修好"。

判据：宿主 4 条（先红后绿）+ mp 侧 2 条（`dsh-remote-mp` 仓）。plugin 379/379（原 372）。

### 修复：证据通道停止说谎——inbox 撤出映射表 + `eventTypes` 不再截断（`af12313`）

两处都是诊断面本身在骗人，"排错第一步"就错在错的地方。

`agent/inbox/spliced` 登记了映射（`{kind:'inbox'}`，35 行注释说它是
"用户在 DSH 里发的消息"唯一可靠信号），`MAPPED_SESSION_EVENTS` 也加了它——
但 `HostRuntime.onKernelEvent` 的 switch 里**没有 `case 'inbox'`**，
事件从末尾掉出去被丢弃，而 `runtime.ts` 还留着"见下面的 inbox 分支"的注释，
那个分支不存在。更糟的是那张表只驱动 `status.json` 记账、不驱动 switch，
于是"内核发了我们没认"被报成"一切正常"（HANDOFF §4 取证陷阱的翻版）。
用户可见后果：在 DSH 桌面里排队的消息，手机上完全看不到。
完整接线要动三处（协议加 inbox 载荷并发版 + mp 加处理器 + 登记回表），不在本次范围，
所以先**撤出映射表**，让 `status.json` 如实报 `unmapped`——
排错第一步就能分清"内核没发"与"我们没接"。同时反转 2026-10-05 那条"必须登记"的判据，
理由写在原地。

`eventTypes` 的 `.slice(-24)`：Set 保插入顺序，见过 24 种类型这个字符串就永久冻结——
现场：重启前 23 种、含 permission/preset，重启后 24 种、permission/preset 消失、
尾部多了 `llm/retry` 等。而它与 `unmappedEventTypes` 喂的是同一个 Set，
"被记成没认"却"在 eventTypes 里查不到"本身就是矛盾信号——
这恰恰是这个字段存在的理由。去截断是安全的：
事件类型来自内核有限词表（实测 59 种），不是随输入增长的集合，
加 slice 只是自造截断，改成排序输出。

判据：穷举自检（`MAPPED_SESSION_EVENTS` 每种都灌进真 `HostRuntime`、断言都有出站面；
`INTENTIONAL_DROPS` 登记 `approval/asked、approval/decided`——
按设计只记账不翻译，"故意丢"与"忘了接"的分界；
映射表新增条目必须同时补样本）+ 事件账本 2 条
（24 种以上最早的不许消失；记成 unmapped 的必须也出现在 eventTypes 里）
+ inbox 证据 1 条。plugin 381/381（原 372），mp 101/101。

### 变更

- **chore: 2.0.11（`013cd1c`）**：纯版本号对齐，无功能改动——
`packages/plugin/package.json` 2.0.10→2.0.11，追平已经装进 Harness 的那份 bundle。
npm 最新仍是 2.0.10，本版尚未发包。

## [2.0.10] - 2026-10-06

### 修复：图片走原生内容块，不再把路径写进正文（`c959c9e`）

原来附件图片落盘后把路径追加进 prompt 正文：正文里多出一截主机目录，
用户与模型都看得见，还泄露了本机布局。主机本来就收内联图片块
（`{type: image, data, mimeType}`，经 attachment store 转成内容寻址引用），
所以正文现在原样过，什么都不写进 `uploadDir`。

### 变更：pill 文案收敛 + `uploads.ts` 图片那半删除（`6a634a5`、`51a4d89`）

"手机离线"那一行原来三句话（"配对还在 小程序回前台会自动重连 不用重新扫码"），
用户在那一屏唯一要做的判断是"要不要扫码"，答案是不用——
现在只留托住这个决策的那几个字。结论本身保留：
2026-10-04 有用户看到"手机离线"就去扫一张不需要扫的码，
一条判据把结论钉住、不钉字句。

`uploads.ts` 图片那半（`saveImageAttachments / appendImageNote`、JPEG 魔数、
`maxImageBytes` 整条链路）随上条一起成为死代码，一并删除；文件那半保留。

### 变更

- **chore: 2.0.10（`3f718c0`）**：纯版本号，
`packages/plugin/package.json` 2.0.9→2.0.10。

## [2.0.9] - 2026-10-05

### 新增：排队三连——主机建队、重做、落成真行（`420066f` → `08fdad6` → `64adde4`）

注：其中 2.0.8（`762a03a`）只推了版本号、未立 tag、npm 也无此版本，
下面三跳随 2.0.9 一起发出（tag `v2.0.9` 落在 `e82fa78`）。

- `420066f` 主机接管排队：`PromptQueue` + `ev.queue` 快照 + `cmd.drop_queued`
（对 wire 1.7.0）；
- `08fdad6` 队列重做：`sent` 只在内核真跑起来时标（不再是"发出就标"），
主机造的 turn 同步到手机，`sent` 可经 `interrupt` 取消——
"诚实状态、host-turn 同步、所有状态可取消"（`762a03a` 的 release note 原话）；
- `64adde4` 把 `agent/inbox/spliced` 落成真 queue 行（不再是猜的），
补 `cmd.get_queue` 拉取（对 wire 1.8.0），版本号 2.0.8→2.0.9。

### 破坏性变更：主机队列整套删除（`011450e feat!`）

`PromptQueue` 删除（`src/shell/queue.ts` 264 行拿掉），
`send_prompt` 改为直发、发不出去如实报错。
建完当天即删：排队这条路在"谁拥有真相"上绕了一整天，
最后回到"主机直发 + 失败明说"（wire 1.8.1 同步删协议半，见线协议 1.8.1）。

### 修复

- 提问卡空值整帧被吞（`9511904`）：`mapQuestion` 吐出空 question/label 时，
schema 的 `nonEmpty` 让整帧解析失败、静默丢掉，mp 卡永远不出来——现在永不吐空；
- 解配读成离线（`6eac6be`）：中继 `peer-left` 带 `unpaired`（对 wire 1.8.1 的帧），
会话一并作废，pill 从"手机离线"回到"未配对"（2026-10-05 用户报：
"mp 端解除配对，dsh 端执行的是手机离线"）。

### 变更

- 依赖改吃发布的线协议：`dsh-remote-wire ^1.8.0`（`e82fa78`），不再用 `file:` 树；
- `format:check` 不再误报 `dist/`（`ec32422`，prettier 指到仓根 ignore）。

## [2.0.7] - 2026-10-05

### 新增：文件附件落盘（`e00de50`，对线协议 1.6.0）

`saveFileAttachments / appendFileNote` + `maxFileBytes` 配置：
落盘名保留扩展名（Agent 认文件靠它），正文后追加
"[文件附件 N 个，已存到本机]"清单（含手机带来的类型标签）。
图片那套不动；空正文只带附件的消息同样可用。

## [2.0.6] - 2026-10-05

### 修复：屏上那张码绝不能是已经用过的（`7cd5461`）

用户一口气报三件事：手机离线太久连不上、dsh 端解配后新二维码也连不上
（要等下一次刷新）、手机解配后 dsh 不再同步状态（第三件此前修过一次）。
根因是配对码一次性的：中继 `claim()` 里标掉，重放永远 `already_used`，
而屏上那张（`status.json` 的 `active.pairing`、pill 二维码、`/pairing/new` 现发的）
只靠 `markConsumed` 与 `wrappedPublish` 维护——真正死掉的那一刻没人退休它：
`unpairAll` 作废了会话却留着那张码，pill 继续展示手机刚用过的那张，
扫了就是 `already_used`；而 `pairOnStartSec` 默认 0，窗口不 tick、没人换上新的，
只能等 TTL。修法是已耗 token 台账守住每条发码路径：用掉就退役；
解配当场退役展示中的那张并现铸一张顶上（而不是留白），
二维码出现的那一刻就是可用的，不用等下一次刷新。
判据走真中继 + 真 runtime + 真小程序客户端（只有这样才看得出中继拒不拒这张码）。
plugin 351/0，伞仓 e2e 168 项、`run.mjs` 17 步。

### 变更

- **chore: 2.0.6（`ac79aea`）**：纯版本号，
`packages/plugin/package.json` 2.0.5→2.0.6。

## [2.0.5] - 2026-10-05

### 修复：配对码的剩余寿命常显，中继不在线时不再画死码

用户报"当前的二维码无法配对"。排查后是三件事叠在一起：主机侧半开掉线
（2.0.4 的探针还没生效，因为跑的是旧 bundle）、配对码 3 分钟权威寿命在屏上
**没有任何时间信息**、以及中继不在线时 pill 照样画着一张扫了必然失败的码。
这一版修后两件：

- 二维码那一屏顶上常显剩余时间（`X 分 Y 秒后过期`），最后 30 秒转重；
  倒计时在说这件事时下面那行 note 闭嘴——一行说一件事；
- 中继不在线时**一个发码请求都不打**：轮询早就知道 relay 不是 online，
  那一屏改成"主机还没连上中继 现在发不出配对码"加右上角刷新；
  面板开着时中继掉线，死的二维码当场换成这一屏（2 秒节拍内）。

判据：client-bundle +2（离线不发码 / 开着面板掉线当场换屏），倒计时常显。
plugin 351/0。

## [2.0.4] - 2026-10-05

### 修复：主机侧补上存活探针（半开连接不再静默到进程重启）

socket 半开时两头都是瞎的：对端已经走了（中继早把主机摘了、`/healthz` 的 `hosts`
归零），本地一个 FIN/RST 都收不到，`close` 事件永远不来——状态一直报 online、
重连永远不会开始。线上取证：中继重启后主机重连成功，28 分钟后连接半开，中继
17:54 起就再无主机，而插件直到进程重启都认为自己在线；手机上看到的是
"配对着却连不上"。

现在主机每 20 秒问中继一句 `ping`（协议里本来就有的一对应用帧，中继无条件回
`pong`，**不动线协议**），10 秒等不到答复就 `terminate()` 强拆——只有强拆才能
在半开连接上逼出 close 事件，进而走既有的退避重连。中继那侧本来就有心跳
（它 ping 主机、2×60 秒判死），缺的就是主机这半边。

判据：relay-client +3（按时提问且答过不判死 / 超时强拆并留痕、链条随之停 /
停机后不再发问且状态落 offline）。plugin 349/0。

## [2.0.3] - 2026-10-05

### 新增：待办进历史回放（补上 2.0.2 留下的 v1 边界）

进一条跑过的会话也立刻看得见待办，不用等下一次 `todo/write`。内核日志里的
`todo/write` 事件本来就已被翻译成 KernelEvent，这一跳只是让它在历史页里也有位置
（`historyWireItem` 不再丢 todo），并依赖 wire 1.5.0 的 historyItem 扩员。
手机侧规则：只应用**第一页**（最新一页）的快照，更早页的是过期快照；
已经在流的实时帧优先（后到者胜）。

### 清理

- 随包分发的 `cordis.patch.yml` 删掉 `takeOverQuestions` 死键（⑥ 的漏网，默认配置里还发着）；
- README 配置表补 `uploadDir` / `maxImageBytes` / `newSessionCwd` 三行，`takeOverQuestions` 行改为“已删除”。

## [2.0.2] - 2026-10-05

### 新增：待办清单上屏（todo list）

内核 todo/write 转发到手机：聊天页顶部一颗待办条，默认收起只报进度，点开看全文、点消息区自动收回；排队消息在底部，两块不打架。
映射带三条夹取：status 三元白名单 / content 非空且不超过 200 字 / 整份不超过 50 条；空清单也下发（内核清空时手机跟着清）。
协议侧新增 ev.todo（dsh-remote-wire 1.4.0）。

### 修复

- mp 新建的会话不出现在 DSH 会话列表：create 不给 cwd 时宿主用 process.cwd() 兜底（真机上就是 /），会话挂在不属于任何用户项目的目录里。现在三级取值：配置点名 > 最近一条会话的目录 > 退回旧行为（日志留痕）。
- pill 文案口径：未配对改为远程未连接、已配对改为已连接、弹窗状态行改为已就绪；二维码页加一行新人引导（短、不带符号）。

## [2.0.0] - 2026-10-04

这一版把配对收敛成**一台、一条路、一颗按钮**，并把 `/drc` 整条删掉。属于**破坏性变更**，
发布时该走主版本号。产品定义（为什么是这三条承诺、由承诺推出的界面判据）在伞仓
`docs/PRODUCT.md`——下面的"等 N 件事"那一条就是它 §3 第 1、2 条落进界面的地方。

### 破坏性变更

- **未配对时点开那颗 pill 直接就是二维码页**，中间那一屏与它那颗 `生成配对码` 按钮一起删掉。
  这一条**反转了 2026-10-03 的"点开不发码"**，但没丢掉它守的东西：那张取舍当时防的是
  "看一眼就消耗一张有寿命的 pending 码"，而**已配对那一侧仍然一次码都不发**（点开只给状态）。
  没配上时面板上没有任何别的内容可看，多点一次只换到一次"原来在这儿"。
  配套两件事：那颗按钮从此只按"配没配上"分两种身份（`刷新` / `退出配对`），退出配对之后就势
  回到二维码页；而**二维码那一屏仍然带正文那几行**（待处理 / 中继 / 状态 / 版本），
  否则这一改会把"连的哪一台、连没连上、跑的是哪一版"从未配对的屏幕上一起删走。
- **`/drc` 命令整条删掉**：`ctx.commands` 上现在**一个命令都不注册**，配对入口只剩状态栏那颗
  pill 的那四条同域路由。`/drc status` 能说的面板抬头都有，`/drc unpair` 换成了面板右上角那颗
  按钮——留着它们只会让"配对入口只有一个"变成一句不真的话。
- **同一时刻只允许配对一台**：新设备配上时，主机当场踢掉旧的那条通道（原来允许多台并存）。
- **`GET …/status` 去掉 `hostLabel`，补上 `version` 与"有没有事在等"**：字段是
  `relay` / `paired` / `serverUrl` / `version` / `waiting` / `waitingOldestSec` 六个，全是非凭据。
  本机名配对时手机上已经看到，留在弹窗里只是占一行；`version` 是本机装的那一版
  （打包时经 esbuild `define` 注入，源码直跑时是 `dev`），用来回答"跑的是哪一版"；
  `waiting` / `waitingOldestSec` 见下面的"等 N 件事"。

### 新增

- **`POST /plugins/dsh-remote-control/unpair`**：面板右上角那颗"退出配对"。写路由，与发码共用
  同一道跨站守卫（`x-drc-pair: 1`）；幂等，没配上时回 `200 {state:'ok',unpaired:0}` 而不是 500
  ——轮询与点击之间状态可能已经翻过去，那是正常竞态不是错误。
- **有东西挂在手机上等回答时，那颗 pill 说的是"等 N 件事"**（抬头 tone 走 amber 那一档），
  面板正文也多出**排在第一行**的 `待处理 · 2 件 · 最久 4 分 12 秒`。
  原来这条链上唯一的可见点是"已配对"——而那一刻真正的事实是**有一条回合停在这台机器上等人点**。
  优先级写死为：`已断开连接`(红) > `等 N 件事` > `已配对`(绿) > `未配对`(灰)：
  链都断了，说"等几件"没有意义（要修的是连接）；而**没配上**时即使还挂着一条没超时的挂起
  （手机中途掉线），抬头也说的是"未配对"——用户能做的第一件事是重新配对，不是去找一台不存在的手机。
  数据来自 `HostRuntime.waiting`（`pending` 表里新增 `kind` 与 `askedAt`，时长用 `clock.now()`
  算，于是 FakeClock 能演"已经等了 4 分钟"）。

- **重启不再逼用户重扫码：会话簿落盘 + 恢复**。配对密钥簿（PSK + convId + seqHost）落到
  status.json 同目录的 `conversations-<hostId>.json`（0600 + 临时文件 rename + hostId 校验），
  **不落**派生密钥、**不落**"此刻谁连着"（后者落盘会让主机一启动就往没人收的通道广播）。
  恢复必须在 `relay.connect()` **之前**——反了会被第一帧 resync 声明空列表，中继当场删通道；
  恢复出的会话立刻 `runtime.start()`，不等 `onPeerJoined`（手机是恢复不是重配，不发
  pair-begin-client，等它 = 主机不订阅任何内核事件，症状与配对丢失一模一样）。
  恢复出来的会话按 7 天剪（与中继 `DRC_CONV_IDLE_TTL_MS` 对齐：中继忘掉它那天本就是该重扫那天），
  `pairStoreFile: 'off'` 关掉即回旧行为。`status.json` 新增
  `pairStore{enabled,file,restored,lastSavedAt}` 四个非凭据字段。

### 变更

- **主机身份不再每次加载换一个**：`config.hostId` 为空时旧写法是现造一个 `h_<3字节随机>`，
  真机 5 分钟内出现过三个身份（HANDOFF §3.4），每一次都让中继报 `replaced:0`——顶不掉旧 socket，
  手机连的那条会话指向"没有钥匙的对端"，`droppedFrames` 一直涨。现在按
  **配置 > 磁盘上的旧值 > 现造并落盘** 定身份，落点是 status.json 旁边的 `host-id`（0600，
  已存在的值绝不改写；升级前那种 `h_xxxx` 读到了继续用，不借机换号）。
  写不进去 / 目录不可用时退回一次性身份并且**绝不抛**——身份暂时不稳，好过插件起不来。
  `status.json` 新增 `hostId` 字段：以后"手机连不上 / 丢帧涨"第一眼就能看出身份稳不稳。
- **pill 弹出面板重做，以"精炼"为准**：抬头一行（状态 + 右上角**唯一**一颗动作按钮）加正文
  **三行：中继 `host:port` / 中继状态（已连接 / 连接中 / 已断开 / 未启动）/ 版本号**
  （各自拿不到值时不占地方）。删掉"本机 / 台数"那两行、`再配一台` 那个改名，以及
  **`换一张` 按钮连同"倒计时走完自动再要一张"这个能力**。那颗按钮**跟着当前视图走**：
  未配对=`生成配对码`、已配对=`退出配对`、正在出图=`刷新`（同一条幂等发码路由）。
  正文先收成"只有中继一行"，用户嫌单薄，于是补回"状态 / 版本"凑三行——留下的这三条都**不与
  抬头那句重复**：抬头在线时只讲配没配上，这三行才讲连的是哪台、连没连上、跑的是哪一版。
- **状态用颜色说**：`已断开连接` 是**新的红**（`tone: 'error'`），不再和"未配对"共用灰——
  断链是故障，灰色会被读成"还没轮到配"。
- **配上之后面板从二维码翻回状态视图**：那一张码配上就没用了，继续占着面板会让人以为要再扫一次。
- **样式表按内容对齐**（真屏幕事故的修法）：`ensureStyle` 原来只要 `<head>` 里有一份
  `style[data-plugin-css]` 就直接返回。宿主热更这一半时文档未必重载，于是**新 JS 按新结构建 DOM、
  旧 CSS 还在生效**——真屏幕上表现为整块面板错位：右上角那颗按钮掉到第二行居中
  （上一版 `.drc-actions` 的 `justify-content: center` 在管事）、中继那一行竖排。
  现在内容不一致就当场换掉。

### 新增

- **提问也问到手机了，而且不再"接管"**：`user-questions/request` 现在是第二条被**参与**的
  waterfall（登记口与审批共用同一组 `{ global: true, prepend: true }`）。
  原来那条路是 `ctx.userQuestions.registerProvider`——它有两个问题：①这一代宿主的服务里
  `provider` 这个词**零命中**（成员只有 `ask / askTimed / answer / continued / releaseReply`），
  所以开了 `takeOverQuestions` 也只是在 status.json 里多一行 `no registerProvider (keys=…)`，
  手机上永远不会有提问卡；②就算有，"注册一个提供者"是**单提供者**语义，接管就意味着桌面问不了问题，
  那是插件在改变宿主的行为。参与 waterfall 才是既两端同弹、又不吞掉桌面那一条的形状
  （取证：`UserQuestionService.ask()` 末端就是 `ctx.waterfall(scopeTarget(agent, agent), …, noAnswerer)`，
  桌面 UI 是网关转发的 `$on("user-questions/request", …)`）。
- **`takeOverQuestions` 这个键已经不生效**（README 的配置表里标了删除线）。删掉键本体要动
  `shell/config.ts` 与 `index.ts`，而这两棵树此刻正被另一条在飞的改动占着，所以留作单独一轮；
  `describe()` 里 `takeOverQuestionsInert` 会把"它不再管事"说清楚，别拿 `questionsFace` 当它还在管。
- **收回卡片改成按 `requestId` 精确收单**：结算点在补 `ev.run_state`（手机上装的那一版只认这条）
  之外，另发 `ev.permission_resolved` / `ev.question_resolved`（`by: 'desktop' | 'cancelled'`）。
  依赖升到 `dsh-remote-wire@1.2.0`——那两帧与提问的 `expiresAt` 都在那一版里。
- **提问请求带上 `expiresAt`**（= `questionTimeoutMs`，默认 300 秒）。审批那条一直有，提问这条没有，
  于是主机早就判"没答上"了而手机上那张卡看不出什么时候作废。
- 提问面新增四条读数进 `status.json`：`questionsFace` / `questionsCalls` / `questionsLast` /
  `questionsDesktopVoided` / `questionsSignalHandoff`，与审批面同一套。
  落点写成 `answered-by-phone(1 项)`——**只报题数，答案正文不进 status.json**。

### 修复

- **手机断开之后，主机不再往那条空会话广播**。真机实测：45 秒里中继 `droppedFrames` 涨 9，
  与插件 `session_changed` / `model` / `keep_awake_state` 各涨 3 **逐帧对得上**；
  而那条会话 `clients=0`、默认 7 天 TTL——它就是 `droppedFrames` 的主要来源，
  原来"丢帧集中在活动窗口"的判断是被这一路噪声带着走的。
  根因是一个名字：`hasPeer()` 答的是"**我手里有没有这条通道的密钥**"，
  而调用方要的是"**现在有没有人能收**"。两者在手机上线时恰好同真，所以错误一直藏着。
  现在拆成两个概念：`ConversationBook.has(id)`（有密钥，D3 重连要用，必须留着）与
  `hasClient(id)`（成员表非空），`send()` / `broadcast()` 只认后者。
  **真机 A/B 复测**（配对让 runtime 起来、再让手机断开，造出同一幕 `conv=1 / clients=0`）：
  62 秒里中继 `droppedFrames` **5878 → 5878 一动不动**（改之前是 45 秒涨 9），
  而插件本地照旧记 `session_changed_no_peer` +4——"主机想发、当时没人听"是本地事实，
  它不该变成中继指标里的一次丢帧。
- **顺带修掉一个更早存在的错**：成员表原来**只靠"收到过这台手机的 enc 帧"长出来**，
  而手机回前台时中继发的那条**不带 `pairingToken` 的重连通知**在本端是直接 `return` 的。
  后果是 `status.json` 里"有几台手机连着"在重连之后会短暂报 0，且任何以"有没有活客户端"
  为准的判断都慢一拍。现在两条 `peer-joined` 都登记成员。
  ⚠️ 有一条旧的测试期望因此改了：`peer-left` 之后 `send()` 现在返回 `false`。
  它当初防的是"手机切个后台就再也收不到更新"——那个性质现在由**重连之后必须能再发**
  来守（同一个测试里两半都钉住了），而不是靠"没人也照发"。
- **审批卡终于能弹到手机上了**（真机 2026-10-03 深夜～10-04 凌晨，两轮才修对）。
  根因不在我们读请求的那几行，在**登记的方式**——`ctx.on('approval/request', …)` 少了两个选项，
  各对应一种"没弹"：
  1. **`global: true`——不被作用域过滤掉**。宿主用
     `ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req, next)` 派发，
     cordis 的判据是 `hook.global || !filter || filter.call(thisArg, hook.ctx)`，而那条 filter
     只放行"未打作用域标签的上下文"与"派发键的**祖先**作用域"（原文：
     'A tag BELOW the dispatch key stays excluded — events flow up the chain, never down'）。
     插件那条 fiber 与 agent 作用域是**兄弟**，于是登记成功、`approvalFace` 报 `registered`、
     监听器一次都不会被调用。
  2. **`prepend: true`——排在桌面那位应答者前面**。只加 `global` 之后真机复测仍然
     `approvalCalls=0`，而新的审计字段显示 `approvalAsked=1`、`approvalDecided=not-seen`：
     请求**确实派发了**，但 waterfall 是"外层不 `next()` 内层永远轮不到"，而
     `dispatch()` 返回数组的第一个就是外层（`register()` 用 `unshift` 实现 prepend）——
     桌面 UI 的应答者登记得更早，它一拿到请求就去等真人点按钮且不 `next()`。
  最终形状（真机一次完整闭环的读数）：`approvalCalls=1`、`approvalLast=answered-by-phone(allowed-once)`、
  `approvalDecided=allowed-once`、`outbound.permission_request=1`，手机侧探针收到的卡是
  `{action:'write', reason:'escalate sandbox to workspace-write: …', options:[允许一次, 拒绝], expiresAt:…}`。
- ⚠️ **但上面那次修复自己引入了一个新的回归，被用户当场指出：手机上弹了，桌面上 DSH 不弹了。**
  根因就是 `prepend` 的另一半：我们排到最外层之后**在那儿等手机**，而 waterfall 是
  "外层不调 `next()`，内层就永远轮不到"——等于插件把宿主自己的审批窗吞掉了。
  **插件不许改变宿主的行为**，这条比"手机上能弹"更硬。
  现在的形状是**两边同时问、谁先给出真实决定谁算**：一进 `participate()` 就立刻 `next()`
  把桌面启动起来，手机并行问，两边赛跑。
  "答"的判据要收紧：手机侧的 `'decline'`（超时）/`'cancelled'`（被撤回）与链子末端的
  `'unavailable'`（没人可问）**都不算答案**——否则"手机没电"会变成"自动拒绝"、
  "桌面暂时没人"会变成"手机还没点就失败"。桌面先答时我们 `abort` 自己那条信号，
  手机这一侧立刻作废（`pending` 条目删掉、`waiting` 角标归零）。
  每一路赛跑结果都**带着"是谁答的"回来**：`'rejected'` 这个词两端都可能给，
  只比数值就不知道该不该收卡（第一版就是这么错的，测试把它钉住了）。
  **任意一端答完，其他端那张卡当场作废**（这一轮补上的一条）：
  - **手机先答 → 桌面那张卡消失**：交给链子下游的那份 `request.signal` 被换成
    `AbortSignal.any([平台的, 我们这条])`，手机答完就撤销我们这条。宿主的 api-gateway 在
    它断掉时向**每一个**渲染端推 `{type:'cancel', eventId}`，卡片由宿主自己的代码收——
    我们只是宣告"这次请求结束了"，不替桌面决定结果（DSH 自己在多窗口场景本来就是这么做的：
    第一个客户端给出结果时其余客户端都收到 cancel）。
    ⚠️ 这条路只有读码读得出来：`next()` 忽略实参（换不掉下游收到的请求对象），
    `ApprovalService.decide` 又在派发**之前**就读走了原件，所以能动的就是那一个字段。
  - **桌面先答 / 平台撤回 / 主机超时 → 手机上那张卡消失**：结算点补发一帧 `ev.run_state`。
    这条帧本来就是小程序认的"挂着的审批/提问卡作废"的唯一信号（它同时清审批卡与提问卡、
    并停掉那条本地倒数），而内核**不会**为"审批被别人答掉了"发状态跳变（这一回合自始至终
    是 running），所以只能由主机补发。补的是内核当前真相，读不到才退缓存快照、再退 `idle`。
    协议里那条按 `requestId` 精确收单的 `ev.permission_resolved`（wire `66e9a63`）仍然待发——
    本仓装的 `dsh-remote-wire` 是 npm 上的 1.1.0，那份里还没有这一帧（追踪：伞仓 HANDOFF §3.10）。
  ⚠️ **代价写在代码注释里**：排到最外层意味着也排在 Auto 预置的自动审阅之前。本机没配 Auto
  （profile 里只有 read-only / workspace-write / danger-full-access），所以没有安全闸门被跳过；
  哪天接上 Auto，这一行要重新审。
- **`approvalFace` 不再被当成"能弹卡"的证据**：`status.json` 的 kernel 面新增四条读数——
  `approvalCalls`（监听器被调用次数）、`approvalLast`（最后一次走到哪一步：
  `answered-by-phone(…)` / `handed-back(no phone target)` / `handed-back(neither answered)`）、
  `approvalAsked`（内核报过几次 `approval/asked`）与 `approvalDecided`（最后一次 `approval/decided`
  的 outcome）。**"没人答"与"别人抢先答了"在现场长得一模一样**，只有 `decided` 能把它们分开——
  这一轮就是靠它从"还是被过滤了"翻到"是排在桌面后面"，少一个字段就要多猜一轮。
- 关弹窗这一半再加两条读数：`approvalSignalHandoff`（`fused` / `ignored` / `failed: <原因>`——
  请求对象的 `signal` 到底换没换成可撤销的那一份）与 `approvalDesktopVoided`
  （手机先答之后撤销了几次，**只在换成功时才计**）。屏幕上看不出桌面那张卡收没收的时候，
  这两个数就是唯一的现场证据：加了而卡还在 ⇒ 断在渲染端；没加 ⇒ 我们这侧没换成功。
- `src/transport/relay.ts` 的 Prettier 格式（随 `4e2528c` 提交进来的长签名），`format:check` 全绿。

- **手机聊天框不再出现原始 XML、工具标题是人话、结果预览不再是乱码**（三件事一个根因：
  内核事件到插件事件的形状映射）。① `assistant/message` 的正文里带着 XML 序列化的工具调用
  （与结构化 `tool/call` 事件是同一信息的第二份副本），剥掉后只留正文，剥完是空串时
  仍发空正文帧（mp 对空正文不建块）；② 工具步骤标题改取模型写的 `description`——
  原来整串贴 455 字符的 JSON；③ `tool/result` 的正文是 part 数组，旧实现 `JSON.stringify`
  出字面量转义（手机上就是一片乱码），改成取文本（数组取文本 part、对象按字段递归、
  非文本 part 跳过）。历史回放走同一个映射函数，旧会话翻上去也是干净的。

### 测试

298 项（上一版 290）。**跨端关弹窗这一轮新增八条，六次变异验证各自只抓到自己那条**：
`carrier-services.test.ts` 三条——**手机先答时下游那份 `signal` 必须已被换掉且已撤销**
（不换 / 不撤 / 撤销时连 runtime 那侧一起带倒，三种变异都红）、
**平台中断时并算后的 signal 要保住原来的取消能力，`reason` 也要带下去**、
**`signal` 不可写时不许抛**（严格模式给冻结对象赋值会抛，一抛就顺着 waterfall 把宿主的审批判死）；
`runtime.test.ts` 五条——**桌面先答/超时/撤回三种收场都要补一帧 `ev.run_state` 并留 reason**
（不补 → 5 红；reason 不区分"桌面先答"与"平台撤回" → 1 红）、
**手机自己点掉时不许补**、**内核读不到真相时退缓存快照、再退 `idle`**、
**提问那两类共用同一个结算点**。
`carrier-services.test.ts` 为"两边同时问"新增三条，**第一条就是那句红线**：
**手机先答也必须把链子交给桌面（`next()` 要跑到）**（把 `next()` 那一行拿掉它就红，已变异验证）、
**桌面先答时手机那一侧必须被 `abort`（否则手机卡继续倒计时、`waiting` 角标也不会归零）**、
**手机超时不算答案：桌面稍后给出的真决定必须赢**。
`client-bundle.test.ts` 为"等 N 件事"新增四条：**有东西在等时抬头说
`等 2 件事`、灯是 amber，面板第一行是 `待处理 · 2 件 · 最久 4 分 12 秒`**（把 `pillLabel` 里那条
分支删掉它就红，已变异验证）、**两条优先级：断链压过等待；没配上时挂起不抢抬头那一格，
但面板仍然要说**、**等待时长的四档写法（37 秒 / 1 分 0 秒 / 4 分 12 秒 / 121 分，全部走打出来的
bundle，不直接 import 那个纯函数）**、**`waiting` 缺席（老版宿主）时那一行不建、抬头退回"已配对"**。
新增 `host-id.test.ts` 九条，其中三条是**去掉"读回旧身份"那行就会红**的
判据（重启拿回同一个身份 / 老的 `h_xxxx` 不许借机换号 / 两个实例抢同一目录只有一个胜出），
另外守住 0600、不认的形状要修好并落回去、目录不可写时退回一次性值且不抛。
`carrier-services.test.ts` 新增四条：**登记必须带
`{ global: true, prepend: true }`**（两个选项各摘一个都会红——它们测的不是"挂没挂上"，
而是"挂的地方收不收得到、收得到的时候排不排得到"）、
**被调用时 `approvalCalls`/`approvalLast` 要记到 `answered-by-phone(…)`**、
**没有会话 id 与手机超时两条交还路径要分得开，且都必须 `next()` 交还桌面**、
**审批审计的 `approvalAsked`/`approvalDecided` 要进 status.json**（`decided` 记最后一次的 outcome）。
`client-bundle.test.ts` 新增四条：**"配上之后从二维码翻回状态视图"**
（翻面只重画，不许顺手再要一张）、**"样式表按内容对齐"**（预置一份旧 `<style>`，要求它被换掉、
且不许插第二份）、**"正文三行各自拿不到值时不占地方"**（老版路由没给 `version` 时那一行消失）
与**"`状态` 按 relay 取值翻译"**（连接中 / 已断开 / 未启动）。另外三条按新行为改判：
断链时说 `已断开连接` 且 `tone=error`、二维码页那颗按钮叫 `刷新`、过期后按钮仍是 `刷新`。
`pill-isolation.test.ts` 的 `/status` 字段集合断言加了 `version`，并钉住"源码直跑时它是 `dev`"。

## [1.2.0] - 2026-10-03

这一版把"界面上那一半"收敛成**一条路**：状态栏那颗 pill。右栏自动弹码与终端文本码同时删除，
`/drc pair` 也不再是配对入口（**破坏性变更**，见下）。

### 新增

- **状态栏那颗 pill：抬头是状态，点开是连接信息，发码要再按一次**。宿主侧三条同域路由——
  `POST /plugins/dsh-remote-control/pairing/new`（幂等发码）、`GET /plugins/dsh-remote-control/pairing.png`
  （弹窗里那张二维码，按需现渲染，`no-store` + `ETag` 用同一口径的 epoch）、
  `GET /plugins/dsh-remote-control/status`（四个非凭据字段：`relay` / `paired` / `hostLabel` /
  `serverUrl`）。浏览器面把一颗 pill 注册进宿主的 `conversation.composer.dock` 槽位：
  抬头那句是 `远程未启动` / `远程未连接` / `连接中` / `未配对` / `已配对`，灯分别是灰 / 灰 / 黄 / 灰 / 绿
  （"有码还没人扫"不再单列一句，也不再给绿灯——绿只能表示真配上了一台）。点一下弹面板，顶部那几行
  就是上面四个字段读出来的**连接信息**（本机名、中继 `host:port`、状态、配了几台），发码是面板里那颗
  **生成配对码**（已配上时改叫**再配一台**）——点开不再顺手向中继申请码，"看一眼"不该消耗 pending 表。
  按下去之后二维码与 6 位数字同时在场（扫不出来时的唯一退路），寿命走完自动再要一张。
- 三条回答里**都不含 `psk`，也不含完整配对 URI**。发码那条是**会改状态**的路由，跨站判据是一个
  只有同源脚本发得出的自定义头 `x-drc-pair: 1`（跨站要带它必然触发 CORS 预检，而这条服务不答应
  预检）；`Origin` 存在时仍要判（环回 http(s) 或宿主自己的 `dsh-app:` 这类自定义 scheme），
  但**它缺席不是拒的理由**——桌面宿主转发 web 请求时会在更外层把 `origin` 头删掉，这一条是
  2026-10-03 在真屏幕上点出来才发现的（当时判据写成"Origin 必须存在"，于是 pill 渲染得好好的、
  点下去永远 403）。403 回答里因此带上**是哪一道守卫**（`guard:"pair-marker-missing"` 等），
  并由 pill 印在弹窗上：宿主 stdout 不落盘，屏幕上那句话是浏览器面唯一的现场。
- `status.json` 的 `pill` 探针（`webServer` / `routes` / `pill`）与一条 `warn:pill`：
  配对入口不可用时必须查得到原因——命令行兜底删了以后，"配不了对"不该是静默失败。
  那条 warn 是**每次写快照时现判**的，不是 `apply()` 里一次性 push：`webServer` 可能由
  `ctx.inject` 的回调晚到，一次性判断会留下 `routes:"registered"` 与 `problems:["warn:pill"]`
  并存的假警报（2026-10-03 真机重装重启后实测抓到，`pill-isolation.test.ts` 里
  "webServer 晚到"那条用例钉住它）。
- 半途失败要回滚：三条路由依次挂，第二条挂不上时第一条**必须被注销掉**，否则它永久留在宿主上、
  `stop()` 再也拿不到注销函数，表现是"重载一次之后那颗 pill 再也不出现"。

### 删除（破坏性）

- **右栏自动弹码那一半整个删除**：宿主侧按节拍渲染 PNG 落到会话工作区、那条只读路由
  `GET /plugins/dsh-remote-control/pairing`、以及浏览器面 `sidebarRight.openResource` 的轮询。
  连带删掉的模块：`src/presentation/{address,presenter,route,sidebar}.ts`（守卫与 `pairingEpoch`
  搬进 `pill-routes.ts`，只留一份）。
- **终端文本码删除**：`platform/qr.ts` 的 `renderTerminalQr` 与 `ascii`/`block`/`half` 三种样式、
  ANSI 反色。理由是它在这个唯一宿主上从来扫不出——DSH 命令卡按 `line-height:1.6` 渲染等宽输出，
  行间留白把半块码横切成条，实测 zxing 在 ≥1.15 行距即失败（取证仍留在 `qr.ts` 文件头）。
- **`/drc pair` 不再是子命令**：`/drc` 只剩 `status` 与 `unpair`。它走的是"每次发一张新码"，
  会在 pill 那张之外再多挂一个仍然有效的 PSK，而手机扫的是屏幕上那张——正是当初"多码事故"的形状。
  打字习惯还留在 `/drc pair` 上的人拿到的是状态快照，不是错误。
- 配置键删除：`qrImage`、`qrOpen`、`qrAnsi`、`qrStyle`、`sidebarQr`（含 `imageFile`/`refreshMs`）。
  留在 patch 里**不产生任何效果**，也不会有 warn（当天先做过一张"退役键各报一条 warn"的表，
  随后按"删了就不会回来，用到再重写"撤掉——见下面"清理"那节）。环境变量
  `DRC_QR_IMAGE`/`DRC_QR_OPEN`/`DRC_QR_ANSI`/`DRC_QR_STYLE`/`DRC_SIDEBAR_QR` 同样删除，
  新增 `DRC_PILL=0/1`。
- **为右栏而开的内核口一起删除**：`provide('dshRemoteControl').sessionWorkspace`（"会话 → 工作区目录"
  那个口原来是给右栏那张图算落点的）、内核侧实现 `kernel.sessionWorkspace`，以及只为它存在的诊断字段
  `kernel.workspaceFace`。pill 的二维码是路由**当场渲染、当场回字节**的，不再往磁盘写，所以这条路上
  已经没有任何调用方。

### 变更

- 一次启动现在挂 **3 条**路由（1.1.0 是 1 条，pill 第一版是 4 条），停机一起注销。
- 浏览器面的服务声明从 `inject: ['sidebarRight']` 改为 **`inject: ['slots']`**（右栏那半删掉了，
  `slots` 才是这一半真正要的那个服务），写法照宿主自带的 `templates/decoration/client.js`：
  `ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(...))`。
- **删除过程中抓到并修掉一个真缺陷：那颗 pill 整颗不出现**。把声明改成空 `inject: []`（当时想
  让 `slots` 走软探测）之后，`apply()` 跑在槽位服务之前，而 `mountPill` 只软探一次就返回——
  屏幕上再也没有那颗按钮，而**当时 262 项单测全绿**（假上下文只给同步的 `ctx.get`，演不出"服务
  还没到"）。旧的 `['sidebarRight']` 无意中把激活时机推到了服务齐之后，所以第一版看起来是好的。
  现在三样一起有：`slots` 声明进 `inject`（正路）、软探测与 `ctx.inject(['slots'], …)` 的晚到回调
  两条退路（回调里只 mount 一次），以及一条能演"晚到"的测试（`client-bundle.test.ts`
  的 `lateSlots`/`flushInject`）。`apply` 时没探到的那句 warn 改成"已挂回调等晚到"，不再断言
  "这代宿主没这个服务"。
- **那颗 pill 在挤不动的那一排里不再逐字断行**。宿主 dock 空间不够时会把每一项自己截断
  （`6 轮 …`、`1.6M to…`），而按钮本身是 flex 项、默认可以缩到"中文的最小内容宽度 = 一个字"，
  于是 `已连 1 台` 竖着排成四行（2026-10-03 用户截图）。现在 `.drc-pill` 写死
  `flex: 0 1 auto; white-space: nowrap`，`.drc-label` 给 `min-width: 0` + `text-overflow: ellipsis`，
  与邻居同一个形状；全文仍然在 `title` 与 `aria-label` 上，悬浮和读屏都不丢。
- 配对二维码的编码/解码防回归（伞仓 `scripts/validate-qr.mjs`）从"三条产物"降到两条：
  PNG 与裸矩阵。

### 清理（同一轮，按"没用的就删，用到再重写"）

- **`apiProxy` 那条载体探都不探了**：这一版从一开始就不接它（桌面态没注册过这个服务，旧实现的
  调用信封整个是错的），却仍然 `ctx.get` + `ctx.inject` 各探一次、把结果收进 `collected` 里等一个
  永远不会来的调用方。现在这两块连同 `apiProxyOf()` 一起删掉，注释里写清"真要用再写"。
- **没人读的口与写盘遗物**：`writePrivateFile`（右栏那张 PNG 落盘时代的工具，现在只有测试调它）、
  `StatusFile.refreshing` 与 `StatusFile.path` 两个 getter（注释声称"测试读它"，实际零调用方）。
- **零消费者的导出**：`HISTORY_LIMIT_DEFAULT`（与 `runtime.ts` 里那份是同一个常量的两份）、
  `ports` 的 `PeerSink`/`PendingQuestion`/`TransportPort`/`AnswerItem`、`guard` 的
  `SubscribableEvent`/`WaterfallParticipant`、`qr.ts` 的 `qrModuleCount`，以及 `redactSecret` 与
  `redact` 这个双名导出（合成一个名字）。
- **退役配置键的 warn 表删除**（见上面"删除"那节），连带 5 条断言。
- 顺带清掉 `tsc --noUnusedLocals --noUnusedParameters` 报出的全部未用导入与未用局部。
- **"presentation" 这个名字全部清掉**（右栏方案删了之后它已经什么都不指了）：
  `src/presentation/` → **`src/pill/`**（`pill-routes.ts` → `routes.ts`、`pill.ts` → `start.ts`），
  三张测试改名 `pill-routes.test.ts` / `pill-isolation.test.ts` / `client-bundle.test.ts`，
  全部 import 与注释引用重接；`scripts/install-to-profile.sh` 里为第二个 cordis 条目
  （`dsh-remote-control-presentation`，从未发到 npm，只有本机 profile 装过且早已摘掉）
  留的退役清理也删了——那是一段永远命中不到的迁移代码。
  **同轮修掉一个真隐患**：那个脚本每次运行都往 profile 里多写一份
  `package.json.bak-drc-<时间戳>`，本机已经堆到 **83 份带 `hostToken` 的副本**；
  现在改成单份滚动 `package.json.bak-drc`，并在写入前清掉历史遗留的时间戳副本。

### 测试

265 项（1.1.0 是 280 —— 那 280 里含 72 项属于这次删掉的两条路，另 3 项属于现在没人调的
`sessionWorkspace`）。删掉 5 个只属于那两条已删路径的测试文件；
`pill-routes.test.ts`（22 条）、`pill-isolation.test.ts`（8 条，含
"配对入口只有 pill：两种宿主上 hint 都不许再宣传 pair"与"webServer 晚到时 warn:pill 必须自己消失"）、
`client-bundle.test.ts`（22 条，在 vm 里真跑打出来的 `client.cjs`，含"`slots` 晚到时那颗 pill 必须补挂"、
"点开只给连接信息、不许顺手发码"、"抬头那句不许把中文逐字断行"）。
伞仓 `e2e/run.mjs` 新增一步：**真中继在线**时点那三条路由——发码、幂等复点同一张、
出的 PNG 与主机维护的那张码同一个 epoch（单测里发码分支永远是"中继不可达"，那条路此前从没走过）。

## [1.1.0] - 2026-10-03

### 新增

- **右栏自动弹码进主插件**：一次构建产出两半——宿主侧 `dist/bundle/index.js` 与浏览器面
  `dist/bundle/client.cjs`。`/drc pair` 之后当前配对码落成 PNG、经一条同域只读路由交给浏览器面，
  右栏自动弹出那张图：不需要用户手动打开侧边栏，也不静默切换工作区。
- 配置项 `sidebarQr`（`enabled` / `imageFile` / `refreshMs`）；环境变量 `DRC_SIDEBAR_QR=0` 可整体关掉。
- `status.json` 多一块 `sidebar`：右栏那一半的软探测结果（`route=registered` / `webServer=none` /
  `disabled` / `register threw: …`）。"二维码没弹"从此有第一现场，而不是只能猜。
- `tests/pill-isolation.test.ts`：同一个假上下文跑两遍 `apply()`，只差有没有 `webServer`，
  要求主链路可观察字段**逐个相等**、`/drc` 返回**逐字节相等**。

### 变更

- **删除 `packages/presentation`**，包名 `dsh-remote-control-presentation` 退役，本仓只剩一个包。
  原来拆两包只是为了在宿主没有 `webServer` 服务时"只有那一行不激活"；折成一个包之后这个隔离
  由代码提供（`src/presentation/sidebar.ts` 只软探测 `webServer`，拿不到就整半不起）。
- 只读路由随 bundle id 改名：`/plugins/dsh-remote-control-presentation/pairing` →
  `/plugins/dsh-remote-control/pairing`。同域、只读、环回+来源守卫三条不变。
  profile 里若还留着旧条目，`scripts/install-to-profile.sh` 会把它从 `dsh.profile.bundles`
  与 `node_modules` 一起摘掉——留着只会多一条"bundle 在列表里但目录已删"的加载失败记录。
- 发布产物收窄为 `dist/bundle` + `cordis.patch.yml`。`exports` 只指向自包含单文件，
  之前 tarball 里的 `dist/src`、`dist/tests`（约 90 个文件、449 KB）全是消费方拿不到的东西。

[未发布]: https://github.com/providcc/dsh-remote-control/compare/v2.0.15...HEAD
[2.0.16]: https://github.com/providcc/dsh-remote-control/compare/v2.0.15...v2.0.16
[2.0.15]: https://github.com/providcc/dsh-remote-control/compare/v2.0.14...v2.0.15
[2.0.14]: https://github.com/providcc/dsh-remote-control/compare/v2.0.13...v2.0.14
[2.0.10]: https://github.com/providcc/dsh-remote-control/compare/v2.0.9...v2.0.10
[2.0.9]: https://github.com/providcc/dsh-remote-control/compare/v2.0.7...v2.0.9
[2.0.7]: https://github.com/providcc/dsh-remote-control/compare/v2.0.6...v2.0.7
[2.0.6]: https://github.com/providcc/dsh-remote-control/compare/v2.0.5...v2.0.6
[2.0.5]: https://github.com/providcc/dsh-remote-control/compare/v2.0.4...v2.0.5
[1.2.0]: https://github.com/providcc/dsh-remote-control/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/providcc/dsh-remote-control/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/providcc/dsh-remote-control/releases/tag/v1.0.0

## [1.0.0-rc.1] - 2026-10-06

> **首个开源候选版。** 四仓统一用这一个版本号；此前的 2.0.x 是私有期编号。
>
> ⚠️ 它的**版本号小于**上面的 2.0.x（`1.0.0-rc.1 < 2.0.0`），所以按 semver 排在**下面**。
> 那一轮它被放在文件最上面 —— 读的人会以为 rc1 才是最新一版，而它其实是最旧的一版。

### 新增：会话状态接上 `awaiting-permission` / `awaiting-answer`

协议里这两个状态一直有、小程序的「等你处理」区与「待审批/待回答」徽标也只认这两个
字符串，而这里只产出 `archived | running | idle` —— 真机上那个区**永远不出现**
（e2e 是自造状态喂进去的，测试绿、真机空）。现在由 runtime 的挂起表经 index.ts 注入
给 carrier；审批优先于提问（180s vs 300s）。

### 修复（rc1 前逐行审计的产出，每条都有判据在旧代码上验过会红）

- **真 cordis ctx 上 `typeof ctx.off === 'function'` 会抛错**（get trap），把 sessions
  那条 inject 回调整段打断——真机 `status.json` 里已经复现，只是被下一个回调侥幸救回。
- **on/off 绑定移出 accept + 支持 on 晚到补订阅**：原来若宿主在 apply 时就能
  `ctx.get('sessions')`，内核会在任何 inject 回调之前启动，带恢复会话时 subscribe 读到
  `services.on === undefined` 就**永久关闭流式**（无重试，而 `describe()` 现读 `hasOn`
  显示 true 掩盖真相）。
- **附件总量闸**：主机原来只卡单文件 512KB，schema 允许 4 个 → 最坏约 2.7MB 进一帧，
  超中继 1MB 就是 socket 1009 断开（不合规客户端能掐断主机自己的中继连接）。
- **平台已 abort 的审批/提问当场结算**：`addEventListener('abort')` 对**已经 abort** 的
  signal 永不触发，于是卡照发、锁照挂，整个超时窗口（180/300 秒）手机上是可点的死卡。
- **`pushSessions` 全程 try/catch + 调用点 catch**：原来 13 处 `void` 调用任一处抛出即
  未捕获 rejection（Node≥15 默认终止进程），违反"绝不带崩宿主"。
- 结算校验 `item.kind`（跨类 requestId 原来会串类结算且回 ok:true）；审批决定改白名单
  （只认 `approve`）——原来是 fail-open，未知词一律**放行**；`stop()` 收卡；挂锁改
  `finally` 配对；`start()` 两步都成功才置位；模型补发只与列表求交。
- 落盘与权限：`status.json` 补 `chmod 0600`（那个文件在开启动发码时含有效配对码+PSK）；
  pair-store 写失败保持脏标记（原来 PSK 会静默不落盘且永不重试）；`pairTtlMs` 折 Infinity；
  死配置键 `carrierGraceMs` 删除；`pair-fail` 接线（换码退避）。
- 浏览器面：倒计时不再每秒重建二维码页（每秒重编码一张 QR）；首帧 `/status` 未落地时
  点开面板**不发码**（原来已配对的主机也会被发一张新码）；`/status` 非 200 留 warn；
  轮询加超时与 in-flight 守卫；注入样式补 `data-plugin`（会被宿主 HMR 当成别人的删掉）；
  配对码不再进 stdout 日志；跨站 Origin 白名单化。
- 文档口径对齐（`uploadDir` 默认值、`maxImageBytes` 其实是 `maxFileBytes`、
  `status.json` 的 pairing 与 `pairOnStartSec` 无关等）。

判据：410 → **448** 条。

## [1.0.0] - 2026-10-03

### 新增

- DSH Remote Control 宿主侧插件的首次公开发布（npm 包 `dsh-remote-control`，本仓 monorepo 产出）。
- 与零知识中继的配对与长连接；主机认证与自动重连。
- 会话发现、指令下发、流式输出回传；审批（提问）转发到手机并可回答。
- 防休眠策略：有会话时保持唤醒，空闲后自动释放（`caffeinate` / `systemd-inhibit`）。
- 配对二维码渲染：默认出 **PNG**（文本码在 DSH 命令卡的行高下扫不出来），可落到会话工作区 `.dsh`。
- 本仓第二个 bundle `dsh-remote-control-presentation`（`private`，不发 npm）：把当前配对码落盘并
  暴露一条同域只读路由，浏览器面轮询它并**自动推开右栏**——不需要用户手动打开侧边栏，也不静默切换工作区。
- 状态快照 `status.json`（0600）作为 GUI 宿主的排错入口，密钥字段一律脱敏。
- 对宿主内核面的软探测：不写 inject 闸门，缺服务时受影响面最小。
- 自包含单文件产物（esbuild），安装只需拷文件 + 注册 bundle，profile 里不需要 `node_modules`。

