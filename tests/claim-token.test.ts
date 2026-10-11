/**
 * claim-token 的判据 —— 「装完就能用」那一条的插件侧（2026-10-11）。
 *
 * ## 这一层要守什么
 *
 * 认领这件事的风险不在"能不能拿到 token"，而在**拿到之后怎么处理**：
 *
 * 1. **定长比较的陷阱**（中继 `server.ts` 那句注释）：token 是 48 位十六进制，
 *    而 `tokenMatches` 是定长比较 —— 长度变了**不报错**，只会让已装机的主机静默连不上。
 *    ⇒ 收到形状不对的东西必须**当失败**，不许原样落盘。
 * 2. **不能把凭据送给另一台中继**：盘上那枚 token 属于某一台具体的中继，
 *    换地址之后拿它去连只有两种结果（被拒 / 把旧凭据送给陌生人）。
 * 3. **落盘必须走 `SecureFilePort`**（0600 + 原子写）：token 是凭据，
 *    这条断言由权限位与"半写文件读不出来"两条一起钉住。
 * 4. **永远不抛**：这一条挂在 `apply()` 的启动路径上，抛出去等于插件不加载。
 *
 * 全程**不联网**：`fetchImpl` 是注入口（真发请求的判据在 e2e 里，见 `e2e/live-e2e.mjs` 那条链）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CLAIMED_TOKEN_PATTERN,
  claimHostToken,
  claimUrlFor,
  readStoredHostToken,
  resolveHostTokenFile,
  writeStoredHostToken,
  type FetchLike,
} from '../src/shell/claim-token.js'
import { skipUnlessPosix } from './test-platform.js'

const POSIX_ONLY = skipUnlessPosix()

/** 一枚形状合法的 token（48 位小写十六进制，与中继 `randomBytes(24).toString('hex')` 同形）。 */
const GOOD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef01'
const RELAY = 'wss://drc.provid.cc'

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'drc-claim-'))
}
/** 一个只记账、不联网的 fetch。 */
function fakeFetch(answer: { status?: number; ok?: boolean; body?: unknown; throw?: Error }): {
  fetch: FetchLike
  calls: Array<{ url: string; method?: string }>
} {
  const calls: Array<{ url: string; method?: string }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method })
    if (answer.throw) throw answer.throw
    const status = answer.status ?? 200
    return {
      ok: answer.ok ?? status === 200,
      status,
      json: async () => answer.body,
    }
  }
  return { fetch: fetchImpl, calls }
}

test('认领地址：wss→https、ws→http，而且**整段路径被替换**（不是拼在后面）', () => {
  // ⚠️ "拼在后面"是本文件最容易犯的错：配对 URI 里的地址可能带路径（`wss://x/y`），
  // 拼出来是 `/y/api/claim-token` —— 中继上不存在那条路由，症状是"认领一直 404"，
  // 看着像中继没部署新版本。
  assert.equal(claimUrlFor('wss://drc.provid.cc'), 'https://drc.provid.cc/api/claim-token')
  assert.equal(claimUrlFor('ws://127.0.0.1:8787'), 'http://127.0.0.1:8787/api/claim-token')
  assert.equal(
    claimUrlFor('wss://relay.example.com:8443/relay?x=1#f'),
    'https://relay.example.com:8443/api/claim-token',
  )
  // 非 ws(s) 的地址没有认领口（配置校验那边会另报 error，这里只回"认不了"）
  for (const bad of ['https://drc.provid.cc', 'drc.provid.cc', '']) {
    assert.equal(claimUrlFor(bad), undefined, `${JSON.stringify(bad)} 不该被当成可认领的地址`)
  }
})

test('认领成功：POST 到那条地址，拿回一枚形状合法的 token', async () => {
  const { fetch, calls } = fakeFetch({ body: { token: GOOD, rotatedAt: '2026-10-11T00:00:00.000Z' } })
  const outcome = await claimHostToken({ serverUrl: RELAY, fetchImpl: fetch })
  assert.deepEqual(outcome, { ok: true, token: GOOD })
  assert.equal(calls.length, 1, '只发一次')
  assert.equal(calls[0]!.url, 'https://drc.provid.cc/api/claim-token')
  assert.equal(calls[0]!.method, 'POST', '**必须是 POST**：GET 在浏览器地址栏一发就能把 token 领走（中继侧那道闸）')
})

test('⚠️ 定长比较的陷阱：形状不对（长度/字符集）一律当失败，**绝不落盘**', async () => {
  // 中继侧 `tokenMatches` 是定长比较：长度变了不会报错，只会让所有已装机的主机**静默**连不上
  // （`server.ts` 的注释）。所以这里收到怪东西必须当失败——把一次网络故障变成一次
  // "要人去翻文件"的静默故障是最坏的结果。
  const bad = [
    'a'.repeat(47), // 少一位
    'a'.repeat(49), // 多一位
    'A'.repeat(48), // 大写：中继产出的是小写十六进制
    'z'.repeat(48), // 不是十六进制
    '',
    undefined,
    null,
    12345,
  ]
  for (const token of bad) {
    const { fetch } = fakeFetch({ body: { token } })
    const outcome = await claimHostToken({ serverUrl: RELAY, fetchImpl: fetch })
    assert.equal(outcome.ok, false, `${JSON.stringify(token)} 不该被接受`)
    assert.equal(outcome.ok === false && outcome.reason, 'shape')
  }
  // 反证：形状对的那一枚必须被接受（否则上面每一条都是空断言）
  const { fetch } = fakeFetch({ body: { token: GOOD } })
  assert.equal((await claimHostToken({ serverUrl: RELAY, fetchImpl: fetch })).ok, true)
  assert.equal(CLAIMED_TOKEN_PATTERN.test(GOOD), true, '常量本身要认得这一枚')
})

