# 遗留档案：DSH 手机远控 —— cordis 宿主插件（host-plugin / cordis 集成与平台 API 面）

> 考古基线：提交 `b026d63` 的工作树内容。证据格式 `（证据：文件:行号）`。
> 取材范围：`packages/plugin/src/index.ts`、`packages/plugin/src/adapter-dsh.ts`（仅平台挂接部分）、`packages/plugin/cordis.patch.yml`、`packages/plugin/tests/apply.test.ts`、`packages/plugin/README.md` 配置章节、`HANDOFF.md` §4.2/§4.4、`~/.dsh/profiles/desktop/`、`~/.dsh/dsh-remote-control/status.json`、DeepSeek Harness 安装内的平台包与 .d.ts。
> 事件窗口化与 cmd 分发属 runtime 包档案，本文不逐行梳理。

## 1. 插件在内核进程里的职责边界

插件是 cordis bundle 里的一个 entry（entry id `dsh-remote-control`，name `dsh-remote-control`）（证据：packages/plugin/cordis.patch.yml:4-6），跑在 **DeepSeek Harness 内核进程内**，不是独立守护进程。它把六件事缝在一起，每件的输入输出如下：

| 职责 | 输入 | 输出 | 落点 |
|---|---|---|---|
| 连中继 | `cfg.serverUrl` / `cfg.hostToken` / `cfg.hostLabel` | WebSocket 长连接 + 状态机 `runtime.state.relay` | `HostRuntime`/`RelayClient`（证据：packages/plugin/src/index.ts:342-353） |
| 桥内核 | `ctx` 上探测到的 carrier（`services` / `apiProxy` / `typertGateway`） | `HarnessBridge` 实例（真实桥或 mock 桥） | `DshKernelBridge` / `MockHarnessBridge`（证据：packages/plugin/src/index.ts:332-341） |
| 执行 cmd | 中继下发的 `Payload`（session.prompt / approval.respond 等） | 调平台 API 后的 `{ok, message}` 回执 | `handlePayload` + `DshKernelBridge`（证据：packages/plugin/src/index.ts:660） |
| 防休眠 | `keepAwake.{enabled,idleReleaseSec,keepDisplay}` | 只在「会话运行中 / 有审批或提问挂起」时持锁，空闲 `idleReleaseSec` 后自动释放；锁由 `HostRuntime` 内部持有并在 disposal 时释放（实现细节属 runtime 包） | （证据：packages/plugin/src/index.ts:9-10,343-350；packages/plugin/README.md:91-93） |
| 配对二维码 | `/drc pair [ttlSec] [--with-token/--no-token]` | 真实 PNG 文件 `pairing-qr.png` + `open` 唤起 + 纯文本回复 | （证据：packages/plugin/src/index.ts:142-179,538-572） |
| 状态快照 | `runtime.state` + `activePair` + `probeContext(ctx)` | 0600 原子写的 `status.json` | （证据：packages/plugin/src/index.ts:108-131,380-420） |

边界要点（WHY）：

- **插件不做 UI**：只 `ctx.provide?.('dshRemoteControl', {state, createPairing, stop})` 暴露一个只读句柄给未来的 UI slice 或其他插件；`provide` 不支持时静默忽略（证据：packages/plugin/src/index.ts:301 注释,513-524）。
- **插件不猜平台类型**：全程用 `LooseContext` 松结构类型，构建期**不 import** cordis 类型，避免 cordis 版本升级即编译失败（证据：packages/plugin/src/index.ts:26-35；packages/plugin/src/adapter-dsh.ts:22）。
- **插件不阻塞启动**：所有能力都是「有则用、无则降级」，具体见 §2。
- **配置来源两条**：entry 的 volatile Cordis Config（由 patch 层注入 `injected`）+ 环境变量覆盖 `DRC_SERVER_URL` / `DRC_HOST_TOKEN` / `DRC_HOST_LABEL`（后者优先级高于注入值）（证据：packages/plugin/src/index.ts:12-14,248-259）。

**装载形态与改动生效路径**（决定调试方式，HANDOFF §4.2）：

- 插件以 `file:` 依赖装进 profile，并出现在
  `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与
  `dsh.profile.bundles` 数组里（与 `@chaoset/session-archive` 等 bundle 并列，
  `dsh-remote-control` 是列表最后一个）（证据：`~/.dsh/profiles/desktop/package.json`）。
- profile 根 `cordis.yml` 是**空列表 `[]`**，注释说明合成顺序：
  `dsh.profile.bundles` → `cordis.patch.yml` → `--patch` 覆盖层，
  「Edit cordis.patch.yml, not this file」（证据：`~/.dsh/profiles/desktop/cordis.yml:1-5`）。
- **HMR 只热更 `cordis.patch.yml` 的配置，不会重新 import dist**；改代码必须重启
  Harness。重装用 `./scripts/install-to-profile.sh`，因为 pnpm 对 `file:` 依赖是
  **硬链接拷贝**，tsc 重建后 inode 变了而 profile 里仍是旧副本，脚本先 `rm -rf`
  再装（证据：HANDOFF.md:71-75）。
- 每次猜测平台 API 出错都要付一次「重启 Harness」的代价——这正是 §5.3 里
  `probeContext` 与 `bridge.services.*` 形状表存在的原因（证据：
  packages/plugin/src/index.ts:605-607）。

## 2. cordis 集成红线

### 2.1 waterfall 事件订阅禁令（WATERFALL_EVENTS 黑名单真实事件名清单）

**红线：绝不 `ctx.on(<waterfall name>, fn)`。**

机理（WHY）：cordis 的事件分两种语义。emit-mode 事件观测者只是被通知；**waterfall
事件是参与式链**——注册监听等于加入这条 waterfall 的参与者集合，监听函数的返回值
就是「这一棒往下传的值」。返回 `undefined` 会把整条链的结果冲掉（证据：
packages/plugin/src/adapter-dsh.ts:839-842「Observing one of these means
PARTICIPATING in it. Read-only integrations must use emit-mode events instead.」；
HANDOFF.md:90-93）。

**事故**：插件为了可观测性订阅过 `agent/request`。因为 `agent/request` 是
waterfall，宿主在构造 LLM 请求对象那一步拿到的是本插件监听器返回的
`undefined`，于是**内核进程内每一个 turn 都崩**，报
`Cannot read properties of undefined (reading 'provider')`，连桌面 UI 里人工发消息
也一起崩（证据：HANDOFF.md:91-93；同一根因在
packages/plugin/src/adapter-dsh.ts:98-100 的注释里被独立记述：「if it yields
nothing the loop dies with "reading 'provider'"」）。

**真实事件名清单（13 项，来自代码常量，非推测）**（证据：
packages/plugin/src/adapter-dsh.ts:140-154；清单头部注明「verified against
desktop rc.6」packages/plugin/src/adapter-dsh.ts:130-135）：

1. `agent/pre-step` —— 也是宿主 `archived-session-gate` 挂靠的闸门（见 §4）
2. `agent/request` —— **就是当初把内核搞崩的那个**
3. `agent/request-error`
4. `compaction/summary-error`
5. `connection/request`
6. `fs/edit-intent`
7. `fs/write-intent`
8. `internal/get`
9. `internal/set`
10. `loader/patch-context`
11. `session-telemetry/record`
12. `user-questions/request`
13. `workspace/session-activity`

**测试护栏**（两道，重写时必须等价保留）：
- 白名单式断言：实际订阅的每个事件名必须满足
  `assert.equal(WATERFALL_EVENTS.has(name), false)`（证据：
  packages/plugin/tests/listing.test.ts:278-297，注释明确写「cordis WATERFALL
  registers a participating listener, and a listener that…」）。
- 黑名单自校验：`WATERFALL_EVENTS.has('agent/request')` 与
  `.has('agent/pre-step')` 必须为真——防止有人「顺手清空黑名单」把护栏变成空壳
  （证据：packages/plugin/tests/listing.test.ts:299-300）。

被否决的替代方案：①「订阅但返回入参原值」——依赖每个事件的参与者契约，一旦宿主
新增 waterfall 就再次翻车，且插件根本不知道自己参与了什么；②「只订阅看起来安全的
agent 事件」——正是事故做法；最终选择**显式黑名单 + 只订阅 emit-mode**：
`session/event`、`session/created`、`agent/status`、`agent/error`、
`permission/requested`、`question/requested`（证据：
packages/plugin/src/adapter-dsh.ts:853-891，订阅循环里命中黑名单即跳过并记
「refusing to observe a waterfall event」:869-872）。

**独立取证结论（13/13 名称在宿主产物中确为 waterfall 家族）**：
- 崩溃点直接对得上：`@deepseek-ai/dsh-agent-loop/lib/index.js:685-691`
  `const proposedConfig = await this.dispatch.waterfall("agent/request", ...)`
  紧接 `if (!proposedConfig.provider || !proposedConfig.model) throw ...` ——
  监听器返回 `undefined` 使 `proposedConfig` 变 undefined，下一行读
  `.provider` 正是事故文案（`@mode waterfall` 声明见
  `@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:246-259`）。
- `agent/pre-step` `@mode waterfall`：同上 :225-240；`agent/request-error` :261-275。
- `internal/get` / `internal/set`：`@deepseek-ai/cordis/lib/types/events.d.ts:230-233`
  （且 `DispatchMode = 'emit'|'parallel'|'serial'|'bail'|'waterfall'` :25）。
- `fs/edit-intent`、`fs/write-intent`：`@deepseek-ai/dsh-fs/lib/types/index.d.ts:28,36` `@mode waterfall`。
- `session-telemetry/record`：`@deepseek-ai/dsh-session-telemetry/lib/types/index.d.ts:40`。
- `loader/patch-context`：`@deepseek-ai/cordis-plugin-loader/lib/types/index.d.ts:24`
  （签名带 `next: () => void|Promise<void>`，waterfall 形状）。
- `workspace/session-activity`：`app.asar!/dsh/node_modules/@deepseek-ai/dsh-workspace/lib/types/index.js:290`
  `await this.ctx.waterfall('workspace/session-activity', ...)`。
- `user-questions/request`：桌面宿主
  `app.asar!/dsh/node_modules/@deepseek-ai/dsh-user-questions/lib/types/index.js:326-327`
  `ctx.waterfall('user-questions/request', ...)`；且在官方转发表里显式标
  `mode: 'waterfall'`（见下）。
- `compaction/summary-error`：asar 内 `dsh-compaction` 以
  `this.ctx.waterfall("compaction/summary-error", {...}, () => false)` 派发，
  README 亦称「Failed summary requests dispatch synchronous
  `compaction/summary-error`」。
- `connection/request`：asar 内 `dsh-client-connection` 以
  `await webCtx.waterfall("connection/request", req, res, () => bridge(...))`
  派发，README 明说「Authenticated shared HTTP requests pass through the
  `connection/request` waterfall before body transfer」。

**黑名单不是完备清单（新实现的关键认知）**：宿主自己有一份权威的
「事件名 + 派发模式」表，位于
`app.asar!/dsh/node_modules/@deepseek-ai/dsh-api-remotes/lib/types/remote-events.js:12-40`
（`API_REMOTE_FORWARDED_EVENTS`，注释称「The one home of this application's
forwarded-Host-event allowlist…The explicit mode is both the Host dispatch
strategy and the legal key set of `ctx.remote.$on`」）。据此表
`approval/request`（:14）与 `user-questions/request`（:39）被标为 `waterfall`，
其余 25 项标为 `emit`。**`approval/request` 并不在旧插件的 13 项黑名单里**；同理
从 `@mode waterfall` 声明全量扫出的 `llm/stream`、`system-prompt/assemble`、
`tools/pre-execute`、`tools/execute`、`tools/post-execute`、
`tools/code-dispatch-log`、`internal/config`、`internal/update` 也不在。旧插件没
出事只是因为**它压根没订阅这些名字**（它的 typert 路径是把
`approval/request` 当作 wire 帧 `type:'waterfall'` 来读，不是本地 `ctx.on`，
证据：packages/plugin/src/adapter-dsh.ts:349,369）。
推断：重写时应改为**白名单**（只允许订阅列举过的 emit-mode 事件）而非黑名单，
黑名单在任何宿主代际升级后都会静默失效。

**代际提醒**：本机存在两套内核产物——CLI
`@deepseek-ai/dsh 0.1.0-rc.6`（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`，
`~/.dsh/profiles/node_modules/@deepseek-ai/*` 全部软链到它，tui/headless/web/插件
都解析到这里）与桌面 App 自带 `app.asar!/dsh/node_modules/`（bundle 版本
0.2.0-rc.2）。同一符号可能只在其中一套里声明（下节逐条标注）。旧插件注释里
「verified against desktop rc.6」指的是前者这一串包名。

