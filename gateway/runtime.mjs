import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'

export const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const DATA_DIR = resolve(process.env.BILI_HUMANISM_DATA || join(ROOT, 'data'))
export const LEGACY_DIR = resolve(process.env.BILI_HUMANISM_LEGACY || join(DATA_DIR, 'legacy'))

const SECRET_FIELD = /^(?:api[-_]?key|access[-_]?key|authorization|proxy-authorization|password|passwd|pass|secret|salt|hash|token|access[-_]?token|refresh[-_]?token|auth|cookie|set-cookie|credential|credentials)$/i
const SECRET_ENV = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH_HASH|AUTH_SALT|COOKIE|CREDENTIAL)/i
const knownSecrets = new Set()

export function registerSecrets(values = []) {
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 4) continue
    knownSecrets.add(value)
    if (knownSecrets.size > 2048) knownSecrets.delete(knownSecrets.values().next().value)
  }
}

export function urlSecrets(value) {
  try {
    const url = new URL(value, 'http://localhost')
    return [decodeURIComponent(url.username), decodeURIComponent(url.password), ...url.searchParams.values()]
  } catch {
    return []
  }
}

export function completionUrl(base) {
  const url = new URL(base)
  url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions'
  return url.href
}

export function safeUrl(value) {
  const text = String(value || '')
  try {
    const url = new URL(text)
    if (url.username) url.username = 'REDACTED'
    if (url.password) url.password = 'REDACTED'
    for (const name of [...url.searchParams.keys()]) url.searchParams.set(name, 'REDACTED')
    if (url.hash) url.hash = 'REDACTED'
    return url.href
  } catch {
    return text.replace(/([?&][^=&#\s]+=)[^&#\s]*/g, '$1REDACTED')
  }
}

/** 在日志和状态边界遮盖凭证；已知密钥也按原值清除，避免上游裸回显。 */
export function redactText(value, secrets = []) {
  let text = String(value ?? '')
  const urls = text.match(/https?:\/\/[^\s<>"'`]+/gi) || []
  const values = [...knownSecrets, ...secrets, ...urls.flatMap(urlSecrets), ...Object.entries(process.env).filter(([key]) => SECRET_ENV.test(key)).map(([, v]) => v)]
  for (const secret of values) {
    if (typeof secret !== 'string' || secret.length < 4) continue
    for (const variant of new Set([secret, encodeURIComponent(secret)])) text = text.split(variant).join('[REDACTED]')
  }
  return text
    .replace(/https?:\/\/[^\s<>"'`]+/gi, (url) => safeUrl(url))
    .replace(/((?:authorization|proxy-authorization)\s*["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic)\s+)?[^\s,"'<>}]+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
    .replace(/(["']?(?:api[-_]?key|access[-_]?key|password|passwd|pass|secret|salt|hash|token|access[-_]?token|refresh[-_]?token|auth|cookie|credential)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;<>}]+)/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/([?&][^=&#\s]+=)[^&#\s]*/g, '$1REDACTED')
}

export function redactData(value, secrets = []) {
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactData(item, secrets))
  if (value && typeof value === 'object') {
    registerSecrets(Object.entries(value).filter(([key]) => SECRET_FIELD.test(key)).map(([, item]) => item))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      SECRET_FIELD.test(key) ? (item ? '***' : '') : redactData(item, secrets)
    ]))
  }
  return value
}

/** 状态界面里的地址可编辑；保存打码地址时逐项保留旧认证参数。 */
export function restoreUrl(value, previous) {
  if (!previous || value === previous) return value
  if (value === safeUrl(previous) || value === redactText(previous)) return previous
  try {
    const next = new URL(value)
    const old = new URL(previous)
    if (next.username === 'REDACTED') next.username = old.username
    if (next.password === 'REDACTED') next.password = old.password
    for (const [name, item] of next.searchParams) {
      if (item === 'REDACTED' && old.searchParams.has(name)) next.searchParams.set(name, old.searchParams.get(name))
    }
    if (next.hash === '#REDACTED') next.hash = old.hash
    return next.href
  } catch {
    return value
  }
}
