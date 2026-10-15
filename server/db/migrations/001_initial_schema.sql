CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password TEXT NOT NULL,
  name VARCHAR(128) NOT NULL,
  role VARCHAR(16) NOT NULL,
  feishu_key VARCHAR(128) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_users_role CHECK (role IN ('CSM', 'PO', 'RD', 'QA', 'ADMIN'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token VARCHAR(128) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_sessions_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  `key` VARCHAR(128) NOT NULL PRIMARY KEY,
  value TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_providers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  type VARCHAR(32) NOT NULL DEFAULT 'openai-compat',
  base_url VARCHAR(1024) NULL,
  api_key TEXT NULL,
  api_key_enc TEXT NULL,
  model VARCHAR(128) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  capability VARCHAR(32) NULL,
  timeout_ms INT NOT NULL DEFAULT 60000,
  max_tokens INT NOT NULL DEFAULT 4096,
  last_tested_at DATETIME NULL,
  last_test_error TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ai_provider_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sop_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sop_nodes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  template_id BIGINT UNSIGNED NOT NULL,
  seq INT NOT NULL,
  node_type VARCHAR(16) NOT NULL,
  name VARCHAR(128) NOT NULL,
  role VARCHAR(16) NULL,
  ai_action VARCHAR(32) NULL,
  ai_prompt LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_nodes_template FOREIGN KEY (template_id) REFERENCES sop_templates(id) ON DELETE CASCADE,
  CONSTRAINT uq_nodes_template_seq UNIQUE (template_id, seq),
  CONSTRAINT chk_nodes_type CHECK (node_type IN ('HUMAN', 'AI'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS requirements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  req_no VARCHAR(64) NOT NULL UNIQUE,
  title VARCHAR(512) NOT NULL,
  description LONGTEXT NOT NULL,
  customer_name VARCHAR(256) NULL,
  priority VARCHAR(16) NOT NULL DEFAULT 'P2',
  expect_date DATE NULL,
  target_version VARCHAR(64) NULL,
  jira_url VARCHAR(1024) NULL,
  csm_id BIGINT UNSIGNED NULL,
  po_id BIGINT UNSIGNED NULL,
  rd_id BIGINT UNSIGNED NULL,
  qa_id BIGINT UNSIGNED NULL,
  template_id BIGINT UNSIGNED NULL,
  current_seq INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  level VARCHAR(8) NULL,
  module_ids TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  closed_at DATETIME NULL,
  CONSTRAINT fk_requirements_csm FOREIGN KEY (csm_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_requirements_po FOREIGN KEY (po_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_requirements_rd FOREIGN KEY (rd_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_requirements_qa FOREIGN KEY (qa_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_requirements_template FOREIGN KEY (template_id) REFERENCES sop_templates(id) ON DELETE SET NULL,
  INDEX idx_req_status (status),
  INDEX idx_req_assignee (po_id, rd_id, qa_id, csm_id),
  INDEX idx_req_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS clarifies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  requirement_id BIGINT UNSIGNED NOT NULL,
  node_id BIGINT UNSIGNED NULL,
  asked_by VARCHAR(128) NOT NULL,
  question LONGTEXT NOT NULL,
  answer LONGTEXT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  kind VARCHAR(16) NOT NULL DEFAULT 'CLARIFY',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  answered_at DATETIME NULL,
  CONSTRAINT fk_clarifies_requirement FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE,
  CONSTRAINT fk_clarifies_node FOREIGN KEY (node_id) REFERENCES sop_nodes(id) ON DELETE SET NULL,
  INDEX idx_clarify_req (requirement_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS artifacts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  requirement_id BIGINT UNSIGNED NOT NULL,
  node_id BIGINT UNSIGNED NULL,
  kind VARCHAR(32) NOT NULL,
  version INT NOT NULL DEFAULT 1,
  content LONGTEXT NOT NULL,
  meta JSON NULL,
  created_by VARCHAR(128) NOT NULL DEFAULT 'AI',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_artifacts_requirement FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE,
  CONSTRAINT fk_artifacts_node FOREIGN KEY (node_id) REFERENCES sop_nodes(id) ON DELETE SET NULL,
  CONSTRAINT uq_artifacts_version UNIQUE (requirement_id, kind, version),
  INDEX idx_artifact_req (requirement_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS timeline (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  requirement_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(64) NOT NULL,
  from_status VARCHAR(32) NULL,
  to_status VARCHAR(32) NULL,
  operator VARCHAR(128) NOT NULL,
  detail TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_timeline_requirement FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE,
  INDEX idx_timeline_req (requirement_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(256) NOT NULL,
  content TEXT NULL,
  requirement_id BIGINT UNSIGNED NULL,
  read_flag TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_requirement FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE SET NULL,
  INDEX idx_notif_user (user_id, read_flag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS req_ai_chats (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  requirement_id BIGINT UNSIGNED NOT NULL,
  artifact_kind VARCHAR(32) NULL,
  question LONGTEXT NOT NULL,
  reply LONGTEXT NOT NULL,
  model VARCHAR(128) NULL,
  provider_type VARCHAR(32) NULL,
  created_by VARCHAR(128) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_chats_requirement FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE,
  INDEX idx_chats_requirement (requirement_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS board_ai_cache (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  role VARCHAR(16) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  text LONGTEXT NOT NULL,
  model VARCHAR(128) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_board_cache_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_board_ai_cache_user_role (user_id, role, kind, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rd_submissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  requirement_id BIGINT UNSIGNED NOT NULL,
  branch_url VARCHAR(1024) NOT NULL,
  pr_url VARCHAR(1024) NULL,
  diff_summary LONGTEXT NOT NULL,
  extra_docs JSON NULL,
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_by VARCHAR(128) NULL,
  CONSTRAINT fk_rd_submissions_requirement FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE,
  INDEX idx_rd_submissions_requirement (requirement_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS code_modules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  gitlab_project_id VARCHAR(128) NOT NULL UNIQUE,
  gitlab_project_path VARCHAR(512) NULL,
  branch VARCHAR(128) NOT NULL DEFAULT 'master',
  sub_path VARCHAR(1024) NOT NULL DEFAULT '',
  sync_status VARCHAR(16) NOT NULL DEFAULT 'IDLE',
  last_synced_at DATETIME NULL,
  commit_sha VARCHAR(128) NULL,
  file_count INT NOT NULL DEFAULT 0,
  error_msg TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS business_modules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL UNIQUE,
  description TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS business_module_codes (
  business_module_id BIGINT UNSIGNED NOT NULL,
  code_module_id BIGINT UNSIGNED NOT NULL,
  path_prefix VARCHAR(1024) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (business_module_id, code_module_id),
  CONSTRAINT fk_bmc_business FOREIGN KEY (business_module_id) REFERENCES business_modules(id) ON DELETE CASCADE,
  CONSTRAINT fk_bmc_code FOREIGN KEY (code_module_id) REFERENCES code_modules(id) ON DELETE CASCADE,
  INDEX idx_bmc_code (code_module_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS requirement_business_modules (
  requirement_id BIGINT UNSIGNED NOT NULL,
  business_module_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (requirement_id, business_module_id),
  CONSTRAINT fk_rbm_requirement FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE,
  CONSTRAINT fk_rbm_business FOREIGN KEY (business_module_id) REFERENCES business_modules(id) ON DELETE CASCADE,
  INDEX idx_rbm_business (business_module_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  requirement_id BIGINT UNSIGNED NULL,
  node_id BIGINT UNSIGNED NULL,
  action VARCHAR(64) NOT NULL,
  provider_id BIGINT UNSIGNED NULL,
  provider_type VARCHAR(32) NULL,
  model VARCHAR(128) NULL,
  structured_level VARCHAR(32) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'OK',
  degraded_reason TEXT NULL,
  is_mock TINYINT(1) NOT NULL DEFAULT 0,
  latency_ms INT NULL,
  attempt INT NOT NULL DEFAULT 0,
  prompt_tokens INT NULL,
  completion_tokens INT NULL,
  code_files_used JSON NULL,
  code_basis LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ai_tasks_requirement FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_tasks_node FOREIGN KEY (node_id) REFERENCES sop_nodes(id) ON DELETE SET NULL,
  INDEX idx_aitask_req (requirement_id),
  INDEX idx_aitask_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
