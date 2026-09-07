// 运动分类（图标为 Emoji 文本，无任何图片资源）
// 仅保留：篮球 / 网球 / 足球 / 羽毛球 / 乒乓球 / 排球
const RAW = [
  ['basketball', '篮球', '🏀', '#ff7a2f'],
  ['tennis', '网球', '🎾', '#84cc16'],
  ['football', '足球', '⚽', '#12b76a'],
  ['badminton', '羽毛球', '🏸', '#3b82f6'],
  ['tabletennis', '乒乓球', '🏓', '#06b6d4'],
  ['volleyball', '排球', '🏐', '#f59e0b']
]

const DEFAULT_CATEGORY = 'basketball'

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function mixShade(hex, ratio) {
  const h = hex.replace('#', '')
  const r = Math.round(parseInt(h.slice(0, 2), 16) * (1 - ratio))
  const g = Math.round(parseInt(h.slice(2, 4), 16) * (1 - ratio))
  const b = Math.round(parseInt(h.slice(4, 6), 16) * (1 - ratio))
  const pad = (n) => (n < 16 ? '0' : '') + n.toString(16)
  return `#${pad(r)}${pad(g)}${pad(b)}`
}

// 分类数据：key / 名称 / emoji图标 / 主色 / 渐变背景 / 辉光阴影
const CATEGORIES = RAW.map(([key, name, icon, color]) => ({
  key,
  name,
  icon,
  color,
  gradient: `linear-gradient(135deg, ${color} 0%, ${mixShade(color, 0.28)} 100%)`,
  glow: hexToRgba(color, 0.38)
}))

const CAT_MAP = {}
CATEGORIES.forEach((c) => { CAT_MAP[c.key] = c })

function catOf(key) {
  // 历史数据可能含已下线的分类，统一回退到「篮球」，保证展示不报错
  return CAT_MAP[key] || CATEGORIES[0]
}

// 从场馆名称推断运动分类
const KEYWORDS = {
  basketball: ['篮球', 'basketball', 'cba', 'nba'],
  tennis: ['网球', 'tennis'],
  football: ['足球', 'football', '五人制'],
  badminton: ['羽毛球', 'badminton', '羽球'],
  tabletennis: ['乒乓球', 'table', '乒乓'],
  volleyball: ['排球', 'volleyball']
}

function inferCategory(text) {
  const t = String(text || '').toLowerCase()
  for (const key of Object.keys(KEYWORDS)) {
    if (KEYWORDS[key].some((kw) => t.indexOf(kw.toLowerCase()) > -1)) {
      return key
    }
  }
  return DEFAULT_CATEGORY
}

// 头像底色色板（按昵称取稳定色）
const AVATAR_COLORS = [
  '#2f6bff', '#0fd083', '#ff7a2f', '#8b5cf6', '#06b6d4',
  '#f59e0b', '#ec4899', '#12b76a', '#3b82f6', '#ef4444'
]
function avatarColor(str) {
  const s = String(str || '球')
  let hash = 0
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

module.exports = {
  CATEGORIES,
  DEFAULT_CATEGORY,
  catOf,
  inferCategory,
  avatarColor
}
