import { randomBytes, scryptSync } from 'node:crypto'
/**
 * 新功能冒烟：设置 / 工具开关 / B站扫码登录
 * 起一个真实 main.mjs 子进程（随机端口），用 fetch 打真实 HTTP。
 * 注意：二维码接口会真实出网调 B 站 passport。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'v2-smoke-'))
const settingsFile = join(dir, 'settings.json')
const modelsFile = join(dir, 'models.json')
const pluginsFile = join(dir, 'plugins.json')
writeFileSync(modelsFile, JSON.stringify({ auto: true, channels: [] }))
writeFileSync(pluginsFile, JSON.stringify({ xhs: { cookie: '', enabled: false } }))

const PORT = 20000 + Math.floor(Math.random() * 20000)
const TEST_USER = 'test-user'
const TEST_PASS = randomBytes(24).toString('hex')
const TEST_SALT = randomBytes(16).toString('hex')
const TEST_AUTH = { AUTH_USER: TEST_USER, AUTH_SALT: TEST_SALT, AUTH_HASH: scryptSync(TEST_PASS, TEST_SALT, 64).toString('hex') }
const AUTH = 'Basic ' + Buffer.from(TEST_USER + ':' + TEST_PASS).toString('base64')

const child = spawn(process.execPath, ['main.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...TEST_AUTH,
    PORT: String(PORT),
    BILI_HUMANISM_SETTINGS: settingsFile,
    BILI_HUMANISM_MODELS: modelsFile,
    PLUGINS_FILE: pluginsFile,
    SESSION_SECRET: 'synthetic-smoke-session-secret',
    NODE_ENV: 'test'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
child.stdout.on('data', (d) => (log += d))
child.stderr.on('data', (d) => (log += d))

const base = `http://127.0.0.1:${PORT}`
let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`✅ ${name}`) } else { fail++; console.error(`❌ ${name} ${extra}`) }
}

async function req(path, opts = {}) {
  const r = await fetch(base + path, {
    ...opts,
    headers: { Authorization: AUTH, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) }
  })
  let j = null
  const t = await r.text()
  try { j = JSON.parse(t) } catch { j = { raw: t } }
  return { status: r.status, body: j }
}

// 等启动
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(base + '/api/health')
    if (r.ok) break
  } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 300))
}

console.log('=== 新功能冒烟 ===')

// 1. 健康
const h = await req('/api/health')
ok('health 200', h.status === 200, JSON.stringify(h.body))
ok('工具已加载', (h.body.tools?.total || 0) >= 7, JSON.stringify(h.body.tools))

// 2. 设置读取
const st = await req('/api/settings/smtp')
ok('GET /api/settings/smtp 200', st.status === 200, JSON.stringify(st.body))
ok('SMTP 默认未配置', st.body.status?.configured === false, JSON.stringify(st.body.status))
ok('设置文件已生成', st.body.status?.nodemailer === true, 'nodemailer 应可用')

// 3. SMTP 保存 + 密码打码
const put = await req('/api/settings/smtp', {
  method: 'PUT',
  body: JSON.stringify({ enabled: true, host: 'smtp.example.com', port: 465, security: 'ssl', user: 'test@example.com', pass: 'secret123', from: 'test@example.com', to: 'test@example.com' })
})
ok('PUT smtp 200', put.status === 200, JSON.stringify(put.body))
ok('返回里密码打码', put.body.smtp?.hasPassword === true && !JSON.stringify(put.body).includes('secret123'))
const put2 = await req('/api/settings/smtp', { method: 'PUT', body: JSON.stringify({ pass: '***' }) })
ok('传 *** 不改密码', put2.body.smtp?.hasPassword === true)

// 4. 工具开关
const off = await req('/api/tools/bili_video/enabled', { method: 'PUT', body: JSON.stringify({ enabled: false }) })
ok('关闭 bili_video 200', off.status === 200 && off.body.enabled === false, JSON.stringify(off.body))
const list = await req('/api/tools')
const bv = list.body.tools.find((t) => t.name === 'bili_video')
ok('列表里 enabled=false', bv && bv.enabled === false, JSON.stringify(bv))
const callOff = await req('/api/tools/bili_video', { method: 'POST', body: JSON.stringify({ args: { bvid: 'BV1GJ411x7h7' } }) })
ok('关闭后调用 → 403 TOOL_DISABLED', callOff.status === 403 && callOff.body.code === 'TOOL_DISABLED', JSON.stringify(callOff.body))
const back = await req('/api/tools/bili_video/enabled', { method: 'PUT', body: JSON.stringify({ enabled: true }) })
ok('重新启用 200', back.status === 200 && back.body.enabled === true)

// 5. 小红书 cookie 读写
const x1 = await req('/api/account/xhs')
ok('GET xhs 200', x1.status === 200, JSON.stringify(x1.body))
const x2 = await req('/api/account/xhs', { method: 'PUT', body: JSON.stringify({ cookie: 'a1=1; web_session=abcdef', enabled: true }) })
ok('PUT xhs 200 且不回落原文', x2.status === 200 && x2.body.hasCookie === true, JSON.stringify(x2.body))
const x3 = await req('/api/account/xhs')
ok('xhs 打码展示', String(x3.body.cookieMasked || '').includes('…') && !String(x3.body.cookieMasked).includes('abcdef'), JSON.stringify(x3.body))

// 6. B 站账号状态（真实出网）
const acc = await req('/api/account/bili/status')
ok('GET bili/status 200', acc.status === 200, JSON.stringify(acc.body))
console.log('   → 当前登录状态:', acc.body.loggedIn ? `已登录 ${acc.body.uname}` : `未登录（${acc.body.reason}）`)

// 7. 二维码生成（真实出网）
const qr = await req('/api/account/bili/qrcode', { method: 'POST' })
ok('生成二维码 200', qr.status === 200 && Boolean(qr.body.key), JSON.stringify(qr.body).slice(0, 200))
ok('二维码图片是 dataURL', String(qr.body.image || '').startsWith('data:image/png;base64,'), `image 前缀=${String(qr.body.image || '').slice(0, 30)}`)
if (qr.body.key) {
  const poll = await req('/api/account/bili/qrcode/poll?key=' + encodeURIComponent(qr.body.key))
  ok('轮询返回合法状态', ['waiting', 'scanned', 'expired', 'confirmed'].includes(poll.body.state), JSON.stringify(poll.body))
  console.log('   → 轮询状态:', poll.body.state)
}

// 8. 未认证
const noAuth = await fetch(base + '/api/settings/smtp')
ok('未认证 401', noAuth.status === 401)

console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`)
if (fail) console.log('\n--- 服务日志尾部 ---\n' + log.split('\n').slice(-25).join('\n'))
child.kill()
rmSync(dir, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
