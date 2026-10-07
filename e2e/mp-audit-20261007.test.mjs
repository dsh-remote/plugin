/**
 * mp-audit-2026-10-07 — 一次深审产出的十条缺陷的对照判据。
 *
 * 与既有判据的关系：这一份**全部是"看着正常、其实那一步没执行"**那一族，
 * 而它们抓不到的原因有同一个形状——**判据只断言了状态字段，没断言"那一步有没有真的跑"**：
 *
 * · nonce 那条：判据用 `counter++` 手工喂 nonce，完全绕开了 `_onPaired`；
 * · 空 psk 那条：四条"应当拒绝"的用例**全都同时提供了合法 psk**，只单独破坏一项，
 *   恰好绕开"psk 根本不存在"这一格；
 * · 重连滚动那条：判据断言 `data.atBottom === true`，而 `atBottom` 正是实现自己
 *   `setData` 上去的，与真实视口位置无关——判据被自己的实现喂饱了；
 * · 思考秒表那条：同一份文件里"卡片倒数 onShow 必须重启"有判据，思考秒表没有，
 *   于是它停摆没人知道；
 * · 帧预算那条：所有用例的正文都是纯 ascii（`'x'.repeat(N)`），而膨胀恰恰来自
 *   JSON.stringify 对 `"` `\` 换行的转义——**转义后不变的正文，测不出转义的膨胀**。
 *
 * 手法与 `mp-pair-recovery.test.mjs` 同一套：假的 wx 载入**真实的** mp 源码，
 * 不 mock 被测对象本身（对拍与直接摸内部是这份文件的一部分，见 `codec.nacl`）。
 */
import { createRequire } from 'node:module'
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MP = path.join(ROOT, 'dsh-remote-mp/miniprogram')

// ── wx shim：只装被测路径真正用到的那几个 API ─────────────────────────
const storage = new Map()
const toasts = []
globalThis.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: (o) => toasts.push(o),
  showModal: () => {},
  navigateTo: () => {},
  stopPullDownRefresh: () => {},
  vibrateShort: () => {},
  vibrateLong: () => {},
  hideKeyboard: () => {},
  setNavigationBarTitle: () => {},
  setClipboardData: (o) => o.success && o.success({}),
  createSelectorQuery: () => ({
    select: () => ({
      boundingClientRect: () => ({ exec: () => {} }),
      fields: () => ({ exec: () => {} }),
    }),
  }),
}

/**
 * 每条用例之前**清空 storage**。
 *
 * 为什么这不是洁癖：配对记录是**进程级**的（wx shim 只装一次），而 `hydrate()` 会去读它。
 * 于是前一条用例配过一次对，后一条"从零开始"的用例就带着上一条的 PSK/convId 跑 ——
 * C2 那条要验的恰恰是"没有 psk"，而它拿到的是上一条留下的合法 psk，于是**假红**。
 * 这与「判据依赖的全局状态必须归一」是同一条教训，一次红一片时先问是不是状态没归一。
 */
beforeEach(() => {
  storage.clear()
  toasts.length = 0
})

/**
 * 每条用例之后停掉页面起的**所有**计时器。
 *
 * 为什么必须收：页面代码里有 `setInterval`（思考秒表，1 秒）与 `setTimeout` 链
 * （卡片倒数、delta 刷帧），它们只在 `onHide`/`onUnload` 里停。本文件直接调页面方法、
 * 从不走完整生命周期，于是某个用例忘了收就会让 `node --test` 等这个文件进程退出时
 * **永远等不到**——症状是"19 条全过、进程挂死"（`mp-pairing.test.mjs` 的注释记过同一条）。
 * 那是**装置**没收拾干净，不是产品行为有问题；修在装置里，别去改小程序仓。
 *
 * `loadChatPage` 把造出来的实例记在这里，`afterEach` 逐个收。
 */
const pageInstances = []
afterEach(() => {
  while (pageInstances.length) {
    const p = pageInstances.pop()
    try {
      p.onUnload()
    } catch (e) {
      /* 装置问题：页面还没 onLoad 过。收不到就算了，不是产品行为 */
    }
  }
})

const codec = require(path.join(MP, 'core/codec.js'))
const store = require(path.join(MP, 'core/session-store.js'))
const { DrcClient } = require(path.join(MP, 'core/client.js'))

/**
 * 16 字节的合法 PSK（base64）。
 *
 * ⚠️ **必须正好 16 字节**（`codec.isValidPsk` 的口径，也是协议层 `PSK_BYTES`）。
 * 本文件要真的走 `connect()`，所以这个数会被校验；而
 * `mp-pair-recovery.test.mjs` 那类用例是直接摆字段、从不调 `connect()`，
 * 32 字节的 PSK 在那里也能过 —— 换句话说那份夹具里藏着一个不会被发现的错误。
 */
const TEST_PSK = Buffer.alloc(16, 7).toString('base64')
const RELAY = 'wss://relay.example'

