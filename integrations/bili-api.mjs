/**
 * B 站接口封装（给 bili-search / bili-video / bili-subtitle / bili-comments 共用）
 * ============================================================================
 * 只做「调接口 + 归一化 + 错误码翻译」，不含业务判断。
 *
 * 免登录可用：view（视频详情）、reply（评论）
 * 需要 Cookie：search/type（站内搜索）—— 无 Cookie 时 B站会返回风控页（-412）
 *
 * Cookie 来源（按优先级）：
 *   1. 环境变量 BILI_SESSDATA / BILI_JCT / BILI_BUVID3 / BILI_DEDEUSERID
 *   2. secrets/loader.mjs 的 bili 组（通过 BILI_CREDENTIAL 指定 JSON 文件）
 * 缺 buvid3 时按 B站格式随机生成一个（搜索接口没有它会直接 -412）。
 *
 * ⚠️ Cookie 永远不会出现在返回值里；错误信息也不打印 Cookie。
 */

import { randomUUID, createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { fetchJson, httpError, DEFAULT_UA } from './fetch-client.mjs'

const API_BASE = () => (process.env.BILI_API_BASE || 'https://api.bilibili.com').replace(/\/$/, '')
const WEB_BASE = () => (process.env.BILI_WEB_BASE || 'https://www.bilibili.com').replace(/\/$/, '')

/** 仅在环境凭据和文件元数据未变化时复用缓存。 */
let credCache = null
let credCacheVersion = ''

/**
 * 读取 B 站凭据
 * @returns {Promise<{SESSDATA:string, bili_jct:string, buvid3:string, DedeUserID:string}>}
 */
async function getCred() {
  const { loadSecrets, BILI_CRED_FILE } = await import('../secrets/loader.mjs')
  const fromEnv = {
    SESSDATA: process.env.BILI_SESSDATA || '',
    bili_jct: process.env.BILI_JCT || '',
    buvid3: process.env.BILI_BUVID3 || '',
    DedeUserID: process.env.BILI_DEDEUSERID || ''
  }

  let fileVersion = 'missing'
  if (!fromEnv.SESSDATA) {
    try {
      const stat = statSync(BILI_CRED_FILE, { bigint: true })
      fileVersion = `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.ino}`
    } catch { /* 文件缺失或不可读时不沿用旧登录态。 */ }
  }
  const version = createHash('sha256').update(JSON.stringify([fromEnv, BILI_CRED_FILE, fileVersion])).digest('hex')
  if (credCache && credCacheVersion === version) return credCache

  if (fromEnv.SESSDATA) {
    credCache = fromEnv
    credCacheVersion = version
    return credCache
  }

  try {
    const s = await loadSecrets()
    credCache = {
      SESSDATA: s?.bili?.SESSDATA || '',
      bili_jct: s?.bili?.bili_jct || '',
      buvid3: s?.bili?.buvid3 || '',
      DedeUserID: s?.bili?.DedeUserID || ''
    }
  } catch {
    credCache = fromEnv
  }
  credCacheVersion = version
  return credCache
}

/**
 * 是否已配置登录 Cookie
 * @returns {Promise<boolean>}
 */
export async function hasLoginCookie() {
  const c = await getCred()
  return Boolean(c.SESSDATA)
}

/**
 * 生成一个形如 B站 buvid3 的随机值（仅用于让接口不返回 -412）
 * @returns {string}
 */
function genBuvid3() {
  const u = randomUUID().toUpperCase()
  return `${u.slice(0, 8)}-${u.slice(9, 13)}-${u.slice(14, 18)}-${u.slice(19, 23)}-${u.slice(24)}infoc`
}

/**
 * 组装请求头（含 Cookie）
 * @param {string} referer
 * @returns {Promise<Record<string,string>>}
 */
async function biliHeaders(referer) {
  const c = await getCred()
  const parts = []
  if (c.SESSDATA) parts.push(`SESSDATA=${c.SESSDATA}`)
  if (c.bili_jct) parts.push(`bili_jct=${c.bili_jct}`)
  if (c.DedeUserID) parts.push(`DedeUserID=${c.DedeUserID}`)
  parts.push(`buvid3=${c.buvid3 || genBuvid3()}`)

  return {
    'User-Agent': DEFAULT_UA,
    'Referer': referer || `${WEB_BASE()}/`,
    'Origin': WEB_BASE(),
    'Cookie': parts.join('; '),
    'Accept': 'application/json, text/plain, */*'
  }
}

/**
 * 调接口并翻译错误码
 * @param {string} path - 形如 /x/web-interface/view
 * @param {Record<string,string|number>} params
 * @param {{ referer?: string, signed?: boolean }} [opts] - signed=true 走 WBI 签名（拼 wts/w_rid）
 * @returns {Promise<any>} data 字段
 */
async function apiGet(path, params = {}, opts = {}) {
  let url
  if (opts.signed) {
    url = API_BASE() + path + '?' + (await wbiQuery(params))
  } else {
    const u = new URL(API_BASE() + path)
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
    }
    url = u.toString()
  }

  const { json } = await fetchJson(url, {
    headers: await biliHeaders(opts.referer),
    timeoutMs: Number(process.env.BILI_TIMEOUT_MS) || 12000
  })

  const code = json?.code
  if (code === 0) return json.data

  const map = {
    '-101': ['BILI_AUTH_REQUIRED', '该接口需要登录（B站 Cookie 缺失或已过期）'],
    '-111': ['BILI_AUTH_REQUIRED', 'CSRF 校验失败（bili_jct 缺失或无效）'],
    '-352': ['BILI_RISK_CONTROL', '触发 B站风控校验，请稍后再试或更换 Cookie'],
    '-412': ['BILI_RISK_CONTROL', '请求被风控拦截（多为缺少 Cookie/buvid3）'],
    '-404': ['BILI_NOT_FOUND', '资源不存在'],
    '62002': ['BILI_NOT_FOUND', '稿件不可见（可能已删除或设为私密）'],
    '62004': ['BILI_NOT_FOUND', '稿件审核中'],
    '62012': ['BILI_NOT_FOUND', '仅 UP 主自己可见'],
    '-400': ['BILI_NOT_FOUND', 'B站返回参数错误（常见于番剧/课程等非普通稿件，或 BV 号无效）']
  }
  const hit = map[String(code)]
  throw httpError(hit ? hit[0] : 'BILI_API_ERROR', hit ? hit[1] : `B站接口返回错误 code=${code}`, {
    apiCode: code,
    apiMessage: json?.message,
    path
  })
}

