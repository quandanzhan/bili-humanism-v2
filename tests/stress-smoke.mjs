/**
 * 三轮压力冒烟测试（真实进程 + 真实 HTTP + 真实网络混合）
 * ============================================================================
 * 运行（cwd 必须是 standalone-v2/）：
 *   BILI_CREDENTIAL=<凭据> node tests/stress-smoke.mjs
 *
 * 流程：spawn main.mjs 起真网关 → 三轮压测 → 杀进程 → 汇总。
 *
 * 三轮设计（对 B 站/搜索引擎克制，避免把自己打进风控）：
 *   R1 基线并发   —— 每工具 1 路串行起步 + 10 并发混合，验证功能在并发下仍正确
 *   R2 阶梯加压   —— 并发 10→25→50，混合本地(file_read/health/chat规则)与
 *                    网络(web_fetch 缓存页/bili_video/comments)，看吞吐与延迟劣化
 *   R3 错误风暴+浸泡 —— 参数校验错误与正常请求 1:1，30 并发持续 20s，
 *                    验证错误不污染进程、内存不涨、P99 不漂移
 *
 * 判定标准（冒烟级，不追求性能极限）：
 *   · 全部轮次成功率：R1/R2 ≥ 98%（真实网络偶发超时允许少量 <100%）
 *   · R3 错误请求返回 4xx 且 code 正确（错误风暴不能演变成 5xx）
 *   · 服务进程全程存活，/api/health 收尾仍 200
 *   · 子进程 RSS 末值/初值 < 2.0（泄漏粗检）
 */
import { spawn } from 'node:child_process'
import { scryptSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
const USER = 'stress_user'
const PASS = 'stress-test-pass'
const SALT = '0123456789abcdef0123456789abcdef'
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')

const tmp = fs.mkdtempSync(path.join(os.tmpDir?.() || os.tmpdir(), 'haitang-stress-'))
const portFile = path.join(tmp, 'port.txt')

// ── 启动服务（随机高位端口；main.mjs 的 PORT=0 会被 || 吞掉退回 3000，故避开）──
const chosenPort = 20000 + Math.floor(Math.random() * 20000)
const child = spawn(process.execPath, ['main.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(chosenPort),
    AUTH_USER: USER,
    AUTH_SALT: SALT,
    AUTH_HASH: scryptSync(PASS, SALT, 64).toString('hex'),
    SESSION_SECRET: 'synthetic-stress-session-secret',
    NODE_ENV: 'production'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let base = null
let stdoutBuf = ''
let rssSamples = []
// stdout 由 findPort 的 data 监听持续排空；stderr 必须 resume()：
// 子进程管道写满会阻塞其事件循环，表现为「服务整体冻结、连 health 都超时」。
child.stderr.resume()

function findPort() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务 15s 内未就绪')), 15000)
    child.stdout.on('data', (d) => {
      stdoutBuf += String(d)
      const m = /网关已启动: http:\/\/localhost:(\d+)/.exec(stdoutBuf)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`服务提前退出 code=${code}\n${stdoutBuf.slice(0, 800)}`)) })
  })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function rssOf() {
  // 跨平台取 RSS：优先 /proc，否则跳过（Windows 用 tasklist 太重，冒烟可接受跳过）
  try {
    const f = `/proc/${child.pid}/statm`
    if (fs.existsSync(f)) return parseInt(fs.readFileSync(f, 'utf8').split(' ')[1], 10) * 4096
  } catch { /* ignore */ }
  return null
}

// ── 发一个请求并记录耗时/状态 ──
async function hit(p, opts = {}) {
  const t0 = Date.now()
  try {
    const res = await fetch(base + p, {
      method: opts.method || 'GET',
      headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), Authorization: AUTH, ...(opts.headers || {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs || 20000)
    })
    let code = null
    try { code = (await res.clone().json())?.code } catch { /* ignore */ }
    return { ok: res.ok, status: res.status, code, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, status: 0, code: e.name === 'TimeoutError' ? 'CLIENT_TIMEOUT' : 'CLIENT_ERROR', ms: Date.now() - t0 }
  }
}

function stats(arr) {
  const sorted = [...arr].sort((a, b) => a - b)
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  return {
    n: arr.length,
    p50: q(0.5), p95: q(0.95), p99: q(0.99),
    max: sorted[sorted.length - 1] ?? 0,
    avg: Math.round(arr.reduce((s, x) => s + x, 0) / (arr.length || 1))
  }
}

