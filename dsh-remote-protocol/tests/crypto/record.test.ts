/**
 * record 的行为契约：布局、字段名、失败语义。
 * 与小程序的**字节等价**由 `e2e/protocol.test.mjs` 负责；这里守的是"我们自己不能悄悄改形状"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { open, seal } from '../../src/crypto/record.js'
import { KEY_BYTES, NONCE_BYTES } from '../../src/crypto/keys.js'
import { fromBase64, toBase64, utf8 } from '../../src/crypto/bytes.js'

const key = (fill = 7): Uint8Array => new Uint8Array(KEY_BYTES).fill(fill)
const fixedNonce = (fill = 3): Uint8Array => new Uint8Array(NONCE_BYTES).fill(fill)

/** 把 base64 解出来、改一个字节、再编回去（模拟传输中的位翻转或对密文的主动篡改）。 */
function mutate(ciphertext: string, at = 30): string {
  const bytes = Buffer.from(fromBase64(ciphertext))
  bytes[at] = (bytes[at]! ^ 0x01) & 0xff
  return bytes.toString('base64')
}

test('往返：标量、嵌套、CJK、emoji、空串', () => {
  const k = key()
  const cases: unknown[] = [
    { t: 'cmd.list_sessions', cmdId: 'c1' },
    { text: '生成周报，中文与 emoji 😀 都要原样回来', n: 42, arr: [1, 2, 3], deep: { x: [null, true] } },
    { delta: '' },
    'bare string',
    1234,
    [1, '两', { 三: 4 }],
  ]
  for (const payload of cases) {
    assert.deepEqual(open(k, seal(k, payload, fixedNonce())), payload)
  }
})

test('往返：60KB 载荷不被截断（现网最大 delta 量级）', () => {
  const k = key()
  const big = '汉'.repeat(20_000) + 'a'.repeat(20_000) // >60KB 的 UTF-8
  const rec = seal(k, { delta: big }, fixedNonce())
  const back = open<{ delta: string }>(k, rec)
  assert.ok(back)
  assert.equal(back.delta.length, big.length)
  assert.equal(back.delta, big)
})

test('显式 nonce 下输出确定；随机 nonce 下每次不同但都能解', () => {
  const k = key()
  const a = seal(k, { x: 1 }, fixedNonce()).ciphertext
  const b = seal(k, { x: 1 }, fixedNonce()).ciphertext
  assert.equal(a, b)
  const r1 = seal(k, { x: 1 }).ciphertext
  const r2 = seal(k, { x: 1 }).ciphertext
  assert.notEqual(r1, r2)
  assert.deepEqual(open(k, { ciphertext: r1 }), { x: 1 })
})

test('记录形状：外层只有一个字段叫 ciphertext，且是标准 base64（B1/B2）', () => {
  const k = key()
  const rec = seal(k, { hello: 'world' }, fixedNonce())
  assert.deepEqual(Object.keys(rec), ['ciphertext'])
  assert.match(rec.ciphertext, /^[A-Za-z0-9+/]+={0,2}$/)
  assert.doesNotMatch(rec.ciphertext, /[-_]/, '不许出现 url-safe 字母表')
  const merged = fromBase64(rec.ciphertext)
  assert.deepEqual(Array.from(merged.subarray(0, NONCE_BYTES)), Array.from(fixedNonce()))
  // secretbox 的开销是 16 字节 MAC；总长 = nonce + utf8(JSON) + MAC。
  assert.equal(merged.length, NONCE_BYTES + utf8(JSON.stringify({ hello: 'world' })).length + 16)
})

test('篡改、错钥、错 nonce 段一律返回 null（B3）', () => {
  const k = key()
  const rec = seal(k, { secret: 'one-time' })
  assert.deepEqual(open(k, rec), { secret: 'one-time' })
  assert.equal(open(k, { ciphertext: mutate(rec.ciphertext) }), null)
  assert.equal(open(k, { ciphertext: mutate(rec.ciphertext, 5) }), null, '改 nonce 段也必须失败')
  assert.equal(open(key(8), rec), null, '换一把钥必须失败')
})

test('open 对垃圾输入返回 null 而绝不抛（一次坏帧不该打断消息链）', () => {
  const k = key()
  const junk: unknown[] = [
    null,
    undefined,
    {},
    { ciphertext: '' },
    { ciphertext: '!!!not base64!!!' },
    { ciphertext: toBase64(randomBytes(8)) }, // 短于 24+16
    { ciphertext: toBase64(randomBytes(39)) }, // 刚好差 1 字节
    { ciphertext: 42 },
    'a string',
    [],
  ]
  for (const value of junk) {
    assert.equal(open(k, value), null, `open(${JSON.stringify(value)}) 必须是 null`)
  }
})

test('记录长度 = 24 + 明文 UTF-8 字节数 + 16（MAC）', () => {
  const k = key()
  const rec = seal(k, '', fixedNonce()) // JSON.stringify('') 是 '""'，2 字节
  assert.equal(fromBase64(rec.ciphertext).length, NONCE_BYTES + 2 + 16)
  assert.equal(open(k, rec), '')
  // 39 字节（比 nonce+MAC 的下界还少 1）必须在碰密码学之前就被拒。
  assert.equal(open(k, { ciphertext: toBase64(randomBytes(39)) }), null)
})

test('无法 JSON 序列化的载荷直接抛，而不是发出一条"解得开但是垃圾"的帧', () => {
  const k = key()
  assert.throws(() => seal(k, undefined, fixedNonce()), /无法 JSON 序列化/)
  assert.throws(() => seal(k, () => 1, fixedNonce()), /无法 JSON 序列化/)
  assert.throws(() => seal(k, Symbol('x'), fixedNonce()), /无法 JSON 序列化/)
})

test('seal 对坏钥/坏 nonce 直接抛（是我们编程错，不是对端数据错）', () => {
  assert.throws(() => seal(new Uint8Array(31), {}, fixedNonce()), /32 字节/)
  assert.throws(() => seal(key(), {}, new Uint8Array(12)), /24 字节/)
})

test('不可 JSON 序列化的载荷会抛，而不是静默发出一个 undefined 帧', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.throws(() => seal(key(), cyclic))
})
