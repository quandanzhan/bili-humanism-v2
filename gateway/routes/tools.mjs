import { redactText, redactData } from '../runtime.mjs'
/**
 * 工具路由模板 - /api/tools
 * 
 * 功能：
 * - GET /api/tools - 列出所有可用工具
 * - GET /api/tools/:name - 获取工具详情
 * - POST /api/tools/:name - 调用工具
 * - POST /api/tools/reload - 重新加载工具
 * 
 * 依赖：
 * - Engine 实例（提供 tools 属性和 callTool 方法）
 */

import { Router } from 'express'
import { requireAuth } from '../auth.mjs'
import { isToolEnabled, setToolEnabled, load as loadSettings } from '../settings.mjs'

/**
 * 创建工具路由
 * @param {import('../../shared/interfaces.d.ts').Engine} engine 
 * @returns {Router}
 */
export function createToolsRouter(engine) {
  const router = Router()

  // 所有工具端点需要认证
  router.use(requireAuth())

  /**
   * GET /api/tools - 列出所有工具
   */
  router.get('/', async (req, res, next) => {
    try {
      const tools = engine.tools

      res.json({
        tools: tools.map(t => ({
          name: t.name,
          description: t.description || '',
          category: t.category || 'general',
          // 运行时开关优先：控制台关掉的工具即使代码里 enabled=true 也算禁用
          enabled: isToolEnabled(t.name) && t.enabled !== false,
          parameters: t.parameters || {}
        })),
        count: tools.length
      })
    } catch (err) {
      next(err)
    }
  })

  /**
   * POST /api/tools/reload - 重新加载工具
   * ⚠️ 必须注册在 POST /:name 之前，否则 "reload" 会被当成工具名
   */
  router.post('/reload', async (req, res, next) => {
    try {
      if (typeof engine.reload === 'function') {
        await engine.reload()
        res.json({
          message: '工具已重新加载',
          count: engine.tools.length,
          tools: engine.tools.map(t => t.name)
        })
      } else {
        // 降级：Engine 未实现 reload 时返回 501，避免误报成功
        res.status(501).json({
          error: '当前 Engine 未实现热重载',
          code: 'RELOAD_NOT_SUPPORTED',
          data: { count: engine.tools.length }
        })
      }
    } catch (err) {
      next(err)
    }
  })

  /**
   * GET /api/tools/:name - 获取工具详情
   */
  router.get('/:name', async (req, res, next) => {
    try {
      const { name } = req.params
      const tool = engine.tools.find(t => t.name === name)

      if (!tool) {
        return res.status(404).json({
          error: `工具未找到: ${name}`,
          code: 'TOOL_NOT_FOUND',
          data: { name }
        })
      }

      res.json({
        name: tool.name,
        description: tool.description || '',
        category: tool.category || 'general',
        enabled: isToolEnabled(tool.name) && tool.enabled !== false,
        parameters: tool.parameters || {},
        examples: tool.examples || []
      })
    } catch (err) {
      next(err)
    }
  })

  /**
   * PUT /api/tools/:name/enabled - 运行时开关（控制台用）
   * Body: { enabled: true|false }
   */
  router.put('/:name/enabled', (req, res, next) => {
    try {
      const { name } = req.params
      const { enabled } = req.body || {}
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled 必须是布尔值', code: 'INVALID_REQUEST' })
      }
      const tool = engine.tools.find(t => t.name === name)
      if (!tool) {
        return res.status(404).json({ error: `工具未找到: ${name}`, code: 'TOOL_NOT_FOUND', data: { name } })
      }
      setToolEnabled(name, enabled)
      res.json({ ok: true, name, enabled, states: loadSettings().tools || {} })
    } catch (err) {
      next(err)
    }
  })

  /**
   * POST /api/tools/:name - 调用工具
   * Body: { args: { ... } }
   *
   * 兼容旧版：`POST /api/tool/<name>` 直接把参数放在 body 顶层（没有 args 包裹），
   * 所以这里先看 body.args，没有就把整个 body 当参数用。
   */
  router.post('/:name', async (req, res, next) => {
    try {
      const { name } = req.params
      const args = req.body?.args ?? req.body ?? {}

      // 验证工具存在
      const tool = engine.tools.find(t => t.name === name)
      if (!tool) {
        return res.status(404).json({
          error: `工具未找到: ${name}`,
          code: 'TOOL_NOT_FOUND',
          data: { name }
        })
      }

      // 验证工具已启用（运行时开关优先）
      if (!isToolEnabled(tool.name) || tool.enabled === false) {
        return res.status(403).json({
          error: `工具已禁用: ${name}`,
          code: 'TOOL_DISABLED',
          data: { name }
        })
      }

      // 调用工具
      const result = await engine.callTool(name, args)

      res.json({
        tool: name,
        result,
        timestamp: Date.now()
      })
    } catch (err) {
      // 白名单 = Phase 2 定稿契约（integration.mjs 用例 5 断言 400 分支）：
      // 参数类错误与无原始码的兜底 TOOL_EXECUTION_ERROR 在路由层压成 400。
      // ⚠️ 工具语义化错误码（FILE_NOT_FOUND / BILI_AUTH_REQUIRED / FETCH_TIMEOUT /
      // FILE_BINARY / BILI_RISK_CONTROL 等 7xxx/8xxx/9xxx 组）一律不进白名单，
      // 由 engine.callTool 透传后交给 errorHandler 按 error.mjs 映射状态码。
      const toolErrorCodes = [
        'TOOL_EXECUTION_ERROR', 'TOOL_EXECUTE_FAILED',
        'CONFIG_INVALID', 'CONFIG_LOAD_FAILED', 'UNKNOWN_PARAMETER', 'TOKEN_BUDGET'
      ]
      if (err.code && toolErrorCodes.includes(err.code)) {
        return res.status(400).json({
          error: redactText(err.message || '工具执行失败'),
          code: err.code,
          data: redactData(err.data || {})
        })
      }
      // 工具自带的配置提示（如需配 Cookie 的 hint）并入 data 后交给 errorHandler
      if (err.hint) {
        err.data = { ...(err.data || {}), hint: err.hint }
      }
      next(err)
    }
  })

  return router
}

