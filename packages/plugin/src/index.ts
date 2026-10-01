/**
 * dsh-remote-control — DSH bundle entry (host side).
 *
 * Activation follows the proven pattern from community remote plugins:
 *   1. gate on carriers with ctx.inject([...]) so a missing relay server or
 *      kernel face never blocks Harness startup;
 *   2. feature-detect typertGateway (rc.1+) and fall back to apiProxy
 *      (dsh-v0.1.1-rc.2);
 *   3. provide `dshRemoteControl` for future UI slices;
 *   4. keep-awake lives inside HostRuntime and is released on disposal.
 *
 * Config source: the entry's volatile Cordis Config (rc.1+) via the patch
 * layer (`packages/plugin/cordis.patch.yml`), plus environment overrides
 * (DRC_SERVER_URL / DRC_HOST_TOKEN / DRC_HOST_LABEL).
 */
import type { Payload } from '@dsh-rc/protocol'
import { HostRuntime } from './host-runtime.js'
import { MockHarnessBridge } from './adapter-mock.js'
import { DshKernelBridge, type ApiProxyLike, type GatewayLike } from './adapter-dsh.js'

/** Loose cordis context — we never hard-depend on @deepseek-ai/cordis types. */
interface LooseContext {
  inject(names: string[], fn: (ctx: LooseContext) => void | Promise<void>): unknown
  get<T = unknown>(name: string, optional?: false): T
  get<T = unknown>(name: string, optional: true): T | undefined
  provide?(name: string, value: unknown): unknown
  effect(fn: () => unknown): unknown
  fiber?: unknown
  [key: string]: unknown
}

interface SettingsFormsLike {
  configure(section: unknown, fiber?: unknown): unknown
  replace?(entryId: string, section: unknown): unknown
}

export interface PluginConfig {
  enabled: boolean
  serverUrl: string
  hostToken: string
  hostTokenEnv: string
  hostLabel: string
  keepAwake: { enabled: boolean; idleReleaseSec: number; keepDisplay: boolean }
  mockBridge: boolean
}

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  serverUrl: 'ws://127.0.0.1:8787',
  hostToken: '',
  hostTokenEnv: 'DRC_HOST_TOKEN',
  hostLabel: 'dsh-host',
  keepAwake: { enabled: true, idleReleaseSec: 300, keepDisplay: false },
  mockBridge: false,
}

function readConfig(ctx: LooseContext, injected: Partial<PluginConfig> | undefined): PluginConfig {
  const cfg: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...injected,
    keepAwake: { ...DEFAULT_CONFIG.keepAwake, ...(injected?.keepAwake ?? {}) },
  }
  if (process.env.DRC_SERVER_URL) cfg.serverUrl = process.env.DRC_SERVER_URL
  const envToken = cfg.hostTokenEnv ? process.env[cfg.hostTokenEnv] : undefined
  if (envToken) cfg.hostToken = envToken
  if (process.env.DRC_HOST_LABEL) cfg.hostLabel = process.env.DRC_HOST_LABEL
  return cfg
}

