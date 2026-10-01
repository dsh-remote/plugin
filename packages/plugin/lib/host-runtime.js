/**
 * HostRuntime — glues RelayClient + HarnessBridge + KeepAwake together.
 * Runs inside the DSH process (cordis plugin) or standalone with the mock
 * bridge (tests / dsh-TUI-less setups).
 */
import { KeepAwake } from '@dsh-rc/protocol';
import { RelayClient } from './relay-client.js';
import { handlePayload } from './bridge.js';
export class HostRuntime {
    relay;
    keepAwake;
    bridge;
    unwatch = null;
    say;
    sessionsCache = [];
    constructor(opts) {
        this.bridge = opts.bridge;
        this.say = opts.log ?? ((m, x) => console.log('[drc-host]', m, x ?? ''));
        this.relay = new RelayClient({
            serverUrl: opts.config.serverUrl,
            hostToken: opts.config.hostToken,
            hostLabel: opts.config.hostLabel,
            onPayload: (sessionId, _clientId, payload) => void this.onPayload(sessionId, payload),
            onPeerJoined: (sessionId) => {
                this.say(`client paired into ${sessionId}`);
                this.markActivity('peer-joined');
                // push current session list to the new client
                void this.pushSessions(sessionId);
                this.relay.sendPayload(sessionId, this.keepAwakeStateEvent());
            },
            onPeerLeft: (sessionId) => this.say(`client left ${sessionId}`),
            onStatus: (s) => this.say(`relay status: ${s}`),
            log: this.say,
        });
        this.keepAwake = new KeepAwake({
            idleReleaseMs: (opts.config.keepAwakeIdleSec ?? 300) * 1000,
            keepDisplay: opts.config.keepDisplay ?? false,
            onStateChange: () => {
                this.relay.broadcast(this.keepAwakeStateEvent());
            },
        });
        if (opts.config.keepAwakeEnabled ?? true)
            this.keepAwake.enable();
    }
    start() {
        this.relay.start();
        this.unwatch = this.bridge.watch((ev) => this.forward(ev));
        // periodic session refresh (cheap; bridge may be mock)
        const timer = setInterval(() => void this.pushSessionsToAll(), 15_000);
        timer.unref?.();
    }
    stop() {
        this.unwatch?.();
        this.unwatch = null;
        this.keepAwake.disable('plugin-stop');
        this.relay.stop();
    }
    createPairing(ttlMs) {
        return this.relay.createPairing(ttlMs);
    }
    keepAwakeStateEvent() {
        return { t: 'ev.keep_awake_state', ...this.keepAwake.state };
    }
    /** forward host events to the right client(s) + activity heuristics */
    forward(ev) {
        this.markActivityFor(ev);
        if ('sessionId' in ev && ev.sessionId) {
            const targets = this.relay.pairedClients.filter((c) => c.sessionId === ev.sessionId || !('sessionId' in ev));
            if (targets.length === 0) {
                // events for sessions nobody follows yet: fan out to all clients
                this.relay.broadcast(ev);
                return;
            }
            for (const c of targets)
                this.relay.sendPayload(c.sessionId, ev);
            return;
        }
        this.relay.broadcast(ev);
    }
    markActivityFor(ev) {
        if (ev.t === 'ev.permission_request' || ev.t === 'ev.question_request') {
            this.keepAwake.markActive();
            // hold the lock while a decision is pending: heartbeat activity
            const hold = setInterval(() => this.keepAwake.markActive(), 60_000);
            hold.unref?.();
            this.pendingHolds.set(ev.requestId, hold);
        }
        else if (ev.t === 'ev.run_state') {
            if (ev.state === 'running')
                this.keepAwake.markActive();
        }
        else if (ev.t === 'ev.tool_event') {
            this.keepAwake.markActive();
        }
        if ((ev.t === 'ev.result' || ev.t === 'ev.run_state' || ev.t === 'ev.tool_event') && 'requestId' in ev) {
            const h = this.pendingHolds.get(ev.requestId);
            if (h) {
                clearInterval(h);
                this.pendingHolds.delete(ev.requestId);
            }
        }
    }
    pendingHolds = new Map();
    markActivity(_why) {
        this.keepAwake.markActive();
    }
    async onPayload(sessionId, payload) {
        if (payload.t === 'cmd.keep_awake') {
            if (payload.enabled) {
                if (payload.idleReleaseSec !== undefined)
                    this.keepAwake.setIdleRelease(payload.idleReleaseSec * 1000);
                this.keepAwake.enable();
                this.keepAwake.markActive();
            }
            else {
                this.keepAwake.disable('client');
            }
            this.relay.sendPayload(sessionId, { t: 'ev.result', cmdId: payload.cmdId, ok: true });
            this.relay.sendPayload(sessionId, this.keepAwakeStateEvent());
            return;
        }
        try {
            const result = await handlePayload(this.bridge, payload);
            if (result)
                this.relay.sendPayload(sessionId, result);
            // after a command that changes state, refresh the session list
            if (payload.t === 'cmd.send_prompt' || payload.t === 'cmd.resolve_permission' || payload.t === 'cmd.answer' || payload.t === 'cmd.interrupt') {
                await this.pushSessions(sessionId);
            }
        }
        catch (e) {
            this.say('payload error', e);
            this.relay.sendPayload(sessionId, {
                t: 'ev.result',
                cmdId: payload.cmdId ?? '',
                ok: false,
                message: String(e?.message ?? e),
            });
        }
    }
    async pushSessions(sessionId) {
        try {
            this.sessionsCache = await this.bridge.listSessions();
            this.relay.sendPayload(sessionId, { t: 'ev.session_changed', sessions: this.sessionsCache });
        }
        catch (e) {
            this.say('listSessions failed', e);
        }
    }
    async pushSessionsToAll() {
        const clients = this.relay.pairedClients;
        if (clients.length === 0)
            return;
        try {
            this.sessionsCache = await this.bridge.listSessions();
        }
        catch {
            return;
        }
        this.relay.broadcast({ t: 'ev.session_changed', sessions: this.sessionsCache });
    }
    get state() {
        return {
            relay: this.relay.status,
            hostId: this.relay.hostId,
            clients: this.relay.pairedClients.length,
            keepAwake: this.keepAwake.state,
            sessions: this.sessionsCache.length,
        };
    }
}
//# sourceMappingURL=host-runtime.js.map