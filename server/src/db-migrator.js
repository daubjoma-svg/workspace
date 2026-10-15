'use strict';

const fs = require('fs');
const path = require('path');
const { execute, many, transaction } = require('./db');
const logger = require('./logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

/** 按文件名顺序执行尚未记录的 MySQL DDL 迁移。 */
async function runSchemaMigrations() {
  await execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(64) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const applied = new Set((await many('SELECT version FROM schema_migrations')).map((row) => row.version));
  // 只执行数字版本命名的迁移，避免 macOS 资源文件（如 ._001_initial_schema.sql）被当作 SQL。
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const statements = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((sql) => sql.trim()).filter(Boolean);
    await transaction(async (tx) => {
      for (const sql of statements) await tx.execute(sql);
      await tx.execute('INSERT INTO schema_migrations(version) VALUES(?)', [file]);
    });
    logger.info('database_migration_applied', { version: file });
  }
}

module.exports = { runSchemaMigrations };
