/**
 * courtApi —— Court Buddy 核心业务云函数（动作分发）
 *
 * 数据集合（云开发自动创建，无需配置权限，函数具备管理员读写能力）：
 *   users   ：微信登录用户 { openid, nick, level, loginAt }，_id = openid，level = 中羽等级(1-9，0未设置)
 *   games   ：拼场活动 { openid, publisherName, venue, category, date, startTime, endTime,
 *                        total, reserve, joined, note, level, coverFileID, status, createdAt }
 *   enrolls ：报名记录 { gameId, openid, nickName, level, createdAt }，level 为报名时的等级快照
 *
 * 登录策略：publish（发布）/ join（报名）都要求该 openid 已在 users 中存在登录记录，
 * 否则返回 code 418（前端据此弹出「微信登录」引导），从根本上杜绝绕过前端直接调用。
 *
 * 防超卖方案：报名 / 取消报名 / 取消拼场 均使用数据库事务（startTransaction），
 * 在事务内读档校验名额 → 写入 enrolls → 更新 joined，多人并发也不会超卖。
 *
 * action 列表：
 *   login     微信登录：为 openid 创建/刷新 users 登录记录
 *   setLevel  设置用户羽毛球等级（中羽 1-9 级）
 *   publish   发布拼场（需登录 + 已设置等级）
 *   join      报名抢位（事务，需登录 + 已设置等级）
 *   cancelJoin 取消报名（事务，开场前 15 分钟内锁定名额不可取消）
 *   cancelGame 取消拼场（事务，仅发起人）
 *   hall      拼场大厅列表（open/ongoing、未拼满、未来场次；已拼满不再展示）
 *   mine      我的拼场（我发布的 + 我报名的）
 *   detail    拼场详情（卡片点击进入；发起人可看到报名名单）
 *   adjustTotal 发起人调整总人数（事务，不能低于已占用 = 自留 + 已报名）
 *   enrolls   某拼场的报名名单（仅发起人可见）
 *   updateGame 发起人编辑拼场信息（仅发起人）
 *   deleteGame 发起人删除拼场（仅发起人，连同报名记录一并删除）
 *   subscribeReminder 报名者/参与者订阅本场开场提醒（由 remindTick 定时推送订阅消息）
 *
 * 到点自动结束：结束时间（date + endTime）一过，remindTick 定时任务把 games.status 置为 'ended'；
 * 本函数在各操作中对 'ended' 状态做拦截（不可报名/开启球场/核销/取消/编辑/调整人数/设置提醒），
 * 且 hall 查询（仅 open/full/ongoing）天然不再展示已结束场次。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// 仅支持：篮球 / 网球 / 足球 / 羽毛球 / 乒乓球 / 排球
const ALLOW_CATS = ['basketball', 'tennis', 'football', 'badminton', 'tabletennis', 'volleyball']

// ① 报名结果通知模板（关键词：报名结果 / 活动时间 / 备注）。
// 用于「报名成功 / 发布成功 / 保存成功」即时服务通知（doNotify）。
// 需与前端 utils/config.js 的 joinResultTemplateId 一致；留空 '' 时回退复用「活动即将开始通知」模板。
const JOIN_RESULT_TEMPLATE_ID = 'rDsEAyzX05yPYx5YceH68RPpT1VbhJeKzH16rywJA-g'
// ② 活动即将开始通知模板（关键词：场地 / 活动时间 / 温馨提示）。
// 开场前/开场时提醒由 remindTick 云函数推送；这里仅作为报名结果模板未配置时 doNotify 的回退。
const SOON_TEMPLATE_ID = 'Zaw4DdByL0g_jEJ0U11kuI-LamcWIm-zcV5xXs7pfN4'
// ③ 活动开始通知模板（关键词：距离开始时间 / 活动名称 / 活动地点 / 温馨提示）。
// 点击「开启球场」时向全场参与者推送，需与前端 utils/config.js 的 startTemplateId 一致。
// 留空 '' 时开启球场不推送（开场时刻的定时提醒仍由 remindTick 负责）。
const START_TEMPLATE_ID = 'EjdpIf9omE1ns1Bi3iOqHcgh4BBdJQEF9pV9-X0wmKQ'

// 「开启球场 + 登记核销」时间窗：与 utils/config.js 保持一致。
// 开场前 CHECKIN_BEFORE_MIN 分钟起可操作；核销一直有效到「场次结束时间」（endTime），
// 即整个时间段（含打到一半出去核销）都可核销，结束时间之后核销失效。
const CHECKIN_BEFORE_MIN = 15
// 取消报名锁定期（分钟）：开场前这么多分钟起锁定名额、不可再取消，
// 与 utils/config.js 的 cancelJoinBeforeMin 保持一致。
const CANCEL_BEFORE_MIN = 15

// 点击消息后跳转的小程序版本：formal=正式版 developer=开发版 trial=体验版
// ⚠️ 设为 developer / trial 时只有开发者、体验者能收到消息，普通用户一条都收不到。
//    这是「发布/报名/提醒/开启球场全都收不到推送」最常见的原因，务必保持 formal。
const MP_STATE = 'formal'

// 订阅消息常见错误码 → 人话，随结果一并返回前端，便于真机上直接定位
const PUSH_ERR = {
  40003: 'touser openid 为空或不正确',
  40037: 'template_id 不正确（模板 ID 填错或不属于本小程序）',
  47003: '模板参数不准确（关键词编号/类型/长度不符）',
  41030: 'page 路径不正确（页面需在 app.json 中注册）',
  42003: '接口调用频率超限',
  43101: '用户未订阅该模板（一次性订阅每次授权只能收 1 条，需在弹窗勾选「总是保持以上选择」）'
}

// 统一解析 subscribeMessage.send 的异常，返回 { errCode, errMsg }
function pushErrInfo(e) {
  const code = e && (e.errCode != null ? e.errCode : (e.errcode != null ? e.errcode : ''))
  const raw = String((e && (e.errMsg || e.message)) || e || '')
  const known = PUSH_ERR[code]
  return { errCode: code || '', errMsg: known || raw || '推送失败' }
}

// 中国时区(UTC+8)的今天字符串 yyyy-MM-dd
function nowChinaDate() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

function fail(code, msg) {
  return { code, msg }
}

exports.main = async (event) => {
  const action = (event && event.action) || ''
  try {
    switch (action) {
      case 'login': return await doLogin(event)
      case 'setLevel': return await doSetLevel(event)
      case 'publish': return await doPublish(event)
      case 'join': return await doJoin(event)
      case 'cancelJoin': return await doCancelJoin(event)
      case 'cancelGame': return await doCancelGame(event)
      case 'updateGame': return await doUpdateGame(event)
      case 'deleteGame': return await doDeleteGame(event)
      case 'gameQrcode': return await doGameQrcode(event)
  case 'hall': return await doHall(event)
  case 'mine': return await doMine()
  case 'detail': return await doDetail(event)
  case 'setVerify': return await doSetVerify(event)
  case 'openCourt': return await doOpenCourt(event)
  case 'adjustTotal': return await doAdjustTotal(event)
  case 'enrolls': return await doEnrolls(event)
      case 'subscribeReminder': return await doSubscribeReminder(event)
      case 'notify': return await doNotify(event)
      case 'pushDiag': return await doPushDiag(event)
      default:
        return fail(400, '未知操作')
    }
  } catch (err) {
    if (err && err._biz) return { code: err.code, msg: err.msg }
    console.error(`[courtApi] ${action} error:`, err)
    return fail(500, '服务繁忙，请稍后再试')
  }
}

function biz(code, msg) {
  const e = new Error(msg)
  e._biz = true
  e.code = code
  e.msg = msg
  return e
}

/* ===================== 开场提醒（订阅消息） ===================== */
// 校验并归一化前端传来的提醒数组：[{ key, label, offsetMin, sendAt }]
// 去重、限制条数，sendAt 必须为合法时间戳（基于开场时间算出的推送时刻）
function normalizeReminders(event) {
  const raw = Array.isArray(event.reminders) ? event.reminders : []
  const seen = {}
  const out = []
  for (let i = 0; i < raw.length && out.length < 6; i++) {
    const r = raw[i] || {}
    const key = String(r.key || '').trim()
    const sendAt = Number(r.sendAt)
    if (!key || seen[key]) continue
    if (!Number.isFinite(sendAt) || sendAt <= 0) continue
    seen[key] = true
    out.push({
      key,
      label: String(r.label || '').slice(0, 20),
      offsetMin: Number(r.offsetMin) || 0,
      sendAt
    })
  }
  return out
}

