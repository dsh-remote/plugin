/**
 * 提醒定时器（2026-10-27）的判据。
 *
 * ## 它守什么
 *
 * 审批/提问挂起满 `NOTIFY_DELAY_MS`（**60 秒**）还没结算、而**手机不在线**时，
 * 主机发一帧 `notify-approval` 让中继去发微信服务通知。
 *
 * 六条纪律（每条都对应一个"做错了会怎样"）：
 *
 * | # | 纪律 | 做错了会怎样 |
 * | --- | --- | --- |
 * | ① | 到点才发 | 用户刚走开 3 秒就被吵醒 |
 * | ② | 在线不发 | 手机本来就能看到卡，通知是多余的 |
 * | ③ | 结算过的不发 | "已经答过了还催我" |
 * | ④ | 中继不支持就不挂定时器 | 老中继回 `unknown_frame`，两端刷错误 |
 * | ⑤ | 同一张卡只发一次 | 同一件事被反复戳 |
 * | ⑥ | 同会话多张卡聚合成一条 | 通知栏被刷爆 |
 *
 * ## ⚠️ 判据自己的两个坑（都踩过）
 *
 * - **"没发"要能区分是哪个机制在挡**：⑤ 那一枪第一版就因为"频控"恰好也给出
 *   `sent=0` 而漏过去 ⇒ 现在跨过冷却再验（见 relay 侧同款教训）。
 * - **夹具要能造出"手机在线"**：本文件用 `hasClient` 的返回值控制，
 *   而不是"发出去就算"（那验的是别的东西）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInteractions, NOTIFY_DELAY_MS } from '../src/core/interactions.js'
import { FakeClock } from '../src/core/clock.js'
import type { NotifyItem } from '@dsh-remote/protocol'

interface Harness {
  clock: FakeClock
  interactions: ReturnType<typeof createInteractions>
  /** 发出去的提醒帧（每一次调用记一条）。 */
  sent: Array<{ conversationId: string; items: NotifyItem[] }>
}

function harness(options: { online?: boolean; notifySupported?: boolean } = {}): Harness {
  const clock = new FakeClock()
  const online = options.online ?? false
  const sent: Array<{ conversationId: string; items: NotifyItem[] }> = []
  const interactions = createInteractions({
    clock,
    log: () => {},
    replyTo: () => {},
    broadcast: () => 0,
    hold: () => {},
    releaseHold: () => {},
    kernelRunState: async () => ({ running: false }),
    sessionRunningFallback: () => false,
    pickConversation: () => 'conv_1',
    hasClient: () => online,
    conversationIds: () => ['conv_1'],
    supportsNotify: () => options.notifySupported ?? true,
    notifyApproval: (conversationId: string, items: NotifyItem[]) => {
      sent.push({ conversationId, items })
      return true
    },
  })
  return { clock, interactions, sent }
}

/** 第一条提醒（断言它真的发出来了 ⇒ 顺带把类型收窄）。 */
function firstSent(h: Harness): { conversationId: string; items: NotifyItem[] } {
  const sent = h.sent[0]
  assert.ok(sent, `应该已经发出一条提醒（实际 ${h.sent.length} 条）`)
  return sent
}

/** 第一条提醒里的第一张卡。 */
function firstItem(h: Harness): NotifyItem {
  const item = firstSent(h).items[0]
  assert.ok(item, '提醒里至少要有一张卡')
  return item
}

/** 挂一张审批卡（不等它结算）。 */
function askApproval(h: Harness, sessionId = 'ses_1'): Promise<unknown> {
  return h.interactions.onApprovalRequest({ sessionId, action: 'Bash' })
}

