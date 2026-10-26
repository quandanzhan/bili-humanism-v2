/**
 * 工具：B 站字幕获取（BV 号 → 字幕文本 + 来源标注）
 * ============================================================================
 * 输入：BV 号（可带 ?p=n 指定分P）、可选语言偏好
 * 输出：字幕全文 + **明确标注来源**（ai=自动识别 / manual=人工上传 / unknown=无法判定）
 *
 * 关键约束：
 *   · **必须配置 B站 Cookie**：未登录时 player/v2 的 subtitles 恒为空，
 *     会把「需要登录」误判成「该视频没有字幕」。本工具在无 Cookie 时直接抛
 *     BILI_AUTH_REQUIRED 并给出配置方式，不返回误导性的空结果。
 *   · 来源判定按真实观察的顺序：lan 前缀 ai-* → 字幕文件域名/路径 → 文案 → type
 *     （`ai_type=0` 不可信，实测 AI 字幕也会是 0）
 *   · 优先选人工字幕（质量更高），其次按语言偏好，最后取第一条
 *   · 多分P视频默认取 ?p= 指定页，未指定则取第 1P
 *   · includeCues=true 时额外返回带时间轴的字幕片段（from/to 秒）
 */

import { httpError } from '../integrations/fetch-client.mjs'
import {
  parseBvid,
  getVideo,
  getSubtitleList,
  getSubtitleBody,
  hasLoginCookie
} from '../integrations/bili-api.mjs'

const SOURCE_LABEL = { ai: '自动识别', manual: '人工上传', unknown: '来源不明' }

export default {
  name: 'bili_subtitle',
  description: 'B站字幕获取：按 BV 号取字幕全文，并明确标注是「自动识别」还是「人工上传」。需要 B站 Cookie。',
  parameters: {
    type: 'object',
    properties: {
      bvid: { type: 'string', description: 'BV 号（如 BV1GJ411x7h7），可带 ?p=2 指定分P' },
      lang: { type: 'string', description: '语言偏好，如 zh / en；不填则优先人工字幕' },
      includeCues: { type: 'boolean', description: '是否返回带时间轴的片段，默认 false' },
      maxChars: { type: 'number', description: '字幕最多返回多少字，默认 50000' }
    },
    required: ['bvid']
  },
  /**
   * @param {{ bvid: string, lang?: string, includeCues?: boolean, maxChars?: number }} args
   * @returns {Promise<string>} JSON 字符串
   */
  async execute(args = {}) {
    const { bvid, page } = parseBvid(args.bvid)

    if (!(await hasLoginCookie())) {
      throw httpError('BILI_AUTH_REQUIRED', '获取字幕需要 B站登录 Cookie（未登录时字幕列表恒为空）', {
        hint: '把 Cookie 写入凭据文件（sessdata/bili_jct/buvid3/dedeuserid），或设置环境变量 BILI_SESSDATA',
        bvid
      })
    }

    const video = await getVideo(bvid)
    const target = video.pages.find(p => p.page === page) || video.pages[0]
    const cid = target?.cid || video.cid

    const list = await getSubtitleList(bvid, cid)
    if (!list.length) {
      return JSON.stringify(
        {
          bvid,
          cid,
          hasSubtitle: false,
          subtitleSource: 'none',
          sourceLabel: '无字幕',
          available: [],
          text: '',
          chars: 0,
          note: '该视频没有可用字幕（已登录状态下查询）'
        },
        null,
        2
      )
    }

    // 选择策略：人工 > 语言匹配 > AI > 第一条
    const wantLang = String(args.lang || '').toLowerCase()
    const score = (s) => {
      let n = 0
      if (s.source === 'manual') n += 100
      if (wantLang && String(s.lan).toLowerCase().includes(wantLang)) n += 50
      if (s.source === 'ai') n += 10
      return n
    }
    const chosen = list.slice().sort((a, b) => score(b) - score(a))[0]

    if (!chosen.url) {
      throw httpError('BILI_API_ERROR', '字幕地址缺失（可能被 B站限制，需重新登录刷新 Cookie）', {
        bvid,
        lan: chosen.lan
      })
    }

    const body = await getSubtitleBody(chosen.url)
    const maxChars = Math.min(Math.max(Number(args.maxChars) || 50000, 100), 200000)

    let text = body.text
    let truncated = false
    if (text.length > maxChars) {
      text = text.slice(0, maxChars)
      truncated = true
    }

    const out = {
      bvid,
      cid,
      page: target?.page || page,
      hasSubtitle: true,
      subtitleSource: chosen.source,
      sourceLabel: SOURCE_LABEL[chosen.source] || chosen.source,
      sourceEvidence: chosen.evidence,
      lan: chosen.lan,
      lanDoc: chosen.lanDoc,
      available: list.map(s => ({
        lan: s.lan,
        lanDoc: s.lanDoc,
        source: s.source,
        sourceLabel: SOURCE_LABEL[s.source] || s.source,
        evidence: s.evidence
      })),
      cues: body.cues.length,
      chars: body.text.length,
      returnedChars: text.length,
      truncated,
      text
    }

    if (args.includeCues) out.cueList = body.cues

    return JSON.stringify(out, null, 2)
  }
}
