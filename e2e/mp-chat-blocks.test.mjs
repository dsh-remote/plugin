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
require(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.js'))
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
  // 两级路径：`pendingPermission.remainSec` 这种。审批卡的倒计时走的就是它，
  // 而这条 setData 是**页面自己发的**（不是测试造的），所以解析器不认就是测试坏了，
  // 不能反过来去改页面。
  const two = p.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/)
  if (two) {
    assert.ok(obj[two[1]] && typeof obj[two[1]] === 'object', `setData 路径的对象不存在: ${two[1]}`)
    obj[two[1]][two[2]] = value
    return
  }
  assert.match(p, /^[A-Za-z_$][\w$]*$/, `setData 路径没处理: ${p}`)
  obj[p] = value
}

/** 页面里的思考计时器是 setInterval，不清掉 node 不会退出 */
const live = []
after(() => {
  for (const pg of live) {
    pg._stopThinkTick()
    // 卡片倒数（审批与提问共用一条表）也是 setTimeout，不清掉 node 不会退出。
    if (pg._stopCardTick) pg._stopCardTick()
  }
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

/**
 * 跨端关弹窗在**手机端**的那三条判据。
 *
 * 为什么值得单独测：主机把"这张卡不用答了"发成了两条帧——
 * 精确的 `ev.permission_resolved` / `ev.question_resolved`（按 requestId 收一张）
 * 与粗收单的 `ev.run_state`（这一会话两张一起收）。两条都发是因为老版本手机只认后者。
 * 于是"收错张"与"两条互相打架"都是真会出现的形状，而不是理论风险。
 */
test('ev.permission_resolved 只收对得上 requestId 的那张审批卡，也不去动运行态', () => {
  const ctx = makePage()
  send(ctx, { t: 'ev.permission_request', sessionId: 's1', requestId: 'ap_1', action: 'bash', options: [{ id: 'approve', label: '允许' }] })
  assert.ok(ctx.data.pendingPermission, '夹具自检：审批卡没挂上')
  ctx.data.running = true
  // 另一张挂着的是提问卡，它不该被审批那条帧波及。
  send(ctx, { t: 'ev.question_request', sessionId: 's1', requestId: 'q_9', questions: [{ id: 'x', question: '要哪个' }] })

  send(ctx, { t: 'ev.permission_resolved', sessionId: 's1', requestId: 'ap_other', by: 'desktop' })
  assert.ok(ctx.data.pendingPermission, 'requestId 对不上却收了卡：那会把用户正在看的那张误杀')

  // 卡片挂上时那两个 `_onPermission`/`_onQuestion` 会把 running 拨成 false；这里显式摆回 true，
  // 这样下面那句"作废帧不许顺手改运行态"测的才是那条帧本身，而不是收卡时的副作用。
  ctx.data.running = true
  send(ctx, { t: 'ev.permission_resolved', sessionId: 's1', requestId: 'ap_1', by: 'desktop' })
  assert.equal(ctx.data.pendingPermission, null, '桌面先答之后手机这张审批卡还挂着')
  assert.equal(ctx.data.pendingQuestion && ctx.data.pendingQuestion.requestId, 'q_9', '审批的作废帧不该收提问那张卡')
  assert.equal(ctx.data.running, true, '作废帧不该顺手改运行态：回合在不在跑由 ev.run_state 说')
})

test('ev.question_resolved 收提问卡；主机没发这一帧时（老宿主）什么都不动', () => {
  const ctx = makePage()
  send(ctx, { t: 'ev.question_request', sessionId: 's1', requestId: 'q_1', questions: [{ id: 'x', question: '要哪个' }] })
  send(ctx, { t: 'ev.permission_request', sessionId: 's1', requestId: 'ap_5', action: 'bash' })
  send(ctx, { t: 'ev.question_resolved', sessionId: 's1', requestId: 'q_1', by: 'cancelled' })
  assert.equal(ctx.data.pendingQuestion, null, '桌面答完了而手机这张提问卡还挂着')
  assert.ok(ctx.data.pendingPermission, '提问的作废帧不该收审批那张卡')

  // 少了 requestId：只能按"当前这张"收，不能当成没发。
  send(ctx, { t: 'ev.question_request', sessionId: 's1', requestId: 'q_2', questions: [{ id: 'x', question: '要哪个' }] })
  send(ctx, { t: 'ev.question_resolved' })
  assert.equal(ctx.data.pendingQuestion, null, '没有 requestId 的作废帧必须收当前那张')
})

test('提问卡带 expiresAt 就走表；老宿主不发时不显示也不报错', () => {
  const withExpiry = makePage()
  const deadline = new Date(Date.now() + 90_000).toISOString()
  send(withExpiry, { t: 'ev.question_request', sessionId: 's1', requestId: 'q_t', expiresAt: deadline, questions: [{ id: 'x', question: '要哪个' }] })
  // tick 在 setData 之后**立刻算一次**，所以不用等一秒就能读到数字。
  assert.equal(withExpiry.data.pendingQuestion.remainSec, 90, '提问卡上有到期时刻却不走数')

  const legacy = makePage()
  send(legacy, { t: 'ev.question_request', sessionId: 's1', requestId: 'q_old', questions: [{ id: 'x', question: '要哪个' }] })
  assert.equal(legacy.data.pendingQuestion.remainSec, 0, '老宿主不发 expiresAt 时不该凭空显示一个倒计时')
  assert.equal(legacy.data.pendingQuestion.deadlineAt, 0, '没有到期时刻就不该排表')

  // 两张卡同时挂着时一条表管两张：审批那张走完不该把提问那张也带停。
  const both = makePage()
  send(both, { t: 'ev.permission_request', sessionId: 's1', requestId: 'ap_b', action: 'bash', expiresAt: new Date(Date.now() + 30_000).toISOString() })
  send(both, { t: 'ev.question_request', sessionId: 's1', requestId: 'q_b', expiresAt: new Date(Date.now() + 120_000).toISOString(), questions: [{ id: 'x', question: '要哪个' }] })
  assert.equal(both.data.pendingPermission.remainSec, 30)
  assert.equal(both.data.pendingQuestion.remainSec, 120, '两张卡共用一条表时，后挂上的那张也要有自己的数字')
})

test('ev.run_state 仍然是粗收单：两张卡一起收，并把还在走的表停掉', () => {
  const ctx = makePage()
  send(ctx, { t: 'ev.permission_request', sessionId: 's1', requestId: 'ap_c', action: 'bash', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  send(ctx, { t: 'ev.question_request', sessionId: 's1', requestId: 'q_c', questions: [{ id: 'x', question: '要哪个' }] })
  assert.ok(ctx.data.pendingPermission && ctx.data.pendingQuestion, '夹具自检：两张卡没同时挂上')
  send(ctx, { t: 'ev.run_state', sessionId: 's1', state: 'running' })
  assert.equal(ctx.data.pendingPermission, null, '粗收单那一帧失效了：老版本手机上两张卡会一直挂着')
  assert.equal(ctx.data.pendingQuestion, null)
  assert.equal(ctx._cardTimer, null, '卡片都收了而那条表还在走：它会一直 setData 到天荒地老')
})

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
  // 空块流时不插思考：那会儿还没有任何一组过程，用户看到的是刚发出去的那条指令，
  // 运行态由顶栏的中断按钮与后续落下的 live 步骤组说明。凭空在正文前面插一段
  // 「思考中」反而落单 —— 而且它会一直计时到 idle 才停
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
  // 运行态由 live 步骤组的实时标签承担，输入区上方那条独立的运行条已删。
  // ⚠️ 这里**不能**断言"必须有 live 步骤组"：本例是空块流直接来正文，
  // 从来没有落过步骤组，前提不成立。这一轮的可见信号是正文末尾的流式光标
  // 与顶栏的中断按钮。
  assert.equal('runText' in p.data, false, '不该再有 runText 字段')
  assert.notEqual(p.data.barText, '思考中…', '运行态不许占用顶栏')
  assert.ok(kinds(p).includes('text'), '正文在流，光标就是"还在动"')
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

test('空正文帧（reasoning-only 的 assistant 消息）不许留下空白块', () => {
  // 宿主里绝大多数 assistant/message 带的是 reasoning + tool-call，正文是空的；
  // 按 M28 只有 type==='text' 的分片出站，于是每一条都变成一帧 delta:'' + done:true。
  // 第一版照样给它建了一个空text 块，界面上就是一排只有 padding 的空白窄条
  // （真机截图：回复正文下面三个空壳）。这一页的主题是"看结论"，凭空三行空白更糟。
  const p = makePage()
  p.data.inputText = '跑一下'
  p.onSend()
  const before = p.data.blocks.length
  send(p, { t: 'ev.tool_event', sessionId: 's1', callId: 'c1', tool: 'Bash', phase: 'started' })
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm-empty', delta: '', done: true, role: 'assistant' })
  p._flushDelta()
  assert.equal(
    p.data.blocks.filter((b) => b.kind === 'text').length,
    0,
    '空正文不许建块：.reply 只剩 padding，屏幕上是一条什么都没有的窄条',
  )
  assert.equal(p.data.blocks.length, before + 1, '只有那条工具块该留下（步骤组默认不渲染，但数据要落）')

  // 关键：紧随其后的**带字**帧必须照常建块，不能被这一帧"用过就没了"连累。
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm-real', delta: '结论是这样。', done: true, role: 'assistant' })
  p._flushDelta()
  const texts = p.data.blocks.filter((b) => b.kind === 'text')
  assert.equal(texts.length, 1, '带正文的帧必须正常落块')
  assert.equal(texts[0].text, '结论是这样。')
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

test('折叠：实时新组默认展开（否则看不见工具列表），历史回放的组默认收起', () => {
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
  assert.equal(
    p.data.blocks[0].open,
    true,
    '实时新组默认展开 —— 只给一行"正在执行 1 个步骤"会让人以为根本没有工具列表',
  )
  assert.equal(p.data.blocks[0].items[0].open, false, '组内某一步的参数/结果仍默认收起')

  p.onToggleSteps({ currentTarget: { dataset: { idx: 0 } } })
  assert.equal(p.data.blocks[0].open, false, '点一下可以手动收起这一组')

  p.onToggleTool({ currentTarget: { dataset: { b: 0, i: 0 } } })
  assert.equal(p.data.blocks[0].items[0].open, true, '再点展开这一步的参数与完整结果')

  p.onToggleSteps({ currentTarget: { dataset: { idx: 0 } } })
  assert.equal(p.data.blocks[0].open, true, '再点一次展开回来 —— 折叠只有这一个层级')

  // 顶栏那个全局「展开过程」按钮已经删掉：折叠只有组标题一行这一个入口。
  // 留着它等于同一个动作有两个地方管，而且一键全收会把正在跑的那组也收起来。
  assert.equal(p.onToggleAll, undefined, '全局折叠处理器不该还在')
  assert.equal('expanded' in p.data, false, '全局折叠状态字段不该还留着')
  assert.equal('foldable' in p.data, false, '顶栏按钮的可见性计数不该还留着')
})

test('展开策略只对实时生效：历史回放的步骤组默认收起', () => {
  const p = makePage()
  const blocks = p._replayPage([
    { t: 'ev.tool_event', callId: 'h1', tool: 'Read', phase: 'completed', resultPreview: 'x' },
  ])
  assert.equal(blocks[0].kind, 'steps')
  assert.equal(blocks[0].open, false, '历史里的组默认收起 —— 一屏全是过程就没法读正文了')
})

test('只有 think 的组（plain）只是一行状态：不给箭头、不给卡片、耗时并进标题', () => {
  const p = makePage()
  const wxml = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'), 'utf8')

  // ⚠️ 必须先把块流填上：空流下 `_ensureThinkOpen` 故意不补组
  // （那一轮还没开始，凭空冒一条「思考中」只会落单）。
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm1', delta: '我看一下。', role: 'assistant', done: true })
  p._flushDelta()
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'running' })
  const g = stepGroups(p).at(-1)
  assert.equal(g.tools, 0, '这个组一个工具都没调')
  assert.equal(g.plain, 1, '没有工具 = 没什么可展开的，标成 plain')
  assert.match(g.label, /^思考中 \d/, `耗时并进标题，不再另起一行（读到「${g.label}」）`)

  // 渲染层：plain 那一支不绑手势、卡片带 !plain 条件
  assert.match(wxml, /wx:if="\{\{item\.plain\}\}"\s+class="steps-bar steps-bar-plain"/, 'plain 组要走没有手势的那一支')
  assert.match(wxml, /wx:else\s+class="steps-bar"\s+hover-class="pressed"[\s\S]*?bindtap="onToggleSteps"/, '可点那支只留给真有工具的组')
  assert.match(wxml, /wx:if="\{\{item\.open && !item\.plain\}\}" class="steps-card"/, 'plain 组不许渲染卡片')

  // plain 组里那条 think 依然在数据层（审批要知道主机在干什么），只是不单独渲染
  assert.ok(g.items.length > 0 && g.items[0].type === 'think', '数据层照旧落 think 条目')

  // 一旦这个组调了工具，plain 立刻归零 —— 箭头与卡片回来
  send(p, { t: 'ev.tool_event', sessionId: 's1', callId: 'c1', tool: 'Bash', phase: 'completed', resultPreview: 'ok' })
  const g2 = stepGroups(p).at(-1)
  assert.equal(g2.plain, 0, '有工具了就不再是纯状态行，折叠能力要回来')
  assert.equal(g2.label, '正在执行 1 个步骤', '标题切回工具计数')
})

test('plain 组在渲染层真的没有箭头也没有卡片（数据层判断不算数）', () => {
  const p = makePage()
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm1', delta: '我看一下。', role: 'assistant', done: true })
  p._flushDelta()
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'running' })
  const bi = p.data.blocks.length - 1
  // ⚠️ 故意把 open 设成 true：卡片那一支已经带 !item.plain，
  // 光看 open=false 证明不了任何事 —— 那正是"按住开关再检查它"。
  p.setData({ ['blocks[' + bi + '].open']: true })
  const again = stepGroups(p).at(-1)
  assert.equal(again.open, true, '前提：open 确实是 true')
  assert.equal(again.plain, 1, '前提：这仍是 plain 组')
  assert.match(fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'), 'utf8'), /item\.open && !item\.plain/)
})

test('过程窗口：组内自动滚到组尾，但只有还在跑的组才给 -- 跑完的组不许拽人', () => {
  const p = makePage()
  // 起跑：run_state 让 _ensureThinkOpen 建一个组并补思考段
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'running' })
  send(p, {
    t: 'ev.tool_event',
    sessionId: 's1',
    callId: 'c1',
    tool: 'Bash',
    phase: 'started',
  })
  const g = p.data.blocks[0]
  assert.equal(g.live, true, '工具还在跑')
  assert.equal(g.tailId, 's' + g.items[g.items.length - 1].key, 'live 组的尾巴要给 tailId')

  // 收尾 + 这一轮结束：组不再 live，tailId 必须清空 —— 否则用户回看老组时
  // 每来一条新内容就被拽回组尾，读不了
  send(p, {
    t: 'ev.tool_event',
    sessionId: 's1',
    callId: 'c1',
    tool: 'Bash',
    phase: 'completed',
    resultPreview: 'ok',
  })
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'idle' })
  const done = p.data.blocks[0]
  assert.equal(done.live, false, '这一轮结束了')
  assert.equal(done.tailId, '', '跑完的组不许再自动滚')
  p._stopThinkTick()
})

