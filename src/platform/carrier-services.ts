/**
 * carrier-services — 真实内核载体：直接同进程使用平台自己的 cordis 服务。
 *
 * 为什么是同进程用服务、而不是走某个 HTTP/WS 网关：官方自己的
 * `dsh-host-apiproxy` 就是这么干的，而且 `typertGateway` 只有 `invoke()`、
 * 既不能列会话也不能发指令（取证 docs/legacy-spec/host-plugin-cordis.md §2.4 表）。
 *
 * 本文件是**整个插件里唯一允许知道内核符号长什么样**的地方。每个符号都注明取证位置；
 * 取不到证的写"未取证到"并给出降级，绝不编造签名。三条已证伪的旧写法在这里被修正：
 *
 * 1. `agent.abort()` / `agent.interrupt()` **不存在**（两代产物全树零命中）。
 *    正解是 `agent.cancel({kind:'user'}, {keepInbox:true})`
 *    （取证：`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:80`，
 *    官方 apiproxy 的实现见 `dsh-host-apiproxy/lib/types/api-proxy.js:2333-2348`）。
 *    旧插件因此在 services 载体下**永远走错误分支**——中断功能实际是坏的。
 * 2. 本地事件 `permission/requested` / `question/requested` **未取证到**。
 *    审批的真实通道是 **waterfall `approval/request`**（参与者语义），
 *    审计事件才是 `approval/asked` / `approval/decided`（经 `session/event` 到达）。
 *    旧插件订阅了一个不存在的事件名，所以审批/提问卡从未到达手机——
 *    这正是"HANDOFF 承认审批卡真机从未验证过"的根因。
 * 3. `session/event` 里**没有 token 级增量事件**（取证：真实会话日志词汇表，
 *    host-plugin-cordis.md §3 表第 10 行：`turn/start`/`step/start`/`user/message`/
 *    `assistant/message`/`tool/call`/`tool/result`/`step/end`/`turn/end`/`session/title`…，
 *    并注明 "There is NO token-level delta event"）。
 *    所以一条助手消息是**整条到达**的：合帧器仍然要跑（它保证 done 与顺序），
 *    但这里不假装是逐 token 流。
 */
import type { QuestionItem, SessionSummary } from 'dsh-remote-wire'
import { canParticipate, guardedSubscribe } from './guard.js'
import type {
  Clock,
  InteractionSink,
  KernelEvent,
  KernelHistoryPage,
  KernelPort,
  KernelSession,
} from '../ports/index.js'

/** 平台服务对象在各代际形状不同，一律按"最小可用面"声明，运行时软探测。 */
interface LooseObject {
  [key: string]: unknown
}

export interface ServicesBundle {
  sessions?: LooseObject
  sessionQuery?: LooseObject
  agents?: LooseObject
  agentDefaultModel?: LooseObject
  workspaceRegistry?: LooseObject
  userQuestions?: LooseObject
  /**
   * 上下文占用测量（dsh-token-meter）。纯回放、不发模型调用。
   * 2026-10-06 宿主能力普查发现它一直挂着而我们没用；mp 端现在完全
   * 不知道一条会话离压缩还有多远。 */
  tokenMeter?: LooseObject
  /**
   * 新建会话的唯一落点。
   *
   * 取证：`@deepseek-ai/dsh-api-session-controller` 的 `SessionController` 内部持有
   * `SessionCommandController`，暴露成 `ctx.sessionController.commands.create(request)`
   * （`lib/types/commands.js` 的 `async create(request)`，返回 `{ sessionId, agentPreset? }`）。
   * 真实宿主里它由 Remote 服务委派，**不在 kernel 的必选成员里** —— 缺了它只是少一个能力，
   * 不该把整条载体判定拖垮，所以它是可选服务。
   */
  sessionController?: LooseObject
  /**
   * 持久附件存储（`ctx.attachments`，`@deepseek-ai/dsh-attachment` 的 `AttachmentStore`）。
   *
   * **带图发提示必须经它或 `commands.prompt` 的 admission**（取证与理由见本文件
   * `submitWithImages`）：内核序列化图片块时读的是 `block.attachment.attachmentId`，
   * 而那个 `attachment` 只可能由这里的 `admitPromptContent()` 产出。
   * 桌面宿主挂的是本地实现（`dsh-attachment-local`）；缺它只是发不了图，
   * 不该把整条载体判定拖垮，所以是可选服务。
   */
  attachments?: LooseObject
  /**
   * cordis 的事件注册口；对 waterfall 是**参与式**监听。
   *
   * 第三个参数是 `EventOptions`（`{ global?, prepend? }`）。两条参与面（审批与提问）
   * 都**必须带 `global: true`**，理由见 `PARTICIPATE_OPTIONS`。
   */
  on?(name: string, listener: (...args: unknown[]) => void, options?: unknown): unknown
  off?(name: string, listener: (...args: unknown[]) => void): unknown
}

/**
 * `ctx.on('<那条 waterfall>', …)` 的第三个参数，审批与提问两条共用。
 * 两个选项各治一种"卡没弹"，**缺一不可**。
 *
 * ### `global: true` —— 不被作用域过滤掉
 *
 * 派发方是 `ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req, next)`
 * （桌面 asar 里 `ApprovalService.decide`；提问那条是 `UserQuestionService.ask()` 用同一个
 * `scopeTarget(agent, agent)` 派发同一个形状的请求），而 cordis 的 `dispatch()` 判据是
 * `hook.global || !filter || filter.call(thisArg, hook.ctx)`；`scopeTarget` 的 filter 只放行
 * "未打作用域标签的上下文"与"派发键的**祖先**作用域"，原文注释写着
 * 'A tag BELOW the dispatch key stays excluded — events flow up the chain, never down'。
 * 插件那条 fiber 与 agent 作用域是兄弟不是祖先。`global` 是 cordis 留的唯一一条逃生口
 * （`EventOptions` 原文：'Receive the event regardless of context filter checks'）。
 *
 * ### `prepend: true` —— 排在桌面那一位**前面**，然后立刻把链子交下去
 *
 * waterfall 是"外层不调 `next()`，内层就永远轮不到"，而 `dispatch()` 返回的数组里
 * **第一个就是外层**（`register()` 用 `unshift` 实现 prepend）。桌面 UI 的应答者登记得比我们早，
 * 它一拿到请求就去等真人点按钮、且不 `next()`——于是真机上出现过这个形状：
 * `approvalAsked=1`、`approvalDecided=not-seen`（卡在桌面等人）、`approvalCalls=0`（我们没轮到），
 * 手机上什么都没有，而 `approvalFace` 一直报 `registered`。
 *
 * ⚠️ **但排到前面不等于可以抢答。** 只 `prepend`、然后自己在那儿等手机，结果是
 * "手机上弹了、桌面上不弹了"——那是插件在改变宿主自己的行为（2026-10-04 真机被用户当场指出）。
 * 正确的形状写在 `participate()` 里：**一进函数就 `next()` 把桌面启动起来**，手机并行问，两边赛跑。
 *
 * **代价，说清楚**：排到最外层意味着也排在 Auto 预置的自动审阅之前（那条是 `prepend` 登记的）。
 * 本机没配 Auto 预置（profile 里只有 read-only / workspace-write / danger-full-access），
 * 所以这里没有东西被跳过；哪天接上 Auto，这一行要重新审——正确做法大概是"先让自动审阅跑完，
 * 再同时问桌面与手机"，而不是继续抢在最外层。
 */
const PARTICIPATE_OPTIONS = { global: true, prepend: true } as const

/**
 * 要**参与**的两条 waterfall：审批与提问。
 *
 * 为什么提问也走参与而不是"注册一个提供者"：宿主自己的提问服务末端就是
 * `ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', {...request, agent}, noAnswerer)`
 * （取证 `@deepseek-ai/dsh-user-questions/lib/index.js` 的 `ask()`），桌面那一位是网关转发的
 * `$on("user-questions/request", function(request, next) …)`（`dsh-client-ui-user-questions`）。
 * 而 `userQuestions.registerProvider` **在这一代宿主上不存在**（整个服务里 provider 零命中），
 * 何况"注册提供者"本来就是单提供者语义——接管会让桌面问不了问题，那是插件在改变宿主的行为。
 *
 * 两条的差别只在"没人答"怎么表达：审批那条链末端 resolve `'unavailable'`，
 * 提问那条是 `noAnswerer()` **抛出** `NO_PROVIDER`。所以参与者必须留一份原始 rejection 可复述，
 * 不能把它吞成 undefined（见 `participate` 末尾那条分支）。
 */
const PARTICIPATED_EVENTS = ['approval/request', 'user-questions/request'] as const

type ParticipatedEvent = (typeof PARTICIPATED_EVENTS)[number]

/**
 * 把"平台的中断"与"这次审批已经结算"并成一条 signal，交给链子下游的应答者。
 *
 * 为什么只有 `AbortSignal.any` 这一种形状：参与者**没法用返回值换掉下游收到的请求**——
 * cordis 的 `waterfall` 里 `next = () => (cbs.shift() ?? inner)(...args)`，`next()` 的实参
 * 被整个忽略，`args` 是派发时那一份（见 cordis `EventsService.waterfall`）。
 * 能改的只有那个请求对象**自己身上**的字段，而下游（宿主的桌面 UI 经 api-gateway
 * 转发的那条 remote event）是在它自己被调用时才读 `request.signal`：
 * `startRemoteEvent()` 把 `projected.signal` 放进 `signals`，它一断就
 * `cancelRemoteEvent()` → 向每个渲染端推 `{type:'cancel', eventId}` →
 * 那一侧的 `PendingApproval.abort()` → 卡片由宿主自己的代码收掉。
 *
 * 所以这条并算是**宣告"这次请求结束了"**，不是替桌面决定结果：结果早已由先答的那一端给出。
 * `engines` 声明的是 `>=20`，而 `AbortSignal.any` 是 20.3 才有的，故留一条手写的中继。
 */
function fuseSignals(platform: AbortSignal | undefined, ours: AbortSignal): AbortSignal {
  if (!platform) return ours
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof any === 'function') return any.call(AbortSignal, [platform, ours])
  const fused = new AbortController()
  for (const source of [platform, ours]) {
    if (fused.signal.aborted) break
    if (source.aborted) {
      fused.abort(source.reason)
      break
    }
    source.addEventListener('abort', () => fused.abort(source.reason), { once: true })
  }
  return fused.signal
}

export interface ServicesOptions {
  clock: Clock
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  /** 标题读取的超时与批量上限（读失败只让列表无标题，不影响列表本身）。 */
  titleTimeoutMs?: number
  titleBatch?: number
  /** 读一次会话历史的超时。读的是整份日志，慢会话可能到几百毫秒，所以比标题宽。 */
  historyTimeoutMs?: number
  /** 新建会话的超时。 */
  createTimeoutMs?: number
  /**
   * 新建会话时显式使用的项目目录（cwd）。空 = 智能选（见 newSession 里的三级）。
   * 为什么要有这个口子：宿主进程的 process.cwd() 是 `/`，会话挂在那儿不属于任何
   * 用户项目，GUI 的列表按项目分组就看不见它（用户 2026-10-04 实测）。
   */
  newSessionCwd?: string
  /**
   * 这条会话此刻**有没有人在等它**（2026-10-06 接上）。
   *
   * **为什么需要**：协议里的 `SESSION_STATES` 一直有 `awaiting-permission` /
   * `awaiting-answer` 两个值，小程序的会话列表与「等你处理」区只认这两个字符串——
   * 而这里原来只产出 `archived | running | idle`，于是那两个状态在真机上**永不出现**，
   * 小程序那个区是"测试绿、真机空"（e2e 是自造状态喂进去的）。
   *
   * 数据源不在本文件（分层红线）：内核只能回答"这条会话在不在跑"，回答不了
   * "有没有一张卡在等人点"。所以由调用方（index.ts）注入一个查询回调，carrier
   * 只问不判断；**回调不可用时一律回 undefined**，行为与修复前完全一致。
   */
  pendingKindForSession?: (sessionId: string) => 'approval' | 'question' | undefined
}

const MAX_TITLE_BATCH_DEFAULT = 25
const TITLE_TIMEOUT_DEFAULT = 4000
const HISTORY_TIMEOUT_DEFAULT = 15_000
/** 新建会话的超时。创建要分配 id、可能还要挂 workspace，比读标题慢，但也不该让手机干等。 */
const CREATE_TIMEOUT_DEFAULT = 8000
/**
 * 带图提示交内核入口的超时。比普通指令宽：admission 要把图片**解码校验并落盘**
 * （内容寻址存储 + 可能的缩放派生），几百 KB 的图在这台机器上并不总是毫秒级。
 * 超时的代价是"手机说发出去了、主机没收到"，所以给得比标题/历史都宽。
 */
const PROMPT_TIMEOUT_DEFAULT = 30_000
/** 只有 attachments 这一条路时的超时（落盘是唯一可能慢的那一步）。 */
const ADMIT_TIMEOUT_DEFAULT = PROMPT_TIMEOUT_DEFAULT
const LIST_LIMIT_DEFAULT = 100

/**
 * 新建会话时，为了推断"用户此刻在哪个项目下"而扫多少条会话。
 *
 * 取 20 而不是 1：列表按 `createdAt` 排，而**最新建的那条完全可能没有 cwd**
 * （它自己就是从手机在旧版本里不带 cwd 建出来的那一条）。只看第一条时，
 * 推断会直接落空 → 内核退回宿主默认目录 → 会话落进 DSH 的**未分组**。
 * 扫前 20 条找第一条带 cwd 的，既够（真正"最近在用的项目"不会排在 20 名之后，
 * 那说明这台机器上有几百条从未再碰过的历史会话），又便宜（列表本来就是一次调用）。
 */
const NEW_SESSION_SCAN = 20

/**
 * 猜「模型面」可能叫什么。**这是探测清单，不是接口声明** —— 内核各代际命名不同，
 * 猜不中就报 `none`，而不能猜中一个就不报（那样「有这项能力」会被误当成「没有」）。
 *
 * 代价很低：每个名字只做一次 `typeof` 检查，不真的调用。
 */
const MODEL_FACE_METHODS = [
  'currentSelection',
  'list',
  'listModels',
  'available',
  'availableModels',
  'selections',
  'options',
  'get',
  'set',
  'select',
  'setSelection',
  'setDefault',
  'update',
] as const

/** 命中这些名字之一才算「能列可选模型」。 */
const MODEL_LIST_METHODS = new Set(['list', 'listModels', 'available', 'availableModels', 'selections', 'options'])
/** 命中这些名字之一才算「能切换模型」。 */
const MODEL_SET_METHODS = new Set(['set', 'select', 'setSelection', 'setDefault', 'update'])

/** 折叠后的插件内部形状。 */
interface ListedSession {
  id: string
  cwd?: string
  createdAt?: number | string
  origin?: string
  /** 排序用的时间戳；对 sessionQuery 是 header.createdAt，对 sessions.list 是记录自身字段。 */
  headerTime?: number | string
}

/** 平台会话记录（`sessionQuery.listSessions()` 的形状，取证 dsh-session-query/lib/types/index.d.ts:55）。 */
interface SessionRecordLike {
  header?: { id?: string; createdAt?: number | string; cwd?: string; origin?: string; parentSession?: string }
  live?: unknown
  persisted?: unknown
}

