#!/usr/bin/env node
// 旧 SQLite -> MySQL 全量数据迁移（一次性脚本，可重复执行：先清空目标表再整表灌入）。
//
// 背景：服务已从 better-sqlite3 切到 mysql2，老库 data/sop.db 的业务数据需整体搬到 MySQL。
// 关键约束：
//   1) 建表：复用 db-migrator.runSchemaMigrations() 执行 db/migrations/*.sql（幂等），
//      全新环境首次启动即自动建好 20 张表，无需手工执行 DDL。
//   2) 保留主键 id：外键依赖原 id，不能重排。
//   3) 密钥换代：老库密文由旧 SOP_MASTER_KEY 加密，当前服务用新 key；迁移时先用旧 key 解密，
//      再用当前 key 重加密。受影响列：users.password / ai_providers.api_key_enc / settings(gitlab.token_enc、feishu.app_secret)。
//   4) 脏数据清洗：老库无外键约束，notifications 存在指向已删需求的 requirement_id，置 NULL；
//      JSON 空串置 NULL；ISO 时间归一到 MySQL DATETIME。
//
// 用法：
//   SOP_MASTER_KEY=<新key> LEGACY_SOP_MASTER_KEY=<旧key> \
//   DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=sop_app DB_PASSWORD=*** DB_NAME=sop_system \
//   node scripts/migrate-sqlite.js
'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { pool, close, config } = require('../src/db');
const { runSchemaMigrations } = require('../src/db-migrator');
const secret = require('../src/crypto/secret');

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'sop.db');
const LEGACY_MASTER_KEY = process.env.LEGACY_SOP_MASTER_KEY || '';

// 建表顺序（父 -> 子）；清空顺序与之相反，配合 FOREIGN_KEY_CHECKS=0 保证安全。
const TABLES = [
  { name: 'settings', columns: ['key', 'value'] },
  { name: 'users', columns: ['id', 'username', 'password', 'name', 'role', 'feishu_key', 'created_at'] },
  { name: 'sop_templates', columns: ['id', 'name', 'is_default', 'is_system', 'created_at'] },
  { name: 'sop_nodes', columns: ['id', 'template_id', 'seq', 'node_type', 'name', 'role', 'ai_action', 'ai_prompt', 'created_at'] },
  { name: 'ai_providers', columns: ['id', 'name', 'type', 'base_url', 'api_key', 'api_key_enc', 'model', 'enabled', 'capability', 'timeout_ms', 'max_tokens', 'last_tested_at', 'last_test_error', 'created_at'] },
  { name: 'code_modules', columns: ['id', 'gitlab_project_id', 'gitlab_project_path', 'branch', 'sub_path', 'sync_status', 'last_synced_at', 'commit_sha', 'file_count', 'error_msg', 'created_at'] },
  { name: 'business_modules', columns: ['id', 'name', 'description', 'created_at'] },
  { name: 'business_module_codes', columns: ['business_module_id', 'code_module_id', 'path_prefix', 'created_at'] },
  { name: 'requirements', columns: ['id', 'req_no', 'title', 'description', 'customer_name', 'priority', 'expect_date', 'target_version', 'jira_url', 'csm_id', 'po_id', 'rd_id', 'qa_id', 'template_id', 'current_seq', 'status', 'level', 'module_ids', 'created_at', 'updated_at', 'closed_at'] },
  { name: 'requirement_business_modules', columns: ['requirement_id', 'business_module_id'] },
  { name: 'clarifies', columns: ['id', 'requirement_id', 'node_id', 'asked_by', 'question', 'answer', 'status', 'kind', 'created_at', 'answered_at'] },
  { name: 'artifacts', columns: ['id', 'requirement_id', 'node_id', 'kind', 'version', 'content', 'meta', 'created_by', 'created_at'] },
  { name: 'timeline', columns: ['id', 'requirement_id', 'action', 'from_status', 'to_status', 'operator', 'detail', 'created_at'] },
  { name: 'notifications', columns: ['id', 'user_id', 'title', 'content', 'requirement_id', 'read_flag', 'created_at'] },
  { name: 'req_ai_chats', columns: ['id', 'requirement_id', 'artifact_kind', 'question', 'reply', 'model', 'provider_type', 'created_by', 'created_at'] },
  { name: 'board_ai_cache', columns: ['id', 'user_id', 'role', 'kind', 'text', 'model', 'created_at'] },
  { name: 'rd_submissions', columns: ['id', 'requirement_id', 'branch_url', 'pr_url', 'diff_summary', 'extra_docs', 'submitted_at', 'submitted_by'] },
  { name: 'ai_tasks', columns: ['id', 'requirement_id', 'node_id', 'action', 'provider_id', 'provider_type', 'model', 'structured_level', 'status', 'degraded_reason', 'is_mock', 'latency_ms', 'attempt', 'prompt_tokens', 'completion_tokens', 'code_files_used', 'code_basis', 'created_at'] },
  { name: 'sessions', columns: ['token', 'user_id', 'created_at'] },
];