/**
 * ── WBI 签名 ─────────────────────────────────────────────────────────────
 * 真实探测结论（2026-10-22）：未签名的 /x/player/v2 对 AI 字幕返回
 * subtitle_url:""（有列表但拿不到正文地址），而签名的 /x/player/wbi/v2
 * 返回带 auth_key 的完整地址。字幕正文必须走 WBI 签名接口。
 * 算法：nav 接口取 wbi_img 的 img/sub key → 固定混淆表打乱取前 32 位为 salt
 * → 参数按 key 排序拼 query（值剔除 !'()* 字符）→ md5(query+salt)=w_rid。
 */
const WBI_MAP = [46, 47, 18, 2, 53, 4, 24, 22, 37, 52, 15, 50, 36, 29, 14, 8,
  44, 35, 40, 32, 43, 34, 9, 30, 26, 6, 20, 28, 50, 51, 39, 33, 48, 41, 45,
  17, 16, 49, 8, 21, 10, 3, 12, 31, 9, 42, 5, 23, 27, 19, 13, 12, 4, 31, 25,
  23, 11, 10, 49, 42, 26, 25, 1, 26, 13, 20, 27]

let wbiKeysCache = null   // { salt, fetchedAt }
const WBI_KEY_TTL = 10 * 60 * 1000

