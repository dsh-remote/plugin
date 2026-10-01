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
import type { Payload } from '@dsh-rc/protocol';
/** Loose cordis context — we never hard-depend on @deepseek-ai/cordis types. */
interface LooseContext {
    inject(names: string[], fn: (ctx: LooseContext) => void | Promise<void>): unknown;
    get<T = unknown>(name: string, optional?: false): T;
    get<T = unknown>(name: string, optional: true): T | undefined;
    provide?(name: string, value: unknown): unknown;
    effect(fn: () => unknown): unknown;
    fiber?: unknown;
    [key: string]: unknown;
}
export interface PluginConfig {
    enabled: boolean;
    serverUrl: string;
    hostToken: string;
    hostTokenEnv: string;
    hostLabel: string;
    keepAwake: {
        enabled: boolean;
        idleReleaseSec: number;
        keepDisplay: boolean;
    };
    mockBridge: boolean;
}
export declare const DEFAULT_CONFIG: PluginConfig;
export declare function apply(ctx: LooseContext, injected?: Partial<PluginConfig> | undefined): void;
export type { Payload };
export { HostRuntime } from './host-runtime.js';
export { MockHarnessBridge } from './adapter-mock.js';
export { DshKernelBridge } from './adapter-dsh.js';
export { RelayClient } from './relay-client.js';
export { handlePayload, type HarnessBridge } from './bridge.js';
