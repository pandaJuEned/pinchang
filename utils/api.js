// 云函数调用统一封装
const { envId } = require('./config')

function call(name, data) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud) {
      reject(new Error('当前微信版本过低，无法使用云开发。'))
      return
    }
    wx.cloud.callFunction({ name, data })
      .then((res) => {
        const result = res && res.result ? res.result : {}
        if (result.code === 0) {
          resolve(result)
        } else {
          const err = new Error(result.msg || '操作失败，请稍后重试')
          err.code = result.code
          err.data = result.data
          reject(err)
        }
      })
      .catch((err) => {
        let message = '网络开小差了，请稍后重试'
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('FunctionName') > -1 || msg.indexOf('not found') > -1) {
          message = '云函数未部署或未开通云开发，请先部署云函数'
        } else if (msg.indexOf('env') > -1) {
          message = '云开发环境未配置正确，请检查 utils/config.js'
        }
        const e = new Error(message)
        e.raw = err
        reject(e)
      })
  })
}

function callApi(data) {
  return call('courtApi', data)
}

function callOcr(fileID) {
  return call('ocrParse', { fileID })
}

// 前置检测：探测 OCR 密钥是否已配置（不实际识别）
function callOcrPreflight() {
  return call('ocrParse', { action: 'preflight' })
}

// 订阅消息推送结果反馈（notify / openCourt）：失败时把错误码的人话解释 Toast 出来，
// 便于真机上直接判断是「未订阅 43101」还是「模板 ID 错误 40037」，不用翻云函数日志。
function toastPushResult(res) {
  const d = (res && res.data) || res || {}
  // notify：sent === false 表示失败
  if (d.sent === false) {
    const msg = String(d.errMsg || '未知原因')
    wx.showToast({
      title: '通知未送达：' + (msg.length > 36 ? msg.slice(0, 36) + '…' : msg),
      icon: 'none',
      duration: 3200
    })
    return
  }
  // openCourt：pushed / total 统计，全失败或半失败都提示
  if (d.total && d.pushed < d.total) {
    const msg = String(d.pushErr || '对方未订阅该模板')
    wx.showToast({
      title: d.pushed ? `仅 ${d.pushed}/${d.total} 人收到：${msg.slice(0, 24)}` : '通知未送达：' + msg.slice(0, 30),
      icon: 'none',
      duration: 3200
    })
  }
}

function toastErr(err) {
  const msg = (err && (err.message || err.msg)) || '操作失败'
  wx.showToast({ title: msg, icon: 'none', duration: 2600 })
}

// 云存储 fileID（cloud://）→ 临时 https 链接
// 分享卡片的 imageUrl 不支持 cloud://，必须换成临时网络地址；失败时返回空串（分享用默认截图）
function getTempUrl(fileID) {
  return new Promise((resolve) => {
    if (!fileID || String(fileID).indexOf('cloud://') !== 0) return resolve('')
    if (!wx.cloud || !wx.cloud.getTempFileURL) return resolve('')
    wx.cloud.getTempFileURL({ fileList: [fileID] })
      .then((res) => {
        const item = (res && res.fileList ? res.fileList : [])[0]
        resolve((item && item.tempFileURL) || '')
      })
      .catch(() => resolve(''))
  })
}

module.exports = { call, callApi, callOcr, callOcrPreflight, toastErr, getTempUrl }
