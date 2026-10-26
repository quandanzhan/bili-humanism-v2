/**
 * 路由：外部 worker（NAS / 阿里云）任务分发
 * ============================================================================
 * @module gateway/routes/worker
 *
 *   GET  /api/worker/next    → worker 拉活（Header: x-worker-token）
 *   POST /api/worker/result  → worker 交结果（同一个 token）
 *   GET  /api/worker/status  → 队列状态（面板用，走 Basic Auth）
 *   POST /api/worker/task    → 手动派活（调试用，走 Basic Auth）
 *
 * ⚠️ 前两个**故意不走 requireAuth**：节点不是人，没法带 Basic Auth。
 *    改用共享 token + 白名单任务类型，避免把这个口子变成「远程执行任意命令」。
 *    token 未配置时整组直接拒绝（安全默认，不给裸奔的机会）。
 */
import { Router } from 'express'
import { requireAuth } from '../auth.mjs'
import { enqueue, claim, submit, queueStatus, TASK_TYPES } from '../worker.mjs'

const TOKEN = () => String(process.env.WORKER_TOKEN || '').trim()

function requireWorkerToken(req, res, next) {
  const t = TOKEN()
  if (!t) {
    return res.status(503).json({
      error: '未配置 WORKER_TOKEN，worker 通道已关闭',
      code: 'WORKER_DISABLED',
      hint: '请通过环境变量配置 WORKER_TOKEN，并让 worker 使用相同令牌'
    })
  }
  // 故意用固定时间比较，避免用 === 泄露前缀长度（虽然内网风险低）
  const got = String(req.headers['x-worker-token'] || '')
  if (got.length !== t.length || got !== t) {
    return res.status(401).json({ error: 'token 无效', code: 'WORKER_AUTH_FAILED' })
  }
  next()
}

export function createWorkerRouter() {
  const router = Router()

  // ---- worker 专用（token 认证）----
  router.get('/worker/next', requireWorkerToken, (req, res, next) => {
    try {
      const agent = String(req.query.agent || 'unknown').slice(0, 40)
      const t = claim(agent)
      if (!t) return res.status(204).end()
      res.json(t)
    } catch (err) {
      next(err)
    }
  })

  router.post('/worker/result', requireWorkerToken, (req, res, next) => {
    try {
      const { id, ok, result, error, agent } = req.body || {}
      if (!id) {
        const e = new Error('缺少任务 id')
        e.code = 'INVALID_REQUEST'
        throw e
      }
      res.json({ ok: true, ...submit(id, { ok, result, error, agent }) })
    } catch (err) {
      next(err)
    }
  })

  // ---- 管理侧（Basic Auth）----
  router.get('/worker/status', requireAuth(), (req, res, next) => {
    try {
      res.json({ ...queueStatus(), enabled: Boolean(TOKEN()), types: [...TASK_TYPES] })
    } catch (err) {
      next(err)
    }
  })

  router.post('/worker/task', requireAuth(), (req, res, next) => {
    try {
      const { type, payload, deadlineMs } = req.body || {}
      const id = enqueue(String(type || ''), payload || {}, { deadlineMs: Number(deadlineMs) || undefined })
      res.json({ ok: true, id })
    } catch (err) {
      next(err)
    }
  })

  return router
}
