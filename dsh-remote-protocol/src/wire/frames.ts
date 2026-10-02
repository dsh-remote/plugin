/**
 * frames — 控制面（明文）帧。
 *
 * 这些帧是**中继唯一读得懂的东西**：它按 `t` 与几个标识字段做路由，
 * `ciphertext` 对它是不透明字符串（结构性零知识，docs/DESIGN.md §5.2）。
 *
 * 帧名冻结（F1）：`hello` `hello-ok` `pair-begin` `pair-ready` `pair-begin-client`
 * `paired` `pair-fail` `peer-joined` `peer-left` `enc` `enc-batch` `ping` `pong` `error`。
 * 新增名字是安全的（小程序的 `_onFrame` 把不认识的 `t` 落进 `default` 静默忽略）；
 * **挪用既有名字的语义不是**——比如把心跳响应叫 `peer-left`，
 * 小程序会每收到一次就丢一次配对。
 *
 * 与旧实现的三处结构差异（都不影响小程序，取证 docs/DESIGN.md §4、§8）：
 *
 * - **D5：`auth`/`auth-ok`/`auth-fail` 三帧并成一条 `hello` 注册路径。**
 *   旧的中继里，host 用 `auth`、client 用 `hello` 做同一件事（登记身份、拿回权威 id），
 *   失败面一个是 `auth-fail{reason}` 一个是 `error{code}`。合并后 host 发
 *   `hello{role:'host', token}`，失败统一 `error{code:'bad_token'}`。
 *   小程序仍只发它那一套（F2 的三种帧一个字节都没动）。
 * - **D1：`pair-begin` 不再携带 `psk`。** PSK 只留在主机本地，中继内存里不再有密钥副本。
 * - 删掉两个从未被使用的声明：`session-list` 帧、`cmd.subscribe` 载荷
 *   （前者中继从未发送/处理，后者的 `sessionIds`/`includeContent` 没有任何效果）。
 */
import { z } from 'zod'

/** 协议版本。小程序恒发 `1`（F2）。 */
export const PROTOCOL_VERSION = 1

/** 6 位配对码。位数变了要同时动三处（中继校验、主机生成、小程序归一化），而小程序改不了。 */
export const PAIRING_TOKEN_RE = /^\d{6}$/

const nonEmpty = z.string().min(1)
const pairingToken = z.string().regex(PAIRING_TOKEN_RE)

/**
 * 密文记录的合法性预检。
 *
 * 为什么必须显式写：`Buffer.from(s,'base64')` 对非法字符是**静默丢弃并继续**，
 * 于是"手机能发、主机报错"这类假故障就没有落点。中继在转发前按标准表校验一次
 * （含 `+` `/` `=`，不含 url-safe 表），错的就直接 `bad_frame` 拒掉——
 * 这也是 D4 之外中继唯一会碰载荷内容的地方，而它碰的只是**字符集**，不是明文。
 */
export const base64Text = z
  .string()
  .min(1)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)

const clientMeta = z.object({
  platform: z.string().optional(),
  label: z.string().optional(),
})
/** 客户端自报的门面信息（小程序发 `{platform:'wechat-mp', label:'微信小程序'}`）。 */
export type ClientMeta = z.infer<typeof clientMeta>

// ── 端点 → 中继 ─────────────────────────────────────────────────────

/** host 与 client 共用这一条注册帧；`token` 只有 host 会带。 */
export const helloFrame = z.object({
  t: z.literal('hello'),
  role: z.enum(['host', 'client']),
  protocol: z.number().int().positive().optional(),
  /** host 的出站认证凭据，与中继的 `DRC_HOST_TOKEN` 定时安全比较。 */
  token: nonEmpty.optional(),
  hostId: nonEmpty.optional(),
  label: z.string().max(128).optional(),
  /** 安装 id，弱随机、非秘密；缺省时由中继分配。上限防一条超长字符串白占内存。 */
  clientId: z.string().min(1).max(128).optional(),
  clientMeta: clientMeta.optional(),
})

/** 主机发布一次性配对码。**没有 psk 字段**——这是 D1 的执行点。 */
export const pairBeginFrame = z.object({
  t: z.literal('pair-begin'),
  pairingToken,
  hostLabel: z.string().max(128).optional(),
})

/** 客户端认领配对码。小程序从不提交 PSK。 */
export const pairClaimFrame = z.object({
  t: z.literal('pair-begin-client'),
  pairingToken,
})

