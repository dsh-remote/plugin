/**
 * mp-chat-blocks — chat 页「文档流」状态机的对照测试。
 *
 * 为什么需要：这一页把一条会话拆成 轮次/指令/步骤组/回复/提示 五种块，
 * 而「哪一步属于哪一组、一组什么时候封口」全靠**事件顺序推断**
 * （协议里没有"思考开始了"这种事件）。这类逻辑错了不会报错，只会让界面
 * 看起来在骗人 —— 比如状态条在第一次工具调用后就显示空闲、用户自己的话出现两遍、
 * 新的工具调用被塞回上一段已经读完的过程里。第三条是重做成"步骤组"时新增的坑。
 *
 * 做法：用假的 wx / Page 载入**真实的页面代码**，喂事件序列，断言块流形状。
 * 纯逻辑、不连中继，所以能进 CI。
 */
import { createRequire } from 'node:module'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 假 wx：页面只用到这几个能力 ──────────────────────────────────────
const storage = {}
globalThis.wx = {
  getStorageSync: (k) => (storage[k] === undefined ? '' : storage[k]),
  setStorageSync: (k, v) => {
    storage[k] = v
  },
  removeStorageSync: (k) => {
    delete storage[k]
  },
  setNavigationBarTitle: () => {},
  showToast: () => {},
  vibrateLong: () => {},
  hideKeyboard: () => {},
  createSelectorQuery: () => {
    const q = {
      select: () => q,
      boundingClientRect: (cb) => {
        if (cb) cb({ height: 600 })
        return q
      },
      exec: () => {},
    }
    return q
  },
}

// ── 载入真实的页面代码 ───────────────────────────────────────────────
let captured = null
globalThis.Page = (cfg) => {
  captured = cfg
}
require(path.join(ROOT, 'mp/pages/chat/chat.js'))
assert.ok(captured, 'Page() 没被调用 —— 页面代码没加载起来')

/**
 * 页面用到的 setData 路径有两种：
 *   blocks[3].open                  （组自己的开合）
 *   blocks[3].items[2].open         （组内某一步的开合 / 计时刷新）
 */
function setByPath(obj, p, value) {
  const m = p.match(/^([A-Za-z_$][\w$]*)\[(\d+)\]\.(?:items\[(\d+)\]\.)?([\w$]+)$/)
  if (m) {
    const node =
      m[3] === undefined ? obj[m[1]][Number(m[2])] : obj[m[1]][Number(m[2])].items[Number(m[3])]
    node[m[4]] = value
    return
  }
  assert.match(p, /^[A-Za-z_$][\w$]*$/, `setData 路径没处理: ${p}`)
  obj[p] = value
}

/** 页面里的思考计时器是 setInterval，不清掉 node 不会退出 */
const live = []
after(() => {
  for (const pg of live) pg._stopThinkTick()
})

function makePage() {
  const ctx = { ...captured }
  ctx.data = JSON.parse(JSON.stringify(captured.data))
  ctx.setData = (patch, cb) => {
    for (const p in patch) setByPath(ctx.data, p, patch[p])
    if (cb) cb()
  }
  ctx.onLoad({ id: 's1', title: '测试会话' })
  live.push(ctx)
  return ctx
}

/** 把块流压成好断言的形状：步骤组连组内的条目一起展开 */
const kinds = (ctx) =>
  ctx.data.blocks.map((b) => {
    if (b.kind !== 'steps') return b.kind
    const inner = b.items
      .map((it) => (it.type === 'think' ? `think(${it.done ? 'done' : 'live'})` : 'tool'))
      .join('+')
    return `steps[${inner}]${b.closed ? '|closed' : ''}`
  })

const stepGroups = (ctx) => ctx.data.blocks.filter((b) => b.kind === 'steps')
const send = (ctx, payload) => ctx._onEvent({ kind: 'payload', payload })