export function createServicesKernel(services: ServicesBundle, options: ServicesOptions): KernelPort {
  const log = (message: string, fields: Record<string, string | number | boolean | undefined> = {}): void =>
    options.log?.(message, fields)
  const titleCache = new Map<string, { title: string; at: number }>()
  /**
   * 本进程刚造出来、**持久化那面还没追上**的会话（见 `listSessions` 末尾的合并）。
   * 不合并的话，用户新建完回到列表会发现那条会话不在里面。
   */
  const freshSessions = new Map<string, ListedSession>()
  /**
   * 每条会话**最后被活动过**的时刻（毫秒）。
   *
   * 为什么单开一张表（2026-10-06 审计）：`ev.session_history.updatedAt` 与手机会话列表
   * 的排序一直取的是 `ListedSession.headerTime`，而那个值是内核会话头的 **createdAt**——
   * 于是：
   *   - 手机上那条"最后消息时间"排出来的是**创建时间**，一条三天前建、今天刚用过的会话
   *     会排在自己分组的最下面（mp 的 `sessionRank` 注释把它称作"最后消息时间"）；
   *   - 显示出来的时间也是创建时间，而 `formatTime` 对今天的显示 `HH:mm`、对更早的
   *     显示日期，读起来就是"我刚用过它，却显示成三天前"。
   *
   * 主机本来就有这个信号且一直在收：任何一条 `session/event` 都经过
   * `translateSessionEvent`。把那一刻记下来，`updatedAt` 就成了它字面意思。
   *
   * **退化成 createdAt 而不是留空**：进程刚起来、还没收到任何事件时表是空的，
   * 那时仍按旧口径给 `headerTime`，所以重启前后不会出现"整页时间消失"。
   */
  const lastActivityAt = new Map<string, number>()

  /**
   * 「最后操作的那个会话」与它的目录（2026-10-06 用户："新建要落在最后操作的分组里"）。
   *
   * 为什么不直接用 `listSessions(1)`：那份列表按 `createdAt` 排，"第一条"是**最新建的**，
   * 而不是**最近在动的**。这两件事在真实使用里差得很远——用户上午建了 10 条会话，
   * 下午一直在上午建的第 3 条里干活，那么"最后操作的分组"是第 3 条的目录，
   * 而 `listSessions(1)[0]` 会指向第 10 条（多半还是别的项目）。
   *
   * 这里是**主机自己观察到的**：任何一条 session 事件（delta / 工具 / 标题 / 运行态）都经过
   * `translateSessionEvent`，因此"用户此刻正在动哪条会话"这件事不需要任何新数据源。
   * 目录本身取自 `listSessions` 填的 `sessionId → cwd` 表（那才是内核的权威），
   * 所以这里只记 id、不猜目录。
   */
  let lastTouchedSessionId = ''
  const cwdBySession = new Map<string, string>()
  /** 取证用：内核实际发过来的会话事件类型，以及我们**没有映射**的那些（进 status.json）。 */
  const seenEventTypes = new Set<string>()
  const unmappedEventTypes = new Set<string>()
  /**
   * 被判成"宿主注入"而**故意没出站**的 user/message，按 `source.kind` 计数。
   *
   * 为什么单独留这一份：注入内容（time-context / skill-catalog / runtime-context …）
   * 在手机上是不能显示的——它们顶着「你的指令」那颗蓝气泡，内容是
   * 「Time sampled while preparing turn 3 …」，用户没发过这句话（真机截图实证）。
   * 但"我们丢掉"这件事必须能被别人看见，否则「手机上看不到 X」这个问题就分不清
   * 是宿主没发、我们丢了、还是路上丢了。
   */
  const injectedUserMessages = new Map<string, number>()
  /** 事件回调里抛过的错（按类型计数）。没有这一条，"回合跑到一半没声音"就只能靠猜。 */
  const listenerErrors = new Map<string, number>()
  /**
   * 两条 waterfall 参与面的现场读数（都进 status.json）。
   *
   * 真机上"卡为什么没弹"有三种原因（宿主策略根本没问 / 我们没登记上 / 登记了但此刻
   * 没有已配对的手机），没有这些字段就只能猜。
   *
   * `registered` 只证明"我们把自己挂上去了"，一点都不能证明"挂的地方收得到"——
   * cordis 的 waterfall 按作用域过滤派发，挂错作用域的监听器登记成功、永不触发
   * （见 `PARTICIPATE_OPTIONS`）。真机那一次"审批卡没弹"就是靠 `calls=0` 排除了
   * "我们抢答了又丢掉"，把问题钉在派发那一步。
   */
  interface ParticipantFace {
    /** 登记结果：`registered` / `not-attached` / `refused by guard` / `no on()` / `failed: …`。 */
    registered: string
    /** 监听器被派发几次。 */
    calls: number
    /** 最后一次走到了哪一步。 */
    last: string
    /** 手机先答之后撤销了几次下游 signal（= 桌面那张卡的关闭句柄被按下去几次）。 */
    desktopVoided: number
    /** 能不能把可撤销的 signal 交给下游（`request.signal` 不可写时是 failed/ignored）。 */
    handoff: string
  }
  const faces: Record<ParticipatedEvent, ParticipantFace> = {
    'approval/request': {
      registered: 'not-attached',
      calls: 0,
      last: 'not-called',
      desktopVoided: 0,
      handoff: 'unknown',
    },
    'user-questions/request': {
      registered: 'not-attached',
      calls: 0,
      last: 'not-called',
      desktopVoided: 0,
      handoff: 'unknown',
    },
  }
  /**
   * 内核自己报出来的审批审计：**问过几次**与**最后一次是怎么收的场**（进 status.json）。
   *
   * 这两条是用来分"审批卡没弹"的两种根因的，它们在现场长得一模一样：
   * - `approvalAsked>0` 而 `approvalCalls=0`、`approvalDecided=unavailable`
   *   → 整条链没人答，说明**我们的监听器压根没被派发**（作用域过滤那一类）；
   * - `approvalAsked>0` 而 `approvalCalls=0`、`approvalDecided=rejected|allowed-once`
   *   → **别人抢先答了**：waterfall 是"外层不 next() 就没人能答"，我们排在桌面那一位后面。
   * 少了 `approvalDecided` 这两者分不开，只能靠猜（2026-10-03 深夜就这么猜错了一次）。
   */
  let approvalAsked = 0
  let approvalDecided = 'not-seen'

  /** 软探测一个成员是不是函数。返回类型用 unknown 参数表，调用点各自窄化。 */
  const fn = (owner: unknown, name: string): ((...args: any[]) => unknown) | undefined => {
    if (!owner) return undefined
    const value = (owner as LooseObject)[name]
    return typeof value === 'function' ? (value as (...args: any[]) => unknown) : undefined
  }

  /** 把"缺哪个成员 + 该对象实际有什么"说清楚：静默降级是排查的最大敌人。 */
  const shapeOf = (owner: unknown): string => {
    if (!owner || typeof owner !== 'object') return String(owner)
    return Object.keys(owner as LooseObject)
      .slice(0, 24)
      .join(',')
  }

  function archivedIds(): Set<string> {
    const registry = services.workspaceRegistry
    const ids = (registry as LooseObject | undefined)?.archivedSessionIds
    return Array.isArray(ids) ? new Set(ids.map(String)) : new Set<string>()
  }

  function liveAgent(sessionId: string): LooseObject | undefined {
    const get = fn(services.agents, 'get')
    if (!get) return undefined
    try {
      return get.call(services.agents, sessionId) as LooseObject | undefined
    } catch {
      return undefined
    }
  }

  /** 任意一个活着的 agent（只用于能力探测，不参与业务）。没有活 agent 时报no-live-agent。 */
  function firstLiveAgent(): LooseObject | undefined {
    const list = fn(services.agents, 'list')
    if (list) {
      try {
        const all = list.call(services.agents) as unknown
        if (Array.isArray(all) && all.length) return all[0] as LooseObject
      } catch {
        /* 退回逐个get */
      }
    }
    return undefined
  }

  function agentStatus(sessionId: string): string {
    const agent = liveAgent(sessionId)
    const status = agent?.status
    return typeof status === 'string' ? status : 'idle'
  }

  /**
   * 这条会话此刻的状态（2026-10-06 接上 `awaiting-*`）。
   *
   * 优先级：归档 > 有人在等 > 在跑 > 空闲。**「有人在等」压过「在跑」**——
   * 那条回合正停在这张卡上，手机把它显示成"运行中"就等于没在说有人等你；
   * 而"运行中"压过"空闲"是修复前就有的语义。
   *
   * 回调可能抛（它接的是 runtime 的 pending 表）：抛了就当没人等，列表本身不能因此坏掉。
   */
  function sessionState(sessionId: string, running: boolean, archived: Set<string>): SessionSummary['state'] {
    if (archived.has(sessionId)) return 'archived'
    let pending: 'approval' | 'question' | undefined
    try {
      pending = options.pendingKindForSession?.(sessionId)
    } catch (error) {
      log('pending query failed', { sessionId, message: String((error as Error)?.message ?? error) })
    }
    if (pending === 'approval') return 'awaiting-permission'
    if (pending === 'question') return 'awaiting-answer'
    return running ? 'running' : 'idle'
  }

  function toSummary(record: ListedSession, archived: Set<string>): SessionSummary {
    const cached = titleCache.get(record.id)
    const running = agentStatus(record.id) === 'running'
    const state = sessionState(record.id, running, archived)
    const activity = lastActivityAt.get(record.id)
    // 见过活动就用它；没见过就退回旧口径（创建时间），而"连标题都还没看到"的会话仍然
    // 不给 updatedAt —— 手机对 undefined 与 ISO 串的处理是分开的（`formatTime` 返回空串），
    // 别把一个我们并不知道的时刻编出来。
    const updatedAt = activity !== undefined ? iso(activity) : cached ? iso(record.headerTime) : undefined
    return {
      id: record.id,
      state,
      running,
      ...(cached?.title ? { title: cached.title } : {}),
      ...(record.cwd ? { workspace: record.cwd } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      ...(record.origin ? { origin: record.origin } : {}),
    }
  }

  function iso(value: unknown): string | undefined {
    if (typeof value === 'number') return new Date(value).toISOString()
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value
    return undefined
  }

  async function loadTitles(ids: string[]): Promise<void> {
    const read = fn(services.sessionQuery, 'readTitleSnapshots')
    if (!read || ids.length === 0) return
    const batch = options.titleBatch ?? MAX_TITLE_BATCH_DEFAULT
    for (let at = 0; at < ids.length; at += batch) {
      const slice = ids.slice(at, at + batch)
      try {
        const rows = (await withTimeout(
          Promise.resolve(read.call(services.sessionQuery, slice)),
          options.titleTimeoutMs ?? TITLE_TIMEOUT_DEFAULT,
        )) as Array<{ sessionId?: string; status?: string; value?: { title?: { title?: string; updatedAt?: string } } }>
        for (const row of rows ?? []) {
          const title = row?.value?.title?.title
          if (row?.status === 'fulfilled' && typeof title === 'string' && title) {
            titleCache.set(String(row.sessionId), { title, at: options.clock.now() })
          }
        }
      } catch (error) {
        // 标题读失败不影响列表：宁可无标题，也不要一整屏空白。
        log('title lookup failed', { message: messageOf(error) })
      }
    }
  }

  async function listSessions(limit: number): Promise<KernelSession[]> {
    const cap = limit > 0 ? limit : LIST_LIMIT_DEFAULT
    const archived = archivedIds()
    let records: ListedSession[] = []
    let source: 'sessionQuery' | 'sessions' = 'sessionQuery'
    const listPersistent = fn(services.sessionQuery, 'listSessions')
    if (listPersistent) {
      try {
        const rows = (await listPersistent.call(services.sessionQuery)) as SessionRecordLike[]
        records = (rows ?? [])
          .filter((row) => typeof row?.header?.id === 'string')
          .map((row) => ({
            id: String(row.header?.id),
            cwd: row.header?.cwd,
            createdAt: row.header?.createdAt,
            origin: row.header?.origin,
            headerTime: row.header?.createdAt,
          }))
      } catch (error) {
        log('sessionQuery.listSessions failed, falling back to sessions.list', { message: messageOf(error) })
        records = []
      }
    }
    if (records.length === 0) {
      const listLive = fn(services.sessions, 'list')
      if (!listLive) {
        log('no session listing face', {
          sessionQuery: shapeOf(services.sessionQuery),
          sessions: shapeOf(services.sessions),
        })
        return []
      }
      source = 'sessions'
      const live = (listLive.call(services.sessions) ?? []) as Array<{
        id?: string
        cwd?: string
        createdAt?: number | string
        origin?: string
        headerTime?: number | string
      }>
      records = (live ?? [])
        .filter((row) => typeof row?.id === 'string')
        .map((row) => ({
          id: String(row.id),
          cwd: row.cwd,
          createdAt: row.createdAt,
          origin: row.origin,
          headerTime: row.createdAt,
        }))
    }
    // 委派子会话整行过滤：手机上点进一条无法回答审批的子会话，比看不见更容易误导。
    records = records.filter((row) => row.origin !== 'subagent')
    // 刚建的会话要**补**进来：`sessionQuery.listSessions` 扫的是持久化日志，
    // 而一条还没有任何消息的新会话根本没有日志。不补的话，用户在手机上新建完
    // 回到列表会发现那条不在里面 —— 「新建了但列表没变」比一条报错更难懂。
    // 一旦持久化那面也能报出它，本地这条临时记录就退休，此后一切以它为准。
    for (const [id, row] of [...freshSessions]) {
      if (records.some((item) => item.id === id)) freshSessions.delete(id)
      else records.push(row)
    }
    records.sort((a, b) => createdAtOf(b) - createdAtOf(a))
    // 顺手记下 `sessionId → cwd`：新建会话要按"最后操作的那个分组"落点，
    // 而"最后操作"这个信号来自事件流（lastTouchedSessionId），目录本身只能从这里取。
    // 只写不算，不读这页的话新表也是空的——所以放在 sort 之后、slice 之前，
    // 保证**全量**记录都进表（slice 只是给人看的分页）。
    for (const row of records) {
      const cwd = String(row.cwd ?? '').trim()
      if (cwd) cwdBySession.set(row.id, cwd)
    }
    const page = records.slice(0, cap)
    await loadTitles(page.map((row) => row.id).filter((id) => !titleCache.has(id)))
    return page.map((row) => ({
      summary: toSummary(row, archived),
      live: agentStatus(row.id) === 'running',
      listingSource: source,
    }))
  }

  function createdAtOf(row: ListedSession): number {
    if (typeof row.createdAt === 'number') return row.createdAt
    if (typeof row.createdAt === 'string') {
      const parsed = Date.parse(row.createdAt)
      return Number.isNaN(parsed) ? 0 : parsed
    }
    return 0
  }

  /**
   * 新建一条会话。
   *
   * 三层软探测（服务 → `commands` → `create`）而不是 `?.` 一把梭：**缺的是哪一层要能报出来**。
   * 真机上"新建没反应"的病根可能在任意一层，而报错信息里带上"这一层有什么成员"，
   * 排查就不用再重启一次 Harness 去取证。
   */
  async function newSession(args?: {
    workspace?: string
  }): Promise<{ ok: boolean; sessionId?: string; message?: string }> {
    const controller = services.sessionController
    if (!controller) return { ok: false, message: '主机这一代没有 sessionController 服务' }
    const commands = controller.commands
    const create = fn(commands, 'create')
    if (!create) {
      return { ok: false, message: `sessionController.commands 上没有 create()（成员：${shapeOf(commands)}）` }
    }
    try {
      // cwd 要显式给（2026-10-04 用户实测："mp 端创建的会话不会出现在 dsh 的会话列表中"）。
      // 不给的时候内核用宿主进程的 process.cwd() 兜底——真机上 lsof 一看就是 `/`，
      // 于是会话挂在一个不属于任何用户项目的目录里，GUI 的列表按项目分组自然看不见它
      // （手机侧照能用，只是主机那一面"新建了却不在列表里"）。
      //
      // 三级取值（2026-10-06 用户报"落在未分组"，根因是旧实现只看第一条）：
      //   ⓪ 手机指明的工作区（`cmd.new_session.workspace`）——**优先级最高**；
      //   ① 配置点名的 `DRC_NEW_SESSION_CWD`（运维在配置文件里写下的一句钉）；
      //   ② **最后操作过的那条会话**的目录（主机自己从事件流观察到的，不猜）；
      //   ③ 往前扫若干条，找第一条带 cwd 的（"最近建过但没挂目录"的那类会话）；
      //   ④ 还是不给（宿主自己安排，日志留痕）。
      //
      // ⓪ 为什么排在配置那一句钉**之上**：那一句钉是"手机没说话时的默认"，
      // 而手机这一次是**明确说了**要让会话落在哪。用户选了分组却落在别处，
      // 就是我们要修的那个症状本身——把运维的默认值当成硬拒绝，症状一模一样。
      // 手机传来的值仍然过 `badWorkspace()`：它是不可信输入，判定的是**形状**。
      //
      // ②③ 都必须存在：旧实现只有一个退化版本（`listSessions(1)[0]`，而那份列表按 createdAt 排），
      // "最新建的那条"完全可能没有 cwd（它自己可能就是手机在旧版本里不带 cwd 建出来的那条），
      // 于是推断直接落空、cwd 为空、内核退回 `/`——用户看到的就是**未分组**。
      //
      // ⚠️ 仍然永远不给 sessionId（那会让内核复用旧会话而不是新建），
      // 也永远不与 workspaceId 同时给（两者并存会被内核当场拒 gateway/bad-request）。
      const requested = String(args?.workspace ?? '').trim()
      let requestedWhy = ''
      if (requested) requestedWhy = badWorkspace(requested)
      if (requested && requestedWhy) {
        // 形状不合法 = 用户选了个主机根本不能用的目录。明确说清楚，不静默改道：
        // 静默改道的表现是"我选了 A，它落在 B"，而那比失败更难查。
        return { ok: false, message: `手机指定的工作区不可用（${requestedWhy}）` }
      }
      const pinned = String(options.newSessionCwd ?? '').trim()
      let cwd = ''
      let cwdFrom = ''
      if (requested) {
        cwd = requested
        cwdFrom = 'client'
      } else if (pinned) {
        cwd = pinned
        cwdFrom = 'config'
      }
      if (!cwd) {
        // ②：主机观察到"用户此刻在动哪条会话"，直接用它的目录。
        // cwdBySession 由 listSessions 填；表空（还没列过一次）时自然落到 ③。
        const touched = cwdBySession.get(lastTouchedSessionId)
        if (touched && !badWorkspace(touched)) {
          cwd = touched
          cwdFrom = 'last-touched'
        }
      }
      if (!cwd) {
        try {
          // ③：多取几条。列表本身按 createdAt 排，"第一条"未必是用户最近在用的那一条，
          // 但它至少是一条**真实的**会话，比落空好。
          const recent = await listSessions(NEW_SESSION_SCAN)
          for (const row of recent) {
            const candidate = String(row.summary?.workspace ?? '').trim()
            if (candidate && !badWorkspace(candidate)) {
              cwd = candidate
              cwdFrom = 'recent-session'
              break
            }
          }
        } catch {
          // 列表读失败不挡新建：退回旧行为（宿主默认目录），日志由 listSessions 自己记。
        }
      }
      const request: Record<string, unknown> = cwd === '' ? {} : { cwd }
      if (cwd === '') log('new session without explicit cwd; host default applies', {})
      else log('new session cwd resolved', { from: cwdFrom, cwd: tailOfPath(cwd) })
      const made = (await withTimeout(
        Promise.resolve(create.call(commands, request)),
        options.createTimeoutMs ?? CREATE_TIMEOUT_DEFAULT,
      )) as LooseObject | undefined
      const id = typeof made?.sessionId === 'string' ? made.sessionId : ''
      if (!id) return { ok: false, message: `新建会话没有返回 sessionId（拿到 ${shapeOf(made)}）` }
      // 先记进 freshSessions：下一条列表推送就能带上它（见 listSessions 里的合并）。
      freshSessions.set(id, { id, createdAt: options.clock.now(), ...(cwd ? { cwd } : {}) })
      return { ok: true, sessionId: id }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  /**
   * 一个目录路径能不能当工作区用。返回 '' = 可以，否则是一句人话原因。
   *
   * 手机传来的 `workspace` 是不可信输入（它就是一条 JSON 里的字符串）。这里只做**形状**判定，
   * 不去 stat：这个进程可能被限制成看不到用户的目录树（`ProtectHome`、容器），
   * 一次 `existsSync` 得到的"不存在"会是个**假否定**，而假否定会让新建直接失败——
   * 比把它交给内核、让内核按自己的规则处理要坏得多。
   */
  function badWorkspace(raw: string): string {
    if (raw.length > 1024) return 'too long'
    if (raw.includes('\0')) return 'contains NUL'
    if (!raw.startsWith('/')) return 'not an absolute path'
    // 只收 POSIX 绝对路径：这一代内核就在 POSIX 上（Windows 明确不实现，见 DESIGN §8），
    // 而 `C:\...` 这种混进来的字符串会让内核自己抛一条没人看得懂的错误。
    if (/^[A-Za-z]:[\\/]/.test(raw)) return 'looks like a Windows path'
    return ''
  }

  /** 日志里只留目录最后一段：完整路径对排错没用、对日志是泄露（见 log.ts 的 MAX_LOG_VALUE_CHARS）。 */
  function tailOfPath(raw: string): string {
    const parts = raw.split('/')
    return parts[parts.length - 1] || '/'
  }

  /**
   * 用户消息形状：优先用平台工厂（它会补 id 与规范化），拿不到退回最小可用对象。
   *
   * 收的 `content` 必须是**内核认的那个形状**，本函数不再自己拼图片块：
   * `{type:'image', data, mimeType}` 这种裸块进不了内核（见 sendPrompt 的取证），
   * 而 `{type:'image', attachment}` 那种块只能由内核自己的 attachment store 产出。
   * 拼装入口统一在 sendPrompt 里做，这里只负责"给内容块套一个消息壳"。
   *
   * 正文原样透传，一个字节都不许多（2026-10-05 用户：正文里不要再出现路径）：
   * 以前图片的通路是「主机落盘 + 把绝对路径追加进正文」，路径会出现在对话正文里，
   * 用户和模型都看得见，还把本机目录结构泄露给模型。
   *
   * 空正文时**不塞空文本块**：一个空的 text 块会让模型看到一句空话，
   * 而「只发图不说话」本来就是合法的输入。
   */
  async function buildUserMessage(content: LooseObject[]): Promise<LooseObject> {
    try {
      // 用变量而不是字面量：这个包不是本插件的依赖，由宿主在运行时提供，
      // 写死路径会让类型检查去找一个根本不存在的声明（旧实现同样用变量绕开）。
      const llmModule = '@deepseek-ai/dsh-llm'
      const mod = (await import(/* @vite-ignore */ llmModule)) as {
        createUserMessage?: (input: unknown) => LooseObject
      }
      if (typeof mod.createUserMessage === 'function') {
        return mod.createUserMessage({
          content,
          source: { kind: 'user' },
        })
      }
    } catch {
      /* 这一代没有该包或名字不同：走兜底形状 */
    }
    return {
      id: `user_${Date.now().toString(36)}`,
      content,
      source: { kind: 'user' },
      role: 'user',
    }
  }

  /**
   * 部署默认模型（`agentDefaultModel.currentSelection()`）。
   * 取不到就必须**在任何内核调用之前**拒绝：宿主 loop 缺 model 会在 `prepareRequest`
   * 里抛 `reading 'provider'`，那条崩溃与远程控制毫无关系，排查方向会被彻底带偏
   * （取证 `docs/legacy-spec/host-plugin-cordis.md` §3 表第 11 行）。
   */
  function currentSelection(): { provider: string; model: string } | undefined {
    const owner = services.agentDefaultModel as LooseObject | undefined
    const read = fn(owner, 'currentSelection')
    if (!read || !owner) return undefined
    try {
      const value = read.call(owner) as { provider?: unknown; model?: unknown } | undefined
      if (!value || typeof value.provider !== 'string' || typeof value.model !== 'string') return undefined
      return { provider: value.provider, model: value.model }
    } catch {
      return undefined
    }
  }

  /**
   * 模型面探测：**逐名试调用**，不用 `Object.keys`。
   *
   * 踩过的坑：cordis 服务对象的成员挂在原型链上（服务本身是 accessor/proxy），
   * `Object.keys(agentDefaultModel)` 返回**空数组**——而 `sessionController.commands`
   * 这种 own-property 形态就能列出来。同一个 `shapeOf` 在两个服务上一个有用一个没���，
   * 照抄形状会得出"内核不能换模型"的**假结论**。
   *
   * 所以这里改成问"这些名字里有没有能用的"，并把命中的名字报出来。
   * 判据只回答两个问题：能不能列可选、能不能写。
   */
  function probeModelFace(): { hits: string[]; canList: boolean; canSet: boolean } {
    const owner = services.agentDefaultModel as LooseObject | undefined
    if (!owner) return { hits: [], canList: false, canSet: false }
    const hits: string[] = []
    for (const name of MODEL_FACE_METHODS) {
      if (fn(owner, name)) hits.push(name)
    }
    return {
      hits,
      canList: hits.some((n) => MODEL_LIST_METHODS.has(n)),
      canSet: hits.some((n) => MODEL_SET_METHODS.has(n)),
    }
  }

  /** 探测结果的一句话摘要，进 status.json。 */
  function modelFaceSummary(): string {
    if (!services.agentDefaultModel) return 'absent'
    const { hits, canList, canSet } = probeModelFace()
    if (!hits.length) return `none (tried=${MODEL_FACE_METHODS.length})`
    return `${canList ? 'list' : 'no-list'}+${canSet ? 'set' : 'no-set'} via=${hits.join(',')}`.slice(0, 180)
  }

  /**
   * 上下文占用的探测结果，进 status.json。
   *
   * 只报**能不能读到**，不报读到的数：数每条消息都在变，写进 status 只会让人
   * 盯着一个每次读都不同的字段。真正的数字走 mp 那条命令。
   */
  function contextUsageFace(): string {
    const meter = services.tokenMeter as LooseObject | undefined
    if (!meter) return 'absent'
    const measure = fn(meter, 'measure')
    if (!measure) return 'no-measure (keys=' + shapeOf(meter) + ')'
    // 真调一次：不试调就不知道它会不会在**我们的调用形状**下抛。
    // try 住是因为它读会话投影，冷会话可能读不到 —— 那也不该把整个载体拖垮。
    try {
      const snapshot = measure.call(meter, undefined) as LooseObject | undefined
      const total = snapshot && typeof snapshot.totalTokens === 'number' ? snapshot.totalTokens : null
      return 'measure ok' + (total === null ? ' (no snapshot)' : ' (total=' + total + ')')
    } catch (error) {
      return 'measure threw: ' + messageOf(error).slice(0, 120)
    }
  }

  /**
   * 图片通路的探测结果，进 status.json。
   *
   * 三态与 `sendPrompt` 的降级顺序一一对应，不许合并：
   * `commands.prompt`（内核完整入口：resume + 模型能力闸 + 文件回执 + admission）
   * → `attachments.admitPromptContent`（只有那座桥，后面的事自己做）
   * → `absent`（明确拒绝发图，绝不退回裸块硬发）。
   */
  function attachmentFace(): string {
    if (typeof fn(services.sessionController?.commands, 'prompt') === 'function') return 'commands.prompt'
    if (typeof fn(services.attachments, 'admitPromptContent') === 'function') return 'attachments.admitPromptContent'
    return `absent (commands=${shapeOf(services.sessionController?.commands)} attachments=${shapeOf(
      services.attachments,
    )})`.slice(0, 160)
  }

  /**
   * 命令入口要的 `requestId`（`SessionRequestId`，内核用它做同一请求的幂等去重）。
   *
   * 必须**逐条不同**且**重连后不重复**：内核见到重复的 requestId 会当成重投直接返回
   * accepted（`SessionCommandController.prompt` 的 `hasPromptRequest` 分支），
   * 于是这一条用户的图会被静默丢掉。所以时间戳之外还带一个进程内自增序号。
   */
  let promptRequestSeq = 0
  function nextPromptRequestId(sessionId: string): string {
    promptRequestSeq += 1
    return `drc_prompt_${sessionId}_${options.clock.now().toString(36)}_${promptRequestSeq.toString(36)}`
  }

  /**
   * 把一条**已经装好内容块**的消息交给 agent（followup 优先，退 steer）。
   *
   * 拆出来是因为带图与不带图两条路到这里汇合：带图那条的内容块由内核的
   * admission 产出（可能来自命令入口，也可能来自 `attachments` 服务），
   * 不带图那条是纯文本 —— 投递方式两者相同。
   */
  function deliverPrompt(
    agent: LooseObject,
    message: LooseObject,
    followup: ((...args: any[]) => unknown) | undefined,
    steer: ((...args: any[]) => unknown) | undefined,
  ): { ok: boolean; message?: string } {
    if (followup) {
      followup.call(agent, message)
      return { ok: true }
    }
    if (!steer) return { ok: false, message: 'agent 既没有 followup 也没有 steer' }
    steer.call(agent, message)
    return { ok: true }
  }

  /** 带图时走内核入口的结果：已投递 / 拿到 admitted 内容块 / 被拒。 */
  type ImageSubmit =
    { kind: 'delivered' } | { kind: 'admitted'; content: LooseObject[] } | { kind: 'rejected'; message: string }

  /**
   * 带图的提示必须**经内核自己的 admission**，不能把裸 image 块塞进 followup。
   *
   * ## 取证（app.asar 里 `@deepseek-ai/*` 的真实产物，2026-10-06）
   *
   * 内核里有**两种**图片内容块，形状不兼容，而旧实现把它们混成了一个：
   *
   * | 代际 | 形状 | 谁能产出 |
   * |---|---|---|
   * | 入口（PromptContentPart） | `{type:'image', mediaType, data, name?}` | 客户端 / 命令层，**base64 原文** |
   * | 内部（ImageBlock） | `{type:'image', attachment: ImageAttachmentRef}` | 只能由 attachment store 的 `admitPromptContent` 产出 |
   *
   * 取证位置：
   * - 入口形状：`@deepseek-ai/dsh-api-session-controller/lib/typert.host.js:1981`
   *   （`PromptContentPart`）与 `:2237`（`SessionPromptRequest`）。
   * - 内部形状：`@deepseek-ai/dsh-llm/lib/typert.host.js:329`
   *   （`export interface ImageBlock { type: 'image'; attachment: ImageAttachmentRef }`）。
   * - 两者之间那座桥：`@deepseek-ai/dsh-attachment/lib/types/index.js:58-73`
   *   的 `admitPromptContent()` —— 入口块进去，内部块出来，**顺序一一对应**。
   *
   * ## 崩在哪（真机现象的完整解释）
   *
   * 旧实现发的是 `{type:'image', data, mimeType}`：**字段名错**（内核叫 `mediaType`）
   * **而且压根没经过那座桥**，块里没有 `attachment`。回合走到内核序列化那一步时：
   *
   * ```js
   * // @deepseek-ai/dsh-llm-deepseek/lib/index.js:1587（serialize() 内）
   * const version = images.get(block.attachment.attachmentId)
   * ```
   *
   * `block.attachment` 是 undefined → `Cannot read properties of undefined (reading 'attachmentId')`。
   * 这一步在 turn 的请求准备里，于是整回合以 error 收场：手机上看到的是
   * 「这一轮没有产出回复，内核报错（UNKNOWN）」，而图从头到尾没进过任何持久化。
   *
   * 两条路，按"内核自己的入口优先"排：
   *
   * 1. `ctx.sessionController.commands.prompt(request)`（`SessionCommandController.prompt`，
   *    `dsh-api-session-controller/lib/types/commands.js:290`）—— 这是客户端那条路，
   *    里面已经做了：resume 冷会话、模型能力闸（`inputModalities` 不含 image 就拒）、
   *    file receipt 解析、`admitPromptContent`、`createUserMessage`、投递。
   *    走它等于让内核按自己的规矩收这条提示，错误也是内核自己的话。
   * 2. 没有该命令时退回 `ctx.attachments.admitPromptContent(content)` —— 就是那座桥本身，
   *    之后我们自己 `createUserMessage` + `followup`。
   *
   * **两个面都没有时明确拒绝，绝不退回"裸块硬发"**：那不是降级，是拿用户的回合去赌
   * 内核别崩（崩了用户只看到一句看不懂的 UNKNOWN）。
   */
  async function submitWithImages(
    sessionId: string,
    content: LooseObject[],
    mode: 'queue' | 'steer',
  ): Promise<ImageSubmit> {
    const controller = services.sessionController as LooseObject | undefined
    const commands = controller?.commands as LooseObject | undefined
    const prompt = fn(commands, 'prompt')
    if (prompt) {
      try {
        await withTimeout(
          Promise.resolve(
            prompt.call(commands, { requestId: nextPromptRequestId(sessionId), sessionId, mode, content }),
          ),
          PROMPT_TIMEOUT_DEFAULT,
        )
        log('prompt with images accepted by sessionController.commands.prompt', {
          sessionId,
          mode,
          images: content.filter((part) => part.type === 'image').length,
        })
        return { kind: 'delivered' }
      } catch (error) {
        // 内核的拒绝理由比我们在外面猜的准，原样带回去（外层会加中文前缀）。
        log('prompt with images rejected by kernel', { sessionId, message: messageOf(error) })
        return { kind: 'rejected', message: messageOf(error) }
      }
    }
    const attachments = services.attachments
    const admit = fn(attachments, 'admitPromptContent')
    if (!admit) {
      return {
        kind: 'rejected',
        message: `这台主机的内核没有图片通路（commands=${shapeOf(commands)} attachments=${shapeOf(
          attachments,
        )}），请把图片存成文件再发`,
      }
    }
    try {
      const admitted = (await withTimeout(
        Promise.resolve(admit.call(attachments, content)) as Promise<LooseObject[]>,
        ADMIT_TIMEOUT_DEFAULT,
      )) as LooseObject[]
      if (!Array.isArray(admitted) || admitted.some((part) => part?.type === 'image' && !part.attachment)) {
        // 没拿到 durable ref 就等于没 admission：这条必须当失败，不能往前送。
        return {
          kind: 'rejected',
          message: `内核的 attachments.admitPromptContent 没给出图片的持久引用（拿到 ${shapeOf(admitted)}）`,
        }
      }
      log('prompt with images admitted by attachments.admitPromptContent', {
        sessionId,
        images: content.filter((part) => part.type === 'image').length,
      })
      return { kind: 'admitted', content: admitted }
    } catch (error) {
      log('prompt with images rejected by attachment store', { sessionId, message: messageOf(error) })
      return { kind: 'rejected', message: messageOf(error) }
    }
  }

  async function sendPrompt(
    sessionId: string,
    text: string,
    attachments: ReadonlyArray<{ data: string; mimeType: string }> = [],
  ): Promise<{ ok: boolean; message?: string }> {
    const agent = liveAgent(sessionId)
    if (!agent) return { ok: false, message: `会话没有活的 agent（agents.get(${sessionId}) 为空，请先恢复会话）` }
    if (!currentSelection()) {
      // 没有可用模型时必须主动拒绝，理由见 currentSelection() 的注释。
      return { ok: false, message: '拿不到当前模型选择（agentDefaultModel.currentSelection 缺失）' }
    }
    const followup = fn(agent, 'followup')
    const steer = fn(agent, 'steer')
    if (!followup && !steer) {
      return { ok: false, message: `agent 既没有 followup 也没有 steer（keys=[${shapeOf(agent)}]）` }
    }

    const head = String(text || '').trim()
    const content: LooseObject[] = []
    // 空正文不占块位：只发图不说话是合法输入，塞一个空 text 块等于让模型读一句空话。
    if (head !== '') content.push({ type: 'text', text: head })

    if (attachments.length === 0) {
      if (content.length === 0) content.push({ type: 'text', text: '' })
      return deliverPrompt(agent, await buildUserMessage(content), followup, steer)
    }

    // 带图：先把手机送来的东西整成**内核入口形状**（mediaType + 规范 base64），
    // 再交内核 admission。理由与取证见 submitWithImages 的注释。
    const prepared = prepareImageParts(attachments)
    if (!prepared.ok) {
      log('prompt with images refused before kernel call', { sessionId, message: prepared.message })
      return { ok: false, message: prepared.message }
    }
    // 这一处断言只跨"我们自己定义的精确形状"与"内核面用的宽松形状"：
    // 内容块最终要交给不认识的第三方方法，所以从这一行起就按 LooseObject 走。
    content.push(...(prepared.parts as unknown as LooseObject[]))
    const submitted = await submitWithImages(sessionId, content, followup ? 'queue' : 'steer')
    if (submitted.kind === 'delivered') return { ok: true }
    if (submitted.kind === 'rejected') return { ok: false, message: `图片附件被内核拒绝：${submitted.message}` }
    return deliverPrompt(agent, await buildUserMessage(submitted.content), followup, steer)
  }

  async function interrupt(sessionId: string): Promise<{ ok: boolean; message?: string }> {
    const agent = liveAgent(sessionId)
    if (!agent) return { ok: false, message: `会话没有活的 agent：${sessionId}` }
    const cancel = fn(agent, 'cancel')
    if (!cancel) return { ok: false, message: `agent 没有 cancel（keys=[${shapeOf(agent)}]）` }
    // 正解见文件头第 1 条：`{kind:'user'}` + `keepInbox`，保住已排队的用户消息。
    cancel.call(agent, { kind: 'user' }, { keepInbox: true })
    return { ok: true }
  }

  /**
   * 冷会话续跑（归档或未加载的会话发指令前必须走这一步）。
   *
   * **`agentOptions` 不能省**：真机取证抓到的就是这个——宿主每轮结束都会 `session/end-seed`
   * 把 agent 拆掉，于是手机的第二条指令一定走 resume；而 `agents.resume({resumeSessionId})`
   * 不带模型时建出来的 Agent 没有 call configuration，回合在 prompt 装配阶段就死掉：
   * `prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`，
   * 更早一代甚至直接抛 `Cannot read properties of undefined (reading 'provider')`。
   * 手机上看到的是"发出去、转两下、一个字都没有"——因为回合是以 error 收的尾，
   * 而第一版连 `turn/end` 的 reason 都丢掉了（见 `turnEndKernelEvents`）。
   * 取证：`docs/legacy-spec/host-plugin-cordis.md` §3 表第 5/11 行。
   */
  async function ensureRunnable(sessionId: string): Promise<{ ok: boolean; message?: string }> {
    if (liveAgent(sessionId)) return { ok: true }
    const registry = services.workspaceRegistry as LooseObject | undefined
    const unarchive = fn(registry, 'unarchiveSession')
    if (unarchive) {
      try {
        await unarchive.call(registry, sessionId)
      } catch (error) {
        // 恢复失败要如实上报：归档会话会被宿主的 archived-session-gate 在
        // `agent/pre-step` 直接拒掉（turn 以 blocked 收场，发生在模型调用之前）。
        return { ok: false, message: `恢复归档会话失败：${messageOf(error)}` }
      }
    }
    const resume = fn(services.agents, 'resume')
    if (!resume) return { ok: false, message: `这一代宿主没有 agents.resume（keys=[${shapeOf(services.agents)}]）` }
    const selection = currentSelection()
    if (!selection) {
      // 没有模型就不要去续跑：续出来的 Agent 一定在装配阶段炸，而且炸点看起来
      // 与远程控制毫无关系。主动拒绝才有可读的原因。
      return { ok: false, message: '拿不到当前模型选择（agentDefaultModel.currentSelection 缺失），无法续跑会话' }
    }
    try {
      await resume.call(services.agents, {
        resumeSessionId: sessionId,
        agentOptions: { provider: selection.provider, model: selection.model },
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, message: `续跑会话失败：${messageOf(error)}` }
    }
  }

  /**
   * 归档 / 取消归档一条会话（`cmd.archive_session` 的落点）。
   *
   * ## ⚠️ 刻意**不传** `stopActivity`（这是本函数最重要的一行注释）
   *
   * 内核的 `archiveSession(sessionId, options)` 在会话还在跑时**抛**
   * `WorkspaceActiveSessionError`，除非传 `stopActivity: true`——而那会**停掉主机上
   * 正在跑的工作**。用户在手机上误点一下，主机上正在跑的任务就断了：那是不可逆的
   * 损失，而且违反"插件不改变宿主自己的行为"这条纪律。
   *
   * 所以这里 `archive.call(registry, sessionId)` **不带第二个参数**。内核抛错时
   * 把它翻成一句用户看得懂的话（"会话正在运行，不能归档"），
   * 而不是一个 `WorkspaceActiveSessionError: ...` 的类名。
   *
   * 反向判据：哪天有人为了"让用户少跑一趟"而在这里补上 `stopActivity`，
   * 下面那条"抛错时翻成人话"的判据不会红——所以另有一条判据钉住"不带第二参"。
   */
  async function archiveSession(sessionId: string, archived: boolean): Promise<{ ok: boolean; message?: string }> {
    const registry = services.workspaceRegistry as LooseObject | undefined
    // 取消归档走 `unarchiveSession`、归档走 `archiveSession`：内核把它们做成了两个
    // 方法而不是一个带布尔参数的（实测 app.asar 里两个都在，且 `ensureRunnable`
    // 已经在用 unarchiveSession 那一个）。这里跟着内核的形状，不自己发明第三种。
    const name = archived ? 'archiveSession' : 'unarchiveSession'
    const method = fn(registry, name)
    if (!method) {
      return {
        ok: false,
        message: `这一代宿主不能${archived ? '归档' : '取消归档'}会话（workspaceRegistry 没有 ${name}）`,
      }
    }
    // 会话还在跑时先自己判一次，给出比内核类名更好懂的话。
    // ⚠️ 这是**预判**不是替代：内核仍可能抛（两个判断之间有竞态），下面照样 catch。
    if (archived && agentStatus(sessionId) === 'running') {
      return { ok: false, message: '会话正在运行，不能归档。请先在电脑上让它跑完' }
    }
    try {
      await method.call(registry, sessionId)
      return { ok: true }
    } catch (error) {
      // 内核的 WorkspaceActiveSessionError 在这里被翻成一句话。
      // 判据用**类名**而不是 message 内容：message 是给人看的、会随版本变文案，
      // 而"这一类错误需要被翻译"这件事本身必须被钉住。
      const text = messageOf(error)
      if (/WorkspaceActiveSessionError|active session/i.test(text)) {
        return { ok: false, message: '会话正在运行，不能归档。请先在电脑上让它跑完' }
      }
      return { ok: false, message: `${archived ? '归档' : '取消归档'}会话失败：${text}` }
    }
  }

  /**
   * 读一条会话已有的历史（手机打开会话时用）。
   *
   * 走 `sessionQuery.readSession(id)`：它返回**整份**会话日志（不是窗口），
   * 与实时 `session/event` 同一套 `{type, seq, data}` 形状 —— 所以翻译直接复用
   * `sessionEventKernelEvents`，分页由 `historyPageFromLog` 在插件侧切。
   *
   * 为什么不逐页读：`readEvent({seq, before, after})` 那边有 50 条的窗口上限，
   * 按它翻页要先知道"哪些 seq 是有内容的"，多一层猜测；而整份日志本来就要被
   * `_corpus.load()` 完整读出来（含 replay 校验），**分页切在内存里做不会多读一个字节**。
   * 真机实测：4 轮对话的日志 713 行，读一次是毫秒级。
   *
   * 能力缺失时**抛**而不是回空页：空页在手机上是"这个会话没内容"，
   * 那是一个会让人查错方向的假事实。
   */
  async function readHistory(
    sessionId: string,
    page: { beforeSeq?: number; limit: number },
  ): Promise<KernelHistoryPage> {
    const read = fn(services.sessionQuery, 'readSession')
    if (!read) {
      throw new Error(
        `这一代宿主不能读会话历史（sessionQuery 没有 readSession，keys=[${shapeOf(services.sessionQuery)}]）`,
      )
    }
    const loaded = (await withTimeout(
      Promise.resolve(read.call(services.sessionQuery, sessionId)),
      options.historyTimeoutMs ?? HISTORY_TIMEOUT_DEFAULT,
    )) as { events?: Array<{ type?: unknown; seq?: unknown; data?: unknown }> } | undefined
    /**
     * **`events` 不是数组时必须抛，不许静默回一张空页**（2026-10-06）。
     *
     * 空页在手机上是"这个会话没内容"——一个会让人查错方向的假事实，与本文件
     * 上面"能力缺失就抛"那条纪律同源。`readSession` 的形状变了（返回 undefined、
     * 或返回 `{items: …}`）时旧写法会把它当成"零条历史"，现场看起来完全正常。
     */
    if (!Array.isArray(loaded?.events)) {
      throw new Error(`会话历史读不出来：sessionQuery.readSession 没回 events 数组（shape=${shapeOf(loaded)}）`)
    }
    const events = loaded.events
    return historyPageFromLog({
      sessionId,
      events,
      ...(page.beforeSeq === undefined ? {} : { beforeSeq: page.beforeSeq }),
      limit: page.limit,
      // 读历史的同时问一次"此刻在不在跑"：只有正在跑才允许把历史快照说成此刻的清单。
      running: agentStatus(sessionId) === 'running',
    })
  }

  /**
   * `on` 到晚时的补登记表（订阅与交互面登记各推一条 binder；binder 返回 false = 还没成）。
   *
   * 重试窗口刻意很短（0/50/250/1000ms 四档）：要覆盖的是"`ctx.inject` 回调在一个微任务
   * 之后才把 `on` 绑上来"这个尺度，不是网络。四档都没等到就如实记日志放弃——
   * 不会留下吊住宿主的定时器（这也是 e2e"跑完还要等一分钟"那类事故的形状）。
   */
  const lateBinders: Array<() => boolean> = []
  const LATE_BIND_DELAYS_MS = [0, 50, 250, 1_000] as const
  let lateTimer: unknown
  let lateAttempt = 0

  const scheduleLateBind = (): void => {
    if (lateTimer !== undefined || lateAttempt >= LATE_BIND_DELAYS_MS.length) return
    const delay = LATE_BIND_DELAYS_MS[lateAttempt] ?? 1_000
    lateAttempt += 1
    const handle = options.clock.setTimeout(() => {
      lateTimer = undefined
      if (typeof services.on !== 'function') {
        scheduleLateBind()
        return
      }
      let pending = false
      for (const binder of [...lateBinders]) {
        try {
          if (!binder()) pending = true
        } catch (error) {
          log('late event bind failed', { message: messageOf(error) })
        }
      }
      if (pending) scheduleLateBind()
    }, delay)
    // 尽力 unref：这条重试链最坏横跨 1.3 秒，插件自己的纪律是"绝不吊住宿主的事件循环"
    // （见 core/clock.ts 的 createOneShotTimers）。假时钟给的是数字句柄，可选调用天然空转。
    ;(handle as { unref?: () => void } | undefined)?.unref?.()
    lateTimer = handle
  }

  const addLateBinder = (binder: () => boolean): void => {
    lateBinders.push(binder)
    // 新的等待方进来了：把重试窗口重新打开（上一个等待方可能已经用光了那四档）。
    if (lateTimer === undefined) lateAttempt = 0
    scheduleLateBind()
  }

  function subscribe(onEvent: (event: KernelEvent) => void): () => void {
    const disposers: Array<() => void> = []
    let disposed = false
    /**
     * 注册一个**永远不会往外抛**的监听器。
     *
     * 这条不是防御性冗余：`guardedSubscribe` 只保护"注册"这一步，回调本体是裸交给
     * cordis 的 emit 的。一次抛出（例如某代事件的字段形状没料到）会打断这一条事件的
     * 派发链，严重时整条订阅被拆掉——真机上表现成"回合跑到一半就再也没有事件"，
     * 而且 status.json 里一片祥和。插件的红线是"绝不带崩宿主"，事件回调是第一现场。
     */
    const bind = (name: string, handler: (...args: unknown[]) => void): void => {
      const guardedHandler = (...args: unknown[]): void => {
        try {
          handler(...args)
        } catch (error) {
          const key = `${name}: ${messageOf(error)}`.slice(0, 120)
          const count = (listenerErrors.get(key) ?? 0) + 1
          listenerErrors.set(key, count)
          if (count === 1) log('event listener threw', { name, message: messageOf(error) })
        }
      }
      disposers.push(
        guardedSubscribe(services.on as never, name, guardedHandler as never, (message, fields) =>
          log(message, fields),
        ),
      )
    }
    /**
     * **订阅可以在 `on` 从无到有时补上**（2026-10-06 真机取证）。
     *
     * `services` 是热补丁对象：`tryStart()` 在 `ctx.get('sessions', true)` 同步可得时
     * 会在任何 `ctx.inject` 回调**之前**把内核启起来，那一刻 `services.on` 还是
     * undefined（on 要等作用域上下文那条回调才绑上来）。旧实现这时记一句
     * `kernel has no on(); streaming disabled` 并**永久**返回空退订，
     * 而 `HostRuntime.start()` 有 started 闸门不会重试 → 该进程内流式全黑，
     * 只有重启宿主才能恢复；`describe().hasOn` 每次现读、那时早已是 true，会掩盖真相。
     *
     * 所以：第一次拿不到就登记一条补绑，短窗口重试（覆盖"一个微任务之后"这个尺度）。
     */
    const bindAll = (): boolean => {
      if (disposed) return true
      if (disposers.length > 0) return true
      const on = services.on
      if (typeof on !== 'function') return false
      bind('session/event', (...args) => translateSessionEvent(onEvent, args))
      bind('session/created', () => onEvent({ kind: 'sessions-changed', reason: 'session/created' }))
      bind('agent/status', (...args) => translateAgentStatus(onEvent, args))
      bind('agent/error', (...args) => {
        const sessionId = sessionIdOf(args)
        if (sessionId) onEvent({ kind: 'run-state', sessionId, state: 'idle', detail: 'agent-error' })
      })
      return true
    }
    if (!bindAll()) {
      log('kernel has no on() yet; streaming will start as soon as it appears', { keys: shapeOf(services) })
      addLateBinder(bindAll)
    }
    return () => {
      disposed = true
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 退订失败无所谓 */
        }
      }
      disposers.length = 0
    }
  }

  /**
   * 平台日志里的一条会话事件 → 插件词汇表。
   *
   * 未识别的类型**不猜、不挪用**，但必须留痕：`seenEventTypes` / `unmappedEventTypes`
   * 直接进 status.json 的 `kernel` 里。真机取证第一次用到它就抓出了"手机上看不到工具行"
   * 这类问题的分叉点——到底是内核没发、还是我们没认。
   */
  function translateSessionEvent(onEvent: (event: KernelEvent) => void, args: unknown[]): void {
    const session = args.find(
      (arg) => arg && typeof arg === 'object' && typeof (arg as { id?: unknown }).id === 'string',
    ) as { id?: string } | undefined
    const event = args.find(
      (arg) => arg && typeof arg === 'object' && typeof (arg as { type?: unknown }).type === 'string',
    ) as { type?: string; data?: LooseObject; seq?: number } | undefined
    const sessionId = String(session?.id ?? '')
    const type = event?.type
    if (!sessionId || !type) return
    seenEventTypes.add(type)
    // "最后操作的会话"：任何一条事件都算（哪怕它随后被 INTENTIONAL_DROPS 丢掉、
    // 或者是一条我们不翻译的类型）——用户确实在那条会话里干了活，这就是我们要的信号。
    lastTouchedSessionId = sessionId
    // 同理，"最后活动时刻"记的是**用户动过**，不是"这条会话有多新"。
    lastActivityAt.set(sessionId, options.clock.now())
    const data = (event?.data ?? {}) as LooseObject
    // 审批的审计面对象：`asked` 带 toolName，`decided` 带 outcome。这里只记账不翻译——
    // 卡片本身走 `approval/request` 那条 waterfall，见 attachInteractionSink。
    if (type === 'approval/asked') approvalAsked += 1
    if (type === 'approval/decided') approvalDecided = String(data.outcome ?? '?')
    for (const mapped of sessionEventKernelEvents({ sessionId, type, seq: event?.seq, data })) {
      // 标题缓存留在闭包这一侧：纯函数只负责"这条事件翻成什么"，不负责记账。
      if (mapped.kind === 'title') titleCache.set(sessionId, { title: mapped.title, at: options.clock.now() })
      onEvent(mapped)
    }
    if (!MAPPED_SESSION_EVENTS.has(type)) {
      // 不映射、不猜语义（F1：挪用既有名字的语义才是危险的），但**必须留痕**：
      // "手机上看不见工具行"这种问题，第一步就是要分清是内核没发还是我们没认。
      if (!unmappedEventTypes.has(type)) {
        unmappedEventTypes.add(type)
        log('unmapped session event type', { type, keys: shapeOf(data) })
      }
    }
    // 被判成"宿主注入"而没出站的 user/message：同样要留痕。
    // 不留痕的话「手机上看不到某条注入」与「内核根本没发」在 status.json 里长得一模一样，
    // 而这两件事的下一步完全不同（改映射 vs 查宿主）。
    if (type === 'user/message' && !isHumanUserMessage(data)) {
      const kind = String((data.source as LooseObject | undefined)?.kind ?? '?')
      injectedUserMessages.set(kind, (injectedUserMessages.get(kind) ?? 0) + 1)
    }
  }

  function translateAgentStatus(onEvent: (event: KernelEvent) => void, args: unknown[]): void {
    const payload = args.find((arg) => arg && typeof arg === 'object') as
      { agent?: LooseObject; status?: string; sessionId?: string } | undefined
    const sessionId = payload?.sessionId ?? String((payload?.agent as { session?: { id?: string } })?.session?.id ?? '')
    if (!sessionId) return
    onEvent({ kind: 'run-state', sessionId, state: payload?.status === 'running' ? 'running' : 'idle' })
  }

  let sink: InteractionSink | undefined

  function attachInteractionSink(next: InteractionSink): () => void {
    sink = next
    const disposers: Array<() => void> = []
    let detached = false
    /**
     * 与 `subscribe()` 同一条理由：`on` 可能晚一步才挂上来（热补丁对象），
     * 而交互面登记晚一步就等于**手机上永远不弹审批/提问卡**、平台的 waterfall
     * 一直等到超时。第一次拿不到就登记一条补绑。
     */
    const attachAll = (): boolean => {
      if (detached) return true
      const on = services.on
      if (typeof on !== 'function') {
        for (const name of PARTICIPATED_EVENTS) faces[name].registered = 'no on()'
        return false
      }
      if (disposers.length > 0) return true
      for (const name of PARTICIPATED_EVENTS) {
        const face = faces[name]
        if (!canParticipate(name)) {
          // 名单是 guard 里那份极窄的显式清单。走到这里说明有人改了名单却没同步这里——
          // 宁可这条面不接，也不要悄悄订阅一条 waterfall。
          face.registered = 'refused by guard'
          continue
        }
        // **参与**这条 waterfall：必须返回真答案或调用 `next()`；返回 undefined 会冲掉整条链
        // （那是"每个 turn 都崩"的形状，见 guard.ts）。
        const listener = (...args: unknown[]): Promise<unknown> => participate(name, args)
        try {
          const disposer = (on as (n: string, fn: unknown, o?: unknown) => unknown).call(
            services,
            name,
            listener,
            PARTICIPATE_OPTIONS,
          )
          // 这条登记要进 status.json：真机上"卡为什么没弹"分三种原因（宿主没问 / 没登记上 /
          // 登记了但没有配对的手机），没有这个字段就只能猜。
          face.registered = 'registered'
          disposers.push(() => {
            if (typeof disposer === 'function') (disposer as () => void)()
            else if (typeof services.off === 'function') services.off(name, listener)
          })
        } catch (error) {
          face.registered = `failed: ${messageOf(error)}`.slice(0, 80)
          log(`${name} participation failed`, { message: messageOf(error) })
        }
      }
      return true
    }
    if (!attachAll()) addLateBinder(attachAll)
    return () => {
      detached = true
      sink = undefined
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 尽力退订 */
        }
      }
      disposers.length = 0
    }
  }

  /**
   * 一条被参与的 waterfall 的处理器：`<event>(this, req, next)`。
   * **同时**问手机和桌面，谁先给出真实决定谁算——审批与提问共用这一份实现。
   *
   * 为什么不能抢答（2026-10-04 真机踩过，用户当场指出来）：waterfall 是"外层不调 `next()`
   * 内层就永远轮不到"，而我们为了排到桌面前面用了 `prepend`——结果**桌面那一半整个不弹了**。
   * 那是插件在改变宿主自己的行为，红线。所以一进这个函数就要立刻把 `next()` 叫起来
   * （桌面照常弹、照常等它的人），手机这一侧并行问，两边赛跑。
   *
   * "谁先答谁算"里的"答"要收紧：审批那条的 `'decline'`（手机超时）/`'cancelled'`（被我们撤回）/
   * `'unavailable'`（链子末端没人应答）都不算；提问那条的 `null` 同样不算。把它们当答案的后果很具体：
   * 手机没电了会变成"自动拒绝"，而桌面上暂时没人会变成"手机还没点就失败"。
   *
   * 桌面先答时我们 `abort` 给 runtime 那条信号（reason `'desktop'`），`runtime` 收到之后
   * 向手机发精确作废帧 + 补一帧 `ev.run_state` 把卡收回去。
   *
   * **反方向也收得掉**（2026-10-04 补上这条，此前那段注释写的是"收不了"，那是没读到
   * cordis `waterfall` 与 api-gateway `startRemoteEvent` 之前的结论）：手机先答之后我们
   * 撤销交给下游的那份 signal，宿主的网关便向每个渲染端发 cancel，桌面那张卡按宿主
   * 自己的代码消失。判据是这条面上的 `desktopVoided` 计数器——它加了而屏幕上卡还在，
   * 问题就在渲染端；没加就是这一侧没换成功（`handoff` 会说为什么）。两条 waterfall 在网关
   * 那边是同一条转发路径（客户端都是 `$on(名字, function(request, next) …)`），所以这招不必
   * 为提问重写一遍。
   *
   * 两条唯一的实质差别是"没人答"怎么表达：审批那条链末端 resolve `'unavailable'`，
   * 提问那条是 `noAnswerer()` **抛出** `NO_PROVIDER`。所以最后那条分支必须把原始 rejection
   * 复述回去，而不是吞成 `undefined`——那正是"把内核每个 turn 都搞崩"的形状（见 guard.ts）。
   */
  async function participate(event: ParticipatedEvent, args: unknown[]): Promise<unknown> {
    const isApproval = event === 'approval/request'
    const face = faces[event]
    face.calls += 1
    // 请求对象就是 args 里形状对得上的那一个：审批认 `toolName`，提问认 `questions`。
    const request = args.find(
      (arg) =>
        Boolean(arg) &&
        typeof arg === 'object' &&
        (isApproval
          ? typeof (arg as { toolName?: unknown }).toolName === 'string'
          : Array.isArray((arg as { questions?: unknown }).questions)),
    ) as
      | {
          agent?: { session?: { id?: string } }
          toolName?: string
          reason?: string
          questions?: LooseObject[]
          signal?: AbortSignal
        }
      | undefined
    const next = args.find((arg) => typeof arg === 'function') as (() => Promise<unknown>) | undefined
    const sessionId = String(request?.agent?.session?.id ?? '')
    // `!sink` 就是"没有能收消息的手机"：交互面登记过才有 sink，而真正的
    // "此刻有没有在线对端"由 runtime 判（它才认识 transport）。原来这里还串了一个
    // `servicesPeers()`，它的实现恒等于 `sink !== undefined` —— 与 `!sink` 完全重复。
    if (!sink || !sessionId) {
      // 一行都不弹，完整交还桌面。这一步是"插件不抢答"的关键。
      // 这里**不 catch**：提问那条没人答时宿主本来就是抛 `NO_PROVIDER`，
      // 把它吞成值会改变宿主的错误形状（未配对的手机上"提问"就变成了一次空答案）。
      face.last = 'handed-back(no phone target)'
      const value = await next?.()
      return isApproval ? String(value ?? 'unavailable') : value
    }
    const controller = new AbortController()
    // 平台自己撤回这次请求时（回合被取消等）也必须让手机把卡收掉，所以把它的 signal 接回
    // 我们这条 controller 上——往下只传一个信号源，`reason` 用来区分"桌面先答"与"平台撤回"。
    const platform = request?.signal
    if (platform) {
      if (platform.aborted) controller.abort('platform')
      else platform.addEventListener('abort', () => controller.abort('platform'), { once: true })
    }
    // 手机先答之后要能宣告"这次请求结束了"，于是把下游拿到的 signal 换成并算后的那一份。
    // 顺序很重要：**先抓原件再接上去**，否则我们自己也会被这次撤销绊一下（`controller`
    // 一旦跟着断，runtime 会把手机刚点掉的那次应答当成"被撤回"再作废一遍）。
    const canceller = new AbortController()
    let handedOff = false
    if (request) {
      try {
        const fused = fuseSignals(platform, canceller.signal)
        request.signal = fused
        handedOff = request.signal === fused
        face.handoff = handedOff ? 'fused' : 'ignored'
      } catch (error) {
        // 请求对象被冻结时赋值会抛（ESM 一律严格模式）。这里退回"桌面那张卡等它自己的
        // 工具调用生命周期"——那是换 signal 之前的老行为，少收一张卡不至于更糟。
        face.handoff = `failed: ${messageOf(error)}`.slice(0, 80)
      }
    }
    /** 结算之后一律撤销：手机先答时它是"关掉桌面那张卡"的那一下，其余分支只是 release。 */
    const finish = (reason: string) => {
      if (!canceller.signal.aborted) canceller.abort(reason)
    }
    type Chain = { answered: boolean; value?: unknown; error?: unknown }
    // 桌面那一半**现在就启动**，不等手机。
    const desktop: Promise<Chain> = Promise.resolve()
      .then(() => next?.())
      .then(
        (value) =>
          // `undefined` 是"这个参与者没认领"（会把整条链冲掉），不是答案；
          // `'unavailable'` 是审批那条链末端的"没人可问"，也不是答案。
          value === undefined || (isApproval && value === 'unavailable')
            ? { answered: false, value }
            : { answered: true, value },
        (error) => ({ answered: false, error }),
      )
    const asked: Promise<unknown> = isApproval
      ? sink.approval({
          sessionId,
          action: String(request?.toolName ?? '工具调用'),
          ...(request?.reason ? { reason: String(request.reason) } : {}),
          signal: controller.signal,
        })
      : sink.question({
          sessionId,
          questions: (request?.questions ?? []).map((item, index) => mapQuestion(item, index)),
          signal: controller.signal,
        })
    const phone: Promise<Chain> = asked.then(
      (value) =>
        // 每一支都**带着自己是谁**回来：`'rejected'` 这个词手机和桌面都可能给出，
        // 只比数值就没法知道该收哪一张卡（第一版就是这么错的）。
        isApproval
          ? value === 'allowed-once' || value === 'rejected'
            ? { answered: true, value }
            : { answered: false, value }
          : value === null || value === undefined
            ? { answered: false, value }
            : { answered: true, value },
      // runtime 抛了（未配对、不在线、被撤）同样不算答案。
      () => ({ answered: false }) as Chain,
    )
    // 不算答案的那些取值换成"永远不落地"，于是 `Promise.race` 只会把真答案送出来；
    // 两边都收场了却都没有真答案时，由最后那条分支兜住（否则这里会挂死）。
    const pending = new Promise<{ src: 'phone' | 'desktop'; chain: Chain }>(() => {})
    const winner = await Promise.race([
      phone.then((chain) => (chain.answered ? { src: 'phone' as const, chain } : pending)),
      desktop.then((chain) => (chain.answered ? { src: 'desktop' as const, chain } : pending)),
      Promise.all([phone, desktop]).then(([, chain]) => ({ src: 'desktop' as const, chain })),
    ])
    if (!winner.chain.answered) {
      // 两边都没答上：手机那一侧要作废（pending 删掉、`waiting` 归零、卡片收掉）。
      controller.abort('desktop')
      finish('settled-without-answer')
      if (isApproval) {
        face.last = 'handed-back(neither answered)'
        return 'unavailable'
      }
      // 提问这条的"没人答"在宿主这边是一个 rejection（链子末端的 `noAnswerer()`），
      // 所以复述它，而不是返回一个"看起来像答案"的东西。
      face.last = 'no-answer'
      if (winner.chain.error !== undefined) throw winner.chain.error
      throw new Error('手机端未应答这次提问（未配对、不在线或已超时）')
    }
    // 桌面先答 → 手机那一侧要立刻作废（pending 条目删掉、`waiting` 归零、连手机上的卡一起收掉）。
    if (winner.src === 'desktop') controller.abort('desktop')
    if (winner.src === 'phone') {
      // 手机先答 → 桌面那张卡作废。撤销之后网关的 cancel 会发给每一个渲染端。
      finish('answered-by-phone')
      // 只有真的把可撤销的句柄交下去了，这一笔才算"桌面那张卡由我们关掉"；
      // 没换成功时按下去也没有任何东西会断，计数器不能替我们说谎。
      if (handedOff) face.desktopVoided += 1
    } else {
      finish('answered-by-desktop')
    }
    face.last = `${winner.src === 'phone' ? 'answered-by-phone' : 'answered-by-desktop'}(${describeOutcome(
      isApproval,
      winner.chain.value,
    )})`
    return winner.chain.value
  }

  /** 落点字符串：审批直接印 outcome 词表，提问印"答了几项"（答案正文不进 status.json）。 */
  function describeOutcome(isApproval: boolean, value: unknown): string {
    if (isApproval) return String(value)
    const answers = (value as { answers?: unknown } | undefined)?.answers
    return Array.isArray(answers) ? `${answers.length} 项` : typeof value
  }

  /**
   * 从一个对象里取第一个**非空**的字符串字段。
   *
   * 为什么不能直接 String(x ?? ""):协议里 questionItem.question 与
   * choiceOption.label 都是 nonEmpty,空串会让**整帧** zod 校验失败,
   * 而认不出的载荷是被**静默丢弃**的——手机上就永远不弹这张卡,
   * 主机这边还记着 questionsCalls=1 / no-answer,两头都对不上账
   * (2026-10-05 用户实测:dsh 弹了提问框,mp 端什么都没有)。
   */
  function firstText(item: LooseObject, keys: readonly string[]): string {
    for (const key of keys) {
      const value = item[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }

  /** 题面文字的候选字段名:宿主各版本叫法不一致,逐个试。 */
  const QUESTION_TEXT_KEYS = ['question', 'header', 'text', 'title', 'prompt'] as const
  /** 选项文字的候选字段名。 */
  const OPTION_TEXT_KEYS = ['label', 'text', 'title', 'value', 'name'] as const

  function mapQuestion(item: LooseObject, index: number): QuestionItem {
    const rawOptions = Array.isArray(item.options) ? (item.options as LooseObject[]) : []
    // 读不到题面就给一道稳定的占位题,**绝不给空串**(见 firstText 的注释)。
    const text = firstText(item, QUESTION_TEXT_KEYS) || '第 ' + String(index + 1) + ' 题'
    const options = rawOptions.map((option, optionIndex) => ({
      // 平台选项只有 label(没有 id),所以 id 由这里稳定生成:
      // 手机上回传 id,我们再映射回 label 交给平台(见 core/runtime.ts)。
      id: 'o' + String(optionIndex + 1),
      label: firstText(option as LooseObject, OPTION_TEXT_KEYS) || '选项 ' + String(optionIndex + 1),
    }))
    return {
      // id 是协议里的 **nonEmpty**：宿主给空串（或只有空白）时必须补一个稳定值，
      // 否则**整帧** question_request 会被 zod 拒掉并静默丢弃 —— 手机上永远不弹这张卡，
      // 而主机这边记着 questionsCalls=1 / no-answer，两头对不上账（题面那两处同理，见 firstText）。
      id: firstText(item, ['id']) || 'q' + String(index + 1),
      question: text,
      ...(item.multiSelect === true ? { multi: true } : {}),
      // 没有可选项就不带这个键:手机把空数组渲染成一张只有输入框的卡,
      // 与'有选项但都不可选'在用户眼里一模一样。
      ...(options.length > 0 ? { options } : {}),
    }
  }

  return {
    carrier: 'services',
    listSessions,
    async runState(sessionId: string) {
      const running = agentStatus(sessionId) === 'running'
      const archived = archivedIds()
      return { running, state: sessionState(sessionId, running, archived) }
    },
    sendPrompt,
    interrupt,
    readHistory,
    newSession,
    subscribe,
    attachInteractionSink,
    ensureRunnable,
    archiveSession,
    // 与发指令/续跑走同一条读取路径：这里原来还有一份实现，而且是 `current()` 裸调用
    // （不带 receiver；真要用 this 的服务方法会当场抛），两份迟早分叉。
    modelSelection: currentSelection,
    /**
     * 可切换模型清单。**这一代内核给不出清单也换不了**（`agentDefaultModel` 上只有
     * `currentSelection`），所以这里报 `canSwitch: false` 并附一句人话。
     *
     * 报false 而不是省略这个方法：省略会被 core 当成"只读"但**说不出原因**，
     * 手机上就只剩一个置灰的模型名，用户不知道是主机不支持还是自己哪里做错了。
     */
    modelOptions() {
      const { hits, canList, canSet } = probeModelFace()
      return {
        // 两个都要有才算能切：只有 list 没有 set 时手机上会列出候选却点了没反应，
        // 那比"换不了"更糟。
        canSwitch: canList && canSet,
        reason: canList && canSet ? undefined : `主机内核只提供读取（命中：${hits.join(',') || '无'}）`,
      }
    },
    describe() {
      return {
        carrier: 'services',
        sessions: typeof services.sessions === 'object',
        sessionQuery: typeof services.sessionQuery === 'object',
        // 读历史只依赖这一条。真机上"点进会话是空的"第一步就要分清：
        // 是宿主没这个能力、还是我们没读出来。没有这个字段就只能猜。
        historyFace:
          typeof fn(services.sessionQuery, 'readSession') === 'function'
            ? 'readSession'
            : `absent (keys=${shapeOf(services.sessionQuery)})`.slice(0, 120),
        // 新建会话只依赖这一条。和 historyFace 同理：真机上"新建没反应"第一件要分清的事
        // 是宿主没有这个能力，还是我们没调对。
        createFace:
          typeof fn(services.sessionController?.commands, 'create') === 'function'
            ? 'commands.create'
            : `absent (keys=${shapeOf(services.sessionController)})`.slice(0, 120),
        // 第二条换模型的可能路径：命令控制器上自带的方法（`setModel` / `switchModel`…），
        // 以及活agent 自己暴露的模型字段。前者能列出来就说明这条路通不通。
        commandsFace: shapeOf(services.sessionController?.commands),
        // **图片通路**（2026-10-06 真机事故后加）。真机现场是"发图 → 这一轮没有产出回复，
        // 内核报错 Cannot read properties of undefined (reading 'attachmentId')"，
        // 而 status.json 里当时没有任何一个字段能回答"这台主机到底能不能收图"。
        // 三态要分得开：走命令 / 只能自己过 attachment store / 两个面都没有。
        attachmentFace: attachmentFace(),
        agentModelFields: (() => {
          const first = firstLiveAgent()
          if (!first) return 'no-live-agent'
          return (
            Object.keys(first)
              .filter((k) => /model|provider|preset/i.test(k))
              .slice(0, 8)
              .join(',') || 'none'
          )
        })(),
        agents: typeof services.agents === 'object',
        agentDefaultModel: typeof services.agentDefaultModel === 'object',
        // 模型面到底有没有"写"的能力（能列可选、能切换）。手机上模型下拉该不该置灰，
        // 取决于这个而不是取决于"读得到当前值" —— 读得到只够显示一行文字。
        modelFace: modelFaceSummary(),
        // **上下文占用**（dsh-token-meter，2026-10-06 宿主能力普查后接上）。
        // 纯进程内服务、不发模型调用，只是回放会话日志做确定性测量。
        // 记它是为了先分清责任：读不到可能是这一代没有 tokenMeter，
        // 也可能是它没挂在 ctx 上 —— 没有这个字段，现场只能靠猜。
        contextUsageFace: contextUsageFace(),
        workspaceRegistry: typeof services.workspaceRegistry === 'object',
        userQuestions: typeof services.userQuestions === 'object',
        archivedSessions: archivedIds().size,
        hasOn: typeof services.on === 'function',
        // 真机排错的第一现场：内核到底发了哪些事件类型、其中哪些我们没认。
        // **不许截断**（2026-10-06）。曾经是 `.slice(-24)`：Set 保留插入顺序，
        // 所以一旦见过 24 种类型，这个字符串就永久冻结——更早见过的再也回不来。
        // 现场（本轮亲眼看着它滑动）：重启前 23 种、含 permission/preset；
        // 重启后 24 种、permission/preset 消失，尾部多了 llm/retry 等三种。
        //
        // 截断的代价是它**与 unmappedEventTypes 对不上账**：后者也是同一个
        // seenEventTypes 喂的，所以"被记成我们没认"却"在 eventTypes 里查不到"
        // 这件事本身就是个矛盾信号，而它恰恰是这个字段存在的理由
        // （"内核到底发了哪些事件类型、其中哪些我们没认"）。
        //
        // 不封顶是安全的：事件类型来自内核那份**有限词表**（本轮实测 59 种），
        // 不是随输入增长的集合——它天然有界，加 slice 只是自造截断。
        eventTypes: [...seenEventTypes].sort().join('|'),
        unmappedEventTypes: [...unmappedEventTypes].join('|'),
        injectedUserMessages: [...injectedUserMessages].map(([kind, count]) => `${count}×${kind}`).join('|') || 'none',
        approvalFace: faces['approval/request'].registered,
        approvalCalls: faces['approval/request'].calls,
        approvalLast: faces['approval/request'].last,
        approvalAsked,
        approvalDecided,
        approvalDesktopVoided: faces['approval/request'].desktopVoided,
        approvalSignalHandoff: faces['approval/request'].handoff,
        // 提问那一条与审批同构，所以读数也同一套：登记结果 / 被派发几次 / 最后走到哪一步 /
        // 手机先答时撤销了几次下游 signal / 那份 signal 换没换成功。
        questionsFace: faces['user-questions/request'].registered,
        questionsCalls: faces['user-questions/request'].calls,
        questionsLast: faces['user-questions/request'].last,
        questionsDesktopVoided: faces['user-questions/request'].desktopVoided,
        questionsSignalHandoff: faces['user-questions/request'].handoff,
        listenerErrors:
          [...listenerErrors]
            .slice(0, 4)
            .map(([key, count]) => `${count}×${key}`)
            .join(' | ') || 'none',
      }
    },
  }
}

/**
 * 会话事件类型 → 插件事件序列。**纯函数**，抽出来的理由与 `turnEndKernelEvents`
 * 一样：这一段每一条都对应一个真机形状，必须能在 CI 里逐条测，而不是等下一次重启宿主。
 * 未知类型返回空数组（不映射、不猜），由调用方留痕。
 */
export const MAPPED_SESSION_EVENTS = new Set([
  'turn/start',
  'assistant/message',
  'user/message',
  'tool/call',
  'tool/result',
  'turn/end',
  'session/title',
  'approval/asked',
  'approval/decided',
  // 内核的 todo/write 在真机的 eventTypes 里（status.json 的 unmappedEventTypes 曾一直记着它），
  // 但没人转发到手机——于是手机上一整轮"现在在干什么"都是空白。2026-10-05 补上。
  'todo/write',
  // agent/inbox/spliced（2026-10-06 接上，control 2.0.13）。
  //
  // 曾经 2026-10-05 把它加进来又 2026-10-06 撤出去：当时映射层产出 `{kind:'inbox'}`
  // 之后 `HostRuntime.onKernelEvent` 的 switch **没有 case 'inbox'**，事件从 switch
  // 末尾掉出去被丢弃——而因为它在这个表里，"没认就记进 unmapped"的留痕路径永不触发，
  // status.json 报"一切正常"，手机却什么都收不到。
  //
  // 接线不需要新协议载荷：inbox 就是"用户在 DSH 里发的、排给下一轮的消息"，
  // 与 `user/message` 走同一条渲染路（用户气泡 + 历史回放）——runtime 里
  // `case 'inbox'` 把它按 user role 推进合帧窗口，复用 `ev.message_delta`。
  // 手机本来就会渲染 role=user 的 delta（去重测试锁着），mp 一行不用改。
  'agent/inbox/spliced',
  // request/header 同理：它每轮都带**本会话真正在用的模型**。不映射的话，
  // mp 端只能显示宿主全局默认模型——那正是 2026-10-05 用户实测到的串台
  // （本会话在用 space-bunny-free，却显示别的会话切出来的 muse-spark）。
  'request/header',
  // 模型重试与上下文压缩（2026-10-06 取证：真机 session log 各 18 次，一直没映射）。
  // 前者让「模型卡住」变成「正在重试」，后者让压缩这段静默期看得见。
  'llm/retry',
  'compaction/start',
  'compaction/end',
])

export function sessionEventKernelEvents(input: {
  sessionId: string
  type: string
  seq: unknown
  data: LooseObject
}): KernelEvent[] {
  const { sessionId, type, data } = input
  switch (type) {
    case 'turn/start':
      return [{ kind: 'run-state', sessionId, state: 'running' }]
    case 'assistant/message': {
      // 工具调用在这一代宿主里有**两条**通道：结构化的 `tool/call` 事件，以及
      // assistant 正文里一段 XML 序列化（真机形状见 `stripToolCallXml` 的注释，
      // 取证：本机 session log 的 assistant/message 的 `type:'text'` part）。
      // 正文这段是同一信息的第二份副本——不剥掉它，手机上每条助手消息都挂着
      // 一段 XML 原文（用户 2026-10-04 截图：聊天框出现原始 tool_call XML），
      // 而结构化那条在步骤卡片里已经呈现（title 走 `argsTitle`）。
      //
      // 剥完之后可能是空串（整条消息只有一个工具调用）：这时**仍然发出这一帧**
      // （空正文 + messageId）。mp 的 `_applyText` 对空正文不建块（那里的注释
      // 记着真机上的“一排只有 padding 的空白窄条”），所以发空帧是安全的；
      // 而 messageId 必须跟着，否则下一条带字的消息会被挂到这一行上。
      const text = stripToolCallXml(textOf(data))
      return [
        {
          kind: 'delta',
          sessionId,
          messageId: messageIdOf(data, input.seq),
          text,
          role: 'assistant',
          done: true,
        },
      ]
    }
    case 'user/message': {
      // **只有真人输入才算"用户消息"**。宿主往会话里塞的东西一律走 `user/message`
      // 这个事件类型，但它们的 `source.kind` 分别是 time-context / runtime-context /
      // skill-catalog / agent-instructions / model-selection / tool-jobs / subagent-settled /
      // compact-checkpoint / schedule / team-message ……
      //
      // 第一版在这里不看 `source`，于是一条 `time-context` 快照在手机上顶着
      // 「你的指令」那颗蓝色气泡，内容是
      // 「Time sampled while preparing turn 3, step 1: 2026-10-02T23:04:02+08:00 …」——
      // 用户没发过这句话，却显示成他发的，这是**假事实**，比不显示坏得多。
      //
      // 所以判据只有一条：`source.kind === 'user'`。其余一律不出站。
      // 「静默丢掉」不成立：调用方（`translateSessionEvent`）会把这个计数写进
      // status.json 的 `injectedUserMessages`，真机问「为什么手机上看不到 X」时，
      // 第一步就能分清是宿主没发、我们丢了、还是路上丢了（与 outbound 计数同一套纪律）。
      if (!isHumanUserMessage(data)) return []
      return [
        {
          kind: 'delta',
          sessionId,
          messageId: messageIdOf(data, input.seq),
          text: textOf(data),
          role: 'user',
          done: true,
        },
      ]
    }
    case 'llm/retry': {
      // 取证 data：{retryId, turn, step, provider, mode, policyKey,
      //              retry, maxRetries, delayMs, failure:{message, code}}
      // policyKey 是一段策略 JSON、对用户毫无意义，不出站。
      const failure = data.failure as LooseObject | undefined
      const code = typeof failure?.code === 'string' ? failure.code : ''
      const message = typeof failure?.message === 'string' ? failure.message : ''
      const attempt = typeof data.retry === 'number' ? data.retry : 1
      const max = typeof data.maxRetries === 'number' ? data.maxRetries : attempt
      return [
        {
          kind: 'retry',
          sessionId,
          attempt,
          max,
          // 只在有话可说时带原因：空的 reason 会渲染成「因为：」这种半截话。
          ...(code || message ? { reason: (code || message).slice(0, 120) } : {}),
        },
      ]
    }
    case 'compaction/start':
      return [{ kind: 'compaction', sessionId, state: 'started' }]
    case 'compaction/end': {
      // end 带 error = **压缩失败了**，与「压缩完了」对用户是两件事（真机见过
      // `summarization produced no text summary content`）。
      const error = typeof data.error === 'string' ? data.error.trim() : ''
      return [
        {
          kind: 'compaction',
          sessionId,
          state: error ? 'failed' : 'ended',
          ...(error ? { error: error.slice(0, 160) } : {}),
        },
      ]
    }
    case 'request/header': {
      // **这条会话这一轮真正在用的模型**（2026-10-05 用户实测：当前会话跑
      // space-bunny-free，mp 端顶栏却显示别的会话切出来的 muse-spark）。
      //
      // 以前读的是 agentDefaultModel.currentSelection()，那是**宿主全局默认
      // 模型**（新建会话用哪个），与本会话无关：用户在别的会话切一次模型，
      // 全局默认就变了，本会话的显示跟着变——而本会话根本没换过。
      //
      // 真机形状：data.header.config = {provider, model, maxTokens, ...}，
      // **每轮一条**（实测 30 轮 30 条）。
      //
      // 读不到 model 就不出站：宁可这一轮不更新模型名，也不要显示错的。
      const cfg = (data.header as LooseObject | undefined)?.config as LooseObject | undefined
      const modelName = cfg?.model
      if (typeof modelName !== 'string' || !modelName) return []
      return [
        {
          kind: 'model',
          sessionId,
          model: modelName,
          provider: typeof cfg?.provider === 'string' ? cfg.provider : undefined,
        },
      ]
    }
    case 'agent/inbox/spliced': {
      // **「用户在 DSH 里发的消息」在这里第一次变得可见**（2026-10-05 取证）。
      //
      // 之前这条事件被 default: return [] 吞掉，于是插件完全不知道主机侧
      // 有人在排队——status.json 的 kernel.unmappedEventTypes 里一直记着它，
      // 是当时的唯一线索。真实负载（真机 session log，338 条）：
      //   data.target     'next-turn'(163) | 'next-step'(175)
      //   data.inserted   180 条有内容 / 158 条是**空数组**
      //   source.kind     user(92) / ptc-mode(51) / repeat-tool-reminder(29)
      //                   / user-approval(4) / tool-jobs(4)
      //
      // 三道过滤，缺一条手机就会多出假排队：
      //   1. target !== 'next-turn' → 这是插话（当前轮内就消化），不是排队。
      //   2. inserted 为空 → 纯 start 调整，没有任何消息进来。
      //   3. source.kind !== 'user' → 内核自己塞的（图片回传、后台任务回执、
      //      重复调用提醒、审批策略变更）。判据与 user/message 那条同源、
      //      同一个理由：不是人写的话不能顶着用户的样子显示。
      //
      // messageId 用 inserted[0].id（内核给的原始 id），这样主机侧的消息
      // 与手机侧的消息进的是同一张表、同一套去重逻辑。
      if (data.target !== 'next-turn') return []
      const inserted = Array.isArray(data.inserted) ? data.inserted : []
      const first = inserted[0] as LooseObject | undefined
      if (!first || !isHumanUserMessage(first)) return []
      return [
        {
          kind: 'inbox',
          sessionId,
          target: 'next-turn',
          messageId: typeof first.id === 'string' ? first.id : 'i' + String(input.seq),
          text: textOf(first),
        },
      ]
    }
    case 'tool/call': {
      // 字段名要按真机形状读：内核给的是 `arguments`（一个 JSON 串），不是 `args`；
      // 读错了这一帧永远停在 'started'，手机上看不到参数、也看不出工具在跑什么。
      const argsRaw = data.arguments ?? data.args
      return [
        {
          kind: 'tool',
          sessionId,
          callId: String(data.callId ?? data.id ?? `tool_${input.seq ?? 0}`),
          phase: argsRaw === undefined || argsRaw === null ? 'started' : 'args',
          tool: typeof data.name === 'string' ? data.name : undefined,
          title: typeof data.title === 'string' ? data.title : argsTitle(argsRaw),
          ...(argsRaw === undefined ? {} : { argsPreview: argsPreviewOf(argsRaw) }),
        },
      ]
    }
    case 'todo/write': {
      // 内核形状（取证：app.asar 的 typert.host.js）：`todo/write: { todos: TodoItem[] }`，
      // `TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed' }`。
      // 每次都是**全量快照**——所以这里也只发整份，不做增量，手机侧同样整份替换。
      //
      // 三条夹取，每条都对应一个真机上的坏味道：
      // - status 不在三元里 → 当 pending（未知状态显示成"没状态"比降级成待办更怪）；
      // - content 非字符串 / 空 → 丢掉这一条（一条没有字的待办在面板里就是一行空白）；
      // - 整份夹到 50 条：真机上单轮 todo 一般十条以内，超了说明这一轮真的很大，
      //   那更该给手机一个能滚动的清单而不是把面板顶到屏幕外。
      const raw = Array.isArray(data.todos) ? (data.todos as LooseObject[]) : []
      const todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] = []
      for (const item of raw) {
        if (todos.length >= 50) break
        const content = typeof item?.content === 'string' ? item.content.trim() : ''
        if (!content) continue
        const status = item?.status
        todos.push({
          content: content.slice(0, 200),
          status: status === 'in_progress' || status === 'completed' || status === 'pending' ? status : 'pending',
        })
      }
      // 空数组也发：内核清空清单时手机必须跟着清（会话跑完一轮 todo 常常整个被清掉）。
      return [{ kind: 'todo', sessionId, todos }]
    }
    case 'tool/result': {
      const message = data.message as LooseObject | undefined
      const callId = data.callId ?? message?.toolCallId ?? (message?.source as LooseObject | undefined)?.callId ?? ''
      // 正文同样在两处：顶层 `result`（一代）与 `data.message.content`（真机这一代）。
      const body = data.result ?? data.error ?? eventContent(data)
      return [
        {
          kind: 'tool',
          sessionId,
          callId: String(callId),
          phase: data.error ? 'failed' : 'completed',
          resultPreview: previewOf(body),
        },
      ]
    }
    case 'turn/end':
      return turnEndKernelEvents({ sessionId, seq: input.seq, data })
    case 'session/title':
      return typeof data.title === 'string' ? [{ kind: 'title', sessionId, title: data.title }] : []
    case 'approval/asked':
    case 'approval/decided':
      // 审批审计事件（emit-mode，经 session/event 到达）。审批卡片本身由
      // `approval/request` 的参与者路径产生，见 attachInteractionSink。
      return [{ kind: 'sessions-changed', reason: type }]
    default:
      return []
  }
}

/**
 * 旧插件（2026-10-06 之前）留下的"坏图片消息"在内核里的报错形状。
 *
 * 取证：`~/.dsh/sessions/.../session-3ca94040…/session.v4.jsonl.zstd` —— 修复后新发的
 * 图已经是 `{type:'image', attachment:{attachmentId:'sha256:…'}}`（对的），而同一条会话
 * 历史里还留着修复前那两条 `{type:'image', data, mimeType}`。内核每轮都要遍历
 * **全部**历史消息求图片版本（`assertImagesFit` → `versions.get(block.attachment.attachmentId)`，
 * `@deepseek-ai/dsh-llm-deepseek/lib/index.js:1436`），于是第一条坏块就把**之后每一轮**
 * 全部打死 —— 连纯文本消息也一样（日志里 21:34:14 那条纯文本就是这么崩的）。
 */
const POISONED_IMAGE_HISTORY = /reading 'attachmentId'/

/**
 * 回合失败时给手机看的那句话。
 *
 * 中文打底 + 原始原因照抄：只说"失败了"用户无从下手，只贴英文栈又看不懂。
 * 长度夹住（内核的 message 可能带着整段 prompt 或栈），并剥掉可能的路径与凭据形态。
 */
function turnErrorText(reason: { kind?: string; error?: { message?: string; code?: string } } | undefined): string {
  const raw = String(reason?.error?.message ?? reason?.kind ?? '未知错误')
    .replace(/\s+/g, ' ')
    .trim()
  // 这一条要**可操作**：用户能做的事只有"新建一条会话"，说清楚比报 UNKNOWN 有用。
  // 不许在这里承诺"我们已经修好了"——那条坏消息在会话日志里，只有换会话能绕开。
  if (POISONED_IMAGE_HISTORY.test(raw)) {
    return (
      '这一轮没有产出回复：这条会话的历史里有一条没走通的图片消息（修复前留下的数据，缺持久引用），内核每轮都要读它，连纯文本消息也会被拖崩。请新建一条会话再试。原始报错：' +
      raw.slice(0, 80)
    )
  }
  const code = reason?.error?.code ? `（${String(reason.error.code)}）` : ''
  return `这一轮没有产出回复，内核报错${code}：${raw.slice(0, 240)}`
}

/**
 * 内核 `turn/end` → 插件事件序列。单独抽出来是为了**能在 CI 里测**：
 * 这一条是真机取证抓出来的（宿主在 prompt 装配阶段抛
 * `prompt variable "{{model}}" has no value for this assembly`，而第一版把
 * `data.reason` 整个丢掉，于是手机上"一个字都没有的失败回合"与"成功的回合"
 * 长得一模一样，live-e2e 十五项全绿而实际没有任何回复）。
 * 顺序是有约定的：先补 done，再报 idle，否则手机的转圈停不下来（F9）。
 */
export function turnEndKernelEvents(input: { sessionId: string; seq: unknown; data: LooseObject }): KernelEvent[] {
  const reason = input.data.reason as { kind?: string; error?: { message?: string; code?: string } } | undefined
  const failed = reason?.kind === 'error'
  const messageId = `turn_${input.seq ?? 0}`
  const events: KernelEvent[] = []
  if (failed)
    events.push({
      kind: 'delta',
      sessionId: input.sessionId,
      messageId,
      text: turnErrorText(reason),
      role: 'system',
      done: false,
    })
  events.push({ kind: 'delta', sessionId: input.sessionId, messageId, text: '', done: true })
  events.push({
    kind: 'run-state',
    sessionId: input.sessionId,
    state: 'idle',
    ...(failed ? { detail: 'turn-error' } : {}),
  })
  return events
}

/**
 * 一条会话事件的正文在哪里。
 *
 * **两代形状都要认**（真机取证）：`user/message` 把 `content` 放在事件 data 顶层，
 * 而 `assistant/message` 放在 `data.message.content`（同一层还有 `turn/step/usage/stream`）。
 * 第一版只读顶层，于是助手的回复折成空串——手机上"流式输出到达"的断言**仍然通过**
 * （done 帧照发、帧数照够），但屏幕上一个字都没有。这是这条链路上最要命的一类缺陷：
 * 判据数的是帧，不是内容。
 */
function eventContent(data: LooseObject): unknown {
  if (data?.content !== undefined && data?.content !== null) return data.content
  const message = data?.message as LooseObject | undefined
  return message?.content
}

// ── 历史：内核日志 → 一页线格式条目 ───────────────────────────────────

/** 单张页面的正文总预算（字符）。超了就少给几条，剩下的由游标继续翻。 */
const HISTORY_CHAR_BUDGET = 100_000
/** 单条正文的硬上限。小程序侧的正文块上限是 20000，这里留出余量。 */
const HISTORY_TEXT_MAX = 12_000

/**
 * 内核日志 → 一页历史。**纯函数**，理由与 `sessionEventKernelEvents` 一样：
 * 这一段每一条都对应一个真机形状，必须能在 CI 里逐条测。
 *
 * 三件在真机日志上验证过的事（取证：`~/.dsh/sessions/**\/session.v4.jsonl.zstd`）：
 *
 * 1. **日志事件与实时 `session/event` 是同一个形状**（`{type, seq, data}`），
 *    所以这里直接复用 `sessionEventKernelEvents`。顺带得到一个关键性质：
 *    同一条消息在两条路径上算出的 `messageId` **逐字相同**（都走 `messageIdOf`），
 *    于是"实时已经渲染过、历史里又来一遍"这种重叠靠 id 就能去重。
 * 2. **一条原始事件可能折成 0 条**：绝大多数 `assistant/message` 带的是
 *    `reasoning` + `tool-call`（正文是**空的**），按 M28 只有 `type==='text'` 的分片出站。
 *    不过滤的话，历史里会插进一堆空白正文块。
 * 3. **`turn/end` 会产生终结帧**（空文本 + done、以及 run-state）。历史不需要终结帧
 *    ——没有东西需要被终止——所以只留 delta/tool 两种，运行态一律丢掉：
 *    回放历史不该去改顶栏的"运行中"。
 */
export function historyPageFromLog(input: {
  sessionId: string
  events: Array<{ type?: unknown; seq?: unknown; data?: unknown }>
  beforeSeq?: number
  limit: number
  charBudget?: number
  /**
   * 这条会话**此刻是否正在跑**。
   *
   * 只决定"要不要把历史里那份待办快照当成此刻的清单补给手机"（见下面那段）。
   * 默认 false = 不补：**宁可手机空着，也不要让它说一句主机此刻没说的话。**
   */
  running?: boolean
}): KernelHistoryPage {
  const { sessionId } = input
  const groups: Array<{ seq: number; events: KernelEvent[] }> = []

  for (const raw of input.events ?? []) {
    const type = typeof raw?.type === 'string' ? raw.type : ''
    if (!type) continue
    const seq = typeof raw?.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : 0
    const data = (raw?.data ?? {}) as LooseObject
    const mapped = sessionEventKernelEvents({ sessionId, type, seq, data })
    const kept = mapped
      .filter(isHistoryWorthy)
      // 会话**不在跑**时，历史里的待办快照整条丢掉（2026-10-07 用户实测双端不一致）。
      //
      // 为什么不能只是"不补"：待办事件本来就在日志里，只要落在第一页窗口内就会
      // 原样送到手机，而 mp 的 `_replayTodos` 把它当**此刻的清单**显示。
      // 宿主那一侧是按轮清的——这一轮没写待办，它就是空的；于是用户看到一件
      // **没在发生的事**。所以要丢的是"作为呈现的待办"，不是"作为历史事实的待办"
      // （历史里那次待办确实发生过，只是不该被当成现在）。
      .filter((event) => input.running === true || event.kind !== 'todo')
    if (kept.length > 0) groups.push({ seq, events: kept })
  }

  // 一次调用里的所有 tool/call：它的结果在不在**整份日志**里。读历史时整份日志都到手了，
  // 所以这里能区分"这一步确实干完了"与"这一步没有下文"。
  const terminal = new Set<string>()
  for (const group of groups) {
    for (const event of group.events) {
      if (event.kind === 'tool' && (event.phase === 'completed' || event.phase === 'failed')) {
        terminal.add(event.callId)
      }
    }
  }

  const ranged = collapseTodoSnapshots(
    input.beforeSeq === undefined ? groups : groups.filter((group) => group.seq < input.beforeSeq!),
  )
  const limit = Math.max(1, input.limit)
  const budget = input.charBudget ?? HISTORY_CHAR_BUDGET

  // 从**后往前**取，保证拿到的是"最近的一页"，而不是会话开头。
  const page: typeof groups = []
  let items = 0
  let chars = 0
  for (let i = ranged.length - 1; i >= 0; i--) {
    const group = ranged[i]!
    // 已经够一页了：**但至少给一组**，否则 limit 很小时会产出一张空页而游标还在动。
    if (page.length > 0 && (items >= limit || chars >= budget)) break
    const normalized = group.events.map((event) => normalizeHistoryEvent(event, terminal))
    page.unshift({ seq: group.seq, events: normalized })
    items += normalized.length
    chars += normalized.reduce((sum, event) => sum + charCountOf(event), 0)
  }

  const flat: KernelEvent[] = []
  for (const group of page) flat.push(...group.events)

  // **只在会话正在跑的时候**把历史里那份待办快照补给手机。
  //
  // 起因（2026-10-06 用户实测）：40 条窗口装满工具事件时快照会被裁在外面，
  // 手机**重进一条正在跑的**长会话，顶部条子直接消失，而且之后没有 todo 变更
  // 就没有实时帧来补，它会一直缺着。
  //
  // 为什么后来收窄到"正在跑"（2026-10-07 用户实测双端不一致）：待办的语义是
  // **"此刻这一轮的清单"**，而宿主那一侧正是这么做的——上一轮写过、这一轮没写，
  // 宿主的清单就是空的。以前这里**无条件**补，于是手机把上一轮的清单当作
  // "此刻在做什么"显示，而宿主此刻什么都没有：用户看到的是一件**没在发生的事**。
  // 这属于本仓库反复出现的那一类（静默黑洞 / 假事实），而"条子消失"那种症状
  // 只在**正在跑**时才成立——所以收窄之后既一致又不回归。
  //
  // 只补第一页：更早页的快照是过期的，手机只应用第一页那一份（mp 侧守卫）。
  // 快照很小（十几条短文本），不计入分页预算——预算管的是"别顶满中继帧"，
  // 一份清单顶不满（wire 1.5.0 同一口径）。
  // 不用再判 `running`：**上一段的过滤器已经保证 `flat` 里一条 todo 都没有**
  // （不在跑时整条被丢掉）。再判一遍是同一件事说两遍，而两遍里总有一遍会先被放宽。
  if (input.beforeSeq === undefined && !flat.some((event) => event.kind === 'todo')) {
    for (let i = ranged.length - 1; i >= 0; i--) {
      const snap = ranged[i]!.events.find((event) => event.kind === 'todo')
      if (snap) {
        flat.push(normalizeHistoryEvent(snap, terminal))
        break
      }
    }
  }

  // 游标只在**确实还有更早、且还有内容**的时候给：给出一个翻不出东西的游标，
  // 手机上会长出一个点了没反应的「加载更早」。
  const earliest = page.length > 0 ? page[0]!.seq : undefined
  const hasEarlier = earliest !== undefined && ranged.some((group) => group.seq < earliest)

  return {
    events: flat,
    ...(hasEarlier ? { nextBeforeSeq: earliest } : {}),
  }
}

/**
 * 历史里放行什么。
 *
 * 前两条是"有内容"判据；第三条 `todo` 是 2026-10-06 补的：
 * 它以前**连映射都做了**（`case 'todo/write'` 在下），但在这里被 return false
 * 挡掉了，于是 `runtime.ts` 里 `historyWireItem` 的 todo 分支是**死代码**——
 * mp 的 `_replayTodos` 恒为 undefined，顶部那颗待办条只在"页面正好开着、
 * 真机又正好推来一帧实时 ev.todo"时才出现，打开一条已有会话就什么都没有。
 *
 * 预算的账在 `collapseTodoSnapshots` 里算：todo 是**全量快照**（内核每轮
 * todo 工具调用都发一整份），直接放行会让一页塞进几十条冗余快照、把正文挤出去。
 */
function isHistoryWorthy(event: KernelEvent): boolean {
  if (event.kind === 'delta') return event.text.length > 0
  if (event.kind === 'tool') return event.callId.length > 0
  // 待办整份都是"内容"，是否保留交给塌缩那一步决定（见 collapseTodoSnapshots）。
  if (event.kind === 'todo') return true
  return false
}

/**
 * 一页历史里只留**最后一份**待办快照。
 *
 * 为什么不是"每份都留"：`todo/write` 是全量语义，同一轮里会连发好几份，
 * 前两份的内容会被后一份整体覆盖。一页留一份既符合 mp 侧本来就只取最后一份的
 * 语义（`chat.js` 的 `_replayTodos`），又让 `items` / `charBudget` 的账算得准——
 * 否则几十条冗余快照会把真正的正文挤出首页。
 *
 * **空清单也是一份快照，照样保留**：用户 2026-10-06 拍板「取最后一份」。
 * 所以一轮跑完内核把清单清空之后，历史里最后一份就是空的，mp 因此不显示那颗条子
 * ——这是忠实语义，不是漏数据。
 *
 * 必须在**预算循环之前**做：否则被丢掉的那些快照已经计进了 items/chars，
 * 账面会虚高、实际取到的正文比预算允许的少。
 */
function collapseTodoSnapshots(groups: Array<{ seq: number; events: KernelEvent[] }>): typeof groups {
  let lastTodoIdx = -1
  for (let i = 0; i < groups.length; i++) {
    if (groups[i]!.events.some((event) => event.kind === 'todo')) lastTodoIdx = i
  }
  if (lastTodoIdx < 0) return groups
  const out: typeof groups = []
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!
    if (i === lastTodoIdx || !group.events.some((event) => event.kind === 'todo')) {
      out.push(group)
      continue
    }
    const kept = group.events.filter((event) => event.kind !== 'todo')
    // 这一组只装了待办的话，整组消失（否则会产出一个空组，白占 seq 与游标）。
    if (kept.length > 0) out.push({ seq: group.seq, events: kept })
  }
  return out
}

