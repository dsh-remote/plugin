# 测试与工具链规格（从零重写用）

> 目的：把旧实现「是怎么被验证的」提取成需求。重写后的可信度**不得低于**本文所列口径。
> 本文只描述验收口径与工具链事实，不给实现方案。
>
> 证据锚点约定：`（证据：文件:行号）`＝该结论可直接在仓库现有文件中核对；
> `推断：`＝由代码中的超时预算/结构推导，仓库内无实测记录（本文作者**未执行**任何测试，
> 以免影响用户正在运行的 Harness 与线上中继）。
> 所有行号基于 2026-10-02 的仓库状态（`e2e/live-e2e.mjs` 310 行版本）。

---

## 1. 测试金字塔现状

### 1.1 分层与其证明力

| 层 | 命令 | 证明什么 | 证明到什么程度 | 前置条件 |
|---|---|---|---|---|
| **单测（纯函数/降级）** | `env -u NODE_OPTIONS pnpm -r test` | protocol 的密码学对合与篡改拒绝、三平台防休眠命令构造；plugin 的激活降级、carrier 优先级、配置校验、状态文件、终端二维码几何、会话列表/归档/瀑布黑名单、delta 窗口化；server 的双向 opaque 转发、一次性码、限流、帧上限、优雅停机 | **不接触真实内核、不接触线上**；全部走 stub/mock 注入面（如 plugin 用 cordis 上下文桩、server 用裸 WebSocket） | 只需 Node ≥20 + `pnpm install`；`test` 脚本内嵌 `pnpm build`（证据：`packages/plugin/package.json:29`、`packages/protocol/package.json:15`） |
| **mp 跨运行时对拍** | `node --test e2e/mp-crypto.test.mjs` | 小程序侧 `mp/core/codec.js`（vendored nacl + js-base64，无 Buffer）与 Node 侧 `packages/protocol` **逐字节一致**：base64、UTF-8、双向派生密钥、MP 加密→Node 解密、Node 加密→MP 解密、篡改/错钥拒绝、大载荷、QR 解析器一致、nonce 前缀与单调性 | 只证明线格式两侧兼容；不碰网络 | 只需 `packages/protocol/dist` 已构建（证据：`e2e/mp-crypto.test.mjs:16-27`） |
| **relay e2e（本地全栈）** | `node e2e/run.mjs` | 真实 spawn 中继 + 真实 `HostRuntime` + `MockHarnessBridge` + 手写模拟小程序，走完 9 步闭环，并做**零知识审计** | 证明「协议+中继+主机运行时」这一整条链路能协同；主机是 **mock 内核**，故不证明任何真实内核挂接（证据：`e2e/run.mjs:82`） | 仅需本机端口 18793 空闲（证据：`e2e/run.mjs:17`） |
| **小程序客户端全闭环** | `node --test e2e/mp-client.test.mjs` | **真实的 `mp/core/client.js`**（经 wx shim）对真实中继 + mock 内核跑完配对/列表/delta→工具→审批→收尾/提问/防休眠/中断/nonce 唯一/失效会话降级 | 证明生产路径「除微信渲染器外」全部正确（证据：`e2e/mp-client.test.mjs:4-6`） | 端口 18794；`packages/plugin/dist` 必须已构建（证据：`e2e/mp-client.test.mjs:31-32`） |
| **live-e2e（真实链路）** | `node e2e/live-e2e.mjs` | 三个真实（见 §2）：真实小程序代码 + 线上/指定中继 + 本机真实内核，含真实发一条指令与上行密文审计 | 唯一能证明「线上部署 + 真实内核」的层；**任何一步拿不到真实材料就失败，绝不退化** | 本机 Harness 在跑且 `carrier=services`、`relay=online`、`pairOnStartSec` 开启、中继可达（证据：`e2e/live-e2e.mjs:36,80,106-113`） |
| **二维码真实解码** | `node scripts/validate-qr.mjs` | 插件产出的二维码 PNG（与终端矩阵）**被第三方解码器 zxing-cpp 扫出来且内容逐字节一致**，28 组（7 载荷 × 4 纠错级），含 CJK 与公网 URL | 功能级校验，不做逐位比对（证据：`scripts/validate-qr.mjs:5-9`） | 需 `packages/plugin/dist/src/qr.js` 已构建 + 本机 python venv 装有 zxing-cpp/pillow（证据：`scripts/validate-qr.mjs:25-36`） |
| **部署冒烟** | `node scripts/verify-deployment.mjs [--pair --qr]` | 部署后的中继 + 装进 profile 的插件产物 + 真实小程序代码可跑通闭环 | **默认可自建 mock 主机 → 会假通过**，只配当部署冒烟（见 §4） | `--url`/profile 里的 host token，或 `--pair`+`--qr` 连正在运行的主机（证据：`scripts/verify-deployment.mjs:45-67`） |

### 1.2 「83 项单测」的真实口径

README 与 HANDOFF 都声称 83 项（证据：`README.md:56`、`HANDOFF.md:17`）。
**按 `node:test` 顶层 `test(...)` 用例逐文件数到 83，与声称一致**，口径与分布：

| 文件 | test() 数 | 行号（用例起点） |
|---|---|---|
| `packages/protocol/tests/crypto.test.ts` | 6 | :17,25,40,47,61,74 |
| `packages/protocol/tests/keepawake.test.ts` | 5 | :5,11,17,24,32 |
| `packages/plugin/tests/apply.test.ts` | 9 | :60,72,83,108,136,173,192,201,216 |
| `packages/plugin/tests/listing.test.ts` | 15 | :33,79,101,117,132,151,171,203,249,276,303,348,363,373,383 |
| `packages/plugin/tests/qr.test.ts` | 7 | :5,22,28,44,75,83,104 |
| `packages/plugin/tests/windowing.test.ts` | 5 | :70,83,96,115,129 |
| `apps/server/tests/relay.test.mjs` | 2 | :44,97 |
| `apps/server/tests/hardening.test.mjs` | 11 | :78,91,111,131,145,174,184,204,211,218,235 |
| `e2e/mp-crypto.test.mjs` | 11 | :34,44,59,66,78,93,106,112,125,139,148 |
| `e2e/mp-client.test.mjs` | 8 | :101,120,129,161,179,188,197,209 |
| `e2e/mp-platform.test.mjs` | 3 | :39,65,125 |
| `e2e/multi-pair.test.mjs` | 1 | :61 |
| **合计** | **83** | protocol 11 + plugin 36 + server 13 + e2e 23 |

统计口径必须写清（否则重写后对不上数）：

- 83 **只数 `node:test` 的 `test()` 用例**；不含 `e2e/run.mjs` 的 9 个 step（证据：`e2e/run.mjs:81,93,114,122,149,162,174,188,198`）、
  不含 live-e2e 的 10 项/轮（证据：`README.md:98-99`）、不含 validate-qr 的 28 组（证据：`README.md:100`）。
- 83 **含 e2e 的 4 个 node:test 文件**——它们其实已经是集成/e2e 测试，「单测」这个词是混用的。
  真实含义是 `pnpm -r test` 会跑到的用例总数（`e2e/package.json:6` 把 4 个 `node --test` 串上 `node run.mjs`）。
- **不得重复计数 `dist/tests/`**：`packages/{plugin,protocol}/dist/tests/*.test.js` 是 tsc 产物副本
  （10 个文件），`test` 脚本只跑 dist 版本，源码只有一份（证据：`packages/plugin/package.json:29`）。
- 全仓无 `describe`/子测试嵌套（核对：`grep -nE "^describe\(|t\.(test|subtest)\("` 对这些文件为空），
  所以「test() 个数 == 用例数」成立。
- **重数时的坑**：`e2e/mp-crypto.test.mjs` 内含非文本字节，普通 `grep` 会当二进制并只报
  "Binary file matches"，必须 `grep -a`（本文实测命中此现象）。
- 文档里「3 轮连跑 24 项」与「10 项/轮」不自洽（3×10=30）（证据：`HANDOFF.md:19`、`.workbuddy/memory/2026-10-02.md:32`）。
  推断：那 24 项来自 `--no-prompt` 的 3 轮（每轮 8 项：步骤 7 的 2 项断言被跳过）。
  重写时**不要抄这两个数字**，按 §2.6 的检查点清单重新推导。

### 1.3 耗时与前置条件汇总

推断（按代码超时预算上界，非实测）：

