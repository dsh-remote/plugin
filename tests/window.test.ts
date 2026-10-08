/**
 * window.test — `core/window.ts` 的 DeltaWindow。
 *
 * 这一层守的是手机上"看得见"的两件事：**文本一个都不丢、顺序一个都不乱**，
 * 以及**每条消息最终必须有一条 done:true**。编号对应 docs/DESIGN.md §2.2 的 F9，
 * 需求与事故来源是 docs/legacy-spec/host-plugin-runtime.md §3.5/§3.6/§7.2 与
 * docs/legacy-spec/mp-client-contract.md §2.3（`ev.message_delta` 那张表）。
 *
 * 夹具刻意用 `FakeClock`（`core/clock.ts`）而不是真定时器：
 * 旧实现那 5 条窗口测试要 `setTimeout(260)` 真等，所以"定时器只在首字装填"
 * 和两个上限路径（4096 字符 / 32 会话）从来没被测试覆盖过
 * （取证 host-plugin-runtime.md §7.1 §7.4 第 7 条）。这里 120ms 与 300s 都是 `advance()`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EvMessageDelta } from 'dsh-remote-wire'
import { DeltaWindow, DEFAULT_WINDOW_OPTIONS, type WindowOptions } from '../src/core/window.js'
import { FakeClock } from '../src/core/clock.js'

interface Harness {
  clock: FakeClock
  frames: EvMessageDelta[]
  win: DeltaWindow
}

/** 只测合帧器本身：emit 直接落进数组，不认识 socket，也不认识 cordis。 */
function harness(overrides: Partial<WindowOptions> = {}): Harness {
  const clock = new FakeClock()
  const frames: EvMessageDelta[] = []
  const win = new DeltaWindow(
    (frame) => {
      frames.push(frame)
    },
    clock,
    { ...DEFAULT_WINDOW_OPTIONS, ...overrides },
  )
  return { clock, frames, win }
}

test('空文本的 done 帧绝不丢：丢了它手机上「运行中…」会永远转圈（F9）', async () => {
  const { clock, frames, win } = harness()
  win.push('ses_a', 'msg_1', '答案')
  await clock.advance(200) // 越过 120ms 窗口，让带文本的那帧先单独出去
  assert.equal(frames.length, 1, '窗口到期必须出 1 帧，实际没有按窗口合帧')

  // 内核 turn/end 的真实形状：一条空文本 + done:true（adapter-dsh 的 messageId:'turn'）。
  win.complete('ses_a', 'msg_1')
  assert.ok(frames.length >= 2, `done 帧被吞了：只收到 ${frames.length} 帧 → 手机永远收不到"这一轮跑完了"`)

  const tail = frames[frames.length - 1] as EvMessageDelta
  assert.equal(tail.t, 'ev.message_delta', '帧名不是 ev.message_delta → 小程序 if 链不匹配，静默丢弃')
  assert.equal(tail.delta, '', 'done 帧的文本必须是空串（不是 undefined：手机会 += 出 "undefined"）')
  assert.equal(tail.done, true, "手机端 chat.js 靠 done:true 收起转圈，缺了就一直显示'运行中…'")
  assert.equal(tail.messageId, 'msg_1', 'messageId 丢了 → 手机把这条挂到错误的消息行上')
  assert.equal(win.stats.droppedEmpty, 0, 'done 帧不是"空消息"，绝不能进丢弃计数')
})

test('done 与文本落在同一个窗口里时必须合并成一帧（既不另发一帧，也不把 done 弄丢）', () => {
  const { frames, win } = harness()
  win.push('ses_a', 'msg_1', '结论是')
  win.complete('ses_a', 'msg_1')
  assert.equal(frames.length, 1, `done 被拆成了独立帧（${frames.length} 帧）→ 手机要多收一帧，且旧实现这里曾丢过 done`)
  const only = frames[0] as EvMessageDelta
  assert.equal(only.delta, '结论是', '合并必须保序带出原文')
  assert.equal(only.done, true, 'sticky-OR 的 done 必须在合并帧上活着')
})

