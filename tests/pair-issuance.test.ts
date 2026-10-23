/**
 * pair-issuance —— 配对码"花名账 + 展示位"的模块级判据（v5 R1）。
 *
 * 为什么要有这层：e2e 那三条路（消费 / 退出配对 / pair-fail）同时做 `spend` 与
 * `clearShown`，于是"花名账"这道防线在端到端层**不可区分**（2026-10-23 R1 变异
 * 反证实测：把 `spentTokens.add` 打掉，698 条单测 + pairing-refresh 全链照样绿）。
 * 防线要有自己的判据，否则它是死的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPairIssuance } from '../src/core/pair-issuance.js'
import { PairingSlots } from '../src/core/keys.js'
import { PairingWindow } from '../src/core/pairing-window.js'
import { DEFAULT_SYSTEM_CLOCK } from '../src/core/clock.js'

function fixture() {
  const clock = DEFAULT_SYSTEM_CLOCK
  const slots = new PairingSlots(() => clock.now())
  const logs: string[] = []
  const published: Array<{ token: string; ttl: number }> = []
  const window = new PairingWindow(
    {
      clock,
      relayOnline: () => true,
      generation: () => 1,
      publish: () => null,
      log: () => {},
    },
    0,
    120_000,
  )
  let online: 'ok' | 'not-open' | 'no-relay' = 'ok'
  const issuance = createPairIssuance({
    clock,
    log: (m) => logs.push(m),
    slots,
    pairingWindow: window,
    pairTtlMs: 120_000,
    publishSlot: (slot) => {
      published.push({ token: slot.token, ttl: 120_000 })
      return online
    },
  })
  return { issuance, slots, published, logs, setOnline: (v: typeof online) => (online = v) }
}

test('花名账防线：spend 过的码不许再出现在展示位/快照里', () => {
  const { issuance } = fixture()
  const created = issuance.publish()
  assert.ok(created, '夹具自检：发得出一张码')
  assert.ok(issuance.current(), '夹具自检：发出去的码在展示位上')

  issuance.spend(created!.token)
  assert.equal(issuance.current(), null, '花掉的码必须当"没有码"（防线①）')
  assert.equal(issuance.describe(), null, '花掉的码不许进 status 快照（外部脚本会照抄它）')
})

test('同码重发是"复活展示"而不是"复活认领"：publish 把它从花名账摘掉（认领与否由中继判）', () => {
  const { issuance } = fixture()
  const first = issuance.publish()
  issuance.spend(first!.token)
  assert.equal(issuance.current(), null)

  // 同一个 token 再发一次（窗口/槽位允许同码重发）⇒ 展示位可再用；
  // 中继那边 `claim()` 会不会放行是**中继的事**（issuePair 绝不复活已认领的码）。
  const again = issuance.publish()
  assert.ok(again, '复发必须发得出去')
  assert.ok(issuance.current(), '复发后展示位必须是活的（花名账按 token 记，重发即清）')
})

test('发不出去不算一张码：socket 不是 OPEN 时展示位不许留下死码', () => {
  const { issuance, logs, setOnline } = fixture()
  setOnline('not-open')
  assert.equal(issuance.publish(), null, '发不出去必须回 null（不是一张码）')
  assert.equal(issuance.current(), null, '展示位不许留"中继根本没收到"的码')
  assert.ok(
    logs.some((l) => l.includes('not open')),
    '不硬发也要留痕',
  )

  setOnline('no-relay')
  assert.equal(issuance.publish(), null, '还没连上中继时同样不算一张码')
})

test('ensureFresh 幂等：已经有能用的就给那张，不许每点一次发一张（多码事故）', () => {
  const { issuance, published } = fixture()
  const first = issuance.ensureFresh()
  assert.ok(first)
  const second = issuance.ensureFresh()
  assert.equal(second!.token, first!.token, '第二次必须还是同一张')
  assert.equal(published.length, 1, '连点三下也只许有一张在途（多码并存 = 全线解不开）')
})