| 命令 | 上界构成 | 典型 |
|---|---|---|
| `pnpm -r test`（不含 e2e） | 两次 tsc 全量编译占大头；测试本身秒级 | 30–90s |
| `apps/server` 13 项 | hardening 每项**各自 spawn 一个中继**并轮询 `/healthz` ≤8s（证据：`apps/server/tests/hardening.test.mjs:16-35`），SIGTERM 项再等 ≤8s+3s | 40–90s |
| `e2e/mp-crypto.test.mjs` | 纯计算，无 sleep 预算 | <5s |
| `node --test e2e/mp-client.test.mjs` | 启中继 ≤8s + 8 项各 5–8s 超时预算（证据：`e2e/mp-client.test.mjs:43-51,114`） | 15–40s（回合类失败才逼近上界） |
| `node --test e2e/multi-pair.test.mjs` | 启中继 ≤8s + relay 上线轮询 ≤4s + 断言 ≤8s（证据：`e2e/multi-pair.test.mjs:31-40,82,123`） | 5–15s |
| `node e2e/run.mjs` | 9 步，各步 1.5–6s 超时预算 + 固定 300ms/50ms 等待（证据：`e2e/run.mjs:89,191`） | 5–20s，上界约 60s |
| `node e2e/live-e2e.mjs`（完整轮） | 取码 ≤150s×最多 3 次尝试 + 配对 ≤25s + 列表 ≤20s + 防休眠 ≤15s + 回合 ≤90s + 解配 400ms（证据：`e2e/live-e2e.mjs:70,151,163,195,215,230,287`） | 1–2min，上界约 7min |
| `node e2e/live-e2e.mjs --no-prompt` | 省掉 90s 回合预算 | <1min |
| `node scripts/validate-qr.mjs` | 28 组 × 每组「PNG 解码 + 矩阵解码」两次 zxing 调用，单进程 python（证据：`scripts/validate-qr.mjs:78-98`） | 10–40s |

是否需要本机 Harness 在跑：只有 **live-e2e** 与 **verify-deployment 的 attach 模式**需要
（证据：`e2e/live-e2e.mjs:74-91`、`scripts/verify-deployment.mjs:106-108`）。
是否需要线上中继可达：live-e2e 默认打 `wss://drc.provid.cc`，但 `--url` 可指向本地中继
（证据：`e2e/live-e2e.mjs:37-38`）；`scripts/verify-deployment.mjs:59` 默认同样是线上地址，且会先打 `/healthz`（证据：`scripts/verify-deployment.mjs:94-101`）。

### 1.4 另外两个 mp 测试（本文不展开，他人负责）

- `e2e/mp-crypto.test.mjs`：**跨运行时线格式一致性**——小程序侧实现必须与 Node 侧逐字节对合，
  红了就意味着两端根本无法对话（证据：`e2e/mp-crypto.test.mjs:1-9`）。
- `e2e/mp-platform.test.mjs`：**传输能力探测/回退**——守护真实手机上报的
  `wx.connectSocket is not a function`：缺能力必须给出可读的类型化错误而非 TypeError，
  仅有旧式全局回调 socket 的容器仍要能连能发（证据：`e2e/mp-platform.test.mjs:8-20`，用例 :39,65,125）。

---

## 2. live-e2e 的「三个真实」机制 —— 原文提取为重写的验收标准

设计声明写在文件头：**三个真实**＝真实小程序客户端代码（`mp/core/client.js` 经 wx shim 在 Node 里跑）、
真实中继（默认线上 `wss://drc.provid.cc`，nginx+TLS）、真实内核载体（本机 Harness 里运行的插件，`carrier=services`）
（证据：`e2e/live-e2e.mjs:5-8`）。与 `verify-deployment` 的区别与「假通过比失败更贵」的立场
（证据：`e2e/live-e2e.mjs:10-12`、`HANDOFF.md:152-154`、`docs/MINI-PROGRAM.md:133-135`）。

以下 2.1–2.6 每一条都应作为新实现的**验收标准条款**原样保留语义。

### 2.1 真实小程序代码怎么被加载（不是重写一份客户端）

- shim 只提供**客户端核心真正用到的 API**：`wx.getStorageSync/setStorageSync/removeStorageSync`
  与 `wx.connectSocket`→SocketTask（用 `ws` 包兜底，含 `onOpen/onMessage/onClose/onError/send/close`），
  页面用的 `showToast/showModal/vibrate*` 一律空实现（证据：`e2e/mp-sim.mjs:9-11,25-65`）。
  WHY：shim 面积越小，「测试里能过、真机上不行」的缝隙越小；页面 API 不参与协议，故可空。
- `globalThis.wx` 装好之后，才用 `createRequire` 以 **CommonJS** 方式加载
  `mp/core/codec.js`、`mp/core/session-store.js`、`mp/core/client.js` 三个**将要发布进小程序的同一批文件**
  （证据：`e2e/mp-sim.mjs:71-77`、`mp/core/package.json:3-4`）。
  WHY：CI 打不开微信开发者工具，所以「客户端怎么被验证」只能是让生产产物本身在 Node 里跑
  （证据：`e2e/mp-sim.mjs:4-7`）。
- 顺序是硬约束：**shim 必须先于 mp/core 加载**（证据：`e2e/mp-client.test.mjs:26-28`、`e2e/live-e2e.mjs:116-118`）。
- 验收标准新写法：**禁止在新实现里出现「测试专用客户端」**。任何对 mp 客户端的验证都必须
  加载将要打进小程序包的那份文件；改 `mp/core/*.js` 后必须同时跑
  `mp-crypto`（对拍）+ `mp-client`（闭环）+ `mp-platform`（探测）（证据：`HANDOFF.md:145-146`）。

### 2.2 真实配对码怎么拿到，以及为什么只接受 age<25s 且本轮未用过的码

- 配对码来源是插件写在 `~/.dsh/dsh-remote-control/status.json` 的 `pairing`（需要 profile 开 `pairOnStartSec`）
  （证据：`e2e/live-e2e.mjs:36,81`）。轮询 1.5s，最长 150s，拿不到就 `throw`（证据：`e2e/live-e2e.mjs:70-99`）。
- 逐条准入判定（证据：`e2e/live-e2e.mjs:80-91`）：
  1. `status.json` 不存在 → 理由「插件没跑？」；
  2. `d.relay !== 'online'` → 带上真实 relay 状态；
  3. 无 `pairing.qr` → 提示 `pairOnStartSec` 未开；
  4. `used.has(p.token)` → **本轮已用过（一次性）**；
  5. `ageMs > 25_000` → 「已发布 Ns，可能已被消费」；
  6. `left <= 60` → 剩余时间不足 60s 也不要。
  WHY（核心）：**配对码一次性，而 `status.json` 是按定时器刷新、不按消费刷新**——所以一个看起来
  「还没过期」的码很可能已经被上一轮/别人消费掉，用它配对会以「配对失败」这种**假原因**失败
  （证据：`e2e/live-e2e.mjs:64-69,85-90`、`HANDOFF.md:120-121`、`.workbuddy/memory/2026-10-02.md:13-15`）。
- 每个失败理由都要被记住并打印（`lastReason`，证据：`e2e/live-e2e.mjs:72,99`）；WHY：这类测试最大的成本是
  「红了但不知道为什么红」，所以诊断信息属于验收标准的一部分。
- `usedTokens` 是**进程级 Set**，跨 `--rounds` 累加（证据：`e2e/live-e2e.mjs:294,111-112,152-153`）。
- 显式给码路径：`--pair <6位码> --qr '<dshr:/p?…>'` **两者必须同时给**，否则视为未提供并回落到自动发布
  （证据：`e2e/live-e2e.mjs:56-62`）。
- 重试白名单极窄：只有错误信息命中 `已被使用|无效或已过期|already_used|invalid_or_expired`
  才换码重试，最多 3 次；**真实故障仍然直接失败**（证据：`e2e/live-e2e.mjs:147-182`，正则 :170）。
  WHY：把「重试」限制在一次性码的固有竞态上，避免用重试把真 bug 洗绿。

### 2.3 真实中继怎么连、连上后先证明什么

- 默认 `RELAY_URL = wss://drc.provid.cc`，可 `--url` 覆盖；HTTP 探活地址由 `ws→http` 字面替换得到
  （证据：`e2e/live-e2e.mjs:37-38`）。
- 每轮第一步先断言中继 `/healthz` 的 `ok===true`，并把 `hosts`/`clients` 计数打印出来
  （证据：`e2e/live-e2e.mjs:105-108`）。WHY：先证明「打到的是那个中继」，否则后面所有断言都没有归属对象。
- 客户端连的是**二维码里解析出的 server**，并且断言它与期望 `RELAY_URL` 一致——
  不一致直接判失败（证据：`e2e/live-e2e.mjs:119-122`）。WHY：内嵌地址错就是真实用户会连错机能的故障。
- 配对成功判据是收到 `status==='online'` 的状态事件（25s 预算），并记录耗时
  （证据：`e2e/live-e2e.mjs:157-164`）。

### 2.4 真实内核的证据（不是「我起了个 mock」）

