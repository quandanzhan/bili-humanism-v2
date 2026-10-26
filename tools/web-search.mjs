/**
 * 工具：全网搜索（关键词 → 结果列表）
 * ============================================================================
 * 输入：关键词
 * 输出：结构化结果列表 [{ rank, title, url, snippet, source }]
 *
 * 关键约束：
 *   · 不依赖任何付费 API：解析搜索引擎的 HTML 结果页（默认 Bing，可切 DuckDuckGo）
 *   · 引擎地址可用环境变量覆盖：WEB_SEARCH_ENDPOINT（支持 {q} 占位符）
 *   · limit 默认 10、上限 20；page 默认 1
 *   · 结果为空时抛 EMPTY_RESULT（而不是返回空列表让调用方猜）
 *   · 会解开 Bing / DuckDuckGo 的跳转包裹链接，输出真实目标 URL
 *
 * 与 bili_search 的区别：本工具搜全网，bili_search 只搜 B 站站内视频。
 */

import { fetchText, httpError } from '../integrations/fetch-client.mjs'
import { decodeEntities } from '../integrations/html-extract.mjs'

/** 默认引擎 */
const DEFAULT_PROVIDER = () => (process.env.WEB_SEARCH_PROVIDER || 'bing').toLowerCase()

/**
 * Bing 跳转链接还原：/ck/a?u=a1<base64url>
 * @param {string} href
 * @returns {string}
 */
function unwrapBing(href) {
  try {
    const u = new URL(href, 'https://www.bing.com')
    const raw = u.searchParams.get('u')
    if (raw && raw.startsWith('a1')) {
      const b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/')
      const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
      return Buffer.from(pad, 'base64').toString('utf8')
    }
    return href
  } catch {
    return href
  }
}

/**
 * DuckDuckGo 跳转链接还原：/l/?uddg=<urlencoded>
 * @param {string} href
 * @returns {string}
 */
function unwrapDdg(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com')
    const target = u.searchParams.get('uddg')
    return target ? decodeURIComponent(target) : href
  } catch {
    return href
  }
}

/**
 * 去标签 + 解码实体 + 压空白
 * @param {string} s
 * @returns {string}
 */
function plain(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

/**
 * 解析 Bing 结果页
 * @param {string} html
 * @returns {Array<{title:string,url:string,snippet:string}>}
 */
function parseBing(html) {
  const out = []
  const blocks = String(html).split(/<li\s+class="b_algo"/i).slice(1)

  for (const block of blocks) {
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!a) continue

    const url = unwrapBing(decodeEntities(a[1]))
    const title = plain(a[2])
    if (!title || !/^https?:\/\//i.test(url)) continue

    const p = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block) ||
              /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)

    out.push({ title, url, snippet: p ? plain(p[1]) : '' })
  }
  return out
}

/**
 * 解析 DuckDuckGo HTML 版结果页
 * @param {string} html
 * @returns {Array<{title:string,url:string,snippet:string}>}
 */
function parseDuckDuckGo(html) {
  const out = []
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippets = [...String(html).matchAll(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map(m => plain(m[1]))

  let m
  let i = 0
  while ((m = re.exec(html)) !== null) {
    const url = unwrapDdg(decodeEntities(m[1]))
    const title = plain(m[2])
    if (!title || !/^https?:\/\//i.test(url)) continue
    out.push({ title, url, snippet: snippets[i] || '' })
    i++
  }
  return out
}

/**
 * 构造请求地址
 * @param {string} provider
 * @param {string} query
 * @param {number} page
 * @returns {string}
 */
function buildUrl(provider, query, page) {
  const custom = process.env.WEB_SEARCH_ENDPOINT
  if (custom) {
    return custom
      .replace(/\{q\}/g, encodeURIComponent(query))
      .replace(/\{page\}/g, String(page))
  }
  if (provider === 'duckduckgo' || provider === 'ddg') {
    return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  }
  // Bing：first 参数用于翻页（第 n 页 = (n-1)*10+1）
  const first = (page - 1) * 10 + 1
  return `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&first=${first}`
}

export default {
  name: 'web_search',
  description: '全网搜索：输入关键词，返回搜索结果列表（标题/链接/摘要）。与 bili_search（站内搜索）相互独立。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      limit: { type: 'number', description: '返回条数，默认 10，上限 20' },
      page: { type: 'number', description: '页码，默认 1' },
      provider: { type: 'string', description: '引擎：bing（默认）或 duckduckgo', enum: ['bing', 'duckduckgo'] },
      timeoutMs: { type: 'number', description: '请求超时毫秒，默认 12000' }
    },
    required: ['query']
  },
  /**
   * @param {{ query: string, limit?: number, page?: number, provider?: string, timeoutMs?: number }} args
   * @param {{ timeoutMs?: number }} [exec]
   * @returns {Promise<string>} JSON 字符串
   */
  async execute(args = {}, exec = {}) {
    const query = String(args.query ?? '').trim()
    if (!query) throw httpError('INVALID_ARGUMENT', '关键词不能为空')

    const provider = (args.provider || DEFAULT_PROVIDER()).toLowerCase()
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20)
    const page = Math.max(1, Number(args.page) || 1)

    const url = buildUrl(provider, query, page)
    const res = await fetchText(url, {
      timeoutMs: Number(args.timeoutMs) || Number(exec.timeoutMs) || 12000,
      headers: {
        // Bing 对无 Cookie 的纯 UA 请求更友好
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    })

    const parsed = provider === 'duckduckgo' || provider === 'ddg'
      ? parseDuckDuckGo(res.text)
      : parseBing(res.text)

    if (!parsed.length) {
      throw httpError('EMPTY_RESULT', '搜索引擎没有解析出结果（可能被反爬或页面结构变化）', {
        provider,
        url,
        snippet: res.text.slice(0, 200)
      })
    }

    const results = parsed.slice(0, limit).map((r, i) => ({
      rank: (page - 1) * 10 + i + 1,
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      source: provider
    }))

    return JSON.stringify(
      { query, provider, page, count: results.length, results },
      null,
      2
    )
  }
}
