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
  const qr = {
    v: 1 as const,
    server: 'wss://example.com:8787',
    hostLabel: 'mb-林',
    psk: generatePairingSecret(),
    token: '',
  }
  const text = buildPairingQr(qr)
  const back = parsePairingQr(text)
  assert.deepEqual(back, qr)
  assert.equal(parsePairingQr('https://nope'), null)
})

test('pairing QR can carry the 6-digit code (opt-in) and rejects a bogus one', () => {
  const psk = generatePairingSecret()
  const withToken = buildPairingQr({ v: 1, server: 'wss://x', hostLabel: 'mb', psk, token: '042391' })
  assert.equal(parsePairingQr(withToken)?.token, '042391')

  // omitted by default
  assert.ok(!buildPairingQr({ v: 1, server: 'wss://x', hostLabel: 'mb', psk, token: '' }).includes('t='))

  // a non-6-digit token is dropped rather than trusted
  const bogus = `dshr:/p?v=1&s=${encodeURIComponent('wss://x')}&n=mb&psk=${encodeURIComponent(psk)}&t=abc`
  assert.equal(parsePairingQr(bogus)?.token, '')
})

test('frame parse', () => {
  assert.equal(parseFrame('garbage'), null)
  assert.equal(parseFrame('{"noType":1}'), null)
  const f = parseFrame(JSON.stringify(makeEnc('s', 1, 'abc')))
  assert.equal(f?.t, 'enc')
  assert.match(randomPairingToken(), /^\d{6}$/)
})
