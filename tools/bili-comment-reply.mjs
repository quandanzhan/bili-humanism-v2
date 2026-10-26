/**
 * 工具：在 B 站评论区发/回复评论（写操作）
 * ============================================================================
 * ⚠️ 这是整个系统里**唯一会让别人看见**的动作。出错收不回，所以过五关：
 *
 *   1. 参数关     —— aid / 内容 / 定位参数必须齐
 *   2. **看懂自检关** —— 必须交代「我凭什么看懂了」：
 *                     · basis 必须包含 subtitle 或 frames，只给 meta（标题简介）直接拒
 *                     · understood 至少 30 字，且不能是「看完了挺好的」这类空话
 *                     · confidence=low 自己都没把握 → 不许发
 *                     ⭐ 这条是用户 2026-10-23 明确要求的：评论前先自检解析是否准确
 *   3. 打扰关     —— 不许放链接/联系方式/陌生人 @；内容不能带引战要素
 *   4. 重复关     —— 同一视频 24h 只许一次；内容与最近发过的太像也拒
 *   5. 写守卫关   —— gateway/writes.mjs（总开关 / 频率 / 长度）
 *
 * 接口：POST /x/v2/reply/add
 *   oid=aid  type=1  message=正文  root=根 rpid  parent=被回复 rpid
 *
 * @module tools/bili-comment-reply
 */
import { httpError } from '../integrations/fetch-client.mjs'
import { apiPost, hasLoginCookie, getUserName } from '../integrations/bili-api.mjs'
import { guardWrite, recordWrite, alreadyCommented, similarRecent } from '../gateway/writes.mjs'

/** 复述式开头：用户明确要求「不要靠分享视频内容凑评论，要出自己的见解」 */
const RECAP = [
  /这(个|条|期)?视频(主要)?(讲|说|介绍|分享|讨论|告诉|提到)了?/,
  /主要(内容|观点|讲了)/,
  /(视频|片子|这期)里(说|讲|提到|认为)/,
  /(UP|up|up主|作者)(说|讲|提到|认为|分享)了?/
]

/** 第一人称观点标记：没有这些就说明它只是在复述 */
const OPINION = /(我觉得|我认为|在我看来|我的看法|我反而|我更关心|让我想到|有意思的是|说实话|说句实话|我同意|我不太同意|我自己的经验|我遇到过)/

/** 优先使用评论负责人，未配置时继承回复负责人；不提供个人默认值。 */
const ALLOWED_AT_UID = Number(process.env.COMMENT_AT_UID || process.env.REPLY_TALKER) || 0

/** 只有标题/简介等于没看懂内容，评论只能是「标题读后感」，不受欢迎 */
const BASIS_ENUM = ['subtitle', 'frames', 'meta']

/** 会打扰别人的东西：外链、联系方式、@ 陌生人 */
const DISTURBING = [
  { re: /https?:\/\/|www\./i, why: '带外部链接' },
  { re: /(?:微信|vx|V信|weixin)\s*[:：]?\s*[A-Za-z0-9_-]{5,}/i, why: '带微信号' },
  { re: /(?:qq|Q群|企鹅群)\s*[:：]?\s*\d{5,}/i, why: '带 QQ/群号' },
  { re: /(?:加我|私聊我|关注我|点我头像|互粉|互关)/, why: '引流话术' },
  { re: /@[^\s@]{2,20}/, why: '点名叫人（会打扰到对方）' }
]

/** 空话检测：这些词单独出现不构成「我看懂了」 */
const EMPTY_TALK = /^(好看|不错|挺好|还行|支持|路过|来了|沙发|第一|哈哈|牛逼|厉害了|学习了|收藏了|已看完|看完了)[。！!.~\s]*$/

