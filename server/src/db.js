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

-- v0.4: GitLab 代码模块（管理员配置,拉取快照到本地供 AI 分析）
-- source_type: GITLAB | LOCAL(预留)
CREATE TABLE IF NOT EXISTS code_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_key TEXT UNIQUE NOT NULL,      -- 如 usercenter
  name TEXT NOT NULL,                   -- 显示名,如 用户中心
  description TEXT,
  source_type TEXT NOT NULL DEFAULT 'GITLAB',
  gitlab_project_id TEXT,               -- GitLab project id 或 path_with_namespace
  gitlab_project_path TEXT,             -- 冗余展示: group/repo
  branch TEXT DEFAULT 'main',
  sub_path TEXT DEFAULT '',             -- monorepo 子路径
  sync_status TEXT DEFAULT 'IDLE',      -- IDLE/SYNCING/OK/FAILED
  last_synced_at TEXT,
  commit_sha TEXT,
  file_count INTEGER DEFAULT 0,
  error_msg TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- v0.4: 平台模块(业务视角) → 代码模块 的映射
CREATE TABLE IF NOT EXISTS module_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_name TEXT UNIQUE NOT NULL,   -- 平台模块名,如 用户中心
  platform_key TEXT UNIQUE NOT NULL,    -- 如 user-center
  code_module_id INTEGER NOT NULL REFERENCES code_modules(id) ON DELETE CASCADE,
  path_prefix TEXT DEFAULT '',          -- 生效的子路径前缀
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- v0.4: 需求单 ↔ 平台模块 多对多
CREATE TABLE IF NOT EXISTS requirement_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  mapping_id INTEGER NOT NULL REFERENCES module_mappings(id) ON DELETE CASCADE,
  UNIQUE(requirement_id, mapping_id)
);

CREATE INDEX IF NOT EXISTS idx_req_status ON requirements(status);
CREATE INDEX IF NOT EXISTS idx_req_assignee ON requirements(po_id, rd_id, qa_id, csm_id);
CREATE INDEX IF NOT EXISTS idx_clarify_req ON clarifies(requirement_id, status);
CREATE INDEX IF NOT EXISTS idx_artifact_req ON artifacts(requirement_id, kind);
CREATE INDEX IF NOT EXISTS idx_timeline_req ON timeline(requirement_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_flag);
CREATE INDEX IF NOT EXISTS idx_reqmod_req ON requirement_modules(requirement_id);
CREATE INDEX IF NOT EXISTS idx_mapping_module ON module_mappings(code_module_id);
`);

// v0.4 迁移:requirements 表补 module 冗余列(可选,主用 requirement_modules)
try { db.exec("ALTER TABLE requirements ADD COLUMN module_ids TEXT DEFAULT ''"); } catch {}
// v0.5 迁移:sop_templates 补 is_system(标准流程不可删/不可改)
try { db.exec("ALTER TABLE sop_templates ADD COLUMN is_system INTEGER DEFAULT 0"); } catch {}
try { db.exec("UPDATE sop_templates SET is_system=1 WHERE is_default=1"); } catch {}

// v1.0 迁移(幂等):F1 凭证加密 + B1 结构化能力。ai_tasks / sync_tasks 等表由 F3/F6 引入。
// api_key_enc 格式 v1:iv:tag:cipher；迁移完成后 api_key 明文列清空(保留列以兼容回滚)。
const V1_COLUMNS = [
  "ALTER TABLE ai_providers ADD COLUMN api_key_enc TEXT",
  "ALTER TABLE ai_providers ADD COLUMN capability TEXT",
  "ALTER TABLE ai_providers ADD COLUMN timeout_ms INTEGER DEFAULT 60000",
  "ALTER TABLE ai_providers ADD COLUMN max_tokens INTEGER DEFAULT 4096",
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

module.exports = { db, getSetting, setSetting };
