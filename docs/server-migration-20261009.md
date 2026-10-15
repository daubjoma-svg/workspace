# 服务器部署与本地数据迁移记录

访问地址：`http://180.76.250.61/`。项目目录：`/opt/sop-system-manual`。
使用 Compose 内的 MySQL 8.4，未切换到外部数据库。

## 迁移范围

- 本地当前使用的 MySQL `sop_system`，共 20 张表；没有使用旧的 `server/data/sop.db`。
- `server/uploads`：36 个上传文件。
- `server/data/repos`：36,508 个仓库文件。
- 与本地数据库密文匹配的 `SOP_MASTER_KEY`，写入服务器项目 `.env`。
- 项目 `APP_BASE_URL` 改为实际公网地址，避免通知链接继续使用模板域名。
- 同步本地应用源码并重新构建镜像，保留旧镜像标签 `sop-system:before-local-sync-20261009`。

迁移为一次快照复制。本地和服务器后续产生的新数据不会自动同步。
迁移后使用原来的本地账号和密码，未重置业务账号。

## 验证方法

导入前后比较全部表的记录数量与排序后的内容 SHA256；比较每个文件的相对路径和内容 SHA256。
验证 13 个加密值可由迁移后的主密钥解密。公网检查首页、健康接口、管理员登录、需求列表及全部上传文件。
新镜像启动后再次验证全部数据与文件摘要一致，后端源码和数据库迁移文件的摘要也与本地相同。

主要业务数量：用户 10、需求 8、模板 2、节点 16、附件记录 46、通知 167、AI 任务 44。
文件和数据库导出包都在上传后校验 SHA256；macOS 打包时禁用扩展属性和 AppleDouble 元数据。

## 保留的备份

迁移前的数据库、上传文件、仓库快照位于：

`/opt/sop-system-manual/backups/20261009-140606/`

其中 `project-before-sync.tar.gz` 保存更新前的项目源码。
服务器 `.env` 的历史副本保存在项目目录，名称为 `.env.before-local-mysql-*`。
原始迁移包保存在项目的 `import/` 目录（权限 700）；该目录已从 Docker 构建上下文中排除。
不要删除备份，也不要执行 `docker compose down -v`，该命令会删除持久化数据卷。

## 日常检查与备份

SSH 登录服务器后执行：

```bash
cd /opt/sop-system-manual
docker compose ps
curl -fsS http://127.0.0.1:4000/api/health
docker compose logs --tail=100 app
```

期望 app、mysql、nginx 均为 `healthy`，健康接口中的 db、dist、master_key 均为 `ok`。
备份当前数据库、上传文件和仓库快照：

```bash
INCLUDE_REPOS=1 bash deploy/backup.sh
```

主密钥需单独保管，恢复数据库时必须使用与备份密文对应的主密钥。

## 运行依赖限制

本地启用的 AI Provider 为 Trae CLI。当前基础镜像未安装 Trae CLI，且本地 CLI 登录态没有迁移。
历史 AI 数据可以查看；新的 AI 执行需补齐 Linux CLI 及授权，或配置服务器可调用的 HTTP Provider。
GitLab、Jira、飞书等外部服务的网络可达性和实际业务调用未在本次迁移中验证。

本次操作未修改 SSH、root 密码、防火墙或其他主机系统配置。
