/**
 * 工具：调用 MCP 服务器上的工具
 * ============================================================================
 * ⚠️ 安全边界：MCP 工具是**任意能力**（可以跑命令、读写文件）。
 *   所以这个工具默认**不进任何场景的工具白名单**（duty/reply 都看不到它），
 *   要用必须由用户在 /api/tools/scope 里显式加。
 *   这不是靠提示词约束，是模型连工具名都看不见。
 *
 * @module tools/mcp-call
 */
import { httpError } from '../integrations/fetch-client.mjs'
import { callMcp } from '../gateway/mcp.mjs'

/** 把 MCP 的 content[] 归一化：文本拼起来，图片转 dataURL */
function normalize(r) {
  const content = Array.isArray(r?.content) ? r.content : []
  const texts = []
  const images = []
  for (const c of content) {
    if (c?.type === 'text' && c.text) texts.push(String(c.text))
    else if (c?.type === 'image' && c.data) {
      images.push(`data:${c.mimeType || 'image/png'};base64,${c.data}`)
    } else if (c?.type === 'resource' && c.resource?.text) texts.push(String(c.resource.text))
  }
  return { text: texts.join('\n').trim(), images }
}

export default {
  name: 'mcp_call',
  description: '调用某个 MCP 服务器上的工具（先用 mcp_list 查 server 和工具名）。',
  parameters: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP 服务器 id（mcp_list 返回的 id）' },
      tool: { type: 'string', description: '工具名' },
      args: { type: 'object', description: '传给该工具的参数对象' }
    },
    required: ['server', 'tool']
  },
  async execute(a = {}) {
    const server = String(a.server || '').trim()
    const tool = String(a.tool || '').trim()
    if (!server || !tool) throw httpError('INVALID_ARGUMENT', 'server 和 tool 都不能为空')

    const r = await callMcp(server, tool, a.args && typeof a.args === 'object' ? a.args : {})
    const { text, images } = normalize(r)
    const limit = Number(process.env.MCP_RESULT_CHARS) || 8000
    const truncated = text.length > limit
    return {
      ok: r?.isError ? false : true,
      server,
      tool,
      text: truncated ? text.slice(0, limit) + `\n…（已截断，原长 ${text.length}）` : text,
      // images 会被 models/router.mjs 抽出来当图像块（交给视觉能力强的通道）
      ...(images.length ? { images } : {}),
      ...(r?.isError ? { note: 'MCP 工具报告执行失败，看 text 里的原因' } : {})
    }
  }
}
