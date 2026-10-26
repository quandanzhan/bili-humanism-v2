import { join, dirname } from 'node:path'
import { DATA_DIR, redactText, redactData, registerSecrets } from '../runtime.mjs'
/**
 * 账号路由：B 站扫码登录 + 小红书 Cookie 管理
 * ============================================================================
 * @module gateway/routes/account
 * @description 参考 V1 的 bili-duty/mcp_server.py（LoginSession 二维码登录）实现，
 *              改成纯 Node 版：调 B 站 passport 的 generate / poll 两个接口，
 *              二维码图片用 qrcode 包在服务端渲染成 dataURL 给前端显示。
 *
 * 流程：
 *   POST /api/account/bili/qrcode        → { key, image(dataURL), url, expiresIn }
 *   GET  /api/account/bili/qrcode/poll   → { state: waiting|scanned|expired|confirmed, ... }
 *         confirmed 时把 Set-Cookie 里的 SESSDATA / bili_jct / DedeUserID / buvid3
 *         写回 BILI_CREDENTIAL 文件（就是 V1 那个 bili_credential.json，格式兼容），
 *         读取方须使用同一 BILI_CREDENTIAL 路径；bili-api 的进程内凭据缓存需重启刷新。
 *   GET  /api/account/bili/status        → 当前 Cookie 是否有效（nav 接口）
 *
 * 小红书没有官方扫码接口，沿用 Cookie：GET/PUT /api/account/xhs。
 * @exports {Function} createAccountRouter
 */

import { Router } from 'express'
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { requireAuth } from '../auth.mjs'

const CRED_FILE = process.env.BILI_CREDENTIAL || join(DATA_DIR, 'bili_credential.json')
const PLUGINS_FILE = process.env.PLUGINS_FILE || join(DATA_DIR, 'plugins.json')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** 二维码 key 的内存表：key → { createdAt }（10 分钟过期） */
const qrSessions = new Map()
const QR_TTL = 10 * 60 * 1000

/** 读凭据文件（容忍不存在/坏 JSON） */
function readCred() {
  try {
    return JSON.parse(readFileSync(CRED_FILE, 'utf8'))
  } catch {
    return {}
  }
}

/** 把 cookie 名值对写进凭据文件（保持小写键，loader 大小写兼容） */
function saveCredFromCookies(pairs) {
  const cur = readCred()
  const next = { ...cur }
  const map = {
    ['SESSDATA']: 'sessdata',
    ['bili_jct']: 'bili_jct',
    DedeUserID: 'dedeuserid',
    DedeUserID__ckMd5: 'dedeuserid_ckmd5',
    buvid3: 'buvid3',
    bili_ticket: 'bili_ticket'
  }
  const aliases = {
    SESSDATA: ['SESSDATA'],
    bili_jct: ['biliJct', 'BILI_JCT'],
    DedeUserID: ['DedeUserID', 'DEDEUSERID', 'uid'],
    buvid3: ['BUVID3', 'buvid_3']
  }
  for (const [k, v] of Object.entries(pairs)) {
    if (map[k] && v) {
      next[map[k]] = v
      for (const alias of aliases[k] || []) delete next[alias]
    }
  }
  next.updated_at = new Date().toISOString()
  next.updated_by = 'qrcode-login'
  mkdirSync(dirname(CRED_FILE), { recursive: true })
  registerSecrets(Object.values(pairs))
  writeFileSync(CRED_FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(CRED_FILE, 0o600)
  } catch {
    /* ignore */
  }
  return next
}

/** 从响应里取 Set-Cookie，返回 { 名: 值 } */
function parseSetCookies(res) {
  const out = {}
  let list = []
  if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie()
  else {
    const raw = res.headers.get('set-cookie')
    if (raw) list = raw.split(/,(?=[^;]+?=)/)
  }
  for (const c of list) {
    const first = String(c).split(';')[0]
    const idx = first.indexOf('=')
    if (idx > 0) out[first.slice(0, idx).trim()] = first.slice(idx + 1).trim()
  }
  return out
}

/** 当前 B 站账号状态（nav 接口） */
async function biliStatus() {
  const raw = readCred()
  const pick = (...keys) => keys.map(key => raw[key]).find(value => typeof value === 'string' && value.trim())?.trim() || ''
  const c = {
    sessdata: pick('SESSDATA', 'sessdata'),
    bili_jct: pick('bili_jct', 'biliJct', 'BILI_JCT'),
    buvid3: pick('buvid3', 'BUVID3', 'buvid_3'),
    dedeuserid: pick('DedeUserID', 'dedeuserid', 'DEDEUSERID', 'uid'),
    updated_at: raw.updated_at
  }
  registerSecrets(Object.values(c))
  const cookie = [
    c.sessdata ? `SESSDATA=${c.sessdata}` : '',
    c.bili_jct ? `bili_jct=${c.bili_jct}` : '',
    c.dedeuserid ? `DedeUserID=${c.dedeuserid}` : '',
    c.buvid3 ? `buvid3=${c.buvid3}` : ''
  ]
    .filter(Boolean)
    .join('; ')
  if (!cookie) return { loggedIn: false, reason: 'NO_CREDENTIAL', updatedAt: c.updated_at || null }
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie },
      signal: AbortSignal.timeout(10000)
    })
    const j = await r.json()
    const d = j?.data || {}
    return {
      loggedIn: Boolean(d.isLogin),
      uname: d.uname || '',
      mid: d.mid || 0,
      avatar: d.face || '',
      vip: d.vipStatus === 1,
      level: d.level_info?.current_level ?? null,
      code: j?.code,
      updatedAt: c.updated_at || null
    }
  } catch (e) {
    return { loggedIn: false, reason: 'NAV_FAILED', error: redactText(e?.message || e) }
  }
}

