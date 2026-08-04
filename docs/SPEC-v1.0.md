# Spec - 企业级需求 SOP 落地系统 v1.0（一期收尾）

> 生成日期：2026-08-04
> 基于：PRD v0.5.3 + 架构文档 v1.0 + UIUX 方向书 + B1 实现 Spec
> 状态：已确认（用户 20:28 拍定 ①北星指标 ③定位，文档与决策全部通过）
> 性质：团队内部契约 —— 锁定范围 / 功能 / API / 页面 / 设计 Token。后续开发以本 Spec 为唯一依据。

---

## 1. 产品定义

- **一句话描述**：把「CSM 提需求 → 产品评需求 → 研发做需求 → 测试测需求 → 需求上线」固化成可配置 SOP，并在每个交接口嵌入**读得到私有 GitLab 真实代码**的 AI 节点，用于降低需求返工与评估口径分歧。
- **目标用户**：CSM / 产品经理 / 研发 / 测试 / 管理员（企业内部交付链路角色）。
- **核心问题**：现有 AI 节点输出通用套话且不可验证，产品与研发不采纳，SOP 退化成走过场审批流。成功标准是 **AI 产物被下游角色采纳的比例**，而非"接通了 LLM"。
- **北星指标（已确认）**：AI 评估采纳率 = 产品在评审时未推翻 AI 给出的改动等级(L1-L4)与影响模块的比例，目标 **≥ 60%**。
- **定位（已确认）**：唯一一个同时做到「AI 当作 SOP 流程节点」×「AI 读得到私有 GitLab 真实代码」×「全私有化部署（代码不出内网）」的需求交付系统。

---

## 2. MVP 范围（锁定 —— 不在此列表的功能一律不做）

实施顺序：**F1 ∥ F2 → F3 → F5 → F4 → F6 → F7 → F8**（共 8 项）

