/**
 * pairing-text.test — `/drc pair` 的文本输出。
 *
 * 这条测试守的是「配对输出必须自足」：不用去别处猜，也仍然能完成配对。
 * 默认值那一半由 `config.test.ts` 守着（`qrImage` 默认 **开**、`qrOpen`/`qrAnsi` 默认关）。
 *
 * 2026-10-02：真机取证发现 DSH 命令卡按 `line-height:1.6` 渲染等宽输出，会把半块二维码
 * 横切成条（zxing ≥1.15 行距即失败），于是把默认产物从文本码翻转成图片路径；
 * 文本码降级为 `qrImage:false` 时的退路。下面两条断言把这个结论锁住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pairingPairText, PAIR_UNAVAILABLE_TEXT } from '../src/shell/pairing-text.js'

const QR = 'dshr:/p?v=1&s=wss%3A%2F%2Frelay.example.invalid&n=demo-host&psk=ZmFrZS1wc2srZmFrZQ%2BZmFrZQ%3D%3D&t=424242'
const TERMINAL = '█▀▀▀▀▀█ ...\n▀ ▀ ▀ ▀▀'
/** 已按会话工作区解析好的落点（`shell/status.ts` 的 pairingImagePath 负责拼，本文件只验印法）。 */
const IMAGE = '/Users/demo/project/.dsh/pairing-qr.png'

function view(overrides: Partial<Parameters<typeof pairingPairText>[0]> = {}) {
  return {
    token: '424242',
    qr: QR,
    expiresAt: 1_000_000,
    now: 940_000,
    qrImage: false,
    imageFile: IMAGE,
    terminalQr: TERMINAL,
    ...overrides,
  }
}

test('文本输出自带二维码、可粘贴的 URI、TTL 与一次性提示', () => {
  const text = pairingPairText(view())
  assert.match(text, /配对码 424242/, '6 位码必须在第一行：手输是扫码之外的唯一退路')
  assert.match(text, /60 秒内有效/, '剩余寿命要说清（服务端权威 TTL 改写后本地值就是它）')
  assert.match(text, /一次性/, '不写"一次性"，用户会以为同一张码能配两部手机')
  assert.ok(text.includes(TERMINAL), '二维码本体必须在文本里')
  assert.ok(text.includes(QR), 'URI 原文要单独一行：比例字体或吞字形的渲染器下，粘贴是最后的退路')
  assert.match(text, /qrImage 设为 true/, '图片版是显式旁路，要告诉用户怎么开')
})

test('不出现任何"打开图片/查看器"的指示：这条命令不许把用户赶出 DSH', () => {
  const text = pairingPairText(view())
  for (const forbidden of ['open ', '查看器', 'xdg-open', '双击', '请用系统打开']) {
    assert.equal(text.includes(forbidden), false, `输出里出现了 "${forbidden}"：配对动作被搬到了宿主外面`)
  }
})

test('开了 qrImage 时才报图片路径（报了就等于承诺写了文件），且不再塞那段扫不出来的文本码', () => {
  const withImage = pairingPairText(view({ qrImage: true }))
  assert.match(withImage, /pairing-qr\.png/, 'qrImage=true 时必须说清文件在哪')
  assert.ok(withImage.includes(IMAGE), `卡片上的路径必须是调用方解析好的那一个（收到的是 ${IMAGE}）`)
  assert.match(withImage, /\.dsh\//, '落在工作区的 .dsh 下：用户拍板过"不要 home 下的 .dsh"')
  assert.match(withImage, /右栏/, '右栏会自动弹出二维码，主路径就得写它：只报文件路径等于让用户白跑一趟去找图')
  assert.equal(
    withImage.includes(TERMINAL),
    false,
    '图片模式下不许再吐文本二维码：DSH 命令卡的行高会把它切成条（本轮事故）',
  )
  assert.ok(withImage.includes(QR), 'URI 原文仍要留着：手输/粘贴是最后退路')
  assert.equal(
    pairingPairText(view({ qrImage: false })).includes('pairing-qr.png'),
    false,
    '没写图片却报路径：用户会去找一个不存在的文件',
  )
  // 图片模式开着但根本没有落点（statusFile 没配）时，也不许印出一个空路径——
  // 那等于让用户去找一个叫空字符串的文件。
  assert.doesNotMatch(pairingPairText(view({ qrImage: true, imageFile: '' })), /再扫：/)
})

test('中继没连上时给出可行动的下一步，而不是"失败"', () => {
  assert.match(PAIR_UNAVAILABLE_TEXT, /status\.json/, '排错入口必须被点名：GUI 宿主里没别的地方可看')
  assert.match(PAIR_UNAVAILABLE_TEXT, /relayProblem/, '要指到具体字段，否则"没连上"三个字什么也解决不了')
})
