# HANDOFF — dsh-remote-control

> 交接给下一位开发 agent。**先读本文，再读代码。**
> 最后更新：2026-10-03 深夜（开源四仓已建已推；`dsh-remote-wire`、`dsh-remote-control` 两个包
> 已上 npm；CI 的 node 20 腿修好了，原因与改法见 §7.4）。

## 0. 一句话状态

这次是**从零重写之后的状态**：小程序 `mp/` 一行未改；协议层 / 中继 / host 插件 /
右栏呈现（`packages/presentation`）/ e2e / 脚本 / 设计文档全部重写，旧代码已删除
（旧实现只剩 `docs/legacy-spec/` 里的事实档案，需要看旧代码用 `git show b026d63:<path>`）。
生产入口 `wss://drc.provid.cc` 已经跑上重写后的单文件中继，并用真链路取证验证通过。

设计、拍板与偏离记录在 [`docs/DESIGN.md`](docs/DESIGN.md)（冻结契约表 §2、偏离 D1-D9 §4、
阶段门禁 §7、拍板 §8、执行日志 §9）。对这份设计的独立复核在
[`docs/DESIGN-REVIEW.md`](docs/DESIGN-REVIEW.md)——**它的 🔴 条目已全部落地**，
复核里"判据不足以守住什么"那一段是这一轮真机取证的主战场。

## 1. 当前实测状态（每条都有可跑的命令）

| 层 | 状态 | 怎么验 |
|---|---|---|
| 类型 | 三包全绿 | `env -u NODE_OPTIONS pnpm -r typecheck` |
| 协议层 | **82 项全绿** | `pnpm --filter @dsh-rc/protocol test` |
| 与小程序逐字节对拍 | **18 项全绿**（284 条向量 + 随机新向量 + 篡改 + 反证 + F6 契约） | `node --test e2e/protocol.test.mjs` |
| 中继 | **73 项全绿**（含产物级零知识断言、空目录起单文件、优雅停机 exit 0、version 对账、诊断计数） | `pnpm --filter @dsh-rc/server test` |
| host 插件 | **218 项全绿** | `pnpm -C packages/plugin test`（根包与插件包**同名**，按名字 filter 会命中两个） |
| 右栏呈现 | **44 项全绿**（码没落盘 / 已过期一律不 `ready`、`expiresAt` 的 ISO 与毫秒两种形状、路由防环回与防跨作用域、浏览器面产物形状） | `pnpm -C packages/presentation test` |
| 本地全链路 | **15 步全绿**（真中继进程 + 真 `apply()` 入口 + 真 mp 代码，内核面 mock；第 6 步就是取历史） | `node e2e/run.mjs` |
| 生命周期取证 | **86 项全绿**（客户端重连 / 中继重启 / **主机重启不许静默** / 审批闭环 / 提问闭环 / 多码并存 / 历史分页 / chat 块流 / **浅深主题**） | `node --test e2e/*.test.mjs`（在 `e2e/` 下跑） |
| 小程序页面逻辑 | **22 + 3 项全绿**（chat 块流时序与历史回放 / 过程窗口 / 会话列表归档过滤） | `pnpm -C e2e test:mp-pages` |
| 小程序主题 | **9 项全绿**（默认浅色 / 双向可切 / 跨启动保留 / 切了要同时改导航栏与回弹区 / 存不下要如实报） | `pnpm -C e2e test:mp-theme` |
| 真实链路 | **18 项/轮全绿**：生产入口 1 轮、本地中继 3 轮；助手正文 114/162 字与 2 条工具行确实到了手机 | `node e2e/live-e2e.mjs` |
| 二维码 | zxing-cpp 真实解码 28/28 | `node scripts/validate-qr.mjs` |
| 生产 | 跑的是 `relay.mjs`（单文件，`/healthz` 报 `version: 2.0.0`），journalctl 无 warning | `curl https://drc.provid.cc/healthz` |
| **未取证** | 真机上的**审批卡与提问卡**：见 §1.1 | — |

> 上面这些数字**跑出来是多少就写多少**，别照抄（这一栏换过好几轮了）。
> 一条经验：`apps/server` 与 `packages/*` 的测试引的是 **`dist/` 里的产物**，
> 所以必须走包自己的 `test` 脚本（它先 build）；直接 `node --test tests/*.mjs`
> 会在 dist 陈旧时红给你看，而那是假红 —— 排查前先 build。

### 1.1 唯一没能在真机上取证的两条（诚实记账，不许当成已通过）

- **审批**：`kernel.approvalFace` 在真宿主上是 `"registered"`——插件确实**登记成了
  `approval/request` waterfall 的参与者**。但这条路径本机现在**按宿主设计就不可能触发**：
  扫 `~/.dsh/sessions/*/*/session.v4.jsonl.zstd` 里每个会话的 `approval/policy` 事件，
  **截至 2026-10-02 共 26 个会话全是 `never`**（部分是 `source:"delegation"`，且这是
  **部署配置**而非缺会话——见 §5.1），而
  `@deepseek-ai/dsh-user-approval` 的 README 写着 `'never' rejects before interactive dispatch`
  ——即在参与者被问到之前就决定了。所以"卡片推给手机 → 手机点批准 → 内核继续"这一整条
  只在**本地全链路**里验过（`e2e/mp-client.test.mjs` 第 5 条 + `e2e/run.mjs` 第 8 步）。
  要补真机取证：把某个会话的策略设成 `ask`（桌面 UI 里做，或用服务的 `setApprovalPolicy()`），
  再跑 `node e2e/live-e2e.mjs --session <那个会话 id> --prompt <需要审批的指令>`。
  重扫命令（**只读**，直接用 homebrew 的 `zstd`；`scripts/read-session-log.mjs` 是单会话版）：
  ```sh
  cd ~/.dsh/sessions && for f in $(find . -name 'session.v4.jsonl.zstd'); do \
    echo "$(zstdcat "$f" | grep -o '"approval/policy"[^}]*}' | tail -1) | $f"; done
  ```
