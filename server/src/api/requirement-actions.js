// P0 改造：产品指派研发/测试 + 需求聊天工作室。
// 1) POST /requirements/:id/assign          —— 产品(或 ADMIN)为需求指派 RD/QA
// 2) POST/GET /requirements/:id/messages    —— 参与人发消息 / 拉取聊天记录
// 3) POST /requirements/:id/messages/:msgId/answer —— 参与人回复某条聊天消息
//
// 聊天复用 clarifies 表（kind='CHAT'，status='CHAT' 初始 / ANSWERED 已回复），
// 与旧澄清（kind='CLARIFY'，status OPEN/ANSWERED/FORCED）互不干扰：
// CHAT 消息不参与 open_clarifies 计数、不触发 answerClarify 的描述合并与节点重跑。
// 独立成文件：保持 routes.js ≤ 300 行门禁；新端点统一走 Envelope 包络。

'use strict';

const express = require('express');
const { db } = require('../db');
const { auth } = require('../authn');
const engine = require('../engine');
const { ok, badRequest, forbidden, notFound } = require('../http/envelope');
const feishu = require('../feishu');
const jira = require('../jira');

const router = express.Router();

const TERMINAL = { DONE: '已完成', CANCELLED: '已取消' };

function parseId(v) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function loadReqOr(res, id) {
  const rid = parseId(id);
  if (!rid) return { err: badRequest(res, '需求 ID 不合法') };
  const r = await engine.getReq(rid);
  if (!r) return { err: notFound(res, `需求 #${id} 不存在`) };
  const terminal = TERMINAL[r.status];
  if (terminal) return { err: badRequest(res, `需求「${r.req_no}」${terminal}，不能再操作`) };
  return { req: r };
}

// 参与人 = 提单人(CSM) / 产品 / 研发 / 前端 / 测试 / 管理员；任一参与人可发消息与回复
function isParticipant(user, r) {
  if (user.role === 'ADMIN') return true;
  return [r.csm_id, r.po_id, r.rd_id, r.fe_id, r.qa_id].includes(user.id);
}

/* ---------- 产品 Jira 配置与一键创建 ---------- */
router.get('/users/me/jira-profile', auth, async (req, res) => {
  if (req.user.role !== 'PO') return forbidden(res, '仅产品可配置 Jira 账号');
  return ok(res, await jira.getProfile(req.user.id));
});

router.put('/users/me/jira-profile', auth, async (req, res) => {
  if (req.user.role !== 'PO') return forbidden(res, '仅产品可配置 Jira 账号');
  try { return ok(res, await jira.saveProfile(req.user.id, req.body || {})); }
  catch (e) { return badRequest(res, e.message); }
});

// 创建弹窗的只读元数据：可创建的问题类型 + 自动带入后仍需用户补填的必填字段。
// 前端据此渲染表单，避免提交后被 Jira 以 “is required / cannot be set” 整单拒绝。
router.get('/requirements/:id/jira-create-form', auth, async (req, res) => {
  const { req: r, err } = await loadReqOr(res, req.params.id);
  if (err) return err;
  if (req.user.role !== 'ADMIN' && r.po_id !== req.user.id) return forbidden(res, '仅该需求产品负责人或管理员可创建 Jira');
  const full = await db.one(`
    SELECT r.*, c.name csm_name, p.name po_name, d.name rd_name, f.name fe_name, q.name qa_name
    FROM requirements r
    LEFT JOIN users c ON c.id=r.csm_id LEFT JOIN users p ON p.id=r.po_id
    LEFT JOIN users d ON d.id=r.rd_id LEFT JOIN users f ON f.id=r.fe_id LEFT JOIN users q ON q.id=r.qa_id
    WHERE r.id=?`, [r.id]);
  try {
    return ok(res, await jira.getCreateForm(req.user.id, full, req.query?.project_key, req.query?.issue_type));
  } catch (e) { return badRequest(res, e.message); }
});

// 创建弹窗里「问题选择器」字段（如客户名称）的候选检索：只读，供产品按关键字挑单号。
router.get('/jira/issue-search', auth, async (req, res) => {
  if (req.user.role !== 'PO' && req.user.role !== 'ADMIN') return forbidden(res, '仅产品或管理员可检索 Jira 单号');
  try {
    return ok(res, await jira.searchIssues(req.user.id, req.query?.q, req.query?.field_id));
  }
  catch (e) { return badRequest(res, e.message); }
});

