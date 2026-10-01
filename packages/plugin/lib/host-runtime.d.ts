/**
 * HostRuntime — glues RelayClient + HarnessBridge + KeepAwake together.
 * Runs inside the DSH process (cordis plugin) or standalone with the mock
 * bridge (tests / dsh-TUI-less setups).
 */
import { KeepAwake } from '@dsh-rc/protocol';
import type { Payload } from '@dsh-rc/protocol';
import { RelayClient } from './relay-client.js';
import { type HarnessBridge } from './bridge.js';
export interface HostRuntimeConfig {
    serverUrl: string;
    hostToken: string;
    hostLabel: string;
    keepAwakeEnabled?: boolean;
    keepAwakeIdleSec?: number;
    keepDisplay?: boolean;
}
export interface HostRuntimeOptions {
    config: HostRuntimeConfig;
    bridge: HarnessBridge;
    log?: (msg: string, extra?: unknown) => void;
}
export declare class HostRuntime {
    readonly relay: RelayClient;
    readonly keepAwake: KeepAwake;
    private bridge;
    private unwatch;
    private say;
    private sessionsCache;
    constructor(opts: HostRuntimeOptions);
    start(): void;
    stop(): void;
    createPairing(ttlMs?: number): {
        token: string;
        qr: string;
    };
    keepAwakeStateEvent(): Payload;
    /** forward host events to the right client(s) + activity heuristics */
    private forward;
    private markActivityFor;
    private pendingHolds;
    private markActivity;
    private onPayload;
    private pushSessions;
    private pushSessionsToAll;
    get state(): Record<string, unknown>;
}
