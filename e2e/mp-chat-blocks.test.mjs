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
  // 剪贴板：真 API 的成功回调是异步的，这里同步回，判据等得起
  setClipboardData: (opts) => {
    globalThis.__drcClipboard = String(opts.data || '')
    opts.success && opts.success({})
  },
  // 剪贴板：真 API 的成功回调是异步的，这里同步回，判据等得起
  setClipboardData: (opts) => {
    globalThis.__drcClipboard = String(opts.data || '')
    opts.success && opts.success({})
  },
  // 加号弹的选择：图片 / 文件。默认回第 0 项（图片），判据想测文件就改 __drcSheetTap
  showActionSheet: (opts) => {
    globalThis.__drcSheetItems = (opts.itemList || []).slice()
    var tap = globalThis.__drcSheetTap === undefined ? 0 : globalThis.__drcSheetTap
    if (tap < 0 || tap >= (opts.itemList || []).length) return
    opts.success && opts.success({ tapIndex: tap })
  },
  showToast: () => {},
  // 取消在跑的那条要先问一句（2026-10-05 傍晚重做）。夹具记下弹了什么，
  // 判据据此断言确认框写明这是中断、以及没点确认就不发给主机。
  showModal: function (o) { globalThis.__drcModal = o },
  vibrateLong: () => {},
  vibrateShort: () => {},
  hideKeyboard: () => {},
  // ── 图片附件那一链（附件功能的判据要走真路径，所以给真返回值）──────────
  // 字段名必须与真 API 一致：chooseMedia 给的是 **tempFilePath**。
  // 2026-10-05 之前这里写成 `path`，页面读 f.path 读不出来而单测一路绿灯——
  // 分叉的假实现比没有假实现更糟。尺寸与路径都按用例改（__drcPick / attachPick）。
  chooseMedia: (opts) =>
    opts.success({
      tempFiles: [attachPick()],
    }),
  // ── 文件附件那一链 ──────────────────────────────────────────────────
  // ⚠️ 这条夹具**必须照官方类型定义 `ChooseFile` 的字段名写，不能照上一条抄**：
  //   1. chooseMessageFile 给的路径字段叫 `path`，它**没有** `tempFilePath`；
  //   2. `type` 是 `'video' | 'image' | 'file'` 的**类别**，不是扩展名。
  // 2026-10-06 这两处都抄成了 chooseMedia 的形状，于是页面读 f.tempFilePath 恒为
  // undefined（"每个文件都读不出来"），而判据一路绿灯——真机上必现的故障被判成了通过。
  // 假实现与实现同源出错比没有假实现更糟：它连"测的到底是哪条路径"都不再说得清。
  chooseMessageFile: (opts) =>
    opts.success({
      tempFiles: [filePick()],
    }),
  // 真 API 只认 chooseMedia 给的那个路径：把它记下来，判据直接断言
  // "压的就是选中的那张"。src 为空时按真 API 的形状失败。
  compressImage: (opts) => {
    if (!opts.src) return opts.fail && opts.fail({ errMsg: 'compressImage:fail: empty src' })
    globalThis.__drcCompressSrc = opts.src
    return opts.success({ tempFilePath: `tmp-compressed-${++attachSeq}.jpg` })
  },
  // 尺寸：按用例给（缩图判据要的是一张 3000px 的大图 / 一张 800px 的截图）。
  getImageInfo: (opts) => {
    if (!opts.src) return opts.fail && opts.fail({ errMsg: 'getImageInfo:fail' })
    const picked = globalThis.__drcPick || {}
    return opts.success({ width: picked.width || 1600, height: picked.height || 1200 })
  },
  getFileSystemManager: () => ({
    readFile: (opts) =>
      opts.success({
        data: (globalThis.__drcFileBytes && globalThis.__drcFileBytes[opts.filePath]) ||
          Buffer.from('JPEGBYTES').toString('base64'),
      }),
  }),
  downloadFile: (opts) =>
    opts.success({ statusCode: 200, tempFilePath: globalThis.__drcDownloaded || '' }),
  // 画布那一链：两平台都算数的那一步（Android 上 compressImage 的 quality 被忽略）。
  //
  // ⚠️ `exec` 的回调**必须异步**（`setTimeout(...,0)`）：真机上是逻辑层→渲染层一个
  // 来回，同步回调会把"紧接 exec() 读结果"这条错路掩盖掉 —— 页面旧实现就是这么把
  // null 缓存进 `_canvasNode`、整页生命周期一次都没缩过图，而判据全绿。
  // `boundingClientRect(cb)` 的回调仍按老夹具同步给（量视口高度那条路与本页判据的
  // 时序无关，保持既有用例确定性）；要验的异步是 **exec 这一层**。
  createSelectorQuery: () => {
    const q = {
      _fields: false,
      select: () => q,
      boundingClientRect: (cb) => {
        if (cb) cb({ height: 600 })
        return q
      },
      fields: () => {
        q._fields = true
        return q
      },
      exec: (cb) => {
        const res = q._fields ? [{ node: fakeCanvasNode() }] : [{ height: 600 }]
        setTimeout(() => {
          if (cb) cb(res)
        }, 0)
      },
    }
    return q
  },
  canvasToTempFilePath: (opts) => {
    const c = opts.canvas
    globalThis.__drcShrunk = {
      w: c && c.width,
      h: c && c.height,
      quality: opts.quality,
      fileType: opts.fileType,
    }
    return opts.success({ tempFilePath: `tmp-shrunk-${++attachSeq}.jpg` })
  },
  showToast: () => {},
  // 取消在跑的那条要先问一句（2026-10-05 傍晚重做）。夹具记下弹了什么，
  // 判据据此断言确认框写明这是中断、以及没点确认就不发给主机。
  showModal: function (o) { globalThis.__drcModal = o },
}

/** 假 canvas 节点：createImage / getContext / drawImage 的形状与真 API 对齐。 */
function fakeCanvasNode() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    createImage: () => {
      const img = {}
      // 赋值 src 的下一拍就 onload：真机上也是异步的，判据里 settleAttach 等得起。
      setTimeout(() => {
        if (img.onload) img.onload()
      }, 0)
      return img
    },
  }
}

// 每张压出来的图给一个不同的临时路径：真实世界里 compressImage 也不会两张都叫同一个名。
let attachSeq = 0

/** 选中图片后 chooseMedia 回的那一条。路径必须是 tempFilePath。 */
let attachPick = () => ({
  tempFilePath: 'tmp-picked.jpg',
  size: 12345,
  width: 1600,
  height: 1200,
})

/**
 * 选中文件后 chooseMessageFile 回的那一条。
 *
 * 字段与取值**逐字照官方类型定义 `miniprogram-api-typings` 的 `ChooseFile`**：
 *   { name: string; path: string; size: number; time: number; type: 'video'|'image'|'file' }
 * `type` 是类别不是扩展名（一条判据专门钉住这一点），路径字段叫 `path`。
 */
let filePick = () =>
  globalThis.__drcPickFile
    ? globalThis.__drcPickFile()
    : {
        name: 'report.pdf',
        path: 'tmp-file.pdf',
        size: 2048,
        time: 1_700_000_000_000,
        type: 'file',
      }

