import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scanner = fileURLToPath(new URL('../scripts/security-audit.mjs', import.meta.url))
const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
const providerToken = ['sk', '-', 'A1b2C3d4'.repeat(4)].join('')
const literalSecret = ['fixture', 'Credential', 'Value', '123456'].join('')
const fixtureSecrets = [privateKey, providerToken, literalSecret]

function sandbox(t, repository = true) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'security-audit-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'repo')
  fs.mkdirSync(root)
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(?:GIT_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) delete env[key]
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(base, 'absent-gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Synthetic Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Synthetic Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com'
  })
  function git(...args) {
    const result = spawnSync('git', ['-C', root, ...args], {
      env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    assert.ok(!result.error && result.status === 0, '临时仓库 Git 命令必须成功（不输出命令内容）')
    return result.stdout
  }
  function write(name, content) {
    const target = path.join(root, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  function scan(args = [], overrides = {}) {
    const result = spawnSync(process.execPath, [scanner, root, ...args], {
      cwd: base, env: { ...env, ...overrides }, encoding: 'utf8',
      timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    assert.ok(!result.error && result.signal === null, '扫描子进程必须正常结束')
    const output = `${result.stdout || ''}${result.stderr || ''}`
    for (const secret of fixtureSecrets) {
      assert.ok(!output.includes(secret), '扫描输出不得包含合成凭据原值')
    }
    assert.ok(result.stderr === '', '扫描不得回显 Git 或运行时错误内容')
    let report
    try { report = JSON.parse(result.stdout) } catch { assert.fail('扫描必须返回合法 JSON（不回显原始输出）') }
    for (const finding of [...report.findings, ...report.history.findings]) {
      const fields = finding.object ? ['category', 'line', 'object', 'path'] : ['category', 'line', 'path']
      assert.deepEqual(Object.keys(finding).sort(), fields, '命中只能包含位置、类别和历史对象标识')
      assert.ok(typeof finding.path === 'string' && Number.isInteger(finding.line))
    }
    return { status: result.status, report }
  }
  if (repository) git('init', '--quiet', '--template=')
  return { root, git, write, scan }
}

function hit(findings, name, category, line) {
  assert.ok(findings.some(f => f.path === name && f.category === category && (line === undefined || f.line === line)),
    `必须报告 ${name} 的 ${category} 位置`)
}

function snapshot(dir) {
  const files = []
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) walk(target)
      else files.push([path.relative(dir, target), createHash('sha256').update(fs.readFileSync(target)).digest('hex')])
    }
  }
  walk(dir)
  return files
}

test('未知扩展和无扩展文本私钥都必须命中', t => {
  const { write, scan } = sandbox(t)
  for (const name of ['material.unusual', 'material']) write(name, `${privateKey}\n合成内容\n`)
  const { status, report } = scan()
  assert.equal(status, 1)
  for (const name of ['material.unusual', 'material']) hit(report.findings, name, 'private-key', 1)
})

test('未跟踪 .env 的凭据内容仍须检查', t => {
  const { write, scan } = sandbox(t)
  write('.env', `SESSION_SECRET="${literalSecret}"\n`)
  const { status, report } = scan()
  assert.equal(status, 1)
  hit(report.findings, '.env', 'credential-literal-review', 1)
})

test('无引号的环境凭据不得漏报', t => {
  const { write, scan } = sandbox(t)
  write('.env', `SESSION_SECRET=${literalSecret}\nMODEL_API_KEY=${literalSecret}\nWORKER_TOKEN=${literalSecret}\n`)
  const { status, report } = scan()
  assert.equal(status, 1)
  for (const line of [1, 2, 3]) hit(report.findings, '.env', 'unquoted-env-credential-review', line)
})

test('索引中的 .env 和私钥文件名须复核，模板不误报', t => {
  const { git, write, scan } = sandbox(t)
  for (const name of ['.env', '.env.local', 'id_ed25519', 'material.pem', '.env.example', '.env.template']) write(name, 'MODE=synthetic\n')
  git('add', '.')
  const { status, report } = scan()
  assert.equal(status, 1)
  for (const name of ['.env', '.env.local', 'id_ed25519', 'material.pem']) hit(report.findings, name, 'tracked-private-file', 0)
  assert.ok(!report.findings.some(f => ['.env.example', '.env.template'].includes(f.path)), '模板不得仅因文件名误报')
})

test('tests 目录中真实模式的合成 token 和普通凭据不得整目录豁免', t => {
  const { write, scan } = sandbox(t)
  write('tests/nested/credential.test.mjs', `const value = '${providerToken}'\nconst password = '${literalSecret}'\n`)
  const { status, report } = scan()
  assert.equal(status, 1)
  hit(report.findings, 'tests/nested/credential.test.mjs', 'provider-token', 1)
  hit(report.findings, 'tests/nested/credential.test.mjs', 'credential-literal-review', 2)
})

test('synthetic fixture 仅豁免测试文件明确标记的单行', t => {
  const { write, scan } = sandbox(t)
  const marker = ['security', 'synthetic', 'fixture'].join('-')
  write('tests/fixture.test.mjs', `const first = '${providerToken}' // ${marker}\nconst second = '${providerToken}'\n`)
  write('src/fixture.mjs', `const first = '${providerToken}' // ${marker}\n`)
  const { status, report } = scan()
  assert.equal(status, 1)
  assert.ok(!report.findings.some(f => f.path === 'tests/fixture.test.mjs' && f.line === 1))
  hit(report.findings, 'tests/fixture.test.mjs', 'provider-token', 2)
  hit(report.findings, 'src/fixture.mjs', 'provider-token', 1)
})

test('staged 文件从 worktree 删除后仍检查索引内容', t => {
  const { root, git, write, scan } = sandbox(t)
  write('staged-material', privateKey)
  write('tests/staged.test.mjs', `const value = '${providerToken}'\n`)
  git('add', '.')
  fs.unlinkSync(path.join(root, 'staged-material'))
  fs.unlinkSync(path.join(root, 'tests/staged.test.mjs'))
  const { status, report } = scan()
  assert.equal(status, 1)
  assert.equal(report.scope.stagedIndex, true)
  hit(report.findings, 'staged-material', 'private-key', 1)
  hit(report.findings, 'tests/staged.test.mjs', 'provider-token', 1)
})

test('staged 敏感内容被干净 worktree 覆盖后仍检查索引', t => {
  const { git, write, scan } = sandbox(t)
  write('indexed.mjs', `const token = '${literalSecret}'\n`)
  git('add', '.')
  write('indexed.mjs', 'export const clean = true\n')
  const { status, report } = scan()
  assert.equal(status, 1)
  hit(report.findings, 'indexed.mjs', 'credential-literal-review', 1)
})

test('历史已删除的 .env 与未知扩展私钥仍报告且不重写历史', t => {
  const { root, git, write, scan } = sandbox(t)
  write('.env', `SESSION_SECRET="${literalSecret}"\n`)
  write('archived-material.unusual', `${privateKey}\n合成未知扩展夹具\n`)
  write('archived-material', `${privateKey}\n合成无扩展夹具\n`)
  git('add', '.')
  git('commit', '--quiet', '-m', '加入合成夹具')
  git('rm', '--quiet', '.env', 'archived-material.unusual', 'archived-material')
  git('commit', '--quiet', '-m', '删除合成夹具')
  const before = snapshot(root)
  const withoutHistory = scan()
  assert.equal(withoutHistory.status, 0)
  const { status, report } = scan(['--history'])
  assert.equal(status, 1)
  assert.equal(report.history.completed, true)
  assert.equal(report.history.commits, 2)
  assert.equal(report.findings.length, 0)
  hit(report.history.findings, '.env', 'credential-literal-review', 1)
  for (const name of ['archived-material.unusual', 'archived-material']) hit(report.history.findings, name, 'private-key', 1)
  assert.ok(report.history.findings.every(f => /^[a-f0-9]{40,64}$/.test(f.object)), '历史命中须有对象位置')
  assert.deepEqual(snapshot(root), before, '扫描前后文件、refs、索引与对象必须完全不变')
})

test('历史已删除的 .env 即使值为占位符也报告敏感文件名', t => {
  const { git, write, scan } = sandbox(t)
  write('.env', 'MODE=synthetic\n')
  git('add', '.')
  git('commit', '--quiet', '-m', '加入合成环境文件')
  git('rm', '--quiet', '.env')
  git('commit', '--quiet', '-m', '删除合成环境文件')
  const { status, report } = scan(['--history'])
  assert.equal(status, 1)
  hit(report.history.findings, '.env', 'tracked-private-file', 0)
})

test('--history 在缺 Git 可执行程序时退出 2 且不回显错误详情', t => {
  const { scan } = sandbox(t)
  const { status, report } = scan(['--history'], { PATH: '', Path: '' })
  assert.equal(status, 2)
  assert.equal(report.history.available, false)
  assert.equal(report.history.requested, true)
  assert.equal(report.history.completed, false)
})

test('--history 在缺 Git 元数据时退出 2', t => {
  const { scan } = sandbox(t, false)
  const { status, report } = scan(['--history'])
  assert.equal(status, 2)
  assert.equal(report.history.available, false)
  assert.equal(report.history.completed, false)
})

test('--include-private 检查默认略过的私有目录', t => {
  const { write, scan } = sandbox(t)
  write('private/material', privateKey)
  assert.equal(scan().status, 0)
  const { status, report } = scan(['--include-private'])
  assert.equal(status, 1)
  hit(report.findings, 'private/material', 'private-key', 1)
})

test('干净仓库包括索引及历史检查全部通过', t => {
  const { git, write, scan } = sandbox(t)
  write('clean.mjs', 'export const clean = true\n')
  write('.env.example', 'MODE=synthetic\n')
  git('add', '.')
  git('commit', '--quiet', '-m', '干净合成仓库')
  const { status, report } = scan(['--history', '--include-private'])
  assert.equal(status, 0)
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.history.findings, [])
  assert.deepEqual(report.errors, [])
  assert.equal(report.scope.stagedIndex, true)
  assert.equal(report.history.completed, true)
  assert.equal(report.history.commits, 1)
})