test('失败的四档各说各话：地址不对 / 没有 fetch / 网络不通 / HTTP 非 200 —— 都不抛', async () => {
  // 地址不是 ws(s)：配置校验那边也会报 error，这里只回"认不了"（不抛）。
  const badUrl = await claimHostToken({ serverUrl: 'https://drc.provid.cc', fetchImpl: fakeFetch({}).fetch })
  assert.equal(badUrl.ok === false && badUrl.reason, 'bad-url')

  const unreachable = await claimHostToken({
    serverUrl: RELAY,
    fetchImpl: fakeFetch({ throw: new Error('ECONNREFUSED') }).fetch,
  })
  assert.equal(unreachable.ok === false && unreachable.reason, 'unreachable')

  // 429 = 限频（正常运维信号）、404 = 老中继（没这条接口）、503 = 停机中：都归"这次没领到"
  for (const status of [429, 404, 503]) {
    const outcome = await claimHostToken({ serverUrl: RELAY, fetchImpl: fakeFetch({ status, ok: false }).fetch })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'http')
    assert.equal(outcome.ok === false && outcome.status, status, '状态码要带出来：排错时"哪一档"就靠它')
  }

  /**
   * 老宿主（老 Electron 主进程）全局里没有 `fetch` —— 这条路要判成"认不了"而不是抛。
   * ⚠️ 必须真删掉全局的那个：不删的话 `claimHostToken` 会落回它，这条判据就变成
   * **一次真的网络请求**（而且它会在 CI 上打公网）。
   */
  const saved = globalThis.fetch
  try {
    delete (globalThis as { fetch?: unknown }).fetch
    const noFetch = await claimHostToken({ serverUrl: RELAY })
    assert.equal(noFetch.ok === false && noFetch.reason, 'no-fetch')
  } finally {
    globalThis.fetch = saved
  }
})

test('落盘：写出来的文件权限是 0600，内容能原样读回来', POSIX_ONLY, () => {
  const dir = tempDir()
  try {
    const file = resolveHostTokenFile(path.join(dir, 'status.json'))
    assert.equal(file, path.join(dir, 'host-token.json'), '落点必须是 status.json 同目录')
    assert.equal(writeStoredHostToken(file, { token: GOOD, serverUrl: RELAY, source: 'claimed', now: 1 }), true)
    assert.equal(statSync(file).mode & 0o777, 0o600, 'token 是凭据：权限位必须是 0600')
    assert.equal(readStoredHostToken(file, RELAY), GOOD)
    // 排错面：source / serverUrl 要真的在文件里（不是靠文件名暗示）
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(raw.source, 'claimed')
    assert.equal(raw.serverUrl, RELAY)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('读盘的四档"不算数"：换中继 / 形状不对 / 坏了 / 没有 —— 一律 undefined，绝不抛', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'host-token.json')

    // 没有这个文件（第一次装）是最常见的一档
    assert.equal(readStoredHostToken(file, RELAY), undefined)

    // 换中继：那枚 token 属于上一台，拿去连只有"被拒"或"把旧凭据送给陌生人"两种结果
    writeStoredHostToken(file, { token: GOOD, serverUrl: RELAY, source: 'claimed', now: 1 })
    assert.equal(readStoredHostToken(file, 'wss://other.example.com'), undefined, 'serverUrl 不同就不算数')
    assert.equal(readStoredHostToken(file, RELAY), GOOD, '反证：地址相同的那一枚要认')

    // 形状不对（手改坏了 / 旧版本写的别的长度）
    writeFileSync(
      file,
      JSON.stringify({ version: 1, token: 'A'.repeat(48), serverUrl: RELAY, source: 'claimed', savedAt: 1 }),
    )
    assert.equal(readStoredHostToken(file, RELAY), undefined, '长度对但字符集不对同样不许用')

    // 坏 JSON
    writeFileSync(file, '{ not json')
    assert.equal(readStoredHostToken(file, RELAY), undefined)

    // 形状不认识（版本升级）
    writeFileSync(file, JSON.stringify({ hello: 'world' }))
    assert.equal(readStoredHostToken(file, RELAY), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写盘失败只返回 false（目录不可写 / 磁盘满）：本次运行仍能连上，下次重启再认领一次', () => {
  // 用一个"父路径是文件"的位置造必失败：`mkdirSync` 会 ENOTDIR。
  const dir = tempDir()
  try {
    const blocker = path.join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const file = path.join(blocker, 'host-token.json')
    assert.equal(writeStoredHostToken(file, { token: GOOD, serverUrl: RELAY, source: 'claimed', now: 1 }), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
