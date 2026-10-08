/**
 * pill-routes.test — 状态栏那颗 pill 那四条路由的判据。
 *
 * 四条路由分两档安全姿态（动机写在 `src/pill/routes.ts` 文件头）：
 * `POST /pairing/new` 与 `POST /unpair` 会改状态（发一张码 / 作废当前通道），跨站判据是
 * 只有同源脚本发得出的自定义头 `x-drc-pair: 1`——**不是** `Origin`：桌面宿主的转发层会把它
 * 删掉，这一条是 2026-10-03 在真屏幕上点出来才发现的。`GET /pairing.png` 与 `GET /status`
 * 只读，Origin 缺席放过，但 Host 仍必须环回。
 *
 * 最重要的一条不是"能发码"，而是**响应里绝不能出现凭据**：`psk` 与完整 `qr` URI
 * 一旦经这条路由出去，就等于把"PSK 从不上网"这条红线（D1）从浏览器面捅了个洞。
 * 所以这里既断言字段集合，也把整段响应文本拿去比对凭据子串。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  hostIsLoopback,
  pairingEpoch,
  PAIR_IMAGE_ROUTE,
  PAIR_NEW_ROUTE,
  PAIR_STATUS_ROUTE,
  PAIR_UNPAIR_ROUTE,
  pairImageHandler,
  pairNewHandler,
  pillStatusHandler,
  registerPillRoutes,
  unpairHandler,
  type LivePairing,
  type PillRouteDeps,
} from '../src/pill/routes.js'

const FAKE_PSK = 'A'.repeat(64)
const FAKE_TOKEN = '482913'
const FAKE_QR = `dshr:/p?v=1&s=ws://relay&n=host&psk=${FAKE_PSK}&t=${FAKE_TOKEN}`
/** 版本号是弹窗第三行；用明显是假的字样，免得与真包版本混淆。 */
const FAKE_VERSION = '0.0.0-test'
/** PNG 的八个魔数字节——图片路由现在自己渲染，判据只能落在字节上。 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

interface Reply {
  status: number
  headers: Record<string, unknown>
  body: string
  /** 原样的字节。图片路由现在自己渲染，判据只能落在字节上，不能落在 utf8 转码后的字符串上。 */
  raw: Buffer
  ended: boolean
}

function response(): { res: ServerResponse; reply: () => Reply } {
  const captured: Reply = { status: 0, headers: {}, body: '', raw: Buffer.alloc(0), ended: false }
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status
      captured.headers = { ...(headers ?? {}) }
      return res
    },
    end(chunk?: unknown) {
      if (Buffer.isBuffer(chunk)) {
        captured.raw = chunk
        captured.body = chunk.toString('utf8')
      } else {
        captured.raw = Buffer.from(typeof chunk === 'string' ? chunk : '')
        captured.body = typeof chunk === 'string' ? chunk : ''
      }
      captured.ended = true
      return res
    },
  } as unknown as ServerResponse
  return { res, reply: () => captured }
}

function request(method: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, url: '/', headers } as unknown as IncomingMessage
}

/**
 * 真机上那颗 pill 发出来的形状：环回 `Host` + 那个自定义头。
 * `Origin` **故意不在这里**——桌面宿主转发时会把它删掉，这是 2026-10-03 在真屏幕上量出来的
 * （当时判据还是"Origin 必须存在"，于是点一下就是 403，弹窗上印着 `origin-missing`）。
 */
const LOOPBACK = { host: '127.0.0.1:19387', 'x-drc-pair': '1' }

function deps(
  over: Partial<PillRouteDeps> = {},
): PillRouteDeps & { calls: { ensure: number; current: number; unpair: number } } {
  const calls = { ensure: 0, current: 0, unpair: 0 }
  const live: LivePairing = { qr: FAKE_QR, token: FAKE_TOKEN, expiresAt: Date.now() + 60_000 }
  return {
    calls,
    ensureFresh: () => {
      calls.ensure += 1
      return live
    },
    current: () => {
      calls.current += 1
      return live
    },
    status: () => ({
      relay: 'online',
      paired: 1,
      pairings: 1,
      serverUrl: 'wss://relay.example.com:443/relay',
      version: FAKE_VERSION,
      waiting: 0,
      waitingOldestSec: 0,
    }),
    unpair: () => {
      calls.unpair += 1
      return 1
    },
    log: () => {},
    ...over,
  }
}