### 2.2 `apply()` 绝不外抛异常

**红线：一个远控附加组件绝不能让 Harness 起不来。**

`apply(ctx, injected)` 的唯一动作是 `try { applyInner(...) } catch (e) { console.warn(...) }`
（证据：packages/plugin/src/index.ts:261-269，注释「Hard rule: a remote-control
add-on must never prevent the Harness from booting. Every failure below is
reported and swallowed.」）。抛出去会被 cordis 认为是插件加载失败，代价是整个
bundle 行的健康度受影响，而收益为零。

贯彻到每一层的同一条纪律（不是只包 apply 外壳就够了）：
- 每个 `ctx.inject(...)` 调用各自包 `try/catch`，因为「这个 composition 根本不
  认识该服务」在旧宿主代际是常态（证据：
  packages/plugin/src/index.ts:465-479,480-495,534-576 每段末尾的 catch）。
- `settings.configure()` 双层 try（证据：packages/plugin/src/index.ts:301-314）。
- `ctx.provide?.()` 包 try（证据：packages/plugin/src/index.ts:513-524）。
- `runtime.start()` 失败则把 `runtime` 置回 `null` 后 return，不留半启动状态
  （证据：packages/plugin/src/index.ts:354-360）。
- `writeStatus` 整体吞异常，注释「status output is best-effort and must never
  break the plugin」（证据：packages/plugin/src/index.ts:128-130）。
- 写配对 PNG 失败也不让 `/drc pair` 失败——落到纯文本兜底（证据：
  packages/plugin/src/index.ts:172-178）。
- 反例参考：`spawn(opener, ...)` 单独包一层 try，缺 `open`/`xdg-open` 只是不打开
  （证据：packages/plugin/src/index.ts:163-169）。

### 2.3 `cordis.patch.yml` 不写 inject 的原因

patch 文件里那条 entry **只有 id/name/config，没有 `inject:` 段**，且这是刻意的，
原地留了注释（证据：packages/plugin/cordis.patch.yml:2-3「No `inject:` gate on
purpose: apply() feature-detects every kernel face (typertGateway / apiProxy /
commands) itself, so gating here would only add a way for the row to silently
never activate.」；HANDOFF.md:107-108）。

WHY：`inject:` 是 cordis 的**激活闸门**——声明依赖的服务若在该 profile 里不存在，
**整行 entry 直接不激活，插件连 `apply()` 都不会被调用**，且现场看不到任何报错
（headless 与 desktop 注册的服务集不同）。把 `apiProxy` 写进 inject 的后果就是：
desktop 这一态根本没注册 `apiProxy`（证据：HANDOFF.md:94-95），于是插件在真实
环境里静默消失，排查成本远高于「自己用 `ctx.inject([...])` 在 apply 内部做门控」。
改成内部门控后，缺服务只是少一个能力，插件仍然加载并能在 `status.json` 里留下
`carrier` 与 `probe` 证据（证据：packages/plugin/src/index.ts:287-291,411-415）。

被否决的替代方案：在 patch 里写 `inject: [apiProxy]` 或 `inject: [typertGateway]`
——两者都会在部分代际把插件锁死；写 `inject: []` 等价于不写。

注意别混淆两层：`apply()` **内部**大量使用 `ctx.inject([name], cb)`，这是 cordis
的「等某个服务出现时回调」原语，不是激活闸门，缺服务时只是回调永不触发
（证据：packages/plugin/src/index.ts:465-495）。

### 2.4 carrier 优先级 `services > apiProxy > typert` 与各 carrier 真实能力差异

优先级由两处共同实现：**探测期**用「只有 apiProxy 能抢先启动」的裁决函数 +
宽限定时器；**运行期**由 getter 排序体现。

- getter 顺序即优先级：`services` → `apiproxy` → `typert` → `none`（证据：
  packages/plugin/src/adapter-dsh.ts:301-305）。
- 启动裁决：`decide()` 里 `if (services) start(...)`；否则
  `if (apiProxy) start(gateway, apiProxy)`——**只有 apiProxy 允许立即启动**
  （证据：packages/plugin/src/index.ts:437-441）。
- 注释点明了这条规则要修的 bug：「Starting on a gateway that happens to land
  first would win the race and lock us into the weaker carrier — which is exactly
  the bug that produced `carrier=typert` on a profile that has apiProxy」
  （证据：packages/plugin/src/index.ts:433-436）。
- typert-only 的场景靠**宽限定时器**兜住：默认 5000ms，`DRC_CARRIER_GRACE_MS`
  可调（测试用短值以免变慢），到点仍无 apiProxy 才在 typert 上启动
  （证据：packages/plugin/src/index.ts:497-505）。两个 inject 是竞态关系，
  「先出现就启动」会把后到的更强 carrier 永久挡在门外（证据：
  packages/plugin/src/index.ts:423-431）。
- mock 桥的触发条件是**按 carrier 判断而非按「是否注册过 inject」**：`agents` /
  `sessionQuery` 只是 helper 不是 carrier，只暴露它们的宿主仍要落到 mock
  （证据：packages/plugin/src/index.ts:507-511；
  `cfg.mockBridge || (gateway===null && apiProxy===null && services===null)`
  packages/plugin/src/index.ts:332-334）。

各 carrier 的**实测能力差异**（这是选型的依据，不是猜测）：

