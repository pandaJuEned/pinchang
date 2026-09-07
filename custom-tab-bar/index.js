// 纯文字自定义底部导航
Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/index/index', text: '大厅' },
      { pagePath: '/pages/history/history', text: '历史' },
      { pagePath: '/pages/publish/publish', text: '发场' },
      { pagePath: '/pages/mine/mine', text: '我的' }
    ]
  },

  methods: {
    switchTab(e) {
      const { index, path } = e.currentTarget.dataset
      if (index === this.data.selected) return
      wx.switchTab({ url: path })
    }
  }
})
