/**
 * 认证模块测试
 * Task D-E: HTTP Gateway & Routing
 * 运行：node templates/tests/auth.test.mjs
 * 
 * 注意：此测试依赖实际的密钥配置（secrets/loader），需先确保密钥文件存在
 */

import { suite, assertEqual } from '../../shared/test-utils.mjs'
import { requireAuth, optionalAuth } from '../auth.mjs'

// ========== Mock 函数 ==========

function mockRequest({ headers = {} } = {}) {
  return { headers, user: null }
}

function mockResponse() {
  let statusCode = 200
  let jsonData = null
  let ended = false
  
  return {
    status(code) {
      statusCode = code
      return this
    },
    json(data) {
      jsonData = data
      ended = true
      return this
    },
    getStatus() { return statusCode },
    getJSON() { return jsonData },
    isEnded() { return ended }
  }
}

function mockNext() {
  let called = false
  return {
    fn() { called = true },
    wasCalled() { return called }
  }
}

// ========== 测试用例 ==========

const tests = {
  'requireAuth - 缺失 Authorization 头应返回 401': async () => {
    const req = mockRequest()
    const res = mockResponse()
    const next = mockNext()
    
    const middleware = requireAuth()
    await middleware(req, res, next.fn)
    
    assertEqual(res.getStatus(), 401)
    assertEqual(res.getJSON().code, 'AUTH_REQUIRED')
    assertEqual(next.wasCalled(), false)
  },

  'requireAuth - 非 Basic Auth 应返回 401': async () => {
    const req = mockRequest({ headers: { authorization: 'Bearer token123' } })
    const res = mockResponse()
    const next = mockNext()
    
    const middleware = requireAuth()
    await middleware(req, res, next.fn)
    
    assertEqual(res.getStatus(), 401)
    assertEqual(res.getJSON().code, 'AUTH_REQUIRED')
  },

  'requireAuth - Base64 解码失败应返回 401': async () => {
    const req = mockRequest({ headers: { authorization: 'Basic !!!invalid!!!' } })
    const res = mockResponse()
    const next = mockNext()
    
    const middleware = requireAuth()
    await middleware(req, res, next.fn)
    
    assertEqual(res.getStatus(), 401)
  },

  'requireAuth - 密码错误应返回 401 AUTH_FAILED': async () => {
    const wrongCredentials = Buffer.from('admin:wrongpass').toString('base64')
    const req = mockRequest({ headers: { authorization: `Basic ${wrongCredentials}` } })
    const res = mockResponse()
    const next = mockNext()
    
    const middleware = requireAuth()
    await middleware(req, res, next.fn)
    
    assertEqual(res.getStatus(), 401)
    assertEqual(res.getJSON().code, 'AUTH_FAILED')
  },

  'optionalAuth - 无认证头时继续但不设置 req.user': async () => {
    const req = mockRequest()
    const res = mockResponse()
    const next = mockNext()
    
    const middleware = optionalAuth()
    await middleware(req, res, next.fn)
    
    assertEqual(next.wasCalled(), true)
    assertEqual(req.user, null)
  },

  'optionalAuth - 错误的凭据时继续但不设置 req.user': async () => {
    const wrongCredentials = Buffer.from('admin:wrongpass').toString('base64')
    const req = mockRequest({ headers: { authorization: `Basic ${wrongCredentials}` } })
    const res = mockResponse()
    const next = mockNext()
    
    const middleware = optionalAuth()
    await middleware(req, res, next.fn)
    
    assertEqual(next.wasCalled(), true)
    assertEqual(req.user, null)
  }

  // 注意：正确凭据的测试需要实际的密钥配置，应在集成测试中覆盖
}

await suite('Auth Middleware', tests)

