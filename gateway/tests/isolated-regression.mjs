import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { randomBytes, scryptSync } from 'node:crypto'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'standalone-isolated-'))
const fixture = join(output, 'fixture')
mkdirSync(fixture)
symlinkSync(join(root, 'tools'), join(fixture, 'tools'), 'junction')
mkdirSync(join(fixture, 'tests'))
symlinkSync(join(root, 'tests', 'fixtures'), join(fixture, 'tests', 'fixtures'), 'junction')
const baseline = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|APPDATA|LOCALAPPDATA|USERPROFILE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)))
const password = randomBytes(24).toString('hex')
const salt = randomBytes(16).toString('hex')
const env = {
  ...baseline,
  TEMP: output, TMP: output, TMPDIR: output,
  NODE_ENV: 'test', SCHEDULER_ENABLED: '0', REPLY_LOOP: '0',
  BILI_HUMANISM_HOST: '127.0.0.1',
  BILI_HUMANISM_DATA: fixture, BILI_HUMANISM_LEGACY: join(fixture, 'legacy'),
  BILI_CREDENTIAL: join(fixture, 'bili_credential.json'),
  PLUGINS_FILE: join(fixture, 'plugins.json'), SERVICE_ENV: join(fixture, 'service.env'),
  SESSION_SECRET: randomBytes(32).toString('hex'), AUTH_USER: 'test-user', AUTH_SALT: salt,
  AUTH_HASH: scryptSync(password, salt, 64).toString('hex'),
  BROWSER_ALLOW_EVAL: 'true', NO_COLOR: '1'
}
for (const name of ['SETTINGS', 'SCHEDULE', 'MODELS', 'NODES', 'VISION', 'MCP']) env[`BILI_HUMANISM_${name}`] = join(fixture, `${name.toLowerCase()}.json`)
writeFileSync(env.BILI_CREDENTIAL, '{}')
writeFileSync(env.PLUGINS_FILE, JSON.stringify({ xhs: { cookie: '', enabled: false } }))
writeFileSync(env.SERVICE_ENV, '')
writeFileSync(join(fixture, 'config.json'), '{}')
// main.mjs 与工具扫描仍依赖 cwd；仅映射源码目录，不复制运行配置。
const preload = join(output, 'isolation.cjs')
writeFileSync(preload, `
const path = require('node:path');
const root = ${JSON.stringify(root)};
const loopback = value => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(String(value));
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!loopback(u.hostname)) throw new Error('隔离回归禁止外部网络');
  return originalFetch(input, ...args);
};
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === 'object' ? options.host || options.hostname : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (host && !loopback(host)) throw new Error('隔离回归禁止外部连接');
  return connect.apply(this, args);
};
const cp = require('node:child_process');
const spawn = cp.spawn;
cp.spawn = function (command, args, options) {
  if (Array.isArray(args) && args[0] === 'main.mjs') args = [path.join(root, 'main.mjs'), ...args.slice(1)];
  return spawn.call(this, command, args, options);
};
require('node:module').syncBuiltinESMExports();
`)
env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`
const groups = [
  ['gateway', 'gateway/tests/gateway.test.mjs'],
  ['auth', 'gateway/tests/auth.test.mjs'],
  ['routes', 'gateway/tests/routes.test.mjs'],
  ['integrations', 'tests/integrations.test.mjs'],
  ['integration', 'tests/integration.mjs'],
  ['persona-schedule', 'tests/persona-schedule.test.mjs'],
  ['model-routing', 'tests/model-routing.test.mjs'],
  ['tool-loop', 'tests/tool-loop.test.mjs'],
  ['secrets', 'tests/secrets.test.mjs'],
  ['redaction', 'gateway/tests/redaction.test.mjs'],
  ['contracts', 'gateway/tests/contracts.test.mjs']
]
const selected = process.argv.slice(2)
const results = []
console.log(`隔离输出目录：${output}`)
for (const [name, file] of groups) {
  if (selected.length && !selected.includes(name)) continue
  const log = join(output, `${name}.log`)
  const fd = openSync(log, 'w', 0o600)
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(root, file)], {
    cwd: fixture,
    env, stdio: ['ignore', fd, fd], timeout: 90000, windowsHide: true
  })
  closeSync(fd)
  const text = readFileSync(log, 'utf8')
  const custom = [...text.matchAll(/总计:\s*(\d+)\s*\|\s*通过:\s*(\d+)\s*\|\s*失败:\s*(\d+)/g)]
  const tool = text.match(/结果：通过\s+(\d+)\s*\/\s*失败\s+(\d+)/)
  const native = field => Number(text.match(new RegExp('(?:^|\\n)# ' + field + '\\s+(\\d+)'))?.[1] || 0)
  let passed = custom.reduce((n, m) => n + Number(m[2]), 0)
  let failed = custom.reduce((n, m) => n + Number(m[3]), 0)
  if (tool) { passed = Number(tool[1]); failed = Number(tool[2]) }
  if (!custom.length && !tool) { passed = native('pass'); failed = native('fail') }
  const infrastructureFailure = Boolean(result.error || result.status !== 0) && failed === 0
  const item = { name, passed, failed, infrastructureFailure, exit: result.status }
  results.push(item)
  console.log(`${name}：通过 ${passed}，失败 ${failed}${infrastructureFailure ? '，执行异常' : ''}`)
  if (failed || infrastructureFailure) {
    // 只报告源码中固定的用例名称；原始断言和值只留在隔离日志。
    const source = readFileSync(join(root, file), 'utf8')
    for (const line of text.split('\n')) {
      const nameMatch = line.match(/(?:not ok \d+ - |\u274c\s*)(.+)/)
      if (nameMatch && source.includes(nameMatch[1].trim())) console.log(`失败断言：${nameMatch[1].trim()}`)
    }
  }
}
const summary = { results, passed: results.reduce((n, r) => n + r.passed, 0), failed: results.reduce((n, r) => n + r.failed, 0) }
writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 })
console.log(`合计：通过 ${summary.passed}，失败 ${summary.failed}`)
process.exitCode = summary.failed || results.some(r => r.infrastructureFailure) ? 1 : 0
