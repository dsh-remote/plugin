/**
 * window — 流式增量（delta）的合帧器。纯逻辑，不起定时器、不认识 cordis。
 *
 * 手机端的体验直接由这几个参数决定，所以它们必须是**可单测的参数**而不是散在
 * socket 回调里的魔数。旧实现的窗口化写在 host-runtime 的事件循环里，
 * 测试要靠假定时器凑环境，因此有几条行为从来没被真正锁住——
 * 而其中一条（空文本的 done 帧被合并逻辑吞掉）会让手机**永远转圈**。
 *
 * 四条不变量：
 *
 * 1. **done 帧永不丢**，哪怕这一条消息一个字都没有（例如中断收尾）。
 *    判据是"文本为空**且**没有 done"才丢，写成 `!text && !done`。
 * 2. **窗口计时器只在首字到达时装填，后续字符不续期**。否则一条持续输出的长回答
 *    会把 flush 一路推迟，手机端表现为"卡住不动"。
 * 3. **同一会话的非 delta 事件之前必须先 flush**（由调用方走 `flushSession`），
 *    不然工具行会插到它自己的文本前面。
 * 4. **一轮最多处理 N 个会话**，超出就从最旧的开始冲刷。会话多时这保证
 *    单个吵闹的会话不会饿死其它会话（也顺带给出内存上界）。
 *
 * 另有两条是重写时补的（第一版只做"触发时机"，没做"大小"与"连续性"）：
 * `maxCharsPerFrame` 是**出站硬上限**——一帧最多这么多字符，超了就切多帧；
 * `part` 在**同一条 messageId 内连续**，跨 flush、跨切帧都不归零，
 * 否则手机上"分片是否完整"这件事没有任何可核对依据。
 */
import type { EvMessageDelta } from 'dsh-remote-wire'
import type { Clock } from '../ports/index.js'

export interface WindowOptions {
  /** 合帧窗口（毫秒）。首字到达后到 flush 之间的最长等待。 */
  windowMs: number
  /** 单次 flush 的文本上限（字符）。超过就切帧，避免单帧顶到中继帧上限。 */
  maxCharsPerFrame: number
  /** 一轮 flush 最多处理的会话数。 */
  maxSessionsPerRound: number
}

export const DEFAULT_WINDOW_OPTIONS: WindowOptions = {
  windowMs: 120,
  maxCharsPerFrame: 4096,
  maxSessionsPerRound: 32,
}

interface Entry {
  sessionId: string
  messageId: string
  text: string
  role?: 'assistant' | 'user' | 'system'
  done: boolean
  /** 已发出的分片序号，从 0 开始；只用于手机端诊断（UI 不读）。 */
  part: number
  /** 首字到达时刻，用于"一轮里最旧的先冲"。 */
  since: number
  timer: unknown
}

export class DeltaWindow {
  private readonly entries = new Map<string, Entry>()
  /**
   * 每个会话"这条消息已经发到第几片"。必须活在 entry 之外：flush 会把 entry 删掉，
   * 下一条同 messageId 的增量于是重建 entry、`part` 归零——一条长回答发出去全是
   * `part:0`，手机与日志都失去了"分片是否连续"这个唯一的判据。
   */
  private readonly partCursor = new Map<string, { messageId: string; next: number }>()
  private flushed = 0
  private droppedEmpty = 0

  constructor(
    private readonly emit: (payload: EvMessageDelta) => void,
    private readonly clock: Clock,
    private readonly options: WindowOptions = DEFAULT_WINDOW_OPTIONS,
  ) {}

  /**
   * 收到一段文本。同一 `messageId` 会继续累加；换了 messageId 就先把上一条冲掉，
   * 保证"一条消息的所有 delta 先于下一条出现"。
   */
  push(sessionId: string, messageId: string, text: string, role?: 'assistant' | 'user' | 'system'): void {
    const current = this.entries.get(sessionId)
    if (current && current.messageId !== messageId) {
      // 上一条必须带 done 才算结束；没有 done 就补一条，否则手机端为上一条一直转圈。
      if (!current.done) this.complete(sessionId, current.messageId)
      else this.flushSession(sessionId)
    }
    let entry = this.entries.get(sessionId)
    if (!entry) {
      entry = {
        sessionId,
        messageId,
        text: '',
        role,
        done: false,
        part: this.nextPart(sessionId, messageId),
        since: this.clock.now(),
        timer: undefined,
      }
      this.entries.set(sessionId, entry)
      // 只在首字装填定时器：后续字符不续期，长输出才不会把 flush 一路推后。
      entry.timer = this.clock.setTimeout(() => this.flushSession(sessionId), this.options.windowMs)
    }
    entry.text += text
    if (role) entry.role = role
    if (entry.text.length >= this.options.maxCharsPerFrame) this.flushSession(sessionId)
  }

