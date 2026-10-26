/**
 * 工具：B 站评论区读取（BV 号 → 热门评论）
 * ============================================================================
 * 输入：BV 号、条数、排序方式（hot/like/time）
 * 输出：评论列表，含评论内容与必要元信息（用户、点赞数、回复数、时间、是否UP主、是否置顶）
 *
 * 关键约束：
 *   · 免登录可用（reply 接口公开），但登录后能拿到更完整的楼中楼统计
 *   · sort 映射：hot→B站 sort=2（热度）/ like→sort=1（点赞）/ time→sort=0（时间）
 *   · limit 默认 20、上限 50（B站单页上限 49 左右，超出会自动夹紧）
 *   · 自动剔除空内容评论；置顶评论会标记 pinned=true
 *   · 只返回一级评论，楼中楼需另调接口（不做隐式递归，避免请求爆炸）
 */

import { httpError } from '../integrations/fetch-client.mjs'
import { parseBvid, getVideo, getComments } from '../integrations/bili-api.mjs'

const SORT_MAP = { hot: 2, like: 1, time: 0 }

export default {
  name: 'bili_comments',
  description: 'B站评论区读取：按 BV 号取热门评论列表，包含内容、用户、点赞数、时间等元信息。免登录可用。',
  parameters: {
    type: 'object',
    properties: {
      bvid: { type: 'string', description: 'BV 号（如 BV1GJ411x7h7）' },
      limit: { type: 'number', description: '返回条数，默认 20，上限 50' },
      sort: { type: 'string', description: '排序：hot 热度（默认）/ like 点赞 / time 时间', enum: ['hot', 'like', 'time'] }
    },
    required: ['bvid']
  },
  /**
   * @param {{ bvid: string, limit?: number, sort?: 'hot'|'like'|'time' }} args
   * @returns {Promise<string>} JSON 字符串
   */
  async execute(args = {}) {
    const { bvid } = parseBvid(args.bvid)
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50)
    const sortKey = String(args.sort || 'hot').toLowerCase()
    const sort = SORT_MAP[sortKey]

    if (sort === undefined) {
      throw httpError('INVALID_ARGUMENT', `sort 只能是 hot / like / time，收到：${args.sort}`)
    }

    const video = await getVideo(bvid)
    const data = await getComments(video.aid, { ps: limit, pn: 1, sort })

    if (!data.comments.length) {
      return JSON.stringify(
        {
          bvid,
          aid: video.aid,
          title: video.title,
          total: data.total,
          count: 0,
          comments: [],
          note: '该视频暂无可见评论（可能关闭评论区或评论被清理）'
        },
        null,
        2
      )
    }

    return JSON.stringify(
      {
        bvid,
        aid: video.aid,
        title: video.title,
        sort: sortKey,
        total: data.total,
        count: data.comments.length,
        comments: data.comments
      },
      null,
      2
    )
  }
}