function checkUnderstanding(args) {
  const raw = Array.isArray(args.basis) ? args.basis : args.basis ? [args.basis] : []
  const basis = raw.map((b) => String(b).toLowerCase()).filter((b) => BASIS_ENUM.includes(b))
  if (!basis.length) {
    throw httpError('SELFCHECK_FAILED', '必须先说明依据：basis 给 subtitle（字幕）/ frames（画面）/ meta（标题简介），至少一项')
  }
  // ⭐ 核心规则：只有元信息 = 没看懂视频内容
  if (!basis.includes('subtitle') && !basis.includes('frames')) {
    throw httpError(
      'SELFCHECK_FAILED',
      '只有标题/简介不算看懂内容（basis 里必须包含 subtitle 或 frames）。' +
        '请先用 bili_subtitle 读字幕，或用 bili_frames 看画面，再决定要不要评论。'
    )
  }

  const understood = String(args.understood || '').trim()
  if (understood.length < 30) {
    throw httpError(
      'SELFCHECK_FAILED',
      `「看懂了什么」只写了 ${understood.length} 字，太短。请具体写出：这条视频讲了哪几件事、你凭哪段字幕/哪几帧判断的。`
    )
  }
  if (EMPTY_TALK.test(understood)) {
    throw httpError('SELFCHECK_FAILED', '「看懂了什么」不能是空话，要写具体内容')
  }

  const confidence = String(args.confidence || '').toLowerCase()
  if (!['high', 'medium', 'low'].includes(confidence)) {
    throw httpError('SELFCHECK_FAILED', 'confidence 必须是 high / medium / low')
  }
  if (confidence === 'low') {
    throw httpError(
      'SELFCHECK_FAILED',
      '你自己给的是 low（没把握）——没看懂就不要评论，避免给 UP 主和观众带来困扰。'
    )
  }
  return { basis, understood, confidence }
}

function checkDisturbing(message, allowedNames = [], skipAt = false) {
  // 先把「允许 @ 的人」从文本里摘掉，再检查其它 @ —— 否则自己加的 @主人 会被自己拦下
  let probe = message
  for (const n of allowedNames) {
    if (n) probe = probe.split('@' + n).join('')
  }
  for (const d of DISTURBING) {
    // 回复别人的评论时，@ 对方是正常对话，不算打扰（用户 2026-10-23 明确要求不做限制）
    if (skipAt && d.why.includes('点名叫人')) continue
    if (d.re.test(probe)) {
      throw httpError('COMMENT_REJECTED', `评论里有${d.why}，会打扰到别人，去掉再发`)
    }
  }
  if (/\n{3,}/.test(message)) {
    throw httpError('COMMENT_REJECTED', '评论里空行太多，像刷屏，精简一下')
  }
}

/**
 * 观点校验：不许「转述视频内容」，必须有第一人称判断。
 * 这是用户 2026-10-23 明确要求：评论要体现在看懂了之后自己的见解，不是复述。
 */
function checkOpinion(message) {
  for (const re of RECAP) {
    if (re.test(message)) {
      throw httpError(
        'COMMENT_REJECTED',
        '这条在复述视频内容（「视频讲了…/UP主说了…」）。' +
          '改成你自己的判断：你认同哪一点、哪一点你不买账、它让你想到什么。别当转述器。'
      )
    }
  }
  if (!OPINION.test(message)) {
    throw httpError(
      'COMMENT_REJECTED',
      '没有读出你自己的态度。加一句明确判断（「我觉得…」「我反而…」「让我想到…」），' +
        '只描述视频说了什么不算评论。'
    )
  }
}

