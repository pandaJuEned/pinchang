/**
 * remindTick —— 开场提醒定时推送云函数
 *
 * 触发方式：云开发「定时触发器」（见 config.json，默认每分钟执行一次）。
 * 作用：1) 到点自动结束：结束时间（date + endTime）一过的场次自动置为 status='ended'；
 *       2) 扫描 reminders 集合中「已到期（sendAt <= 当前）且未发送」的提醒，
 *          通过订阅消息（subscribeMessage.send）推送给对应 openid；
 *       3) 开场后长时间无人开启球场 → 向全体参与者推送提醒。
 *
 * 依赖：
 *   1. 微信公众平台 → 订阅消息 中申请「一次性订阅」模板，把模板 ID 填到下方
 *      SOON_TEMPLATE_ID（活动即将开始通知）/ START_TEMPLATE_ID（活动开始通知），
 *      需与前端 utils/config.js 的 soonTemplateId / startTemplateId 保持一致。
 *   2. 用户在小程序内通过 wx.requestSubscribeMessage 授权过该模板（发布/报名时引导）。
 *   3. 本目录下必须有 package.json（依赖 wx-server-sdk），否则云端安装依赖失败，
 *      函数运行会报 Cannot find module 'wx-server-sdk'。
 *   4. 修改 config.json 后需重新「上传触发器」才会生效。
 *
 * 集合 reminders 文档结构（由 courtApi 写入）：
 *   { _id, gameId, openid, key, label, sendAt, sent, createdAt }
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// ⚠️ 模板 ID 需与前端 utils/config.js 保持一致（公众平台 → 订阅消息 → 我的模板）
// ② 活动即将开始通知（关键词：场地 / 活动时间 / 温馨提示）—— 开场前提醒（提前 N 分钟/小时/天）
const SOON_TEMPLATE_ID = 'Zaw4DdByL0g_jEJ0U11kuI-LamcWIm-zcV5xXs7pfN4'
// ③ 活动开始通知（关键词：距离开始时间 / 活动名称 / 活动地点 / 温馨提示）—— 开场时刻提醒
const START_TEMPLATE_ID = 'EjdpIf9omE1ns1Bi3iOqHcgh4BBdJQEF9pV9-X0wmKQ'

// 点击消息后跳转的小程序版本：developer=开发版 trial=体验版 formal=正式版
// ⚠️ 设为 developer / trial 时只有开发者、体验者能收到消息，普通用户一条都收不到。
//    这是「到点收不到提醒」最常见的原因，务必保持 formal（接口默认值）。
const MP_STATE = 'formal'

// 过期阈值：提醒时刻已过去超过该时长就不再补发（避免一次性推送一堆历史提醒）
const STALE_MS = 2 * 60 * 60 * 1000

// 开场后多少分钟仍无人「开启球场并登记核销」→ 向全体参与者推送提醒
const OPEN_REMIND_AFTER_MIN = 5
// 超时未开启提醒的最长有效期：到开场后该时长仍未处理就不再补推（避免拖很久后集中轰炸）
const OPEN_REMIND_STALE_MS = 60 * 60 * 1000

// 北京时间 yyyy-MM-dd
function chinaDate(offsetDays) {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  d.setDate(d.getDate() + (offsetDays || 0))
  return d.toISOString().slice(0, 10)
}

// 北京时间 yyyy-MM-dd + HH:mm → 真实 UTC 时间戳(ms)
function beijingTs(dateStr, timeStr) {
  const dp = String(dateStr || '').split('-').map(Number)
  const tp = String(timeStr || '00:00').split(':').map(Number)
  const y = dp[0]; const mo = dp[1]; const d = dp[2]
  if (!y || !mo || !d) return 0
  return Date.UTC(y, mo - 1, d, tp[0] || 0, tp[1] || 0) - 8 * 3600 * 1000
}

// 常见错误码 → 人话，便于在云函数日志里一眼定位
const ERR_MAP = {
  43101: '用户未订阅/已拒收该模板（一次性订阅每次授权只能收 1 条，需在弹窗勾选「总是保持以上选择」）',
  40037: 'template_id 不正确（模板 ID 填错或模板不属于本小程序）',
  47003: '模板参数不准确（关键词字段名/类型/长度不符，thing 需 ≤20 字符）',
  40003: 'touser openid 为空或不正确',
  41030: 'page 路径不正确（页面需在 app.json 中已注册）',
  42003: '接口调用频率超限'
}

function explain(e) {
  const code = e && (e.errCode != null ? e.errCode : (e.errcode != null ? e.errcode : ''))
  const msg = String((e && (e.errMsg || e.message)) || e || '')
  const known = ERR_MAP[code]
  return { errCode: code || '', errMsg: known ? `${known}｜原始：${msg}` : msg }
}

// 集合不存在时自动创建（首次部署常见）
async function ensureCollection(name) {
  try {
    await db.createCollection(name)
    return true
  } catch (e) { return false }
}

async function markDone(id, extra) {
  try {
    await db.collection('reminders').doc(id).update({
      data: Object.assign({ sent: true, sentAt: db.serverDate() }, extra || {})
    })
  } catch (e) { /* 忽略 */ }
}

