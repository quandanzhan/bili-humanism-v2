import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const dir = mkdtempSync(join(tmpdir(), 'standalone-redaction-'))
process.env.BILI_HUMANISM_DATA = dir
for (const key of ['SETTINGS', 'SCHEDULE', 'NODES', 'VISION', 'MCP', 'MODELS']) {
  process.env[`BILI_HUMANISM_${key}`] = join(dir, `${key.toLowerCase()}.json`)
}
process.env.BILI_HUMANISM_LEGACY = join(dir, 'legacy')
for (const key of ['REPLY_TALKER', 'SMTP_HOST', 'ALERT_TO', 'BILI_HUMANISM_V1_ENV', 'BILI_HUMANISM_V1_DUTY', 'BILI_HUMANISM_PARSE_HEALTH_URL']) delete process.env[key]

const runtime = await import('../runtime.mjs')
const channels = await import('../../models/channels.mjs')
const nodes = await import('../nodes.mjs')
const vision = await import('../vision.mjs')
const mcp = await import('../mcp.mjs')
const worker = await import('../worker.mjs')
const settings = await import('../settings.mjs')
const reply = await import('../reply-loop.mjs')
const schedule = await import('../schedule.mjs')
const { errorHandler } = await import('../middleware/error.mjs')
const { callChannel } = await import('../../models/fallback.mjs')
const { chat, testChannel } = await import('../../models/router.mjs')
const { default: nodemailer } = await import('nodemailer')
const { alertChannel } = await import('../notifier.mjs')

const key = randomBytes(24).toString('hex')
const query = randomBytes(24).toString('hex')
const url = `https://example.com/v1?token=${query}`
const absent = (value, secrets = [key, query]) => {
  const text = JSON.stringify(value)
  assert.ok(secrets.every((secret) => !text.includes(secret)), '输出不得含测试凭证')
}

test.after(() => {
  mcp.closeAll()
  rmSync(dir, { recursive: true, force: true })
})

test('脱敏覆盖嵌套字段、Bearer、URL用户信息、查询参数和裸回显', () => {
  runtime.registerSecrets([key])
  absent(runtime.redactData({ apiKey: key, nested: { url, message: `Bearer ${key} ${query} ${url}` } }))
  absent(runtime.safeUrl(`https://user:${key}@example.com/?session=${query}`)) // security-synthetic-fixture：随机生成的 URL 脱敏夹具
  assert.equal(runtime.restoreUrl(runtime.safeUrl(url), url), url)
  assert.equal(new URL(runtime.completionUrl(url)).pathname, '/v1/chat/completions')
  assert.equal(new URL(runtime.completionUrl(url)).searchParams.get('token'), query)
})

test('默认配置不导入生产文件、不预设负责人或解析节点', async () => {
  assert.equal(reply.loadState().talker, 0)
  assert.equal((await reply.runOnce({ simulate: '卡片 aid=123' })).reason, 'NOT_CONFIGURED')
  assert.equal(settings.load().smtp.enabled, false)
  assert.equal(schedule.loadSchedule().seedFrom, 'defaults')
  assert.equal(nodes.loadNodes().nodes[0].enabled, false)
  assert.equal(nodes.loadNodes().nodes[0].url, '')
})

test('模型状态和增改响应脱敏，打码URL更新不丢认证', () => {
  const added = channels.add({ name: '测试通道', baseURL: url, model: 'mock-model', apiKey: key })
  absent(added)
  const view = channels.masked().channels[0]
  absent(view)
  channels.update(added.id, { baseURL: view.baseURL, priority: 5, apiKey: '***' })
  assert.equal(channels.list()[0].baseURL, url)
  assert.equal(channels.list()[0].apiKey, key)
})

test('节点状态、响应片段及URL往返保留认证', async () => {
  nodes.saveNodes({ nodes: [{ id: 'test', name: '测试节点', url, auth: key, enabled: true }] })
  const view = nodes.sanitize()
  absent(view)
  nodes.saveNodes(view)
  assert.equal(nodes.loadNodes().nodes[0].url, url)
  assert.equal(nodes.loadNodes().nodes[0].auth, key)
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, apiKey: key, url }))
  try { absent(await nodes.probeAll({ force: true })) } finally { globalThis.fetch = original }
})

test('视觉状态与上游错误不回显密钥，URL可安全保存', async () => {
  vision.saveVision({ backends: [{ id: 'test', name: '测试视觉', baseURL: url, model: 'mock', apiKey: key }] })
  const view = vision.visionStatus()
  absent(view)
  vision.saveVision({ backends: view.backends })
  assert.equal(vision.loadVision().backends[0].baseURL, url)
  assert.equal(vision.loadVision().backends[0].apiKey, key)
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: `${key} ${query} ${url}` } }), { status: 401 })
  try { absent(await vision.describeImages({ images: ['data:image/png;base64,AA=='], cache: false })) } finally { globalThis.fetch = original }
})

