# DSH远控宿主插件（`@dsh-remote/plugin`）

在手机上远程操作 **DeepSeek Harness（DSH）**：下发指令、看流式输出、审批工具调用、回答问题，
并让主机在任务跑完前**保持唤醒**。

**载荷级端到端加密**：中继从头到尾只见 `base64(nonce ‖ secretbox)`——不是"我们不查"，
而是密钥在协议层的依赖图上就不可达（中继的构建产物里没有任何密码学实现，有测试锁住）。

## 安装

```sh
dsh plugin --profile web add @dsh-remote/plugin
```

桌面端把 `--profile web` 换成 `--profile desktop`。**装完必须重启 Harness** ——
HMR 只热更 `cordis.patch.yml` 的配置，不会重新 import dist；浏览器面还要刷新页面
才拉得到新的 `client.cjs`。不重启的表现是"改了的代码没生效"。

从源码构建（开发者）见「快速开始 · 装插件」。

## 官方小程序

<p align="center">
  <img src="docs/images/miniprogram-qr.jpg" alt="官方小程序码" width="240">
</p>

微信扫上面这张码即可打开官方客户端（小程序已上架，打开即用、无需安装、不注册账号）。
配对只需扫一次主机状态栏那颗 pill 给出的二维码，之后每次连都是自动的。
自建中继的用户注意：配对二维码里的地址来自**主机侧配置**（`serverUrl`），
小程序只管扫，不需要手填任何地址。

## 系统构成

| 角色                 | 仓                                                              | 说明                                                           |
| -------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| **宿主插件（本仓）** | [`dsh-remote/plugin`](https://github.com/dsh-remote/plugin)     | 跑在 DSH 进程里：配对、中继、会话与命令、审批转发、状态栏 pill |
| 官方小程序           | [`dsh-remote/client`](https://github.com/dsh-remote/client)     | 微信小程序：扫码配对 / 会话列表 / 对话 / 审批 / 提问           |
| 中继                 | [`dsh-remote/relay`](https://github.com/dsh-remote/relay)       | 零知识 WebSocket 中继，单文件产物，可自托管                    |
| 协议层               | [`dsh-remote/protocol`](https://github.com/dsh-remote/protocol) | 帧与载荷 schema、E2E crypto、版本闸。纯函数、零 I/O            |

## 快速开始

### 前置

- 一台跑着 **DeepSeek Harness** 的机器（本插件装进它的 profile）。
- 一台**中继**（官方实例已提供；自托管见
  [`dsh-remote/relay` 的 SELF-HOSTING](https://github.com/dsh-remote/relay/blob/main/docs/SELF-HOSTING.md)）。
- 一个**主机 token**：中继与插件必须**逐字一致**（`openssl rand -hex 32` 生成）。
  把它放进中继的 `DRC_HOST_TOKEN`，插件侧只给**变量名**。

### 装插件

**用户路径（从 npm 装，推荐）**：

```sh
dsh plugin --profile web add @dsh-remote/plugin
```

`dsh plugin` 转发的就是 pnpm。桌面端换成 `--profile desktop`。装完必须重启 Harness。

**开发者路径（从本仓源码装）**：

```sh
pnpm install
pnpm build          # 产出两半：dist/bundle/index.js（宿主侧）+ client.cjs（浏览器面）
node scripts/install-to-profile.mjs
```

装进 `~/.dsh/profiles/desktop`；其他 profile 用 `DSH_PROFILE=…` 指定。
脚本只拷产物、不跑 `pnpm add`——profile 里不需要 node_modules。

> ⚠️ 两条路**不要混用**：`install-to-profile.mjs` 装出来的是软链时它会拒绝运行，
> 而 `dsh plugin add` 装的是 npm 包。同一个 profile 里先后用过两条路，表现是
> "文件都在、插件不加载"——三个名字（包名 / `bundles` 条目 / `insert.name`）必须一致。

### 用

小程序里：会话列表点开会话 → 输入框下发指令 → 流式输出实时回显 → 主机要审批 / 提问时手机上直接答。
任务跑完前主机保持唤醒（防休眠由插件发命令，可配空闲多久释放）。

## 排错

**第一入口永远是状态快照**：

```sh
cat ~/.dsh/dsh-remote-control/status.json
```

四个关键字段：

| 字段           | 看什么                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `relay`        | `online` / `connecting` / `offline`                                                                 |
| `relayProblem` | 连不上时的具体原因（token 不一致、地址错、中继没起…）                                               |
| `carrier`      | `services`=真内核 / `mock`=内存替身 / `none`=配置或载体有问题                                       |
| `pill`         | 配对入口的软探测：`registered` / `webServer=none` / `disabled`（`registered` 表示同域路由都挂上了） |

**`pill` 不是 `registered` ⇒ 这台主机配不了对**（配对入口只有它）。看 `problems` 里有没有
`warn:pill`，原因在那条 pill 探针里。

pill 背后的同域路由（**改状态的那几条要带自定义头 `x-drc-pair`**——那是跨站判据，不是装饰）。
配对码只有一种：中继签发的小程序码（JPEG），取不到就 503，不回落成别的图。

```sh
# 状态（只读；Host 必须环回）
curl -s http://127.0.0.1:<pillPort>/plugins/dsh-remote-control/status

# 触发发码（幂等；跨站会先触发 CORS 预检而被拦下）
curl -X POST -H 'x-drc-pair: 1' \
  http://127.0.0.1:<pillPort>/plugins/dsh-remote-control/pairing/new
```

## 设计上的三条硬线

1. **零知识**：插件配置里只有 `hostTokenEnv`（变量名），没有 token 明文；
   中继经手的载荷是密封记录，密钥只经这一条加密通道过一次网络（码里只有 6 位配对码）。
2. **凭据落盘一律 0600**：`status.json`、配对密钥簿（含**每个会话的 PSK**）、
   宿主身份文件、附件目录都走同一个落盘端口；
   win32 上 `chmod` 只切只读位时会**显式告警**，而不是假装生效。
3. **审批必须真的过 waterfall**：只有参与宿主 `approval/request` 才能到达手机；
   没有手机在线时交还桌面 UI。`approval/asked|decided` 是审计事件，**不能**当应答通道用。

## 开发

```sh
pnpm install
pnpm typecheck      # 两个编译面：宿主侧（NodeNext）与浏览器半（DOM lib）
pnpm format:check   # ⚠️ 排在 test 之前，release workflow 也是这个顺序
pnpm test           # 全量判据
```

改完跑一遍 `node scripts/install-to-profile.mjs` + **重启 Harness** 再验。

## 许可

MIT
