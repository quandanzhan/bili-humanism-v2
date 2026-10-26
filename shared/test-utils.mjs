/**
 * 测试工具函数
 * ============================================================================
 * 用途：提供统一的测试辅助函数，减少重复代码
 */

/**
 * 简单的测试运行器
 * @param {string} name - 测试名称
 * @param {Function} fn - 测试函数
 */
export async function test(name, fn) {
  try {
    await fn()
    console.log(`✅ ${name}`)
    return true
  } catch (e) {
    console.error(`❌ ${name}`)
    console.error(`   ${e.message}`)
    if (e.stack) {
      console.error(`   ${e.stack.split('\n').slice(1, 3).join('\n   ')}`)
    }
    return false
  }
}

/**
 * 断言函数
 */
export function assert(condition, message = '断言失败') {
  if (!condition) {
    throw new Error(message)
  }
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      message || `断言失败: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`
    )
  }
}

export function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) {
    throw new Error(
      message || `深度断言失败:\n期望: ${b}\n实际: ${a}`
    )
  }
}

export function assertThrows(fn, expectedCode, message) {
  try {
    fn()
    throw new Error(message || `期望抛出错误但没有抛出`)
  } catch (e) {
    if (expectedCode && e.code !== expectedCode) {
      throw new Error(
        message || `期望错误码 ${expectedCode}, 实际 ${e.code}: ${e.message}`
      )
    }
  }
}

export async function assertThrowsAsync(fn, expectedCode, message) {
  try {
    await fn()
    throw new Error(message || `期望抛出错误但没有抛出`)
  } catch (e) {
    if (expectedCode && e.code !== expectedCode) {
      throw new Error(
        message || `期望错误码 ${expectedCode}, 实际 ${e.code}: ${e.message}`
      )
    }
  }
}

/**
 * Mock 函数
 */
export function mock(returnValue) {
  const calls = []
  const fn = (...args) => {
    calls.push(args)
    return typeof returnValue === 'function' ? returnValue(...args) : returnValue
  }
  fn.calls = calls
  fn.callCount = () => calls.length
  fn.reset = () => { calls.length = 0 }
  return fn
}

/**
 * 临时环境变量
 */
export function withEnv(vars, fn) {
  const backup = {}
  for (const [k, v] of Object.entries(vars)) {
    backup[k] = process.env[k]
    process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/**
 * 测试套件
 */
export async function suite(name, tests) {
  console.log(`\n🧪 ${name}`)
  console.log('─'.repeat(60))
  let passed = 0
  let failed = 0
  
  for (const [testName, testFn] of Object.entries(tests)) {
    const ok = await test(testName, testFn)
    if (ok) passed++
    else failed++
  }
  
  console.log('─'.repeat(60))
  console.log(`总计: ${passed + failed} | 通过: ${passed} | 失败: ${failed}`)
  
  return { passed, failed, total: passed + failed }
}