test('「回到最新」的锚点必须是两个静态 id；过程窗口必须限高且用 scroll-view', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxss'), 'utf8')

  // 锚点曾写成 <view id="{{toView}}"> —— 同一个元素跟着 toView 改名。那要赌
  // "元素改名"与"scroll-into-view 生效"谁先落到渲染层上，赌输了 scroll-view 会
  // 查不到目标节点、**静默不滚**（不报错、不重试）。「回到最新」点了没反应就是这么来的。
  assert.match(wxml, /id="anchor-a"/, '需要第一个静态锚点')
  assert.match(wxml, /id="anchor-b"/, '需要第二个静态锚点')
  assert.ok(!/id="\{\{toView\}\}"/.test(wxml), '锚点 id 不许跟着 toView 变')

  // 过程窗口：限高 + 组内滚动。小程序里 view 的 overflow:auto 在**真机上不生效**，
  // 要滚只能用 scroll-view —— 写成 CSS overflow 会在开发者工具里"看起来能滚"。
  const card = wxml.slice(wxml.indexOf('class="steps-card"'), wxml.indexOf('</scroll-view>'))
  assert.match(card, /class="steps-scroll"/, '过程内容要包在限高容器里')
  assert.match(card, /scroll-y/, '限高容器必须是 scroll-view，否则真机不滚')
  assert.match(card, /scroll-into-view="\{\{item\.tailId\}\}"/, '要滚到组尾那一条')
  assert.match(card, /id="s\{\{it\.key\}\}"/, '每条要有落点 id，否则 scroll-into-view 无处可去')
  assert.match(wxss, /\.steps-scroll\s*\{[^}]*max-height/, '限高要写在 .steps-scroll 上')
})

