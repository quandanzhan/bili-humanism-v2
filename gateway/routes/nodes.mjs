/**
 * 路由：解析节点监控
 * ============================================================================
 * @module gateway/routes/nodes
 *
 *   GET  /api/nodes        → 全部节点状态（30 秒缓存）
 *   POST /api/nodes/probe  → 强制重新探测（前端「立即检测」）
 *   PUT  /api/nodes        → 保存节点配置（地址留空=未启用）
 *
 * 与 /api/schedule/status 的区别：那个是**本机**调度器状态，
 * 这个是**远端服务器**（阿里云/魔搭）的健康，两者不要混在一个卡片里。
 */
import { Router } from 'express'
import { requireAuth } from '../auth.mjs'
import { probeAll, loadNodes, saveNodes, nodesFile, sanitize } from '../nodes.mjs'

export function createNodesRouter() {
  const router = Router()
  router.use(requireAuth())

  router.get('/nodes', async (req, res, next) => {
    try {
      const force = req.query.force === '1' || req.query.force === 'true'
      const r = await probeAll({ force })
      res.json({ ...r, file: nodesFile(), config: sanitize() })
    } catch (err) {
      next(err)
    }
  })

  router.post('/nodes/probe', async (req, res, next) => {
    try {
      res.json(await probeAll({ force: true }))
    } catch (err) {
      next(err)
    }
  })

  router.put('/nodes', async (req, res, next) => {
    try {
      const cfg = saveNodes(req.body || {})
      // 存完立刻按新配置探一次，省得前端再发一次请求
      const r = await probeAll({ force: true })
      res.json({ ok: true, config: sanitize(cfg), ...r })
    } catch (err) {
      next(err)
    }
  })

  return router
}
