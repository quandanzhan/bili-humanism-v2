/**
 * 统一 HTTP 抓取客户端
 * ============================================================================
 * 给「网页抓取 / 搜索 / B站接口」三个工具共用。不放 tools/ 目录，因为它不是工具模块
 * （Engine 的扫描器只认「默认导出含 name + execute」的文件，放进去会刷警告）。
 *
 * 能力与约束：
 *   · 只允许 http/https，其余协议（file:、data:、ftp:）直接 URL_INVALID
 *   · 分块读取并强制大小上限（默认 5MB），超限立刻中断 —— 不把整个响应读进内存
 *   · 超时用 AbortController（默认 15s），失联不会挂死
 *   · 自动识别编码：优先 Content-Type 的 charset，其次嗅探 <meta charset>，回退 utf-8
 *     （Node 22 内置 full-icu，gbk/gb18030/big5 都能解）
 *   · 429 / 5xx / 网络错误自动重试一次（退避 400ms，尊重 Retry-After 上限 3s）
 *
 * 错误码（均带 code，供网关映射状态码）：
 *   URL_INVALID / FETCH_TIMEOUT / FETCH_TOO_LARGE / FETCH_FAILED / UPSTREAM_HTTP_ERROR
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 视为「可重试」的上游状态码 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * 构造带 code 的错误
 * @param {string} code
 * @param {string} message
 * @param {object} [data]
 * @returns {Error}
 */
export function httpError(code, message, data = {}) {
  const err = new Error(message)
  err.code = code
  err.data = data
  return err
}

/**
 * 校验并规范化 URL
 * @param {string} raw
 * @returns {string} 规范化后的 URL
 * @throws {Error} URL_INVALID
 */
export function normalizeUrl(raw) {
  const input = String(raw ?? '').trim()
  if (!input) throw httpError('URL_INVALID', 'URL 不能为空')

  // 用户常忘写协议，按 http(s) 补全（优先 https）
  let candidate = input
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    candidate = 'https://' + candidate
  }

  let u
  try {
    u = new URL(candidate)
  } catch {
    throw httpError('URL_INVALID', `URL 格式不合法：${input}`)
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw httpError('URL_INVALID', `只支持 http/https，收到：${u.protocol}`)
  }
  if (!u.hostname || !u.hostname.includes('.') && u.hostname !== 'localhost') {
    throw httpError('URL_INVALID', `URL 缺少有效主机名：${input}`)
  }
  return u.toString()
}

/**
 * 从 Content-Type 或 HTML 头部嗅探字符集
 * @param {string} contentType
 * @param {Uint8Array} head - 前若干字节
 * @returns {string} 字符集名（小写）
 */
function detectCharset(contentType, head) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '')
  if (m) return m[1].toLowerCase()

  // 用 latin1 看头部，避免用错编码解出乱码
  const sniff = Buffer.from(head).toString('latin1')
  const meta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff) ||
    /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(sniff)
  if (meta) return meta[1].toLowerCase()

  return 'utf-8'
}

/**
 * 用指定编码解码（失败自动回退 utf-8）
 * @param {Uint8Array} bytes
 * @param {string} charset
 * @returns {{ text: string, encoding: string }}
 */
export function decodeBytes(bytes, charset = 'utf-8') {
  const tryList = [charset, 'utf-8']
  for (const label of tryList) {
    try {
      return { text: new TextDecoder(label).decode(bytes), encoding: label }
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return { text: Buffer.from(bytes).toString('utf8'), encoding: 'utf-8(fallback)' }
}

/**
 * 抓取文本内容
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {Record<string,string>} [opts.headers]
 * @param {string} [opts.body]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.retries] - 额外重试次数（默认 1）
 * @param {boolean} [opts.throwOnHttpError] - 默认 true
 * @param {boolean} [opts.allowHtmlIfError] - 出错时也返回响应体（便于诊断）
 * @returns {Promise<{status:number, ok:boolean, headers:Headers, text:string, encoding:string, bytes:number, finalUrl:string, truncated:boolean, attempts:number}>}
 */
export async function fetchText(rawUrl, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 15000,
    maxBytes = 5 * 1024 * 1024,
    retries = 1,
    throwOnHttpError = true
  } = opts

  const url = normalizeUrl(rawUrl)
  let lastErr = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': DEFAULT_UA,
          'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
          ...headers
        }
      })

      // 上游错误且允许重试 → 记下来继续
      if (!res.ok && RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after'))
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 3000) : 400
        await res.body?.cancel().catch(() => {})
        await new Promise(r => setTimeout(r, wait))
        lastErr = httpError('UPSTREAM_HTTP_ERROR', `上游返回 ${res.status}`, { url, status: res.status, attempt })
        continue
      }

      // 分块读，超过 maxBytes 立即中断
      const chunks = []
      let total = 0
      let truncated = false

      if (res.body) {
        const reader = res.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > maxBytes) {
            truncated = true
            chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))))
            await reader.cancel().catch(() => {})
            break
          }
          chunks.push(value)
        }
      }

      const bytes = Buffer.concat(chunks.map(c => Buffer.from(c)))
      const contentType = res.headers.get('content-type') || ''
      const { text, encoding } = decodeBytes(bytes, detectCharset(contentType, bytes.subarray(0, 2048)))

      const out = {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        text,
        encoding,
        bytes: bytes.byteLength,
        finalUrl: res.url || url,
        truncated,
        attempts: attempt + 1
      }

      if (!res.ok && throwOnHttpError) {
        throw httpError('UPSTREAM_HTTP_ERROR', `上游返回 ${res.status} ${res.statusText || ''}`.trim(), {
          url: out.finalUrl,
          status: out.status,
          statusText: res.statusText,
          snippet: text.slice(0, 300)
        })
      }

      return out
    } catch (err) {
      // 自己抛的 UPSTREAM_HTTP_ERROR 直接上抛（重试已在上面处理）
      if (err?.code === 'UPSTREAM_HTTP_ERROR') {
        lastErr = err
        continue
      }
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        lastErr = httpError('FETCH_TIMEOUT', `请求超时（>${timeoutMs}ms）`, { url, timeoutMs })
        if (attempt < retries) continue
        throw lastErr
      }
      lastErr = httpError('FETCH_FAILED', `请求失败：${err?.message || err}`, { url })
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 300))
        continue
      }
      throw lastErr
    } finally {
      clearTimeout(timer)
    }
  }

  throw lastErr || httpError('FETCH_FAILED', '请求失败（未知原因）', { url })
}

/**
 * 抓取 JSON（B站接口等）
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function fetchJson(url, opts = {}) {
  const res = await fetchText(url, {
    ...opts,
    headers: { Accept: 'application/json, text/plain, */*', ...(opts.headers || {}) }
  })
  try {
    return { json: JSON.parse(res.text), raw: res }
  } catch {
    throw httpError('PARSE_FAILED', '响应不是合法 JSON', {
      url: res.finalUrl,
      status: res.status,
      snippet: res.text.slice(0, 300)
    })
  }
}

export { DEFAULT_UA }
