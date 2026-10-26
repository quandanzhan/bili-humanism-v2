import { dirname, join } from 'node:path'
import { DATA_DIR, redactText } from './runtime.mjs'
/**
 * 刷视频调度（固定 Asia/Shanghai 时区）
 * ============================================================================
 * @module gateway/schedule
 * @description 对应用户要求：「允许用户设置 AI 刷视频的时间，以及使用什么 AI 大模型接口，
 *              以上海时间为准」。
 *
 * 存储：data/schedule.json（600）
 * 首次生成时从 V1 的 bili-duty/config.json 播种（perDay / peakValley / noon / night）。
 *
 * ⚠️ 时区为什么要显式写死：
 *   V1 的窗口判断依赖服务器本地时间（CST），换台机器或改 TZ 就悄悄错位。
 *   这里所有判断都走 Intl.DateTimeFormat(timeZone:'Asia/Shanghai')，
 *   与服务器 TZ 无关，跨机器结果一致。
 *
 * 窗口语义：
 *   · start/end 为 HH:MM，闭区间；end 小于 start 表示跨夜（如 23:00-01:30）
 *   · perDay 为「该窗口每天最多跑几次」；顶层 perDay 为全天总上限
 *   · intervalMinutes 为两次运行之间的最小间隔（防止一个窗口里连刷）
 *
 * @exports TZ / loadSchedule / saveSchedule / shanghaiNow / stateOf
 * @exports nextRunAt / acquire / markRun / resetToday / scheduleFile
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync, mkdirSync } from 'node:fs'

export const TZ = 'Asia/Shanghai'
const FILE = process.env.BILI_HUMANISM_SCHEDULE || join(DATA_DIR, 'schedule.json')
const V1_DUTY = process.env.BILI_HUMANISM_V1_DUTY || ''

/** 上海时间（与服务器 TZ 无关） */
export function shanghaiNow(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23'
  })
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]))
  const hour = Number(p.hour)
  const minute = Number(p.minute)
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    hour,
    minute,
    minutes: hour * 60 + minute,
    text: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`,
    iso: d.toISOString()
  }
}

function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

function inRange(minutes, start, end) {
  const s = toMin(start)
  const e = toMin(end)
  if (s === null || e === null) return false
  if (s === e) return true // 00:00-00:00 视为全天
  if (s < e) return minutes >= s && minutes <= e
  // 跨夜：23:00-01:30 → minutes>=1380 || minutes<=90
  return minutes >= s || minutes <= e
}

/** 从 V1 值班配置播种 */
function buildSeed() {
  let v1 = {}
  try {
    v1 = JSON.parse(readFileSync(V1_DUTY, 'utf8'))
  } catch {
    /* V1 配置不存在就用默认 */
  }
  const windows = []
  if (v1.noon !== false) {
    windows.push({ id: 'noon', name: '午间', start: '12:00', end: '13:30', enabled: true, perDay: 2 })
  }
  if (v1.night !== false) {
    windows.push({ id: 'night', name: '夜间', start: '21:00', end: '23:30', enabled: true, perDay: 4 })
  }
  if (!windows.length) {
    windows.push({ id: 'evening', name: '晚间', start: '20:00', end: '22:00', enabled: true, perDay: 3 })
  }
  return {
    timezone: TZ,
    enabled: true,
    perDay: Number(v1.perDay) || 6,
    intervalMinutes: 45,
    windows,
    task: {
      channelId: '',
      maxVideos: 2,
      maxRounds: 6,
      allowComment: false,
      prompt: ''
    },
    seedFrom: existsSync(V1_DUTY) ? 'v1-bili-duty/config.json' : 'defaults',
    state: { date: '', runs: [] },
    updatedAt: new Date().toISOString()
  }
}

function writeRaw(data) {
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8')
    chmodSync(FILE, 0o600)
  } catch (e) {
    const err = new Error(`写入调度配置失败：${redactText(e.message)}`)
    err.code = 'SETTINGS_WRITE_FAILED'
    throw err
  }
  return data
}

function normalize(s) {
  const out = { ...s }
  out.timezone = TZ // 不允许改成别的时区
  out.perDay = Number(out.perDay) || 6
  out.intervalMinutes = Math.max(5, Number(out.intervalMinutes) || 45)
  out.windows = (Array.isArray(out.windows) ? out.windows : [])
    .map((w, i) => ({
      id: String(w.id || `w${i + 1}`).slice(0, 24),
      name: String(w.name || `时段${i + 1}`).slice(0, 24),
      start: String(w.start || '00:00'),
      end: String(w.end || '00:00'),
      enabled: w.enabled !== false,
      perDay: Math.max(1, Number(w.perDay) || 2)
    }))
    .filter((w) => toMin(w.start) !== null && toMin(w.end) !== null)
  out.task = {
    channelId: String(out.task?.channelId || ''),
    maxVideos: Math.max(1, Math.min(10, Number(out.task?.maxVideos) || 2)),
    maxRounds: Math.max(1, Math.min(12, Number(out.task?.maxRounds) || 6)),
    allowComment: out.task?.allowComment === true,
    prompt: String(out.task?.prompt || '').slice(0, 2000)
  }
  out.state = out.state && typeof out.state === 'object' ? out.state : { date: '', runs: [] }
  return out
}

/** 读配置（不存在则用 V1 配置播种） */
export function loadSchedule() {
  if (!existsSync(FILE)) return writeRaw(normalize(buildSeed()))
  try {
    return normalize(JSON.parse(readFileSync(FILE, 'utf8')))
  } catch {
    return writeRaw(normalize(buildSeed()))
  }
}

/** 合并保存（先备份） */
export function saveSchedule(patch = {}) {
  const cur = loadSchedule()
  const bak = `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    if (existsSync(FILE)) copyFileSync(FILE, bak)
  } catch {
    /* ignore */
  }
  const merged = {
    ...cur,
    ...patch,
    windows: patch.windows !== undefined ? patch.windows : cur.windows,
    task: { ...cur.task, ...(patch.task || {}) },
    state: patch.state !== undefined ? patch.state : cur.state,
    updatedAt: new Date().toISOString()
  }
  return writeRaw(normalize(merged))
}

