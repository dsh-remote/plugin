import test from 'node:test'
import assert from 'node:assert/strict'
import { HostRuntime } from '../src/host-runtime.js'
import type { HarnessBridge } from '../src/bridge.js'
import type { Payload } from '../src/index.js'

/**
 * Event-stream windowing.
 *
 * The host merges streamed deltas inside a short window so a busy turn does
 * not put hundreds of encrypted frames per second on a phone connection. Two
 * properties have to hold, and a regression in either is invisible in
 * production until a user complains:
 *
 *  - merging must never LOSE text (the concatenation is what the user reads);
 *  - a done-only frame (no text) must still be forwarded, because it is the
 *    only signal that the run ended.
 */

/** A bridge whose event source we drive by hand. */
function harness(): { bridge: HarnessBridge; emit: (ev: Payload) => void } {
  let sink: ((ev: Payload) => void) | null = null
  const bridge: HarnessBridge = {
    carrier: 'stub',
    listSessions: async () => [],
    sendPrompt: async () => ({ ok: true }),
    answer: async () => ({ ok: true }),
    resolvePermission: async () => ({ ok: true }),
    interrupt: async () => ({ ok: true }),
    watch(emit) {
      sink = emit
      return () => {
        sink = null
      }
    },
  }
  return { bridge, emit: (ev) => sink?.(ev) }
}

function runtime(): { rt: HostRuntime; emit: (ev: Payload) => void; seen: Payload[] } {
  const { bridge, emit } = harness()
  const rt = new HostRuntime({
    config: {
      serverUrl: 'ws://127.0.0.1:1', // dead port: connects, fails, retries
      hostToken: 'unit-***',
      hostLabel: 'test',
      keepAwakeEnabled: false,
    },
    bridge,
    log: () => {},
  })
  const seen: Payload[] = []
  // no clients are paired in a unit test, so every payload lands in broadcast
  rt.relay.broadcast = (ev: Payload) => {
    seen.push(ev)
  }
  rt.start()
  return { rt, emit, seen }
}

const delta = (text: string, done = false): Payload => ({
  t: 'ev.message_delta',
  sessionId: 's-1',
  messageId: 'm1',
  part: 0,
  delta: text,
  done,
})

test('a delta burst is merged without losing or reordering text', async () => {
  const { rt, emit, seen } = runtime()
  emit(delta('段0'))
  emit(delta('段1'))
  emit(delta('段2'))
  await new Promise((r) => setTimeout(r, 260)) // longer than the flush window

  const merged = seen.filter((e) => e.t === 'ev.message_delta')
  assert.equal(merged.length, 1, 'three deltas inside one window become one frame')
  assert.equal((merged[0] as { delta: string }).delta, '段0段1段2')
  rt.stop()
})

test('a done marker arriving with text rides along in one frame', async () => {
  const { rt, emit, seen } = runtime()
  emit(delta('答案'))
  emit(delta('', true))
  await new Promise((r) => setTimeout(r, 260))

  const frames = seen.filter((e) => e.t === 'ev.message_delta') as Array<{ delta: string; done?: boolean }>
  assert.equal(frames.length, 1, 'still inside the window, so it merges')
  assert.equal(frames[0]!.delta, '答案')
  assert.equal(frames[0]!.done, true, 'the terminal flag must survive the merge')
  rt.stop()
})

test('a standalone done-only frame is forwarded, not swallowed', async () => {
  // Regression guard: flushDelta used to start with `if (!entry.text) return`,
  // which silently dropped the empty-text frame that `turn/end` produces. The
  // phone then never learned the run had finished and spun forever — the bug
  // only showed up against the real kernel, never with the mock.
  const { rt, emit, seen } = runtime()
  emit(delta('答案'))
  await new Promise((r) => setTimeout(r, 260)) // window elapses: text goes out alone
  emit(delta('', true))
  await new Promise((r) => setTimeout(r, 260))

  const frames = seen.filter((e) => e.t === 'ev.message_delta') as Array<{ delta: string; done?: boolean }>
  assert.equal(frames.length, 2, 'the done marker needs its own frame here')
  assert.equal(frames[0]!.delta, '答案')
  assert.equal(frames[1]!.delta, '')
  assert.equal(frames[1]!.done, true)
  rt.stop()
})

test('a non-delta event flushes the buffer first, so order is preserved', async () => {
  const { rt, emit, seen } = runtime()
  emit(delta('前半'))
  emit({ t: 'ev.tool_event', sessionId: 's-1', callId: 'c1', tool: 'bash', phase: 'started' })
  emit(delta('后半'))
  await new Promise((r) => setTimeout(r, 260))

  const kinds = seen.map((e) => e.t)
  assert.deepEqual(kinds, ['ev.message_delta', 'ev.tool_event', 'ev.message_delta'])
  assert.equal((seen[0] as { delta: string }).delta, '前半')
  assert.equal((seen[2] as { delta: string }).delta, '后半')
  rt.stop()
})

test('stopping flushes whatever is still buffered', async () => {
  const { rt, emit, seen } = runtime()
  emit(delta('尾巴'))
  rt.stop() // before the window elapses
  const frames = seen.filter((e) => e.t === 'ev.message_delta')
  assert.equal(frames.length, 1)
  assert.equal((frames[0] as { delta: string }).delta, '尾巴')
})
