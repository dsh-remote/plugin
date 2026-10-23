/**
 * carrier-probe —— 载体探测：`services > (mock)`（v5 R2c 从 `index.ts` 抽出）。
 *
 * 从宿主注入里认出 kernel 面（sessions 服务）→ 起 runtime；认不出就试 mock 桥；
 * 两头都没有就说清原因。**取证**（apply 轨迹 / inject 子 fiber / fiber 生命周期）
 * 也在这里：它只记录现场、不改变行为，是"配不了对"排查链的第一环。
 *
 * ⚠️ **行为零变化**（R2 纪律）：判据一片未动照样全绿。
 */
import type { Clock } from '../ports/index.js'
import { guardedSubscribe } from '../platform/guard.js'
import type { createOneShotTimers } from './clock.js'
import { SERVICE_NAMES, type HostContext } from './host-context.js'

export interface CarrierProbeDeps {
  clock: Clock
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  config: { newSessionCwd?: string; mockBridge: boolean }
  startKernel(kernel: unknown): void
  createServicesKernel(collected: never, options: Record<string, unknown>): unknown
  getRuntime(): { pendingKindForSession(sessionId: string): string | undefined } | undefined
  applyCount: { n: number }
  /** 宿主注入面（cordis Proxy：只碰 `HostContext` 列出来的那些面）。 */
  ctx: HostContext
  /** 一次性定时器（guardedSubscribe 的喂养口；取消口径在 index 的 stop 里）。 */
  oneShot: ReturnType<typeof createOneShotTimers>
  /** 复查落地时把探针结论写进 status（state() 在 index，闭包搬不动）。 */
  writeStatus(extra: Record<string, unknown>): void
  /** 认领还在路上吗（pending 时不动手，见文件尾那条纪律）。 */
  isClaimPending(): boolean
}

