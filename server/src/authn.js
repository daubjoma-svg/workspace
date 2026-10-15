// 认证层（"你是谁"）：会话 token → req.user。
// 与 authz.js（"你能不能操作这个资源"）分开：认证只解析身份，不做任何资源级判定。
// 单独成文件的原因：api/* 下的子路由需要复用 auth，而 routes.js 又要挂载它们，
// 若 auth 继续留在 routes.js 会形成 routes -> api/* -> routes 的循环依赖。

'use strict';

const { db } = require('./db');

async function auth(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: '未登录' });
  const s = await db.one('SELECT * FROM sessions WHERE token=?', [token]);
  if (!s) return res.status(401).json({ error: '会话失效' });
  const u = await db.one('SELECT id,username,name,role FROM users WHERE id=?', [s.user_id]);
  if (!u) return res.status(401).json({ error: '会话失效' });   // 用户已被删除但会话残留
  req.user = u;
  return next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: '仅管理员可操作' });
  return next();
}

module.exports = { auth, adminOnly };
