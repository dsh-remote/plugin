/**
 * E2E crypto for DSH Remote Control — pure tweetnacl so the SAME semantics
 * run in the DSH host plugin (Node), the relay tests, and the WeChat Mini
 * Program client (vendored nacl-fast.js + counter nonces).
 *
 * Wire form of a sealed record: base64( nonce(24) || secretbox ).
 * Conversation keys: derived per pairing from a 16B PSK + direction +
 * conversation id via SHA-512(truncated 32) — no platform hash needed
 * (nacl.hash is SHA-512, available in every target).
 */
import nacl from 'tweetnacl'
import naclUtil from 'tweetnacl-util'
const { encodeBase64, decodeBase64 } = naclUtil

export interface KeyPair {
  publicKey: string // base64, 32B
  secretKey: string // base64, 64B (nacl format)
}

export function generateIdentity(): KeyPair {
  const kp = nacl.box.keyPair()
  return { publicKey: encodeBase64(kp.publicKey), secretKey: encodeBase64(kp.secretKey) }
}

/** Rehydrate a stored identity (persist both halves together). */
export function parseIdentity(json: string): KeyPair | null {
  try {
    const v = JSON.parse(json)
    if (v && typeof v.publicKey === 'string' && typeof v.secretKey === 'string') {
      return { publicKey: v.publicKey, secretKey: v.secretKey }
    }
    return null
  } catch {
    return null
  }
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/** sha512(bytes...) truncated to 32B, using nacl.hash (portable). */
function kdfHash(parts: Array<Uint8Array | string>): Uint8Array {
  const joined: number[] = []
  for (const p of parts) {
    const b = typeof p === 'string' ? enc(p) : p
    for (const x of b) joined.push(x)
    joined.push(0x1f) // unit separator
  }
  const h = nacl.hash(new Uint8Array(joined))
  return h.slice(0, 32)
}

/** X25519 -> conversation key (for future web/desktop clients with box support). */
export function deriveSessionKey(
  mySecretB64: string,
  theirPublicB64: string,
  context: string,
): Uint8Array {
  const shared = nacl.box.before(decodeBase64(theirPublicB64), decodeBase64(mySecretB64))
  return kdfHash([shared, 'dsh-rc/v1/x25519', context])
}

export interface SealedRecord {
  /** base64(nonce || box), single field on the wire */
  ciphertext: string
}

export function seal(key: Uint8Array, plaintextJson: unknown, nonce?: Uint8Array): SealedRecord {
  const n = nonce ?? nacl.randomBytes(24)
  if (n.length !== 24) throw new Error('nonce must be 24 bytes')
  const msg = enc(JSON.stringify(plaintextJson))
  const box = nacl.secretbox(msg, n, key)
  const merged = new Uint8Array(24 + box.length)
  merged.set(n, 0)
  merged.set(box, 24)
  return { ciphertext: encodeBase64(merged) }
}

export function open<T = unknown>(key: Uint8Array, record: SealedRecord): T | null {
  const merged = decodeBase64(record.ciphertext)
  if (merged.length < 24 + 16) return null
  const nonce = merged.slice(0, 24)
  const box = merged.slice(24)
  const msg = nacl.secretbox.open(box, nonce, key)
  if (!msg) return null
  try {
    return JSON.parse(new TextDecoder().decode(msg)) as T
  } catch {
    return null
  }
}

/**
 * Pairing secret: 16B PSK shown as 6-digit token + QR (mini program cannot do
 * X25519 comfortably; PSK-in-QR + per-direction derived keys keeps the server
 * zero-knowledge). Rotate per pairing; single-use enforced by the relay.
 */
export function generatePairingSecret(): string {
  return encodeBase64(nacl.randomBytes(16))
}

export interface PairingQr {
  v: 1
  server: string
  hostLabel: string
  /** pre-shared secret (base64 16B) */
  psk: string
  /**
   * Optional 6-digit pairing code embedded in the QR.
   *
   * The host shows the code next to the QR anyway, so embedding it is not a
   * real security downgrade — but a QR that leaks on its own (screenshot,
   * clipboard manager) would then also leak the code. So it is OPT-IN
   * (`drc pair --with-token`) and off by default; absent means "ask the user".
   * Always present in the parsed shape ('' when absent) so the Mini Program
   * and Node implementations stay deep-equal.
   */
  token: string
}

export function parsePairingQr(text: string): PairingQr | null {
  try {
    const qIdx = text.indexOf('?')
    if (!text.startsWith('dshr:') || qIdx < 0) return null
    const params = new URLSearchParams(text.slice(qIdx + 1))
    const psk = params.get('psk')
    const server = params.get('s')
    if (!psk || !server) return null
    const t = params.get('t')
    return {
      v: 1,
      server,
      hostLabel: params.get('n') ?? 'dsh',
      psk,
      token: t && /^\d{6}$/.test(t) ? t : '',
    }
  } catch {
    return null
  }
}

export function buildPairingQr(qr: PairingQr): string {
  const p = new URLSearchParams()
  p.set('v', '1')
  p.set('s', qr.server)
  p.set('n', qr.hostLabel)
  p.set('psk', qr.psk)
  if (qr.token) p.set('t', qr.token)
  return `dshr:/p?${p.toString()}`
}

/** Per-direction conversation key from PSK + conversation id. */
export function derivePskKey(
  pskB64: string,
  direction: 'c2h' | 'h2c',
  conversationId: string,
): Uint8Array {
  return kdfHash(['dsh-rc/v1', direction, conversationId, decodeBase64(pskB64)])
}
