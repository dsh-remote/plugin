/**
 * entry — presentation 包的 cordis 入口（宿主侧）。
 *
 * 这一半只做三件事：把主插件 `provide` 的 `dshRemoteControl.state.pairing` 每隔
 * `refreshMs` 看一版并渲染落盘、把一个同域只读路由挂到 `webServer` 上、卸载时把
 * 定时器和路由都收回。业务判断在 `presenter.ts`，地址编码在 `address.ts`，
 * 路由的安全姿态与回答形状在 `route.ts`。
 *
 * 三条纪律（与主插件 `packages/plugin/src/index.ts` 同款，理由也一样）：
 *
 * 1. **`apply()` 绝不向外抛**。抛出去会让宿主的那一行 fiber 失败；本包存在的意义是
 *    一个**可选**的预览增强，绝不能因为自己没有服务可用就把宿主的加载流程弄脏。
 * 2. **不写 `inject:` 闸门**：对 `dshRemoteControl` / `webServer` 都软探测
 *    （`ctx.get(name, true)` + `ctx.inject([name], cb)` 双路），谁先到都能起。
 * 3. **inject 回调的参数是作用域化上下文，不是服务实例**（主插件踩过的坑：
 *    按"回调参数=服务"写会六个服务全 none 且不报错）。所以回调里逐候选试
 *    `candidate.get(name, true)` 与直接读属性，两条都包 try。
 */
import { readConfig, validateConfig, type PresentationConfig } from './config.js'
import { liveDeps, PairingPresenter, type ActivePairing } from './presenter.js'
import { registerPairingRoute, type WebServerLike } from './route.js'

/**
 * 我们只用到 ctx 的几个成员，所以不硬依赖 `@deepseek-ai/cordis` 的类型。
 * `get` 的第二参 `true` 是"拿不到就返回 undefined"，不加它读一个不存在的服务是抛错。
 */
interface LooseContext {
  get?<T>(name: string, optional: true): T | undefined
  inject?(names: string[], callback: (scoped: unknown) => void): unknown
  /**
   * cordis 唯一的卸载钩子。**没有 `onDispose` 这个东西**——ctx 是 Proxy，读不存在的
   * 属性名是抛错而不是 undefined，`?.` 挡不住（主插件的真机取证）。
   */
  effect?(execute: () => (() => unknown) | void): unknown
}

/** 主插件 `provide('dshRemoteControl', ...)` 的形状（这里只看 `state.pairing`）。 */
interface RemoteControlLike {
  readonly state?: { readonly pairing?: unknown } | undefined
}

export interface PresentationHandle {
  stop(): void
}

/** 宿主加载 bundle 时调它。**绝不向外抛**。 */
export function apply(ctx: LooseContext, injected: Partial<PresentationConfig> = {}): void {
  let handle: PresentationHandle | undefined
  try {
    handle = applyInner(ctx, injected)
  } catch (error) {
    try {
      process.stderr.write(`[dsh-remote-control-presentation] apply failed: ${String((error as Error)?.stack ?? error)}\n`)
    } catch {
      /* stderr 也可能不可用 */
    }
  }
  let hooked = false
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => void handle?.stop())
      hooked = true
    }
  } catch {
    /* 没有 effect 口的代际 */
  }
  if (!hooked && 'onDispose' in ctx) {
    // `'x' in ctx` 走的是 Proxy 的 has trap，不抛错——探测属性存在与否的唯一安全姿势。
    try {
      ;(ctx as { onDispose?: (fn: () => void) => void }).onDispose?.(() => void handle?.stop())
    } catch {
      /* 同上 */
    }
  }
}

