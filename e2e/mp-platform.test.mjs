import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFileSync } from 'node:fs'

/**
 * Transport resolution.
 *
 * Regression guard for a real report from a phone: the published mini program
 * died with `wx.connectSocket is not a function`. The old code called
 * `wx.connectSocket(...)` unconditionally, so a container that does not
 * implement it produced a bare TypeError — no hint of what was missing, and
 * nothing the user could act on.
 *
 * What must hold now:
 *   - a missing socket API becomes a typed, described error (never a TypeError);
 *   - a container that only offers the legacy global-callback socket still works.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const mpCore = path.join(here, '..', 'dsh-remote-mp', 'miniprogram', 'core')
const env = require(path.join(mpCore, 'env.js'))
const sock = require(path.join(mpCore, 'socket.js'))

function withGlobal(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, name)
  const prev = globalThis[name]
  globalThis[name] = value
  try {
    return fn()
  } finally {
    if (had) globalThis[name] = prev
    else delete globalThis[name]
  }
}

test('a container without connectSocket reports a described error, not a TypeError', () => {
  withGlobal('wx', { getStorageSync: () => '' }, () => {
    env.probe(true) // drop the cache that earlier tests warmed
    const errors = []
    let threw = null
    const socket = sock.createSocket({
      url: 'wss://example.invalid',
      onError: (e) => errors.push(e),
    })
    try {
      socket.open()
    } catch (e) {
      threw = e
    }

    assert.equal(threw, null, 'opening must never throw')
    assert.equal(errors.length, 1, 'the caller is told, once')
    const err = errors[0]
    assert.equal(err.code, 'SOCKET_UNAVAILABLE')
    assert.match(err.message, /connectSocket/)
    // the summary is the whole point: it is what the user copies back to us
    assert.match(err.message, /SOCKET=NO/)
    assert.match(err.message, /GLOBAL=wx/)
  })
})

test('a container with only the legacy global socket still connects and sends', () => {
  const calls = { connected: [], sent: [], closed: false }
  const handlers = {}
  withGlobal(
    'wx',
    {
      // returns nothing → not SocketTask shaped
      connectSocket: (o) => {
        calls.connected.push(o.url)
        return undefined
      },
      onSocketOpen: (fn) => {
        handlers.open = fn
      },
      onSocketMessage: (fn) => {
        handlers.message = fn
      },
      onSocketError: (fn) => {
        handlers.error = fn
      },
      onSocketClose: (fn) => {
        handlers.close = fn
      },
      sendSocketMessage: ({ data }) => {
        calls.sent.push(data)
      },
      closeSocket: () => {
        calls.closed = true
      },
    },
    () => {
      env.probe(true)
      const opened = []
      const got = []
      const socket = sock.createSocket({
        url: 'wss://example.invalid',
        onOpen: () => opened.push('open'),
        onMessage: (d) => got.push(d),
        onError: () => {},
      })
      socket.open()

      assert.deepEqual(calls.connected, ['wss://example.invalid'], 'one connect only')
      assert.equal(socket.transport(), 'legacy')

      handlers.open()
      assert.deepEqual(opened, ['open'], 'the global onSocketOpen drives onOpen')

      assert.equal(socket.send('hello'), true)
      assert.deepEqual(calls.sent, ['hello'])

      handlers.message({ data: 'from-host' })
      assert.deepEqual(got, ['from-host'])

      socket.close()
      assert.equal(calls.closed, true)
    },
  )
})

test('the probe names the host global it found', () => {
  withGlobal('my', { connectSocket: () => ({}), onSocketOpen: () => {}, onSocketMessage: () => {}, sendSocketMessage: () => {} }, () => {
    withGlobal('wx', undefined, () => {
      const p = env.probe(true)
      // Alipay-style containers expose `my`; the transport must not hard-code `wx`
      assert.equal(p.global, 'my')
      assert.equal(p.connectSocket, true)
      assert.equal(p.legacySocket, true)
    })
  })
})

test('summary() 报的项数与 probe() 探到的键数一致（诊断行漏字段 = 让用户白发一次）', () => {
  // `summary()` 是"出问题时用户把这行复制回来就能定位"的载体，可它之前**漏了两个**：
  // `chooseMessageFile` 与 `showActionSheet`——而这两个恰好是"加号"那个菜单的两条路。
  // 老 SDK 上文件入口点不动，用户唯一能做的就是发回这行，那行里却没有"缺的是哪个"。
  //
  // 判据用**项数不变式**而不是"把这两个名字补上"：诊断行里能力用的是短标签
  // （`SOCKET=` 而不是 `connectSocket=`），逐个名字比对就得在测试里再维护一张映射表，
  // 而那张表本身正是会漂的东西。数项数与措辞无关，多探一项就必红。
  const summary = env.summary()
  const source = readFileSync(path.join(mpCore, 'env.js'), 'utf8')
  const body = /function collect\(\)[\s\S]*?return \{([\s\S]*?)\n {2}\}/.exec(source)?.[1]
  assert.ok(body, 'env.js 里找不到 collect() 的返回字面量：抽法或结构变了')
  const keys = [...body.matchAll(/^ {4}([a-zA-Z][A-Za-z0-9]*):/gm)].map((m) => m[1])
  assert.ok(keys.length >= 10, `只从 collect() 抽出 ${keys.length} 个键：抽法或结构变了`)

  const reported = (summary.match(/=/g) ?? []).length
  assert.equal(
    reported,
    keys.length,
    `diagnostic 行报了 ${reported} 项，而 probe() 探到 ${keys.length} 项：\n  诊断行：${summary}\n` +
      '差的那些正是用户发回来时看不到的（探到了却不报 = 让用户白发一次诊断）',
  )
  // 顺带钉住这次补的两条：它们各自守着一个用户可见的入口。
  assert.match(summary, /CHOOSE_MSG_FILE=(yes|no)/, '诊断行必须报告文件附件入口的能力')
  assert.match(summary, /ACTION_SHEET=(yes|no)/, '诊断行必须报告"加号"那个原生菜单的能力')
})
