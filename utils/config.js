// 云开发配置
module.exports = {
  // ⚠️ 请填入你的云开发环境 ID（微信开发者工具 → 云开发控制台 → 设置 → 环境 ID），例如 'cloud1-xxxxxx'
  // 留空 '' 时使用「默认环境」（当前账号仅一个环境时通常可直接使用）
  // 注意：不要带前后空格，否则会报 INVALID_ENV；请以云开发控制台「环境 ID」为准复制
  envId: 'cloudbase-d9gzpm26b441f5f08',

  // 云存储上的静态资源（替代本地 assets，避免代码包超过 200K）
  cloudAssets: {
    // 中羽等级科普大图
    // 在微信开发者工具 → 云开发 → 存储 → 上传 assets/level-guide.jpg
    // 然后右键文件 →「复制文件 URL」，粘贴到下面引号内
    // 支持 cloud:// 协议链接，也支持 https:// 临时下载链接
    levelGuide: 'cloud://cloudbase-d9gzpm26b441f5f08.636c-cloudbase-d9gzpm26b441f5f08-1300913513/level-guide.jpg'
  },

  // ===================== 订阅消息模板（共 3 个，与公众平台「我的模板」一一对应） =====================
  // 获取模板 ID：微信公众平台 → 功能 → 订阅消息 → 我的模板 → 点开模板详情 → 复制「模板 ID」。
  // 详情页同时能看到每个关键词的编号（thing1/time2/...）与类型，云函数 data 字段名需与之对应。
  // 某个模板留空 '' 时对应推送自动降级，不影响发布/报名主流程。

  // ① 报名结果通知 —— 关键词：报名结果 / 活动时间 / 备注
  //    用于「发布成功 / 保存成功 / 报名成功」即时服务通知（courtApi 的 doNotify）
  joinResultTemplateId: 'rDsEAyzX05yPYx5YceH68RPpT1VbhJeKzH16rywJA-g',

  // ② 活动即将开始通知 —— 关键词：场地 / 活动时间 / 温馨提示
  //    用于开场前提醒（提前 1 天 / 3 小时 / 1 小时 / 30 分钟），由 remindTick 定时推送
  //    ⚠️ 下面是旧开场提醒模板的 ID：若它不是「活动即将开始通知」的 ID（模板删除重建后 ID 会变），请替换
  soonTemplateId: 'Zaw4DdByL0g_jEJ0U11kuI-LamcWIm-zcV5xXs7pfN4',

  // ③ 活动开始通知 —— 关键词：距离开始时间 / 活动名称 / 活动地点 / 温馨提示
  //    用于「开场时（开启球场）」提醒，由 remindTick 定时推送
  startTemplateId: 'EjdpIf9omE1ns1Bi3iOqHcgh4BBdJQEF9pV9-X0wmKQ',

  // 提醒预设：用户在发布时勾选，支持多个。offsetMin = 距开场时间的提前分钟数
  // （0 表示开场时刻，对应「开启球场」提醒）。label 用于 UI 与推送文案。
  reminderPresets: {
    d1: { label: '开场前 1 天', offsetMin: 1440 },
    h3: { label: '开场前 3 小时', offsetMin: 180 },
    h1: { label: '开场前 1 小时', offsetMin: 60 },
    m30: { label: '开场前 30 分钟', offsetMin: 30 },
    d0: { label: '开场时（开启球场并核销）', offsetMin: 0 }
  },
  // 发布时默认勾选的提醒
  defaultReminderKeys: ['h1', 'd0'],

  // ===================== 「开启球场 + 场地核销」时间窗 =====================
  // 两者合并为一个操作：到场后点一次即「开启球场并登记核销」。
  // 开场前 checkinBeforeMin 分钟起允许操作；核销一直有效到「场次结束时间」——
  // 整个时间段（含打到一半出去核销）都可核销，结束时间之后失效
  // （失效后仍可开启球场，但不再登记核销）。
  checkinBeforeMin: 15,

  // ===================== 取消报名截止（分钟） =====================
  // 开场前 cancelJoinBeforeMin 分钟内锁定名额，不可再取消报名（让出名额须提前安排）。
  // 需与 cloudfunctions/courtApi/index.js 的 CANCEL_BEFORE_MIN 保持一致。
  cancelJoinBeforeMin: 15,

  // 开场后 openRemindAfterMin 分钟仍无人点击「开启球场并核销」→ 向全体参与者推送提醒
  // （由 remindTick 定时扫描并推送）。
  openRemindAfterMin: 5
}