// ── POST /pairing/new ────────────────────────────────────────────────

test('点一下发码：回 state/epoch/token/剩余寿命，epoch 与 pairingEpoch 同一个口径', async () => {
  const d = deps()
  const { res, reply } = response()
  await pairNewHandler(d)(request('POST', LOOPBACK), res)
  const got = reply()
  assert.equal(got.status, 200)
  const body = JSON.parse(got.body) as Record<string, unknown>
  assert.equal(body.state, 'ready')
  assert.equal(body.token, FAKE_TOKEN, '6 位码要给——弹窗上"或手输这 6 位数字"靠它')
  assert.equal(body.epoch, pairingEpoch(FAKE_QR), 'epoch 必须是同一个哈希口径，否则弹窗会以为每次都是新码')
  assert.ok(typeof body.expiresInMs === 'number' && (body.expiresInMs as number) > 0)
})

test('响应里绝不含凭据：psk 与完整 qr URI 一个字都不许出现', async () => {
  const d = deps()
  const { res, reply } = response()
  await pairNewHandler(d)(request('POST', LOOPBACK), res)
  const raw = reply().body
  assert.ok(!raw.includes(FAKE_PSK), `响应里出现了 PSK：${raw}`)
  assert.ok(!raw.includes(FAKE_QR), `响应里出现了完整配对 URI：${raw}`)
  assert.ok(!raw.includes('psk'), `响应字段里出现了 psk 字样：${raw}`)
  assert.ok(!raw.includes('dshr:'), `响应里出现了配对 URI 的前缀：${raw}`)
})

test('幂等：连点两次只问一次，屏幕上不会挂出两张有效码', async () => {
  const d = deps()
  for (let i = 0; i < 2; i += 1) {
    const { res, reply } = response()
    await pairNewHandler(d)(request('POST', LOOPBACK), res)
    assert.equal(reply().status, 200)
  }
  // ensureFresh 本身就是"有就回原码"，所以这里数的是路由有没有绕过它去另发一张。
  assert.equal(d.calls.ensure, 2, '两条请求各问一次幂等入口（幂等语义在 ensureFresh 里面，那里另有单测）')
})

test('GET 打开发码路由 → 405：这条只接受 POST', async () => {
  const d = deps()
  const { res, reply } = response()
  await pairNewHandler(d)(request('GET', LOOPBACK), res)
  assert.equal(reply().status, 405)
  assert.equal(d.calls.ensure, 0, '被拒的请求绝不能已经先把码发出去了')
})

test('Origin 缺席 + 带自定义头 → 200：桌面宿主会删 origin，这条不能要求它在', async () => {
  // 真机形状（2026-10-03）：请求从 `dsh-app://app` 那个文档里发出来，走到我们手上时
  // `origin` 头已经被宿主转发层去掉了。要求它存在 = 那颗 pill 永远点不动。
  const d = deps()
  const { res, reply } = response()
  await pairNewHandler(d)(request('POST', LOOPBACK), res)
  assert.equal(reply().status, 200, reply().body)
  assert.equal(JSON.parse(reply().body).state, 'ready')
})

test('Origin 是宿主自己的自定义 scheme（`dsh-app://app`）→ 200：不是只有环回 http 才算自己', async () => {
  const d = deps()
  const { res, reply } = response()
  await pairNewHandler(d)(request('POST', { ...LOOPBACK, origin: 'dsh-app://app' }), res)
  assert.equal(reply().status, 200, reply().body)
})