export function createCarrierProbe(deps: CarrierProbeDeps) {
  // ── 载体探测：services > (mock) ────────────────────────────────────
  const collected: Record<string, unknown> = {}
  const hasServices = (): boolean => typeof collected.sessions === 'object' && collected.sessions !== null

  // wanted 是**布尔表**，不是字符串 —— 它回答"装没装"，值天然是 true/false。
  const probe: Record<string, string | Record<string, boolean>> = {}
  const injectFired: string[] = []
  let hasGet = true
  let hasInject = true
  let decided = false
  /** 取证：`deps.ctx.inject` 返回的子 fiber，用来区分"依赖没满足"和"子 fiber 已被拆掉"。 */
  const injectChildren: [string, unknown][] = []
  /** 取证：我们这条 fiber 的生命周期轨迹（含进入 UNLOADING/DISPOSED 时的调用栈）。 */
  const states: string[] = []
  const tryStart = (): void => {
    if (deps.getRuntime()) return
    if (hasServices()) {
      if (decided) {
        // 服务热补丁进同一个对象：runtime 已经持有它的引用，不需要重启。
        return
      }
      decided = true
      // newSessionCwd 透传：新建会话用哪个项目目录（见 carrier-services 的 newSession——
      // 不给的话宿主用 process.cwd() 兜底，真机上是 /，会话就不在任何用户项目里）。
      deps.startKernel(
        deps.createServicesKernel(collected as never, {
          log: deps.log,
          clock: deps.clock,
          newSessionCwd: deps.config.newSessionCwd,
          // `awaiting-permission` / `awaiting-answer` 这两个会话状态只有 runtime 知道
          //（内核只答得出"在不在跑"），而小程序列表与「等你处理」区只认这两个字符串——
          // 不接上它们，真机上那个区永远是空的（判据见 carrier 的 pendingKindForSession
          // 注释）。collect 早于 start，所以这里传的是一个**惰性查询**而不是值。
          pendingKindForSession: (sessionId: string) => deps.getRuntime()?.pendingKindForSession(sessionId),
        }),
      )
      return
    }
    // 没有 services 载体就不启动，也不退回 apiProxy/typert：桌面态从未注册 apiProxy 服务，
    // 而它的调用信封在旧实现里整个是错的、无法验证；typert 只有 invoke()，既不能列会话
    // 也不能发指令，接上去只是一台"永远空列表"的机器。这两条**探都不探**：真要用再写，
    // 留着只是让"下一版会不会接上"变成读代码的人去猜。
    // （取证 docs/legacy-spec/host-plugin-cordis.md §2.4 表与 §3 表第 14-19 行）
  }

  /** 关键成员先验：收下不合法的对象比不收更糟（旧实现踩过的坑）。 */
  const requiredMember: Record<string, string> = { sessions: 'list', sessionQuery: 'listSessions', agents: 'get' }
  /** 把服务对象的前几个成员拼成可读指纹；这是取证，绝不许抛。 */
  const keysOf = (value: unknown): string => {
    try {
      return Object.keys(value as object)
        .slice(0, 6)
        .join('|')
    } catch (error) {
      return `keys threw: ${String((error as Error)?.message ?? error).slice(0, 60)}`
    }
  }
  /** 一个候选来源里取出 `name`：先按"作用域上下文"读，读不到再按"直接就是服务"读。 */
  const pickFrom = (source: unknown, name: string): unknown => {
    if (!source || typeof source !== 'object') return undefined
    const asContext = source as HostContext
    if (typeof asContext.get === 'function') {
      try {
        const got = asContext.get(name, true)
        if (got) return got
      } catch {
        /* 这个候选没有该服务 */
      }
    }
    try {
      // 直接点属性在 cordis 上下文上只在"这个名字已注入本 fiber"时成立，否则 get trap
      // 抛错（不是返回 undefined）——所以这里必须包 try。
      return (source as Record<string, unknown>)[name]
    } catch {
      return undefined
    }
  }
  /**
   * 把某个上下文（根 deps.ctx 或 `deps.ctx.inject` 回调给的作用域上下文）的 `on`/`off` 绑到
   * 服务对象上——carrier 的 `subscribe()` 与交互面登记都读 `services.on`。
   *
   * **为什么必须单独一条，而不是塞在 `accept()` 里**（2026-10-06 真机取证）：
   * `tryStart()` 在 `deps.ctx.get('sessions', true)` **同步可得**时会在任何 inject 回调
   * **之前**就把内核启起来，而 `collected.on` 那时还只在 `accept('sessions', …)`
   * 里绑——晚一步的后果是 `subscribe()` 读到 `services.on === undefined`，
   * 记一句 `kernel has no on(); streaming disabled` 并永久返回空退订；
   * `HostRuntime.start()` 有 started 闸门不会重试，于是**该进程内流式全黑**，
   * 而 `describe()` 的 `hasOn` 每次现读（那时 on 早绑上了）会显示 true 掩盖真相。
   * 现在：拿到任意服务、任意候选上下文时先绑一次，晚到的 inject 回调再补一次。
   *
   * 两处读取**各自包 try**：cordis 的 deps.ctx 是 Proxy，读一个它这个作用域里没有的属性名
   * 是**抛错**而不是返回 undefined（真机：`cannot get property "off" without inject`,
   * 就是本文件 110-119 行那条结论）。`typeof`/`?.` 都挡不住 get trap，
   * 所以只能用 try——而且 off 单独一段，它抛不能把 on 的绑定一起带走。
   */
  const bindScopedEvents = (source: unknown): void => {
    if (!source || typeof source !== 'object') return
    const asContext = source as HostContext
    /**
     * 只认"看起来像上下文"的候选（有 `get`）。回调参数里除了作用域上下文还有别的东西
     * （配置对象等），而某个**服务对象**自己也带一个同名 `on` 时，绑错了就是
     * "订阅装到了没有事件派发能力的对象上"——比没绑更难查。
     * 判别方式与 `pill/start.ts` 的 `pickFrom` 完全一致。
     */
    try {
      if (typeof asContext.get !== 'function') return
    } catch {
      return
    }
    if (typeof collected.on !== 'function') {
      try {
        if (typeof asContext.on === 'function') collected.on = asContext.on.bind(asContext)
      } catch {
        /* 这个作用域读不到 on（或它抛了）：换下一个候选 */
      }
    }
    if (typeof collected.off !== 'function') {
      try {
        if (typeof asContext.off === 'function') collected.off = asContext.off.bind(asContext)
      } catch {
        /* 同上：真机上 off 比 on 更常见地"没注入" */
      }
    }
  }
  // 根上下文先绑一次：`deps.ctx.get` 那条同步路径拿到的服务也要能订阅（见上面那段取证）。
  bindScopedEvents(deps.ctx)

  /**
   * 收下探到的服务并尝试启动；`via` 只用于把"从哪条路拿到的"记进 probe。
   * 晚到的服务热补丁进同一个对象：runtime 已经持有它的引用，不需要重启。
   */
  const accept = (name: string, value: unknown, source: unknown, via: string): boolean => {
    if (!value || typeof value !== 'object') return false
    const member = requiredMember[name]
    if (member && typeof (value as Record<string, unknown>)[member] !== 'function') {
      probe[name] = `object without ${member}()`
      return false
    }
    collected[name] = value
    bindScopedEvents(source)
    probe[name] = `${via}(${keysOf(value)})`
    tryStart()
    return true
  }

  for (const name of SERVICE_NAMES) {
    try {
      if (typeof deps.ctx.get !== 'function') hasGet = false
      const found = deps.ctx.get?.(name, true)
      probe[name] = found
        ? typeof found === 'object'
          ? `object(${Object.keys(found as object)
              .slice(0, 6)
              .join('|')})`
          : typeof found
        : 'none'
      if (found) collected[name] = found
    } catch (error) {
      // 这一代宿主没这个服务
      probe[name] = `get threw: ${String((error as Error)?.message ?? error).slice(0, 60)}`
    }
    try {
      // 关键：`deps.ctx.inject(names, cb)` 的回调参数**不是服务实例，而是已作用域化的上下文**，
      // 要在回调里 `c.get(name, true)` 才拿得到东西（第一版按"回调参数=服务"写，
      // 结果六个服务全 none、carrier=none —— 这个形状错了比抛错更难查）。
      const child = deps.ctx.inject?.([name], ((...cbArgs: unknown[]) => {
        injectFired.push(`${name}(args=${cbArgs.length})`)
        probe.injectFiredLive = injectFired.join('|')
        // 回调整段包 try：这条子 fiber 的 apply 抛出会让 cordis 把它连同我们其它
        // 五条探测一起 dispose 掉，代价是"服务明明在、carrier 却起不来"。
        try {
          // 取证：不同代际这里拿到的可能是"作用域上下文"，也可能直接就是服务。逐个试。
          let value: unknown
          let from: unknown
          for (const candidate of [cbArgs[0], ...cbArgs, deps.ctx]) {
            // **先绑事件口再取服务**：`on` 只在这个作用域上下文上才读得到（根 deps.ctx 上不一定有），
            // 而 `accept()` 里的 `tryStart()` 可能就在这一句之后把 runtime 启起来 ——
            // 绑晚了 subscribe() 拿到的就是 undefined（该进程内流式全黑，见 bindScopedEvents）。
            bindScopedEvents(candidate)
            value = pickFrom(candidate, name)
            if (value) {
              from = candidate
              break
            }
          }
          if (accept(name, value, from, 'via inject')) return
          if (!value) probe[name] = `${probe[name] ?? 'none'} (inject fired, empty)`
        } catch (error) {
          probe[`injectThrew:${name}`] = String((error as Error)?.message ?? error).slice(0, 160)
        }
      }) as never)
      if (child !== undefined) injectChildren.push([name, child])
    } catch (error) {
      hasInject = false
      probe[name] = `${probe[name] ?? 'none'}; inject threw: ${String((error as Error)?.message ?? error).slice(0, 60)}`
    }
  }
  probe.hasGet = String(hasGet)
  probe.hasInject = String(hasInject)
  /**
   * 一次性取证：这一代宿主到底给了 deps.ctx 什么。猜"名字对不对"之前先看形状。
   *
   * **逐句包 try**：`Object.keys(deps.ctx)` / `getPrototypeOf(deps.ctx)` / `deps.ctx.effect` / `deps.ctx.fiber`
   * 在这台宿主上都是 Proxy 的 trap（ownKeys / getPrototypeOf / get），
   * 读不到不是返回 undefined 而是**抛错**（本文件 110-119 行那条结论；
   * `cannot get property "off" without inject` 就是同一个洞里出来的）。
   * 取证段自己抛出去的代价是整段 applyInner 中断——那正是最贵的那种故障。
   */
  try {
    probe.ctxKeys = Object.keys(deps.ctx).slice(0, 40).join('|')
  } catch (error) {
    probe.ctxKeys = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }
  try {
    probe.ctxProtoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(deps.ctx) ?? {})
      .slice(0, 40)
      .join('|')
  } catch (error) {
    probe.ctxProtoKeys = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }
  for (const candidate of ['sessions', 'agents']) {
    try {
      const strict = (deps.ctx as { get?: (n: string) => unknown }).get?.(candidate)
      probe[`strictGet:${candidate}`] = strict ? 'object' : 'undefined'
    } catch (error) {
      probe[`strictGet:${candidate}`] = `threw: ${String((error as Error)?.message ?? error).slice(0, 70)}`
    }
  }
  // 有些代际要靠 effect/fiber 才看得到服务；有就登记一条"等一会再看"的复查。
  // 注意 `injectFiredLive`（而不是任何在 apply 同步段里取的快照）才是"回调到底有没有
  // 触发"的证据：inject 回调最快也要一个微任务之后才跑，同步取的那一笔永远是 never。
  try {
    probe.hasEffect = String(typeof (deps.ctx as { effect?: unknown }).effect === 'function')
  } catch (error) {
    probe.hasEffect = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }
  try {
    probe.hasFiber = String(
      typeof (deps.ctx as { fiber?: unknown }).fiber === 'function' ||
        (deps.ctx as { fiber?: unknown }).fiber !== undefined,
    )
  } catch (error) {
    probe.hasFiber = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }

  // ── 取证（只记录现场，不改变行为）────────────────────────────────
  // 每一次猜错都要付一次"重启 Harness"的代价，所以把定根因需要的东西一次拿全：
  // 这个 cordis root 到底注册了哪些服务、我们的 fiber 挂在哪棵树上、谁调用了 apply。
  const asRecord = (value: unknown): Record<string | symbol, unknown> =>
    value && typeof value === 'object' ? (value as Record<string | symbol, unknown>) : {}
  const liveFiberChain = (): string[] => {
    const chain: string[] = []
    const seen = new Set<unknown>()
    let fiber: unknown = asRecord(deps.ctx).fiber
    while (fiber && !seen.has(fiber) && chain.length < 12) {
      seen.add(fiber)
      const record = asRecord(fiber)
      const entryId = asRecord(record.entry).id
      // state 数字即 cordis FiberState：0 PENDING / 1 LOADING / 2 ACTIVE / 3 DISPOSED / 4 UNLOADING
      chain.push(
        `${String(record.name ?? '?')}#${String(record.uid ?? 'null')}@${String(record.state ?? '?')}${entryId ? `[${String(entryId)}]` : ''}`,
      )
      fiber = asRecord(asRecord(record.parent).fiber === record.fiber ? null : asRecord(record.parent).fiber)
    }
    return chain
  }
  const liveStore = (): string[] => {
    const store = asRecord(asRecord(deps.ctx).reflect).store
    const names: string[] = []
    for (const key of Object.getOwnPropertySymbols(asRecord(store))) {
      const impl = asRecord(asRecord(store)[key])
      names.push(`${String(impl.name)}@${String(asRecord(impl.fiber).state ?? '?')}`)
    }
    return names
  }
  const liveIsolate = (): string[] => {
    const map = asRecord(deps.ctx)[Symbol.for('cordis.isolate')]
    // isolate map 是 Object.create(null) 的**原型链**，每条 loader entry 自己那一层
    // 往往是空的——只数 own key 会永远得到空串，必须用 for...in 连继承的一起看。
    const names: string[] = []
    for (const key in map as object) names.push(`${key}=${String(asRecord(map)[key])}`)
    return names
  }
  const collectForensics = (prefix: string): void => {
    try {
      probe[`${prefix}store`] = liveStore().join('|').slice(0, 900)
      probe[`${prefix}isolate`] = liveIsolate().join(',').slice(0, 900)
      probe[`${prefix}props`] = Object.getOwnPropertyNames(asRecord(asRecord(asRecord(deps.ctx).reflect).props))
        .slice(0, 160)
        .join('|')
      probe[`${prefix}fibers`] = liveFiberChain().join(' <- ').slice(0, 600)
      for (const name of SERVICE_NAMES) {
        const got = deps.ctx.get?.(name, true)
        probe[`${prefix}get:${name}`] = got
          ? `object(${Object.keys(got as object)
              .slice(0, 5)
              .join('|')})`
          : 'undefined'
      }
    } catch (error) {
      probe[`${prefix}forensicsThrew`] = String((error as Error)?.message ?? error).slice(0, 120)
    }
  }
  collectForensics('t0:')
  probe.injectFiredLive = injectFired.join('|') || 'never'
  // 生命周期取证：`internal/status` 是 emit-mode（cordis events.d.ts:219），订阅安全。
  // 只记自己这条 fiber；进入 UNLOADING/DISPOSED 时抓一次栈，看清是谁把我们拆掉的。
  deps.applyCount.n += 1
  probe.applyCount = `${String(deps.applyCount.n)}@${deps.clock.now()}`
  try {
    // **必须走 guard 的订阅口**（guard.ts 头注称自己是"事件订阅的唯一入口"）：
    // 这里直接 `deps.ctx.on(...)` 是绕过白名单的旁路 —— 今天这条是 emit-mode 所以没事，
    // 但明天有人把名字改成一条 waterfall，就只有这行代码不在护栏里。
    const on = (deps.ctx as { on?: (name: string, listener: (...args: unknown[]) => void) => unknown }).on
    if (typeof on === 'function') {
      guardedSubscribe(
        on.bind(deps.ctx) as never,
        'internal/status',
        ((fiber: unknown, oldState: unknown) => {
          if (asRecord(fiber) !== asRecord(deps.ctx).fiber) return
          const record = asRecord(fiber)
          const state = Number(record.state ?? -1)
          const entry = asRecord(record.entry)
          const error = record._error
          const tail = `${
            error
              ? ` err=${String((error as Error)?.name ?? '')}:${String((error as Error)?.message ?? error).slice(0, 200)} @${String(
                  (error as Error)?.stack ?? '',
                )
                  .split('\n')
                  .slice(1, 4)
                  .map((line) => line.trim().replace(/^at\s+/, ''))
                  .join(' <- ')}`
              : ''
          }${
            state >= 4
              ? ` stack=${String(new Error('drc-dispose').stack ?? '')
                  .split('\n')
                  .slice(1, 7)
                  .map((line) => line.trim().replace(/^at\s+/, ''))
                  .join(' <- ')
                  .slice(0, 400)}`
              : ''
          }`
          states.push(
            `${deps.clock.now()}:${String(oldState)}->${String(state)} entry=${String(entry.id ?? '?')}/disabled=${String(entry.disabled ?? '?')}${tail}`,
          )
          probe.fiberStates = states.join(' | ').slice(0, 1800)
        }) as never,
        (message: string, fields?: Record<string, string | number | boolean | undefined>) => deps.log(message, fields),
      )
    } else {
      probe.statusWatch = 'no on() on the root deps.ctx'
    }
  } catch (error) {
    probe.statusWatch = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }
  probe.processShape = [
    String((process as unknown as { type?: string }).type ?? ''),
    String((process.versions as unknown as { electron?: string }).electron ?? 'no-electron'),
    String(process.argv[2] ?? '')
      .split('/')
      .pop() ?? '',
    String(process.argv[3] ?? '')
      .split('/')
      .pop() ?? '',
  ].join('|')
  /**
   * `probe.wanted` 逐个点名回答的包（2026-10-06 宿主能力普查后定的）。
   *
   * 为什么点名而不倒全表：loader 有 50+ 条，status.json 会截断，
   * 倒全表的那一半**看起来就像没加载**，而那正是最容易得出错结论的用法。
   * 这里问的是"在不在"，答案短、不截断、且可复算。
   */
  const PROBE_PACKAGES = [
    'dsh-token-meter',
    'dsh-session-projection',
    'dsh-compaction-basic',
    'dsh-command-compact',
    'dsh-api-workspace-files',
    'dsh-client-file-upload',
    'dsh-experimental-api-speech-to-text',
    'dsh-llm-retry',
    'dsh-tool-todo',
  ] as const

  // 谁调用 apply：栈里能看出是 cordis-plugin-loader 还是别的包装层。
  probe.applyStack = String(new Error('drc-probe').stack ?? '')
    .split('\n')
    .slice(1, 9)
    .map((line) => line.trim().replace(/^at\s+/, ''))
    .join(' <- ')
    .slice(0, 900)
  try {
    const loader = deps.ctx.get?.('loader', true) as { entries?: () => Iterable<unknown> } | undefined
    if (typeof loader?.entries === 'function') {
      const rows: string[] = []
      for (const entry of loader.entries()) {
        const options = asRecord(asRecord(entry).options)
        rows.push(`${String(options.id ?? '?')}=${String(options.name ?? '?')}`)
        if (rows.length >= 300) break
      }
      // `loaderRows` 会被 status.json 的长度截断，所以**不能**拿它回答
      // "某个包到底加载了没有"——截断点之后的看起来就像没加载，而那正是
      // 最容易得出错误结论的用法（2026-10-06差点据此断言 token-meter 没挂）。
      // 要回答"装没装"用下面的 wanted：逐个点名，短、确定、不受截断影响。
      const all = rows.join(',')
      probe.wanted = Object.fromEntries(PROBE_PACKAGES.map((name) => [name, all.includes('@deepseek-ai/' + name)]))
      probe.loaderRows = all.slice(0, 2600)
    } else {
      probe.loaderRows = 'no-loader-service'
    }
  } catch (error) {
    probe.loaderRows = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }
  // 服务可能晚到：8s / 25s / 60s 各复查一次，把"根本没提供"和"提供得晚"分开。
  for (const delayMs of [8_000, 25_000, 60_000]) {
    try {
      deps.oneShot.schedule(() => {
        probe.injectFiredLive = injectFired.join('|') || 'never'
        probe.injectFired = probe.injectFiredLive
        collectForensics(`t${delayMs}:`)
        probe.injectChildren = injectChildren
          .map(([childName, child]) => {
            const record = asRecord(child)
            const store = asRecord(record.store)
            return `${childName}@${String(record.state ?? '?')}/uid${String(record.uid ?? 'null')}${store ? `[${Object.keys(store).join('|')}]` : ''}`
          })
          .join(' ')
        probe.fiberStates = states.join(' | ').slice(0, 1800)
        // 兜底：inject 子 fiber 若因任何原因没被唤醒，直接查 store——`deps.ctx.get` 不要求
        // inject，真机取证显示它在同一个 deps.ctx 上一直是拿得到的。
        for (const name of SERVICE_NAMES) {
          if (collected[name]) {
            // 已经收下了，但"从哪条路收的"那一笔可能没写进去（accept 里的取证写入是尽力而为）。
            if (!String(probe[name] ?? '').startsWith('via')) probe[name] = `via held(${keysOf(collected[name])})`
            continue
          }
          try {
            accept(name, deps.ctx.get?.(name, true), deps.ctx, 'via get@poll')
          } catch {
            /* 还是没有这个服务 */
          }
        }
        tryStart()
        deps.writeStatus({})
      }, delayMs)
    } catch {
      /* 时钟不可用就少一次复查，不影响主流程 */
    }
  }
  /**
   * 没有载具时的两件收尾：mock 兜底 + 一条"为什么什么都没起来"的面包屑。
   *
   * 抽成函数而不是留在原地内联（2026-10-11）：认领那条**异步**路落地时也要走这两步，
   * 抄第二遍就等于第二处会漂移（本项目"两处各写一份必然漂移"的老账）。
   */
  const startMockIfConfigured = (): void => {
    if (deps.getRuntime() || !deps.config.mockBridge || decided) return
    decided = true
    // mock 载体只为开发与冒烟存在：它的会话 id 一律 `ses_mock` 前缀，
    // 真链路测试里有专门一条断言"看到 ses_mock 就判失败"。
    import('../platform/mock-kernel.js')
      .then(({ createMockKernel }) => deps.startKernel(createMockKernel({ log: deps.log, clock: deps.clock })))
      .catch(() => {})
  }
  /** 载具一个都没起来时留下面包屑（`state()` 已经能回答"探到了什么"，这里补"结论"）。 */
  const reportNoCarrier = (): void => {
    deps.writeStatus({ carrier: 'none', reason: 'no-carrier' })
    deps.log('no kernel carrier available', { hint: '需要 sessions 服务，或把 mockBridge 打开做开发' })
  }

  /**
   * ⚠️ 构造尾句（`tryStart` / mock 兜底 / 无载具面包屑）**不在这里跑**：它们会经
   * `writeStatus` → `state()` 读到 index 侧的 `probe`，而那要等 `createCarrierProbe`
   * 返回、解构完成才有值（TDZ，2026-10-23 踩过）。调用方在装配完之后自己跑：
   * `carrier.tryStart(); if (!claimPending) { carrier.startMockIfConfigured(); … }`。
   */

  return {
    accept,
    bindScopedEvents,
    tryStart,
    reportNoCarrier,
    startMockIfConfigured,
    probe,
    injectChildren,
    states,
    collected,
  }
}
