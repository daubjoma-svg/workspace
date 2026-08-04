# Phase 4 部署与验证方案（运维契约）

> 作者：卜宕机（DevOps） | 版本：v1.0 | 日期：2026-08-04
> 依据：`docs/SPEC-v1.0.md` §4/§12、`docs/tech-spec-phase1.md` §3.4/§5.3/§9、`README.md`
> 知识库基线：`01-standards/production-readiness-scorecard.md`、`architecture/mvp-stack.md`、`cost-models/development-costs.md`
> 状态：待命中。本文只做规划，未修改任何代码与配置。

---

## 0. 结论摘要

**当前生产就绪总档：未达 Bronze。** 记分卡规则是"总档取各维最低档"，短板在**发布安全**——项目目前连 Bronze 的"能回退"都不成立。

三句话说清现状：

1. **回滚不存在。** 项目根目录没有 git 仓库（`git status` 报 not a repository，且父目录也没有），没有 tag、没有历史、没有 .gitignore。一旦部署出问题，没有任何东西可以退回去。这是 Phase 4 的第一阻断项，且**不依赖后端开发进度，现在就能补**。
2. **健康检查目前会"假绿"。** `server/src/index.js:16` 的 catch-all `app.get(/^(?!\/api).*/)` 会把所有非 `/api` 路径回 `index.html`。也就是说探测 `/health` 恒返回 200 + HTML —— 哪怕数据库已经挂了。健康检查端点必须挂在 `/api/health` 之下，并真实探测依赖。
3. **Node 版本契约写错了，会导致部署即挂。** 架构文档 §0 锁定 "Node.js >= 18"，但实际依赖 `better-sqlite3@13.0.2` 的 `engines` 是 **`>=22`**。目标机若装 Node 18/20，`npm ci` 只 warn 不 fail，然后运行时崩。必须改文档并锁 Node 22。

好消息一条：`better-sqlite3@13.0.2` 走 **Node-API**（依赖 `node-addon-api@^8`，`prebuilds/` 下 8 个平台预编译产物齐全，含 `linux-x64` / `linux-arm64` / `linuxmusl-*`）。**目标机不需要编译工具链，不需要 node-gyp**。这对"代码不出内网"的私有化交付是实质性利好，内网离线装机难度大幅下降。

**目标档：Silver**（记分卡定义的商业级最低线）。差距与补救见 §2。

---

## 1. 部署方案选型

### 1.1 云托管方案全部排除（合规硬约束，不是成本问题）

SPEC §1 把产品定位钉死为「**全私有化部署（代码不出内网）**」，SPEC §10 进一步约束「系统对 GitLab 仓库只读」。这条定位直接判掉了知识库 `mvp-stack.md`「部署方案」表里的三个高星选项：

| 知识库推荐方案 | 知识库评分 | 本项目结论 |
|---|---|---|
| Vercel | 5/5 | **排除**：源码与构建产物出内网 |
| CloudBase | 5/5 | **排除**：数据与云函数托管在公有云 |
| Railway | 4/5 | **排除**：同上，且需公网出口 |
| Docker + 云服务器 | 4/5 | 变形保留 → **Docker + 客户内网服务器** |
| 腾讯云 Serverless | 4/5 | **排除**：同 CloudBase |

成本口径也随之改写：`development-costs.md` 的隐性成本项「服务器/云服务 ¥100-500/月」在本项目**归零** —— 部署在客户已有的内网服务器上，增量基础设施成本为 0；「AI API 调用 ¥200-2000/月」由客户自备 Provider 密钥承担，不进我方成本；真正需要预算的只剩「运维监控：日志/告警/备份」，而本方案用 systemd + journald + cron 覆盖，同样零采购。

### 1.2 候选方案对比

| 维度 | A. systemd + Node 直跑 | B. Docker Compose |
|---|---|---|
| 目标机前置依赖 | Node >= 22 | Docker + Compose |
| 回滚粒度 | releases 目录 + 软链切换（秒级） | 镜像 tag 重启 |
| 数据持久化风险 | 低（就在宿主机文件系统） | **中**：`server/data` 必须 volume 挂载，否则容器重建即丢库 |
| 与架构契约契合 | 完全契合（§4「单进程 Node + 静态前端，零外部服务」） | 多一层抽象 |
| 内网离线可行性 | 高（N-API 预编译，无需编译链） | 需预先导入镜像 tar |
| 排障成本 | 低（日志、文件、进程都在宿主机） | 中 |

