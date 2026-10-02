/**
 * gen-vectors — 用**保留的小程序代码**生成 golden vector。
 *
 * 为什么拿 mp 当 oracle：小程序一行不改，它那份 `mp/core/codec.js` 就是这套线格式的
 * 权威实现。让被测方自己给期望值是自欺欺人；让不可改的那一方给，才叫对拍。
 *
 * 为什么固化成 JSON（现跑对拍在 protocol.test.mjs 里也有）：固化后字节回归在任何环境
 * 都能跑，而且**向量本身可以 diff**——将来有人改坏了 KDF，CI 报的是"某条 golden
 * 向量变了"，而不是含糊的"两个实现不一样"。
 *
 * 用法：node e2e/tools/gen-vectors.mjs
 * 幂等：所有随机量走固定种子 PRNG，同一份 mp 代码跑两次产出逐字节相同的文件。
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..', '..')
const MP_CODEC = path.join(ROOT, 'mp', 'core', 'codec.js')
const OUT = path.join(ROOT, 'e2e', 'fixtures', 'wire-vectors.json')

const require_ = createRequire(import.meta.url)
const mp = require_(MP_CODEC)

/** 固定种子的 xorshift，保证向量可复现。 */
let seed = 0x2545f4914f6cdd1d
function next() {
  seed ^= seed << 13
  seed >>>= 0
  seed ^= seed >>> 7
  seed ^= seed << 17
  seed >>>= 0
  return seed / 0x100000000
}
const someBytes = (n) => {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.floor(next() * 256)
  return out
}
const hex = (b) => Buffer.from(b).toString('hex')
const b64 = (b) => Buffer.from(b).toString('base64')

const TEXTS = [
  '',
  'a',
  'hello world',
  '生成周报，中文与 emoji 都要原样回来',
  '\u{1F600}\u{1F1E6}\u{1F1E7} mixed 😀😀 and 中文',
  'tab\tand\nnewline\r\n\u00a0nbsp',
  'ß€你好🙂',
  'x'.repeat(500),
]

const vectors = {}

// ── 1. UTF-8 与 base64 的字节层 ──────────────────────────────────────
vectors.text = TEXTS.map((input) => {
  const bytes = mp.stringToBytes(input)
  return {
    input,
    utf8Hex: hex(bytes),
    b64OfUtf8: mp.bytesToBase64(bytes),
    backAgain: mp.bytesToString(bytes),
  }
})

const B64_INPUTS = []
for (let n = 0; n <= 33; n++) B64_INPUTS.push(b64(someBytes(n)))
B64_INPUTS.push('', 'AAAA', 'AA==', 'AAA=', 'A/+/', 'aaAA11++//==', '  AAAA  ', 'AAAA\nBBBB')
vectors.base64 = B64_INPUTS.map((input) => {
  let decoded = null
  let errorKind = null
  try {
    decoded = hex(mp.base64ToBytes(input))
  } catch (e) {
    errorKind = e && e.name ? String(e.name) : 'Error'
  }
  return { input, decodedHex: decoded, errorKind }
})

// ── 2. KDF ──────────────────────────────────────────────────────────
const PSKS = []
for (let i = 0; i < 24; i++) PSKS.push(b64(someBytes(16)))

vectors.kdfHash = [
  { parts: ['dsh-rc/v1'], keyHex: hex(mp.kdfHash(['dsh-rc/v1'])) },
  { parts: ['a', 'b'], keyHex: hex(mp.kdfHash(['a', 'b'])) },
  { parts: ['ab'], keyHex: hex(mp.kdfHash(['ab'])) },
  { parts: ['', 'x'], keyHex: hex(mp.kdfHash(['', 'x'])) },
  { parts: ['dsh-rc/v1', 'c2h', 'c_0123456789ab'], keyHex: hex(mp.kdfHash(['dsh-rc/v1', 'c2h', 'c_0123456789ab'])) },
].concat(
  PSKS.slice(0, 8).map((psk) => ({
    partsBytesHex: [psk],
    keyHex: hex(mp.kdfHash(['dsh-rc/v1/nonce', 'install-1', 'c_abcdef123456', mp.base64ToBytes(psk)])),
  })),
)

vectors.derivePskKey = []
for (const psk of PSKS) {
  for (const dir of ['c2h', 'h2c']) {
    for (const convId of ['c_0123456789ab', 'c_deadbeefdead', '']) {
      vectors.derivePskKey.push({ psk, dir, convId, keyHex: hex(mp.derivePskKey(psk, dir, convId)) })
    }
  }
}

// ── 3. 计数器 nonce ─────────────────────────────────────────────────
vectors.noncePrefix = []
for (const psk of PSKS.slice(0, 12)) {
  const installId = 'install-' + hex(someBytes(3))
  const convId = 'c_' + hex(someBytes(6))
  vectors.noncePrefix.push({ psk, installId, convId, prefixHex: hex(mp.noncePrefix(psk, convId, installId)) })
}

const COUNTERS = [0, 1, 2, 255, 256, 65535, 0x7fffffff, 0x80000000, 0xffffffff, 0x100000000, 0x123456789, 4503599627370495]
vectors.buildNonce = COUNTERS.map((counter) => {
  const prefix = someBytes(16)
  return { prefixHex: hex(prefix), counter, nonceHex: hex(mp.buildNonce(prefix, counter)) }
})

