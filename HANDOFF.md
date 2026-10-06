| dsh-remote-protocol/（包名 dsh-remote-wire） | 1.8.1 | 已发 npm（1.8.1 加 ev.retry / ev.compaction） |
| dsh-remote-control/（单包） | 2.0.11 | 已发 npm 的是 2.0.10；**2.0.11 只装进了 Harness、未发版**，见 §4 |
| dsh-remote-server/ | 1.0.6 | 已部署 2026-10-06 10:30（/healthz 1.0.6, persistence:on, stateRestored:1）；不发 npm（包名被第三方占）；**§1.1 已完成**，见下 |
| dsh-remote-mp/ | 1.1.24 | 开发版本已上传，待「选为体验版」 |

三条不许再错：

1. 仓名 ≠ 包名：仓库 dsh-remote-protocol，npm 包 dsh-remote-wire。
2. 协议是 npm 依赖（^1.8.0），不是 git/file 依赖。
3. 判据是版本号 + 文案，不是字节哈希：esbuild 内嵌模块路径标签，同源码换次构建哈希就变。
4. **图片不进 uploads.ts**：图片走宿主原生的 {type:image,data,mimeType} 内容块，
   正文不出现路径（2026-10-05 用户要求）。落盘 + 路径那套**只留给文件**——
   宿主没有文件的内联块，Agent 要读它就得有个路径。

线上真相：中继 wss://drc.provid.cc；本机 hostId=drc-748e9a9ce167（落盘 host-id，0600）；status.json 按定时器刷，读它要轮询、要带基线。

闸门（干净工作树）：wire 92/92、server 101/101（102 条里 1 条 skip 是原有的）、control 372/372、伞仓 194/194、mp 32/32 + 对比度全过；四个仓 format:check 全绿。

## 0. 本轮做完的（2026-10-06 §1.1）

中继会话表落盘，**已上线 1.0.6**。`DRC_STATE_FILE=/var/lib/dsh-remote-control/state.json`，
线上 `/healthz` 现在多五个字段：`persistence` / `stateRestored` / `stateSavedAtSec` /
`stateWrites` / `stateWriteFailures`。

验收五条全部成立，其中第 1 条**在生产验过**：改完 1.0.6 自己写出的状态文件后直接重启，
`conversations` 从 1 读回 1，主机 0.8 秒回来，全程没人重扫。
⇒ **§1.2 的前置解除了**，那条现在才验得动。

线上那次切换**没有让你重扫**，是这么做到的：中继自己的 journal 里 `paired` 那行同时记着
sessionId 与 clientId（`journalctl -u dsh-remote-control | grep '"msg":"paired"'`），
拿它和主机 pair store 里的 convId 交叉核对一致，再手工播了一份状态文件。
**只播 id，不播 PSK**——中继从来不持有它。往后不需要再手工播了。

### 0.1 上线时踩到并已修的坑：ProtectSystem=strict

第一次上 1.0.6，状态文件**每 5 秒写失败一次**（EROFS），但 `/healthz` 的 conversations
是对的、配对看着完全正常——只是永远不落盘。`systemctl status` 看不出来，
ssh 进去 `touch` 又成功，因为那是另一个 mount namespace。

根因：单元里 `ProtectSystem=strict` 把整个文件系统挂成只读，只留
`ReadWritePaths=/opt/dsh-remote-control`，所以 `/var/lib` 写不进去。
修法是加 `StateDirectory=dsh-remote-control`（systemd 在 strict 下把**这一个**路径放回
可写，**不用**放松 ProtectSystem）。刻意没用 `ReadWritePaths=/var/lib`——那要放开整个 /var/lib。

**判据是 `stateWriteFailures` 这个字段**，它本来就为这种"功能看着正常、其实没落盘"
的故障加的，这次正好派上用场。换台机器部署记得先看这一项，它不是 0 就是没在写。

## 0.2 工作树会被外部进程清掉

本轮开工时 `src/persist.ts` 是一份**未提交**的半成品，`state.ts` 也带一处未提交修改。
09:40 左右两者一起消失、工作树变干净：git reflog 里没有任何 revert 记录，
`.git/index` 的 mtime 与之同时更新，机器上跑着 VS Code + Copilot。
**没查出来源**，但结论明确：半成品放在未提交状态是会丢的。

