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
import { messageOf } from '../shell/log-line.js'
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
  StatusDigest,
} from '@dsh-remote/protocol'
import { appendFileNote, MAX_ATTACH_TOTAL_BYTES, saveFileAttachments } from '../shell/uploads.js'
import { APPROVAL_OPTIONS as APPROVAL_OPTIONS_ZH } from '../copy/zh.js'
import { PLUGIN_VERSION } from '../version.js'
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
import type { NotifyItem } from '@dsh-remote/protocol'
import type {
  ApprovalDecision,
  ApprovalOutcomeValue,
  AskUserQuestionAnswerValue,
  KernelEvent,
  KernelPort,
} from '../ports/index.js'
import { HISTORY_WINDOW_EXCEEDED } from '../ports/index.js'
import { DeltaWindow, DEFAULT_WINDOW_OPTIONS, type WindowOptions } from './window.js'
import { createKernelEventHandler, RUN_OUTPUT, historyWireItem } from './kernel-events.js'
import { createInteractions, type PendingInteraction, type VoidReason } from './interactions.js'
import type { KeepAwake } from './sleep-policy.js'
import type { Clock } from '../ports/index.js'

/** 出站通道：core 只负责"该发什么"，加密与投递由 shell 提供。 */
export interface RuntimeTransport {
  /** 发给某一条配对会话（回执用）。返回 false 表示没有活的对端。 */
  reply(conversationId: string, payload: EvPayload): boolean
  /**
   * 发给所有已配对的会话（会话列表、防休眠状态这类广播）。返回**收到这条广播的会话数**，0 表示没发出去。
   *
   * `opts.includeNoClient`（P1-3 后半步）：**run 输出**在没有活客户端的会话上也要上线
   * （中继环形缓冲接住、重连补投）。周期状态帧不带它 —— 判据是"这一帧是不是
   * `RUN_OUTPUT`"（内核事件管道转发的那些），见那边的注释。
   */
  broadcast(payload: EvPayload, opts?: { includeNoClient?: boolean }): number
  /** 此刻是否有能收这条会话消息的对端（审批要不要认领的判据）。 */
  hasClient(conversationId: string): boolean
  /** 当前活跃的配对会话 id。 */
  conversationIds(): string[]
  /**
   * 登记状态摘要（M2，REVIEW §5.1）：控制面**明文**帧，发给中继存"最后已知"。
   *
   * 与 `broadcast` 的关键差别：**不看有没有活客户端** —— 摘要的消费者恰恰是
   * "手机不在的那段时间"（中继存着，回头给手机回放），没人听才是它要登记的时刻。
   * 返回送达的会话数（本地记账，不是送达回执）。
   */
  pushSummary(digest: StatusDigest): number
  /**
   * 中继支持通知面吗（`notify.v1`，2026-10-27）。
   *
   * **按声明开**：老中继返回 false ⇒ 主机**连提醒定时器都不挂**
   * （老中继解析不了 `notify-approval`，发了只会换来 `unknown_frame`）。
   */
  supportsNotify?(): boolean
  /**
   * 发一帧 `notify-approval`（host → relay 的**明文控制帧**）。
   *
   * 可选：没实现这一条的老宿主 ⇒ 提醒那一路整体不存在（不是"发了没反应"）。
   */
  notifyApproval?(conversationId: string, items: NotifyItem[]): boolean
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

export class HostRuntime {
  private readonly options: RuntimeOptions
  private readonly window: DeltaWindow

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

  /**
   * ⚠️ 这里原来还有一个"手机上此刻有清单的会话"的有界 Set（`todo/write` 发过非空清单
   * 就记下、用来在下一轮开始时**补一帧空快照**）。它连同那段合成逻辑一起在
   * 2026-10-11 用户裁决时删掉了（"生命周期跟随 host"）：内核**确实会**发空清单，
   * 自己再合成一帧是**双重清空**，而且依据的是"上一轮有过清单"这个已经过期的事实。
   * 详见下面 `case 'run-state'` 里那段注释。
   *
   * 注释留在这里是说清"删了什么、为什么删"，免得下一个人看见 run-state 里
   * 那段"刻意不清空"觉得是漏了。
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
  /** 工具步数（M2 状态摘要的 `steps`）：进程启动以来的累计，只加不减。 */
  private stepsDone = 0