- 会话列表必须**非空**，空列表直接判失败并注明「真实内核应有会话」（证据：`e2e/live-e2e.mjs:190-199`）。
- 列出前 5 个会话的 id/state/title 供人核对（证据：`e2e/live-e2e.mjs:202-204`）。
- **反 mock 断言**：列表里只要出现 `id.startsWith('ses_mock')` 就判失败——
  「说明连到了 mock 主机」（证据：`e2e/live-e2e.mjs:205-206`）。
- 防休眠开关必须回传 `ev.keep_awake_state` 并打印内容（证据：`e2e/live-e2e.mjs:213-219`）。
- 默认指令刻意选**不会调用任何工具**的极短回复（`只回复 ok 两个字，不要调用任何工具`），
  把真实回合的 token 成本与副作用压到最低，同时仍要求真实收尾（证据：`e2e/live-e2e.mjs:40`）。
- 目标会话选择：`--session` 优先，否则取第一个 `idle` 会话，再否则第一个（证据：`e2e/live-e2e.mjs:223`）；
  若命中 `archived` 状态则打印提示，语义是「主机应自动恢复后再执行」（证据：`e2e/live-e2e.mjs:225`）——
  这条正是归档会话自动恢复的真机证据（证据：`HANDOFF.md:21`）。
- 回合内**必须真实处理审批/提问卡**：收到 `ev.permission_request` 就 approve、
  收到 `ev.question_request` 就选第一个选项作答，并在收尾时报告「审批/提问：有/无」
  （证据：`e2e/live-e2e.mjs:245-266`）。WHY：审批/提问是远控的最高风险面，闭环里必须带上；
  旧实现的已知缺口恰恰是这块**从未在真机跑过**（本机所有会话 preset 均为 `danger-full-access` +
  `approval/policy: never`，永不弹卡）（证据：`HANDOFF.md:22`、`HANDOFF.md:175-177`）。

### 2.5 零知识怎么断言（服务端必须看不到什么）

- 断言点在**上行线上帧**：包住 `client.sendControl`，把每一个交给 socket 的控制/数据帧录下来
  （证据：`e2e/live-e2e.mjs:128-134`）。
  WHY（关键取舍）：「零知识断言要盯线上帧（outbound enc frame），不是客户端事件流——
  客户端事件里当然有明文（它本来就是解密方）」（证据：`.workbuddy/memory/2026-10-01.md:212-213`）。
- 判定式（证据：`e2e/live-e2e.mjs:274-283`）：只取 `f.t === 'enc'` 的帧，把 `ciphertext` 从 base64
  解成 latin1 字节，**不得包含指令正文 `PROMPT`，也不得包含命令名 `cmd.send_prompt`**；
  并且要求 **`encFrames.length >= 2`** 才算通过。
  WHY `>=2`：没有这个下界，「一帧都没发」也能让审计空对空通过——这是**反空判定**，必须保留。
- 更严的一版在本地 relay e2e：审计对象是客户端 socket 上观察到的**所有**帧（含下行，因为中继转什么我们看到什么），
  要求 `enc` 帧 ≥10、每帧密文 >40B、逐帧不含 `cmd.send_prompt` 与 `生成周报`，
  且**整个观测帧序列的 JSON 化文本里不得出现 `周报`**（证据：`e2e/run.mjs:48-52,198-213`）。
- 中继侧的结构性证据：服务器只搬运 `{t:'enc', sessionId, seq, ciphertext}`，
  明文只出现在控制面（`hello/auth/pair-begin/paired/peer-joined`）且不含业务内容
  （证据：`docs/SECURITY.md:16-25`、`apps/server/src/main.mjs:347-356`）。
  中继日志一行一条 JSON，字段只有 `hostId/clientId/sessionId/pairingToken/ttlMs/code/message` 这类标识与计数
  （证据：`apps/server/src/main.mjs:272,294,340,387,402`、`deploy/README.md:93-94`）。
  推断：`apps/server/tests/hardening.test.mjs:22-28` 已经把 stdout/stderr 收集成 `lines`，
  但当前**没有任何一条断言使用它**——即「日志里不含明文」这件事在旧实现里靠代码结构（中继不解密）
  与 `run.mjs` 的帧审计成立，而不是靠日志断言。重写时这是可以直接加强的点（见 §8）。

### 2.6 失败时绝不退化为 mock：机制与检查点清单

- 结构上无法退化：mock 桥接只存在于 `verify-deployment` 的自建主机分支
  （证据：`scripts/verify-deployment.mjs:110-121`）；`live-e2e` **没有任何构造主机的代码路径**，
  取码只有「读 status.json」或「用户显式给码」两条（证据：`e2e/live-e2e.mjs:56-100,111`）。
- 历史成因必须写进新实现的理由里：旧 `verify-deployment` 的自建主机模式会在拿不到真实配对码时
  **静默退化成 mock 并通过**，掩盖了「配对成功但主机把 peer 丢了」这类真实故障
  （证据：`.workbuddy/memory/2026-10-02.md:4-6`、`docs/MINI-PROGRAM.md:133-135`）。
- 收尾纪律：任何一步异常都进入 `bad()`/`throw`，最后 `failures>0` 就 `exit 1`；
  多轮循环里单轮异常也被计入失败而不是跳过（证据：`e2e/live-e2e.mjs:296-309`）。
- 每轮检查点（完整模式 10 项，`--no-prompt` 为 8 项）：
  ① 中继可达；② 真实主机发布配对码；③ 小程序解析出中继地址与 PSK；④ 配对成功；
  ⑤ 收到非空真实会话列表（且无 mock 会话）；⑥ 防休眠回传；⑦ 流式输出到达；⑧ 回合正常收尾；
  ⑨ 零知识上行帧全密文；⑩ 解配后状态正确（证据：`e2e/live-e2e.mjs:107,113,122,164,201,216,259,266,280,288`，
  与 `README.md:99` 的「10 项/轮」一致）。
  附加（真实环境弹出时才计）：审批卡到达、提问卡到达（证据：`e2e/live-e2e.mjs:246,252`）。
- 失败可诊断性：配对失败时打印最后 8 个事件的 `kind:status/payload.t` 轨迹
  （证据：`e2e/live-e2e.mjs:171-174`）；文档明确这是定位「服务端显示 paired、客户端却没反应」的关键
  （证据：`docs/MINI-PROGRAM.md:145-146`）。

### 2.7 用法面（重写要保留的开关）

`node e2e/live-e2e.mjs`（完整闭环，含发一条指令）、`--no-prompt`（只验证配对/列表/防休眠）、
`--rounds N`（连跑查稳定性）、`--session <id>`、`--prompt '…'`、`--url`、`--pair`+`--qr`
（证据：`e2e/live-e2e.mjs:14-18,37-40`、`README.md:104-109`、`docs/MINI-PROGRAM.md:137-143`）。
注意：`--rounds` 的跨轮一次性码保护依赖进程级 `usedTokens`（证据：`e2e/live-e2e.mjs:294`），
所以**多轮必须在一个进程里跑完**，不能靠外部 shell 循环多次调用（否则同一码会被跨进程重复使用）。
推断：`live-e2e` 没有任何 npm script / CI 引用（本仓 `grep -rn live-e2e package.json **/package.json .github` 为空），
它是**人工触发的最高级验收**，这一点在新实现里应改成有明确记录的执行约定（见 §7、§8）。

---

## 3. multi-pair 回归测试在守护什么

**它守护的旧 bug**：主机可以同时挂着多个配对码（自动发布的码 + 一次 `/drc pair`，或 TTL 内两次 `/drc pair`）。
旧实现把 pending pair 存成**单槽**，于是主机用「最近一个码」的 PSK 去派生会话密钥，
而客户端用的是「它实际扫的那个码」的 PSK——两端密钥不同：**每一个载荷都解不开，会话列表永远空，
UI 只显示一句莫名的「无法解密」**（证据：`e2e/multi-pair.test.mjs:1-10`）。
修复方式：`pendingPairs: Map<token, {psk, expiresAt}>`，服务端 `peer-joined` 回传 `pairingToken`，
按**客户端实际使用的码**取 PSK（证据：`HANDOFF.md:117-119`）。
相关同源事故记录（主机按自己请求的 60s 记过期、服务端实给 180s，导致 PSK 被提前清扫→静默丢 peer→
「配对成功但什么都解不开」）见 `.workbuddy/memory/2026-10-02.md:19-22` 与 `HANDOFF.md:114-116`。

**断言（必须在新实现里等价保留）**：

1. 两个码同时存在且**互不相同**：`rt.createPairing(60_000, { includeToken: true })` 调两次，
   `assert.notEqual(first.token, second.token)`，再等 400ms 让两条 `pair-ready` 落地
   （证据：`e2e/multi-pair.test.mjs:85-90`）。
2. 客户端用 **第一个（不再是最新）** 的码配对：
   `assert.equal(paired.t, 'paired', 'the earlier token must still be claimable')`
   （证据：`e2e/multi-pair.test.mjs:95-102`）。
