# dsh-remote-wire

> 仓库目录名是 `dsh-remote-protocol`，npm 包名是 `dsh-remote-wire`——`dsh-remote-protocol`
> 这个名字在 npm 上已被第三方占用。下文与本仓源码里的 `dsh-remote-wire` 均指这个 npm 包。

[![CI](https://github.com/providcc/dsh-remote-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/providcc/dsh-remote-protocol/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-remote-wire.svg)](https://www.npmjs.com/package/dsh-remote-wire)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**DSH Remote Control** 三端共用的线协议——DSH 宿主插件、零知识中继、微信小程序客户端。

这是一个**纯函数**库：没有 I/O、没有定时器、没有 `node:child_process`，也不认识任何宿主框架符号。
因此每条冻结契约都能脱离环境单独被测，中继也能**只 import 类型**——它一个明文字节都不会碰。

## 安装

```sh
pnpm add dsh-remote-wire
# 或
npm install dsh-remote-wire
```

要求 Node.js **≥ 20**。

## 内容

| 模块                                 | 导入路径                       | 职责                                                                |
| ------------------------------------ | ------------------------------ | ------------------------------------------------------------------- |
| bytes                                | `dsh-remote-wire`（内部）  | base64 / UTF-8 / 拼接，与小程序 vendored 的 `js-base64` 逐字节一致  |
| [keys](./src/crypto/keys.ts)         | `dsh-remote-wire/keys`     | PSK 生成、HKDF 风格的两把方向密钥派生、计数器 nonce 构造            |
| [record](./src/crypto/record.ts)     | `dsh-remote-wire/record`   | `seal()` / `open()`——基于 `tweetnacl` 的 XSalsa20-Poly1305 密封记录 |
| [frames](./src/wire/frames.ts)       | `dsh-remote-wire/frames`   | 每一条中继控制帧的 zod schema + 解析器                              |
| [payloads](./src/wire/payloads.ts)   | `dsh-remote-wire/payloads` | `cmd.*` / `ev.*` 载荷目录的 zod schema                              |
| [outbound](./src/wire/outbound.ts)   | `dsh-remote-wire/outbound` | 中继 → 端点、主机 → 客户端消息的类型化构造器                        |
| [pairing](./src/identity/pairing.ts) | `dsh-remote-wire/pairing`  | `dshr:/p?...` 配对 URI 编解码、6 位码工具                           |
| [ids](./src/identity/ids.ts)         | `dsh-remote-wire/ids`      | 会话 / 主机 / 命令 id 生成                                          |
| [sleep](./src/platform/sleep.ts)     | `dsh-remote-wire/sleep`    | 防休眠命令构造器（`caffeinate` / `systemd-inhibit`）                |

根入口（`dsh-remote-wire`）会把上面全部再导出一次。

## 设计约束

1. **纯函数。** 这里的防休眠只是"该执行哪条命令"；执行与生命周期在调用方。这样每条契约都能脱离设备被测。
2. **字节级契约不可动。** 小程序里有一份同格式的**独立**实现。两侧由 golden vector 与现跑对拍锁死——
   改一边就必须改另一边。
3. **中继只允许 import 类型。** 它绝不能碰载荷字节（结构性零知识）。中继的构建产物里**没有**密码学代码，
   有测试守着。

### 为什么是这几个依赖

- [`tweetnacl`](https://www.npmjs.com/package/tweetnacl) 提供 `secretbox`：`node:crypto` 里**没有**
  XSalsa20-Poly1305（实测 `crypto.getCiphers()` 过滤 `salsa` 为空），纯 JS 实现是唯一选择。
- [`zod`](https://www.npmjs.com/package/zod) 做帧与载荷校验（闭包 1 个包、0 运行时依赖）。

base64 / UTF-8 用 Node 内置的 `Buffer` 与 `TextEncoder`——在大量输入长度的模糊测试下与小程序 vendored
的 `js-base64` 逐字节一致。因此我们**刻意不**引 `tweetnacl-util`，也**禁止**用 `base64-js` /
`@stablelib/base64` 解入站数据：它们对无填充与非法字符直接抛错，比小程序严格，会造出"手机能发、
主机报错"的假故障。

## 用法

用派生出的密钥密封 / 打开一条记录：

```ts
import { generatePsk, derivePskKey } from 'dsh-remote-wire/keys'
import { seal, open } from 'dsh-remote-wire/record'

const psk = generatePsk()
const key = derivePskKey(psk, 'c2h', 'c_abc123')

const record = seal(key, { t: 'ping' })
const back = open(key, record) // { t: 'ping' }
```

构造与解析配对 URI：

```ts
import { buildPairingUri, parsePairingUri } from 'dsh-remote-wire/pairing'

const uri = buildPairingUri({ server: 'wss://relay.example', psk, token: '042317' })
const info = parsePairingUri(uri) // 任何畸形输入返回 null
```

构造平台防休眠命令：

```ts
import { detectBackend, buildSleepCommand } from 'dsh-remote-wire/sleep'

const backend = detectBackend(process.platform) // 'caffeinate' | 'systemd-inhibit' | 'unsupported'
if (backend !== 'unsupported') {
  console.log(buildSleepCommand(backend, process.pid)) // { cmd, args }
}
```

## 开发

```sh
pnpm install
pnpm typecheck     # tsc --noEmit
pnpm test          # 先 build，再对 dist/tests 跑 node --test
pnpm build         # 产出 dist/
```

测试就是普通的 `node --test` 文件——没有测试框架，运行期也不做转译。

## 安全

这个库实现了密码学，但自己不持有任何密钥。威胁模型、密钥处理与加固清单见 [SECURITY.md](./SECURITY.md)。

报告漏洞请按 [SECURITY.md](./SECURITY.md) 走——**请不要开公开 issue**。

## 许可

[MIT](./LICENSE) © providcc
