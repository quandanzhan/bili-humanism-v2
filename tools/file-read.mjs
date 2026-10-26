/**
 * 工具：本地文件读取（路径 → 内容）
 * ============================================================================
 * 输入：文件路径（绝对路径，或相对**进程工作目录**的路径）
 * 输出：文本内容 + 大小/编码/行数等元信息
 *
 * 支持场景：
 *   · 常见日志文本：.log / .txt / .out / .err（自动去掉 ANSI 颜色码、超长行可截断）
 *   · 配置与代码：.json / .jsonl / .csv / .tsv / .yml / .yaml / .ini / .conf / .env / .md / .mjs / .py
 *   · 中文编码混杂：utf-8 解析失败会自动回退 gbk（Windows 日志常见）
 *   · 大文件：默认最多读 256KB；tail=true 时读**末尾**（看日志尾部最常用）
 *
 * 失败提示（每条都带 hint，告诉调用方怎么改）：
 *   FILE_NOT_FOUND     路径不存在（会回显解析后的绝对路径与当前 cwd）
 *   FILE_IS_DIRECTORY  传了目录（提示改用具体文件）
 *   FILE_ACCESS_DENIED 无权限
 *   FILE_BINARY        二进制文件（检测到 NUL 字节），拒绝按文本返回
 *   FILE_SECRET_BLOCKED 命中敏感文件名单（凭据/env/私钥），需显式 allowSecret=true
 *   FILE_READ_FAILED   其它读取异常
 */

import fs from 'node:fs'
import path from 'node:path'
import { httpError } from '../integrations/fetch-client.mjs'

/** 默认拒绝读取的敏感文件（避免把密钥/凭据喂给模型） */
const SECRET_PATTERNS = [
  /bili[-_]?credential\.json$/i,
  /(^|\/)service\.env$/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)id_rsa(\.|$)/i,
  /\.(pem|p12|pfx|keystore)$/i,
  /(^|\/)models\.json$/i,
  /(^|\/)secrets?\/(loader\.mjs)?$/i
]

/** 已知文本扩展名 */
const TEXT_EXT = new Set([
  '.log', '.txt', '.out', '.err', '.json', '.jsonl', '.ndjson', '.csv', '.tsv',
  '.yml', '.yaml', '.ini', '.conf', '.cfg', '.env', '.md', '.markdown', '.sql',
  '.mjs', '.js', '.cjs', '.ts', '.py', '.sh', '.bash', '.ps1', '.html', '.css', '.xml'
])

/**
 * 去掉 ANSI 颜色/控制序列（日志文件常见）
 * @param {string} s
 * @returns {string}
 */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

/**
 * 尝试解码
 * @param {Buffer} buf
 * @param {'auto'|'utf8'|'gbk'|'utf16le'} encoding
 * @returns {{ text: string, encoding: string }}
 */
function decode(buf, encoding) {
  if (encoding === 'utf8') return { text: buf.toString('utf8'), encoding: 'utf8' }
  if (encoding === 'gbk') {
    try {
      return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk' }
    } catch {
      return { text: buf.toString('utf8'), encoding: 'utf8(fallback)' }
    }
  }
  if (encoding === 'utf16le') return { text: buf.toString('utf16le'), encoding: 'utf16le' }

  // auto：先严格 utf-8，失败再 gbk
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }
  } catch {
    try {
      return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk' }
    } catch {
      return { text: buf.toString('utf8'), encoding: 'utf-8(loose)' }
    }
  }
}

/**
 * 读取文件尾部 N 字节
 * @param {string} filePath
 * @param {number} bytes
 * @returns {Promise<Buffer>}
 */
async function readTail(filePath, bytes) {
  const fh = await fs.promises.open(filePath, 'r')
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - bytes)
    const len = size - start
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, start)
    return buf
  } finally {
    await fh.close()
  }
}

