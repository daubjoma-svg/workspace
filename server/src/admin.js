// 管理后台：用户、SOP 模板编排、AI Provider、模块管理(GitLab)、数据总览
const express = require('express');
const { db } = require('./db');
const { auth, adminOnly } = require('./routes');
const gitlab = require('./repo');
const password = require('./crypto/password');
const secret = require('./crypto/secret');
const providerRepo = require('./llm/provider');
const { inferCapability, isValidCapability } = require('./llm/capabilities');

const admin = express.Router();
admin.use(auth, adminOnly);

/* ---------- 用户管理 ---------- */
admin.post('/users', (req, res) => {
  const { username, password: plain, name, role } = req.body || {};
  if (!username || !plain || !name || !role) return res.status(400).json({ error: '字段不全' });
  try {
    // F1：口令一律 bcrypt 哈希入库，不存明文
    const r = db.prepare('INSERT INTO users(username,password,name,role) VALUES(?,?,?,?)')
      .run(username, password.hash(plain), name, role);
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: '用户名已存在' }); }
});
admin.put('/users/:id', (req, res) => {
  const { name, role, password: plain } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  // 未传 password 表示不改；传了就重新哈希（hash 对已哈希值幂等，防二次哈希锁死账号）
  const nextPwd = plain ? password.hash(plain) : u.password;
  db.prepare('UPDATE users SET name=?, role=?, password=? WHERE id=?')
    .run(name ?? u.name, role ?? u.role, nextPwd, u.id);
  res.json({ ok: true });
});
admin.delete('/users/:id', (req, res) => {
  if (+req.params.id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------- SOP 模板与节点编排 ---------- */
admin.get('/sop-templates', (req, res) => {
  const tpls = db.prepare('SELECT * FROM sop_templates ORDER BY id').all();
  const nodes = db.prepare('SELECT * FROM sop_nodes ORDER BY template_id, seq').all();
  res.json(tpls.map((t) => ({ ...t, nodes: nodes.filter((n) => n.template_id === t.id) })));
});
admin.post('/sop-templates', (req, res) => {
  const { name, is_default } = req.body || {};
  if (!name) return res.status(400).json({ error: '名称必填' });
  if (is_default) db.prepare('UPDATE sop_templates SET is_default=0').run();
  const r = db.prepare('INSERT INTO sop_templates(name,is_default) VALUES(?,?)').run(name, is_default ? 1 : 0);
  res.json({ id: r.lastInsertRowid });
});
admin.put('/sop-templates/:id', (req, res) => {
  const { name, is_default } = req.body || {};
  const tpl = db.prepare('SELECT * FROM sop_templates WHERE id=?').get(req.params.id);
  if (!tpl) return res.status(404).json({ error: '模板不存在' });
  // 标准交付流程为系统内置:不允许改名,也不允许被取消默认(只可整体替换默认到自定义模板?不允许)
  if (tpl.is_system) {
    if (name && name !== tpl.name) return res.status(400).json({ error: '标准交付流程不可修改' });
    if (is_default === false) return res.status(400).json({ error: '标准交付流程必须保持默认,不可取消' });
  }
  if (is_default) db.prepare('UPDATE sop_templates SET is_default=0').run();
  db.prepare('UPDATE sop_templates SET name=COALESCE(?,name), is_default=COALESCE(?,is_default) WHERE id=?')
    .run(name ?? null, is_default == null ? null : (is_default ? 1 : 0), req.params.id);
  res.json({ ok: true });
});
admin.delete('/sop-templates/:id', (req, res) => {
  const tpl = db.prepare('SELECT * FROM sop_templates WHERE id=?').get(req.params.id);
  if (!tpl) return res.status(404).json({ error: '模板不存在' });
  if (tpl.is_system) return res.status(400).json({ error: '标准交付流程为系统内置,不可删除' });
  const used = db.prepare('SELECT COUNT(*) n FROM requirements WHERE template_id=?').get(req.params.id).n;
  if (used) return res.status(400).json({ error: '该模板已被需求引用，不能删除' });
  db.prepare('DELETE FROM sop_templates WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 整包保存节点（重排/增删改一次提交）。
// 节点可能被历史需求的 clarifies/artifacts 引用，故把引用置空后再删。
admin.put('/sop-templates/:id/nodes', (req, res) => {
  const tplId = +req.params.id;
  const tpl = db.prepare('SELECT * FROM sop_templates WHERE id=?').get(tplId);
  if (!tpl) return res.status(404).json({ error: '模板不存在' });
  if (tpl.is_system) return res.status(400).json({ error: '标准交付流程为系统内置,节点不可修改;可「新建模板」自定义交付流程' });
  const nodes = Array.isArray(req.body?.nodes) ? req.body.nodes : [];
  const tx = db.transaction(() => {
    const oldIds = db.prepare('SELECT id FROM sop_nodes WHERE template_id=?').all(tplId).map((r) => r.id);
    if (oldIds.length) {
      const ph = oldIds.map(() => '?').join(',');
      db.prepare(`UPDATE clarifies SET node_id=NULL WHERE node_id IN (${ph})`).run(...oldIds);
      db.prepare(`UPDATE artifacts SET node_id=NULL WHERE node_id IN (${ph})`).run(...oldIds);
    }
    db.prepare('DELETE FROM sop_nodes WHERE template_id=?').run(tplId);
    const ins = db.prepare('INSERT INTO sop_nodes(template_id,seq,node_type,name,role,ai_action,ai_prompt) VALUES(?,?,?,?,?,?,?)');
    nodes.forEach((n, i) => {
      ins.run(tplId, i + 1, n.node_type, n.name, n.role || null, n.ai_action || null, n.ai_prompt || null);
    });
  });
  tx();
  res.json({ ok: true });
});

/* ---------- AI Provider ---------- */
admin.get('/ai-providers', (req, res) => {
  res.json(db.prepare('SELECT id,name,type,base_url,model,enabled,created_at FROM ai_providers ORDER BY id').all());
});
admin.post('/ai-providers', (req, res) => {
  const { name, type, base_url, api_key, model, enabled } = req.body || {};
  if (!name) return res.status(400).json({ error: '名称必填' });
  if (enabled) db.prepare('UPDATE ai_providers SET enabled=0').run();
  const r = db.prepare('INSERT INTO ai_providers(name,type,base_url,api_key,model,enabled) VALUES(?,?,?,?,?,?)')
    .run(name, type || 'openai-compat', base_url || null, api_key || null, model || null, enabled ? 1 : 0);
  res.json({ id: r.lastInsertRowid });
});
admin.put('/ai-providers/:id', (req, res) => {
  const { name, type, base_url, api_key, model, enabled } = req.body || {};
  if (enabled) db.prepare('UPDATE ai_providers SET enabled=0').run();
  const p = db.prepare('SELECT * FROM ai_providers WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '不存在' });
  db.prepare('UPDATE ai_providers SET name=?,type=?,base_url=?,api_key=?,model=?,enabled=? WHERE id=?')
    .run(name ?? p.name, type ?? p.type, base_url ?? p.base_url, api_key ?? p.api_key, model ?? p.model,
      enabled == null ? p.enabled : (enabled ? 1 : 0), p.id);
  res.json({ ok: true });
});
admin.delete('/ai-providers/:id', (req, res) => {
  db.prepare('DELETE FROM ai_providers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------- GitLab 连接配置 ---------- */
admin.get('/gitlab/config', (req, res) => res.json(gitlab.maskedCfg()));
admin.put('/gitlab/config', (req, res) => {
  gitlab.setGitlabCfg(req.body || {});
  res.json(gitlab.maskedCfg());
});
admin.get('/gitlab/test', async (req, res) => res.json(await gitlab.testConnection()));
admin.get('/gitlab/projects', async (req, res) => {
  try { res.json(await gitlab.listProjects(req.query.search || '')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
admin.get('/gitlab/projects/:pid/branches', async (req, res) => {
  try { res.json(await gitlab.listBranches(req.params.pid)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- 代码模块(GitLab 仓库快照) ---------- */
admin.get('/modules', (req, res) => {
  res.json(db.prepare('SELECT * FROM code_modules ORDER BY id').all());
});
admin.post('/modules', (req, res) => {
  const { module_key, name, description, gitlab_project_id, gitlab_project_path, branch, sub_path } = req.body || {};
  if (!module_key || !name || !gitlab_project_id) return res.status(400).json({ error: 'module_key/name/gitlab_project_id 必填' });
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(module_key)) return res.status(400).json({ error: 'module_key 仅允许字母/数字/-/_' });
  try {
    const r = db.prepare(`INSERT INTO code_modules(module_key,name,description,gitlab_project_id,gitlab_project_path,branch,sub_path)
      VALUES(?,?,?,?,?,?,?)`)
      .run(module_key, name, description || '', String(gitlab_project_id), gitlab_project_path || '', branch || 'main', sub_path || '');
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: 'module_key 已存在' }); }
});
admin.put('/modules/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM code_modules WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '模块不存在' });
  const { name, description, branch, sub_path } = req.body || {};
  db.prepare('UPDATE code_modules SET name=?,description=?,branch=?,sub_path=? WHERE id=?')
    .run(name ?? m.name, description ?? m.description, branch ?? m.branch, sub_path ?? m.sub_path, m.id);
  res.json({ ok: true });
});
admin.delete('/modules/:id', (req, res) => {
  db.prepare('DELETE FROM code_modules WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
admin.post('/modules/:id/sync', async (req, res) => {
  try { res.json(await gitlab.syncModule(+req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
admin.get('/modules/:id/tree', (req, res) => {
  const m = db.prepare('SELECT * FROM code_modules WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '模块不存在' });
  res.json({ tree: gitlab.dirTree(m) });
});

/* ---------- 平台模块映射 ---------- */
admin.get('/mappings', (req, res) => {
  res.json(db.prepare(`
    SELECT mm.*, cm.name code_module_name, cm.module_key, cm.sync_status, cm.last_synced_at
    FROM module_mappings mm JOIN code_modules cm ON cm.id=mm.code_module_id ORDER BY mm.id`).all());
});
admin.post('/mappings', (req, res) => {
  const { platform_name, platform_key, code_module_id, path_prefix } = req.body || {};
  if (!platform_name || !platform_key || !code_module_id) return res.status(400).json({ error: 'platform_name/platform_key/code_module_id 必填' });
  try {
    const r = db.prepare('INSERT INTO module_mappings(platform_name,platform_key,code_module_id,path_prefix) VALUES(?,?,?,?)')
      .run(platform_name, platform_key, code_module_id, path_prefix || '');
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: 'platform_name 或 platform_key 已存在' }); }
});
admin.delete('/mappings/:id', (req, res) => {
  db.prepare('DELETE FROM module_mappings WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------- 总览 ---------- */
admin.get('/stats', (req, res) => {
  const byStatus = db.prepare('SELECT status, COUNT(*) n FROM requirements GROUP BY status').all();
  const byLevel = db.prepare('SELECT level, COUNT(*) n FROM requirements WHERE level IS NOT NULL GROUP BY level').all();
  const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const reqs = db.prepare('SELECT COUNT(*) n FROM requirements').get().n;
  res.json({ byStatus, byLevel, users, requirements: reqs });
});

module.exports = admin;
