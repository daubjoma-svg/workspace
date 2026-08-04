const express = require('express');
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('./db');
const engine = require('./engine');
const password = require('./crypto/password');
const logger = require('./logger');

const router = express.Router();

// 恒定耗时比对用的哑哈希（bcrypt("__no_such_user__")），仅用于抹平用户不存在时的响应时间差
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

/* ---------- 鉴权 ---------- */
function auth(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: '未登录' });
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s) return res.status(401).json({ error: '会话失效' });
  req.user = db.prepare('SELECT id,username,name,role FROM users WHERE id=?').get(s.user_id);
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: '仅管理员可操作' });
  next();
}

/* ---------- 认证 ---------- */
// F1/AC-03：先按 username 查行，再 bcrypt.compare，绝不明文比对。
// 用户不存在时也走一次 compare，避免响应时间差成为用户名枚举信道。
router.post('/auth/login', (req, res) => {
  const { username, password: input } = req.body || {};
  if (!username || !input) return res.status(400).json({ error: '用户名与密码必填' });
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  const ok = u ? password.compare(input, u.password) : password.compare(input, DUMMY_HASH);
  if (!u || !ok) {
    logger.warn('login_failed', { username: String(username).slice(0, 64), reason: u ? 'bad_password' : 'no_such_user' });
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id) VALUES(?,?)').run(token, u.id);
  logger.info('login_ok', { user_id: u.id, role: u.role });
  res.json({ token, user: { id: u.id, username: u.username, name: u.name, role: u.role } });
});
router.post('/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run(req.headers['x-token']);
  res.json({ ok: true });
});
router.get('/me', auth, (req, res) => res.json(req.user));

/* ---------- 用户/角色（登录后可选负责人） ---------- */
router.get('/users', auth, (req, res) => {
  res.json(db.prepare('SELECT id,username,name,role,created_at FROM users ORDER BY id').all());
});

/* ---------- 平台模块(登录即可见,供提需求时选择) ---------- */
router.get('/platform-modules', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT mm.id, mm.platform_name, mm.platform_key, mm.path_prefix,
           cm.name code_module_name, cm.module_key, cm.sync_status
    FROM module_mappings mm JOIN code_modules cm ON cm.id=mm.code_module_id ORDER BY mm.id`).all());
});

/* ---------- 需求单 ---------- */
router.post('/requirements', auth, (req, res) => {
  const { title, description, customer_name, priority, expect_date, po_id, rd_id, qa_id, template_id, module_ids } = req.body || {};
  if (!title || !description) return res.status(400).json({ error: '标题与描述必填' });
  const tpl = template_id || (db.prepare('SELECT id FROM sop_templates WHERE is_default=1').get() || {}).id
    || (db.prepare('SELECT id FROM sop_templates ORDER BY id LIMIT 1').get() || {}).id;
  if (!tpl) return res.status(400).json({ error: '尚未配置 SOP 模板' });
  const reqNo = 'RQ-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(Date.now() % 100000).padStart(5, '0');
  const mids = Array.isArray(module_ids) ? module_ids.filter(Number.isInteger) : [];
  const r = db.prepare(`INSERT INTO requirements(req_no,title,description,customer_name,priority,expect_date,csm_id,po_id,rd_id,qa_id,template_id,module_ids)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(reqNo, title, description, customer_name || '', priority || 'P2', expect_date || null,
      req.user.id, po_id || null, rd_id || null, qa_id || null, tpl, mids.join(','));
  const reqId = r.lastInsertRowid;
  const insM = db.prepare('INSERT OR IGNORE INTO requirement_modules(requirement_id,mapping_id) VALUES(?,?)');
  mids.forEach((mid) => insM.run(reqId, mid));
  engine.addTimeline(reqId, 'CREATE', req.user.name, '创建需求草稿');
  res.json({ id: reqId, req_no: reqNo });
});

router.get('/requirements', auth, (req, res) => {
  const { status, mine, role } = req.query;
  let sql = `SELECT r.*, u.name csm_name, p.name po_name, d.name rd_name, q.name qa_name
    FROM requirements r
    LEFT JOIN users u ON u.id=r.csm_id LEFT JOIN users p ON p.id=r.po_id
    LEFT JOIN users d ON d.id=r.rd_id LEFT JOIN users q ON q.id=r.qa_id WHERE 1=1`;
  const args = [];
  if (status) { sql += ' AND r.status=?'; args.push(status); }
  if (mine === '1') {
    const col = { CSM: 'csm_id', PO: 'po_id', RD: 'rd_id', QA: 'qa_id' }[role || req.user.role];
    if (col) { sql += ` AND r.${col}=?`; args.push(req.user.id); }
  }
  sql += ' ORDER BY r.id DESC';
  const rows = db.prepare(sql).all(...args);
  // 附带：待澄清问题数（看板/列表用于「待补充」标识）
  const cq = db.prepare("SELECT COUNT(*) n FROM clarifies WHERE requirement_id=? AND status='OPEN'");
  rows.forEach((r) => { r.open_clarifies = cq.get(r.id).n; });
  res.json(rows);
});

