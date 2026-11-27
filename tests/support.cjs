const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { randomBytes } = require('node:crypto');
const WebSocket = require('ws');

const masterToken = 'relay-master-token-for-local-testing';
const random = (size) => new Uint8Array(randomBytes(size));

async function until(read, reason, timeout = 3500) {
  const end = Date.now() + timeout;
  while (Date.now() <= end) {
    const result = await read();
    if (result) return result;
    await wait(8);
  }
  assert.fail('Timed out: ' + reason);
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'drc06-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function memoryStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    read: (name) => values.get(name),
    write: (name, value) => values.set(name, structuredClone(value)),
    remove: (name) => values.delete(name),
  };
}

async function rawSocket(t, url) {
  const socket = new WebSocket(url);
  const frames = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data))));
  const opened = new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });
  t.after(() => socket.terminate());
  await opened;
  return {
    frames,
    send: (frame) => socket.send(JSON.stringify(frame)),
    close: () => new Promise((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once('close', resolve);
      socket.close();
    }),
    next: (type, predicate = () => true) => until(() => {
      const index = frames.findIndex((frame) => frame.t === type && predicate(frame));
      if (index >= 0) return frames.splice(index, 1)[0];
    }, type),
  };
}

function nodeSocket(url, events) {
  const socket = new WebSocket(url);
  socket.on('open', events.open);
  socket.on('message', (data) => events.message(String(data)));
  socket.on('close', (code) => events.close(code));
  socket.on('error', (error) => events.error(error));
  return {
    send(raw) {
      if (socket.readyState !== WebSocket.OPEN) return false;
      socket.send(raw);
      return true;
    },
    close: () => socket.close(),
  };
}

function fakeTimers(start = 0) {
  let time = start;
  let serial = 0;
  const jobs = new Map();
  return {
    now: () => time,
    set(delay, run) {
      const id = ++serial;
      jobs.set(id, { at: time + delay, run });
      return id;
    },
    clear: (id) => jobs.delete(id),
    async step(ms) {
      const end = time + ms;
      for (;;) {
        const job = [...jobs].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!job) break;
        jobs.delete(job[0]);
        time = job[1].at;
        await job[1].run();
      }
      time = end;
    },
  };
}

module.exports = { masterToken, random, until, tempDir, memoryStore, rawSocket, nodeSocket, fakeTimers };
