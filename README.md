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

配一次中继与主机 token 见下面的[教程](#教程)。从源码构建（开发者）见[第 2 步](#2-装插件)。

---

这是四仓里的**主推库**：装上它 + 一台中继 + 官方小程序，就能在手机上看着 DSH 干活并随时插话。

| 角色                 | 仓                                                              | 说明                                                           |
| -------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| **宿主插件（本仓）** | [`dsh-remote/plugin`](https://github.com/dsh-remote/plugin)     | 跑在 DSH 进程里：配对、中继、会话与命令、审批转发、状态栏 pill |
| 官方小程序           | [`dsh-remote/client`](https://github.com/dsh-remote/client)     | 微信小程序：扫码配对 / 会话列表 / 对话 / 审批 / 提问           |
| 中继                 | [`dsh-remote/relay`](https://github.com/dsh-remote/relay)       | 零知识 WebSocket 中继，单文件产物，可自托管                    |
| 协议层               | [`dsh-remote/protocol`](https://github.com/dsh-remote/protocol) | 帧与载荷 schema、E2E crypto、配对 URI。纯函数、零 I/O          |

---

## 官方小程序：黑鲸远控

<p align="center">
  <img src="docs/images/miniprogram-qr.jpg" alt="黑鲸远控小程序码" width="240">
</p>

微信扫上面这张码（或直接搜小程序名 **黑鲸远控**）即可打开官方客户端 ——
**2026-10-13 起已过审并在微信正式上线，任何人都能用**（之前只在开发者/体验名单里）。

- **打开即用，无需安装**：不装 App、不注册账号。
- 配对只需扫一次主机状态栏那颗 pill 给出的二维码，**之后每次连都是自动的**。
- 自建中继的用户注意：配对二维码里的地址来自**主机侧配置**（`serverUrl`），
  小程序只管扫，**不需要手填任何地址**。

---

## 教程

### 1. 前置

- 一台跑着 **DeepSeek Harness** 的机器（本仓要装进它的 profile）。
- 一台**中继**（生产实例已提供；自托管见
  [`dsh-remote/relay` 的 SELF-HOSTING](https://github.com/dsh-remote/relay/blob/main/docs/SELF-HOSTING.md)）。
- 一个**主机 token**：中继与插件必须**逐字一致**（`openssl rand -hex 32` 生成）。
  把它放进中继的 `DRC_HOST_TOKEN`，插件侧只给**变量名**（见第 3 步）。

### 2. 装插件

**用户路径（从 npm 装，推荐）**：

```sh
dsh plugin --profile web add @dsh-remote/plugin
```

`dsh plugin` 转发的就是 pnpm —— 它把 `@dsh-remote/plugin` 写进 profile 的依赖并安装。
桌面端换成 `--profile desktop`。**装完必须重启 Harness**（理由见顶部「安装」一节）。

**开发者路径（从本仓源码装）**：

```sh
pnpm install
pnpm build          # 产出两半：dist/bundle/index.js（宿主侧）+ client.cjs（浏览器面）
node scripts/install-to-profile.mjs
```

装进 `~/.dsh/profiles/desktop`；其他 profile 用 `DSH_PROFILE=…` 指定。
脚本只拷产物、**不跑 `pnpm add`**——profile 里不需要 node_modules。

> ⚠️ 两条路**不要混用**：`install-to-profile.mjs` 装出来的是软链时它会拒绝运行，
> 而 `dsh plugin add` 装的是 npm 包。同一个 profile 里先后用过两条路，表现是
> "文件都在、插件不加载"——三个名字（包名 / `bundles` 条目 / `insert.name`）必须一致。

### 3. 配一次（2026-10-11 起：**通常什么都不用配**）

默认中继是官方 `wss://drc.provid.cc`，口令（host token）由插件启动时**自动向中继认领**
并落进 `~/.dsh/dsh-remote-control/host-token.json`（0600）。装完重启 Harness 就能用。

要改的只有"不想用官方中继"或"想用自己的口令"这两件事，**两条路都行**：

- **设置页**：宿主设置 →「远程控制」→ 最下面「进阶：自部署 / 自定义」那一栏，填中继地址 / 口令。
  它落在 `~/.dsh/dsh-remote-control/user-config.json`（0600），**重启 Harness 生效**。
- **profile 的 patch**（下面这段）—— 手写在这里的值压过设置页那一栏。

插件在 profile 里注册为一个 bundle。在 `~/.dsh/profiles/desktop/cordis.patch.yml`
（**顶层是一个数组**，没有 `plugins:` 这一层）里补上配置：

```yaml
- id: dsh-remote-control # 条目 id：稳定标识，路由前缀与数据目录都跟着它
  name: '@dsh-remote/plugin' # ⚠️ 这是**包名**，不是上面的 id —— 两者不是一回事
  config:
    enabled: true
    hostTokenEnv: DRC_HOST_TOKEN # 从环境变量读，别把 token 写进这个文件
    hostLabel: my-mac # 会显示在小程序顶部
    listingRefreshSec: 15
    keepAwake:
      enabled: true
      idleReleaseSec: 300
      keepDisplay: false
```

> `serverUrl` **刻意不写**：它有一个默认值（官方中继），而默认值只有**一处**事实源
> （`src/shell/config.ts` 的 `DEFAULT_CONFIG`）。自部署时把它写成 `wss://你的域名`
> 即可 —— 写在这里的值压过设置页那一栏。

⚠️ **认领那一步失败不会让插件起不来**：它照常起载具与配对入口，只在 `status.json` 里留一条
`warn:hostToken` 与 `diagnostics.hostToken.*`（来源 / 认领结果 / 失败原因）。
这时去设置页「进阶」那一栏自己填一枚中继的 `DRC_HOST_TOKEN` 即可。

⚠️ **三个容易抄错的地方**（2026-10-11 实测这段文档与真实配置四处不符，已订正）：

1. **`name` 不是 `dsh-remote-control`**。拆成四仓之后包名是 `@dsh-remote/plugin`；
   保持稳定的只有**路由前缀、数据目录、patch 条目 id**。
   ⚠️ 而 `README` 上方那句"三个名字（包名 / `bundles` 条目 / `insert.name`）必须一致"
   说的就是这件事 —— 抄错的话表现是"文件都在、插件不加载"。
2. **没有 `plugins:` 这一层** —— patch 文件顶层就是数组。
3. **没有 `approvalTimeoutSec`** —— 它连同 `questionTimeoutSec` 一起在 2026-10-11 删除
   （期限改成跟随弹窗自身生命周期，见 `docs/RELEASE.md`）。

重启 Harness 后，**状态栏会出现一颗 pill**：未配对时点开**直接就是二维码页**。
用「黑鲸远控」扫它 → 配对完成。配对码**一次性**，服务端权威寿命默认 120 秒。

> 配对入口**只有那颗 pill**。`/drc` 命令与右栏自动弹码已在 2026-10-03 整条删除——
> 照着旧文档去找它们会扑空。

### 4. 用

小程序里：会话列表点开会话 → 输入框下发指令 → 流式输出实时回显 → 主机要审批 / 提问时手机上直接答。
任务跑完前主机保持唤醒（防休眠由插件发命令，可配空闲多久释放）。

### 5. 排错

**第一入口永远是状态快照**：

```sh
cat ~/.dsh/dsh-remote-control/status.json
```

四个关键字段：

| 字段           | 看什么                                                                               |
| -------------- | ------------------------------------------------------------------------------------ |
| `relay`        | `online` / `connecting` / `offline`                                                  |
| `relayProblem` | 连不上时的具体原因（token 不一致、地址错、中继没起…）                                |
| `carrier`      | `services`=真内核 / `mock`=内存替身 / `none`=配置或载体有问题                        |
| `pill`         | 七条路由的软探测：`registered` / `webServer=none` / `disabled` / `miniprogramCode=ok | missing`（`registered` 只表示**六条配对路由**挂上了——配置那条不参与这个判断） |

**`pill` 不是 `registered` ⇒ 这台主机配不了对**（配对入口只有它）。此时看 `problems` 里有没有
`warn:pill`，原因在那条 pill 探针里。

pill 背后的七条同域路由（**改状态的那三条要带自定义头**——那是同源判据，不是装饰；
第六条是官方小程序那张**静态**码，只读、可缓存，与带 PSK 的 `/pairing.png` 是两件东西）：

```sh
# 设置页那张静态小程序码（只读；200 + image/jpeg，或图不在包里时 204）
curl -sI http://127.0.0.1:<pillPort>/plugins/dsh-remote-control/miniprogram.jpg
```

```sh
# 状态（只读；Host 必须环回）
curl -s http://127.0.0.1:<pillPort>/plugins/dsh-remote-control/status

# 触发发码（幂等；跨站会先触发 CORS 预检而被拦下）
curl -X POST -H 'x-drc-pair: 1' \
  http://127.0.0.1:<pillPort>/plugins/dsh-remote-control/pairing/new
```

---

## 设计上的三条硬线

1. **零知识**：插件配置里只有 `hostTokenEnv`（变量名），没有 token 明文；
   中继经手的载荷是密封记录，密钥只经二维码过一次网络。
2. **凭据落盘一律 0600**：`status.json`、配对密钥簿（`conversations-<hostId>.json`，
   含**每个会话的 PSK**）、宿主身份文件、附件目录都走同一个落盘端口；
   win32 上 `chmod` 只切只读位时会**显式告警**，而不是假装生效。
3. **审批必须真的过 waterfall**：只有参与宿主 `approval/request` 才能到达手机；
   没有手机在线时交还桌面 UI。`approval/asked|decided` 是审计事件，**不能**当应答通道用。

## 开发

```sh
pnpm install
pnpm typecheck      # 两个编译面：宿主侧（NodeNext）与浏览器半（DOM lib）
pnpm format:check   # ⚠️ 排在 test 之前，release workflow 也是这个顺序
pnpm test           # 676 条判据
```

改完跑一遍 `node scripts/install-to-profile.mjs` + **重启 Harness** 再验。

## 许可

MIT
