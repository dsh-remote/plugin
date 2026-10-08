# V3-PLAN — DSH Remote Control v3

> **这份文档是什么**：v3 的完整计划。写于 2026-10-08，依据是两轮取证——
> ① 对 WorkBuddy 微信小程序反编译产物的分析（界面 / 交互 / 通信协议）；
> ② 对 v2 四仓的跨平台审计（逐 `file:line`）。
>
> **不是什么**：不是待办清单，也不是现状描述。凡是"现在是这样"的地方都带
> `file:line` 或实测数据；凡是"打算这样做"的地方都在 §7 及之后，**一条都还没实现**。
>
> 前置阅读：[`PRODUCT.md`](PRODUCT.md)（三条承诺与 30 秒原则）→
> [`EXPANSION-PLAN.md`](EXPANSION-PLAN.md)（多 profile / 三平台 / 自建中继的既有调研）
> → [`DESIGN.md`](DESIGN.md) §2（三张冻结契约表）。

---

## 0. 一句话目标

**把 v2 的"能用"，做成 v3 的"好用、好装、好自建"：界面按 WorkBuddy 的语言重做，
协议长出断线续传，中继能在三平台自建，插件与小程序说同一套话。**

三条底线一条都不动：**零知识 / 无账号 / 手机免安装**（`PRODUCT.md` §2）。

---

## 1. v2 基线：要**全量保留**的东西

这一节的作用是"v3 不许悄悄丢东西"。逐条列，其中任何一条在 v3 里消失都算回归。

### 1.1 产品承诺（不可让步）

| # | 承诺 | 判据落点 |
|---|---|---|
| 一 | **零知识**：PSK 只经二维码，从不上网；中继只见 `base64(nonce‖secretbox)` | `e2e/live-e2e.mjs` ⑩/⑩b 逐帧查明文；`e2e/run.mjs` 第 16 步；中继 `tests/bundle.test.mjs` 断言产物里没有密码学代码 |
| 二 | **无账号、无常驻服务**：配对即授权，退出即结束；中继是一个自包含单文件 + 一个服务单元 | 无 DB、无 schema 迁移；`/healthz` 的 `stateWriteFailures` 是落盘活着的唯一判据 |
| 三 | **手机免安装**：微信小程序，打开即用 | 无原生 App |

### 1.2 30 秒原则的五条规则

首屏必须是"有什么在等你" / 每一眼都要能回答"远程还管得住吗" / 超时必须可见 /
"不行"要留得下原因 / **一端答完其他端那张卡当场作废**。

### 1.3 功能面（v2 已有，v3 必须继续有）

| 面 | 内容 |
|---|---|
| 配对 | 二维码（`dshr:/p?v=1&s=…&n=…&psk=…&t=…`）+ 6 位码；一次性；TTL 由服务端权威；`pair-fail` 带是哪一张码失败 |
| 会话列表 | 只读 + **归档/取消归档**（`cmd.archive_session`）；「等你处理」优先区；按工作区分组；长按新建到指定分组 |
| 聊天 | 流式正文（分片合并、`done` 收尾）；工具调用；思考过程折叠；待办快照；审批卡（含倒计时、超时交还桌面）；提问卡；模型名显示 |
| 历史 | 游标分页（`cmd.session_history`，只有 `nextBeforeSeq`，无 `hasMore`）；「加载更早」 |
| 附件 | 图片（宿主原生图片块，正文不出现路径）+ 文件（落盘 + 路径入正文）；整批先验后写 |
| 会话控制 | 新建（可指定 workspace）、中断 |
| 防休眠 | `cmd.keep_awake` + `ev.keep_awake_state`（mp 侧暂无界面，见 §10.7） |
| 运维 | `status.json`（唯一排错入口）+ pill 四条同域路由（`/pairing/new`、`/pairing.png`、`/status`、`/unpair`） |
| 主题 | **浅色 + 深色**（自制 `theme.js` + 生成器 + 对比度闸 304 组） |

### 1.4 协议面（`dsh-remote-wire@2.0.21`，`describeCatalog()` 实测）

```
帧  16 个（去重）  8 个 endpoint→relay + 10 个 relay→endpoint
cmd 10 个  ev 15 个   能力 16 个   错误码 15 个
```

- **帧**：`hello hello-ok pair-begin pair-begin-client pair-ready paired pair-fail
  peer-joined peer-left resync enc enc-batch session-leave ping pong error`
- **cmd**：`send_prompt answer resolve_permission interrupt list_sessions keep_awake
  session_history new_session get_pending archive_session`
- **ev**：`session_changed message_delta tool_event permission_request
  permission_resolved question_request question_resolved run_state todo retry
  compaction keep_awake_state model result session_history`
- **capability**：`drc.v1 | pairing.qr | pairing.token | payload.attachments |
  payload.history | payload.new-session.workspace | payload.get-pending |
  payload.keep-awake | payload.archive-session | payload.model |
  payload.retry-compaction | cmd.idempotency | data.enc-batch | host.resync |
  host.info | crypto.v2`
- **error**：`bad_role bad_token need_host need_client bad_pair pair_table_full
  unknown_session not_member host_unavailable bad_frame rate_limited bad_json
  unknown_frame unsupported_protocol internal`

### 1.5 四仓与闸门

| 仓 | 规模 | 闸门 |
|---|---|---|
| `dsh-remote-protocol` | 2.9k 行 | 168 条 |
| `dsh-remote-server` | 3.0k 行 | 197 条（1 skip） |
| `dsh-remote-control`（plugin） | 9.5k 行 | 524 条 |
| `dsh-remote-mp` | 11.4k 行 | 五道闸（verify / md 35 / scroll 14 / theme / contrast 304） |
| 伞仓 `e2e/` + `scripts/` | 15.6k 行 | 364 条 + `pnpm gates` 逐格比对 README |

### 1.6 v2 已经做到的、容易被忽略的硬功夫（v3 不许退化）

- 中继**结构性零知识**（构建产物里没有 tweetnacl/xsalsa20 痕迹，有判据）
- **帧预算**与合帧（`MAX_CIPHERTEXT_BYTES = 1MiB − 8KiB`，三端同源常量）
- **`cmdId` 幂等台账**（窗口 + 容量双淘汰；`takeEvicted()` 让并着的回执表跟着收缩）
- **审批 waterfall 参与**（只有参与 `approval/request` 才能到达手机；无手机在线时 `next()` 交还桌面）
- **一端答完另一端当场作废**（两个方向用不同机制，各有一条读数）
- **恢复出来的会话立刻 `runtime.start()`**、四仓 `pnpm gates` 与 README 项数逐格比对

---

## 2. 参考对象：WorkBuddy 小程序（取证实测）

### 2.1 它是什么

| 项 | 实测 |
|---|---|
| 渲染器 | **Skyline + glass-easel**（`app-config.json` 的 `window.renderer`）⇒ **没有 .wxml/.wxss 源文件**，结构编译进 JS、样式编译进 `.fpcssb` 二进制 |
| 规模 | 主包 5 页 + **35 个分包、共 96 个页面**；`pages/home` 预载 5 个包 |
| 导航 | **无 tabBar**；96 页里 **92 页 `navigationStyle: "custom"`** |
| 深色模式 | **不存在**。全树 `prefers-color-scheme` / `data-theme` / `darkMode` / `.dark` **0 命中**；全库唯一 `@media` 是 `orientation:landscape` |
| 设计基准 | **428px 画布**，比例尺 `×1.7517`（= 750/428），**4px 整数网格** |
| 主色 | 旧 token `--color-primary: #10a37f`；新 token `--wb-color-text-brand: #00a885` |
| 动效 | 30 个 keyframes；`transition` 754 处；主曲线 `cubic-bezier(.4,0,.2,1)`，300ms 级 |

### 2.2 通信协议（**最有价值的一节**）