- **提问**：`kernel.questionsFace` 现在会把服务实际暴露的成员一起报出来，真机上是
  `no registerProvider (keys=name|typertRemote|waits|queuedReplies|…)`——这一代宿主的
  `ctx.userQuestions` 不是 `@deepseek-ai/dsh-user-questions` 那份带 `registerProvider` 的
  服务定义，所以**接管路径在本机不可能跑起来**（不是代码问题，但也不能写作已验证）。
  本地闭环有测试：`e2e/mp-client.test.mjs` 第 6 条 + `e2e/run.mjs` 第 10 步。

## 2. 快速恢复环境

```sh
cd /Users/linbin/dsh-remote-control
env -u NODE_OPTIONS pnpm install          # §4.1：必须 env -u NODE_OPTIONS
env -u NODE_OPTIONS pnpm -r typecheck
env -u NODE_OPTIONS pnpm -r test
./scripts/relay-start.sh --bundle          # 本地中继（token 复用 profile 里那份）
./scripts/install-to-profile.sh            # 构建 + 装两个 bundle（主插件 + 右栏呈现）；之后重启 Harness，改过浏览器面还要重新加载页面
osascript -e 'tell application "DeepSeek Harness" to quit'; sleep 6; open -a "DeepSeek Harness"
node e2e/live-e2e.mjs                      # 真链路（本机 Harness 必须在跑；且要先 /drc pair，见 §4.5）
```

读码顺序（重写后的分层）：

1. `docs/DESIGN.md` §2（冻结契约表：B1-B9 字节级 / F1-F13 帧与字段 / T1-T8 传输语义）——
   这一节是"哪些东西不能动"的唯一事实源。
2. `packages/protocol/src/`：`bytes` → `keys`（KDF 与 nonce）→ `record`（seal/open）→
   `pairing`（URI）→ `frames`（控制面）→ `payloads`（数据面）→ `outbound`（**出站帧构造器**：
   出站帧是造出来的，不是拼出来的）。
3. `apps/server/src/`：`state`（四张表 + 不变量）→ `server`（路由与 D1-D6 行为）→
   `main`（拒绝无 token 启动、SIGTERM→1001→exit 0）。
4. `packages/plugin/src/`：`ports/index.ts`（可测性契约）→ `core/`（纯逻辑：
   `keys` 密钥簿、`window` 合帧、`pairing-window` 活码策略、`runtime` 事件↔载荷）→
   `transport/relay.ts` → `platform/`（唯一认识 cordis 的地方）→ `shell/` → `index.ts`。
5. `mp/core/client.js`（冻结消费面）+ `e2e/`（契约的执行机构）。

## 3. 这次重写改了哪些行为（拍板与偏离）

`docs/DESIGN.md` §4/§4.5 有全文，这里只列影响判断的：

- **D1：PSK 从不上网**。旧实现把 PSK 放在 `pair-begin` 里发给中继；现在只发 6 位码，
  PSK 只在二维码里。**后果**：**两个方向都不能单向混搭**——新 host 发给旧中继会硬失败
  （旧中继要求 `pair-begin.psk` 是 ≥16 字符的字符串）；旧 host 发给新中继也**不是**兼容
  （旧 host 发的 `auth` 落到新中继的 `default:` 分支，只会收到 `error{unknown_frame}`，
  它等不到 `auth-ok`，会一直停在 connecting——见下面的 D5）。
  所以回滚单位是"中继产物 + 插件产物**成对**回滚"，不是只回滚一边。
- **D3/D6：会话跨断连存活**（这是这次的产品级卖点：手机回前台不再要求重新扫码）。
  代价是必须有一条"主机不认得这条 convId"的出口，见 §5 的 R1 三件套。
- **D5：`auth`/`auth-ok`/`auth-fail` 并入 `hello`/`hello-ok`**；失败统一 `error{bad_token}`。
  这条把 D1 的"不能单向混搭"补齐：旧 host 的 `auth` 在新中继里是 `unknown_frame`。
- **D9：apiProxy / typert 两个弱 carrier 整个删掉**，只留 `services` + `mock`。
- **F6：`pair-fail.reason` 只能是小程序能翻译的四个**。中继的全局限速原因
  （`rate_limited`）只进日志，线上写 `invalid_or_expired`——弹英文给用户是不允许的。
- **配对二维码默认出图片**（2026-10-02 翻转原拍板）：真机取证发现 DSH 命令卡按 `line-height:1.6` 渲染等宽输出，行间留白把半块文本码横切成条（用真机输出做受控实验：行距 1.0 时 zxing 解得出来、≥1.15 就扫不出来），文本码在这个宿主上根本扫不了。于是 `qrImage` 默认 **true**（写 `pairing-qr.png` 并把路径给用户）、`qrOpen` 仍默认 **false**（写图 ≠ 替你打开查看器）、`qrAnsi` 默认 false、`qrStyle` 默认 `half`（只在关掉 `qrImage` 时当退路）。命令 API 只接受纯文本，所以图片以"文件路径"的形式进卡片，卡片同时给可粘贴的 `dshr:/p?…` 一行。
- **二维码自动进右栏**（2026-10-02，新增 `packages/presentation`）：`/drc pair` 之后
  右栏**自己弹出**当前配对码，用户不必再去点侧边栏。做法是一个 `dsh.client` 双面包——
  宿主侧把码落成 `<会话工作区>/.dsh/sidebar-qr.png`（工作区解析不出来才落 `~/.dsh/sidebar-qr.png`）
  并给一条同域只读路由
  `/plugins/dsh-remote-control-presentation/pairing`；浏览器侧每 2s 轮询它，
  `state==='ready'` 且 `epoch` 变了才 `ctx.sidebarRight.openResource(address)`。
  不切工作区、不静默换工作区。**为什么拆成独立的包**：`openResource` 要用 `webServer`
  服务（`clientModules` + 路由），而主插件刻意不写 inject 闸门；拆开后缺 `webServer`
  的宿主只影响这一行，配对/中继不受牵连。安装脚本与产物见 §2/§4.9。
