// 状态机引擎：由 sop_nodes 表驱动。
// 进入某节点时：AI 节点自动执行 runAI 并落产物，可能需要澄清（挂起）或自动前进；
// HUMAN 节点等待对应角色操作（confirm / return / force）。

const { db } = require('./db');
const { runAI } = require('./ai');

const STATUS = {
  DRAFT: 'DRAFT',
  AI_RUNNING: 'AI_RUNNING',
  CLARIFYING: 'CLARIFYING',
  PENDING: 'PENDING',       // 等待人工节点处理
  DONE: 'DONE',
  CANCELLED: 'CANCELLED',
};

function getNodes(templateId) {
  return db.prepare('SELECT * FROM sop_nodes WHERE template_id=? ORDER BY seq').all(templateId);
}
function getNodeBySeq(templateId, seq) {
  return db.prepare('SELECT * FROM sop_nodes WHERE template_id=? AND seq=?').get(templateId, seq);
}
function getReq(id) {
  return db.prepare('SELECT * FROM requirements WHERE id=?').get(id);
}
function addTimeline(reqId, action, operator, detail = '', from = null, to = null) {
  db.prepare('INSERT INTO timeline(requirement_id,action,from_status,to_status,operator,detail) VALUES(?,?,?,?,?,?)')
    .run(reqId, action, from, to, operator, detail);
}
function notify(userId, title, content, reqId) {
  if (!userId) return;
  db.prepare('INSERT INTO notifications(user_id,title,content,requirement_id) VALUES(?,?,?,?)')
    .run(userId, title, content, reqId);
}
function saveArtifact(reqId, nodeId, kind, content, createdBy = 'AI', meta = null) {
  const last = db.prepare('SELECT MAX(version) v FROM artifacts WHERE requirement_id=? AND kind=?').get(reqId, kind);
  const version = (last?.v || 0) + 1;
  db.prepare('INSERT INTO artifacts(requirement_id,node_id,kind,version,content,meta,created_by) VALUES(?,?,?,?,?,?,?)')
    .run(reqId, nodeId, kind, version, typeof content === 'string' ? content : JSON.stringify(content, null, 2), meta, createdBy);
  return version;
}
function latestArtifact(reqId, kind) {
  return db.prepare('SELECT * FROM artifacts WHERE requirement_id=? AND kind=? ORDER BY version DESC LIMIT 1').get(reqId, kind);
}
function touchReq(id, fields) {
  const keys = Object.keys(fields);
  const sql = `UPDATE requirements SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=datetime('now','localtime') WHERE id=?`;
  db.prepare(sql).run(...keys.map((k) => fields[k]), id);
}

function assigneeForNode(req, node) {
  if (!node || node.node_type !== 'HUMAN') return null;
  return { CSM: req.csm_id, PO: req.po_id, RD: req.rd_id, QA: req.qa_id }[node.role] || null;
}

// 推进：从当前 seq 走到下一个节点并激活它
async function advance(reqId, operator = 'system') {
  const req = getReq(reqId);
  const nodes = getNodes(req.template_id);
  const idx = nodes.findIndex((n) => n.seq === req.current_seq);
  const next = nodes[idx + 1];
  if (!next) {
    touchReq(reqId, { status: STATUS.DONE, current_seq: 999, closed_at: new Date().toISOString() });
    addTimeline(reqId, 'DONE', operator, '流程走完，需求单关闭', req.status, STATUS.DONE);
    notify(req.csm_id, `需求已完成：${req.title}`, '全流程已走完', reqId);
    return;
  }
  touchReq(reqId, { current_seq: next.seq });
  addTimeline(reqId, 'ENTER_NODE', operator, `进入节点「${next.name}」`, null, null);
  await activateNode(reqId, next);
}

