'use strict';

const PROTOCOL = 1;
const MAX_FRAME = 1024 * 1024;
const MAX_CIPHER = MAX_FRAME - 8192;
const MAX_TEXT = 20000;
const MAX_MEDIA = 512 * 1024;
const MAX_ATTACHMENTS = 4;
const TOKEN = /^\d{6}$/;
const CONVERSATION = /^c_[a-f0-9]{12}$/;
const HOST_ID = /^[a-zA-Z0-9_.:-]{1,200}$/;
const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const str = (v, size = 200) => typeof v === 'string' && v.length > 0 && v.length <= size;
const record = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const opt = (v, check) => v === undefined || check(v);
const b64 = (v, size = MAX_CIPHER) => str(v, size) && BASE64.test(v);
const code = (v) => typeof v === 'string' && TOKEN.test(v);
const conv = (v) => typeof v === 'string' && CONVERSATION.test(v);
const hostId = (v) => typeof v === 'string' && HOST_ID.test(v);
const publicKey = (v) => typeof v === 'string' && PUBLIC_KEY.test(v);

function pick(source, keys) {
  const target = {};
  for (const key of keys) {
    if (owns(source, key)) target[key] = source[key];
  }
  return target;
}

function validDigest(value) {
  return record(value) && Object.keys(value).every((k) => ['at', 'running', 'steps', 'pending'].includes(k))
    && count(value.at) && typeof value.running === 'boolean'
    && opt(value.steps, count) && opt(value.pending, count);
}

const shapes = {
  'pair-begin': ['host', ['pairingToken'], (x) => code(x.pairingToken)],
  'pair-begin-client': ['client', ['pairingToken', 'clientPub'],
    (x) => code(x.pairingToken) && opt(x.clientPub, publicKey)],
  'pair-grant': ['host', ['sessionId', 'hostPub', 'nonce', 'wrappedPsk'],
    (x) => conv(x.sessionId) && publicKey(x.hostPub) && x.nonce?.length === 32
      && x.wrappedPsk?.length === 44 && b64(x.nonce, 32) && b64(x.wrappedPsk, 44)],
  enc: [null, ['sessionId', 'seq', 'ciphertext'],
    (x) => conv(x.sessionId) && opt(x.seq, count) && b64(x.ciphertext)],
  'enc-batch': [null, ['sessionId', 'items'], (x) => conv(x.sessionId) && Array.isArray(x.items)
    && x.items.length > 0 && x.items.length <= 200
    && x.items.every((i) => record(i) && opt(i.seq, count) && b64(i.ciphertext))],
  summary: ['host', ['sessionId', 'summary'], (x) => conv(x.sessionId) && validDigest(x.summary)],
  'session-leave': [null, ['sessionId'], (x) => conv(x.sessionId)],
  resync: ['host', ['sessionIds'], (x) => Array.isArray(x.sessionIds) && x.sessionIds.length <= 256 && x.sessionIds.every(conv)],
  ping: [null, ['ts'], (x) => opt(x.ts, count)],
  'notify-register': ['client', ['code', 'subscribed'], (x) => str(x.code, 256) && opt(x.subscribed, (v) => typeof v === 'boolean')],
  'notify-approval': ['host', ['sessionId', 'items'], (x) => conv(x.sessionId) && Array.isArray(x.items)
    && x.items.length > 0 && x.items.length <= 10 && x.items.every((item) => record(item)
      && str(item.requestId, 256) && str(item.sessionId, 256) && ['approval', 'question'].includes(item.kind) && str(item.askedAt, 40)
      && Object.keys(item).every((k) => ['requestId', 'sessionId', 'kind', 'askedAt'].includes(k)))],
};

