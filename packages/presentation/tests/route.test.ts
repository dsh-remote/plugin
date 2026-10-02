/**
 * route.test — 那条只读路由的边界。
 *
 * 它是**唯一一个浏览器可达、由本插件注册的入口**，所以每一条拒绝都当成安全断言来写：
 *
 * - Host 不是环回 → 403（挡 DNS 重绑定：攻击者域名解析到 127.0.0.1 时 Host 头是攻击者的域名）；
 * - Origin 不是环回 → 403（挡跨站读：别的站点 fetch 我们的环回地址）；
 * - Origin 缺席 → **放行**（同源 GET 浏览器本来就可能不带，桌面宿主转发时还会主动删掉它）；
 * - 非 GET → 405；没有码 → 200 + `state:"none"`（**不是 404**：客户端要能区分
 *   "没在配对"和"路由不存在/被拦"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pairingHandler, PAIRING_ROUTE, registerPairingRoute, type PairingRouteOptions } from '../src/route.js'

interface Answer {
  status: number
  body: Record<string, unknown>
}

function request(input: { method?: string; url?: string; host?: string; origin?: string }): IncomingMessage {
  return {
    method: input.method ?? 'GET',
    url: input.url ?? '/',
    headers: {
      ...(input.host === undefined ? {} : { host: input.host }),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    },
  } as unknown as IncomingMessage
}

function response(): { res: ServerResponse; answer(): Answer } {
  let status = 0
  let payload = ''
  const res = {
    writeHead: (code: number) => {
      status = code
    },
    end: (chunk?: unknown) => {
      payload = typeof chunk === 'string' ? chunk : ''
    },
  } as unknown as ServerResponse
  return { res, answer: () => ({ status, body: JSON.parse(payload) as Record<string, unknown> }) }
}

async function ask(
  options: PairingRouteOptions,
  input: { method?: string; url?: string; host?: string; origin?: string },
): Promise<Answer> {
  const { res, answer } = response()
  await pairingHandler(options)(request(input), res)
  return answer()
}

const ready: PairingRouteOptions = {
  imageFile: '/Users/x/.dsh/sidebar-qr.png',
  snapshot: () => ({ state: 'ready', epoch: 'e1', expiresAt: 2_000_000 }),
}
const none: PairingRouteOptions = { imageFile: ready.imageFile, snapshot: () => ({ state: 'none' }) }

test('路由路径与包名对齐（客户端硬编码的是同一个字符串）', () => {
  assert.equal(PAIRING_ROUTE, '/plugins/dsh-remote-control-presentation/pairing')
})

test('Host 必须是环回：外部域名（DNS 重绑定）一律 403', async () => {
  for (const host of ['evil.example.com', 'evil.example.com:1234', '127.0.0.1.evil.com', '']) {
    const answer = await ask(ready, { host, url: '/?session=s1' })
    assert.equal(answer.status, 403, host)
  }
})

test('Origin 必须环回或缺席：跨站读 403，缺席放行', async () => {
  const cross = await ask(ready, { host: '127.0.0.1:1', origin: 'https://evil.example.com', url: '/?session=s1' })
  assert.equal(cross.status, 403)
  const absent = await ask(ready, { host: '127.0.0.1:1', url: '/?session=s1' })
  assert.equal(absent.status, 200)
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']) {
    assert.equal((await ask(ready, { host: 'localhost:5173', origin, url: '/?session=s1' })).status, 200, origin)
  }
})

test('非 GET → 405（先验方法，再验环回）', async () => {
  const answer = await ask(ready, { method: 'POST', host: '127.0.0.1', url: '/?session=s1' })
  assert.equal(answer.status, 405)
})

test('没有码 → 200 + none（不是 404）', async () => {
  assert.deepEqual(await ask(none, { host: '127.0.0.1', url: '/?session=s1' }), { status: 200, body: { state: 'none' } })
})

test('有码但没有可用 session → 400（宿主不猜会话，地址编不出来）', async () => {
  for (const url of ['/', '/?session=', '/?session=a%2Fb', '/?session=..%2Fx']) {
    const answer = await ask(ready, { host: '127.0.0.1', url })
    assert.equal(answer.status, 400, url)
    assert.equal(answer.body.state, 'none')
  }
})

test('有码 + 可用 session → 200，地址就是那张图的会话作用域地址', async () => {
  const answer = await ask(ready, { host: '127.0.0.1:1234', url: '/?session=sess-1' })
  assert.deepEqual(answer.body, {
    state: 'ready',
    epoch: 'e1',
    address: 'dsh-resource://file/session/sess-1//Users/x/.dsh/sidebar-qr.png',
    expiresAt: 2_000_000,
  })
})

test('snapshot 抛错 → 500，而不是把宿主带崩', async () => {
  const answer = await ask(
    {
      imageFile: ready.imageFile,
      snapshot: () => {
        throw new Error('boom')
      },
    },
    { host: '127.0.0.1', url: '/?session=s1' },
  )
  assert.equal(answer.status, 500)
})

test('registerPairingRoute 用 exact 路径注册，返回值直接注销', () => {
  const calls: Array<{ kind: string; path: string }> = []
  let disposed = 0
  const dispose = registerPairingRoute(
    {
      register: (route) => {
        calls.push({ kind: route.kind, path: route.path })
        return () => {
          disposed += 1
        }
      },
    },
    ready,
  )
  assert.deepEqual(calls, [{ kind: 'exact', path: PAIRING_ROUTE }])
  dispose()
  assert.equal(disposed, 1)
})
