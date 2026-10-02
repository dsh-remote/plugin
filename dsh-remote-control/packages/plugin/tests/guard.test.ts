/**
 * guard.test — `platform/guard.ts`：订阅的唯一入口。
 *
 * 守的是"插件绝不许崩宿主"这条总则下最贵的一起事故（docs/DESIGN.md §7 阶段 C 第 ② 条）：
 * 旧插件为了可观测性订阅了 `agent/request`（一条 **waterfall**），监听器返回 undefined
 * 就把整条链的结果冲掉了，于是宿主内核进程里**每一个 turn 都崩**，
 * 报 `Cannot read properties of undefined (reading 'provider')`，连桌面 UI 人工发消息也一起崩
 * （取证 docs/legacy-spec/host-plugin-cordis.md §2.1、HANDOFF.md §4.4，
 * 崩溃点 `@deepseek-ai/dsh-agent-loop/lib/index.js:685-691`）。
 *
 * 因此本文件有两条"自校验"：白名单与 waterfall 清单的交集必须为空，
 * 以及旧黑名单里那两个真出过事的名字必须仍在拒绝列表里。
 * 白名单的意义在于"宿主代际升级后不会静默失效"（旧实现是 13 项黑名单，缺一个就漏一个）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SUBSCRIBABLE_EVENTS,
  WATERFALL_EVENTS,
  WATERFALL_PARTICIPANTS,
  canParticipate,
  canSubscribe,
  guardedSubscribe,
} from '../src/platform/guard.js'

type Listener = (payload: never) => void

interface Bus {
  /** cordis 的 `on()`：返回值可能是退订函数，也可能没有（要靠 `off()`）。 */
  on(name: string, listener: Listener): unknown
  off?(name: string, listener: Listener): void
  readonly registered: string[]
  readonly warns: Array<{ message: string; fields?: Record<string, string | number | boolean> }>
}

/** 一个最小的事件注册口替身：只记录"有没有把订阅透下去"。 */
function makeBus(options: { throwOn?: string; disposer?: boolean } = {}): Bus {
  const registered: string[] = []
  const warns: Bus['warns'] = []
  const offed: string[] = []
  const bus: Bus = {
    registered,
    warns,
    on(name: string, listener: Listener): unknown {
      if (options.throwOn === name) throw new Error(`宿主不认识事件 ${name}`)
      registered.push(name)
      if (options.disposer === false) return undefined
      return () => {
        offed.push(name)
      }
    },
    off(name: string, _listener: Listener) {
      offed.push(name)
    },
  }
  ;(bus as unknown as { offed: string[] }).offed = offed
  return bus
}

const warnOf =
  (bus: Bus) =>
  (message: string, fields?: Record<string, string | number | boolean>): void => {
    bus.warns.push({ message, ...(fields === undefined ? {} : { fields }) })
  }

test('白名单非空且含 session/event：少一个名字就少一类推送能力', () => {
  assert.ok(SUBSCRIBABLE_EVENTS.length >= 1, '白名单是空的：那就等于"什么都订阅不到"，手机上永远没有输出')
  for (const name of ['session/event', 'session/created', 'agent/status', 'agent/error']) {
    assert.equal(canSubscribe(name), true, `${name} 必须在白名单里（emit-mode，有取证位置）：缺了它手机少一类事件`)
    assert.equal(
      SUBSCRIBABLE_EVENTS.includes(name as (typeof SUBSCRIBABLE_EVENTS)[number]),
      true,
      `${name} 要能在名单本体里查到`,
    )
  }
})

test('白名单外的名字一律拒订，包括三条 waterfall 通道（agent/request、approval/request、llm/stream）', () => {
  for (const name of ['agent/request', 'approval/request', 'llm/stream', 'agent/pre-step', 'system-prompt/assemble']) {
    assert.equal(
      canSubscribe(name),
      false,
      `${name} 是 waterfall：注册即参与，处理器返回 undefined 会把这条链的结果冲掉`,
    )
    const bus = makeBus()
    const unsubscribe = guardedSubscribe((n, l) => bus.on(n, l), name, (() => {}) as Listener, warnOf(bus))
    assert.equal(bus.registered.length, 0, `${name} 被订阅了 → 宿主进程里每一个 turn 都会崩（旧事故形状）`)
    assert.equal(typeof unsubscribe, 'function', '拒订也必须返回一个可调用的退订函数：调用方不该为此判空')
    assert.doesNotThrow(() => unsubscribe(), '空退订函数不许抛')
    assert.equal(bus.warns.length, 1, '拒订必须留下恰好一条告警，否则"为什么收不到"没有答案')
  }
})

