/**
 * Gateway 网关测试
 * Task D-E: HTTP Gateway & Routing
 * 运行：node templates/tests/gateway.test.mjs
 * 
 * 测试覆盖：
 * - CORS 中间件响应头
 * - 错误处理中间件（determineStatusCode 映射）
 * - 404 处理
 * - 请求日志
 */

import { suite, assertEqual, assert } from '../../shared/test-utils.mjs'
import { corsMiddleware } from '../middleware/cors.mjs'
import { errorHandler, notFoundHandler } from '../middleware/error.mjs'

// ========== Mock 函数 ==========

function mockRequest({ method = 'GET', path = '/', url = '/', headers = {} } = {}) {
  return { method, path, url, headers }
}

function mockResponse() {
  const headers = {}
  let statusCode = 200
  let jsonData = null
  let ended = false
  
  return {
    header(key, value) {
      headers[key] = value
      return this
    },
    status(code) {
      statusCode = code
      return this
    },
    json(data) {
      jsonData = data
      ended = true
      return this
    },
    end() {
      ended = true
      return this
    },
    sendStatus(code) {
      statusCode = code
      ended = true
      return this
    },
    getHeader(key) { return headers[key] },
    getAllHeaders() { return headers },
    getStatus() { return statusCode },
    getJSON() { return jsonData },
    isEnded() { return ended }
  }
}

function mockNext() {
  let called = false
  let error = null
  return {
    fn(err) {
      called = true
      error = err
    },
    wasCalled() { return called },
    getError() { return error }
  }
}

// ========== 测试用例 ==========