下一次改代码，改完就 commit，别攒着。
（那半成品的内容已按上下文重建并补全，`state.ts` 的未提交修改则改由 `persist.ts` 承担，
现在 `state.ts` 与 HEAD 一致。）

## 0.3 五个 mp/host bug 已修（2026-10-06 晚，全部先红后绿）

六个并行深挖的结论 + 修复。**四个用户可见问题里有三个是同一个盲区的产物**：
判据一律在造帧，从不断言主机此刻到底发不发，于是修完也"测试通过"。

| # | 问题 | 根因 | 修在哪 |
|---|---|---|---|
| 1 | 当前模型不见了 | commit **9511904**（修提问弹窗的那个）重构 `broadcastModel` 时把 `pushSessions()` 里的 call site **删掉而不是适配**。模型只剩 `request/header` 一个源，而它**每轮一条**，空闲会话永不发 | host：`modelBySession` 缓存 + 随列表补发 |
| 2 | 待办不显示 | `isHistoryWorthy` 只放行 delta/tool，`todo` **在进历史页之前**就被丢掉 → `historyWireItem` 的 todo 分支是**死代码** | host：放行 + 一页塌缩成最后一份；mp：`_todoLive` 不许被形状不对的帧锁死 |
| 3 | 重连后停更 | 2026-10-05 那次"修复"**只复位、不触发**，整段是空操作：`_maybeLoadHistory()` 在 `_historyStarted` 还是 true 时就 return 了，之后复位了却没人再调用 | mp：复位后显式再触发一次 |
| 4 | FAB 移到中间 | restyle `4656d70` 把 `bottom` 从 210rpx 改成 176rpx，而输入区高 `122rpx + env(safe-area-inset-bottom)` → iPhone 沉 13rpx、Android 48dp 手势条沉 41rpx，正好压在输入框上。**根因是锚在 `.chat-wrap`（height:100%）而不是视口** | mp：`position: fixed` + `bottom: 46%` |
| 5 | 提问不弹 | 用户确认：**整段 5 分 18 秒什么都没有**，不是闪一下被撤卡。帧确实出去了（`question_request_no_peer` 不存在=主机认为手机在线）。放大器之一是会话过滤把别的会话的提问**无声吞掉** | mp：不静默，给提示。**主机侧重放（治本）还没做** |

### 三条最值得记住的

1. **一个 commit 修了 A、弄坏了 B。** 9511904 是去修提问弹窗的，顺手弄坏了模型显示。
   提交说明里一个字没提。**改签名时必须检查每一个 call site**，而不只是自己那处。
2. **判据假通过比没有判据更糟。** 问题 3 那条 e2e 是绿的，但它证明不了任何事：
   `stubClient` 把 `status:'online'` 写死且从不随帧变，于是断链那一帧
   **替重连那一帧**把断言喂饱了。补了真实路径的判据之后它才红。
3. **证据通道本身会骗人。** `MAPPED_SESSION_EVENTS` **只驱动 status.json 的记账、
   不驱动 HostRuntime 的 switch**——`agent/inbox/spliced` 登记在里面，而 switch 里
   没有 `case 'inbox'`，于是主机侧排队的消息手机完全看不到，而 status.json 报"一切正常"。
   同理 `eventTypes` 的 `.slice(-24)` 让它与 `unmappedEventTypes` **对不上账**（同一个 Set 喂的）。

### 新增的判据（这一轮的主要产出）

- **穷举自检**：`MAPPED_SESSION_EVENTS` 每一种都灌进真实 `HostRuntime`，断言都有出站面。
  `INTENTIONAL_DROPS` 登记"按设计只记账不翻译"的（approval/asked、approval/decided）。
  且断言映射表新增条目必须同时补样本，否则判据会悄悄不再覆盖它。
- `stubClient.status` 改为跟随状态帧（`feedStatus()`），7 处手写注入全部换掉。
- 真实日志 fixture 补 `todo/write`（此前**出现 0 次**）。
- `runtime.test.ts` 里 model 此前**出现 0 次**，现补 3 条。
- FAB 加了**像素/结构**判据（此前末尾三条一条都没量位置）。

