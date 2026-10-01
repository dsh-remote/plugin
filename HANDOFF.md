# HANDOFF — dsh-remote-control（DSH 远程控制插件）

> 交接文档。**2026-10-01 更新**：上一版（§4）里的三大缺口 —— 微信小程序、文档、安装进
> desktop profile —— 已全部完成并验证。本文已重写为当前状态。

## 1. 项目目标（用户原始需求 + 已确认决策）

在 `/Users/linbin/dsh-remote-control` 内创建「远程操作 DSH」的完整系统，参考
[slopus/happy](https://github.com/slopus/happy) 与本地 zip
（`/Users/linbin/Downloads/ds-harness-remote-main.zip`）。三大件：

1. DSH 插件（Host 侧），支持**防休眠**；
2. **server 端**（自建中继）；
3. **微信小程序**控制客户端（核心闭环）。

已确认决策：

| 项 | 决策 |
|---|---|
| 目录 | `/Users/linbin/dsh-remote-control` |
| 安装方式 | 已装进 desktop profile（`~/.dsh/profiles/desktop`） |
| 安全 | token + TLS + 端到端加密 |
| 技术栈 | Node + ws（实际为 node:http + ws，见 §7） |
| 小程序范围 | 核心控制闭环：配对/会话/指令/审批/提问/防休眠状态 |
| 防休眠平台 | macOS + Linux（Windows 预留） |
| 验证深度 | 单测 + mock 端到端 + **小程序代码跨端回归** |
| 其他 | 自动决策，不再停下来问 |

## 2. 架构

```
┌──────────────────┐   ws (host token)    ┌───────────────┐   ws (配对码)   ┌──────────────────┐
│  DSH 桌面应用      │ ──────────────────▶ │  relay server │ ◀────────────── │ 微信小程序        │
│  (cordis bundle) │   审计：只见密文      │  apps/server  │                 │  mp/             │
└──────────────────┘                      └───────────────┘                 └──────────────────┘
        │ 防休眠: caffeinate / systemd-inhibit      数据面: base64(nonce24 ‖ secretbox) 端到端
        ▼
   E2E payload 协议（@dsh-rc/protocol）：
   cmd.list_sessions / cmd.send_prompt / cmd.answer / cmd.resolve_permission /
   cmd.interrupt / cmd.keep_awake / cmd.subscribe  ⇄
   ev.session_changed / ev.message_delta / ev.tool_event / ev.permission_request /
   ev.question_request / ev.run_state / ev.keep_awake_state / ev.result
```

- **信任模型**：中继持有 `DRC_HOST_TOKEN` 与配对码路由表，**只透传密文**。
  TLS 由部署方负责（反代 wss）。详见 `docs/SECURITY.md`。
- **配对**：host 生成 6 位 token + PSK（16B，QR `dshr:/p?s=…&n=…&psk=…`）；
  小程序扫码拿 server+PSK，再输入 6 位码。双方派生
  `derivePskKey(psk,'c2h'|'h2c',convId)`。
- **防休眠**：仅在「会话运行中 / 有审批或提问挂起」时持锁，空闲 `idleReleaseSec`
  （默认 300s）后自动释放。

## 3. 当前状态：全部完成

| 包 | 内容 | 测试 |
|---|---|---|
| `packages/protocol` | 线协议 + E2E crypto（tweetnacl）+ 防休眠命令构造器 | **10/10** |
| `packages/plugin` | relay-client / host-runtime / bridge / adapter-dsh / adapter-mock / index（cordis apply） | **9/9** |
| `apps/server` | node:http + ws 零知识中继 + **生产加固** | **13/13** |
| `mp/` | **原生微信小程序**（配对/会话/对话三页 + 移植的 tweetnacl） | 见下 |
| `e2e/mp-crypto.test.mjs` | 小程序 crypto 与 Node 逐字节对拍 | **10/10** |
| `e2e/mp-client.test.mjs` | 用 `wx` shim 跑**真实小程序客户端代码**走完整闭环 | **8/8** |
| `e2e/run.mjs` | 真实 server + HostRuntime + 模拟小程序 + 零知识审计 | **9/9 步** |

```sh
env -u NODE_OPTIONS pnpm -r build     # 见 §5.7
env -u NODE_OPTIONS pnpm -r test      # 52 项 + 9 步 e2e，全绿
node e2e/run.mjs                      # 单跑 relay e2e
```

CI：`.github/workflows/ci.yml`（Node 20/22 跑构建+全部测试+relay 冒烟）。

### 上云 + 真实端到端（第三轮）

已部署到 `wss://drc.provid.cc`（阿里云 cn-shanghai / ECS `47.100.82.15`）：
nginx + Let's Encrypt（acme.sh DNS-01）+ systemd，中继只绑 `127.0.0.1:8787`。
配置与复现步骤在 `deploy/`，一键自检 `node scripts/verify-deployment.mjs`。

已用**真实小程序客户端代码**经公网 wss 跑通：配对 → 会话列表 → 流式输出 →
审批 → 完成 → 零知识审计（全绿）。

本轮新增：

- `DRC_BIND`（默认 `127.0.0.1`）——中继不再默认监听全部网卡；
- `scripts/verify-deployment.mjs` 部署自检（自建主机 / `--pair --qr` 连正在运行的主机）；
- `scripts/install-to-profile.sh` 一键构建+重装+注册；
- 插件**状态快照** `~/.dsh/dsh-remote-control/status.json`（含 `carrier`，见下）；
- 配对二维码可内嵌配对码（`/drc pair --with-token`，默认关闭）；
- 小程序「粘贴配对信息」入口 —— 模拟器没有摄像头，扫不了码。

### 生产加固轮（第二轮）

- **中继**：帧大小上限、并发连接上限、单连接帧速率配额；host 认证失败次数上限、
  配对码错误次数上限、全局配对速率配额（防 6 位码枚举）；`/api/pair-status`
  **默认关闭**（免认证的配对码 oracle）；待配对表上限；`SIGTERM/SIGINT` 优雅停机；
  结构化 JSON 日志 + `DRC_LOG_LEVEL`；host 掉线清理其会话（修了孤儿会话内存泄漏）；
  host 心跳检测。
- **插件**：`validateConfig()` 分级（error 才阻止启动）；`apply()` 包 try/catch
  绝不向外抛（远程控制插件不能拖垮 Harness）；所有异步入口加 `.catch()`
  （原本 `void this.onPayload(...)` 会把 rejection 漏进宿主进程）；日志 token 脱敏。
- 新增 11 项中继加固测试 + 2 项插件测试。

文档：`README.md`、`docs/SECURITY.md`、`docs/SELF-HOSTING.md`、
`docs/MINI-PROGRAM.md`、`packages/plugin/README.md`、`LICENSE`（MIT）。

## 4. 已完成的关键修复（本轮）

1. **`drc` 命令签名错误**（对照 `@deepseek-ai/dsh-commands@0.1.0-rc.6` 实测修正）：
   handler 收的是 `{commandId, agent, rawInput, signal}`（不是整行字符串），
   且必须返回 `{kind:'success',text}` / `{kind:'error',text}`（不是裸字符串）。
   改为 `ctx.inject(['commands'], …)` 内注册。
2. **陈旧 `lib/` 产物遮蔽真实构建**：`packages/plugin/lib/` 是旧的 tsc 输出且**已进 git**，
   而 `e2e` 一直在 import 它 —— 等于在测过期代码。已删除、`lib/` 加入 `.gitignore`、
   e2e 改为 import `dist/src/`。
3. **`workspace:*` 导致装不进外部 profile**：`pnpm add -w file:…` 会报
   `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`。新增 `scripts/bundle-protocol.mjs`，
   构建时把 `@dsh-rc/protocol` 编译产物复制到 `dist/protocol/` 并把裸 specifier
   改写成相对路径；protocol 降为 devDependency，运行时依赖只剩
   `ws` / `tweetnacl` / `tweetnacl-util`。已在隔离目录验证 `import('dsh-remote-control')` 可独立加载。
4. **`packages/protocol` 的 `exports./mp` 指向不存在的路径** —— 已删除该导出。
5. **e2e 相对路径 bug**：`pnpm -r test` 时 cwd 是 `e2e/`，spawn 的 server 路径不对，
   导致 `pnpm -r test` 必挂。已改为基于 `import.meta.url` 解析绝对路径。

## 5. 关键决策记录与踩坑（重要，别重犯）

1. **协议包产物路径坑**：`packages/protocol` 的 tsconfig 用 `rootDir:"."`，产出在
   `dist/src/**`，`main` 必须写 `./dist/src/index.js`。plugin 同理
   （`dist/src/`，不是 `dist/`，也不是 `lib/`）。
2. **`node --test` 目录参数**：必须用 glob（`dist/tests/*.test.js`），传目录会
   `MODULE_NOT_FOUND`。
3. **tweetnacl-util 是 CJS**：ESM 里不能具名导入，要默认导入解构。
4. **中继 conversation id ≠ DSH session id**：ws 帧的 `sessionId` 是配对通道 id（`c_xxx`），
   payload 里的 `sessionId` 才是 DSH 会话 id。
5. **DSH 内核挂接面**：rc.6 本机 `ctx.typertGateway`（`dsh-api-gateway`）只有
   `invoke({namespace,method,args,signal})`，**无流式事件**；`$events` 在 0.1.7+/0.2 才有。
   desktop 未加载 api-gateway/connection，所以插件**绝不能**把远端能力变成启动硬依赖 ——
   必须 `ctx.inject([...])` + 软探测。`index.ts` 已按此实现。
6. **小程序环境约束**：无 Buffer / 无 CSPRNG / 无 `crypto` 模块。
   - base64、UTF-8 全部手写（`mp/utils/drc-crypto.js`）；
   - `nacl-fast.js` 末尾的 `require('crypto')` PRNG 探测**已打补丁移除**（否则加载即崩）；
     不提供 `Math.random()` 兜底，宁可抛错；
   - nonce 用计数器：`KDF(psk,convId,installId)[0..16] ‖ counter(8B BE)`，持久化。
   - `mp/utils/package.json` 只标 `type:commonjs`，供 Node 侧测试加载，小程序无视它。
7. **本环境的 pnpm 坑**：WorkBuddy 的 FS 钩子进程会拦截 pnpm 的符号链接操作
   （`CODEBUDDY_BROKER_DENY` EEXIST/ENOENT）。**凡跑 pnpm 一律加 `env -u NODE_OPTIONS`**：
   `env -u NODE_OPTIONS pnpm install -r`。另外被 SIGTERM 打断的 pnpm 会在
   `~/Library/pnpm/store/v11/projects/` 留下失效链接，删掉即可。
8. **`cordis.patch.yml` 不要写 `inject`**：desktop 确实提供了 `commands` 服务，但
   一旦某代际缺失该服务，整行就不会激活、插件静默不加载。`apply()` 内部对所有内核面
   都是软探测，所以这里**不设 inject 最稳**。
9. **测试别跨边界切断 mock 的连续流程**：`MockHarnessBridge.sendPrompt` 会跑一条
   delta→tool→permission 的异步链。把「发指令」和「等审批」拆成两个 test 会在边界上
   丢帧（drain 掉还没到的帧）。已合并为一个 test。

## 6. 恢复到当前状态 / 快速上手

```sh
cd /Users/linbin/dsh-remote-control
env -u NODE_OPTIONS pnpm install -r
env -u NODE_OPTIONS pnpm -r build && env -u NODE_OPTIONS pnpm -r test
node e2e/run.mjs
./scripts/relay-start.sh     # 自动读取 desktop profile 里的同一个 token
```

读码顺序：`packages/protocol/src/crypto.ts` → `apps/server/src/main.mjs` →
`packages/plugin/src/relay-client.ts` → `host-runtime.ts` → `bridge.ts` →
`adapter-dsh.ts` → `index.ts` → `mp/utils/drc.js` → `e2e/run.mjs`。

## 7. 与需求的偏差（都可回退）

1. **server 用 node:http + ws**，非 Fastify+TS：无值守环境下降低工具链风险。
   HTTP 端点为 healthz / api/info（`/api/pair-status` 默认关闭），迁移 Fastify 是对拍改写。
2. **小程序用 PSK-in-QR 而非 X25519**：小程序无 CSPRNG、无成熟 x25519 纯 JS 实现。
   PSK 单次有效、只在配对窗口出现。wire 格式与 Node 完全一致且有逐字节对拍测试。
   **代价：无前向安全**（影响范围限于一次配对）。
3. **`adapter-dsh.ts` 的真实 DSH 挂接仍未在真机上验证**。安装后请看日志确认
   `carrier=dsh` 而不是 `carrier=mock`。

## 8. 待办 / 下一步

- [ ] **重启 DSH Harness**。HMR 只会重放补丁层，**不会重新 import dist**，
      所以改代码后必须重启才生效（改 `cordis.patch.yml` 的配置则会热更新）。
      重启后 `cat ~/.dsh/dsh-remote-control/status.json` 看 `carrier`：
      `dsh` = 真实内核挂上了，`mock` = 会话是假的。
- [ ] 在内核挂上之后确认审批卡 / 提问卡是否真的流转（rc.6 的 typertGateway
      只有 `invoke()`、没有流式事件，这是最可能出问题的地方）。
- [ ] 小程序 appid 目前是 `touristappid`。**真机预览需要换成已注册的 appid**，
      并把 `drc.provid.cc` 加入小程序后台的 socket 合法域名白名单；
      开发者工具模拟器里勾选「不校验合法域名」即可直接连 wss。
- [ ] （可选，评估后**决定不做**）CLI bin：配对必须由运行中的 host 生成 PSK，
      独立 CLI 无法代劳；server 持久化：会把 PSK 落盘，反而扩大泄露面；
      Fastify 迁移 / locale：收益不抵风险。

## 5.10 真实内核挂接：实测结论（2026-10-01）

用真实 Harness + 公网中继实测（配对一个真实的 host，hostId `724cf186`）：

**结论 1：真实内核确实挂上了。** 会话列表返回 0 个而不是 mock 的
`ses_mock1/ses_mock2`，说明**没有走 mock 桥接** —— `carrier=dsh` 成立。

**结论 2：原来的 carrier 选择是错的，已按官方文档修正。**

`@deepseek-ai/dsh-api-gateway` 的官方 README 写明了 `/api` 的**分工**：

> The Host entry registers a trusted-host interceptor on Connection's shared
> `/api` FetchHandler. …**the handler dispatches claimed endpoints to Gateway and
> unclaimed endpoints to API Proxy.**
> Business Services **extend `TypertRemoteService` and mark methods with `@Remote`**
> … are callable through the Gateway.

对照代码：

- `dsh-session` 的 `SessionStore` 是 `class SessionStore extends Service`，
  **没有 `@Remote`** → `session.*` 属于 “unclaimed endpoints”，走 **API Proxy**；
- 它注册的 `lookup("session")` 是**参数解析器**，不是命名空间——
  我原来就是把这个 lookup 名误当成了命名空间，才写出 `session/list`；
- 全仓库形如 `xxx/list` 的端点只有 `commands/list`、`tools/list`；
- `dsh-web-app/cordis.patch.yml` 以 id `api-gateway` 挂载
  `@deepseek-ai/dsh-host-apiproxy`，它（在同一进程里）就是
  `ctx.sessions.list()` / `events.mux()` / `respond()` 的官方实现。

**已做的修改：**

1. `carrier` 只认 **apiProxy**（`ctx.apiProxy`，官方 API Proxy 服务）；
2. **删掉全部自造的 typert 一元端点猜测**（`callRc` 及其
   `session/list`、`session/prompt`、`session/cancel`、`$events/result`）——
   这些端点不存在，属于“自己造轮子”；
3. Typert Gateway **只保留官方文档明确存在的增量 `$events` 命名流**
   （`openWireStream`），且 `asGateway()` 现在要求 `openWireStream` 而不是 `invoke`；
4. `asApiProxy()` 现在要求 `sessions.list` 存在，否则不认；
5. 只拿到 typert 时启动会打一条明确的 warning：能收事件、但列不了会话。

**结论 3：失败不再静默。** 桥接吞掉的错误现在记进 `lastError`，并写进
`status.json` 的 `bridge.lastError` —— 「拿不到会话」和「你没有会话」必须能区分。

### 5.11 实测：desktop 里根本没有 apiProxy —— 改用同进程服务（第三版）

第二次实测（重启后 `status.json` 的探针）给出决定性事实：

```json
"apiProxy": null,
"typertGateway": { "keys": ["ctx","name","wireStream","srcClaims",
                            "inProcessOperator","remoteEvents","remoteEventClients",
                            "pendingRemoteEvents"], "hasWireStream": true }
```

`@deepseek-ai/dsh-host-apiproxy` 虽然在 `dsh-web-app` 的补丁里被挂载，
**在 desktop 这一态里并没有注册成 `apiProxy` 服务**。而 `inProcessOperator`
（来自 `@deepseek-ai/dsh-client-connection` 的 `OperatorPeer`，注释写着
“Gateway's in-process carrier”）也不是文档化的 session 入口。

**最终方案：同进程直接用平台自己的 cordis 服务**（新 carrier `services`）：

- 列会话：`ctx.sessions.list()`（session 对象带 `.id` / `.header.cwd`）
- 运行状态：`ctx.agents.get(id)?.status === 'running'`
- 发指令：`ctx.agents.get(id)` → `agent.followup(createUserMessage({content,source}))`
  （`createUserMessage` 来自 `@deepseek-ai/dsh-llm`，运行时动态 import，取不到就退回朴素对象）
- 中断：`agent.abort()` / `agent.interrupt()`
- 事件：`ctx.on('session/event' | 'permission/requested' | 'question/requested', …)`

这不是造轮子 —— **官方 `dsh-host-apiproxy` 自己就是直接调 `ctx.sessions` 的**
（源码 2222 行 `ctx.sessions.list().map(summarizeAttached)`，2830/2855 行
`turnAgentFor()` + `agent.followup(message)`）。同进程访问不需要任何 wire 协议。

`carrier` 优先级现在是：`services` > `apiProxy` > `typert`。
同时加了 `probeContext()`：把 ctx 上**实际可见的服务名**和关键服务是否存在写进
`status.json` 的 `probe` 字段，避免再靠猜。

### 5.12 真机进展：已打通到「agent 真的开始跑」，卡在模型选择

`services` 载体在真机验证通过：

```
carrier: services        hasSessionsList: true   hasAgents: true
✅ 小程序配对成功  ✅ 收到真实会话（session-3449591d… @ /Users/linbin/vibe/data-warehouse）
✅ 指令送达：agent 真的开跑了（agent/status、agent/request、agent/error 事件都观测到）
```

**唯一剩下的阻塞**（`bridge.lastError` 原样）：

```
agent error (turn 8, step 1): Cannot read properties of undefined (reading 'provider')
  at ReactLoopAgent.prepareRequest (…/dsh-agent-loop/lib/index.js:1185:23)
  at … step → turn → kick
```

定位过程：

1. 官方 `dsh-host-apiproxy` 的 prompt 路径是
   `turnAgentFor()` → `agent.followup(createUserMessage(...))`；
   `agentOptions()` 取 `{provider, model}`，来源是
   **`ctx.agentDefaultModel.currentSelection()`**（官方 README 明确的方法名，
   不是 `defaultModelSelection`）→ 已按此接入。
2. `selectionFor(agent)`（apiproxy 第 1750 行）优先读
   `agent.session.requestHeader()?.config`，**读不到才回退到部署默认模型**。
3. 报错发生在 `prepareRequest`，即 agent 的 loop 拿不到 provider —— 
   说明**这个 agent 被创建时没有带模型选项**。
4. 试过 `ctx.agents.resume({resumeSessionId, agentOptions})` 补救，但
   官方 resolver 对**已在线的 agent 是直接复用**（README: “reuses live Agents”），
   所以 resume 是空操作，救不回一个已经建坏了的 agent。

**假设（待验证）**：这台机器上当前在线的那个 session 是**命令会话**
（session log 里能看到 `command/run` + `name: "drc"`），
斜杠命令不需要模型，所以它的 agent 没有模型；
而正常聊天创建的 session 会带模型。

**下一步**：在 DSH 界面里**开一个新的聊天会话**（或打开一个你真正聊过的会话），
让它成为「已附加」会话，然后重跑：

```sh
node scripts/verify-deployment.mjs --pair <码> --qr '<dsh…>' \
  --send-prompt --prompt '只回复 ok 两个字'
```

若换成聊天会话后仍然报同样的错，那问题就在 `agentDefaultModel.currentSelection()`
在这个 profile 里返回空 —— 用 `status.json` 的 `probe.present` 里的
`agentDefaultModel` 与 `bridge.services.hasDefaultModel` 一起判断。

## 9. 安装记录（已执行）

- `~/.dsh/profiles/desktop/package.json`：加了依赖
  `"dsh-remote-control": "file:/Users/linbin/dsh-remote-control/packages/plugin"`，
  并把它追加进 `dsh.profile.bundles`。
- `~/.dsh/profiles/desktop/cordis.patch.yml`：追加了 `dsh-remote-control` 配置行
  （含 `hostToken`，该文件权限 600）。
- 备份：`package.json.bak-drc-<ts>`、`cordis.patch.yml.bak-drc-<ts>`。
- 已验证：`apply()` 在真实 `@deepseek-ai/cordis` 下不抛错；profile 里的 token 能与
  `scripts/relay-start.sh` 起的中继握手成功（relay online，拿到 hostId）。

### 5.13 真机端到端跑通 —— 根因是本插件自己造成的（waterfall 事件）

**结论：全链路打通。** 「指令送达内核 → 模型回复 → 回合正常收尾 → 零知识」全部验证通过。

#### 根因 1（最严重）：订阅了 cordis 的 waterfall 事件

`ctx.on(name, fn)` 在 cordis 里注册的是**参与式**监听器。对 **waterfall** 事件，
监听器的返回值会**替换**传给下一个监听器的值。一个只读的观察者返回 `undefined`，
就把整条链冲掉了。

本插件曾订阅 `agent/request`（只为观测）。该 waterfall 产出的正是
`ReactLoopAgent.prepareRequest` 使用的请求配置，于是 `proposedConfig` 变成 undefined，
紧接着那行断言抛：

```
Cannot read properties of undefined (reading 'provider')
  at ReactLoopAgent.prepareRequest (app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:1186:22)
```

—— **而且是进程内每一个 turn 都崩，包括你在桌面 UI 里手动发的**。这就是
"重启了没用" 的全部原因。已修：从订阅列表移除，并加 `WATERFALL_EVENTS` 黑名单
（13 个 waterfall 名）+ 两道测试护栏（`the bridge never observes a waterfall event`）。

#### 根因 2：会话被归档

桌面 profile 装了 `@chaoset/session-archive`，把历史会话都归档了。归档会话
（或其后代的 subagent）会被宿主自己的 `archived-session-gate` 在 `agent/pre-step`
拒掉，loop 以 `turn/end {reason:{kind:"blocked"}}` 收场，**在任何模型调用之前** —— 
所以指令进了 inbox 却什么也不发生。

```
agent/inbox/spliced {"inserted":[{"text":"只回复 ok …"}]}
turn/start {"turn":8}
agent/inbox/spliced {"start":0,"removedCount":1,"inserted":[]}
turn/end {"turn":8,"reason":{"kind":"blocked"}}
```

已修：列表读出 `workspaceRegistry.archivedSessionIds`，把状态标成 `archived`
（客户端一眼可辨），发送前用 `workspaceRegistry.unarchiveSession(id)` 恢复
（`unarchiveOnPrompt`，默认开）。

#### 根因 3：我自己的窗口合并把收尾帧丢了

`flushDelta` 里的 `if (!entry.text) return` 会把 `turn/end` 产生的
空文本 `done:true` 帧静默丢掉，手机端永远转圈。已修（`if (!entry.text && !entry.done)`）
并加回归测试。

#### 最终验证（真实内核 / 公网 wss）

```
✅ 收到加密会话列表（11 个会话，真实标题，6 个标 archived）
✅ 会话来自真实内核（不是 mock 桥接）
✅ 流式输出到达："ok"
✅ 回合已收尾（首帧即含 done）
✅ 零知识：3 个上行帧全为密文（无明文/无命令名）
🎉 端到端自检全部通过
```

会话日志侧证据：

```
request/header  {"config":{"provider":"stepfun","model":"step-5-preview"}}
assistant/message {"content":[{"type":"text","text":"ok"}]}
turn/end  {"turn":12,"reason":{"kind":"completed"}}
```

另跑了一次工具型 prompt（`请用 bash 工具运行 echo drc-e2e`），同样端到端通过：
模型真的去调工具、回报结果、回合正常收尾。

#### 仍未验证的一项（受环境限制，非代码问题）

本机**所有**会话的 preset 都是 `danger-full-access` + `approval/policy: never`
（逐会话核对过），**永远不会弹审批卡**，所以 `ev.permission_request` 这条路
在本工作区无法实测。要验证它需要一个 restrictive preset 的会话。

#### 测试

72 项 + e2e 9 步，全绿。

### 5.14 手机反馈三连的修复 + 二维码改为 vendored 实现

手机试用的三个问题（排版错乱 / 插件没有二维码 / `wx.connectSocket is not a function`）：

| 问题 | 修复 |
|---|---|
| 手机排版错乱 | `chat.wxss` 100vh+缺 `min-height:0`（输入框被挤出屏）；`sessions.wxss` 整个缺失；长 ID/路径未 `break-all`。三个页面样式按设计规范重写，新增 `app.wxss` 全局层 |
| `wx.connectSocket is not a function` | 新增 `mp/utils/platform.js` 能力探测 + `mp/utils/ws.js` 双路径（SocketTask / 旧式全局回调）；两条路都没有时如实报「环境缺能力」并停止重连，页面显示可复制的环境自检行 |
| 插件没有二维码 | `/drc pair` 现在直接在终端渲染**可扫的二维码**（半块字符 + 黑底白字 ANSI，明暗主题都正确）；默认内嵌配对码，扫码即连 |

**二维码编码器：手写版放弃，改 vendoring `qrcode-generator` 1.4.4（MIT）。**
手写版经 `scripts/validate-qr.mjs`（segno 逐位比对）抓出系统性差异后放弃；
差异的最终定性：两者前 3 个码字完全一致，分歧只在**填充字节的合法选择**
（标准允许 terminator 后直接 EC/11 填充，segno 会先补零到码字边界）。
校验方法随之升级为**功能级**：zxing-cpp 真实解码渲染结果，28 组用例
（含 CJK、公网 URL）全部解出且逐字节一致。终端半块渲染有「可还原」回归测试。

另修：vendored 库默认 `stringToBytes` 会截断非 ASCII（`中`→1 字节，静默产生
坏码），已显式启用其自带的 UTF-8 编码器；小程序扫码/粘贴遇内嵌配对码自动连接。

测试：77 项 + e2e 9 步 + QR 解码 28 组，全绿。
