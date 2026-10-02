/**
 * keys — 密钥派生与 nonce 构造。
 *
 * 这一整个文件都是**冻结契约**（docs/DESIGN.md §2.1 的 B4-B6）：
 * 小程序里有一份独立实现（`mp/core/codec.js`），两侧必须由
 * `e2e/protocol.test.mjs` 的逐字节对拍锁死。这里任何一处改动——
 * 少补一个分隔符、把 `0x1f` 换成 `0x00`、截后 32 字节而不是前 32、
 * 把 `psk` 用 base64 文本而不是原始字节参与运算——都会静默产出**另一把密钥**，
 * 手机端的表现是「配对显示成功，但每一帧都解不开」。
 *
 * 为什么用 `node:crypto` 算 SHA-512 而不用 `nacl.hash`：
 * 两者就是同一个算法（SHA-512），前者是平台自带的原生实现，快且不占依赖位。
 * 这个"等价"不是推测——对拍测试拿小程序里那份 `nacl.hash` 的输出逐字节比过
 * （取证 docs/DESIGN.md §3 第 1 条）。secretbox 则必须留在 tweetnacl：
 * XSalsa20-Poly1305 不在 OpenSSL 的算法表里。
 */
import { createHash, randomBytes } from 'node:crypto'

/** KDF 命名空间。**确切拼写**已被小程序侧固定。 */
export const KDF_NAMESPACE = 'dsh-rc/v1'
/** 客户端计数器 nonce 前缀的命名空间。 */
export const NONCE_NAMESPACE = 'dsh-rc/v1/nonce'

/** RFC 7469 之外的老约定：本 KDF 用 ASCII 单元分隔符串接各部分。 */
const UNIT_SEPARATOR = 0x1f

export const KEY_BYTES = 32
export const NONCE_BYTES = 24
export const PSK_BYTES = 16
/** 计数器 nonce 的固定前缀长度；其余 8 字节是大端计数器。 */
export const NONCE_PREFIX_BYTES = NONCE_BYTES - 8

/** 会话密钥的方向。两个方向必须得到**不同**的密钥。 */
export type Direction = 'c2h' | 'h2c'

/** KDF 的一部分：字符串按 UTF-8，字节段原样。 */
export type KdfPart = string | Uint8Array

import { concat, fromBase64, utf8 } from './bytes.js'

/**
 * `SHA-512(p0 ‖ 0x1f ‖ p1 ‖ 0x1f ‖ … ‖ pn ‖ 0x1f)` 取**前 32 字节**。
 *
 * 注意「含最后一个部分之后也要补分隔符」——这是最容易写错的一处，
 * 也是小程序与 Node 两侧曾经真正分叉过的地方（取证 legacy-spec/relay-and-wireformat.md §3.2）。
 */
export function kdfHash(parts: readonly KdfPart[]): Uint8Array {
  const encoded = parts.map((p) => (typeof p === 'string' ? utf8(p) : p))
  const total = encoded.reduce((n, b) => n + b.length + 1, 0)
  const joined = new Uint8Array(total)
  let at = 0
  for (const bytes of encoded) {
    joined.set(bytes, at)
    at += bytes.length
    joined[at++] = UNIT_SEPARATOR
  }
  return new Uint8Array(createHash('sha512').update(joined).digest().subarray(0, KEY_BYTES))
}

/**
 * 从配对 PSK 派生某个会话、某个方向的会话密钥。
 *
 * parts 顺序固定为 `[命名空间, 方向, 会话 id, PSK 原始字节]`——
 * PSK 传的是**解码后的字节**，不是 base64 文本（B5）。
 */
export function derivePskKey(pskBase64: string, direction: Direction, conversationId: string): Uint8Array {
  return kdfHash([KDF_NAMESPACE, direction, conversationId, fromBase64(pskBase64)])
}

/**
 * 计数器 nonce 的 16 字节前缀。
 *
 * 唯一性论证（也是小程序敢用无 CSPRNG 的计数器方案的理由）：会话密钥已经绑定了
 * `(PSK, 会话, 方向)`，前缀又绑定了 `installId`；存储被清空时 `installId` 与配对一起消失，
 * 所以 `(key, nonce)` 组合不可能复用（取证 legacy-spec/mp-client-contract.md §5.2）。
 */
export function noncePrefix(pskBase64: string, conversationId: string, installId: string): Uint8Array {
  return kdfHash([NONCE_NAMESPACE, installId, conversationId, fromBase64(pskBase64)]).subarray(0, NONCE_PREFIX_BYTES)
}

/**
 * `prefix(16B) ‖ counter(8B 大端)` → 24 字节 nonce。
 *
 * 大端是硬要求（B6）：字节序一改，两侧计数器含义就不同，而**看起来仍然能用**。
 * 计数器允许出现空洞（小程序在真正发出之前就先加一，丢帧/发送失败都会跳过值），
 * 所以任何一侧都不许推断"下一个应该是几"。
 */
export function buildCounterNonce(prefix: Uint8Array, counter: number): Uint8Array {
  if (prefix.length !== NONCE_PREFIX_BYTES) {
    throw new Error(`nonce 前缀必须是 ${NONCE_PREFIX_BYTES} 字节，收到 ${prefix.length}`)
  }
  if (!Number.isInteger(counter) || counter < 0) {
    throw new Error(`nonce 计数器必须是非负整数，收到 ${String(counter)}`)
  }
  const high = Math.floor(counter / 0x1_0000_0000)
  const low = counter >>> 0
  const tail = new Uint8Array([
    (high >>> 24) & 0xff,
    (high >>> 16) & 0xff,
    (high >>> 8) & 0xff,
    high & 0xff,
    (low >>> 24) & 0xff,
    (low >>> 16) & 0xff,
    (low >>> 8) & 0xff,
    low & 0xff,
  ])
  return concat([prefix, tail])
}

/** 新的配对密钥：16 字节 CSPRNG，按标准 base64 交出（24 字符）。每次配对都换（B7）。 */
export function generatePsk(): string {
  return Buffer.from(randomBytes(PSK_BYTES)).toString('base64')
}

/** host→client 方向的随机 nonce（Node 侧有 CSPRNG，小程序侧没有，所以只有这里用随机）。 */
export function randomNonce(): Uint8Array {
  return new Uint8Array(randomBytes(NONCE_BYTES))
}
