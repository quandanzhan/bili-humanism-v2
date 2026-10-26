/**
 * fixture 工具：echo —— 回显入参（集成测试用）
 * ============================================================================
 * 契约（tools/scanner.mjs 的扫描规则）：
 *   默认导出的对象必须同时含 name:string 与 execute:function 才算有效工具。
 */

export default {
  name: 'echo',
  description: '回显入参（测试用）',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: '要回显的内容' }
    }
  },
  async execute(args) {
    return JSON.stringify({ success: true, data: args })
  }
}
