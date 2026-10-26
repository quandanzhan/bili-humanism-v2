/**
 * 章程记账（duty 任务说明的版本管理）
 * ============================================================================
 * 要解决什么问题：
 *   值班每一轮都要给模型一段任务说明（「本轮要做的」）。这段说明会随版本迭代，
 *   但用户可能自己改过它（加要求、删不喜欢的条款）。如果升级时直接覆盖，
 *   用户的改动就静默丢了。
 *
 * 借鉴 dsh-bili-scroll 的做法 —— 用 sha256 记账：
 *   · 记录「上次由程序铺设的那一版」的哈希
 *   · 升级时比对：文件哈希 == 记录哈希 → 用户没改过 → 直接覆盖为新版
 *   · 文件哈希 != 记录哈希 → 用户改过 → 保留用户那份，新版另存 `duty-v2.md.new`
 *   · 从没记过账的老文件 → 保守当成「用户改过」，只记账不覆盖
 *
 * 存哪：
 *   章程正文 `legacy/persona/duty-v2.md`（跟人格放一起，属于「它怎么干活」的一部分）
 *   哈希记录 `data/charter.sha256`
 *
 * @module gateway/charter
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

import { DATA_DIR, LEGACY_DIR as LEGACY } from './runtime.mjs'

const TEMPLATE_FILE = join(LEGACY, 'persona', 'duty-v2.md')
const HASH_FILE = join(DATA_DIR, 'charter.sha256')

/**
 * 内置默认章程（程序自带的那一版）。
 * 占位符：{{now}} {{weekday}} {{windows}} {{maxVideos}} {{extra}}
 */
export const DEFAULT_TEMPLATE = `现在是 {{now}}（Asia/Shanghai，星期{{weekday}}），本轮是你自己安排的值班时间（窗口 {{windows}}）。

本轮要做的：
1. 用 bili_search 挑 {{maxVideos}} 条左右你觉得值得看的视频（优先你记忆里关注过的 UP 主/话题，但别重复看过的）。
2. 对每条：先用 bili_video 看标题/简介/时长，再用 bili_subtitle 读字幕；
   字幕为空或明显不足时，用 bili_frames 取画面帧再判断。
   ⛔ 值班期间不要用 bili_asr：本地语音识别一个 3 分钟视频要 1~2 分钟、吃 800MB 内存，
      会把这轮值班拖到超时。字幕为空就老实说「没字幕，只看了画面色调」，不要把时间耗在听音频上。
3. 每条给一段 100 字以内的判断：它到底讲了什么、值不值得看完、有什么是标题没说清的。

硬要求：
- 只读，不要发评论、不要发私信、不要做任何对外发布动作。
- 没读到的内容不许猜；画面只看过几帧就说「抽样看了几帧」。
- 当前模型通道看不到图像时，只能依据 bili_frames 返回的像素统计说色调级结论，不许编画面里的人和物。
- 最后固定输出三行：
  【看过】BV号 · 标题（一行一条）
  【判断】不超过 120 字
  【记忆候选】一句话，写你这次真正学到/修正的东西；没有就写「无」
{{extra}}`

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function ensureDirs() {
  for (const p of [join(LEGACY, 'persona'), DATA_DIR]) {
    if (!existsSync(p)) mkdirSync(p, { recursive: true })
  }
}

function readRecorded() {
  try {
    if (existsSync(HASH_FILE)) return readFileSync(HASH_FILE, 'utf8').trim()
  } catch {
    /* ignore */
  }
  return ''
}

function writeRecorded(hash) {
  ensureDirs()
  writeFileSync(HASH_FILE, hash, 'utf8')
}

/**
 * 确保章程存在并与当前程序版本对齐。
 * **幂等**，可以在每次启动时调。
 * @returns {{action:string, file:string, hash:string, userEdited:boolean}}
 */
