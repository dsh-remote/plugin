/**
 * config-routes 的判据 —— 设置页「进阶」那一栏那条路由（2026-10-11）。
 *
 * ## 为什么它不是"顺手多加的一条路由"
 *
 * 它是**唯一一条既能读又能改配置**的浏览器可达路由，所以两条纪律都在它身上：
 *
 * 1. **GET 绝不给 token 真值**（只给脱敏形态与"有没有"）。这条路由是浏览器可达的，
 *    而 token 是主机与中继之间的共享密钥——`status.json` 那条同款纪律
 *    （"这个文件被设计成随时贴进工单"）在这里同样成立。
 * 2. **POST 走写路由那一档守卫**（`x-drc-pair` 自定义头 + 环回 Host + Origin 白名单）：
 *    它改的是"这台主机连哪台中继"，是一条能改行为的写路由。
 *
 * 另外两条是**语义**判据：校验失败时**不落盘**（400 要把哪一项错、错在哪带出去），
 * 以及"空串 = 删掉这一项"要真的传到 `saveConfig` 那一侧。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  configReadHandler,
  configRouteHandler,
  configWriteHandler,
  MAX_CONFIG_BODY_BYTES,
  PLUGIN_CONFIG_ROUTE,
  type ConfigRouteDeps,
  type EffectivePluginConfig,
} from '../src/pill/config-routes.js'
import { normalizeUserOverrides, type UserOverrides } from '../src/shell/user-config.js'

const HOST_TOKEN = 'REAL-HOST-TOKEN-MUST-NOT-APPEAR-IN-ANY-ANSWER'
const LOOPBACK = { host: '127.0.0.1:19387' }

/** 夹具：默认一台"没配过自定义、token 是认领来的"的机器。 */
function deps(over: Partial<ConfigRouteDeps> = {}): ConfigRouteDeps & { saved: UserOverrides[]; logs: string[] } {
  const saved: UserOverrides[] = []
  const logs: string[] = []
  const config = (): EffectivePluginConfig => ({
    serverUrl: 'wss://drc.provid.cc',
    defaultServerUrl: 'wss://drc.provid.cc',
    serverUrlSource: 'default',
    hostTokenSet: true,
    // ⚠️ 脱敏形态：与 `redact()` 同形（首 4 位 + 尾 2 位 + 长度）
    hostTokenShape: 'a1b2…f1(48)',
    hostTokenSource: 'claimed',
    userConfigFile: '/home/u/.dsh/dsh-remote-control/user-config.json',
  })
  return {
    config,
    saveConfig: (overrides) => {
      saved.push(overrides)
      return { ok: true }
    },
    log: (message) => {
      logs.push(message)
    },
    saved,
    logs,
    ...over,
  }
}

/** 假请求：只带这一层真正读的几个字段（method / headers / on）。 */
function request(method: string, headers: Record<string, string> = LOOPBACK, body?: string): IncomingMessage {
  const listeners = new Map<string, Array<(chunk?: unknown) => void>>()
  const req = {
    method,
    url: '/',
    headers,
    on: (event: string, handler: (chunk?: unknown) => void) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return req
    },
  } as unknown as IncomingMessage
  // body 要在 handler 注册完之后再喂（`readJsonBody` 是注册在前、收数据在后）。
  if (body !== undefined) {
    queueMicrotask(() => {
      for (const handler of listeners.get('data') ?? []) handler(Buffer.from(body))
      for (const handler of listeners.get('end') ?? []) handler()
    })
  }
  return req
}

function response(): {
  res: ServerResponse
  reply: () => { status: number; body: string; headers: Record<string, string> }
} {
  let status = 0
  let body = ''
  const headers: Record<string, string> = {}
  const res = {
    writeHead: (code: number, extra?: Record<string, string>) => {
      status = code
      Object.assign(headers, extra ?? {})
    },
    end: (chunk?: unknown) => {
      body = typeof chunk === 'string' ? chunk : ''
    },
  } as unknown as ServerResponse
  return { res, reply: () => ({ status, body, headers }) }
}

