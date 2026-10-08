/**
 * pill — 状态栏那颗 pill 的宿主侧接线：软探测 `webServer`、挂四条路由、收干净。
 *
 * 2026-10-03 这一半原来还带着"右栏自动弹码"：按节拍看当前码、渲染 PNG、写进会话工作区、
 * 再经一条只读路由把 `dsh-resource://` 地址交给浏览器面。那套整个删了——配对入口现在只有
 * 这颗 pill，而 pill 要图的时候自己发请求（`pill-routes.ts`），宿主侧不需要任何节拍。
 *
 * **隔离仍然必须由代码提供**（原来是靠"拆成两个 cordis 条目"这个结构提供的）：
 *
 * 1. 只软探测 `webServer` 一个服务，且**绝不写 `inject:` 闸门**——写了闸门会让"这代宿主没这个
 *    服务"时整行不激活，配对/中继一行都不受影响那条就破了。拿不到服务就什么都不做，
 *    `probe.webServer` 里留下为什么。
 * 2. 它抛出的任何东西都不许到达调用方。调用方（`applyInner`）外面还有一层 try，两个都要有：
 *    主插件的 fiber 一旦 FAILED，宿主会把它的 inject 子 fiber 一起 dispose，配对链路会跟着没
 *    （真机取证见 `src/index.ts` 的 apply() 注释）。
 * 3. 与右栏那半同一条纪律：`stop()` 幂等，注销抛错只吞不抛。
 *
 * `available` 是**唯一**被主插件用来决定"配对入口还在不在"的信号：路由挂不上时屏幕上不会有
 * 那颗 pill，而 `/drc pair` 已经删掉了，所以主插件必须把它报成一条 `problems`（见 index.ts），
 * 否则表现就是"配不了对且没有任何地方说为什么"。
 */
import { registerPillRoutes, type PillRouteDeps, type WebServerLike } from './routes.js'

/** 只用到 ctx 的几个成员，所以不硬依赖 `@deepseek-ai/cordis` 的类型。 */
interface LooseContext {
  get?<T>(name: string, optional: true): T | undefined
  inject?(names: string[], callback: (scoped: unknown) => void): unknown
}

export interface PillHandle {
  stop(): void
  /** 排错入口：为什么没起 / 服务是从哪条路拿到的 / 路由挂上没。 */
  readonly probe: Record<string, string>
  /** 那四条路由**是否真的挂上了**——没挂上就没有配对入口。 */
  readonly available: boolean
}

/** 起 pill 的那四条路由。`enabled:false` 时什么都不做。返回句柄；`stop()` 幂等。 */
export function startPill(ctx: LooseContext, deps: PillRouteDeps & { enabled: boolean }): PillHandle {
  const { log } = deps
  const probe: Record<string, string> = {}
  let web: WebServerLike | undefined
  let unregister: (() => void) | undefined
  let started = false
  let stopped = false

  const tryStart = (): void => {
    if (started || stopped || !web) return
    started = true
    try {
      unregister = registerPillRoutes(web, {
        ensureFresh: () => deps.ensureFresh(),
        current: () => deps.current(),
        status: () => deps.status(),
        unpair: () => deps.unpair(),
        log,
      })
      probe.routes = 'registered'
    } catch (error) {
      probe.routes = `register threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
      started = false
      log('pill 路由注册失败（配对链路不受影响）', {
        message: String((error as Error)?.message ?? error).slice(0, 200),
      })
      return
    }
    log('pill routes started')
  }

  /** 收下这个服务：形状不对就不收（收下不合法的对象比不收更糟）。 */
  const acceptWebServer = (value: unknown, via: string): boolean => {
    if (!value || typeof value !== 'object') return false
    if (typeof (value as WebServerLike).register !== 'function') {
      probe.webServer = 'object without register()'
      return false
    }
    web = value as WebServerLike
    probe.webServer = via
    tryStart()
    return true
  }

  /** 从一个候选（作用域上下文或服务本身）里取 `webServer`。 */
  const pickFrom = (source: unknown): unknown => {
    if (!source || typeof source !== 'object') return undefined
    const asContext = source as { get?: (n: string, optional: true) => unknown }
    if (typeof asContext.get === 'function') {
      try {
        const got = asContext.get('webServer', true)
        if (got) return got
      } catch {
        /* 这个候选没有该服务 */
      }
    }
    try {
      return (source as Record<string, unknown>)['webServer']
    } catch {
      return undefined
    }
  }

  if (!deps.enabled) {
    probe.pill = 'disabled'
  } else {
    try {
      const found = ctx.get?.('webServer', true)
      if (found) acceptWebServer(found, 'via get')
      else probe.webServer = 'none'
    } catch (error) {
      // 真 cordis 的 ctx 是 Proxy：读一个没声明的服务名是**抛错**，`?.` 挡不住。
      probe.webServer = `get threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
    }
    try {
      ctx.inject?.(['webServer'], ((...args: unknown[]) => {
        try {
          for (const candidate of [args[0], ...args, ctx]) {
            if (acceptWebServer(pickFrom(candidate), 'via inject')) return
          }
          probe.webServer = `${probe.webServer ?? 'none'} (inject fired, empty)`
        } catch (error) {
          probe['injectThrew:webServer'] = String((error as Error)?.message ?? error).slice(0, 160)
        }
      }) as never)
    } catch (error) {
      probe['injectThrew:webServer'] = String((error as Error)?.message ?? error).slice(0, 160)
    }
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    const off = unregister
    unregister = undefined
    try {
      off?.()
    } catch {
      /* 宿主可能已经先一步把 webServer 拆了 */
    }
    if (started) log('pill routes stopped')
  }

  return {
    stop,
    probe,
    get available() {
      /**
       * `!stopped` 不能省（2026-10-06 修）：`started` 与 `probe.routes` 都是"起过"的痕迹，
       * `stop()` 不会把它们抹掉——少了这一条，停掉之后仍报 `available: true`，
       * 而主插件正是拿它决定要不要报那条 `warn:pill`（`src/index.ts`），
       * 表现就是"路由已经摘干净了，快照还说配对入口在"。
       */
      return !stopped && started && probe.routes === 'registered'
    },
  }
}