// ── 过程显示（SHOW_STEPS = true），但仍是数据层与渲染层分开 ────────────

test('过程块渲染，但开关仍然独立于落块逻辑', () => {
  const p = makePage()
  assert.equal(p.data.showSteps, true, '过程要放出来：收起时是一行摘要，展开看细节')

  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'running' })
  send(p, { t: 'ev.tool_event', sessionId: 's1', callId: 'c1', tool: 'Bash', phase: 'started' })
  send(p, {
    t: 'ev.tool_event',
    sessionId: 's1',
    callId: 'c1',
    tool: 'Bash',
    phase: 'completed',
    resultPreview: 'ok',
  })

  // 数据层：一个步骤组必须在，且收尾帧要能按 callId 找到原来那条并更新它。
  // 这条与 showSteps 无关 —— 关掉渲染也不能坏，否则审批看不到主机在调什么。
  const g = p.data.blocks.find((b) => b.kind === 'steps')
  assert.ok(g, '审批要知道主机在调什么，回放要对得上 callId')
  const tool = g.items.find((it) => it.callId === 'c1')
  assert.equal(tool.phase, 'completed', '同一次调用的收尾帧要更新到原来那条，不能新开一组')
  assert.equal(tool.result, 'ok')

  // 渲染层：wxml 里那一支仍由 showSteps 门住（一个常量就能整体关掉）
  const wxml = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'), 'utf8')
  assert.match(
    wxml,
    /wx:if="\{\{item\.kind === 'steps' && showSteps\}\}"/,
    '过程块要用独立的 wx:if 挂 showSteps',
  )
  assert.ok(
    !/wx:elif="\{\{item\.kind === 'steps'/.test(wxml),
    '不能写成 wx:elif：条件为假会落到末尾的 else，把每个步骤组变成一个空提示条',
  )
  assert.ok(
    !/<view\s+wx:else\s+class="note"/.test(wxml),
    'note 分支要写明 kind 条件，裸 else 会接住所有没匹配上的块',
  )
  assert.match(wxml, /wx:if="\{\{item\.kind === 'note'\}\}"/, 'note 要显式写条件')
  // 顶栏只有「连接状态 + 模型 + 中断」；全局折叠按钮已删，折叠由每个组标题自己管。
  assert.doesNotMatch(wxml, /onToggleAll|foldable|expanded/, 'wxml 里不许再有全局折叠的入口')
  assert.doesNotMatch(
    fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxss'), 'utf8'),
    /\.bar-btn/,
    '删掉按钮就要删掉它的样式，留着会让下一个人以为还有别的胶囊按钮',
  )
})

