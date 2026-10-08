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
import type { ModelOption, QuestionItem, SessionSummary } from 'dsh-remote-wire'

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
  | {
      /**
       * agent inbox 被拼接了一条消息（内核 agent/inbox/spliced）。
       *
       * **这是「用户在 DSH 里发的消息」唯一可靠的信号**（2026-10-05 用户实测
       * 排队四连问题后取证得来）。真实负载：
       *   {type:'agent/inbox/spliced', data:{
       *     target: 'next-turn' | 'next-step',   // 排下一轮 vs 插当前轮的下一步
       *     start: number,
       *     inserted: [{content:[{type:'text',text}], source:{kind}, role, id}]}}
       *
       * 三个必须过滤的点（真机 session log 取证，各 100+ 条）：
       *   1. target 只认 'next-turn'。'next-step' 是插话，当前轮里就消化了，
       *      不是排队——混进来会让手机凭空多出一条排队。
       *   2. inserted 有 158/338 条是**空数组**（纯 start 调整），空的不算消息。
       *   3. source.kind 只有 'user' 是人写的。实测另有 user-approval（策略变更
       *      提示）、ptc-mode（图片/文件回传）、tool-jobs（后台任务回执）、
       *      repeat-tool-reminder（内核重复调用提醒）——这些都不是用户排的消息，
       *      全部不显示。
       *
       * 为什么以前只能靠猜：宿主**确实**把这条事件转给了插件
       * （status.json 的 kernel.eventTypes 里列着它），但 sessionEventKernelEvents
       * 的 switch 没有对应 case，落到 default: return [] 被静默丢掉，
       * 于是它同时出现在 kernel.unmappedEventTypes 里。
       * 之前用「run-state=running 且本会话无可提升项 → 造 host 占位项、
       * 再等 delta role=user 回填文字」来猜，既漏又对不齐（占位项和真实消息
       * 可能对不上号）。现在直接用这条事件，正文/来源/消息 id 全都自带。
       *
       * text 是**空串**表示这次 splice 里没有可显示的文字（原文只剩图片，
       * 或内容类型不是 text）。
       */
      kind: 'inbox'
      sessionId: string
      target: 'next-turn' | 'next-step'
      messageId: string
      text: string
    }
  | {
      /**
       * **这条会话这一轮真正在用的模型**（内核 request/header，每轮一条）。
       *
       * 为什么不能用 agentDefaultModel.currentSelection()（2026-10-05 用户实测：
       * 当前会话是 space-bunny-free，mp 端却显示 muse-spark）：
       * 那个接口读的是**宿主全局默认模型**，即「新建会话时用哪个」，与
       *「这条会话这一轮跑的是哪个」**不是一回事**。用户在别的会话切了模型，
       * 全局默认就变了，于是本会话的 mp 端显示跟着变——而本会话根本没换。
       * 取证：真机 session log 里 request/header 30 条，每轮一条，
       * 最后一轮 config = {provider:'space-bunny', model:'space-bunny-free'}，
       * 与用户报的当前模型一致。
       *
       * 只在真的读到 config.model 时才出站（读不到就不发，见 broadcastModel）。
       */
      kind: 'model'
      sessionId: string
      model: string
      provider?: string
    }
  | { kind: 'run-state'; sessionId: string; state: 'running' | 'idle'; detail?: string }
  | {
      /** 待办清单全量快照（内核 `todo/write`）。
       * 单条上限由 carrier-services 的映射函数夹：content ≤ 200 字、整份 ≤ 50 条。 */
      kind: 'todo'
      sessionId: string
      todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[]
    }
  | {
      /**
       * 模型正在重试（内核 `llm/retry` / `llm/retry-started`）。
       *
       * 2026-10-06 取证（真机 session log，18 次）：这两个事件一直在发，
       * 但插件没映射，手机上模型卡住时**一片空白** —— 用户以为死了，
       * 而宿主其实正在重试。`llm/retry` 的 data 带 retry / maxRetries /
       * failure.{code,message}，够拼出一句人话。
       */
      kind: 'retry'
      sessionId: string
      attempt: number
      max: number
      reason?: string
    }
  | {
      /**
       * 上下文压缩的起止（内核 `compaction/start` / `compaction/end`）。
       *
       * 取证：start 带 {compactionId, turn}，end 带同样两个 **外加可选 error**
       * （真机见过 `summarization produced no text summary content`）。
       * 这一段手机上是完全静默的，没有事件也没有运行态变化。
       *
       * end 带 error 要单独表达：那不是"压缩完了"，是**压缩失败了**，
       * 两者对用户的含义完全不同。
       */
      kind: 'compaction'
      sessionId: string
      state: 'started' | 'ended' | 'failed'
      error?: string
    }
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

