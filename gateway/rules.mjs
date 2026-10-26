/**
 * 本地规则直答（降级模式）
 * ============================================================================
 * 用途：当「一个模型通道都没配置」时，不让对话框卡死，但也不能假装是 AI 在回答。
 *
 * 设计原则（折中方案的核心）：
 *   1. **诚实** —— 文案里明说「离线模式 / 尚未接入模型」，不冒充模型输出；
 *   2. **有用** —— 每条回复都给「下一步该做什么」，而不是一句「服务不可用」；
 *   3. **可关** —— 环境变量 RULE_FALLBACK=0 时退回 503 NO_CHANNEL，便于对照排查；
 *   4. **只兜「未配置」** —— 通道存在但全部失败（ALL_CHANNELS_FAILED）**不**走本模块，
 *      那是真故障，必须按 502 暴露出来。
 *
 * 返回对象的 mode/degraded/rule 字段会一路带到 HTTP 响应，前端据此显示「离线」徽标。
 */

/** 回复统一前缀，让用户一眼看出不是模型在答 */
const TAG = '（离线模式）'

/**
 * 规范化用户最后一条消息
 * @param {Array<{role:string,content:string}>} messages
 * @returns {string}
 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user' && typeof m.content === 'string') return m.content.trim()
  }
  return ''
}

/**
 * 规则表：按顺序匹配，命中即返回
 * @type {Array<{ id: string, test: RegExp, build: (ctx: object) => string }>}
 */
const RULES = [
  {
    id: 'greeting',
    test: /^(你好|您好|hi|hello|hey|在吗|嗨|哈喽)[\s!！。.~]*$/i,
    build: () => `${TAG}你好，我在。\n\n不过现在还没有接入任何 AI 模型通道，只能先用固定规则应答。\n配置一个通道后就能正常对话：打开控制台 → 「模型通道」→ 添加（填 Base URL、模型 ID、API Key）→ 保存即生效。`
  },
  {
    id: 'identity',
    test: /(你是谁|什么模型|哪个模型|用的什么|gpt|claude|deepseek)/i,
    build: () => `${TAG}这条回复不是模型生成的，是服务端的本地规则。\n\n当前可用通道数为 0，所以对话走的是降级兜底。\n想让真正的模型来答，去控制台「模型通道」加一个就能切换。`
  },
  {
    id: 'config',
    test: /(模型|通道|配置|接入|api[\s-]?key|密钥|设置|怎么加|添加|switch|切换)/i,
    build: () => `${TAG}接入模型只要三步：\n\n1. 打开控制台首页（就是当前服务的根路径）；\n2. 在「模型通道」里填四条：名称、Base URL（如 https://api.deepseek.com/v1）、模型 ID、API Key；\n3. 保存后可以点「测试」验证连通，通了你就能正常对话了。\n\n优先级数字越小越先用，多个通道会自动按顺序降级。`
  },
  {
    id: 'tools',
    test: /(工具|插件|能干什么|有什么能力|tool)/i,
    build: (ctx) => {
      const names = Array.isArray(ctx.tools) ? ctx.tools : []
      const list = names.length
        ? `当前已加载 ${names.length} 个工具：${names.slice(0, 12).join('、')}${names.length > 12 ? ' 等' : ''}。`
        : '当前还没有加载任何工具（工具目录为空，属正常状态，工具迁移还没做）。'
      return `${TAG}${list}\n\n工具需要通过接口调用：GET /api/tools 看清单，POST /api/tools/<名称> 传 { args } 执行。\n对话本身要等模型通道配好才能用。`
    }
  },
  {
    id: 'help',
    test: /(帮助|help|怎么用|使用说明|能做什么|功能|说明书)/i,
    build: () => `${TAG}现在能做的事：\n\n· 对话 —— 需要先配模型通道（目前没有，所以是我在按规则回你）；\n· 工具调用 —— 走 /api/tools；\n· 健康检查 —— /api/health；\n· 控制台 —— 服务根路径，可以管理通道、看状态、测对话。\n\n先去控制台把通道配上，其他都好说。`
  },
  {
    id: 'thanks',
    test: /(谢谢|感谢|thanks|thx|辛苦)/i,
    build: () => `${TAG}不客气。\n\n顺带提醒：配置模型通道之后体验会差别很大，现在这套规则只是在兜底。`
  },
  {
    id: 'fallback',
    test: /[\s\S]*/,
    build: (ctx) => {
      const n = Number(ctx.channelCount || 0)
      return `${TAG}这条不是 AI 回复 —— 当前有 ${n} 个可用模型通道，所以只能用固定规则应答。\n\n你问的「${ctx.echo || '这个问题'}」等接上模型后才能真正回答。\n下一步：打开控制台 →「模型通道」→ 添加一个通道，保存后立即可以正常对话。`
    }
  }
]

/**
 * 生成降级回复
 * @param {Array<{role:string,content:string}>} messages - 完整消息数组
 * @param {{ tools?: string[], channelCount?: number }} [ctx] - 上下文（工具名、通道数）
 * @returns {{ content: string, rule: string, mode: 'degraded', degraded: true, hint: string }}
 */
export function ruleReply(messages, ctx = {}) {
  const text = lastUserText(messages)
  const echo = text.length > 24 ? text.slice(0, 24) + '…' : text
  const scope = { tools: ctx.tools || [], channelCount: ctx.channelCount ?? 0, echo }

  const hit = RULES.find(r => r.test.test(text)) || RULES[RULES.length - 1]

  return {
    content: hit.build(scope),
    rule: hit.id,
    mode: 'degraded',
    degraded: true,
    hint: '配置模型通道后即可获得真实 AI 回复：控制台 →「模型通道」→ 添加'
  }
}

/**
 * 降级模式是否开启（默认开）
 * @returns {boolean}
 */
export function ruleFallbackEnabled() {
  return String(process.env.RULE_FALLBACK ?? '1') !== '0'
}