// 为某用户（openid）写入/更新该拼场的提醒文档；以确定性 _id 保证幂等、不重复堆积
// 文档结构：{ gameId, openid, key, label, sendAt, sent:false, createdAt }
async function upsertReminderDocs(gameId, openid, reminders) {
  if (!gameId || !openid || !reminders || !reminders.length) return
  await ensureCollection('reminders')
  const now = db.serverDate()
  for (const r of reminders) {
    const _id = `R_${gameId}_${openid}_${r.key}`
    try {
      await db.collection('reminders').doc(_id).set({
        data: {
          _id,
          gameId,
          openid,
          key: r.key,
          label: r.label,
          offsetMin: Number(r.offsetMin) || 0, // remindTick 据此选模板：0=活动开始通知，>0=活动即将开始通知
          sendAt: r.sendAt,
          sent: false,
          createdAt: now
        }
      })
    } catch (e) { /* 单条失败不影响其余 */ }
  }
}

// 取消 / 删除拼场时，把该拼场尚未发出的提醒标记为已处理，避免定时任务继续推送
async function markRemindersDone(gameId) {
  if (!gameId) return
  try {
    await db.collection('reminders')
      .where({ gameId, sent: false })
      .update({ data: { sent: true, canceled: true } })
  } catch (e) { /* 忽略 */ }
}

// 参与者重新设置自己的提醒：先清掉该用户在本拼场旧的提醒文档，再写入新的，
// 保证自定义 / 沿用发起人 两种选择之间切换时不会堆积重复推送
async function replaceReminderDocs(gameId, openid, reminders) {
  if (!gameId || !openid || !reminders || !reminders.length) return
  await ensureCollection('reminders')
  try {
    await db.collection('reminders').where({ gameId, openid }).remove()
  } catch (e) { /* 忽略 */ }
  await upsertReminderDocs(gameId, openid, reminders)
}

// 报名记录使用确定性 _id，天然唯一，事务内可直接 doc.get 判断是否已报名
function enrollDocId(gameId, openid) {
  return `E_${gameId}_${openid}`
}

function getOpenid() {
  const wxContext = cloud.getWXContext()
  return (wxContext && wxContext.OPENID) || ''
}

// 安全查询：集合未创建 / 索引缺失 / 权限异常等查询报错时返回 null，由调用方决定降级策略，
// 保证列表页在数据层异常时优雅显示空态，而不是把错误抛到外层变成「服务繁忙」。
async function safeGet(col, where, sort) {
  try {
    let q = db.collection(col).where(where || {})
    ;(sort || []).forEach((s) => { q = q.orderBy(s.field, s.dir || 'asc') })
    const res = await q.limit(100).get()
    return res.data || []
  } catch (e) {
    console.warn(`[courtApi] safeGet 降级 ${col}:`, e && (e.errMsg || e.message))
    return null
  }
}

// 确保集合存在：集合不存在时自动创建（已存在则忽略），避免首次使用数据库时报「集合不存在」。
async function ensureCollection(name) {
  try {
    await db.createCollection(name)
    return true
  } catch (e) {
    // 已存在 / 无权限创建等都忽略，交由后续真实的读写去暴露错误
    return false
  }
}

// 查询当前 openid 的登录记录；未登录 / 无记录返回 null
async function currentUser(openid) {
  if (!openid) return null
  try {
    const r = await db.collection('users').doc(openid).get()
    return r.data || null
  } catch (e) {
    return null
  }
}

// 批量取用户头像（users._id = openid），返回 openid → avatar(fileID) 映射，供报名名单/参与者展示
async function avatarsByOpenids(openids) {
  const map = {}
  if (!openids || !openids.length) return map
  try {
    const res = await db.collection('users').where({ _id: _.in(openids) }).limit(500).get()
    ;(res.data || []).forEach((u) => { if (u.avatar) map[u._id] = u.avatar })
  } catch (e) { /* 忽略：拿不到头像就回退字母头像 */ }
  return map
}

// 校验登录：未在 users 中建立登录记录时抛 418（前端据此弹出微信登录引导）
async function requireLogin() {
  const openid = getOpenid()
  if (!openid) throw biz(403, '无法获取用户身份，请重新进入小程序')
  const me = await currentUser(openid)
  if (!me) throw biz(418, '请先完成微信登录后再操作')
  return { openid, me }
}

// 校验等级：发布 / 报名前必须已设置羽毛球等级（未设置抛 419，前端据此弹出等级设置弹层）
function requireLevel(me) {
  const lv = Number(me && me.level) || 0
  if (!(lv >= 1 && lv <= 9)) throw biz(419, '请先设置自己的羽毛球等级（中羽 1-9 级）')
  return lv
}

