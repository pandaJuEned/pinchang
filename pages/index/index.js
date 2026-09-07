const app = getApp()
const { CATEGORIES, catOf, avatarColor } = require('../../utils/categories')
const { levelText, levelShort } = require('../../utils/levels')
const api = require('../../utils/api')
const util = require('../../utils/util')

Page({
  data: {
    cats: [{ key: 'all', name: '全部', icon: '🔥' }].concat(CATEGORIES),
    activeCat: 'all',
    list: [],
    activeCount: 0,
    loading: true,
    joiningId: '',
    flashId: '',
    showLogin: false,
    pendingId: '',
    pendingIndex: -1,
    showLevel: false,
    showNotice: false
  },

  onLoad() {
    this.setData({ activeCat: wx.getStorageSync('cb_cat') || 'all' })
    // 首次打开弹出使用说明；确认后写入标记，后续不再提示
    if (!wx.getStorageSync('cb_notice_v1')) this.setData({ showNotice: true })
  },

  onShow() {
    this.selectTab()
    this.load()
    this.startPoll()
  },

  onHide() {
    this.stopPoll()
  },

  onUnload() {
    this.stopPoll()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  /* ---------------- 分享：仅分享结构化场次信息，固定标题/封面，不携带用户上传内容 ---------------- */
  pickShareItem() {
    const list = this.data.list
    if (!list.length) return null
    return list.find((g) => g.remaining > 0 && g.status !== 'canceled') || list[0]
  },

  shareContent() {
    const g = this.pickShareItem()
    if (!g) {
      return { title: 'Court Buddy · 球场拼场报名', path: '/pages/index/index', query: '' }
    }
    return {
      title: `球场拼场：${g.dateLabel} ${g.startTime}-${g.endTime}（剩余 ${g.remaining} 个名额）`,
      path: '/pages/detail/detail?id=' + g._id,
      query: 'id=' + g._id
    }
  },

  // 注意：不设置 imageUrl —— 避免把用户上传的图片用作分享封面
  onShareAppMessage() {
    const c = this.shareContent()
    return { title: c.title, path: c.path }
  },

  selectTab() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
  },

  startPoll() {
    this.stopPoll()
    this._timer = setInterval(() => this.load(true), 15000)
  },

  stopPoll() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  },

  chooseCat(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.activeCat) return
    this.setData({ activeCat: key })
    wx.setStorageSync('cb_cat', key)
    this.load()
  },

  load(silent) {
    if (!silent) this.setData({ loading: true })
    return api.callApi({ action: 'hall', category: this.data.activeCat === 'all' ? '' : this.data.activeCat })
      .then((res) => {
        // 已拼满（剩余名额为 0）的场次不在大厅展示：服务端已过滤，
        // 这里兜底一次，防止云函数未重新部署时旧逻辑把满员场次带回来
        const list = this.decorate(res.data || []).filter((g) => g.remaining > 0)
        // 「在拼」只统计还有剩余名额的场次，已拼满/已取消的不计入
        const activeCount = list.filter((g) => g.remaining > 0 && g.status !== 'canceled').length
        this.setData({ list, activeCount, loading: false })
      })
      .catch((err) => {
        this.setData({ loading: false })
        if (!silent) api.toastErr(err)
      })
  },

  decorate(rawList) {
    return rawList.map((g) => {
      const cat = catOf(g.category)
      const remaining = g.remaining
      const statusOpen = remaining > 0 && g.status !== 'canceled'
      const pubName = g.publisherName || '球友'
      return {
        ...g,
        cat,
        iconBg: cat.gradient,
        glow: cat.glow,
        dateLabel: util.dayLabel(g.date),
        diffText: util.daysFromToday(g.date),
        canJoin: g.canJoin,
        isJoined: !!g.isJoined,
        isOwner: !!g.isOwner,
        publisherName: pubName,
        pubColor: avatarColor(pubName),
        publisherChar: pubName.slice(0, 1),
        statusText: util.phaseText(g.phase),
        statusClass: util.phaseClass(g.phase),
        statusOpen,
        levelText: levelText(g.level),
        levelShort: levelShort(g.level)
      }
    })
  },

  handleJoin(e) {
    const { id, index } = e.currentTarget.dataset
    if (!app.isLoggedIn()) {
      this.setData({ showLogin: true, pendingId: id, pendingIndex: index })
      return
    }
    // 报名拼场前必须先填写自己的羽毛球等级
    if (!app.getUserLevel()) {
      this.setData({ showLevel: true, pendingId: id, pendingIndex: index })
      return
    }
    this.performJoin(id, index)
  },

  performJoin(id, index) {
    const item = this.data.list[index]
    if (!item || !item.canJoin) return
    if (this.data.joiningId) return

    this.setData({ joiningId: id, flashId: id })
    setTimeout(() => this.setData({ flashId: '' }), 600)

    const nickName = app.getUserNick()
    api.callApi({ action: 'join', gameId: id, nickName })
      .then(() => {
        wx.vibrateShort({ type: 'light' })
        wx.showToast({ title: '抢位成功！', icon: 'success' })
        this.setData({ joiningId: '' })
        this.load(true)
      })
      .catch((err) => {
        this.setData({ joiningId: '' })
        if (err && err.code === 418) {
          // 服务端判定未登录：弹出微信登录，登录成功后自动继续这次抢位
          this.setData({ showLogin: true, pendingId: id, pendingIndex: index })
          return
        }
        if (err && err.code === 419) {
          // 服务端要求先设置等级：弹出等级设置弹层
          this.setData({ showLevel: true, pendingId: id, pendingIndex: index })
          return
        }
        api.toastErr(err)
        // 兜底刷新，同步最新名额
        this.load(true)
      })
  },

  // 登录成功回调：继续之前被打断的报名
  handleLoginSuccess() {
    this.setData({ showLogin: false })
    const { pendingId, pendingIndex } = this.data
    if (pendingId) {
      this.setData({ pendingId: '', pendingIndex: -1 })
      this.performJoin(pendingId, pendingIndex)
    }
  },

  handleLoginCancel() {
    this.setData({ showLogin: false, pendingId: '', pendingIndex: -1 })
  },

  // 点击卡片进入拼场详情
  openDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
  },

  closeNotice() {
    wx.setStorageSync('cb_notice_v1', '1')
    this.setData({ showNotice: false })
  },

  // 等级设置确认：若有待报名场次则继续抢位
  handleLevelConfirm() {
    this.setData({ showLevel: false })
    const { pendingId, pendingIndex } = this.data
    if (pendingId) {
      this.setData({ pendingId: '', pendingIndex: -1 })
      this.performJoin(pendingId, pendingIndex)
    }
  },

  handleLevelCancel() {
    this.setData({ showLevel: false, pendingId: '', pendingIndex: -1 })
  },

  noop() {}
})