| 项 | 实测 |
|---|---|
| 主通道 | **JSON-RPC 2.0 over HTTP POST + SSE**。出站 `wx.request({enableChunked:true, responseType:'arraybuffer', method:'DELETE'!==e.method})`；入站 GET SSE 流 |
| 方法集 | 客户端→agent：`initialize session/new session/load session/prompt session/set_model session/set_config_option session/cancel` |
| 通知 | `session/update{update:{sessionUpdate: ...}}`，判别值含 `agent_message_chunk agent_thought_chunk tool_call tool_call_update plan usage_update user_message_chunk available_commands_update current_mode_update config_option_update session_info_update` |
| 反向调用 | `session/request_permission fs/read_text_file fs/write_text_file terminal/{create,output,wait_for_exit,kill,release} mcp/{connect,disconnect}` |
| **续传三件套** | HTTP 头 `Acp-Connection-Id` + `Last-Event-ID`；通知内 `_meta["codebuddy.ai"].offset`（增量去重/定序） |
| 心跳 | `heartbeatTimeout: 60000`，10s 轮询检测；**SSE 注释行（`:`）也刷新 lastSeen** |
| 重连 | `{initialDelay:1000, maxDelay:30000, maxRetries:Infinity, jitter:true}`，退避 `min(U·2^(n-1), max) ± 25%` |
| 流式节流 | **50ms**，首帧 `immediate` |
| 收尾 | **无 `[DONE]`**；靠 `session/prompt` 的响应 `stopReason` + 扩展通知 `session/endTurn` |
| 错误码 | 两族：`CH_SDK_4001 request_invalid` … `CH_SDK_5050 channel_unavailable`；`CONV_SYNC_4001 request_invalid` … `CONV_SYNC_5041 desktop_request_timeout` |
| **端到端加密** | 云端 ACP **明确没有**（全量 grep `encrypt\|decrypt\|AES\|crypto.subtle\|Cipher\|CryptoKey` → 0 命中）。协议即明文 JSON over TLS |
| 本地通道 | **不是直连内网**，是「云端中继 + deviceId + scope」：`addExecutorTarget(deviceId)` → `ensureScope({userId, deviceId, apiBaseUrl})`；`127.0.0.1` 全树只出现在 OTEL 默认配置里 |
| 多环境 | prod / staging 自动判定（`apiBaseUrl.includes('staging.')`）+ 企业 IOA 登录时整套换域；**没有任何用户可填的自部署 URL 输入** |

### 2.3 界面层可借鉴的（原样取证）

**消息排版（关键差异）**

```
user-bubble      {background:#e7e9e8; border-radius:24rpx 24rpx 8rpx 24rpx;
                  max-width:80%; padding:24rpx 28rpx}      ← 右下小尾角灰气泡
assistant-content{background:transparent; border:0; border-radius:0;
                  box-shadow:none; max-width:100%; padding:0} ← 通栏、无气泡
```

**默认值**：`--wb-spacing-*` = 4/8/12/16/20/24/32px；`--wb-radius-*` = 4/8/12/16/24px；
`--wb-font-ui-*` = 13/14/17px；`--wb-shadow-input: 0 4px 30px #00000014`。

**composer（`ChatInputBar`）**：一整个 **24px 圆角胶囊**（`inset 0 0 0 .5px #ffffff1a` 描边 + 大投影）。
自上而下：命令条 → 专家/同事条 → textarea（`font-size:32rpx; max-height:300rpx`）→
语音行 → toolbar。
**toolbar-left 顺序**：语音按钮 → 模型 → 连接器 → `@助理`；**toolbar-right**：＋ → 发送/停止。
**发送按钮状态机**：`idle`（有内容才渲染）/ `queue`（发送 + 停止并存）/ `stop`（只有停止）。

**底部弹层**：通用壳含 `__mask(--Entered)`、`__panel(--Entered,--Resizable,--Dragging)`、
`__handleZone > __handle`（拖拽把手走属性标记 `data-popup-header="true"` / `data-popup-handle="true"`）、
**三档高度 `__tierCompact / __tierStandard / __tierExpanded`**；
mask `#0000004d`；panel `#fff` + `env(safe-area-inset-bottom)`。

**其余可借鉴件**：`scroll-to-bottom-button(--visible,--streaming,__ring)`（流式时带旋转环）；
工具调用 `__status` 四态 `pending / in_progress / failed / cancelled` + 聚合（cluster）;
`cloud-chat-thought` 可折叠思考块；骨架屏（`dltb-skeleton` 宽度 72/88/64/80/56/76%）；
自研 Toast `CF({content, position: top|center|relative, theme: success|info|warning|fail|loading})`。

**流式表现**：**没有光标**。用文案机代替——`正在整理答案` / `正在继续处理` /
`深度思考中...` / `资料搜集中...`，外加 `shining-loading`（spinner + 文字）与
`typing-indicator > .dot`（`typingBounce`）。

**文案风格**：短句、动词开头、无主语；统一「**动作 + 原因/下一步**」
（`发送失败，请稍后重试` / `连接未就绪，请稍后重试` / `请求超时，请检查网络后重试`）；
几乎不用感叹号；emoji 极克制（只用于空态图标与任务派发）。

### 2.4 它**没有**、而我们有优势的

| 项 | WorkBuddy | 我们 v2 |
|---|---|---|
| 端到端加密 | ❌ 明文 JSON over TLS | ✅ secretbox + PSK 只走二维码，中继结构性看不见载荷 |
| 深色模式 | ❌ 完全没有 | ✅ 浅/深双主题 + 304 组对比度闸 |
| 自部署 | ❌ 只有企业 IOA 与构建期变量，**用户填不了地址** | ⚠️ 中继已可配 27 个 `DRC_*`，但**小程序端没有入口**（§8） |
| 账号 | 必须登录 | 无账号，配对即授权 |

---

## 3. 抄什么、不抄什么

**核心判断：抄"设计语言"与"交互骨架"，不抄"功能面"。**
它是"把工作台搬进手机"，我们是"离开工作台时那 30 秒"（`PRODUCT.md` §7）。
它的 96 页里有大量我们**结构上就不该有**的东西。

### 3.1 直接抄（照做）

| # | 内容 | 为什么 |
|---|---|---|
| 1 | **设计 token 体系**：428px 基准、4px 网格、间距 4/8/12/16/20/24/32、圆角 4/8/12/16/24、字号 13/14/17 | 白捡一套自洽的尺度；我们现在是 TDesign 变量 + 手写值混用 |
| 2 | **助手消息通栏、用户消息右下灰气泡**（`24/24/8/24`，80% 宽） | 直接解决 v2"两种消息长得差不多"的问题；长正文（我们主要场景）通栏可读性明显更好 |
| 3 | **composer 胶囊化** + 明确的左右分工（左：输入方式与上下文；右：附件与发送） | v2 的输入区是"一行按钮挤在下面"，没有主次 |
| 4 | **发送按钮三态**（idle / queue / stop） | 我们有中断但按钮语义没排开 |
| 5 | **底部弹层三档高度 + 拖拽把手** | 我们要加设置页、模型选择、附件来源，正缺这个壳 |
| 6 | **骨架屏**代替空白/转圈 | v2 首屏是空白直到列表到 |
| 7 | **自研 Toast（position × theme 二维）** | v2 用 `wx.showToast` 且只弹失败，缺一个统一的轻提示 |
| 8 | **"正在X"文案机** 代替一个干转的圈 | 流式等待期的可读性 |
| 9 | **工具调用四态 + 聚合** | 我们只有 `started/args/completed/failed`，缺 pending/cancelled，也没有聚合 |
| 10 | **`scroll-to-bottom` 带流式环** | 我们修过视口问题，但那个入口还没做 |
| 11 | **文案纪律**：短句、动作+下一步、少 emoji、无感叹号 | 我们的错误文案已经是这个风格，但没成文；v3 把它固化成判据 |
| 12 | **协议：offset 式断线续传**（`Last-Event-ID` 的思路，不一定用 SSE） | 见 §4.1，这是本次最大的技术收获 |

### 3.2 抄形状、不抄规模（选择性）

| 内容 | 怎么抄 |
|---|---|
| 底部弹层的**清单** | 只抄我们真有的：附件来源、模型（只读）、设置（自部署中继 / 主题 / 诊断）。**不抄**专家中心 / 技能广场 / 连接器 / 资料库 / 定时任务 |
| 消息长按菜单 | 只抄 `复制` + `重试`（+ 将来的 `编辑`）。**不抄** `摘录复制` / `朗读` / `分享` / `复制消息 ID`（后两个与零知识或产品定位冲突，见 §9.3） |
| 设置页 | 只放：主题、自部署中继、连接诊断、关于。**不抄**积分 / 分享 / 员工 / 项目 / 消息中心 |
| 分组/标签 | **不抄**。我们的列表已经按工作区分组，够用 |

### 3.3 明确不抄

| 内容 | 理由 |
|---|---|
| **96 页的页面结构** | 我们两个页面是产品定义的结果，不是能力不足 |
| **专家中心 / 技能广场 / 连接器市场 / 资料库 / 团队 / 积分** | 承诺二（无账号）直接排除；且它们是"工作台"，不是那 30 秒 |
| **语音输入 / TTS 朗读** | 云 ASR/TTS 会把正文送出设备 ⇒ **与承诺一冲突**。除非找到端上方案，否则不做（§9.3） |
| **推送通知（订阅消息）** | 带正文 ⇒ 冲突；不带正文则价值有限。**维持 v2 结论：不做** |
| **企业 SSO / 多租户** | 无账号前提 |
| **`attachment` 面板里的"模型切换"** | 我们宿主这一代**只给读不给写**（`modelFace = no-list+no-set`），长一个点了没反应的下拉比没有更坏 |
| **它的"无深色模式"** | 这是它的缺口，不是我们的目标 |