test('视觉成功响应与环境Key裸回显也脱敏', async () => {
  const envKey = randomBytes(24).toString('hex')
  process.env.REDACTION_VISION_API_KEY = envKey
  vision.saveVision({ backends: [{ id: 'env-test', name: '环境视觉', baseURL: url, model: 'mock', apiKeyEnv: 'REDACTION_VISION_API_KEY' }] })
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: `颜色：红色；${envKey} ${query} ${url}` } }] }))
  try {
    const result = await vision.describeImages({ images: ['data:image/png;base64,AA=='], cache: false })
    assert.equal(result.ok, true)
    absent(result, [envKey, query])
  } finally {
    globalThis.fetch = original
    delete process.env.REDACTION_VISION_API_KEY
  }
})

test('MCP env、独立及内联参数打码，保存后仍保留原值', () => {
  mcp.saveMcpConfig({ servers: [{ id: 'test', command: 'node', args: ['--token', key, `--url=${url}`, `--api-key=${key}`], env: { API_KEY: key, CUSTOM_CONFIG: query }, enabled: false }] })
  const view = mcp.maskedMcpConfig()
  absent(view)
  mcp.saveMcpConfig(view)
  const saved = mcp.loadMcpConfig().servers[0]
  assert.equal(saved.env.API_KEY, key)
  assert.equal(saved.env.CUSTOM_CONFIG, query)
  assert.equal(saved.args[1], key)
  assert.equal(saved.args[2], `--url=${url}`)
  assert.equal(saved.args[3], `--api-key=${key}`)
})

test('MCP启动失败不会触发未处理异常或回显参数凭证', async () => {
  mcp.saveMcpConfig({ servers: [{ id: 'missing', command: 'standalone-redaction-command-not-installed', args: ['--token', key], enabled: true }] })
  const result = await mcp.listMcp({ connect: true })
  assert.ok(result[0].error)
  absent(result)
  absent(mcp.mcpStatus())
})

test('worker状态与错误中间件日志、堆栈和额外数据脱敏', () => {
  const id = worker.enqueue('probe')
  worker.submit(id, { ok: false, error: `${key} ${url}` })
  absent(worker.queueStatus())
  const original = console.warn
  const logged = []
  console.warn = (...args) => logged.push(args)
  let response
  try {
    const error = Object.assign(new Error(`${key} ${url}`), { statusCode: 400, data: { apiKey: key, url } })
    errorHandler(error, { method: 'GET', url: `/test?token=${query}`, headers: {} }, { status() { return this }, json(value) { response = value } }, () => {})
    absent(response)
    absent(logged)
  } finally { console.warn = original }
})

test('模型请求及测试错误保留状态码且不泄露上游裸回显', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (target) => {
    assert.equal(new URL(target).pathname, '/v1/chat/completions')
    assert.equal(new URL(target).searchParams.get('token'), query)
    return new Response(JSON.stringify({ error: { message: `${key} ${query} ${url}` } }), { status: 401 })
  }
  try {
    const channel = channels.list()[0]
    await assert.rejects(callChannel(channel, []), (error) => { absent(error.message); assert.equal(error.status, 401); return true })
    const result = await testChannel(channel)
    assert.equal(result.status, 401)
    absent(result)
  } finally { globalThis.fetch = original }
})

test('alertChannel四路径邮件与节流保留，邮件不泄露凭证', async () => {
  const sent = []
  const original = nodemailer.createTransport
  nodemailer.createTransport = () => ({ sendMail: async (message) => { sent.push(message); return { messageId: 'mock' } } })
  settings.save({ smtp: { enabled: true, host: 'smtp.example.com', to: 'alerts@example.com', pass: key }, alerts: { onChannelFailed: true } })
  try {
    for (const level of ['down', 'all', 'none', 'hard']) {
      alertChannel({ level, channel: '测试通道', code: 'TEST', detail: `${key} ${query} ${url}` })
    }
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(sent.length, 4)
    absent(sent)
    alertChannel({ level: 'none', code: 'TEST' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(sent.length, 4)
  } finally {
    settings.save({ smtp: { enabled: false } })
    nodemailer.createTransport = original
  }
})

test('模型路由仍触发none/down/all/hard告警分支', async () => {
  const original = globalThis.fetch
  const channel = { id: 'test', name: '测试通道', baseURL: url, model: 'mock', apiKey: key, enabled: true }
  channels.save({ auto: true, channels: [] })
  await assert.rejects(chat([]), { code: 'NO_CHANNEL' })
  channels.save({ auto: true, channels: [channel] })
  globalThis.fetch = async () => new Response('{}', { status: 429 })
  try {
    await assert.rejects(chat([]), { code: 'ALL_CHANNELS_FAILED' })
    globalThis.fetch = async () => new Response('{}', { status: 401 })
    await assert.rejects(chat([]), { code: 'CHANNEL_FAILED' })
  } finally { globalThis.fetch = original }
})