test('拼错的、空的、带命名空间前缀的名字一律拒订：白名单不是前缀匹配', () => {
  for (const name of ['', '  ', 'session/events', 'Session/event', 'session/event2', 'session/*', 'any-name']) {
    assert.equal(
      canSubscribe(name),
      false,
      `${JSON.stringify(name)} 不该被放行：黑名单时代的"看起来不像危险名字"就是漏口的来源`,
    )
    const bus = makeBus()
    guardedSubscribe((n, l) => bus.on(n, l), name, (() => {}) as Listener, warnOf(bus))
    assert.equal(bus.registered.length, 0, `${JSON.stringify(name)} 竟然被订阅了`)
  }
})

test('自校验一：白名单与 WATERFALL_EVENTS 的交集必须为空（防止有人顺手往白名单里加一个 waterfall 名字）', () => {
  const overlap = SUBSCRIBABLE_EVENTS.filter((name) => WATERFALL_EVENTS.includes(name))
  assert.deepEqual(
    overlap,
    [],
    `白名单里出现了 waterfall 名字：${JSON.stringify(overlap)} → 这条测试就是为了一次都不让它发生`,
  )
})

test('自校验二：waterfall 清单必须含旧黑名单里真出过事的两个名字，且比旧清单更宽', () => {
  for (const name of ['agent/request', 'agent/pre-step']) {
    assert.equal(
      WATERFALL_EVENTS.includes(name),
      true,
      `${name} 必须留在 waterfall 清单里：它就是那次"每个 turn 都崩"的元凶`,
    )
  }
  assert.ok(
    WATERFALL_EVENTS.length >= 13,
    `waterfall 清单只有 ${WATERFALL_EVENTS.length} 项，比旧实现的 13 项黑名单还窄`,
  )
  for (const name of [
    'approval/request',
    'user-questions/request',
    'llm/stream',
    'system-prompt/assemble',
    'internal/config',
  ]) {
    assert.equal(
      WATERFALL_EVENTS.includes(name),
      true,
      `${name} 是宿主权威表里的 @mode waterfall，必须列出（旧黑名单一项都没有，这就是它静默失效的原因）`,
    )
  }
  assert.equal(
    WATERFALL_EVENTS.filter((name, index) => WATERFALL_EVENTS.indexOf(name) !== index).length,
    0,
    '清单里有重复名字：说明这份表没有对着宿主权威表核过',
  )
})

test('guardedSubscribe 放行白名单内的订阅，并把宿主给的退订函数原样接上', () => {
  const bus = makeBus()
  const seen: unknown[] = []
  const listener = ((payload: unknown) => {
    seen.push(payload)
  }) as Listener
  const unsubscribe = guardedSubscribe((n, l) => bus.on(n, l), 'session/event', listener, warnOf(bus))
  assert.deepEqual(bus.registered, ['session/event'], '白名单内的订阅没有透下去 → 手机收不到任何会话事件')
  assert.equal(bus.warns.length, 0, '正常放行不该告警')

  unsubscribe()
  assert.equal(seen.length, 0, '夹具自检：监听器本身没被调用过')
})

test('宿主 on() 抛异常时必须咽下去：少订阅一个事件只是少一类推送，不该让插件整个不工作', () => {
  const bus = makeBus({ throwOn: 'session/event' })
  let unsubscribe: (() => void) | undefined
  assert.doesNotThrow(() => {
    unsubscribe = guardedSubscribe((n, l) => bus.on(n, l), 'session/event', (() => {}) as Listener, warnOf(bus))
  }, '订阅失败把异常抛了出去 → apply() 的红线破了，用户的 DSH 进程起不来')
  assert.equal(typeof unsubscribe, 'function', '抛异常后也必须返回一个可用的退订函数')
  assert.doesNotThrow(() => unsubscribe?.(), '退订函数不许二次抛')
  assert.equal(bus.warns.length, 1, '订阅失败要留一条告警：否则"为什么没有事件"没有答案')
  assert.equal(String(bus.warns[0]?.fields?.name), 'session/event', '告警要带上事件名，便于对着宿主权威表排查')
})

