# standalone-v2

基于 Node.js 的 B站助手独立服务，包含 Web 控制台、OpenAI 兼容模型通道、工具调用、可选 SMTP 告警、视觉描述链、拉取式 worker 与 stdio MCP。代码按 MIT 整理；V2 新增部分的权利人和授权范围仍待确认，当前是发布前审查候选，详见 [LICENSE](LICENSE) 和 [NOTICE.md](NOTICE.md)。

## 本地快速启动

使用 Node.js 22（`package.json` 要求 `>=22`）及随 Node 提供的 npm。以下命令在项目根目录执行，适用于 Bash / Windows Git Bash；路径包含空格时加引号。无需全局 npm 包。

```bash
node --version
npm --version
npm ci
cp -n secrets/.env.template .env
```

`npm ci` 按锁文件安装本地依赖，会重建本项目的 `node_modules`，通常需要访问 npm registry；离线安装需要预先准备完整缓存。不要用它替代数据备份。`.env` 已存在时保留并人工核对。Windows PowerShell 可用 `if (!(Test-Path .env)) { Copy-Item secrets/.env.template .env }` 完成复制。

### 生成登录认证和会话密钥

以下命令交互读取账号与密码，将随机盐、scrypt 哈希和随机会话密钥直接写入刚复制的 `.env`。它不打印任何认证值，密码不放入命令行参数或历史。不要在开启 shell 跟踪、终端录制或共享诊断的环境执行。Windows 可在 Git Bash 中执行。

```bash
set +x
read -r -p '自定义登录账号: ' SETUP_USER
read -r -s -p '登录密码: ' SETUP_PASSWORD
printf '\n'
SETUP_USER="$SETUP_USER" SETUP_PASSWORD="$SETUP_PASSWORD" node --input-type=module <<'NODE'
import fs from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
const user = process.env.SETUP_USER || '';
const password = process.env.SETUP_PASSWORD || '';
if (!/^[A-Za-z0-9_-]{1,64}$/.test(user) || !password) {
  throw new Error('账号须为 1–64 位字母、数字、下划线或短横线，密码不能为空');
}
let env = fs.readFileSync('.env', 'utf8');
const salt = randomBytes(16).toString('hex');
const values = {
  AUTH_USER: user,
  AUTH_SALT: salt,
  AUTH_HASH: scryptSync(password, salt, 64).toString('hex'),
  SESSION_SECRET: randomBytes(32).toString('hex')
};
for (const [key, value] of Object.entries(values)) {
  const blank = new RegExp('^' + key + '=[ \\t]*\\r?$', 'm');
  if (!blank.test(env)) throw new Error('认证字段缺失或已有值，停止以避免覆盖');
  env = env.replace(blank, key + '=' + value);
}
fs.writeFileSync('.env', env, { mode: 0o600 });
fs.chmodSync('.env', 0o600);
console.log('认证配置已写入本机 .env，未输出认证值');
NODE
unset SETUP_USER SETUP_PASSWORD
```

`AUTH_HASH` 是 `scryptSync(password, AUTH_SALT, 64)` 的 128 位十六进制结果，不能填明文密码；三项 `AUTH_USER/AUTH_SALT/AUTH_HASH` 缺一时登录禁用。`SESSION_SECRET` 使用独立的 32 字节随机值；缺省临时密钥不记入日志，但重启后会话失效。Windows 的文件权限还须用本机 ACL 限制为服务账号可读，`chmod` 不能代替 ACL。

### 首次启动前关闭视觉外传

视觉链默认启用，包含免密钥的外部后端；仅留空视觉 API Key 不能关闭它。新部署先运行以下本地初始化命令。已有视觉文件时命令停止，不覆盖配置；应先人工审核该文件。修改过 `BILI_HUMANISM_DATA` 或 `BILI_HUMANISM_VISION` 时，命令会使用相应路径。

```bash
node --env-file=.env --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; const data=path.resolve(process.env.BILI_HUMANISM_DATA || "data"); const file=process.env.BILI_HUMANISM_VISION || path.join(data,"vision.json"); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify({enabled:false,backends:[]},null,2),{flag:"wx",mode:0o600}); console.log("视觉链已初始化为关闭状态");'
npm start
```

