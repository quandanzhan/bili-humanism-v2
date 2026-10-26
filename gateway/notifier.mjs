/**
 * 预警邮件（SMTP）
 * ============================================================================
 * @module gateway/notifier
 * @description 继承 V1 的「出错发邮件」能力，但改成模块内可配置、带节流：
 *              · 同类错误 10 分钟内只发一封（防止错误风暴把邮箱打爆，也防止
 *                每个 4xx 都发信拖慢事件循环——上一轮压测已经吃过日志刷屏的亏）
 *              · 发送永远不阻塞请求：调用方只 fire-and-forget
 *              · 配置来自 gateway/settings.mjs（控制台可改，改完立即生效）
 *
 * 依赖 nodemailer（纯 JS，无原生依赖）。未安装时降级为「只记日志不发信」，
 * 不会因为缺依赖把服务打挂。
 * @exports {Function} sendMail - 直接发一封（用于「发送测试邮件」）
 * @exports {Function} alert - 节流告警
 * @exports {Function} smtpStatus - 当前 SMTP 可用性摘要
 */

import { getSmtpRaw, load as loadSettings } from './settings.mjs'
import { redactText, redactData } from './runtime.mjs'

let transporterPromise = null
let transporterKey = ''

/** 懒加载 nodemailer（未安装时返回 null，不抛错） */
async function getNodemailer() {
  try {
    return await import('nodemailer')
  } catch {
    return null
  }
}

/** 根据当前设置构造/复用 transporter（host/port/user/pass 变了就重建） */
async function getTransporter() {
  const s = getSmtpRaw()
  const key = `${s.host}|${s.port}|${s.security}|${s.user}|${s.pass}`
  if (transporterPromise && key === transporterKey) return transporterPromise

  transporterPromise = (async () => {
    const mod = await getNodemailer()
    if (!mod) return null
    const nodemailer = mod.default || mod
    const opts = {
      host: s.host,
      port: Number(s.port) || 465,
      secure: (s.security || 'ssl') === 'ssl',
      auth: s.user ? { user: s.user, pass: s.pass } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000
    }
    if ((s.security || '') === 'starttls') {
      opts.secure = false
      opts.requireTLS = true
    }
    return nodemailer.createTransport(opts)
  })()
  transporterKey = key
  return transporterPromise
}

/**
 * 发一封邮件
 * @param {{ subject: string, text: string, html?: string, to?: string }} msg
 * @returns {Promise<{ ok: boolean, error?: string, messageId?: string }>}
 */
export async function sendMail(msg) {
  const s = getSmtpRaw()
  if (!s.host || !s.to) return { ok: false, error: 'SMTP 未配置（host / 收件人 为空）' }
  const t = await getTransporter()
  if (!t) return { ok: false, error: 'nodemailer 未安装（npm i nodemailer）' }
  try {
    const info = await t.sendMail({
      from: s.from || s.user,
      to: msg.to || s.to,
      subject: `${redactText(s.subjectPrefix || '')}${redactText(msg.subject)}`,
      text: redactText(msg.text, [s.pass]),
      html: msg.html ? redactText(msg.html, [s.pass]) : undefined
    })
    console.log(`[notifier] ✓ 邮件已发送：${redactText(msg.subject)}`)
    return { ok: true, messageId: info.messageId }
  } catch (e) {
    console.error(`[notifier] ✗ 邮件发送失败：${redactText(e?.message || e)}`)
    return { ok: false, error: redactText(e?.message || e) }
  }
}

/** 节流状态：code → 上次发送时间 */
const lastSent = new Map()

/**
 * 节流告警（fire-and-forget，绝不 await）
 * @param {string} key - 去重键（一般用错误码）
 * @param {string} subject
 * @param {string} text
 */
export function alert(key, subject, text) {
  try {
    const s = loadSettings()
    if (!s.smtp?.enabled) return
    const win = Number(s.alerts?.throttleMs) || 600000
    const now = Date.now()
    const prev = lastSent.get(key) || 0
    if (now - prev < win) return
    lastSent.set(key, now)
    sendMail({ subject, text }).catch(() => {})
  } catch (e) {
    console.warn(`[notifier] 告警调度失败：${redactText(e?.message || e)}`)
  }
}

