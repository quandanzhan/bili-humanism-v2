/**
 * HTML → 正文提取
 * ============================================================================
 * 目标：把网页变成「人能读的正文」，去掉导航、侧栏、广告、脚本、页脚这些噪声。
 *
 * 策略（无第三方依赖，纯正则 + 结构启发式）：
 *   1. 先删「一定不是正文」的标签块：script/style/noscript/svg/template/iframe/canvas
 *   2. 抽 title / meta description 作为元信息
 *   3. 选正文根：<article> → <main> → [role=main] → <body>
 *   4. 在根内删噪声容器：nav/header/footer/aside/form/button，以及 class/id 命中
 *      ad/banner/sidebar/comment/share/recommend/copyright 等关键词的块
 *   5. 块级标签转行、<li> 转「• 」、<br> 转换行
 *   6. 去标签 → 解实体 → 逐行 trim → 合并空行 → 丢掉短于 2 字的碎片行
 *
 * 已知限制：
 *   · 不执行 JS，纯服务端渲染的页面（SPA）可能只拿到骨架
 *   · 不解析 CSS 的 display:none（只按标签与 class 关键词判断）
 */

/** 直接整块丢弃的标签 */
const DROP_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed']

/** 噪声容器标签 */
const NOISE_TAGS = ['nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'dialog']

/** class/id 命中的噪声关键词 */
const NOISE_WORDS = [
  'advert', 'adsbygoogle', ' ad-', '-ad-', 'banner', 'sidebar', 'side-bar', 'right-rail',
  'comment', 'share', 'social', 'recommend', 'related', 'copyright', 'cookie', 'popup',
  'modal', 'breadcrumb', 'pagination', 'pager', 'toolbar', 'navbar', 'menu', 'subscribe',
  'newsletter', 'widget', 'sponsor', 'promo'
]

/** 块级标签（转换行） */
const BLOCK_TAGS = [
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'dl', 'dt', 'dd', 'table',
  'thead', 'tbody', 'tr', 'blockquote', 'pre', 'figure', 'figcaption', 'address', 'hr'
]

/**
 * 解码常见 HTML 实体
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—',
    ndash: '–', middot: '·', copy: '©', reg: '®', trade: '™', times: '×', divide: '÷'
  }
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => (named[name.toLowerCase()] !== undefined ? named[name.toLowerCase()] : m))
}

function safeFromCodePoint(n) {
  try {
    return String.fromCodePoint(n)
  } catch {
    return ''
  }
}

/**
 * 删掉「标签 + 其内容」的整块
 * @param {string} html
 * @param {string} tag
 * @returns {string}
 */
function dropBlock(html, tag) {
  // 成对标签：非贪婪但跳过嵌套同名标签的场景极少，这里够用
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi')
  let prev = html
  let next = prev.replace(re, ' ')
  // 最多再清 2 轮，处理同名嵌套残留
  for (let i = 0; i < 2 && next !== prev; i++) {
    prev = next
    next = prev.replace(re, ' ')
  }
  // 自闭合 / 未闭合残留
  next = next.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ')
  return next
}

/**
 * 删除 class/id 命中噪声关键词的元素（含内容）
 * @param {string} html
 * @returns {string}
 */
function dropNoisyContainers(html) {
  return html.replace(/<([a-z][a-z0-9]*)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (match, tag, attrs, inner) => {
    if (inner.length > 12000) return match // 超大块不动，避免误删整页正文
    const probe = ` ${String(attrs).toLowerCase()} `
    const attrMatch = /(?:class|id)\s*=\s*["']([^"']*)["']/i.exec(attrs || '')
    const cls = attrMatch ? attrMatch[1].toLowerCase() : ''
    const hay = `${probe} ${cls} `
    if (NOISE_WORDS.some(w => hay.includes(w))) return ' '
    return match
  })
}

/**
 * 抽取 <title> 与 meta 描述
 * @param {string} html
 * @returns {{ title: string, description: string }}
 */
function extractMeta(html) {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const d =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html) ||
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(html) ||
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i.exec(html)

  return {
    title: t ? decodeEntities(t[1]).replace(/\s+/g, ' ').trim() : '',
    description: d ? decodeEntities(d[1]).replace(/\s+/g, ' ').trim() : ''
  }
}

