/**
 * 全局错误处理中间件模板
 * Task D-E: HTTP Gateway & Routing
 * 
 * 职责：
 * - 捕获所有未处理的同步和异步错误
 * - 统一错误响应格式
 * - 根据错误类型返回合适的 HTTP 状态码
 * - 记录详细错误日志（生产环境隐藏敏感信息）
 * 
 * 错误码映射：
 * - 1xxx: 通用错误（400 或 500）
 * - 2xxx: 密钥错误（500）
 * - 3xxx: 模型错误（502 或 503）
 * - 4xxx: 工具错误（400 或 404）
 * - 5xxx: 网关错误（500）
 * - 6xxx: 集成错误（502）
 */

/**
 * 错误日志节流表：同 code+status 在窗口内只打一次，其余计数合并。
 * 真实教训（2026-10-22 压测）：错误风暴下每个 4xx 都带完整堆栈刷屏，
 * 若 stdout/stderr 是管道且消费不及时（pm2/docker exec/测试 harness），
 * 管道缓冲写满会直接阻塞进程事件循环，表现为「整个服务冻结」。
 */
import { redactText, redactData, registerSecrets, urlSecrets } from '../runtime.mjs'

const logThrottle = new Map()
const LOG_THROTTLE_MS = 5000

function shouldLog(code, status) {
  const key = `${code}:${status}`
  const hit = logThrottle.get(key)
  const now = Date.now()
  if (!hit || now - hit.last >= LOG_THROTTLE_MS) {
    logThrottle.set(key, { last: now, suppressed: 0 })
    if (hit?.suppressed) console.warn(`[Error] ↑ 同类错误(${key})近 5s 静默 ${hit.suppressed} 条`)
    return true
  }
  hit.suppressed++
  hit.last = now // 持续风暴时保持窗口滑动
  return false
}

/** 4xx 属客户端错误：一行摘要即可，不打堆栈 */
function isClientStatus(status) {
  return status >= 400 && status < 500
}

/**
 * 全局错误处理中间件
 * @param {Error} err - 错误对象
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function errorHandler(err, req, res, next) {
  registerSecrets([...(req.headers?.authorization ? [req.headers.authorization, req.headers.authorization.split(' ').slice(1).join(' ')] : []), ...urlSecrets(req.originalUrl || req.url)])
  // 提取错误信息
  const errorCode = err.code || 'INTERNAL_ERROR'
  const errorMessage = redactText(err.message || '服务器内部错误')
  const statusCode = determineStatusCode(err, errorCode)

  // 记录错误详情（带节流；5xx 或开发环境才带堆栈）
  // 预警邮件：5xx（以及配置里打开的通道故障）异步发一封，绝不阻塞响应。
  // 动态 import 避免 error.mjs 与 notifier.mjs 之间形成静态循环依赖。
  if (statusCode >= 500) {
    import('../notifier.mjs')
      .then((m) => m.alertError({ code: errorCode, status: statusCode, message: errorMessage, method: req.method, url: req.originalUrl || req.url }))
      .catch(() => {})
  }

  if (shouldLog(errorCode, statusCode)) {
    const brief = {
      message: errorMessage,
      code: errorCode,
      status: statusCode,
      method: req.method,
      url: redactText(req.url),
      timestamp: new Date().toISOString()
    }
    if (statusCode >= 500) { brief.stack = redactText(err.stack) }
    const emit = statusCode >= 500 ? console.error : console.warn
    emit('[Error]', brief)
  }

  // 已发送响应则跳过
  if (res.headersSent) {
    return next(err)
  }

  // 构建错误响应
  const response = {
    error: errorMessage,
    code: errorCode,
    timestamp: Date.now()
  }

  // 开发环境附加堆栈信息
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    response.stack = redactText(err.stack).split('\n').slice(0, 5) // 只返回前 5 行
  }

  // 附加额外数据（若有）
  if (err.data) {
    response.data = redactData(err.data)
  }

  res.status(statusCode).json(response)
}

/**
 * 根据错误对象和错误码确定 HTTP 状态码
 * @param {Error} err
 * @param {string} code
 * @returns {number}
 */
