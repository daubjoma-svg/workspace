#!/usr/bin/env bash
# RTE 真实浏览器验证：单命令完成 启动 dev → 就绪探测 → playwright 断言 → 清理
set -e
cd "$(dirname "$0")/.."
nohup npm run dev > /tmp/vite-dev-rte.log 2>&1 &
VITE_PID=$!
cleanup() { kill "$VITE_PID" 2>/dev/null || true; }
trap cleanup EXIT
for i in $(seq 1 25); do
  if curl -s -o /dev/null --noproxy '*' --max-time 2 "http://localhost:5173/rte-demo.html"; then
    echo "[rte-verify] vite ready after ${i}s"
    break
  fi
  sleep 1
done
node scripts/rte-playwright.mjs
