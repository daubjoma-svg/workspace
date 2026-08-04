// AI Provider 数据访问：选取启用的 provider、解密 api_key、对外掩码。
// 密钥只在真正发起调用前解密一次，不进日志、不进 API 响应（F1 约束）。

'use strict';

const { db } = require('../db');
const secret = require('../crypto/secret');
const logger = require('../logger');
const { resolveCapability } = require('./capabilities');

const SAFE_COLUMNS = 'id,name,type,base_url,model,enabled,capability,created_at';

function activeProvider() {
  return db.prepare('SELECT * FROM ai_providers WHERE enabled=1 ORDER BY id LIMIT 1').get() || null;
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
    api_key: secret.mask(hasKey),
    created_at: provider.created_at,
  };
}

function listPublic() {
  return db.prepare(`SELECT ${SAFE_COLUMNS},api_key_enc,api_key FROM ai_providers ORDER BY id`)
    .all()
    .map(toPublic);
}

module.exports = { SAFE_COLUMNS, activeProvider, findById, resolveApiKey, toPublic, listPublic };
