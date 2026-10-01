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
import { spawn } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Payload } from '@dsh-rc/protocol'
import { HostRuntime } from './host-runtime.js'
import { MockHarnessBridge } from './adapter-mock.js'
import { DshKernelBridge, type ApiProxyLike, type GatewayLike, type InProcServices } from './adapter-dsh.js'
import { qrPng, renderTerminalQr, type QrStyle } from './qr.js'

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
  /** where to drop a live status snapshot; '' disables it */
  statusFile: string
  /**
   * Restore an archived session before prompting it. An archived session is
   * refused by the host's archived-session-gate before any model call, so the
   * prompt would otherwise vanish into a `blocked` turn.
   */
  unarchiveOnPrompt: boolean
  /**
   * Verification aid: when > 0, keep a pairing code published in status.json
   * with this TTL (seconds). Off by default — it publishes the QR (which
   * carries the PSK) to a 0600 file, so it exists only so `pnpm test` /
   * `scripts/verify-deployment.mjs` can drive a real end-to-end run without a
   * human typing `/drc pair`.
   */
  pairOnStartSec: number
  /**
   * `/drc pair` writes a real PNG next to the status file and opens it.
   *
   * The slash-command API can only settle `{ kind, text }` — there is no image
   * result type — but the plugin runs on the host, so it can emit an actual
   * image file instead of fighting whatever the TUI does to block characters.
   */
  qrImage: boolean
  /** Open the generated PNG with the OS default viewer. */
  qrOpen: boolean
  /** Text fallback style, used only if the PNG cannot be written. */
  qrStyle: QrStyle
}

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  serverUrl: 'ws://127.0.0.1:8787',
  hostToken: '',
  hostTokenEnv: 'DRC_HOST_TOKEN',
  hostLabel: 'dsh-host',
  keepAwake: { enabled: true, idleReleaseSec: 300, keepDisplay: false },
  mockBridge: false,
  statusFile: join(homedir(), '.dsh', 'dsh-remote-control', 'status.json'),
  unarchiveOnPrompt: true,
  pairOnStartSec: Number(process.env.DRC_PAIR_ON_START_SEC ?? 0) || 0,
  qrImage: process.env.DRC_QR_IMAGE !== '0',
  qrOpen: process.env.DRC_QR_OPEN !== '0',
  qrStyle: (['ascii', 'block', 'half'] as const).includes(
    (process.env.DRC_QR_STYLE ?? '') as QrStyle,
  )
    ? (process.env.DRC_QR_STYLE as QrStyle)
    : 'ascii',
}

/**
 * Write a status snapshot for operators.
 *
 * The Harness is usually a GUI app whose stdout nobody can read, so "is the
 * plugin up, and is it talking to the real kernel?" has to be answerable from
 * the filesystem. `carrier` is the answer to the second half: `dsh` means the
 * real kernel bridge attached, `mock` means it fell back to the in-memory one.
 */
function writeStatus(file: string, carrier: string, cfg: PluginConfig, state: Record<string, unknown>): void {
  if (!file) return
  try {
    const body = JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        carrier,
        serverUrl: cfg.serverUrl,
        hostLabel: cfg.hostLabel,
        mockBridgeForced: cfg.mockBridge,
        ...state,
      },
      null,
      2,
    )
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, body, { mode: 0o600 })
    renameSync(tmp, file) // atomic: readers never see a half-written file
  } catch {
    /* status output is best-effort and must never break the plugin */
  }
}

/** Never let a secret reach a log line. */
/**
 * Compose the `/drc pair` reply.
 *
 * A real PNG is the primary output: block characters in a TUI depend on the
 * font, the glyph set and whether ANSI is interpreted at all, and any of those
 * going wrong turns the symbol into unscannable noise. An image file always
 * scans, and we can open it directly since we are running on the host.
 */
