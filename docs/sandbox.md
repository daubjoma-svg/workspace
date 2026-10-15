# AI 沙箱（主机隔离）设计说明

> 需求原文：这个应用不允许操作主机电脑的任何东西，也不允许看，只能看已经添加的代码；
> 把这些封装成一个沙箱，不允许任何人操作沙箱外的任何东西；沙箱内的也只能读。

## 边界定义

| 区域 | 路径 | 权限 |
|---|---|---|
| 沙箱内（已添加的代码） | `server/data/repos/*`（仓库快照） | **只读** |
| 运行时目录（与主机数据无关） | `server/data/trae-home`、`server/data/sandbox/tmp` | 读写（CLI 会话状态/临时文件） |
| 主机其余一切 | `~`、`~/Desktop`、`~/Library`、`/Volumes`、`/private/var/root`、`/Library/Preferences`、`/etc`（个别文件除外）… | **不可读、不可写** |

网络：仅出站 TCP 443/80 与 DNS 53（LLM API 调用所需）；禁止监听、禁止本地 unix socket
（含 `docker.sock`）、禁止回连本机服务。

## 四道闸（纵深防御）

所有 AI 子进程（traecli 的 `exec` 与 `acp serve` 两种形态）自 `sandbox/seatbelt.js` 的
`spawnSandboxed()` 唯一出口启动：

1. **Seatbelt（macOS `sandbox-exec`）——硬边界**
   - 默认拒绝一切写入（`deny file-write*`），仅放行 trae-home / sandbox-tmp；
     仓库快照对 AI **只读**。
   - 隐藏所有用户与主机敏感目录（`deny file-read*` 定向树 + 白名单例外后置，
     SBPL last-match-wins；本机实测「无过滤 deny + 后置 allow」会编译崩溃，故用此形态）。
   - 禁止 `osascript`/`open`/`security`/`system_profiler` 等主机探测与自动化命令，
     禁止 Finder/AppleEvents 等 mach 服务（防借自动化服务绕过文件读边界）。
   - profile 生成于 `server/data/sandbox/profile.sb`，路径全部来自常量，无外部输入。
2. **进程环境隔离**
   - 子进程环境仅 8 个良性变量（PATH/HOME/TRAE_HOME/TMPDIR/LANG/TZ 等），
     **绝不继承** `process.env`——此前 `...process.env` 透传会让模型一条
     `printenv` 读走 DB 密码与 SOP_MASTER_KEY。
   - `HOME`/`TRAE_HOME` 指向 `server/data/trae-home`，不加载主机 `~/.trae` 的全局
     MCP 配置（`trae_cli.yaml` 里有 computer-use 等危险 server），也不带会话历史。
     引导时仅拷贝 `model-provider/`、`traecli.toml`、`installation_id`、`cli/auth.json`
     （登录凭据，源端重新 login 后自动刷新）。
3. **协议层收紧（`agent/acp-client.js`）**
   - `--permission-mode` 一律不允许 `bypass_permissions`（传入即降级并告警）；
     并强制 `-s read-only` 让模型生成的 shell 命令按只读策略执行。
   - `session/request_permission` 一律拒绝（越权读/写/联网命令直接取消）。
   - `fs/read_text_file` 读盘代理运行在**服务器进程内、不受 Seatbelt 约束**，
     因此自设白名单：只允许会话仓库根内的路径（realpath 防符号链接逃逸），
     敏感文件剔除、内容脱敏。
4. **AI 路径无写操作（`agent/tools.js`）**
   - 移除了评估时自动 `git pull`（写快照 + 碰主机 git 配置）；
     快照更新只走「模块管理」的管理员同步动作。

## 非 macOS 平台

`sandbox-exec` 仅 macOS 可用。Linux（docker-compose 部署）上退化为直启并打告警——
依赖容器/VM 作为边界；协议层（第 3、4 道）在所有平台始终生效。

## 已知残留风险（明示）

- 沙箱内的 `trae-home/cli/auth.json`（trae 账号凭据）对子进程自身可读——
  这是 CLI 正常工作所需，与改造前一致（改造前它能读到的远多于此）。
- 出站 443/80 未按目标域名收窄（SBPL 网络规则只支持端口通配）；由于主机文件
  均不可读，可外传的内容只剩仓库快照本身（本就是交给 AI 的）。
- `process-info*` 未收紧：可看到进程列表元数据（无文件内容）。

## 验证

- `bash server/scripts/verify-sandbox.sh`：19 项边界探针（读/写/危险命令/网络），
  任一 FAIL 即表示隔离被破坏。
- 实测记录（2026-10）：exec 路径真实模型调用成功（5.9s）；ACP 路径正常代码问答完好
  （81s 完整回答）；同路径诱饵 `ls /Users/admin/Desktop` 被拒（Operation not permitted）；
  子进程 `printenv` 仅见 8 个良性变量。
