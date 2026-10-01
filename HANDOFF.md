# HANDOFF — dsh-remote-control（DSH 远程控制插件）

> 交接文档。截至编写时全部已完成部分测试全绿；未完成项集中在**微信小程序客户端**与**文档/正式安装验证**。请先读本文再动手。

## 1. 项目目标（用户原始需求 + 已确认决策）

在全新目录 `/Users/linbin/dsh-remote-control` 内创建「远程操作 DSH」的完整系统，参考 [slopus/happy](https://github.com/slopus/happy) 与本地 zip（`/Users/linbin/Downloads/ds-harness-remote-main.zip`，即开源项目 `ds-harness-remote` 的源码）。三大件：

1. 功能完善的 DSH 插件（Host 侧），支持**防休眠**（参考 Claude / Qoder 的实现方式）；
2. **server 端**（自建中继）；
3. **微信小程序**控制客户端（核心闭环）。

用户已确认的决策：

| 项 | 决策 |
|---|---|
| 目录 | `/Users/linbin/dsh-remote-control` |
| 安装方式 | 完成后**直接安装进 desktop profile**（`~/.dsh/profiles/desktop`） |
| 安全 | token + TLS + 端到端加密 |
| 技术栈 | Node + Fastify + ws（**实际实现为 node:http + ws，见 §7 偏差说明**） |
| 小程序范围 | 核心控制闭环：配对/会话/指令/审批/提问/防休眠状态 |
| 防休眠平台 | macOS + Linux（Windows 预留） |
| 验证深度 | 单测 + mock 端到端 |
| 其他 | 自动决策，不再停下来问 |

## 2. 架构

```
┌─────────────────┐   ws (token 鉴权)    ┌──────────────┐   ws (token)   ┌─────────────────┐
│ DSH 桌面应用      │ ───────────────────▶ │  relay server │ ◀─────────── │ 微信小程序 / web  │
│  (cordis 插件)   │   审计: 只见密文      │  apps/server  │               │  mp/            │
└─────────────────┘                       └──────────────┘               └─────────────────┘
        │ 防休眠: caffeinate/systemd-inhibit           数据面: base64(nonce24 ‖ secretbox) 端到端
        ▼
   E2E payload 协议（@dsh-rc/protocol）：
   cmd.list_sessions / cmd.send_prompt / cmd.answer / cmd.resolve_permission /
   cmd.interrupt / cmd.keep_awake / cmd.subscribe  ⇄
   ev.session_changed / ev.message_delta / ev.tool_event / ev.permission_request /
   ev.question_request / ev.run_state / ev.keep_awake_state / ev.result
```

- **信任模型**：relay server 持有 `DRC_HOST_TOKEN`（host 出站认证）与配对 token 路由表；**只透传密文**，无 payload 密钥（e2e 有断言验证）。TLS 由部署方负责（反代 wss）。
- **配对**：host 生成 6 位 token + PSK（16B，QR `dshr:/p?s=wss://…&n=<label>&psk=…`）；小程序扫码或手输 token 换取密文字向钥（`derivePskKey(psk,'c2h',convId)` / `'h2c'`）。
- **防休眠**：`KeepAwake` 类仅在「会话运行中 / 有审批或提问挂起」时持有锁，空闲 `idleReleaseSec`（默认 300s）后自动释放——本地空闲仍可正常睡眠。

## 3. 已完成且测试通过的模块

| 包 | 内容 | 测试 |
|---|---|---|
| `packages/protocol` | 线协议（`WsFrame` 联合类型 + 校验）、E2E crypto（tweetnacl，Node/MP 同语义）、防休眠命令构造器（macOS `caffeinate -i -s -w<pid>`、Linux `systemd-inhibit`、Windows `SetThreadExecutionState` 预留） | **10/10** |
| `packages/plugin` | `relay-client.ts`（出站 ws、重连、配对管理）、`host-runtime.ts`（事件扇出、挂起审批时心跳保活、keep_awake 指令）、`bridge.ts`（`HarnessBridge` seam + `handlePayload` 分发）、`adapter-mock.ts`（内存 harness）、`adapter-dsh.ts`（真实内核适配，**未在真实 DSH 上验证**）、`index.ts`（cordis `apply`：软激活、环境变量覆盖、`drc` TUI 命令） | **4/4** |
| `apps/server` | `src/main.mjs`（node:http + ws 中继：host/client 认证、配对 token（TTL、单次、防重放）、conversation 路由、seq 编号、反代零知识） | **2/2** |
| `e2e/run.mjs` | 真实 server + HostRuntime(mock bridge) + 模拟小程序客户端（ws）：配对→list→prompt→delta→审批 approve→提问 answer→keep-awake→interrupt→**零知识审计** | **9/9** |

验证命令（在 `/Users/linbin/dsh-remote-control` 下）：

```sh
pnpm -r build          # protocol→dist/src，plugin→dist
pnpm -r test           # 16 项单测
node e2e/run.mjs       # 9 步全链路
# 单跑 server 中继自测：cd apps/server && node --test tests/relay.test.mjs
```

## 4. 未完成（按优先级）

### 4.1 微信小程序客户端 `mp/`（最大缺口，目录只有空 `mp/app/`）

需从零创建原生小程序（**至少**）：

```
mp/
  project.config.json          # appid 用 touristappid 或用户自己的
  app.js / app.json / app.wxss
  utils/nacl-fast.js           # ← 复制自 packages/protocol/node_modules/tweetnacl/nacl-fast.js（tweetnacl 是纯 JS，MP 可用；randomBytes 需替换）
  utils/drc-crypto.js          # MP 侧 kdfHash/derivePskKey/seal/open 镜像实现（用 nacl.hash=sha512 trunc32；nonce 用计数器，MP 无 crypto.getRandomValues）
  utils/store.js               # token/psk/convId 持久化（wx.setStorageSync）
  utils/ws.js                  # wx.connectSocket 封装 + 断线重连
  pages/index/                 # 配对页：扫码(wx.scanCode 解析 dshr:) + 手输 6 位 token
  pages/sessions/              # 会话列表（ev.session_changed）
  pages/chat/                  # 对话页：cmd.send_prompt、流式 delta、审批卡片、提问卡片、中断按钮、keep-awake 状态
```

协议语义直接抄 `e2e/run.mjs` 里的 `MpClient`（hello→pair-begin-client→paired→派生双方向密钥→`enc` 帧 send/recv）。**约束**：MP 无 Buffer，需 Uint8Array + 手写 base64 编解码；`wx.connectSocket` 需在微信开发者工具勾选"不校验合法域名"。

### 4.2 文档 `docs/`（当前为空）

- `README.md`（根）：三件套说明、快速开始、架构图（可参考本文件 §2）
- `docs/SECURITY.md`：信任模型、配对流程、为何 MP 用 PSK 而非 X25519、TLS 部署要求
- `docs/SELF-HOSTING.md`：`DRC_HOST_TOKEN=xxx DRC_PORT=8787 node apps/server/src/main.mjs`、wss 反代、systemd/launchd 常驻样例
- `packages/plugin/README.md`：安装/卸载/配置说明
- 根 `LICENSE`（MIT）

### 4.3 安装进 desktop profile（用户已批准，**未执行**）

目标：`~/.dsh/profiles/desktop`。推荐路径：

```sh
cd ~/.dsh/profiles/desktop
pnpm add -w file:/Users/linbin/dsh-remote-control/packages/plugin
# 然后把 "dsh-remote-control" 加进 package.json 的 dsh.profile.bundles 数组
```

**风险**：`cordis.patch.yml` 现为 `inject: [commands]`。参考插件 desktop 条目 `inject: [webServer]`，TUI 条目才带 commands/tuiScenes。若 desktop 无 `commands` 服务，条目可能不激活——应改成桌面条目 `inject: [webServer]`（或干脆 `inject: []` + `apply()` 里已做 runtime 软探测）。**未装前不要盲改**，先本地 dry-run（见 §6）。装完需重启 Harness 生效。

### 4.4 可选增强

- `packages/plugin/src/bin.ts`：CLI（`drc pair` 打印 QR 文本 / `drc status`）——当前未建，package.json 的 `start` 已删除
- server 迁到 Fastify+TS（见 §7）
- server 持久化（当前纯内存，重启丢 pairing）
- locale（en/zh）

## 5. 关键决策记录与踩坑（重要，别重犯）

1. **协议包产物路径坑**：`packages/protocol` 的 tsconfig 用 `rootDir:"." include:[src,tests]`，产出在 `dist/src/**`。`package.json` 的 `main` 必须写 `./dist/src/index.js`，不是 `./dist/index.js`。
2. **`node --test` 目录参数**：`node --test dist/tests`（目录）会当模块加载报 `MODULE_NOT_FOUND`；必须用 glob：`node --test dist/tests/*.test.js`。
3. **tweetnacl-util 是 CJS**：ESM 里不能 `import { encodeBase64 }`，要默认导入解构（`crypto.ts` L12 已处理）。
4. **中继 conversation id ≠ DSH harness session id**：`ws` 帧的 `sessionId` 是配对通道 id（`c_xxx`），payload 里的 `sessionId` 才是 DSH 会话 id。e2e 里曾混淆导致 send_prompt 打空。`host-runtime.ts` 的 `forward()` 靠"匹配不上就 broadcast"兜底，语义 OK。
5. **DSH 内核挂接面（调研结论，来自两个子代理 + 本机 bundle 检查）**：
   - DSH 插件 = cordis bundle：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`；条目录入 `package.json → dsh.profile.bundles`；`pnpm add -w file:...` 安装。HMR 约 1s（补丁层改动）；**新增 package 需重启**。
   - **rc.6 本机**：`ctx.typertGateway`（`dsh-api-gateway` 0.1.0-rc.6）只有 `invoke({namespace,method,args,signal})`，**无 openWireStream/$events 流**（lib/types/types.d.ts 实查）；`$events` 在 0.1.7+/0.2 才有。桥接状态需 handler 探测 `fn.openWireStream?.call`。
   - 参考插件 `ds-harness-remote`：走官方 carrier（legacy `ctx.apiProxy`（`dsh-host-apiproxy`）：`apiProxy.sessions.list/history/prompt/cancel` 点号 + `events.mux(req,signal)` 帧 `approval/requested`/`question/requested` + `respond({type:'client-response',rpcId,result})`；typert 代际：`gateway.dispatch('ns/method')` + `$events` waterfall `approval/request`/`user-questions/request` + `$events/result`）。**endpoint 准确清单在参考仓库 `packages/plugin/src/harness-remote-bridge.ts` L102-176（typert 白名单）与 `harness-api-bridge.ts` L200-248（legacy 白名单）**。`@Remote` 方法名（如 `sessionPrompt`）需 introspection：`typert.local`/`$cmdCache` 命中后按行号核名，未知即报 `definition-unavailable`，禁止猜。
   - **desktop profile 当前未加载 api-gateway/connection**：所以插件**绝不能**把远端能力变成启动硬依赖——必须 `ctx.inject([...])` 门活 + `ctx.get(name,false)` 探测（`index.ts` 已按此实现，typert 缺失时降级 mockBridge）。
   - **不要**像参考插件那样 Proxy 劫持 `apiProxy` 域对象去改写官方 GUI（实现脆弱、跨代风险）。
   - `~/.dsh/profiles/node_modules/@deepseek-ai/` 是本机 bundle 真相源（dsh-session 提供 `ctx.sessions`+事件 `session/created|disposed|event|flush`；dsh-host-apiproxy 提供 apiProxy）。
6. **本机环境**：Node 22.23.3 / pnpm 11.7.0 / dsh CLI 在 `/opt/homebrew/bin/dsh`。/tmp 里的解压目录 `/tmp/dsr-ref/ds-harness-remote-main` **可能已被清理**，需要参考时从 `/Users/linbin/Downloads/ds-harness-remote-main.zip` 重解压。

## 6. 恢复上下文 / 快速上手

```sh
cd /Users/linbin/dsh-remote-control
pnpm install -r
pnpm -r build && pnpm -r test && node e2e/run.mjs     # 期望 16 + 9 全绿
# 手动起 server 看真实配对：
cd apps/server && DRC_HOST_TOKEN=$(openssl rand -hex 24) DRC_PORT=8787 node src/main.mjs &
# 起 host（mock bridge，无需 DSH）：node packages/plugin/dist/src/index.js 不可直接跑，用 e2e 同款方式:
#   node -e "import('./packages/plugin/dist/src/host-runtime.js').then(async m=>{ ... })"
```

读代码顺序：`packages/protocol/src/crypto.ts` → `apps/server/src/main.mjs` → `packages/plugin/src/relay-client.ts` → `host-runtime.ts` → `bridge.ts` → `adapter-dsh.ts` → `index.ts` → `e2e/run.mjs`。

## 7. 与需求的偏差（都可回退）

1. **server 用了 node:http + ws（纯 JS，无构建）**，而非 Fastify+TS。原因：无值守环境下降低工具链/构建风险。数据结构（map-in-memory）与 Fastify 迁移等价；如需 Fastify，按 `main.mjs` 里的三个HTTP端点(healthz/info/pair-status)+ws 对拍即可。
2. **MP 客户端方案用 PSK-in-QR 而非 X25519**：MP 环境缺少安全随机源与成熟 x25519 纯 JS 实现；PSK 仅在配对窗口出现且单次有效，wire 格式与 Node 侧完全一致（e2e 已验证互通语义，MP 侧需按同一 spec 实现并用 §4.1 脚本 `node --test` 回归）。
3. **`adapter-dsh.ts` 的真实 DSH 挂接未验证**（ry rc.6 typertGateway 无流式；审批流在本机可能走 `apiProxy` 路径）。安装前建议按参考仓库白名单逐一用 `node:vm` dry-run 探测 `invoke('session/list')`。

## 8. 当前待办快照

- [ ] `mp/` 完整小程序（最大块）
- [ ] `docs/` + 根 README + LICENSE
- [ ] `cordis.patch.yml` inject 列表按 desktop 实际服务面校正 + `pnpm add -w file:…` 安装 + 重启验证
- [ ] （可选）server Fastify 化 / 持久化 / plugin CLI bin
- [x] protocol / plugin / server 单测 + mock e2e 全绿
