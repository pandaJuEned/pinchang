const app = getApp()
const { catOf, avatarColor } = require('../../utils/categories')
const { levelText, levelShort, levelColor } = require('../../utils/levels')
const api = require('../../utils/api')
const util = require('../../utils/util')
const reminder = require('../../utils/reminder')

Page({
  data: {
    nick: '',
    editing: false,
    editValue: '',
    avatarColor: '#2f6bff',
    pubList: [],
    joinList: [],
    stats: [],
    hotVenues: [],
    seg: 'pub',
    loading: true,
    swipeWidth: 150,
    openId: '',
    moveId: '',
    moveOffset: 0,
    enrollSheet: { show: false, title: '', list: [] },
    acting: '',
    loggedIn: false,
    showLogin: false,
    showLevel: false,
    avatarUrl: '',
    phone: '',
    version: app.globalData.version
  },

  onLoad() {
    // 触摸位移 px → rpx 换算系数（用于卡片左滑跟手）
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      this._px2rpx = 750 / (info.windowWidth || 375)
    } catch (e) {
      this._px2rpx = 2
    }
  },

  onShow() {
    this.selectTab()
    this.syncNick()
    this.load()
  },

  // 分享仅含结构化场次信息与固定标题，不携带用户自定义文案
  onShareAppMessage() {
    const sample = this.pickShareGame()
    if (sample) {
      return {
        title: `球场拼场：${sample.dateLabel} ${sample.startTime}-${sample.endTime}（剩余 ${sample.remaining} 个名额）`,
        path: '/pages/detail/detail?id=' + sample._id
      }
    }
    return { title: 'Court Buddy · 球场拼场报名', path: '/pages/index/index' }
  },

  // 分享用的范例场次：优先取「未取消且还没开始」的一场
  pickShareGame() {
    return this.data.pubList.find((g) => g.status !== 'canceled' && util.daysFromToday(g.date) >= 0) || null
  },

  selectTab() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 })
    }
  },

  syncNick() {
    const nick = app.getUserNick()
    const lv = app.getUserLevel()
    this.setData({
      nick,
      editValue: nick,
      avatarColor: avatarColor(nick),
      avatarChar: nick.slice(0, 1),
      avatarUrl: app.getUserAvatar(),
      phone: app.getUserPhone(),
      loggedIn: app.isLoggedIn(),
      level: lv,
      levelShort: levelShort(lv),
      levelText: levelText(lv)
    })
  },

  /* ---------------- 加载 ---------------- */
  load() {
    return api.callApi({ action: 'mine' })
      .then((res) => {
        const data = res.data || {}
        this.setData({
          pubList: this.decoratePublished(data.published || []),
          joinList: this.decorateJoined(data.joined || []),
          loading: false,
          openId: '',
          moveId: '',
          moveOffset: 0
        })
        this.computeStats()
      })
      .catch((err) => {
        this.setData({ loading: false })
        api.toastErr(err)
      })
  },

  decorateStatus(g, remaining) {
    // 统一使用云函数计算的阶段：招募中 / 正在进行 / 即将结束 / 已结束 / 已拼满 / 已取消
    if (!g.phase) return remaining > 0 ? '招募中' : '已拼满'
    return util.phaseText(g.phase)
  },

  decoratePublished(list) {
    return list.map((g) => {
      const remaining = g.remaining
      const cat = catOf(g.category)
      return {
        ...g,
        cat,
        iconBg: cat.gradient,
        glow: cat.glow,
        dateLabel: util.dayLabel(g.date),
        remaining,
        filled: g.total - remaining,
        percent: g.total ? Math.min(100, Math.round(((g.total - remaining) * 100) / g.total)) : 0,
        statusText: this.decorateStatus(g, remaining),
        statusClass: util.phaseClass(g.phase),
        canceled: g.status === 'canceled',
        finished: util.daysFromToday(g.date) < 0 || g.phase === 'ended',
        // 核销窗口：开场前 15 分钟起 ~ 场次结束时间内才可点「核销」
        canVerifyCourt: g.status !== 'canceled' && g.phase !== 'ended' &&
          reminder.checkinWindow(g.date, g.startTime, Date.now(), g.endTime).state === 'open'
      }
    })
  },

  decorateJoined(list) {
    return list.map((g) => {
      const remaining = g.remaining
      const cat = catOf(g.category)
      return {
        ...g,
        cat,
        iconBg: cat.gradient,
        glow: cat.glow,
        dateLabel: util.dayLabel(g.date),
        remaining,
        filled: g.total - remaining,
        percent: g.total ? Math.min(100, Math.round(((g.total - remaining) * 100) / g.total)) : 0,
        statusText: this.decorateStatus(g, remaining),
        statusClass: util.phaseClass(g.phase),
        canceled: g.status === 'canceled',
        finished: util.daysFromToday(g.date) < 0 || g.phase === 'ended',
        // 取消报名窗口：开场前 15 分钟内锁定名额，左滑不再露出「取消报名」按钮
        cancelLocked: reminder.cancelJoinWindow(g.date, g.startTime).state === 'locked',
        joinTime: this.formatDateTime(g.joinedAt),
        canOpenCourt: g.status !== 'canceled' && g.status !== 'ongoing' && g.phase !== 'ended',
        // 核销窗口：开场前 15 分钟起 ~ 场次结束时间内才可点「核销」
        canVerifyCourt: g.status !== 'canceled' && g.phase !== 'ended' &&
          reminder.checkinWindow(g.date, g.startTime, Date.now(), g.endTime).state === 'open'
      }
    })
  },

  formatDateTime(v) {
    if (!v) return ''
    const d = new Date(v)
    if (isNaN(d.getTime())) return ''
    return `${d.getMonth() + 1}月${d.getDate()}日 ${util.pad(d.getHours())}:${util.pad(d.getMinutes())}`
  },

  /* ---------------- 统计（发布/报名/周月/场馆热度） ---------------- */
  computeStats() {
    const pub = this.data.pubList
    const join = this.data.joinList

    const future7Pub = pub.filter((g) => g.status !== 'canceled' && util.daysFromToday(g.date) >= 0 && util.daysFromToday(g.date) <= 7).length
    const future7Join = join.filter((g) => g.status !== 'canceled' && util.daysFromToday(g.date) >= 0 && util.daysFromToday(g.date) <= 7).length
    const upcoming = pub.filter((g) => g.status !== 'canceled' && util.daysFromToday(g.date) >= 0).length +
      join.filter((g) => g.status !== 'canceled' && util.daysFromToday(g.date) >= 0).length
    const avg = pub.length
      ? Math.round(pub.reduce((s, g) => s + (g.joined || 0), 0) / pub.length * 10) / 10
      : 0

    this.setData({
      stats: [
        { key: 'pub', icon: '📣', label: '我发布的', value: pub.length },
        { key: 'join', icon: '🙋', label: '我报名的', value: join.length },
        { key: 'week', icon: '🗓️', label: '未来7天场次', value: future7Pub + future7Join },
        { key: 'hot', icon: '🔥', label: '待开场', value: upcoming }
      ],
      avgJoiner: avg
    })

    const venueMap = {}
    const push = (g) => {
      if (!g.venue) return
      venueMap[g.venue] = (venueMap[g.venue] || 0) + 1
    }
    pub.forEach(push)
    join.forEach(push)
    const hot = Object.keys(venueMap)
      .map((name) => ({ name, count: venueMap[name] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
    this.setData({ hotVenues: hot })
  },

  /* ---------------- 昵称编辑 ---------------- */
  startEdit() {
    this.setData({ editing: true, editValue: this.data.nick })
  },
  onEditInput(e) {
    this.setData({ editValue: e.detail.value })
  },
  saveNick() {
    const nick = app.setUserNick(this.data.editValue)
    if (!nick) {
      wx.showToast({ title: '昵称不能为空', icon: 'none' })
      return
    }
    this.setData({ editing: false })
    this.syncNick()
    wx.showToast({ title: '已保存', icon: 'success' })
  },
  cancelEdit() {
    this.setData({ editing: false, editValue: this.data.nick })
  },

  switchSeg(e) {
    this.setData({ seg: e.currentTarget.dataset.seg })
    this.closeSwipe()
  },

  /* ---------------- 卡片左滑（露出删除 / 取消报名按钮） ---------------- */
  closeSwipe() {
    const id = this.data.openId || this.data.moveId
    if (!id) return
    const patch = { openId: '', moveId: '', moveOffset: 0 }
    const path = this.stylePathOf(id)
    if (path) patch[path] = 'transform: translateX(0rpx);'
    this.setData(patch)
  },

  // 定位某张卡片在列表数据中的样式字段路径
  stylePathOf(id) {
    const pi = this.data.pubList.findIndex((g) => g._id === id)
    if (pi > -1) return 'pubList[' + pi + '].swipeStyle'
    const ji = this.data.joinList.findIndex((g) => g._id === id)
    if (ji > -1) return 'joinList[' + ji + '].swipeStyle'
    return ''
  },

  onCardTouchStart(e) {
    this._swipe = null
    if (!e.currentTarget.dataset.swipeable) return
    const t = e.touches[0]
    this._swipe = {
      id: e.currentTarget.dataset.id,
      x: t.clientX,
      y: t.clientY,
      opened: this.data.openId === e.currentTarget.dataset.id,
      moved: false,
      locked: false
    }
  },

  onCardTouchMove(e) {
    const s = this._swipe
    if (!s || s.id !== e.currentTarget.dataset.id || s.locked) return
    const t = e.touches[0]
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (!s.moved) {
      // 方向锁定：纵向位移让位给页面滚动，只有横向才进入左滑
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      if (Math.abs(dy) > Math.abs(dx)) { s.locked = true; return }
      s.moved = true
    }
    const sw = this.data.swipeWidth
    const offset = Math.max(-sw, Math.min(0, (s.opened ? -sw : 0) + dx * (this._px2rpx || 2)))
    const rounded = Math.round(offset)
    if (this.data.moveId !== s.id || this.data.moveOffset !== rounded) {
      const patch = { moveId: s.id, moveOffset: rounded }
      const path = this.stylePathOf(s.id)
      if (path) patch[path] = 'transform: translateX(' + rounded + 'rpx);'
      this.setData(patch)
    }
  },

  onCardTouchEnd() {
    const s = this._swipe
    this._swipe = null
    if (!s || !s.moved) return
    const sw = this.data.swipeWidth
    const offset = this.data.moveId === s.id ? this.data.moveOffset : (s.opened ? -sw : 0)
    // 滑过一半吸附展开，否则弹回；同时收起其它卡片
    const open = offset <= -sw / 2
    const prevOpen = this.data.openId
    const patch = { moveId: '', moveOffset: 0, openId: open ? s.id : '' }
    const ids = prevOpen && prevOpen !== s.id ? [s.id, prevOpen] : [s.id]
    ids.forEach((id) => {
      const x = id === s.id && open ? -sw : 0
      const path = this.stylePathOf(id)
      if (path) patch[path] = 'transform: translateX(' + x + 'rpx);'
    })
    this.setData(patch)
    this._swipeTs = Date.now() // 拖拽刚结束时忽略随之而来的 tap
  },

  // 卡片点击：有卡片处于左滑态时先收起，不进详情
  onCardTap(e) {
    if (Date.now() - (this._swipeTs || 0) < 350) return
    if (this.data.openId) {
      this.closeSwipe()
      return
    }
    this.openDetail(e)
  },

  /* ---------------- 操作 ---------------- */
  viewEnrolls(e) {
    const { id, index } = e.currentTarget.dataset
    const item = this.data.pubList[index]
    if (!item) return
    api.callApi({ action: 'enrolls', gameId: id })
      .then((res) => {
        const list = (res.data || []).map((u, i) => {
          const name = u.nickName || '球友'
          return {
            name,
            char: name.slice(0, 1),
            color: avatarColor(name),
            date: this.formatDateTime(u.createdAt),
            no: i + 1,
            levelShort: levelShort(u.level),
            levelColor: levelColor(u.level),
            avatar: u.avatar || '',
            openid: u.openid || '',
            verified: !!u.verified
          }
        })
        this.setData({ enrollSheet: { show: true, title: `报名名单 · ${list.length} 人`, gameId: id, list } })
      })
      .catch((err) => api.toastErr(err))
  },

  closeSheet() {
    this.setData({ 'enrollSheet.show': false })
  },
  noop() {},

  /* ---------------- 开启球场（报名的球友也可操作，状态→进行中） ---------------- */
  openCourt(e) {
    const { id, index } = e.currentTarget.dataset
    const item = this.data.joinList[index]
    if (!item || this.data.acting) return
    let content = '确认开启球场？开启后本场状态将变为「进行中」。'
    if (!item.verified) {
      content = '场地还未核销，确认开启球场吗？\n（开启后状态变为「进行中」，可稍后在详情里补核销）'
    }
    wx.showModal({
      title: '开启球场',
      content,
      confirmText: '开启',
      confirmColor: '#06a86b',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ acting: 'court-' + id })
        api.callApi({ action: 'openCourt', gameId: id })
          .then((res) => {
            const p = 'joinList[' + index + ']'
            this.setData({
              [p + '.status']: 'ongoing',
              [p + '.phase']: 'ongoing',
              [p + '.statusText']: '正在进行',
              [p + '.statusClass']: 'ongoing',
              [p + '.canOpenCourt']: false
            })
            wx.showToast({ title: '球场已开启', icon: 'success' })
            // 有人没收到的推送（未订阅/模板错误）Toast 出来，便于定位
            setTimeout(() => api.toastPushResult(res), 900)
          })
          .catch((err) => api.toastErr(err))
          .finally(() => this.setData({ acting: '' }))
      }
    })
  },

  /* ---------------- 核销场地（任一参与者可操作，整场只核一次 + 备注） ---------------- */
  verifyCourt(e) {
    const { list, index, id } = e.currentTarget.dataset
    const arr = this.data[list]
    const item = arr && arr[index]
    if (!item || this.data.acting) return
    // 已核销：仅展示备注
    if (item.verified) {
      if (item.verifyRemark) {
        wx.showModal({ title: '场地核销备注', content: item.verifyRemark, showCancel: false, confirmText: '知道了' })
      } else {
        wx.showToast({ title: '场地已核销', icon: 'none' })
      }
      return
    }
    // 核销时间窗：开场前 15 分钟起 ~ 场次结束时间可核销（与详情页/云函数校验一致）
    const win = reminder.checkinWindow(item.date, item.startTime, Date.now(), item.endTime)
    if (win.state === 'early') {
      wx.showToast({ title: `开场前 ${reminder.CHECKIN_BEFORE_MIN} 分钟起可核销场地`, icon: 'none' })
      return
    }
    if (win.state === 'expired') {
      wx.showToast({ title: '本场时间已结束，无法核销', icon: 'none' })
      return
    }
    wx.showModal({
      title: '确认核销场地？',
      content: '核销的是本场场地，整场只需核销一次，核销后不可撤销，仅可补充备注。',
      editable: true,
      placeholderText: '核销备注（选填，如到场情况）',
      success: (res) => {
        if (!res.confirm) return
        const remark = (res.content || '').trim().slice(0, 60)
        this.setData({ acting: 'verify-' + id })
        api.callApi({ action: 'setVerify', gameId: id, verify: true, remark })
          .then(() => {
            const p = list + '[' + index + ']'
            this.setData({ [p + '.verified']: true, [p + '.verifyRemark']: remark })
            wx.showToast({ title: '场地已核销', icon: 'none' })
          })
          .catch((err) => api.toastErr(err))
          .finally(() => this.setData({ acting: '' }))
      }
    })
  },

  cancelJoin(e) {
    const { id, index } = e.currentTarget.dataset
    const item = this.data.joinList[index]
    if (!item || item.finished || item.canceled) return
    if (this.data.acting) return
    // 开场前 15 分钟内锁定名额，不可再取消（以实时计算为准，防止列表数据过期）
    const cw = reminder.cancelJoinWindow(item.date, item.startTime)
    if (cw.state === 'locked') {
      this.closeSwipe()
      wx.showToast({ title: `开场前 ${reminder.CANCEL_JOIN_BEFORE_MIN} 分钟内不可取消报名`, icon: 'none' })
      return
    }
    this.closeSwipe()
    wx.showModal({
      title: '取消报名',
      content: `确定取消「${item.venue}」${item.dateLabel} ${item.startTime} 的报名吗？名额会立刻释放。`,
      confirmColor: '#ff4d5a',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ acting: 'cancel-' + id })
        api.callApi({ action: 'cancelJoin', gameId: id, enrollId: item.enrollId })
          .then(() => {
            wx.showToast({ title: '已取消报名', icon: 'success' })
            this.load()
          })
          .catch((err) => api.toastErr(err))
          .finally(() => this.setData({ acting: '' }))
      }
    })
  },

  cancelGame(e) {
    const { id, index } = e.currentTarget.dataset
    const item = this.data.pubList[index]
    if (!item || item.canceled || item.finished) return
    if (this.data.acting) return
    wx.showModal({
      title: '取消拼场',
      content: `确定取消「${item.venue}」这场拼场吗？已报名的 ${item.joined || 0} 位球友将看到场次已取消。`,
      confirmColor: '#ff4d5a',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ acting: 'game-' + id })
        api.callApi({ action: 'cancelGame', gameId: id })
          .then(() => {
            wx.showToast({ title: '已取消', icon: 'success' })
            this.load()
          })
          .catch((err) => api.toastErr(err))
          .finally(() => this.setData({ acting: '' }))
      }
    })
  },

  /* ---------------- 微信登录（入口与回调） ---------------- */
  loginFromMine() {
    if (this.data.acting) return
    this.setData({ showLogin: true })
  },

  handleLoginSuccess() {
    this.setData({ showLogin: false, loggedIn: true })
    this.syncNick()
    this.load()
    wx.showToast({ title: '微信登录成功', icon: 'success' })
  },

  handleLoginCancel() {
    this.setData({ showLogin: false })
  },

  /* ---------------- 羽毛球等级 ---------------- */
  openLevel() {
    this.setData({ showLevel: true })
  },

  handleLevelConfirm() {
    this.setData({ showLevel: false })
    this.syncNick()
    wx.showToast({ title: '等级已更新', icon: 'success' })
  },

  handleLevelCancel() {
    this.setData({ showLevel: false })
  },

  /* ---------------- 列表卡片进入详情 / 编辑 / 删除 ---------------- */
  openDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
  },

  // 编辑我发布的拼场：发布页是 tab，用存储传递待编辑 id 后切换过去
  onEditGame(e) {
    const id = e.currentTarget.dataset.id
    if (!id || this.data.acting) return
    wx.setStorageSync('cb_edit_game', id)
    wx.switchTab({ url: '/pages/publish/publish' })
  },

  // 删除我发布的拼场（连同报名记录），左滑后点删除 → 二次确认
  onDeleteGame(e) {
    const { id, index } = e.currentTarget.dataset
    const item = this.data.pubList[index]
    if (!item || this.data.acting) return
    this.closeSwipe()
    wx.showModal({
      title: '删除拼场',
      content: `确定删除「${item.venue}」这场拼场吗？已报名的球友将看到场次已删除，且无法恢复。`,
      confirmColor: '#ff4d5a',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ acting: 'game-' + id })
        api.callApi({ action: 'deleteGame', gameId: id })
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'success' })
            this.load()
          })
          .catch((err) => api.toastErr(err))
          .finally(() => this.setData({ acting: '' }))
      }
    })
  }
})