// 选文件时 readFile 回的内容（判据断言的是"原样读进来、不改一个字节"）。
globalThis.__drcFileBytes = {
  'tmp-file.pdf': Buffer.from('FILEDATA').toString('base64'),
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
  // 整块替换：blocks[1] = {...}（思考计时器整组重派生走的就是它）。
  // 没有这一条，跑得稍慢的机器上计时器的 tick 会落进隔壁用例，报一个
  // 「路径没处理」的假失败——页面发的形状合法，是夹具跟不上。
  const whole = p.match(/^([A-Za-z_$][\w$]*)\[(\d+)\]$/)
  if (whole) {
    obj[whole[1]][Number(whole[2])] = value
    return
  }
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
  // 加号选择的归零：不归零的话，上一条用例选了"文件"，下一条用例点加号
  // 也会进文件链——两个用例都莫名失败（本次真实踩到）。
  globalThis.__drcSheetTap = 0
  globalThis.__drcDropped = []
  globalThis.__drcDropFail = ''
  globalThis.__drcSheetItems = undefined
  // 选中文件的覆写同样必须归零：它决定 chooseMessageFile 回什么形状，漏一条就会让
  // 后面**看起来不相关**的用例拿到上一条的文件名（本次真实踩到）。
  globalThis.__drcPickFile = null
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


test('ev.run_state 回到 idle 才是粗收单：两张卡一起收，并把还在走的表停掉', () => {
  const ctx = makePage()
  send(ctx, { t: 'ev.permission_request', sessionId: 's1', requestId: 'ap_c', action: 'bash', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  send(ctx, { t: 'ev.question_request', sessionId: 's1', requestId: 'q_c', questions: [{ id: 'x', question: '要哪个' }] })
  assert.ok(ctx.data.pendingPermission && ctx.data.pendingQuestion, '夹具自检：两张卡没同时挂上')
  send(ctx, { t: 'ev.run_state', sessionId: 's1', state: 'idle' })
  assert.equal(ctx.data.pendingPermission, null, '这一轮结束了，挂着的卡都不该留着（老宿主只发这一帧）')
  assert.equal(ctx.data.pendingQuestion, null)
  assert.equal(ctx._cardTimer, null, '卡片都收了而那条表还在走：它会一直 setData 到天荒地老')
})


/**
 * running 那一帧**不是**粗收单信号（2026-10-06 修复的 P1）。
 *
 * 主机"只作废其中一张"时也发 `run_state`：桌面先把审批答掉，`voidStaleCard` 广播
 * `runState(state:'running')`。旧写法把这一帧当粗收单，两张卡一起清 ——
 * 还挂着的提问卡在手机上直接消失，而主机继续阻塞等回答，直到 300 秒超时
 * 按"没答上"结掉。用户完全不知道自己错过了一次提问。
 * 所以：running 里"哪张没了"只认精确帧。
 *
 * 判据在旧代码上必红：那时 running 会把两张卡一起清。
 */
test('ev.run_state{running} 不许粗清两张卡：主机只作废其中一张时也发这一帧', () => {
  const ctx = makePage()
  send(ctx, {
    t: 'ev.permission_request',
    sessionId: 's1',
    requestId: 'ap_r',
    action: 'bash',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  })
  send(ctx, {
    t: 'ev.question_request',
    sessionId: 's1',
    requestId: 'q_r',
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    questions: [{ id: 'x', question: '要哪个' }],
  })
  assert.ok(ctx.data.pendingPermission && ctx.data.pendingQuestion, '夹具自检：两张卡没同时挂上')

  // 桌面先答掉审批（精确帧），主机随后广播 running —— 提问那张还在等回答。
  send(ctx, { t: 'ev.permission_resolved', sessionId: 's1', requestId: 'ap_r', by: 'desktop' })
  send(ctx, { t: 'ev.run_state', sessionId: 's1', state: 'running' })
  assert.equal(ctx.data.pendingPermission, null, '桌面答掉的那张要收')
  assert.equal(
    ctx.data.pendingQuestion && ctx.data.pendingQuestion.requestId,
    'q_r',
    'running 帧把还挂着的提问卡一起清了：主机仍阻塞等回答，而用户看不到任何东西',
  )
  assert.ok(ctx._cardTimer, '提问卡还挂着，倒数表必须继续走（不能冻在那一刻）')

  // 回到 idle 才粗清剩下那张（这一轮结束了）
  send(ctx, { t: 'ev.run_state', sessionId: 's1', state: 'idle' })
  assert.equal(ctx.data.pendingQuestion, null, 'idle 是"这一轮结束"，挂着的卡随之作废')
  assert.equal(ctx._cardTimer, null)
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


test('工具还在跑的时候不补思考（那会儿在跑的是工具，不是模型）', async () => {
  const p = makePage()
  // 空块流时不插思考：那会儿还没有任何一组过程，用户看到的是刚发出去的那条指令，
  // 运行态由顶栏的中断按钮与后续落下的 live 步骤组说明。凭空在正文前面插一段
  // 「思考中」反而落单 —— 而且它会一直计时到 idle 才停
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'running' })
  assert.deepEqual(kinds(p), [], '空流不插思考段')

  // 2026-10-05 取消排队：执行中不许提交，所以这条消息现在发不出去（那一层由
  // 「执行中不许提交」那条判据钉）。先把会话置回空闲，再走正常那条路。
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'idle' })
  p.data.inputText = '跑一下测试'
  p.onSend()
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(kinds(p), ['turn', 'user'], '空闲时发出去就该立刻落块，不该再等一个「消化」动作')
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


test('折叠：新组默认收起，展开只能由用户点开（2026-10-05 用户：全部场景默认收起）', () => {
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
  // 这一条原来钉的是反面：实时新组默认展开，理由是"看不见工具列表"。
  // 但长会话里每来一次工具调用就顶开一段过程，正文被推出屏幕，想看正文得
  // 一路收回去——这正是用户报的。组头那行汇总已经够说明它在干什么了。
  assert.equal(
    p.data.blocks[0].open,
    false,
    '新步骤组默认展开：数据流不该替用户决定展开与否，想看细节由用户点开',
  )
  assert.equal(p.data.blocks[0].items[0].open, false, '组内某一步的参数/结果同样默认收起')

  p.onToggleSteps({ currentTarget: { dataset: { idx: 0 } } })
  assert.equal(p.data.blocks[0].open, true, '点一下才展开')

  p.onToggleTool({ currentTarget: { dataset: { b: 0, i: 0 } } })
  assert.equal(p.data.blocks[0].items[0].open, true, '再点展开这一步的参数与完整结果')

  p.onToggleSteps({ currentTarget: { dataset: { idx: 0 } } })
  assert.equal(p.data.blocks[0].open, false, '再点一次收回去 —— 折叠只有这一个层级')

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
  assert.equal(p.data.barTheme, 'default')
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
    getPending: () => {},
    on: () => () => {},
    sendPrompt: () => {},
    sendPromptReceipt: () => Promise.resolve({ ok: true }),
  // dropQueued: delete a queued message. __drcDropFail non-empty = host refuses
  dropQueued: function (sessionId, queueId) {
    globalThis.__drcDropped = (globalThis.__drcDropped || []).concat([queueId])
    var fail = globalThis.__drcDropFail
    return Promise.resolve(fail ? { ok: false, message: fail } : { ok: true })
  },
  }
  return calls
}

/**
 * 像真 client 那样喂一帧状态变化：**先改 client.status，再 emit**。
 *
 * 为什么不直接 `p._onEvent({kind:'status',...})`：真 client 的顺序是
 * `core/client.js:79-82` —— 先 `this.status = status`，再 emit。
 * 而 `stubClient` 把 `status:'online'` **写死**且从不随帧变，于是
 * `_maybeLoadHistory` 里的 `if (this.client.status !== 'online') return`
 * 在整个用例里永远不成立。后果是那条「断链重连后要重新读历史」的判据
 * **假通过**：真机上 'connecting' 帧会正确早退、不加载，而测试里它反而
 * 加载了一次——断链那一帧错误地替重连那一帧把断言喂饱了。
 *
 * 所以：**所有状态帧都必须走这个函数**，别再手写 _onEvent。
 */
function feedStatus(p, status, text) {
  p.client.status = status
  p._onEvent({ kind: 'status', status, ...(text ? { text } : {}) })
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
  // 刚点进会话时正文是空的，还没有步骤组 —— 运行态这时唯一的落点是那颗
  // 「变成中断的发送键」（2026-10-05 用户把顶栏那颗取消了）。
  assert.match(
    wxml,
    /wx:if="\{\{running\}\}"[\s\S]{0,80}composer-send composer-stop/,
    '运行中要把发送键变成中断键，否则用户进到一个正在跑的会话却停不下来',
  )
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


test('模型：别的会话的 ev.model 必须被会话过滤拦下（2026-10-05 用户实测的串台）', () => {
  const p = makePage()
  // 这条判据原来是反的：它断言「模型是全局的，不该被会话 id 拦掉」，
  // 并用另一个会话的 id 去验证——于是把串台写进了测试。用户实测到的正是
  // 本会话 space-bunny-free、顶栏显示别的会话切出来的 muse-spark。
  send(p, { t: 'ev.model', sessionId: 'another-session', model: 'muse-spark', canSwitch: false })
  assert.equal(p.data.modelName, '', '别的会话在用什么模型，与本会话无关')

  p._stopThinkTick()
})


test('模型：本会话的 ev.model 正常显示', () => {
  const p = makePage()
  send(p, { t: 'ev.model', sessionId: p.data.sessionId, model: 'space-bunny-free', canSwitch: false })
  assert.equal(p.data.modelName, 'space-bunny-free')

  p._stopThinkTick()
})


test('模型：老主机的无 sessionId 帧只做兜底，不覆盖已有的正确值', () => {
  const p = makePage()
  send(p, { t: 'ev.model', sessionId: p.data.sessionId, model: 'space-bunny-free', canSwitch: false })
  // 老主机那种全局帧随后才到：它是另一个上下文的值，不能把上面那条覆盖掉
  send(p, { t: 'ev.model', model: 'muse-spark', canSwitch: false })
  assert.equal(p.data.modelName, 'space-bunny-free', '已有本会话的真实模型时，无主机的旧帧不许覆盖')

  // 但一开始什么都没有时，旧帧仍然可用（总比空白好）
  const q = makePage()
  send(q, { t: 'ev.model', model: 'muse-spark', canSwitch: false })
  assert.equal(q.data.modelName, 'muse-spark')
  q._stopThinkTick()
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


test('审批：ev.run_state 回到 idle 时收走挂着的审批卡，倒计时也一起停', () => {
  const p = makePage()
  send(p, {
    t: 'ev.permission_request',
    sessionId: 's1',
    requestId: 'rq1',
    action: 'Bash',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  assert.ok(p.data.pendingPermission)

  // running **不**收卡（主机也用它广播"只作废了另一张"，见那条判据）；idle 才是粗收单。
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'idle' })
  assert.equal(p.data.pendingPermission, null, '一轮结束（idle）时挂着的审批就作废')
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



/* ── 排队消息 + 图片附件（2026-10-04 两个新特性）──────────────────────────
   排队：会话在跑时用户继续打的内容进队列（贴在输入区上方、可收起、可删），
   空闲按序发出。附件：加号 → 相册 → 压缩 → base64，随消息发出，
   **只映射协议要的字段**（本地 path 不上线）。 */

/** 桩住发码回执（与 newSession 同一套 waiter 机制由真 client 跑）。 */
function stubReceipt(p, answer) {
  const calls = []
  let n = 0
  p.client.sendPromptReceipt = (sessionId, text, images, files) => {
    const mappedPics =
      images && images.length
        ? images.slice(0, 4).map((a) => ({
            name: a.name,
            mediaType: 'image/jpeg',
            data: a.data,
            width: a.width,
            height: a.height,
          }))
        : undefined
    const mappedFiles =
      files && files.length
        ? files.slice(0, 4).map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data }))
        : undefined
    calls.push({ sessionId, text, images: mappedPics, files: mappedFiles })
    const a = typeof answer === 'function' ? answer(n++) : answer
    return Promise.resolve(a)
  }
  p.client.status = 'online'
  return calls
}

/** 等附件那一链的异步回调跑完（读文件/缩图都是 setImmediate 级别的异步）。 */
const settleAttach = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 10))
}


test('图片附件：加号 → 相册 → 压缩 → 画布缩到 1600 长边 → base64；只映射协议字段', async () => {
  const p = makePage()
  const calls = stubReceipt(p, { ok: true })
  globalThis.__drcCompressSrc = undefined
  // 一张 3000x4000 的大图：画布那一步必须真的把它缩下来（Android 上
  // compressImage 的 quality 被系统忽略，只有这一步两个平台都算数）。
  globalThis.__drcPick = { width: 3000, height: 4000 }
  p.setData({ sessionId: 's1' })
  p.onAttach()
  await settleAttach()
  assert.equal(p.data.attachments.length, 1, '假 wx 那一链走完要落一条附件')
  // 压的就是**选中的那一张**：chooseMedia 给的是 tempFilePath（不是 path）。
  assert.equal(globalThis.__drcCompressSrc, 'tmp-picked.jpg')
  const att = p.data.attachments[0]
  assert.deepEqual(globalThis.__drcShrunk, { w: 1200, h: 1600, quality: 0.6, fileType: 'jpg' })
  assert.match(att.path, /^tmp-shrunk-/, '上线的是缩完那个文件')
  assert.equal(att.data, Buffer.from('JPEGBYTES').toString('base64'))

  p.setData({ inputText: '看这张报错' })
  p.onSend()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, '看这张报错')
  assert.deepEqual(
    calls[0].images,
    [{ name: att.name, mediaType: 'image/jpeg', data: att.data, width: 3000, height: 4000 }],
    '上线的只有协议要的五个字段：path 之类的本机信息不许出去',
  )
  assert.equal(p.data.attachments.length, 0, '发完附件条清空')
  assert.equal(p.data.attachCount, 0, '加号角标跟着归零')
  // 回显里**不画图**，只报几张（用户：图片不用显示出来）
  const userBlock = p.data.blocks.find((b) => b.kind === 'user')
  assert.ok(userBlock, '本地回显要出现在块流里')
  assert.equal(userBlock.images.length, 1, '数据里还带着（要发出去）')
})


test('图片附件：小图不缩（缩一张 800px 的截图只会更糊）；超预算的被挡下并说清', async () => {
  const p = makePage()
  globalThis.__drcPick = { width: 800, height: 600 }
  // 上一条用例跑过画布：全局量要在这里清掉，不然读到的是别人的结果
  globalThis.__drcShrunk = undefined
  p.setData({ sessionId: 's1' })
  p.onAttach()
  await settleAttach()
  assert.equal(globalThis.__drcShrunk, undefined, '本来就小的图不许过画布：缩一张 800px 的截图只会更糊')
  // 800 < 1600：长边没超线，画布那一步整条不该发生
  assert.equal(p.data.attachments.length, 1)

  // 超单张预算：直接喂一个过大的 base64（判据不必真有个大文件）
  var out = []
  var steps = 0
  p._acceptImage('x.jpg', 'x.jpg', { width: 800, height: 600 }, 'A'.repeat(700 * 1024), out, function () {
    steps++
  })
  assert.equal(out.length, 0, '超预算的不进附件')
  assert.equal(steps, 1, '但仍然走完 done，后续图片要继续处理')
})


test('图片附件：撤掉全部已选（缩略图条删了，只留加号角标）', async () => {
  const p = makePage()
  globalThis.__drcPick = { width: 1600, height: 1200 }
  p.setData({ sessionId: 's1' })
  p.onAttach()
  await settleAttach()
  assert.equal(p.data.attachments.length, 1)
  p.onClearAttachments()
  assert.equal(p.data.attachments.length, 0, '一键清空')
  assert.equal(p.data.attachCount, 0, '角标归零')
})


test('图片附件：上限 4 个附件（协议层同一个数，两边不许分叉）', async () => {
  const p = makePage()
  const calls = stubReceipt(p, { ok: true })
  globalThis.__drcPick = { width: 1600, height: 1200 }
  p.setData({ sessionId: 's1' })
  for (let i = 0; i < 6; i++) p.onAttach()
  await settleAttach()
  assert.equal(p.data.attachments.length, 4, '假 wx 每次都回一张——但页面侧要截到 4')
  p.setData({ inputText: '' })
  p.onSend()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, '')
  assert.equal(calls[0].images.length, 4)
})
/* ── 进会话即执行中：正文要立刻有"正在执行"那一组（2026-10-05 用户实测）────── */


test('进执行中的会话：list_sessions 回执翻牌时必须开出实时组，不等内核事件', async () => {
  const p = makePage()
  stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: HISTORY_PAGE, nextBeforeSeq: null }))
  p._maybeLoadHistory()
  await flush()
  // 历史回放之后最后一个块是封口的步骤组/正文，此刻还没有实时组
  const before = stepGroups(p).length
  // 列表回执说这条会话在跑（进入时 ev.run_state 不会补发，这是唯一信号）
  p._onSessions({ sessions: [{ id: 's1', running: true }] })
  assert.equal(p.data.running, true)
  assert.equal(stepGroups(p).length, before + 1, '翻牌的同时要开出一个新的步骤组')
  const live = stepGroups(p)[stepGroups(p).length - 1]
  assert.equal(live.closed, false, '实时组不许封口（它还在跑）')
  assert.equal(live.items[live.items.length - 1].type, 'think')
  assert.equal(live.items[live.items.length - 1].done !== true, true, '思考项不能是完成态')
})


test('进空历史的执行中会话：列表回执先到时也要等历史落地后开组（空流不补）', async () => {
  const p = makePage()
  stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: [], nextBeforeSeq: null }))
  p._maybeLoadHistory()
  await flush()
  // 列表回执先到：blocks 还是空的 → 空流不补，一组都不该有
  p._onSessions({ sessions: [{ id: 's1', running: true }] })
  assert.equal(stepGroups(p).length, 0, '空流时不该凭空冒一组')
  // 历史（空的）随后落地：仍然没有块，还是不补（无历史可挂）
  await flush()
  assert.equal(stepGroups(p).length, 0)
  // 用户在列表回执之后发指令：这会儿会话在跑，指令进队列
  p.setData({ sessionId: 's1', inputText: '继续' })
  p.onSend()
  assert.equal(stepGroups(p).length, 0, '排队中的指令也不该凭空开组')
  // 当前这轮结束 → running 翻假 → 队列排空，本地回显落地
  p._onSessions({ sessions: [{ id: 's1', running: false }] })
  assert.equal(stepGroups(p).length, 0, '回显落地时仍然没有步骤组')
})


test('进执行中的会话：历史最后是封口组时开新组，不往旧组里塞', async () => {
  const p = makePage()
  stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: HISTORY_PAGE, nextBeforeSeq: null }))
  p._maybeLoadHistory()
  await flush()
  const closedGroups = stepGroups(p).length
  p._onSessions({ sessions: [{ id: 's1', running: true }] })
  assert.equal(stepGroups(p).length, closedGroups + 1)
  const last = p.data.blocks[p.data.blocks.length - 1]
  assert.equal(last.kind, 'steps')
  assert.equal(last.closed, false)
  assert.equal(p.data.blocks[p.data.blocks.length - 2].kind !== 'steps', true, '新组必须是追加在最后，不是在中间')
})

/* ── 待办条（2026-10-05：用户要的 todo list）────────────────────────────────── */

const TODO_FRAME = {
  t: 'ev.todo',
  todos: [
    { content: '复现问题', status: 'completed' },
    { content: '改完跑全链路', status: 'in_progress' },
    { content: '写判据', status: 'pending' },
  ],
}


test('待办帧：落在顶部那颗条上，默认收起只报进度', () => {
  const p = makePage()
  send(p, TODO_FRAME)
  assert.deepEqual(
    p.data.todos.map((x) => x.status),
    ['completed', 'in_progress', 'pending'],
    '三条状态原样落，一个都不许改',
  )
  assert.equal(p.data.todosOpen, false, '默认收起——常驻展开会把消息区顶掉')
  assert.equal(p.data.todoDone, 1, '完成数：1/3')
  assert.equal(p.data.todoRunning, 1, '有一条在进行中')
  assert.equal(p.data.todoRunningText, '进行中 改完跑全链路')
})


test('待办条：点条子展开、点消息区收回', () => {
  const p = makePage()
  send(p, TODO_FRAME)
  p.onToggleTodos()
  assert.equal(p.data.todosOpen, true, '点一下要展开')
  p.onToggleTodos()
  assert.equal(p.data.todosOpen, false, '再点一下收回')
  // 展开态下点消息区（scroll-view 的 catchtap）→ 收回
  p.onToggleTodos()
  p.onCollapseTodos()
  assert.equal(p.data.todosOpen, false, '失去焦点要自动收缩')
  // 收起态再点消息区：不该抖（没有状态变化就没有 setData）
  p.onCollapseTodos()
  assert.equal(p.data.todosOpen, false)
})


