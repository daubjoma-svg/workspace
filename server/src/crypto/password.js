// F1 登录口令（不可逆）：users.password 用 bcrypt 哈希，cost=10（ADR-003）。
// 实现选用 bcryptjs：与 bcrypt 同算法、同 $2a$ 哈希格式，纯 JS 无 node-gyp 构建，
// 适配私有化离线部署（目标机器不一定有编译工具链）。

'use strict';

const bcrypt = require('bcryptjs');

const COST = 10;
// bcrypt 哈希固定 60 字符：$2<a|b|y>$<cost>$<22 位 salt + 31 位 hash>
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function isHashed(value) {
  return typeof value === 'string' && BCRYPT_RE.test(value);
}

/** 明文 -> bcrypt 哈希；已是哈希则原样返回（幂等，防止二次哈希把口令锁死） */
function hash(plain) {
  if (plain == null || plain === '') throw new Error('口令不能为空');
  if (isHashed(plain)) return plain;
  return bcrypt.hashSync(String(plain), COST);
}

/**
 * 校验口令。恒定走 bcrypt.compare，不做任何明文比对。
 * 存量未迁移的明文哈希不会匹配 —— 由 migrate.js 在启动时一次性哈希化。
 */
function compare(plain, hashed) {
  if (!plain || !hashed) return false;
  if (!isHashed(hashed)) return false;
  try {
    return bcrypt.compareSync(String(plain), hashed);
  } catch {
    return false;
  }
}

module.exports = { COST, isHashed, hash, compare };