async function getWbiSalt() {
  if (wbiKeysCache && Date.now() - wbiKeysCache.fetchedAt < WBI_KEY_TTL) return wbiKeysCache.salt
  const d = await apiGet('/x/web-interface/nav', {}, {})
  const img = String(d?.wbi_img?.img_url || '').split('/').pop().split('.')[0]
  const sub = String(d?.wbi_img?.sub_url || '').split('/').pop().split('.')[0]
  if (!img || !sub) throw httpError('BILI_API_ERROR', '无法获取 WBI 签名密钥（nav 接口异常）')
  const raw = img + sub
  const salt = Array.from({ length: 32 }, (_, i) => raw[WBI_MAP[i]] || '').join('')
  wbiKeysCache = { salt, fetchedAt: Date.now() }
  return salt
}

/** 给参数附加 wts + w_rid，返回完整 query string */
async function wbiQuery(params) {
  const salt = await getWbiSalt()
  const q = { ...params, wts: Math.floor(Date.now() / 1000) }
  const clean = (v) => String(v).replace(/[!'()*]/g, '')
  const query = Object.keys(q).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(clean(q[k]))}`)
    .join('&')
  const w_rid = createHash('md5').update(query + salt).digest('hex')
  return `${query}&w_rid=${w_rid}`
}

/**
 * 解析 BV 号：支持纯 BV、带 ?p=n 的完整链接、av 号不支持
 * @param {string} input
 * @returns {{ bvid: string, page: number }}
 * @throws {Error} BILI_INVALID_BVID
 */
export function parseBvid(input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw httpError('BILI_INVALID_BVID', 'BV 号不能为空')

  // 从 URL 或文本里抠 BV 号；前缀 bv/BV 大小写都认（B站实际只认大写前缀，
  // 但用户手输经常写成小写 bv，这里统一规范化，正文 10 位保持原样区分大小写）
  const m = /[Bb][Vv]([0-9A-Za-z]{10})/.exec(raw)
  if (!m) {
    throw httpError('BILI_INVALID_BVID', `无法识别 BV 号：${raw}（应形如 BV1GJ411x7h7）`)
  }

  let page = 1
  const pm = /[?&]p=(\d+)/.exec(raw)
  if (pm) page = Math.max(1, Number(pm[1]))

  return { bvid: `BV${m[1]}`, page }
}

/**
 * 秒 → mm:ss / hh:mm:ss
 * @param {number} sec
 * @returns {string}
 */
export function fmtDuration(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  const s = n % 60
  const pad = (x) => String(x).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * 视频详情
 * @param {string} bvid
 * @returns {Promise<object>} 归一化后的详情
 */
export async function getVideo(bvid) {
  const d = await apiGet('/x/web-interface/view', { bvid }, { referer: `${WEB_BASE()}/video/${bvid}` })

  const pages = Array.isArray(d.pages)
    ? d.pages.map(p => ({
        cid: p.cid,
        page: p.page,
        part: p.part,
        durationSec: p.duration,
        durationText: fmtDuration(p.duration)
      }))
    : []

  return {
    bvid: d.bvid,
    aid: d.aid,
    title: String(d.title || '').trim(),
    owner: { mid: d.owner?.mid, name: d.owner?.name, face: d.owner?.face },
    description: String(d.desc || '').trim(),
    durationSec: d.duration,
    durationText: fmtDuration(d.duration),
    pubdate: d.pubdate,
    pubdateText: d.pubdate ? new Date(d.pubdate * 1000).toISOString() : '',
    cover: d.pic,
    category: d.tname || '',
    stat: {
      view: d.stat?.view ?? 0,
      danmaku: d.stat?.danmaku ?? 0,
      reply: d.stat?.reply ?? 0,
      like: d.stat?.like ?? 0,
      coin: d.stat?.coin ?? 0,
      favorite: d.stat?.favorite ?? 0,
      share: d.stat?.share ?? 0
    },
    pages,
    cid: pages[0]?.cid || d.cid
  }
}

/**
 * 判断字幕来源：AI 自动识别 / 人工上传
 *
 * ⚠️ 判定顺序来自 2026-10-22 的真实接口观察，不是猜的：
 *    实测一条 `lan=ai-zh / lan_doc=中文 / type=1 / ai_type=0 / url=aisubtitle.hdslb.com/bfs/ai_subtitle/...`
 *    确实是 **AI 自动生成**字幕。也就是说 **`ai_type=0` 并不代表「人工」**，
 *    早期按 ai_type 优先判定的实现会把 AI 字幕错标成人工。
 *
 * 因此顺序改为：lan 前缀 → 字幕文件域名/路径 → lan_doc 文案 → 最后才看 type。
 * 每一步都记录 evidence，便于事后追溯「为什么判成这个」。
 *
 * @param {object} s - player/v2 返回的原始字幕项
 * @returns {{ source: 'ai'|'manual'|'unknown', evidence: string }}
 */
export function classifySubtitle(s) {
  const lan = String(s?.lan || '')
  const lanDoc = String(s?.lan_doc || '')
  const url = String(s?.subtitle_url || s?.subtitle_url_v2 || '')

  // 1) 最可靠：lan 前缀 ai-*（ai-zh / ai-en / ai-ja…）
  if (/^ai[-_]/i.test(lan)) return { source: 'ai', evidence: `lan=${lan}` }

  // 2) 字幕文件落在 AI 字幕专用存储上
  if (/aisubtitle\.hdslb\.com/i.test(url) || /\/ai_subtitle\//i.test(url)) {
    return { source: 'ai', evidence: 'url=aisubtitle/ai_subtitle' }
  }

  // 3) 人工字幕通常挂在普通对象存储路径下
  if (/\/bfs\/subtitle\//i.test(url)) return { source: 'manual', evidence: 'url=/bfs/subtitle/' }

  // 4) 文案兜底
  if (/自动生成|自动识别|ai\s*字幕|ai\s*生成/i.test(lanDoc)) return { source: 'ai', evidence: `lan_doc=${lanDoc}` }
  if (/人工|up主|字幕组|投稿者/i.test(lanDoc)) return { source: 'manual', evidence: `lan_doc=${lanDoc}` }

  // 5) 弱信号：ai_type=1 明确是 AI；ai_type=0 不能用（实测会误判）
  if (s?.ai_type === 1) return { source: 'ai', evidence: 'ai_type=1' }
  if (s?.type === 1) return { source: 'ai', evidence: 'type=1(弱信号)' }

  return { source: 'unknown', evidence: `无明确标记(lan=${lan},type=${s?.type},ai_type=${s?.ai_type})` }
}

/**
 * 取字幕列表
 * @param {string} bvid
 * @param {number} cid
 * @returns {Promise<Array<{lan:string, lanDoc:string, url:string, source:string, evidence:string}>>}
 */
export async function getSubtitleList(bvid, cid) {
  // 必须走 WBI 签名接口：未签名的 /x/player/v2 对 AI 字幕返回 subtitle_url:""
  const d = await apiGet(
    '/x/player/wbi/v2',
    { bvid, cid, platform: 'web' },
    { referer: `${WEB_BASE()}/video/${bvid}`, signed: true }
  )

  const list = d?.subtitle?.subtitles || []
  return list.map(s => {
    const cls = classifySubtitle(s)
    // v2 里 //aisubtitle... 是协议相对地址；v2 字段优先，v2 空时退回 v1
    const url = s.subtitle_url || s.subtitle_url_v2 || ''
    return {
      lan: s.lan,
      lanDoc: s.lan_doc,
      url,
      source: cls.source,
      evidence: cls.evidence,
      isLock: Boolean(s.is_lock)
    }
  })
}

/**
 * 拉取字幕正文
 * @param {string} rawUrl - 字幕 JSON 地址（可能是 // 开头）
 * @returns {Promise<{cues: Array<{from:number,to:number,content:string}>, text: string}>}
 */
export async function getSubtitleBody(rawUrl) {
  const url = rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl
  if (!/^https?:\/\//i.test(url)) {
    throw httpError('BILI_API_ERROR', `字幕地址不可用：${rawUrl}`, { rawUrl })
  }

  const { json } = await fetchJson(url, {
    headers: { 'User-Agent': DEFAULT_UA, 'Referer': `${WEB_BASE()}/` },
    timeoutMs: Number(process.env.BILI_TIMEOUT_MS) || 12000
  })

  const body = Array.isArray(json?.body) ? json.body : []
  if (!body.length) {
    throw httpError('EMPTY_RESULT', '字幕文件为空', { url })
  }

  const cues = body.map(c => ({
    from: Number(c.from) || 0,
    to: Number(c.to) || 0,
    content: String(c.content || '').trim()
  }))

  // 合并相邻重复行（自动字幕常见连续重复）
  const lines = []
  for (const c of cues) {
    if (!c.content) continue
    if (lines[lines.length - 1] !== c.content) lines.push(c.content)
  }

  return { cues, text: lines.join('\n') }
}

/**
 * 热门评论
 * @param {number} aid
 * @param {{ ps?: number, pn?: number, sort?: 0|1|2 }} [opts] - sort: 0 按时间 / 1 按点赞 / 2 按热度
 * @returns {Promise<{total:number, page:number, size:number, comments:Array}>}
 */
export async function getComments(aid, opts = {}) {
  const { ps = 20, pn = 1, sort = 2 } = opts
  const limit = Math.min(Math.max(Number(ps) || 20, 1), 50)

  const d = await apiGet(
    '/x/v2/reply',
    { type: 1, oid: aid, sort, ps: limit, pn },
    { referer: `${WEB_BASE()}/video/av${aid}` }
  )

  const raw = Array.isArray(d?.replies) ? d.replies : []
  const pin = d?.upper?.top?.upper ? d.upper.top : null

  const normalize = (r) => ({
    rpid: r.rpid,
    user: {
      mid: r.member?.mid,
      name: r.member?.uname,
      level: r.member?.level_info?.current_level ?? null
    },
    content: String(r.content?.message || '').trim(),
    like: r.like ?? 0,
    replyCount: r.rcount ?? 0,
    ctime: r.ctime,
    ctimeText: r.ctime ? new Date(r.ctime * 1000).toISOString() : '',
    isUp: r?.member?.mid === d?.upper?.mid && Boolean(d?.upper?.mid)
  })

  const comments = raw.filter(r => r?.content?.message).map(normalize)

  // 置顶评论单独标注（若与列表重复则打标）
  let pinned = null
  if (pin) {
    pinned = normalize(pin)
    pinned.pinned = true
    const idx = comments.findIndex(c => c.rpid === pinned.rpid)
    if (idx >= 0) comments[idx].pinned = true
    else comments.unshift(pinned)
  }

  return {
    total: d?.page?.count ?? comments.length,
    page: Number(d?.page?.num) || pn,
    size: Number(d?.page?.size) || limit,
    comments
  }
}

/**
 * B 站站内搜索（视频）
 * @param {string} keyword
 * @param {{ page?: number, pageSize?: number }} [opts]
 * @returns {Promise<{keyword:string, page:number, total:number, results:Array}>}
 */
export async function searchVideos(keyword, opts = {}) {
  const kw = String(keyword ?? '').trim()
  if (!kw) throw httpError('INVALID_ARGUMENT', '关键词不能为空')

  const page = Math.max(1, Number(opts.page) || 1)

  if (!(await hasLoginCookie())) {
    throw httpError(
      'BILI_AUTH_REQUIRED',
      'B站站内搜索需要登录 Cookie（SESSDATA）。未配置时接口返回风控页，无法搜索。',
      {
        hint: '设置 BILI_CREDENTIAL 指向凭据 JSON 文件，或设置 BILI_SESSDATA 等环境变量',
        endpoint: '/x/web-interface/search/type'
      }
    )
  }

  const d = await apiGet(
    '/x/web-interface/search/type',
    { search_type: 'video', keyword: kw, page },
    { referer: `${WEB_BASE()}/search?keyword=${encodeURIComponent(kw)}` }
  )

  const list = Array.isArray(d?.result) ? d.result : []
  const results = list.map(v => ({
    bvid: v.bvid,
    aid: v.aid,
    title: String(v.title || '').replace(/<[^>]+>/g, '').trim(),
    author: v.author,
    mid: v.mid,
    durationText: typeof v.duration === 'string' ? v.duration : fmtDuration(v.duration),
    play: v.play ?? 0,
    danmaku: v.video_review ?? 0,
    favorites: v.favorites ?? 0,
    pubdate: v.pubdate,
    description: String(v.description || '').replace(/<[^>]+>/g, '').trim(),
    url: `https://www.bilibili.com/video/${v.bvid}`
  }))

  return {
    keyword: kw,
    page,
    total: d?.numResults ?? d?.numPages ?? results.length,
    results
  }
}

