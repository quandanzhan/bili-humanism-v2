/**
 * 工具引擎
 * ============================================================================
 * 用途：统一的工具调用入口，负责扫描 / 注册 / 调用 / 配置热更新
 * 模块：core/engine
 */

import { ToolRegistry } from '../tools/registry.mjs'
import { scanTools } from '../tools/scanner.mjs'

/** 默认工具目录 */
const DEFAULT_TOOLS_DIR = './tools'

/**
 * 工具引擎类
 */
export class Engine {
  /**
   * @param {string} [configFile] - 配置文件路径（可选，预留热重载集成）
   */
  constructor(configFile) {
    this.registry = new ToolRegistry()
    this.configFile = configFile || null
    this.config = {}
    this.started = false
  }

  /**
   * 启动引擎：扫描工具目录并注册所有工具
   * @param {string} [toolsDir] - 工具目录，默认 './tools'
   * @returns {Promise<{tools: Array}>}
   * @throws {Error} 重复启动时抛出
   */
  async start(toolsDir = DEFAULT_TOOLS_DIR) {
    if (this.started) {
      const err = new Error('引擎已经启动过了，不能重复启动')
      err.code = 'INVALID_STATE'
      throw err
    }

    console.log(`[engine] 正在扫描工具目录: ${toolsDir} ...`)
    const tools = await scanTools(toolsDir)

    for (const tool of tools) {
      this.registry.register(tool)
    }

    this.started = true
    console.log(`[engine] ✓ 引擎已启动，加载了 ${tools.length} 个工具`)

    return { tools: this.registry.list() }
  }

  /**
   * 调用已注册的工具
   * @param {string} name - 工具名称
   * @param {Object} args - 工具参数
   * @returns {Promise<any>} 工具执行结果
   * @throws {Error} TOOL_NOT_FOUND / TOOL_EXECUTION_ERROR
   */
  async callTool(name, args) {
    const tool = this.registry.get(name)

    if (!tool) {
      const err = new Error(`工具 ${name} 不存在`)
      err.code = 'TOOL_NOT_FOUND'
      err.data = { tool: name }
      throw err
    }

    try {
      return await tool.execute(args)
    } catch (e) {
      // 关键：工具自己抛出的语义化错误码（FILE_NOT_FOUND / BILI_AUTH_REQUIRED /
      // FETCH_TIMEOUT / URL_INVALID 等 7xxx/8xxx/9xxx 组）必须原样透传，
      // 否则会被路由层的 toolErrorCodes 白名单统一压成 400，
      // error.mjs 里的 codeToStatus 映射（404/403/504/415…）全部失效。
      const rawCode = typeof e?.code === 'string' && e.code ? e.code : ''
      const keep = rawCode && rawCode !== 'TOOL_EXECUTION_ERROR'
      const err = new Error(`工具 ${name} 执行失败: ${e?.message ?? String(e)}`)
      err.code = keep ? rawCode : 'TOOL_EXECUTION_ERROR'
      // 合并工具原始错误携带的 data（path/hint/apiCode 等）——
      // hint 对调用方排错至关重要，包装时不能丢
      err.data = {
        ...(keep && e?.data && typeof e.data === 'object' ? e.data : {}),
        tool: name,
        originalError: e?.message ?? String(e),
        ...(keep ? { originalCode: rawCode } : {})
      }
      // 透传工具附带的提示信息（如 BILI_AUTH_REQUIRED 的配置 hint），供前端展示
      if (e?.hint) err.hint = e.hint
      if (e?.status) err.status = e.status
      throw err
    }
  }

  /**
   * 热更新配置（由 ConfigLoader.watchConfig 回调或主程序调用）
   * @param {Object} patch - 配置补丁（增量合并）
   */
  async updateConfig(patch) {
    this.config = { ...this.config, ...(patch || {}) }
    console.log('[engine] 配置已更新')
    // 预留：可在此触发工具重载 / 插件配置刷新
  }

  /**
   * 获取工具列表（只读元数据）
   * @returns {Array<{name: string, description: string, schema: Object}>}
   */
  get tools() {
    return this.registry.list()
  }
}
