/**
 * mp-pairing — 首页内联的配对流程。
 *
 * 背景：配对曾经是独立一页（pages/pair），后来按「首页直接扫码」的要求删掉了，
 * 扫码 / 粘贴 / 6 位码 / 解除配对全部内联进 sessions 页。**搬一次就等于重写一次**
 * —— 行为很容易丢，而丢了的形态全是静默的：扫了没反应、失败了按钮一直转、
 * 配好了还停在"未配对"。
 *
 * 手法：假的 wx 载入真实页面代码（与 mp-chat-blocks 同一套）。
 */
import { createRequire } from 'node:module'
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 记录所有副作用，供断言查 */
let calls
let scanImpl
let modalImpl

globalThis.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  navigateTo: () => {},
  stopPullDownRefresh: () => {},
  showToast: (o) => calls.push(['toast', o.title]),
  showModal: (o) => {
    calls.push(['modal', o.title, o.content])
    if (modalImpl) modalImpl(o)
  },
  vibrateShort: () => calls.push(['vibrate']),
  setClipboardData: (o) => {
    calls.push(['clipboard', o.data])
    o.success && o.success()
  },
  scanCode: (o) => {
    calls.push(['scanCode'])
    if (scanImpl) scanImpl(o)
  },
  getClipboardData: (o) => {
    calls.push(['getClipboard'])
    if (typeof scanImpl === 'function') return
    o.success && o.success({ data: 'CLIP' })
  },
}