3. 密钥只从**所用那个码的 QR 里的 PSK** 派生（`c2h`/`h2c` 双向）（证据：`e2e/multi-pair.test.mjs:92,105-106`）。
4. 发 `cmd.list_sessions` 后，**主机发来的每一个 `enc` 帧都必须能用我们的密钥解开**：
   `assert.ok(payload, 'host reply must decrypt with the PSK of the code we used')`
   ——这条是关键：连主机在 join 时推的 keep-awake 状态帧都要能解，任何一帧解不开就红
   （证据：`e2e/multi-pair.test.mjs:120-131`）。
5. 该命令的 `ev.result` 必须到达且 `data.sessions` 是数组（证据：`e2e/multi-pair.test.mjs:133-134`）。
6. 环境隔离：独立端口 18931、独立 host token、`DRC_LOG_LEVEL=warn`、`t.after()` 负责杀进程与停主机
   （证据：`e2e/multi-pair.test.mjs:24-41,61-65,81`）。

WHY 这一层值得单独存在：它是「**配对成功之后**才暴露」的故障类别——握手全绿、数据全废。
新实现只要允许多码并存（自动发布 + 手动），就必须有这条回归。

---

## 4. verify-deployment 的「假通过」陷阱

### 4.1 自建主机模式为什么会假通过

`scripts/verify-deployment.mjs` 有两条模式（证据：`scripts/verify-deployment.mjs:35-47`）：

- **默认（自建）**：从 profile 里装的插件产物（或仓库 `dist`）`import { HostRuntime, MockHarnessBridge }`
  并**自己起一个 mock 内核主机**（证据：`scripts/verify-deployment.mjs:70-75,110-121`）。
- **attach（`--pair` + `--qr`）**：配对**正在运行的真实主机**（证据：`scripts/verify-deployment.mjs:106-108`）。

默认模式会产生假通过，原因有四条，逐条都在代码里：

1. **主机是 mock 桥接**，所以「真实内核有没有挂上」（`carrier=services` vs `mock`）这件事根本没进入被测量。
2. **反 mock 断言只在 attach 模式下才生效**：`mockish` 在 :161 被计算出来，但用它判失败的分支
   在 `if (ATTACH_MODE)` 里面（证据：`scripts/verify-deployment.mjs:161,167-175`）。
   自建模式下**满屏 mock 会话照样打印 ✅**（证据：`scripts/verify-deployment.mjs:162`）。
3. **空列表也算通过**：`ok('收到加密会话列表（N 个会话）')` 不判断 N 是否 >0
   （证据：`scripts/verify-deployment.mjs:162`），而 live-e2e 对同一件事是 `bad()`
   （证据：`e2e/live-e2e.mjs:199`）。
4. **零知识判定弱一档**：`enc.length >= 1`（证据：`scripts/verify-deployment.mjs:235`）
   vs live-e2e 的 `>= 2`（证据：`e2e/live-e2e.mjs:279`）；且泄露特征写的是泛化子串 `cmd.`
   （证据：`scripts/verify-deployment.mjs:233`）而非具体命令名，容易被「根本没发数据」绕过。

历史证据：正是这个「自建主机模式」在拿不到真实码时静默退化成 mock 并通过，掩盖了真实故障，
才逼出了 `live-e2e`（证据：`.workbuddy/memory/2026-10-02.md:4-8`、`e2e/live-e2e.mjs:10-12`）。

另外两个会误导人的细节：
- 对真实主机发指令会**真的触发一次 agent 运行**（花 token、动工作区、调工具），所以 attach 模式默认跳过发送，
  必须显式 `--send-prompt` 才发（证据：`scripts/verify-deployment.mjs:177-184`）。
- 回合收尾判定刻意兼容「首帧即含 done」，并把「审批卡」与「收尾」竞速判定
  （证据：`scripts/verify-deployment.mjs:194-224`）——这是被窗口化合并咬过的产物
  （同一坑见 `HANDOFF.md:123-128`）。

### 4.2 它只能用于什么

**只用于部署冒烟**：证明「这台机器上装的插件产物 + 这个中继 + 小程序客户端代码」三者版本互相兼容、
网络与 TLS 通、host token 配对了（证据：`scripts/verify-deployment.mjs:1-19`）。
`HANDOFF.md:154-155` 明确写：「有『自建主机模式』会假通过——只用于部署冒烟，别拿它当功能验证」。
它比 live-e2e 多出来的唯一价值是：**加载的是 profile 里已安装的产物**
（`<profile>/node_modules/dsh-remote-control/dist/src/index.js` 优先于仓库 dist，证据：`scripts/verify-deployment.mjs:70-71,88-90`），
因此能抓出「构建产物没装进去/装歪了」这类纯部署故障。

### 4.3 新实现要设计成什么样才不重蹈

（口径，不给方案）

1. **任何工具都不允许「拿不到真实材料就用替身继续并返回成功」**。降级路径要么不存在，
   要么必须让最终退出码变红（`live-e2e` 的做法是直接 `throw`/`bad()` 后 `exit 1`，证据：`e2e/live-e2e.mjs:99,306-308`）。
2. **mock 与真实必须在输出里显式对消费者可见**：状态文件的 `carrier` 字段就是为此存在的
   （`services`=真实内核 / `mock`=假会话，证据：`HANDOFF.md:25`、`README.md:126,130`）。
   判真实的测试应当**直接读 `carrier`**（旧实现只在会话 id 前缀上判，证据：`e2e/live-e2e.mjs:205`）——推断：新实现应两者都判。
3. **每个「收到 X」的判定都必须带最小数量下界**（列表非空、审计帧 ≥2），
   否则就是空判定（对照 `verify-deployment.mjs:162,235` 与 `e2e/live-e2e.mjs:199,279`）。
4. **同一份冒烟工具的两个模式要给出不同名字或不同退出语义**，避免「跑成功了」被误读为「真实链路 OK」。
5. 部署冒烟应继续用「**已安装产物优先**」的解析顺序（证据：`scripts/verify-deployment.mjs:70-71`），
   这是它唯一不可替代的信号（同类坑：`install-to-profile.sh` 的硬链接拷贝问题，见 §5.2）。

---

## 5. 脚本清单与职责

### 5.1 `scripts/relay-start.sh` —— 本地起中继，token 从 profile 借

- 作用：用**和桌面 profile 插件同一个 host token** 起中继，开箱即用两边一致
  （证据：`scripts/relay-start.sh:1-8`）。
- 输入：环境变量 `DRC_HOST_TOKEN`（显式覆盖）、`DRC_PORT`（默认 8787）、`PATCH_FILE`（默认
  `~/.dsh/profiles/desktop/cordis.patch.yml`）；无位置参数。
- 关键实现事实：token 缺失时用 **awk 在 `- id: dsh-remote-control` 块内抓 `hostToken:`**，
  并剥掉引号（证据：`scripts/relay-start.sh:17-29`）；找不到就 `exit 1` 并提示手设
  （证据：`scripts/relay-start.sh:31-34`）。
- 输出：`export DRC_HOST_TOKEN / DRC_PORT / DRC_PUBLIC_URL`（默认 `ws://127.0.0.1:$DRC_PORT`），
  然后 `exec node ../apps/server/src/main.mjs`（证据：`scripts/relay-start.sh:36-41`）。
- 坑：日志只打印 token **前 6 个字符 + 省略号**，不泄露全串（证据：`scripts/relay-start.sh:40`）；
  `PATCH_FILE` 的块匹配依赖 `^- id: dsh-remote-control$` 这个精确缩进/锚点，profile 里写法一变就读不到
  （证据：`scripts/relay-start.sh:23`）。推断：与 `verify-deployment.mjs:51-57` 的解析器是**两份独立实现**，
  新实现应统一成一个来源，否则两处对同一 YAML 的理解会漂移。

### 5.2 `scripts/install-to-profile.sh` —— 构建 + 装进 profile + 注册 bundle

- 作用与存在理由：**pnpm 把 `file:` 依赖装成拷贝而不是符号链接**，所以单跑 `pnpm -r build`
  根本不会更新 Harness 真正加载的那份插件；此脚本按顺序做「构建 + 重装 + 注册 bundle」
  （证据：`scripts/install-to-profile.sh:1-11`、`README.md:74-75`、`HANDOFF.md:74-75`）。
- 输入：`DSH_PROFILE`（默认 `~/.dsh/profiles/desktop`）；无参数。目录不存在直接 `exit 1`
  （证据：`scripts/install-to-profile.sh:17,19-22`）。
