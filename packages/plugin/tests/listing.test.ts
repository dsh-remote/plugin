import test from 'node:test'
import assert from 'node:assert/strict'
import { DshKernelBridge, resolveAgentFrom, WATERFALL_EVENTS, type InProcServices } from '../src/adapter-dsh.js'

/**
 * Session listing + agent resolution.
 *
 * These two behaviours were the difference between "the phone shows an empty
 * list" and a working remote: `ctx.sessions.list()` only knows what THIS
 * process has loaded, and an agent whose loop carries no model dies inside
 * `prepareRequest` with "reading 'provider'". Both are covered here so a
 * regression shows up in `pnpm test` instead of on a phone.
 */

function fakeServices(over: Partial<InProcServices> = {}): InProcServices {
  return {
    sessions: {
      list: () => [],
      get: () => undefined,
    },
    ...over,
  }
}

/** `describe()` is diagnostics-shaped; narrow it for assertions. */
function describeOf(bridge: DshKernelBridge): {
  services: Record<string, unknown> & { hasSessionQuery?: boolean; listingSource?: string }
  lastError: unknown
} {
  return bridge.describe() as never
}

test('listing prefers the persisted corpus and marks detached sessions', async () => {
  const calls: string[] = []
  const services = fakeServices({
    sessions: { list: () => [{ id: 'live-1', header: {} }], get: () => undefined },
    sessionQuery: {
      listSessions: async () => {
        calls.push('sessionQuery')
        return [
          { header: { id: 'cold-1', createdAt: 1_700_000_000_000, cwd: '/w/a' }, live: false, persisted: true },
          { header: { id: 'live-1', createdAt: 1_700_000_500_000, cwd: '/w/b' }, live: true, persisted: true },
        ]
      },
      readTitleSnapshots: async (ids: readonly string[]) =>
        ids.map((sessionId) => ({
          sessionId,
          status: 'fulfilled' as const,
          value: { title: { title: 'title-' + sessionId, updatedAt: 1_700_000_600_000 } },
        })),
    },
    agents: { get: (id: string) => (id === 'live-1' ? { status: 'running' } : undefined) },
  })

  const bridge = new DshKernelBridge({ services, log: () => {} })
  const list = await bridge.listSessions()

  assert.deepEqual(calls, ['sessionQuery'], 'ctx.sessionQuery is the listing surface')
  assert.equal(list.length, 2)
  assert.deepEqual(
    list.map((s) => s.id),
    ['live-1', 'cold-1'],
    'newest first',
  )

  const cold = list.find((s) => s.id === 'cold-1')!
  assert.equal(cold.state, 'detached', 'persisted-but-unloaded is openable, not missing')
  assert.equal(cold.workspace, '/w/a')
  assert.equal(cold.title, 'title-cold-1')

  const live = list.find((s) => s.id === 'live-1')!
  assert.equal(live.state, 'running')
  assert.equal(live.running, true)
  assert.equal(live.updatedAt, new Date(1_700_000_600_000).toISOString())
  const desc = describeOf(bridge)
  assert.equal(desc.services.hasSessionQuery, true)
})

test('listing falls back to ctx.sessions when the corpus read fails', async () => {
  const services = fakeServices({
    sessions: { list: () => [{ id: 'only-live', header: { cwd: '/w' } }], get: () => undefined },
    sessionQuery: {
      listSessions: async () => {
        throw new Error('persistence unreadable')
      },
    },
  })
  const bridge = new DshKernelBridge({ services, log: () => {} })
  const list = await bridge.listSessions()

  assert.deepEqual(
    list.map((s) => s.id),
    ['only-live'],
    'an unreadable corpus degrades to the live store instead of returning nothing',
  )
  const desc = describeOf(bridge)
  assert.match(String(desc.lastError), /persistence unreadable/)
  assert.match(String(desc.services.listingSource), /attached only/)
})

test('a title failure never costs the session list', async () => {
  const services = fakeServices({
    sessionQuery: {
      listSessions: async () => [{ header: { id: 's-1' }, live: false, persisted: true }],
      readTitleSnapshots: async () => {
        throw new Error('log unreadable')
      },
    },
  })
  const bridge = new DshKernelBridge({ services, log: () => {} })
  const list = await bridge.listSessions()

  assert.equal(list.length, 1, 'the row survives without its title')
  assert.equal(list[0]!.title, undefined)
})

test('a modelless live agent is refused with an actionable message', async () => {
  // This is the "本轮运行失败: Cannot read properties of undefined (reading
  // 'provider')" case seen on a real host: a session that never ran a turn.
  const services = fakeServices({
    agents: {
      get: () => ({ session: { requestHeader: () => undefined } }),
    },
    sessionQuery: { listSessions: async () => [] },
  })
  const res = await resolveAgentFrom(services, 'session-cmd')

  assert.equal(res.agent, null, 'refusing beats starting a turn that cannot work')
  assert.match(String(res.note), /no model/i)
})

