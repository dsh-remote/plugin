'use strict';

const { createPairingUI, selectSessions } = require('../../core.js');

function demoSessions() {
  const now = Date.now();
  return [
    { id: 'demo-consent', title: '检查新的发布脚本', workspace: '/example/remote-control',
      updatedAt: new Date(now - 122000).toISOString(), state: 'awaiting-permission' },
    { id: 'demo-protocol', title: '整理配对协议的回归用例', workspace: '/example/remote-control',
      updatedAt: new Date(now - 380000).toISOString(), state: 'running' },
    { id: 'demo-docs', title: '更新安装说明', workspace: '/example/field-guide',
      updatedAt: new Date(now - 3800000).toISOString(), state: 'idle' },
  ];
}

const LINK = {
  online: ['已连接到电脑', '可以发送指令并处理审批'],
  pairing: ['正在认领配对码', '请保持电脑上的配对窗口打开'],
  verifying: ['等待核对确认码', '对照两端显示的六位数字'],
  connecting: ['正在连接电脑', '将保留最近一次同步的会话'],
  'host-offline': ['电脑离线', '任务可能仍在电脑上运行'],
  offline: ['连接已断开', '恢复网络后将自动重连'],
  unpaired: ['连接你的电脑', '打开 Harness 的远程控制，扫描电脑上的小程序码。'],
};

