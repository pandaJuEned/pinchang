# Court Buddy（拼场）

一个基于 **微信小程序 + 云开发** 的运动拼场平台：发布拼场、报名抢位、开场提醒、到场核销，一站式解决「约球凑不齐人」的问题。

支持 6 类运动：🏀 篮球 / 🎾 网球 / ⚽ 足球 / 🏸 羽毛球 / 🏓 乒乓球 / 🏐 排球。

## 功能特性

- **拼场大厅**：浏览未拼满的未来场次，按运动分类筛选
- **发布拼场（发场）**：设置场地、时间、人数、自留名额、备注，支持 OCR 识别预约截图（可选）
- **报名抢位**：数据库事务防超卖，并发报名也不会超出名额
- **开场提醒**：订阅消息推送，开场前 1 天 / 3 小时 / 1 小时 / 30 分钟 / 开场时多档可选
- **开启球场 + 核销**：到场后一键开启并登记核销（开场前 15 分钟起可操作）
- **中羽等级**：羽毛球 1-9 级等级体系，报名时自动快照
- **我的拼场 / 历史**：管理我发布的与我报名的场次
- **防绕过设计**：未登录的 openid 直接调云函数会被拦截（code 418）

## 技术栈

| 部分 | 技术 |
| --- | --- |
| 前端 | 微信小程序原生框架（自定义 TabBar、Skyline 兼容） |
| 后端 | 微信云开发（云函数 + 云数据库 + 云存储） |
| 定时任务 | remindTick（每分钟触发，负责提醒与自动结束场次） |
| OCR | 百度智能云（免费）→ 腾讯云 → ocr.space 三级降级 |

## 项目结构

```
├── app.js / app.json / app.wxss     # 小程序入口与全局配置
├── pages/
│   ├── index/      # 大厅（首页）
│   ├── history/    # 历史
│   ├── publish/    # 发场（发布拼场）
│   ├── mine/       # 我的
│   └── detail/     # 拼场详情（报名名单、开启球场、提醒设置）
├── components/
│   ├── level-modal/    # 中羽等级选择
│   ├── level-viewer/   # 等级科普查看器
│   └── login-modal/    # 微信登录引导
├── custom-tab-bar/     # 自定义底部导航
├── utils/
│   ├── api.js          # 云函数调用封装
│   ├── config.js       # 云环境 ID、订阅消息模板 ID、提醒预设等
│   ├── categories.js   # 运动分类定义
│   ├── levels.js       # 中羽等级定义
│   ├── reminder.js     # 提醒相关工具
│   └── util.js
└── cloudfunctions/
    ├── courtApi/    # 核心业务：登录/发布/报名/取消/查询（事务防超卖）
    ├── ocrParse/    # OCR 识别（密钥在 keys.js，不入库）
    └── remindTick/  # 定时提醒 + 场次自动结束（timer 触发器）
```

## 快速上手（新成员必读）

### 1. 环境准备

1. 下载安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. 克隆仓库：

```bash
git clone https://github.com/pandaJuEned/pinchang.git
```

3. 用微信开发者工具「导入项目」，选择本目录（AppID 已在 `project.config.json` 中配置，如无权限请换成自己测试号）

### 2. 开通云开发

1. 工具栏点击「云开发」→ 开通并创建环境
2. 把你的**环境 ID** 填入 `utils/config.js` 的 `envId`

### 3. 创建密钥文件（不入库）

`cloudfunctions/ocrParse/keys.js` 因含密钥被 `.gitignore` 忽略，克隆后需自行创建：

```bash
# 在 cloudfunctions/ocrParse/ 下新建 keys.js
```

```js
module.exports = {
  BAIDU_API_KEY: '',      // 百度智能云 OCR（免费，https://cloud.baidu.com）
  BAIDU_SECRET_KEY: '',
  OCR_SECRET_ID: '',      // 腾讯云 OCR（可选）
  OCR_SECRET_KEY: '',
  OCR_SPACE_API_KEY: ''   // ocr.space（可选）
}
```

> OCR 功能为可选增强，全部留空不影响核心拼场流程。

### 4. 部署云函数

在开发者工具中，对 `cloudfunctions` 下的每个函数目录**右键 → 上传并部署（云端安装依赖）**：

- `courtApi`
- `remindTick`（部署后检查定时触发器已启用）
- `ocrParse`

### 5. 配置订阅消息（如需提醒功能）

微信公众平台 → 订阅消息，申请 3 个模板并把模板 ID 填入 `utils/config.js`：

1. 报名结果通知
2. 活动即将开始通知
3. 活动开始通知

模板 ID 留空时对应推送自动降级，不影响主流程。

## 数据集合

云数据库自动创建，无需手动配置权限（云函数具备管理员读写能力）：

| 集合 | 说明 |
| --- | --- |
| `users` | 微信登录用户（`_id` = openid，含中羽等级） |
| `games` | 拼场活动（场地/时间/人数/状态等） |
| `enrolls` | 报名记录（含报名时等级快照） |

## 开发约定

- **敏感信息不入库**：`keys.js`、`project.private.config.json`、`.cloudbase/` 均已在 `.gitignore` 中忽略，请勿强行添加
- `utils/config.js` 与 `cloudfunctions/courtApi/index.js` 中的时间窗常量（核销窗口、取消截止）需保持一致
- 提交前请确保小程序端 + 云函数均能正常编译部署，建议一个功能一个 commit

## 许可证

仅供学习交流使用。
