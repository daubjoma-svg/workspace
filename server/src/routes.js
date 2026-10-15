const express = require('express');
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('./db');
const engine = require('./engine');
const password = require('./crypto/password');
const logger = require('./logger');
const { auth, adminOnly } = require('./authn');
const { requireNodeOwner, requireClarifyOwner, requireTestCaseOwner } = require('./authz');
const { aiChat, generatePrd } = require('./ai');
const { activeProvider, resolveApiKey } = require('./llm/provider');
const { requestOnce } = require('./llm-call');
const codeContextApi = require('./api/code-context');
const requirementActions = require('./api/requirement-actions');
const uploadsApi = require('./api/uploads');
const authRegister = require('./auth-register');

const router = express.Router();

// 恒定耗时比对用的哑哈希（bcrypt("__no_such_user__")），仅用于抹平用户不存在时的响应时间差
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

// P0 改造：目标版本号格式（26M8V1 = 26年8月V1版；一个月四个版本 W1/V1/W2/V2）。
// 宽松校验：非空则必须匹配，空允许（不强制填）。
const TARGET_VERSION_RE = /^2\dM(1[0-2]|[1-9])(W1|V1|W2|V2)$/;
function validTargetVersion(v) {
  if (v == null || v === '') return true;
  return typeof v === 'string' && TARGET_VERSION_RE.test(v.trim());
}

