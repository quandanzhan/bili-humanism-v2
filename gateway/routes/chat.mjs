import { redactText, redactData, safeUrl } from '../runtime.mjs'
/**
 * 聊天路由 - POST /api/chat
 * ============================================================================
 * Task D-E 收尾后按两项决策重写：
 *
 * 1. **降级直答（折中方案）**：一个通道都没配时，不再直接 503 把对话框卡死，
 *    而是返回 200 + 本地规则回复，并在响应体里用 `mode:"degraded"` / `degraded:true`
 *    明确标注「这不是 AI 的回复」。文案里同样明说离线状态并给出恢复步骤。
 *    · 只有 `NO_CHANNEL`（未配置）才降级；
 *    · `ALL_CHANNELS_FAILED` / `CHANNEL_FAILED`（配了但全挂）**不降级**，按 502 暴露真故障。
 *    · `RULE_FALLBACK=0` 可关闭降级，退回原来的 503 行为。
 *
 * 2. **流式帧带 `event:` 行**：只写 `data:` 时浏览器事件类型默认是 "message"，
 *    客户端 `addEventListener('content')` 一帧都收不到。
 *
 * 3. **工具调用（节点调用）**：把 engine 里注册的工具转成 OpenAI tools 定义传下去，
 *    模型返回 tool_calls 时由 engine.callTool 真正执行，多轮循环后给出最终回答；
 *    调用轨迹放在响应 `steps` 里，流式模式下发 `event: tool` / `tool_result` 帧。
 *    `CHAT_ENABLE_TOOLS=0` 可整体关闭；`CHAT_MAX_ROUNDS` 控轮数（默认 5）。
 *
 * 接口：
 *   POST /api/chat          Body: { messages:[{role,content}], stream?:boolean, model?:string }
 *   GET  /api/chat/models   列出可用模型通道（需要 modelRouter.getAvailableChannels）
 */

import { Router } from 'express'
import { requireAuth } from '../auth.mjs'
import { ruleReply, ruleFallbackEnabled } from '../rules.mjs'
import { isToolEnabled } from '../settings.mjs'

/**
 * 写一帧 SSE（event + data 缺一不可）
 * @param {import('express').Response} res
 * @param {'content'|'done'|'error'} type
 * @param {object} payload
 */
