import { redactText, redactData } from '../runtime.mjs'
/**
 * 健康检查路由模板
 * Task D-E: HTTP Gateway & Routing
 * 
 * 职责：
 * - 提供系统健康状态端点（公开，无需认证）
 * - 返回服务运行时长、工具数量、可用模型通道数
 * - 可选地展示详细统计信息（若 Engine 和 ModelRouter 实现）
 * 
 * 注意：
 * - 此路由不需要认证，供监控系统和负载均衡器调用
 * - 使用 typeof 检查可选方法（reload / getAvailableChannels / healthCheck）
 * - 确保响应轻量，避免阻塞主线程
 */

import express from 'express'

const START_TIME = Date.now()

/**
 * 创建健康检查路由
 * @param {import('../../shared/interfaces.d.ts').Engine} engine - 工具引擎实例
 * @param {object} modelRouter - 模型路由器实例（可选方法见实现）
 * @returns {import('express').Router}
 */
export function createHealthRouter(engine, modelRouter) {
  const router = express.Router()

  /**
   * GET /
   * 返回系统健康状态
   * 
   * 响应示例：
   * {
   *   "status": "ok",
   *   "uptime": 123456,
   *   "tools": { "total": 12, "enabled": 10 },
   *   "models": { "available": 3 },
   *   "timestamp": 1234567890123
   * }
   */
  router.get('/', async (req, res) => {
    try {
      const uptime = Date.now() - START_TIME

      // 统计工具数量
      const toolsTotal = engine.tools ? engine.tools.length : 0
      const toolsEnabled = engine.tools
        ? engine.tools.filter(t => t.enabled !== false).length
        : 0

      // 统计可用模型通道（若 modelRouter 实现了 getAvailableChannels）
      let modelsAvailable = 0
      if (typeof modelRouter?.getAvailableChannels === 'function') {
        try {
          const channels = await modelRouter.getAvailableChannels()
          modelsAvailable = Array.isArray(channels)
            ? channels.filter(c => c.enabled !== false).length
            : 0
        } catch (err) {
          // 静默失败，返回 0
          console.warn('[Health] 获取模型通道失败:', redactText(err.message))
        }
      }

      // 可选：调用 Engine 的健康检查方法
      // ⚠️ healthCheck 可能是 async（interfaces.d.ts 声明为 Promise），必须 await，
      //    否则 engineHealth 会是一个 Promise 对象，JSON 序列化后变成 {}。
      let engineHealth = null
      if (typeof engine.healthCheck === 'function') {
        try {
          engineHealth = await engine.healthCheck()
        } catch (err) {
          console.warn('[Health] Engine 健康检查失败:', redactText(err.message))
        }
      }

      // 可选：调用 ModelRouter 的统计方法
      let modelStats = null
      if (typeof modelRouter?.stats === 'function') {
        try {
          modelStats = modelRouter.stats()
        } catch (err) {
          console.warn('[Health] ModelRouter 统计失败:', redactText(err.message))
        }
      }

      const response = {
        status: 'ok',
        uptime,
        tools: {
          total: toolsTotal,
          enabled: toolsEnabled
        },
        models: {
          available: modelsAvailable
        },
        timestamp: Date.now()
      }

      // 附加可选数据
      if (engineHealth) {
        response.engine = redactData(engineHealth)
      }
      if (modelStats) {
        response.modelStats = redactData(modelStats)
      }

      res.json(response)
    } catch (err) {
      // 健康检查端点自身不应抛出错误
      console.error('[Health] 健康检查异常:', redactText(err?.message || err))
      res.status(500).json({
        status: 'error',
        error: '健康检查失败',
        code: 'HEALTH_CHECK_FAILED',
        timestamp: Date.now()
      })
    }
  })

  return router
}
