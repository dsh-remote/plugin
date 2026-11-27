'use strict';

const { createClient, normalizeUrl, sceneToken } = require('./core.js');
const config = require('./runtime-config.js');
const systemTheme = require('./theme-native.js');

const storage = {
  read: (key) => wx.getStorageSync(key),
  write: (key, value) => wx.setStorageSync(key, value),
  remove: (key) => wx.removeStorageSync(key),
};

function socket(url, events) {
  const task = wx.connectSocket({ url, fail: events.error });
  task.onOpen(events.open);
  task.onMessage((event) => events.message(event.data));
  task.onClose((event) => events.close(event.code));
  task.onError(events.error);
  return {
    send(raw) {
      try { task.send({ data: raw, fail: events.error }); return true; }
      catch { return false; }
    },
    close() { try { task.close({ code: 1000 }); } catch {} },
  };
}

function random(length) {
  if (typeof wx.getRandomValues === 'function') {
    return new Promise((resolve, reject) => wx.getRandomValues({
      length,
      success(result) {
        const bytes = new Uint8Array(result.randomValues || 0);
        if (bytes.length === length) resolve(bytes);
        else reject(new Error('系统未返回所需的安全随机数'));
      },
      fail() { reject(new Error('无法获取安全随机数，请更新微信后重试')); },
    }));
  }
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
  }
  throw new Error('当前微信环境不支持安全配对，请更新微信');
}

App({
  onLaunch(options) {
    this.entry = options || {};
    this.client = createClient({ storage, socket, random });
    this.settings = { url: this.client.snapshot().url || storage.read('drc.v06.relay-url') || config.relayUrl,
      theme: storage.read('drc.v06.theme') === 'dark' ? 'dark' : 'light' };
  },
  onShow(options) {
    this.entry = options || this.entry || {};
    if (!sceneToken(this.entry) && this.client.snapshot().paired) {
      void this.client.connect().catch((error) => this.toast(error.message));
    }
  },
  setRelay(value) {
    const url = normalizeUrl(value);
    if (this.client.snapshot().paired && this.client.snapshot().url !== url) {
      throw new Error('更换中继前，请先解除当前配对');
    }
    storage.write('drc.v06.relay-url', url);
    this.settings.url = url;
  },
  setTheme(value) {
    this.settings.theme = value;
    try { storage.write('drc.v06.theme', value); } catch {}
    this.applyTheme();
  },
  applyTheme() {
    const { frontColor, backgroundColor, backgroundColorTop } = systemTheme[this.settings.theme] || systemTheme.light;
    wx.setNavigationBarColor?.({ frontColor, backgroundColor });
    wx.setBackgroundColor?.({ backgroundColor, backgroundColorTop });
  },
  toast(title) { wx.showToast?.({ title, icon: 'none' }); },
  storage,
});
