# HANDOFF — dsh-remote-control

> 交接给下一位开发 agent。**先读本文，再读代码。**
> 最后更新：2026-10-02（mp 端全量重写 + 真实链路验证通过后）。

## 0. 一句话状态

系统**已上线并在真实链路验证通过**：DSH 插件（host）+ 零知识中继（`wss://drc.provid.cc`）
+ 微信小程序客户端，配对 → 会话列表 → 发指令 → 流式输出 → 工具调用 → 零知识审计全绿。

## 1. 当前实测状态（不是猜的，全部有测试背书）

| 层 | 状态 |
|---|---|
| Harness 插件 | 运行中，`carrier=services`（真实内核），`relay=online`，`relayProblem=null` |
| 中继 | 阿里云 ECS 运行中（systemd），`https://drc.provid.cc/healthz` 正常 |
| 单测 | **83 项全绿**（protocol 11 / plugin 36 / server 13 / e2e 23） |
| relay e2e | `node e2e/run.mjs` 9 步全绿 |
| **live-e2e** | `node e2e/live-e2e.mjs` 10 项/轮全绿（真实 mp 客户端代码 + 线上中继 + 真实内核，**绝不退化 mock**）；3 轮连跑 24 项全绿 |
| 二维码 | zxing-cpp 真实解码 28/28 |
| 真机验证 | 工具型指令（bash echo）真实执行回传 ✅；归档会话自动恢复 ✅ |
| **未验证** | 真机上的审批/提问卡（本机所有会话 preset 均为 `danger-full-access` + `approval/policy: never`，永不弹审批——环境问题，非代码问题） |

状态快照（排错第一入口）：`cat ~/.dsh/dsh-remote-control/status.json`
关键字段：`carrier`（`services`=真实内核，`mock`=假会话）、`relay`、`relayProblem`、`probe`。

## 2. 快速恢复环境

```sh
cd /Users/linbin/dsh-remote-control
env -u NODE_OPTIONS pnpm install -r       # 为什么加 env -u：见 §4.1
env -u NODE_OPTIONS pnpm -r build
env -u NODE_OPTIONS pnpm -r test           # 83 项
node e2e/run.mjs
node e2e/live-e2e.mjs                      # 真实链路（需要本机 Harness 在跑）
```

读码顺序：`packages/protocol/src/crypto.ts` → `apps/server/src/main.mjs` →
`packages/plugin/src/relay-client.ts` → `host-runtime.ts` → `bridge.ts` →
`adapter-dsh.ts` → `index.ts` → `mp/core/client.js` → `e2e/live-e2e.mjs`。

## 3. 仓库结构

```
packages/protocol   线协议 + E2E crypto（tweetnacl）+ 防休眠命令构造器
packages/plugin     Host 插件：relay-client / host-runtime / bridge /
                    adapter-dsh / adapter-mock / qr / index（cordis apply）
apps/server         零知识中继（node:http + ws，无构建）
mp/                 微信小程序（2026-10-02 全量重写）
  core/             协议层：codec（线格式）/ env（能力探测）/ socket（双路径 WS）/
                    session-store / client（DrcClient 状态机）
  core/vendor/      nacl-fast.js（打过补丁的 tweetnacl）+ js-base64.js（MIT）
  miniprogram_npm/  裁剪版 TDesign（1.5MB，预置产物，不要「构建 npm」）
  pages/            sessions（入口）/ pair（配对）/ chat（对话）
e2e/                live-e2e / run / mp-crypto / mp-client / mp-platform / multi-pair
deploy/             nginx + systemd + 上线文档（生产实例在跑）
scripts/            install-to-profile / relay-start / verify-deployment /
                    validate-qr / pairing-qr / bundle-protocol / read-session-log
docs/               SECURITY / SELF-HOSTING / MINI-PROGRAM
```

## 4. 硬性约束与踩坑清单（别重犯）

### 4.1 本机环境：pnpm 必须 `env -u NODE_OPTIONS`

WorkBuddy 注入的 FS 钩子会拦截 pnpm 的符号链接操作，报
`CODEBUDDY_BROKER_DENY` EEXIST/ENOENT。**凡跑 pnpm 一律**：
`env -u NODE_OPTIONS pnpm …`。被 SIGTERM 打断的 pnpm 还会在
`~/Library/pnpm/store/v11/projects/` 留失效链接，删掉即可。

### 4.2 改插件代码必须重启 Harness

HMR 只热更 `cordis.patch.yml` 的配置，**不会重新 import dist**。改代码后必须重启。
重装插件用 `./scripts/install-to-profile.sh`（pnpm 对 `file:` 依赖是硬链接拷贝，
tsc 重建后 inode 变了，profile 里仍是旧副本；脚本先 `rm -rf` 再装）。