- **二维码落到会话工作区的 `.dsh`**（2026-10-02 用户拍板，原话「要保存到工作区的 .dsh
  不是 home 下的 .dsh」）：`/drc pair` 的 `pairing-qr.png` 与右栏的 `sidebar-qr.png` 都写进
  **请求那条会话的工作区**下的 `.dsh/`；"会话 → 工作区"这点平台知识只在主插件里
  （`KernelPort.sessionWorkspace()`，`ctx.sessions.get(id).header.cwd`），presentation 半侧
  通过 `dshRemoteControl.sessionWorkspace()` 问它，问不到才退回 home 兜底。落盘时机也从
  "后台节拍"挪到"路由答题前"——只有路由知道 `?session=`。**不变量**：写不成就不答 `ready`。
- 环境变量：中继的默认值逐项继承旧值，但**三个变量名改了**
  （`DRC_MAX_AUTH_ATTEMPTS`→`DRC_HOST_AUTH_MAX_ATTEMPTS`、
  `DRC_MAX_PAIR_ATTEMPTS`→`DRC_PAIR_ATTEMPTS_PER_CONN`、
  `DRC_MAX_PAIR_ATTEMPTS_PER_SEC`→`DRC_PAIR_GLOBAL_PER_SEC`）。
  生产 env 文件里原本只设了未改名的四项，所以没炸；换机器时要按新名字写。

## 4. 环境坑（每条都是踩过的）

### 4.1 `env -u NODE_OPTIONS` 是必须的
Qoder CLI 会往子 shell 注入 `NODE_OPTIONS=--require ".../cjs-js-proxy-registry.js"`，
Node 22 的 ESM loader 解析不了它（`ERR_LOADER_CHAIN_INCOMPLETE`），**任何** `pnpm`
带依赖解析的调用（build/test/install）都会挂。所有文档里的命令都带这个前缀。

### 4.2 profile 的 `node_modules/dsh-remote-control` 必须是真目录
它是旧安装方式（`pnpm add file:`）留下的软链/物化副本来源。**只要 profile 的
package.json 里还留着那条 `file:` 依赖，宿主里就可能同时跑两个插件实例**：
两个 hostId、中继里两份会话、手机连到哪个全凭运气，而 `status.json` 的计数来自
另一个实例——这次排查被它误导了整整几轮。`install-to-profile.sh` 现在会拒软链、
整目录先删后建、并删掉那条依赖。改完必须重启 Harness。

### 4.3 `noEmitOnError: true`（`tsconfig.base.json`）
`esbuild`/`tsc` 的"build 绿"以前不等于"类型对"；插件的测试跑的是 tsc 产物，
类型不过就该整体红。

### 4.4 生产凭据绝不进仓库
`DRC_HOST_TOKEN` 只在 `~/.dsh/profiles/desktop/cordis.patch.yml`（600）与服务器
`/etc/dsh-remote-control.env`（600）。文档/测试/日志里只允许 `fake-*` 这种一眼假的形状。

### 4.5 配对码的一次性与新鲜度
`status.json` 是按 3s 定时器刷新、**不按消费刷新**，所以外部脚本只能接受
"年龄 < 25s 且本轮未用过"的码（`live-e2e` 里 `usedTokens` 去重 + 失败重试一次）。
现在这条由 `core/pairing-window.ts` 保证"永远有一张活码"：无码 / 中继代次变了 /
过半程 / **已被消费** 四选一就换一张，且不在线绝不发布。

**但活码只在 `pairOnStartSec > 0` 时才自动发**：`PairingWindow.tick()` 第一行就是
`if (this.pairSec <= 0) return false`，而本机 profile 是 `0`（刻意不自发出码）。
所以 **`node e2e/live-e2e.mjs` 裸跑会报"status.json 里没有 pairing.qr"**——不是坏了。
正确姿势：先在 DSH 里执行一次 `/drc pair`，立刻用 `--pair <6位> --qr '<dshr:/p?...>'` 喂进去
（`--pair` + `--qr` 走的是 manual 分支，**跳过**年龄与剩余寿命两项检查，只受码本身的 TTL 约束）。
`status.json` 里 `pairing` 对象的形状是 `{token,psk,expiresAt,qr,ageSec}`
（**没有 `createdAt`**——别按字段名猜时间基线）。

### 4.6 `agent.abort()` / `agent.interrupt()` 不存在
正解是 `agent.cancel({kind:'user'}, {keepInbox:true})`。`permission/requested` /
`question/requested` 这两个**本地事件名也不存在**（它们是 apiProxy 的帧类型）；
审批要**参与** `approval/request` 这条 waterfall（返回 outcome 或调 `next()`），
提问要注册 `userQuestions` 提供者。全部有 `tests/carrier-services.test.ts` 锁住调用形状。

