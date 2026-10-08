/**
 * iso — 越界的时刻不许让 status.json 永久停更。
 *
 * ## 这条为什么存在
 *
 * `new Date(n).toISOString()` 在 `|n| > 8.64e15` 时抛 `RangeError`。而这个调用
 * 出现在**构造 status.json 快照**的过程中，`shell/status.ts` 的写盘外面包着一个
 * 空 catch（"状态入口不许成为崩溃源"——那条纪律本身是对的）⇒ **一帧数据里的一个
 * 越界时刻，会让整个 status.json 从此永久停更**，而 GUI 宿主里那是唯一的排错入口
 * （`carrier` / `relay` / `problems` 全部冻在启动那一版，且没有任何日志说这件事）。
 *
 * 实测触发路径：中继回一条 `pair-ready{ttlMs: 1e17}` → 端点算 `createdAt + ttlMs`
 * → 写进 status 快照时抛 → 每 3 秒的快照全丢。
 *
 * 口径：**越界 ⇒ undefined**，不是"回一个假的"。回一个假时刻（epoch、夹到上限）
 * 会让用户看到一个看起来正常但错的过期时间，而"没有这个字段"在界面上的表现是
 * "不显示时间角标"——一个诚实的缺席。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isoOrUndefined } from '../src/shell/iso.js'

test('正常时刻逐字等于 toISOString（这道闸不许改变正常路径的输出）', () => {
  for (const ms of [0, 1, 1_700_000_000_000, Date.UTC(2026, 9, 7)]) {
    assert.equal(isoOrUndefined(ms), new Date(ms).toISOString(), `${ms} 的输出必须与原生一致`)
  }
})

test('越界返回 undefined，而**不是**抛（抛就是这一族缺陷本身）', () => {
  const MAX = 8.64e15
  for (const ms of [MAX + 1, 1e17, 1e300, -MAX - 1, -1e17]) {
    assert.equal(isoOrUndefined(ms), undefined, `${ms} 越界，必须给 undefined`)
  }
  // 边界本身合法（Date 的范围是闭区间）
  assert.ok(isoOrUndefined(MAX), '正好等于上限必须仍然可用 —— 判据不能比实现更严')
  assert.ok(isoOrUndefined(-MAX))
})

test('NaN / Infinity / undefined 都给 undefined', () => {
  // NaN 特别值得单列：`JSON.stringify(NaN)` 是 `null`（悄悄变成一个空字段），
  // 而 `new Date(NaN).toISOString()` 直接抛。两条都不可接受。
  assert.equal(isoOrUndefined(Number.NaN), undefined)
  assert.equal(isoOrUndefined(Number.POSITIVE_INFINITY), undefined)
  assert.equal(isoOrUndefined(Number.NEGATIVE_INFINITY), undefined)
  assert.equal(isoOrUndefined(undefined), undefined)
})

test('反向判据：undefined 真的会被 JSON 序列化"省略"，而不是变成 null', () => {
  // 这是口径选择的根据：字段缺席（界面上"不显示"）而不是 null（界面上"显示空"）。
  const withValue = { a: 1, expiresAt: isoOrUndefined(1_700_000_000_000) }
  const without = { a: 1, expiresAt: isoOrUndefined(1e17) }
  assert.match(JSON.stringify(withValue), /"expiresAt":"\d{4}-/, '正常时刻要真的写进去')
  assert.equal(JSON.stringify(without), '{"a":1}', '越界时整个字段消失，而不是 null')
})