/** 收集一条命令发出的密文，用来对账 nonce。 */
function wireRecorder() {
  const frames = []
  return {
    frames,
    sock: {
      send: (o) => {
        if (o && o.ciphertext) frames.push(o.ciphertext)
        return true
      },
      close: () => {},
    },
  }
}

/** 推进到"刚配对成功、还没发过任何命令"那一刻。 */
function justPaired(convId = 'c_audit') {
  const c = new DrcClient().hydrate()
  const rec = wireRecorder()
  c.sock = rec.sock
  c.server = RELAY
  c.psk = TEST_PSK
  c._onFrame(JSON.stringify({ t: 'paired', sessionId: convId, hostId: 'h1' }))
  return { c, ...rec }
}

// ══════════════════════════════════════════════════════════════════════
// 一、密码学：nonce 计数器绝不回退
// ══════════════════════════════════════════════════════════════════════

test('【C1】中继重放 paired 不许把 nonce 计数器打回 0（密钥流复用）', () => {
  const { c, frames } = justPaired()

  c.sendCmd({ t: 'cmd.list_sessions', cmdId: 'a' })
  c.sendCmd({ t: 'cmd.list_sessions', cmdId: 'b' })
  const used = c._resume.nonceCounter
  assert.equal(used, 3, `两条命令后计数器应为 3（1 = paired 自己那次 + 2），实际 ${used}`)

  // 中继是零知识的：它不需要任何密钥就能重放一个 paired 帧。同一 sessionId。
  c._onFrame(JSON.stringify({ t: 'paired', sessionId: c.convId, hostId: 'h1' }))
  assert.ok(
    c._resume.nonceCounter >= used,
    `重放 paired 把计数器打回了 ${c._resume.nonceCounter}（重放前 ${used}）。` +
      '同一 (psk, convId, installId) 三元组下计数器回退 ⇒ 24 字节 nonce 重复 ⇒' +
      '密钥流复用：相同明文得到逐字节相同的密文，中继 XOR 两条即得明文。' +
      '（`_onPaired` 自己末尾会发一条 list_sessions，所以重放后可以**多**于 ' +
      `${used}，但绝不能少于。）`,
  )

  // 端到端：重放后发出的那条，与重放前发出的那条逐字节相同
  const before = frames[0]
  c.sendCmd({ t: 'cmd.list_sessions', cmdId: 'a' }) // 与第 1 条明文完全相同
  assert.notEqual(
    frames[frames.length - 1],
    before,
    '重放后同一条明文又得到了同一段密文 —— nonce 确实被复用了',
  )
})

