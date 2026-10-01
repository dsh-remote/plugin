import { type Payload } from '@dsh-rc/protocol';
export interface RelayClientOptions {
    serverUrl: string;
    hostToken: string;
    hostLabel: string;
    onPayload?: (sessionId: string, clientId: string, payload: Payload) => void;
    onPeerJoined?: (sessionId: string, clientId: string) => void;
    onPeerLeft?: (sessionId: string, clientId: string) => void;
    onStatus?: (s: RelayStatus) => void;
    log?: (msg: string, extra?: unknown) => void;
}
export type RelayStatus = 'connecting' | 'online' | 'offline' | 'auth-failed';
export declare class RelayClient {
    private opts;
    private ws;
    private conversations;
    /** psk by 6-digit token currently offered for pairing */
    private pendingPair;
    private reconnectTimer;
    private backoff;
    private closed;
    status: RelayStatus;
    hostId: string;
    constructor(opts: RelayClientOptions);
    private say;
    start(): void;
    stop(): void;
    private setStatus;
    private connect;
    private scheduleReconnect;
    private send;
    private onFrame;
    /** Issue a one-time pairing token (6-digit) + PSK; returns QR text for display. */
    createPairing(ttlMs?: number): {
        token: string;
        qr: string;
    };
    sendPayload(sessionId: string, payload: Payload): boolean;
    /** broadcast to every paired client */
    broadcast(payload: Payload): void;
    get pairedClients(): Array<{
        sessionId: string;
    }>;
    /** stable short fingerprint for display (sha256 of token, first 8) */
    static tokenFingerprint(token: string): string;
    newCmdId(): string;
}
