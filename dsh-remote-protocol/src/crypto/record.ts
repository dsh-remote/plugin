/**
 * record — 端到端密封记录（载荷层）。
 *
 * 冻结项 B1/B2/B3（docs/DESIGN.md §2.1）：
 *
 * ```
 * ciphertext = base64( nonce(24B) ‖ nacl.secretbox( utf8(JSON.stringify(payload)), nonce, key ) )
 * ```
 *
 * 外层对象**只有一个字段**，名字就叫 `ciphertext`。小程序侧那份实现读的也是它，
 * 改名或拆成 `{n, c}` 两段字段的结果是「配对成功但每一帧都解不开」。
 *
 * 中继永远只把这个字符串当不透明数据搬运——它不 import 本模块（结构性零知识，
 * 见 docs/DESIGN.md §5.2）。
 */
import nacl from 'tweetnacl'
import { concat, fromBase64, fromUtf8, toBase64, utf8 } from './bytes.js'
import { KEY_BYTES, NONCE_BYTES, randomNonce } from './keys.js'

/** 密封记录。字段名冻结。 */
export interface SealedRecord {
  ciphertext: string
}

/** secretbox 的 Poly1305 MAC 长度；用于「太短的记录直接拒」的下界。 */
const MAC_BYTES = 16
const MIN_RECORD_BYTES = NONCE_BYTES + MAC_BYTES

/**
 * 密封一个可 JSON 序列化的载荷。
 *
 * nonce 可省略（Node 侧有 CSPRNG，默认随机）。小程序侧必须显式传计数器 nonce，
 * 那是它环境的限制，不是这里的——两边产出都是同一种记录。
 */
export function seal(key: Uint8Array, payload: unknown, nonce: Uint8Array = randomNonce()): SealedRecord {
  if (key.length !== KEY_BYTES) throw new Error(`会话密钥必须是 ${KEY_BYTES} 字节`)
  if (nonce.length !== NONCE_BYTES) throw new Error(`nonce 必须是 ${NONCE_BYTES} 字节`)
  const text = JSON.stringify(payload)
  if (text === undefined) {
    // `JSON.stringify(undefined)` 得到的是 undefined，而 TextEncoder 会把它编成
    // 字面量 "undefined"——发出去解得开、但内容是垃圾。这种"看起来成功了"的帧
    // 比直接抛错难查得多，所以在出口就拦掉。
    throw new Error('载荷无法 JSON 序列化（undefined / 函数 / Symbol）')
  }
  const box = nacl.secretbox(utf8(text), nonce, key)
  return { ciphertext: toBase64(concat([nonce, box])) }
}

/**
 * 打开一条记录。**任何失败都返回 null，绝不抛异常**（B3）。
 *
 * 为什么不抛：调用方拿到 null 之后的处置是「丢弃这一帧，或按计数判定配对已失效」，
 * 而抛异常会让一次损坏的帧打断整条消息处理链（小程序侧就是这么处理的，
 * 并且它给两次机会才丢配对——取证 legacy-spec/mp-client-contract.md §3.2）。
 */
export function open<T = unknown>(key: Uint8Array, record: unknown): T | null {
  try {
    const ciphertext = (record as SealedRecord | null)?.ciphertext
    if (typeof ciphertext !== 'string') return null
    const merged = fromBase64(ciphertext)
    if (merged.length < MIN_RECORD_BYTES) return null
    const box = nacl.secretbox.open(merged.subarray(NONCE_BYTES), merged.subarray(0, NONCE_BYTES), key)
    if (!box) return null
    return JSON.parse(fromUtf8(box)) as T
  } catch {
    return null
  }
}
