// 状态机引擎：由 sop_nodes 表驱动。
// 进入某节点时：AI 节点自动执行 runAI 并落产物，可能需要澄清（挂起）或自动前进；
// HUMAN 节点等待对应角色操作（confirm / return / force）。

const { db } = require('./db');
const { runAI } = require('./ai');
const aiTask = require('./services/ai-task');
const feishu = require('./feishu');

const STATUS = {
  DRAFT: 'DRAFT',
  AI_RUNNING: 'AI_RUNNING',
  CLARIFYING: 'CLARIFYING',
  PENDING: 'PENDING',       // 等待人工节点处理
  AI_FAILED: 'AI_FAILED',   // AI 节点执行失败，等待提单人/管理员确认重跑
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
// event/ctx 可选：event 存在时飞书发富文本卡片；缺失时回退旧 text 消息（title/content），保证兼容不崩。
function notify(userId, title, content, reqId, event, ctx) {
  if (!userId) return;
  db.prepare('INSERT INTO notifications(user_id,title,content,requirement_id) VALUES(?,?,?,?)')
    .run(userId, title, content, reqId);
  // 飞书为增量渠道：站内通知是主渠道。sendFeishuToUser 内部已吞错，
  // 这里再 .catch 兜底，保证 fire-and-forget 绝不阻塞 notify 返回。
  feishu.sendFeishuToUser(userId, event, ctx, title, content).catch(() => {});
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
// 防御：若当前已 DONE 或 current_seq 与期望不符（并发 AI 完成时已被其他推进者走过），直接返回，避免跳步/回跳。
async function advance(reqId, operator = 'system', expectedSeq = null) {
  const req = getReq(reqId);
  if (!req) return;
  if (req.status === STATUS.DONE) return;
  // 如果调用方指定期望 seq（AI 节点完成后），必须 current_seq 仍然是自己才推进，防止并发多次 advance 串联
  if (expectedSeq != null && req.current_seq !== expectedSeq) {
    addTimeline(reqId, 'ADVANCE_SKIP', operator,
      `跳过推进：当前 seq=${req.current_seq}，期望 seq=${expectedSeq}（可能被其他进程已推进）`);
    return;
  }
  const nodes = getNodes(req.template_id);
  const idx = nodes.findIndex((n) => n.seq === req.current_seq);
  if (idx < 0) return; // seq 不在模板里（异常），不动
  const next = nodes[idx + 1];
  if (!next) {
    touchReq(reqId, { status: STATUS.DONE, current_seq: 999, closed_at: new Date().toISOString() });
    addTimeline(reqId, 'DONE', operator, '流程走完，需求单关闭', req.status, STATUS.DONE);
    notify(req.csm_id, `需求已完成：${req.title}`, '全流程已走完', reqId, 'DONE', { req });
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
    // 防御：已经在 AI_RUNNING/CLARIFYING 中，不要重复触发（并发 AI 执行会导致多轮 advance 串联跳步）
    if (req.status === STATUS.AI_RUNNING || req.status === STATUS.CLARIFYING) {
      addTimeline(reqId, 'AI_SKIP_DUP', 'AI', `节点「${node.name}」已在执行中，跳过重复触发`);
      return;
    }
    touchReq(reqId, { status: STATUS.AI_RUNNING });
    addTimeline(reqId, 'AI_START', 'AI', `节点「${node.name}」开始执行（${node.ai_action || 'CUSTOM'}）`);
    try {
      await runAiNode(reqId, node);
    } catch (e) {
      console.error('[engine] AI 节点执行失败', e);
      addTimeline(reqId, 'AI_FAIL', 'AI', `执行失败：${e.message}，可人工跳过`);
      // B2：节点级失败同样入库，否则"AI 跑挂了"这一类最需要审计的事件反而查不到
      aiTask.recordAiTask({
        requirementId: reqId, nodeId: node.id, action: node.ai_action || 'CUSTOM',
        meta: { status: aiTask.STATUS.FAILED, degraded_reason: `node_error:${String(e.message).slice(0, 120)}` },
      });
      // 降级：挂起在当前节点，标记 AI_FAILED（区别于正常 PENDING 等待人工），等待人工 confirm 重跑
      touchReq(reqId, { status: STATUS.AI_FAILED });
    }
  } else {
    touchReq(reqId, { status: STATUS.PENDING });
    const uid = assigneeForNode(req, node);
    notify(uid, `待处理：${req.title}`, `需求已流转到你的节点「${node.name}」`, reqId,
      'NODE_ARRIVED', { req, node, role: node.role });
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
  const { content, model, meta } = await runAI(action, req, extra);

  // B2：本次调用的 provider/级别/降级原因入库（可查询、可审计），并把同一份 meta 挂到产物上，
  // 前端据此渲染模型名、代码依据（AC-09）与 mock 警示条（AC-10）。
  aiTask.recordAiTask({ requirementId: reqId, nodeId: node.id, action, meta });
  const metaJson = aiTask.buildArtifactMeta(meta);
  // AC-09：产物署名要能看出"哪个模型出的"——llm-call 返回的 model 只是 llm/fallback 粗标签，
  // 真实模型名在 meta.model 里。
  // AC-10：但 mock 分支的 meta.model 仍是"配置里那个模型名"（如 deepseek-chat），
  // 直接用它会把假数据署成真模型的名字。所以必须先看 is_mock，mock 一律署 AI(mock)。
  const by = meta && meta.is_mock ? 'AI(mock)' : `AI(${(meta && meta.model) || model})`;

  if (action === 'PRECHECK') {
    saveArtifact(reqId, node.id, 'NOTE', content, by, metaJson);
    if (!content.pass && content.questions?.length) {
      raiseClarifies(reqId, node, content.questions, '需求完整性预检未通过，请补充以下信息');
      return; // 挂起等澄清
    }
  } else if (action === 'EVALUATE') {
    saveArtifact(reqId, node.id, 'EVALUATION', content, by, metaJson);
    if (content.level) touchReq(reqId, { level: content.level });
    // P0 改造：AI 评估不再向 CSM 提问阻塞流程。NEEDS_ATTENTION = 有风险但继续走，
    // 只把注意事项写进产物（content 已整体落库）并记 AI_ATTENTION 提醒，不 raiseClarifies。
    if (content.rationality?.verdict === 'NEEDS_ATTENTION') {
      const pts = Array.isArray(content.attention_points) ? content.attention_points : [];
      addTimeline(reqId, 'AI_ATTENTION', 'AI',
        `AI 评估提出 ${pts.length} 条注意事项：${pts.join('；') || '（无具体事项）'}`);
    }
  } else if (action === 'PRD_GEN') {
    saveArtifact(reqId, node.id, 'PRD', content, by, metaJson);
  } else if (action === 'DEV_PROMPT') {
    saveArtifact(reqId, node.id, 'DEV_PROMPT', content, by, metaJson);
  } else if (action === 'TEST_CASE') {
    saveArtifact(reqId, node.id, 'TEST_CASE', content, by, metaJson);
  } else {
    saveArtifact(reqId, node.id, 'NOTE', content, by, metaJson);
  }
  addTimeline(reqId, 'AI_DONE', 'AI', `节点「${node.name}」执行完成`);
  // 方案 B：AI 产物是兜底（is_mock=true 即"AI 未真评估"）时不自动推进 —— 挂起等人工三选：
  //   1) 重新执行 2) 跳过继续 3) 人工补产物。只有真产物（is_mock=false）才自动流转。
  if (meta && meta.is_mock) {
    addTimeline(reqId, 'AI_DEGRADED', 'AI', `节点「${node.name}」产物为兜底（未真评估），已挂起等待处理：可重新执行 / 跳过继续 / 人工补产物`);
    touchReq(reqId, { status: STATUS.PENDING });
    const req = getReq(reqId);
    notify(req.csm_id, `AI 评估未产出：${req.title}`, `节点「${node.name}」AI 未返回真实评估（兜底产物），请处理：重新执行 / 跳过 / 补产物`, reqId, 'AI_DEGRADED', { req, node });
    return;
  }
  // 传 expectedSeq=node.seq：只有当 current_seq 仍是本 AI 节点时才推进，防止并发多次 AI 完成后连续跳步
  await advance(reqId, 'AI', node.seq);
}

// 方案 B：跳过当前 AI 节点（兜底产物时人工选择"继续走"），直接进入下一节点
async function skipAiNode(reqId, operator) {
  const req = getReq(reqId);
  const node = getNodeBySeq(req.template_id, req.current_seq);
  if (!node || node.node_type !== 'AI') throw new Error('仅挂起的 AI 节点可跳过');
  addTimeline(reqId, 'AI_SKIP', operator, `跳过 AI 节点「${node.name}」（产物为兜底，人工确认继续）`);
  await advance(reqId, operator);
}

function raiseClarifies(reqId, node, questions, reason) {
  const ins = db.prepare('INSERT INTO clarifies(requirement_id,node_id,asked_by,question) VALUES(?,?,?,?)');
  questions.forEach((q) => ins.run(reqId, node.id, 'AI', q));
  touchReq(reqId, { status: STATUS.CLARIFYING });
  addTimeline(reqId, 'CLARIFY', 'AI', `${reason}（${questions.length} 个问题）`);
  const req = getReq(reqId);
  notify(req.csm_id, `需求待澄清：${req.title}`, `AI 提出了 ${questions.length} 个问题`, reqId,
    'CLARIFY', { req, questions });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/* ------------ 对外动作 ------------ */

// 提交需求（DRAFT -> 第一个节点）
// P0 修复：跳过冗余的「CSM 提交需求」人工节点，直接进入第一个真正的流程节点，
// 避免 CSM 自己看到"该你处理了：CSM 提交需求"的待办提示。
async function submit(reqId, operator) {
  const req = getReq(reqId);
  const nodes = getNodes(req.template_id);
  if (!nodes.length) throw new Error('SOP 模板没有节点');
  const first = nodes[0];
  // 冗余 CSM 提交节点判定：HUMAN +（角色 CSM 或 名称含「CSM 提交」）
  const redundantCsmSubmit =
    first.node_type === 'HUMAN' &&
    (first.role === 'CSM' || (first.name && first.name.includes('CSM 提交')));
  // 跳过该节点：从 nodes[1] 起找第一个真正的入口节点；仅一个节点时兜底激活 first。
  const startNode = redundantCsmSubmit && nodes.length > 1 ? nodes[1] : first;
  // current_seq 直接跳到 startNode.seq：不留 seq=1 的中间值，避免前端残留错误待办态
  touchReq(reqId, { current_seq: startNode.seq, status: 'SUBMITTED' });
  addTimeline(reqId, 'SUBMIT', operator, '需求提交，进入流程', STATUS.DRAFT, 'SUBMITTED');
  if (startNode !== first) {
    addTimeline(reqId, 'SUBMIT_SKIP', operator,
      `CSM 提交后跳过【${first.name}】，直接进入【${startNode.name}】`);
  }
  // 启动起始节点（AI 节点会后台跑 LLM；人工节点立即写 PENDING 状态并通知）。
  // fire-and-forget：返回前不等 LLM 完成，避免 60s+ 阻塞导致 CSM 重复点击。
  activateNode(reqId, startNode).catch((e) => console.error("[engine] bg_activate_node_failed", reqId, e.message));
}

// 重新跑当前 AI 节点：删该节点已有产物、记时间线、后台激活节点（fire-and-forget）。
// 用途：AI 评估/PRD/提示词不准时，CSM 或 ADMIN 主动重跑当前节点——不等用户走完整流程。
// 仅 AI 节点可重跑（人工节点没"重跑"语义），非 AI 节点报 400。
function reevaluate(reqId, operator, targetSeq = null) {
  const req = getReq(reqId);
  if (!req) throw new Error('需求不存在');

  // 选节点：传了 targetSeq 用指定 seq；否则：
  // 1) 当前节点是 AI → 重跑当前
  // 2) 当前是人工 → 找最近一个 AI 节点（产品场景：AI 评估已过但结果不准，要回炉重跑）
  let node;
  if (targetSeq != null) {
    node = getNodeBySeq(req.template_id, targetSeq);
    if (!node) throw new Error(`seq=${targetSeq} 节点不存在`);
  } else {
    const cur = getNodeBySeq(req.template_id, req.current_seq);
    if (cur && cur.node_type === 'AI') {
      node = cur;
    } else {
      // 找最近一个 AI 节点（按 seq 降序）
      const allNodes = getNodes(req.template_id);
      const lastAI = [...allNodes].reverse().find((n) => n.node_type === 'AI');
      if (!lastAI) throw new Error('模板里没有任何 AI 节点');
      node = lastAI;
    }
  }
  if (node.node_type !== 'AI') {
    throw new Error(`节点「${node.name}」是人工节点，无可重跑的 AI 任务`);
  }
  // 删该节点所有产物（按 node_id）
  const del = db.prepare('DELETE FROM artifacts WHERE requirement_id=? AND node_id=?').run(reqId, node.id);
  addTimeline(reqId, 'REEVALUATE', operator,
    `重新评估节点「${node.name}」（${node.ai_action || 'CUSTOM'}），已清空 ${del.changes} 条产物`);
  // 把需求 current_seq 拉回该 AI 节点（如果是回炉重跑场景）
  if (req.current_seq !== node.seq) {
    touchReq(reqId, { current_seq: node.seq, status: 'AI_RUNNING' });
  }
  // 后台激活（fire-and-forget）
  activateNode(reqId, node).catch((e) => console.error('[engine] bg_reevaluate_failed', reqId, e.message));
  return { deleted_artifacts: del.changes, node_name: node.name, action: node.ai_action || 'CUSTOM', node_seq: node.seq };
}

// 人工节点确认（或打回到 AI 节点后人工确认继续）
async function confirm(reqId, operator, note = '') {
  const req = getReq(reqId);
  const node = getNodeBySeq(req.template_id, req.current_seq);
  // 产品评审需求（PO 人工节点）确认流转前必须已有 PRD 产物；校验放在写 CONFIRM timeline 之前，
  // 校验失败的需求不留下「已确认」痕迹。AI 节点（挂起重执行）与 CSM/RD/QA 人工节点不做此校验。
  if (node?.node_type === 'HUMAN' && node.role === 'PO') {
    const prd = latestArtifact(reqId, 'PRD');
    if (!prd || typeof prd.content !== 'string' || prd.content.trim() === '') {
      throw new Error('请补充 PRD 文档后确认流转');
    }
    // PO 节点 confirm 必须先指派 RD + QA（用户需求：产品不指派不允许提交）
    const reqFresh = getReq(reqId);
    if (!reqFresh.rd_id || !reqFresh.qa_id) {
      throw new Error('请先指派研发负责人和测试负责人后再提交');
    }
  }
  addTimeline(reqId, 'CONFIRM', operator, note || `确认节点「${node?.name}」`, req.status, null);
  if (node?.node_type === 'AI') {
    // AI 节点的 confirm 语义：仅当节点挂起（AI_FAILED / PENDING 兜底态）时重跑；
    // AI_RUNNING/CLARIFYING 时重复 confirm 直接拒绝，防止前端重复点击/自动重试导致并发 AI 执行
    if (req.status === STATUS.AI_RUNNING || req.status === STATUS.CLARIFYING) {
      throw new Error(`节点「${node.name}」正在执行中，请勿重复确认`);
    }
    await activateNode(reqId, node);
    return;
  }
  // P0 改造：QA 节点确认通过后立即提醒 CSM「测试完成，等待目标版本上线」，
  // 不等到整个流程走完（QA 节点后面可能还有节点）。站内通知 + 飞书 TEST_DONE 卡片双发。
  if (node?.node_type === 'HUMAN' && node.role === 'QA') {
    const reqFresh = getReq(reqId);
    notify(reqFresh.csm_id,
      `测试完成：${reqFresh.title}`,
      `测试已完成，等待目标版本 ${reqFresh.target_version || '待定'} 即可上线`,
      reqId, 'TEST_DONE', { req: reqFresh });
  }
  await advance(reqId, operator);
}

// 打回到上一个人工节点（必填原因）
// 语义修正：人工节点打回 = 退给最近的 HUMAN 节点（人），跳过中间 AI 节点。
// AI 节点自动执行、不可被打回（挂起态走 confirm 重跑，见 confirm 的 AI 分支）。
async function sendBack(reqId, operator, reason) {
  if (!reason) throw new Error('打回必须填写原因');
  const req = getReq(reqId);
  const nodes = getNodes(req.template_id);
  const idx = nodes.findIndex((n) => n.seq === req.current_seq);
  if (idx <= 0) throw new Error('已在第一个节点，无法打回');
  // 从当前节点向前找最近的 HUMAN 节点；前序全是 AI 属异常模板，抛错由提单人兜底
  let target = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (nodes[i].node_type === 'HUMAN') { target = nodes[i]; break; }
  }
  if (!target) throw new Error('打回失败：当前节点之前没有人工节点，请联系管理员处理');
  touchReq(reqId, { current_seq: target.seq });
  addTimeline(reqId, 'RETURN', operator, `打回到「${target.name}」：${reason}`, req.status, null);
  const uid = assigneeForNode(req, target);
  notify(uid || req.csm_id, `需求被打回：${req.title}`, reason, reqId,
    'SEND_BACK', { req, node: target, targetName: target.name, reason, operator });
  // target 是 HUMAN 节点，activateNode 走 PENDING + notify 分支，天然等待该负责人处理（不传 holdAI）
  await activateNode(reqId, target);
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
    // 去重：若已存在旧一轮【澄清补充】段落，先剥掉再拼新的，description 永远是「原始描述 + 最新一轮澄清」，不无限膨胀。
    // 只取「上一轮合并之后」回答的澄清，避免旧轮答案残留进新段落（轮次之间隔着 AI 重新执行）。
    const lastDone = db.prepare("SELECT MAX(created_at) t FROM timeline WHERE requirement_id=? AND action='CLARIFY_DONE'").get(c.requirement_id).t;
    const answered = lastDone
      ? db.prepare("SELECT question,answer FROM clarifies WHERE requirement_id=? AND status='ANSWERED' AND answered_at > ?").all(c.requirement_id, lastDone)
      : db.prepare("SELECT question,answer FROM clarifies WHERE requirement_id=? AND status='ANSWERED'").all(c.requirement_id);
    const extra = answered.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n');
    const base = /\n*【澄清补充】[\s\S]*$/.test(req.description)
      ? req.description.replace(/\n*【澄清补充】[\s\S]*$/, '')
      : req.description;
    touchReq(c.requirement_id, { description: base + '\n\n【澄清补充】\n' + extra });
    addTimeline(c.requirement_id, 'CLARIFY_DONE', operator, '澄清完毕，重新执行当前节点');
    const node = getNodeBySeq(req.template_id, req.current_seq);
    await activateNode(c.requirement_id, node);
  }
}

module.exports = {
  STATUS, submit, confirm, sendBack, forceSubmit, answerClarify, advance, reevaluate, skipAiNode,
  getNodes, getNodeBySeq, getReq, addTimeline, notify,
  saveArtifact, latestArtifact, touchReq,
  // authz.js 需要用同一份负责人解析规则做 403 判定，禁止在鉴权层另写一份
  assigneeForNode,
};
