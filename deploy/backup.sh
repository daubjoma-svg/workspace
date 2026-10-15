#!/usr/bin/env bash
# 备份 MySQL 与用户上传文件。仓库快照可重新同步，默认不备份以控制备份体积。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_ROOT="${BACKUP_DIR:-$PROJECT_DIR/backups}"
BACKUP_TIME="$(date +%Y%m%d-%H%M%S)"
TARGET_DIR="$BACKUP_ROOT/$BACKUP_TIME"

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "[备份失败] 未找到 Docker Compose" >&2
    exit 1
  fi
}

cd "$PROJECT_DIR"
if [ ! -f .env ]; then
  echo "[备份失败] 缺少 $PROJECT_DIR/.env" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

echo "[备份] 开始导出 MySQL..."
compose exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --routines --triggers "$MYSQL_DATABASE"' \
  | gzip -9 > "$TARGET_DIR/mysql.sql.gz"

echo "[备份] 开始归档上传文件..."
compose exec -T app tar -C /app/server -czf - uploads > "$TARGET_DIR/uploads.tar.gz"

if [ "${INCLUDE_REPOS:-0}" = "1" ]; then
  echo "[备份] 开始归档代码仓库快照..."
  compose exec -T app tar -C /app/server -czf - data/repos > "$TARGET_DIR/repos.tar.gz"
fi

{
  printf 'created_at=%s\n' "$(date -Iseconds)"
  printf 'project=%s\n' "${COMPOSE_PROJECT_NAME:-sop-system}"
  printf 'repos_included=%s\n' "${INCLUDE_REPOS:-0}"
} > "$TARGET_DIR/manifest.txt"

echo "[备份完成] $TARGET_DIR"
echo "[重要] SOP_MASTER_KEY 不会写入备份，请在独立的密码管理器中保管。"

