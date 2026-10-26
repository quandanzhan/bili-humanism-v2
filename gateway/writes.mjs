/**
 * 写操作守卫（对外发布类动作的唯一闸门）
 * ============================================================================
 * 为什么要单独一层：
 *   「读」错了只是它自己看到错的；「写」错了是**别人会看见**——评论发出去就收不回。
 *   所以所有写工具（发评论回复、以后可能的关注/点赞）都必须先过这里，
 *   而不是各个工具自己判断开关。
 *
 * 三道闸：
 *   1. 总开关 + 分类型开关（settings.writes）
 *   2. 频率限制（每分钟 / 每小时），防被模型刷屏或触发 B站风控
 *   3. 审计日志（data/writes.jsonl），每一条写都留痕，出问题能回溯
 *
 * 默认值取向（2026-10-23 用户明确要求「评论区回复这类写操作权限」）：
 *   · enabled=true          总开关开
 *   · allowCommentReply=true  回复别人可以
 *   · allowNewComment=false   主动在视频下发新评论**默认关**（那是刷屏，不是对话）
 *
 * @module gateway/writes
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { load } from './settings.mjs'

import { DATA_DIR, redactText, redactData } from './runtime.mjs'
const LOG_FILE = join(DATA_DIR, 'writes.jsonl')

const DEFAULTS = {
  enabled: true,
  allowCommentReply: true,
  allowNewComment: false,
  maxPerHour: 12,
  maxPerMinute: 2,
  maxChars: 400
}

/** 当前写策略（settings.writes 与默认值合并） */
export function writePolicy() {
  let cur = {}
  try {
    cur = load()?.writes || {}
  } catch {
    cur = {}
  }
  return { ...DEFAULTS, ...cur }
}

/** 最近写记录（只读最后 300 行，够算频率了） */
function recentWrites() {
  try {
    if (!existsSync(LOG_FILE)) return []
    const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-300)
    return lines.map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

function httpErr(code, message, data) {
  const e = new Error(message)
  e.code = code
  if (data) e.data = data
  return e
}

/**
 * 闸门检查。不通过直接抛（带 code，前端能显示原因）。
 * @param {string} kind - 'comment_reply' | 'comment_new'
 * @param {{text?:string, target?:string}} [detail]
 * @returns {{policy:Object}}
 */
export function guardWrite(kind, detail = {}) {
  const p = writePolicy()

  if (!p.enabled) {
    throw httpErr('WRITE_DISABLED', '写操作总开关是关的（控制台「写权限」里打开）')
  }
  if (kind === 'comment_reply' && !p.allowCommentReply) {
    throw httpErr('WRITE_DISABLED', '「回复评论」被单独关掉了')
  }
  if (kind === 'comment_new' && !p.allowNewComment) {
    throw httpErr('WRITE_DISABLED', '「主动发新评论」默认关闭——那属于刷屏，需要手动打开')
  }

  const text = String(detail.text || '')
  if (text.length > p.maxChars) {
    throw httpErr('INVALID_REQUEST', `内容太长（${text.length} 字），上限 ${p.maxChars}`)
  }

  const now = Date.now()
  const list = recentWrites()
  const inMinute = list.filter((w) => now - Date.parse(w.at) < 60_000)
  const inHour = list.filter((w) => now - Date.parse(w.at) < 3_600_000)
  if (inMinute.length >= p.maxPerMinute) {
    throw httpErr('WRITE_RATE_LIMITED', `一分钟内已写 ${inMinute.length} 次（上限 ${p.maxPerMinute}），先等等`)
  }
  if (inHour.length >= p.maxPerHour) {
    throw httpErr('WRITE_RATE_LIMITED', `一小时内已写 ${inHour.length} 次（上限 ${p.maxPerHour}）`)
  }
  return { policy: p }
}

/**
 * 记一笔写操作（成功与失败都记，失败原因也要留痕）
 * @param {{kind:string, target?:string, text?:string, ok:boolean, error?:string, result?:any}} entry
 */
export function recordWrite(entry = {}) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(
      LOG_FILE,
      JSON.stringify({
        at: new Date().toISOString(),
        kind: entry.kind || 'unknown',
        target: entry.target || '',
        ok: entry.ok !== false,
        text: String(entry.text || '').slice(0, 300),
        ...(entry.error ? { error: redactText(entry.error).slice(0, 300) } : {}),
        ...(entry.result ? { result: entry.result } : {})
      }) + '\n',
      'utf8'
    )
  } catch {
    /* 审计写失败不能挡住主流程，但至少要让它出现在 stdout */
    console.error('[writes] 审计日志写入失败')
  }
}

/** 写操作统计（给前端卡片） */
export function writeStats() {
  const list = recentWrites()
  const now = Date.now()
  return {
    policy: writePolicy(),
    total: list.length,
    lastHour: list.filter((w) => now - Date.parse(w.at) < 3_600_000).length,
    lastMinute: list.filter((w) => now - Date.parse(w.at) < 60_000).length,
    recent: redactData(list.slice(-10).reverse())
  }
}

/**
 * 同一个视频最近是不是已经评论过
 * ---------------------------------------------------------------------------
 * 「不要给别人带来困扰」最直接的落地：同一个视频下面反复出现自己的评论，
 * 在别人眼里就是刷屏。默认 24 小时内只允许一次。
 * @param {number|string} aid
 * @param {number} withinHours
 * @returns {{hit:boolean, at?:string, text?:string}}
 */
export function alreadyCommented(aid, withinHours = 24) {
  const key = `av${aid}`
  const cut = Date.now() - withinHours * 3_600_000
  const hit = recentWrites()
    .filter((w) => w.ok !== false && String(w.target || '').startsWith(key))
    .filter((w) => Date.parse(w.at) > cut)
    .pop()
  return hit ? { hit: true, at: hit.at, text: hit.text } : { hit: false }
}

/**
 * 这条内容是不是跟最近发过的某条太像（防复制粘贴式刷屏）
 * 用「前 20 字相同」做粗判——比编辑距离便宜，也够挡住模板化重复。
 * @param {string} text
 * @param {number} lookback 最近多少条
 * @returns {{hit:boolean, at?:string, text?:string}}
 */
export function similarRecent(text, lookback = 20) {
  const head = String(text || '').replace(/\s+/g, '').slice(0, 20)
  if (head.length < 8) return { hit: false }
  const list = recentWrites().filter((w) => w.ok !== false).slice(-lookback)
  for (const w of list) {
    const other = String(w.text || '').replace(/\s+/g, '').slice(0, 20)
    if (other && other === head) return { hit: true, at: w.at, text: w.text }
  }
  return { hit: false }
}