| carrier | 来源服务 | 列会话 | 发指令 | 流式事件 | 备注 |
|---|---|---|---|---|---|
| `services` | 平台自身 cordis 服务 `ctx.sessions`/`ctx.agents`/… | 可以 | 可以 | 可以（`ctx.on`，仅 emit-mode） | 同进程、无线协议、无需猜 endpoint（证据：packages/plugin/src/adapter-dsh.ts:46-53；index.ts:443-449） |
| `apiproxy` | `apiProxy`（legacy face） | **唯一暴露会话列表的 wire face** | 可以（`sessions.prompt`） | 可以（`events.mux` 帧） | 证据：index.ts:423-425「apiProxy ... it is the only one that exposes session listing」；adapter-dsh.ts:12-13 |
| `typert` | `typertGateway`（`@deepseek-ai/dsh-api-gateway`） | **不行** | **不行** | 只能流事件 | 只有 `invoke()`、无流式列会话能力（证据：HANDOFF.md:94-95）；运行期会专门 warn 一次「only the Typert gateway is available — it can stream events but cannot list or prompt sessions (those live on the API Proxy). Expect an empty session list.」（证据：index.ts:368-372） |
| `mock` | `MockHarnessBridge` | 假数据 | 假数据 | 假数据 | `status.json` 的 `carrier` 字段就是用来区分「真的接上内核」还是「内存替身」的（证据：index.ts:100-107,362-364） |

一个已修的典型坑：typert 的 `$events` 端点只带 waterfall 的
`approval/request` 与 `user-questions/request`（证据：
packages/plugin/src/adapter-dsh.ts:9-11），早期把列会话也走 typert endpoint，
结果静默返回空列表（证据：packages/plugin/src/adapter-dsh.ts:289-297 注释：
「Per the official `@deepseek-ai/dsh-api-gateway` README, the host's shared
endpoint, so the Typert carrier silently returned an empty session list.」）。

`services` carrier 内部还要再分层：**5 个服务各自一个 inject 收集**，而不是等
一次快照齐活。原因是它们各自独立上线，且 `sessionQuery`（持久化语料）可能比
`sessions` 后到；晚到的服务通过 `Object.assign(services, holder)` **热补丁进
桥已经持有的同一个对象**，不需要重启（证据：
packages/plugin/src/index.ts:443-464,451-455）。

## 3. 平台 API 权威清单

图例：`[双]` = CLI rc.6 与桌面 asar 两代产物都取到证；`[CLI]` = 只在
`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh@0.1.0-rc.6`（profile 软链指向它）
取到；`[APP]` = 只在 `/Applications/DeepSeek Harness.app/Contents/Resources/`
`app.asar!/dsh/node_modules/`（bundle 0.2.0-rc.2）取到——下文 `[APP]` 后的包路径
一律省略 `app.asar!/dsh/node_modules/` 前缀；`[无]` = **未取证到**。