export function apply(ctx: LooseContext, injected: Partial<PluginConfig> | undefined = undefined): void {
  const cfg = readConfig(ctx, injected)
  if (!cfg.enabled) return

  // rc.1+ settings page policy: the plugin ships its own status card; no
  // auto-generated form. Feature-detected so legacy registry generations skip.
  try {
    ctx.inject(['settings'], (c) => {
      const settings = c.get<SettingsFormsLike>('settings')
      if (typeof settings?.configure === 'function') {
        try {
          c.effect(() => settings.configure({ auto: false }, c.fiber))
        } catch {
          /* non-fatal */
        }
      }
    })
  } catch {
    /* settings not present in this profile (e.g. headless) */
  }

  if (!cfg.hostToken) {
    console.warn(
      '[dsh-remote-control] host token missing — set config.hostToken or env %s. Plugin stays idle until configured.',
      cfg.hostTokenEnv,
    )
    return
  }

  let runtime: HostRuntime | null = null

  const start = (gateway: GatewayLike | null, apiProxy: ApiProxyLike | null): void => {
    if (runtime) return
    const bridge =
      cfg.mockBridge || (gateway === null && apiProxy === null)
        ? new MockHarnessBridge()
        : new DshKernelBridge({ gateway, apiProxy, log: (m, x) => console.log('[dsh-remote-control]', m, x ?? '') })
    runtime = new HostRuntime({
      config: {
        serverUrl: cfg.serverUrl,
        hostToken: cfg.hostToken,
        hostLabel: cfg.hostLabel,
        keepAwakeEnabled: cfg.keepAwake.enabled,
        keepAwakeIdleSec: cfg.keepAwake.idleReleaseSec,
        keepDisplay: cfg.keepAwake.keepDisplay,
      },
      bridge,
      log: (m, x) => console.log('[dsh-remote-control]', m, x ?? ''),
    })
    runtime.start()
    ctx.effect?.(() => () => runtime?.stop())
    console.log(`[dsh-remote-control] host runtime started → ${cfg.serverUrl} (carrier=${bridge instanceof MockHarnessBridge ? 'mock' : 'dsh'})`)
  }

  // Prefer the Typert carrier (rc.1+ / 0.2.x); fall back to apiProxy
  // (dsh-v0.1.1-rc.2). Both are soft: if neither is injectable we still run
  // with the mock bridge only when explicitly configured.
  let startedViaInject = false
  try {
    ctx.inject(['typertGateway'], (c) => {
      if (runtime) return
      startedViaInject = true
      start(asGateway(c.get('typertGateway')), null)
    })
    startedViaInject = true
  } catch {
    startedViaInject = false
  }
  if (!startedViaInject) {
    try {
      ctx.inject(['apiProxy'], (c) => {
        if (runtime) return
        start(null, asApiProxy(c.get('apiProxy')))
      })
      startedViaInject = true
    } catch {
      /* fallthrough */
    }
  }
  if (!startedViaInject && cfg.mockBridge) {
    start(null, null)
  }

  // Expose runtime for any UI/other plugin consumers.
  try {
    ctx.provide?.('dshRemoteControl', {
      get state() {
        return runtime?.state ?? { relay: 'offline' }
      },
      createPairing: (ttlMs?: number) => runtime?.createPairing(ttlMs) ?? null,
      stop: () => runtime?.stop(),
    })
  } catch {
    /* provide unsupported in this generation — ignore */
  }

  // /remote-style TUI command when commands registry exists (dsh-TUI).
  try {
    const commands = ctx.get<{ register(def: unknown): unknown }>('commands', true)
    if (commands?.register) {
      commands.register({
        name: 'drc',
        description: 'DSH Remote Control: status | pair [ttl]',
        input: { hint: '[status | pair [ttlSec]]' },
        handler: async (line: string) => {
          const parts = String(line ?? '').trim().split(/\s+/)
          const sub = parts[1] ?? 'status'
          if (sub === 'pair') {
            const ttl = Number(parts[2] ?? 120) * 1000
            const p = runtime?.createPairing(ttl)
            return p ? `pair token ${p.token}\nQR ${p.qr}` : 'runtime not started'
          }
          return JSON.stringify(runtime?.state ?? { relay: 'offline' }, null, 2)
        },
      })
    }
  } catch {
    /* commands face differs per generation — soft */
  }
}

function asGateway(v: unknown): GatewayLike | null {
  const g = v as GatewayLike | null | undefined
  if (!g || typeof g.invoke !== 'function') return null
  return g
}

function asApiProxy(v: unknown): ApiProxyLike | null {
  const a = v as ApiProxyLike | null | undefined
  if (!a || typeof a.respond !== 'function' || !a.events?.mux) return null
  return a
}

export type { Payload }
export { HostRuntime } from './host-runtime.js'
export { MockHarnessBridge } from './adapter-mock.js'
export { DshKernelBridge } from './adapter-dsh.js'
export { RelayClient } from './relay-client.js'
export { handlePayload, type HarnessBridge } from './bridge.js'
