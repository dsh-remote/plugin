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
import { canParticipate, canSubscribe, guardedSubscribe } from './guard.js'
import type {
  ApprovalDecision,
  AskUserQuestionAnswerValue,
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
   * 新建会话的唯一落点。
   *
   * 取证：`@deepseek-ai/dsh-api-session-controller` 的 `SessionController` 内部持有
   * `SessionCommandController`，暴露成 `ctx.sessionController.commands.create(request)`
   * （`lib/types/commands.js` 的 `async create(request)`，返回 `{ sessionId, agentPreset? }`）。
   * 真实宿主里它由 Remote 服务委派，**不在 kernel 的必选成员里** —— 缺了它只是少一个能力，
   * 不该把整条载体判定拖垮，所以它是可选服务。
   */
  sessionController?: LooseObject
  /** cordis 的事件注册口；对 waterfall 是**参与式**监听。 */
  on?(name: string, listener: (...args: unknown[]) => void): unknown
  off?(name: string, listener: (...args: unknown[]) => void): unknown
}

export interface ServicesOptions {
  clock: Clock
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  /** 接管提问：`ctx.userQuestions` 只允许一个活跃 provider，接管会取代桌面 UI，故默认关。 */
  takeOverQuestions?: boolean
  /** 标题读取的超时与批量上限（读失败只让列表无标题，不影响列表本身）。 */
  titleTimeoutMs?: number
  titleBatch?: number
  /** 读一次会话历史的超时。读的是整份日志，慢会话可能到几百毫秒，所以比标题宽。 */
  historyTimeoutMs?: number
  /** 新建会话的超时。 */
  createTimeoutMs?: number
}