/**
 * 创建账号路由
 * @returns {Router}
 */
export function createAccountRouter() {
  const router = Router()
  router.use(requireAuth())

  /** GET /api/account/bili/status */
  router.get('/bili/status', async (req, res, next) => {
    try {
      res.json({ ...(await biliStatus()), credentialFile: CRED_FILE })
    } catch (e) {
      next(e)
    }
  })

  /** POST /api/account/bili/qrcode —— 生成登录二维码 */
  router.post('/bili/qrcode', async (req, res, next) => {
    try {
      const r = await fetch(
        'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header',
        { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(10000) }
      )
      const j = await r.json()
      if (j?.code !== 0 || !j?.data?.qrcode_key) {
        return res.status(502).json({ error: '获取二维码失败', code: 'QR_GENERATE_FAILED', data: redactData(j) })
      }
      const { url, qrcode_key: key } = j.data
      qrSessions.set(key, { createdAt: Date.now() })
      // 清理过期 key，避免无限增长
      for (const [k, v] of qrSessions) if (Date.now() - v.createdAt > QR_TTL) qrSessions.delete(k)

      let image = ''
      try {
        const qr = await import('qrcode')
        const QRCode = qr.default || qr
        image = await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: 'M' })
      } catch (e) {
        console.warn(`[account] qrcode 渲染失败（未安装 qrcode？）：${redactText(e?.message || e)}`)
      }
      res.json({ key, url, image, expiresIn: Math.floor(QR_TTL / 1000), hint: '用 B 站手机客户端扫码' })
    } catch (e) {
      next(e)
    }
  })

  /** GET /api/account/bili/qrcode/poll?key= */
  router.get('/bili/qrcode/poll', async (req, res, next) => {
    try {
      const key = String(req.query.key || '').trim()
      if (!key) return res.status(400).json({ error: '缺少 key', code: 'INVALID_REQUEST' })
      const sess = qrSessions.get(key)
      if (!sess || Date.now() - sess.createdAt > QR_TTL) {
        return res.json({ state: 'expired', message: '二维码已过期，请重新生成' })
      }

      const r = await fetch(
        `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`,
        { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(10000) }
      )
      const j = redactData(await r.json(), [key])
      const code = j?.data?.code
      // 86101 未扫码 / 86090 已扫码待确认 / 86038 已失效 / 0 成功
      if (code === 86101) return res.json({ state: 'waiting', message: j?.data?.message || '等待扫码' })
      if (code === 86090) return res.json({ state: 'scanned', message: j?.data?.message || '已扫码，请在手机上确认' })
      if (code === 86038) {
        qrSessions.delete(key)
        return res.json({ state: 'expired', message: j?.data?.message || '二维码已失效' })
      }
      if (code !== 0) {
        return res.json({ state: 'error', message: j?.data?.message || '未知状态', code })
      }

      const cookies = parseSetCookies(r)
      if (!cookies.SESSDATA) {
        return res.status(502).json({
          error: '登录成功但没拿到 SESSDATA',
          code: 'QR_COOKIE_MISSING',
          data: { got: Object.keys(cookies) }
        })
      }
      saveCredFromCookies(cookies)
      qrSessions.delete(key)
      const st = await biliStatus()
      res.json({
        state: 'confirmed',
        message: '登录成功',
        user: { uname: st.uname, mid: st.mid, avatar: st.avatar, level: st.level, vip: st.vip },
        cookieKeys: Object.keys(cookies),
        credentialFile: CRED_FILE
      })
    } catch (e) {
      next(e)
    }
  })

  /** GET /api/account/xhs —— 小红书 Cookie（打码） */
  router.get('/xhs', (req, res) => {
    let cookie = ''
    let enabled = false
    try {
      const j = JSON.parse(readFileSync(PLUGINS_FILE, 'utf8'))
      cookie = j?.xhs?.cookie || ''
      enabled = j?.xhs?.enabled === true
    } catch {
      /* 文件不存在 */
    }
    res.json({
      enabled,
      hasCookie: Boolean(cookie),
      cookieMasked: cookie ? '***' : '',
      file: PLUGINS_FILE
    })
  })

  /** PUT /api/account/xhs —— 更新小红书 Cookie */
  router.put('/xhs', (req, res, next) => {
    try {
      const { cookie, enabled } = req.body || {}
      if (cookie !== undefined && typeof cookie !== 'string') {
        return res.status(400).json({ error: 'cookie 必须是字符串', code: 'INVALID_REQUEST' })
      }
      let cur = { xhs: { cookie: '', enabled: false } }
      try {
        cur = JSON.parse(readFileSync(PLUGINS_FILE, 'utf8'))
      } catch {
        /* 新建 */
      }
      cur.xhs = cur.xhs || { cookie: '', enabled: false }
      if (typeof cookie === 'string' && cookie !== '***' && cookie !== '') cur.xhs.cookie = cookie
      if (enabled !== undefined) cur.xhs.enabled = Boolean(enabled)
      mkdirSync(dirname(PLUGINS_FILE), { recursive: true })
      registerSecrets([cur.xhs.cookie])
      writeFileSync(PLUGINS_FILE, JSON.stringify(cur, null, 2), { encoding: 'utf8', mode: 0o600 })
      try {
        chmodSync(PLUGINS_FILE, 0o600)
      } catch {
        /* ignore */
      }
      res.json({ ok: true, hasCookie: Boolean(cur.xhs.cookie), enabled: cur.xhs.enabled })
    } catch (e) {
      next(e)
    }
  })

  return router
}
