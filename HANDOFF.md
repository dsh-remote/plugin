| dsh-remote-protocol/（包名 dsh-remote-wire） | 1.8.0 | 已发 npm（2026-10-05，Release 工作流带 provenance） |
| dsh-remote-control/（单包） | 2.0.10 | 已发 npm（2026-10-06） |
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

闸门（干净工作树）：wire 90/90、server 84/84、control 369/369、伞仓 194/194、mp 32/32 + 对比度全过；四个仓 format:check 全绿。

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
```
