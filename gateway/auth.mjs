import { redactText, registerSecrets } from './runtime.mjs'
// ================================================================
// 身份验证中间件 - 完整实现模板
// ================================================================
//
// 🚨 落地说明：
// 此模板导入路径是相对于 ai-tasks/task-d-e/templates/，
// 实际落地时应根据最终文件位置调整。
//
// 推荐落地方案（假设落地到 standalone-v2/gateway/）：
// import { loadSecrets } from '../secrets/loader.mjs'
//
// 或者如果与 Task A 在不同仓库/目录：
// import { loadSecrets } from '../secrets/loader.mjs'
//
// ================================================================

import { loadSecrets } from '../secrets/loader.mjs'
import { scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Basic Auth 中间件（兼容原 auth.mjs 的 scrypt 验证）
 * @returns {Function} Express 中间件
 */
export function requireAuth() {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return res.status(401).json({
        error: '需要身份验证',
        code: 'AUTH_REQUIRED',
        hint: '请提供 Authorization: Basic <credentials> 头'
      })
    }

    try {
      // 解码 Basic Auth
      const base64Credentials = authHeader.split(' ')[1]
      const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8')
      const separator = credentials.indexOf(':')
      const user = separator < 0 ? '' : credentials.slice(0, separator)
      const password = separator < 0 ? '' : credentials.slice(separator + 1)
      registerSecrets([password, authHeader.split(' ')[1]])

      if (!user || !password) {
        return res.status(401).json({
          error: '凭据格式错误',
          code: 'AUTH_INVALID_FORMAT'
        })
      }

      // 加载密钥
      const secrets = await loadSecrets()
      const expectedUser = secrets.auth.USER
      const expectedHash = secrets.auth.HASH
      const salt = secrets.auth.SALT

      // 验证用户名
      if (user !== expectedUser) {
        return res.status(401).json({
          error: '用户名或密码错误',
          code: 'AUTH_FAILED'
        })
      }

      // 验证密码（使用 scrypt，与原 auth.mjs 一致）
      const got = scryptSync(password, salt, 64)
      const want = Buffer.from(expectedHash, 'hex')

      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        return res.status(401).json({
          error: '用户名或密码错误',
          code: 'AUTH_FAILED'
        })
      }

      // 验证通过
      req.user = user
      next()
    } catch (e) {
      console.error('[auth] 验证过程出错:', redactText(e?.message || e))
      return res.status(500).json({
        error: '身份验证失败',
        code: 'AUTH_ERROR',
        detail: redactText(e.message)
      })
    }
  }
}

/**
 * 可选的认证中间件（允许匿名访问）
 * @returns {Function} Express 中间件
 */
export function optionalAuth() {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Basic ')) {
      // 无认证头，继续但不设置 req.user
      return next()
    }

    try {
      const base64Credentials = authHeader.split(' ')[1]
      const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8')
      const separator = credentials.indexOf(':')
      const user = separator < 0 ? '' : credentials.slice(0, separator)
      const password = separator < 0 ? '' : credentials.slice(separator + 1)
      registerSecrets([password, authHeader.split(' ')[1]])

      const secrets = await loadSecrets()
      const expectedUser = secrets.auth.USER
      const expectedHash = secrets.auth.HASH
      const salt = secrets.auth.SALT

      if (user === expectedUser) {
        const got = scryptSync(password, salt, 64)
        const want = Buffer.from(expectedHash, 'hex')

        if (got.length === want.length && timingSafeEqual(got, want)) {
          req.user = user
        }
      }
    } catch (e) {
      console.warn('[auth] 可选认证失败，继续匿名访问:', redactText(e.message))
    }

    next()
  }
}
