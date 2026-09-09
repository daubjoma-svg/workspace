const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'sop.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('CSM','PO','RD','QA','ADMIN')),
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS ai_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'openai-compat',  -- openai-compat | anthropic | mock
  base_url TEXT,
  api_key TEXT,
  model TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sop_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  is_system INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- node_type: HUMAN | AI
-- role: CSM/PO/RD/QA (仅 HUMAN 节点)
-- ai_action: PRECHECK/EVALUATE/PRD_GEN/DEV_PROMPT/TEST_CASE/CUSTOM (仅 AI 节点)
CREATE TABLE IF NOT EXISTS sop_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES sop_templates(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  node_type TEXT NOT NULL CHECK(node_type IN ('HUMAN','AI')),
  name TEXT NOT NULL,
  role TEXT,
  ai_action TEXT,
  ai_prompt TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  req_no TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  customer_name TEXT,
  priority TEXT DEFAULT 'P2',
  expect_date TEXT,
  csm_id INTEGER NOT NULL REFERENCES users(id),
  po_id INTEGER REFERENCES users(id),
  rd_id INTEGER REFERENCES users(id),
  qa_id INTEGER REFERENCES users(id),
  template_id INTEGER REFERENCES sop_templates(id),
  current_seq INTEGER DEFAULT 0,         -- 当前节点在模板中的 seq；999=DONE, -1=CANCELLED
  status TEXT NOT NULL DEFAULT 'DRAFT',
  level TEXT,                            -- L1-L4，评估后回填
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  closed_at TEXT
);

-- 需求在某个 AI 节点上的待处理提问
CREATE TABLE IF NOT EXISTS clarifies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  node_id INTEGER REFERENCES sop_nodes(id),
  asked_by TEXT NOT NULL,        -- AI 或 用户名
  question TEXT NOT NULL,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',   -- OPEN / ANSWERED / FORCED
  created_at TEXT DEFAULT (datetime('now','localtime')),
  answered_at TEXT
);

-- 需求 × AI 追问会话（「和 AI 继续对话」历史）：每次追问一对 问题/回答 一行，按时间正序即完整会话
CREATE TABLE IF NOT EXISTS req_ai_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  artifact_kind TEXT,               -- 追问时所在的产物 tab（EVALUATION/PRD/...），上下文来源
  question TEXT NOT NULL,
  reply TEXT NOT NULL,
  model TEXT,
  provider_type TEXT,
  created_by TEXT,                  -- 提问人展示名
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- 看板 AI 视角分析缓存（按 user+role 持久化，每次打开直接展示上次结果）
CREATE TABLE IF NOT EXISTS board_ai_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,                 -- CSM/PO/RD/QA
  kind TEXT NOT NULL,                 -- summary/advice
  text TEXT NOT NULL,
  model TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_board_ai_cache_user_role ON board_ai_cache(user_id, role, kind, created_at DESC);


-- 研发节点提交物：分支 + PR + 改动点摘要 + 补充文档
CREATE TABLE IF NOT EXISTS rd_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  branch_url TEXT NOT NULL,         -- 必填：分支名或分支链接，如 feature/orSign-active
  pr_url TEXT,                      -- 可选：GitHub/GitLab PR 链接
  diff_summary TEXT NOT NULL,       -- 必填：研发手写改动点（改了哪些文件/类/接口/逻辑）
  extra_docs TEXT,                  -- JSON 数组：补充文档类型，如 ["修改点说明","前端联调文档","数据迁移说明"]
  submitted_at TEXT DEFAULT (datetime('now','localtime')),
  submitted_by TEXT                 -- 研发姓名（前端取登录用户）
);


-- 各节点产物：评估报告 / PRD / DevPrompt / 测试用例 / 测试报告 / 代码提交
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  node_id INTEGER REFERENCES sop_nodes(id),
  kind TEXT NOT NULL,   -- EVALUATION/PRD/DEV_PROMPT/TEST_CASE/TEST_REPORT/CODE_SUBMIT/NOTE
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  meta TEXT,            -- JSON: model/tokens/level 等
  created_by TEXT NOT NULL DEFAULT 'AI',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  operator TEXT NOT NULL,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  content TEXT,
  requirement_id INTEGER,
  read_flag INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- v0.7 代码模块：精简为「仓库快照」语义，砍掉 module_key/name/description/source_type/paste_content/git_token_enc
-- 唯一标识 = gitlab_project_id（从 GitLab API 加载项目后下拉选，无需手填 key/name）
CREATE TABLE IF NOT EXISTS code_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gitlab_project_id TEXT UNIQUE NOT NULL,  -- GitLab project id
  gitlab_project_path TEXT,                -- 冗余展示: group/repo（从 GitLab 自动拉）
  branch TEXT DEFAULT 'master',             -- 强制 master
  sub_path TEXT DEFAULT '',                -- monorepo 子路径
  sync_status TEXT DEFAULT 'IDLE',         -- IDLE/SYNCING/OK/FAILED
  last_synced_at TEXT,
  commit_sha TEXT,
  file_count INTEGER DEFAULT 0,
  error_msg TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- v0.7 业务模块：替代原 module_mappings 的「平台」概念；CSM 提单时按业务模块关联
