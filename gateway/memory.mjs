import { LEGACY_DIR, redactText } from './runtime.mjs'
/**
 * 记忆（可修正的长期理解）—— 与人格壳严格分离
 * ============================================================================
 * @module gateway/memory
 * @description 对应用户要求：「记忆那块是可修正的，搬过去要能继续改，不能写死成指令」。
 *
 * 存放：data/legacy/memory/
 *   notes.json         —— 长期记忆条目（CRUD，运行时随时改）
 *   chat-history.json  —— V1 聊天记录导出（79 条 history + 83 条 events，可编辑）
 *   state.sqlite3      —— V1 原件（只读查询，保留原貌，可回溯）
 *   ledger.sqlite      —— V1 读书账本原件
 *   runs.jsonl         —— V2 每次「AI 刷视频」的结果流水（追加）
 *
 * 设计要点：
 *   · 记忆**不写进 system prompt 的指令区**，而是作为「记忆参考」块注入，
 *     并明确告诉模型「可能过时、与边界冲突以边界为准」。
 *   · 所有写操作先备份 notes.json，永不静默丢失。
 *   · 记忆条目允许用户直接编辑/删除（前端 Memory 卡片）。
 *
 * @exports listNotes / addNote / updateNote / deleteNote / searchNotes
 * @exports buildMemoryBlock / chatHistory / appendRun / listRuns / memoryStats
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const LEGACY = LEGACY_DIR
const MEM_DIR = join(LEGACY, 'memory')
const NOTES = join(MEM_DIR, 'notes.json')
const CHAT = join(MEM_DIR, 'chat-history.json')
const RUNS = join(MEM_DIR, 'runs.jsonl')

function ensureDir() {
  try {
    mkdirSync(MEM_DIR, { recursive: true })
  } catch {
    /* 已存在 */
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function backup(file) {
  if (!existsSync(file)) return null
  const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    copyFileSync(file, bak)
    return bak
  } catch {
    return null
  }
}

function writeNotes(data) {
  ensureDir()
  backup(NOTES)
  writeFileSync(NOTES, JSON.stringify(data, null, 2), 'utf8')
  try {
    chmodSync(NOTES, 0o600)
  } catch {
    /* ignore */
  }
  return data
}

function loadNotesRaw() {
  const d = readJson(NOTES, null)
  if (!d || !Array.isArray(d.items)) {
    return {
      note: 'AI 的长期记忆，可随时修改/删除；不会写死成系统指令。',
      updatedAt: new Date().toISOString(),
      items: []
    }
  }
  return d
}

/** 全部记忆条目（按更新时间倒序） */
export function listNotes() {
  const d = loadNotesRaw()
  const items = [...d.items].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  return { ...d, items, count: items.length }
}

/**
 * 新增一条记忆
 * @param {{text: string, tags?: string[], source?: string}} input
 */
export function addNote(input = {}) {
  const text = String(input.text || '').trim()
  if (!text) {
    const err = new Error('记忆内容不能为空')
    err.code = 'INVALID_REQUEST'
    throw err
  }
  const d = loadNotesRaw()
  const item = {
    id: 'n-' + randomUUID().slice(0, 8),
    text: text.slice(0, 4000),
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 8) : [],
    source: input.source || 'manual',
    updatedAt: new Date().toISOString()
  }
  d.items.push(item)
  d.updatedAt = new Date().toISOString()
  writeNotes(d)
  return item
}

/** 修改记忆（text/tags） */
export function updateNote(id, patch = {}) {
  const d = loadNotesRaw()
  const it = d.items.find((x) => x.id === id)
  if (!it) {
    const err = new Error(`记忆不存在：${id}`)
    err.code = 'NOT_FOUND'
    throw err
  }
  if (patch.text !== undefined) {
    const t = String(patch.text).trim()
    if (!t) {
      const err = new Error('记忆内容不能为空')
      err.code = 'INVALID_REQUEST'
      throw err
    }
    it.text = t.slice(0, 4000)
  }
  if (Array.isArray(patch.tags)) it.tags = patch.tags.slice(0, 8)
  it.updatedAt = new Date().toISOString()
  d.updatedAt = it.updatedAt
  writeNotes(d)
  return it
}

