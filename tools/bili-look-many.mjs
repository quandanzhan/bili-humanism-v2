/**
 * 工具：批量看多条视频的画面（并发扩容的入口）
 * ============================================================================
 * 为什么需要它：
 *   现有的 bili_vision 一次只处理一条视频 —— 即使你有 NAS + 阿里云两个节点，
 *   一次调用也只会派一个任务、只用一个节点。真正的「并发扩容」入口在这里：
 *   一次把 N 条视频的抽帧任务全派出去，让 N 个节点**各领一个**同时算。
 *
 * ⚠️ 但必须诚实：**单节点时必须退化成串行**。
 *   只有 1 个节点时并发派 3 个任务，它们只能在同一个节点排队，
 *   总耗时等于串行（甚至更久，因为多了排队/切换开销）。
 *   所以进门先看在线节点数：< 2 就直接串行处理，不为了「并发」而并发。
 *
 * @module tools/bili-look-many
 */
import { httpError } from '../integrations/fetch-client.mjs'
import { describeImages, visionStatus } from '../gateway/vision.mjs'
import { workerOnline, enqueue, waitFor } from '../gateway/worker.mjs'
import { getVideoUrl, parseBvid, getVideo } from '../integrations/bili-api.mjs'
import framesTool from './bili-frames.mjs'

const MAX_ITEMS = 5

/** 给一条视频派 frames 任务并等结果；失败返回 null（上层回落精灵图） */
async function nasFramesFor(bvid, count, deadlineMs = 45000) {
  try {
    const { bvid: bv } = parseBvid(bvid)
    const v = await getVideo(bv)
    const vurl = await getVideoUrl(bv, v.cid)
    const dur = vurl.durationSec || v.durationSec || 0
    const LO = 0.08
    const HI = 0.85
    const times = Array.from({ length: count }, (_, i) => {
      const p = count === 1 ? 0.5 : LO + ((HI - LO) * i) / (count - 1)
      return Math.max(1, Math.min(Math.floor(dur * HI), Math.round(dur * p)))
    })
    const id = enqueue('frames', { videoUrl: vurl.url, times, width: 1280, qsv: true }, { deadlineMs: deadlineMs + 30000 })
    const w = await waitFor(id, deadlineMs, 800)
    if (!w.ok || !w.result?.frames) return null
    const ok = w.result.frames.filter((f) => f.ok && f.b64)
    if (!ok.length) return null
    return {
      images: ok.map((f) => 'data:image/jpeg;base64,' + f.b64),
      times: ok.map((f) => f.sec),
      agent: w.agent,
      res: `${vurl.width}x${vurl.height}`
    }
  } catch {
    return null
  }
}

/** 处理一条：优先 NAS/worker 高清帧，拿不到就用精灵图 */
async function processOne(bvid, count, question, forceSprite) {
  const t0 = Date.now()
  let frames = null
  // 尊重全局开关：BILI_VISION_NAS=1 才尝试远程抽帧。
  // 不开的时候直接走精灵图（0.6 秒），别为了「可能更快」白等 45 秒。
  const nasEnabled = String(process.env.BILI_VISION_NAS || '') === '1'
  if (!forceSprite && nasEnabled) {
    frames = await nasFramesFor(bvid, count)
  }

  let images = frames?.images
  let source = frames ? 'nas' : 'sprite'
  let quality = frames ? frames.res : '480x270'
  let timeText = ''

  if (!images) {
    const fr = await framesTool.execute({ bvid, count, width: 480, quality: 85 })
    if (!fr?.ok || !fr.images?.length) {
      return { bvid, ok: false, error: fr?.why || '取帧失败', ms: Date.now() - t0 }
    }
    images = fr.images
    timeText = (fr.frames || []).map((f) => f.timeText || `${f.sec}s`).join(' / ')
    if (frames?.times?.length) {
      timeText = frames.times.map((x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`).join(' / ')
    }
  } else if (frames?.times?.length) {
    timeText = frames.times.map((x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`).join(' / ')
  }

  const v = await describeImages({ images, question, maxImages: count, race: true })
  return {
    bvid,
    ok: Boolean(v.ok),
    source,
    quality,
    timePoints: timeText,
    description: v.ok ? v.text : null,
    backend: v.ok ? v.backend : null,
    error: v.ok ? null : v.error,
    ms: Date.now() - t0
  }
}

export default {
  name: 'bili_look_many',
  description:
    '一次看多条视频的画面（最多 5 条）。有 2 个以上算力节点时会真正并行，只有 1 个时自动串行。' +
    '每条返回画面描述。想知道「这几条视频分别在讲什么画面」时用它，比一条条调 bili_vision 快。',
  parameters: {
    type: 'object',
    properties: {
      bvids: {
        type: 'array',
        items: { type: 'string' },
        description: 'BV 号数组，最多 5 条'
      },
      count: { type: 'number', description: '每条看几帧，默认 2，最多 4（帧越多越慢）' },
      question: { type: 'string', description: '想问什么，默认逐帧描述画面内容' }
    },
    required: ['bvids']
  },

  async execute(args = {}) {
    const raw = Array.isArray(args.bvids) ? args.bvids : []
    const list = [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, MAX_ITEMS)
    if (!list.length) throw httpError('INVALID_ARGUMENT', 'bvids 不能为空')

    const count = Math.max(1, Math.min(4, Number(args.count) || 2))
    const question = String(args.question || '').trim() ||
      '这几帧是同一个视频的不同时间点。逐帧说明：实拍还是录屏/PPT？画面里有什么？有没有可读文字？只说你确实看到的。'

    const st = visionStatus()
    if (!st.readyCount) {
      throw httpError('VISION_NO_BACKEND', '没有可用视觉后端（缺 API key）')
    }

    // ⭐ 关键：先看有几个节点。只有 1 个节点时并发毫无意义（同一节点排队），直接串行。
    const online = workerOnline()
    const nodeCount = (online.agents || []).filter((a) => a.online).length
    const parallel = nodeCount >= 2
    const t0 = Date.now()

    const results = []
    if (parallel) {
      // 多节点：一次性把任务全派出去，让各节点各领一个
      results.push(...(await Promise.all(list.map((bv) => processOne(bv, count, question, false)))))
    } else {
      // 单节点/无节点：串行，避免排队反而更慢
      for (const bv of list) {
        results.push(await processOne(bv, count, question, !online.online))
      }
    }

    const okCount = results.filter((r) => r.ok).length
    return {
      ok: okCount > 0,
      mode: parallel ? `并行（${nodeCount} 个节点）` : `串行（${nodeCount || 0} 个节点在线）`,
      count: results.length,
      okCount,
      totalMs: Date.now() - t0,
      items: results,
      note: parallel
        ? `已按 ${nodeCount} 个节点并行派发。每条的 source 表示帧来自 nas（高清）还是 sprite（B站精灵图）。`
        : '当前只有 1 个算力节点（或都没有），所以串行处理——并发只会让同一节点排队，不会更快。' +
          '要真正并行需要再挂一个 worker（阿里云/NAS 都行）。'
    }
  }
}
