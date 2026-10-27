/**
 * interactions —— 挂起卡全链：审批/提问的请求入口、结算三档、作废、重放、诊断（v5 R4b 从
 * `runtime.ts` 抽出）。
 *
 * 这条链上的每一段都有"不做就会坏"的理由（2026-10-06/09/10/11 的真机事故逐条写在
 * 各自的注释里）。核心纪律：
 * - **手机离线照样挂账**（不当场拒）——回来时 `replayPending` 补投；
 * - **不自己设期限**——桌面等多久手机就等多久（2026-10-11 用户裁决）；
 * - **跨类结算必须拒**——审批与提问共用一张 pending 表，id 拿错类不许结算；
 * - **两条重放路共用同一筛选口径**（`pendingEntries`）——否则"帧丢了"是假结论。
 *
 * ⚠️ **行为零变化**（R4 纪律）：判据一片未动照样全绿。
 */
import type { AnswerItem, EvPayload, NotifyItem, QuestionItem } from '@dsh-remote/protocol'
import {
  permissionRequest,
  permissionResolved,
  questionRequest,
  questionResolved,
  runState,
} from '@dsh-remote/protocol/outbound'
import { randomUUID } from 'node:crypto'
import { messageOf } from '../shell/log-line.js'
import type { Clock } from '../ports/index.js'
import type { ApprovalDecision, ApprovalOutcomeValue, AskUserQuestionAnswerValue } from '../ports/index.js'
import { APPROVAL_OPTIONS as APPROVAL_OPTIONS_ZH } from '../copy/zh.js'
import { RUN_OUTPUT } from './kernel-events.js'

export type VoidReason = 'desktop' | 'withdrawn' | 'timeout'

/**
 * 挂起多久之后才发提醒（毫秒）。
 *
 * **60 秒**（2026-10-27 用户裁决：原方案的 3 分钟改为 1 分钟）。
 *
 * 为什么这么短：用户是在**电脑前**等着审批的人 —— 他离开电脑去做别的事，
 * 一分钟之内还会回来看看；发通知的窗口越短，"我刚走开就收到提醒"的概率越高，
 * 而误发的代价（额度是**一次性**的）由频控（10 分钟冷却 / 3 条每小时）兜着。
 */
export const NOTIFY_DELAY_MS = 60_000

export interface PendingInteraction {
  conversationId: string
  sessionId: string
  resolve: (value: unknown) => void
  timer?: unknown
  /**
   * 提醒定时器（2026-10-27）：挂起满 `NOTIFY_DELAY_MS` 后若**手机不在线**就发通知。
   *
   * 与 `timer`（宿主给的期限）是**两回事**：`timer` 到点是**结算**这张卡，
   * `notifyTimer` 到点是**提醒**用户 —— 两者互不替代，都要在 `settle()` 里清掉。
   */
  notifyTimer?: unknown
  /** 这张卡**已经触发过**通知（一次性）。 */
  notified?: boolean
  expiresAt?: string
  options?: QuestionItem[]
  kind: 'approval' | 'question'
  askedAt: number
  action?: string
  reason?: string
}

export interface InteractionsDeps {
  clock: Clock
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  /** 发一帧到指定通道（走 runtime 的计数出站口）。 */
  replyTo(conversationId: string, payload: EvPayload): void
  /** 广播一帧（RUN_OUTPUT 的帧即使没人听也算发出去了）。 */
  broadcast(payload: EvPayload, opts?: { includeNoClient?: boolean }): void
  /** 防休眠挂锁（挂起期间机器不睡）。 */
  hold(id: string): void
  releaseHold(id: string): void
  /** `voidStaleCard` 的真相读取：这一回合此刻到底在不在跑。 */
  kernelRunState(sessionId: string): Promise<{ running: boolean }>
  /** 读不到真相时的兜底：缓存快照里这条会话在不在跑。 */
  sessionRunningFallback(sessionId: string): boolean
  /** 挑一条配对通道（现网恒为 1 host : 1 client）。 */
  pickConversation(_sessionId: string): string | undefined
  /** `transport.hasClient`：这条通道上此刻有没有活对端。 */
  hasClient(conversationId: string): boolean
  /** `transport.conversationIds()`：台上的全部通道。 */
  conversationIds(): string[]
  /**
   * 中继支持通知面吗（按声明开，`notify.v1`）。
   *
   * ⚠️ **老中继返回 false**：那时不但发不出去，连发帧都会被回一句
   * `unknown_frame`（给两端刷错误）。⇒ 这种情况**连定时器都不挂**。
   */
  supportsNotify(): boolean
  /**
   * 发一帧 `notify-approval`（host → relay 的**明文控制帧**，不走加密信封）。
   *
   * 返回 false = 没发出去（通道没了/老中继）。**没有回执**（v1 不做失败重试），
   * 所以主机这边靠"这张卡通知过了"的标记去重。
   */
  notifyApproval?(conversationId: string, items: NotifyItem[]): boolean
}