**结论：Phase 4 选 A（systemd + Node 直跑），B 作为备选**，仅当客户已有容器平台且要求统一纳管时启用。

选 A 的核心理由：本系统**零外部服务依赖**（无 PostgreSQL、无 Redis、无消息队列，数据库是进程内嵌的 SQLite 文件）。给一个零依赖的单进程套一层容器，换不来隔离收益，只增加"数据卷挂错就丢库"的新故障模式。

> 若启用方案 B，Dockerfile 必须多阶段构建（web 构建阶段产出 dist，运行阶段只带 server + dist），且 `server/data` **必须**声明为 volume。这一条写死，不接受"先跑起来再说"。

---

## 2. 生产就绪记分卡评级

目标档 Silver。当前评级与证据如下（评级人：卜宕机，评级时间：2026-08-04，Phase 3 开发中）：

| 维度 | 当前档 | 证据 | 离 Silver 差什么 | 责任人 |
|---|---|---|---|---|
| 测试 + 回归 | **未达 Bronze** | `server/package.json` 与 `web/package.json` 均无 `test` script；无 CI（无 `.github/`）；构建/lint 无门禁 | 核心流自动化测试 + 回归集进门禁 | qa / backend |
| 契约 | Bronze | `docs/openapi.yaml` 存在，SPEC §5 锁定端点清单 | 错误模型不统一（老端点裸 JSON，新端点 `{code,data,message}` 包络，ADR-007 有意为之）；契约对照未进 CI | architect / backend |
| 安全 | **未达 Bronze** | Bronze 要求"密钥不入库"，当前 `ai_providers.api_key`（`db.js:38`）、`settings['gitlab.token']` 仍明文；B4 命令注入未修；seed 硬编码弱口令 `admin123` | F1 + F2 + B4 落地（Phase 3 在做）+ 首次登录强制改密 | backend |
| 无障碍 | 待评 | 未做键盘可达走查 | 核心流键盘可完成 + 对比度 AA（设计 Token 已给出合规对比度，需实测） | designer / frontend |
| 性能 | Bronze | SPEC §10 有性能目标；但架构 §3.4 明确 `execSync`/`readFileSync`/递归 `walk` 阻塞事件循环 | 同步操作异步化 + LLM 超时（Phase 3 在做）+ 分页/索引到位 | backend |
| 可观测 | Bronze | `server/src/logger.js` 已有结构化 key=value 日志（且注释明确不打印凭据）；`ai_tasks` 表在 SPEC §6 已规划 | 关键指标 + SLI/SLO；ai_tasks 落库完成 | backend / devops |
| 发布安全 | **未达 Bronze** | 无 git 仓库、无 tag、无 .gitignore、无备份、无回滚路径 | 见 §3 OPS-B1、§8 回滚、§9 备份 | **devops（我）** |

**总档 = 未达 Bronze**（取最低档）。

三个未达 Bronze 的维度里，**发布安全完全由运维侧负责，我可以在 Phase 4 启动前独立补齐**；安全维度等 Phase 3 的 F1/F2/B4 合入即可跳到 Silver；测试维度依赖 qa 的自动化产出，是通往 Silver 最长的一条腿。

按记分卡 §7 的要求，本评级留痕字段齐全：档位、证据、责任人、目标档（Silver）、期限（Phase 4 上线前）。后续每次关键改动后重算受影响维度。

---

## 3. Phase 4 部署阻断项（P0）

以下五项在部署前必须清零。前三项是运维侧，后两项必须由 backend 处理。

### OPS-B1（devops）无版本控制，回滚不可能

现状：`git status` → `fatal: not a git repository`，向上追溯到 `/Users/admin/workspace/code` 也没有。全项目无 `.gitignore`。

后果：没有任何可回退的版本锚点。部署翻车 = 手工恢复，无 RTO 可言。

