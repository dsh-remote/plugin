'use strict';

const FAST_ATTEMPTS = 5;
const COOLDOWN = 60000;
const SLOW_INTERVAL = 600000;

const systemClock = {
  now: Date.now,
  set(delay, fn) { const timer = setTimeout(fn, delay); timer.unref?.(); return timer; },
  clear(timer) { clearTimeout(timer); },
};

function createTokenRecovery({ clock = systemClock, claim, activate, change = () => {} }) {
  let slot;
  let attempts = 0;
  let inFlight = false;
  let disposed = false;
  let generation = 0;
  let next = 0;
  let mode = 'idle';

  function status() { return { mode, attempts }; }

  function report(value) {
    mode = value;
    change(status());
  }

  function schedule() {
    if (disposed || slot !== undefined || inFlight) return;
    slot = clock.set(Math.max(0, next - clock.now()), attempt);
  }

  async function attempt() {
    slot = undefined;
    if (disposed) return;
    const current = generation;
    if (mode === 'slow') attempts = 0;
    attempts += 1;
    inFlight = true;
    report('fast');
    let token;
    try { token = await claim(); } catch {}
    if (current !== generation || disposed) return;
    inFlight = false;
    const exhausted = attempts >= FAST_ATTEMPTS;
    next = clock.now() + (exhausted ? SLOW_INTERVAL : COOLDOWN);
    report(exhausted ? 'slow' : 'fast');
    if (token) activate(token);
    else schedule();
  }

  function reset() {
    generation += 1;
    if (slot !== undefined) clock.clear(slot);
    slot = undefined;
    attempts = 0;
    inFlight = false;
    next = 0;
    report('idle');
  }

  return {
    rejected: schedule, online: reset, status,
    stop() { disposed = true; reset(); },
  };
}

module.exports = { createTokenRecovery, systemClock };
