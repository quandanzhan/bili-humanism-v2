/**
 * 工具扫描器
 * ============================================================================
 * 用途：自动扫描指定目录下的所有 .mjs / .js 工具模块
 * 模块：tools/scanner
 */

import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

/** 可识别的工具文件扩展名 */
const TOOL_EXTENSIONS = ['.mjs', '.js']

/**
 * 扫描工具目录，加载所有有效工具
 * 有效工具 = 默认导出对象且包含 name（string）和 execute（function）
 *
 * @param {string} toolsDir - 工具目录路径
 * @returns {Promise<Array<Object>>} 有效工具数组
 * @throws {Error} 目录不存在时抛出错误（code: NOT_FOUND）
 */
export async function scanTools(toolsDir) {
  const tools = []

  let entries
  try {
    entries = await fs.promises.readdir(toolsDir, { withFileTypes: true })
  } catch (e) {
    const err = new Error(`工具目录不存在或无法读取: ${toolsDir}`)
    err.code = 'NOT_FOUND'
    err.data = { dir: toolsDir, originalError: e.message }
    throw err
  }

  // 只处理 .mjs / .js 文件，自动过滤 .txt / .json 等非 JS 文件
  const jsFiles = entries.filter(e =>
    e.isFile() && TOOL_EXTENSIONS.includes(path.extname(e.name))
  )

  for (const file of jsFiles) {
    const fullPath = path.join(toolsDir, file.name)
    const fileURL = pathToFileURL(path.resolve(fullPath)).href

    try {
      const mod = await import(fileURL)

      if (mod.default && mod.default.name && typeof mod.default.execute === 'function') {
        tools.push(mod.default)
        console.log(`[scanner] ✓ 发现工具: ${mod.default.name} (${file.name})`)
      } else {
        console.warn(`[scanner] ⚠ ${file.name} 不是有效工具（缺少 default.name 或 default.execute）`)
      }
    } catch (e) {
      // 单个工具加载失败时打印警告但继续扫描，不中断
      console.error(`[scanner] ✗ 加载 ${file.name} 失败: ${e.message}`)
    }
  }

  return tools
}