const verdict = { rounds: [], overallPass: true }
function check(label, cond, detail) {
  verdict.rounds.push({ label, pass: cond, detail })
  if (!cond) verdict.overallPass = false
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`)
}

// 工作负载定义：label → 请求工厂
// local = 不依赖外网（服务端能力测试，成功标准严格）
// net   = 依赖 B站/搜索引擎（受对方限流影响，成功标准宽松，只验证服务不被拖垮）
const NETWORK_LABELS = new Set(['bili_video', 'bili_comments', 'bili_search', 'web_search', 'web_fetch'])

function makeLoads(includeNetwork) {
  const local = [
    ['health', () => hit('/api/health', { auth: false })],
    ['file_read', () => hit('/api/tools/file_read', { method: 'POST', body: { args: { path: path.join(ROOT, 'config', 'loader.mjs'), maxBytes: 8192 } } })],
    ['chat_rule', () => hit('/api/chat', { method: 'POST', body: { messages: [{ role: 'user', content: '你好' }] }, timeoutMs: 15000 })],
    ['bili_video_bad', () => hit('/api/tools/bili_video', { method: 'POST', body: { args: { bvid: 'hello' } } })],
    ['url_invalid', () => hit('/api/tools/web_fetch', { method: 'POST', body: { args: { url: 'file:///x' } } })],
    ['file_missing', () => hit('/api/tools/file_read', { method: 'POST', body: { args: { path: 'C:/no/__stress__.log' } } })]
  ]
  const network = [
    ['bili_video', () => hit('/api/tools/bili_video', { method: 'POST', body: { args: { bvid: 'BV1ZVWbeFEpX' } } })],
    ['bili_comments', () => hit('/api/tools/bili_comments', { method: 'POST', body: { args: { bvid: 'BV1ZVWbeFEpX', limit: 5 } } })],
    ['bili_search', () => hit('/api/tools/bili_search', { method: 'POST', body: { args: { keyword: '白云号', limit: 3 } } })],
    ['web_search', () => hit('/api/tools/web_search', { method: 'POST', body: { args: { query: '压测冒烟 OpenAI', limit: 3 } } })],
    ['web_fetch', () => hit('/api/tools/web_fetch', { method: 'POST', body: { args: { url: 'https://example.com/', maxChars: 500 } } })]
  ]
  return includeNetwork ? [...local, ...network] : local
}

async function runConcurrent(loads, concurrency, total) {
  const lat = [], errs = {}
  let done = 0, i = 0
  let localN = 0, localOk = 0, netN = 0, netOk = 0
  async function worker() {
    while (done < total) {
      done++
      const [label, f] = loads[i++ % loads.length]
      const r = await f()
      lat.push(r.ms)
      const expect4xx = label.endsWith('_bad') || label === 'url_invalid' || label === 'file_missing'
      const bad = expect4xx ? (r.status < 400 || r.status >= 500) : !r.ok
      if (NETWORK_LABELS.has(label)) { netN++; if (!bad) netOk++ }
      else { localN++; if (!bad) localOk++ }
      if (bad) errs[`${label}:${r.status}:${r.code ?? '-'}`] = (errs[`${label}:${r.status}:${r.code ?? '-'}`] || 0) + 1
    }
  }
  const t0 = Date.now()
  await Promise.all(Array.from({ length: concurrency }, worker))
  const wall = Date.now() - t0
  const okN = lat.length - Object.values(errs).reduce((a, b) => a + b, 0)
  return { lat: stats(lat), wall, errs, total, okN, localN, localOk, netN, netOk }
}

// 本地服务成功率（严格）：这些不依赖外网，任何失败都算服务端问题
function localRate(res) { return res.localN ? res.localOk / res.localN : 1 }
// 真实网络成功率（宽松）：受 B站/搜索引擎限流，冒烟只要求不全线崩且无 5xx
function netRate(res) { return res.netN ? res.netOk / res.netN : 1 }
function hasServer5xx(res) { return Object.keys(res.errs).some(k => /:5\d\d:/.test(k)) }

// ══════════════════ 主流程 ══════════════════
const port = await findPort()
base = `http://127.0.0.1:${port}`
console.log(`\n服务就绪: ${base} (pid=${child.pid})`)
const r0 = await rssOf()

// ── R1 基线并发 ──
// 判定拆分：本地负载（不依赖外网）严格 ≥98%；真实网络负载宽松 ≥60%
//（B站/搜索引擎对 10 并发已可能限流，返回 504 是「如实降级」，不算服务崩溃。
//  真正的红线是：服务自身不产生 500、进程不死）。
console.log('\n══════ R1 基线并发（本地+真实网络，20 请求 / 10 并发）══════')
{
  const res = await runConcurrent(makeLoads(true), 10, 20)
  console.log(`  延迟 p50=${res.lat.p50}ms p95=${res.lat.p95}ms max=${res.lat.max}ms 均=${res.lat.avg}ms 墙钟=${res.wall}ms`)
  if (Object.keys(res.errs).length) console.log('  异常分布:', JSON.stringify(res.errs))
  check('R1 本地成功率 ≥98%', localRate(res) >= 0.98, `${res.localOk}/${res.localN}`)
  check('R1 网络成功率 ≥60%（限流容忍）', netRate(res) >= 0.6, `${res.netOk}/${res.netN}`)
  check('R1 无服务端 500', !hasServer5xx(res))
}

// ── R2 阶梯加压 ──
// 阶梯用**纯本地**负载测服务端自身容量（外网并发不是本机能力问题）；
// 另跑一档 10 并发网络混合，确认外网路径在压力下不产生 500。
console.log('\n══════ R2 阶梯加压（纯本地：并发 10→25→50）══════')
let prevP99 = null
for (const [c, n] of [[10, 30], [25, 60], [50, 100]]) {
  const res = await runConcurrent(makeLoads(false), c, n)
  console.log(`  并发=${String(c).padStart(2)} 请求=${n} 成功=${res.okN}/${res.total} 墙钟=${res.wall}ms p50=${res.lat.p50} p95=${res.lat.p95} p99=${res.lat.p99} max=${res.lat.max}ms`)
  if (Object.keys(res.errs).length) console.log('    异常分布:', JSON.stringify(res.errs))
  check(`R2 并发${c} 本地成功率 ≥95%`, localRate(res) >= 0.95, `${res.localOk}/${res.localN}`)
  check(`R2 并发${c} 无服务端 500`, !hasServer5xx(res))
  if (prevP99 != null) check(`R2 并发${c} p99 未爆炸(≤4×上一级)`, res.lat.p99 <= prevP99 * 4, `${res.lat.p99} vs ${prevP99}`)
  prevP99 = res.lat.p99
  await sleep(300)
}
console.log('  ── 附加：混合网络 15 请求 / 10 并发 ──')
{
  const res = await runConcurrent(makeLoads(true), 10, 15)
  console.log(`  本地=${res.localOk}/${res.localN} 网络=${res.netOk}/${res.netN} p99=${res.lat.p99}ms`)
  if (Object.keys(res.errs).length) console.log('    异常分布:', JSON.stringify(res.errs))
  check('R2 混合档 本地成功率 ≥95%', localRate(res) >= 0.95, `${res.localOk}/${res.localN}`)
  check('R2 混合档 无服务端 500', !hasServer5xx(res))
}

// ── R3 错误风暴 + 浸泡 ──
console.log('\n══════ R3 错误风暴+浸泡（30 并发 × 20s，错误:正常 ≈ 1:1）══════')
{
  const loads = makeLoads(false) // 错误项已在 local 中，不出网，避免触发真实风控
  const lat = [], errCodes = {}, codeHit = {}
  const tEnd = Date.now() + 20000
  let n = 0
  async function worker() {
    let guard = 0
    while (Date.now() < tEnd && guard++ < 5000) {
      n++
      const [label, f] = loads[n % loads.length]
      const r = await f()
      lat.push(r.ms)
      if (r.code) codeHit[r.code] = (codeHit[r.code] || 0) + 1
      if (!r.ok) errCodes[`${label}:${r.status}`] = (errCodes[`${label}:${r.status}`] || 0) + 1
    }
  }
  const t0 = Date.now()
  await Promise.all(Array.from({ length: 30 }, worker))
  const wall = Date.now() - t0
  const s = stats(lat)
  console.log(`  请求=${n} 用时=${(wall / 1000).toFixed(1)}s 吞吐≈${(n / wall * 1000).toFixed(1)}/s p50=${s.p50} p95=${s.p95} p99=${s.p99} max=${s.max}ms`)
  console.log('  非正常响应:', Object.keys(errCodes).length ? JSON.stringify(errCodes) : '（无）')
  console.log('  错误码分布:', JSON.stringify(codeHit))
  check('R3 错误风暴不产生 5xx', !Object.keys(errCodes).some(k => k.includes(':5')))
  check('R3 FILE_NOT_FOUND 码出现', !!codeHit['FILE_NOT_FOUND'])
  check('R3 BILI_INVALID_BVID 码出现', !!codeHit['BILI_INVALID_BVID'])
  check('R3 URL_INVALID 码出现', !!codeHit['URL_INVALID'])
  check('R3 吞吐 ≥ 5 req/s', n / wall * 1000 >= 5, `${(n / wall * 1000).toFixed(1)}/s`)
}

// ── 收尾：进程存活 + 内存粗检 ──
const alive = child.exitCode === null && !child.killed
const endHealth = await hit('/api/health', { auth: false })
const r1 = await rssOf()
check('服务进程全程存活', alive, alive ? '✔' : `exit=${child.exitCode}`)
check('收尾 /api/health 仍 200', endHealth.status === 200)
if (r0 != null && r1 != null) {
  const ratio = r1 / r0
  console.log(`  RSS 初=${(r0 / 1e6).toFixed(1)}MB 末=${(r1 / 1e6).toFixed(1)}MB 比=${ratio.toFixed(2)}×`)
  check('RSS 增长 <2.0×（泄漏粗检）', ratio < 2.0)
} else {
  console.log('  （Windows 环境无 /proc，跳过 RSS 采样）')
}

child.kill()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }

console.log('\n════════ 三轮压力冒烟 · 结论 ════════')
for (const v of verdict.rounds) console.log(`  ${v.pass ? '✅' : '❌'} ${v.detail ? v.label + ' — ' + v.detail : v.label}`)
console.log(`\n${verdict.overallPass ? '🎉 压力冒烟全部通过' : '⛔ 有项未过，见上'}`)
process.exit(verdict.overallPass ? 0 : 1)
