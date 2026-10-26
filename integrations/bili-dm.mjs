/**
 * B 站私信（会话列表 / 拉消息 / 发消息）
 * ============================================================================
 * 为什么要自己实现：V1 的 reply_service.py 用 Python 的 `bilibili_api` 库，
 * V2 是 Node，要么整条链路照搬 Python（等于没停 V1），要么自己调接口。
 * 这里选后者，只依赖 integrations/bili-api.mjs 的 vcRequest（它管 Cookie/UA/风控翻译）。
 *
 * 真实字段（2026-10-22 真机探测，和文档/记忆里的名字都不一样，别再猜）：
 *   · 会话列表项：talker_id / session_type / session_ts / unread_count / last_msg
 *   · 消息：sender_uid / receiver_id / msg_type / content(JSON 字符串) / timestamp / msg_key
 *   · content 解析后：msg_type=1 → {content}；=7 → 分享卡片 {id(就是 aid)/title/author/...}
 *
 * @module integrations/bili-dm
 */

import { httpError } from './fetch-client.mjs'
import { vcRequest, myUid, csrfToken } from './bili-api.mjs'

/** 会话类型：1=用户私信 */
const SESSION_TYPE_USER = 1

/**
 * 拉会话列表
 * @param {{size?:number}} [opts]
 * @returns {Promise<Array<{talker:number, ts:number, unread:number, lastMsg:Object|null}>>}
 */
export async function listSessions({ size = 30 } = {}) {
  const d = await vcRequest('/session_svr/v1/session_svr/get_sessions', {
    params: { session_type: SESSION_TYPE_USER, group_id: 0, size }
  })
  const list = d?.session_list || []
  return list.map((s) => ({
    talker: Number(s.talker_id || 0),
    ts: Number(s.session_ts || 0),
    unread: Number(s.unread_count || 0),
    lastMsg: s.last_msg || null
  }))
}

/**
 * 解析单条消息的正文
 * @param {Object} m - 原始消息
 * @returns {{kind:'text'|'card'|'image'|'other', text:string, aid:number|null}}
 */
export function parseMessage(m) {
  const type = Number(m?.msg_type || 0)
  let c = m?.content
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c)
    } catch {
      c = { content: c }
    }
  }
  if (!c || typeof c !== 'object') return { kind: 'other', text: '', aid: null }

  if (type === 1) return { kind: 'text', text: String(c.content || '').trim(), aid: null }
  if (type === 2) return { kind: 'image', text: '[对方发来一张图片]', aid: null }
  if (type === 7) {
    // 分享卡片：真实字段是 id/title/headline/author/source/thumb，没有 url/bvid/rid
    const rawId = c.id ?? c.rid
    const aid = /^[1-9][0-9]*$/.test(String(rawId ?? '')) ? Number(rawId) : null
    const title = String(c.title || c.headline || '').trim()
    const author = String(c.author || '').trim()
    const lines = ['分享了B站视频']
    if (title) lines.push(`《${title}》`)
    if (author) lines.push(`UP：${author}`)
    // ⚠️ 卡片里只有 aid 没有 BV 号（2026-10-23 真机复现：模型收到卡片后说
    // 「你没给 BV 号，查不了详情」——其实 id 就在手里，只是没写进正文它看不见）。
    // 把 aid 显式写进文本，模型就能直接拿它调 bili_video(aid=…)。
    if (aid) lines.push(`aid=${aid}（这就是视频编号，可直接用 bili_video 的 aid 参数查详情，不用再要 BV 号）`)
    return { kind: 'card', text: lines.join('\n'), aid }
  }
  return { kind: 'other', text: '', aid: null }
}

/**
 * 拉某个会话的消息（按时间正序返回）
 * @param {{talker:number, size?:number}} opts
 * @returns {Promise<Array<{key:string, from:number, to:number, type:number, ts:number, text:string, kind:string, aid:number|null}>>}
 */
export async function fetchMessages({ talker, size = 20 }) {
  if (!talker) throw httpError('INVALID_ARGUMENT', 'talker 不能为空')
  const d = await vcRequest('/svr_sync/v1/svr_sync/fetch_session_msgs', {
    params: { talker_id: talker, session_type: SESSION_TYPE_USER, size }
  })
  const list = d?.messages || []
  return list
    .map((m) => {
      const p = parseMessage(m)
      return {
        key: String(m.msg_key || m.msg_seqno || ''),
        from: Number(m.sender_uid || 0),
        to: Number(m.receiver_id || 0),
        type: Number(m.msg_type || 0),
        ts: Number(m.timestamp || 0),
        ...p
      }
    })
    .sort((a, b) => a.ts - b.ts)
}

