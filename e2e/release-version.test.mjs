/**
 * next-version 的判据 —— `scripts/next-version.mjs` 的纯函数部分。
 *
 * 为什么值得测：这一段决定**发出去的号对不对**，而错了的代价是「latest 退回去」
 * 或「npm 拒绝发布」——两者都要到发版那一刻才现形，而那时已经改不回去了。
 *
 * 这里**不联网**：判据的输入是"哪些版本被占用了"，测试里直接给。
 * 真连 npm 的那条路径由 `node scripts/next-version.mjs --check` 在发版前跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatVersion, isGreater, nextVersion, parseVersion } from '../scripts/next-version.mjs'

test('预发布排在同版本的正式版之前（semver：1.0.0-rc.1 < 1.0.0）', () => {
  assert.equal(isGreater('1.0.0', '1.0.0-rc.1'), true, '切 latest 到正式版不是"倒退"')
  assert.equal(isGreater('1.0.0-rc.1', '1.0.0'), false)
  assert.equal(isGreater('1.0.0-rc.2', '1.0.0-rc.1'), true)
  assert.equal(isGreater('1.0.0', '1.0.0'), false, '相同版本不算更大')
})

test('按 semver 比大小，不按字符串（否则 1.0.10 会小于 1.0.9）', () => {
  assert.equal(isGreater('1.0.10', '1.0.9'), true, '字符串比较会把 1.0.10 排在 1.0.9 前面')
  assert.equal(isGreater('2.0.0', '1.99.99'), true)
  assert.equal(isGreater('1.2.0', '1.10.0'), false)
})

test('形状不对的版本号要当场报出来，不许默默当 0', () => {
  for (const bad of ['', '1.0', 'v1.0.0', '1.0.0.0', 'abc', '1.0.0-']) {
    assert.throws(() => parseVersion(bad), /版本号形状不对/, `\`${bad}\` 不该被放过`)
  }
  assert.equal(formatVersion(parseVersion('2.0.14')), '2.0.14')
  assert.equal(formatVersion(parseVersion('1.0.0-rc.1')), '1.0.0-rc.1')
})

test('建议号必须**大于**所有已发布版本 —— 2.0.8 那个坑（2026-10-07 实际卡过一次）', () => {
  // control 当年从 2.0.7 直接跳到 2.0.9，所以 **2.0.8 是空的**。
  // 但发 2.0.8 等于版本号倒退：2.0.13 已经出去了，latest 会退回去，
  // 而 `^2.0.0` 的消费方按 semver 比大小，**拿不到** 2.0.8。
  // ⚠️ 刻意**打乱顺序**：第一版的用例给的是升序，于是"取最后一个当最大"这种写法
  // 照样通过——那正是这道闸的判据（必须真的比出最大，而不是相信输入有序）。
  // npm 一般给升序，但**依赖输入有序**就是本条要防的病。
  const wire = ['1.9.0', '1.0.0', '1.0.1', '1.0.0-rc.1', '1.1.0']
  const ctrl = ['2.0.13', '1.2.0', '2.0.9', '1.0.0-rc.1', '2.0.0', '1.0.0', '2.0.7', '1.1.0']
  assert.equal(nextVersion([wire, ctrl]), '2.0.14', '必须跳过"空着但更小"的 2.0.8')
})

test('建议号还要在**两个包上**都空着（一个包占了就换另一个）', () => {
  const wire = ['1.0.0']
  const ctrl = ['1.0.0', '1.0.1']
  assert.equal(nextVersion([wire, ctrl]), '1.0.2')
})

test('--major：跳到下一个大版本，而不是在小版本里找', () => {
  const wire = ['1.9.0']
  const ctrl = ['2.0.13']
  assert.equal(nextVersion([wire, ctrl]), '2.0.14')
  assert.equal(nextVersion([wire, ctrl], { bumpMajor: true }), '3.0.1', '跳大版本时 patch 从 1 起')
})

test('两个包都空 → 从 0.0.1 起给得出号（别在空输入上崩）', () => {
  assert.equal(nextVersion([[], []]), '0.0.1')
})
