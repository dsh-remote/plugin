'use strict'

var client = require('./core/client.js')

App({
  globalData: {
    protocolVersion: 1,
  },

  onLaunch: function () {
    // 整个 app 生命周期共用一个客户端：页面从这里取
    this.drc = client.getClient()
  },

  onShow: function () {
    // 从后台回来：如果已配对且 socket 断了，尝试恢复
    if (this.drc && this.drc.isPaired() && !this.drc.sock) {
      this.drc.connect()
    }
  },
})
