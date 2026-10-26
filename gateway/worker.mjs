/**
 * 外部 worker 任务队列（给 NAS / 阿里云 这类「出站连接」的算力节点用）
 * ============================================================================
 * 为什么要「拉」而不是「推」：
 *   NAS 在家里，只有一条 Cloudflare Tunnel 暴露 443（网页），22 端口不通；
 *   服务端可能无法直接连接内网计算节点，因此使用出站轮询。
 *   解法是反过来：NAS 每几秒来腾讯云拉一次任务（出站连接，NAT 后面也能通），
 *   算完再 POST 回来。这样不需要开端口、不需要 IPv6、不需要改隧道。
 *
 * 设计约束：
 *   · 任务只在内存 + 一个 JSON 文件里，重启不丢（但只保留最近 200 条）
 *   · 每个任务有 deadlineMs，超时就判失败 —— 上层自动回落到「本地精灵图」那条老路
 *   · worker 用共享 token 认证（不是 Basic Auth，节点不是人）
 *   · 只允许白名单任务类型，不接受任意命令（NAS 是家里的机器，不能被当跳板）
 *
 * @module gateway/worker
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { DATA_DIR, redactText } from './runtime.mjs'
const FILE = join(DATA_DIR, 'worker-tasks.json')

/** 只允许这几种活。加新类型必须同时改 NAS agent，否则会被拒。 */
export const TASK_TYPES = new Set(['probe', 'frames', 'audio'])

const MAX_KEEP = 200
const DEFAULT_DEADLINE = 120_000

let tasks = null // [{id, type, payload, createdAt, deadlineAt, status, agent, result, error}]

/** agent 心跳：{ [agentName]: lastSeenMs } —— 用判断「NAS 还在不在线」
 *  ⚠️ 必须落盘：只放内存的话，服务一重启就清空，会在「重启后 ~5 秒」这个窗口
 *     把在线的 NAS 误判成离线，视觉工具白白降级到精灵图（2026-10-23 实测踩到）。
 */
const HEARTBEAT_FILE = join(DATA_DIR, 'worker-heartbeat.json')
const heartbeat = new Map()
try {
  if (existsSync(HEARTBEAT_FILE)) {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(HEARTBEAT_FILE, 'utf8')) || {})) {
      if (typeof v === 'number') heartbeat.set(k, v)
    }
  }
} catch {
  /* 坏文件就当没有，不影响启动 */
}

function saveHeartbeat() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(HEARTBEAT_FILE, JSON.stringify(Object.fromEntries(heartbeat)), 'utf8')
  } catch {
    /* 落盘失败只影响重启后的判断精度 */
  }
}
const OFFLINE_MS = Number(process.env.WORKER_OFFLINE_MS) || 60_000

/**
 * 读任务队列。
 * ⚠️ force=true 时**强制从文件重读**，这是必须的：
 *    派任务的一方可能是独立进程（比如 CLI 里直接调 bili_vision），
 *    它 enqueue 后写进文件；而服务进程的 tasks 是启动时加载的，
 *    如果不重读，agent 来 claim 时永远看不到新任务 —— 表现就是「任务派了但没人领」。
 *    2026-10-23 这个坑排查了三轮（队列里看不到任务、却报「等待结果超时」）。
 */
function load(force = false) {
  if (tasks && !force) return tasks
  try {
    if (existsSync(FILE)) tasks = JSON.parse(readFileSync(FILE, 'utf8')) || []
    else tasks = []
  } catch {
    tasks = []
  }
  return tasks
}

function save() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    // 只留最近 MAX_KEEP 条，文件不无限涨
    if (tasks.length > MAX_KEEP) tasks = tasks.slice(-MAX_KEEP)
    writeFileSync(FILE, JSON.stringify(tasks), 'utf8')
  } catch {
    /* 落盘失败不影响内存队列，最多重启丢任务 */
  }
}

