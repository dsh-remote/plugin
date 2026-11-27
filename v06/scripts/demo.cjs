'use strict';

const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { createInterface } = require('node:readline');
const { createRelay } = require('../packages/relay/index.cjs');
const { createHost } = require('../packages/plugin/host.cjs');

async function main() {
  const path = await mkdtemp(join(tmpdir(), 'drc-v06-demo-'));
  const port = Number(process.env.DRC_DEMO_PORT || 8788);
  const relay = createRelay({ masterToken: randomBytes(32).toString('hex'), port });
  let host;
  let terminal;
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    terminal?.close();
    await host?.stop();
    await relay.close();
    await rm(path, { recursive: true, force: true });
  }
  const stop = () => { void close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const { ws } = await relay.start();
    let consumer;
    let seenSas;
    let next = 1;
    const tasks = [{ id: 'example', title: '验收配对与消息链路', workspace: '/demo/remote-control', state: 'idle',
      updatedAt: new Date().toISOString() }];
    const transcript = new Map();
    const emit = (event) => {
      const journal = transcript.get(event.sessionId) || [];
      if (event.t === 'ev.message_delta') {
        journal.push(event);
        transcript.set(event.sessionId, journal);
      }
      consumer?.(event);
    };
    host = createHost({
      url: ws, hostId: 'demo-host', label: '本地演示电脑', stateDir: path,
      onStatus(status) {
        if (status.sas && seenSas !== status.sas) {
          seenSas = status.sas;
          console.log('核对码 ' + status.sas + '。请与手机逐位比对。');
        }
      },
      kernel: {
        subscribe(fn) { consumer = fn; return () => { consumer = undefined; }; },
        async listSessions() { return tasks; },
        async sendPrompt(sessionId, text) {
          const reply = '本地演示收到指令：' + text;
          emit({ t: 'ev.message_delta', sessionId, messageId: 'u-' + next, role: 'user', delta: text, done: true });
          emit({ t: 'ev.message_delta', sessionId, messageId: 'a-' + next++, role: 'assistant', delta: reply, done: true });
        },
        async newSession(workspace) {
          const id = 'demo-' + next++;
          tasks.push({ id, title: '新会话', workspace: workspace || '/demo/remote-control', state: 'idle' });
          return id;
        },
        async archiveSession(id, archived) {
          const row = tasks.find((entry) => entry.id === id);
          if (row) row.state = archived ? 'archived' : 'idle';
        },
        async interrupt(sessionId) { emit({ t: 'ev.run_state', sessionId, state: 'idle' }); },
        async history(id, { since, beforeSeq, limit = 60 }) {
          const rows = transcript.get(id) || [];
          const selected = rows.map((value, index) => ({ value, seq: index + 1 }))
            .filter((entry) => (since === undefined || entry.seq > since) && (beforeSeq === undefined || entry.seq < beforeSeq));
          if (since !== undefined && selected.length > limit) return { error: 'history_window_exceeded' };
          const page = selected.slice(-limit);
          return { items: page.map((row) => row.value), latestSeq: rows.length,
            nextBeforeSeq: selected.length > page.length ? page[0].seq : undefined };
        },
      },
    });
    await host.start();
    for (let i = 0; i < 100 && host.status().state !== 'online'; i += 1) await new Promise((done) => setTimeout(done, 30));
    if (host.status().state !== 'online') throw new Error('本地演示主机未能连接');
    console.log('本地演示中继 ' + ws);
    console.log('可在模拟器自动化测试中注入扫码结果。终端回车刷新，输入 q 退出。');
    async function issue() {
      const code = await host.issueCode();
      console.log('扫码测试 scene ' + code.token);
    }
    await issue();
    terminal = createInterface({ input: process.stdin, output: process.stdout });
    terminal.on('line', (line) => {
      if (line.trim().toLowerCase() === 'q') stop();
      else void issue().catch((error) => console.error(error.message));
    });
    terminal.once('close', stop);
  } catch (error) {
    await close();
    throw error;
  }
}

void main().catch((error) => { console.error(error.message); process.exitCode = 1; });
