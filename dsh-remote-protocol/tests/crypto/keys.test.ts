/**
 * keys 的不变量测试。
 *
 * 这里**不**验证"字节与小程序一致"——那是 `e2e/protocol.test.mjs` 拿真实 `mp/core/codec.js`
 * 做 oracle 的逐字节对拍要干的事。本文件只保证实现自身不会因为"看着等价的改写"而漂移：
 * 分隔符位置、截断方向、parts 顺序、字节序，这四处各有一条测试专门钉着。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  KDF_NAMESPACE,
  KEY_BYTES,
  NONCE_BYTES,
  NONCE_PREFIX_BYTES,
  PSK_BYTES,
  buildCounterNonce,
  derivePskKey,
  generatePsk,
  kdfHash,
  noncePrefix,
  randomNonce,
} from '../../src/crypto/keys.js'
import { fromBase64, toBase64, utf8 } from '../../src/crypto/bytes.js'

const hex = (bytes: Uint8Array): string => toBase64(bytes)

test('kdfHash 输出 32 字节且对同一输入确定', () => {
  const a = kdfHash([KDF_NAMESPACE, 'c2h', 'c_abc', fromBase64(generatePsk())])
  const b = kdfHash([KDF_NAMESPACE, 'c2h', 'c_abc', fromBase64(generatePsk())])
  assert.equal(a.length, KEY_BYTES)
  const psk = generatePsk()
  assert.deepEqual(
    kdfHash([KDF_NAMESPACE, 'c2h', 'x', fromBase64(psk)]),
    kdfHash([KDF_NAMESPACE, 'c2h', 'x', fromBase64(psk)]),
  )
  assert.notDeepEqual(a, b)
})

test('分隔符：每个部分之后都补 0x1f，含最后一个（B4 最易写错处）', () => {
  // 若实现漏掉"最后一个部分之后也要补"，这两组就会撞在一起。
  const withTrailing = kdfHash(['ab'])
  const ambiguous = kdfHash(['a', 'b'])
  assert.notDeepEqual(withTrailing, ambiguous, "['ab'] 与 ['a','b'] 必须不同，否则分隔符没生效")
  // 对着独立参考实现（node:crypto 的 SHA-512）算一次期望值：SHA-512('ab' ‖ 0x1f)[0..32]。
  const expected = new Uint8Array(
    createHash('sha512')
      .update(new Uint8Array([...utf8('ab'), 0x1f]))
      .digest()
      .subarray(0, 32),
  )
  assert.deepEqual(withTrailing, expected)
  // 多部分的期望值同样独立算一遍，确保是"每段后补"，而不是"段间补"。
  const multi = kdfHash(['a', 'b'])
  const multiExpected = new Uint8Array(
    createHash('sha512')
      .update(new Uint8Array([...utf8('a'), 0x1f, ...utf8('b'), 0x1f]))
      .digest()
      .subarray(0, 32),
  )
  assert.deepEqual(multi, multiExpected)
})

test('parts 顺序参与摘要（顺序错 = 密钥错）', () => {
  const psk = fromBase64(generatePsk())
  const one = kdfHash([KDF_NAMESPACE, 'c2h', 'c_x', psk])
  const swapped = kdfHash([KDF_NAMESPACE, 'c_x', 'c2h', psk])
  assert.notDeepEqual(one, swapped)
})

test('derivePskKey：两个方向必须不同；会话 id 不同必须不同；PSK 用原始字节', () => {
  const psk = generatePsk()
  const c2h = derivePskKey(psk, 'c2h', 'c_one')
  const h2c = derivePskKey(psk, 'h2c', 'c_one')
  assert.equal(c2h.length, KEY_BYTES)
  assert.notDeepEqual(c2h, h2c)
  assert.notDeepEqual(c2h, derivePskKey(psk, 'c2h', 'c_two'))
  assert.notDeepEqual(c2h, derivePskKey(generatePsk(), 'c2h', 'c_one'))
  // 传 base64 文本而不是解码后的字节，结果必须不同——这是"psk 参与 KDF 的形式"这条契约的反证。
  assert.notDeepEqual(c2h, kdfHash([KDF_NAMESPACE, 'c2h', 'c_one', utf8(psk)]))
})

test('noncePrefix 是 16 字节，且绑 installId / convId / psk', () => {
  const psk = generatePsk()
  const p = noncePrefix(psk, 'c_one', 'install-1')
  assert.equal(p.length, NONCE_PREFIX_BYTES)
  assert.deepEqual(p, noncePrefix(psk, 'c_one', 'install-1'))
  assert.notDeepEqual(p, noncePrefix(psk, 'c_one', 'install-2'))
  assert.notDeepEqual(p, noncePrefix(psk, 'c_two', 'install-1'))
  assert.notDeepEqual(p, noncePrefix(generatePsk(), 'c_one', 'install-1'))
  // 命名空间必须与会话密钥的不同，否则同一 (psk,conv) 会派生出重叠的密钥材料。
  assert.notDeepEqual(
    noncePrefix(psk, 'c_one', 'install-1'),
    derivePskKey(psk, 'c2h', 'c_one').subarray(0, NONCE_PREFIX_BYTES),
  )
})

test('buildCounterNonce：16+8=24 字节，尾部是 8 字节**大端**计数器', () => {
  const prefix = new Uint8Array(NONCE_PREFIX_BYTES).fill(0xab)
  const zero = buildCounterNonce(prefix, 0)
  assert.equal(zero.length, NONCE_BYTES)
  assert.deepEqual(zero.subarray(0, 16), prefix)
  assert.deepEqual(Array.from(zero.subarray(16)), [0, 0, 0, 0, 0, 0, 0, 0])

  assert.deepEqual(Array.from(buildCounterNonce(prefix, 1).subarray(16)), [0, 0, 0, 0, 0, 0, 0, 1])
  assert.deepEqual(Array.from(buildCounterNonce(prefix, 255).subarray(16)), [0, 0, 0, 0, 0, 0, 0, 255])
  // 跨 32 位边界：2^32 应该是高 4 字节的最低位为 1。
  assert.deepEqual(Array.from(buildCounterNonce(prefix, 2 ** 32).subarray(16)), [0, 0, 0, 1, 0, 0, 0, 0])
  // 2^32-1 与 2^32 必须不同（小端实现会在低 4 字节上把两者都写成 0 或 1）。
  assert.notDeepEqual(buildCounterNonce(prefix, 2 ** 32 - 1), buildCounterNonce(prefix, 2 ** 32))
  // 单调性：连续 200 个 nonce 互不重复。
  const seen = new Set<string>()
  for (let i = 0; i < 200; i++) seen.add(hex(buildCounterNonce(prefix, i)))
  assert.equal(seen.size, 200)
})

test('buildCounterNonce 对坏输入抛，而不是产出可用但错误的 nonce', () => {
  const prefix = new Uint8Array(NONCE_PREFIX_BYTES)
  assert.throws(() => buildCounterNonce(new Uint8Array(15), 1), /16 字节/)
  assert.throws(() => buildCounterNonce(prefix, -1), /非负整数/)
  assert.throws(() => buildCounterNonce(prefix, 1.5), /非负整数/)
})

test('generatePsk 是 16 字节标准 base64（24 字符），每次不同', () => {
  const psk = generatePsk()
  assert.equal(psk.length, 24)
  assert.equal(fromBase64(psk).length, PSK_BYTES)
  assert.match(psk, /^[A-Za-z0-9+/]+={0,2}$/)
  assert.notEqual(psk, generatePsk())
})

test('randomNonce 每次 24 字节且互不相同', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 500; i++) seen.add(hex(randomNonce()))
  assert.equal(seen.size, 500)
})