test('待办帧去重：同一份清单到两次不重排', () => {
  const p = makePage()
  send(p, TODO_FRAME)
  const first = p.data.todos
  send(p, TODO_FRAME)
  assert.equal(p.data.todos, first, '同一份快照第二次到必须原样不动（引用相等即没 setData）')
  // 状态真变了要落：completed → in_progress
  send(p, {
    t: 'ev.todo',
    todos: [
      { content: '复现问题', status: 'completed' },
      { content: '改完跑全链路', status: 'completed' },
      { content: '写判据', status: 'in_progress' },
    ],
  })
  assert.equal(p.data.todoDone, 2, '完成后完成数要跟着涨')
  assert.equal(p.data.todoRunningText, '进行中 写判据')
})


test('待办被内核清空：清单空了，展开态也要收回', () => {
  const p = makePage()
  send(p, TODO_FRAME)
  p.onToggleTodos()
  assert.equal(p.data.todosOpen, true)
  send(p, { t: 'ev.todo', todos: [] })
  assert.deepEqual(p.data.todos, [], '空快照要清空（不许留着上一轮的清单）')
  assert.equal(p.data.todosOpen, false, '清单没了就不该留一个展开的空面板')
})


test('wxml：待办条在顶部（scroll 之前），默认收起可点开', () => {
  const { readFileSync } = require('node:fs')
  const wxml = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'), 'utf8')
  const barAt = wxml.indexOf('todo-bar')
  const scrollAt = wxml.indexOf('class="scroll"')
  assert.ok(barAt > 0 && scrollAt > barAt, '待办条必须在消息区之前（做在顶部）')
  assert.ok(wxml.includes('bindtap="onToggleTodos"'), '点条子展开')
  assert.ok(wxml.includes('catchtap="onCollapseTodos"'), '点消息区收回')
  assert.ok(wxml.includes('todosOpen'), '张开合由 todosOpen 驱动')
})

/* ── 待办进历史回放（2026-10-05：补 1.4.0 留下的 v1 边界）────────────────────── */


test('历史回放：第一页里的待办快照落到顶部条上（进跑过的会话不用等下一帧）', async () => {
  const p = makePage()
  stubClient(p, () =>
    Promise.resolve({
      sessionId: 's1',
      cmdId: 'c1',
      items: [
        { t: 'ev.message_delta', messageId: 'h1', delta: '把待办补进历史', role: 'user', done: true },
        { t: 'ev.todo', todos: [{ content: '改完跑全链路', status: 'in_progress' }] },
        { t: 'ev.todo', todos: [{ content: '改完跑全链路', status: 'completed' }] },
      ],
      nextBeforeSeq: 12,
    }),
  )
  p._maybeLoadHistory()
  await flush()
  assert.equal(p.data.todos.length, 1, '第一页的快照要落地')
  assert.equal(p.data.todos[0].status, 'completed', '一页里最后一条才是那一页截止时的清单')
  assert.equal(p.data.todoDone, 1)
  assert.equal(p.data.todosOpen, false, '默认仍旧收起')
})


test('历史回放：更早页的待办是过期快照，不许把清单往回拨', async () => {
  const p = makePage()
  let call = 0
  stubClient(p, () => {
    call += 1
    return Promise.resolve({
      sessionId: 's1',
      cmdId: 'c' + call,
      items:
        call === 1
          ? [{ t: 'ev.todo', todos: [{ content: '最新清单', status: 'in_progress' }] }]
          : [{ t: 'ev.todo', todos: [{ content: '更早的清单', status: 'pending' }] }],
      nextBeforeSeq: call === 1 ? 20 : null,
    })
  })
  p._maybeLoadHistory()
  await flush()
  assert.equal(p.data.todos[0].content, '最新清单')
  // 用户点了「加载更早」：第二页（更早）落地
  await p.onLoadEarlier()
  assert.equal(p.data.todos[0].content, '最新清单', '更早页的待办是过期快照，不许覆盖')
})


test('历史回放：实时帧已经到过，历史快照不许盖它（后到者胜）', async () => {
  const p = makePage()
  // 实时帧先到（会话正在跑，todo/write 已经来了）
  send(p, { t: 'ev.todo', todos: [{ content: '实时清单', status: 'in_progress' }] })
  stubClient(p, () =>
    Promise.resolve({
      sessionId: 's1',
      cmdId: 'c1',
      items: [{ t: 'ev.todo', todos: [{ content: '历史里的旧清单', status: 'pending' }] }],
      nextBeforeSeq: null,
    }),
  )
  p._maybeLoadHistory()
  await flush()
  assert.equal(p.data.todos[0].content, '实时清单', '实时帧后到，历史不许盖它')
})


test('历史回放：没有待办的历史页不碰顶部条', async () => {
  const p = makePage()
  stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: HISTORY_PAGE, nextBeforeSeq: null }))
  p._maybeLoadHistory()
  await flush()
  assert.deepEqual(p.data.todos, [], '没有待办快照就不该凭空出现一条')
})


test('文件附件：加号旁边的文件入口 → 选文件 → 原样读成 base64；不压缩、保留扩展名', async () => {
  const p = makePage()
  const calls = stubReceipt(p, { ok: true })
  p.setData({ sessionId: 's1' })
  globalThis.__drcSheetTap = 1
  p.onAttach()
  await settleAttach()
  assert.equal(p.data.attachments.length, 1, '文件要落成一条附件')
  const one = p.data.attachments[0]
  assert.equal(one.kind, 'file', '与图片分开记：协议里是两个字段')
  assert.equal(one.name, 'report.pdf', '扩展名要留着——Agent 认文件靠它')
  assert.equal(one.mediaType, 'pdf', '类型标签取自**文件名**的扩展名，不是 chooseMessageFile 那个类别 type')
  assert.equal(one.data, Buffer.from('FILEDATA').toString('base64'), '原样读进来，不改一个字节')
  assert.equal(p.data.attachCount, 1, '加号角标跟着涨')

  // 发出去：只映射协议要的三个字段，path / size 都不上线
  p.setData({ inputText: '看看这份周报' })
  p.onSend()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, '看看这份周报')
  assert.equal(calls[0].images, undefined, '这条没有图，不该凭空多个空数组')
  assert.deepEqual(
    calls[0].files,
    [{ name: 'report.pdf', mediaType: 'pdf', data: Buffer.from('FILEDATA').toString('base64') }],
    '上线的只有协议要的三个字段：path / size 是本机的，不许出去',
  )
})


test('回归：chooseMessageFile 的路径字段是 `path`（2026-10-06 用户报"txt 读不出来"）', async () => {
  // 这条是本轮最贵的一个教训，值得单独钉住：页面读 f.tempFilePath，而真 API 只给 `path`，
  // 于是 filePath 恒为 undefined，**每一个**文件都落进"读不出来"的 toast。
  // 假实现当时也照抄了 chooseMedia 的形状，所以判据是绿的——它测的不是真机那条路。
  const p = makePage()
  globalThis.__drcFileBytes = { 'wxfile://tmp/notes.txt': Buffer.from('TXT').toString('base64') }
  globalThis.__drcPickFile = () => ({
    name: 'notes.txt',
    path: 'wxfile://tmp/notes.txt',
    size: 3,
    time: 1_700_000_000_000,
    type: 'file',
  })
  globalThis.__drcSheetTap = 1
  p.onAttach()
  await settleAttach()

  assert.equal(p.data.attachments.length, 1, '按真 API 的形状（只有 path）也必须读得出来')
  assert.equal(p.data.attachments[0].name, 'notes.txt', '文件名照原样带上去')
  assert.equal(p.data.attachments[0].data, Buffer.from('TXT').toString('base64'), '内容原样读进来')
  assert.equal(p.data.attachments[0].mediaType, 'txt', '扩展名从文件名取：txt 不该被标成类别 file')
})


test('type 是类别不是扩展名：媒体标签一律取自文件名（协议与主机都以名字为准）', async () => {
  // 官方 ChooseFile.type ∈ {video,image,file}。照抄它当扩展名，界面那一行的类型标签
  // 就退化成"file"，而主机那边 uploads.ts 保留的也是名字里的扩展名（它不改扩展名）。
  const cases = [
    { name: 'report.pdf', type: 'file', expect: 'pdf' },
    { name: 'notes.TXT', type: 'file', expect: 'txt' }, // 大小写归一，否则界面上会出现 TXT
    { name: 'archive.tar.gz', type: 'file', expect: 'gz' }, // 只取最后一段，别整条尾巴都标上
    { name: 'README', type: 'file', expect: 'file' }, // 没有扩展名：退回类别而不是空标签
  ]
  for (const [i, c] of cases.entries()) {
    const p = makePage()
    const path = `wxfile://tmp/case-${i}`
    globalThis.__drcFileBytes = { [path]: Buffer.from('X').toString('base64') }
    globalThis.__drcPickFile = () => ({ name: c.name, path, size: 1, time: 0, type: c.type })
    globalThis.__drcSheetTap = 1
    p.onAttach()
    await settleAttach()
    assert.equal(
      p.data.attachments[0].mediaType,
      c.expect,
      `${c.name} 的类型标签算成了 ${p.data.attachments[0].mediaType}，应为 ${c.expect}`,
    )
  }
})


test('文件附件：与图片可以同一条消息带（协议里是两个独立字段）', async () => {
  const p = makePage()
  const calls = stubReceipt(p, { ok: true })
  globalThis.__drcPick = { width: 1600, height: 1200 }
  globalThis.__drcShrunk = undefined
  p.setData({ sessionId: 's1' })
  p.onAttach()
  await settleAttach()
  assert.equal(p.data.attachments.length, 1, '先来一张图')
  globalThis.__drcSheetTap = 1
  p.onAttach()
  await settleAttach()
  assert.equal(p.data.attachments.length, 2, '图 + 文件各一条')
  assert.equal(p.data.attachments.filter((a) => a.kind === 'file').length, 1)
  assert.equal(p.data.attachments.filter((a) => a.kind !== 'file').length, 1)
  p.setData({ inputText: '' })
  p.onSend()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].images.length, 1, '图走 images')
  assert.equal(calls[0].files.length, 1, '文件走 files，两个字段互不干扰')
})


test('文件附件：超预算被挡下并说清该减哪一个（不静默丢弃）', async () => {
  const p = makePage()
  stubReceipt(p, { ok: true })
  p.setData({ sessionId: 's1' })
  // 解码后超过 512KB 的 base64：base64 长度要够到 700KB 字符才有这个效果
  const big = 'A'.repeat(700 * 1024)
  const out = []
  let steps = 0
  p._acceptFile('tmp-big.pdf', { name: 'big.pdf', type: 'pdf' }, big, out, () => {
    steps++
  })
  assert.equal(out.length, 0, '超预算的不进附件')
  assert.equal(steps, 1, '但仍然走完 done，后续文件要继续处理')
  // 后面这一份照常进来：挡下的只是那一个
  globalThis.__drcSheetTap = 1
  p.onAttach()
  await settleAttach()
  assert.equal(p.data.attachments.length, 1, '被挡下的是那一个，后面这份照常进来')
})


/* ── 附件的界面结构：两个入口、一张角标、一行说明 ─────────────────────── */


