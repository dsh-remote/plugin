'use strict';

const { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } = require('node:fs');
const { dirname } = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { CONVERSATION, HOST_ID, validDigest } = require('../protocol/wire.cjs');

const hexToken = /^[0-9a-f]{48}$/;
const time = (value) => Number.isSafeInteger(value) && value >= 0;

function loadState(file, report) {
  const conversations = new Map();
  const tokens = new Map();
  if (!file) return { conversations, tokens };
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    for (const row of Array.isArray(state.hostTokens) ? state.hostTokens : []) {
      if (!row || !HOST_ID.test(row.hostId) || !hexToken.test(row.token) || !time(row.issuedAt) || !time(row.lastUsedAt)) continue;
      tokens.set(row.hostId, { token: row.token, issuedAt: row.issuedAt, lastUsedAt: row.lastUsedAt });
    }
    for (const row of Array.isArray(state.conversations) ? state.conversations : []) {
      if (!row || !CONVERSATION.test(row.conversationId) || !HOST_ID.test(row.hostId) || !time(row.seqHost)
        || !time(row.lastActivityAt) || !Array.isArray(row.clients)) continue;
      const clientId = row.clients.find((client) => typeof client === 'string' && client.length > 0 && client.length <= 128);
      if (!clientId) continue;
      conversations.set(row.conversationId, {
        hostId: row.hostId, clientId, sequence: row.seqHost, activeAt: row.lastActivityAt,
        upCount: time(row.upCount) ? row.upCount : 0, ring: [], bytes: 0,
        summary: validDigest(row.summary) ? row.summary : undefined,
      });
    }
  } catch (cause) {
    if (cause.code !== 'ENOENT') report('state ignored');
  }
  return { conversations, tokens };
}

function saveState(file, now, conversations, tokens) {
  if (!file) return;
  const snapshot = {
    version: 2, savedAt: now,
    hostTokens: Array.from(tokens, ([hostId, value]) => ({ hostId, ...value })),
    conversations: Array.from(conversations, ([conversationId, row]) => ({
      conversationId, hostId: row.hostId, clients: [row.clientId], seqHost: row.sequence,
      upCount: row.upCount, lastActivityAt: row.activeAt, summary: row.summary,
    })),
  };
  const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temp, file);
  } finally {
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function match(expected, supplied) {
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function issueToken(tokens, hostId, now, max, ttl) {
  const token = randomBytes(24).toString('hex');
  tokens.set(hostId, { token, issuedAt: now, lastUsedAt: 0 });
  for (const [id, value] of tokens) {
    if (id !== hostId && Math.max(value.issuedAt, value.lastUsedAt) < now - ttl) tokens.delete(id);
  }
  if (tokens.size > max) {
    const ordered = [...tokens].filter(([id]) => id !== hostId);
    ordered.sort(([, a], [, b]) => Number(a.lastUsedAt > 0) - Number(b.lastUsedAt > 0)
      || (a.lastUsedAt || a.issuedAt) - (b.lastUsedAt || b.issuedAt));
    for (const [id] of ordered.slice(0, tokens.size - max)) tokens.delete(id);
  }
  return token;
}

module.exports = { loadState, saveState, match, issueToken };
