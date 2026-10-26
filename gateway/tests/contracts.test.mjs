import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { format } from 'node:util'

const dir = mkdtempSync(join(tmpdir(), 'gateway-contracts-'))
process.env.BILI_HUMANISM_DATA = dir
process.env.BILI_CREDENTIAL = join(dir, 'bili_credential.json')
process.env.PLUGINS_FILE = join(dir, 'nested', 'plugins.json')
const secret = randomBytes(24).toString('hex')
const originalFetch = globalThis.fetch
const { createAccountRouter } = await import('../routes/account.mjs')
const router = createAccountRouter()
async function invoke(path, method, body = {}, query = {}) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method])
  let result
  const res = { status() { return this }, json(value) { result = value } }
  await layer.route.stack[0].handle({ body, query }, res, error => { throw error })
  return result
}
function defaultSecrets() {
  const env = { ...process.env, BILI_HUMANISM_DATA: dir }
  delete env.BILI_CREDENTIAL
  delete env.PLUGINS_FILE
  const loader = new URL('../../secrets/loader.mjs', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { loadSecrets } = await import(${JSON.stringify(loader)});
    const s = await loadSecrets();
    console.log(JSON.stringify({ bili: Boolean(s.bili.SESSDATA), plugins: s.plugins.xhs.enabled }));
  `], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, '隔离密钥加载子进程应成功')
  return JSON.parse(result.stdout.trim().split('\n').at(-1))
}
test.after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

test('默认凭据路径：账号文件可被 secrets loader 读取', () => {
  writeFileSync(join(dir, 'bili_credential.json'), JSON.stringify({ sessdata: secret }))
  assert.ok(defaultSecrets().bili, 'BILI_CREDENTIAL 未设置时应读取 DATA_DIR/bili_credential.json')
})
test('默认插件路径：账号文件可被 secrets loader 读取', () => {
  writeFileSync(join(dir, 'plugins.json'), JSON.stringify({ xhs: { cookie: secret, enabled: true } }))
  assert.ok(defaultSecrets().plugins, 'PLUGINS_FILE 未设置时应读取 DATA_DIR/plugins.json')
})
test('B站凭据更新后集成立即使用新登录态', async () => {
  const file = join(dir, 'cache-credential.json')
  const env = { ...process.env, BILI_CREDENTIAL: file }
  delete env.BILI_SESSDATA
  const api = new URL('../../integrations/bili-api.mjs', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.BILI_CREDENTIAL, '{}');
    const { hasLoginCookie } = await import(${JSON.stringify(api)});
    const before = await hasLoginCookie();
    writeFileSync(process.env.BILI_CREDENTIAL, JSON.stringify({ sessdata: 'synthetic-cookie' }));
    console.log(JSON.stringify({ before, after: await hasLoginCookie() }));
  `], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, '凭据刷新子进程应成功')
  const state = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.ok(!state.before && state.after, '账号更新后不应继续使用缓存的空 Cookie')
})
test('账号状态兼容大写 Cookie 字段', async () => {
  writeFileSync(process.env.BILI_CREDENTIAL, JSON.stringify({ SESSDATA: secret, DedeUserID: '10001' }))
  let called = false
  globalThis.fetch = async (url, options) => {
    called = options.headers.cookie.includes(secret)
    return Response.json({ code: 0, data: { isLogin: true } })
  }
  const result = await invoke('/bili/status', 'get')
  assert.ok(called && result.loggedIn, '账号状态应使用 loader 支持的大写凭据')
})
test('插件配置首次保存自动创建父目录并完整遮盖短 Cookie', async () => {
  await invoke('/xhs', 'put', { cookie: secret, enabled: true })
  const result = await invoke('/xhs', 'get')
  assert.equal(result.hasCookie, true)
  assert.equal(result.cookieMasked, '***', '状态不能返回 Cookie 前后缀')
})
test('扫码失败响应不回显上游认证字段和 query', async () => {
  globalThis.fetch = async () => Response.json({ code: -1, apiKey: secret, url: `https://example.com/?token=${secret}` })
  const result = await invoke('/bili/qrcode', 'post')
  assert.ok(!JSON.stringify(result).includes(secret), '扫码错误响应不得含上游凭证')
})
test('扫码轮询消息遮盖上游认证字段和 query', async () => {
  const qrKey = randomBytes(18).toString('hex')
  globalThis.fetch = async () => Response.json({ code: 0, data: { url: 'https://example.com/qr', qrcode_key: qrKey } })
  await invoke('/bili/qrcode', 'post')
  globalThis.fetch = async () => Response.json({ code: 0, data: { code: 86101, message: `token=${secret} https://example.com/?key=${qrKey}` } })
  const result = await invoke('/bili/qrcode/poll', 'get', {}, { key: qrKey })
  assert.equal(result.state, 'waiting')
  assert.ok(!JSON.stringify(result).includes(secret) && !JSON.stringify(result).includes(qrKey), '轮询状态不得回显认证值')
})
test('扫码更新清除旧大写别名，loader 与账号状态使用新 Cookie', async () => {
  const qrKey = randomBytes(18).toString('hex')
  const nextCookie = randomBytes(24).toString('hex')
  writeFileSync(process.env.BILI_CREDENTIAL, JSON.stringify({ SESSDATA: secret, DedeUserID: '10001' }))
  globalThis.fetch = async url => {
    if (String(url).includes('/generate')) return Response.json({ code: 0, data: { url: 'https://example.com/qr', qrcode_key: qrKey } })
    if (String(url).includes('/poll')) return new Response(JSON.stringify({ code: 0, data: { code: 0 } }), { headers: { 'set-cookie': `SESSDATA=${nextCookie}; Path=/` } })
    return Response.json({ code: 0, data: { isLogin: true } })
  }
  await invoke('/bili/qrcode', 'post')
  assert.equal((await invoke('/bili/qrcode/poll', 'get', {}, { key: qrKey })).state, 'confirmed')
  const saved = JSON.parse(readFileSync(process.env.BILI_CREDENTIAL, 'utf8'))
  assert.ok(saved.sessdata === nextCookie && !saved.SESSDATA, '更新后不得残留优先级更高的旧别名')
})
test('分享卡片 aid 输入可继续调用视频详情工具', async () => {
  const { parseMessage } = await import('../../integrations/bili-dm.mjs')
  const { default: video } = await import('../../tools/bili-video.mjs')
  const card = parseMessage({ msg_type: 7, content: JSON.stringify({ id: '123456', title: '测试视频' }) })
  assert.equal(card.aid, 123456)
  assert.ok(card.text.includes('aid=123456'), '卡片正文应向模型提供 aid')
  globalThis.fetch = async () => Response.json({ code: 0, data: { bvid: 'BV1GJ411x7h7', aid: card.aid, title: '测试视频', pages: [{ cid: 1, page: 1 }], owner: {}, stat: {} } })
  const result = JSON.parse(await video.execute({ aid: card.aid }))
  assert.equal(result.aid, card.aid)
  assert.equal(result.bvid, 'BV1GJ411x7h7')
})
function commentOwner(commentUid, replyUid) {
  const caseDir = mkdtempSync(join(dir, 'comment-owner-'))
  try {
    const settings = join(caseDir, 'settings.json')
    writeFileSync(settings, JSON.stringify({ writes: { enabled: true, allowNewComment: true } }))
    const env = {
      ...process.env,
      BILI_HUMANISM_DATA: caseDir,
      BILI_HUMANISM_SETTINGS: settings,
      BILI_SESSDATA: 'synthetic-session', BILI_JCT: 'synthetic-csrf'
    }
    delete env.COMMENT_AT_UID
    delete env.REPLY_TALKER
    if (commentUid) env.COMMENT_AT_UID = String(commentUid)
    if (replyUid) env.REPLY_TALKER = String(replyUid)
    const tool = new URL('../../tools/bili-comment-reply.mjs', import.meta.url).href
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      let at = '';
      globalThis.fetch = async (url, options = {}) => {
        if (options.method === 'POST') {
          at = new URLSearchParams(options.body).get('at_name_to_mid') || '';
          return Response.json({ code: 0, data: { rpid: 'test-reply' } });
        }
        return Response.json({ code: 0, data: { card: { name: '测试负责人' } } });
      };
      const { default: tool } = await import(${JSON.stringify(tool)});
      await tool.execute({ aid: 123456, message: '我更关心这个例子怎样用于实际验证。', basis: ['subtitle'], understood: '测试字幕逐步说明了如何准备材料并比较两种方法，最后给出了可以实际重复验证的具体过程。', confidence: 'high' });
      console.log(JSON.stringify({ at }));
    `], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, '合成评论流程应成功且不访问真实接口')
    return JSON.parse(result.stdout.trim().split('\n').at(-1)).at
  } finally {
    rmSync(caseDir, { recursive: true, force: true })
  }
}
test('COMMENT_AT_UID 显式配置保留自动 @ 负责人', () => {
  assert.ok(commentOwner(10001, 10002).includes('10001'), '评论负责人应使用显式 COMMENT_AT_UID')
})
test('负责人均未配置时不添加个人默认 UID', () => {
  assert.equal(commentOwner(null, null), '')
})
test('仅配置 REPLY_TALKER 时评论负责人保持一致', () => {
  assert.ok(commentOwner(null, 10003).includes('10003'), '仅配置回复负责人时自动 @ 链应使用同一负责人')
})
test('生产网关请求日志不包含 query 或 Authorization，错误响应仍脱敏', async () => {
  const beforeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  globalThis.fetch = originalFetch
  const { createGateway } = await import('../gateway.mjs')
  const log = []
  const saved = { log: console.log, warn: console.warn, error: console.error }
  for (const method of Object.keys(saved)) console[method] = (...args) => log.push(format(...args))
  let server
  try {
    const gateway = await createGateway({ tools: [], getHealth: async () => ({ ok: true }) }, { getAvailableChannels: () => [] })
    ;({ server } = await gateway.start(0))
    const response = await originalFetch(`http://127.0.0.1:${server.address().port}/missing?key=${secret}`, { headers: { authorization: `Bearer ${secret}` } })
    assert.equal(response.status, 404)
    assert.ok(!JSON.stringify(await response.json()).includes(secret), '生产错误响应不得含 query 凭证')
    assert.ok(!log.join('\n').includes(secret), '生产日志不得含 query 或认证头')
    assert.ok(log.some(line => line.includes('GET /missing')), '请求日志应保留方法与路径')
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    Object.assign(console, saved)
    process.env.NODE_ENV = beforeEnv
  }
})
