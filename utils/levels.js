// 中羽等级（业余羽毛球水平分级）：数字越大水平越高，9 级为封顶（9级+）
// 文案参考「中羽等级科普」图（assets/level-guide.jpg）
const LEVELS = [
  { level: 1, name: '极度入门', color: '#7cb342', desc: '基本不会打，只会发球、接球，有时接不住', suit: '纯练习、想体验羽毛球乐趣，以娱乐为主' },
  { level: 2, name: '初学者', color: '#43a047', desc: '能进行基本对打，但移动比较生疏，回球稳定性不足', suit: '刚开始打球、打球频率不高的新手' },
  { level: 3, name: '初级爱好', color: '#00897b', desc: '掌握高远球、吊球等基本技术，能进行简单多拍', suit: '打球 1~3 个月、有兴趣想提升的朋友' },
  { level: 4, name: '中级爱好', color: '#1e88e5', desc: '技术较稳定，步法渐熟，失误减少，能进行基本攻防转换', suit: '打球半年以上、球技尚可想更进一步' },
  { level: 5, name: '中高级', color: '#3949ab', desc: '技术全面，各种控球运用自如，有一定战术意识', suit: '有一定基础、经常打球想继续提升' },
  { level: 6, name: '高级爱好', color: '#8e24aa', desc: '技术熟练稳定，步法灵活，进攻能力强，对抗失误少', suit: '球龄较长、经常参加业余赛的高水平球友' },
  { level: 7, name: '专业级业余', color: '#ef6c00', desc: '技术非常全面，攻防节奏好，比赛经验丰富', suit: '常参加高水平业余赛、想挑战专业球员的爱好者' },
  { level: 8, name: '资深业余', color: '#e53935', desc: '技术非常扎实，执行力与抗压能力强，经过系统训练或比赛磨炼', suit: '追求顶尖比赛体验的高水平业余选手' },
  { level: 9, name: '专业/半专业', color: '#c2185b', desc: '技术水平精湛，体能出色，战术与心理素质俱佳', suit: '专业运动员或有丰富比赛经验的选手' }
]

// 发布页「等级建议」选择器：index 0 = 不限制，index n = 中羽 n 级
const LEVEL_PICKER = ['不限等级（任何水平都可参与）'].concat(
  LEVELS.map((l) => `${l.level === 9 ? '9' : l.level}级 · ${l.name}`)
)

function isValidLevel(v) {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 9
}

// 展示文案：0/空 = 不限等级；9 = 9级+
function levelText(v) {
  if (!isValidLevel(v)) return '不限等级'
  return v === 9 ? '9级+ · 专业/半专业' : `${v}级 · ${LEVELS[v - 1].name}`
}

// 短文案：1级 / 9级+（未设置返回空串）
function levelShort(v) {
  if (!isValidLevel(v)) return ''
  return v === 9 ? '9级+' : `${v}级`
}

function levelName(v) {
  return isValidLevel(v) ? LEVELS[v - 1].name : ''
}

function levelColor(v) {
  return isValidLevel(v) ? LEVELS[v - 1].color : ''
}

module.exports = { LEVELS, LEVEL_PICKER, isValidLevel, levelText, levelShort, levelName, levelColor }
