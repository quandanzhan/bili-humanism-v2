/**
 * 日报：按天累积值班结果，生成一份可读的 Markdown，并在跨天时推送
 * ============================================================================
 * 为什么要单独一层：
 *   攒批（scheduler 里那套）解决的是「一天 25 条私信刷屏」，但它只是把多轮**合并推送**，
 *   内容仍是零散的「第 N 轮」。用户要的是**一天一份日报**——能从头读到尾那种。
 *
 * 设计：
 *   · 每轮值班结果追加到 `data/digest/YYYY-MM-DD.md`，一条一个 `## 时间` 小节
 *   · 每条抽出 `【看过】BVxxx` 行做索引，日报开头列「今天看了哪几条」
 *   · 跨天时（下一次值班发现日期变了）把**昨天**的日报推一次私信，推过就记状态不再推
 *   · 状态存 `data/digest-state.json`，重启不重复推
 *
 * 为什么不做「每天 23:59 定时推」：值班窗口是 00:00-05:30 和 12:00-13:30，
 * 23:59 大概率没有 tick 在跑，定时器不可靠。用「跨天检测」天然贴合值班节奏。
 *
 * @module gateway/digest
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DATA_DIR } from './runtime.mjs'
const DIGEST_DIR = join(DATA_DIR, 'digest')
const STATE_FILE = join(DATA_DIR, 'digest-state.json')

function ensure() {
  if (!existsSync(DIGEST_DIR)) mkdirSync(DIGEST_DIR, { recursive: true })
}

function shanghaiDate(d = new Date()) {
  // 与调度器同一口径：固定上海时区，不受服务器 TZ 影响
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  return s // en-CA 输出 YYYY-MM-DD
}

function fileOf(date) {
  return join(DIGEST_DIR, `${date}.md`)
}

function loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8')) || {}
  } catch {
    /* 坏文件当作没状态 */
  }
  return {}
}

function saveState(patch = {}) {
  ensure()
  const cur = loadState()
  writeFileSync(STATE_FILE, JSON.stringify({ ...cur, ...patch }, null, 2), 'utf8')
  return { ...cur, ...patch }
}

/**
 * 追加一轮结果到当天日报。
 * @param {{timeText?:string, text:string, tools?:string[], ok?:boolean}} entry
 * @returns {{date:string, file:string, rounds:number}}
 */
export function appendToDigest(entry = {}) {
  ensure()
  const date = shanghaiDate()
  const f = fileOf(date)
  const body = String(entry.text || '').trim()
  if (!body) return { date, file: f, rounds: countRounds(f) }

  const head = existsSync(f) ? readFileSync(f, 'utf8') : `# 值班日报 ${date}\n`
  const time = entry.timeText || new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())
  const tools = Array.isArray(entry.tools) && entry.tools.length ? `\n\n> 工具：${[...new Set(entry.tools)].join(' / ')}` : ''
  const mark = entry.ok === false ? '（本轮失败）' : ''
  const section = `\n## ${time}${mark}\n\n${body}${tools}\n`
  writeFileSync(f, head.replace(/\s*$/, '') + '\n' + section, 'utf8')
  return { date, file: f, rounds: countRounds(f) }
}

