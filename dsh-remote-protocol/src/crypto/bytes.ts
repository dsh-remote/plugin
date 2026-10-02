/**
 * bytes — UTF-8 与 base64。
 *
 * 为什么这里只有 Buffer / TextEncoder，没有 `tweetnacl-util`：
 * 那个包做的两件事 Node 内置就有，而且行为与小程序侧 vendored `js-base64` **逐字节一致**
 * ——标准 base64 表、带 `=` padding、非 url-safe（冻结项 B2，取证 docs/DESIGN.md §2.1）。
 * 少一个运行时依赖，也少掉「CJS 包在 ESM 里必须默认导入后解构」这类反复踩过的坑
 * （取证 HANDOFF.md §4.3）。
 *
 * 一处**有意的不对称**，写下来免得日后被当成 bug：
 * `Buffer.from(s, 'base64')` 对非法字符宽容（丢弃并继续），而小程序侧
 * `Base64.toUint8Array` 会抛异常。这边选宽容是安全的——解出的字节还要过 secretbox 的
 * Poly1305 MAC，任何被改坏的输入最终只会得到 `null`（B3），不会有别的表现。
 */
import { Buffer } from 'node:buffer'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

/** string → UTF-8 字节。与小程序 `Base64.utob` 的结果对合法输入完全一致。 */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

/** UTF-8 字节 → string。非忠实序列按替换字符处理（与 mp 的 `btou` 同样不抛）。 */
export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/** 字节 → 标准 base64（带 padding）。 */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/** 标准 base64 → 字节。非法输入不抛（见文件头的「有意的不对称」）。 */
export function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'))
}

/** 按顺序拼接若干字节段。 */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