### 4.7 `ctx.inject(names, cb)` 的回调参数是**作用域化上下文**，不是服务
而且 cordis 的 `ctx` 是 Proxy：读一个它没有的属性名是**抛错**，`?.` 挡不住
（`ctx.onDispose?.()` 就是这么把整条 fiber 打进 FAILED、连带 dispose 六个 inject 子 fiber
→ `carrier=none`）。卸载钩子只能用 `ctx.effect`；探测属性存在与否用 `'x' in ctx`。

### 4.8 别改共享 build 里的 `rm -rf`
`apps/server` 的 build 以前先 `pnpm clean`（`rm -rf dist`），而 `dist/` 同时是
四套测试的读取目标——并行时会把别人正读的东西抽走。现在 `bundle-relay.mjs` 只删自己的产物。

### 4.9 「右栏没自动弹」先看有没有活动会话
`ctx.sidebarRight.require()` **只在挂载了会话列时才返回 `{sessionId, actions}`**；
应用停在设置页 / 插件页时它拿不到 sessionId，浏览器面就**在发起任何 fetch 之前**静默 return——
表现为**零请求、零报错**，很容易误判成"入口没激活 / 注入失败"。先在应用里「新建会话」，
轮询会立刻开始打 `…/pairing?session=session-…`。静默跳过是**刻意**的（无会话页不该刷错误日志），
别改成报错。另一个坑：浏览器面改了要**重新加载页面**才重新拉 `client.cjs`，
只重启 Harness 不够（§2 的安装脚本会提示）。

## 5. 已知缺陷 / 下一步

1. **真机审批与提问取证**（§1.1）。需要一个会真的弹审批的会话，以及一个暴露
   `userQuestions` 提供者的宿主版本。**2026-10-02 重扫结论（比 §1.1 更新）**：
   `~/.dsh/sessions/**/session.v4.jsonl.zstd` 共 **26 个会话，`approval/policy` 全是
   `never`**（含 `source:"delegation"` 的子 agent 会话），**一个 `ask` 都没有**——
   所以不是"缺一个会弹审批的会话"，而是**这个部署把默认策略配成了 `never`**。
   `dsh-user-approval` 的 README 明说 `ask` 才是服务默认（`never` 是"CI 与无人值守运行的严格
   无头模式"），`setApprovalPolicy(session, policy)` 是持久写入路径。**要取证必须先改审批策略，
   那是用户的安全姿态**（`never` → `ask` 会放行原本被确定性拒绝的操作），没有用户点头不许替
   他们做。**2026-10-02 用户已明确表态：先不动策略，这条继续按"未取证"记账——别再问第二遍。**
   提问那条则**在本机无解**：这一代宿主的 `ctx.userQuestions` 就不带 `registerProvider`（§1.1），
   换会话也没用。等宿主升级后先重扫一次 `kernel.questionsFace` 的 keys 再谈。
2. **host 侧通道上界已补**（原 DESIGN-REVIEW 🟡8）：`ConversationBook.pruneStale` 按"最后活动"剪
   （`conversationIdleTtlSec`，默认 24h）并保留 64 条硬上界，剪枝一定走 `voidConversation`
   （发 `session-leave` + 通知上层），由 status 的 3s 节拍驱动。四条变异验证锁住：只删内存不发
   `session-leave`、按创建序剪、没有硬上界、KeepAwake 停机闸门被删——全部被指名的断言杀掉。
3. ~~**e2e 收尾句柄**：`node e2e/run.mjs` 打完全绿后进程约 60s 才退出~~——**2026-10-02 实测已不复现**：
   `s=$(date +%s); node e2e/run.mjs; …` 量到**整进程 wall = 2s**（脚本自报"耗时 1.2s"）。
   那条 60s 尾巴（KeepAwake 停机闸门）已经收掉了。**再看到"CI 多等一分钟"的说法，先按下面
   的命令自己量一次**，别照抄这段。
4. ~~`docs/SECURITY.md` / `SELF-HOSTING.md` / `MINI-PROGRAM.md` 仍描述旧实现~~——**已核实为过时条目**：
   这次实际读过三份，`SECURITY.md` / `SELF-HOSTING.md` 里的 `pair-begin` / `auth-ok` /
   `apiProxy` 等旧名只出现在**改名表与"旧 vs 新"偏离表**里（那是刻意留的迁移说明），
   正文讲的是重写后的实现；`MINI-PROGRAM.md` 里的 `pair-begin-client` 是小程序**现在仍在发**的帧名。
   这条可以划掉。
5. ~~**慢消费者 1008 与小程序退避可能形成循环**（DESIGN-REVIEW 🟡11）：机制已核清，缺的是实测~~
   ——**2026-10-02 补上生产实测：没复现。** `curl -s https://drc.provid.cc/healthz` 报
   `slowConsumers: 0`（中继 19:56 重启，`uptimeSec` ≈ 3.2h），`journalctl -u
   dsh-remote-control --since "26 hours ago" | grep -c "slow consumer"` = **0**；同一窗口
   `client online` **56** 次、`paired` **42** 次（其中 3 条 `platform:"wechat-mp"` 真机）。也就是说
   45s 窗口在这轮真实使用里**一次都没触发过**。
   （别照抄上面的数字，它们随 uptime 变；命令是权威。另外这台的单元名是
   `dsh-remote-control`，**不是 `dsh-relay`**——本文早前那处写法是错的。）
   机制留档（将来要动阈值前必读）：中继按角色给窗口（`apps/server/src/limits.ts:96,109`：
   host `10s`、client `45s`；阈值 `DRC_MAX_BUFFERED_BYTES` 默认 1 MiB）。client 侧给到 **45s**
   是刻意的：mp 的退避是 1s→30s 指数且 `onOpen` 清零（`mp/core/socket.js:19,20,267`），窗口短于
   它的重连周期就会变成永不升级的抖动。重连后 `bufferedAmount` 归零、窗口重算，所以**只有当手机
   在连续 45s 窗口里都排不空积压时才会循环**——那意味着这台手机真的持续跟不上。
   **结论**：不是已知缺陷，45s 不动。真出现时的判据是"**同一个 clientId 上反复**"出现
   `slow consumer disconnected`，而不是单次。

