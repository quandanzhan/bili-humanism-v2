/**
 * standalone-v2 统一入口
 * ============================================================================
 * Task G-H：把密钥 / 模型路由 / 工具引擎 / HTTP 网关串成一个能启动的服务。
 *
 * 启动顺序（契约，不许调换）：
 *   配置 → 密钥 → 引擎 → 模型 → 网关 → 配置热重载，每步打一行日志。
 *
 * 用法（cwd 必须是 standalone-v2/，engine.start 相对 cwd 扫描工具目录）：
 *   node main.mjs                      # 默认 3000
 *   PORT=8080 node main.mjs            # 环境变量优先
 *   # config.json 里也可写 { "port": 8080 }，优先级：PORT > config.port > 3000
 *
 * 边界行为（均按 HANDOFF-TASK-G-H.md 5.1 要求实现）：
 *   · config.json 不存在 → loadConfig 返回 {}，不算错，跳过热重载并 warn
 *   · config.json 内容坏了（非法 JSON）→ CONFIG_INVALID 冒到 main().catch → exit(1)
 *   · 端口被占用 → start(port) reject（gateway 已修好 EADDRINUSE 行为）→ exit(1)
 *   · watchConfig 前必须 fs.existsSync（fs.watch 对不存在文件同步抛 ENOENT）
 *
 * 热重载现状（如实声明，见 HANDOFF 坑 14）：
 *   engine.updateConfig() 只把 patch 合进内存 this.config，
 *   不落盘、不重扫工具、不刷新插件——链路已接通，实际生效范围待 Task C 补齐。
 */

import fs from 'node:fs'
import { loadSecrets } from './secrets/loader.mjs'
import { loadConfig, watchConfig } from './config/loader.mjs'
import { chat } from './models/router.mjs'
import { getAvailableChannels } from './models/fallback.mjs'
import { Engine } from './integrations/engine.mjs'
import { createGateway } from './gateway/gateway.mjs'

async function main() {
  // ---------- 1. 配置 ----------
  const config = await loadConfig('./config.json')   // ENOENT 时自动返回 {}，不会抛
  console.log('[main] ✓ 配置已加载')

  // ---------- 2. 密钥 ----------
  const secrets = await loadSecrets()
  console.log('[main] 密钥已加载')

  // ---------- 3. 工具引擎 ----------
  const engine = new Engine()
  // ⚠️ './tools' 相对 process.cwd()，所以本文件必须在 standalone-v2/ 下、
  //    且以该目录为 cwd 启动，否则扫描到 0 个工具且不报错。
  const { tools } = await engine.start('./tools')
  console.log(`[main] ✓ 工具引擎已启动（${tools.length} 个工具）`)

  // ---------- 4. 模型路由 ----------
  // ⚠️ 必须同时提供 chat 和 getAvailableChannels：
  //    少了 getAvailableChannels，/api/chat/models 直接 500、
  //    /api/health 的 models.available 永远是 0。
  const modelRouter = { chat, getAvailableChannels }
  console.log('[main] ✓ 模型路由器已就绪')

  // ---------- 5. HTTP 网关 ----------
  const { start } = await createGateway(engine, modelRouter)
  const port = Number(process.env.PORT) || config.port || 3000
  const bindHost = process.env.BILI_HUMANISM_HOST || '127.0.0.1'
  let server
  try {
    const started = await start(port)                // 端口占用会 reject，必须接住
    server = started.server
  } catch (err) {
    console.error(`[main] ✗ 网关启动失败（端口 ${port}）: ${err.message}`)
    process.exit(1)
  }
  console.log(`[main] ✓ 网关已启动: http://${bindHost}:${port}`)

  // ---------- 5.5 值班调度（AI 自己刷视频） ----------
  // 关掉用 SCHEDULER_ENABLED=0（测试环境默认不启，避免测试里偷偷调模型花钱）
  if (process.env.SCHEDULER_ENABLED !== '0' && process.env.NODE_ENV !== 'test') {
    const { startScheduler } = await import('./gateway/scheduler.mjs')
    startScheduler(engine)
  } else {
    console.log('[main] 值班调度未启动（SCHEDULER_ENABLED=0 或 NODE_ENV=test）')
  }

  // ---------- 5.6 私信回复循环（接管 V1 的 reply_service.py） ----------
  // 默认启动，但 mode 由 data/reply-loop.json 决定（off/dry/live）；
  // 新机器上首次是 off，需要显式打开 —— 不会莫名其妙给主人发消息。
  if (process.env.REPLY_LOOP !== '0' && process.env.NODE_ENV !== 'test') {
    const { startReplyLoop } = await import('./gateway/reply-loop.mjs')
    startReplyLoop(engine)
  } else {
    console.log('[main] 私信回复循环未启动（REPLY_LOOP=0 或 NODE_ENV=test）')
  }

  // ---------- 6. 配置热重载 ----------
  // ⚠️ fs.watch 对不存在的文件会「同步抛 ENOENT」，必须先前置判断，
  //    否则前面全部成功、最后一步把进程打挂。
  if (fs.existsSync('./config.json')) {
    watchConfig('./config.json', async (next) => {
      console.log('[main] 配置变更，热重载...')
      await engine.updateConfig(next)                // ⚠️ async，必须 await
    })
    console.log('[main] ✓ 热重载已启用')
  } else {
    console.warn('[main] ⚠ 未找到 config.json，跳过热重载')
  }

  // ---------- 优雅退出 ----------
  // gateway.mjs 已注册 SIGTERM；这里补 SIGINT（Ctrl+C / 集成测试收尾）。
  if (!main._sigintBound) {
    main._sigintBound = true
    process.on('SIGINT', () => {
      console.log('[main] 收到 SIGINT，正在关闭...')
      server?.close(() => {
        console.log('[main] 已关闭')
        process.exit(0)
      })
      // 兜底：3 秒后强退，避免连接未排空导致进程挂住
      setTimeout(() => process.exit(0), 3000).unref()
    })
  }
}

main().catch((err) => {
  console.error('[main] ✗ 启动失败:', err)
  process.exit(1)
})
