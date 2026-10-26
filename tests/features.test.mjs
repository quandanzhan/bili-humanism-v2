/**
 * 新功能集成测试：通道管理 / 降级直答 / CORS 白名单 / 旧路径兼容
 * ============================================================================
 * 覆盖 2026-10-22 三项决策落地后的行为，全部走真实 HTTP（内置 fetch + start(0)）。
 *
 * 运行（cwd 必须是 standalone-v2/）：
 *   node tests/features.test.mjs
 *
 * 隔离：通道数据写到临时文件（BILI_HUMANISM_MODELS），绝不动 /opt 下的真实配置。
 */

import { scryptSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------- 隔离通道配置文件（必须在 import 通道模块之前设置） ----------
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haitang-feat-'))
const CHANNEL_FILE = path.join(TMP_DIR, 'models.json')
process.env.BILI_HUMANISM_MODELS = CHANNEL_FILE

// ---------- 测试专用凭据 ----------
const T_USER = 'feat_user'
const T_PASS = 'features-test-pass'
const T_SALT = 'fedcba9876543210fedcba9876543210'
process.env.AUTH_USER = T_USER
process.env.AUTH_SALT = T_SALT
process.env.AUTH_HASH = scryptSync(T_PASS, T_SALT, 64).toString('hex')
process.env.SESSION_SECRET = 'synthetic-features-session-secret'
const AUTH = 'Basic ' + Buffer.from(`${T_USER}:${T_PASS}`).toString('base64')
const ORIGIN_OK = 'http://localhost:5173'

import { suite, assert, assertEqual } from '../shared/test-utils.mjs'
import { Engine } from '../integrations/engine.mjs'
import { chat } from '../models/router.mjs'
import { getAvailableChannels } from '../models/fallback.mjs'
import { createGateway } from '../gateway/gateway.mjs'

let baseUrl = null
let serverRef = null
let firstId = null
let secondId = null

/** 带认证的 fetch */
function req(pathname, { method = 'GET', body, headers = {}, auth = true } = {}) {
  return fetch(baseUrl + pathname, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(auth ? { Authorization: AUTH } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
}

const tests = {
  '01. 静态控制台可访问且不要求认证（登录在页面内完成）': async () => {
    const res = await req('/', { auth: false })
    const html = await res.text()
    assertEqual(res.status, 200)
    assert(res.headers.get('content-type').includes('text/html'), '应返回 HTML')
    assert(html.includes('海棠控制台'), '应包含控制台标题')
  },

  '02. 通道列表初始为空': async () => {
    const res = await req('/api/channels')
    const d = await res.json()
    assertEqual(res.status, 200)
    assertEqual(d.count, 0)
    assertEqual(d.auto, true)
    assert(Array.isArray(d.channels), 'channels 应是数组')
  },

  '03. 新增通道：apiKey 打码、优先级自动 10': async () => {
    const res = await req('/api/channels', {
      method: 'POST',
      body: {
        name: '测试主通道',
        baseURL: 'https://api.example.com/v1',
        model: 'test-model-a',
        apiKey: 'synthetic-channel-a',
        note: '来自测试'
      }
    })
    const d = await res.json()
    assertEqual(res.status, 201)
    assertEqual(d.channel.apiKey, '***', 'apiKey 必须打码')
    assertEqual(d.channel.priority, 10, '首个通道优先级应为 10')
    assertEqual(d.channel.enabled, true)
    firstId = d.channel.id
  },

  '04. 第二个通道优先级自动 20': async () => {
    const res = await req('/api/channels', {
      method: 'POST',
      body: { name: '备用通道', baseURL: 'https://api.example.org/v1', model: 'test-model-b', apiKey: 'synthetic-channel-b' }
    })
    const d = await res.json()
    assertEqual(res.status, 201)
    assertEqual(d.channel.priority, 20)
    secondId = d.channel.id
  },

  '05. 缺 model 应 400 BAD_MODEL': async () => {
    const res = await req('/api/channels', {
      method: 'POST',
      body: { name: '坏通道', baseURL: 'https://api.bad.com/v1', model: '' }
    })
    const d = await res.json()
    assertEqual(res.status, 400)
    assertEqual(d.code, 'BAD_MODEL')
  },

  '06. 同 BaseURL + 同模型应 400 DUP': async () => {
    const res = await req('/api/channels', {
      method: 'POST',
      body: { name: '重复', baseURL: 'https://api.example.com/v1', model: 'test-model-a' }
    })
    const d = await res.json()
    assertEqual(res.status, 400)
    assertEqual(d.code, 'DUP')
  },

  '07. 停用通道（PATCH enabled=false）': async () => {
    const res = await req(`/api/channels/${secondId}`, {
      method: 'PATCH',
      body: { enabled: false }
    })
    const d = await res.json()
    assertEqual(res.status, 200)
    assertEqual(d.channel.enabled, false)
  },

  '08. 调整优先级：reorder 后按传入顺序重排 10/20': async () => {
    const res = await req('/api/channels/reorder', {
      method: 'POST',
      body: { ids: [secondId, firstId] }
    })
    const d = await res.json()
    assertEqual(res.status, 200)
    assertEqual(d.channels[0].id, secondId, '第二通道应排第一')
    assertEqual(d.channels[0].priority, 10)
    assertEqual(d.channels[1].priority, 20)
  },

  '09. reorder 传未知 id 应 400 BAD_ORDER': async () => {
    const res = await req('/api/channels/reorder', {
      method: 'POST',
      body: { ids: ['ch_not_exist'] }
    })
    const d = await res.json()
    assertEqual(res.status, 400)
    assertEqual(d.code, 'BAD_ORDER')
  },

  '10. 测试不存在的通道应 404': async () => {
    const res = await req('/api/channels/ch_nope/test', { method: 'POST', body: {} })
    assertEqual(res.status, 404)
  },

  '11. 有通道但全部失败时不降级（502/503 暴露真故障）': async () => {
    // 两个通道都是假 key，必然失败；关键断言：不能返回 200 degraded
    const res = await req('/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: '你好' }] }
    })
    const d = await res.json()
    assert(res.status >= 400, `通道失败应报错，实际 ${res.status}`)
    assert(d.degraded !== true, '配置了通道但失败时不得伪装成降级成功')
  },

  '12. 清空通道后 chat 走降级直答（200 + degraded）': async () => {
    await req(`/api/channels/${firstId}`, { method: 'DELETE' })
    const res2 = await req(`/api/channels/${secondId}`, { method: 'DELETE' })
    assertEqual(res2.status, 200)

    const res = await req('/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: '你好' }] }
    })
    const d = await res.json()
    assertEqual(res.status, 200, '未配置通道时不应卡死')
    assertEqual(d.degraded, true)
    assertEqual(d.mode, 'degraded')
    assertEqual(d.reason, 'NO_CHANNEL')
    assertEqual(d.channel, 'local-rule')
    assert(typeof d.content === 'string' && d.content.length > 10, '应有规则话术内容')
    assert(d.content.includes('离线模式'), '话术必须自我标明离线')
  },

  '13. 降级流式：帧含 event: 行且 done.degraded=true': async () => {
    const res = await req('/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: '怎么配置模型' }], stream: true }
    })
    assertEqual(res.status, 200)
    const text = await res.text()
    assert(text.includes('event: content'), '必须有具名 content 事件')
    assert(text.includes('event: done'), '必须有具名 done 事件')

    const doneLine = text.split('\n').find(l => l.startsWith('data:') && l.includes('"done"'))
    const payload = JSON.parse(doneLine.slice(5).trim())
    assertEqual(payload.degraded, true)
    assertEqual(payload.reason, 'NO_CHANNEL')
  },

  '14. RULE_FALLBACK=0 时退回 503 NO_CHANNEL': async () => {
    const prev = process.env.RULE_FALLBACK
    process.env.RULE_FALLBACK = '0'
    try {
      const res = await req('/api/chat', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: '你好' }] }
      })
      const d = await res.json()
      assertEqual(res.status, 503)
      assertEqual(d.code, 'NO_CHANNEL')
    } finally {
      if (prev === undefined) delete process.env.RULE_FALLBACK
      else process.env.RULE_FALLBACK = prev
    }
  },

  '15. CORS 白名单来源回显 Origin': async () => {
    const res = await req('/api/health', { auth: false, headers: { Origin: ORIGIN_OK } })
    assertEqual(res.headers.get('access-control-allow-origin'), ORIGIN_OK)
    assertEqual(res.headers.get('access-control-allow-credentials'), 'true')
    assertEqual(res.headers.get('vary'), 'Origin')
  },

  '16. CORS 未知来源不下发 Allow-Origin': async () => {
    const res = await req('/api/health', { auth: false, headers: { Origin: 'https://evil.example.com' } })
    assertEqual(res.headers.get('access-control-allow-origin'), null)
  },

  '17. 旧路径 /api/tool/:name 走工具路由（非 ROUTE_NOT_FOUND）': async () => {
    const res = await req('/api/tool/echo', { method: 'POST', body: { input: 'hi' } })
    const d = await res.json()
    // 没有加载工具时是 TOOL_NOT_FOUND；关键是别掉进 404 路由兜底
    assert(d.code !== 'ROUTE_NOT_FOUND', `旧路径未挂载，实际 code=${d.code}`)
    assertEqual(res.status, 404)
  },

  '18. auto 开关可切换': async () => {
    const off = await req('/api/channels/auto', { method: 'PUT', body: { auto: false } })
    const d1 = await off.json()
    assertEqual(d1.auto, false)

    const on = await req('/api/channels/auto', { method: 'PUT', body: { auto: true } })
    const d2 = await on.json()
    assertEqual(d2.auto, true)
  },

  '19. 通道接口未认证应 401': async () => {
    const res = await req('/api/channels', { auth: false })
    assertEqual(res.status, 401)
  },

  // ── 工具错误码透传（engine.callTool 修复后，语义化错误码必须按
  //    error.mjs 的映射出 HTTP 状态，而不是被路由层压成 400）──
  '20. file_read 不存在路径 → 404 + FILE_NOT_FOUND': async () => {
    const res = await req('/api/tools/file_read', { method: 'POST', body: { args: { path: 'C:/no/such/__feat__.log' } } })
    const d = await res.json()
    assertEqual(res.status, 404)
    assertEqual(d.code, 'FILE_NOT_FOUND')
    assert(d.data?.hint, '错误应带 hint')
  },

  '21. web_fetch file:// 协议 → 400 + URL_INVALID': async () => {
    const res = await req('/api/tools/web_fetch', { method: 'POST', body: { args: { url: 'file:///etc/passwd' } } })
    const d = await res.json()
    assertEqual(res.status, 400)
    assertEqual(d.code, 'URL_INVALID')
  },

  '22. bili_video 非法 BV → 400 + BILI_INVALID_BVID': async () => {
    const res = await req('/api/tools/bili_video', { method: 'POST', body: { args: { bvid: 'hello' } } })
    const d = await res.json()
    assertEqual(res.status, 400)
    assertEqual(d.code, 'BILI_INVALID_BVID')
  }
}

// ------------------------------------------------------------------ 执行
async function main() {
  const engine = new Engine()
  await engine.start('./tools')
  const { start } = await createGateway(engine, { chat, getAvailableChannels })
  const started = await start(0)
  serverRef = started.server
  baseUrl = `http://127.0.0.1:${serverRef.address().port}`

  let passed = 0
  let failed = 0
  const failures = []

  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn()
      console.log(`✅ ${name}`)
      passed++
    } catch (err) {
      console.log(`❌ ${name}`)
      console.log(`   ${err.message}`)
      failures.push({ name, error: err })
      failed++
    }
  }

  console.log('─'.repeat(60))
  console.log(`总计: ${passed + failed} | 通过: ${passed} | 失败: ${failed}`)

  if (serverRef) serverRef.close()
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }) } catch { /* ignore */ }

  if (failed > 0) {
    console.log('\n失败详情:')
    failures.forEach(f => console.log(` - ${f.name}: ${f.error.message}`))
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('测试运行器异常:', err)
  process.exit(1)
})