test('运行态不再单独占一行：没有 runText，也没有 runbar，信号落在 live 步骤组上', () => {
  const p = makePage()
  stubClient(p, () => Promise.resolve(null))
  const wxml = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxss'), 'utf8')

  assert.equal('runText' in p.data, false, '输入区上方那条运行条已删，字段也不该留')
  assert.doesNotMatch(wxml, /runbar|runText/, 'wxml 里不许再有运行条')
  assert.doesNotMatch(wxss, /\.runbar|\.jump-up/, 'wxss 里不许再有运行条与它的让位偏移')

  // 先发一条，让真的落一个步骤组出来 —— 空块流下没有组可谈，
  // 在那种前提下断言"必须有 live 组"是判据自己写错了。
  p.data.inputText = '跑一下测试'
  p.onSend()
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'running' })

  assert.equal(p.data.barText, '已连接', '顶栏只回答「连上了吗」')
  assert.equal(p.data.barTheme, 'success')
  assert.ok(!wxml.includes('{{barText}}思考'), '顶栏不得再拿 barText 拼运行态')

  const live = p.data.blocks.filter((b) => b.kind === 'steps' && b.live)
  assert.ok(live.length > 0, '运行中要有 live 步骤组')
  assert.match(live[0].label, /^思考中 \d/, `live 组的标签就是"它还在动"这句话，且带上耗时（读到「${live[0].label}」）`)
  assert.match(wxml, /class="steps-label \{\{item\.live \? 'live' : ''\}\}"/, 'live 标签是运行态的可见信号')

  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'idle' })
  assert.equal(p.data.barText, '已连接', '顶栏不受运行态影响')
  assert.equal(
    p.data.blocks.filter((b) => b.kind === 'steps' && b.live).length,
    0,
    '跑完就没有 live 组了，运行态不能一直挂着',
  )
})

test('顶栏断开时说「未连接」而不是「空闲」', () => {
  const p = makePage()
  p.client = Object.assign({}, p.client, { status: 'error', statusText: '连接失败' })
  p._renderBar()
  assert.equal(p.data.barText, '连接失败')
  assert.equal(p.data.barTheme, 'danger')
})

