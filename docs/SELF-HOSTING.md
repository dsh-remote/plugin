# 自建中继服务部署指南

`apps/server` 是一个单进程、纯内存的零知识 WebSocket 中继。运行时只有 `ws` 与 `zod`，
而**生产入口只有一个文件**：`apps/server/dist/bundle/main.js`。

这份文档描述的是 2026-10-02 从零重写之后的代码（基线 `b026d63` 是旧实现，旧代码已删除，
要看旧代码用 `git show b026d63:<path>`）。旧版本文档里的 `node src/main.mjs`、
`ExecStart=/usr/bin/node src/main.mjs`、launchd 里的 `apps/server/src/main.mjs`、
`CMD ["node","src/main.mjs"]`、`npm install --omit=dev` **全部作废**：那个文件已经不存在了。

每节末尾标注了取证状态：

| 标注 | 含义 |
|---|---|
| **[已验证]** | 在生产实例 `wss://drc.provid.cc` 或仓库测试里跑过（出处写在该条目里） |
| **[本次实测]** | 写这份文档时在本机（macOS / Node v22.23.3）跑过的命令，逐条贴了原文输出 |
| **[未实测]** | 与当前代码一致、但没有任何实例或测试跑过它。照做之前请自己验一遍 |

---

## 1. 生产入口：一个文件

```sh
env -u NODE_OPTIONS pnpm --filter @dsh-rc/server build
# → apps/server/dist/bundle/main.js（约 910 KB）
```

这条 `build` 做两件事（`apps/server/package.json`）：`tsc -p tsconfig.json`（类型检查 +
`dist/src/**`）与 `node ../../scripts/bundle-relay.mjs`（esbuild 打成单文件）。

打包结果（事实，出处 `scripts/bundle-relay.mjs`）：

- **`ws` 与协议层全部内联**，端点 `import` 的 `@dsh-rc/protocol/frames`、`outbound`、`ids`
  都在产物里；只有 `bufferutil` / `utf-8-validate` 这两个**可选**原生加速模块留在外面，
  缺了照常跑。
- 产物是 ESM，所以头部补了一句真 `createRequire`（内联进来的 CJS 模块有 `require(...)`，
  esbuild 默认会把它们换成运行期抛错的兜底函数）。
- **包版本以 esbuild `define` 注入**成 `__DRC_VERSION__`。为什么必须注入而不是运行时读
  `package.json`：生产部署就是"scp 一个 `main.js` 到 `/opt/.../server/`"，文件旁边没有
  `package.json`，靠文件探针读版本的两条相对路径都会落空，`/healthz` 的 `version` 静默退化成
  `0.0.0` —— 而运维恰恰靠这个字段判断线上跑的是哪一版。

于是部署退化成**拷一个文件 + 一个 env 文件**：

```sh
scp apps/server/dist/bundle/main.js root@HOST:/opt/dsh-remote-control/server/relay.mjs
scp deploy/systemd/dsh-remote-control.service root@HOST:/etc/systemd/system/
```

不需要 `npm install`、不需要 `node_modules`，也就没有"服务器上的依赖树和 CI 不一样"这一类故障。
这三条断言（空目录能起、`/healthz` 的 `version` 必须等于包版本、SIGTERM 必须 exit 0）由
`apps/server/tests/bundle.test.mjs` 锁住，CI 的 `relay-smoke` 作业在 **Node 20** 上从空目录
真起一次（`.github/workflows/ci.yml`）。 **[已验证]**

产物里不含任何密码学实现（`xsalsa20` / `secretbox` / `tweetnacl` 都搜不到）——同一份测试断言它，
这是"结构性零知识"的机械防线：中继不是"不去解密"，是**没有可解密的代码**。 **[已验证]**

> Node 要求：`engines.node >= 20`（产物 target `node20`）。生产实例是 Alibaba Cloud Linux 4
> 自带的 Node 22。 **[已验证]**

---

## 2. 环境变量

权威来源是 `apps/server/src/config.ts`，逐条抄自代码。**没有 `DRC_HOST_TOKEN` 服务拒绝启动**
（stderr 打 `[drc-relay] error: DRC_HOST_TOKEN is required (...)`，exit 1）。

| 变量 | 必填 | 默认 | 单位 | 说明 |
|---|---|---|---|---|
| `DRC_HOST_TOKEN` | ✅ | — | — | host 出站认证凭据。`openssl rand -hex 32` 生成；短于 24 字符只告警不阻止。**与主机插件那一份必须逐字一致** |
| `DRC_PORT` | | `8787` | 端口号 | 监听端口。`0` 合法 = 让系统分配（测试与容器发布端口用）。越界（非 0-65535 整数）直接拒绝启动 |
| `DRC_BIND` | | `127.0.0.1` | IP | 绑定地址。默认只绑回环：TLS 由反代终止，中继没理由出现在局域网里。**只有自己就是边缘（容器直接发布端口、无同机反代）时才设 `0.0.0.0`** |
| `DRC_PUBLIC_URL` | | **空字符串** | URL | `/api/info` 返回的对外地址。公网填 `wss://你的域名` |
| `DRC_PAIR_TTL_MS` | | `120000` | 毫秒 | 配对码的**服务端权威**寿命。生产实例实际用 `90000`；`docs/SECURITY.md` 建议公网收紧到 60s。主机必须按 `pair-ready.ttlMs` 改写本地过期时间（旧实现的第一起线上事故） |
| `DRC_LOG_LEVEL` | | `info` | 枚举 | `debug` / `info` / `warn` / `error` / `silent`。**区分大小写**，写 `INFO` 会拒绝启动 |
| `DRC_MAX_MSG_BYTES` | | `262144`（256 KiB） | 字节 | 单帧上限（喂给 `ws` 的 `maxPayload`），超过直接 1009 断开。**不要往小调**：低于 256 KiB 会把大的流式 delta 硬切断，表现是"输出说到一半就重连" |
| `DRC_MAX_CONNS` | | `200` | 连接数 | 并发连接上限，超出的新连接立刻 1013 `server_busy` |
| `DRC_MAX_FRAMES_PER_SEC` | | `500` | 帧/秒 | 单连接帧速率（固定窗口，每秒重置）。超限时窗口内回一次 `error{rate_limited}`，**累计 3 次违规** → 1008 断开 |
| `DRC_HOST_AUTH_MAX_ATTEMPTS` | | `5` | 次 | 单连接允许的 host 认证失败次数，用尽 → 4001 `too_many_auth_attempts` |
| `DRC_PAIR_ATTEMPTS_PER_CONN` | | `5` | 次 | 单连接允许的配对码错误次数，用尽 → 4008 `too_many_pair_attempts`。**成功一次就清零** |
| `DRC_PAIR_GLOBAL_PER_SEC` | | `20` | 次/秒 | 全局配对尝试配额。6 位码只有 10⁶ 空间，这一条是唯一的暴力枚举防线 |
| `DRC_MAX_PENDING_PAIRS` | | `1000` | 条 | 待配对表上限，防无界增长；装满后新码得到 `error{pair_table_full}`（已存在的 token 允许覆盖） |
| `DRC_CONV_IDLE_TTL_MS` | | `604800000`（7 天） | 毫秒 | **新增**：会话空闲多久后被回收。续用不是无限期 |
| `DRC_HOST_GRACE_MS` | | `120000`（120 秒） | 毫秒 | **新增**：主机 socket 断开后多久才通知客户端"主机已离开"。没有它，一次网络抖动就会让手机丢掉配对、必须回电脑前重新扫码 |
| `DRC_SWEEP_MS` | | `5000` | 毫秒 | 清扫与保活周期：过期配对码清理、WS 层 ping/pong 判活、host 宽限期到期、会话空闲回收都挂在它上面。调小只为排错（e2e 用 `1000`） |
| `DRC_MAX_BUFFERED_BYTES` | | `1048576`（1 MiB） | 字节 | **新增**：慢消费者阈值。对端发送缓冲区持续超限 **10 秒**即 1008 `slow_consumer` 断开，而不是无限堆积把中继内存吃掉 |
| `DRC_PAIR_STATUS` | | 关闭 | — | 设为 `1` **或** `true` 才启用 `/api/pair-status`（默认关闭，见下） |

