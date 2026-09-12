// 开场提醒工具：预设、sendAt 计算、订阅授权
const {
  reminderPresets,
  defaultReminderKeys,
  joinResultTemplateId, // ① 报名结果通知
  soonTemplateId,       // ② 活动即将开始通知
  startTemplateId,      // ③ 活动开始通知
  checkinBeforeMin,     // 开场前多少分钟起可「开启球场并核销」
  openRemindAfterMin,   // 开场后多少分钟无人开启 → 向全体推送提醒
  cancelJoinBeforeMin   // 开场前多少分钟内不可取消报名（锁定期）
} = require('./config')

// 「开启球场 + 登记核销」时间窗，缺省值保证配置缺失时也有合理行为：
// 开场前 CHECKIN_BEFORE_MIN 分钟起可操作，直到场次结束时间（endTime）都可核销
const CHECKIN_BEFORE_MIN = Number(checkinBeforeMin) || 15
const OPEN_REMIND_AFTER_MIN = Number(openRemindAfterMin) || 5
// 取消报名锁定期（分钟）：开场前这么多分钟起不可再取消报名
const CANCEL_JOIN_BEFORE_MIN = Number(cancelJoinBeforeMin) || 15

// 把 yyyy-MM-dd + HH:mm 当成北京时间，转成真实 UTC 毫秒时间戳
function startTs(dateStr, timeStr) {
  const s = `${dateStr}T${timeStr}:00+08:00`
  const t = new Date(s).getTime()
  return isNaN(t) ? 0 : t
}

// 由勾选的预设 key 列表，结合开场时间，算出每条提醒的推送时刻 sendAt
// 返回 [{ key, label, offsetMin, sendAt }]
function buildReminders(keys, dateStr, startTime) {
  const base = startTs(dateStr, startTime)
  if (!base) return []
  const list = []
  ;(keys || []).forEach((k) => {
    const p = reminderPresets[k]
    if (!p) return
    list.push({
      key: k,
      label: p.label,
      offsetMin: p.offsetMin,
      sendAt: base - p.offsetMin * 60000
    })
  })
  return list
}

// 默认勾选项
function defaultKeys() {
  return (defaultReminderKeys || []).slice()
}

// 「开启球场 + 登记核销」的时间窗
// 返回 { state, startAt, openAt, expireAt, remindAt }
//   state: 'early' 还没到可操作时间 | 'open' 可操作 | 'expired' 核销已失效
// 核销有效期：开场前 CHECKIN_BEFORE_MIN 分钟起，直到「场次结束时间」都可核销
// （支持打到一半出去核销）；endTime 缺失时兜底为开场时刻。
function checkinWindow(dateStr, startTime, now, endTime) {
  const startAt = startTs(dateStr, startTime)
  const t = Number(now) || Date.now()
  const openAt = startAt ? startAt - CHECKIN_BEFORE_MIN * 60000 : 0
  const expireAt = startTs(dateStr, endTime) || startAt
  let state = 'open'
  if (startAt) {
    if (t < openAt) state = 'early'
    else if (t > expireAt) state = 'expired'
  }
  return {
    state,
    startAt,
    openAt,
    expireAt,
    remindAt: startAt ? startAt + OPEN_REMIND_AFTER_MIN * 60000 : 0
  }
}

// 取消报名的时间窗：开场前 CANCEL_JOIN_BEFORE_MIN 分钟内（含已开场）锁定名额，
// 不可再取消报名；此前可随时取消让出名额。
// 返回 { state, deadlineAt, leftMs }
//   state: 'open' 可取消 | 'locked' 已锁定不可取消
function cancelJoinWindow(dateStr, startTime, now) {
  const startAt = startTs(dateStr, startTime)
  const t = Number(now) || Date.now()
  const deadlineAt = startAt ? startAt - CANCEL_JOIN_BEFORE_MIN * 60000 : 0
  const locked = !!startAt && t >= deadlineAt
  return {
    state: locked ? 'locked' : 'open',
    deadlineAt,
    leftMs: locked ? 0 : Math.max(0, deadlineAt - t)
  }
}

