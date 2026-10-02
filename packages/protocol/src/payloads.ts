/**
 * payloads — 数据面载荷目录（host ⇄ client，端到端加密之后才是这些）。
 *
 * 新实现里载荷类型的**唯一事实源**：中继看不见它们（结构性零知识），
 * 插件按 `cmd.*` 分发、按 `ev.*` 推送，小程序按字段名渲染。
 * 校验用 `zod`（选型依据是实测，不是口味：闭包 1 个包、0 运行时依赖、
 * 2.2M ops/s，而中继自己的帧速率上限是 500/s —— 见
 * `docs/legacy-spec/open-source-options.md` §A.5.1 与 §C）。
 *
 * 三个最容易出事的地方，钉在 schema 里而不是散落在各层：
 *
 * 1. **两个 `sessionId` 不是一回事**（F3）。中继帧外层的 `sessionId` 是配对通道 id
 *    （`c_xxx`）；载荷里的 `sessionId` 是 DSH 会话 id，且必须与 `sessions[].id` 同名同值。
 *    混淆它 = 聊天页把所有事件过滤掉，是本协议最贵的一类 bug。
 * 2. `ev.session_changed` 与 `ev.keep_awake_state` **不带** `sessionId`，将来也不许加
 *    （加了会被聊天页当作"别的会话"丢弃，F11）。
 * 3. `SessionSummary.updatedAt` 只能是 ISO-8601 字符串或不下发；给数字时间戳会让小程序
 *    整页渲染抛错，而那个异常被它的 `emit()` 吞掉，表现是"会话列表静默地不更新"（F7）。
 *    这条在**生产端**兜住：`isoOrUndefined()`（见文件末尾）——不要指望校验器替你决定
 *    "数字时间戳该不该发"。
 *
 * 一处刻意的宽松：未知字段被 zod 剥掉。载荷的**生产者是我们自己的 host**，
 * 消费者是手机；插件不会因为不认识某个字段而坏，所以剥未知字段只带来一个好处——
 * 不会把对端多塞的东西原样转发到手机上。
 */
import { z } from 'zod'

/** 会话状态枚举。拼错一个字符，手机端徽标会退化成"空闲"——归档会话因此看着像正常会话。 */
export const SESSION_STATES = [
  'idle',
  'running',
  'detached',
  'archived',
  'awaiting-permission',
  'awaiting-answer',
] as const

const nonEmpty = z.string().min(1)
const isoText = z.string()

const sessionSummary = z.object({
  /** 必填且稳定：小程序拿它做 `wx:key`、跳页参数、标题兜底。 */
  id: nonEmpty,
  state: z.enum(SESSION_STATES).optional(),
  running: z.boolean().optional(),
  title: z.string().optional(),
  workspace: z.string().optional(),
  /** 只接受 ISO 字符串。生产侧请用 `isoOrUndefined()`。 */
  updatedAt: isoText.optional(),
  createdAt: isoText.optional(),
  /** `'subagent'` 表示委派子会话；services carrier 会把这些行整体过滤掉。 */
  origin: z.string().optional(),
})

/** 会话摘要。 */
export type SessionSummary = z.infer<typeof sessionSummary>

export const evSessionChanged = z.object({
  t: z.literal('ev.session_changed'),
  /** **全量快照**，不是增量。会话列表的唯一数据源（F7/F8）。 */
  sessions: z.array(sessionSummary),
  reason: z.string().optional(),
})

export const evMessageDelta = z.object({
  t: z.literal('ev.message_delta'),
  sessionId: nonEmpty.optional(),
  /** 同一条助手消息内稳定且唯一；缺了它不同消息的文本会被拼成一段。 */
  messageId: nonEmpty,
  part: z.number().int().nonnegative().optional(),
  /** 可以为空串——空文本的 done 帧也必须照发（F9）。 */
  delta: z.string(),
  role: z.enum(['assistant', 'user', 'system']).optional(),
  done: z.boolean().optional(),
})

const choiceOption = z.object({ id: nonEmpty, label: nonEmpty })
/** 一个可选项；`id` 会被手机逐字回传，所以它必须是稳定的机器名。 */
export type ChoiceOption = z.infer<typeof choiceOption>