export interface Interactions {
  onApprovalRequest(info: {
    sessionId: string
    action: string
    reason?: string
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<ApprovalDecision>
  onQuestionRequest(info: {
    sessionId: string
    questions: QuestionItem[]
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<AskUserQuestionAnswerValue | null>
  settleApproval(requestId: string, decision: string): boolean
  settleQuestion(requestId: string, answers: AnswerItem[]): boolean
  replayPending(conversationId: string): number
  pendingKindForSession(sessionId: string): 'approval' | 'question' | undefined
  /** `cmd.get_pending` 的完整处理（计数 + 重放），调用方只管回执。 */
  handleGetPending(conversationId: string, sessionId: string | undefined): number
  /** `stop()` 时把挂着的全部收场（'withdrawn' = 主机要退了）。 */
  withdrawAll(): void
  /** 「始终允许」记表与 pending 同生命周期：出了这个进程就失效。 */
  clearSessionAllowed(): void
  readonly pendingAsks: {
    now: number
    oldestSec: number
    getPendingCalls: number
    getPendingReplayed: number
    lastGetPendingReplayed: number | null
    lastGetPendingPending: number | null
    lastGetPendingAgoSec: number | null
  }
  readonly waiting: { count: number; oldestSec: number }
  readonly declined: { noClient: number; offlineHold: number; aborted: number }
  readonly alwaysAllowedHits: number
  /** 供 `cmd.get_pending` 之外的路径读 pending 条目（如将来的诊断）。 */
  pendingEntries(sessionId: string | undefined): Array<[string, PendingInteraction]>
  buildPendingFrame(id: string, item: PendingInteraction): EvPayload | null
}

export function createInteractions(deps: InteractionsDeps): Interactions {
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
    /** 提醒定时器（2026-10-27）：见导出那份的同名注释。 */
    notifyTimer?: unknown
    /** 这张卡已经触发过通知（一次性）。 */
    notified?: boolean
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

  /**
   * 「始终允许」记忆表（`sessionAllowed`）的容量上限（Optional⑤，2026-10-22）。
   *
   * **刻意不按会话列表裁剪**：列表是 LIMIT 截断的（`LISTING_LIMIT`），一条批准过的
   * 旧会话掉出前 100 就会被误删——`rememberModel` 的注释里钉着同一条判例。
   * 与 `MODEL_CACHE_MAX` / `RelayClient.voided` / `PairingSlots` 同一套有界纪律：
   * 容量满时淘汰最久没被用过的那条（命中即重新入队）。
   */
  const SESSION_ALLOWED_MAX = 256

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

  const pending = new Map<string, PendingInteraction>()

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
  const sessionAllowed = new Map<string, ApprovalOutcomeValue>()

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
  let sessionAllowedHits = 0

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
  const interactionDeclines = { noClient: 0, offlineHold: 0, aborted: 0 }

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
  function pendingAsks(): {
    now: number
    oldestSec: number
    getPendingCalls: number
    getPendingReplayed: number
    lastGetPendingReplayed: number | null
    lastGetPendingPending: number | null
    lastGetPendingAgoSec: number | null
  } {
    const { count, oldestSec } = waiting()
    const last = getPendingCount.last
    return {
      now: count,
      oldestSec,
      getPendingCalls: getPendingCount.calls,
      getPendingReplayed: getPendingCount.replayed,
      lastGetPendingReplayed: last === null ? null : last.replayed,
      lastGetPendingPending: last === null ? null : last.pending,
      lastGetPendingAgoSec:
        getPendingCount.lastAt === null
          ? null
          : Math.max(0, Math.floor((deps.clock.now() - getPendingCount.lastAt) / 1000)),
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
  function pendingEntries(sessionId: string | undefined): Array<[string, PendingInteraction]> {
    const out: Array<[string, PendingInteraction]> = []
    for (const [id, item] of pending) {
      if (sessionId !== undefined && item.sessionId !== sessionId) continue
      out.push([id, item])
    }
    return out
  }

  const getPendingCount = {
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
  function waiting(): { count: number; oldestSec: number } {
    const now = deps.clock.now()
    let oldest = 0
    for (const item of pending.values()) {
      const age = Math.max(0, Math.floor((now - item.askedAt) / 1000))
      if (age > oldest) oldest = age
    }
    return { count: pending.size, oldestSec: oldest }
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
  function pendingKindForSession(sessionId: string): 'approval' | 'question' | undefined {
    let approval = false
    let question = false
    for (const item of pending.values()) {
      if (item.sessionId !== sessionId) continue
      if (item.kind === 'approval') approval = true
      else question = true
    }
    return approval ? 'approval' : question ? 'question' : undefined
  }

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
  async function onApprovalRequest(info: {
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
    const conversationId = deps.pickConversation(info.sessionId)
    if (!conversationId) {
      // ⚠️ **一台手机都没配过**（`conversationIds()` 为空）⇒ 交还桌面。
      // 纯桌面用户从来没打算在手机上答，让他们每次审批白等 180 秒是错的。
      interactionDeclines.noClient += 1
      deps.log('approval dropped before any frame: no conversation at all', {
        sessionId: info.sessionId,
        conversations: deps.conversationIds().length,
      })
      return 'decline'
    }
    if (!deps.hasClient(conversationId)) {
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
      interactionDeclines.offlineHold += 1
      deps.log('approval held while the paired phone is offline; it will be replayed on reconnect', {
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
      interactionDeclines.aborted += 1
      deps.log('approval already withdrawn by the platform, handing back to the desktop', {
        sessionId: info.sessionId,
        reason: String(info.signal.reason ?? ''),
      })
      return 'decline'
    }
    const id = `ap_${randomUUID().slice(0, 8)}`
    deps.hold(id)
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
    const remembered = sessionAllowed.get(scope)
    if (remembered) {
      // 这一格必须在**返回之前**记：命中即返回，之后再没有别的语句会执行到。
      sessionAllowedHits += 1
      // 命中刷新队尾（有界淘汰的另一半）：常用的记忆不该因为"登记得早"被挤掉。
      sessionAllowed.delete(scope)
      sessionAllowed.set(scope, remembered)
      deps.log('approval answered by session-scoped allow-list', { sessionId: info.sessionId, action: info.action })
      return remembered
    }
    // `return await` + finally：executor 里抛出（或 resolve 路径的任何异常）都不会让
    // releaseHold 被跳过 —— 旧写法里一次抛出就是一条永久泄漏的挂锁（机器再也不睡）。
    try {
      // **有期限才设**：宿主没给就不设（见上面那段长注）。与提问那条逐字同形。
      const hostTimeout = hostTimeoutMs(info.timeoutMs)
      // 时刻走注入时钟（与 oldestSec 同一条纪律：FakeClock 要能演「到期」，见 349 行注释）。
      const expiresAt = hostTimeout ? new Date(deps.clock.now() + hostTimeout).toISOString() : undefined
      return await new Promise<ApprovalDecision>((resolve) => {
        const timer = hostTimeout
          ? deps.clock.setTimeout(() => {
              settle(id, 'decline', 'timeout')
            }, hostTimeout)
          : undefined
        const item: PendingInteraction = {
          conversationId,
          sessionId: info.sessionId,
          resolve: (value) => resolve(value === undefined ? 'decline' : (value as ApprovalDecision)),
          ...(timer === undefined ? {} : { timer }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          kind: 'approval',
          askedAt: deps.clock.now(),
          action: info.action,
          reason: info.reason,
        }
        pending.set(id, item)
        armNotifyTimer(id, item)
        // `reason` 是 `carrier-services.participate()` 打的标记：'desktop' = 桌面先答了，
        // 其余（'platform'）是宿主自己把这次请求撤了。两种都要让手机把卡收掉，
        // 但说出来的话不一样。
        info.signal?.addEventListener(
          'abort',
          () => settle(id, 'cancelled', info.signal?.reason === 'desktop' ? 'desktop' : 'withdrawn'),
          { once: true },
        )
        deps.replyTo(
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
      deps.releaseHold(id)
    }
  }

  async function onQuestionRequest(info: {
    sessionId: string
    questions: QuestionItem[]
    signal?: AbortSignal
    /** 与审批那个 `timeoutMs` 逐字同形：有就跟随，没有就不自己加。 */
    timeoutMs?: number
  }): Promise<AskUserQuestionAnswerValue | null> {
    const conversationId = deps.pickConversation(info.sessionId)
    if (!conversationId) {
      // 与审批那条**逐字同形**：一台手机都没配过 ⇒ 交还桌面（纯桌面用户不该白等 300 秒）。
      interactionDeclines.noClient += 1
      deps.log('question dropped before any frame: no conversation at all', {
        sessionId: info.sessionId,
        conversations: deps.conversationIds().length,
      })
      return null
    }
    if (!deps.hasClient(conversationId)) {
      // 与审批那条**逐字同形**：配过手机但不在线 ⇒ 照样挂账，手机回来时由 `replayPending` 推给它。
      // 两条必须一起改 —— 只改审批的话，提问仍然"离线即消失"，而它们在主机是同一份 `pending`、
      // 同一个命令、同一段补拉（见 `cmd.get_pending` 的处理）。
      interactionDeclines.offlineHold += 1
      deps.log('question held while the paired phone is offline; it will be replayed on reconnect', {
        sessionId: info.sessionId,
        conversationId,
      })
    }
    // 与审批同一条：**已经 abort 的 signal 永远不会再触发监听器**，所以必须在
    // hold 与首帧之前判掉，否则手机上是 300 秒的死卡、挂锁也一直挂着（见审批那里的取证）。
    if (info.signal?.aborted) {
      interactionDeclines.aborted += 1
      deps.log('question already withdrawn by the platform, handing back to the desktop', {
        sessionId: info.sessionId,
        reason: String(info.signal.reason ?? ''),
      })
      return null
    }
    const id = `q_${randomUUID().slice(0, 8)}`
    deps.hold(id)
    // 与审批**逐字同形**：也不设期限，两处必须一起改（理由见审批那条的整段注）。
    // `return await` + finally：releaseHold 与 hold 必须一一对应（同审批那条的理由）。
    try {
      const hostTimeout = hostTimeoutMs(info.timeoutMs)
      // 时刻走注入时钟（与 oldestSec 同一条纪律：FakeClock 要能演「到期」，见 349 行注释）。
      const expiresAt = hostTimeout ? new Date(deps.clock.now() + hostTimeout).toISOString() : undefined
      return await new Promise<AskUserQuestionAnswerValue | null>((resolve) => {
        const timer = hostTimeout
          ? deps.clock.setTimeout(() => {
              settle(id, null, 'timeout')
            }, hostTimeout)
          : undefined
        const item: PendingInteraction = {
          conversationId,
          sessionId: info.sessionId,
          resolve: (value) => resolve((value as AskUserQuestionAnswerValue | undefined) ?? null),
          ...(timer === undefined ? {} : { timer }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          options: info.questions,
          kind: 'question',
          askedAt: deps.clock.now(),
        }
        pending.set(id, item)
        armNotifyTimer(id, item)
        // 与审批那条同样：'desktop' 是桌面先答，其余是宿主自己撤了这次请求。
        info.signal?.addEventListener(
          'abort',
          () => settle(id, null, info.signal?.reason === 'desktop' ? 'desktop' : 'withdrawn'),
          { once: true },
        )
        deps.replyTo(
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
      deps.releaseHold(id)
    }
  }

  function settleApproval(requestId: string, decision: string): boolean {
    const item = pending.get(requestId)
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
      const scope = approvalScopeOf(item.sessionId, item.action)
      // 命中就重新插到队尾：容量满时淘汰的是**最久没被用过**的那条（rememberModel 同款）。
      sessionAllowed.delete(scope)
      sessionAllowed.set(scope, outcome)
      while (sessionAllowed.size > SESSION_ALLOWED_MAX) {
        const oldest = sessionAllowed.keys().next()
        if (oldest.done) break
        sessionAllowed.delete(oldest.value)
      }
    }
    settle(requestId, outcome)
    return true
  }

  function settleQuestion(requestId: string, answers: AnswerItem[]): boolean {
    const item = pending.get(requestId)
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
    settle(requestId, value)
    return true
  }

  /**
   * 挂上提醒定时器（2026-10-27）。
   *
   * ## 为什么要有它
   *
   * 审批/提问挂起时，手机**可能不在**（用户去干别的了）。而这恰恰是最需要他的时刻
   * —— 桌面那一半只能干等（不设期限），用户回到电脑前才发现"刚才有个审批没答"。
   * ⇒ 挂起满 `NOTIFY_DELAY_MS`（60 秒）还没结算，就发一条微信服务通知。
   *
   * ## 四条纪律
   *
   * ① **按声明开**：中继没声明 `notify.v1` ⇒ **连定时器都不挂**（老中继会回
   *    `unknown_frame`，发了就是给两端刷错误）。
   * ② **在线不发**（v1）：手机此刻在线的话，它本来就能看到卡 ⇒ 通知是多余的。
   * ③ **一张卡一条**：标记 `notified`，聚合成一条（同会话的审批+提问打包）。
   * ④ **不重试、不补发**：发完就完；主机重启后 pending 本身已丢，不会恢复提醒。
   */
  function armNotifyTimer(id: string, item: PendingInteraction): void {
    if (!deps.supportsNotify()) return
    const timer = deps.clock.setTimeout(() => {
      onNotifyDue(id)
    }, NOTIFY_DELAY_MS)
    item.notifyTimer = timer
  }

  /**
   * 提醒定时器到点（2026-10-27）。
   *
   * 五步（顺序有讲究）：① 卡还在吗 ② 手机在线吗 ③ 收集同会话里未通知的卡
   * ④ 全部标记 notified ⑤ 发一帧。
   *
   * ⚠️ **④ 在 ⑤ 之前**：标记在前 ⇒ 同一张卡绝不会被两条定时器各发一次
   * （同会话多张卡时，每张卡都有自己的定时器，它们会先后到点）。
   */
  function onNotifyDue(id: string): void {
    const item = pending.get(id)
    // ① 已经结算了（手机答了/桌面答了/被撤回）⇒ 什么都不做。
    if (item === undefined) return
    // ② 手机在线 ⇒ 它本来就能看到卡，不发。
    if (deps.hasClient(item.conversationId)) return
    // ③ 收集**同一会话**里所有还没通知过的卡（审批 + 提问打包成一条）。
    const items: NotifyItem[] = []
    for (const [requestId, p] of pending) {
      if (p.conversationId !== item.conversationId) continue
      if (p.notified === true) continue
      items.push({
        requestId,
        sessionId: p.sessionId,
        kind: p.kind,
        askedAt: new Date(p.askedAt).toISOString(),
      })
    }
    if (items.length === 0) return
    // ④ 全部标记"通知过了"（先标记 ⇒ 同一张卡不会被两条定时器各发一次）。
    for (const it of items) {
      const p = pending.get(it.requestId)
      if (p !== undefined) p.notified = true
    }
    // ⑤ 发一帧（**明文控制帧**：只带元数据，不带任何内容）。
    const sent = deps.notifyApproval?.(item.conversationId, items) ?? false
    deps.log('approval notify dispatched', {
      conversationId: item.conversationId,
      count: items.length,
      sent: sent ? 1 : 0,
    })
  }

  function settle(id: string, value: unknown, voidAs?: VoidReason): void {
    const item = pending.get(id)
    if (!item) return
    pending.delete(id)
    if (item.timer !== undefined) deps.clock.clearTimeout(item.timer)
    // ⚠️ **提醒定时器也要清**（2026-10-27）：不清的话，一张已经结算的卡到点时
    // 还会去查 pending 表 —— 查不到就返回，看起来"没事"，但那个定时器会一直挂着
    // 到 60 秒后（宿主 shutdown 时若有未清的定时器，进程可能退不出去）。
    if (item.notifyTimer !== undefined) deps.clock.clearTimeout(item.notifyTimer)
    // 只有"不是手机自己点的"才需要作废：那种情况下手机上那张卡还亮着，而它已经没用了。
    if (voidAs) voidStaleCard(id, item, voidAs)
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
  function voidStaleCard(requestId: string, item: PendingInteraction, reason: VoidReason): void {
    // `by` 说的是"谁收的场"，不是答案本身：手机只按"要不要收掉这张卡"读它。
    const by = reason === 'desktop' ? 'desktop' : 'cancelled'
    deps.replyTo(
      item.conversationId,
      item.kind === 'approval'
        ? permissionResolved({ requestId, sessionId: item.sessionId, by })
        : questionResolved({ requestId, sessionId: item.sessionId, by }),
    )
    const emit = (running: boolean): void => {
      deps.broadcast(runState({ sessionId: item.sessionId, state: running ? 'running' : 'idle' }), RUN_OUTPUT)
      deps.log('pending card voided', { requestId, reason, kind: item.kind, state: running ? 'running' : 'idle' })
    }
    void deps
      .kernelRunState(item.sessionId)
      .then((truth) => emit(truth.running))
      .catch(() => {
        emit(deps.sessionRunningFallback(item.sessionId))
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
  function replayPending(conversationId: string): number {
    if (!deps.hasClient(conversationId)) return 0
    let replayed = 0
    // 同上：筛选口径走 `pendingEntries`（这里 `sessionId` 缺省 ⇒ 全部会话都补）
    for (const [id, item] of pendingEntries(undefined)) {
      try {
        // 重配对时通道换了：旧 conversationId 已经作废，后续的结算作废帧要发到新通道。
        item.conversationId = conversationId
        const frame = buildPendingFrame(id, item)
        if (!frame) continue
        deps.replyTo(conversationId, frame)
        replayed += 1
      } catch (error) {
        deps.log('pending replay failed', { requestId: id, message: messageOf(error) })
      }
    }
    if (replayed > 0) deps.log('pending replayed', { conversationId, count: replayed })
    // 与 `cmd.get_pending` 那条**同一个计数**：两条路（手机来问 / 主机在 peer-joined 上主动补）
    // 重放出去的是同一种帧，排错时不该因为走的哪条路而给出两个数。
    getPendingCount.replayed += replayed
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
  function buildPendingFrame(id: string, item: PendingInteraction): EvPayload | null {
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
  /**
   * `cmd.get_pending` 的完整处理：计数 + 按筛选口径重放（与 `replayPending` 共用
   * `pendingEntries`——两条路的分子分母必须同口径）。
   *
   * 返回**重放了几帧**，调用方只管把数字放进回执。
   */
  function handleGetPending(conversationId: string, sessionId: string | undefined): number {
    getPendingCount.calls += 1
    getPendingCount.lastAt = deps.clock.now()
    // 先拍下"此刻手上有几张"，**再**开始重放：这一格是分诊的关键，
    // 它回答"手机问的那一刻那张卡在不在"（见 pendingAsks 的注释）。
    getPendingCount.last = { pending: pending.size, replayed: 0 }
    let replayed = 0
    for (const [id, item] of pendingEntries(sessionId)) {
      const frame = buildPendingFrame(id, item)
      if (!frame) continue
      deps.replyTo(conversationId, frame)
      replayed += 1
    }
    getPendingCount.replayed += replayed
    if (getPendingCount.last !== null) getPendingCount.last.replayed = replayed
    return replayed
  }

  /** `stop()` 时把挂着的全部收场：一张都不留，手机上的卡当场收掉。 */
  function withdrawAll(): void {
    for (const [id] of [...pending]) settle(id, undefined, 'withdrawn')
  }

  /** 「始终允许」记表与 pending 同生命周期：出了这个进程就失效。 */
  function clearSessionAllowed(): void {
    sessionAllowed.clear()
  }

  function pickConversation(_sessionId: string): string | undefined {
    const ids = deps.conversationIds()
    if (ids.length === 0) return undefined
    return ids.find((cid: string) => deps.hasClient(cid)) ?? ids[0]
  }
  return {
    onApprovalRequest,
    onQuestionRequest,
    settleApproval,
    settleQuestion,
    replayPending,
    pendingKindForSession,
    handleGetPending,
    withdrawAll,
    clearSessionAllowed,
    get pendingAsks() {
      return pendingAsks()
    },
    get waiting() {
      return waiting()
    },
    get declined() {
      return { ...interactionDeclines }
    },
    get alwaysAllowedHits() {
      return sessionAllowedHits
    },
    pendingEntries,
    buildPendingFrame,
  }
}
