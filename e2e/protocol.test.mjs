/**
 * 协议层与小程序的**逐字节对拍**（阶段 A 的验收）。
 *
 * 两条独立的路径都要绿，缺一不可：
 *
 * - **fixtures**：`e2e/tools/gen-vectors.mjs` 从小程序那份 `mp/core/codec.js` 导出的
 *   golden vector，新实现必须逐字节复现。它能离线跑，且向量本身可 diff。
 * - **live oracle**：把 `mp/core/codec.js` 当模块 `require` 进 Node，随机生成新向量，
 *   两侧各算一遍并互解对方产生的密文。fixtures 防"改坏了自己不知道"，
 *   live 防"fixtures 是照着新实现生成的"这个循环论证。
 *
 * 还有一类**必须显式承认**的差异：入站 base64 的严格度。
 * Node 的 `Buffer.from(s,'base64')` 对非法字符静默丢弃，小程序的 `js-base64` 会抛；
 * 新实现在协议层用正则把"合法标准 base64"当成契约（`frames.base64Text`）来兜住。
 * 下面的 `base64 严格度` 测试就是在量这条边界的两侧关系。
 *
 * 用法：node --test e2e/protocol.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  KDF_NAMESPACE,
  NONCE_NAMESPACE,
  base64Text,
  buildCounterNonce,
  buildPairingUri,
  derivePskKey,
  fromBase64,
  fromUtf8,
  generatePsk,
  kdfHash,
  noncePrefix,
  normalizePairingToken,
  open,
  parsePairingUri,
  seal,
  toBase64,
  utf8,
} from '../packages/protocol/dist/src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const require_ = createRequire(import.meta.url)
const mp = require_(path.join(here, '..', 'mp', 'core', 'codec.js'))
const FIXTURES = JSON.parse(readFileSync(path.join(here, 'fixtures', 'wire-vectors.json'), 'utf8'))

const hex = (b) => Buffer.from(b).toString('hex')
const b64 = (b) => Buffer.from(b).toString('base64')
const unhex = (h) => new Uint8Array(Buffer.from(h, 'hex'))

test('fixtures 的出处可信：oracle 文件未被改动', () => {
  const actual = createHash('sha256').update(readFileSync(path.join(here, '..', 'mp', 'core', 'codec.js'))).digest('hex')
  assert.equal(actual, FIXTURES._meta.oracleSha256, 'mp/core/codec.js 变了但向量没重生成——先跑 gen-vectors')
})

test('fixtures：UTF-8 与 base64 字节层逐个相同', () => {
  assert.ok(FIXTURES.vectors.text.length >= 6)
  for (const v of FIXTURES.vectors.text) {
    assert.equal(hex(utf8(v.input)), v.utf8Hex, JSON.stringify(v.input).slice(0, 30))
    assert.equal(toBase64(utf8(v.input)), v.b64OfUtf8)
    assert.equal(fromUtf8(unhex(v.utf8Hex)), v.backAgain)
  }
})

test('fixtures：base64 解码结果相同（含空串与各种填充形态）', () => {
  for (const v of FIXTURES.vectors.base64) {
    if (v.errorKind !== null) continue // 小程序抛错的输入不归这里管，见「base64 严格度」
    assert.equal(hex(fromBase64(v.input)), v.decodedHex, JSON.stringify(v.input))
  }
})

test('fixtures：KDF 逐字节相同，含"部分边界"这一组反例', () => {
  for (const v of FIXTURES.vectors.kdfHash) {
    if (v.parts) assert.equal(hex(kdfHash(v.parts)), v.keyHex, JSON.stringify(v.parts))
    else
      assert.equal(
        hex(kdfHash([NONCE_NAMESPACE, 'install-1', 'c_abcdef123456', fromBase64(v.partsBytesHex[0])])),
        v.keyHex,
      )
  }
  // 关键三条单独写死，免得上面那个 else 分支把重点糊掉。
  assert.equal(hex(kdfHash(['dsh-rc/v1'])), FIXTURES.vectors.kdfHash[0].keyHex)
  assert.equal(hex(kdfHash(['a', 'b'])), FIXTURES.vectors.kdfHash[1].keyHex)
  assert.equal(hex(kdfHash(['ab'])), FIXTURES.vectors.kdfHash[2].keyHex)
  assert.notEqual(FIXTURES.vectors.kdfHash[1].keyHex, FIXTURES.vectors.kdfHash[2].keyHex, "['a','b'] 与 ['ab'] 必须不同")
})

test('fixtures：会话密钥派生 144 组全部相同（两方向 × 三会话 id × 24 PSK）', () => {
  assert.equal(FIXTURES.vectors.derivePskKey.length, 144)
  const byDir = new Map()
  for (const v of FIXTURES.vectors.derivePskKey) {
    assert.equal(hex(derivePskKey(v.psk, v.dir, v.convId)), v.keyHex, `${v.dir}/${v.convId}`)
    byDir.set(v.keyHex, v.dir)
  }
  // 交叉检查：同一 (psk, conv) 的两个方向绝不能得到同一把钥。
  for (const a of FIXTURES.vectors.derivePskKey) {
    const b = FIXTURES.vectors.derivePskKey.find(
      (x) => x.psk === a.psk && x.convId === a.convId && x.dir !== a.dir,
    )
    assert.ok(b)
    assert.notEqual(a.keyHex, b.keyHex)
  }
})

test('fixtures：nonce 前缀与 8 字节大端计数器', () => {
  for (const v of FIXTURES.vectors.noncePrefix) {
    assert.equal(hex(noncePrefix(v.psk, v.convId, v.installId)), v.prefixHex)
  }
  assert.equal(FIXTURES.vectors.buildNonce.length, 12)
  for (const v of FIXTURES.vectors.buildNonce) {
    assert.equal(hex(buildCounterNonce(unhex(v.prefixHex), v.counter)), v.nonceHex, `counter=${v.counter}`)
  }
  // 大端序的独立证据：计数器 1 的 nonce 最后一字节是 1，倒数第二字节是 0。
  const one = FIXTURES.vectors.buildNonce.find((v) => v.counter === 1)
  assert.ok(one)
  assert.equal(one.nonceHex.slice(32), '0000000000000001')
})

test('fixtures：新实现能解出小程序密封的每一种载荷，并用同一 nonce 复现同一密文', () => {
  for (const v of FIXTURES.vectors.seal) {
    assert.equal(v.openedByOracle, 'ok', '小程序自己解不开自己 → 向量生成有问题')
    const key = derivePskKey(v.psk, v.dir, v.convId)
    assert.deepEqual(open(key, { ciphertext: v.ciphertext }), v.payload)
    assert.equal(seal(key, v.payload, unhex(v.nonceHex)).ciphertext, v.ciphertext, '同 nonce 必须同密文')
  }
})

test('fixtures：配对 URI 两侧结论逐字段相同（33 组，含全部 null 分支）', () => {
  assert.equal(FIXTURES.vectors.qr.length, 33)
  for (const v of FIXTURES.vectors.qr) {
    assert.deepEqual(parsePairingUri(v.input), v.output, JSON.stringify(v.input).slice(0, 60))
  }
})

test('fixtures：配对码归一化两侧相同', () => {
  for (const v of FIXTURES.vectors.normalizeToken) {
    assert.equal(normalizePairingToken(v.input === null ? undefined : v.input), v.output)
  }
})

// ── live oracle：不依赖 fixtures 的第二条路径 ────────────────────────

const rand = (n) => new Uint8Array(randomBytes(n))

test('live：60 组随机输入，两侧 seal/open 双向互解且密文相同', () => {
  for (let i = 0; i < 60; i++) {
    const psk = b64(rand(16))
    const convId = 'c_' + hex(rand(6))
    const dir = i % 2 ? 'h2c' : 'c2h'
    const kMine = derivePskKey(psk, dir, convId)
    const kTheirs = mp.derivePskKey(psk, dir, convId)
    assert.deepEqual(kMine, kTheirs)

    const payload = {
      t: 'ev.message_delta',
      sessionId: 'ses_' + hex(rand(4)),
      messageId: 'm' + i,
      delta: '中文 😀 ' + 'x'.repeat(i % 7),
      done: i % 3 === 0,
    }
    const nonce = rand(24)
    assert.equal(
      seal(kMine, payload, nonce).ciphertext,
      mp.seal(kTheirs, payload, nonce).ciphertext,
      '同钥同 nonce 的密文必须逐字节相同',
    )
    // 交叉：我们加密（我们的 seal 允许随机 nonce）→ 小程序解
    assert.deepEqual(mp.open(kTheirs, seal(kMine, payload)), payload)
    // 交叉：小程序加密 → 我们解。小程序的 seal **必须**显式传 nonce（它没有 CSPRNG），
    // 这本身就是协议的一条约束，写在这里免得日后有人以为可以省。
    assert.deepEqual(open(kMine, mp.seal(kTheirs, payload, nonce)), payload)
  }
})

test('live：篡改任何一位都会被两侧一致地拒绝（MAC 不是装饰）', () => {
  const psk = generatePsk()
  const key = derivePskKey(psk, 'c2h', 'c_ffffffffffff')
  const rec = seal(key, { secret: 'one-time' })
  const bytes = Buffer.from(fromBase64(rec.ciphertext))
  for (const at of [0, 12, 23, 24, 25, 40, bytes.length - 1]) {
    const tampered = Buffer.from(bytes)
    tampered[at] = (tampered[at] ^ 0x5a) & 0xff
    const ciphertext = tampered.toString('base64')
    const mine = open(key, { ciphertext })
    const theirs = mp.open(key, { ciphertext })
    assert.equal(mine, null, `位置 ${at}：我们必须拒`)
    assert.equal(theirs, null, `位置 ${at}：小程序也必须拒（两侧结论要一致）`)
  }
  // 换钥必须拒
  assert.equal(open(derivePskKey(generatePsk(), 'c2h', 'c_ffffffffffff'), rec), null)
})

test('live：open 对畸形输入返回 null 而不抛（一次坏帧不许打断消息链）', () => {
  const key = derivePskKey(generatePsk(), 'h2c', 'c_0123456789ab')
  for (const junk of [null, undefined, {}, { ciphertext: '' }, { ciphertext: '!!!' }, 'string', []]) {
    assert.equal(open(key, junk), null)
  }
})

test('live：新实现的输出永远是小程序能解的标准 base64', () => {
  const key = derivePskKey(generatePsk(), 'h2c', 'c_abcabcabcabc')
  for (let i = 0; i < 40; i++) {
    const rec = seal(key, { i, 中: '文' })
    assert.match(rec.ciphertext, /^[A-Za-z0-9+/]+={0,2}$/)
    assert.equal(base64Text.safeParse(rec.ciphertext).success, true, '我们的输出必须过自己的入站校验')
    assert.deepEqual(mp.open(key, rec), { i, 中: '文' })
  }
})

test('live：我们生成的配对 URI，小程序解析结果与我们的解析器一致', () => {
  const servers = ['ws://127.0.0.1:8787', 'wss://drc.provid.cc', 'wss://h.example:8443/ws']
  for (let i = 0; i < 40; i++) {
    const psk = generatePsk()
    const server = servers[i % servers.length]
    const token = i % 2 ? String(100000 + (i * 7919) % 900000) : undefined
    const uri = buildPairingUri({ server, psk, hostLabel: 'bins-macbook ' + i, token })
    assert.deepEqual(mp.parsePairingQr(uri), parsePairingUri(uri), uri.slice(0, 70))
  }
  // 含裸 `+` 的 psk 是两侧最不对称的地方：生成侧必须编码，解析侧必须都能救回来。
  const plusy = 'ab+cd/ef+' + 'A'.repeat(15)
  assert.equal(parsePairingUri(buildPairingUri({ server: 'wss://x', psk: plusy }))?.psk, plusy)
  assert.equal(mp.parsePairingQr(buildPairingUri({ server: 'wss://x', psk: plusy }))?.psk, plusy)
})

test('base64 严格度边界：小程序拒的一定被我们拒；我们只允许更严', () => {
  let stricterOnly = 0
  for (const v of FIXTURES.vectors.base64) {
    const oursAccepts = base64Text.safeParse(v.input).success
    if (v.errorKind !== null) {
      assert.equal(oursAccepts, false, `小程序抛错的输入我们必须拒：${JSON.stringify(v.input)}`)
    } else if (!oursAccepts) {
      // 我们比小程序严的**唯一**允许情形：空串与含空白的串。
      // 小程序的解码器会先把空白剔掉（`js-base64` 的行为），而协议层的字符集校验不接受；
      // 两侧的实现都只会产出不含空白、非空的 base64，所以这里不存在真实的兼容缺口。
      assert.match(v.input, /^$|\s/, `不接受但小程序接受，且不属空串/空白类：${JSON.stringify(v.input)}`)
      stricterOnly++
    }
  }
  assert.ok(stricterOnly > 0, '至少要覆盖到空串或含空白的用例，否则这条测试是空判定')
})

test('原语层三方一致：npm tweetnacl、小程序 vendored nacl、node:crypto 的 SHA-512', async () => {
  // 从协议包的位置解析 tweetnacl（pnpm 把它链在 packages/protocol/node_modules 下）。
  const reqFromProtocol = createRequire(path.join(here, '..', 'packages', 'protocol', 'dist', 'src', 'index.js'))
  const naclNpm = reqFromProtocol('tweetnacl')
  const naclMp = mp.nacl
  for (let i = 0; i < 25; i++) {
    const msg = rand(1 + i * 613)
    // SHA-512：node:crypto（我们的 KDF 用的）必须与小程序的 nacl.hash 逐字节相同，
    // 这是"协议层不必引 tweetnacl 也能算对摘要"的依据。
    const viaNode = new Uint8Array(createHash('sha512').update(msg).digest())
    assert.deepEqual(Array.from(viaNode), Array.from(naclMp.hash(msg)), `hash(len=${msg.length})`)
    assert.deepEqual(Array.from(viaNode), Array.from(naclNpm.hash(msg)), `npm hash(len=${msg.length})`)

    const key = rand(32)
    const nonce = rand(24)
    const boxNpm = naclNpm.secretbox(msg, nonce, key)
    const boxMp = naclMp.secretbox(msg, nonce, key)
    assert.equal(boxNpm.length, msg.length + 16)
    assert.deepEqual(Array.from(boxNpm), Array.from(boxMp), `secretbox(len=${msg.length}) 密文必须逐字节相同`)
    // 交叉解密：npm 版加密 → vendored 版解密
    assert.deepEqual(Array.from(naclMp.secretbox.open(boxNpm, nonce, key)), Array.from(msg))
    assert.deepEqual(Array.from(naclNpm.secretbox.open(boxMp, nonce, key)), Array.from(msg))
  }
})

test('反证：把 KDF 的末尾分隔符去掉，向量立刻全红（证明这套断言真的在守东西）', () => {
  const withoutTrailing = (parts) => {
    const joined = new Uint8Array(parts.reduce((n, p) => n + (typeof p === 'string' ? utf8(p).length : p.length), parts.length - 1))
    let at = 0
    parts.forEach((p, i) => {
      const bytes = typeof p === 'string' ? utf8(p) : p
      joined.set(bytes, at)
      at += bytes.length
      if (i < parts.length - 1) joined[at++] = 0x1f
    })
    return new Uint8Array(createHash('sha512').update(joined).digest().subarray(0, 32))
  }
  const v = FIXTURES.vectors.kdfHash[1] // parts ['a','b']
  assert.notEqual(hex(withoutTrailing(['a', 'b'])), v.keyHex, '去掉末尾分隔符还能对得上，说明向量没在守这条')
  assert.equal(hex(kdfHash(['a', 'b'])), v.keyHex, '正确实现必须对得上')
})