数值型变量走同一条校验（`integer()`）：**必须是正整数**，`0`、负数、`abc`、小数一律拒绝启动
（`DRC_PORT` 例外，`0` 合法）。这是相对旧实现的行为变化：旧代码是 `Number(env.X || 默认)`，
写坏了静默退回默认值；现在 env 文件里的一个拼写错误会让服务**根本起不来**（`[drc-relay] error:
DRC_XXX 必须是正整数，收到 "..."`）。无值守场景里这是好事，但要知道它现在会响。 **[已验证]**

### 2.1 三个变量改名了（迁移风险）

默认值逐项继承旧值，但下面三个**换了名字**。旧名字在新代码里**没有任何读取点**：
写了不报错、不告警、不生效——**静默按新默认值跑**。这是本次迁移最容易漏的一条：
你以为把上限收紧了，其实它回到了默认值，而且日志里一个字都不会提。 **[已验证：`config.ts`
只读新名字；本次实测在 env 里带 `DRC_MAX_AUTH_ATTEMPTS=3` 起产物，启动成功且无任何提示]**

| 旧名（`b026d63` 的 `src/main.mjs`） | 新名（当前代码） | 默认值 | 含义没变的部分 |
|---|---|---|---|
| `DRC_MAX_AUTH_ATTEMPTS` | `DRC_HOST_AUTH_MAX_ATTEMPTS` | `5` | 单连接 host 认证失败次数，用尽 4001 |
| `DRC_MAX_PAIR_ATTEMPTS` | `DRC_PAIR_ATTEMPTS_PER_CONN` | `5` | 单连接配对码错误次数，用尽 4008 |
| `DRC_MAX_PAIR_ATTEMPTS_PER_SEC` | `DRC_PAIR_GLOBAL_PER_SEC` | `20` | 全局配对尝试配额（每秒） |

迁移检查（把服务器 env 文件里的旧名揪出来，只读不改）：

```sh
grep -nE 'DRC_(MAX_AUTH_ATTEMPTS|MAX_PAIR_ATTEMPTS|MAX_PAIR_ATTEMPTS_PER_SEC)\b' /etc/dsh-remote-control.env
```

命中就得改名，然后 `systemctl restart dsh-remote-control`。生产实例这次没踩到，
是因为 env 文件里原本只设了**没改名的那几项**（`DRC_HOST_TOKEN` / `DRC_PORT` /
`DRC_PUBLIC_URL` / `DRC_PAIR_TTL_MS` / `DRC_LOG_LEVEL`）。 **[已验证：`deploy/README.md`]**

> 顺带一句：`docs/SECURITY.md`「6 位配对码的暴力枚举」一节里还写着旧名
> `DRC_MAX_PAIR_ATTEMPTS` / `DRC_MAX_PAIR_ATTEMPTS_PER_SEC`，以及已经不存在的
> `relay-client.ts` 路径。看那一节时按上面的对照表换算。

### 2.2 另外两处默认值/语义变化

| 项 | 旧 | 新 | 影响 |
|---|---|---|---|
| `DRC_PUBLIC_URL` 默认 | `ws://127.0.0.1:<port>` | `''`（空） | `/api/info` 现在返回 `{"publicUrl":"","protocol":1}`。想让端点从 `/api/info` 读到地址就**必须显式设** |
| `DRC_LOG_LEVEL` 大小写 | `.toLowerCase()` 后接受 | 精确匹配枚举 | `INFO` / `Warn` 之类现在拒绝启动 |

`DRC_PAIR_STATUS` 是放宽：`1` 与 `true` 都算开（旧代码只认 `1`）。

### 2.3 关于 `/api/pair-status`

**默认 404。** 它是一个无需认证、直接回答「配对码 N 是否有效」的接口，等于给 6 位码空间
装了个现成的扫描 oracle。小程序客户端并不用它（配对走 `pair-begin-client`），所以默认关闭；
确需调试时设 `DRC_PAIR_STATUS=1`，**用完关掉**。这条默认值有测试锁住
（`apps/server/tests/relay.test.mjs`）。 **[已验证]**

---

## 3. 直接跑（本地）

推荐用仓库里的脚本，它把 token 从本机 profile 的 patch 里读出来（主机插件与中继必须同一份
凭据，手工同步两次就会有一边改了另一边没改，表现是"永远 `bad_token`"）：

```sh
./scripts/relay-start.sh              # 127.0.0.1:8787，跑 tsc 产物 dist/src/main.js
DRC_PORT=9000 ./scripts/relay-start.sh
./scripts/relay-start.sh --bundle     # 跑单文件产物，与生产形态完全一致
```

脚本行为（照 `scripts/relay-start.sh` 的实现）：优先用环境变量 `DRC_HOST_TOKEN`，没有才从
`${DSH_PROFILE:-~/.dsh/profiles/desktop}/cordis.patch.yml` 里抓 `hostToken:` 那一行（只打印前
4 位，完整值不外泄）；两处都没有就报错退出，不会起来一个"没人能连上"的进程。缺产物时提示先跑
`env -u NODE_OPTIONS pnpm --filter @dsh-rc/server build`。它固定导出
`DRC_BIND=127.0.0.1`、`DRC_LOG_LEVEL=debug`、`DRC_PAIR_TTL_MS=120000`（都可被同名环境变量覆盖）。

`--bundle` 与默认的差别只在**跑哪个产物**：`dist/src/main.js` 那一份还需要 `node_modules`
才能解析 `@dsh-rc/protocol`（只在工作区里跑得起来，仓库内的 e2e 与单测都用它）；
`dist/bundle/main.js` 才是生产形态。 **[已验证：脚本源码 + `e2e/run.mjs`]**

手工起（不依赖脚本）：

```sh
DRC_HOST_TOKEN=$(openssl rand -hex 32) DRC_PORT=8787 node apps/server/dist/bundle/main.js
```

验证（输出是**本次实测**的原文，取自一个 `DRC_PORT=0` 的产物实例；命令按 8787 写，字段一致）：

```sh
curl -s http://127.0.0.1:8787/healthz
# {"ok":true,"version":"2.0.0","uptimeSec":1,"hosts":0,"clients":0,"conversations":0,"pendingPairs":0,"shuttingDown":false}
curl -s http://127.0.0.1:8787/api/info
# {"publicUrl":"","protocol":1}
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8787/api/pair-status?token=123456'
# 404
```

拷到空目录里起（证明它真的自包含）：

```sh
mkdir -p /tmp/drc-smoke && cp apps/server/dist/bundle/main.js /tmp/drc-smoke/relay.mjs
cd /tmp/drc-smoke
DRC_HOST_TOKEN=smoke-token-0123456789abcdef DRC_PORT=0 node relay.mjs
# {"ts":"...","level":"info","msg":"relay listening","port":65258,"bind":"127.0.0.1","publicUrl":"","version":"2.0.0"}
```

