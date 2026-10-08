/**
 * client-bundle.test — 在 vm 里真跑一遍**打出来的** `dist/bundle/client.cjs`。
 *
 * 为什么要在产物上测、而不是 import 源码：这一半真正容易错的地方是**外壳**
 * （`window.__ModuleLoader__.load({id, factory})` 的 id/闭合/导出形状）和
 * "装载之后到底注册了什么"。外壳写错的表现是整页 web boot 失败——真机上要重启应用才看得见，
 * 所以这里用 Node 的 vm 造一个最小的浏览器环境，把产物原样执行：
 *
 *   1. 外壳注册成功、id 与包名一致、导出的是 `{name, inject, apply}`；
 *   2. 状态栏那颗 pill：向装载器拿 react、软探测 `slots`、往 `conversation.composer.dock`
 *      注册；点开是"状态 + 右上角那颗按钮"，再按一次才发码（已配对时那颗按钮是退出配对），
 *      发码后把图与 6 位码画进同一个面板；
 *   3. **任何一条依赖拿不到时只降级成"没有 pill"**：apply 绝不外抛（那会整页起不来），
 *      并且留下一行 warn 说明缺的是哪一样；
 *   4. 发码请求必须带宿主那道守卫要的自定义头（两半的分叉在这里对上）。
 *
 * 2026-10-03 这一半原来还有一条"每 2 秒轮只读路由、把当前码推进右栏"的轮询（连同
 * `inject: ['sidebarRight']`）。右栏方案删除后那些用例一起删了——留下的每条都指着 pill。
 *
 * 这里不测"那颗 pill 好不好看"、也不测"宿主的槽位会不会真的把它画出来"——那是真机验收
 * （配方见伞仓 `docs/HOST-SIDE.md` §6.1）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
/** 真 Date：夹具的假墙钟要从它身上取静态成员（`parse`/`UTC` 等）与构造语义。 */
const RealDate = Date
import {
  PAIR_IMAGE_ROUTE,
  PAIR_MARKER_HEADER,
  PAIR_MARKER_VALUE,
  PAIR_NEW_ROUTE,
  PAIR_STATUS_ROUTE,
  PAIR_UNPAIR_ROUTE,
} from '../src/pill/routes.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(here, '..', 'bundle', 'client.cjs')

interface ClientModule {
  name: string
  inject: string[]
  apply(ctx: unknown): void
}

interface LoadOptions {
  hidden?: boolean
  /** 装载器能不能给出 react。缺省给不出——"最坏只少一颗 pill"那条。 */
  react?: unknown
  /** 软探测能不能拿到 `slots` 这个服务。 */
  slots?: boolean
  /**
   * `slots` 只在 `flushInject()` 之后才"到"——真机就是这个形状：浏览器面 `inject` 声明是空的，
   * 于是 `apply()` 在 web boot 那一刻就跑，而 `slots` 服务还在后面。2026-10-03 删掉右栏之后
   * 那颗 pill 在这台机器上**整颗不出现**，就是被这个形状打中的（旧的假上下文只给同步的 `get`，
   * 所以 262 项全绿也没抓到它）。
   */
  lateSlots?: boolean
  /** `ctx.get` 本身抛不抛：真 cordis 的 Proxy 读一个没声明的服务名就是**抛**。 */
  getThrows?: boolean
  /** `/status` 那条的回答。 */
  status?: Record<string, unknown>
  /** `/status` 回非 200（路由没挂上时真机就是 404）。 */
  statusHttp?: number
  /** `/status` 直接抛（宿主转发层断了）。 */
  statusThrows?: boolean
  /** `/status` 一直不落地——演"宿主卡住"，用来钉 in-flight 守卫。 */
  statusPending?: boolean
  /** `POST /pairing/new` 的回答。 */
  newAnswer?: Record<string, unknown>
  /** `POST /pairing/new` 直接抛（网络断了 / 路由没挂上）。 */
  newThrows?: boolean
  /** `POST /unpair` 的回答。 */
  unpairAnswer?: Record<string, unknown>
  /**
   * `POST /unpair` 回非 200。**要能造这一档**，因为 403 不会让 fetch 抛错：
   * 退出配对这条路原来把回答整个丢掉，于是"守卫拒了"这件事在现场一句都留不下。
   */
  unpairHttp?: number
  /** `POST /unpair` 直接抛。 */
  unpairThrows?: boolean
  /** 预置一份**上一版**的样式表：模拟"宿主热更了这一半、文档没重载"。 */
  staleStyle?: boolean
}

interface Harness {
  module: ClientModule
  /** fetch 收到的 URL。 */
  requests: string[]
  /** 每条 fetch 收到的 `init.signal`——3 秒硬超时的判据（见 `signals()`）。 */
  signals: unknown[]
  /** 被记下来的 console.error。 */
  errors: string[]
  /** 被记下来的 console.warn——pill 那一路的降级说的是 warn，不是 error。 */
  warnings: string[]
  /** 装载到现在创建的节拍个数（pill 挂了才有状态轮询）。 */
  timerCount(): number
  /** **还活着**（没被 clearInterval 掉）的节拍个数：孤儿定时器的判据。 */
  liveTimerCount(): number
  fire(index: number): void
  fireAndFlush(index: number): Promise<void>
  /** pill 注册进槽位时 `register` 收到的入参。 */
  slotRegisters(): Array<{ definition: Record<string, unknown>; component?: () => unknown }>
  /** 只有 `lateSlots` 用：把宿主欠我们的那次 `inject(['slots'], cb)` 回调补上。 */
  flushInject(): void
  /** 把那颗 pill 的挂载点交给它的 ref（= 宿主把它挂进 DOM）。 */
  mountPill(): FakeElement
  /** 同一个 ref 再交一次 null（= 宿主把那颗 pill 卸掉）。 */
  unmountPill(): void
  /** 假 document：点外面与 Escape 这两条要往它身上发事件。 */
  fakeDocument(): FakeDocument
  /**
   * 把假墙钟往前拨若干毫秒，**不打任何节拍**。
   *
   * 用来演后台计时器被节流/冻结的那一段时间：真实浏览器里页面隐藏时 `setInterval`
   * 可能一分钟才醒一次，合上盖子直接停摆，而用户切回来是**立刻**看屏的。
   * 夹具里节拍是手工打的，所以"时间过去了但节拍没响"只能这么造。
   */
  advanceClock(ms: number): void
}

// ── 够用的假 DOM ────────────────────────────────────────────────────
// 只实现那颗 pill 真正用到的成员。写全了反而糟：测的就变成"我自己那套假 DOM 的行为"。
class FakeElement {
  children: FakeElement[] = []
  parent: FakeElement | undefined
  attributes = new Map<string, string>()
  listeners = new Map<string, Array<(event: unknown) => void>>()
  textContent = ''
  className = ''
  src = ''
  type = ''
  tabIndex = 0
  style: Record<string, string> = {}
  focused = 0

  constructor(
    readonly tag: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  appendChild(child: FakeElement): FakeElement {
    child.parent = this
    this.children.push(child)
    return child
  }

  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = undefined
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parent = undefined
    this.children = []
    for (const node of nodes) this.appendChild(node)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name)
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      list.filter((candidate) => candidate !== handler),
    )
  }

  contains(other: unknown): boolean {
    let node: FakeElement | undefined = other as FakeElement
    while (node) {
      if (node === this) return true
      node = node.parent
    }
    return false
  }

  focus(): void {
    this.focused += 1
  }

  /** 触发某类事件；没有监听者就直接红——别让"没接上"伪装成"行为正确"。 */
  emit(type: string, event: unknown = {}): void {
    const list = this.listeners.get(type) ?? []
    assert.ok(list.length > 0, `<${this.tag}> 上没有注册 ${type} 监听器`)
    for (const handler of [...list]) handler(event)
  }

  /** 按 class 找回面板里那一句（比遍历树好读），只在本节点的后代里找。 */
  find(className: string): FakeElement | undefined {
    return this.findAll(className)[0]
  }

  /** 正文那三行都是 `drc-info`：要按键取，不能只取第一行。 */
  findAll(className: string): FakeElement[] {
    const found: FakeElement[] = []
    for (const child of this.children) {
      if (child.className === className) found.push(child)
      found.push(...child.findAll(className))
    }
    return found
  }

  allText(): string {
    return [this.textContent, ...this.children.map((child) => child.allText())].join(' ')
  }
}

class FakeDocument {
  head = new FakeElement('head', this)
  private documentListeners = new Map<string, Array<(event: unknown) => void>>()
  /** `staleStyle` 用：预置的旧 `<style>`，让 `querySelector` 认得出"插过了"。 */
  seededStyle?: FakeElement

  constructor(readonly visibilityState: string) {}

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this)
  }

  /** 样式探针：默认返回"没注入过"；`seededStyle` 时返回那份**上一版**的样式表。 */
  querySelector(selector: string): FakeElement | null {
    if (this.seededStyle && selector.includes('data-plugin-css')) return this.seededStyle
    return null
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.documentListeners.get(type) ?? []
    list.push(handler)
    this.documentListeners.set(type, list)
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.documentListeners.get(type) ?? []
    this.documentListeners.set(
      type,
      list.filter((candidate) => candidate !== handler),
    )
  }

  emit(type: string, event: unknown): void {
    for (const handler of [...(this.documentListeners.get(type) ?? [])]) handler(event)
  }

  listenerCount(type: string): number {
    return (this.documentListeners.get(type) ?? []).length
  }
}