/* ===================== 微信登录 ===================== */
// 微信一键登录：以 openid 为 _id 创建/刷新 users 登录记录（幂等，可反复调用）
// 同时写入头像（云存储 fileID）与手机号（前端经 wx.cloud.CloudID 传入，wx-server-sdk 自动解密）
async function doLogin(event) {
  const openid = getOpenid()
  if (!openid) return fail(403, '无法获取用户身份，请重新进入小程序')
  await ensureCollection('users')
  const nick = String(event.nick || '').trim().slice(0, 12) || '球友'
  const avatar = String(event.avatar || '').trim()
  // 手机号：优先用前端 wx.cloud.CloudID(cloudID) 传入（wx-server-sdk 自动解密为真实内容）；
  // 当 getPhoneNumber 不可用（如小程序未认证）时，允许前端手动填写明文手机号兜底
  let phone = ''
  try {
    const cd = event.cloudID
    if (cd && cd.purePhoneNumber) phone = cd.purePhoneNumber
    else if (cd && cd.phoneNumber) phone = cd.phoneNumber
  } catch (e) { phone = '' }
  if (!phone && event.phone) {
    const p = String(event.phone).trim()
    if (/^1\d{10}$/.test(p)) phone = p
  }
  // 等级合并策略：重复登录不丢已设置的等级；首次登录时接受前端带来的本地等级
  const prev = await currentUser(openid)
  const prevLevel = prev && Number(prev.level) >= 1 && Number(prev.level) <= 9 ? Number(prev.level) : 0
  const evtLevel = Number(event.level)
  const level = prevLevel || (evtLevel >= 1 && evtLevel <= 9 ? evtLevel : 0)
  // 头像/手机号合并：仅当用户本次传入了才覆盖，避免清空已有资料
  const data = { openid, nick, level, loginAt: db.serverDate() }
  if (avatar || (prev && prev.avatar)) data.avatar = avatar || prev.avatar
  if (phone || (prev && prev.phone)) data.phone = phone || prev.phone
  await db.collection('users').doc(openid).set({ data })
  // 回传脱敏手机号（保留前3后4），便于前端展示，避免明文存储到本地
  const masked = (data.phone || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
  return { code: 0, data: { loggedIn: true, openid, nick, level, avatar: data.avatar || '', phone: masked } }
}

/* ===================== 设置羽毛球等级（中羽 1-9 级） ===================== */
async function doSetLevel(event) {
  const openid = getOpenid()
  if (!openid) return fail(403, '无法获取用户身份，请重新进入小程序')
  const level = Number(event.level)
  if (!(level >= 1 && level <= 9)) return fail(400, '等级不合法，请选择 1-9 级')
  await ensureCollection('users')
  const me = await currentUser(openid)
  if (me) {
    await db.collection('users').doc(openid).update({
      data: { level, levelUpdatedAt: db.serverDate() }
    })
  } else {
    // 兜底：从未登录过也允许直接落库，结构与登录写入保持一致
    await db.collection('users').doc(openid).set({
      data: {
        openid,
        nick: String(event.nick || '').trim().slice(0, 12) || '球友',
        level,
        loginAt: db.serverDate()
      }
    })
  }
  return { code: 0, data: { level } }
}

/* ===================== 发布拼场（需登录 + 已设置等级） ===================== */
async function doPublish(event) {
  const { openid, me } = await requireLogin()
  requireLevel(me)

  const venue = String(event.venue || '').trim()
  const category = ALLOW_CATS.indexOf(event.category) > -1 ? event.category : 'basketball'
  const date = String(event.date || '')
  const startTime = String(event.startTime || '')
  const endTime = String(event.endTime || '')
  const note = String(event.note || '').trim().slice(0, 60)
  const total = Number(event.total)
  const reserve = Number(event.reserve)
  const publisherName = String(event.publisherName || '').trim().slice(0, 12) || '球友'
  const coverFileID = String(event.coverFileID || '')
  const location = String(event.location || '').trim().slice(0, 30) // 场次位置（如 3号场 / A区）
  const level = Number(event.level) || 0 // 等级建议：0 = 不限制，1-9 = 中羽等级
  const today = nowChinaDate()

  if (venue.length < 2 || venue.length > 30) return fail(400, '请填写正确的场馆名称')
  if (!location) return fail(400, '请填写场次位置（如 3号场 / A区）')
  if (!DATE_RE.test(date)) return fail(400, '日期格式不正确')
  if (date < today) return fail(400, '不能发布已过去的日期')
  if (date > today.slice(0, 4) + '-12-31') return fail(400, '暂不支持跨年发布')
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) return fail(400, '场次时间格式不正确')
  if (startTime >= endTime) return fail(400, '结束时间需晚于开始时间')
  // 距离结束时间不足 30 分钟的场次不允许发布
  const endTs = beijingTs(date, endTime)
  if (!endTs || endTs - Date.now() < 30 * 60 * 1000) {
    return fail(400, '该场次的结束时间距今不足 30 分钟，无法发布')
  }
  if (!Number.isInteger(total) || total < 2 || total > 99) return fail(400, '总人数需在 2-99 之间')
  if (!Number.isInteger(reserve) || reserve < 1) return fail(400, '自留名额至少 1 个')
  if (reserve > total) return fail(400, '自留名额不能大于总人数')
  if (total - reserve < 1) return fail(400, '请为拼友至少预留 1 个名额')
  if (coverFileID && coverFileID.indexOf('cloud://') !== 0) return fail(400, '截图信息异常，请重新上传')
  if (!(level >= 0 && level <= 9)) return fail(400, '等级建议不合法')

  // 首次使用数据库时集合往往未创建，直接 add 会报「集合不存在」→ 先自动建齐再写入
  await Promise.all([ensureCollection('games'), ensureCollection('enrolls')])

  // 开场提醒：归一化前端勾选的提醒，并随拼场一起落库
  const reminders = normalizeReminders(event)

  const res = await db.collection('games').add({
    data: {
      openid,
      publisherName,
      venue,
      location,
      category,
      date,
      startTime,
      endTime,
      note,
      level,
      total,
      reserve,
      joined: 0,
      status: 'open',
      coverFileID,
      verifiedCount: 0,
      verified: false,
      reminders,
      createdAt: db.serverDate()
    }
  })

  // 发起人也订阅自己设置的提醒（到点由 remindTick 云函数推送订阅消息）
  if (reminders.length) {
    await upsertReminderDocs(res._id, openid, reminders)
  }

  return { code: 0, data: { id: res._id } }
}

/* ===================== 报名（事务，防超卖/防重复，需登录） ===================== */
async function doJoin(event) {
  const { openid, me } = await requireLogin()
  requireLevel(me)
  const gameId = String(event.gameId || '')
  if (!gameId) return fail(400, '参数错误')
  const nickName = String(event.nickName || '').trim().slice(0, 12) || '球友'
  const enrollId = enrollDocId(gameId, openid)
  const today = nowChinaDate()

  const transaction = await db.startTransaction()
  try {
    let game
    try {
      const r = await transaction.collection('games').doc(gameId).get()
      game = r.data
    } catch (e) {
      throw biz(401, '拼场不存在或已被删除')
    }
    if (!game) throw biz(401, '拼场不存在或已被删除')
    if (game.status === 'canceled') throw biz(401, '该拼场已取消')
    if (game.status === 'ended') throw biz(409, '该场次已结束，无法报名')
    if (game.date < today) throw biz(409, '该场次已过期，无法报名')
    // 当天场次已过结束时间则不可再报名
    const joinEndTs = beijingTs(game.date, game.endTime)
    if (joinEndTs && Date.now() >= joinEndTs) throw biz(409, '该场次已结束，无法报名')
    if (game.openid === openid) throw biz(403, '你是发起人，无需报名')

    // 事务内按确定性 _id 判断是否已报名（同一用户并发双击也只会成功一次）
    let duplicated = false
    try {
      const r2 = await transaction.collection('enrolls').doc(enrollId).get()
      if (r2 && r2.data && r2.data._id) duplicated = true
    } catch (e) { duplicated = false }
    if (duplicated) throw biz(410, '你已报名该拼场，请勿重复操作')

    const remaining = game.total - game.reserve - (game.joined || 0)
    if (remaining <= 0) throw biz(409, '手慢了，名额已抢完')

    const nJoined = (game.joined || 0) + 1
    const nRemaining = remaining - 1
    const nStatus = nRemaining <= 0 ? 'full' : game.status

    await transaction.collection('games').doc(gameId).update({
      data: { joined: nJoined, status: nStatus }
    })
    await transaction.collection('enrolls').add({
      data: {
        _id: enrollId,
        gameId,
        openid,
        nickName,
        level: Number(me.level) || 0,
        createdAt: db.serverDate()
      }
    })
    await transaction.commit()

    return {
      code: 0,
      data: { gameId, joined: nJoined, remaining: nRemaining, status: nStatus }
    }
  } catch (err) {
    try { await transaction.rollback() } catch (e) { /* ignore */ }
    throw err
  }
}

