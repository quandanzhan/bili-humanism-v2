/**
 * 路由：MCP 服务器管理
 * ============================================================================
 *   GET  /api/mcp            → 配置 + 连接状态（不主动连，只报已连的）
 *   PUT  /api/mcp            → 改配置（servers 数组，改完断开重连）
 *   POST /api/mcp/probe      → 主动连一遍，拿每个 server 的工具清单
 *
 * 架构说明：MCP 工具**不会**被展开成原生工具，只通过 mcp_list / mcp_call 两个代理口访问。
 * 这样接多少 server 都不会撑爆工具列表（本内核是精简版，工具一多模型选择质量会掉）。
 *
 * @module gateway/routes/mcp
 */
import { Router } from 'express'
import { requireAuth } from '../auth.mjs'
import { maskedMcpConfig, saveMcpConfig, listMcp, mcpStatus, closeAll } from '../mcp.mjs'

export function createMcpRouter() {
  const router = Router()
  // 同 scopes：不用 use(requireAuth())，否则会拦掉挂在它后面注册的 /api/* 路由

  router.get('/mcp', requireAuth(), (req, res, next) => {
    try {
      res.json({ config: maskedMcpConfig(), status: mcpStatus() })
    } catch (err) {
      next(err)
    }
  })

  router.put('/mcp', requireAuth(), (req, res, next) => {
    try {
      const cfg = saveMcpConfig(req.body || {})
      res.json({ ok: true, config: maskedMcpConfig(cfg), status: mcpStatus() })
    } catch (err) {
      next(err)
    }
  })

  router.post('/mcp/probe', requireAuth(), async (req, res, next) => {
    try {
      const servers = await listMcp({ connect: true })
      res.json({ ok: true, servers, status: mcpStatus() })
    } catch (err) {
      next(err)
    }
  })

  router.post('/mcp/close', requireAuth(), (req, res, next) => {
    try {
      closeAll()
      res.json({ ok: true, status: mcpStatus() })
    } catch (err) {
      next(err)
    }
  })

  return router
}
