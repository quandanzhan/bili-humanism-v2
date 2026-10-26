/** 密钥加载与脱敏回归测试；仅使用系统临时目录中的合成夹具。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, renameSync, unlinkSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, scryptSync } from 'node:crypto'
import { format } from 'node:util'

const dir = mkdtempSync(join(tmpdir(), 'secrets-test-'))
const vars = ['BILI_CREDENTIAL', 'SERVICE_ENV', 'PLUGINS_FILE', 'SESSION_SECRET', 'SESSION_TTL_MS', 'AUTH_USER', 'AUTH_SALT', 'AUTH_HASH', 'AMD_API_KEY', 'DEEPSEEK_API_KEY', 'MODELSCOPE_API_KEY', 'BILI_SESSDATA', 'BILI_JCT', 'BILI_BUVID3', 'BILI_DEDEUSERID']
const previous = Object.fromEntries(vars.map(k => [k, process.env[k]]))
for (const k of vars) delete process.env[k]
process.env.BILI_CREDENTIAL = join(dir, 'bili.json')
process.env.SERVICE_ENV = join(dir, 'service.env')
process.env.PLUGINS_FILE = join(dir, 'plugins.json')
const { loadSecrets } = await import('../secrets/loader.mjs')
const { loadConfig } = await import('../config/loader.mjs')
const warnings = []
const originalWarn = console.warn
console.warn = (...args) => warnings.push(format(...args))

test.after(() => {
  console.warn = originalWarn
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(dir, { recursive: true, force: true })
})

test('缺少文件仍返回完整结构，缺少认证配置不能登录', async () => {
  const s = await loadSecrets()
  for (const key of ['bili', 'models', 'session', 'auth', 'plugins']) assert.equal(typeof s[key], 'object')
  assert.equal(s.bili.SESSDATA, '')
  assert.equal(s.plugins.xhs.enabled, false)
  assert.equal(s.auth.USER, '')
  assert.match(s.auth.SALT, /^[a-f0-9]{32}$/)
  assert.match(s.auth.HASH, /^[a-f0-9]{128}$/)
})

test('临时会话密钥在进程内稳定且不会写入日志', async () => {
  const a = await loadSecrets()
  const b = await loadSecrets()
  assert.match(a.session.SECRET, /^[a-f0-9]{64}$/)
  assert.ok(a.session.SECRET === b.session.SECRET, '临时密钥应在同一进程复用')
  assert.ok(!warnings.join('\n').includes(a.session.SECRET), '日志不得包含会话密钥')
  assert.ok(!warnings.join('\n').includes(dir), '日志不得包含配置绝对路径')
})

test('会话密钥与 TTL 可由环境变量覆盖且不写日志', async () => {
  const value = randomBytes(32).toString('hex')
  process.env.SESSION_SECRET = value
  process.env.SESSION_TTL_MS = '60000'
  const s = await loadSecrets()
  assert.ok(s.session.SECRET === value, '会话环境变量应生效')
  assert.equal(s.session.TTL_MS, 60000)
  assert.ok(!warnings.join('\n').includes(value), '日志不得包含配置会话密钥')
  delete process.env.SESSION_SECRET
  delete process.env.SESSION_TTL_MS
})

test('完整认证配置兼容网关 scrypt，部分配置保持禁用', async () => {
  const password = randomBytes(24).toString('hex')
  process.env.AUTH_USER = 'test-user'
  process.env.AUTH_SALT = randomBytes(16).toString('hex')
  process.env.AUTH_HASH = scryptSync(password, process.env.AUTH_SALT, 64).toString('hex')
  const s = await loadSecrets()
  assert.equal(s.auth.USER, 'test-user')
  assert.ok(scryptSync(password, s.auth.SALT, 64).toString('hex') === s.auth.HASH, '认证哈希应兼容网关')
  for (const missing of ['AUTH_USER', 'AUTH_SALT', 'AUTH_HASH']) {
    const saved = process.env[missing]
    delete process.env[missing]
    assert.equal((await loadSecrets()).auth.USER, '')
    process.env[missing] = saved
  }
  for (const key of ['AUTH_USER', 'AUTH_SALT', 'AUTH_HASH']) delete process.env[key]
})

test('B站兼容大小写字段、模型环境变量优先、插件配置可读', async () => {
  const cookie = randomBytes(18).toString('hex')
  writeFileSync(process.env.BILI_CREDENTIAL, JSON.stringify({ sessdata: cookie, bili_jct: 'test-csrf', buvid3: 'test-device', dedeuserid: '10001' }))
  writeFileSync(process.env.SERVICE_ENV, 'AMD_API_KEY=test-file-key\nDEEPSEEK_API_KEY=test-file-deepseek\n')
  writeFileSync(process.env.PLUGINS_FILE, JSON.stringify({ xhs: { cookie: 'test-cookie', enabled: true } }))
  process.env.AMD_API_KEY = 'test-env-key'
  const s = await loadSecrets()
  assert.ok(s.bili.SESSDATA === cookie, '应读取小写凭据字段')
  assert.equal(s.bili.DedeUserID, '10001')
  assert.equal(s.models.AMD_API_KEY, 'test-env-key')
  assert.equal(s.models.DEEPSEEK_API_KEY, 'test-file-deepseek')
  assert.equal(s.plugins.xhs.enabled, true)
  assert.ok(!warnings.join('\n').includes(cookie), '日志不得包含文件凭据')
})

test('解析错误不回显密钥内容', async () => {
  const marker = randomBytes(24).toString('hex')
  writeFileSync(process.env.BILI_CREDENTIAL, marker)
  assert.equal((await loadSecrets()).bili.SESSDATA, '')
  assert.ok(!warnings.join('\n').includes(marker), '解析错误不得回显文件内容')
})

test('集成凭据缓存随文件更新、替换、删除与环境覆盖刷新', async () => {
  const { hasLoginCookie } = await import('../integrations/bili-api.mjs')
  const file = process.env.BILI_CREDENTIAL
  writeFileSync(file, '{}')
  assert.equal(await hasLoginCookie(), false)
  writeFileSync(file, JSON.stringify({ sessdata: randomBytes(24).toString('hex') }))
  assert.equal(await hasLoginCookie(), true)
  const originalTime = statSync(file).mtime
  const replacement = file + '.replacement'
  writeFileSync(replacement, '{}')
  utimesSync(replacement, originalTime, originalTime)
  renameSync(replacement, file)
  assert.equal(await hasLoginCookie(), false)
  process.env.BILI_SESSDATA = randomBytes(24).toString('hex')
  assert.equal(await hasLoginCookie(), true)
  delete process.env.BILI_SESSDATA
  assert.equal(await hasLoginCookie(), false)
  writeFileSync(file, JSON.stringify({ sessdata: randomBytes(24).toString('hex') }))
  assert.equal(await hasLoginCookie(), true)
  unlinkSync(file)
  assert.equal(await hasLoginCookie(), false)
})

test('配置加载器解析错误不回显配置内容', async () => {
  const marker = randomBytes(24).toString('hex')
  const configFile = join(dir, 'invalid-config.json')
  writeFileSync(configFile, `{"value":"${marker}" invalid}`)
  await assert.rejects(loadConfig(configFile), error => {
    assert.equal(error.code, 'CONFIG_INVALID')
    assert.ok(!format(error).includes(marker), '错误对象不得包含配置内容')
    return true
  })
})