/** 把跨 realm 的 promise 链推完（pill 那一轮有 fetch / json / 写 DOM 好几段 await）。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * **未配对时点一下那颗 pill 就够了**（2026-10-04 改的）：直接进二维码页，
 * 中间那一屏"先按一颗「生成配对码」才出码"已经删掉。
 *
 * 所以这个 helper 现在只做一件事：点开 + 让那次自动发码的回答落地。
 * 它仍然必须 `await flush()`——不 flush 就是在断言"面板停在 loading 上"，
 * 那条会让所有"看 QR / 看 6 位码 / 看倒计时"的断言假绿。
 */
async function openPairing(root: FakeElement): Promise<void> {
  root.find('drc-pill')!.emit('click')
  await flush()
}

/** 一颗够用的假 react：这一半只用 createElement。 */
const FAKE_REACT = {
  createElement: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
}

/** `/status` 那条的默认回答：在线、一台都没配上。 */
const DEFAULT_STATUS = {
  relay: 'online',
  paired: 0,
  pairings: 0,
  serverUrl: 'wss://relay.example.com:443/relay',
  version: '0.0.0-test',
  waiting: 0,
  waitingOldestSec: 0,
}

function load(options: LoadOptions = {}): Harness {
  const requests: string[] = []
  const signals: unknown[] = []
  const errors: string[] = []
  const warnings: string[] = []
  /**
   * 节拍要**记下 id 并且真的清掉**（原来 `clearInterval: () => {}` 是个空实现，
   * 于是"离开二维码那一屏 / 关面板 / 卸载之后定时器有没有清"这件事完全没测——
   * 2026-10-06 修）。`timerCount()` 仍然数"创建过几个"（老断言的语义），
   * 还活着的用 `liveTimerCount()`。
   */
  const timers: Array<{ id: number; callback: () => void; cleared: boolean }> = []
  /**
   * 假墙钟。**必须给**：`pill.ts` 里倒计时读的是 `Date.now()`，而 vm 上下文自带的是真
   * `Date`，测试没法推进它——于是"后台冻结两分钟"这种时序在夹具里根本演不出来，
   * 而那正是 2026-10-07 审出的倒计时漂移的现场形状。
   */
  let clockMs = 1_700_000_000_000
  const slotRegisters: Array<{ definition: Record<string, unknown>; component?: () => unknown }> = []
  const doc = new FakeDocument(options.hidden ? 'hidden' : 'visible')
  if (options.staleStyle) {
    const seeded = doc.createElement('style')
    seeded.setAttribute('data-plugin-css', 'dsh-remote-control/pill.css')
    seeded.textContent = '.drc-pill { color: red } /* 上一版的样式 */'
    doc.head.appendChild(seeded)
    doc.seededStyle = seeded
  }
  let spec: { id?: string; factory?: (require: unknown) => ClientModule } | undefined

  const sandbox: Record<string, unknown> = {
    console: {
      error: (message: unknown) => errors.push(String(message)),
      warn: (message: unknown) => warnings.push(String(message)),
      log: () => {},
    },
    document: doc,
    /**
     * 只换掉 `Date.now`：这一半只用它读"这张码什么时候到期"，而判据要能**推进**时间。
     * 其余（构造、`parse`、`UTC`…）原样转发到真 Date —— 这一行是给将来用的保险，
     * 不是这次要测的东西。
     */
    Date: { ...RealDate, now: () => clockMs },
    // 真浏览器有 `AbortSignal.timeout`，pill 拿它做每条请求的 3 秒硬超时。
    // 夹具不给它的话，那条路在 vm 里会静悄悄退回"没有 signal"，判据也就测了个空。
    AbortSignal,
    setInterval: (callback: () => void) => {
      timers.push({ id: timers.length + 1, callback, cleared: false })
      return timers.length
    },
    clearInterval: (id: number) => {
      const timer = timers.find((candidate) => candidate.id === id)
      if (timer) timer.cleared = true
    },
    fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: unknown }) => {
      requests.push(url)
      signals.push(init?.signal)
      const method = init?.method ?? 'GET'
      if (url.startsWith(PAIR_NEW_ROUTE)) {
        assert.equal(method, 'POST', '发码那条只接受 POST')
        // 那个自定义头是这条写路由唯一的 CSRF 判据（桌面宿主会删 `origin`，真机 2026-10-03 量过）。
        // 浏览器面**忘了带**、或宿主侧改了头名，表现都是"点一下永远 403"，所以两边在这里对上。
        assert.equal(
          init?.headers?.[PAIR_MARKER_HEADER],
          PAIR_MARKER_VALUE,
          `发码请求必须带 ${PAIR_MARKER_HEADER}: ${PAIR_MARKER_VALUE}，实际 init=${JSON.stringify(init)}`,
        )
        if (options.newThrows) throw new Error('发码那条断了')
        return {
          ok: true,
          status: 200,
          json: async () => options.newAnswer ?? { state: 'ready', epoch: 'e1', token: '482913', expiresInMs: 60_000 },
        }
      }
      if (url.startsWith(PAIR_STATUS_ROUTE)) {
        if (options.statusPending) return new Promise(() => {})
        if (options.statusThrows) throw new Error('状态那条断了')
        return {
          ok: true,
          status: options.statusHttp ?? 200,
          json: async () => options.status ?? DEFAULT_STATUS,
        }
      }
      if (url.startsWith(PAIR_UNPAIR_ROUTE)) {
        assert.equal(method, 'POST', '退出配对只接受 POST')
        // 写路由同一条 CSRF 判据：那颗按钮与发码那颗在同一个弹窗里，头名不许分叉。
        assert.equal(
          init?.headers?.[PAIR_MARKER_HEADER],
          PAIR_MARKER_VALUE,
          `退出配对必须带 ${PAIR_MARKER_HEADER}: ${PAIR_MARKER_VALUE}，实际 init=${JSON.stringify(init)}`,
        )
        if (options.unpairThrows) throw new Error('退出配对那条断了')
        return {
          ok: (options.unpairHttp ?? 200) === 200,
          status: options.unpairHttp ?? 200,
          json: async () => options.unpairAnswer ?? { state: 'ok', unpaired: 1 },
        }
      }
      assert.equal(method, 'GET', `${url} 不该收到 ${method}`)
      return { ok: true, status: 200, json: async () => ({}) }
    },
    window: {
      __ModuleLoader__: {
        load: (loaded: unknown) => {
          spec = loaded as never
        },
      },
    },
  }
  runInContext(readFileSync(CLIENT, 'utf8'), createContext(sandbox), { filename: CLIENT })
  assert.ok(spec, '产物必须在装载时调用 __ModuleLoader__.load')
  assert.equal(typeof spec?.factory, 'function')
  const module = spec!.factory!((id: string): never => {
    if (id === 'react' && options.react !== undefined) return options.react as never
    throw new Error(`client 产物不该 require ${id}（除了向装载器拿 react）`)
  })

  /** slots 服务的形状照宿主那个用法：`inject(槽位名, cb)`，cb 里面调 `register(定义, 组件)`。 */
  const slots = options.slots
    ? {
        inject: (_slotName: string, callback: () => void) => {
          callback()
        },
        register: (definition: Record<string, unknown>, component: () => unknown) => {
          slotRegisters.push({ definition, component })
          return () => undefined
        },
      }
    : undefined

  // 真 cordis 的 `ctx.inject(names, cb)`：cb 可能在 apply 返回之后很久才触发，
  // 参数是一个只能读那些服务名的作用域上下文。
  const pendingInject: Array<(scoped: unknown) => void> = []
  const scopedContext = {
    get: (name: string) => (name === 'slots' ? slots : undefined),
  }
  // 模块声明了 `inject: ['slots']`，所以真宿主上 `ctx.slots` 是直接可读的那一条
  // （宿主自带模板同款）。`lateSlots` 时它在补注入之前必须读不到。
  let delivered = !options.lateSlots
  const ctx: Record<string, unknown> = {
    get: (name: string) => {
      if (options.getThrows) throw new Error(`cannot get property "${name}" without inject`)
      if (!delivered) return undefined
      return name === 'slots' ? slots : undefined
    },
    inject: (names: string[], callback: (scoped: unknown) => void) => {
      if (options.lateSlots && names.includes('slots')) pendingInject.push(callback)
      return () => undefined
    },
    effect: (execute: () => unknown) => {
      execute()
    },
  }
  Object.defineProperty(ctx, 'slots', {
    get() {
      if (options.getThrows) throw new Error('cannot get property "slots" without inject')
      return delivered ? slots : undefined
    },
  })
  module.apply(ctx)

  /**
   * 那颗 pill 的 ref 回调：mount / unmount 都走它，与宿主真正做的事一致。
   * `attach` 是 `mountPill` 里那一份闭包，两次 `component()` 拿到的是**同一个函数**——
   * 若它每次渲染都换新身份，React 会反复拆建那块 DOM，这里也就测不出真行为。
   */
  const pillRef = (): ((node: unknown) => void) => {
    assert.ok(slotRegisters.length > 0, 'pill 必须先注册进槽位')
    const created = slotRegisters[0]!.component!() as { props?: { ref?: (node: unknown) => void } }
    const ref = created?.props?.ref
    assert.equal(typeof ref, 'function', '挂载点必须带 ref，否则那颗 pill 永远进不了 DOM')
    return ref!
  }

  return {
    module,
    requests,
    signals,
    errors,
    warnings,
    timerCount: () => timers.length,
    liveTimerCount: () => timers.filter((timer) => !timer.cleared).length,
    fire: (index: number) => {
      assert.ok(timers[index], `第 ${index} 个节拍不存在（一共 ${timers.length} 个）`)
      timers[index]!.callback()
    },
    async fireAndFlush(index: number) {
      timers[index]?.callback()
      await flush()
    },
    slotRegisters: () => slotRegisters,
    flushInject(): void {
      delivered = true
      for (const callback of pendingInject.splice(0)) callback(scopedContext)
    },
    mountPill(): FakeElement {
      const element = doc.createElement('span')
      pillRef()(element)
      return element
    },
    unmountPill(): void {
      pillRef()(null)
    },
    fakeDocument: () => doc,
    advanceClock: (ms: number) => {
      clockMs += ms
    },
  }
}

