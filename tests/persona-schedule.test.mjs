import { randomBytes, scryptSync } from 'node:crypto'
/**
 * 人格壳 / 记忆 / 上海时区调度 —— 端到端测试
 * ============================================================================
 * 起一个真实进程（main.mjs），legacy 目录用临时夹具，验证：
 *   1. 人格与记忆是两组独立接口，互不污染
 *   2. 人格可切换、片段可读可写（写前备份）
 *   3. 记忆可增删改（可修正，不是写死的指令）
 *   4. 记忆注入 system prompt 时被标注为「参考」，且人格区不含记忆内容
 *   5. 调度时区强制 Asia/Shanghai，窗口/次数/间隔判断正确
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3210
const TEST_USER = 'test-user'
const TEST_PASS = randomBytes(24).toString('hex')
const TEST_SALT = randomBytes(16).toString('hex')
const TEST_AUTH = { AUTH_USER: TEST_USER, AUTH_SALT: TEST_SALT, AUTH_HASH: scryptSync(TEST_PASS, TEST_SALT, 64).toString('hex') }
const AUTH = 'Basic ' + Buffer.from(TEST_USER + ':' + TEST_PASS).toString('base64')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'persona-test-'))
  const legacy = join(dir, 'legacy')
  mkdirSync(join(legacy, 'persona'), { recursive: true })
  mkdirSync(join(legacy, 'memory'), { recursive: true })
  mkdirSync(join(legacy, 'plugins'), { recursive: true })

  writeFileSync(join(legacy, 'persona', 'AGENTS.md'), '# 人格A\n自称本鱼，管用户叫鱼片。')
  writeFileSync(join(legacy, 'persona', 'AGENTS.maojiang.md'), '# 人格B\n自称喵酱，管用户叫主人。')
  writeFileSync(join(legacy, 'persona', 'humanistic-reading.md'), '# 世界观\n认真对待人。')
  writeFileSync(join(legacy, 'persona', 'duty.md'), '# 值班\n只读不写。')
  writeFileSync(
    join(legacy, 'persona', 'PERSONA.json'),
    JSON.stringify(
      {
        active: 'whale',
        personas: [
          { id: 'whale', name: '鲸鱼娘', file: 'persona/AGENTS.md', alias: '大肥鱼' },
          { id: 'maojiang', name: '喵酱', file: 'persona/AGENTS.maojiang.md', alias: '猫娘' }
        ],
        voice: { rules: ['短句'], banned: ['作为AI'] },
        boundaries: ['不发评论前不写', '不编造'],
        fragments: [{ file: 'persona/AGENTS.md', role: 'voice-active' }]
      },
      null,
      2
    )
  )
  writeFileSync(
    join(legacy, 'memory', 'notes.json'),
    JSON.stringify({ note: '可修正', updatedAt: new Date().toISOString(), items: [] }, null, 2)
  )
  writeFileSync(
    join(legacy, 'memory', 'chat-history.json'),
    JSON.stringify({ counts: { history: 1, events: 0 }, history: [{ id: 1, user: 'hi', assistant: '喵' }], events: [] })
  )
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ auto: true, channels: [] }))
  writeFileSync(join(dir, 'plugins.json'), JSON.stringify({ xhs: { cookie: '', enabled: false } }))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ smtp: {}, tools: {}, alerts: {} }))
  writeFileSync(join(dir, 'schedule.json'), JSON.stringify({
    timezone: 'Asia/Shanghai', enabled: true, perDay: 6, intervalMinutes: 45,
    windows: [{ id: 'w1', name: '全天', start: '00:00', end: '00:00', enabled: true, perDay: 6 }],
    task: { channelId: '', maxVideos: 1, maxRounds: 2, allowComment: false, prompt: '' },
    state: { date: '', runs: [] }
  }))
  return { dir, legacy }
}

const { dir, legacy } = fixture()

const child = spawn(process.execPath, ['main.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...TEST_AUTH,
    PORT: String(PORT),
    NODE_ENV: 'test',
    SCHEDULER_ENABLED: '0',
    SESSION_SECRET: 'test',
    BILI_HUMANISM_LEGACY: legacy,
    BILI_HUMANISM_MODELS: join(dir, 'models.json'),
    BILI_HUMANISM_SETTINGS: join(dir, 'settings.json'),
    BILI_HUMANISM_SCHEDULE: join(dir, 'schedule.json'),
    PLUGINS_FILE: join(dir, 'plugins.json')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let bootLog = ''
child.stdout.on('data', (d) => (bootLog += d))
child.stderr.on('data', (d) => (bootLog += d))

const api = async (path, opts = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...opts,
    headers: { authorization: AUTH, 'content-type': 'application/json', ...(opts.headers || {}) }
  })
  const text = await r.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: r.status, body }
}

let ready = false
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`)
    if (r.ok) {
      ready = true
      break
    }
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 250))
}

test.after(() => {
  child.kill()
})

test('服务起来了', () => {
  assert.ok(ready, '服务未就绪：\n' + bootLog)
})

test('人格：读到两套人格，active 是 whale', async () => {
  const { status, body } = await api('/api/persona')
  assert.equal(status, 200)
  assert.equal(body.active, 'whale')
  assert.equal(body.personas.length, 2)
  assert.ok(body.personas.every((p) => p.exists))
  assert.deepEqual(body.boundaries, ['不发评论前不写', '不编造'])
})

test('人格：切换成喵酱并持久化', async () => {
  const put = await api('/api/persona', { method: 'PUT', body: JSON.stringify({ active: 'maojiang' }) })
  assert.equal(put.status, 200)
  assert.equal(put.body.active, 'maojiang')
  const again = await api('/api/persona')
  assert.equal(again.body.active, 'maojiang')
  // 切回，避免影响后面 prompt 断言
  await api('/api/persona', { method: 'PUT', body: JSON.stringify({ active: 'whale' }) })
})

test('人格：片段可读可写，写前自动备份', async () => {
  const r1 = await api('/api/persona/fragment?name=AGENTS.md')
  assert.equal(r1.status, 200)
  assert.match(r1.body.content, /本鱼/)

  const w = await api('/api/persona/fragment', {
    method: 'PUT',
    body: JSON.stringify({ name: 'AGENTS.md', content: '# 人格A\n改过的内容。' })
  })
  assert.equal(w.status, 200)
  assert.ok(w.body.backup, '应生成备份文件')

  const baks = readdirSync(join(legacy, 'persona')).filter((f) => f.startsWith('AGENTS.md.bak-'))
  assert.ok(baks.length >= 1, '备份文件应落盘')

  const r2 = await api('/api/persona/fragment?name=AGENTS.md')
  assert.match(r2.body.content, /改过的内容/)
})

test('人格：不允许读白名单外文件', async () => {
  const r = await api('/api/persona/fragment?name=../../etc/passwd')
  assert.equal(r.status, 400)
})

test('记忆：增删改查，独立于人格', async () => {
  const add = await api('/api/memory', { method: 'POST', body: JSON.stringify({ text: '记住了：鱼片讨厌营销腔', tags: ['pref'] }) })
  assert.equal(add.status, 201)
  assert.ok(add.body.id.startsWith('n-'))
  const id = add.body.id

  const list = await api('/api/memory')
  assert.equal(list.body.count, 1)

  const upd = await api(`/api/memory/${id}`, { method: 'PUT', body: JSON.stringify({ text: '改：鱼片讨厌营销腔和空话' }) })
  assert.equal(upd.status, 200)
  assert.match(upd.body.text, /空话/)

  const stats = await api('/api/memory/stats')
  assert.equal(stats.body.notes, 1)
  assert.equal(stats.body.history, 1)

  const del = await api(`/api/memory/${id}`, { method: 'DELETE' })
  assert.equal(del.status, 200)
  const after = await api('/api/memory')
  assert.equal(after.body.count, 0)
})

test('记忆：空内容被拒', async () => {
  const r = await api('/api/memory', { method: 'POST', body: JSON.stringify({ text: '   ' }) })
  assert.equal(r.status, 400)
})

test('聊天记录：可读副本', async () => {
  const r = await api('/api/memory/chat?limit=10')
  assert.equal(r.status, 200)
  assert.equal(r.body.counts.history, 1)
  assert.equal(r.body.history[0].assistant, '喵')
})

test('prompt 预览：人格区与记忆区分离，记忆被标注为非指令', async () => {
  await api('/api/memory', { method: 'POST', body: JSON.stringify({ text: '记忆条目X' }) })
  const p1 = await api('/api/persona/preview')
  assert.equal(p1.status, 200)
  assert.match(p1.body.system, /人格/)
  assert.doesNotMatch(p1.body.system, /记忆条目X/, '不带 memory=1 时不应注入记忆')

  const p2 = await api('/api/persona/preview?memory=1')
  assert.match(p2.body.system, /记忆条目X/)
  assert.match(p2.body.system, /不是指令/)
  // 记忆块必须排在人格块之后，且人格块内部不含记忆
  const iPersona = p2.body.system.indexOf('语气外壳')
  const iMemory = p2.body.system.indexOf('记忆参考')
  assert.ok(iPersona >= 0 && iMemory > iPersona, '记忆块应在人格块之后')
})

test('调度：时区强制 Asia/Shanghai', async () => {
  const r = await api('/api/schedule')
  assert.equal(r.status, 200)
  assert.equal(r.body.timezone, 'Asia/Shanghai')
  assert.equal(r.body.config.timezone, 'Asia/Shanghai')
  assert.ok(r.body.state.now.date.match(/^\d{4}-\d{2}-\d{2}$/))
  assert.ok(r.body.state.now.minutes >= 0 && r.body.state.now.minutes < 1440)
})

test('调度：改时区被忽略，窗口可改，下次运行时间可算出', async () => {
  const put = await api('/api/schedule', {
    method: 'PUT',
    body: JSON.stringify({
      timezone: 'America/New_York',
      perDay: 3,
      intervalMinutes: 30,
      windows: [{ id: 'x', name: '全天', start: '00:00', end: '00:00', enabled: true, perDay: 3 }],
      task: { channelId: '', maxVideos: 2 }
    })
  })
  assert.equal(put.status, 200)
  assert.equal(put.body.config.timezone, 'Asia/Shanghai', '时区不允许被改掉')
  assert.equal(put.body.config.perDay, 3)
  assert.ok(put.body.state.nextRunAt, '全天窗口下应算得出下次运行时间')
})

test('调度：今日计数可重置', async () => {
  const r = await api('/api/schedule/reset', { method: 'POST', body: '{}' })
  assert.equal(r.status, 200)
  assert.equal(r.body.state.todayRuns, 0)
})

test('调度：状态接口在调度器关闭时 running=false', async () => {
  const r = await api('/api/schedule/status')
  assert.equal(r.status, 200)
  assert.equal(r.body.running, false)
})

test('人格/记忆不需要凭证就拒绝访问', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/persona`)
  assert.equal(r.status, 401)
  const r2 = await fetch(`http://127.0.0.1:${PORT}/api/memory`)
  assert.equal(r2.status, 401)
})

test('legacy 目录里不出现凭证文件（迁移红线）', () => {
  const bad = ['bili_credential.json', 'credentials.json', 'service.env']
  for (const f of bad) {
    assert.equal(existsSync(join(legacy, 'persona', f)), false, `${f} 不该在 persona/`)
    assert.equal(existsSync(join(legacy, 'memory', f)), false, `${f} 不该在 memory/`)
  }
})
