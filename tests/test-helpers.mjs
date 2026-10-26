/**
 * 测试辅助函数（API 与 ai-tasks/shared/test-utils.mjs 同名同签名）
 * ============================================================================
 * 为什么放这里：ai-tasks 协作包与 vendor/ 不在同一 workspace，测试无法稳定
 * 相对引用共享文件（任务 B 在 model-routing.test.mjs 内联了同款辅助；
 * 本目录有两个测试文件，抽成独立 helper 避免两份内联重复）。
 * 任务 G 固化统一 runner 时，把本文件替换为对共享版的 re-export 即可。
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

export function assert(condition, message = '断言失败') {
  if (!condition) throw new Error(message)
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      message || `断言失败: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`
    )
  }
}

export async function assertThrowsAsync(fn, expectedPart, message) {
  try {
    await fn()
  } catch (e) {
    if (expectedPart && !String(e.message).includes(expectedPart)) {
      throw new Error(message || `期望错误包含 ${JSON.stringify(expectedPart)}, 实际: ${e.message}`)
    }
    return
  }
  throw new Error(message || '期望抛出错误但没有抛出')
}

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

  if (failed > 0) process.exitCode = 1
  return { passed, failed, total: passed + failed }
}