test('外壳注册的形状：id 与包名一致，导出 name/inject/apply；inject 声明 slots（宿主模板同款）', () => {
  const harness = load()
  assert.equal(harness.module.name, 'dsh-remote-control')
  // 展开一次：vm 那个 realm 的数组与本 realm 的 Array.prototype 不是同一个，
  // deepStrictEqual 会因原型不同而红（与代码对错无关）。
  assert.deepEqual(
    [...harness.module.inject],
    ['slots'],
    '这条声明决定激活时机：空列表时 apply 跑在槽位服务之前，那颗 pill 整颗不出现（2026-10-03 真机）',
  )
  assert.equal(typeof harness.module.apply, 'function')
  assert.equal(harness.errors.length, 0)
})

test('拿不到 react：一颗 pill 都不注册，apply 不外抛，且留下一行说得清的 warn', async () => {
  const harness = load()
  await flush()
  assert.equal(harness.slotRegisters().length, 0, '没有 react 就不该去碰槽位')
  assert.equal(harness.errors.length, 0, '这是降级，不是故障')
  assert.equal(harness.timerCount(), 0, 'pill 没起来就不该留节拍')
  assert.ok(
    harness.warnings.some((line) => line.includes('react')),
    `降级要留下能查的一句：${harness.warnings.join(' | ')}`,
  )
})

test('探不到 slots（这代宿主没这个服务）：同样只降级，并指名是没探到 slots', async () => {
  const harness = load({ react: FAKE_REACT })
  await flush()
  assert.equal(harness.slotRegisters().length, 0)
  assert.equal(harness.errors.length, 0)
  assert.ok(
    harness.warnings.some((line) => line.includes('slots')),
    `要指名是没探到 slots：${harness.warnings.join(' | ')}`,
  )
})

test('slots 晚到（真机形状：apply 时拿不到，注入回调之后才有）：pill 必须补挂上，而不是永久没有', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, lateSlots: true })
  await flush()
  assert.equal(harness.slotRegisters().length, 0, 'apply 那一刻还没拿到 slots，不该已经注册')
  harness.flushInject()
  await flush()
  assert.equal(
    harness.slotRegisters().length,
    1,
    '晚到的 slots 必须把那颗 pill 补挂上：浏览器面不声明任何 inject，于是 apply 早于服务到位是常态——' +
      '2026-10-03 删掉右栏之后，这台机器上那颗 pill 整颗不出现就是这个形状打的',
  )
  const root = harness.mountPill()
  await flush()
  assert.ok(root.find('drc-pill'), `补挂之后按钮要建得出来：${root.allText()}`)
})

test('软探测不许抛出 apply：ctx.get 抛（真 cordis 的 Proxy 就是这个形状）时只降级', async () => {
  const harness = load({ react: FAKE_REACT, getThrows: true })
  await flush()
  assert.equal(harness.errors.length, 0, `抛出 apply 就是整页起不来：${harness.errors.join(' | ')}`)
  assert.equal(harness.slotRegisters().length, 0)
})

test('注册进 conversation.composer.dock：槽位名、id、order 都要对', async () => {
  const harness = load({ react: FAKE_REACT, slots: true })
  await flush()
  const entry = harness.slotRegisters()[0]
  assert.ok(entry, '必须注册进槽位')
  assert.equal(entry!.definition.name, 'conversation.composer.dock')
  assert.equal(entry!.definition.id, 'dsh-remote-control')
  assert.equal(entry!.definition.order, 20, '排在宿主自带的 stats(0) 与 provider-usage(10) 之后，不挤掉它们')
})

test('挂载之后抬头写的是状态路由给的那句', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, paired: 1, pairings: 1 } })
  const root = harness.mountPill()
  await flush()
  const pill = root.find('drc-pill')
  assert.ok(pill, `那颗按钮必须建出来：${root.allText()}`)
  // 抬头那句写在按钮里那个 `drc-label` 上，取它而不是按钮：假 DOM 的 textContent 不聚合后代。
  // 配上了几句台数**不写进抬头**：那排宽度是宿主给的，中文会被逐字断行（见下一条用例），
  // 而"几台"这件事点进去那颗按钮上看得见（只允许一台，所以它只可能是 0 或 1）。
  assert.equal(root.find('drc-label')!.textContent, '已连接')
  assert.equal(pill!.getAttribute('aria-label'), '已连接')
  assert.equal(root.find('drc-dot')!.getAttribute('data-tone'), 'on', '灯的颜色由 tone 决定')
})

test('在线但一台没配上：抬头是"远程未连接"，灯必须是灰的', async () => {
  // 夹具的配对簿也是空的（pairings: 0）——真没配过。
  // 配过但手机离线是另一种状态，见下面一条。
  const harness = load({ react: FAKE_REACT, slots: true })
  const root = harness.mountPill()
  await flush()
  assert.equal(root.find('drc-label')!.textContent, '远程未连接')
  assert.equal(
    root.find('drc-dot')!.getAttribute('data-tone'),
    'off',
    '绿色只能给"真的配上了一台"，一张还没人扫的码不算',
  )
})

test('在线、配对簿里还有会话但没有手机连着：抬头是"手机离线"，不是"远程未连接"', async () => {
  // 现场：手机把小程序收进后台 / 关屏——socket 断了，但配对还在（pair-store 落盘、
  // D3 长存），回前台自动重连。那一刻说"未配对"是在让用户扫一个不需要扫的码
  // （2026-10-04 用户报的误解）。灯走黄：不是故障，也不是"可以用了"，是"等它自己回来"。
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, paired: 0, pairings: 1 } })
  const root = harness.mountPill()
  await flush()
  assert.equal(root.find('drc-label')!.textContent, '手机离线')
  assert.equal(
    root.find('drc-dot')!.getAttribute('data-tone'),
    'wait',
    '黄色给"等它自己回来"：灰是没配上（要扫码），绿是配上了且在用，红才是故障',
  )
  // 点开不烧码（配对还在就是资格），也不该出二维码；按钮仍是"退出配对"——能退
  root.find('drc-pill')!.emit('click')
  await flush()
  assert.ok(root.find('drc-panel'), '面板要弹出来')
  assert.ok(!root.find('drc-qr'), '配过了就不该再出二维码：手机离线不是没配上')
  assert.equal(root.find('drc-head-label')!.textContent, '手机离线')
  assert.equal(
    harness.requests.filter((url) => url === PAIR_NEW_ROUTE).length,
    0,
    '离线不放码：新码只会白耗中继的 pending 表',
  )
  assert.equal(root.find('drc-btn')!.textContent, '退出配对', '配对还在，按钮的身份就该还是退出配对')
  assert.ok(
    root.allText().includes('不用重新扫码'),
    `离线那一屏要说清"不用重新扫码"，否则用户看到"手机离线"会去扫一个不需要扫的码：${root.allText().slice(0, 240)}`,
  )
})

test('那一排挤不下时只许省略号，不许把中文逐字断行（真屏幕截图抓到的形状）', async () => {
  // 现场：宿主 dock 已经挤到 `6 轮 …`、`1.6M to…`，而我们那颗 `已连 1 台` 被压成竖排四个字。
  // flex 项默认可以缩到"中文的最小内容宽度 = 一个字"，所以 nowrap + 省略号必须写死在样式里。
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, paired: 1, pairings: 1 } })
  const root = harness.mountPill()
  await flush()
  const css = harness.fakeDocument().head.children.find((node) => node.tag === 'style')?.textContent ?? ''
  assert.ok(css.includes('.drc-pill'), `那颗 pill 的样式没注入到 head：${css.slice(0, 120)}`)
  assert.match(css, /flex: 0 1 auto; white-space: nowrap;/, '按钮不许被压成多行：nowrap 是那条断行的唯一解药')
  assert.match(
    css,
    /\.drc-label \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;[^}]*\}/,
    '缩不下时截断的是文字，不是把整颗按钮撑开',
  )
  // 截断之后全文仍然取得到（悬浮与读屏都靠这两条）
  const pill = root.find('drc-pill')!
  assert.equal(pill.getAttribute('title'), 'dsh-remote-control：已连接')
  assert.equal(pill.getAttribute('aria-label'), '已连接')
})

test('中继断链时说的是"已断开连接"，而且是红的——不能和"还没配上"同一个灰', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, relay: 'offline' } })
  const root = harness.mountPill()
  await flush()
  assert.equal(root.find('drc-label')!.textContent, '已断开连接')
  assert.equal(root.find('drc-dot')!.getAttribute('data-tone'), 'error', '断链是故障不是"还没轮到配"，灰灯会被读成后者')
})

test('runtime 还没起来时说"远程未启动"：idle 与 offline 是两件事', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, relay: 'idle' } })
  const root = harness.mountPill()
  await flush()
  assert.equal(root.find('drc-label')!.textContent, '远程未启动')
})

test('页面不可见时不轮状态（Electron 里窗口在后台是常态）', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, hidden: true })
  harness.mountPill()
  await flush()
  assert.equal(
    harness.requests.filter((url) => url.startsWith(PAIR_STATUS_ROUTE)).length,
    0,
    `不可见时一次都不该发：${harness.requests.join(' | ')}`,
  )
})

