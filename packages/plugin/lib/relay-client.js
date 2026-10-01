/**
 * Relay client used by the DSH Host plugin: connects to the
 * dsh-remote-control server, maintains pairing tokens, and
 * routes E2E-encrypted payloads to/from paired clients.
 */
import { WebSocket } from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { seal, open, derivePskKey, generatePairingSecret, buildPairingQr, } from '@dsh-rc/protocol';
export class RelayClient {
    opts;
    ws = null;
    conversations = new Map();
    /** psk by 6-digit token currently offered for pairing */
    pendingPair = null;
    reconnectTimer = null;
    backoff = 1000;
    closed = false;
    status = 'offline';
    hostId = '';
    constructor(opts) {
        this.opts = opts;
    }
    say = (m, x) => this.opts.log?.(m, x);
    start() {
        this.closed = false;
        this.connect();
    }
    stop() {
        this.closed = true;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        try {
            this.ws?.close();
        }
        catch { /* ignore */ }
        this.ws = null;
        this.conversations.clear();
        this.setStatus('offline');
    }
    setStatus(s) {
        if (this.status !== s) {
            this.status = s;
            this.opts.onStatus?.(s);
        }
    }
    connect() {
        if (this.closed)
            return;
        this.setStatus('connecting');
        let ws;
        try {
            ws = new WebSocket(this.opts.serverUrl, { handshakeTimeout: 10_000 });
        }
        catch (e) {
            this.say('ws create failed', e);
            return this.scheduleReconnect();
        }
        this.ws = ws;
        ws.on('open', () => {
            this.backoff = 1000;
            this.send({ t: 'auth', role: 'host', token: this.opts.hostToken, label: this.opts.hostLabel });
        });
        ws.on('message', (raw) => this.onFrame(String(raw)));
        ws.on('error', (e) => this.say('ws error', e.message));
        ws.on('close', () => {
            if (this.ws === ws) {
                this.ws = null;
                this.setStatus('offline');
                this.scheduleReconnect();
            }
        });
    }
    scheduleReconnect() {
        if (this.closed || this.reconnectTimer)
            return;
        const delay = this.backoff + Math.random() * 500;
        this.backoff = Math.min(this.backoff * 2, 30_000);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
        this.reconnectTimer.unref?.();
    }
    send(f) {
        if (this.ws?.readyState === WebSocket.OPEN)
            this.ws.send(JSON.stringify(f));
    }
    onFrame(raw) {
        let f;
        try {
            f = JSON.parse(raw);
        }
        catch {
            return;
        }
        switch (f.t) {
            case 'auth-ok':
                this.hostId = f.hostId;
                this.setStatus('online');
                this.say(`relay online as host ${f.hostId}`);
                // re-offer pairing automatically when host restarts with pending pair
                return;
            case 'auth-fail':
                this.setStatus('auth-failed');
                this.say('relay auth failed — check DRC_HOST_TOKEN / serverUrl');
                return;
            case 'pair-ready':
                this.say(`pairing token ${f.pairingToken} ready (ttl ${f.ttlMs}ms)`);
                return;
            case 'peer-joined': {
                // host side: the conversation was created server-side; psk was ours
                const psk = this.pendingPair?.token === undefined ? null : this.pendingPair.psk;
                if (!psk) {
                    this.say('peer-joined without pending pair — dropping', f.sessionId);
                    return;
                }
                this.conversations.set(f.sessionId, {
                    sessionId: f.sessionId,
                    kC2H: derivePskKey(psk, 'c2h', f.sessionId),
                    kH2C: derivePskKey(psk, 'h2c', f.sessionId),
                    seq: 0,
                });
                this.opts.onPeerJoined?.(f.sessionId, f.clientId);
                return;
            }
            case 'peer-left':
                if (this.conversations.delete(f.sessionId))
                    this.opts.onPeerLeft?.(f.sessionId, f.clientId);
                return;
            case 'enc': {
                const conv = this.conversations.get(f.sessionId);
                if (!conv)
                    return;
                const payload = open(conv.kC2H, { ciphertext: f.ciphertext });
                if (!payload) {
                    this.say('undecryptable frame dropped', f.sessionId);
                    return;
                }
                this.opts.onPayload?.(f.sessionId, f.clientId ?? '', payload);
                return;
            }
            case 'pong':
                return;
            default:
                return;
        }
    }
    // ── pairing ─────────────────────────────────────────────
    /** Issue a one-time pairing token (6-digit) + PSK; returns QR text for display. */
    createPairing(ttlMs = 120_000) {
        const psk = generatePairingSecret();
        const token = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
        this.pendingPair = { token, psk, expiresAt: Date.now() + ttlMs };
        const url = this.opts.serverUrl.replace(/^ws/, 'http');
        const qr = buildPairingQr({ v: 1, server: this.opts.serverUrl, hostLabel: this.opts.hostLabel, psk });
        void url;
        this.send({ t: 'pair-begin', pairingToken: token, psk, hostLabel: this.opts.hostLabel });
        return { token, qr };
    }
    // ── outbound encrypted stream ───────────────────────────
    sendPayload(sessionId, payload) {
        const conv = this.conversations.get(sessionId);
        if (!conv || this.ws?.readyState !== WebSocket.OPEN)
            return false;
        const rec = seal(conv.kH2C, payload);
        this.send({ t: 'enc', sessionId, seq: ++conv.seq, ciphertext: rec.ciphertext });
        return true;
    }
    /** broadcast to every paired client */
    broadcast(payload) {
        for (const sessionId of this.conversations.keys())
            this.sendPayload(sessionId, payload);
    }
    get pairedClients() {
        return [...this.conversations.values()].map((c) => ({ sessionId: c.sessionId }));
    }
    /** stable short fingerprint for display (sha256 of token, first 8) */
    static tokenFingerprint(token) {
        return createHash('sha256').update(token).digest('hex').slice(0, 8);
    }
    newCmdId() {
        return randomUUID();
    }
}
//# sourceMappingURL=relay-client.js.map