`DRC_PORT=0` 时系统分配端口，真实端口就在上面这行启动日志的 `port` 字段里（别猜端口）。
`Ctrl-C`（SIGINT）或 `kill -TERM` 停机，退出码 0。 **[本次实测]**

---

## 4. `/healthz` 与运维契约

```sh
curl -s http://127.0.0.1:8787/healthz
```

| 字段 | 类型 | 是否运维契约 | 含义 |
|---|---|---|---|
| `ok` | bool | ✅ **契约** | `!shuttingDown`。停机中变 `false` |
| `version` | string | ✅ **契约** | 包版本。**必须是真实版本号，出现 `0.0.0` 说明部署的不是打包产物**（define 没进去）——`bundle.test.mjs` 与 CI `relay-smoke` 都断言它等于 `apps/server/package.json` 的 `version` |
| `uptimeSec` | number | ✅ 契约 | 进程已运行秒数 |
| `hosts` | number | ✅ 契约 | 当前在册主机数 |
| `clients` | number | ✅ 契约 | 当前在册客户端数 |
| `conversations` | number | ✅ 契约 | 活跃会话（配对通道）数 |
| `pendingPairs` | number | ✅ 契约 | 待配对表条数。**注意**：已用过的码在 TTL 窗口内仍留在表里（为的是给出 `already_used` 而不是 `invalid_or_expired`），所以这个数会短暂高于你的直觉 |
| `shuttingDown` | bool | ✅ 契约 | 收到 SIGTERM/SIGINT 后置位 |

这八个字段就是运维契约：`docs/DESIGN.md` §2 的 **T7** 把它冻结成一份清单，
`apps/server/tests/relay.test.mjs` 里有一条名字就叫「`/healthz` 与 `/api/info` 的形状是测试与
运维的依赖（T7）」的断言逐个字段钉住。 **[已验证]**

**关于"新增诊断字段"**：`docs/DESIGN-REVIEW.md` 里有一条复核意见写着「新 `health()` 加了
`lastPingAgo`」，但**当前代码里没有这个字段**——`server.ts` 有 `lastPingAt` 变量，只在每轮清扫
时赋值、没有任何出口读它，`health()` 也没有它；产物里同样搜不到 `lastPingAgo`。
所以：`/healthz` 现在**只有上面八个字段**，`lastPingAgo` / `droppedFrames` / `slowConsumers`
都不存在，别把告警规则写在它们身上。这一条按"未落地"记账。 **[已验证：代码 + 本次实测响应]**

`/healthz`、`/api/info`、`/api/pair-status` 之外的路径一律 404 + `{"error":"not_found"}`。

`ok` 适合做存活探针，但要清楚：停机时 `http.close()` 会**立刻关掉监听套接字**，
探针更常见的表现是连不上（ECONNREFUSED），而不是拿到一个 `ok:false` 的响应
（`shuttingDown:true` 只在已经建立的连接上读得到）。按"连不上=正在重启"来写探针。 **[未实测]**

---

## 5. 日志

**一行一个 JSON**（NDJSON），字段固定 `{ts, level, msg, ...}`，写到 stdout，
由 journald / launchd / Docker 负责收集与轮转。中继刻意不引 pino（`log.ts` 的注释记录了实测理由：
pino 默认起 `thread-stream` 工作线程、生产依赖闭包 13 个包）。

等级权重（`apps/server/src/config.ts`）：`debug=10` `info=20` `warn=30` `error=40` `silent=99`。
一条日志**只有权重大于等于阈值才写出**，所以 `DRC_LOG_LEVEL=warn` 时你看不见 `info` 行
（`paired`、`host online` 这些都会消失，只剩告警）。被级别过滤掉的行**根本不会被构造**，
不是"生成了再丢掉"。

**`level` 与 `msg` 是运维契约**：`msg` 是稳定的英文字面量（告警规则、`journalctl` 的 grep、
日志管道的字段解析都靠它），不要按人话去改写它。字段的值只允许 `string | number | boolean`
（类型层面兜住，编译器不允许把载荷对象、会话标题或模型输出塞进日志行），
`hardening.test.mjs` 还有一条断言：日志行里出现业务明文或长 base64 串即为失败。 **[已验证]**

```json
{"ts":"2026-10-02T08:55:58.511Z","level":"info","msg":"relay listening","port":65258,"bind":"127.0.0.1","publicUrl":"","version":"2.0.0"}
{"ts":"2026-10-02T08:56:50.016Z","level":"info","msg":"shutting down","signal":"SIGTERM"}
{"ts":"...","level":"warn","msg":"host auth failed","attempts":1}
{"ts":"...","level":"info","msg":"paired","sessionId":"c_9f3c…","hostId":"desktop-1","clientId":"wx-1"}
```

### 5.1 值得盯的行

| `msg` | `level` | 含义 / 该怎么反应 |
|---|---|---|
| `relay listening` | info | 启动成功。`port`/`bind`/`version` 三个字段就是"线上到底是哪版、在听哪个地址"的答案 |
| `host auth failed` | warn | 有端点拿错 token 在试。**同一连接连续 5 次会 4001 断开，但断开这一步没有独立的告警行**——只有 `attempts` 一路涨到 5 然后连接消失。看到 `attempts:4` 就该怀疑 token 漂移 |
| `frame flood disconnected` | warn | 单连接帧速率违规累计 3 次，已 1008 断开 |
| `pair budget exhausted (global)` | warn | **全局配对配额打满**（`DRC_PAIR_GLOBAL_PER_SEC`）。字段里的 `reason:"rate_limited"` 是我们的真实原因，见 §5.2 |
| `pair failed` | **info** | 配对码错。**这一行是 info 级**，字段 `attemptsLeft` 递减到 0 时该连接被 4008 断开——而断开本身没有 warn 行。只盯 `-p warning` 会漏掉配对码爆破 |
| `heartbeat timeout` | warn | 对端上一轮 WS 层 ping 没回 pong，已 `terminate()`。替代了旧文档的 `host unresponsive, terminating` |
| `slow consumer disconnected` | warn | 缓冲区持续超 `DRC_MAX_BUFFERED_BYTES` 达 10 秒，1008 `slow_consumer` 断开。字段 `buffered` 是当时的字节数 |
| `pair table full` | warn | 待配对表打满（`DRC_MAX_PENDING_PAIRS`） |
| `enc from non-member` | warn | 有非会话成员往某条通道灌密文（D4 拒绝）。可能是抢注，也可能是主机重连后的孤儿 socket |
| `client replaced by newer socket` | warn | 同 `clientId` 的旧连接被顶掉（复核 R3）。同一台手机反复出现说明它在掉线重连 |
| `socket error` / `send failed` | warn | 底层 socket 异常，多数是网络抖动，成串出现才值得查 |
| `frame handler threw` | error | 处理某一帧时抛异常，已回 `error{internal}`。带 `t` 字段，说明是哪类帧 |
| `uncaught exception` / `unhandled rejection` | error | 进程随即 **exit 1**，交给 `Restart=always` 拉起。注意 `msg` 是带空格的 `uncaught exception`，旧文档写的 `uncaughtException` 已经不是任何一行的内容 |
| `shutting down` | info | 收到 SIGTERM/SIGINT。`signal` 字段告诉你来源 |
| `shutdown timed out, forcing exit` | warn | 5 秒没排干净，强退（退出码仍是 0）。偶发无妨，频繁出现说明有连接卡在 draining |
| `host offline (grace started)` | info | 主机 socket 掉了，宽限期 `DRC_HOST_GRACE_MS` 开始计时。**这条不该当告警用**：主机自己会重连 |
| `host grace expired` | info | 宽限期到点仍没回来，已向该主机的所有客户端发 `peer-left`。手机上会提示重新配对 |
| `host online` / `client online` / `paired` | info | 正常流水。`paired` 给出 `sessionId`/`hostId`/`clientId` 三元组，是"这台手机连的是这台主机"的唯一权威记录 |
| `pair token issued` | info | 主机发布了一张码，字段 `token:"<redacted>"`。**info 级不落完整配对码**（旧实现会，D2 收紧了）。要看到真正的码得开 `debug`：`pair token issued (debug)` |
| `conversation voided by host` / `conversations dropped at host resync` | info | 主机自己声明某条会话它不再持有密钥（R1 的出口），或 `resync` 时没被列出而被删掉 |
| `conversation idle-dropped` | info | 空闲超过 `DRC_CONV_IDLE_TTL_MS` 被回收。客户端下次发帧会撞上 `unknown_session` |
| `pair tokens expired` | debug | 清扫周期清掉的过期/已用码条数 |

