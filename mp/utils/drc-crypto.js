/**
 * drc-crypto — Mini Program mirror of @dsh-rc/protocol/src/crypto.ts.
 *
 * The wire format must be byte-identical to the Node implementation:
 *   sealed record  = base64( nonce(24) || nacl.secretbox(utf8(JSON), nonce, key) )
 *   conversation key = SHA-512( 'dsh-rc/v1' | dir | convId | psk )[0..32]
 *
 * Why this file exists instead of just importing the package:
 *   - Mini Program has no Buffer / atob / btoa / TextEncoder guarantees,
 *     so base64 + UTF-8 are implemented here over Uint8Array only.
 *   - Mini Program has no CSPRNG we can rely on, so `seal()` REQUIRES an
 *     explicit nonce; callers use a counter nonce (utils/drc-crypto nonce
 *     factory) which is safe because the key is unique per (pairing,
 *     direction, conversation) and therefore a nonce never repeats.
 *
 * CommonJS on purpose: WeChat Mini Program loads utils via require().
 */
var nacl = require('./nacl-fast.js')

// ── UTF-8 ────────────────────────────────────────────────────────────
/** string -> Uint8Array (UTF-8). Matches TextEncoder semantics for valid input. */
function encodeUtf8(s) {
  var out = []
  var i = 0
  var c
  for (; i < s.length; i++) {
    c = s.charCodeAt(i)
    if (c < 0x80) {
      out.push(c)
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      // surrogate pair
      var c2 = s.charCodeAt(i + 1)
      var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
      i++
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      )
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return new Uint8Array(out)
}

/** Uint8Array(UTF-8) -> string. Matches TextDecoder (fatal=false) semantics. */
function decodeUtf8(arr) {
  var out = ''
  var i = 0
  var b
  while (i < arr.length) {
    b = arr[i]
    if (b < 0x80) {
      out += String.fromCharCode(b)
      i += 1
    } else if (b >= 0xc0 && b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (arr[i + 1] & 0x3f))
      i += 2
    } else if (b >= 0xe0 && b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((arr[i + 1] & 0x3f) << 6) | (arr[i + 2] & 0x3f),
      )
      i += 3
    } else {
      var cp =
        ((b & 0x07) << 18) |
        ((arr[i + 1] & 0x3f) << 12) |
        ((arr[i + 2] & 0x3f) << 6) |
        (arr[i + 3] & 0x3f)
      cp -= 0x10000
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
      i += 4
    }
  }
  return out
}

// ── Base64 ───────────────────────────────────────────────────────────
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
var B64_REV = (function () {
  var m = {}
  for (var i = 0; i < B64.length; i++) m[B64.charAt(i)] = i
  return m
})()

/** Uint8Array -> standard base64 (identical to Buffer.toString('base64')). */
function encodeBase64(arr) {
  var out = ''
  var i = 0
  var n = arr.length
  var c1, c2, c3
  while (i < n) {
    c1 = arr[i++] & 0xff
    if (i === n) {
      out += B64.charAt(c1 >> 2)
      out += B64.charAt((c1 & 0x03) << 4)
      out += '=='
      break
    }
    c2 = arr[i++] & 0xff
    if (i === n) {
      out += B64.charAt(c1 >> 2)
      out += B64.charAt(((c1 & 0x03) << 4) | ((c2 & 0xf0) >> 4))
      out += B64.charAt((c2 & 0x0f) << 2)
      out += '='
      break
    }
    c3 = arr[i++] & 0xff
    out += B64.charAt(c1 >> 2)
    out += B64.charAt(((c1 & 0x03) << 4) | ((c2 & 0xf0) >> 4))
    out += B64.charAt(((c2 & 0x0f) << 2) | ((c3 & 0xc0) >> 6))
    out += B64.charAt(c3 & 0x3f)
  }
  return out
}