test('缓冲里根本没有这条消息时（工具调用没出字就直接结束），也必须补一条 done-only 帧', () => {
  const { frames, win } = harness()
  win.complete('ses_b', 'turn')
  assert.ok(frames.length >= 1, '一条文本都没有的收尾同样必须出站，否则手机停在转圈态')
  const only = frames[0] as EvMessageDelta
  assert.equal(only.messageId, 'turn', 'done-only 帧的 messageId 必须逐字回传（手机用它定位消息行）')
  assert.equal(only.delta, '')
  assert.equal(only.done, true)
})

test('合帧定时器只在首字装填：后续字符不许续期，否则长输出永远发不出去', async () => {
  const { clock, frames, win } = harness({ windowMs: 120 })
  win.push('ses_a', 'msg_1', 'a')
  await clock.advance(119)
  assert.equal(frames.length, 0, '未到窗口就发 → 等于没有合帧（帧率退化成 1 帧/字）')
  // 首字之后 119ms 又来一个字：如果实现按"每个字符续期"，出站时刻会被推到 239ms，
  // 一条持续出字的长回答就永远发不出去（手机表现为卡住不动）。
  win.push('ses_a', 'msg_1', 'b')
  await clock.advance(2) // 此刻 121ms：首字装填的那个定时器早该到期
  assert.ok(frames.length >= 1, '后续字符续期了定时器 → 流式输出会一路被推迟，手机看不到增量')
  assert.equal((frames[0] as EvMessageDelta).delta, 'ab', '窗口内的字必须按到达顺序串接，一个都不能少')
})

test('flushSession 冲刷同会话缓冲：非 delta 事件之前必须先调它，否则工具行会插到自己的文本前面', async () => {
  const { clock, frames, win } = harness({ windowMs: 5_000 })
  win.push('ses_a', 'msg_1', '我先说明一下')
  win.flushSession('ses_a') // runtime 在 ev.tool_event 之前走的就是这一步
  win.push('ses_a', 'msg_1', '然后是调用后的补充')
  win.complete('ses_a', 'msg_1') // turn/end：这一条消息到此为止
  await clock.advance(0)

  assert.ok(frames.length >= 2, `只收到 ${frames.length} 帧：文本被工具行插队 → 手机先看到工具调用、后看到调用前的说明`)
  assert.equal((frames[0] as EvMessageDelta).delta, '我先说明一下', '第一帧必须是先产生的那段文本')
  assert.equal((frames[1] as EvMessageDelta).delta, '然后是调用后的补充', '第二帧才是后产生的文本')
  assert.equal(frames[0]?.done, undefined, '中途切帧不许把 done 提前带上（done 只能出现在收尾帧）')
  assert.equal((frames[1] as EvMessageDelta).done, true, '收尾必须有一条 done:true')

  // 已经冲过的会话再冲一次不许重复出站（也不许凭空造帧）。
  const before = frames.length
  win.flushSession('ses_a')
  win.flushSession('ses_never_buffered')
  assert.equal(frames.length, before, 'flush 幂等性破了 → 手机上同一段文字出现两遍')
})