| # | 能力 | 旧实现调用（文件:行） | 平台侧真实签名 / 参数形状 / 返回 | 取证 | 失败降级 |
|---|---|---|---|---|---|
| 1 | 列会话（主路径） | `svc.sessionQuery.listSessions()`（adapter-dsh.ts:587-591） | `listSessions(signal?: AbortSignal): Promise<SessionRecord[]>`；记录形如 `{header:{id,createdAt,cwd,parentSession,origin,...}, live?, persisted?}`。README：「reads current persistence metadata, merges live records with live precedence, and returns cloned records in deterministic newest-first order」「`listSessions()` remains lightweight and does not load logs」 | `[CLI]` `@deepseek-ai/dsh-session-query/lib/types/index.d.ts:55`、`corpus.d.ts:41`、`README.md:9,20` | try/catch → 回落 #2，并把失败记进 `lastError`（adapter-dsh.ts:595-597）；排序在插件侧按 `createdAt` 倒序补做（:593）；上限 `MAX_LIST_SESSIONS=100`（:157,552） |
| 2 | 列会话（兜底） | `svc.sessions.list()`（adapter-dsh.ts:600） | `list(): Session[]`——「All live sessions, in creation order. @returns a fresh array」；`get(id): Session \| undefined` | `[双]` `[CLI]` `@deepseek-ai/dsh-session/lib/types/index.d.ts:393,398`（`class SessionStore extends Service` :290）；`[APP]` `dsh-session/lib/types/index.js:1042,1049` | 只返回本进程已加载的会话，故「新开的 Harness 只报一个会话」是预期行为（插件注释 :526-534）；`listingSource` 字段区分两条路（:590,599） |
| 3 | 会话标题 | `svc.sessionQuery.readTitleSnapshots(ids)`（adapter-dsh.ts:641） | `readTitleSnapshots(sessionIds: readonly SessionId[], signal?): Promise<SessionTitleObservationResult[]>`，逐行 `{sessionId, status:'fulfilled'\|'rejected', value?.title?.{title,updatedAt}}` | `[CLI]` `@deepseek-ai/dsh-session-query/lib/types/index.d.ts:93` | 4s 超时 `withTimeout`（:160,1172-1180）+ 300s 结果缓存（:159,625-655），失败只「listing continues untitled」（:649-651）；批上限 25（:158） |
| 4 | 运行状态 | `svc.agents?.get?.(id)` 后读 `.status === 'running'`（adapter-dsh.ts:575-582） | `get(id: SessionId): Agent \| undefined`；`readonly status: AgentStatus`，`AgentStatus = 'idle' \| 'running'`，注释「Disposal removes the agent from its registry; it is not a third observable status」 | `[CLI]` `@deepseek-ai/dsh-agent/lib/types/index.d.ts:349`；`runtime-types.d.ts:70,45`；`[APP]` `dsh-agent/lib/types/index.js:349` | 任何异常 → 视为非运行（`catch { return false }`），即误报「空闲」而不是报错 |
| 5 | 冷会话续跑 | `svc.agents.resume({resumeSessionId, agentOptions})` → `resumed?.agent`（adapter-dsh.ts:1161-1162） | `resume(options: ResumeAgentOptions): Promise<AgentHandle>`；`ResumeAgentOptions = {resumeSessionId: SessionId, agentOptions?: AgentOptions{provider,model,maxTokens}}` | `[CLI]` `@deepseek-ai/dsh-agent/lib/types/index.d.ts:296`（`resume`）、`123-127`（`ResumeAgentOptions.resumeSessionId` / `.agentOptions`）；`AgentOptions{provider,model,maxTokens}` 在 `runtime-types.d.ts:21-27` | 无 `resume` → 「ctx.agents.resume is unavailable in this composition」（:1157-1159）；抛错 → 把 message 透出去（:1166-1168） |
| 6 | 发指令（主路径） | `agent.followup(buildUserMessage(text))`，无则 `agent.steer(...)`（adapter-dsh.ts:706-715） | `followup(message: UserMessage): void`——「Queue an ordinary follow-up turn and wake the driver. The item becomes the sole ordinary message of its own turn」；`steer(message): void`——「Submit steering for the nearest step」 | `[CLI]` `@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:115,123` | 两者都没有 → 报错并列出 `keys=[...]` 便于现场判断（:715）。官方 apiproxy 自己就是这套：`createUserMessage({content,source})` 然后 `mode==='steer' ? agent.steer(message) : agent.followup(message)`（`@deepseek-ai/dsh-host-apiproxy/lib/types/api-proxy.js:2208-2212`） |
| 7 | 构造用户消息 | `await import('@deepseek-ai/dsh-llm')` 取 `createUserMessage`，取不到退回朴素对象 `{id, content:[{type:'text',text}], source:{kind:'user'}}`（adapter-dsh.ts:1020-1036） | `createUserMessage<T extends NewUserMessage>(input: T & {...})` | `[CLI]` `@deepseek-ai/dsh-llm/lib/types/message.d.ts:171`；官方用法 `dsh-host-apiproxy/lib/index.js:8,2850` | 动态 import 失败静默走兜底形状；**运行时才解析**，因此构建期无依赖（`as string` 防类型解析，:1022）。推断：兜底对象缺少官方 `id` 生成/校验，可能被宿主拒绝——旧实现未覆盖该失败面 |
| 8 | 中断 | `agent.abort()`，无则 `agent.interrupt()`（adapter-dsh.ts:745-752） | **两个符号都不存在。** 平台权威取消方法是 `cancel(cause: AgentCancelCause, options?: CancelOptions): void`，`CancelOptions.keepInbox` 保住了 inbox；官方 apiproxy 的实现是 `agent.cancel({kind:'user'}, {keepInbox:true})` | `[无]`（`abort()` 在 `[CLI]` 全树 .d.ts/.js 与 `[APP]` asar 中零命中；`interrupt(` 只作为 `ctx.subagents.interrupt(targetSessionId, authority)` 存在，见 `@deepseek-ai/dsh-subagent/lib/types/index.d.ts:152`、`dsh-host-apiproxy/lib/types/api/subagents.d.ts:97`）。**`[CLI]` `@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:80`** + `api-proxy.js:2333-2348` 给出正解 | 无 live agent → `no live agent for X`；两个方法都没有 → 报 `agent cannot be interrupted (keys=[...])`（:753）。**结论：本条在 services carrier 下实际永远走错误分支，中断功能要靠 `agent.cancel({kind:'user'},{keepInbox:true})`** |
| 9 | 订阅事件（services 载体） | `svc.on(name, fn)`，名单见 §2.1（adapter-dsh.ts:853-891） | `session/event(this, session, event)`、`session/created(this, session)` 为 emit；`agent/status(this, payload:{agent,status})`、`agent/error` 同理 | `[双]` `[CLI]` `@deepseek-ai/dsh-session/lib/types/index.d.ts:44,66`；`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:169-171,316`；`[APP]` `dsh-api-session-controller/lib/types/index.js:239,252,255,258` 官方自己就是这样监听的 | 每个 `on` 单独 try（事件名未声明即跳过，:874-879）；无 `on` 函数则整条流式能力关闭并记日志（:855-857）；unsubscribe 逐个 try（:881-889） |
| 9b | `permission/requested` / `question/requested` | 同上订阅名（adapter-dsh.ts:864-865） | **本地事件名未取证到**。真实存在的相近符号是：apiProxy mux **帧类型** `'approval/requested'` / `'question/requested'`，以及本地 **waterfall** `approval/request`、`user-questions/request` | `[无]`（全树含 asar 对 `permission/requested` 零命中）。`[CLI]` 帧类型：`@deepseek-ai/dsh-host-apiproxy/lib/types/api/events.d.ts:76,88`；`[APP]` 转发表：`dsh-api-remotes/lib/types/remote-events.js:12-40` | 订阅失败静默 → 审批/提问在 services 载体下推不到手机端。推断：这是旧实现的**未修缺陷**，新实现应改订 `approval/requested` 语义对应的真实通道 |
| 10 | 会话内事件词汇表 | `emitSessionEvent` 按 `turn/start`、`assistant/message`、`tool/call`、`tool/result`、`turn/end` 分派（adapter-dsh.ts:922-969） | 注释称「Vocabulary verified against a real desktop session log: turn/start, step/start, user/message, assistant/message, tool/call, tool/result, step/end, turn/end, session/title, agent/inbox/spliced, request/header」；且「There is NO token-level delta event in the log」→ 一步一条完整消息（:899-902） | `[APP]` `dsh-session/lib/types/known-event-types.js` 逐个点名——`agent/inbox/spliced`:23、`assistant/message`:28、`request/header`:50、`session/title`:55、`tool/call`:72、`turn/end`:76、`turn/start`:77；`request/header` 亦对应 `session.requestHeader(): EpochHeader{config}`（`[CLI]` `dsh-session/lib/types/index.d.ts:225`、`types.d.ts:191-200`） | 未识别的 type 直接忽略（无 else 分支）；`turn/end` 先补一帧空 `done` 再发 `run_state idle`，注释「order matters for the phone UI」（:964-966） |
| 11 | 模型选择（部署默认） | `svc.agentDefaultModel.currentSelection()`（adapter-dsh.ts:1129,819） | `currentSelection(): ModelSelection`；README：「`ctx.agentDefaultModel.currentSelection()` returns a detached `{ provider, model, reasoningEffort? }` selection for a newly created Agent」，并说明 `reasoningEffort` 故意不在 plugin config 里 | `[CLI]` `@deepseek-ai/dsh-agent-default-model/lib/types/index.d.ts:48`、`README.md:7,9` | 可选链 + try → `fallback = undefined`；**没有可用默认模型时插件主动拒绝**并给出人话（:1145-1153）。WHY：宿主 loop 缺 model 会在 `prepareRequest` 里抛 `reading 'provider'`（§2.1），官方 `turnAgentFor` 同样以 `model-unavailable` 拒绝（注释 :1117-1121，`[CLI]` `dsh-host-apiproxy/lib/types/api-proxy.js:2185` 起有 `turnAgentFor`） |
| 12 | 模型选择（会话内） | `agent.session.requestHeader()?.config` 读 provider/model/reasoningEffort（adapter-dsh.ts:1092-1107） | `requestHeader(): EpochHeader \| undefined`；`EpochHeader.config: LlmCallConfig`「The conversation's call configuration (provider, model, reasoning effort, and sampling scalars)」 | `[CLI]` `@deepseek-ai/dsh-session/lib/types/index.d.ts:213,225`、`types.d.ts:191-200` | try/catch → `undefined`，回落到 #11；注释「the session face differs per generation」 |
| 13 | 归档集合 / 恢复 | `svc.workspaceRegistry.archivedSessionIds` / `.unarchiveSession(id)` / `.archiveSession(id)`（adapter-dsh.ts:216,683） | `get archivedSessionIds(): readonly SessionId[]`、`archiveSession(id): Promise<void>`；`unarchiveSession` 实现存在于桌面代际、CLI 的 .d.ts 未声明 | `[双/部分]` 见 §4 的逐行取证：`[CLI]` `dsh-workspace/lib/types/index.d.ts:116,124`；`[APP]` `dsh-workspace/lib/types/index.js:260,314`；`unarchiveSession` 在 `[CLI]` `.d.ts` **未取证到** | 全部经 `typeof === 'function'` 探测（:674）；缺 registry 只意味着 `archivedSessions: 0`（:217），列表照常但会把归档会话当正常会话 → 触发 §4 的 blocked |
| 14 | apiProxy 载体的列会话 | `api.sessions.list({})`，再读 `res.sessions ?? []`（adapter-dsh.ts:508-509） | `list(request: RpcRequest<{cursor?}>): Promise<RpcResponse<{items: SessionSummary[]}>>`，`RpcRequest<P>={rpcId,payload:P}`、`RpcResponse<T>={rpcId,result:RpcResult<T>}`；实现 `ok(request,{items: await listVisibleSessionSummaries()})` | `[CLI]` `@deepseek-ai/dsh-host-apiproxy/lib/types/api/sessions.d.ts:228-232`、`api/rpc.d.ts:217-225`、`api-proxy.js:1740-1742` | **形状对不上**：期望 `res.result.items`，旧代码读 `res.sessions` → 恒空。`ctx.apiProxy` 服务名本身真实存在（`dsh-host-apiproxy/lib/types/index.d.ts:25-28` `interface Context { apiProxy: ApiProxy }`），但 desktop 态未注册该服务（HANDOFF.md:94-95），所以这条路径在真机上从未被执行 |
| 15 | apiProxy 载体发指令 | `api.sessions.prompt({requestId, sessionId, mode:'queue', content:[{type:'text',text}]})`（adapter-dsh.ts:726-731） | `prompt(request: RpcRequest<{sessionId, mode:'queue'\|'steer', content: PromptContentPart[], clientTimeZone?}>): Promise<RpcResponse<{accepted:true, command?:{kind:'success',text?}}>>`；实现第一句 `const {sessionId, mode, content, clientTimeZone} = request.payload` | `[CLI]` `api/sessions.d.ts:359-377`、`api-proxy.js:2171-2172` | **传的是平铺对象、没有 `payload` 包装 → 解构 undefined 直接 TypeError**。同上：只在 mock/legacy 态可达 |
| 16 | apiProxy 载体中断 | `api.sessions.cancel({sessionId})`（adapter-dsh.ts:764） | `cancel(request: RpcRequest<{sessionId}>)`，实现 `const {sessionId} = request.payload` 后 `agent.cancel({kind:'user'},{keepInbox:true})`，未 attach 时回 `session-not-found` | `[CLI]` `api-proxy.js:2333-2348` | 同 #15 的包装缺失；`apiProxy.sessions.cancel missing` 时返回文案（:761） |
| 17 | apiProxy 载体应答审批/提问 | `api.respond({type:'client-response', rpcId: token, result:{ok:true, value:{...}}})`（adapter-dsh.ts:782-787,803-807） | `respond(message: ClientResponse): Promise<RpcReceipt>`；`ClientRequest` 判别式 `type:'client-request'`+`rpcId`+`method` 的镜像即 client-response | `[CLI]` `@deepseek-ai/dsh-host-apiproxy/lib/types/api/index.d.ts:34-39`、`api/rpc.d.ts:226-230` | 缺 `respond` → `apiProxy.respond missing`；requestId 不在 `respondables` 里 → `permission request not pending (or from another session)`（:774-775），并**先 delete 再发**，避免重复应答 |
| 18 | typert 载体一元调用 | `gateway.invoke({namespace, method, args, signal})`（adapter-dsh.ts:24,8-9） | `invoke(request: InvokeRemoteRequest): Promise<unknown>`，`InvokeRemoteRequest={namespace,method,args:Readonly<Record<string,unknown>>,signal?}`，注释「fields must exactly match the descriptor」；服务名 `typertGateway`（`@typert service typertGateway`） | `[CLI]` `@deepseek-ai/dsh-api-gateway/lib/types/index.d.ts:33,51`、`types.d.ts:6-14,31` | 列会话/发指令**不走这里**：README 明确「the handler dispatches claimed endpoints to Gateway and unclaimed endpoints to API Proxy」且只有 `TypertRemoteService` + `@Remote` 方法可经 Gateway 调用（`[CLI]` `dsh-api-gateway/README.md:9,13`）；`SessionStore extends Service` 无 `@Remote`（`[CLI]` `dsh-session/lib/types/index.d.ts:290`）→ 所以 typert 拿不到会话（`session/list` 不是注册端点，实测记于 adapter-dsh.ts:296-297） |
| 19 | typert 载体事件流 | `gateway.openWireStream('$events', {args:{}}, signal)`（adapter-dsh.ts:330）；应答走 `$events/result`（:11） | 常量真实存在：`REMOTE_EVENT_STREAM_ENDPOINT = '$events'`、`REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'`；但服务端方法是 `openWireStream(endpoint, payload, uplink, peer, signal, control)`（6 参，`open: (endpoint,payload,uplink,peer,signal) => ...`） | `[APP]` `@deepseek-ai/dsh-api-gateway/lib/types/stream-protocol.js:6,8`、`index.js:62,88,271`；`[CLI]` **未取证到**（rc.6 的 `dsh-api-gateway/lib/types/` 无 stream-protocol，`openWireStream` 零命中） | 无 `openWireStream` → 「typert gateway has no wire stream; approvals via $events unavailable」并继续跑（:324-328）；泵协程异常只记 `typert $events pump ended`（:334-336）。README 自述与此一致：「已知本机 rc.6 的 `typertGateway` 只有 `invoke({namespace,method,args})`，没有流式事件订阅（`$events` 在 0.1.7+/0.2 才有）」（packages/plugin/README.md:87-89） |
| 20 | commands registry | `commands.register({name,description,input:{hint},handler})`（index.ts:536-538） | 见 §6：`register(definition)` 强校验并返回 disposer；handler 收 `{commandId, agent, rawInput, signal}`（`Object.freeze` 的 invocation 对象） | `[双]` `[CLI]` `@deepseek-ai/dsh-commands/lib/types/index.js:115-152,210-217,267-273`；`[APP]` 同路径 `:124-167,228-237,302-326`（行号不同） | `typeof commands?.register !== 'function'` → 静默不注册（index.ts:537）；整段 try（:574-576） |
| 21 | settings 表单策略 | `settings.configure({auto:false}, ctx.fiber)`（index.ts:306） | `SettingsFormsLike{configure(section, fiber?), replace?(entryId, section)}` 是插件自定义的**最小结构声明**，平台侧未逐项取证 | `[无]`（`@deepseek-ai/dsh-settings` 存在于两代产物中，但本次未定位 `configure({auto})` 的权威声明） | 双层 try，非致命（index.ts:307-310） |
| 22 | 服务发现本身 | `ctx.inject([name], cb)` × 每服务一个 + `ctx.get(name, true)`（index.ts:465-479） | cordis `Context.inject/get/provide/effect`，`Events` 的 `DispatchMode = 'emit'\|'parallel'\|'serial'\|'bail'\|'waterfall'` | `[CLI]` `@deepseek-ai/cordis/lib/types/events.d.ts:25,77-79,115,167,224-234` | 每个 inject 包 try（「this composition does not expose that service」）；`sessions` 还要额外验 `.list` 是函数、`sessionQuery` 验 `.listSessions` 是函数才收下（index.ts:470-471）——**收下不合法的对象比不收更糟** |

