import { redactText, redactData, safeUrl } from './runtime.mjs'
/**
 * 值班调度器（在进程内跑，不依赖 cron / systemd timer）
 * ============================================================================
 * @module gateway/scheduler
 * @description 每 30 秒 tick 一次，到点就让 AI 自己去刷一轮视频。
 *
 * 为什么放在进程内而不是 systemd timer：
 *   · 需要读运行时的配置（窗口、次数、指定模型通道），systemd 拿不到
 *   · 需要和前端状态联动（下一次什么时候跑、今天跑了几次）
 *   · V1 用 timer 拉起 python 脚本，结果就是「配置改了要等下次重启才生效」
 *
 * 安全性：
 *   · allowComment 默认 false —— 只读不写，绝不自动发评论
 *   · 单实例锁（running 标志），避免上一轮没跑完又起一轮
 *   · 失败也记账，绝不因为报错把调度卡死
 *
 * @exports startScheduler / stopScheduler / schedulerStatus / runDutyNow
 */
import { acquire, markRun, loadSchedule, stateOf, shanghaiNow } from './schedule.mjs'
import { buildSystemPrompt } from './persona.mjs'
import { buildMemoryBlock, appendRun, addNote } from './memory.mjs'
import { chat } from '../models/router.mjs'
import { isToolEnabled, getToolScope } from './settings.mjs'
import { sendLongMessage } from '../integrations/bili-dm.mjs'
import { loadState as loadReplyState } from './reply-loop.mjs'
import { renderCharter, ensureCharter } from './charter.mjs'
import { appendToDigest, maybePushYesterday } from './digest.mjs'

const TICK_MS = Number(process.env.BILI_HUMANISM_TICK_MS) || 30000

let timer = null
let running = false

// ── 日报攒批：值班一天最多 25 轮，逐轮推等于刷屏（实测最坏 25 条/天）。
//    改成「攒够 N 分钟 或 M 轮」才合并发一条，全文不截断，只是合成一条。
let pendingReports = []
let lastReportAt = 0
const REPORT_GAP_MS = () => (Number(process.env.REPORT_GAP_MIN) || 60) * 60000
const REPORT_MAX_BATCH = () => Number(process.env.REPORT_MAX_BATCH) || 6
const log = []

function pushLog(entry) {
  log.push({ at: new Date().toISOString(), ...redactData(entry) })
  if (log.length > 50) log.shift()
}