---

## 4. v3 的五条主线

### L1 · 协议 v3：从"全量对齐"到"增量续传"

**问题**：v2 断线后靠 `resync`（声明我有哪些会话）+ 历史回放（重新拉一页）来恢复。
粒度是**会话级**、动作是**全量**。弱网下这一下很贵，而且丢帧只能靠"拉历史"补。

**v3 做法**（照 WorkBuddy 抄思路，不照抄传输）：

1. **每条会话一条单调递增的 stream cursor**（宿主侧产、随帧下发）。
2. 客户端记住"我收到哪了"，重连时带 `since` 请求补差量。
3. 补不出来的（超出保留窗口）**如实说"这段没了，请拉历史"**，而不是静默跳号。

⚠️ **关键约束：不要把 WS 的语义烧进协议。** 游标、ack、since 都是**会话层**概念，
WS 与 HTTP/SSE 都能承载。这样将来换传输不用改协议（也是 §9.2 的前提）。

### L2 · 中继 v3：三平台可部署 + 自建友好

- **三平台**：Windows（服务包装 / 控制台关闭事件）、macOS（launchd）、Linux（systemd/容器）
- **零知识不变**：中继仍然只认 `frames/ids/negotiate/outbound`，**不 import payloads**
- **自建友好**：一眼可读的健康面、一条诊断命令、明确的绑定与防火墙说明
- **可选传输面**（见 §9.2，**低优先**）：为"WS 被企业代理掐掉"的场景留口

### L3 · 小程序 v3：设计系统 + 两个页面重做

- 换掉"TDesign 变量 + 手写值"的混用，建**自己的 token 层**
- 聊天页按 §3.1 重排；列表页补齐设置入口
- **深色模式保住**（我们的优势），token 层天生支持双主题

### L4 · 插件 v3：与小程序同一套设计语言

- pill 面板（`/status` 渲染的那一屏）与配对图重做成同一套 token
- 文案表统一（插件侧的中文与小程序侧共用一份措辞）
- 承载 L1 的新协议（cursor 的生产方）

### L5 · 跨平台：Windows / macOS / Linux

- 平台抽象层（`PathsPort` / `SecureFilePort` / `LifecyclePort`）
- 脚本去 shell 化（`.sh` → `.mjs`）
- CI 加 OS 矩阵
- 防休眠补 Windows 后端（或如实继续报 unsupported，见 §8.4）

---

## 5. 协议 v3 设计草案

> 冻结契约（F1–F13 / B1–B9 / T1–T8，见 `DESIGN.md` §2）**一律不动**。
> 下面全是**加性**变更，老客户端与老主机逐字不变。

### 5.1 新增：流式游标与补差量

| 名称 | 方向 | 形状 | 语义 |
|---|---|---|---|
| `ev.ack` | host→client | `{t:'ev.ack', sessionId, upTo}` | 可选。宿主周期性告知"我已发出到 N"，纯优化，丢了不影响正确性 |
| `cmd.session_history.since` | client→host | 复用现有命令，加一个可选 `since` | 与 `beforeSeq` **互斥**（向前 vs 向后）。带 `since` 时返回 `seq > since` 的新条目 |
| `ev.session_history` | host→client | 加可选 `latestSeq` | 告诉客户端"你现在到哪了"，便于下次 `since` |

**为什么不用新命令**：`cmd.session_history` 已经是"按 seq 取一页"，加一个方向参数比加一条
命令省四处登记（`PAYLOAD_TYPES` / `CMD_TYPES` / mp 便捷方法 / 宿主 switch）。

**判据（必须有的反向判据）**：
- `since` 与 `beforeSeq` 同时出现 ⇒ schema 拒（不许"两个方向一起走"）
- `since` 落在保留窗口外 ⇒ **明确回"这段没了"**，不许静默从窗口头部开始给
- 补差量与"拉历史"的结果**逐字节一致**（同一批 seq 给同样的条目）

### 5.2 新增：能力位

| capability | 含义 |
|---|---|
| `drc.payload.resume` | 支持 `since` 补差量（老主机不支持时客户端退回拉历史） |
| `drc.payload.artifact-preview` | 支持产物只读预览（§9.5，若做） |
| `drc.payload.approval-memory` | 支持"本次会话内始终允许"（§9.1，若做） |

**为什么用能力位而不是版本号**：v2 已经建立了"能力面与形状解耦"的纪律
（`registry.ts` 头注）。版本号只能表达"整体新旧"，表达不了"这一项有没有"。

### 5.3 新增：错误码的扩展位

现有 15 个码里没有"差量补不上"这一类。候选：

| 码 | 语义 | 可重试 |
|---|---|---|
| `history_window_exceeded` | `since` 太旧，补不出来，请拉历史 | ❌（要换动作） |

⚠️ **它必须进 `CLIENT_ERROR_TEXT` 的中文表**，否则手机上是一句英文。

### 5.4 帧预算要重算

v2 的预算是 `MAX_RELAY_MESSAGE_BYTES(1MiB) − 8KiB`。补差量会**一次带多条**，
所以要么走既有的 `enc-batch`（外层一条、内层 N 条），要么单独定预算。
**决定：复用 `enc-batch`**，不新开路径（它的 200 项上限已经在那里）。

### 5.5 兼容矩阵

| 组合 | 行为 |
|---|---|
| 新 mp + 新 host | 全功能 |
| 新 mp + 老 host | 能力面缺 `drc.payload.resume` ⇒ **不做 `since`**，走 v2 的"拉历史" |
| 老 mp + 新 host | host 不主动发新帧（`ev.ack` 是可选且加性）；`since` 从不出现 |
| 新 mp + 老 relay | 帧名不认识 ⇒ relay 的 `classifyEndpointFrameText` 回 `unknown_frame`，客户端据此降级 |

---

## 6. 跨平台改造清单（按审计结果，逐 `file:line`）

> 这一节是审计的原始产出，**v3 实施时直接当工单用**。

### 6.1 已经是跨平台的（**不用改**，列出来是为了不用再查一遍）

- `dsh-remote-protocol/` **全仓**：纯函数零 I/O
- plugin 所有路径拼接：全部走 `node:path`，**无 `path.posix`、无字符串拼 `/`**
- `plugin/transport/relay.ts:328` `new WebSocket(url)`：ws **客户端**出站，无绑定
- `plugin/platform/sleep-posix.ts`：平台探测是**构造注入**的，非 darwin/linux 时
  `isSleepSupported()` 返回 false、`start()` 明确失败——**有 else，不静默**。本次审计的正面样本
- `server/src/`（除 §6.3/§6.4）：无 `child_process` / `os.platform` / `path.posix` / `homedir`
- `server/persist.ts:269-285` 目录 fsync：Windows 下必抛，但调用点 `strict=false` 已 try/catch **优雅降级**
- **全仓无原生依赖**（`.node` 零命中）；依赖全是纯 JS
- `engines` 只有 `"node": ">=20"`，**无 `os`/`cpu` 限制**
- `pnpm-lock.yaml` 已含 `@esbuild/{darwin,win32,linux}-*`，三平台二进制齐

### 6.2 进程与命令执行

| 位置 | 现在 | Windows | 建议 |
|---|---|---|---|
| `umbrella/scripts/next-version.mjs:93` | `execFileSync('npm', …)` | **ENOENT**（Node/libuv 不解析 `npm.cmd`） | `process.platform==='win32' ? 'npm.cmd' : 'npm'` |
| `umbrella/scripts/report-gates.mjs:47-100,132` | `spawnSync(pnpm\|npm\|node, …)` | 同上，`pnpm gates` 整体挂 | 同上 |
| `umbrella/package.json` scripts | `sh …` / `cd … && env -u …` | 无 `sh`、无 `env` | 改写成 node 脚本 |
| `umbrella/scripts/approval-probe.mjs:65` | `execFileSync('lsof', …)` | 无 `lsof` → **静默**返回 `''` | 改 `node:net` 主动探测 |
| `proto/platform/sleep.ts:61-92` | darwin `caffeinate` / linux `systemd-inhibit` / default `null` | 走 default，如实报 `unsupported`（**刻意**） | 见 §8.4 |

### 6.3 shell 脚本

