var drc = require('./utils/drc.js')

App({
  globalData: {
    protocolVersion: 1,
  },

  onLaunch: function () {
    // One client for the whole app lifetime: pages read getApp().drc
    this.drc = drc.getClient()
  },

  onShow: function () {
    // Coming back from the background: if we were paired, try to resume.
    if (this.drc && this.drc.isPaired() && !this.drc.sock) {
      this.drc.connect()
    }
  },
})