const tests = {
  'CORS - 白名单来源应回显 Origin 并允许凭据': async () => {
    // 白名单版：不再发 *（* + credentials 会被浏览器拒绝）
    const origin = 'http://localhost:5173'
    const req = mockRequest({ headers: { origin } })
    const res = mockResponse()
    const next = mockNext()

    corsMiddleware()(req, res, next.fn)

    assertEqual(res.getHeader('Access-Control-Allow-Origin'), origin)
    assertEqual(res.getHeader('Access-Control-Allow-Credentials'), 'true')
    assertEqual(res.getHeader('Vary'), 'Origin')
    assert(res.getHeader('Access-Control-Allow-Methods').includes('PATCH'))
    assert(res.getHeader('Access-Control-Allow-Headers').includes('Authorization'))
    assertEqual(next.wasCalled(), true)
  },

  'CORS - 未知来源不下发 Allow-Origin': async () => {
    const req = mockRequest({ headers: { origin: 'http://evil.example.com' } })
    const res = mockResponse()
    const next = mockNext()

    corsMiddleware()(req, res, next.fn)

    assertEqual(res.getHeader('Access-Control-Allow-Origin'), undefined)
    assertEqual(res.getHeader('Vary'), 'Origin')
    assertEqual(next.wasCalled(), true)
  },

  'CORS - 无 Origin（同源/curl）不下发任何 CORS 头': async () => {
    const req = mockRequest()
    const res = mockResponse()
    const next = mockNext()

    corsMiddleware()(req, res, next.fn)

    assertEqual(res.getHeader('Access-Control-Allow-Origin'), undefined)
    assertEqual(res.getHeader('Vary'), undefined)
    assertEqual(next.wasCalled(), true)
  },

  'CORS - CORS_HAVP=1 时放行环境变量指定的附加域名': async () => {
    const prev = process.env.CORS_HAVP
    const prevReserved = process.env.CORS_RESERVED_ORIGINS
    process.env.CORS_RESERVED_ORIGINS = 'https://console.example.com'
    process.env.CORS_HAVP = '1'
    try {
      const origin = 'https://console.example.com'
      const req = mockRequest({ headers: { origin } })
      const res = mockResponse()
      corsMiddleware()(req, res, mockNext().fn)
      assertEqual(res.getHeader('Access-Control-Allow-Origin'), origin)
    } finally {
      if (prevReserved === undefined) delete process.env.CORS_RESERVED_ORIGINS
      else process.env.CORS_RESERVED_ORIGINS = prevReserved
      if (prev === undefined) delete process.env.CORS_HAVP
      else process.env.CORS_HAVP = prev
    }
  },

  'CORS - OPTIONS 预检应返回 204 且不进入业务处理': async () => {
    const req = mockRequest({ method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } })
    const res = mockResponse()
    const next = mockNext()

    corsMiddleware()(req, res, next.fn)

    assertEqual(res.getStatus(), 204)
    assertEqual(res.isEnded(), true)
    assertEqual(next.wasCalled(), false)
  },

  '404 处理器 - 应返回正确的错误响应': async () => {
    const req = mockRequest({ path: '/nonexistent', method: 'POST' })
    const res = mockResponse()
    
    notFoundHandler(req, res)
    
    assertEqual(res.getStatus(), 404)
    assertEqual(res.getJSON().code, 'ROUTE_NOT_FOUND')
    assertEqual(res.getJSON().path, '/nonexistent')
    assertEqual(res.getJSON().method, 'POST')
  },

  '错误处理器 - TOOL_NOT_FOUND 应返回 404': async () => {
    const err = new Error('工具不存在')
    err.code = 'TOOL_NOT_FOUND'
    
    const req = mockRequest()
    const res = mockResponse()
    const next = mockNext()
    
    errorHandler(err, req, res, next.fn)
    
    assertEqual(res.getStatus(), 404)
    assertEqual(res.getJSON().code, 'TOOL_NOT_FOUND')
  },

  '错误处理器 - AUTH_FAILED 应返回 401': async () => {
    const err = new Error('认证失败')
    err.code = 'AUTH_FAILED'
    
    const req = mockRequest()
    const res = mockResponse()
    const next = mockNext()
    
    errorHandler(err, req, res, next.fn)
    
    assertEqual(res.getStatus(), 401)
    assertEqual(res.getJSON().code, 'AUTH_FAILED')
  },

  '错误处理器 - INVALID_ARGUMENT 应返回 400': async () => {
    const err = new Error('参数无效')
    err.code = 'INVALID_ARGUMENT'
    
    const req = mockRequest()
    const res = mockResponse()
    const next = mockNext()
    
    errorHandler(err, req, res, next.fn)
    
    assertEqual(res.getStatus(), 400)
  },

  '错误处理器 - CHANNEL_TIMEOUT 应返回 504': async () => {
    const err = new Error('通道超时')
    err.code = 'CHANNEL_TIMEOUT'
    
    const req = mockRequest()
    const res = mockResponse()
    const next = mockNext()
    
    errorHandler(err, req, res, next.fn)
    
    assertEqual(res.getStatus(), 504)
  },

  '错误处理器 - 未知错误应返回 500': async () => {
    const err = new Error('某个未知错误')
    
    const req = mockRequest()
    const res = mockResponse()
    const next = mockNext()
    
    errorHandler(err, req, res, next.fn)
    
    assertEqual(res.getStatus(), 500)
    assertEqual(res.getJSON().code, 'INTERNAL_ERROR')
  },

  '错误处理器 - 应包含 data 字段（若有）': async () => {
    const err = new Error('工具执行失败')
    err.code = 'TOOL_EXECUTE_FAILED'
    err.data = { tool: 'echo', input: 'test' }
    
    const req = mockRequest()
    const res = mockResponse()
    const next = mockNext()
    
    errorHandler(err, req, res, next.fn)
    
    assertEqual(res.getJSON().data.tool, 'echo')
    assertEqual(res.getJSON().data.input, 'test')
  },

  '错误处理器 - statusCode 优先级高于错误码映射': async () => {
    const err = new Error('自定义状态码')
    err.code = 'TOOL_NOT_FOUND'  // 映射到 404
    err.statusCode = 418  // 显式指定优先
    
    const req = mockRequest()
    const res = mockResponse()
    const next = mockNext()
    
    errorHandler(err, req, res, next.fn)
    
    assertEqual(res.getStatus(), 418)
  }
}

await suite('Gateway & Middleware', tests)