处置（Phase 4 开工第一步，需 team-lead 授权后执行）：

1. `git init` + 提交 `.gitignore`（模板见 §3.1）
2. Phase 3 完成后打基线 tag `v1.0.0-rc1`
3. 每次部署前打 tag `deploy-YYYYMMDD-HHMM`，与 releases 目录一一对应

**注意顺序**：必须**先有 `.gitignore` 再 `git init` 后首次 commit**。当前 `server/data/sop.db`（139KB）、`server/data/sop.db-wal`（107KB）、两个 `node_modules` 都在工作区里，一旦裸提交，数据库连同（F1 落地后的）加密密钥、以及 `data/repos/` 下的客户私有代码快照会一起进版本历史 —— 对一个主打"代码不出内网"的产品，这是最讽刺的事故。

### 3.1 .gitignore（交付包必含，Phase 4 提交）

```gitignore
# 依赖
node_modules/

# 环境与密钥
.env
.env.local
*.key
*.pem

# 运行时数据（含加密凭据与客户私有代码快照，严禁入库）
server/data/sop.db
server/data/sop.db-shm
server/data/sop.db-wal
server/data/repos/

# 构建产物
web/dist/
*.log

# IDE 与系统
.idea/
.vscode/
.DS_Store
```

> `web/dist/` 是否忽略取决于交付形态：本方案在**构建机产出 dist、随 release 包一起分发**，源码仓不需要跟踪它，故忽略。若后续改为"目标机自行构建"，此行保留亦无影响。

### OPS-B2（architect 确认 + devops 执行）Node 版本契约与实际不符

| 来源 | 声明 |
|---|---|
| `docs/tech-spec-phase1.md` §0 | Node.js **>= 18** |
| `docs/SPEC-v1.0.md` §4 | 未声明 Node 版本 |
| `better-sqlite3@13.0.2` 实际 `engines` | **>= 22** |
| 本机实测 | v22.22.2 |

`npm ci` 遇到 engines 不满足时默认只打 EBADGINE 警告不中断（除非 `engine-strict=true`），所以这个问题会**溜过安装阶段，在运行时才炸**。

处置：
- 请 architect 修订 tech-spec §0 为 `Node.js >= 22`（SPEC §4 同步补上版本行）
- 交付包根目录加 `.nvmrc`（内容 `22`）
- `server/package.json` 加 `"engines": { "node": ">=22" }`
- 部署脚本首步硬校验，不满足直接退出（见 §6 预检脚本）

### OPS-B3（backend）健康检查端点缺失，且当前存在"假绿"陷阱

现状：`grep -rni "health" server/src` 无任何命中，没有健康检查端点。

**陷阱**：`server/src/index.js:16` 是 `app.get(/^(?!\/api).*/, (req,res) => res.sendFile(dist/index.html))`。负向前瞻只排除 `/api` 前缀，因此：

- 探测 `/health` → 命中 catch-all → **返回 200 + HTML**。监控看到 200 判定健康，实际数据库可能已经挂了。**这是比没有健康检查更危险的状态。**
- 探测 `/api/health` → router 无此路由 → 落到 Express 默认 404。

因此健康检查端点**必须挂在 `/api` 前缀下**。给 backend 的实现契约：

```
GET /api/health          无需认证（监控要能匿名探测）
200 { status: "ok",       checks: { db: "ok", dist: "ok", master_key: "ok" }, uptime, version }
503 { status: "degraded", checks: { db: "fail", ... }, uptime, version }
```

三项探测的具体要求：

- `db`：执行一次真实查询（如 `db.prepare('SELECT 1').get()`），不能只判断对象存在
- `dist`：`fs.existsSync(path.join(dist,'index.html'))` —— dist 缺失时所有非 API 路由都会 `sendFile` ENOENT 报 500，这个必须能被探测到
- `master_key`：只回 `ok`/`fail` 布尔语义，**绝不回显密钥值或长度**