test('【C1b】换一个 sessionId 的 paired 是正常重配对，计数器从头开始是对的', () => {
  // 上面那条守卫**不能**写成"任何 paired 都不许动计数器"：主机每次新配对都会换 PSK 与
  // sessionId，那正是计数器该归零的时候。这条判据守住修复的另一半：别把重配对也堵掉。
  const { c } = justPaired()
  c.sendCmd({ t: 'cmd.list_sessions', cmdId: 'a' })
  assert.ok(c._resume.nonceCounter > 0, '前置条件：先用过几次')

  c.psk = Buffer.alloc(16, 9).toString('base64') // 新配对 = 新 PSK
  c._onFrame(JSON.stringify({ t: 'paired', sessionId: 'c_brand_new', hostId: 'h1' }))
  assert.equal(c.convId, 'c_brand_new')
  assert.ok(
    c._resume.nonceCounter < 3,
    `新 session 的计数器应从小开始，实际 ${c._resume.nonceCounter} —— 修复把重配对也堵住了`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// 二、配对入口的形状校验：没有 psk 就是没有，不许因为"空串跳过校验"而通过
// ══════════════════════════════════════════════════════════════════════

test('【C2】connect({server, token}) 不带 psk 必须被拒（空 psk 派生出的 key 中继可自行算出）', () => {
  const c = new DrcClient().hydrate()
  c.connect({ server: RELAY, token: '123456' })

  assert.notEqual(
    c.status,
    'connecting',
    `空 psk 被放行进了连接（status=${c.status}）。derivePskKey('') **不抛**，照常算出 32 字节：` +
      'K = SHA-512("dsh-rc/v1" ␟ c2h ␟ convId ␟ 空)，而 convId、namespace、方向全是公开的 ——' +
      '中继不需要任何秘密就能派生同一把 key。这不是"抛一句英文异常"，是更糟的静默弱密钥。',
  )
  assert.match(c.statusText || '', /密钥|psk|扫码|配对/i, `给的中文原因不对：${c.statusText}`)
  assert.equal(c.psk, '', '被拒之后不该留下一个空 psk')
})

test('【C2b】codec 层：空 psk 派生得出来，所以纪律必须落在配对入口', () => {
  // 这条不是缺陷，是**前提**：它说明为什么 `&&` 短路是真问题。
  // 如果哪天 codec 改成对空串抛异常，这条会红 —— 那时 C2 就变成"英文异常"而不是弱密钥了。
  assert.equal(codec.isValidPsk(''), false, 'isValidPsk("") 必须为 false')
  const k = codec.derivePskKey('', 'c2h', 'c_x')
  assert.equal(k.length, 32, 'derivePskKey("") 照常算出 32 字节（前提成立）')
})

// ══════════════════════════════════════════════════════════════════════
// 三、connect() 的赋值与校验次序：先校验，后提交
// ══════════════════════════════════════════════════════════════════════

test('【S1】已配对时扫到一张坏码：既有配对必须完好如初，且不留下脏 token', () => {
  const { c } = justPaired('c_good')
  assert.ok(c.isPaired(), '前置条件：一开始是已配对的')
  const goodPsk = c.psk
  const goodK = c.kC2H

  // 一张 base64 合法、但解出来不是 16 字节的二维码（parsePairingQr 只查形状，放它过）
  const badPsk = Buffer.alloc(20, 3).toString('base64') // 20 字节：base64 合法但不是 16
  c.connect({ server: RELAY, psk: badPsk, token: '123456' })

  assert.match(c.statusText || '', /密钥|不合法|重新扫码/, `应明说密钥不合法，实际：${c.statusText}`)
  assert.equal(c.psk, goodPsk, '旧的可用 PSK 被那张坏码覆盖了 —— 用户重扫一张好的就能救回来，' +
    '但如果这里被冲掉，那台主机就再也连不上了（主机每次新配对才换 PSK，没有别的来源）')
  assert.equal(c.isPaired(), true, '既有配对被一条没通过校验的输入拆掉了')
  assert.equal(c.kC2H, goodK, '会话密钥被重算了（convId 没变却推出新 key = 数据面全废）')
  assert.equal(c.convId, 'c_good', '会话 id 被换掉了')
  assert.equal(c._pendingToken, null, '被拒之后留着一个脏的待用配对码 —— ' +
    '下一次 hello-ok 会拿它再发一次 pair-begin-client，用户看到的是"解配之后又自己配上了"')
})

test('【S1b】合法重配对：真的换了 PSK 才算数，不许被"一律当坏码"误伤', () => {
  const { c } = justPaired('c_old')
  const newPsk = Buffer.alloc(16, 5).toString('base64')
  c.connect({ server: RELAY, psk: newPsk, token: '123456' })

  assert.equal(c.status, 'connecting', `合法输入应继续连接，实际 ${c.status} / ${c.statusText}`)
  assert.equal(c.psk, newPsk, '合法重配对时新 PSK 必须真的被采纳')
  assert.equal(c._pendingToken, '123456', '合法的配对码要留着等 paired 回来')
})

// ══════════════════════════════════════════════════════════════════════
// 四、enc-batch：畸形 item 不许把异常抛出解帧层；一帧不许烧完两次机会
// ══════════════════════════════════════════════════════════════════════

test('【T2】enc-batch 里的畸形 item 不许让异常逃出 _onFrame', () => {
  const { c } = justPaired()
  c.status = 'online'
  const before = c.status
  // 全部是**形状**不对的 item。注意别把"形状对但解不开"（那属于 T1 那一族）混进来：
  // `ciphertext: 'AAAA'` 是合法 base64 字符串，解不开就是真的解不开，该计一次失败。
  const shapes = [
    { t: 'enc-batch', sessionId: c.convId, items: [null] },
    { t: 'enc-batch', sessionId: c.convId, items: [{ ciphertext: 'AAAA' }, undefined] }, // 两个都不合法形状
    { t: 'enc-batch', sessionId: c.convId, items: [{ ciphertext: 123 }] },
    { t: 'enc-batch', sessionId: c.convId, items: [{}] },
    { t: 'enc-batch', sessionId: c.convId, items: {} }, // items 不是数组
    { t: 'enc-batch', sessionId: c.convId, items: 'not-an-array' },
  ]
  for (const f of shapes) {
    assert.doesNotThrow(
      () => c._onFrame(JSON.stringify(f)),
      `这一帧把异常抛出去了：${JSON.stringify(f)}。_onFrame 只对 JSON.parse 做了 try/catch，` +
        'switch 内部没有保护 —— 而中继是唯一能自由构造畸形帧的人（零知识）。',
    )
  }
  assert.equal(
    c.status,
    before,
    '形状不对的 item 被算成了"密钥不匹配"。它不是 —— 把畸形帧算成解密失败，' +
      '等于让一条坏帧把一个健康配对误杀掉（而这两条正是同一条纪律的两面）。',
  )
})

test('【T1】一帧 enc-batch 里丢 2 条，只算一次机会（不许一帧就把配对丢掉）', () => {
  const { c } = justPaired()
  c.status = 'online'
  const frames = [
    { t: 'enc-batch', sessionId: c.convId, items: [{ ciphertext: '!!junk-1!!' }, { ciphertext: '!!junk-2!!' }] },
  ]
  c._onFrame(JSON.stringify(frames[0]))

  assert.notEqual(
    c.status,
    'needs-pair',
    `一帧 enc-batch 丢 2 条就把配对丢了（${c.statusText}）。"给两次机会免得一条损坏的帧误杀一个健康配对"——` +
      '而在批量帧下"一帧"就等于"两次"。enc-batch 是活路径（server.forwardEncBatch 逐条转发）。',
  )
})

test('【T1b】两帧各丢 1 条 = 真的连续解不开两次 → 这时才该掉配对', () => {
  const { c } = justPaired()
  c.status = 'online'
  for (let i = 0; i < 2; i++) {
    c._onFrame(JSON.stringify({ t: 'enc-batch', sessionId: c.convId, items: [{ ciphertext: `!!junk-${i}!!` }] }))
  }
  assert.equal(
    c.status,
    'needs-pair',
    '连续两帧解不开还不掉配对，那两次机会的承诺就没了 —— 别把 T1 修成"永远不丢"',
  )
})

test('【T1c】直接调 _onEncrypted（不经帧分发）仍然按"一帧一次"计失败', () => {
  // 这条守的是 2026-10-07 修 T1 时踩的一个坑：把计数从 `_onEncrypted` 里搬出去之后，
  // **直接调用它**的那些判据（`mp-client.test.mjs` 第 13 条就是）不再计数，
  // "两次机会"对它们悄悄失效了 —— 全量跑才抓到，而那条红在另一个文件里、与本轮改动
  // 毫无字面关系。所以把契约写死在这里。
  //
  // 契约：默认（不传第二个参数）计一次；只有批量帧那条路显式传 false 才由它自己按帧计。
  const { c } = justPaired()
  c.status = 'online'
  const { codec: cc } = { codec }
  const wrongKey = cc.derivePskKey(c.psk, 'h2c', 'c_000000000000')
  const forged = cc.seal(wrongKey, { t: 'ev.session_changed', sessions: [] }, new Uint8Array(24))

  c._onEncrypted({ sessionId: c.convId, ciphertext: forged.ciphertext })
  assert.notEqual(c.status, 'needs-pair', '一帧解不开不该立刻杀配对')
  c._onEncrypted({ sessionId: c.convId, ciphertext: forged.ciphertext })
  assert.equal(
    c.status,
    'needs-pair',
    '直接调用 _onEncrypted 两次没触发掉配对 —— 默认口径必须仍然计失败。' +
      '（批量帧那条路显式传 false 自己按帧计；这条守的是**默认**那一半。）',
  )
})

test('【T1d】批量帧解不开时也要给出可读提示（不许因为改了计数口径而变静默）', () => {
  const { c } = justPaired()
  c.status = 'online'
  const errors = []
  c.on((e) => {
    if (e.kind === 'error') errors.push(e.message)
  })
  c._onFrame(JSON.stringify({ t: 'enc-batch', sessionId: c.convId, items: [{ ciphertext: '!!junk!!' }] }))
  assert.ok(
    errors.some((m) => String(m).includes('无法解密')),
    `批量帧解不开一声不吭。静默是这一族缺陷里最难查的那种：用户看到的是"手机不响应了"，` +
      `而日志里什么都没有。收到 ${JSON.stringify(errors)}`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// 五、帧预算：宁高勿低
// ══════════════════════════════════════════════════════════════════════

test('【F1】帧预算必须把 JSON.stringify 的转义膨胀算进去（否则闸会放行 1009 断链的帧）', () => {
  // 不复刻 chat.js 的算式（复刻一份就是两份真相，改一处不会红）——
  // 直接问**可观测的口径**：这条正文过不过闸？再与**真 codec.seal** 的实际长度对账。
  const page = loadChatPage()

  const RELAY_MAX = 1024 * 1024
  const CONV = 'c_budget'

  // 真帧：用真 codec.seal 算，与中继看到的形状一致
  const key = codec.derivePskKey(TEST_PSK, 'c2h', CONV)
  const nonce = codec.buildNonce(codec.noncePrefix(TEST_PSK, CONV, 'inst'), 1)
  const text = '"'.repeat(400 * 1024) // 大量引号：JSON.stringify 每个翻倍
  const cmd = { t: 'cmd.send_prompt', cmdId: 'c1', sessionId: 's1', text }
  const real = codec.seal(key, cmd, nonce).ciphertext.length + 200 // +信封

  assert.ok(
    real > RELAY_MAX,
    `前置条件：这条正文真实帧 ${real} > 中继上限 ${RELAY_MAX}，所以它必须被拦住。` +
      '若这条红，说明 codec 或中继上限变了，本条判据的前提要重估。',
  )

  // 页面自己的口径：onSend 在清空输入框**之前**就该拦下来
  const toasts = []
  const savedToast = globalThis.wx.showToast
  globalThis.wx.showToast = (o) => toasts.push(o.title)
  page.data = { inputText: text, attachments: [], attachCount: 0, running: false, sessionId: 's1' }
  page.client = { sendPromptReceipt: () => { throw new Error('不该走到发送') } }
  page._commit = () => {}
  page.scroll = { onScrollToLower: () => {} }
  page.onSend()
  globalThis.wx.showToast = savedToast

  const spoke = toasts.join(' | ')
  assert.match(
    spoke,
    /太大|超|减/,
    `闸放行了这条真实帧 ${real} 字节的正文（> 中继上限 ${RELAY_MAX}）。用户看到的是"发出去就掉线"：` +
      '中继以 1009 关掉整条连接，而 setData({inputText:""}) 已经在拦截前执行过、正文丢了。' +
      '根因：预算只数原始 UTF-8 字节，对 JSON.stringify 把每个引号变成两个字节这层膨胀零感知。' +
      `（纯 ascii 正文转义后不变长，所以既有那条用 'x'.repeat(N) 的判据永远绿。）实际提示：${JSON.stringify(spoke)}`,
  )
  assert.equal(page.data.inputText, text, '拦截必须发生在清空输入框之前，否则用户要重打一遍')
})

// ══════════════════════════════════════════════════════════════════════
// 六、历史回放对带附件的消息也要去重（实时路径已修，历史路径没修）
// ══════════════════════════════════════════════════════════════════════

function loadChatPage() {
  const toasts = []
  globalThis.wx.setClipboardData = (o) => o.success && o.success({})
  globalThis.Page = (cfg) => {
    globalThis.__capturedChat = cfg
  }
  require(path.join(MP, 'pages/chat/chat.js'))
  const p = globalThis.__capturedChat
  p.setData = function (patch, cb) {
    for (const k in patch) {
      const m = k.match(/^(.+?)\[(\d+)\]\[(\d+)\]$/)
      if (m) {
        const arr = this.data[m[1]]
        if (arr && arr[+m[2]]) arr[+m[2]][m[3]] = patch[k]
        continue
      }
      const m2 = k.match(/^(.+?)\[(\d+)\]$/)
      if (m2) {
        const arr = this.data[m2[1]]
        if (arr && arr[+m2[2]]) Object.assign(arr[+m2[2]], patch[k])
        continue
      }
      if (k.startsWith('pendingQuestion.') || k.startsWith('pendingPermission.')) {
        const [head, tail] = k.split('.')
        const cur = this.data[head] || {}
        cur[tail] = patch[k]
        this.data[head] = cur
        continue
      }
      this.data[k] = patch[k]
    }
    if (cb) cb()
  }
  p._toasts = []
  pageInstances.push(p)
  return p
}

/**
 * 绕过 Node 的模块缓存重新载入一份 mp 模块。
 *
 * 为什么需要：被测的页面读的是**全局 wx 的能力集合**（`env.probe()`），
 * 而 `env.js` 自己缓存了 probe 结果、`chat.js` 的模块体也只在第一次 require 时跑一次。
 * 于是"换一个能力不同的宿主再跑一遍"这件事，用裸 `require` 是做不到的 ——
 * 跑的是上一次那份探测结果，判据会**假绿**（A2 就这样红过一次）。
 */
function requireFresh(file) {
  delete require.cache[require.resolve(file)]
  return require(file)
}

/**
 * 装一个能力集合受限的宿主，重新载入 env.js 与 chat.js，让它们看到这份新能力。
 *
 * @param {object} apis 要**额外提供**的 API；不给的那些一律缺席（模拟老基础库）。
 *                 基础那份（storage / 提示类）由 baseWx 兜着。
 */
function installHost(apis) {
  const baseWx = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    setNavigationBarTitle: () => {},
    showToast: () => {},
    showModal: () => {},
    navigateTo: () => {},
    vibrateShort: () => {},
    vibrateLong: () => {},
    hideKeyboard: () => {},
    setClipboardData: (o) => o.success && o.success({}),
    createSelectorQuery: () => ({
      select: () => ({ boundingClientRect: () => ({ exec: () => {} }), fields: () => ({ exec: () => {} }) }),
    }),
  }
  globalThis.wx = { ...baseWx, ...apis }
  requireFresh(path.join(MP, 'core/env.js'))
  globalThis.Page = (cfg) => {
    globalThis.__capturedChat = cfg
  }
  requireFresh(path.join(MP, 'pages/chat/chat.js'))
  return globalThis.__capturedChat
}

/** 屏上有一条本地回显（未确认），历史页里也来了同一条 —— 数最终几个 user 块。 */
function replayUserBlocks(localText, histText) {
  const p = loadChatPage()
  p.scroll = new (require(path.join(MP, 'core/scroll-policy.js')).ScrollPolicy)(() => Date.now())
  p.onLoad({ id: 's1', title: 'T' })
  p._counter = 100
  p.data.sessionId = 's1'
  p.data.blocks = [
    { key: 'r1', kind: 'turn', label: '', time: '' },
    { key: 'u1', kind: 'user', text: localText, confirmed: false },
  ]
  const replayed = p._replayPage([{ t: 'ev.message_delta', role: 'user', delta: histText }])
  const merged = p._mergeByAnchors(replayed, p._replayAnchors, p.data.blocks)
  return merged.filter((b) => b.kind === 'user')
}

test('【R1】历史回放：带附件的消息与本地回显是同一条，不许显示两遍', () => {
  // 主机把附件落盘后会在正文后追加一段说明（uploads.ts 的 appendFileNote），
  // 所以历史里的正文与用户输入的原文**本来就不相等**。实时路径已为此写了 `_echoMatches`，
  // 但历史路径的 `localEcho` 还在按文本逐字相等匹配。
  const note = '看下这个\n\n[文件附件 1 个，已存到本机]\n1. /Users/x/a.pdf（application/pdf）'
  const blocks = replayUserBlocks('看下这个', note)
  assert.equal(
    blocks.length,
    1,
    `同一条消息显示成了 ${blocks.length} 遍：${JSON.stringify(blocks.map((b) => b.text))}。` +
      '它长得和 message/inbox 双发一模一样，但根因不是双发，是回显正文与回传正文本来就不相等。',
  )
})

test('【R1b】历史回放：只发附件、正文为空的那条同样不许显示两遍', () => {
  const note = '[文件附件 1 个，已存到本机]\n1. /Users/x/a.pdf（application/pdf）'
  const blocks = replayUserBlocks('', note)
  assert.equal(
    blocks.length,
    1,
    `只发附件的消息显示成了 ${blocks.length} 遍。` +
      '空文本连 localEcho 都进不去（`if (ut)` 挡掉空串），历史那条必然匹配不上。',
  )
})

test('【R1c】对照：纯文本指令必须仍然去重（别把 R1 的修复写成"一律不匹配"）', () => {
  const blocks = replayUserBlocks('看看这个项目的完成度', '看看这个项目的完成度')
  assert.equal(blocks.length, 1, '纯文本去重被 R1 的修复弄坏了 —— 那是最常见的一种形状')
})

// ══════════════════════════════════════════════════════════════════════
// 七、重连：视口回到底部（注释承诺的那一步必须真的执行）
// ══════════════════════════════════════════════════════════════════════

test('【S2】断链重连后视口必须回到底部，不许跳到块流最开头', async () => {
  const p = loadChatPage()
  p.scroll = new (require(path.join(MP, 'core/scroll-policy.js')).ScrollPolicy)(() => Date.now())
  p.scroll.setViewportHeight(600)
  p.onLoad({ id: 's1', title: 'T' })
  p._counter = 100
  p.data.sessionId = 's1'
  p.client = {
    isPaired: () => true,
    status: 'online',
    sessions: [],
    on: () => () => {},
    listSessions: () => {},
    getPending: () => {},
    loadHistory: () => Promise.resolve({ items: [], nextBeforeSeq: null }),
  }
  pageInstances.push(p)
  p.data.blocks = [
    { key: 'm0', kind: 'text', msgId: 'm0', text: '最早那段', done: true },
    { key: 'm1', kind: 'text', msgId: 'm1', text: '比较早', done: true },
    { key: 'm2', kind: 'text', msgId: 'm2', text: '最新', done: true },
  ]

  const firstKey = p.data.blocks[0].key
  p._historyStarted = false
  p._historyBusy = false
  p.client.loadHistory = () => Promise.resolve({ items: [], nextBeforeSeq: null })

  p._loadHistory(null)
  await new Promise((r) => setTimeout(r, 30))

  assert.notEqual(
    p.data.toView,
    'b' + firstKey,
    `重连后 toView = ${p.data.toView}，也就是 b${firstKey} —— 把视口滚到了块流**最开头**。` +
      '而 atBottom 已被手动置 true 藏掉了「回到最新」那颗钮，于是用户被留在几千行之前，' +
      '界面上还没有任何回到底部的入口。这一页的约定是"最新在最底"。',
  )
  p.onHide()
})

// ══════════════════════════════════════════════════════════════════════
// 八、onShow 必须重启思考秒表（卡片倒数已经这么做了，思考秒表漏了）
// ══════════════════════════════════════════════════════════════════════

test('【T4】思考秒表：onHide 停表，onShow 必须重启（回前台后不能冻在离开那一刻）', async () => {
  const p = loadChatPage()
  p.scroll = new (require(path.join(MP, 'core/scroll-policy.js')).ScrollPolicy)(() => Date.now())
  p.onLoad({ id: 's1', title: 'T' })
  p._counter = 100
  p.data.sessionId = 's1'
  p.client = { isPaired: () => true, status: 'online', sessions: [], on: () => () => {}, listSessions: () => {}, getPending: () => {} }
  pageInstances.push(p)
  p.data.running = true
  p.data.blocks = [
    {
      key: 'x1',
      kind: 'steps',
      open: false,
      closed: false,
      items: [{ key: 'k1', type: 'think', startedAt: Date.now() - 3000, msText: '3.0s', done: false }],
    },
  ]
  // onShow 里会走 _maybeLoadHistory → _loadHistory，装置必须给得出这个方法
  p._historyStarted = true
  p.client.loadHistory = () => Promise.resolve({ items: [], nextBeforeSeq: null })

  p.onHide()
  assert.equal(p._thinkTimer, null, 'onHide 停表（前置条件）')
  const before = p.data.blocks[0].items[0].msText

  p.onShow()
  assert.ok(
    p._thinkTimer !== null,
    'onShow 没有重启思考秒表。卡片倒数重启了（有专门判据），思考秒表漏了 —— ' +
      '回前台后「思考中 12.0s」永久冻住，而那是用户唯一能看到"模型还活着"的信号。' +
      '其它三个入口（run_state / _ensureThinkOpen / _onSessions）都要先收到一帧新事件才会被调到，' +
      '而切后台期间那些帧早就过去了。',
  )
  await new Promise((r) => setTimeout(r, 1200))
  const after = p.data.blocks[0].items[0].msText
  assert.notEqual(after, before, `1.2 秒后 msText 仍是 ${after} —— 秒表没走`)
})

// ══════════════════════════════════════════════════════════════════════
// 九、附件入口的能力守卫（probe 已经探到了，只是没人读）
// ══════════════════════════════════════════════════════════════════════

test('【A1】老容器上没有 chooseMessageFile 时，入口要说人话而不是抛 TypeError', () => {
  // 装置：真实的页面代码 + 一个**故意缺 API** 的宿主。
  //
  // ⚠️ 必须**重新 require**：`env.js` 的 probe 与 chat.js 的模块体都被 Node 缓存了
  // （A1/A2 之前那些用例已经载入过），而"宿主的 API 集合"是全局的。
  // 所以这里换掉全局 wx 之后要绕开缓存，否则跑的是上一次那份能力探测结果。
  const toasts = []
  const modals = []
  installHost({
    showToast: (o) => toasts.push(o.title),
    showModal: (o) => modals.push(o.content),
    // ⚠️ 故意不给 chooseMessageFile / chooseMedia / showActionSheet —— 模拟老基础库
  })
  const env = requireFresh(path.join(MP, 'core/env.js'))

  assert.equal(
    env.probe().chooseMessageFile,
    false,
    '装置问题：这个宿主应当被探成"没有 chooseMessageFile"，而诊断行恰恰会报 CHOOSE_MSG_FILE=no',
  )

  const page = globalThis.__capturedChat
  assert.ok(page, '装置问题：chat.js 应当已被 Page() 捕获')
  page.data = { attachments: [], attachCount: 0 }

  assert.doesNotThrow(
    () => page._pickFiles(),
    '直接调了 wx.chooseMessageFile：老容器上抛 TypeError，而用户看到的是"点了加号没反应"。' +
      '探针实测：`wx.chooseMessageFile is not a function`，零提示。' +
      'env.probe() 早就探到了这个能力（诊断行里 CHOOSE_MSG_FILE=no），只是没人读它。',
  )
  const spoke = toasts.join(' | ') + ' | ' + modals.join(' | ')
  assert.match(
    spoke,
    /文件|版本|能力|环境|升级|基础库/,
    `必须说清为什么选不了。实际给用户看的是：${JSON.stringify(spoke)}`,
  )
})

test('【A2】宿主有 API 时入口必须真的调它（别把守卫写成永远拦截）', () => {
  let called = 0
  installHost({
    chooseMessageFile: () => {
      called++
    },
  })
  const page = globalThis.__capturedChat
  page.data = { attachments: [], attachCount: 0 }
  page._pickFiles()
  assert.equal(called, 1, '宿主有 chooseMessageFile 时必须真的调它')
})

/** 载入 sessions 页（真实页面代码）并造一个可操作的实例。 */
function loadSessionsPage() {
  globalThis.Page = (cfg) => {
    globalThis.__capturedSessions = cfg
  }
  requireFresh(path.join(MP, 'pages/sessions/sessions.js'))
  const p = globalThis.__capturedSessions
  p.setData = function (patch) {
    for (const k in patch) this.data[k] = patch[k]
  }
  p.client = {
    isPaired: () => false,
    status: 'idle',
    on: () => () => {},
    sessions: [],
    listSessions: () => {},
    connect: () => {},
  }
  p.data = Object.assign({}, globalThis.__capturedSessions.data, { sessions: [], pending: [], status: 'idle' })
  pageInstances.push({
    onUnload() {
      p._stopLinkTick && p._stopLinkTick()
    },
  })
  return p
}

// ══════════════════════════════════════════════════════════════════════
// 十、cmd.new_session 的 workspace：让新会话落进指定的分组
//   （HANDOFF §0.10.4 第 4 步 / 遗留清单待办 D 的最后一项）
// ══════════════════════════════════════════════════════════════════════

test('【W1】指定 workspace 时载荷带上它；不指定时**一个键都不多**（老主机那条路）', () => {
  // 协议层 `cmd.new_session.workspace` 是**可选**字段，而 zod 默认 strip 未知键 ——
  // 所以"带上它"对老主机是无害的。但"带上它"仍然是**变更**：判据要钉住
  // 「不给就不给」，否则将来有人为了"省事"改成总是发一个空串，
  // 而空串会被主机的 `badWorkspace()` 判成形状不合法 → **明确失败**而不是静默改道。
  const { c, frames } = justPaired()
  const seen = []
  c.on((e) => {
    if (e.kind === 'payload') return
  })
  // 直接截获 sendCmd 的入参（比解密更直接，验的是"发出去的那条命令"）
  const orig = c.sendCmd.bind(c)
  c.sendCmd = (cmd) => {
    seen.push(cmd)
    return orig(cmd)
  }

  c.newSession('/Users/x/dsh-remote-control')
  c.newSession()

  assert.equal(seen[0]?.workspace, '/Users/x/dsh-remote-control', '指定了工作区却没有带上 —— 手机指定的分组被主机忽略了，' +
    '会话建在主机自己推断的目录里，而回执照样 ok:true、无错无日志、界面上完全看不出')
  assert.equal(
    'workspace' in (seen[1] || {}),
    false,
    `没指定工作区时载荷里仍然有 workspace=${JSON.stringify(seen[1]?.workspace)} —— ` +
      '这一格必须与接线之前逐字相同（老主机那条路不能被这次改动影响）',
  )
})

test('【W2】默认取"最后点开的那条会话的工作区"（点开列表不等于同意那个项目）', () => {
  // 默认值的来历必须是**用户点开哪一条**，而不是"最近更新的那条" ——
  // 点开常常只是看一眼就走，而"我接下来要在哪个项目里干活"才是新建时要表达的事。
  const page = loadSessionsPage()
  page.data.sessions = [
    { id: 'a', title: 'A', workspace: '/w/alpha' },
    { id: 'b', title: 'B', workspace: '/w/beta' },
  ]
  page.onOpen({ currentTarget: { dataset: { id: 'b', title: 'B', workspace: '/w/beta' } } })

  assert.equal(page._currentWorkspace(), '/w/beta', '点开 B 之后默认应当是 B 的工作区（不是列表里第一条 A）')
})

test('【W3】没点开过任何一条时退到"列表里第一个非空分组"，且全都没有时不带字段', () => {
  const page = loadSessionsPage()
  page.data.sessions = [{ id: 'a', title: 'A', workspace: '' }, { id: 'b', title: 'B', workspace: '/w/beta' }]
  assert.equal(page._currentWorkspace(), '/w/beta', '空目录那一行不该被选中（列表已把空目录排最后）')

  const empty = loadSessionsPage()
  empty.data.sessions = [{ id: 'a', title: 'A', workspace: '' }]
  assert.equal(empty._currentWorkspace(), '', '全都没有时返回空串 —— 调用点据此不带字段，由主机推断')
})

test('【W4】长按选分组：只列这一页见过的非空工作区，且没有就不弹空列表', () => {
  const page = loadSessionsPage()
  const sheets = []
  globalThis.wx.showActionSheet = (o) => {
    sheets.push(o.itemList)
    o.success && o.success({ tapIndex: 0 })
  }
  const asked = []
  page.client.newSession = (ws) => {
    asked.push(ws)
    return Promise.resolve({ ok: true, sessionId: 'ses_made' })
  }
  page.client.isPaired = () => true
  page.data.status = 'online'

  page.data.sessions = [
    { id: 'a', title: 'A', workspace: '/w/alpha' },
    { id: 'b', title: 'B', workspace: '/w/beta' },
    { id: 'c', title: 'C', workspace: '/w/alpha' },
  ]
  page.onNewSessionLongPress()

  assert.deepEqual(sheets[0], ['alpha', 'beta'], '同一工作区只出现一次，且显示目录最后一段')
  assert.equal(asked[0], '/w/alpha', '选中第 0 项就应当把它那一项的**完整路径**传下去（协议传的是绝对路径）')

  // 一个都没见过 → 不弹空列表
  const none = loadSessionsPage()
  const sheets2 = []
  globalThis.wx.showActionSheet = (o) => sheets2.push(o.itemList)
  const toasts = []
  globalThis.wx.showToast = (o) => toasts.push(o.title)
  none.client.isPaired = () => true
  none.data.sessions = []
  none.onNewSessionLongPress()
  assert.equal(sheets2.length, 0, '一个工作区都没有时弹了一个空列表 —— 那比不弹更像坏了')
  assert.match(toasts.join('|'), /工作区/, `必须说清为什么没有可选项，实际：${JSON.stringify(toasts)}`)
})