test('maxCharsPerFrame 切帧：字符一个都不丢、顺序不乱，且不提前带上 done', () => {
  const { frames, win } = harness({ windowMs: 10_000, maxCharsPerFrame: 10 })
  const input = '0123456789abcdefghij01234' // 25 个字符，按上限切成 10+10+5
  win.push('ses_a', 'msg_1', input.slice(0, 10))
  assert.ok(frames.length >= 1, '到顶必须立刻 flush，不许等窗口（否则单帧可能顶到中继帧上限）')
  win.push('ses_a', 'msg_1', input.slice(10, 20))
  win.push('ses_a', 'msg_1', input.slice(20))
  win.complete('ses_a', 'msg_1') // 收尾：剩下的 5 个字符必须跟着 done 一起出去

  assert.ok(frames.length >= 3, `切了 ${frames.length} 帧，少于预期的 3 帧 → 有字符被合并逻辑吞掉`)
  assert.equal(frames.map((frame) => frame.delta).join(''), input, '切帧后拼回来的正文必须与输入逐字符相等')
  assert.equal(frames[0]?.done, undefined, '切出来的中间帧不许带 done → 手机会提前收起转圈、后面正文没地方放')
  assert.equal(frames[frames.length - 1]?.done, true, '最后一帧必须带 done')
  assert.equal(
    new Set(frames.map((frame) => frame.messageId)).size,
    1,
    '同一条消息切帧不许换 messageId（换了手机会拆成两段）',
  )
})

test('maxCharsPerFrame 是出站硬上限：一次 push 就写超也要切，不许出一帧 5 万字符', () => {
  const { frames, win } = harness({ windowMs: 10_000, maxCharsPerFrame: 10 })
  const input = 'x'.repeat(37) // 一次到达就超上限三次以上：内核一个 delta 事件带一大段文本是常态
  win.push('ses_a', 'msg_1', input)
  win.complete('ses_a', 'msg_1')

  assert.ok(frames.length >= 4, `一帧 37 字符（上限 10）只切了 ${frames.length} 帧：上限只管了"何时 flush"，没管"多大"`)
  assert.ok(
    frames.every((frame) => frame.delta.length <= 10),
    `仍有超限帧：${JSON.stringify(frames.map((frame) => frame.delta.length))}。中继侧 MAX_FRAME_BYTES 会把整条连接断开，手机表现为"聊着聊着掉线"`,
  )
  assert.equal(frames.map((frame) => frame.delta).join(''), input, '切帧不许丢字符')
  // 到顶的那一次先冲掉 4 片（part 0..3），随后 complete() 补一条收尾帧（part 4）。
  // 这条 done 只能是独立一帧：前 4 帧已经在 complete 之前发出去了。
  assert.deepEqual(
    frames.map((frame) => frame.part),
    [0, 1, 2, 3, 4],
    '同一条消息的分片序号必须逐帧递增：手机与日志靠它判断"分片是否连续"，全 0 就等于没有这个判据',
  )
  assert.equal(frames[frames.length - 1]?.done, true, 'done 只能落在最后一片上')
  assert.equal(
    frames.slice(0, -1).every((frame) => frame.done === undefined),
    true,
    '中间片不许提前带 done',
  )
})

test('切帧不许把一个代理对劈成两半：一个 emoji 被切成两片会变成两个乱码方块', () => {
  const { frames, win } = harness({ windowMs: 10_000, maxCharsPerFrame: 3 })
  // 😀 = U+1F600 = 高位代理 + 低位代理，**占两个 UTF-16 码元**（索引 2 与 3）。
  // 上限 3 正好把切点落在两半之间，旧写法切出 "ab\ud83d" 与 "\ude00cd"：
  // 密封走 `utf8(JSON.stringify(payload))`，ES2019 的 well-formed stringify 把孤立代理
  // 转义成 \udXXX，接收端 JSON.parse 拿回来的仍是**孤立代理**——手机上就是两个豆腐块，
  // 那个表情从此消失。AI 输出里 emoji 极常见，而切点位置由流式节奏决定、完全随机，
  // 所以这不是"理论上可能"，是一条会话跑久了必然踩到的路。
  const input = 'ab\u{1F600}cd' // 长度 6；按上限 3 切 → 第 3 片起点正落在 😀 的两半之间
  win.push('ses_a', 'msg_1', input)
  win.complete('ses_a', 'msg_1')

  const joined = frames.map((frame) => frame.delta).join('')
  assert.equal(joined, input, '切帧后拼回来的正文必须与输入逐码元相等（孤立代理会在这一条上现形）')
  for (const frame of frames) {
    assert.doesNotMatch(
      frame.delta,
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      `这一帧里出现了孤立代理：${JSON.stringify(frame.delta)}——emoji 被劈成了两半`,
    )
  }
  // 代理对允许让这一片多 1 个码元（cap+1），但仍必须受"上限量级"约束，不能整段放行。
  assert.ok(
    frames.every((frame) => frame.delta.length <= 4),
    `代理对让切帧失控：${JSON.stringify(frames.map((f) => f.delta.length))}`,
  )
})

