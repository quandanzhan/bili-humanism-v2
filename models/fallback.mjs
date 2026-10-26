/**
 * AI 模型降级策略（通道过滤 + 单通道调用 + 错误分类）
 * ============================================================================
 * @module models/fallback
 * @description 供 ./router.mjs 使用的底层策略：
 *              - getAvailableChannels()：过滤出可参与调用的通道（启用 + 有 key，按优先级排序）
 *              - callChannel()：调用单个通道，失败时抛出带 code / status 的标准错误
 *              - fetchWithTimeout()：带超时的 fetch，超时统一归类为 CHANNEL_TIMEOUT
 * 错误码约定见 ai-tasks/shared/error-codes.md（3xxx 模型路由错误）。
 * @exports {Function} getAvailableChannels - 获取可用通道列表
 * @exports {Function} callChannel - 调用单个通道
 * @exports {Function} fetchWithTimeout - 带超时的 fetch 封装
 */
import { list } from "./channels.mjs";
import { redactText, safeUrl, registerSecrets, urlSecrets, completionUrl } from '../gateway/runtime.mjs';

/**
 * 获取可用通道列表（按优先级排序，过滤未启用和无 key 的）
 * @returns {Promise<Array>} 可参与调用的通道列表（priority 小的在前）
 */
export async function getAvailableChannels() {
  return list().filter((ch) => ch.enabled !== false && ch.apiKey);
}

/**
 * 带超时的 fetch。AbortSignal.timeout 触发的 AbortError 统一转换为
 * code = CHANNEL_TIMEOUT 的标准错误，方便上层区分「超时」和「业务失败」。
 * @param {string} url - 请求地址
 * @param {RequestInit} init - fetch 参数（不含 signal，由本函数注入）
 * @param {number} timeoutMs - 超时毫秒数
 * @returns {Promise<Response>} fetch 响应
 * @throws {Error} code CHANNEL_TIMEOUT / UNKNOWN_ERROR
 */
export async function fetchWithTimeout(url, init = {}, timeoutMs = 60000) {
  registerSecrets(urlSecrets(url))
  let r
  try {
    r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    // AbortSignal.timeout 到期时抛出 AbortError（name=AbortError / TimeoutError 依运行时版本而异）
    if (e?.name === "AbortError" || e?.name === "TimeoutError" || /timeout|aborted/i.test(redactText(e?.message || e))) {
      const err = new Error(`请求超时（${timeoutMs}ms）：${safeUrl(url)}`)
      err.code = "CHANNEL_TIMEOUT"
      err.data = { url: safeUrl(url), timeoutMs }
      throw err
    }
    const err = new Error(`请求失败：${String(e?.message || e)}`)
    err.code = "UNKNOWN_ERROR"
    err.data = { url: safeUrl(url) }
    throw err
  }
  const text = await r.text().catch(() => "")
  return { r, text }
}

/**
 * 调用单个通道（OpenAI 兼容 /chat/completions）
 * @param {Object} ch - 通道配置 { name, baseURL, apiKey, model }
 * @param {Array} messages - 消息数组 [{ role, content, tool_calls?, tool_call_id? }]
 * @param {Object} [opts] - { maxTokens=800, temperature=0.7, timeoutMs=60000, tools?, toolChoice? }
 * @param {Array} [opts.tools] - OpenAI 格式工具定义；传了才会带 tools 字段
 * @param {string} [opts.toolChoice] - 'auto' | 'none' | {type:'function',function:{name}}
 * @returns {Promise<{ text: string, toolCalls: Array, assistantMessage: Object|null,
 *                     finishReason: string|null, usage: Object|null, channel: string, model: string }>}
 * @throws {Error} code CHANNEL_TIMEOUT / CHANNEL_RATE_LIMITED / CHANNEL_FAILED / UNKNOWN_ERROR；
 *                 非超时类 HTTP 错误附带 err.status 供上层降级判断
 */
export async function callChannel(ch, messages, opts = {}) {
  const { maxTokens = 800, temperature = 0.7, timeoutMs = 60000, tools, toolChoice } = opts

  registerSecrets([ch.apiKey, ...urlSecrets(ch.baseURL)])
  const url = completionUrl(ch.baseURL)
  const body = {
    model: ch.model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
  }
  // 只在真的传了工具时才带 tools——不带 tools 的老路径请求体与之前完全一致，
  // 不会因为这次改动影响非工具场景的兼容性
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools
    body.tool_choice = toolChoice || "auto"
    // 并行工具调用会让「先看结果再决定下一步」变得不可控，这里保守关闭，
    // 一轮只允许一个工具调用，前端也能按顺序展示调用轨迹
    body.parallel_tool_calls = false
  }

  const { r, text } = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + ch.apiKey,
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
  )

  if (!r.ok) {
    let msg = text.slice(0, 300)
    try {
      const j = JSON.parse(text)
      msg = j?.error?.message || j?.message || j?.msg || msg
    } catch {
      /* 保留原文 */
    }
    const err = new Error(`通道 ${ch.name} 返回 ${r.status}：${redactText(msg, [ch.apiKey])}`)
    err.code = r.status === 429 ? "CHANNEL_RATE_LIMITED" : "CHANNEL_FAILED"
    err.status = r.status
    err.data = { channel: ch.name, status: r.status }
    throw err
  }

  let j
  try {
    j = JSON.parse(text)
  } catch {
    const err = new Error(`通道 ${ch.name} 返回的不是合法 JSON`)
    err.code = "CHANNEL_FAILED"
    err.status = r.status
    err.data = { channel: ch.name, sample: redactText(text, [ch.apiKey]).slice(0, 120) }
    throw err
  }

  const choice = j?.choices?.[0] || {}
  const msg = choice.message || {}
  return {
    text: typeof msg.content === 'string' ? redactText(msg.content, [ch.apiKey]) : msg.content || "",
    // 有些兼容端点把 tool_calls 放在 choice 上而不是 message 上，两者都认
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : Array.isArray(choice.tool_calls) ? choice.tool_calls : [],
    assistantMessage: msg && Object.keys(msg).length ? msg : null,
    finishReason: choice.finish_reason || null,
    usage: j?.usage || null,
    channel: ch.name,
    model: ch.model,
  }
}
