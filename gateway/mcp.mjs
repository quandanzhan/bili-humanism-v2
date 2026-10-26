/**
 * MCP 客户端（stdio 传输，零依赖）
 * ============================================================================
 * ⚠️ 架构约束（本内核是重构精简版，必须遵守）：
 *
 *   1. **不引入 npm 依赖** —— MCP 协议只是一套 JSON-RPC 2.0 over stdio，
 *      用 node:child_process + 按行切包就够，没必要为它拖一个 SDK。
 *   2. **不把 MCP 工具展开进工具列表** —— 接 5 个 server 可能会冒出几十个工具，
 *      工具列表一爆炸，模型的工具选择质量断崖式下跌，也违背「精选内核」。
 *      所以只暴露 2 个代理工具（mcp_list / mcp_call），模型先看再调。
 *   3. **懒连接** —— 进程启动时一个 MCP server 都不连，第一次真正用到才 spawn。
 *      server 挂了不影响内核启动。
 *   4. **权限跟内部工具一视同仁** —— mcp_call 默认不进任何 toolScopes 白名单，
 *      要用得用户自己加。MCP 工具是任意能力（能跑命令/读文件），不能默认放行。
 *
 * 配置：data/mcp-servers.json
 * {
 *   "servers": [
 *     { "id": "bili", "name": "B站 MCP", "enabled": true,
 *       "command": "python", "args": ["-m","bilibili_mcp"],
 *       "env": {}, "cwd": null, "timeoutMs": 60000 }
 *   ]
 * }
 *
 * @module gateway/mcp
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DATA_DIR, redactText, redactData, registerSecrets, urlSecrets } from './runtime.mjs'
const FILE = process.env.BILI_HUMANISM_MCP || join(DATA_DIR, 'mcp-servers.json')

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT = 60_000

/** 已连接的客户端：serverId → McpClient */
const clients = new Map()

export function loadMcpConfig() {
  try {
    if (existsSync(FILE)) {
      const d = JSON.parse(readFileSync(FILE, 'utf8'))
      if (Array.isArray(d?.servers)) return d
    }
  } catch {
    /* 坏文件不阻断内核启动 */
  }
  return { servers: [] }
}

export function saveMcpConfig(patch = {}) {
  const cur = loadMcpConfig()
  const next = { ...cur }
  if (Array.isArray(patch.servers)) {
    next.servers = patch.servers.map((s, i) => ({
      id: String(s.id || `mcp${i}`).slice(0, 32),
      name: String(s.name || s.id || `MCP ${i}`).slice(0, 60),
      transport: 'stdio',
      command: restoreMcpText(s.command, (cur.servers || []).find((old) => old.id === s.id)?.command).slice(0, 200),
      args: restoreMcpArgs(s.args, (cur.servers || []).find((old) => old.id === s.id)?.args),
      env: restoreMcpEnv(s.env, (cur.servers || []).find((old) => old.id === s.id)?.env),
      cwd: s.cwd ? restoreMcpText(s.cwd, (cur.servers || []).find((old) => old.id === s.id)?.cwd).slice(0, 300) : null,
      timeoutMs: Math.max(5000, Math.min(300000, Number(s.timeoutMs) || DEFAULT_TIMEOUT)),
      enabled: s.enabled !== false
    }))
  }
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    writeFileSync(FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* 落盘失败不影响内存里的正在跑的连接 */
  }
  // 配置变了就断开所有旧连接，下次用到重新按新配置连
  closeAll()
  return next
}

function restoreMcpText(value, previous) {
  const text = String(value || '')
  return previous && text === redactText(previous) ? previous : text
}

function restoreMcpEnv(env, previous = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return previous
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key,
    value === '***' && key in previous ? previous[key] : String(value)
  ]))
}

function maskedArgs(args = []) {
  let hideNext = false
  return args.map((arg) => {
    const text = String(arg)
    const hidden = hideNext
    hideNext = /^--?(?:api[-_]?key|token|password|secret|authorization|auth|cookie)$/i.test(text)
    registerSecrets(urlSecrets(text))
    if (hidden) registerSecrets([text])
    const inline = /^--?(?:api[-_]?key|token|password|secret|authorization|auth|cookie)=(.*)$/i.exec(text)
    if (inline) registerSecrets([inline[1]])
    return hidden ? '***' : redactText(text)
  })
}

function restoreMcpArgs(args, previous = []) {
  if (!Array.isArray(args)) return previous
  const masked = maskedArgs(previous)
  return args.slice(0, 20).map((arg, i) => {
    const text = String(arg).slice(0, 200)
    return text === masked[i] && previous[i] !== undefined ? previous[i] : text
  })
}

export function maskedMcpConfig(cfg = loadMcpConfig()) {
  registerSecrets((cfg.servers || []).flatMap((s) => Object.values(s.env || {})))
  for (const server of cfg.servers || []) maskedArgs(server.args)
  return {
    ...redactData(cfg),
    servers: (cfg.servers || []).map((s) => ({
      ...redactData(s),
      command: redactText(s.command),
      args: maskedArgs(s.args),
      env: Object.fromEntries(Object.keys(s.env || {}).map((key) => [key, '***']))
    }))
  }
}

/** 一个 MCP server 的 stdio 客户端（极简 JSON-RPC 2.0） */
class McpClient {
  constructor(cfg) {
    this.cfg = cfg
    this.proc = null
    this.buf = ''
    this.seq = 0
    this.pending = new Map()
    this.tools = []
    this.serverInfo = null
    this.ready = false
  }

