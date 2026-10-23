/**
 * 小程序码的取码器（2026-10-21）。
 *
 * 守的是"回落"那条路：**中继没配小程序是正常的**，那时 `pairing.png` 必须仍旧给出
 * 本机渲的旧码。所以这里的判据不只在成功那一侧——"要不到要说清是哪一档"与
 * "要不到不许每次都打一次外网"同样重要。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MP_CODE_PATH, createMpCodeFetcher, mpCodeUrlFor, type MpCodeFetch } from '../src/shell/mp-code.js'

/** 一张最小但真的 JPEG（魔数 FF D8 + 结尾 FF D9）：成败判据看的就是这两个字节。 */
const JPEG = Buffer.from([0xff, 0xd8, 0x00, 0x01, 0xff, 0xd9])
/** 中继失败时那种"200 + JSON"：形状判据必须把它认成失败。 */
const JSON_BODY = Buffer.from('{"error":"mp_code_failed"}')

/** 造一个假 fetch：按 `handler` 回答，`calls` 记下每一次请求的 URL。 */
function fakeFetch(handler: (url: string) => { status: number; body?: Buffer }): {
  fetchImpl: MpCodeFetch
  urls: string[]
} {
  const urls: string[] = []
  const fetchImpl: MpCodeFetch = async (input) => {
    urls.push(String(input))
    const answer = handler(String(input))
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      arrayBuffer: async () => {
        const bytes = answer.body ?? Buffer.alloc(0)
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      },
    }
  }
  return { fetchImpl, urls }
}

test('地址：ws(s) 换成 http(s)，**保留路径前缀**再拼 /code', () => {
  assert.equal(mpCodeUrlFor('wss://drc.provid.cc'), 'https://drc.provid.cc/code')
  assert.equal(mpCodeUrlFor('ws://127.0.0.1:8787'), 'http://127.0.0.1:8787/code')
  /**
   * **B 口径翻转**（裁决出处：`docs/RELEASE-CADENCE.md` §3.1，2026-10-23 用户定的
   * 0.5.0 验证方案）：路径前缀是**路由前缀**（`wss://drc.provid.cc/v05` 由 nginx
   * 剥前缀转给验证/生产实例）——覆盖掉它，取码会打到根路径那套实例、配对却走
   * /v05 ⇒ 码根本认领不到（"扫了没反应"）。旧纪律"路径整个替换"防的
   * "地址尾巴带杂路径拼出不存在的路由"由"前缀 + 固定路径"的形状兜住。
   */
  assert.equal(mpCodeUrlFor('wss://x.example/y'), 'https://x.example/y/code')
  assert.equal(mpCodeUrlFor('wss://x.example/y/'), 'https://x.example/y/code', '末尾斜杠归一')
  assert.equal(mpCodeUrlFor('wss://drc.provid.cc/v05'), 'https://drc.provid.cc/v05/code')
  assert.equal(mpCodeUrlFor('https://drc.provid.cc'), undefined, '非 ws(s) 地址拼不出取码 URL')
  assert.equal(mpCodeUrlFor('不是地址'), undefined)
  assert.equal(MP_CODE_PATH, '/code')
})

test('取到 JPEG 就给图，且按配对码缓存（不重复打外网）', async () => {
  const { fetchImpl, urls } = fakeFetch(() => ({ status: 200, body: JPEG }))
  const mp = createMpCodeFetcher({ serverUrl: 'wss://drc.provid.cc', fetchImpl })
  const first = await mp.codeFor('042915')
  assert.ok(first, '必须拿到图')
  assert.equal(first!.length, JPEG.length)
  assert.equal(mp.state(), 'ok')
  const second = await mp.codeFor('042915')
  assert.equal(second, first, '同一枚码必须命中缓存')
  assert.equal(urls.length, 1, '缓存命中后不许再打一次外网')
})

test('200 但不是 JPEG（微信回 JSON）算失败，并回落到旧码', async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 200, body: JSON_BODY }))
  const mp = createMpCodeFetcher({ serverUrl: 'wss://drc.provid.cc', fetchImpl })
  assert.equal(await mp.codeFor('042915'), null)
  assert.equal(mp.state(), 'shape')
})

test('501 = 这台中继没配小程序：不是故障，且不许每次重画都打一次外网', async () => {
  const { fetchImpl, urls } = fakeFetch(() => ({ status: 501 }))
  const mp = createMpCodeFetcher({ serverUrl: 'wss://drc.provid.cc', fetchImpl })
  assert.equal(await mp.codeFor('042915'), null)
  assert.equal(mp.state(), 'not-configured')
  assert.equal(await mp.codeFor('111111'), null, '换一枚码也不该立刻再打一次')
  assert.equal(urls.length, 1, '失败必须走负缓存')
})

test('连不上（抛）与地址非法都不外抛', async () => {
  const mp = createMpCodeFetcher({
    serverUrl: 'wss://drc.provid.cc',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  assert.equal(await mp.codeFor('042915'), null)
  assert.equal(mp.state(), 'unreachable')

  const bad = createMpCodeFetcher({ serverUrl: 'https://x', fetchImpl: async () => undefined })
  assert.equal(await bad.codeFor('042915'), null)
  assert.equal(bad.state(), 'bad-url')

  const noFetch = createMpCodeFetcher({ serverUrl: 'wss://drc.provid.cc' })
  assert.equal(await noFetch.codeFor('042915'), null)
})

test('请求 URL 上带着配对码（中继按它生成 scene）', async () => {
  const { fetchImpl, urls } = fakeFetch(() => ({ status: 200, body: JPEG }))
  const mp = createMpCodeFetcher({ serverUrl: 'wss://drc.provid.cc', fetchImpl })
  await mp.codeFor('042915')
  assert.equal(urls[0], 'https://drc.provid.cc/code?token=042915')
})