test('一轮：思考随内容出现而收尾，工具进同一个步骤组，按 callId 原地更新', () => {
  const p = makePage()
  p.data.inputText = '看下 git status'
  p.onSend()
  assert.deepEqual(kinds(p), ['turn', 'user'], '发出指令后应立刻有轮次分隔与指令块')

  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'running' })
  assert.deepEqual(kinds(p), ['turn', 'user', 'steps[think(live)]'], '开跑后应有一段落着的思考')

  send(p, {
    t: 'ev.tool_event',
    sessionId: 's1',
    callId: 'c1',
    tool: 'Bash',
    phase: 'started',
    title: 'git status',
  })
  assert.deepEqual(
    kinds(p),
    ['turn', 'user', 'steps[think(done)+tool]'],
    '工具与思考同属一组，且工具出现即收掉上一段思考',
  )

  send(p, {
    t: 'ev.tool_event',
    sessionId: 's1',
    callId: 'c1',
    tool: 'Bash',
    phase: 'completed',
    resultPreview: 'nothing to commit\nsecond line',
  })
  assert.equal(p.data.blocks.length, 3, '同一个 callId 的收尾帧不得新开一组')
  let g = stepGroups(p)[0]
  assert.equal(g.items.length, 3, '思考 / 工具 / 新思考：拿到结果后模型接着想')
  assert.equal(g.items[1].preview, 'nothing to commit second line', '结果预览要压成一行')
  assert.equal(g.tools, 1)
  assert.equal(g.live, true, '还有一条思考没结束，这一组就算在跑')
  assert.equal(g.label, '正在执行 1 个步骤')

  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'idle' })
  g = stepGroups(p)[0]
  assert.equal(g.items.at(-1).done, true, 'idle 必须收掉组内最后的思考')
  assert.equal(g.live, false)
  assert.equal(g.label, '已完成 1 个步骤')
  assert.equal(p.data.running, false)
})

test('工具还在跑的时候不补思考（那会儿在跑的是工具，不是模型）', () => {
  const p = makePage()
  // 空块流时不插思考：那一轮还没开始，状态由顶栏表达，凭空一段「思考中」反而落单
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'running' })
  assert.deepEqual(kinds(p), [], '空流不插思考段')

  p.data.inputText = '跑一下测试'
  p.onSend()
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'running' })
  assert.deepEqual(kinds(p), ['turn', 'user', 'steps[think(live)]'])

  send(p, { t: 'ev.tool_event', sessionId: 's1', callId: 'c1', tool: 'Bash', phase: 'started' })
  send(p, {
    t: 'ev.tool_event',
    sessionId: 's1',
    callId: 'c1',
    tool: 'Bash',
    phase: 'args',
    argsPreview: '{"command":"ls"}',
  })
  assert.deepEqual(
    kinds(p),
    ['turn', 'user', 'steps[think(done)+tool]'],
    'args 阶段不得再补一段思考',
  )
  assert.equal(stepGroups(p)[0].items[1].args, '{"command":"ls"}', '参数要落到那一条上')
})

test('正文出现即给步骤组封口：新的工具调用另起一组，不插回上一段过程', () => {
  const p = makePage()
  p.data.inputText = '先看状态，再跑测试'
  p.onSend()
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'running' })

  send(p, {
    t: 'ev.tool_event',
    sessionId: 's1',
    callId: 'c1',
    tool: 'Bash',
    phase: 'completed',
    resultPreview: 'ok',
  })
  send(p, {
    t: 'ev.message_delta',
    sessionId: 's1',
    messageId: 'm1',
    delta: '第一步做完了。',
    done: true,
    role: 'assistant',
  })
  p._flushDelta()

  const first = stepGroups(p)[0]
  assert.equal(first.closed, true, '有正文出现后这一组就该封口')
  assert.equal(first.tools, 1)
  assert.equal(first.label, '已完成 1 个步骤')

  send(p, {
    t: 'ev.tool_event',
    sessionId: 's1',
    callId: 'c2',
    tool: 'Bash',
    phase: 'completed',
    resultPreview: 'ok2',
  })
  const groups = stepGroups(p)
  assert.equal(groups.length, 2, '第二次调用必须另起一组，不能塞回已封口的那组')
  assert.equal(groups[1].tools, 1)

  const order = kinds(p)
  assert.deepEqual(order.slice(0, 2), ['turn', 'user'])
  assert.ok(order[2].startsWith('steps['), '第一组')
  assert.equal(order[3], 'text', '正文夹在两段过程之间')
  assert.ok(order[4].startsWith('steps['), '第二组')
})