| 位置 | 问题 |
|---|---|
| `dsh-remote-control/scripts/install-to-profile.sh` | `#!/bin/sh`；`:123` `file.slice(0, file.lastIndexOf('/'))` 在 `C:\…` 上得 `-1` ⇒ **备份路径错**。→ 改写成 `install-to-profile.mjs`（`path.dirname`） |
| `dsh-remote-server/scripts/relay-start.sh` | `grep -oE` + `sed -E` 抽 token ⇒ 改写成 node |
| `dsh-remote-server/tests/scripts.test.mjs:60` | `spawn('sh', …)` ⇒ win32 skip，或先落 node 版再测它 |
| `deploy/systemd/*`、`deploy/docker/*`、`deploy/nginx/*` | 需补 Windows 服务配方（nssm / `sc.exe` 或容器） |
| `dsh-remote-server/docs/SELF-HOSTING.md:594-616` | 唯一非 Linux 配方是 macOS LaunchAgents |

### 6.4 路径与文件系统

| 位置 | 现在 | Windows 会怎样 | 建议 |
|---|---|---|---|
| `plugin/shell/config.ts:163,181` | `configured.startsWith('/')` | `C:\…`、UNC `\\host\share` **被误判成相对路径** ⇒ 被 `path.join` 改道（违反同文件反复强调的"不静默改道"） | `path.isAbsolute()` |
| `plugin/shell/config.ts:321` | `!statusFile.startsWith('/')` ⇒ warn | 正确的 `C:\…` **误报**"必须是绝对路径" | 同上 |
| `plugin/platform/carrier-services.ts:700-708` | `badWorkspace` 显式拒 `C:\…`（`:706` 有 `/^[A-Za-z]:[\\/]/` 分支，注释写着"Windows 明确不实现"） | **手机传来的 Windows 路径全判非法** ⇒ `newSession` 的 workspace 推断链全部落空、静默退回宿主默认目录 | `path.isAbsolute` + 平台感知 |
| `plugin/platform/carrier-services.ts:711-714` | `tailOfPath` `raw.split('/')` | 取不到最后一段 ⇒ 日志打整串（信息泄露 + 噪音） | `path.basename` |
| `plugin/shell/pair-store.ts:161-163` 等 **5 处** | `{mode:0o600}` + `chmodSync(0o600)` | `chmod` 只切只读位 ⇒ **0600 静默失效**，而这些文件装的是 PSK / 有效配对码 / host token | win32 明确 warn 一次（不许假装生效） |
| ↳ | 5 处清单：`shell/status.ts:42-49`、`shell/pair-store.ts:161-163`、`shell/host-id.ts:54-60`、`shell/uploads.ts:176`、`server/persist.ts:311-312` | | 收成一个 `SecureFilePort` |
| `plugin/shell/uploads.ts:75-83` | `safeSegment` 只留 `[A-Za-z0-9._-]` | **未拦 Windows 保留名**（`CON/PRN/AUX/NUL/COM1..9/LPT1..9`，`con.txt` 同样保留）⇒ `writeFileSync` 抛 EINVAL、整批附件回滚 | 加保留名表，命中加前缀 |
| 3 处 `renameSync(tmp, target)` | 原子替换 | 目标被占用（杀软/索引）会 `EPERM/EBUSY` | win32 有限重试（tmp 与目标同目录现已正确） |

### 6.5 信号与进程生命周期

| 位置 | 问题 |
|---|---|
| `server/main.ts:100-124` | `process.on('SIGTERM'/'SIGINT')` → `shutdown()`。Windows **无投递路径**：服务停止 = 硬杀 ⇒ **drain、`forceShutdown` 的状态落盘全不跑**。→ 把"优雅停机"做成可被**显式调用**的出口（信号只是触发源之一） |
| `e2e/restart-resume.test.mjs:162,322,419` | 断言"中继收到 SIGTERM → `exit.code === 0`" ⇒ win32 必挂 ⇒ skip |

### 6.6 测试装置里的平台假设

| 位置 | 问题 |
|---|---|
| `plugin/tests/uploads.test.ts:32`、`status.test.ts:268-274`、`pair-store.test.ts:70-72`、`server/tests/persist.test.mjs:436,447` | 断言 `mode & 0o777 === 0o600/0o644` ⇒ win32 永远拿不到 ⇒ 全挂 |
| `plugin/tests/host-id.test.ts:95`、`status.test.ts:147`、`pair-store.test.ts:106` | `chmodSync(dir, 0o500)` 造只读目录 ⇒ win32 造不出 ⇒ **前置条件不成立**，用例语义失效（假绿） |
| `server/tests/bundle.test.mjs:21,119`、`hardening.test.mjs:18`、`docs.test.mjs:247` | `new URL('…', import.meta.url).pathname` ⇒ `/C:/…` + URL 编码 ⇒ **产物路径无效**。同仓 `scripts.test.mjs:79-86` 已自我禁止这种写法却没禁这 4 处 ⇒ 统一 `fileURLToPath` |
| `e2e/mp-sessions-list.test.mjs:139-147,667-680` 等多处 | 夹具写死 `/Users/…`、`/tmp/x` ⇒ 改用平台无关值 |
| `umbrella/e2e/run.mjs:114,120,126` | 构建串 `'cd … && env -u NODE_OPTIONS pnpm -r build'` ⇒ 改成 node 调用（`cwd` + `env`） |
| 四仓 `.github/workflows/ci.yml` | 全部 `ubuntu-latest`，**Windows/macOS 零覆盖** ⇒ 加 OS 矩阵 |

### 6.7 平台抽象层建议

现有 `plugin/ports/index.ts`（343 行）已有 5 个端口：`KernelPort` / `SleepPort` /
`Clock` / `StatusSink` / `InteractionSink`。既有四条纪律应被新端口继承：
① 只有 `platform/`、`shell/` 可 import cordis；② 缺能力**必须显式报错或降级**；
③ 平台对象在适配器里折叠成插件自己的类型；④ 失败要带 `reason`。

**应新抽（按优先级）**：

| 端口 | 收什么 | 今天散在哪 |
|---|---|---|
| **`PathsPort`** | 绝对路径判定 + 数据目录派生 + 工作区形状判定 | `config.ts:163,181,321` + `carrier-services.ts:703,712` —— **四处各写一遍**，是最大的分叉源 |
| **`SecureFilePort`** | `0600 + chmod + tmp→rename` 模式 | **5 处各写一遍** |
| **`LifecyclePort`** | 信号注册 + `shutdown()` | `server/main.ts:115-116` |
| `OpenerPort`（预留） | 系统 opener | 当前**没有**（旧实现的 `open`/`start`/`xdg-open` 已随右栏方案删除），但 §9.4 一旦做配对图落盘就必须走端口 |

**不要抽**：`KernelPort` 与 `InteractionSink` 是宿主代际抽象，与 OS 无关。

---

## 7. 分阶段计划

> 每阶段的"判据"是该阶段**必须新长出来的闸门**。没有判据的改动在本项目不算完成。

### 阶段 A · 地基：平台抽象与三平台可跑

**为什么排第一**：后面每一阶段都要在三平台上验证。地基不做，改动一次就要返工一次。

| 步 | 内容 | 判据 |
|---|---|---|
| A1 | `PathsPort`：绝对路径判定、数据目录派生、工作区形状判定三件事收成一处；`config.ts` 三处 + `carrier-services.ts` 两处改调用它 | 表驱动判据：`/x`、`C:\x`、`\\host\share`、`~/x`、相对路径 × 三个平台各自的期望 |
| A2 | `SecureFilePort`：5 处收敛；win32 显式 warn + rename 重试 | 判据：posix 仍拿 `0o600`；win32 **必须留下一条 warn**（不许静默） |
| A3 | `LifecyclePort`：中继的优雅停机变成可显式调用 | 判据：win32 下调用停机出口 ⇒ 状态已落盘 + exit 0 |
| A4 | 脚本去 shell 化：`install-to-profile.mjs`、`relay-start.mjs`；`.mjs` 里的 `npm`/`pnpm` 走 `.cmd`；`e2e/run.mjs` 的构建串改 node 调用 | 三平台各跑一次安装 + 启动 |
| A5 | 测试装置平台化：`mode & 0o777` 断言、`chmod 0o500` 前置、`new URL().pathname` 4 处、写死的 `/Users/...` | 三平台 `pnpm test` 全绿（win32 的 skip 必须**显式**且带原因） |
| A6 | 四仓 CI 加 `windows-latest` + `macos-latest` 矩阵 | 矩阵首次全绿 |
| A7 | 防休眠：见 §8.4 | 三平台各自如实上报 |

**出口标准**：三平台上 `pnpm gates` 与 `node e2e/run.mjs` 全绿。

### 阶段 B · 协议 v3（L1）