  /**
   * 标记某条消息结束。**文本为空也必须发**——这是手机端唯一的停止转圈信号（F9）。
   */
  complete(sessionId: string, messageId: string, role?: 'assistant' | 'user' | 'system'): void {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.messageId !== messageId) {
      // 缓冲里根本没有这条消息（例如一条工具调用没产生任何文本就直接结束）：
      // 仍然要补一条 done-only 帧。走 flushedDoneOnly() 而不是裸 emit——
      // 直接 emit 会让 stats.flushed 与实际出站帧数分叉（"发出去了但没人知道"是红线）。
      this.flushedDoneOnly(sessionId, messageId, role)
      return
    }
    entry.done = true
    if (role) entry.role = role
    this.flushSession(sessionId)
  }

  /** 冲刷某个会话的缓冲（非 delta 事件之前、停机时、命令回执前都要调）。 */
  flushSession(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    this.clearTimer(entry)
    this.entries.delete(sessionId)
    if (!entry.text && !entry.done) {
      // 唯一允许丢弃的情形：既没文本也不是收尾帧。计数暴露出去，防止"静默丢帧"无人知晓。
      this.droppedEmpty += 1
      return
    }
    const chunks = this.splitToCap(entry.text)
    if (chunks.length === 0) {
      // 收尾且一个字都没有：仍必须出站（F9），手机只认 done。
      this.emitFrame(entry, '', true)
    } else {
      chunks.forEach((chunk, index) => this.emitFrame(entry, chunk, index === chunks.length - 1 ? entry.done : false))
    }
    // 分片序号要跨 flush 接着数；这条消息已经带 done 收尾了就把游标清掉，
    // 下一条消息从 0 开始才是它自己的序列。
    if (entry.done) this.partCursor.delete(sessionId)
    else this.partCursor.set(sessionId, { messageId: entry.messageId, next: entry.part })
    entry.text = ''
  }

  /**
   * 一轮冲刷：先处理缓冲最久的会话，超过 `maxSessionsPerRound` 就停在这里
   * （下一轮继续），避免吵闹的会话饿死其它会话。
   */
  flushRound(): void {
    const ordered = [...this.entries.values()].sort((a, b) => a.since - b.since)
    for (const entry of ordered.slice(0, this.options.maxSessionsPerRound)) {
      this.flushSession(entry.sessionId)
    }
  }

  /** 停机/断线时全量冲刷。 */
  flushAll(): void {
    for (const sessionId of [...this.entries.keys()]) this.flushSession(sessionId)
  }

  stop(): void {
    this.flushAll()
    for (const entry of this.entries.values()) this.clearTimer(entry)
    this.entries.clear()
    // 游标也要清：会话没了还留着它的分片序号，等于给未来同 id 的消息一个凭空的起点。
    this.partCursor.clear()
  }

  get stats(): { buffered: number; flushed: number; droppedEmpty: number } {
    return { buffered: this.entries.size, flushed: this.flushed, droppedEmpty: this.droppedEmpty }
  }

  /**
   * 硬切成 `maxCharsPerFrame` 以内的片。
   *
   * 第一版只在 `entry.text.length >= cap` 时"触发一次 flush"，而 flush 是整串发出去的：
   * 一次 push 就写进 5 万字符时，出站的那一帧仍然是 5 万字符——上限只管了时机、没管大小，
   * 于是手机可能顶到中继的帧上限（`MAX_FRAME_BYTES`）而被整条连接断开。
   */
  private splitToCap(text: string): string[] {
    const cap = this.options.maxCharsPerFrame
    if (!Number.isFinite(cap) || cap <= 0 || text.length <= cap) return text.length === 0 ? [] : [text]
    const parts: string[] = []
    for (let at = 0; at < text.length; at += cap) parts.push(text.slice(at, at + cap))
    return parts
  }

  /** 这条消息的下一个分片序号：跨 flush 连续，换 messageId 就归零。 */
  private nextPart(sessionId: string, messageId: string): number {
    const cursor = this.partCursor.get(sessionId)
    if (!cursor) return 0
    if (cursor.messageId !== messageId) {
      this.partCursor.delete(sessionId)
      return 0
    }
    return cursor.next
  }

  /** 缓冲区里从来没有过这条消息的收尾帧（例如一条工具调用一个字都没出就直接结束）。 */
  private flushedDoneOnly(sessionId: string, messageId: string, role?: 'assistant' | 'user' | 'system'): void {
    this.flushed += 1
    // 收尾帧同样是这条消息的一片：序号要接得上（前面已经发过 2 片时它就是第 3 片），
    // 从来没有过缓冲时才回到 0。发完就把游标清掉，下一条消息重新计数。
    const part = this.nextPart(sessionId, messageId)
    this.partCursor.delete(sessionId)
    this.emit({ t: 'ev.message_delta', sessionId, messageId, delta: '', part, done: true, ...(role ? { role } : {}) })
  }

  private emitFrame(entry: Entry, text: string, done: boolean): void {
    this.flushed += 1
    this.emit({
      t: 'ev.message_delta',
      sessionId: entry.sessionId,
      messageId: entry.messageId,
      delta: text,
      part: entry.part++,
      ...(entry.role ? { role: entry.role } : {}),
      ...(done ? { done } : {}),
    })
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer !== undefined) {
      this.clock.clearTimeout(entry.timer)
      entry.timer = undefined
    }
  }
}
