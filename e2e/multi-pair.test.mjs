/**
 * multi-pair.test — 多张配对码并存时，必须按**手机实际用的那张码**取 PSK。
 *
 * 它守护的是旧实现的一起线上事故（取证 docs/legacy-spec/relay-and-wireformat.md §2.3 第 2 条、
 * docs/legacy-spec/testing-and-tooling.md §3）：主机同时挂着两张码（这里由两次 createPairing() 造出来，
 * 真机上就是「窗口里那张还没用完」与「又点了一下配对」）
 * 时，旧实现把待配对 PSK 存成**单槽**，于是主机用"最新那张"的密钥派生会话钥匙，
 * 而手机用的是"它扫的那张"——握手全绿、`paired` 也到了，但**每一帧都解不开**，
 * 手机表现为"会话列表永远空白 + 一句莫名的无法解密"。
 * 新实现两侧都必须是 `Map<token,{psk,expiresAt}>`，中继的 `peer-joined` 必须回传 `pairingToken`
 * （dsh-remote-control/packages/plugin/src/core/keys.ts:98-148 与 transport/relay.ts:194-210）。
 *
 * 三个真实里本文件与其它本地用例同构：真中继（dsh-remote-server 产物）+ 真插件运行时
 * （`apply()` 真入口）+ **真 `dsh-remote-mp/miniprogram/core/client.js`**；只有内核面是 `platform/mock-kernel.ts`
 * （所以会话 id 一律 `ses_mock*`，这不证明真内核）。
 *
 * 独立端口、独立 hostId、`DRC_LOG_LEVEL=warn`：这个文件必须能在别的用例旁边并行跑。
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { MOCK_SESSION_ID, bootHost, controlFrames, newPhone, pairPhone, shutdown, startRelay, tappedFrames } from './run.mjs'
import { until } from './mp-sim.mjs'

describe('多张配对码并存：按所用码取 PSK（旧事故回归）', () => {
  const workDir = path.join(os.tmpdir(), `drc-e2e-multipair-${process.pid}`)
  let relay = null
  let host = null
  let phone = null
  let earlier = null
  let later = null

  before(async () => {
    mkdirSync(workDir, { recursive: true })
    relay = await startRelay({ env: { DRC_SWEEP_MS: '1000', DRC_LOG_LEVEL: 'warn' }, label: '本地中继（multi-pair）' })
    host = await bootHost({ relayUrl: relay.url, hostId: 'e2e_multipair_host', statusDir: workDir, pairTtlMs: 60_000 })
    phone = newPhone('multi-pair 手机')
  })

  after(async () => {
    const { relayExit } = await shutdown({ phone, host, relay })
    rmSync(workDir, { recursive: true, force: true })
    assert.equal(relayExit.code, 0, `中继必须优雅退出，实际 code=${relayExit.code}`)
  })

  test('1. 先发布两张码：它们必须互不相同，且两张都各自拿到服务端权威 ttlMs', async () => {
    earlier = host.createPairing()
    await delay(400)
    later = host.createPairing()
    await delay(400)
    assert.notEqual(earlier.token, later.token, `两张码不能相同（6 位空间碰撞也要重来）：${earlier.token}`)
    assert.notEqual(earlier.psk, later.psk, '每张码必须有自己的一份 PSK')
    const ready = controlFrames('host', 'received', ['pair-ready'])
    for (const token of [earlier.token, later.token]) {
      const frame = ready.find((f) => f.pairingToken === token)
      assert.ok(frame, `这张码 ${token} 没等到 pair-ready：主机不会改写它的本地过期时间`)
      assert.ok(Number.isInteger(frame.ttlMs) && frame.ttlMs > 0, `pair-ready.ttlMs 必须是正整数，收到 ${JSON.stringify(frame.ttlMs)}`)
    }
    assert.equal(ready.length >= 2, true, `只看到 ${ready.length} 条 pair-ready——两张码并存没成立，这条回归就是空的`)
    assert.equal(host.state().pendingPairs >= 2, true, `主机侧只挂着 ${host.state().pendingPairs} 张待配对码：单槽实现会在这里露形`)
  })

  test('2. 用**较早那张**配对：paired 与 peer-joined 都必须指向它', async () => {
    const { pairing } = await pairPhone(host, phone, { pairing: earlier, expectedRelayUrl: relay.url })
    assert.equal(pairing.token, earlier.token, '本用例必须用较早那张码')
    const claim = controlFrames('phone', 'sent', ['pair-begin-client']).pop()
    assert.equal(claim.pairingToken, earlier.token)
    const paired = controlFrames('phone', 'received', ['paired']).pop()
    assert.match(paired.sessionId, /^c_[0-9a-f]{12}$/, `paired.sessionId 形状不对：${paired.sessionId}`)
    const joined = await until(
      () => controlFrames('host', 'received', ['peer-joined']).find((f) => f.sessionId === paired.sessionId) ?? null,
      { timeoutMs: 8000, trail: phone.trail, label: '主机收到这条会话的 peer-joined' },
    )
    assert.equal(joined.pairingToken, earlier.token, 'peer-joined 必须回传手机实际使用的那张码')
    assert.notEqual(joined.pairingToken, later.token, '不能把"最新那张"当成依据')
  })

  test('3. 主机发来的每一帧都能用较早那张码的 PSK 解开；用最新那张的密钥必须全部失败', async () => {
    const convId = phone.convId
    const { codec } = phone.mp
    const keyOfEarlier = codec.derivePskKey(earlier.psk, 'h2c', convId)
    const keyOfLater = codec.derivePskKey(later.psk, 'h2c', convId)
    assert.notEqual(Buffer.from(keyOfEarlier).toString('hex'), Buffer.from(keyOfLater).toString('hex'), '两把派生密钥必须不同——否则这条回归是空的')

    // 让主机多推几类帧：join 时的列表 + 防休眠、list 回执、prompt→审批→工具→delta→done。
    phone.client.listSessions()
    await delay(200)
    const permissionBefore = phone.count('ev.permission_request')
    phone.client.sendPrompt(MOCK_SESSION_ID, '多码并存也要能整条跑通')
    const request = await phone.waitForPayload('ev.permission_request', '审批卡到达', { after: permissionBefore, timeoutMs: 12_000 })
    phone.client.resolvePermission(request.sessionId, request.requestId, 'approve')
    await phone.waitForPayload('ev.message_delta', '回合收尾（done:true）', { where: (p) => p.done === true, timeoutMs: 12_000 })
    await delay(200)

    const down = tappedFrames('phone', 'received')
      .map((f) => ({ raw: f.raw, frame: JSON.parse(f.raw) }))
      .filter((entry) => entry.frame.t === 'enc' || entry.frame.t === 'enc-batch')
    assert.ok(down.length >= 8, `主机一共只发来 ${down.length} 帧密文，样本太少不足以证明"每一帧"`)
    const records = []
    for (const entry of down) {
      if (entry.frame.t === 'enc') {
        assert.equal(entry.frame.sessionId, convId, '下行帧外层 sessionId 必须逐字不变（红线 4）')
        records.push(entry.frame)
        continue
      }
      assert.ok(Array.isArray(entry.frame.items), 'enc-batch 的 items 必须是数组（否则手机整批丢弃）')
      for (const item of entry.frame.items) records.push({ sessionId: entry.frame.sessionId, ciphertext: item.ciphertext })
    }
    const opened = []
    for (const record of records) {
      const payload = codec.open(keyOfEarlier, record)
      assert.ok(payload, `主机发来的一帧用"所用码 A 的 PSK"解不开：${record.ciphertext.slice(0, 32)}…（这正是旧事故的形状）`)
      assert.equal(typeof payload.t, 'string')
      opened.push(payload.t)
    }
    assert.ok(opened.length >= 8, `只解开 ${opened.length} 帧，下界 8`)
    assert.ok(opened.includes('ev.session_changed'), 'join 时推的会话列表帧也必须在"每一帧"里')
    assert.ok(opened.includes('ev.keep_awake_state'), 'join 时推的防休眠状态帧也必须在"每一帧"里')

    // 反证：用另一张码的密钥必须一帧都解不开。解得开就说明两张码共用了一个 PSK。
    const wrongOpens = records.filter((record) => codec.open(keyOfLater, record) !== null)
    assert.deepEqual(wrongOpens.map((r) => r.ciphertext.slice(0, 16)), [], '用"最新那张码"的密钥居然解开了帧——两张码共用了 PSK')

    // 手机侧的用户可见症状必须为 0：一次解密失败会给提示，两次就永久掉配对（§3.2）。
    const decryptErrors = phone.events.filter((e) => e.kind === 'error' && String(e.message).includes('无法解密'))
    assert.deepEqual(decryptErrors.map((e) => e.message), [], `手机报了 ${decryptErrors.length} 次解密失败`)
    assert.equal(phone.client.status, 'online', '手机必须还停在 online')
  })

  test('4. 列表与回执都要在（F8），且会话 id 与载荷 sessionId 同值（F3）', async () => {
    const cmdId = phone.client.newCmdId()
    phone.client.sendCmd({ t: 'cmd.list_sessions', cmdId })
    const result = await phone.waitForPayload('ev.result', 'list_sessions 的回执', { where: (p) => p.cmdId === cmdId, timeoutMs: 10_000 })
    assert.equal(result.ok, true, `回执 ok:false：${result.message ?? ''}`)
    assert.ok(Array.isArray(result.data?.sessions), 'ev.result.data.sessions 必须是数组（虽然手机不读它）')
    const changed = await phone.waitForPayload('ev.session_changed', '列表快照', {
      where: (p) => Array.isArray(p.sessions) && p.sessions.length > 0,
      timeoutMs: 10_000,
    })
    assert.equal(changed.sessions, phone.client.sessions)
    const uplink = phone.sent.filter((s) => s.frame.t === 'enc').pop()
    assert.match(uplink.frame.sessionId, /^c_/, '帧外层必须是配对通道 id')
    assert.notEqual(uplink.frame.sessionId, changed.sessions[0].id)
    await until(() => phone.client.status === 'online', { timeoutMs: 3000, trail: phone.trail, label: '手机仍在 online（多码并存没把配对打掉）' })
  })
})