export { API_BASE, WEB_BASE }

// ---------------------------------------------------------------- 音频（给 bili_asr 用）
/**
 * 取音频直链（DASH 的第一条 audio，按码率取最高）
 * ---------------------------------------------------------------------------
 * 为什么要自己取：V1 的 asr.py 用 yt-dlp 下载，2026-10-22 实测被 B站
 * 反爬挡住（HTTP 412 Precondition Failed）。我们本来就有带 Cookie 的请求头，
 * 直接走 playurl 更稳，也不依赖 yt-dlp 的版本适配。
 *
 * @param {string} bvid
 * @param {number|string} cid
 * @returns {Promise<{url:string, bandwidth:number, mimeType:string, durationSec:number}>}
 * @throws {Error} BILI_AUTH_REQUIRED / BILI_NOT_FOUND
 */
export async function getAudioUrl(bvid, cid) {
  const d = await apiGet('/x/player/playurl', { bvid, cid, fnval: 16, fourk: 1 })
  const dash = d?.dash
  const list = dash?.audio || []
  if (!list.length) {
    // 老视频只有 durl（音视频合一），退回第一个分片
    const durl = d?.durl?.[0]?.url
    if (durl) return { url: durl, bandwidth: 0, mimeType: 'video/mp4', durationSec: Number(d?.timelength || 0) / 1000 }
    throw httpError('BILI_AUTH_REQUIRED', '拿不到音频流（可能需要登录 Cookie）', { bvid, cid })
  }
  const best = [...list].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0]
  return {
    url: best.baseUrl || best.base_url,
    bandwidth: best.bandwidth || 0,
    mimeType: best.mimeType || best.mime_type || 'audio/mp4',
    durationSec: Math.round(Number(dash.duration) || 0)
  }
}