test('part 跨 flush 连续：同一条消息被窗口切成两帧时，序号不能归零', async () => {
  const { clock, frames, win } = harness({ windowMs: 120 })
  win.push('ses_a', 'msg_1', '第一段')
  await clock.advance(200) // 窗口到期 → part 0
  win.push('ses_a', 'msg_1', '第二段')
  await clock.advance(200) // 同一个 messageId 的下一片 → 必须是 part 1
  win.complete('ses_a', 'msg_1')

  assert.equal(frames.length, 3, `预期 3 帧，实收 ${frames.length}`)
  assert.deepEqual(
    frames.map((frame) => frame.part),
    [0, 1, 2],
    'flush 把 entry 删掉、下一条重建时 part 归零 → 一条长回答的所有分片都是 part:0，"分片完整性"无从判断',
  )
  assert.equal(new Set(frames.map((frame) => frame.messageId)).size, 1, '同一条消息不许换 messageId')

  // 换一条消息才是新的序列：从 0 重新开始。
  const second = harness({ windowMs: 120 })
  second.win.push('ses_a', 'msg_1', '甲')
  await second.clock.advance(200)
  second.win.push('ses_a', 'msg_1', '乙')
  await second.clock.advance(200)
  second.win.push('ses_a', 'msg_2', '丙')
  second.win.stop()
  const msg2 = second.frames.filter((frame) => frame.messageId === 'msg_2')
  assert.equal(msg2[0]?.part, 0, `新消息的分片序号应从 0 开始，实际 ${msg2[0]?.part}`)
})

test('maxSessionsPerRound 生效：一轮只冲最旧的 N 个会话，吵闹的会话饿死不了其它会话', () => {
  const { frames, win } = harness({ windowMs: 10_000, maxSessionsPerRound: 2 })
  for (const sessionId of ['ses_1', 'ses_2', 'ses_3', 'ses_4', 'ses_5']) {
    win.push(sessionId, 'msg_x', `字-${sessionId}`)
  }
  assert.equal(win.stats.buffered, 5, '五条会话都该在缓冲里')

  win.flushRound()
  assert.equal(frames.length, 2, '一轮最多冲 maxSessionsPerRound 个，多冲/少冲都说明上限没生效')
  assert.deepEqual(
    frames.map((frame) => frame.sessionId).sort(),
    ['ses_1', 'ses_2'],
    '必须先冲缓冲最久的会话（不按 since 排序就是"最后写入者赢"，某个会话可能永远轮不到）',
  )
  assert.equal(win.stats.buffered, 3, '剩下的三条不许被顺手丢掉')

  win.flushRound()
  win.flushRound()
  assert.equal(frames.length, 5, `两轮之后还剩会话没冲：${win.stats.buffered} 条`)
  assert.equal(win.stats.buffered, 0, '全部会话都必须最终被冲出去（上限只能提前结束窗口，不能丢数据）')
})

