/**
 * 跨 AI 协作接口定义
 * ============================================================================
 * 用途：让所有 AI 了解彼此提供的接口，便于协作
 * 说明：这是 TypeScript 类型定义文件，实际实现在各模块的 .mjs 文件中
 */

// ============================================================================
// 任务 A 提供的接口：密钥管理
// ============================================================================

/**
 * 密钥集合
 */
export interface Secrets {
  bili: {
    SESSDATA: string
    bili_jct: string
    buvid3: string
    DedeUserID: string
  }
  models: {
    AMD_API_KEY?: string
    DEEPSEEK_API_KEY?: string
    MODELSCOPE_API_KEY?: string
  }
  session: {
    SECRET: string
    TTL_MS: number
  }
  auth: {
    USER: string
    SALT: string
    HASH: string
  }
  plugins: {
    xhs?: {
      cookie?: string
      enabled: boolean
    }
  }
}

/**
 * 加载所有密钥
 * @module secrets/loader
 */
export function loadSecrets(): Promise<Secrets>

// ============================================================================
// 任务 B 提供的接口：AI 模型路由
// ============================================================================

/**
 * 模型通道
 */
export interface ModelChannel {
  id: string
  name: string
  baseURL: string
  apiKey: string
  model: string
  priority: number
  enabled: boolean
}

/**
 * 对话选项
 */
export interface ChatOptions {
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
}

/**
 * 对话响应
 */
export interface ChatResponse {
  text: string
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  } | null
  channel: string
}

/**
 * 与 AI 模型对话
 * @module models/router
 */
export function chat(
  messages: Array<{ role: string; content: string }>,
  opts?: ChatOptions
): Promise<ChatResponse>

/**
 * 选择可用的模型通道
 */
export function pickChannel(): Promise<{ channel: ModelChannel; probe: any } | null>

/**
 * 测试模型通道
 */
export function testChannel(ch: ModelChannel): Promise<{
  ok: boolean
  status?: number
  ms: number
  sample?: string
  error?: string
}>

// ============================================================================
// 任务 C 提供的接口：工具引擎
// ============================================================================

/**
 * 工具定义
 */
export interface Tool {
  name: string
  description: string
  parameters: Record<string, any>
  execute: (args: any, exec?: any) => Promise<string>
}

/**
 * 工具引擎
 * @module core/engine
 */
export class Engine {
  constructor(configFile: string)
  
  /**
   * 启动引擎
   */
  start(): Promise<{ tools: Tool[] }>
  
  /**
   * 获取工具列表
   */
  get tools(): Tool[]
  
  /**
   * 调用工具
   */
  callTool(name: string, args: any): Promise<any>
  
  /**
   * 更新配置（自动热加载）
   */
  updateConfig(patch: any): Promise<any>
}

// ============================================================================
// 任务 D 提供的接口：HTTP 网关
// ============================================================================

/**
 * 会话对象
 */
export interface Session {
  u: string
  exp: number
  n: string
}

/**
 * 创建 HTTP 网关
 * @module gateway/gateway
 */
export function createGateway(
  engine: Engine,
  opts?: {
    secrets?: Secrets
    port?: number
    host?: string
  }
): import('http').Server

/**
 * 认证中间件
 * @module gateway/auth
 */
export function sessionOf(req: import('http').IncomingMessage): Session | null
export function issueToken(): string
export function verifyToken(token: string): Session | null

// ============================================================================
// 任务 F 提供的接口：外部集成
// ============================================================================

/**
 * 小红书搜索结果
 */
export interface XhsNote {
  id: string
  url: string
  title: string
  author: string
  like: string
  type: string
  cover: string
}

/**
 * 小红书采集动作
 * @module integrations/xhs
 */
export const xhsActions: {
  search(args: { keyword: string; limit?: number; cookie?: string }): Promise<{
    ok: boolean
    count: number
    notes: XhsNote[]
  }>
  note(args: { url: string; cookie?: string }): Promise<any>
  selfTest(): any
}

/**
 * 浏览器动作
 * @module integrations/browser-pool
 */
export const browserActions: {
  text(args: { url: string; waitMs?: number; maxChars?: number }): Promise<any>
  screenshot(args: { url: string; fullPage?: boolean }): Promise<any>
  html(args: { url: string; maxChars?: number }): Promise<any>
  links(args: { url: string; max?: number }): Promise<any>
  eval(args: { url: string; script: string }): Promise<any>
  status(): Promise<any>
}

/**
 * 插件注册表
 * @module integrations/registry
 */
export const PLUGINS: Array<{
  id: string
  name: string
  icon: string
  group: string
  kind: string
  desc: string
}>

export function pluginById(id: string): any
export function localizeTool(tool: Tool): any

// ============================================================================
// 错误定义
// ============================================================================

/**
 * 标准错误对象
 */
export interface StandardError extends Error {
  code: string
  data?: any
}

/**
 * 创建标准错误
 */
export function createError(message: string, code: string, data?: any): StandardError