router.post('/requirements/:id/jira', auth, async (req, res) => {
  const { req: r, err } = await loadReqOr(res, req.params.id);
  if (err) return err;
  if (req.user.role !== 'ADMIN' && r.po_id !== req.user.id) return forbidden(res, '仅该需求产品负责人或管理员可创建 Jira');
  const full = await db.one(`
    SELECT r.*, c.name csm_name, p.name po_name, d.name rd_name, f.name fe_name, q.name qa_name
    FROM requirements r
    LEFT JOIN users c ON c.id=r.csm_id LEFT JOIN users p ON p.id=r.po_id
    LEFT JOIN users d ON d.id=r.rd_id LEFT JOIN users f ON f.id=r.fe_id LEFT JOIN users q ON q.id=r.qa_id
    WHERE r.id=?`, [r.id]);
  const prd = await engine.latestArtifact(r.id, 'PRD');
  try {
    const result = await jira.createIssue(full, req.user.id, {
      summary: req.body?.summary,
      project_key: req.body?.project_key,
      issue_type: req.body?.issue_type,
      // 弹窗补填的必填字段（fieldId → 原始值）必须透传，否则必填字段缺失会被 Jira 拒绝。
      fields: req.body?.fields,
      description: prd?.content || full.description,
    });
    await engine.touchReq(r.id, { jira_url: result.url });
    await engine.addTimeline(r.id, 'JIRA_CREATE', req.user.name, `创建 Jira ${result.key} 并回写链接`);
    return ok(res, result);
  } catch (e) { return badRequest(res, e.message); }
});

/* ---------- 产品指派研发/测试 ---------- */
router.post('/requirements/:id/assign', auth, async (req, res) => {
  const { req: r, err } = await loadReqOr(res, req.params.id);
  if (err) return err;
  if (req.user.role !== 'ADMIN' && r.po_id !== req.user.id) {
    return forbidden(res, `需求「${r.req_no}」的研发/测试仅产品（${r.po_id ? '负责人' : '未指派'}）或管理员可指派`);  }
  const body = req.body || {};
  if (body.rd_id === undefined && body.fe_id === undefined && body.qa_id === undefined && body.jira_url === undefined) {
    return badRequest(res, '请至少指定 rd_id / fe_id / qa_id / jira_url 之一（可传 null 取消指派）');
  }
  const fields = {};
  if (body.rd_id !== undefined) {
    const rid = body.rd_id ? parseId(String(body.rd_id)) : null;
    if (body.rd_id !== null && !rid) return badRequest(res, 'rd_id 必须是正整数或 null');
    if (rid) {
      const u = await db.one('SELECT id,role,name FROM users WHERE id=?', [rid]);
      if (!u) return badRequest(res, `研发用户 #${rid} 不存在`);
      if (u.role !== 'RD') return badRequest(res, `用户「${u.name}」角色为 ${u.role}，不是研发(RD)，不能指派为研发负责人`);
    }
    fields.rd_id = rid;
  }
  if (body.fe_id !== undefined) {
    const fid = body.fe_id ? parseId(String(body.fe_id)) : null;
    if (body.fe_id !== null && !fid) return badRequest(res, 'fe_id 必须是正整数或 null');
    if (fid) {
      const u = await db.one('SELECT id,role,name FROM users WHERE id=?', [fid]);
      if (!u) return badRequest(res, `前端用户 #${fid} 不存在`);
      if (u.role !== 'FE') return badRequest(res, `用户「${u.name}」角色为 ${u.role}，不是前端(FE)，不能指派为前端负责人`);
    }
    fields.fe_id = fid;
  }
  if (body.qa_id !== undefined) {
    const qid = body.qa_id ? parseId(String(body.qa_id)) : null;
    if (body.qa_id !== null && !qid) return badRequest(res, 'qa_id 必须是正整数或 null');
    if (qid) {
      const u = await db.one('SELECT id,role,name FROM users WHERE id=?', [qid]);
      if (!u) return badRequest(res, `测试用户 #${qid} 不存在`);
      if (u.role !== 'QA') return badRequest(res, `用户「${u.name}」角色为 ${u.role}，不是测试(QA)，不能指派为测试负责人`);
    }
    fields.qa_id = qid;
  }
  // Jira 支持完整链接或单号（如 PINGTAI-11952）；单号便于产品在尚未拿到链接时先完成指派。
  if (body.jira_url !== undefined) {
    const j = body.jira_url == null ? null : String(body.jira_url).trim();
    const isUrl = /^https?:\/\//i.test(j);
    const isIssueKey = /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(j);
    if (j && !isUrl && !isIssueKey) return badRequest(res, 'Jira 请填写完整链接或单号（如 PINGTAI-11952）');
    if (j && j.length > 500) return badRequest(res, 'jira_url 长度不能超过 500 字符');
    fields.jira_url = j || null;
  }
  await engine.touchReq(r.id, fields);
  const detail = ['rd_id', 'fe_id', 'qa_id'].filter((k) => fields[k] !== undefined)
    .map((k) => `${k}=${fields[k] ?? 'null'}`).join(', ');
  const jiraNote = fields.jira_url !== undefined ? `Jira=${fields.jira_url || '已清空'}` : '';
  const summary = [detail, jiraNote].filter(Boolean).join('；') || '无变更';
  await engine.addTimeline(r.id, 'ASSIGN', req.user.name, `指派研发/前端/测试与 Jira：${summary}`);
  return ok(res, { rd_id: fields.rd_id ?? r.rd_id, fe_id: fields.fe_id ?? r.fe_id, qa_id: fields.qa_id ?? r.qa_id, jira_url: fields.jira_url !== undefined ? fields.jira_url : r.jira_url });
});