| 优先级 | 功能 | 依赖 | 验收标准摘要 | 对应 BLOCKER |
|--------|------|------|-------------|--------------|
| P0 | **F1 凭证加密存储** | — | api_key/token 用 AES-256-GCM 可逆加密；users.password 用 bcrypt(cost=10) 哈希；接口不回明文；SOP_MASTER_KEY 缺失 fail-fast | B5 |
| P0 | **F2 代码快照敏感文件过滤** | — | 同步与上下文提取阶段剔除 .env/*.properties/*secret* 等；防密钥随 Prompt 外发 | B6 |
| P0 | **F3 真实 LLM 网关** | F1+F2 | Claude/OpenAI 兼容双协议 + 超时 + 重试 + 降级 Mock + 调用留痕 | — |
| P0 | **B4 命令注入修复** | — | module_key 白名单 + execFileSync 数组参数 + 路径前缀校验 | B4 |
| P0 | **B1 AI 节点契约统一** | — | runAI 恒返回 Zod 校验对象，下游零改，根治静默断裂 | B1 |
| P1 | **F5 AI 输出 Schema 校验** | F3 | LLM 返回按 JSON Schema 校验，不合规重试一次再降级 | B1 延伸 |
| P1 | **F4 AI 产物可信度展示** | F3 | 模型来源 / 代码依据 / 置信度三件套 | B2 |
| P1 | **B2 AI 调用可观测** | F3 | ai_tasks 表落库：模型/耗时/成败/降级原因 | B2 |
| P1 | **F6 GitLab 快照 + 模块映射 + 上下文注入** | F2,F4 | 闭环打通；impact_scope.files 为真实路径 | B3(超时) |
| P1 | **F7 需求-平台模块关联 UI** | — | CSM 提单多选平台模块（前端入口补齐） | — |
| P2 | **F8 闭环流程可视化** | — | 需求详情 SOP 节点进度条 + 当前节点 + 已走路径 | — |

> B3（LLM 无超时）已并入 B1 的 callLLM 改造（AbortController 15s）。

---

## 3. 明确不做（Out-of-Scope —— 锁定）

| 不做的功能 | 原因 | 何时考虑 |
|------------|------|----------|
| F9 打回目标可选（退到任一上游） | 2.25 人日 > 2 阈值，降二期；一期保持"退一格" | 二期 |
| F10 Prompt 按节点可配置 | 非闭环必需 | 二期 |
| F11 IM 通知（企微/飞书） | 系统内通知已可用 | 二期 |
| F12 AI 调用看板 | 有 ai_tasks 表，UI 看板二期 | 二期 |
| F13 评估偏差回灌 | 需先验证采纳率前提 | 三期 |
| F14 代码 RAG 向量检索 | SQLite 无原生向量；启发式够用 | 三期 |
| F15 多团队数据隔离 | 单团队先跑通 | 三期 |
| 甘特图/工时结算/AI 写代码/自动提 MR/移动端/对接 Jira | 见 PRD §10 | 不做 |
| 定时全量刷新所有模块 | GitLab 限流 5 次/分/用户，不可配 | 不做（ADR-005） |

---

## 4. 技术架构（锁定 — 含版本锚定）

| 层 | 技术 | 实际版本 | 锁定原因 |
|----|------|----------|----------|
| 后端框架 | Express | ^4.21.2 | 现有依赖，CJS 规范 |
| 数据库 | better-sqlite3（WAL，同步 API） | ^13.0.2 | 现有依赖，零额外服务 |
| 前端框架 | React + TypeScript + Vite | ^18.3.1 / ^5.6.3 / ^5.4.11 | 现有依赖，ESM 规范 |
| 后端新增 | **zod**（结构化输出校验） | ^3.23.8 | B1 根治契约断裂，零 ESM 冲突 |
| 前端新增 | **lucide-react**（SVG 图标库，锁定一套） | ^0.454.0 | P0-1 强制，替换全部 emoji |
| LLM 抽象 | 自研轻量 Adapter（server/src/llm/） | — | CJS 直接改，不引入 AI SDK（ESM-only 冲突） |
| 加密 | node:crypto AES-256-GCM（可逆）+ bcrypt（不可逆口令） | 内置 + bcrypt | 凭据分流原则（ADR-003） |
| 部署 | 单进程 Node（server）+ 静态前端（web/dist） | — | 零外部服务，私有化 |
| 认证 | JWT（登录校验改 bcrypt.compare） | — | 现有会话机制改造 |

**模块规范**：server = CommonJS，web = ESM。新增代码不得改变模块规范。

**代码组织（强制，§8 约束）**：
```
server/src/
├── llm/                  # index.js / capabilities.js / providers/* / structured.js
├── repo/                 # gitlab-api.js / archive.js / sync-queue.js / code-context.js
├── crypto/secret.js      # AES-256-GCM 加解密 + 存量迁移
├── llm-schema.js         # Zod schema（B1）
└── llm-call.js           # 三级降级调用（B1）
web/src/
├── components/Icon.tsx    # 图标收口（lucide-react）
└── pages/admin/          # Admin.tsx 按 Tab 拆分
```
单文件 ≤ 300 行。超限文件（Admin.tsx 646 / ReqDetail.tsx 367 / ai.js 241 / gitlab.js 202）必须拆包，新增代码不得堆入。

---

## 5. API 端点清单（锁定 —— 开发时以此为唯一依据）

**版本化**：`app.use('/api/v1', router); app.use('/api', router);` 双挂载。新端点文档以 `/api/v1` 为准，新前端代码用 `/api/v1`，存量调用保持可用。新端点统一响应包络 `{ code, data, message }`，老端点不动。

| Method | Path | 功能 | 认证 | 请求体 | 响应体 |
|--------|------|------|------|--------|--------|
| GET | `/api/v1/admin/ai-providers` | AI Provider 列表（密钥掩码） | admin | — | `{code,data:[{id,type,model,capability,masked}]}` |
| POST | `/api/v1/admin/ai-providers` | 新增 Provider（密钥加密入库） | admin | `{type,model,api_key,base_url}` | `{code,data:{id}}` |
| PUT | `/api/v1/admin/ai-providers/{id}` | 更新（•••••••• 表示不改密钥） | admin | `{model?,api_key?,base_url?}` | `{code,data:{id}}` |
| DELETE | `/api/v1/admin/ai-providers/{id}` | 删除 | admin | — | `{code,data:{id}}` |
| POST | `/api/v1/admin/ai-providers/{id}/test` | 连通性测试（返回延迟/模型/能力） | admin | — | `{code,data:{ok,latency_ms,capability}}` |
| GET | `/api/v1/admin/ai-tasks` | AI 调用记录（含降级原因，分页） | admin | `?page&status` | `{code,data:[ai_tasks 行]}` |
| POST | `/api/v1/admin/modules/{id}/sync` | 触发同步（入队语义，返回 task_id） | admin | — | `{code,data:{task_id}}` |
| GET | `/api/v1/admin/sync-tasks/{id}` | 同步任务状态轮询 | admin | — | `{code,data:{status,attempt,error_msg}}` |
| GET | `/api/v1/requirements/{id}/code-context` | 回显本次 AI 实际读取的文件清单 | 角色 | — | `{code,data:{files:[...]}}` |

> 现有端点（auth/users/requirements/clarifies/artifacts/timeline/notifications/settings）保持 `/api` 与 `/api/v1` 双挂载，逻辑不变。

---

## 6. 数据库表清单（锁定）

**新增表**：
```sql
CREATE TABLE IF NOT EXISTS ai_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE CASCADE,
  node_id INTEGER REFERENCES sop_nodes(id),
  action TEXT NOT NULL,
  provider_id INTEGER REFERENCES ai_providers(id),
  provider_type TEXT, model TEXT,
  status TEXT NOT NULL,                     -- OK / DEGRADED / FAILED
  degraded_reason TEXT,
  structured_level TEXT,                    -- L1/L2/L3/mock
  latency_ms INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER,
  code_files_used TEXT,                     -- JSON 数组：注入文件路径
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ai_task_req ON ai_tasks(requirement_id, created_at);

CREATE TABLE IF NOT EXISTS sync_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES code_modules(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'QUEUED',    -- QUEUED/RUNNING/OK/FAILED
  attempt INTEGER DEFAULT 0, error_msg TEXT,
  started_at TEXT, finished_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sync_task_status ON sync_tasks(status, created_at);
```

**ALTER 列（幂等，复用 db.js 现有 try/catch 迁移风格）**：
```sql
ALTER TABLE ai_providers ADD COLUMN api_key_enc TEXT;       -- v1:iv:tag:cipher
ALTER TABLE ai_providers ADD COLUMN timeout_ms INTEGER DEFAULT 60000;
ALTER TABLE ai_providers ADD COLUMN max_tokens INTEGER DEFAULT 4096;
ALTER TABLE ai_providers ADD COLUMN capability TEXT;        -- json_schema/json_object/prompt_only
ALTER TABLE ai_providers ADD COLUMN priority INTEGER DEFAULT 0;
ALTER TABLE ai_providers ADD COLUMN last_tested_at TEXT;
ALTER TABLE ai_providers ADD COLUMN last_test_result TEXT;
ALTER TABLE code_modules ADD COLUMN max_archive_mb INTEGER DEFAULT 200;
ALTER TABLE code_modules ADD COLUMN last_sync_task_id INTEGER;
-- users.password：bcrypt 哈希迁移（存量明文一次性哈希化）
```

> 不新建 `repo_config`/`platform_module` 表 —— 现有 `code_modules` + `module_mappings` + `settings['gitlab.*']` 已覆盖。

---

## 7. 页面清单（锁定）

| 页面 | 路由 | 核心组件 | 对应 API | 设计 Token 主题 |
|------|------|----------|----------|-----------------|
| 看板/列表 | `/` (Board) | 需求流转条、密度切换、汇总卡 | GET /requirements | Blueprint Calm |
| 需求列表 | `/list` (ReqList) | 表格 + divide-y + 行内流转 | GET /requirements | Blueprint Calm |
| 需求详情 | `/req/:id` (ReqDetail) | 三栏 + AI 产物卡（虚/实线材质） | GET /requirements/:id + artifacts | AI 材质语言 |
| 提单弹窗 | CreateModal | 模块多选 + 空状态引导 | POST /requirements | — |
| 管理后台 | `/admin` (Admin) | 按 Tab 拆分：用户/模板/AI/模块/映射 | /api/v1/admin/* | — |
| AI 模型配置（Admin 子页） | — | Provider CRUD + 连通性测试 + ai_tasks 记录 | /api/v1/admin/ai-providers* | — |
| 同步队列状态（Admin 子页） | — | sync_tasks 轮询 | /api/v1/admin/sync-tasks/:id | — |

---

## 8. 设计 Token（锁定）

> 设计师确认后产出 `design-system/design-tokens.json` + `design-tokens.css`，前端通过 import 引用。下方为锁定值。

- **主色（accent）**：Cyanotype Blue `#0E62A8`（浅色态文字/按钮对比度 6.30:1，AA ✓）；深色态 `#4FA6EE`（7.23:1，AAA）
- **品牌藏青（brand）**：`#1E3A5F`（登录 Hero / 侧栏 logo 底）
- **语义色**：success `#12805C` / warn `#B45309`（文字）· `#f59e0b`（仅背景）/ danger `#B3261E`（全部 WCAG ≥4.9:1）
- **中性灰**：`--bg #F5F7FA` · `--surface #FFFFFF` · `--fg #101724` · `--muted #5D6B7E` · `--border #E2E7EE`（浅色主题）
- **AI 材质语言**：`--ai-surface #F7F9FB` · `--ai-dash #C3CCD8`；待确认 = 1px dashed 边框 + 冷灰底；已确认 = 1px solid 边框 + 白底。AI 图标用 `Cpu`（非 Sparkles），上线用 `CircleCheckBig`（非 Rocket）
- **字体**：Display = Geist Sans；Body = Inter（cv01/ss03/tnum）；中文 = Noto Sans SC；Mono = JetBrains Mono。替换 Plus Jakarta Sans
- **图标库**：Lucide 锁定，16/20/24px，strokeWidth 1.75，继承 currentColor。全项目只用这一套，禁止 emoji 作功能图标
- **圆角**：仅 6 / 12 / 16 / pill 四档
- **间距**：4px 网格（4 8 12 16 20 24 32 40 48 64）
- **动效**：instant 0ms / fast 120ms / base 180ms / slow 240ms，ease `cubic-bezier(0.2,0,0,1)`；禁止弹跳缓动
- **对标**：Linear（主）+ Vercel Geist（副）+ 飞书项目（中文密度）+ GitLab/TAPD（代码感知）
- **设计语言**：Blueprint Calm 蓝图冷静（线条即结构 / 颜色即信息 / 数字用等宽 / AI 用材质不用颜色）

---

## 9. 验收标准（锁定 —— QA 测试时以此为唯一依据）

采用 EARS 格式。以下为关键项（完整 Given/When/Then 见 PRD v0.5.3 §8）：

| 编号 | 功能 | EARS 格式验收标准 | 优先级 |
|------|------|-------------------|--------|
| AC-01 | F1 | While 管理员保存 GitLab Token，系统**必须**加密存储且 GET 接口响应体不含明文 | P0 |
| AC-02 | F1 | If `SOP_MASTER_KEY` 未设置，When 服务启动，系统**必须** fail-fast 退出并打印指引 | P0 |
| AC-03 | F1 | While 用户登录，系统**必须**先查行再 `bcrypt.compare`，不再明文比对 | P0 |
| AC-04 | F2 | If 仓库存在 `application.properties`，When 构建代码上下文，系统**必须**剔除该文件不注入 prompt | P0 |
| AC-05 | F3 | If LLM 返回 429，When AI 节点执行，系统**必须**重试 1 次后仍失败则降级 Mock 并记录 | P0 |
| AC-06 | F3 | If LLM 响应超 60s，When 等待超时，系统**必须**中断并走降级，不无限挂起 | P0 |
| AC-07 | B1 | When 真实 LLM 返回裸 string，系统**必须**经 Zod 兜底为合法对象，下游 EvaluationView 整块渲染 | P0 |
| AC-08 | B4 | If `module_key` 含 shell 元字符，When 创建模块，系统**必须**返回 400 拒绝 | P0 |
| AC-09 | F4 | While 产品打开真实模型生成的评估报告，系统**必须**展示模型名 + 代码依据（模块@分支 + commit + 文件数）+ 置信度 | P1 |
| AC-10 | F4 | If 产物由 Mock 生成，When 查看，系统**必须**显示琥珀警示条"演示数据，不可作为排期依据" | P1 |
| AC-11 | F5 | If LLM 返回 JSON 缺 `level`，When 校验，系统**必须**重试一次；二次失败降级 Mock 并记录原始响应 | P1 |
| AC-12 | F6 | While 需求关联 2 模块，When AI 评估执行，系统**必须**在 prompt 含目录树且 `impact_scope.files` 为真实路径（非占位串） | P1 |
| AC-13 | F7 | While CSM 创建需求，When 打开提单弹窗，系统**必须**支持搜索多选平台模块 | P1 |
| AC-14 | F8 | While 需求处于研发节点，When 打开详情，系统**必须**展示 SOP 节点链（完成/当前/未到达/曾被打回四态可辨，AI 与人工视觉可区分） | P2 |
| AC-15 | P0合规 | When 扫描全项目，系统**必须**零 emoji 功能图标、零紫粉渐变、单文件 ≤300 行 | P0 |

---

## 10. 边界与约束

- 不支持 IE；Chrome / Safari / Firefox 最新 2 版本；最小分辨率 1366×768
- 响应式断点：sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536
- 性能目标：首屏 < 3s；列表/详情 p95 < 500ms；AI 节点异步不阻塞 HTTP；单次 LLM 超时 60s；代码上下文注入 ≤16000 字符
- 系统对 GitLab 仓库**只读**，不执行任何写操作
- 节点操作互斥后端强制校验（非负责人 403）；数据可见性按最小可见原则服务端过滤
- GitLab 同步串行队列 + 令牌桶 ≥12s/次；遇 429 读 Retry-After 退避重试 ≤3 次；单仓库 ≤200MB / ≤20000 文件
- 代码上下文预算按 provider 窗口动态计算，命中文件清单回显给用户
- 埋点不采集需求正文与代码内容，只采集长度与计数

---

## 11. 内嵌已知坑（从项目记忆拉取）

| 坑 | 技术栈指纹 | 根因 | 修法 |
|----|------------|------|------|
| B1 契约断裂 | express+better-sqlite3 | 真实 LLM 返回 string / mock 返回 object，下游按对象消费取 undefined | runAI 出口统一过 Zod，engine.js 零改 |
| B4 命令注入 | gitlab.js | module_key 无校验拼进 execSync | 白名单 + execFileSync 数组 + realpath 校验 |
| B5 明文密钥 | better-sqlite3 | api_key/token 明文入库 | AES-256-GCM + SOP_MASTER_KEY fail-fast |
| B6 敏感文件外发 | gitlab.js | PRIORITY_RE 给 application.properties +10 分排首位 | L1 文件名正则剔除 + L2 内容嗅探脱敏 |
| maxFiles 丢弃 | ai.js | withCodeContext 签名漏解构 maxFiles | 补解构并透传 buildCodeContext |
| OpenAI 兼容 JSON 能力分化 | llm adapter | DeepSeek/GLM/通义启用 json_object 时 prompt 须含 "json" 否则 400 | L2 自动注入 "json" 字面量 |
| emoji 参与业务逻辑 | ReqList.tsx | emoji 拼进分组 key + startsWith 排序 | 结构化重构为 {key,label,icon,weight}，非字符替换 |

---

## 12. 端到端验证步骤（Spec 锁定的最后一项）

```bash
# 准备
export SOP_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
cd server && npm i && npm run dev

# 核心成功流
1. 管理后台配置真实 Provider → 点连通性测试 → 返回 ok + 延迟 + 结构化能力级别
2. sqlite3 server/data/sop.db "SELECT api_key_enc FROM ai_providers LIMIT 1" → 输出 v1: 开头密文，api_key 列为空
3. 配置 GitLab + 创建 code_module（monorepo 子路径）→ 同步 → sync_tasks 走 QUEUED→RUNNING→OK
4. 新建需求关联平台模块 → 提交 → 走到 EVALUATE 节点
5. 打开详情：EvaluationView 正常渲染等级/人日/影响面表格；列表等级标签有值
6. GET /api/v1/requirements/{id}/code-context → 返回真实仓库文件路径
7. 走到 DEV_PROMPT → 产物出现真实文件路径与类名

# 关键错误流
8. 改错 api_key → 重跑 EVALUATE → 产物仍结构化（mock 兜底）+ 降级徽标 + ai_tasks.degraded_reason=401，不静默
9. 创建 module_key='a"; touch /tmp/pwned; #' → API 返回 400，/tmp/pwned 不存在
10. 连续触发 6 模块同步 → 不出现 429 失败，队列串行完成

# P0 合规门禁
rg -c '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{FE0F}]' web/src server/src | awk -F: '{s+=$2} END {print s+0}'  # 必须 0
find server/src web/src \( -name '*.js' -o -name '*.tsx' -o -name '*.ts' \) | xargs wc -l | awk '$1>300 {print "OVER LIMIT:", $0}'  # 必须无输出
```

---

## 13. 变更记录

| 日期 | 变更内容 | 原因 | 影响范围 |
|------|----------|------|----------|
| 2026-08-04 | v1.0 初始生成 | 用户确认三文档 + ①北星指标 ③定位 | 锁定 F1-F8 + B1-B6 一期范围 |
| 2026-08-04 | F9 降二期 | 2.25 人日 > 2 阈值 | MVP 由 9 项收紧为 8 项 |

---

## 附录：决策索引（已确认）

| 决策 | 结论 | 来源 |
|------|------|------|
| 北星指标 | AI 评估采纳率 ≥60% | 用户确认 ① |
| 产品定位 | 代码不出内网 + AI评估有代码依据 | 用户确认 ③ |
| BLOCKER 范围 | B1-B6 全纳一期 | team-lead 裁决 |
| 定时全量刷新 | 砍掉（GitLab 限流 5/分） | ADR-005 |
| F9 | 降二期（保持退一格） | PRD §7.1 规则 |
| 实施顺序 | F1∥F2→F3→F5→F4→F6→F7→F8 | team-lead 锁定 |
| 图标库 | Lucide 锁定 | ADR-004 |
| 凭据分流 | 可逆 AES / 不可逆 bcrypt | ADR-003 |
| API 版本 | /api/v1 + /api 双挂载 | ADR-007 |
