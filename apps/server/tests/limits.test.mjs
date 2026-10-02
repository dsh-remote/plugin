/**
 * limits.test — `limits.ts` 里那两个闸门的判定语义（纯内存，不起 socket）。
 *
 * 需求来源：docs/DESIGN-REVIEW.md 第 11 条（🟡）——「慢消费者 1008 会与手机的 12s 超时 /
 * 30s 退避形成循环」。读码确证后，这条不只是"阈值没实测"，而是**判定本身写错了**：
 *
 * 1. 断开的窗口对 client 与 host 用了同一个值（10s）。可 client 侧 `mp/core/socket.js`
 *    每次 `onOpen` 都把退避重置为 0（:169 / :213），而 `onClose` **不读关闭码**（全文没有
 *    任何一处读 code），于是"被踢 → ~1s 后回来 → 再被踢"是一个**永不升级的 ~11s 循环**，
 *    用户只看到"连接已断开，正在重连…"。中继在这里是那台发动机。
 * 2. 判定只挂在 `ws.on('message')` 上：**静默的慢客户端永远不被评估**（它不说话就没人查），
 *    缓冲区一直挂着；爱说话的慢客户端反而被踢。所以判定必须由定时扫描驱动。
 *
 * 这个文件锁两件事：
 * - 客户端窗口必须**严格大于对端自己的重连周期**（跨层不变量，直接读 mp 源码的常量，
 *   对端一改这里就红）；
 * - 闸门本身的语义（连续超限才断、中途降下来要清零、窗口按角色给）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BackpressureGate, CLIENT_SLOW_CONSUMER_MS, HOST_SLOW_CONSUMER_MS } from '../dist/src/limits.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const MP_SOCKET = path.join(here, '..', '..', '..', 'mp', 'core', 'socket.js')

/** 从 mp 源码里读一个 `NAME = 123` 形式的常量（小程序端是唯一事实源，不许抄进注释就算）。 */
function mpConstant(name) {
  const source = readFileSync(MP_SOCKET, 'utf8')
  const matched = new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(source)
  assert.ok(matched, `mp/core/socket.js 里找不到 ${name}：对端改了常量名，这条不变量得跟着改`)
  return Number(matched[1].replace(/_/g, ''))
}

test('客户端窗口必须大于对端自己的重连周期：否则中继就是那个 ~11s 循环的发动机', () => {
  const connectTimeout = mpConstant('CONNECT_TIMEOUT_MS')
  const reconnectMax = mpConstant('RECONNECT_MAX_MS')
  const jitter = Number(/Math\.random\(\)\s*\*\s*([0-9]+)/.exec(readFileSync(MP_SOCKET, 'utf8'))?.[1] ?? 0)
  const peerCycle = connectTimeout + reconnectMax + jitter

  assert.ok(
    CLIENT_SLOW_CONSUMER_MS > peerCycle,
    `客户端窗口 ${CLIENT_SLOW_CONSUMER_MS}ms 没有超过对端重连周期 ${peerCycle}ms ` +
      `(CONNECT_TIMEOUT_MS=${connectTimeout} + RECONNECT_MAX_MS=${reconnectMax} + 抖动=${jitter})：` +
      '窗口若落在周期内，手机每次刚回来就又被踢，形成永不升级的重连循环',
  )
  assert.ok(
    HOST_SLOW_CONSUMER_MS < CLIENT_SLOW_CONSUMER_MS,
    '主机与客户端必须用不同的窗口：主机没有这套"断开即重连"的对端行为，卡住它就是卡住所有人',
  )
})

test('连续超限才断：中途降回限内要把计时清零（不能累计）', () => {
  const gate = new BackpressureGate()
  const limit = 100

  assert.deepEqual(gate.check(50, limit, 0, HOST_SLOW_CONSUMER_MS).shouldClose, false, '没超限不该断')
  gate.check(500, limit, 1_000, HOST_SLOW_CONSUMER_MS)
  assert.equal(gate.check(500, limit, 9_000, HOST_SLOW_CONSUMER_MS).shouldClose, false, '超限 8s，未到 10s 窗口')
  assert.equal(gate.check(500, limit, 11_000, HOST_SLOW_CONSUMER_MS).shouldClose, true, '超限 10s 以上该断')

  // 清零：降到限内之后，计时必须重新开始
  const fresh = new BackpressureGate()
  fresh.check(500, limit, 0, HOST_SLOW_CONSUMER_MS)
  fresh.check(50, limit, 5_000, HOST_SLOW_CONSUMER_MS) // 降回限内 → 清零
  fresh.check(500, limit, 6_000, HOST_SLOW_CONSUMER_MS)
  assert.equal(
    fresh.check(500, limit, 15_000, HOST_SLOW_CONSUMER_MS).shouldClose,
    false,
    '中途降到限内之后又从 6s 重新计时，15s 时只累计了 9s，不该断',
  )
})

test('窗口按角色给：同样"超限 10 秒"，主机该断、客户端不该断（🟡11 的回归点）', () => {
  const limit = 100
  const at = (windowMs) => {
    const gate = new BackpressureGate()
    gate.check(limit + 1, limit, 0, windowMs)
    return gate.check(limit + 1, limit, 10_000, windowMs).shouldClose
  }

  assert.equal(at(HOST_SLOW_CONSUMER_MS), true, '主机超限 10s 就该断（原行为，不许被这条修复改掉）')
  assert.equal(
    at(CLIENT_SLOW_CONSUMER_MS),
    false,
    '客户端超限 10s **不许断**：这正是被修掉的那个 bug（10s < 手机的重连周期）',
  )
})

test('超限时长会被报出来，便于写进日志', () => {
  const gate = new BackpressureGate()
  gate.check(500, 100, 1_000, CLIENT_SLOW_CONSUMER_MS)
  assert.equal(gate.check(500, 100, 4_000, CLIENT_SLOW_CONSUMER_MS).overMs, 3_000, 'overMs 必须是"已经连续超限多久"')
  assert.equal(gate.check(50, 100, 5_000, CLIENT_SLOW_CONSUMER_MS).overMs, 0, '不再超限时 overMs 归零')
})
