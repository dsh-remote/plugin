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
 * 2. **每个用例重新 `installWxShim()`**——storage 是每次装 shim 时新建的 `Map`，
 *    所以要用例之间互不污染，靠的是重装 shim，而**不是**清 require 缓存
 *    （`loadMpModules()` 走 `createRequire`，同一进程里模块只加载一次，模块级的
 *    状态会跨用例留着；要干净就得连模块级状态一起想清楚，别指望这里删缓存）。
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
    /**
     * 只看手机**交给中继**的 enc 帧密文字段（零知识断言的对象必须是"交给中继的那一帧"）。
     *
     * 方向命名是"从 socket 的角度看"的，很容易反：`direction: 'in'` = 手机发出去
     * （`task.send`），`direction: 'out'` = 手机收到的（`onMessage`）。交给中继的那一份是 'in'。
     */
    outboundCiphertexts() {
      return frames.filter((f) => f.direction === 'in' && f.raw.includes('"ciphertext"')).map((f) => f.raw)
    },
  }
}

export function installWxShim({ recorder } = {}) {
  const storage = new Map()
  const sockets = []
  /**
   * 原生组件（导航栏 / 页面底色）的最后一次取值。
   *
   * 它们是**命令式**设置的、深色模式下最容易留白顶栏的那两处，而 CSS 变量对比度闸门
   * 看不到——所以必须在这里留一份可断言的读数。判据见
   * `e2e/mp-theme.test.mjs` 的「原生组件配色也要过对比度」那几条。
   */
  const systemBars = { navigationBarColor: undefined, backgroundColor: undefined }

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
    /**
     * 导航栏 / 页面底色：记下参数而不是空实现。
     *
     * 为什么必须记（2026-10-06 审计）：`core/theme.js` 用**命令式**调用这两个 API
     * 来切深色下的导航栏与下拉回弹区——它们是原生组件，不吃 CSS 自定义属性，所以
     * `check-mp-contrast.mjs` 那 304 组 CSS 变量对比度**看不到它们**。
     * 而 shim 里原本没有这两个 API，于是 `theme.js` 那两个 `try/catch` 在**除
     * mp-theme.test.mjs 以外**的每个用例里都走 catch 分支——那两个调用从未真正执行过。
     * （那两个色值本身是有判据的：`mp-theme.test.mjs` 用自己的 stub 逐字钉住了
     * `#242424`/`#ffffff`/`#000000`。补 shim 是为了消除"这条分支在别处恒定走 catch"
     * 这个系统性盲点，不是为了让色值第一次被看见。）
     */
    // ⚠️ **不进 recorder**：recorder 是零知识帧审计的证据表（run.mjs 第 16 步要逐帧
    // 查明文），往里塞非帧内容会污染那条判据。读数走 systemBars 就够了。
    setNavigationBarColor(opts) {
      systemBars.navigationBarColor = opts
      opts?.success?.({})
    },
    setBackgroundColor(opts) {
      systemBars.backgroundColor = opts
      opts?.success?.({})
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
  return { wx, storage, sockets, systemBars }
}

/** 加载真实的小程序模块（绕开 require 缓存）。必须在 `installWxShim()` 之后调用。 */
export function loadMpModules() {
  const require = createRequire(import.meta.url)
  const codec = require(path.join(MP_DIR, 'core', 'codec.js'))
  const client = require(path.join(MP_DIR, 'core', 'client.js'))
  return { codec, client }
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