test('a live agent carrying its own model is used as-is', async () => {
  let resumed = 0
  const agent = { session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'chat' } }) } }
  const services = fakeServices({
    agents: {
      get: () => agent,
      resume: async () => {
        resumed++
        return { agent }
      },
    },
    sessionQuery: { listSessions: async () => [] },
  })
  const res = await resolveAgentFrom(services, 's-1')

  assert.equal(res.agent, agent)
  assert.equal(resumed, 0, 'a usable live agent must not be re-resumed')
})

test('a cold session is resumed with the deployment default model', async () => {
  let seen: Record<string, unknown> | undefined
  const services = fakeServices({
    agents: {
      get: () => undefined,
      resume: async (options: Record<string, unknown>) => {
        seen = options
        return { agent: { id: 'resumed' } }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'chat', reasoningEffort: 'high' }) },
    sessionQuery: { listSessions: async () => [] },
  })
  const res = await resolveAgentFrom(services, 's-cold')

  assert.ok(res.agent, 'a cold session is resumable')
  assert.equal(seen!.resumeSessionId, 's-cold')
  assert.deepEqual(seen!.agentOptions, { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' })
})

test('a resume failure is reported rather than thrown', async () => {
  const services = fakeServices({
    agents: {
      get: () => undefined,
      resume: async () => {
        throw new Error('agent preset unmountable')
      },
    },
    sessionQuery: { listSessions: async () => [] },
  })
  const res = await resolveAgentFrom(services, 's-x')

  assert.equal(res.agent, null)
  assert.match(String(res.note), /agent preset unmountable/)
})

// ── session/event decoding ───────────────────────────────────────────

/** Wire a bridge to a fake bus and return the listener map. */
function wiredBus(services: InProcServices) {
  const listeners = new Map<string, (...a: unknown[]) => void>()
  services.on = (name: string, fn: (...a: unknown[]) => void) => {
    listeners.set(name, fn)
    return () => listeners.delete(name)
  }
  const bridge = new DshKernelBridge({ services, log: () => {} })
  const seen: Array<Record<string, unknown>> = []
  bridge.watch((ev) => seen.push(ev as unknown as Record<string, unknown>))
  const fire = (name: string, ...args: unknown[]) => listeners.get(name)!(...args)
  return { bridge, seen, fire }
}

test('session/event becomes deltas, tool events and a finished run', () => {
  const { seen, fire } = wiredBus(fakeServices())
  const session = { id: 's-1' }
  const post = (type: string, seq: number, data: Record<string, unknown>) =>
    fire('session/event', session, { type, seq, time: 0, data })

  post('turn/start', 1, { turn: 1 })
  post('assistant/message', 4, {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'chain of thought must not ship' },
        { type: 'text', text: 'ok' },
      ],
    },
  })
  post('tool/call', 5, { name: 'bash', callId: 'c1', arguments: { command: 'ls' } })
  post('tool/result', 6, { name: 'bash', callId: 'c1', ok: true, result: 'a\nb' })
  post('turn/end', 9, { turn: 1, reason: { kind: 'completed' } })

  const kinds = seen.map((e) => e.t)
  assert.deepEqual(kinds, [
    'ev.run_state',
    'ev.message_delta',
    'ev.tool_event',
    'ev.tool_event',
    'ev.message_delta',
    'ev.run_state',
  ])

  const delta = seen[1]!
  assert.equal(delta.delta, 'ok', 'only text parts become output')
  assert.equal(delta.done, false)
  assert.equal(delta.sessionId, 's-1')

  assert.equal(seen[2]!.tool, 'bash')
  assert.equal(seen[2]!.phase, 'started')
  assert.equal(seen[3]!.phase, 'completed')

  assert.equal(seen[4]!.done, true, 'the run is closed for the client')
  assert.equal(seen[5]!.state, 'idle')
  assert.equal(seen[5]!.detail, 'completed')
})

test('subagent children are hidden from the listing and refused as targets', async () => {
  const services = fakeServices({
    sessionQuery: {
      listSessions: async () => [
        { header: { id: 'parent-1', createdAt: 2 }, live: false, persisted: true },
        { header: { id: 'child-1', createdAt: 1, origin: 'subagent' }, live: false, persisted: true },
      ],
    },
    agents: { get: () => undefined, resume: async () => ({ agent: { id: 'a' } }) },
  })
  const bridge = new DshKernelBridge({ services, log: () => {} })
  const list = await bridge.listSessions()

  assert.deepEqual(
    list.map((s) => s.id),
    ['parent-1'],
    'a session the host will not hand over must not be offered',
  )
  assert.equal(describeOf(bridge).services.hiddenSubagents, 1, 'but the omission is reported')

  const res = await bridge.sendPrompt('child-1', 'hello')
  assert.equal(res.ok, false)
  assert.match(String(res.message), /subagent/i)
})