router.get('/requirements/:id', auth, (req, res) => {
  const r = engine.getReq(req.params.id);
  if (!r) return res.status(404).json({ error: '需求不存在' });
  const names = db.prepare('SELECT id,name FROM users').all().reduce((m, u) => (m[u.id] = u.name, m), {});
  const nodes = engine.getNodes(r.template_id);
  const openClarifies = db.prepare("SELECT * FROM clarifies WHERE requirement_id=? AND status='OPEN'").all(r.id);
  const modules = db.prepare(`
    SELECT mm.id, mm.platform_name, mm.platform_key, cm.name code_module_name, cm.module_key, cm.sync_status, cm.last_synced_at
    FROM requirement_modules rm JOIN module_mappings mm ON mm.id=rm.mapping_id
    JOIN code_modules cm ON cm.id=mm.code_module_id WHERE rm.requirement_id=?`).all(r.id);
  // 每个节点的进度状态（看板时间轴用）：done / current / pending
  const isDone = r.status === 'DONE';
  const nodesView = nodes.map((n) => ({
    ...n,
    state: isDone || n.seq < r.current_seq ? 'done' : (n.seq === r.current_seq ? 'current' : 'pending'),
  }));
  res.json({
    ...r,
    csm_name: names[r.csm_id], po_name: names[r.po_id], rd_name: names[r.rd_id], qa_name: names[r.qa_id],
    nodes, nodes_view: nodesView, open_clarifies: openClarifies, modules,
  });
});

router.post('/requirements/:id/submit', auth, async (req, res) => {
  try { await engine.submit(+req.params.id, req.user.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/requirements/:id/confirm', auth, async (req, res) => {
  try { await engine.confirm(+req.params.id, req.user.name, req.body?.note); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/requirements/:id/return', auth, async (req, res) => {
  try { await engine.sendBack(+req.params.id, req.user.name, req.body?.reason); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/requirements/:id/force-submit', auth, async (req, res) => {
  try { await engine.forceSubmit(+req.params.id, req.user.name, req.body?.note); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/requirements/:id/cancel', auth, (req, res) => {
  engine.touchReq(+req.params.id, { status: 'CANCELLED', current_seq: -1, closed_at: new Date().toISOString() });
  engine.addTimeline(+req.params.id, 'CANCEL', req.user.name, req.body?.reason || '取消需求');
  res.json({ ok: true });
});

/* ---------- 澄清 ---------- */
router.post('/clarifies/:id/answer', auth, async (req, res) => {
  try { await engine.answerClarify(+req.params.id, req.body?.answer || '', req.user.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- 产物 ---------- */
router.get('/requirements/:id/artifacts', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM artifacts WHERE requirement_id=? ORDER BY kind, version DESC').all(req.params.id));
});
router.post('/requirements/:id/artifacts', auth, (req, res) => {
  const { kind, content, meta } = req.body || {};
  if (!kind || !content) return res.status(400).json({ error: 'kind/content 必填' });
  const v = engine.saveArtifact(+req.params.id, null, kind, content, req.user.name, meta ? JSON.stringify(meta) : null);
  engine.addTimeline(+req.params.id, 'ARTIFACT_SAVE', req.user.name, `保存 ${kind} v${v}`);
  res.json({ ok: true, version: v });
});
router.get('/requirements/:id/timeline', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM timeline WHERE requirement_id=? ORDER BY id').all(req.params.id));
});

/* ---------- 通知 ---------- */
router.get('/notifications', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id));
});
router.post('/notifications/read-all', auth, (req, res) => {
  db.prepare('UPDATE notifications SET read_flag=1 WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

/* ---------- 主题设置 ---------- */
router.get('/settings/theme', auth, (req, res) => {
  res.json({
    primary: getSetting('theme.primary', '#0E62A8'),
    mode: getSetting('theme.mode', 'light'),
  });
});
router.put('/settings/theme', auth, adminOnly, (req, res) => {
  const { primary, mode } = req.body || {};
  if (primary) setSetting('theme.primary', primary);
  if (mode) setSetting('theme.mode', mode);
  res.json({ ok: true });
});

module.exports = { router, auth, adminOnly };