/* ===================== 取消报名（事务） ===================== */
async function doCancelJoin(event) {
  const openid = getOpenid()
  if (!openid) return fail(403, '无法获取用户身份，请重新进入小程序')
  const gameId = String(event.gameId || '')
  if (!gameId) return fail(400, '参数错误')

  const transaction = await db.startTransaction()
  try {
    let enroll = null
    try {
      const r = await transaction.collection('enrolls').doc(enrollDocId(gameId, openid)).get()
      if (r && r.data && r.data._id) enroll = r.data
    } catch (e) { enroll = null }
    if (!enroll) throw biz(411, '未找到报名记录')

    let game
    try {
      const r = await transaction.collection('games').doc(gameId).get()
      game = r.data
    } catch (e) { /* ignore */ }
    if (!game) throw biz(401, '拼场不存在或已被删除')
    if (game.status === 'ended') throw biz(409, '该场次已结束，无需取消报名')
    // 开场前 CANCEL_BEFORE_MIN 分钟内（含已开场）锁定名额，不可再取消，
    // 防止临近开场临时放鸽子；服务端强制校验，前端入口（详情页 / 我的页）仅做展示引导
    const cancelStartTs = beijingTs(game.date, game.startTime)
    if (cancelStartTs && Date.now() >= cancelStartTs - CANCEL_BEFORE_MIN * 60000) {
      throw biz(409, `开场前 ${CANCEL_BEFORE_MIN} 分钟内不可取消报名，名额已锁定`)
    }

    const nJoined = Math.max(0, (game.joined || 0) - 1)
    const nRemaining = game.total - game.reserve - nJoined
    let nStatus = game.status
    if (game.status === 'full' && nRemaining > 0) nStatus = 'open'
    if (game.status === 'canceled') nStatus = 'canceled'

    await transaction.collection('games').doc(gameId).update({
      data: { joined: nJoined, status: nStatus }
    })
    await transaction.collection('enrolls').doc(enroll._id).remove()
    await transaction.commit()

    return { code: 0, data: { gameId, joined: nJoined, remaining: nRemaining, status: nStatus } }
  } catch (err) {
    try { await transaction.rollback() } catch (e) { /* ignore */ }
    throw err
  }
}

/* ===================== 取消拼场（事务，仅发起人） ===================== */
async function doCancelGame(event) {
  const openid = getOpenid()
  if (!openid) return fail(403, '无法获取用户身份，请重新进入小程序')
  const gameId = String(event.gameId || '')
  if (!gameId) return fail(400, '参数错误')

  const transaction = await db.startTransaction()
  try {
    let game
    try {
      const r = await transaction.collection('games').doc(gameId).get()
      game = r.data
    } catch (e) {
      throw biz(401, '拼场不存在或已被删除')
    }
    if (!game) throw biz(401, '拼场不存在或已被删除')
    if (game.openid !== openid) throw biz(403, '仅发起人可以取消拼场')
    if (game.status === 'canceled') {
      await transaction.rollback()
      return { code: 0, data: { status: 'canceled' } }
    }
    if (game.status === 'ended') throw biz(409, '该场次已结束，无需取消')
    await transaction.collection('games').doc(gameId).update({
      data: { status: 'canceled' }
    })
    await transaction.commit()
    // 取消拼场：未发出的提醒不再推送
    await markRemindersDone(gameId)
    return { code: 0, data: { status: 'canceled' } }
  } catch (err) {
    try { await transaction.rollback() } catch (e) { /* ignore */ }
    throw err
  }
}

/* ===================== 编辑拼场信息（仅发起人） ===================== */
async function doUpdateGame(event) {
  const { openid } = await requireLogin()
  const gameId = String(event.gameId || '')
  if (!gameId) return fail(400, '参数错误')

  const game = await currentUserGame(openid, gameId)
  if (!game) return fail(401, '拼场不存在或已被删除')
  if (game.openid !== openid) return fail(403, '仅发起人可以编辑拼场')
  if (game.status === 'ended') return fail(409, '该场次已结束，无法编辑')

  const venue = String(event.venue || '').trim()
  const category = ALLOW_CATS.indexOf(event.category) > -1 ? event.category : 'badminton'
  const date = String(event.date || '')
  const startTime = String(event.startTime || '')
  const endTime = String(event.endTime || '')
  const note = String(event.note || '').trim().slice(0, 60)
  const total = Number(event.total)
  const reserve = Number(event.reserve)
  const location = String(event.location || '').trim().slice(0, 30)
  const level = Number(event.level) || 0
  const coverFileID = String(event.coverFileID || '')
  const today = nowChinaDate()

  if (venue.length < 2 || venue.length > 30) return fail(400, '请填写正确的场馆名称')
  if (!location) return fail(400, '请填写场次位置（如 3号场 / A区）')
  if (!DATE_RE.test(date)) return fail(400, '日期格式不正确')
  if (date < today) return fail(400, '不能发布已过去的日期')
  if (date > today.slice(0, 4) + '-12-31') return fail(400, '暂不支持跨年发布')
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) return fail(400, '场次时间格式不正确')
  if (startTime >= endTime) return fail(400, '结束时间需晚于开始时间')
  // 今天的场次：结束时间距今必须 ≥ 30 分钟
  if (date === today) {
    const endTs = beijingTs(date, endTime)
    if (!endTs || endTs - Date.now() < 30 * 60 * 1000) {
      return fail(400, '该场次的结束时间距今不足 30 分钟，无法保存')
    }
  }
  if (!Number.isInteger(total) || total < 2 || total > 99) return fail(400, '总人数需在 2-99 之间')
  if (!Number.isInteger(reserve) || reserve < 1) return fail(400, '自留名额至少 1 个')
  if (reserve > total) return fail(400, '自留名额不能大于总人数')
  // 总人数不能低于已占用（自留 + 已报名），否则会把已报名的球友挤掉
  const joined = game.joined || 0
  const gReserve = game.reserve || 0
  if (total < gReserve + joined) {
    return fail(400, `总人数不能低于已占用 ${gReserve + joined} 人（自留 ${gReserve} + 已报名 ${joined}）`)
  }
  if (!(level >= 0 && level <= 9)) return fail(400, '等级建议不合法')
  if (coverFileID && coverFileID.indexOf('cloud://') !== 0) return fail(400, '截图信息异常，请重新上传')

  // 状态跟随剩余名额变化（已取消 / 已开启球场的保持原态）
  const remaining = Math.max(0, total - reserve - joined)
  let status = game.status
  if (game.status === 'open' || game.status === 'full') {
    status = remaining <= 0 ? 'full' : 'open'
  }

  // 重新计算提醒（开场时间变化会影响推送时刻）
  const reminders = normalizeReminders(event)

  await db.collection('games').doc(gameId).update({
    data: {
      venue,
      location,
      category,
      date,
      startTime,
      endTime,
      note,
      level,
      total,
      reserve,
      coverFileID,
      status,
      reminders
    }
  })

  // 发起人提醒随编辑同步：清掉旧的、按最新设置重建（确定性 _id 幂等）
  if (reminders.length) {
    try {
      await db.collection('reminders').where({ gameId, openid }).remove()
    } catch (e) { /* 忽略 */ }
    await upsertReminderDocs(gameId, openid, reminders)
  } else {
    await markRemindersDone(gameId)
  }

  return { code: 0, data: { id: gameId, status } }
}

/* ===================== 删除拼场（仅发起人，连同报名记录） ===================== */
async function doDeleteGame(event) {
  const { openid } = await requireLogin()
  const gameId = String(event.gameId || '')
  if (!gameId) return fail(400, '参数错误')

  const game = await currentUserGame(openid, gameId)
  if (!game) return fail(401, '拼场不存在或已被删除')
  if (game.openid !== openid) return fail(403, '仅发起人可以删除拼场')

  await db.collection('games').doc(gameId).remove()
  // 一并清理该拼场的报名记录
  try {
    await db.collection('enrolls').where({ gameId }).remove()
  } catch (e) { /* 即便报名记录清理失败，拼场本身已删除，忽略 */ }
  // 删除拼场：未发出的提醒一并清理
  await markRemindersDone(gameId)

  return { code: 0, data: { deleted: true } }
}

