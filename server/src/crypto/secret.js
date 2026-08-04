// F1 凭证加密（可逆）：api_key / gitlab token 等"需要还原后调用第三方"的凭据。
// 算法 AES-256-GCM，每条记录独立随机 12 字节 IV，存储格式 v1:<iv_b64>:<tag_b64>:<cipher_b64>。
// 主密钥来自环境变量 SOP_MASTER_KEY（32 字节，base64 或 hex），不入库、不入仓、不进日志。
// 注意：登录口令不走这里，用 crypto/password.js 的 bcrypt 哈希（ADR-003 凭据分流）。

'use strict';

const nodeCrypto = require('node:crypto');

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'; // 8 个圆点，前端"未修改"哨兵值

const SETUP_HINT = [
  '未配置 SOP_MASTER_KEY，服务拒绝启动（凭据将无法加密存储）。',
  '生成方式：',
  '  export SOP_MASTER_KEY=$(node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))")',
  '请妥善备份该密钥：密钥丢失后已加密的 api_key / token 不可恢复，需要在后台重新填写。',
].join('\n');

let cachedKey = null;

/** 解析主密钥：优先 base64，其次 hex，必须解出 32 字节 */
function parseMasterKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  let buf;
  try { buf = Buffer.from(s, 'base64'); } catch { return null; }
  return buf.length === KEY_BYTES ? buf : null;
}

/** 是否已正确配置主密钥（不抛错，供启动自检与降级判断使用） */
function isConfigured() {
  return parseMasterKey(process.env.SOP_MASTER_KEY) != null;
}

/** 取主密钥；未配置或格式错误时抛出带指引的错误 */
function getMasterKey() {
  if (cachedKey) return cachedKey;
  const key = parseMasterKey(process.env.SOP_MASTER_KEY);
  if (!key) {
    const err = new Error(`SOP_MASTER_KEY 无效或未设置（需 32 字节 base64/hex）。\n${SETUP_HINT}`);
    err.code = 'MASTER_KEY_MISSING';
    throw err;
  }
  cachedKey = key;
  return cachedKey;
}

/** 启动期 fail-fast：AC-02。缺失即退出进程，不静默降级成明文存储 */
function assertMasterKeyOrExit(logger) {
  if (isConfigured()) return true;
  const msg = `[启动失败] ${SETUP_HINT}`;
  if (logger) logger.error('master_key_missing', { hint: 'SOP_MASTER_KEY' });
  console.error(msg);
  process.exit(1);
}

/** 测试用：清掉进程内缓存的主密钥 */
function resetKeyCache() { cachedKey = null; }

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`) && value.split(':').length === 4;
}

/** 明文 -> v1:iv:tag:cipher；空值原样返回 null，避免把空串加密成一堆密文 */
function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = nodeCrypto.randomBytes(IV_BYTES);
  const cipher = nodeCrypto.createCipheriv(ALGO, getMasterKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

/** v1:iv:tag:cipher -> 明文；格式错误 / 密钥不对 / 密文被篡改都会抛错 */
function decrypt(payload) {
  if (!isEncrypted(payload)) throw new Error('密文格式不合法（期望 v1:iv:tag:cipher）');
  const [, ivB64, tagB64, dataB64] = payload.split(':');
  const decipher = nodeCrypto.createDecipheriv(ALGO, getMasterKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * 宽容解密：R4 风险缓解——主密钥丢失或密文损坏时按"未配置"处理，返回 null 不崩服务。
 * 调用方据此提示管理员重新填写凭据。
 */
function tryDecrypt(payload, logger, ctx) {
  if (payload == null || payload === '') return null;
  try {
    return decrypt(payload);
  } catch (e) {
    if (logger) logger.warn('secret_decrypt_failed', { reason: e.code || e.message, ...(ctx || {}) });
    return null;
  }
}

/**
 * 读取凭据：优先密文列，回落到存量明文列（迁移未跑完时仍可用）。
 * 返回 { value, source: 'enc' | 'legacy' | 'none' }
 */
function readSecret(encValue, legacyValue, logger, ctx) {
  if (isEncrypted(encValue)) {
    const v = tryDecrypt(encValue, logger, ctx);
    if (v != null) return { value: v, source: 'enc' };
    return { value: '', source: 'none' };
  }
  if (legacyValue) return { value: String(legacyValue), source: 'legacy' };
  return { value: '', source: 'none' };
}

/** 对外展示用掩码：有值返回哨兵串，无值返回空串。绝不返回明文片段 */
function mask(hasValue) {
  return hasValue ? MASK : '';
}

/** 前端回传 MASK 表示"不修改该字段" */
function isMaskSentinel(value) {
  return value === MASK;
}

module.exports = {
  VERSION, MASK, SETUP_HINT,
  isConfigured, getMasterKey, assertMasterKeyOrExit, resetKeyCache,
  isEncrypted, encrypt, decrypt, tryDecrypt, readSecret, mask, isMaskSentinel,
};
