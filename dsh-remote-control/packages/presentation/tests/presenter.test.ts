/**
 * presenter.test — 「当前配对码 → 右栏能打开的一份 PNG 字节」这段判断。
 *
 * 这一层最要紧的三条：
 *
 * 1. **过期必须是 none**。配对码有过期时间，过期之后把图顶开等于对用户撒谎。
 * 2. **同一版码只渲染一次**，但 `expiresAt` 要跟着服务端 TTL 走。
 * 3. **渲染抛错必须把上一版的字节丢掉**——留着它，`ready` 就会把**上一版的图**配上
 *    这一版的 epoch 交出去（右栏弹出一张已经作废的码，扫出来是"配对失败"）。
 *
 * 落盘**不在这里**了（2026-10-02：图要落在请求那条会话的工作区，只有路由知道），
 * 所以"写不成就不许答 ready"这条不变量在 `route.test.ts` 上守，写盘动作本身在
 * 本文件末尾用 `writePrivatePng` 真写一次、断言 PNG magic 与 0600。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { liveDeps, PairingPresenter, writePrivatePng } from '../src/presenter.js'

/**
 * 生产用的就是码的哈希。这里用一个**真的**哈希（而不是 `h(qr)` 这种会原样带上码的假货）：
 * 否则"快照里不许出现码本身"这条断言会因为假 digest 自己泄码而变得没意义。
 */
const digestOf = (qr: string): string => createHash('sha256').update(qr).digest('hex').slice(0, 16)

interface Fixture {
  presenter: PairingPresenter
  renders: string[]
  logs: string[]
  setNow(value: number): void
}

function fixture(): Fixture {
  let now = 1_000_000
  const renders: string[] = []
  const logs: string[] = []
  const presenter = new PairingPresenter({
    now: () => now,
    render: async (qr) => {
      renders.push(qr)
      return Buffer.from(`PNG(${qr})`)
    },
    // 生产用码的哈希；测试里"换码"就是"哈希变了"，用同一套语义但可读。
    digest: digestOf,
    log: (message) => logs.push(message),
  })
  return { presenter, renders, logs, setNow: (value) => void (now = value) }
}

test('没有码（null / 缺 qr / 空串）一律 none，且不渲染、不留字节', async () => {
  const f = fixture()
  await f.presenter.observe(null)
  assert.deepEqual(f.presenter.snapshot(), { state: 'none' })
  await f.presenter.observe({})
  assert.deepEqual(f.presenter.snapshot(), { state: 'none' })
  await f.presenter.observe({ qr: '', expiresAt: 9_999_999 })
  assert.deepEqual(f.presenter.snapshot(), { state: 'none' })
  assert.equal(f.renders.length, 0)
  assert.equal(f.presenter.current(), null, '没有码时 current() 必须是 null：路由靠它决定能不能落盘')
})

test('已过期的码是 none，即便它从没渲染过', async () => {
  const f = fixture()
  await f.presenter.observe({ qr: 'dsh-rc://pair?x=1', expiresAt: 999_000 })
  assert.deepEqual(f.presenter.snapshot(), { state: 'none' })
  assert.equal(f.renders.length, 0)
})

test('码过期之后连字节一起丢掉：留着它就会把废码发给右栏', async () => {
  const f = fixture()
  await f.presenter.observe({ qr: 'qr', expiresAt: 2_000_000 })
  assert.notEqual(f.presenter.current(), null)
  f.setNow(3_000_000)
  await f.presenter.observe({ qr: 'qr', expiresAt: 2_000_000 })
  assert.deepEqual(f.presenter.snapshot(), { state: 'none' })
  assert.equal(f.presenter.current(), null, '过期后还留着上一版的字节 = 右栏可能弹出一张扫不出来的图')
})

test('有效码：渲染之后才 ready，epoch 是码的哈希不是码本身，字节随之可拿', async () => {
  const f = fixture()
  await f.presenter.observe({ qr: 'dsh-rc://pair?x=1', expiresAt: 2_000_000 })
  assert.deepEqual(f.presenter.snapshot(), {
    state: 'ready',
    epoch: digestOf('dsh-rc://pair?x=1'),
    expiresAt: 2_000_000,
  })
  assert.equal(f.renders.length, 1)
  assert.equal(f.presenter.current()?.epoch, digestOf('dsh-rc://pair?x=1'))
  assert.equal(f.presenter.current()?.buffer.toString(), 'PNG(dsh-rc://pair?x=1)')
  assert.ok(
    !JSON.stringify(f.presenter.snapshot()).includes('dsh-rc://pair?x=1'),
    '快照里不许出现码本身（路由是浏览器可达的）',
  )
})

/**
 * 这一条是真机取证换来的：`provide('dshRemoteControl')` 的 `state.pairing.expiresAt`
 * 不是主插件内部那个毫秒数，而是 `describeActivePairing()` 序列化过的 **ISO 字符串**
 * （`new Date(slot.expiresAt).toISOString()`，见 packages/plugin/src/index.ts）。只认
 * `typeof === 'number'` 的话，真机上每一版码都会被判成"已过期"，路由永远答 `none`，
 * 用户那边表现为"右栏从来不弹"——而单测里手写的毫秒 fixture 一路全绿。
 */
test('expiresAt 是 ISO 字符串（provide 层的真实形状）也要认', async () => {
  const f = fixture()
  await f.presenter.observe({ qr: 'dsh-rc://pair?x=1', expiresAt: new Date(2_000_000).toISOString() })
  assert.deepEqual(f.presenter.snapshot(), {
    state: 'ready',
    epoch: digestOf('dsh-rc://pair?x=1'),
    expiresAt: 2_000_000,
  })
  assert.equal(f.renders.length, 1)
})

