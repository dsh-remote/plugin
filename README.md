# dsh-remote-control

在手机上远程操作 **DeepSeek Harness（DSH）**：下发指令、看流式输出、审批工具调用、回答问题，并且让主机在任务跑完前**不要休眠**。

三件套：

| 组成 | 目录 | 作用 |
|---|---|---|
| **Host 插件** | `packages/plugin` | 跑在 DSH 进程里的 cordis bundle：连接中继、桥接内核、防休眠 |
| **中继服务** | `apps/server` | 自建 WebSocket 中继，**零知识**（只转发密文） |
| **小程序客户端** | `mp` | 微信小程序：配对 / 会话列表 / 对话 / 审批 / 提问 / 防休眠开关 |

载荷级端到端加密：中继服务器从头到尾只看到 `base64(nonce ‖ secretbox)`，没有任何密钥。

---

## 架构

```
┌──────────────────┐   ws (host token)    ┌───────────────┐   ws (配对码)   ┌──────────────────┐
│  DSH 桌面应用      │ ──────────────────▶ │  relay server │ ◀────────────── │ 微信小程序        │
│  (cordis bundle) │   审计：只见密文      │  apps/server  │                 │  mp/             │
└──────────────────┘                      └───────────────┘                 └──────────────────┘
        │
        │ 防休眠：macOS caffeinate / Linux systemd-inhibit（Windows 预留）
        ▼
   端到端加密数据面（@dsh-rc/protocol）
   cmd.list_sessions / cmd.send_prompt / cmd.answer / cmd.resolve_permission /
   cmd.interrupt / cmd.keep_awake / cmd.subscribe   ⇄
   ev.session_changed / ev.message_delta / ev.tool_event / ev.permission_request /
   ev.question_request / ev.run_state / ev.keep_awake_state / ev.result
```

**信任模型**

- 中继持有 `DRC_HOST_TOKEN`（host 出站认证）与配对码路由表，**没有载荷密钥**。
- 配对时 host 生成 16 字节 PSK，通过二维码交给小程序；双方各自派生 `c2h` / `h2c`
  两个方向的会话密钥（`derivePskKey(psk, dir, convId)`）。
- TLS 由部署方负责（反代 `wss://`）。详见 [`docs/SECURITY.md`](docs/SECURITY.md)。

---

## 快速开始

### 1. 起中继服务

```sh
cd apps/server
DRC_HOST_TOKEN=$(openssl rand -hex 24) DRC_PORT=8787 node src/main.mjs
# 健康检查：curl http://127.0.0.1:8787/healthz
```

把同一个 `DRC_HOST_TOKEN` 配给 host 插件。公网部署见 [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md)。

装进 desktop profile 之后，token 已经写进 `~/.dsh/profiles/desktop/cordis.patch.yml`，
直接用 helper 起服务即可自动取同一个 token：

```sh
./scripts/relay-start.sh              # 默认 8787
DRC_PORT=9000 ./scripts/relay-start.sh
```

### 2. 安装 host 插件

```sh
cd ~/.dsh/profiles/desktop
pnpm add -w file:/Users/linbin/dsh-remote-control/packages/plugin
```

然后把 `"dsh-remote-control"` 加进 `~/.dsh/profiles/desktop/package.json` 的
`dsh.profile.bundles` 数组，并配置：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-remote-control"]
    }
  }
}
```

重启 Harness 生效。也可以用环境变量，不改配置文件：

```sh
export DRC_SERVER_URL=wss://drc.example.com
export DRC_HOST_TOKEN=<同一个 token>
export DRC_HOST_LABEL=bins-macbook
```

### 3. 配对

在 DSH 的 TUI 里执行（插件注册了 `drc` 命令）：

```
drc pair 120
```

它会打印 6 位配对码和一段二维码文本（`dshr:/p?s=…&n=…&psk=…`）。把二维码显示出来，
用小程序扫码后输入 6 位码即可。

> 二维码文本可以直接用任意二维码生成器/终端二维码渲染出来。

### 4. 用小程序控制

微信开发者工具打开 `mp/` 目录：

- 勾选「**不校验合法域名**」（开发期）；
- 已在 `mp/project.config.json` 里配置真实 appid（真机调试/预览都可用）；
- 真机必须用 `wss://`，且域名要在小程序后台的 socket 合法域名白名单里。

---

## 目录结构

```
packages/protocol   线协议 + 端到端加密（tweetnacl）+ 防休眠命令构造器
packages/plugin     Host 插件：relay-client / host-runtime / bridge / adapter-dsh / adapter-mock
apps/server         零知识 WebSocket 中继（node:http + ws，无构建步骤）
mp                  微信小程序客户端（原生，utils 里内置了移植版 tweetnacl）
e2e                 全链路测试：真实 server + HostRuntime + 模拟小程序
docs                SECURITY / SELF-HOSTING / MINI-PROGRAM
```

---

## 已部署实例

`wss://drc.provid.cc`（阿里云 ECS + nginx + Let's Encrypt）。
配置在 [`deploy/`](deploy/README.md)，一键自检：

