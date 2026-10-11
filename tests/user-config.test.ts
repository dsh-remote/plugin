/**
 * user-config 的判据 —— 设置页「进阶」那一栏的落盘与它在配置优先级里的位置（2026-10-11）。
 *
 * ## 这一层要守什么
 *
 * 1. **空串 = 删掉这一项**，不是"写一个空字符串进去"。表单没有这一条就没有退路：
 *    用户清空输入框再保存，必须真的回到下一层（patch / 默认值），而不是把地址改成一个空串。
 * 2. **优先级是四级**：`默认值 < 本文件 < patch 注入 < 环境变量`。
 *    手写 patch 的人（自部署的常态）必须仍然说了算——一个网页表单不许悄悄盖掉他写的那行。
 * 3. **坏文件只坏一项**：`serverUrl` 写坏了不该把 `hostToken` 一起丢掉。
 * 4. **0600 + 绝不抛**：里面有 token。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  normalizeUserOverrides,
  readUserConfig,
  resolveUserConfigFile,
  writeUserConfig,
} from '../src/shell/user-config.js'
import { DEFAULT_CONFIG, readConfig } from '../src/shell/config.js'
import { skipUnlessPosix } from './test-platform.js'

const POSIX_ONLY = skipUnlessPosix()
const LONG_ENOUGH = 'fake-host-token-not-a-real-secret-0123456789abcdef'

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'drc-usercfg-'))
}

test('归一：空串 = 删掉这一项（key 在 = 用户动过它），非法地址当场拒', () => {
  // `''` 进来 ⇒ 这一项**以 undefined 的形式留在返回值里**（"用户要求删掉"这个意图必须能传下去，
  // 否则保存那一步分不出"没提交"与"清空了"）。
  assert.deepEqual(normalizeUserOverrides({ serverUrl: '', hostToken: '' }), {
    ok: true,
    value: { serverUrl: undefined, hostToken: undefined },
  })
  assert.deepEqual(normalizeUserOverrides({ serverUrl: '  wss://x.example.com  ' }), {
    ok: true,
    value: { serverUrl: 'wss://x.example.com' },
  })
  // 没提交的那一项**不出现**在返回值里
  assert.deepEqual(normalizeUserOverrides({ hostToken: LONG_ENOUGH }), { ok: true, value: { hostToken: LONG_ENOUGH } })
  /**
   * "key 在"与"key 的值不是 undefined"**不是同一件事**——这条断言就是钉这个差别的。
   *
   * 语义是「key 在 = 用户动过这一项」，所以一个显式 `undefined` 属于
   * "提交了一个不是字符串的东西"（回 400），不是"没提交"。
   * ⚠️ 判法一旦退回 `input.x !== undefined`，这一条就变成 `{ok:true,value:{}}` ⇒ 红。
   * （真实调用方给不出这个形状：路由那边是 `JSON.parse` 出来的对象，
   *   `undefined` 在 JSON 里不存在——所以这条钉的是**接口语义**，不是某个调用点。）
   */
  const explicitUndefined = normalizeUserOverrides({ serverUrl: undefined })
  assert.equal(explicitUndefined.ok, false, '显式 undefined 不许被当成"没提交"')
  assert.equal(explicitUndefined.ok === false && explicitUndefined.field, 'serverUrl')
  for (const bad of ['http://x', 'x.example.com', 42]) {
    const result = normalizeUserOverrides({ serverUrl: bad })
    assert.equal(result.ok, false, `${JSON.stringify(bad)} 不该被接受`)
    assert.equal(result.ok === false && result.field, 'serverUrl')
  }
  const tooLong = normalizeUserOverrides({ hostToken: 'x'.repeat(257) })
  assert.equal(tooLong.ok, false, '整段粘贴进来的东西要拦住（上限 256）')
})

