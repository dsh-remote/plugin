export class DshKernelBridge {
    opts;
    emit = null;
    respondables = new Map();
    abort = null;
    say;
    constructor(opts) {
        this.opts = opts;
        this.say = opts.log ?? (() => { });
    }
    get carrier() {
        if (this.opts.gateway)
            return 'typert';
        if (this.opts.apiProxy)
            return 'apiproxy';
        return 'none';
    }
    watch(emit) {
        this.emit = emit;
        this.abort = new AbortController();
        if (this.carrier === 'typert')
            void this.pumpTypertEvents();
        else if (this.carrier === 'apiproxy')
            void this.pumpMuxEvents();
        return () => {
            this.abort?.abort();
            this.abort = null;
            this.emit = null;
        };
    }
    // ── typert carrier ─────────────────────────────────────
    async callRc(endpoint, args) {
        const gw = this.opts.gateway;
        if (!gw)
            throw new Error('no typert gateway');
        const [namespace, method] = endpoint.split('/');
        return gw.invoke({ namespace: namespace, method: method, args, signal: AbortSignal.timeout(30_000) });
    }
    async pumpTypertEvents() {
        const gw = this.opts.gateway;
        if (!gw?.openWireStream) {
            this.say('typert gateway has no wire stream; approvals via $events unavailable');
            return;
        }
        try {
            const stream = gw.openWireStream('$events', { args: {} }, this.abort.signal);
            for await (const frame of stream) {
                this.handleTypertEventFrame(frame);
            }
        }
        catch (e) {
            this.say('typert $events pump ended', e);
        }
    }
    handleTypertEventFrame(frame) {
        const f = frame;
        if (!f || typeof f !== 'object')
            return;
        if (f.type === 'waterfall' && f.event === 'approval/request' && f.eventId) {
            const req = (f.request ?? {});
            const sessionId = String(f.agentId ?? req.sessionId ?? '');
            const requestId = String(f.eventId);
            this.respondables.set(requestId, { sessionId, kind: 'approval', token: requestId });
            this.emit?.({
                t: 'ev.permission_request',
                sessionId,
                requestId,
                action: String(req.tool ?? req.action ?? 'permission'),
                resource: String(req.resource ?? req.command ?? req.description ?? '') || undefined,
                reason: typeof req.reason === 'string' ? req.reason : undefined,
                options: [
                    { id: 'approve', label: '允许一次' },
                    { id: 'approve_session', label: '本会话允许' },
                    { id: 'reject', label: '拒绝' },
                ],
            });
            return;
        }
        if (f.type === 'waterfall' && f.event === 'user-questions/request' && f.eventId) {
            const req = (f.request ?? {});
            const sessionId = String(f.agentId ?? '');
            const requestId = String(f.eventId);
            const questions = (req.questions ?? []).map((q0, i) => {
                const q = q0;
                return {
                    id: String(q.id ?? `q${i}`),
                    question: String(q.question ?? ''),
                    multi: q.multi_select === true,
                    options: Array.isArray(q.options)
                        ? q.options.map((o, j) => ({ id: String(o.id ?? j), label: String(o.label ?? '') }))
                        : undefined,
                };
            });
            this.respondables.set(requestId, { sessionId, kind: 'question', token: requestId });
            this.emit?.({ t: 'ev.question_request', sessionId, requestId, questions });
            return;
        }
        if (f.type === 'cancel' && f.eventId) {
            const r = this.respondables.get(String(f.eventId));
            if (r) {
                this.respondables.delete(String(f.eventId));
                this.emit?.({
                    t: 'ev.run_state',
                    sessionId: r.sessionId,
                    state: r.kind === 'approval' ? 'awaiting-permission' : 'awaiting-answer',
                    detail: 'request-cancelled',
                });
            }
            return;
        }
        if (f.type === 'emit' && f.event) {
            this.handleNativeEvent(f.event, f.args);
        }
    }
    /** native cordis events forwarded via $events: session/event etc. */
    handleNativeEvent(event, args) {
        const arr = Array.isArray(args) ? args : [args];
        if (event === 'session/event') {
            const session = arr[0];
            const ev = arr[1];
            const sessionId = String(session?.id ?? '');
            const type = String(ev?.type ?? '');
            const payload = (ev?.payload ?? {});
            switch (type) {
                case 'message/delta':
                case 'message_delta': {
                    this.emit?.({
                        t: 'ev.message_delta',
                        sessionId,
                        messageId: String(payload.messageId ?? 'm'),
                        part: Number(payload.part ?? payload.index ?? 0),
                        delta: String(payload.delta ?? payload.text ?? ''),
                        role: 'assistant',
                    });
                    return;
                }
                case 'message/appended':
                case 'message': {
                    // user/assistant message appended — surface user echo + final assistant
                    const msg = payload;
                    const text = typeof msg.text === 'string'
                        ? msg.text
                        : (msg.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
                    if (msg.role === 'user') {
                        this.emit?.({ t: 'ev.message_delta', sessionId, messageId: 'u_' + Date.now(), part: 0, delta: text, role: 'user', done: true });
                    }
                    return;
                }
                default:
                    return;
            }
        }
        if (event === 'session/created' || event === 'session/disposed') {
            this.emit?.({ t: 'ev.session_changed', sessions: [], reason: event });
        }
    }
    // ── legacy apiProxy carrier ────────────────────────────
    async pumpMuxEvents() {
        const api = this.opts.apiProxy;
        if (!api)
            return;
        try {
            for await (const frame of api.events.mux({}, this.abort.signal)) {
                const f = frame;
                const p = f.payload ?? {};
                const type = String(p.type ?? '');
                const sessionId = String(p.sessionId ?? '');
                if (type === 'approval/requested') {
                    const requestId = String(p.approvalId ?? f.rpcId ?? '');
                    this.respondables.set(requestId, { sessionId, kind: 'approval', token: String(f.rpcId ?? requestId) });
                    this.emit?.({
                        t: 'ev.permission_request', sessionId, requestId,
                        action: String(p.tool ?? 'permission'),
                        resource: String(p.command ?? p.resource ?? '') || undefined,
                        reason: typeof p.reason === 'string' ? p.reason : undefined,
                        options: [
                            { id: 'approve', label: '允许一次' },
                            { id: 'approve_session', label: '本会话允许' },
                            { id: 'reject', label: '拒绝' },
                        ],
                    });
                }
                else if (type === 'question/requested') {
                    const requestId = String(f.rpcId ?? p.questionRpcId ?? '');
                    const questions = Array.isArray(p.questions) ? p.questions.map((q0, i) => {
                        const q = q0;
                        return { id: String(q.id ?? i), question: String(q.question ?? ''), multi: q.multi_select === true };
                    }) : [];
                    this.respondables.set(requestId, { sessionId, kind: 'question', token: String(f.rpcId ?? '') });
                    this.emit?.({ t: 'ev.question_request', sessionId, requestId, questions });
                }
                else if (type === 'session/event' || type === 'message/delta') {
                    this.handleNativeEvent('session/event', [p.session ?? { id: sessionId }, p.event ?? p]);
                }
            }
        }
        catch (e) {
            this.say('mux pump ended', e);
        }
    }
    // ── HarnessBridge implementation ───────────────────────
    async listSessions() {
        if (this.carrier === 'typert') {
            try {
                const res = (await this.callRc('session/list', { _request: {} }));
                const rows = (Array.isArray(res) ? res : (res.sessions ?? res.value?.sessions ?? []));
                return rows.map((s) => ({
                    id: String(s.id ?? s.sessionId ?? ''),
                    title: typeof s.title === 'string' ? s.title : undefined,
                    workspace: typeof s.workspace === 'string' ? s.workspace : (typeof s.cwd === 'string' ? s.cwd : undefined),
                    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : undefined,
                    running: s.busy === true || s.running === true,
                    state: String(s.state ?? (s.busy ? 'running' : 'idle')),
                }));
            }
            catch (e) {
                this.say('session/list failed', e);
                return [];
            }
        }
        if (this.carrier === 'apiproxy') {
            try {
                const res = (await this.opts.apiProxy.sessions.list({}));
                const rows = Array.isArray(res) ? res : res.sessions ?? [];
                return rows.map((s) => ({
                    id: String(s.id ?? ''),
                    title: typeof s.title === 'string' ? s.title : undefined,
                    workspace: typeof s.workspace === 'string' ? s.workspace : undefined,
                    state: 'idle',
                }));
            }
            catch (e) {
                this.say('sessions.list failed', e);
                return [];
            }
        }
        return [];
    }
    async sendPrompt(sessionId, text) {
        if (this.carrier === 'typert') {
            try {
                await this.callRc('session/prompt', {
                    request: {
                        requestId: 'drc_' + Date.now().toString(36),
                        sessionId,
                        mode: 'queue',
                        content: [{ type: 'text', text }],
                        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    },
                });
                return { ok: true };
            }
            catch (e) {
                return { ok: false, message: String(e?.message ?? e) };
            }
        }
        if (this.carrier === 'apiproxy') {
            try {
                await this.opts.apiProxy.sessions.prompt({
                    requestId: 'drc_' + Date.now().toString(36),
                    sessionId,
                    mode: 'queue',
                    content: [{ type: 'text', text }],
                });
                return { ok: true };
            }
            catch (e) {
                return { ok: false, message: String(e?.message ?? e) };
            }
        }
        return { ok: false, message: 'no DSH carrier available' };
    }
    async interrupt(sessionId) {
        if (this.carrier === 'typert') {
            try {
                await this.callRc('session/cancel', { request: { sessionId } });
                return { ok: true };
            }
            catch (e) {
                return { ok: false, message: String(e?.message ?? e) };
            }
        }
        if (this.carrier === 'apiproxy') {
            try {
                await this.opts.apiProxy.sessions.cancel({ sessionId });
                return { ok: true };
            }
            catch (e) {
                return { ok: false, message: String(e?.message ?? e) };
            }
        }
        return { ok: false, message: 'no DSH carrier available' };
    }
    async resolvePermission(sessionId, requestId, decision, note) {
        const r = this.respondables.get(requestId);
        if (!r || r.sessionId !== sessionId)
            return { ok: false, message: 'permission request not pending (or from another session)' };
        this.respondables.delete(requestId);
        const outcome = decision === 'reject' ? 'rejected' : 'allowed-once';
        if (this.carrier === 'typert') {
            try {
                // official shape: $events/result {args:{clientId,eventId,outcome}} with
                // outcome = {kind:'result', value} | {kind:'rejected', error}
                await this.callRc('$events/result', {
                    args: {
                        eventId: r.token,
                        outcome: outcome === 'allowed-once'
                            ? { kind: 'result', value: outcome }
                            : { kind: 'rejected', error: note ?? 'rejected from mobile' },
                    },
                });
                return { ok: true };
            }
            catch (e) {
                return { ok: false, message: String(e?.message ?? e) };
            }
        }
        if (this.carrier === 'apiproxy') {
            try {
                await this.opts.apiProxy.respond({
                    type: 'client-response',
                    rpcId: r.token,
                    result: { ok: true, value: { sessionId, approvalId: requestId, outcome } },
                });
                return { ok: true };
            }
            catch (e) {
                return { ok: false, message: String(e?.message ?? e) };
            }
        }
        return { ok: false, message: 'no DSH carrier' };
    }
    async answer(sessionId, requestId, answers) {
        const r = this.respondables.get(requestId);
        if (!r || r.sessionId !== sessionId)
            return { ok: false, message: 'question not pending' };
        this.respondables.delete(requestId);
        if (this.carrier === 'typert') {
            try {
                await this.callRc('$events/result', { args: { eventId: r.token, outcome: { kind: 'result', value: { answers } } } });
                return { ok: true };
            }
            catch (e) {
                return { ok: false, message: String(e?.message ?? e) };
            }
        }
        if (this.carrier === 'apiproxy') {
            try {
                await this.opts.apiProxy.respond({
                    type: 'client-response',
                    rpcId: r.token,
                    result: { ok: true, value: { sessionId, answer: JSON.stringify(answers) } },
                });
                return { ok: true };
            }
            catch (e) {
                return { ok: false, message: String(e?.message ?? e) };
            }
        }
        return { ok: false, message: 'no DSH carrier' };
    }
}
//# sourceMappingURL=adapter-dsh.js.map