### 还没做的（别当已完成）

- **主机侧重放挂着的提问**：手机退后台/断线期间挂着的提问，回来后永远收不到；
  300s 超时后还会被 `voidStaleCard` 主动擦掉。治本要改 `peer-joined` 后的补发，风险中偏高。
- **inbox 的完整接线**：协议加载荷（wire 发版）+ mp 加处理器 + 改回映射表。现在只做了
  「让证据说真话」。
- **FAB 是否真的"跑到屏幕正中间"**：`fixed` + 46% 解决的是"沉进输入区"（已实测确认）。
  字面意义的"屏幕正中间"在静态与模拟器都复现不出来——需要一张真机截图才能定。



### 1.1 ~~中继落盘会话表~~ ✅ 2026-10-06 完成并上线（1.0.6）

细节见 §0。三条判断值得留着，它们是踩过才知道的：

- **`hostOfflineSince` 刻意不落、也不恢复**。读盘那一刻没有任何主机连着，照搬盘上的计时
  等于宣称"主机从上次落盘起就已离线"，于是宽限期从进程启动那刻开始判死——一次 130 秒的
  停机维护就能让会话当场判死、手机照样重扫，**比不做落盘更糟**。恢复出来的会话一律按
  "主机在场、只是还没连上"处理。判据里有配一条反向的：真掉过线的主机照样会被判死。
- **恢复放在 `createRelay`（listen 之前）**。放 listen 之后有真实竞态：主机在读盘完成前
  连上来发 `resync`，那轮 resync 按"服务器现有的表"去删，把主机刚声明的会话全删掉。
- **回收必须同步删盘**。只在"建"的时候写的话，已回收的会话永远留在盘上、重启被复活。

变异验证做了三个，都作用在被测的那段逻辑上、都能编译：
去掉 restore → 验收 1/2/2b 红；去掉删除路径的落盘 → 只有验收 5 红；
把 `hostOfflineSince` 加回类型+快照+恢复 → 只有那条判据红。

（第一次试第三个变异时 `pnpm build` 失败了，判据却全绿——测的是上一个产物。
就是 HANDOFF §2 那条"变异要能编译"的教训，又踩了一次。）

### 1.2 unpair 修复的真机复验（部署已完成，**验收还没做**）

1.0.5 已上线，`unpaired` 标记现在真的在发。但下面两条只在**真机 + 真人点**下才验得了，
e2e 只覆盖了中继发标记那一半：

- mp 解除配对 → dsh 的 pill 从「手机离线」变「**未配对**」
- 手机切后台再回来 → **不许**要求重新扫码

⚠️ 第二条的阻塞**已解除**（§0：落盘上线并在线上验过重启不丢配对）。
现在可以真机验了——验之前先扫一次码把手机配上。

### 1.3 mp 1.1.24 选为体验版 + 真机复验

1.1.24 已上传为开发版本，还需要在公众平台「版本管理 → 开发版本 → 选为体验版」。
本轮 mp 侧四个改动都还没上过真机：待办条（去掉蓝条、修三角闪烁）、默认收起、
断链重连补历史、图片不再带路径。e2e 只验逻辑层，排版与时序得真机才知道。

### 1.4 自动滚动 + FAB（2026-10-06 已完成）

滚动改成**默认永远跟底**：onScroll 里叠的三个判据（负 delta 就停 / 点完 600ms 内豁免 /
24px 容差）互相抵消，位置判据现在排在 deltaY 之前，回弹守卫只覆盖我们自己触发的滚动。
FAB 72rpx → 56rpx、贴右边缘、品牌色实心圆改成中性面 + 细边 + 次级色箭头。
判据在 e2e/mp-chat-blocks.test.mjs 末尾三条（跟着 / 中间帧 / 窗口外照停）。

### 1.5 mp steps 的中文对齐（未做）

