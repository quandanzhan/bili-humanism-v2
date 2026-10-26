#!/usr/bin/env node
// Reports locations/categories only; never matching source, command stderr or secret values.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const root = path.resolve(args.find(x => !x.startsWith('--')) || fileURLToPath(new URL('../', import.meta.url)))
const includePrivate = args.includes('--include-private')
const skip = new Set(['node_modules', '.git', '.workbuddy', '__pycache__', '.venv', 'venv', 'coverage'])
const privateDirs = new Set(['.tmp', 'data', 'legacy', 'private', 'outputs', 'dist'])
const binaryExtensions = /\.(?:zip|gz|tar|7z|rar|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|mp[34]|wav|pdf|exe|dll|bin|pt|pth|safetensors|onnx|p12|pfx)$/i
const findings = [], errors = [], excluded = { directories: 0, binaryFiles: 0, oversizedFiles: 0, symlinks: 0 }
const maxSize = 4 * 1024 * 1024
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['provider-token', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/],
  ['jwt-literal', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/],
  ['encoded-basic-auth', /\bBasic\s+[A-Za-z0-9+/]{20,}={0,2}/],
  ['credential-url', /https?:\/\/[^\s/:'"`]+:[^\s/@'"`]+@/],
  ['private-mailbox', /[\w.%+-]+@(?:foxmail\.com|qq\.com|gmail\.com|163\.com)\b/i],
  ['personal-windows-path', /\b[A-Z]:[\\/]Users[\\/](?!Public\b|Default\b)[^\s'"`/\\]+/i],
  ['production-install-path', /\/(?:opt|root|www)\/(?:dsh-home|bili-humanism(?:-v2)?|vp-worker)\b/],
  ['provider-modelscope-token', /\bms-[a-f0-9]{8}-[a-f0-9-]{25,}\b/i]
]
const literal = /\b(?:apiKey|api_key|password|passwd|token|secret|SESSDATA|bili_jct|SMTP_PASSWORD|AUTH_HASH|AUTH_SALT|WORKER_TOKEN|SESSION_SECRET)['"]?\s*[:=]\s*['"]([^'"\r\n]{8,})['"]/gi
const synthetic = /^(?:synthetic|test[-_]|mock[-_]|dummy[-_]|fake[-_]|example|replace|your[-_ ]|redacted|<|\$\{|\*\*\*)/i
const privateFile = /(?:^|\/)(?:\.env(?:\.(?!example$|template$)[^/]+)?$|id_ed25519[^/]*$|id_rsa[^/]*$|data\/|legacy\/|private\/|\.tmp\/)|\.(?:pem|p12|pfx)$/i
// Tests contain intentional fixtures. Exempt ONLY explicitly labelled synthetic lines,
// not arbitrary files under tests; a real credential added to a test remains reportable.
function inspect(name, content, target = findings, object) {
  const fixture = /(?:^|\/)tests\//.test(name) || name === 'tests/security-audit.test.mjs'
  content.split(/\r?\n/).forEach((line, index) => {
    const categories = rules.filter(([, re]) => re.test(line)).map(([kind]) => kind)
    for (const match of line.matchAll(literal)) {
      if (!synthetic.test(match[1])) categories.push('credential-literal-review')
    }
    const envAssignment = /^\s*(?:export\s+)?(?:[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)|AUTH_HASH|AUTH_SALT|SESSDATA|BILI_JCT)\s*=\s*([^\s#'"][^#\r\n]*)/.exec(line)
    if (envAssignment && envAssignment[1].trim().length >= 8 && !synthetic.test(envAssignment[1].trim())) categories.push('unquoted-env-credential-review')
    for (const match of line.matchAll(/https?:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?=[:/\s'"`]|$)/g)) {
      if (!/^(?:127\.|0\.0\.0\.0$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|169\.254\.169\.254$)/.test(match[1])) categories.push('non-example-ip')
    }
    // Rule regex definitions aren't credential values. Do not exempt the whole scanner.
    const ruleDefinition = name === 'scripts/security-audit.mjs' && /^\s*\['[\w-]+', \/.*\],?$/.test(line)
    if (ruleDefinition || (fixture && /security-synthetic-fixture/.test(line))) return
    for (const category of new Set(categories)) target.push({ path: name, line: index + 1, category, ...(object ? { object } : {}) })
  })
}
function scanBuffer(name, buf, target = findings, object) {
  if (buf.includes(0)) { excluded.binaryFiles++; return }
  inspect(name, buf.toString('utf8'), target, object)
}
function walk(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { errors.push({ stage: 'read-directory', path: path.relative(root, dir) }); return }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name), rel = path.relative(root, abs).replaceAll('\\', '/')
    if (entry.isSymbolicLink()) { excluded.symlinks++; continue }
    if (entry.isDirectory()) {
      if (skip.has(entry.name) || (!includePrivate && privateDirs.has(entry.name))) { excluded.directories++; continue }
      walk(abs)
    } else if (entry.isFile()) {
      try {
        if (binaryExtensions.test(entry.name)) { excluded.binaryFiles++; continue }
        if (fs.statSync(abs).size > maxSize) { excluded.oversizedFiles++; continue }
        scanBuffer(rel, fs.readFileSync(abs))
      } catch { errors.push({ stage: 'read-file', path: rel }) }
    }
  }
}
walk(root)
const git = (...cmdArgs) => spawnSync('git', ['-C', root, ...cmdArgs], { encoding: null, maxBuffer: 128 * 1024 * 1024 })
const gitText = result => result.stdout?.toString('utf8') || ''
const available = git('rev-parse', '--show-toplevel')
const history = { available: available.status === 0, requested: args.includes('--history'), completed: false, commits: 0, objectsScanned: 0, findings: [] }
if (history.available) {
  const tracked = git('ls-files', '-z')
  if (tracked.status !== 0) errors.push({ stage: 'git-index-list' })
  else for (const name of gitText(tracked).split('\0').filter(Boolean)) {
    if (privateFile.test(name)) findings.push({ path: name, line: 0, category: 'tracked-private-file' })
    // Scan staged contents too, including deleted files and extensionless keys.
    const staged = git('show', `:${name}`)
    if (staged.status !== 0) { errors.push({ stage: 'git-index-read', path: name }); continue }
    if (staged.stdout.length > maxSize) { excluded.oversizedFiles++; continue }
    if (binaryExtensions.test(name)) { excluded.binaryFiles++; continue }
    scanBuffer(name, staged.stdout)
  }
  if (history.requested) {
    const log = git('rev-list', '--all'), objects = git('rev-list', '--objects', '--all')
    if (log.status !== 0 || objects.status !== 0) errors.push({ stage: 'git-history-list' })
    else {
      history.commits = gitText(log).trim().split('\n').filter(Boolean).length
      const seen = new Set()
      for (const entry of gitText(objects).split('\n')) {
        const first = entry.indexOf(' ')
        const oid = first < 0 ? entry.trim() : entry.slice(0, first)
        const name = first < 0 ? '(unnamed-object)' : entry.slice(first + 1)
        if (!oid || seen.has(oid)) continue
        seen.add(oid)
        const type = git('cat-file', '-t', oid)
        if (type.status !== 0) { errors.push({ stage: 'git-object-type', object: oid }); continue }
        if (gitText(type).trim() !== 'blob') continue
        if (privateFile.test(name)) history.findings.push({ path: name, line: 0, category: 'tracked-private-file', object: oid })
        const size = git('cat-file', '-s', oid)
        if (size.status !== 0) { errors.push({ stage: 'git-object-size', object: oid }); continue }
        if (Number(gitText(size)) > maxSize) { excluded.oversizedFiles++; continue }
        // Blob contents, rather than filename extension, decide text/binary.
        const blob = git('cat-file', 'blob', oid)
        if (blob.status !== 0) { errors.push({ stage: 'git-object-read', object: oid }); continue }
        scanBuffer(name, blob.stdout, history.findings, oid)
        history.objectsScanned++
      }
      history.completed = !errors.some(x => x.stage.startsWith('git-'))
    }
  }
}
const unique = [...new Map(findings.map(f => [JSON.stringify(f), f])).values()]
console.log(JSON.stringify({ root: '.', scope: { includePrivate, stagedIndex: history.available }, findings: unique, history, errors, excluded, limitations: ['Heuristic scan; manual review required. Findings never include matching values.', 'Binary files, archives, files over 4 MiB and symlinks are not inspected; review excluded counts.', 'Dependencies and tooling metadata are excluded; runtime/private directories require --include-private.', 'Git history covers reachable objects only, not remote refs absent locally, reflogs, LFS payloads or hosting caches.', 'No history is rewritten. Missing Git metadata prevents a tracked-file/history conclusion.'] }, null, 2))
process.exitCode = errors.length || (history.requested && !history.available) ? 2 : unique.length || history.findings.length ? 1 : 0