/**
 * 下载音频到本地文件（带 Cookie/Referer，B站 CDN 会校验）
 * @param {string} url - getAudioUrl 返回的直链
 * @param {string} destPath - 目标文件路径（建议 .m4s）
 * @returns {Promise<{path:string, bytes:number}>}
 */
export async function downloadAudio(url, destPath) {
  const { writeFile } = await import('node:fs/promises')
  const headers = await biliHeaders(`${WEB_BASE()}/`)
  const r = await fetch(url, {
    headers: { 'User-Agent': headers['User-Agent'], Referer: headers.Referer, Cookie: headers.Cookie },
    signal: AbortSignal.timeout(Number(process.env.BILI_AUDIO_TIMEOUT_MS) || 120000)
  })
  if (!r.ok) throw httpError('BILI_HTTP_ERROR', `音频下载失败 ${r.status}`, { status: r.status })
  const buf = Buffer.from(await r.arrayBuffer())
  await writeFile(destPath, buf)
  return { path: destPath, bytes: buf.length }
}

// ---------------------------------------------------------------- 私信（给 reply-loop 用）
/**
 * 私信接口在 api.vc.bilibili.com 上（不是 api.bilibili.com），Cookie/UA 要求更严：
 * Referer 必须是 message.bilibili.com，否则 -412。
 * @param {string} path
 * @param {{method?:string, params?:Object, form?:Object, referer?:string}} [opts]
 */