宿主那张三态词表已经从 app.asar 里挖出来了（`message.stepProcess.*`：
进行中/准备/已完成 × read/write/search/edit/commands/code/webSearch/webFetch/subagents/plan/questions/tools）。
**缺的是「工具名 → 类别」的映射函数**，搜遍 asar 与磁盘都没找到——它要么在运行时资源里，
要么是按子串动态判定的。mp 现在那行显示的是 `{{it.tool}}` 原样英文（`Bash`），
而宿主显示中文类别，所以对齐后 mp 那一行的语义也会跟着变。
不要凭猜测硬写映射表：猜错的表现是显示错的类别，比不翻译更糟。

### 1.6 mp 侧显示重试与压缩（下一步，不用等重启）

主机侧已经做完并等重启生效：wire 1.8.1 发了 `ev.retry` / `ev.compaction`，control 2.0.11
做了映射与广播，两条都过了判据与循环验证。

**但 mp 的 chat.js 里还没有这两个的处理器**，所以界面上什么都不会出现。剩下的就是这一层：

- `_onEvent` 加两个分支，按 sessionId 过滤（与其它事件同一条）
- 顶栏那行加一句瞬时提示，与现有运行态提示放一起：
  「正在重试 2/5 · TRANSPORT」/「正在压缩上下文」/「压缩没成功：<error>」
- **failed 与 ended 不许合并**（上下文已经烂掉而用户以为正常，比看不见更糟）
- 提示要有清除时机：run-state 回到 idle 时清掉，否则会一直挂着

判据放 e2e/mp-chat-blocks.test.mjs，并且要做循环验证。

## 2. 环境坑（还有效的）

- 所有 pnpm/node 命令带 env -u NODE_OPTIONS（子 shell 注入的 loader 会搞挂 ESM 解析）。
- 装/查/打包走 Node 22（pnpm 11 要 22.13+）；pnpm/action-setup 不写 version；本家包在 minimumReleaseAgeExclude 写裸名。
- node --test 统一 find 加 xargs，先断言文件数非零；跑的是 dist，先 build（build 先 clean）。
- 每仓一把 write deploy key，core.sshCommand 已钉好，直接 git push，别加 GIT_SSH_COMMAND。
- profile 里 node_modules/dsh-remote-control 必须是真目录、无 file 依赖；改代码后重启 Harness + 重载页面。
- 插件与 e2e 是两份物理 ws，按被测产物解析位置取副本，装不上就抛。
- 探针 scripts/approval-probe.mjs 加 session 参数；取码走 POST /pairing/new + GET /pairing.png + zxing 解（不改 profile、不重启；umask 077，用完删）。
- 读宿主实现直接 grep 打 app.asar；status.json 按定时器刷，读数要轮询加基线。
- 判据红了先查判据再查实现；变异验证要改成能编译的形状，否则测的是上一个产物。

## 3. 命令速查

```sh
env -u NODE_OPTIONS pnpm -C dsh-remote-control test   # 本仓闸门（含 build）
env -u NODE_OPTIONS node e2e/run.mjs                  # 本地全链路 17 步
curl -s https://drc.provid.cc/healthz                 # 线上真相
cat ~/.dsh/dsh-remote-control/status.json             # 插件侧真相（轮询+基线）
node scripts/mp-preview.mjs                           # 改完 mp 先让用户扫码看
node scripts/mp-shots.mjs --pages sessions            # 截图验收

# 中继部署（2026-10-06 验证过，逐步都别省）
ssh root@47.100.82.15 ls -l /opt/dsh-remote-control/server/relay.mjs   # 先看现状
(cd dsh-remote-server && pnpm build)                                # 本地打包
scp dsh-remote-server/dist/bundle/main.js root@47.100.82.15:/tmp/relay-new.mjs
ssh root@47.100.82.15 'node --check /tmp/relay-new.mjs'                # 换之前先验语法
# 远端：备份(带时间戳) → systemctl stop → install -m0755 + mv → systemctl start
curl -s https://drc.provid.cc/healthz                                 # 版本号变了才算成

# 换完必看这一项——不是 0 就是没在写（见 §0.1）
curl -s https://drc.provid.cc/healthz | grep -o '"stateWriteFailures":[0-9]*'

# 改了 systemd 单元还要：install -m0644 新单元 → systemctl daemon-reload → restart

```