/**
 * 一条没有下文（整份日志里都没有结果）的工具调用，在历史里要有个说法。
 *
 * 它只会出现在"这一轮被中断或出错"的情形。原样留给手机的话，步骤组会显示
 * 「正在执行 1 个步骤」并一直闪 —— 而那条会话其实早就停了，看起来就像页面坏了。
 * 所以这里落成一个明确的、不撒谎的形态：状态按"已结束"渲染，结果位写明原因。
 *
 * 如果这条会话此刻还在跑，真正的那条结果稍后会从实时流到达，手机按 callId
 * 在原位替换掉这句占位文案（`chat.js` 的 `_onTool` 就是按 callId 找的）。
 */
function normalizeHistoryEvent(event: KernelEvent, terminal: Set<string>): KernelEvent {
  if (event.kind === 'delta') {
    if (event.text.length <= HISTORY_TEXT_MAX) return event
    return { ...event, text: `${event.text.slice(0, HISTORY_TEXT_MAX)}…（这条回复过长，已截断）` }
  }
  if (event.kind === 'tool' && !terminal.has(event.callId) && event.phase !== 'completed' && event.phase !== 'failed') {
    return { ...event, phase: 'completed', resultPreview: '（这一轮被中断，这个工具没有返回结果）' }
  }
  return event
}

