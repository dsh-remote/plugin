import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

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
const mpCore = path.join(here, '..', 'mp', 'core')
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
