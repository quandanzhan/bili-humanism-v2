/**
 * 路由：日报与章程
 * ============================================================================
 *   GET  /api/digest            → 今天的日报 + 最近有日报的日期 + 推送状态
 *   GET  /api/digest/:date      → 某天日报全文（YYYY-MM-DD）
 *   POST /api/digest/push       → 手动推送某天（默认昨天），调试用
 *   GET  /api/charter           → 章程状态（哈希/是否被用户改过）+ 正文
 *   PUT  /api/charter           → 改章程正文（写完重新记账，不会被当成程序版覆盖）
 *
 * ⚠️ 挂在 '/api' 根上，**认证只加在各自路由**，不能用 router.use(requireAuth())
 *    —— 否则会拦掉后面注册的所有 /api/*（含 /api/health），今天已经踩过三次同类坑。
 *
 * @module gateway/routes/digest
 */
import { Router } from 'express'
import { requireAuth } from '../auth.mjs'
import { readDigest, listDigests, digestForPush, digestState, maybePushYesterday, yesterdayKey, dailySummary, highlights } from '../digest.mjs'
import { charterStatus, readCharter, writeCharter, ensureCharter } from '../charter.mjs'
import { sendLongMessage } from '../../integrations/bili-dm.mjs'
import { loadState as loadReplyState } from '../reply-loop.mjs'

export function createDigestRouter() {
  const router = Router()

  router.get('/digest', requireAuth(), (req, res, next) => {
    try {
      const today = readDigest()
      res.json({
        today: {
          date: today.date,
          exists: today.exists,
          rounds: today.rounds,
          chars: today.chars || 0,
          summary: dailySummary(today.date),
          highlights: highlights(today.date),
          markdown: today.markdown
        },
        dates: listDigests(14),
        state: digestState()
      })
    } catch (err) {
      next(err)
    }
  })

  router.get('/digest/:date', requireAuth(), (req, res, next) => {
    try {
      // 借鉴 dsh-bili-scroll 2.0.1：只认「行首是 YYYY-MM-DD」，后面带不带时间都收下。
      // 以前整串严格匹配 ^\d{4}-\d{2}-\d{2}$，写成 2026-10-23T14:00:00Z 会被 400 拒掉。
      // 但仍拒绝完全不含日期的乱写（normalizeDate 会把乱写悄悄当成今天，这里不能那样）。
      const raw = String(req.params.date || '').trim()
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw)
      if (!m) {
        const e = new Error('日期格式应为 YYYY-MM-DD（可带时间后缀）')
        e.code = 'INVALID_REQUEST'
        throw e
      }
      res.json(readDigest(m[1]))
    } catch (err) {
      next(err)
    }
  })

  router.post('/digest/push', requireAuth(), async (req, res, next) => {
    try {
      const date = String((req.body || {}).date || yesterdayKey())
      const d = digestForPush(date)
      if (!d) {
        const e = new Error(`没有 ${date} 的日报`)
        e.code = 'BILI_NOT_FOUND'
        throw e
      }
      const to = loadReplyState().talker || Number(process.env.REPLY_TALKER) || 0
      if (!to) throw Object.assign(new Error('请配置负责人 UID（REPLY_TALKER 或回复设置）'), { code: 'INVALID_REQUEST' })
      const r = await sendLongMessage({ receiver: to, text: d.text })
      res.json({ ok: true, date, rounds: d.rounds, watched: d.watched.length, parts: r.parts })
    } catch (err) {
      next(err)
    }
  })

  router.get('/charter', requireAuth(), (req, res, next) => {
    try {
      res.json({ status: charterStatus(), body: readCharter() })
    } catch (err) {
      next(err)
    }
  })

  router.put('/charter', requireAuth(), (req, res, next) => {
    try {
      const body = String((req.body || {}).body || '')
      const r = writeCharter(body)
      res.json({ ok: true, ...r, status: charterStatus() })
    } catch (err) {
      next(err)
    }
  })

  return router
}
