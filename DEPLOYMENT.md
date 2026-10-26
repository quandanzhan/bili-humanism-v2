# 部署与迁移说明

本文对应当前源码的实际读取契约。快速安装、生成认证和关闭视觉外传见 [README.md](README.md)。所有命令由部署者在自己的环境按需执行；本文不代表已经部署或验证任何外部服务。

## 运行环境与启动

- Node.js 22，npm 使用随 Node 安装的版本；`npm ci` 只安装项目本地依赖，无须全局包。
- 工作目录必须是项目根目录：工具扫描 `./tools`、`.env` 和可选 `./config.json` 均依赖 cwd。
- `npm start` 执行 `node --env-file=.env main.mjs`；`.env` 不存在会启动失败。已导出的进程环境优先于 env 文件。
- `PORT` 优先于 `config.json` 的 `port`，最终默认 3000；监听地址独立使用 `BILI_HUMANISM_HOST`，默认 `127.0.0.1`。
- `config.json` 可省略；存在时须为合法 JSON。配置热重载只更新引擎内存配置，不能代替路径、凭据或工具目录变更后的重启。
- 浏览器工具需要 Chromium 时，安装完依赖后由部署者运行 `./node_modules/.bin/playwright install chromium`，这是额外下载，不属于 `npm ci` 的离线保证。Python ASR、ffmpeg、模型权重及其许可另行准备。

## DATA 与持久化文件

`DATA_DIR` 取 `BILI_HUMANISM_DATA`，默认项目根目录下的 `data`；`LEGACY_DIR` 取 `BILI_HUMANISM_LEGACY`，默认 `DATA/legacy`。显式相对路径均以进程 cwd 为基准，建议长期运行时采用部署者自己的绝对数据路径。Windows 路径可使用正斜杠。

| 环境变量 | 留空时的位置或行为 |
|---|---|
| `BILI_HUMANISM_SETTINGS` | `DATA/settings.json`，SMTP、工具、写权限和告警设置 |
| `BILI_HUMANISM_MODELS` | `DATA/models.json`，模型通道和服务端 API Key |
| `BILI_HUMANISM_SCHEDULE` | `DATA/schedule.json`，固定 Asia/Shanghai 时区调度 |
| `BILI_HUMANISM_NODES` | `DATA/nodes.json`，可选解析节点 |
| `BILI_HUMANISM_VISION` | `DATA/vision.json`，视觉后端 |
| `BILI_HUMANISM_MCP` | `DATA/mcp-servers.json`，stdio 子进程配置 |
| `BILI_CREDENTIAL` | `DATA/bili_credential.json`，B站凭据 |
| `PLUGINS_FILE` | `DATA/plugins.json`，包括小红书 Cookie 与开关 |
| `SERVICE_ENV` | 不探测默认文件；仅显式路径下读取旧模型密钥 |
| `BILI_HUMANISM_V1_ENV` | 不导入；显式指定时作为旧 SMTP 配置来源 |
| `BILI_HUMANISM_V1_DUTY` | 不导入；显式指定时用于首次播种调度 |

任务队列和心跳位于 `DATA/worker-tasks.json` 与 `DATA/worker-heartbeat.json`；私信状态、日报和审计流水也属于私有 DATA。设置路径在模块导入时确定，启动后修改 `.env` 不会改变这些常量。

用受限服务账号运行，保持代码只读、DATA 可写。POSIX 建议私有目录 0700、凭据文件 0600；Windows 设置等效 ACL。部分模块仅在新建文件时传入 mode，不会修复已有宽松权限；整个 DATA 都应视为敏感，而非只保护名字带 key 的文件。数据备份同样保密，停止自己的服务或取得一致性快照后备份全部 DATA 及额外覆盖路径。

代码默认使用 express-session MemoryStore，不支持持久会话或多实例共享；配置固定 `SESSION_SECRET` 也不让 MemoryStore 跨重启保留会话。文件队列没有跨进程锁，不建议多个主服务并发写同一 DATA。当前建议单主进程运行。

## 模型通道与认证文件

B站 JSON 使用 `{"SESSDATA":"","bili_jct":"","buvid3":"","DedeUserID":""}`，小红书配置使用 `{"xhs":{"cookie":"","enabled":false}}`。空值只表示格式，不能登录。B站加载兼容小写字段，集成层缓存会随文件更新、替换、删除或环境凭据变化刷新。