/**
 * 稳定设备号：B站发私信要求带，随便变会被判异常
 * @returns {string}
 */
function devId() {
  const fixed = process.env.BILI_DM_DEV_ID
  if (fixed) return fixed
  // 由 BOT uid 派生一个固定值（同一台机器/账号永远一样）
  return 'AUTO' + '8A1F2C3D-4E5F-4A6B-9C7D-0E1F2A3B4C5D'
}

/**
 * 发私信
 * @param {{receiver:number, text:string}} opts
 * @returns {Promise<{msgKey:string, ts:number}>}
 */
export async function sendMessage({ receiver, text }) {
  const to = Number(receiver)
  const body = String(text || '').trim()
  if (!to) throw httpError('INVALID_ARGUMENT', 'receiver 不能为空')
  if (!body) throw httpError('INVALID_ARGUMENT', '回复内容为空')
  if (body.length > 800) throw httpError('INVALID_REQUEST', `回复过长（${body.length} 字），B站私信上限 800`)

  const me = await myUid()
  if (!me) throw httpError('BILI_AUTH_REQUIRED', '取不到 BOT 自己的 uid（Cookie 里的 DedeUserID 缺失）')
  const csrf = await csrfToken()
  if (!csrf) throw httpError('BILI_AUTH_REQUIRED', 'Cookie 里缺 bili_jct，无法发私信')

  const ts = Math.floor(Date.now() / 1000)
  const d = await vcRequest('/web_im/v1/web_im/send_msg', {
    form: {
      'msg[sender_uid]': String(me),
      'msg[receiver_id]': String(to),
      'msg[receiver_type]': '1',
      'msg[msg_type]': '1',
      'msg[msg_status]': '0',
      'msg[content]': JSON.stringify({ content: body }),
      'msg[timestamp]': String(ts),
      'msg[dev_id]': devId(),
      csrf,
      csrf_token: csrf
    }
  })
  return { msgKey: String(d?.msg_key || ''), ts: Number(d?.msg_content ? ts : ts) }
}

/** BOT 自己的 uid */
export { myUid }

/**
 * 发长消息：按段落切成多条私信发出去（B站单条上限 800）
 * ---------------------------------------------------------------------------
 * 「写了多少就发多少」——值班的完整分析往往 500~2000 字，直接 sendMessage 会
 * 因为超长被拒，截断又违背用户要求。所以按自然段落切，尽量不切断句子。
 *
 * @param {{receiver:number, text:string, maxLen?:number, maxParts?:number}} opts
 * @returns {Promise<{parts:number, sent:string[], skipped:number}>}
 */
export async function sendLongMessage({ receiver, text, maxLen = 680, maxParts = 6 }) {
  const raw = String(text || '').trim()
  if (!raw) throw httpError('INVALID_ARGUMENT', '内容为空')

  // 先按空行切段，段落仍超长就按句号切
  const blocks = raw.split(/\n{2,}/).flatMap((b) => {
    if (b.length <= maxLen) return [b]
    const out = []
    let buf = ''
    for (const seg of b.split(/(?<=[。！？；\n])/)) {
      if ((buf + seg).length > maxLen && buf) {
        out.push(buf)
        buf = seg
      } else {
        buf += seg
      }
    }
    if (buf) out.push(buf)
    return out
  })

  // 装箱：把小段拼回到 maxLen 以内，减少条数
  const parts = []
  let cur = ''
  for (const b of blocks) {
    if (!cur) cur = b
    else if (cur.length + 1 + b.length <= maxLen) cur += '\n' + b
    else {
      parts.push(cur)
      cur = b
    }
  }
  if (cur) parts.push(cur)

  const limited = parts.slice(0, maxParts)
  const skipped = Math.max(0, parts.length - limited.length)
  const sent = []
  for (let i = 0; i < limited.length; i++) {
    const head = limited.length > 1 ? `（${i + 1}/${limited.length}）` : ''
    const r = await sendMessage({ receiver, text: head + limited[i] })
    sent.push(r.msgKey)
    if (i < limited.length - 1) await new Promise((res) => setTimeout(res, 700)) // 防触发发送频率限制
  }
  return { parts: limited.length, sent, skipped }
}