export async function vcRequest(path, opts = {}) {
  const { method = 'GET', params = {}, form = null, referer = 'https://message.bilibili.com/' } = opts
  const base = (process.env.BILI_VC_BASE || 'https://api.vc.bilibili.com').replace(/\/$/, '')
  const u = new URL(base + path)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
  }
  const headers = await biliHeaders(referer)
  const init = { method, headers, signal: AbortSignal.timeout(Number(process.env.BILI_TIMEOUT_MS) || 12000) }
  if (form) {
    init.method = 'POST'
    init.headers = { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }
    init.body = new URLSearchParams(form).toString()
  }
  const r = await fetch(u, init)
  const json = await r.json().catch(() => null)
  const code = json?.code
  if (code === 0) return json.data
  const map = {
    '-101': ['BILI_AUTH_REQUIRED', '私信接口需要登录（Cookie 缺失或过期）'],
    '-111': ['BILI_AUTH_REQUIRED', 'CSRF 校验失败（bili_jct 无效）'],
    '-352': ['BILI_RISK_CONTROL', '私信接口触发风控'],
    '-400': ['INVALID_REQUEST', '私信接口参数错误'],
    '21010': ['BILI_NOT_FOUND', '对方不接受陌生人私信'],
    '25005': ['BILI_NOT_FOUND', '消息内容被拦截（可能含敏感词）']
  }
  const hit = map[String(code)]
  throw httpError(hit ? hit[0] : 'BILI_API_ERROR', hit ? hit[1] : `私信接口返回 code=${code}`, {
    apiCode: code, apiMessage: json?.message, path
  })
}