/** 当天运行记录（跨天自动清零） */
function todayState(sched, now) {
  const st = sched.state || { date: '', runs: [] }
  if (st.date !== now.date) return { date: now.date, runs: [], recent: [] }
  return { date: st.date, runs: Array.isArray(st.runs) ? st.runs : [] }
}

/**
 * 当前状态（给前端）
 * @returns {Object} { now, timezone, windows[{...active,used}], todayRuns, nextRunAt }
 */
export function stateOf(sched = loadSchedule()) {
  const now = shanghaiNow()
  const st = todayState(sched, now)
  const windows = sched.windows.map((w) => {
    const used = st.runs.filter((r) => r.windowId === w.id).length
    return { ...w, active: w.enabled && inRange(now.minutes, w.start, w.end), used }
  })
  return {
    now,
    timezone: TZ,
    enabled: sched.enabled !== false,
    perDay: sched.perDay,
    intervalMinutes: sched.intervalMinutes,
    task: sched.task,
    windows,
    todayRuns: st.runs.length,
    runs: st.runs.slice(-10),
    inAnyWindow: windows.some((w) => w.active),
    nextRunAt: nextRunAt(sched)
  }
}

/**
 * 计算下一次可运行时间（最多往后找 24 小时，5 分钟粒度）
 * 只按「窗口 + 全天次数」判断，间隔限制交给 acquire()
 */
export function nextRunAt(sched = loadSchedule()) {
  if (sched.enabled === false) return null
  const now = shanghaiNow()
  const st = todayState(sched, now)
  if (st.runs.length >= sched.perDay) return null
  for (let add = 0; add <= 24 * 60; add += 5) {
    const t = now.minutes + add
    const dayShift = Math.floor(t / 1440)
    const mm = t % 1440
    // 只算当天（跨天要重新算额度，返回次日首个窗口起点即可）
    if (dayShift > 0) {
      const first = sched.windows.filter((w) => w.enabled).map((w) => toMin(w.start)).sort((a, b) => a - b)[0]
      if (first === undefined) return null
      const hh = String(Math.floor(first / 60)).padStart(2, '0')
      const mi = String(first % 60).padStart(2, '0')
      return { at: `${now.date} 次日 ${hh}:${mi}` }
    }
    for (const w of sched.windows) {
      if (!w.enabled) continue
      if (!inRange(mm, w.start, w.end)) continue
      if (st.runs.filter((r) => r.windowId === w.id).length >= w.perDay) continue
      const hh = String(Math.floor(mm / 60)).padStart(2, '0')
      const mi = String(mm % 60).padStart(2, '0')
      return { at: `${now.date} ${hh}:${mi}`, windowId: w.id, inMinutes: add }
    }
  }
  return null
}

/**
 * 判断当前是否该跑，并在允许时「占位」（写一条 running 记录）
 * 三道闸：开关 → 窗口 → 次数/间隔
 * @returns {{ok: boolean, reason: string, windowId?: string}}
 */
export function acquire(force = false) {
  const sched = loadSchedule()
  const now = shanghaiNow()
  if (!force && sched.enabled === false) return { ok: false, reason: 'SCHEDULE_DISABLED' }
  const st = todayState(sched, now)
  if (!force && st.runs.length >= sched.perDay) return { ok: false, reason: 'DAILY_LIMIT_REACHED' }

  const win = sched.windows.find((w) => w.enabled && inRange(now.minutes, w.start, w.end))
  if (!force && !win) return { ok: false, reason: 'OUTSIDE_WINDOW' }
  if (!force && win) {
    const used = st.runs.filter((r) => r.windowId === win.id).length
    if (used >= win.perDay) return { ok: false, reason: 'WINDOW_LIMIT_REACHED' }
  }
  // 间隔限制：用最后一次成功/开始时间
  if (!force && sched.intervalMinutes > 0 && st.runs.length) {
    const last = st.runs[st.runs.length - 1]
    const lastAt = Date.parse(last.at)
    if (Number.isFinite(lastAt) && Date.now() - lastAt < sched.intervalMinutes * 60000) {
      return { ok: false, reason: 'TOO_SOON' }
    }
  }
  return { ok: true, reason: force ? 'FORCED' : 'OK', windowId: win?.id }
}

/** 记录一次运行结果（写入 schedule.state 与 runs.jsonl） */
export function markRun(entry = {}) {
  const sched = loadSchedule()
  const now = shanghaiNow()
  const st = todayState(sched, now)
  st.runs.push({
    at: new Date().toISOString(),
    date: now.date,
    timeText: now.text,
    windowId: entry.windowId || '',
    ...entry
  })
  // 只保留当天最近 200 条，避免文件无限膨胀
  st.runs = st.runs.slice(-200)
  saveSchedule({ state: st })
  return st.runs[st.runs.length - 1]
}

/** 清空今天的运行计数（前端「重置今日」） */
export function resetToday() {
  const now = shanghaiNow()
  saveSchedule({ state: { date: now.date, runs: [] } })
  return stateOf()
}

/** 配置文件路径（前端展示） */
export function scheduleFile() {
  return FILE
}