-- 一个业务模块可挂多个代码仓库（如「用户中心」→ usercenter 仓库 + harmony 共享模块）
CREATE TABLE IF NOT EXISTS business_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,                -- 业务模块名: 用户中心 / 订单中心 / 营销活动
  description TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- v0.7 业务模块 ↔ 代码仓库 多对多（含 path_prefix 用于 monorepo 子路径）
CREATE TABLE IF NOT EXISTS business_module_codes (
  business_module_id INTEGER NOT NULL REFERENCES business_modules(id) ON DELETE CASCADE,
  code_module_id INTEGER NOT NULL REFERENCES code_modules(id) ON DELETE CASCADE,
  path_prefix TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (business_module_id, code_module_id)
);

-- v0.7 需求单 ↔ 业务模块 多对多（替代 requirement_modules）
CREATE TABLE IF NOT EXISTS requirement_business_modules (
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  business_module_id INTEGER NOT NULL REFERENCES business_modules(id) ON DELETE CASCADE,
  PRIMARY KEY (requirement_id, business_module_id)
);

CREATE INDEX IF NOT EXISTS idx_bmc_biz ON business_module_codes(business_module_id);
CREATE INDEX IF NOT EXISTS idx_bmc_code ON business_module_codes(code_module_id);
CREATE INDEX IF NOT EXISTS idx_rbm_req ON requirement_business_modules(requirement_id);
CREATE INDEX IF NOT EXISTS idx_rbm_biz ON requirement_business_modules(business_module_id);

-- v0.4/v0.6: 平台模块(业务视角) → 代码模块 的映射
-- 一个平台可挂多个代码模块: 联合唯一(platform_key, code_module_id)
CREATE TABLE IF NOT EXISTS module_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_name TEXT NOT NULL,          -- 平台模块名,如 用户中心
  platform_key TEXT NOT NULL,           -- 如 user-center
  code_module_id INTEGER NOT NULL REFERENCES code_modules(id) ON DELETE CASCADE,
  path_prefix TEXT DEFAULT '',          -- 生效的子路径前缀
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(platform_key, code_module_id)
);

-- v0.4: 需求单 ↔ 平台模块 多对多
CREATE TABLE IF NOT EXISTS requirement_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  mapping_id INTEGER NOT NULL REFERENCES module_mappings(id) ON DELETE CASCADE,
  UNIQUE(requirement_id, mapping_id)
);

-- v0.7 迁移：旧 module_mappings/requirement_modules 表与 code_modules 冗余字段清理
DROP TABLE IF EXISTS module_mappings;
DROP TABLE IF EXISTS requirement_modules;
DROP INDEX IF EXISTS idx_reqmod_req;
DROP INDEX IF EXISTS idx_mapping_module;

CREATE INDEX IF NOT EXISTS idx_req_status ON requirements(status);
CREATE INDEX IF NOT EXISTS idx_req_assignee ON requirements(po_id, rd_id, qa_id, csm_id);
CREATE INDEX IF NOT EXISTS idx_clarify_req ON clarifies(requirement_id, status);
CREATE INDEX IF NOT EXISTS idx_artifact_req ON artifacts(requirement_id, kind);
CREATE INDEX IF NOT EXISTS idx_timeline_req ON timeline(requirement_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_flag);
`);

// v0.7 code_modules 旧列清理（SQLite 不允许 DROP UNIQUE 列：先删 UNIQUE 索引再 DROP COLUMN）
try { db.exec('DROP INDEX IF EXISTS sqlite_autoindex_code_modules_1') } catch (e) { console.warn('drop_unique_index_failed', e.message) }
try { db.exec('ALTER TABLE code_modules DROP COLUMN module_key') } catch (e) { console.warn('drop_module_key_failed', e.message) }
try { db.exec('ALTER TABLE code_modules DROP COLUMN name') } catch (e) { console.warn('drop_name_failed', e.message) }
try { db.exec('ALTER TABLE code_modules DROP COLUMN description') } catch (e) { console.warn('drop_description_failed', e.message) }
try { db.exec('ALTER TABLE code_modules DROP COLUMN source_type') } catch (e) { console.warn('drop_source_type_failed', e.message) }
try { db.exec('ALTER TABLE code_modules DROP COLUMN paste_content') } catch (e) { console.warn('drop_paste_content_failed', e.message) }
try { db.exec('ALTER TABLE code_modules DROP COLUMN git_token_enc') } catch (e) { console.warn('drop_git_token_enc_failed', e.message) }

// v0.4 迁移:requirements 表补 module 冗余列(可选,主用 requirement_modules)
try { db.exec("ALTER TABLE requirements ADD COLUMN module_ids TEXT DEFAULT ''"); } catch {}
// v0.5 迁移:sop_templates 补 is_system(标准流程不可删/不可改)
try { db.exec("ALTER TABLE sop_templates ADD COLUMN is_system INTEGER DEFAULT 0"); } catch {}
try { db.exec("UPDATE sop_templates SET is_system=1 WHERE is_default=1"); } catch {}
// v1.1 迁移:users 表补 feishu_key(飞书定向通知 user_id/邮箱,非高敏存明文)
try { db.exec("ALTER TABLE users ADD COLUMN feishu_key TEXT DEFAULT ''"); } catch {}
// v1.2 迁移:需求单补 target_version(目标版本号,如 26M8V1,替代具体上线日期;expect_date 保留历史兼容)
try { db.exec("ALTER TABLE requirements ADD COLUMN target_version TEXT"); } catch {}
// v1.2 迁移:clarifies 表补 kind(CLARIFY=旧澄清 / CHAT=需求聊天消息),复用同一张表做「需求聊天工作室」
try { db.exec("ALTER TABLE clarifies ADD COLUMN kind TEXT DEFAULT 'CLARIFY'"); } catch {}

// v1.0 迁移(幂等):F1 凭证加密 + B1 结构化能力 + B2 AI 调用可观测。
// api_key_enc 格式 v1:iv:tag:cipher；迁移完成后 api_key 明文列清空(保留列以兼容回滚)。

// B2 可观测性落地:每次 AI 节点调用留一条记录,降级原因入库可查、可审计,不再只进日志。
// status: OK(真实模型+schema 通过) / DEGRADED(schema 兜底或走 mock) / FAILED(节点执行抛错)
// structured_level: json_schema | json_object | prompt_only | mock(与 artifact.meta 同词表)
db.exec(`
CREATE TABLE IF NOT EXISTS ai_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE CASCADE,
  node_id INTEGER REFERENCES sop_nodes(id),
  action TEXT NOT NULL,
  provider_id INTEGER,
  provider_type TEXT,
  model TEXT,
  structured_level TEXT,
  status TEXT NOT NULL DEFAULT 'OK',
  degraded_reason TEXT,
  is_mock INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  attempt INTEGER DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  code_files_used TEXT,
  code_basis TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_aitask_req ON ai_tasks(requirement_id);