test('wxml：加号一个入口管两样，没有旁边的第二个按钮', () => {
  const { readFileSync } = require('node:fs')
  const wxml = fs.readFileSync(
    path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'),
    'utf8',
  )
  // 加号现在是唯一的附件入口（2026-10-05 用户：文件要放在加号里面）。
  assert.match(wxml, /composer-plus[^>]*bindtap="onAttach"/, '加号要点得动')
  // 不许有第二个附件按钮：1.1.7 加过一个，1.1.11 按用户要求收回加号里。
  assert.ok(!wxml.includes('composer-file'), '文件入口已经并进加号，不许再留一个旁边的按钮')
  assert.match(wxml, /chooseMessageFile/ === null ? /x/ : /x/, '占位')
  // 角标是唯一的"选了几个"的说法（缩略图条已删）。
  assert.match(wxml, /plus-badge">\{\{attachCount\}\}<\/view>/, '角标要说附件数')
  // 那一行说明：现在可能是图也可能是文件，所以说"项"不说"张"。
  assert.match(wxml, /已选 \{\{attachCount\}\} 项 随下一条消息发出/, '附件行要说项数，不要说张数')
  // 回显里同样只说项数（不画缩略图是已定的界面决定）。
  assert.match(wxml, /附件 \{\{item\.images\.length\}\} 项/, '回显里也说附件项数')
})






test('长按复制：助手回复同样能复制（markdown 原文）', () => {
  const p = makePage()
  globalThis.__drcClipboard = undefined
  const md = '## 结论\n\n**问题**在第三行'
  p.onCopyMessage({ currentTarget: { dataset: { text: md } } })
  assert.equal(globalThis.__drcClipboard, md, '复制的是模型原文，不是渲染后的版本')
})


test('长按复制：空文本不动作（不许用空串覆盖用户已复制的东西）', () => {
  const p = makePage()
  globalThis.__drcClipboard = '用户之前复制的'
  p.onCopyMessage({ currentTarget: { dataset: { text: '' } } })
  assert.equal(globalThis.__drcClipboard, '用户之前复制的', '空文本不许碰剪贴板')
  // 连 dataset 都没有（没绑 data-text 的节点）也不能炸
  p.onCopyMessage({ currentTarget: { dataset: {} } })
  p.onCopyMessage({})
  assert.equal(globalThis.__drcClipboard, '用户之前复制的')
})


test('wxml：只给用户气泡与回复气泡绑长按复制，步骤组不绑', () => {
  const { readFileSync } = require('node:fs')
  const wxml = fs.readFileSync(
    path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'),
    'utf8',
  )
  // 两处绑定：user 与 text
  const binds = wxml.match(/bindlongpress="onCopyMessage"/g) || []
  assert.equal(binds.length, 2, '只该有两处：用户气泡 + 回复气泡')
  // 步骤组那一行：不许出现 onCopyMessage（用户明说 steps 不用）
  const stepsLine = wxml
    .split(String.fromCharCode(10))
    .find((l) => l.includes("class=\"steps\"") && l.includes('wx:if'))
  assert.ok(stepsLine, '夹具自检：步骤组的渲染行没找到')
  assert.ok(!stepsLine.includes('onCopyMessage'), '步骤组不许绑复制')
  // data-text 必须跟着绑（没有它两手都空）
  assert.equal((wxml.match(/data-text="\{\{item\.text\}\}"/g) || []).length, 2)
})




test('长按复制：助手回复同样能复制（markdown 原文）', () => {
  const p = makePage()
  globalThis.__drcClipboard = undefined
  const md = '## 结论\n\n**问题**在第三行'
  p.onCopyMessage({ currentTarget: { dataset: { text: md } } })
  assert.equal(globalThis.__drcClipboard, md, '复制的是模型原文，不是渲染后的版本')
})


test('长按复制：空文本不动作（不许用空串覆盖用户已复制的东西）', () => {
  const p = makePage()
  globalThis.__drcClipboard = '用户之前复制的'
  p.onCopyMessage({ currentTarget: { dataset: { text: '' } } })
  assert.equal(globalThis.__drcClipboard, '用户之前复制的', '空文本不许碰剪贴板')
  // 连 dataset 都没有（没绑 data-text 的节点）也不能炸
  p.onCopyMessage({ currentTarget: { dataset: {} } })
  p.onCopyMessage({})
  assert.equal(globalThis.__drcClipboard, '用户之前复制的')
})


test('wxml：只给用户气泡与回复气泡绑长按复制，步骤组不绑', () => {
  const { readFileSync } = require('node:fs')
  const wxml = fs.readFileSync(
    path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'),
    'utf8',
  )
  // 两处绑定：user 与 text
  const binds = wxml.match(/bindlongpress="onCopyMessage"/g) || []
  assert.equal(binds.length, 2, '只该有两处：用户气泡 + 回复气泡')
  // 步骤组那一行：不许出现 onCopyMessage（用户明说 steps 不用）
  const stepsLine = wxml
    .split(String.fromCharCode(10))
    .find((l) => l.includes("class=\"steps\"") && l.includes('wx:if'))
  assert.ok(stepsLine, '夹具自检：步骤组的渲染行没找到')
  assert.ok(!stepsLine.includes('onCopyMessage'), '步骤组不许绑复制')
  // data-text 必须跟着绑（没有它两手都空）
  assert.equal((wxml.match(/data-text="\{\{item\.text\}\}"/g) || []).length, 2)
})


/* ── 加号弹选择：图片 / 文件（2026-10-05 用户：文件要放在加号里面） ────── */


test('加号先弹选择：两项，图片在前文件在后', () => {
  const p = makePage()
  globalThis.__drcSheetItems = undefined
  globalThis.__drcSheetTap = 0
  p.onAttach()
  assert.deepEqual(globalThis.__drcSheetItems, ['图片', '文件'], '选择就这两项，顺序按常用排')
})


test('加号 -> 选文件：走 chooseMessageFile，落成 file 附件', async () => {
  const p = makePage()
  globalThis.__drcSheetTap = 1
  globalThis.__drcFileBytes = { 'tmp-file.pdf': Buffer.from('PDFDATA') }
  p.onAttach()
  await settleAttach()
  const got = p.data.attachments
  assert.equal(got.length, 1, '选完文件就该有一个附件')
  assert.equal(got[0].kind, 'file', '从加号->文件进来的也是文件附件')
  assert.equal(got[0].name, 'report.pdf', '扩展名要留着（Agent 认文件靠它）')
})


test('加号 -> 选图片：走 chooseMedia，落成 image 附件', async () => {
  const p = makePage()
  globalThis.__drcSheetTap = 0
  p.onAttach()
  await settleAttach()
  const got = p.data.attachments
  assert.equal(got.length, 1, '选完图就该有一个附件')
  assert.notEqual(got[0].kind, 'file', '走的是图片那条链，不是文件')
})


test('加号：满了不弹选择，直接说满（不浪费一次点击）', async () => {
  const p = makePage()
  // 先填满（每次点加号都走一遍选择 -> 选图）。
  // ⚠️ 必须逐次 await：缩图画布那个节点是**异步**回来的（真机也一样，
  // 见夹具 createSelectorQuery 的注释），第一次不进画布的结果要下一拍才落进 attachments。
  for (let i = 0; i < 4; i++) {
    globalThis.__drcSheetTap = 0
    p.onAttach()
    await settleAttach()
  }
  assert.equal(p.data.attachments.length, 4, '先确认真的满了')
  // 再点一次：这次不许弹选择，直接告诉用户满了
  globalThis.__drcSheetItems = undefined
  globalThis.__drcSheetTap = -1 // 越界 = 假 wx 的 showActionSheet 直接 return
  p.onAttach()
  assert.equal(globalThis.__drcSheetItems, undefined, '满了以后连选择都不该弹')
  assert.equal(p.data.attachments.length, 4, '也不许多收')
})


/* ── 排队双向同步：主机是真相源，手机能删 ─────────────────────────────── */


test('模型按会话：ev.model 带 sessionId，mp 端不再豁免会话过滤（2026-10-05 实测串台）', () => {
  const proto = fs.readFileSync(path.join(ROOT, 'dsh-remote-protocol/src/wire/payloads.ts'), 'utf8')
  const i = proto.indexOf('export const evModel')
  const block = proto.slice(i, proto.indexOf('})', i))
  assert.match(block, /sessionId: nonEmpty/, 'ev.model 必须带 sessionId，否则无法按会话过滤')

  const chat = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.js'), 'utf8')
  // 关键：那句「模型是全局的，过滤之前先判」的豁免必须消失
  assert.ok(!/ev\.model.*return this\._onModel\(p\)\s*\n\s*\n\s*if \(p\.sessionId/.test(chat),
    'ev.model 不得豁免会话过滤——别的会话一推模型帧就会覆盖本会话的顶栏')
  // 兜底分支：老主机不带 sessionId 时，只在本会话还没有模型名时才用
  assert.match(chat, /if \(p\.sessionId \|\| !this\.data\.modelName\) this\._onModel\(p\)/,
    '无 sessionId 的旧帧只做兜底，不能覆盖已有的正确模型名')
})


test('模型的数据源是 request/header，不是宿主全局默认模型', () => {
  const carrier = fs.readFileSync(
    path.join(ROOT, 'dsh-remote-control/packages/plugin/src/platform/carrier-services.ts'),
    'utf8',
  )
  assert.match(carrier, /case 'request\/header'/, '必须映射 request/header（每轮都带本会话真实模型）')
  const runtime = fs.readFileSync(
    path.join(ROOT, 'dsh-remote-control/packages/plugin/src/core/runtime.ts'),
    'utf8',
  )
  // broadcastModel 不许再从 currentSelection 取值
  assert.ok(!/modelSelection\?\.\(\)/.test(runtime),
    '不许再用宿主全局默认模型——那是别的会话切模型后会串台的那个值')
  assert.match(runtime, /broadcastModel\(event\.sessionId, event\.model/, '按会话广播')
})


/**
 * 取消排队之后的新约定（2026-10-05 用户拍板）。三条都要钉：
 *
 * 1) 执行中不许提交。判据钉 onSend 那一层而不是只钉按钮：键盘的 send 走
 *    bindconfirm，绕得过去，只在 wxml 上拦会漏。
 * 2) 发送键在执行中变中断键——同一位置、同一形状，文案说清身份变了。
 * 3) 顶栏那颗中断键取消：同一个动作挂两处，用户会怀疑哪颗是真的。
 *
 * 顺带钉住「执行中照发」这个老行为**不再**成立——它当年是为了配合
 * 主机侧排队；队列没了还留着，就等于把消息丢进一个没人消费的 inbox。
 */
test('执行中不许提交：onSend 被 running 挡住，输入框与附件都留着', () => {
  const p = readyAtBottom()
  p.setData({ running: true, inputText: '再补一句', attachCount: 0 })
  const sent = []
  p.client.sendPromptReceipt = (...a) => {
    sent.push(a)
    return Promise.resolve({ ok: true })
  }
  p.onSend()
  assert.equal(sent.length, 0, '执行中还是把消息发出去了：主机那边没有队列，它会掉进 agent inbox 没人管')
  assert.equal(p.data.inputText, '再补一句', '被挡住的那次提交不该把用户已经打好的字吞掉')
})

test('不执行中：onSend 正常发出去，并且清空输入', () => {
  const p = readyAtBottom()
  p.setData({ running: false, inputText: '发出去', attachCount: 0 })
  const sent = []
  p.client.sendPromptReceipt = (...a) => {
    sent.push(a)
    return Promise.resolve({ ok: true })
  }
  p.onSend()
  assert.equal(sent.length, 1, '空闲时反而发不出去：这是最常见的那条路，坏了整页就不能用了')
  assert.equal(p.data.inputText, '', '发出去了就该清空，不然下一条会带上上一条')
})

test('发送键在执行中变中断键；顶栏不再挂第二颗中断键', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'), 'utf8')
  assert.match(
    wxml,
    /wx:if="\{\{running\}\}"[\s\S]{0,80}composer-send composer-stop/,
    '执行中那颗键没有变成中断键：用户只能去别处找停止，而那个入口已经被取消了',
  )
  assert.match(wxml, /bindtap="onInterrupt"/, '执行中那颗键没有绑中断')
  assert.doesNotMatch(
    wxml,
    /class="bar-stop"/,
    '顶栏还挂着中断键：同一个动作两个入口，而且它在拇指最难够到的位置',
  )
})

/**
 * 断链重连后消息流必须恢复（2026-10-05 用户：chat 页激活时断链，重连后就不刷新了）。
 *
 * 病根：`_maybeLoadHistory` 第一句是 `if (this._historyStarted) return`，
 * 而那个标志一辈子只置真一次。于是重连成功那一刻它直接返回 —— 断链期间
 * 主机上跑完的东西一条都补不回来，主机又只发 resync 不推历史，
 * 于是页面活着、顶栏亮着，而消息流从此静止。
 *
 * 判据钉的是**重连那一刻真的又去读了一次**：断了之后收到 online，
 * 必须再发一次 loadHistory。没修之前这里是 0 次。
 */
test('断链重连后要重新读历史：断链期间落下的消息不能永远补不回来', async () => {
  const p = readyAtBottom()
  const calls = stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: [] }))

  // 第一次连上：读一页
  feedStatus(p, 'connecting')
  feedStatus(p, 'online')
  await flush()
  const afterFirst = calls.length
  assert.ok(afterFirst >= 1, '夹具自检：首次连上就该读一次历史')

  // 链断了又回来。这中间主机上发生了什么，这一页完全不知道。
  calls.length = 0
  feedStatus(p, 'connecting', '连接已断开，正在重连…')
  feedStatus(p, 'online')
  await flush()

  assert.ok(
    calls.length > 0,
    '重连后一次都没读：断链期间跑完的步骤、工具、回复永远补不回来了（消息流就此静止）',
  )
})
/**
 * 反过来：只是多余的状态帧、并没有真的断开过，就不该重读。
 *
 * 没有这一条，上面那条修法会退化成「每次 online 都把历史重拉一遍」——
 * 长会话每收到一次 online 就把整页翻出来，既慢又把用户正在看的位置冲掉。
 *
 * 注意场景：这里**不**发 connecting。全程 online，所以没有"断过"这件事。
 */
test('不是重连（没断过链）就不重读历史：否则每次 online 都把整页翻出来', async () => {
  const p = readyAtBottom()
  const calls = stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: [] }))

  feedStatus(p, 'online')
  await flush()
  assert.ok(calls.length >= 1, '夹具自检：首次连上读过')

  // 又来两次 online，中间**没有** connecting —— 全程没断过
  calls.length = 0
  feedStatus(p, 'online')
  feedStatus(p, 'online')
  await flush()
  assert.equal(
    calls.length,
    0,
    '没断过链却重读历史：长会话每收到一次 online 就整页翻出来，又慢又冲掉用户正在看的位置',
  )
})

/**
 * 待办条那两个显示问题的判据（2026-10-05 用户截图）。
 *
 * ① 折叠三角一直在闪；② 不要那排蓝色分段进度条。
 *
 * ① 的病根值得记下来：**两个互不相关的东西共用了 .caret 这个类名**——
 * 用户消息里「正在输入」的光标（蓝色、caret-blink 1s infinite），
 * 和待办条的折叠三角。wxss 里后定义的那条覆盖前面的，于是三角被顶成光标。
 * 判据钉的是**两个类名不许相同**，而不只是「别闪」：只钉现象的话，
 * 下一个人把三角改回 .caret 时没人会知道那是同一个坑。
 */
test('待办条：折叠三角不能沿用输入光标的类名（否则它会变成一根闪的光标）', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxss'), 'utf8')

  assert.match(
    wxml,
    /todo-caret/,
    '待办条的折叠三角还在用 .caret —— 那个类名是用户消息里正在输入的光标',
  )
  assert.match(
    wxss,
    /\.todo-caret\s*\{/,
    'wxss 里没有 .todo-caret 的定义：三角会退回套 .caret，也就退回那根闪的光标',
  )
  // .caret 那条带闪烁动画 —— 它只该属于输入光标
  assert.match(
    wxss,
    /\.caret\s*\{[^}]*caret-blink/s,
    '夹具自检：.caret 应当是那根闪的光标，否则这条判据的前提就不成立了',
  )
  assert.doesNotMatch(
    wxss,
    /\.caret-up\s*\{/,
    '.caret-up 还在：三角改名了它没跟着改，这条会变成没有主人的孤儿规则',
  )
})

/**
 * ② 蓝色分段进度条整块删掉（用户：可以不要这些蓝色的进度条）。
 *
 * 连着判据「死代码也要清」：只删 wxml 不删 _todoSegs/TODO_SEG_MAX 的话，
 * 那段算分格的代码还留在那儿，下一个人会以为它还在用。
 */
test('待办条：蓝色分段进度条整块删干净（wxml、样式、算分格的代码都不许留）', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxss'), 'utf8')
  const js = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.js'), 'utf8')

  assert.doesNotMatch(wxml, /todo-segs/, '分段条还在页面上：用户明确说不要那排蓝条')
  assert.doesNotMatch(wxss, /\.todo-seg/, '分段条的样式没删：wxml 已经不用它们了，纯死代码')
  assert.doesNotMatch(js, /todoSegs|TODO_SEG_MAX/, '算分格的代码还在：只删视图不删算法，下一个人会以为它还在用')

  // 而进度本身还在：那个数字才是这条要说的（用户删的是蓝条，不是进度）
  assert.match(
    wxml,
    /待办 \{\{todoDone\}\}\/\{\{todos\.length\}\}/,
    '连「待办 7/9」这个数字一起删了：用户要的是去掉蓝条，不是去掉进度',
  )
})