test('落盘：0600、能读回来、没提交的项不写进文件', POSIX_ONLY, () => {
  const dir = tempDir()
  try {
    const file = resolveUserConfigFile(path.join(dir, 'status.json'))
    assert.equal(file, path.join(dir, 'user-config.json'))
    assert.equal(writeUserConfig(file, { serverUrl: 'wss://self.example.com' }, 1234), true)
    assert.equal(statSync(file).mode & 0o777, 0o600, '文件里可能有 token：权限位必须是 0600')
    assert.deepEqual(readUserConfig(file), { serverUrl: 'wss://self.example.com' })
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(raw.savedAt, 1234, 'savedAt 是排错面（"这一栏什么时候改的"）')
    assert.ok(!('hostToken' in raw), '没提交的那一项不许在文件里留一个空壳')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('坏文件只坏一项，绝不抛：坏 JSON / 不认识的结构 / 手改坏的单项', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'user-config.json')
    assert.deepEqual(readUserConfig(file), {}, '文件不存在（绝大多数用户）是空')
    writeFileSync(file, '{oops')
    assert.deepEqual(readUserConfig(file), {})
    writeFileSync(file, JSON.stringify({ hello: 'world' }))
    assert.deepEqual(readUserConfig(file), {})
    // 地址被手改坏、口令还是好的 ⇒ **口令要留下**（整份丢弃会让用户"两个都要重填"）
    writeFileSync(
      file,
      JSON.stringify({ version: 1, serverUrl: 'http://被手改坏', hostToken: LONG_ENOUGH, savedAt: 1 }),
    )
    assert.deepEqual(readUserConfig(file), { hostToken: LONG_ENOUGH })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置优先级四级：默认值 < 设置页 < patch < 环境变量', () => {
  const overrides = { serverUrl: 'wss://self.example.com', hostToken: 'user-token-user-token-user-token-0000' }
  const patch = { serverUrl: 'wss://patch.example.com', hostToken: 'patch-token-patch-token-patch-token-0' }

  // 只有设置页那一级
  const userOnly = readConfig(undefined, {}, overrides)
  assert.equal(userOnly.serverUrl, 'wss://self.example.com', '设置页写的地址要生效')
  assert.equal(userOnly.hostToken, overrides.hostToken)

  // 设置页 < patch：**手写 patch 的人说了算**（自部署的常态）
  const patched = readConfig(patch, {}, overrides)
  assert.equal(patched.serverUrl, 'wss://patch.example.com', 'patch 必须压过设置页那一栏')
  assert.equal(patched.hostToken, patch.hostToken)

  // patch < 环境变量
  const fromEnv = readConfig(patch, { DRC_SERVER_URL: 'wss://env.example.com', DRC_HOST_TOKEN: LONG_ENOUGH }, overrides)
  assert.equal(fromEnv.serverUrl, 'wss://env.example.com')
  assert.equal(fromEnv.hostToken, LONG_ENOUGH)

  // 一级都没有 ⇒ 官方默认
  assert.equal(readConfig(undefined, {}, {}).serverUrl, DEFAULT_CONFIG.serverUrl)
})

test('官方默认值就是"装完就能用"那一枚：wss 的官方中继，不是本机回环', () => {
  /**
   * ⚠️ 这条钉的是**产品默认值**（2026-10-11 用户裁决）：旧默认值是 `ws://127.0.0.1:8787`
   * —— 只有恰好在本机跑着中继的人才能连上，对下载插件的绝大多数人来说，
   * 那个默认值的真实含义是"配完也不通"（原话：下载下来发现不能用，直接就卸载了）。
   *
   * 变异：把默认值改回 `ws://127.0.0.1:8787` ⇒ 立刻红。
   */
  assert.equal(DEFAULT_CONFIG.serverUrl, 'wss://drc.provid.cc')
  assert.match(DEFAULT_CONFIG.serverUrl, /^wss:\/\//, '必须是 wss：明文 ws 到公网会把配对码与密文摆到链路上')
  assert.ok(
    !/127\.0\.0\.1|localhost|\[::1\]/.test(DEFAULT_CONFIG.serverUrl),
    '默认值不许指向回环：那只对"正好在本机跑着中继"的人成立',
  )
})