6. **真机「连接被拒」≠ 中继故障**（2026-10-02 排错结论，下次别再从头查）。症状：手机小程序
   状态行显示 `wss://drc.provid.cc`（地址没错），弹窗是 `connection refused /
   Could not connect to the server`。判据链条（全在服务端取证，5 分钟可复现）：
   - `curl -s https://drc.provid.cc/healthz` 返回 `{"ok":true,...}` → 公网可达、证书与安全组 OK；
   - `dig +short A drc.provid.cc` 只有一条 A 记录（无 AAAA）；
   - `journalctl -u dsh-remote-control` 里**没有任何 `client online`** → 客户的包根本没到中继，
     失败发生在 TCP 握手之前（配对码被拒会记成 `pair failed`，那是完全不同的症状）；
   - `grep -c "limiting connections" /var/log/nginx/drc.error.log` 的限流全部来自扫描器 IP，
     对真实客户端没有 5xx。
   **主动拒绝**（而非 12s 超时黑洞）最常见两种，按此顺序排除：
   (a) **微信「socket 合法域名」未配**——体验版/正式版强制，开发版只有开「调试模式」才跳过
   （`docs/MINI-PROGRAM.md:10-11`）；(b) 手机侧网络/代理（VPN、加速器、WeChat 代理）或手机
   DNS 缓存指向别的 IP。**10 秒判定**：用**手机浏览器**打开 `https://drc.provid.cc/healthz`
   —— 能出 JSON 就是 (a)，打不开就是 (b)。这条只涉及手机/微信后台配置，**仓库里没有可改的
   代码**（`mp/` 归并行会话）。
   **同日 23:0x 复测结论**：手机侧修好后，`client online`(platform=`wechat-mp`) 与 `paired`
   成对出现（23:03:40、23:07:17 各一条；后者的 clientId 正是 22:09 记过 `pair failed` 的那台）
   ——**链路通的判据就是这一对**：先有 `client online`，才可能有 `pair failed`/`paired`；
   两个都没有才是"包根本没到中继"。所以这次是手机侧一时连不上，中继没有持续故障。

## 6. 命令速查

```sh
env -u NODE_OPTIONS pnpm -r typecheck && env -u NODE_OPTIONS pnpm -r test
env -u NODE_OPTIONS pnpm -C packages/presentation test   # 右栏呈现：落盘判据 + 路由防环回
env -u NODE_OPTIONS node e2e/run.mjs
env -u NODE_OPTIONS node --test e2e/restart-resume.test.mjs
env -u NODE_OPTIONS node e2e/live-e2e.mjs --rounds 3
env -u NODE_OPTIONS node scripts/validate-qr.mjs
./scripts/relay-start.sh --bundle; ./scripts/install-to-profile.sh
curl -s https://drc.provid.cc/healthz
node scripts/read-session-log.mjs <sessionId> --tail 20      # 内核侧真相
cat ~/.dsh/dsh-remote-control/status.json                      # 插件侧真相
```

## 7. 开源四仓（2026-10-03；**四仓已建已推，两个 npm 包与三个 GitHub Release 都已发出**）

用户拍板：开源到 GitHub（账号 `providcc`）、MIT、拆 4 仓，**都是平行顶层目录、统一 `dsh-remote-` 前缀**。
四仓已就地 `git init` 并推到 `providcc/*`；伞仓把四个目录 detrack（见 `.gitignore`）。

| 目录 | 内容 | 发 npm？ |
|---|---|---|
| `dsh-remote-protocol/` | 线协议纯函数库（**npm 包名 `dsh-remote-wire`**，仓名仍 `dsh-remote-protocol`） | **发** |
| `dsh-remote-server/` | 零知识中继（self-hosted 单文件产物） | 不发 |
| `dsh-remote-control/` | 宿主插件 monorepo（`packages/plugin`=主插件、`packages/presentation`=右栏呈现） | **只发 1 个**：`dsh-remote-control` |
| `dsh-remote-mp/` | 微信小程序客户端（WeChat 官方目录布局，`miniprogramRoot: "miniprogram/"`） | 不发 |

**`dsh-remote-control-presentation` 不单独发 npm**（2026-10-03 用户拍板）：`packages/presentation`
标 `private: true`、去掉 `publishConfig`，仍随 `scripts/install-to-profile.sh` 以 bundle 装进 profile。
所以 `pnpm -r publish` 只挑出插件包一个（可用 `pnpm -r publish --dry-run` 复核）。

**这是拷贝出来的独立目录，不是链接。** 改 `packages/plugin/**`（并行会话常改的地方）**不会**同步到
`dsh-remote-control/packages/plugin/**`，反之亦然——两边会漂移。要同步就用
`git archive HEAD <path> | tar -x -C <目标>` 取已提交快照。

### 7.0 包名冲突：仓名 ≠ 包名

