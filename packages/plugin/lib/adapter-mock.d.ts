/**
 * MockHarnessBridge — an in-memory DSH harness for tests and the e2e demo.
 * Emits realistic event payloads: deltas, tool events, permission request
 * (awaiting resolve), ask_user question (awaiting answer).
 */
import type { SessionSummary, Payload } from '@dsh-rc/protocol';
import type { HarnessBridge } from './bridge.js';
export declare class MockHarnessBridge implements HarnessBridge {
    private emit;
    private sessions;
    pendingPermissions: Map<string, {
        sessionId: string;
        requestId: string;
    }>;
    pendingQuestions: Map<string, {
        sessionId: string;
        requestId: string;
    }>;
    receivedPrompts: Array<{
        sessionId: string;
        text: string;
    }>;
    listSessions(): Promise<SessionSummary[]>;
    watch(emit: (ev: Payload) => void): () => void;
    private send;
    sendPrompt(sessionId: string, text: string): Promise<{
        ok: boolean;
        message: string;
    } | {
        ok: boolean;
        message?: undefined;
    }>;
    answer(sessionId: string, requestId: string, answers: unknown[]): Promise<{
        ok: boolean;
        message: string;
    } | {
        ok: boolean;
        message?: undefined;
    }>;
    resolvePermission(sessionId: string, requestId: string, decision: string): Promise<{
        ok: boolean;
        message: string;
    } | {
        ok: boolean;
        message?: undefined;
    }>;
    interrupt(sessionId: string): Promise<{
        ok: boolean;
    }>;
    /** test helper: ask the client a question */
    raiseQuestion(sessionId: string): string;
}