test('少了那个自定义头 → 403 pair-marker-missing：这才是这条真正的 CSRF 判据', async () => {
  // 跨站页面要带自定义头就必须先过 CORS 预检，而这条服务既不响应 OPTIONS 也不发
  // `Access-Control-*`，浏览器会拦下；普通 HTML 表单更是没有设头的口子。
  const missing: Array<Record<string, string>> = [
    { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' },
    { host: '127.0.0.1:19387' },
    { host: '127.0.0.1:19387', 'x-drc-pair': 'yes' }, // 值不对也算没带
  ]
  for (const headers of missing) {
    const d = deps()
    const { res, reply } = response()
    await pairNewHandler(d)(request('POST', headers), res)
    assert.equal(reply().status, 403, `${JSON.stringify(headers)} 不该被放行`)
    assert.equal(JSON.parse(reply().body).guard, 'pair-marker-missing')
    assert.equal(d.calls.ensure, 0, '被拦下的请求不许改状态')
  }
})

test('跨站 Origin、`null` 来源与非环回 Host 都 → 403，各自报出自己那道守卫', async () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ ...LOOPBACK, origin: 'https://evil.example.com' }, 'origin-not-trusted'],
    [{ ...LOOPBACK, origin: 'null' }, 'origin-not-trusted'],
    [{ ...LOOPBACK, origin: 'not a url' }, 'origin-not-trusted'],
    // 自定义 scheme 走**白名单**：只有宿主自己的 `dsh-app:` 算"自己"。
    // 原来那条判据是"非 http(s) 一律放行"，于是别的浏览器扩展（跨站写请求发得出那个自定义头）
    // 只要带个 chrome-extension:// 的 Origin 就能过（2026-10-06 修）。
    [{ ...LOOPBACK, origin: 'chrome-extension://cnncmdfpacgibcdjkceegbjkkboijfhl' }, 'origin-not-trusted'],
    [{ ...LOOPBACK, origin: 'file://' }, 'origin-not-trusted'],
    [{ ...LOOPBACK, origin: 'data:text/html,<h1>x</h1>' }, 'origin-not-trusted'],
    [{ ...LOOPBACK, origin: 'dsh-app-evil://app' }, 'origin-not-trusted'],
    [{ ...LOOPBACK, host: 'evil.example.com' }, 'host-not-loopback'],
    [{ host: 'attacker.local:8787', origin: 'http://localhost:8787', 'x-drc-pair': '1' }, 'host-not-loopback'],
    // 缺 Host 头：不是"环回"，不许当自己人（代理/畸形请求的形状）。
    [{ 'x-drc-pair': '1' }, 'host-not-loopback'],
    [{ 'x-drc-pair': '1', origin: 'http://127.0.0.1:19387' }, 'host-not-loopback'],
  ]
  for (const [headers, guard] of cases) {
    const d = deps()
    const { res, reply } = response()
    await pairNewHandler(d)(request('POST', headers), res)
    assert.equal(reply().status, 403, `${JSON.stringify(headers)} 应当被拒`)
    assert.equal(JSON.parse(reply().body).guard, guard, `拒的原因要指对：${JSON.stringify(reply().body)}`)
    assert.equal(d.calls.ensure, 0)
  }
})

test('只读那两条同样认这套白名单：chrome-extension / 缺 Host / 非环回 Host 都拒', async () => {
  const cases: Array<[Record<string, string>, number]> = [
    [{ host: '127.0.0.1:19387' }, 200],
    [{ host: '127.0.0.1:19387', origin: 'chrome-extension://cnncmdfpacgibcdjkceegbjkkboijfhl' }, 403],
    [{ host: '127.0.0.1:19387', origin: 'null' }, 403],
    [{}, 403],
    [{ host: '[::1]:19387' }, 200],
    [{ host: '[fe80::1]:19387' }, 403],
  ]
  for (const [headers, expected] of cases) {
    const image = response()
    await pairImageHandler(deps())(request('GET', headers), image.res)
    assert.equal(image.reply().status, expected, `图片路由 ${JSON.stringify(headers)}`)
    const status = response()
    await pillStatusHandler(deps())(request('GET', headers), status.res)
    assert.equal(status.reply().status, expected, `状态路由 ${JSON.stringify(headers)}`)
  }
})

test('IPv6 方括号那一支：`[::1]` 是环回，畸形方括号（缺 `]` / 端口不是数字）不是', () => {
  // 这一段是手写解析（不用 `new URL`）：方括号分支写错的表现是"IPv6 环回被当成外站"，
  // 而那在真机上是整颗 pill 点不动。
  const loopback = ['[::1]:19387', '[::1]', '[::1]:0', '::1', '127.0.0.1:19387', 'localhost:19387']
  for (const host of loopback) assert.equal(hostIsLoopback(host), true, `${host} 应当算环回`)
  const foreign = ['[fe80::1]:19387', '[::1', '[::1]evil:80', '[::1]:notaport', 'evil.example.com', '', undefined]
  for (const host of foreign) assert.equal(hostIsLoopback(host), false, `${String(host)} 不该算环回`)
})

