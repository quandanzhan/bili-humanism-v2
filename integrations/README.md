# integrations —— 外部集成

> standalone-v2 模块 · 任务 A（外部集成）产出

## 职责

把小红书采集、浏览器资源池、插件注册表从旧版 `vendor/standalone/` 根目录独立成模块，统一导出格式。**三个文件均为旧版原样迁移，只改了 module 注释**，签名算法、Playwright 逻辑、汉化字典、踩坑注释全部保留。

## 文件与接口

### `xhs.mjs` —— 小红书采集（原生 HTTP + 自算 v1 签名，零浏览器）

迁移自旧版 `standalone/xhs.mjs`。

```javascript
import { actions } from './xhs.mjs'

await actions.search({ keyword, limit = 10, cookie = '', onCookieUpdate })
// → { ok, count, notes: [{ id, url, title, author, like, type, cover }], ... }

await actions.note({ url, cookie = '', onCookieUpdate })
// → { ok, title, desc, author, like, collect, comment, tags, images, ... }

actions.selfTest()
// → { ok, xS, xSLength: 44, xT, xSCommonLength }（不联网，验证签名函数）
```

- **Cookie 轮换**：小红书每次访问都可能轮换 `web_session`，`onCookieUpdate(next, keys)` 回调把合并后的 cookie 交回宿主持久化。
- **失败分类**：HTTP 461 = 签名失效；code -100 = 登录过期；code -104 = 账号无权限（见返回的 `hint` 字段）。
- 只读采集；请求间隔 ≥1.5s，单次上限 30 条。

### `browser-pool.mjs` —— 浏览器资源池（Playwright Chromium，headless）

迁移自旧版 `standalone/browser.mjs`。

```javascript
import { actions, withContext, parseCookieString, close } from './browser-pool.mjs'

await actions.text({ url, waitMs, maxChars })        // 标题 + 正文
await actions.screenshot({ url, fullPage, width, height })  // PNG base64
await actions.html({ url, maxChars })                // 原始 DOM
await actions.links({ url, max })                    // 页面链接
await actions.eval({ url, script })                  // 页面求值（可 BROWSER_ALLOW_EVAL=false 关闭）
await actions.status()                               // 运行状态（不起浏览器）

await withContext(cookies, async (page, ctx) => { ... })  // 独立 context 注入 Cookie，用完即关
parseCookieString('a=1; b=2', '.example.com')        // cookie 串 → Playwright 结构
await close()                                        // 手动关闭浏览器
```

- **惰性启动 + 复用**：首次调用才起浏览器，空闲 `BROWSER_IDLE_MS`（默认 90s）自动关闭。
- **单页串行**：互斥锁排队，避免并发页面打爆内存。
- **小内存参数**：`--renderer-process-limit=1` 等优化全部保留（旧版踩坑记录见文件头注释）。
- 依赖：`playwright`（standalone-v2/package.json 已声明，本机用 chromium-1148 缓存）。

### `registry.mjs` —— 插件注册表 + 汉化字典

迁移自旧版 `standalone/plugins.mjs`。

```javascript
import { PLUGINS, pluginById, localizeTool } from './registry.mjs'

PLUGINS              // 插件清单（humanism / browser / video / qq / xhs / webhook）
pluginById('humanism')  // → { id, name, icon, group, kind: 'builtin-tool', ... } 或 null
localizeTool(tool)      // 给工具补齐中文 label / desc / hint，参数与 enum 一并汉化
```

- 加新插件 = 往 `PLUGINS` 里加一条对象，前端自动渲染。
- `kind` 三种：`builtin-tool`（宿主工具集）、`builtin-browser`（内置浏览器动作）、`adapter`（外部平台适配器，secret 字段在 API 里打码）。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `BROWSER_IDLE_MS` | 浏览器空闲回收毫秒 | `90000` |
| `BROWSER_NAV_TIMEOUT` | 导航超时毫秒 | `45000` |
| `BROWSER_MAX_TEXT` | 正文截断上限 | `60000` |
| `BROWSER_ALLOW_EVAL` | 允许页面 eval | `true` |

## 错误处理

迁移文件沿用旧版语义：小红书/浏览器动作以 `{ ok: false, httpStatus, code, hint }` 返回失败而非抛错；参数类错误（缺 keyword、坏链接）抛 `Error`。新增模块请按 `ai-tasks/shared/error-codes.md` 约定带 `err.code`（如 `XHS_AUTH_REQUIRED`、`BROWSER_TIMEOUT`）。
