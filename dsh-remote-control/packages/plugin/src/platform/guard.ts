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
] as const

export type SubscribableEvent = (typeof SUBSCRIBABLE_EVENTS)[number]

/**
 * 已知为 waterfall 的事件名。
 *
 * 这份清单**不参与放行判断**（放行只看白名单），它存在的意义只有一条：
 * 让测试能自校验"白名单里绝不出现这里任何一个名字"。
 * 取证位置见 docs/legacy-spec/host-plugin-cordis.md §2.1 的 13 项 + 由宿主
 * `remote-events.js` 与 `@mode waterfall` 声明补出来的 8 项。
 */
export const WATERFALL_EVENTS: readonly string[] = [
  'agent/pre-step',
  'agent/request',
  'agent/request-error',
  'compaction/summary-error',
  'connection/request',
  'fs/edit-intent',
  'fs/write-intent',
  'internal/get',
  'internal/set',
  'internal/config',
  'internal/update',
  'loader/patch-context',
  'session-telemetry/record',
  'user-questions/request',
  'workspace/session-activity',
  'approval/request',
  'llm/stream',
  'system-prompt/assemble',
  'tools/pre-execute',
  'tools/execute',
  'tools/post-execute',
  'tools/code-dispatch-log',
]

/**
 * 允许**参与**的 waterfall（与"观测"是两件事）。
 *
 * `approval/request` 的官方契约就是"参与者返回 outcome 即认领这次决定，
 * 或调用 `next()` 交还"（取证 @deepseek-ai/dsh-user-approval/lib/types/index.d.ts:16-24）。
 * 也就是说：审批要想到达手机，只能参与这条 waterfall，没有 emit-mode 的替代通道
 * （`approval/asked` / `approval/decided` 只是审计事件，不能应答）。
 *
 * 所以这里是一份**显式、极窄**的参与名单，而不是一句"waterfall 一律禁止"。
 * 名单外的名字一律拒；名单内的处理器必须返回合法 outcome 或调用 next()，
 * 绝不能返回 undefined —— 那正是把内核每个 turn 都搞崩的形状。
 */
export const WATERFALL_PARTICIPANTS = ['approval/request'] as const

export type WaterfallParticipant = (typeof WATERFALL_PARTICIPANTS)[number]

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
