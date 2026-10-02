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
 */
import type { EvMessageDelta } from '@dsh-rc/protocol'
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
        part: 0,
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
      // 仍然要补一条 done-only 帧。
      this.emit({ t: 'ev.message_delta', sessionId, messageId, delta: '', done: true, ...(role ? { role } : {}) })
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
    this.emitFrame(entry, entry.text, entry.done)
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
  }

  get stats(): { buffered: number; flushed: number; droppedEmpty: number } {
    return { buffered: this.entries.size, flushed: this.flushed, droppedEmpty: this.droppedEmpty }
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
