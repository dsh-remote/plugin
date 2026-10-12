/**
 * runtime — HostRuntime：内核事件 → 手机载荷，以及手机命令 → 内核调用。
 *
 * 这一层**不认识 cordis**，也不认识 socket：它只通过 `KernelPort` 与
 * `RuntimeTransport` 说话，所以审批闭环、归档恢复、合帧顺序这些真正难验证的行为
 * 都能在纯内存里测出来（旧实现做不到，它的测试全靠手写 cordis 替身）。
 *
 * 四条必须在这里守住的协议义务（编号对应 docs/DESIGN.md §2）：
 *
 * - **F8 列表推送义务**：会话列表的唯一数据源是 `ev.session_changed`，
 *   `ev.result.data.sessions` 手机**不看**。所以每次 `cmd.list_sessions`、
 *   以及任何会改变会话状态的动作之后，都必须**额外推一条 session_changed**。
 * - **F9 done 帧不可丢**：文本收尾由 `DeltaWindow` 负责，本层只保证
 *   "非 delta 事件之前先 flush 同会话缓冲"，否则工具行会插到它自己的文本前面。
 * - **F10 decision 逐字**：手机端回传的是我们下发的 `options[].id`，
 *   所以这里的选项 id 必须是**稳定机器名**，且 `'reject'` 这个词不能改——
 *   小程序用它判断"拒绝之后界面该不该继续显示运行中"。
 * - **F11 两个无会话归属的载荷**：`ev.session_changed` / `ev.keep_awake_state`
 *   由 `outbound.ts` 的构造器产出，参数表里就没有 sessionId。
 */
import { randomUUID } from 'node:crypto'
import { isKnownPayloadType } from '@dsh-remote/protocol'
import type {
  AnswerItem,
  CmdPayload,
  EvPayload,
  FileAttachment,
  HistoryItem,
  ImageAttachment,
  QuestionItem,
  SessionSummary,
} from '@dsh-remote/protocol'
import { appendFileNote, MAX_ATTACH_TOTAL_BYTES, saveFileAttachments } from '../shell/uploads.js'
import { APPROVAL_OPTIONS as APPROVAL_OPTIONS_ZH } from '../copy/zh.js'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_FILE_ATTACHMENTS,
  MAX_IMAGE_ATTACHMENTS,
  MAX_TEXT_CHARS,
} from '@dsh-remote/protocol/limits'
import { detectBackend } from '@dsh-remote/protocol/sleep'
import { IdempotencyLedger } from '@dsh-remote/protocol/idempotency'
import {
  hostInfo,
  keepAwakeState,
  messageDelta,
  model,
  permissionRequest,
  permissionResolved,
  questionRequest,
  questionResolved,
  result as resultOf,
  runState,
  sessionChanged,
  sessionHistory,
  todoList,
  retryNotice,
  compactionNotice,
  toolEvent,
} from '@dsh-remote/protocol/outbound'
import type { EvHostInfo } from '@dsh-remote/protocol'
import { imageAttachmentsSupported } from './capabilities.js'
import type {
  ApprovalDecision,
  ApprovalOutcomeValue,
  AskUserQuestionAnswerValue,
  KernelEvent,
  KernelPort,
} from '../ports/index.js'
import { HISTORY_WINDOW_EXCEEDED } from '../ports/index.js'
import { DeltaWindow, DEFAULT_WINDOW_OPTIONS, type WindowOptions } from './window.js'
import type { KeepAwake } from './sleep-policy.js'
import type { Clock } from '../ports/index.js'

/** 出站通道：core 只负责"该发什么"，加密与投递由 shell 提供。 */
export interface RuntimeTransport {
  /** 发给某一条配对会话（回执用）。返回 false 表示没有活的对端。 */
  reply(conversationId: string, payload: EvPayload): boolean
  /** 发给所有已配对的会话（会话列表、防休眠状态这类广播）。返回**收到这条广播的会话数**，0 表示没发出去。 */
  broadcast(payload: EvPayload): number
  /** 此刻是否有能收这条会话消息的对端（审批要不要认领的判据）。 */
  hasClient(conversationId: string): boolean
  /** 当前活跃的配对会话 id。 */
  conversationIds(): string[]
}

export interface RuntimeOptions {
  /** 会话列表的全量刷新周期。事件驱动之外还要有一条兜底，因为旧实现断连期间会丢事件。 */
  listingRefreshMs: number
  window?: Partial<WindowOptions>
  /**
   * ⚠️ 这里**曾经**有 `approvalTimeoutMs` / `questionTimeoutMs` 两个上限，
   * 2026-10-11 连同它们在 `onApprovalRequest` / `onQuestionRequest` 里的定时器一起删了
   * （期限改成跟随弹窗自身生命周期，理由见那两处的注）。
   * 留这段注释是为了让下一个人知道"为什么这里空着"——别当成漏删又加回来。
   */
  /** 发指令前自动恢复归档会话。关掉它就要接受"归档会话被宿主 gate 直接拒掉"。 */
  unarchiveOnPrompt: boolean
  /** 文件附件落盘目录（`shell/uploads.ts`）；空串时主机拒收文件附件。 */
  uploadDir: string
  maxFileBytes: number
  /**
   * `ev.host_info.host` 的来源（规范 §13.2）。
   *
   * 为什么是注入而不是 core 自己去读 `process.platform`：这样单测能给一个确定的平台，
   * 从而让 `state.sleep` 的推导（`detectBackend`）可以被钉住 —— 否则判据会随 CI 机器变。
   * 缺省值见 `DEFAULTS`。
   */
  hostMeta?: () => Pick<EvHostInfo['host'], 'platform' | 'arch'> &
    Partial<Pick<EvHostInfo['host'], 'profile' | 'dshVersion'>>
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
}

/**
 * 这次等待是**被谁**收的场。只有不是手机收的场才需要给 `settle()` 传它——
 * 一传就意味着手机上那张卡在本侧已经作废，得当场把它收掉（见 `voidStaleCard`）。
 */
type VoidReason = 'desktop' | 'withdrawn' | 'timeout'

interface PendingInteraction {
  conversationId: string
  sessionId: string
  resolve: (value: unknown) => void
  /**
   * 一次性定时器句柄。
   *
   * ⚠️ 2026-10-11 起**审批与提问都不再设它**（期限改成跟随弹窗自身生命周期，见
   * `onApprovalRequest` 那段注）。字段保留为可选，是因为它仍属于账本形状的一部分，
   * 而 `settle()` 统一清它 —— 将来若某个宿主真的带了期限，加回来只需要一处。
   */
  timer?: unknown
  /**
   * 到期时刻**只在宿主给了期限时才有**（2026-10-11）。它是可选的：缺省即"无期限"，
   * 而这正是这一代内核的样子。`replayPending` 原样重发它、不重算 —— 顺延等于骗手机。
   */
  expiresAt?: string
  /** 审批/提问各自的选项表，用于把手机回传的 id 翻回平台要的词汇。 */
  options?: QuestionItem[]
  /** 哪一类等待。桌面那颗 pill 的抬头要说"等 N 件事"，两类都算。 */
  kind: 'approval' | 'question'
  /** 发出去的时刻（`clock.now()`），用来算"最久的那件已经等了多久"。 */
  askedAt: number
  /** 审批重发要原样带回去的动作与原因（提问那类存在 `options` 里）。 */
  action?: string
  reason?: string
}

// 文案与 `id` 都来自共享表（`copy/zh-cn.json`，V3-PLAN §7 阶段 F2）。
// ⚠️ 这里曾经是三个写死的中文字面量，而小程序演示数据里另有一份 —— 改一处就漂。
// ⚠️ `id` 是手机端的行为分支条件，不能改（F10）；`label` 是给用户看的字，两端必须逐字相同。
// ⚠️ scope 说明**没有删掉**，只是换了一行承载 —— 小程序那张卡在按钮下面渲染
// 「「始终允许」仅限本次会话内的同类操作，会话结束即失效」（`APPROVAL_SCOPE_HINT`）。
// 所以宿主这里只写「始终允许」；**别的客户端接这张卡时，有义务自己把那半句边界补出来。**
//
// ⚠️ 那一层 `.map` 不是装饰：共享表是 `readonly` 的，而载荷类型要的是可变的
// `{id,label}[]`。这里做**一次**浅拷贝（全进程一个实例，没有任何地方改它），
// 好过为了省一次 map 去改协议的类型 —— 载荷可变性是协议层的既有约定，不该被文案表带偏。
const APPROVAL_OPTIONS = APPROVAL_OPTIONS_ZH.map((option) => ({ ...option }))

/**
 * 「本次会话内始终允许」的记表键：`会话 id + 审批类别`。
 *
 * ## 为什么键里带**类别**而不是只有会话
 *
 * 「始终允许」必须限定在**一类动作**上。若只按会话记，那么用户批准过一次
 * `Bash` 之后，同一会话里 `Write` 之类的其它工具也会被放行——而他批准的是那一类。
 *
 * ## 类别取 `info.action`（宿主给的稳定机器名）
 *
 * 不取 `reason`（人话、会变），也不取工具的完整命令行（那就变成逐条授权了，
 * 等于没有"始终"）。`action` 是宿主给的**类别**，粒度正好。
 */
const approvalScopeOf = (sessionId: string | undefined, action: string | undefined): string =>
  // ⚠️ 分隔符必须写成 `\u0000` 转义，不要写成字面 NUL 字节。
  // 字面 NUL 会让 git 与 ripgrep 把整个文件当成二进制：`git diff` 看不到改动、
  // `git grep` 搜不到这个文件里的函数 —— 改一个函数会漏掉全部调用点。
  // 转义写法与字面写法行为逐字节相同。
  `${sessionId ?? ''}\u0000${action ?? ''}`

/** `ev.host_info.host` 的缺省来源：如实读本进程的平台。抽成命名函数是为了能被 `??` 回退到。 */
const defaultHostMeta = (): EvHostInfo['host'] => ({ platform: process.platform, arch: process.arch })

const DEFAULTS: RuntimeOptions = {
  listingRefreshMs: 15_000,
  unarchiveOnPrompt: true,
  /**
   * 附件落盘目录。**留空 = 拒收文件附件**（下面那条 `reply(false, …)` 就是这条分支）。
   *
   * 为什么这里是留空而不是给个默认路径：这是纯构造器的默认值，直接 new 出来的实例
   * （单测、将来的别的载具）不该自动往用户磁盘写文件。
   *
   * ⚠️ 但**生产路径上它永远非空**：`index.ts` 传的是 `resolveUploadDir(config)`，
   * 而那个函数把 `''` 解析成 `status.json` 同目录的 `uploads/`（理由写在它自己文件头）。
   * 所以"默认不收"只对**直接构造**成立，线上主机是收文件附件的——别照着这条注释
   * 去判断线上行为，也别把 `index.ts` 那个解析去掉（去掉就真的会静默拒收一切附件）。
   */
  uploadDir: '',
  maxFileBytes: MAX_ATTACHMENT_BYTES,
  hostMeta: defaultHostMeta,
}

/** 一次列表最多给手机多少条会话（与中继侧的会话上限同源，取证 §5.3）。 */
const LISTING_LIMIT = 100
/** 一次历史翻页默认给多少条（协议上界 200，这里更保守：一帧要装得下）。 */
const HISTORY_LIMIT = 40
/** 相邻两条 `ev.session_changed` 的最小间隔；小于它就改成尾随推送。 */
/** 每会话模型缓存的容量上限。与 voided/pairing slots 同一套有界纪律。 */
const MODEL_CACHE_MAX = 256

const SESSION_MERGE_MS = 500

/**
 * 宿主给的期限，**取一下并夹一下**。
 *
 * ⚠️ 只认「有限且 > 0」：宿主传 `undefined`（这一代内核就是这样）、`NaN`、`0`
 * 或负数，一律当**没有期限**。
 *
 * 为什么不夹回某个默认值（那正是 2026-10-11 删掉的东西）：默认值得有一个，
 * 就会让"宿主其实没给期限"这件事**看起来像有期限** —— 手机上会起倒计时，
 * 到点主机就结算，而桌面上那张对话框还在等。
 */