test('assistant/message 自带 done，不得据此判定这一轮结束', () => {
  const p = makePage()
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'running' })
  send(p, {
    t: 'ev.message_delta',
    sessionId: 's1',
    messageId: 'm1',
    delta: '我先查一下。',
    done: true,
    role: 'assistant',
  })
  p._flushDelta()
  assert.equal(p.data.running, true, '一轮里可以有好几条 assistant/message，done 不代表 turn 结束')
  assert.equal(p.data.barText, '主机运行中')
})

test('流式 delta 合并成一块，done 落在块上', () => {
  const p = makePage()
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm1', delta: '工作区是干净的' })
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm1', delta: '。' })
  p._flushDelta()
  send(p, {
    t: 'ev.message_delta',
    sessionId: 's1',
    messageId: 'm1',
    delta: '',
    done: true,
    role: 'assistant',
  })
  p._flushDelta()
  const texts = p.data.blocks.filter((b) => b.kind === 'text')
  assert.equal(texts.length, 1, '同一条消息的多个 delta 只能是一个块')
  assert.equal(texts[0].text, '工作区是干净的。')
  assert.equal(texts[0].done, true)
})

test('宿主回传的用户消息要与本地回显去重', () => {
  const p = makePage()
  p.data.inputText = '看下 git status'
  p.onSend()
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'running' })
  send(p, { t: 'ev.tool_event', sessionId: 's1', callId: 'c1', tool: 'Bash', phase: 'started' })
  const before = p.data.blocks.length

  send(p, {
    t: 'ev.message_delta',
    sessionId: 's1',
    messageId: 'mu',
    delta: '看下 git status',
    done: true,
    role: 'user',
  })
  p._flushDelta()
  assert.equal(
    p.data.blocks.length,
    before,
    '同一条用户消息不得变成两块（中间隔着思考/工具也要认得出）',
  )
  assert.equal(p.data.blocks[1].confirmed, true, '本地那块应被标记为已确认')

  send(p, {
    t: 'ev.message_delta',
    sessionId: 's1',
    messageId: 'mu2',
    delta: '另一个客户端发的话',
    done: true,
    role: 'user',
  })
  p._flushDelta()
  assert.equal(p.data.blocks.at(-1).text, '另一个客户端发的话', '对不上的用户消息要照常追加')
})

test('折叠：组的开合与「展开过程」两个层级', () => {
  const p = makePage()
  send(p, {
    t: 'ev.tool_event',
    sessionId: 's1',
    callId: 'c1',
    tool: 'Bash',
    phase: 'completed',
    resultPreview: 'ok',
  })
  assert.equal(p.data.blocks[0].kind, 'steps')
  assert.equal(p.data.blocks[0].open, false, '新步骤组默认收起 —— 这是这一页的窗口管理')
  assert.equal(p.data.blocks[0].items[0].open, false, '组内某一步也默认收起')

  p.onToggleSteps({ currentTarget: { dataset: { idx: 0 } } })
  assert.equal(p.data.blocks[0].open, true, '点一下展开这一组')
  assert.equal(p.data.blocks[0].items[0].open, false, '展开组不等于展开某一步的细节')

  p.onToggleTool({ currentTarget: { dataset: { b: 0, i: 0 } } })
  assert.equal(p.data.blocks[0].items[0].open, true, '再点展开这一步的参数与完整结果')

  p.onToggleAll() // expanded: false -> true
  assert.equal(p.data.expanded, true)
  assert.equal(p.data.blocks[0].open, true)

  p.onToggleAll() // -> false
  assert.equal(p.data.expanded, false)
  assert.equal(p.data.blocks[0].open, false)
})

