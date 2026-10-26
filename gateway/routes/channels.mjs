/**
 * 模型通道管理路由 - /api/channels
 * ============================================================================
 * 给控制台用的「自定义 AI 大模型接入点」CRUD + 优先级排序 + 连通性测试。
 *
 * 接口一览（全部需要 Basic Auth）：
 *   GET    /api/channels              列出全部通道（apiKey 打码为 ***）+ auto 开关
 *   POST   /api/channels              新增通道  { name, baseURL, model, apiKey?, priority?, note? }
 *   PATCH  /api/channels/:id          修改通道  { name?, baseURL?, model?, apiKey?, priority?, enabled?, note? }
 *   DELETE /api/channels/:id          删除通道
 *   POST   /api/channels/reorder      按 id 顺序重排优先级  { ids: ["ch_xx", "ch_yy"] }
 *   POST   /api/channels/:id/test     测试连通性（真实请求一次 /chat/completions）
 *   PUT    /api/channels/auto         自动模式开关  { auto: true|false }
 *
 * 约定：
 *   · priority 数字越小越优先，对话时按此顺序尝试并自动降级
 *   · apiKey 永不出现在响应里；更新时传 "***" 或空串表示「不修改」
 *   · 参数类错误（BAD_BASE / BAD_MODEL / DUP）统一 400，便于前端就地提示
 *
 * 注意：不在此处做任何网络调用以外的业务逻辑，通道数据由 models/channels.mjs 负责。
 */

import { Router } from 'express'
import { requireAuth } from '../auth.mjs'
import {
  load,
  save,
  list,
  masked,
  add,
  update,
  remove,
  setAuto
} from '../../models/channels.mjs'
import { testChannel } from '../../models/router.mjs'

/** 可安全返回给客户端的业务错误码 */
const CLIENT_ERRORS = new Set(['BAD_BASE', 'BAD_MODEL', 'DUP', 'BAD_PRIORITY', 'BAD_NAME'])

/**
 * 包装通道模块抛出的错误
 * @param {any} err
 * @param {import('express').Response} res
 * @returns {boolean} true 表示已响应
 */
function handleChannelError(err, res) {
  if (err && CLIENT_ERRORS.has(err.code)) {
    res.status(400).json({
      error: err.message,
      code: err.code,
      data: err.data || {}
    })
    return true
  }
  return false
}

/**
 * 创建通道管理路由
 * @returns {Router}
 */
export function createChannelsRouter() {
  const router = Router()
  router.use(requireAuth())

  /**
   * GET /api/channels
   * masked() 返回的是 { auto, file, channels }，不是数组
   */
  router.get('/', (req, res) => {
    const m = masked()
    const items = m.channels || []
    res.json({
      auto: m.auto !== false,
      channels: items,
      count: items.length,
      enabled: items.filter(c => c.enabled !== false).length,
      file: m.file
    })
  })

  /**
   * POST /api/channels/reorder
   * 必须注册在 /:id 相关路由之前
   */
  router.post('/reorder', (req, res) => {
    const ids = req.body?.ids
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        error: 'ids 必须是非空数组（按期望顺序排列的通道 id）',
        code: 'BAD_ORDER'
      })
    }

    const d = load()
    const map = new Map(d.channels.map(c => [c.id, c]))
    const head = ids.map(id => map.get(id)).filter(Boolean)
    if (head.length !== ids.length) {
      return res.status(400).json({
        error: 'ids 中存在不存在的通道 id',
        code: 'BAD_ORDER',
        data: { unknown: ids.filter(id => !map.has(id)) }
      })
    }

    // 未出现在 ids 里的通道保持原有相对顺序，排在后面
    const tail = d.channels.filter(c => !ids.includes(c.id))
    let p = 10
    for (const c of [...head, ...tail]) {
      c.priority = p
      p += 10
    }
    save(d)

    const items = masked().channels || []
    res.json({ ok: true, channels: items, count: items.length })
  })

  /**
   * PUT /api/channels/auto
   */
  router.put('/auto', (req, res) => {
    const auto = Boolean(req.body?.auto)
    res.json({ ok: true, auto: setAuto(auto) })
  })

  /**
   * POST /api/channels/:id/test
   */
  router.post('/:id/test', async (req, res, next) => {
    try {
      const ch = list().find(c => c.id === req.params.id)
      if (!ch) {
        return res.status(404).json({ error: '通道不存在', code: 'CHANNEL_NOT_FOUND', data: { id: req.params.id } })
      }

      const timeoutMs = Number(req.body?.timeoutMs) || 20000
      const started = Date.now()
      const result = await testChannel(ch, timeoutMs)

      res.json({
        ok: Boolean(result.ok),
        channel: { id: ch.id, name: ch.name, model: ch.model },
        latencyMs: result.ms ?? Date.now() - started,
        status: result.status,
        sample: result.sample,
        error: result.error
      })
    } catch (err) {
      next(err)
    }
  })

  /**
   * PATCH /api/channels/:id
   */
  router.patch('/:id', (req, res) => {
    try {
      const patch = req.body || {}
      const next = update(req.params.id, patch)
      if (!next) {
        return res.status(404).json({ error: '通道不存在', code: 'CHANNEL_NOT_FOUND', data: { id: req.params.id } })
      }
      res.json({ ok: true, channel: next })
    } catch (err) {
      if (!handleChannelError(err, res)) throw err
    }
  })

  /**
   * PUT /api/channels/:id —— 局部更新（含 vision 开关）
   * 2026-10-22 补：之前只有 POST/DELETE，前端想单独切「支持图像输入」没有接口
   */
  router.put('/:id', (req, res, next) => {
    try {
      const item = update(req.params.id, req.body || {})
      if (!item) {
        return res.status(404).json({ error: '通道不存在', code: 'CHANNEL_NOT_FOUND', data: { id: req.params.id } })
      }
      res.json({ ok: true, channel: item, count: list().length })
    } catch (err) {
      if (!handleChannelError(err, res)) next(err)
    }
  })

  /**
   * DELETE /api/channels/:id
   */
  router.delete('/:id', (req, res) => {
    const ok = remove(req.params.id)
    if (!ok) {
      return res.status(404).json({ error: '通道不存在', code: 'CHANNEL_NOT_FOUND', data: { id: req.params.id } })
    }
    res.json({ ok: true, id: req.params.id, count: list().length })
  })

  /**
   * POST /api/channels
   */
  router.post('/', (req, res) => {
    try {
      const body = req.body || {}
      const item = add({
        name: body.name,
        baseURL: body.baseURL,
        apiKey: body.apiKey,
        model: body.model,
        priority: body.priority,
        note: body.note
      })
      res.status(201).json({ ok: true, channel: item, count: list().length })
    } catch (err) {
      if (!handleChannelError(err, res)) throw err
    }
  })

  return router
}