function charCountOf(event: KernelEvent): number {
  if (event.kind === 'delta') return event.text.length
  if (event.kind === 'tool') return (event.resultPreview ?? '').length + (event.argsPreview ?? '').length
  return 0
}

/**
 * 这条 `user/message` 是不是**真人敲的那一句**。
 *
 * 取证（`~/.dsh/sessions/**\/session.v4.jsonl.zstd`，把全部会话按 `source.kind` 统计）：
 * 宿主把注入内容也写成 `user/message`，靠 `source.kind` 区分，实测见过
 * `user`（真人的话）、`time-context`、`runtime-context`、`skill-catalog`、
 * `agent-instructions`、`model-selection`、`tool-jobs`、`subagent-settled`、
 * `compact-checkpoint`、`schedule`、`team-message`、`agent-message`、`user-approval`、
 * `ptc-mode`。判据必须是 `source`，不是事件类型 —— 事件类型它们全都一样。
 *
 * **缺 `source` 时按真人处理**：宿主若真的发了不带 `source` 的一条，那是旧一代的形状，
 * 而把真人指令误判成注入 = 用户发的话凭空消失，代价比多显示一条注入大得多。
 */
function isHumanUserMessage(data: LooseObject): boolean {
  const source = data?.source
  if (source === undefined || source === null) return true
  if (typeof source !== 'object') return true
  const kind = (source as LooseObject).kind
  if (typeof kind !== 'string' || !kind) return true
  return kind === 'user'
}

