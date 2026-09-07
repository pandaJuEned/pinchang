/**
 * ocrParse —— 上传的球场预约订单截图自动识别
 *
 * 流程：
 *   1. 通过 fileID 从云存储下载截图
 *   2. 自动降级链调用 OCR：百度OCR(免费) → 腾讯云OCR(付费备选) → ocr.space(免费 25,000次/月)
 *      前一通道失败(额度/权限/网络等)自动切换下一通道，全部失败才汇总报错
 *   3. 对 OCR 文本进行结构化解析，提取：场馆名称 / 场次位置 / 日期 / 开始·结束时间
 *      （场次位置 = 预约场次下、日期与时间之间的场地信息，如「3号场」「A区」）
 *
 * 🔑 密钥来源（环境变量优先，其次本目录 keys.js）：
 *   ① 百度（默认优先，免费）：BAIDU_API_KEY + BAIDU_SECRET_KEY
 *   ② 腾讯云（付费备选）：OCR_SECRET_ID + OCR_SECRET_KEY
 *   ③ ocr.space（免费 25,000 次/月，推荐注册）：OCR_SPACE_API_KEY  注册：https://ocr.space/ocrapi
 *   方式一：直接在本目录 keys.js 里填好（随云函数一起部署，开箱即用）
 *   方式二（更推荐）：右键 ocrParse → 配置 → 新增同名环境变量覆盖
 *
 * 可选：OCR_PROVIDER=baidu|tencent|ocrspace 可强制只走某一通道；
 *      留空时按「已配置且可用」的通道自动降级。
 *
 * 动作：默认识别截图；event.action === 'preflight' 时返回密钥配置状态
 *
 * 返回 code：
 *   0  识别成功（data 含结构化字段）/ preflight 探测成功
 *   100 OCR 服务未配置任何密钥（可手动填写后发布）
 *   101 OCR 调用失败（密钥错误/图片不清晰/限流/全部通道失败等）
 *   102 OCR 密钥权限不足（未授予 QcloudOCRFullAccess）
 */
const cloud = require('wx-server-sdk')
const https = require('https')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const OCR_HOST = 'ocr.tencentcloudapi.com'
const OCR_SERVICE = 'ocr'
const OCR_VERSION = '2018-11-19'
// 腾讯云 OCR「通用印刷体识别」正确 Action 为 GeneralBasicOCR（DescribeGeneralBasicOCR 不存在）
const OCR_ACTION = 'GeneralBasicOCR'
const OCR_REGION = process.env.OCR_REGION || 'ap-guangzhou'

const BAIDU_OCR_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic'
const BAIDU_TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token'

const OCR_SPACE_URL = 'https://api.ocr.space/parse/image'

/* ---- 密钥解析：环境变量优先，其次本目录 keys.js（随云函数部署的本地兜底） ---- */
let BAIDU_API_KEY = process.env.BAIDU_API_KEY || ''
let BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY || ''
let OCR_SECRET_ID = process.env.OCR_SECRET_ID || '' // 腾讯云
let OCR_SECRET_KEY = process.env.OCR_SECRET_KEY || ''
let OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY || '' // ocr.space
try {
  const localKeys = require('./keys.js') || {}
  if (!BAIDU_API_KEY) BAIDU_API_KEY = localKeys.BAIDU_API_KEY || ''
  if (!BAIDU_SECRET_KEY) BAIDU_SECRET_KEY = localKeys.BAIDU_SECRET_KEY || ''
  if (!OCR_SECRET_ID) OCR_SECRET_ID = localKeys.OCR_SECRET_ID || ''
  if (!OCR_SECRET_KEY) OCR_SECRET_KEY = localKeys.OCR_SECRET_KEY || ''
  if (!OCR_SPACE_API_KEY) OCR_SPACE_API_KEY = localKeys.OCR_SPACE_API_KEY || ''
} catch (e) {
  // 目录内无 keys.js 时忽略，仅使用环境变量
}

// 各通道是否配置了有效密钥（自动降级链只加入已配置的通道）
function baiduEnabled() { return !!(BAIDU_API_KEY && BAIDU_SECRET_KEY) }
function tencentEnabled() { return !!(OCR_SECRET_ID && OCR_SECRET_KEY) }
function ocrSpaceEnabled() { return !!OCR_SPACE_API_KEY }