/**
 * 「默认永远跟底」这条契约（2026-10-05 用户：以滑动底部作为默认行为，
 * 避免场景确实导致不跟滑）。
 *
 * 旧写法把「deltaY 为负」当成用户往上拖，于是**位置明明还在底部也停跟**——
 * 那正是「不跟手、很多场景卡住」的来源。现在判据只看位置：贴底就跟着。
 *
 * 这一条钉的是**顺序**：位置判据必须在 deltaY 之前。反过来写的话，
 * 回弹帧（位置在底部、deltaY 为负）会先把跟随关掉——现有那三条判据都盖不住它，
 * 因为它们的帧要么在底部之外、要么 deltaY 为正。
 */
test('滚动：贴在底部时不管 deltaY 什么符号都跟着（默认行为是跟）', () => {
  const p = readyAtBottom()
  // 一条「位置在底部但 deltaY 为负」的帧 —— iOS 落底回弹就是这个样子
  p.onScroll({ detail: { scrollLeft: 0, scrollTop: 1380, scrollHeight: 2000, deltaY: -30 } })
  assert.equal(p._autoScroll, true, '还在底部就把跟随关了：这正是「不跟手」的成因')
  assert.equal(p.data.atBottom, true, '按钮不该浮出来')

  // 正的 deltaY（同理，不该影响）
  p.onScroll({ detail: { scrollLeft: 0, scrollTop: 1390, scrollHeight: 2000, deltaY: 12 } })
  assert.equal(p._autoScroll, true, '贴底时正向滚动也要保持跟随')
})

/**
 * 自作滚动途中的那些帧：位置还没到底、deltaY 为负。
 *
 * 这时候停下跟随就等于把一次自动滚动拆成两半（后续帧不再跟），用户看到的是
 * 「滚到一半就不动了」。窗口只覆盖**我们自己触发**的那次滚动——
 * 旧写法是「点完回到最新之后的 600ms」，那会把用户在这段时间里的真回看也吃掉。
 */
test('滚动：自动滚动途中的中间帧不许停跟（否则一次滚动被拆成两半）', () => {
  const p = readyAtBottom()
  p.onJumpLatest()
  assert.ok(p._programmaticUntil > 0, '夹具自检：点了回到最新就该记下窗口')
  // 途中一帧：还没到底、deltaY 为负
  p.onScroll({ detail: { scrollLeft: 0, scrollTop: 1200, scrollHeight: 2000, deltaY: -40 } })
  assert.equal(p._autoScroll, true, '自动滚动的中间帧被当成了用户回看：这次滚动到此为止')
})

/**
 * 反过来：窗口之外的真实回看**照旧**要停跟。
 *
 * 没有这一条，上一条会退化成「永远不跟」——而用户往上翻历史正是要这个。
 */
test('滚动：窗口之外的真实回看照旧停跟（不然就变成永远不跟了）', () => {
  const p = readyAtBottom()
  p.onScroll({ detail: { scrollLeft: 0, scrollTop: 1000, scrollHeight: 2000, deltaY: -50 } })
  assert.equal(p._autoScroll, false, '没在底部、也不是自动滚动的回弹帧：这就是用户在回看')
})

test('断链重连后要重新读历史：**进页面时已在线**（onShow 读过）的那一条路径', async () => {
  // 上一条判据的夹具有个巧合把它盖住了：它用 connecting→online 起手，
  // 于是第一次 online 时 _wasOffline 为真，顺手把 _historyStarted 复位成 false，
  // 第二次 online 于是又能加载。**真实用户路径不是这样**：
  //   进 chat 页时已经连着 → onShow 读历史（_historyStarted=true, _wasOffline=false）
  //   → 断链 → 重连
  // 这一条里 _historyStarted 在重连那一刻**就是 true**，而复位发生在触发点之后。
  const p = readyAtBottom()
  const calls = stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: [] }))

  // 进页面时已经在线：onShow 读一页历史
  feedStatus(p, 'online')
  await flush()
  assert.ok(calls.length >= 1, '夹具自检：进页面就该读一次历史')
  assert.equal(p._historyStarted, true, '夹具自检：读完之后这个标志是置位的')

  // 断链 → 重连
  calls.length = 0
  feedStatus(p, 'connecting', '连接已断开，正在重连…')
  feedStatus(p, 'online')
  await flush()

  assert.ok(
    calls.length > 0,
    '重连后一次都没读：断链期间跑完的步骤、工具、回复永远补不回来了（消息流就此静止）',
  )
})

// ── 回到最新 FAB（2026-10-06）───────────────────────────────────────────
// 两条都是**从真实现场取证**加进来的，不是构造出来的场景：
//   位置：restyle 4656d70 把 bottom 从 210rpx 改成 176rpx，而输入区高
//         122rpx + env(safe-area-inset-bottom)，于是它沉进输入区——
//         模拟器实测（safeAreaBottom=34）FAB 盒 y 633–662、输入区顶边 657。
//   重挂载：点完「回到最新」，向下的程序滚动 deltaY>0，而回弹豁免只挡 deltaY<0，
//         于是每一帧中间帧都把 atBottom 打回 false，按钮在自己滚动途中反复出现
//         （渲染层实测 11 个中间帧里 7 帧重新出现）。
//
// 上一版的三条判据（跟着/中间帧/窗口外照停）**一条都没量位置**，也没喂正 deltaY，
// 所以这两条全绿。

const CHAT_WXSS = fs.readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxss'), 'utf8')

test('FAB：锚在视口（fixed）而不是 .chat-wrap——height:100% 没解析时它会跑到屏幕中间', () => {
  // 这条钉的是**根因**而不是症状。锚在 .chat-wrap（position:relative;height:100%）上时，
  // 一旦这台设备上 height:100% 没解析，定位祖先退化成内容高度、bottom 按内容量算——
  // 内容长时跑出屏幕，内容短时正好落在屏幕中部。用户报的现象就是这个。
  assert.match(CHAT_WXSS, /\.jump\s*\{[^}]*position:\s*fixed/, 'FAB 必须锚在视口')
  assert.doesNotMatch(
    CHAT_WXSS,
    /\.jump\s*\{[^}]*position:\s*absolute/,
    '锚回 .chat-wrap 就等于把 height:100% 的解析结果交给运气',
  )
  // 本页无祖先 transform，fixed 不会遇到"transform 生成 containing block"那类漂移。
  assert.doesNotMatch(CHAT_WXSS, /\.chat-wrap\s*\{[^}]*transform/, '.chat-wrap 不能有 transform，否则 fixed 也会漂')
})

test('FAB：贴在输入区上方（按输入区高度算，不按视口百分比）', () => {
  // 用户拍板：「放在下面，不要垂直居中」。上一版 bottom:46% 在一切高屏上都飘在
  // 屏幕中段——看着像屏幕正中长的东西。用输入区高度定位才恒成立：
  // 输入区 122rpx（padding 16/16+inset + pill 88rpx + 2rpx 边）+ 24rpx 间隙，
  // 再加 env(safe-area-inset-bottom) 兜手势条/小黑条。
  const m = /\.jump\s*\{[^}]*bottom:\s*calc\((\d+)rpx\s*\+\s*env\(safe-area-inset-bottom\)\)/.exec(CHAT_WXSS)
  assert.ok(m, '.jump 的 bottom 必须是 calc(<输入区+间隙>rpx + env(safe-area-inset-bottom))')
  const offset = Number(m[1])
  assert.ok(offset >= 130 && offset <= 170, `bottom 偏移应≈146rpx（122 输入区 + 24 间隙），实际 ${offset}rpx`)
  assert.match(CHAT_WXSS, /\.jump\s*\{[^}]*right:\s*24rpx/, '.jump 贴右，与输入区左右 padding 对齐')
})

test('FAB：有附件行时整个不渲染（按钮按输入区定位，会压住附件行）', () => {
  const wxml = fs.readFileSync(
    path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'),
    'utf8',
  )
  assert.match(wxml, /wx:if="\{\{!atBottom && !pendingPermission && !pendingQuestion && !attachCount\}\}"/)
})

test('FAB：点完「回到最新」，向下滚的中间帧不许把它重新挂上（deltaY > 0）', () => {
  const p = readyAtBottom()
  p.onScroll({ detail: { scrollLeft: 0, scrollTop: 1000, scrollHeight: 3000, deltaY: -300 } })
  assert.equal(p._autoScroll, false, '夹具自检：用户往上滑之后不该再跟')

  p.onJumpLatest()
  assert.equal(p.data.atBottom, true, '点完立刻判定为贴底')

  // 程序滚动是**向下**的：deltaY > 0。这些帧还没真的到底，
  // 原来的豁免只挡负 deltaY，于是 atBottom 被打回 false、按钮重新挂上。
  for (const scrollTop of [1100, 1250, 1500, 1900, 2400, 2800]) {
    p.onScroll({ detail: { scrollLeft: 0, scrollTop, scrollHeight: 3000, deltaY: 25 } })
    assert.equal(p._autoScroll, true, `scrollTop=${scrollTop} 这一帧是"回到最新"自己的滚动，按钮不该重新出现`)
    assert.equal(p.data.atBottom, true, `scrollTop=${scrollTop} 不该被判成"不在底部"`)
  }
})

test('FAB：程序滚动窗口内用户真的往回拖，仍然要停跟（位置判据不能吃掉真回看）', () => {
  const p = readyAtBottom()
  p.onScroll({ detail: { scrollLeft: 0, scrollTop: 1000, scrollHeight: 3000, deltaY: -300 } })
  p.onJumpLatest()
  // 窗口内往回拖：scrollTop 明显**低于**起点。这是用户在回看，必须照跟停掉。
  p.onScroll({ detail: { scrollLeft: 0, scrollTop: 300, scrollHeight: 3000, deltaY: 30 } })
  assert.equal(p._autoScroll, false, '窗口内往回拖是真回看，不能被位置豁免吃掉')
})

test('待办：形状不对的帧不许锁死历史回放（_todoLive 是单向闩锁）', async () => {
  // `_todoLive` 置真后全页不再复位，而历史落地处有 `!_todoLive` 这道守卫。
  // 原实现在 _onTodo 里无条件置真：任何一帧 p.todos 不是数组的帧，都会
  // 把历史回放永久关掉，同时把清单清成空的——条子就没了，且再也回不来。
  const p = readyAtBottom()
  stubClient(p, () =>
    Promise.resolve({
      sessionId: 's1',
      cmdId: 'c1',
      items: [...HISTORY_PAGE, { t: 'ev.todo', todos: [{ content: '历史那条', status: 'in_progress' }] }],
    }),
  )

  p._onEvent({ kind: 'payload', payload: { t: 'ev.todo', sessionId: 's1', todos: null } })
  assert.equal(p._todoLive, false, '形状不对的帧没有真数据，不该置闩锁')

  await p._loadHistory(null)
  await flush()
  assert.equal(p.data.todos.length, 1, '历史快照必须能被应用')
  assert.equal(p.data.todos[0].content, '历史那条')
})

test('待办：空数组**要**置闩锁（内核清空清单是真数据，用户拍板取最后一份）', () => {
  const p = readyAtBottom()
  p._onEvent({ kind: 'payload', payload: { t: 'ev.todo', sessionId: 's1', todos: [] } })
  assert.equal(p._todoLive, true, '空清单是"此刻清单为空"，是真数据')
  assert.equal(p.data.todos.length, 0)
})

// ── 提问卡：别的会话在提问时不许静默吞掉（2026-10-06）────────────────────
//
// 现场（用户确认）：2026-10-06 10:16:12 主机问了一个真问题（2 道题），
// 10:21:30 被桌面答掉。期间手机端**什么都没有**——不是"闪一下被撤卡"，
// 是整段时间没出现过。运行时计数证明帧确实出去了（outbound.question_request=1，
// 且没有 question_request_no_peer，即主机认为手机在线）。
//
// 结构性原因：提问卡是「一次性、单会话、只在 chat 页、永不重放」的面。
// 其中一个放大器是 `chat.js:545/553` 的会话过滤——用户不在提问那条会话的
// chat 页（甚至停在列表页）就**无声吞掉**，连一句提示都没有。

test('提问：不是本会话的提问帧不许静默吞掉（要提示，否则用户以为没这回事）', () => {
  const p = readyAtBottom()
  const toasts = []
  const original = wx.showToast
  wx.showToast = (opts) => toasts.push(opts.title)
  try {
    p._onEvent({
      kind: 'payload',
      payload: {
        t: 'ev.question_request',
        sessionId: 'other_session',
        requestId: 'rq_other',
        questions: [{ id: 'q1', question: '在另一条会话里问的', options: [{ id: 'a', label: 'A' }] }],
      },
    })
    assert.equal(p.data.pendingQuestion, null, '本会话不该收到别人的卡')
    assert.equal(
      toasts.length,
      1,
      '静默吞掉了：用户在手机上什么都看不到，却完全不知道主机正在等他回答（2026-10-06 现场）',
    )
  } finally {
    wx.showToast = original
  }
})

test('提问：本会话的提问帧照常弹卡（别把上面那条改过头）', () => {
  const p = readyAtBottom()
  p._onEvent({
    kind: 'payload',
    payload: {
      t: 'ev.question_request',
      sessionId: p.data.sessionId,
      requestId: 'rq_mine',
      questions: [{ id: 'q1', question: '要继续吗', options: [{ id: 'a', label: 'A' }] }],
    },
  })
  assert.ok(p.data.pendingQuestion, '本会话的提问必须弹出来')
  assert.equal(p.data.pendingQuestion.questions[0].question, '要继续吗')
})

