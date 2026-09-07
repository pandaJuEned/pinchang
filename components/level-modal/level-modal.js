// 羽毛球等级（中羽等级）设置弹层：
// 发布 / 参与拼场前需先选择自己的等级；同时可查看等级科普大图
const { LEVELS } = require('../../utils/levels')
const api = require('../../utils/api')

Component({
  properties: {
    show: { type: Boolean, value: false }
  },
  data: {
    levels: LEVELS,
    selected: 1,
    cur: LEVELS[0],
    showViewer: false
  },
  observers: {
    show(v) {
      if (!v) return
      const lv = getApp().getUserLevel()
      const selected = lv >= 1 && lv <= 9 ? lv : 1
      this.setData({ selected, cur: LEVELS[selected - 1], showViewer: false })
    }
  },
  methods: {
    noop() {},
    onSelect(e) {
      const level = Number(e.currentTarget.dataset.level)
      if (!(level >= 1 && level <= 9)) return
      this.setData({ selected: level, cur: LEVELS[level - 1] })
    },
    openImage() {
      this.setData({ showViewer: true })
    },
    closeImage() {
      this.setData({ showViewer: false })
    },
    onConfirm() {
      const level = this.data.selected
      const cur = this.data.cur
      getApp().setUserLevel(level)
      // 已登录则同步到云端 users.level；未登录时由页面流程先走登录，之后仍会要求设置等级
      if (getApp().isLoggedIn()) {
        api.callApi({ action: 'setLevel', level }).catch(() => {})
      }
      this.triggerEvent('confirm', { level, name: cur.name })
    },
    onCancel() {
      this.triggerEvent('cancel')
    }
  }
})