// 外键列 -> 被引用表；被引用 id 不存在时：可空列置 NULL，非空列报错。
const FK_COLUMNS = {
  sop_nodes: { template_id: 'sop_templates' },
  requirements: { csm_id: 'users', po_id: 'users', rd_id: 'users', qa_id: 'users', template_id: 'sop_templates' },
  clarifies: { requirement_id: 'requirements', node_id: 'sop_nodes' },
  artifacts: { requirement_id: 'requirements', node_id: 'sop_nodes' },
  timeline: { requirement_id: 'requirements' },
  notifications: { user_id: 'users', requirement_id: 'requirements' },
  req_ai_chats: { requirement_id: 'requirements' },
  board_ai_cache: { user_id: 'users' },
  rd_submissions: { requirement_id: 'requirements' },
  requirement_business_modules: { requirement_id: 'requirements', business_module_id: 'business_modules' },
  business_module_codes: { business_module_id: 'business_modules', code_module_id: 'code_modules' },
  ai_tasks: { requirement_id: 'requirements', node_id: 'sop_nodes' },
  sessions: { user_id: 'users' },
};

const TS_COLUMNS = new Set(['created_at', 'updated_at', 'submitted_at', 'answered_at', 'closed_at', 'last_tested_at', 'last_synced_at']);
const TS_REQUIRED = new Set(['created_at', 'updated_at', 'submitted_at']);
const DATE_COLUMNS = new Set(['expect_date']);
const JSON_COLUMNS = new Set(['meta', 'extra_docs', 'code_files_used']);
const BOOL_COLUMNS = new Set(['enabled', 'is_default', 'is_system', 'read_flag', 'is_mock']);
const SECRET_COLUMNS = new Set(['password', 'api_key_enc']);

const pad = (n) => String(n).padStart(2, '0');
const nowTs = () => {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
};

/** ISO(带 T/Z) 时间归一到 MySQL DATETIME（+08:00）；空串 -> null；普通字符串原样返回。 */
function normalizeTs(value, required) {
  if (value == null) return required ? nowTs() : null;
  const s = String(value).trim();
  if (!s) return required ? nowTs() : null;
  if (/[TZ]/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      const t = new Date(d.getTime() + 8 * 3600 * 1000);
      return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
    }
  }
  return s;
}

/** 空串/非法 JSON -> null，合法 JSON 原样保留，普通文本包成 JSON 字符串。 */
function toJsonOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  try { JSON.parse(s); return s; } catch { return JSON.stringify(s); }
}

/**
 * 用当前 key 解密；失败则回退旧 key 解密后用当前 key 重加密。
 * 已是当前 key 加密的密文原样返回（保证幂等，避免重复迁移把密文二次加密）。
 */
function reencrypt(payload) {
  if (!secret.isEncrypted(payload)) return payload;
  try { secret.decrypt(payload); return payload; } catch { /* 换旧 key 试 */ }
  if (!LEGACY_MASTER_KEY) return payload;
  const active = process.env.SOP_MASTER_KEY;
  process.env.SOP_MASTER_KEY = LEGACY_MASTER_KEY;
  secret.resetKeyCache();
  let plain = null;
  try { plain = secret.decrypt(payload); } catch { plain = null; }
  process.env.SOP_MASTER_KEY = active;
  secret.resetKeyCache();
  if (plain == null) {
    console.warn('[migrate] 密文无法用新/旧 key 解密，保持原值:', payload.slice(0, 16) + '...');
    return payload;
  }
  return secret.encrypt(plain);
}