### 5.2 限速时"线上说法"与"日志说法"不一致（必须知道）

全局配对配额打满时：

- **发给对端的**是 `pair-fail{reason:"invalid_or_expired"}`；
- **日志里**是 `warn pair budget exhausted (global) {reason:"rate_limited"}`。

这不是 bug，是刻意的（F6 冻结消费面）：小程序 `translatePairFail` 只认
`invalid_or_expired` / `already_used` / `host_offline` / `bad_token` 四个 reason，
多一个就会把英文字面量弹到用户脸上。所以内部原因只进日志，线上只说"这张码现在配不上"。

**排查含义**：用户报"码输不进去、提示无效或已过期"，而你在日志里看见
`pair budget exhausted (global)`，那是**限速**（配额或按 IP 的攻击流量），不是码写错了。
反过来，日志里是成串的 `pair failed {reason:"invalid_or_expired"}` 才是真的码不对/过期。
这条有测试锁住（`hardening.test.mjs`「全局配对配额…reason 必须是小程序能翻译的那四个」）。 **[已验证]**

### 5.3 journald 侧的过滤

`deploy/systemd/dsh-remote-control.service` 用 `StandardOutput=journal` +
`SyslogIdentifier=dsh-remote-control`，所以：

```sh
journalctl -u dsh-remote-control -f                 # 跟流
journalctl -u dsh-remote-control --since -1h | grep '"level":"warn"'
# 摊平成三列看（`fromjson?` 会跳过 stderr 那些非 JSON 行，比如启动失败的那两行）
journalctl -u dsh-remote-control -o cat | jq -Rr 'fromjson? | "\(.ts) \(.level) \(.msg)"'
```

`deploy/README.md` 里写的 `journalctl -u dsh-remote-control -p warning` 是既有的运维入口，
但要留个心眼：中继写到 stdout 的 JSON **不带 `<34>` 这类 syslog 级别前缀**，
systemd 也没设 `SyslogLevelPrefix`，因此这些行进 journal 时优先级一律是 `info`(6)。
按 `-p warning` 过滤 journald 优先级，很可能一条都出不来 —— 真正可靠的是按 JSON 里的
`level` 字段过滤（上面第二条命令）。这一点我**没有在生产实例上实测过**，
只做成了"照代码推断"，落地前请先在目标机上验一次再写进告警规则。 **[未实测]**

---

## 6. 中继重启之后会发生什么

路由表（`hosts` / `clients` / `conversations` / `pendingPairs` 四张表）**全在内存、刻意不持久化**：
PSK 与配对关系落盘只会扩大泄露面。因此：

- 重启即清空：`/healthz` 的四个计数全部归零，旧 `convId` 在新表里不存在。
- 主机与手机都靠各自的退避重连（指数退避 1s→30s 加抖动），**不需要人工干预**。
- 客户端拿旧 `convId` 发帧 → 撞上 `error{code:"unknown_session"}`，中继给手机侧的这条 error
  自带中文（帧里的字面量是 `会话已失效，请重新扫码配对`），手机上显示的是
  **「会话已失效，请重新配对」**，并停在需要输码的界面等你。
- 手机上如果弹出来的是**英文错误码本身**（`bad_token`、`bad_role`、`need_host`、`bad_pair`
  这四个没有中文映射），那是走到了 `message || code` 这条兜底路——说明问题在握手或帧形状上，
  不是"会话没了"。`CLIENT_ERROR_TEXT`（`server.ts`）覆盖的十个 code 才有中文。
- 停机过程中：新连接立刻 1013 `server_shutdown`、HTTP upgrade 返回 503，
  已连着的对端收到 `1001 server_shutdown`（客户端会马上重连，而不是等 TCP 超时）。

这条不是文档里的口头承诺：`e2e/restart-resume.test.mjs` 的 **(b)** 用例真起中继进程、真发
SIGTERM、真在**同一个端口**起重启后的第二个实例，然后断言
`error.code === 'unknown_session'`（逐字）、`error.message` 含"会话"与"配对"两个中文关键词、
手机进入 `needs-pair`、手机状态文案匹配 `会话已失效，请重新配对`、`convId` 被清空、
新中继 `conversations === 0`、两次停机都 **exit 0**。 **[已验证]**

同一个测试文件里另外两条用例划清了"重启"的三种不同表现，运维上要分得清：

| 场景 | 会话 | 手机端 |
|---|---|---|
| **(a) 只有手机断开**（切后台、杀进程、网络抖一下） | **留着**（D3）。手机用同一个 `clientId` 重连即自动重新挂上 | **不需要重新扫码**。这是本次重写修掉的体验问题：旧实现是"回前台就得重新扫码" |
| **(b) 中继重启** | 全丢（内存态） | 中文提示"会话已失效，请重新配对" |
| **(c) 主机重启** | 主机手里的 PSK 随进程消失，它重连后发 `resync` 声明自己还持有哪些会话，中继据此删掉没被列出的 | 撞 `unknown_session` 或收 `peer-left`，两种都有中文提示。**不许静默黑洞**是这条用例的判据 |

顺带一条容易误判的：会话还在而主机暂时不在（宽限期内）时，中继回的是
`error{host_unavailable}`（手机显示"主机暂时不在线，请稍后重试"），
**绝不能**是 `unknown_session` —— 后者会让手机丢掉配对。所以"提示重新配对"和"稍后重试"
在手机上就是两句话，别把它们当成同一个故障。

### 6.1 内存态的其它几条运维要点

- **同 `hostId` 重连会顶掉旧连接**：旧 socket 收到自定义关闭码 **4000 `replaced_by_newer_socket`**。
  客户端的重连策略不认识 4000（它只对主机有意义），主机侧靠它区分"我被更新的一个实例顶了"
  ——如果日志里反复出现 `host online {replaced:1}`，说明有两份主机在抢同一个 `hostId`
  （典型成因就是 §10.2 那个双实例坑）。
- **主机重连后已有会话会挂回新 socket**：注册成功时中继会把该主机名下的会话作为
  `peer-joined` 重放给已连接的客户端，让客户端知道原来的 `convId` 还能继续用。
