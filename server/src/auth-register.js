// 注册端点：POST /auth/register（挂载在 routes.js 的 auth 区段）。
// 独立成文件的原因：routes.js 已 244 行，注册逻辑约 50 行会把它顶过 300 行门禁（代码组织规范）。
// 职责边界：参数校验 + 简单限流 + 建用户 + 建会话；不触碰引擎/鉴权。
// 角色自选白名单 CSM/PO/RD/QA：ADMIN 不在白名单，防任何人注册成管理员（唯一安全底线），
// ADMIN 仍由管理员在后台分配/提升。

'use strict';

const express = require('express');
const crypto = require('crypto');
const { db } = require('./db');
const password = require('./crypto/password');
const logger = require('./logger');

const router = express.Router();

// 注册可选角色白名单：ADMIN 必须排除（管理员只能由管理员在后台分配/提升）
const ALLOWED_ROLES = ['CSM', 'PO', 'RD', 'FE', 'QA'];
const DEFAULT_ROLE = 'CSM';

// 注册限流：同一 IP 固定窗口 1 分钟 ≤10 次，超限 429。
// 轻量进程内存实现（MVP 单实例足够），不引新依赖。
const REGISTER_MAX = 10;
const REGISTER_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map(); // ip -> { count, windowStart }

function isRateLimited(ip) {
  const now = Date.now();
  const b = rateBuckets.get(ip);
  if (!b || now - b.windowStart >= REGISTER_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    return false;
  }
  b.count += 1;
  if (rateBuckets.size > 1000) {
    // 防内存无限增长：清掉已过窗口的旧桶（偶发 O(n)，桶数有限可接受）
    for (const [k, v] of rateBuckets) {
      if (now - v.windowStart >= REGISTER_WINDOW_MS) rateBuckets.delete(k);
    }
  }
  return b.count > REGISTER_MAX;
}

router.post('/auth/register', async (req, res) => {
  if (isRateLimited(req.ip)) return res.status(429).json({ error: '注册过于频繁，请稍后再试' });

  const { username, password: plain, name, feishu_key, role } = req.body || {};
  const uname = typeof username === 'string' ? username.trim() : '';
  const pwd = typeof plain === 'string' ? plain : '';
  const displayName = typeof name === 'string' ? name.trim() : '';
  const fkey = typeof feishu_key === 'string' ? feishu_key.trim() : '';
  // 角色自选：缺省 CSM；传入的角色必须在白名单内（ADMIN 直接 400）
  const roleVal = typeof role === 'string' && role !== '' ? role.trim().toUpperCase() : DEFAULT_ROLE;
  if (!ALLOWED_ROLES.includes(roleVal)) return res.status(400).json({ error: '角色不合法' });

  if (!uname || !pwd || !displayName) return res.status(400).json({ error: '用户名、密码与显示名必填' });
  if (uname.length > 64) return res.status(400).json({ error: '用户名长度超限' });
  if (pwd.length < 6) return res.status(400).json({ error: '密码长度至少 6 位' });
  if (fkey.length > 128) return res.status(400).json({ error: '飞书账号长度超限' });

  if (await db.one('SELECT id FROM users WHERE username=?', [uname])) {
    return res.status(409).json({ error: '用户名已存在' });
  }

  const r = await db.execute(
    'INSERT INTO users(username,password,name,role,feishu_key) VALUES(?,?,?,?,?)',
    [uname, password.store(pwd), displayName, roleVal, fkey]
  );
  const uid = r.lastInsertRowid;

  // 复用登录会话逻辑：注册即登录，返回 token（与 POST /auth/login 响应同构）
  const token = crypto.randomBytes(24).toString('hex');
  await db.execute('INSERT INTO sessions(token,user_id) VALUES(?,?)', [token, uid]);
  logger.info('register_ok', { user_id: uid, role: roleVal });
  res.status(201).json({ token, user: { id: uid, username: uname, name: displayName, role: roleVal } });
});

module.exports = router;