/**
 * 选正文根节点
 * @param {string} html
 * @returns {{ html: string, root: string }}
 */
function pickRoot(html) {
  const candidates = [
    { tag: 'article', re: /<article\b[^>]*>([\s\S]*?)<\/article>/i },
    { tag: 'main', re: /<main\b[^>]*>([\s\S]*?)<\/main>/i },
    { tag: '[role=main]', re: /<div\b[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/div>/i },
    { tag: 'body', re: /<body\b[^>]*>([\s\S]*?)<\/body>/i }
  ]

  for (const c of candidates) {
    const m = c.re.exec(html)
    if (m && m[1] && m[1].trim().length > 200) {
      return { html: m[1], root: c.tag }
    }
  }
  return { html, root: 'full-document' }
}

/**
 * HTML 片段 → 纯文本
 * @param {string} html
 * @returns {string}
 */
function toPlainText(html) {
  let s = html

  // 保留代码块内的换行语义
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\n${code}\n\n`)

  // 列表项
  s = s.replace(/<li\b[^>]*>/gi, '\n• ').replace(/<\/li>/gi, '')

  // 换行与分隔
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<hr\b[^>]*>/gi, '\n---\n')

  // 表格单元格加制表符
  s = s.replace(/<\/(td|th)>/gi, '\t').replace(/<\/tr>/gi, '\n')

  // 块级标签 → 双换行
  for (const tag of BLOCK_TAGS) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), '\n')
    s = s.replace(new RegExp(`</${tag}>`, 'gi'), '\n')
  }

  // 其余标签直接去掉
  s = s.replace(/<[^>]+>/g, '')

  // 实体 & 空白规整
  s = decodeEntities(s)
  s = s.replace(/\r\n?/g, '\n')
  s = s.replace(/[ \t\u00a0]+/g, ' ')
  s = s
    .split('\n')
    .map(line => line.trim())
    // 丢掉纯符号 / 单字符碎片（多为图标、面包屑分隔符）
    .filter(line => line.length >= 2 || /[\u4e00-\u9fa5A-Za-z0-9]/.test(line))
    .join('\n')
  s = s.replace(/\n{3,}/g, '\n\n')

  return s.trim()
}

/**
 * 主入口：HTML → 正文
 * @param {string} html
 * @param {{ keepTitleLine?: boolean }} [opts]
 * @returns {{ title: string, description: string, text: string, chars: number, root: string }}
 */
export function htmlToText(html, opts = {}) {
  const raw = String(html ?? '')
  const meta = extractMeta(raw)

  let cleaned = raw

  // 1. 整块丢弃非内容标签
  for (const tag of DROP_TAGS) cleaned = dropBlock(cleaned, tag)

  // 2. 删 HTML 注释（含条件注释）
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, ' ')

  // 3. 选正文根
  const picked = pickRoot(cleaned)
  let body = picked.html

  // 4. 删噪声容器标签
  for (const tag of NOISE_TAGS) body = dropBlock(body, tag)

  // 5. 删 class/id 命中噪声词的容器
  body = dropNoisyContainers(body)

  // 6. 转文本
  let text = toPlainText(body)

  // 7. 有 title 时补一行（可选）
  if (opts.keepTitleLine && meta.title && !text.startsWith(meta.title)) {
    text = `${meta.title}\n\n${text}`
  }

  return {
    title: meta.title,
    description: meta.description,
    text,
    chars: text.length,
    root: picked.root
  }
}

/**
 * 粗略判断正文是否「像被 JS 渲染的骨架」（正文过短）
 * @param {{chars:number, text:string}} extracted
 * @returns {boolean}
 */
export function looksLikeSkeleton(extracted) {
  const t = extracted?.text || ''
  if (t.length < 200) return true
  // 含大量「请启用 JavaScript」提示
  return /enable javascript|请开启\s*javascript|需要启用.*脚本/i.test(t)
}
