#!/usr/bin/env node
'use strict';

const { createRelay } = require('./index.cjs');
const { createWechat } = require('./wechat.cjs');

function envInt(key) {
  const value = process.env[key];
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value)) throw new Error(key + ' 需要是非负整数');
  return Number(value);
}

async function main(args) {
  if (args.length) {
    if (args.length === 1 && ['--version', '-v'].includes(args[0])) return console.log('0.6.0');
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
      return console.log('DSH Remote Control relay 0.6.0\nDRC_HOST_TOKEN=... node main.cjs\nDRC_BIND、DRC_PORT 和 DRC_STATE_FILE 可配置');
    }
    process.stderr.write('无法识别的参数，请使用 --help\n');
    process.exitCode = 2;
    return;
  }
  const wechat = createWechat({ appId: process.env.DRC_MP_APPID, secret: process.env.DRC_MP_SECRET,
    envVersion: process.env.DRC_MP_ENV || 'release', templateId: process.env.DRC_MP_APPROVAL_TEMPLATE_ID });
  const relay = createRelay({
    masterToken: process.env.DRC_HOST_TOKEN, bind: process.env.DRC_BIND, port: envInt('DRC_PORT') ?? 8788,
    trustLocalProxy: process.env.DRC_TRUST_LOCAL_PROXY === '1',
    stateFile: process.env.DRC_STATE_FILE, maxHostTokens: envInt('DRC_MAX_HOST_TOKENS'),
    hostTokenTtlMs: envInt('DRC_HOST_TOKEN_TTL_MS'), claimIntervalMs: envInt('DRC_CLAIM_MIN_INTERVAL_MS'),
    maxPairAttemptsPerConn: envInt('DRC_PAIR_ATTEMPTS_PER_CONN'), pairGlobalPerSec: envInt('DRC_PAIR_GLOBAL_PER_SEC'),
    pairTtlMs: envInt('DRC_PAIR_TTL_MS'), conversationTtlMs: envInt('DRC_CONV_IDLE_TTL_MS'),
    miniProgramCode: wechat?.code, notifier: wechat?.notifier,
    report: (message) => console.error('[drc-relay] ' + message),
  });
  const address = await relay.start();
  console.log('[drc-relay] 0.6.0 listening on ' + address.http);
  const stop = () => { void relay.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main(process.argv.slice(2)).catch((error) => {
  console.error('[drc-relay] ' + (error.code || error.message));
  process.exitCode = 1;
});