| 步 | 内容 | 判据 |
|---|---|---|
| B1 | `cmd.session_history.since`（与 `beforeSeq` 互斥）+ `ev.session_history.latestSeq` | 三条（互斥 / 窗口外明确拒绝 / 补差量与拉历史逐字节一致） |
| B2 | `history_window_exceeded` 错误码 + 中文映射 + 可重试性表 | 判据：它**不在**可重试集合里；中文表里有它 |
| B3 | 能力位 `drc.payload.resume` | 老主机缺位时客户端**退回拉历史**（反向判据） |
| B4 | 宿主侧产 cursor、mp 侧记 cursor、重连带 `since` | e2e：断线 → 重连 → 只有差量到达（不是全量） |
| B5 | `SPEC.md` 补 §10.7（续传）与 §17 的登记 | 文档与 `describeCatalog()` 逐项一致 |

**关键纪律**：`since`/`ack`/cursor 全部是**会话层**概念，不许出现任何"因为是 WS 所以…"的设计。

### 阶段 C · 小程序 v3（L3）

| 步 | 内容 | 判据 |
|---|---|---|
| C1 | **token 层**：4px 网格、间距/圆角/字号档位；浅深双主题各一份；生成器 + 闸 | 扩展 `gen-mp-theme.mjs`：token 表是唯一来源；对比度闸从 304 组涨到覆盖全部新组合 |
| C2 | **组件层**：Toast、底部弹层壳（三档 + 把手）、骨架、空态、主按钮/危险按钮 | 每件一条结构判据（不许只断"渲染出节点"） |
| C3 | **聊天页重排**：助手通栏 / 用户右下气泡；工具四态 + 聚合；思考折叠；`scroll-to-bottom` + 流式环；"正在X"文案机 | 逐项；**每项配一条反向判据**（例如"折叠不许删落块逻辑"——那是既有纪律） |
| C4 | **composer 重做**：胶囊、左（语音不做则留位/模型只读/@）/右（＋/发送）、三态发送按钮、草稿、键盘处理 | 状态机表驱动判据（三态 × 有无内容 × 是否在跑） |
| C5 | **列表页**：设置入口；空态/加载态骨架；「等你处理」区沿用 v2 语义 | 反向判据：解配必须把**每一个**从主机读来的量归零（v2 已有一条，扩展它） |
| C6 | **设置页（新建）**：主题 / 自部署中继 / 连接诊断 / 关于 | 见阶段 E |

### 阶段 D · 中继 v3（L2）

| 步 | 内容 | 判据 |
|---|---|---|
| D1 | 三平台部署配方：Linux（systemd/容器，已有）/ macOS（launchd，已有但 `[未实测]`）/ **Windows（新）** | 每平台一条"装完能被 `/healthz` 看到"的实测记录 |
| D2 | 优雅停机的显式出口（与 A3 同一件事）+ Windows 服务停止可触发 | win32：服务停止 ⇒ 落盘 + exit 0 |
| D3 | 自建友好：`/healthz` 的一眼可读摘要 + 一条诊断命令 | 判据：诊断输出**不含任何凭据**（既有纪律） |
| D4 | 绑定与防火墙文档（`0.0.0.0` 在 Windows 会弹窗） | 文档 + 一条 warn |
| D5 | （低优先）可选传输面 —— 见 §9.2，**先只做协议中立性验证，不实现** | 判据：协议层没有 WS 专有概念（grep） |

### 阶段 E · 小程序自部署中继（需求 5b）

| 步 | 内容 | 判据 |
|---|---|---|
| E1 | 设置页加"中继地址"输入 + 校验 + 持久化 | 校验用 `isValidPairingServer` 的同一套规则（不许两套） |
| E2 | 地址与配对码的**优先级**说清：扫码来的 `s=` 覆盖手填？还是反过来？ | 必须有一条判据钉住，且**界面上要能解释这个优先级** |
| E3 | 清掉 v2 的死文案（`client.js:150` 那句指向不存在界面的"请先扫码或填写中继服务地址"） | 判据：文案里的每个入口都要真实存在 |
| E4 | **微信合规现实**（见 §10）写进文档与界面引导 | 文档 + 界面文案各一处 |

### 阶段 F · 插件 v3（L4）

| 步 | 内容 | 判据 |
|---|---|---|
| F1 | pill 面板与配对图换用同一套 token（把 token 从 mp 抽成**共享的** JSON/TS 常量） | 判据：插件侧渲染值与 mp 侧 token 表逐项一致 |
| F2 | 文案表统一（宿主侧中文与 mp 侧共用一份） | 判据：同一语义在两端的措辞逐字相同 |
| F3 | 承载 B 阶段的新协议（cursor 生产方） | 单测 + e2e 覆盖 |
| F4 | `status.json` 增诊断字段（自部署/传输/续传命中率） | 判据：每个新字段都有"谁读它"（既有纪律：改了账本没人看等于没改） |

### 阶段 G · 特性补齐（见 §9）

按 §9 的优先级取前 3–4 项做。

### 阶段 H · 收口

`pnpm gates` 刷 README 项数、四仓 CHANGELOG、HANDOFF 记账、版本号、发版。

---

## 8. 三个需求点的专门说明

### 8.1 需求 1：保留 v2 全部需求

做法是 §1 那张清单 + **一条机械判据**：v3 收口时逐条对照，任何一条缺失都算回归。
建议把它固化成 `e2e/v3-parity.test.mjs`——**读 §1 的表比读记忆可靠**。

### 8.2 需求 2/3/4：以小程序为切入点，驱动中继与插件

这三条是一条链，顺序不能反：

```
小程序改造（认知层）→ 协议长出需求（L1）→ 中继承载（L2）→ 插件生产（L4）
```

**为什么不能反**：v2 的历史反复证明——协议先改、客户端后跟，中间那段时间的
"两端版本不一致"是最难查的一类故障（HANDOFF §5-9 就是它）。

### 8.3 需求 5a：三平台

见阶段 A + §6 的完整清单。**最大的不确定性是 DSH 自己在 Windows 上的可用度**：
它是"部分可用"（`dsh-base/cordis.patch.yml` 有 5 处 win32 闸、
`dsh-cc-tui` 再加 2 处、还有 `dsh-win32-process` / `dsh-sandbox-windows-acl` 两个专门的包），
但**没有任何 sleep/power 助手**（全仓 grep `powerSaveBlocker` /
`SetThreadExecutionState` / `caffeinate` / `systemd-inhibit` 均 0 命中）。

### 8.4 防休眠在 Windows 上到底做不做

| 选项 | 代价 | 收益 |
|---|---|---|
| **如实报 unsupported**（v2 现状） | 0 | 少一个功能，但**诚实** |
| 实现 `SetThreadExecutionState` | 要写原生调用（koffi/ffi 或 powershell），而**项目至今零原生依赖** | 防休眠可用 |

**建议：先做"如实报 unsupported + 文档写清"**，把它列为 v3.1 的可选项。
理由：引入第一个原生依赖的代价（三平台编译、CI 矩阵、打包）远大于这个功能本身；
而 v2 已经建立了"缺能力必须显式上报"的纪律，`ev.keep_awake_state.reason` 就是它的出口。

---

## 9. 综合分析：v3 还值得做的（按价值排序）

> 这一节是"除了用户点名的五条，还有哪些值得做"。每条给**价值 / 成本 / 与承诺的冲突**。

### 9.1 ⭐ 审批的"本次会话内始终允许"（价值高 / 成本低）

WorkBuddy 的审批选项是 `allow | deny | allowAll | rejectAndExitPlan`，
而我们是"逐次批准"。`allowAll` 能显著减少打断次数——**直接服务 30 秒原则**
（"瞥一眼 → 决定一件事 → 走开"里，"每两分钟被叫一次"是最破坏它的东西）。

**必须说清的边界**：scope 是**本次会话内**（不是全局、不是永远）。要有 TTL 或
"会话结束即失效"。宿主侧的能力面要先确认（`approval/policy` 是否支持记住）。

### 9.2 ⭐ 传输面：**WS 换成 HTTP+SSE 可行，但不该换**（2026-10-08 深核）

**结论：技术上可行（WorkBuddy 在同一个运行时里生产跑着），但对我们不值得做。**
理由不是"WS 更好"——是因为**我们真正缺的那个东西不需要换传输就能拿到**，
而换传输要付的代价集中在**我们拓扑里最贵的那一侧**。

#### 9.2.1 决定性的是拓扑，不是协议

| | WorkBuddy | 我们 |
|---|---|---|
| 形状 | mp →（HTTP）→ **云端 agent 服务** | mp ←→ **relay** ←→ host |
| 发起方向 | 客户端发起、服务端流式回 ⇒ **SSE 天然贴合** | 双向长驻：host 是**长时生产者**，它的上行就是流式输出 |
| 上行频率 | 低（一条 prompt） | 手机侧低、**主机侧高**（50ms 级的 delta） |

- **手机侧**：POST 上行 + SSE 下行 —— 完美，没有争议。
- **主机侧**：要么每条帧一个 POST（`enc` 帧的频率 × 完整 HTTP 头开销），
  要么**用两条连接模拟全双工**（chunked POST 上行 + SSE 下行）。
  而"全双工"正是 WS 存在的理由。