export const evToolEvent = z.object({
  t: z.literal('ev.tool_event'),
  sessionId: nonEmpty.optional(),
  /** 同一次调用稳定唯一：小程序用它原位更新同一行，缺了所有工具事件会挤成一行。 */
  callId: nonEmpty,
  tool: z.string().optional(),
  phase: z.enum(['started', 'args', 'completed', 'failed']),
  title: z.string().optional(),
  argsPreview: z.string().optional(),
  /** 只在 completed/failed 时被渲染，提前发不会显示。 */
  resultPreview: z.string().optional(),
})

export const evPermissionRequest = z.object({
  t: z.literal('ev.permission_request'),
  sessionId: nonEmpty.optional(),
  requestId: nonEmpty,
  action: z.string(),
  resource: z.string().optional(),
  reason: z.string().optional(),
  /** 缺省时小程序自造 `approve`/`reject` 两键；一旦下发，`id` 会被逐字回传。 */
  options: z.array(choiceOption).optional(),
  expiresAt: z.string().optional(),
})

const questionItem = z.object({
  id: nonEmpty,
  question: nonEmpty,
  multi: z.boolean().optional(),
  options: z.array(choiceOption).optional(),
})
/** 提问卡里的一道题；`id` 是回传时 `answers[].questionId` 的值。 */
export type QuestionItem = z.infer<typeof questionItem>

export const evQuestionRequest = z.object({
  t: z.literal('ev.question_request'),
  sessionId: nonEmpty.optional(),
  requestId: nonEmpty,
  questions: z.array(questionItem),
})

export const evRunState = z.object({
  t: z.literal('ev.run_state'),
  sessionId: nonEmpty.optional(),
  /** 只有这两个值会让手机收起挂着的审批/提问卡，所以类型收紧，不放第三种状态漏出去。 */
  state: z.enum(['running', 'idle']),
  detail: z.string().optional(),
})

export const evKeepAwakeState = z.object({
  t: z.literal('ev.keep_awake_state'),
  enabled: z.boolean(),
  active: z.boolean(),
  platform: nonEmpty,
  backend: nonEmpty,
  reason: z.string().optional(),
})

export const evResult = z.object({
  t: z.literal('ev.result'),
  cmdId: z.string(),
  ok: z.boolean(),
  message: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
})

/** evSessionChanged 的推导类型。 */
export type EvSessionChanged = z.infer<typeof evSessionChanged>
/** evMessageDelta 的推导类型。 */
export type EvMessageDelta = z.infer<typeof evMessageDelta>
/** evToolEvent 的推导类型。 */
export type EvToolEvent = z.infer<typeof evToolEvent>
/** evPermissionRequest 的推导类型。 */
export type EvPermissionRequest = z.infer<typeof evPermissionRequest>
/** evQuestionRequest 的推导类型。 */
export type EvQuestionRequest = z.infer<typeof evQuestionRequest>
/** evRunState 的推导类型。 */
export type EvRunState = z.infer<typeof evRunState>
/** evKeepAwakeState 的推导类型。 */
export type EvKeepAwakeState = z.infer<typeof evKeepAwakeState>
/** evResult 的推导类型。 */
export type EvResult = z.infer<typeof evResult>
/** cmdSendPrompt 的推导类型。 */
export type CmdSendPrompt = z.infer<typeof cmdSendPrompt>
/** cmdAnswer 的推导类型。 */
export type CmdAnswer = z.infer<typeof cmdAnswer>
/** cmdResolvePermission 的推导类型。 */
export type CmdResolvePermission = z.infer<typeof cmdResolvePermission>
/** cmdInterrupt 的推导类型。 */
export type CmdInterrupt = z.infer<typeof cmdInterrupt>
/** cmdListSessions 的推导类型。 */
export type CmdListSessions = z.infer<typeof cmdListSessions>
/** cmdKeepAwake 的推导类型。 */
export type CmdKeepAwake = z.infer<typeof cmdKeepAwake>

/**
 * 出站载荷（host → client）。小程序解密后按 `t` 分发，认不出的类型被**静默丢弃**，
 * 所以新增名字安全，改既有语义不安全。
 */
export const evPayload = z.discriminatedUnion('t', [
  evSessionChanged,
  evMessageDelta,
  evToolEvent,
  evPermissionRequest,
  evQuestionRequest,
  evRunState,
  evKeepAwakeState,
  evResult,
])
export type EvPayload = z.infer<typeof evPayload>

// ── 入站载荷（client → host）─────────────────────────────────────────