/** standard base64 -> Uint8Array. Throws on malformed input (like tweetnacl-util). */
function decodeBase64(s) {
  var clean = String(s).replace(/[\r\n\s]/g, '')
  if (clean.length % 4 !== 0) throw new TypeError('invalid base64 length')
  var len = (clean.length / 4) * 3
  if (clean.charAt(clean.length - 1) === '=') len--
  if (clean.charAt(clean.length - 2) === '=') len--
  var out = new Uint8Array(len)
  var p = 0
  var i = 0
  var c1, c2, c3, c4
  while (i < clean.length) {
    c1 = B64_REV[clean.charAt(i++)]
    c2 = B64_REV[clean.charAt(i++)]
    c3 = B64_REV[clean.charAt(i++)]
    c4 = B64_REV[clean.charAt(i++)]
    if (c1 === undefined || c2 === undefined) throw new TypeError('invalid base64')
    if (c3 === undefined) c3 = 0
    if (c4 === undefined) c4 = 0
    if (p < len) out[p++] = (c1 << 2) | (c2 >> 4)
    if (p < len) out[p++] = ((c2 & 0x0f) << 4) | (c3 >> 2)
    if (p < len) out[p++] = ((c3 & 0x03) << 6) | c4
  }
  return out
}

// ── KDF ──────────────────────────────────────────────────────────────
/** SHA-512(part|0x1f for each part) truncated to 32B — mirrors kdfHash(). */
function kdfHash(parts) {
  var joined = []
  var i, j, b
  for (i = 0; i < parts.length; i++) {
    b = typeof parts[i] === 'string' ? encodeUtf8(parts[i]) : parts[i]
    for (j = 0; j < b.length; j++) joined.push(b[j])
    joined.push(0x1f) // unit separator, appended after EVERY part (incl. last)
  }
  return nacl.hash(new Uint8Array(joined)).slice(0, 32)
}

/** Per-direction conversation key from the pairing PSK + conversation id. */
function derivePskKey(pskB64, direction, conversationId) {
  return kdfHash(['dsh-rc/v1', direction, conversationId, decodeBase64(pskB64)])
}

// ── seal / open ──────────────────────────────────────────────────────
/**
 * @param {Uint8Array} key     32-byte conversation key
 * @param {*} plaintextJson    JSON-serialisable object
 * @param {Uint8Array} nonce   24 bytes. REQUIRED in Mini Program (no CSPRNG).
 * @returns {{ciphertext: string}} base64(nonce || box)
 */
function seal(key, plaintextJson, nonce) {
  if (!nonce || nonce.length !== 24) {
    throw new Error('seal() requires an explicit 24-byte nonce in Mini Program')
  }
  var msg = encodeUtf8(JSON.stringify(plaintextJson))
  var box = nacl.secretbox(msg, nonce, key)
  var merged = new Uint8Array(24 + box.length)
  merged.set(nonce, 0)
  merged.set(box, 24)
  return { ciphertext: encodeBase64(merged) }
}

/** @returns {*|null} the decrypted JSON payload, or null on any failure. */
function open(key, record) {
  try {
    var merged = decodeBase64(record.ciphertext)
    if (merged.length < 24 + 16) return null
    var nonce = merged.slice(0, 24)
    var box = merged.slice(24)
    var msg = nacl.secretbox.open(box, nonce, key)
    if (!msg) return null
    return JSON.parse(decodeUtf8(msg))
  } catch (e) {
    return null
  }
}

// ── counter nonces ───────────────────────────────────────────────────
/**
 * Stable 16-byte prefix for a (install, pairing, conversation) triple.
 * The remaining 8 bytes are a big-endian counter, persisted by the caller.
 * Uniqueness argument: (key, nonce) never repeats because the key already
 * binds psk+conversation+direction, and the counter is monotonic per
 * installId — if storage is wiped, installId changes too.
 */
function noncePrefix(pskB64, conversationId, installId) {
  return kdfHash(['dsh-rc/v1/nonce', installId, conversationId, decodeBase64(pskB64)]).slice(0, 16)
}

