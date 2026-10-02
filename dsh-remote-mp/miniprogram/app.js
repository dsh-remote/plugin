'use strict'

var client = require('./core/client.js')
var theme = require('./core/theme.js')

App({
  globalData: {
    protocolVersion: 1,
  },

  onLaunch: function () {
    // 整个 app 生命周期共用一个客户端：页面从这里取
    this.drc = client.getClient()
    // 导航栏/回弹区是原生组件，不吃页面变量，得在 app 启动时就设一次。
    // 等页面 onLoad 再设的话，中途会有一条白顶栏闪过去。
    theme.applyTo(null)
  },

  onShow: function () {
    // 从后台回来：如果已配对且 socket 断了，尝试恢复
    if (this.drc && this.drc.isPaired() && !this.drc.sock) {
      this.drc.connect()
    }
  },
})