function textOf(data: LooseObject): string {
  const content = eventContent(data)
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && (part as LooseObject).type === 'text'
          ? String((part as LooseObject).text ?? '')
          : '',
      )
      .join('')
  }
  return ''
}

function messageIdOf(data: LooseObject, seq: unknown): string {
  const message = data?.message as LooseObject | undefined
  const id = data?.id ?? data?.messageId ?? message?.id
  if (typeof id === 'string' && id) return id
  return `msg_${String(seq ?? Date.now())}`
}

/**
 * 剥掉 assistant 正文里的工具调用 XML。
 *
 * 真机形状（取证：本机 session log 的 assistant/message）：这一代宿主把工具
 * 调用**同时**写进结构化 part（`type:'tool-call'`）和一个 `type:'text'` part
 * 的 XML 序列化里。结构化那条由 `tool/call` 事件单独出站（title 走
 * `argsTitle`），正文这段是同一信息的第二份副本——把它透到手机上，用户看到
 * 的就是聊天框里一段 XML 原文（用户 2026-10-04 截图报的就是它）。
 *
 * 三条判别，都是被真机形状逼出来的：
 * ① **只剥完整的块**（开标签到闭合标签），块外的正文一个字不动；
 * ② **尾部未闭合的块也剥**（流被掐断时），但要求开标签后紧跟 function=——
 *    否则正文里反引号包着的提到（真机上出现过：助手解释“手机上有原始
 *    XML”这件事时自己写了那个标签）会被当成块开头，从那儿把真正的正文删光；
 * ③ 剥完可能是空串（整条消息只有一个工具调用）——调用方按空正文发帧，
 *    mp 侧不建块（见 `_applyText` 的“空正文不建块”注释）。
 */
