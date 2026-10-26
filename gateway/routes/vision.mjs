/**
 * 路由：视觉能力（给纯文本模型装眼睛）
 * ============================================================================
 * @module gateway/routes/vision
 *
 *   GET  /api/vision      → 后端链状态（只说「配没配 key」，绝不回显 key）
 *   PUT  /api/vision      → 改后端链配置
 *   POST /api/vision/test → 拿一张纯色测试图跑一遍，验证 key 通不通
 *
 * 测试图用 32x32 纯红 PNG：能答对「红色」才说明真的能看图，
 * 而不是模型在瞎猜（纯文本模型遇到图会假装没看见然后编）。
 */
import { Router } from 'express'
import { requireAuth } from '../auth.mjs'
import { visionStatus, saveVision, describeImages, visionFile } from '../vision.mjs'

// 32x32 纯红 PNG（zlib 压缩后 base64）
const RED_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwOqpf0GTMhF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj13IkkEeAiW3HAAAAABJRU5ErkJggg=='

export function createVisionRouter() {
  const router = Router()
  router.use(requireAuth())

  router.get('/vision', (req, res, next) => {
    try {
      res.json({ ...visionStatus(), file: visionFile() })
    } catch (err) {
      next(err)
    }
  })

  router.put('/vision', (req, res, next) => {
    try {
      saveVision(req.body || {})
      res.json({ ok: true, ...visionStatus() })
    } catch (err) {
      next(err)
    }
  })

  router.post('/vision/test', async (req, res, next) => {
    try {
      const t0 = Date.now()
      const r = await describeImages({
        images: [RED_PNG],
        question: '这张图是什么颜色？只回答颜色名。',
        cache: false
      })
      res.json({ ...r, wallMs: Date.now() - t0 })
    } catch (err) {
      next(err)
    }
  })

  return router
}