// ── waterfall safety ─────────────────────────────────────────────────

test('the bridge never observes a waterfall event', () => {
  // Regression guard for the worst bug this plugin ever had: `ctx.on()` on a
  // cordis WATERFALL registers a participating listener, and a listener that
  // returns undefined erases the value passed down the chain. Subscribing to
  // `agent/request` made `proposedConfig` undefined in
  // `ReactLoopAgent.prepareRequest`, so EVERY turn in the process died with
  // "Cannot read properties of undefined (reading 'provider')" — including
  // turns started from the desktop UI.
  const registered: string[] = []
  const services = fakeServices({
    on: (name: string, fn: (...a: unknown[]) => void) => {
      registered.push(name)
      void fn
      return () => {}
    },
  })
  const bridge = new DshKernelBridge({ services, log: () => {} })
  bridge.watch(() => {})

  assert.ok(registered.length > 0, 'the bridge should observe something')
  for (const name of registered) {
    assert.equal(WATERFALL_EVENTS.has(name), false, `must not observe waterfall "${name}"`)
  }
  assert.ok(WATERFALL_EVENTS.has('agent/request'), 'the denylist must cover the one that bit us')
  assert.ok(WATERFALL_EVENTS.has('agent/pre-step'), 'and the gate that blocks archived sessions')
})

test('a waterfall name reaching the subscribe list is skipped, not registered', () => {
  // Defence in depth: even if someone re-adds one to the list, it must not
  // reach the bus.
  const registered: string[] = []
  const services = fakeServices({
    on: (name: string) => {
      registered.push(name)
      return () => {}
    },
  })
  const bridge = new DshKernelBridge({ services, log: () => {} })
  bridge.watch(() => {})
  assert.equal(registered.includes('agent/request'), false)
})


/** A live agent that carries its own model, so prompting can proceed. */
const liveAgent = {
  session: { requestHeader: () => ({ config: { provider: 'stepfun', model: 'step-5-preview' } }) },
  followup: () => {},
}

function archivable(over: Partial<InProcServices> = {}) {
  const calls: string[] = []
  const services = fakeServices({
    sessionQuery: {
      listSessions: async () => [
        { header: { id: 's-open', createdAt: 2 }, live: false, persisted: true },
        { header: { id: 's-arch', createdAt: 1 }, live: false, persisted: true },
      ],
    },
    agents: { get: (id: string) => (id === 's-arch' ? liveAgent : undefined) },
    workspaceRegistry: {
      get archivedSessionIds() {
        return ['s-arch']
      },
      unarchiveSession: async (id: string) => {
        calls.push('unarchive:' + id)
      },
    },
    ...over,
  })
  return { services, calls }
}

test('an archived session is listed as archived, not as a plain detached row', async () => {
  // The host's archived-session-gate rejects every step of an archived
  // session, so "detached" would be a lie that sends the user chasing a
  // timeout instead of restoring the session.
  const { services } = archivable()
  const bridge = new DshKernelBridge({ services, log: () => {} })
  const list = await bridge.listSessions()

  const archived = list.find((s) => s.id === 's-arch')!
  const open = list.find((s) => s.id === 's-open')!
  assert.equal(archived.state, 'archived')
  assert.equal(open.state, 'detached')
  assert.equal(describeOf(bridge).services.archivedSessions, 1)
})

test('prompting an archived session restores it first', async () => {
  const { services, calls } = archivable()
  const bridge = new DshKernelBridge({ services, log: () => {} })
  await bridge.listSessions() // the archive set is read per call, but warm it anyway

  const res = await bridge.sendPrompt('s-arch', 'hello')
  assert.deepEqual(calls, ['unarchive:s-arch'], 'restore precedes the prompt')
  assert.equal(res.ok, true)
})

test('unarchiveOnPrompt: false refuses instead of mutating the archive', async () => {
  const { services, calls } = archivable()
  const bridge = new DshKernelBridge({ services, unarchiveOnPrompt: false, log: () => {} })

  const res = await bridge.sendPrompt('s-arch', 'hello')
  assert.equal(res.ok, false)
  assert.deepEqual(calls, [], 'the archive set must not be touched')
  assert.match(String(res.message), /archived/i)
})

test('a restore failure is surfaced with its reason', async () => {
  const { services } = archivable({
    workspaceRegistry: {
      archivedSessionIds: ['s-arch'],
      unarchiveSession: async () => {
        throw new Error('persistence record already deleted')
      },
    },
  })
  const bridge = new DshKernelBridge({ services, log: () => {} })

  const res = await bridge.sendPrompt('s-arch', 'hello')
  assert.equal(res.ok, false)
  assert.match(String(res.message), /persistence record already deleted/)
})