  _onLine(line) {
    const s = line.trim()
    if (!s) return
    let msg
    try {
      msg = JSON.parse(s)
    } catch {
      return // 有些 server 会往 stdout 打日志，忽略非 JSON 行
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      clearTimeout(timer)
      if (msg.error) reject(new Error(redactText(`${msg.error.message || 'MCP 错误'}（code=${msg.error.code}）`)))
      else resolve(msg.result)
    }
    // 其它（notification / request）本内核不处理，静默忽略，保持精简
  }

  _send(obj) {
    if (!this.proc?.stdin?.writable) throw new Error(`MCP[${this.cfg.id}] 未连接`)
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  request(method, params, timeoutMs) {
    const id = ++this.seq
    const t = timeoutMs || this.cfg.timeoutMs || DEFAULT_TIMEOUT
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP[${this.cfg.id}] ${method} 超时（${t}ms）`))
      }, t)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this._send({ jsonrpc: '2.0', id, method, params: params || {} })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  notify(method, params) {
    try {
      this._send({ jsonrpc: '2.0', method, params: params || {} })
    } catch {
      /* 通知失败不影响主流程 */
    }
  }

  async connect() {
    if (this.ready) return this
    const c = this.cfg
    registerSecrets(Object.values(c.env || {}))
    maskedMcpConfig({ servers: [c] })
    if (!c.command) throw new Error(`MCP[${c.id}] 没配 command`)

    this.proc = spawn(c.command, c.args || [], {
      cwd: c.cwd || undefined,
      env: { ...process.env, ...(c.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (d) => {
      this.buf += d
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        this._onLine(line)
      }
    })
    this.proc.stderr.on('data', () => {
      /* MCP server 的日志丢掉，不污染内核 stdout */
    })
    this.proc.on('error', (error) => {
      this.ready = false
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error(redactText(error.message)))
      }
      this.pending.clear()
    })
    this.proc.on('exit', () => {
      this.ready = false
      this.proc = null
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`MCP[${this.cfg.id}] 进程已退出`))
      }
      this.pending.clear()
    })

    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'bili-humanism-v2', version: '1.0.0' }
    })
    this.serverInfo = init?.serverInfo || null
    this.notify('notifications/initialized')
    const list = await this.request('tools/list', {})
    this.tools = Array.isArray(list?.tools) ? list.tools : []
    this.ready = true
    return this
  }

  async callTool(name, args) {
    await this.connect()
    const r = await this.request('tools/call', { name, arguments: args || {} })
    return r
  }

  close() {
    const p = this.proc
    if (p) {
      try {
        p.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      // MCP server 多半阻塞在 stdin 读上，SIGTERM 有时不生效（实测 python 写的
      // echo server 就赖着不退）。200ms 后还不走就 SIGKILL —— 精简内核不能留僵尸进程。
      const t = setTimeout(() => {
        try {
          p.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, 200)
      if (t.unref) t.unref()
    }
    this.proc = null
    this.ready = false
  }
}

/** 拿到（必要时建立）某 server 的连接 */
async function clientFor(serverId) {
  const cfg = loadMcpConfig()
  const s = (cfg.servers || []).find((x) => x.id === serverId && x.enabled !== false)
  if (!s) {
    const e = new Error(`MCP server 不存在或未启用：${serverId}`)
    e.code = 'MCP_NOT_FOUND'
    throw e
  }
  if (!clients.has(serverId)) clients.set(serverId, new McpClient(s))
  const c = clients.get(serverId)
  await c.connect()
  return c
}

/**
 * 列出所有 MCP server 及其工具（**不连接未启用的**，连接失败的单独标注）
 * @param {{connect?:boolean}} [opts] connect=true 时逐个握手拿工具列表
 */
export async function listMcp({ connect = false } = {}) {
  const cfg = loadMcpConfig()
  const out = []
  for (const s of cfg.servers || []) {
    const item = { id: s.id, name: s.name, enabled: s.enabled !== false, command: redactText(s.command), args: maskedArgs(s.args), tools: [], error: null }
    if (s.enabled !== false && connect) {
      try {
        const c = await clientFor(s.id)
        item.tools = c.tools.map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 200) }))
        item.serverInfo = redactData(c.serverInfo)
      } catch (e) {
        item.error = redactText(e?.message || e).slice(0, 200)
      }
    }
    out.push(item)
  }
  return out
}

/** 调某个 MCP server 的工具 */
export async function callMcp(serverId, toolName, args) {
  const c = await clientFor(serverId)
  const exists = c.tools.some((t) => t.name === toolName)
  if (!exists) {
    const e = new Error(`MCP[${serverId}] 没有工具 ${toolName}（可用：${c.tools.map((t) => t.name).join(', ') || '无'}）`)
    e.code = 'MCP_TOOL_NOT_FOUND'
    throw e
  }
  return redactData(await c.callTool(toolName, args))
}

export function closeAll() {
  for (const [, c] of clients) c.close()
  clients.clear()
}

export function mcpStatus() {
  return {
    file: FILE,
    servers: (loadMcpConfig().servers || []).map((s) => {
      const c = clients.get(s.id)
      return {
        id: s.id,
        name: s.name,
        enabled: s.enabled !== false,
        connected: Boolean(c?.ready),
        toolCount: c?.tools?.length || 0,
        serverInfo: redactData(c?.serverInfo || null)
      }
    })
  }
}
