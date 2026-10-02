# HANDOFF — dsh-remote-control

> 交接给下一位开发 agent。**先读本文，再读代码。**
> 最后更新：2026-10-02（重写后的代码全部落地，生产已切换并验证）。

## 0. 一句话状态

这次是**从零重写之后的状态**：小程序 `mp/` 一行未改；协议层 / 中继 / host 插件 / e2e /
脚本 / 设计文档全部重写，旧代码已删除（旧实现只剩 `docs/legacy-spec/` 里的事实档案，
需要看旧代码用 `git show b026d63:<path>`）。生产入口 `wss://drc.provid.cc` 已经跑上
重写后的单文件中继，并用真链路取证验证通过。

设计、拍板与偏离记录在 [`docs/DESIGN.md`](docs/DESIGN.md)（冻结契约表 §2、偏离 D1-D9 §4、
阶段门禁 §7、拍板 §8、执行日志 §9）。对这份设计的独立复核在
[`docs/DESIGN-REVIEW.md`](docs/DESIGN-REVIEW.md)——**它的 🔴 条目已全部落地**，
复核里"判据不足以守住什么"那一段是这一轮真机取证的主战场。

## 1. 当前实测状态（每条都有可跑的命令）

| 层 | 状态 | 怎么验 |
|---|---|---|
| 类型 | 三包全绿 | `env -u NODE_OPTIONS pnpm -r typecheck` |
| 协议层 | **76 项全绿** | `pnpm --filter @dsh-rc/protocol test` |
| 与小程序逐字节对拍 | **18 项全绿**（284 条向量 + 随机新向量 + 篡改 + 反证 + F6 契约） | `node --test e2e/protocol.test.mjs` |
| 中继 | **62 项全绿**（含产物级零知识断言、空目录起单文件、优雅停机 exit 0、version 对账） | `pnpm --filter @dsh-rc/server test` |
| host 插件 | **173 项全绿** | `pnpm --filter dsh-remote-control test` |
| 本地全链路 | **13 步全绿**（真中继进程 + 真 `apply()` 入口 + 真 mp 代码，内核面 mock） | `node e2e/run.mjs` |
| 生命周期取证 | **50 项全绿**（客户端重连 / 中继重启 / **主机重启不许静默** / 审批闭环 / 提问闭环 / 多码并存） | `node --test e2e/*.test.mjs` |
| 真实链路 | **18 项/轮全绿**：生产入口 1 轮、本地中继 3 轮；助手正文 114/162 字与 2 条工具行确实到了手机 | `node e2e/live-e2e.mjs` |
| 二维码 | zxing-cpp 真实解码 28/28 | `node scripts/validate-qr.mjs` |
| 生产 | 跑的是 `relay.mjs`（单文件，`/healthz` 报 `version: 2.0.0`），journalctl 无 warning | `curl https://drc.provid.cc/healthz` |
| **未取证** | 真机上的**审批卡与提问卡**：见 §1.1 | — |

### 1.1 唯一没能在真机上取证的两条（诚实记账，不许当成已通过）

- **审批**：`kernel.approvalFace` 在真宿主上是 `"registered"`——插件确实**登记成了
  `approval/request` waterfall 的参与者**。但本机这些会话的工具全部被宿主策略直接放行
  （`schedule_create` 之类不问就跑了），审批**从未发起**，所以"卡片推给手机 → 手机点批准 →
  内核继续"这一整条只在**本地全链路**里验过（`e2e/mp-client.test.mjs` 第 5 条 +
  `e2e/run.mjs` 第 7 步）。要补的真机取证：在桌面里开一个会问的会话/策略，再跑
  `node e2e/live-e2e.mjs --session <那个会话 id> --prompt <会触发审批的指令>`。
- **提问**：`kernel.questionsFace` 在真宿主上是 `"no userQuestions provider"`——
  这一代宿主没暴露 `userQuestions.registerProvider`，模型自己也说没有 AskUserQuestion 工具，
  所以**接管路径在本机不可能跑起来**（不是代码问题，但也不能写作已验证）。
  本地闭环有测试：`e2e/mp-client.test.mjs` 第 6 条 + `e2e/run.mjs` 第 9 步。

