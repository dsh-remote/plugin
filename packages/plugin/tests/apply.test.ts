import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, DEFAULT_CONFIG, validateConfig } from '../src/index.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** minimal cordis-like context stub for activation tests */
function stubCtx(opts: {
  services?: Record<string, unknown>
  injectFails?: string[]
}) {
  const provided: Record<string, unknown> = {}
  const effects: Array<() => void> = []
  const injectCalls: string[][] = []
  const ctx: any = {
    fiber: {},
    get(name: string, optional?: boolean) {
      const v = opts.services?.[name]
      if (v === undefined && !optional) throw new Error(`missing service ${name}`)
      return v
    },
    inject(names: string[], fn: (c: any) => void) {
      injectCalls.push(names)
      if (opts.injectFails?.includes(names[0]!)) throw new Error('inject unavailable')
      // synchronous activation for the stub
      fn(ctx)
      return () => {}
    },
    provide(name: string, value: unknown) {
      provided[name] = value
    },
    effect(fn: () => void) {
      effects.push(fn)
    },
    provided,
    effects,
    injectCalls,
  }
  return ctx
}

/**
 * Set env vars for one test and restore them afterwards.
 *
 * Registered through `t.after`, so a FAILED assertion can no longer leak a
 * token into the next test — which is exactly how a single real failure used
 * to cascade into two bogus ones.
 */
function useDrcEnv(t: { after(fn: () => void): void }, vars: Record<string, string>): void {
  const before = { ...process.env }
  for (const [k, v] of Object.entries(vars)) process.env[k] = v
  t.after(() => {
    for (const k of Object.keys(vars)) delete process.env[k]
    for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v
    else delete process.env[k]
  })
}

test('apply() with missing token stays idle (no crash)', () => {
  const ctx = stubCtx({ services: { settings: {}, typertGateway: { invoke: async () => ({}) } } })
  const warn = console.warn
  let warned = ''
  console.warn = (...a: unknown[]) => { warned += String(a[0]) }
  apply(ctx, { hostToken: '', statusFile: '' })
  console.warn = warn
  assert.match(warned, /hostToken/)
  assert.match(warned, /missing/)
  assert.equal(ctx.provided.dshRemoteControl, undefined)
})

test('apply() activates with mock bridge when no carriers injectable', (t) => {
  const ctx = stubCtx({ services: {}, injectFails: ['sessions', 'typertGateway', 'apiProxy', 'settings'] })
  // dead port: connects, fails, retries — fine
  useDrcEnv(t, { DRC_HOST_TOKEN: 'unit-***', DRC_SERVER_URL: 'ws://127.0.0.1:1' })
  apply(ctx, { mockBridge: true, statusFile: '' })
  const api = ctx.provided.dshRemoteControl as { state: { relay: string }; stop: () => void }
  assert.ok(api)
  assert.ok(['connecting', 'offline', 'online'].includes(api.state.relay as string))
  api.stop()
})

test('apply() prefers the in-process platform services over any wire carrier', (t) => {
  // A plugin runs inside the Harness, so ctx.sessions / ctx.agents are the
  // direct, documented API — no wire protocol, no endpoint names. This is what
  // the official @deepseek-ai/dsh-host-apiproxy itself uses.
  const dir = mkdtempSync(join(tmpdir(), 'drc-svc-'))
  const file = join(dir, 'status.json')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = stubCtx({
    services: {
      settings: { configure: () => {} },
      sessions: { list: () => [{ id: 'session-1', header: { cwd: '/tmp/w', title: '真实会话' } }] },
      agents: { get: () => ({ status: 'idle' }) },
      typertGateway: {
        openWireStream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) }),
      },
    },
  })
  useDrcEnv(t, { DRC_HOST_TOKEN: 'unit-***', DRC_SERVER_URL: 'ws://127.0.0.1:1' })
  apply(ctx, { statusFile: file })
  const status = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(status.carrier, 'services', 'in-process services win')
  assert.equal(status.bridge.services.hasSessionsList, true)
  ;(ctx.provided.dshRemoteControl as { stop(): void } | undefined)?.stop()
})

test('typert is still used when apiProxy is absent (after the grace period)', async (t) => {
  const ctx = stubCtx({
    services: {
      typertGateway: {
        invoke: async () => ({}),
        openWireStream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) }),
      },
    },
    injectFails: ['sessions', 'apiProxy', 'settings'],
  })
  useDrcEnv(t, {
    DRC_HOST_TOKEN: 'unit-***',
    DRC_SERVER_URL: 'ws://127.0.0.1:1',
    DRC_CARRIER_GRACE_MS: '10',
  })
  apply(ctx, { statusFile: '' })
  // `provide` happens unconditionally, so probe the runtime itself:
  // createPairing() returns null until a runtime exists.
  const api = ctx.provided.dshRemoteControl as { createPairing(t?: number): unknown; stop(): void }
  assert.ok(api, 'the service handle is always provided')
  assert.equal(api.createPairing(60_000), null, 'must NOT start on typert eagerly')

  await new Promise((r) => setTimeout(r, 60))
  const pair = api.createPairing(60_000) as { token: string } | null
  assert.ok(pair && /^\d{6}$/.test(pair.token), 'typert fallback should start after the grace period')
  api.stop()
})

