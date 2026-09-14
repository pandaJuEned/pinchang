// app.js
const config = require('./utils/config')

App({
  globalData: {
    envId: config.envId,
    // 小程序版本号（提审时同步更新）
    version: '1.2.4',
    loggedIn: false,
    user: { nick: '', level: 0, avatar: '', phone: '' }
  },

  onLaunch() {
    // 初始化云开发（未填写 envId 时使用默认环境）
    if (!wx.cloud) {
      wx.showModal({
        title: '提示',
        content: '当前微信基础库版本过低，无法使用云开发能力，请升级微信后重试。',
        showCancel: false
      })
      return
    }
    const options = { traceUser: true }
    // 防御性去空格，避免误填前导/尾随空格导致 INVALID_ENV
    const envId = String(config.envId || '').trim()
    if (envId) options.env = envId
    wx.cloud.init(options)
    this.initUser()
  },

  initUser() {
    let nick = wx.getStorageSync('cb_nick')
    if (!nick) {
      nick = '球友' + Math.floor(100 + Math.random() * 900)
      wx.setStorageSync('cb_nick', nick)
    }
    this.globalData.user.nick = nick
    this.globalData.loggedIn = wx.getStorageSync('cb_login') === '1'
    // 羽毛球等级（中羽等级 1-9，0 = 未设置）
    const level = Number(wx.getStorageSync('cb_level')) || 0
    this.globalData.user.level = level >= 1 && level <= 9 ? level : 0
    // 头像（云存储 fileID）与手机号
    this.globalData.user.avatar = wx.getStorageSync('cb_avatar') || ''
    this.globalData.user.phone = wx.getStorageSync('cb_phone') || ''
  },

  getUserNick() {
    return this.globalData.user.nick || wx.getStorageSync('cb_nick') || '球友'
  },

  setUserNick(nick) {
    const n = String(nick || '').trim().slice(0, 12)
    if (n) {
      this.globalData.user.nick = n
      wx.setStorageSync('cb_nick', n)
    }
    return n
  },

  /* ---------------- 羽毛球等级（中羽等级） ---------------- */
  getUserLevel() {
    return this.globalData.user.level || 0
  },

  setUserLevel(level) {
    const lv = Number(level)
    if (!(lv >= 1 && lv <= 9)) return this.getUserLevel()
    this.globalData.user.level = lv
    wx.setStorageSync('cb_level', String(lv))
    return lv
  },

  /* ---------------- 头像（云存储 fileID） ---------------- */
  getUserAvatar() {
    return this.globalData.user.avatar || wx.getStorageSync('cb_avatar') || ''
  },

  setUserAvatar(avatar) {
    this.globalData.user.avatar = avatar || ''
    if (avatar) wx.setStorageSync('cb_avatar', avatar)
    else wx.removeStorageSync('cb_avatar')
    return this.globalData.user.avatar
  },

  /* ---------------- 手机号（脱敏存储） ---------------- */
  getUserPhone() {
    return this.globalData.user.phone || wx.getStorageSync('cb_phone') || ''
  },

  setUserPhone(phone) {
    this.globalData.user.phone = phone || ''
    if (phone) wx.setStorageSync('cb_phone', phone)
    else wx.removeStorageSync('cb_phone')
    return this.globalData.user.phone
  },

  /* ---------------- 微信登录态 ---------------- */
  isLoggedIn() {
    return wx.getStorageSync('cb_login') === '1'
  },

  setLoggedIn(on) {
    if (on) {
      wx.setStorageSync('cb_login', '1')
      this.globalData.loggedIn = true
    } else {
      wx.removeStorageSync('cb_login')
      this.globalData.loggedIn = false
    }
    return !!on
  }
})
