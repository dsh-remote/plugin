/**
 * log-line.test — 插件日志的值长度上界。
 *
 * 中继侧早就有同一条纪律（`dsh-remote-server/src/log.ts`）：**一条 409 KB 的日志行和一条
 * 40 字节的日志行，占的是同一个采集管道的配额**。2026-10-06 把同样的纪律补到插件侧——
 * 那边三处 `message:`（错误消息）一个都没截断，而错误消息恰恰是长度不由我们决定的那类。
 *
 * 这条判据第一版写在 `host-wiring.test.ts` 里，**恒绿**：它跑 `apply()` 看有没有长行，
 * 而启动路径上根本没有长行——把截断整个去掉它照样全绿。那种判据比没有更坏。
 * 现在直接测纯函数：喂 10 万字符进去，断言出来的是 256+1。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLogRecord, clampLogText, MAX_LOG_VALUE_CHARS } from '../src/shell/log-line.js'

test('超长的值被截到上限 + 一个省略号，且不丢前 256 个字符', () => {
  const huge = 'E'.repeat(100_000)
  const clamped = clampLogText(huge)
  assert.equal(
    clamped.length,
    MAX_LOG_VALUE_CHARS + 1,
    `截断后应当是 ${MAX_LOG_VALUE_CHARS} + 省略号，实际 ${clamped.length}`,
  )
  assert.ok(clamped.endsWith('…'), '截断后要留下"这里被截过"的痕迹')
  assert.ok(clamped.startsWith('E'.repeat(MAX_LOG_VALUE_CHARS)), '前 256 个字符必须原样保留——它们才是排错要用的')
  assert.equal(clamped.split('E').length - 1, MAX_LOG_VALUE_CHARS, '正文只该剩下上限那么多个 E')
})

test('长度正好在上限内的值**一个字节都不动**（截断不是每次都发生）', () => {
  const exact = 'x'.repeat(MAX_LOG_VALUE_CHARS)
  assert.equal(clampLogText(exact), exact, '等于上限就该原样返回')
  assert.equal(clampLogText(''), '', '空串也是合法值')
})

test('记录里的每一个字符串字段都过截断，数字与布尔不动', () => {
  const record = buildLogRecord(
    '一条很长的消息'.repeat(5_000),
    {
      long: 'L'.repeat(50_000),
      count: 7,
      ok: true,
      skipped: undefined,
    },
    '2026-10-07T00:00:00.000Z',
  )
  assert.ok((record.msg as string).length <= MAX_LOG_VALUE_CHARS + 1, 'msg 也要截（含前缀）')
  assert.equal((record.long as string).length, MAX_LOG_VALUE_CHARS + 1, '字段值要截')
  assert.equal(record.count, 7, '数字不能被当成字符串截')
  assert.equal(record.ok, true, '布尔不能动')
  assert.equal('skipped' in record, false, 'undefined 的字段直接不出现，而不是变成 null')
  assert.equal(record.ts, '2026-10-07T00:00:00.000Z', 'ts 原样带着')
})

test('截断后的整行仍然是一条合法 JSON（截断不能把行写坏）', () => {
  const record = buildLogRecord('x', { evil: '"引号"与\\反斜杠\n换行'.repeat(2_000) }, 'ts')
  const line = JSON.stringify(record)
  assert.doesNotThrow(() => JSON.parse(line), '截断之后仍必须能被 JSON.parse 读回来')
  assert.ok(line.includes('\\n'), '换行符要按 JSON 规则转义，而不是把日志行真的截断成两行')
})