test('折叠只有组标题一个入口：纯思考的组（plain）连这个入口都没有', () => {
  const p = makePage()
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'running' })
  send(p, { t: 'ev.tool_event', sessionId: 's1', callId: 'c1', tool: 'Bash', phase: 'completed' })
  const g = stepGroups(p).at(-1)
  assert.equal(g.tools, 1, '有工具调用的组可以展开')
  assert.equal(g.plain, 0, '有工具就不是纯状态行，组标题那行可点')

  // 折叠只有一层：组标题。组内某一步的参数/结果再点一次才展开。
  assert.equal(typeof p.onToggleSteps, 'function', '组标题可点开/收起')
  assert.equal(typeof p.onToggleTool, 'function', '组内某一步可点开参数与结果')
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

// ⚠️ 2026-10-04 改判：旧断言写的是「历史加载不该动滚动锚点」，理由「首屏进来时
// 本来就该停在最新的位置」——**那个前提是假的**。第一页历史也走了 noScroll，而
// onReady 之后没有任何东西把视口推到底：automator 实测打开会话 scrollTop=0，
// 用户每次都要自己滚一遍（真机报「自动滚动有点问题」的一半）。现在：第一页
// 必须翻锚点（= 落底），往前插更早内容才不许翻。
test('历史：第一页落底，往前插更早内容静默（不该被甩走）', async () => {
  const p = makePage()
  p.onReady()
  stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: HISTORY_PAGE, nextBeforeSeq: 4 }))
  p._maybeLoadHistory()
  await flush()
  assert.equal(p.data.toView, 'anchor-b', '第一页带的就是最新内容：必须翻一次锚点 = 落底')
  // 往前插更早内容：**不许翻锚点**（翻了就是跟底），但要把原来第一块滚回视口——
  // 那是另一套机制（toView 指到内容锚点 b<key>，不是 anchor-a/b 那两个尾锚点）。
  const beforeFlip = p._flip
  p._loadHistory(4)
  await flush()
  assert.equal(p._flip, beforeFlip, '往前插更早内容不许翻尾锚点——那会把用户从刚读的位置甩走')
  assert.match(p.data.toView, /^b/, '翻页拼完要把原来第一块滚回视口（内容锚点）')
})