// ── 重试 / 压缩的瞬时提示（2026-10-06：主机 2.0.11 已发，mp 侧补上） ──
//
// 为什么值得测：`llm/retry` 与 `compaction/*` 期间手机原来是一片空白 ——
// 用户看到"模型卡住了"就手动中断，而宿主其实正在重试/压缩。
// 提示是顶栏下一行的一句瞬时话（`notice`），不是块流：半小时后再看
// "正在重试 2/5"毫无意义，所以它不进历史，run-state 回到 idle 就清掉。
// `failed` 与 `ended` 是两件事，绝不合并（上下文烂了还说正常，比看不见更糟）。

test('重试：ev.retry 在顶栏下给一句瞬时提示（第几次/共几次/原因）', () => {
  const p = readyAtBottom()
  assert.equal(p.data.notice, '', '夹具自检：初始没有提示')
  send(p, { t: 'ev.retry', sessionId: p.data.sessionId, attempt: 2, max: 5, reason: 'TRANSPORT' })
  assert.equal(p.data.notice, '正在重试 2/5 · TRANSPORT')
})

test('重试：别的会话的重试帧不许污染本页（与其它事件同一条会话过滤）', () => {
  const p = readyAtBottom()
  send(p, { t: 'ev.retry', sessionId: 'other_session', attempt: 1, max: 3 })
  assert.equal(p.data.notice, '', '别的会话在重试不关这一页的事')
})

test('压缩：started 给提示，ended 当场清，failed 留原因且不与 ended 合并', () => {
  const p = readyAtBottom()
  send(p, { t: 'ev.compaction', sessionId: p.data.sessionId, state: 'started' })
  assert.equal(p.data.notice, '正在压缩上下文')
  send(p, { t: 'ev.compaction', sessionId: p.data.sessionId, state: 'ended' })
  assert.equal(p.data.notice, '', '压缩结束了就没什么好说的')
  send(p, { t: 'ev.compaction', sessionId: p.data.sessionId, state: 'started' })
  send(p, {
    t: 'ev.compaction',
    sessionId: p.data.sessionId,
    state: 'failed',
    error: 'summarization produced no text summary content',
  })
  assert.match(p.data.notice, /^压缩没成功：/, 'failed 必须说失败，不能当成 ended 清掉')
  assert.match(p.data.notice, /summarization/, '失败原因要留下来，否则用户不知道上下文已经烂了')
})

test('瞬时提示：run-state 回到 idle 就清掉（不把上一轮的话留到下一轮）', () => {
  const p = readyAtBottom()
  send(p, { t: 'ev.retry', sessionId: p.data.sessionId, attempt: 2, max: 5, reason: 'TIMEOUT' })
  assert.ok(p.data.notice, '运行时有提示')
  send(p, { t: 'ev.run_state', sessionId: p.data.sessionId, state: 'idle' })
  assert.equal(p.data.notice, '', '这一轮结束了，提示必须走')
})

test('瞬时提示：running 不清（别把刚收到的提示当场掐掉）', () => {
  const p = readyAtBottom()
  send(p, { t: 'ev.compaction', sessionId: p.data.sessionId, state: 'started' })
  send(p, { t: 'ev.run_state', sessionId: p.data.sessionId, state: 'running' })
  assert.equal(p.data.notice, '正在压缩上下文', '还在跑就说明压缩还没完，提示要留着')
})

// PRODUCT.md G2 的另一半：审批跨会话原来是彻底静默（提问至少还有一句 toast）。
// 主机阻塞等决定、180 秒超时自动拒绝，而手机毫无痕迹 —— 与提问对称处理。

test('审批：不是本会话的审批帧不许静默吞掉（与提问对称）', () => {
  const p = readyAtBottom()
  const toasts = []
  const original = wx.showToast
  wx.showToast = (opts) => toasts.push(opts.title)
  try {
    p._onEvent({
      kind: 'payload',
      payload: { t: 'ev.permission_request', sessionId: 'other_session', requestId: 'rq_other' },
    })
    assert.equal(p.data.pendingPermission, null, '本会话不该收到别人的卡')
    assert.equal(toasts.length, 1, '静默吞掉了：主机白等 180 秒，用户却完全不知道有审批在等')
  } finally {
    wx.showToast = original
  }
})

test('审批：本会话的审批帧照常弹卡（别把上面那条改过头）', () => {
  const p = readyAtBottom()
  p._onEvent({
    kind: 'payload',
    payload: { t: 'ev.permission_request', sessionId: p.data.sessionId, requestId: 'rq_mine' },
  })
  assert.ok(p.data.pendingPermission, '本会话的审批必须弹出来')
})

// ── 步骤中文类别（2026-10-06：映射函数从 app.asar 实测挖出，不是猜的） ──
//
// 宿主 `dsh-client-ui-chat` 的 `activity(name)`（工具名→类别）+ 中文词表
// `message.stepProcess.*` 都在 asar 里，mp 之前直接显示 `{{it.tool}}` 原样英文。
// port 在 `miniprogram/core/activity.js`，行首显示类别、原英文名退到副标题。

test('步骤：工具名按宿主同款映射显示中文（bash→正在运行命令）', () => {
  const p = readyAtBottom()
  send(p, { t: 'ev.tool_event', sessionId: p.data.sessionId, callId: 'c1', phase: 'args', tool: 'bash' })
  const group = stepGroups(p)[stepGroups(p).length - 1]
  const item = group.items[group.items.length - 1]
  assert.equal(item.tool, 'bash', 'tool 存原样（调试与断言的锚点）')
  assert.equal(item.cat, '正在运行命令', '显示用中文类别')
  assert.equal(item.title, 'bash', '无标题时原英文名退到副标题，信息不丢')
})

test('步骤：映射覆盖宿主全部的分流规则（不是只列几个常见的）', () => {
  const cases = [
    ['read', '正在读取文件'],
    ['read_image', '正在读取图片'],
    ['write', '正在写入文件'],
    ['grep', '正在搜索代码'],
    ['glob', '正在搜索代码'],
    ['edit', '正在编辑文件'],
    ['apply_patch', '正在编辑文件'],
    ['web_search', '正在搜索网页'],
    ['web_fetch', '正在访问网页'],
    ['subagent', '正在协调子智能体'],
    ['todo_write', '正在更新计划'],
    ['ask_user_question', '等待你的操作'],
    ['run_code', '正在运行代码'],
    ['terminal_x', '正在运行命令'],
    ['something_new', '正在调用工具'],
  ]
  for (const [tool, label] of cases) {
    const p = readyAtBottom()
    send(p, { t: 'ev.tool_event', sessionId: p.data.sessionId, callId: 'c-' + tool, phase: 'args', tool })
    const group = stepGroups(p)[stepGroups(p).length - 1]
    assert.equal(group.items[group.items.length - 1].cat, label, `${tool} 必须映射成「${label}」`)
  }
})

test('步骤：行首渲染的是 cat（老数据没有 cat 才回退英文名）', () => {
  const wxml = fs.readFileSync(
    path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'),
    'utf8',
  )
  assert.match(wxml, /\{\{it\.cat \|\| it\.tool\}\}/, '行首必须是 cat 优先')
})

// ── 瞬时提示的过期清理 + 与待办条合并（2026-10-06 下午用户实测三连） ──
//
// 1. retry 成功后提示既不更新也不消失：run_state 的 idle 是跳变帧，退后台期间
//    错过就没了，提示永远挂着。列表（全量快照，每 15 秒一推）说没跑，提示就是过期遮罩。
// 2. 顶部 retry 行与待办条叠在一起互相抢：一屏一次只说一件事，有待办时提示进待办条的状态位。

test('瞬时提示：列表说这条会话没跑了，提示必须走（错过的 idle 帧由快照兜底）', () => {
  const p = readyAtBottom()
  send(p, { t: 'ev.retry', sessionId: p.data.sessionId, attempt: 2, max: 5, reason: 'TIMEOUT' })
  assert.ok(p.data.notice, '夹具自检：提示在')
  p._onEvent({
    kind: 'payload',
    payload: { t: 'ev.session_changed', sessions: [{ id: p.data.sessionId, running: false }] },
  })
  assert.equal(p.data.notice, '', '列表说没跑了，挂着的"正在重试"就是过期遮罩')
})

test('瞬时提示：列表说还在跑，不清（别把真提示当过期掐掉）', () => {
  const p = readyAtBottom()
  send(p, { t: 'ev.compaction', sessionId: p.data.sessionId, state: 'started' })
  p._onEvent({
    kind: 'payload',
    payload: { t: 'ev.session_changed', sessions: [{ id: p.data.sessionId, running: true }] },
  })
  assert.equal(p.data.notice, '正在压缩上下文', '还在跑就说明压缩还没完')
})

test('瞬时提示：断链重连后清掉（断链期间世界可能变了，真相由列表与历史重建）', () => {
  const p = readyAtBottom()
  send(p, { t: 'ev.retry', sessionId: p.data.sessionId, attempt: 1, max: 3 })
  assert.ok(p.data.notice, '夹具自检：提示在')
  p._wasOffline = true
  p._onEvent({ kind: 'status', status: 'online' })
  assert.equal(p.data.notice, '', '重连后旧提示必须走，还在跑的话新帧会再来')
})

test('顶栏合并：有待办时提示进待办条的状态位，不单独占一行', () => {
  const wxml = fs.readFileSync(
    path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/chat/chat.wxml'),
    'utf8',
  )
  assert.match(wxml, /wx:if="\{\{notice && !todos\.length\}\}"/, '独立提示行只在没有待办时渲染')
  assert.match(wxml, /wx:if="\{\{notice\}\}".*todo-running/, '待办条状态位优先显示提示')
})

test('顶栏合并：提示不碰待办数据（显示合并，数据各管各的）', () => {
  const p = readyAtBottom()
  p._onEvent({
    kind: 'payload',
    payload: {
      t: 'ev.todo',
      sessionId: p.data.sessionId,
      todos: [{ content: '做一件事', status: 'in_progress' }],
    },
  })
  send(p, { t: 'ev.retry', sessionId: p.data.sessionId, attempt: 2, max: 5 })
  assert.equal(p.data.todos.length, 1, '提示来了待办不能动')
  assert.equal(p.data.todoRunningText, '进行中 做一件事', '待办派生值不受提示影响')
  assert.equal(p.data.notice, '正在重试 2/5', '提示正常落位')
})

// ── get_pending 调用点（2026-10-06 下午）：进会话与重连各拉一次 ──
//
// peer-joined 重发只发生在重配对；普通重连主机收不到信号。手机拉（fire-and-forget，
// 老主机静默丢）。不断言帧内容（那是主机测的 + 真链路 6b 测的），只断言拉了。

test('进会话拉一次挂起卡（onShow → getPending，带本会话 id）', () => {
  const p = readyAtBottom()
  stubClient(p, () => Promise.resolve(null))
  const pulled = []
  p.client.getPending = (sessionId) => {
    pulled.push(sessionId)
    return true
  }
  p.onShow()
  assert.deepEqual(pulled, [p.data.sessionId], '进会话必须问一次主机还有什么挂着')
})

test('重连成功拉一次挂起卡（断链期间挂上的那一帧已经过去了）', () => {
  const p = readyAtBottom()
  stubClient(p, () => Promise.resolve(null))
  const pulled = []
  p.client.getPending = (sessionId) => {
    pulled.push(sessionId)
    return true
  }
  p._wasOffline = true
  p._onEvent({ kind: 'status', status: 'online' })
  assert.deepEqual(pulled, [p.data.sessionId], '重连后必须重新问一次')
})

// ═══════════════════════════════════════════════════════════════════════
// rc1 前的缺陷修复判据（2026-10-06 晚）—— 每一条都在旧实现上先验过会红
// ═══════════════════════════════════════════════════════════════════════

/**
 * 一段"典型长回复"：标题 / 段落 / 行内代码 / 粗体 / 列表都占全，
 * markdown 排出来的 nodes 是原文的 **14.2 倍**（实测 19900 字符 → 281687 字符 JSON，
 * 与真机取证的 13.7 倍同一个量级）。纯 `'x'.repeat(n)` 是压不出这个倍数的 ——
 * 那样 nodes 里就一个 text 节点，套不出"单次 setData 顶过 1MB"这件事。
 */
function longMarkdown(chars) {
  const lines = []
  for (let i = 0; lines.join('\n').length < chars; i++) {
    lines.push('### 第 ' + i + ' 节：`core/client.js` 里的 **' + i + '** 号问题')
    lines.push('')
    lines.push('这一节说明第 ' + i + ' 个改动点，涉及 `store.nextNonceFor()` 与 `_resume` 的关系，以及为什么不能回退计数器。')
    lines.push('')
    lines.push('- 第一条：**必须**保留 ' + i)
    lines.push('- 第二条：`code-' + i + '` 的语义')
    lines.push('')
  }
  return lines.join('\n').slice(0, chars)
}

/** 记下页面每一次 setData 的负载（判据读的是"渲染层真正收到的那一份"） */
function recordPatches(p) {
  const patches = []
  const orig = p.setData
  p.setData = (patch, cb) => {
    patches.push(patch)
    orig(patch, cb)
  }
  return patches
}

test('缩图画布：exec 的回调是异步的 —— 第一次就要拿到节点，null 不许被缓存死', async () => {
  // 旧实现把节点赋在 exec 的回调里、却在 exec() 之后同步读它：读到的永远是 null，
  // 而且这个 null 被缓存进 `_canvasNode`（首行 `!== undefined` 直接返回），
  // 于是**整页生命周期一次都没缩过图**。夹具旧写法（同步回调）恰好掩盖了它。
  const p = makePage()
  const got = []
  p._shrinkCanvas((n) => got.push(n ? 'node' : null))
  assert.deepEqual(got, [], '夹具自检：exec 的回调必须是异步的（同步就说明这条判据验不到时序）')
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(got, ['node'], '异步回调里必须把节点交出来；读到 null 就是"永远拿不到画布"')

  // 第二次走缓存，也要给得出来（缓存的是**节点**，不是首帧那个 null）
  p._shrinkCanvas((n) => got.push(n ? 'node' : null))
  assert.deepEqual(got, ['node', 'node'], '缓存里必须是节点：缓存了 null 就等于整页禁用缩图')
})

