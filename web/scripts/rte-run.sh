#!/usr/bin/env bash
# RTE 验证编排：同一进程内启动 后端 + vite + playwright。
# 不主动 kill（沙箱会在任务结束时统一回收子进程），避免触发删除/进程管理拦截。
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "[run] start backend..."
(cd server && node start-dev.js > /tmp/sop-server.log 2>&1) &
BACK_PID=$!

echo "[run] start vite..."
(cd web && npm run dev > /tmp/sop-vite.log 2>&1) &
VITE_PID=$!

# 等待后端 + 前端就绪（最多 45s）
BOK=000; VOK=000
for i in $(seq 1 45); do
  BOK=$(curl -s -m 2 -o /dev/null -w "%{http_code}" http://localhost:4000/api/health 2>/dev/null || true)
  VOK=$(curl -s -m 2 -o /dev/null -w "%{http_code}" http://localhost:5173/ 2>/dev/null || true)
  if [ "$BOK" != "000" ] && [ "$VOK" = "200" ]; then break; fi
  sleep 1
done
echo "[run] backend=$BOK vite=$VOK"

echo "[run] run playwright..."
cd "$ROOT/web"
node scripts/rte-verify.mjs
RC=$?
echo "[run] playwright exit=$RC"
exit $RC
