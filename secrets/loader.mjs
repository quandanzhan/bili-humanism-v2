/**
 * 统一密钥加载器
 * @module secrets/loader
 * ============================================================================
 * 设计目标：统一管理所有密钥，不再硬编码在源码里。
 *
 * 密钥来源：
 *   · B站 Cookie     —— BILI_CREDENTIAL 指定的 JSON 文件
 *   · 模型 API Key   —— 环境变量，或 SERVICE_ENV 指定的文件
 *   · 会话密钥        —— 环境变量 SESSION_SECRET（缺失时生成临时密钥并警告）
 *   · 登录认证        —— 环境变量 AUTH_USER / AUTH_SALT / AUTH_HASH（缺失时禁止登录并警告）
 *   · 插件配置        —— PLUGINS_FILE 指定的 JSON 文件
 *
 * 约束（验收清单要求）：
 *   · 所有字段都有默认值，任何读取失败都不会抛异常（只 console.warn）
 *   · 文件路径全部可用环境变量覆盖，源码内无业务密钥硬编码
 *   · auth 不提供固定凭据；缺少完整配置时保持不可登录
 *
 * 使用方式：
 *   import { loadSecrets } from './loader.mjs'
 *   const secrets = await loadSecrets()
 *   // 只将密钥传给需要它的模块，不记录密钥值
 */

import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DATA_DIR } from '../gateway/runtime.mjs'

// 默认与账号路由共用项目数据目录，允许显式路径覆盖。
export const BILI_CRED_FILE = process.env.BILI_CREDENTIAL || join(DATA_DIR, 'bili_credential.json')
const SERVICE_ENV_FILE = process.env.SERVICE_ENV || ''
const PLUGINS_FILE = process.env.PLUGINS_FILE || join(DATA_DIR, 'plugins.json')

/**
 * 加载 B站 Cookie（SESSDATA / bili_jct / buvid3 / DedeUserID）
 * @private
 * @returns {{ SESSDATA: string, bili_jct: string, buvid3: string, DedeUserID: string }}
 */
function loadBiliCred() {
  try {
    const text = readFileSync(BILI_CRED_FILE, 'utf8')
    const json = JSON.parse(text)

    // ⚠️ 线上凭据文件用的是小写字段（sessdata / dedeuserid），
    //    早期版本只读大写键，会把 SESSDATA 解析成空字符串 —— 表现为「配置了 Cookie
    //    但搜索仍 403/风控」。这里两种写法都认，缺一个就换另一个。
    const pick = (...keys) => {
      for (const k of keys) {
        const v = json[k]
        if (typeof v === 'string' && v.trim()) return v.trim()
      }
      return ''
    }

    return {
      SESSDATA: pick('SESSDATA', 'sessdata'),
      bili_jct: pick('bili_jct', 'biliJct', 'BILI_JCT'),
      buvid3: pick('buvid3', 'BUVID3', 'buvid_3'),
      DedeUserID: pick('DedeUserID', 'dedeuserid', 'DEDEUSERID', 'uid')
    }
  } catch (e) {
    console.warn('[secrets] 无法读取 B站 Cookie，部分功能可能不可用')
    console.warn('[secrets] 读取失败，请检查文件路径、权限和格式')
    return { SESSDATA: '', bili_jct: '', buvid3: '', DedeUserID: '' }
  }
}

/**
 * 加载模型 API Key（从 .env 风格文件按 KEY=VALUE 解析）
 * @private
 * @returns {{ AMD_API_KEY?: string, DEEPSEEK_API_KEY?: string, MODELSCOPE_API_KEY?: string }}
 */
function loadModelsEnv() {
  let kv = {}
  try {
    const text = readFileSync(SERVICE_ENV_FILE, 'utf8')
    for (const line of text.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (m) kv[m[1]] = m[2].trim()
    }
  } catch {
    console.warn('[secrets] 模型密钥文件未读取，使用环境变量或空配置')
  }
  return {
    AMD_API_KEY: process.env.AMD_API_KEY || kv.AMD_API_KEY || '',
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || kv.DEEPSEEK_API_KEY || '',
    MODELSCOPE_API_KEY: process.env.MODELSCOPE_API_KEY || kv.MODELSCOPE_API_KEY || ''
  }
}

/**
 * 加载会话密钥（从环境变量 SESSION_SECRET 读取）
 * 未设置时生成 32 字节随机密钥（64 字符 hex）并警告用户写入环境变量，
 * 否则服务重启后所有会话都会失效。
 * @private
 * @returns {{ SECRET: string, TTL_MS: number }}
 */
let temporarySessionSecret = ''

function loadSession() {
  let SECRET = process.env.SESSION_SECRET || ''
  if (!SECRET) {
    temporarySessionSecret ||= randomBytes(32).toString('hex')
    SECRET = temporarySessionSecret
    console.warn('[secrets] 未设置 SESSION_SECRET，正在使用进程内临时密钥，重启后会话将失效')
    console.warn('[secrets] 请自行生成持久 SESSION_SECRET 并通过环境变量设置；临时密钥不会写入日志')
  }
  return {
    SECRET,
    TTL_MS: Number(process.env.SESSION_TTL_MS) || 7 * 24 * 3600 * 1000
  }
}

/**
 * 加载登录认证（从环境变量 AUTH_USER / AUTH_SALT / AUTH_HASH 读取）
 * 缺少完整配置时返回不可登录的随机认证字段，并警告。
 * 部署时必须设置全部认证变量（见 .env.template）。
 * @private
 * @returns {{ USER: string, SALT: string, HASH: string }}
 */
function loadAuth() {
  const USER = process.env.AUTH_USER || ''
  const SALT = process.env.AUTH_SALT || ''
  const HASH = process.env.AUTH_HASH || ''
  if (USER && SALT && HASH) return { USER, SALT, HASH }

  console.warn('[secrets] AUTH_USER / AUTH_SALT / AUTH_HASH 未配置完整，登录已禁用')
  return { USER: '', SALT: randomBytes(16).toString('hex'), HASH: randomBytes(64).toString('hex') }
}

/**
 * 加载插件配置（小红书 Cookie 等，从 plugins.json）
 * @private
 * @returns {{ xhs: { cookie: string, enabled: boolean } }}
 */
function loadPlugins() {
  try {
    const text = readFileSync(PLUGINS_FILE, 'utf8')
    const json = JSON.parse(text)
    return {
      xhs: {
        cookie: json.xhs?.cookie || '',
        enabled: json.xhs?.enabled === true
      }
    }
  } catch (e) {
    console.warn('[secrets] 无法读取插件配置，外部集成功能可能不可用')
    return { xhs: { cookie: '', enabled: false } }
  }
}

/**
 * 加载所有密钥
 * @returns {Promise<{
 *   bili: { SESSDATA: string, bili_jct: string, buvid3: string, DedeUserID: string },
 *   models: { AMD_API_KEY?: string, DEEPSEEK_API_KEY?: string, MODELSCOPE_API_KEY?: string },
 *   session: { SECRET: string, TTL_MS: number },
 *   auth: { USER: string, SALT: string, HASH: string },
 *   plugins: { xhs: { cookie: string, enabled: boolean } }
 * }>}
 */
export async function loadSecrets() {
  return {
    bili: loadBiliCred(),
    models: loadModelsEnv(),
    session: loadSession(),
    auth: loadAuth(),
    plugins: loadPlugins()
  }
}