/** 派一个任务，返回 taskId */
export function enqueue(type, payload = {}, { deadlineMs = DEFAULT_DEADLINE } = {}) {
  if (!TASK_TYPES.has(type)) {
    const e = new Error(`不支持的任务类型：${type}（可用：${[...TASK_TYPES].join('/')}）`)
    e.code = 'INVALID_REQUEST'
    throw e
  }
  load(true) // 必须重读：否则会基于旧内存覆盖别的进程刚写的任务
  const now = Date.now()
  const t = {
    id: randomUUID(),
    type,
    payload,
    createdAt: now,
    deadlineAt: now + deadlineMs,
    status: 'pending',
    agent: null,
    result: null,
    error: null
  }
  tasks.push(t)
  save()
  return t.id
}

/** worker 来取活：把最老的 pending 派给它 */
export function claim(agent = 'unknown') {
  load(true) // 必须重读：让 agent 看到其它进程刚派的任务
  const now = Date.now()
  // ⚠️ 心跳必须在这里更新：agent 空闲时也在轮询，只是没活可领（返回 204）。
  //    若只在「领到任务」时更新，空闲一分钟就会被误判离线（踩过）。
  heartbeat.set(agent, now)
  saveHeartbeat()
  // 顺手把过期的 pending 判死，避免永远卡住
  for (const t of tasks) {
    if (t.status === 'pending' && t.deadlineAt < now) {
      t.status = 'expired'
      t.error = '没有 worker 在时限内领走'
    }
    if (t.status === 'running' && t.deadlineAt < now) {
      t.status = 'expired'
      t.error = 'worker 领走后超时未交结果'
    }
  }
  const t = tasks.find((x) => x.status === 'pending')
  if (!t) {
    save()
    return null
  }
  t.status = 'running'
  t.agent = agent
  save()
  return { id: t.id, type: t.type, payload: t.payload, deadlineAt: t.deadlineAt }
}

/** worker 交结果 */
export function submit(id, { ok, result, error, agent } = {}) {
  load(true)
  const t = tasks.find((x) => x.id === id)
  if (!t) {
    const e = new Error('任务不存在或已过期清理')
    e.code = 'BILI_NOT_FOUND'
    throw e
  }
  t.status = ok === false ? 'failed' : 'done'
  t.result = ok === false ? null : result || null
  t.error = ok === false ? redactText(error || '未知错误').slice(0, 500) : null
  if (agent) t.agent = agent
  save()
  return { id: t.id, status: t.status }
}

/** 等某个任务的结果（上层调用用），超时返回 null */
export async function waitFor(id, timeoutMs = DEFAULT_DEADLINE, pollMs = 800) {
  load()
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const t = load().find((x) => x.id === id)
    if (t && (t.status === 'done' || t.status === 'failed' || t.status === 'expired')) {
      return t.status === 'done' ? { ok: true, result: t.result, agent: t.agent } : { ok: false, error: t.error, status: t.status }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return { ok: false, error: '等待结果超时', status: 'timeout' }
}

/**
 * 指定 agent 是否在线（用于「NAS 优先、离线回落」）
 * @param {string} [agent] 不传则看「有没有任何一个在线」
 * @returns {{online:boolean, agent?:string, ageMs?:number, agents:Array}}
 */
export function workerOnline(agent) {
  const now = Date.now()
  const list = [...heartbeat.entries()].map(([a, t]) => ({ agent: a, ageMs: now - t, online: now - t < OFFLINE_MS }))
  if (agent) {
    const hit = list.find((x) => x.agent === agent)
    return { online: Boolean(hit?.online), agent, ageMs: hit?.ageMs ?? null, agents: list }
  }
  const any = list.filter((x) => x.online).sort((a, b) => a.ageMs - b.ageMs)[0]
  return { online: Boolean(any), agent: any?.agent, ageMs: any?.ageMs ?? null, agents: list }
}

/** 队列状态（给面板看） */
export function queueStatus() {
  load()
  const now = Date.now()
  const by = (s) => tasks.filter((t) => t.status === s).length
  const last = tasks.slice(-8).reverse().map((t) => ({
    id: t.id.slice(0, 8),
    type: t.type,
    status: t.status,
    agent: t.agent,
    ms: t.status === 'done' || t.status === 'failed' ? now - t.createdAt : null,
    error: redactText(t.error)
  }))
  return {
    online: workerOnline(),
    pending: by('pending'),
    running: by('running'),
    done: by('done'),
    failed: by('failed'),
    expired: by('expired'),
    total: tasks.length,
    last
  }
}