**载体侧的通用降级纪律**（每一条都对应一次线上排查）：形状不合时**不要静默换
载体**，而是在调用点报「缺哪个成员 + 该服务对象实际有哪些 key」——
`describeService`/`keys=[...]` 就是为此存在（证据：
packages/plugin/src/index.ts:579-600 注释「Shape checks happen at the call site,
where a miss can be reported precisely (which member was missing + what keys the
service actually has) instead of silently degrading to the other carrier」，
packages/plugin/src/adapter-dsh.ts:504,723,753）。

## 4. 归档会话语义（archived-session-gate）

**闸门本体（已从宿主产物取证，不是听说的）**：`archived-session-gate` 是桌面宿主
自带的 cordis service，定义在
`app.asar!/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/archived-session-gate.js:18-22`
（全文 2271 字节；用 `npx asar extract` 或按 asar 头表偏移读取即可复核），
实现只有一行有效逻辑：

```js
name: 'archived-session-gate', inject: ['agents','sessions','workspaceRegistry'],
apply(ctx) { ctx.on('agent/pre-step', (payload, next) =>
  underArchivedSession(ctx, payload.agent) ? Promise.resolve({ kind: 'reject' }) : next()) }
```

即：**拦在 `agent/pre-step`**，返回 `PreStepDecision {kind:'reject'}`（类型定义见
`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:47-51`，只有 `reject` 与
`enter` 两态）。宿主 loop 收到 reject 后「ends as `blocked` **without a request**」
—— 在**任何模型调用之前**结束回合（证据：archived-session-gate.js 头部注释
「A late waking delivery to an archived Session — a subagent settlement, a queued
follow-up — proposes a step the gate rejects, which the loop ends as `blocked`
without a request; unarchiving lifts the gate for the whole lineage.」；loop 侧
`kind: "blocked"` 见 `@deepseek-ai/dsh-agent-loop/lib/index.js:539`）。
**注意**：`agent/pre-step` 本身就在 §2.1 黑名单里——宿主是用「参与者」身份实现
这个闸门的，第三方插件不能照抄这个做法（证据：
`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:233-240` `@mode waterfall`）。

**报错表现**：没有异常、没有错误码、没有任何回显——`turn/end` 带
`reason.kind === 'blocked'` 就结束了（证据：
packages/plugin/src/adapter-dsh.ts:85-89；packages/plugin/src/index.ts:53-57
「the prompt would otherwise vanish into a `blocked` turn」）。从手机端看就是
「发出去没反应」，因此插件必须在**发送之前**自己判断，而不是等宿主报错。

**归档集合的权威来源**：registry 的 getter
`workspaceRegistry.archivedSessionIds`（证据：
`app.asar!/dsh/node_modules/@deepseek-ai/dsh-workspace/lib/types/index.js:260-261`；
CLI 侧 `@deepseek-ai/dsh-workspace/lib/types/index.d.ts:116`
`get archivedSessionIds(): readonly SessionId[]`，注释「The registry-global
archive set: sessions hidden from every grouping surface」）。插件在每次列表时
读它一次并缓存计数（证据：packages/plugin/src/adapter-dsh.ts:214-219）。

**列表标记**：`state` 取值优先级 `archived > running > detached > idle`，注释明确
「`archived` wins over the others: it is the one state that makes a prompt
impossible, and the phone must not have to guess why a turn produced nothing」；
`detached` 指「已持久化但本进程未加载」，仍可打开（内核按需 resume）
（证据：packages/plugin/src/adapter-dsh.ts:552-572，尤其 :564-569）。

**发送前自动恢复**：`sendPrompt` 在 services carrier 下的顺序是硬性的
（证据：packages/plugin/src/adapter-dsh.ts:657-700）：
1. `ctx.agents` 不存在 → 直接失败返回（:660-662）；
2. 命中归档集合 → 若 `unarchiveOnPrompt` 为 false 则拒绝，文案引导用户去
   「设置 → 已归档会话」手动恢复（:666-672）；
3. 组件里没有 `unarchiveSession` → 拒绝并说明「this composition exposes no
   unarchiveSession」（:674-681）；
4. 调 `await reg.unarchiveSession(sessionId)`，成功记入 `restoredIds` 再发消息
   （:682-685）；抛错则把原始 message 回传给手机（:686-691）；
5. 之后才检查 subagent 子会话（:693-700）与解析 agent。
WHY 顺序如此：恢复动作本身可能失败，必须比「起一个注定 blocked 的 turn」更早决定。

`unarchiveSession` 取证结果：桌面代际
`@deepseek-ai/dsh-workspace/lib/types/index.js:314` 有实现（:319 对未归档 id 直接
返回，**幂等**；:284/:319/:348 显示 archive/unarchive/delete 三段共享临界区）。CLI
rc.6 代际的 `@deepseek-ai/dsh-workspace/lib/types/index.d.ts` **只声明了
`archiveSession`（:124），未声明 `unarchiveSession`**——第三方 bundle
`@chaoset/session-archive@0.3.24` 的 `lib/index.js:349` 却直接
`await registry.unarchiveSession(sessionId)`，并在注释里称其为「官方 API
unarchiveSession…不做存在性检查、幂等」（:40-41,327）。结论：该符号在桌面宿主存在、
在 CLI rc.6 声明文件中未取证到，属代际差异，新实现必须继续做 typeof 探测。

**`unarchiveOnPrompt` 默认值**：`true`（证据：
packages/plugin/src/index.ts:89；桥侧判定是 `opts.unarchiveOnPrompt !== false`，
即 undefined 也按开处理，packages/plugin/src/adapter-dsh.ts:211）。设计理由写在
packages/plugin/src/adapter-dsh.ts:164-169：「Sending a prompt IS the explicit
"I want to use this session" action, and the alternative is a `blocked` turn that
looks like a bug. Set false to refuse instead.」被否决的方案是默认拒绝（旧行为），
因为它把宿主的一个正常状态变成了手机端的「点了没反应」bug。

`restoredIds` / `archivedCount` 会进 status.json（`services.restoredByUs` /
`services.archivedSessions`），用来回答「插件到底动了哪几个会话」（证据：
packages/plugin/src/adapter-dsh.ts:259-261）。

回归测试护栏：`packages/plugin/tests/listing.test.ts:349` 起的用例模拟宿主的
archived-session-gate 拒绝每个 step。