test('图片附件：异步画布下"钉死长边"这一步真的跑了（Android 只靠这一步压体积）', async () => {
  const p = makePage()
  globalThis.__drcPick = { width: 3000, height: 4000 }
  globalThis.__drcShrunk = undefined
  p.setData({ sessionId: 's1' })
  p.onAttach()
  await settleAttach()
  assert.deepEqual(
    globalThis.__drcShrunk,
    { w: 1200, h: 1600, quality: 0.6, fileType: 'jpg' },
    '3000x4000 的图必须过画布缩到 1600 长边；不做这一步，Android 上 quality 被忽略 → 压完还是几 MB',
  )
  assert.match(p.data.attachments[0].path, /^tmp-shrunk-/, '进附件的必须是缩完那个文件')
})

test('容器没有 compressImage：加号选图不许抛 TypeError，要一路降级到画布/原文件', async () => {
  const p = makePage()
  const env = require(path.join(ROOT, 'dsh-remote-mp/miniprogram/core/env.js'))
  const real = globalThis.wx.compressImage
  globalThis.wx.compressImage = undefined
  env.probe(true) // 能力探测带缓存：必须强制重采（与 mp-pairing 里那条 scanCode 判据同一套手法）
  try {
    globalThis.__drcPick = { width: 3000, height: 4000 }
    globalThis.__drcShrunk = undefined
    p.setData({ sessionId: 's1' })
    assert.doesNotThrow(() => p.onAttach(), '老容器上没有 compressImage：硬调就是一句 TypeError，用户看到的是"加不进来"')
    await settleAttach()
    assert.equal(p.data.attachments.length, 1, '降级之后图照样要能加进来')
    assert.ok(globalThis.__drcShrunk, '降级路径是"直接进画布"，不是"什么都不做"')
  } finally {
    globalThis.wx.compressImage = real
    env.probe(true)
  }
})

test('setData 负载：块上不许带第二份 markdown nodes，且长正文的一次提交要有界', () => {
  const p = makePage()
  p.setData({ sessionId: 's1' })
  const patches = recordPatches(p)
  const body = longMarkdown(19000)
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm1', delta: body, done: true })
  p._flushDelta()

  // ⚠️ 末条 patch 是 `_commit` 之后那次 `toView`（滚到底的锚点翻面），
  // 所以取"最后一次带块流的提交"。
  const patch = patches.filter((x) => x.blocks).pop()
  assert.ok(patch, '夹具自检：这一拍必须是一次块流提交')
  const blocksJson = JSON.stringify(patch.blocks)
  assert.ok(
    !blocksJson.includes('"_md"'),
    '块流里还带着 `_md`：同一份 nodes 进了两次 setData（一条 20000 字正文约 550KB）',
  )
  assert.ok(
    blocksJson.length < body.length + 2000,
    `块流本身不该因为 nodes 膨胀：${blocksJson.length} 字符 vs 正文 ${body.length}`,
  )
  assert.equal(Object.keys(patch.mdBodies || {}).length, 1, '渲染层要的那份 nodes 必须在 mdBodies 里')
  assert.ok(
    JSON.stringify(patch).length < 700 * 1024,
    `单次 setData 的负载要有界（硬上限 1MB，超了静默丢弃）：实得 ${JSON.stringify(patch).length}`,
  )
})

test('正文总量封顶：四条 20000 字回复不许把 setData 顶过 1MB，被截的段要明说', () => {
  // 块数上限（MAX_BLOCKS）管不到字节：400 块正文能到好几 MB。这条按"新内容优先"
  // 从旧到新截断，最新那段永远完整，旧的换成一句明说被省略的提示。
  const p = makePage()
  p.setData({ sessionId: 's1' })
  const patches = recordPatches(p)
  const body = longMarkdown(19900)
  for (let i = 0; i < 4; i++) {
    send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm' + i, delta: body, done: true })
    p._flushDelta()
  }
  const patch = patches.filter((x) => x.blocks).pop()
  assert.ok(patch, '夹具自检：必须有块流提交')
  const texts = patch.blocks.filter((b) => b.kind === 'text')
  assert.equal(texts.length, 4, '夹具自检：四条正文都在块流里')
  const total = texts.reduce((n, b) => n + b.text.length, 0)
  assert.ok(total <= 30000 + 4 * 200, `正文总量必须封顶，实得 ${total} 字符`)
  assert.ok(
    texts.filter((b) => /已省略/.test(b.text)).length >= 1,
    '被截断的段必须换成一句明说的提示（静默丢内容比不显示更糟）',
  )
  assert.equal(texts[3].text, body, '最新那段必须完整（用户正在读的就是它）')
  assert.ok(
    JSON.stringify(patch).length < 700 * 1024,
    `四条长正文的一次提交必须仍在半程以内：实得 ${JSON.stringify(patch).length}`,
  )
})

test('裁剪：省略提示块不参与计数（否则每帧都报同一条数，且条数永远不收敛）', () => {
  const p = makePage()
  for (let i = 0; i < 400; i++) {
    p._commit(p._append(p.data.blocks, { key: 'x' + i, kind: 'text', msgId: 'g' + i, text: 'x', done: true }))
  }
  assert.equal(p.data.blocks.length, 400, '夹具自检：刚好到上限')
  p._commit(p._append(p.data.blocks, { key: 'x400', kind: 'text', msgId: 'g400', text: 'x', done: true }))
  assert.equal(p.data.blocks.length, 401, '裁剪到上限 + 1 条说明')
  assert.match(p.data.blocks[0].text, /已省略较早的 1 个片段/)
  // 第 402 条：真实被挤掉的**内容**是第 2 条。旧实现把上一轮那条提示也算进 dropped，
  // 于是这里报的还是 2 而且永远停在 2（用户看不出到底省了多少）。
  p._commit(p._append(p.data.blocks, { key: 'x401', kind: 'text', msgId: 'g401', text: 'x', done: true }))
  assert.equal(p.data.blocks.length, 401, '长度必须收敛在 MAX_BLOCKS + 1')
  assert.match(p.data.blocks[0].text, /已省略较早的 2 个片段/, '提示块自己不参与计数')
  for (let i = 402; i < 407; i++) {
    p._commit(p._append(p.data.blocks, { key: 'x' + i, kind: 'text', msgId: 'g' + i, text: 'x', done: true }))
  }
  assert.equal(p.data.blocks.length, 401, '再来五条，长度照旧')
  assert.match(p.data.blocks[0].text, /已省略较早的 7 个片段/, '每多一条内容只多省略一条：不许停在 2')
})

test('用户回显：主机把一条长消息切成多帧回传时，屏幕上只能有一块', () => {
  const p = makePage()
  stubReceipt(p, { ok: true })
  const whole = 'A'.repeat(9000)
  p.setData({ sessionId: 's1', inputText: whole })
  p.onSend()
  assert.equal(p.data.blocks.filter((b) => b.kind === 'user').length, 1, '夹具自检：本地立刻回显一整条')

  // 主机按合帧窗口切帧（>4096 字符必切），最后一片才带 done；
  // 旧实现把**半截缓冲**就拿去匹配，永远对不上 → 追加成第二、第三条用户块。
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'mu', role: 'user', delta: whole.slice(0, 4096), done: false })
  p._flushDelta()
  assert.equal(
    p.data.blocks.filter((b) => b.kind === 'user').length,
    1,
    '半截缓冲不许落成新块（同一条消息会出现两三条半截的用户块）',
  )
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'mu', role: 'user', delta: whole.slice(4096), done: true })
  p._flushDelta()
  const users = p.data.blocks.filter((b) => b.kind === 'user')
  assert.equal(users.length, 1, '整条到齐之后仍然只有一块')
  assert.equal(users[0].text, whole, '匹配的是整条原文')
  assert.equal(users[0].confirmed, true, '要标成已确认')
})

/**
 * 同一条消息主机会回传**两次**，屏幕上只能有一块（用户 2026-10-06 截图：第 3 轮两条一样的用户消息）。
 *
 * 现场形状（session log 取证）：一条手机消息产生两条内核事件——
 * `agent/inbox/spliced`（seq4155，排队）与 `user/message`（seq4179，落定），
 * 两条带**同一个 messageId**（f71ae5a5…）。主机把两者都出站成 role=user 的 delta，
 * 而 `_onUserEcho` 的兜底动作是"再画一个气泡"，于是第二条把本地回显旁边又画了一份。
 */
test('同一条消息被主机回传两次（inbox + user/message）：屏幕上只能有一块', () => {
  const p = makePage()
  stubReceipt(p, { ok: true })
  p.setData({ sessionId: 's1', inputText: '测试一下审批卡' })
  p.onSend()
  assert.equal(p.data.blocks.filter((b) => b.kind === 'user').length, 1, '夹具自检：本地立刻回显一条')

  // 第一次（inbox）：把本地回显标成已确认
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'mu1', role: 'user', delta: '测试一下审批卡', done: true })
  p._flushDelta()
  const users1 = p.data.blocks.filter((b) => b.kind === 'user')
  assert.equal(users1.length, 1, '第一次回传就把本地回显结算掉了')
  assert.equal(users1[0].confirmed, true, '要标成已确认')

  // 第二次（user/message，同一个 messageId）：必须被吃掉
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'mu1', role: 'user', delta: '测试一下审批卡', done: true })
  p._flushDelta()
  const users2 = p.data.blocks.filter((b) => b.kind === 'user')
  assert.equal(users2.length, 1, `同一条消息在屏幕上出现了 ${users2.length} 次：重复显示没修掉`)
  assert.equal(users2[0].text, '测试一下审批卡')

  // 另一条消息照常显示（去重键是 messageId，不是"最近一条"）
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'mu2', role: 'user', delta: '再来一条', done: true })
  p._flushDelta()
  assert.equal(p.data.blocks.filter((b) => b.kind === 'user').length, 2, '把不同消息也吃掉就是另一个 bug 了')
})

/**
 * 桌面侧排队的消息本地**没有回显**，两次回传也只该出现一块。
 *
 * 与上一条同源、不同触发路径：主机的 inbox 与 user/message 都对，用户在 DSH 桌面里
 * 敲的字只经主机到达手机一次语义，却会被回传两遍。
 */
test('桌面排队消息（本地无回显）：两次回传也只画一块', () => {
  const p = makePage()
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'dk1', role: 'user', delta: '桌面里敲的', done: true })
  p._flushDelta()
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'dk1', role: 'user', delta: '桌面里敲的', done: true })
  p._flushDelta()
  const users = p.data.blocks.filter((b) => b.kind === 'user')
  assert.equal(users.length, 1, `本地没有回显时两次回传画了 ${users.length} 块`)
  assert.equal(users[0].confirmed, true)
})

test('历史回放：与屏幕上已有内容交错时，按页内锚点对齐（不许 m3 排到 m1 前面）', async () => {
  // 现场形状：会话正在跑，屏幕上已经有实时来的 m1 与 c2；历史第一页里
  // 既有更早的 c1（没渲染过），也有更晚的 m3（也没渲染过）。
  // 旧实现把这批"新块"整批拼在 `this.data.blocks` 之前 → c1/m3 跑到 m1/c2 前面。
  const p = makePage()
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm1', delta: '第一段。', role: 'assistant', done: true })
  p._flushDelta()
  send(p, { t: 'ev.tool_event', sessionId: 's1', callId: 'c2', tool: 'Bash', phase: 'completed', resultPreview: 'ok2' })
  stubClient(p, () =>
    Promise.resolve({
      sessionId: 's1',
      cmdId: 'c1',
      items: [
        { t: 'ev.tool_event', callId: 'c1', tool: 'Read', phase: 'completed', resultPreview: 'ok1' },
        { t: 'ev.message_delta', messageId: 'm1', delta: '第一段。', role: 'assistant', done: true },
        { t: 'ev.tool_event', callId: 'c2', tool: 'Bash', phase: 'completed', resultPreview: 'ok2' },
        { t: 'ev.message_delta', messageId: 'm3', delta: '第三段。', role: 'assistant', done: true },
      ],
    }),
  )
  p._maybeLoadHistory()
  await flush()

  const seq = p.data.blocks.map((b) => {
    if (b.kind === 'text') return b.msgId
    if (b.kind === 'steps') return 'steps:' + b.items.map((it) => it.callId).join(',')
    return b.kind
  })
  const at = (needle) => seq.findIndex((s) => String(s).includes(needle))
  assert.ok(at('m1') >= 0 && at('m3') >= 0, `夹具自检：两块正文都要在：${JSON.stringify(seq)}`)
  assert.ok(at('c1') < at('m1'), `更早的工具组 c1 必须排在 m1 之前：${JSON.stringify(seq)}`)
  assert.ok(at('c2') < at('m3'), `页内更晚的 m3 必须排在 c2 之后（旧实现会排到最前面）：${JSON.stringify(seq)}`)
  assert.equal(seq.filter((s) => s === 'm1').length, 1, '与实时重复的那条不许变成两块')
})

test('历史读不到：loadHistory 抛错也要把 loading 复位（不许永远转圈）', async () => {
  const p = makePage()
  stubClient(p, () => Promise.reject(new Error('页形状不对')))
  await p._loadHistory(null)
  await flush()
  assert.equal(p.data.historyState, 'error', 'then 里抛错而没 catch：historyState 永远停在 loading，只能退出重进')
  assert.equal(p._historyBusy, false, '忙标志也必须复位，否则之后每次重连都被它挡在门外')
})

test('卡片倒数：onHide 停表、onShow 必须重启（否则回前台是停住的旧秒数）', () => {
  const p = makePage()
  send(p, {
    t: 'ev.permission_request',
    sessionId: 's1',
    requestId: 'rq_show',
    action: 'Bash',
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
  })
  assert.ok(p._cardTimer, '夹具自检：卡挂了就该有表')
  p.onHide()
  assert.equal(p._cardTimer, null, 'onHide 要停表（定时器不许带到别的页）')
  p.onShow()
  assert.ok(p._cardTimer, '还有卡挂着就必须重启表：老宿主下从后台回来是停住的旧秒数')
  assert.ok(p.data.pendingPermission.remainSec > 0, '重启之后立刻算出当前剩余秒数')
  p._stopCardTick()
})

