/**
 * mp-sim — 在 Node 里跑**真实的小程序客户端代码**。
 *
 * 为什么必须这样测：CI 打不开微信开发者工具，所以"客户端怎么被验证"只有一个可信答案
 * —— 把将要打进小程序包的那几个文件本身加载进 Node 来驱动。
 * 任何"为测试另写一份客户端"的做法都会让测试与真机分叉（旧实现的假通过事故根因之一）。
 *
 * 只 shim 客户端核心真正用到的 API，页面级 API 一律空实现：
 * shim 面积越小，"测试里能过、真机上不行"的缝隙就越小。
 * 覆盖范围（取证 docs/legacy-spec/mp-client-contract.md §1、§6）：
 *   wx.getStorageSync / setStorageSync / removeStorageSync
 *   wx.connectSocket → SocketTask（用 ws 兜底，含 onOpen/onMessage/onClose/onError/send/close）
 *   页面用但协议层不用的：showToast / showModal / vibrateShort / vibrateLong（空实现）
 *
 * 两条顺序是硬要求：
 * 1. **先装 shim 再 import dsh-remote-mp/miniprogram/core**（否则 `wx` 未定义，模块加载即坏）；
 * 2. **绕过 require 缓存**（同一进程里多个测试用例要各自干净的 storage）。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
// mp 的源码树在开源仓 `dsh-remote-mp` 里，小程序根目录是它的 `miniprogram/`
// （`project.config.json` / `package.json` 在仓根，不在这一层——凡要读这两样的脚本都得往上一层取）。
export const MP_DIR = path.join(here, '..', 'dsh-remote-mp', 'miniprogram')

/** 记录所有经手的帧，供零知识审计与顺序断言使用。 */
export function createRecorder() {
  const frames = []
  return {
    frames,
    push(direction, raw, meta = {}) {
      frames.push({ direction, raw, at: Date.now(), ...meta })
    },
    /** 只看发给中继的 enc 帧的密文字段（零知识断言的对象必须是"交给中继的那一帧"）。 */
    outboundCiphertexts() {
      return frames
        .filter((f) => f.direction === 'out' && f.raw.includes('"ciphertext"'))
        .map((f) => f.raw)
    },
  }
}

export function installWxShim({ recorder } = {}) {
  const storage = new Map()
  const sockets = []

  const wx = {
    getStorageSync(key) {
      return storage.has(key) ? storage.get(key) : ''
    },
    setStorageSync(key, value) {
      storage.set(key, value)
    },
    removeStorageSync(key) {
      storage.delete(key)
    },
    connectSocket({ url, fail, success }) {
      let socket
      try {
        socket = new WebSocket(url)
      } catch (error) {
        if (fail) fail({ errMsg: `connectSocket:fail ${String(error?.message ?? error)}` })
        return null
      }
      const handlers = { open: [], message: [], close: [], error: [] }
      const fire = (name, arg) => {
        for (const fn of handlers[name]) fn(arg)
      }
      sockets.push(socket)
      socket.on('open', () => {
        success?.({})
        fire('open')
      })
      socket.on('message', (data) => {
        const text = String(data)
        recorder?.push('out', text, { url })
        fire('message', { data: text })
      })
      socket.on('error', (error) => fire('error', { errMsg: `connectSocket:fail ${String(error?.message ?? error)}` }))
      socket.on('close', () => fire('close'))
      const task = {
        onOpen: (fn) => handlers.open.push(fn),
        onMessage: (fn) => handlers.message.push(fn),
        onClose: (fn) => handlers.close.push(fn),
        onError: (fn) => handlers.error.push(fn),
        send: ({ data, fail }) => {
          if (socket.readyState !== WebSocket.OPEN) {
            if (fail) fail({ errMsg: 'sendSocketMessage:fail socket not open' })
            return
          }
          recorder?.push('in', String(data), { url })
          socket.send(data)
        },
        close: ({ code, reason } = {}) => socket.close(code ?? 1000, reason ?? ''),
      }
      return task
    },
    // 页面级 API：客户端核心一个都不用到，给空实现即可。
    showToast() {},
    hideToast() {},
    showModal() {},
    showLoading() {},
    hideLoading() {},
    vibrateShort() {},
    vibrateLong() {},
    setNavigationBarTitle() {},
  }
  globalThis.wx = wx
  return { wx, storage, sockets }
}

/** 加载真实的小程序模块（绕开 require 缓存）。必须在 `installWxShim()` 之后调用。 */
export function loadMpModules() {
  const require = createRequire(import.meta.url)
  const codec = require(path.join(MP_DIR, 'core', 'codec.js'))
  const store = require(path.join(MP_DIR, 'core', 'session-store.js'))
  const client = require(path.join(MP_DIR, 'core', 'client.js'))
  const env = require(path.join(MP_DIR, 'core', 'env.js'))
  const socket = require(path.join(MP_DIR, 'core', 'socket.js'))
  return { codec, store, client, env, socket }
}

/** 等到某个谓词成立；失败时把最近的事件轨迹打出来（"红了但不知道为什么红"最贵）。 */
export async function until(predicate, { timeoutMs = 4000, trail = [], label = '条件' } = {}) {
  const at = Date.now()
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() - at > timeoutMs) {
      const tail = trail.slice(-8).map((entry) => `${entry.kind ?? entry.t}:${entry.status ?? entry.text ?? ''}`)
      throw new Error(`等不到${label}（${timeoutMs}ms）。事件轨迹：[${tail.join(' | ')}]`)
    }
    await delay(10)
  }
}

/** 收集客户端事件流。 */
export function traceOf(client) {
  const trail = []
  client.on((event) => {
    trail.push({
      kind: event?.kind,
      status: event?.status,
      t: event?.payload?.t,
      text: event?.text ?? event?.message,
    })
  })
  return trail
}
