# Docker Compose 部署指南

本文是当前 MySQL 版本的部署说明。旧的 SQLite 部署评估文档只保留历史背景，不再作为执行依据。

## 1. 部署结构

- `nginx`：Compose 内置反向代理；当前无域名时提供 IP HTTP，后续可替换为 HTTPS 配置。
- `app`：Node.js 22 应用，同时托管 React 构建产物和 API，仅监听宿主机回环地址。
- `mysql`：MySQL 8.4，仅通过 Docker 内部网络访问。
- `app-data`：保存 GitLab 仓库快照等运行数据。
- `app-uploads`：保存用户上传图片。
- MySQL 不映射宿主机端口；公网只暴露 Nginx 的 80 端口。

当前应用包含进程内 AI 任务和仓库同步逻辑，生产环境保持单个 `app` 实例，不要直接横向扩容。

## 2. 服务器准备

建议使用 Linux x86_64，最低 2 核 4GB；代码仓库较多时建议 4 核 8GB。磁盘至少预留 20GB，并根据仓库快照增长情况扩容。

服务器需要：

- Docker Engine 与 Docker Compose v2；
- 能访问镜像仓库或已提前导入基础镜像；
- 能访问实际使用的 GitLab、AI Provider、Jira、飞书地址；
- 若使用企业自签 HTTPS 证书，需要把企业根证书加入应用镜像；
- 公网部署需要域名、HTTPS 证书和 Nginx/Caddy。

## 3. 首次部署

在服务器进入项目目录后执行：

```bash
cp .env.example .env
chmod 600 .env
```

生成三个随机值：

```bash
openssl rand -base64 32
openssl rand -base64 32
openssl rand -base64 32
```

依次填入 `.env` 的 `DB_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`SOP_MASTER_KEY`。同时修改：

- `APP_BASE_URL`：最终访问地址，例如 `https://sop.example.com`；
- `APP_BIND_IP`：使用宿主机反向代理时保持 `127.0.0.1`，可信内网直接访问时改为 `0.0.0.0`；
- `APP_PORT`：默认 `4000`。

主密钥生成后必须长期保存。升级、重启和迁移时继续使用同一个 `SOP_MASTER_KEY`，否则数据库内的第三方凭据无法解密。

校验、构建并启动：

```bash
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
```

验证健康状态：

```bash
curl -fsS http://127.0.0.1:4000/api/health
```

期望返回 `status: "ok"`，且 `db`、`dist`、`master_key` 均为 `ok`。

仅在数据库为空时初始化默认账号，管理员为 `admin / admin123`，请首次登录后在管理界面修改。
导入已有数据库后保留原账号和密码，不会生成新的管理员密码文件。

当前 Compose 内置 Nginx 已阻断 `/api/auth/register` 和 `/api/v1/auth/register`，不应直接把应用的 4000 端口暴露公网。

## 4. 配置 HTTPS 反向代理

当前无域名部署使用 `deploy/nginx/sop-system.http.conf`，由 Compose 内的 Nginx 监听 80。
取得域名和证书后，Nginx 模板位于 `deploy/nginx/sop-system.conf.example`。替换域名和证书路径后，改为挂载 HTTPS 配置并执行：

```bash
nginx -t
systemctl reload nginx
```

如果暂时只在可信内网通过 IP 访问，可把 `.env` 中 `APP_BIND_IP` 改为 `0.0.0.0`，然后执行：

```bash
docker compose up -d --force-recreate app
```

## 5. 日常升级

升级前先备份：

```bash
./deploy/backup.sh
```

确认备份完成后拉取代码并重新构建：

```bash
git pull --ff-only
docker compose build --pull app
docker compose up -d app
docker compose ps
curl -fsS http://127.0.0.1:4000/api/health
```

应用启动时会自动执行数据库结构迁移。由于 MySQL DDL 不保证整体事务回滚，升级前备份不可省略。

## 6. 备份与恢复

默认备份 MySQL 和上传文件：

```bash
./deploy/backup.sh
```

仓库快照通常可以从 GitLab 重新同步；确需备份时执行：

```bash
INCLUDE_REPOS=1 ./deploy/backup.sh
```

备份默认写入项目根目录 `backups/<时间>/`。`SOP_MASTER_KEY` 不会自动写入备份，必须与数据库备份分开保管。

恢复会覆盖当前数据，先人工确认备份目录和 `.env` 中的主密钥，再执行：

```bash
CONFIRM_RESTORE=YES ./deploy/restore.sh /absolute/path/to/backup-set
```

## 7. Trae CLI 与旧 SQLite 数据

应用镜像安装官方 Trae CLI `0.207.1-tob`，安装脚本与发行包均校验 SHA256。
`TRAECLI_BIN=/usr/local/bin/traecli`，授权配置保存在 `app-trae` 数据卷的 `/home/node/.trae`。
CLI 安装不代表已经授权；不会复制本地 HOME、其他工具凭据或预置令牌。

在服务器项目目录检查版本和登录状态：

```bash
docker compose exec app traecli --version
docker compose exec app traecli login status
```

使用 CLI 官方登录流程：

```bash
docker compose exec app traecli login
```

根据终端提示完成浏览器授权。企业 PAT 也可在 SOP 管理界面对应的 Trae Provider 中填写，
应用会在调用 CLI 时通过进程环境传递该令牌，不需要把令牌写入 Compose 或镜像。
授权后在管理界面测试启用的 Provider；模型必须在授权账号可用的模型列表中。
不要为绕过 CLI 沙箱报错而开启特权容器或修改主机内核、Docker、SSH 配置。
`app-trae` 可能包含敏感凭据，当前数据库备份脚本不会归档它，需独立妥善保管。

若需要把现有 `server/data/sop.db` 数据迁移到服务器 MySQL，不要直接把 SQLite 文件挂到应用容器。应在正式部署前使用 `server/scripts/migrate-sqlite.js` 做一次性迁移，并同时准备旧、新 `SOP_MASTER_KEY`。

## 8. 常用排障命令

```bash
docker compose ps
docker compose logs --tail=200 app
docker compose logs --tail=200 mysql
docker compose restart app
docker compose exec mysql mysql -usop_app -p sop_system
```

数据库不对外暴露端口。如确需临时从宿主机连接，应使用 `docker compose exec mysql ...`，不要长期开放 3306。
