/**
 * Task G-H 回归测试：与旧版 vendor/standalone/server.mjs 对比
 * ============================================================================
 * 对比方式：两边都真正起 HTTP 服务（旧版 spawn 子进程 + 随机端口，
 * 新版 in-process + start(0) 随机端口），用内置 fetch 打真实请求对比行为。
 *
 * 运行（cwd 必须是 standalone-v2/）：
 *   node tests/regression.mjs
 * 可选：
 *   REGRESSION_USER=<用户名> REGRESSION_PASS=<密码> node tests/regression.mjs
 *     —— 同时提供后启用「登录后行为对比」（工具清单内容、聊天结构）；
 *        未提供时这些用例自动 SKIP（不算失败），因为旧版凭据硬编码在
 *        auth.mjs 里，测试代码不硬编码真实密码（铁律 5）。
 *
 * 旧版启动隔离（铁律 3：不动 vendor/standalone/）：
 *   BILI_HUMANISM_DATA / BILI_HUMANISM_CONFIG 全部指向临时目录，
 *   旧版运行不写、不改自己目录里的任何文件。
 *
 * 「旧版没有」的能力（SSE、/api/tools/:name 400 白名单等）记为
 * N/A（新增能力），不算回归失败（HANDOFF 5.3）。
 *
 * 退出码：对比项失败 >0 时为 1；SKIP 不影响退出码。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { scryptSync } from 'node:crypto'

// ---------- 路径常量（绝对路径，与 cwd 解耦） ----------
const V2_ROOT = path.resolve(import.meta.dirname, '..')            // standalone-v2/
const OLD_ROOT = path.resolve(V2_ROOT, '..', 'standalone')          // vendor/standalone/
const OLD_SERVER = path.join(OLD_ROOT, 'server.mjs')
const NODE_BIN = process.execPath                                    // 用当前 node 跑旧版

// ---------- 测试专用凭据（新版侧，同 integration.mjs 策略） ----------
const RG_USER = 'rg_user'
const RG_PASS = 'regression-test-pass'
const RG_SALT = 'fedcba9876543210fedcba9876543210'
process.env.AUTH_USER = RG_USER
process.env.AUTH_SALT = RG_SALT
process.env.AUTH_HASH = scryptSync(RG_PASS, RG_SALT, 64).toString('hex')
process.env.SESSION_SECRET = 'synthetic-regression-session-secret'
const NEW_AUTH = 'Basic ' + Buffer.from(`${RG_USER}:${RG_PASS}`).toString('base64')

import { suite, assert, assertEqual } from '../shared/test-utils.mjs'
import { Engine } from '../integrations/engine.mjs'
import { chat } from '../models/router.mjs'
import { getAvailableChannels } from '../models/fallback.mjs'
import { createGateway } from '../gateway/gateway.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 让 OS 分配一个空闲端口（先 listen(0) 再 close，存在极小竞态，测试环境可接受） */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/**
 * 启动旧版服务（子进程 + 临时数据目录，不污染 vendor/standalone/）
 * 返回 { child, port, readyMs }
 */
