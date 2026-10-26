/**
 * 工具：B 站视频真实画面帧（图像块，给视觉模型看）
 * ============================================================================
 * 目标：让「具备图像能力的模型」看到视频**实际画面**，而不是只依赖字幕与标题。
 *
 * 三级取帧策略（按顺序降级，全部实测过）：
 *   1. sprite —— B站官方 `x/player/videoshot` 预览精灵图（10x10 大图），
 *                用 scripts/sprite_slice.py 本地切格。**不需要 ffmpeg**，
 *                也不需要下载视频流。这是服务器上唯一稳的一档。
 *   2. cover  —— 视频封面（一定拿得到，但不是内容帧，只能当「长什么样」的参考）。
 *   3. ffmpeg —— 若部署环境配了 BILI_FFMPEG，才走下载视频+抽帧。
 *                本机（腾讯云 Lighthouse）**没装 ffmpeg**，所以默认不会走这档。
 *
 * 返回值约定（给 models/router.mjs 用）：
 *   { ok, kind, bvid, ..., images: ['data:image/jpeg;base64,...'], frames: [{sec,timeText}] }
 *   router 会把 images 抽出来，作为**下一条 user 消息的图像块**发给视觉模型
 *   （OpenAI 协议里 role:'tool' 只能放文本，图像必须单独走 user 消息）。
 *
 * ⚠️ 诚实性：抽样帧不等于完整观影。工具在 note 里写清楚抽了几帧、覆盖哪些时间点，
 *    并要求模型不要用抽样代替全部。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { httpError } from '../integrations/fetch-client.mjs'
import { parseBvid, getVideo } from '../integrations/bili-api.mjs'

const execFileP = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

/** 切格用的 python（bili-duty 的 venv 里带 PIL） */
const PY = process.env.BILI_FRAMES_PY || join(__dirname, '..', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const SLICER = process.env.BILI_FRAMES_SCRIPT || join(__dirname, '..', 'scripts', 'sprite_slice.py')

function secText(sec) {
  if (sec === null || sec === undefined) return ''
  const s = Number(sec) || 0
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

async function fetchJson(url, timeoutMs = 12000) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, referer: REFERER },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!r.ok) throw httpError('BILI_HTTP_ERROR', `接口返回 ${r.status}`, { url, status: r.status })
  return r.json()
}