function sendEvent(res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(redactData(payload))}\n\n`)
}

/**
 * 校验消息数组
 * @param {unknown} messages
 * @returns {{ ok: boolean, message?: string, index?: number }}
 */
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, message: '消息格式错误：messages 必须是非空数组' }
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m || typeof m !== 'object' || !m.role || typeof m.content !== 'string') {
      return { ok: false, message: '消息格式错误：每条消息必须包含 role 和 content（字符串）', index: i }
    }
  }
  return { ok: true }
}

/**
 * 是否属于「尚未配置通道」这类可降级的错误
 * @param {any} err
 * @returns {boolean}
 */
function isNoChannel(err) {
  return Boolean(err) && err.code === 'NO_CHANNEL'
}

/**
 * 创建聊天路由
 * @param {object} modelRouter - { chat, getAvailableChannels? }
 * @param {object} [engine] - 工具引擎（可选，仅用于降级话术里列出工具名）
 * @returns {Router}
 */
export function createChatRouter(modelRouter, engine) {
  const router = Router()

  // 所有聊天端点需要认证
  router.use(requireAuth())

  /**
   * 把引擎里的工具转成 OpenAI tools 定义
   * @returns {Array|null} 无可工具/已关闭时返回 null（此时请求体不带 tools）
   */
  function buildToolDefs() {
    if (process.env.CHAT_ENABLE_TOOLS === '0') return null
    // 只把「控制台里打开着」的工具交给模型——关掉的工具模型根本看不到，
    // 也就不会出现「模型调了但服务端拒绝」这种别扭的体验
    const list = (engine?.tools || []).filter(t => isToolEnabled(t.name) && t.enabled !== false)
    if (!list.length) return null
    return list.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: String(t.description || '').slice(0, 1024),
        parameters: t.parameters || { type: 'object', properties: {} }
      }
    }))
  }

  /** 工具执行器：直接复用 engine.callTool（工具返回 JSON 字符串） */
  async function runTool(name, args) {
    if (!engine || typeof engine.callTool !== 'function') {
      const e = new Error('服务端未接入工具引擎')
      e.code = 'TOOL_RUNNER_MISSING'
      throw e
    }
    // 双保险：模型可能在工具被关掉的瞬间仍在调用（长对话），这里再挡一次
    if (!isToolEnabled(name)) {
      const e = new Error(`工具 ${name} 已被管理员关闭`)
      e.code = 'TOOL_DISABLED'
      throw e
    }
    return engine.callTool(name, args)
  }

  /** 组装模型调用参数（工具 + 轮数 + 补全上限都由环境变量控制） */
  function chatOpts(extra = {}) {
    const tools = buildToolDefs()
    return {
      ...(tools ? { tools, toolRunner: runTool } : {}),
      maxRounds: Number(process.env.CHAT_MAX_ROUNDS) || 5,
      maxTokens: Number(process.env.CHAT_MAX_TOKENS) || 1600,
      timeoutMs: Number(process.env.CHAT_TIMEOUT_MS) || 60000,
      ...extra
    }
  }

  /**
   * 构造降级响应体（明确标注非 AI 输出）
   * @param {Array} messages
   * @returns {object}
   */
  function buildDegraded(messages) {
    const tools = (engine?.tools || []).map(t => t.name)
    const r = ruleReply(messages, { tools, channelCount: 0 })
    return {
      content: r.content,
      model: 'rule-v1',
      channel: 'local-rule',
      mode: 'degraded',
      degraded: true,
      reason: 'NO_CHANNEL',
      rule: r.rule,
      hint: r.hint,
      usage: {},
      timestamp: Date.now()
    }
  }

  /**
   * POST /api/chat - 对话
   */
  router.post('/', async (req, res, next) => {
    try {
      const { messages, stream = false, model } = req.body || {}

      const v = validateMessages(messages)
      if (!v.ok) {
        return res.status(400).json({
          error: v.message,
          code: 'INVALID_REQUEST',
          data: v.index !== undefined ? { index: v.index } : {}
        })
      }

      const opts = {}
      if (model) opts.model = model
      if (stream) opts.stream = true

      // ---------- 流式 ----------
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        // nginx 默认缓冲响应，不加这个「流式」会变成「生成完一次性吐」
        res.setHeader('X-Accel-Buffering', 'no')
        res.flushHeaders()

        try {
          const response = await modelRouter.chat(messages, chatOpts({
            // 工具调用过程实时下发，前端可以显示「正在查视频…」这类进度
            onEvent: (ev) => {
              if (ev.type === 'tool') {
                sendEvent(res, 'tool', { type: 'tool', round: ev.round, tool: ev.tool, args: ev.args })
              } else if (ev.type === 'tool_result') {
                sendEvent(res, 'tool_result', { type: 'tool_result', round: ev.round, tool: ev.tool, ok: ev.ok, preview: ev.preview })
              }
            }
          }))
          const replyText = response.text ?? response.content ?? ''

          if (!response.stream) {
            // 非流式结果转成流式：先 content 再 done
            sendEvent(res, 'content', { type: 'content', content: replyText })
            sendEvent(res, 'done', {
              type: 'done',
              model: response.model,
              channel: response.channel,
              usage: response.usage,
              rounds: response.rounds,
              steps: response.steps || []
            })
            return res.end()
          }

          for await (const chunk of response.stream) {
            sendEvent(res, 'content', { type: 'content', content: chunk })
          }
          sendEvent(res, 'done', { type: 'done', model: response.model, channel: response.channel })
          return res.end()
        } catch (err) {
          // 降级：无通道 → 规则话术凑一整段，帧格式保持不变
          if (isNoChannel(err) && ruleFallbackEnabled()) {
            const d = buildDegraded(messages)
            sendEvent(res, 'content', { type: 'content', content: d.content })
            sendEvent(res, 'done', {
              type: 'done',
              model: d.model,
              channel: d.channel,
              mode: d.mode,
              degraded: true,
              reason: d.reason,
              rule: d.rule,
              hint: d.hint
            })
            return res.end()
          }

          sendEvent(res, 'error', {
            type: 'error',
            error: err.message || '对话失败',
            code: err.code || 'CHAT_ERROR'
          })
          return res.end()
        }
      }

      // ---------- 非流式 ----------
      try {
        const response = await modelRouter.chat(messages, chatOpts(opts))
        return res.json({
          content: response.text ?? response.content ?? '',
          model: response.model,
          channel: response.channel,
          usage: response.usage || {},
          // 工具调用轨迹（为空数组表示这轮模型直接回答，没调工具）
          steps: redactData(response.steps || []),
          rounds: response.rounds || 1,
          timestamp: Date.now()
        })
      } catch (err) {
        if (isNoChannel(err) && ruleFallbackEnabled()) {
          // 200 + 明确标注的降级内容：对话框不卡死，但用户知道这不是 AI
          return res.json(buildDegraded(messages))
        }
        throw err
      }
    } catch (err) {
      next(err)
    }
  })

  /**
   * GET /api/chat/models - 可用模型通道列表
   */
  router.get('/models', async (req, res, next) => {
    try {
      if (typeof modelRouter?.getAvailableChannels !== 'function') {
        return res.status(501).json({
          error: '当前 modelRouter 未提供 getAvailableChannels，无法列出模型通道',
          code: 'CAPABILITY_UNAVAILABLE',
          hint: '请确认 main.mjs 传入的 modelRouter 包含 getAvailableChannels'
        })
      }

      const channels = await modelRouter.getAvailableChannels()
      return res.json({
        channels: (channels || []).map(ch => ({
          id: ch.id,
          name: ch.name,
          model: ch.model,
          priority: ch.priority,
          enabled: ch.enabled
        })),
        count: (channels || []).length
      })
    } catch (err) {
      next(err)
    }
  })

  return router
}