/* ---------- 需求聊天：发消息 ---------- */
router.post('/requirements/:id/messages', auth, async (req, res) => {
  const { req: r, err } = await loadReqOr(res, req.params.id);
  if (err) return err;
  if (!isParticipant(req.user, r)) {
    return forbidden(res, '仅需求参与人（CSM/产品/研发/测试/管理员）可发送消息');
  }
  const text = String(req.body?.text || '').trim();
  if (!text) return badRequest(res, '消息内容不能为空');
  if (text.length > 2000) return badRequest(res, '消息过长（上限 2000 字符）');
  const node = await engine.getNodeBySeq(r.template_id, r.current_seq);
  const result = await db.execute("INSERT INTO clarifies(requirement_id,node_id,asked_by,question,status,kind) VALUES(?,?,?,?,'CHAT','CHAT')",
    [r.id, node ? node.id : null, req.user.name, text]);
  const row = await db.one('SELECT * FROM clarifies WHERE id=?', [result.lastInsertRowid]);
  await engine.addTimeline(r.id, 'CHAT_SEND', req.user.name, `发送消息：${text.slice(0, 80)}`);
  // 飞书推送：给其他需求参与人（CSM/PO/RD/FE/QA/ADMIN）逐个发 IM，绑定飞书的就收得到
  const others = [r.csm_id, r.po_id, r.rd_id, r.fe_id, r.qa_id].filter((uid) => uid && uid !== req.user.id);
  const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
  for (const uid of others) {
    feishu.sendFeishuToUser(uid, 'CHAT_MSG', { req_no: r.req_no, title: r.title, who: req.user.name, preview },
      `${req.user.name} 在 ${r.req_no} 发了消息`, preview).catch(() => {});
  }
  return ok(res, row);
});

/* ---------- 需求聊天：拉取记录（含旧澄清，前端按 kind 区分） ---------- */
router.get('/requirements/:id/messages', auth, async (req, res) => {
  const { req: r, err } = await loadReqOr(res, req.params.id);
  if (err) return err;
  const rows = await db.many(
    'SELECT * FROM clarifies WHERE requirement_id=? ORDER BY created_at ASC, id ASC',
    [r.id]
  );
  return ok(res, rows);
});

/* ---------- 需求聊天：回复某条消息 ---------- */
router.post('/requirements/:id/messages/:msgId/answer', auth, async (req, res) => {
  const { req: r, err } = await loadReqOr(res, req.params.id);
  if (err) return err;
  const msgId = parseId(req.params.msgId);
  if (!msgId) return badRequest(res, '消息 ID 不合法');
  const msg = await db.one(
    'SELECT * FROM clarifies WHERE id=? AND requirement_id=? AND kind=?',
    [msgId, r.id, 'CHAT']
  );
  if (!msg) return notFound(res, `消息 #${msgId} 不存在`);
  if (msg.status === 'ANSWERED') return badRequest(res, '该消息已回复，不能重复回复');
  if (!isParticipant(req.user, r)) {
    return forbidden(res, '仅需求参与人（CSM/产品/研发/测试/管理员）可回复');
  }
  const answer = String(req.body?.answer ?? req.body?.text ?? '').trim();
  if (!answer) return badRequest(res, '回复内容不能为空');
  if (answer.length > 2000) return badRequest(res, '回复过长（上限 2000 字符）');
  await db.execute(
    "UPDATE clarifies SET answer=?, status='ANSWERED', answered_at=NOW() WHERE id=?",
    [answer, msgId]
  );
  await engine.addTimeline(r.id, 'CHAT_ANSWER', req.user.name, `回复消息 #${msgId}`);
  return ok(res, await db.one('SELECT * FROM clarifies WHERE id=?', [msgId]));
});

module.exports = router;
