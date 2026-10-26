/**
 * Task G-H 集成测试：端到端，走真实 HTTP
 * ============================================================================
 * 这是本任务的核心价值：此前 31 个单测一个 HTTP 请求都没发过，
 * createGateway / createToolsRouter / createChatRouter 从未被 import。
 * 本文件真正建立 HTTP 连接（Node 22 内置 fetch + 随机端口 app.listen(0)）。
 *
 * 运行（cwd 必须是 standalone-v2/，fixture 工具路径相对 cwd）：
 *   node tests/integration.mjs
 *
 * 退出码：全绿 0，任何失败 1（deploy.sh 依赖退出码中止部署）。
 *
 * 凭据说明（HANDOFF 3.7 铁律 5）：
 *   不用 loader 默认凭据做鉴权断言。文件开头用 scryptSync 现生成一套
 *   测试专用凭据写进 process.env——loadSecrets() 每个请求都重读环境变量
 *   （无缓存），所以此刻设置对所有后续请求生效，且不污染真实凭据。
 *   注意：ESM import 会提升，但读 env 的时机是「请求到达时」而非「模块加载时」，
 *   因此这里的赋值一定先于第一个 HTTP 请求执行。
 */

import { scryptSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------- 测试专用凭据（先于任何 HTTP 请求生效） ----------
const IT_USER = 'it_user'
const IT_PASS = 'integration-test-pass'
const IT_SALT = '0123456789abcdef0123456789abcdef'
process.env.AUTH_USER = IT_USER
process.env.AUTH_SALT = IT_SALT
process.env.AUTH_HASH = scryptSync(IT_PASS, IT_SALT, 64).toString('hex')
process.env.SESSION_SECRET = 'synthetic-integration-session-secret'
const AUTH_HEADER = 'Basic ' + Buffer.from(`${IT_USER}:${IT_PASS}`).toString('base64')

import { suite, assert, assertEqual } from '../shared/test-utils.mjs'
import { Engine } from '../integrations/engine.mjs'
import { chat } from '../models/router.mjs'
import { getAvailableChannels } from '../models/fallback.mjs'
import { createGateway } from '../gateway/gateway.mjs'
import { watchConfig, stopWatch } from '../config/loader.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 全局状态（用例 1 建好，后续用例复用同一个服务实例） ----------
let baseUrl = null
let serverRef = null
let engineRef = null
let chatOutcome = '(未执行)'   // 记录 P1 用例实际走向，供 COMPLETED.md 引用
let sseOutcome = '(未执行)'

const tests = {
  '1. 启动全链路：Engine(fixture 工具) → Gateway → start(0) 随机端口': async () => {
    const engine = new Engine()
    engineRef = engine
    const { tools } = await engine.start('./tests/fixtures/tools')
    assertEqual(tools.length, 2, `fixture 有效工具应为 2 个（echo+boom），实际 ${tools.length}`)

    // ⚠️ modelRouter 必须同时带 chat 和 getAvailableChannels（HANDOFF 3.2）
    const modelRouter = { chat, getAvailableChannels }
    const { start } = await createGateway(engine, modelRouter)
    const { server } = await start(0)               // 随机端口，避免与用户本地服务撞车
    serverRef = server
    const port = server.address().port
    assert(Number.isInteger(port) && port > 0, `应拿到随机端口，实际 ${port}`)
    baseUrl = `http://127.0.0.1:${port}`

    // 服务真的可访问
    const res = await fetch(`${baseUrl}/api/health`)
    assertEqual(res.status, 200, `启动后 /api/health 应立即可访问，实际 ${res.status}`)
  },

  '2. GET /api/health 免认证：200 + status=ok + 数字字段': async () => {
    const res = await fetch(`${baseUrl}/api/health`)
    assertEqual(res.status, 200)
    const body = await res.json()
    assertEqual(body.status, 'ok')
    assert(typeof body.tools.total === 'number', 'tools.total 应为数字')
    assert(typeof body.models.available === 'number', 'models.available 应为数字（不要求 >0）')
    assertEqual(body.tools.total, 2, `健康端点工具总数应为 2，实际 ${body.tools.total}`)
  },

  '3. GET /api/tools 带认证：200 + 数组 + 2 个 fixture': async () => {
    const res = await fetch(`${baseUrl}/api/tools`, {
      headers: { authorization: AUTH_HEADER }
    })
    assertEqual(res.status, 200, `带认证应 200，实际 ${res.status}`)
    const body = await res.json()
    assert(Array.isArray(body.tools), 'tools 应为数组')
    assertEqual(body.tools.length, 2, `应加载 2 个 fixture 工具，实际 ${body.tools.length}`)
    assertEqual(body.count, 2)
    const names = body.tools.map(t => t.name).sort()
    assertEqual(names.join(','), 'boom,echo', `工具名集合应为 boom+echo，实际 ${names}`)
  },

  '4. POST /api/tools/echo：200 + result 回显入参': async () => {
    const res = await fetch(`${baseUrl}/api/tools/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: AUTH_HEADER },
      body: JSON.stringify({ args: { input: 'hello-integration' } })
    })
    assertEqual(res.status, 200, `echo 调用应 200，实际 ${res.status}`)
    const body = await res.json()
    assertEqual(body.tool, 'echo')
    // echo.execute 返回 JSON.stringify({success:true, data:args})，网关原样透传
    const parsed = JSON.parse(body.result)
    assertEqual(parsed.success, true)
    assertEqual(parsed.data.input, 'hello-integration', 'result 应回显入参')
  },

  '5. POST /api/tools/boom：400 + TOOL_EXECUTION_ERROR（白名单分支）': async () => {
    const res = await fetch(`${baseUrl}/api/tools/boom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: AUTH_HEADER },
      body: JSON.stringify({ args: {} })
    })
    // HANDOFF 3.5：白名单错误码（TOOL_EXECUTION_ERROR 属于 7 码之一）→ 400
    assertEqual(res.status, 400, `boom 应触发白名单 400，实际 ${res.status}`)
    const body = await res.json()
    assertEqual(body.code, 'TOOL_EXECUTION_ERROR', `错误码应为 TOOL_EXECUTION_ERROR，实际 ${body.code}`)
  },

  '6. GET /api/tools 不带认证：401': async () => {
    const res = await fetch(`${baseUrl}/api/tools`)
    assertEqual(res.status, 401, `无认证应 401，实际 ${res.status}`)
    const body = await res.json()
    assertEqual(body.code, 'AUTH_REQUIRED')
  },

  '7. POST /api/chat 空 messages：400 + INVALID_REQUEST（不依赖模型）': async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: AUTH_HEADER },
      body: JSON.stringify({ messages: [] })
    })
    assertEqual(res.status, 400, `空 messages 应 400，实际 ${res.status}`)
    const body = await res.json()
    assertEqual(body.code, 'INVALID_REQUEST')
  },

  '8. [P1] POST /api/chat 非流式：200+content 非空，或无通道 503/502': async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: AUTH_HEADER },
      body: JSON.stringify({ messages: [{ role: 'user', content: '请只回复两个字：收到' }] }),
      signal: AbortSignal.timeout(60000)             // 真实模型调用可能较慢
    })
    const body = await res.json()

    if (res.status === 200) {
      // 能抓出「router 返回 text、路由读 content」那类静默失效
      assert(typeof body.content === 'string' && body.content.length > 0,
        `content 应为非空字符串，实际 ${JSON.stringify(body.content)}`)
      chatOutcome = `200（model=${body.model}, channel=${body.channel}）`
    } else {
      // 无通道：chat() 抛 NO_CHANNEL → error.mjs 映射 503；
      // 有通道但全部失败：ALL_CHANNELS_FAILED → 502。
      // （HANDOFF 5.2 写的是「500 + NO_CHANNEL」，与 error.mjs 的映射表不符，以源码为准。）
      assert([502, 503].includes(res.status),
        `无可用通道时应为 503(NO_CHANNEL)/502(ALL_CHANNELS_FAILED)，实际 ${res.status}`)
      assert(['NO_CHANNEL', 'ALL_CHANNELS_FAILED'].includes(body.code),
        `错误码应为 NO_CHANNEL 或 ALL_CHANNELS_FAILED，实际 ${body.code}`)
      chatOutcome = `${res.status}（${body.code}，本机无可用模型通道/通道全失败——合法分支）`
    }
  },

  '9. [P1] POST /api/chat stream:true → SSE 帧（event: 行必须存在）': async () => {
    // SSE 是 POST + Basic Auth，标准 EventSource 用不了，按 HANDOFF 3.6 用 fetch 读流。
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: AUTH_HEADER },
      body: JSON.stringify({ messages: [{ role: 'user', content: '请只回复两个字：收到' }], stream: true }),
      signal: AbortSignal.timeout(60000),
    })
    assertEqual(res.headers.get('content-type'), 'text/event-stream',
      `Content-Type 应为 text/event-stream，实际 ${res.headers.get('content-type')}`)

    // 完整读流
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()

    if (text.includes('event: error')) {
      // 本机无通道 → error 帧（验证定稿的 error 帧格式：event 行 + data 行）
      assert(text.includes('"code":"NO_CHANNEL"') || text.includes('"code":"ALL_CHANNELS_FAILED"'),
        `error 帧应带 NO_CHANNEL/ALL_CHANNELS_FAILED，实际：${text.slice(0, 200)}`)
      sseOutcome = 'error 帧（NO_CHANNEL）——帧格式符合定稿'
    } else {
      // 有通道 → content + done 帧
      assert(text.includes('event: content'), `SSE 应有 event: content 帧，实际：${text.slice(0, 200)}`)
      assert(text.includes('event: done'), 'SSE 应有 event: done 帧')
      sseOutcome = 'content + done 帧——帧格式符合定稿'
    }
  },

  '10. 配置热重载链路：watchConfig 触发 → updateConfig 合并（仅内存）': async () => {
    // 用临时文件验证链路，不污染 standalone-v2/（那里没有 config.json 属正常态）。
    // ⚠️ 按 HANDOFF 坑 14：updateConfig 只合并内存 this.config，不落盘不重扫工具，
    //    所以只断言「engine.config 变了」，不断言「工具列表变化」（那是 Task C 未实现能力）。
    const cfgPath = path.join(os.tmpdir(), `gh-hotreload-${Date.now()}.json`)
    fs.writeFileSync(cfgPath, JSON.stringify({ hot: 1 }))

    let received = null
    watchConfig(cfgPath, async (next) => {
      received = next
      await engineRef.updateConfig(next)
    })

    await sleep(300)                       // 等 fs.watch 就绪
    fs.writeFileSync(cfgPath, JSON.stringify({ hot: 2 }))

    // 轮询等 change 事件（Windows 上 fs.watch 时机不保证，最多等 5s）
    for (let i = 0; i < 25 && received === null; i++) {
      await sleep(200)
    }
    stopWatch()
    fs.rmSync(cfgPath, { force: true })

    assert(received !== null, 'watchConfig 回调应被触发（收到新配置）')
    assertEqual(received.hot, 2, '回调应收到修改后的配置')
    assertEqual(engineRef.config.hot, 2, 'engine.updateConfig 应把补丁合进内存配置')
  }
}

const result = await suite('Task G-H 集成测试（真实 HTTP 连接）', tests)

console.log(`\n[chat 用例走向] ${chatOutcome}`)
console.log(`[SSE 用例走向] ${sseOutcome}`)

// ---------- 收尾：关服务、按结果定退出码 ----------
if (serverRef) {
  await new Promise((resolve) => serverRef.close(resolve))
}
process.exit(result.failed > 0 ? 1 : 0)
