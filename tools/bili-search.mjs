/**
 * 工具：B 站站内搜索（关键词 → 视频列表）
 * ============================================================================
 * 输入：关键词（可选页码）
 * 输出：结构化视频列表 [{ bvid, title, author, durationText, play, ... }]
 *
 * 关键约束：
 *   · **需要登录 Cookie**（SESSDATA）。无 Cookie 时 B站 search 接口返回风控页（-412），
 *     本工具会直接抛 BILI_AUTH_REQUIRED 并给出配置提示，不会把风控 HTML 当结果返回
 *   · 只搜「视频」分区（search_type=video），不是直播/番剧/用户
 *   · limit 默认 10、上限 30；搜索结果标题里的 <em> 高亮标签会被清掉
 *   · 与 web_search（全网搜索）是两个独立工具，互不依赖
 */

import { httpError } from '../integrations/fetch-client.mjs'
import { searchVideos } from '../integrations/bili-api.mjs'

export default {
  name: 'bili_search',
  description: 'B站站内搜索：按关键词搜索视频，返回 BV 号、标题、UP主、播放量等结构化列表。需要配置 B站 Cookie。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '搜索关键词' },
      page: { type: 'number', description: '页码，默认 1' },
      limit: { type: 'number', description: '返回条数，默认 10，上限 30' }
    },
    required: ['keyword']
  },
  /**
   * @param {{ keyword: string, page?: number, limit?: number }} args
   * @returns {Promise<string>} JSON 字符串
   */
  async execute(args = {}) {
    const keyword = String(args.keyword ?? '').trim()
    if (!keyword) throw httpError('INVALID_ARGUMENT', '关键词不能为空')

    const page = Math.max(1, Number(args.page) || 1)
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30)

    const data = await searchVideos(keyword, { page })
    const results = data.results.slice(0, limit)

    if (!results.length) {
      throw httpError('EMPTY_RESULT', `没有搜到「${keyword}」相关的视频`, { keyword, page })
    }

    return JSON.stringify(
      {
        keyword: data.keyword,
        page: data.page,
        total: data.total,
        count: results.length,
        results
      },
      null,
      2
    )
  }
}