test('中继不在线：200 + state:"unavailable"，不是 500（pill 要能显示"未连接"）', async () => {
  const d = deps({ ensureFresh: () => null })
  const { res, reply } = response()
  await pairNewHandler(d)(request('POST', LOOPBACK), res)
  assert.equal(reply().status, 200)
  assert.deepEqual(JSON.parse(reply().body), { state: 'unavailable', reason: 'relay-offline' })
})

test('ensureFresh() 自己抛错 → 500 且不外抛到宿主，回答里带上截断后的原因', async () => {
  // 中继那边炸了不该表现成"整条路由把异常抛进宿主"，也不该回一个空白回答让 pill 卡在 loading 上。
  const d = deps({
    ensureFresh: () => {
      throw new Error('中继 socket 已经拆了')
    },
  })
  const { res, reply } = response()
  await pairNewHandler(d)(request('POST', LOOPBACK), res)
  assert.equal(reply().status, 500)
  assert.match(JSON.parse(reply().body).error, /中继 socket/)
})

test('stdout 日志里不许出现那个 6 位码（token 就是认领凭据，stdout 会被贴进 issue）', async () => {
  const logged: Array<Record<string, unknown>> = []
  const d = deps({
    log: (_message, fields) => {
      logged.push({ ...(fields ?? {}) })
    },
  })
  const { res, reply } = response()
  await pairNewHandler(d)(request('POST', LOOPBACK), res)
  assert.equal(reply().status, 200, '前提：这一次真发了一张码')
  assert.ok(logged.length > 0, '发码要留一条日志')
  const raw = JSON.stringify(logged)
  assert.ok(!raw.includes(FAKE_TOKEN), `日志里出现了 6 位码本身：${raw}`)
  assert.ok(!raw.includes('token:'), `日志字段名不许叫 token：${raw}`)
  // 排查要的两件事还在：知道"发出去了"与"是哪一版码"。
  assert.ok(
    logged.some((fields) => typeof fields.epoch === 'string' || typeof fields.tokenLength === 'number'),
    `日志要留下非凭据的标识（epoch / 长度）：${raw}`,
  )
})

// ── GET /pairing.png ────────────────────────────────────────────────

test('有码时图片路由**真的渲染出**一张 PNG：魔数字节 + Content-Length + no-store + ETag 是这一版的 epoch', async () => {
  const d = deps()
  const { res, reply } = response()
  await pairImageHandler(d)(request('GET', { host: '127.0.0.1:19387' }), res)
  const got = reply()
  assert.equal(got.status, 200)
  assert.equal(got.headers['Content-Type'], 'image/png')
  assert.equal(got.headers['Cache-Control'], 'no-store', '一张码会被就地换掉，缓存等于弹窗里停在废码上')
  assert.equal(got.headers.ETag, `"${pairingEpoch(FAKE_QR)}"`)
  assert.ok(got.raw.subarray(0, 8).equals(PNG_MAGIC), '必须是真 PNG 字节，不是"某个回调给的东西"')
  assert.equal(Number(got.headers['Content-Length']), got.raw.length, 'Content-Length 与字节数不一致会被截断')
  assert.equal(d.calls.ensure, 0, '看图不许顺手发码')
  assert.equal(d.calls.current, 1, '看图只问"当前有没有"，绝不问幂等入口——那等于顺手发码')
})

test('没有效码 → 204（路由在、只是现在没码），不是 404', async () => {
  const d = deps({ current: () => null })
  const { res, reply } = response()
  await pairImageHandler(d)(request('GET', { host: '127.0.0.1:19387' }), res)
  assert.equal(reply().status, 204)
  assert.equal(reply().ended, true)
})

test('图片路由只读：Origin 缺席放过，但非环回 Host 仍拒', async () => {
  const noOrigin = deps()
  const a = response()
  await pairImageHandler(noOrigin)(request('GET', { host: 'localhost:19387' }), a.res)
  assert.equal(a.reply().status, 200, '同源 GET 常常不带 Origin，只读路由不该因此拒')

  const badHost = deps()
  const b = response()
  await pairImageHandler(badHost)(request('GET', { host: 'evil.example.com' }), b.res)
  assert.equal(b.reply().status, 403)
})

