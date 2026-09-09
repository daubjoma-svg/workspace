#!/bin/bash
# AI-SOP 后端启动脚本 — 服务挂了自己跑这个（双击或在终端执行）
# 用法: bash start-server.sh   或   chmod +x start-server.sh && ./start-server.sh
cd "$(dirname "$0")/server" || exit 1

lan_url() {
  local ip
  ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
  if [ -n "$ip" ]; then
    echo "局域网访问: http://$ip:4000/"
  fi
}

# 若已在运行则提示
if lsof -ti :4000 >/dev/null 2>&1; then
  echo "服务已在运行 (端口 4000, PID $(lsof -ti :4000 | head -1))"
  echo "本机访问: http://localhost:4000/"
  lan_url
  open http://localhost:4000/
  exit 0
fi

# 固定 master key（首次运行生成并缓存）
KEY_FILE="$(dirname "$0")/.sop-master-key"
if [ ! -f "$KEY_FILE" ]; then
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" > "$KEY_FILE"
  echo "已生成固定加密密钥 → $KEY_FILE（请妥善保管，更换会丢失已存凭据）"
fi
export SOP_MASTER_KEY="$(cat "$KEY_FILE")"

# 启动
echo "启动 AI-SOP 后端 (端口 4000)..."
nohup node src/index.js >> /tmp/sop-server.log 2>&1 &
disown
sleep 2
if lsof -ti :4000 >/dev/null 2>&1; then
  echo "启动成功 ✓  本机访问: http://localhost:4000/"
  lan_url
  open http://localhost:4000/
else
  echo "启动失败，日志："
  tail -10 /tmp/sop-server.log
fi
