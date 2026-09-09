// 登录口令存储与校验。
// 产品决议（2026-08，替代原 F1 bcrypt 方案）：口令需要被管理员回显，
// 新口令用 AES-256-GCM 可逆加密存储（v1:iv:tag:cipher，复用 secret.js 主密钥），
// 管理员可在人员管理页查看真实密码；接口仅对 admin 开放，明文不进日志。
// 存量 bcrypt 哈希（$2a$...）不可逆：仍走 bcrypt 校验保证可登录，后台显示「不可回显」，
// 重置一次后自动切换为可逆密文。

'use strict';

const bcrypt = require('bcryptjs');
const nodeCrypto = require('node:crypto');
const secret = require('./secret');

const COST = 10;
// bcrypt 哈希固定 60 字符：$2<a|b|y>$<cost>$<22 位 salt + 31 位 hash>
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function isHashed(value) {
  return typeof value === 'string' && BCRYPT_RE.test(value);
}

/** 明文 -> 可逆密文入库；已是密文/哈希则原样返回（幂等，防二次加密锁死账号） */
function store(plain) {
  if (plain == null || plain === '') throw new Error('口令不能为空');
  if (isHashed(plain) || secret.isEncrypted(plain)) return plain;
  return secret.encrypt(String(plain));
}

/** 校验口令：bcrypt 走 compare；可逆密文解密后做恒定时间比对 */
function verify(plain, stored) {
  if (!plain || !stored) return false;
  if (isHashed(stored)) {
    try { return bcrypt.compareSync(String(plain), stored); } catch { return false; }
  }
  if (secret.isEncrypted(stored)) {
    const real = secret.tryDecrypt(stored);
    if (real == null) return false;
    const a = Buffer.from(String(plain));
    const b = Buffer.from(real);
    return a.length === b.length && nodeCrypto.timingSafeEqual(a, b);
  }
  return false;
}

/** 管理员查看明文：可逆密文 -> 明文；bcrypt/异常 -> null（不可回显） */
function view(stored) {
  if (secret.isEncrypted(stored)) return secret.tryDecrypt(stored);
  return null;
}

/** 明文 -> bcrypt 哈希；已是哈希则原样返回。保留给 DUMMY_HASH 等兼容场景 */
function hash(plain) {
  if (plain == null || plain === '') throw new Error('口令不能为空');
  if (isHashed(plain)) return plain;
  return bcrypt.hashSync(String(plain), COST);
}

/** bcrypt 校验（存量账号登录 + 登录接口恒定耗时比对用） */
function compare(plain, hashed) {
  if (!plain || !hashed) return false;
  if (!isHashed(hashed)) return false;
  try {
    return bcrypt.compareSync(String(plain), hashed);
  } catch {
    return false;
  }
}

module.exports = { COST, isHashed, hash, compare, store, verify, view };
