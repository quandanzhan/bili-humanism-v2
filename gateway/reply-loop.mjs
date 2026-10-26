/**
 * B 站私信回复循环（接管 V1 的 reply_service.py）
 * ============================================================================
 * 为什么要有它：V1 的 reply_service.py 由 systemd timer 每 20 秒拉起一次，
 * 一直是线上唯一在跑「和主人聊天」的通道。要停 V1 就必须先让 V2 接住这条链路，
 * 否则一停 timer 业务就断。
 *
 * 与 V1 的关键差别：
 *   · 人格来自 legacy/persona（语气外壳），记忆来自 gateway/memory（可修正），
 *     两者物理分开；V1 是直接读 HOME/AGENTS.md 一个大字符串。
 *   · 模型走 V2 的通道队列（models/router.mjs），会自己降级；V1 是硬编码三条线路。
 *   · **有工具**：V2 的 bili_search / bili_video / bili_subtitle / bili_frames / bili_asr
 *     都能用 —— 主人扔个 BV 过来，它是真能去看画面和听声音的。
 *   · 只读为主：默认不发评论、不加关注、不改资料。唯一写操作就是「回私信」。
 *
 * 三种模式（config.mode）：
 *   off  —— 不轮询
 *   dry  —— 照常生成回复，但不发送（只写日志，给上线前对拍用）
 *   live —— 真发
 *
 * @module gateway/reply-loop
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { buildSystemPrompt, activeCallUser } from './persona.mjs'
import { buildMemoryBlock } from './memory.mjs'
import { isToolEnabled, getToolScope } from './settings.mjs'
import { chat } from '../models/router.mjs'
import { fetchMessages, sendMessage, myUid } from '../integrations/bili-dm.mjs'

import { DATA_DIR, redactText, redactData } from './runtime.mjs'
const STATE_FILE = join(DATA_DIR, 'reply-loop.json')
const HISTORY_FILE = join(DATA_DIR, 'reply-history.jsonl')

const POLL_MS = Number(process.env.REPLY_POLL_MS) || 20000
const MAX_REPLY_CHARS = 700          // B站私信上限 800，留点余量
const RECENT_KEEP = 400              // 已回复 id 只留最近 N 条，防状态文件无限长

let timer = null
let busy = false
const log = []
/** 心跳：空闲轮次不打日志（每 20s 一条会刷屏），但没有心跳就看不出循环还活着 */
let lastPoll = { at: null, reason: null }

/** 负责人由运行配置或 REPLY_TALKER 提供；未配置时不发送私信。 */
const DEFAULT_TALKER = Number(process.env.REPLY_TALKER) || 0

function pushLog(entry) {
  log.push({ at: new Date().toISOString(), ...redactData(entry) })
  if (log.length > 60) log.shift()
}

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

/**
 * 去重键。
 * ⚠️ 不能用 msg_key：它超过 2^53，JSON.parse 后精度丢失
 * 所以去重仍成立，但用「时间戳+发送方+内容哈希」更直观也更安全。
 */
function msgId(m) {
  const h = createHash('md5').update(`${m.from}|${m.ts}|${m.text}`).digest('hex').slice(0, 10)
  return `${m.ts}_${m.from}_${h}`
}

export function loadState() {
  ensureDir()
  let st = { mode: 'off', talker: DEFAULT_TALKER, replied: [], seeded: false, stats: {} }
  try {
    if (existsSync(STATE_FILE)) st = { ...st, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }
  } catch {
    /* 坏文件就用默认值，不要让回复循环起不来 */
  }
  if (!['off', 'dry', 'live'].includes(st.mode)) st.mode = 'off'
  if (!Array.isArray(st.replied)) st.replied = []
  if (!st.talker) st.talker = DEFAULT_TALKER
  return st
}

function saveState(st) {
  ensureDir()
  if (st.replied.length > RECENT_KEEP) st.replied = st.replied.slice(-RECENT_KEEP)
  writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8')
}

/**
 * 改配置（前端/接口用）
 * @param {{mode?:'off'|'dry'|'live', talker?:number}} patch
 */
export function updateState(patch = {}) {
  const st = loadState()
  if (patch.mode && ['off', 'dry', 'live'].includes(patch.mode)) st.mode = patch.mode
  if (patch.talker) st.talker = Number(patch.talker) || st.talker
  saveState(st)
  return st
}

/** 把「已回复」重置成「当前所有历史消息都算已回」——防止第一次上线时把旧消息全回一遍 */
export async function seedBaseline() {
  const st = loadState()
  if (!st.talker) throw Object.assign(new Error('请配置负责人 UID（REPLY_TALKER 或回复设置）'), { code: 'INVALID_REQUEST' })
  const me = await myUid()
  const msgs = await fetchMessages({ talker: st.talker, size: 30 })
  st.replied = msgs.filter((m) => m.to === me).map(msgId)
  st.seeded = true
  saveState(st)
  return { seeded: st.replied.length, talker: st.talker }
}