// ── 4. 密封记录（mp 是生产方，新实现必须解出同样的明文，也必须能产出同样的密文） ──
const PAYLOADS = [
  { t: 'cmd.list_sessions', cmdId: 'c1' },
  { t: 'cmd.send_prompt', cmdId: 'c2', sessionId: 'ses_1', text: '只回复 ok 两个字，不要调用任何工具' },
  { t: 'ev.message_delta', messageId: 'm1', delta: '你好 😀', done: true },
  { t: 'ev.message_delta', messageId: 'm2', delta: '', done: true },
  { t: 'ev.session_changed', sessions: [{ id: 'ses_1', state: 'archived', title: '周报', updatedAt: '2026-10-02T03:04:05.000Z' }] },
  { t: 'ev.keep_awake_state', enabled: true, active: false, platform: 'darwin', backend: 'caffeinate' },
  { t: 'ev.result', cmdId: '', ok: false, message: '载荷处理失败' },
  { empty: {} },
  { arr: [1, '两', true, null] },
  'bare string',
  42,
  { big: '数'.repeat(1000) },
]
vectors.seal = PAYLOADS.map((payload, i) => {
  const psk = PSKS[i % PSKS.length]
  const dir = i % 2 ? 'h2c' : 'c2h'
  const convId = 'c_' + hex(someBytes(6))
  const key = mp.derivePskKey(psk, dir, convId)
  const nonce = someBytes(24)
  const sealed = mp.seal(key, payload, nonce)
  return {
    psk,
    dir,
    convId,
    nonceHex: hex(nonce),
    ciphertext: sealed.ciphertext,
    /** 明文原样带上，让"我们能否解出小程序加密的东西"这一半也可以离线跑。 */
    payload,
    openedByOracle: mp.open(key, sealed) === null ? 'FAIL' : 'ok',
  }
})

// ── 5. 配对 URI 解析（两侧结论必须逐字段相同，含 null） ────────────────
const P1 = PSKS[0]
const P2 = 'ab+cd+ef+gh+ij+kl=='
const P3 = 'AbCdEfGhIjKlMnOpQrSt//=='
const QR_CASES = [
  `dshr:/p?v=1&s=wss://drc.provid.cc&n=bins-macbook&psk=${encodeURIComponent(P1)}&t=123456`,
  `dshr:/p?v=1&s=ws%3A%2F%2F127.0.0.1%3A8787&psk=${encodeURIComponent(P1)}`,
  `dshr:/p?psk=${encodeURIComponent(P1)}&t=654321&n=%E4%B8%BB%E6%9C%BA&s=wss://a.example/ws`,
  `dshr:/p?s=wss://x&psk=${P2}`,
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P2)}`,
  `dshr:/p?s=wss://x&psk=${P3}`,
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P3)}`,
  `dshr:/p?s=https://x&psk=${encodeURIComponent(P1)}`,
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P1)}&t=12`,
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P1)}&t=abcdef`,
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P1)}&t=1234567`,
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P1)}&t=`,
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P1)}&n=`,
  `dshr:/p?s=&psk=${encodeURIComponent(P1)}`,
  `dshr:/p?psk=${encodeURIComponent(P1)}`,
  `dshr:/p?s=wss://x`,
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P1)}&n=a&n=b`,
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P1)}&whatever=1`,
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P1)}&n=%zz`,
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P1)}#frag`,
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P1)}&extra=a b`,
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P1)}&tail=`,
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P1)}&psk=${encodeURIComponent(P2)}`,
  'dshr:/p',
  'dshr:',
  'DSHR:/p?s=wss://x&psk=y',
  ' dshr:/p?s=wss://x&psk=y',
  'https://x/p?s=wss://y&psk=z',
  'dshr://host/p?s=wss://x&psk=y',
  '',
  '   ',
  '{"psk":"x"}',
  `dshr:/p?s=wss://x&psk=${encodeURIComponent(P1)}&n=` + '名'.repeat(40),
]
vectors.qr = QR_CASES.map((input) => ({ input, output: mp.parsePairingQr(input) }))

vectors.normalizeToken = [' 12-3 4-56 ', '123456', '12 34 56', '---', 'a1b2c3', '', null, undefined].map((input) => ({
  input: input === undefined ? null : input,
  output: mp.normalizePairingToken(input),
}))

// ── 6. 出处与统计 ───────────────────────────────────────────────────
const mpSource = createHash('sha256').update(readFileSync(MP_CODEC)).digest('hex')
const counts = Object.fromEntries(Object.entries(vectors).map(([k, v]) => [k, v.length]))
const doc = {
  _meta: {
    note: '由 e2e/tools/gen-vectors.mjs 生成，oracle 是保留的小程序实现 mp/core/codec.js（一行不改）。新实现必须逐字节复现这里的一切。',
    oracle: 'mp/core/codec.js',
    oracleSha256: mpSource,
    generatedBy: 'e2e/tools/gen-vectors.mjs',
    counts,
  },
  vectors,
}
mkdirSync(path.dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n')
console.log('golden vectors →', path.relative(ROOT, OUT))
console.log('oracle sha256', mpSource.slice(0, 16), '…')
console.log('counts', counts)