## 4. 宿主能力面：P0 / P1（2026-10-06 通读 app.asar + 真机日志取证）

完整版在 [docs/HOST-CAPABILITIES.md](docs/HOST-CAPABILITIES.md)（30 服务 / 140 方法的来源与理由）。
这里只留**已核实**的结论 —— 每条都有取证来源，不是推测。

**怎么查的**（别再靠猜）：

```sh
# 1. 每个宿主包带一份机器可读的调用契约：lib/typert.host.js（服务 + 方法 + 参数 + 返回）
# 2. 每个包还有 README.md（人话版签名、语义、已知限制）
# 3. 线上到底挂了什么：status.json 的 probe.wanted（逐个点名，回答 true/false）
# 4. 事件到底发不发、长什么样：真机 session log 解压后统计
#    ls -t ~/.dsh/sessions/*/*/session.v4.jsonl.zstd | head -12 | xargs -I{} /opt/homebrew/bin/zstd -dc {}
```

### ⚠️ 两个取证陷阱（都踩过）

1. **`probe.loaderRows` 不能用来判断"某包装没装"** —— 它被我们自己 `slice(0, 2600)` 过，
   截断点之后的看起来就像没加载。2026-10-06 差点据此断言 token-meter 没挂。
   已加 `probe.wanted` 逐个点名回答，短的、不截断、可复算。
2. **判据红了先确认变异真的改变了行为** —— 我第一次回归验证从 `MAPPED_SESSION_EVENTS` 里
   删掉 `llm/retry`，判据却没红：那张表只管 status.json 记账，switch 照样跑。
   换成直接改 switch case 才验到。**变异必须作用在被测的那段逻辑上。**

### P0

| # | 能力 | 状态 |
|---|---|---|
| 1 | `tokenMeter` 上下文占用 | ❌ **这个 profile 没挂**。依赖 `session-projection` 在，它自己不在 |
| 2 | `workspace/changes` 改了哪些文件 | ❌ **做不了**。真机 66 个样本**全是 `{turn:N}`** —— 只是"本轮有改动"的宣告，文件清单在认证 Web 路由里，中继够不到。只报"改了文件"却不给哪些文件，比不说更糟 |
| 3 | 压缩可见 `compaction/*` | ✅ **已做（主机侧）**，真机 18 次。`start{compactionId,turn}` / `end{compactionId,turn,error?}` |
| 4 | 重试可见 `llm/retry` | ✅ **已做（主机侧）**，真机 18 次。data 带 retry/maxRetries/failure |

P0-1/P0-2 的"没挂"指的是**这个 profile 的组合**。宿主发布清单里有（`desktop-runtime.json`
287 个包，含 dsh-token-meter），是 profile 没引。**要启用得改 profile 的 bundle 声明**，
那是宿主配置、影响面比改我们代码大得多，别顺手就动。

### P1

| # | 能力 | 状态 |
|---|---|---|
| 5 | 文件附件走 receipt（`client-file-upload`） | ❌ **没挂** → 印证了文件附件那条路确实够不到，不是没找对 |
| 6 | 模型下拉能用（`llm.discoverModels` 等） | 🟡 **待验**。`agentDefaultModel` 那侧确认只有 `currentSelection`，但 `llm` 服务本身已加载，有没有可用枚举入口要单独验 |
| 7 | `workspaceFiles.*` 手机看文件 | ❌ **没挂** |

### P0-3 / P0-4 的 mp 侧显示**还没做**（下一步）

事件已经从主机到中继、到 mp 的 `_onEvent` 了，但 mp 的 chat.js 里**没有** `ev.retry` /
`ev.compaction` 的处理器，所以界面上还是不会出现。

要做的：顶栏那行加一句瞬时提示，与现有运行态提示放一起。建议文案：

- `ev.retry` → 「正在重试 2/5 · TRANSPORT」（attempt/max/reason 都有）
- `ev.compaction started` → 「正在压缩上下文」
- `ev.compaction failed` → 「压缩没成功：<error>」**别与 ended 合并** —— 上下文已经烂掉而用户以为正常，比看不见更糟

wire 1.8.1 与 control 2.0.11 都已就位；control 2.0.11 已装进 Harness，重启后才生效。