test('点空白收起键盘；输入区自己 catch 住不误收', () => {
  const p = makePage()
  p.data.inputFocus = true
  p.onTapBlank()
  assert.equal(p.data.inputFocus, false, '点空白必须真的失焦，否则键盘收不起来')
  assert.equal(typeof p.onNoop, 'function', '输入区/面板的 catchtap 需要一个空实现')
})

test('块流裁剪后索引要重建到新下标', () => {
  const p = makePage()
  for (let i = 0; i < 420; i++) {
    p._commit(
      p._append(p.data.blocks, { key: 'x' + i, kind: 'text', msgId: 'g' + i, text: 'x', done: true }),
    )
  }
  assert.equal(p.data.blocks.length, 401, '裁剪到上限 + 1 条说明')
  assert.equal(p.data.blocks[0].kind, 'note')
  const idx = p._textIndex['g419']
  assert.ok(idx !== undefined, '索引必须指向裁剪后的新位置')
  assert.equal(p.data.blocks[idx].msgId, 'g419')
})

// ── 历史：打开会话时把主机上已有的内容读进来 ────────────────────────
//
// 这一组守的是"点进去是空的"那件事的另一半：协议与主机侧现在能读出历史了，
// 而**它怎么进块流**全在这一页。历史与实时必须走同一条落块逻辑，
// 否则会出现"实时看着对、历史看着怪"——靠肉眼很难发现。

/** 让微任务跑完（客户端桩返回的是 Promise）。 */
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** 换掉真实的 client：历史这条路只需要四个方法。 */
function stubClient(p, handler) {
  const calls = []
  p.client = {
    status: 'online',
    isPaired: () => true,
    loadHistory: (sessionId, opts) => {
      calls.push({ sessionId, opts: opts || {} })
      return handler(sessionId, opts || {})
    },
    listSessions: () => {},
    sendPrompt: () => {},
  }
  return calls
}

/** 一页典型的真实历史：两轮，中间夹一次工具调用。 */
const HISTORY_PAGE = [
  { t: 'ev.message_delta', messageId: 'h1', delta: '看看这个项目的完成度', role: 'user', done: true },
  { t: 'ev.message_delta', messageId: 'h2', delta: '我先看一下目录。', role: 'assistant', done: true },
  { t: 'ev.tool_event', callId: 'hc1', phase: 'args', tool: 'Bash', title: 'ls -la', argsPreview: '{"command":"ls -la"}' },
  { t: 'ev.tool_event', callId: 'hc1', phase: 'completed', tool: 'Bash', resultPreview: 'total 88' },
  { t: 'ev.message_delta', messageId: 'h3', delta: '结构清楚了。', role: 'assistant', done: true },
  { t: 'ev.message_delta', messageId: 'h4', delta: '再跑一遍测试', role: 'user', done: true },
  { t: 'ev.message_delta', messageId: 'h5', delta: '测试全过。', role: 'assistant', done: true },
]

test('历史：一页条目走同一条落块路径 —— 用户消息开新轮次，工具进步骤组，不补思考段', async () => {
  const p = makePage()
  const calls = stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: HISTORY_PAGE, nextBeforeSeq: 4 }))
  p._maybeLoadHistory()
  await flush()

  assert.deepEqual(calls, [{ sessionId: 's1', opts: {} }], '不带游标 = 要最新一页')
  assert.deepEqual(kinds(p), ['turn', 'user', 'text', 'steps[tool]|closed', 'text', 'turn', 'user', 'text'])
  assert.equal(stepGroups(p)[0].items.length, 1, '历史回放不许补「思考中」——那会是一排永远走不完的秒数')
  assert.equal(stepGroups(p)[0].items[0].preview, 'total 88')
  assert.equal(stepGroups(p)[0].closed, true, '正文出现后这一组要封口')

  assert.deepEqual(
    p.data.blocks.filter((b) => b.kind === 'turn').map((b) => b.label),
    ['第 1 轮', '第 2 轮'],
  )
  assert.equal(p.data.turn, 2, '轮次计数要接着历史往下数，否则下一条指令又从「第 1 轮」开始')
  assert.equal(p.data.historyState, 'ok')
  assert.equal(p.data.hasMore, true)
  assert.equal(p.data.running, false, '回放历史绝不能把顶栏改成"运行中"')
})

