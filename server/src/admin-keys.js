// 管理员明文查看密钥接口（只读）。列表/配置接口恒掩码（toPublic/maskedCfg），
// 前端「小眼睛」按钮点击时才调用本模块；明文只进响应、绝不进日志（F1 约束）。
// 独立成文件：admin.js 已达 300 行门禁上限，新增端点按子功能拆分后由 admin.js 挂载，
// 父级 admin.use(auth, adminOnly) 已生效，此处无需重复鉴权。

'use strict';

const express = require('express');
const { db } = require('./db');
const password = require('./crypto/password');
const providerRepo = require('./llm/provider');
const gitlab = require('./repo');
const feishu = require('./feishu');

const router = express.Router();

/* ---------- 用户登录口令 ---------- */
// 可逆密文 -> {viewable:true,password}；存量 bcrypt -> {viewable:false}（重置后可回显）。
// 明文只进响应，不落日志。
router.get('/users/:id/password', async (req, res) => {
  const u = await db.one('SELECT id,password FROM users WHERE id=?', [+req.params.id]);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const plain = password.view(u.password);
  res.json({ viewable: plain != null, password: plain || '' });
});

/* ---------- AI Provider API Key ---------- */
// 无 key → {key:''}；Provider 不存在 → 404。明文只进响应，不落日志。
router.get('/ai-providers/:id/key', (req, res) => {
  const provider = providerRepo.findById(+req.params.id);
  if (!provider) return res.status(404).json({ error: 'Provider 不存在' });
  res.json({ key: providerRepo.resolveApiKey(provider) || '' });
});

/* ---------- GitLab Token ---------- */
// getGitlabCfg() 已含解密逻辑；未配置 → {token:''}。明文只进响应，不落日志。
router.get('/gitlab/token', async (req, res) => {
  res.json({ token: (await gitlab.getGitlabCfg()).token || '' });
});

/* ---------- 飞书 app_secret ---------- */
// getFeishuCfg() 已含解密逻辑；未配置 → {app_secret:''}。明文只进响应，不落日志。
router.get('/settings/feishu/secret', async (req, res) => {
  res.json({ app_secret: (await feishu.getFeishuCfg()).appSecret || '' });
});

module.exports = router;