/**
 * 面板的两屏（2026-10-04 定形）：**未配对点开就是二维码页，已配对点开只给状态。**
 *
 * 原来这里是"未配对点开只给状态 + 一颗「生成配对码」"，那一屏被删掉了：没配上时面板上
 * 没有任何别的东西可看，多点一次只换到一次"啊，原来在这儿"。
 * 2026-10-03 那条取舍守的东西没有作废，只是挪了位置——**它现在守已配对那一侧**：
 * 配上了之后点开仍然一次码都不发（见下面那条 paired 的用例），因为那时点开的第一预期
 * 确实是"看一眼连得怎么样"，而一张码是有寿命的 pending 资源。
 */
test('未配对点开直接就是二维码页：发一次码、图与 6 位码都在，那颗按钮叫「刷新」', async () => {
  const harness = load({ react: FAKE_REACT, slots: true })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()

  assert.ok(root.find('drc-panel'), '面板要弹出来')
  assert.equal(root.find('drc-head-label')!.textContent, '远程未连接')
  assert.ok(root.find('drc-qr'), `未配对点开就该在二维码页上，实际：${root.allText()}`)
  assert.ok(root.find('drc-code'), '6 位码要单独印一行（QR 扫不出来时那是唯一退路）')
  assert.equal(
    harness.requests.filter((url) => url === PAIR_NEW_ROUTE).length,
    1,
    '点开要发**且只发一次**码：这条路由幂等，但一次点开排两次是白耗中继的 pending 表',
  )
  assert.equal(root.find('drc-btn')!.textContent, '刷新', '没配上时那颗按钮的身份就是"再要一张码"')
  // 正文那几行在未配对这一屏也要在场：它回答的是"连的哪一台 / 连没连上 / 跑的是哪一版"。
  const rows = root
    .findAll('drc-info')
    .map((row) => [row.find('drc-key')!.textContent, row.find('drc-value')!.textContent])
  // 夹具里 `waiting: 0`，所以"待处理"那一行自己不占地方，正文就是这三行（次序也是判据）。
  assert.deepEqual(rows, [
    ['中继', 'relay.example.com:443'],
    ['状态', '已就绪'],
    ['版本', '0.0.0-test'],
  ])
  assert.ok(!root.allText().includes('wss://'), `面板里不许出现完整 URI：${root.allText()}`)
  // 已删掉的说法（这一轮又少了两个）：本机名、台数、再配一台、换一张、生成配对码。
  const flat = root.allText()
  for (const gone of ['本机', '已配对', '再配一台', '换一张', '生成配对码']) {
    assert.ok(!flat.includes(gone), `删掉的说法不该再出现：「${gone}」在 ${flat}`)
  }
})

test('已配对点开只给状态，一次码都不发；正文就是中继/状态/版本三行', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, paired: 1, pairings: 1 } })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  assert.equal(
    harness.requests.filter((url) => url === PAIR_NEW_ROUTE).length,
    0,
    '配上之后点开还发码 = 每次"看一眼"都可能向中继申请一张新的挂在 pending 表里',
  )
  assert.equal(root.find('drc-head-label')!.textContent, '已连接')
  assert.ok(!root.find('drc-qr'), '已配对那一屏不该有二维码')
  const rows = root
    .findAll('drc-info')
    .map((row) => [row.find('drc-key')!.textContent, row.find('drc-value')!.textContent])
  assert.deepEqual(
    rows,
    [
      ['中继', 'relay.example.com:443'],
      ['状态', '已就绪'],
      ['版本', '0.0.0-test'],
    ],
    `正文就那三行、按这个次序：${root.allText()}`,
  )
})

/**
 * 这一组是"30 秒原则"落进界面的那一条（伞仓 docs/PRODUCT.md §3、§5 G3/G4）。
 *
 * 原来"已配对 + 有一条审批挂在手机上"时，那颗 pill 仍然只说 `已配对`——而那条回合正停在这台
 * 机器上等人点，且这颗 pill 是它在桌面上唯一可能被看见的地方。所以：**有得等就说等几件**。
 */
test('有东西在等时抬头说"等 N 件事"，面板第一行是"待处理 · 最久多久"', async () => {
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    status: { ...DEFAULT_STATUS, paired: 1, pairings: 1, waiting: 2, waitingOldestSec: 252 },
  })
  const root = harness.mountPill()
  await flush()
  assert.equal(root.find('drc-label')!.textContent, '等 2 件事', `回合停着等人点，抬头不许还说"已配对"`)
  assert.equal(
    root.find('drc-dot')!.getAttribute('data-tone'),
    'wait',
    '要 amber 那一档：这是"该你动手"，不是"一切正常"的绿',
  )
  root.find('drc-pill')!.emit('click')
  await flush()
  const rows = root
    .findAll('drc-info')
    .map((row) => [row.find('drc-key')!.textContent, row.find('drc-value')!.textContent])
  assert.deepEqual(
    rows[0],
    ['待处理', '2 件 最久 4 分 12 秒'],
    `待处理必须排第一（其余三条都是"知道就行"）：${JSON.stringify(rows)}`,
  )
  assert.deepEqual(
    rows.slice(1).map(([key]) => key),
    ['中继', '状态', '版本'],
  )
})

test('两条优先级：断链仍然压过"等 N 件事"；没配上时挂起也不抢那一格', async () => {
  // ① 链都断了，"等几件"是没意义的——用户要修的是连接，那才是故障优先。
  const offline = load({
    react: FAKE_REACT,
    slots: true,
    status: { ...DEFAULT_STATUS, paired: 1, pairings: 1, relay: 'offline', waiting: 3, waitingOldestSec: 10 },
  })
  const offlineRoot = offline.mountPill()
  await flush()
  assert.equal(offlineRoot.find('drc-label')!.textContent, '已断开连接')
  assert.equal(offlineRoot.find('drc-dot')!.getAttribute('data-tone'), 'error')

  // ② 手机中途掉线、挂起还没超时：这时能做的第一件事是重新配对，抬头就该说那个。
  const unpaired = load({
    react: FAKE_REACT,
    slots: true,
    status: { ...DEFAULT_STATUS, paired: 0, waiting: 1, waitingOldestSec: 40 },
  })
  const unpairedRoot = unpaired.mountPill()
  await flush()
  assert.equal(
    unpairedRoot.find('drc-label')!.textContent,
    '远程未连接',
    '没配上却说"等 1 件事"是让人去找一台不存在的手机',
  )
  // 但面板里那一行仍然要说——它回答的是"这台机器上有没有回合被卡住"。
  unpairedRoot.find('drc-pill')!.emit('click')
  await flush()
  const first = unpairedRoot.findAll('drc-info')[0]!
  assert.deepEqual(
    [first.find('drc-key')!.textContent, first.find('drc-value')!.textContent],
    ['待处理', '1 件 最久 40 秒'],
    '抬头不抢，不代表面板可以不说',
  )
})

/**
 * 时长写法走**打出来的 bundle**，不直接 import 那个纯函数——这个文件的立足点就是
 * "在 vm 里真跑 client.cjs"，绕过去就等于这条判据没测过 bundle 里那份。
 */
test('等待时长的写法：<60 秒只说秒、十分钟以上不再带秒（这行是扫一眼的，不是秒表）', async () => {
  const cases: Array<[number, string]> = [
    [37, '1 件 最久 37 秒'],
    [60, '1 件 最久 1 分 0 秒'],
    [252, '1 件 最久 4 分 12 秒'],
    [600, '1 件 最久 10 分'],
    [7265, '1 件 最久 121 分'],
  ]
  for (const [seconds, expected] of cases) {
    const harness = load({
      react: FAKE_REACT,
      slots: true,
      status: { ...DEFAULT_STATUS, paired: 1, pairings: 1, waiting: 1, waitingOldestSec: seconds },
    })
    const root = harness.mountPill()
    await flush()
    root.find('drc-pill')!.emit('click')
    await flush()
    const value = root.findAll('drc-info')[0]!.find('drc-value')!.textContent
    assert.equal(value, expected, `${seconds}s 那一档写成了「${value}」，期望「${expected}」`)
  }
})

test('waitingOldestSec 是怪值（老版宿主 / NaN）时那一行只说件数，不许印出 NaN', async () => {
  for (const junk of ['不是数', -7, undefined]) {
    const harness = load({
      react: FAKE_REACT,
      slots: true,
      status: { ...DEFAULT_STATUS, paired: 1, pairings: 1, waiting: 2, waitingOldestSec: junk },
    })
    const root = harness.mountPill()
    await flush()
    root.find('drc-pill')!.emit('click')
    await flush()
    const value = root.findAll('drc-info')[0]!.find('drc-value')!.textContent
    assert.equal(value, '2 件', `怪值 ${JSON.stringify(junk)} 应该退化成只说件数，实际「${value}」`)
  }
})

test('waiting 字段缺失（老版宿主）时那一行不建、抬头退回"已配对"', async () => {
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    status: {
      relay: 'online',
      paired: 1,
      pairings: 1,
      serverUrl: 'wss://relay.example.com:443/relay',
      version: '1.2.0',
    },
  })
  const root = harness.mountPill()
  await flush()
  assert.equal(root.find('drc-label')!.textContent, '已连接')
  root.find('drc-pill')!.emit('click')
  await flush()
  const keys = root.findAll('drc-info').map((row) => row.find('drc-key')!.textContent)
  assert.deepEqual(keys, ['中继', '状态', '版本'], `没有 waiting 就不该凭空出现一行"待处理"：${JSON.stringify(keys)}`)
})

