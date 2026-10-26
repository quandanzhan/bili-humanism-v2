/**
 * 工具：B 站视频详情（BV 号 → 结构化数据）
 * ============================================================================
 * 输入：BV 号（也接受完整视频链接，会自动抠出 BV 与 ?p= 分P）
 * 输出：标题、UP 主、简介、时长（秒 + 人类可读）、发布时间、封面、统计、分P列表
 *
 * 关键约束：
 *   · 免登录可用（B站 view 接口公开）
 *   · 接受 BV 号、av 号(aid) 或视频链接；**私信分享卡片只有 av 号，填 aid 即可**
 *     （2026-10-23 修：以前只吃 BV，导致「拿到卡片也只报标题、查不了详情」）
 *   · BV 号格式校验：BV + 10 位字母数字，不合法直接 BILI_INVALID_BVID
 *   · 稿件被删/私密/审核中 → BILI_NOT_FOUND（带 B站原始 code）
 *   · 本工具只返回元信息，不下载视频流、不返回播放地址
 */

import { httpError } from '../integrations/fetch-client.mjs'
import { parseBvid, getVideo, getVideoByAid } from '../integrations/bili-api.mjs'

export default {
  name: 'bili_video',
  description: 'B站视频详情：凭 BV 号或 av 号（aid）获取标题、UP主、简介、时长、播放数据等结构化信息。私信分享卡片给的是 aid，直接填 aid 即可。免登录可用。',
  parameters: {
    type: 'object',
    properties: {
      bvid: { type: 'string', description: 'BV 号（如 BV1GJ411x7h7），也接受视频链接；与 aid 二选一' },
      aid: { type: 'number', description: 'av 号 / 稿件 id（私信分享卡片 content.id 就是它）；与 bvid 二选一，bvid 优先' },
      withPages: { type: 'boolean', description: '是否返回分P列表，默认 true' }
    },
    required: []
  },
  /**
   * @param {{ bvid?: string, aid?: number|string, withPages?: boolean }} args
   * @returns {Promise<string>} JSON 字符串
   */
  async execute(args = {}) {
    let bvid = ''
    let page = 1
    if (args.bvid) {
      const p = parseBvid(args.bvid)
      bvid = p.bvid
      page = p.page
    } else if (args.aid != null && String(args.aid).trim() !== '') {
      // aid → bvid 一跳（view 接口两个键都收，这里复用 getVideoByAid）。
      // 卡片里的 id 是 15 位大整数，字符串传进来，Number() 在 2^53 内是安全的。
      const n = Number(String(args.aid).trim())
      if (!Number.isFinite(n) || n <= 0) throw httpError('BILI_INVALID_BVID', `aid 不是合法正整数：${args.aid}`)
      const conv = await getVideoByAid(n).catch(() => null)
      if (!conv?.bvid) throw httpError('BILI_NOT_FOUND', `aid=${n} 查不到对应视频（可能已删除/私密）`, { aid: n })
      bvid = conv.bvid
    } else {
      throw httpError('INVALID_ARGUMENT', '需要 bvid 或 aid 之一')
    }

    const v = await getVideo(bvid)
    if (!v?.bvid) throw httpError('BILI_NOT_FOUND', '未获取到视频信息', { bvid })

    const withPages = args.withPages !== false

    const out = {
      bvid: v.bvid,
      aid: v.aid,
      url: `https://www.bilibili.com/video/${v.bvid}`,
      title: v.title,
      owner: v.owner,
      description: v.description,
      durationSec: v.durationSec,
      durationText: v.durationText,
      pubdate: v.pubdate,
      pubdateText: v.pubdateText,
      cover: v.cover,
      category: v.category,
      stat: v.stat,
      currentPage: page,
      cid: (withPages && v.pages.find(p => p.page === page)?.cid) || v.cid
    }

    if (withPages) out.pages = v.pages

    return JSON.stringify(out, null, 2)
  }
}
