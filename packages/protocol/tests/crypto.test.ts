import test from 'node:test'
import assert from 'node:assert/strict'
import {
  generateIdentity,
  deriveSessionKey,
  seal,
  open,
  generatePairingSecret,
  buildPairingQr,
  parsePairingQr,
  derivePskKey,
  parseFrame,
  makeEnc,
  randomPairingToken,
} from '../src/index.js'

test('identity + x25519 shared key symmetric', () => {
  const a = generateIdentity()
  const b = generateIdentity()
  const k1 = deriveSessionKey(a.secretKey, b.publicKey, 'sess-1')
  const k2 = deriveSessionKey(b.secretKey, a.publicKey, 'sess-1')
  assert.deepEqual([...k1], [...k2])
})

test('seal/open roundtrip + tamper rejected', () => {
  const k = derivePskKey(generatePairingSecret(), 'c2h', 's1')
  const rec = seal(k, { t: 'cmd.send_prompt', text: '你好 dsh' })
  assert.ok(rec.ciphertext.length > 32)
  const out = open<{ t: string; text: string }>(k, rec)
  assert.equal(out?.t, 'cmd.send_prompt')
  assert.equal(out?.text, '你好 dsh')
  // wrong key
  const k2 = derivePskKey(generatePairingSecret(), 'c2h', 's1')
  assert.equal(open(k2, rec), null)
  // tampered ciphertext
  const bad = { ciphertext: rec.ciphertext.slice(0, -4) + 'AAAA' }
  assert.equal(open(k, bad), null)
})

test('psk direction keys differ', () => {
  const psk = generatePairingSecret()
  const c2h = derivePskKey(psk, 'c2h', 's')
  const h2c = derivePskKey(psk, 'h2c', 's')
  assert.notDeepEqual([...c2h], [...h2c])
})

test('pairing QR roundtrip', () => {
  const qr = { v: 1 as const, server: 'wss://example.com:8787', hostLabel: 'mb-林', psk: generatePairingSecret() }
  const text = buildPairingQr(qr)
  const back = parsePairingQr(text)
  assert.deepEqual(back, qr)
  assert.equal(parsePairingQr('https://nope'), null)
})

test('frame parse', () => {
  assert.equal(parseFrame('garbage'), null)
  assert.equal(parseFrame('{"noType":1}'), null)
  const f = parseFrame(JSON.stringify(makeEnc('s', 1, 'abc')))
  assert.equal(f?.t, 'enc')
  assert.match(randomPairingToken(), /^\d{6}$/)
})
