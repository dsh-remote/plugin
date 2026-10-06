/**
 * frame-budget.test — 生产端每一处"体积预算"与**中继那条 1 MiB 硬帧上限**的关系。
 *
 * ## 为什么这类关系需要判据
 *
 * `DRC_MAX_MSG_BYTES`（中继 `ws.maxPayload`）与 `MAX_CIPHERTEXT_BYTES`（协议层 schema）
 * 是**两个仓各自的常数**，而"某处能产出多大的载荷"是第三、第四个仓里的另一个常数。
 * 三者之间没有任何编译期关系，调大任何一边都不会有编译错误、不会有测试变红，
 * 直到真机上表现为**整条连接被 1009 关掉**（ws 层）或**帧被静默丢弃**（schema 层）。
 *
 * 这不是假想：本轮就在 mp 侧真找到一个——附件那两道闸只算附件，正文长度没人管，
 * 512KB 附件 + ~88KB 正文就顶过了上限（见 §0.10.2 第 8 条）。同一个错误形状。
 *
 * ## 这里量的是"真的上线多大"
 *
 * 不是按公式估算，而是**用真实的 `seal()`** 把载荷密封、算 base64、装进信封再量字节。
 * 公式对不对不重要——本轮已经因为"盯着纸面算术"踩过一次（`payload += String(len)`，
 * 估算值被算成 3.1MB，见 §0.10.7 第 9 条）。**要有人真的跑一遍。**
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROTOCOL_DIST = path.join(ROOT, 'dsh-remote-protocol', 'dist', 'src', 'index.js')
const PLUGIN_SRC = path.join(ROOT, 'dsh-remote-control', 'packages', 'plugin', 'src')
const MP_CHAT = path.join(ROOT, 'dsh-remote-mp', 'miniprogram', 'pages', 'chat', 'chat.js')

const haveAll = existsSync(PROTOCOL_DIST) && existsSync(PLUGIN_SRC) && existsSync(MP_CHAT)

/**
 * 从源码里取一个数值常数（避免为了断言一个数字就去 import 一整棵仓）。
 *
 * ⚠️ 必须能算**简单算式**：`512 * 1024` 这种写法到处都是。第一版只抓 `([0-9_]+)`，
 * 于是 `MAX_ATTACH_TOTAL_BYTES` 被读成 **512**（而不是 524288），后面的余量断言
 * 全是按 512 算的——**它"绿"着把一个错的数当真的**。这类错误只有把数拿出来看一眼才会发现。
 */
function constantFrom(file, name) {
  // 右值取到行尾**或**第一个 `//` 为止：这些常数行后面几乎都跟着解释性注释，
  // 锚到行尾会把它们全判成"找不到"（第一版就栽在这儿）。
  const m = new RegExp(`${name}\\s*=\\s*([^/\\n]+)`, 'm').exec(readFileSync(file, 'utf8'))
  assert.ok(m, `${file} 里找不到常数 ${name}`)
  const expr = m[1].replace(/_/g, '').trim()
  assert.match(expr, /^[0-9\s*]+$/, `${name} 的右值不是纯算式（读到 ${JSON.stringify(expr)}）：判据自己看不懂了`)
  // 只允许数字与乘号：eval 一个来自源码的字符串之前，先把字符集卡死。
  // eslint-disable-next-line no-eval
  return eval(expr)
}

/** 用真实 seal 把一条载荷装进真实信封，返回线上帧的字节数。 */
function wireFrameBytes(seal, payload) {
  const record = seal(new Uint8Array(32), payload, new Uint8Array(24))
  const frame = JSON.stringify({
    t: 'enc',
    sessionId: 'c_ffffffffffff',
    seq: 1,
    clientId: 'client-1',
    ciphertext: record.ciphertext,
  })
  return Buffer.byteLength(frame, 'utf8')
}

