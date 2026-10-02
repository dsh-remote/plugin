/**
 * presenter.test — 「当前配对码 → 右栏能打开的一张图」这段判断。
 *
 * 这一层最要紧的两条是**否定**的：
 *
 * 1. **落盘没成功就不能说 ready**。右栏拿到地址就会去开那个文件；文件不存在或者还是
 *    上一版码，用户看到的就是"弹出来一张废图"——比不弹更糟。所以 `write` 返回 false
 *    时状态必须是 `none`。
 * 2. **过期就必须是 none**。配对码有过期时间，过期之后把图顶开等于对用户撒谎。
 *
 * 另外用 liveDeps 真写一次盘，断言前缀是 PNG magic：这条钉的是"渲染出来的确实是 PNG"，
 * 而不是"我们调用了某个函数"（后者改掉 render 的实现也不会红）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { liveDeps, PairingPresenter } from '../src/presenter.js'

interface Fixture {
  presenter: PairingPresenter
  renders: string[]
  writes: Array<{ file: string; bytes: number }>
  logs: string[]
  setNow(value: number): void
  failWrite: boolean
}

function fixture(overrides: { digestUnchanged?: boolean } = {}): Fixture {
  let now = 1_000_000
  const renders: string[] = []
  const writes: Array<{ file: string; bytes: number }> = []
  const logs: string[] = []
  const state = { failWrite: false }
  const presenter = new PairingPresenter({
    imageFile: '/tmp/drc-test/sidebar-qr.png',
    now: () => now,
    render: async (qr) => {
      renders.push(qr)
      return Buffer.from(`PNG(${qr})`)
    },
    write: (file, data) => {
      if (state.failWrite) return false
      writes.push({ file, bytes: data.byteLength })
      return true
    },
    // 生产用码的哈希；测试里"换码"就是"哈希变了"，用同一套语义但可读。
    digest: (qr) => (overrides.digestUnchanged ? 'const' : `h(${qr})`),
    log: (message) => logs.push(message),
  })
  return {
    presenter,
    renders,
    writes,
    logs,
    setNow: (value) => {
      now = value
    },
    get failWrite() {
      return state.failWrite
    },
    set failWrite(value: boolean) {
      state.failWrite = value
    },
  }
}

test('没有码（null / 缺 qr / 空串）一律 none，且不渲染', async () => {
  const f = fixture()
  await f.presenter.observe(null)
  assert.deepEqual(f.presenter.snapshot(), { state: 'none' })
  await f.presenter.observe({})
  assert.deepEqual(f.presenter.snapshot(), { state: 'none' })
  await f.presenter.observe({ qr: '', expiresAt: 9_999_999 })
  assert.deepEqual(f.presenter.snapshot(), { state: 'none' })
  assert.equal(f.renders.length, 0)
})

test('已过期的码是 none，即便它从没渲染过', async () => {
  const f = fixture()
  await f.presenter.observe({ qr: 'dsh-rc://pair?x=1', expiresAt: 999_000 })
  assert.deepEqual(f.presenter.snapshot(), { state: 'none' })
  assert.equal(f.renders.length, 0)
})

test('有效码：渲染 + 落盘之后才 ready，epoch 是码的哈希不是码本身', async () => {
  const f = fixture()
  await f.presenter.observe({ qr: 'dsh-rc://pair?x=1', expiresAt: 2_000_000 })
  assert.deepEqual(f.presenter.snapshot(), { state: 'ready', epoch: 'h(dsh-rc://pair?x=1)', expiresAt: 2_000_000 })
  assert.equal(f.renders.length, 1)
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0]?.file, '/tmp/drc-test/sidebar-qr.png')
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
  assert.deepEqual(f.presenter.snapshot(), { state: 'ready', epoch: 'h(dsh-rc://pair?x=1)', expiresAt: 2_000_000 })
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
  assert.deepEqual(f.presenter.snapshot(), { state: 'ready', epoch: 'h(qr)', expiresAt: 2_500_000 })
})

test('换了一版码 → 重新渲染，epoch 变', async () => {
  const f = fixture()
  await f.presenter.observe({ qr: 'qr-1', expiresAt: 2_000_000 })
  await f.presenter.observe({ qr: 'qr-2', expiresAt: 2_000_000 })
  assert.equal(f.renders.length, 2)
  assert.equal((f.presenter.snapshot() as { epoch: string }).epoch, 'h(qr-2)')
})

test('落盘失败 → none（绝不把指向不存在文件的地址交出去）', async () => {
  const f = fixture()
  f.failWrite = true
  await f.presenter.observe({ qr: 'qr', expiresAt: 2_000_000 })
  assert.deepEqual(f.presenter.snapshot(), { state: 'none' })
  assert.ok(f.logs.some((line) => line.includes('落盘失败')))
})

test('渲染抛错 → none，且不把异常抛给调用方', async () => {
  const logs: string[] = []
  const presenter = new PairingPresenter({
    imageFile: '/tmp/x.png',
    now: () => 1,
    render: async () => {
      throw new Error('boom')
    },
    write: () => true,
    digest: () => 'h',
    log: (message) => logs.push(message),
  })
  await presenter.observe({ qr: 'qr', expiresAt: 9 })
  assert.deepEqual(presenter.snapshot(), { state: 'none' })
  assert.ok(logs.some((line) => line.includes('渲染失败')))
})

test('渲染期间来的下一个 tick 直接跳过，不会并发渲染同一版码', async () => {
  let release: (() => void) | undefined
  let renders = 0
  const presenter = new PairingPresenter({
    imageFile: '/tmp/x.png',
    now: () => 1,
    render: () => {
      renders += 1
      return new Promise<Buffer>((resolve) => {
        release = () => resolve(Buffer.from('png'))
      })
    },
    write: () => true,
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
  const deps = liveDeps('/tmp/unused.png', () => {})
  const qr = 'dsh-rc://pair?server=ws://x&psk=fake-psk&token=fake-token'
  const epoch = deps.digest(qr)
  assert.match(epoch, /^[0-9a-f]{16}$/)
  assert.ok(!epoch.includes(qr))
  assert.notEqual(epoch, deps.digest('dsh-rc://pair?server=ws://x&psk=fake-psk&token=fake-token2'))
})

test('liveDeps 真写盘：产物是 PNG（magic bytes），文件权限 0600', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-presenter-'))
  try {
    const file = path.join(dir, 'nested', 'sidebar-qr.png')
    const deps = liveDeps(file, () => {})
    const presenter = new PairingPresenter(deps)
    await presenter.observe({ qr: 'dsh-rc://pair?server=ws://x&psk=fake-psk&token=fake-token', expiresAt: Date.now() + 60_000 })
    assert.equal(presenter.snapshot().state, 'ready')
    assert.ok(!JSON.stringify(presenter.snapshot()).includes('fake-psk'), '快照里不许出现码')
    const bytes = readFileSync(file)
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic')
    assert.ok(bytes.byteLength > 200)
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