test('历史：与实时已经渲染过的内容按 id 去重（会话正在跑时进来，同一帧会到两次）', async () => {
  const p = makePage()
  // 先用实时路径喂进一条消息与一次工具调用
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'h2', delta: '我先看一下目录。', role: 'assistant', done: true })
  p._flushDelta()
  send(p, { t: 'ev.tool_event', sessionId: 's1', callId: 'hc1', tool: 'Bash', phase: 'completed', resultPreview: 'total 88' })
  const before = kinds(p)

  stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: HISTORY_PAGE }))
  p._maybeLoadHistory()
  await flush()

  const texts = p.data.blocks.filter((b) => b.kind === 'text' && b.msgId === 'h2')
  assert.equal(texts.length, 1, '同一条消息在历史里又来一遍：不能变成两块')
  assert.equal(stepGroups(p).filter((g) => g.items.some((it) => it.callId === 'hc1')).length, 1, '同一次工具调用不能有两行')
  assert.ok(kinds(p).length > before.length, '只有更早的内容该被补进来')
  assert.equal(kinds(p)[0], 'turn', '更早的轮次拼在最前面')
})

test('历史：「加载更早」把上一页拼到前面并重排轮次号（先加载的那页编号一定偏小）', async () => {
  const p = makePage()
  const calls = stubClient(p, (sessionId, opts) =>
    opts.beforeSeq === undefined
      ? Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: HISTORY_PAGE, nextBeforeSeq: 4 })
      : Promise.resolve({
          sessionId: 's1',
          cmdId: 'c2',
          items: [
            { t: 'ev.message_delta', messageId: 'e1', delta: '更早的一句话', role: 'user', done: true },
            { t: 'ev.message_delta', messageId: 'e2', delta: '更早的回复。', role: 'assistant', done: true },
          ],
        }),
  )
  p._maybeLoadHistory()
  await flush()
  const anchorKey = p.data.blocks[0].key

  p.onLoadEarlier()
  await flush()

  assert.deepEqual(calls.map((c) => c.opts.beforeSeq), [undefined, 4], '第二页必须原样回传主机给的游标')
  assert.deepEqual(
    p.data.blocks.filter((b) => b.kind === 'turn').map((b) => b.label),
    ['第 1 轮', '第 2 轮', '第 3 轮'],
    '不重排的话「第 2 轮」会排在「第 1 轮」前面',
  )
  assert.equal(p.data.turn, 3)
  assert.equal(p.data.hasMore, false, '主机没给游标就是到底了')
  assert.equal(p.data.toView, 'b' + anchorKey, '要靠锚点把用户刚读到的那一块滚回视口，否则页面会原地跳动')
})

test('历史：翻回唯一的一页之后不留游标；再点「加载更早」不会再发请求', async () => {
  const p = makePage()
  const calls = stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: HISTORY_PAGE }))
  p._maybeLoadHistory()
  await flush()
  assert.equal(p.data.hasMore, false)
  p.onLoadEarlier()
  await flush()
  assert.equal(calls.length, 1, '已经到底了还在发请求：用户点一下就要等一次超时')
})

test('历史：读不到 ≠ 没内容 —— 读不到要给重试的出口，不能装作会话是空的', async () => {
  const p = makePage()
  let ok = false
  const calls = stubClient(p, () => (ok ? Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: HISTORY_PAGE }) : Promise.resolve(null)))
  p._maybeLoadHistory()
  await flush()
  assert.equal(p.data.historyState, 'error', '读不到必须与"这个会话没内容"分开报')
  assert.equal(p.data.blocks.length, 0)

  // 页面上的那一行是可点的重试
  ok = true
  p.onLoadEarlier()
  await flush()
  assert.equal(calls.length, 2, '重试必须真的再发一次')
  assert.equal(p.data.historyState, 'ok')
  assert.equal(p.data.blocks.length, 8)
})

