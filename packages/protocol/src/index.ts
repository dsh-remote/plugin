/**
 * @dsh-rc/protocol — DSH Remote Control 的线协议层。
 *
 * 三条约束，决定了这个包长什么样：
 *
 * 1. **纯函数**。没有 I/O、没有定时器、没有 `node:child_process`，
 *    也没有任何 cordis / DSH 符号——防休眠在这里只是"该执行哪条命令"，
 *    执行与生命周期在插件侧的 `SleepPort` 实现里。这样 docs/DESIGN.md §2 的
 *    每条冻结契约都能脱离环境被测。
 * 2. **字节级契约不可动**。`mp/` 里有一份同格式的第二份实现且**一行不改**，
 *    两侧由 `e2e/protocol.test.mjs` 的 golden vector 与现跑对拍锁死。
 * 3. **中继只允许 import 类型**。运行时它一个字节都不该碰载荷
 *    （结构性零知识，docs/DESIGN.md §5.2）。
 *
 * 依赖只有两个，都是实测选定的：
 * - `tweetnacl`：secretbox。`node:crypto` 里**没有** XSalsa20-Poly1305
 *   （实测 `crypto.getCiphers()` 过滤 salsa 为空），只能走纯 JS。
 * - `zod`：帧与载荷校验。闭包 1 个包、0 运行时依赖、2.2M ops/s。
 * base64 / UTF-8 用 Node 内置 `Buffer` 与 `TextEncoder`，与小程序侧 vendored
 * `js-base64` 逐字节一致（实测 133 种长度 × 5 种实现零差异），因此**不**引
 * `tweetnacl-util`；也**禁止**用 `base64-js` / `@stablelib/base64` 解入站数据——
 * 它们对无填充与非法字符直接抛错，比小程序严格，会造出"手机能发、主机报错"的假故障。
 * （取证 docs/legacy-spec/open-source-options.md §A.1、§A.2、§C）
 */
export * from './bytes.js'
export * from './keys.js'
export * from './record.js'
export * from './pairing.js'
export * from './frames.js'
export * from './payloads.js'
export * from './outbound.js'
export * from './sleep.js'
export * from './ids.js'

/** 中继默认监听端口（`DRC_PORT` 的缺省值）。 */
export const DEFAULT_RELAY_PORT = 8787
