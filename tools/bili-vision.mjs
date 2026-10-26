/**
 * 工具：看懂 B 站视频的画面（给纯文本 DeepSeek 装眼睛）
 * ============================================================================
 * 这是「视频解析内核」缺的最后一块。
 * 之前 bili_frames 只能把帧取出来，但三个通道都是纯文本模型，喂不进去，
 * 所以 DeepSeek 只能靠字幕猜画面，或者只读得到「亮度 20/255、主色黑」这种像素统计。
 *
 * 现在的链路：
 *   bili_frames 取帧 → gateway/vision.mjs 视觉链（免费视觉 API failover）
 *   → 画面转成结构化文字 → 返回给 DeepSeek 推理
 *
 * ⚠️ 诚实边界（必须写进返回值，否则模型会当成自己亲眼看见）：
 *   这是**二手描述**：视觉模型先看图写成文字，DeepSeek 读的是文字。
 *   细节（人脸、小字、精确颜色）会在转述中丢失。
 *   所以结论里要说「据画面描述」，不能说「我看到」。
 *
 * @module tools/bili-vision
 */
import { httpError } from '../integrations/fetch-client.mjs'
import { describeImages, visionStatus } from '../gateway/vision.mjs'
import { workerOnline, enqueue, waitFor } from '../gateway/worker.mjs'
import { getVideoUrl, parseBvid, getVideo } from '../integrations/bili-api.mjs'
import framesTool from './bili-frames.mjs'

/** NAS 路径的熔断状态：连续失败几次就暂停一段时间，别让每次视觉调用都白等 */
let nasFail = 0
let nasCooldownUntil = 0
const NAS_MAX_FAIL = 2
const NAS_COOLDOWN_MS = 10 * 60 * 1000

const DEFAULT_Q = [
  '这几张是同一个视频里不同时间点的画面。请逐帧说明：',
  '1) 这是实拍还是录屏/PPT/动画？2) 画面里有什么（人/物/场景/界面）？',
  '3) 有没有可读的文字（标题、字幕条、图表数字）？4) 整体是什么场景？',
  '只描述你确实看到的，看不清就说看不清。'
].join('')