/** 删除记忆 */
export function deleteNote(id) {
  const d = loadNotesRaw()
  const i = d.items.findIndex((x) => x.id === id)
  if (i < 0) {
    const err = new Error(`记忆不存在：${id}`)
    err.code = 'NOT_FOUND'
    throw err
  }
  const [removed] = d.items.splice(i, 1)
  d.updatedAt = new Date().toISOString()
  writeNotes(d)
  return removed
}

/** 关键词搜索（简单大小写不敏感包含匹配，够用） */
export function searchNotes(q, limit = 20) {
  const kw = String(q || '').trim().toLowerCase()
  const all = listNotes().items
  const hits = kw
    ? all.filter((x) => (x.text || '').toLowerCase().includes(kw) || (x.tags || []).join(',').toLowerCase().includes(kw))
    : all
  return hits.slice(0, Math.max(1, Math.min(200, Number(limit) || 20)))
}

/**
 * 生成注入 system prompt 的「记忆参考」块
 * @param {{limit?: number, query?: string, maxChars?: number}} [opts]
 */
export function buildMemoryBlock(opts = {}) {
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 12))
  const maxChars = Math.max(500, Math.min(20000, Number(opts.maxChars) || 6000))
  const items = opts.query ? searchNotes(opts.query, limit) : listNotes().items.slice(0, limit)
  if (!items.length) return ''
  const lines = []
  let used = 0
  for (const it of items) {
    const line = `- （${it.id}${it.tags?.length ? ' · ' + it.tags.join('/') : ''}）${String(it.text).replace(/\s+/g, ' ')}`
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length
  }
  return lines.join('\n')
}

/**
 * 读 V1 聊天记录（可编辑副本）
 * @param {{limit?: number, q?: string, kind?: 'history'|'events'|'both'}} [opts]
 */
export function chatHistory(opts = {}) {
  const d = readJson(CHAT, { counts: { history: 0, events: 0 }, history: [], events: [] })
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 30))
  const kw = String(opts.q || '').trim().toLowerCase()
  const pick = (arr) =>
    (kw
      ? arr.filter((x) => JSON.stringify(x).toLowerCase().includes(kw))
      : arr
    ).slice(-limit)
  const kind = opts.kind || 'both'
  return {
    exportedAt: d.exportedAt,
    counts: d.counts,
    note: d.note,
    history: kind === 'events' ? [] : pick(d.history || []),
    events: kind === 'history' ? [] : pick(d.events || [])
  }
}

/** 追加一次「AI 刷视频」的运行记录 */
export function appendRun(entry = {}) {
  ensureDir()
  const row = { at: new Date().toISOString(), ...entry }
  try {
    appendFileSync(RUNS, JSON.stringify(row) + '\n', 'utf8')
  } catch (e) {
    console.warn('[memory] 写 runs.jsonl 失败:', redactText(e.message))
  }
  return row
}

/** 最近的运行记录（倒序） */
export function listRuns(limit = 20) {
  if (!existsSync(RUNS)) return []
  const lines = readFileSync(RUNS, 'utf8').split('\n').filter(Boolean)
  const out = []
  for (let i = lines.length - 1; i >= 0 && out.length < Math.max(1, Math.min(200, limit)); i--) {
    try {
      out.push(JSON.parse(lines[i]))
    } catch {
      /* 跳过坏行 */
    }
  }
  return out
}

/** 记忆统计（给前端卡片副标题） */
export function memoryStats() {
  const n = listNotes()
  const chat = readJson(CHAT, { counts: { history: 0, events: 0 } })
  return {
    notes: n.count,
    history: chat.counts?.history || 0,
    events: chat.counts?.events || 0,
    runs: existsSync(RUNS) ? readFileSync(RUNS, 'utf8').split('\n').filter(Boolean).length : 0,
    dir: MEM_DIR,
    notesUpdatedAt: n.updatedAt || null
  }
}

/** 记忆目录（前端展示） */
export function memoryDir() {
  return MEM_DIR
}