- **每个清扫周期（`DRC_SWEEP_MS`）做四件事**：清过期/已用的配对码 → 给所有 socket 发 WS 层
  ping 并把上一轮没回 pong 的连接 `terminate()`（默认最坏约 2×5 秒判死）→ 判 host 宽限期是否到期
  → 回收空闲超过 `DRC_CONV_IDLE_TTL_MS` 的会话。保活**只走 WS 层 ping**：主机与小程序都不发
  应用层心跳，把它改成依赖应用层心跳会周期性踢掉所有空闲客户端。
- **客户端断开不删会话**（D3），成员表里的 `clientId` 也留着：手机重连时用同一个 `clientId`
  注册即自动重新挂上。真正的回收只由空闲 TTL / 主机宽限期到期 / 主机主动作废三条路触发。
- **反代层还要做的**：按 IP 的连接数与请求速率限制（§7.1）、TLS 终止。中继看不到真实客户端 IP。

---

## 7. HTTPS / WSS 反向代理

中继自己**不终止 TLS**。小程序真机只允许 `wss://`，所以公网部署必须有反代。
仓库里的 `deploy/nginx/drc.conf` 是**正在生产使用的配置**，不是示例，改它之前先读它的注释。 **[已验证]**

拓扑：`drc.provid.cc --wss--> nginx(TLS) --ws--> 127.0.0.1:8787`。

### 7.1 nginx（生产用的就是这一份）

```sh
scp deploy/nginx/drc.conf root@HOST:/etc/nginx/conf.d/drc.conf
ssh root@HOST 'nginx -t && systemctl enable --now nginx'
```

要点（`deploy/nginx/drc.conf` 逐条对应）：

- **按 IP 限流做在反代**：`limit_req_zone $binary_remote_addr zone=drc:10m rate=20r/s`、
  `limit_conn_zone $binary_remote_addr zone=drc_conn:10m`，location 内
  `limit_req zone=drc burst=40 nodelay` + `limit_conn drc_conn 8`。
  中继只有全局与单连接两级配额，**看不到真实客户端 IP**，所以这一层必须由反代做
  （把爆破概率再压一两个数量级的关键一环）。
- WS 升级三件套 `proxy_http_version 1.1` + `Upgrade`/`Connection $connection_upgrade`
  （`map` 在 http 层，conf.d 正好被 include 在 http 块内，所以这份文件里可以直接写），
  并透传 `Host` / `X-Real-IP` / `X-Forwarded-For` / `X-Forwarded-Proto`。
- 长连接：`proxy_read_timeout 3600s`、`proxy_send_timeout 3600s`、`proxy_buffering off`。
- TLS：`listen 443 ssl` + `http2 on`、`TLSv1.2/1.3`、`ssl_prefer_server_ciphers off`、
  session cache `shared:SSL:10m`/1d、HSTS `max-age=31536000`、`X-Content-Type-Options nosniff`；
  80 端口只做 301 跳转。
- 独立日志：`/var/log/nginx/drc.access.log`、`/var/log/nginx/drc.error.log`。
- `proxy_pass` 写死了 `http://127.0.0.1:8787`：**改了 `DRC_PORT` 就要同时改这里**，
  否则 nginx 200 而中继在别的端口上没人理。

证书（生产用 acme.sh + 阿里云 DNS-01，不需要占用 80 端口）：

```sh
acme.sh --issue --dns dns_ali -d drc.example.com --server letsencrypt
acme.sh --install-cert -d drc.example.com \
  --key-file       /etc/nginx/ssl/drc.example.com.key \
  --fullchain-file /etc/nginx/ssl/drc.example.com.crt \
  --reloadcmd      "systemctl reload nginx"
```

路径要与 `drc.conf` 里的 `ssl_certificate*` 对上。生产实例复用既有的 `*.provid.cc` 泛解析，
没有新增解析记录。 **[已验证：`deploy/README.md`]**

### 7.2 Caddy（最省事，但本仓库没用过）

```caddyfile
drc.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

自动签发证书，WebSocket 升级透明转发。客户端用 `wss://drc.example.com`，
并设 `DRC_PUBLIC_URL=wss://drc.example.com`。 **[未实测]**

### 7.3 然后

```sh
DRC_PUBLIC_URL=wss://你的域名      # env 文件里，改完 restart
curl -s https://你的域名/api/info  # 应当回显这个地址
```

别忘了小程序侧：域名必须加进微信后台的 **socket 合法域名**白名单，否则真机连不上。

---

## 8. 常驻

### 8.1 systemd（Linux，生产用的就是这一份）

`deploy/systemd/dsh-remote-control.service` 的关键行（照抄自该文件，**别再写 `src/main.mjs`**）：

```ini
WorkingDirectory=/opt/dsh-remote-control/server
EnvironmentFile=/etc/dsh-remote-control.env
ExecStart=/usr/bin/node /opt/dsh-remote-control/server/relay.mjs
Restart=always
RestartSec=3
TimeoutStopSec=15
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dsh-remote-control
```

注意 `ExecStart` 是**绝对路径指向那一个文件**——单元旁边没有 `node_modules`，也不需要有。
单元里**没有** `DRC_BIND`，所以走代码默认 `127.0.0.1:8787`。
沙箱：`NoNewPrivileges`、`PrivateTmp`、`ProtectSystem=strict` + `ReadWritePaths=/opt/dsh-remote-control`、
`ProtectHome`、`ProtectKernelTunables/Modules/ControlGroups`、
`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`、`MemoryMax=512M`。
**换部署目录时 `ReadWritePaths` 要一起改**。 `TimeoutStopSec=15` 是刻意留的余量：代码自己
5 秒兜底强退，systemd 不该比它先动手。 **[已验证：`deploy/systemd/dsh-remote-control.service`]**

```sh
# 本机：把单元与产物推上去
scp apps/server/dist/bundle/main.js root@HOST:/opt/dsh-remote-control/server/relay.mjs
scp deploy/systemd/dsh-remote-control.service root@HOST:/etc/systemd/system/

# 服务器上（或由本机 ssh 执行）
systemctl daemon-reload
systemctl enable --now dsh-remote-control
systemctl status dsh-remote-control
journalctl -u dsh-remote-control -f
```

env 文件（与主机插件那份 token 必须逐字一致）：

```sh
cat > /etc/dsh-remote-control.env <<'EOF'
DRC_HOST_TOKEN=<openssl rand -hex 32 的输出>
DRC_PORT=8787
DRC_PUBLIC_URL=wss://drc.example.com
DRC_PAIR_TTL_MS=90000
DRC_LOG_LEVEL=info
EOF
chmod 600 /etc/dsh-remote-control.env
systemctl restart dsh-remote-control
```

### 8.2 launchd（macOS）

launchd 没有 `EnvironmentFile`，凭据得写在 plist 或包装脚本里。把产物放在固定路径
（`node` 那行换成 `which node` 的实际路径，Apple Silicon 上通常是
`/opt/homebrew/bin/node`），然后 `~/Library/LaunchAgents/com.dsh.remote-control.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh.remote-control</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/dsh-remote-control/relay.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DRC_PORT</key><string>8787</string>
    <key>DRC_PUBLIC_URL</key><string>wss://drc.example.com</string>
    <key>DRC_HOST_TOKEN</key><string>REPLACE_ME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/dsh-rc-relay.log</string>
  <key>StandardErrorPath</key><string>/tmp/dsh-rc-relay.err</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.dsh.remote-control.plist
```

