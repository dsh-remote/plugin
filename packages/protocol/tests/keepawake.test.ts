import test from 'node:test'
import assert from 'node:assert/strict'
import { buildKeepAwakeCommand, windowsExecutionStateCommand } from '../src/keepawake.js'

test('macOS: caffeinate idle+system, bound to pid', () => {
  const c = buildKeepAwakeCommand('darwin', 4321)!
  assert.equal(c.bin, '/usr/bin/caffeinate')
  assert.deepEqual(c.args, ['-i', '-s', '-w', '4321'])
})

test('macOS keepDisplay adds display assertion', () => {
  const c = buildKeepAwakeCommand('darwin', 1, true)!
  assert.ok(c.args.includes('-d'))
  assert.ok(c.args.includes('-u'))
})

test('Linux: systemd-inhibit idle:sleep block', () => {
  const c = buildKeepAwakeCommand('linux', 1)!
  assert.equal(c.bin, 'systemd-inhibit')
  assert.ok(c.args.includes('--what=idle:sleep'))
  assert.ok(c.args.includes('--mode=block'))
})

test('Windows: SetThreadExecutionState flags', () => {
  const sys = windowsExecutionStateCommand(false)
  assert.match(sys.args.join(' '), /0x80000001u/)
  const disp = windowsExecutionStateCommand(true)
  assert.match(disp.args.join(' '), /0x80000003u/)
  assert.equal(buildKeepAwakeCommand('win32', 1)!.bin, 'powershell')
})

test('unsupported platform returns null', () => {
  assert.equal(buildKeepAwakeCommand('freebsd' as NodeJS.Platform, 1), null)
})