async function startOldServer() {
  const port = await getFreePort()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regress-old-'))
  const t0 = Date.now()
  const child = spawn(NODE_BIN, [OLD_SERVER, '--port', String(port)], {
    cwd: OLD_ROOT,
    env: {
      ...process.env,
      BILI_HUMANISM_DATA: path.join(tmp, 'data'),
      BILI_HUMANISM_CONFIG: path.join(tmp, 'config.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})   // 只吞日志，避免缓冲塞满阻塞子进程
  child.stderr.on('data', () => {})

  // 轮询探活：/health 未登录会 302（跳 /login），能拿到任何 HTTP 响应即视为就绪
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { redirect: 'manual' })
      if (res.status > 0) {
        return { child, port, readyMs: Date.now() - t0 }
      }
    } catch { /* 未就绪，继续等 */ }
    await sleep(500)
  }
  child.kill()
  throw new Error('旧版服务 30 秒内未就绪')
}

/**
 * 启动新版服务（in-process，fixture 工具，返回 { server, port, readyMs }）
 */
async function startNewServer() {
  const t0 = Date.now()
  const engine = new Engine()
  await engine.start('./tests/fixtures/tools')
  const modelRouter = { chat, getAvailableChannels }
  const { start } = await createGateway(engine, modelRouter)
  const { server } = await start(0)
  const port = server.address().port
  const res = await fetch(`http://127.0.0.1:${port}/api/health`)
  assertEqual(res.status, 200, '新版 /api/health 首次响应应为 200')
  return { server, port, readyMs: Date.now() - t0 }
}

// ---------- 全局状态 ----------
let old = null        // { child, port, readyMs }
let neu = null        // { server, port, readyMs }
let oldCookie = null  // 旧版登录后的会话 cookie
const hasPass = Boolean(process.env.REGRESSION_USER && process.env.REGRESSION_PASS)

/** 旧版登录（真实凭据来自 REGRESSION_USER / REGRESSION_PASS，不落代码） */
async function oldLogin() {
  const res = await fetch(`http://127.0.0.1:${old.port}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.REGRESSION_USER, password: process.env.REGRESSION_PASS }),
  })
  assertEqual(res.status, 200, `旧版登录应 200，实际 ${res.status}`)
  const setCookie = res.headers.get('set-cookie') || ''
  assert(setCookie.includes('hum_session='), '旧版登录应下发会话 cookie')
  oldCookie = setCookie.split(';')[0]
}

const tests = {
  '0. 两版均可启动（旧版 spawn / 新版 in-process）': async () => {
    old = await startOldServer()
    neu = await startNewServer()
    assert(Number.isInteger(old.port) && old.port > 0, '旧版应拿到端口')
    assert(Number.isInteger(neu.port) && neu.port > 0, '新版应拿到端口')
  },

  '1. 未认证 GET 工具列表：两版都 401（等价）': async () => {
    const oldRes = await fetch(`http://127.0.0.1:${old.port}/api/tools`)
    const newRes = await fetch(`http://127.0.0.1:${neu.port}/api/tools`)
    assertEqual(oldRes.status, 401, `旧版未认证应 401，实际 ${oldRes.status}`)
    assertEqual(newRes.status, 401, `新版未认证应 401，实际 ${newRes.status}`)
  },

  '2. 未认证 POST 聊天接口：两版都 401（等价）': async () => {
    const oldRes = await fetch(`http://127.0.0.1:${old.port}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    const newRes = await fetch(`http://127.0.0.1:${neu.port}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assertEqual(oldRes.status, 401, `旧版未认证聊天应 401，实际 ${oldRes.status}`)
    assertEqual(newRes.status, 401, `新版未认证聊天应 401，实际 ${newRes.status}`)
  },

  '3. 健康端点免认证行为：旧 302 跳登录 / 新 200（差异：新版监控友好）': async () => {
    const oldRes = await fetch(`http://127.0.0.1:${old.port}/health`, { redirect: 'manual' })
    const newRes = await fetch(`http://127.0.0.1:${neu.port}/api/health`)
    assertEqual(oldRes.status, 302, `旧版 /health 未认证应 302 跳登录，实际 ${oldRes.status}`)
    assertEqual(newRes.status, 200, `新版 /api/health 免认证应 200，实际 ${newRes.status}`)
    const body = await newRes.json()
    assertEqual(body.status, 'ok')
    // 差异记录（非失败）：旧版健康端点也被会话保护，负载均衡器探活会被 302 干扰；
    // 新版免认证 + status 字段，对监控更友好。
  },

  '4. 调用不存在的工具：两版都 404（等价，路径单复数不同）': async () => {
    // 旧版：POST /api/tool/<name>（单数，需登录）
    if (hasPass) {
      if (!oldCookie) await oldLogin()
      const oldRes = await fetch(`http://127.0.0.1:${old.port}/api/tool/__nope__`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: oldCookie }, body: '{}',
      })
      assertEqual(oldRes.status, 404, `旧版工具不存在应 404，实际 ${oldRes.status}`)
    }
    // 新版：POST /api/tools/<name>（复数）
    const newRes = await fetch(`http://127.0.0.1:${neu.port}/api/tools/__nope__`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: NEW_AUTH }, body: '{}',
    })
    assertEqual(newRes.status, 404, `新版工具不存在应 404，实际 ${newRes.status}`)
    // 差异记录：路径从 /api/tool/<name>（单数）变为 /api/tools/<name>（复数），
    // 且 body 约定从「body 即 args」变为 { args: {...} }——客户端需同步调整。
  },

  '5. 工具清单内容对比：旧 11 运行时工具 / 新 2 fixture（差异已记录）': async () => {
    const newRes = await fetch(`http://127.0.0.1:${neu.port}/api/tools`, {
      headers: { authorization: NEW_AUTH },
    })
    const newBody = await newRes.json()
    assertEqual(newBody.count, 2)
    if (hasPass) {
      if (!oldCookie) await oldLogin()
      const oldRes = await fetch(`http://127.0.0.1:${old.port}/api/tools`, {
        headers: { cookie: oldCookie },
      })
      const oldBody = await oldRes.json()
      assertEqual(oldRes.status, 200)
      assert(Array.isArray(oldBody.tools), '旧版 tools 应为数组')
      console.log(`   [对比] 旧版 ${oldBody.tools.length} 个（运行时 ctx.tools.list()）` +
        ` vs 新版 ${newBody.count} 个（文件扫描 fixture）`)
      // 差异原因（HANDOFF 1.3/5.3）：旧版工具来自运行时上下文，新版来自 tools/ 目录
      // 文件扫描；真实工具迁移不在 Task G-H 范围，允许不等，如实记录。
    } else {
      console.log('   [SKIP-旧版侧] 未设置 REGRESSION_PASS，跳过旧版登录对比')
    }
  },

  '6. 聊天接口结构对比：回复文本字段语义等价（reply ↔ content）': async () => {
    const newRes = await fetch(`http://127.0.0.1:${neu.port}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: NEW_AUTH },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
      signal: AbortSignal.timeout(60000),
    })
    if (newRes.status === 200) {
      const b = await newRes.json()
      assert(typeof b.content === 'string', '新版聊天应返回 content 字段')
      console.log(`   [新版] 200 content="${String(b.content).slice(0, 40)}..."`)
    } else {
      const b = await newRes.json()
      assert([502, 503].includes(newRes.status), `新版无通道应 502/503，实际 ${newRes.status}`)
      console.log(`   [新版] ${newRes.status} ${b.code}（本机无可用模型通道——合法分支）`)
    }
    if (hasPass) {
      if (!oldCookie) await oldLogin()
      const oldRes = await fetch(`http://127.0.0.1:${old.port}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: oldCookie },
        body: JSON.stringify({ text: '你好' }),
        signal: AbortSignal.timeout(60000),
      })
      const oldBody = await oldRes.json()
      assertEqual(oldRes.status, 200, `旧版聊天应 200（失败退回规则也应答），实际 ${oldRes.status}`)
      assert(typeof oldBody.reply === 'string', '旧版聊天应返回 reply 字段')
      console.log(`   [旧版] 200 mode=${oldBody.mode} reply="${String(oldBody.reply).slice(0, 40)}..."`)
      // 结构差异记录（非失败）：入参 {text} → {messages:[{role,content}]}；
      // 出参 reply → content；旧版模型失败时仍 200 + mode:fallback，
      // 新版无通道时 503 NO_CHANNEL（错误不再被吞掉，语义更 RESTful）。
    } else {
      console.log('   [SKIP-旧版侧] 未设置 REGRESSION_PASS，跳过旧版聊天对比')
    }
  },

  '7. 冷启动到首次响应耗时（口径注明，仅供参考）': async () => {
    // 口径差异：旧版=spawn 新进程到探活成功（含 node 启动）；新版=in-process
    // 从 Engine.start 前到 /api/health 首次 200（不含进程启动）。仅记录，不断言优劣。
    console.log(`   [对比] 旧版 ${old.readyMs}ms（含进程启动） / 新版 ${neu.readyMs}ms（不含进程启动）`)
    assert(old.readyMs > 0 && neu.readyMs > 0, '耗时应为正数')
  },
}

const result = await suite('Task G-H 回归测试（vs 旧版 standalone）', tests)

// ---------- 收尾：杀旧版子进程、关新版服务 ----------
if (old?.child) old.child.kill()
if (neu?.server) await new Promise((r) => neu.server.close(r))
process.exit(result.failed > 0 ? 1 : 0)
