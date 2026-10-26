/**
 * 路由：人格（语气外壳） + 记忆（可修正） —— 两者刻意分开两组端点
 * ============================================================================
 * @module gateway/routes/persona
 *
 * 人格（只读为主，可切换/可改片段，改前自动备份）：
 *   GET    /api/persona                  → 人格元信息 + 片段清单
 *   PUT    /api/persona                  → { active: 'whale'|'maojiang' } 切换
 *   GET    /api/persona/fragment?name=   → 读片段原文
 *   PUT    /api/persona/fragment         → 写片段（自动 .bak）
 *   GET    /api/persona/preview          → 预览最终 system prompt
 *
 * 记忆（可增删改，不写死成指令）：
 *   GET    /api/memory                   → 记忆条目
 *   POST   /api/memory                   → { text, tags }
 *   PUT    /api/memory/:id               → { text?, tags? }
 *   DELETE /api/memory/:id
 *   GET    /api/memory/chat?limit=&q=    → V1 聊天记录（可读副本）
 *   GET    /api/memory/runs?limit=       → 值班流水
 *   GET    /api/memory/stats             → 计数（卡片副标题用）
 */

import { Router } from 'express'
import { requireAuth } from '../auth.mjs'
import {
  getPersona,
  setActivePersona,
  readFragment,
  writeFragment,
  buildSystemPrompt,
  personaFile
} from '../persona.mjs'
import {
  listNotes,
  addNote,
  updateNote,
  deleteNote,
  chatHistory,
  listRuns,
  memoryStats,
  memoryDir,
  buildMemoryBlock
} from '../memory.mjs'

export function createPersonaRouter() {
  const router = Router()
  router.use(requireAuth())

  // ---------------------------------------------------------------- 人格
  router.get('/persona', (req, res, next) => {
    try {
      res.json({ ...getPersona(), dir: personaFile() })
    } catch (err) {
      next(err)
    }
  })

  router.put('/persona', (req, res, next) => {
    try {
      const { active } = req.body || {}
      if (!active) {
        return res.status(400).json({ error: '缺少 active', code: 'INVALID_REQUEST' })
      }
      res.json(setActivePersona(String(active)))
    } catch (err) {
      next(err)
    }
  })

  router.get('/persona/fragment', (req, res, next) => {
    try {
      res.json(readFragment(req.query.name))
    } catch (err) {
      next(err)
    }
  })

  router.put('/persona/fragment', (req, res, next) => {
    try {
      const { name, content } = req.body || {}
      if (!name || typeof content !== 'string') {
        return res.status(400).json({ error: '需要 name 与 content', code: 'INVALID_REQUEST' })
      }
      res.json(writeFragment(name, content))
    } catch (err) {
      next(err)
    }
  })

  router.get('/persona/preview', (req, res, next) => {
    try {
      const withMemory = String(req.query.memory || '') === '1'
      const p = buildSystemPrompt({
        includeWorldview: String(req.query.worldview || '') === '1',
        memoryBlock: withMemory ? buildMemoryBlock({ limit: 8 }) : ''
      })
      res.json({
        personaId: p.personaId,
        chars: p.system.length,
        parts: p.parts,
        system: p.system.length > 12000 ? p.system.slice(0, 12000) + '\n…（截断）' : p.system
      })
    } catch (err) {
      next(err)
    }
  })

  // ---------------------------------------------------------------- 记忆
  router.get('/memory', (req, res, next) => {
    try {
      res.json({ ...listNotes(), dir: memoryDir() })
    } catch (err) {
      next(err)
    }
  })

  router.post('/memory', (req, res, next) => {
    try {
      res.status(201).json(addNote(req.body || {}))
    } catch (err) {
      next(err)
    }
  })

  router.put('/memory/:id', (req, res, next) => {
    try {
      res.json(updateNote(req.params.id, req.body || {}))
    } catch (err) {
      next(err)
    }
  })

  router.delete('/memory/:id', (req, res, next) => {
    try {
      res.json({ ok: true, removed: deleteNote(req.params.id) })
    } catch (err) {
      next(err)
    }
  })

  router.get('/memory/chat', (req, res, next) => {
    try {
      res.json(chatHistory({ limit: req.query.limit, q: req.query.q, kind: req.query.kind }))
    } catch (err) {
      next(err)
    }
  })

  router.get('/memory/runs', (req, res, next) => {
    try {
      res.json({ runs: listRuns(Number(req.query.limit) || 20) })
    } catch (err) {
      next(err)
    }
  })

  router.get('/memory/stats', (req, res, next) => {
    try {
      res.json(memoryStats())
    } catch (err) {
      next(err)
    }
  })

  return router
}
