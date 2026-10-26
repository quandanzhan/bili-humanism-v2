/**
 * 视觉链（给纯文本模型装眼睛）
 * ============================================================================
 * 问题：我们手上三个通道（AMD DeepSeek-V4.1-Flash / deepseek-chat / reasoner）
 * 全是纯文本模型，`vision=false`。取到帧也喂不进去，DeepSeek 只能靠字幕猜画面。
 *
 * 思路来自 GitHub 上两类成熟方案（2026-10 调研）：
 *   · `ysr666/dsh-vision-router`：视觉模型只当眼睛，DeepSeek 始终当大脑；
 *     多后端 failover、429 立即切下一个、内容哈希缓存、调用前降采样。
 *   · `gmleong/dsh-img`：analyze_image 工具 + backends 回退链，默认接智谱免费视觉。
 * 两者都是 dsh 插件（装不进我们这套 standalone 服务），所以按它们的**设计**重写一份。
 *
 * 本质是「描述桥」而非「路由桥」：我们没有原生图片输入能力，
 * 所以让视觉模型把画面转成结构化文字，再把文字交给 DeepSeek 推理。
 * ⚠️ 代价要认：文字描述是有损的，DeepSeek 看到的是「二手的画面」。
 *    因此所有结论都必须标注「据视觉描述」，不能说得像亲眼看过。
 *
 * 免费额度（2026-10 核实，会变，以后失效只影响该后端）：
 *   · 智谱 glm-4v-flash / glm-4.6v-flash / glm-4.1v-thinking-flash —— 永久免费、token 不限
 *   · 阿里云百炼 qwen3-vl-flash —— 新用户每模型 100 万 token / 90 天
 *   · Intern AI（上海 AI Lab）internvl-latest —— 30 RPM / 9000 万 token 月
 *   · 本地 Ollama（moondream2 / minicpm-v）—— 由部署者自行准备的本地后端
 *
 * @module gateway/vision
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DATA_DIR, redactText, safeUrl, restoreUrl, registerSecrets, urlSecrets, completionUrl } from './runtime.mjs'
const FILE = process.env.BILI_HUMANISM_VISION || join(DATA_DIR, 'vision.json')
const CACHE_TTL = Number(process.env.VISION_CACHE_TTL_S) || 3600
const TIMEOUT_MS = Number(process.env.VISION_TIMEOUT_MS) || 60000
/** 调用前降采样：像素太多会把免费额度和延迟都吃掉 */
const MAX_PIXELS = Number(process.env.VISION_MAX_PIXELS) || 1_200_000

/**
 * 默认后端链。**顺序即优先级**：免费的、国内直连的放前面，本地放最后兜底。
 * 每个后端的 key 从环境变量读，没配就自动跳过（不会因为缺 key 报错）。
 */
const DEFAULTS = {
  enabled: true,
  backends: [
    {
      id: 'zhipu',
      name: '智谱 GLM-4.6V-Flash（永久免费）',
      type: 'openai',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.6v-flash',
      apiKeyEnv: 'ZHIPU_API_KEY',
      maxTokens: 800,
      enabled: true
    },
    {
      id: 'zhipu-4v',
      name: '智谱 GLM-4V-Flash（永久免费 · 备用）',
      type: 'openai',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4v-flash',
      apiKeyEnv: 'ZHIPU_API_KEY',
      maxTokens: 800,
      enabled: true
    },
    {
      id: 'dashscope',
      name: '阿里云百炼 qwen3-vl-flash（限免）',
      type: 'openai',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3-vl-flash',
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      maxTokens: 800,
      enabled: true
    },
    {
      id: 'intern',
      name: 'Intern AI internvl-latest（9000万/月）',
      type: 'openai',
      baseURL: 'https://chat.intern-ai.org.cn/api/v1',
      model: 'internvl-latest',
      apiKeyEnv: 'INTERN_API_KEY',
      maxTokens: 800,
      enabled: true
    },
    {
      id: 'ovh-anon',
      name: 'OVH 匿名 Qwen2.5-VL-72B（免 key · 2次/分钟）',
      type: 'openai',
      baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
      model: 'Qwen2.5-VL-72B-Instruct',
      apiKeyEnv: '',
      maxTokens: 800,
      // 匿名只有 2 请求/分钟/IP，一次只送 1 张，省着用
      maxImages: 1,
      enabled: true
    },
    {
      id: 'local',
      name: '本地 Ollama（moondream2 / minicpm-v）',
      type: 'openai',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'moondream',
      apiKeyEnv: '', // 本地不需要 key
      maxTokens: 500,
      enabled: false // 部署者准备并验证自己的本地后端后再启用
    }
  ]
}

/* 缓存：图片内容 + 问题 一起哈希。同一帧被反复问同一件事时不重复花钱 */
const memCache = new Map()
function cacheKey(dataUrl, question, model) {
  return createHash('md5').update(String(dataUrl).slice(0, 20000)).update('|').update(question).update('|').update(model).digest('hex')
}