### 4.3 产物路径与打包约束

- `packages/protocol`、`packages/plugin` 的 tsconfig 用 `rootDir:"."`，产物在
  `dist/src/**`，`main` 是 `./dist/src/index.js`。
- `lib/` 是历史遗留的陈旧产物，**已删除并 gitignore，不要从 lib/ import**。
- 插件要装进外部 profile，**不能有 `workspace:*` 依赖**：`@dsh-rc/protocol` 只是
  devDependency，`scripts/bundle-protocol.mjs` 在 build 后把 protocol 产物内联到
  `dist/protocol/` 并改写裸 specifier。**改了 protocol 必须重新 build plugin。**
- `node --test` 传目录会 MODULE_NOT_FOUND，必须 glob（`dist/tests/*.test.js`）。
- `tweetnacl-util` 是 CJS：ESM 里默认导入解构，不能具名导入。

### 4.4 cordis 集成（血泪教训，全有回归测试）

1. **绝不订阅 waterfall 事件**。`ctx.on(name, fn)` 对 waterfall 是参与式监听，
   返回 `undefined` 会把整条链冲掉。插件曾因观测性订阅 `agent/request`，导致
   **进程内每一个 turn 都崩**（`Cannot read properties of undefined (reading 'provider')`），
   连桌面 UI 手动发消息都崩。现在有 `WATERFALL_EVENTS` 黑名单 + 测试护栏。
2. **carrier 优先级：`services` > `apiProxy` > `typert`**。desktop 这一态没有注册
   `apiProxy` 服务；`typertGateway` 只有 `invoke()`、无流式事件。最终方案是同进程
   直接用平台自己的 cordis 服务（官方 `dsh-host-apiproxy` 自己也是这么干的）：
   - 列会话：`ctx.sessions.list()`；运行状态：`ctx.agents.get(id)?.status`
   - 发指令：`agent.followup(createUserMessage(...))`（`createUserMessage` 运行时
     动态 import 自 `@deepseek-ai/dsh-llm`，取不到退回朴素对象）
   - 中断：`agent.abort()` / `agent.interrupt()`
   - 事件：`ctx.on('session/event' | 'permission/requested' | 'question/requested')`
   - 模型选择：`ctx.agentDefaultModel.currentSelection()`（官方方法名）
3. **归档会话会被宿主 gate 拒掉**（`@chaoset/session-archive` 的
   `archived-session-gate` 在 `agent/pre-step` 拦，loop 以 `turn/end blocked` 收场，
   在模型调用之前）。插件列表时读 `workspaceRegistry.archivedSessionIds` 标
   `archived`，发送前 `unarchiveSession(id)` 自动恢复（`unarchiveOnPrompt`，默认开）。
4. `apply()` **绝不向外抛异常**；所有内核面软探测；`cordis.patch.yml` **不写 inject**
   （某代际缺服务时整行不激活、插件静默不加载）。
5. 中继帧的 `sessionId` 是**配对通道 id**（`c_xxx`），payload 里的 `sessionId`
   才是 DSH 会话 id。别混。

### 4.5 配对协议（两个真 bug 的教训）

1. **TTL 以服务端为准**：`pair-ready` 携带服务端权威 `ttlMs`，host 必须据此更新
   本地过期时间。否则 host 提前清扫 PSK → `peer-joined` 找不到 PSK → 静默丢 peer →
   客户端永远「加密解码失败」、会话列表为空。
2. **多配对码并存**：`pendingPairs: Map<token, {psk, expiresAt}>`（不是单槽），
   服务端 `peer-joined` 回传 `pairingToken`，按客户端实际使用的码取 PSK。
   回归测试：`e2e/multi-pair.test.mjs`。
3. 配对码一次性；`status.json` 按定时器刷新、不按消费刷新——live-e2e 因此只接受
   新发布（age<25s）且本轮未用过的码。

### 4.6 事件流窗口化（防卡顿/内存泄漏）

- host 侧合并 delta：120ms / 4KB / 最多 32 个会话一轮 flush（`host-runtime.ts`）。
- **`flushDelta` 不能丢空文本的 done 帧**（`if (!entry.text && !entry.done)`），
  否则手机端永远转圈。有回归测试。
- mp 聊天页合并刷帧：100ms / 最多 300 条 / 单条截断 20KB（`pages/chat/chat.js`）。
- 中继→客户端可能发 `enc-batch`（多帧合并），客户端必须处理（`core/client.js`）。

### 4.7 小程序环境约束