// 毫秒 → 人话时长（用于倒计时）：2 小时 5 分 / 13 分 20 秒 / 45 秒
function fmtDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分 ${sec} 秒`
  return `${sec} 秒`
}

// 把「提前多少分钟」人性化为标签（用于参与者自定义提醒）
function humanizeOffset(min) {
  min = Number(min) || 0
  if (min <= 0) return '开场时（开启球场并核销）'
  if (min % 1440 === 0) return `开场前 ${min / 1440} 天`
  if (min >= 60) {
    const h = Math.floor(min / 60)
    const m = min % 60
    return m ? `开场前 ${h} 小时 ${m} 分钟` : `开场前 ${h} 小时`
  }
  return `开场前 ${min} 分钟`
}

// 参与者自定义一条提醒：key 用 c_<offsetMin> 与发起人的预设 key 区分开
// 返回 [{ key, label, offsetMin, sendAt }] 中的单条，或 null（时间非法）
function buildCustomReminder(offsetMin, dateStr, startTime) {
  const base = startTs(dateStr, startTime)
  if (!base) return null
  const off = Number(offsetMin) || 0
  if (off < 0) return null
  return {
    key: `c_${off}`,
    label: humanizeOffset(off),
    offsetMin: off,
    sendAt: base - off * 60000
  }
}

// 请求「提醒类」订阅授权（活动即将开始通知 + 活动开始通知，去重后一并弹出）。
// 返回 Promise<string>：'accept' 已授权 | 'reject' 拒绝 | 'ban' 被后台封禁 |
//                       'unsupported' 未配置模板/基础库不支持 | 'fail:xxx' 接口调用失败
// 注意：一次性订阅消息每次授权只能收到 1 条，多条提醒需要在弹窗里勾选「总是保持以上选择」
function requestSubscribe() {
  return new Promise((resolve) => {
    const ids = []
    ;[soonTemplateId, startTemplateId].forEach((id) => {
      if (id && ids.indexOf(id) === -1) ids.push(id)
    })
    if (!ids.length || !wx.requestSubscribeMessage) {
      resolve('unsupported')
      return
    }
    wx.requestSubscribeMessage({
      tmplIds: ids,
      success: (res) => {
        const states = ids.map((id) => (res || {})[id])
        if (states.indexOf('accept') !== -1) resolve('accept')
        else if (states.indexOf('ban') !== -1) resolve('ban')
        else resolve('reject')
      },
      fail: (err) => resolve('fail:' + String((err && err.errMsg) || ''))
    })
  })
}

// 「操作结果通知」实际使用的模板：优先「报名结果通知」，未配置时回退「活动即将开始通知」
function notifyTmplId() {
  return joinResultTemplateId || soonTemplateId
}

// 请求「操作结果通知」订阅授权（报名成功 / 发布成功后即时推送）。
// 与 requestSubscribe 同理返回 'accept'/'reject'/'ban'/'unsupported'/'fail:xxx'。
// 注意：wx.requestSubscribeMessage 必须在用户点击手势内同步调用，因此应在 onJoin / doPublish 函数体开头调用。
function requestNotifySubscribe() {
  return new Promise((resolve) => {
    const tid = notifyTmplId()
    if (!tid || !wx.requestSubscribeMessage) {
      resolve('unsupported')
      return
    }
    wx.requestSubscribeMessage({
      tmplIds: [tid],
      success: (res) => {
        const state = res && res[tid]
        if (state === 'accept') resolve('accept')
        else if (state === 'ban') resolve('ban')
        else resolve('reject')
      },
      fail: (err) => resolve('fail:' + String((err && err.errMsg) || ''))
    })
  })
}

// 本次操作需要授权的全部模板 ID（去重）：报名结果 + 即将开始 + 开始，共 3 个。
// 某模板未配置（''）时自动剔除，去重后只弹实际配置了的模板。
function allTemplateIds() {
  const ids = []
  ;[joinResultTemplateId, soonTemplateId, startTemplateId].forEach((id) => {
    if (id && ids.indexOf(id) === -1) ids.push(id)
  })
  return ids
}

// 按提前分钟数选择提醒模板：开场时刻（offsetMin=0）用「活动开始通知」，
// 其余（提前 N 分钟/小时/天）用「活动即将开始通知」。
function templateIdForOffset(offsetMin) {
  return (Number(offsetMin) || 0) === 0 ? startTemplateId : soonTemplateId
}

// 一次性请求全部订阅授权（发布/报名场景：通知 + 提醒模板合并在一个弹窗里）。
// ⚠️ 必须在用户点击手势内同步调用：wx.requestSubscribeMessage 若在网络回调等
// 异步之后再调用会直接 fail（errMsg: can only be invoked by user TAP gesture）。
function requestAllSubscribe() {
  return new Promise((resolve) => {
    const ids = allTemplateIds()
    if (!ids.length || !wx.requestSubscribeMessage) {
      resolve('unsupported')
      return
    }
    wx.requestSubscribeMessage({
      tmplIds: ids.slice(0, 3), // 接口限制一次最多 3 个模板
      success: (res) => {
        const states = ids.map((id) => (res || {})[id])
        if (states.indexOf('accept') !== -1) resolve('accept')
        else if (states.indexOf('ban') !== -1) resolve('ban')
        else resolve('reject')
      },
      fail: (err) => resolve('fail:' + String((err && err.errMsg) || ''))
    })
  })
}

// 授权结果 → 给用户的提示文案（未授权时提醒仍会保存，只是收不到推送）
function subscribeTip(state) {
  if (state === 'accept') return ''
  if (state === 'ban') return '订阅消息已被禁用，请在小程序设置中重新开启'
  if (state === 'reject') return '未同意接收订阅消息，到点不会收到提醒推送'
  if (state === 'unsupported') return '未配置订阅消息模板，暂不支持推送'
  // fail:xxx：接口调用失败，带出真实原因便于排查（如「只能在用户点击时调用」）
  console.warn('[reminder] 订阅授权失败:', state)
  const msg = String(state || '')
    .replace(/^fail:/, '')
    .replace(/^requestSubscribeMessage:fail\s*/, '')
    .trim()
  const short = msg.length > 30 ? msg.slice(0, 30) + '…' : msg
  return short ? '订阅授权失败：' + short : '订阅授权失败，到点可能收不到提醒推送'
}

module.exports = {
  reminderPresets,
  defaultKeys,
  humanizeOffset,
  startTs,
  checkinWindow,
  cancelJoinWindow,
  fmtDuration,
  buildReminders,
  buildCustomReminder,
  templateIdForOffset,
  requestSubscribe,
  subscribeTip,
  requestNotifySubscribe,
  notifyTmplId,
  allTemplateIds,
  requestAllSubscribe,
  // 「开启球场 + 核销」时间窗常量（详情页提示文案使用，缺失会显示 undefined）
  CHECKIN_BEFORE_MIN,
  OPEN_REMIND_AFTER_MIN,
  // 取消报名锁定期常量（详情页 / 我的页提示文案使用）
  CANCEL_JOIN_BEFORE_MIN,
  // 兼容旧字段名：subscribeTemplateId → 活动即将开始通知；notifyTemplateId → 报名结果通知
  subscribeTemplateId: soonTemplateId,
  notifyTemplateId: joinResultTemplateId
}
