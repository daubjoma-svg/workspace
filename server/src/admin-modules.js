// 管理后台：代码仓库管理（v0.7 精简版——只支持 GIT 拉取，无粘贴/独立 token 字段）
// 父级 admin.use(auth, adminOnly) 已生效，无需重复鉴权。

'use strict';

const express = require('express');
const { db } = require('./db');
const logger = require('./logger');
const gitlab = require('./repo');

const router = express.Router();

const LIST_COLS = `id, gitlab_project_id, gitlab_project_path, branch, sub_path,
  sync_status, last_synced_at, commit_sha, file_count, error_msg, created_at`;

/** 列表 */
router.get('/modules', (req, res) => {
  const rows = db.prepare(`SELECT ${LIST_COLS} FROM code_modules ORDER BY id`).all();
  res.json(rows);
});

/** 详情 */
router.get('/modules/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM code_modules WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '仓库不存在' });
  res.json(m);
});

/** 新增：从 GitLab 项目下拉选 → 同步；path 前端可改，branch 恒 master */
router.post('/modules', (req, res) => {
  const { gitlab_project_id, gitlab_project_path, sub_path } = req.body || {};
  if (!gitlab_project_id) return res.status(400).json({ error: '请选择 GitLab 项目' });
  try { gitlab.assertSafeRelPath(sub_path || '', 'sub_path'); } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  try {
    const r = db.prepare(`INSERT INTO code_modules(gitlab_project_id, gitlab_project_path, branch, sub_path)
      VALUES(?, ?, 'master', ?)`)
      .run(String(gitlab_project_id), gitlab_project_path || '', sub_path || '');
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    // 精确判断 UNIQUE 冲突：SQLite 是 "UNIQUE constraint failed: code_modules.<col>"
    // NOT NULL 是 "NOT NULL constraint failed: code_modules.<col>" —— 不要误判为「已添加」
    if (/UNIQUE constraint failed/i.test(e.message)) return res.status(400).json({ error: '该 GitLab 项目已添加' });
    if (/NOT NULL constraint failed/i.test(e.message)) return res.status(400).json({ error: '字段缺失，请联系管理员排查 DB schema' });
    throw e;
  }
});

/** 编辑：仅允许改 sub_path（branch 强制 master 不允许改） */
router.put('/modules/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM code_modules WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '仓库不存在' });
  const { sub_path } = req.body || {};
  let nextSub = m.sub_path;
  if (sub_path != null) {
    try { gitlab.assertSafeRelPath(sub_path, 'sub_path'); } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    nextSub = sub_path;
  }
  db.prepare(`UPDATE code_modules SET sub_path=? WHERE id=?`).run(nextSub, m.id);
  res.json({ ok: true });
});

router.delete('/modules/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM code_modules WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '仓库不存在' });
  // 检查是否有业务模块挂载：有则拒（保护）
  const linked = db.prepare('SELECT COUNT(*) c FROM business_module_codes WHERE code_module_id=?').get(m.id).c;
  if (linked > 0) return res.status(400).json({ error: `该仓库被 ${linked} 个业务模块挂载，请先解绑` });
  db.prepare('DELETE FROM code_modules WHERE id=?').run(m.id);
  res.json({ ok: true });
});

router.post('/modules/:id/sync', async (req, res) => {
  try { res.json(await gitlab.syncModule(+req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/modules/:id/tree', (req, res) => {
  const m = db.prepare('SELECT * FROM code_modules WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '仓库不存在' });
  const dirKey = String(m.gitlab_project_id).replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = gitlab.moduleRoot(gitlab.REPOS_DIR, dirKey);
  res.json({ tree: m.sync_status === 'OK' ? gitlab.dirTree({ sub_path: m.sub_path }) : null });
});

module.exports = router;