/* ===================== 拼场小程序码（用于分享海报） ===================== */
// 云调用 wxacode.getUnlimited 生成 scene=gameId 的小程序码，落到云存储后返回 fileID。
// 注意：page 必须是「已发布」的页面，未发布/体验版调用会失败，前端会降级成无码海报。
async function doGameQrcode(event) {
  const gameId = String(event.gameId || '')
  if (!gameId) return fail(400, '参数错误')

  try {
    const r = await db.collection('games').doc(gameId).get()
    if (!r || !r.data) return fail(401, '拼场不存在或已被删除')
  } catch (e) {
    return fail(401, '拼场不存在或已被删除')
  }

  // scene 最长 32 个字符（云开发自动生成的 _id 通常为 32 位）
  if (gameId.length > 32) return fail(400, '场次 ID 超长，无法生成小程序码')
  // 固定 cloudPath：同一场次重复生成会覆盖，天然复用、不会堆积文件
  const cloudPath = 'qrcodes/game_' + gameId + '.png'

  try {
    const res = await cloud.openapi.wxacode.getUnlimited({
      scene: gameId,
      page: 'pages/detail/detail',
      width: 280,
      isHyaline: false
    })
    const buffer = res && res.buffer
    if (!buffer || !buffer.length) return fail(500, '小程序码生成失败')
    const up = await cloud.uploadFile({ cloudPath, fileContent: buffer })
    return { code: 0, data: { fileID: up.fileID, scene: gameId } }
  } catch (e) {
    const msg = (e && (e.errMsg || e.message)) || ''
    console.warn('[courtApi] wxacode 生成失败:', msg)
    return fail(500, '小程序码生成失败（小程序发布后可用）：' + msg)
  }
}

// 取某 openid 名下的拼场（用于编辑/删除前的归属校验）
async function currentUserGame(openid, gameId) {
  if (!openid) return null
  try {
    const r = await db.collection('games').doc(gameId).get()
    return r.data || null
  } catch (e) {
    return null
  }
}

/* ===================== 拼场大厅 ===================== */
async function doHall(event) {
  const openid = getOpenid()
  const today = nowChinaDate()
  const category = String(event.category || '')
  // 已拼满的场次不再进入大厅：查询剔除 full 状态（full/ongoing 且剩余名额为 0 的都不展示），
  // 返回前再按剩余名额兜底过滤一次，防止旧数据 status 与 joined 不同步时漏网
  const where = { status: _.in(['open', 'ongoing']), date: _.gte(today) }
  if (category) where.category = category

  // 逐级兜底查询：任一查询失败都返回 null，交给下一策略；最终都失败时返回空列表。
  // 这样即使集合未创建 / 组合索引缺失 / 权限异常，也不会抛出导致整页报「服务繁忙」。
  // 优先按 日期+开始时间 排序；若缺少组合索引出错，退回 createdAt 排序；再失败则按空处理
  let list = await safeGet('games', where, [{ field: 'date', dir: 'asc' }, { field: 'startTime', dir: 'asc' }])
  if (list === null) list = await safeGet('games', where, [{ field: 'createdAt', dir: 'desc' }])
  if (list === null) list = []
  // 兜底过滤：剩余名额（total - reserve - joined）≤ 0 的场次不下发（含进行中但已满的场次）
  list = list.filter((g) => (g.total || 0) - (g.reserve || 0) - (g.joined || 0) > 0)
  // 兜底过滤：已过结束时间的场次不下发 —— status 可能仍停留在 ongoing（等 remindTick 翻转），
  // 查询条件只按状态/日期，这里按 endTime 再兜一道，避免深夜大厅还挂着白天的「进行中」场次
  list = list.filter((g) => {
    const gEndTs = beijingTs(g.date, g.endTime)
    return !gEndTs || Date.now() < gEndTs
  })

  // 我报名过的场次集合
  const joinedSet = {}
  if (openid && list.length) {
    try {
      const ids = list.map((g) => g._id)
      const eRes = await db.collection('enrolls')
        .where({ openid, gameId: _.in(ids) })
        .limit(500)
        .get()
      ;(eRes.data || []).forEach((e) => { joinedSet[e.gameId] = true })
    } catch (e) { /* ignore */ }
  }

  return {
    code: 0,
    data: list.map((g) => decorateGame(g, openid, joinedSet[g._id]))
  }
}

/* ===================== 我的拼场 ===================== */
async function doMine() {
  const openid = getOpenid()
  if (!openid) return fail(403, '无法获取用户身份，请重新进入小程序')

  // 我发布的场次（查询失败按空处理，不抛 500）
  const pList = await safeGet('games', { openid }, [{ field: 'createdAt', dir: 'desc' }])
  const published = (pList || []).map((g) => decorateGame(g, openid, false))

  // 我报名的记录（enrolls 集合不存在 / 查询失败时同样按空处理）
  const eList = await safeGet('enrolls', { openid }, [{ field: 'createdAt', dir: 'desc' }])
  const enrolls = eList || []

  const ids = []
  const seen = {}
  enrolls.forEach((e) => {
    if (e.gameId && !seen[e.gameId]) {
      seen[e.gameId] = true
      ids.push(e.gameId)
    }
  })

  let joined = []
  if (ids.length) {
    const gMap = {}
    const gList = await safeGet('games', { _id: _.in(ids) }, null)
    ;(gList || []).forEach((g) => { gMap[g._id] = g })
    joined = enrolls
      .filter((e) => gMap[e.gameId])
      .map((e) => ({
        ...decorateGame(gMap[e.gameId], openid, true),
        enrollId: e._id,
        joinedAt: e.createdAt
      }))
  }

  return { code: 0, data: { published, joined } }
}

/* ===================== 拼场详情（卡片点击进入） ===================== */
async function doDetail(event) {
  const openid = getOpenid()
  const gameId = String(event.gameId || '')
  if (!gameId) return fail(400, '参数错误')

  let game
  try {
    const r = await db.collection('games').doc(gameId).get()
    game = r.data
  } catch (e) { /* ignore */ }
  if (!game) return fail(401, '拼场不存在或已被删除')

  // 我是否已报名
  let isJoined = false
  if (openid) {
    try {
      const r = await db.collection('enrolls').doc(enrollDocId(gameId, openid)).get()
      isJoined = !!(r && r.data && r.data._id)
    } catch (e) { isJoined = false }
  }
  const isOwner = !!openid && game.openid === openid

  // 报名名单：所有人可见（昵称 + 报名时的等级快照）
  let enrolls = []
  try {
    const eRes = await db.collection('enrolls')
      .where({ gameId })
      .orderBy('createdAt', 'asc')
      .limit(500)
      .get()
    enrolls = (eRes.data || []).map((e) => ({
      nickName: e.nickName || '球友',
      level: e.level || 0,
      createdAt: e.createdAt,
      openid: e.openid || ''
    }))
  } catch (e) { enrolls = [] }

  // 批量取头像：报名者 + 发起人，避免逐人查库
  const avatarMap = await avatarsByOpenids(
    enrolls.map((e) => e.openid).filter(Boolean).concat(game.openid || [])
  )
  enrolls = enrolls.map((e) => ({
    nickName: e.nickName,
    level: e.level,
    createdAt: e.createdAt,
    avatar: avatarMap[e.openid] || ''
  }))

  // 发起人也占用名额，一并展示（取账号当前的昵称 / 等级 / 头像）
  const publisher = {
    nickName: game.publisherName || '球友',
    level: 0,
    reserve: game.reserve || 0,
    openid: game.openid || '',
    avatar: avatarMap[game.openid] || ''
  }
  try {
    const uRes = await db.collection('users').doc(game.openid).get()
    if (uRes && uRes.data) {
      publisher.nickName = uRes.data.nick || publisher.nickName
      publisher.level = Number(uRes.data.level) || 0
    }
  } catch (e) { /* 忽略：没有 users 记录时按未定级处理 */ }

  // 预约凭证换临时链接：云函数具备管理员权限，不受云存储「仅创建者可读」安全规则限制，
  // 避免报名球友的 image 直接加载 cloud:// fileID 时因非文件创建者被拒而看不到截图
  const gameView = decorateGame(game, openid, isJoined)
  if (gameView.coverFileID) {
    try {
      const fRes = await cloud.getTempFileURL({ fileList: [gameView.coverFileID] })
      const f = (fRes && fRes.fileList && fRes.fileList[0]) || null
      if (f && f.tempFileURL) gameView.coverUrl = f.tempFileURL
    } catch (e) { /* 换链失败时前端回退 fileID 展示 */ }
  }

  return {
    code: 0,
    data: {
      game: gameView,
      isOwner,
      isJoined,
      openid: openid || '',
      occupied: (game.reserve || 0) + (game.joined || 0),
      verified: !!game.verified,
      verifyRemark: game.verifyRemark || '',
      publisher,
      enrolls
    }
  }
}