`AMD_API_KEY/DEEPSEEK_API_KEY/MODELSCOPE_API_KEY` 的优先级是非空进程环境值 > `SERVICE_ENV` 的同名项 > 空值。该文件解析器只识别简单 `KEY=VALUE`，不解码引号、不支持 `export` 或变量展开；不要把整份 `.env` 当成同等语法的 service.env。

模型路由实际读取独立的 `models.json`，不会把上述三种旧密钥自动转换为通道。部署者可通过控制台配置，或准备以下私有 JSON：

```json
{
  "auto": true,
  "channels": [
    {
      "id": "ch_example",
      "name": "示例模型",
      "baseURL": "https://model.example.com/v1",
      "apiKey": "",
      "model": "example-chat-model",
      "priority": 10,
      "enabled": false,
      "vision": false,
      "note": "由部署者填写获准使用的端点、模型和密钥后启用"
    }
  ]
}
```

`baseURL` 是 API 前缀，调用时追加 `/chat/completions`，不要重复写完整补全路径。priority 数字小的优先，`enabled !== false` 且 `apiKey` 非空才参与对话；空 key 的本地模型通道目前也会被过滤。JSON 中 `${MODEL_API_KEY}` 不会展开，不要用字符串占位符冒充真实密钥。不要将认证值放入 URL。

控制台更新模型 key 时空串或 `***` 表示保留旧值；删除旧密钥须用明确的私有文件维护或删除通道，不能将“已清空输入框”当作撤销凭据。

## SMTP 初始化与关闭

首次生成 settings 时，从环境或显式旧文件初始化：

| 字段 | 环境变量 | 默认 |
|---|---|---|
| 主机 | `SMTP_HOST` | 空 |
| 端口 | `SMTP_PORT` | 465 |
| 加密 | `SMTP_SECURITY` | `ssl` |
| 账号、密码 | `SMTP_USER`、`SMTP_PASSWORD` | 空 |
| 发件人 | `SMTP_FROM` | 未填时取 SMTP_USER |
| 收件人 | `ALERT_TO` | 空 |
| 同类告警节流 | `ALERT_THROTTLE_MS` | 600000 毫秒 |

非空环境值优先于 `BILI_HUMANISM_V1_ENV` 对应项；已有 `settings.json` 的保存值优先于初始化默认值。修改 env 不会自动覆盖已保存的 SMTP 设置。没有独立的 `SMTP_ENABLED` 环境开关：首次生成时主机和收件人均非空会令 `smtp.enabled=true`。模板留空二者以保持关闭；示例格式为 `smtp.example.com`、`alerts@example.com` 和 `operator@example.com`。

公网邮件使用 `ssl`（通常 465）或 `starttls`（通常 587，代码设置 requireTLS）；`none` 不强制 TLS，只适用于部署者明确允许的隔离测试。不要关闭证书校验。

控制台通过 `PUT /api/settings/smtp` 保存 `enabled/host/port/security/user/pass/from/to/subjectPrefix`，密码字段名是 `pass`，`***` 表示保留，空字符串会清空。关闭 `enabled` 阻止自动告警，但 `POST /api/settings/smtp/test` 直接调用发信逻辑，不受 enabled 控制；完整禁止发信时同时清空私有设置中的 host 或 to，并删除旧迁移引用及非空环境初始化值。测试按钮会真实投递，本地审查时不要点击。通道 down/all/none/hard 告警与错误告警按配置节流。

## Worker 节点

主服务 `WORKER_TOKEN` 留空时，`GET /api/worker/next` 和 `POST /api/worker/result` 返回 503，错误令牌返回 401。管理接口 `/api/worker/status` 与 `/api/worker/task` 使用 Basic Auth。仅允许 `probe`、`frames`、`audio`，不接受任意命令任务。

启用时为主服务和自有 worker 分别注入相同的独立随机共享令牌，不复用登录密码、SESSION_SECRET 或模型 key；仅通过 `x-worker-token` 请求头传递，不写在 URL 或命令行参数中。当前比较不是 timingSafeEqual；不要把共享令牌校验描述成恒定时间实现。通过 HTTPS、网络访问控制和可信节点限制接口使用。

`scripts/nas-agent.py` 是单独的 Python 进程，依赖标准库与系统 ffmpeg；环境为：