/* ---------- 认证 ---------- */
// F1/AC-03：先按 username 查行，再 bcrypt.compare，绝不明文比对。
// 用户不存在时也走一次 compare，避免响应时间差成为用户名枚举信道。
router.post('/auth/login', async (req, res) => {
  const { username, password: input } = req.body || {};
  if (!username || !input) return res.status(400).json({ error: '用户名与密码必填' });
  const u = await db.one('SELECT * FROM users WHERE username=?', [username]);
  // verify 兼容两种存储：可逆密文（新）与 bcrypt 哈希（存量）；用户不存在时走哑哈希抹平时差
  const ok = u ? password.verify(input, u.password) : password.compare(input, DUMMY_HASH);
  if (!u || !ok) {
    logger.warn('login_failed', { username: String(username).slice(0, 64), reason: u ? 'bad_password' : 'no_such_user' });
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  await db.execute('INSERT INTO sessions(token,user_id) VALUES(?,?)', [token, u.id]);
  logger.info('login_ok', { user_id: u.id, role: u.role });
  res.json({ token, user: { id: u.id, username: u.username, name: u.name, role: u.role } });
});
router.post('/auth/logout', auth, async (req, res) => {
  await db.execute('DELETE FROM sessions WHERE token=?', [req.headers['x-token']]);
  res.json({ ok: true });
});
router.get('/me', auth, (req, res) => res.json(req.user));

// 注册（独立模块，避免 routes.js 超 300 行门禁；逻辑见 src/auth-register.js）
router.use(authRegister);

/* ---------- 用户/角色（登录后可选负责人） ---------- */
router.get('/users', auth, async (req, res) => {
  // Jira 账号属于管理员人员管理信息，仅管理员可看到账号名与配置状态；普通角色继续只拿负责人基础信息。
  const jiraFields = req.user.role === 'ADMIN'
    ? `,jira_username,
       CASE WHEN COALESCE(jira_username,'')<>'' AND COALESCE(jira_api_token_enc,'')<>'' THEN 1 ELSE 0 END AS jira_configured,
       CASE WHEN COALESCE(password,'')<>'' THEN 1 ELSE 0 END AS password_configured`
    : '';
  res.json(await db.many(
    `SELECT id,username,name,role,feishu_key${jiraFields},created_at FROM users ORDER BY id`,
    []
  ));
});

/* ---------- 业务模块(登录即可见,供提需求时选择) ---------- */
router.get('/business-modules-public', auth, async (req, res) => {
  // 公开端点：CSM 提单时只看到 id + name + description，不暴露 codes 内部细节
  res.json(await db.many(`SELECT id, name, description, type FROM business_modules ORDER BY id`, []));
});

/* ---------- 客户名称(提单表单下拉候选，按提单人账号隔离) ---------- */
// 列表来源：该账号历史需求里填写过的客户名称（去重）。用户新填的客户名保存到需求后，下次即出现在候选里。
router.get('/customer-names', auth, async (req, res) => {
  const rows = await db.many(
    `SELECT DISTINCT customer_name FROM requirements
      WHERE csm_id=? AND customer_name IS NOT NULL AND customer_name<>''
      ORDER BY customer_name`,
    [req.user.id]
  );
  res.json(rows.map((r) => r.customer_name));
});

/* ---------- 需求单 ---------- */
// P0 改造：CSM 建单只选产品(po_id)；研发/测试由产品在 /assign 接口指派；上线时间用 target_version 替代 expect_date。
// v0.7：module_ids 现在存 business_module.id（业务模块 ID）而非 module_mappings.id
router.post('/requirements', auth, async (req, res) => {
  const { title, description, customer_name, priority, po_id, template_id, module_ids, target_version } = req.body || {};
  if (!title || !description) return res.status(400).json({ error: '标题与描述必填' });
  if (!validTargetVersion(target_version)) {
    return res.status(400).json({ error: '目标版本格式不正确，示例：26M8V1（26年8月V1版，W1/V1/W2/V2）' });
  }
  const tpl = template_id || ((await db.one('SELECT id FROM sop_templates WHERE is_default=1', [])) || {}).id
    || ((await db.one('SELECT id FROM sop_templates ORDER BY id LIMIT 1', [])) || {}).id;
  if (!tpl) return res.status(400).json({ error: '尚未配置 SOP 模板' });
  const reqNo = 'RQ-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(Date.now() % 100000).padStart(5, '0');
  const mids = Array.isArray(module_ids) ? module_ids.filter(Number.isInteger) : [];
  const r = await db.execute(
    `INSERT INTO requirements(req_no,title,description,customer_name,priority,csm_id,po_id,template_id,module_ids,target_version)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [
      reqNo,
      title,
      description,
      customer_name || '',
      priority || 'P2',
      req.user.id,
      po_id || null,
      tpl,
      mids.join(','),
      (target_version || '').trim() || null
    ]
  );
  const reqId = r.lastInsertRowid;
  for (const mid of mids) {
    await db.execute('INSERT IGNORE INTO requirement_business_modules(requirement_id,business_module_id) VALUES(?,?)', [reqId, mid]);
  }
  await engine.addTimeline(reqId, 'CREATE', req.user.name, '创建需求草稿');
  res.json({ id: reqId, req_no: reqNo });
});

// 编辑需求：提单人或 ADMIN；DRAFT 全字段可改，非 DRAFT 禁改 title 与负责人（流程中换人会时序错乱）
router.put('/requirements/:id', auth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '需求 ID 不合法' });
  const r = await engine.getReq(id);
  if (!r) return res.status(404).json({ error: '需求不存在' });
  if (r.csm_id !== req.user.id && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: `需求「${r.req_no}」仅提单人可编辑` });
  }
  if (r.status === 'DONE' || r.status === 'CANCELLED') {
    return res.status(400).json({ error: `需求「${r.req_no}」已${r.status === 'DONE' ? '完成' : '取消'}，不可编辑` });
  }
  const body = req.body || {};
  const isDraft = r.status === 'DRAFT';
  const fields = {};
  if (body.title !== undefined) {
    if (!isDraft) return res.status(400).json({ error: '需求已提交，标题不可修改' });
    if (typeof body.title !== 'string' || !body.title.trim()) return res.status(400).json({ error: '标题不能为空' });
    fields.title = body.title;
  }
  // P0 改造：CSM 只选产品(po_id)；rd_id/qa_id 由产品经 /assign 指派，这里不再接收。
  if (body.po_id !== undefined) {
    if (!isDraft) return res.status(400).json({ error: '需求已提交，产品负责人不可修改' });
    fields.po_id = body.po_id ? Number(body.po_id) : null;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || !body.description.trim()) return res.status(400).json({ error: '描述不能为空' });
    fields.description = body.description;
  }
  if (body.customer_name !== undefined) fields.customer_name = body.customer_name || '';
  if (body.priority !== undefined) fields.priority = body.priority || 'P2';
  // 目标版本号：非空则校验格式，空允许（置 null）；expect_date 不再接收（历史兼容保留原值）
  if (body.target_version !== undefined) {
    if (!validTargetVersion(body.target_version)) {
      return res.status(400).json({ error: '目标版本格式不正确，示例：26M8V1（26年8月V1版，W1/V1/W2/V2）' });
    }
    fields.target_version = (body.target_version || '').trim() || null;
  }
  if (body.jira_url !== undefined) {
    const u = String(body.jira_url || '').trim();
    fields.jira_url = u || null;
  }
  let mids = null;
  if (Array.isArray(body.module_ids)) {
    mids = body.module_ids.filter(Number.isInteger);
    fields.module_ids = mids.join(',');
  }
  if (!Object.keys(fields).length) return res.status(400).json({ error: '没有可更新的字段' });
  await engine.touchReq(id, fields);
  if (mids !== null) {
    // 业务模块变更：先删后插，简单可靠（v0.7：business_module.id 替代 mapping_id）
    await db.execute('DELETE FROM requirement_business_modules WHERE requirement_id=?', [id]);
    for (const mid of mids) {
      await db.execute('INSERT IGNORE INTO requirement_business_modules(requirement_id,business_module_id) VALUES(?,?)', [id, mid]);
    }
  }
  await engine.addTimeline(id, 'UPDATE', req.user.name, '更新需求信息');
  res.json({ ok: true });
});

router.get('/requirements', auth, async (req, res) => {
  const { status, mine, role } = req.query;
  // 分页：不带 page/pageSize 时保持原数组返回（看板/列表旧调用零改动）；
  // 带任一参数时返回 {items,total,page,pageSize}。page≥1，pageSize 默认 20 上限 100。
  const hasPaging = req.query.page !== undefined || req.query.pageSize !== undefined;
  let page = Number.parseInt(req.query.page, 10);
  let pageSize = Number.parseInt(req.query.pageSize, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = 20;
  if (pageSize > 100) pageSize = 100;
  // 附当前节点 role/node_type：看板按「当前节点是否该角色处理」过滤 todo。
  // 用相关子查询（DB 量级 <100 行可读性优先）；DONE(current_seq=999)/CANCELLED(current_seq=-1)
  // 在节点表中无对应行，天然返回 NULL，前端兜底为 null。
  let sql = `SELECT r.*, u.name csm_name, p.name po_name, d.name rd_name, f.name fe_name, q.name qa_name,
    (SELECT role FROM sop_nodes WHERE template_id=r.template_id AND seq=r.current_seq) AS current_node_role,
    (SELECT node_type FROM sop_nodes WHERE template_id=r.template_id AND seq=r.current_seq) AS current_node_type
    FROM requirements r
    LEFT JOIN users u ON u.id=r.csm_id LEFT JOIN users p ON p.id=r.po_id
    LEFT JOIN users d ON d.id=r.rd_id LEFT JOIN users f ON f.id=r.fe_id
    LEFT JOIN users q ON q.id=r.qa_id WHERE 1=1`;
  // 计数与列表同 WHERE（过滤逻辑保留），仅分页时执行，非分页路径零额外查询
  let countSql = 'SELECT COUNT(*) n FROM requirements r WHERE 1=1';
  const args = [];
  if (status) { sql += ' AND r.status=?'; countSql += ' AND r.status=?'; args.push(status); }
  if (mine === '1') {
    const col = { CSM: 'csm_id', PO: 'po_id', RD: 'rd_id', FE: 'fe_id', QA: 'qa_id' }[role || req.user.role];
    if (col) { sql += ` AND r.${col}=?`; countSql += ` AND r.${col}=?`; args.push(req.user.id); }
  }
  let total = null;
  if (hasPaging) total = (await db.one(countSql, [...args])).n;
  sql += ' ORDER BY r.id DESC';
  if (hasPaging) sql += ' LIMIT ? OFFSET ?';
  const rows = hasPaging
    ? await db.many(sql, [...args, pageSize, (page - 1) * pageSize])
    : await db.many(sql, [...args]);
  // 附带：待澄清问题数（看板/列表用于「待补充」标识）
  for (const r of rows) {
    r.open_clarifies = (await db.one("SELECT COUNT(*) n FROM clarifies WHERE requirement_id=? AND status='OPEN'", [r.id])).n;
  }
  // 附带：业务模块（看板「模块」维度分桶用；一次全量取出后按需求归组）
  const rbmAll = await db.many(
    `SELECT rbm.requirement_id, rbm.business_module_id, bm.name AS business_name
      FROM requirement_business_modules rbm JOIN business_modules bm ON bm.id = rbm.business_module_id`,
    []
  );
  const modMap = {};
  for (const row of rbmAll) (modMap[row.requirement_id] ||= []).push({ business_module_id: row.business_module_id, business_name: row.business_name });
  rows.forEach((r) => { r.modules = modMap[r.id] || []; });
  if (hasPaging) res.json({ items: rows, total, page, pageSize });
  else res.json(rows);
});

router.get('/requirements/:id', auth, async (req, res) => {
  const r = await engine.getReq(req.params.id);
  if (!r) return res.status(404).json({ error: '需求不存在' });
  const names = (await db.many('SELECT id,name FROM users', [])).reduce((m, u) => (m[u.id] = u.name, m), {});
  const nodes = await engine.getNodes(r.template_id);
  const openClarifies = await db.many("SELECT * FROM clarifies WHERE requirement_id=? AND status='OPEN'", [r.id]);
  // v0.7 业务模块挂载：业务模块 → 多仓库 code_modules（LEFT JOIN 允许业务模块未挂代码）
  const modules = await db.many(`
    SELECT bm.id AS business_module_id, bm.name AS business_name, bm.description AS business_description, bm.type AS business_type,
      bmc.path_prefix, bmc.code_module_id,
      cm.gitlab_project_id, cm.gitlab_project_path, cm.branch, cm.sync_status, cm.file_count
    FROM requirement_business_modules rbm
    JOIN business_modules bm ON bm.id = rbm.business_module_id
    LEFT JOIN business_module_codes bmc ON bmc.business_module_id = bm.id
    LEFT JOIN code_modules cm ON cm.id = bmc.code_module_id
    WHERE rbm.requirement_id=?`, [r.id]);
  // 每个节点的进度状态（看板时间轴用）：done / current / pending
  const isDone = r.status === 'DONE';
  const nodesView = nodes.map((n) => ({
    ...n,
    state: isDone || n.seq < r.current_seq ? 'done' : (n.seq === r.current_seq ? 'current' : 'pending'),
  }));
  res.json({
    ...r,
    csm_name: names[r.csm_id], po_name: names[r.po_id], rd_name: names[r.rd_id], fe_name: names[r.fe_id], qa_name: names[r.qa_id],
    nodes, nodes_view: nodesView, open_clarifies: openClarifies, modules,
  });
});

/* ---------- 节点流转 ----------
   P0-01：每个动作先过 requireNodeOwner（SPEC §10 L222 非负责人 403），
   鉴权判定全在 authz.js，这里只负责编排；engine 收到的 operator 仍是展示名。 */
router.post('/requirements/:id/submit', auth, requireNodeOwner('submit'), async (req, res) => {
  try { await engine.submit(+req.params.id, req.user.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/requirements/:id/confirm', auth, requireNodeOwner('confirm'), async (req, res) => {
  try {
    // RD 节点流转前必须先提交开发产物（分支 + 改动摘要）
    const r = await engine.getReq(+req.params.id);
    if (r) {
      const node = await db.one(
        'SELECT role FROM sop_nodes WHERE template_id=? AND seq=?',
        [r.template_id || 1, r.current_seq]
      );
      if (node && node.role === 'RD') {
        const sub = await db.one(
          'SELECT id FROM rd_submissions WHERE requirement_id=? ORDER BY id DESC LIMIT 1',
          [r.id]
        );
        if (!sub) return res.status(400).json({ error: '请先在「开发提交」表单中提交分支与改动点摘要，再流转到下一步' });
      }
    }
    await engine.confirm(+req.params.id, req.user.name, req.body?.note);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 研发节点提交开发产物（分支 + PR + 改动点摘要 + 补充文档）
router.post('/requirements/:id/rd-submission', auth, async (req, res) => {
  const r = await engine.getReq(+req.params.id);
  if (!r) return res.status(404).json({ error: '需求不存在' });
  // 开发提交是研发节点产物：仅研发/前端负责人（未指派任一负责人时任一研发/前端）或 ADMIN 可提交
  const isDevRole = req.user.role === 'RD' || req.user.role === 'FE';
  const devAssigned = (req.user.role === 'RD' && r.rd_id === req.user.id)
    || (req.user.role === 'FE' && r.fe_id === req.user.id);
  const noDevAssigned = !r.rd_id && !r.fe_id;
  const isOwner = req.user.role === 'ADMIN' || (isDevRole && (devAssigned || noDevAssigned));
  if (!isOwner) return res.status(403).json({ error: '仅研发负责人或管理员可提交' });
  const { branch_url, pr_url, diff_summary, extra_docs } = req.body || {};
  if (!branch_url || !String(branch_url).trim()) return res.status(400).json({ error: '请填写分支名或分支链接' });
  if (!diff_summary || !String(diff_summary).trim()) return res.status(400).json({ error: '请填写改动点摘要（改了哪些文件/类/接口）' });
  const extra = Array.isArray(extra_docs) ? JSON.stringify(extra_docs) : null;
  const info = await db.execute(
    `INSERT INTO rd_submissions(requirement_id, branch_url, pr_url, diff_summary, extra_docs, submitted_by) VALUES(?,?,?,?,?,?)`,
    [
      r.id,
      String(branch_url).trim(),
      pr_url ? String(pr_url).trim() : null,
      String(diff_summary).trim(),
      extra,
      req.user.name
    ]
  );
  try { await engine.addTimeline(r.id, 'RD_SUBMIT', req.user.name, '分支：' + String(branch_url).trim() + (pr_url ? ' | PR：' + String(pr_url).trim() : '')); } catch {}
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.get('/requirements/:id/rd-submission', auth, async (req, res) => {
  const r = await engine.getReq(+req.params.id);
  if (!r) return res.status(404).json({ error: '需求不存在' });
  const row = await db.one(
    'SELECT id, branch_url, pr_url, diff_summary, extra_docs, submitted_at, submitted_by FROM rd_submissions WHERE requirement_id=? ORDER BY id DESC LIMIT 1',
    [r.id]
  );
  if (!row) return res.json(null);
  try { row.extra_docs = row.extra_docs ? JSON.parse(row.extra_docs) : []; } catch { row.extra_docs = []; }
  res.json(row);
});
router.post('/requirements/:id/return', auth, requireNodeOwner('return'), async (req, res) => {
  try { await engine.sendBack(+req.params.id, req.user.name, req.body?.reason); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/requirements/:id/force-submit', auth, requireNodeOwner('force-submit'), async (req, res) => {
  try { await engine.forceSubmit(+req.params.id, req.user.name, req.body?.note); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// 重新跑当前 AI 节点（产品功能：AI 评估不准时主动重跑，不等走完整流程）。
// 权限：CSM 提单人 + ADMIN（用自定义校验，避免 requireNodeOwner 限制过死——AI 节点没固定负责人）
router.post('/requirements/:id/reevaluate', auth, async (req, res) => {
  const r = await engine.getReq(+req.params.id);
  if (!r) return res.status(404).json({ error: '需求不存在' });
  const isOwner = req.user.role === 'ADMIN' || r.csm_id === req.user.id;
  if (!isOwner) return res.status(403).json({ error: '仅提单人或管理员可重新评估' });
  try {
    const result = await engine.reevaluate(+req.params.id, req.user.name, req.body?.node_seq ?? null);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 方案 B：跳过当前挂起的 AI 节点（兜底产物时人工确认"继续走"），直接进入下一节点
// 权限：CSM 提单人 + ADMIN
router.post('/requirements/:id/skip-ai', auth, async (req, res) => {
  const r = await engine.getReq(+req.params.id);
  if (!r) return res.status(404).json({ error: '需求不存在' });
  const isOwner = req.user.role === 'ADMIN' || r.csm_id === req.user.id;
  if (!isOwner) return res.status(403).json({ error: '仅提单人或管理员可跳过 AI 节点' });
  try {
    await engine.skipAiNode(+req.params.id, req.user.name);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// 与 AI 继续对话（就着需求上下文 + 最近 AI 产物追问，不落产物、不推进流程）。
// 权限：任何参与该需求的人（ADMIN / 提单人 / 当前节点负责人）。
// 回答落库到 req_ai_chats（追问历史），前端可回看完整会话。
router.post('/requirements/:id/ai-chat', auth, async (req, res) => {
  const r = await engine.getReq(+req.params.id);
  if (!r) return res.status(404).json({ error: '需求不存在' });
  const isOwner = req.user.role === 'ADMIN' || r.csm_id === req.user.id
    || r.po_id === req.user.id || r.rd_id === req.user.id || r.fe_id === req.user.id || r.qa_id === req.user.id;
  if (!isOwner) return res.status(403).json({ error: '仅需求参与人可对话' });
  try {
    const { message, artifact_kind, scopes, images } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: '请输入问题' });
    // scopes：用户勾选的代码范围 ['frontend'|'backend']（空/全选 = 全部仓库）
    // images：随消息上传的截图 URL 列表（也可直接写在 message 的 markdown 里，后端会一并识别）
    const scopeList = Array.isArray(scopes) ? scopes.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
    const imageList = Array.isArray(images) ? images.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
    const result = await aiChat(r, String(message).trim(), artifact_kind || null, { scopes: scopeList, images: imageList });
    const ins = await db.execute(
      `INSERT INTO req_ai_chats(requirement_id, artifact_kind, question, reply, image_urls, model, provider_type, created_by)
        VALUES(?,?,?,?,?,?,?,?)`,
      [
        r.id,
        artifact_kind || null,
        String(message).trim(),
        result.reply,
        imageList.length ? JSON.stringify(imageList) : null,
        result.model,
        result.provider_type,
        req.user.name
      ]
    );
    res.json({ ok: true, chat_id: ins.lastInsertRowid, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// 需求 AI 追问历史（正序 = 完整会话）：参与人可回看
router.get('/requirements/:id/ai-chats', auth, async (req, res) => {
  const r = await engine.getReq(+req.params.id);
  if (!r) return res.status(404).json({ error: '需求不存在' });
  const rows = await db.many(
    'SELECT id, artifact_kind, question, reply, image_urls, model, provider_type, created_by, created_at FROM req_ai_chats WHERE requirement_id=? ORDER BY id',
    [r.id]
  );
  res.json(rows);
});
// AI 按产品意图生成/修改 PRD（产品手动触发）：只返回正文，由产品在编辑器里确认修改后
// 走既有产物接口保存为新版本 —— 避免未经产品确认的 AI 文本直接覆盖 PRD。
router.post('/requirements/:id/prd-generate', auth, async (req, res) => {
  try {
    const r = await engine.getReq(+req.params.id);
    if (!r) return res.status(404).json({ error: '需求不存在' });
    const u = req.user;
    if (!(u.role === 'ADMIN' || (u.role === 'PO' && r.po_id === u.id))) {
      return res.status(403).json({ error: '仅该需求的产品负责人或管理员可让 AI 生成 PRD' });
    }
    const intent = String(req.body?.intent || '').trim();
    if (!intent) return res.status(400).json({ error: '请填写产品意图（希望 AI 生成/修改什么）' });
    const imageList = Array.isArray(req.body?.images)
      ? req.body.images.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      : [];
    const result = await generatePrd(r, intent, imageList);
    await engine.addTimeline(r.id, 'AI_PRD_GEN', u.name,
      `产品使用 AI 生成 PRD（意图：${intent.slice(0, 200)}${imageList.length ? `；截图 ${imageList.length} 张` : ''}）`);
    logger.info('prd_ai_generated', { requirement_id: r.id, user_id: u.id, model: result.model, images: imageList.length });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message || 'AI 生成 PRD 失败' }); }
});
/* ---------- 管理员批量删除需求（事务 + 先清关联表） ---------- */
router.post('/admin/requirements/batch-delete', auth, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: '仅管理员可批量删除' });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((n) => Number.isInteger(n) && n > 0) : [];
  if (ids.length === 0) return res.status(400).json({ error: '请提供 ids 数组' });
  if (ids.length > 500) return res.status(400).json({ error: '一次最多 500 条' });
  const placeholders = ids.map(() => '?').join(',');
  try {
    const deleted = await db.transaction(async (tx) => {
      // 1) 先清无 ON DELETE CASCADE 的关联表
      await tx.execute(
        `DELETE FROM clarifies WHERE requirement_id IN (${placeholders})`,
        [...ids]
      );
      await tx.execute(
        `DELETE FROM artifacts WHERE requirement_id IN (${placeholders})`,
        [...ids]
      );
      await tx.execute(`DELETE FROM timeline WHERE requirement_id IN (${placeholders})`, [...ids]);
      await tx.execute(
        `DELETE FROM notifications WHERE requirement_id IN (${placeholders})`,
        [...ids]
      );
      await tx.execute(
        `DELETE FROM req_ai_chats WHERE requirement_id IN (${placeholders})`,
        [...ids]
      );
      await tx.execute(
        `DELETE FROM rd_submissions WHERE requirement_id IN (${placeholders})`,
        [...ids]
      );
      await tx.execute(
        `DELETE FROM requirement_business_modules WHERE requirement_id IN (${placeholders})`,
        [...ids]
      );
      // 2) 删 requirements（ai_tasks / board_ai_cache 已 ON DELETE CASCADE 自动级联）
      const info = await tx.execute(`DELETE FROM requirements WHERE id IN (${placeholders})`, [...ids]);
      return info.changes;
    });
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || String(e) });
  }
});

router.post('/requirements/:id/cancel', auth, requireNodeOwner('cancel'), async (req, res) => {
  // closed_at 传 Date 对象，见 engine.advance 注释（toISOString 的 Z 格式会被 MySQL 严格模式拒绝）
  await engine.touchReq(+req.params.id, { status: 'CANCELLED', current_seq: -1, closed_at: new Date() });
  await engine.addTimeline(+req.params.id, 'CANCEL', req.user.name, req.body?.reason || '取消需求');
  res.json({ ok: true });
});

/* ---------- 澄清 ---------- */
// 应答人 = 提单人 + ADMIN，判定与理由见 authz.requireClarifyOwner 的注释
router.post('/clarifies/:id/answer', auth, requireClarifyOwner(), async (req, res) => {
  try { await engine.answerClarify(+req.params.id, req.body?.answer || '', req.user.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- 产物 ---------- */
router.get('/requirements/:id/artifacts', auth, async (req, res) => {
  res.json(await db.many(
    'SELECT * FROM artifacts WHERE requirement_id=? ORDER BY kind, version DESC',
    [req.params.id]
  ));
});
router.post('/requirements/:id/artifacts', auth, requireTestCaseOwner(), async (req, res, next) => {
  const { kind, content, meta } = req.body || {};
  if (!kind || !content) return res.status(400).json({ error: 'kind/content 必填' });
  // MySQL 的类型比较不区分大小写，限制为规范标识，避免通过大小写/空白变体绕过 TEST_CASE 鉴权。
  if (typeof kind !== 'string' || /[^A-Z_]/.test(kind)) {
    logger.warn('artifact_kind_invalid', { requirement_id: req.params.id, user_id: req.user.id });
    return res.status(400).json({ error: '产物类型必须使用大写字母和下划线' });
  }
  try {
    const v = await engine.saveArtifact(+req.params.id, null, kind, content, req.user.name, meta ? JSON.stringify(meta) : null);
    await engine.addTimeline(+req.params.id, 'ARTIFACT_SAVE', req.user.name, `保存 ${kind} v${v}`);
    logger.info('artifact_saved', { requirement_id: +req.params.id, user_id: req.user.id, kind, version: v });
    res.json({ ok: true, version: v });
  } catch (error) {
    logger.error('artifact_save_failed', { requirement_id: req.params.id, user_id: req.user.id, kind, reason: error.message });
    next(error);
  }
});
router.get('/requirements/:id/timeline', auth, async (req, res) => {
  res.json(await db.many(
    'SELECT * FROM timeline WHERE requirement_id=? ORDER BY id',
    [req.params.id]
  ));
});

/* ---------- 通知 ---------- */
router.get('/notifications', auth, async (req, res) => {
  res.json(await db.many(
    'SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50',
    [req.user.id]
  ));
});
router.post('/notifications/read-all', auth, async (req, res) => {
  await db.execute('UPDATE notifications SET read_flag=1 WHERE user_id=?', [req.user.id]);
  res.json({ ok: true });
});

/* ---------- 主题设置 ---------- */
router.get('/settings/theme', auth, async (req, res) => {
  res.json({
    primary: await getSetting('theme.primary', '#0E62A8'),
    mode: await getSetting('theme.mode', 'light'),
  });
});
router.put('/settings/theme', auth, adminOnly, async (req, res) => {
  const { primary, mode } = req.body || {};
  if (primary) await setSetting('theme.primary', primary);
  if (mode) await setSetting('theme.mode', mode);
  res.json({ ok: true });
});

/* ---------- 新增端点（Envelope 包络，见 api/） ---------- */
router.use(codeContextApi);
// P0 改造：产品指派研发/测试 + 需求聊天工作室（见 api/requirement-actions.js）
router.use(requirementActions);
// 图片上传（富文本编辑器粘贴图片，见 api/uploads.js）
router.use(uploadsApi);

// auth / adminOnly 现居 authn.js；此处保留再导出，避免改动 admin.js 等既有引用方
module.exports = { router, auth, adminOnly };


/* ---------- 看板 v2：角色视角 AI 总结 / 建议 ---------- */
async function boardAiText(req, role, kind) {
  const provider = await activeProvider();
  if (!provider || provider.type === 'mock') return null;
  const apiKey = provider.type !== 'mock' ? resolveApiKey(provider) : null;
  if (provider.type !== 'trae-cli' && !apiKey) return null;

  const isAdmin = req.user.role === 'ADMIN';
  const baseSelect = `SELECT r.id, r.req_no, r.title, r.status, r.priority, r.level, r.customer_name, r.target_version, r.current_seq, r.expect_date,
    uc.name AS csm_name, up.name AS po_name, ur.name AS rd_name, uf.name AS fe_name, uq.name AS qa_name, r.created_at, r.updated_at, r.closed_at
    FROM requirements r
    LEFT JOIN users uc ON uc.id = r.csm_id
    LEFT JOIN users up ON up.id = r.po_id
    LEFT JOIN users ur ON ur.id = r.rd_id
    LEFT JOIN users uf ON uf.id = r.fe_id
    LEFT JOIN users uq ON uq.id = r.qa_id`;
  const rows = isAdmin
    ? await db.many(baseSelect + ' ORDER BY r.updated_at DESC LIMIT 100', [])
    : await db.many(
    baseSelect + ' WHERE r.csm_id=? OR r.po_id=? OR r.rd_id=? OR r.fe_id=? OR r.qa_id=? ORDER BY r.updated_at DESC LIMIT 100',
    [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]
  );

  const rbm = await db.many(
    `SELECT rbm.requirement_id, bm.name AS business_module FROM requirement_business_modules rbm JOIN business_modules bm ON bm.id = rbm.business_module_id`,
    []
  );

  const PROMPTS = {
    CSM_SUMMARY: '你是 CSM（客户成功经理）。基于下方需求列表给出【客户视角】总结（≤300 字）。重点：哪些客户即将超期/已超期？哪些客户优先级需升级？哪些需求上线后客户反馈待跟进？',
    CSM_ADVICE:  '你是 CSM。给出【可执行建议】列表（≤500 字，3-6 条）。重点：哪些需求应优先催办？哪些客户需主动同步进度？',
    PO_SUMMARY:  '你是产品经理。给出【产品视角】总结（≤300 字）。重点：当前排期到目标版本的容量？工时饱和度？哪些需求待 PRD 完善？',
    PO_ADVICE:   '你是产品经理。给出【可执行建议】列表（≤500 字，3-6 条）。重点：哪些需求可合并/拆分？哪些版本排期需调整？',
    RD_SUMMARY:  '你是研发负责人。给出【研发视角】总结（≤300 字）。重点：哪些需求技术相似可合并实现？技术风险点？阻塞依赖？',
    RD_ADVICE:   '你是研发负责人。给出【可执行建议】列表（≤500 字，3-6 条）。重点：哪些需求可统一处理？哪些需提前评审？',
    QA_SUMMARY:  '你是测试负责人。给出【测试视角】总结（≤300 字）。重点：涉及哪些模块？影响范围？回归测试重点？',
    QA_ADVICE:   '你是测试负责人。给出【可执行建议】列表（≤500 字，3-6 条）。重点：测试点有哪些？哪些模块先测？',
    FE_SUMMARY:  '你是前端负责人。给出【前端视角】总结（≤300 字）。重点：哪些需求涉及前端改动？有哪些页面/交互/联调依赖？',
    FE_ADVICE:   '你是前端负责人。给出【可执行建议】列表（≤500 字，3-6 条）。重点：哪些需求可合并实现？前后端联调排期如何安排？',
    ADMIN_SUMMARY:'你是全局管理员。给出【平台全局视角】总结（≤300 字）。重点：各角色负载情况？哪些需求流转卡住？整体交付节奏？',
    ADMIN_ADVICE: '你是全局管理员。给出【可执行建议】列表（≤500 字，3-6 条）。重点：哪些需求需督办？哪些资源需协调？哪些流程需优化？',
  };
  const key = (role || '').toUpperCase() + '_' + (kind === 'advice' ? 'ADVICE' : 'SUMMARY');
  const sys = PROMPTS[key];
  if (!sys) return null;

  const list = rows.slice(0, 60).map((r, i) => {
    const mods = rbm.filter((m) => m.requirement_id === r.id).map((m) => m.business_module).join('/') || '-';
    void r.module_names;
    // 数据库驱动可能返回 Date/数字等非字符串类型，统一转换后再截取，避免建议接口因单条脏数据失败。
    const title = String(r.title || '').slice(0, 40);
    const createdAt = String(r.created_at || '').slice(0, 10);
    const updatedAt = String(r.updated_at || '').slice(0, 10);
    return (i + 1) + '. [' + r.req_no + '] ' + title + ' | 客户:' + (r.customer_name || '-') + ' | 优先级:' + (r.priority || '-') + ' | 等级:' + (r.level || '-') + ' | 状态:' + r.status + ' | 模块:' + mods + ' | 目标版本:' + (r.target_version || '-') + ' | 节点:' + r.current_seq + ' | CSM:' + (r.csm_name || '-') + ' | PO:' + (r.po_name || '-') + ' | RD:' + (r.rd_name || '-') + ' | FE:' + (r.fe_name || '-') + ' | QA:' + (r.qa_name || '-') + ' | 创建:' + createdAt + ' | 更新:' + updatedAt;
  }).join('\n');
  const prompt = [
    sys,
    '\n【需求列表（最多 60 条）】\n' + list,
    '\n【输出要求】1) Markdown 文本；2) 数字+结论；3) 不超过字数限制；4) 不要输出"调用工具"或"代码"等元话语。',
  ].join('\n');

  const reqBody = {
    body: { messages: [{ role: 'user', content: prompt }] },
    trae_token: apiKey || '',
    provider_type: provider.type,
  };
  let data;
  try { data = await requestOnce(reqBody, 90000); } catch { return null; }
  let raw = data?.choices?.[0]?.message?.content || '';
  // 防御：traecli 在 agent 模式下可能返回整个会话状态 JSON；此时 choices[0].content 可能是空串或被解析为原始 dump
  // 若 content 是空串（新提取逻辑返回的 _parse_failed 标志），直接返回 null 走兜底文案
  if (!raw || data?._parse_failed) return null;
  // 若 content 以 { 开头且含内部字段（session_id / agent_states），视为内部泄漏，丢弃并返回 null
  if (typeof raw === 'string' && /^\s*\{/.test(raw) && /"(session_id|agent_states|tool_call|tool_result)"/.test(raw.slice(0, 2000))) {
    logger.warn('board_ai_internal_dump_detected', { role, kind, len: raw.length });
    return null;
  }
  raw = raw.replace(/^```(markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (raw.length < 20) return null;
  // 写缓存：按 user+role+kind 落表（每次新分析覆盖；前端展示时取最新一条）
  try {
    await db.execute(
      'INSERT INTO board_ai_cache(user_id, role, kind, text, model) VALUES(?,?,?,?,?)',
      [
        req.user.id,
        role,
        kind === 'advice' ? 'advice' : 'summary',
        raw,
        data?.model || provider.model || null
      ]
    );
  } catch (e) { logger.warn('board_ai_cache_write_failed', { role, kind, err: String(e.message || e).slice(0, 120) }); }
  return { text: raw, model: data?.model || provider.model, count: rows.length };
}

router.get('/board/ai-summary', auth, async (req, res) => {
  try {
    const role = String(req.query.role || req.user.role || 'RD').toUpperCase();
    const allowed = ['CSM', 'PO', 'RD', 'FE', 'QA', 'ADMIN'];
    if (!allowed.includes(role)) return res.status(400).json({ error: 'role 必须是 CSM/PO/RD/FE/QA/ADMIN' });
    if (req.user.role !== 'ADMIN' && role !== req.user.role) return res.status(403).json({ error: '仅可看自己角色视角' });
    const r = await boardAiText(req, role, 'summary');
    if (!r) return res.json({ text: 'AI 总结暂不可用，请稍后重试。', model: null, count: 0, fallback: true });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/board/ai-advice', auth, async (req, res) => {
  try {
    const role = String(req.query.role || req.user.role || 'RD').toUpperCase();
    const allowed = ['CSM', 'PO', 'RD', 'FE', 'QA', 'ADMIN'];
    if (!allowed.includes(role)) return res.status(400).json({ error: 'role 必须是 CSM/PO/RD/FE/QA/ADMIN' });
    if (req.user.role !== 'ADMIN' && role !== req.user.role) return res.status(403).json({ error: '仅可看自己角色视角' });
    const r = await boardAiText(req, role, 'advice');
    if (!r) return res.json({ text: 'AI 建议暂不可用，请稍后重试。', model: null, count: 0, fallback: true });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 拉取 user+role 的最新 AI 缓存（summary + advice 各自最新一条），进页面时直接展示
router.get('/board/ai-cache', auth, async (req, res) => {
  try {
    const role = String(req.query.role || req.user.role || 'RD').toUpperCase();
    const allowed = ['CSM', 'PO', 'RD', 'FE', 'QA', 'ADMIN'];
    if (!allowed.includes(role)) return res.status(400).json({ error: 'role 必须是 CSM/PO/RD/FE/QA/ADMIN' });
    if (req.user.role !== 'ADMIN' && role !== req.user.role) return res.status(403).json({ error: '仅可看自己角色视角' });
    const latest = async kind => await db.one(
      'SELECT text, model, created_at FROM board_ai_cache WHERE user_id=? AND role=? AND kind=? ORDER BY id DESC LIMIT 1',
      [req.user.id, role, kind]
    );
    res.json({ role, summary: (await latest('summary')) || null, advice: (await latest('advice')) || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 数据看板聚合：每日创建/完成/状态/优先级/模块 Top 10
router.get('/board/trends', auth, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(7, parseInt(String(req.query.days || 30), 10) || 30));
    const role = String(req.query.role || req.user.role || 'RD').toUpperCase();
    const isAdmin = req.user.role === 'ADMIN';
    // 统一只保存过滤表达式，避免在不同查询中重复拼接 WHERE。
    const scope = isAdmin ? '1=1' : '(csm_id=? OR po_id=? OR rd_id=? OR fe_id=? OR qa_id=?)';
    const args = isAdmin ? [] : [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id];
    // 日期必须 DATE_FORMAT 成字符串：mysql2 会把 DATE() 结果转成 JS Date 序列化成完整 ISO 时间戳，
    // 前端按 'YYYY-MM-DD' 建映射会整天 miss，趋势图恒为 0。窗口用范围过滤而非 LIMIT（LIMIT 语义是
    // "最近 N 个有数据的日期"，创建日期超过 N 个时窗口边缘会被截掉）。
    const daily = await db.many(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS d, COUNT(*) AS c FROM requirements WHERE ${scope}
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY d ORDER BY d`,
      [...args, days]
    );
    const daily_done = await db.many(
      `SELECT DATE_FORMAT(closed_at, '%Y-%m-%d') AS d, COUNT(*) AS c FROM requirements WHERE ${scope}
        AND closed_at IS NOT NULL AND closed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY d ORDER BY d`,
      [...(isAdmin ? [days] : [...args, days])]
    );
    const byStatus = await db.many(
      `SELECT status, COUNT(*) AS c FROM requirements WHERE ${scope} GROUP BY status ORDER BY c DESC`,
      [...args]
    );
    const byPriority = await db.many(
      `SELECT COALESCE(priority,'未标') AS p, COUNT(*) AS c FROM requirements WHERE ${scope} GROUP BY COALESCE(priority,'未标') ORDER BY c DESC`,
      [...args]
    );
    const byModule = await db.many(
      `SELECT bm.name AS name, COUNT(*) AS c FROM requirement_business_modules rbm
        JOIN business_modules bm ON bm.id = rbm.business_module_id
        JOIN requirements r ON r.id = rbm.requirement_id
        ${isAdmin ? '' : 'WHERE r.csm_id=? OR r.po_id=? OR r.rd_id=? OR r.fe_id=? OR r.qa_id=?'}
        GROUP BY bm.name ORDER BY c DESC LIMIT 10`,
      [...(isAdmin ? [] : args)]
    );
    // 待你处理：当前节点是 viewRole 的人工节点（与看板 todo 定义一致）
    // 前端（FE）与后端（RD）共用研发开发节点，故节点角色按 RD 匹配
    const nodeRole = role === 'FE' ? 'RD' : role;
    const todoCount = (await db.one(`SELECT COUNT(*) n FROM requirements r
      WHERE r.status='PENDING'
        AND (SELECT node_type FROM sop_nodes WHERE template_id=r.template_id AND seq=r.current_seq)='HUMAN'
        AND (SELECT role FROM sop_nodes WHERE template_id=r.template_id AND seq=r.current_seq)=?
        ${isAdmin ? '' : 'AND (r.csm_id=? OR r.po_id=? OR r.rd_id=? OR r.fe_id=? OR r.qa_id=?)'}`, [
      ...(isAdmin ? [nodeRole] : [nodeRole, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id])
    ])).n;
    // 进行中：创建但未完成（DONE/CANCELLED 之外）
    const activeCount = (await db.one(
      `SELECT COUNT(*) n FROM requirements r WHERE r.status NOT IN ('DONE','CANCELLED') AND ${isAdmin ? '1=1' : '(r.csm_id=? OR r.po_id=? OR r.rd_id=? OR r.fe_id=? OR r.qa_id=?)'}`,
      [...args]
    )).n;
    // 企业维度：涉及企业数 + Top10
    const customerCount = (await db.one(
      `SELECT COUNT(DISTINCT COALESCE(customer_name,'未填')) n FROM requirements r WHERE ${isAdmin ? '1=1' : '(r.csm_id=? OR r.po_id=? OR r.rd_id=? OR r.fe_id=? OR r.qa_id=?)'}`,
      [...args]
    )).n;
    const byCustomer = await db.many(
      `SELECT COALESCE(customer_name,'未填') AS name, COUNT(*) AS c FROM requirements r WHERE ${isAdmin ? '1=1' : '(r.csm_id=? OR r.po_id=? OR r.rd_id=? OR r.fe_id=? OR r.qa_id=?)'} GROUP BY COALESCE(customer_name,'未填') ORDER BY c DESC LIMIT 10`,
      [...args]
    );
    res.json({ days, role, daily, daily_done, byStatus, byPriority, byModule, todoCount, activeCount, customerCount, byCustomer });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
