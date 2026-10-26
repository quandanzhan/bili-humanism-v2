/**
 * 路由：刷视频时间表（固定 Asia/Shanghai）+ 立即运行
 * ============================================================================
 * @module gateway/routes/schedule
 *
 *   GET  /api/schedule          → { config, state, file }（state 含当前窗口/今日次数/下次时间）
 *   PUT  /api/schedule          → 保存（可只传部分字段）
 *   GET  /api/schedule/status   → 调度器运行态 + 最近日志
 *   POST /api/schedule/run      → 立即跑一轮（force，忽略窗口但与次数无关）
 *   POST /api/schedule/reset    → 清空今日计数
 *
 * 时区固定 Asia/Shanghai：接口收到 timezone 也会被忽略（见 schedule.mjs normalize）。
 */

import { Router } from 'express'
import { requireAuth } from '../auth.mjs'
import { loadSchedule, saveSchedule, stateOf, resetToday, scheduleFile, TZ } from '../schedule.mjs'
import { runDuty, schedulerStatus, startScheduler, stopScheduler } from '../scheduler.mjs'

export function createScheduleRouter(engine) {
  const router = Router()
  router.use(requireAuth())

  router.get('/schedule', (req, res, next) => {
    try {
      res.json({ timezone: TZ, config: loadSchedule(), state: stateOf(), file: scheduleFile() })
    } catch (err) {
      next(err)
    }
  })

  router.put('/schedule', (req, res, next) => {
    try {
      const cfg = saveSchedule(req.body || {})
      res.json({ ok: true, timezone: TZ, config: cfg, state: stateOf(cfg) })
    } catch (err) {
      next(err)
    }
  })

  router.get('/schedule/status', (req, res, next) => {
    try {
      res.json(schedulerStatus())
    } catch (err) {
      next(err)
    }
  })

  router.post('/schedule/run', async (req, res, next) => {
    try {
      const r = await runDuty({ engine, force: true, windowId: 'manual' })
      res.json({ ok: r.ok !== false, result: r, state: stateOf() })
    } catch (err) {
      next(err)
    }
  })

  router.post('/schedule/reset', (req, res, next) => {
    try {
      res.json({ ok: true, state: resetToday() })
    } catch (err) {
      next(err)
    }
  })

  /** 启动/停止调度器（默认随进程启动，这里只是运维开关） */
  router.post('/schedule/toggle', (req, res, next) => {
    try {
      const on = req.body?.on
      if (on === false) return res.json({ ok: true, ...stopScheduler() })
      return res.json({ ok: true, ...startScheduler(engine) })
    } catch (err) {
      next(err)
    }
  })

  return router
}
