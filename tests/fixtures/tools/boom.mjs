/**
 * fixture 工具：boom —— 故意抛错（集成测试用）
 * ============================================================================
 * 用途：让 engine.callTool 包装出 code=TOOL_EXECUTION_ERROR，
 *      覆盖网关 tools 路由里「白名单错误码 → 400」的分支（此前零覆盖）。
 *
 * 契约（tools/scanner.mjs 的扫描规则）：
 *   默认导出的对象必须同时含 name:string 与 execute:function 才算有效工具。
 */

export default {
  name: 'boom',
  description: '故意抛错（测试用）：触发 TOOL_EXECUTION_ERROR',
  parameters: {
    type: 'object',
    properties: {}
  },
  async execute() {
    throw new Error('boom! 故意失败')
  }
}