旧模板里 `/opt/dsh-remote-control/apps/server/src/main.mjs` 那一行指向的文件已经不存在了；
换成上面这个单文件之后，常驻退化成"一个文件、一条命令、没有依赖安装步骤"。 **[未实测]**

### 8.3 Docker

仓库里**没有** Dockerfile（生产是裸 systemd + nginx），下面这份按当前产物形态自己存一份，
例如 `deploy/Dockerfile`：

```dockerfile
FROM node:22-slim
WORKDIR /app
# 只有一个文件要拷，没有 package.json、没有 npm install
COPY apps/server/dist/bundle/main.js /app/relay.mjs
ENV DRC_PORT=8787
# 容器自己就是边缘：默认绑定是 127.0.0.1，不覆盖的话 -p 发布出来的端口没人监听
ENV DRC_BIND=0.0.0.0
EXPOSE 8787
CMD ["node", "/app/relay.mjs"]
```

```sh
env -u NODE_OPTIONS pnpm --filter @dsh-rc/server build
docker build -f deploy/Dockerfile -t dsh-rc-relay .
docker run -d --name drc -p 8787:8787 \
  -e DRC_HOST_TOKEN=$(openssl rand -hex 32) \
  -e DRC_PUBLIC_URL=wss://drc.example.com \
  dsh-rc-relay
```

**`DRC_BIND=0.0.0.0` 这条不能省**（代码默认只绑回环；旧文档的 Docker 示例没写它，照抄会起来一个
端口发布成功但外面连不上的容器）。若只在本机跑反代再转发进容器，可以用
`--network host` 或把发布改成 `127.0.0.1:8787:8787` 并保持默认绑定。 **[未实测]**

---

## 9. 优雅停机与暴露面

`SIGTERM` / `SIGINT` 之后（`apps/server/src/main.ts` + `server.close()`）：

1. 置 `shuttingDown`：新 WebSocket 连接直接 1013 `server_shutdown`，HTTP upgrade 回 503；
2. 停止清扫定时器；
3. 给所有已连接 socket 发 `1001 server_shutdown`；
4. 关闭 HTTP 监听，等它的 `close` 回调 → **exit 0**；5 秒没走完就强退，**仍是 exit 0**。

未捕获异常（`uncaughtException` 事件）与未处理的 rejection 走另一条路：记一行 error 日志后
**exit 1**，把重启交给 `Restart=always`——无值守进程里"活着但坏了"比"死了被拉起来"更糟。 **[已验证：
`hardening.test.mjs` 断言对端收到 1001 且进程 exit 0；`bundle.test.mjs` 断言产物 SIGTERM exit 0]**

暴露面：

- 只需要放行 **一个端口**（默认 8787），而且它应当**只对回环开放**：公网走 443。
  生产安全组只放 `22 / 80 / 443`，8787 不对公网。 **[已验证：`deploy/README.md`]**
- 同一个端口上既有 HTTP（`/healthz`、`/api/info`；`/api/pair-status` 默认 404）也有 WebSocket
  （**路径不设限**，根路径与 `/ws` 之类都能升级——收窄会把已发布的地址全部弄断）。
- 把 `/healthz` 暴露到公网是安全的（只有计数），但 `/api/info` 会泄露对外地址，无所谓就别单独暴露。
- **不要**把明文 `ws://` 直挂公网就跑：小程序真机不允许，而且配对码与密文在链路上可见
  （插件配置校验对"非回环地址走 `ws://`"会专门 warn）。

---

## 10. 本机 host 侧（跑 DSH 的那台机器）

host 插件是跑在 DSH 进程里的 cordis bundle，它的产物同样是**自包含单文件**
（`packages/plugin/dist/bundle/index.js`，约 1.2 MB；`ws` / `zod` / `tweetnacl` / `qrcode`
全部内联，`cordis` 与 `@deepseek-ai/*` 刻意留在外面——宿主注入的东西打进去会造成两份实例）。

### 10.1 起一个本地中继

```sh
env -u NODE_OPTIONS pnpm --filter @dsh-rc/server build
./scripts/relay-start.sh --bundle     # 127.0.0.1:8787，token 复用 profile 里那一份
```

细节见 §3。生产部署不走这个脚本（走 systemd + `/etc/dsh-remote-control.env`），它只服务本地。

### 10.2 装插件

```sh
./scripts/install-to-profile.sh                      # 目标 ~/.dsh/profiles/desktop
DSH_PROFILE=~/.dsh/profiles/tui ./scripts/install-to-profile.sh
```

按脚本内容逐条说明它会做什么：

1. **构建**：`env -u NODE_OPTIONS pnpm --filter @dsh-rc/protocol build` +
   `node scripts/bundle-plugin.mjs`。刻意**不跑 tsc**——装 profile 只需要产物，
   单元测试编译失败不该挡住"把当前代码装进宿主验一把"；类型检查是
   `env -u NODE_OPTIONS pnpm -r typecheck` / CI 的事。
2. **目标必须是真目录**：`$PROFILE/node_modules/dsh-remote-control` 若是**软链**，
   脚本直接报错退出，并让你先删掉 profile `package.json` 里的 `dependencies.dsh-remote-control`。
3. **整目录先删后建**再拷：只删 `index.js`/`package.json` 的话，上一次 `pnpm` 物化出来的
   `dist/`、`node_modules/` 会被当成当前版本的一部分。
4. 拷 `index.js`（单文件产物）并在该目录生成一份 `package.json`，里面带着
   **`dsh.bundle.patch = "./cordis.patch.yml"`** 这个入口字段，并把插件自带的
   `cordis.patch.yml` 一起拷进去。漏了这个字段，文件都在、`bundles` 列表里也有名字，
   但插件根本不会被加载（踩过一次）。
5. **改写 profile 自己的 `package.json`**（每次都先留一份
   `package.json.bak-drc-<unix 秒>` 备份，因为这文件里同时带着 `hostToken`）：
   把 `dsh-remote-control` 追加进 `dsh.profile.bundles`（幂等），并且
   **从 `dependencies` / `devDependencies` / `optionalDependencies` 里删掉残留的
   `"dsh-remote-control": "file:…"`**。
6. 打印下一步提示：必须重启 Harness。

**为什么必须删掉那条 `file:` 依赖**（这是本机排查里最贵的一课）：那条是上一代安装方式
（`pnpm add file:…/packages/plugin`）留下的。只要它还在，`pnpm install` 就会把整个工作区包
**再物化一份**进 profile，于是宿主里同时跑着**两个插件实例**：两个 `hostId`、中继里两份会话、
手机连到哪一个全凭运气，而 `status.json` 的计数来自另一个实例——表现就是"改了的代码没生效"
和"数字怎么都对不上"。现在的安装方式只有这一条：单文件 bundle + `bundles` 列表里的名字。 **[已验证：
`scripts/install-to-profile.sh` + `HANDOFF.md` §4.2；本机 profile 现在 `bundles` 里有名字、
`dependencies` 里没有该条目、`node_modules/dsh-remote-control` 是真目录]**

改完代码必须**重启 Harness**：HMR 只热更 `cordis.patch.yml` 里的配置，不会重新 `import` dist。

```sh
osascript -e 'tell application "DeepSeek Harness" to quit'; sleep 6; open -a "DeepSeek Harness"
```

### 10.3 插件配置（profile 的 `cordis.patch.yml`）

优先级：**环境变量 > patch 注入的 config > 默认值**。键名一律沿用旧名
（这些键写在用户机器的 patch 里，改名等于让线上配置静默失效）。