test('GET：回当前配置与"来源"，**绝不含 token 真值**（只有脱敏形态与有没有）', async () => {
  const d = deps()
  const { res, reply } = response()
  configReadHandler(d)(request('GET'), res)
  const got = reply()
  assert.equal(got.status, 200)
  const answer = JSON.parse(got.body) as Record<string, unknown>
  assert.equal(answer.serverUrl, 'wss://drc.provid.cc', '当前生效地址要回（设置页要把它填进输入框）')
  assert.equal(answer.defaultServerUrl, 'wss://drc.provid.cc', '默认值也回：前端不必自己抄一份常量')
  assert.equal(answer.hostTokenSet, true)
  assert.equal(answer.hostTokenSource, 'claimed')
  assert.equal(answer.serverUrlSource, 'default')
  assert.equal(typeof answer.userConfigFile, 'string', '改坏了去哪儿看，要能读到')
  assert.deepEqual(
    Object.keys(answer).sort(),
    [
      'defaultServerUrl',
      'hostTokenSet',
      'hostTokenShape',
      'hostTokenSource',
      'serverUrl',
      'serverUrlSource',
      'userConfigFile',
    ],
    `回答的字段集合要精确：多一个字段就可能多一条凭据外泄的路（实得 ${Object.keys(answer).join(',')}）`,
  )
  // 真值一个字都不许出现（形状里含 `…` 与长度，那是诊断要用的，不是凭据）
  assert.ok(!got.body.includes(HOST_TOKEN), 'GET 的回答里出现了 token 真值')
  assert.ok(!('hostToken' in answer), '连 `hostToken` 这个键名都不该出现：它会被读成"真值在这附近"')
})

test('GET：只读那一档守卫（Host 必须环回；跨站 Origin 拒；Origin 缺席放过）', () => {
  for (const [headers, why] of [
    [{ host: 'evil.example.com' }, '非环回 Host'],
    [{ ...LOOPBACK, origin: 'https://evil.example.com' }, '跨站 Origin'],
    [{ ...LOOPBACK, origin: 'null' }, 'null 来源'],
  ] as Array<[Record<string, string>, string]>) {
    const { res, reply } = response()
    configReadHandler(deps())(request('GET', headers), res)
    assert.equal(reply().status, 403, `${why} 必须被拒`)
  }
  const { res, reply } = response()
  configReadHandler(deps())(request('GET', { ...LOOPBACK, origin: 'dsh-app://app' }), res)
  assert.equal(reply().status, 200, '宿主自己的 scheme 算"自己"（与另外六条同一个白名单）')
})

test('POST：没有 `x-drc-pair` 头就 403，且**一个字节都没写**（跨站改中继地址的闸）', async () => {
  const d = deps()
  const { res, reply } = response()
  await configWriteHandler(d)(request('POST', LOOPBACK, JSON.stringify({ serverUrl: 'wss://evil.example.com' })), res)
  assert.equal(reply().status, 403)
  assert.deepEqual(JSON.parse(reply().body), { error: 'request-not-trusted', guard: 'pair-marker-missing' })
  assert.deepEqual(d.saved, [], '被守卫拒了**绝不许**落到 saveConfig —— 这条守卫是"能改行为"的唯一防线')
})

test('POST：带头的合法请求真的落盘，回答里带 `restartRequired`（不说用户会以为保存没反应）', async () => {
  const d = deps()
  const { res, reply } = response()
  await configWriteHandler(d)(
    request(
      'POST',
      { ...LOOPBACK, 'x-drc-pair': '1' },
      JSON.stringify({ serverUrl: 'wss://self.example.com', hostToken: HOST_TOKEN }),
    ),
    res,
  )
  const got = reply()
  assert.equal(got.status, 200, got.body)
  assert.deepEqual(d.saved, [{ serverUrl: 'wss://self.example.com', hostToken: HOST_TOKEN }])
  const answer = JSON.parse(got.body) as Record<string, unknown>
  assert.equal(answer.state, 'ok')
  assert.equal(answer.restartRequired, true, '中继地址与 token 是建连接时读一次的：必须说出来（否则"保存了但没变"）')
  assert.ok(answer.config, '回答要带上刷新后的配置，前端不用再多打一次 GET')
  assert.deepEqual(d.logs, ['设置页写入自定义配置'], '留一行痕：这条路由改的是"连哪台中继"')
})