test('① 挂起满 60 秒、手机离线 ⇒ 发一帧提醒', async () => {
  const h = harness()
  void askApproval(h)
  assert.equal(h.sent.length, 0, '还没到点不许发')
  await h.clock.advance(NOTIFY_DELAY_MS - 1_000)
  assert.equal(h.sent.length, 0, '差 1 秒也不许发')
  await h.clock.advance(2_000)
  assert.equal(h.sent.length, 1, '到点要发')
  assert.equal(firstSent(h).conversationId, 'conv_1')
  assert.equal(firstSent(h).items.length, 1)
  assert.equal(firstItem(h).kind, 'approval')
  assert.ok(firstItem(h).requestId.length > 0, '要有 requestId（中继靠它去重）')
  assert.equal(firstItem(h).sessionId, 'ses_1')
})

test('② 手机在线 ⇒ 不发（它本来就能看到卡）', async () => {
  const h = harness({ online: true })
  void askApproval(h)
  await h.clock.advance(NOTIFY_DELAY_MS * 3)
  assert.equal(h.sent.length, 0, '在线时提醒是多余的')
})

test('③ 卡已结算 ⇒ 到点不发', async () => {
  const h = harness()
  const pending = askApproval(h)
  // 结算掉它（模拟手机答了）
  const entries = h.interactions.pendingEntries(undefined)
  assert.equal(entries.length, 1)
  const first = entries[0]
  assert.ok(first, '要有一张卡')
  h.interactions.settleApproval(first[0], 'approve')
  await pending
  await h.clock.advance(NOTIFY_DELAY_MS * 2)
  assert.equal(h.sent.length, 0, '已经答过了还催 = 骚扰')
})

test('④ 中继不支持 notify.v1 ⇒ 连定时器都不挂（老中继会回 unknown_frame）', async () => {
  const h = harness({ notifySupported: false })
  void askApproval(h)
  await h.clock.advance(NOTIFY_DELAY_MS * 3)
  assert.equal(h.sent.length, 0, '不支持就不该发')
})

test('⑤ 同一张卡只发一次（再等多久也不重复）', async () => {
  const h = harness()
  void askApproval(h)
  await h.clock.advance(NOTIFY_DELAY_MS)
  assert.equal(h.sent.length, 1)
  await h.clock.advance(NOTIFY_DELAY_MS * 5)
  assert.equal(h.sent.length, 1, '同一张卡不许被反复通知')
})

test('⑥ 同会话多张卡 ⇒ 聚合成一条（通知栏不许被刷爆）', async () => {
  const h = harness()
  void askApproval(h, 'ses_1')
  void h.interactions.onQuestionRequest({
    sessionId: 'ses_1',
    questions: [{ id: 'q1', question: '要哪个', options: [{ id: 'o1', label: '甲' }] }],
  })
  await h.clock.advance(NOTIFY_DELAY_MS)
  assert.equal(h.sent.length, 1, '两张卡 ⇒ 一条通知')
  assert.equal(firstSent(h).items.length, 2, '一条通知里带上两张卡')
  const kinds = firstSent(h)
    .items.map((i) => i.kind)
    .sort()
  assert.deepEqual(kinds, ['approval', 'question'])
})

test('⑦ 提醒帧里只有元数据：一个字的正文都不许带', async () => {
  const h = harness()
  void askApproval(h)
  await h.clock.advance(NOTIFY_DELAY_MS)
  const item = firstItem(h)
  assert.deepEqual(Object.keys(item).sort(), ['askedAt', 'kind', 'requestId', 'sessionId'])
  // ⚠️ askedAt 是**时刻**，不是内容
  assert.match(item.askedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('⑧ 提问卡也提醒（两类卡共用这一路）', async () => {
  const h = harness()
  void h.interactions.onQuestionRequest({
    sessionId: 'ses_2',
    questions: [{ id: 'q1', question: '要哪个', options: [{ id: 'o1', label: '甲' }] }],
  })
  await h.clock.advance(NOTIFY_DELAY_MS)
  assert.equal(h.sent.length, 1)
  assert.equal(firstItem(h).kind, 'question')
})