| 键 | 默认 | 环境变量覆盖 | 说明 |
|---|---|---|---|
| `enabled` | `true` | — | 关掉就什么都不做 |
| `serverUrl` | `ws://127.0.0.1:8787` | `DRC_SERVER_URL` | 公网填 `wss://…`。不是 `ws(s)://` 开头 = error 级、不启动 runtime |
| `hostToken` | `''` | 由 `hostTokenEnv` 指定名 | 空 = error 级；短于 24 字符 = warn。本机的做法是**把它直接写进 profile 的 patch**（GUI 方式启动的宿主通常没有你的 shell env；`deploy/README.md` 记录的就是这条路） |
| `hostTokenEnv` | `DRC_HOST_TOKEN` | — | token 的**取值**来源环境变量名；置空字符串则不读 env。注意**同名 env 变量存在时会覆盖 patch 里的 `hostToken`** |
| `hostId` | `''` | `DRC_HOST_ID` | **留空时插件每次进程启动随机生成 `h_<6 hex>`**（同一进程内稳定，所以 socket 抖动重连仍能挂回原会话）。想跨重启认出同一台主机（日志对齐、`/healthz` 计数、多台主机共存）就显式配一个固定值 |
| `hostLabel` | `dsh-host` | `DRC_HOST_LABEL` | 日志与 `hello` 里的显示名 |
| `pairTtlMs` | `120000` | — | 只是**向中继申请**的值，服务端 `pair-ready.ttlMs` 才是准的 |
| `pairOnStartSec` | `0`（关） | `DRC_PAIR_ON_START_SEC` | >0 时启动即自动发布一张码并把 QR 写进 `status.json`。**开了会把"仍然有效的配对码 + PSK"放进 0600 的 status.json，配置校验会 warn，取证用完关掉**。`Infinity` / 负数 / 非有限值一律折回 0 |
| `unarchiveOnPrompt` | `true` | — | 对归档会话下发指令时自动恢复 |
| `takeOverQuestions` | `false` | `DRC_TAKE_OVER_QUESTIONS=1` | 会剥夺桌面 UI 的提问能力，所以默认关 |
| `approvalTimeoutSec` | `180` | — | 审批卡超时 |
| `listingRefreshSec` | `15` | — | 会话列表刷新周期 |
| `keepAwake.enabled` / `idleReleaseSec` / `keepDisplay` | `true` / `300` / `false` | — | `idleReleaseSec` 不是有效非负数会夹回 300 |
| `qrImage` / `qrOpen` / `qrStyle` | `true` / `true` / `ascii` | `DRC_QR_IMAGE=0` / `DRC_QR_OPEN=0` / `DRC_QR_STYLE` | 终端二维码与 PNG |
| `statusFile` | `~/.dsh/dsh-remote-control/status.json` | — | 置空关闭状态快照（GUI 宿主里这是唯一排错入口） |
| `mockBridge` | `false` | `DRC_MOCK_BRIDGE=1` | 强制内存替身内核，**别用在真机上** |

日常配对路径：DSH 里执行 `/drc pair`（渲染终端二维码并写 PNG）→ 小程序扫码或粘贴链接内容。

### 10.4 排错第一入口：`status.json`

```sh
cat ~/.dsh/dsh-remote-control/status.json
```

值得看的字段：`carrier`（`services`=真内核 / `mock`=内存替身 / `probing`=还没探到载体 /
`none`=没起来，`reason` 字段会写 `disabled` 或 `no-carrier`）、
`relay`（`online`/`connecting`/`offline`）与 `relayProblem`、`conversations`、`pendingPairs`、
`pairing`（开了 `pairOnStartSec` 才有：`token` / `psk` / `qr` / `ageSec`）、`outbound`
（按载荷类型的出站计数——分清"插件没发"还是"发了但路上丢了"）、
`probe`、`kernel.*`、`problems`（`level:field` 形态的配置诊断）。
`hostToken` 永远不出现真值，只有 `hostTokenShape` 的脱敏形态（前 4 + `…` + 后 2 + 长度），
这条有测试锁住。文件写入是 0600 + 临时文件改名原子替换。 **[已验证：`packages/plugin/src/index.ts`
/ `shell/status.ts`；本机快照现在 `carrier=services`、`relay=online`]**

`relay` 长时间停在 `connecting` 且不报错，是一种特定的病：**版本不匹配**（见 §11.2 的兼容矩阵），
不是网络问题。

---

## 11. 升级与回滚

### 11.1 升级（中继侧，三条命令）

```sh
env -u NODE_OPTIONS pnpm --filter @dsh-rc/server build
scp apps/server/dist/bundle/main.js root@HOST:/opt/dsh-remote-control/server/relay.mjs
ssh root@HOST 'systemctl restart dsh-remote-control'
curl -s https://drc.provid.cc/healthz          # version 必须是新版本，不是 0.0.0
```

`relay.mjs` 旁边没有 `package.json`，也没有 `node_modules`：**升级就是替换一个文件**。
重启会丢掉全部配对关系（§6），所以挑一个没人正在用手机的时刻；主机与手机会各自重连回来。

升级 host 插件：

```sh
./scripts/install-to-profile.sh
# 然后重启 Harness（不重启等于没升级：HMR 不会重新 import dist）
osascript -e 'tell application "DeepSeek Harness" to quit'; sleep 6; open -a "DeepSeek Harness"
cat ~/.dsh/dsh-remote-control/status.json      # relay 应回到 online
```

发布前建议跑一遍取证（都是仓库里真能跑的命令）：

```sh
env -u NODE_OPTIONS pnpm -r typecheck && env -u NODE_OPTIONS pnpm -r test
env -u NODE_OPTIONS node e2e/run.mjs                        # 本地全链路 14 步
env -u NODE_OPTIONS node --test e2e/restart-resume.test.mjs # 重启续用三族分支
env -u NODE_OPTIONS node e2e/live-e2e.mjs --rounds 3        # 真链路：真 mp 代码 / 真中继 / 真内核
```

`live-e2e` 打的是 `DRC_LIVE_RELAY`（缺省 `wss://drc.provid.cc`），
配对码来源是插件写进 `status.json` 的 `pairing`（**需要 profile 开 `pairOnStartSec`**）；
它拿不到真实配对码就直接失败，绝不退化成 mock 主机——旧的那个"自建主机"模式掩盖过一次真故障。
`live-e2e` **不在 CI 里**（要真内核与线上课），是发布前人工跑的最高标准。 **[已验证：
`HANDOFF.md` §1、`e2e/live-e2e.mjs`]**

### 11.2 回滚必须**成对**：中继产物 + 插件产物

**不能只回滚一边**，因为两侧握手是双向不兼容的：

| 组合 | 结果 | 为什么 |
|---|---|---|
| 新 host + 旧中继 | **配对永远不成功** | 新 host 发的 `pair-begin` **不带 `psk`**（D1：PSK 从不上网），旧 `main.mjs` 要求 `typeof psk==='string' && psk.length>=16`，缺字段即 `error{bad_pair}`。（新 host 的 `hello{role:'host'}` 在旧中继那里也会被 `bad_role` 拒掉，因为旧中继的 `hello` 只服务 client） |
| 旧 host + 新中继 | **静默不上线**：`status.json` 的 `relay` 一直停在 `connecting`，也不报 auth-failed | D5 把 `auth`/`auth-ok`/`auth-fail` 并进了 `hello`/`hello-ok`，新中继的 `endpointFrame` 判别联合里没有 `auth` → 回 `error{unknown_frame}` → 旧插件把它丢掉，于是永远等不到注册成功 |