test('正文那三行各自拿不到值时不占地方：老版路由没给 version、中继字段不认识', async () => {
  // 模拟"宿主是上一版、回答里没有 version"：那一行必须自己消失，而不是印一个空白键。
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    status: { relay: 'weird-state', paired: 0, serverUrl: 'wss://relay.example.com:443/relay' },
  })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  const keys = root.findAll('drc-info').map((row) => row.find('drc-key')!.textContent)
  assert.deepEqual(keys, ['中继'], `拿不到值的那两行不该出现，收到：${JSON.stringify(keys)}`)
})

test('中继那条链的细态按 relay 取值翻译：连接中 / 已断开 / 未启动', async () => {
  const cases: Array<[string, string]> = [
    ['connecting', '连接中'],
    ['offline', '已断开'],
    ['idle', '未启动'],
  ]
  for (const [relay, expected] of cases) {
    const harness = load({
      react: FAKE_REACT,
      slots: true,
      status: { relay, paired: 0, serverUrl: 'wss://relay.example.com:443/relay', version: '0.0.0-test' },
    })
    const root = harness.mountPill()
    await flush()
    root.find('drc-pill')!.emit('click')
    await flush()
    const stateRow = root.findAll('drc-info').find((row) => row.find('drc-key')!.textContent === '状态')
    assert.equal(stateRow?.find('drc-value')!.textContent, expected, `relay=${relay} 时那行状态`)
  }
})

test('已经配上时右上角那颗是"退出配对"，按下就打 POST /unpair（带同一个守卫头）', async () => {
  // 先未配对地建出来，再把状态切成已配对并触发一次轮询，验证按钮会随状态改文案。
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, paired: 1, pairings: 1 } })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  assert.equal(root.find('drc-head-label')!.textContent, '已连接')
  const button = root.find('drc-btn')!
  assert.equal(button.textContent, '退出配对')
  assert.equal(
    harness.requests.filter((url) => url.startsWith(PAIR_UNPAIR_ROUTE)).length,
    0,
    '点开面板本身不该解配——必须真的按下那颗按钮',
  )

  button.emit('click')
  await flush()
  assert.ok(
    harness.requests.some((url) => url.startsWith(PAIR_UNPAIR_ROUTE)),
    `按下退出配对必须打那条写路由：${harness.requests.join(' | ')}`,
  )
  // 乐观翻面：不用等下一次 2 秒轮询，抬头与那颗按钮当场就变。
  assert.equal(root.find('drc-head-label')!.textContent, '远程未连接')
  // 退完之后不再是"先按一颗生成配对码"那一屏：**没配上就直接在二维码页上**，
  // 那颗按钮的身份同时翻成 `刷新`（要再换一张码还是它）。
  assert.equal(root.find('drc-btn')!.textContent, '刷新')
  assert.ok(root.find('drc-qr'), `退出配对之后面板该停在二维码页，实际：${root.allText()}`)
})

test('退出配对那条断了：面板不白屏、抬头仍按乐观结果翻面，并且留下一行 warn', async () => {
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    status: { ...DEFAULT_STATUS, paired: 1, pairings: 1 },
    unpairThrows: true,
  })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  root.find('drc-btn')!.emit('click')
  await flush()
  assert.equal(harness.errors.length, 0, '这是降级不是故障')
  assert.ok(root.find('drc-panel'), '面板要留着')
  assert.ok(
    harness.warnings.some((line) => line.includes('退出配对')),
    `降级要留下能查的一句：${harness.warnings.join(' | ')}`,
  )
})

test('按下发码那颗：POST 发码那条，再把图与 6 位码画进面板；epoch 进图片 URL', async () => {
  const harness = load({ react: FAKE_REACT, slots: true })
  const root = harness.mountPill()
  await openPairing(root)

  assert.ok(harness.requests.includes(PAIR_NEW_ROUTE), `必须真的打过发码那条：${harness.requests.join(' | ')}`)
  assert.ok(root.find('drc-panel'), '面板要弹出来')
  assert.equal(root.find('drc-qr')!.src, `${PAIR_IMAGE_ROUTE}?e=e1`, '图片地址要带上这一版码的 epoch')
  assert.equal(root.find('drc-code')!.textContent, '482913', '6 位码必须与 QR 同时在屏上——手输是唯一退路')
  // 剩余时间**常显在码上面**（2026-10-05 用户报"显示着码却配不上"之后加的）：
  // 服务端权威寿命 3 分钟，旧版只有 tick 走完后 note 才改口，那之前屏上没有任何
  // 时间信息——手机上挪一圈回来码就废了，而用户看不出它废了。
  assert.equal(root.find('drc-count')!.textContent, '1 分 0 秒后过期')
  // 还有时间时 note 闭嘴：一行说一件事。
  assert.equal(root.find('drc-note'), undefined, '倒计时已经在说这件事，note 不许重复')
  // 引导行：第一次装好插件的人要能在这一屏看明白"码是给谁扫的、扫完得到什么"。
  // 口径是用户 2026-10-05 定的：一条、短、不带括号/顿号/书名号等符号（空格分隔）。
  assert.equal(root.find('drc-guide')!.textContent, '打开小程序扫这个码 远程控制这台电脑')
  assert.doesNotMatch(root.find('drc-guide')!.textContent, /[（()）「」【】·、，：:！!？?]/)
  // 出图这一版右上角那颗是**刷新**，不再是"生成配对码"——同一件事两个说法会让用户以为要重新配一次。
  assert.equal(root.find('drc-btn')!.textContent, '刷新', '二维码页那颗按钮的文案')
  assert.equal(root.find('drc-pill')!.getAttribute('aria-expanded'), 'true')
})

test('中继不在线：连码都不发，面板说明白"现在发不出配对码"', async () => {
  // 2026-10-05 线上取证：主机半开掉线的那 10 分钟里 pill 照常画着一张码，
  // 用户扫码 → 中继 invalid_or_expired → 手机只说"配对失败"。一张扫了必然失败
  // 的码比没有码更糟。现在中继不在线时**一个请求都不该打出去**。
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    status: { ...DEFAULT_STATUS, relay: 'offline' },
  })
  const root = harness.mountPill()
  // 先等一轮 /status 回来：守卫读的是 poll 的结果，挂上那一刻还没有。
  await flush()
  await openPairing(root)
  assert.equal(
    harness.requests.includes(PAIR_NEW_ROUTE),
    false,
    `中继不在线就不该打发码那条：${harness.requests.join(' | ')}`,
  )
  assert.equal(root.find('drc-qr'), undefined, '没有码就不该有那张图')
  const shown = root.find('drc-panel')!.allText()
  assert.match(shown, /主机还没连上中继/, '第一句要说清为什么现在没有码')
  assert.match(shown, /中继恢复后点右上角刷新/, '第二句告诉人下一步点什么')
  assert.ok(root.find('drc-btn'), '刷新按钮要在场——中继回来就靠它')
})

test('面板开着的时候中继掉了：死的二维码当场换成 offline，不许留在屏上', async () => {
  // 今天线上就是这么误导用户的：面板停在一张码上，主机半开掉线，
  // 用户照着扫 → 中继 invalid_or_expired → 手机只说"配对失败"。
  // status 用**可变对象**：poll 每轮都读它，所以"中继掉线"就是把 relay 改掉。
  const status = { ...DEFAULT_STATUS, paired: 0, pairings: 0 }
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    status,
    newAnswer: { state: 'ready', token: '482913', epoch: 'e1', expiresInMs: 60000 },
  })
  const root = harness.mountPill()
  await flush()
  await openPairing(root)
  assert.ok(root.find('drc-qr'), '前提：先有一张码在屏上')

  // 中继掉线：下一轮 /status 带回来 offline，那一屏必须当场换掉。
  // （轮询是 setInterval 驱动的，测试里手工打那一拍——挂载后只有一个节拍：status。）
  status.relay = 'offline'
  await harness.fireAndFlush(0)
  assert.equal(root.find('drc-qr'), undefined, '中继走了就不许留着那张码')
  const shown = root.find('drc-panel')!.allText()
  assert.match(shown, /主机还没连上中继/)
})

test('200 + state:"unavailable" 不是成功：面板要说明白，不许弹一张白框', async () => {
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    newAnswer: { state: 'unavailable', reason: 'relay-offline' },
  })
  const root = harness.mountPill()
  await openPairing(root)
  assert.equal(root.find('drc-qr'), undefined, '没有码就不该有那张图')
  assert.match(root.find('drc-note')!.textContent, /中继还没连上/)
  assert.ok(root.find('drc-btn'), '要给一句"再试一次"，别让人以为插件坏了')
})

test('守卫拒了就把是哪一道印在屏幕上：那是浏览器面唯一的现场', async () => {
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    newAnswer: { error: 'request-not-trusted', guard: 'pair-marker-missing' },
  })
  const root = harness.mountPill()
  await openPairing(root)
  assert.match(root.find('drc-note')!.textContent, /request-not-trusted/, '要把宿主说的原因带出来')
  assert.match(root.find('drc-note')!.textContent, /pair-marker-missing/, '更要带出是哪一道守卫')
})

test('发码那条直接断（fetch 抛）：面板显示失败原因，不抛出、不白屏', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, newThrows: true })
  const root = harness.mountPill()
  await openPairing(root)
  assert.match(root.find('drc-note')!.textContent, /配对请求没成功/)
  assert.equal(harness.errors.length, 0)
})