## 5. 配置项清单与 status.json

### 5.1 配置项：键名、默认值、校验规则

优先级：**环境变量 > patch 里注入的 config > DEFAULT_CONFIG**（证据：
packages/plugin/README.md:41；合成顺序见
packages/plugin/src/index.ts:248-258——先 spread DEFAULT，再 spread `injected`，
`keepAwake` 单独浅合并做深兜底，最后逐条覆盖 env）。

| 键 | 环境变量 | 默认值 | 校验 / 语义 |
|---|---|---|---|
| `enabled` | — | `true` | false 时 `applyInner` 第一句就 return，连校验都不做（证据：index.ts:272-273） |
| `serverUrl` | `DRC_SERVER_URL` | `ws://127.0.0.1:8787` | 必须 `/^wss?:\/\/.+/`，否则 **error**（阻断本插件）；是 `ws://` 且 host 非 `localhost`/`127.0.0.1`/`[::1]` → **warn**「plaintext ws:// to a non-loopback host」（证据：index.ts:200-216） |
| `hostToken` | 由 `hostTokenEnv` 指定名（默认 `DRC_HOST_TOKEN`） | `''` | 空 → **error**；长度 <24 → **warn**，提示 `openssl rand -hex 24`（证据：index.ts:217-229）。永远不进 status.json，日志里只出 `redact()` 形态：≤8 字符打 `****`，否则前 4 + `…` + 后 2 + 长度（证据：index.ts:181-184；测试 packages/plugin/tests/apply.test.ts:212 断言 `status.hostToken === undefined`） |
| `hostTokenEnv` | — | `DRC_HOST_TOKEN` | 可改指向别的变量名；置空字符串则不读 env（证据：index.ts:255） |
| `hostLabel` | `DRC_HOST_LABEL` | `dsh-host` | 无校验；配对方显示名（证据：README.md:48） |
| `keepAwake.enabled` | — | `true` | 传给 runtime（证据：index.ts:343-348） |
| `keepAwake.idleReleaseSec` | — | `300` | 非有限数或 <0 → **warn** 并在激活前**夹回 300**，注释「clamp so KeepAwake never sees NaN」（证据：index.ts:237-244,294-297）。`0` 合法，含义是「一直持有」 |
| `keepAwake.keepDisplay` | — | `false` | 是否连屏幕也不睡 |
| `mockBridge` | — | `false` | 强制内存桥；同时会进 status.json 的 `mockBridgeForced` |
| `statusFile` | — | `~/.dsh/dsh-remote-control/status.json` | 空字符串**关闭**整个快照功能（`if (!file) return`）（证据：index.ts:88,109） |
| `unarchiveOnPrompt` | — | `true` | 见 §4 |
| `pairOnStartSec` | `DRC_PAIR_ON_START_SEC` | `0`（关） | >0 会 **warn**：「a live pairing code (with its PSK) will be published in status.json」。设计定位是**验证辅助**，让 `pnpm test` / `scripts/verify-deployment.mjs` 无需人肉打 `/drc pair` 就能跑真端到端（证据：index.ts:60-65,90,230-236） |
| `qrImage` | `DRC_QR_IMAGE`（`'0'` 关闭） | `true` | 见 §6 |
| `qrOpen` | `DRC_QR_OPEN`（`'0'` 关闭） | `true` | 见 §6 |
| `qrStyle` | `DRC_QR_STYLE` | `'ascii'` | 枚举白名单 `ascii|block|half`，非法值回落 `ascii`（证据：index.ts:93-97）。仅在 PNG 写不出来时用 |

patch 层实际注入的键是收敛的：`enabled / serverUrl / hostTokenEnv / hostLabel /
keepAwake.{enabled,idleReleaseSec,keepDisplay}`，**故意不含 `hostToken`**，让令牌
只能来自环境变量（证据：packages/plugin/cordis.patch.yml:7-16）。
`pairOnStartSec / qr* / statusFile / unarchiveOnPrompt` 都不写进 patch，用默认值。

**仓库模板与线上实态已经分叉（重写时要按哪一份对齐，需要拍板）**：真实生效的
`~/.dsh/profiles/desktop/cordis.patch.yml:72-85` 里除了模板那几项，还多写了
`hostToken: <redacted>`（值不外抄）与 `pairOnStartSec: 60`（注释自述「验证用……
验完就删掉」，但一直留在线上），`serverUrl` 已换成 `wss://` 公网地址。该文件本身
权限 0600（`-rw-------`）。后果：`validateConfig` 的
`pairOnStartSec>0 ⇒ warn + 把带 PSK 的配对码发布进 status.json` 这条兜底在生产
环境上是**持续生效**的，而不是只在测试里（证据：
`~/.dsh/profiles/desktop/cordis.patch.yml:77,81`；index.ts:60-64,230-236）。

校验哲学（WHY）：注释「Only genuinely unusable settings block startup — a
short-but-present token or a plaintext loopback URL is reported and allowed」
（证据：index.ts:193-197）。`error` 只停**本插件**、不停 Harness（:279-280）。
被否决方案：任何配置问题都硬失败——会让「忘了配 token」变成插件从系统里消失。

测试对照表（`validateConfig` 的 6 条等价断言，重写时必须逐条保持）：默认配置恰好
只有 `hostToken:error`；好配置零问题；短 token 只 `warn`；`http://` 是 `error`；
`ws://` 远端是 `warn`；`idleReleaseSec: NaN` 被报（证据：
packages/plugin/tests/apply.test.ts:136-171）。

### 5.2 缺服务时的激活降级行为

- 有 error 级问题：**不启动 runtime**，但**仍写一次 status.json**，`carrier: 'none'`
  + `relay: 'idle'` + `reason: 'invalid-config'` + `problems[]`（证据：
  index.ts:281-293）。注释说明动机：「leave a breadcrumb: otherwise "why is nothing
  happening?" has no answer」。测试锁死了这三字段（证据：
  packages/plugin/tests/apply.test.ts:216-234）。
- 只有 token 缺失（第二道检查，:316-322）：额外再 warn 一句并 return。
- 一个 carrier 都探测不到且 `mockBridge: true` → mock 启动，`carrier: 'mock'`
  （证据：index.ts:507-511；测试 apply.test.ts:201-214 断言
  `status.carrier === 'mock'`）。
- 只有 typert → 宽限期后才起，且 warn 一次「Expect an empty session list」（证据：
  index.ts:368-372；测试 apply.test.ts:108-134 用 `DRC_CARRIER_GRACE_MS=10` 验证
  「must NOT start on typert eagerly」→ 60ms 后 `createPairing()` 才有值）。
- 宿主 ctx 完全敌意（`get/inject/provide/effect` 全抛）→ `apply()` 不抛
  （证据：测试 apply.test.ts:173-190）。
- `inject` 不可用（`injectFails`）也不阻塞：测试用 `injectFails: ['sessions',
  'typertGateway', 'apiProxy', 'settings']` 走 mock 分支（证据：
  apply.test.ts:72-81）。
- 提供物始终存在：`ctx.provide('dshRemoteControl', ...)` 无条件执行，runtime 为
  null 时 `state` getter 返回 `{relay:'offline'}`、`createPairing()` 返回 `null`
  ——测试注释明确「`provide` happens unconditionally, so probe the runtime itself:
  createPairing() returns null until a runtime exists」（证据：
  index.ts:513-524；apply.test.ts:124-128）。
- rc.1+ settings 页策略：`settings.configure({auto:false}, fiber)` 关掉自动生成的
  表单（插件自带状态卡），feature-detect，老代际直接跳过（证据：
  index.ts:299-314）。

### 5.3 status.json 字段含义与刷新时机

**为什么需要这个文件**：「The Harness is usually a GUI app whose stdout nobody can
read, so "is the plugin up, and is it talking to the real kernel?" has to be
answerable from the filesystem. `carrier` is the answer to the second half」
（证据：index.ts:100-107）。

写法：`mkdir -p` 目录 → 写 `<file>.tmp`（mode 0600）→ `renameSync` 原子替换，
注释「atomic: readers never see a half-written file」；整体 try/catch 吞异常
（证据：index.ts:124-130）。

顶层字段（固定 6 个 + 展开的 state + 可选 `pairing` + `probe`）：
`updatedAt`(ISO) / `pid` / `carrier` / `serverUrl` / `hostLabel` /
`mockBridgeForced`（证据：index.ts:111-120）。

`carrier` 取值 `services|apiproxy|typert|mock|none`（证据：
adapter-dsh.ts:301-305 + index.ts:364,287）。日志与注释同义：`apiproxy`/`typert`
= 真内核（并区分是哪张脸），`mock` = 内存替身，会话是假的（证据：
index.ts:362-363；README.md:84-85「看到 `mock` 说明内核没挂上」）。

`...state` 展开自 `runtime.state`，本机现值（真机 desktop 态，实测
`~/.dsh/dsh-remote-control/status.json`）：`relay`（连接状态机）、`hostId`、
`clients`（已连客户端数）、`sessions`（会话数）、`keepAwake{enabled,active,
platform,backend}`、`relayProblem`。