test('生产端的三处体积预算，都装得进中继的 1 MiB 硬帧上限（用真实 seal 量）', async () => {
  if (!haveAll) return
  const { seal, MAX_RELAY_MESSAGE_BYTES, MAX_CIPHERTEXT_BYTES } = await import(PROTOCOL_DIST)
  const relayLimit = MAX_RELAY_MESSAGE_BYTES

  const carrier = constantFrom(path.join(MP_CHAT), 'MAX_ATTACH_TOTAL_BYTES')
  const delta = constantFrom(path.join(MP_CHAT), 'DELTA_FLUSH_CHARS')
  const history = constantFrom(path.join(PLUGIN_SRC, 'platform', 'carrier-services.ts'), 'HISTORY_CHAR_BUDGET')

  // ① 附件顶格：原始字节 → base64（mp 侧就是这么进载荷的）
  const attachBase64 = Buffer.alloc(carrier, 0x41).toString('base64')
  const attachFrame = wireFrameBytes(seal, {
    t: 'cmd.send_prompt',
    cmdId: 'c1',
    sessionId: 'ses_x',
    text: '',
    files: [{ name: 'a.bin', mediaType: 'bin', data: attachBase64 }],
  })

  // ② 一帧流式增量：最坏是一整条 maxCharsPerFrame 的文本
  const deltaFrame = wireFrameBytes(seal, {
    t: 'ev.message_delta',
    messageId: 'm1',
    delta: '中'.repeat(delta), // 用 CJK：UTF-8 3 字节/字符，是最坏情况
  })

  // ③ 一整页历史：预算是**字符**数，CJK 同样是最坏情况
  const historyFrame = wireFrameBytes(seal, {
    t: 'ev.session_history',
    cmdId: 'c1',
    nextBeforeSeq: null,
    events: [{ kind: 'text', sessionId: 'ses_x', text: '中'.repeat(history) }],
  })

  for (const [name, bytes] of [
    ['附件顶格', attachFrame],
    ['一帧流式增量', deltaFrame],
    ['一整页历史', historyFrame],
  ]) {
    assert.ok(
      bytes <= relayLimit,
      `${name} 出来 ${bytes} 字节 > 中继 ws.maxPayload ${relayLimit}：` +
        '这会被 ws 以 1009 关掉**整条连接**（用户看到的是"发出去就掉线"）',
    )
    // schema 侧那条更早生效：超了它就是"帧被静默丢弃"，比 1009 更难查。
    assert.ok(
      bytes <= MAX_CIPHERTEXT_BYTES + 512,
      `${name} 出来 ${bytes} 字节，顶到协议层的密文上限 ${MAX_CIPHERTEXT_BYTES}：` +
        '再往上一点中继就会回 bad_frame，而手机侧看不到任何东西',
    )
  }
})

test('mp 发送前那道帧闸的预算，**必须装得下附件路径能产出的最坏帧**（否则附件静默发不出去）', async () => {
  if (!haveAll) return
  const { seal } = await import(PROTOCOL_DIST)
  const RELAY = 1024 * 1024
  const mpChat = readFileSync(MP_CHAT, 'utf8')

  const carrier = constantFrom(MP_CHAT, 'MAX_ATTACH_TOTAL_BYTES')
  const guardBudget = constantFrom(MP_CHAT, 'WIRE_FRAME_BUDGET')
  const guardHeadroom = constantFrom(MP_CHAT, 'WIRE_FRAME_HEADROOM')

  // 附件路径能产出的最坏帧：512KiB 原始字节（base64 进载荷）→ 密封 → 信封。
  const worstFrame = wireFrameBytes(seal, {
    t: 'cmd.send_prompt',
    cmdId: 'c1',
    sessionId: 'ses_x',
    text: '',
    files: [{ name: 'a.bin', mediaType: 'bin', data: Buffer.alloc(carrier, 0x41).toString('base64') }],
  })

  // 这条是**跨文件**的关系，两边都在 mp 里但没有任何东西把它们连起来：
  // 闸的预算 < 附件能产出的最坏帧 ⇒ 用户顶格带附件时，那条消息会在发送前被自己拒掉，
  // 而症状只是"发不出去"，没有任何一层会报"预算不够"。
  const effectiveGuard = guardBudget - guardHeadroom
  assert.ok(
    effectiveGuard >= worstFrame,
    `顶格附件（${carrier} 原始字节）会产出 ${worstFrame} 字节的帧，而 mp 的发送闸只让 ` +
      `${effectiveGuard} 字节过（${guardBudget} − ${guardHeadroom}）：` +
      '顶格附件会被自己拒掉，而用户只看到"发不出去"。要么把附件预算降下来，要么把闸放宽',
  )
  // 闸本身也不能宽过中继的硬上限，否则闸形同虚设（那正是本轮修掉的那个 bug）。
  assert.ok(
    guardBudget >= RELAY,
    `WIRE_FRAME_BUDGET=${guardBudget} 小于中继的 ${RELAY}：闸在放行的东西中继根本收不下`,
  )
  // 留一点余量这件事本身也钉一下：附件顶格后只剩这么点空间给正文，
  // 大约就是这个量级的正文会被拒（§0.10.7 第 8 条真踩到的那个组合）。
  const slack = RELAY - worstFrame
  assert.ok(
    slack > 0 && slack < RELAY * 0.15,
    `顶格附件之后只剩 ${slack} 字节（${((slack / RELAY) * 100).toFixed(1)}%）给正文：` +
      '余量太大说明附件预算定保守了，太小说明"带附件 + 长正文"这个组合基本发不出去——' +
      '两个方向都要知道，而不是等真机上撞到',
  )
})
