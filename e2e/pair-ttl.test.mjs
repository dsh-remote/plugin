/**
 * pair-ttl.test — 本地 TTL 与服务端 TTL 分叉时，发码路由不许回"半条码"。
 *
 * 线上形状（2026-10-04 用户实测）：中继发码时回的 ttlMs 是 **180s**，而插件本地
 * 默认 120s（这台机器的 env 里写的 90s 根本没生效）。中继的 pair-ready 会用服务端
 * TTL 改写 slot 的过期时刻，但 `active.pairing` 里那份出码时的旧值没人更新——
 * 于是本地过期之后、中继还有效的那一整段里，`resolveFor` 认这张码（slot 还活着），
 * 发码路由却拿旧值算 expiresInMs → 0，pill 上就是"配对请求没成功：发码回答里的码不完整"，
 * 而且按一次撞一次。用户在手机断开重连后点"刷新"撞见的正是这个。
 *
 * 修法两道的这一文件钉第二道（第一道在 currentPairing 改读 slot 的权威过期时刻）：
 * 本地过期、中继还有效时，/pairing/new 必须仍回一条**完整的码**。
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { bootHost, shutdown, startRelay } from './run.mjs'

const NEW = '/plugins/dsh-remote-control/pairing/new'
const marker = { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'x-drc-pair': '1' }

describe('配对码 TTL 分叉：本地过期、中继还有效（180s > 本地）时仍要完整', () => {
  const workDir = path.join(os.tmpdir(), `drc-e2e-pairttl-${process.pid}`)
  let relay = null
  let host = null

  before(async () => {
    mkdirSync(workDir, { recursive: true })
    relay = await startRelay({ env: { DRC_SWEEP_MS: '1000', DRC_LOG_LEVEL: 'warn' }, label: '本地中继（pair-ttl）' })
    // 本地 TTL 给 1 秒，中继默认 180s——分叉方向与线上一致（服务端更宽）
    host = await bootHost({ relayUrl: relay.url, hostId: 'e2e_pairttl_host', statusDir: workDir, pairTtlMs: 1_000 })
  })

  after(async () => {
    const { relayExit } = await shutdown({ host, relay })
    rmSync(workDir, { recursive: true, force: true })
    assert.equal(relayExit.code, 0, `中继必须优雅退出 0，实际 ${JSON.stringify(relayExit)}`)
  })

  test('本地过期之后点刷新：回答仍是完整的码（expiresInMs>0、token 非空），不是"码不完整"', async () => {
    const first = await host.callPill(NEW, { method: 'POST', headers: marker })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.state, 'ready')
    assert.ok(first.body.expiresInMs > 0 && first.body.expiresInMs <= 1_000, `首帧该在本地 TTL 内：${JSON.stringify(first.body)}`)
    assert.ok(String(first.body.token).length >= 4)

    // 等 pair-ready 把 slot 的过期时刻按服务端 TTL（180s）改写完，再越过本地 TTL
    await delay(1_500)
    const second = await host.callPill(NEW, { method: 'POST', headers: marker })
    assert.equal(second.status, 200)
    assert.equal(second.body.state, 'ready', `本地过期、中继还有效时不该 unavailable：${JSON.stringify(second.body)}`)
    assert.ok(
      typeof second.body.token === 'string' && second.body.token !== '' && second.body.expiresInMs > 0,
      `修复前这里是 expiresInMs=0：pill 显示"发码回答里的码不完整"。实际 ${JSON.stringify(second.body)}`,
    )
    // 而且给的是**同一张**码（幂等）：不该因为本地过期就另烧一张
    assert.equal(second.body.token, first.body.token, '服务端还说它有效，本地不许换码')
  })
})