`bridge`（= `DshKernelBridge.describe()`，证据：adapter-dsh.ts:233-279）：
`carrier`、`lastError`、`events{<事件名>: 次数}`、`eventSamples{<事件名>: 截断样本}`、
`services{keys, hasSessionsList, hasAgents, hasResume, hasDefaultModel,
hasSessionQuery, hiddenSubagents, resumedByUs, archivedSessions, restoredByUs,
hasWorkspaceRegistry, defaultSelection, hasTitleSnapshots, listingSource}`、
`apiProxy{...}`、`typertGateway{keys, hasWireStream}`。这张「有没有某方法」的表
就是排障答案本身——注释「Shape probe for status.json. When a kernel face is
present but not the shape we expect, "missing member" beats a silent empty list」
（:229-232）。

`pairing{token, qr, createdAt, expiresAt, generation}`：**只在
`pairOnStartSec > 0` 时出现**（默认不出现）。含 PSK，所以是 0600 文件里的敏感项
（证据：index.ts:58-64,411-413）。三个非显然规则（证据：index.ts:380-415）：
1. 有效期以**中继**给的 `runtime.pairingTtlMs` 为准，不是本地请求值，否则会广告
   中继已扫掉的码；
2. `generation` 变了（中继重启清空 pendingPairs）即视为失效，即使 TTL 未满；
3. 半衰期就刷新（`expiresAt < now + ttl/2`），并只在
   `runtime.state.relay === 'online'` 时发布（连接中发 pair-begin 会被丢）。

`probe`（`probeContext(ctx)`，证据：index.ts:602-653）：`visibleServices`（把
ctx 自身与 `ctx.fiber` 的 own+enumerable 属性名并集，去掉 `_` 前缀和
`constructor/fiber/scope/root/ctx`，截 120 项）+ `present`（对 15 个感兴趣的
服务名逐个 `ctx.get(name, true)` 记 typeof）。动机写在注释里：「Every wrong guess
about the kernel API has cost a Harness restart, so we record what is actually
there instead of guessing again」。列表里 `workspaceRegistry` 被写了两次
（:632,637），无害但是旧代码指纹。

**刷新时机：固定 3 秒定时器，不按消费刷新**（证据：
index.ts:417-420 `snap(); setInterval(snap, 3_000)`，`unref()` +
`ctx.effect(() => () => clearInterval(...))` 负责回收）。这条有外部后果：
「配对码一次性；`status.json` 按定时器刷新、不按消费刷新——live-e2e 因此只接受
新发布（age<25s）且本轮未用过的码」（证据：HANDOFF.md:120-121）。任何读
status.json 做测试的脚本都必须按「文件可能已经旧了 3 秒」来写断言。

## 6. `/drc pair` 命令注册与「纯文本命令 API → 真实 PNG」约束

**注册方式**：`ctx.inject(['commands'], c => { const commands = c.get('commands', true);
if (typeof commands?.register !== 'function') return; commands.register({...}) })`，
整段包 try/catch，缺 registry 时静默跳过（证据：
packages/plugin/src/index.ts:526-576）。注册体：
`{ name: 'drc', description: 'DSH Remote Control: 查看状态 / 生成配对码',
input: { hint: '[status | pair [ttlSec] [--with-token]]' }, handler }`。
注释直接写明了它对照过的平台 API：`register({name, description, input?:{hint},
recordInput?, handler})`，handler 收到
`{commandId, agent, rawInput, signal}`，`rawInput` 是命令名**之后**的文本
（`"/drc pair 300"` → `" pair 300"`），返回
`{kind:'success', text?} | {kind:'error', text}`（证据：
packages/plugin/src/index.ts:528-534）。

**这些字段形状在平台产物里逐条对得上**（`@deepseek-ai/dsh-commands`；
`[CLI]` = `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/
@deepseek-ai/dsh-commands/lib/types/index.js`（0.1.0-rc.6），
`[APP]` = `app.asar!/dsh/node_modules/@deepseek-ai/dsh-commands/lib/types/index.js`
（0.2.0-rc.2）——**两代行号不同，下面并列给出**）：
- `register(definition)` → `normalizeDefinition` 强校验：`name` 必须匹配
  `COMMAND_NAME`、`description` 必须是非空字符串、`handler` 必须是函数、
  `input` 若给则必须是带字符串 `hint` 的对象且 `hint.trim()` 非空，另接受布尔
  `attachments`（证据：`[CLI] :115-152`；`[APP] :124-153`）；`recordInput` 原样
  透传（`[CLI] :144`；`[APP] :160`）。返回值是「卸载该定义的 effect disposer」
  （`[CLI] :210-217`；`[APP] :228-237`），旧插件丢弃它=命令常驻，符合预期。
- `rawInput = line.slice(match[0].length)`，即命令名之后的原文
  （`[CLI] :76`；`[APP] :81`）；`execute(...)` 会 `mintCommandId()` 并把
  `args: parsed.rawInput` 记进 `command/run` 生命周期事件
  （`[CLI] :257,267-272`；`[APP] :302-316`）——这解释了为什么 `--with-token` 这类开关
  只能靠 handler 自己解析。**handler 入参形状的直接佐证**：
  `const invocation = Object.freeze({ commandId, agent, rawInput: parsed.rawInput, signal })`
  （`[CLI] :273`），与旧注释「handler receives `{commandId, agent, rawInput, signal}`」
  完全一致（对照 packages/plugin/src/index.ts:530-533）。**代际差异**：`[CLI] execute(agent, line, signal)` 没有
  附件参数，`[APP] execute(agent, line, submittedAttachments, signal)` 才有
  （对应 `input.attachments`），说明附件式命令入参是桌面代际新增能力。
- **`/drc` 必须 feature-detect 的原因**：`commands` registry 只在装有
  `@deepseek-ai/dsh-commands` 的 profile（desktop/web/TUI）里是真服务（证据：
  packages/plugin/src/index.ts:527-528 注释）。

**「命令 API 只支持纯文本」的出处（两处，互相印证）**：
1. 旧代码自述：「The slash-command API can only settle `{ kind, text }` — there is
   no image result type — but the plugin runs on the host, so it can emit an actual
   image file instead of fighting whatever the TUI does to block characters」
   （证据：packages/plugin/src/index.ts:66-73；函数头注释 :134-141）。
2. 平台独立佐证（更强）：`normalizeResult(command, value)` 只接受
   `kind === 'success'`（可选 `text: string`、可选 `sourceEventSeq`）或
   `kind === 'error'`（必须非空 `text: string`），任何其他 `kind` 直接
   `throw new TypeError(...returned unknown result kind...)`，且 `text` 非字符串
   也抛（证据：`[CLI]` `dsh-commands/lib/types/index.js:155-183`；`[APP]`
   `dsh-commands/lib/types/index.js:172-200`）。
   `command/done` 帧也只带 `text`（`[CLI] :266-278`；`[APP] :318-325`）。
   **结论：图片结果类型在协议层就不存在，返回多余字段会被 freeze/丢掉，
   不会变成附件。**

**因此旧实现的做法**：把真 PNG 写到 status.json 同目录的 `pairing-qr.png`
（0600，`mkdir -p` 后 `writeFileSync`），再用 OS 默认查看器打开——
darwin `open` / win32 `start` / 其他 `xdg-open`，`spawn(..., {stdio:'ignore',
detached:true}).unref()` 发后即忘，打开失败只影响文案（证据：
packages/plugin/src/index.ts:153-171）。WHY 不用终端字符二维码：「block characters
in a TUI depend on the font, the glyph set and whether ANSI is interpreted at all,
and any of those going wrong turns the symbol into unscannable noise」（:136-141）。
兜底路径保留：`renderTerminalQr(qr, {style: cfg.qrStyle})`，仅当 PNG 写不出来时
（:172-178）。

**默认内嵌配对码**：`/drc pair` 默认 `includeToken: true`，扫码即连不需要再打字；
理由是码一次性、短寿命、二维码只出现在宿主自己屏幕上；`--no-token` 退回裸 payload
（证据：packages/plugin/src/index.ts:546-552）。默认 TTL 120s，可跟一个纯数字参数
覆盖（:551-552）。子命令：无参/`status` → `JSON.stringify(runtime.state)`，
`help` → 固定用法表，`pair` → 上述流程；runtime 未启动时返回
`{kind:'error', text:'runtime 未启动：检查 hostToken 配置与中继地址'}`（:553-570）。

## 7. 新实现必须满足的条款汇总（MUST / MUST NOT）

### 7.1 MUST

