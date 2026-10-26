/**
 * 路由：写操作权限
 * ============================================================================
 * @module gateway/routes/writes
 *
 *   GET /api/writes        → 当前策略 + 最近写记录 + 额度用量
 *   PUT /api/writes        → 改策略（总开关 / 回复 / 新评论 / 频率 / 字数）
 *
 * 刻意做成独立一路：写权限是「别人能看见」的开关，不该混在普通设置里被误点。
 */
import { Router } from 'express'
import { requireAuth } from '../auth.mjs'
import { save } from '../settings.mjs'
import { writeStats } from '../writes.mjs'

const BOOLS = ['enabled', 'allowCommentReply', 'allowNewComment']
const NUMS = { maxPerHour: [1, 200], maxPerMinute: [1, 20], maxChars: [10, 800] }

export function createWritesRouter() {
  const router = Router()
  router.use(requireAuth())

  router.get('/writes', (req, res, next) => {
    try {
      res.json(writeStats())
    } catch (err) {
      next(err)
    }
  })

  router.put('/writes', (req, res, next) => {
    try {
      const body = req.body || {}
      const next_ = {}
      for (const k of BOOLS) {
        if (body[k] !== undefined) next_[k] = body[k] === true || body[k] === 'true'
      }
      for (const [k, [lo, hi]] of Object.entries(NUMS)) {
        if (body[k] !== undefined) {
          const n = Number(body[k])
          if (!Number.isFinite(n)) {
            const e = new Error(`${k} 必须是数字`)
            e.code = 'INVALID_REQUEST'
            throw e
          }
          next_[k] = Math.max(lo, Math.min(hi, Math.round(n)))
        }
      }
      if (!Object.keys(next_).length) {
        const e = new Error('没有可保存的字段')
        e.code = 'INVALID_REQUEST'
        throw e
      }
      save({ writes: next_ })
      res.json({ ok: true, ...writeStats() })
    } catch (err) {
      next(err)
    }
  })

  return router
}
