// 中羽等级科普大图查看器（全屏弹层，长按图片可保存 / 转发给球友）
const { cloudAssets } = require('../../utils/config')

// 缓存已转换的 https 链接，避免每次打开都请求
let cachedUrl = 'https://636c-cloudbase-d9gzpm26b441f5f08-1300913513.tcb.qcloud.la/level-guide.jpg?sign=f451426d981c3a4b6d66e314a3cab4ef&t=1788787790'

Component({
  properties: {
    show: { type: Boolean, value: false }
  },
  data: {
    imageSrc: ''
  },
  observers: {
    show(v) {
      if (v) this.loadImage()
    }
  },
  methods: {
    loadImage() {
      const raw = cloudAssets.levelGuide
      // 未配置则回退本地兜底图
      if (!raw) {
        this.setData({ imageSrc: '/assets/level-guide.jpg' })
        return
      }
      // 已是 https 链接，直接使用
      if (raw.startsWith('https://') || raw.startsWith('http://')) {
        this.setData({ imageSrc: raw })
        return
      }
      // cloud:// fileID：转成 https 临时链接再给 image 组件
      if (cachedUrl) {
        this.setData({ imageSrc: cachedUrl })
        return
      }
      wx.cloud.getTempFileURL({
        fileList: [raw],
        success: (res) => {
          const item = res.fileList && res.fileList[0]
          const url = (item && item.tempFileURL) || ''
          if (url) {
            cachedUrl = url
            this.setData({ imageSrc: url })
          } else {
            this.setData({ imageSrc: raw })
          }
        },
        fail: (err) => {
          // 开发者工具模拟器可能无法直接解析 cloud://，建议改用 https 链接
          console.error('[level-viewer] getTempFileURL 失败，请改为填写 https 链接：', err)
          this.setData({ imageSrc: raw })
        }
      })
    },
    close() {
      this.triggerEvent('close')
    },
    noop() {}
  }
})
