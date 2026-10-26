/**
 * 外部集成模块测试（任务 A 验收）
 * ============================================================================
 * 运行：node tests/integrations.test.mjs（本目录）或
 *       node vendor/standalone-v2/tests/integrations.test.mjs（项目根）
 *
 * 说明：
 * · 小红书用例不联网：selfTest 只验证签名函数；search/note 只测参数校验抛错。
 * · 浏览器用例用 data: URL 打开真实 headless Chromium（需 playwright +
 *   本机 chromium-1148 缓存，standalone-v2/package.json 已声明依赖）。
 * · 测试辅助 API 与 ai-tasks/shared/test-utils.mjs 一致（见 test-helpers.mjs 头注释）。
 */

import { suite, assert, assertEqual, assertThrowsAsync } from './test-helpers.mjs'
import { actions as xhsActions } from '../integrations/xhs.mjs'
import { actions as browserActions, withContext, parseCookieString, close as closeBrowser } from '../integrations/browser-pool.mjs'
import { PLUGINS, pluginById, localizeTool } from '../integrations/registry.mjs'

// data: URL 页面：真实走一遍 Chromium 渲染管线，零网络依赖
const PAGE_URL = 'data:text/html,<html><head><title>TestPage</title></head><body><h1>hello</h1><p>standalone-v2 integrations test page, enough characters for readBody</p><a href="https://example.com/a">A</a><a href="https://example.com/b">B</a></body></html>'

try {
  await suite('外部集成模块', {
    '小红书自检通过': () => {
      const r = xhsActions.selfTest()
      assert(r.ok, '签名算法正常')
      assertEqual(r.xSLength, 44, 'x-s 长度 44 字符')
      assert(r.xSCommonLength > 0, 'x-s-common 非空')
      assert(r.xT, 'x-t 存在')
    },

    '小红书 search 缺 keyword 抛错': async () => {
      await assertThrowsAsync(() => xhsActions.search({ keyword: '' }), 'keyword')
    },

    '小红书 note 坏链接抛错': async () => {
      await assertThrowsAsync(() => xhsActions.note({ url: 'https://example.com/foo' }), '小红书')
    },

    '浏览器状态可查': async () => {
      const r = await browserActions.status()
      assert(r.ok, '浏览器模块正常')
      assertEqual(typeof r.idleMs, 'number', 'idleMs 是数字')
      assertEqual(typeof r.evalAllowed, 'boolean', 'evalAllowed 是布尔')
    },

    '浏览器 text 能打开页面': async () => {
      const r = await browserActions.text({ url: PAGE_URL, waitMs: 0 })
      assert(r.ok, '打开成功')
      assertEqual(r.title, 'TestPage', '拿到页面标题')
      assert(r.text.includes('standalone-v2 integrations test page'), '拿到正文')
      assert(r.textLength > 0, '正文非空')
    },

    '浏览器 screenshot 返回 PNG': async () => {
      const r = await browserActions.screenshot({ url: PAGE_URL, waitMs: 0, fullPage: false })
      assert(r.ok, '截图成功')
      assertEqual(r.format, 'png')
      assert(r.bytes > 1000, 'PNG 有内容')
      assert(r.base64.length > 0, 'base64 非空')
    },

    '浏览器 links / eval 正常': async () => {
      const links = await browserActions.links({ url: PAGE_URL, waitMs: 0 })
      assert(links.ok && links.count === 2, '取到 2 条链接')
      const ev = await browserActions.eval({ url: PAGE_URL, waitMs: 0, script: 'document.title' })
      assert(ev.ok && ev.value === 'TestPage', 'eval 求值正确')
    },

    'parseCookieString / withContext 注入 Cookie': async () => {
      const cookies = parseCookieString('a1=xxx; web_session=yyy', '.example.com')
      assertEqual(cookies.length, 2, '解析出 2 条 cookie')
      assertEqual(cookies[0].name, 'a1')
      assertEqual(cookies[0].domain, '.example.com')
      assert(cookies[0].secure === true, 'secure 默认 true')
      const n = await withContext(cookies, async (page, ctx) => (await ctx.cookies()).length)
      assertEqual(n, 2, '独立 context 里注入了 2 条 cookie')
    },

    '插件注册表有数据': () => {
      assert(PLUGINS.length > 0, '至少有一个插件')
      const humanism = pluginById('humanism')
      assert(humanism, 'B站人文学习插件存在')
      assertEqual(humanism.kind, 'builtin-tool')
      assertEqual(pluginById('not-exist'), null, '不存在的插件返回 null')
    },

    'localizeTool 能正确汉化工具': () => {
      const tool = {
        name: 'bili_humanism_read',
        description: 'read a video',
        parameters: { action: { type: 'string', enum: ['read', 'list'] }, url: { type: 'string' } }
      }
      const zh = localizeTool(tool)
      assertEqual(zh.label, '读取视频', '工具名汉化')
      assert(zh.descZh.length > 0, 'descZh 非空')
      assertEqual(zh.parameters.url.label, '链接地址', '参数汉化')
      assertEqual(zh.parameters.action.enum[0].label, '读取', 'enum 汉化')
    }
  })
} finally {
  // 关掉浏览器进程，让测试脚本干净退出
  await closeBrowser().catch(() => {})
}