test('历史头的文案不许自相矛盾（这类缺陷只有截图看得见，所以用断言补一道闸）', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'), 'utf8')
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

test('列表里这条会话正在跑时，页面上要看得见（从列表点进运行中的会话，原来毫无动静）', () => {
  const p = makePage()
  // 必须桩住 client：真实的那个单例此刻 status 还是 'idle'，而 'idle' 在本项目里的
  // 约定文案就是「未连接」（sessions 页的 statusView 一样）。从列表点进会话，
  // 前提是已经连上了，所以这里用 online 这个真实状态。
  stubClient(p, () => Promise.resolve(null))
  const wxml = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'), 'utf8')

  send(p, { t: 'ev.session_changed', sessions: [{ id: 's1', state: 'running', running: true }], reason: 'list' })
  assert.equal(p.data.running, true)
  // 刚点进会话时正文是空的，还没有步骤组 —— 运行态这时唯一的落点是顶栏的中断按钮。
  // 判据要认这一条：断言"必须有 live 步骤组"在这里是错的，前提不成立。
  assert.match(wxml, /wx:if="\{\{running\}\}"\s*\n?\s*class="bar-stop"/, '运行中要在顶栏给出中断按钮')
  assert.deepEqual(kinds(p), [], '空流不该凭空插一段过程')

  send(p, { t: 'ev.session_changed', sessions: [{ id: 's1', state: 'idle', running: false }], reason: 'refresh' })
  assert.equal(p.data.running, false)
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

// ── 模型 ────────────────────────────────────────────────────────────

test('模型：ev.model 到达后显示模型名，且这一帧不该被"不是本会话"过滤掉', () => {
  const p = makePage()
  send(p, { t: 'ev.model', model: 'deepseek-chat', provider: 'deepseek', canSwitch: false, reason: '主机内核只提供读取' })

  assert.equal(p.data.modelName, 'deepseek-chat')

  p._stopThinkTick()
})

test('模型：超长名字在这一层就截断，界面层不再自己判断', () => {
  const p = makePage()
  const long = 'a-very-long-model-name-that-will-not-fit-in-the-bar'
  send(p, { t: 'ev.model', model: long, canSwitch: false })

  assert.notEqual(p.data.modelName, long, '不该把整串塞进顶栏')
  assert.ok(p.data.modelName.endsWith('…'), '截断要有省略号，否则看不出被截了')
  assert.ok(p.data.modelName.length <= 22, `截断后仍太长: ${p.data.modelName.length}`)

  p._stopThinkTick()
})

test('模型：只读，不留任何切换入口（canSwitch/options 相关的字段与处理器都不许存在）', () => {
  const p = makePage()
  send(p, {
    t: 'ev.model',
    model: 'deepseek-chat',
    canSwitch: true,
    options: [
      { value: 'deepseek-chat', label: 'DeepSeek Chat' },
      { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
    ],
  })

  // 主机内核实测 modelFace = no-list+no-set，切不了。留一个"点了会弹空列表"的
  // 入口，比没有这个入口更像坏了；留着没人读的字段，下一个人会以为只是没接上。
  assert.equal(p.data.modelName, 'deepseek-chat', '只显示名字')
  assert.equal('canSwitchModel' in p.data, false, '不该留 canSwitch 字段')
  assert.equal('modelOptions' in p.data, false, '不该留 options 字段')
  assert.equal(typeof p.onModelTap, 'undefined', '不该有模型点击处理器')
  assert.equal(typeof p.onModelPick, 'undefined', '不该有候选选择处理器')

  const wxml = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'), 'utf8')
  assert.doesNotMatch(wxml, /bindtap="onModel/, 'wxml 里不许还绑着模型的手势')
  assert.doesNotMatch(wxml, /modelPanelOpen/, '候选面板已经删掉')
  assert.match(wxml, /class="bar-model[^"]*"[^>]*>\{\{modelName\}\}/, '模型名在顶栏里弱化显示')

  p._stopThinkTick()
})

test('模型：ev.model 不带 sessionId，不能被会话过滤误丢', () => {
  const p = makePage()
  // 会话 id 对不上——如果实现里把这条帧放在「不是本会话就 return」之后，
  // 模型名就永远不显示，而单测会以为是自己造的数据不对。
  send(p, { t: 'ev.model', sessionId: 'another-session', model: 'deepseek-chat', canSwitch: false })
  assert.equal(p.data.modelName, 'deepseek-chat', '模型是全局的，不该被会话 id 拦掉')

  p._stopThinkTick()
})

// ── 审批卡：本地倒计时 ──────────────────────────────────────────────

test('审批：expiresAt 换算成剩余秒数并逐秒往下走', () => {
  const p = makePage()
  const expires = new Date(Date.now() + 180_000).toISOString()
  send(p, {
    t: 'ev.permission_request',
    sessionId: 's1',
    requestId: 'rq1',
    action: 'Bash',
    options: [
      { id: 'approve', label: '允许一次' },
      { id: 'reject', label: '拒绝' },
    ],
    expiresAt: expires,
  })

  const perm = p.data.pendingPermission
  assert.ok(perm, '审批卡应出现')
  assert.equal(perm.requestId, 'rq1')
  assert.equal(perm.options.length, 2)
  assert.ok(perm.deadlineAt > Date.now(), 'deadlineAt 应是将来的时刻')

  // _onPermission 已经起过表；剩余应立刻可见（不能等一秒才显示）
  assert.ok(perm.remainSec > 0 && perm.remainSec <= 180, `剩余秒数不对: ${perm.remainSec}`)

  p._stopCardTick()
  p._stopThinkTick()
})

test('审批：没有 expiresAt 就不倒计时（不能自己编一个 180 秒出来）', () => {
  const p = makePage()
  send(p, { t: 'ev.permission_request', sessionId: 's1', requestId: 'rq1', action: 'Bash' })

  const perm = p.data.pendingPermission
  assert.equal(perm.deadlineAt, 0, '主机没给期限就不许显示倒计时')
  assert.equal(perm.remainSec, 0, '没有期限就没有剩余秒数')

  p._stopThinkTick()
})

test('审批：点了按钮就回传逐字的 option id，并停掉那个还在走的表', () => {
  const p = makePage()
  const sent = []
  p.client = { resolvePermission: (...a) => sent.push(a), interrupt() {} }
  send(p, {
    t: 'ev.permission_request',
    sessionId: 's1',
    requestId: 'rq1',
    action: 'Bash',
    options: [
      { id: 'approve', label: '允许一次' },
      { id: 'reject', label: '拒绝' },
    ],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })

  p.onPermissionTap({ currentTarget: { dataset: { decision: 'approve' } } })
  assert.equal(p.data.pendingPermission, null, '回了就该把卡撤掉')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], ['s1', 'rq1', 'approve'], 'requestId 与 option id 必须逐字回传')
  assert.equal(p._cardTimer, null, '表必须停，否则它会一直 setData')

  p._stopThinkTick()
})

test('审批：ev.run_state 收走挂着的审批卡时，倒计时也一起停', () => {
  const p = makePage()
  send(p, {
    t: 'ev.permission_request',
    sessionId: 's1',
    requestId: 'rq1',
    action: 'Bash',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  assert.ok(p.data.pendingPermission)

  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'running' })
  assert.equal(p.data.pendingPermission, null, '运行态一恢复，挂着的审批就作废')
  assert.equal(p._cardTimer, null, '作废的卡不该还留着一个在走的表')

  p._stopThinkTick()
})

test('审批：页面隐藏时倒计时停表（定时器必须与撤销成对）', () => {
  const p = makePage()
  send(p, {
    t: 'ev.permission_request',
    sessionId: 's1',
    requestId: 'rq1',
    action: 'Bash',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  p.onHide()
  assert.equal(p._cardTimer, null)

  p._stopThinkTick()
})

// ── Markdown 渲染（流式）────────────────────────────────────────────────
//
// 落在这一层而不是只测 core/markdown.js：那一层证明"转换是对的"，
// 这一层证明"**页面真的把它渲染出来了**" —— data 层对了而 wxml 没接上，
// 界面上还是纯文本（这正是上一轮"账本对了界面还错"的同类）。
//
// ⚠️ 判据读的是 **setData 之后的 data**，不是页面内部变量：那是渲染层能拿到的。

/** 页面当前 text 块上的 markdown 字段 */
function mdOf(p) {
  const b = p.data.blocks.find((x) => x.kind === 'text')
  assert.ok(b, '没有 text 块')
  return b
}

/**
 * **渲染层真正会拿去 `nodes` 的那份**：`data.mdBodies[块key]`。
 *
 * ⚠️ 别改成读 `blocks[i]._md`：那是 JS 侧的中间量，wxml 拿不到。
 * `rich-text` 的 `nodes` 绑 `wx:for` 作用域里的变量会渲染成**高度 0 的空块**
 * （正文整段消失，而 data 全绿），所以 `_commit` 把它收进顶层 map、
 * wxml 按 `item.key` 取 —— 那份 map 就是这一层该断言的对象。
 */
function mdNodes(p) {
  const b = mdOf(p)
  const map = p.data.mdBodies || {}
  const nodes = map[b.key]
  assert.ok(nodes, `mdBodies 里没有块 ${b.key}（keys=${Object.keys(map)}）—— wxml 会走纯文本那一支`)
  return nodes
}

/** 从 nodes 里取出所有文字（表格现在留在原地，直接递归即可） */
function mdText(p) {
  const txt = (x) => {
    if (x == null) return ''
    if (Array.isArray(x)) return x.map(txt).join('')
    if (x.type === 'text') return x.text
    return txt(x.children || [])
  }
  return txt(mdNodes(p)) + (mdOf(p).mdPending || '')
}

test('正文在流的时候就按 Markdown 排版（不是等 done 才切）', () => {
  // 反证：把 `_withMd` 改成 `if (!b.done) return b`（流式期不渲染）→ 这条红。
  const p = makePage()
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm1', delta: '这是**重点**结论' })
  p._flushDelta()
  const b = mdOf(p)
  assert.equal(b.done, false, '本例还没 done')
  assert.ok(mdNodes(p).length > 0, '还没 done 就该有排好版的 nodes —— 否则流式期是纯文本')
  assert.equal(mdText(p), '这是重点结论', 'md 渲染出来的文字不对：' + JSON.stringify(mdText(p)))
})

test('未闭合的标记被暂扣住，闭合那帧才补上样式（跳变的根因）', () => {
  // 反证：让 `_withMd` 走非流式分支（渲染全文不暂扣）→ 这条红
  //（第 2 帧显示的文字会从"a 粗体"退成"a *粗体"，内容字相同、标记少一个）。
  const p = makePage()
  const feed = (delta) => {
    send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm1', delta })
    p._flushDelta()
  }
  feed('这是**重点')
  assert.ok(
    (mdOf(p).mdPending || '').includes('**'),
    '未闭合的 ** 该被暂扣（pending=' + JSON.stringify(mdOf(p).mdPending) + '）'
  )
  // 关键：内容字已经出现在屏幕上了（暂扣区只是标记符号）
  assert.ok(mdText(p).includes('重点'), '内容字应该已经显示：' + JSON.stringify(mdText(p)))

  feed('**结论')
  const b = mdOf(p)
  assert.equal(b.mdPending || '', '', '闭合后不该还有暂扣（pending=' + JSON.stringify(b.mdPending) + '）')
  assert.equal(mdText(p), '这是重点结论')
})

test('done 之后暂扣区必须为空、且与一次性渲染完全一致', () => {
  // 反证：让 done 分支也走 renderStream 并把 pending 原样透出 → 这条红。
  const p = makePage()
  send(p, {
    t: 'ev.message_delta',
    sessionId: 's1',
    messageId: 'm1',
    delta: '段落\n\n```js\nconst a=1\n```\n',
    done: true,
    role: 'assistant',
  })
  p._flushDelta()
  const b = mdOf(p)
  assert.equal(b.done, true)
  assert.equal(b.mdPending || '', '', 'done 后还有暂扣内容：' + JSON.stringify(b.mdPending))
  // 围栏代码块的内容要真的在
  assert.ok(mdText(p).includes('const a=1'), '代码块内容没渲染出来：' + JSON.stringify(mdText(p)))
  // 且不能把标记符号漏进屏幕
  assert.ok(!mdText(p).includes('```'), '围栏标记漏进输出了：' + JSON.stringify(mdText(p)))
})

test('表格留在 nodes 里（不再摘出去），列宽按容器百分比', () => {
  // 反证：让 `_withMd` 改回 `splitTables` → 下面「占位符数为 0」那条红。
  // 而它红的原因不是难看，是**表格在界面上会整块消失**：占位符 `{__table:i}`
  // 不是合法节点，而摘出去那条路要 wxml 两层索引 → `rich-text` 渲染成 0 高度。
  const p = makePage()
  send(p, {
    t: 'ev.message_delta',
    sessionId: 's1',
    messageId: 'm1',
    delta: '| 列A | 列B | 列C |\n| --- | --- | --- |\n| 一 | 二 | 三 |\n',
    done: true,
    role: 'assistant',
  })
  p._flushDelta()
  const nodes = mdNodes(p)
  const table = nodes.find((n) => n && n.name === 'table')
  assert.ok(table, '表格该留在 nodes 里（nodes=' + JSON.stringify(nodes) + '）')
  assert.equal(
    nodes.filter((n) => n && n.__table !== undefined).length,
    0,
    '不该再有 {__table:i} 占位 —— 占位符不是合法节点，渲染时内容会凭空消失'
  )
  // 摘出去那条路的判据：`mdTables` 这个顶层 map 不该再被 `_commit` 产出
  assert.equal(p.data.mdTables, undefined, 'mdTables 已不再使用（表格不摘出去）')
  // 列宽必须是百分比而不是固定 rpx：固定 240rpx × 3 列在 334px 正文里必然溢出
  assert.match(table.attrs.style, /width:\s*100%/, '表格应占满容器宽：' + table.attrs.style)
  const th = table.children[0].children[0].children.filter((n) => n.name === 'th')
  for (const c of th) assert.match(c.attrs.style, /width:\s*33\.3333%/, '每列应平分宽度：' + c.attrs.style)
})

test('多块正文各自一份 nodes，按块 key 分开（wxml 靠 key 取，不能串）', () => {
  // 反证：`_commit` 改成只留最后一块（`bodies[最后一块key] = …`）→ 这条红。
  const p = makePage()
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm1', delta: '第一段。', done: true })
  p._flushDelta()
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm2', delta: '第二段。', done: true })
  p._flushDelta()

  const keys = Object.keys(p.data.mdBodies)
  assert.equal(keys.length, 2, `两个 text 块都该有 nodes，实际 keys=${JSON.stringify(keys)}`)
  const b0 = p.data.blocks.find((x) => x.kind === 'text' && x.msgId === 'm1')
  const b1 = p.data.blocks.find((x) => x.kind === 'text' && x.msgId === 'm2')
  assert.deepEqual(keys.slice().sort(), [b0.key, b1.key].sort(), 'map 的键要与块的 key 一致')
  // 而且两份内容不许串：key 对不上就是一段内容显示在另一段的位置上
  assert.ok(mdText({ data: { blocks: [b0], mdBodies: p.data.mdBodies } }) === '第一段。', 'm1 的 nodes 不对')
  assert.ok(mdText({ data: { blocks: [b1], mdBodies: p.data.mdBodies } }) === '第二段。', 'm2 的 nodes 不对')
})

/* ── 滚动：贴底跟滚 / 回看停跟 / 回到最新之后照跟 ─────────────────────
   2026-10-04 用户报：点位在最新时要自动跟滚，回到最新之后也要。
   踩过两个坑：① 第一页历史也走 noScroll，打开会话停在最旧处；
   ② onScroll 拿 deltaY<0 一刀切，iOS 落底回弹的尾帧把刚接上的跟随关掉。 */

/** 让页面以为自己贴在最底部：onReady 里那个 SelectorQuery 的假实现给 600。 */
function readyAtBottom() {
  const p = makePage()
  p.onReady()
  return p
}

/** 一次真实的贴底滚动帧：内容 2000 高、视口 600，scrollTop 停在 1376 就是贴底。 */
function bottomFrame() {
  return { detail: { scrollLeft: 0, scrollTop: 1376, scrollHeight: 2000, deltaY: 10 } }
}

test('滚动：贴底时新内容要跟滚（toView 每提交翻一次面）', () => {
  const p = readyAtBottom()
  assert.equal(p._autoScroll, true, '初始就该是跟随态')
  assert.equal(p.data.toView, 'anchor-a', '夹具自检：起始锚点')
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm-r1', delta: '新内容。', role: 'assistant', done: true })
  p._flushDelta()
  assert.equal(p.data.toView, 'anchor-b', '贴底时的提交必须翻锚点 = 要求滚到底')
  // 再一条继续翻：sc-into-view 只在值变化时生效，不翻面就是静默不滚
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm-r2', delta: '再一条。', role: 'assistant', done: true })
  p._flushDelta()
  assert.equal(p.data.toView, 'anchor-a', '第二次提交要翻回另一颗锚点')
})

test('滚动：往上回看立即停跟随，之后的 delta 不许把人拽回去', () => {
  const p = readyAtBottom()
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm-r1', delta: '第一条。', role: 'assistant', done: true })
  p._flushDelta()
  // 用户在底部附近开始往上拖：位置还在 24px 容差里，但 deltaY 是负的
  p.onScroll({ detail: { scrollLeft: 0, scrollTop: 1340, scrollHeight: 2000, deltaY: -36 } })
  assert.equal(p._autoScroll, false, '往上拖就要停：容差内下一帧内容会把他拽回去')
  assert.equal(p.data.atBottom, false, '停了跟随，按钮要浮出来')
  const before = p.data.toView
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm-r2', delta: '回看期间到达。', role: 'assistant', done: true })
  p._flushDelta()
  assert.equal(p.data.toView, before, '不跟随时提交不许翻锚点')
})

test('滚动：回到最新之后，落底回弹的负帧不许把跟随关掉（用户报的点）', () => {
  const p = readyAtBottom()
  p.onScroll({ detail: { scrollLeft: 0, scrollTop: 1340, scrollHeight: 2000, deltaY: -36 } })
  assert.equal(p._autoScroll, false, '夹具自检：先处于回看态')
  p.onJumpLatest()
  assert.equal(p._autoScroll, true, '点了回到最新就该接上跟随')
  // iOS 上 scroll-into-view 落底有回弹：尾帧 deltaY 为负、位置在底部
  p.onScroll({ detail: { scrollLeft: 0, scrollTop: 1379, scrollHeight: 2000, deltaY: -3 } })
  assert.equal(p._autoScroll, true, '回弹帧不是拖动：关掉它，后续 delta 就再也不跟了')
  assert.equal(p.data.atBottom, true, '位置本来就在底部，按钮不该重新浮出来')
  // 窗口（600ms）过后，真实的往上拖照旧停跟随
  return new Promise((resolve) =>
    setTimeout(() => {
      p.onScroll({ detail: { scrollLeft: 0, scrollTop: 1200, scrollHeight: 2000, deltaY: -60 } })
      assert.equal(p._autoScroll, false, '窗口过期后负 delta 恢复本义：停跟随')
      resolve()
    }, 650),
  )
})