export const cmdSendPrompt = z.object({
  t: z.literal('cmd.send_prompt'),
  cmdId: nonEmpty,
  /** DSH 会话 id，不是配对通道 id。 */
  sessionId: nonEmpty,
  text: z.string(),
})

const answerItem = z.object({
  questionId: nonEmpty,
  selected: z.array(nonEmpty),
  /** 整卡共享的一个自由文本框，不是每题一个（取证 legacy-spec/mp-client-contract.md §2.3）。 */
  freeText: z.string().optional(),
})
/** 一道题的作答。 */
export type AnswerItem = z.infer<typeof answerItem>

export const cmdAnswer = z.object({
  t: z.literal('cmd.answer'),
  cmdId: nonEmpty,
  sessionId: nonEmpty,
  requestId: nonEmpty,
  answers: z.array(answerItem),
})

export const cmdResolvePermission = z.object({
  t: z.literal('cmd.resolve_permission'),
  cmdId: nonEmpty,
  sessionId: nonEmpty,
  requestId: nonEmpty,
  /** 主机下发哪个 `options[].id`，手机就回传哪个，逐字——所以不做枚举收紧。 */
  decision: nonEmpty,
  note: z.string().optional(),
})

export const cmdInterrupt = z.object({
  t: z.literal('cmd.interrupt'),
  cmdId: nonEmpty,
  sessionId: nonEmpty,
})

export const cmdListSessions = z.object({
  t: z.literal('cmd.list_sessions'),
  cmdId: nonEmpty,
})

export const cmdKeepAwake = z.object({
  t: z.literal('cmd.keep_awake'),
  cmdId: nonEmpty,
  enabled: z.boolean(),
  /** 单位秒；`0` = 保持到被显式关闭。关掉开关时小程序**不带**这个字段。 */
  idleReleaseSec: z.number().int().nonnegative().optional(),
})

/**
 * 手机发来的命令载荷，共 6 种——就是 `mp/core/client.js` 的便捷方法能产出的全部。
 *
 * 旧实现还有一个 `cmd.subscribe`：它的 handler 只回一个 `ev.result{ok:true}`，
 * `sessionIds`/`includeContent` 没有任何过滤效果，而小程序从不发它。
 * 本版不实现它（取证 legacy-spec/relay-and-wireformat.md §4.1 的"事实上的 no-op"）。
 */
export const cmdPayload = z.discriminatedUnion('t', [
  cmdSendPrompt,
  cmdAnswer,
  cmdResolvePermission,
  cmdInterrupt,
  cmdListSessions,
  cmdKeepAwake,
])
export type CmdPayload = z.infer<typeof cmdPayload>

/** 解析手机发来的命令；非法返回 null（调用方决定丢弃还是回 `ev.result{ok:false}`）。 */
export function parseCmdPayload(value: unknown): CmdPayload | null {
  const parsed = cmdPayload.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** 解析事件载荷（中继 e2e 审计与插件自测用）。 */
export function parseEvPayload(value: unknown): EvPayload | null {
  const parsed = evPayload.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** 载荷类型名常量（分发与测试断言用，避免各处手打字符串）。 */
export const PAYLOAD_TYPES = {
  cmdSendPrompt: 'cmd.send_prompt',
  cmdAnswer: 'cmd.answer',
  cmdResolvePermission: 'cmd.resolve_permission',
  cmdInterrupt: 'cmd.interrupt',
  cmdListSessions: 'cmd.list_sessions',
  cmdKeepAwake: 'cmd.keep_awake',
  evSessionChanged: 'ev.session_changed',
  evMessageDelta: 'ev.message_delta',
  evToolEvent: 'ev.tool_event',
  evPermissionRequest: 'ev.permission_request',
  evQuestionRequest: 'ev.question_request',
  evRunState: 'ev.run_state',
  evKeepAwakeState: 'ev.keep_awake_state',
  evResult: 'ev.result',
} as const

/**
 * 生产侧兜住 F7：只有能被 `Date.parse` 认出来的值才作为 ISO 字符串下发，
 * 否则**整个字段省略**（小程序把它当可选字段，缺省不显示时间角标）。
 *
 * 为什么不在校验器里管：校验器只管收到的东西对不对；而这里要防的是我们自己
 * 把内核给的**毫秒数**直接塞进去——那是一次"发得出去、对方静默坏掉"的错误。
 */
export function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    const iso = new Date(value).toISOString()
    return Number.isNaN(Date.parse(iso)) ? undefined : iso
  }
  return undefined
}