function decodeEndpoint(raw, role) {
  if (typeof raw !== 'string' || raw.length > MAX_FRAME) return { error: 'bad_frame' };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: 'bad_json' };
  }
  if (!record(value) || !str(value.t)) return { error: 'unknown_frame' };
  if (value.t === 'hello') {
    if (role) return { error: 'bad_role' };
    if (value.protocol !== PROTOCOL) return { error: 'unsupported_protocol' };
    if (!['client', 'host'].includes(value.role)) return { error: 'bad_role' };
    if (!opt(value.token, (v) => str(v, 512)) || !opt(value.hostId, hostId)
      || !opt(value.clientId, (v) => str(v, 128)) || !opt(value.label, (v) => str(v, 128))
      || !opt(value.softwareVersion, (v) => str(v, 64))) return { error: 'bad_frame' };
    const frame = pick(value, ['t', 'role', 'protocol', 'softwareVersion']);
    if (frame.role === 'host') {
      if (!hostId(value.hostId)) return { error: 'bad_frame' };
      Object.assign(frame, pick(value, ['hostId', 'token', 'label']));
    } else {
      Object.assign(frame, pick(value, ['clientId']));
      if (record(value.clientMeta)) {
        const meta = pick(value.clientMeta, ['platform', 'label']);
        if (Object.values(meta).every((v) => str(v, 128))) frame.clientMeta = meta;
      }
      if (value.resume !== undefined) {
        if (!record(value.resume) || !conv(value.resume.sessionId) || !count(value.resume.fromSeq)) return { error: 'bad_frame' };
        frame.resume = pick(value.resume, ['sessionId', 'fromSeq']);
      }
    }
    return { frame };
  }
  if (!role) return { error: 'need_hello' };
  if (!owns(shapes, value.t)) return { error: 'unknown_frame' };
  const [required, fields, validate] = shapes[value.t];
  if (required && role !== required) return { error: 'need_' + required };
  if (!validate(value)) return { error: 'bad_frame' };
  const frame = pick(value, ['t', ...fields]);
  if (frame.t === 'enc-batch') frame.items = frame.items.map((item) => pick(item, ['seq', 'ciphertext']));
  if (frame.t === 'notify-approval') frame.items = frame.items.map((item) => pick(item, ['kind', 'requestId', 'sessionId', 'askedAt']));
  return { frame };
}

function mediaBytes(value) {
  return value.length * 3 / 4 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
}

function validMedia(media, image) {
  return opt(media, (items) => Array.isArray(items) && items.length <= MAX_ATTACHMENTS
    && items.every((item) => record(item) && str(item.name, 255)
      && b64(item.data, 4 * Math.ceil(MAX_MEDIA / 3)) && mediaBytes(item.data) <= MAX_MEDIA
      && (image ? item.mediaType === 'image/jpeg' : opt(item.mediaType, (v) => str(v, 64)))));
}

function validPrompt(x) {
  if (!str(x.sessionId) || typeof x.text !== 'string' || x.text.length > MAX_TEXT) return false;
  if (!validMedia(x.images, true) || !validMedia(x.files, false)) return false;
  const items = [...(x.images || []), ...(x.files || [])];
  return (x.text.trim().length > 0 || items.length > 0)
    && items.reduce((sum, item) => sum + mediaBytes(item.data), 0) <= MAX_MEDIA;
}

const commands = {
  'cmd.list_sessions': () => true,
  'cmd.get_pending': (x) => opt(x.sessionId, str),
  'cmd.send_prompt': validPrompt,
  'cmd.new_session': (x) => opt(x.workspace, (v) => typeof v === 'string' && v.length <= 1024),
  'cmd.interrupt': (x) => str(x.sessionId),
  'cmd.archive_session': (x) => str(x.sessionId) && opt(x.archived, (v) => typeof v === 'boolean'),
  'cmd.session_history': (x) => str(x.sessionId) && opt(x.beforeSeq, count) && opt(x.since, count)
    && (x.beforeSeq === undefined || x.since === undefined) && opt(x.limit, (v) => count(v) && v >= 1 && v <= 200),
  'cmd.resolve_permission': (x) => str(x.sessionId) && str(x.requestId) && str(x.decision),
  'cmd.answer': (x) => str(x.sessionId) && str(x.requestId) && Array.isArray(x.answers)
    && x.answers.length > 0 && x.answers.length <= 100
    && x.answers.every((a) => record(a) && str(a.questionId) && Array.isArray(a.selected)
      && a.selected.length <= 100 && a.selected.every((s) => str(s)) && opt(a.freeText, (v) => str(v, MAX_TEXT) || v === '')),
  'cmd.keep_awake': (x) => typeof x.enabled === 'boolean' && opt(x.idleReleaseSec, count),
};

function validateCommand(value) {
  return record(value) && owns(commands, value.t) && str(value.cmdId, 256) && commands[value.t](value);
}

module.exports = {
  PROTOCOL, MAX_FRAME, MAX_CIPHER, MAX_TEXT, MAX_MEDIA, MAX_ATTACHMENTS,
  HOST_ID, CONVERSATION, TOKEN, validDigest, validateCommand, decodeEndpoint,
};
