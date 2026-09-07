// 日期与展示工具
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

// 当前时间对应 yyyy-MM-dd（本地时区）
function todayStr() {
  const d = new Date()
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

// 相对今天偏移 offset 天的日期字符串
function offsetDateStr(offset) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

// '2026-09-08' -> Date（本地零点）
function toDate(str) {
  const p = String(str || '').split('-')
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
}

// 相差天数（b - a）
function daysBetween(aStr, bStr) {
  return Math.round((toDate(bStr) - toDate(aStr)) / 86400000)
}

// 距今天还有几天（负数=已过去）
function daysFromToday(dateStr) {
  return daysBetween(todayStr(), dateStr)
}

// 日期展示：9月8日 周二
function dayLabel(dateStr) {
  const d = toDate(dateStr)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`
}

// 今日 / 明日 快捷展示
function shortDayLabel(dateStr) {
  const diff = daysFromToday(dateStr)
  const base = dayLabel(dateStr)
  if (diff === 0) return '今天 · ' + base
  if (diff === 1) return '明天 · ' + base
  return base
}

// ---------- 场次阶段（由云函数计算 phase 字段） ----------
// upcoming 招募中 | ongoing 正在进行 | ending 即将结束(距结束<20分钟)
// ended 已结束 | full 已拼满 | canceled 已取消
const PHASE_TEXT = {
  upcoming: '招募中',
  ongoing: '正在进行',
  ending: '即将结束',
  ended: '已结束',
  full: '已拼满',
  canceled: '已取消'
}

const PHASE_CLASS = {
  upcoming: 'open',
  ongoing: 'ongoing',
  ending: 'ending',
  ended: 'ended',
  full: 'full',
  canceled: 'cancel'
}

function phaseText(phase) {
  return PHASE_TEXT[phase] || '招募中'
}

function phaseClass(phase) {
  return PHASE_CLASS[phase] || 'open'
}

module.exports = {
  pad,
  todayStr,
  offsetDateStr,
  toDate,
  daysBetween,
  daysFromToday,
  dayLabel,
  shortDayLabel,
  phaseText,
  phaseClass
}
