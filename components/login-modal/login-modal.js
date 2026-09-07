// 微信登录引导弹层（复用组件）
// 登录动作：头像(chooseAvatar) + 昵称(type=nickname) + 手机号(getPhoneNumber 或手动输入)
// 手机号优先用微信 getPhoneNumber（通过 wx.cloud.CloudID 传云端自动解密）；
// 若 getPhoneNumber 不可用（如小程序未认证），支持手动填写手机号完成登录，避免流程卡死。
const app = getApp()
const api = require('../../utils/api')

Component({
  properties: {
    show: { type: Boolean, value: false },
    tip: { type: String, value: '登录后你的拼场身份将与微信账号绑定' }
  },
  data: {
    busy: false,
    nick: '',
    phone: '',          // 手动填写的手机号（明文，仅在 getPhoneNumber 不可用时使用）
    avatarUrl: '',      // 展示用地址（云存储 fileID 或临时路径）
    avatarFileID: ''    // 已上传云存储的 fileID（空表示尚未上传）
  },
  observers: {
    show(v) {
      if (v) {
        // 预填已保存的资料，方便老用户补登（手机号不预填，避免误导）
        const nick = app.getUserNick()
        this.setData({
          busy: false,
          nick: nick && nick.indexOf('球友') !== 0 ? nick : '',
          phone: '',
          avatarUrl: app.getUserAvatar() || '',
          avatarFileID: app.getUserAvatar() || ''
        })
      } else {
        this.setData({ busy: false })
      }
    }
  },
  methods: {
    preventMove() {},
    onCancel() {
      if (this.data.busy) return
      this.triggerEvent('cancel')
    },

    // 选择头像：chooseAvatar 返回临时路径，上传到云存储得到可长期使用的 fileID
    onChooseAvatar(e) {
      const url = e.detail && e.detail.avatarUrl
      if (!url) return
      this.setData({ avatarUrl: url })
      if (!wx.cloud || !wx.cloud.uploadFile) return
      wx.cloud.uploadFile({
        cloudPath: 'avatars/' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.png',
        filePath: url
      }).then((res) => {
        this.setData({ avatarUrl: res.fileID, avatarFileID: res.fileID })
      }).catch(() => {
        wx.showToast({ title: '头像上传失败，将使用临时头像', icon: 'none' })
      })
    },

    onNickInput(e) {
      this.setData({ nick: e.detail.value })
    },

    onPhoneInput(e) {
      this.setData({ phone: e.detail.value })
    },

    // 统一登录提交：extra 传 { cloudID }（微信手机号）或 { phone }（手动）
    loginWith(extra) {
      this.setData({ busy: true })
      const nick = (this.data.nick || '').trim().slice(0, 12) || app.getUserNick()
      const avatar = this.data.avatarFileID || this.data.avatarUrl || ''
      api.callApi(Object.assign({
        action: 'login',
        nick,
        avatar,
        level: app.getUserLevel() || 0
      }, extra))
        .then((res) => {
          const data = res.data || {}
          app.setLoggedIn(true)
          app.setUserNick(nick)
          if (avatar) app.setUserAvatar(avatar)
          if (data.phone) app.setUserPhone(data.phone) // data.phone 已是脱敏后的
          this.setData({ busy: false })
          this.triggerEvent('success')
        })
        .catch((err) => {
          this.setData({ busy: false })
          wx.showToast({ title: (err && (err.message || err.msg)) || '登录失败，请重试', icon: 'none' })
        })
    },

    // 微信手机号授权：成功则自动填入并登录；失败（未认证/取消）提示改用手动输入
    onGetPhone(e) {
      if (this.data.busy) return
      const detail = e.detail || {}
      if (detail.errMsg !== 'getPhoneNumber:ok') {
        wx.showToast({ title: '微信获取失败，可手动填写手机号登录', icon: 'none' })
        return
      }
      this.loginWith({ cloudID: wx.cloud.CloudID(detail.cloudID) })
    },

    // 手动填写手机号登录（getPhoneNumber 不可用时的可靠兜底）
    onManualLogin() {
      if (this.data.busy) return
      const phone = (this.data.phone || '').trim()
      if (!/^1\d{10}$/.test(phone)) {
        wx.showToast({ title: '请输入正确的 11 位手机号', icon: 'none' })
        return
      }
      this.loginWith({ phone })
    }
  }
})