- 无 Buffer / 无 CSPRNG / 无 `crypto` 模块。base64/UTF-8 用 vendored **js-base64**
  （`mp/core/vendor/js-base64.js`）；nonce 用计数器（持久化在 storage）。
- `core/vendor/nacl-fast.js` 是打过补丁的 tweetnacl（移除 `require('crypto')` PRNG
  探测，否则加载即崩；不提供 `Math.random()` 兜底，宁可抛错）。**升级 tweetnacl
  要重新打补丁。**
- `mp/core/package.json` 只标 `type:commonjs`，供 Node 侧测试加载，小程序无视它。
- socket 双路径：`core/env.js` 探测能力，`core/socket.js` 按结果走 SocketTask 或
  旧式全局回调；两条路都没有时如实报「环境缺能力」并停止重连（第三方预览容器
  没有 `connectSocket`，原理上无法工作）。**连接超时 12s 真实生效**（旧版是死代码）。
- UI 用 **TDesign**，产物已按依赖闭包裁剪预置在 `mp/miniprogram_npm/`（1.5MB，
  含内嵌 tslib）。**不要在开发者工具里点「构建 npm」**（会用全量包覆盖裁剪产物，
  超 2MB 主包限制）；`mp/node_modules/` 已在 project.config.json 里忽略打包。
- 改 `mp/core/*.js` 必须跑 `e2e/mp-crypto.test.mjs` + `e2e/mp-client.test.mjs` +
  `e2e/mp-platform.test.mjs`。
- 微信 `input` 组件默认内容高度小，必须用显式 `height/line-height` 撑高，
  靠 padding 会把文字裁掉（真机上半截字）。

### 4.8 测试哲学

- `e2e/live-e2e.mjs` 是最高标准：三个真实（真实 mp 客户端代码经 wx shim、线上中继、
  真实内核），**拿不到真实配对码就直接失败，绝不退化成 mock**。
  `scripts/verify-deployment.mjs` 有「自建主机模式」会假通过——只用于部署冒烟，
  别拿它当功能验证。
- 小程序测试靠 `e2e/mp-sim.mjs` 的 wx shim 在 Node 里驱动**真实的 `mp/core` 代码**；
  crypto 与 `packages/protocol` 逐字节对拍。改线格式两边必须一起改。
- 二维码校验不靠肉眼：`scripts/validate-qr.mjs` 用 zxing-cpp 真实解码 28 组。
- 测试别跨边界切断 mock 的连续异步链（delta→tool→permission），会丢帧。

## 5. 密钥与配置位置

| 项 | 位置 |
|---|---|
| host token（中继侧） | 服务器 `/etc/dsh-remote-control.env`（600） |
| host token（插件侧） | `~/.dsh/profiles/desktop/cordis.patch.yml`（600）——两处必须一致 |
| 插件状态快照 | `~/.dsh/dsh-remote-control/status.json` |
| profile 备份 | `~/.dsh/profiles/desktop/*.bak-drc-<ts>` |
| 中继部署 | 服务器 `/opt/dsh-remote-control/server` + systemd `dsh-remote-control.service`（只绑 127.0.0.1:8787），nginx `conf.d/drc.conf` 终止 TLS + 限流 |
| 证书 | acme.sh（`/opt/jevtv/acme/acme.sh`）+ 阿里云 DNS-01，自动续期 |
| 服务器 | 阿里云 cn-shanghai ECS `47.100.82.15`，本地已 root 免密 |

## 6. 待办 / 下一步

- [ ] 真机验证审批/提问卡流转：需要一个 restrictive preset 的会话（本机全是
      `danger-full-access` + `approval/policy: never`，永远不会弹）。代码路径有
      单测和 mock e2e 覆盖，但真机没跑过。
- [ ] mp 端：图片/文件附件（协议 `cmd.send_prompt.attachments` 有字段，UI 未做）；
      多主机切换（现在单配对，重新配对会覆盖）。
- [ ] 中继纯内存，重启后配对关系丢失（客户端会提示重新配对）。不打算做持久化——
      PSK 落盘反而扩大泄露面。
- [ ] Windows 防休眠（`SetThreadExecutionState`）预留未实现。

## 7. 已评估并决定不做

- CLI bin：配对必须由运行中的 host 生成 PSK，独立 CLI 无法代劳。
- Fastify 迁移 / server 上 TS：无值守环境降低工具链风险优先。
- 配对改 X25519 握手：小程序无 CSPRNG、无成熟纯 JS 实现；PSK 单次有效、只在配对
  窗口出现，代价是无前向安全（影响范围限于一次配对），可接受。