function pairMessage(
  token: string,
  qr: string,
  ttlMs: number,
  withToken: boolean,
  cfg: PluginConfig,
): string {
  const head =
    `配对码 ${token}（${Math.round(ttlMs / 1000)}s 内有效）\n` +
    (withToken ? '二维码已内嵌配对码，扫码即连。\n' : '')

  if (cfg.qrImage) {
    try {
      const dir = dirname(cfg.statusFile || join(homedir(), '.dsh', 'dsh-remote-control', 'status.json'))
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'pairing-qr.png')
      writeFileSync(file, qrPng(qr), { mode: 0o600 })
      let opened = ''
      if (cfg.qrOpen) {
        const opener =
          process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
        try {
          // fire-and-forget: a missing opener must not fail the command
          spawn(opener, [file], { stdio: 'ignore', detached: true }).unref()
          opened = '（已用默认应用打开）'
        } catch {
          opened = ''
        }
      }
      return `${head}\n二维码图片：${file}${opened}\n\n二维码内容：\n${qr}`
    } catch (e) {
      // fall through to text — the command must still produce a usable code
      console.warn('[dsh-remote-control] writing the pairing PNG failed', e)
    }
  }

  return `${head}\n${renderTerminalQr(qr, { style: cfg.qrStyle })}\n\n二维码内容：\n${qr}`
}

function redact(token: string): string {
  if (!token) return '(empty)'
  return token.length <= 8 ? '****' : `${token.slice(0, 4)}…${token.slice(-2)} (len ${token.length})`
}

export interface ConfigProblem {
  field: string
  /** `error` blocks startup; `warn` is advisory only. */
  severity: 'error' | 'warn'
  message: string
}

/**
 * Validate before touching the network so misconfiguration is obvious.
 * Only genuinely unusable settings block startup — a short-but-present token
 * or a plaintext loopback URL is reported and allowed.
 */
export function validateConfig(cfg: PluginConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = []
  if (!/^wss?:\/\/.+/.test(cfg.serverUrl)) {
    problems.push({
      field: 'serverUrl',
      severity: 'error',
      message: `must start with ws:// or wss:// (got ${JSON.stringify(cfg.serverUrl)})`,
    })
  } else if (cfg.serverUrl.startsWith('ws://')) {
    const host = cfg.serverUrl.slice(5).split(/[:/]/)[0] ?? ''
    const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
    if (!local) {
      problems.push({
        field: 'serverUrl',
        severity: 'warn',
        message: 'plaintext ws:// to a non-loopback host — use wss:// in production',
      })
    }
  }
  if (!cfg.hostToken) {
    problems.push({
      field: 'hostToken',
      severity: 'error',
      message: `host token missing (set config.hostToken or env ${cfg.hostTokenEnv})`,
    })
  } else if (cfg.hostToken.length < 24) {
    problems.push({
      field: 'hostToken',
      severity: 'warn',
      message: 'host token shorter than 24 chars; use `openssl rand -hex 24`',
    })
  }
  if (Number(cfg.pairOnStartSec) > 0) {
    problems.push({
      field: 'pairOnStartSec',
      severity: 'warn',
      message: 'enabled — a live pairing code (with its PSK) will be published in status.json',
    })
  }
  const idle = cfg.keepAwake.idleReleaseSec
  if (typeof idle !== 'number' || Number.isNaN(idle) || idle < 0) {
    problems.push({
      field: 'keepAwake.idleReleaseSec',
      severity: 'warn',
      message: 'must be a number >= 0 (0 = hold until disabled); falling back to 300',
    })
  }
  return problems
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
  // Hard rule: a remote-control add-on must never prevent the Harness from
  // booting. Every failure below is reported and swallowed.
  try {
    applyInner(ctx, injected)
  } catch (e) {
    console.warn('[dsh-remote-control] plugin failed to initialise (Harness unaffected):', e)
  }
}

