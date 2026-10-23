/**
 * guard — 事件订阅的唯一入口。
 *
 * cordis 的事件有两种派发模式：`emit`（观测者只是被告知）与 `waterfall`
 * （**注册即参与**，监听函数的返回值就是"这一棒往下传的值"）。
 * 观测者若订阅了 waterfall 并返回 `undefined`，就把整条链的结果冲掉了。
 *
 * 事故（不是理论风险）：旧插件为了可观测性订阅了 `agent/request`，
 * 宿主在构造 LLM 请求那一步拿到的是插件监听器返回的 undefined，于是
 * **内核进程里每一个 turn 都崩**，报 `Cannot read properties of undefined (reading 'provider')`，
 * 连桌面 UI 里人工发消息也一起崩（取证 HANDOFF.md §4.4 与
 * docs/legacy-spec/host-plugin-cordis.md §2.1，崩溃点在
 * `@deepseek-ai/dsh-agent-loop/lib/index.js:685-691`）。
 *
 * 为什么这次是**白名单**而不是旧实现的 13 项黑名单：宿主自己有一份权威的
 * 「事件名 + 派发模式」表（`@deepseek-ai/dsh-api-remotes/lib/types/remote-events.js:12-40`），
 * 按它 `approval/request`、`user-questions/request`、`llm/stream`、
 * `system-prompt/assemble`、`tools/pre-execute|execute|post-execute|code-dispatch-log`、
 * `internal/config`、`internal/update` 都是 waterfall，而旧黑名单里一个都没有——
 * **旧插件没出事只是因为它恰好没订阅这些名字**。黑名单在任何一次宿主代际升级后都会静默失效，
 * 所以本文件的原则是：名单外的名字一律拒订，而不是名单外的名字一律放行。
 */

/** 允许订阅的 emit-mode 事件（逐个附取证位置，缺一个就少一类能力）。 */
export const SUBSCRIBABLE_EVENTS = [
  // 会话内的结构化事件（含 approval/asked|decided 这类审计事件）。
  // 取证：@deepseek-ai/dsh-session/lib/types/index.d.ts:44（`session/event` 声明为 emit）
  'session/event',
  // 新会话建立。取证：同上 :66
  'session/created',
  // agent 运行状态（running/idle）。取证：@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:169,316
  'agent/status',
  // agent 出错。取证：同上
  'agent/error',
  // fiber 生命周期（index.ts 用它抓"是谁把我们拆了"的那条栈）。取证：@deepseek-ai/cordis
  // lib/types/events.d.ts:219（`internal/status` 声明为 emit）。
  // **它必须在白名单里**：这条例外是在**订阅口**上开放的，不是在调用点上——
  // index.ts 原来直接 `ctx.on('internal/status', …)` 绕过了这份名单，
  // 等于"唯一入口"这句话在代码里不成立（guard 头注与实现分叉）。
  'internal/status',
] as const

/**
 * docs/legacy-spec/host-plugin-cordis.md §2.1 记录的**旧实现 13 项黑名单**
 * （"来自代码常量，非推测"，且 13/13 都在宿主产物里被复核过是 waterfall 家族）。
 *
 * 它必须原样留着：这是纵深防御的第二层，也是"那次每个 turn 都崩"的直接证据。
 */
export const LEGACY_WATERFALL_EVENTS: readonly string[] = [
  'agent/pre-step',
  'agent/request',
  'agent/request-error',
  'compaction/summary-error',
  'connection/request',
  'fs/edit-intent',
  'fs/write-intent',
  'internal/get',
  'internal/set',
  'loader/patch-context',
  'session-telemetry/record',
  'user-questions/request',
  'workspace/session-activity',
]

/**
 * 由宿主权威表 `remote-events.js`（`API_REMOTE_FORWARDED_EVENTS`，显式 mode 字段）
 * 与 `@mode waterfall` 声明**补出来**的 9 项。旧黑名单里一项都没有它们——
 * 旧插件没出事只是因为它恰好没订阅这些名字。
 */
export const EXTRA_WATERFALL_EVENTS: readonly string[] = [
  'internal/config',
  'internal/update',
  'approval/request',
  'llm/stream',
  'system-prompt/assemble',
  'tools/pre-execute',
  'tools/execute',
  'tools/post-execute',
  'tools/code-dispatch-log',
]