test('点外面才关：落在面板里的 pointerdown 不许收起，落在外面与 Escape 都要收', async () => {
  const harness = load({ react: FAKE_REACT, slots: true })
  const root = harness.mountPill()
  await flush()
  const button = root.find('drc-pill')!
  button.emit('click')
  await flush()
  assert.ok(root.find('drc-panel'), '先确认面板开着')

  const panel = root.find('drc-panel')!
  harness.fakeDocument().emit('pointerdown', { target: panel })
  assert.ok(root.find('drc-panel'), '落在面板里的 pointerdown 关掉它，用户就是"复制码时弹窗消失"')

  harness.fakeDocument().emit('pointerdown', { target: harness.fakeDocument().createElement('div') })
  assert.equal(root.find('drc-panel'), undefined, '点外面要关')

  button.emit('click')
  await flush()
  assert.ok(root.find('drc-panel'), '再点要能开')
  harness.fakeDocument().emit('keydown', { key: 'Escape' })
  assert.equal(root.find('drc-panel'), undefined, 'Escape 要关')
})

test('码过期后**不再自动补一张**，就地说明白要人自己去按（自动补码已删，重发靠右上角那颗「刷新」）', async () => {
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    newAnswer: { state: 'ready', epoch: 'e1', token: '482913', expiresInMs: 1_000 },
  })
  const root = harness.mountPill()
  await openPairing(root)
  assert.equal(harness.requests.filter((url) => url === PAIR_NEW_ROUTE).length, 1)
  // 节拍次序：0 = pill 状态轮询，1 = 面板倒计时。倒计时走光后自清，所以那一刻仍是 2 个。
  assert.equal(harness.timerCount(), 2, '该有两个节拍')
  const image = root.find('drc-qr')
  assert.ok(image, '前提：图在屏上')
  // 拨一秒再打那一拍：倒计时读的是墙钟，所以"一秒过去"必须由时钟表达，
  // 而不是由"节拍响了一次"顺带减掉 1000（2026-10-07 改，见下面那条漂移判据）。
  harness.advanceClock(1_000)
  await harness.fireAndFlush(1)
  assert.equal(
    harness.requests.filter((url) => url === PAIR_NEW_ROUTE).length,
    1,
    '倒计时走光**不许**再去要一张：自动补码 2026-10-03 删了，重发靠人按右上角那颗「刷新」',
  )
  assert.match(root.find('drc-note')!.textContent, /已过期/)
  assert.equal(root.find('drc-btn')!.textContent, '刷新', '要重发还是右上角那颗（出图时它叫刷新）')
  // 过期那一刻**整块重画**了一次（note 要改口），但图仍然按 src 复用同一个元素：
  // 重画不等于重新取图（`/pairing.png` 是 no-store，新元素必然回源并重新编码一整张 PNG）。
  assert.equal(root.find('drc-qr'), image, '过期那一拍重画了面板，img 却不该被重建')
  assert.equal(harness.liveTimerCount(), 1, '倒计时自清，只留状态轮询那一拍')
})

test('手机上刚扫完码：面板从二维码当场翻回状态视图，右上角那颗同时变成"退出配对"', async () => {
  // 一张码配上之后就没用了。面板若还停在图上，用户会以为"还没成功、再扫一次"。
  const status: Record<string, unknown> = { ...DEFAULT_STATUS, paired: 0 }
  const harness = load({ react: FAKE_REACT, slots: true, status })
  const root = harness.mountPill()
  await openPairing(root)
  assert.ok(root.find('drc-qr'), '先确认图在屏上')
  assert.equal(root.find('drc-btn')!.textContent, '刷新')

  status.paired = 1
  // 配对成功的那一刻主机就多了一条会话（簿从 0 变 1）——翻面判据读的是簿，不是台数。
  status.pairings = 1
  await harness.fireAndFlush(0)
  assert.equal(root.find('drc-qr'), undefined, '配上之后那张图不该还占着面板')
  assert.equal(root.find('drc-head-label')!.textContent, '已连接')
  assert.equal(root.find('drc-btn')!.textContent, '退出配对')
  assert.ok(harness.requests.filter((url) => url === PAIR_NEW_ROUTE).length === 1, '翻面只是重画，不许顺手再要一张')
})

test('样式表按内容对齐：宿主热更这一半、文档没重载时，旧 CSS 必须被换掉', async () => {
  // 现场（2026-10-03 用户截图）：新 JS 按新结构建 DOM，`<head>` 里却还是上一版的 `<style>`——
  // 旧 `.drc-actions{justify-content:center}` 让右上角那颗按钮掉到第二行居中，整块面板错位。
  const harness = load({ react: FAKE_REACT, slots: true, staleStyle: true })
  harness.mountPill()
  await flush()
  const doc = harness.fakeDocument()
  const styles = doc.head.children.filter((node) => node.tag === 'style')
  assert.equal(styles.length, 1, `不该再插第二份样式表：${styles.length}`)
  assert.ok(
    styles[0]!.textContent.includes('.drc-head'),
    '旧样式表必须被换成这一版的：只看"插过没有"会让上一版的布局一直生效',
  )
  assert.ok(!styles[0]!.textContent.includes('上一版的样式'), '旧内容不许留着')
})

test('卸载（宿主把 pill 摘掉）之后节拍停、文档监听摘干净', async () => {
  const harness = load({ react: FAKE_REACT, slots: true })
  harness.mountPill()
  await flush()
  assert.ok(
    harness.requests.some((url) => url.startsWith(PAIR_STATUS_ROUTE)),
    '先确认状态轮询在跑',
  )
  const doc = harness.fakeDocument()
  assert.ok(doc.listenerCount('pointerdown') > 0, 'pill 必须挂上"点外面"的监听')

  harness.unmountPill()
  const after = harness.requests.length
  await harness.fireAndFlush(0)
  assert.equal(harness.requests.length, after, '卸载后不该再轮状态')
  assert.equal(doc.listenerCount('pointerdown'), 0, '文档级监听必须摘掉，否则每次重挂都多一份')
})

test('反证：产物里的路由常量与宿主侧定义逐字一致（分叉的表现是"点了没反应而日志全绿"）', () => {
  const bundle = readFileSync(CLIENT, 'utf8')
  for (const constant of [PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE, PAIR_UNPAIR_ROUTE, PAIR_MARKER_HEADER]) {
    assert.ok(bundle.includes(constant), `client.cjs 里缺 ${constant}`)
  }
  // 出现一条宿主侧没有的 /plugins 路径就是两边分叉了。
  const found = [...new Set([...bundle.matchAll(/\/plugins\/[a-z0-9./-]+/g)].map((match) => match[0]))].sort()
  assert.deepEqual(found, [PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE, PAIR_UNPAIR_ROUTE].sort())
})

/**
 * 「手机离线」那一屏必须有一句「不用重新扫码」（2026-10-05）。
 *
 * 判据钉的是**这个结论在不在**，不是那句文案长什么样——所以 2026-10-05 把
 * 「配对还在 小程序回前台会自动重连 不用重新扫码」压成「不用重新扫码」时，
 * 这条判据不动；反过来哪天有人嫌它多余整句删掉，这里会红。
 *
 * 它为什么必须在：手机切后台就是离线（小程序生命周期），而配对簿还在。
 * 少了这句，用户看到「手机离线」会去扫一个根本不需要扫的码
 * （2026-10-04 用户提的误解）。
 */
test('pill：「手机离线」那一屏要有一句「不用重新扫码」', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../client/src/pill.ts'), 'utf8')
  assert.match(
    src,
    /text\('p', 'drc-note', '不用重新扫码'\)/,
    '「手机离线」那一屏没有这句：用户会去扫一个不需要扫的码（2026-10-04 的误解）',
  )
  // 同时钉住"别再长回去"：那三句解释用户 2026-10-05 已经嫌长了。
  assert.doesNotMatch(
    src,
    /'配对还在 小程序回前台会自动重连 不用重新扫码'/,
    '文案又长回去了：用户要的行动只有一个判断（要不要扫码），答案是不要，就只说不要',
  )
})

// ── 2026-10-06 那一轮修复的回归网 ────────────────────────────────────
// 每一条都对应一处"看上去没坏、实际每秒/每次都在白烧东西"的缺陷；判据钉的是**可观察的形状**
// （同一个 img 元素、同一个 warn 出口、定时器还活着几个），不是"代码里有没有那句话"。

test('倒计时每秒只改那一行文本：img 与 6 位码原地不动（重建 = 每秒重新请求并重编码一张 PNG）', async () => {
  // 现场：`/pairing.png` 是 `no-store`，而原来倒计时每秒 `paint()` 一次，
  // 而 `paint()` 是 `panel.replaceChildren()` 整块重建——`<img>` 跟着被换掉，
  // 于是屏幕上一张静止的码，后台每秒重新编码一整张 PNG。
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    newAnswer: { state: 'ready', epoch: 'e1', token: '482913', expiresInMs: 60_000 },
  })
  const root = harness.mountPill()
  await openPairing(root)
  const image = root.find('drc-qr')
  const code = root.find('drc-code')
  assert.ok(image, `前提：图在屏上（${root.allText()}）`)
  assert.equal(root.find('drc-count')!.textContent, '1 分 0 秒后过期')

  harness.advanceClock(1_000) // 真过了一秒，再打那一拍
  await harness.fireAndFlush(1)
  assert.equal(root.find('drc-count')!.textContent, '59 秒后过期', '每秒要动的只有这一行')
  assert.equal(
    root.find('drc-qr'),
    image,
    'img 必须是同一个元素：`<img>` 重建 = 浏览器必然重新请求一次 no-store 的 /pairing.png + 服务端重新编码',
  )
  assert.equal(root.find('drc-code'), code, '整块 replaceChildren 会把码那行一起换掉——每秒重建一次不该发生')
  assert.equal(harness.liveTimerCount(), 2, '还没过期：状态轮询与倒计时都该活着')
})