- 步骤：
  1. `pnpm -r build`（证据：`scripts/install-to-profile.sh:24-25`）；
  2. **按 package.json 里的声明判断是否已装**，而不是看目录是否存在
     ——因为一次失败的安装可能留下「目录没了但 package.json 仍列着依赖」的状态，
     此时重跑 `pnpm add` 会**重新解析 profile 里每一个 GitHub tarball**，网络一抖就卡死
     （证据：`scripts/install-to-profile.sh:29-33`）；
  3. 已装则 **`rm -rf "$TARGET"` 再 `cp -R`**（`dist`、`package.json`、`cordis.patch.yml`、`README.md`）
     ——注释写明：`pnpm add` 会重新解析全部依赖，而 pnpm 对 `file:` 是**硬链接**，重建后 inode 变了
     profile 里还是旧副本，所以只替换树、不走网络（证据：`scripts/install-to-profile.sh:34-44`）；
  4. 首次安装才 `pnpm add -w --prefer-offline "file:$PLUGIN"`，并先备份
     `package.json.bak-drc-<ts>`（证据：`scripts/install-to-profile.sh:45-49`，备份位置亦见 `HANDOFF.md:168`）；
  5. 用内联 node 脚本把 `dsh-remote-control` 追加进 `package.json` 的 `dsh.profile.bundles`
     （证据：`scripts/install-to-profile.sh:51-62`）。
- 输出/收尾提示：**必须重启 Harness**（新包不热载），然后看日志里的
  `carrier=dsh`；若是 `carrier=mock` 说明真实内核桥没挂上（证据：`scripts/install-to-profile.sh:64-68`）。
  与 `HANDOFF.md:71-73`（HMR 只热更 `cordis.patch.yml` 配置、不重新 import dist）一致。
- 坑（新实现必须保留这条知识）：**「先删再装」不可省**；以及插件装进外部 profile 后
  `workspace:*` 依赖无法解析（见 §5.7、`HANDOFF.md:82-84`）。

### 5.3 `scripts/verify-deployment.mjs` —— 部署冒烟

见 §4 全文。补充输入输出：`--url/--token/--label/--pair/--qr/--prompt/--session/--send-prompt`、
env `DRC_PROFILE`（默认 `~/.dsh/profiles/desktop`）、env `DRC_HOST_TOKEN`；
token 解析优先级：`--token` > `process.env.DRC_HOST_TOKEN` > profile 的 `hostToken`
（证据：`scripts/verify-deployment.mjs:45-61`）。没有 token 且不是 attach 模式 → `exit 2` 并提示两种出路
（证据：`scripts/verify-deployment.mjs:63-67`）。探活用 `AbortSignal.timeout(10_000)`（证据：`scripts/verify-deployment.mjs:96`）。
输出是逐条 ✅/❌ + `failures` 计数，>0 则 `exit 1`（证据：`scripts/verify-deployment.mjs:246-250`）。

### 5.4 `scripts/validate-qr.mjs` —— 二维码功能级真实解码

- 作用：证明 `/drc pair` 产出的东西**扫得出来且内容逐字节一致**（证据：`scripts/validate-qr.mjs:9`）。
- 为什么不逐位比对：不同编码器在 ISO 18004 下对 terminator 之后的填充字节选择不同
  （`0xEC/0x11` vs 补齐到码字边界），矩阵逐位不同但解码相同——逐位比会被合法差异干扰
  （证据：`scripts/validate-qr.mjs:5-8`）。曾经手写过编码器，正是这个校验器抓出系统性差异后才改为 vendoring
  （证据：`scripts/validate-qr.mjs:11-12`、`docs/MINI-PROGRAM.md:117-119`）。
- 输入：无参数；依赖 `packages/plugin/dist/src/qr.js` 的 `qrMatrix`/`qrPng`（证据：`scripts/validate-qr.mjs:25-38`），
  缺产物 `exit 2`（证据：`scripts/validate-qr.mjs:27-30`）。
- 依赖的本机路径（**可移植性坑**）：解码器 python 路径是**硬编码**
  `/Users/linbin/.workbuddy/binaries/python/envs/default/bin/python`（证据：`scripts/validate-qr.mjs:32`），
  不存在则 `exit 2` 并打印建 venv 的命令（`pip install zxing-cpp pillow segno`）（证据：`scripts/validate-qr.mjs:33-36`）。
  新实现应把它变成可配置项。
- 用例矩阵：7 条载荷 × 4 个纠错级 = **28 组**，载荷含两条真实 `dshr:/p?...&psk=...&t=` 形式
  （带/不带端口）、`HELLO WORLD`、单字符 `a`、纯数字、带 query 的 https URL、**CJK 载荷**
  （证据：`scripts/validate-qr.mjs:40-53`，`README.md:100` 的 28 组由此而来）。
- 每条用例**解两次**：先解 `qrPng(text, ecc, {scale:8})` 的 PNG（这才是给用户的主产物），
  再把 `qrMatrix(text, ecc, 2)` 渲染成带 4px 静默区的位图扫一遍
  （证据：`scripts/validate-qr.mjs:56-68,78-98`）。WHY：矩阵路径等价于「把终端输出截屏去扫」（证据：`scripts/validate-qr.mjs:56-57`）。
- 判定：解码结果必须 `=== text`（逐字节），否则列期望/实得并 `exit 1`（证据：`scripts/validate-qr.mjs:115-136`）。

### 5.5 `scripts/pairing-qr.mjs` —— 把当前配对码出成 PNG 并打开（真机调试入口）

- 作用：真机上小程序用 `wx.scanCode` 扫电脑屏幕，所以要产出**图片**而不是终端字符
  （证据：`scripts/pairing-qr.mjs:4-6`）。
- 输入：`--qr 'dshr:/p?…'` 直接指定；否则读 `~/.dsh/dsh-remote-control/status.json` 的 `pairing`
  （需要 `pairOnStartSec`）（证据：`scripts/pairing-qr.mjs:8-9,39-60`）。
- 失败口径：`status.json` 不存在 → 提示插件没在发布码并查 `pairOnStartSec`；无 `pairing.qr` →
  提示改用 `/drc pair` 或 `--qr`（证据：`scripts/pairing-qr.mjs:45-54`）。
- 输出：`~/.dsh/dsh-remote-control/pairing-qr.png`（可 `--out` 覆盖），**权限 0600**，`scale:10`
  （证据：`scripts/pairing-qr.mjs:62-64`；文件实际存在于 `~/.dsh/dsh-remote-control/pairing-qr.png`，
  本文核对为 `-rw-------`）。同时打印配对码与剩余秒数（证据：`scripts/pairing-qr.mjs:57-59,66-67`）。
- 打开方式按平台选 `open`/`start`/`xdg-open`，失败只提示不报错；`--no-open` 只写图
  （证据：`scripts/pairing-qr.mjs:69-77,13`）。
- 坑：它和 live-e2e 抢同一个东西——**一次性配对码**。推断：`pairing-qr.mjs` 读的是定时器刷新的
  `status.json`，不标记消费；若真机扫码前测试脚本已把该码用掉，真机会得到 `already_used`。

### 5.6 `scripts/read-session-log.mjs` —— 内核侧取证工具

- 作用：读 DSH 会话日志 `~/.dsh/sessions/<workspace-slug>/<sessionId>/session.v4.jsonl.zstd`，
  用来**从内核自己的落盘证明「我的指令真的进了内核」**（证据：`scripts/read-session-log.mjs:14-16,28-36`）。
- 存在的唯一理由是一条硬坑：日志是 **append-only 的多帧 zstd**，单次
  `zstdDecompressSync`（或流式管道）**只解到第一帧**，拿回来的是「只有 session header」，
  读起来像「这个会话是空的」，于是人去查错方向（证据：`scripts/read-session-log.mjs:4-10`）。
  解法：按 zstd magic `28 B5 2F FD` 切帧、逐帧解、拼接（证据：`scripts/read-session-log.mjs:38-56`）。
- 容错：尾部半帧与撕裂行都要容忍（会话开着时这是常态）（证据：`scripts/read-session-log.mjs:48-54,60-66`）。
- 输入/输出：`<sessionId>` 或 `--file`；`--tail N`、`--types`（事件类型直方图）；
  打印 `frames=/events=/bytes=` 与 `seq type data(≤220字符)`
  （证据：`scripts/read-session-log.mjs:11-13,77-93`）。
- 旧实现里它的实际用途（证据链）：判定指令是否进入内核（`agent/inbox/spliced`、`turn/start`、
  `turn/end {reason:{kind:'blocked'}}`）与发现 provider 401/403 之类的**环境侧**故障
  （证据：`.workbuddy/memory/2026-10-01.md:223-227,233-235`）。
  多帧 zstd 的读法是当时排查沉淀下来的脚本模板（证据：`.workbuddy/memory/2026-10-01.md:241-242`）。
  推断：这是「live-e2e 红了之后区分代码故障 vs 环境故障」的专用工具，属于验收体系的一部分，
  新实现要有等价的「内核侧独立证据源」，不能只信我们自己客户端的叙述。

