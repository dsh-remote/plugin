import test from 'node:test'
import assert from 'node:assert/strict'
import { qrMatrix, renderTerminalQr } from '../src/qr.js'

test('terminal QR renders a square, quiet-zoned, half-block symbol', () => {
  const text = 'dshr:/p?v=1&s=wss%3A%2F%2Fdrc.provid.cc&n=bins-macbook&psk=u6ufzO%2BGNSmosc8y148Rew%3D%3D&t=173142'
  const out = renderTerminalQr(text, { ansi: false })
  const lines = out.split('\n')

  assert.ok(lines.length >= 20, `half-block rendering should be compact, got ${lines.length} lines`)
  // all lines equal width (monospace requirement)
  const width = lines[0]!.length
  assert.ok(lines.every((l) => l.length === width), 'every line must have the same width')
  // quiet zone: the border rows/cols are all spaces
  assert.match(lines[0]!, /^ *$/, 'top quiet row must be blank')
  assert.match(lines.at(-1)!, /^ *$/, 'bottom quiet row must be blank')
  assert.ok(lines.every((l) => l.startsWith('  ') && l.endsWith('  ')), 'side quiet columns must be blank')
  // half-block alphabet only
  assert.match(out, /^[█▀▄ \n]+$/, 'only half-block characters expected (ansi off)')
})

test('ANSI mode wraps the symbol in an explicit black-on-white palette', () => {
  const out = renderTerminalQr('HELLO WORLD')
  assert.ok(out.startsWith('\x1b[30;107m'), 'must start with black-fg/white-bg')
  assert.ok(out.endsWith('\x1b[0m'), 'must reset styles at the end')
})

test('qrMatrix includes a quiet zone and the finder corners', () => {
  const m = qrMatrix('HELLO WORLD', 'M', 2)
  // all rows equal length
  assert.ok(m.every((r) => r.length === m.length), 'matrix must be square')
  // quiet zone ring is light
  assert.ok(m[0]!.every((v) => v === false), 'top quiet row must be light')
  assert.ok(m.at(-1)!.every((v) => v === false), 'bottom quiet row must be light')
  assert.ok(m.every((r) => r[0] === false && r[1] === false), 'left quiet columns must be light')
  // top-left finder: 7×7 dark border pattern
  const tl = m.slice(2, 9).map((r) => r.slice(2, 9))
  assert.ok(tl[0]!.every((v) => v === true), 'finder top edge dark')
  assert.ok(tl[6]!.every((v) => v === true), 'finder bottom edge dark')
  assert.ok(tl.every((r) => r[0] === true && r[6] === true), 'finder side edges dark')
  assert.ok(tl[2]!.slice(2, 5).every((v) => v === true), 'finder centre 3×3 dark')
})

test('half-block rendering round-trips back to the exact matrix', () => {
  // The terminal output is the product a user will actually photograph — it
  // must reconstruct bit-for-bit, or the pretty print silently broke pairing.
  const text = 'dshr:/p?v=1&s=wss%3A%2F%2Fdrc.provid.cc&n=bins-macbook&psk=u6ufzO%2BGNSmosc8y148Rew%3D%3D&t=173142'
  const rendered = renderTerminalQr(text, { ansi: false, quietZone: 0 })
  const original = qrMatrix(text, 'M', 0)

  const parse = (ch: string): [boolean, boolean] => {
    if (ch === '█') return [true, true]
    if (ch === '▀') return [true, false]
    if (ch === '▄') return [false, true]
    return [false, false]
  }
  const rebuilt: boolean[][] = []
  const lines = rendered.split('\n')
  for (const line of lines) {
    const top: boolean[] = []
    const bottom: boolean[] = []
    for (const ch of line) {
      const [t, b] = parse(ch)
      top.push(t)
      bottom.push(b)
    }
    rebuilt.push(top)
    rebuilt.push(bottom)
  }
  // odd module counts duplicate the last row on render; trim to compare
  const trimmed = rebuilt.slice(0, original.length)
  assert.deepEqual(trimmed, original, 'rendered symbol must decode back to the same matrix')
})

test('non-ASCII payloads survive: stringToBytes must be UTF-8, not truncating', () => {
  // The vendored default stringToBytes truncates charCodes — a silent corruptor.
  // The wrapper opts into the UTF-8 encoder; verify by decoding capability:
  // the CJK payload must produce a LARGER matrix than the truncation would.
  const cjk = qrMatrix('中文载荷测试：配对信息', 'M', 0)
  assert.equal(cjk.length, 29, '11 CJK chars ×3 bytes needs version 3 (29×29); a truncating bug would emit 21×21')
})