Page({
  data: {
    theme: 'light', groups: [], projects: [], pending: [], linkState: 'unpaired',
    linkTitle: LINK.unpaired[0], linkCopy: LINK.unpaired[1], problem: '',
    paired: false, settingsOpen: false, demo: false, archivedCount: 0, lastKnown: '',
  },

  onLoad() {
    const app = getApp();
    this.app = app;
    this.client = app.client;
    this.pairUI = createPairingUI({
      pair: (token) => {
        if (!app.settings.url) {
          this.setData({ settingsOpen: true });
          throw new Error('请先填写电脑使用的中继地址');
        }
        return this.client.pair(app.settings.url, token);
      },
      accept: (id) => this.client.confirm(id),
      reject: (id) => this.client.reject(id),
      knownDead: this.client.knownDead,
      showSas: (sas) => new Promise((resolve, reject) => wx.showModal({
        title: '核对确认码',
        content: '手机计算出的数字为 ' + sas + '。请和电脑上显示的数字逐位比对。',
        confirmText: '数字一致', cancelText: '不一致',
        success: (result) => resolve(result.confirm), fail: reject,
      })),
    });
  },

  onShow() {
    this.app.applyTheme();
    this.off?.();
    this.off = this.client.subscribe(() => this.renderState());
    this.renderState();
    if (!this.data.demo) {
      const launch = this.app.entry;
      this.app.entry = undefined;
      return this.pairUI.launch(launch).catch((error) => this.app.toast(error.message));
    }
  },
  onHide() { this.off?.(); this.off = null; },
  onUnload() { this.onHide(); },

  renderState() {
    const state = this.client.snapshot();
    const demo = this.data.demo;
    const pins = this.app.storage.read('drc.v06.pins') || [];
    const view = selectSessions(demo ? demoSessions() : state.sessions, Array.isArray(pins) ? pins : []);
    const remembered = state.paired && state.recordedAt && state.state !== 'online';
    const time = remembered ? new Date(state.recordedAt).toLocaleString('zh-CN') : '';
    const link = demo ? ['演示会话', '这里的操作不会发送到电脑'] : LINK[state.state] || LINK.offline;
    this.setData({
      ...view, theme: this.app.settings.theme, relayDraft: this.data.settingsOpen ? this.data.relayDraft : this.app.settings.url,
      paired: state.paired, linkState: demo ? 'online' : state.state, linkTitle: link[0], linkCopy: link[1],
      problem: state.problem, lastKnown: time ? '最后同步于 ' + time : '',
      notifyAvailable: !!state.notify && !this.data.notificationBooked,
    });
    if (!demo && state.offer) void this.pairUI.grant(state.offer);
  },

  onScan() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (result) => this.pairUI.scan(result).catch((error) => this.app.toast(error.message)),
      fail: (error) => { if (!/cancel/i.test(error.errMsg || '')) this.app.toast('未扫到微信码，请对准电脑上的小程序码'); },
    });
  },
  onTheme() {
    this.app.setTheme(this.data.theme === 'dark' ? 'light' : 'dark');
    this.renderState();
  },
  keepSheet() {},
  onSettings() {
    this.setData({ settingsOpen: !this.data.settingsOpen, relayDraft: this.app.settings.url, settingsError: '' });
  },
  onRelayInput(event) { this.setData({ relayDraft: event.detail.value, settingsError: '' }); },
  onSaveRelay() {
    try { this.app.setRelay(this.data.relayDraft); this.onSettings(); this.app.toast('中继地址已保存'); }
    catch (error) { this.setData({ settingsError: error.message }); }
  },

  onDemo() { this.setData({ demo: !this.data.demo }); this.renderState(); },
  onReward() { wx.navigateTo({ url: '/pages/reward/index' }); },
  onUnpair() {
    wx.showModal({
      title: '解除配对？', content: '下次连接需要重新扫描电脑上的配对码。',
      confirmText: '解除配对',
      success: (result) => { if (result.confirm) void this.client.unpair().then(() => this.onSettings()); },
    });
  },
  onNotify() {
    const templateId = this.client.snapshot().notify?.templateId;
    if (!templateId) return;
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: (result) => {
        if (result[templateId] !== 'accept') return;
        wx.login({
          success: ({ code }) => {
            if (this.client.registerNotification(code)) {
              this.setData({ notificationBooked: true, notifyAvailable: false });
              this.app.toast('已预约一次提醒');
            } else this.app.toast('预约未发送，请重试');
          },
          fail: () => this.app.toast('微信登录失败，请重试'),
        });
      },
      fail: () => this.app.toast('无法预约提醒'),
    });
  },

  onShareAppMessage() { return { title: 'DSH 远程控制', path: '/pages/sessions/index' }; },
  onOpen(event) {
    const id = event.currentTarget.dataset.id;
    const view = this.data.pending.concat(this.data.groups.flatMap((group) => group.items));
    const title = view.find((row) => row.id === id)?.title || '会话';
    wx.navigateTo({ url: '/pages/chat/index?id=' + encodeURIComponent(id) + '&title='
      + encodeURIComponent(Array.from(title).slice(0, 24).join('')) + (this.data.demo ? '&demo=1' : '') });
  },
  onPullDownRefresh() {
    if (this.data.linkState !== 'online' || this.data.demo) { wx.stopPullDownRefresh(); return; }
    void this.client.command('cmd.list_sessions').catch((error) => this.app.toast(error.message)).finally(() => wx.stopPullDownRefresh());
  },

  onRowMenu(event) {
    if (this.data.demo) return;
    const { id, pinned } = event.currentTarget.dataset;
    wx.showActionSheet({
      itemList: [pinned ? '取消置顶' : '置顶', '归档'],
      success: ({ tapIndex }) => {
        if (tapIndex === 0) {
          try {
            const stored = this.app.storage.read('drc.v06.pins');
            const pins = Array.isArray(stored) ? stored.filter((item) => item !== id) : [];
            if (!pinned) pins.unshift(id);
            this.app.storage.write('drc.v06.pins', pins.slice(0, 200));
            this.renderState();
          } catch { this.app.toast('无法保存置顶，请稍后重试'); }
        } else if (this.data.linkState === 'online') {
          void this.client.command('cmd.archive_session', { sessionId: id }).then((result) => {
            if (!result.ok) this.app.toast(result.message);
          }).catch((error) => this.app.toast(error.message));
        } else this.app.toast('电脑上线后可以归档');
      },
    });
  },

  onNew() {
    if (this.data.demo || this.data.creating || this.data.linkState !== 'online') return;
    if (!this.data.projects.length) this.createSession();
    else this.pickProject(0);
  },
  pickProject(offset) {
    const page = this.data.projects.slice(offset, offset + 5);
    const more = this.data.projects.length > offset + page.length;
    wx.showActionSheet({
      itemList: page.map((project) => project.title).concat(more ? ['更多项目'] : []),
      success: ({ tapIndex }) => {
        if (more && tapIndex === page.length) this.pickProject(offset + page.length);
        else if (page[tapIndex]) this.createSession(page[tapIndex].path);
      },
    });
  },
  createSession(workspace) {
    this.setData({ creating: true });
    void this.client.command('cmd.new_session', { workspace }).then((result) => {
      if (!result.ok) throw new Error(result.message || '新建会话失败');
      wx.navigateTo({ url: '/pages/chat/index?id=' + encodeURIComponent(result.data.sessionId) });
    }).catch((error) => this.app.toast(error.message)).finally(() => this.setData({ creating: false }));
  },
});
