# models — AI 模型路由

对话入口、通道配置与降级策略。接口类型见 [shared/interfaces.d.ts](../shared/interfaces.d.ts)，部署契约见 [DEPLOYMENT.md](../DEPLOYMENT.md)。

| 文件 | 职责 |
|---|---|
| `channels.mjs` | 通道增删改查、持久化、优先级与打码响应 |
| `fallback.mjs` | 过滤可用通道，调用 OpenAI 兼容端点，分类错误 |
| `router.mjs` | chat、pickChannel、testChannel 与工具调用循环 |

## 存储与配置

文件默认是项目 `data/models.json`；`BILI_HUMANISM_DATA` 可改统一数据目录，`BILI_HUMANISM_MODELS` 可单独覆盖文件。显式相对路径基于进程 cwd；模块导入前配置，修改路径后重启。首次读取无文件时生成 `{"auto":true,"channels":[]}`；损坏或缺少 channels 数组时会重建空配置，因此维护前应备份。

以下为格式有效、认证留空且停用的示例，地址和模型名须由部署者替换：

```json
{
  "auto": true,
  "channels": [
    {
      "id": "ch_example",
      "name": "示例通道",
      "baseURL": "https://model.example.com/v1",
      "apiKey": "",
      "model": "example-chat-model",
      "priority": 10,
      "enabled": false,
      "vision": false,
      "note": "配置自有端点后启用"
    }
  ]
}
```

调用时在 baseURL 路径追加 `/chat/completions`。路由只选择 enabled 不为 false 且 apiKey 非空的通道，按 priority 升序；没有 key 的本地通道也会被过滤。`vision=true` 声明通道支持图像输入，不会自动配置独立的视觉描述链。

`secrets/loader.mjs` 读取的 `AMD_API_KEY` 等旧环境字段不会自动创建或填充此文件。JSON 不展开 `${ENV_NAME}`。真实 apiKey 仅存私有配置，不写入文档；GET 和增改响应对它打码，PATCH/PUT 更新时 `***` 或空字符串表示保留旧值。URL 内的用户名、密码和查询值也会在状态边界打码，保存打码 URL 时尝试保留原有认证参数。

## 调用与降级

```javascript
import { chat, pickChannel, testChannel } from './models/router.mjs';
import { masked } from './models/channels.mjs';

// 需要先在本机私有配置中添加有效通道；以下调用会访问模型端点。
const result = await chat([{ role: 'user', content: '请解释这段代码的作用' }], {
  maxTokens: 800,
  timeoutMs: 60000
});
// result: { text, usage, channel, model, steps, rounds }
// masked() 提供可展示的配置；不要记录 channels.list() 的原始结果。
```

`channelId` 可将指定的有效通道提到队首，其余通道仍参与故障回退。429、5xx（包括 500、503）和超时会尝试下一个通道；400、401 及其他不满足回退条件的错误直接抛出。通道顺序由私有配置决定，没有固定供应商链。`auto` 字段会持久化，但当前 chat 的选择逻辑不以它作为停止回退的闸门。

| 错误码 | 含义 |
|---|---|
| `NO_CHANNEL` | 没有可用通道，或指定通道无效 |
| `CHANNEL_RATE_LIMITED` | 上游 429 |
| `CHANNEL_TIMEOUT` | 单次调用超时 |
| `CHANNEL_FAILED` | 其他 HTTP 错误或非法响应 |
| `ALL_CHANNELS_FAILED` | 可回退通道均失败 |
| `TOOL_LOOP_EXCEEDED` | 工具循环超过上限 |

pickChannel 和 testChannel 也会实际调用模型，不应把它们当离线配置校验。通道故障可触发 SMTP 告警，是否发送取决于 settings 的 smtp.enabled、onChannelFailed 和节流配置。

## 网关与验证

当前通道管理入口是 `/api/channels`：GET 列表，POST 新建，PATCH/PUT `/:id` 更新，DELETE `/:id` 删除，POST `/:id/test` 实际测试，PUT `/auto` 保存自动开关。均需要 Basic Auth。API、Cookie、SMTP、worker、MCP 与 CORS 的完整配置以项目部署说明为准。

在项目根目录运行 `npm run test:security`。需要额外运行模型路由测试时，用独立临时 DATA 隔离 notifier 引发的设置初始化：

```bash
VALIDATION_DATA=$(mktemp -d)
BILI_HUMANISM_DATA="$VALIDATION_DATA" BILI_HUMANISM_SETTINGS="$VALIDATION_DATA/settings.json" BILI_HUMANISM_V1_ENV= SMTP_HOST= ALERT_TO= NODE_ENV=test node --test tests/model-routing.test.mjs
unset VALIDATION_DATA
```

该命令适用于 Bash / Git Bash，临时目录由系统或部署者按需清理。模型路由测试自身仅覆盖模型文件路径，并模拟 fetch；额外设置 DATA/settings 可避免在源码目录生成 settings.json。不要继承生产 SMTP 配置。测试不需要真实 API Key，不等于生产连通性验证，也不证明 Git 历史无敏感信息。
