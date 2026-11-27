'use strict';

const { version } = require('../../package.json');

const { homedir } = require('node:os');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { createHost, read, write, httpEndpoint } = require('./host.cjs');
const { service, createKernel, participate } = require('./harness.cjs');
const { createAwake } = require('./awake.cjs');
const { registerRoutes } = require('./routes.cjs');

const name = typeof __DRC_PLUGIN_NAME__ === 'string' ? __DRC_PLUGIN_NAME__ : '@dsh-remote/plugin';

function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  const disposers = [];
  const log = (message) => { try { ctx.logger?.('dsh-remote-control')?.warn(message); } catch {} };
  const stateDir = config.stateDir || process.env.DRC_STATE_DIR || join(homedir(), '.dsh', 'dsh-remote-control-v06');
  const configFile = join(stateDir, 'settings.json');
  const idFile = join(stateDir, 'identity.json');
  let host;
  let hostId;
  let settings = read(configFile) || {};
  let routeCleanup;
  let stopped = false;
  let change = Promise.resolve();

  const serverUrl = () => config.serverUrl || settings.serverUrl || process.env.DRC_SERVER_URL || 'wss://drc.provid.cc/v06';
  const configuredToken = () => config.hostToken || settings.hostToken || process.env.DRC_HOST_TOKEN || '';
  const state = () => {
    const snapshot = host?.status() || { state: 'offline', relay: 'offline', serverUrl: serverUrl(), version,
      relayProblem: serverUrl() ? '中继暂不可用' : '请配置中继地址', paired: 0, onlinePhones: 0, waiting: 0, sas: '' };
    return { ...snapshot, tokenConfigured: !!configuredToken(), serverLocked: !!config.serverUrl };
  };

  async function restart() {
    await host?.stop();
    host = null;
    if (stopped || !serverUrl()) return;
    const kernel = createKernel(ctx, { newSessionCwd: config.newSessionCwd || process.env.DRC_NEW_SESSION_CWD, stateDir, log });
    const awake = createAwake({ enabled: config.keepAwake?.enabled !== false, idleReleaseSec: config.keepAwake?.idleReleaseSec ?? 300,
      report: (status) => host?.emit({ t: 'ev.keep_awake_state', ...status }) });
    host = createHost({ url: serverUrl(), token: configuredToken(), hostId, kernel, stateDir, awake, log,
      label: config.hostLabel || 'DSH' });
    await host.start();
  }

  function requireHost() {
    if (!host) throw new Error('先保存中继地址并等待连接');
    return host;
  }

  function mount(web) {
    if (routeCleanup || stopped || typeof web?.register !== 'function') return;
    try {
      routeCleanup = registerRoutes(web, {
        status: state,
        issueCode: () => requireHost().issueCode(),
        getCodeImage: (code) => requireHost().getCodeImage(code),
        unpair: () => requireHost().unpairAll(),
        configure(patch) {
          const task = change.then(async () => {
            const next = { ...settings };
            if ('serverUrl' in patch) {
              if (config.serverUrl) throw new Error('中继地址由宿主配置固定');
              if (typeof patch.serverUrl !== 'string' || patch.serverUrl.length > 512) throw new Error('中继地址无效');
              const value = patch.serverUrl.trim();
              if (value) httpEndpoint(value, '/healthz');
              if (host?.status().paired && value !== serverUrl()) throw new Error('请先解除配对，再更改中继');
              next.serverUrl = value;
            }
            if (patch.clearHostToken === true) delete next.hostToken;
            if (typeof patch.hostToken === 'string' && patch.hostToken.trim()) {
              if (patch.hostToken.length > 512 || /[\x00-\x20]/.test(patch.hostToken.trim())) throw new Error('令牌格式无效');
              next.hostToken = patch.hostToken.trim();
            }
            write(configFile, next);
            settings = next;
            await restart();
          });
          change = task.catch(() => {});
          return task;
        },
      });
    } catch { log('远程控制路由注册失败'); }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    routeCleanup?.();
    for (const off of disposers.splice(0)) { try { off(); } catch {} }
    void host?.stop().catch(() => {});
  }

  try {
    const old = read(idFile);
    hostId = config.hostId || old?.hostId || 'drc-' + randomBytes(12).toString('hex');
    if (!old || old.hostId !== hostId) write(idFile, { hostId });
    mount(service(ctx, 'webServer'));
    if (!routeCleanup && typeof ctx.inject === 'function') {
      const off = ctx.inject(['webServer'], (scoped) => mount(service(scoped || ctx, 'webServer')));
      if (typeof off === 'function') disposers.push(off);
    }
    for (const [type, kind] of [['approval/request', 'permission'], ['user-questions/request', 'question']]) {
      try {
        const off = ctx.on?.(type, (request, next) => host ? participate(host, kind, request, next) : next?.(),
          { global: true, prepend: true });
        if (typeof off === 'function') disposers.push(off);
      } catch { log('宿主未提供 ' + type); }
    }
    if (typeof ctx.effect === 'function') ctx.effect(() => stop);
    else ctx.onDispose?.(stop);
    change = restart().catch(() => log('远程控制启动失败'));
  } catch {
    stop();
    log('远程控制没有启动');
  }
}

module.exports = { apply, name };
