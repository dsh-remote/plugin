/**
 * kernel-events —— 内核事件 → 线帧的翻译层（v5 R4a 从 `runtime.ts` 抽出）。
 *
 * 合帧与顺序规则都在这里：`delta` 先进 DeltaWindow（`push`/`complete`），
 * 非 delta 事件之前必须先 `flushSession`（否则工具行会插进它自己的文本里），
 * `run-state` **刻意不做任何"推断清空"**（2026-10-11 用户裁决：生命周期跟随 host）。
 *
 * ⚠️ **行为零变化**（R4 纪律）：判据一片未动照样全绿。
 */
import type { KernelEvent } from '../ports/index.js'
import type { HistoryItem } from '@dsh-remote/protocol'
import {
  compactionNotice,
  messageDelta,
  retryNotice,
  runState,
  todoList,
  toolEvent,
} from '@dsh-remote/protocol/outbound'

/** `run` 输出的广播选项（内容与运行态帧，断线期由中继环形缓冲接住）。 */
export const RUN_OUTPUT = { includeNoClient: true } as const

export interface KernelEventsDeps {
  /** DeltaWindow 的合帧操作（push/complete/flushSession）。 */
  window: {
    push(sessionId: string, messageId: string, text: string, role?: 'assistant' | 'user' | 'system'): void
    complete(sessionId: string, messageId: string, role?: 'assistant' | 'user' | 'system'): void
    flushSession(sessionId: string): void
  }
  /** 防休眠的活性喂养（内容到达 = 用户在等）。 */
  sleep: { markActive(): void }
  /** 广播一帧到配对通道（opts 缺省 = 状态面，不带 RUN_OUTPUT）。 */
  broadcast(payload: unknown, opts?: { includeNoClient?: boolean }): void
  /** 按会话记下内核报的模型（cache 住，供空闲会话补发）。 */
  rememberModel(sessionId: string, model: string, provider?: string): void
  /** 按会话广播模型（不读全局默认——防串台）。 */
  broadcastModel(sessionId: string, model: string, provider?: string): void
  /** 推一次全量会话列表（F8：状态变了就推）。 */
  pushSessions(reason: string): void
  /** 工具步数 +1（M2 状态摘要的 `steps`：进度是数出来的，不是猜的）。 */
  noteStep(): void
}

export function createKernelEventHandler(deps: KernelEventsDeps): (event: KernelEvent) => void {
  /** 内核事件入口。合帧与顺序规则都在这几行里。 */
  return (event: KernelEvent): void => {
    switch (event.kind) {
      case 'delta': {
        // **一条带正文的 done 必须先把正文推进窗口**。内核没有 token 级增量：一条消息
        // 就是一条完整的 `assistant/message`（正文与 done 同到）。第一版在这里只走
        // `complete()`，而 complete 对"缓冲区里根本没有这条消息"的情形发的是 **done-only 帧**
        // ——于是 `textOf` 辛苦读出来的回复被整个丢掉，手机上收到一帧空文本 + done，
        // 而"⑧ 流式输出到达 / ⑨ 有 done"两条断言照样绿（真机取证抓到的正是这个）。
        if (event.text) deps.window.push(event.sessionId, event.messageId, event.text, event.role)
        if (event.done) deps.window.complete(event.sessionId, event.messageId, event.role)
        if (event.text) deps.sleep.markActive()
        return
      }
      case 'inbox': {
        // 主机侧排队的用户消息（内核 agent/inbox/spliced）：用户在 DSH 里敲了字，
        // 这一轮还没跑完，消息排给下一轮。手机上它就是一条用户指令——与 user/message
        // 同一条渲染路（用户气泡 + 历史回放），复用 ev.message_delta role=user。
        // 空正文不发：纯图片的 splice 在手机上没有载体，发一条空 user 块等于假事实
        // （mp 的 _applyText 对空正文本来就不建块，这里的跳过只是不浪费那一帧）。
        if (!event.text) return
        deps.window.push(event.sessionId, event.messageId, event.text, 'user')
        deps.window.complete(event.sessionId, event.messageId, 'user')
        deps.sleep.markActive()
        return
      }
      case 'tool':
        // 非 delta 事件之前必须先 flush 同会话缓冲，否则工具行会插进它自己的文本里。
        deps.window.flushSession(event.sessionId)
        deps.broadcast(toolEvent(event), RUN_OUTPUT)
        // 工具步数是状态摘要的进度面（M2）：只计数，不记 tool 名/参数 —— 那些是内容。
        deps.noteStep()
        deps.sleep.markActive()
        return
      case 'run-state':
        deps.window.flushSession(event.sessionId)
        deps.broadcast(runState(event), RUN_OUTPUT)
        if (event.state === 'running') {
          deps.sleep.markActive()
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
        deps.pushSessions('run-state')
        return
      case 'model':
        // **按会话**广播模型（2026-10-05 用户实测：当前会话 space-bunny-free，
        // mp 端显示别的会话切出来的 muse-spark）。
        //
        // 数据源是内核 request/header（每轮一条），**不是**宿主全局默认模型
        // （agentDefaultModel.currentSelection = 新会话默认用哪个）。
        // 全局那个与本会话无关——用户在别的会话切一次模型，本会话显示就跟着变。
        deps.rememberModel(event.sessionId, event.model, event.provider)
        deps.broadcastModel(event.sessionId, event.model, event.provider)
        return
      case 'todo':
        // 与 tool 同一纪律：先 flush 同会话的文本缓冲，再广播整份快照。
        // 不做合并窗口——一轮 todo 也就十几条，逐条发手机也渲染得动；合并反而会让
        // "最后那份清单"晚到，而顶部那颗条子要的就是此刻。
        deps.window.flushSession(event.sessionId)
        deps.broadcast(todoList({ todos: event.todos, sessionId: event.sessionId }), RUN_OUTPUT)
        deps.sleep.markActive()
        return
      case 'retry':
        // 「模型卡住」与「模型正在重试」对用户是两件事（2026-10-06）：
        // 以前这条不映射，手机上一片空白，用户以为它死了还去手动中断。
        deps.broadcast(
          retryNotice({ sessionId: event.sessionId, attempt: event.attempt, max: event.max, reason: event.reason }),
          RUN_OUTPUT,
        )
        return
      case 'compaction':
        // 压缩这段静默期以前完全看不见。
        deps.broadcast(
          compactionNotice({ sessionId: event.sessionId, state: event.state, error: event.error }),
          RUN_OUTPUT,
        )
        return
      case 'title':
        deps.pushSessions('title')
        return
      case 'sessions-changed':
        deps.pushSessions(event.reason ?? 'changed')
        return
    }
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
 * （合并/尾随推送的实现住在 `runtime.ts` 的 pushSessions 接线处，本文件只出接口。）
 */

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
export function historyWireItem(event: KernelEvent): HistoryItem | undefined {
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