CREATE INDEX IF NOT EXISTS idx_aitask_status ON ai_tasks(status);
`);

const V1_COLUMNS = [
  "ALTER TABLE ai_providers ADD COLUMN api_key_enc TEXT",
  "ALTER TABLE ai_providers ADD COLUMN capability TEXT",
  "ALTER TABLE ai_providers ADD COLUMN timeout_ms INTEGER DEFAULT 60000",
  "ALTER TABLE ai_providers ADD COLUMN max_tokens INTEGER DEFAULT 4096",
  // 连通性探测留痕(openapi AiProvider)：区分"没测过"与"测过但失败"，避免静默降级盲区(B2)
  "ALTER TABLE ai_providers ADD COLUMN last_tested_at TEXT",
  "ALTER TABLE ai_providers ADD COLUMN last_test_error TEXT",
];
for (const sql of V1_COLUMNS) {
  try { db.exec(sql); } catch { /* 列已存在,幂等跳过 */ }
}

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

// v0.7 重构：v0.6 双轨制迁移全部废弃（code_modules 已精简为仅 GIT 字段；
// module_mappings/requirement_modules 已 drop；下面 ensureColumn/ensureColumn/3 个 UPDATE
// 引用了已删字段 source_type/paste_content/git_token_enc，故整段去除以免启动报错）

// v0.7 终极迁移：code_modules UNIQUE 索引无法直接 DROP，必须 CREATE new → INSERT → DROP → RENAME。
// 仅当表里还残留 v0.6 旧列（module_key/name 等）时执行；已有干净 schema 则跳过（PRAGMA 检测）。
try {
  const cols = db.prepare('PRAGMA table_info(code_modules)').all().map((c) => c.name);
  if (cols.includes('module_key')) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`CREATE TABLE code_modules_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gitlab_project_id TEXT UNIQUE NOT NULL,
        gitlab_project_path TEXT,
        branch TEXT DEFAULT 'master',
        sub_path TEXT DEFAULT '',
        sync_status TEXT DEFAULT 'IDLE',
        last_synced_at TEXT,
        commit_sha TEXT,
        file_count INTEGER DEFAULT 0,
        error_msg TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime')))`);
      db.exec(`INSERT INTO code_modules_new(id,gitlab_project_id,gitlab_project_path,branch,sub_path,sync_status,last_synced_at,commit_sha,file_count,error_msg,created_at)
        SELECT id,gitlab_project_id,gitlab_project_path,COALESCE(branch,'master'),COALESCE(sub_path,''),COALESCE(sync_status,'IDLE'),last_synced_at,commit_sha,COALESCE(file_count,0),error_msg,created_at FROM code_modules`);
      db.exec('DROP TABLE code_modules');
      db.exec('ALTER TABLE code_modules_new RENAME TO code_modules');
    })();
    db.pragma('foreign_keys = ON');
  }
} catch (e) { /* 重建失败保留旧表；启动后人工排查 */ }

// 幂等 migration：requirements.jira_url（Jira 链接，由产品填写）
try { db.exec("ALTER TABLE requirements ADD COLUMN jira_url TEXT"); } catch (e) { /* 列已存在 */ }

module.exports = { db, getSetting, setSetting };