补充一条 F1 相关的强诉求：架构 R4 规定"解密失败按未配置处理并提示重填，不崩溃"。运维视角这会造成 **"没配 key" 和 "key 配错了" 表现一致**（这正是 BLOCKER-2 已经踩过一次的坑，别在密钥上再踩一次）。建议启动自检：若库中存在 `v1:` 前缀密文，则试解一条，失败时打 `level=error event=master_key_mismatch` 明确日志，并让 `/api/health` 的 `master_key` 转为 `fail`。

### OPS-B4（backend，部署即挂级别）seed.js 与 F1 冲突：全新环境将无法登录

`server/src/seed.js:7-12` 以**明文**写入种子用户：

```js
ins.run('admin', 'admin123', '系统管理员', 'ADMIN');
```

F1 要求把登录改为「先按 username 查行，再 `bcrypt.compare(input, row.password)`」（tech-spec §5.3 补充条款）。若 `seed.js` 不同步改成写入 bcrypt 哈希，则：

**全新部署的实例，数据库为空 → seed 写入明文 → 登录走 bcrypt.compare(明文, 明文) → 恒 false → 所有账号无法登录，包括 admin。系统开局即锁死。**

现有开发库因为已有用户、`hasUser` 为真而不会触发，所以**这个问题在本地开发环境永远复现不出来，只会在客户首次部署时爆炸**。必须在 Phase 4 前修掉，并在验证清单里用"删库重启"的方式实测（见 §7 V-05）。

### OPS-B5（backend）seed.js 无条件覆盖主题设置，重启即重置用户配置

`server/src/seed.js:53-54`：

```js
setSetting('theme.primary', '#4f7cff');
setSetting('theme.mode', 'light');
```

这两行在 `seed()` 里**没有任何存在性判断**，而 `seed()` 在 `index.js:19` 每次启动都执行。结果：管理员在后台改的主题色，**每次重启服务都会被打回 `#4f7cff`**。

顺带一提，`#4f7cff` 也已经不是 SPEC §8 锁定的主色（accent 应为 Cyanotype Blue `#0E62A8`）。请 backend 一并处理：改为"仅当 key 不存在时写入默认值"，并同步 SPEC §8 的锁定值。

---

## 4. SOP_MASTER_KEY 注入方案

`grep -rn "SOP_MASTER_KEY" server/src web/src` 当前无命中 —— F1 尚未落地，以下为 Phase 4 的注入契约。

### 4.1 生成

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

与 SPEC §12、tech-spec §9 的准备步骤一致（32 字节，base64）。

### 4.2 注入方式：EnvironmentFile，不用 export

SPEC §12 的 `export SOP_MASTER_KEY=...` 适合**手工验证**，不适合生产。原因：`npm run dev` 是 `node --watch src/index.js`，环境变量必须存在于同一个 shell；一旦用 systemd 托管、或换个终端重启，key 就丢了 —— 而 F1 是 fail-fast，服务会直接起不来。更糟的情况是 key 只存在于某个人的 shell history 里。

生产注入：

```ini
# /etc/sop-system/sop-system.env   权限 0600，属主 root:sop
SOP_MASTER_KEY=<base64-32bytes>
PORT=4000
LOG_LEVEL=info
```

```ini
# /etc/systemd/system/sop-system.service
[Unit]
Description=SOP System
After=network.target

[Service]
Type=simple
User=sop
WorkingDirectory=/opt/sop-system/current/server
EnvironmentFile=/etc/sop-system/sop-system.env
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=10
StartLimitBurst=3
StartLimitIntervalSec=300

[Install]
WantedBy=multi-user.target
```

`StartLimitBurst=3` / `StartLimitIntervalSec=300` 是刻意加的：F1 的 fail-fast 语义下，如果 key 配错，服务会启动即退出。没有重启限制的话 systemd 会无限重启刷爆 journal，把真正的错误日志淹掉。限制成 5 分钟内最多 3 次，失败后进 failed 状态，日志留得下来。

### 4.3 密钥的备份，是这套方案里最容易被忽略的单点

架构 R4 已登记「`SOP_MASTER_KEY` 丢失导致存量密钥不可解」。运维侧必须落实：

