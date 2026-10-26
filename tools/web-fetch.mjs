/**
 * 工具：网页抓取（URL → 正文文本）
 * ============================================================================
 * 输入：一个 http/https URL
 * 输出：该页正文纯文本 + 标题/描述/字数等元信息
 *
 * 关键约束：
 *   · 只接受 http/https；未写协议时按 https 补全
 *   · 不执行 JavaScript —— 纯前端的 SPA 可能只拿到骨架，输出里 skeleton=true 提示
 *   · 响应体默认上限 5MB、超时 15s，超限/超时都会明确报错而不是静默截断
 *   · 正文提取会去掉 nav/header/footer/aside/form、脚本样式、广告与侧栏容器
 *   · maxChars 默认 20000（上限 100000），超出部分在输出里标注 truncated
 */

import { fetchText } from '../integrations/fetch-client.mjs'
import { htmlToText, looksLikeSkeleton } from '../integrations/html-extract.mjs'

export default {
  name: 'web_fetch',
  description: '抓取网页并返回正文纯文本（自动去除导航、广告、脚本等噪声），适合让模型阅读文章内容。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的网页地址，http/https，可省略协议' },
      keepTitle: { type: 'boolean', description: '是否在正文开头补一行标题，默认 false' },
      maxChars: { type: 'number', description: '正文最多返回多少字，默认 20000，上限 100000' },
      timeoutMs: { type: 'number', description: '请求超时毫秒，默认 15000' },
      includeHtml: { type: 'boolean', description: '是否附带原始 HTML（默认 false，仅调试用）' }
    },
    required: ['url']
  },
  /**
   * @param {{ url: string, keepTitle?: boolean, maxChars?: number, timeoutMs?: number, includeHtml?: boolean }} args
   * @param {{ timeoutMs?: number }} [exec]
   * @returns {Promise<string>} JSON 字符串
   */
  async execute(args = {}, exec = {}) {
    const maxChars = Math.min(Math.max(Number(args.maxChars) || 20000, 200), 100000)

    const res = await fetchText(args.url, {
      timeoutMs: Number(args.timeoutMs) || Number(exec.timeoutMs) || 15000
    })

    const extracted = htmlToText(res.text, { keepTitleLine: Boolean(args.keepTitle) })
    const skeleton = looksLikeSkeleton(extracted)

    let text = extracted.text
    let truncated = false
    if (text.length > maxChars) {
      text = text.slice(0, maxChars)
      truncated = true
    }

    const out = {
      url: res.finalUrl,
      status: res.status,
      title: extracted.title,
      description: extracted.description,
      chars: extracted.chars,
      returnedChars: text.length,
      truncated,
      skeleton,
      root: extracted.root,
      encoding: res.encoding,
      bytes: res.bytes,
      text
    }

    if (skeleton) {
      out.hint = '正文过短，可能是 JS 渲染页面或被反爬拦截；可换用可服务端渲染的页面，或改用浏览器抓取能力'
    }
    if (args.includeHtml) out.html = res.text.slice(0, 5000)

    return JSON.stringify(out, null, 2)
  }
}
