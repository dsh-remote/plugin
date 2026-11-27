'use strict';
Page({
  data: { theme: 'light' },
  onShow() {
    const app = getApp();
    app.applyTheme();
    this.setData({ theme: app.settings.theme });
  },
  onBack() { wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/sessions/index' }) }); },
});
