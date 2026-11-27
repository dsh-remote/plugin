# DSH Remote Control · 0.6

在手机上远程操作 **DeepSeek Harness（DSH）**：查看会话与运行进度、下发指令、审批工具调用、回答问题，
并让主机在任务跑完前保持唤醒。**载荷级端到端加密**——中继从头到尾只见 `base64(nonce‖secretbox)`：
不是"我们不查"，而是密钥在依赖图上不可达（中继的构建产物里没有任何密码学实现，有判据锁住）。

三条承诺：**零知识 / 无账号 / 手机免安装**（小程序打开即用）。

要用 AI 助手升级 Harness 插件，把 [0.6 插件升级指南](README.for-ai.md) 发给它。指南会让它核对目标
profile 和包名，再按发布通道安装、重启、验收或回退。

## 结构（单包工程 · 四端 + H5 壳）

| 位置 | 是什么 |
|---|---|
| `packages/protocol` | 线协议层：帧校验与 E2E crypto（tweetnacl 纯 JS，浏览器/小程序/Node 三处可跑）。零 I/O |
| `packages/relay` | 零知识 WebSocket 中继：自包含 Node.js 程序（`dist/relay/main.cjs`），可自托管，产物里没有密码学 |
| `packages/plugin` | 宿主插件（npm `@dsh-remote/plugin` 与 `dsh-remote-control`，`next` 通道）：配对 / 中继 / 会话 / 底栏 pill |
| `packages/client` | 微信小程序：会话列表 / 对话 / 审批 / 提问（`dist/miniprogram` 用微信开发者工具导入） |
| `h5/` | H5 构建壳（weapp-vite）：把小程序产物编译为浏览器应用，源码零改动（当前未上线，资产保留） |
| `scripts/`、`tests/`、`docs/`、`deploy/` | 构建脚本 / 判据 / 需求与验证记录 / 中继容器与发布工作流 |

本仓是唯一事实源的公开镜像；GitHub org [`dsh-remote`](https://github.com/dsh-remote) 下
[`protocol`](https://github.com/dsh-remote/protocol) / [`relay`](https://github.com/dsh-remote/relay) /
[`plugin`](https://github.com/dsh-remote/plugin) / [`client`](https://github.com/dsh-remote/client) 四仓同源。
**npm 只发插件一个包**（两个安装名）；协议以 devDep 内联进插件产物；中继走 Docker 镜像与 Release 单文件产物。

## 快速开始

```sh
npm ci
npm test          # 判据（tests/*.test.cjs，含协议对拍、中继、宿主内核、包形状、UI 守卫）
npm run build     # 产物：dist/{protocol,relay,plugin,miniprogram}
```

需要 Node.js 20+。演示模式：`npm run demo`（本地中继 `ws://127.0.0.1:8788`，小程序构建带 `DRC_MP_LOCAL=1`）。

## 装机（宿主插件）

```sh
npm pack ./dist/plugin
dsh plugin --profile <web|desktop> add --save-exact <tarball 或 @dsh-remote/plugin@<版本>>
```

然后**完全退出并重启 Harness**（换掉的文件不会被热加载；网页端还要刷新页面）。
在「设置 → 远程控制」生成小程序码，手机微信扫码或小程序「扫码连接」，两端核对六位数字后在手机上确认。

三个名字必须一致，否则表现是"文件都在、插件不加载"：包名（`@dsh-remote/plugin` 或 `dsh-remote-control`，
同一 profile 只用其一）、`dsh.profile.bundles` 条目、自带 `cordis.patch.yml` 的 `insert.name`。

**装完就能用**：默认中继 `wss://drc.provid.cc/v06`，口令由主机启动时自动向中继认领
（`POST <中继>/api/claim-token`，带 `hostId`）并原子落盘。0.6 使用独立状态目录
`~/.dsh/dsh-remote-control-v06/`（status.json / 密钥簿 / host-token），与 0.5 互不干扰；首次体验需重新配对。

## 排错

```sh
cat ~/.dsh/dsh-remote-control-v06/status.json     # 第一入口：state / relay / relayProblem / serverUrl / version / pairing
curl -fsS https://drc.provid.cc/v06/healthz       # 中继：ok / version / hosts / conversations / stateRestored
```

配对类问题先看中继日志（`paired` 每次都成功 ⇒ 断点在配对之后的收尾；`already_used` ⇒ 重连拿烧掉的码再认领）。
宿主连不上中继时按优先级核对：插件配置 `serverUrl` → 设置页保存的地址 → 环境变量 `DRC_SERVER_URL` → 官方默认。

## 自托管

```sh
DRC_BIND=127.0.0.1 DRC_PORT=8788 DRC_STATE_FILE=/path/to/relay.json DRC_HOST_TOKEN=<主机管理令牌> node dist/relay/main.cjs
```

中继支持 `/healthz`、`/api/claim-token`、`/code` 和 WebSocket；反代上可挂路径前缀（如 `/v06`），
反代负责 TLS 与 Upgrade。同机反代可设 `DRC_TRUST_LOCAL_PROXY=1`（配合 `X-Real-IP` 覆写，认领限频按真实 IP）。

- `DRC_MP_APPID` / `DRC_MP_SECRET`：中继签小程序码；`DRC_MP_ENV` 选 `release` / `trial` / `develop`。
- `DRC_MP_APPROVAL_TEMPLATE_ID`：一次性订阅提醒，留空则产品入口隐藏。
- `DRC_MAX_HOST_TOKENS` 默认 5000；`DRC_HOST_TOKEN_TTL_MS` 默认 30 天（按闲置回收）。
- `DRC_CLAIM_MIN_INTERVAL_MS` 默认 4000。路由、令牌与状态摘要持久化，加密补帧缓冲留在进程内。

容器镜像：`docker build -f deploy/Dockerfile -t dsh-remote-relay:0.6.0 .`，运行时挂载 `/state`。

## 发布

打 tag `v0.6.x` 触发 Release 工作流：核对 tag 与 `package.json` 版本一致 → 跑插件判据 →
从 `dist/{alias,scoped}` 发布两个安装名到 npm **`next`** 通道（带 provenance）→ 建 prerelease。
默认通道（`latest`）继续供应 0.5 存量。小程序审核与正式发布在微信公众平台操作。

## 文档

| 文档 | 内容 |
|---|---|
| [`README.for-ai.md`](README.for-ai.md) | 0.6 插件升级指南（发给 AI 助手执行） |
| [`docs/requirements.md`](docs/requirements.md) | 需求和用例追踪 |
| [`docs/interface.md`](docs/interface.md) | 界面设计 |
| [`docs/verification.md`](docs/verification.md) | 验证记录 |

## 许可

MIT。