/** prefix(16) + counter(8, big-endian) -> 24-byte nonce. */
function buildNonce(prefix16, counter) {
  var n = new Uint8Array(24)
  n.set(prefix16, 0)
  var hi = Math.floor(counter / 0x100000000)
  var lo = counter >>> 0
  n[16] = (hi >>> 24) & 0xff
  n[17] = (hi >>> 16) & 0xff
  n[18] = (hi >>> 8) & 0xff
  n[19] = hi & 0xff
  n[20] = (lo >>> 24) & 0xff
  n[21] = (lo >>> 16) & 0xff
  n[22] = (lo >>> 8) & 0xff
  n[23] = lo & 0xff
  return n
}

// ── pairing QR ───────────────────────────────────────────────────────
/**
 * Parse `dshr:/p?v=1&s=<ws url>&n=<label>&psk=<base64 16B>`.
 * Mirrors URLSearchParams decoding ('+' -> space). If the decoded psk ends up
 * containing a space (a producer that emitted raw '+' for base64), we retry
 * with '+' preserved — this keeps hand-written / third-party QRs working.
 */
function parsePairingQr(text) {
  try {
    var s = String(text || '')
    if (s.indexOf('dshr:') !== 0) return null
    var q = s.indexOf('?')
    if (q < 0) return null
    var params = parseQuery(s.slice(q + 1), true)
    var psk = params.psk
    var server = params.s
    if (!psk || !server) return null
    if (psk.indexOf(' ') >= 0) {
      var retry = parseQuery(s.slice(q + 1), false)
      if (retry.psk && retry.psk.indexOf(' ') < 0) {
        psk = retry.psk
        if (!server || server.indexOf(' ') >= 0) server = retry.s || server
      }
    }
    // `t` is optional: a host that chooses to embed the pairing code lets the
    // client skip the manual step. Absent means "ask the user for it".
    var token = params.t && /^\d{6}$/.test(params.t) ? params.t : ''
    return { v: 1, server: server, hostLabel: params.n || 'dsh', psk: psk, token: token }
  } catch (e) {
    return null
  }
}

function parseQuery(qs, plusAsSpace) {
  var out = {}
  var parts = String(qs).split('&')
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue
    var eq = parts[i].indexOf('=')
    var k = eq < 0 ? parts[i] : parts[i].slice(0, eq)
    var v = eq < 0 ? '' : parts[i].slice(eq + 1)
    out[decodeQ(k, plusAsSpace)] = decodeQ(v, plusAsSpace)
  }
  return out
}

function decodeQ(v, plusAsSpace) {
  var s = String(v)
  if (plusAsSpace) s = s.replace(/\+/g, ' ')
  try {
    return decodeURIComponent(s)
  } catch (e) {
    return s
  }
}

/** 6-digit pairing tokens are entered by hand; normalise whitespace/dashes. */
function normalizePairingToken(raw) {
  return String(raw || '').replace(/[\s-]/g, '')
}

// ── misc ─────────────────────────────────────────────────────────────
/** Weak but unique-enough id for the control plane (clientId). Not a secret. */
function randomId() {
  return (
    Date.now().toString(36) +
    '-' +
    Math.floor(Math.random() * 0xffffffff).toString(36) +
    Math.floor(Math.random() * 0xffffffff).toString(36)
  )
}

module.exports = {
  nacl: nacl,
  encodeUtf8: encodeUtf8,
  decodeUtf8: decodeUtf8,
  encodeBase64: encodeBase64,
  decodeBase64: decodeBase64,
  kdfHash: kdfHash,
  derivePskKey: derivePskKey,
  seal: seal,
  open: open,
  noncePrefix: noncePrefix,
  buildNonce: buildNonce,
  parsePairingQr: parsePairingQr,
  normalizePairingToken: normalizePairingToken,
  randomId: randomId,
}