test('validateConfig: only unusable settings block startup', () => {
  const base = { ...DEFAULT_CONFIG, keepAwake: { ...DEFAULT_CONFIG.keepAwake } }
  const fields = (cfg: typeof base) => validateConfig(cfg).map((p) => `${p.field}:${p.severity}`)

  assert.deepEqual(fields(base), ['hostToken:error'], 'default config has no token')

  assert.deepEqual(
    fields({ ...base, hostToken: 'x'.repeat(48), serverUrl: 'ws://127.0.0.1:8787' }),
    [],
    'a good config has no problems at all',
  )

  assert.deepEqual(
    fields({ ...base, hostToken: 'short', serverUrl: 'ws://127.0.0.1:8787' }),
    ['hostToken:warn'],
    'a short token is a warning, not a blocker',
  )

  assert.deepEqual(
    fields({ ...base, hostToken: 'x'.repeat(48), serverUrl: 'http://nope' }),
    ['serverUrl:error'],
    'a non-ws URL is fatal',
  )

  assert.deepEqual(
    fields({ ...base, hostToken: 'x'.repeat(48), serverUrl: 'ws://drc.example.com' }),
    ['serverUrl:warn'],
    'plaintext to a remote host is warned about',
  )

  assert.ok(
    validateConfig({ ...base, hostToken: 'x'.repeat(48), serverUrl: 'ws://127.0.0.1:8787', keepAwake: { ...base.keepAwake, idleReleaseSec: Number.NaN } })
      .some((p) => p.field === 'keepAwake.idleReleaseSec' && p.severity === 'warn'),
    'NaN idleReleaseSec is reported',
  )
})

test('apply() never throws, even with a hostile context', () => {
  const ctx: any = {
    get() { throw new Error('no services here') },
    inject() { throw new Error('inject unsupported') },
    provide() { throw new Error('provide unsupported') },
    effect() { throw new Error('effect unsupported') },
  }
  const warn = console.warn
  console.warn = () => {}
  let threw = false
  try {
    apply(ctx, { hostToken: 'x'.repeat(48), serverUrl: 'ws://127.0.0.1:1', mockBridge: true, statusFile: '' })
  } catch {
    threw = true
  }
  console.warn = warn
  assert.equal(threw, false, 'a broken host context must not propagate an exception')
})

test('config: env overrides beat injected config', (t) => {
  useDrcEnv(t, { DRC_SERVER_URL: 'wss://env.example:9', DRC_HOST_TOKEN: 'from-env' })
  const ctx = stubCtx({ services: {}, injectFails: ['sessions', 'typertGateway', 'apiProxy', 'settings'] })
  apply(ctx, { serverUrl: 'ws://cfg:1', hostToken: 'from-cfg', mockBridge: true, statusFile: '' })
  const api = ctx.provided.dshRemoteControl as { stop(): void }
  api?.stop()
  assert.ok(DEFAULT_CONFIG.hostTokenEnv)
})

test('status file reports the carrier so ops can tell dsh from mock', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'drc-status-'))
  const file = join(dir, 'status.json')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = stubCtx({ services: {}, injectFails: ['sessions', 'typertGateway', 'apiProxy', 'settings'] })
  useDrcEnv(t, { DRC_HOST_TOKEN: 'x'.repeat(48), DRC_SERVER_URL: 'ws://127.0.0.1:1' })
  apply(ctx, { mockBridge: true, statusFile: file })
  const status = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(status.carrier, 'mock', 'no injectable carrier => mock bridge')
  assert.equal(status.serverUrl, 'ws://127.0.0.1:1')
  assert.equal(typeof status.updatedAt, 'string')
  assert.equal(status.hostToken, undefined, 'the status file must never contain the token')
  ;(ctx.provided.dshRemoteControl as { stop(): void } | undefined)?.stop()
})

test('status file explains an invalid config instead of failing silently', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'drc-status-'))
  const file = join(dir, 'status.json')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // this test is about "no token at all", so it must not inherit one
  delete process.env.DRC_HOST_TOKEN
  const ctx = stubCtx({ services: {} })
  const warn = console.warn
  console.warn = () => {}
  try {
    apply(ctx, { hostToken: '', statusFile: file })
  } finally {
    console.warn = warn
  }
  const status = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(status.carrier, 'none')
  assert.equal(status.reason, 'invalid-config')
  assert.ok(status.problems.some((p: string) => p.startsWith('hostToken')))
})