function applyInner(ctx: LooseContext, injected: Partial<PresentationConfig>): PresentationHandle | undefined {
  const config = readConfig(injected)
  const log = (message: string, fields: Record<string, string | number | boolean | undefined> = {}): void => {
    try {
      process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: `dsh-remote-control-presentation ${message}`, ...fields })}\n`)
    } catch {
      /* GUI 宿主里 stdout 可能不可用 */
    }
  }

  const problems = validateConfig(config)
  for (const problem of problems) log(`config ${problem.level}`, { field: problem.field, message: problem.message })
  if (!config.enabled) {
    log('disabled')
    return undefined
  }
  if (problems.some((problem) => problem.level === 'error')) {
    log('not started: invalid config')
    return undefined
  }

  const presenter = new PairingPresenter(liveDeps(config.imageFile, log))
  const collected: { remote?: RemoteControlLike; web?: WebServerLike } = {}
  const probe: Record<string, string> = {}
  let timer: ReturnType<typeof setInterval> | undefined
  let unregister: (() => void) | undefined
  let started = false
  let stopped = false

  /** 看一眼当前配对码。任何一步抛出都只记一行，节拍继续。 */
  const tick = async (): Promise<void> => {
    const remote = collected.remote
    if (!remote) return
    let pairing: ActivePairing | null = null
    try {
      const state = remote.state
      const raw = state && typeof state === 'object' ? (state as { pairing?: unknown }).pairing : undefined
      pairing = raw && typeof raw === 'object' ? (raw as ActivePairing) : null
    } catch (error) {
      log('read pairing state failed', { message: String((error as Error)?.message ?? error).slice(0, 160) })
      return
    }
    try {
      await presenter.observe(pairing)
    } catch (error) {
      // observe 自己已经吞了渲染/落盘异常；这里只兜"别的意外"。
      log('observe failed', { message: String((error as Error)?.message ?? error).slice(0, 160) })
    }
  }

  /** 两个服务都到齐才开始跑：只有 remote 没有 web 时，图落了盘也没人知道地址。 */
  const tryStart = (): void => {
    if (started || stopped) return
    if (!collected.remote || !collected.web) return
    started = true
    try {
      unregister = registerPairingRoute(collected.web, {
        imageFile: config.imageFile,
        snapshot: () => presenter.snapshot(),
      })
      probe.route = 'registered'
    } catch (error) {
      probe.route = `register threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
      log('route registration failed', { message: String((error as Error)?.message ?? error).slice(0, 200) })
      started = false
      return
    }
    timer = setInterval(() => void tick(), config.refreshMs)
    // 不 unref 的话，任何一次性跑法（headless/CLI/e2e）都会被这个节拍钉住不退出。
    timer.unref?.()
    void tick()
    log('started', { imageFile: config.imageFile, refreshMs: config.refreshMs })
  }

  /** 一个候选来源里取出 `name`：先按作用域上下文读，读不到再按"直接就是服务"读。 */
  const pickFrom = (source: unknown, name: string): unknown => {
    if (!source || typeof source !== 'object') return undefined
    const asContext = source as { get?: (n: string, optional: true) => unknown }
    if (typeof asContext.get === 'function') {
      try {
        const got = asContext.get(name, true)
        if (got) return got
      } catch {
        /* 这个候选没有该服务 */
      }
    }
    try {
      return (source as Record<string, unknown>)[name]
    } catch {
      return undefined
    }
  }

  /** 收下一个服务：形状不对就不收（收下不合法的对象比不收更糟）。 */
  const accept = (name: 'dshRemoteControl' | 'webServer', value: unknown, via: string): boolean => {
    if (!value || typeof value !== 'object') return false
    if (name === 'webServer' && typeof (value as WebServerLike).register !== 'function') {
      probe[name] = 'object without register()'
      return false
    }
    if (name === 'dshRemoteControl') collected.remote = value as RemoteControlLike
    else collected.web = value as WebServerLike
    probe[name] = via
    tryStart()
    return true
  }

  for (const name of ['dshRemoteControl', 'webServer'] as const) {
    try {
      const found = ctx.get?.(name, true)
      if (found) accept(name, found, 'via get')
      else probe[name] = 'none'
    } catch (error) {
      probe[name] = `get threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
    }
    try {
      ctx.inject?.([name], ((...args: unknown[]) => {
        try {
          let value: unknown
          let from: unknown
          for (const candidate of [args[0], ...args, ctx]) {
            value = pickFrom(candidate, name)
            if (value) {
              from = candidate
              break
            }
          }
          if (accept(name, value, 'via inject')) return
          probe[name] = `${probe[name] ?? 'none'} (inject fired, empty)`
        } catch (error) {
          probe[`injectThrew:${name}`] = String((error as Error)?.message ?? error).slice(0, 160)
        }
      }) as never)
    } catch (error) {
      probe[`injectThrew:${name}`] = String((error as Error)?.message ?? error).slice(0, 160)
    }
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    try {
      unregister?.()
    } catch {
      /* 宿主可能已经先一步把 webServer 拆了 */
    }
    unregister = undefined
    log('stopped')
  }

  return { stop }
}
