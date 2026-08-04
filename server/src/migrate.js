// 启动期存量数据迁移（幂等，可反复执行）：
//   1. ai_providers.api_key 明文 → api_key_enc 密文，明文列清空
//   2. settings['gitlab.token'] 明文 → settings['gitlab.token_enc'] 密文
//   3. users.password 明文 → bcrypt 哈希
//   4. ai_providers.capability 按 type/base_url 回填
// 前置：SOP_MASTER_KEY 已配置（index.js 在调用本模块前已 fail-fast 校验）。

'use strict';

const { db, getSetting, setSetting } = require('./db');
const secret = require('./crypto/secret');
const password = require('./crypto/password');
const logger = require('./logger');
const { inferCapability, isValidCapability } = require('./llm/capabilities');
const { TOKEN_KEY, TOKEN_ENC_KEY } = require('./repo/gitlab-api');

function migrateProviderKeys() {
  const rows = db.prepare('SELECT id,type,base_url,api_key,api_key_enc FROM ai_providers').all();
  const upd = db.prepare('UPDATE ai_providers SET api_key_enc=?, api_key=NULL WHERE id=?');
  let n = 0;
  for (const r of rows) {
    if (secret.isEncrypted(r.api_key_enc)) {
      if (r.api_key) db.prepare('UPDATE ai_providers SET api_key=NULL WHERE id=?').run(r.id); // 清残留明文
      continue;
    }
    if (!r.api_key) continue;
    upd.run(secret.encrypt(r.api_key), r.id);
    n += 1;
  }
  return n;
}

function migrateGitlabToken() {
  if (secret.isEncrypted(getSetting(TOKEN_ENC_KEY, ''))) {
    if (getSetting(TOKEN_KEY, '')) setSetting(TOKEN_KEY, '');
    return 0;
  }
  const plain = getSetting(TOKEN_KEY, '') || '';
  if (!plain) return 0;
  setSetting(TOKEN_ENC_KEY, secret.encrypt(plain));
  setSetting(TOKEN_KEY, '');
  return 1;
}

function migrateUserPasswords() {
  const rows = db.prepare('SELECT id,username,password FROM users').all();
  const upd = db.prepare('UPDATE users SET password=? WHERE id=?');
  let n = 0;
  for (const u of rows) {
    if (password.isHashed(u.password)) continue;
    upd.run(password.hash(u.password), u.id);
    n += 1;
  }
  return n;
}

function backfillCapability() {
  const rows = db.prepare('SELECT id,type,base_url,capability FROM ai_providers').all();
  const upd = db.prepare('UPDATE ai_providers SET capability=? WHERE id=?');
  let n = 0;
  for (const r of rows) {
    if (isValidCapability(r.capability)) continue;
    upd.run(inferCapability(r.type, r.base_url), r.id);
    n += 1;
  }
  return n;
}

/**
 * 主密钥自检：库里若已有 v1: 前缀密文，试解一条。
 * 解不开说明 SOP_MASTER_KEY 与加密时用的不是同一把 —— 必须与"未配置"区分开，
 * 否则运维侧"没配 key"和"key 配错了"表现完全一致（BLOCKER-2 同款盲区）。
 * @returns 'ok' | 'mismatch' | 'no_data'
 */
function verifyMasterKey() {
  const samples = [];
  const row = db.prepare("SELECT api_key_enc FROM ai_providers WHERE api_key_enc LIKE 'v1:%' LIMIT 1").get();
  if (row) samples.push(row.api_key_enc);
  const token = getSetting(TOKEN_ENC_KEY, '');
  if (secret.isEncrypted(token)) samples.push(token);
  if (!samples.length) return 'no_data';

  for (const payload of samples) {
    try {
      secret.decrypt(payload);
      return 'ok';
    } catch { /* 试下一条 */ }
  }
  logger.error('master_key_mismatch', {
    hint: 'SOP_MASTER_KEY 与存量密文不匹配，已加密的 api_key / gitlab token 无法解密',
    samples: samples.length,
  });
  return 'mismatch';
}

function runMigrations() {
  const stats = db.transaction(() => ({
    provider_keys: migrateProviderKeys(),
    gitlab_token: migrateGitlabToken(),
    user_passwords: migrateUserPasswords(),
    capability: backfillCapability(),
  }))();
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  if (total > 0) logger.info('migration_done', stats);
  return stats;
}

module.exports = {
  runMigrations, verifyMasterKey,
  migrateProviderKeys, migrateGitlabToken, migrateUserPasswords, backfillCapability,
};
