import { DATA_DIR, redactText, registerSecrets } from './runtime.mjs'
/**
 * 运行时设置（SMTP 预警 + 工具开关）
 * ============================================================================
 * @module gateway/settings
 * @description 管理员可在控制台即时调整，首次启动可从环境变量初始化：
 *              · smtp     —— 预警邮件（V1 用 reply-service/service.env 的 SMTP_* 变量）
 *              · tools    —— 每个工具的开关（{ 工具名: true/false }）
 *              · alerts   —— 告警节流参数
 *
 * 存储：data/settings.json（可用 BILI_HUMANISM_SETTINGS 覆盖），权限 600。
 * 首次生成从环境变量初始化 SMTP；仅显式设置 BILI_HUMANISM_V1_ENV 时导入旧配置。
 * 不会查找或复制部署机器上的生产配置。
 * @exports {Function} load - 读全部设置
 * @exports {Function} save - 合并保存
 * @exports {Function} getSmtp / putSmtp - SMTP 读写（读时密码打码）
 * @exports {Function} isToolEnabled / setToolEnabled / allToolStates
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'

const FILE = process.env.BILI_HUMANISM_SETTINGS || join(DATA_DIR, 'settings.json')
const V1_ENV_FILE = process.env.BILI_HUMANISM_V1_ENV || ''

/** 读取 V1 的 service.env（简单 KEY=VALUE 解析，忽略注释与空行） */
function readV1Env() {
  try {
    const out = {}
    for (const line of readFileSync(V1_ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
      if (!m) continue
      let v = m[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out[m[1]] = v
    }
    return out
  } catch {
    return {}
  }
}

/** 默认设置：SMTP 优先取进程环境，其次取 V1 的 service.env 迁移过来 */
function defaults() {
  const v1 = readV1Env()
  const pick = (k) => process.env[k] || v1[k] || ''
  return {
    smtp: {
      enabled: Boolean(pick('SMTP_HOST')) && Boolean(pick('ALERT_TO')),
      host: pick('SMTP_HOST'),
      port: Number(pick('SMTP_PORT')) || 465,
      security: (pick('SMTP_SECURITY') || 'ssl').toLowerCase(),
      user: pick('SMTP_USER'),
      pass: pick('SMTP_PASSWORD'),
      from: pick('SMTP_FROM') || pick('SMTP_USER'),
      to: pick('ALERT_TO'),
      subjectPrefix: '[海棠 B站助手]',
      legacyFrom: v1.SMTP_HOST ? 'v1-service.env' : null
    },
    tools: {},
    // 场景化工具集：**不写死**，用户可通过 PUT /api/tools/scope 改。
    // 借鉴 dsh-bili-scroll：值班那一轮只给它只读工具，发评论的权限默认不给 ——
    // 不是靠提示词约束它别用，而是模型连工具名都看不到。
    toolScopes: {
      // 值班：只看不写
      duty: ['bili_search', 'bili_video', 'bili_subtitle', 'bili_comments', 'bili_frames', 'bili_vision', 'web_fetch'],
      // 私信对话：允许查视频、看画面、听音频，但不给发评论
      reply: ['bili_search', 'bili_video', 'bili_subtitle', 'bili_comments', 'bili_at', 'bili_frames', 'bili_vision', 'bili_asr', 'web_fetch', 'web_search', 'file_read'],
      // 评论：只有开了写权限才会用到的那个
      comment: ['bili_comment_reply']
    },
    // 写操作策略（对外发布类动作的唯一闸门，见 gateway/writes.mjs）
    // 「回复评论」开着是因为用户明确要求；「主动发新评论」默认关——那是刷屏不是对话。
    writes: {
      enabled: true,
      allowCommentReply: true,
      allowNewComment: false,
      maxPerHour: 12,
      maxPerMinute: 2,
      maxChars: 400
    },
    alerts: {
      throttleMs: Number(pick('ALERT_THROTTLE_MS')) || 10 * 60 * 1000,
      on5xx: true,
      onChannelFailed: true
    }
  }
}

function ensureDir() {
  try {
    mkdirSync(dirname(FILE), { recursive: true })
  } catch {
    /* 已存在 */
  }
}

/** 深度合并（只处理普通对象，够用） */
function merge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = merge(base[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

/** 直接落盘（不做任何读取/合并），load 与 save 都只走这里，避免互相递归 */
function writeRaw(data) {
  ensureDir()
  writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8')
  try {
    chmodSync(FILE, 0o600)
  } catch {
    /* 非 POSIX 环境忽略 */
  }
  return data
}

/** 读文件里的原始对象（不存在/损坏返回 null） */
function readRaw() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'))
  } catch {
    return null
  }
}

/** 读取全部设置（文件不存在/损坏时用默认值重建） */
export function load() {
  if (!existsSync(FILE)) return writeRaw(defaults())
  const raw = readRaw()
  if (!raw || typeof raw !== 'object') return writeRaw(defaults())
  // 补齐后续新增字段，老文件也能用
  return merge(defaults(), raw)
}

/** 保存（增量合并） */
export function save(patch) {
  const base = existsSync(FILE) ? (readRaw() || defaults()) : defaults()
  return writeRaw(merge(base, patch))
}

/** 给前端看的 SMTP 配置（密码打码，只回是否已设置） */
export function getSmtp() {
  const s = load().smtp
  return {
    enabled: Boolean(s.enabled),
    host: s.host || '',
    port: s.port || 465,
    security: s.security || 'ssl',
    user: s.user || '',
    from: s.from || '',
    to: s.to || '',
    subjectPrefix: s.subjectPrefix || '',
    hasPassword: Boolean(s.pass),
    passwordMasked: s.pass ? '***' : '',
    legacyFrom: s.legacyFrom || null
  }
}

/** 内部用：带真实密码的 SMTP 配置 */
export function getSmtpRaw() {
  const smtp = load().smtp
  registerSecrets([smtp.pass])
  return smtp
}

/**
 * 更新 SMTP。password 传 '***' 或空字符串表示「不修改」
 * @param {Object} patch
 */
export function putSmtp(patch = {}) {
  const cur = getSmtpRaw()
  const next = { ...cur, ...patch }
  if (patch.pass === '***' || patch.pass === undefined) next.pass = cur.pass
  if (typeof patch.port === 'string') next.port = Number(patch.port) || 465
  if (typeof next.enabled === 'string') next.enabled = next.enabled === 'true'
  return save({ smtp: next }).smtp
}

/**
 * 工具是否启用（未显式配置时默认启用）
 * @param {string} name
 * @returns {boolean}
 */
export function isToolEnabled(name) {
  const t = load().tools || {}
  return t[name] !== false
}

/** 设置单个工具开关 */
export function setToolEnabled(name, enabled) {
  const t = { ...(load().tools || {}) }
  t[name] = Boolean(enabled)
  save({ tools: t })
  return t
}

/** 全部工具开关状态 */
export function allToolStates() {
  return { ...(load().tools || {}) }
}

/**
 * 取某个场景允许的工具名列表。
 * @param {string} scene 'duty' | 'reply' | 'comment'
 * @returns {string[]} 空数组表示「不限制」（未配置该场景时）
 */
export function getToolScope(scene) {
  const all = load().toolScopes || {}
  const list = all[scene]
  return Array.isArray(list) ? list.map(String) : []
}

/** 改场景工具集（可整组覆盖，也可只改一个场景） */
export function setToolScope(scene, names) {
  const cur = { ...(load().toolScopes || {}) }
  if (names === null) delete cur[scene]
  else cur[scene] = (Array.isArray(names) ? names : []).map((x) => String(x).slice(0, 60)).slice(0, 40)
  save({ toolScopes: cur })
  return cur
}

/** 设置文件路径（给前端展示） */
export function settingsFile() {
  return FILE
}
