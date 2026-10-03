/**
 * mp-pair-recovery — 「会话在服务端已经没了」这条路径的对照测试。
 *
 * 这是一条**真机故障**的护栏，不是设想的边界。现象（2026-10-02 取证）：
 * 主机插件重启过 → 中继侧的会话被回收（healthz 显示 `conversations: 0`，
 * 而手机的 socket 还连着，`clients: 1`）→ 手机上会话列表永远是空的，
 * 点「＋新建会话」没反应，12 秒后才因超时弹一句「主机没有回应」，
 * 界面上却一直显示「在线 / 已连接，正在同步会话列表」。
 *
 * 病根是**在验证之前就宣布 online**：`isPaired()` 只说明本机存着 PSK 与 convId，
 * 主机侧那条会话早就不存在了。修法是把 online 推迟到"主机真的回了一句"，
 * 并让 needs-pair 能把界面带回扫码页。
 *
 * 这里只测纯逻辑（`_onFrame` 是同步的，喂 JSON 字符串即可），不碰 socket。
 */
import { createRequire } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// client.js 走 wx shim；这里只需要 storage 与提示类 API 存在。
const storage = new Map()
const toasts = []
globalThis.wx = {
  getStorageSync: (k) => storage.get(k) ?? '',
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: (o) => toasts.push(o),
  showModal: () => {},
  navigateTo: () => {},
  stopPullDownRefresh: () => {},
  vibrateShort: () => {},
  setNavigationBarColor: () => {},
  createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => ({ exec: () => {} }) }) }),
}

const codec = require(path.join(ROOT, 'dsh-remote-mp/miniprogram/core/codec.js'))
const { DrcClient } = require(path.join(ROOT, 'dsh-remote-mp/miniprogram/core/client.js'))

/** 32 字节的合法 PSK（base64）。用真密钥而不是假对象：sendCmd 会走 codec.seal。 */
const TEST_PSK = Buffer.alloc(32, 7).toString('base64')
const GONE_CONV = 'c_gone'

/** 造一个"本机认为已配对"的客户端，并把状态推进到恢复尝试的那一刻。 */
function pairedClient() {
  const c = new DrcClient()
  // 直接摆出 hydrate() 之后该有的样子：PSK + convId + 两把真密钥。
  c.psk = TEST_PSK
  c.convId = GONE_CONV
  c.kC2H = codec.derivePskKey(TEST_PSK, 'c2h', GONE_CONV)
  c.kH2C = codec.derivePskKey(TEST_PSK, 'h2c', GONE_CONV)
  c._resume = { psk: c.psk, convId: c.convId, nonceCounter: 0 }
  c.sock = { send: () => true }
  c.sendControl = () => true
  return c
}

test('恢复连接时不谎报 online：主机确认之前一律是 connecting', () => {
  const c = pairedClient()
  const seen = []
  c.on((e) => {
    if (e.kind === 'status') seen.push([e.status, e.text])
  })
  c._onHelloOk({ clientId: 'c_probe' })

  assert.equal(c.status, 'connecting', `恢复期间必须是 connecting，实际 ${c.status}`)
  assert.ok(
    !seen.some(([s]) => s === 'online'),
    `主机还没回话就宣布 online 了：${JSON.stringify(seen)}`,
  )
  // 主动作据此置灰（wxml 的条件是 status === 'online'）
  assert.notEqual(c.status, 'online', '按钮的可用性正是由这个状态决定的')
})

test('主机真的回了列表，才升到 online', () => {
  const c = pairedClient()
  c._onHelloOk({ clientId: 'c_probe' })
  assert.equal(c.status, 'connecting')

  // 用**真加密**造一帧主机回包：走完整的 seal → open，才算真的验了解密路径。
  const nonce = codec.buildNonce(new Uint8Array(16), 1)
  const box = codec.seal(c.kH2C, { t: 'ev.session_changed', sessions: [{ id: 's1', state: 'idle' }] }, nonce)
  c._onEncrypted({ sessionId: GONE_CONV, ciphertext: box.ciphertext })

  assert.equal(c.status, 'online', '主机确认过了才可以是 online')
  assert.deepEqual(c.sessions.map((s) => s.id), ['s1'])
})

test('会话已被回收：收到 unknown_session 就丢掉本机 pairing 并要求重新扫码', () => {
  const c = pairedClient()
  c._onHelloOk({ clientId: 'c_probe' })

  // 中继对一条不存在的会话回的就是这个（真机取证 + 独立探针都验过）。
  c._onFrame(
    JSON.stringify({ t: 'error', code: 'unknown_session', message: '会话已失效，请重新扫码配对' }),
  )

  assert.equal(c.status, 'needs-pair', `失效会话必须回到需要配对，实际 ${c.status}`)
  assert.equal(c.isPaired(), false, '本机的 pairing 必须一起丢掉，否则下次还会重蹈覆辙')
  assert.match(String(c.statusText), /重新配对|重新扫码/, '要给用户一条能走的出路')
})

test('恢复期间新建会话立刻失败，而不是干等 12 秒超时', async () => {
  const c = pairedClient()
  c._onHelloOk({ clientId: 'c_probe' })

  // 页面按 status 置灰按钮；这一条锁住"即使被绕过也不会静默等待"。
  const before = Date.now()
  const res = await c.newSession()
  const waited = Date.now() - before

  assert.equal(res.ok, false, '主机没确认过会话就不该假装能新建')
  assert.ok(waited < 2000, `应该立刻返回，实际等了 ${waited}ms（真机上这是 12 秒）`)
})