const TOOL_CALL_BLOCK = /<tool_call>\s*<function=[\s\S]*?<\/tool_call>/g
const TOOL_CALL_UNCLOSED = /<tool_call>\s*<function=[\s\S]*$/

export function stripToolCallXml(text: string): string {
  const stripped = text.replace(TOOL_CALL_BLOCK, '').replace(TOOL_CALL_UNCLOSED, '')
  // 只剩空白（整条都是 XML + 换行）就归还真正的空串：mp 对空串不建块，
  // 对一个 '\n' 却会建（真机上那是一排只有 padding 的空白窄条）。
  return stripped.trim() === '' ? '' : stripped
}

/* ── 图片附件：手机送来的东西 → 内核入口形状（PromptContentPart）──────────── */

/**
 * 内核这一代只认这四种图片类型。
 *
 * 取证：`@deepseek-ai/dsh-llm/lib/typert.host.js:333`
 * `export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'`
 * —— 部署的 attachment store 还会再按 `imageLimits.mediaTypes` 过滤一次
 * （`dsh-attachment/lib/types/index.js:32`），不在单子里的会带着
 * `UNSUPPORTED_IMAGE_TYPE` 被拒。与其让整回合以 error 收场，不如在进内核前说清楚。
 */
export const KERNEL_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** 声明的媒体类型 → 内核口径。`image/jpg` 是野生写法（wx 与各家客户端都这么写），折成 jpeg。 */
function normalizeMediaType(raw: unknown): string | undefined {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase()
    .split(';')[0]!
    .trim()
  if (text === 'image/jpg') return 'image/jpeg'
  return (KERNEL_IMAGE_MEDIA_TYPES as readonly string[]).includes(text) ? text : undefined
}