/**
 * 错误告警（按设置里的开关决定要不要发）
 * @param {{ code: string, status?: number, message: string, method?: string, url?: string }} err
 */
export function alertError(err) {
  const s = loadSettings()
  const status = Number(err.status) || 500
  if (status >= 500 && s.alerts?.on5xx === false) return
  if (status < 500 && s.alerts?.onChannelFailed === false && !String(err.code || '').includes('CHANNEL')) return
  const lines = [
    `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    `错误码：${err.code || 'UNKNOWN'}`,
    `HTTP 状态：${status}`,
    `请求：${err.method || '-'} ${redactText(err.url || '-')}`,
    `详情：${redactText(err.message || '-')}`
  ]
  alert(`err:${err.code || status}`, `错误告警 ${err.code || status}`, lines.join('\n'))
}

/**
 * AI 模型通道告警（models/router 在真实故障点直接调用）
 * ============================================================================
 * 为什么必须有这个（2026-10-23 用户报「节点报警不发邮件」后定位）：
 *   值班与私信回复是**进程内 tick**，不是 HTTP 请求——chat() 抛出的
 *   CHANNEL_* / ALL_CHANNELS_FAILED 被 scheduler / reply-loop 自己 catch 掉了，
 *   永远走不到 express 的 errorHandler，alertError 那条线对它们形同虚设。
 *   V1 的 reply_service.py 是在循环里直接 alert() 发信的，重构时漏接了这根线。
 *   所以通道故障必须由 router 就地调用本函数，而不是指望中间件。
 * @param {{ level:'down'|'all'|'none'|'hard', channel?:string, code:string,
 *           status?:number|string, detail?:string, tried?:string[] }} info
 */
export function alertChannel(info = {}) {
  const s = loadSettings()
  // 通道类告警的总开关（和 alertError 里 onChannelFailed 同一语义）
  if (s.smtp?.enabled !== true || s.alerts?.onChannelFailed === false) return
  const SUBJ = {
    down: `模型通道降级：${info.channel || '?'}`,
    all: '模型通道全部失败，本轮无法继续',
    none: '没有可用的模型通道',
    hard: `模型调用失败（不可降级）：${info.code}`
  }
  const NOTE = {
    down: '该通道暂时不可用，已自动切换下一个通道；同类告警按节流窗口合并。',
    all: '所有启用通道都失败了，值班/回复会停摆，请检查 key 或上游状态。',
    none: '没有「启用且填了 API Key」的通道，去控制台「AI 模型」配置。',
    hard: '换通道也没用的错误（400 参数 / 401 key 无效等），需要人工看配置。'
  }
  const key = info.level === 'down'
    ? `chan:down:${info.channel || '?'}:${info.code}`
    : `chan:${info.level}`
  const lines = [
    `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    `级别：${info.level}`,
    `通道：${info.channel || '-'}`,
    `错误码：${info.code}`,
    `HTTP：${info.status ?? '-'}`,
    `详情：${redactText(info.detail || '').slice(0, 400)}`,
    ...(info.tried && info.tried.length ? [`已尝试通道：${info.tried.join(' → ')}`] : []),
    '',
    `说明：${NOTE[info.level] || ''}`
  ]
  alert(key, `【AI通道】${SUBJ[info.level] || '告警'}`, lines.join('\n'))
}

/** 当前 SMTP 摘要（用于 /api/settings/smtp 的 status 字段） */
export async function smtpStatus() {
  const s = getSmtpRaw()
  const mod = await getNodemailer()
  return {
    configured: Boolean(s.host && s.to),
    enabled: Boolean(s.enabled),
    transport: (s.security || 'ssl') === 'ssl' ? 'SMTP_SSL' : 'SMTP/STARTTLS',
    nodemailer: Boolean(mod),
    from: s.from || s.user || '',
    to: s.to || ''
  }
}