/** 平台词汇（`@deepseek-ai/dsh-user-approval` 的 `ApprovalOutcome`）。 */
export type ApprovalOutcomeValue = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

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
  /**
   * 发一条用户消息。
   *
   * `attachments` 是**可选**的图片附件（2026-10-05 用户：正文里不要再出现路径）。
   *
   * 以前图片的通路是「主机落盘 + 把绝对路径写进 prompt 正文」——那是当时唯一
   * 能想到的办法，但代价太大：路径会出现在对话正文里（用户与模型都看得见），
   * 而且把本机目录结构泄露给模型。现在图片走宿主原生的图片内容块，正文一个字节都不用改。
   *
   * ## 这里传的是**手机侧形状**，不是内核形状（2026-10-06 真机事故订正）
   *
   * `data` + `mimeType` 是**我们自己**的入参口径；载体负责整成内核入口形状
   * `{type:'image', mediaType, data}`（字段名是 `mediaType`），**再交内核自己的
   * admission**（`sessionController.commands.prompt` 或 `attachments.admitPromptContent`）。
   *
   * 为什么不许把 `{type:'image', data, mimeType}` 直接塞进 `followup`：内核里有两种
   * 图片块，入口那块（base64 原文）必须经 admission 变成 `{type:'image', attachment}`
   * 才是内部能用的形状。跳过这一步，内核序列化时会读 `block.attachment.attachmentId`
   * 而 `attachment` 是 undefined —— 整个回合以
   * `Cannot read properties of undefined (reading 'attachmentId')` 收场，
   * 用户侧就是"这一轮没有产出回复，内核报错（UNKNOWN）"。取证见 carrier-services 的
   * `submitWithImages`。
   *
   * 可选是为了**不打破既有实现**：签名更少的载具（mock、e2e 夹具）照样满足这个接口，
   * 运行时据此判断能不能带图——带不了就明确拒绝，而不是悄悄把图丢掉。
   */
  sendPrompt(
    sessionId: string,
    text: string,
    attachments?: ReadonlyArray<{ data: string; mimeType: string }>,
  ): Promise<{ ok: boolean; message?: string }>
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
   *
   * `args.workspace` 是手机指明的工作区目录（**目录绝对路径**，与
   * `SessionSummary.workspace` 同一个字符串、逐字透传）。缺省 = 由实现自己推断
   * （配置 → 最近活动的会话 → 宿主默认）。它来自手机，是**不可信输入**，
   * 所以形状校验（绝对路径 / 长度 / 非 Windows 形状）属于实现，端口不收未校验的值。
   */
  newSession?(args?: { workspace?: string }): Promise<{ ok: boolean; sessionId?: string; message?: string }>

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
   * 归档 / 取消归档一条会话（`cmd.archive_session` 的落点，2026-10-07 加）。
   *
   * ## 为什么是可选方法
   *
   * 这一代宿主**有**这个能力（`workspaceRegistry.archiveSession` /
   * `unarchiveSession`，真机上 55 条已归档会话就是它做的），但**下一代有没有**
   * 不由我们决定。缺这个方法时 `core` 回一条明说原因的 `ev.result{ok:false}`，
   * 而不是静默成功——静默成功会让用户以为归档了，而列表里那条还在。
   *
   * ## ⚠️ 实现方 MUST NOT 传 `stopActivity`
   *
   * 内核的 `archiveSession(sessionId, options)` 在会话还在跑时**抛**
   * `WorkspaceActiveSessionError`，除非传 `stopActivity: true`——而那会**停掉主机上
   * 正在跑的工作**。插件的纪律是"不改变宿主自己的行为"（用户在手机上误点一下，
   * 主机上正在跑的任务就断了，那是不可逆的损失）。
   *
   * 所以正确行为是**明确报错**："会话正在运行，不能归档"。让用户回工作台停。
   */
  archiveSession?(sessionId: string, archived: boolean): Promise<{ ok: boolean; message?: string }>
  /** 当前模型选择，仅用于展示与"没模型就拒绝"的前置判断。 */
  modelSelection?(): { provider: string; model: string } | undefined
  /**
   * 可切换的模型清单与**能不能切**这件事的答案。
   *
   * 为什么单独一个端口而不是让 `modelSelection` 一起返回：读当前值几乎每个代际都有，
   * 而「能不能列候选、能不能写」是代际差异最大的部分（实测 `agentDefaultModel`
   * 上只有 `currentSelection`）。合成一个返回值会让调用方分不清
   * 「拿不到清单」与「主机根本不能切」——手机上这两种必须表现不同。
   *
   * 缺这个方法 = 只读（core 会下发 `canSwitch: false` 并给出理由）。
   */
  modelOptions?(): { canSwitch: boolean; options?: ModelOption[]; reason?: string }
  /** 诊断：内核服务实际暴露了哪些成员，出错时打出来。 */
  describe(): Record<string, string | number | boolean>
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
