/** Dispatch a decrypted client payload onto the bridge; returns optional result payload. */
export async function handlePayload(bridge, payload) {
    switch (payload.t) {
        case 'cmd.list_sessions': {
            const sessions = await bridge.listSessions();
            return { t: 'ev.result', cmdId: payload.cmdId, ok: true, data: { sessions } };
        }
        case 'cmd.send_prompt': {
            const r = await bridge.sendPrompt(payload.sessionId, payload.text);
            return { t: 'ev.result', cmdId: payload.cmdId, ok: r.ok, message: r.message };
        }
        case 'cmd.answer': {
            const r = await bridge.answer(payload.sessionId, payload.requestId, payload.answers);
            return { t: 'ev.result', cmdId: payload.cmdId, ok: r.ok, message: r.message };
        }
        case 'cmd.resolve_permission': {
            const r = await bridge.resolvePermission(payload.sessionId, payload.requestId, payload.decision, payload.note);
            return { t: 'ev.result', cmdId: payload.cmdId, ok: r.ok, message: r.message };
        }
        case 'cmd.interrupt': {
            const r = await bridge.interrupt(payload.sessionId);
            return { t: 'ev.result', cmdId: payload.cmdId, ok: r.ok, message: r.message };
        }
        case 'cmd.subscribe':
        default:
            return payload.t === 'cmd.subscribe'
                ? { t: 'ev.result', cmdId: payload.cmdId, ok: true }
                : null;
    }
}
//# sourceMappingURL=bridge.js.map