// 激活当前节点（AI 自动执行 / 人工等待）
// holdAI: 打回到 AI 节点时不自动执行，挂起等待人工确认（避免打回立即被弹回）
async function activateNode(reqId, node, { holdAI = false } = {}) {
  const req = getReq(reqId);
  if (node.node_type === 'AI' && !holdAI) {
    touchReq(reqId, { status: STATUS.AI_RUNNING });
    addTimeline(reqId, 'AI_START', 'AI', `节点「${node.name}」开始执行（${node.ai_action || 'CUSTOM'}）`);
    try {
      await runAiNode(reqId, node);
    } catch (e) {
      console.error('[engine] AI 节点执行失败', e);
      addTimeline(reqId, 'AI_FAIL', 'AI', `执行失败：${e.message}，可人工跳过`);
      // 降级：挂起在当前节点，等待人工 continue
      touchReq(reqId, { status: STATUS.PENDING });
    }
  } else {
    touchReq(reqId, { status: STATUS.PENDING });
    const uid = assigneeForNode(req, node);
    notify(uid, `待处理：${req.title}`, `需求已流转到你的节点「${node.name}」`, reqId);
  }
}

async function runAiNode(reqId, node) {
  const req = getReq(reqId);
  const action = node.ai_action || 'CUSTOM';
  const extra = {};
  if (action === 'PRD_GEN') {
    const ev = latestArtifact(reqId, 'EVALUATION');
    if (ev) extra.evaluation = safeParse(ev.content);
  }
  if (action === 'DEV_PROMPT') {
    const prd = latestArtifact(reqId, 'PRD');
    if (prd) extra.prd = prd.content;
  }
  if (node.ai_prompt) extra.custom_prompt = node.ai_prompt;
  const { content, model } = await runAI(action, req, extra);

  if (action === 'PRECHECK') {
    saveArtifact(reqId, node.id, 'NOTE', content, `AI(${model})`);
    if (!content.pass && content.questions?.length) {
      raiseClarifies(reqId, node, content.questions, '需求完整性预检未通过，请补充以下信息');
      return; // 挂起等澄清
    }
  } else if (action === 'EVALUATE') {
    saveArtifact(reqId, node.id, 'EVALUATION', content, `AI(${model})`);
    if (content.level) touchReq(reqId, { level: content.level });
    if (content.rationality?.verdict === 'NEED_CLARIFY' && content.clarify_questions?.length) {
      raiseClarifies(reqId, node, content.clarify_questions, 'AI 评估认为需求需要澄清');
      return;
    }
  } else if (action === 'PRD_GEN') {
    saveArtifact(reqId, node.id, 'PRD', content, `AI(${model})`);
  } else if (action === 'DEV_PROMPT') {
    saveArtifact(reqId, node.id, 'DEV_PROMPT', content, `AI(${model})`);
  } else if (action === 'TEST_CASE') {
    saveArtifact(reqId, node.id, 'TEST_CASE', content, `AI(${model})`);
  } else {
    saveArtifact(reqId, node.id, 'NOTE', content, `AI(${model})`);
  }
  addTimeline(reqId, 'AI_DONE', 'AI', `节点「${node.name}」执行完成`);
  await advance(reqId, 'AI');
}