function ensure() {
  mkdirSync(dirname(FILE), { recursive: true })
}

export function loadVision() {
  ensure()
  try {
    if (existsSync(FILE)) {
      const d = JSON.parse(readFileSync(FILE, 'utf8'))
      if (Array.isArray(d?.backends)) {
        registerSecrets(d.backends.flatMap((b) => [b.apiKey, ...urlSecrets(b.baseURL)]))
        return { ...DEFAULTS, ...d }
      }
    }
  } catch {
    /* 配置坏掉就用默认，视觉功能不该整个不可用 */
  }
  return { ...DEFAULTS }
}

export function saveVision(patch = {}) {
  const cur = loadVision()
  const next = { ...cur }
  if (patch.enabled !== undefined) next.enabled = patch.enabled !== false
  const prevKey = new Map((cur.backends || []).map((b) => [b.id, b.apiKey || '']))
  if (Array.isArray(patch.backends)) {
    next.backends = patch.backends.map((b) => ({
      id: String(b.id || '').slice(0, 32),
      name: String(b.name || '').slice(0, 80),
      type: 'openai',
      baseURL: restoreUrl(String(b.baseURL || ''), cur.backends.find((old) => old.id === b.id)?.baseURL).slice(0, 300),
      model: String(b.model || '').slice(0, 100),
      apiKeyEnv: String(b.apiKeyEnv || '').slice(0, 60),
      maxTokens: Math.max(64, Math.min(4096, Number(b.maxTokens) || 800)),
      maxImages: Number(b.maxImages) || undefined,
      // ⚠️ 前端不回显 key（脱敏），只改别的字段时必须沿用旧值
      apiKey: b.apiKey === null ? '' : typeof b.apiKey === 'string' ? b.apiKey.trim().slice(0, 200) : prevKey.get(String(b.id || '')) || '',
      enabled: b.enabled !== false
    }))
  }
  ensure()
  writeFileSync(FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  return next
}

/** 该后端有没有可用的 key（本地后端不需要） */
function keyOf(b) {
  // 优先用面板里填的（存 vision.json，权限 600），其次环境变量
  if (b.apiKey) return String(b.apiKey).trim()
  if (!b.apiKeyEnv) return '__local__' // 本地/匿名后端不需要 key
  const v = process.env[b.apiKeyEnv]
  return v ? String(v).trim() : ''
}

/** 哪些后端现在真的能跑 */
export function readyBackends(cfg = loadVision()) {
  return (cfg.backends || []).filter((b) => b.enabled !== false && keyOf(b))
}

function httpErr(code, message, data) {
  const e = new Error(message)
  e.code = code
  if (data) e.data = data
  return e
}

/**
 * 调一个 OpenAI 兼容的视觉后端
 * @param {Object} b 后端配置
 * @param {Array<string>} images dataURL 数组
 * @param {string} question
 */
async function callBackend(b, images, question) {
  const key = keyOf(b)
  registerSecrets([key, ...urlSecrets(b.baseURL)])
  // 匿名/小额度后端限制每次送几张图（OVH 匿名 2 RPM，一次送 4 张等于 2 轮就用光）
  const cap = Math.max(1, Math.min(images.length, Number(b.maxImages) || images.length))
  const use = images.slice(0, cap)
  const content = [{ type: 'text', text: use.length < images.length ? `${question}\n（只附了前 ${use.length} 张）` : question }]
  for (const u of use) content.push({ type: 'image_url', image_url: { url: u } })

  const r = await fetch(completionUrl(b.baseURL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key && key !== '__local__' ? { Authorization: `Bearer ${key}` } : {})
    },
    body: JSON.stringify({
      model: b.model,
      max_tokens: b.maxTokens || 800,
      temperature: 0.2,
      messages: [{ role: 'user', content }]
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })

  const txt = await r.text()
  let j = null
  try {
    j = JSON.parse(txt)
  } catch {
    /* 非 JSON，下面统一处理 */
  }

  if (!r.ok) {
    const msg = redactText(j?.error?.message || j?.message || txt.slice(0, 200), [key, ...urlSecrets(b.baseURL)])
    // 429 / 5xx → 让上层切下一个后端；4xx 的 key 问题也切（换一家可能就好）
    throw httpErr(r.status === 429 ? 'VISION_RATE_LIMITED' : 'VISION_BACKEND_ERROR', `${b.name} 返回 ${r.status}：${msg}`, {
      status: r.status,
      retryAfter: r.headers.get('retry-after') || null
    })
  }
  const out = j?.choices?.[0]?.message?.content
  if (!out) throw httpErr('VISION_EMPTY', `${b.name} 返回空内容`)
  return redactText(out, [key]).trim()
}

/**
 * 让视觉模型描述图片（多后端自动 failover）
 *
 * @param {Object} opts
 * @param {Array<string>} opts.images - dataURL 数组（1~6 张）
 * @param {string} opts.question - 要问的问题（**带具体问题比泛泛描述更有用**）
 * @param {number} [opts.maxImages=4]
 * @param {boolean} [opts.cache=true]
 * @returns {Promise<{ok:boolean, text?:string, backend?:string, model?:string, ms?:number, tried?:Array, cached?:boolean, error?:string}>}
 */
export async function describeImages({ images = [], question, maxImages = 4, cache = true, race = false } = {}) {
  const cfg = loadVision()
  if (cfg.enabled === false) return { ok: false, error: '视觉链已关闭' }

  const q = String(question || '这几张画面里分别是什么？只描述你确实看到的内容：场景、人物、物体、文字。').slice(0, 500)
  const imgs = (images || []).filter(Boolean).slice(0, maxImages)
  if (!imgs.length) return { ok: false, error: '没有可描述的图片' }

  const ready = readyBackends(cfg)
  if (!ready.length) {
    return {
      ok: false,
      error: '没有可用的视觉后端（缺 API key）',
      hint: '任一即可：ZHIPU_API_KEY（智谱永久免费）/ DASHSCOPE_API_KEY（阿里云百炼）/ INTERN_API_KEY'
    }
  }

  const tried = []

  // ── 竞速模式：同时打前两个后端，谁先回用谁 ──────────────────────────────
  // 为什么需要：视觉调用是整轮里最慢的一步（单个后端 4~15 秒），而串行 failover
  // 只在「失败」时才切，救不了「慢」。实测智谱 4.6V 偶尔 429/拥堵，串行会白等。
  // 代价：两家都会扣一次额度（免费额度下可以接受）。
  if (race && ready.length > 1) {
    const picked = ready.slice(0, 2)
    const cks = picked.map((b) => (cache ? cacheKey(imgs.join('|'), q, b.model) : null))
    for (let i = 0; i < picked.length; i++) {
      const ck = cks[i]
      if (ck && memCache.has(ck)) {
        const hit = memCache.get(ck)
        if (Date.now() - hit.at < CACHE_TTL * 1000) {
          return { ok: true, text: hit.text, backend: picked[i].name, model: picked[i].model, cached: true, ms: 0, tried, race: true }
        }
      }
    }
    const t0 = Date.now()
    const settled = await Promise.allSettled(
      picked.map(async (b, i) => {
        const text = await callBackend(b, imgs, q)
        return { b, text, i }
      })
    )
    const win = settled.find((r) => r.status === 'fulfilled')
    settled.forEach((r, i) => {
      if (r.status === 'rejected') tried.push({ backend: picked[i].name, code: r.reason?.code || 'ERR', message: redactText(r.reason?.message || r.reason).slice(0, 120) })
    })
    if (win) {
      const { b, text, i } = win.value
      if (cks[i]) memCache.set(cks[i], { at: Date.now(), text })
      return { ok: true, text, backend: b.name, model: b.model, ms: Date.now() - t0, images: imgs.length, tried, cached: false, race: true }
    }
    // 竞速全挂 → 落到下面的串行链继续兜底
  }

  for (const b of ready) {
    const ck = cache ? cacheKey(imgs.join('|'), q, b.model) : null
    if (ck && memCache.has(ck)) {
      const hit = memCache.get(ck)
      if (Date.now() - hit.at < CACHE_TTL * 1000) {
        return { ok: true, text: hit.text, backend: b.name, model: b.model, cached: true, ms: 0, tried }
      }
      memCache.delete(ck)
    }

    const t0 = Date.now()
    try {
      const text = await callBackend(b, imgs, q)
      const ms = Date.now() - t0
      if (ck) memCache.set(ck, { at: Date.now(), text })
      return { ok: true, text, backend: b.name, model: b.model, ms, images: imgs.length, tried, cached: false }
    } catch (e) {
      tried.push({ backend: b.name, code: e.code || 'ERR', message: redactText(e.message).slice(0, 140) })
      // 任何失败都继续试下一个：多一家免费额度就多一次机会
      continue
    }
  }

  return {
    ok: false,
    error: '所有视觉后端都失败了',
    tried,
    hint: '看 tried 里每条的原因：401/403 多是 key 或未开通模型，429 是限流，超时是网络'
  }
}

/** 给面板看的状态（不回显 key，只说配没配） */
export function visionStatus() {
  const cfg = loadVision()
  return {
    enabled: cfg.enabled !== false,
    maxPixels: MAX_PIXELS,
    timeoutMs: TIMEOUT_MS,
    cacheTtlSec: CACHE_TTL,
    cacheSize: memCache.size,
    backends: (cfg.backends || []).map((b) => ({
      id: b.id,
      name: b.name,
      model: b.model,
      baseURL: safeUrl(b.baseURL),
      apiKeyEnv: b.apiKeyEnv,
      enabled: b.enabled !== false,
      maxImages: b.maxImages || null,
      needsKey: Boolean(b.apiKeyEnv || b.apiKey),
      hasKey: Boolean(keyOf(b)),
      ready: b.enabled !== false && Boolean(keyOf(b))
    })),
    readyCount: readyBackends(cfg).length
  }
}

export function visionFile() {
  return FILE
}

export { MAX_PIXELS }