test('POST：空串 = 删掉这一项（表单的"恢复默认"就是发两个空串）', async () => {
  const d = deps()
  const { res, reply } = response()
  await configWriteHandler(d)(
    request('POST', { ...LOOPBACK, 'x-drc-pair': '1' }, JSON.stringify({ serverUrl: '', hostToken: '' })),
    res,
  )
  assert.equal(reply().status, 200)
  assert.deepEqual(d.saved, [{ serverUrl: undefined, hostToken: undefined }], '归一后是"这两项都删掉"，不是空字符串')
})

test('POST：坏地址 / 坏 JSON / 超长 body 都回 400，且**不落盘**', async () => {
  const cases: Array<[string, string | undefined, string]> = [
    ['坏地址', JSON.stringify({ serverUrl: 'http://x' }), 'serverUrl'],
    ['地址不是字符串', JSON.stringify({ serverUrl: 42 }), 'serverUrl'],
    ['不是 JSON', '{nope', 'body'],
    // ⚠️ 数组也是 `typeof 'object'`：不显式挡掉会**归一成"一项都没提交"**然后回 200
    // 「已保存」—— 一条假回答（中继那条认领接口同一个位置就是这么挡的）。
    ['数组', '[1,2,3]', 'body'],
  ]
  for (const [why, body, field] of cases) {
    const d = deps()
    const { res, reply } = response()
    await configWriteHandler(d)(request('POST', { ...LOOPBACK, 'x-drc-pair': '1' }, body), res)
    const got = reply()
    assert.equal(got.status, 400, `${why} 应当 400（实得 ${got.status}）`)
    const answer = JSON.parse(got.body) as Record<string, unknown>
    assert.equal(answer.error, 'invalid')
    assert.equal(answer.field, field, `${why}：要指出是哪一项错（实得 ${String(answer.field)}）`)
    assert.deepEqual(d.saved, [], `${why} 不许落盘`)
  }

  // 超限 body：`readJsonBody` 直接放弃 ⇒ 当成"不是 JSON" 回 400（不是把整段读进内存）
  const huge = `{"serverUrl":"${'x'.repeat(MAX_CONFIG_BODY_BYTES + 10)}"}`
  const d = deps()
  const { res, reply } = response()
  await configWriteHandler(d)(request('POST', { ...LOOPBACK, 'x-drc-pair': '1' }, huge), res)
  assert.equal(reply().status, 400, '超过上限的 body 不许被读进来')
  assert.deepEqual(d.saved, [])
})

test('POST：saveConfig 说不行就回 400 并把它给的理由带出去（不让界面显示"已保存"）', async () => {
  const d = deps({ saveConfig: () => ({ ok: false, field: 'file', error: 'cannot write the config file' }) })
  const { res, reply } = response()
  await configWriteHandler(d)(
    request('POST', { ...LOOPBACK, 'x-drc-pair': '1' }, JSON.stringify({ serverUrl: 'wss://x.example.com' })),
    res,
  )
  const got = reply()
  assert.equal(got.status, 400, '写盘失败必须回 400：回 200 就是界面说"已保存"而盘上什么都没有')
  const answer = JSON.parse(got.body) as Record<string, unknown>
  assert.equal(answer.field, 'file')
  assert.equal(answer.detail, 'cannot write the config file')
})

test('方法分发：GET/HEAD 走读、POST 走写、其余 405；HEAD 不读 file body', async () => {
  const d = deps()
  const handler = configRouteHandler(d)
  const put = response()
  await Promise.resolve(handler(request('PUT'), put.res))
  assert.equal(put.reply().status, 405)

  const head = response()
  await Promise.resolve(handler(request('HEAD'), head.res))
  assert.equal(head.reply().status, 200, 'HEAD 与 GET 同一档：宿主探活会打它')
})

test('路由常量与注册表那条一致（拼错一个字符 = "保存点了没反应而日志全绿"）', () => {
  assert.equal(PLUGIN_CONFIG_ROUTE, '/plugins/dsh-remote-control/config')
  // 归一函数与路由用的是**同一份**校验：路由里那份不许另写一套（两处各写一份必然漂移）
  assert.equal(normalizeUserOverrides({ serverUrl: 'ws://127.0.0.1:8787' }).ok, true)
})