/** 当前 Cookie 对应的账号 uid（BOT 自己） */
export async function myUid() {
  const c = await getCred()
  return Number(c.DedeUserID || 0) || 0
}

/** CSRF token（发私信必须带） */
export async function csrfToken() {
  const c = await getCred()
  return String(c.bili_jct || '')
}

// ---------------------------------------------------------------- 写操作（发评论）
/**
 * POST 到 api.bilibili.com（表单编码 + csrf）
 * 写接口都在主域，且必须带 csrf=bili_jct，少一个直接 -111。
 * @param {string} path
 * @param {Record<string,string|number>} form
 * @param {{referer?:string}} [opts]
 */
export async function apiPost(path, form = {}, opts = {}) {
  const csrf = await csrfToken()
  if (!csrf) throw httpError('BILI_AUTH_REQUIRED', 'Cookie 缺 bili_jct，无法执行写操作')
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(form)) {
    if (v !== undefined && v !== null) body.set(k, String(v))
  }
  body.set('csrf', csrf)
  body.set('csrf_token', csrf)

  const url = API_BASE() + path
  const headers = await biliHeaders(opts.referer)
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(Number(process.env.BILI_TIMEOUT_MS) || 15000)
  })
  const json = await r.json().catch(() => null)
  const code = json?.code
  if (code === 0) return json.data
  const map = {
    '-101': ['BILI_AUTH_REQUIRED', '该操作需要登录（Cookie 失效）'],
    '-111': ['BILI_AUTH_REQUIRED', 'CSRF 校验失败（bili_jct 无效）'],
    '-352': ['BILI_RISK_CONTROL', '触发 B站风控，写操作被拦'],
    '-400': ['INVALID_REQUEST', '参数错误'],
    '-403': ['BILI_FORBIDDEN', '没有权限执行该操作（可能被拉黑/未绑定手机/等级不足）'],
    '12002': ['BILI_FORBIDDEN', '评论区已关闭'],
    '12006': ['BILI_FORBIDDEN', '评论被折叠或已删除'],
    '12051': ['BILI_RATE_LIMITED', '评论太快，被限流了'],
    '12061': ['BILI_RATE_LIMITED', '评论频率超限']
  }
  const hit = map[String(code)]
  throw httpError(hit ? hit[0] : 'BILI_API_ERROR', hit ? hit[1] : `写操作失败 code=${code}`, {
    apiCode: code, apiMessage: json?.message, path
  })
}

