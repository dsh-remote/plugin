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
| 防休眠 | `keepAwake.{enabled,idleReleaseSec,keepDisplay}` | macOS `caffeinate` 类持锁；`HostRuntime` 内部持有，disposal 时释放（证据：packages/plugin/src/index.ts:9-10,343-350） |
| 配对二维码 | `/drc pair [ttlSec] [--with-token/--no-token]` | 真实 PNG 文件 `pairing-qr.png` + `open` 唤起 + 纯文本回复 | （证据：packages/plugin/src/index.ts:142-179,538-572） |
| 状态快照 | `runtime.state` + `activePair` + `probeContext(ctx)` | 0600 原子写的 `status.json` | （证据：packages/plugin/src/index.ts:108-131,380-420） |

边界要点（WHY）：

- **插件不做 UI**：只 `ctx.provide?.('dshRemoteControl', {state, createPairing, stop})` 暴露一个只读句柄给未来的 UI slice 或其他插件；`provide` 不支持时静默忽略（证据：packages/plugin/src/index.ts:301 注释,513-524）。
- **插件不猜平台类型**：全程用 `LooseContext` 松结构类型，构建期**不 import** cordis 类型，避免 cordis 版本升级即编译失败（证据：packages/plugin/src/index.ts:26-35；packages/plugin/src/adapter-dsh.ts:22）。
- **插件不阻塞启动**：所有能力都是「有则用、无则降级」，具体见 §2。
- **配置来源两条**：entry 的 volatile Cordis Config（由 patch 层注入 `injected`）+ 环境变量覆盖 `DRC_SERVER_URL` / `DRC_HOST_TOKEN` / `DRC_HOST_LABEL`（后者优先级高于注入值）（证据：packages/plugin/src/index.ts:12-14,248-259）。

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
`session/event`、`permission/requested`、`question/requested`（证据：
packages/plugin/src/adapter-dsh.ts:843-869 的订阅循环，命中黑名单即跳过并记日志）。

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

（待填）

## 4. 归档会话语义（archived-session-gate）

（待填）

## 5. 配置项清单与 status.json

### 5.1 配置项：键名、默认值、校验规则

（待填）

### 5.2 缺服务时的激活降级行为

（待填）

### 5.3 status.json 字段含义与刷新时机

（待填）

## 6. `/drc pair` 命令注册与「纯文本命令 API → 真实 PNG」约束

（待填）

## 7. 新实现必须满足的条款汇总（MUST / MUST NOT）

### 7.1 MUST

（待填）

### 7.2 MUST NOT

（待填）
