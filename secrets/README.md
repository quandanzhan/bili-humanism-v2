# secrets —— 统一密钥加载

统一通过 `loadSecrets()` 读取密钥，保持以下接口结构：

```javascript
import { loadSecrets } from './loader.mjs'
const secrets = await loadSecrets()
// bili: { SESSDATA, bili_jct, buvid3, DedeUserID }
// models: { AMD_API_KEY, DEEPSEEK_API_KEY, MODELSCOPE_API_KEY }
// session: { SECRET, TTL_MS }
// auth: { USER, SALT, HASH }
// plugins: { xhs: { cookie, enabled } }
```

类型定义见 `../shared/interfaces.d.ts`。

## 来源与优先级

| 分组 | 来源与缺省行为 |
|---|---|
| bili | `BILI_CREDENTIAL` 指向 JSON 文件；兼容大小写字段，缺失返回空字符串 |
| models | 同名环境变量优先，其次 `SERVICE_ENV` 指定文件中的 `KEY=VALUE` 行，缺失为空 |
| session | `SESSION_SECRET`；缺失时生成进程内复用的临时随机密钥，重启后会话失效 |
| session.TTL_MS | `SESSION_TTL_MS`，默认 604800000 毫秒（7 天） |
| auth | `AUTH_USER`、`AUTH_SALT`、`AUTH_HASH` 必须全部配置；缺失时禁止登录 |
| plugins | `PLUGINS_FILE` 指定 JSON，读取 `xhs.cookie` 和 `xhs.enabled`；缺失禁用 |

B站凭据与插件文件默认分别位于 `DATA_DIR/bili_credential.json` 和 `DATA_DIR/plugins.json`，与账号路由一致。`DATA_DIR` 使用 `BILI_HUMANISM_DATA`，未配置时使用项目根目录下的 `data`；`BILI_CREDENTIAL`、`PLUGINS_FILE` 可单独覆盖。`SERVICE_ENV` 无默认值，不会探测旧部署目录。路径在模块导入时读取，须在启动前配置；显式相对路径以进程工作目录为基准。会话、认证和模型密钥环境变量在调用时读取。文件读取或 JSON 解析失败只给出不含原值的警告，返回完整分组结构；日志不打印密钥和配置内容。

## 配置认证

复制同目录 `.env.template` 为项目根目录的私有 `.env`。按[项目 README 的认证生成步骤](../README.md#生成登录认证和会话密钥)交互读取账号与密码，并将随机盐、scrypt 哈希及独立的随机会话密钥直接写入本机文件，不打印认证值。已有认证字段时脚本停止以免覆盖。

网关使用 `scryptSync(password, salt, 64)` 验证，AUTH_HASH 是 64 字节结果的 128 位 hex，不是明文密码；AUTH_SALT 与其必须配套，AUTH_USER 无默认账号。SESSION_SECRET 使用独立的 32 字节随机值。不要把密码、Cookie、盐、哈希、私有配置或会话密钥提交到版本库或共享日志。

在 Node 22 中从项目根目录运行 `npm start`，等价于 `node --env-file=.env main.mjs`；进程环境中的同名项优先，Node 不会隐式读取模板，也不展开 JSON 中的变量。生产启动不必通过 shell source 加载。POSIX 限制私有目录与文件权限，Windows 使用服务账号 ACL。固定会话密钥不等于持久会话存储，当前网关 MemoryStore 不跨重启保存会话。

## 凭据文件结构

以下仅说明键名，空值不构成可用凭据：

```json
{"SESSDATA":"","bili_jct":"","buvid3":"","DedeUserID":""}
```

插件文件使用 `{"xhs":{"cookie":"","enabled":false}}`。SERVICE_ENV 模型密钥文件每行使用 `AMD_API_KEY=` 等同名配置，认证值留空，由部署者在私有文件填写；当前解析器不处理 shell 表达式、export 前缀或引号解码。它不等同于独立的 DATA/models.json 通道配置。

## 工具及维护脚本

- `COMMENT_AT_UID`：评论工具允许 @ 的目标正整数 UID；未配置时继承 `REPLY_TALKER`，两者均未配置时不追加 @。
- B站集成每次使用凭据时核对文件修改时间、大小和文件标识，并检测环境凭据变化；扫码保存、文件替换或删除后自动刷新，无需账号路由调用 invalidate。
- `BILI_ASR_PY`、`BILI_ASR_SCRIPT`、`BILI_ASR_CWD`：ASR 解释器、脚本与工作目录。默认项目 `.venv-asr` 解释器、`scripts/asr_v2.py` 与项目根目录。
- `BILI_ASR_HF_HOME`：模型缓存根目录，默认用户目录下 `.cache/huggingface`；`BILI_ASR_CACHE` 可覆盖缓存枚举目录，通常为前者的 `hub` 子目录。`HF_ENDPOINT` 可由部署者自行指定。
- `BILI_FRAMES_PY`：取帧解释器，默认项目 `.venv` 中的平台对应解释器。
- `scripts/nas-agent.py`：必须配置 `CORE_BASE`（完整 HTTP(S) 地址）和 `WORKER_TOKEN`。
- `scripts/migrate-v1-data.py`：必须配置 `V1_APP`、`V1_HOME`、`MIGRATION_OUT`；备用人格路径可用 `V1_ALT_PERSONA` 覆盖。迁移产物含私人数据，不应提交。
- `scripts/rename-calluser.py`：必须配置 `PERSONA_DIR`，操作前核对目录。
- `scripts/stop-v1.sh`：必须配置 `V1_HOME`、`V1_UNITS`（空格分隔单元名）、`V2_BASE_URL`、`V2_AUTH_USER`、`V2_AUTH_PASS`；可选 `V1_BACKUP_DIR` 和 `V1_ROLLBACK_FILE`。此脚本会停服务并写备份，备份可能含私人配置。回滚脚本运行时仍须提供上述目标及认证变量，不内嵌凭据。
- UI 诊断脚本：使用 `TEST_BASE_URL`（默认本机 3000 端口）、`TEST_AUTH_USER`、`TEST_AUTH_PASS`；旧版回归登录需同时配置 `REGRESSION_USER` 和 `REGRESSION_PASS`。

## 验证

`node --test tests/secrets.test.mjs` 仅使用系统临时目录中的合成配置，验证缺失配置、认证契约、环境变量优先级和日志不泄密。真实网络诊断和维护脚本需自行配置目标后单独执行。

模型路由使用独立的通道配置；本模块读取模型密钥不会自动创建通道。完整的 SMTP、worker、vision、MCP、CORS、DATA 和旧数据迁移契约见[部署说明](../DEPLOYMENT.md)。尤其注意：SMTP 已保存设置优先于环境初始化值；关闭自动告警不阻止测试按钮直接发信；视觉默认包含免密钥外部后端，API key 留空不能阻止外传，须在启动前写入包含 backends 数组的关闭配置。

模板与私有文件按当前工作树清理，不代表 Git 历史、远端或旧发布包已清理。MIT 署名与第三方许可见 [NOTICE.md](../NOTICE.md)。