// OCR_PROVIDER 可强制指定单通道：baidu | tencent | ocrspace；留空 = 自动降级
function getProvider() {
  const p = String(process.env.OCR_PROVIDER || '').toLowerCase()
  if (p === 'baidu' || p === 'tencent' || p === 'ocrspace') return p
  return 'auto'
}

// 自动降级链顺序：百度(免费) → 腾讯云(付费备选) → ocr.space(免费)；仅包含已配置通道
function providerChain() {
  const forced = getProvider()
  if (forced !== 'auto') return [forced]
  const chain = []
  if (baiduEnabled()) chain.push('baidu')
  if (tencentEnabled()) chain.push('tencent')
  if (ocrSpaceEnabled()) chain.push('ocrspace')
  return chain
}

/* ---- 通用 https 请求 ---- */
function httpGetString(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', reject)
  })
}

function httpPostString(url, body, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/* ---- 百度 OCR（免费额度）：OAuth access_token + POST ---- */
let _baiduToken = ''
let _baiduTokenExpiry = 0

async function getBaiduToken() {
  const now = Date.now()
  if (_baiduToken && _baiduTokenExpiry > now) return _baiduToken
  const apiKey = BAIDU_API_KEY
  const secretKey = BAIDU_SECRET_KEY
  if (!apiKey || !secretKey) {
    const err = new Error('BAIDU_API_KEY / BAIDU_SECRET_KEY not configured')
    err.code = 'NOT_CONFIGURED'
    err.provider = 'baidu'
    throw err
  }
  const url = `${BAIDU_TOKEN_URL}?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`
  const json = JSON.parse(await httpGetString(url))
  if (json.access_token) {
    _baiduToken = json.access_token
    _baiduTokenExpiry = now + ((json.expires_in || 2592000) - 300) * 1000
    return _baiduToken
  }
  const err = new Error(json.error_description || json.error || '百度 OCR 鉴权失败')
  err.code = 'BAIDU_AUTH'
  err.provider = 'baidu'
  throw err
}

function requestBaiduOcr(imageBase64) {
  return getBaiduToken()
    .then((token) => {
      const body = 'image=' + encodeURIComponent(imageBase64)
      return httpPostString(`${BAIDU_OCR_URL}?access_token=${encodeURIComponent(token)}`, body, 'application/x-www-form-urlencoded')
    })
    .then((text) => {
      const json = JSON.parse(text)
      if (json.error_code) {
        const err = new Error(json.error_msg || '百度 OCR 调用失败')
        err.code = String(json.error_code)
        err.provider = 'baidu'
        err.baidu = true
        throw err
      }
      return (json.words_result || []).map((w) => w.words).filter(Boolean).join('\n')
    })
}

/* ---- 自动降级调度：依次尝试各通道，成功即返回；全部失败则汇总各通道原因 ---- */
const PROVIDER_NAMES = { baidu: '百度OCR', tencent: '腾讯云OCR', ocrspace: 'ocr.space' }

function runProvider(name, imageBase64) {
  if (name === 'baidu') return requestBaiduOcr(imageBase64)
  if (name === 'tencent') return requestTencentOcr(imageBase64)
  if (name === 'ocrspace') return requestOcrSpace(imageBase64)
  const err = new Error('未知 OCR 通道: ' + name)
  err.code = 'UNKNOWN_PROVIDER'
  throw err
}

// 单个通道失败的简短原因（用于汇总提示）
function shortFailReason(name, err) {
  const code = String((err && err.code) || '')
  const msg = String((err && err.message) || '').slice(0, 40)
  if (name === 'baidu') {
    if (code === 'NOT_CONFIGURED') return '未配置密钥'
    if (code === '17' || code === '19' || code === '282004' || code === '282005') return '免费额度已用尽'
    if (code === '18') return '请求过于频繁'
    if (code === '110' || code === '111' || code === 'BAIDU_AUTH') return '密钥错误'
    if (/216200|216201|216202|216630/.test(code)) return '无法识别该图片'
    return msg || '调用失败'
  }
  if (name === 'tencent') {
    if (code === 'NOT_CONFIGURED') return '未配置密钥'
    if (code === 'UnauthorizedOperation') return '密钥无权限'
    if (/AuthFailure|Signature|InvalidCredential/.test(code + '|' + msg)) return '密钥错误'
    if (/LimitExceeded/.test(code + '|' + msg)) return '触发限流'
    return msg || '调用失败'
  }
  if (name === 'ocrspace') {
    if (code === 'NOT_CONFIGURED') return '未配置密钥'
    if (code === 'OCRSPACE_KEY') return '密钥无效'
    if (code === 'OCRSPACE_QUOTA') return '当月额度/频率超限'
    if (code === 'OCRSPACE_IMAGE') return '无法识别该图片'
    return msg || '调用失败'
  }
  return msg || '调用失败'
}

// 统一识别入口：按降级链依次尝试，成功即返回文本
async function requestOcr(imageBase64) {
  const chain = providerChain()
  if (!chain.length) {
    const err = new Error('未配置任何 OCR 密钥')
    err.code = 'ALL_FAILED'
    err.chain = []
    throw err
  }
  const failures = []
  for (const name of chain) {
    try {
      const text = await runProvider(name, imageBase64)
      if (text && String(text).trim()) return text
      failures.push({ name, reason: '未识别出文字' })
    } catch (e) {
      failures.push({ name, reason: shortFailReason(name, e) })
    }
  }
  const err = new Error('所有 OCR 通道均失败')
  err.code = 'ALL_FAILED'
  err.chain = failures
  throw err
}

exports.main = async (event) => {
  // 前置检测：前端可在页面加载时调用，提前知晓 OCR 密钥是否已配置并给出提示
  if (event && event.action === 'preflight') return preflight()

  const fileID = event && event.fileID
  if (!fileID) return { code: 400, msg: '缺少截图文件' }

  // 1. 下载截图
  let buffer
  try {
    const res = await cloud.downloadFile({ fileID })
    buffer = res.fileContent
  } catch (e) {
    console.error('downloadFile error', e)
    return { code: 101, msg: '截图读取失败，请重新上传' }
  }
  if (!buffer || !buffer.length) return { code: 101, msg: '截图内容为空' }

  const imageBase64 = buffer.toString('base64')

  // 2. OCR
  let text
  try {
    text = await requestOcr(imageBase64)
  } catch (e) {
    // 把 OCR 各通道返回的原始错误翻译成可操作的中文提示
    const mapped = mapOcrError(e)
    console.error('ocr error: [' + ((e && e.code) || '') + ']', (e && e.message) || '')
    return { code: mapped.code, msg: mapped.msg }
  }

  // 3. 结构化解析
  const parsed = parseOrderText(text)

  return {
    code: 0,
    data: {
      venue: parsed.venue,
      location: parsed.location,
      date: parsed.date,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      sport: parsed.sport,
      raw: String(text).slice(0, 2000)
    }
  }
}

/* ==================== 腾讯云 OCR 调用（TC3 签名，备选通道） ==================== */
function requestTencentOcr(imageBase64) {
  const secretId = OCR_SECRET_ID || process.env.TENCENTCLOUD_SECRETID
  const secretKey = OCR_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY
  if (!secretId || !secretKey) {
    const err = new Error('OCR_SECRET_ID / OCR_SECRET_KEY not configured')
    err.code = 'NOT_CONFIGURED'
    err.provider = 'tencent'
    return Promise.reject(err)
  }
  const token = process.env.TENCENTCLOUD_SESSIONTOKEN || ''

  const payload = JSON.stringify({ ImageBase64: imageBase64 })
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10) // UTC 日期用于 TC3
  const actionLower = OCR_ACTION.toLowerCase()

  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest()
  const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex')

  // 1. CanonicalRequest
  const contentType = 'application/json; charset=utf-8'
  const canonicalHeaders =
    'content-type:' + contentType + '\n' +
    'host:' + OCR_HOST + '\n' +
    'x-tc-action:' + actionLower + '\n'
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256hex(payload)
  ].join('\n')

  // 2. StringToSign
  const credentialScope = `${date}/${OCR_SERVICE}/tc3_request`
  const stringToSign = [
    'TC3-HMAC-SHA256',
    timestamp,
    credentialScope,
    sha256hex(canonicalRequest)
  ].join('\n')

  // 3. Signature
  const secretDate = hmac('TC3' + secretKey, date)
  const secretService = hmac(secretDate, OCR_SERVICE)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = hmac(secretSigning, stringToSign).toString('hex')

  const authorization =
    `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  const headers = {
    Authorization: authorization,
    'Content-Type': contentType,
    'Host': OCR_HOST,
    'X-TC-Action': OCR_ACTION,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': OCR_VERSION,
    'X-TC-Region': OCR_REGION
  }
  if (token) headers['X-TC-Token'] = token

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: OCR_HOST,
      path: '/',
      method: 'POST',
      headers
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        let json
        try {
          json = JSON.parse(body)
        } catch (e) {
          reject(new Error('OCR 服务返回异常'))
          return
        }
        const resp = json.Response || {}
        if (resp.Error) {
          const err = new Error(resp.Error.Message || 'OCR 调用失败')
          err.code = resp.Error.Code
          reject(err)
          return
        }
        // 兼容两种响应结构
        const lines = []
        const td = resp.TextDetections
        if (Array.isArray(td)) {
          td.forEach((it) => {
            if (it && it.DetectedText) lines.push(String(it.DetectedText))
          })
        }
        const itemList = resp.Result && resp.Result.ItemList
        if (Array.isArray(itemList)) {
          itemList.forEach((it) => {
            if (it && it.ItemString) lines.push(String(it.ItemString))
          })
        }
        resolve(lines.join('\n'))
      })
    })
    req.on('error', (err) => reject(err))
    req.write(payload)
    req.end()
  })
}

/* ==================== ocr.space OCR（免费：25,000 次/月，无需信用卡） ==================== */
function httpPostReturnStatus(url, body, contentType, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) },
        headers || {}
      )
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function multipartField(boundary, name, value) {
  return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
}

function requestOcrSpace(imageBase64) {
  const apiKey = OCR_SPACE_API_KEY
  if (!apiKey) {
    const err = new Error('OCR_SPACE_API_KEY not configured')
    err.code = 'NOT_CONFIGURED'
    err.provider = 'ocrspace'
    err.ocrspace = true
    return Promise.reject(err)
  }
  // multipart 提交；base64Image 需带 data:image/xxx;base64, 前缀；语言 chs = 简体中文
  const boundary = '----ocrSpace' + crypto.randomBytes(12).toString('hex')
  let body = multipartField(boundary, 'apikey', apiKey)
  body += multipartField(boundary, 'language', 'chs')
  body += multipartField(boundary, 'OCREngine', '2')
  body += multipartField(boundary, 'isOverlayRequired', 'false')
  body += multipartField(boundary, 'detectOrientation', 'true')
  body += multipartField(boundary, 'isTable', 'true')
  body += multipartField(boundary, 'base64Image', 'data:image/jpeg;base64,' + imageBase64)
  body += `--${boundary}--\r\n`

  return httpPostReturnStatus(OCR_SPACE_URL, body, 'multipart/form-data; boundary=' + boundary, { apikey: apiKey })
    .then((r) => {
      let json = null
      try { json = JSON.parse(r.body) } catch (e) { json = null }
      const topMsg = String((json && (json.ErrorMessage || json.ErrorDetails)) || '')

      const makeErr = (code, fallbackMsg) => {
        const err = new Error(topMsg || fallbackMsg)
        err.code = code
        err.provider = 'ocrspace'
        err.ocrspace = true
        throw err
      }

      // HTTP 层鉴权 / 限额错误
      if (r.statusCode === 401 || (r.statusCode === 403 && /apikey|api key|invalid|incorrect/i.test(topMsg))) {
        return makeErr('OCRSPACE_KEY', 'ocr.space 密钥无效 (HTTP ' + r.statusCode + ')')
      }
      if (r.statusCode === 403 || r.statusCode === 429) {
        return makeErr('OCRSPACE_QUOTA', 'ocr.space 额度/频率超限 (HTTP ' + r.statusCode + ')')
      }
      if (r.statusCode !== 200 || !json) {
        return makeErr('OCRSPACE_FAIL', 'ocr.space 请求失败 (HTTP ' + r.statusCode + ')')
      }

      // 业务层错误
      const exitCode = +json.OCRExitCode
      if (exitCode === 4 || json.IsErroredOnProcessing === true) {
        if (/limit|quota|exceeded|too many/i.test(topMsg)) return makeErr('OCRSPACE_QUOTA', topMsg)
        return makeErr('OCRSPACE_FAIL', topMsg)
      }
      if (exitCode === 3) {
        return makeErr('OCRSPACE_IMAGE', topMsg || 'ocr.space 未能解析该图片')
      }

      // 成功/部分成功：收集各页解析文本
      const results = Array.isArray(json.ParsedResults) ? json.ParsedResults : []
      const lines = []
      results.forEach((it) => {
        if (it && String(it.FileParseExitCode) === '1' && it.ParsedText) lines.push(String(it.ParsedText))
      })
      if (lines.length) return lines.join('\n')
      return makeErr('OCRSPACE_IMAGE', topMsg || '未识别出文字')
    })
}

/* ==================== 前置检测：OCR 密钥是否配置 ==================== */
function preflight() {
  const chain = providerChain()
  return {
    code: 0,
    data: {
      ocrConfigured: chain.length > 0,
      provider: getProvider(),
      chain
    }
  }
}

/* ==================== OCR 各通道错误 → 友好中文提示 ==================== */
function mapOcrError(err) {
  const code = String((err && err.code) || '')
  const message = String((err && err.message) || '')
  const lower = message.toLowerCase()
  const raw = message.replace(/\[\[request id:[^\]\]]*\]\]/g, '').trim()

  // ---------- 全部通道均失败：逐通道汇总原因 ----------
  if (code === 'ALL_FAILED' && err && Array.isArray(err.chain)) {
    if (!err.chain.length) {
      return {
        code: 100,
        msg: 'OCR 服务未配置任何密钥（百度 / ocr.space 免费、腾讯云可选任一即可）。可先手动填写表单发布，配置方法见 ocrParse 云函数说明。'
      }
    }
    const parts = err.chain.map((it) => (PROVIDER_NAMES[it.name] || it.name) + '=' + it.reason)
    return { code: 101, msg: '自动识别通道均未成功：' + parts.join('；') + '。可稍后重试或手动填写发布。' }
  }

  // ---------- ocr.space OCR（免费通道） ----------
  if (err && (err.ocrspace || err.provider === 'ocrspace')) {
    if (code === 'NOT_CONFIGURED') {
      return { code: 100, msg: 'OCR 密钥未配置：免费注册 https://ocr.space/ocrapi 获取 API Key（免费 25,000 次/月），配置到 ocrParse 的 OCR_SPACE_API_KEY（环境变量或 keys.js）。未配置可先手动填写发布。' }
    }
    if (code === 'OCRSPACE_KEY') return { code: 101, msg: 'ocr.space 密钥无效：请检查 OCR_SPACE_API_KEY 是否正确。' }
    if (code === 'OCRSPACE_QUOTA') return { code: 101, msg: 'ocr.space 免费额度(25,000次/月)或频率已超限：可下月再试，或注册新的免费 Key。' }
    if (code === 'OCRSPACE_IMAGE') return { code: 101, msg: '截图无法识别：请使用清晰、格式为 JPEG/PNG 的预约订单截图。' }
    return { code: 101, msg: '截图识别失败(ocr.space)：' + (raw || message || '请稍后重试或手动填写') }
  }

  // ---------- 百度 OCR（免费通道） ----------
  if (err && (err.baidu || err.provider === 'baidu')) {
    if (code === 'NOT_CONFIGURED') {
      return {
        code: 100,
        msg: 'OCR 密钥未配置：请在 百度智能云 免费注册并创建「文字识别」应用，获取 API_KEY / SECRET_KEY，配置到 ocrParse 云函数环境变量（BAIDU_API_KEY / BAIDU_SECRET_KEY）。未配置可先手动填写发布。'
      }
    }
    if (code === '110' || code === '111' || code === 'BAIDU_AUTH') {
      return { code: 101, msg: '百度 OCR 鉴权失败：请检查 BAIDU_API_KEY / BAIDU_SECRET_KEY 是否正确。' }
    }
    if (code === '18') {
      return { code: 101, msg: '识别请求过于频繁（QPS 超限），请稍后重试。' }
    }
    if (code === '17') {
      return { code: 101, msg: '百度 OCR 今日免费识别次数已用尽，请明天再试。' }
    }
    if (code === '19' || code === '282004' || code === '282005') {
      return { code: 101, msg: '百度 OCR 免费识别额度已用尽：请确认已在百度智能云完成实名认证并领取免费资源包（免费额度有限）；用完后可购买资源包，或改用其它免费方案。' }
    }
    if (code === '216201' || code === '216202' || code === '216200' || code === '216630') {
      return { code: 101, msg: '截图无法识别：请使用清晰、格式为 JPEG/PNG 的预约订单截图。' }
    }
    return { code: 101, msg: '截图识别失败：' + (raw || message || '请稍后重试或手动填写') }
  }

  // ---------- 腾讯云 OCR（备选通道） ----------
  // 未配置密钥（前置检测）
  if (code === 'NOT_CONFIGURED') {
    return {
      code: 100,
      msg: 'OCR 密钥未配置：请在腾讯云 CAM 创建密钥并授权 QcloudOCRFullAccess，再为 ocrParse 云函数配置环境变量 OCR_SECRET_ID / OCR_SECRET_KEY。未配置时也可先手动填写表单发布。'
    }
  }
  // CAM 权限不足
  if (code === 'UnauthorizedOperation' || /unauthorizedoperation|not authorized|has no permission|you are not authorized/.test(lower)) {
    return {
      code: 102,
      msg: 'OCR 密钥权限不足：当前密钥无法调用 ocr:GeneralBasicOCR。请到腾讯云 CAM 为该密钥关联策略 QcloudOCRFullAccess，并在 ocrParse 云函数更新 OCR_SECRET_ID / OCR_SECRET_KEY。'
    }
  }
  // 密钥错误/签名/有效期问题
  if (code.indexOf('AuthFailure') > -1 || /signature|secretid|secret key|invalid credential|authfail/.test(lower)) {
    return {
      code: 101,
      msg: 'OCR 密钥校验失败：请检查 OCR_SECRET_ID / OCR_SECRET_KEY 是否正确（腾讯云控制台 → 访问管理 → 访问密钥）。'
    }
  }
  // 调用频率限制
  if (/limitexceeded|frequency|too many request/.test(lower)) {
    return { code: 101, msg: 'OCR 调用过于频繁，请稍后重试。' }
  }
  // 图片本身问题
  if (/imagesizetoolarge|invalidparameter|unsupported|decode|recogniz/.test(lower)) {
    return { code: 101, msg: '截图无法识别：请确保图片清晰、曝光正常、关键信息未被遮挡，或更换更清晰的预约截图。' }
  }
  // 其他未知错误
  return { code: 101, msg: '截图识别失败：' + (raw || message || '请稍后重试或手动填写') }
}

/* ==================== 结构化解析 ==================== */
function normalize(s) {
  return String(s)
    .replace(/[：]/g, ':')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[，、]/g, ' ')
    .replace(/[—-―–~]/g, '-')
    .replace(/[。；]/g, ' ')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

// 中国时区今天 yyyy-MM-dd
function chinaToday() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

const VENUE_MARKERS = [
  '球馆', '体育馆', '体育中心', '羽毛球馆', '羽毛球', '篮球馆', '篮球场', '篮球',
  '足球场', '足球', '网球场', '网球', '乒乓球馆', '乒乓球', '台球', '斯诺克',
  '排球', '健身', '游泳馆', '泳池', '运动公园', '运动中心', '体育公园',
  '俱乐部', '场馆', '中心', '球场', '会所', '馆', '场'
]
const VENUE_LABEL_RE = /^(场馆|场地|场馆名称|场地名称|地点|地址)/

function venueScore(s) {
  let score = 0
  if (/馆|中心|体育|公园|俱乐部|球场/.test(s)) score += 6
  if (/羽毛球|篮球|足球|网球|乒乓|排球|台球|健身|游泳/.test(s)) score += 2
  if (s.length >= 4 && s.length <= 12) score += 3
  else if (s.length <= 20) score += 1
  if (/(电话|客服|订单|支付|温馨提示|热线|投诉)/.test(s)) score -= 10
  return score
}

function looksVenue(s) {
  return VENUE_MARKERS.some((m) => s.indexOf(m) > -1) && !/^[\d\s:.()%]+$/.test(s)
}

function extractVenue(lines) {
  let best = ''
  let bestScore = -1

  const consider = (raw) => {
    const candidate = String(raw || '').trim()
      .replace(/[|】】』】『]/g, '')
      .replace(/^[：:、\-=*\s]+/, '')
      .trim()
    if (candidate.length < 2 || candidate.length > 20) return
    if (!looksVenue(candidate)) return
    const sc = venueScore(candidate)
    if (sc > bestScore) {
      bestScore = sc
      best = candidate
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const cleaned = String(lines[i] || '').trim()
    if (cleaned.length < 2 || cleaned.length > 24) continue

    // 1) 形如「场馆：XXX」取冒号后内容
    const ci = cleaned.indexOf(':')
    if (ci > -1) {
      const label = cleaned.slice(0, ci).trim()
      const val = cleaned.slice(ci + 1).trim()
      if (VENUE_LABEL_RE.test(label) && val.length >= 2 && val.length <= 20 && looksVenue(val)) {
        if (venueScore(val) > bestScore) {
          bestScore = venueScore(val)
          best = val
        }
        continue
      }
    }

    // 2) 单独一行「场馆名称」，其值在下一行（常见预约订单排版）
    if (VENUE_LABEL_RE.test(cleaned) && cleaned.length <= 6) {
      const next = String(lines[i + 1] || '').trim()
      if (next && next.length >= 2 && next.length <= 20) consider(next)
      continue
    }

    // 3) 独立场馆名
    consider(cleaned)
  }
  return best
}

function extractDate(text) {
  const today = chinaToday()
  const matches = []
  const re1 = /(20\d{2})\s*[-/年月.]\s*(\d{1,2})\s*[-/月日.]\s*(\d{1,2})\s*[日号]?/g
  let m
  while ((m = re1.exec(text)) !== null) {
    const y = +m[1]
    const mo = +m[2]
    const d = +m[3]
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue
    matches.push(`${y}-${pad2(mo)}-${pad2(d)}`)
  }

  // 无年份：如「9月6日」
  if (!matches.length) {
    const re2 = /(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g
    const curYear = today.slice(0, 4)
    while ((m = re2.exec(text)) !== null) {
      const mo = +m[1]
      const d = +m[2]
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue
      matches.push(`${curYear}-${pad2(mo)}-${pad2(d)}`)
    }
  }

  if (!matches.length) return ''
  // 优先选择未来（含今天），否则取第一个
  const future = matches.filter((s) => s >= today)
  return future.length ? future[0] : matches[0]
}

function extractTime(text) {
  // 范围形式：14:00-16:00 / 19:00—21:00
  const reRange = /(\d{1,2})[:：](\d{2})\s*[-~]\s*(\d{1,2})[:：](\d{2})/
  const rg = text.match(reRange)
  if (rg) {
    const h1 = +rg[1]; const m1 = +rg[2]; const h2 = +rg[3]; const m2 = +rg[4]
    if (h1 < 24 && h2 < 24 && (h2 * 60 + m2) > (h1 * 60 + m1)) {
      return { startTime: `${pad2(h1)}:${pad2(m1)}`, endTime: `${pad2(h2)}:${pad2(m2)}` }
    }
  }
  // 兜底：连续两个时间点
  const reTs = /(\d{1,2})[:：](\d{2})/g
  const tokens = []
  let t
  while ((t = reTs.exec(text)) !== null) {
    const h = +t[1]
    if (h < 24) tokens.push(`${pad2(h)}:${t[2]}`)
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] < tokens[i + 1]) {
      return { startTime: tokens[i], endTime: tokens[i + 1] }
    }
  }
  return { startTime: '', endTime: '' }
}

// 「项目名称」等字段提取运动类型，用于前端更准确地推断分类
const SPORT_MARKERS = ['篮球', '足球', '羽毛球', '网球', '乒乓球', '台球', '桌球', '斯诺克', '排球', '游泳', '健身']
function extractSport(text) {
  const m = text.match(/项目名称[:：]?\s*([^\n]+)/)
  const src = m && m[1] ? m[1] : text
  for (const s of SPORT_MARKERS) {
    if (src.indexOf(s) > -1) return s
  }
  return ''
}

/* ---- 场次位置（场地）：预约场次下，位于日期与时间之间 ---- */
const LOCATION_LABEL_RE = /^(场次位置|场地位置|使用场地|活动场地|场地号|场位|场区|区域|分区|位置|场地)$/
const LOCATION_VALUE_RE = /\d{1,2}\s*号\s*[场馆地]|[A-Za-z]\s*区|[A-Za-z]\s*号场|\d{1,2}\s*号?场地|室内|室外/

function cleanLocation(s) {
  return String(s || '')
    .replace(/[|｜】』]/g, '')
    .replace(/^[：:、\-=*\s]+/, '')
    .replace(/[\s，,。;；]+$/, '')
    .trim()
    .slice(0, 20)
}

// 排除：纯数字 / 时间 / 日期 / 电话订单等无关信息 / 明显是场馆名的内容
function isLocationLike(s) {
  const v = cleanLocation(s)
  if (!v || v.length < 1 || v.length > 20) return false
  if (/^\d+$/.test(v)) return false
  if (/\d{1,2}\s*[:：]\s*\d{2}/.test(v)) return false
  if (/(20\d{2}|\d{1,2}\s*月)/.test(v)) return false
  if (/(电话|客服|订单|支付|温馨提示|热线|投诉|预约人|手机号|金额|状态)/.test(v)) return false
  if (/(馆|中心|体育|公园|俱乐部)/.test(v)) return false
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(v)) return false
  return true
}

// 纯数字场次号（如「03」）：仅在「日期↔时间」之间的兜底路径里允许
function isCourtNo(s) {
  return /^\d{1,3}$/.test(cleanLocation(s))
}

// 同一行内取「日期之后、时间之前」的片段（应对 OCR 把卡片合并成一行的情况）
function sliceBetweenDateAndTime(s) {
  const dm = s.match(/(20\d{2}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2})|(\d{1,2}\s*月\s*\d{1,2}\s*日)/)
  const tm = s.match(/\d{1,2}\s*[:：]\s*\d{2}/)
  if (dm && tm && tm.index > dm.index + dm[0].length) {
    return cleanLocation(s.slice(dm.index + dm[0].length, tm.index))
  }
  return ''
}

function extractLocation(lines, text) {
  // 1) 带标签：「位置：3号场」「场地位置:A区」
  for (let i = 0; i < lines.length; i++) {
    const cleaned = String(lines[i] || '').trim()
    const ci = cleaned.indexOf(':')
    if (ci > -1) {
      const label = cleaned.slice(0, ci).trim()
      const val = cleaned.slice(ci + 1).trim()
      if (LOCATION_LABEL_RE.test(label) && isLocationLike(val)) return cleanLocation(val)
    }
  }

  // 2) 标签单独一行，值在下一行
  for (let i = 0; i < lines.length; i++) {
    const cleaned = String(lines[i] || '').trim()
    if (LOCATION_LABEL_RE.test(cleaned) && cleaned.length <= 6) {
      const next = String(lines[i + 1] || '').trim()
      if (isLocationLike(next)) return cleanLocation(next)
    }
  }

  // 3) 典型位置特征：3号场 / 1号场地 / A区 / 室内
  const m = text.match(LOCATION_VALUE_RE)
  if (m) {
    const v = cleanLocation(m[0])
    if (isLocationLike(v)) return v
  }

  // 4) 兜底：取「日期」与「时间」之间的内容
  //    厦大体育预约卡片排版：日期行(2026-09-06 周日) → 场次号(03) → 时间行(14:00-15:00)
  const DATE_LINE_RE = /(20\d{2}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2})|(\d{1,2}\s*月\s*\d{1,2}\s*日)/
  const TIME_LINE_RE = /\d{1,2}\s*[:：]\s*\d{2}/
  const dateLineIdx = lines.findIndex((l) => DATE_LINE_RE.test(l))
  const timeLineIdx = lines.findIndex((l) => TIME_LINE_RE.test(l))

  if (dateLineIdx > -1 && timeLineIdx === dateLineIdx) {
    // 日期与时间在同一行：取两者之间的片段
    const seg = sliceBetweenDateAndTime(lines[dateLineIdx])
    if (seg && (isLocationLike(seg) || isCourtNo(seg))) return seg
  }

  if (dateLineIdx > -1 && timeLineIdx > dateLineIdx) {
    // 之间的独立行（典型：场次号「03」）
    for (let i = dateLineIdx + 1; i < timeLineIdx; i++) {
      const v = cleanLocation(lines[i])
      if (isLocationLike(v) || isCourtNo(v)) return v
    }
    // 日期行内日期之后的内容（如「2026-09-06 周日 03」→ 提取「03」）
    const dm = lines[dateLineIdx].match(DATE_LINE_RE)
    if (dm) {
      const tail = cleanLocation(lines[dateLineIdx].slice(dm.index + dm[0].length))
      if (tail && !TIME_LINE_RE.test(tail)) {
        if (isCourtNo(tail)) return tail
        if (isLocationLike(tail)) {
          const nm = tail.match(/(?:^|\s)(\d{1,3})(?:\s|$)/)
          return nm ? nm[1] : tail
        }
      }
    }
    // 时间行内时间之前的内容（如「03 14:00-15:00」）
    const head = cleanLocation(lines[timeLineIdx].split(TIME_LINE_RE)[0])
    if (head && (isLocationLike(head) || isCourtNo(head))) return head
  }
  return ''
}

function parseOrderText(rawText) {
  const text = normalize(rawText || '')
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean)

  return {
    venue: extractVenue(lines),
    location: extractLocation(lines, text),
    date: extractDate(text),
    startTime: extractTime(text).startTime,
    endTime: extractTime(text).endTime,
    sport: extractSport(text)
  }
}