⇒ 换传输的收益落在手机侧，代价落在主机侧与中继侧。

#### 9.2.2 反直觉的核实结果：**关闭码语义在我们这里根本没人消费**

这是最重要的一条。换传输最常见的反对理由是"会丢 WS 关闭码语义"，
而 `DESIGN.md` §2 的 T5 写着「客户端的重连策略依赖这些语义」。**逐行核实：那句话是假的。**

| 端 | 位置 | 实际行为 |
|---|---|---|
| 小程序 | `core/socket.js:214` | `t.onClose(() => { this._onClose() })` —— **关闭码被直接丢弃**，回调根本不接这个参数 |
| 小程序 | `core/client.js` | 全文无关闭码分支（只消费 `error` 帧的 `retryAfterMs`） |
| 宿主 | `transport/relay.ts:366-370` | `socket.on('close', (code) => { log('relay closed', {code}); scheduleReconnect(...) })` —— **只记日志，从不分支**，重连是无条件的 |

⇒ 「换传输会丢关闭码语义」这个理由**在我们当前实现里不成立**（它只是文档里的一句承诺）。

#### 9.2.3 中继的 WS 耦合面（实测计数）

比想象中浅——因为它**早就被抽象过**：

| 位置 | 命中 | 说明 |
|---|---|---|
| `state.ts` | **5 处** | 且有 `export interface Sock { readyState; send(data); close(code, reason) }` —— **只有 3 个成员**，状态机本身已经是传输无关的 |
| `server.ts`（1560 行） | 33 处 | `WebSocketServer/handleUpgrade` 5、`close(code)` 11、`bufferedAmount` 3、`ws.ping/on('pong')` 2、`terminate` 2、`maxPayload` 2、`readyState` 2 |

⇒ 真要做，工作量主要在**新写一个 `Sock` 适配器 + 重写 `server.ts` 的连接生命周期**，
而不是重写状态机。（这是既有分层的一个正面回报。）

#### 9.2.4 真正的 WS 硬依赖（这三条才是代价）

| # | 依赖 | 位置 | 换成 SSE 后 |
|---|---|---|---|
| 1 | **保活**（T4） | relay 的 WS 层 ping + 主机侧 `ws.ping`（`relay.ts` 探针） | SSE 只能靠**注释行**（`:` 开头）；中继要自己产，且**小程序侧收不到注释行**（`wx.request` 的 chunk 回调只给数据），所以还得用一条显式的 keepalive 事件 |
| 2 | **背压** | `server.ts` 3 处 `bufferedAmount`（慢消费者判定） | 要读 HTTP 响应流的写缓冲 —— API 不同，**可观测性更差**（没有标准字段） |
| 3 | **`maxPayload`** | `server.ts` 2 处（1 MiB 帧闸，T2） | HTTP 没有等价的库级上限，要自己在流解析层实现 |

#### 9.2.5 成本量化（如果真做）

| 仓 | 要动什么 | 量级 |
|---|---|---|
| `dsh-remote-protocol` | T1–T8 传输契约重签；`ping/pong` 语义改写；关闭码语义改写 | 冻结契约表重写，`e2e/protocol.test.mjs` 逐字节对拍要重做 |
| `dsh-remote-server` | 新 `Sock` 适配器 + POST/SSE 两个端点 + 连接生命周期 + 背压 + 帧上限 | `server.ts` 1560 行里的大半 |
| `dsh-remote-control`（host） | `relay.ts` 的 socket 层重写（含探针、退避、幂等重放） | 中等 |
| `dsh-remote-mp` | `socket.js` 重写（chunk 缓冲 + 自己切 SSE 行 + 重连） | 小（但**引入一类新 bug**：chunk 边界不对齐 SSE 行，必须自己累积切分） |
| 部署 | nginx 要 `proxy_buffering off`；绑定的白名单从 socket 换成 request | 小 |

#### 9.2.6 建议

**v3 不换传输，但把它的两个好处分别用更便宜的方式拿到：**

1. **offset 续传**（§5.1）—— 这是最值钱的那部分，而它**本来就是会话层概念**，
   在 WS 上照做。**不需要换传输。**
2. **企业代理友好** —— 真需要时，在 relay **边缘加一个 HTTP 适配器**
   （`POST /uplink` + `GET /stream?since=N`），内部桥到同一条逻辑会话。
   这是**中继侧的一个适配层，不是协议变更**，主机侧一行都不用动。

**触发条件**（满足任一再启动这件事）：
- 有真实用户报告"WS 被企业网络/代理掐掉，且改不了"；
- 或者要接一个**只能出 HTTP 不能出 WS** 的客户端形态（例如某种机器人/CLI 嵌入）。

**顺手要修的文档 bug**：`DESIGN.md` §2 的 **T5 描述与实现不符**（见 9.2.2）。
它现在声称"客户端的重连策略依赖这些语义"，而两端都不消费。
要么改文档，要么补实现——**但现状是一句会被下一个人当真的假话**。

#### 9.2.7 小程序侧如果哪天真做，三条要实测的

1. **`wx.request` chunked 流的最大存活时长** —— 未实测。WorkBuddy 有 60s 心跳 +
   重连，暗示它**不假设流永久**。这条必须先量。
2. **chunk 边界不对齐 SSE 行** —— 必须自己累积缓冲、按 `\n\n` 切
   （WorkBuddy 的实现就是 `t.data = (t.data || "") + s`）。
3. **换传输不解决微信白名单** —— 从"socket 合法域名"变成"request 合法域名"，
   备案与证书要求一字不变（见 §10.3）。

### 9.3 ⚠️ 语音与 TTS：**与承诺一冲突，先不做**

它们的入口是 `wx.getRecorderManager` + 云 ASR，播报要云 TTS——**正文会离开设备**。
零知识是我们的第一条承诺，不是可选优化。

**唯一可能的口子**：宿主侧本地 TTS（如果 DSH 有），音频走既有的 `enc` 通道回手机。
**先验证 DSH 有没有本地 TTS**；没有就不做。

### 9.4 ⭐ 产物只读预览（价值中 / 成本中）

WorkBuddy 有 code / diff / md / csv / media 五种 viewer + artifact 面板。
我们只有 `ev.tool_event` 的 `resultPreview` 文本。

**值得做的部分**：**diff 与文本**（"它改了什么"正是那 30 秒里最想看的）。
**不做的部分**：编辑、下载、上传。

⚠️ **与 30 秒原则的边界要说清**：只读预览是"看一眼"；一旦能改，就变成"在工作"。

### 9.5 ⭐ 消息重试 / 编辑（价值中高 / 成本中）

WorkBuddy 有 `编辑消息` / `重试`。场景很真：手机上说错一句话。
**成本在宿主侧**（要能撤销/重放一轮），协议侧只是加两条 cmd。

### 9.6 中继的"零知识可自证"（价值中 / 成本中，**差异化强**）

我们的核心卖点是零知识，但**用户自己很难验证**。
可以考虑：中继在 `/healthz` 与一条命令里自证"本进程从未 import 密码学模块、
从未解析载荷"（构建期断言 + 运行时字节计数）。

这与 `tests/bundle.test.mjs` 现有的"产物里没有 xsalsa20 痕迹"是同一条思路的延伸，
**而且 WorkBuddy 结构上做不到这件事**（它必须解析载荷）。

### 9.7 多受控端 / 多实例（价值中 / 成本中）

`EXPANSION-PLAN.md` P0–P2 已有完整调研（实例隔离、web profile、tui profile）。
v3 可以做 P0（实例隔离），因为它是"一个用户有两台机器"的前提。

### 9.8 冷启动与首屏（价值中 / 成本低）

WorkBuddy 用 `preloadRule` 预载分包。我们只有 2 页，但 v3 加设置页/弹层后
要注意首屏时间。**判据**：首屏可交互时间 + 骨架屏覆盖率。

### 9.9 国际化（价值低 / 成本低，可推迟）

WorkBuddy 有 66 条 `["中文","English"]`。我们的用户是自己。**暂不做**，
但 token 层与文案表的形状要**允许**将来加。

### 9.10 诊断包一键导出（价值中 / 成本低）

自建用户的排错需求。导出一份**不含凭据与正文**的诊断（`status.json` 摘要 +
最近日志 + 版本矩阵）。与既有纪律一致（"诊断面是产品面"）。

### 9.11 会话置顶（价值低 / 成本低）

WorkBuddy 有 pinned。我们禁删除但置顶不冲突。**低优先**。

### 9.12 元老级问题：协议 v2 消息棘轮（前向保密）