function determineStatusCode(err, code) {
  // 显式状态码优先
  if (err.statusCode) {
    return err.statusCode
  }

  // 根据错误码名称映射（对照 shared/error-codes.md）
  const codeToStatus = {
    // 通用错误（1xxx）
    'UNKNOWN_ERROR': 500,
    'INVALID_ARGUMENT': 400,
    // 2026-10-22：人格/记忆/调度模块统一用 INVALID_REQUEST 表示「调用方参数不对」，
    // 之前没进映射表，会被压成 500，前端分不清「我传错了」还是「服务炸了」
    'INVALID_REQUEST': 400,
    'MISSING_REQUIRED': 400,
    'NOT_FOUND': 404,
    'PERMISSION_DENIED': 403,
    'RATE_LIMITED': 429,

    // 密钥管理错误（2xxx）
    'SECRET_NOT_FOUND': 500,
    'SECRET_INVALID': 500,
    'SECRET_LOAD_FAILED': 500,

    // 模型路由错误（3xxx）
    'NO_CHANNEL': 503,
    'CHANNEL_TIMEOUT': 504,
    'CHANNEL_FAILED': 502,
    'ALL_CHANNELS_FAILED': 502,
    // 工具循环没收敛（模型一直要调工具）：502 表示上游行为异常，不是调用方参数错
    'TOOL_LOOP_EXCEEDED': 502,

    // 工具引擎错误（4xxx）
    'TOOL_NOT_FOUND': 404,
    'TOOL_EXECUTE_FAILED': 500,
    'TOOL_EXECUTION_ERROR': 500,  // Task C 实际抛出的错误码
    'CONFIG_INVALID': 400,
    'CONFIG_LOAD_FAILED': 500,
    'UNKNOWN_PARAMETER': 400,
    'TOKEN_BUDGET': 429,

    // 人格 / 记忆 / 值班调度（2026-10-22 新增，Task I）
    'LEGACY_NOT_MIGRATED': 503,   // V1 数据还没迁过来
    'LEGACY_WRITE_FAILED': 500,
    'SETTINGS_WRITE_FAILED': 500,
    'SCHEDULER_BUSY': 409,        // 上一轮还在跑，拒绝重入
    'SCHEDULER_NO_ENGINE': 503,
    'DUTY_FAILED': 502,
    // 视觉 / 本地识别
    'BILI_FRAMES_FAILED': 502,
    'ASR_NOT_AVAILABLE': 503,
    'ASR_TIMEOUT': 504,
    'ASR_FAILED': 502,

    // 网关 / 认证错误（5xxx）
    'AUTH_FAILED': 401,
    'SESSION_EXPIRED': 401,
    'SESSION_INVALID': 401,
    'RATE_LIMITED_AUTH': 429,

    // 外部集成错误（6xxx）
    'XHS_SIGN_FAILED': 502,
    'XHS_AUTH_REQUIRED': 401,
    'XHS_FORBIDDEN': 403,
    'BROWSER_NOT_READY': 503,
    'BROWSER_TIMEOUT': 504,

    // 抓取 / 搜索工具（7xxx）
    'URL_INVALID': 400,
    'TARGET_BLOCKED': 403,
    'FETCH_FAILED': 502,
    'FETCH_TIMEOUT': 504,
    'FETCH_TOO_LARGE': 413,
    'UPSTREAM_HTTP_ERROR': 502,
    'PARSE_FAILED': 502,
    'EMPTY_RESULT': 404,

    // B 站工具（8xxx）
    'BILI_INVALID_BVID': 400,
    'BILI_AUTH_REQUIRED': 403,
    'BILI_NOT_FOUND': 404,
    'BILI_API_ERROR': 502,
    'BILI_RISK_CONTROL': 429,

    // 本地文件工具（9xxx）
    'FILE_NOT_FOUND': 404,
    'FILE_IS_DIRECTORY': 400,
    'FILE_ACCESS_DENIED': 403,
    'FILE_TOO_LARGE': 413,
    'FILE_BINARY': 415,
    'FILE_READ_FAILED': 500,
    'FILE_SECRET_BLOCKED': 403
  }

  if (code && codeToStatus[code]) {
    return codeToStatus[code]
  }

  // 特定错误名称映射
  if (err.name === 'ValidationError') return 400
  if (err.name === 'UnauthorizedError') return 401
  if (err.name === 'ForbiddenError') return 403
  if (err.name === 'NotFoundError') return 404
  if (err.name === 'ConflictError') return 409
  if (err.name === 'TooManyRequestsError') return 429

  // 默认 500
  return 500
}

/**
 * 404 Not Found 处理器
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: '请求的资源不存在',
    code: 'ROUTE_NOT_FOUND',
    path: req.path,
    method: req.method,
    timestamp: Date.now()
  })
}
