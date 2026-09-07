const app = getApp()
const { catOf, avatarColor } = require('../../utils/categories')
const { levelText, levelShort, levelColor } = require('../../utils/levels')
const api = require('../../utils/api')
const util = require('../../utils/util')
const reminder = require('../../utils/reminder')

Page({
  data: {
    id: '',
    loading: true,
    game: null,
    loadError: '',
    openid: '',
    isOwner: false,
    isJoined: false,
    occupied: 0,
    verified: false,
    verifyRemark: '',
    // 「开启球场 + 登记核销」状态：hidden / done / early / todo / expired / waiting
    courtState: 'waiting',
    courtTag: '待开启',
    courtTip: '',
    courtCount: '',
    courtBtn: '',
    // 取消报名窗口：open 可取消 / locked 开场前 15 分钟内已锁定
    cancelState: 'open',
    cancelTip: '',
    enrolls: [],
    players: [],
    playersTop: [],
    playersMore: 0,
    acting: '',
    joinLoading: false,
    adjusting: false,
    showLogin: false,
    showLevel: false,
    showSheet: false,
    soloMode: false,
    poster: { show: false, path: '' },
    posterLoading: false,
    // 开场提醒
    reminderList: [],
    reminderEnabled: !!reminder.subscribeTemplateId,
    subscribed: false,
    subscribing: false,
    // 设置提醒弹层（参与者可自定义自己的提醒时间）
    remindSheet: false,
    // 发起人预设转成数组，勾选状态直接存在每条 item 的 on 标志上，避免 WXML 里用 indexOf 判断
    reminderPresetList: Object.keys(reminder.reminderPresets).map((k) => ({
      key: k,
      label: reminder.reminderPresets[k].label,
      on: false
    })),
    remindCustom: [],
    customMin: '',
    subscribedCount: 0
  },

  onLoad(options) {
    this.setData({ id: String((options && options.id) || '') })
    // 朋友圈分享点开是「单页模式」（scene 1154），顶部提示前往小程序才能报名
    try {
      const lo = wx.getLaunchOptionsSync()
      if (lo && Number(lo.scene) === 1154) this.setData({ soloMode: true })
    } catch (e) { /* 忽略 */ }
  },

  onShow() {
    this.load()
    this.startCourtTicker()
  },

  onHide() {
    this.stopCourtTicker()
  },

  onUnload() {
    this.stopCourtTicker()
  },

  // 每秒刷新「开启球场 + 核销」状态与倒计时（仅在页面可见时跑）
  startCourtTicker() {
    this.stopCourtTicker()
    if (this.data.game) this.refreshCourtState()
    this._courtTimer = setInterval(() => {
      if (this.data.game) this.refreshCourtState()
    }, 1000)
  },

  stopCourtTicker() {
    if (this._courtTimer) {
      clearInterval(this._courtTimer)
      this._courtTimer = null
    }
  },

  load() {
    if (!this.data.id) {
      wx.showToast({ title: '拼场信息缺失', icon: 'none' })
      return Promise.resolve()
    }
    if (!this.data.game) this.setData({ loading: true })
    return api.callApi({ action: 'detail', gameId: this.data.id })
      .then((res) => {
        const d = res.data || {}
        const g = d.game || null
        if (!g) {
          this.setData({ loading: false, game: null, loadError: '拼场不存在或已被删除' })
          return
        }
        const cat = catOf(g.category)
        const occupied = d.occupied != null ? d.occupied : (g.reserve + g.joined)
        const canceled = g.status === 'canceled'
        const myOpenid = d.openid || ''
        const toPlayer = (name, level, tag, avatar, openid) => {
          const n = name || '球友'
          return {
            name: n,
            char: n.slice(0, 1),
            color: avatarColor(n),
            level: Number(level) || 0,
            levelShort: levelShort(level),
            levelColor: levelColor(level),
            tag: tag || '',
            avatar: avatar || '',
            openid: openid || ''
          }
        }
        // 参与者 = 发起人（自留名额）+ 已报名球友，所有人可见；level 为报名时的等级快照
        const pub = d.publisher || {}
        const players = [toPlayer(pub.nickName || g.publisherName, pub.level, '发起人', pub.avatar, pub.openid || g.openid)]
          .concat((d.enrolls || []).map((u) => toPlayer(u.nickName, u.level, '', u.avatar, u.openid)))
        const isParticipant = !!d.isOwner || !!d.isJoined
        players.forEach((p, i) => { p.no = i + 1 })
        const enrolls = players.slice(1)
        this.setData({
          loading: false,
          game: {
            ...g,
            cat,
            iconBg: cat.gradient,
            glow: cat.glow,
            canceled,
            dateLabel: util.dayLabel(g.date),
            diffText: util.daysFromToday(g.date),
            statusText: util.phaseText(g.phase),
            statusClass: util.phaseClass(g.phase),
            pubColor: avatarColor(g.publisherName),
            pubChar: (g.publisherName || '球').slice(0, 1),
            pubAvatar: pub.avatar || '',
            levelText: levelText(g.level),
            levelShort: levelShort(g.level)
          },
          openid: myOpenid,
          isOwner: !!d.isOwner,
          isJoined: !!d.isJoined,
          occupied,
          verified: !!d.verified,
          verifyRemark: d.verifyRemark || '',
          enrolls,
          players,
          playersTop: players.slice(0, 8),
          playersMore: Math.max(0, players.length - 8),
          reminderList: Array.isArray(g.reminders) ? g.reminders : [],
          subscribed: !!d.isOwner,
          subscribedCount: d.isOwner ? (Array.isArray(g.reminders) ? g.reminders.length : 0) : 0
        }, () => this.refreshCourtState())
      })
      .catch((err) => {
        // 展示真实失败原因（如云函数未部署新版时的「未知操作」），而不是误报「拼场不存在」
        this.setData({
          loading: false,
          game: null,
          loadError: (err && (err.message || err.msg)) || '加载失败，请稍后重试'
        })
        api.toastErr(err)
      })
  },

  goHall() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/index/index' })
    })
  },

  /* ---------------- 报名 / 取消报名 ---------------- */
  onJoin() {
    if (this.data.joinLoading) return
    if (!app.isLoggedIn()) {
      this.setData({ showLogin: true })
      return
    }
    // 报名前必须先填写自己的羽毛球等级
    if (!app.getUserLevel()) {
      this.setData({ showLevel: true })
      return
    }
    // 报名成功会推送服务通知：需在点击手势内同步请求订阅授权（未配置模板则跳过）。
    // 这里一次性授权「报名结果 + 即将开始 + 开始」3 个模板，否则报名者后续收不到
    // 开场提醒与「开启球场」推送（43101 用户未订阅）。
    const wantPush = !!reminder.notifyTmplId()
    if (wantPush) reminder.requestAllSubscribe()
    this.setData({ joinLoading: true })
    api.callApi({ action: 'join', gameId: this.data.id, nickName: app.getUserNick() })
      .then(() => {
        wx.vibrateShort({ type: 'light' })
        wx.showToast({ title: '抢位成功！', icon: 'success' })
        if (wantPush) {
          const g = this.data.game || {}
          api.callApi({
            action: 'notify',
            title: '报名成功',
            scene: g.venue || '羽毛球拼场',
            time: [g.date, g.startTime].filter(Boolean).join(' '),
            gameId: this.data.id
          }).then((r) => api.toastPushResult(r)).catch(() => {})
        }
        this.load()
      })
      .catch((err) => {
        if (err && err.code === 418) {
          this.setData({ showLogin: true })
          return
        }
        if (err && err.code === 419) {
          this.setData({ showLevel: true })
          return
        }
        api.toastErr(err)
      })
      .finally(() => this.setData({ joinLoading: false }))
  },

  // 等级设置确认：设置后自动重试报名
  handleLevelConfirm() {
    this.setData({ showLevel: false })
    if (app.isLoggedIn() && app.getUserLevel()) {
      this.onJoin()
    }
  },

  handleLevelCancel() {
    this.setData({ showLevel: false })
  },

  // 发起人编辑拼场：发布页是 tab，用存储传递待编辑 id 后切换过去
  onEdit() {
    if (this.data.acting) return
    wx.setStorageSync('cb_edit_game', this.data.id)
    wx.switchTab({ url: '/pages/publish/publish' })
  },

  // 发起人删除拼场（连同报名记录）
  onDeleteGame() {
    const g = this.data.game
    if (!g || this.data.acting) return
    wx.showModal({
      title: '删除拼场',
      content: `确定删除「${g.venue}」这场拼场吗？已报名的 ${g.joined || 0} 位球友将看到场次已删除，且无法恢复。`,
      confirmColor: '#ff4d5a',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ acting: 'deleteGame' })
        api.callApi({ action: 'deleteGame', gameId: this.data.id })
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'success' })
            setTimeout(() => this.goHall(), 600)
          })
          .catch((err) => api.toastErr(err))
          .finally(() => this.setData({ acting: '' }))
      }
    })
  },

  handleLoginSuccess() {
    this.setData({ showLogin: false })
    this.onJoin()
  },

  /* ---------------- 订阅开场提醒（参与者可自定义自己的提醒时间） ---------------- */
  // 打开设置弹层：默认勾选发起人的预设；若发起人没设提醒，则从空白开始，由参与者自定义
  openRemindSheet() {
    const g = this.data.game
    if (!g || this.data.subscribing) return
    if (!this.data.reminderEnabled) {
      wx.showToast({ title: '未配置订阅消息模板', icon: 'none' })
      return
    }
    if (!app.isLoggedIn()) {
      this.setData({ showLogin: true })
      return
    }
    const presets = reminder.reminderPresets
    const existing = Array.isArray(g.reminders) ? g.reminders : []
    const pickSet = new Set(
      existing.map((r) => r.key).filter((k) => presets[k])
    )
    const custom = existing
      .map((r) => r.key)
      .filter((k) => k && k.indexOf('c_') === 0)
      .map((k) => Number(k.slice(2)))
      .filter((n) => Number.isFinite(n) && n > 0)
    this.setData({
      remindSheet: true,
      reminderPresetList: this.data.reminderPresetList.map((r) => ({ ...r, on: pickSet.has(r.key) })),
      remindCustom: custom,
      customMin: ''
    })
  },

  closeRemindSheet() {
    this.setData({ remindSheet: false })
  },

  // 勾选 / 取消勾选某条发起人预设提醒（直接翻转该项 on 标志）
  toggleRemindKey(e) {
    const idx = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.data.reminderPresetList.length) return
    this.setData({ [`reminderPresetList[${idx}].on`]: !this.data.reminderPresetList[idx].on })
  },

  onCustomMin(e) {
    this.setData({ customMin: e.detail.value })
  },

  // 添加一条「自定义提前分钟」提醒
  addCustomRemind() {
    const min = Math.floor(Number(this.data.customMin))
    if (!Number.isFinite(min) || min <= 0) {
      wx.showToast({ title: '请输入大于 0 的分钟数', icon: 'none' })
      return
    }
    if (min > 60 * 24 * 30) {
      wx.showToast({ title: '提前时间不能超过 30 天', icon: 'none' })
      return
    }
    const list = this.data.remindCustom.slice()
    if (list.indexOf(min) === -1) list.push(min)
    this.setData({ remindCustom: list, customMin: '' })
  },

  // 移除一条自定义提醒
  removeCustomRemind(e) {
    const min = Number(e.currentTarget.dataset.min)
    this.setData({ remindCustom: this.data.remindCustom.filter((m) => m !== min) })
  },

  // 确认订阅：合并预设 + 自定义，过滤掉已过去的时刻，请求授权并写入提醒
  confirmRemind() {
    const g = this.data.game
    if (!g || this.data.subscribing) return
    let all = []
    try {
      const pickKeys = this.data.reminderPresetList.filter((r) => r.on).map((r) => r.key)
      const presets = reminder.buildReminders(pickKeys, g.date, g.startTime)
      const custom = (Array.isArray(this.data.remindCustom) ? this.data.remindCustom : [])
        .map((min) => reminder.buildCustomReminder(min, g.date, g.startTime))
        .filter((r) => r)
      all = presets.concat(custom)
      // 丢弃已经过去的推送时刻（避免订阅后立刻被定时任务推送一条过期提醒）
      const now = Date.now()
      all = all.filter((r) => r && r.sendAt > now + 60000)
    } catch (e) {
      console.error('[detail] 计算提醒失败', e)
    }
    if (!all.length) {
      wx.showToast({ title: '没有可设置的提醒（都已过期）', icon: 'none' })
      return
    }
    this.setData({ subscribing: true, remindSheet: false })
    // 先请求订阅消息授权（授权后到点才会收到推送）；授权失败/拒绝也继续保存，只是不会推送
    let granted = false
    let tip = ''
    Promise.resolve(reminder.requestSubscribe())
      .then((state) => {
        granted = state === 'accept'
        tip = reminder.subscribeTip(state)
        return api.callApi({
          action: 'subscribeReminder',
          gameId: this.data.id,
          reminders: all
        })
      })
      .then(() => {
        this.setData({
          subscribed: true,
          subscribedCount: all.length,
          reminderList: all
        })
        if (granted) {
          wx.showToast({ title: '已设置提醒 🔔', icon: 'success' })
        } else {
          wx.showToast({ title: tip || '未授权消息推送，将收不到提醒', icon: 'none' })
        }
      })
      .catch((err) => {
        console.error('[detail] 订阅提醒失败', err)
        api.toastErr(err)
      })
      .finally(() => this.setData({ subscribing: false }))
  },

  handleLoginCancel() {
    this.setData({ showLogin: false })
  },

  onCancelJoin() {
    const g = this.data.game
    if (!g) return
    // 开场前 15 分钟内锁定名额（以实时计算为准，防止页面数据过期）
    const cw = reminder.cancelJoinWindow(g.date, g.startTime)
    if (cw.state === 'locked' || this.data.cancelState !== 'open') {
      wx.showToast({ title: `开场前 ${reminder.CANCEL_JOIN_BEFORE_MIN} 分钟内不可取消报名`, icon: 'none' })
      return
    }
    wx.showModal({
      title: '取消报名',
      content: `确定取消「${g.venue}」的报名吗？名额会立刻释放。开场前 ${reminder.CANCEL_JOIN_BEFORE_MIN} 分钟内不可取消。`,
      confirmColor: '#ff4d5a',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ acting: 'cancelJoin' })
        api.callApi({ action: 'cancelJoin', gameId: this.data.id })
          .then(() => {
            wx.showToast({ title: '已取消报名', icon: 'success' })
            this.load()
          })
          .catch((err) => api.toastErr(err))
          .finally(() => this.setData({ acting: '' }))
      }
    })
  },

  /* ---------------- 发起人：调整总人数 ---------------- */
  changeTotal(e) {
    const delta = Number(e.currentTarget.dataset.delta)
    const g = this.data.game
    if (!g || this.data.adjusting) return
    const next = g.total + delta
    if (next < 2 || next > 99) return
    // 总人数不能低于已占用人数（自留 + 已报名）
    if (next < this.data.occupied) {
      wx.showToast({ title: `不能低于已占用 ${this.data.occupied} 人`, icon: 'none' })
      return
    }
    this.setData({ adjusting: true })
    api.callApi({ action: 'adjustTotal', gameId: this.data.id, total: next })
      .then(() => {
        wx.vibrateShort({ type: 'light' })
        wx.showToast({ title: `总人数已改为 ${next} 人`, icon: 'none' })
        this.load()
      })
      .catch((err) => api.toastErr(err))
      .finally(() => this.setData({ adjusting: false }))
  },

  /* ---------------- 发起人：取消拼场 ---------------- */
  onCancelGame() {
    const g = this.data.game
    if (!g) return
    wx.showModal({
      title: '取消拼场',
      content: `确定取消这场拼场吗？已报名的 ${g.joined || 0} 位球友将看到场次已取消。`,
      confirmColor: '#ff4d5a',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ acting: 'cancelGame' })
        api.callApi({ action: 'cancelGame', gameId: this.data.id })
          .then(() => {
            wx.showToast({ title: '已取消', icon: 'success' })
            this.load()
          })
          .catch((err) => api.toastErr(err))
          .finally(() => this.setData({ acting: '' }))
      }
    })
  },

  /* ---------------- 报名名单 ---------------- */
  // 报名名单：所有人可见（发起人可看到完整名单，球友可看到同场球友与等级）
  openSheet() {
    this.setData({ showSheet: true })
  },

  closeSheet() {
    this.setData({ showSheet: false })
  },

  noop() {},

  /* ---------------- 「开启球场 + 登记核销」：合并为一个操作 ---------------- */
  // 计算当前可用状态、文案与倒计时，每秒调用一次（页面可见时）
  refreshCourtState() {
    const g = this.data.game
    if (!g) return
    const now = Date.now()
    // 到点自动结束（前端兜底）：结束时间一过立刻按「已结束」展示，不等下一次 load
    // （服务端由 remindTick 每分钟把 status 置为 ended，这里保证页面上无感实时切换）
    const endAt = reminder.startTs(g.date, g.endTime)
    const autoEnded = !g.canceled && g.status !== 'canceled' && !!endAt && now >= endAt
    if (autoEnded && g.phase !== 'ended') {
      this.setData({
        'game.phase': 'ended',
        'game.statusText': '已结束',
        'game.statusClass': 'ended'
      })
    }
    const isParticipant = !!(this.data.isOwner || this.data.isJoined)
    const win = reminder.checkinWindow(g.date, g.startTime, now)
    let state = 'waiting'
    let tag = '待开启'
    let tip = ''
    let count = ''
    let btn = ''

    if (g.canceled) {
      state = 'hidden'
    } else if (g.phase === 'ended' || autoEnded) {
      state = 'done'
      tag = g.verified ? '已核销' : '未核销'
      tip = '本场已结束'
    } else if (g.status === 'ongoing') {
      state = 'done'
      tag = g.verified ? '已核销' : '未核销'
      tip = g.verified ? '球场已开启，场地已核销' : '球场已开启'
    } else if (win.state === 'early') {
      state = 'early'
      tip = `开场前 ${reminder.CHECKIN_BEFORE_MIN} 分钟起可开启球场并登记核销`
      count = `${reminder.fmtDuration(win.openAt - now)}后可操作`
    } else if (win.state === 'open') {
      state = isParticipant ? 'todo' : 'waiting'
      tip = isParticipant ? '到场后点右侧按钮，开启球场并登记核销' : '等待参与者开启球场'
      count = isParticipant ? `${reminder.fmtDuration(win.expireAt - now)}后核销失效` : ''
    } else {
      state = isParticipant ? 'expired' : 'waiting'
      tip = isParticipant ? `核销已失效（开场 ${reminder.CHECKIN_AFTER_MIN} 分钟后不可核销），仍可开启球场` : '等待参与者开启球场'
    }

    // 取消报名窗口：开场前 CANCEL_JOIN_BEFORE_MIN 分钟起锁定名额（每秒随倒计时刷新）
    const cw = reminder.cancelJoinWindow(g.date, g.startTime, now)
    const cancelTip = cw.state === 'locked'
      ? `🔒 开场前 ${reminder.CANCEL_JOIN_BEFORE_MIN} 分钟内不可取消报名，名额已锁定`
      : `⏳ 开场前可取消报名让出名额，还可取消 ${reminder.fmtDuration(cw.leftMs)}`

    this.setData({ courtState: state, courtTag: tag, courtTip: tip, courtCount: count, courtBtn: btn, cancelState: cw.state, cancelTip })
    // 按钮文案单独处理（避免每次 setData 都被覆盖）
    if (state === 'todo') {
      if (!this.data.courtBtn) this.setData({ courtBtn: '🏟️ 开启并核销' })
    } else if (state === 'expired') {
      if (this.data.courtBtn !== '🏟️ 仅开启球场') this.setData({ courtBtn: '🏟️ 仅开启球场' })
    } else if (this.data.courtBtn) {
      this.setData({ courtBtn: '' })
    }
  },

  // 点击「开启球场并登记核销」：合并操作，可填备注
  openCourt() {
    const g = this.data.game
    if (!g || this.data.acting) return
    const st = this.data.courtState
    if (st !== 'todo' && st !== 'expired') return
    const onlyOpen = st === 'expired'
    wx.showModal({
      title: onlyOpen ? '开启球场' : '开启球场并登记核销',
      content: onlyOpen
        ? '核销已超过开场 10 分钟，本次只开启球场，不再登记核销。'
        : '确认开启球场并登记核销？\n开启后状态变为「进行中」，场地核销整场只登记一次，不可撤销。',
      editable: true,
      placeholderText: '核销备注（选填，如到场情况）',
      confirmText: '开启',
      confirmColor: '#06a86b',
      success: (res) => {
        if (!res.confirm) return
        const remark = (res.content || '').trim().slice(0, 60)
        this.setData({ acting: 'openCourt' })
        api.callApi({ action: 'openCourt', gameId: this.data.id, remark })
          .then((r) => {
            const d = r.data || {}
            this.setData({
              'game.status': 'ongoing',
              'game.phase': 'ongoing',
              'game.statusText': '正在进行',
              'game.statusClass': 'ongoing',
              'game.verified': !!d.verified,
              verified: !!d.verified,
              verifyRemark: d.verified ? remark : this.data.verifyRemark
            })
            this.refreshCourtState()
            wx.showToast({ title: d.verified ? '球场已开启并核销' : '球场已开启', icon: 'success' })
            // 有人没收到的推送（未订阅/模板错误）Toast 出来，便于定位
            setTimeout(() => api.toastPushResult(r), 900)
          })
          .catch((err) => api.toastErr(err))
          .finally(() => this.setData({ acting: '' }))
      }
    })
  },

  // 已核销：点击展示备注
  showVerifyInfo() {
    if (this.data.verified && this.data.verifyRemark) {
      wx.showModal({ title: '场地核销备注', content: this.data.verifyRemark, showCancel: false, confirmText: '知道了' })
    } else if (this.data.verified) {
      wx.showToast({ title: '场地已核销', icon: 'none' })
    }
  },

  /* ---------------- 分享：仅分享结构化场次信息，固定标题、不携带用户上传图片 ---------------- */
  shareContent() {
    const g = this.data.game
    if (!g) {
      return { title: 'Court Buddy · 球场拼场报名', path: '/pages/index/index', query: '' }
    }
    return {
      title: `球场拼场：${g.dateLabel} ${g.startTime}-${g.endTime}（剩余 ${g.remaining} 个名额）`,
      path: '/pages/detail/detail?id=' + this.data.id,
      query: 'id=' + this.data.id
    }
  },

  // 注意：不设置 imageUrl —— 避免把用户上传的预约截图用作分享封面
  onShareAppMessage() {
    const c = this.shareContent()
    return { title: c.title, path: c.path }
  },

  /* ---------------- 拼场海报（含小程序码） ---------------- */
  openPoster() {
    if (this.data.posterLoading) return
    // 已生成过直接复用，不重复绘制
    if (this.data.poster.path) {
      this.setData({ 'poster.show': true })
      return
    }
    this.buildPoster()
  },

  closePoster() {
    this.setData({ 'poster.show': false })
  },

  buildPoster() {
    const g = this.data.game
    if (!g) return
    this.setData({ posterLoading: true })
    wx.showLoading({ title: '生成海报中…', mask: true })
    // 小程序码生成失败（如小程序未发布）时降级为无码海报，不阻断流程
    this.fetchQrcode(g._id)
      .catch(() => '')
      // 注意：海报文案固定、不使用用户上传的预约截图作为封面
      .then((qrFileID) => this.downloadFile(qrFileID).then((qr) => this.drawPoster(g, '', qr)))
      .then((path) => {
        this.setData({ poster: { show: true, path }, posterLoading: false })
        wx.hideLoading()
      })
      .catch(() => {
        this.setData({ posterLoading: false })
        wx.hideLoading()
        wx.showToast({ title: '海报生成失败，请重试', icon: 'none' })
      })
  },

  // 云函数生成小程序码，返回云存储 fileID
  fetchQrcode(gameId) {
    return api.callApi({ action: 'gameQrcode', gameId }).then((res) => (res.data || {}).fileID || '')
  },

  // 云文件 → 本地临时路径（canvas 只能绘制本地图片）
  downloadFile(fileID) {
    return new Promise((resolve) => {
      if (!fileID || !wx.cloud || !wx.cloud.downloadFile) return resolve('')
      wx.cloud.downloadFile({ fileID })
        .then((res) => resolve(res.tempFilePath || ''))
        .catch(() => resolve(''))
    })
  },

  dpr() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      return info.pixelRatio || 2
    } catch (e) {
      return 2
    }
  },

  drawPoster(g, coverPath, qrPath) {
    return new Promise((resolve, reject) => {
      const query = wx.createSelectorQuery().in(this)
      query.select('#posterCanvas').fields({ node: true, size: true }).exec((res) => {
        const info = res && res[0]
        if (!info || !info.node) {
          reject(new Error('canvas 未就绪'))
          return
        }
        const canvas = info.node
        const ctx = canvas.getContext('2d')
        const ratio = this.dpr()
        const W = 640
        const H = 900
        canvas.width = Math.round(W * ratio)
        canvas.height = Math.round(H * ratio)
        ctx.scale(ratio, ratio)
        this.paintPoster(ctx, W, H, g, coverPath, qrPath, canvas)
          .then(() => {
            wx.canvasToTempFilePath({
              canvas,
              x: 0, y: 0, width: W, height: H,
              destWidth: Math.round(W * ratio), destHeight: Math.round(H * ratio),
              success: (r) => resolve(r.tempFilePath),
              fail: reject
            })
          })
          .catch(reject)
      })
    })
  },

  paintPoster(ctx, W, H, g, coverPath, qrPath, canvas) {
    const loadImg = (src) => new Promise((resolve) => {
      if (!src) return resolve(null)
      const img = canvas.createImage()
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = src
    })

    const roundRect = (x, y, w, h, r) => {
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.lineTo(x + w - r, y)
      ctx.quadraticCurveTo(x + w, y, x + w, y + r)
      ctx.lineTo(x + w, y + h - r)
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
      ctx.lineTo(x + r, y + h)
      ctx.quadraticCurveTo(x, y + h, x, y + h - r)
      ctx.lineTo(x, y + r)
      ctx.quadraticCurveTo(x, y, x + r, y)
      ctx.closePath()
    }

    const clipText = (text, maxWidth) => {
      if (!text) return ''
      if (ctx.measureText(text).width <= maxWidth) return text
      let t = String(text)
      while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1)
      return t + '…'
    }

    return Promise.all([loadImg(coverPath), loadImg(qrPath)]).then((imgs) => {
      const coverImg = imgs[0]
      const qrImg = imgs[1]

      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, W, H)

      // 顶部渐变头图
      const grad = ctx.createLinearGradient(0, 0, W, 240)
      grad.addColorStop(0, '#4d86ff')
      grad.addColorStop(1, '#0fd083')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, W, 240)

      ctx.textAlign = 'center'
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 46px sans-serif'
      ctx.fillText('球场拼场 · 缺你来凑', W / 2, 96)
      ctx.font = '26px sans-serif'
      ctx.fillStyle = 'rgba(255, 255, 255, .9)'
      ctx.fillText(clipText(g.cat && g.cat.name ? g.cat.name : '运动', W - 120), W / 2, 142)
      ctx.font = 'bold 30px sans-serif'
      ctx.fillStyle = '#ffffff'
      ctx.fillText(clipText(g.statusText || '招募中', W - 120), W / 2, 196)

      // 封面区（没有截图时用占位块）
      const coverY = 280
      const coverH = 240
      ctx.save()
      roundRect(60, coverY, W - 120, coverH, 24)
      ctx.clip()
      if (coverImg) {
        ctx.drawImage(coverImg, 60, coverY, W - 120, coverH)
      } else {
        const ph = ctx.createLinearGradient(60, coverY, W - 60, coverY + coverH)
        ph.addColorStop(0, '#eef4ff')
        ph.addColorStop(1, '#eefaf4')
        ctx.fillStyle = ph
        ctx.fillRect(60, coverY, W - 120, coverH)
        ctx.fillStyle = '#9aa3b5'
        ctx.font = '28px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('一起打球，拒绝孤场', W / 2, coverY + coverH / 2 + 10)
      }
      ctx.restore()

      // 场馆 / 时间 / 发起人
      let y = 580
      ctx.textAlign = 'left'
      ctx.fillStyle = '#16233c'
      ctx.font = 'bold 44px sans-serif'
      ctx.fillText(clipText(g.venue || '球场', W - 120), 60, y)

      y += 52
      ctx.fillStyle = '#7b8799'
      ctx.font = '28px sans-serif'
      ctx.fillText(clipText(`${g.dateLabel} ${g.startTime}-${g.endTime}`, W - 120), 60, y)

      const sub = [g.location ? '位置 ' + g.location : '', g.publisherName ? '发起人 ' + g.publisherName : '']
        .filter((s) => s).join('   ·   ')
      if (sub) {
        y += 46
        ctx.fillStyle = '#9aa3b5'
        ctx.font = '24px sans-serif'
        ctx.fillText(clipText(sub, W - 120), 60, y)
      }

      // 名额卡片
      y += 76
      ctx.fillStyle = g.remaining > 0 ? '#eefaf4' : '#f2f4f8'
      roundRect(60, y - 46, W - 120, 110, 20)
      ctx.fill()
      ctx.fillStyle = g.remaining > 0 ? '#06a86b' : '#9aa3b5'
      ctx.font = 'bold 56px sans-serif'
      ctx.fillText(String(g.remaining), 92, y + 30)
      const numW = ctx.measureText(String(g.remaining)).width
      ctx.font = '26px sans-serif'
      ctx.fillStyle = '#7b8799'
      ctx.fillText(`个名额可抢 · 已占 ${g.filled}/${g.total} 人`, 92 + numW + 16, y + 26)

      // 底部小程序码
      const footY = H - 170
      ctx.fillStyle = '#f6f8fd'
      roundRect(60, footY, W - 120, 130, 20)
      ctx.fill()
      if (qrImg) {
        ctx.drawImage(qrImg, 80, footY + 10, 110, 110)
      } else {
        ctx.fillStyle = '#dfe5ef'
        ctx.fillRect(80, footY + 10, 110, 110)
      }
      ctx.textAlign = 'left'
      ctx.fillStyle = '#16233c'
      ctx.font = 'bold 28px sans-serif'
      ctx.fillText(qrImg ? '长按识别小程序码' : '小程序码发布后可用', 212, footY + 52)
      ctx.fillStyle = '#9aa3b5'
      ctx.font = '24px sans-serif'
      ctx.fillText('查看拼场详情并一键报名', 212, footY + 90)
      return true
    })
  },

  savePoster() {
    const path = this.data.poster.path
    if (!path) return
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
      fail: (err) => {
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('auth deny') > -1 || msg.indexOf('authorize') > -1) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许保存到相册',
            confirmText: '去设置',
            success: (r) => { if (r.confirm) wx.openSetting() }
          })
          return
        }
        wx.showToast({ title: '保存失败，可长按海报保存', icon: 'none' })
      }
    })
  }
})
