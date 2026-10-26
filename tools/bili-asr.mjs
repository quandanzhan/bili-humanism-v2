/**
 * 工具：B 站视频本地语音识别（faster-whisper，离线）
 * ============================================================================
 * 为什么需要：B 站很多视频没有字幕（或只有「AI 自动字幕」质量很差），
 * 字幕为空时模型就完全瞎了。服务器上已经有 V1 留下的 faster-whisper
 * （`.venv-asr` 里装了 faster-whisper + PyAV），直接复用，不重复装依赖、不外传音频。
 *
 * 依赖事实（2026-10-22 真机实测）：
 *   · 服务器**没有 ffmpeg**，asr_v2.py 用 PyAV 解码，不需要系统 ffmpeg。
 *   · 模型缓存路径通过 BILI_ASR_HF_HOME 配置，默认使用用户缓存目录。
 *     请求 tiny/base 会去连 HuggingFace，这台机器连不上 ⇒ 必须就地回落。
 *   · 4 核 CPU 上 small/int8 约 0.42x 实时：6 分钟视频转全片要 153s，太贵。
 *     所以默认只转前 180 秒（判断「这视频在讲什么」足够），全片得显式要。
 *
 * @module tools/bili-asr
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { httpError } from '../integrations/fetch-client.mjs'
import { parseBvid, getVideo, getAudioUrl, downloadAudio } from '../integrations/bili-api.mjs'

const execFileP = promisify(execFile)

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))
const ASR_PY = process.env.BILI_ASR_PY || join(PROJECT_ROOT, '.venv-asr', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const ASR_SCRIPT = process.env.BILI_ASR_SCRIPT || join(PROJECT_ROOT, 'scripts', 'asr_v2.py')
const ASR_CWD = process.env.BILI_ASR_CWD || PROJECT_ROOT
/** faster-whisper 的模型缓存（asr_v2.py 也认这个，通过 BILI_ASR_HF_HOME 传） */
const ASR_HF_HOME = process.env.BILI_ASR_HF_HOME || join(homedir(), '.cache', 'huggingface')
const ASR_CACHE = process.env.BILI_ASR_CACHE || join(ASR_HF_HOME, 'hub')
/** 默认只转前 180 秒：够判断，又不至于把一轮对话拖爆 */
const DEFAULT_MAX_SEC = Number(process.env.BILI_ASR_MAX_SEC) || 180

/**
 * 本地已经下好的模型有哪些
 * @returns {string[]} 例如 ['small']
 */
function cachedModels() {
  try {
    return readdirSync(ASR_CACHE)
      .filter((d) => d.startsWith('models--') && d.includes('faster-whisper-'))
      .map((d) => d.split('faster-whisper-')[1])
  } catch {
    return []
  }
}

/** asr_v2.py 吐的是「最后一行 JSON」；老版 asr.py 吐裸文本，两种都要能读 */
function parseOut(stdout) {
  const s = String(stdout || '').trim()
  if (!s) return null
  const lines = s.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const o = JSON.parse(line)
      if (o && typeof o === 'object' && 'ok' in o) return o
    } catch {
      /* 继续往前找 */
    }
  }
  return null
}