// 标记某拼场「超时未开启提醒」已处理（避免每分钟重复推送）
async function markOpenRemind(gameId, extra) {
  try {
    await db.collection('games').doc(gameId).update({
      data: Object.assign({ openRemindSent: true, openRemindAt: db.serverDate() }, extra || {})
    })
  } catch (e) { /* 忽略 */ }
}

// 取某拼场全部参与者 openid（发起人 + 已报名球友），去重
async function gameOpenids(gameId, extraOpenid) {
  const ids = []
  if (extraOpenid) ids.push(extraOpenid)
  try {
    const eRes = await db.collection('enrolls').where({ gameId }).limit(100).get()
    ;(eRes.data || []).forEach((e) => {
      if (e.openid && ids.indexOf(e.openid) === -1) ids.push(e.openid)
    })
  } catch (e) { /* 拿不到名单时只推发起人 */ }
  return ids
}

// 「超时未开启球场」提醒文案（复用「活动即将开始通知」模板：场地 / 活动时间 / 温馨提示）
function unopenedData(game) {
  const venue = String(game.venue || '球场').trim().slice(0, 20) || '球场'
  const tip = `开场已${OPEN_REMIND_AFTER_MIN}分钟，无人开启球场`.slice(0, 20)
  return {
    thing7: { value: venue },
    time2: { value: `${game.date || ''} ${game.startTime || '00:00'}`.trim() || '待定' },
    thing3: { value: tip }
  }
}

// 「活动即将开始通知」data：thing7 场地 / time2 活动时间 / thing3 温馨提示
function soonData(game, doc) {
  return {
    thing7: { value: String(game.venue || '球场').trim().slice(0, 20) || '球场' },
    time2: { value: `${game.date || ''} ${game.startTime || '00:00'}`.trim() || '待定' },
    thing3: { value: String(doc.label || '即将开始，请提前到场').trim().slice(0, 20) || '即将开始' }
  }
}

// 「活动开始通知」data：character_string17 距离开始时间（仅数字/字母/符号，不能是汉字）/
// thing4 活动名称 / thing6 活动地点 / thing7 温馨提示
function startData(game) {
  const venue = String(game.venue || '球场').trim().slice(0, 20) || '球场'
  const loc = String(game.location || '').trim()
  return {
    character_string17: { value: '0min' },
    thing4: { value: venue },
    thing6: { value: (venue + (loc ? ' ' + loc : '')).slice(0, 20) },
    thing7: { value: '请尽快到场开启球场' }
  }
}

exports.main = async (event) => {
  const trigger = (event && (event.Type || event.type)) || 'manual'
  const now = Date.now()

  // 1) 到点自动结束：结束时间一过的场次自动置为「已结束」（先跑，后续步骤基于最新状态）
  const autoEndRes = await autoEndGames(now)

  // 2) 常规开场提醒（到点推送订阅消息）
  const remindRes = await processReminders(now)

  // 3) 超时未开启：开场后 OPEN_REMIND_AFTER_MIN 分钟仍无人「开启球场并核销」→ 向全体参与者推送提醒
  const unopenedRes = await remindUnopened(now)

  console.log(`[remindTick][${trigger}] 自动结束: ${autoEndRes.ended} 场；提醒: 成功 ${remindRes.sent} 失败/跳过 ${remindRes.skipped}；超时未开启: 扫描 ${unopenedRes.scanned} 推送 ${unopenedRes.sent}`, JSON.stringify(unopenedRes.errors || []))
  return {
    code: 0,
    trigger,
    autoEnd: autoEndRes,
    reminder: remindRes,
    unopened: unopenedRes
  }
}

