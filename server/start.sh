#!/bin/bash
# AI-SOP 服务守护脚本：崩溃自动拉起，nohup 后台常驻
# 用法：./start.sh           （启动守护）
#       pkill -f ai-sop-daemon  （停止）
cd /Users/admin/workspace/code/sop-system/server
export SOP_MASTER_KEY=$(cat /Users/admin/workspace/code/sop-system/.sop-master-key)
export NODE_ENV=production

# 如果已在跑就退出
if lsof -ti :4000 >/dev/null 2>&1; then
  echo "[守护] 服务已在运行 (端口 4000)，跳过启动"
  echo "[守护] 本机访问: http://localhost:4000/"
  LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
  [ -n "$LAN_IP" ] && echo "[守护] 局域网访问: http://$LAN_IP:4000/"
  exit 0
fi

nohup bash -c '
while true; do
  cd /Users/admin/workspace/code/sop-system/server
  export SOP_MASTER_KEY="'"$(cat /Users/admin/workspace/code/sop-system/.sop-master-key)"'"
  export NODE_ENV=production
  node src/index.js >> /tmp/ai-sop.log 2>&1
  echo "$(date "+%F %T") 服务退出 code=$?，2s 后自动拉起" >> /tmp/ai-sop-restart.log
  sleep 2
done
' > /dev/null 2>&1 &
echo "[守护] 已启动，日志: /tmp/ai-sop.log，重启记录: /tmp/ai-sop-restart.log"
echo "[守护] 查看: tail -f /tmp/ai-sop.log"
echo "[守护] 本机访问: http://localhost:4000/"
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
[ -n "$LAN_IP" ] && echo "[守护] 局域网访问: http://$LAN_IP:4000/"