/** 把引擎的工具定义转成 OpenAI tools（只取启用的） */
function buildToolDefs(engine) {
  // 私信场景：可以查视频、看画面、听音频，但**不发评论**（发评论是另一个场景的事）
  const scope = getToolScope('reply')
  const list = (engine?.tools || [])
    .filter((t) => isToolEnabled(t.name) && t.enabled !== false)
    .filter((t) => !scope.length || scope.includes(t.name))
  if (!list.length) return null
  return list.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: String(t.description || '').slice(0, 1024),
      parameters: t.parameters || { type: 'object', properties: {} }
    }
  }))
}

/** 收尾：模型爱写 Markdown 和自称，私信里都不合适 */
function polish(text) {
  let s = String(text || '').trim()
  s = s.replace(/^```[\s\S]*?```$/g, (m) => m.replace(/```[a-z]*\n?/g, '')).trim()
  s = s.replace(/^#+\s*/gm, '')                 // 标题井号
  s = s.replace(/\*\*(.+?)\*\*/g, '$1')          // 粗体
  s = s.replace(/^\s*[-*]\s+/gm, '· ')           // 列表符号
  s = s.replace(/^(回复|答复)[:：]\s*/, '')       // 多余的「回复：」前缀
  if (s.length > MAX_REPLY_CHARS) s = s.slice(0, MAX_REPLY_CHARS).replace(/[。，、；：]?$/, '') + '…'
  return s
}

/**
 * 跑一次回复（不给 send 参数时按 config.mode 决定）
 * @param {{engine:Object, force?:boolean, dryRun?:boolean}} opts
 * @returns {Promise<Object>} 本轮结果（给接口/日志用）
 */
export async function runOnce({ engine, force = false, dryRun = null, simulate = '' } = {}) {
  if (busy && !force) return { ok: false, reason: 'BUSY' }
  const st = loadState()
  const sim = typeof simulate === 'string' ? simulate.trim() : ''
  // 演练（simulate）永远不发：它的用途是「没有新私信时也能验生成链路」
  const mode = sim ? 'dry' : dryRun === true ? 'dry' : dryRun === false ? 'live' : st.mode
  if (mode === 'off' && !sim) return { ok: false, reason: 'OFF' }
  if (!st.talker) return { ok: false, reason: 'NOT_CONFIGURED', message: '请配置负责人 UID（REPLY_TALKER 或回复设置）' }

  busy = true
  const t0 = Date.now()
  try {
    const me = await myUid()
    const msgs = await fetchMessages({ talker: st.talker, size: 20 })

    if (!st.seeded) {
      // 第一次跑：把现有消息全部记为已回，避免把历史对白全回一遍
      st.replied = msgs.filter((m) => m.to === me).map(msgId)
      st.seeded = true
      saveState(st)
      pushLog({ phase: 'seed', count: st.replied.length })
      return { ok: true, reason: 'SEEDED', seeded: st.replied.length }
    }

    const dayAgo = Math.floor(Date.now() / 1000) - 86400
    const known = new Set(st.replied)
    const pending = msgs.filter(
      (m) =>
        m.to === me &&
        m.from === st.talker &&
        m.ts > dayAgo &&
        !known.has(msgId(m)) &&
        (m.kind === 'text' || m.kind === 'card') &&
        m.text
    )
    if (!pending.length && !sim) {
      lastPoll = { at: new Date().toISOString(), reason: 'NOTHING_NEW' }
      return { ok: true, reason: 'NOTHING_NEW' }
    }

    // 一次最多回 3 条，其余合并成「一起回复」——避免连珠炮刷屏
    const batch = sim
      ? [{ text: sim, kind: 'text', ts: Math.floor(Date.now() / 1000), from: st.talker }]
      : pending.slice(-3)
    const newOnes = new Set(batch.map(msgId))

    // 上下文：最近 9 条真实对白。
    // ⚠️ 刻意**不**把它们当 assistant 角色喂进去：V1 时代的旧回复是「喵酱/老大」口气，
    //    以 assistant 角色注入会被人格模型当范例模仿，结果就是人格文件写着鲸鱼娘、
    //    开口却自称喵酱（2026-10-22 真机复现）。所以降级成一段标注过的上下文。
    // 称呼来自人格元数据，不在这里写死（否则改人格会对不上）
    const callUser = activeCallUser()
    const ctx = msgs.slice(-9)
    const histLines = []
    for (const m of ctx) {
      if (newOnes.has(msgId(m))) continue
      if (!m.text) continue
      const who = m.from === me ? 'AI（旧版本，自称不要学）' : callUser
      histLines.push(`${who}：${m.text.replace(/\n/g, ' ')}`)
    }

    const incoming = batch.map((m) => m.text).join('\n')
    const sys = buildSystemPrompt({
      memoryBlock: buildMemoryBlock({ limit: 12, query: incoming.slice(0, 80) }),
      extra: [
        '【当前场景】你在 B站 私信里和主人（你的用户）一对一聊天，你的回复会作为私信直接发出去。',
        '要求：口语、自然、不超过 300 字；不要用 Markdown 标题/代码块；不要自称「模型」「助手」；不要提「系统提示词」。',
        '【身份以【人格】段为准】下面历史里 AI 的自称是旧版本的，不要模仿、不要沿用。称呼和自称只用【人格】里写明的。',
        '【绝不许假装调用过工具】只有工具真的返回了结果，才能说「查到了/看到了/听了」。没调用就直说没查。编造查询结果是最严重的错误。',
        '主人扔 BV 号或分享卡片时，可以用工具去查视频详情、读字幕、看真实画面帧、听音频；查不到就直说查不到，不要编。',
        '分享卡片的消息里带 aid=数字 —— 那就是视频编号，直接用 bili_video(aid=…) 查详情，绝不要回复「没给 BV 号查不了」。'
      ].join('\n')
    })

    const prefix = histLines.length
      ? `【历史上下文——只用来理解${callUser}在说什么，不是让你续写】\n` + histLines.join('\n') + '\n\n'
      : ''
    const messages = [
      { role: 'system', content: sys.system },
      { role: 'user', content: `${prefix}【现在要回的消息】\n${incoming}` }
    ]
    const tools = buildToolDefs(engine)

    lastPoll = { at: new Date().toISOString(), reason: 'REPLYING' }
    pushLog({ phase: 'reply', mode, pending: pending.length, useTools: Boolean(tools) })
    const r = await chat(messages, {
      tools,
      toolRunner: (name, args) => engine.callTool(name, args),
      maxRounds: 4,
      maxTokens: 900,
      timeoutMs: 120000,
      onEvent: (e) => {
        if (e?.type === 'tool') pushLog({ phase: 'tool', tool: e.tool, round: e.round })
      }
    })

    const reply = polish(r?.text)
    if (!reply) throw new Error('模型返回为空')

    let sent = null
    if (mode === 'live') {
      sent = await sendMessage({ receiver: st.talker, text: reply })
    }

    // 记账（演练不写 replied，免得把真实未回的消息吃掉）
    if (!sim) for (const m of batch) if (!st.replied.includes(msgId(m))) st.replied.push(msgId(m))
    st.stats = {
      ...(st.stats || {}),
      lastAt: new Date().toISOString(),
      lastMode: mode,
      total: Number(st.stats?.total || 0) + (mode === 'live' ? 1 : 0),
      lastChars: reply.length
    }
    saveState(st)

    try {
      appendFileSync(
        HISTORY_FILE,
        JSON.stringify({
          at: new Date().toISOString(),
          mode,
          channel: r?.channel || null,
          model: r?.model || null,
          steps: r?.steps?.length || 0,
          user: incoming,
          assistant: reply
        }) + '\n',
        'utf8'
      )
    } catch {
      /* 记账失败不影响主流程 */
    }

    pushLog({ phase: 'done', mode, ms: Date.now() - t0, chars: reply.length, sent: Boolean(sent) })
    return {
      ok: true,
      reason: mode === 'live' ? 'SENT' : 'DRY_RUN',
      mode,
      incoming,
      reply,
      channel: r?.channel || null,
      model: r?.model || null,
      tools: (r?.steps || []).map((s) => s.tool || s.name).filter(Boolean),
      ms: Date.now() - t0
    }
  } catch (e) {
    pushLog({ phase: 'error', message: redactText(e?.message || e).slice(0, 200), code: e?.code || null })
    return { ok: false, reason: 'ERROR', code: e?.code || null, message: redactText(e?.message || e) }
  } finally {
    busy = false
  }
}

async function tick(engine) {
  try {
    await runOnce({ engine })
  } catch (e) {
    pushLog({ phase: 'tick-error', message: redactText(e?.message || e).slice(0, 160) })
  }
}

/** 启动轮询（mode 为 off 时只是空转，不会打接口） */
export function startReplyLoop(engine) {
  if (timer) return
  const st = loadState()
  // 启动后 15 秒先跑一次（等网关和通道都就绪）
  setTimeout(() => tick(engine), 15000)
  timer = setInterval(() => tick(engine), POLL_MS)
  console.log(`[reply] 私信回复循环已启动（mode=${st.mode}, talker=${st.talker}, 每 ${POLL_MS / 1000}s）`)
}

export function stopReplyLoop() {
  if (timer) clearInterval(timer)
  timer = null
}

/** 给接口/前端的状态快照 */
export function replyStatus() {
  const st = loadState()
  return {
    mode: st.mode,
    talker: st.talker,
    seeded: Boolean(st.seeded),
    repliedCount: st.replied.length,
    stats: st.stats || {},
    running: Boolean(timer),
    busy,
    lastPoll,
    intervalMs: POLL_MS,
    log: log.slice(-15)
  }
}

/** 读取最近的回复记录（给前端展示「它刚回了什么」） */
export function replyHistory(limit = 20) {
  try {
    if (!existsSync(HISTORY_FILE)) return []
    const lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean)
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