export default {
  name: 'bili_vision',
  description:
    '看懂B站视频的画面：取真实帧交给视觉模型，返回画面内容描述（实拍/录屏/有没有人/画面文字）。' +
    '字幕为空或想判断画面内容时用它。注意这是视觉模型转述，不是你亲眼看到，结论要标注「据画面描述」。',
  parameters: {
    type: 'object',
    properties: {
      bvid: { type: 'string', description: 'BV 号 / 视频链接' },
      count: { type: 'number', description: '抽几帧看，默认 4，最多 6（帧越多越慢越贵）' },
      question: { type: 'string', description: '想重点看什么，如「画面里有没有人物出镜」' },
      page: { type: 'number', description: '分P 号，默认 1' },
      width: { type: 'number', description: '画面宽度，默认 480（精灵图原始格宽）；调小可省流量但小字会糊' },
      cover: { type: 'boolean', description: '是否同时看封面，默认 true（封面清晰、小字读得准，建议开）' }
    },
    required: ['bvid']
  },

  async execute(args = {}) {
    const count = Math.max(1, Math.min(6, Number(args.count) || 4))
    const question = String(args.question || '').trim() || DEFAULT_Q

    // 先确认视觉链有没有可用后端，避免白取一次帧
    const st = visionStatus()
    if (st.enabled === false) {
      throw httpError('VISION_DISABLED', '视觉链被关掉了（控制台「视觉能力」里打开）')
    }
    if (!st.readyCount) {
      throw httpError('VISION_NO_BACKEND', '没有可用的视觉后端（缺少 API key）', {
        hint:
          '配任意一个即可：ZHIPU_API_KEY（智谱 glm-4v-flash，永久免费，open.bigmodel.cn）/' +
          'DASHSCOPE_API_KEY（阿里云百炼 qwen3-vl-flash）/ INTERN_API_KEY（Intern AI）',
        backends: st.backends.map((b) => ({ name: b.name, hasKey: b.hasKey }))
      })
    }

    // ── NAS 优先：在线就用 1080p 真实帧，离线/失败自动回落精灵图 ──────────
    //   用户明确要求：NAS 只是「开机时的主力」，关机时必须能走老路，不能变成单点。
    //   判断依据是心跳（agent 每 5 秒轮询就续命，60 秒没动静判离线）。
    // ⚠️ 不再用 workerOnline() 决定要不要派任务。
    //    它的返回值在工具进程里出现过「接口说在线、工具里判离线」的矛盾，
    //    导致永远走不到 NAS 分支、且不留任何日志（2026-10-23 排查了两轮才定位）。
    //    改成「直接派 + 短超时 + 熔断」：NAS 在就 12 秒内拿回帧，不在就 12 秒后回落，
    //    连续 2 次失败熔断 10 分钟，平时不会反复白等。
    let nasFrames = null
    const online = workerOnline()
    let nasError = null
    const cooling = Date.now() < nasCooldownUntil
    // 默认**关闭** NAS 路径：链路已通但端到端还不稳定（跨进程队列 + 抽帧本身 10~20s，
    // 叠加后常在 25s 内回不来，导致每次视觉调用白等）。等串联验证稳定后再打开：
    //   在服务环境中设置 BILI_VISION_NAS=1，然后重启自己的服务
    // 关着的时候 100% 走精灵图，耗时稳定在 30s 内，不影响任何现有功能。
    const nasEnabled = String(process.env.BILI_VISION_NAS || '') === '1'
    if (nasEnabled && !cooling && online.agents?.length !== 0) {
      const t0nas = Date.now()
      try {
        const { bvid } = parseBvid(args.bvid)
        const v = await getVideo(bvid)
        const cid = v.pages?.find((p) => p.page === (Number(args.page) || 1))?.cid || v.cid
        const vurl = await getVideoUrl(bvid, cid)
        const dur = vurl.durationSec || v.durationSec || 0
        // 均匀取点，避开片头片尾各 10%
        // ⚠️ 取点必须跟着视频真实时长按比例滑动，并且和精灵图那条路的口径一致：
        //   · 避开片头 8%（常是黑场/logo）和片尾 15%（流尾部 seek 容易卡住）
        //   · **count=1 时取中点**（旧公式会退化成 10% 位置，等于只看片头）
        const LO = 0.08, HI = 0.85
        const times = Array.from({ length: count }, (_, i) => {
          const p = count === 1 ? 0.5 : LO + ((HI - LO) * i) / (count - 1)
          return Math.max(1, Math.min(Math.floor(dur * HI), Math.round(dur * p)))
        })
        // 超时 45 秒：实测 NAS 抽 3 帧（1080p QSV）约 30~40 秒 —— 每帧要启动 ffmpeg、
        // 连 CDN、seek 到目标位置，比预想的慢。25 秒会误判成失败（任务其实成功了，只是没等到）。
        // 上限不再更大：45 秒等不到就回落精灵图，加上熔断不会反复白等。
        const id = enqueue('frames', { videoUrl: vurl.url, times, width: 1280, qsv: true }, { deadlineMs: 120000 })
        const w = await waitFor(id, 45000, 800)
        // ⚠️ waitFor 超时返回 {ok:false} 而不是抛异常 —— 不走 catch，
        //    nasError 就会一直是 null，看起来像「没进 NAS 分支」，实际是「等了 30 秒没等到」。
        //    2026-10-23 就是这里误导了排查方向，必须显式记下来。
        if (!w.ok) {
          nasError = `NAS 未在时限内返回：${w.error || w.status || 'unknown'}`
          console.warn('[bili_vision]', nasError)
        }
        if (w.ok && w.result?.frames?.length) {
          const ok = w.result.frames.filter((f) => f.ok && f.b64)
          if (ok.length) {
            nasFrames = {
              images: ok.map((f) => 'data:image/jpeg;base64,' + f.b64),
              times: ok.map((f) => f.sec),
              agent: w.agent,
              ms: Date.now() - t0nas,
              res: `${vurl.width}x${vurl.height} ${vurl.codecs.split('.')[0]}`
            }
          }
        }
      } catch (e) {
        // 失败要回落，但**不能完全静默** —— 否则出问题时根本看不出来（今天已经踩过两次）
        nasError = `${e?.code || 'ERR'}: ${String(e?.message || e).slice(0, 140)}`
        console.warn('[bili_vision] NAS 抽帧失败，回落精灵图：', nasError)
        nasFrames = null
      }
      if (!nasFrames) {
        nasFail += 1
        if (nasFail >= NAS_MAX_FAIL) {
          nasCooldownUntil = Date.now() + NAS_COOLDOWN_MS
          nasFail = 0
          console.warn(`[bili_vision] NAS 连续失败 ${NAS_MAX_FAIL} 次，熔断 5 分钟，期间直接走精灵图`)
        }
      } else {
        nasFail = 0
      }
    }

    // ── 取两种图，各司其职 ──────────────────────────────────────────────
    // 封面：一张高清大图（100KB+），小字看得清 —— 用它判断「这视频在讲什么」
    // 帧  ：精灵图格 480×270，字会糊 —— 用它判断「画面怎么变、是实拍还是录屏」
    // 实测对比：封面能读出「别让智能体自己结算 / 批批次按依赖分层成波次」，
    //          同一视频的帧只能读出「单智能体产品 / 多线程行」。两者都要。
    const wantCover = args.cover !== false
    const [coverFr, fr] = await Promise.all([
      wantCover
        ? framesTool.execute({ bvid: args.bvid, count: 1, page: args.page, mode: 'cover' }).catch(() => null)
        : Promise.resolve(null),
      // ⚠️ 关键：用精灵图原始格宽（480），缩小会让小字糊掉
      framesTool.execute({
        bvid: args.bvid,
        count,
        page: args.page,
        width: Math.max(1, Math.min(960, Number(args.width) || 480)),
        quality: 85
      })
    ])
    if (!fr?.ok || !fr.images?.length) {
      throw httpError('BILI_FRAMES_FAILED', `取帧失败：${fr?.why || '没有可用帧'}`)
    }

    // 2) 交给视觉链：封面问「主题」，帧问「画面」
    const t0 = Date.now()
    const coverQ =
      '这是B站视频的封面图。请回答：1) 封面上所有可读的文字（标题/大字/角标）原样读出；' +
      '2) 画面主体是什么（人物/截图/实拍/插画）？3) 从封面看这视频在讲什么。只说你看到的。'
    const frameQ = question

    // 帧的来源：优先 NAS 高清帧，没有就用精灵图
    const frameImages = nasFrames?.images?.length ? nasFrames.images : fr.images
    const [coverV, v] = await Promise.all([
      coverFr?.images?.length
        ? describeImages({ images: coverFr.images, question: coverQ, maxImages: 1, race: true }).catch(() => null)
        : Promise.resolve(null),
      describeImages({ images: frameImages, question: frameQ, maxImages: count, race: true })
    ])

    // timeText 可能为空（sec 解析不到时），用秒数兜底，避免 note 里出现空的「 / / 」
    const times = (fr.frames || [])
      .map((f) => f.timeText || (f.sec != null ? `${f.sec}s` : '?'))
      .join(' / ')

    if (!v.ok) {
      // 视觉失败不要整轮失败：把像素统计还给模型，让它至少能说色调
      return {
        ok: false,
        degraded: true,
        bvid: fr.bvid,
        title: fr.title,
        sampled: fr.sampled,
        timePoints: times,
        visualSummary: fr.visualSummary,
        error: v.error,
        tried: v.tried,
        hint: v.hint,
        note: '视觉模型没调通，本次只能给你像素统计（色调/明暗），不能描述画面内容——不要编。'
      }
    }

    return {
      ok: true,
      bvid: fr.bvid,
      title: fr.title,
      durationSec: fr.durationSec,
      url: fr.url,
      sampled: frameImages.length,
      timePoints: nasFrames?.times?.map((x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`).join(' / ') || times,
      // ⭐ 图从哪来：nas=1080p 真实帧（高清），sprite=B站精灵图（480x270，字会糊）
      frameSource: nasFrames ? 'nas' : 'sprite',
      nasError: nasError || (cooling ? '熔断中' : null),
      frameQuality: nasFrames ? nasFrames.res : '480x270',
      // 封面描述（高清，字读得准）+ 帧描述（看画面变化），分开返回
      coverText: coverV?.ok ? coverV.text : null,
      coverBackend: coverV?.ok ? coverV.backend : null,
      // 视觉模型的原话（这是二手描述）
      description: v.text,
      backend: v.backend,
      model: v.model,
      ms: Date.now() - t0,
      cached: v.cached || false,
      visualSummary: fr.visualSummary,
      note:
        `两种来源：①封面${coverV?.ok ? `（${coverV.backend}）` : '（未取到）'}——高清，字读得准；` +
        `②${frameImages.length} 帧画面（${v.backend}）——来自 ${nasFrames ? `NAS 高清帧 ${nasFrames.res}` : 'B站精灵图 480x270（字会糊）'}，时间点 ${times}。` +
        '两者都是视觉模型转述，不是你亲眼看画面：细节（人脸、小字、精确颜色）可能丢失，' +
        '结论请写「据画面描述」，不要写「我看到」；引用文字以封面那段为准。'
    }
  }
}
