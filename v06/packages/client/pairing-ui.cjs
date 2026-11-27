'use strict';

const MINI_PROGRAM_SCAN = new Set([1047, 1048, 1049]);

function code(value) {
  if (typeof value !== 'string') return '';
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch {}
  return /^\d{6}$/.test(decoded) ? decoded : '';
}

function sceneToken(options = {}) {
  return MINI_PROGRAM_SCAN.has(Number(options.scene)) ? code(options.query?.scene) : '';
}

function scanToken(result) {
  const match = typeof result?.path === 'string' && result.path.match(/[?&]scene=([^&#]+)/);
  return code(match?.[1]) || code(result?.result);
}

function createPairingUI({ pair, accept, reject, showSas, knownDead = () => false }) {
  let lastLaunch;
  let dialog = null;
  let answered = null;

  async function claim(token) {
    if (!token) throw new Error('请扫描 Harness 远程控制面板上的小程序码');
    if (knownDead(token)) throw new Error('配对码已失效，请在电脑上刷新后重扫');
    if (dialog) return false;
    answered = null;
    return pair(token);
  }

  async function launch(options) {
    const token = sceneToken(options);
    if (!token || options === lastLaunch || knownDead(token)) return false;
    lastLaunch = options;
    return claim(token);
  }

  async function grant(offer) {
    if (!offer || dialog || answered === offer.id || !showSas) return;
    dialog = offer.id;
    let confirmed;
    try { confirmed = await showSas(offer.sas); }
    catch { return; }
    finally { dialog = null; }
    answered = offer.id;
    if (confirmed) {
      const accepted = await accept?.(offer.id);
      if (accepted === false) answered = null;
      return accepted;
    }
    return reject?.(offer.id);
  }

  return { launch, grant, scan: (result) => claim(scanToken(result)) };
}

module.exports = { sceneToken, scanToken, createPairingUI };
