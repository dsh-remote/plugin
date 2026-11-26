'use strict';

const nacl = require('tweetnacl');
const { Base64 } = require('js-base64');

function bytes(text) {
  return Base64.toUint8Array(Base64.encode(text));
}

function toBase64(value) {
  return Base64.fromUint8Array(value);
}

function fromBase64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError('Invalid base64');
  }
  return Base64.toUint8Array(value);
}

function join(parts) {
  const value = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    value.set(part, offset);
    offset += part.length;
  }
  return value;
}

function deriveKey(psk, direction, sessionId) {
  const secret = fromBase64(psk);
  if (secret.length !== 16) throw new RangeError('PSK must contain 16 bytes');
  if (!['c2h', 'h2c'].includes(direction)) throw new TypeError('Invalid key direction');
  const separator = Uint8Array.of(31);
  const input = join([bytes('dsh-rc/v1'), separator, bytes(direction), separator, bytes(sessionId), separator, secret, separator]);
  return nacl.hash(input).subarray(0, 32);
}

function seal(key, value, nonce) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Record must be serializable JSON');
  return toBase64(join([nonce, nacl.secretbox(bytes(serialized), nonce, key)]));
}

function open(key, ciphertext) {
  try {
    const record = fromBase64(ciphertext);
    if (record.length < 40) return null;
    const plaintext = nacl.secretbox.open(record.subarray(24), record.subarray(0, 24), key);
    return plaintext ? JSON.parse(Base64.decode(toBase64(plaintext))) : null;
  } catch {
    return null;
  }
}

function keyPair(secret) {
  return nacl.box.keyPair.fromSecretKey(secret);
}

function grantKeys(secret, peer) {
  const shared = nacl.box.before(peer, secret);
  const number = nacl.hash(join([shared, bytes('dsh-rc/sas')]));
  const value = new DataView(number.buffer, number.byteOffset, 4).getUint32(0);
  const key = nacl.hash(join([shared, bytes('dsh-rc/psk-wrap')])).subarray(0, 32);
  return { sas: String(value % 1000000).padStart(6, '0'), key };
}

function makeGrant(secret, clientPub, psk, nonce) {
  const { sas, key } = grantKeys(secret, clientPub);
  const pskBytes = fromBase64(psk);
  if (pskBytes.length !== 16) throw new RangeError('PSK must contain 16 bytes');
  return {
    sas, hostPub: toBase64(keyPair(secret).publicKey), nonce: toBase64(nonce),
    wrappedPsk: toBase64(nacl.secretbox(pskBytes, nonce, key)),
  };
}

function readGrant(secret, frame) {
  try {
    const { sas, key } = grantKeys(secret, fromBase64(frame.hostPub));
    const result = nacl.secretbox.open(fromBase64(frame.wrappedPsk), fromBase64(frame.nonce), key);
    return result && result.length === 16 ? { sas, psk: toBase64(result) } : null;
  } catch {
    return null;
  }
}

module.exports = { toBase64, fromBase64, deriveKey, seal, open, keyPair, makeGrant, readGrant };
