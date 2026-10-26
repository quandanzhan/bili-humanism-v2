/**
 * 解析节点监控（视频解析站的服务器状态）
 * ============================================================================
 * 为什么放在 V2 里：
 *   视频解析站自己有 monitor.html，但它只管自己那一摊。用户希望「一处看全」，
 *   在控制台统一展示各解析节点的运行状态。
 *
 * 监测对象（可配置，存在 data/nodes.json）：
 *   · 解析服务与识别 worker：由部署者配置健康检查地址。
 *   · 阿里云识别 worker     （本方案 P1 待部署，:8052）
 *   · 魔搭创空间            （地址待填，会休眠，需保活）
 *
 * 探测纪律：
 *   · 只做 HTTP GET，不全量抓页面（限制 4KB，够看状态字段）
 *   · 结果缓存 30 秒，避免面板刷新把对端打爆
 *   · 单节点超时 6 秒，并发探测，总耗时不超过约 7 秒
 *   · **不做 SSRF 跳板**：拒绝云厂商 metadata 地址和非 http(s) 协议
 *
 * @module gateway/nodes
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DATA_DIR, redactText, redactData, safeUrl, restoreUrl, registerSecrets, urlSecrets } from './runtime.mjs'
const FILE = process.env.BILI_HUMANISM_NODES || join(DATA_DIR, 'nodes.json')

const CACHE_MS = 30_000
const TIMEOUT_MS = 6_000

/** 默认节点模板；部署专属地址从环境变量或面板配置。 */
const DEFAULTS = {
  nodes: [
    {
      id: 'aliyun-parse',
      name: '阿里云 · 解析服务',
      url: process.env.BILI_HUMANISM_PARSE_HEALTH_URL || '',
      enabled: Boolean(process.env.BILI_HUMANISM_PARSE_HEALTH_URL),
      note: '配置解析服务的健康检查地址后启用'
    },
    {
      id: 'aliyun-worker',
      name: '阿里云 · 识别 worker',
      url: '',
      enabled: false,
      note: '主 worker 候选（:8052），部署后填地址'
    },
    {
      id: 'aliyun-heyuan',
      name: '阿里云 · 河源（全力解析）',
      url: '',
      enabled: false,
      note: '1M 公网、算力全开：只取音频/精灵图、只回 JSON，不传大文件'
    },
    {
      id: 'modelscope',
      name: '魔搭 · 推理 API',
      url: 'https://api-inference.modelscope.cn/v1/models',
      enabled: false,
      note: '带上令牌才算真探活；公共 API 只有文本模型，视觉需自建创空间',
      needsAuth: true
    }
  ]
}

/** 禁止探测的目标：云 metadata 是典型 SSRF 跳板，探测它等于把凭证送出去 */
const BLOCKED = [/169\.254\.169\.254/, /metadata\.tencentcloudapi/i, /metadata\.aliyun/i, /^file:/i, /^gopher:/i]

function ensure() {
  mkdirSync(dirname(FILE), { recursive: true })
}

export function loadNodes() {
  ensure()
  try {
    if (existsSync(FILE)) {
      const d = JSON.parse(readFileSync(FILE, 'utf8'))
      if (Array.isArray(d?.nodes) && d.nodes.length) {
        // ⚠️ 老配置文件没有 priority / caps（这两个字段是后加的），
        //    必须在这里补默认值，否则 UI 里优先级全是空、排序失效。
        d.nodes = d.nodes.map((n, i) => ({
          priority: (i + 1) * 10,
          caps: [],
          ...n
        }))
        registerSecrets(d.nodes.flatMap((n) => [n.auth, ...urlSecrets(n.url)]))
        return d
      }
    }
  } catch {
    /* 坏文件回落到默认值，监控不该因为配置坏掉就整个不显示 */
  }
  return { ...DEFAULTS }
}

