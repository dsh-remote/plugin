/**
 * DshKernelBridge — adapter from live DSH cordis ctx to HarnessBridge.
 *
 * Mount points (proven against the installed rc.2 kernel and the
 * ds-harness-remote reference plugin):
 *  - `ctx.inject([...])` gates activation until carriers exist.
 *  - Typert carrier (`typertGateway`, @deepseek-ai/dsh-api-gateway):
 *      unary  gateway.invoke({namespace,method,args,signal})
 *      streams gateway.openWireStream(endpoint, payload, signal) (rc.1+)
 *              endpoint '$events' carries waterfall approval/request +
 *              user-questions/request; answered via '$events/result'.
 *  - legacy carrier (`apiProxy`): sessions.list/prompt/cancel +
 *      events.mux(req,signal) frames (approval/requested…) + respond().
 *
 * Everything is feature-detected at runtime; the bridge degrades to
 * session-list + prompt-only when the richer faces are missing, and the
 * plugin keeps working with the mock bridge when run standalone.
 */
import type { SessionSummary, Payload } from '@dsh-rc/protocol';
import type { HarnessBridge } from './bridge.js';
/** minimal structural typings — we never import cordis types at build time */
export interface GatewayLike {
    invoke(req: {
        namespace: string;
        method: string;
        args: Record<string, unknown>;
        signal?: AbortSignal;
    }): Promise<unknown>;
    /** rc.1+ wire stream; arity varies (older: (endpoint, payload, signal)) */
    openWireStream?: (...args: unknown[]) => AsyncIterable<unknown>;
    wireStream?: {
        open?: (...args: unknown[]) => AsyncIterable<unknown>;
    };
    supportsCarrier?: boolean;
}
export interface ApiProxyLike {
    sessions: {
        list(request?: unknown): Promise<unknown>;
        prompt(request: unknown): Promise<unknown>;
        cancel(request: unknown): Promise<unknown>;
    };
    events: {
        mux(request: unknown, signal?: AbortSignal): AsyncIterable<unknown>;
        host(request?: unknown, signal?: AbortSignal): AsyncIterable<unknown>;
    };
    respond(message: unknown): Promise<unknown>;
    host_describe?(): Promise<unknown>;
}
export interface KernelBridgeOptions {
    gateway?: GatewayLike | null;
    apiProxy?: ApiProxyLike | null;
    log?: (m: string, x?: unknown) => void;
}
export declare class DshKernelBridge implements HarnessBridge {
    private opts;
    private emit;
    private respondables;
    private abort;
    private say;
    constructor(opts: KernelBridgeOptions);
    get carrier(): 'typert' | 'apiproxy' | 'none';
    watch(emit: (ev: Payload) => void): () => void;
    private callRc;
    private pumpTypertEvents;
    private handleTypertEventFrame;
    /** native cordis events forwarded via $events: session/event etc. */
    private handleNativeEvent;
    private pumpMuxEvents;
    listSessions(): Promise<SessionSummary[]>;
    sendPrompt(sessionId: string, text: string): Promise<{
        ok: boolean;
        message?: string;
    }>;
    interrupt(sessionId: string): Promise<{
        ok: boolean;
        message?: string;
    }>;
    resolvePermission(sessionId: string, requestId: string, decision: string, note?: string): Promise<{
        ok: boolean;
        message?: string;
    }>;
    answer(sessionId: string, requestId: string, answers: unknown[]): Promise<{
        ok: boolean;
        message?: string;
    }>;
}
