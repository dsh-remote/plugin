/**
 * pairing-refresh — 屏幕上那张配对码必须是**没花过**的。
 *
 * 2026-10-05 用户连报三条，根因是同一个：配对码是一次性的（中继 `claim()` 里
 * `pending.used = true`，重放只拿到 `already_used`），而主机 `active.pairing`——
 * status.json 里那张、状态栏二维码那张、`/pairing/new` 发的那张——从来没有人把它
 * 在该花掉的时候换掉。
 *
 * 用户的三个表象与这条根因的对应：
 * 1. "手机离线太久后连不上" —— 回来重新扫，扫到的是主机还挂着的那张旧码，
 *    中继回 already_used；
 * 2. "dsh 操作退出配对后，新的二维码也连不上，要等下次刷新的二维码才能用" ——
 *    退出配对只作废了通道，没换码，而 `pairOnStartSec` 默认 0（自动发码关着）
 *    于是没有任何东西去换，只能干等 TTL（线上中继 180 s）走完；
 * 3. "手机解除配对之后 dsh 又不同步状态" —— pill 三态靠 `paired`(clientCount) 与
 *    `pairings`(密钥簿) 两个字段，glance 一下就该变。
 *
 * 手法与 multi-pair / restart-resume 同一套：真中继 + 真插件运行时（内核面 mock）
 * + 真小程序客户端代码。判据只可能这样写——单测里的假发码器不会告诉你
 * "那张码中继根本不认"。
 *
 * ## 已知不稳定：中继日志级别会决定它红不红（2026-10-06 实测）
 *
 * 下面第 2 条在 `DRC_LOG_LEVEL=warn` 下**间歇性**红：连跑 8 次红 2 次（约 25%）。失败形态
 * 固定是「扫屏幕上那张码失败：等不到配对完成（手机 status=online）」，事件轨迹
 * `connecting → pairing → needs-pair` —— 即中继回了 `pair-fail`。
 *
 * 改成 `info` 之后（见 before() 的注释）连跑 **22 次全绿**，一次没复现。`warn` 档恰好把
 * 唯一能回答「这张码为什么没配上」的那条 `pair failed {reason}` 藏掉了，所以这个对照
 * 也正好解释了当初为什么查不出来。
 *
 * **机制没有定位，所以不敢说"修好了"**：按 25% 的发生率，22 次全绿在统计上很有说服力，
 * 但 `pair-fail` 的三个 reason（码过期 / 已用过 / 主机 socket 不在 OPEN）指向三条完全
 * 不同的路，而"日志级别能影响配对成功率"这件事本身还没有解释——它可能是巧合，也可能是
 * 写日志带来的时序变化恰好躲开了一个竞态。**如果以后又红，先看失败消息里附带的那几行
 * 中继日志**，那里面有 reason。**
 *
 * 刻意**不加重试**：这条判据要证明的正是「屏幕上那张码**真的**能配上」，
 * 加重试等于把它变成测不出东西的判据。
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { bootHost, shutdown, startRelay, untilAsync, newPhone, pairPhone } from './run.mjs'

const NEW = '/plugins/dsh-remote-control/pairing/new'
const UNPAIR = '/plugins/dsh-remote-control/unpair'
const STATUS = '/plugins/dsh-remote-control/status'
const marker = { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'x-drc-pair': '1' }

describe('屏幕上那张配对码：花掉了就必须换掉，不许递给用户', () => {
  const workDir = path.join(os.tmpdir(), `drc-e2e-pairfresh-${process.pid}`)
  let relay = null
  let host = null

  before(async () => {
    mkdirSync(workDir, { recursive: true })
    relay = await startRelay({
      // `info` 而不是 `warn`：配对失败时中继只打一条 `pair failed {reason}`（info 级），
      // `warn` 恰好把**唯一**能回答「这张码为什么没配上」的那行藏掉。实测这个用例有
      // 间歇性失败，没有那行日志就只能猜（见文件头「已知不稳定」那条）。
      env: { DRC_SWEEP_MS: '600', DRC_CONV_EMPTY_TTL_MS: '1500', DRC_LOG_LEVEL: 'info' },
      label: '本地中继（pairing-refresh）',
    })
    // TTL 给 20 秒：那张花掉的码在本地 slot 里**仍然有效**——正是旧代码会把死码
    // 递出去的那一段窗口。pairOnStartSec 用默认的 0（自动发码关着），与真机一致。
    // ⚠️ 不要再传 `carrierGraceMs`：它 2026-10-06 已从配置面删掉（全 src 零读取，
    // `packages/plugin/tests/config.test.ts` 有判据钉着「它是死键」）。装置里还传着，
    // 会让人以为这里有什么宽限期在起作用。
    host = await bootHost({ relayUrl: relay.url, hostId: 'e2e_pairfresh_host', statusDir: workDir, pairTtlMs: 20_000 })
  })

  after(async () => {
    const { relayExit } = await shutdown({ host, relay })
    rmSync(workDir, { recursive: true, force: true })
    assert.equal(relayExit.code, 0, `中继必须优雅退出 0，实际 ${JSON.stringify(relayExit)}`)
  })

  /** status.json 里那张（= 状态栏二维码那张、外部脚本照抄的那张）。 */
  function shownPairing() {
    // 读**这台主机自己**的状态文件（`host.statusFile`，bootHost 交出来的确切路径）。
    // 老写法是 `readdirSync(workDir).filter(...)[0]`：目录里可能有另一台主机留下的
    // `host-*.json`，而 readdir 的顺序没有保证 —— 读到哪一份全看文件系统心情。
    try {
      return JSON.parse(readFileSync(host.statusFile, 'utf8')).pairing ?? null
    } catch {
      return null
    }
  }

  /**
   * 走一遍状态栏的真实流程：点一下 `/pairing/new` → 等 status 的 3 秒节拍把那张
   * 二维码落盘 → 返回它。pairOnStartSec=0 时点之前屏幕上本来就没有码，
   * 所以"屏幕上有没有"这件事必须由 `/pairing/new` 主动触发。
   */
  async function codeOnScreen(what) {
    const reply = await host.callPill(NEW, { method: 'POST', headers: marker })
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    assert.ok(reply.body.token, `${what}：/pairing/new 必须给得出码`)
    await untilAsync(
      () => {
        const p = shownPairing()
        return Boolean(p && p.token === reply.body.token)
      },
      { timeoutMs: 8000, intervalMs: 200, label: `${what}（二维码落到 status.json）` },
    )
    return shownPairing()
  }

  /** 用屏幕上那张码真配一次手机：成没成不看主机怎么说，看手机有没有 online。 */
  async function scanShown(tag) {
    const pairing = await codeOnScreen(tag)
    assert.ok(pairing && pairing.qr, `${tag}：屏幕上必须有一张码`)
    const phone = newPhone(tag)
    try {
      const { parsed } = await pairPhone(host, phone, { pairing })
      return { phone, parsed, token: pairing.token }
    } catch (error) {
      await shutdown({ phone })
      // 失败消息自带证据：配对失败时中继只打一条 `pair failed {reason}`，而它的三个 reason
      // 指向三条完全不同的路（码过期 / 已用过 / 主机 socket 不在 OPEN）。不把这条带出来，
      // 下一个人只能猜——本轮就是这样连猜了三次（见文件头「已知不稳定」）。
      const evidence = relay.logLines
        .filter((line) => /"pair failed"|"paired"|"host online"|"client online"/.test(line))
        .slice(-6)
      throw new Error(
        `${tag}：扫屏幕上那张码失败（${String(error.message).slice(0, 120)}）\n` +
          `   中继侧相关日志：\n     ${evidence.join('\n     ') || '（无——级别被调低了？）'}`,
      )
    }
  }

  test('1. 手机配过之后，屏幕上不能再是那张花掉的码（用户：离线回来连不上）', async () => {
    const { phone, parsed, token: spent } = await scanShown('第一部手机')

    // 手机退开再回来：同一条 convId 续用（D3）。这一条同时钉住"离线回来还连得上"。
    phone.close()
    await delay(1_200)
    phone.client.connect({ server: parsed.server })
    await untilAsync(
      async () => {
        const s = await host.callPill(STATUS, { headers: marker })
        return s.body.paired === 1
      },
      { timeoutMs: 8000, intervalMs: 200, label: '手机回来之后 paired 回到 1' },
    )

    // 屏幕上换一张没花过的，而且它真能配。旧代码这里给的还是 spent，
    // 中继回 already_used，用户看到的就是"新二维码也连不上"。
    const fresh = await codeOnScreen('换新码之后')
    assert.notEqual(fresh.token, spent, '屏幕上不许还是刚花掉的那张')

    const second = await scanShown('第二部手机')
    assert.equal(second.phone.status, 'online')
    await shutdown({ phone: second.phone })
    await shutdown({ phone })
  })

  test('2. 退出配对：当场换一张能用的码，而不是让用户干等 TTL（用户：要等下次刷新）', async () => {
    const { phone, token: scanned } = await scanShown('先配一部')

    // 先把 status.json 的 3 秒节拍等过去：配对成功那一刻花掉的码已从 active 里摘掉，
    // 但文件可能还停在配对前那一版。不等就會读到陈旧内容，会把后面的判据变成假的。
    await untilAsync(
      () => {
        const p = shownPairing()
        return !p || p.token !== scanned
      },
      { timeoutMs: 8000, intervalMs: 200, label: '配对成功后 status.json 不再挂着刚花掉那张' },
    )

    const reply = await host.callPill(UNPAIR, { method: 'POST', headers: marker })
    assert.equal(reply.status, 200, JSON.stringify(reply.body))

    // 关键：**不调 `/pairing/new`、不等待"自动发码"**（pairOnStartSec=0，自动那条路
    // 根本不走）。退出配对这一步自己就要把一张新码落进 status.json——那张二维码图
    // 读的就是它。旧代码只作废通道、不动码，于是这里一直是 null（花掉的码被勾掉后
    // 没有任何东西补位），用户看到的就是"二维码是空的/扫了没用，要等下次刷新"。
    await untilAsync(
      () => {
        const p = shownPairing()
        return Boolean(p && p.qr)
      },
      { timeoutMs: 8000, intervalMs: 200, label: '退出配对后 status.json 里就有一张新码' },
    )
    const fresh = shownPairing()
    assert.ok(fresh && fresh.qr, '退出配对后屏幕上必须立刻有一张码')

    const after = await scanShown('退出配对后新扫一部')
    assert.equal(after.phone.status, 'online')
    await shutdown({ phone: after.phone })
    await shutdown({ phone })
  })

  test('3. 退出配对之后 pill 的连接状态跟着变（用户：dsh 又不同步状态）', async () => {
    const { phone } = await scanShown('为状态判据配一部')
    const paired = await host.callPill(STATUS, { headers: marker })
    assert.equal(paired.body.paired, 1, '配上了一台手机')
    assert.equal(paired.body.pairings, 1, '密钥簿里一条会话')

    // 手机这一侧解除配对：主机必须当场知道"没有手机连着了"。
    phone.client.unpair()
    await untilAsync(
      async () => {
        const s = await host.callPill(STATUS, { headers: marker })
        return s.body.paired === 0
      },
      { timeoutMs: 6000, intervalMs: 200, label: '手机解除配对后主机 paired 归零' },
    )

    // 主机退出配对：密钥簿也清空，未配对态就不再有任何残留。
    await host.callPill(UNPAIR, { method: 'POST', headers: marker })
    await untilAsync(
      async () => {
        const s = await host.callPill(STATUS, { headers: marker })
        return s.body.pairings === 0
      },
      { timeoutMs: 6000, intervalMs: 200, label: '主机退出配对后 pairings 归零' },
    )
    await shutdown({ phone })
  })
})