export const encFrame = z.object({
  t: z.literal('enc'),
  /** 配对通道 id（`c_xxx`），不是 DSH 会话 id（F3）。 */
  sessionId: nonEmpty,
  /** 元数据而已：不得校验单调（F13），host→client 方向由中继重新编号。 */
  seq: z.number().int().nonnegative().optional(),
  clientId: z.string().min(1).max(128).optional(),
  /**
   * 这里只要求"非空字符串"，**字符集合不合法由 `base64Text` 单独把关**。
   * 故意分两层：混在 schema 里，中继就没法区分"形状不对（unknown_frame）"与
   * "密文不是合法 base64（bad_frame）"，而这两个错误码对排错的价值完全不同。
   */
  ciphertext: z
    .string()
    .min(1)
    .max(512 * 1024),
})

export const encBatchFrame = z.object({
  t: z.literal('enc-batch'),
  /** 通道 id 只在外层；小程序逐项解密时复用它。 */
  sessionId: nonEmpty,
  items: z
    .array(
      z.object({
        seq: z.number().int().nonnegative().optional(),
        ciphertext: z
          .string()
          .min(1)
          .max(512 * 1024),
      }),
    )
    .min(1),
})

/** 显式退出某个会话（D3 之后会话会长存，需要一条主动退出的路）。 */
export const sessionLeaveFrame = z.object({
  t: z.literal('session-leave'),
  sessionId: nonEmpty,
})

export const pingFrame = z.object({ t: z.literal('ping'), ts: z.number().optional() })

/**
 * 主机声明"我此刻仍持有密钥的会话有哪些"。
 *
 * 为什么必须有这条（复核 R1）：D3/D6 让会话跨断连存活之后，出现了旧实现没有的
 * 死角——**主机进程重启**（PSK 随之消失）而中继不知道，于是它继续把手机发来的
 * 密文转发给一个解不开的主机；手机既收不到回复、也收不到 `unknown_session`，
 * 表现是"永远转圈且没有任何提示"。中继自己的表命中与否并不能代表主机是否还认得这个会话。
 *
 * 语义：主机鉴权成功后立刻发一条 `resync`，列出它还持有的 convId。
 * 中继把该主机名下**没被列出**的会话删掉，但**不**向客户端发 `peer-left`——
 * 那在小程序里会翻成一条英文 toast（没有映射），而是让客户端下一次用旧 convId
 * 发帧时自然撞上 `unknown_session`，从而得到中文的"会话已失效，请重新配对"。
 */
export const resyncFrame = z.object({
  t: z.literal('resync'),
  sessionIds: z.array(nonEmpty).max(2000),
})

// 刻意不提供"逐条确认会话还在"的帧：resync 一次就够，
// 多一个入口只会多一类"两条路说法不一致"的故障。

/** 端点可能发给中继的一切。 */
export const endpointFrame = z.discriminatedUnion('t', [
  helloFrame,
  pairBeginFrame,
  pairClaimFrame,
  resyncFrame,

  encFrame,
  encBatchFrame,
  sessionLeaveFrame,
  pingFrame,
])
export type EndpointFrame = z.infer<typeof endpointFrame>

// ── 中继 → 端点 ─────────────────────────────────────────────────────

export const helloOkFrame = z.object({
  t: z.literal('hello-ok'),
  role: z.enum(['host', 'client']),
  /** 权威 clientId：小程序会采纳它并覆盖本地安装 id（F2/§3.6）。 */
  clientId: z.string().min(1).max(128).optional(),
  hostId: nonEmpty.optional(),
  protocol: z.number().int().positive().optional(),
})

/** 服务端权威 TTL。**主机必须据此改写本地过期时间**——这是旧实现的第一起事故。 */
export const pairReadyFrame = z.object({
  t: z.literal('pair-ready'),
  pairingToken,
  ttlMs: z.number().int().positive(),
})

export const pairedFrame = z.object({
  t: z.literal('paired'),
  /** 小程序把它当 convId 持久化并参与密钥派生：缺了它后面全部解不开（F4/F6）。 */
  sessionId: nonEmpty,
  hostId: nonEmpty,
})