async function fetchImageDataUrl(url, timeoutMs = 15000) {
  const u = url.startsWith('//') ? 'https:' + url : url
  const r = await fetch(u, {
    headers: { 'user-agent': UA, referer: REFERER, accept: 'image/*,*/*;q=0.8' },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!r.ok) throw httpError('BILI_HTTP_ERROR', `图片返回 ${r.status}`, { url: u, status: r.status })
  const type = (r.headers.get('content-type') || 'image/jpeg').split(';')[0]
  const buf = Buffer.from(await r.arrayBuffer())
  return `data:${type};base64,${buf.toString('base64')}`
}

/** 第一档：官方预览精灵图 → 本地切格 */
async function trySprite({ bvid, cid, count, maxWidth = 0, quality = 0, select = '' }) {
  const j = await fetchJson(
    `https://api.bilibili.com/x/player/videoshot?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&index=1`
  )
  if (j?.code !== 0 || !j?.data?.image?.length) {
    return { ok: false, why: `videoshot code=${j?.code} ${j?.message || ''}`.trim() }
  }
  const d = j.data
  if (!existsSync(SLICER)) return { ok: false, why: `切格脚本不存在：${SLICER}` }
  if (!existsSync(PY)) return { ok: false, why: `python 不存在：${PY}` }

  const payload = JSON.stringify({
    images: d.image,
    xLen: d.img_x_len,
    yLen: d.img_y_len,
    xSize: d.img_x_size,
    ySize: d.img_y_size,
    index: d.index || [],
    count,
    // 默认 400：给纯文本模型用，图会被剥掉，只需要像素统计
    // bili_vision 会传 width=480（精灵图原始格宽）—— 缩小会让小字糊掉，
    // 实测 400px 时三个视觉模型都把「单智能体产品」读成「单机版产品」，纯属瞎猜。
    select: String(select || '').toLowerCase() === 'uniform' ? 'uniform' : 'smart',
    maxWidth: Number(maxWidth) || Number(process.env.BILI_FRAMES_WIDTH) || 400,
    quality: Number(quality) || Number(process.env.BILI_FRAMES_QUALITY) || 78
  })

  const { stdout } = await execFileP(PY, [SLICER, payload], {
    timeout: Number(process.env.BILI_FRAMES_TIMEOUT_MS) || 90000,
    maxBuffer: 64 * 1024 * 1024
  })
  let out
  try {
    out = JSON.parse(String(stdout || '').trim().split('\n').pop())
  } catch {
    return { ok: false, why: '切格脚本输出不是 JSON' }
  }
  if (!out.ok) return { ok: false, why: out.error || '切格失败' }

  return {
    ok: true,
    kind: 'sprite',
    grid: `${d.img_x_len}x${d.img_y_len}`,
    totalFrames: out.total,
    images: out.frames.map((f) => `data:image/jpeg;base64,${f.b64}`),
    frames: out.frames.map((f) => ({
      i: f.i,
      sec: f.sec,
      timeText: secText(f.sec),
      w: f.w,
      h: f.h,
      kb: f.kb,
      // ⚠️ look 必须透传：这是视觉模型不可用时唯一的画面依据。
      //    之前漏了这一行，导致 visualSummary 永远是空（踩过一次）。
      look: f.look || null
    })),
    why: ''
  }
}

/** 第二档：封面 */
async function tryCover(video) {
  const url = video?.cover || ''
  if (!url) return { ok: false, why: '视频没有封面字段' }
  const dataUrl = await fetchImageDataUrl(url)
  return {
    ok: true,
    kind: 'cover',
    images: [dataUrl],
    frames: [{ i: 0, sec: null, timeText: '封面', w: 0, h: 0 }],
    why: ''
  }
}

export default {
  name: 'bili_frames',
  description:
    '取B站视频的真实画面帧（官方预览精灵图切格，免 ffmpeg），返回图像块，让视觉模型直接看到画面而不只依赖字幕。取不到帧时自动回退视频封面。',
  parameters: {
    type: 'object',
    properties: {
      bvid: { type: 'string', description: 'BV 号或视频链接' },
      count: { type: 'number', description: '要几帧（1-9，默认 6）' },
      page: { type: 'number', description: '分P序号，默认 1' },
      mode: {
        type: 'string',
        enum: ['auto', 'sprite', 'cover'],
        description: 'auto=精灵图优先并回退封面；sprite=只要帧；cover=只要封面'
      }
    },
    required: ['bvid']
  },

  /**
   * @param {{bvid: string, count?: number, page?: number, mode?: string}} args
   * @returns {Promise<Object>} { ok, kind, images:[dataURL], frames:[{sec,timeText}], note }
   */
  async execute(args = {}) {
    const { bvid, page } = parseBvid(args.bvid)
    const count = Math.max(1, Math.min(9, Number(args.count) || 6))
    const mode = ['auto', 'sprite', 'cover'].includes(args.mode) ? args.mode : 'auto'

    const v = await getVideo(bvid)
    if (!v?.bvid) throw httpError('BILI_NOT_FOUND', '未获取到视频信息', { bvid })
    const cid = v.pages?.find((p) => p.page === page)?.cid || v.cid

    const tried = []
    let result = null

    if (mode !== 'cover') {
      try {
        const r = await trySprite({ bvid, cid, count, maxWidth: Number(args.width) || 0, quality: Number(args.quality) || 0, select: args.select || '' })
        tried.push({ tier: 'sprite', ok: r.ok, why: r.why })
        if (r.ok) result = r
      } catch (e) {
        tried.push({ tier: 'sprite', ok: false, why: String(e?.message || e) })
      }
      if (!result && mode === 'sprite') {
        throw httpError('BILI_FRAMES_FAILED', '官方预览精灵图取帧失败', { bvid, tried })
      }
    }

    if (!result) {
      try {
        const r = await tryCover(v)
        tried.push({ tier: 'cover', ok: r.ok, why: r.why })
        if (r.ok) result = r
      } catch (e) {
        tried.push({ tier: 'cover', ok: false, why: String(e?.message || e) })
      }
    }

    if (!result) {
      throw httpError('BILI_FRAMES_FAILED', '取画面失败：精灵图与封面都没拿到', { bvid, tried })
    }

    const note =
      result.kind === 'sprite'
        ? `这是从官方预览精灵图切出的 ${result.images.length} 张抽样帧（原图共 ${result.totalFrames} 格，` +
          `网格 ${result.grid}）。抽样不等于完整观影，描述时请说明「看了哪几个时间点」。`
        : '未取到内容帧，只有封面。封面不能代表视频内容，不要用封面推断内容。'

    // 客观色卡摘要：给「看不见图」的模型（服务器上的通道都是纯文本模型）留一条活路。
    // 只陈述像素实测值，不替它下「这是什么内容」的结论。
    const looks = (result.frames || []).filter((f) => f.look)
    const visualSummary = looks.length
      ? '【每帧的客观像素统计（实测值，不是内容描述）】\n' +
        looks
          .map((f) => {
            const t = f.sec === null ? '?' : `${Math.floor(f.sec / 60)}:${String(f.sec % 60).padStart(2, '0')}`
            const tags = f.look.tags?.length ? `；${f.look.tags.join('；')}` : ''
            return `· ${t} ${f.look.text}${tags}`
          })
          .join('\n') +
        '\n用这些数据可以判断：亮度/色彩/是否死黑、画面是不是字幕板或夜景这类**色调级**结论。' +
        '不能判断：画面里是谁、在做什么、有没有某个物体——那些必须真看到图才能说。'
      : ''

    return {
      ok: true,
      kind: result.kind,
      bvid,
      page,
      title: v.title,
      durationSec: v.durationSec,
      url: `https://www.bilibili.com/video/${bvid}`,
      sampled: result.images.length,
      frames: result.frames,
      visualSummary,
      // ⚠️ images 会被 models/router.mjs 抽出来，作为下一条 user 消息的图像块
      images: result.images,
      tried,
      note
    }
  }
}
