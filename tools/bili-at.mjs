/**
 * 工具：看「@我的」消息（评论区有人 @ 或回复我）
 * ============================================================================
 * 为什么需要：之前只能读某个视频的评论列表，看不到「谁在找我」。
 * 用户 @ 了看不见 → 不能回 → 等于聋了。
 *
 * 这个工具是**只读**的，返回的每条都带齐了回复所需的定位参数
 * （aid / rootId / sourceId），可以直接喂给 bili_comment_reply。
 *
 * @module tools/bili-at
 */
import { httpError } from '../integrations/fetch-client.mjs'
import { getAtMe, hasLoginCookie, getVideoByAid } from '../integrations/bili-api.mjs'

function fmtTime(sec) {
  if (!sec) return ''
  const d = new Date(sec * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default {
  name: 'bili_at',
  description:
    '查看「@我的」消息：评论区里谁 @ 了我、谁回复了我。返回内容、对方、所属视频，以及回复时需要的 aid/rootId/sourceId。只读。',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: '返回条数，默认 15，上限 50' }
    }
  },

  async execute(args = {}) {
    if (!(await hasLoginCookie())) {
      throw httpError('BILI_AUTH_REQUIRED', '@消息列表需要登录 Cookie')
    }
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 15))
    const items = await getAtMe({ limit })

    if (!items.length) {
      return { ok: true, count: 0, items: [], note: '最近没有新的 @ 或回复。' }
    }

    // ⭐ 补 bvid：@ 接口只给 aid，而 bili_video / bili_subtitle / bili_frames 只认 BV 号。
    //   不做这一步，模型拿到 aid 就没法继续查视频（用户 2026-10-23 实测踩到）。
    //   并发查 + 同 aid 去重，避免 15 条消息打 15 次接口。
    const aids = [...new Set(items.filter((x) => x.businessId === 1 && x.aid).map((x) => x.aid))]
    const map = new Map()
    await Promise.all(
      aids.map(async (aid) => {
        try {
          map.set(aid, await getVideoByAid(aid))
        } catch {
          /* 单个失败不影响其它条，下面降级成空 bvid */
        }
      })
    )

    return {
      ok: true,
      count: items.length,
      items: items.map((it) => {
        const v = map.get(it.aid) || {}
        const bvid = v.bvid || ''
        // 锚点 #reply<rpid> 直接落到那条评论，否则只能打开视频首页再自己找
        const anchor = it.sourceId ? `#reply${it.sourceId}` : ''
        return {
          user: it.user.name || String(it.user.mid),
          uid: it.user.mid,
          time: fmtTime(it.atTime),
          videoTitle: it.title || v.title || '',
          // ⭐ 优先给 bvid，aid 保留做兼容
          bvid,
          aid: it.aid,
          // 回复时用：root = 根评论（0 表示这条就是一级评论），parent = 要回到的那条
          rootId: it.rootId || it.sourceId,
          sourceId: it.sourceId,
          content: it.content,
          // 这条 @ 在哪儿：视频 + 具体评论楼
          position: bvid
            ? `视频 ${bvid} 的评论区 · 评论 rpid=${it.sourceId}`
            : `评论 rpid=${it.sourceId}（视频 aid=${it.aid}）`,
          link: v.bvid ? `https://www.bilibili.com/video/${bvid}${anchor}` : it.aid ? `https://www.bilibili.com/video/av${it.aid}${anchor}` : ''
        }
      }),
      note:
        '要查这个视频的内容：拿 items[].bvid 传给 bili_video / bili_subtitle / bili_frames / bili_vision（它们只认 BV 号，不认 aid）。' +
        '要回复某一条：bili_comment_reply 传 aid=该项 aid、rootId=该项 rootId、parent=该项 sourceId。' +
        '回复前先想清楚说什么——发出去别人就能看到，删不掉。'
    }
  }
}