  constructor(
    private readonly kernel: KernelPort,
    private readonly transport: RuntimeTransport,
    private readonly sleep: KeepAwake,
    private readonly clock: Clock,
    options: Partial<RuntimeOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options }
    this.window = new DeltaWindow((delta) => this.broadcast(delta, RUN_OUTPUT), this.clock, {
      ...DEFAULT_WINDOW_OPTIONS,
      ...options.window,
    })
    /**
     * **挂起卡全链**（v5 R4b 抽出 → `core/interactions.ts`，行为零变化）。
     * 审批/提问的请求入口、结算三档、作废、重放、诊断都住那个模块。
     */
    this.interactions = createInteractions({
      clock: this.clock,
      log: (message, fields) => this.options.log?.(message, fields),
      replyTo: (conversationId, payload) => this.replyTo(conversationId, payload),
      broadcast: (payload, opts) => this.broadcast(payload as never, opts),
      hold: (id) => this.sleep.hold(id),
      releaseHold: (id) => this.sleep.releaseHold(id),
      kernelRunState: (sessionId) => this.kernel.runState(sessionId),
      sessionRunningFallback: (sessionId) =>
        this.sessions.some((session) => session.id === sessionId && session.running === true),
      pickConversation: (_sessionId) => {
        const ids = this.transport.conversationIds()
        if (ids.length === 0) return undefined
        return ids.find((id) => this.transport.hasClient(id)) ?? ids[0]
      },
      hasClient: (conversationId) => this.transport.hasClient(conversationId),
      conversationIds: () => this.transport.conversationIds(),
      // 通知面（2026-10-27）：按声明开。老中继 ⇒ 不挂定时器。
      supportsNotify: () => this.transport.supportsNotify?.() === true,
      notifyApproval: (conversationId, items) => this.transport.notifyApproval?.(conversationId, items) ?? false,
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
      this.unsubscribe = this.kernel.subscribe((event) => this.kernelEvents(event))
    } catch (error) {
      this.log('kernel subscribe failed', { message: messageOf(error) })
      return
    }
    try {
      const detach = this.kernel.attachInteractionSink?.({
        approval: (info) => this.interactions.onApprovalRequest(info),
        question: (info) => this.interactions.onQuestionRequest(info),
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
    this.interactions.withdrawAll()
    // 「本次会话内始终允许」的记表与 pending 同生命周期：出了这个进程就失效。
    // 不清的话，下一次 `apply()` 复用同一个 runtime 实例时会把上一段会话的授权带过来
    //——而那正是这个功能**承诺不做**的事（§9.1：scope 是本次会话内）。
    this.interactions.clearSessionAllowed()
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
          const settled = this.interactions.settleApproval(cmd.requestId, cmd.decision)
          reply(settled, settled ? {} : { message: '这个审批请求已经不在挂起状态' })
          void this.pushSessions('permission').catch(() => {})
          return
        }
        case 'cmd.answer': {
          const settled = this.interactions.settleQuestion(cmd.requestId, cmd.answers)
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
          const replayed = this.interactions.handleGetPending(conversationId, cmd.sessionId)
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

  /** 挂起卡那条链的可观测读数（委托 → `interactions`）。 */
  get pendingAsks(): {
    now: number
    oldestSec: number
    getPendingCalls: number
    getPendingReplayed: number
    lastGetPendingReplayed: number | null
    lastGetPendingPending: number | null
    lastGetPendingAgoSec: number | null
  } {
    return this.interactions.pendingAsks
  }

  get alwaysAllowedHits(): number {
    return this.interactions.alwaysAllowedHits
  }

  get declined(): { noClient: number; offlineHold: number; aborted: number } {
    return this.interactions.declined
  }

  /** 有几件事正挂在手机上等回答（委托 → `interactions`）。 */
  get waiting(): { count: number; oldestSec: number } {
    return this.interactions.waiting
  }

  /** 某条会话此刻有没有人在等它（委托 → `interactions`，给 carrier 用）。 */
  pendingKindForSession(sessionId: string): 'approval' | 'question' | undefined {
    return this.interactions.pendingKindForSession(sessionId)
  }

  /** 把还挂着的审批/提问按原样重发一遍（委托 → `interactions`）。 */
  replayPending(conversationId: string): number {
    return this.interactions.replayPending(conversationId)
  }

  private countOutbound(payload: EvPayload, sent?: boolean): void {
    const key = payload.t.replace(/^ev\./, '')
    this.outboundCount[key] = (this.outboundCount[key] ?? 0) + 1
    if (sent === false) this.outboundCount[`${key}_no_peer`] = (this.outboundCount[`${key}_no_peer`] ?? 0) + 1
  }

  private broadcast(payload: EvPayload, opts?: { includeNoClient?: boolean }): void {
    // 广播也要报"有没有人收到"：只数帧不数对端，就会在真机上出现
    // "计数说发了 4 帧、手机一帧都没收到"这种无从对账的局面。
    // ⚠️ `RUN_OUTPUT` 的帧即使没人听也算"发出去了"（环在收，重连补投）——
    // 那种情形记 `_no_peer` 是假账，语义见 `transport.broadcast` 的注释。
    this.countOutbound(payload, this.transport.broadcast(payload, opts) > 0)
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
      /**
       * `pluginVersion` 是**本包自己的**版本，所以不进 `hostMeta`（那是平台信息，
       * 注入它是为了让单测能钉住 `state.sleep` 的推导）。版本没有"注入"这回事 ——
       * 报别人的版本等于骗手机。
       *
       * 手机拿它做"电脑上的插件太旧"的提示（规范 §13.2 / 2026-10-21）。
       */
      host: { ...meta, carrier: this.kernel.carrier, pluginVersion: PLUGIN_VERSION },
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
   * - "（重）连上"由 `index.ts` 的 `onClientRejoined` 触发 —— 它的语义是
   *   "**这台手机的密钥面现在可以用来推东西了**"（重连回到自己的会话、以及 3.2 起
   *   刚配对完的那一帧，两个触发点都在那一处）。
   *   ⚠️ **不要在 `onPeerJoined` 里调它**（2026-10-21 订正）：3.2 的 psk 要等用户
   *   比对完 6 位数字才装进手机，而 `peer-joined` 早于 `pair-grant` —— 那一刻发出去的
   *   密文手机上 `kH2C` 还是 null，静默丢弃，连"解密失败"都不记。
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

  /**
   * **内核事件 → 线帧的翻译层**（v5 R4a 抽出 → `core/kernel-events.ts`，行为零变化）。
   * 合帧、顺序、run-state"刻意不清空"的纪律都住那个模块。
   */
  private readonly interactions: ReturnType<typeof createInteractions>
  private readonly kernelEvents = createKernelEventHandler({
    window: {
      push: (sessionId, messageId, text, role) => this.window.push(sessionId, messageId, text, role),
      complete: (sessionId, messageId, role) => this.window.complete(sessionId, messageId, role),
      flushSession: (sessionId) => this.window.flushSession(sessionId),
    },
    sleep: { markActive: () => this.sleep.markActive() },
    broadcast: (payload, opts) => this.broadcast(payload as never, opts),
    rememberModel: (sessionId, model, provider) => this.rememberModel(sessionId, model, provider),
    broadcastModel: (sessionId, model, provider) => this.broadcastModel(sessionId, model, provider),
    pushSessions: (reason) => {
      void this.pushSessions(reason).catch(() => {})
    },
    noteStep: () => {
      this.stepsDone += 1
    },
  })

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
      // 状态摘要跟在列表推送尾部（M2，REVIEW §5.1「插件在 run_state / 列表推送时
      // 带上摘要」）：pushSessions 是"状态变了就推"的唯一汇聚点，挂在它身上
      // 就覆盖了 prompt / interrupt / permission / run-state / 周期兜底全部入口。
      this.flushStatusSummary()
      return this.sessions
    } catch (error) {
      this.log('push sessions crashed', { message: messageOf(error), reason })
      return this.sessions
    }
  }

  /**
   * 推一次状态摘要（M2）——零知识边界上唯一的明文业务面。
   *
   * 字段只有状态类（时刻/布尔/非负整数），**一个自由文本都不许有**：摘要会
   * 明文落到中继盘上，自由文本一进来就是内容侧漏（§5.1 风险条）。协议侧
   * `statusDigest` 是 strict 白名单，这里组装时也只从**计数与状态**取值：
   *   · at —— 此刻（"最后已知于 X" 的 X）；
   *   · running —— 列表里有没有活着的会话（"正在跑还是已停"）；
   *   · steps —— 工具步数累计（"跑到第几步"）；
   *   · pending —— 挂起的审批/提问（"要不要我批"）。
   */
  private flushStatusSummary(): void {
    const digest: StatusDigest = {
      at: this.clock.now(),
      running: this.sessions.some((s) => s.running === true),
      steps: this.stepsDone,
      pending: this.interactions.waiting.count,
    }
    // 发送失败只丢这一次（下次推送还会带）：摘要是幂等快照，不是事件流。
    this.transport.pushSummary(digest)
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

  private log(message: string, fields?: Record<string, string | number | boolean | undefined>): void {
    this.options.log?.(message, fields)
  }
}