- **key 与数据库备份分离存放**（安全要求：拿到 db 备份的人不应同时拿到 key）
- **但两者必须同时存在**（可恢复要求：只有 db 没有 key，备份就是一堆废密文）
- 交付时 key 需离线移交给客户管理员（纸质/密码管理器），并明确书面告知：**此密钥丢失后，已存储的 Provider api_key 与 GitLab token 不可恢复，只能全部重新录入**
- 恢复演练必须验证 "db 备份 + key" 的**组合**可用，只验证 db 能打开不算数（见 §9.3）

### 4.4 交付包中的 .env.example

```bash
# SOP System 环境变量模板 —— 复制为 .env 并填入实际值，.env 不得提交
# 主密钥：32 字节 base64。生成命令见 DEPLOY.md
# 警告：此密钥丢失将导致已存储的 API Key 与 GitLab Token 全部不可解密
SOP_MASTER_KEY=

# 服务端口，默认 4000
PORT=4000

# 日志级别 debug|info|warn|error，默认 info
LOG_LEVEL=info
```

---

## 5. 健康检查与探针参数（关键：不能配太激进）

架构 §3.4 明确：`execSync` 解压、`fs.readFileSync`、递归 `walk` 全是同步调用，大仓同步期间**整个服务无法响应任何请求，包括健康检查和前端静态资源**。

这直接决定探针参数不能按常规配。典型事故链是这样的：

> 管理员触发一个大仓同步 → 事件循环阻塞 40 秒 → 健康检查连续超时 → systemd/监控判定进程死亡 → 重启 → 同步中断且未完成 → 管理员再次触发 → 再次阻塞 → 再次被杀 …… 形成重启风暴，同步永远完不成，且现场看起来像"服务不稳定"，排障方向会被完全带偏。

因此 Phase 4 的探针参数：

| 参数 | 值 | 理由 |
|---|---|---|
| 探测端点 | `GET /api/health` | 必须带 `/api` 前缀，规避 §3 OPS-B3 的假绿 |
| 超时 | 30s | 覆盖同步阻塞窗口 |
| 间隔 | 30s | — |
| 连续失败阈值 | 3 次 | 累计 90s 无响应才判定异常 |
| 自动重启 | systemd `Restart=on-failure` + `StartLimitBurst=3` | 防重启风暴 |

**收紧条件**：待 backend 按架构 §3.4 把同步改为 `spawn` 异步 + 单并发队列后，超时可收紧到 5s、阈值降到 2 次。在那之前保持宽松，宁可晚发现，不可误杀。

---

## 6. 构建校验流程（部署前，构建机执行）

顺序不可颠倒：**前端构建 → 校验 dist → 后端装依赖 → 预检 → 启动**。因为 `index.js:14-16` 把 `web/dist` 作为后端静态托管的硬依赖，dist 不存在则所有非 API 路由 500。

当前 `web/dist` 是 `Jul 31 17:49` 的旧产物，而 `web/src` 已更新至 `Aug 4 21:25` —— **部署必须重建，不能复用现有 dist**。

```bash
#!/usr/bin/env bash
# preflight.sh —— Phase 4 部署预检，任一步失败即中止
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

# 0) Node 版本硬校验（OPS-B2）
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 22 ] || { echo "FAIL: 需要 Node >= 22，当前 $(node -v)"; exit 1; }

# 1) 前端构建
cd "$ROOT/web" && npm ci && npm run build

# 2) 校验 dist 产物真实存在（不只看目录）
[ -f "$ROOT/web/dist/index.html" ] || { echo "FAIL: web/dist/index.html 缺失"; exit 1; }
[ -d "$ROOT/web/dist/assets" ]     || { echo "FAIL: web/dist/assets 缺失"; exit 1; }

# 3) 后端依赖
cd "$ROOT/server" && npm ci

# 4) 主密钥存在性（F1 fail-fast 前置拦截，早失败早止损）
[ -n "${SOP_MASTER_KEY:-}" ] || { echo "FAIL: SOP_MASTER_KEY 未设置"; exit 1; }

# 5) P0 合规门禁（SPEC §12）
cd "$ROOT"
EMOJI=$(rg -c '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{FE0F}]' web/src server/src 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
[ "$EMOJI" = "0" ] || { echo "FAIL: 检出 $EMOJI 处 emoji"; exit 1; }

OVER=$(find server/src web/src \( -name '*.js' -o -name '*.tsx' -o -name '*.ts' \) | xargs wc -l | awk '$2!="total" && $1>300 {print $2"("$1")"}')
[ -z "$OVER" ] || { echo "FAIL: 单文件超 300 行: $OVER"; exit 1; }

echo "PASS: 预检通过"
```