/* ===================== 核销（针对「场地」，整场只核销一次，任一参与者均可） ===================== */
// 核销的是场地，不是人：整场拼场只有一个核销状态 games.verified + verifyRemark，
// 任意参与者（发起人 / 已报名球友）点击一次即标记场地已核销，不可撤销、仅可补备注。
async function doSetVerify(event) {
  const openid = getOpenid()
  if (!openid) return fail(403, '无法获取用户身份，请重新进入小程序')
  const gameId = String(event.gameId || '')
  if (!gameId) return fail(400, '参数错误')
  const remark = String(event.remark || '').trim().slice(0, 60)

  let game
  try {
    const r = await db.collection('games').doc(gameId).get()
    game = r.data
  } catch (e) { /* ignore */ }
  if (!game) return fail(401, '拼场不存在或已被删除')
  if (game.status === 'canceled') return fail(401, '该拼场已取消')
  if (game.status === 'ended') return fail(409, '本场已结束，无法核销')

  // 鉴权：发起人 / 已报名的球友（即拼场成功的参与者）均可核销场地；旁观者无权
  const isOwner = game.openid === openid
  let authorized = isOwner
  if (!authorized) {
    try {
      const r = await db.collection('enrolls').doc(enrollDocId(gameId, openid)).get()
      authorized = !!(r && r.data && r.data._id)
    } catch (e) { authorized = false }
  }
  if (!authorized) return fail(403, '只有参与本场拼场的人才能核销')

  // 时间窗：开场前 CHECKIN_BEFORE_MIN 分钟起才可核销，直到场次结束时间（endTime）都可核销
  const startTs = beijingTs(game.date, game.startTime)
  const endTs = beijingTs(game.date, game.endTime)
  const now = Date.now()
  if (game.status === 'ongoing' && game.verified) {
    return fail(409, '场地已核销，无需重复操作')
  }
  if (startTs && now < startTs - CHECKIN_BEFORE_MIN * 60000) {
    return fail(409, `开场前 ${CHECKIN_BEFORE_MIN} 分钟（${game.startTime} 前）才能核销场地`)
  }
  if (endTs && now > endTs) {
    return fail(409, `本场时间段（${game.startTime}-${game.endTime}）已结束，无法核销`)
  }

  const data = { verified: true }
  if (remark) data.verifyRemark = remark
  await db.collection('games').doc(gameId).update({ data })

  return {
    code: 0,
    data: {
      verified: true,
      remark,
      openid
    }
  }
}

/* ===================== 开启球场 + 登记核销（合并为一个操作，任一参与者均可） ===================== */
// 到场后点一次即「开启球场并登记核销」：状态→进行中，并在时间窗内把场地核销标记置为 true。
// 时间窗：开场前 CHECKIN_BEFORE_MIN 分钟起可操作；核销一直有效到「场次结束时间」（endTime），
// 结束后仍可开启球场，但不再登记核销（避免错过核销的人永远无法关单）。
async function doOpenCourt(event) {
  const openid = getOpenid()
  if (!openid) return fail(403, '无法获取用户身份，请重新进入小程序')
  const gameId = String(event.gameId || '')
  if (!gameId) return fail(400, '参数错误')
  const remark = String(event.remark || '').trim().slice(0, 60)

  let game
  try {
    const r = await db.collection('games').doc(gameId).get()
    game = r.data
  } catch (e) { /* ignore */ }
  if (!game) return fail(401, '拼场不存在或已被删除')
  if (game.status === 'canceled') return fail(401, '该拼场已取消')
  if (game.status === 'ended') return fail(409, '本场已结束，无法开启球场')

  const isOwner = game.openid === openid
  let isJoined = false
  if (!isOwner) {
    try {
      const r = await db.collection('enrolls').doc(enrollDocId(gameId, openid)).get()
      isJoined = !!(r && r.data && r.data._id)
    } catch (e) { isJoined = false }
  }
  if (!isOwner && !isJoined) return fail(403, '只有参与本场拼场的人才能开启球场')

  // 已开启：仅在「时间窗内且尚未核销」时才允许补登记核销，否则直接返回当前状态
  if (game.status === 'ongoing') {
    if (game.verified) {
      return { code: 0, data: { status: 'ongoing', verified: true, already: true } }
    }
  }

  // 时间窗：开场前 CHECKIN_BEFORE_MIN 分钟起才能「开启球场并登记核销」
  const startTs = beijingTs(game.date, game.startTime)
  const endTs = beijingTs(game.date, game.endTime)
  const now = Date.now()
  if (startTs && now < startTs - CHECKIN_BEFORE_MIN * 60000) {
    return fail(409, `开场前 ${CHECKIN_BEFORE_MIN} 分钟（${game.startTime} 前）才能开启球场并登记核销`)
  }
  // 是否仍在核销窗口内（直到场次结束时间都可核销）
  const inWindow = !!startTs && now >= startTs - CHECKIN_BEFORE_MIN * 60000 && (!endTs || now <= endTs)

  // 合并：开启球场（状态→进行中）+ 时间窗内登记核销
  const data = { status: 'ongoing' }
  let verified = false
  if (game.status !== 'ongoing') {
    data.openedAt = db.serverDate()
    data.openedBy = openid
    data.openRemindSent = true // 已有人开启，remindTick 不再补推「超时未开启」提醒
  }
  // 已开启但未核销（例如开场很久后才点开、或旧版本数据）→ 时间窗内补核销
  if (!game.verified && inWindow) {
    data.verified = true
    data.verifiedAt = db.serverDate()
    data.verifiedBy = openid
    if (remark) data.verifyRemark = remark
    verified = true
  } else if (game.verified) {
    verified = true
  } else {
    // 已过核销窗口（场次已结束）：仅开启球场，不再登记核销
    data.verifyExpired = true
  }
  await db.collection('games').doc(gameId).update({ data })

  let openCourtPush = { pushed: 0, total: 0, pushErr: '' }
  // 开启球场：向全场参与者（发起人 + 已报名球友）推送「活动开始通知」。
  // 一次性订阅需对方此前授权过该模板（发布/报名/设置提醒时勾选了「开场时」并同意），
  // 未授权的用户发送会失败（43101），静默跳过，不影响开启流程。
  if (START_TEMPLATE_ID) {
    const openids = [game.openid]
    try {
      const eRes = await db.collection('enrolls').where({ gameId }).limit(100).get()
      ;(eRes.data || []).forEach((e) => {
        if (e.openid && openids.indexOf(e.openid) === -1) openids.push(e.openid)
      })
    } catch (e) { /* 拿不到名单时只推给发起人 */ }
    const venue = String(game.venue || '球场').trim().slice(0, 20) || '球场'
    const loc = String(game.location || '').trim()
    let pushed = 0
    let pushErr = ''
    for (const touser of openids) {
      try {
        await cloud.openapi.subscribeMessage.send({
          touser,
          templateId: START_TEMPLATE_ID,
          page: 'pages/detail/detail?id=' + gameId,
          miniprogram_state: MP_STATE,
          lang: 'zh_CN',
          // 「活动开始通知」关键词：距离开始时间 character_string17（仅数字/字母/符号，≤5 字符，不能是汉字）/
          // 活动名称 thing4 / 活动地点 thing6 / 温馨提示 thing7
          data: {
            character_string17: { value: '0min' },
            thing4: { value: venue },
            thing6: { value: (venue + (loc ? ' ' + loc : '')).slice(0, 20) },
            thing7: { value: verified ? '球场已开启并核销' : '球场已开启' }
          }
        })
        pushed++
      } catch (e) {
        const info = pushErrInfo(e)
        if (!pushErr) pushErr = info.errMsg
        console.warn('[courtApi] openCourt push failed:', touser, info.errCode, info.errMsg)
      }
    }
    openCourtPush = { pushed, total: openids.length, pushErr }
  }

  // 已手动开启球场：把本场「开场时(d0)」的定时提醒标记完成，避免到点重复推送
  try {
    await db.collection('reminders').where({ gameId, sent: false, key: 'd0' }).update({
      data: { sent: true, opened: true }
    })
  } catch (e) { /* 忽略 */ }

  return { code: 0, data: { status: 'ongoing', verified, verifyExpired: !verified, ...openCourtPush } }
}

