const app = getApp()
const { CATEGORIES, DEFAULT_CATEGORY, inferCategory } = require('../../utils/categories')
const levels = require('../../utils/levels')
const api = require('../../utils/api')
const util = require('../../utils/util')
const reminder = require('../../utils/reminder')

const MAX_TOTAL = 99

// 「拼场说明」固定选项：只提供系统预设标签，不支持用户自由输入文字
const NOTE_TAGS = ['新手友好', '进阶对抗', '练球为主', '3v3 半场', '双打轮换', '自带球', '提供球', 'AA 制', '准点开始', '可加时']
const NOTE_MAX = 3
const NOTE_SPLIT = ' · '

Page({
  data: {
    cats: CATEGORIES,
    noteTags: NOTE_TAGS.map((t) => ({ name: t, on: false })),
    activeTags: [],
    form: {
      venue: '',
      location: '',
      date: util.offsetDateStr(1),
      startTime: '19:00',
      endTime: '21:00',
      total: 10,
      reserve: 1,
      note: '',
      level: 0, // 等级建议：0 = 不限等级，1-9 = 中羽等级
      category: DEFAULT_CATEGORY
    },
    levelOptions: levels.LEVEL_PICKER,
    levelIndex: 0,
    dateRangeStart: util.todayStr(),
    dateRangeEnd: util.offsetDateStr(90),
    errors: { venue: '', location: '', date: '', time: '', capacity: '', cover: '' },
    img: { preview: '', fileID: '' },
    uploading: false,
    parseState: 0, // 0=未识别 1=识别中 2=成功 3=失败/未配置
    parseTip: '',
    ocrHint: '',
    submitting: false,
    published: false,
    showLogin: false,
    showLevel: false,
    editId: '',
    editMode: false,
    // 开场提醒：发布时可勾选多个预设，到点推送订阅消息。
    // 每条预设自带 on 标志，勾选状态直接存在 item 上，避免 WXML 里再用 indexOf 判断。
    reminderList: (() => {
      const def = new Set(reminder.defaultKeys())
      return Object.keys(reminder.reminderPresets).map((k) => ({
        key: k,
        label: reminder.reminderPresets[k].label,
        on: def.has(k)
      }))
    })(),
    reminderEnabled: !!reminder.subscribeTemplateId
  },

  onShow() {
    this.selectTab()
    // 前置检测：提前探测 OCR 密钥是否配置，未配置则在页首给出友好提示
    this.checkOcrPreflight()
    // 从「编辑」入口进入（发布页是 tab，无法用 navigateTo 传参，故用存储传递 id）
    const editId = wx.getStorageSync('cb_edit_game')
    if (editId && editId !== this.data.editId) {
      wx.removeStorageSync('cb_edit_game')
      this.enterEdit(editId)
    }
  },

  /* ---------------- 编辑模式（发起人修改已有拼场） ---------------- */
  enterEdit(id) {
    this.setData({ editId: id, editMode: true, submitting: false, published: false })
    wx.showLoading({ title: '加载拼场…' })
    api.callApi({ action: 'detail', gameId: id })
      .then((res) => {
        const g = res.data && res.data.game
        if (!g) throw new Error('拼场不存在或已被删除')
        this.prefillFromGame(g)
      })
      .catch((err) => {
        this.setData({ editId: '', editMode: false })
        api.toastErr(err)
      })
      .finally(() => wx.hideLoading())
  },

  prefillFromGame(g) {
    // 还原已设置的提醒（以存储的 key 为准，剔除已失效的预设）
    const saved = new Set(
      (g.reminders || [])
        .map((r) => r.key)
        .filter((k) => reminder.reminderPresets[k])
    )
    const restored = this.restoreTags(g.note)
    this.setData({
      form: {
        venue: g.venue || '',
        location: g.location || '',
        date: g.date || util.offsetDateStr(1),
        startTime: g.startTime || '19:00',
        endTime: g.endTime || '21:00',
        total: g.total || 10,
        reserve: g.reserve || 1,
        note: restored.note,
        level: g.level || 0,
        category: g.category || DEFAULT_CATEGORY
      },
      activeTags: restored.activeTags,
      noteTags: restored.noteTags || this.data.noteTags,
      levelIndex: g.level || 0,
      img: { preview: g.coverFileID || '', fileID: g.coverFileID || '' },
      reminderList: this.data.reminderList.map((r) => ({ ...r, on: saved.has(r.key) }))
    })
  },

  // 勾选 / 取消勾选某条提醒预设（直接翻转该项 on 标志）
  toggleReminder(e) {
    const idx = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.data.reminderList.length) return
    this.setData({ [`reminderList[${idx}].on`]: !this.data.reminderList[idx].on })
  },

  exitEdit() {
    this.resetAfterPublish()
    wx.switchTab({ url: '/pages/index/index' })
  },

  /* ---------------- OCR 前置检测 ---------------- */
  checkOcrPreflight() {
    api.callOcrPreflight()
      .then((r) => {
        const cfg = (r && r.data) || {}
        if (cfg.ocrConfigured) {
          this.setData({ ocrHint: '' })
          return
        }
        this.setData({
          ocrHint: 'OCR 自动识别未配置密钥：配置 百度(免费) / ocr.space(免费2.5万次/月) / 腾讯云 任一即可自动降级，详见 ocrParse 云函数说明；也可先手动填写发布。'
        })
      })
      .catch(() => {
        // 检测失败不阻塞，用户仍可手动填写发布
        this.setData({ ocrHint: '' })
      })
  },

  onShareAppMessage() {
    return { title: 'Court Buddy · 发布你的球场拼场', path: '/pages/publish/publish' }
  },

  selectTab() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
  },

  /* ---------------- 截图上传与 OCR ---------------- */
  chooseImage() {
    if (this.data.uploading || this.data.parseState === 1 || this.data.submitting) return
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles[0]
        if (!file) return
        this.setData({
          'img.preview': file.tempFilePath,
          'img.fileID': '',
          'errors.cover': '',
          parseState: 0
        })
        this.uploadAndParse(file.tempFilePath)
      },
      fail: () => {}
    })
  },

  uploadAndParse(tempPath) {
    if (!wx.cloud) return
    this.setData({ uploading: true, parseState: 1, parseTip: '正在上传截图…' })

    const extMatch = String(tempPath).match(/\.(\w+)$/)
    const ext = (extMatch ? extMatch[1] : 'jpg').toLowerCase()
    const cloudPath = `screenshots/${Date.now()}-${Math.floor(Math.random() * 1000000)}.${ext}`

    wx.cloud.uploadFile({ cloudPath, filePath: tempPath })
      .then((res) => {
        this.setData({ 'img.fileID': res.fileID, parseTip: '正在识别场馆、日期与场次…' })
        return api.callOcr(res.fileID)
      })
      .then((r) => this.applyOcrResult(r))
      .catch((err) => {
        this.setData({
          parseState: 3,
          parseTip: (err && (err.message || err.msg)) || '识别失败，请稍后重试或手动填写'
        })
      })
      .finally(() => this.setData({ uploading: false }))
  },

  // OCR 结果回填表单（保留 OCR 解析出的正确信息，允许用户修正）
  applyOcrResult(r) {
    const data = (r && r.data) || {}
    const patch = {}
    const filled = { date: false, time: false, venue: false, location: false }

    if (data.venue) {
      patch.venue = String(data.venue).slice(0, 30)
      filled.venue = true
    }
    // 场次位置：预约场次下、日期与时间之间（如 3号场 / A区）
    if (data.location) {
      patch.location = String(data.location).slice(0, 30)
      filled.location = true
    }
    if (data.date && util.daysFromToday(data.date) >= 0 && util.daysFromToday(data.date) <= 90) {
      patch.date = data.date
      filled.date = true
    }
    if (data.startTime && data.endTime && data.startTime < data.endTime) {
      patch.startTime = data.startTime
      patch.endTime = data.endTime
      filled.time = true
    }
    // 运动分类：优先采用 OCR 提取的「项目名称」，其次用场馆名推断
    patch.category = inferCategory(data.sport || data.venue || this.data.form.venue)

    this.setData({
      form: { ...this.data.form, ...patch },
      parseState: 2
    })
    this.clearError(['venue', 'date', 'time'])

    const parts = []
    if (filled.venue) parts.push('场馆')
    if (filled.date) parts.push('日期')
    if (filled.time) parts.push('场次')
    if (filled.location) parts.push('位置')
    this.setData({ parseTip: parts.length ? `已识别${parts.join('、')}，请核对后可修正` : '识别完成，请补充下方信息' })
  },

  retryParse() {
    const fileID = this.data.img.fileID
    if (!fileID) return this.chooseImage()
    this.setData({ parseState: 1, parseTip: '正在重新识别…' })
    api.callOcr(fileID)
      .then((r) => this.applyOcrResult(r))
      .catch((err) => {
        this.setData({ parseState: 3, parseTip: (err && (err.message || err.msg)) || '识别失败' })
      })
  },

  removeImage() {
    this.setData({ 'img.preview': '', 'img.fileID': '', parseState: 0, 'errors.cover': '' })
  },

  /* ---------------- 表单输入 ---------------- */
  onVenue(e) {
    this.setData({ 'form.venue': e.detail.value })
    this.clearError('venue')
  },

  onLocation(e) {
    this.setData({ 'form.location': e.detail.value })
    this.clearError('location')
  },

  // 拼场说明：只能选择系统预设标签（最多 3 个），合成后写入 form.note
  toggleNoteTag(e) {
    const tag = e.currentTarget.dataset.tag
    if (!tag) return
    const active = this.data.activeTags.slice()
    const idx = active.indexOf(tag)
    if (idx > -1) {
      active.splice(idx, 1)
    } else {
      if (active.length >= NOTE_MAX) {
        wx.showToast({ title: `最多选 ${NOTE_MAX} 个`, icon: 'none' })
        return
      }
      active.push(tag)
    }
    this.setData({
      activeTags: active,
      'form.note': active.join(NOTE_SPLIT),
      noteTags: this.data.noteTags.map((t) => ({ name: t.name, on: active.indexOf(t.name) > -1 }))
    })
  },

  // 从已保存的 note 还原标签（兼容历史自由文本：无法匹配时原样保留）
  restoreTags(note) {
    const text = String(note || '').trim()
    if (!text) return { activeTags: [], note: '' }
    const parts = text.split(NOTE_SPLIT).map((s) => s.trim()).filter(Boolean)
    const matched = parts.filter((p) => NOTE_TAGS.indexOf(p) > -1)
    return {
      activeTags: matched,
      noteTags: NOTE_TAGS.map((t) => ({ name: t, on: matched.indexOf(t) > -1 })),
      note: text
    }
  },

  // 等级建议：picker index 0 = 不限，index n = 中羽 n 级
  onLevelChange(e) {
    const idx = Number(e.detail.value) || 0
    this.setData({ levelIndex: idx, 'form.level': idx })
  },

  onDate(e) {
    const value = e.detail.value
    if (!value) return
    this.setData({ 'form.date': value })
    this.clearError('date')
  },

  onStart(e) {
    this.setData({ 'form.startTime': e.detail.value })
    this.clearError('time')
  },

  onEnd(e) {
    this.setData({ 'form.endTime': e.detail.value })
    this.clearError('time')
  },

  chooseCategory(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ 'form.category': key })
    this.clearError('category')
  },

  stepTotal(e) {
    const delta = Number(e.currentTarget.dataset.delta)
    const total = this.data.form.total + delta
    this.setData({ 'form.total': Math.max(2, Math.min(MAX_TOTAL, total)) })
    this.checkCapacity()
  },

  stepReserve(e) {
    const delta = Number(e.currentTarget.dataset.delta)
    const reserve = this.data.form.reserve + delta
    this.setData({ 'form.reserve': Math.max(1, Math.min(MAX_TOTAL, reserve)) })
    this.checkCapacity()
  },

  clearError(key) {
    const keys = Array.isArray(key) ? key : [key]
    const patch = {}
    keys.forEach((k) => { patch[`errors.${k}`] = '' })
    this.setData(patch)
  },

  // 实时名额校验（自留名额 > 总名额 / 未给拼友留位 时高亮提示）
  checkCapacity() {
    const { total, reserve } = this.data.form
    let msg = ''
    if (total < 2) {
      msg = '总人数至少为 2 人'
    } else if (reserve > total) {
      msg = '自留名额不能大于总人数'
    } else if (total - reserve < 1) {
      msg = '请为拼友至少预留 1 个名额'
    }
    this.setData({ 'errors.capacity': msg })
    return !msg
  },

  /* ---------------- 提交发布 ---------------- */
  validate() {
    const f = this.data.form
    const errors = { venue: '', location: '', date: '', time: '', capacity: '', cover: '' }
    let first = ''

    if (!this.data.img.fileID && !this.data.img.preview) {
      errors.cover = '请先上传球场预约订单截图'
      first = first || '请先上传预约截图'
    }
    if (!f.venue || !String(f.venue).trim()) {
      errors.venue = '请填写场馆名称（OCR 未识别到时手动补充）'
      first = first || errors.venue
    } else if (String(f.venue).trim().length < 2) {
      errors.venue = '场馆名称至少 2 个字'
      first = first || errors.venue
    }
    if (!f.location || !String(f.location).trim()) {
      errors.location = '请填写场次位置（如 3号场 / A区）'
      first = first || errors.location
    }
    if (!f.date) {
      errors.date = '请选择日期'
      first = first || errors.date
    } else if (util.daysFromToday(f.date) < 0) {
      errors.date = '不能发布已过去的日期'
      first = first || errors.date
    }
    if (!f.startTime || !f.endTime) {
      errors.time = '请选择开始与结束时间'
      first = first || errors.time
    } else if (f.startTime >= f.endTime) {
      errors.time = '结束时间需晚于开始时间'
      first = first || errors.time
    } else if (f.date && util.daysFromToday(f.date) === 0) {
      // 今天的场次：结束时间距今必须 ≥ 30 分钟
      const p = String(f.endTime).split(':')
      const endMin = Number(p[0]) * 60 + Number(p[1])
      const now = new Date()
      const nowMin = now.getHours() * 60 + now.getMinutes()
      if (endMin - nowMin < 30) {
        errors.time = '结束时间距今不足 30 分钟，无法发布'
        first = first || errors.time
      }
    }
    const capMsg = this.checkCapacity()
    if (!capMsg) {
      errors.capacity = this.data.errors.capacity
      first = first || errors.capacity
    }

    this.setData({ errors })
    if (first) {
      wx.showToast({ title: first, icon: 'none' })
      return false
    }
    return true
  },

  submit() {
    if (this.data.submitting || this.data.parseState === 1) return
    if (!this.validate()) return
    // 发布拼场需微信登录：未登录先弹登录引导
    if (!app.isLoggedIn()) {
      this.setData({ showLogin: true })
      return
    }
    // 发布前必须先填写自己的羽毛球等级（中羽等级）
    if (!app.getUserLevel()) {
      this.setData({ showLevel: true })
      return
    }
    if (this.data.editMode) {
      this.doUpdate()
    } else {
      this.doPublish()
    }
  },

  doPublish() {
    if (this.data.submitting) return
    const f = this.data.form
    // 订阅授权必须在本次点击手势内一次性请求：合并「发布成功通知 + 开场提醒」模板。
    // wx.requestSubscribeMessage 在网络回调等异步之后再调用会直接 fail（不在手势内）。
    const tmplIds = reminder.allTemplateIds()
    if (tmplIds.length) {
      reminder.requestAllSubscribe().then((state) => {
        if (state !== 'accept') {
          const tip = reminder.subscribeTip(state)
          if (tip) setTimeout(() => wx.showToast({ title: tip, icon: 'none', duration: 2500 }), 1200)
        }
      })
    }
    this.setData({ submitting: true })

    // 计算各条提醒的推送时刻（基于开场时间）
    const reminders = reminder.buildReminders(
      this.data.reminderList.filter((r) => r.on).map((r) => r.key),
      f.date,
      f.startTime
    )

    api.callApi({
      action: 'publish',
      venue: String(f.venue).trim(),
      location: String(f.location || '').trim().slice(0, 30),
      category: f.category,
      date: f.date,
      startTime: f.startTime,
      endTime: f.endTime,
      total: Number(f.total),
      reserve: Number(f.reserve),
      note: String(f.note || '').trim().slice(0, 50),
      level: Number(f.level) || 0,
      coverFileID: this.data.img.fileID || '',
      publisherName: app.getUserNick(),
      reminders
    })
      .then((res) => {
        const gameId = (res && res.data && res.data.id) || ''
        wx.vibrateShort({ type: 'light' })
        // 订阅授权已在 doPublish 开头（点击手势内）完成，此处不再重复请求——
        // 异步回调后调用 requestSubscribeMessage 会直接 fail 并误报「订阅授权失败」。
        // 一次性订阅每次授权只能收 1 条，多条提醒需在弹窗勾选「总是保持以上选择」
        // 发布成功：推送一条服务通知（用户已在点击手势中授权过通知模板）
        if (tmplIds.length) {
          api.callApi({
            action: 'notify',
            title: '发布成功',
            scene: String(f.venue).slice(0, 20) || '羽毛球拼场',
            time: `${f.date} ${f.startTime}`,
            gameId
          }).then((r) => setTimeout(() => api.toastPushResult(r), 1200)).catch(() => {})
        }
        this.setData({ published: true, parseState: 2, parseTip: '发布成功！大厅已同步更新' })
        wx.showToast({ title: '发布成功 🎉', icon: 'none' })
        setTimeout(() => {
          this.resetAfterPublish()
          wx.switchTab({ url: '/pages/index/index' })
        }, 900)
      })
      .catch((err) => {
        this.setData({ submitting: false })
        if (err && err.code === 418) {
          this.setData({ showLogin: true })
          return
        }
        // 服务端要求先设置等级（兜底，正常情况下前端已拦截）
        if (err && err.code === 419) {
          this.setData({ showLevel: true })
          return
        }
        api.toastErr(err)
      })
  },

  doUpdate() {
    if (this.data.submitting) return
    const f = this.data.form
    // 订阅授权必须在本次点击手势内一次性请求（合并通知 + 提醒模板），与 doPublish 一致
    const tmplIds = reminder.allTemplateIds()
    if (tmplIds.length) {
      reminder.requestAllSubscribe().then((state) => {
        if (state !== 'accept') {
          const tip = reminder.subscribeTip(state)
          if (tip) setTimeout(() => wx.showToast({ title: tip, icon: 'none', duration: 2500 }), 1200)
        }
      })
    }
    this.setData({ submitting: true })

    // 编辑时也同步提醒设置（开场时间变化会导致推送时刻重新计算）
    const reminders = reminder.buildReminders(
      this.data.reminderList.filter((r) => r.on).map((r) => r.key),
      f.date,
      f.startTime
    )

    api.callApi({
      action: 'updateGame',
      gameId: this.data.editId,
      venue: String(f.venue).trim(),
      location: String(f.location || '').trim().slice(0, 30),
      category: f.category,
      date: f.date,
      startTime: f.startTime,
      endTime: f.endTime,
      total: Number(f.total),
      reserve: Number(f.reserve),
      note: String(f.note || '').trim().slice(0, 50),
      level: Number(f.level) || 0,
      coverFileID: this.data.img.fileID || '',
      reminders
    })
      .then(() => {
        const id = this.data.editId
        wx.vibrateShort({ type: 'light' })
        // 订阅授权已在 doUpdate 开头（点击手势内）完成，此处不再重复请求
        // 编辑保存：推送一条服务通知（用户已在点击手势中授权过通知模板）
        if (tmplIds.length) {
          api.callApi({
            action: 'notify',
            title: '保存成功',
            scene: String(f.venue).slice(0, 20) || '羽毛球拼场',
            time: `${f.date} ${f.startTime}`,
            gameId: id
          }).then((r) => setTimeout(() => api.toastPushResult(r), 1200)).catch(() => {})
        }
        wx.showToast({ title: '已保存修改 ✅', icon: 'none' })
        this.resetAfterPublish()
        setTimeout(() => wx.navigateTo({ url: '/pages/detail/detail?id=' + id }), 700)
      })
      .catch((err) => {
        this.setData({ submitting: false })
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
  },

  // 登录成功回调：若已设置等级则继续发布/更新，否则先弹等级设置
  handleLoginSuccess() {
    this.setData({ showLogin: false })
    if (!app.getUserLevel()) {
      this.setData({ showLevel: true })
      return
    }
    if (this.data.editMode) {
      this.doUpdate()
    } else {
      this.doPublish()
    }
  },

  handleLoginCancel() {
    this.setData({ showLogin: false })
  },

  // 等级设置弹层
  handleLevelConfirm() {
    this.setData({ showLevel: false })
    // 设置完成且已登录则继续发布
    if (app.isLoggedIn() && app.getUserLevel()) {
      this.doPublish()
    }
  },

  handleLevelCancel() {
    this.setData({ showLevel: false })
  },

  resetAfterPublish() {
    this.setData({
      form: {
        venue: '',
        location: '',
        date: util.offsetDateStr(1),
        startTime: '19:00',
        endTime: '21:00',
        total: 10,
        reserve: 1,
        note: '',
        level: 0,
        category: DEFAULT_CATEGORY
      },
      levelIndex: 0,
      activeTags: [],
      noteTags: NOTE_TAGS.map((t) => ({ name: t, on: false })),
      errors: { venue: '', location: '', date: '', time: '', capacity: '', cover: '' },
      img: { preview: '', fileID: '' },
      parseState: 0,
      parseTip: '',
      submitting: false,
      published: false,
      editId: '',
      editMode: false
    })
  }
})
