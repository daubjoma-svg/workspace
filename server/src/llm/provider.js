// AI Provider 数据访问：选取启用的 provider、解密 api_key、对外掩码。
// 密钥只在真正发起调用前解密一次，不进日志、不进 API 响应（F1 约束）。

'use strict';

const { db } = require('../db');
const secret = require('../crypto/secret');
const logger = require('../logger');
const { resolveCapability } = require('./capabilities');

const SAFE_COLUMNS = 'id,name,type,base_url,model,enabled,capability,last_tested_at,last_test_error,created_at';

function activeProvider() {
  const p = db.prepare('SELECT * FROM ai_providers WHERE enabled=1 ORDER BY id LIMIT 1').get() || null;
  // 有 enabled provider 但没 API Key → 返回 null（让 ai.js 走 mock 路径兜底，避免 LLM 调 401）
  // 例外：trae-cli 走本地 traecli 进程，无 key 也可用（本机已登录态），但填了 trae-lt-xxx 更稳
  if (p && !p.api_key_enc && !p.api_key && p.type !== 'trae-cli') return null;
  return p;
}

function findById(id) {
  return db.prepare('SELECT * FROM ai_providers WHERE id=?').get(id) || null;
}

/** 解密 api_key。密文损坏或主密钥变更时返回空串，由调用方走降级而非崩溃（风险 R4） */
function resolveApiKey(provider) {
  if (!provider) return '';
  const { value } = secret.readSecret(provider.api_key_enc, provider.api_key, logger, { provider_id: provider.id });
  return value;
}

/** 列表/详情对外表示：绝不含密钥明文，只给"是否已配置"与掩码串 */
function toPublic(provider) {
  if (!provider) return null;
  const hasKey = !!(provider.api_key_enc || provider.api_key);
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    base_url: provider.base_url,
    model: provider.model,
    enabled: provider.enabled,
    capability: resolveCapability(provider),
    api_key_set: hasKey,
    // openapi 契约字段；api_key 同值保留，兼容存量前端读取（两者都是掩码，不存在明文外泄）
    api_key_masked: secret.mask(hasKey),
    api_key: secret.mask(hasKey),
    last_tested_at: provider.last_tested_at || null,
    last_test_error: provider.last_test_error || null,
    created_at: provider.created_at,
  };
}

function listPublic() {
  return db.prepare(`SELECT ${SAFE_COLUMNS},api_key_enc,api_key FROM ai_providers ORDER BY id`)
    .all()
    .map(toPublic);
}

/** 全量（含 disabled 与密钥指针），供健康检测遍历 */
function listAll() {
  return db.prepare('SELECT * FROM ai_providers ORDER BY id').all();
}

module.exports = { SAFE_COLUMNS, activeProvider, findById, resolveApiKey, toPublic, listPublic, listAll };
