/**
 * CORS 中间件（白名单版）
 * ============================================================================
 * Task D-E 收尾后重写：原实现是 `Access-Control-Allow-Origin: *` 且同时
 * `Allow-Credentials: true`，按 Fetch 规范浏览器会直接拒绝该响应——
 * 本地测试测不出来（不带 Origin 头），一上浏览器就全员登录失败。
 *
 * 现在的行为：
 *   · 有 Origin 且命中白名单 → 回显该 Origin + credentials + Vary: Origin
 *   · 有 Origin 但不在白名单   → 不下发 CORS 头（浏览器自然拦截）；默认仍放行请求，
 *                              设 CORS_STRICT=1 时直接 403，便于排查越权调用
 *   · 无 Origin（同源页面 / curl / 服务间调用）→ 不下发任何 CORS 头
 *
 * 白名单来源（按优先级）：
 *   1. 环境变量 CORS_ORIGINS，逗号分隔，如：
 *      CORS_ORIGINS="https://console.example.com,http://localhost:5173"
 *   2. 未设置时用内置默认（本地开发端口），保证开箱可用
 *
 * 可选附加域名：
 *   设置 CORS_RESERVED_ORIGINS 后，用 CORS_HAVP=1 启用（兼容旧开关名）。
 *   源码不预设任何部署者私人域名。
 */

import { redactText } from '../runtime.mjs'

/** 内置开发默认白名单（CORS_ORIGINS 未设置时使用） */
const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8080'
]

/** 备案域名预留位：CORS_HAVP=1 时并入白名单 */
const reservedOrigins = () => String(process.env.CORS_RESERVED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)

/**
 * 解析白名单
 * @returns {{ origins: string[], source: string, havp: boolean }}
 */
export function resolveOrigins() {
  const raw = String(process.env.CORS_ORIGINS || '').trim()
  const fromEnv = raw
    ? raw.split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)
    : []

  const havp = process.env.CORS_HAVP === '1'
  const origins = new Set(fromEnv.length ? fromEnv : DEFAULT_DEV_ORIGINS)
  if (havp) reservedOrigins().forEach(o => origins.add(o))

  // 恒允许的补充项（通过 CORS_ORIGIN_EXTRA 配置局域网真机调试来源）
  String(process.env.CORS_ORIGIN_EXTRA || '')
    .split(',')
    .map(s => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
    .forEach(o => origins.add(o))

  return {
    origins: [...origins],
    source: fromEnv.length ? 'CORS_ORIGINS' : '内置开发默认',
    havp
  }
}

/**
 * 启动时打印一次白名单，避免「到底允许了谁」靠猜
 * @returns {void}
 */
export function logCorsPolicy() {
  const { origins, source, havp } = resolveOrigins()
  console.log(`[cors] 白名单来源: ${source}｜允许 ${origins.length} 个来源`)
  origins.forEach(o => console.log(`[cors] ${redactText(o)}`))
  if (havp) console.log('[cors] 已启用环境变量配置的附加来源')
}

/**
 * CORS 中间件
 * @param {{ strict?: boolean }} [opts] - strict: 不在白名单时直接 403
 * @returns {import('express').RequestHandler}
 */
export function corsMiddleware(opts = {}) {
  const { origins } = resolveOrigins()
  const allow = new Set(origins)
  const strict = opts.strict ?? process.env.CORS_STRICT === '1'

  return (req, res, next) => {
    const origin = req.headers.origin

    // 存在 Origin 就必须声明按 Origin 变化，否则 CDN/代理会把 A 站的头缓存给 B 站
    if (origin) res.header('Vary', 'Origin')

    if (origin && allow.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin)
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      res.header('Access-Control-Allow-Credentials', 'true')
      res.header('Access-Control-Max-Age', '86400')
    } else if (origin && strict) {
      return res.status(403).json({
        error: '该来源不允许跨域访问',
        code: 'CORS_ORIGIN_DENIED',
        data: { origin }
      })
    }

    if (req.method === 'OPTIONS') {
      // 预检：命中时上面的头已下发；未命中时浏览器会因缺 Allow-Origin 自行拦截
      return res.status(204).end()
    }

    next()
  }
}