/** 四个 reason 是 UI 分支条件，小程序有逐字的中文映射表（F6）。 */
// reason 的取值集合是**冻结消费面**的一部分（F6）：小程序 `mp/core/client.js:translatePairFail`
// 只认这五个键，多一个就把英文字面量弹到用户脸上。中继侧内部原因（rate_limited 之类）
// 要记进日志，落到线上的 reason 必须是这张表里的一个。
export const pairFailFrame = z.object({
  t: z.literal('pair-fail'),
  reason: z.enum(['invalid_or_expired', 'already_used', 'host_offline', 'bad_token']),
})

export const peerJoinedFrame = z.object({
  t: z.literal('peer-joined'),
  sessionId: nonEmpty,
  clientId: nonEmpty.optional(),
  /** 发给主机的那一份**必须**带：主机按它取对应的 PSK（多码并存那起事故的根因）。 */
  pairingToken: pairingToken.optional(),
})

/** 对客户端而言，`peer-left` 只有一个合法触发：**主机离开**（D3 把这条写死）。 */
export const peerLeftFrame = z.object({
  t: z.literal('peer-left'),
  sessionId: nonEmpty,
  clientId: nonEmpty,
})

export const errorCodes = [
  'bad_role',
  'bad_token',
  'need_host',
  'need_client',
  'bad_pair',
  'pair_table_full',
  /** 客户端靠这个字面量决定"清配对并提示重扫"（F5）。 */
  'unknown_session',
  /** D4：发送方不是该会话成员。 */
  'not_member',
  /**
   * 会话还在，但主机此刻不在（宽限期内）。**必须区别于 `unknown_session`**：
   * 客户端见到 `unknown_session` 会丢掉配对并要求重新扫码，而这里只是"这条指令没人接"，
   * 用户重试即可，配对关系不该因此作废（D3/D6）。
   */
  'host_unavailable',
  'bad_frame',
  'rate_limited',
  'bad_json',
  'unknown_frame',
  'internal',
] as const

export const errorFrame = z.object({
  t: z.literal('error'),
  code: z.enum(errorCodes),
  message: z.string().max(512).optional(),
})
export type ErrorCode = z.infer<typeof errorFrame>['code']

export const pongFrame = z.object({ t: z.literal('pong'), ts: z.number().optional() })

/** 中继可能发给端点的一切。 */
export const relayFrame = z.discriminatedUnion('t', [
  helloOkFrame,
  pairReadyFrame,
  pairedFrame,
  pairFailFrame,
  peerJoinedFrame,
  peerLeftFrame,
  errorFrame,
  pongFrame,
  encFrame,
  encBatchFrame,
])
export type RelayFrame = z.infer<typeof relayFrame>

// ── 解析与构造 ──────────────────────────────────────────────────────

/** 中继解析端点来帧。`t` 认不出 → null（调用方回 `unknown_frame`）。 */
export function parseEndpointFrame(value: unknown): EndpointFrame | null {
  const parsed = endpointFrame.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** 端点（主机或小程序）解析中继来帧。 */
export function parseRelayFrame(value: unknown): RelayFrame | null {
  const parsed = relayFrame.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** JSON 文本 → 对象 → 中继来帧；任何一步失败都 null（小程序侧同样静默丢弃非法帧）。 */
export function parseRelayFrameText(raw: string): RelayFrame | null {
  try {
    return parseRelayFrame(JSON.parse(raw))
  } catch {
    return null
  }
}

/** JSON 文本 → 对象 → 端点来帧。 */
export function parseEndpointFrameText(raw: string): EndpointFrame | null {
  try {
    return parseEndpointFrame(JSON.parse(raw))
  } catch {
    return null
  }
}

export function makeEncFrame(
  sessionId: string,
  ciphertext: string,
  extra: { seq?: number; clientId?: string } = {},
): z.infer<typeof encFrame> {
  return { t: 'enc', sessionId, ciphertext, ...extra }
}

export function makeEncBatchFrame(
  sessionId: string,
  items: Array<{ ciphertext: string; seq?: number }>,
): z.infer<typeof encBatchFrame> {
  return { t: 'enc-batch', sessionId, items }
}

export function makeErrorFrame(code: ErrorCode, message?: string): z.infer<typeof errorFrame> {
  return { t: 'error', code, ...(message ? { message } : {}) }
}

/** 是否一条数据面帧（中继的转发路径要绕开完整 schema 校验的热路径判断）。 */
export function isEncFrame(frame: { t: string }): boolean {
  return frame.t === 'enc' || frame.t === 'enc-batch'
}