const MAX_TITLE_BATCH_DEFAULT = 25
const TITLE_TIMEOUT_DEFAULT = 4000
const HISTORY_TIMEOUT_DEFAULT = 15_000
/** 新建会话的超时。创建要分配 id、可能还要挂 workspace，比读标题慢，但也不该让手机干等。 */
const CREATE_TIMEOUT_DEFAULT = 8000
const LIST_LIMIT_DEFAULT = 100

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
  /** 取证用：内核实际发过来的会话事件类型，以及我们**没有映射**的那些（进 status.json）。 */
  const seenEventTypes = new Set<string>()
  const unmappedEventTypes = new Set<string>()
  /** 事件回调里抛过的错（按类型计数）。没有这一条，"回合跑到一半没声音"就只能靠猜。 */
  const listenerErrors = new Map<string, number>()
  /**
   * 人工交互两面的登记结果，进 status.json。
   * 真机上"审批卡为什么没弹"有三种原因（宿主策略根本没问 / 我们没登记上 /
   * 登记了但此刻没有已配对的手机），没有这两个字段就只能猜。
   */
  let approvalFace = 'not-attached'
  let questionsFace = 'pending'

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

  function agentStatus(sessionId: string): string {
    const agent = liveAgent(sessionId)
    const status = agent?.status
    return typeof status === 'string' ? status : 'idle'
  }

  /**
   * 一条会话的工作区目录（会话头里的 `cwd`）。二维码 PNG 按它落 `<workspace>/.dsh/`。
   *
   * **只查活会话**：`services.sessions.get(id)` 拿到的是内核的 `Session` 对象，
   * `header.cwd` 由内核自己校验成绝对路径（dsh-session：`cwd must be an absolute path`）。
   * 不走持久化语料那条路（`sessionQuery.listSessions` 要读整份语料、还顺带拉标题），
   * 因为用到它的两个时机——用户敲 `/drc pair`、右栏轮询——都发生在**用户正在那条会话里**。
   * 查不到就返回 undefined，调用方退回 `~/.dsh/` 并把那个路径如实写进卡片。
   */
  function sessionWorkspace(sessionId: string): string | undefined {
    const get = fn(services.sessions, 'get')
    if (!get || sessionId === '') return undefined
    try {
      const session = get.call(services.sessions, sessionId) as
        { header?: { cwd?: unknown }; cwd?: unknown } | undefined
      // 两个读法都留着：真身是 `session.header.cwd`，而某些代际把会话折叠成扁平记录
      // （`{id, cwd}`，见 listSessions 里 `sessions.list` 那个分支的读法）。
      const cwd = session?.header?.cwd ?? session?.cwd
      return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
    } catch {
      return undefined
    }
  }

  function toSummary(record: ListedSession, archived: Set<string>): SessionSummary {
    const cached = titleCache.get(record.id)
    const running = agentStatus(record.id) === 'running'
    const state: SessionSummary['state'] = archived.has(record.id) ? 'archived' : running ? 'running' : 'idle'
    const updatedAt = cached ? iso(record.headerTime) : undefined
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
  async function newSession(): Promise<{ ok: boolean; sessionId?: string; message?: string }> {
    const controller = services.sessionController
    if (!controller) return { ok: false, message: '主机这一代没有 sessionController 服务' }
    const commands = controller.commands
    const create = fn(commands, 'create')
    if (!create) {
      return { ok: false, message: `sessionController.commands 上没有 create()（成员：${shapeOf(commands)}）` }
    }
    try {
      // 只传空对象：不指定 sessionId（交给内核分配）、不指定 cwd / workspaceId（用默认项目目录）。
      // 两者同时给会被内核当场拒（`gateway/bad-request`），所以这里一个都不给。
      const made = (await withTimeout(
        Promise.resolve(create.call(commands, {})),
        options.createTimeoutMs ?? CREATE_TIMEOUT_DEFAULT,
      )) as LooseObject | undefined
      const id = typeof made?.sessionId === 'string' ? made.sessionId : ''
      if (!id) return { ok: false, message: `新建会话没有返回 sessionId（拿到 ${shapeOf(made)}）` }
      // 先记进 freshSessions：下一条列表推送就能带上它（见 listSessions 里的合并）。
      freshSessions.set(id, { id, createdAt: options.clock.now() })
      return { ok: true, sessionId: id }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  /** 用户消息形状：优先用平台工厂（它会补 id 与规范化），拿不到退回最小可用对象。 */
  async function buildUserMessage(text: string): Promise<LooseObject> {
    try {
      // 用变量而不是字面量：这个包不是本插件的依赖，由宿主在运行时提供，
      // 写死路径会让类型检查去找一个根本不存在的声明（旧实现同样用变量绕开）。
      const llmModule = '@deepseek-ai/dsh-llm'
      const mod = (await import(/* @vite-ignore */ llmModule)) as {
        createUserMessage?: (input: unknown) => LooseObject
      }
      if (typeof mod.createUserMessage === 'function') {
        return mod.createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
      }
    } catch {
      /* 这一代没有该包或名字不同：走兜底形状 */
    }
    return {
      id: `user_${Date.now().toString(36)}`,
      content: [{ type: 'text', text }],
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

  async function sendPrompt(sessionId: string, text: string): Promise<{ ok: boolean; message?: string }> {
    const agent = liveAgent(sessionId)
    if (!agent) return { ok: false, message: `会话没有活的 agent（agents.get(${sessionId}) 为空，请先恢复会话）` }
    if (!currentSelection()) {
      // 没有可用模型时必须主动拒绝，理由见 currentSelection() 的注释。
      return { ok: false, message: '拿不到当前模型选择（agentDefaultModel.currentSelection 缺失）' }
    }
    const message = await buildUserMessage(text)
    const followup = fn(agent, 'followup')
    if (followup) {
      followup.call(agent, message)
      return { ok: true }
    }
    const steer = fn(agent, 'steer')
    if (steer) {
      steer.call(agent, message)
      return { ok: true }
    }
    return { ok: false, message: `agent 既没有 followup 也没有 steer（keys=[${shapeOf(agent)}]）` }
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
    const events = Array.isArray(loaded?.events) ? loaded!.events : []
    return historyPageFromLog({
      sessionId,
      events,
      ...(page.beforeSeq === undefined ? {} : { beforeSeq: page.beforeSeq }),
      limit: page.limit,
    })
  }

  function subscribe(onEvent: (event: KernelEvent) => void): () => void {
    const on = services.on
    if (typeof on !== 'function') {
      log('kernel has no on(); streaming disabled', { keys: shapeOf(services) })
      return () => {}
    }
    const disposers: Array<() => void> = []
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
        guardedSubscribe(on as never, name, guardedHandler as never, (message, fields) => log(message, fields)),
      )
    }
    bind('session/event', (...args) => translateSessionEvent(onEvent, args))
    bind('session/created', () => onEvent({ kind: 'sessions-changed', reason: 'session/created' }))
    bind('agent/status', (...args) => translateAgentStatus(onEvent, args))
    bind('agent/error', (...args) => {
      const sessionId = sessionIdOf(args)
      if (sessionId) onEvent({ kind: 'run-state', sessionId, state: 'idle', detail: 'agent-error' })
    })
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 退订失败无所谓 */
        }
      }
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
    const data = (event?.data ?? {}) as LooseObject
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
    const on = services.on
    if (typeof on === 'function') {
      const name = 'approval/request'
      if (canParticipate(name)) {
        // **参与**这条 waterfall：必须返回 outcome 或调用 next()，返回 undefined 会冲掉整条链。
        const listener = (...args: unknown[]): Promise<string> => participate(args)
        try {
          const disposer = (on as (n: string, fn: unknown) => unknown).call(services, name, listener)
          // 这条登记要进 status.json：真机上审批卡"为什么没弹"分三种原因
          // （策略根本没问 / 没登记上 / 登记了但没配对的手机），没有这个字段就只能猜。
          approvalFace = 'registered'
          disposers.push(() => {
            if (typeof disposer === 'function') (disposer as () => void)()
            else if (typeof services.off === 'function') services.off(name, listener)
          })
        } catch (error) {
          approvalFace = `failed: ${messageOf(error)}`.slice(0, 80)
          log('approval/request participation failed', { message: messageOf(error) })
        }
      } else {
        approvalFace = 'refused by guard'
      }
    } else {
      approvalFace = 'no on()'
    }
    const questions = services.userQuestions as LooseObject | undefined
    if (!options.takeOverQuestions) {
      // 默认关：`ctx.userQuestions` 只允许一个活跃提供者，接管就意味着桌面 UI 不再问。
      questionsFace = 'not-taken-over'
    } else if (!questions || typeof questions.registerProvider !== 'function') {
      // 把服务实际暴露的成员一起报出来：真机上这一代宿主没有 `registerProvider`，
      // 只写"没有提供者"就分不清是"服务不在"还是"这一代的 API 换了名字"。
      questionsFace = `no registerProvider (keys=${questions ? shapeOf(questions) : 'service absent'})`.slice(0, 120)
    }
    if (options.takeOverQuestions && questions && typeof questions.registerProvider === 'function') {
      const provider = {
        ask: async (request: LooseObject) => {
          const agent = request.agent as { session?: { id?: string } } | undefined
          const sessionId = String(agent?.session?.id ?? request.sessionId ?? '')
          const items = Array.isArray(request.questions) ? (request.questions as LooseObject[]) : []
          const mapped: QuestionItem[] = items.map((item, index) => mapQuestion(item, index))
          const answer = await sink?.question({
            sessionId,
            questions: mapped,
            ...(request.signal ? { signal: request.signal as AbortSignal } : {}),
          })
          if (!answer) {
            // 提问服务没有 next() 可交还（单提供者），所以这里必须明确失败，
            // 绝不能静默挂着——那会把整个 agent 卡死。
            throw new Error('手机端未应答这次提问（未配对、不在线或已超时）')
          }
          return { answers: answer.answers }
        },
      }
      try {
        const dispose = (questions.registerProvider as (p: unknown) => unknown).call(questions, provider)
        if (typeof dispose === 'function') disposers.push(dispose as () => void)
        questionsFace = 'registered'
        log('question provider taken over from the desktop UI')
      } catch (error) {
        questionsFace = `failed: ${messageOf(error)}`.slice(0, 80)
        log('question provider registration failed', { message: messageOf(error) })
      }
    }
    return () => {
      sink = undefined
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 尽力退订 */
        }
      }
    }
  }

  /** `approval/request(this, req, next)`：req 是只读审批问题，next 交还给其他应答者。 */
  async function participate(args: unknown[]): Promise<string> {
    const request = args.find(
      (arg) => arg && typeof arg === 'object' && typeof (arg as { toolName?: unknown }).toolName === 'string',
    ) as { agent?: { session?: { id?: string } }; toolName?: string; reason?: string; signal?: AbortSignal } | undefined
    const next = args.find((arg) => typeof arg === 'function') as (() => Promise<unknown>) | undefined
    const sessionId = String(request?.agent?.session?.id ?? '')
    if (!sink || !sessionId || !servicesPeers()) {
      // 没有手机端在线 → 交还桌面 UI。这一步是"插件不抢答"的关键。
      return String((await next?.()) ?? 'unavailable')
    }
    const decision = await sink.approval({
      sessionId,
      action: String(request?.toolName ?? '工具调用'),
      ...(request?.reason ? { reason: String(request.reason) } : {}),
      ...(request?.signal ? { signal: request.signal } : {}),
    })
    if (decision === 'decline') return String((await next?.()) ?? 'unavailable')
    return decision
  }

  /** 有没有能收消息的对端由 runtime 判断；这里只做一个粗筛（有 sink 即可能有对端）。 */
  function servicesPeers(): boolean {
    return sink !== undefined
  }

  function mapQuestion(item: LooseObject, index: number): QuestionItem {
    const options = Array.isArray(item.options) ? (item.options as LooseObject[]) : []
    return {
      id: String(item.id ?? `q${index + 1}`),
      question: String(item.question ?? ''),
      ...(item.multiSelect === true ? { multi: true } : {}),
      ...(options.length > 0
        ? {
            options: options.map((option, optionIndex) => ({
              // 平台选项只有 label（没有 id），所以 id 由这里稳定生成：
              // 手机上回传 id，我们再映射回 label 交给平台（见 core/runtime.ts）。
              id: `o${optionIndex + 1}`,
              label: String((option as LooseObject).label ?? ''),
            })),
          }
        : {}),
    }
  }

  return {
    carrier: 'services',
    listSessions,
    async runState(sessionId: string) {
      const running = agentStatus(sessionId) === 'running'
      const archived = archivedIds().has(sessionId)
      return { running, state: archived ? 'archived' : running ? 'running' : 'idle' }
    },
    sendPrompt,
    interrupt,
    readHistory,
    newSession,
    subscribe,
    attachInteractionSink,
    ensureRunnable,
    sessionWorkspace,
    // 与发指令/续跑走同一条读取路径：这里原来还有一份实现，而且是 `current()` 裸调用
    // （不带 receiver；真要用 this 的服务方法会当场抛），两份迟早分叉。
    modelSelection: currentSelection,
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
        // 二维码落点依赖这一条。它缺席时 PNG 会退回 ~/.dsh/，卡片上的路径会跟着变——
        // 用户看到"图不在工作区"时，第一件事就是看这个字段是不是 absent。
        workspaceFace:
          typeof fn(services.sessions, 'get') === 'function'
            ? 'sessions.get'
            : `absent (keys=${shapeOf(services.sessions)})`.slice(0, 120),
        agents: typeof services.agents === 'object',
        agentDefaultModel: typeof services.agentDefaultModel === 'object',
        workspaceRegistry: typeof services.workspaceRegistry === 'object',
        userQuestions: typeof services.userQuestions === 'object',
        takeOverQuestions: options.takeOverQuestions === true,
        archivedSessions: archivedIds().size,
        hasOn: typeof services.on === 'function',
        // 真机排错的第一现场：内核到底发了哪些事件类型、其中哪些我们没认。
        eventTypes: [...seenEventTypes].slice(-24).join('|'),
        unmappedEventTypes: [...unmappedEventTypes].join('|'),
        approvalFace,
        questionsFace,
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
    case 'assistant/message':
    case 'user/message':
      return [
        {
          kind: 'delta',
          sessionId,
          messageId: messageIdOf(data, input.seq),
          text: textOf(data),
          role: type === 'assistant/message' ? 'assistant' : 'user',
          done: true,
        },
      ]
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
          title: typeof data.title === 'string' ? data.title : previewOf(argsRaw),
          ...(argsRaw === undefined ? {} : { argsPreview: previewOf(argsRaw) }),
        },
      ]
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
 * 回合失败时给手机看的那句话。
 *
 * 中文打底 + 原始原因照抄：只说"失败了"用户无从下手，只贴英文栈又看不懂。
 * 长度夹住（内核的 message 可能带着整段 prompt 或栈），并剥掉可能的路径与凭据形态。
 */