## 2. 快速恢复环境

```sh
cd /Users/linbin/dsh-remote-control
env -u NODE_OPTIONS pnpm install          # §4.1：必须 env -u NODE_OPTIONS
env -u NODE_OPTIONS pnpm -r typecheck
env -u NODE_OPTIONS pnpm -r test
./scripts/relay-start.sh --bundle          # 本地中继（token 复用 profile 里那份）
./scripts/install-to-profile.sh            # 构建 + 装插件；之后必须重启 Harness
osascript -e 'tell application "DeepSeek Harness" to quit'; sleep 6; open -a "DeepSeek Harness"
node e2e/live-e2e.mjs                      # 真链路（本机 Harness 必须在跑）
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
  PSK 只在二维码里。**后果**：旧 host + 新中继能兼容（多余字段被 zod strip），
  **新 host + 旧中继会硬失败**（旧中继要求 `pair-begin.psk` 是 ≥16 字符的字符串）。
  所以回滚单位是"中继产物 + 插件产物**成对**回滚"，不是只回滚一边。
- **D3/D6：会话跨断连存活**（这是这次的产品级卖点：手机回前台不再要求重新扫码）。
  代价是必须有一条"主机不认得这条 convId"的出口，见 §5 的 R1 三件套。
- **D5：`auth`/`auth-ok`/`auth-fail` 并入 `hello`/`hello-ok`**；失败统一 `error{bad_token}`。
- **D9：apiProxy / typert 两个弱 carrier 整个删掉**，只留 `services` + `mock`。
- **F6：`pair-fail.reason` 只能是小程序能翻译的四个**。中继的全局限速原因
  （`rate_limited`）只进日志，线上写 `invalid_or_expired`——弹英文给用户是不允许的。
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

## 5. 已知缺陷 / 下一步

1. **真机审批与提问取证**（§1.1）。需要一个会真的弹审批的会话，以及一个暴露
   `userQuestions` 提供者的宿主版本。
2. **host 侧 conversations 没有上界**（DESIGN-REVIEW 🟡8）：中继会 idle-drop 会话，
   但主机的 `ConversationBook` 只在 `voidConversation`/`closeBefore` 时删。
   现在靠 R1 的 `session-leave` 兜住大部分情形，长期跑仍需一个 TTL。
3. **e2e 收尾句柄**：`node e2e/run.mjs` 1.2s 就打完全绿，但进程约 60s 后才退出
   （某个 ~60s 定时器没被 `stop()` 清掉；`sleep-policy` 的 `pendingRefreshMs` 是首要嫌疑）。
   不影响判定，只让 CI 多等一分钟。
4. `docs/SECURITY.md` / `SELF-HOSTING.md` / `MINI-PROGRAM.md` 仍描述旧实现的具体路径与
   帧名，需要按 §3 的偏离重写（`deploy/README.md` 已经改过）。
5. 慢消费者 1008 与小程序 12s 超时/30s 退避可能形成循环（阈值的取值来自参考实现，
   不是实测；DESIGN-REVIEW 🟡11）。

## 6. 命令速查

```sh
env -u NODE_OPTIONS pnpm -r typecheck && env -u NODE_OPTIONS pnpm -r test
env -u NODE_OPTIONS node e2e/run.mjs
env -u NODE_OPTIONS node --test e2e/restart-resume.test.mjs
env -u NODE_OPTIONS node e2e/live-e2e.mjs --rounds 3
env -u NODE_OPTIONS node scripts/validate-qr.mjs
./scripts/relay-start.sh --bundle; ./scripts/install-to-profile.sh
curl -s https://drc.provid.cc/healthz
node scripts/read-session-log.mjs <sessionId> --tail 20      # 内核侧真相
cat ~/.dsh/dsh-remote-control/status.json                      # 插件侧真相
```
