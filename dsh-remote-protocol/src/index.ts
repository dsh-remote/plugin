/**
 * dsh-remote-wire — DSH Remote Control 的线协议层。
 *
 * 三条约束，决定了这个包长什么样：
 *
 * 1. **纯函数**。没有 I/O、没有定时器、没有 `node:child_process`，
 *    也没有任何宿主框架符号——防休眠在这里只是"该执行哪条命令"，
 *    执行与生命周期在调用方实现。于是每条冻结契约都能脱离环境被测。
 * 2. **字节级契约不可动**。客户端（微信小程序）里有一份同格式的第二实现，
 *    两侧由 golden vector 与现跑对拍锁死：改这里就必须同步改那边。
 * 3. **中继只允许 import 类型**。运行时它一个字节都不该碰载荷
 *    （结构性零知识）。
 *
 * 依赖只有两个，都是实测选定的：
 * - `tweetnacl`：secretbox。`node:crypto` 里**没有** XSalsa20-Poly1305
 *   （实测 `crypto.getCiphers()` 过滤 salsa 为空），只能走纯 JS。
 * - `zod`：帧与载荷校验。闭包 1 个包、0 运行时依赖。
 * base64 / UTF-8 用 Node 内置 `Buffer` 与 `TextEncoder`，与小程序侧 vendored
 * `js-base64` 逐字节一致（实测 133 种长度 × 5 种实现零差异），因此**不**引
 * `tweetnacl-util`；也**禁止**用 `base64-js` / `@stablelib/base64` 解入站数据——
 * 它们对无填充与非法字符直接抛错，比小程序严格，会造出"手机能发、主机报错"的假故障。
 *
 * 目录按关注点分组：`crypto/` 是密封记录与密钥派生，`wire/` 是帧与载荷，
 * `identity/` 是会话标识与配对，`platform/` 是与宿主环境相关的命令构造。
 */
export * from './crypto/bytes.js'
export * from './crypto/keys.js'
export * from './crypto/record.js'
export * from './identity/pairing.js'
export * from './wire/frames.js'
export * from './wire/payloads.js'
export * from './wire/outbound.js'
export * from './platform/sleep.js'
export * from './identity/ids.js'

/** 中继默认监听端口（`DRC_PORT` 的缺省值）。 */
export const DEFAULT_RELAY_PORT = 8787
