/**
 * pairing — 配对二维码 URI 与 6 位配对码。
 *
 * 冻结项 B7/B8。URI 的语法：
 *
 * ```
 * dshr:/p?v=1&s=<ws(s) 地址>&n=<主机名>&psk=<base64 16B>[&t=<6 位码>]
 * ```
 *
 * 两条必须记住的事实：
 *
 * 1. **生成侧必须用 `URLSearchParams`**，不许自己拼字符串。小程序的解析器对
 *    base64 里未编码的 `+` 有一条"重试"兼容路径（先按 `+`→空格解一次，
 *    解出的 psk 含空格就用不替换 `+` 的方式再解一次），Node 侧只有
 *    `URLSearchParams` 一条路。两侧不对称的合流点就是生成侧永远输出 `%2B`。
 *    （取证 legacy-spec/relay-and-wireformat.md §3.4、mp-client-contract.md §4）
 * 2. `dshr:/p` 后面刻意没有 `//`：它不是 http URL，任何按 WHATWG URL 解析的实现
 *    都会把 query 丢掉。
 */
import { randomBytes } from 'node:crypto'

/** 配对 URI 解出来的内容。字段名与小程序侧返回的对象一致。 */
export interface PairingInfo {
  /** 版本；小程序恒返回 1，不做校验。 */
  v: number
  /** 中继地址，如 `wss://drc.example.com`。 */
  server: string
  /** 主机展示名，缺省 `'dsh'`。 */
  hostLabel: string
  /** base64 的 16 字节 PSK。 */
  psk: string
  /** 内嵌的 6 位配对码；没有或不合法时为 **空字符串**（不是 undefined）。 */
  token: string
}

const URI_PREFIX = 'dshr:'
const TOKEN_RE = /^\d{6}$/
const DEFAULT_HOST_LABEL = 'dsh'

/** 6 位配对码（手输友好）。用 CSPRNG，不用 `Math.random()`。 */
export function randomPairingToken(): string {
  // 0..999999，均匀取到 6 位： rejection sampling 避免 `randomBytes % 1e6` 的模偏差。
  let n = 0
  do {
    n = randomBytes(3).readUIntBE(0, 3)
  } while (n >= 16_777_216 - (16_777_216 % 1_000_000))
  return formatPairingToken(n % 1_000_000)
}

/** 把整数摆成 6 位数字码。 */
export function formatPairingToken(n: number): string {
  return String(Math.abs(Math.trunc(n)) % 1_000_000).padStart(6, '0')
}

/**
 * 配对码是手输的：剔除空格与连字符。
 * 与小程序 `normalizePairingToken` 同语义（只剔这两类字符，别的不动）。
 */
export function normalizePairingToken(raw: string): string {
  return String(raw ?? '').replace(/[\s-]/g, '')
}

/** 构造配对 URI。`token` 省略时不写 `t` 参数（扫码后仍需手输码）。 */
export function buildPairingUri(info: { server: string; psk: string; hostLabel?: string; token?: string }): string {
  const params = new URLSearchParams()
  params.set('v', '1')
  params.set('s', info.server)
  params.set('n', info.hostLabel || DEFAULT_HOST_LABEL)
  params.set('psk', info.psk)
  const token = info.token ? normalizePairingToken(info.token) : ''
  if (TOKEN_RE.test(token)) params.set('t', token)
  return `${URI_PREFIX}/p?${params.toString()}`
}

/**
 * 解析配对 URI；**任何不合法输入返回 null**（小程序侧同样返回 null，
 * 页面据此弹「无法识别」）。
 */
export function parsePairingUri(text: string): PairingInfo | null {
  const raw = String(text ?? '')
  if (!raw.startsWith(URI_PREFIX)) return null
  const cut = raw.indexOf('?')
  if (cut < 0) return null
  const params = readQuery(raw.slice(cut + 1))
  const psk = params.get('psk') ?? ''
  const server = params.get('s') ?? ''
  if (!psk || !server) return null
  const token = params.get('t') ?? ''
  return {
    v: 1,
    server,
    hostLabel: params.get('n') || DEFAULT_HOST_LABEL,
    psk,
    token: TOKEN_RE.test(token) ? token : '',
  }
}

/**
 * 与小程序 `parsePairingQr` 等价的 query 读取。
 *
 * 为什么不用 `new URLSearchParams(qs)` 一步到位：小程序那份实现是手写的，
 * 语义里有三件事和 WHATWG 不完全一样——只按**第一个** `=` 切、重复键后者覆盖前者、
 * 非法 `%` 序列不抛错而是回退原串。这里逐条对齐，并额外保留它的
 * 「未编码 `+` 重试」路径（第一遍把 `+` 当空格，若 psk 里出现空格再解一遍）。
 */
function readQuery(qs: string): Map<string, string> {
  const first = parsePairs(qs, true)
  const psk = first.get('psk') ?? ''
  if (!psk.includes(' ')) return first
  const second = parsePairs(qs, false)
  const retryPsk = second.get('psk') ?? ''
  if (!retryPsk || retryPsk.includes(' ')) return first
  // 采纳第二遍的 psk；server 缺失或同样带空格时一并换成第二遍的值。
  const merged = new Map(first)
  merged.set('psk', retryPsk)
  const server = first.get('s') ?? ''
  if (!server || server.includes(' ')) merged.set('s', second.get('s') ?? server)
  return merged
}

function parsePairs(qs: string, plusAsSpace: boolean): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of qs.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = eq < 0 ? part : part.slice(0, eq)
    const value = eq < 0 ? '' : part.slice(eq + 1)
    out.set(decodeToken(key, plusAsSpace), decodeToken(value, plusAsSpace))
  }
  return out
}

function decodeToken(value: string, plusAsSpace: boolean): string {
  const text = plusAsSpace ? value.replace(/\+/g, ' ') : value
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