test('/status 非 200（路由没挂上就是 404）：要留一行 warn，pill 照常可用、下一拍照常问', async () => {
  // 原来这条路上是静默 `return`——一行 warn 都不留，于是"那颗 pill 一动不动"在现场没有任何线索。
  const harness = load({ react: FAKE_REACT, slots: true, statusHttp: 404 })
  const root = harness.mountPill()
  await flush()
  assert.ok(root.find('drc-pill'), '路由没挂上不许影响那颗 pill 本身')
  assert.equal(harness.errors.length, 0, '这是降级，不是故障')
  assert.ok(
    harness.warnings.some((line) => line.includes('status poll failed') && line.includes('404')),
    `非 200 必须留痕（含状态码），实际：${harness.warnings.join(' | ')}`,
  )
  await harness.fireAndFlush(0)
  assert.ok(
    harness.requests.filter((url) => url.startsWith(PAIR_STATUS_ROUTE)).length >= 2,
    '留痕不等于放弃：下一拍照常问',
  )

  // 面板正等着首次状态时那条路由一直 404：loading 必须落地成一句人话，而且**一颗码都不发**
  // （连状态都读不到时"是不是已配对"根本无从判断，不能靠"读不到就当没配上"绕过那条红线）。
  const waiting = load({ react: FAKE_REACT, slots: true, statusHttp: 404 })
  const waitingRoot = waiting.mountPill()
  waitingRoot.find('drc-pill')!.emit('click')
  assert.match(waitingRoot.find('drc-note')!.textContent, /正在读取主机状态/, '先画 loading，不许停在空白上')
  await flush()
  assert.equal(
    waiting.requests.filter((url) => url === PAIR_NEW_ROUTE).length,
    0,
    '读不到状态就不许发码：已配对的主机不该因为我们读不到状态就白吃一张新码',
  )
  assert.match(waitingRoot.find('drc-note')!.textContent, /读不到主机状态/, 'loading 要落地成一句人话，不能永远转圈')
})

// ── 2026-10-07 审计：倒计时是"期限"的投影，不是节拍器的读数 ──────────
// 现场（2026-10-05 用户报的"要等下次刷新的二维码才能用"）：用户点开发码面板之后必然要
// **切走**去手机上扫码，而后台页的 setInterval 会被节流（Chrome intensive throttling 一分钟
// 一醒）、Electron 会冻不可见窗口、合盖直接停摆。原来那一行是 `expiresInMs -= 1000`，
// 于是屏上的数字只数"节拍响过几次"，切回来时那张码早就死了而面板还写着"还剩 2 分"。

test('倒计时按墙钟算：后台冻结的那段时间不许被当成"没过去"', async () => {
  // 这条判的是**节拍本身**，所以刻意不打任何节拍：只把墙钟往前拨，
  // 模拟"两分钟里一次回调都没有"。旧实现（`expiresInMs -= 1000`）这时会显示 59 秒。
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    newAnswer: { state: 'ready', epoch: 'e1', token: '482913', expiresInMs: 60_000 },
  })
  const root = harness.mountPill()
  await openPairing(root)
  assert.equal(root.find('drc-count')!.textContent, '1 分 0 秒后过期', '前提：刚拿到码时算得出 1 分钟')

  harness.advanceClock(90_000) // 一分半过去，一拍都没响
  await harness.fireAndFlush(1)

  assert.equal(
    root.find('drc-count')?.textContent,
    undefined,
    `一张 60 秒的码过了 90 秒必须已经收起来，实际屏上是：${root.find('drc-count')?.textContent ?? '(没有这一行)'}`,
  )
  assert.match(
    root.find('drc-note')!.textContent,
    /已过期/,
    '必须就地改口说"已过期"：用户扫的是一张死码，面板却显示它还活着',
  )
  assert.equal(harness.liveTimerCount(), 1, '走完就该自清，只留状态轮询那一拍')
})

test('切回前台那一拍就把倒计时对齐（后台节流期间表早就停了，回来要立刻看到真相）', async () => {
  // 墙钟锚定保证"下一拍回来时数字是对的"，可后台被冻结时下一拍可能几分钟后才来，
  // 而用户是**切回来立刻看屏**的 —— 这一拍就是为那一眼准备的。
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    newAnswer: { state: 'ready', epoch: 'e1', token: '482913', expiresInMs: 60_000 },
  })
  const root = harness.mountPill()
  await openPairing(root)
  assert.ok(root.find('drc-count'), '前提：倒计时在跑')

  // 部分过期：还剩 25 秒。不是"走光"，所以这一拍该做的是把数字改对。
  harness.advanceClock(35_000)
  harness.fakeDocument().emit('visibilitychange', {})
  assert.equal(
    root.find('drc-count')!.textContent,
    '25 秒后过期',
    '切回来第一眼必须是真实剩余，不是"35 秒没响就还是 60"',
  )

  // 再切回来一次：这次是真的过期了，必须落到"已过期"而不是继续显示 25 秒。
  harness.advanceClock(30_000)
  harness.fakeDocument().emit('visibilitychange', {})
  assert.equal(root.find('drc-count'), undefined, '过期之后不许还挂着一行倒计时')
  assert.match(root.find('drc-note')!.textContent, /已过期/)
  assert.equal(harness.liveTimerCount(), 1, '过期即停表，只留状态轮询')
})

test('关面板与卸载之后 visibilitychange 不许再动屏（孤儿监听 = 一条留在页面上的引用）', async () => {
  // 面板关掉之后那张码早就不在屏上了；监听还活着的话，一次切回前台就会去重画一个
  // 已经收掉的面板——用户看到的是"我明明关掉了，它自己又动了一下"。
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    newAnswer: { state: 'ready', epoch: 'e1', token: '482913', expiresInMs: 60_000 },
  })
  const root = harness.mountPill()
  await openPairing(root)
  assert.equal(harness.fakeDocument().listenerCount('visibilitychange'), 1, '前提：监听挂上了')

  harness.unmountPill()
  assert.equal(
    harness.fakeDocument().listenerCount('visibilitychange'),
    0,
    '卸载必须把监听摘掉：pill.ts 头注写着"卸载要清定时器"，监听同一条纪律',
  )
})

test('/unpair 的回答不许丢掉：403 带着守卫名回来是宿主故意留的唯一现场', async () => {
  // `routes.ts` 的 403 回答里**专门**带 `guard`，注释写着"屏幕上那句话就是唯一的现场"，
  // 而发码那条路由的客户端分支（`panelViewFor`）确实把它印出来了。
  // 退出配对这条路原来把整个回答丢掉：403 不会让 fetch 抛错，于是那句现场一句都留不下，
  // 而面板已经乐观地把 `paired` 清零 —— 用户看着一张自己没点过的码出现又消失。
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    status: { ...DEFAULT_STATUS, paired: 1, pairings: 1 },
    unpairAnswer: { error: 'request-not-trusted', guard: 'missing-marker-header' },
    unpairHttp: 403,
  })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  assert.equal(root.find('drc-btn')!.textContent, '退出配对', '前提：按钮身份是退出配对')
  root.find('drc-btn')!.emit('click')
  await flush()

  assert.ok(
    harness.warnings.some((line) => line.includes('403') && line.includes('request-not-trusted')),
    `退出配对被守卫拒了必须留一行 warn（状态码与宿主给的那句 error），实际：${harness.warnings.join(' | ')}`,
  )
})

test('二维码那一屏换成"发不出码 / 失败"时倒计时要停：否则是个每秒还在重画的孤儿定时器', async () => {
  const answer: Record<string, unknown> = { state: 'ready', epoch: 'e1', token: '482913', expiresInMs: 60_000 }
  const harness = load({ react: FAKE_REACT, slots: true, newAnswer: answer })
  const root = harness.mountPill()
  await openPairing(root)
  assert.ok(root.find('drc-qr'), '前提：先有一张码在屏上')
  // 节拍：0 = 状态轮询，1 = 倒计时。
  assert.equal(harness.liveTimerCount(), 2, '码在屏上时倒计时必须活着')

  // 中继在按下的这一刻说发不出码（路由回 200 + unavailable）→ 面板换成说明页。
  answer.state = 'unavailable'
  answer.reason = 'relay-offline'
  root.find('drc-btn')!.emit('click')
  await flush()
  assert.equal(root.find('drc-qr'), undefined, '没有码了就不该留着那张图')
  assert.match(root.find('drc-note')!.textContent, /中继还没连上/)
  assert.equal(harness.liveTimerCount(), 1, '离开二维码那一屏：倒计时要停，只剩状态轮询那一拍')

  // 失败那一支（fetch 抛 / 非 200 回答）同样要停表。
  const failing: Record<string, unknown> = { state: 'ready', epoch: 'e2', token: '482913', expiresInMs: 60_000 }
  const failed = load({ react: FAKE_REACT, slots: true, newAnswer: failing })
  const failedRoot = failed.mountPill()
  await openPairing(failedRoot)
  assert.equal(failed.liveTimerCount(), 2, '前提：这张码的倒计时在跑')
  delete failing.state
  failing.error = 'request-not-trusted'
  failedRoot.find('drc-btn')!.emit('click')
  await flush()
  assert.match(failedRoot.find('drc-note')!.textContent, /配对请求没成功/)
  assert.equal(failed.liveTimerCount(), 1, '失败那一屏也不该留着那个每秒重画的节拍')
})

