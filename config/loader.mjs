/**
 * 配置加载器（支持热重载）
 * ============================================================================
 * 用途：加载 JSON 配置文件并监听变化，变化时自动触发回调
 * 模块：config/loader
 */

import fs from 'fs'

/** 当前活跃的监听器（同时只允许一个） */
let watcher = null

/** 默认配置文件路径 */
const DEFAULT_CONFIG_PATH = './config.json'

/**
 * 加载 JSON 配置文件
 * @param {string} [configPath] - 配置文件路径
 * @returns {Promise<Object>} 配置对象；文件不存在时返回空对象 {}
 * @throws {Error} JSON 解析失败或读取失败时抛出（code: CONFIG_INVALID / CONFIG_LOAD_FAILED）
 */
export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  let raw
  try {
    raw = await fs.promises.readFile(configPath, 'utf-8')
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn(`[config] ⚠ 配置文件不存在: ${configPath}，返回空配置`)
      return {}
    }
    const err = new Error(`配置文件读取失败: ${configPath}`)
    err.code = 'CONFIG_LOAD_FAILED'
    err.data = { path: configPath, originalError: e.message }
    throw err
  }

  try {
    return JSON.parse(raw)
  } catch (e) {
    const err = new Error(`配置文件 JSON 解析失败: ${configPath}`)
    err.code = 'CONFIG_INVALID'
    err.data = { path: configPath, originalError: 'JSON 解析失败' }
    throw err
  }
}

/**
 * 监听配置文件变化，变化时触发回调
 * 重复调用时会自动停止旧监听器
 * @param {string} configPath - 配置文件路径
 * @param {Function} onChange - 变化回调 (newConfig: Object) => void
 */
export function watchConfig(configPath, onChange) {
  if (watcher) {
    console.warn('[config] ⚠ 已有监听器在运行，先停止旧监听器')
    stopWatch()
  }

  console.log(`[config] 开始监听配置文件: ${configPath}`)

  watcher = fs.watch(configPath, async (eventType) => {
    if (eventType === 'change') {
      console.log('[config] 检测到配置文件变化，重新加载...')
      try {
        const newConfig = await loadConfig(configPath)
        onChange(newConfig)
      } catch (e) {
        console.error(`[config] ✗ 热重载失败: ${e.message}`)
      }
    }
  })
}

/**
 * 停止配置文件监听
 */
export function stopWatch() {
  if (watcher) {
    watcher.close()
    watcher = null
    console.log('[config] ✓ 已停止配置监听')
  }
}