关于"zod 默认 strip 多余字段"要说准：它只保证**字段级**的向前兼容——旧 host 的
`pair-begin{psk}` 确实能被新中继解析（多余的 `psk` 键被剥掉，不报错）。但它救不了
**帧名级**的断掉：握手那一帧在 D5 之后换了名字，所以"旧 host + 新中继 兼容"这个说法
（`docs/DESIGN-REVIEW.md` N3 只看了 `pair-begin` 那一层；`HANDOFF.md` §3 与
`docs/SECURITY.md` 的回滚一节都已按帧名改正）
**在实践中不成立**。这一条是读代码 + 复核记录得出的，**我没有真的把旧产物起来做过双向对拍**，
属于[未实测]；但结论可以照用，因为回滚两侧成对走本来就不需要依赖它。

小程序侧不受影响：`mp/` 冻结，它只发 `hello` / `pair-begin-client` / `enc` 三种控制帧
（F2，两代中继都认），**回滚不涉及小程序发版**。

### 11.3 回滚步骤

先把每次上线的两个产物按版本号存下来（这是 `docs/DESIGN.md` §7-E④ 要求的那条回滚路径）：

```sh
# 升级前，先备份现网正在跑的两个文件
mkdir -p ~/drc-backup
ssh root@HOST 'cp /opt/dsh-remote-control/server/relay.mjs /opt/dsh-remote-control/server/relay.mjs.prev'
cp ~/.dsh/profiles/desktop/node_modules/dsh-remote-control/index.js ~/drc-backup/plugin-index.js.prev
```

回滚 = 两份一起退：

```sh
# 1) 中继
scp <上一版>/relay.mjs root@HOST:/opt/dsh-remote-control/server/relay.mjs
ssh root@HOST 'systemctl restart dsh-remote-control'
curl -s https://drc.provid.cc/healthz        # version 回到上一版

# 2) 插件：装回上一版单文件，然后重启 Harness
cp ~/drc-backup/plugin-index.js.prev ~/.dsh/profiles/desktop/node_modules/dsh-remote-control/index.js
osascript -e 'tell application "DeepSeek Harness" to quit'; sleep 6; open -a "DeepSeek Harness"
```

只退一边会留下上表里的某一行：只退中继 = 配对永远不成功（新 host 发不出旧中继要的 `psk`）；
只退插件 = 主机静默不上线（`relay` 卡在 `connecting`、日志里一条错误都没有）。
两种都比"看回滚清单"贵得多，所以两份必须一起动。

> 用 `cp` 直接换 `index.js` 时，同目录那份由 `install-to-profile.sh` 生成的 `package.json`
> 里写的还是新版本号——顺手改回去，否则 `status.json` 与宿主日志会报一个对不上的版本。

要退到 `b026d63` 那一代实现：旧产物不在本分支的 `dist/` 里，得从那个提交重建整棵树
（旧插件还要 `pnpm add file:`、`npm install --omit=dev`），并且**必须中继与插件同时退**。
实操上远不如"退到上一个自己构建的单文件版本"便宜——这也是为什么 §11.2 要求每次上线都存产物。

### 11.4 回滚之后的验收

别只 `curl /healthz`：那只证明进程活着。按 `docs/DESIGN-REVIEW.md` §7-E④ 的意见，
回滚验收要**做一次真配对**：`/drc pair` 出码 → 手机扫码 → 手机上出现会话列表 →
`/healthz` 的 `hosts`、`clients`、`conversations` 各加 1 → 发一条指令拿到流式回复。 **[未实测]**

---

## 12. 哪些已在生产实例上验证过

生产实例（`deploy/README.md`，2026-10-02 切换）：

| 项 | 值 |
|---|---|
| 公网入口 | `wss://drc.provid.cc` |
| ECS | 阿里云 cn-shanghai / `i-uf62gq3vjcvqzi8f9ozj` / `47.100.82.15` / Alibaba Cloud Linux 4（Node 22） |
| 中继 | `/opt/dsh-remote-control/server/relay.mjs` —— **就是当前这条打包路径产出的自包含单文件**，`/healthz` 报 `version: 2.0.0` |
| 反代 / 证书 | nginx 1.30 + `/etc/nginx/conf.d/drc.conf`；Let's Encrypt（acme.sh + 阿里云 DNS-01，ECC，自动续期） |
| 绑定 | 中继只听 `127.0.0.1:8787`，公网只暴露 80/443 |
| 密钥 | `/etc/dsh-remote-control.env`（600）；同一份 token 在 macOS 的 `~/.dsh/profiles/desktop/cordis.patch.yml` |
| 真实链路 | `node e2e/live-e2e.mjs`：**18 项/轮全绿**，生产入口 1 轮 + 本地中继 3 轮；助手正文 114/162 字与 2 条工具行确实到了手机 |

**已验证**：单文件产物在生产上跑着（`/healthz` 计数与 `version` 对得上）、nginx 那份配置、
systemd 那份单元、优雅停机与重启后 `unknown_session` 的行为（测试层）、
`install-to-profile.sh` 的产物形态（本机 profile 就是它装的）。

**没有实测、只是照代码写的**：Caddy 反代、launchd 常驻、Docker 部署、
`journalctl -p warning` 的实际过滤效果（§5.3）、停机窗口的探针行为（§4）、
回滚到 `b026d63` 那一代、双向兼容矩阵的真实对拍（§11.2）、回滚后的真配对验收（§11.4）。

另外记两条**没能在真机上取证**的（不是部署问题，但会误导你判断"这套东西到底通不通"）：
真机上的**审批卡**（本机这些会话的工具被宿主策略直接放行，审批从未发起）与**提问卡**
（这一代宿主没暴露 `userQuestions.registerProvider`）。两者都只在本地全链路里验过。
出处 `HANDOFF.md` §1.1。

---

## 13. 一页速查

```sh
# 构建 / 部署（中继）
env -u NODE_OPTIONS pnpm --filter @dsh-rc/server build
scp apps/server/dist/bundle/main.js root@HOST:/opt/dsh-remote-control/server/relay.mjs
ssh root@HOST 'systemctl restart dsh-remote-control'

# 看它活着没 / 跑的是哪版
curl -s https://drc.provid.cc/healthz
journalctl -u dsh-remote-control -o cat | grep '"level":"warn"'

# 本机（host 侧）
./scripts/relay-start.sh --bundle
./scripts/install-to-profile.sh
cat ~/.dsh/dsh-remote-control/status.json

# 取证
env -u NODE_OPTIONS pnpm -r typecheck && env -u NODE_OPTIONS pnpm -r test
env -u NODE_OPTIONS node e2e/run.mjs
env -u NODE_OPTIONS node --test e2e/restart-resume.test.mjs
env -u NODE_OPTIONS node e2e/live-e2e.mjs --rounds 3
```

> **每条 `pnpm` 命令都要带 `env -u NODE_OPTIONS` 前缀。** 原因（`HANDOFF.md` §4.1）：
> Qoder CLI 会往子 shell 注入 `NODE_OPTIONS=--require ".../cjs-js-proxy-registry.js"`，
> Node 22 的 ESM loader 解析不了它（`ERR_LOADER_CHAIN_INCOMPLETE`），
> **任何** `pnpm` 带依赖解析的调用（build / test / install）都会挂。