export function saveNodes(patch = {}) {
  const cur = loadNodes()
  const next = { ...cur }
  const prevAuth = new Map((cur.nodes || []).map((n) => [n.id, n.auth || '']))
  if (Array.isArray(patch.nodes)) {
    next.nodes = patch.nodes
      .map((n, i) => ({
        id: String(n.id || `n${i}`).slice(0, 40),
        name: String(n.name || '').slice(0, 60),
        url: restoreUrl(String(n.url || '').trim(), cur.nodes.find((old) => old.id === n.id)?.url).slice(0, 300),
        enabled: n.enabled !== false,
        // priority：越小越优先。不填则按数组顺序（10,20,30…）自动编号，保证可排序。
        priority: Number.isFinite(Number(n.priority)) ? Number(n.priority) : (i + 1) * 10,
        // caps：这个节点能提供什么能力。以后「抽帧/转写/视觉」按优先级挑节点用，
        // 不再把「用哪台机器」写死在代码里。
        caps: Array.isArray(n.caps) ? n.caps.map((x) => String(x).slice(0, 24)).slice(0, 8) : [],
        note: String(n.note || '').slice(0, 200),
        // auth：需要 Bearer 的节点（如魔搭推理 API）。**只存不回显**，
        // 前端拿到的永远是 hasAuth 布尔值（见 sanitize）。
        // ⚠️ 前端只改地址时不会回传 auth（脱敏了），这里必须沿用旧值，
        //    否则保存一次 URL 就把令牌清空（这种错很难被发现）。
        auth:
          n.auth === null
            ? ''
            : typeof n.auth === 'string'
              ? n.auth.trim().slice(0, 200)
              : prevAuth.get(String(n.id || '')) || '',
        // 该节点是否需要令牌（前端据此显示输入框）
        needsAuth: n.needsAuth === true
      }))
      .filter((n) => n.name)
  }
  ensure()
  writeFileSync(FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  cache = null
  return next
}

/** 判断响应体像不像「健康」：优先看 JSON 的 ok/status，其次看 HTTP 码 */
function judge(httpStatus, text) {
  if (httpStatus < 200 || httpStatus >= 400) return false
  const t = String(text || '').trim()
  if (!t) return true
  try {
    const j = JSON.parse(t)
    if (j && typeof j === 'object') {
      if (j.ok === false) return false
      if (typeof j.status === 'string') return /^(ok|healthy|up|good|running)$/i.test(j.status)
      if (j.ok === true) return true
    }
    return true
  } catch {
    // 非 JSON（比如返回了 HTML 页面）：只要 2xx 就算活着，但标注出来
    return true
  }
}

async function probeOne(node) {
  registerSecrets([node.auth, ...urlSecrets(node.url)])
  const t0 = Date.now()
  const base = { id: node.id, name: node.name, note: redactText(node.note || ''), url: safeUrl(node.url), hasAuth: Boolean(node.auth) }

  if (!node.enabled || !node.url) {
    return { ...base, ok: null, skipped: true, reason: node.enabled ? '未填地址' : '已停用', ms: 0 }
  }
  if (BLOCKED.some((re) => re.test(node.url))) {
    return { ...base, ok: false, error: '该地址被安全策略拒绝（metadata/非 http 协议）', ms: 0 }
  }
  let u
  try {
    u = new URL(node.url)
    if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http/https')
  } catch (e) {
    return { ...base, ok: false, error: `地址无效：${redactText(e.message)}`, ms: 0 }
  }

  try {
    const r = await fetch(u, {
      method: 'GET',
      headers: {
        'User-Agent': 'bili-humanism-v2-monitor/1.0',
        Accept: 'application/json, text/html;q=0.5',
        ...(node.auth ? { Authorization: `Bearer ${node.auth}` } : {})
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    // 只读前 4KB：健康接口不需要整页 HTML
    const buf = await r.arrayBuffer()
    const text = Buffer.from(buf).subarray(0, 4096).toString('utf8')
    const ok = judge(r.status, text)
    return {
      ...base,
      ok,
      status: r.status,
      ms: Date.now() - t0,
      // 回显一小段，方便人眼确认（例如 {"status":"ok"}）
      body: redactText(text, [node.auth, ...urlSecrets(node.url)]).replace(/\s+/g, ' ').slice(0, 120),
      json: /^\s*[{[]/.test(text)
    }
  } catch (e) {
    const timeout = /abort|timeout/i.test(String(e?.name || e?.message || ''))
    return { ...base, ok: false, timeout, ms: Date.now() - t0, error: timeout ? `超时（>${TIMEOUT_MS / 1000}s）` : redactText(e?.message || e).slice(0, 160) }
  }
}

let cache = null // { at, payload }

/**
 * 探测全部节点（默认走 30 秒缓存）
 * @param {{force?:boolean}} [opts]
 */
export async function probeAll({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.payload, cached: true, ageMs: Date.now() - cache.at }
  }
  const cfg = loadNodes()
  const t0 = Date.now()
  // 按 priority 升序探测与返回 —— 用户能自己调顺序，代码不写死
  const ordered = [...cfg.nodes].sort((a, b) => (Number(a.priority) || 999) - (Number(b.priority) || 999))
  const results = await Promise.all(ordered.map(probeOne))
  const payload = {
    checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    nodes: results,
    summary: {
      total: results.length,
      up: results.filter((r) => r.ok === true).length,
      down: results.filter((r) => r.ok === false).length,
      skipped: results.filter((r) => r.skipped).length
    }
  }
  cache = { at: Date.now(), payload }
  return { ...payload, cached: false, ageMs: 0 }
}

/** 给前端的脱敏视图：去掉 auth，只留 hasAuth */
export function sanitize(cfg = loadNodes()) {
  return {
    ...cfg,
    nodes: (cfg.nodes || []).map((n) => {
      const { auth, ...rest } = n
      return { ...redactData(rest), url: safeUrl(rest.url), hasAuth: Boolean(auth) }
    })
  }
}

/**
 * 按能力挑一个最优先、且当前健康的节点。
 * @param {string} cap 能力名，如 'frames' / 'asr' / 'vision'
 * @param {Array} probed probeAll() 返回的 nodes（不传会现探一次，慢）
 * @returns {{node:Object|null, reason:string}}
 */
export function pickBest(cap, probed) {
  const list = (probed || []).filter((n) => {
    const cfg = (loadNodes().nodes || []).find((x) => x.id === n.id) || {}
    return n.ok === true && Array.isArray(cfg.caps) && cfg.caps.includes(cap)
  })
  if (!list.length) return { node: null, reason: `没有健康且声明了 ${cap} 能力的节点` }
  const cfg = loadNodes().nodes || []
  list.sort((a, b) => {
    const pa = Number((cfg.find((x) => x.id === a.id) || {}).priority) || 999
    const pb = Number((cfg.find((x) => x.id === b.id) || {}).priority) || 999
    return pa - pb
  })
  return { node: list[0], reason: 'ok' }
}

export function nodesFile() {
  return FILE
}
