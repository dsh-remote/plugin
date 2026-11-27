'use strict';

const { spawn } = require('node:child_process');
const { systemClock } = require('./token-recovery.cjs');

function backend(platform = process.platform) {
  if (platform === 'darwin') return { label: 'caffeinate', command: 'caffeinate', args: ['-i'] };
  if (platform === 'linux') return { label: 'systemd-inhibit', command: 'systemd-inhibit',
    args: ['--what=sleep:idle', '--mode=block', '--who=DSH Remote Control', '--why=DSH task running', 'cat'] };
  if (platform === 'win32') {
    const script = [
      "Add-Type -Name Awake -Namespace Drc -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
      '[Drc.Awake]::SetThreadExecutionState(2147483649) | Out-Null',
      '[Console]::ReadLine() | Out-Null',
      '[Drc.Awake]::SetThreadExecutionState(2147483648) | Out-Null',
    ].join('; ');
    return { label: 'SetThreadExecutionState', command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
  }
  return { label: 'unavailable' };
}

function createAwake({ clock = systemClock, acquire, idleReleaseSec = 300, enabled = true, report = () => {} } = {}) {
  const implementation = backend();
  let active;
  let timer;
  let busy = false;
  let reason;
  let disposed = false;

  function holdDefault(onExit) {
    if (!implementation.command) throw new Error('当前平台没有防休眠能力');
    const child = spawn(implementation.command, implementation.args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.once('error', () => onExit('防休眠启动失败'));
    child.once('exit', (code) => { if (code !== null && code !== 0) onExit('系统防休眠命令退出'); });
    child.stdin?.on('error', () => {});
    return () => {
      child.stdin?.end();
      child.kill();
    };
  }

  function cancelTimer() {
    if (timer !== undefined) clock.clear(timer);
    timer = undefined;
  }

  function release() {
    cancelTimer();
    const old = active;
    active = undefined;
    old?.();
  }

  function state() {
    return { enabled, active: !!active, platform: process.platform, backend: implementation.label, reason };
  }

  function activity(running) {
    busy = running;
    if (disposed || !enabled) return;
    if (running) {
      cancelTimer();
      if (active) return;
      try {
        active = (acquire || holdDefault)((error) => { reason = error; release(); report(state()); });
        reason = undefined;
      } catch (error) { reason = error.message; }
      report(state());
    } else if (active && idleReleaseSec > 0 && timer === undefined) {
      timer = clock.set(idleReleaseSec * 1000, () => { release(); report(state()); });
    }
  }

  return {
    activity, state,
    configure(value, idle) {
      enabled = value;
      if (idle !== undefined) idleReleaseSec = idle;
      cancelTimer();
      if (!enabled) release();
      else activity(busy);
      return state();
    },
    dispose() { disposed = true; release(); },
  };
}

module.exports = { backend, createAwake };
