/**
 * 工具注册表
 * ============================================================================
 * 用途：动态管理工具的注册 / 注销 / 查询
 * 模块：tools/registry
 */

/**
 * 工具注册表类
 * 内部使用 Map 存储，保证 O(1) 查询性能
 */
export class ToolRegistry {
  constructor() {
    /** @type {Map<string, Object>} name → tool object */
    this.tools = new Map()
  }

  /**
   * 注册工具
   * @param {Object} tool - 工具对象 { name, description?, execute, schema? }
   * @throws {Error} 缺少必填字段或字段类型不正确时抛出
   */
  register(tool) {
    if (!tool || typeof tool !== 'object') {
      throw new Error('工具必须是一个对象')
    }
    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error('工具必须有 name 字段（字符串）')
    }
    if (!tool.execute || typeof tool.execute !== 'function') {
      throw new Error('工具必须有 execute 方法（函数）')
    }

    this.tools.set(tool.name, tool)
    console.log(`[registry] ✓ 注册工具: ${tool.name}`)
  }

  /**
   * 注销工具
   * @param {string} name - 工具名称
   * @returns {boolean} 是否成功注销（工具原本存在返回 true）
   */
  unregister(name) {
    const existed = this.tools.has(name)
    this.tools.delete(name)
    if (existed) {
      console.log(`[registry] ✓ 注销工具: ${name}`)
    }
    return existed
  }

  /**
   * 获取工具
   * @param {string} name - 工具名称
   * @returns {Object|null} 工具对象，不存在时返回 null
   */
  get(name) {
    return this.tools.get(name) || null
  }

  /**
   * 获取所有工具的元数据列表（仅元数据，不含 execute）
   * @returns {Array<{name: string, description: string, schema: Object, parameters: Object}>}
   */
  list() {
    return Array.from(this.tools.values()).map(t => {
      // 工具作者可能写 schema，也可能写 parameters（两种历史写法都有），
      // 统一在 list() 里都给出——chat 路由要拿 parameters 去构造 OpenAI tools，
      // 之前只返回 schema 导致模型收到的参数定义是空的（2026-10-22 实测踩到）
      const p = t.parameters || t.schema || {}
      return {
        name: t.name,
        description: t.description || '',
        schema: p,
        parameters: p
      }
    })
  }

  /**
   * 清空所有已注册工具
   */
  clear() {
    this.tools.clear()
    console.log('[registry] ✓ 已清空所有工具')
  }
}
