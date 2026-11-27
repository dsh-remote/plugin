const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { vectors } = require('./fixtures/wire-v1.json');
const { deriveKey, seal, open, keyPair, makeGrant, readGrant } = require('../packages/protocol/crypto.cjs');
const { decodeEndpoint, validateCommand, validDigest } = require('../packages/protocol/wire.cjs');

test('W1: fixed v1 keys and encrypted records match the extracted golden observations', () => {
  for (const v of vectors.derivePskKey) {
    assert.equal(Buffer.from(deriveKey(v.psk, v.dir, v.convId)).toString('hex'), v.keyHex);
  }
  for (const v of vectors.seal) {
    const key = deriveKey(v.psk, v.dir, v.convId);
    assert.equal(seal(key, v.payload, Buffer.from(v.nonceHex, 'hex')), v.ciphertext);
    assert.deepEqual(open(key, v.ciphertext), v.payload);
    const other = deriveKey(v.psk, v.dir === 'c2h' ? 'h2c' : 'c2h', v.convId);
    assert.equal(open(other, v.ciphertext), null);
    const damaged = Buffer.from(v.ciphertext, 'base64');
    damaged[damaged.length - 1] ^= 1;
    assert.equal(open(key, damaged.toString('base64')), null);
  }
  assert.throws(() => deriveKey('MTIz', 'c2h', 'c_0123456789ab'), /16/);
});

test('P2: X25519 grant SAS matches an independent SHA-512 calculation and rejects corrupted grant', () => {
  const host = keyPair(new Uint8Array(32).fill(7));
  const phone = keyPair(new Uint8Array(32).fill(11));
  const psk = 'AAECAwQFBgcICQoLDA0ODw==';
  const offered = makeGrant(host.secretKey, phone.publicKey, psk, new Uint8Array(24).fill(3));
  const shared = require('tweetnacl').box.before(host.publicKey, phone.secretKey);
  const expected = String(createHash('sha512').update(shared).update('dsh-rc/sas').digest().readUInt32BE() % 1000000)
    .padStart(6, '0');
  assert.equal(offered.sas, expected);
  assert.equal('psk' in offered, false);
  assert.deepEqual(readGrant(phone.secretKey, offered), { sas: expected, psk });
  assert.equal(readGrant(phone.secretKey, { ...offered, hostPub: 'AA==' }), null);
  const changed = Buffer.from(offered.wrappedPsk, 'base64');
  changed[0] ^= 1;
  assert.equal(readGrant(phone.secretKey, { ...offered, wrappedPsk: changed.toString('base64') }), null);
});

test('W2: role checks, malformed input, forward-compatible fields and text-free digests', () => {
  const decode = (frame, role) => decodeEndpoint(JSON.stringify(frame), role);
  assert.equal(decodeEndpoint('not JSON', null).error, 'bad_json');
  assert.equal(decode({ t: 'enc', sessionId: 'c_0123456789ab', ciphertext: 'aA==' }, null).error, 'need_hello');
  assert.equal(decode({ t: 'hello', role: 'client', protocol: 2 }, null).error, 'unsupported_protocol');
  assert.equal(decode({ t: 'pair-begin', pairingToken: '012345' }, 'client').error, 'need_host');
  assert.equal(decode({ t: 'enc', sessionId: 'c_0123456789ab', ciphertext: '???' }, 'client').error, 'bad_frame');
  assert.deepEqual(decode({ t: 'hello', role: 'client', protocol: 1, futureField: true }, null).frame,
    { t: 'hello', role: 'client', protocol: 1 });
  assert.equal(validDigest({ at: 123, running: true, steps: 4, pending: 0 }), true);
  assert.equal(validDigest({ at: 123, running: false, title: 'private' }), false);
  assert.equal(validDigest({ at: 123, running: false, steps: -1 }), false);
});

test('H2/H4: command budgets, closed vocabulary, and independent history cursors', () => {
  const ask = { t: 'cmd.send_prompt', cmdId: 'prompt', sessionId: 'session-one' };
  assert.equal(validateCommand({ ...ask, text: 'x'.repeat(20000) }), true);
  assert.equal(validateCommand({ ...ask, text: 'x'.repeat(20001) }), false);
  assert.equal(validateCommand({ ...ask, text: '', images: [{ name: 'one.jpg', mediaType: 'image/jpeg', data: '/9j/2Q==' }] }), true);
  assert.equal(validateCommand({ ...ask, text: '', files: [{ mediaType: 'text/plain', name: 'x.txt', data: '!' }] }), false);
  assert.equal(validateCommand({ t: 'cmd.unregistered', cmdId: 'x' }), false);
  const history = { t: 'cmd.session_history', sessionId: 'session-one', cmdId: 'history' };
  assert.equal(validateCommand({ ...history, since: 0 }), true);
  assert.equal(validateCommand({ ...history, beforeSeq: 4, since: 0 }), false);
});
