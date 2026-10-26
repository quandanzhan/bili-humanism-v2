/**
 * 设置路由：SMTP 预警
 * ============================================================================
 * @module gateway/routes/settings
 *   GET  /api/settings/smtp        → 当前配置（密码打码）+ transporter 状态
 *   PUT  /api/settings/smtp        → 保存（password 传 "***" 表示不改）
 *   POST /api/settings/smtp/test   → 真发一封测试邮件（带耗时与错误原文）
 *   GET  /api/settings             → 汇总（smtp + 工具开关 + 文件路径）
 * @exports {Function} createSettingsRouter
 */

import { Router } from 'express'
import { requireAuth } from '../auth.mjs'
import { getSmtp, putSmtp, allToolStates, settingsFile } from '../settings.mjs'
import { sendMail, smtpStatus } from '../notifier.mjs'

export function createSettingsRouter() {
  const router = Router()
  router.use(requireAuth())

  /** GET /api/settings */
  router.get('/', async (req, res, next) => {
    try {
      res.json({
        smtp: { ...getSmtp(), status: await smtpStatus() },
        tools: allToolStates(),
        file: settingsFile()
      })
    } catch (e) {
      next(e)
    }
  })

  /** GET /api/settings/smtp */
  router.get('/smtp', async (req, res, next) => {
    try {
      res.json({ ...getSmtp(), status: await smtpStatus() })
    } catch (e) {
      next(e)
    }
  })

  /** PUT /api/settings/smtp */
  router.put('/smtp', (req, res, next) => {
    try {
      const b = req.body || {}
      const allowed = ['enabled', 'host', 'port', 'security', 'user', 'pass', 'from', 'to', 'subjectPrefix']
      const patch = {}
      for (const k of allowed) if (b[k] !== undefined) patch[k] = b[k]
      if (patch.security && !['ssl', 'starttls', 'none'].includes(String(patch.security))) {
        return res.status(400).json({ error: 'security 只能是 ssl / starttls / none', code: 'INVALID_REQUEST' })
      }
      putSmtp(patch)
      res.json({ ok: true, smtp: getSmtp() })
    } catch (e) {
      next(e)
    }
  })

  /** POST /api/settings/smtp/test —— 真发一封 */
  router.post('/smtp/test', async (req, res, next) => {
    try {
      const to = (req.body || {}).to
      const t0 = Date.now()
      const r = await sendMail({
        to,
        subject: '测试邮件：预警通道自检',
        text: [
          '这是一封来自 bili-humanism v2 控制台的测试邮件。',
          '',
          `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
          '收到这封信说明 SMTP 预警通道已配置可用。',
          '',
          '—— 海棠 B站助手'
        ].join('\n')
      })
      res.status(r.ok ? 200 : 502).json({ ...r, latencyMs: Date.now() - t0 })
    } catch (e) {
      next(e)
    }
  })

  return router
}