test('stop() 全量 flush 并撤掉所有定时器：停机时尾句不许蒸发，也不许留下吊住宿主的定时器', async () => {
  const { clock, frames, win } = harness({ windowMs: 10_000 })
  win.push('ses_a', 'msg_1', '尾句A')
  win.push('ses_b', 'msg_2', '尾句B')
  win.push('ses_c', 'msg_3', '尾句C')
  assert.ok(clock.pending >= 3, '夹具自检：每个会话都该装了一个窗口定时器')

  win.stop()
  await clock.advance(10_000)
  assert.ok(frames.length >= 3, `停机只冲出 ${frames.length} 帧 → 缓冲里的正文随进程一起蒸发`)
  assert.equal(
    frames
      .map((frame) => frame.delta)
      .sort()
      .join('|'),
    ['尾句A', '尾句B', '尾句C'].sort().join('|'),
    '停机必须把每条会话的缓冲都发出去（顺序：flush 在拆 socket 之前）',
  )
  assert.equal(win.stats.buffered, 0, 'stop() 之后缓冲必须清空')
  assert.equal(clock.pending, 0, 'stop() 之后不许残留定时器：宿主是用户的内核进程，插件不能让它赖着不退')
})

test('唯一允许丢弃的情形是"既无文本也非 done"，并且必须被 stats.droppedEmpty 观察到', () => {
  const { frames, win } = harness()
  win.push('ses_a', 'msg_1', '') // 空文本、未收尾
  win.flushSession('ses_a')
  assert.equal(frames.length, 0, '这种噪声帧确实不该出站')
  assert.equal(win.stats.droppedEmpty, 1, '静默丢帧必须计数：否则"手机没输出"永远查不出来')
  assert.equal(win.stats.flushed, 0, '被丢弃的帧不该算进已发出数')

  // 反面对照：同一条会话只要带 done，空文本也必须出站。
  win.complete('ses_a', 'msg_1')
  assert.ok(frames.length >= 1, '带 done 的空文本被一起丢了 → done 帧永不丢这条被破坏了')
  assert.equal(win.stats.droppedEmpty, 1, 'done 帧不许进丢弃计数')
})

test('同一会话换了 messageId：上一条必须先带 done 出去，否则手机为上一条一直转圈', () => {
  const { frames, win } = harness({ windowMs: 10_000 })
  win.push('ses_a', 'msg_1', '前半')
  win.push('ses_a', 'msg_2', '后半') // 内核开始写下一条消息
  win.stop()

  assert.ok(frames.length >= 2, `换了 messageId 只出 ${frames.length} 帧 → msg_1 永远等不到 done`)
  assert.equal(frames[0]?.messageId, 'msg_1')
  assert.equal(frames[0]?.delta, '前半', '上一条的文本必须挂在它自己的 messageId 上（挂错就是两段文本拼成一段）')
  assert.equal(frames[0]?.done, true, '上一条没有 done 就必须补一条 done:true')
  assert.equal(frames[1]?.messageId, 'msg_2')
  assert.equal(frames[1]?.delta, '后半')
})

test('role 必须透传：缺了它手机上无法区分助手文本与用户回声', () => {
  const { frames, win } = harness()
  win.push('ses_a', 'msg_1', '你好', 'assistant')
  win.complete('ses_a', 'msg_1', 'assistant')
  assert.equal(frames.length, 1, '同窗口内 done 与文本合并成 1 帧')
  assert.equal(frames[0]?.role, 'assistant', 'role 丢了 → 手机把助手输出按默认气泡渲染')
})

test('stats.flushed 与实际出站帧数一致（可观测性红线：不许有"发出去了但没人知道"的帧）', () => {
  const { frames, win } = harness({ windowMs: 10_000 })
  for (let i = 0; i < 6; i++) win.push(`ses_${i}`, 'msg_i', `片段${i}`)
  win.flushAll()
  assert.ok(frames.length >= 6, `预期 6 帧，实收 ${frames.length} 帧`)
  assert.equal(win.stats.flushed, frames.length, 'flushed 计数与实际帧数分叉 → status.json 里的数字不可信')
  assert.ok(win.stats.flushed >= 6, 'stats.flushed 必须能观察到已发出的帧数下界')
})