// 到点自动结束：结束时间（北京时间 date + endTime）一过，自动把场次状态置为「已结束」。
// 覆盖三种遗留状态：招募中(open) / 已拼满(full) / 进行中(ongoing，开启球场后没人关单)。
// 置为 ended 后：hall 不再展示、detail/mine 显示「已结束」，courtApi 拦截报名/开启/核销等操作。
// 清理策略：每轮定时（每分钟）把全部已超时场次清完——今天/昨天一批 + 更早日期分批循环，
// 单轮最多约 300 条（云函数 20s 超时保护）；历史积压量大时几分钟内自动收敛，
// 也可在云开发控制台手动「云端测试」运行一次本函数，立即清完。
async function autoEndGames(now) {
  const errors = []
  let scanned = 0
  let ended = 0

  const sweep = async (where, limit) => {
    let list = []
    try {
      const res = await db.collection('games').where(where).limit(limit).get()
      list = res.data || []
    } catch (e) {
      errors.push({ err: String((e && (e.errMsg || e.message)) || e) })
      return
    }
    for (const g of list) {
      const endTs = beijingTs(g.date, g.endTime)
      // 还没到结束时间，或时间字段异常 → 跳过
      if (!endTs || now < endTs) continue
      scanned++
      try {
        await db.collection('games').doc(g._id).update({
          data: { status: 'ended', endedAt: db.serverDate(), endedFrom: g.status }
        })
        ended++
      } catch (e) {
        errors.push({ gameId: g._id, err: String((e && (e.errMsg || e.message)) || e) })
      }
    }
  }

  // 今天 + 昨天的场次（每分钟兜底，防跨天遗漏）
  await sweep({ date: _.in([chinaDate(0), chinaDate(-1)]), status: _.in(['open', 'full', 'ongoing']) }, 100)

  // 更早日期仍处于未结束状态的历史遗留场次：分批循环清完（date < 昨天的一定已超时）。
  // 每批 100 条、最多 2 批；某一批一条都没结束时说明已清完（或只剩更新失败的脏数据，下轮重试）
  for (let i = 0; i < 2; i++) {
    const before = ended
    await sweep({ date: _.lt(chinaDate(-1)), status: _.in(['open', 'full', 'ongoing']) }, 100)
    if (ended === before) break
  }

  return { scanned, ended, errors }
}

// 处理常规开场提醒（到点推送订阅消息）
async function processReminders(now) {
  const errors = []
  let list = []

  try {
    const res = await db.collection('reminders')
      .where({ sent: false, sendAt: _.lte(now) })
      .limit(100)
      .get()
    list = res.data || []
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || e)
    // 集合还没建（例如从未发布过带提醒的拼场）→ 建一次，下一分钟自动正常
    if (msg.indexOf('collection not exists') >= 0 || msg.indexOf('-501001') >= 0) {
      const created = await ensureCollection('reminders')
      return { code: -1, processed: 0, sent: 0, skipped: 0, err: `reminders 集合不存在，已尝试创建：${created}` }
    }
    console.error('[remindTick] query failed:', msg)
    return { code: -1, processed: 0, sent: 0, skipped: 0, err: msg }
  }

  if (!list.length) return { code: 0, processed: 0, sent: 0, skipped: 0 }

  if (!SOON_TEMPLATE_ID && !START_TEMPLATE_ID) {
    console.error('[remindTick] 未配置任何模板 ID（SOON_TEMPLATE_ID / START_TEMPLATE_ID），无法推送')
    return { code: -2, processed: list.length, sent: 0, skipped: list.length, err: '未配置模板 ID' }
  }

  let sent = 0
  let skipped = 0

  for (const doc of list) {
    // 过期太久的提醒直接丢弃，不再补发
    if (doc.sendAt && now - doc.sendAt > STALE_MS) {
      await markDone(doc._id, { stale: true })
      skipped++
      errors.push({ _id: doc._id, openid: doc.openid, errCode: 'stale', errMsg: '提醒已过期超过 2 小时，未补发' })
      continue
    }

    // 取拼场，校验是否仍可推送（不存在 / 已取消的不再推送）
    let game = null
    try {
      const r = await db.collection('games').doc(doc.gameId).get()
      game = r.data
    } catch (e) { game = null }

    if (!game) {
      await markDone(doc._id, { missed: 'game' })
      skipped++
      errors.push({ _id: doc._id, openid: doc.openid, errCode: 'nogame', errMsg: '拼场不存在' })
      continue
    }
    // 已取消 / 已自动结束的场次不再推送任何提醒
    if (game.status === 'canceled' || game.status === 'ended') {
      await markDone(doc._id, game.status === 'canceled' ? { canceled: true } : { gameEnded: true })
      skipped++
      continue
    }
    // 已手动开启球场：开场时(d0)的提醒不再推送（避免与「开启球场」推送重复）
    if (game.status === 'ongoing' && doc.key === 'd0') {
      await markDone(doc._id, { opened: true })
      skipped++
      continue
    }

    // 按提前分钟数选模板：开场时刻（offsetMin=0）用「活动开始通知」，其余用「活动即将开始通知」。
    // 旧提醒文档没有 offsetMin 字段时，按 key 兜底（d0 = 开场时）。
    const off = Number(doc.offsetMin)
    const isStart = off === 0 || (!Number.isFinite(off) && doc.key === 'd0')
    const templateId = isStart ? START_TEMPLATE_ID : SOON_TEMPLATE_ID
    if (!templateId) {
      await markDone(doc._id, { failed: 'notpl' })
      skipped++
      errors.push({
        _id: doc._id,
        openid: doc.openid,
        errCode: 'notpl',
        errMsg: isStart ? '未配置 START_TEMPLATE_ID（活动开始通知）' : '未配置 SOON_TEMPLATE_ID（活动即将开始通知）'
      })
      continue
    }

    try {
      await cloud.openapi.subscribeMessage.send({
        touser: doc.openid,
        templateId,
        page: 'pages/detail/detail?id=' + doc.gameId,
        miniprogram_state: MP_STATE,
        lang: 'zh_CN',
        // 关键词编号按模板详情页顺序：thing1/time2/...。若推送报 47003，
        // 请到公众平台模板详情核对每个关键词的编号与类型，对应调整字段名。
        data: isStart ? startData(game) : soonData(game, doc)
      })
      sent++
      await markDone(doc._id)
    } catch (e) {
      const info = explain(e)
      skipped++
      errors.push({ _id: doc._id, openid: doc.openid, key: doc.key, errCode: info.errCode, errMsg: info.errMsg })
      await markDone(doc._id, { failed: info.errCode || 1 })
    }
  }

  return { code: 0, processed: list.length, sent, skipped, errors }
}