export default {
  name: 'file_read',
  description: '读取本地文本/日志文件内容（支持 utf-8/gbk 自动识别、读末尾、去 ANSI 色码），路径无效或读取失败会给出明确原因。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（绝对路径，或相对进程工作目录）' },
      maxBytes: { type: 'number', description: '最多读取字节数，默认 262144（256KB），上限 4194304（4MB）' },
      tail: { type: 'boolean', description: '是否读取文件末尾（看日志用），默认 false' },
      maxLines: { type: 'number', description: '最多返回行数，默认 2000' },
      offset: { type: 'number', description: '从第几行开始（0 起），默认 0' },
      encoding: { type: 'string', description: '编码：auto（默认）/ utf8 / gbk / utf16le', enum: ['auto', 'utf8', 'gbk', 'utf16le'] },
      stripAnsiCodes: { type: 'boolean', description: '是否去掉终端颜色码，默认 true' },
      maxLineLength: { type: 'number', description: '单行最大长度，超出截断，默认 2000' },
      allowSecret: { type: 'boolean', description: '允许读取凭据/env/私钥类文件，默认 false' }
    },
    required: ['path']
  },
  /**
   * @param {object} args
   * @returns {Promise<string>} JSON 字符串
   */
  async execute(args = {}) {
    const rawPath = String(args.path ?? '').trim()
    if (!rawPath) {
      throw httpError('INVALID_ARGUMENT', 'path 不能为空', { cwd: process.cwd() })
    }

    // Windows 路径里的 \ 在 JSON 里常被转义坏，这里统一成 /
    const cleaned = rawPath.replace(/\\\\/g, '/')
    const abs = path.resolve(process.cwd(), cleaned)

    // 敏感文件拦截
    if (!args.allowSecret && SECRET_PATTERNS.some(re => re.test(abs.replace(/\\/g, '/')))) {
      throw httpError('FILE_SECRET_BLOCKED', '该文件属于凭据/密钥类，默认拒绝读取', {
        path: abs,
        hint: '确需读取请显式传 allowSecret=true；切勿把内容回传给模型或写入日志'
      })
    }

    // 存在性与类型
    let st
    try {
      st = await fs.promises.stat(abs)
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw httpError('FILE_NOT_FOUND', `文件不存在：${abs}`, {
          path: abs,
          input: rawPath,
          cwd: process.cwd(),
          hint: '检查路径拼写；相对路径是相对服务进程的工作目录，不是相对项目根'
        })
      }
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        throw httpError('FILE_ACCESS_DENIED', `无权访问：${abs}`, { path: abs, hint: '检查文件权限或用有权限的账号运行服务' })
      }
      throw httpError('FILE_READ_FAILED', `读取失败：${err.message}`, { path: abs, sysCode: err.code })
    }

    if (st.isDirectory()) {
      throw httpError('FILE_IS_DIRECTORY', `这是一个目录，不是文件：${abs}`, {
        path: abs,
        hint: '请指定目录下的具体文件'
      })
    }

    const maxBytes = Math.min(Math.max(Number(args.maxBytes) || 262144, 1024), 4 * 1024 * 1024)
    const maxLines = Math.min(Math.max(Number(args.maxLines) || 2000, 1), 20000)
    const offset = Math.max(Number(args.offset) || 0, 0)
    const maxLineLength = Math.min(Math.max(Number(args.maxLineLength) || 2000, 80), 20000)
    const useTail = Boolean(args.tail)

    // 读取（大文件只读首/尾一段）
    let buf
    let truncatedByBytes = false
    try {
      if (st.size > maxBytes) {
        truncatedByBytes = true
        if (useTail) {
          buf = await readTail(abs, maxBytes)
        } else {
          const fh = await fs.promises.open(abs, 'r')
          try {
            buf = Buffer.alloc(maxBytes)
            await fh.read(buf, 0, maxBytes, 0)
          } finally {
            await fh.close()
          }
        }
      } else {
        buf = await fs.promises.readFile(abs)
      }
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        throw httpError('FILE_ACCESS_DENIED', `无权读取：${abs}`, { path: abs })
      }
      throw httpError('FILE_READ_FAILED', `读取失败：${err.message}`, { path: abs, sysCode: err.code })
    }

    // 二进制检测（前 4KB 出现 NUL 即视为二进制）
    const probe = buf.subarray(0, 4096)
    if (probe.includes(0)) {
      throw httpError('FILE_BINARY', '这是二进制文件，不能按文本读取', {
        path: abs,
        sizeBytes: st.size,
        hint: '仅支持文本/日志格式；二进制请用专门的解析器'
      })
    }

    const { text: decoded, encoding } = decode(buf, String(args.encoding || 'auto'))
    let text = args.stripAnsiCodes === false ? decoded : stripAnsi(decoded)

    // 行处理
    const allLines = text.split(/\r\n|\n|\r/)
    const totalLines = allLines.length
    let lines = allLines.slice(offset, offset + maxLines)
    lines = lines.map(l => (l.length > maxLineLength ? l.slice(0, maxLineLength) + `…[+${l.length - maxLineLength}]` : l))
    text = lines.join('\n')

    const ext = path.extname(abs).toLowerCase()
    return JSON.stringify(
      {
        path: abs,
        kind: TEXT_EXT.has(ext) ? ext.slice(1) : (ext ? ext.slice(1) : 'unknown'),
        sizeBytes: st.size,
        encoding,
        isLog: ['.log', '.out', '.err'].includes(ext),
        readMode: useTail ? 'tail' : 'head',
        totalLines,
        returnedLines: lines.length,
        lineOffset: offset,
        truncated: truncatedByBytes || offset + lines.length < totalLines,
        truncatedByBytes,
        modifiedAt: st.mtime.toISOString(),
        content: text
      },
      null,
      2
    )
  }
}