依赖工具已在本机核实可用：`sqlite3 3.43.2`（`/usr/bin/sqlite3`）、`rg`（`/opt/homebrew/bin/rg`）。**目标机需确认 `sqlite3` CLI 存在**，否则 §7 的 V-02 无法执行（可用 `node -e` 走 better-sqlite3 替代，作为 fallback）。

### 6.1 关于 node_modules：绝不跨平台拷贝

已核实 `web/node_modules/@rollup` 下**只有** `rollup-darwin-arm64`，`@esbuild` 下只有 `darwin-arm64`。Vite 5 / Rollup 4 用平台专属可选依赖，把本机 `node_modules` 打包带到 Linux 服务器，构建会直接报 `Cannot find module @rollup/rollup-linux-x64-gnu`。

规则：
- 交付包**不含** `node_modules`，目标机 `npm ci`
- 内网离线场景：预置 npm 私服或离线 cache，`npm ci --offline`
- `better-sqlite3` 不受此限（N-API 预编译，`prebuilds/` 含全平台产物，无需编译链），但仍按统一规则走 `npm ci`
- 目标机若为 Alpine，走 `linuxmusl-*` 预编译，同样无需编译链

---

## 7. 部署后验证清单

对齐 SPEC §12 与 tech-spec §9。QA 的功能验收另算，这里只列**运维必须亲自过的项**。

| 编号 | 验证项 | 命令 / 操作 | 通过标准 |
|---|---|---|---|
| V-01 | 健康检查真实有效 | `curl -s -o /dev/null -w '%{http_code}' localhost:4000/api/health` | 200；且 `curl localhost:4000/health` 返回的是 HTML（确认已知陷阱，不作为监控端点） |
| V-02 | 密钥密文落库 | `sqlite3 server/data/sop.db "SELECT api_key_enc, api_key FROM ai_providers LIMIT 1"` | `api_key_enc` 以 `v1:` 开头，`api_key` 为空 |
| V-03 | 缺 key 时 fail-fast | 清空 `SOP_MASTER_KEY` 启动 | 进程退出且日志有明确指引，**不得**静默降级明文 |
| V-04 | key 错配可识别 | 换一个随机 key 启动（已有密文） | 日志明确报 key 不匹配，`/api/health` 的 `master_key` 为 fail，而非静音 |
| V-05 | **全新环境可登录** | 备份后清空 data 目录 → 启动 → 用 admin 登录 | 登录成功（专门验 OPS-B4，本地老库复现不出） |
| V-06 | 重启不重置配置 | 后台改主题色 → 重启 → 复查 | 主题色保持（专门验 OPS-B5） |
| V-07 | dist 缺失可感知 | 临时改名 dist → 探测 | `/api/health` 的 `dist` 转 fail 并回 503 |
| V-08 | 核心流程不卡死 | 提单 → 评估 → PRD → 研发 → 测试 → 上线 全流程走一遍 | 每步 HTTP 有响应；AI 节点降级也必须返回结构化产物（SPEC AC-07） |
| V-09 | 阻塞期服务可用性基线 | 触发一次模块同步，期间持续探测 `/api/health` | 记录最长无响应时长，写入运维基线；若 > 30s 需上调探针超时或推动 §3.4 异步化 |
| V-10 | 命令注入已拦截 | 创建 `module_key = 'a"; touch /tmp/pwned; #'` | API 返回 400，`/tmp/pwned` 不存在 |
| V-11 | 备份可恢复 | 按 §9 生成备份 → 恢复到临时目录 → 用同一 key 启动 → 读 Provider | 能正常解密调用，不是废密文 |
| V-12 | 回滚可执行 | 按 §8 切换软链回上一版本 | 60 秒内完成且服务恢复 200 |

