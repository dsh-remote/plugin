/**
 * mp-sim — run the REAL WeChat Mini Program client code (mp/utils/*.js) in
 * Node by providing a minimal `wx` shim.
 *
 * We cannot open the WeChat devtools in CI, so this is how the client gets
 * verified: the exact files that ship in mp/utils are loaded (CommonJS) and
 * driven through the full loop against a real relay server + HostRuntime.
 *
 * Only the APIs the client core actually uses are shimmed:
 *   wx.getStorageSync / setStorageSync / removeStorageSync
 *   wx.connectSocket -> SocketTask (backed by the `ws` package)
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import WebSocket from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
const mpDir = path.join(here, '..', 'mp')

export function installWxShim() {
  const storage = new Map()
  const sockets = []

  const wx = {
    getStorageSync(k) {
      return storage.has(k) ? storage.get(k) : ''
    },
    setStorageSync(k, v) {
      storage.set(k, v)
    },
    removeStorageSync(k) {
      storage.delete(k)
    },
    connectSocket({ url, fail }) {
      try {
        const sock = new WebSocket(url)
        const handlers = { open: [], message: [], close: [], error: [] }
        const fire = (name, arg) => handlers[name].forEach((fn) => fn(arg))
        sockets.push(sock)
        sock.on('open', () => fire('open'))
        sock.on('message', (d) => fire('message', { data: String(d) }))
        sock.on('error', (e) => fire('error', { errMsg: String(e && e.message) }))
        sock.on('close', () => fire('close'))
        return {
          onOpen: (fn) => handlers.open.push(fn),
          onMessage: (fn) => handlers.message.push(fn),
          onClose: (fn) => handlers.close.push(fn),
          onError: (fn) => handlers.error.push(fn),
          send: ({ data }) => {
            if (sock.readyState === WebSocket.OPEN) sock.send(data)
          },
          close: () => sock.close(),
        }
      } catch (e) {
        fail && fail(e)
        return null
      }
    },
    // no-ops: pages use these, the client core does not
    showToast() {},
    showModal() {},
    vibrateShort() {},
    vibrateLong() {},
  }
  globalThis.wx = wx
  return { storage, sockets }
}

/** Load mp/utils/* fresh (busting the require cache) after the shim is in place. */
export function loadMpModules() {
  const require = createRequire(import.meta.url)
  const crypto = require(path.join(mpDir, 'utils/drc-crypto.js'))
  const store = require(path.join(mpDir, 'utils/store.js'))
  const drc = require(path.join(mpDir, 'utils/drc.js'))
  return { crypto, store, drc }
}

export function mpDirPath() {
  return mpDir
}
