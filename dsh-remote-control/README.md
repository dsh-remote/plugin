# dsh-remote-control

[![CI](https://github.com/providcc/dsh-remote-control/actions/workflows/ci.yml/badge.svg)](https://github.com/providcc/dsh-remote-control/actions/workflows/ci.yml)
[![npm: dsh-remote-control](https://img.shields.io/npm/v/dsh-remote-control.svg)](https://www.npmjs.com/package/dsh-remote-control)
[![npm: dsh-remote-control-presentation](https://img.shields.io/npm/v/dsh-remote-control-presentation.svg)](https://www.npmjs.com/package/dsh-remote-control-presentation)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**DSH Remote Control** 的宿主侧——跑在 DeepSeek Harness 里的 cordis 插件。它把本机的 DSH 与
零知识中继配对，让微信小程序可以**发指令、看流式输出、回答审批**，全程载荷级端到端加密。

本仓是 monorepo，产出两个 npm 包：

| 目录                                               | 包名                              | 作用                                                                               |
| -------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| [`packages/plugin`](./packages/plugin)             | `dsh-remote-control`              | 主插件：配对、中继连接、会话与命令、审批转发、防休眠                               |
| [`packages/presentation`](./packages/presentation) | `dsh-remote-control-presentation` | 把当前配对二维码落到磁盘，并让 DSH 右栏**自动弹码**（含一个浏览器面 `client.cjs`） |

其余两半在各自仓库：[`dsh-remote-server`](https://github.com/providcc/dsh-remote-server)（零知识中继）、
`dsh-remote-mp`（微信小程序客户端）。三者共用
[`dsh-remote-protocol`](https://github.com/providcc/dsh-remote-protocol)（线协议；npm 包名 `dsh-remote-wire`，本插件以 npm 依赖消费）。

```
┌──────────────────┐  wss + host token   ┌────────────────┐  wss + 配对码   ┌────────────────┐
│  DSH 桌面主机      │ ─────────────────▶ │  relay server  │ ◀────────────── │ 微信小程序客户端  │
│  (本仓：插件)      │   只见密文与 6 位码   │                │                 │                │
└──────────────────┘                     └────────────────┘                 └────────────────┘
```

## 加密模型

中继看到的每个载荷都是 `base64(nonce ‖ secretbox)`，它**没有密钥**。载荷密钥（PSK）在本机生成，
只经配对二维码交给手机，从不上网。密钥派生、密封记录与配对 URI 的字节级契约由
`dsh-remote-wire` 冻结，本仓只消费它。

插件侧的关键约束：**host token 只从环境变量读**（`hostTokenEnv`，默认 `DRC_HOST_TOKEN`）。
它不写进 patch 文件——配置文件比环境变量更容易被顺手提交或贴进工单。

## 安装到 DSH profile

### 前置条件

`dsh-remote-wire` 是 npm 依赖，本仓的 `pnpm install` 需要它已经发布。首次引导顺序：

1. 在 `dsh-remote-protocol` 仓打 `v*` 标签走它的 Release，把包发到 npm；
2. 回到本仓跑一次 `pnpm install`，把生成的 `pnpm-lock.yaml` 提交；
3. 把 `.github/workflows/ci.yml` 里的 `--no-frozen-lockfile` 改成 `--frozen-lockfile`。

（步骤 2、3 是一次性的。协议升版后重跑即可。）

插件不进 `node_modules`，而是打成**自包含单文件**装进 profile：

```sh
pnpm install          # 装依赖（含 dsh-remote-wire，需先发布该包）
sh scripts/install-to-profile.sh
# DSH_PROFILE=~/.dsh/profiles/tui sh scripts/install-to-profile.sh   # 指定其它 profile
```

脚本做三件事：用 esbuild 把两个包各打成一个文件 → 拷进 `$DSH_PROFILE/node_modules/<包名>/` →
把包名注册进 profile `package.json` 的 `dsh.profile.bundles`（幂等），并删除遗留的 `file:` 依赖
（那个会让 profile 里同时跑起**两个插件实例**）。

> **改代码后必须重启 Harness。** HMR 只热更 `cordis.patch.yml` 的配置，不会重新 import 产物；
> 浏览器面要**重新加载页面**才会重新拉 `client.cjs`。

配对：在 DSH 里执行 `/drc pair`，右栏应自动出现二维码；扫码即完成配对。

## 配置

插件读 `~/.dsh/profiles/<name>/cordis.patch.yml` 里的那一行，优先级为
**环境变量 > patch 里的 `config` > 内置默认值**。分发包自带的默认行见
[`packages/plugin/cordis.patch.yml`](./packages/plugin/cordis.patch.yml)。

| 键                         | 默认                  | 说明                                                                                   |
| -------------------------- | --------------------- | -------------------------------------------------------------------------------------- |
| `enabled`                  | `true`                | 关掉即整行不干活                                                                       |
| `serverUrl`                | `ws://127.0.0.1:8787` | 中继地址。生产必须 `wss://`（写非回环的 `ws://` 只 warn 不拦，但明文链路上配对码可见） |
| `hostTokenEnv`             | `DRC_HOST_TOKEN`      | **token 所在的环境变量名**。token 本身不进 patch                                       |
| `hostLabel`                | `dsh-host`            | 手机上显示的主机名                                                                     |
| `keepAwake.enabled`        | `true`                | 有会话时阻止系统休眠                                                                   |
| `keepAwake.idleReleaseSec` | `300`                 | 空闲多久后释放防休眠                                                                   |
| `unarchiveOnPrompt`        | `true`                | 收到指令时自动取消会话归档                                                             |
| `takeOverQuestions`        | `false`               | 提问接管（会**取代桌面 UI 的提问能力**，默认关）                                       |
| `approvalTimeoutSec`       | `180`                 | 审批等待上限                                                                           |
| `pairTtlMs`                | `120000`              | 向中继申请 PSK 的有效期；**服务端权威值会覆盖它**                                      |
| `qrImage`                  | `true`                | 配对码出 PNG（文本码在 DSH 命令卡的行高下扫不出来）                                    |
| `conversationIdleTtlSec`   | `86400`               | 空闲多久剪掉一条配对通道（不接受"永不剪枝"）                                           |

对应的环境变量覆盖见
[`packages/plugin/src/shell/config.ts`](./packages/plugin/src/shell/config.ts)（`DRC_SERVER_URL`、
`DRC_HOST_LABEL`、`DRC_QR_IMAGE`、`DRC_MOCK_BRIDGE` 等）。**键名刻意继承旧名**：它们写在用户的
profile 里，改名等于让线上配置静默失效。

排错入口是状态快照 `~/.dsh/dsh-remote-control/status.json`（0600）；关键字段 `carrier`
（`services` = 真内核 / `mock` = 内存替身 / `none`）、`relay`、`relayProblem`。

## 开发

```sh
pnpm install
pnpm typecheck        # 两个包 tsc --noEmit
pnpm test             # 每个包：先 build 再对 dist/tests 跑 node --test
pnpm build            # tsc + esbuild → packages/*/dist/bundle/
pnpm format:check     # prettier --check
```

测试就是普通的 `node --test` 文件，没有测试框架，运行期不做转译。动到二维码形状时务必盯住
`packages/plugin/tests/pairing-text.test.ts`（文本/半块码）与
`packages/presentation/tests/presenter.test.ts`（真渲染出 PNG magic bytes、落盘 0600）这两组。

## 安全

威胁模型与信任边界见 [`docs/SECURITY.md`](./docs/SECURITY.md)；报告漏洞的流程见仓库根的
[`SECURITY.md`](./SECURITY.md)。**请不要为安全报告开公开 issue。**

## 许可

[MIT](./LICENSE) © providcc