### 5.7 `scripts/bundle-protocol.mjs` —— 把 protocol 内联进插件产物

- 作用与存在理由：插件是 `pnpm add -w file:.../packages/plugin` 装进外部 profile 的，
  pnpm 在仓库外解析不了 `workspace:*`（`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`）。
  所以 `@dsh-rc/protocol` **只能是 devDependency**（只在构建期通过 workspace 链接解析），
  build 之后把它的编译产物拷进 `dist/protocol/`，并把裸 specifier 改写成相对路径
  （证据：`scripts/bundle-protocol.mjs:1-14`、`HANDOFF.md:82-84`）。
- 输入：`packages/protocol/dist/src`；缺失则 `exit 1` 并提示先 `pnpm -r build`
  （证据：`scripts/bundle-protocol.mjs:26-30`）。
- 动作：先 `rmSync(dist/protocol)` 再 `cpSync` 全量拷贝；遍历 `dist` 下 `.js`/`.d.ts`，
  跳过拷贝自身，把 `'@dsh-rc/protocol'` 整体替换为该文件视角的 POSIX 相对路径
  （证据：`scripts/bundle-protocol.mjs:31-32,46-62`）。
- 输出：`[bundle-protocol] inlined @dsh-rc/protocol -> dist/protocol (N file(s) rewritten)`
  （证据：`scripts/bundle-protocol.mjs:64`）。
- 挂载点：`packages/plugin` 的 `build` = `tsc -p tsconfig.json && node ../../scripts/bundle-protocol.mjs`
  （证据：`packages/plugin/package.json:28`）。
- 坑（必须写进新实现的约束）：**改了 protocol 必须重新 build plugin**（证据：`HANDOFF.md:84`）；
  产物自包含后运行时依赖只剩 `ws / tweetnacl / tweetnacl-util`（证据：`scripts/bundle-protocol.mjs:11-13`、
  `packages/plugin/package.json:31-35`）。推断：由于它在 `dist` 里改写文件，
  任何「直接编辑 dist」或「只跑 tsc 不跑 bundle」的操作都会让插件在生产里炸。

---

## 6. 工具链与运行环境事实

### 6.1 pnpm workspace 结构

- workspace 成员只有三处：`packages/*`、`apps/*`、`e2e`（证据：`pnpm-workspace.yaml:1-4`）。
  **`mp/` 不在 workspace 里**（证据：`pnpm-workspace.yaml:1-4`、`mp/package.json:1-9` 只有
  `tdesign-miniprogram` / `js-base64` 两个依赖，无任何 script）——推断：所以改 `mp/core` 时
  没有任何 `pnpm` 命令会自动带出它的测试，全靠人工跑 e2e 三个文件（`HANDOFF.md:145-146`）。
  新实现若要「保留 mp/ 不改一行」，这条接口关系（`mp/core/*.js` 被 e2e 以 CommonJS require）必须原样保住。
- 成员：`@dsh-rc/protocol`（packages/protocol）、`dsh-remote-control`（packages/plugin，即插件包名）、
  `@dsh-rc/server`（apps/server）、`@dsh-rc/e2e`（private）
  （证据：`packages/protocol/package.json:2`、`packages/plugin/package.json:2`、`apps/server/package.json:2`、
  `e2e/package.json:2-3`）。
- 根包 `private: true`、`type: module`、`engines.node >= 20`，脚本只有三条：
  `build = pnpm -r build`、`test = pnpm -r test`、`e2e = node e2e/run.mjs`
  （证据：`package.json:3-13`）。**没有 `test:live` 之类的别名**（见 §7）。
- 依赖图（`--frozen-lockfile` 可核对）：`e2e` 只依赖 `ws` + `@dsh-rc/protocol`(workspace link)；
  `packages/plugin` 运行时依赖 `ws/tweetnacl/tweetnacl-util`，`@dsh-rc/protocol` 是 **dev** 依赖；
  `apps/server` 只依赖 `ws`（证据：`pnpm-lock.yaml:18-31,33-56,44-47`）。
  坑：`e2e/mp-client.test.mjs` 与 `e2e/multi-pair.test.mjs` 却 import `packages/plugin/dist`
  （证据：`e2e/mp-client.test.mjs:31-32`、`e2e/multi-pair.test.mjs:67`），
  而 e2e 并未声明对 plugin 的 workspace 依赖 → 推断：`pnpm -r test` 的拓扑顺序不保证 plugin 先建，
  所以文档一律要求先 `pnpm -r build` 再 test（证据：`README.md:54-57`、`HANDOFF.md:31-33`）。
- `ws` 不在根 `node_modules`：pnpm 隔离链接只放在 server/plugin/e2e 各自目录下，
  自写 shim 时别猜路径，直接复用 `e2e/mp-sim.mjs` 的 `installWxShim()`
  （证据：`.workbuddy/memory/2026-10-01.md:209-211`）。
- 另有一条 ESM 解析坑：`import 'dsh-remote-control'` 按**脚本所在目录**解析而非 cwd，
  脚本放 /tmp 时要用绝对路径 import（`node -e` 才按 cwd 解析）（证据：`.workbuddy/memory/2026-10-01.md:207-208`）。

### 6.2 Node 版本与「无构建步骤」的中继

- 全仓 `engines.node >= 20`（根、plugin、server）（证据：`package.json:8`、`packages/plugin/package.json:42-44`、
  `apps/server/package.json:15`）。
- CI 矩阵跑 **Node 20 与 22**（证据：`.github/workflows/ci.yml:11-14`）。
- **中继是纯 `.mjs`，没有构建步骤**：`build` 脚本就是字面量 `true`（证据：`apps/server/package.json:9`），
  `main` 指向 `src/main.mjs`，`start = node src/main.mjs`（证据：`apps/server/package.json:6-8`）。
  生产部署也是直接 `node src/main.mjs`（证据：`deploy/systemd/dsh-remote-control.service:18-20`）。
  WHY 这个选择：无值守环境降低工具链风险优先（证据：`HANDOFF.md:187`）。
- CI 专门有一个 job 证明「无构建也能在最低支持版本起得来」：`npm install --prefix apps/server ws` 后
  直接 boot 中继打 `/healthz`，并额外断言**缺 `DRC_HOST_TOKEN` 时必须拒绝启动**
  （证据：`.github/workflows/ci.yml:39-61`）。这条「不给 token 就别起来」是安全属性，不是便利属性。

### 6.3 TS 编译配置约定

- 共用 `tsconfig.base.json`：`target/lib ES2022`、`module`/`moduleResolution` = `NodeNext`、
  `strict`、`declaration`、`sourceMap`、`skipLibCheck`、`esModuleInterop`、
  `forceConsistentCasingInFileNames`、**`noUncheckedIndexedAccess`**、`resolveJsonModule`
  （证据：`tsconfig.base.json:3-14`）。`noUncheckedIndexedAccess` 说明旧代码刻意要求索引访问显式收窄——
  新实现若不保留，等于放宽了一道静态防线（推断：应当保留）。
- 两个 TS 包的 tsconfig 都是 `outDir: "dist"` + **`rootDir: "."`**，`include` 同时含
  `src/**/*.ts` 与 `tests/**/*.ts`（证据：`packages/plugin/tsconfig.json:2-5`、`packages/protocol/tsconfig.json:2-7`）。
  WHY `rootDir: "."`：产物因此落在 **`dist/src/**` 与 `dist/tests/**`**（证据：`HANDOFF.md:79-80`），
  目录结构实际是 `packages/plugin/dist/src/*.js`、`packages/protocol/dist/src/*.js`（本文核对存在）。
- 对应地，`main`/`types`/`exports` 都指向 `./dist/src/index.js`（`.d.ts`）
  （证据：`packages/plugin/package.json:6-15`、`packages/protocol/package.json:6-11`）。
  **所有测试与 e2e 也都 import 这个路径**（证据：`e2e/run.mjs:13-15`、`e2e/mp-client.test.mjs:31-32`、
  `e2e/multi-pair.test.mjs:67-68`、`e2e/mp-crypto.test.mjs:16-23`）——路径约定是测试能否跑起来的一部分。
- 插件的 `exports` 还额外暴露 `./cordis.patch.yml` 与 `./package.json`，`files` 只装
  `dist / cordis.patch.yml / README.md / LICENSE`，并有 `dsh.bundle.patch` 声明
  （证据：`packages/plugin/package.json:13-26`）。WHY：cordis bundle 靠 patch 文件激活，
  发布白名单漏了它就装不进 profile。
- `lib/` 是历史遗留的陈旧产物，**已删除并 gitignore，不得从 lib/ import**
  （证据：`HANDOFF.md:81`、`.gitignore:3`）。测试文件里还专门留了一句注释警告不要 import 旧的 `lib/`
  （证据：`e2e/mp-client.test.mjs:29-30`）。
