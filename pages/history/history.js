const app = getApp()
const { catOf } = require('../../utils/categories')
const api = require('../../utils/api')
const util = require('../../utils/util')

Page({
  data: {
    seg: 'all', // all | pub | join 角色筛选
    status: 'all', // all | active | done | canceled 状态筛选
    list: [],
    filtered: [],
    stats: { total: 0, active: 0, done: 0 },
    loading: true
  },

  onShow() {
    this.selectTab()
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  selectTab() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
  },

  load() {
    return api.callApi({ action: 'mine' })
      .then((res) => {
        const data = res.data || {}
        const list = this.mergeGames(data.published || [], data.joined || [])
        this.setData({ list, loading: false })
        this.applyFilter()
      })
      .catch((err) => {
        this.setData({ loading: false })
        api.toastErr(err)
      })
  },

  // 合并「我发布的 + 我报名的」，同一场只保留一条（发起优先），按日期倒序
  mergeGames(pubList, joinList) {
    const map = {}
    pubList.forEach((g) => { map[g._id] = this.decorate(g, 'pub') })
    joinList.forEach((g) => { if (!map[g._id]) map[g._id] = this.decorate(g, 'join') })
    return Object.keys(map)
      .map((k) => map[k])
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.startTime < b.startTime ? 1 : -1))
  },

  decorate(g, role) {
    const cat = catOf(g.category)
    const remaining = g.remaining
    const filled = g.total - remaining
    const canceled = g.status === 'canceled'
    const finished = !canceled && (util.daysFromToday(g.date) < 0 || g.phase === 'ended')
    return {
      ...g,
      role,
      cat,
      iconBg: cat.gradient,
      glow: cat.glow,
      dateLabel: util.dayLabel(g.date),
      filled,
      percent: g.total ? Math.min(100, Math.round((filled * 100) / g.total)) : 0,
      statusText: util.phaseText(g.phase),
      statusClass: util.phaseClass(g.phase),
      canceled,
      finished
    }
  },

  switchSeg(e) {
    const seg = e.currentTarget.dataset.seg
    if (seg === this.data.seg) return
    this.setData({ seg })
    this.applyFilter()
  },

  switchStatus(e) {
    const status = e.currentTarget.dataset.status
    if (status === this.data.status) return
    this.setData({ status })
    this.applyFilter()
  },

  applyFilter() {
    const { seg, status, list } = this.data
    let arr = list
    if (seg === 'pub') arr = arr.filter((g) => g.role === 'pub')
    else if (seg === 'join') arr = arr.filter((g) => g.role === 'join')

    if (status === 'active') arr = arr.filter((g) => !g.canceled && !g.finished)
    else if (status === 'done') arr = arr.filter((g) => g.finished)
    else if (status === 'canceled') arr = arr.filter((g) => g.canceled)

    const active = list.filter((g) => !g.canceled && !g.finished).length
    const done = list.filter((g) => g.finished).length
    this.setData({
      filtered: arr,
      stats: { total: list.length, active, done }
    })
  },

  openDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
  },

  onShareAppMessage() {
    return { title: 'Court Buddy · 球场拼场报名', path: '/pages/index/index' }
  },

  noop() {}
})