V-05、V-06、V-09、V-11、V-12 是常规清单里没有、但本项目**必须**做的五项，理由分别见 OPS-B4、OPS-B5、§5、§4.3、§8。

---

## 8. 回滚策略

### 8.1 目录布局

```
/opt/sop-system/
├── releases/
│   ├── deploy-20260805-1030/     # 每次部署一个完整目录（含 server/ 与 web/dist/）
│   └── deploy-20260806-1415/
├── current -> releases/deploy-20260806-1415    # 软链
└── data/                         # 数据库与仓库快照，独立于 releases，不随回滚变动
```

`server/data` 通过软链指向 `/opt/sop-system/data`，保证**代码回滚不动数据**。

### 8.2 回滚动作（目标 RTO < 60 秒）

```bash
ln -sfn /opt/sop-system/releases/<上一个 tag> /opt/sop-system/current
systemctl restart sop-system
curl -f localhost:4000/api/health
```

保留最近 3 个 release 目录。

### 8.3 数据库为什么不需要跟着回滚（重要判断）

核查了迁移风格：`db.js` 用 `CREATE TABLE IF NOT EXISTS`，SPEC §6 的增量列全部是 `ALTER TABLE ... ADD COLUMN`，**没有任何 DROP / RENAME / 类型变更**。这意味着 schema 变更是纯 additive 的，旧版本代码运行在新 schema 上会直接忽略多出来的列，不会报错。

**结论：代码回滚不需要数据库回滚。** 这让回滚变成一个秒级、低风险的动作。

### 8.4 唯一的单向门：F1 的密码哈希迁移

必须把这条单独拎出来讲清楚。

F1 会把 `users.password` 从明文一次性迁移为 bcrypt 哈希（tech-spec §5.3 补充条款）。**这个迁移不可逆** —— 哈希算不回明文。一旦执行，如果回滚到 F1 之前的代码版本，旧登录逻辑是 `WHERE username=? AND password=?` 明文比对，拿明文去比哈希，**全员登录失败**。

所以：

- **F1 上线即关闭"纯代码回滚"窗口。** 跨 F1 的回滚必须**同时恢复数据库备份**，两者必须成对操作。
- 部署 F1 版本**前**必须做一次完整备份（§9），并在 release 记录里标注 `crosses-F1-migration: true`。
- 部署脚本在检测到本次是跨 F1 迁移时，应打印显式确认提示，不允许无人值守静默执行。

这条不写清楚，就是给未来某个凌晨埋一颗雷。

---

## 9. 备份策略

### 9.1 先说清楚一个会直接丢数据的坑：不能 `cp sop.db`

`db.js:9` 开了 `journal_mode = WAL`。当前实测：

```
sop.db      139264 bytes
sop.db-wal  107152 bytes
```

WAL 里有 107KB **尚未 checkpoint 回主库**的数据，占总数据量约 43%。此刻直接 `cp sop.db backup.db`，拿到的是一个**丢失近一半近期写入**的库 —— 而且它能正常打开、能查询，不会报任何错，只是数据旧。这种"备份看起来成功了，恢复时才发现少数据"的故障，是最难在事后追责和补救的。

### 9.2 正确做法

```bash
#!/usr/bin/env bash
# backup-db.sh —— 每日 03:00 执行（crontab: 0 3 * * * /opt/sop-system/backup-db.sh）
set -euo pipefail
DB=/opt/sop-system/data/sop.db
DIR=/opt/sop-system/backups
TS=$(date +%Y%m%d_%H%M%S)
KEEP_DAYS=7
mkdir -p "$DIR"

# 用 SQLite 官方在线备份 API，自动整合 WAL，无需停服，不阻塞写入
sqlite3 "$DB" ".backup '$DIR/sop_$TS.db'"
gzip "$DIR/sop_$TS.db"

# 完整性校验：备份完立刻验，不留到恢复时才发现坏了
gunzip -c "$DIR/sop_$TS.db.gz" > /tmp/verify_$TS.db
sqlite3 /tmp/verify_$TS.db "PRAGMA integrity_check;" | grep -q '^ok$' \
  || { echo "FAIL: 备份完整性校验未通过 $TS"; exit 1; }
rm -f /tmp/verify_$TS.db

find "$DIR" -name 'sop_*.db.gz' -mtime +$KEEP_DAYS -delete
echo "OK: backup $TS"
```

