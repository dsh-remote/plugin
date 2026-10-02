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
import type { QuestionItem, SessionSummary } from '@dsh-rc/protocol'
import { canParticipate, canSubscribe, guardedSubscribe } from './guard.js'
import type {
  ApprovalDecision,
  AskUserQuestionAnswerValue,
  Clock,
  InteractionSink,
  KernelEvent,
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
}

const MAX_TITLE_BATCH_DEFAULT = 25
const TITLE_TIMEOUT_DEFAULT = 4000
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

  /** 软探测一个成员是不是函数。返回类型用 unknown 参数表，调用点各自窄化。 */
  const fn = (owner: unknown, name: string): ((...args: any[]) => unknown) | undefined => {
    if (!owner) return undefined
    const value = (owner as LooseObject)[name]
    return typeof value === 'function' ? (value as (...args: any[]) => unknown) : undefined
  }

  /** 把"缺哪个成员 + 该对象实际有什么"说清楚：静默降级是排查的最大敌人。 */
  const shapeOf = (owner: unknown): string => {
    if (!owner || typeof owner !== 'object') return String(owner)
    return Object.keys(owner as LooseObject).slice(0, 24).join(',')
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
        log('no session listing face', { sessionQuery: shapeOf(services.sessionQuery), sessions: shapeOf(services.sessions) })
        return []
      }
      source = 'sessions'
      const live = (listLive.call(services.sessions) ?? []) as Array<{ id?: string; cwd?: string; createdAt?: number | string; origin?: string; headerTime?: number | string }>
      records = (live ?? [])
        .filter((row) => typeof row?.id === 'string')
        .map((row) => ({ id: String(row.id), cwd: row.cwd, createdAt: row.createdAt, origin: row.origin, headerTime: row.createdAt }))
    }
    // 委派子会话整行过滤：手机上点进一条无法回答审批的子会话，比看不见更容易误导。
    records = records.filter((row) => row.origin !== 'subagent')
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

  /** 用户消息形状：优先用平台工厂（它会补 id 与规范化），拿不到退回最小可用对象。 */
  async function buildUserMessage(text: string): Promise<LooseObject> {
    try {
      // 用变量而不是字面量：这个包不是本插件的依赖，由宿主在运行时提供，
      // 写死路径会让类型检查去找一个根本不存在的声明（旧实现同样用变量绕开）。
      const llmModule = '@deepseek-ai/dsh-llm'
      const mod = (await import(/* @vite-ignore */ llmModule)) as { createUserMessage?: (input: unknown) => LooseObject }
      if (typeof mod.createUserMessage === 'function') {
        return mod.createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
      }
    } catch {
      /* 这一代没有该包或名字不同：走兜底形状 */
    }
    return { id: `user_${Date.now().toString(36)}`, content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' }
  }

  async function sendPrompt(sessionId: string, text: string): Promise<{ ok: boolean; message?: string }> {
    const agent = liveAgent(sessionId)
    if (!agent) return { ok: false, message: `会话没有活的 agent（agents.get(${sessionId}) 为空，请先恢复会话）` }
    const selection = fn(services.agentDefaultModel, 'currentSelection')
    if (!selection) {
      // 没有可用模型时必须**主动拒绝**：宿主 loop 缺 model 会在 prepareRequest 里抛
      // `reading 'provider'`，那是一条跟远程控制毫无关系的崩溃。
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
    try {
      await resume.call(services.agents, { resumeSessionId: sessionId })
      return { ok: true }
    } catch (error) {
      return { ok: false, message: `续跑会话失败：${messageOf(error)}` }
    }
  }

  function subscribe(onEvent: (event: KernelEvent) => void): () => void {
    const on = services.on
    if (typeof on !== 'function') {
      log('kernel has no on(); streaming disabled', { keys: shapeOf(services) })
      return () => {}
    }
    const disposers: Array<() => void> = []
    const bind = (name: string, handler: (...args: unknown[]) => void): void => {
      if (!canSubscribe(name)) {
        log('refusing to subscribe', { name, waterfall: false })
        return
      }
      disposers.push(guardedSubscribe(on as never, name, handler as never, (message, fields) => log(message, fields)))
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

  /** 平台日志里的一条会话事件 → 插件词汇表。未识别的类型直接忽略（没有 else 分支）。 */
  function translateSessionEvent(onEvent: (event: KernelEvent) => void, args: unknown[]): void {
    const session = args.find((arg) => arg && typeof arg === 'object' && typeof (arg as { id?: unknown }).id === 'string') as
      | { id?: string }
      | undefined
    const event = args.find((arg) => arg && typeof arg === 'object' && typeof (arg as { type?: unknown }).type === 'string') as
      | { type?: string; data?: LooseObject; seq?: number }
      | undefined
    const sessionId = String(session?.id ?? '')
    const type = event?.type
    if (!sessionId || !type) return
    const data = (event?.data ?? {}) as LooseObject
    switch (type) {
      case 'turn/start':
        onEvent({ kind: 'run-state', sessionId, state: 'running' })
        return
      case 'assistant/message':
      case 'user/message': {
        const text = textOf(data)
        const messageId = messageIdOf(data, event?.seq)
        if (type === 'assistant/message') {
          onEvent({ kind: 'delta', sessionId, messageId, text, role: 'assistant', done: true })
        } else {
          onEvent({ kind: 'delta', sessionId, messageId, text, role: 'user', done: true })
        }
        return
      }
      case 'tool/call':
        onEvent({
          kind: 'tool',
          sessionId,
          callId: String(data.callId ?? data.id ?? `tool_${event?.seq ?? 0}`),
          phase: data.args === undefined || data.args === null ? 'started' : 'args',
          tool: typeof data.name === 'string' ? data.name : undefined,
          title: typeof data.title === 'string' ? data.title : previewOf(data.args),
        })
        return
      case 'tool/result':
        onEvent({
          kind: 'tool',
          sessionId,
          callId: String(data.callId ?? data.id ?? ''),
          phase: data.error ? 'failed' : 'completed',
          resultPreview: previewOf(data.result ?? data.error),
        })
        return
      case 'turn/end':
        // 顺序对手机有意义：先补一条 done，再报 idle，否则转圈会一直停在那里。
        onEvent({ kind: 'delta', sessionId, messageId: `turn_${event?.seq ?? 0}`, text: '', done: true })
        onEvent({ kind: 'run-state', sessionId, state: 'idle' })
        return
      case 'session/title':
        if (typeof data.title === 'string') {
          titleCache.set(sessionId, { title: data.title, at: options.clock.now() })
          onEvent({ kind: 'title', sessionId, title: data.title })
        }
        return
      case 'approval/asked':
      case 'approval/decided':
        // 审批审计事件（emit-mode，经 session/event 到达）。审批卡片本身由
        // `approval/request` 的参与者路径产生，见 attachInteractionSink。
        onEvent({ kind: 'sessions-changed', reason: type })
        return
      default:
        return
    }
  }

  function translateAgentStatus(onEvent: (event: KernelEvent) => void, args: unknown[]): void {
    const payload = args.find((arg) => arg && typeof arg === 'object') as { agent?: LooseObject; status?: string; sessionId?: string } | undefined
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
          disposers.push(() => {
            if (typeof disposer === 'function') (disposer as () => void)()
            else if (typeof services.off === 'function') services.off(name, listener)
          })
        } catch (error) {
          log('approval/request participation failed', { message: messageOf(error) })
        }
      }
    }
    const questions = services.userQuestions as LooseObject | undefined
    if (options.takeOverQuestions && questions && typeof questions.registerProvider === 'function') {
      const provider = {
        ask: async (request: LooseObject) => {
          const agent = request.agent as { session?: { id?: string } } | undefined
          const sessionId = String(agent?.session?.id ?? request.sessionId ?? '')
          const items = Array.isArray(request.questions) ? (request.questions as LooseObject[]) : []
          const mapped: QuestionItem[] = items.map((item, index) => mapQuestion(item, index))
          const answer = await sink?.question({ sessionId, questions: mapped, ...(request.signal ? { signal: request.signal as AbortSignal } : {}) })
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
        log('question provider taken over from the desktop UI')
      } catch (error) {
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
    const request = args.find((arg) => arg && typeof arg === 'object' && typeof (arg as { toolName?: unknown }).toolName === 'string') as
      | { agent?: { session?: { id?: string } }; toolName?: string; reason?: string; signal?: AbortSignal }
      | undefined
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
    subscribe,
    attachInteractionSink,
    ensureRunnable,
    modelSelection() {
      const current = fn(services.agentDefaultModel, 'currentSelection')
      if (!current) return undefined
      try {
        const selection = current() as LooseObject | undefined
        if (!selection || typeof selection !== 'object') return undefined
        const provider = typeof selection.provider === 'string' ? selection.provider : undefined
        const model = typeof selection.model === 'string' ? selection.model : undefined
        return provider && model ? { provider, model } : undefined
      } catch {
        return undefined
      }
    },
    describe() {
      return {
        carrier: 'services',
        sessions: typeof services.sessions === 'object',
        sessionQuery: typeof services.sessionQuery === 'object',
        agents: typeof services.agents === 'object',
        agentDefaultModel: typeof services.agentDefaultModel === 'object',
        workspaceRegistry: typeof services.workspaceRegistry === 'object',
        userQuestions: typeof services.userQuestions === 'object',
        takeOverQuestions: options.takeOverQuestions === true,
        archivedSessions: archivedIds().size,
        hasOn: typeof services.on === 'function',
      }
    },
  }
}

function textOf(data: LooseObject): string {
  const content = data?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && (part as LooseObject).type === 'text' ? String((part as LooseObject).text ?? '') : '',
      )
      .join('')
  }
  return ''
}

function messageIdOf(data: LooseObject, seq: unknown): string {
  const id = data?.id ?? data?.messageId
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