| # | 条款 | 锚点 |
|---|---|---|
| M1 | `apply(ctx, injected)` 外层必须 `try/catch` 吞掉 `applyInner` 的一切异常，只 warn | §2.2（证据：index.ts:261-269；测试 apply.test.ts:173-190） |
| M2 | 每一次 `ctx.inject` / `ctx.get` / `ctx.provide` / `ctx.effect` / `settings.configure` / `commands.register` 都必须各自软探测，缺服务只少一个能力 | §2.2、§5.2（证据：index.ts:301-314,465-495,513-524,534-576） |
| M3 | `cordis.patch.yml` 的 entry 行**不得写 `inject:`**，激活门控全部放在 `apply()` 内部 | §2.3（证据：cordis.patch.yml:2-3；HANDOFF.md:107-108） |
| M4 | carrier 裁决顺序必须是 `services > apiProxy > typert`；**只有 apiProxy 或 services 落地才允许立即启动**，typert 必须等宽限期（默认 5s，env `DRC_CARRIER_GRACE_MS` 可调） | §2.4（证据：index.ts:437-441,497-505；adapter-dsh.ts:301-305；测试 apply.test.ts:108-134） |
| M5 | 5 个平台服务（`sessions/agents/agentDefaultModel/sessionQuery/workspaceRegistry`）各自独立 inject 收集，晚到者热补丁进桥已持有的同一对象；收下列表服务前必须验 `.list` / `.listSessions` 是函数 | §2.4（证据：index.ts:443-479） |
| M6 | mock 桥的判定依据是「有没有 carrier」，不是「注册过 inject」；`mockBridge` 必须同时可强制开启 | §2.4（证据：index.ts:332-334,507-511；测试 apply.test.ts:201-214） |
| M7 | 事件订阅必须走 **emit-mode 白名单**：`session/event`、`session/created`、`agent/status`、`agent/error` 已证实为 emit；黑名单命中即拒绝订阅并打日志 | §2.1、§3#9（证据：adapter-dsh.ts:130-154,853-891；remote-events.js:12-40；listing.test.ts:278-300） |
| M8 | 13 项 waterfall 名单必须原样保留在代码里（作为纵深防御的第二层），且必须有断言证明 `agent/request` 与 `agent/pre-step` 在名单内 | §2.1（证据：adapter-dsh.ts:140-154；listing.test.ts:299-300） |
| M9 | 中断必须改用 `agent.cancel({kind:'user'}, {keepInbox:true})`；`abort/interrupt` 在平台两代产物里都不存在 | §3#8（证据：runtime-types.d.ts:80；api-proxy.js:2333-2348） |
| M10 | apiProxy 载体所有调用必须包成 `{rpcId, payload}` 信封并按 `{rpcId, result:{ok,value}}` 解包（列表读 `result.items`） | §3#14-16（证据：api/rpc.d.ts:197-230；api/sessions.d.ts:228-232,365-377；api-proxy.js:228,1740-1742,2171-2172,2333-2348） |
| M11 | 发指令前必须查 `workspaceRegistry.archivedSessionIds`；`unarchiveOnPrompt` 默认 true，恢复动作在 subagent 围栏与 agent 解析**之前**完成；`unarchiveSession` 必须 typeof 探测 | §4（证据：adapter-dsh.ts:657-700,211；index.ts:89；dsh-workspace/lib/types/index.js:314 [APP]） |
| M12 | 无模型时必须**主动拒绝并给出人话**，不得让 turn 进宿主的 `reading 'provider'` 崩溃路径 | §2.1、§3#11（证据：adapter-dsh.ts:1117-1121,1145-1153；agent-loop/lib/index.js:685-691） |
| M13 | subagent 子会话不得出现在列表里，但必须计数（`hiddenSubagents`） | §3#1、§4（证据：adapter-dsh.ts:538-548,693-700,259） |
| M14 | 标题读取必须有超时 + 缓存 + 上限，且失败不影响列表 | §3#3（证据：adapter-dsh.ts:158-160,625-655） |
| M15 | `status.json` 必须原子写（tmp+rename, 0600）、由 3s 定时器刷新、写失败吞异常，并至少含 `carrier` / `probe` / `bridge.services` 形状表；配置非法时也要落一份 `carrier:'none' + reason:'invalid-config'` | §5.3（证据：index.ts:108-131,281-293,411-420；测试 apply.test.ts:216-234） |
| M16 | `hostToken` 绝不可出现在 status.json 或日志中，只允许 `redact()` 形态 | §5.1（证据：index.ts:181-184；测试 apply.test.ts:212） |
| M17 | `pairOnStartSec` 默认 0；启用时必须中继权威 TTL、检测 `relayGeneration` 变更、半衰期预刷、仅在 `relay==='online'` 时发布 | §5.3（证据：index.ts:380-415；HANDOFF.md:114-121） |
| M18 | `/drc pair` 主输出必须是真实 PNG 文件 + OS 默认查看器打开；文本二维码只在 PNG 写失败时兜底；命令返回只能是 `{kind:'success',text}` / `{kind:'error',text}` | §6（证据：index.ts:142-179,538-572；dsh-commands/lib/types/index.js `[CLI] :155-183` / `[APP] :172-200`） |
| M19 | `ctx.provide('dshRemoteControl', …)` 必须无条件提供，runtime 未起时 `state={relay:'offline'}`、`createPairing()` 返回 `null` | §5.2（证据：index.ts:513-524；测试 apply.test.ts:124-128） |
| M20 | 平台类型一律松结构（不 import cordis / dsh 类型）；`createUserMessage` 只能运行时动态 import 并留朴素对象兜底 | §1、§3#7（证据：index.ts:22-35；adapter-dsh.ts:22,1020-1036） |

### 7.2 MUST NOT

| # | 禁令 | 锚点 |
| --- |---|---|
| N1 | MUST NOT 用 `ctx.on` 订阅任何 §2.1 名单内的事件——哪怕只是「打个点」 | §2.1（证据：HANDOFF.md:90-93；adapter-dsh.ts:839-851；agent-loop/lib/index.js:685-691） |
| N2 | MUST NOT 把名单当完备清单：`approval/request`、`llm/stream`、`system-prompt/assemble`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/code-dispatch-log`、`internal/config`、`internal/update` 同样是 waterfall，却不在名单里 | §2.1（证据：remote-events.js:14,39；`@mode waterfall` 声明扫出的其余项；dsh-fs/lib/types/index.d.ts:28,36；cordis/lib/types/events.d.ts:224-233） |
| N3 | MUST NOT 让任何配置错误或内核探测失败影响 Harness 启动；`error` 只停本插件 | §2.2、§5.1（证据：index.ts:193-197,279-293） |
| N4 | MUST NOT 在 `cordis.patch.yml` 写 `inject:`（会导致整行不激活、插件静默消失） | §2.3（证据：cordis.patch.yml:2-3） |
| N5 | MUST NOT 因为 typert 先出现在 inject 竞态里就启动——那会把后到的 apiProxy 永久锁在门外（历史事故：有 apiProxy 的 profile 跑出 `carrier=typert`） | §2.4（证据：index.ts:433-436,423-431） |
| N6 | MUST NOT 用 `gateway.invoke` 去列会话/发指令：`SessionStore` 是 plain `Service`、无 `@Remote`，`session/list` 不是注册端点，只会拿到静默空列表 | §2.4、§3#18（证据：dsh-api-gateway/README.md:9,13；dsh-session/lib/types/index.d.ts:290；adapter-dsh.ts:289-299） |
| N7 | MUST NOT 依赖 `$events` / `openWireStream` 存在于所有代际——CLI rc.6 完全没有该符号；参数元数也不固定（桌面是 6 参服务端形状） | §3#19（证据：rc.6 `dsh-api-gateway/lib/types/` 无 stream-protocol；asar `index.js:62,271`；adapter-dsh.ts:26-27） |
| N8 | MUST NOT 调用 `agent.abort()` / `agent.interrupt()`（两代产物均未取证到，等于永远走「cannot be interrupted」） | §3#8 |
| N9 | MUST NOT 向 `apiProxy.sessions.*` 传平铺参数或读 `res.sessions`（正确为 `{rpcId,payload}` 入、`res.result.items` 出） | §3#14-16 |
| N10 | MUST NOT 订阅 `permission/requested` / `question/requested` 当作本地事件（全树零命中，含 asar）——需另找真实通道 | §3#9b |
| N11 | MUST NOT 对归档会话直接发消息；也 MUST NOT 让恢复失败静默（必须把原因回给手机） | §4（证据：adapter-dsh.ts:666-691） |
| N12 | MUST NOT 让 `/drc` 返回图片或任何非 `{kind,text}` 结构（协议层 `normalizeResult` 会抛 `TypeError`，`[CLI]` :155-183 / `[APP]` :172-200），也 MUST NOT 依赖终端 block 字符渲染二维码 | §6（证据：dsh-commands/lib/types/index.js `[CLI] :155-183` / `[APP] :172-200`；index.ts:136-141） |
| N13 | MUST NOT 把 `hostToken` 写进 patch 文件（只允许 env 注入）；也 MUST NOT 把它落进 status.json/日志 | §5.1（证据：cordis.patch.yml:7-16；apply.test.ts:212） |
| N14 | MUST NOT 假设 status.json 是「刚被消费就更新」的——它是 3s 定时快照，读它的测试必须只接受新鲜（age<25s）且未用过的配对码 | §5.3（证据：HANDOFF.md:120-121） |
| N15 | MUST NOT 在形状不合时静默切换 carrier；必须报出「缺哪个成员 + 实际 keys」 | §3 末（证据：index.ts:579-590；adapter-dsh.ts:504,723,753） |
| N16 | MUST NOT 把 subagent 子会话暴露给手机（宿主不转交所有权，发过去就是 blocked） | §3#1、§4（证据：adapter-dsh.ts:538-548,693-700） |
