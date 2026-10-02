/**
 * outbound — 出站帧与出站载荷的**构造器**。
 *
 * 为什么要有这个文件（复核 R7、§5.2）：旧实现（以及我第一版新代码）都是在各处
 * 手搓 `{ t:'paired', sessionId, hostId }` 这样的字面量。这有两个后果：
 *
 * 1. 字段名散落在十几个调用点里，改一个就得改全部，而小程序只会**静默地**显示不出来；
 * 2. "禁止出现的字段"这种约束根本没有防线——比如 `ev.keep_awake_state` 与
 *    `ev.session_changed` 按契约**不带** `sessionId`（F11），但拼装模式下
 *    谁都可能顺手加一个，而 zod 默认会把未知键**剥掉**而不是报错，
 *    于是连测试都看不出差别。
 *
 * 这里把每条出站帧/载荷收成一个函数：参数表就是允许出现的字段集合，
 * 没有的参数**类型上不存在**。`outbound.test.mjs` 再对产物断言键集，
 * 这样 F4（必发帧的必填项）、F11（禁止字段）、F3（sessionId 逐字不变）
 * 才从"文档要求"变成"跑一下就红"。
 */
import type { ClientMeta, ErrorCode } from './frames.js'
import {
  type ChoiceOption,
  type EvKeepAwakeState,
  type EvMessageDelta,
  type EvPayload,
  type EvPermissionRequest,
  type EvQuestionRequest,
  type EvResult,
  type EvRunState,
  type EvSessionChanged,
  type EvSessionHistory,
  type EvToolEvent,
  type HistoryItem,
  type QuestionItem,
  type SessionSummary,
  PAYLOAD_TYPES,
} from './payloads.js'

// ── 中继 → 端点 的控制面 ─────────────────────────────────────────────

export interface RelayOutbound {
  t: string
  [key: string]: unknown
}

export function helloOkForClient(clientId: string, protocol?: number): RelayOutbound {
  return { t: 'hello-ok', role: 'client', clientId, ...(protocol === undefined ? {} : { protocol }) }
}

export function helloOkForHost(hostId: string, protocol?: number): RelayOutbound {
  return { t: 'hello-ok', role: 'host', hostId, ...(protocol === undefined ? {} : { protocol }) }
}

export function pairReady(pairingToken: string, ttlMs: number): RelayOutbound {
  // ttlMs 必须是正整数：主机要靠它改写本地过期时间（旧实现的第一起事故）。
  return { t: 'pair-ready', pairingToken, ttlMs }
}

export function paired(sessionId: string, hostId: string): RelayOutbound {
  return { t: 'paired', sessionId, hostId }
}

export function pairFail(
  reason: 'invalid_or_expired' | 'already_used' | 'host_offline' | 'bad_token' | 'rate_limited',
): RelayOutbound {
  return { t: 'pair-fail', reason }
}

/** 发给主机的加入通知必须带 pairingToken（主机按它取 PSK）；发给客户端的不带。 */
export function peerJoinedForHost(sessionId: string, clientId: string, pairingToken: string): RelayOutbound {
  return { t: 'peer-joined', sessionId, clientId, pairingToken }
}

export function peerJoinedNotice(sessionId: string, hostId: string): RelayOutbound {
  return { t: 'peer-joined', sessionId, clientId: hostId }
}

/**
 * `peer-left` 只有一个合法触发：**主机离开**。
 * 参数表里刻意没有"告诉某个客户端别人走了"的形态——那种帧会让别的手机无辜丢配对（F5）。
 */
export function peerLeft(sessionId: string, clientId: string): RelayOutbound {
  return { t: 'peer-left', sessionId, clientId }
}

export function makeError(code: ErrorCode, message?: string): RelayOutbound {
  return { t: 'error', code, ...(message === undefined ? {} : { message }) }
}

export function pong(ts?: number): RelayOutbound {
  return { t: 'pong', ...(ts === undefined ? {} : { ts }) }
}