- `dist/` 本身也被 gitignore（证据：`.gitignore:2`）。推断：因此 `git clone` 后不 build 就没有任何测试可跑，
  「先 build」是硬前置。

### 6.4 `node --test` 必须用 glob，不能传目录

- 事实：`node --test` 传目录会 `MODULE_NOT_FOUND`，必须写 glob
  （证据：`HANDOFF.md:85`）。落地写法：
  `node --test dist/tests/*.test.js`（plugin，证据：`packages/plugin/package.json:29`）、
  `node --test dist/tests/crypto.test.js dist/tests/keepawake.test.js`（protocol，逐个列出，
  证据：`packages/protocol/package.json:15`）、
  `node --test tests/relay.test.mjs tests/hardening.test.mjs`（server，证据：`apps/server/package.json:10`）。
- e2e 侧是**串行的四条 `node --test` + 一条 `node run.mjs`**，用 `&&` 连接（任一红就中断）
  （证据：`e2e/package.json:6`）。WHY 串行不并发：每个文件都自己 spawn 中继，并发会撞端口/抢资源
  （端口分配见 `e2e/run.mjs:17`、`e2e/mp-client.test.mjs:20`、`e2e/multi-pair.test.mjs:62`、
  `apps/server/tests/relay.test.mjs:8`、`apps/server/tests/hardening.test.mjs:15-16` 的自增序号）。
- 附带约定：`test` 脚本内嵌 `pnpm build`（plugin/protocol），所以「跑测试」就等于「重新构建」
  （证据：`packages/plugin/package.json:29`、`packages/protocol/package.json:15`）。

### 6.5 `tweetnacl-util` 是 CJS 的导入约束

- 事实：`tweetnacl-util` 是 CJS 包，ESM 里**只能用默认导入再解构，不能具名导入**
  （证据：`HANDOFF.md:86`）。仓库里的唯一命中点正是默认导入
  `import naclUtil from 'tweetnacl-util'`（证据：`packages/protocol/src/crypto.ts:12`）。
- 版本锁定：`tweetnacl@1.0.3`、`tweetnacl-util@0.15.1`（无子依赖）
  （证据：`pnpm-lock.yaml:82-86,118-120`）。
- 小程序侧的对应约束（接口关系，不展开 mp）：`mp/core/vendor/nacl-fast.js` 是**打过补丁的 tweetnacl**——
  移除 `require('crypto')` PRNG 探测否则加载即崩，且不提供 `Math.random()` 兜底宁可抛错；
  **升级 tweetnacl 要重新打补丁**（证据：`HANDOFF.md:135-137`）。小程序无 Buffer/无 CSPRNG/无 crypto 模块，
  base64/UTF-8 走 vendored js-base64，nonce 走持久化计数器（证据：`HANDOFF.md:132-134`）。
  推断：这条决定了新实现不能把「小程序端加密」改成依赖任何 Node-only API，
  §1 的逐字节对拍测试就是这条约束的护栏。

### 6.6 `env -u NODE_OPTIONS` 的根因

- 现象与根因（原文口径）：**WorkBuddy 注入的 FS 钩子会拦截 pnpm 的符号链接操作**，报
  `CODEBUDDY_BROKER_DENY` EEXIST/ENOENT；因此**凡跑 pnpm 一律** `env -u NODE_OPTIONS pnpm …`
  （证据：`HANDOFF.md:64-69`）。
- 连带坑：被 SIGTERM 打断的 pnpm 会在 `~/Library/pnpm/store/v11/projects/` 留下失效链接，删掉即可
  （证据：`HANDOFF.md:68-69`）。
- 文档里所有 pnpm 命令都带这个前缀，包括安装/构建/测试与错误提示文案
  （证据：`README.md:53-56`、`HANDOFF.md:31-33`、`scripts/validate-qr.mjs:28`、`scripts/pairing-qr.mjs:27`）。
  推断：这是**本机环境事实而非项目事实**——新实现应当在文档里注明「仅在此类宿主环境下需要」，
  否则会把一个环境噪声固化成项目约定。CI 里不带（证据：`.github/workflows/ci.yml:28,31,34`）。

### 6.7 本机路径依赖清单（工具链的地基）

| 路径 | 谁在用 | 证据 |
|---|---|---|
| `~/.dsh/dsh-remote-control/status.json` | live-e2e 取真实配对码 / 判定 relay 与 carrier | `e2e/live-e2e.mjs:36,74-81`；`HANDOFF.md:167` |
| `~/.dsh/dsh-remote-control/pairing-qr.png` | pairing-qr 输出（0600） | `scripts/pairing-qr.mjs:62-64` |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | relay-start 读 hostToken；verify-deployment 读 serverUrl/hostToken/hostLabel | `scripts/relay-start.sh:15,22-28`；`scripts/verify-deployment.mjs:48-61` |
| `~/.dsh/profiles/desktop/node_modules/dsh-remote-control/dist/src/index.js` | verify-deployment 优先加载「已安装产物」 | `scripts/verify-deployment.mjs:70-71` |
| `~/.dsh/profiles/desktop/package.json`（+ `.bak-drc-<ts>`） | install-to-profile 判断/写入 bundles | `scripts/install-to-profile.sh:33,47,52-62`；`HANDOFF.md:168` |
| `~/.dsh/sessions/<slug>/<id>/session.v4.jsonl.zstd` | read-session-log 内核侧取证 | `scripts/read-session-log.mjs:14-16,32` |
| `/Users/linbin/.workbuddy/binaries/python/envs/default/bin/python` | validate-qr 的 zxing-cpp 解码器（**硬编码**） | `scripts/validate-qr.mjs:32` |
| 服务器 `/etc/dsh-remote-control.env`(600)、`/opt/dsh-remote-control/server`、nginx `conf.d/drc.conf` | 生产中继（healthz 探活对象） | `HANDOFF.md:165,169`；`deploy/systemd/dsh-remote-control.service:4,19` |

推断：这 8 条里前 6 条是「测试/脚本能不能跑」的直接开关，任一目录搬家就需要改脚本默认值；
新实现应把它们集中成可覆盖的配置项（`--profile`/env），而不是散在各文件里各写一遍
（现状已经是两份 YAML 解析器，见 §5.1）。

---

## 7. CI 现状：跑什么、不跑什么

触发：`push` 到 main/master 与所有 `pull_request`（证据：`.github/workflows/ci.yml:3-6`）。

**job `test`**（矩阵 Node 20 / 22，`fail-fast: false`，pnpm 9 + setup-node 缓存）：

1. `pnpm install --frozen-lockfile`（证据：`ci.yml:18-28`）
2. `pnpm -r build`（证据：`ci.yml:31`）
3. `pnpm -r test` → 即 83 个 `node:test` 用例 **外加** e2e 包脚本里的 `node run.mjs`
   （证据：`ci.yml:34`、`e2e/package.json:6`、`packages/*/package.json` 的 test 字段）
4. `node e2e/run.mjs` 再跑一遍（证据：`ci.yml:37`）
   推断：第 3、4 步**重复执行了 relay e2e**（e2e 包 test 脚本末尾已含 `node run.mjs`）。
   新实现应避免这种重复（同一件事跑两次会让「哪个是权威」变模糊）。

**job `relay-smoke`**（仅 Node 20）：裸 `npm install --prefix apps/server ws` →
boot 中继并轮询 `/healthz`（50 次 × 0.1s）→ 另起一次**必须因缺 `DRC_HOST_TOKEN` 而失败**
（证据：`ci.yml:41-61`）。

**CI 里没有的（因为需要真实环境或本机材料）**：

| 未进 CI | 原因（证据/推断） |
|---|---|
| `node e2e/live-e2e.mjs` | 需本机 Harness 在跑 + 真实内核 + 一次性配对码，且会向真实会话发指令花 token（证据：`e2e/live-e2e.mjs:36,70-100,222-227`；无任何 script/CI 引用，见 §2.7） |
| `node scripts/validate-qr.mjs` | 需本机 python venv + zxing-cpp/pillow，且解释器路径硬编码（证据：`scripts/validate-qr.mjs:32-36`） |
| `node scripts/verify-deployment.mjs` | 默认打线上中继；attach 模式需真实主机（证据：`scripts/verify-deployment.mjs:59,106-108`） |
| `./scripts/install-to-profile.sh` | 写 `~/.dsh/profiles/desktop`，且要求重启 GUI Harness（证据：`scripts/install-to-profile.sh:17,65-68`） |
| `node scripts/pairing-qr.mjs` / `read-session-log.mjs` | 依赖 `~/.dsh` 运行时材料与人工扫码场景（证据：`scripts/pairing-qr.mjs:39-54`、`scripts/read-session-log.mjs:28-36`） |
| 真机审批/提问卡流转 | 环境不具备：本机所有会话 preset 为 `danger-full-access` + `approval/policy: never`，永不弹卡（证据：`HANDOFF.md:22,175-177`） |