function turnErrorText(reason: { kind?: string; error?: { message?: string; code?: string } } | undefined): string {
  const raw = String(reason?.error?.message ?? reason?.kind ?? '未知错误')
    .replace(/\s+/g, ' ')
    .trim()
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

/** 一页历史默认给多少条线格式条目（够看几轮，又不会顶满中继的帧预算）。 */
export const HISTORY_LIMIT_DEFAULT = 40
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
}): KernelHistoryPage {
  const { sessionId } = input
  const groups: Array<{ seq: number; events: KernelEvent[] }> = []

  for (const raw of input.events ?? []) {
    const type = typeof raw?.type === 'string' ? raw.type : ''
    if (!type) continue
    const seq = typeof raw?.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : 0
    const data = (raw?.data ?? {}) as LooseObject
    const mapped = sessionEventKernelEvents({ sessionId, type, seq, data })
    const kept = mapped.filter(isHistoryWorthy)
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

  const ranged = input.beforeSeq === undefined ? groups : groups.filter((group) => group.seq < input.beforeSeq!)
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

  // 游标只在**确实还有更早、且还有内容**的时候给：给出一个翻不出东西的游标，
  // 手机上会长出一个点了没反应的「加载更早」。
  const earliest = page.length > 0 ? page[0]!.seq : undefined
  const hasEarlier = earliest !== undefined && ranged.some((group) => group.seq < earliest)

  return {
    events: flat,
    ...(hasEarlier ? { nextBeforeSeq: earliest } : {}),
  }
}

/** 历史只留"有内容"的两种：有正文的 delta、有 callId 的工具事件。 */
function isHistoryWorthy(event: KernelEvent): boolean {
  if (event.kind === 'delta') return event.text.length > 0
  if (event.kind === 'tool') return event.callId.length > 0
  return false
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

function previewOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = typeof value === 'string' ? value : safeJson(value)
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