test('没有退订函数的宿主代际要靠 off() 退订：两条路都要尽力而为且不许抛', () => {
  const bus = makeBus({ disposer: false })
  const listener = (() => {}) as Listener
  // 这一代宿主不给退订函数，只能靠 off()：把 off 挂到可调用对象上才是 guardedSubscribe 认的形状。
  const onWithOff = Object.assign((n: string, l: Listener) => bus.on(n, l), {
    off: (n: string, l: Listener) => bus.off?.(n, l),
  })
  const unsubscribe = guardedSubscribe(onWithOff, 'agent/status', listener, warnOf(bus))
  assert.deepEqual(bus.registered, ['agent/status'], '白名单内必须放行')
  assert.doesNotThrow(() => unsubscribe(), '靠 off() 退订这条路不许抛')
  const offed = (bus as unknown as { offed: string[] }).offed
  assert.deepEqual(
    offed,
    ['agent/status'],
    `没有调用 off() 退订（offed=${JSON.stringify(offed)}）：订阅泄漏会让插件重启后收到双份事件`,
  )

  // 反面对照：调用方只递一个箭头包装（不带 off）时，退订必须静默无害——
  // 但这条路径等于"订阅撤不掉"，是 carrier 侧的接线要求（见回报 BUG-4）。
  const bare = makeBus({ disposer: false })
  const bareOff = guardedSubscribe((n: string, l: Listener) => bare.on(n, l), 'agent/error', listener, warnOf(bare))
  assert.deepEqual(bare.registered, ['agent/error'], '夹具自检：订阅本身要放行')
  assert.doesNotThrow(() => bareOff(), '不带 off 的宿主形状退订时不许抛')
  assert.deepEqual(
    (bare as unknown as { offed: string[] }).offed,
    [],
    '夹具自检：这条路径确实什么都做不了（不是偷偷调了 off）',
  )

  // off 自己抛错也必须咽下去。
  const hostile = makeBus({ disposer: false })
  const hostileOn = Object.assign((n: string, l: Listener) => hostile.on(n, l), {
    off: (): void => {
      throw new Error('这一代 cordis 的 off 会抛')
    },
  })
  const off2 = guardedSubscribe(hostileOn, 'agent/error', listener, warnOf(hostile))
  assert.doesNotThrow(() => off2(), '退订失败抛了出去：进程要走了，退订失败无所谓')
})

test('参与名单是极窄的显式清单：approval/request 允许以参与者身份注册，其它 waterfall 一律不许', () => {
  assert.deepEqual(
    [...WATERFALL_PARTICIPANTS],
    ['approval/request'],
    '参与名单只能有这一条：审批要想到达手机只能参与这条 waterfall',
  )
  assert.equal(
    canParticipate('approval/request'),
    true,
    'approval/request 必须允许参与：它是 emit-mode 替代通道不存在的情况下唯一的路',
  )
  for (const name of [
    'agent/request',
    'llm/stream',
    'user-questions/request',
    'session/event',
    'system-prompt/assemble',
  ]) {
    assert.equal(canParticipate(name), false, `${name} 不许被"参与"：那是把观察代码写成链上的一环`)
  }
  assert.equal(canParticipate(''), false, '空名字不许放行')
})

test('canSubscribe 与 canParticipate 是两件不同的事：白名单不含审批，但审批必须能参与', () => {
  assert.equal(canSubscribe('approval/request'), false, '观测订阅仍然禁止（否则 undefined 会冲掉 outcome）')
  assert.equal(
    canParticipate('approval/request'),
    true,
    '但参与者通道必须打开，否则手机永远收不到审批卡：审批只会在桌面 UI 里被决定',
  )
  assert.equal(canSubscribe('session/event'), true, 'session/event 是 emit-mode 观测通道，必须在白名单里')
  assert.equal(canParticipate('session/event'), false, '观测事件不许被当成参与者：approval 的 outcome 语义不适用于它')
})

test('拒订的告警要如实标出"这是 waterfall"：让排错的人一眼看到为什么不给订', () => {
  const bus = makeBus()
  guardedSubscribe((n, l) => bus.on(n, l), 'agent/request', (() => {}) as Listener, warnOf(bus))
  assert.equal(bus.warns.length, 1, '没有留下告警')
  assert.equal(bus.warns[0]?.message, 'refusing to subscribe', `告警文案是 ${String(bus.warns[0]?.message)}`)
  assert.equal(bus.warns[0]?.fields?.waterfall, true, 'fields.waterfall 必须为 true：这是"为什么拒订"的直接答案')
  assert.equal(bus.warns[0]?.fields?.name, 'agent/request', '要带上被拒的事件名')

  const other = makeBus()
  guardedSubscribe((n, l) => other.on(n, l), 'totally/unknown', (() => {}) as Listener, warnOf(other))
  assert.equal(
    other.warns[0]?.fields?.waterfall,
    false,
    '不在 waterfall 清单里的名字要如实报 false：否则会误以为已知风险',
  )
})