function hostTimeoutMs(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export class HostRuntime {
  private readonly options: RuntimeOptions
  private readonly window: DeltaWindow

  private readonly pending = new Map<string, PendingInteraction>()

  /**
   * 「本次会话内始终允许」的记表：`会话 + 审批类别 → 'allowed-once'`。
   *
   * ## 它为什么在内存里、且随 `stop()` 清空
   *
   * V3-PLAN §9.1 拍板：scope 是**本次会话内**，不是"这一类工具永久"也不是全局。
   * 于是它必须满足两条：① 不落盘（落盘就变成"永久"了，而永久授权的语义与风险
   * 都比这一项大得多）；② 生命周期与既有的 `pending` 表一致（`stop()` 清空）。
   *
   * ## 它不进 `status.json`
   *
   * 它是**决策台账**，不是诊断面。放进去会让一个"用户做过什么决定"变成
   * 一份可被外部脚本读到的记录——而那与"授权只在本会话有效"这件事的
   * **前提**（出了这个进程就失效）直接矛盾。
   *
   * 但它**要有计数**（`alwaysAllowedHits`）：否则"为什么这次没弹审批"
   * 在排错时无迹可寻——与既有那四个 `approval*` 字段同一条理由。
   */
  private readonly sessionAllowed = new Map<string, ApprovalOutcomeValue>()

  /**
   * 「本次会话内始终允许」命中过几次（上面那段注释里承诺的 `alwaysAllowedHits`，
   * 2026-10-09 补上——**它在那条注释写下的当天就是缺的**，而今天用户报的
   * 「审批窗卡着、手机没有弹窗」正好落在这一格：命中时**刻意一帧都不发**，
   * 而界面上「为什么这次没弹」过去无迹可寻）。
   *
   * ⚠️ 它归 runtime 而不是 `carrier-services` 的 `faces`：那条判定
   * （`approvalScopeOf` 查表）就在这一层，而 `faces` 数的是**参与器**收到过几次。
   * 两边都数"参与"，混在一起就会有人以为它们该相等。
   */
  private sessionAllowedHits = 0

  /**
   * 这台主机**此刻**对手机宣告的附件限额（`ev.host_info.limits` 里那两条）。
   *
   * ⚠️ 抽成方法而不是就地算：`diagnostics.attachmentLimits` 要报**同一个值**
   * （2026-10-10 补）。理由是一整晚反复出现的那条纪律 ——
   * 一个决定如果没有读数，用户报"发不了图"时 doctor 就只能回去读代码：
   * 分不清"主机报的是 0（手机拦得对）"还是"报的是 4（那才是手机/链路的锅）"。
   *
   * ⚠️ 做成方法而不是构造时常量：`this.kernel` 是后到的（端口在 `ctx.inject` 里才有），
   * 与 `imageFace` 那条注释同一个理由。
   */
  attachmentLimits(): { maxImageAttachments: number; maxFileAttachments: number } {
    return {
      maxImageAttachments: imageAttachmentsSupported(this.kernel) === 'no' ? 0 : MAX_IMAGE_ATTACHMENTS,
      maxFileAttachments: this.options.uploadDir ? MAX_FILE_ATTACHMENTS : 0,
    }
  }

  /**
   * 附件限额的现场读数（`diagnostics.attachmentLimits`）。
   *
   * 与 `alwaysAllowedHits` 同一条纪律：**每个新字段都要有谁读它**，
   * 读者是 `scripts/host-doctor.mjs` 与 `docs/HOST-SIDE.md` §5。
   */
  get attachmentLimitsForDiagnostics(): { images: number; files: number } {
    const limits = this.attachmentLimits()
    return { images: limits.maxImageAttachments, files: limits.maxFileAttachments }
  }

  get alwaysAllowedHits(): number {
    return this.sessionAllowedHits
  }

  /**
   * **发帧之前就被判掉**的次数，按理由分开（2026-10-09 用户报「审批窗/提问窗卡着、
   * 手机没有弹窗」时补）。
   *
   * ## 为什么这一格是上一轮那批计数里最大的缺口
   *
   * 现场读数：`approvalCalls = 10` 而 `outbound.permission_request = 2`；
   * `questionsCalls = 1` 而 `outbound` 里**连 `question_request` 这个键都没有**
   * ——**提问帧一次都没发出去过**。而参与器那侧的三条分流（held / no-target / no-answerer）
   * 解释不了它：卡确实被 `participate` 交到了 sink 上（`questionsSignalHandoff = fused`），
   * 是在**这一层**、在 `replyTo` 之前就被判掉的。
   *
   * | 键 | 判掉它的语句 | 是不是缺陷 |
   * |---|---|---|
   * | `noClient` | `!conversationId \|\| !transport.hasClient(...)` ⇒ `return 'decline' / null` | **要查**：其它事件发得出去、这里发不出去，就是它 |
   * | `aborted` | `info.signal?.aborted` ⇒ 一张卡都不发，整条交还桌面 | **多半不是缺陷**：平台自己撤回了这次请求（回合被取消 / 超时），发出去就是一张点不动的死卡 |
   *
   * ⚠️ 这两条**必须分开数**：上一条可能是 bug，第二条是正确行为。
   * 混成一个"被拒 N 次"，就等于把"该修的"和"不该修的"捆在一起 ——
   * 而它们要的处置完全不同（前者要改代码，后者什么都不要改）。
   */
  private readonly interactionDeclines = { noClient: 0, offlineHold: 0, aborted: 0 }

  get declined(): { noClient: number; offlineHold: number; aborted: number } {
    return { ...this.interactionDeclines }
  }
  /**
   * 手机上**此刻有清单**的会话（`todo/write` 发过非空清单、且还没被下一轮清掉）。
   *
   * 用来在下一轮开始时补一帧空快照。刻意用有界 Set 记、不留内容：它只回答
   * "要不要清"，不回答"清成什么"（清成空是唯一答案）。
   * 按会话隔离：同一时刻可能有几条会话各自带着清单。
   */
  private unsubscribe: (() => void) | undefined
  private detachSink: (() => void) | undefined
  private refreshTimer: unknown
  /** 被合并掉的那次推送：定时器 + 最后一次触发它的原因。 */
  private mergeTimer: unknown
  private mergePendingReason = 'merged'
  private sessions: SessionSummary[] = []
  /**
   * 每条会话**内核真实上报过**的模型（2026-10-06 补）。
   *
   * 为什么需要它：模型的数据源是内核 `request/header`，而它**每轮一条**——
   * 空闲会话永远不发。所以打开一条跑完的会话时，mp 的 `modelName` 从 `''` 起算、
   * 顶栏 `wx:if="{{modelName}}"` 空则不渲染，用户看到的现象是"当前模型不见了"。
   *
   * **不是**退回读宿主全局的 `agentDefaultModel.currentSelection()`：那是"新建
   * 会话用哪个"，用户在别的会话切一次模型，本会话的显示就跟着变——2026-10-05
   * 用户实测到的串台（space-bunny-free 显示成 muse-spark）就是它。
   * 这里只缓存内核**为这条会话**报过的值，所以补发的是真的，且不会串台。
   *
   * 内存有界靠**容量上限**（`rememberModel` 的 MODEL_CACHE_MAX），
   * **刻意不按会话列表裁剪**：列表是 LIMIT 截断的，一条跑过模型的会话掉出前 100
   * 就被删的话，"打开一条旧会话模型是空的"会换个原因复发（理由见 `rememberModel`）。
   * 代价是缓存里可能留着已不在列表里的会话，所以 `replayModels` 补发前自己求交。
   */
  private readonly modelBySession = new Map<string, { model: string; provider?: string }>()
  /**
   * `cmdId` 去重台账（规范 §10.2 / GAP-4，2026-10-07 接线）。
   *
   * ## 它解决的是一个已经存在的故障
   *
   * 手机 12 秒收不到回执就报超时并允许重发（`COMMAND_TIMEOUT_MS`），断线重连后
   * 也会补发。而主机此前**零去重**，于是同一条命令可能执行两次：
   * `cmd.send_prompt` 两次 → 用户说一遍、模型回两遍；`cmd.resolve_permission` 两次 →
   * 第二次落在一个已关闭的请求上，表现为"点了没反应"，且与真正的失败无法区分。
   *
   * 它**随机**：快网络下几乎不复现，慢网络或切后台时必现 —— 于是排错时永远
   * 找不到"那次重复发送"是谁发起的。
   *
   * ## 为什么用协议层那个纯函数而不是自己写一个
   *
   * 判定必须与协议层一致（那是载荷契约），而它把时钟从外面注入 ⇒ 判据能用
   * 假时钟把窗口边界一格格走一遍，不必真等五分钟（凡是"要靠真实等待才能测"的
   * 东西实际上都不会被测）。时钟就用本类已有的 `this.clock`。
   *
   * ## 它不是安全边界
   *
   * 去重是**幂等性**，不是防重放：真正的防重放依赖密封记录的 Poly1305 与通道成员
   * 校验。台账在内存里，主机重启即清空 —— 而主机重启本来就会作废全部会话
   * （`resync{[]}`），所以这条边界恰好与安全边界重合。
   */
  private readonly ledger = new IdempotencyLedger()
  /**
   * 已执行过的命令的**回执**，供重发时原样重放（规范 §10.2 要求 "MUST 重发上一次
   * 那个 `ev.result`"）。
   *
   * ⚠️ 为什么单独一张表而不是让台账存：协议的 `IdempotencyLedger` 只存时刻
   * （`admit()` 返回 `firstSeenAt`），它**刻意**不存载荷 —— 那是载荷层不该管的事。
   * 而没有这张表，重发只能"跳过执行并回一句新的"，那与规范要求的"重发上一次那个
   * 回执"不同：手机上 `ev.result` 是按 `cmdId` 结算的（`client.js` 的 `_cmdWaiters`），
   * 回一句新的 `ok:true` 会让**超时重发的那个 Promise 正常 resolve** —— 而实际上
   * 那条命令可能根本没执行成功。这条差异对用户不可见，对判据可见。
   *
   * 容量与台账同源（同一个 `IDEMPOTENCY_CAPACITY`）：两张表同生共死，不给
   * "台账清了这张还在"留机会。
   */
  private readonly settledReplies = new Map<string, EvPayload>()
  private started = false
  private stopped = false
  private lastPushAt = 0

  constructor(
    private readonly kernel: KernelPort,
    private readonly transport: RuntimeTransport,
    private readonly sleep: KeepAwake,
    private readonly clock: Clock,
    options: Partial<RuntimeOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options }
    this.window = new DeltaWindow((delta) => this.broadcast(delta), this.clock, {
      ...DEFAULT_WINDOW_OPTIONS,
      ...options.window,
    })
  }

  /** 挂接内核。任何一步失败都只降级，不抛（外层 apply() 的红线）。 */
  start(): void {
    if (this.started) return
    /**
     * **两步都成功之后才置 `started`**（2026-10-06）。
     *
     * 原来 `started = true` 在第一步之前，`attachInteractionSink` 又在这段 try 之外：
     * 它一抛，这条 runtime 就"半启动且不可重试"——`start()` 下次直接 return，
     * 表现是手机上永远没有审批/提问卡，而 status.json 里 carrier 一切正常。
     * 订阅上了而 sink 抛出的那一档要把订阅退掉再返回，否则下一次 start() 会叠出两份订阅。
     */
    try {
      this.unsubscribe = this.kernel.subscribe((event) => this.onKernelEvent(event))
    } catch (error) {
      this.log('kernel subscribe failed', { message: messageOf(error) })
      return
    }
    try {
      const detach = this.kernel.attachInteractionSink?.({
        approval: (info) => this.onApprovalRequest(info),
        question: (info) => this.onQuestionRequest(info),
      })
      if (detach) this.detachSink = detach
    } catch (error) {
      this.log('kernel attach failed, will retry on the next start', { message: messageOf(error) })
      try {
        this.unsubscribe?.()
      } catch {
        /* 退订是尽力而为 */
      }
      this.unsubscribe = undefined
      return
    }
    this.started = true
    void this.pushSessions('start').catch(() => {})
    this.refreshTimer = this.clock.setTimeout(() => this.refreshLoop(), this.options.listingRefreshMs)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.window.stop()
    try {
      this.unsubscribe?.()
    } catch {
      /* 退订失败无所谓，进程要走了 */
    }
    this.detachSink?.()
    if (this.refreshTimer !== undefined) this.clock.clearTimeout(this.refreshTimer)
    if (this.mergeTimer !== undefined) {
      this.clock.clearTimeout(this.mergeTimer)
      this.mergeTimer = undefined
    }
    // 停机时**必须带 voidAs**：这一帧是手机上那张卡唯一的收场信号。停机顺序是
    // `runtime.stop()` → `relay.stop()`（见 index.ts），此刻通道还活着，发得出去；
    // 不带的话（原来就是这样）卡片一直亮到 TTL 走完，用户对着一个没人处理的审批干等。
    for (const [id] of [...this.pending]) this.settle(id, undefined, 'withdrawn')
    // 「本次会话内始终允许」的记表与 pending 同生命周期：出了这个进程就失效。
    // 不清的话，下一次 `apply()` 复用同一个 runtime 实例时会把上一段会话的授权带过来
    //——而那正是这个功能**承诺不做**的事（§9.1：scope 是本次会话内）。
    this.sessionAllowed.clear()
  }

  /**
   * 让 `settledReplies` 与台账**同生共死**。
   *
   * 为什么需要它：台账自己按窗口 + 容量淘汰，而这张表没有 —— 不管的话它会无界增长，
   * 而"每条命令留一个回执"在长会话里就是每条消息一份（`send_prompt` 的回执还带
   * `data`）。**这正是协议层那张表刻意不存载荷的原因**：载荷级的记忆必须由使用方
   * 自己按同样的边界管。
   *
   * ## 2026-10-07 修：原来这里**根本没在淘汰其余的条目**
   *
   * 原实现是 `if (!this.ledger.has(cmdId, now)) this.settledReplies.delete(cmdId)`
   * —— 登记完**那一条**之后顺手问一次台账还在不在。而 `ledger.has()` 里的
   * `prune()` 只对台账自己的 entries 生效：它删的是**台账**的键，
   * `settledReplies` 里其余的键从此再没有任何代码碰过。
   *
   * 实测：900 条命令后台账 256 条、回执表 900 条。而每条 `cmd.list_sessions`
   * 的回执带 `data.sessions`（最多 100 条会话摘要）——长跑进程（GUI 宿主本来就长驻）
   * 持续涨内存，且**没有任何一行日志**说这件事。
   *
   * 现在改成向台账要"我淘汰了谁"（`takeEvicted`）：那是**唯一**知道淘汰了谁的
   * 地方，而遍历全表对齐是 O(n) 每条命令 —— n 正是要解决的问题。
   */
  private forgetEvicted(): void {
    for (const cmdId of this.ledger.takeEvicted()) this.settledReplies.delete(cmdId)
  }

  /** 手机发来的命令。`conversationId` 是配对通道 id，与载荷里的 sessionId 不是一回事（F3）。 */
  async handleCommand(cmd: CmdPayload, conversationId: string): Promise<void> {
    // ── `cmdId` 去重（规范 §10.2）─────────────────────────────────────
    //
    // 放在 `handleCommand` 的**最前面**，因为这是命令的唯一入口（放里面某几个
    // case 就会漏，而漏掉的那几条正是最不能重复执行的：`send_prompt`）。
    //
    // 三条纪律（每条都对应一种"看起来能跑、实际不行"）：
    // ① `admit()` 是**问 + 记账**合一（协议层刻意不拆成 has/add：拆开的话进程
    //    在两者之间退出就会执行两次 —— 而那正是本模块要防的事）；
    // ② 重发时**重放上一次的回执**，不是回一句新的（见 `settledReplies` 的注释）；
    // ③ 只有"确实回过执"的命令才进 `settledReplies` —— 异常路径（`catch` 里的
    //    `internal`）也回执，所以同样要记，否则重发会既不执行也不回执，
    //    手机那头 12 秒超时后又变成"什么都没有"。
    const now = this.clock.now()
    const decision = this.ledger.admit(cmd.cmdId, now)
    if (decision.action === 'replay') {
      const previous = this.settledReplies.get(cmd.cmdId)
      // 有上一份回执就原样重放；没有（进程中途重启、或那一帧还没来得及记）就
      // **明确回一句"已执行过、但回执丢了"** —— 绝不能静默：手机在等一个
      // `cmdId` 对应的回执，不回它就一直转到超时。
      this.replyTo(
        conversationId,
        previous ?? resultOf(cmd.cmdId, true, { message: '这条指令上一轮已执行过，但回执已不在（主机重启过）' }),
      )
      return
    }
    const reply = (ok: boolean, extras: { message?: string; data?: Record<string, unknown> } = {}): void => {
      const frame = resultOf(cmd.cmdId, ok, extras)
      this.settledReplies.set(cmd.cmdId, frame)
      // 顺序要紧：先登记这条，再问台账淘汰了谁 —— 反过来的话，
      // 这一次 admit 造成的容量淘汰（把**别人**挤出去）会漏掉。
      this.forgetEvicted()
      this.replyTo(conversationId, frame)
    }
    try {
      switch (cmd.t) {
        case 'cmd.list_sessions': {
          const sessions = await this.pushSessions('list')
          reply(true, { data: { sessions } })
          return
        }
        case 'cmd.send_prompt': {
          if (this.options.unarchiveOnPrompt && this.kernel.ensureRunnable) {
            const ready = await this.kernel.ensureRunnable(cmd.sessionId)
            if (!ready.ok) {
              reply(false, { message: ready.message ?? '会话无法恢复' })
              return
            }
          }
          let text = cmd.text
          /**
           * 正文长度的**执行点**（规范 §13.2 L2）。
           *
           * `ev.host_info.limits.maxTextChars` 报的必须是主机此刻真正执行的值，
           * 所以这个数要么在这里真的被拒，要么就不该报出去——报一个没人执行的限额
           * 等于给手机一个空头承诺（它会据此放行一段我们其实不收的正文）。
           *
           * 为什么放在最前面：附件整批校验与落盘是有副作用的（写盘），
           * 一条注定要被拒的请求不该先往用户磁盘上落文件。
           *
           * 为什么用 `length` 而不是字节数：手机侧那条 `MAX_TEXT_PER_BLOCK` 也是按
           * 字符算的，两端同一个口径才不会在中间留出一段"手机放行、主机拒收"的正文。
           */
          if (text.length > MAX_TEXT_CHARS) {
            reply(false, {
              message: `这条消息太长了（${text.length} 字，上限 ${MAX_TEXT_CHARS} 字），请分几条发`,
            })
            return
          }
          const images: ImageAttachment[] = Array.isArray(cmd.images) ? cmd.images : []
          // 图片附件（2026-10-05 用户：正文里不要再出现路径）。
          //
          // 以前是「落盘 + 把绝对路径追加进 prompt 正文」：路径会出现在对话正文里，
          // 用户和模型都看得见，还把本机目录结构泄露给模型。现在按宿主原生的图片
          // 内容块送进去，正文一个字节都不用改。
          //
          // 也不再落盘：宿主的 attachment store 已经负责持久化，我们再存一份只是
          // 让同一个文件在本机有两个副本，还平白多一个 uploadDir 闸门。
          //
          // **这里还是手机侧形状**（`{data, mimeType}`）：整成内核入口形状
          // （`{type:'image', mediaType, data}`）并送进内核 admission 是载体的活
          // （`carrier-services.submitWithImages`）—— 这一层不认识内核符号，
          // 也不该认识（分层红线）。
          const imageBlocks = images
            .filter((one) => one && typeof one.data === 'string' && one.data !== '')
            .map((one) => ({ data: one.data, mimeType: one.mediaType || 'image/jpeg' }))
          // 手机说"我发了 N 张图"却一张都送不出去时，**不许把正文照发**。
          // 静默丢掉图的那次形态是：照片选好了、发送键也按了、模型对这张图只字不提，
          // 而用户完全看不出发生过什么 —— 比明确失败难查得多（判据见
          // 「主机的载体不许把带图请求悄悄降级成纯文本」那条）。
          if (images.length > 0 && imageBlocks.length === 0) {
            reply(false, { message: `这 ${images.length} 张图片都没带出数据（多半是相册读取失败），请重新选一次` })
            return
          }
          // 文件附件：同一条通路（落盘 + 路径写进正文），差别在 uploads.ts 头注。
          const files: FileAttachment[] = Array.isArray(cmd.files) ? cmd.files : []
          if (files.length > 0) {
            if (!this.options.uploadDir) {
              reply(false, { message: '这台主机没配附件落盘目录（uploadDir），收不了文件附件' })
              return
            }
            const savedFiles = saveFileAttachments({
              files,
              dir: this.options.uploadDir,
              sessionId: cmd.sessionId,
              maxBytesPerFile: this.options.maxFileBytes,
              // 整批总量也要卡：单文件 512KB × 最多 4 个 = 2.7MB base64 进一帧，
              // 中继 maxPayload 是 1MB，超了整帧被掐、socket 1009 断开（见 uploads.ts）。
              // 这一条与 mp 侧 MAX_ATTACH_TOTAL_BYTES 同值同口径，手机放行的这里也放行。
              maxTotalBytes: MAX_ATTACH_TOTAL_BYTES,
            })
            if (!savedFiles.ok) {
              reply(false, { message: savedFiles.message })
              return
            }
            this.options.log?.('文件附件落盘', {
              sessionId: cmd.sessionId,
              files: savedFiles.saved.length,
              bytes: savedFiles.saved.reduce((sum, f) => sum + f.bytes, 0),
              dir: savedFiles.dir,
            })
            text = appendFileNote(text, savedFiles.saved)
          }
          // 直接交给内核（2026-10-05 用户拍板：取消排队）。
          // 理由是 inbox 没有删除入口：排队看着能撤，实际撤不掉，两端只会越差越远。
          // 执行中不许提交这条由**手机**保证（发送键在执行中是中断键）。
          try {
            const sent = await this.kernel.sendPrompt(cmd.sessionId, text, imageBlocks)
            if (!sent.ok) {
              reply(false, { message: sent.message ?? '发送失败' })
              return
            }
          } catch (err) {
            reply(false, { message: err instanceof Error ? err.message : String(err) })
            return
          }
          this.sleep.markActive()
          reply(true, { data: { sent: true } })
          void this.pushSessions('prompt').catch(() => {}) // F8：状态变了就要额外推一次
          return
        }

        case 'cmd.interrupt': {
          const done = await this.kernel.interrupt(cmd.sessionId)
          reply(done.ok, done.message ? { message: done.message } : {})
          void this.pushSessions('interrupt').catch(() => {})
          return
        }
        case 'cmd.resolve_permission': {
          const settled = this.settleApproval(cmd.requestId, cmd.decision)
          reply(settled, settled ? {} : { message: '这个审批请求已经不在挂起状态' })
          void this.pushSessions('permission').catch(() => {})
          return
        }
        case 'cmd.answer': {
          const settled = this.settleQuestion(cmd.requestId, cmd.answers)
          reply(settled, settled ? { data: { answered: cmd.requestId } } : { message: '这个提问已经不在挂起状态' })
          return
        }
        case 'cmd.keep_awake': {
          const snapshot = this.sleep.setEnabled(cmd.enabled, cmd.idleReleaseSec)
          this.broadcast(keepAwakeState(snapshot))
          reply(true)
          return
        }
        case 'cmd.new_session': {
          // 能力缺失时**明确拒绝**（与 cmd.session_history 同一条原则）：回一个假的
          // sessionId 让手机一路走下去，失败点会跑到很远的地方 —— 用户看到的是
          // "新建了一个会话，但发什么都失败"，而病根在宿主没有这个服务。
          const create = this.kernel.newSession
          if (!create) {
            reply(false, { message: '主机这一代不支持新建会话（内核端口没有 newSession 能力）' })
            return
          }
          // 手机指明的工作区（可选）：`cmd.new_session.workspace`。
          // 这一段曾经**刻意不写**：那时插件钉的是还没发版的 wire，
          // 而 `parseCmdPayload` 会把不认识的键 strip 掉 —— 写出来的是一段
          // 永远读到 `undefined` 的代码。现在钉的是 2.0.14，字段在 schema 里，
          // 所以 `cmd.workspace` 拿得到值，接线成立（发版与钉的顺序见 HANDOFF §0.10.4）。
          // 手机不知道落在哪时不带这个字段 → 载体自己推断（配置 → 最近活动的会话 → 宿主默认）。
          const made = await create.call(this.kernel, cmd.workspace ? { workspace: cmd.workspace } : undefined)
          if (!made.ok || !made.sessionId) {
            reply(false, { message: made.message ?? '新建会话失败' })
            return
          }
          reply(true, { data: { sessionId: made.sessionId } })
          // 状态变了就要额外推一次列表（F8）：手机新建完回到列表时那条会话必须已经在，
          // 靠 15 秒的兜底刷新等它出现是不可接受的。
          void this.pushSessions('new-session').catch(() => {})
          return
        }
        case 'cmd.session_history': {
          // 没带 `since` = 这一页是"整页重读"而不是"补差量"。它本身不是故障
          // （首屏就是整页），但**和补差量混在一起就看不出续传有没有在跑**，
          // 所以单独记一笔（见 resume getter）。
          if (cmd.since === undefined) this.resumeCount.noCap += 1
          // 能力缺失时**明确拒绝**：回一张空页在手机上是"这个会话没内容"，
          // 那是一个会让人查错方向的假事实。能力面差异是真实存在的（见 KernelPort）。
          const read = this.kernel.readHistory
          if (!read) {
            reply(false, { message: '主机这一代不支持读取历史（内核端口没有 readHistory 能力）' })
            return
          }
          // ⚠️ 互斥的第二道（协议 schema 已先拒一道）：mock 与真实载体是两条实现，
          // 只靠 schema 那一道会漏。放行的后果是实现自己挑一个方向，挑错即静默漏消息。
          if (cmd.since !== undefined && cmd.beforeSeq !== undefined) {
            reply(false, { message: 'since（向前补差量）与 beforeSeq（向后翻页）不能同时给' })
            return
          }
          let page: Awaited<ReturnType<NonNullable<typeof read>>>
          try {
            page = await read.call(this.kernel, cmd.sessionId, {
              ...(cmd.beforeSeq === undefined ? {} : { beforeSeq: cmd.beforeSeq }),
              ...(cmd.since === undefined ? {} : { since: cmd.since }),
              limit: cmd.limit ?? HISTORY_LIMIT,
            })
          } catch (error) {
            // 保留窗口之外：**明确说补不回来**，让手机改拉历史（规范 §10.7 S4/S5）。
            // 这里绝不能退化成"返回窗口内能给的那些"——手机会以为补齐了，
            // 而中间那段永远补不回来，用户看到的是"消息偶尔少几行"。
            const reason = String((error as Error)?.message ?? error)
            if (reason.includes(HISTORY_WINDOW_EXCEEDED)) {
              this.resumeCount.tooDeep += 1
              reply(false, { message: `断线时间太长，中间那段已经补不回来了（${reason}）` })
              return
            }
            throw error
          }
          if (cmd.since !== undefined) {
            // 补到了东西 = 续传生效；空页 = 游标之后确实没有新事件（也可能是补齐了，
            // 手机把 `latestSeq` 推到了末尾）——两者都不是故障，所以分成两个读数而不是一个。
            if (page.events.length > 0) this.resumeCount.hits += 1
            else this.resumeCount.misses += 1
          }
          // 条目走**与实时流同一批出站构造器**：形状一致才谈得上"同一套渲染路径"。
          const items: HistoryItem[] = []
          for (const event of page.events) {
            const item = historyWireItem(event)
            if (item) items.push(item)
          }
          this.replyTo(
            conversationId,
            sessionHistory({
              sessionId: cmd.sessionId,
              cmdId: cmd.cmdId,
              items,
              ...(page.nextBeforeSeq === undefined ? {} : { nextBeforeSeq: page.nextBeforeSeq }),
              // ⚠️ `latestSeq` 必须一起带出去（规范 §10.7 S3）：它是手机下一次
              // `since` 的取值来源。第一版只加了 schema 与端口字段，漏了这里——
              // 于是手机永远收不到游标，重连后整段重拉，而 schema 与 mock 两侧都看不出。
              ...(page.latestSeq === undefined ? {} : { latestSeq: page.latestSeq }),
            }),
          )
          return
        }
        case 'cmd.get_pending': {
          /**
           * 手机问了一次「你那边还有挂着的东西吗」。这两个计数是**这一类症状唯一的分诊入口**
           * （`diagnostics.pendingAsks`，见那个 getter 的注释里的那张表）。
           */
          this.getPendingCount.calls += 1
          this.getPendingCount.lastAt = this.clock.now()
          // 先拍下"此刻手上有几张"，**再**开始重放：这一格是分诊的关键，
          // 它回答"手机问的那一刻那张卡在不在"（见 pendingAsks 的注释）。
          this.getPendingCount.last = { pending: this.pending.size, replayed: 0 }
          // 手机主动拉还挂着的审批/提问（重连、进会话页时各一次）。
          // 与 peer-joined 的重发同一批帧构造器（同一 requestId，手机按卡覆盖），
          // 只是触发方从主机变成手机——普通 socket 重连中继不通知主机，
          // 主机侧收不到任何信号，只能由手机拉。
          // 没有挂起时只回 ok:true 的回执：回空数组是"没有"，与"没读到"必须分得清。
          let replayed = 0
          // 筛选口径与 `replayPending` 共用同一处实现（见 `pendingEntries`）——
          // 原来这里是内联复制的一份，两处一旦漂移，"帧丢了"的假结论就有了。
          for (const [id, item] of this.pendingEntries(cmd.sessionId)) {
            const frame = this.buildPendingFrame(id, item)
            if (!frame) continue
            this.replyTo(conversationId, frame)
            replayed += 1
          }
          this.getPendingCount.replayed += replayed
          if (this.getPendingCount.last !== null) this.getPendingCount.last.replayed = replayed
          reply(true, { data: { replayed } })
          return
        }
        case 'cmd.archive_session': {
          /**
           * 归档 / 取消归档一条会话。
           *
           * 能力缺失时**明确拒绝**，理由与 `cmd.session_history` 那条一样：
           * 回 ok:true 会让用户以为归档了，而列表里那条还在。
           *
           * 成功后**必须补推一次列表**：本端不监听 `workspace/changes`（它在
           * `unmappedEventTypes` 里——那是一帧 `{turn:N}`，不含"改了哪些文件"，
           * 手机也无法从中推断出归档了哪一条，见伞仓 HANDOFF §8 P0-2），
           * 所以唯一能让界面跟上的是"改完自己推一次"。
           */
          const archive = this.kernel.archiveSession
          if (!archive) {
            reply(false, { message: '主机这一代不支持归档会话（内核端口没有 archiveSession 能力）' })
            return
          }
          const archived = cmd.archived !== false
          const outcome = await archive.call(this.kernel, cmd.sessionId, archived)
          if (!outcome.ok) {
            reply(false, { message: outcome.message ?? `${archived ? '归档' : '取消归档'}失败` })
            return
          }
          reply(true, { data: { archived } })
          // 补推列表放在回执**之后**：回执是给"点下按钮那一下"的答复，
          // 列表是给下一次渲染的输入，两者的顺序不影响正确性，但回执先走
          // 能让手机立刻关掉那个转圈——而列表这一帧会顺带把按钮恢复原状。
          //
          // 复用 `pushSessions` 而不是自己 `listSessions` + `sessionChanged`：
          // 那条路上还有"读失败时保留上一次快照"与"整段包 try"两件事，
          // 自己重写一遍就是第三份口径（而分叉的那一版正是这个项目最常见的缺陷形状）。
          await this.pushSessions('archived')
          return
        }
      }
    } catch (error) {
      // 兜底回执：手机端至少要看到"这条命令失败了"，否则 UI 会静默卡在原地。
      // cmdId 一定回原值，因为对答靠它匹配。
      reply(false, { message: messageOf(error) })
    }
  }

  /**
   * 手机发来一条**解得开、但主机认不出**的指令（2026-10-07 补，
   * 入口是 `transport/relay.ts` 的 `onInvalidCommand`）。
   *
   * ## 为什么要回一条 `ev.result`
   *
   * 手机那一端是过得了 schema 的——它有自己那份协议。所以"到主机这边过不去"几乎只意味着
   * 两端协议版本不一致：最典型的场景是手机把主机这一代还没发版的命令送了过来
   * （例如将来加的 `cmd.archive_session`），或某个字段超出了 schema 的上界
   * （实测最容易撞的是 `fileAttachment.mediaType > 64`）。
   *
   * 不回执就是这个项目里最贵的那一类故障的形状：手机干等满 12 秒的
   * `COMMAND_TIMEOUT_MS`，然后拿到一句「主机没有回应这条指令」——**根因一个字都没留下**，
   * 而真正的那句话（`inbound payload failed cmd schema`）只活在主机的日志里，
   * 用户那头看得见的只是"点了没反应"。
   *
   * ## 为什么刻意不做的两件事
   *
   * 1. **不进 `ledger` / `settledReplies`**：这条命令**没有被执行**，把"没做过的事"
   *    记进"已执行"的台账是撒谎——重发时会回放一个从来没有发生过的结果。它也没被任何
   *    环节消费过，所以每次收到都照实再回一次是安全的（这与 `handleCommand` 开头那段
   *    幂等逻辑是**两条路**，别合并）。
   * 2. **不把英文技术细节原样发给手机**：`message` 是直接 toast 给用户的，
   *    说的是"你该怎么办"；主机那边具体抛了什么留在日志里（两边都有，不用二选一）。
   *
   * 没有 `cmdId` 时**只能记日志**：回执是按 `cmdId` 结算的（`client.js` 的 `_cmdWaiters`），
   * 造一个假的会把手机上某一条**别的**等待误结算——那比不回执更糟。
   */
  handleInvalidCommand(conversationId: string, cmdId: string | undefined, payloadType: string): void {
    if (!cmdId) {
      this.log('unanswerable command rejected', { conversationId, t: payloadType })
      return
    }
    const message = isKnownPayloadType(payloadType)
      ? `主机认不出「${payloadType}」的字段（两端协议版本不一致），请把小程序与主机插件都升到最新版`
      : `主机这一代不支持「${payloadType}」，请把主机插件升到最新版`
    this.replyTo(conversationId, resultOf(cmdId, false, { message }))
  }

  /**
   * 出站计数（进 status.json 的 `outbound`）。
   *
   * 为什么必须有：真机取证时手机报"没收到工具行"，第一件要分清楚的事是
   * **插件到底没发，还是发了但路上丢了**。没有这组计数，这个问题只能靠猜。
   * `*_no_peer` 是"发了但回执说没有对端"，那是另一种故障（配对已经不在了）。
   */
  private readonly outboundCount: Record<string, number> = {}
  get stats(): Record<string, number> {
    return { ...this.outboundCount }
  }

  /**
   * **续传诊断**（进 status.json 的 `diagnostics.resume`，V3-PLAN §7 阶段 F4）。
   *
   * 为什么必须有这组计数：`since` 差量续传（B3/B4）**失败时不报错**——协议设计成
   * "补不回来就退回整页重读"，于是"手机一直在重拉整段历史"这件事在界面上与
   * "续传一直生效"长得一模一样（都是"消息都在"），差别只在流量与时间。
   * 上一轮补 B4 时真机上的那个缺陷（重连后主机不再宣告能力面 ⇒ 差量**永不**生效且不报错）
   * 就是这样藏了很久的——它只在计数上现形。
   *
   * 四个读数各自对应一条降级路径，`hitRate` 是它们的比值：
   * - `hits`：带 `since` 且补到了东西；
   * - `misses`：带 `since` 但返回空页（游标之后真的没有新事件，也是合法的）；
   * - `noCap`：手机**没带** `since`（首屏、没有游标，或上一次差量被拒之后的重读）⇒ 走整页；
   * - `tooDeep`：`since` 落在保留窗口外，协议明确拒收，手机改拉历史（规范 §10.7 S4）。
   */
  private readonly resumeCount = { hits: 0, misses: 0, noCap: 0, tooDeep: 0 }
  /**
   * ⚠️ **不给 `hitRate`**：它是 `hits / (hits+misses+tooDeep)` 的派生量，
   * 而每个字段存在的理由是"有谁读它"（F4）。派生量放进来就多一个没人读的键，
   * 而且它必然与三个计数不同步（谁先更新谁说了算）。
   * 要看命中率的人用 `scripts/host-doctor.mjs`——它按同一条公式算给你看。
   */
  get resume(): { hits: number; misses: number; noCap: number; tooDeep: number } {
    return { ...this.resumeCount }
  }

  /**
   * 挂起卡那条链的可观测读数（`diagnostics.pendingAsks`，出到 `status.json`）。
   *
   * ## 为什么非有不可（2026-10-09 用户报「小程序端的 question 弹窗不弹」）
   *
   * 那一类症状有**四种**根因，长得一模一样：手机上什么都没有。
   * 而这四个数把它们**一次分开**，不用猜：
   *
   * | 读数 | 说明 |
   * |---|---|
   * | `now` / `oldestSec` | 主机此刻还挂着几张、最久等了多久。`now > 0` ⇒ **主机手里有那张卡**，它该能被重放 |
   * | `getPendingCalls` | 手机问过几次。`0` ⇒ **手机从来没来问**（没上线 / 没进会话页；重连后的正路是主机主动 `replayPending`） |
   * | `lastGetPendingReplayed` | **最近那一次**补拉重放了几帧。`0` ⇒ 它问的时候主机一帧都给不出 |
   * | `lastGetPendingPending` | 最近那一次补拉时主机手上有几张。**拿它和 `now` 比**，才分得出「问早了」与「真丢了」 |
   * | `lastGetPendingAgoSec` | 最近一次是多久之前。`now > 0` 而它很大 ⇒ 手机在那之后就没再问过 |
   * | `getPendingReplayed` | 累计重放帧数（含主机在 `peer-joined` 上主动补的那条路） |
   *
   * ⚠️ **为什么"最近那一次"要单独一格，而不用那个累计值**（2026-10-09 review 时自己抓到的）：
   * 累计值只要**曾经**重放过任何一帧就再也不动了，于是"手机问了、主机一帧都没给出去"
   * 这条判断会在当天稍晚**永久闭嘴** —— 而那正是最该报警的时刻。
   * 这就是"判据制造缺陷"那一族：格子看起来在守某件事，实际上一旦被别的路径满足就永远绿。
   *
   * 同理**不能只看 `lastGetPendingReplayed = 0` 就下结论**：那张卡可能是**问完之后**才挂上的，
   * 那种情况下 0 是完全正常的。所以必须配 `lastGetPendingPending` 一起读
   * （分诊表在 `scripts/host-doctor.mjs` 与 `docs/HOST-SIDE.md` §5）。
   *
   * ⚠️ **`waiting`（上面那个 getter）早就存在，但它只进了 pill 面板**，
   * 而面板恰恰是"用户在手机上看不到的那台机器"——于是排错的人手上什么都没有。
   * 这条是同一个读数的第二个出口，不是新的一套状态模型。
   */
  get pendingAsks(): {
    now: number
    oldestSec: number
    getPendingCalls: number
    getPendingReplayed: number
    lastGetPendingReplayed: number | null
    lastGetPendingPending: number | null
    lastGetPendingAgoSec: number | null
  } {
    const { count, oldestSec } = this.waiting
    const last = this.getPendingCount.last
    return {
      now: count,
      oldestSec,
      getPendingCalls: this.getPendingCount.calls,
      getPendingReplayed: this.getPendingCount.replayed,
      lastGetPendingReplayed: last === null ? null : last.replayed,
      lastGetPendingPending: last === null ? null : last.pending,
      lastGetPendingAgoSec:
        this.getPendingCount.lastAt === null
          ? null
          : Math.max(0, Math.floor((this.clock.now() - this.getPendingCount.lastAt) / 1000)),
    }
  }

  /**
   * `cmd.get_pending` 的收发计数。**只有计数，没有别的**：
   * "重放了几帧"才是能定性的一格（`replayed=0` 与 `replayed>0` 是两条完全不同的排查方向）。
   */
  /**
   * 此刻挂着的、**属于这条会话**的那些（`sessionId` 缺省 = 全部），带 requestId。
   *
   * ⚠️ **两条重放路必须共用它**（`cmd.get_pending` 与 `replayPending`）：
   * 那两个数是同一个分诊表上的分子与分母，筛选口径一旦不同就得出"帧丢了"的假结论
   * （2026-10-09 深度 review 的 A2）。
   *
   * 2026-10-12 review 修：这里原来是一个**没人调用**的 `pendingForSession()`
   * （返回 `PendingInteraction[]`），而 `cmd.get_pending` 那边**内联复制**了同一段筛选
   * —— 注释说"必须逐字同判据"，实现却是两份。现在两处都走这一份。
   */
  private pendingEntries(sessionId: string | undefined): Array<[string, PendingInteraction]> {
    const out: Array<[string, PendingInteraction]> = []
    for (const [id, item] of this.pending) {
      if (sessionId !== undefined && item.sessionId !== sessionId) continue
      out.push([id, item])
    }
    return out
  }

  private readonly getPendingCount = {
    calls: 0,
    replayed: 0,
    lastAt: null as number | null,
    /** 最近那一趟的现场：`pending` 是**问的那一刻**主机手上有几张，`replayed` 是那趟给出去几帧。 */
    last: null as { pending: number; replayed: number } | null,
  }

  /**
   * 有几件事正挂在手机上等回答，以及**最久的那件已经等了多久**（秒）。
   *
   * 为什么这条要出到界面上（而不只是内部状态）：一张挂起的审批阻塞着远端一条正在跑的回合，
   * 而回合阻塞着用户的下班时间。桌面那颗 pill 原来在"已配对 + 有东西在等"时仍然只说
   * `已配对`——那是这整条链上唯一看得见它的地方，等于没有。判据见伞仓 docs/PRODUCT.md §3。
   *
   * `oldestSec` 用 `clock.now()` 而不是 `Date.now()`： FakeClock 要能演"等了 4 分钟"，
   * 否则这条时长在测试里永远是 0，也就永远不会红。
   */
  get waiting(): { count: number; oldestSec: number } {
    const now = this.clock.now()
    let oldest = 0
    for (const item of this.pending.values()) {
      const age = Math.max(0, Math.floor((now - item.askedAt) / 1000))
      if (age > oldest) oldest = age
    }
    return { count: this.pending.size, oldestSec: oldest }
  }

  /**
   * 某条会话此刻有没有人在等它（2026-10-06 接上 `awaiting-*` 会话状态）。
   *
   * **给 carrier 用**：内核回答不了这件事——它只知道会话在不在跑，不知道有一张
   * 审批/提问卡正等人点。分层上 carrier 不 import runtime，所以由 index.ts 把这个
   * 方法作为回调注进去（见 carrier-services 的 `pendingKindForSession`）。
   *
   * 同时挂着审批与提问时**审批优先**：审批 180s 超时、提问 300s，前者更急。
   */
  pendingKindForSession(sessionId: string): 'approval' | 'question' | undefined {
    let approval = false
    let question = false
    for (const item of this.pending.values()) {
      if (item.sessionId !== sessionId) continue
      if (item.kind === 'approval') approval = true
      else question = true
    }
    return approval ? 'approval' : question ? 'question' : undefined
  }

  private countOutbound(payload: EvPayload, sent?: boolean): void {
    const key = payload.t.replace(/^ev\./, '')
    this.outboundCount[key] = (this.outboundCount[key] ?? 0) + 1
    if (sent === false) this.outboundCount[`${key}_no_peer`] = (this.outboundCount[`${key}_no_peer`] ?? 0) + 1
  }

  private broadcast(payload: EvPayload): void {
    // 广播也要报"有没有人收到"：只数帧不数对端，就会在真机上出现
    // "计数说发了 4 帧、手机一帧都没收到"这种无从对账的局面。
    this.countOutbound(payload, this.transport.broadcast(payload) > 0)
  }

  private replyTo(conversationId: string, payload: EvPayload): void {
    this.countOutbound(payload, this.transport.reply(conversationId, payload))
  }

  /**
   * 本端**此刻**的限额与自身信息（规范 §13.2，附录 D·GAP-5 的收口）。
   *
   * ## 为什么它必须是"此刻"而不是"构建时"
   *
   * - `limits.maxFileAttachments` 看 `uploadDir`：没配落盘目录的主机**真的**不收
   *   文件附件（`cmd.send_prompt` 那条 `reply(false, …)` 就是证据），
   *   所以它必须报 0，而不是报协议上界的 4。
   *
   * 这条义务（L2"报的是 host **此刻真正执行**的值，不是配置的名义值"）是整条
   * §13 的支点：报名义值等于把一个空头承诺发给手机，而手机据此置灰/放行。
   */
  hostInfoPayload(): EvHostInfo {
    const meta = (this.options.hostMeta ?? defaultHostMeta)()
    return hostInfo({
      host: { ...meta, carrier: this.kernel.carrier },
      limits: {
        /**
         * **图片上限跟着"这台内核此刻有没有图片通路"走**（2026-10-09 真机取证）。
         *
         * 与下面 `maxFileAttachments` 同一个形状、同一套理由：那两个数字回答的是
         * "这台主机**此刻**真的能收几张"，不是"协议上界是几张"。文件那条早就这么做了
         * （没配 `uploadDir` 就报 0），图片这条原来一直报协议上界 4 ——
         * 于是在一台**内核根本没有图片通路**的主机上（web profile 的 dsh 0.1.0-rc.6：
         * `dsh-llm-deepseek` 对任何图片内容直接抛 `UNSUPPORTED_CONTENT`），
         * 手机照样让用户选图、压缩、传完整个附件，才在发送那一刻被拒。
         *
         * 报 0 之后，手机在**选之前**就能知道（`limits` 是它读得到的东西）。
         * 取证、三态与取舍见 `capabilities.ts` 的 `imageAttachmentsSupported`。
         */
        ...this.attachmentLimits(),
        maxAttachmentBytes: this.options.maxFileBytes,
        maxTextChars: MAX_TEXT_CHARS,
      },
      /**
       * `state.sleep` 从**平台**推导，不从 `SleepPort.backend()` 取。
       *
       * 那条路走不通的原因：`backend()` 的类型是自由字符串（`ev.keep_awake_state.backend`
       * 本来就接受任意名字，测试桩用的是 `'fake-caffeinate'`），而
       * `ev.host_info.state.sleep` 是**闭枚举**——手机要按它三态分支。
       * `detectBackend(platform)` 才是规范给的那条映射，也是 `SystemSleepBackend`
       * 内部实际用的那一条（`backend()` 就是 `detectBackend(this.osName)`），
       * 所以这里推导与那里取值**同源**。等价性由 `sleep.test.ts` 钉着。
       */
      state: { sleep: detectBackend(meta.platform) },
    })
  }

  /**
   * 把 `ev.host_info` 发给某一条会话。
   *
   * 规范 L4：host MUST 在**（重）连上**与**能力变化**时各发一次。
   *
   * - "（重）连上"由 `index.ts` 的 `onPeerJoined` 触发 —— 它同时覆盖新配对与重连
   *   （重连那一帧不带 pairingToken，但一样会走到那个回调）。
   * - "能力变化"目前**不可达**：`caps` 只随进程内的内核端口变，而端口在
   *   `start()` 时定型、之后不再换。所以不假装有一条能力变化事件 —— 假装的那个
   *   只会在真需要它的那一天（例如将来支持热插拔载体）变成一句空话。
   *
   * 永不抛：它挂在 `peer-joined` 那条路上，异常会把配对流程带崩（`apply()` 的红线）。
   */
  sendHostInfo(conversationId: string): boolean {
    if (!this.started) return false
    try {
      this.replyTo(conversationId, this.hostInfoPayload())
      return true
    } catch (error) {
      this.log('host info send failed', { message: messageOf(error) })
      return false
    }
  }

  /** 内核事件入口。合帧与顺序规则都在这几行里。 */
  private onKernelEvent(event: KernelEvent): void {
    switch (event.kind) {
      case 'delta': {
        // **一条带正文的 done 必须先把正文推进窗口**。内核没有 token 级增量：一条消息
        // 就是一条完整的 `assistant/message`（正文与 done 同到）。第一版在这里只走
        // `complete()`，而 complete 对"缓冲区里根本没有这条消息"的情形发的是 **done-only 帧**
        // ——于是 `textOf` 辛苦读出来的回复被整个丢掉，手机上收到一帧空文本 + done，
        // 而"⑧ 流式输出到达 / ⑨ 有 done"两条断言照样绿（真机取证抓到的正是这个）。
        if (event.text) this.window.push(event.sessionId, event.messageId, event.text, event.role)
        if (event.done) this.window.complete(event.sessionId, event.messageId, event.role)
        if (event.text) this.sleep.markActive()
        return
      }
      case 'inbox': {
        // 主机侧排队的用户消息（内核 agent/inbox/spliced）：用户在 DSH 里敲了字，
        // 这一轮还没跑完，消息排给下一轮。手机上它就是一条用户指令——与 user/message
        // 同一条渲染路（用户气泡 + 历史回放），复用 ev.message_delta role=user。
        // 空正文不发：纯图片的 splice 在手机上没有载体，发一条空 user 块等于假事实
        // （mp 的 _applyText 对空正文本来就不建块，这里的跳过只是不浪费那一帧）。
        if (!event.text) return
        this.window.push(event.sessionId, event.messageId, event.text, 'user')
        this.window.complete(event.sessionId, event.messageId, 'user')
        this.sleep.markActive()
        return
      }
      case 'tool':
        // 非 delta 事件之前必须先 flush 同会话缓冲，否则工具行会插进它自己的文本里。
        this.window.flushSession(event.sessionId)
        this.broadcast(toolEvent(event))
        this.sleep.markActive()
        return
      case 'run-state':
        this.window.flushSession(event.sessionId)
        this.broadcast(runState(event))
        if (event.state === 'running') {
          this.sleep.markActive()
          // ⚠️ 这里**刻意不做任何"推断清空"**（2026-10-11 用户裁决：生命周期跟随 host）。
          //
          // 原来这里有一段：新一轮开始时，若上一轮显示过清单，就合成一帧空快照发出去。
          // 它的理由是"内核不会为'这一轮没有待办'专门发一帧 `todo/write`"
          // —— **那个前提是错的**：内核**确实会**发空清单，
          // 判据 `tests/runtime.test.ts` 里就有一处直接喂 `todos: []` 验证这一点。
          //
          // ⇒ 自己合成空帧造成的是**双重清空**：内核发了空清单、我们又发一次，
          // 而第二条依据的是"上一轮有过"这个**已经过期的事实**。
          // 现在只转发内核实际发来的清单：它说什么，手机上就是什么。
        }
        void this.pushSessions('run-state').catch(() => {})
        return
      case 'model':
        // **按会话**广播模型（2026-10-05 用户实测：当前会话 space-bunny-free，
        // mp 端显示别的会话切出来的 muse-spark）。
        //
        // 数据源是内核 request/header（每轮一条），**不是**宿主全局默认模型
        // （agentDefaultModel.currentSelection = 新会话默认用哪个）。
        // 全局那个与本会话无关——用户在别的会话切一次模型，本会话显示就跟着变。
        this.rememberModel(event.sessionId, event.model, event.provider)
        this.broadcastModel(event.sessionId, event.model, event.provider)
        return
      case 'todo':
        // 与 tool 同一纪律：先 flush 同会话的文本缓冲，再广播整份快照。
        // 不做合并窗口——一轮 todo 也就十几条，逐条发手机也渲染得动；合并反而会让
        // "最后那份清单"晚到，而顶部那颗条子要的就是此刻。
        this.window.flushSession(event.sessionId)
        this.broadcast(todoList({ todos: event.todos, sessionId: event.sessionId }))
        this.sleep.markActive()
        return
      case 'retry':
        // 「模型卡住」与「模型正在重试」对用户是两件事（2026-10-06）：
        // 以前这条不映射，手机上一片空白，用户以为它死了还去手动中断。
        this.broadcast(
          retryNotice({ sessionId: event.sessionId, attempt: event.attempt, max: event.max, reason: event.reason }),
        )
        return
      case 'compaction':
        // 压缩这段静默期以前完全看不见。
        this.broadcast(compactionNotice({ sessionId: event.sessionId, state: event.state, error: event.error }))
        return
      case 'title':
        void this.pushSessions('title').catch(() => {})
        return
      case 'sessions-changed':
        void this.pushSessions(event.reason ?? 'changed').catch(() => {})
        return
    }
  }

  /**
   * 推一次全量会话列表（F7/F8）。
   *
   * 相邻两次推送之间至少隔一个"合并窗口"，因为内核可以在一个 turn 里连发十几条
   * `sessions-changed`；列表是全量快照，合并掉中间几次没有信息损失。
   *
   * **但"合并"不等于"丢掉"**（第一版就是把它写成了丢掉）：被合并的那一次必须变成一次
   * 尾随推送，否则最后那次变化永远没人告知手机——F8 要求"任何会改变会话状态的动作
   * 之后都必须额外推一条 session_changed"，而手机不看 `ev.result.data.sessions`，
   * 于是"发完指令列表却停在旧状态"最长要等到 15 秒的兜底刷新。
   */
  async pushSessions(reason: string): Promise<SessionSummary[]> {
    if (this.stopped) return this.sessions
    /**
     * **整段包 try**（2026-10-06）。原来只有 `kernel.listSessions` 那一句在 try 里，
     * 后面的 `transport.broadcast`（加密 + 写 socket）与 `kernel.modelOptions()`
     * （调内核服务）都在外面：任一处抛出就是一条未捕获的 Promise 拒绝，
     * Node≥15 默认**直接终止进程** —— 而调用点全是 `void this.pushSessions(...)`，
     * 等于用一次状态推送把用户的宿主带崩（违反 apply() 的头号红线）。
     */
    try {
      try {
        const listed = await this.kernel.listSessions(LISTING_LIMIT)
        this.sessions = listed.map((item) => item.summary)
      } catch (error) {
        // 读失败时**保留上一次已知的快照**再照常广播：把列表清成空白比停在旧状态更糟
        // （手机会以为会话全没了），而 keep_awake 那一侧的状态仍然必须送达（M25）。
        this.log('list sessions failed', { message: messageOf(error), reason })
      }
      // 判窗口用的是"数据到手"的时刻，不是进入函数的时刻：内核读列表可能很慢，
      // 用进入时刻会让一次 400ms 的读直接吃掉整个合并窗口。
      const now = this.clock.now()
      const sinceLast = now - this.lastPushAt
      if (sinceLast < SESSION_MERGE_MS && reason !== 'start' && reason !== 'list') {
        this.mergePendingReason = reason
        if (this.mergeTimer === undefined) {
          this.mergeTimer = this.clock.setTimeout(() => {
            this.mergeTimer = undefined
            void this.pushSessions(this.mergePendingReason).catch(() => {})
          }, SESSION_MERGE_MS - sinceLast)
        }
        return this.sessions
      }
      this.lastPushAt = now
      if (this.mergeTimer !== undefined) {
        // 这一条全量快照已经把待推的内容覆盖到了，尾随推送不必再发（否则会多发一条重复列表）。
        this.clock.clearTimeout(this.mergeTimer)
        this.mergeTimer = undefined
      }
      this.broadcast(sessionChanged(this.sessions, reason))
      this.broadcast(keepAwakeState(this.sleep.snapshot()))
      this.replayModels()
      return this.sessions
    } catch (error) {
      this.log('push sessions crashed', { message: messageOf(error), reason })
      return this.sessions
    }
  }

  /**
   * 随会话列表**补发**每条会话的模型。
   *
   * 为什么这条路径必须存在（2026-10-06 取证）：commit 9511904 修提问弹窗时把
   * `this.broadcastModel()` 从 `pushSessions()` 里删掉了——那次重构改了
   * broadcastModel 的签名（从"读全局"改成"广播这个事件带来的"），
   * **call site 被删掉而不是适配**。于是模型只在跑一轮时出站，
   * 打开已有会话/重连后顶栏一片空白。
   *
   * 挂在 pushSessions 上是因为它本来就是那个"状态变了就推一次"的唯一入口，
   * 而且它的 reason `'list'`（mp 重连时 `chat.js` 会发 `cmd.list_sessions`）
   * **不走合并窗口**——所以重连这一路是白拿的，不需要另加触发点。
   *
   * 只补发**内核报过的**：没见过的会话一条都不发。凭空造一个全局模型名，
   * 显示的是猜的东西，比不显示更糟。
   */
  private replayModels(): void {
    /**
     * **只补发当前会话列表里那几条**（2026-10-06）。
     *
     * 缓存上限是 256 条，而 `pushSessions` 是"任何状态变化都推一次"的唯一入口：
     * 全量重播意味着一次变化最坏发出数百帧 `ev.model`（含早就掉出列表、手机上根本
     * 看不到的会话），而中继的单帧上限与手机的处理都按"一次状态变化一帧"设计。
     * 求交不删缓存（理由见 `rememberModel`）：会话回到列表里时它的模型还在。
     */
    const listed = new Set(this.sessions.map((session) => session.id))
    for (const [sessionId, entry] of this.modelBySession) {
      if (!listed.has(sessionId)) continue
      this.broadcastModel(sessionId, entry.model, entry.provider)
    }
  }

  /**
   * 记一条会话的模型，并做**有界**淘汰。
   *
   * 刻意**不**按会话列表裁剪：列表是 LIMIT 截断的（LISTING_LIMIT=100），
   * 一条跑过模型的会话一旦掉出前 100，它的模型就会被误删——那正好是"打开一条
   * 旧会话模型是空的"这条 bug 换个原因复发。
   * 改用与 `RelayClient.voided` / `PairingSlots` 同一套的容量上限（见 MODEL_CACHE_MAX）。
   */
  private rememberModel(sessionId: string, model: string, provider?: string): void {
    // 命中就重新插到队尾：容量满时淘汰的是**最久没被内核确认过**的那条。
    this.modelBySession.delete(sessionId)
    this.modelBySession.set(sessionId, { model, ...(provider ? { provider } : {}) })
    while (this.modelBySession.size > MODEL_CACHE_MAX) {
      const oldest = this.modelBySession.keys().next()
      if (oldest.done) break
      this.modelBySession.delete(oldest.value)
    }
  }

  /**
   * 广播当前模型。
   *
   * 跟着 `pushSessions` 一起发而不是单独起一条：模型与防休眠都是**全局状态**，
   * 而 `pushSessions` 已经是"状态变了就推一次"的唯一入口，另开一条推送路径
   * 必然出现「会话更新了但模型没更新」这种半同步状态。
   *
   * **读不到就不发**（而不是发一个 `model: ''`）：`ev.model` 的 `model` 是必填的
   * 非空串，硬塞空串会让手机把「不知道用什么模型」显示成「模型名为空」——
   * 后者看起来像 bug，前者只是没显示。内核缺 `currentSelection` 时真机上是常态
   * （见 carrier 的 modelFace 探测）。
   */
  private broadcastModel(sessionId: string, modelName: string, provider?: string): void {
    if (!modelName) return
    const face = this.kernel.modelOptions?.()
    this.broadcast(
      model({
        sessionId,
        model: modelName,
        provider,
        canSwitch: Boolean(face?.canSwitch),
        options: face?.options,
        reason: face?.canSwitch ? undefined : (face?.reason ?? '主机内核未提供切换模型的能力'),
      }),
    )
  }

  private refreshLoop(): void {
    if (this.stopped) return
    void this.pushSessions('refresh').catch(() => {})
    this.window.flushRound()
    this.refreshTimer = this.clock.setTimeout(() => this.refreshLoop(), this.options.listingRefreshMs)
  }

  // ── 人工交互：审批与提问 ────────────────────────────────────────────

  /**
   * 平台发起一次审批。
   *
   * **没有在线对端就返回 `'decline'`**，让适配器去调平台的 `next()` 把决定权交还桌面 UI；
   * 超时同样返回 `'decline'`（我们已经把卡片发出去了，但手机迟迟没点，
   * 与其替用户决定，不如让桌面去决定）。
   *
   * 返回值只说明"手机这一侧算出了什么"，**不代表这张卡是手机答掉的**：
   * 桌面与手机是同时被问的（见 `carrier-services.ts` 的 `participate`），
   * 所以收尾时要按"有没有真的有人在手机上点过"决定要不要把卡收回去。
   */
  private async onApprovalRequest(info: {
    sessionId: string
    action: string
    reason?: string
    signal?: AbortSignal
    /**
     * **宿主自己给的期限（毫秒）**。有就跟随，没有就不设 —— 见 `onApprovalRequest`
     * 里那段长注。⚠️ 它是**可选的**：这一代内核**不给**这个字段，所以今天的行为是
     * "不设期限"；哪一代内核开始给，就自动跟随，不需要改这里。
     */
    timeoutMs?: number
  }): Promise<ApprovalDecision> {
    const conversationId = this.pickConversation(info.sessionId)
    if (!conversationId) {
      // ⚠️ **一台手机都没配过**（`conversationIds()` 为空）⇒ 交还桌面。
      // 纯桌面用户从来没打算在手机上答，让他们每次审批白等 180 秒是错的。
      this.interactionDeclines.noClient += 1
      this.log('approval dropped before any frame: no conversation at all', {
        sessionId: info.sessionId,
        conversations: this.transport.conversationIds().length,
      })
      return 'decline'
    }
    if (!this.transport.hasClient(conversationId)) {
      /**
       * ⚠️ **配过手机、但此刻不在线 ⇒ 照样挂账，不再当场拒**（2026-10-10 改）。
       *
       * ## 改之前什么样（用户报「手机不在线时审批/提问卡还是会漏」）
       *
       * 原来这一支和上面那条**合并**成一个 `noClient`，处置都是 `return 'decline'`。
       * 于是手机离线的后果不是"卡等在那儿"，而是**卡根本不存在**：
       * 内核收到拒绝 ⇒ 那一轮被中断（真机截图里那句「这一轮被中断，这个工具没有返回结果」），
       * `pending` 账里一条都没有 ⇒ 手机回来时 `replayPending` **无物可放**。
       * 所以只补 `replayPending` 是不够的 —— 得先让卡生出来。
       *
       * ## 为什么"挂账"是安全的
       *
       * 1. **桌面侧不受影响**：我们只是不再替用户立刻拒绝。桌面那条审批链照常显示，
       *    用户在电脑上点了 ⇒ `settle(id, …, 'desktop')` 走 `voidStaleCard`，
       *    手机上那张（若推过）当场收掉，不留幽灵卡。
       * 2. **有超时兜底**：审批 180s / 提问 300s 之后 `settle(…, 'timeout')` 自动收场，
       *    与"手机在但没答"完全同一条路 —— 不是新的、没验证过的分支。
       * 3. **只对"配过手机"的人生效**：没配过的走上面那一支，立刻交还桌面。
       *
       * ## 为什么单独计数，不并进 `noClient`
       *
       * 两个数要的处置**完全相反**：`noClient`（一台都没配）是正确行为；
       * 这个是"配了但不在线 ⇒ 卡在等你"。混成一个数就分不出"该不该有卡"
       * 与"卡为什么没到"，而那正是这一格存在的理由。
       */
      this.interactionDeclines.offlineHold += 1
      this.log('approval held while the paired phone is offline; it will be replayed on reconnect', {
        sessionId: info.sessionId,
        conversationId,
      })
    }
    /**
     * **进来就已经 abort 的信号：当场交还桌面，一张卡都不发**（2026-10-06）。
     *
     * `carrier-services.participate()` 在调用 sink **之前**就把平台撤下来的 signal
     * 转成 `controller.abort('platform')`（`if (platform.aborted) controller.abort('platform')`），
     * 而我们拿到的正是这条 controller 的 signal。对**已经 abort** 的 signal
     * `addEventListener('abort', …)` **永远不会触发**：于是卡照发、挂锁照挂，
     * 手机上是一张可点的死卡，宿主那条 waterfall 也被堵满整个超时窗口
     * （审批 180s / 提问 300s），期间手机点"允许"还会被当成真答案。
     * 这一判必须在 `sleep.hold()` 与首帧之前——那样连锁都不用挂。
     */
    if (info.signal?.aborted) {
      this.interactionDeclines.aborted += 1
      this.log('approval already withdrawn by the platform, handing back to the desktop', {
        sessionId: info.sessionId,
        reason: String(info.signal.reason ?? ''),
      })
      return 'decline'
    }
    const id = `ap_${randomUUID().slice(0, 8)}`
    this.sleep.hold(id)
    // ⚠️ **这里刻意不设任何到期时刻**（2026-10-11 用户裁决）。
    //
    // 原来有 `approvalTimeoutSec`（180s）与 `questionTimeoutSec`（300s）两个定时器：
    // 到点就 `settle(…, 'timeout')`，并给帧带一个 `expiresAt` 让手机显示倒计时。
    // 那个期限**是我们自己加的** —— 宿主内核给的入参
    // `onApprovalRequest({ sessionId, action, reason?, signal? })` 与
    // `onQuestionRequest({ sessionId, questions, signal? })` **都不含任何期限字段**，
    // 桌面上那张对话框的生命周期就是这件事的全部。
    //
    // ⇒ 加上限的后果正是 2026-10-09 那次真机故障：**页面退后台 → 事件退订 → 卡帧到了
    // client 却没到任何界面 → 用户回到页面时主机早已判超时**，手机上什么都没有可点。
    // 症状看起来像"小程序点不动"，真因是"那张卡在主机上已经过期了"。
    //
    // ⇒ 现在只由**三种**方式结算：手机答了、桌面先答了（`ev.permission_resolved`）、
    // 宿主撤了这次请求（`signal` abort）。**桌面会一直等的事，手机上也一直等** ——
    // 两端行为一致，而不是手机先到期。
    // 代价要说清：**没人答时这次交互不会自己结束**（挂锁与 `pending` 条目一直留着），
    // 但桌面那一位同样不会结束 —— 这是"与 host 端一致"的字面含义。
    // ⚠️ 查表放在**挂 waterfall 之前**：「本次会话内始终允许」要真的省掉打扰，
    // 而不只是在事后记一笔。若放在之后，每次请求照样走一遍审批流（照样占住 host 的一次交互、
    // 照样给桌面 UI 一次机会），用户仍然被打断——那就只实现了"记账"，没实现"始终允许"。
    const scope = approvalScopeOf(info.sessionId, info.action)
    const remembered = this.sessionAllowed.get(scope)
    if (remembered) {
      // 这一格必须在**返回之前**记：命中即返回，之后再没有别的语句会执行到。
      this.sessionAllowedHits += 1
      this.log('approval answered by session-scoped allow-list', { sessionId: info.sessionId, action: info.action })
      return remembered
    }
    // `return await` + finally：executor 里抛出（或 resolve 路径的任何异常）都不会让
    // releaseHold 被跳过 —— 旧写法里一次抛出就是一条永久泄漏的挂锁（机器再也不睡）。
    try {
      // **有期限才设**：宿主没给就不设（见上面那段长注）。与提问那条逐字同形。
      const hostTimeout = hostTimeoutMs(info.timeoutMs)
      const expiresAt = hostTimeout ? new Date(Date.now() + hostTimeout).toISOString() : undefined
      return await new Promise<ApprovalDecision>((resolve) => {
        const timer = hostTimeout
          ? this.clock.setTimeout(() => {
              this.settle(id, 'decline', 'timeout')
            }, hostTimeout)
          : undefined
        this.pending.set(id, {
          conversationId,
          sessionId: info.sessionId,
          resolve: (value) => resolve(value === undefined ? 'decline' : (value as ApprovalDecision)),
          ...(timer === undefined ? {} : { timer }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          kind: 'approval',
          askedAt: this.clock.now(),
          action: info.action,
          reason: info.reason,
        })
        // `reason` 是 `carrier-services.participate()` 打的标记：'desktop' = 桌面先答了，
        // 其余（'platform'）是宿主自己把这次请求撤了。两种都要让手机把卡收掉，
        // 但说出来的话不一样。
        info.signal?.addEventListener(
          'abort',
          () => this.settle(id, 'cancelled', info.signal?.reason === 'desktop' ? 'desktop' : 'withdrawn'),
          { once: true },
        )
        this.replyTo(
          conversationId,
          permissionRequest({
            requestId: id,
            sessionId: info.sessionId,
            action: info.action,
            ...(info.reason === undefined ? {} : { reason: info.reason }),
            options: APPROVAL_OPTIONS,
            // 宿主没给期限时**不带这个键**（协议里它是可选的）—— 带了手机就会起倒计时，
            // 而主机并不会在那个时间点结算。
            ...(expiresAt === undefined ? {} : { expiresAt }),
          }),
        )
      })
    } finally {
      // 结算点（settleApproval）已经把手机的 'approve'/'reject' 翻成平台词汇了，
      // 这里不再翻第二次——两处映射表迟早会分叉。
      //
      // 手机没被点过（超时、桌面先答、平台撤回）时那张卡的作废在 `settle()` 里就发了，
      // 不用在这里补第二次：那一处同时管审批与提问两类卡。
      this.sleep.releaseHold(id)
    }
  }

  private async onQuestionRequest(info: {
    sessionId: string
    questions: QuestionItem[]
    signal?: AbortSignal
    /** 与审批那个 `timeoutMs` 逐字同形：有就跟随，没有就不自己加。 */
    timeoutMs?: number
  }): Promise<AskUserQuestionAnswerValue | null> {
    const conversationId = this.pickConversation(info.sessionId)
    if (!conversationId) {
      // 与审批那条**逐字同形**：一台手机都没配过 ⇒ 交还桌面（纯桌面用户不该白等 300 秒）。
      this.interactionDeclines.noClient += 1
      this.log('question dropped before any frame: no conversation at all', {
        sessionId: info.sessionId,
        conversations: this.transport.conversationIds().length,
      })
      return null
    }
    if (!this.transport.hasClient(conversationId)) {
      // 与审批那条**逐字同形**：配过手机但不在线 ⇒ 照样挂账，手机回来时由 `replayPending` 推给它。
      // 两条必须一起改 —— 只改审批的话，提问仍然"离线即消失"，而它们在主机是同一份 `pending`、
      // 同一个命令、同一段补拉（见 `cmd.get_pending` 的处理）。
      this.interactionDeclines.offlineHold += 1
      this.log('question held while the paired phone is offline; it will be replayed on reconnect', {
        sessionId: info.sessionId,
        conversationId,
      })
    }
    // 与审批同一条：**已经 abort 的 signal 永远不会再触发监听器**，所以必须在
    // hold 与首帧之前判掉，否则手机上是 300 秒的死卡、挂锁也一直挂着（见审批那里的取证）。
    if (info.signal?.aborted) {
      this.interactionDeclines.aborted += 1
      this.log('question already withdrawn by the platform, handing back to the desktop', {
        sessionId: info.sessionId,
        reason: String(info.signal.reason ?? ''),
      })
      return null
    }
    const id = `q_${randomUUID().slice(0, 8)}`
    this.sleep.hold(id)
    // 与审批**逐字同形**：也不设期限，两处必须一起改（理由见审批那条的整段注）。
    // `return await` + finally：releaseHold 与 hold 必须一一对应（同审批那条的理由）。
    try {
      const hostTimeout = hostTimeoutMs(info.timeoutMs)
      const expiresAt = hostTimeout ? new Date(Date.now() + hostTimeout).toISOString() : undefined
      return await new Promise<AskUserQuestionAnswerValue | null>((resolve) => {
        const timer = hostTimeout
          ? this.clock.setTimeout(() => {
              this.settle(id, null, 'timeout')
            }, hostTimeout)
          : undefined
        this.pending.set(id, {
          conversationId,
          sessionId: info.sessionId,
          resolve: (value) => resolve((value as AskUserQuestionAnswerValue | undefined) ?? null),
          ...(timer === undefined ? {} : { timer }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          options: info.questions,
          kind: 'question',
          askedAt: this.clock.now(),
        })
        // 与审批那条同样：'desktop' 是桌面先答，其余是宿主自己撤了这次请求。
        info.signal?.addEventListener(
          'abort',
          () => this.settle(id, null, info.signal?.reason === 'desktop' ? 'desktop' : 'withdrawn'),
          { once: true },
        )
        this.replyTo(
          conversationId,
          questionRequest({
            requestId: id,
            sessionId: info.sessionId,
            questions: info.questions,
            ...(expiresAt === undefined ? {} : { expiresAt }),
          }),
        )
      })
    } finally {
      this.sleep.releaseHold(id)
    }
  }

  private settleApproval(requestId: string, decision: string): boolean {
    const item = this.pending.get(requestId)
    // **跨类结算必须拒掉**：审批与提问共用一张 pending 表与同一套 requestId 回传协议，
    // 拿提问的 id 去 settleApproval（或反过来）原来会跨类结算并回 ok:true —— 手机上
    // 那张提问卡被一个审批答案收掉，而平台拿到一个它没问过的决定。
    if (!item || item.kind !== 'approval') return false
    /**
     * **白名单**（F10）：手机逐字回传我们下发的 `options[].id`，合法的只有
     * `'approve'` / `'reject'`（v3 加了 `'approve-session'`）。
     * 原来写的是"不是 reject 就放行一次"——那是 fail-open：
     * 未知词（`deny` / `decline` / `cancel`，或者一个被改过的小程序回传的别的形状）会被当成
     * **允许**，一次误判就是替用户放行了一条工具调用。认不出的一律按拒绝。
     */
    const outcome: ApprovalDecision =
      decision === 'approve' ? 'allowed-once' : decision === 'approve-session' ? 'allowed-session' : 'rejected'
    // 「本次会话内始终允许」：记住这把钥匙的形状，让同一会话里后续同类请求不再打扰用户。
    // 键取 **会话 + 审批类别**（`approvalScopeOf`），不是 requestId——同一会话里
    // 同一类工具重复问才是打扰的来源。
    if (decision === 'approve-session') {
      this.sessionAllowed.set(approvalScopeOf(item.sessionId, item.action), outcome)
    }
    this.settle(requestId, outcome)
    return true
  }

  private settleQuestion(requestId: string, answers: AnswerItem[]): boolean {
    const item = this.pending.get(requestId)
    // 同 settleApproval：用错类的 requestId 不许跨类结算。
    if (!item || item.kind !== 'question') return false
    // 空答案不是答案：`answers: []` 交给平台会得到一条"问过了但什么都没选"的记录，
    // 而手机上那张卡其实还亮着（用户会以为自己答了）。拒绝它，回执说清楚。
    if (!Array.isArray(answers) || answers.length === 0) return false
    // 平台的答案里 selected 装的是**选项 label**（不是我们的 id），所以这里要翻回去。
    const byQuestion = new Map((item.options ?? []).map((question) => [question.id, question]))
    const value: AskUserQuestionAnswerValue = {
      answers: answers.map((answer) => {
        const question = byQuestion.get(answer.questionId)
        const selected = (question?.options ?? [])
          .filter((option) => answer.selected.includes(option.id))
          .map((option) => option.label)
        return {
          id: answer.questionId,
          selected,
          ...(answer.freeText === undefined ? {} : { custom: answer.freeText }),
        }
      }),
    }
    this.settle(requestId, value)
    return true
  }

  private settle(id: string, value: unknown, voidAs?: VoidReason): void {
    const item = this.pending.get(id)
    if (!item) return
    this.pending.delete(id)
    if (item.timer !== undefined) this.clock.clearTimeout(item.timer)
    // 只有"不是手机自己点的"才需要作废：那种情况下手机上那张卡还亮着，而它已经没用了。
    if (voidAs) this.voidStaleCard(id, item, voidAs)
    item.resolve(value)
  }

  /**
   * 让手机上那张已经作废的卡片**当场**收掉：按 `requestId` 发一条精确帧，
   * 再补一帧 `ev.run_state` —— 两条各管一件事，不是"为兼容老手机"。
   *
   * - `ev.permission_resolved` / `ev.question_resolved`：按 `requestId` 收单，
   *   精确收掉**这一张**（`chat.js` 的 `_onPermissionResolved` / `_onQuestionResolved`）。
   * - `ev.run_state`：**这一回合此刻到底在不在跑**。内核不会为"审批被别人答掉了"
   *   发状态跳变（这一回合自始至终是 running），所以这一帧只能由我们补发；
   *   手机上的"思考中"跟着它走。
   *
   * 补的是**当前真相**而不是硬编码 `running`：发错方向会一直错到下一次真实跳变。
   * 读不到真相时退回缓存快照，再退 `idle`：宁可少一个转圈，不能凭空多一个转圈。
   */
  private voidStaleCard(requestId: string, item: PendingInteraction, reason: VoidReason): void {
    // `by` 说的是"谁收的场"，不是答案本身：手机只按"要不要收掉这张卡"读它。
    const by = reason === 'desktop' ? 'desktop' : 'cancelled'
    this.replyTo(
      item.conversationId,
      item.kind === 'approval'
        ? permissionResolved({ requestId, sessionId: item.sessionId, by })
        : questionResolved({ requestId, sessionId: item.sessionId, by }),
    )
    const emit = (running: boolean): void => {
      this.broadcast(runState({ sessionId: item.sessionId, state: running ? 'running' : 'idle' }))
      this.log('pending card voided', { requestId, reason, kind: item.kind, state: running ? 'running' : 'idle' })
    }
    void this.kernel
      .runState(item.sessionId)
      .then((truth) => emit(truth.running))
      .catch(() => {
        emit(this.sessions.some((session) => session.id === item.sessionId && session.running === true))
      })
  }

  /**
   * 把还挂着的审批/提问按原样重发一遍（调用方是 `peer-joined`）。
   *
   * 为什么需要：审批/提问卡是"一次性、单会话、只在 chat 页"的一帧——手机退后台、
   * 断线、停在列表页或别的会话时，这一帧过去就没了，而主机那边还阻塞着等决定
   * （审批 180 秒、提问 300 秒）。重配对回来后手机永远收不到，超时后还会被结算点
   * 主动擦掉。重发补的就是这一帧。
   *
   * 为什么用**同一个 requestId**：手机按 requestId 收卡（`_onPermissionResolved` /
   * `_onQuestionResolved`）与覆盖同卡——重发落在已经有这张卡的手机上只是原地重写，
   * 不会翻倍；结算点（超时/桌面先答/撤回）发精确作废帧时新旧两份一起收，不留幽灵卡。
   *
   * 三条纪律：
   * 1. 只重发 `pending` 里还挂着的：已结算的早被 `settle()` 删掉了，不会复活；
   * 2. **不再有"到期时刻"要顺延**（2026-10-11 起）：帧里不带 `expiresAt`，手机也不显示
   *    倒计时（协议里那个字段本来就可选，见 `payloads.ts`）。在有期限的那些版本里，
   *    这里必须用**最初那一帧**的值而不是重发时刻重算的——那个坑已连同期限一起删掉；
   * 3. 永不抛：这一路走在配对流程里，任何一行炸了都只记一条日志，不能断掉配对。
   */
  replayPending(conversationId: string): number {
    if (!this.transport.hasClient(conversationId)) return 0
    let replayed = 0
    // 同上：筛选口径走 `pendingEntries`（这里 `sessionId` 缺省 ⇒ 全部会话都补）
    for (const [id, item] of this.pendingEntries(undefined)) {
      try {
        // 重配对时通道换了：旧 conversationId 已经作废，后续的结算作废帧要发到新通道。
        item.conversationId = conversationId
        const frame = this.buildPendingFrame(id, item)
        if (!frame) continue
        this.replyTo(conversationId, frame)
        replayed += 1
      } catch (error) {
        this.log('pending replay failed', { requestId: id, message: messageOf(error) })
      }
    }
    if (replayed > 0) this.log('pending replayed', { conversationId, count: replayed })
    // 与 `cmd.get_pending` 那条**同一个计数**：两条路（手机来问 / 主机在 peer-joined 上主动补）
    // 重放出去的是同一种帧，排错时不该因为走的哪条路而给出两个数。
    this.getPendingCount.replayed += replayed
    return replayed
  }

  /**
   * 把一条挂起的等待拼回它最初的那一帧（`cmd.get_pending` 与 `replayPending` 共用）。
   *
   * 同一 requestId、同一内容——手机按 requestId 覆盖，
   * 重发落在已有卡的手机上只是原地重写。提问的 questions 为空时不拼：
   * 空数组的提问卡在手机上是一张只有输入框的卡，与"有选项但都不可选"长得一样，
   * 发出去是假事实（首帧不可能为空——内核问的时候一定带了题）。
   */
  private buildPendingFrame(id: string, item: PendingInteraction): EvPayload | null {
    if (item.kind === 'approval') {
      return permissionRequest({
        // 原样重发账本里那份到期时刻，**不重算** —— 顺延等于骗手机的倒计时。
        ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
        requestId: id,
        sessionId: item.sessionId,
        action: item.action ?? '操作',
        ...(item.reason === undefined ? {} : { reason: item.reason }),
        options: APPROVAL_OPTIONS,
      })
    }
    if (!item.options || item.options.length === 0) return null
    return questionRequest({
      ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
      requestId: id,
      sessionId: item.sessionId,
      questions: item.options,
    })
  }

  /**
   * 挑一条配对通道把这轮交互发出去。
   *
   * 为什么不能按 sessionId 精确定位：手机是在**配对通道**上收消息的，
   * 而"哪个 DSH 会话属于哪条通道"只有手机端知道（它按 payload.sessionId 过滤显示）。
   * 现网拓扑恒为 1 host : 1 client，所以"挑一条有对端的通道"就是正解；
   * 将来若真要一个主机配多部手机，需要的是**广播给所有通道**再让手机按 sessionId 过滤。
   */
  private pickConversation(_sessionId: string): string | undefined {
    const ids = this.transport.conversationIds()
    if (ids.length === 0) return undefined
    return ids.find((id) => this.transport.hasClient(id)) ?? ids[0]
  }

  private log(message: string, fields?: Record<string, string | number | boolean | undefined>): void {
    this.options.log?.(message, fields)
  }
}

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

/**
 * `KernelEvent` → 历史条目。
 *
 * 运行态 / 标题 / 列表变化在历史里没有位置——它们是"此刻"的事，回放历史不该去改顶栏；
 * 返回 `undefined` 由调用方丢掉。**待办例外**（2026-10-05）：它是全量快照，
 * 一页里最后一条就是那一页截止时的清单，回放它进一条跑过的会话也看得见待办。
 *
 * `done` 恒为 `true`：历史里的消息是**已经写完的**。不置的话手机上正文末尾会挂着一个
 * 一直闪的光标，看起来像还在生成。
 */
function historyWireItem(event: KernelEvent): HistoryItem | undefined {
  if (event.kind === 'delta') {
    return messageDelta({
      messageId: event.messageId,
      delta: event.text,
      done: true,
      ...(event.role === undefined ? {} : { role: event.role }),
    })
  }
  if (event.kind === 'todo') {
    return todoList({ todos: event.todos })
  }
  if (event.kind === 'tool') {
    return toolEvent({
      callId: event.callId,
      phase: event.phase,
      ...(event.tool === undefined ? {} : { tool: event.tool }),
      ...(event.title === undefined ? {} : { title: event.title }),
      ...(event.argsPreview === undefined ? {} : { argsPreview: event.argsPreview }),
      ...(event.resultPreview === undefined ? {} : { resultPreview: event.resultPreview }),
    })
  }
  return undefined
}
