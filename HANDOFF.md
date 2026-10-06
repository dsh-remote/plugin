| dsh-remote-protocol/（包名 dsh-remote-wire） | 1.8.1 | 已发 npm（1.8.1 加 ev.retry / ev.compaction） |
| dsh-remote-control/（单包） | 2.0.11 | 已发 npm 的是 2.0.10；**2.0.11 只装进了 Harness、未发版**，见 §4 |
| dsh-remote-server/ | 1.0.5 | 已部署 2026-10-06 07:10（/healthz 1.0.5, hosts:1）；不发 npm（包名被第三方占）；⚠️ 中继重启丢配对，见 §1.1 |
| dsh-remote-mp/ | 1.1.24 | 开发版本已上传，待「选为体验版」 |

三条不许再错：

1. 仓名 ≠ 包名：仓库 dsh-remote-protocol，npm 包 dsh-remote-wire。
2. 协议是 npm 依赖（^1.8.0），不是 git/file 依赖。
3. 判据是版本号 + 文案，不是字节哈希：esbuild 内嵌模块路径标签，同源码换次构建哈希就变。
4. **图片不进 uploads.ts**：图片走宿主原生的 {type:image,data,mimeType} 内容块，
   正文不出现路径（2026-10-05 用户要求）。落盘 + 路径那套**只留给文件**——
   宿主没有文件的内联块，Agent 要读它就得有个路径。

线上真相：中继 wss://drc.provid.cc；本机 hostId=drc-748e9a9ce167（落盘 host-id，0600）；status.json 按定时器刷，读它要轮询、要带基线。

闸门（干净工作树）：wire 92/92、server 84/84、control 372/372、伞仓 194/194、mp 32/32 + 对比度全过；四个仓 format:check 全绿。

## 1. 待办（按顺序做）

### 1.1 中继落盘会话表（用户 2026-10-06 拍板方案 A，**未做**）

**问题**：会话只存在内存里，中继一重启，全部配对消失，所有手机要重新扫码。
这不是某次改坏的，是一直如此——以前没暴露，只因为线上那个进程连着跑了 29.7 小时。

取证（2026-10-06 部署 1.0.5 时撞上，日志逐行可查）：

```
07:09:01  client disconnected  clientId: muqu1ibj-…   ← 手机被踢
07:09:59  shutting down  SIGTERM
07:10:01  host online                                  ← 主机 1 秒内回来
07:11:05  conversations: 0                             ← 会话没回来
```

根因三条：

- `state.ts` 里 `conversations.set(...)` **全仓只有一处**（第 162 行），在**配对认领**
  路径里——那需要一枚新的配对码，也就是扫码。
- 主机重连发的 `resync()`（第 220 行）**只删不建**：它遍历的是服务器现有的表，
  主机声明的会话已经不在里面了，于是 `kept` 算出来也是 0。
- `/etc/dsh-remote-control.env` 里没有任何状态路径，磁盘上也没有状态文件——零持久化。

**它卡住了 unpair 修复的验收**：见下面 §1.2 那条「手机切后台再回来不许要求重新扫码」
在落盘做完之前**根本验不了**——中继重启后手机必然掉配对。这两条是同一件事。

**方案 A：中继落盘会话表，启动时读回**（不碰协议、不改安全模型）。

要定的几件事：

- 位置：新增 `DRC_STATE_FILE`。**默认关闭**，这样本地起一个中继不会被凭空多出状态。
- 存什么：conversationId / hostId / clients / seqHost / seqClient / 时间戳。
  **不存** pendingPairs（本来就短命，且它带一次性语义）。
- 原子写：先写临时文件再 rename。半截状态文件把中继起挂掉，比没有文件更糟。
- **不落任何秘密**：中继是结构性零知识的，它从来不持有 PSK。会话 id 与 client id
  本来就明文出现在帧里，落盘不扩大暴露面。
- 启动时先读后 listen。**文件损坏要记日志并按空启动**，不能拒绝启动——
  起不来的中继等于整个产品停摆。
- 回收要同步删盘：空会话回收与空闲剪枝都是内存里做的，不同步的话
  重启会把已经死掉的会话复活。

验收（缺一条都算没做完）：

1. 重启中继 → `conversations` 仍然 > 0
2. 手机带着旧 convId 连上来 → **不回** `unknown_session`，不用重扫
3. 没有状态文件时启动 → 行为与今天完全一致
4. 状态文件损坏 → 中继照常起来，日志说清，按空处理
5. 会话被回收后重启 → 不会复活


### 1.2 unpair 修复的真机复验（部署已完成，**验收还没做**）

1.0.5 已上线，`unpaired` 标记现在真的在发。但下面两条只在**真机 + 真人点**下才验得了，
e2e 只覆盖了中继发标记那一半：

- mp 解除配对 → dsh 的 pill 从「手机离线」变「**未配对**」
- 手机切后台再回来 → **不许**要求重新扫码

⚠️ 第二条在 §1.1 做完之前**必然验不过**：中继一重启配对就没了，手机连上来
先撞 `unknown_session`。**先做 §1.1，再回来验这一条。**

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
