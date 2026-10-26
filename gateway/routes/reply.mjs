/**
 * 路由：B站私信回复循环（接管 V1 的 reply_service）
 * ============================================================================
 * @module gateway/routes/reply
 *
 *   GET  /api/reply/status      → 运行态（mode / talker / 已回条数 / 最近日志）
 *   PUT  /api/reply             → 改模式 { mode:'off'|'dry'|'live', talker? }
 *   GET  /api/reply/history     → 最近的回复记录（含模型/通道/用了哪些工具）
 *   POST /api/reply/seed        → 把现有历史消息标为「已回」，上线前打底
 *   POST /api/reply/run         → 立刻跑一轮 { dryRun?: boolean }
 *
 * 为什么单独一路而不是塞进 schedule：两者节奏和风险完全不同。
 * 刷视频是只读，回私信是**对外发消息**，必须能被单独关掉。
 */

import { Router } from 'express'
import { requireAuth } from '../auth.mjs'
import { replyStatus, replyHistory, updateState, seedBaseline, runOnce } from '../reply-loop.mjs'

export function createReplyRouter(engine) {
  const router = Router()
  router.use(requireAuth())

  router.get('/reply/status', (req, res, next) => {
    try {
      res.json(replyStatus())
    } catch (err) {
      next(err)
    }
  })

  router.put('/reply', (req, res, next) => {
    try {
      const { mode, talker } = req.body || {}
      if (mode !== undefined && !['off', 'dry', 'live'].includes(mode)) {
        const e = new Error(`mode 只能是 off / dry / live，收到 ${mode}`)
        e.code = 'INVALID_REQUEST'
        throw e
      }
      const st = updateState({ mode, talker })
      res.json({ ok: true, mode: st.mode, talker: st.talker })
    } catch (err) {
      next(err)
    }
  })

  router.get('/reply/history', (req, res, next) => {
    try {
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20))
      res.json({ items: replyHistory(limit) })
    } catch (err) {
      next(err)
    }
  })

  router.post('/reply/seed', async (req, res, next) => {
    try {
      res.json({ ok: true, ...(await seedBaseline()) })
    } catch (err) {
      next(err)
    }
  })

  router.post('/reply/run', async (req, res, next) => {
    try {
      const dryRun = req.body?.dryRun === true
      // simulate：拿一句假消息走一遍完整生成链路（永不会真的发出去），
      // 用于「没有新私信也想验一下人格/工具/通道是否正常」
      const simulate = typeof req.body?.simulate === 'string' ? req.body.simulate : ''
      const r = await runOnce({ engine, force: true, dryRun, simulate })
      res.json({ ok: r.ok !== false, result: r, status: replyStatus() })
    } catch (err) {
      next(err)
    }
  })

  return router
}
