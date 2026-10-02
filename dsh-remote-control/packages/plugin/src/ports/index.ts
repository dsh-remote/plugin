/**
 * ports — 插件的端口定义（内核/传输/防休眠/时钟/存储）。
 *
 * 这一层是整个插件的"可测性契约"：**只有 `platform/` 与 `shell/` 允许 import cordis
 * 与 `@deepseek-ai/*`**，`core/` 只认这里的形状。旧实现做不到这一点——它的
 * 36 项测试全靠手写 cordis 替身，因为内核调用与业务逻辑写在同一个对象里。
 *
 * 三条设计约束：
 *
 * 1. **内核面必须能被"部分实现"**。真实宿主在不同代际暴露的能力不一样
 *    （列会话有两条路、审批有 waterfall、提问是单提供者服务），所以可选方法
 *    用 `?:` 表达，调用方负责探测与降级——不是用一个 `capabilities` 位图，
 *    那会退化成"猜平台有什么"。
 * 2. **审批与提问走"参与者"语义，不是观测**。`respondApproval` / `ask` 返回 Promise
 *    并由调用方（`core/runtime`）挂到手机上；平台侧的 `approval/request` 是 waterfall，
 *    返回 outcome 即声明"这个决定我认领了"，不调 `next()` 就不会轮到桌面 UI。
 * 3. **所有返回给 core 的形状都是插件自己的类型**（`KernelSession`、`PendingApproval`…），
 *    平台对象一律在适配器里折叠完再出来。这样协议层的 `SessionSummary` 与内核
 *    代际变化之间有一层可测的翻译，而不是满屏 `as any`。
 */
import type { AnswerItem, QuestionItem, SessionSummary } from 'dsh-remote-wire'

/** 插件端口只需要四个方法形状的 socket，方便用内存替身测试。 */
export interface PeerSink {
  /** 向某个会话的所有在线客户端发一条已加密载荷；返回是否有活客户端。 */
  broadcast(payload: unknown): boolean
  /** 单播到某个客户端（用于只回给发起者）。 */
  toClient(clientId: string, payload: unknown): boolean
}

/** 内核报告的一条会话在插件内部的形状（还没变成线格式）。 */
export interface KernelSession {
  summary: SessionSummary
  /** 该会话此刻是否有活的 agent 在跑（决定要不要持锁）。 */
  live: boolean
  /** 列表来自哪条路（持久化语料 / 仅本进程活会话）；"只报一个会话"是不是故障，看这个字段。 */
  listingSource?: 'sessionQuery' | 'sessions'
}

/** 会话的一次事件，已经翻译成插件词汇。 */
export type KernelEvent =
  | {
      kind: 'delta'
      sessionId: string
      messageId: string
      text: string
      done: boolean
      role?: 'assistant' | 'user' | 'system'
    }
  | {
      kind: 'tool'
      sessionId: string
      callId: string
      phase: 'started' | 'args' | 'completed' | 'failed'
      tool?: string
      title?: string
      argsPreview?: string
      resultPreview?: string
    }
  | { kind: 'run-state'; sessionId: string; state: 'running' | 'idle'; detail?: string }
  | { kind: 'title'; sessionId: string; title: string }
  | { kind: 'sessions-changed'; reason?: string }

/**
 * 一页历史。
 *
 * `events` 用的是**与实时流同一套 KernelEvent 词汇**，而不是另立一套"历史消息"形状：
 * 内核日志里的事件和实时 `session/event` 本来就是同一种东西（都是
 * `{type, seq, data}`），所以翻译函数可以原样复用，出站构造器也可以原样复用。
 * 另立一套的话，同一段翻译逻辑要写两遍，而两份实现分叉的表现是
 * "实时看着对、历史看着怪"——靠肉眼很难发现。
 *
 * `nextBeforeSeq` 省略 = 这是最初的一页（没有更早的内容了）。
 */
export interface KernelHistoryPage {
  events: KernelEvent[]
  nextBeforeSeq?: number
}

/** 一次待决审批。`id` 是插件自己生成的关联键（手机回传时逐字带回）。 */
export interface PendingApproval {
  id: string
  sessionId: string
  /** 平台侧的审计 id（`approval/asked` 里那个），有就带着，便于取证。 */
  platformId?: string
  action: string
  reason?: string
  /** 挂起的 abort 信号：手机一直不回答案时由平台侧撤销。 */
  signal?: AbortSignal
  /** 认领这次决定：返回平台词汇的 outcome。 */
  settle(outcome: ApprovalOutcomeValue): void
}

/** 平台词汇（`@deepseek-ai/dsh-user-approval` 的 `ApprovalOutcome`）。 */
export type ApprovalOutcomeValue = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 一次待答提问。选项用 label 与平台交换，`id` 只在插件与手机之间使用。 */
export interface PendingQuestion {
  id: string
  sessionId: string
  questions: QuestionItem[]
  settle(answer: AskUserQuestionAnswerValue): void
  cancel(): void
}

