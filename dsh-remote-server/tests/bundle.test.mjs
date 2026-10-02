/**
 * 部署产物测试：`dist/bundle/main.js` 必须是一个**自包含、不含密码学代码**的单文件。
 *
 * 这两条都是"结构性"保证，比"代码里没调用"强：
 * - 不含密码学：协议层标了 `sideEffects:false`，中继只 import `frames`/`ids`，
 *   所以 tree-shaking 之后产物里根本没有 secretbox/xsalsa20 的实现——
 *   零知识不是纪律，是依赖图上不可达。
 * - 自包含：拷到一个空目录（没有 node_modules）也能跑起来并应答 `/healthz`，
 *   于是生产部署退化成"scp 一个文件 + systemctl restart"，
 *   少一步 `npm install`，也就少一类"服务器上的依赖树和 CI 不一样"的故障。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const BUNDLE = new URL('../dist/bundle/main.js', import.meta.url).pathname
/** 按包名解析协议包，而不是写死它在工作区里的相对路径——这里是独立仓，只有 node_modules。 */
const require = createRequire(import.meta.url)

test('产物里没有任何密码学实现（零知识在依赖图上成立）', () => {
  const source = readFileSync(BUNDLE, 'utf8')
  for (const marker of ['xsalsa20', 'secretbox', 'tweetnacl', 'nacl_verify', 'salsa20', 'poly1305']) {
    assert.ok(!new RegExp(marker, 'i').test(source), `产物里出现了 ${marker} —— 中继不该带密码学`)
  }
  // 反向确认它确实是需要的那个东西，而不是一个空壳。
  assert.match(source, /pair-begin-client/)
  assert.match(source, /\/healthz/)
  assert.match(source, /dsh-rc|WebSocket/)
  const kb = Math.round(statSync(BUNDLE).size / 1024)
  assert.ok(kb < 3_000, `产物 ${kb} KB，超出预期`)
})

test('单文件在没有 node_modules 的空目录里能启动、应答健康检查并优雅退出', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-relay-'))
  const target = path.join(dir, 'relay.mjs')
  copyFileSync(BUNDLE, target)
  const child = spawn(process.execPath, [target], {
    cwd: dir,
    env: {
      ...process.env,
      DRC_HOST_TOKEN: 'bundle-smoke-token-0123456789abcdef',
      DRC_PORT: '0',
      DRC_BIND: '127.0.0.1',
      DRC_LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = []
  let resolvePort
  const portReady = new Promise((resolve, reject) => {
    resolvePort = resolve
    child.on('exit', (code) => reject(new Error(`提前退出 code=${String(code)}：${lines.join('\n')}`)))
  })
  const onData = (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue
      lines.push(line)
      try {
        const record = JSON.parse(line)
        if (record.msg === 'relay listening') resolvePort(record.port)
      } catch {
        /* 忽略非 JSON 行 */
      }
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  try {
    const port = await Promise.race([
      portReady,
      sleep(4000).then(() => {
        throw new Error(`没等到启动日志：${lines.join('\n')}`)
      }),
    ])
    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json())
    assert.equal(health.ok, true)
    assert.equal(health.hosts, 0)
    // 断言**具体值**而不是"是个字符串"：单文件部署时旁边没有 package.json，
    // 靠文件探针读版本的实现会静默退化成 `0.0.0`，而旧断言对此完全无感。
    // `/healthz` 的 version 是运维判断"线上跑的是哪一版"的唯一入口。
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(typeof health.version, 'string')
    assert.equal(
      health.version,
      pkg.version,
      `产物报的版本是 ${String(health.version)}，包版本是 ${pkg.version}：版本号没在打包时注入`,
    )
    assert.match(readFileSync(BUNDLE, 'utf8'), new RegExp(`"${pkg.version}"`), 'define 没有真的落进产物')

    const exitCode = new Promise((resolve) => child.on('exit', resolve))
    child.kill('SIGTERM')
    assert.equal(await Promise.race([exitCode, sleep(3000).then(() => 'timeout')]), 0, '优雅停机必须 exit 0')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})

test('协议包声明 sideEffects:false —— 上面那条零知识保证的前提', () => {
  const pkg = JSON.parse(readFileSync(require.resolve('dsh-remote-wire/package.json'), 'utf8'))
  assert.equal(pkg.sideEffects, false, '没有这条，打包器不会把 record/keys 从产物里摇掉')
  assert.ok(!('tweetnacl' in (pkg.dependencies ?? {})) === false, 'tweetnacl 仍是协议包的运行时依赖（插件要用）')
})