let captured = null
globalThis.Page = (cfg) => {
  captured = cfg
}
require(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/sessions/sessions.js'))
assert.ok(captured, 'Page() 没被调用 —— 页面代码没加载起来')

/**
 * 造出来的页面实例：`afterEach` 里要把它们起的计时器停掉。
 *
 * 为什么必须收：页面代码里有一个 15 秒的「· N 秒前有消息」计时器
 * （`pages/sessions/sessions.js` 的 `_startLinkTick`），只在 `onHide`/`onUnload` 停。
 * 本文件直接调页面方法、从不走小程序的生命周期，于是它会一直 ref 着事件循环 ——
 * `node --test` 等这个文件进程退出时永远等不到（自检实测：19 条全过、进程挂死 5 分钟）。
 * 这是**装置**没收拾干净，不是产品行为有问题；修在装置里，别去改小程序仓。
 */
const pageInstances = []

/** 页面里的 client 换成可控的假货，避免真的去连网 */
function makePage(overrides = {}) {
  const ctx = { ...captured }
  ctx.data = JSON.parse(JSON.stringify(captured.data))
  ctx.setData = (patch) => {
    for (const k in patch) ctx.data[k] = patch[k]
  }
  ctx.client = {
    status: 'idle',
    statusText: '',
    sessions: [],
    hostLabel: '',
    hostId: '',
    server: 'wss://drc.provid.cc',
    psk: '',
    keepAwake: null,
    isPaired: () => false,
    connect: (opts) => calls.push(['connect', opts]),
    unpair: () => calls.push(['unpair']),
    listSessions: () => {},
    on: () => () => {},
    ...overrides,
  }
  pageInstances.push(ctx)
  return ctx
}

/** 一段合法的配对二维码（服务端 + 密钥 [+ 可选 6 位码]） */
function qr({ token = '', psk = 'QUJDREVGRw==', server = 'wss://drc.provid.cc' } = {}) {
  const parts = ['v=1', 's=' + encodeURIComponent(server), 'psk=' + psk, 'n=my-host']
  if (token) parts.push('t=' + token)
  return 'dshr:/p?' + parts.join('&')
}

beforeEach(() => {
  calls = []
  scanImpl = null
  modalImpl = null
})

afterEach(() => {
  // 停掉每个页面实例起的计时器（`_startLinkTick`）与事件订阅：留着它们，
  // 这个测试文件的进程就永远不退出（`node --test` 会一直等）。
  for (const page of pageInstances.splice(0)) {
    if (typeof page._stopLinkTick === 'function') page._stopLinkTick()
    if (typeof page._off === 'function') {
      page._off()
      page._off = null
    }
  }
})

// ── 扫码即连 ──────────────────────────────────────────────────────────

test('扫到带配对码的二维码：直接连，不需要用户再输任何东西', () => {
  const p = makePage()
  scanImpl = (o) => o.success({ result: qr({ token: '042391' }) })

  p.onScan()

  const connect = calls.find((c) => c[0] === 'connect')
  assert.ok(connect, '应该直接发起连接')
  assert.equal(connect[1].token, '042391')
  assert.equal(connect[1].server, 'wss://drc.provid.cc')
  assert.ok(connect[1].psk, '密钥要带上')
  assert.equal(p.data.busy, true, '连的过程中要有可见状态')
  assert.equal(p.data.paired, false, '还没连上，不能提前切成已配对')
})

test('二维码不带配对码：不自动展开，但要说清去哪儿填（2026-10-05：全部默认收起）', () => {
  const p = makePage()
  scanImpl = (o) => o.success({ result: qr({}) })

  p.onScan()

  assert.equal(calls.some((c) => c[0] === 'connect'), false, '没有配对码，连不了')
  assert.equal(p.data.hasPsk, true, '密钥已读到，要能看出来')
  // 原来这里断言 manualOpen===true，理由是"要把输入框露出来"。
  // 现在默认收起（用户：全部场景默认收起），但**不许静默停在半路**——
  // toast 必须说清还差什么、以及去哪儿点，否则用户以为扫完就成了。
  assert.equal(p.data.manualOpen, false, '不该自动展开手动输入区')
  assert.ok(calls.some((c) => c[0] === 'toast'), '要说明还差什么')
  const toast = calls.find((c) => c[0] === 'toast')
  assert.match(String(toast[1] || ''), /手动输入/, `说清了还差配对码，但没告诉用户去哪儿输入：${String(toast[1])}`)
})

test('扫到不是配对码的东西：给完整说明，不能默默失败', () => {
  const p = makePage()
  scanImpl = (o) => o.success({ result: 'https://example.com' })

  p.onScan()

  const modal = calls.find((c) => c[0] === 'modal')
  assert.ok(modal, '认不出来要弹说明')
  assert.match(modal[2], /dshr:\/p\?/, '要说清长什么样')
  assert.equal(calls.some((c) => c[0] === 'connect'), false)
})

test('容器没有扫码能力：不调用 scanCode，展开手动输入并说清原因', () => {
  const p = makePage()
  const realScan = globalThis.wx.scanCode
  // env.probe() **带缓存**（能力不会中途变，没必要每次重连都重探），
  // 所以要让下一次采集看到"没有 scanCode"必须用 onScan 内部那条路径：
  // 直接把 probe 的缓存打掉，再删 API。
  globalThis.wx.scanCode = undefined
  const env = require(path.join(ROOT, 'dsh-remote-mp/miniprogram/core/env.js'))
  env.probe(true) // 强制重采，缓存里 scanCode 变成 false
  try {
    p.onScan()
  } finally {
    globalThis.wx.scanCode = realScan
    env.probe(true) // 还原，别污染后面的用例
  }
  assert.equal(calls.some((c) => c[0] === 'scanCode'), false, '不能去调不存在的 API')
  const modal = calls.find((c) => c[0] === 'modal')
  assert.ok(modal)
  // 默认收起（2026-10-05 用户），但弹窗里要指路 —— 以前是自动展开代替指路，
  // 现在不展开了，指路就得落在文案上，否则用户在这台机器上无路可走。
  assert.equal(p.data.manualOpen, false, '不该自动展开手动输入区')
  assert.match(
    String(modal[2]),
    /手动输入/,
    '没扫码能力却不自动展开，弹窗就必须指路，否则用户无路可走',
  )
})

// ── 粘贴 ──────────────────────────────────────────────────────────────

test('粘贴整段 dshr 串：等价于扫码', () => {
  const p = makePage()
  p.onPaste({ detail: { value: qr({ token: '123456' }) } })
  const connect = calls.find((c) => c[0] === 'connect')
  assert.ok(connect)
  assert.equal(connect[1].token, '123456')
})

test('粘贴纯 6 位数字：当作配对码填上（人们就是这么试的）', () => {
  const p = makePage()
  p.onPasteInput({ detail: { value: '042391' } })
  p.onPasteCommit()
  assert.equal(p.data.token, '042391')
  assert.ok(calls.some((c) => c[0] === 'toast' && c[1] === '已填入配对码'))
})

test('粘贴框只记值、不在每次敲键时解析', () => {
  const p = makePage()
  p.onPasteInput({ detail: { value: 'dshr:/p?eyJ2' } })
  assert.equal(p.data.pasteText, 'dshr:/p?eyJ2', '先老实记着')
  assert.equal(calls.some((c) => c[0] === 'connect'), false, '半截内容不该触发连接')
})

// ── 手动配对 ──────────────────────────────────────────────────────────

test('手动配对三项校验：地址形状、密钥、配对码，缺一都要说清缺什么', () => {
  const p = makePage()
  p.setData({ server: 'drc.provid.cc', psk: 'x', token: '042391' })
  p.onPair()
  assert.ok(calls.some((c) => c[0] === 'toast' && /ws:\/\//.test(c[1])), '地址形状不对要提示')

  calls = []
  p.setData({ server: 'wss://drc.provid.cc', psk: '', token: '042391' })
  p.onPair()
  assert.ok(calls.some((c) => c[0] === 'toast' && /密钥/.test(c[1])))

  calls = []
  p.setData({ server: 'wss://drc.provid.cc', psk: 'x', token: '123' })
  p.onPair()
  assert.ok(calls.some((c) => c[0] === 'toast' && /6 位/.test(c[1])))
  assert.equal(calls.some((c) => c[0] === 'connect'), false, '校验没过不许连')
})

test('手动配对成功发起连接并进入等待态', () => {
  const p = makePage()
  p.setData({ server: 'wss://drc.provid.cc', psk: 'x', token: '042391' })
  p.onPair()
  const connect = calls.find((c) => c[0] === 'connect')
  assert.ok(connect)
  assert.equal(connect[1].token, '042391')
  assert.equal(p.data.busy, true)
})

test('配对码输入只留数字、最多 6 位', () => {
  const p = makePage()
  p.onTokenInput({ detail: { value: '04a2b3911234' } })
  assert.equal(p.data.token, '0423911234'.slice(0, 6))
})

test('手动输入区是开关：默认收起，点了才展开', () => {
  const p = makePage()
  assert.equal(p.data.manualOpen, false, '平时不该占版面')
  p.onToggleManual()
  assert.equal(p.data.manualOpen, true)
  p.onToggleManual()
  assert.equal(p.data.manualOpen, false)
})

// ── 状态流转 ──────────────────────────────────────────────────────────

test('连接成功：切到已配对态、收掉忙碌与手动输入区，并刷新列表', () => {
  const p = makePage()
  let listed = 0
  p.refresh = () => {
    listed++
  }
  p.setData({ paired: false, busy: true, manualOpen: true })

  p._onEvent({ kind: 'status', status: 'online', text: '已连接' })

  assert.equal(p.data.paired, true, '连上了就要换成已配对那套界面')
  assert.equal(p.data.busy, false, '不能让按钮一直转')
  assert.equal(p.data.manualOpen, false, '手动输入区用不上了就收起来')
  assert.equal(listed, 1, '连上就该拉会话列表')
})

test('连接失败：一定要退出忙碌态，否则「正在连接…」停在那儿且没有重试入口', () => {
  const p = makePage()
  p.setData({ busy: true })
  p._onEvent({ kind: 'error', message: '配对码不对' })
  assert.equal(p.data.busy, false, '失败后必须能重试')
})

test('环境类错误用 modal 完整展示，toast 装不下', () => {
  const p = makePage()
  const long = '这个运行环境没有 WebSocket 能力，无法连接中继'
  p._onEvent({ kind: 'error', message: long })
  assert.ok(calls.some((c) => c[0] === 'modal' && c[2] === long))
})

// ── 解除配对 ──────────────────────────────────────────────────────────

test('解除配对要先确认；确认后回到未配对态并清掉凭据', () => {
  const p = makePage()
  p.setData({ paired: true, token: '042391', psk: 'secret', hasPsk: true, hostLabel: 'my-host' })

  modalImpl = (o) => o.success({ confirm: true })
  p.onUnpair()

  assert.ok(calls.some((c) => c[0] === 'modal'), '不能一点就解绑')
  assert.ok(calls.some((c) => c[0] === 'unpair'))
  assert.equal(p.data.paired, false, '要回到未配对界面')
  assert.equal(p.data.token, '')
  assert.equal(p.data.psk, '', '凭据要清干净，不能留在内存里')
  assert.equal(p.data.hasPsk, false)
})

test('解除配对被取消：什么都不做', () => {
  const p = makePage()
  p.setData({ paired: true })
  modalImpl = (o) => o.success({ confirm: false })
  p.onUnpair()
  assert.equal(calls.some((c) => c[0] === 'unpair'), false)
  assert.equal(p.data.paired, true, '误触不能丢配对')
})

// ── 静态护栏：wxml 层面的接线 ─────────────────────────────────────────

test('wxml：未配对态有扫描按钮；已配对态没有重新配对，解除配对在主机卡里', () => {
  const wxml = readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/sessions/sessions.wxml'), 'utf8')
  const unpaired = wxml.split('wx:if="{{paired}}"')[0]
  assert.match(unpaired, /bindtap="onScan"/, '未配对时首要动作就是扫码')
  const paired = wxml.split('wx:if="{{paired}}"')[1]
  // 2026-10-04 用户拍板：**不需要「重新配对」**——先解除再扫码就是重新配对，
  // 多一颗按钮只多一次误触。解除配对同时挪进主机卡（那张卡写的就是这台主机）。
  assert.equal(/重新配对/.test(paired), false, '重新配对入口已按用户要求删除')
  assert.match(paired, /host-danger[^>]*bindtap="onUnpair"/, '解除配对收在主机卡里，不再沉底')
  assert.match(paired, /bindtap="onToggleTheme"/, '主题切换还在')
})

test('页面里不再残留任何跳转配对页的死代码', () => {
  const js = readFileSync(path.join(ROOT, 'dsh-remote-mp/miniprogram/pages/sessions/sessions.js'), 'utf8')
  assert.equal(/pages\/pair/.test(js), false, '配对页已删除，不能再 navigateTo 过去')
  assert.equal(/onGoPair/.test(js), false)
})

/**
 * 用户 2026-10-05 原话：「手动输入默认收起，取消配对后重新连接也是默认收起，
 * 全部场景都是默认收起，不自动展开，除非用户自己手动展开」。
 *
 * 这一条钉的是**那句抱怨本身**指的那条路：配对失效（needs-pair）会把界面带回
 * 扫码态，而那一支原来写死 `manualOpen: true` —— 于是「解配 → 重新连」每次都
 * 顶开一整片输入控件。它与扫码/粘贴那两条是**不同的触发**，所以要单独钉：
 * 少了这条，改了扫码那两处也照样复现。
 */
test('配对失效（解配后重新连）也不自动展开手动输入', () => {
  const p = makePage()
  p.setData({ paired: true, manualOpen: false })
  p._onEvent({ kind: 'status', status: 'needs-pair', text: '会话已失效，请重新扫码配对' })
  assert.equal(p.data.paired, false, '界面要带回扫码态，否则用户没有地方重新配对')
  assert.equal(
    p.data.manualOpen,
    false,
    'needs-pair 又把手动输入自动顶开了：用户报的「取消配对后重新连也是默认收起」就是这一条',
  )

  // 反过来：配对**成功**那一支要主动收起来（连上了就不该还挂着输入区）。
  p.setData({ manualOpen: true, busy: true })
  p._onEvent({ kind: 'status', status: 'online' })
  assert.equal(p.data.manualOpen, false, '连上之后手动输入区应该收起来')
})