test('首次 /status 还没落地就点开面板：一颗码都不发，先画 loading；状态回来才按分支走', async () => {
  // 现场：`pairingNow()` 读的是上一次轮询结果，第一次轮询还没回来时恒为 0。
  // 旧实现在这个窗口里点开就会 POST /pairing/new——**已配对的主机也照发**，
  // 服务端真出一张新码，与"已配对时点开一次码都不发"直接矛盾。
  const paired = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, paired: 1, pairings: 1 } })
  const pairedRoot = paired.mountPill()
  pairedRoot.find('drc-pill')!.emit('click') // 比第一拍轮询还早
  assert.ok(pairedRoot.find('drc-panel'), '面板要弹出来')
  assert.match(pairedRoot.find('drc-note')!.textContent, /正在读取主机状态/, '这一屏先画 loading')
  assert.equal(
    paired.requests.filter((url) => url === PAIR_NEW_ROUTE).length,
    0,
    '状态没回来之前一颗码都不发：这时根本不知道配没配上',
  )
  await flush()
  assert.equal(
    paired.requests.filter((url) => url === PAIR_NEW_ROUTE).length,
    0,
    '状态回来说"已配对"：点开依旧一次码都不发',
  )
  assert.equal(pairedRoot.find('drc-head-label')!.textContent, '已连接')
  assert.equal(pairedRoot.find('drc-qr'), undefined, '已配对那一屏不该有二维码')

  // 真没配上那一侧：loading 只是等状态，状态一到就要发码（否则用户得多点一次那颗按钮）。
  const fresh = load({ react: FAKE_REACT, slots: true })
  const freshRoot = fresh.mountPill()
  freshRoot.find('drc-pill')!.emit('click')
  assert.equal(
    fresh.requests.filter((url) => url === PAIR_NEW_ROUTE).length,
    0,
    '状态没回来之前同样不许发（这一条对两侧都成立）',
  )
  await flush()
  assert.equal(
    fresh.requests.filter((url) => url === PAIR_NEW_ROUTE).length,
    1,
    '状态回来说"真没配上"：这时才发码，且只发一次',
  )
  assert.ok(freshRoot.find('drc-qr'), `未配对点开就该落在二维码页：${freshRoot.allText()}`)
})

test('面板开着时普通状态变化也要跟着变：抬头与正文几行不许停在旧值上', async () => {
  // 原来只有 `qr → offline` 与 `qr → info` 两个跃迁会重画面板，普通状态变化只更新那颗 pill，
  // 于是面板抬头与正文（待处理 / 中继 / 状态 / 版本）一直显示点开那一刻的旧值。
  const status: Record<string, unknown> = { ...DEFAULT_STATUS, paired: 1, pairings: 1 }
  const harness = load({ react: FAKE_REACT, slots: true, status })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  assert.equal(root.find('drc-head-label')!.textContent, '已连接')
  assert.deepEqual(
    root.findAll('drc-info').map((row) => row.find('drc-key')!.textContent),
    ['中继', '状态', '版本'],
    '前提：此刻没有待处理',
  )

  // 中继转 connecting、手机上挂起 2 件事、版本也换了。
  status.relay = 'connecting'
  status.waiting = 2
  status.waitingOldestSec = 252
  status.version = '9.9.9-test'
  await harness.fireAndFlush(0)

  assert.equal(
    root.find('drc-head-label')!.textContent,
    '连接中',
    '面板抬头与那颗 pill 读的是同一份状态，两处不许各说各的',
  )
  assert.equal(root.find('drc-label')!.textContent, '连接中')
  assert.deepEqual(
    root.findAll('drc-info').map((row) => [row.find('drc-key')!.textContent, row.find('drc-value')!.textContent]),
    [
      ['待处理', '2 件 最久 4 分 12 秒'],
      ['中继', 'relay.example.com:443'],
      ['状态', '连接中'],
      ['版本', '9.9.9-test'],
    ],
    `面板正文要跟着轮询走：${root.allText()}`,
  )
})

test('注入的 <style> 必须同时带 data-plugin 与 data-plugin-css：只带后者会被宿主算到别的插件头上', async () => {
  // 宿主按 `data-plugin` 认领"这份样式是谁插的"（claimStyles）。缺了它，这份样式会被
  // 算到别的插件名下，那个插件 HMR 时一句 removeOwnedStyles 就带走整颗 pill 的配色。
  const harness = load({ react: FAKE_REACT, slots: true })
  harness.mountPill()
  await flush()
  const style = harness.fakeDocument().head.children.find((node) => node.tag === 'style')
  assert.ok(style, '样式要注入到 head')
  assert.equal(style!.getAttribute('data-plugin'), 'dsh-remote-control', '宿主认领样式靠的就是它')
  assert.equal(
    style!.getAttribute('data-plugin-css'),
    'dsh-remote-control/pill.css',
    '我们自己的探针属性也要留着——按它把旧内容对齐成这一版',
  )

  // 上一版插的那份（只有 data-plugin-css）在热更路径上也要补上认领标记。
  const stale = load({ react: FAKE_REACT, slots: true, staleStyle: true })
  stale.mountPill()
  await flush()
  assert.equal(
    stale.fakeDocument().seededStyle!.getAttribute('data-plugin'),
    'dsh-remote-control',
    '宿主热更这一半、文档没重载时，head 里那份旧 style 同样要补上 data-plugin',
  )
})

test('CSS：.drc-note-block 必须排在 .drc-note 之后，否则那条 margin-top 是死规则', async () => {
  // 两者同特异度（都只一个类），`margin: 4px 0 0` 写在后面就整条盖掉前面的 `margin-top: 10px`。
  const harness = load({ react: FAKE_REACT, slots: true })
  harness.mountPill()
  await flush()
  const css = harness.fakeDocument().head.children.find((node) => node.tag === 'style')?.textContent ?? ''
  const noteAt = css.indexOf('.drc-note {')
  const blockAt = css.indexOf('.drc-note-block')
  assert.ok(noteAt >= 0 && blockAt >= 0, `两条规则都要在：${css.slice(0, 120)}`)
  assert.ok(
    blockAt > noteAt,
    '同特异度下后来的赢：写在 .drc-note 前面的话，margin-top:10px 会被它的 margin:4px 0 0 覆盖成死规则',
  )
  assert.match(css.slice(blockAt, blockAt + 60), /margin-top: 10px/, '离线那一屏第一行靠它跟上面拉开距离')
})

test('每条请求都带 3 秒硬超时的 signal：宿主卡住时请求必须自己收场', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, paired: 1, pairings: 1 } })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  root.find('drc-btn')!.emit('click') // 退出配对：这条写路由也要有超时
  await flush()
  assert.ok(harness.signals.length >= 3, `status / 发码 / 解配三条都要走到，实际只有 ${harness.signals.length} 条`)
  for (const signal of harness.signals) {
    assert.ok(
      signal instanceof AbortSignal,
      `每条 fetch 都要带 AbortSignal.timeout(3000) 的 signal，实际：${String(signal)}`,
    )
  }
})

test('轮询有 in-flight 守卫：上一发还没落地时，后面几拍不再叠请求', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, statusPending: true })
  harness.mountPill()
  await flush()
  const statusRequests = (): number => harness.requests.filter((url) => url.startsWith(PAIR_STATUS_ROUTE)).length
  assert.equal(statusRequests(), 1, '挂载时那一发')
  await harness.fireAndFlush(0)
  await harness.fireAndFlush(0)
  assert.equal(statusRequests(), 1, '上一发还挂着（宿主卡住），后两拍不许再叠——原来每 2 秒就多一个永不落地的请求')
})

test('中继那一行只印 host:port：scheme / userinfo / path / query 都不许上屏', async () => {
  const cases: Array<[unknown, string | undefined]> = [
    ['wss://relay.example.com:443/relay', 'relay.example.com:443'],
    ['relay.example.com:443', 'relay.example.com:443'],
    // userinfo 是这一段里唯一可能带凭据的东西：面板上印 user:pass@host 等于把凭据抄给看屏幕的人。
    ['wss://user:pass@relay.example.com:443/relay?token=1', 'relay.example.com:443'],
    ['https://[::1]:8443/x', '[::1]:8443'],
    // 拿不到值那一行不占地方（老版宿主没给 serverUrl）。
    ['', undefined],
  ]
  for (const [serverUrl, expected] of cases) {
    const harness = load({
      react: FAKE_REACT,
      slots: true,
      status: { ...DEFAULT_STATUS, paired: 1, pairings: 1, serverUrl },
    })
    const root = harness.mountPill()
    await flush()
    root.find('drc-pill')!.emit('click')
    await flush()
    const row = root.findAll('drc-info').find((candidate) => candidate.find('drc-key')!.textContent === '中继')
    const value = row ? row.find('drc-value')!.textContent : undefined
    assert.equal(value, expected, `serverUrl=${JSON.stringify(serverUrl)} 时那一行写成了「${String(value)}」`)
    assert.ok(!root.allText().includes('user:pass'), `面板里不许出现 userinfo：${root.allText().slice(0, 200)}`)
  }
})

test('关面板与卸载都要把定时器清干净：倒计时不许变成孤儿节拍', async () => {
  // 夹具原来 `clearInterval: () => {}` 是空实现、也不记 timer，于是"清没清"完全没测。
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    newAnswer: { state: 'ready', epoch: 'e1', token: '482913', expiresInMs: 60_000 },
  })
  const root = harness.mountPill()
  await openPairing(root)
  assert.equal(harness.liveTimerCount(), 2, '码在屏上：状态轮询 + 倒计时')

  root.find('drc-pill')!.emit('click') // 再按一次那颗 pill = 收面板
  assert.equal(root.find('drc-panel'), undefined, '前提：面板关上了')
  assert.equal(harness.liveTimerCount(), 1, '关面板要把倒计时清掉，只留状态轮询')

  await openPairing(root)
  assert.equal(harness.liveTimerCount(), 2, '重开一张码，倒计时重新起表')
  harness.unmountPill()
  assert.equal(harness.liveTimerCount(), 0, '卸载之后一个节拍都不许留（宿主重挂会再建一份，不清就是每次多一份）')
})