test('HEAD 不写 body（宿主可能用它探活），而且**跳过渲染**：编不出来的一张码照样 200', async () => {
  const d = deps()
  const { res, reply } = response()
  await pairImageHandler(d)(request('HEAD', { host: '127.0.0.1:19387' }), res)
  assert.equal(reply().status, 200)
  assert.equal(reply().raw.length, 0, 'HEAD 连一个字节都不该写出去')

  // 反证：这一版码的 QR 容量超限、`renderPairingPng` 必抛（同一个 deps 上 GET 就是 500）。
  // HEAD 若走了渲染，这里也会是 500——插件探活时白烧一次 PNG 编码。
  const overflow: LivePairing = { qr: 'x'.repeat(20_000), token: FAKE_TOKEN, expiresAt: Date.now() + 60_000 }
  const head = response()
  await pairImageHandler(deps({ current: () => overflow }))(request('HEAD', { host: '127.0.0.1:19387' }), head.res)
  assert.equal(head.reply().status, 200, 'HEAD 必须跳过渲染')
  const get = response()
  await pairImageHandler(deps({ current: () => overflow }))(request('GET', { host: '127.0.0.1:19387' }), get.res)
  assert.equal(get.reply().status, 500, '前提：这张码 GET 一定编不出来')
})

test('图片路由只接受 GET/HEAD：POST 等写方法 → 405，且不去读当前码', async () => {
  const d = deps()
  const { res, reply } = response()
  await pairImageHandler(d)(request('POST', { host: '127.0.0.1:19387' }), res)
  assert.equal(reply().status, 405)
  assert.deepEqual(JSON.parse(reply().body), { error: 'method not allowed' })
  assert.equal(d.calls.current, 0, '被拒的请求不该已经去读当前码')
})

test('渲染抛错 → 500 且带截断后的原因，不抛到宿主', async () => {
  // 不注入假渲染器了——渲染就在路由里，那就用一份**真的编不出来**的码：
  // QR 的容量上限远小于这个长度，node-qrcode 会抛"code length overflow"。
  const d = deps({
    current: () => ({ qr: 'x'.repeat(20_000), token: FAKE_TOKEN, expiresAt: Date.now() + 60_000 }),
  })
  const { res, reply } = response()
  await pairImageHandler(d)(request('GET', { host: '127.0.0.1:19387' }), res)
  assert.equal(reply().status, 500)
  assert.ok((JSON.parse(reply().body).error as string).length <= 200, '原因要截断，不许把整段栈喷出去')
})

// ── GET /status（pill 抬头那句连接状态）──────────────────────────────

test('状态路由只出七个非凭据字段：relay / paired / pairings / serverUrl / version / waiting / waitingOldestSec', async () => {
  const d = deps()
  const { res, reply } = response()
  await pillStatusHandler(d)(request('GET', { host: '127.0.0.1:19387' }), res)
  const got = reply()
  assert.equal(got.status, 200)
  assert.deepEqual(JSON.parse(got.body), {
    relay: 'online',
    paired: 1,
    pairings: 1,
    serverUrl: 'wss://relay.example.com:443/relay',
    version: FAKE_VERSION,
    waiting: 0,
    waitingOldestSec: 0,
  })
  const raw = got.body
  for (const secret of [FAKE_PSK, FAKE_QR, FAKE_TOKEN, 'dshr:']) {
    assert.ok(!raw.includes(secret), `状态回答里出现了 ${secret}：${raw}`)
  }
  assert.ok(!raw.includes('hostLabel'), `本机名 2026-10-03 从面板上撤了，回答里也不该再有：${raw}`)
  assert.equal(d.calls.ensure, 0, '看状态绝不顺手发码')
  assert.equal(d.calls.unpair, 0, '看状态更不该解配')
})