推断（重要）：所以**「CI 绿」在旧体系里只等于「83 用例 + 本地 relay e2e + 中继能起」**，
它不覆盖真实链路、不覆盖二维码可扫性、不覆盖部署产物。新实现的 README/HANDOFF 必须把
「CI 绿 ≠ 可发布」写死，并给出人工验收清单（§8）。

---

## 8. 重写时的验收建议（仅口径，不给方案）

### 8.1 每层的最低门槛

| 层 | 新实现至少要有什么（不得小于左列） |
|---|---|
| 单测 | ≥83 个 `node:test` 用例的**等价覆盖**，且按 §1.2 的口径逐文件可数；必须包含：篡改拒绝、双向密钥不同向、三平台防休眠命令构造、激活降级不抛异常、carrier 优先级、配置校验只拦「不可用」、状态文件写 carrier、终端二维码几何（静默区/等宽/半块字母表）、UTF-8 非 ASCII 载荷不截断、PNG 尺寸合法、会话列表 6 类降级（持久化优先/回退/标题失败不影响列表/无模型拒答/冷会话用默认模型/恢复失败如实上报）、事件流不被污染（瀑布黑名单）、subagent 子会话隐藏且拒绝驱动、归档会话标记+恢复+可关、窗口化 5 条（不丢文本/不重排/done 独立帧要转发/异类事件先 flush/stop 要 flush）（证据：§1.2 各行号） |
| 中继 | 双向 opaque 转发 + `seq` 由服务端编号 + 配对码一次性（`already_used`）+ 错 host token `bad_token` + 加固行为 11 项（超大帧 1009、鉴权爆破 4001、配对爆破 4008、帧洪泛 `rate_limited`、主机下线清孤儿会话、healthz 计数、SIGTERM 退 0 且客户端收 1001、pair-status 默认 404、显式开启才应答、pendingPairs 有界、连接上限 1013）（证据：`apps/server/tests/relay.test.mjs:44-95`、`apps/server/tests/hardening.test.mjs:78-251`） |
| 跨运行时 | 小程序 crypto 与 Node crypto **逐字节对拍**（11 条），含「MP 加密→Node 解密」「Node 随机 nonce 加密→MP 解密」双向、篡改与错钥必须拒、24B nonce 单调不回绕、两个 QR 解析器结论一致（证据：`e2e/mp-crypto.test.mjs:34-148`） |
| 客户端闭环 | 真实 `mp/core` 代码（非测试专用副本）跑完 8 条：配对、加密列表、delta→工具→审批→approve→收尾、提问→作答、防休眠回传、中断、nonce 30 次不重复、失效会话降级为 needs-pair 而非崩（证据：`e2e/mp-client.test.mjs:101-219`） |
| 传输探测 | 缺 `connectSocket` 给出**可读的类型化错误**、仅旧式全局回调容器仍可连可发、探测结果要报告命中的全局名（证据：`e2e/mp-platform.test.mjs:39,65,125`） |
| relay e2e | 9 步闭环 + 零知识审计：对客户端 socket 上**观测到的全部帧**（含双向，即中继实际吐出来的东西）断言 `enc` 帧 ≥10、逐帧密文 >40B、不含 `cmd.send_prompt` 与正文关键词、整段观测 JSON 化后也不含正文（证据：`e2e/run.mjs:48-52,198-213`） |
| live-e2e | §2 全部 7 个子条款 + 10 项/轮检查点 + `--rounds` 稳定性连跑（证据：`e2e/live-e2e.mjs` 全文、`README.md:99`） |
| 二维码 | 28 组真实第三方解码（7 载荷 × 4 ECC，含 CJK/公网 URL/单字符/纯数字），PNG 与矩阵两条路径各解一次，逐字节相等（证据：`scripts/validate-qr.mjs:40-98`） |
| 回归 | 多配对码并存按「所用码」取 PSK，且**主机发来的每一帧**都要能用该码密钥解开（证据：`e2e/multi-pair.test.mjs:85-134`） |

### 8.2 必须从生产日志 / 真实链路取证，不得用抽样或 mock 代替

1. **真实内核挂接**：必须证明 `carrier=services` 且列表来自真实内核——读运行时状态文件的 `carrier` 与
   `relay`/`relayProblem`（证据：`HANDOFF.md:15,25`、`e2e/live-e2e.mjs:80`），
   并保留 live-e2e 的「出现 mock 会话即判失败」（证据：`e2e/live-e2e.mjs:205-206`）。
   不接受「本地 mock 跑通」作为这一条的证据。
2. **指令真的进了内核**：必须从**内核自己的落盘**取证（`agent/inbox/spliced` / `turn/start` / `turn/end`），
   即 §5.6 的工具面（证据：`scripts/read-session-log.mjs:4-16`、`.workbuddy/memory/2026-10-01.md:223-227`）。
   WHY：只有客户端一侧的叙述无法区分「我们的代码坏了」与「内核/环境拒绝了」。
3. **零知识**：必须在**交给中继的那一帧字节**上取证（outbound `enc` 帧 base64 解码后不含指令正文、
   不含命令名），且必须有**帧数下界**（≥2）防止空判定（证据：`e2e/live-e2e.mjs:128-134,274-283`、
   `.workbuddy/memory/2026-10-01.md:212-213`）。
   「只审计我们自己内存里的对象」不算。
4. **生产中继行为**：必须打**部署实例**（或其完整拓扑副本：nginx TLS 终止 + 只绑 127.0.0.1 + 按 IP 限流）
   做 healthz/握手/断连取证（证据：`README.md:42-48`、`deploy/nginx/drc.conf:17-20,47,51-55`、
   `deploy/systemd/dsh-remote-control.service:6,19`）。
   推断：本地 `ws://127.0.0.1` 不能替代，因为 `wss://` 与 nginx 帧大小/超时限制只在生产里存在
   （`HANDOFF.md:140-141` 的 12s 连接超时死代码就是只在真机暴露的例子）。
5. **审批/提问卡**：旧体系承认这块**只有单测 + mock e2e、真机从没跑过**（证据：`HANDOFF.md:22,175-177`）。
   新实现要把「在一个 restrictive preset 的真实会话上跑通一次审批与一次提问，并从内核日志取到
   对应的 resolve/answer 事件」列为发布前必做取证项；不允许再用「单测里有」来交差。
6. **稳定性不是抽样**：多轮必须**每轮独立取新的一次性配对码并全部通过**（进程级 `usedTokens` 累加），
   旧口径是 `--rounds 3` 全绿（证据：`e2e/live-e2e.mjs:151-153,294-302`、`HANDOFF.md:19`）。
   推断：不得写成「随机跑 3 次看有没有红」——每轮都是完整 10 项断言。
7. **可诊断性**：任何真实链路失败都必须打印事件轨迹/最后若干帧与理由（`lastReason`、tail 轨迹）
   （证据：`e2e/live-e2e.mjs:72,99,171-174`、`docs/MINI-PROGRAM.md:145-146`）。
   红了但说不清原因，视为验收不达标。

### 8.3 三条结构性红线（来自旧实现的事故，而不是风格偏好）

1. **禁止「拿不到真实材料就换替身并通过」**（证据：`e2e/live-e2e.mjs:10-12`、`.workbuddy/memory/2026-10-02.md:4-6`）。
2. **禁止空判定**：所有「收到了 X」必须带数量下界（证据：`e2e/live-e2e.mjs:199,279` vs
   `scripts/verify-deployment.mjs:162,235` 的反例）。
3. **禁止重试洗绿**：重试只允许覆盖一次性码/已知竞态的**白名单错误**，其余错误必须立刻红
   （证据：`e2e/live-e2e.mjs:147-182`）。

### 8.4 旧实现自认的验证缺口（重写时应视为「必须补强」而非「维持」）

- 真机审批/提问卡未验证（证据：`HANDOFF.md:22`、`HANDOFF.md:175-177`）。
- 中继重启后配对关系丢失属**有意设计**，但「客户端会提示重新配对」这条只在文档里写，
  没有一条真实链路测试断言它（证据：`HANDOFF.md:180-181`；live-e2e 只测 `unpair` 后状态，
  证据：`e2e/live-e2e.mjs:286-289`）。
- 服务端日志「不含明文」没有断言（`lines` 收集了却未使用，证据：`apps/server/tests/hardening.test.mjs:22-28`）。
- Windows 防休眠只有命令构造器单测、无实现无实机（证据：`packages/protocol/tests/keepawake.test.ts:24`、
  `HANDOFF.md:182`、`README.md:118-122`）。
- 二维码「在真实手机上扫」没有自动化，只有 zxing 替手机眼睛（证据：`scripts/validate-qr.mjs:9,11-12`）。
  推断：这是可接受的等价取证，前提是解码器为第三方且载荷逐字节比对。