/**
 * 取「@我的」消息列表（评论区被人 @ 或回复）
 * @param {{limit?:number}} [opts]
 * @returns {Promise<Array<Object>>}
 */
export async function getAtMe({ limit = 20 } = {}) {
  const d = await apiGet('/x/msgfeed/at', { build: 0, mobi_app: 'web', platform: 'web' })
  const items = d?.items || []
  return items.slice(0, Math.max(1, Math.min(50, limit))).map((it) => {
    const item = it.item || {}
    return {
      id: String(it.id || ''),
      atTime: Number(it.at_time || 0),
      user: { mid: Number(it.user?.mid || 0), name: String(it.user?.uname || '') },
      // business_id=1 是视频稿件；subject_id 就是 aid
      businessId: Number(item.business_id || 0),
      aid: Number(item.subject_id || 0),
      rootId: Number(item.root_id || 0),
      sourceId: Number(item.source_id || 0),
      uri: String(item.uri || ''),
      title: String(item.title || ''),
      content: String(item.source_content || '').trim(),
      raw: String(item.source_content || '').trim()
    }
  })
}

/**
 * 取用户昵称（评论 @ 人要用昵称，不能用 uid）
 * 用 /x/web-interface/card，免签名。
 * @param {number|string} mid
 * @returns {Promise<string>}
 */
export async function getUserName(mid) {
  const d = await apiGet('/x/web-interface/card', { mid })
  const name = d?.card?.name || d?.card?.uname || ''
  return String(name).trim()
}

/**
 * aid（数字）→ bvid（BV 号）
 * ---------------------------------------------------------------------------
 * 为什么要这个：`bili_at`（@我的）接口只给 aid，而 bili_video / bili_subtitle /
 * bili_frames 全都只认 BV 号 —— 模型拿到 aid 就卡住，没法继续查视频。
 * 2026-10-23 用户实测反馈「@模型时模型无法读取 BV 号」，就是这里断了。
 *
 * @param {number|string} aid
 * @returns {Promise<{bvid:string, title:string, durationSec:number}>}
 */
export async function getVideoByAid(aid) {
  const n = Number(aid)
  if (!Number.isFinite(n) || n <= 0) throw httpError('INVALID_ARGUMENT', 'aid 必须是正整数')
  const d = await apiGet('/x/web-interface/view', { aid: n })
  return {
    bvid: String(d?.bvid || ''),
    title: String(d?.title || ''),
    durationSec: Number(d?.duration || 0)
  }
}

/**
 * 取视频流直链（给 NAS 用 ffmpeg 抽帧）
 * 与 getAudioUrl 的区别：这个是 dash.video，不是 dash.audio。
 * @param {string} bvid
 * @param {number|string} cid
 * @returns {Promise<{url:string, width:number, height:number, codecs:string, bandwidth:number, durationSec:number}>}
 */
export async function getVideoUrl(bvid, cid) {
  const d = await apiGet('/x/player/playurl', { bvid, cid, fnval: 16, fourk: 1 })
  const list = d?.dash?.video || []
  if (!list.length) throw httpError('BILI_NOT_FOUND', '拿不到视频流（可能需要登录 Cookie）', { bvid, cid })
  // 取分辨率最高的；同分辨率取带宽高的
  const best = [...list].sort((a, b) => (b.width * b.height - a.width * a.height) || (b.bandwidth - a.bandwidth))[0]
  return {
    url: best.baseUrl || best.base_url,
    width: Number(best.width) || 0,
    height: Number(best.height) || 0,
    codecs: String(best.codecs || ''),
    bandwidth: Number(best.bandwidth) || 0,
    durationSec: Number(d?.dash?.duration) || 0
  }
}
