/**
 * 工具：列出 MCP 服务器与工具
 * ============================================================================
 * 为什么不把 MCP 工具直接展开成一堆原生工具：
 *   接 5 个 server 可能冒出几十个工具，工具列表一爆炸，模型选工具的准确率会掉，
 *   也违背「内核精简」。所以只留 mcp_list + mcp_call 两个代理口。
 *
 * @module tools/mcp-list
 */
import { listMcp } from '../gateway/mcp.mjs'

export default {
  name: 'mcp_list',
  description: '列出已接入的 MCP 服务器及其提供的工具。要调 MCP 工具前先用它看清楚有什么。',
  parameters: {
    type: 'object',
    properties: {
      connect: { type: 'boolean', description: '是否真的连上去取工具列表，默认 true；只看配置可传 false' }
    }
  },
  async execute(args = {}) {
    const list = await listMcp({ connect: args.connect !== false })
    if (!list.length) {
      return { ok: true, count: 0, servers: [], note: '还没有配置任何 MCP 服务器（配置在 data/mcp-servers.json）' }
    }
    return {
      ok: true,
      count: list.length,
      servers: list.map((s) => ({
        id: s.id,
        name: s.name,
        enabled: s.enabled,
        tools: s.tools.map((t) => t.name),
        ...(s.error ? { error: s.error } : {})
      })),
      note: '调用方式：mcp_call 传 server=上面的 id、tool=工具名、args=参数对象。'
    }
  }
}