test('审批答掉时那表只停"两张卡都没了"：提问卡还挂着就继续走秒', async () => {
  const p = makePage()
  const sent = []
  p.client = { resolvePermission: (...a) => sent.push(a), interrupt() {} }
  send(p, {
    t: 'ev.permission_request',
    sessionId: 's1',
    requestId: 'rq_p',
    action: 'Bash',
    options: [{ id: 'approve', label: '允许' }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  send(p, {
    t: 'ev.question_request',
    sessionId: 's1',
    requestId: 'q_p',
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    questions: [{ id: 'x', question: '要哪个' }],
  })
  p.onPermissionTap({ currentTarget: { dataset: { decision: 'approve' } } })
  assert.equal(sent.length, 1)
  assert.ok(p.data.pendingQuestion, '夹具自检：提问卡还在')
  assert.ok(p._cardTimer, '两张卡共用一条表：审批答掉不该把提问卡的倒计时冻住')
  // 提问卡也没了之后，表由 tick 自己收（下一次醒来发现没有活着的卡就停）
  p.setData({ pendingQuestion: null })
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal(p._cardTimer, null, '两张都没了才停表（表自己收，不许提前冻住另一张）')
})

test('退页（onUnload）也要清掉待刷的 delta 定时器：不许 setData 到已销毁的页面', async () => {
  const p = makePage()
  const patches = recordPatches(p)
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm_late', delta: '还差一秒就 flush', done: false })
  assert.ok(p._deltaTimer, '夹具自检：定时器排上了')
  const before = patches.length
  p.onUnload()
  assert.equal(p._deltaTimer, null, 'onUnload 必须与 onHide 一样清掉它')
  await new Promise((r) => setTimeout(r, 160))
  assert.equal(patches.length, before, '退页之后还有 setData 落到已销毁的页面上')
})

test('点消息区收键盘：catchtap 截断了冒泡，onCollapseTodos 必须自己接上', () => {
  const p = makePage()
  p.setData({ inputFocus: true })
  p.onCollapseTodos()
  assert.equal(p.data.inputFocus, false, '消息区是最常点的空白：收键盘不能只靠外层冒泡（它被 catchtap 截断了）')
  // 待办面板那半件事照旧
  p.setData({ todosOpen: true, inputFocus: true })
  p.onCollapseTodos()
  assert.equal(p.data.todosOpen, false)
  assert.equal(p.data.inputFocus, false)
})

test('vendor/marked：UMD 导出键必须是合法标识符，walkTokens 不许被打成 walkTokens}', () => {
  // 文件头曾经指向一个不存在的 scripts/check-marked-vendor.mjs。这条判据就是那个脚本
  // 要守的东西：导出键写坏时 `require` 得到的是 `walkTokens}` 这种键，
  // `marked.walkTokens` 是 undefined —— 调用方只会看到一句 not a function。
  const target = path.join(ROOT, 'dsh-remote-mp/miniprogram/core/vendor/marked.js')
  const marked = require(target)
  const bad = Object.keys(marked).filter((k) => !/^[A-Za-z_$][\w$]*$/.test(k))
  assert.deepEqual(bad, [], `导出键里有非法标识符：${bad.join(',')}（marked 升级时 UMD 尾巴要重打）`)
  assert.equal(typeof marked.walkTokens, 'function', 'walkTokens 缺失：导出键被打坏过（walkTokens}）')
  assert.equal(typeof marked.lexer, 'function', 'markdown.js 只调 lexer()，它必须在')
  assert.equal(typeof marked.parse, 'function')
  // 版本号要对得上：文件头写的 v18.0.14 与产物里自带的那行注释必须是同一个版本
  const src = fs.readFileSync(target, 'utf8')
  const versions = [...src.matchAll(/marked v(\d+\.\d+\.\d+)/g)].map((m) => m[1])
  assert.ok(versions.length >= 2, `版本号至少要出现两次（文件头 + 产物注释），实得 ${JSON.stringify(versions)}`)
  assert.equal(new Set(versions).size, 1, `文件头与产物的版本号不一致：${JSON.stringify(versions)}`)
})

test('正文 nodes 要在后续提交里活下来（块上那份 _md 已经不进 setData 了）', () => {
  // 这是"剥掉 `_md`"这个修法的**配套护栏**：nodes 现在缓存在页面实例的 `_mdNodes`
  // 上，而收卡 / 工具事件 / 运行态这些提交走的是 `this.data.blocks`（里面已经没有
  // `_md` 了）。缓存掉了的话，正文会在下一次无关提交时**整段从界面上消失**
  // —— data 里 mdBodies 空掉，wxml 退回纯文本那一支，而判据若不看后续提交就全绿。
  const p = makePage()
  send(p, { t: 'ev.message_delta', sessionId: 's1', messageId: 'm1', delta: '**结论**：没问题。', role: 'assistant', done: true })
  p._flushDelta()
  const block = p.data.blocks.find((b) => b.kind === 'text' && b.msgId === 'm1')
  assert.ok(block && !('_md' in block), '夹具自检：块上不许再带 _md')
  const nodesBefore = p.data.mdBodies[block.key]
  assert.ok(nodesBefore, '夹具自检：这一拍应该有 nodes')

  // 一次与正文无关的提交（工具事件 → run_state idle），正文必须原样还在
  send(p, { t: 'ev.tool_event', sessionId: 's1', callId: 'c9', tool: 'Bash', phase: 'completed', resultPreview: 'ok' })
  assert.deepEqual(p.data.mdBodies[block.key], nodesBefore, '工具事件提交之后正文 nodes 丢了（段落会退回纯文本）')
  send(p, { t: 'ev.run_state', sessionId: 's1', state: 'idle' })
  assert.deepEqual(p.data.mdBodies[block.key], nodesBefore, '运行态提交之后正文 nodes 丢了')
  assert.equal(p.data.blocks.find((b) => b.msgId === 'm1').text, '**结论**：没问题。', '正文原文也不能被动过')
})

// ── 2026-06 用户复访报的三条 ──────────────────────────────────────────────
//   1) 待办全部做完、dsh 已经关闭了，mp 端还在显示
//   2) retry 成功之后，mp 端的 retry 还显示
//   3) 重连和重新进入 session 都应该直接滚到底部，不要记住"读到哪儿"
// 三条都是"瞬时状态没有收尾"或"行为与约定不符"，每条先红后绿。

test('待办：一轮结束（run 回到 idle）就清掉，别把上一轮的清单一直挂着', () => {
  const p = readyAtBottom()
  p._onEvent({
    kind: 'payload',
    payload: {
      t: 'ev.todo',
      sessionId: 's1',
      todos: [
        { content: '读完 handoff', status: 'completed' },
        { content: '实现落盘', status: 'completed' },
      ],
    },
  })
  assert.equal(p.data.todos.length, 2, '夹具自检：清单先落上')
  assert.equal(p.data.todoDone, 2)

  // dsh 那一轮跑完了
  p._onEvent({ kind: 'payload', payload: { t: 'ev.run_state', sessionId: 's1', state: 'idle' } })

  assert.equal(
    p.data.todos.length,
    0,
    '一轮都结束了，待办条还挂着：用户看到的是一件已经做完的事（2026-06 复访报的第 1 条）',
  )
  assert.equal(p.data.todosOpen, false, '收起：留一个展开的空面板更怪')
})

test('待办：正在跑的时候不许清（那样就退回到"永远看不到"了）', () => {
  const p = readyAtBottom()
  p._onEvent({
    kind: 'payload',
    payload: { t: 'ev.todo', sessionId: 's1', todos: [{ content: '做一件事', status: 'in_progress' }] },
  })
  p._onEvent({ kind: 'payload', payload: { t: 'ev.run_state', sessionId: 's1', state: 'running' } })
  assert.equal(p.data.todos.length, 1, '跑到 idle 才清，running 时必须留着')
})

test('retry：重试成功、开始出字之后，那句「正在重试」必须消失', () => {
  const p = readyAtBottom()
  p._onEvent({ kind: 'payload', payload: { t: 'ev.run_state', sessionId: 's1', state: 'running' } })
  p._onEvent({
    kind: 'payload',
    payload: { t: 'ev.retry', sessionId: 's1', attempt: 2, max: 5, reason: 'TRANSPORT' },
  })
  assert.equal(p.data.notice, '正在重试 2/5 · TRANSPORT', '夹具自检：提示先挂上')

  // 重试成功了 → 模型开始出字。注意这一轮**还在跑**，
  // 所以「回到 idle 才清」那条路径根本不会触发（2026-06 复访报的第 2 条）。
  p._onEvent({ kind: 'payload', payload: { t: 'ev.message_delta', sessionId: 's1', messageId: 'm1', delta: '答' } })
  p._flushDelta()

  assert.equal(
    p.data.notice,
    '',
    '已经在出字了还挂着"正在重试"：用户以为还在重试，而答案都出来了',
  )
})

test('retry：工具事件同样算"恢复生产"的信号', () => {
  const p = readyAtBottom()
  p._onEvent({ kind: 'payload', payload: { t: 'ev.run_state', sessionId: 's1', state: 'running' } })
  p._onEvent({ kind: 'payload', payload: { t: 'ev.retry', sessionId: 's1', attempt: 1, max: 3 } })
  assert.ok(p.data.notice.indexOf('正在重试') === 0)
  p._onEvent({
    kind: 'payload',
    payload: { t: 'ev.tool_event', sessionId: 's1', callId: 'c1', phase: 'args', name: 'read_file' },
  })
  assert.equal(p.data.notice, '', '工具又跑起来了，重试早就结束了')
})

test('滚动：重连后也要到底部（不要停在"读到哪儿"）', async () => {
  const p = readyAtBottom()
  const calls = stubClient(p, () => Promise.resolve({ sessionId: 's1', cmdId: 'c1', items: HISTORY_PAGE }))
  // 进页面（已在线）→ 读一页历史，停在底部
  feedStatus(p, 'online')
  await flush()
  // 用户往上翻了一大段，正在读旧内容
  p.onScroll({ detail: { scrollLeft: 0, scrollTop: 100, scrollHeight: 4000, deltaY: -300 } })
  assert.equal(p.data.atBottom, false, '夹具自检：用户正在回看')
  calls.length = 0

  // 断链 → 重连
  feedStatus(p, 'connecting', '连接已断开，正在重连…')
  feedStatus(p, 'online')
  await flush()

  assert.equal(
    p.data.atBottom,
    true,
    '重连后没回到底部（用户报的第 3 条）——约定是重连与重新进入都直接到底部',
  )
})


/* ── 发送前的帧预算闸：附件算过了，正文没人算过 ─────────────────────── */

// 512 KiB 原始字节的标准 base64 长度：ceil(524288/3)*4。
// 用真长度而不是随手一个 700K —— 估算函数的输入必须与线格式对上，
// 否则判据量的是一个现实中不存在的帧。
const FULL_512KB_B64 = Math.ceil((512 * 1024) / 3) * 4


test('回归：512KB 附件 + 长正文会顶过中继 1MB 硬帧上限，必须在发送前拦下（2026-10-06 审计）', async () => {
  // 附件那两道闸只算附件，于是这个组合没人管：实测线上帧 1 055 304B > 1 MiB，
  // 中继以 1009 关掉**整条连接**，用户看到的是"发出去就掉线"——正是这一页注释里
  // 写着"绝不能让它变成莫名掉线"的那件事。
  const p = makePage()
  const calls = stubReceipt(p, { ok: true })
  p.setData({ sessionId: 's1' })
  p.setData({
    inputText: 'x'.repeat(120 * 1024),
    attachments: [{ kind: 'file', name: 'a.bin', data: 'A'.repeat(FULL_512KB_B64) }],
  })
  p.onSend()
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(calls.length, 0, '超预算的那一条不该真的发出去')
  assert.equal(p.data.inputText.length, 120 * 1024, '拦下时**不许**清空输入框：清了用户就得重打一遍')
  assert.equal(p.data.attachments.length, 1, '附件也要留着')
})

test('帧预算闸的界：附件顶格时 ~60KB 正文放行、~90KB 正文拦下', async () => {
  const attempt = async (textKB) => {
    const p = makePage()
    const calls = stubReceipt(p, { ok: true })
    p.setData({ sessionId: 's1' })
    p.setData({
      inputText: 'x'.repeat(textKB * 1024),
      attachments: [{ kind: 'file', name: 'a.bin', data: 'A'.repeat(FULL_512KB_B64) }],
    })
    p.onSend()
    await new Promise((r) => setTimeout(r, 0))
    return calls.length
  }
  assert.equal(await attempt(60), 1, '还在预算内的那一条必须发得出去（闸不是墙）')
  assert.equal(await attempt(90), 0, '越界的那一条必须发不出去')
})

test('纯文字的长消息不受附件闸牵连（估高也要够准）', async () => {
  // 闸是按"线上字节"算的，不是"有一个数就拦"：没有附件时，一段正常长度的正文
  // 必须照发，否则这条修复就变成了"长文本也不能发"的新故障。
  //
  // 这条判据还真抓到过一个东西：第一版把 `payload += String(len)` 写进了估算函数，
  // `+=` 见到字符串就变成拼接，于是一条 6 字节的小消息被估成 3.1MB 而当场拦下。
  // **算式要有人真的跑一遍**——盯着纸面上的算术是看不出 `+=` 那一行的。
  const p = makePage()
  const calls = stubReceipt(p, { ok: true })
  p.setData({ sessionId: 's1', inputText: '把这段代码贴给你看看：\n' + 'const x = 1\n'.repeat(2000) })
  p.onSend()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(calls.length, 1, `纯文字正文（${'const x = 1\n'.repeat(2000).length} 字符）被闸误拦了`)
  assert.equal(p.data.inputText, '', '放行时输入框照常清空')
})