协议层的 **npm 包名是 `dsh-remote-wire`，GitHub 仓名/目录名仍是 `dsh-remote-protocol`**。
原因：`dsh-remote-protocol` 这个名字在 npm 上**已被第三方占用**（发布者 `weijf14-gmail`，
v0.1.0，2026-08-14），我们无法发。按用户定的「`dsh-remote-` 开头 + 一个单词」约定改成
`dsh-remote-wire`（npm `dsh-remote-wire` 当时查得 404 = 未被占）。

- 源码、依赖声明、文档里凡是**消费这个 npm 包**的地方都写 `dsh-remote-wire`；
- 凡是**指仓库**的地方（GitHub URL、`git clone`、链接文字、目录名）都写 `dsh-remote-protocol`；
- `dsh-remote-protocol/README.md` 顶部有一段说明两者的区别。

### 7.1 一次性引导顺序（**已全部走完**，留作升版与 fork 的说明）

1. **先推 `dsh-remote-protocol` 仓并打 `v1.0.0`**，走它的 Release 把 **`dsh-remote-wire`** 包发到 npm。✅
2. 再推 `dsh-remote-server` / `dsh-remote-control`，各跑一次 `pnpm install`，
   把生成的 `pnpm-lock.yaml` 提交，然后把 CI/release 里的 `--no-frozen-lockfile`
   改成 `--frozen-lockfile`（`^1.0.0` 在协议包发布前解析不出来，所以现在只能非冻结）。✅
3. 两个仓的 release 工作流都需要仓库 secret **`NPM_TOKEN`**。**这个 token 必须是能 bypass 2FA 的**
   ——npm 现在发布强制「2FA 或 bypass-2FA 的 token」，CI 里做不了 2FA。颗粒度 token 要
   **勾上 "Bypass 2FA"**（且账号本身已开 2FA），或直接用 **Classic 的 Automation token**。
   实测一个 `bypass_2fa:false` 的颗粒度 token（`package:write`）会在 `PUT /dsh-remote-wire`
   处 403（原文：「Two-factor authentication or granular access token with bypass 2fa enabled
   is required」）。用 `curl -H "Authorization: Bearer <token>" https://registry.npmjs.org/-/npm/v1/tokens`
   可自查 `bypass_2fa` 字段。
4. `dsh-remote-mp/project.config.json` 里是**用户自己的小程序 appid**，别人 fork 必须改。

### 7.1.1 首次发布踩过的两个 CI 坑（都已修，别再犯）

- **`pnpm/action-setup` 里不能再写 `version:`**：package.json 已有 `packageManager: pnpm@11.7.0`，
  两处同时指定会 `ERR_PNPM_BAD_PM_VERSION` 直接失败。workflow 里只留 `- uses: pnpm/action-setup@v4`。
  （protocol / server / control 三仓共 7 处，2026-10-03 已清。）
- **`format:check` 会覆盖 workflow 的 yml 与 markdown 表格**：改完 README 的表格列宽/badge 行后要先
  `prettier --write`，否则 `pnpm format:check` 红。验证时用**干净环境**复现（`git archive HEAD | tar -x`
  到伞仓之外），否则 pnpm 会向上走到伞仓的 `pnpm-workspace.yaml`，跑的不是 CI 那套。
- **`git push` 的通道**：这台机器 `github.com:443` 被墙（`api.github.com` 正常），且本机 SSH key
  属于**已封禁**的 `linbin66`。现用方案：`~/.ssh/id_ed25519_providcc*`（每仓一把）作为 write
  deploy key，remote 走 `git@ssh.github.com:443`，靠各仓 `core.sshCommand` 指定 `-i`。
  （一把 deploy key 只能挂一个仓，同一把挂第二个会报 `key is already in use`。）

### 7.2 走过的弯路（别再退回 git 依赖）

协议最初设计为 git 依赖（`github:providcc/dsh-remote-protocol#v1.0.0`）。实测 pnpm 11.7.0：
git 包的 `prepare` 必须靠 `pnpm-workspace.yaml` 的 `allowBuilds` 放行，而键**只能是含 commit
的精确解析结果**（`dsh-remote-protocol@git+https://...#<sha>`）；包名、`name@version`、`name@*`、
`name@<tag>` 四种写法全部被拒（`ERR_PNPM_INVALID_VERSION_UNION` /
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）。那意味着两个消费仓各要手改一条随协议升版漂移的键。
→ 已改为**发 npm**，消费仓写 `^1.0.0`。

### 7.3 已做的清理与验证

- 四个仓都不含生产标识符（无 ECS IP / 实例 id / `jevtv` / 真 hostToken / 真 PSK / `/Users/linbin`）；
  测试夹具里的真实域名与主机名已换成 `drc.example.com` / `my-macbook`，`ls` 夹具里的用户名换成 `dev`。
  `dsh-remote-server/deploy/` 与 `SELF-HOSTING.md` 里保留了真实公网域名 `drc.provid.cc`
  （用户已公开过，属允许保留）。
- 协议 `pnpm pack` 产物只含 `dist/src`（30 文件）+ LICENSE/README/package.json；把该 tgz 装进空
  project 后 `seal/open`、`dshr:/p?` 构造解析、根入口 108 导出全部正常。
- 消费侧用同一个 tgz 验过：server 74 项、control 271 项（plugin 221 + presentation 50）全绿。
- **改名 `dsh-remote-wire` 后又复验了一轮**：协议 82 项全绿；重新 `pnpm pack` 得到
  `dsh-remote-wire-1.0.0.tgz`，临时把 server/control 的依赖指到该 tgz 再跑——server 74、
  control 271（plugin 221 + presentation 50）全绿；随后已还原临时的 `file:` 依赖并删掉
  临时 tgz / node_modules / lockfile。改名提交：协议 `2ac160d`、server `fc05db6`、control `9119f33`。
