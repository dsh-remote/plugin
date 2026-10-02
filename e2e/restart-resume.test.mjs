/**
 * restart-resume.test — 中继/主机重启后的**续用取证**（本次重写新加的一条层）。
 *
 * 为什么必须单独有这一层：旧实现只在文档里写"中继重启后客户端会提示重新配对"，
 * 从来没有一条真实链路测试断言它（取证 docs/legacy-spec/testing-and-tooling.md §8.4），
 * 而 D3/D6 改了会话生命周期之后，"重启"这一族故障出现了三种**表现完全不同**的分支：
 *
 * (a) **只有客户端断开**（手机切后台、杀进程、网络抖一下）：会话必须留着，
 *     同一个 convId 回来就能继续用（D3，本次的产品级修复——旧实现是"回前台就得重新扫码"）。
 * (b) **中继被 SIGTERM 重启**：路由表全空（内存态、有意不持久化），客户端拿旧 convId 发帧
 *     必须撞上 `error{code:'unknown_session'}`，手机才会中文提示"会话已失效，请重新配对"
 *     （取证 mp-client-contract §3.3；只断连接的表现是"重连…+空列表"死循环）。
 * (c) **主机侧重启**（generation 变化 / `resync` 声明自己还持有哪些密钥）：
 *     D3+D6 合起来会造出一个静默黑洞——中继留着会话、主机没了密钥，手机把密文发给
 *     一个听不见的对端，`unknown_session` 永远不会发生（复核 R1，docs/DESIGN-REVIEW.md:508）。
 *     本条不要求是哪一种出口，只要求**必须观察到 `unknown_session` 或 `peer-left` 之一**，
 *     也就是"不许静默"。
 *
 * 三个真实：真中继（apps/server 产物，(b) 里真的 SIGTERM 再起重启）、真插件运行时
 * （`apply()` 真入口，(c) 里真的停机再重挂）、真 `mp/core/client.js`；
 * **内核面是 `platform/mock-kernel.ts`**（会话 id 一律 `ses_mock*`，不证明真内核）。
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import {
  MOCK_SESSION_ID,
  bootHost,
  controlFrames,
  installPhoneRig,
  newPhone,
  pairPhone,
  pickFreePort,
  shutdown,
  startRelay,
  tap,
  untilAsync,
} from './run.mjs'
import { until } from './mp-sim.mjs'

const workDir = path.join(os.tmpdir(), `drc-e2e-restart-${process.pid}`)
mkdirSync(workDir, { recursive: true })

/**
 * 每个用例一套独立装置（中继 + 主机 + 手机），跑完就地拆干净。
 *
 * `installPhoneRig()` 的 storage 是**进程级**的（`wx` shim 只能装一次），
 * 所以新建手机前必须把 storage 与 recorder 清空——否则上一个用例留下的配对
 * 会让这次的 `hydrate()` 直接"恢复"到旧 convId 上，测试之间互相污染。
 */
async function boot({ port, hostId, relayEnv = {} } = {}) {
  const rig = installPhoneRig()
  rig.shim.storage.clear()
  rig.recorder.frames.length = 0
  const relay = await startRelay({ port, env: { DRC_SWEEP_MS: '1000', ...relayEnv }, label: `本地中继（${hostId}）` })
  const host = await bootHost({ relayUrl: relay.url, hostId, statusDir: workDir, pairTtlMs: 60_000, approvalTimeoutSec: 20 })
  const phone = newPhone(`手机（${hostId}）`)
  return {
    relay,
    host,
    phone,
    rig,
    async pair() {
      await pairPhone(host, phone, { expectedRelayUrl: relay.url })
      return phone.convId
    },
    async teardown() {
      const { relayExit } = await shutdown({ phone, host, relay })
      return relayExit
    },
  }
}