function applyInner(ctx: LooseContext, injected: Partial<PluginConfig> | undefined = undefined): void {
  const cfg = readConfig(ctx, injected)
  if (!cfg.enabled) return

  const problems = validateConfig(cfg)
  for (const p of problems) {
    console.warn(`[dsh-remote-control] config.${p.field}: ${p.message}`)
  }
  // Only hard errors stop the plugin — and stopping here affects this plugin
  // alone, never the Harness.
  if (problems.some((p) => p.severity === 'error')) {
    console.warn(
      '[dsh-remote-control] staying idle until the config above is fixed (token hint: %s)',
      redact(cfg.hostToken),
    )
    // leave a breadcrumb: otherwise "why is nothing happening?" has no answer
    writeStatus(cfg.statusFile, 'none', cfg, {
      relay: 'idle',
      reason: 'invalid-config',
      problems: problems.map((p) => `${p.field}: ${p.message}`),
    })
    return
  }
  // keepAwake.idleReleaseSec could be garbage; clamp so KeepAwake never sees NaN
  if (!Number.isFinite(cfg.keepAwake.idleReleaseSec) || cfg.keepAwake.idleReleaseSec < 0) {
    cfg.keepAwake.idleReleaseSec = DEFAULT_CONFIG.keepAwake.idleReleaseSec
  }

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

  const start = (
    gateway: GatewayLike | null,
    apiProxy: ApiProxyLike | null,
    services: InProcServices | null = null,
  ): void => {
    if (runtime) return
    const bridge =
      cfg.mockBridge || (gateway === null && apiProxy === null && services === null)
        ? new MockHarnessBridge()
        : new DshKernelBridge({
            services,
            gateway,
            apiProxy,
            unarchiveOnPrompt: cfg.unarchiveOnPrompt,
            log: (m, x) => console.log('[dsh-remote-control]', m, x ?? ''),
          })
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
    try {
      runtime.start()
    } catch (e) {
      console.warn('[dsh-remote-control] runtime failed to start:', e)
      runtime = null
      return
    }
    ctx.effect?.(() => () => runtime?.stop())
    // `apiproxy` / `typert` = real kernel (which face), `mock` = in-memory
    // stand-in whose sessions are fake. This is the one word an operator needs.
    const carrier = bridge instanceof MockHarnessBridge ? 'mock' : bridge.carrier
    console.log(
      `[dsh-remote-control] host runtime started → ${cfg.serverUrl} (carrier=${carrier}, token=${redact(cfg.hostToken)})`,
    )
    if (carrier === 'typert') {
      console.warn(
        '[dsh-remote-control] only the Typert gateway is available — it can stream events but cannot list or prompt sessions (those live on the API Proxy). Expect an empty session list.',
      )
    }
    let activePair: {
      token: string
      qr: string
      createdAt: number
      expiresAt: string
      generation: number
    } | null = null
    const snap = () => {
      const pairSec = Number(cfg.pairOnStartSec)
      // Expiry is decided by the RELAY (`pair-ready.ttlMs`), not by what we
      // asked for — otherwise status.json advertises codes the relay already
      // swept. Falls back to the requested TTL until the reply lands.
      const ttlMs = runtime?.pairingTtlMs ?? pairSec * 1000
      const expiresAt = (activePair?.createdAt ?? 0) + ttlMs
      // A relay restart wipes its pending-pair table: our published code is
      // dead even though its TTL has not run out.
      const generationChanged =
        activePair !== null && runtime !== null && activePair.generation !== runtime.relayGeneration
      // Only publish once the relay is up (a pair-begin sent while connecting
      // is dropped), and refresh at half-life so a stale code never survives.
      const stale =
        !activePair || generationChanged || expiresAt < Date.now() + ttlMs / 2
      if (pairSec > 0 && runtime && runtime.state.relay === 'online' && stale) {
        try {
          const p = runtime.createPairing(pairSec * 1000, { includeToken: true })
          activePair = {
            token: p.token,
            qr: p.qr,
            createdAt: Date.now(),
            expiresAt: new Date(Date.now() + ttlMs).toISOString(),
            generation: runtime.relayGeneration,
          }
        } catch (e) {
          console.warn('[dsh-remote-control] pairOnStartSec: createPairing failed', e)
        }
      } else if (activePair) {
        activePair.expiresAt = new Date(expiresAt).toISOString()
      }
      writeStatus(cfg.statusFile, carrier, cfg, {
        ...(runtime?.state ?? {}),
        ...(activePair ? { pairing: activePair } : {}),
        probe: probeContext(ctx),
      })
    }
    snap()
    const statusTimer = setInterval(snap, 3_000)
    statusTimer.unref?.()
    ctx.effect?.(() => () => clearInterval(statusTimer))
  }

  // Both kernel faces are watched, and apiProxy is deliberately preferred
  // (see DshKernelBridge.carrier): it is the only one that exposes session
  // listing. Typert is the fallback for profiles whose web app is absent.
  //
  // The two injects race, so we collect whatever shows up and decide once:
  // starting on typert the moment it appears would lock out a later apiProxy.
  let gateway: GatewayLike | null = null
  let apiProxy: ApiProxyLike | null = null
  let services: InProcServices | null = null

  // Only apiProxy may start us eagerly. Starting on a gateway that happens to
  // land first would win the race and lock us into the weaker carrier — which
  // is exactly the bug that produced `carrier=typert` on a profile that has
  // apiProxy. Gateway-only is decided by the grace timer below.
  const decide = (): void => {
    if (runtime) return
    if (services) return start(gateway, apiProxy, services)
    if (apiProxy) start(gateway, apiProxy)
  }

  // 1. The platform's own services. Same process, no wire, no endpoint names.
  //
  // Collected through one inject per service rather than a single snapshot:
  // they come up independently, and listing every conversation needs
  // `sessionQuery` (the persisted corpus) which can land after `sessions`.
  // Late arrivals patch the SAME object the bridge already holds, so nothing
  // has to restart to pick them up.
  const holder: Partial<InProcServices> = {}
  const publish = (): void => {
    if (!holder.sessions) return
    if (services) {
      Object.assign(services, holder)
      return
    }
    services = holder as InProcServices
    console.log(
      '[dsh-remote-control] in-process services available (ctx.sessions / ctx.agents' +
        (holder.sessionQuery ? ' / ctx.sessionQuery' : '') +
        ')',
    )
    decide()
  }
  for (const name of ['sessions', 'agents', 'agentDefaultModel', 'sessionQuery', 'workspaceRegistry'] as const) {
    try {
      ctx.inject([name], (c) => {
        const value = c.get(name, true)
        if (value === undefined || value === null) return
        if (name === 'sessions' && typeof (value as { list?: unknown }).list !== 'function') return
        if (name === 'sessionQuery' && typeof (value as { listSessions?: unknown }).listSessions !== 'function') return
        ;(holder as unknown as Record<string, unknown>)[name] = value
        if (name === 'sessions' && typeof c.on === 'function') holder.on = c.on.bind(c)
        publish()
      })
    } catch {
      /* this composition does not expose that service */
    }
  }
  try {
    ctx.inject(['apiProxy'], (c) => {
      apiProxy = asApiProxy(c.get('apiProxy', true))
      decide()
    })
  } catch {
    /* apiProxy not a service in this generation */
  }
  try {
    ctx.inject(['typertGateway'], (c) => {
      gateway = asGateway(c.get('typertGateway', true))
      decide()
    })
  } catch {
    /* typertGateway not a service in this generation */
  }

  // If only typert ever arrives, start on it after a grace period so a slow
  // apiProxy still gets the chance to win. Tunable so tests are not slow.
  const graceMs = Number(process.env.DRC_CARRIER_GRACE_MS ?? 5_000)
  const grace = setTimeout(() => {
    if (runtime) return
    if (gateway) start(gateway, null)
    else if (cfg.mockBridge) start(null, null)
  }, Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : 5_000)
  grace.unref?.()

  // Decide on CARRIERS, not on "some inject registered": `agents` /
  // `sessionQuery` are helpers, not carriers, so a host that exposes only
  // those must still fall through to the forced mock bridge.
  const anyCarrier = gateway !== null || apiProxy !== null || services !== null
  if (!anyCarrier && cfg.mockBridge) start(null, null)

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

  // `/drc` human command, registered only where the commands registry is a
  // real service (@deepseek-ai/dsh-commands — present in desktop/web/TUI).
  //
  // API (verified against @deepseek-ai/dsh-commands 0.1.0-rc.6):
  //   register({ name, description, input?: {hint}, recordInput?, handler })
  //   handler receives { commandId, agent, rawInput, signal } where `rawInput`
  //   is the text AFTER the command name (so "/drc pair 300" -> " pair 300"),
  //   and must return { kind:'success', text? } | { kind:'error', text }.
  try {
    ctx.inject(['commands'], (c) => {
      const commands = c.get<{ register(def: unknown): unknown }>('commands', true)
      if (typeof commands?.register !== 'function') return
      commands.register({
        name: 'drc',
        description: 'DSH Remote Control: 查看状态 / 生成配对码',
        input: { hint: '[status | pair [ttlSec] [--with-token]]' },
        handler: (inv: { rawInput?: string }) => {
          const parts = String(inv?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
          const sub = parts[0] ?? 'status'
          if (sub === 'pair') {
            // The pairing code is embedded by default: scanning then needs no
            // typing at all. The code is single-use and short-lived, and the
            // QR is shown on the host's own screen, so embedding is safe.
            // `--no-token` restores the bare payload for special cases.
            const withToken = !parts.includes('--no-token')
            const secs = Number(parts.filter((p) => /^\d+$/.test(p))[0] ?? 120)
            const ttl = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 120_000
            const p = runtime?.createPairing(ttl, { includeToken: withToken })
            if (!p) {
              return { kind: 'error', text: 'runtime 未启动：检查 hostToken 配置与中继地址' }
            }
            return { kind: 'success', text: pairMessage(p.token, p.qr, ttl, withToken, cfg) }
          }
          if (sub === 'help') {
            return {
              kind: 'success',
              text: [
                '用法：',
                '  /drc                     查看状态',
                '  /drc pair [ttlSec]       生成配对码与二维码（默认 120s）',
                '  /drc pair --with-token   二维码内嵌配对码（无摄像头时一步配对）',
              ].join('\n'),
            }
          }
          return { kind: 'success', text: JSON.stringify(runtime?.state ?? { relay: 'offline' }, null, 2) }
        },
      })
    })
  } catch {
    /* commands service not present in this generation — soft */
  }
}

/**
 * Accept either kernel face as-is. Shape checks happen at the call site, where
 * a miss can be reported precisely (which member was missing + what keys the
 * service actually has) instead of silently degrading to the other carrier.
 */
function asGateway(v: unknown): GatewayLike | null {
  return v && typeof v === 'object' ? (v as GatewayLike) : null
}

function asApiProxy(v: unknown): ApiProxyLike | null {
  return v && typeof v === 'object' ? (v as ApiProxyLike) : null
}

/** Top-level member names of a service, for diagnostics. Never throws. */
export function describeService(v: unknown): string[] {
  if (!v || typeof v !== 'object') return []
  try {
    return Object.keys(v as object).slice(0, 40)
  } catch {
    return []
  }
}

/**
 * One-shot probe of the host context, written into status.json.
 *
 * Every wrong guess about the kernel API has cost a Harness restart, so we
 * record what is actually there instead of guessing again.
 */
export function probeContext(ctx: LooseContext): Record<string, unknown> {
  const names = new Set<string>()
  for (const src of [ctx as unknown as object, (ctx as { fiber?: object }).fiber ?? {}]) {
    try {
      for (const k of Object.getOwnPropertyNames(src)) names.add(k)
    } catch {
      /* ignore */
    }
    try {
      for (const k of Object.keys(src)) names.add(k)
    } catch {
      /* ignore */
    }
  }
  const interesting = [
    'sessions',
    'agents',
    'agentDefaultModel',
    'approval',
    'permissions',
    'userQuestions',
    'permissionPresets',
    'apiProxy',
    'typertGateway',
    'sessionQuery',
    'sessionPersistence',
    'workspaceRegistry',
    'connection',
    'commands',
    'llm',
    'workspaceRegistry',
  ]
  const present: Record<string, string> = {}
  for (const n of interesting) {
    try {
      const v = (ctx as { get?: (k: string, o?: boolean) => unknown }).get?.(n, true)
      if (v !== undefined && v !== null) present[n] = typeof v
    } catch {
      /* ignore */
    }
  }
  const visible = [...names]
    .filter((n) => !n.startsWith('_') && !['constructor', 'fiber', 'scope', 'root', 'ctx'].includes(n))
    .sort()
  return { visibleServices: visible.slice(0, 120), present }
}

export type { Payload }
export { HostRuntime } from './host-runtime.js'
export { MockHarnessBridge } from './adapter-mock.js'
export { DshKernelBridge } from './adapter-dsh.js'
export { RelayClient } from './relay-client.js'
export { handlePayload, type HarnessBridge } from './bridge.js'