export function ensureCharter() {
  ensureDirs()
  const defHash = sha256(DEFAULT_TEMPLATE)
  const recorded = readRecorded()
  const exists = existsSync(TEMPLATE_FILE)

  if (!exists) {
    writeFileSync(TEMPLATE_FILE, DEFAULT_TEMPLATE, 'utf8')
    writeRecorded(defHash)
    return { action: 'created', file: TEMPLATE_FILE, hash: defHash, userEdited: false }
  }

  const cur = readFileSync(TEMPLATE_FILE, 'utf8')
  const curHash = sha256(cur)

  // 从未记账（老用户/老文件）：保守当成用户可能改过，只记账不覆盖
  if (!recorded) {
    writeRecorded(curHash)
    return { action: 'adopted', file: TEMPLATE_FILE, hash: curHash, userEdited: curHash !== defHash }
  }

  if (curHash === recorded) {
    // 用户没动过这份文件
    if (defHash !== recorded) {
      // 程序版本更新了 → 直接升级
      copyFileSync(TEMPLATE_FILE, TEMPLATE_FILE + '.bak')
      writeFileSync(TEMPLATE_FILE, DEFAULT_TEMPLATE, 'utf8')
      writeRecorded(defHash)
      return { action: 'upgraded', file: TEMPLATE_FILE, hash: defHash, userEdited: false }
    }
    return { action: 'unchanged', file: TEMPLATE_FILE, hash: curHash, userEdited: false }
  }

  // 用户改过
  if (defHash !== recorded) {
    const newFile = TEMPLATE_FILE + '.new'
    writeFileSync(newFile, DEFAULT_TEMPLATE, 'utf8')
    return { action: 'user-edited-new-saved', file: TEMPLATE_FILE, hash: curHash, userEdited: true, newFile }
  }
  return { action: 'user-edited', file: TEMPLATE_FILE, hash: curHash, userEdited: true }
}

/** 读当前章程正文（不存在就给默认） */
export function readCharter() {
  try {
    if (existsSync(TEMPLATE_FILE)) return readFileSync(TEMPLATE_FILE, 'utf8')
  } catch {
    /* ignore */
  }
  return DEFAULT_TEMPLATE
}

/** 写回章程（用户在前端改）；写完更新记账，避免下次被当成「程序版」覆盖 */
export function writeCharter(text) {
  ensureDirs()
  const body = String(text || '')
  if (!body.trim()) {
    const e = new Error('章程内容不能为空')
    e.code = 'INVALID_REQUEST'
    throw e
  }
  copyFileSync(TEMPLATE_FILE, TEMPLATE_FILE + '.bak')
  writeFileSync(TEMPLATE_FILE, body, 'utf8')
  writeRecorded(sha256(body))
  return { file: TEMPLATE_FILE, hash: sha256(body) }
}

/**
 * 渲染章程：把占位符换成当轮的实际值。
 * @param {{now?:string, weekday?:string, windows?:string, maxVideos?:number, extra?:string}} vars
 */
export function renderCharter(vars = {}) {
  const tpl = readCharter()
  return tpl
    .replace(/\{\{now\}\}/g, String(vars.now || ''))
    .replace(/\{\{weekday\}\}/g, String(vars.weekday || ''))
    .replace(/\{\{windows\}\}/g, String(vars.windows || ''))
    .replace(/\{\{maxVideos\}\}/g, String(vars.maxVideos || 1))
    .replace(/\{\{extra\}\}/g, vars.extra ? `\n补充要求：${vars.extra}` : '')
}

/** 状态（给面板看） */
export function charterStatus() {
  const exists = existsSync(TEMPLATE_FILE)
  const cur = exists ? readFileSync(TEMPLATE_FILE, 'utf8') : ''
  const recorded = readRecorded()
  const defHash = sha256(DEFAULT_TEMPLATE)
  return {
    file: TEMPLATE_FILE,
    exists,
    hash: exists ? sha256(cur) : null,
    recorded: recorded || null,
    defaultHash: defHash,
    userEdited: Boolean(recorded) && exists && sha256(cur) !== recorded,
    outOfDate: exists && sha256(cur) !== defHash,
    chars: cur.length,
    hasNew: existsSync(TEMPLATE_FILE + '.new'),
    preview: cur.slice(0, 300)
  }
}
