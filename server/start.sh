#!/bin/bash
# AI-SOP 启动/重启脚本。
# 每次执行都会：1) 重新构建前端产物 web/dist；2) 重启后端服务。
# 保证浏览器访问到的界面始终与当前代码一致，避免源码已改但线上仍是旧打包产物。
# 服务优先使用唯一的 launchd 服务，避免 nohup 守护与 launchd 同时抢占 4000 端口。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$PROJECT_DIR/web"
LABEL="com.ai-sop.server"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# 先打包前端：构建失败则直接终止，不把旧产物当新版本重启。
if ! command -v npm >/dev/null 2>&1; then
  echo "[构建] 未找到 npm，无法构建前端；请先安装 Node.js" >&2
  exit 1
fi
if [ ! -d "${WEB_DIR}/node_modules" ]; then
  echo "[构建] 未找到 ${WEB_DIR}/node_modules，请先在 web 目录执行 npm install" >&2
  exit 1
fi
echo "[构建] 开始构建前端产物（${WEB_DIR}）..."
(cd "${WEB_DIR}" && npm run build)
echo "[构建] 前端产物已更新：${WEB_DIR}/dist"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "$DOMAIN/$LABEL"
  echo "[服务] 已重启 $LABEL"
elif [ -f "$PLIST" ]; then
  # 首次使用或被 unload 后，重新注册再启动。
  launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "[服务] 已启动 $LABEL"
else
  # 开发环境未安装 launchd 配置时，才使用独立守护进程兜底。
  if lsof -ti :4000 >/dev/null 2>&1; then
    echo "[服务] 4000 端口已被其他进程占用，未启动备用服务" >&2
    exit 1
  fi
  export SOP_MASTER_KEY="$(cat "$PROJECT_DIR/.sop-master-key")"
  export NODE_ENV=production
  nohup bash -c "
    while true; do
      cd '$SCRIPT_DIR'
      export SOP_MASTER_KEY='\$SOP_MASTER_KEY'
      export NODE_ENV=production
      node src/index.js >> /tmp/ai-sop.log 2>&1
      sleep 2
    done
  " >/dev/null 2>&1 &
  echo "[服务] 未找到 launchd 配置，已启动备用守护进程"
fi

for _ in {1..10}; do
  if curl -fs --max-time 1 http://127.0.0.1:4000/api/health >/dev/null 2>&1; then
    echo "[服务] 健康检查通过：http://localhost:4000/"
    exit 0
  fi
  sleep 1
done

echo "[服务] 进程已发起，但健康检查未在 10 秒内通过；请查看 /tmp/ai-sop-launchd.err.log" >&2
exit 1