/** 数据面：`sessionId` 逐字来自入帧或配对结果，这里不做任何加工（F3）。 */
export function encToClient(sessionId: string, seq: number, ciphertext: string): RelayOutbound {
  return { t: 'enc', sessionId, seq, ciphertext }
}

export function encBatchToClient(sessionId: string, items: Array<{ seq: number; ciphertext: string }>): RelayOutbound {
  return { t: 'enc-batch', sessionId, items }
}

// ── host → client 的数据面载荷 ───────────────────────────────────────

export function sessionChanged(sessions: SessionSummary[], reason?: string): EvSessionChanged {
  return { t: PAYLOAD_TYPES.evSessionChanged, sessions, ...(reason === undefined ? {} : { reason }) }
}

export function messageDelta(args: {
  messageId: string
  delta: string
  sessionId?: string
  part?: number
  role?: 'assistant' | 'user' | 'system'
  done?: boolean
}): EvMessageDelta {
  return { t: PAYLOAD_TYPES.evMessageDelta, ...args }
}

export function toolEvent(args: {
  callId: string
  phase: 'started' | 'args' | 'completed' | 'failed'
  tool?: string
  title?: string
  argsPreview?: string
  resultPreview?: string
  sessionId?: string
}): EvToolEvent {
  return { t: PAYLOAD_TYPES.evToolEvent, ...args }
}

export function permissionRequest(args: {
  requestId: string
  action: string
  options?: ChoiceOption[]
  resource?: string
  reason?: string
  expiresAt?: string
  sessionId?: string
}): EvPermissionRequest {
  return { t: PAYLOAD_TYPES.evPermissionRequest, ...args }
}

export function questionRequest(args: {
  requestId: string
  questions: QuestionItem[]
  sessionId?: string
}): EvQuestionRequest {
  return { t: PAYLOAD_TYPES.evQuestionRequest, ...args }
}

export function runState(args: { state: 'running' | 'idle'; detail?: string; sessionId?: string }): EvRunState {
  return { t: PAYLOAD_TYPES.evRunState, ...args }
}

/**
 * 防休眠状态：参数表里没有 `sessionId`（F11）。
 * 想按会话区分就得改协议——那需要先改小程序，而它不在本次范围内。
 */
export function keepAwakeState(args: {
  enabled: boolean
  active: boolean
  platform: string
  backend: string
  reason?: string
}): EvKeepAwakeState {
  return { t: PAYLOAD_TYPES.evKeepAwakeState, ...args }
}

export type EvResultExtras = { message?: string; data?: Record<string, unknown> }

export function result(cmdId: string, ok: boolean, extras: EvResultExtras = {}): EvResult {
  const { message, data } = extras
  return {
    t: PAYLOAD_TYPES.evResult,
    cmdId,
    ok,
    ...(message === undefined ? {} : { message }),
    ...(data === undefined ? {} : { data }),
  }
}

/**
 * 一页历史。
 *
 * **只给游标，不给 `hasMore`**：`nextBeforeSeq` 在 = 还有更早的一页，不在 = 到底了。
 * 原来那版是两个字段，于是"说还有、却忘了给游标"能写得出来，而那产出的是一条
 * 过不了自己 schema 的载荷——它只会在手机侧被静默丢弃，表现是「加载更早」点了没反应。
 * 现在这种状态在类型上不存在。
 */
export function sessionHistory(args: {
  sessionId: string
  cmdId: string
  items: HistoryItem[]
  /** 省略即"这是最初的一页"。 */
  nextBeforeSeq?: number
}): EvSessionHistory {
  const { sessionId, cmdId, items, nextBeforeSeq } = args
  return {
    t: PAYLOAD_TYPES.evSessionHistory,
    sessionId,
    cmdId,
    items,
    ...(nextBeforeSeq === undefined ? {} : { nextBeforeSeq }),
  }
}

export type OutboundPayload = EvPayload