test('runtime 还没起来时 relay 是 idle，不是 offline（pill 要说的是"没启动"而不是"断了"）', async () => {
  const d = deps({
    status: () => ({
      relay: 'idle',
      paired: 0,
      pairings: 0,
      serverUrl: 'wss://relay.example.com:443/relay',
      version: FAKE_VERSION,
      waiting: 0,
      waitingOldestSec: 0,
    }),
  })
  const { res, reply } = response()
  await pillStatusHandler(d)(request('GET', { host: '127.0.0.1:19387' }), res)
  assert.deepEqual(JSON.parse(reply().body), {
    relay: 'idle',
    paired: 0,
    pairings: 0,
    serverUrl: 'wss://relay.example.com:443/relay',
    version: FAKE_VERSION,
    // runtime 还没起来时"没有事在等"必须是**读出来的 0**，不是字段缺席——
    // 缺席会让浏览器面那侧退回 `已配对`，而那一刻真正该说的是"远程未启动"。
    waiting: 0,
    waitingOldestSec: 0,
  })
})

test('状态路由是只读的：Origin 缺席放过，非环回 Host 仍拒，POST 拒', async () => {
  const noOrigin = deps()
  const a = response()
  await pillStatusHandler(noOrigin)(request('GET', { host: 'localhost:19387' }), a.res)
  assert.equal(a.reply().status, 200)

  const badHost = deps()
  const b = response()
  await pillStatusHandler(badHost)(request('GET', { host: 'evil.example.com' }), b.res)
  assert.equal(b.reply().status, 403)

  const written = deps()
  const c = response()
  await pillStatusHandler(written)(request('POST', LOOPBACK), c.res)
  assert.equal(c.reply().status, 405)
})

test('status() 自己抛错 → 500 且不外抛到宿主', async () => {
  const d = deps({
    status: () => {
      throw new Error('relay 被拆了')
    },
  })
  const { res, reply } = response()
  await pillStatusHandler(d)(request('GET', { host: '127.0.0.1:19387' }), res)
  assert.equal(reply().status, 500)
})

// ── POST /unpair（退出配对）──────────────────────────────────────────

test('退出配对：POST 回 {state:"ok", unpaired:n}，真去作废通道', async () => {
  const d = deps()
  const { res, reply } = response()
  await unpairHandler(d)(request('POST', LOOPBACK), res)
  const got = reply()
  assert.equal(got.status, 200)
  assert.deepEqual(JSON.parse(got.body), { state: 'ok', unpaired: 1 })
  assert.equal(d.calls.unpair, 1, '必须真的走到 unpair 那一步')
  assert.equal(d.calls.ensure, 0, '解配不许顺手发码')
})

test('本来就没配上（unpair 回 0）也是 200：这是正常竞态，不是错误', async () => {
  const d = deps({ unpair: () => 0 })
  const { res, reply } = response()
  await unpairHandler(d)(request('POST', LOOPBACK), res)
  assert.equal(reply().status, 200)
  assert.deepEqual(JSON.parse(reply().body), { state: 'ok', unpaired: 0 })
})

test('退出配对是写路由：GET → 405，缺自定义头 → 403，跨站 Origin → 403，非环回 Host → 403', async () => {
  const byMethod = deps()
  const a = response()
  await unpairHandler(byMethod)(request('GET', LOOPBACK), a.res)
  assert.equal(a.reply().status, 405)
  assert.equal(byMethod.calls.unpair, 0, '被拒的请求绝不能已经先解了配')

  const cases: Array<[Record<string, string>, string]> = [
    [{ host: '127.0.0.1:19387' }, 'pair-marker-missing'],
    [{ host: '127.0.0.1:19387', 'x-drc-pair': 'yes' }, 'pair-marker-missing'],
    [{ ...LOOPBACK, origin: 'https://evil.example.com' }, 'origin-not-trusted'],
    [{ ...LOOPBACK, origin: 'null' }, 'origin-not-trusted'],
    [{ host: 'evil.example.com', 'x-drc-pair': '1' }, 'host-not-loopback'],
  ]
  for (const [headers, guard] of cases) {
    const d = deps()
    const { res, reply } = response()
    await unpairHandler(d)(request('POST', headers), res)
    assert.equal(reply().status, 403, `${JSON.stringify(headers)} 应当被拒`)
    assert.equal(JSON.parse(reply().body).guard, guard, `拒的原因要指对：${reply().body}`)
    assert.equal(d.calls.unpair, 0, '被拦下的请求不许改状态')
  }
})

test('宿主自己的自定义 scheme（`dsh-app://app`）→ 200：与发码那条同一个口径', async () => {
  const d = deps()
  const { res, reply } = response()
  await unpairHandler(d)(request('POST', { ...LOOPBACK, origin: 'dsh-app://app' }), res)
  assert.equal(reply().status, 200, reply().body)
})