- **control 只发 1 个包**：`packages/presentation` 标 `private: true` 后，
  `pnpm -r publish --dry-run` 只列出 `dsh-remote-control@1.0.0`（提交 `bc2ca9b`）。
  presentation 的测试仍照跑，只是不进 npm。

### 7.4 发布已完成（2026-10-03 深夜，用户授权自行决策、不停不问）

**npm 上现在有两个包**，都是 `1.0.0`、发布者 `providcc`：

| 包 | 怎么发的 | GitHub Release |
|---|---|---|
| `dsh-remote-wire` | 协议仓 tag `v1.0.0` → Release 工作流 | 有（`--generate-notes`） |
| `dsh-remote-control` | 控制仓 tag `v1.0.0` → Release 工作流（只发插件包一个） | 有 |

`dsh-remote-server` 也打了 `v1.0.0`，**不发 npm**，改为把**单文件产物 + SHA-256 清单挂进 Release**
（提交 `03c7853`）。已独立验过：`shasum -c SHA256SUMS` OK，空目录里 `node dsh-remote-relay.mjs`
起得来并应答 `/healthz`（`version:1.0.0`）。下载 → 校验 → 跑，这条链就是自托管者要走的路。

**token 现状**：能 bypass 2FA 的那把存在 `~/.provid/env-v3` 的 `DSH_REMOTE_NPM_TOKEN`（值不写在任何
仓库/文档里），两仓 secret 已换成它。**用户曾在对话里贴出过一把 `bypass_2fa:false` 的旧 token——
那把应当去 npm 站点 revoke**（它没权限发包，但仍然是把有效凭据）。

**这轮新踩的两个 CI 坑（都已修，别再犯）**：

1. **pnpm 11.7 要求 Node ≥ 22.13**（它 `import 'node:sqlite'`）。CI 矩阵里那条 `node: '20'`
   根本不是"测试没过"，而是 job 在 `actions/setup-node` 的 `cache: pnpm` 步骤就死了
   （`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`）——所以 node 20 这条腿**从来没有绿过**，
   而且把所有 Dependabot PR 的 CI 一起带红了。改法：**装/查/打包固定走 22，只把 `node --test`
   跑在矩阵版本上**（engines 声明 >=20 就得真在 20 上验一遍，别把这条杠削掉）。
   server 的 relay-smoke 同理：22 上 build，切到 20 才跑那个产物。
2. **`node --test` 的位置参数语义在版本之间变过**：node 20 把它当**字面路径**
   （`"dist/tests/**/*.test.js"` 直接 `Could not find`），node 22 才当 glob；
   而 `node --test <目录>` 在 22 上又会变成"把这个目录当模块 require"。
   所以三仓统一改成 **shell 用 `find -print0 | xargs -0` 显式列文件**，并且**先断言文件数非零**
   ——路径或命名一改，`xargs` 会"跑 0 个测试然后绿"，那是最坏的一种通过。
   验过数对得上：协议 82 / server 74 / plugin 221 / presentation 50。

**另一处收口**：control 的发布产物从 `files: ["dist", ...]` 收窄成 `["dist/bundle", ...]`——
`exports` 只指向自包含单文件，tarball 里 `dist/src`、`dist/tests` 约 90 个文件全是消费方拿不到的
（449 KB → 225 KB，`pnpm pack` 数过）。**没有为此发 1.0.1**：版本号和 tarball 都不可回收，
让下一次真实改动带走（记在 control 的 CHANGELOG「未发布」里）。

**还没做的三件事，按价值排序**：

1. **npm provenance 实际没挂上**。两个包的 workflow 都有 `publishConfig.provenance: true` +
   `id-token: write`，但 pnpm 的 OIDC 换票返回 404（`ERR_PNPM_AUTH_TOKEN_EXCHANGE`）后回落到
   `NODE_AUTH_TOKEN`，于是 `/-/npm/v1/attestations/<pkg>@1.0.0` 是 404、只有 registry 自己的签名。
   要补得去 npm 站点给这两个包配 **Trusted Publishing**（包现已存在，够条件了），然后把 workflow
   里的 token 发布改成 OIDC 发布。别在文档里宣称"带 provenance"。
2. **Dependabot 的 PR 还红着**（actions 4→7、typescript 5.9→7.0、@types/node 22→26、esbuild minor）。
   原因多半就是上面第 1 条——那些分支的 `ci.yml` 还是旧的。修好的 `ci.yml` 在 main 上，
   需要 Dependabot rebase/`gh pr update-branch` 才会带走。大版本（TS 7、@types/node 26）没审过，
   别顺手合。
3. `dsh-remote-mp` 仓的 CI 已绿，但它没有 Release 流程（不发 npm、产物在微信侧），
   要不要给它也打 `v1.0.0` 只是"有没有版本页"的问题，未决。

`presentation` 的 `package.json` 里 `homepage` 指向 `#readme` 而该目录没有 README——无害，
但它不是发包对象，下次动它时一并清掉。

## 8. 中继规模化批次 C0–C7（2026-10-03 深夜，**C0/C1/C2 已完成，C3–C7 未动**）

用户给了 C0–C7 的改造清单，并指示"推送后执行、自行决策、不停不问"。工作全部落在
**开源仓 `dsh-remote-server/`**（不是伞仓 `apps/server/`，两边已漂移；用户给的行号
`server.ts:541 sweep()` 等对得上开源仓那份）。

### 8.1 已完成

