/**
 * @dsh-rc/protocol — wire protocol shared by the DSH Remote Control
 * Host plugin, relay server, and clients (WeChat Mini Program / web).
 *
 * Trust model (payload-level E2E):
 *  - The server relays opaque `ciphertext` strings only; it never holds keys.
 *  - Long-term identity: X25519 keypairs (host + each client).
 *  - Pairing: 6-digit claim token + host public key (QR) -> X25519 handshake.
 *  - Session: per-record encryption derived from handshake, fresh random 24B
 *    nonce per record (NaCl secretbox / AES-256-GCM fallback in mini program).
 */

export const PROTOCOL_VERSION = 1
export const DEFAULT_SERVER_PORT = 8787

// ────────────────────────────────────────────────────────────────
// Envelope types (what flows over WebSocket, always plaintext JSON)
// ────────────────────────────────────────────────────────────────

export type Role = 'host' | 'client'

/** Frame sent by host/client over WS after (optional) auth. */
export type WsFrame =
  // ── control plane (server-visible) ──
  | { t: 'hello'; role: Role; protocol: number; clientId?: string; clientMeta?: ClientMeta }
  | { t: 'auth'; role: 'host'; token: string; hostId?: string; label?: string }
  | { t: 'auth-ok'; hostId: string }
  | { t: 'auth-fail'; reason: string }
  | { t: 'pair-begin'; pairingToken: string; psk: string; hostLabel?: string }
  | { t: 'pair-ready'; pairingToken: string; ttlMs: number }
  | { t: 'pair-begin-client'; pairingToken: string; clientPublicKey?: string; clientId?: string }
  | { t: 'session-leave'; sessionId: string }
  | { t: 'paired'; hostId: string; sessionId: string }
  | { t: 'pair-fail'; reason: string }
  | { t: 'peer-joined'; sessionId: string; clientId: string }
  | { t: 'peer-left'; sessionId: string; clientId: string }
  | { t: 'session-list'; sessions: SessionSummary[] }
  | { t: 'error'; code: string; message: string }
  | { t: 'ping'; ts?: number }
  | { t: 'pong'; ts?: number }
  // ── encrypted data plane (server-opaque) ──
  | { t: 'enc'; sessionId: string; seq: number; clientId?: string; ciphertext: string }
  | {
      t: 'enc-batch'
      sessionId: string
      items: Array<{ seq: number; ciphertext: string }>
    }

export interface ClientMeta {
  platform?: 'wechat-mp' | 'web' | 'cli' | string
  label?: string
}

export interface SessionSummary {
  id: string
  title?: string
  workspace?: string
  updatedAt?: string
  /** Session creation time (ISO), when the kernel header reports one. */
  createdAt?: string
  /** 'subagent' for delegated child sessions. */
  origin?: string
  running?: boolean
  /** `detached` = persisted but not loaded in the host process (still openable). */
  /** `archived` = the host refuses every step until it is restored. */
  state?: 'idle' | 'running' | 'detached' | 'archived' | 'awaiting-permission' | 'awaiting-answer' | string
}

// ────────────────────────────────────────────────────────────────
// Decrypted payloads (host <-> client, E2E)
// ────────────────────────────────────────────────────────────────

export type Payload =
  // client -> host
  | CmdSendPrompt
  | CmdAnswer
  | CmdResolvePermission
  | CmdInterrupt
  | CmdListSessions
  | CmdKeepAwake
  | CmdSubscribe
  // host -> client
  | EvSessionChanged
  | EvMessageDelta
  | EvToolEvent
  | EvPermissionRequest
  | EvQuestionRequest
  | EvRunStateChanged
  | EvResult
  | EvKeepAwakeState

export interface CmdSendPrompt {
  t: 'cmd.send_prompt'
  cmdId: string
  sessionId: string
  text: string
  attachments?: Array<{ name: string; mime?: string; dataBase64?: string }>
}
export interface CmdAnswer {
  t: 'cmd.answer'
  cmdId: string
  sessionId: string
  requestId: string
  answers: Array<{ questionId: string; selected: string[]; freeText?: string }>
}
export interface CmdResolvePermission {
  t: 'cmd.resolve_permission'
  cmdId: string
  sessionId: string
  requestId: string
  decision: 'approve' | 'reject' | 'approve_session'
  note?: string
}
export interface CmdInterrupt {
  t: 'cmd.interrupt'
  cmdId: string
  sessionId: string
}
export interface CmdListSessions { t: 'cmd.list_sessions'; cmdId: string }
export interface CmdKeepAwake {
  t: 'cmd.keep_awake'
  cmdId: string
  enabled: boolean
  /** idle release seconds; 0 = keep awake until disabled */
  idleReleaseSec?: number
}
export interface CmdSubscribe {
  t: 'cmd.subscribe'
  cmdId: string
  /** empty = all sessions */
  sessionIds?: string[]
  includeContent?: boolean
}

export interface EvSessionChanged {
  t: 'ev.session_changed'
  sessions: SessionSummary[]
  reason?: string
}
export interface EvMessageDelta {
  t: 'ev.message_delta'
  sessionId: string
  /** assistant message id */
  messageId: string
  /** monotonically increasing part index for append-only deltas */
  part: number
  delta: string
  role?: 'assistant' | 'user' | 'system'
  done?: boolean
}
export interface EvToolEvent {
  t: 'ev.tool_event'
  sessionId: string
  callId: string
  tool: string
  phase: 'started' | 'args' | 'completed' | 'failed'
  title?: string
  argsPreview?: string
  resultPreview?: string
}
export interface EvPermissionRequest {
  t: 'ev.permission_request'
  sessionId: string
  requestId: string
  action: string
  resource?: string
  reason?: string
  options?: Array<{ id: string; label: string }>
  expiresAt?: string
}
export interface EvQuestionRequest {
  t: 'ev.question_request'
  sessionId: string
  requestId: string
  questions: Array<{
    id: string
    question: string
    multi?: boolean
    options?: Array<{ id: string; label: string }>
  }>
}
export interface EvRunStateChanged {
  t: 'ev.run_state'
  sessionId: string
  state: SessionSummary['state']
  detail?: string
}
export interface EvKeepAwakeState {
  t: 'ev.keep_awake_state'
  enabled: boolean
  active: boolean
  platform: string
  backend: string
  reason?: string
}
export interface EvResult {
  t: 'ev.result'
  cmdId: string
  ok: boolean
  message?: string
  data?: unknown
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

export const CONTROL_FRAME_TYPES = new Set<string>([
  'hello',
  'auth',
  'auth-ok',
  'auth-fail',
  'pair-begin',
  'pair-begin-client',
  'paired',
  'pair-fail',
  'peer-joined',
  'peer-left',
  'session-list',
  'error',
  'ping',
  'pong',
])

export function isControlFrame(f: WsFrame): boolean {
  return CONTROL_FRAME_TYPES.has(f.t)
}

export function parseFrame(raw: string): WsFrame | null {
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === 'object' && typeof v.t === 'string') return v as WsFrame
    return null
  } catch {
    return null
  }
}

export function makeEnc(sessionId: string, seq: number, ciphertext: string): WsFrame {
  return { t: 'enc', sessionId, seq, ciphertext }
}

/** 6-digit pairing token, human readable & QR friendly. */
export function formatPairingToken(n: number): string {
  return String(n).padStart(6, '0')
}

export function randomPairingToken(): string {
  return formatPairingToken(Math.floor(Math.random() * 1_000_000))
}

export * from './crypto.js'

export * from './keepawake.js'