test('ISO 字符串形式的过期码同样是 none', async () => {
  const f = fixture()
  await f.presenter.observe({ qr: 'qr', expiresAt: new Date(999_000).toISOString() })
  assert.deepEqual(f.presenter.snapshot(), { state: 'none' })
  assert.equal(f.renders.length, 0)
})

test('认不出的 expiresAt（垃圾串 / 对象）一律 none，不猜', async () => {
  const f = fixture()
  await f.presenter.observe({ qr: 'qr', expiresAt: 'soon' })
  assert.deepEqual(f.presenter.snapshot(), { state: 'none' })
  await f.presenter.observe({ qr: 'qr', expiresAt: {} })
  assert.deepEqual(f.presenter.snapshot(), { state: 'none' })
  await f.presenter.observe({ qr: 'qr', expiresAt: NaN })
  assert.deepEqual(f.presenter.snapshot(), { state: 'none' })
  assert.equal(f.renders.length, 0)
})

test('同一版码只渲染一次，但 expiresAt 会跟着服务端 TTL 走', async () => {
  const f = fixture()
  await f.presenter.observe({ qr: 'qr', expiresAt: 2_000_000 })
  await f.presenter.observe({ qr: 'qr', expiresAt: 2_500_000 })
  assert.equal(f.renders.length, 1)
  assert.deepEqual(f.presenter.snapshot(), { state: 'ready', epoch: digestOf('qr'), expiresAt: 2_500_000 })
})

test('换了一版码 → 重新渲染，epoch 变', async () => {
  const f = fixture()
  await f.presenter.observe({ qr: 'qr-1', expiresAt: 2_000_000 })
  await f.presenter.observe({ qr: 'qr-2', expiresAt: 2_000_000 })
  assert.equal(f.renders.length, 2)
  assert.equal((f.presenter.snapshot() as { epoch: string }).epoch, digestOf('qr-2'))
})

test('渲染抛错 → none，上一版的字节必须被丢掉，且不把异常抛给调用方', async () => {
  const logs: string[] = []
  let fail = false
  const presenter = new PairingPresenter({
    now: () => 1,
    render: async () => {
      if (fail) throw new Error('boom')
      return Buffer.from('first')
    },
    digest: (qr) => `h(${qr})`,
    log: (message) => logs.push(message),
  })
  await presenter.observe({ qr: 'qr-1', expiresAt: 9 })
  assert.equal(presenter.current()?.buffer.toString(), 'first')
  fail = true
  await presenter.observe({ qr: 'qr-2', expiresAt: 9 })
  assert.deepEqual(presenter.snapshot(), { state: 'none' })
  assert.equal(presenter.current(), null, '渲染失败后current()还留着上一版的字节：右栏会拿到一张作废的码')
  assert.ok(logs.some((line) => line.includes('渲染失败')))
})

test('渲染期间来的下一个 tick 直接跳过，不会并发渲染同一版码', async () => {
  let release: (() => void) | undefined
  let renders = 0
  const presenter = new PairingPresenter({
    now: () => 1,
    render: () => {
      renders += 1
      return new Promise<Buffer>((resolve) => {
        release = () => resolve(Buffer.from('png'))
      })
    },
    digest: () => 'h',
    log: () => {},
  })
  const first = presenter.observe({ qr: 'qr', expiresAt: 9 })
  await presenter.observe({ qr: 'qr', expiresAt: 9 })
  assert.equal(renders, 1)
  release?.()
  await first
  assert.equal(presenter.snapshot().state, 'ready')
})

test('liveDeps 的 epoch 是码的哈希前缀：泄不出码本身（路由是浏览器可达的）', () => {
  const deps = liveDeps(() => {})
  const qr = 'dsh-rc://pair?server=ws://x&psk=fake-psk&token=fake-token'
  const epoch = deps.digest(qr)
  assert.match(epoch, /^[0-9a-f]{16}$/)
  assert.ok(!epoch.includes(qr))
  assert.notEqual(epoch, deps.digest('dsh-rc://pair?server=ws://x&psk=fake-psk&token=fake-token2'))
})

test('liveDeps 真渲染：产物是 PNG（magic bytes），快照里没有码', async () => {
  const presenter = new PairingPresenter(liveDeps(() => {}))
  await presenter.observe({
    qr: 'dsh-rc://pair?server=ws://x&psk=fake-psk&token=fake-token',
    expiresAt: Date.now() + 60_000,
  })
  assert.equal(presenter.snapshot().state, 'ready')
  assert.ok(!JSON.stringify(presenter.snapshot()).includes('fake-psk'), '快照里不许出现码')
  const bytes = presenter.current()!.buffer
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic')
  assert.ok(bytes.byteLength > 200)
})

test('writePrivatePng 真写盘：0600 + 原子改名（右栏可能正在读它）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-presenter-'))
  try {
    const file = path.join(dir, 'nested', 'sidebar-qr.png')
    assert.equal(writePrivatePng(file, Buffer.from([0x89, 0x50, 0x4e, 0x47])), true)
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600, 'QR 里含 PSK，谁读到谁就能配对')
    }
    assert.deepEqual([...readFileSync(file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
    // 临时文件不许留在目录里：半写的 PNG 会被右栏渲染成一张破图。
    assert.equal(readdirSync(path.join(dir, 'nested')).filter((name) => name.includes('.tmp-')).length, 0)
    assert.equal(writePrivatePng('', Buffer.from('x')), false, '空路径要返回 false 而不是抛')
    const notADir = path.join(dir, 'afile')
    writeFileSync(notADir, 'x')
    assert.equal(
      writePrivatePng(path.join(notADir, 'qr.png'), Buffer.from('x')),
      false,
      '写失败必须折成 false：路由靠它改答 none',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