async function main() {
  if (!secret.isConfigured()) {
    throw new Error('未配置 SOP_MASTER_KEY（需 32 字节 base64/hex），拒绝迁移');
  }
  if (!LEGACY_MASTER_KEY) {
    console.warn('[migrate] 未提供 LEGACY_SOP_MASTER_KEY：老库密文若由旧 key 加密将无法解密');
  }

  await runSchemaMigrations();

  const sqlite = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });
  const sourceRows = {};
  for (const { name, columns } of TABLES) {
    sourceRows[name] = sqlite.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(',')} FROM "${name}"`).all();
  }

  const idSets = {
    users: new Set(sourceRows.users.map((r) => r.id)),
    sop_templates: new Set(sourceRows.sop_templates.map((r) => r.id)),
    sop_nodes: new Set(sourceRows.sop_nodes.map((r) => r.id)),
    requirements: new Set(sourceRows.requirements.map((r) => r.id)),
    business_modules: new Set(sourceRows.business_modules.map((r) => r.id)),
    code_modules: new Set(sourceRows.code_modules.map((r) => r.id)),
  };

  const conn = await pool.getConnection();
  const stats = {};
  try {
    const [colMeta] = await conn.query(
      'SELECT TABLE_NAME t, COLUMN_NAME c, IS_NULLABLE n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=?',
      [config.database],
    );
    const nullable = new Map();
    for (const { t, c, n } of colMeta) {
      if (!nullable.has(t)) nullable.set(t, new Set());
      if (n === 'YES') nullable.get(t).add(c);
    }

    await conn.query('SET FOREIGN_KEY_CHECKS=0');
    await conn.beginTransaction();

    for (const { name } of [...TABLES].reverse()) {
      await conn.query(`DELETE FROM \`${name}\``);
    }

    for (const { name, columns } of TABLES) {
      const fks = FK_COLUMNS[name] || {};
      const colSql = columns.map((c) => `\`${c}\``).join(',');
      const phSql = columns.map(() => '?').join(',');
      const insertSql = `INSERT INTO \`${name}\` (${colSql}) VALUES (${phSql})`;
      let count = 0;
      for (const row of sourceRows[name]) {
        const values = [];
        let skip = false;
        for (const col of columns) {
          let v = row[col] === undefined ? null : row[col];
          if (TS_COLUMNS.has(col)) {
            v = normalizeTs(v, TS_REQUIRED.has(col));
          } else if (DATE_COLUMNS.has(col)) {
            v = v ? String(v).slice(0, 10) : null;
          } else if (JSON_COLUMNS.has(col)) {
            v = toJsonOrNull(v);
          } else if (BOOL_COLUMNS.has(col)) {
            v = v == null ? 0 : (Number(v) ? 1 : 0);
          } else if (SECRET_COLUMNS.has(col) || (name === 'settings' && col === 'value')) {
            v = reencrypt(v);
          }
          if (fks[col] != null && v != null && !idSets[fks[col]].has(v)) {
            if (nullable.get(name)?.has(col)) {
              v = null;
            } else {
              throw new Error(`${name}.${col}=${v} 引用 ${fks[col]} 不存在，且该列非空，无法迁移`);
            }
          }
          values.push(v);
        }
        if (skip) continue;
        await conn.execute(insertSql, values);
        count += 1;
      }
      stats[name] = count;
    }

    await conn.commit();
    await conn.query('SET FOREIGN_KEY_CHECKS=1');
  } catch (error) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw error;
  } finally {
    conn.release();
  }

  sqlite.close();

  console.log('[migrate] SQLite -> MySQL 完成，各表写入行数：');
  for (const { name } of TABLES) console.log('  ', name.padEnd(30), stats[name]);

  const [check] = await pool.query('SELECT COUNT(*) c FROM users');
  console.log('[migrate] users 表当前行数:', check[0].c);
  await close();
}

main().catch((error) => {
  console.error('[migrate] 迁移失败:', error.message);
  close().catch(() => {});
  process.exitCode = 1;
});