| 条 | 内容 | 提交 | 证据 |
|---|---|---|---|
| C0 | `scripts/loadtest-conns.mjs` 压测装置 + `SELF-HOSTING.md` §4.1 基线表 | `22b09cd` | 1k/5k/10k 三档实跑 |
| C1 | 保活 ping 分桶轮转（`DRC_PING_INTERVAL_MS` 60 s / `DRC_PING_TICK_MS` 1 s），表清扫仍 5 s | `504da5f` | `tests/heartbeat.test.mjs` 4 条，**全部变异验过** |
| C2 | `peersOfSockets()` → `forEachPeer()`，不再每轮复制 N 长数组 | `d421206` | 78 项全绿；`relay.test.mjs:799` 已覆盖遍历中 terminate |

CI：`dsh-remote-server` main 上 `504da5f`、`d421206` 两次 push 均 **success**。

### 8.2 C0 实测数（这台机器：macOS / 8 逻辑核 / node 22；空载 RSS ≈ 57 MB）

| N | 每连接 RSS | 每连接 fd | ping/s | sweep 最坏阻塞 | CPU |
|---|---|---|---|---|---|
| 1k | 11 KB | 1 | 197 | 6 ms | ≈0.01 核 |
| 5k | 8 KB | 1 | 985 | 41 ms | 0.02 核 |
| 10k | 7 KB | 1 | 1 960 | **96 ms** | 0.02–0.07 核 |

**C1 之后同档复测（10k）**：最坏阻塞 **96 → 7 ms**、ping 1 960 → 167 次/秒、CPU 0.02 核。

这批数推翻了清单里的三条前提，后面几轮的判据要按它们改：

1. **内存不是约束项**。7–11 KB/连接 → 10k 连接的路由表才 70–110 MB。`DRC_MAX_CONNS=200`
   卡的是 2 vCPU 上的转发算力，不是内存。C6 的价值是**可观测性**，不是容量。
2. **C1 的真正收益是事件循环，不是带宽**。10k 个 ping 挤在同一轮里把循环堵到 96 ms，
   这期间所有在途流式帧都在排队。带宽那部分（清单估的 2.1 Mbps）在**真链路上成立**
   （每条 ping 吃 ~42 B IP+TCP 头 + 一个 ACK），但 **loopback 量不出来**——
   实测只有 WS 帧层的 2 B/ping。文档里把"实测"和"解析式"分开写了。
3. **C3 的阈值不能从这批数推**。C0 的连接是**空载**的，一条业务帧都没走；
   而 C3 的担忧是 `JSON.parse` + zod 在集体突发下打满 2 vCPU。
   → **C3 开工前要先给压测装置加"带流量模式"**（走完 pair-begin / claim，再打 `enc`），
   否则全局预算的数还是拍脑袋。这条是清单本身的缺口，不是我漏做。

### 8.3 C1 的代价（写进代码注释、文档和测试，没藏）

`alive` 是"上一轮有没有回 pong"的**单轮标志**（结构没动，只换节奏），所以半开对端
（无 FIN/RST 的那种）从最坏 `2×sweepMs`≈10 s 变成最坏约 `2×pingIntervalMs`≈**121 s**
才被回收，期间一直占着 `DRC_MAX_CONNS` 的槽位。常规断开仍走 `close`/`error`，不受影响。
在意回收速度就把 `DRC_PING_INTERVAL_MS` 调小。`tests/heartbeat.test.mjs` 第 4 条
用**裸 socket 握手后不回 pong**把这个上下界都钉住了（改成一轮判活、或悄悄调大 interval，都会红）。

清单原本说"peer.alive 的判活窗口跟着改成 ping 周期 + 一轮容忍"——那会漏掉这是**两轮**
这一事实，我按实测形状写成了 2×。

### 8.4 C3–C7 待办（含清单里我改了两处判据的地方）

- **C3**：先扩压测装置做带流量测量，再定 `DRC_GLOBAL_FRAMES_PER_SEC/BYTES_PER_SEC`。
  处置按清单：中继不能丢 `enc`，所以超预算判给**触发它的那条连接**（1008 + 计数进 `/healthz`）。
- **C4**：`Log.throttledCount(key, fields)` 按秒聚合。**C0 已经把量级测出来了**：
  稳态日志 0 B/s，但 10k 建连风暴在 0.7 s 内写了 **10 000 行 / 1.3 MB**（每条 ~130 B）
  ——所以 C4 治的是**重启风暴**，和 C7 是同一场景，这两条该一起看。
- **C5**：**红线待用户拍**。`DESIGN §5.5` 写死"新增持久化：0"。D1 之后表里没有 `psk`，
  前半条理由已不成立；但"谁和谁配过对"这层**元数据**落盘仍然成立。要用户判断能不能接受。
  另外两件事会一起冒出来：systemd 要配 `ReadWritePaths=`；`e2e/restart-resume.test.mjs`
  在伞仓 `e2e/` 而不在本仓 `tests/`，**e2e 归属哪个仓**这个决定必须先做。
- **C6**：`/healthz` 加 `peers`/`rssBytes`/`sweepMaxMs`/`globalDropped`/`pingBacklog`。
  判据改为"能看见每连接成本与 sweep 阻塞"（C0 用的是外部代理，C6 换成进程内真数）。
- **C7**：**用户 2026-10-03 明确先不做**（我改到一半已 `git restore`，`dsh-remote-server`
  工作树干净、停在 `d421206`）。原计划：`listen({ backlog: 4096 })` + upgrade raw socket
  `setNoDelay(true)`；sysctl（`somaxconn`/`tcp_max_syn_backlog`）归用户自己的配置批次。
  C0 侧的观测留着备用：本机建连 10k 只用 0.7 s（loopback，量不出 accept 队列问题），
  这条真要做必须在真链路 + 重连风暴场景下验。
