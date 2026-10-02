/**
 * 防休眠命令构造器。
 *
 * 这里测的是"参数对不对"，不是"机器真的不睡了没"——后者要在真机上取证。
 * 参数表是这套方案唯一的产物：`-w <pid>` 少一个字符，插件崩溃后机器就会永远不睡。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSleepCommand, detectBackend, isSleepSupported } from '../../src/platform/sleep.js'

test('macOS：默认用 -i -s -w <pid>，不带动 sudo，不绑屏幕', () => {
  assert.deepEqual(buildSleepCommand('darwin', 4321), {
    command: '/usr/bin/caffeinate',
    args: ['-i', '-s', '-w', '4321'],
  })
})

test('macOS：keepDisplay 走 -d/-u 分支（保持旧语义，未实测，不顺手"修正"）', () => {
  assert.deepEqual(buildSleepCommand('darwin', 4321, true), {
    command: '/usr/bin/caffeinate',
    args: ['-d', '-i', '-u', 'disk,display', '-w', '4321'],
  })
})

test('Linux：--what=idle:sleep 与 --mode=block 缺一不可，末尾必须是 sleep infinity', () => {
  const cmd = buildSleepCommand('linux', 1)
  assert.ok(cmd)
  assert.equal(cmd.command, 'systemd-inhibit')
  assert.ok(cmd.args.includes('--what=idle:sleep'), '只抑制 idle 不抑制 sleep 的话合盖仍会挂起')
  assert.ok(cmd.args.includes('--mode=block'), '默认 delay 只是推迟，策略仍可让机器睡')
  assert.deepEqual(cmd.args.slice(-2), ['sleep', 'infinity'], '锁持有到被 hold 的命令退出')
  assert.ok(!cmd.args.includes('-w'), 'systemd-inhibit 没有 -w 语义，pid 不该出现在这里')
})

test('Windows 与其它平台：返回 null 并报 unsupported，不产出任何 powershell', () => {
  assert.equal(buildSleepCommand('win32', 1), null)
  assert.equal(buildSleepCommand('freebsd', 1), null)
  assert.equal(detectBackend('win32'), 'unsupported')
  assert.equal(detectBackend('darwin'), 'caffeinate')
  assert.equal(detectBackend('linux'), 'systemd-inhibit')
  assert.equal(isSleepSupported('win32'), false)
  assert.equal(isSleepSupported('darwin'), true)
})

test('pid 坏值直接抛（写成 -w undefined 会 spawn 出一个永不退出的 caffeinate）', () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => buildSleepCommand('darwin', bad), /正整数/, String(bad))
  }
})