```sh
node scripts/verify-deployment.mjs        # 自建主机跑完整闭环
node scripts/verify-deployment.mjs --pair <6位码> --qr '<dshr:/p?…>'   # 连正在运行的主机
```

## 测试

```sh
pnpm install -r
pnpm -r build
pnpm -r test      # 77 项 + relay e2e 9 步
node e2e/run.mjs  # 单独跑：配对→指令→审批→提问→防休眠→中断→零知识审计
node scripts/validate-qr.mjs  # 二维码：zxing-cpp 真实解码 28 组
```

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `packages/protocol` | 11 | 加密、篡改检测、配对 QR（含内嵌配对码）、三平台防休眠命令 |
| `apps/server` | 13 | 中继闭环 + **加固行为**（限流、帧大小上限、连接上限、优雅停机、孤儿会话清理） |
| `packages/plugin` | 27 | 激活降级、carrier 选择、配置校验、恶意 ctx 不抛异常、状态文件、**终端二维码**、会话列表/归档/事件窗口 |
| `e2e/mp-crypto` | 11 | 小程序 crypto 与 Node **逐字节对拍** |
| `e2e/mp-client` | 8 | 真实小程序客户端代码走完整闭环 |
| `e2e/mp-platform` | 3 | 无 `connectSocket` 的容器：如实报错 + 旧式全局回调回退 |
| `e2e/run.mjs` | 9 步 | 真实 server + HostRuntime + 模拟小程序 + 零知识审计 |

后两个是专为小程序写的（CI 里开不了微信开发者工具）：

- `e2e/mp-crypto.test.mjs` —— 把 `mp/utils/drc-crypto.js` 拉到 Node 里，
  与 `packages/protocol` 的 `seal/open/derivePskKey` **逐字节对拍**。
- `e2e/mp-client.test.mjs` —— 用一个 `wx` shim 跑**真实的小程序客户端代码**
  （`mp/utils/drc.js`），对真实中继 + HostRuntime 走完整闭环。

CI 见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：Node 20 / 22 双版本跑
构建 + 全部测试 + relay 冒烟。

## 已做的生产加固

中继：

- 帧大小上限（默认 256 KB，超限断连）、并发连接上限、单连接帧速率配额；
- host 认证失败次数上限、配对码错误次数上限、全局配对速率配额 ——
  防止 6 位配对码被枚举（详见 [`docs/SECURITY.md`](docs/SECURITY.md)）；
- `/api/pair-status` **默认关闭**（它是个无需认证的配对码 oracle）；
- 待配对表有上限，防止无界增长；
- `SIGTERM` / `SIGINT` 优雅停机：停止接入 → 通知客户端 → 0 退出；
- 结构化 JSON 日志（`DRC_LOG_LEVEL`）；
- host 掉线时清理其会话，不留孤儿状态。

插件：

- 配置校验（URL 方案、token 存在性），问题分级为 error / warn；
- `apply()` 绝不向外抛异常 —— 远程控制插件不能拖垮 Harness 启动；
- 所有异步入口都有 `.catch()`，不会有逃逸的 unhandled rejection 污染宿主进程；
- 日志里的 token 一律脱敏；
- **写一份状态快照** `~/.dsh/dsh-remote-control/status.json`。Harness 是 GUI 程序，
  stdout 通常没人看得到，所以「插件起来没有 / 有没有挂上真内核」必须能从文件系统问出来：

  ```json
  {
    "updatedAt": "2026-10-01T06:20:00.000Z",
    "carrier": "apiproxy",         // apiproxy/typert = 真实内核；mock = 内存桥接（会话是假的）
    "serverUrl": "wss://drc.provid.cc",
    "relay": "online",
    "hostId": "724cf186",
    "clients": 0,
    "keepAwake": { "enabled": true, "active": false, "backend": "caffeinate" },
    "bridge": { "carrier": "apiproxy", "lastError": null }
  }
  ```

---

## 防休眠

`KeepAwake` 只在「会话运行中 / 有审批或提问挂起」时持锁，空闲 `idleReleaseSec`
（默认 300 秒）后自动释放，**本地空闲时机器照常睡眠**。

| 平台 | 实现 |
|---|---|
| macOS | `/usr/bin/caffeinate -i -s -w <pid>`（不需要 sudo） |
| Linux | `systemd-inhibit --what=idle:sleep --mode=block` |
| Windows | 预留（`SetThreadExecutionState`，默认关闭） |

---

## 当前状态与已知限制

- ✅ protocol / plugin / server 单测、小程序 crypto 对拍、小程序客户端全链路、relay e2e 全绿。
- ⚠️ `adapter-dsh.ts` 的真实内核挂接**尚未在真机 DSH 上验证**。本机 rc.6 的
  `ctx.typertGateway` 只有 `invoke()`、没有流式事件，插件会软降级；审批流在本机
  可能走 `apiProxy` 路径。安装后请看日志确认 `carrier=dsh` 而不是 `carrier=mock`。
- ⚠️ 中继是纯内存的，重启后配对关系丢失（客户端会提示重新配对）。
- ⚠️ 真机需要在微信后台把 `drc.provid.cc` 加入 **socket 合法域名**（域名需备案）。

---

## License

MIT — 见 [`LICENSE`](LICENSE)。