function raiseClarifies(reqId, node, questions, reason) {
  const ins = db.prepare('INSERT INTO clarifies(requirement_id,node_id,asked_by,question) VALUES(?,?,?,?)');
  questions.forEach((q) => ins.run(reqId, node.id, 'AI', q));
  touchReq(reqId, { status: STATUS.CLARIFYING });
  addTimeline(reqId, 'CLARIFY', 'AI', `${reason}（${questions.length} 个问题）`);
  const req = getReq(reqId);
  notify(req.csm_id, `需求待澄清：${req.title}`, `AI 提出了 ${questions.length} 个问题`, reqId);
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/* ------------ 对外动作 ------------ */

// 提交需求（DRAFT -> 第一个节点）
async function submit(reqId, operator) {
  const req = getReq(reqId);
  const nodes = getNodes(req.template_id);
  if (!nodes.length) throw new Error('SOP 模板没有节点');
  const first = nodes[0];
  touchReq(reqId, { current_seq: first.seq, status: 'SUBMITTED' });
  addTimeline(reqId, 'SUBMIT', operator, '需求提交，进入流程', STATUS.DRAFT, 'SUBMITTED');
  await activateNode(reqId, first);
}

// 人工节点确认（或打回到 AI 节点后人工确认继续）
async function confirm(reqId, operator, note = '') {
  const req = getReq(reqId);
  const node = getNodeBySeq(req.template_id, req.current_seq);
  addTimeline(reqId, 'CONFIRM', operator, note || `确认节点「${node?.name}」`, req.status, null);
  if (node?.node_type === 'AI') {
    // 当前是被挂起的 AI 节点（打回/失败后）：人工确认 = 重新执行该 AI 节点
    await activateNode(reqId, node);
    return;
  }
  await advance(reqId, operator);
}

// 打回到上一个节点（必填原因）
async function sendBack(reqId, operator, reason) {
  if (!reason) throw new Error('打回必须填写原因');
  const req = getReq(reqId);
  const nodes = getNodes(req.template_id);
  const idx = nodes.findIndex((n) => n.seq === req.current_seq);
  if (idx <= 0) throw new Error('已在第一个节点，无法打回');
  const prev = nodes[idx - 1];
  touchReq(reqId, { current_seq: prev.seq });
  addTimeline(reqId, 'RETURN', operator, `打回到「${prev.name}」：${reason}`, req.status, null);
  const uid = assigneeForNode(req, prev);
  notify(uid || req.csm_id, `需求被打回：${req.title}`, reason, reqId);
  // 打回到 AI 节点：挂起，由提交人/管理员确认后继续（可改模板再 advance）
  await activateNode(reqId, prev, { holdAI: true });
}

// 强制提交（从 CLARIFYING 状态跳过未回答问题，继续走）
async function forceSubmit(reqId, operator, note = '') {
  const req = getReq(reqId);
  if (req.status !== STATUS.CLARIFYING) throw new Error('当前不在待澄清状态，无需强制提交');
  db.prepare("UPDATE clarifies SET status='FORCED' WHERE requirement_id=? AND status='OPEN'").run(reqId);
  addTimeline(reqId, 'FORCE_SUBMIT', operator, note || '未全部澄清，强制继续流程', req.status, null);
  await advance(reqId, operator);
}

// 回复澄清问题；全部回复完后自动重走当前 AI 节点
async function answerClarify(clarifyId, answer, operator) {
  const c = db.prepare('SELECT * FROM clarifies WHERE id=?').get(clarifyId);
  if (!c) throw new Error('澄清问题不存在');
  db.prepare("UPDATE clarifies SET answer=?, status='ANSWERED', answered_at=datetime('now','localtime') WHERE id=?")
    .run(answer, clarifyId);
  addTimeline(c.requirement_id, 'CLARIFY_ANSWER', operator, `回答问题 #${clarifyId}`);
  const open = db.prepare("SELECT COUNT(*) n FROM clarifies WHERE requirement_id=? AND status='OPEN'").get(c.requirement_id).n;
  if (open === 0) {
    const req = getReq(c.requirement_id);
    // 把澄清答案并入描述，重新激活当前节点（AI 重新评估）
    const answered = db.prepare("SELECT question,answer FROM clarifies WHERE requirement_id=? AND status='ANSWERED'").all(c.requirement_id);
    const extra = answered.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n');
    touchReq(c.requirement_id, { description: req.description + '\n\n【澄清补充】\n' + extra });
    addTimeline(c.requirement_id, 'CLARIFY_DONE', operator, '澄清完毕，重新执行当前节点');
    const node = getNodeBySeq(req.template_id, req.current_seq);
    await activateNode(c.requirement_id, node);
  }
}

module.exports = { STATUS, submit, confirm, sendBack, forceSubmit, answerClarify, advance, getNodes, getNodeBySeq, getReq, addTimeline, notify, saveArtifact, latestArtifact, touchReq };
