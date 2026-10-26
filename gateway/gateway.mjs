import { redactText } from './runtime.mjs'
// ================================================================
// HTTP 网关主模块
// ================================================================

import express from 'express'
import session from 'express-session'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadSecrets } from '../secrets/loader.mjs'
import { corsMiddleware, logCorsPolicy } from './middleware/cors.mjs'
import { errorHandler, notFoundHandler } from './middleware/error.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 创建 HTTP 网关
 * @param {Object} engine - Engine 实例
 * @param {Object} modelRouter - 模型路由器 { chat, getAvailableChannels }
 * @returns {Promise<{ app: Express, start: Function }>}
 */
export async function createGateway(engine, modelRouter) {
  const secrets = await loadSecrets()
  const app = express()

  // ============ 中间件配置 ============

  // JSON 解析（10mb 偏大，公网部署建议收到 1mb：JSON_BODY_LIMIT 可调）
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }))

  // URL 编码解析
  app.use(express.urlencoded({ extended: true, limit: process.env.JSON_BODY_LIMIT || '1mb' }))

  // 会话管理
  app.use(session({
    secret: secrets.session.SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: secrets.session.TTL_MS,   // loader 默认 7 天，见 SESSION_TTL_MS
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === '1'   // 生产 HTTPS 置 1（并配 trust proxy）
    }
  }))

  // 反向代理下让 secure cookie 与 req.ip 正确（nginx/CDN 前置时必须）
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1)

  // CORS：白名单模式（CORS_ORIGINS / CORS_HAVP / CORS_STRICT）
  logCorsPolicy()
  app.use(corsMiddleware())

  // 请求日志（可用 LOG_REQUESTS=0 关闭，避免刷屏）
  if (process.env.LOG_REQUESTS !== '0') {
    app.use((req, res, next) => {
      console.log(`[gateway] ${req.method} ${req.path}`)
      next()
    })
  }

  // ============ 静态控制台 ============

  // 前端只有 index.html / console.js / console.css 三个文件，发布新版本后必须能被立刻拿到。
  // 实测踩过的坑：改了 console.js 但浏览器（以及 Cloudflare 边缘）仍拿旧副本，
  // 表现为「按钮点了没反应、二维码刷不出来」——静态扩展名默认会被 CF 缓存。
  // 这里统一压成 no-cache + ETag 强校验：内容没变只回 304，变了立刻拿新的。
  app.use((req, res, next) => {
    if (req.path === '/' || /\.(html|js|css)$/i.test(req.path)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate')
    }
    next()
  })

  // 同源托管 public/，浏览器会自动带上 Basic Auth，不需要额外登录页
  app.use(express.static(join(__dirname, '..', 'public'), {
    index: 'index.html',
    etag: true,
    lastModified: true,
    maxAge: process.env.STATIC_MAX_AGE || 0
  }))

  // ============ 挂载路由 ============

  // 动态导入路由模块
  const { createChatRouter } = await import('./routes/chat.mjs')
  const { createToolsRouter } = await import('./routes/tools.mjs')
  const { createHealthRouter } = await import('./routes/health.mjs')
  const { createChannelsRouter } = await import('./routes/channels.mjs')
  const { createSettingsRouter } = await import('./routes/settings.mjs')
  const { createAccountRouter } = await import('./routes/account.mjs')
  const { createPersonaRouter } = await import('./routes/persona.mjs')
  const { createScheduleRouter } = await import('./routes/schedule.mjs')
  const { createReplyRouter } = await import('./routes/reply.mjs')
  const { createWritesRouter } = await import('./routes/writes.mjs')
  const { createNodesRouter } = await import('./routes/nodes.mjs')
  const { createWorkerRouter } = await import('./routes/worker.mjs')
  const { createScopesRouter } = await import('./routes/scopes.mjs')
  const { createMcpRouter } = await import('./routes/mcp.mjs')
  const { createDigestRouter } = await import('./routes/digest.mjs')
  const { createVisionRouter } = await import('./routes/vision.mjs')

  // ⚠️ 外部 worker 必须**第一个**注册：
  //    后面那些 createXxxRouter() 内部都有 router.use(requireAuth())，而它们挂在 '/api' 上，
  //    会拦截所有 /api/* —— worker 节点带的是 x-worker-token 不是 Basic Auth，
  //    注册晚了会先被 401 掉（2026-10-23 实测踩到）。
  app.use('/api', createWorkerRouter())

  // chat 需要 engine 才能把工具名带进降级话术
  app.use('/api/chat', createChatRouter(modelRouter, engine))
  // scopes 必须在 tools 之前：/api/tools/:name 会把 scope 当工具名吃掉
  app.use('/api', createScopesRouter())
  // MCP 服务器管理（只提供 mcp_list/mcp_call 两个代理口，不展开工具）
  app.use('/api', createMcpRouter())
  // 日报与章程
  app.use('/api', createDigestRouter())
  app.use('/api/tools', createToolsRouter(engine))
  // 旧版路径兼容：POST /api/tool/<name>（单数），前端迁移期不至于直接 404
  app.use('/api/tool', createToolsRouter(engine))
  app.use('/api/health', createHealthRouter(engine, modelRouter))
  app.use('/api/channels', createChannelsRouter())
  // 管理员设置（SMTP 预警）与账号（B站扫码登录 / 小红书 Cookie）
  app.use('/api/settings', createSettingsRouter())
  app.use('/api/account', createAccountRouter())
  // 人格与记忆：刻意挂在 /api 根下且分成两组路径，避免以后有人把两者合并成一个接口
  app.use('/api', createPersonaRouter())
  app.use('/api', createScheduleRouter(engine))
  // 私信回复（会对外发消息，单独一路便于随时关掉）
  app.use('/api', createReplyRouter(engine))
  // 写权限（发评论这类「别人能看见」的动作，单独一路）
  app.use('/api', createWritesRouter())
  // 解析节点监控（阿里云/魔搭的服务器健康，与本机调度分开）
  app.use('/api', createNodesRouter())
  // 视觉能力（给纯文本通道装眼睛）
  app.use('/api', createVisionRouter())

  // ============ 错误处理 ============

  // 404 处理
  app.use(notFoundHandler)

  // 全局错误处理
  app.use(errorHandler)

  // ============ 启动方法 ============

  const start = (port = 3000, host) => {
    // 默认只绑回环——ECS 复核发现 app.listen(port) 裸写会监听 *:port，
    // 外网暴露只靠云安全组兜底。需要对外/接反代时用 HOST env 或参数显式放开。
    // 变量名沿用旧版 server.mjs 的 BILI_HUMANISM_HOST；不用裸 HOST，
    // 避免 shell 恰好导出 HOST 变量时无意把服务放开到所有网卡。
    const bindHost = host ?? process.env.BILI_HUMANISM_HOST ?? '127.0.0.1'
    return new Promise((resolve, reject) => {
      // ⚠️ 不能写成 app.listen(port, (err) => ...)：listen 的回调是 'listening' 事件，
      //    不会带 err 参数。端口被占用时只会抛未捕获的 'error' 事件把进程打挂，
      //    promise 永远不 resolve 也不 reject。必须显式监听 error。
      const server = app.listen(port, bindHost)

      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[gateway] ✗ 端口 ${port} 已被占用`)
        } else {
          console.error('[gateway] ✗ 启动失败:', redactText(err?.message || err))
        }
        reject(err)
      })

      server.once('listening', () => {
        const addr = server.address()
        console.log(`[gateway] ✓ HTTP 网关已启动: http://${addr.address}:${addr.port}`)
        resolve({ app, server })
      })

      // 优雅关闭（只在第一次 start 时注册，避免多次调用重复绑定）
      if (!start._sigtermBound) {
        start._sigtermBound = true
        process.on('SIGTERM', () => {
          console.log('[gateway] 收到 SIGTERM，正在关闭...')
          server.close(() => {
            console.log('[gateway] 已关闭')
            process.exit(0)
          })
        })
      }
    })
  }

  return { app, start }
}