export default {
  name: 'bili_comment_reply',
  description:
    '在B站评论区发评论或回复别人（真的发出去，别人能看见）。' +
    '⚠️ 调用前必须先自检：确实读过字幕或用 bili_frames 看过画面，才填 basis / understood / confidence。' +
    '只看了标题简介一律会被拒绝。回复 @我的 时 aid/root/parent 从 bili_at 结果里取。',
  parameters: {
    type: 'object',
    properties: {
      aid: { type: 'number', description: '视频 aid（数字）。bili_at 结果里的 aid' },
      message: { type: 'string', description: '要发出去的正文，≤400 字；不放链接、联系方式、不 @ 人' },
      basis: {
        type: 'array',
        items: { type: 'string', enum: BASIS_ENUM },
        description:
          '你判断的依据：subtitle（读到了字幕）/ frames（看了画面）/ meta（只看了标题简介）。' +
          '必须含 subtitle 或 frames —— 只给 meta 会被拒。'
      },
      understood: {
        type: 'string',
        description:
          '自检：你到底看懂了什么（≥30 字）。具体写这条视频讲了哪几件事、你凭哪段内容判断的。写不出来就说明没看懂，不要评论。'
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: '对「我真的看懂了」的把握。low 会被直接拒绝（没看懂就别发）。'
      },
      mentionOwner: { type: 'boolean', description: '是否在评论里 @ 主人（默认 true，会按昵称自动附加）' },
      parent: { type: 'number', description: '被回复的评论 rpid（bili_at 里的 sourceId）；发新评论则不传' },
      root: { type: 'number', description: '根评论 rpid（bili_at 里的 rootId）；回复一级评论时与 parent 相同' }
    },
    required: ['aid', 'message', 'basis', 'understood', 'confidence']
  },

  async execute(args = {}) {
    const aid = Number(args.aid)
    const message = String(args.message || '').trim()
    const parent = Number(args.parent) || 0
    const root = Number(args.root) || parent

    if (!Number.isFinite(aid) || aid <= 0) throw httpError('INVALID_ARGUMENT', 'aid 必须是正整数')
    if (!message) throw httpError('INVALID_ARGUMENT', '评论内容不能为空')
    if (message.length < 4) throw httpError('INVALID_ARGUMENT', '评论太短，像是在应付')
    if (!(await hasLoginCookie())) throw httpError('BILI_AUTH_REQUIRED', '发评论需要登录 Cookie')

    // ② 看懂自检（用户明确要求：先确认真的看懂了，再决定评不评论）
    const self = checkUnderstanding(args)

    // ③ 打扰关 / 观点关 / @ 主人 —— 按场景分流
    //    · 发新评论（comment_new）：这是公开表态，必须有自己见解，并 @ 主人
    //    · 回复别人（comment_reply）：属于对话，不做 @ 限制，也不强制表态
    const kind0 = parent > 0 ? 'comment_reply' : 'comment_new'
    let finalMessage = message
    let atName = ''
    if (kind0 === 'comment_new') {
      checkOpinion(message)
      if (args.mentionOwner !== false && ALLOWED_AT_UID > 0) {
        atName = await getUserName(ALLOWED_AT_UID).catch(() => '')
        if (atName && !message.includes('@' + atName)) finalMessage = `${message} @${atName}`
      }
      checkDisturbing(finalMessage, [atName].filter(Boolean))
    } else {
      checkDisturbing(message, [], true)
    }

    // ④ 重复关
    const dup = alreadyCommented(aid, 24)
    if (dup.hit) {
      throw httpError(
        'COMMENT_DUPLICATE',
        `这个视频 24 小时内已经评论过了（${String(dup.at).slice(11, 19)}：「${String(dup.text).slice(0, 30)}」）。` +
          '同一个视频反复出现自己的评论就是刷屏，不再发。'
      )
    }
    const sim = similarRecent(finalMessage)
    if (sim.hit) {
      throw httpError('COMMENT_DUPLICATE', '这条内容跟最近发过的几乎一样，换个说法或者别发')
    }

    // ⑤ 写守卫（开关 / 频率 / 长度）
    const kind = kind0 // comment_new / comment_reply，决定写守卫的分类型开关
    guardWrite(kind, { text: finalMessage, target: `av${aid}` })

    const finalRoot = parent > 0 ? (root > 0 ? root : parent) : 0

    let result
    try {
      result = await apiPost(
        '/x/v2/reply/add',
        {
          oid: aid,
          type: 1,
          message: finalMessage,
          root: finalRoot,
          parent,
          plat: 1,
          // @ 人必须同时给 at_name_to_mid，否则前面的「@昵称」只是纯文本不会被渲染成 @
          ...(atName ? { at_name_to_mid: JSON.stringify({ [atName]: ALLOWED_AT_UID }) } : {})
        },
        { referer: `https://www.bilibili.com/video/av${aid}` }
      )
      recordWrite({
        kind,
        target: `av${aid}/rpid:${parent || 'new'}`,
        text: finalMessage,
        ok: true,
        // 把自检结论一起留痕：以后回看能知道「它当时凭什么认为看懂了」
        result: {
          rpid: String(result?.rpid || ''),
          basis: self.basis.join('+'),
          confidence: self.confidence,
          understood: self.understood.slice(0, 200)
        }
      })
    } catch (e) {
      recordWrite({ kind, target: `av${aid}`, text: finalMessage, ok: false, error: e.message })
      throw e
    }

    const rpid = String(result?.rpid || result?.rpid_str || '')
    return {
      ok: true,
      kind,
      aid,
      root: finalRoot,
      parent,
      rpid,
      message: finalMessage,
      at: atName || null,
      selfCheck: { basis: self.basis, confidence: self.confidence, understood: self.understood },
      link: rpid ? `https://www.bilibili.com/video/av${aid}#reply${rpid}` : `https://www.bilibili.com/video/av${aid}`,
      note: `已发出（${finalMessage.length} 字），依据：${self.basis.join('/')}，自评把握：${self.confidence}${atName ? `，已 @ ${atName}` : ''}。`
    }
  }
}
