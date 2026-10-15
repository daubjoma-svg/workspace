// 管理后台：业务模块管理（v0.7 新概念）
// 业务模块 = CSM 提单时选择的「业务名」（如「用户中心」「订单中心」）
// 一业务可挂多个代码仓库（多对多）；AI 评估时按业务模块收集所有挂载仓库的代码上下文
// 父级 admin.use(auth, adminOnly) 已生效。

'use strict';

const express = require('express');
const { db } = require('./db');
const gitlab = require('./repo');

const router = express.Router();

/** 业务模块列表：每个带挂载的代码仓库（精简字段：仓库 id/path/status） */
router.get('/business-modules', async (req, res) => {
  const rows = await db.many('SELECT * FROM business_modules ORDER BY id', []);
  const codes = await db.many(`
    SELECT bmc.business_module_id, bmc.path_prefix, bmc.code_module_id,
      cm.gitlab_project_id, cm.gitlab_project_path, cm.branch, cm.sync_status, cm.file_count
    FROM business_module_codes bmc
    JOIN code_modules cm ON cm.id = bmc.code_module_id
    ORDER BY bmc.business_module_id, bmc.code_module_id
  `, []);
  const byId = new Map();
  for (const r of rows) byId.set(r.id, { ...r, codes: [] });
  for (const c of codes) {
    const t = byId.get(c.business_module_id);
    if (t) t.codes.push({
      code_module_id: c.code_module_id,
      gitlab_project_id: c.gitlab_project_id,
      gitlab_project_path: c.gitlab_project_path,
      branch: c.branch,
      sync_status: c.sync_status,
      file_count: c.file_count,
      path_prefix: c.path_prefix,
    });
  }
  res.json([...byId.values()]);
});

/** 新建业务模块：name 必填，description 选填 */
router.post('/business-modules', async (req, res) => {
  const { name, description } = req.body || {};
  const type = req.body?.type === 'FRONTEND' ? 'FRONTEND' : 'BACKEND';
  if (!name || !name.trim()) return res.status(400).json({ error: '业务模块名必填' });
  try {
    const r = await db.execute(
      'INSERT INTO business_modules(name, type, description) VALUES(?, ?, ?)',
      [name.trim(), type, (description || '').trim()]
    );
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    if (/UNIQUE|constraint/i.test(e.message)) return res.status(400).json({ error: '业务模块名已存在' });
    throw e;
  }
});

router.put('/business-modules/:id', async (req, res) => {
  const m = await db.one('SELECT * FROM business_modules WHERE id=?', [req.params.id]);
  if (!m) return res.status(404).json({ error: '业务模块不存在' });
  const { name, description } = req.body || {};
  const type = req.body?.type === 'FRONTEND' ? 'FRONTEND' : (req.body?.type === 'BACKEND' ? 'BACKEND' : m.type || 'BACKEND');
  let nextName = m.name;
  if (name != null && name.trim() && name.trim() !== m.name) {
    try { nextName = name.trim(); } catch { /* noop */ }
  }
  await db.execute(
    'UPDATE business_modules SET name=?, type=?, description=? WHERE id=?',
    [nextName, type, description != null ? description : m.description, m.id]
  );
  res.json({ ok: true });
});

router.delete('/business-modules/:id', async (req, res) => {
  const m = await db.one('SELECT * FROM business_modules WHERE id=?', [req.params.id]);
  if (!m) return res.status(404).json({ error: '业务模块不存在' });
  await db.execute('DELETE FROM business_modules WHERE id=?', [m.id]); // ON DELETE CASCADE 自动清挂载
  res.json({ ok: true });
});

/** 业务模块挂代码仓库 */
router.post('/business-modules/:id/codes', async (req, res) => {
  const m = await db.one('SELECT * FROM business_modules WHERE id=?', [req.params.id]);
  if (!m) return res.status(404).json({ error: '业务模块不存在' });
  const { code_module_id, path_prefix } = req.body || {};
  if (!code_module_id) return res.status(400).json({ error: '请选择代码仓库' });
  const cm = await db.one('SELECT id FROM code_modules WHERE id=?', [code_module_id]);
  if (!cm) return res.status(400).json({ error: '代码仓库不存在' });
  let safePath = '';
  if (path_prefix) {
    try { gitlab.assertSafeRelPath(path_prefix, 'path_prefix'); safePath = path_prefix; }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  try {
    await db.execute(
      'INSERT INTO business_module_codes(business_module_id, code_module_id, path_prefix) VALUES(?, ?, ?)',
      [m.id, code_module_id, safePath]
    );
    res.json({ ok: true });
  } catch (e) {
    if (/UNIQUE|constraint/i.test(e.message)) return res.status(400).json({ error: '该仓库已挂载到本业务模块' });
    throw e;
  }
});

/** 业务模块卸代码仓库 */
router.delete('/business-modules/:id/codes/:codeModuleId', async (req, res) => {
  const m = await db.one('SELECT * FROM business_modules WHERE id=?', [req.params.id]);
  if (!m) return res.status(404).json({ error: '业务模块不存在' });
  const r = await db.execute(
    'DELETE FROM business_module_codes WHERE business_module_id=? AND code_module_id=?',
    [m.id, +req.params.codeModuleId]
  );
  if (!r.changes) return res.status(404).json({ error: '该挂载关系不存在' });
  res.json({ ok: true });
});

module.exports = router;
