#!/usr/bin/env bash
# 从 deploy/backup.sh 的产物恢复 MySQL 与上传文件。该操作会覆盖当前数据，必须显式确认。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_SET="${1:-}"

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "[恢复失败] 未找到 Docker Compose" >&2
    exit 1
  fi
}

if [ -z "$BACKUP_SET" ] || [ ! -d "$BACKUP_SET" ]; then
  echo "用法：CONFIRM_RESTORE=YES $0 /absolute/path/to/backup-set" >&2
  exit 1
fi
if [ "${CONFIRM_RESTORE:-}" != "YES" ]; then
  echo "[恢复已取消] 该操作会覆盖当前数据库和上传文件；确认后设置 CONFIRM_RESTORE=YES" >&2
  exit 1
fi
if [ ! -f "$BACKUP_SET/mysql.sql.gz" ] || [ ! -f "$BACKUP_SET/uploads.tar.gz" ]; then
  echo "[恢复失败] 备份集中缺少 mysql.sql.gz 或 uploads.tar.gz" >&2
  exit 1
fi

cd "$PROJECT_DIR"
if [ ! -f .env ]; then
  echo "[恢复失败] 缺少 $PROJECT_DIR/.env" >&2
  exit 1
fi

echo "[恢复] 停止应用并启动 MySQL..."
compose stop app >/dev/null 2>&1 || true
compose up -d mysql

for _ in $(seq 1 60); do
  if compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqladmin ping -h 127.0.0.1 -uroot --silent' >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqladmin ping -h 127.0.0.1 -uroot --silent' >/dev/null 2>&1; then
  echo "[恢复失败] MySQL 未在预期时间内就绪" >&2
  exit 1
fi

echo "[恢复] 重建业务数据库..."
compose exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "DROP DATABASE IF EXISTS \`$MYSQL_DATABASE\`; CREATE DATABASE \`$MYSQL_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL PRIVILEGES ON \`$MYSQL_DATABASE\`.* TO \"$MYSQL_USER\"@\"%\"; FLUSH PRIVILEGES;"'
gzip -dc "$BACKUP_SET/mysql.sql.gz" \
  | compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot "$MYSQL_DATABASE"'

echo "[恢复] 覆盖上传文件..."
compose run --rm -T --no-deps app sh -c \
  'find /app/server/uploads -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf - -C /app/server' \
  < "$BACKUP_SET/uploads.tar.gz"

if [ -f "$BACKUP_SET/repos.tar.gz" ]; then
  echo "[恢复] 覆盖代码仓库快照..."
  compose run --rm -T --no-deps app sh -c \
    'find /app/server/data/repos -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf - -C /app/server' \
    < "$BACKUP_SET/repos.tar.gz"
fi

echo "[恢复] 启动应用..."
compose up -d app
echo "[恢复完成] 请执行 curl -fsS http://127.0.0.1:${APP_PORT:-4000}/api/health 验证服务。"