// 超时未开启：开场后 OPEN_REMIND_AFTER_MIN 分钟仍无人「开启球场并核销」→ 向全体参与者推送提醒
async function remindUnopened(now) {
  const errors = []
  let scanned = 0
  let sent = 0

  // 只看今天与昨天的场次（开场后超 5 分钟还没开的，多半落在今天；兜底昨天防跨天）
  const dates = [chinaDate(0), chinaDate(-1)]
  let list = []
  try {
    const res = await db.collection('games')
      .where({ date: _.in(dates), status: _.in(['open', 'full']) })
      .limit(100)
      .get()
    list = res.data || []
  } catch (e) {
    console.error('[remindTick] unopened query failed:', String((e && (e.errMsg || e.message)) || e))
    return { scanned: 0, sent: 0, err: String((e && (e.errMsg || e.message)) || e) }
  }

  for (const g of list) {
    // 已有人开启 / 已标记提醒过 → 跳过
    if (g.openRemindSent) continue
    const startTs = beijingTs(g.date, g.startTime)
    if (!startTs) continue
    // 已经结束（过 endTime）的场次不再提醒
    const endTs = beijingTs(g.date, g.endTime)
    if (endTs && now >= endTs) {
      await markOpenRemind(g._id, { openRemindExpired: true })
      continue
    }
    const dueAt = startTs + OPEN_REMIND_AFTER_MIN * 60000
    // 还没到「开场后 5 分钟」或已经失效很久（避免拖很久后集中补推）
    if (now < dueAt) continue
    if (now - dueAt > OPEN_REMIND_STALE_MS) {
      await markOpenRemind(g._id, { openRemindExpired: true })
      continue
    }
    scanned++
    // 先标记再推送：即便推送失败也只提醒一次，避免每分钟重复轰炸
    await markOpenRemind(g._id)
    const openids = await gameOpenids(g._id, g.openid)
    const templateId = SOON_TEMPLATE_ID || START_TEMPLATE_ID
    if (!templateId) {
      errors.push({ gameId: g._id, errCode: 'notpl', errMsg: '未配置任何提醒模板' })
      continue
    }
    let pushed = 0
    for (const touser of openids) {
      try {
        await cloud.openapi.subscribeMessage.send({
          touser,
          templateId,
          page: 'pages/detail/detail?id=' + g._id,
          miniprogram_state: MP_STATE,
          lang: 'zh_CN',
          data: templateId === START_TEMPLATE_ID ? startData(g) : unopenedData(g)
        })
        pushed++
      } catch (e) {
        const info = explain(e)
        errors.push({ gameId: g._id, openid: touser, errCode: info.errCode, errMsg: info.errMsg })
      }
    }
    sent += pushed
  }

  return { scanned, sent, errors }
}
