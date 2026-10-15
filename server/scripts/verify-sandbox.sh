#!/bin/bash
# 沙箱边界自检：验证 AI 子进程的 Seatbelt 约束是否有效。
# 任何一项 FAIL 都意味着主机隔离被破坏，应立即停止 AI 功能并排查 profile。
# 用法：bash scripts/verify-sandbox.sh   （在 server/ 目录下执行）

set -u
cd "$(dirname "$0")/.."

echo "[1/4] 生成沙箱 profile ..."
node -e "require('./src/sandbox/seatbelt').ensureSandbox()" >/dev/null 2>&1 || { echo "  profile 生成失败"; exit 1; }

PROFILE="$PWD/data/sandbox/profile.sb"
REPOS="$(node -e "console.log(require('fs').realpathSync('data/repos'))")"
TRAEHOME="$(node -e "console.log(require('fs').realpathSync('data/trae-home'))")"
REPOFILE="$(find "$REPOS" -maxdepth 2 -type f 2>/dev/null | head -1)"

pass=0; total=0
chk() {
  local expect="$1"; shift
  total=$((total+1))
  /usr/bin/sandbox-exec -f "$PROFILE" "$@" >/dev/null 2>&1
  local got=$?
  if { [ "$expect" = "allow" ] && [ "$got" -eq 0 ]; } || { [ "$expect" = "deny" ] && [ "$got" -ne 0 ]; }; then
    pass=$((pass+1)); printf '  ok    %-5s %s\n' "$expect" "$*"
  else
    printf '  FAIL  %-5s (exit %s) %s\n' "$expect" "$got" "$*"
  fi
}

echo "[2/4] 读边界（只允许已添加的代码仓库快照）"
if [ -n "$REPOFILE" ]; then
  chk allow /bin/cat "$REPOFILE"
else
  echo "  （跳过：data/repos 下没有快照文件，先在「模块管理」同步一个模块）"
fi
chk deny  /bin/ls /Users
chk deny  /bin/ls /Users/admin
chk deny  /bin/ls /Users/admin/Library
chk deny  /bin/ls /Users/admin/Desktop
chk deny  /bin/cat /etc/master.password
chk deny  /bin/ls /Library/Preferences
chk deny  /bin/ls /private/var/root
chk deny  /bin/ls /private/var/folders
chk deny  /bin/ls /Volumes
chk allow /bin/cat /etc/ssl/cert.pem

echo "[3/4] 写边界（沙箱内只读；唯一可写为 trae-home 运行时目录）"
chk deny  /usr/bin/touch "$REPOS/.write-probe"
chk deny  /usr/bin/touch /tmp/.sandbox-write-probe
chk deny  /usr/bin/touch "$HOME/.sandbox-write-probe"
chk allow /usr/bin/touch "$TRAEHOME/.write-probe"
rm -f "$TRAEHOME/.write-probe" "$REPOS/.write-probe" 2>/dev/null

echo "[4/4] 危险命令与网络"
chk deny  /usr/bin/osascript -e return\ 1
chk deny  /usr/bin/security find-generic-password
chk deny  /usr/bin/curl -s --max-time 4 http://127.0.0.1:4000/
chk deny  /bin/ls /opt/homebrew/etc

echo "RESULT: $pass/$total"
if [ "$pass" -ne "$total" ]; then
  echo "存在失败项：主机隔离可能被破坏，请勿放行 AI 功能。"
  exit 1
fi
echo "沙箱边界自检全部通过。"