/**
 * 已知为 waterfall 的事件名。
 *
 * 这份清单**不参与放行判断**（放行只看白名单），它存在的意义只有一条：
 * 让测试能自校验"白名单里绝不出现这里任何一个名字"。
 * 取证位置见 docs/legacy-spec/host-plugin-cordis.md §2.1 的 13 项 + 由宿主
 * `remote-events.js` 与 `@mode waterfall` 声明补出来的 9 项（13+9=22，
 * 由两条常量组合而成，注释里的数与数组本体不会再分叉）。
 */
export const WATERFALL_EVENTS: readonly string[] = [...LEGACY_WATERFALL_EVENTS, ...EXTRA_WATERFALL_EVENTS]

/**
 * 允许**参与**的 waterfall（与"观测"是两件事）。
 *
 * `approval/request` 的官方契约就是"参与者返回 outcome 即认领这次决定，
 * 或调用 `next()` 交还"（取证 @deepseek-ai/dsh-user-approval/lib/types/index.d.ts:16-24）。
 * 也就是说：审批要想到达手机，只能参与这条 waterfall，没有 emit-mode 的替代通道
 * （`approval/asked` / `approval/decided` 只是审计事件，不能应答）。
 *
 * `user-questions/request` 是**同一条形状**，取证在宿主自己的服务实现里：
 * `@deepseek-ai/dsh-user-questions/lib/index.js` 的 `ask()` 末端就是
 * `ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', {...request, agent}, noAnswerer)`，
 * 而桌面那一位是通过网关转发的 `$on("user-questions/request", function(request, next) …)` 参与的
 * （`@deepseek-ai/dsh-client-ui-user-questions/lib/client.js`）。
 * ⚠️ 原来走的 `userQuestions.registerProvider` 那条口**在这一代宿主上不存在**
 * （整个服务里 provider 这个词零命中，成员只有 `ask / askTimed / answer / continued / releaseReply`），
 * 而"注册一个提供者"这个形状本身就是单提供者语义——接管会让桌面问不了问题。
 * 参与 waterfall 才是既两端同弹、又不改变宿主行为的那条路。
 *
 * 所以这里是一份**显式、极窄**的参与名单，而不是一句"waterfall 一律禁止"。
 * 名单外的名字一律拒；名单内的处理器必须返回合法 outcome 或调用 next()，
 * 绝不能返回 undefined —— 那正是把内核每个 turn 都搞崩的形状。
 * 提问那条的"没人答"不是 undefined 而是**把链子的错误原样抛回去**（`noAnswerer` 抛
 * `NO_PROVIDER`），所以参与者那边必须留一份原始 rejection 可复述（见 carrier 的 `participate`）。
 */
export const WATERFALL_PARTICIPANTS = ['approval/request', 'user-questions/request'] as const

const allowed = new Set<string>(SUBSCRIBABLE_EVENTS)
const participants = new Set<string>(WATERFALL_PARTICIPANTS)

/** 允许以"参与者"身份注册的 waterfall 名。 */
export function canParticipate(name: string): boolean {
  return participants.has(name)
}

/** 这个事件名允许订阅吗？白名单外一律 false。 */
export function canSubscribe(name: string): boolean {
  return allowed.has(name)
}

/**
 * 包装宿主的事件注册口：只把白名单内的订阅透下去，
 * 其余返回一个"什么都没做过"的退订函数并记一条告警。
 *
 * 为什么不抛：`apply()` 的红线是绝不向外抛异常，而"少订阅一个事件"只是少一类推送，
 * 不该让插件整个不工作。
 */
export function guardedSubscribe(
  on: (name: string, listener: (payload: never) => void) => unknown,
  name: string,
  listener: (payload: never) => void,
  warn: (message: string, fields?: Record<string, string | number | boolean>) => void,
): () => void {
  if (!canSubscribe(name)) {
    warn('refusing to subscribe', { name, waterfall: WATERFALL_EVENTS.includes(name) })
    return () => {}
  }
  try {
    const disposer = on(name, listener)
    return () => {
      if (typeof disposer === 'function') (disposer as () => void)()
      else if (typeof (on as unknown as { off?: unknown }).off === 'function') {
        // 有的 cordis 代际要靠 off 退订；这里同样是"尽力而为"，失败不影响主流程。
        try {
          ;(on as unknown as { off: (n: string, l: unknown) => void }).off(name, listener)
        } catch {
          /* 忽略 */
        }
      }
    }
  } catch (error) {
    warn('subscribe failed', { name, message: String((error as Error)?.message ?? error) })
    return () => {}
  }
}