/**
 * 按**字节**判定图片类型，而不是信手机上那个声明。
 *
 * 为什么不信声明：入口形状里类型错了，内核只会回一句 `UNSUPPORTED_IMAGE_TYPE`
 * （用户看到的是"发图失败"，完全不知道是相册给错了类型还是我们认错了）；
 * 而我们手上就有字节，魔数判据是零成本的。声明只当魔数认不出来时的兜底。
 */
function sniffImageMediaType(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('latin1') === 'GIF8') return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return undefined
}

/**
 * 解成**规范 base64**（内核的硬要求）。
 *
 * 取证：`@deepseek-ai/dsh-attachment/lib/types/admission.js:5-14`
 * `decodeCanonicalBase64()`：`Buffer.from(data,'base64').toString('base64') !== data`
 * 就抛 `INVALID_IMAGE_BASE64`。所以带换行、带空白、带 data-URI 前缀的都要先规整——
 * 这些形态在手机侧都可能发生（e2e 夹具里就出现过 `data:image/png;base64,…` 当 payload）。
 *
 * 这里选择**规整而不是直接拒**：解码后重新编码与原文不同，多半只是空白或前缀，
 * 字节本身是好的；只有解不出字节（非法字符集 / 解出来是空的）才拒绝。
 */
function decodeImageBase64(raw: unknown): { data: string; bytes: Buffer } | undefined {
  let text = String(raw ?? '').trim()
  if (/^data:/i.test(text)) {
    const comma = text.indexOf(',')
    if (comma < 0) return undefined
    text = text.slice(comma + 1)
  }
  text = text.replace(/\s+/g, '')
  if (text === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return undefined
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== text) return undefined
  return { data: bytes.toString('base64'), bytes }
}

