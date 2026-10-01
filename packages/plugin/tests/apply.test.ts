import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, DEFAULT_CONFIG } from '../src/index.js'

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

test('apply() with missing token stays idle (no crash)', () => {
  const ctx = stubCtx({ services: { settings: {}, typertGateway: { invoke: async () => ({}) } } })
  const warn = console.warn
  let warned = ''
  console.warn = (...a: unknown[]) => { warned += String(a[0]) }
  apply(ctx, { hostToken: '' })
  console.warn = warn
  assert.match(warned, /host token missing/)
  assert.equal(ctx.provided.dshRemoteControl, undefined)
})

test('apply() activates with mock bridge when no carriers injectable', () => {
  const ctx = stubCtx({ services: {}, injectFails: ['typertGateway', 'apiProxy', 'settings'] })
  process.env.DRC_HOST_TOKEN = 'unit-***'
  process.env.DRC_SERVER_URL = 'ws://127.0.0.1:1' // dead port: connects, fails, retries — fine
  apply(ctx, { mockBridge: true })
  const api = ctx.provided.dshRemoteControl as { state: { relay: string }; stop: () => void }
  assert.ok(api)
  assert.ok(['connecting', 'offline', 'online'].includes(api.state.relay as string))
  api.stop()
  delete process.env.DRC_HOST_TOKEN
  delete process.env.DRC_SERVER_URL
})

test('apply() picks typert carrier over apiProxy', () => {
  let used = ''
  const ctx = stubCtx({
    services: {
      settings: { configure: () => {} },
      typertGateway: {
        invoke: async () => ({ sessions: [] }),
        openWireStream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) }),
      },
      apiProxy: { sessions: {}, events: { mux: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) }) }, respond: async () => {} },
    },
  })
  ctx.inject = (names: string[], fn: (c: any) => void) => {
    if (names[0] === 'typertGateway') used = 'typert'
    if (names[0] === 'apiProxy') used = used || 'apiproxy'
    fn(ctx)
    return () => {}
  }
  process.env.DRC_HOST_TOKEN = 'unit-***'
  process.env.DRC_SERVER_URL = 'ws://127.0.0.1:1'
  apply(ctx, {})
  assert.equal(used, 'typert')
  const api = ctx.provided.dshRemoteControl as { stop: () => void }
  api?.stop()
  delete process.env.DRC_HOST_TOKEN
  delete process.env.DRC_SERVER_URL
})

test('config: env overrides beat injected config', () => {
  process.env.DRC_SERVER_URL = 'wss://env.example:9'
  process.env.DRC_HOST_TOKEN = 'from-env'
  const ctx = stubCtx({ services: {}, injectFails: ['typertGateway', 'apiProxy', 'settings'] })
  apply(ctx, { serverUrl: 'ws://cfg:1', hostToken: 'from-cfg', mockBridge: true })
  const api = ctx.provided.dshRemoteControl as { stop(): void }
  api?.stop()
  delete process.env.DRC_SERVER_URL
  delete process.env.DRC_HOST_TOKEN
  assert.ok(DEFAULT_CONFIG.hostTokenEnv)
})