v2 记录为"刻意不做"（`drc.crypto.v2` 能力位已经预留在注册表里）。
v3 **仍建议不做**：收益是"密钥泄露后看不到历史"，成本是整条链路的
nonce/派生全部重做 + 小程序端没有 CSPRNG（这是 v2 用计数器 nonce 的根因）。
要做也是一整个大版本，不是 v3 的配菜。

---

## 10. 自部署中继的现实约束（**必读，否则计划会落空**）

这一节是 v3 最容易"想当然"的地方，先把硬约束摆出来。

### 10.1 服务端已经可配

27 个 `DRC_*` 环境变量（`dsh-remote-server/src/config.ts:153-249` 全部读在一处），
无配置文件、无 CLI 参数。Dockerfile / Caddy / launchd 配方在
`docs/SELF-HOSTING.md` 里都有，但**全部标着 `[未实测]`**。

### 10.2 小程序侧**没有入口**（这是真正要修的）

中继地址**只能从配对二维码来**。逐行核实过（2026-10-08）：

| 证据 | 位置 | 说明 |
|---|---|---|
| URI 解析 | `miniprogram/core/codec.js:187,203-223` | `dshr:/p?v=1&s=<ws url>&n=…&psk=…[&t=…]`，`s=` 就是中继地址 |
| `data.server` 的**唯一写入点** | `pages/sessions/sessions.js:685`（`_applyParsed`） | 而 `_applyParsed` 只被扫码路径调用 |
| 校验**存在且正确** | `sessions.js:712-716` | `/^wss?:\/\//` 不通过就 toast |
| 使用点 | `sessions.js:727` | `client.connect({server, psk, token})` |
| **wxml 里 `server` 出现 0 次** | `pages/sessions/sessions.wxml` | 全页只绑了两个输入：`pasteText`、`token` |

⇒ **一条完整的"手填中继地址"代码链已经在，唯一缺的是那个输入框。**
这让阶段 E 的成本从"设计+实现"降到"补一个输入 + 定优先级 + 清死文案"。

另有一句死文案：`core/client.js:176` 的 `needs-pair` 文案写着
「请先扫码或填写中继服务地址」——而界面上**没有"填写"这条路**。

### 10.3 微信侧四道闸（**体验版/正式版无法绕过**）

1. `appid` 必须已注册
2. **socket 合法域名**白名单（HTTP 传输则是 request 合法域名）
3. 域名**已备案**
4. **有效证书**（`wss://`）

⇒ **自建中继必须部署在已备案域名上，并在微信后台加入白名单。**
⇒ 换传输（WS→SSE）**不解决**这个问题（只是从 socket 白名单换成 request 白名单）。

### 10.4 因此"自部署"的诚实定位

| 场景 | 可行性 |
|---|---|
| 开发者工具 / 真机调试 | ✅ 不受白名单限制（勾"不校验合法域名"） |
| 体验版 | ⚠️ 需要该域名在白名单里（体验成员也一样） |
| 正式版 | ⚠️ 同上，且要备案 |

**结论：v3 的"自部署中继"是一个"给会自建的人"的功能，不是"人人可自部署"。**
界面与文档都必须**如实说明这一点**，不能只给一个输入框就完事——
否则用户填了地址、连不上，会以为是我们的 bug。

### 10.5 建议的界面口径

设置页那一项不叫"服务器地址"，叫「**自建中继（高级）**」，并附一段说明：
域名需备案并在微信后台加入白名单；附一条"怎么验证我的中继是通的"（curl `/healthz`）。

---

## 11. 明确不做（v3 版，写下来为了不用重吵）

| 不做 | 理由 |
|---|---|
| 多设备/多用户/账号体系、跨设备会话同步 | 承诺二 |
| 任何需要服务端理解载荷的功能：搜索历史、云端摘要、推送带正文 | 承诺一 |
| 文件浏览器、远程终端、IDE 式多面板 | 30 秒原则 |
| 原生 iOS/Android 客户端 | 承诺三 |
| **删除会话** | 不可逆；归档已覆盖收益（`PRODUCT.md` §4） |
| **云 ASR / 云 TTS** | 正文离开设备 ⇒ 承诺一 |
| **会话分享 / 云分享** | 同上 |
| **专家中心 / 技能广场 / 连接器市场 / 资料库 / 团队 / 积分** | 那是"工作台"，不是那 30 秒；且需账号 |
| **消息棘轮（前向保密）** | 成本是整个大版本，见 §9.12 |
| **第二传输面的实现** | 先只守协议中立性，见 §9.2 |
| **模型切换** | 宿主这一代只读 |
| 防休眠的 Windows 后端（**v3 内**） | 见 §8.4，留 v3.1 |

---

## 12. 风险与未决问题

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| R1 | **WorkBuddy 的 WXML/WXSS 结构不可读**（Skyline 二进制） | 我们只能抄到类名 + 可读的 WXSS 片段（来自 `webview.app.js`），**像素级细节拿不到** | 已取证的部分足够定"设计语言"；具体数值我们自己定并固化成 token |
| R2 | **DSH 在 Windows 上的可用度未实测** | 三平台里的 Windows 可能是"半可用" | 阶段 A 先在三平台跑通**我们自己的**闸门；DSH 本身的缺口列为已知边界 |
| R3 | **微信白名单**（§10.3） | 自部署功能对普通用户不可达 | 界面与文档如实说明（§10.5） |
| R4 | **协议加性变更的累积** | v2 已经 16 帧 / 25 载荷；再加会稀释"注册表"的可读性 | 每次加都要进注册表 + `describeCatalog()` + README 计数（既有机制） |
| R5 | **桌面端 UI 看不到 WorkBuddy 的实现** | L4（插件设计语言统一）只能"风格对齐"，不能"像素对齐" | 把 token 抽成共享常量，用判据守住"两端用同一份" |
| R6 | 阶段 A 动了 `config.ts` / `carrier-services.ts` 的核心路径 | 回归风险 | `PathsPort` 用**表驱动判据**，且旧行为要有"逐字不变"的对照 |
| R7 | 三平台 CI 会显著拉长反馈时间 | 迭代变慢 | 只在 push/tag 跑矩阵，PR 上跑 ubuntu |

**未决问题（需要拍板）**：

1. **自建中继地址与扫码地址的优先级**（§7 阶段 E2）——扫码覆盖手填，还是反过来？
   建议：**扫码覆盖**（扫码是"我现在要用这一台"的明确意图），但要在界面上说明。
2. **cursor 的保留窗口多长**（§5.1）——太长要占内存，太短则补不上。
   建议：与既有 `IDEMPOTENCY_WINDOW_MS`（5 分钟）解耦，单独定，先取"每会话最后 N 条"。
3. **§9.1 的 `allowAll` scope**——会话内？还是"这一类工具在本会话内"？后者更安全但更复杂。
4. **要不要在 v3 就把 token 抽成四仓共享的包**（新增一个 npm 包？还是塞进 `dsh-remote-wire`？）
   建议：先塞进 `dsh-remote-wire`（它已经是四仓唯一的共享面），别急着开第五个仓。

---

## 13. 判据与闸门映射（v3 要新增的闸门）

| 阶段 | 新增闸门 | 落在哪 |
|---|---|---|
| A | 路径判定表驱动判据；`SecureFilePort` 的 win32 warn 判据；停机出口判据；三平台 CI 矩阵 | 四仓 + 伞仓 |
| B | `since`/`beforeSeq` 互斥；窗口外明确拒绝；补差量与拉历史逐字节一致；协议中立性（无 WS 专有概念） | protocol |
| C | token 表为唯一来源；对比度闸覆盖全部新组合；聊天页逐项 + 反向判据；composer 状态机表 | mp |
| D | 三平台部署各一条实测；`/healthz` 摘要不含凭据 | server |
| E | 地址校验与配对码同源；死文案清零 | mp |
| F | 两端 token 逐项一致；两端文案逐字一致 | control |
| H | `v3-parity`（§1 清单逐条对照）；`pnpm gates` 刷新 | 伞仓 |

---

## 14. 相关文档

- 承诺与取舍：[`PRODUCT.md`](PRODUCT.md)
- 既有扩展调研（多 profile / 三平台 / 自建）：[`EXPANSION-PLAN.md`](EXPANSION-PLAN.md)
- 冻结契约三张表：[`DESIGN.md`](DESIGN.md) §2
- 宿主配置与排障：[`HOST-SIDE.md`](HOST-SIDE.md)
- 小程序结构：[`MINI-PROGRAM.md`](MINI-PROGRAM.md)
- 威胁模型：[`SECURITY.md`](SECURITY.md)
- 排错第一入口：[`../HANDOFF.md`](../HANDOFF.md)

---

## 附录 A · WorkBuddy 设计 token 全表（反编译实测）

