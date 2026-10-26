/**
 * 路由：场景化工具集（哪个场景能看见哪些工具）
 * ============================================================================
 * @module gateway/routes/scopes
 *
 *   GET /api/tools/scope        → 当前三个场景的工具白名单
 *   PUT /api/tools/scope        → 改某个场景 { scene, tools: [...] | null }
 *
 * 为什么需要：之前 12 个工具全塞给模型，包括「发评论」。发评论是对外动作，
 * 值班/私信根本用不到，让它看见了就是风险。
 * 借鉴 dsh-bili-scroll 的做法：**不注册**，模型连工具名都看不到，比提示词约束可靠。
 *
 * tools 传 null = 取消该场景限制（恢复全量）。
 */
import { Router } from 'express'
import { requireAuth } from '../auth.mjs'
import { load, setToolScope, settingsFile } from '../settings.mjs'

export function createScopesRouter() {
  const router = Router()
  // ⚠️ 不要用 router.use(requireAuth())：这个 router 挂在 '/api' 上，
  //    use 会拦截**后面注册的所有 /api/*** （包括 /api/health），
  //    导致健康检查 401（2026-10-23 实测踩到）。认证只加在自己的两条路由上。

  router.get('/tools/scope', requireAuth(), (req, res, next) => {
    try {
      res.json({ scopes: load().toolScopes || {}, file: settingsFile() })
    } catch (err) {
      next(err)
    }
  })

  router.put('/tools/scope', requireAuth(), (req, res, next) => {
    try {
      const { scene, tools } = req.body || {}
      if (!scene) {
        const e = new Error('缺少 scene（duty / reply / comment）')
        e.code = 'INVALID_REQUEST'
        throw e
      }
      res.json({ ok: true, scopes: setToolScope(String(scene), tools === null ? null : tools) })
    } catch (err) {
      next(err)
    }
  })

  return router
}