export default {
  name: 'bili_asr',
  description:
    '本地语音识别：把B站视频的音频离线转成文字（faster-whisper，不外传音频）。字幕缺失或只有AI自动字幕时用它兜底。默认只转前 3 分钟。',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'BV 号 / 视频链接 / 本地音视频文件路径' },
      maxSeconds: {
        type: 'number',
        description: '只转前 N 秒，默认 180；传 0 转全片（长视频很慢，约 0.4x 实时）'
      },
      model: {
        type: 'string',
        enum: ['tiny', 'base', 'small', 'medium'],
        description: 'whisper 模型大小，默认 small（服务器上只有 small 有缓存，请求别的会自动回落）'
      },
      lang: { type: 'string', description: '语言代码，默认 zh；传 auto 自动判断' }
    },
    required: ['target']
  },

  /**
   * @param {{target: string, maxSeconds?: number, model?: string, lang?: string}} args
   * @returns {Promise<Object>} { ok, text, chars, model, ms, truncated, partial }
   */
  async execute(args = {}) {
    const target = String(args.target || '').trim()
    if (!target) throw httpError('INVALID_ARGUMENT', 'target 不能为空')
    const want = ['tiny', 'base', 'small', 'medium'].includes(args.model) ? args.model : 'small'
    const lang = String(args.lang || 'zh').slice(0, 8)
    const maxSeconds =
      args.maxSeconds === undefined || args.maxSeconds === null
        ? DEFAULT_MAX_SEC
        : Math.max(0, Number(args.maxSeconds) || 0)

    // 只用手上已有的模型：请求未缓存的型号会去连 HuggingFace，
    // 在这台机器上必然失败（实测 tiny 白等 80s 后 500）。能就地回落就回落。
    // asr_v2.py 里也有一份同样的回落逻辑（防止绕过本工具直接调脚本）。
    const have = cachedModels()
    let model = want
    let modelFallback = null
    if (have.length && !have.includes(want)) {
      model = have.includes('small') ? 'small' : have[0]
      modelFallback = { requested: want, used: model }
    }

    if (!existsSync(ASR_PY)) {
      throw httpError('ASR_NOT_AVAILABLE', `找不到 ASR python：${ASR_PY}`, {
        hint: '设置 BILI_ASR_PY 指向装了 faster-whisper 的解释器'
      })
    }
    if (!existsSync(ASR_SCRIPT)) {
      throw httpError('ASR_NOT_AVAILABLE', `找不到识别脚本：${ASR_SCRIPT}`, {
        hint: '设置 BILI_ASR_SCRIPT'
      })
    }

    const t0 = Date.now()
    // 4 分钟封顶：实测一个 3 分钟视频转前 180 秒约 75s，正常不会到 240s。
    // 原来给 10 分钟，结果有一次跑了 5 分 42 秒还没结束、把值班拖到超时（2026-10-23 实测）。
    const timeout = Number(process.env.BILI_ASR_TIMEOUT_MS) || 240000

    // ⚠️ BV 号/链接由**我们自己**下音频，再交给识别脚本读本地文件。
    //    原因：V1 的 asr.py 内部用 yt-dlp，2026-10-22 实测被 B站挡成 HTTP 412；
    //    而我们本来就有带 Cookie 的请求头，走 playurl 更稳。
    let localTarget = target
    let tmpDir = null
    let audioInfo = null
    try {
      if (/^BV[0-9A-Za-z]{10}$/.test(target) || /^https?:\/\//i.test(target)) {
        const { bvid, page } = parseBvid(target)
        const v = await getVideo(bvid)
        const cid = v.pages?.find((p) => p.page === page)?.cid || v.cid
        const a = await getAudioUrl(bvid, cid)
        tmpDir = await mkdtemp(join(tmpdir(), 'asr-'))
        localTarget = join(tmpDir, `${bvid}.m4s`)
        const dl = await downloadAudio(a.url, localTarget)
        audioInfo = { bvid, cid, bytes: dl.bytes, durationSec: a.durationSec, bandwidth: a.bandwidth }
      }

      // ── 引擎选择 ────────────────────────────────────────────────────────
      // SenseVoice（sherpa-onnx）实测 180 秒音频 **19 秒**，faster-whisper 要 75 秒，
      // 而且 SenseVoice 自带标点。所以默认优先进 SenseVoice，失败再落 whisper。
      //   BILI_ASR_ENGINE=sense|whisper|auto（默认 auto）
      const ENGINE = String(process.env.BILI_ASR_ENGINE || 'auto').toLowerCase()
      const SENSE_SCRIPT = join(dirname(ASR_SCRIPT), 'asr_sense.py')
      const SENSE_MODEL = join(dirname(dirname(ASR_SCRIPT)), 'models', 'sensevoice', 'model.int8.onnx')
      const senseReady = existsSync(SENSE_SCRIPT) && existsSync(SENSE_MODEL)

      const plan = []
      if (ENGINE !== 'whisper' && senseReady) {
        plan.push({ name: 'sensevoice', argv: [SENSE_SCRIPT, localTarget, '--lang', lang, '--max-seconds', String(maxSeconds)] })
      }
      if (ENGINE !== 'sense') {
        plan.push({ name: 'whisper', argv: [ASR_SCRIPT, localTarget, '--model', model, '--lang', lang, '--max-seconds', String(maxSeconds)] })
      }
      if (!plan.length) {
        throw httpError('ASR_NOT_AVAILABLE', '没有可用的识别引擎', { engine: ENGINE, senseReady })
      }

      let stdout = ''
      let usedEngine = ''
      let lastError = null
      try {
        for (const step of plan) {
          try {
            const r = await execFileP(ASR_PY, step.argv, {
              cwd: ASR_CWD,
              timeout,
              maxBuffer: 32 * 1024 * 1024,
              env: { ...process.env, BILI_ASR_HF_HOME: ASR_HF_HOME }
            })
            stdout = String(r.stdout || '')
            usedEngine = step.name
            break
          } catch (err) {
            // 一个引擎失败就换下一个；全挂了才把最后一个错误抛出去
            lastError = err
            if (step !== plan[plan.length - 1]) continue
          }
        }
        if (!stdout && lastError) throw lastError
      } catch (e) {
        const msg = String(e?.message || e)
        const killed = e?.killed || /ETIMEDOUT/.test(msg)
        // 识别脚本把真实原因打在 stderr，剥出来给模型看（否则只有一句 "Command failed"）
        const errTail = String(e?.stderr || '')
          .split('\n')
          .filter((l) => l.trim() && !/^\s*$/.test(l))
          .slice(-3)
          .join(' | ')
        throw httpError(
          killed ? 'ASR_TIMEOUT' : 'ASR_FAILED',
          killed
            ? `识别超时（>${Math.round(timeout / 1000)}s）`
            : `识别失败：${errTail ? errTail.slice(0, 240) : msg.slice(0, 240)}`,
          { target, model, maxSeconds, audio: audioInfo, hint: '可先把 maxSeconds 调小；也可在服务器手动跑 asr_v2.py 排查' }
        )
      }

      const parsed = parseOut(stdout)
      const ms = Date.now() - t0
      const text = String((parsed ? parsed.text : stdout) || '').trim()
      const limit = Number(process.env.BILI_ASR_MAX_CHARS) || 12000
      const truncated = text.length > limit

      return {
        ok: true,
        target,
        audio: audioInfo,
        model: parsed?.modelFallback?.used || parsed?.model || model,
        modelFallback: parsed?.modelFallback || modelFallback,
        lang: parsed?.lang || lang,
        // 转了多少、是不是只转了一部分 —— 让模型知道自己的结论边界
        durationSec: parsed?.durationSec || null,
        coveredSec: parsed?.coveredSec || null,
        partial: parsed?.partial ?? maxSeconds > 0,
        ms,
        chars: text.length,
        segments: parsed?.segments ?? null,
        truncated,
        text: truncated ? text.slice(0, limit) + `\n…（已截断，原文 ${text.length} 字）` : text,
        note: truncated
          ? `音频转写共 ${text.length} 字，超出上限只保留前 ${limit} 字。结论请限定在已读范围内。`
          : parsed?.partial
            ? `只转写了前 ${Math.round(parsed.coveredSec || maxSeconds)} 秒（全长 ${Math.round(parsed.durationSec || 0)} 秒）。后面没听到的部分不要猜。`
            : '这是本地 whisper 转写，专有名词可能有误，关键人名/数字建议回查字幕或画面。'
      }
    } finally {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