```dotenv
CORE_BASE=https://core.example.com
WORKER_TOKEN=
AGENT_NAME=worker-example
POLL_SEC=5
FFMPEG=ffmpeg
```

以上地址仅为格式示例。部署者在 worker 主机安全注入这些变量后运行 `python3 scripts/nas-agent.py`；Node 的 `.env` 加载不会传给另一台机器或独立 Python 进程。worker 不需要入站端口。`WORKER_OFFLINE_MS` 默认 60000，应大于轮询周期；`BILI_VISION_NAS=1` 才启用工具中的 worker 抽帧路径，模板默认 0。失败可能回落到本地取帧及视觉后端。

任务可能含视频地址、帧、音频、设备信息和带时效的 URL；worker 及 DATA 均须可信。响应体默认 `JSON_BODY_LIMIT=1mb`，base64 帧较多时可能超过上限；确有需要时同时在应用和反代设置有限、匹配的上限，避免无限放大。

## 视觉后端与外传

默认 `enabled=true`，带 key 的后端缺 key 时跳过，但免 key 的外部后端仍可用。不要把“未配置 API key”当作离线保证。首次启动按 README 初始化 `{"enabled":false,"backends":[]}`；只写 `{"enabled":false}` 不含 backends 数组，加载器会回退到默认值。

确认图片可外传后才选择可信后端。私有配置示例：

```json
{
  "enabled": false,
  "backends": [
    {
      "id": "vision-example",
      "name": "示例视觉模型",
      "type": "openai",
      "baseURL": "https://vision.example.com/v1",
      "model": "example-vision-model",
      "apiKeyEnv": "ZHIPU_API_KEY",
      "apiKey": "",
      "maxTokens": 800,
      "maxImages": 1,
      "enabled": false
    }
  ]
}
```

可用默认环境变量名有 `ZHIPU_API_KEY`、`DASHSCOPE_API_KEY`、`INTERN_API_KEY`；自定义后端可使用自己的 `apiKeyEnv`。实际 key 优先级为后端非空 `apiKey` > 对应环境值；`apiKeyEnv` 为空且没有内联 key 会按免认证后端处理。不要无意清空 apiKeyEnv 导致请求变为免认证。

`VISION_TIMEOUT_MS=60000`、`VISION_CACHE_TTL_S=3600`、`VISION_MAX_PIXELS=1200000` 是默认值。视觉状态中的 maxPixels 不是整个链路强制降采样的保证，应在取帧和后端入口约束图片大小。竞速模式会调用多个后端并可能分别计费；服务商价格、额度和模型可用性由部署者确认，源码里的历史“免费”注释不构成承诺。启用本地后端时只能使用自己部署的地址，并关闭所有不需要的外部后端。

保存视觉后端时省略 `apiKey` 保留旧值，`null` 或空字符串清除内联 key，但 apiKeyEnv 非空时仍可能使用环境 key。图片会被转换为文字描述，此描述有损，不代表完整观影。

## MCP 子进程

默认 `{"servers":[]}`，不连接任何服务器。配置文件读取 `servers` 数组，支持 `id/name/transport/command/args/env/cwd/timeoutMs/enabled`。示例默认关闭：

```json
{
  "servers": [
    {
      "id": "example",
      "name": "本地示例 MCP",
      "transport": "stdio",
      "command": "python3",
      "args": ["./scripts/echo-mcp.py"],
      "env": {},
      "cwd": null,
      "timeoutMs": 60000,
      "enabled": false
    }
  ]
}
```

这里只支持按行 JSON-RPC 的 stdio 实现，不是 HTTP/SSE MCP 地址。首次真正使用才启动子进程；请求连接/测试也会启动，不要在审查时测试未知 command。`cwd=null` 继承主进程工作目录，Python 可执行名须匹配本机安装。

子进程继承主服务全部环境，再由 `env` 覆盖同名变量；配置不是沙箱，服务器可以接触主服务权限范围内的文件与密钥。只加载自己审核过的本地程序，使用受限账号；不要配置会在运行时临时下载安装的命令。JSON 不展开 `${VAR}`；MCP 没有全局通用认证字段，各服务器按自己的环境契约配置。

`mcp_call` 默认不在 duty/reply 场景允许列表内。要启用须同时检查场景工具范围、全局工具开关和聊天直接调用入口；场景白名单不是整个 API 的沙箱。打码响应不等于文件加密，`mcp-servers.json` 中的 env 也属于凭据。