/* ===================== 发起人调整总人数（事务） ===================== */
// 约束：新总人数不能低于已占用人数（自留 + 已报名），避免把已报名的球友挤掉
async function doAdjustTotal(event) {
  const openid = getOpenid()
  if (!openid) return fail(403, '无法获取用户身份，请重新进入小程序')
  const gameId = String(event.gameId || '')
  if (!gameId) return fail(400, '参数错误')
  const total = Number(event.total)
  if (!Number.isInteger(total) || total < 2 || total > 99) return fail(400, '总人数需在 2-99 之间')

  const transaction = await db.startTransaction()
  try {
    let game
    try {
      const r = await transaction.collection('games').doc(gameId).get()
      game = r.data
    } catch (e) {
      throw biz(401, '拼场不存在或已被删除')
    }
    if (!game) throw biz(401, '拼场不存在或已被删除')
    if (game.openid !== openid) throw biz(403, '仅发起人可以调整人数')
    if (game.status === 'canceled') throw biz(401, '该拼场已取消')
    if (game.status === 'ended') throw biz(409, '该场次已结束，无法调整人数')

    const reserve = game.reserve || 0
    const joined = game.joined || 0
    const occupied = reserve + joined
    if (total < occupied) {
      throw biz(409, `总人数不能低于已占用 ${occupied} 人（自留 ${reserve} + 已报名 ${joined}）`)
    }

    const remaining = total - occupied
    let status = game.status
    if (game.status === 'open' || game.status === 'full') {
      status = remaining <= 0 ? 'full' : 'open'
    }

    await transaction.collection('games').doc(gameId).update({ data: { total, status } })
    await transaction.commit()

    return { code: 0, data: { gameId, total, reserve, joined, remaining, status } }
  } catch (err) {
    try { await transaction.rollback() } catch (e) { /* ignore */ }
    throw err
  }
}

/* ===================== 订阅开场提醒（报名者 / 参与者均可，支持自定义） ===================== */
// 发起人发布时已写入自己的提醒；报名的球友 / 参与者可在此订阅提醒。
// 参与者可「沿用发起人的预设」，也可「自定义自己的提醒时间」：若前端传了合法的
// reminders 数组则以自定义的为准（replaceReminderDocs 覆盖旧的），否则沿用发起人设置。
// 到点由 remindTick 云函数推送订阅消息（需用户此前授权过订阅消息模板）。
async function doSubscribeReminder(event) {
  const openid = getOpenid()
  if (!openid) return fail(403, '无法获取用户身份，请重新进入小程序')
  const gameId = String(event.gameId || '')
  if (!gameId) return fail(400, '参数错误')

  let game
  try {
    const r = await db.collection('games').doc(gameId).get()
    game = r.data
  } catch (e) { /* ignore */ }
  if (!game) return fail(401, '拼场不存在或已被删除')
  if (game.status === 'canceled') return fail(401, '该拼场已取消')
  if (game.status === 'ended') return fail(409, '该场次已结束，无需设置提醒')

  // 参与者传了自定义提醒 → 以自定义为准（前端已做过去过滤，这里再归一化兜底）
  const custom = normalizeReminders(event)
  const base = Array.isArray(game.reminders) ? game.reminders : []
  if (custom.length) {
    await replaceReminderDocs(gameId, openid, custom)
    return { code: 0, data: { subscribed: custom.length, custom: true } }
  }
  if (!base.length) return fail(400, '本场未设置提醒，可点「自定义」添加你自己的提醒时间')
  await upsertReminderDocs(gameId, openid, base)
  return { code: 0, data: { subscribed: base.length, custom: false } }
}

/* ===================== 操作结果通知（报名成功 / 发布成功即时推送） ===================== */
// 在用户完成报名 / 发布后，向操作者本人推送一条服务通知。
// 前提是用户已在页面内通过 wx.requestSubscribeMessage 授权过该「一次性订阅」模板，
// 且本云函数 config.json 已声明 subscribeMessage.send 权限。模板留空时不推送（静默降级）。
async function doNotify(event) {
  const openid = getOpenid()
  if (!openid) return fail(403, '无法获取用户身份，请重新进入小程序')
  const tpl = JOIN_RESULT_TEMPLATE_ID || SOON_TEMPLATE_ID
  if (!tpl) return { code: 0, skipped: true }

  const title = String(event.title || '操作成功').trim().slice(0, 20) || '操作成功'
  const scene = String(event.scene || '').trim().slice(0, 20)
  const gameId = String(event.gameId || '')
  // 活动时间：前端传入「date startTime」；缺省时用当前时间
  const actTime = String(event.time || '').trim().slice(0, 30)

  // time2 格式化为 yyyy-MM-dd HH:mm
  const d = new Date()
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  const time2 = actTime || `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`

  try {
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId: tpl,
      page: gameId ? 'pages/detail/detail?id=' + gameId : 'pages/index/index',
      miniprogram_state: MP_STATE,
      lang: 'zh_CN',
      // 关键词按模板详情页顺序：报名结果通知为 thing1 报名结果 / time2 活动时间 / thing3 备注；
      // 回退「活动即将开始通知」时为 thing1 场地 / time2 活动时间 / thing3 温馨提示，字段名恰好一致。
      // 若推送报 47003，请到公众平台模板详情核对关键词编号/类型后调整字段名。
      data: {
        // 「报名结果通知」关键词：报名结果 phrase1 / 活动时间 time20 / 备注 thing5
        phrase1: { value: title },
        time20: { value: time2 },
        thing5: { value: scene || '查看详情' }
      }
    })
    return { code: 0, sent: true }
  } catch (e) {
    const info = pushErrInfo(e)
    console.warn('[courtApi] notify failed:', info.errCode, info.errMsg)
    return { code: 0, sent: false, errCode: info.errCode, errMsg: info.errMsg }
  }
}