test('unpair() 自己抛错 → 500 且不外抛到宿主', async () => {
  const d = deps({
    unpair: () => {
      throw new Error('relay 被拆了')
    },
  })
  const { res, reply } = response()
  await unpairHandler(d)(request('POST', LOOPBACK), res)
  assert.equal(reply().status, 500)
})

// ── 注册与注销 ───────────────────────────────────────────────────────

test('注册挂上四条、注销把四条都摘掉', () => {
  const registered: string[] = []
  let off = 0
  const web = {
    register: (route: { path: string }) => {
      registered.push(route.path)
      return () => {
        off += 1
      }
    },
  }
  const unregister = registerPillRoutes(web as never, deps())
  assert.deepEqual(registered, [PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE, PAIR_UNPAIR_ROUTE])
  unregister()
  assert.equal(off, 4)
})

test('第二条挂不上时，第一条必须被回滚掉：半途失败不许在宿主上留下摘不走的路由', () => {
  const registered: string[] = []
  let off = 0
  const web = {
    register: (route: { path: string }) => {
      registered.push(route.path)
      if (registered.length === 2) throw new Error('这条路径宿主不给挂')
      return () => {
        off += 1
      }
    },
  }
  assert.throws(() => registerPillRoutes(web as never, deps()), /宿主不给挂/, '原始错误要抛回去，让上层留痕')
  assert.equal(registered.length, 2, '确实只挂上第一条就失败了')
  assert.equal(off, 1, '第一条必须被注销掉——否则它永久留在宿主上，重载之后谁都挂不上那条')
})

test('一条注销抛错不许让其余留在宿主上', () => {
  let off = 0
  const web = {
    register: () => () => {
      off += 1
      if (off === 1) throw new Error('宿主已经先拆了')
    },
  }
  const unregister = registerPillRoutes(web as never, deps())
  assert.doesNotThrow(() => unregister())
  assert.equal(off, 4, '后三条必须仍然被调用')
})

test('反证：环回主机名这份表只有一份，写路由与只读那条必须同一个口径', async () => {
  // 若有人在这里另写一套字面量，最先露馅的就是这种"边界上那一种写法"：https 的 localhost
  // 在只读那条一直是放过的，写这条若判成拒，表现就是"右栏弹得出码、pill 点不动"。
  for (const origin of ['http://localhost:19387', 'https://localhost:19387', 'http://127.0.0.1:19387']) {
    const d = deps()
    const { res, reply } = response()
    await pairNewHandler(d)(request('POST', { ...LOOPBACK, origin }), res)
    assert.equal(reply().status, 200, `${origin} 应当算宿主自己：${reply().body}`)
  }
  // 而这一条钉住的是本轮真机那个结论：**谁把"Origin 必须存在"加回来，上面那条
  // "Origin 缺席 + 带自定义头 → 200" 就会立刻红**——不是判据松了，是那颗 pill 又点不动了。
})

test('反证：不再宣称"pill 拿 ETag 判断要不要重画"（`<img>` 拿不到响应头，而且响应是 no-store）', () => {
  // ETag 本身留着（排错有用），错的是那句注释给后来的人指了一条不成立的路：
  // 浏览器面判"换没换码"靠的是图片 URL 上那个 `?e=<epoch>`，不是响应头。
  const here = path.dirname(fileURLToPath(import.meta.url))
  // 产物在 `dist/tests/`，所以源码要往上两层（`client-bundle.test.ts` 那条同款）。
  const routes = readFileSync(path.join(here, '..', '..', 'src', 'pill', 'routes.ts'), 'utf8')
  const client = readFileSync(path.join(here, '..', '..', 'client', 'src', 'pill.ts'), 'utf8')
  assert.doesNotMatch(routes, /pill 拿它判断要不要重画/, '那句注释是误导：`<img>` 拿不到 ETag，响应还是 no-store')
  assert.doesNotMatch(client, /headers\.get\(/, '浏览器面从来没读过响应头，别照那句注释去实现')
  assert.match(routes, /ETag: `"\$\{pairingEpoch\(pairing\.qr\)\}"`/, 'ETag 留着（排错用），只是不再宣称有人读它')
})
