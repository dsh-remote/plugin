/**
 * HarnessBridge — the seam between the relay plugin and the DSH core.
 *
 * The plugin never reaches into private内核 internals directly; it talks to
 * this interface. Two implementations exist:
 *   - `DshSessionBridge` (adapter-dsh.ts): attaches to the live cordis ctx
 *     (sessions service + session log events + agent steering).
 *   - `MockHarnessBridge` (adapter-mock.ts): in-memory harness for tests/e2e.
 */
import type { SessionSummary, Payload } from '@dsh-rc/protocol';
export interface BridgeEvents {
    onSessionsChanged?: (sessions: SessionSummary[]) => void;
    onEvent?: (ev: Payload) => void;
    onKeepAwakeState?: () => void;
}
export interface HarnessBridge {
    listSessions(): Promise<SessionSummary[]>;
    /** send a user prompt into a session (starts/resumes a run) */
    sendPrompt(sessionId: string, text: string): Promise<{
        ok: boolean;
        message?: string;
    }>;
    /** answer an outstanding ask_user question */
    answer(sessionId: string, requestId: string, answers: unknown[]): Promise<{
        ok: boolean;
        message?: string;
    }>;
    /** approve/reject an outstanding permission request */
    resolvePermission(sessionId: string, requestId: string, decision: string, note?: string): Promise<{
        ok: boolean;
        message?: string;
    }>;
    /** interrupt the current run */
    interrupt(sessionId: string): Promise<{
        ok: boolean;
        message?: string;
    }>;
    /** start streaming session events into `emit` */
    watch(emit: (ev: Payload) => void): () => void;
}
/** Dispatch a decrypted client payload onto the bridge; returns optional result payload. */
export declare function handlePayload(bridge: HarnessBridge, payload: Payload): Promise<Payload | null>;