after(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('重启与续用取证（D3 / unknown_session / 复核 R1）', () => {
  test('(a) 客户端断连重连：同一条 convId 仍然可用（D3，会话不因手机下线而消失）', async () => {
    const scene = await boot({ hostId: 'e2e_resume_client' })
    try {
      const convId = await scene.pair()
      const listBefore = scene.phone.count('ev.session_changed')
      const pairedFrames = controlFrames('phone', 'received', ['paired'])
      assert.equal(pairedFrames.length, 1, '只该有一次 paired；重挂不许走重新配对')
      assert.match(convId, /^c_/)
      await untilAsync(() => scene.relay.health().then((h) => h.conversations === 1 && h.clients === 1), {
        label: '中继侧 1 条会话 1 个客户端',
        trail: scene.phone.trail,
      })

      // 手机切后台：真实客户端的 disconnect() 会关 socket 并停止重连（socket.js:114-127）。
      scene.phone.client.disconnect()
      await untilAsync(() => scene.relay.health().then((h) => h.clients === 0), {
        label: '中继看到客户端离开',
        trail: scene.phone.trail,
      })
      const healthWhileGone = await scene.relay.health()
      assert.equal(healthWhileGone.conversations, 1, `D3：客户端断开后中继必须**留着**会话（实际 conversations=${healthWhileGone.conversations}）`)
      await untilAsync(() => Promise.resolve(scene.host.state().conversations === 1), {
        label: '主机侧也留着这条会话与密钥（收到 peer-left 但不丢配对）',
        trail: scene.phone.trail,
        timeoutMs: 5000,
      })
      const leftOnHost = await untilAsync(
        async () => {
          const frames = controlFrames('host', 'received', ['peer-left'])
          return frames.length >= 1 ? frames : null
        },
        { label: '主机被告知客户端离开', trail: scene.phone.trail, timeoutMs: 8000 },
      )
      assert.equal(leftOnHost[leftOnHost.length - 1].sessionId, convId)

      // 手机回前台：不带 token 的 connect() 走"恢复"路径（hello-ok → 已配对 → 直接 list_sessions）。
      scene.phone.client.connect()
      await scene.phone.waitForStatus('online', '重连后恢复在线', 20_000)
      assert.equal(scene.phone.convId, convId, '重连必须仍然用同一条 convId（重新配对就是 D3 要消灭的体验）')
      const changed = await scene.phone.waitForPayload('ev.session_changed', '重连后列表重新推过来', {
        after: listBefore,
        where: (p) => Array.isArray(p.sessions) && p.sessions.length > 0,
        timeoutMs: 15_000,
      })
      assertSessionShapeIsFine(changed)
      assert.equal(controlFrames('phone', 'received', ['paired']).length, 1, '恢复路径绝不能重新走一次配对')
      const decryptErrors = scene.phone.events.filter((e) => e.kind === 'error' && String(e.message).includes('无法解密'))
      assert.deepEqual(decryptErrors.map((e) => e.message), [], '续用期间一帧都不许解不开')
      // 续用之后还能正常发指令：会话不是"留着壳子"。
      const deltaBefore = scene.phone.count('ev.message_delta')
      const permissionBefore = scene.phone.count('ev.permission_request')
      scene.phone.client.sendPrompt(MOCK_SESSION_ID, '重连之后这条也要能跑')
      const request = await scene.phone.waitForPayload('ev.permission_request', '重连后的审批卡', { after: permissionBefore, timeoutMs: 12_000 })
      scene.phone.client.resolvePermission(request.sessionId, request.requestId, 'approve')
      await scene.phone.waitForPayload('ev.message_delta', '重连后的回合收尾（done:true）', {
        after: deltaBefore,
        where: (p) => p.done === true,
        timeoutMs: 12_000,
      })
      assert.equal(scene.phone.convId, convId)
    } finally {
      const exit = await scene.teardown()
      assert.equal(exit.code, 0, `中继 SIGTERM 必须退出 0，实际 ${JSON.stringify(exit)}`)
    }
  })

  test('(b) 中继 SIGTERM 重启：旧 convId 必须撞上 error{unknown_session} → 手机进入 needs-pair', async () => {
    const port = await pickFreePort()
    const scene = await boot({ port, hostId: 'e2e_resume_relay' })
    let second = null
    try {
      const convId = await scene.pair()
      await untilAsync(() => scene.relay.health().then((h) => h.conversations === 1), { label: '中继侧有 1 条会话', trail: scene.phone.trail })
      const framesAtRestart = tap.frames.length
      const exit = await scene.relay.stop('SIGTERM')
      assert.equal(exit.code, 0, `旧中继必须优雅退出 0，实际 code=${exit.code} signal=${exit.signal}`)
      // 新中继起在**同一个端口**：手机与主机都靠各自的退避重连，我们不碰它们的内部状态。
      second = await startRelay({ port, env: { DRC_SWEEP_MS: '1000' }, label: '重启后的中继' })
      assert.equal(second.port, port, '重启必须回到同一个地址，否则测的不是"旧 convId 撞新表"')

      // 手机的 socket 会自动重连；重连后它按本地配对直接发 cmd.list_sessions（client.js:258-261）。
      // 内存态没有持久化 → 这条 convId 在新表里不存在 → 必须回 unknown_session。
      const error = await untilAsync(
        async () => {
          const seen = tap.frames.slice(framesAtRestart).map((f) => (f.side === 'phone' && f.dir === 'received' ? safeJson(f.raw) : null))
          return seen.find((frame) => frame?.t === 'error' && frame.code === 'unknown_session') ?? null
        },
        { timeoutMs: 40_000, intervalMs: 200, label: '重启后的中继对旧 convId 回 error{unknown_session}', trail: scene.phone.trail },
      )
      assert.equal(error.code, 'unknown_session', '错误码必须逐字是 unknown_session（换别的 code 手机只会弹一句英文 toast）')
      const message = String(error.message ?? '')
      // 中继给手机侧的每条 error 都必须自带中文（复核 R2：手机对未知 code 只会把 message||code
      // 原样弹出来，没有 message 就是一句用户看不懂的英文）。
      assert.ok(message.includes('会话') && message.includes('配对'), `error.message 必须是可读的中文提示，收到 ${JSON.stringify(message)}`)
      assert.notEqual(message, error.code, 'message 不许退化成错误码本身')
      await until(() => scene.phone.client.status === 'needs-pair', {
        timeoutMs: 10_000,
        trail: scene.phone.trail,
        label: '手机进入 needs-pair',
      })
      assert.match(scene.phone.client.statusText, /会话已失效，请重新配对/, `文案必须逐字对号，收到 ${JSON.stringify(scene.phone.client.statusText)}`)
      assert.equal(scene.phone.client.convId, '', 'unknown_session 必须让手机清掉配对')
      // 连接不能因此被掐断：客户端要继续重连并提示输码（红线 7）。
      const closed = controlFrames('phone', 'received', ['error'])
      assert.ok(closed.length >= 1)
      const health = await second.health()
      assert.equal(health.conversations, 0, '新中继的路由表就该是空的（内存态、有意不持久化）')
      assert.equal(scene.phone.client.status, 'needs-pair', '手机必须停在 needs-pair 等用户，而不是继续转圈')
    } finally {
      scene.phone.close()
      scene.host.stop()
      if (second) {
        const exit2 = await second.stop('SIGTERM')
        assert.equal(exit2.code, 0, `重启后的中继也必须优雅退出，实际 ${JSON.stringify(exit2)}`)
      }
    }
  })

  test('(c) 主机侧重启：不许静默黑洞——必须观察到 unknown_session 或 peer-left 之一（复核 R1）', async () => {
    const scene = await boot({ hostId: 'e2e_resume_host' })
    let second = null
    try {
      const convId = await scene.pair()
      await untilAsync(() => scene.relay.health().then((h) => h.conversations === 1), { label: '中继侧有 1 条会话', trail: scene.phone.trail })
      assert.equal(scene.host.state().conversations, 1, '重启前主机手里必须有这条会话的密钥')

      // 主机进程重启：同一 hostId、全新的 PairingSlots（旧 conv 的 PSK 随进程没了）。
      const framesAtRestart = tap.frames.length
      scene.host.stop()
      await untilAsync(() => scene.relay.health().then((h) => h.hosts === 0), {
        label: '中继看到主机离开',
        trail: scene.phone.trail,
      })
      second = await bootHost({ relayUrl: scene.relay.url, hostId: 'e2e_resume_host', statusDir: workDir, pairTtlMs: 60_000, approvalTimeoutSec: 20 })
      await untilAsync(() => scene.relay.health().then((h) => h.hosts === 1), {
        label: '主机（重启后）重新挂上中继',
        trail: scene.phone.trail,
        timeoutMs: 20_000,
      })
      assert.equal(second.state().conversations, 0, '重启后的主机手里不该还留着旧会话的密钥')
      const resync = await untilAsync(
        async () => controlFrames('host', 'sent', ['resync']).find((f) => Array.isArray(f.sessionIds)) ?? null,
        { label: '重启后的主机发出 resync', trail: scene.phone.trail, timeoutMs: 10_000 },
      )
      assert.ok(resync, '重启后的主机必须发 resync 声明它持有哪些会话（中继据此删掉没人接的）')
      assert.ok(!resync.sessionIds.includes(convId), 'resync 不许把没密钥的旧会话声明成还在')

      // 手机此刻还以为一切正常（status=online）：这正是 R1 描述的"没有出口"的位置。
      assert.equal(scene.phone.client.status, 'online')
      const cmdId = scene.phone.client.newCmdId()
      scene.phone.client.sendCmd({ t: 'cmd.list_sessions', cmdId })
      const observed = await untilAsync(
        async () => {
          const later = tap.frames.slice(framesAtRestart).filter((f) => f.side === 'phone' && f.dir === 'received')
          const unknown = later.map((f) => safeJson(f.raw)).find((frame) => frame?.t === 'error' && frame.code === 'unknown_session')
          if (unknown) return { kind: 'unknown_session', frame: unknown }
          const left = later.map((f) => safeJson(f.raw)).find((frame) => frame?.t === 'peer-left' && frame.sessionId === convId)
          if (left) return { kind: 'peer-left', frame: left }
          return null
        },
        { timeoutMs: 30_000, intervalMs: 200, label: '主机重启后手机拿到 unknown_session 或 peer-left 之一（静默黑洞即红）', trail: scene.phone.trail },
      )
      assert.ok(['unknown_session', 'peer-left'].includes(observed.kind), `出口只能是这两种，收到 ${observed.kind}`)
      await until(() => scene.phone.client.status === 'needs-pair', {
        timeoutMs: 10_000,
        trail: scene.phone.trail,
        label: '手机停在 needs-pair（等用户重新扫码，而不是继续转圈）',
      })
      assert.match(
        scene.phone.client.statusText,
        /(会话已失效，请重新配对|主机已断开，请重新配对)/,
        `两个出口对应的中文文案必须对号，收到 ${JSON.stringify(scene.phone.client.statusText)}`,
      )
      assert.equal(scene.phone.client.convId, '', '配对必须被清掉')
      // 黑洞的另一种形态：手机侧连续两帧解不开也会掉配对——不许出现"既没提示也没回复"。
      const decryptErrors = scene.phone.events.filter((e) => e.kind === 'error' && String(e.message).includes('无法解密'))
      process.stdout.write(
        `     取证：出口=${observed.kind} 解密失败提示=${decryptErrors.length} 次；手机最终 status=${scene.phone.client.status}\n`,
      )
      const health = await scene.relay.health()
      assert.equal(health.conversations, 0, `会话最终必须被回收（留下没人接的会话就是黑洞），实际 ${health.conversations}`)
    } finally {
      scene.phone.close()
      if (second) second.stop()
      scene.host.stop()
      const exit = await scene.relay.stop('SIGTERM')
      assert.equal(exit.code, 0, `中继 SIGTERM 必须退出 0，实际 ${JSON.stringify(exit)}`)
    }
  })
})

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function assertSessionShapeIsFine(changed) {
  assert.ok(Array.isArray(changed.sessions) && changed.sessions.length > 0, '续用后的列表必须还是非空')
  for (const session of changed.sessions) {
    assert.equal(typeof session.id, 'string')
    if (session.updatedAt !== undefined) assert.equal(typeof session.updatedAt, 'string', 'F7：updatedAt 只能是 ISO 字符串')
  }
}