打开 `http://127.0.0.1:3000`，控制台请求 API 时使用刚设置的 Basic Auth 账号和原密码。静态页面本身可匿名读取，管理 API 需要认证。缺少可选 Cookie、插件、模型密钥文件或 `config.json` 的警告不会阻止本地启动；模型通道初始为空，没有通道时无法完成 AI 对话。

模板将 `SCHEDULER_ENABLED=0`、`REPLY_LOOP=0`、`BILI_VISION_NAS=0`、`BROWSER_ALLOW_EVAL=false`，SMTP 和 worker 凭据留空。**首次接入平台账号前，先在控制台关闭写权限并核对工具开关**：代码原始写策略允许回复评论，工具未显式关闭时默认启用。禁用后台循环并不禁止管理员直接调用工具。

## 配置入口

- [环境模板](secrets/.env.template)：可直接复制的本地起始配置，所有真实认证字段留空。
- [部署与迁移说明](DEPLOYMENT.md)：DATA、旧数据迁移、SMTP、worker、视觉、MCP、CORS 与 HTTPS 反代。
- [密钥契约](secrets/README.md)：文件结构、优先级与维护脚本入口。
- [模型路由](models/README.md)：通道格式、调用和降级行为。

从项目根目录运行 `npm start`，等价于 `node --env-file=.env main.mjs`。进程环境中的同名变量优先于 `.env`；修改导入时读取的路径变量后重启进程。Node 的 env 文件加载不负责 JSON 内的 `${VAR}` 展开，也不会替 Python worker 加载环境。

模型通道在控制台“AI 模型”中配置，或由部署者准备私有 `DATA/models.json`。`AMD_API_KEY` 等旧环境字段只供 secrets 加载器读取，**不会自动创建或填充模型通道**。模型、SMTP、视觉或 MCP 的测试按钮可能访问外网或发送邮件，按需自行启用。

## 本地验证

```bash
node --check secrets/loader.mjs
npm run test:security
```

安全测试使用合成配置和临时目录；扫描器测试需要 Git 可执行程序可从 PATH 调用（Windows 可在 Git Bash 运行）。完整跨模块回归 `node gateway/tests/isolated-regression.mjs` 只在本地执行，共享 CI 仅跑语法与安全检查。

```bash
npm run security:scan -- --include-private
# 在真正的 Git 仓库内审核索引和全部本地可达历史：
npm run security:scan -- --include-private --history
# 只按白名单生成候选源码，输出目录必须尚不存在且位于源码树以外：
python3 scripts/package-source.py --output /path/to/existing-parent/new-candidate
```

扫描退出码 0 表示本次范围无命中，1 表示发现待复核项，2 表示执行不完整或请求历史审查但没有 Git 元数据。报告只输出位置和类别，不输出匹配原值。默认不扫运行目录，`--include-private` 才纳入；二进制、归档、依赖、符号链接与超过 4 MiB 的文件不检查，排除数量会列出。任何单次扫描都不能证明历史提交已清理。

候选目录含源码副本、ZIP 和逐文件 SHA-256 清单；打包器拒绝符号链接、二进制和过大源码，只允许明确的源码目录、文本扩展与模板。打包后还须独立扫描候选副本并人工核对清单。ZIP 不携带 Git 历史，也不能替代真正仓库的审查。

## 发布边界

`.env`、DATA、旧数据、模型权重、浏览器状态、备份和私人配置均不属于源码发布内容。自定义 DATA 指向忽略规则以外的目录时，须另行确保它不被打包或跟踪。示例中的 `example.com` 及其子域仅说明合法格式，部署前替换为自己有权使用的地址；不能把示例地址当作可用服务。

保留已有上游版权声明；V2 由本项目独立重写实现，署名与授权范围见 [LICENSE](LICENSE) 和 [NOTICE.md](NOTICE.md)，`package.json` 的 MIT 元数据不代表已经完成全部第三方授权核验。第三方依赖、模型权重、角色素材与平台内容的许可分别处理。

安全问题的报告方式见 [SECURITY.md](SECURITY.md)，开发约定与提交前自查见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本地工作树清理不等于 Git 历史清理。当前目录未提供可审查的 Git 历史，无法据此证明既有提交、分支、标签、远端、fork、CI 产物或旧发布包无敏感信息。发布前须在实际仓库核查跟踪文件和完整历史；曾泄露的凭据应撤销或轮换，删除文件和增加 `.gitignore` 都不会使旧凭据失效。本次清理不部署、不操作生产、不发邮件，也不执行历史改写。