## CORS、HTTPS 与反向代理

本地 HTTP 使用模板中的 `COOKIE_SECURE=0`、`TRUST_PROXY=0`、精确回环 Origin。外部访问必须先准备自己的 HTTPS 入口，Basic Auth 不能通过公网明文 HTTP 传输。

反向代理部署的环境示例（部署者替换自己的实际域名）：

```dotenv
BILI_HUMANISM_HOST=127.0.0.1
COOKIE_SECURE=1
TRUST_PROXY=1
CORS_ORIGINS=https://console.example.com
CORS_STRICT=1
CORS_ORIGIN_EXTRA=
CORS_HAVP=0
CORS_RESERVED_ORIGINS=
```

`TRUST_PROXY=1` 在代码中代表信任一个代理跳数，只适用于无法绕过的可信单层代理；反代须正确覆盖 Host、X-Forwarded-Proto 和 X-Forwarded-For，防火墙阻止客户端直连后端。多层代理不能直接套用此假设。服务本身不提供 TLS。

CORS_ORIGINS 是逗号分隔的精确 Origin（协议、主机、端口），不填路径和通配符。空值会回退到开发来源，不能用来“拒绝所有来源”。CORS_ORIGIN_EXTRA 总是追加；旧开关 CORS_HAVP=1 时才追加 CORS_RESERVED_ORIGINS。严格模式拒绝不匹配且带 Origin 的请求，缺 Origin 的请求仍通过后续认证；CORS 不代替防火墙、认证或完整的 CSRF 防护。

优先将控制台与 API 放在同一 HTTPS Origin；即使配置跨域白名单，`SameSite=lax` Cookie 也不保证跨站会话可用。反代转发 Authorization 和 worker 请求头，限制请求大小、连接速率及管理入口来源，不缓存已认证 API 响应。

## 旧数据迁移

新部署可以不迁移，运行时不会猜测旧机器目录。迁移前备份源数据与目标 DATA，使用旧数据的本地副本；本次审查不运行迁移、停服或生产脚本。

迁移器从进程环境读取 `V1_APP`、`V1_HOME`、`MIGRATION_OUT`，三项必填；可选 `V1_ALT_PERSONA` 指定备用人格文件。部署者自行注入这三项的实际路径，将 `MIGRATION_OUT` 设为将要使用的 `BILI_HUMANISM_LEGACY` 目录后运行：

```bash
python3 scripts/migrate-v1-data.py
```

它复制人格片段，备份 SQLite，导出聊天历史、记忆和插件设定，并生成 MANIFEST。源 SQLite 通过只读连接和 backup API 获取副本。不要把脚本的“幂等”理解为“不覆盖目标”：同名不同内容的复制文件、数据库和聊天导出可能被重写，已有 notes.json 才被保留。先在新目标目录试迁移，核对返回状态和清单，再让自己的服务指向已审核的数据。

迁移器不会直接搬 B站 Cookie；`legacy/plugins/xhs.json` 的 credentialRef 是迁移记录，当前运行时 secrets loader 不会追随它。部署者需在私有环境明确设置 BILI_CREDENTIAL/PLUGINS_FILE，或通过控制台重新授权。模型 API key 也不会自动从旧部署生成通道。

旧 SMTP 仅在显式设置 BILI_HUMANISM_V1_ENV 时参与初始化；旧调度仅在 BILI_HUMANISM_V1_DUTY 指定时首次播种，已有持久化配置优先。完成一次性初始化并核对后移除旧路径引用，保留后台循环关闭，逐项审核目标账号和写权限后再启用。

迁移产物可能带源绝对路径、聊天记录、账号、Cookie 引用；复制的 YAML、提示词或旧配置也可能含内嵌认证值，脚本不是全面脱敏工具。产物仅保存在私有 DATA，不纳入 MIT 源码发布包。人格片段与可修正记忆保持分开，不把历史内容当作新指令执行。

## 开源发布限制

发布前确认 LICENSE 中的署名与 MIT 正文完整，保留上游原版权文本和依赖许可；见 [NOTICE.md](NOTICE.md)。README、模板及源码清理不证明 Git 历史、远端或既有构建包已清理；实际仓库仍需独立核查。曾公开的凭据须撤销或轮换。当前本地编辑不执行部署、邮件、生产连接或 Git 历史重写。