function countRounds(file) {
  try {
    if (!existsSync(file)) return 0
    // 只数「## 9:05」/「## 14:30」这种时间小节，不数正文里模型自己写的 ## 标题
    return (readFileSync(file, 'utf8').match(/^##\s+\d{1,2}:\d{2}/gm) || []).length
  } catch {
    return 0
  }
}

/** 把任何日期写法归一成 YYYY-MM-DD（借鉴 dsh-bili-scroll 2.0.1：带时间的不该被整行丢掉） */
export function normalizeDate(input) {
  const s = String(input || '').trim()
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  return m ? m[1] : shanghaiDate()
}

/** 读某天日报（默认今天）；不传日期返回今天。允许传 "2026-10-23 14:00" 这种带时间的 */
export function readDigest(date) {
  const d = date ? normalizeDate(date) : shanghaiDate()
  const f = fileOf(d)
  if (!existsSync(f)) return { date: d, exists: false, markdown: '', rounds: 0 }
  const md = readFileSync(f, 'utf8')
  return { date: d, exists: true, markdown: md, rounds: countRounds(f), chars: md.length }
}

/** 列出有日报的日期（最近 N 天，倒序） */
export function listDigests(limit = 14) {
  ensure()
  try {
    return readdirSync(DIGEST_DIR)
      .filter((x) => /^\d{4}-\d{2}-\d{2}\.md$/.test(x))
      .map((x) => x.replace(/\.md$/, ''))
      .sort()
      .reverse()
      .slice(0, Math.max(1, Math.min(90, limit)))
      .map((d) => ({ date: d, rounds: countRounds(fileOf(d)) }))
  } catch {
    return []
  }
}

/**
 * 抽出当天所有轮的「【判断】」行 —— 这就是当天最有信息量的一句话集合。
 * 不做模型二次提炼（那要多一次调用、还可能编），直接取它自己写下的结论。
 * @param {string} [date]
 * @returns {string[]}
 */
export function highlights(date) {
  const d = readDigest(date)
  if (!d.exists) return []
  const out = []
  for (const line of d.markdown.split('\n')) {
    const idx = line.indexOf('【判断】')
    if (idx < 0) continue
    // 取标记之后的部分，清掉 markdown 粗体/列表符/冒号/缩进——
    // 模型有时写「**【判断】** xxx」或「【判断】：xxx」，死抠格式会漏（dsh-bili-scroll 2.0.1 同类坑）
    let v = line.slice(idx + '【判断】'.length)
    v = v.replace(/^[\s*:：\-]+/, '').replace(/\*+$/, '').trim()
    if (v) out.push(v)
  }
  return out
}

/**
 * 按天汇总的一句话结论：取最后一轮的【判断】当主句，
 * 前面几轮的并列成分句（最多 3 句），超过就省略。
 */
export function dailySummary(date) {
  const hs = highlights(date)
  if (!hs.length) return ''
  const pick = hs.slice(-3)
  return pick.length === 1 ? pick[0] : pick.join(' ')
}

/**
 * 把某天日报压成一段适合私信推送的文本：
 * 开头「今天看了哪几条」（从 【看过】 行抽），正文各轮按时间顺序。
 */
export function digestForPush(date) {
  const d = readDigest(date)
  if (!d.exists) return null
  const lines = d.markdown.split('\n')
  const watched = [...new Set(
    lines
      .filter((l) => l.includes('【看过】'))
      .map((l) => {
        const i = l.indexOf('【看过】')
        return l.slice(i + '【看过】'.length).replace(/^[\s*:：\-]+/, '').replace(/\*+$/, '').trim()
      })
      .filter(Boolean)
  )]
  const sum = dailySummary(d.date)
  const head =
    `【值班日报 ${d.date}】共 ${d.rounds} 轮${watched.length ? ` · 看了 ${watched.length} 条` : ''}\n` +
    (sum ? `\n一句话：${sum}\n` : '')
  return { date: d.date, rounds: d.rounds, watched, summary: sum, text: head + '\n' + d.markdown }
}

/** 昨天/今天判定，供调度器跨天时使用 */
export function todayKey() {
  return shanghaiDate()
}

export function yesterdayKey() {
  return shanghaiDate(new Date(Date.now() - 86400_000))
}

/**
 * 跨天检测：如果昨天的日报还没推过，就推出去。
 * 由调度器在每轮值班开始时调用（不依赖定时器，因为值班窗口里才有 tick）。
 * @returns {Promise<{pushed:boolean, date?:string, reason?:string}>}
 */
export async function maybePushYesterday(sendFn) {
  const st = loadState()
  const y = yesterdayKey()
  const d = digestForPush(y)
  if (!d) return { pushed: false, reason: `昨天（${y}）没有日报` }
  if (st.pushedDates && st.pushedDates.includes(y)) return { pushed: false, reason: `昨天日报已推过` }
  if (typeof sendFn !== 'function') return { pushed: false, reason: '没有发送函数' }
  await sendFn(d.text)
  const pushedDates = [...new Set([...(st.pushedDates || []), y])].slice(-30)
  saveState({ pushedDates, lastPushedAt: new Date().toISOString() })
  return { pushed: true, date: y }
}

export function digestState() {
  const st = loadState()
  return { ...st, today: todayKey(), yesterday: yesterdayKey(), dir: DIGEST_DIR }
}
