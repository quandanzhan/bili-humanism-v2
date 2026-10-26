# 错误码约定

> **用途**：统一错误处理，便于调试和日志分析

---

## 错误格式

所有模块必须使用以下错误格式：

```javascript
const err = new Error('人类可读的错误信息')
err.code = 'ERROR_CODE'  // 大写下划线格式
err.data = { /* 附加调试数据 */ }
throw err
```

---

## 错误码分类

### 通用错误（1xxx）

| 错误码 | 含义 | 何时使用 |
|--------|------|----------|
| `UNKNOWN_ERROR` | 未知错误 | 捕获到未预期的异常 |
| `INVALID_ARGUMENT` | 参数无效 | 参数类型或格式错误 |
| `MISSING_REQUIRED` | 缺少必填参数 | 必填参数为空 |
| `NOT_FOUND` | 资源不存在 | 找不到指定的资源（工具 / 文件 / 配置） |
| `PERMISSION_DENIED` | 权限不足 | 没有权限执行操作 |
| `RATE_LIMITED` | 请求过于频繁 | 触发限流 |

### 密钥管理错误（2xxx）

| 错误码 | 含义 | 何时使用 |
|--------|------|----------|
| `SECRET_NOT_FOUND` | 密钥不存在 | 找不到指定的密钥 |
| `SECRET_INVALID` | 密钥无效 | 密钥格式错误或已过期 |
| `SECRET_LOAD_FAILED` | 密钥加载失败 | 读取密钥文件失败 |

### 模型路由错误（3xxx）

| 错误码 | 含义 | 何时使用 |
|--------|------|----------|
| `NO_CHANNEL` | 没有可用通道 | 所有模型通道都不可用 |
| `CHANNEL_TIMEOUT` | 通道超时 | 请求超过指定时间 |
| `CHANNEL_FAILED` | 通道失败 | 通道返回错误（非 429） |
| `ALL_CHANNELS_FAILED` | 所有通道失败 | 尝试所有通道都失败了 |

### 工具引擎错误（4xxx）

| 错误码 | 含义 | 何时使用 |
|--------|------|----------|
| `TOOL_NOT_FOUND` | 工具不存在 | 找不到指定的工具 |
| `TOOL_EXECUTE_FAILED` | 工具执行失败 | 工具内部抛出异常 |
| `CONFIG_INVALID` | 配置无效 | 配置文件格式错误 |
| `CONFIG_LOAD_FAILED` | 配置加载失败 | 读取配置文件失败 |
| `UNKNOWN_PARAMETER` | 未知参数 | 工具参数不在允许列表中 |
| `TOKEN_BUDGET` | Token 预算耗尽 | 超过会话 token 限额 |

### 网关 / 认证错误（5xxx）

| 错误码 | 含义 | 何时使用 |
|--------|------|----------|
| `AUTH_FAILED` | 认证失败 | 账号或密码错误 |
| `SESSION_EXPIRED` | 会话过期 | token 已过期 |
| `SESSION_INVALID` | 会话无效 | token 格式错误或签名不匹配 |
| `RATE_LIMITED_AUTH` | 登录尝试过于频繁 | 触发失败限流 |

### 外部集成错误（6xxx）

| 错误码 | 含义 | 何时使用 |
|--------|------|----------|
| `XHS_SIGN_FAILED` | 小红书签名失败 | v1 签名计算错误 |
| `XHS_AUTH_REQUIRED` | 需要登录 | Cookie 缺失或已过期 |
| `XHS_FORBIDDEN` | 账号无权限 | 登录态被识别，账号受限 |
| `BROWSER_NOT_READY` | 浏览器不可用 | Playwright 未就绪 |
| `BROWSER_TIMEOUT` | 浏览器超时 | 页面加载超时 |

---

## 使用示例

### 抛出错误

```javascript
// 密钥不存在
const err = new Error('找不到 B站 Cookie')
err.code = 'SECRET_NOT_FOUND'
err.data = { key: 'bili.SESSDATA' }
throw err

// 模型通道超时
const err = new Error(`通道 ${ch.name} 请求超时`)
err.code = 'CHANNEL_TIMEOUT'
err.data = { channelId: ch.id, timeoutMs: 60000 }
throw err
```

### 捕获错误

```javascript
try {
  await someOperation()
} catch (e) {
  if (e.code === 'CHANNEL_TIMEOUT') {
    // 尝试降级到下一个通道
    console.warn(`通道超时，尝试降级: ${e.message}`)
    return await fallback()
  }
  throw e  // 其他错误继续向上抛
}
```

---

## 日志格式

错误日志必须包含：

```javascript
console.error(`[${moduleName}] ${err.code}: ${err.message}`, err.data || {})
```

示例：
```
[models] CHANNEL_TIMEOUT: 通道 AMD Radeon 请求超时 { channelId: 'ch_amd', timeoutMs: 60000 }
```

---

## 验收要求

所有 AI 完成后，检查：

1. ✅ 所有抛出的错误都有 `code` 字段
2. ✅ `code` 格式是大写下划线（例如 `SECRET_NOT_FOUND`）
3. ✅ 错误信息是人类可读的中文
4. ✅ 如果有附加数据，放在 `err.data` 里
5. ✅ 不要在 `message` 里夹杂对象（用 `JSON.stringify` 或放 `data`）
