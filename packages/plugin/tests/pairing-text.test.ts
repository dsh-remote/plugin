/**
 * pairing-text.test — `/drc pair` 的文本输出。
 *
 * 这条测试守的是一句拍板：「二维码不要用打开一个图片的方式，不要脱离 dsh」。
 * 默认值那半边由 `config.test.ts` 守着（`qrImage`/`qrOpen`/`qrAnsi` 默认关），
 * 这半边守的是**输出本身自足**：不用去别处看图，也仍然能完成配对。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pairingPairText, PAIR_UNAVAILABLE_TEXT } from '../src/shell/pairing-text.js'

const QR = 'dshr:/p?v=1&s=wss%3A%2F%2Fdrc.provid.cc&n=bins-macbook&psk=u6ufzO%2BGNSmosc8y148Rew%3D%3D&t=173142'
const TERMINAL = '█▀▀▀▀▀█ ...\n▀ ▀ ▀ ▀▀'

function view(overrides: Partial<Parameters<typeof pairingPairText>[0]> = {}) {
  return {
    token: '173142',
    qr: QR,
    expiresAt: 1_000_000,
    now: 940_000,
    qrImage: false,
    statusFile: '/tmp/drc/status.json',
    terminalQr: TERMINAL,
    ...overrides,
  }
}

test('文本输出自带二维码、可粘贴的 URI、TTL 与一次性提示', () => {
  const text = pairingPairText(view())
  assert.match(text, /配对码 173142/, '6 位码必须在第一行：手输是扫码之外的唯一退路')
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

test('开了 qrImage 时才报图片路径（报了就等于承诺写了文件）', () => {
  const withImage = pairingPairText(view({ qrImage: true }))
  assert.match(withImage, /pairing-qr\.png/, 'qrImage=true 时必须说清文件在哪')
  assert.equal(pairingPairText(view({ qrImage: false })).includes('pairing-qr.png'), false, '没写图片却报路径：用户会去找一个不存在的文件')
})

test('中继没连上时给出可行动的下一步，而不是"失败"', () => {
  assert.match(PAIR_UNAVAILABLE_TEXT, /status\.json/, '排错入口必须被点名：GUI 宿主里没别的地方可看')
  assert.match(PAIR_UNAVAILABLE_TEXT, /relayProblem/, '要指到具体字段，否则"没连上"三个字什么也解决不了')
})