要点：
- 用 `.backup` 而非 `cp`：SQLite 在线备份 API 会正确整合 WAL，且不阻塞写入
- 若坚持文件级拷贝，必须先 `PRAGMA wal_checkpoint(TRUNCATE)`，并且 `sop.db` / `-wal` / `-shm` **三件套一起拷**。不推荐，容易漏
- 备份**当场**做 `integrity_check`，别把校验推迟到恢复现场
- `data/repos/` 下是从客户 GitLab 拉的代码快照，**不备份**（可从 GitLab 重新同步，且体积大、含客户源码，备份反而扩大泄露面）

### 9.3 备份频率与恢复演练

| 项 | 策略 |
|---|---|
| 每日 | 03:00 自动备份，保留 7 天 |
| 每次部署前 | 强制一次，命名 `pre-deploy-<tag>`，跨 F1 迁移时必须保留至确认稳定 |
| 每月 | 恢复演练一次 |

**恢复演练必须验证 "db + key" 组合**，只验证库能打开是不够的：

```bash
# 1) 恢复到临时目录
# 2) 用生产的 SOP_MASTER_KEY 启动临时实例
# 3) 在后台执行一次 Provider 连通性测试
# 通过标准：能成功解密并发起真实调用。只要这步过了，才证明这份备份真的可用。
```

演练结果留痕（日期、备份文件、结论、执行人），作为记分卡「发布安全」维度的证据。

---

## 10. 交付包结构（Phase 4 产出）

```
delivery/
├── README.md              # 项目说明 + 一键启动
├── DEPLOY.md              # 部署步骤 + 回滚方案 + 密钥管理
├── USER_GUIDE.md          # 基本操作
├── TEST_REPORT.md         # QA 质量报告（qa 提供）
├── .env.example           # 见 §4.4
├── .gitignore             # 见 §3.1
├── .nvmrc                 # 22
├── preflight.sh           # 见 §6
├── backup-db.sh           # 见 §9.2
├── sop-system.service     # systemd 单元模板
├── server/                # 不含 node_modules、不含 data
└── web/                   # 含 dist，不含 node_modules
```

用户拿到后三步：填 `.env` 里的 `SOP_MASTER_KEY` → 跑 `preflight.sh` → `systemctl start sop-system`。

DEPLOY.md 必须显著位置写明两条**不可逆风险**：`SOP_MASTER_KEY` 丢失不可恢复（§4.3）、F1 密码迁移关闭纯代码回滚窗口（§8.4）。

---

## 11. 待办与责任分工

| 项 | 责任人 | 阻断 Phase 4 | 说明 |
|---|---|---|---|
| OPS-B1 git 仓库 + .gitignore | devops | 是 | 待 team-lead 授权即可执行，不依赖 Phase 3 |
| OPS-B2 Node 版本契约修订 | architect | 是 | 文档 >=18 与实际 >=22 冲突 |
| OPS-B3 `/api/health` 端点 | backend | 是 | 含 db/dist/master_key 三项探测 + key 错配可识别 |
| OPS-B4 seed.js bcrypt 同步 | backend | 是 | 不修则全新环境登录锁死 |
| OPS-B5 seed.js 主题覆盖 | backend | 否 | 顺带把默认色对齐 SPEC §8 的 `#0E62A8` |
| 同步操作异步化（§3.4） | backend | 否 | 未做则探针参数保持宽松（§5） |
| 自动化测试 + CI 门禁 | qa / backend | 否 | 记分卡「测试+回归」升 Silver 的必要条件 |
| 无障碍键盘走查 | designer / frontend | 否 | 记分卡「无障碍」当前待评 |

**运维侧当前状态：待命。** 上述 OPS-B1 一经授权即可动手，其余等 team-lead 通知进入 Phase 4。

---

## 12. 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-08-04 | v1.0 初稿 | Phase 4 部署准备，基于 SPEC v1.0 + tech-spec v1.0 + 代码实测 |