/** 内核入口形状的一个图片块（`PromptContentPart` 的 image 变体）。 */
export interface KernelImagePart {
  type: 'image'
  /** 内核叫 `mediaType`，**不是** `mimeType`（取证见文件里 submitWithImages 的表）。 */
  mediaType: string
  /** 规范 base64（无空白、无前缀）。 */
  data: string
}

/**
 * 一批手机图片 → 内核入口形状的图片块。
 *
 * 整批先验后返：任何一张不合格就整条拒绝并说明是哪一张第几张，
 * 而不是让内核在自己的回合里抛一句 UNKNOWN（那正是这次事故的用户可见形态）。
 */
export function prepareImageParts(
  attachments: ReadonlyArray<{ data: string; mimeType: string }>,
): { ok: true; parts: KernelImagePart[] } | { ok: false; message: string } {
  const parts: KernelImagePart[] = []
  for (const [index, one] of (attachments ?? []).entries()) {
    const decoded = decodeImageBase64(one?.data)
    if (!decoded) {
      return { ok: false, message: `第 ${index + 1} 张图片的数据不是合法的 base64，请重新选一次` }
    }
    const mediaType = sniffImageMediaType(decoded.bytes) ?? normalizeMediaType(one?.mimeType)
    if (!mediaType) {
      return {
        ok: false,
        message: `第 ${index + 1} 张图片的类型是 ${String(one?.mimeType || '未知')}，这台主机只收 ${KERNEL_IMAGE_MEDIA_TYPES.join(' / ')}`,
      }
    }
    parts.push({ type: 'image', mediaType, data: decoded.data })
  }
  return { ok: true, parts }
}

/**
 * 工具调用的“这一步行标题”。
 *
 * 真机形状：`arguments` 是一个 **JSON 串**。旧实现把它整串当 title，于是步骤
 * 卡片上每个 run_code 都挂着一 455 字符的 JSON——用户原话“run_code 有点
 * 看不懂”（2026-10-04 截图）。模型写工具调用时都会带 `description`（一句话
 * 说明这一步在干什么），那才是给人看的标题。取不到的才退回整串预览。
 */
function argsTitle(argsRaw: unknown): string | undefined {
  const parsed = tryParseJson(argsRaw)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as LooseObject
    for (const key of ['description', 'prompt', 'command', 'path', 'file_path', 'pattern', 'query', 'url']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return oneLine(value)
    }
  }
  return previewOf(argsRaw)
}

/** 展开时看的参数：是 JSON 就美化（真换行、有缩进），否则原样。 */
function argsPreviewOf(argsRaw: unknown): string | undefined {
  const parsed = tryParseJson(argsRaw)
  if (parsed !== undefined) {
    try {
      return previewOf(JSON.stringify(parsed, null, 2))
    } catch {
      /* 美化失败就原样，下面那句兜底 */
    }
  }
  return previewOf(argsRaw)
}

function tryParseJson(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}

/**
 * 把任意内核值折成“给人看的预览文本”。
 *
 * 为什么不能直接 JSON.stringify：真机上 `tool/result` 的正文是
 * `data.message.content`，一个 **part 数组**。旧实现对非字符串一律 stringify，
 * 于是手机上每个工具结果都长这样 `[{"type":"text","text":"{\n …`——
 * 换行是两个字面量、引号带反斜杠，markdown 渲染出来就是一片乱码
 * （用户 2026-10-04 截图报的正是它）。所以：能取出人话就取人话，
 * 取不到才 stringify（那是真的结构化数据）。
 *
 * 取不到的判定同样重要：part 数组里的非文本 part（图片等）没有 text 字段，
 * 把它们也 stringify 进去等于把协议碎片贴给用户——跳过，只留文本。
 */
function readableText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => readableText(part))
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
    return parts.length > 0 ? parts.join('\n') : undefined
  }
  if (typeof value === 'object') {
    const record = value as LooseObject
    // 文本字段按“最像正文”的顺序找。message / result / error 是嵌套入口
    // （真机形状：{message:{content:[...]}}、{error:{message:'...'}}）。
    for (const key of ['content', 'text', 'output', 'stdout', 'stderr', 'message', 'result', 'error']) {
      if (record[key] === undefined || record[key] === null) continue
      const nested = readableText(record[key])
      if (nested !== undefined && nested !== '') return nested
    }
    // 带 type 但不是文本的 part（图片、文件…）：没有可取的人话，不贴协议碎片。
    if (typeof record.type === 'string' && record.type !== 'text') return undefined
    return safeJson(record)
  }
  return safeJson(value)
}

function previewOf(value: unknown): string | undefined {
  const text = readableText(value)
  if (!text) return undefined
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`超时 ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

function sessionIdOf(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') continue
    const direct = (arg as { sessionId?: unknown }).sessionId
    if (typeof direct === 'string') return direct
    const nested = (arg as { session?: { id?: unknown } }).session
    if (nested && typeof nested.id === 'string') return nested.id
  }
  return undefined
}