> 从 `/Users/linbin/wbu-extract/**/*.js` 里以 `var(--token, fallback)` 的形式抽得，
> **57 个 `--wb-*`**。`rpx` 值来自编译产物的数字字面量（`[0,N],` = `N rpx`），
> 换算基准 **428px 画布**（`750 / 428 = 1.7517`）。
>
> ⚠️ 它**没有**语义定义块——这些 token 只以带 fallback 的引用形式出现在各处。
> 下表是我们给它补的定义。

### A.1 颜色

| token | 值 | 换算/说明 |
|---|---|---|
| `--wb-color-text-brand` / `--wb-color-icon-brand` | `#00a885` | 品牌绿（**只用于文字与图标**） |
| `--wb-color-success` | `#00c29a` | |
| `--wb-color-btn-primary` | `#000000e6` | ⚠️ **主按钮是黑，不是绿** —— 一个刻意的取舍 |
| `--wb-color-btn-primary-pressed` / `-disabled` | `#000c` / `#0003` | |
| `--wb-color-text-primary` | `#000000e6` | = `rgba(0,0,0,.9)` |
| `--wb-color-text-secondary` / `-tertiary` / `-disabled` | `#0009` / `#0006` / `#0003` | |
| `--wb-color-text-inverse` | `#fff` | |
| `--wb-color-text-error` / `--wb-color-icon-error` / `--wb-color-border-error` | `#d13f3f` | |
| `--wb-color-warning` / `-light` | `#ff8c19` / `#fff4e5` | |
| `--wb-color-error-light` | `#fcecea` | |
| `--wb-color-bg-page` | `#f8f8f8` | |
| `--wb-color-bg-surface` / `-hover` / `-container` | `#fff` / `#f2f2f2` / `#fff` | |
| `--wb-color-bg-secondary` / `-tertiary` | `#f0f0f0` / `#ebebeb` | |
| `--wb-color-bg-mask` | `#0000004d` | = `rgba(0,0,0,.3)` |
| `--wb-color-bg-toast` | `#000c` | |
| `--wb-color-bg-switch` | `#fff` | |
| `--wb-color-border-default` | `#00000021` | |
| `--wb-color-border-light` / `-secondary` / `-white` | `#ebebeb` / `#0000000f` / `#fff` | |
| `--wb-color-icon-primary` / `-secondary` / `-tertiary` / `-disabled` / `-inverse` | `#000000e6` / `#0009` / `#0006` / `#0003` / `#fff` | |

### A.2 间距（4px 网格）

| token | rpx | px |
|---|---|---|
| `--wb-spacing-2xs` / `--wb-spacing-xxs` | 7.01 | **4** |
| `--wb-spacing-xs` | 14.02 | **8** |
| `--wb-spacing-sm` | 21.03 | **12** |
| `--wb-spacing-md` | 28.04 | **16** |
| `--wb-spacing-lg` | 35.05 | **20** |
| `--wb-spacing-xl` | 42.06 | **24** |
| `--wb-spacing-2xl` | 56.07 | **32** |

⚠️ 注意 `2xs` 与 `xxs` **同值**（4px）——是重复定义，不必抄这个冗余。

### A.3 圆角

| token | rpx | px |
|---|---|---|
| `--wb-radius-xs` | 7.01 | **4** |
| `--wb-radius-sm` | 14.02 | **8** |
| `--wb-radius-md` | 21.03 | **12** |
| `--wb-radius-lg` | 28.04 | **16** |
| `--wb-radius-2xl` | 42.06 | **24** |
| `--wb-radius-full` | 17521.61 | 10000（胶囊） |

### A.4 字号

| token | rpx | px |
|---|---|---|
| `--wb-font-ui-p3` | 22.78 | **13** |
| `--wb-font-ui-p2` | 24.53 | **14** |
| `--wb-font-ui-h2` | 29.79 | **17** |

（只有三档出现在产物里；聊天正文字号另见 `input-card__textarea{font-size:32rpx}`。）

### A.5 阴影

| token | 值（px 换算后） |
|---|---|
| `--wb-shadow-xs` | `0 4px 16px #00000008` |
| `--wb-shadow-input` | `0 4px 30px #00000014` |
| `--wb-shadow-md` | `0 8px 24px #0f172a0a` |

### A.6 旧 token（`app-wxss.js` 的 `body{}`，唯一一处有语义定义块）

`--color-primary:#10a37f` `-dark:#0d8a6c` `-light:#10a37f1a`；
`--color-bg-primary:#fff` `-secondary:#f7f7f8` `-tertiary:#ececec` `-page:#f7f8fa` `-hover:#f5f5f5`；
`--color-text-primary:#1a1a1a` `-secondary:#6b6b6b` `-tertiary:#999` `-muted:#b4b4b4` `-on-primary:#fff`；
`--color-border:#e5e5e5` `-light:#f0f0f0`；`--color-success:#10a37f` `--color-warning:#f5a623`
`-light:#fff4e5` `-pressed:#e67417`；`--color-error:#ef4444` `-bg:#ef444414`；`--color-info:#1677ff`
`-bg:#e6f4ff`；`--color-user-message-link:#4ecba0`；
代码块 `--color-bg-code:#1e1e1e` `-header:#2d2d2d` `--color-code-text:#d4d4d4` `--color-code-lang:#888`；
`--radius-*` 8/12/16/24、`--spacing-*` 8/12/16/24/32、`--font-size-*` 22/26/28/32/36（rpx）。

### A.7 给 v3 的建议

1. **只抄 `--wb-*` 那一套**（它是新体系，粒度更细、命名更自洽）；旧 token 略过。
2. **改成我们自己的前缀**（`--drc-*`），并在生成器里同时产出浅/深两套——
   这是 WorkBuddy **没有**、而我们**已经有**的能力（`gen-mp-theme.mjs` 的扩展点）。
3. **保留它的一条纪律**：主按钮用黑/深色，品牌绿只用于文字与图标。
   我们在 v2 是 TDesign 蓝，v3 换成这套需要一次视觉评审。
4. **`--wb-spacing-2xs` / `--wb-spacing-xxs` 的重复**是它的瑕疵，别一起抄。

---

## 附录 B · 本次取证的复现方式

> **解包产物留在 `/Users/linbin/wbu-extract/`**（205 个文件，11MB）——它是本次
> UI/协议分析的直接依据，**不要删**。原始 wxapkg 在
> `/Users/linbin/Downloads/plan/wx907c65e5e107ddcf/decoded/`。
>
> ⚠️ 用户最初指的 `decoded/_webcrack/` 目录是**空的**；`decoded/` 下的
> `dynamic-*/**/*.wxml` 全是**占位符**（内容只有一行注释）。真正的代码在
> wxapkg 里，需要按下面的格式自己解。


```sh
# 1) 反编译产物解包（wxapkg → 明文文件）
#    索引格式：0xBE | info1(4) | indexLen(4) | bodyLen(4) | 0xED | fileCount(4) | 索引 | 数据
#    ⚠️ 索引里的文件名可能带前导 / —— os.path.join 会因此跳到根目录，必须 lstrip('/')
python3 -c "..."        # 见本文件作者留下的 /tmp 脚本；核心是上行的偏移表

# 2) 设计 token 抽取
grep -ohE -- '--wb-[a-zA-Z0-9-]+' ~/wbu-extract/**/*.js 2>/dev/null | sort -u

# 3) 读 app-config.json（**开头被截断**，且尾部黏连了 WXMLRT 运行时代码）
#    先按 '}{' 切分再逐段 json.loads，或直接正则抽字段

# 4) 跨平台审计
grep -rn "startsWith('/')\|process.platform\|SIGTERM\|chmodSync\|path.posix" \
  /Users/linbin/dsh-remote-control/dsh-remote-{protocol,server,control,mp}/src \
  /Users/linbin/dsh-remote-control/dsh-remote-control/packages/plugin/src
```

### 附录 C · WorkBuddy 参考里**不可读**的部分（如实记录）

| 目标 | 结论 | 试过的路径 |
|---|---|---|
| WXML 结构树 | **不可读**（Skyline 编译进二进制） | 搜 `$gwx` / `__wxAppCode__` / `pages/*.wxml` 全 0 命中；`.fpcssb` 是二进制 |
| `AttachmentPanel`（＋菜单本体） | **不可读**，模块号 72159 不在产物内 | 全树搜模块号与该模块的所有回调名 |
| 桌面端（Electron/Web）的界面实现 | **不在本次素材里**（只有小程序） | — |
| 深色模式 | **确认不存在**（不是不可读） | 4 个关键词全树 0 命中 |
| 精确像素（部分） | 二进制数值区不可读，但 `webview.app.js` / `page-frame.js` 含**完整可读 WXSS 文本**（`[1],`=类名、`[0,N],`=rpx）——附录 A 的数据来自这里 | 正则解析 `__COMMON_STYLESHEETS__` |