/** 把引擎里的工具转成 OpenAI tools（只取启用的） */
function buildToolDefs(engine) {
  // ⭐ 按「值班」场景裁剪：默认只给只读工具，发评论的权限模型连名字都看不到。
  //    借鉴 dsh-bili-scroll 的最小权限思路 —— 不靠提示词约束，直接不给注册。
  const scope = getToolScope('duty')
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

function taskPrompt(sched, now) {
  // 章程从 legacy/persona/duty-v2.md 读（用户可改），不再写死在代码里。
  // 版本升级靠 charter.mjs 的 sha256 记账：用户没改过才覆盖，改过就保留并另存 .new。
  const windows = sched.windows.filter((w) => w.enabled).map((w) => `${w.start}-${w.end}`)
  return renderCharter({
    now: now.text,
    weekday: now.weekday,
    windows: windows.join(' / '),
    maxVideos: sched.task.maxVideos,
    extra: sched.task.prompt || ''
  })
}

/**
 * 跑一轮值班（供调度器与「立即运行」共用）
 * @param {{engine: Object, force?: boolean, reason?: string, windowId?: string}} opts
 */
export async function runDuty(opts = {}) {
  const { engine, force = false } = opts
  if (running) {
    const err = new Error('上一轮还没跑完')
    err.code = 'SCHEDULER_BUSY'
    throw err
  }
  if (!engine) {
    const err = new Error('调度器未接入工具引擎')
    err.code = 'SCHEDULER_NO_ENGINE'
    throw err
  }

  const acq = force ? { ok: true, reason: 'FORCED', windowId: opts.windowId || 'manual' } : acquire()
  if (!acq.ok) return { skipped: true, reason: acq.reason }

  running = true

  // 跨天补推：值班窗口里才有 tick，所以用「跨天检测」代替定时器。
  // 昨天日报还没推过就推一次（状态落盘，重启不重复）。
  try {
    const to = loadReplyState().talker || Number(process.env.REPLY_TALKER) || 0
    if (!to) throw new Error('请配置负责人 UID（REPLY_TALKER 或回复设置）')
    const r = await maybePushYesterday(async (text) => {
      const { sendLongMessage } = await import('../integrations/bili-dm.mjs')
      await sendLongMessage({ receiver: to, text })
    })
    if (r.pushed) pushLog({ phase: 'digest', ok: true, date: r.date })
  } catch (e) {
    pushLog({ phase: 'digest', ok: false, error: redactText(e?.message || e).slice(0, 120) })
  }
  const t0 = Date.now()
  const sched = loadSchedule()
  const now = shanghaiNow()
  let record = null

  try {
    const memBlock = buildMemoryBlock({ limit: 10 })
    const sys = buildSystemPrompt({
      includeWorldview: false,
      memoryBlock: memBlock,
      extra: '你在值班：自己决定看什么、看多少，但只读不写。'
    })

    const tools = buildToolDefs(engine)
    const res = await chat(
      [
        { role: 'system', content: sys.system },
        { role: 'user', content: taskPrompt(sched, now) }
      ],
      {
        tools,
        toolRunner: (name, args) => engine.callTool(name, args),
        maxRounds: sched.task.maxRounds,
        maxTokens: 1600,
        timeoutMs: 150000,
        channelId: sched.task.channelId || undefined,
        onEvent: (e) => {
          if (e.type === 'tool') pushLog({ phase: 'tool', tool: e.tool, round: e.round })
        }
      }
    )

    const ms = Date.now() - t0
    const m = /【记忆候选】([\s\S]*)$/.exec(res.text || '')
    const candidate = m ? m[1].trim().slice(0, 500) : ''

    record = markRun({
      windowId: acq.windowId,
      reason: acq.reason,
      ok: true,
      ms,
      channel: res.channel,
      model: res.model,
      rounds: res.rounds,
      steps: res.steps.length,
      tools: res.steps.map((s) => s.tool),
      text: (res.text || '').slice(0, 4000),
      memoryCandidate: candidate && candidate !== '无' ? candidate : ''
    })

    // 记忆候选：只记录，不自动当指令；写进 notes.json 时标注来源，用户可删
    if (candidate && candidate !== '无' && candidate.length > 4) {
      try {
        addNote({ text: candidate, tags: ['duty', 'auto'], source: 'scheduler' })
      } catch {
        /* 记忆写失败不影响本轮结果 */
      }
    }

    appendRun({ ok: true, ms, channel: res.channel, rounds: res.rounds, steps: res.steps.length, text: record.text })

    // 追加到当天日报（跨天自动新建文件，供「日报」卡片与次日推送使用）
    try {
      const dg = appendToDigest({ timeText: record.timeText, text: record.text, tools: record.tools, ok: true })
      pushLog({ phase: 'digest-append', date: dg.date, rounds: dg.rounds })
    } catch (e) {
      pushLog({ phase: 'digest-append', ok: false, error: redactText(e?.message || e).slice(0, 120) })
    }

    // ── 日报：把这一轮写的东西**全文**发到主人私信 ──
    // 用户明确要求「写了多少就发我多少」，所以不截断，只在 B站 800 字上限处分条。
    // 发送失败绝不影响值班结果本身（它只是通知渠道）。
    let report = null
    if (sched.task?.reportToDm !== false && (res.text || '').trim()) {
      pendingReports.push({ timeText: record.timeText, text: (res.text || '').trim() })
      const gapOk = Date.now() - lastReportAt >= REPORT_GAP_MS()
      const batchOk = pendingReports.length >= REPORT_MAX_BATCH()
      if (gapOk || batchOk) {
        const items = pendingReports
        pendingReports = []
        try {
          const to = loadReplyState().talker || Number(process.env.REPLY_TALKER) || 0
          if (!to) throw new Error('请配置负责人 UID（REPLY_TALKER 或回复设置）')
          const body =
            items.length === 1
              ? `【值班 ${items[0].timeText}】\n\n${items[0].text}`
              : `【值班汇总 · ${items.length} 轮】${items[0].timeText} ~ ${items[items.length - 1].timeText}\n\n` +
                items.map((x, i) => `── 第 ${i + 1} 轮 ${x.timeText} ──\n${x.text}`).join('\n\n')
          const r = await sendLongMessage({ receiver: to, text: body })
          lastReportAt = Date.now()
          report = { ok: true, parts: r.parts, skipped: r.skipped, merged: items.length, trigger: gapOk ? 'gap' : 'batch' }
          pushLog({ phase: 'report', ok: true, parts: r.parts, merged: items.length })
        } catch (e) {
          pendingReports = [...items, ...pendingReports]
          report = { ok: false, error: redactText(e?.message || e).slice(0, 160) }
          pushLog({ phase: 'report', ok: false, error: report.error })
        }
      } else {
        report = { ok: true, queued: pendingReports.length }
        pushLog({ phase: 'report-queued', count: pendingReports.length })
      }
    }

    pushLog({ phase: 'done', ok: true, ms, channel: res.channel, steps: res.steps.length })
    return { ok: true, ...record, report }
  } catch (e) {
    const ms = Date.now() - t0
    record = markRun({
      windowId: acq.windowId,
      reason: acq.reason,
      ok: false,
      ms,
      error: redactText(e?.message || e).slice(0, 500),
      code: e?.code || 'DUTY_FAILED'
    })
    appendRun({ ok: false, ms, error: redactText(e?.message || e) })
    pushLog({ phase: 'done', ok: false, ms, error: redactText(e?.message || e) })
    return { ok: false, ...record }
  } finally {
    running = false
  }
}

/** 启动调度（进程内 30s tick） */
export function startScheduler(engine) {
  // 铺设/对齐章程（用户没改过就跟着程序升级，改过就保留并另存 .new）
  try {
    const c = ensureCharter()
    pushLog({ phase: 'charter', action: c.action, userEdited: c.userEdited })
  } catch (e) {
    pushLog({ phase: 'charter', ok: false, error: redactText(e?.message || e).slice(0, 120) })
  }
  if (timer) return { already: true, intervalMs: TICK_MS }
  const tick = async () => {
    if (running) return
    try {
      const acq = acquire()
      if (!acq.ok) return
      console.log(`[scheduler] 到点，开始刷视频（${acq.reason} / ${acq.windowId || '-'}）`)
      await runDuty({ engine })
    } catch (e) {
      console.warn('[scheduler] tick 失败:', redactText(e?.message || e))
      pushLog({ phase: 'tick-error', error: redactText(e?.message || e) })
    }
  }
  // 开机后先等 8 秒（让工具扫描与模型通道就绪），再判断一次
  setTimeout(() => tick(), 8000)
  timer = setInterval(() => tick(), TICK_MS)
  console.log(`[scheduler] ✓ 已启动，每 ${TICK_MS / 1000}s 检查一次（时区 Asia/Shanghai）`)
  return { started: true, intervalMs: TICK_MS }
}

/** 停调度 */
export function stopScheduler() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  return { stopped: true }
}

/** 调度器 + 配置的整体状态（前端轮询用） */
export function schedulerStatus() {
  return {
    running: Boolean(timer),
    busy: running,
    intervalMs: TICK_MS,
    schedule: stateOf(),
    log: log.slice(-8)
  }
}
