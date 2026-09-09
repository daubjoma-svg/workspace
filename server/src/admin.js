// 管理后台：用户、SOP 模板编排、AI Provider、模块管理(GIT/PASTE)、数据总览
const express = require('express');
const { db } = require('./db');
const { auth, adminOnly } = require('./routes');
const gitlab = require('./repo');
const password = require('./crypto/password');
const secret = require('./crypto/secret');
const providerRepo = require('./llm/provider');
const providerTest = require('./llm/provider-test');
const { inferCapability, isValidCapability } = require('./llm/capabilities');
const feishu = require('./feishu');

const admin = express.Router();
admin.use(auth, adminOnly);

// B2 可观测：GET /ai-tasks（逻辑在 api/ai-tasks + services/ai-task，此处只做挂载）
admin.use(require('./api/ai-tasks'));

/* ---------- 用户管理 ---------- */
admin.post('/users', (req, res) => {
  const { username, password: plain, name, role } = req.body || {};
  if (!username || !plain || !name || !role) return res.status(400).json({ error: '字段不全' });
  try {
    // 口令可逆加密入库（AES-256-GCM），管理员可在后台回显
    const r = db.prepare('INSERT INTO users(username,password,name,role) VALUES(?,?,?,?)')
      .run(username, password.store(plain), name, role);
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: '用户名已存在' }); }
});
admin.put('/users/:id', (req, res) => {
  const { name, role, password: plain, feishu_key } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  // 安全护栏：管理员账号不允许被改密码（防误操作锁死最高权限账号）
  if (u.role === 'ADMIN' && plain) {
    return res.status(400).json({ error: '管理员账号不允许修改密码' });
  }
  // 未传 password 表示不改；传了就重新可逆加密（store 幂等，防二次加密锁死账号）
  const nextPwd = plain ? password.store(plain) : u.password;
  // feishu_key：传了才更新（可传空串清空）；未传保持原值。trim + 限长防脏数据
  let nextFs = u.feishu_key;
  if (feishu_key !== undefined) {
    nextFs = String(feishu_key).trim();
    if (nextFs.length > 128) return res.status(400).json({ error: '飞书账号长度超限' });
  }
  db.prepare('UPDATE users SET name=?, role=?, password=?, feishu_key=? WHERE id=?')
    .run(name ?? u.name, role ?? u.role, nextPwd, nextFs, u.id);
  res.json({ ok: true });
});
admin.delete('/users/:id', (req, res) => {
  if (+req.params.id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  try {
    const uid = +req.params.id;
    const u = db.prepare('SELECT id FROM users WHERE id=?').get(uid);
    if (!u) return res.status(404).json({ error: '用户不存在' });
    // 先清理关联再删，避免外键约束导致 500：会话/通知直接删，需求负责人置 NULL（需求保留）
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid);
    db.prepare('DELETE FROM notifications WHERE user_id=?').run(uid);
    db.prepare('UPDATE requirements SET csm_id=NULL WHERE csm_id=?').run(uid);
    db.prepare('UPDATE requirements SET po_id=NULL WHERE po_id=?').run(uid);
    db.prepare('UPDATE requirements SET rd_id=NULL WHERE rd_id=?').run(uid);
    db.prepare('UPDATE requirements SET qa_id=NULL WHERE qa_id=?').run(uid);
    db.prepare('DELETE FROM users WHERE id=?').run(uid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '删除失败', detail: e.message });
  }
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
  // 唯一系统内置模板是种子"标准需求交付流程"(id=1)：不允许改名,也不允许被取消默认
  // 其它模板永远不能变 is_system（接口根本不让设）
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

// 克隆流程模板（含所有节点）。返回新模板 id。
admin.post('/sop-templates/:id/clone', (req, res) => {
  const src = db.prepare('SELECT * FROM sop_templates WHERE id=?').get(req.params.id);
  if (!src) return res.status(404).json({ error: '模板不存在' });
  const r = db.prepare(`INSERT INTO sop_templates(name, is_default, is_system) VALUES(?, 0, 0)`)
    .run(`${src.name} - 副本`);
  const newId = r.lastInsertRowid;
  const nodes = db.prepare('SELECT * FROM sop_nodes WHERE template_id=? ORDER BY seq').all(req.params.id);
  const ins = db.prepare(`INSERT INTO sop_nodes
    (template_id, seq, node_type, name, role, ai_action, ai_prompt)
    VALUES(?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const n of nodes) {
      ins.run(newId, n.seq, n.node_type, n.name, n.role, n.ai_action, n.ai_prompt);
    }
  })();
  res.json({ id: newId, name: `${src.name} - 副本`, node_count: nodes.length });
});
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

/* ---------- AI Provider（密钥加密入库，响应恒掩码） ---------- */
admin.get('/ai-providers', (req, res) => {
  res.json(providerRepo.listPublic());
});
admin.post('/ai-providers', (req, res) => {
  const { name, type, base_url, api_key, model, enabled, capability } = req.body || {};
  if (!name) return res.status(400).json({ error: '名称必填' });
  const cap = isValidCapability(capability) ? capability : inferCapability(type || 'openai-compat', base_url);
  if (enabled) db.prepare('UPDATE ai_providers SET enabled=0').run();
  const r = db.prepare(`INSERT INTO ai_providers(name,type,base_url,api_key_enc,model,enabled,capability)
    VALUES(?,?,?,?,?,?,?)`)
    .run(name, type || 'openai-compat', base_url || null,
      api_key ? secret.encrypt(api_key) : null, model || null, enabled ? 1 : 0, cap);
  res.json(providerRepo.toPublic(providerRepo.findById(r.lastInsertRowid)));
});
admin.put('/ai-providers/:id', (req, res) => {
  const { name, type, base_url, api_key, model, enabled, capability } = req.body || {};
  const p = db.prepare('SELECT * FROM ai_providers WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '不存在' });
  if (enabled) db.prepare('UPDATE ai_providers SET enabled=0').run();
  // 掩码哨兵 / 未传 => 保持原密钥；空串 => 清除；其余 => 重新加密
  let nextEnc = p.api_key_enc;
  if (api_key != null && !secret.isMaskSentinel(api_key)) {
    nextEnc = api_key === '' ? null : secret.encrypt(api_key);
  }
  const nextType = type ?? p.type;
  const nextBase = base_url ?? p.base_url;
  const nextCap = isValidCapability(capability) ? capability
    : (isValidCapability(p.capability) ? p.capability : inferCapability(nextType, nextBase));
  db.prepare(`UPDATE ai_providers SET name=?,type=?,base_url=?,api_key_enc=?,api_key=NULL,model=?,enabled=?,capability=?
    WHERE id=?`)
    .run(name ?? p.name, nextType, nextBase, nextEnc, model ?? p.model,
      enabled == null ? p.enabled : (enabled ? 1 : 0), nextCap, p.id);
  res.json(providerRepo.toPublic(providerRepo.findById(p.id)));
});
admin.delete('/ai-providers/:id', (req, res) => {
  db.prepare('DELETE FROM ai_providers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// Provider 连通性测试：真实模型调用一次极简请求，结果留痕（last_tested_at / last_test_error）。
// mock 类型直接回成功；无 key → 400；不存在 → 404；任何调用失败 → 400 且错误入库可查。
admin.post('/ai-providers/:id/test', async (req, res) => {
  const provider = providerRepo.findById(+req.params.id);
  if (!provider) return res.status(404).json({ error: 'Provider 不存在' });
  // mock 类型无密钥，直接走成功分支；其余类型必须有可用 key
  const needKey = provider.type !== 'mock';
  const apiKey = needKey ? providerRepo.resolveApiKey(provider) : '';
  if (needKey && !apiKey) return res.status(400).json({ error: '该 Provider 未配置 API Key' });
  const started = Date.now();
  try {
    const { reply, model } = await providerTest.testProvider(provider, apiKey);
    const latencyMs = Date.now() - started;
    db.prepare("UPDATE ai_providers SET last_tested_at=datetime('now','localtime'), last_test_error=NULL WHERE id=?")
      .run(provider.id);
    res.json({ ok: true, model, latency_ms: latencyMs, reply: String(reply).slice(0, 100) });
  } catch (e) {
    db.prepare("UPDATE ai_providers SET last_tested_at=datetime('now','localtime'), last_test_error=? WHERE id=?")
      .run(String(e.message).slice(0, 500), provider.id);
    res.status(400).json({ error: e.message });
  }
});

/* ---------- AI 配置一键健康检测 ---------- */
// 遍历所有 provider：无 key → 标「未配 Key」；有 key → 真实连通测试；返回每项状态 + 建议
admin.post('/ai-providers/health-check', async (req, res) => {
  const all = providerRepo.listAll();
  const results = [];
  for (const p of all) {
    // trae-cli 走本机进程：无 key 也可测（用本机登录态）；填了 trae-lt-xxx 更稳
    const needKey = p.type !== 'mock' && p.type !== 'trae-cli';
    const apiKey = needKey ? providerRepo.resolveApiKey(p) : '';
    const base = {
      id: p.id, name: p.name, type: p.type, model: p.model,
      base_url: p.base_url, enabled: !!p.enabled,
    };
    if (needKey && !apiKey) {
      results.push({ ...base, status: 'NO_KEY', has_key: false, reachable: false, error: '未配置 API Key', suggestion: '编辑并填入 API Key 后保存' });
      continue;
    }
    if (p.type === 'mock') {
      results.push({ ...base, status: 'OK', has_key: true, reachable: true, error: null, suggestion: null, latency_ms: 0 });
      continue;
    }
    const started = Date.now();
    try {
      const { reply, model } = await providerTest.testProvider(p, apiKey);
      results.push({
        ...base, status: 'OK', has_key: true, reachable: true, error: null, suggestion: null,
        model: model || p.model, latency_ms: Date.now() - started, reply: String(reply).slice(0, 80),
      });
    } catch (e) {
      results.push({
        ...base, status: 'FAIL', has_key: true, reachable: false,
        error: String(e.message).slice(0, 200),
        suggestion: '检查 base_url / API Key / 网络（该配置当前不可用）',
      });
    }
  }
  // 汇总
  const ok = results.filter((r) => r.status === 'OK').length;
  res.json({ providers: results, summary: { total: results.length, ok, fail: results.length - ok } });
});

/* ---------- 从 CLI 检测本地已安装的 Agent 工具 ---------- */
// 检测本地已安装的 claude / codex / kimi CLI 工具（用于「从 CLI 检测」按钮自动建 provider）。
// 注意：Trae 是字节跳动的 AI IDE 工具，**没有公开 HTTP API endpoint**，所以这里不自动建 Trae provider。
admin.get('/ai-providers/scan-cli', async (req, res) => {
  const { execFile } = require('child_process');
  const targets = [
    { id: 'claude', type: 'anthropic',    label: 'Claude', base_url: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
    { id: 'codex',  type: 'openai-compat', label: 'Codex',  base_url: 'https://api.openai.com',   model: 'gpt-5.6' },
    { id: 'kimi',   type: 'openai-compat', label: 'Kimi',   base_url: 'https://api.moonshot.cn',  model: 'kimi-k2-0905-preview' },
  ];
  const probe = (cmd) => new Promise((resolve) => {
    execFile('which', [cmd], { timeout: 3000 }, (err, stdout) => {
      const path = (stdout || '').trim();
      resolve(err || !path ? null : path);
    });
  });
  const results = await Promise.all(targets.map(async (t) => {
    const p = await probe(t.id);
    return { ...t, installed: !!p, path: p };
  }));
  res.json({ agents: results });
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

/* ---------- v0.7 代码仓库(只 GIT) + 业务模块(挂多仓库) ---------- */
admin.use(require('./admin-modules'));
admin.use(require('./admin-business-modules'));

/* ---------- 飞书通知配置 ---------- */
// app_secret 加密落 settings（secret.js AES-256-GCM），GET 绝不返回明文；test 是唯一把飞书错误抛给前端的点
admin.get('/settings/feishu', (req, res) => {
  res.json(feishu.maskedFeishuCfg());
});
admin.put('/settings/feishu', (req, res) => {
  feishu.setFeishuConfig(req.body || {});
  res.json(feishu.maskedFeishuCfg());
});
admin.post('/settings/feishu/test', async (req, res) => {
  const { target } = req.body || {};
  if (!target) return res.status(400).json({ error: '缺少测试目标（user_id 或邮箱）' });
  try {
    // 测试用已存配置的应用凭据（app_secret 解密后仅供请求，不落日志/响应）
    const cfg = feishu.getFeishuCfg();
    await feishu.sendFeishuTest(cfg.appId, cfg.appSecret, target);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------- 总览 ---------- */
admin.get('/stats', (req, res) => {
  const byStatus = db.prepare('SELECT status, COUNT(*) n FROM requirements GROUP BY status').all();
  const byLevel = db.prepare('SELECT level, COUNT(*) n FROM requirements WHERE level IS NOT NULL GROUP BY level').all();
  const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const reqs = db.prepare('SELECT COUNT(*) n FROM requirements').get().n;
  res.json({ byStatus, byLevel, users, requirements: reqs });
});

// 管理员明文查看密钥接口（只读，独立成文件 admin-keys.js，保持本文件 ≤300 行）
admin.use(require('./admin-keys'));

// 管理员批量删除需求：级联清理 clarifies/artifacts/timeline/业务模块关联，事务保证原子性
admin.post('/requirements/batch-delete', (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((x) => Number.isInteger(x));
  if (!ids.length) return res.status(400).json({ error: '请选择要删除的需求' });
  const ph = ids.map(() => '?').join(',');
  const existing = db.prepare(`SELECT id FROM requirements WHERE id IN (${ph})`).all(...ids);
  if (!existing.length) return res.status(400).json({ error: '所选需求不存在' });
  try {
    db.transaction(() => {
      db.prepare(`DELETE FROM clarifies WHERE requirement_id IN (${ph})`).run(...ids);
      db.prepare(`DELETE FROM artifacts WHERE requirement_id IN (${ph})`).run(...ids);
      db.prepare(`DELETE FROM timeline WHERE requirement_id IN (${ph})`).run(...ids);
      db.prepare(`DELETE FROM requirement_business_modules WHERE requirement_id IN (${ph})`).run(...ids);
      db.prepare(`DELETE FROM requirements WHERE id IN (${ph})`).run(...ids);
    })();
    res.json({ ok: true, deleted: existing.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = admin;