/* ===================== 推送自检（定位「收不到消息」用） ===================== */
// 依次用 3 个模板给自己各发一条订阅消息，把每个模板的成功/失败与错误码直接回传前端，
// 免得只能翻云函数日志。用法：我的 → 「消息推送自检」。
// 注意：一次性订阅每次授权只能收 1 条，检测前前端会先走 wx.requestSubscribeMessage 授权。
async function doPushDiag() {
  const openid = getOpenid()
  if (!openid) return fail(403, '无法获取用户身份，请重新进入小程序')

  // 关键词结构分两类：三关键词模板（thing1/time2/thing3）与四关键词模板（thing1~thing4）
  const items = [
    { key: 'joinResult', name: '报名结果通知', id: JOIN_RESULT_TEMPLATE_ID, four: false },
    { key: 'soon', name: '活动即将开始通知', id: SOON_TEMPLATE_ID, four: false },
    { key: 'start', name: '活动开始通知', id: START_TEMPLATE_ID, four: true }
  ]

  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  const timeVal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`

  const results = []
  for (const it of items) {
    if (!it.id) {
      results.push({ ...it, sent: false, errCode: '', errMsg: '未配置该模板 ID' })
      continue
    }
    // 关键词名按各模板实际编号：
    //   报名结果通知: phrase1 / time20 / thing5
    //   活动即将开始通知: thing7 / time2 / thing3
    //   活动开始通知: character_string17 / thing4 / thing6 / thing7
    const data = it.four
      ? {
        // 活动开始通知。⚠️ character_string 类型只允许数字/字母/符号（≤5 字符），
        // 不能是汉字，否则 47003。thing ≤20 字可含汉字。
        character_string17: { value: '0min' },
        thing4: { value: '推送自检' },
        thing6: { value: '推送自检' },
        thing7: { value: '收到即链路正常' }
      }
      : it.key === 'joinResult'
        ? {
          phrase1: { value: '推送自检' },
          time20: { value: timeVal },
          thing5: { value: '收到即链路正常' }
        }
        : {
          thing7: { value: '推送自检' },
          time2: { value: timeVal },
          thing3: { value: '收到即链路正常' }
        }
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: openid,
        templateId: it.id,
        page: 'pages/mine/mine',
        miniprogram_state: MP_STATE,
        lang: 'zh_CN',
        data
      })
      results.push({ ...it, sent: true, errCode: '', errMsg: '' })
    } catch (e) {
      const info = pushErrInfo(e)
      // 把完整异常 + 发送的 data 一并写日志，方便在云函数日志里查真实原因
      const raw = e && (e.errMsg || e.message) || JSON.stringify(e)
      console.error('[courtApi] pushDiag failed:', it.key, info.errCode, raw, 'data=', JSON.stringify(data))
      results.push({ ...it, sent: false, errCode: info.errCode, errMsg: info.errMsg })
    }
  }

  return {
    code: 0,
    data: {
      openid: openid.slice(0, 6) + '***' + openid.slice(-4),
      mpState: MP_STATE,
      results
    }
  }
}

/* ===================== 报名名单（所有人可见） ===================== */
async function doEnrolls(event) {
  const openid = getOpenid()
  if (!openid) return fail(403, '无法获取用户身份，请重新进入小程序')
  const gameId = String(event.gameId || '')
  if (!gameId) return fail(400, '参数错误')

  let game
  try {
    const r = await db.collection('games').doc(gameId).get()
    game = r.data
  } catch (e) { /* ignore */ }
  if (!game) return fail(401, '拼场不存在或已被删除')

  const eRes = await db.collection('enrolls')
    .where({ gameId })
    .orderBy('createdAt', 'asc')
    .limit(500)
    .get()

  const list = (eRes.data || []).map((e) => ({
    nickName: e.nickName || '球友',
    level: e.level || 0,
    createdAt: e.createdAt,
    openid: e.openid || ''
  }))
  const avatarMap = await avatarsByOpenids(list.map((e) => e.openid).filter(Boolean))
  return {
    code: 0,
    data: list.map((e) => ({
      nickName: e.nickName,
      level: e.level,
      createdAt: e.createdAt,
      avatar: avatarMap[e.openid] || ''
    }))
  }
}

/* ===================== 时间工具与场次阶段 ===================== */
// 北京时间 yyyy-MM-dd + HH:mm → 真实 UTC 时间戳(ms)
// 云函数运行环境为 UTC，Date.UTC(...) 得到的是「把该时间当 UTC」的时刻，需减去 8 小时
function beijingTs(dateStr, timeStr) {
  const dp = String(dateStr || '').split('-').map(Number)
  const tp = String(timeStr || '00:00').split(':').map(Number)
  const y = dp[0]; const mo = dp[1]; const d = dp[2]
  if (!y || !mo || !d) return 0
  return Date.UTC(y, mo - 1, d, tp[0] || 0, tp[1] || 0) - 8 * 3600 * 1000
}

// 场次阶段：
//   canceled 已取消 | ended 已结束（灰）| ending 即将结束（红，距结束 <20 分钟）
//   ongoing 正在进行 | full 已拼满 | upcoming 招募中
function computePhase(g, remaining) {
  if (g.status === 'canceled') return 'canceled'
  if (g.status === 'ended') return 'ended' // 到点自动结束（remindTick 定时任务置为 ended）
  const startTs = beijingTs(g.date, g.startTime)
  const endTs = beijingTs(g.date, g.endTime)
  const now = Date.now()
  // 已过结束时间一律按「已结束」：status 可能仍停留在 ongoing（开启球场后 remindTick
  // 未及翻转 / 定时任务未运行），此时大厅/我的/详情也不能再显示「正在进行」
  if (endTs && now >= endTs) return 'ended'
  if (g.status === 'ongoing') return 'ongoing' // 手动开启球场
  if (!startTs || !endTs) return remaining > 0 ? 'upcoming' : 'full'
  if (now >= startTs) return endTs - now <= 20 * 60 * 1000 ? 'ending' : 'ongoing'
  return remaining > 0 ? 'upcoming' : 'full'
}

/* ===================== 装饰：计算剩余名额等 ===================== */
function decorateGame(g, openid, isJoined) {
  const total = g.total || 0
  const reserve = g.reserve || 0
  const joined = g.joined || 0
  const remaining = Math.max(0, total - reserve - joined)
  const filled = total - remaining
  const phase = computePhase(g, remaining)
  const isOwner = !!g.openid && g.openid === openid
  // 预约凭证：仅发起人与已报名球友可见，非参与者直接不下发（数据层防泄露）
  const canSeeCover = isOwner || !!isJoined
  return {
    _id: g._id,
    venue: g.venue,
    location: g.location || '',
    category: g.category,
    date: g.date,
    startTime: g.startTime,
    endTime: g.endTime,
    note: g.note || '',
    level: g.level || 0,
    total,
    reserve,
    joined,
    remaining,
    filled,
    percent: total ? Math.min(100, Math.round((filled * 100) / total)) : 0,
    // 场地核销：整场只核销一次（针对场地，不针对个人）
    verified: !!g.verified,
    verifyRemark: g.verifyRemark || '',
    publisherName: g.publisherName || '球友',
    // 预约凭证：仅发起人与已报名球友可见；coverUrl 由 detail 动作换取临时链接
    coverFileID: canSeeCover ? (g.coverFileID || '') : '',
    coverUrl: '',
    // 开场提醒：发起人设置的提醒列表，前端据此展示与引导订阅
    reminders: Array.isArray(g.reminders) ? g.reminders : [],
    reminderCount: Array.isArray(g.reminders) ? g.reminders.length : 0,
    status: g.status,
    phase,
    isOwner,
    isJoined: !!isJoined,
    canJoin: !!g.openid && g.openid !== openid && g.status !== 'canceled' &&
      remaining > 0 && ['upcoming', 'ongoing', 'ending'].indexOf(phase) > -1,
    createdAt: g.createdAt
  }
}