test('历史：还没配对 / 还没连上时不发请求，等状态变化再试（而不是记成"读不到"）', async () => {
  const p = makePage()
  const calls = stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: [] }))
  p.client.isPaired = () => false
  p._maybeLoadHistory()
  await flush()
  assert.equal(calls.length, 0)
  assert.equal(p.data.historyState, 'idle', '没配对不是失败：连上之后还会再来一次')

  p.client.isPaired = () => true
  p.client.status = 'connecting'
  p._maybeLoadHistory()
  await flush()
  assert.equal(calls.length, 0, '没连上就发请求只会白等一次超时')

  p.client.status = 'online'
  p._maybeLoadHistory()
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(p.data.historyState, 'ok')
})

test('历史：第一页读到了但不许自动跟底（用户在读旧内容，不该被甩走）', async () => {
  const p = makePage()
  stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: HISTORY_PAGE }))
  p._maybeLoadHistory()
  await flush()
  // 首屏进来时本来就该停在最新的位置，所以这里只证明它没有额外翻转锚点
  assert.equal(p.data.toView, 'anchor-a', '历史加载不该动滚动锚点')
})

test('历史头的文案不许自相矛盾（这类缺陷只有截图看得见，所以用断言补一道闸）', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'mp/pages/chat/chat.wxml'), 'utf8')
  // 「还有更早」那一支只在 hasMore 为真时渲染。它左边曾写着「已到最早加载的位置」——
  // 恰好是反的，而旁边紧跟着「加载更早的内容」。控件都是对的时候，只有放大看文案才发现。
  const from = wxml.indexOf('wx:elif="{{hasMore}}"')
  assert.ok(from > 0, 'hasMore 那一支不见了？')
  const branch = wxml.slice(from, wxml.indexOf('</view>', from))
  assert.ok(!/最早/.test(branch), '这一支里不能出现"已到最早加载的位置"')
  assert.ok(/加载更早的内容/.test(branch), '这一支要给出可点的动作')

  // 「读不到」与「没内容」是两句不同的话，缺一句就意味着用户看不出区别
  assert.match(wxml, /这个会话还没有内容/)
  assert.match(wxml, /还没有可以显示的内容/)
  assert.match(wxml, /没读到主机上的历史/)
})

test('列表里这条会话正在跑时，顶栏要跟着变（从列表点进运行中的会话，原来一直显示"空闲"）', () => {
  const p = makePage()
  // 必须桩住 client：真实的那个单例此刻 status 还是 'idle'，而 'idle' 在本项目里的
  // 约定文案就是「未连接」（sessions 页的 statusView 一样）。从列表点进会话，
  // 前提是已经连上了，所以这里用 online 这个真实状态。
  stubClient(p, () => Promise.resolve(null))

  send(p, { t: 'ev.session_changed', sessions: [{ id: 's1', state: 'running', running: true }], reason: 'list' })
  assert.equal(p.data.running, true)
  assert.equal(p.data.barText, '主机运行中')

  send(p, { t: 'ev.session_changed', sessions: [{ id: 's1', state: 'idle', running: false }], reason: 'refresh' })
  assert.equal(p.data.running, false)
  assert.equal(p.data.barText, '空闲')
  p._stopThinkTick()
})

test('历史：刚发出去的那句话不会因为历史里也有就显示两遍', async () => {
  const p = makePage()
  stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: HISTORY_PAGE }))
  // 本地回显（宿主还没回传），紧接着历史把同一句也带回来了
  p.data.inputText = '看看这个项目的完成度'
  p.onSend()
  assert.equal(p.data.blocks.filter((b) => b.kind === 'user').length, 1)

  p._maybeLoadHistory()
  await flush()
  const said = p.data.blocks.filter((b) => b.kind === 'user' && b.text === '看看这个项目的完成度')
  assert.equal(said.length, 1, '本地回显与历史是同一句话，不能变成两遍')
  // 历史里另一句（第二轮的）照常进来
  assert.ok(
    p.data.blocks.some((b) => b.kind === 'user' && b.text === '再跑一遍测试'),
    '只该吞掉与本地上屏重复的那一条，别的用户消息要照常回放',
  )
})