/** 平台侧的答案形状（`selected` 装的是**选项 label**，不是我们的 id）。 */
export interface AskUserQuestionAnswerValue {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

/**
 * 内核端口。`listSessions` / `sendPrompt` / `interrupt` 是手机三大动作的落点，
 * 其余是可选能力面：宿主代际不同就有不同，缺失时调用方必须能报出"缺哪个成员 +
 * 该服务对象实际有哪些 key"，而不是静默换一个载体。
 */
/** core 提供给内核适配器的人工交互入口。 */
export interface InteractionSink {
  /** 一次审批请求。返回 `'decline'` 让适配器去调平台的 `next()`。 */
  approval(info: {
    sessionId: string
    action: string
    reason?: string
    signal?: AbortSignal
  }): Promise<ApprovalDecision>
  /** 一次提问请求。返回 null 表示无人应答（适配器须转成明确失败，不许静默挂住 agent）。 */
  question(info: {
    sessionId: string
    questions: QuestionItem[]
    signal?: AbortSignal
  }): Promise<AskUserQuestionAnswerValue | null>
}

/** 审批结论，外加一个"我不认领"。 */
export type ApprovalDecision = ApprovalOutcomeValue | 'decline'

export interface KernelPort {
  /** 这条载体的名字，会进 status.json（`services` / `apiproxy` / `mock`）。 */
  readonly carrier: string

  listSessions(limit: number): Promise<KernelSession[]>
  runState(sessionId: string): Promise<{ running: boolean; state: SessionSummary['state'] }>
  sendPrompt(sessionId: string, text: string): Promise<{ ok: boolean; message?: string }>
  interrupt(sessionId: string): Promise<{ ok: boolean; message?: string }>

  /**
   * 读一条会话已有的历史（手机打开会话时用）。
   *
   * **可选**：读历史依赖宿主暴露 `sessionQuery`（`listSessions` / `readTitleSnapshots`
   * 那条路线的同一个服务），而不同代际的能力面不一样。缺失时调用方必须能明确报出
   * "这一代没有这个能力"，而不是回一个空列表——空列表在手机上就是"这个会话没内容"，
   * 那是一个会让人查错方向的假事实。
   *
   * `options.beforeSeq` 是上一页给的游标（取 `seq < beforeSeq`）；省略表示要最新一页。
   */
  readHistory?(sessionId: string, options: { beforeSeq?: number; limit: number }): Promise<KernelHistoryPage>

  /**
   * 新建一条会话（手机上那个「新建会话」）。
   *
   * **可选**：它依赖宿主暴露 `sessionController`，而不同代际暴露的服务面不一样。
   * 缺失时调用方必须明确拒绝并说出缺哪一层，**不许**回一条"已创建"——
   * 手机拿着一个假的 sessionId 一路走下去，失败点会离病根很远。
   *
   * 成功时返回**主机分配**的 id。刻意不接受标题：命名是主机那一侧的事
   * （创建时不传 sessionId 由内核分配，不传 cwd 就用默认项目目录）。
   */
  newSession?(): Promise<{ ok: boolean; sessionId?: string; message?: string }>

  /** 订阅会话事件；返回退订函数。实现必须拒绝订阅 waterfall（见 guard.ts）。 */
  subscribe(onEvent: (event: KernelEvent) => void): () => void

  /**
   * 登记"谁来处理一次人工交互"。
   *
   * 方向很重要：**交互由平台发起**（审批是 `approval/request` waterfall 的参与者、
   * 提问是 `ctx.userQuestions` 的提供者），适配器只负责把它转交给 core，
   * 并在 core 给出结论后把结论送回平台。所以这里是 sink 注册，不是 `ask()` 调用。
   *
   * core 返回 `'decline'` 表示"这局我不认领"（例如此刻没有已配对的手机在线），
   * 审批适配器此时**必须**调用平台的 `next()` 把决定权交还桌面 UI；
   * 提问服务是单提供者、没有 next 可交还，因此 decline 一律转成明确失败，
   * 绝不静默挂住 agent（取证：dsh-user-questions 只允许一个活跃 provider）。
   */
  attachInteractionSink?(sink: InteractionSink): () => void

  /** 冷会话续跑（归档/未加载的会话发指令前需要）。 */
  ensureRunnable?(sessionId: string): Promise<{ ok: boolean; message?: string }>
  /**
   * 一条会话的工作区目录（会话头里的 `cwd`）。
   *
   * **可选**：宿主代际不同，能拿到 `cwd` 的面也不同。只查**活会话**（`sessions.get(id)`，
   * 同步、零成本）——用到它的两个调用点（`/drc pair` 与右栏那条路由）都发生在用户正在
   * 那条会话里操作的时刻，活会话这条足以覆盖；查不到就返回 undefined，调用方退回
   * `~/.dsh/` 并在卡片上如实显示那个路径。
   *
   * 返回值必须是绝对路径（会话头里的 `cwd` 被内核校验为绝对路径），调用方直接当目录用。
   */
  sessionWorkspace?(sessionId: string): string | undefined
  /** 当前模型选择，仅用于展示与"没模型就拒绝"的前置判断。 */
  modelSelection?(): { provider: string; model: string } | undefined
  /** 诊断：内核服务实际暴露了哪些成员，出错时打出来。 */
  describe(): Record<string, string | number | boolean>
}

/** 传输端口：core 通过它发消息，不关心 socket。 */
export interface TransportPort {
  /** 有没有能收这条会话消息的对端（决定审批要不要自己认领）。 */
  hasPeer(sessionId: string): boolean
  broadcast(payload: unknown, sessionId?: string): void
}

/** 防休眠后端端口。 */
export interface SleepPort {
  backend(): string
  platform(): string
  start(ownerPid: number, keepDisplay: boolean): { ok: boolean; message?: string }
  stop(): void
  isActive(): boolean
}

/** 时间与随机性注入点：窗口化与退避策略因此可以确定性测试。 */
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** 状态快照落盘（GUI 宿主没人看 stdout，这个文件是排错第一入口）。 */
export interface StatusSink {
  write(snapshot: Record<string, unknown>): void
}
