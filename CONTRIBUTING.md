# 参与贡献

## 环境

- Node.js 22 及以上，使用随 Node 提供的 npm。
- 首次准备：`npm ci`，然后 `cp -n secrets/.env.template .env`。
- `.env` 只放本机的合成或测试值，**永远不要提交**。仓库的 `.gitignore` 已排除真实配置、运行数据与凭据文件。

## 提交前自查

```bash
node --check main.mjs
npm run test:security
npm run security:scan -- --include-private
python3 scripts/package-source.py --output /tmp/bili-review-candidate
```

`test:security` 需要 PATH 中可调用的 Git。完整跨模块回归在本地执行：

```bash
node gateway/tests/isolated-regression.mjs
```

它在临时目录中使用合成认证和本地假服务，不访问外部网络。

## 代码约定

- 运行路径一律从 `gateway/runtime.mjs` 的 `ROOT` / `DATA_DIR` / `LEGACY_DIR` 推导，不要写死开发机路径。
- 新增配置项时同步更新 `secrets/.env.template`、`README.md` 与 `DEPLOYMENT.md`。
- 日志、错误响应、SSE 与告警正文必须经过 `redactText` / `redactData`，不得输出密钥、Cookie、会话值或完整请求头。
- 测试只使用合成凭据与临时目录；不要针对生产地址或真实账号编写测试。
- 变更工具或模型路由时，补充 `gateway/tests/contracts.test.mjs` 或对应的专项测试。

## Pull Request

说明改动目的、影响范围与验证方式。涉及配置契约、认证或数据目录的改动请在描述里写清迁移影响。提交信息使用简洁的祈使句即可。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 Issue。
