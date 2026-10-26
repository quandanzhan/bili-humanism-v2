#!/bin/bash
# 停用指定的 V1 服务，备份并生成回滚脚本。执行前显式配置目标。
set -eu
: "${V1_HOME:?请设置 V1_HOME 为旧版数据目录}"
: "${V1_UNITS:?请设置 V1_UNITS 为要停用的 systemd 单元列表}"
: "${V2_BASE_URL:?请设置 V2_BASE_URL 为新版服务地址}"
: "${V2_AUTH_USER:?请设置 V2_AUTH_USER}"
: "${V2_AUTH_PASS:?请设置 V2_AUTH_PASS}"
TS=$(date +%Y%m%d-%H%M%S)
BK="${V1_BACKUP_DIR:-./backups}/v1-stop-$TS"
ROLLBACK="${V1_ROLLBACK_FILE:-./rollback-v1.sh}"
mkdir -p "$BK"
for u in $V1_UNITS; do
  systemctl cat "$u" > "$BK/$u.txt" 2>/dev/null || true
  printf '%-32s %s\n' "$u" "$(systemctl is-enabled "$u" 2>/dev/null || true)/$(systemctl is-active "$u" 2>/dev/null || true)" >> "$BK/STATE.txt"
done
crontab -l > "$BK/crontab.txt" 2>/dev/null || true
cp -a "$V1_HOME/reply-service/state.sqlite3" "$BK/state.sqlite3" 2>/dev/null || true
cp -a "$V1_HOME/AGENTS.md" "$BK/" 2>/dev/null || true
for u in $V1_UNITS; do
  systemctl disable --now "$u" >> "$BK/disable.log" 2>&1
  printf '  %-32s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || true)"
done
curl --fail --silent --show-error -o /dev/null -w '/api/health → HTTP %{http_code}\n' \
  -u "$V2_AUTH_USER:$V2_AUTH_PASS" "${V2_BASE_URL%/}/api/health"
curl --fail --silent --show-error -u "$V2_AUTH_USER:$V2_AUTH_PASS" \
  "${V2_BASE_URL%/}/api/reply-loop" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("回复循环 mode=%s seeded=%s"%(d["mode"],d["seeded"]))'
# 回滚脚本只引用环境变量，不把凭据复制到磁盘。
cat > "$ROLLBACK" <<'RB'
#!/bin/bash
set -eu
: "${V1_UNITS:?请设置 V1_UNITS}"
: "${V2_BASE_URL:?请设置 V2_BASE_URL}"
: "${V2_AUTH_USER:?请设置 V2_AUTH_USER}"
: "${V2_AUTH_PASS:?请设置 V2_AUTH_PASS}"
curl --fail --silent --show-error -u "$V2_AUTH_USER:$V2_AUTH_PASS" \
  -X PUT -H 'Content-Type: application/json' --data-binary '{"mode":"off"}' \
  "${V2_BASE_URL%/}/api/reply-loop" >/dev/null
for u in $V1_UNITS; do
  systemctl enable --now "$u"
done
RB
chmod +x "$ROLLBACK"
printf '完成，备份在 %s；回滚脚本在 %s\n' "$BK" "$ROLLBACK"
