// 状态机引擎：由 sop_nodes 表驱动。
// 进入某节点时：AI 节点自动执行 runAI 并落产物，可能需要澄清（挂起）或自动前进；
// HUMAN 节点等待对应角色操作（confirm / return / force）。

const { db } = require('./db');
const { runAI } = require('./ai');
const aiTask = require('./services/ai-task');
const feishu = require('./feishu');
const logger = require('./logger');

const STATUS = {
  DRAFT: 'DRAFT',
  AI_RUNNING: 'AI_RUNNING',
  CLARIFYING: 'CLARIFYING',
  PENDING: 'PENDING',       // 等待人工节点处理
  AI_FAILED: 'AI_FAILED',   // AI 节点执行失败，等待提单人/管理员确认重跑
  DONE: 'DONE',
  CANCELLED: 'CANCELLED',
};

async function getNodes(templateId) {
  return await db.many('SELECT * FROM sop_nodes WHERE template_id=? ORDER BY seq', [templateId]);
}
async function getNodeBySeq(templateId, seq) {
  return await db.one('SELECT * FROM sop_nodes WHERE template_id=? AND seq=?', [templateId, seq]);
}
async function getReq(id) {
  return await db.one('SELECT * FROM requirements WHERE id=?', [id]);
}
async function addTimeline(reqId, action, operator, detail = '', from = null, to = null) {
  await db.execute(
    'INSERT INTO timeline(requirement_id,action,from_status,to_status,operator,detail) VALUES(?,?,?,?,?,?)',
    [reqId, action, from, to, operator, detail]
  );
}
// event/ctx 可选：event 存在时飞书发富文本卡片；缺失时回退旧 text 消息（title/content），保证兼容不崩。
async function notify(userId, title, content, reqId, event, ctx) {
  if (!userId) return;
  await db.execute(
    'INSERT INTO notifications(user_id,title,content,requirement_id) VALUES(?,?,?,?)',
    [userId, title, content, reqId]
  );
  // 飞书为增量渠道：站内通知是主渠道。sendFeishuToUser 内部已吞错，
  // 这里再 .catch 兜底，保证 fire-and-forget 绝不阻塞 notify 返回。
  feishu.sendFeishuToUser(userId, event, ctx, title, content).catch(() => {});
}
async function saveArtifact(reqId, nodeId, kind, content, createdBy = 'AI', meta = null) {
  const last = await db.one(
    'SELECT MAX(version) v FROM artifacts WHERE requirement_id=? AND kind=?',
    [reqId, kind]
  );
  const version = (last?.v || 0) + 1;
  await db.execute(
    'INSERT INTO artifacts(requirement_id,node_id,kind,version,content,meta,created_by) VALUES(?,?,?,?,?,?,?)',
    [
      reqId,
      nodeId,
      kind,
      version,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      meta,
      createdBy
    ]
  );
  return version;
}
async function latestArtifact(reqId, kind) {
  return await db.one(
    'SELECT * FROM artifacts WHERE requirement_id=? AND kind=? ORDER BY version DESC LIMIT 1',
    [reqId, kind]
  );
}
async function touchReq(id, fields) {
  const keys = Object.keys(fields);
  const sql = `UPDATE requirements SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=NOW() WHERE id=?`;
  await db.execute(sql, [...keys.map((k) => fields[k]), id]);
}

// 一个节点可能对应多个负责人：研发开发节点同时含 RD（后端）与 FE（前端），任一负责人均可操作。
// 其余角色一一对应。返回去重后的负责人 ID 数组（不含空值）。
function nodeAssigneeIds(req, node) {
  if (!node || node.node_type !== 'HUMAN') return [];
  const ids = node.role === 'RD' ? [req.rd_id, req.fe_id] : [{ CSM: req.csm_id, PO: req.po_id, QA: req.qa_id }[node.role]];
  return Array.from(new Set(ids.filter(Boolean)));
}

function assigneeForNode(req, node) {
  return nodeAssigneeIds(req, node)[0] || null;
}

// 推进：从当前 seq 走到下一个节点并激活它
// 防御：若当前已 DONE 或 current_seq 与期望不符（并发 AI 完成时已被其他推进者走过），直接返回，避免跳步/回跳。
async function advance(reqId, operator = 'system', expectedSeq = null) {
  const req = await getReq(reqId);
  if (!req) return;
  if (req.status === STATUS.DONE) return;
  // 如果调用方指定期望 seq（AI 节点完成后），必须 current_seq 仍然是自己才推进，防止并发多次 advance 串联
  if (expectedSeq != null && req.current_seq !== expectedSeq) {
    await addTimeline(reqId, 'ADVANCE_SKIP', operator,
      `跳过推进：当前 seq=${req.current_seq}，期望 seq=${expectedSeq}（可能被其他进程已推进）`);
    return;
  }
  const nodes = await getNodes(req.template_id);
  const idx = nodes.findIndex((n) => n.seq === req.current_seq);
  if (idx < 0) return; // seq 不在模板里（异常），不动
  const next = nodes[idx + 1];
  if (!next) {
    // closed_at 必须传 Date 对象（mysql2 按会话时区格式化为 'YYYY-MM-DD HH:MM:SS'）。
    // 传 toISOString() 的 '2026-09-15T02:52:36.936Z' 会被 MySQL 严格模式判为非法 datetime，导致最后一个节点无法流转。
    await touchReq(reqId, { status: STATUS.DONE, current_seq: 999, closed_at: new Date() });
    await addTimeline(reqId, 'DONE', operator, '流程走完，需求单关闭', req.status, STATUS.DONE);
    await notify(req.csm_id, `需求已完成：${req.title}`, '全流程已走完', reqId, 'DONE', { req });
    return;
  }
  // 上一节点是 AI 时 status 仍是 AI_RUNNING；必须先复位为 PENDING，
  // 否则下一个节点若也是 AI，activateNode 的"已在执行中"防重保护会把本次触发当成重复而跳过，
  // 需求会永久停在 AI_RUNNING（前端「AI 处理中」一直涨秒，实际没有任何 AI 在跑）。
  await touchReq(reqId, { current_seq: next.seq, status: STATUS.PENDING });
  await addTimeline(reqId, 'ENTER_NODE', operator, `进入节点「${next.name}」`, null, null);
  await activateNode(reqId, next);
}

// 激活当前节点（AI 自动执行 / 人工等待）
// holdAI: 打回到 AI 节点时不自动执行，挂起等待人工确认（避免打回立即被弹回）
async function activateNode(reqId, node, { holdAI = false } = {}) {
  const req = await getReq(reqId);
  if (node.node_type === 'AI' && !holdAI) {
    // 防御：已经在 AI_RUNNING/CLARIFYING 中，不要重复触发（并发 AI 执行会导致多轮 advance 串联跳步）
    if (req.status === STATUS.AI_RUNNING || req.status === STATUS.CLARIFYING) {
      await addTimeline(reqId, 'AI_SKIP_DUP', 'AI', `节点「${node.name}」已在执行中，跳过重复触发`);
      return;
    }
    await touchReq(reqId, { status: STATUS.AI_RUNNING });
    await addTimeline(reqId, 'AI_START', 'AI', `节点「${node.name}」开始执行（${node.ai_action || 'CUSTOM'}）`);
    try {
      await runAiNode(reqId, node);
    } catch (e) {
      console.error('[engine] AI 节点执行失败', e);
      await addTimeline(reqId, 'AI_FAIL', 'AI', `执行失败：${e.message}，可人工跳过`);
      // B2：节点级失败同样入库，否则"AI 跑挂了"这一类最需要审计的事件反而查不到
      await aiTask.recordAiTask({
        requirementId: reqId, nodeId: node.id, action: node.ai_action || 'CUSTOM',
        meta: { status: aiTask.STATUS.FAILED, degraded_reason: `node_error:${String(e.message).slice(0, 120)}` },
      });
      // 降级：挂起在当前节点，标记 AI_FAILED（区别于正常 PENDING 等待人工），等待人工 confirm 重跑
      await touchReq(reqId, { status: STATUS.AI_FAILED });
    }
  } else {
    await touchReq(reqId, { status: STATUS.PENDING });
    // 一个节点可能有多个负责人（研发开发节点 = RD + FE），逐个通知
    const uids = nodeAssigneeIds(req, node);
    for (const uid of uids) {
      await notify(uid, `待处理：${req.title}`, `需求已流转到你的节点「${node.name}」`, reqId,
        'NODE_ARRIVED', { req, node, role: node.role });
    }
  }
}

// 启动自愈：AI 执行是进程内的 Promise，服务重启会连同它一起杀掉。
// 若不处理，需求会永久停在 AI_RUNNING：没有 worker 会去结束它，前端「已分析 N 秒…」会一直涨。
// 重启后把所有 AI_RUNNING 标记为 AI_FAILED（可 confirm 重跑），CLARIFYING 是合法的等待人工状态，不动。
async function recoverOrphanedRuns() {
  const rows = await db.many('SELECT id FROM requirements WHERE status=?', [STATUS.AI_RUNNING]);
  for (const r of rows) {
    await touchReq(r.id, { status: STATUS.AI_FAILED });
    await addTimeline(r.id, 'AI_RECOVER', 'system',
      '服务重启导致本次 AI 执行中断，已标记为失败，可重新执行', STATUS.AI_RUNNING, STATUS.AI_FAILED);
  }
  if (rows.length) logger.warn('ai_orphan_recovered', { count: rows.length, ids: rows.map((r) => r.id) });
  return rows.length;
}

async function runAiNode(reqId, node) {
  const req = await getReq(reqId);
  const action = node.ai_action || 'CUSTOM';
  const extra = {};
  if (action === 'PRD_GEN') {
    const ev = await latestArtifact(reqId, 'EVALUATION');
    if (ev) extra.evaluation = safeParse(ev.content);
  }
  if (action === 'DEV_PROMPT') {
    const prd = await latestArtifact(reqId, 'PRD');
    if (prd) extra.prd = prd.content;
  }
  if (node.ai_prompt) extra.custom_prompt = node.ai_prompt;
  const { content, model, meta } = await runAI(action, req, extra);

  // B2：本次调用的 provider/级别/降级原因入库（可查询、可审计），并把同一份 meta 挂到产物上，
  // 前端据此渲染模型名、代码依据（AC-09）与 mock 警示条（AC-10）。
  await aiTask.recordAiTask({ requirementId: reqId, nodeId: node.id, action, meta });
  const metaJson = aiTask.buildArtifactMeta(meta);
  // AC-09：产物署名要能看出"哪个模型出的"——llm-call 返回的 model 只是 llm/fallback 粗标签，
  // 真实模型名在 meta.model 里。
  // AC-10：但 mock 分支的 meta.model 仍是"配置里那个模型名"（如 deepseek-chat），
  // 直接用它会把假数据署成真模型的名字。所以必须先看 is_mock，mock 一律署 AI(mock)。
  const by = meta && meta.is_mock ? 'AI(mock)' : `AI(${(meta && meta.model) || model})`;

  if (action === 'PRECHECK') {
    await saveArtifact(reqId, node.id, 'NOTE', content, by, metaJson);
    if (!content.pass && content.questions?.length) {
      const raised = await raiseClarifies(reqId, node, content.questions, '需求完整性预检未通过，请补充以下信息');
      if (raised) return; // 挂起等澄清
      // 已达澄清轮次上限：不再挂起，继续推进（raiseClarifies 已记 CLARIFY_LIMIT）
    }
  } else if (action === 'EVALUATE') {
    await saveArtifact(reqId, node.id, 'EVALUATION', content, by, metaJson);
    if (content.level) await touchReq(reqId, { level: content.level });
    // 需求信息不足：卡在评估节点，向需求发起人（CSM）提问，补充后自动重跑本节点重新评估。
    const questions = Array.isArray(content.questions)
      ? content.questions.filter((q) => typeof q === 'string' && q.trim())
      : [];
    // 阻断性问题优先于分数；低于阈值且模型漏列问题时，补一条澄清，避免 82% 等高分被误当成充分信息。
    const confidence = typeof content.confidence === 'number' ? content.confidence : null;
    const confident = confidence != null && confidence >= CLARIFY_MIN_CONFIDENCE;
    const clarifyQuestions = questions.length ? questions : (confident ? [] : [
      '请补充本需求的目标使用对象、具体业务范围和可验证的验收标准，以便完成可靠评估。',
    ]);
    if (clarifyQuestions.length) {
      const raised = await raiseClarifies(reqId, node, clarifyQuestions, '需求评审置信度未达到 85%，请补充关键信息');
      if (raised) return; // 挂起等澄清
      // 已达澄清轮次上限：不再挂起，继续推进（raiseClarifies 已记 CLARIFY_LIMIT）
    }
    // 信息充足但有风险：不阻塞流程，只把注意事项写进产物（content 已整体落库）并记 AI_ATTENTION 提醒。
    if (content.rationality?.verdict === 'NEEDS_ATTENTION') {
      const pts = Array.isArray(content.attention_points) ? content.attention_points : [];
      await addTimeline(reqId, 'AI_ATTENTION', 'AI',
        `AI 评估提出 ${pts.length} 条注意事项：${pts.join('；') || '（无具体事项）'}`);
    }
  } else if (action === 'PRD_GEN') {
    await saveArtifact(reqId, node.id, 'PRD', content, by, metaJson);
  } else if (action === 'DEV_PROMPT') {
    await saveArtifact(reqId, node.id, 'DEV_PROMPT', content, by, metaJson);
  } else if (action === 'TEST_CASE') {
    await saveArtifact(reqId, node.id, 'TEST_CASE', content, by, metaJson);
  } else {
    await saveArtifact(reqId, node.id, 'NOTE', content, by, metaJson);
  }
  await addTimeline(reqId, 'AI_DONE', 'AI', `节点「${node.name}」执行完成`);
  // 方案 B：AI 产物是兜底（is_mock=true 即"AI 未真评估"）时不自动推进 —— 挂起等人工三选：
  //   1) 重新执行 2) 跳过继续 3) 人工补产物。只有真产物（is_mock=false）才自动流转。
  if (meta && meta.is_mock) {
    await addTimeline(reqId, 'AI_DEGRADED', 'AI', `节点「${node.name}」产物为兜底（未真评估），已挂起等待处理：可重新执行 / 跳过继续 / 人工补产物`);
    await touchReq(reqId, { status: STATUS.PENDING });
    const reqFresh = await getReq(reqId);
    await notify(reqFresh.csm_id, `AI 评估未产出：${reqFresh.title}`, `节点「${node.name}」AI 未返回真实评估（兜底产物），请处理：重新执行 / 跳过 / 补产物`, reqId, 'AI_DEGRADED', { req: reqFresh, node });
    return;
  }
  // 传 expectedSeq=node.seq：只有当 current_seq 仍是本 AI 节点时才推进，防止并发多次 AI 完成后连续跳步
  await advance(reqId, 'AI', node.seq);
}

// 方案 B：跳过当前 AI 节点（兜底产物时人工选择"继续走"），直接进入下一节点
async function skipAiNode(reqId, operator) {
  const req = await getReq(reqId);
  const node = await getNodeBySeq(req.template_id, req.current_seq);
  if (!node || node.node_type !== 'AI') throw new Error('仅挂起的 AI 节点可跳过');
  await addTimeline(reqId, 'AI_SKIP', operator, `跳过 AI 节点「${node.name}」（产物为兜底，人工确认继续）`);
  await advance(reqId, operator);
}

// 单个节点的 AI 澄清上限：最多 3 轮、每轮最多 3 个问题。
// 达到轮次上限后不再挂起提问，由调用方继续推进流程，避免 AI 反复追问把需求卡死。
const MAX_CLARIFY_ROUNDS = 3;
const MAX_CLARIFY_QUESTIONS = 3;
// AI 自评置信度达到 85% 才认定信息足够；低于该值必须补充信息后再评估。
const CLARIFY_MIN_CONFIDENCE = 0.85;

// 澄清结论落进需求描述时的固定声明。migrate.js 升级存量描述块时复用同一份文案，避免两处漂移。
const CLARIFY_FACT_NOTE = '以下问答已由需求发起人确认，直接采信：不得再重复提问，也不得与其冲突。';

// 问题文本归一化（去掉空白与尾部标点），用于跨轮去重：AI 换行/标点微调不应算新问题。
function normalizeQuestion(s) {
  return String(s || '').replace(/\s+/g, '').replace(/[。．.!！?？；;、,，~～]+$/g, '');
}

/**
 * 把已回答的澄清渲染成「已澄清结论·视为既定事实」区块。
 * 单独成块并显式声明"已确认"，是因为此前只把问答追加进描述时，AI 会把它们继续当成开放问题，
 * 换个说法重问一遍（仅有文本精确去重拦不住改写式重复）。
 */
function clarifyFactBlock(round, qas) {
  return [
    `【已澄清结论·视为既定事实（第 ${round} 轮）】`,
    CLARIFY_FACT_NOTE,
    ...qas.map((a) => `Q: ${a.question}\nA: ${a.answer}`),
  ].join('\n');
}

/**
 * 就当前节点挂起一轮澄清。
 * @returns {Promise<boolean>} 是否真的提出了问题；false 表示已达轮次上限或问题重复（已记时间线）。
 */
async function raiseClarifies(reqId, node, questions, reason) {
  const asked = (questions || [])
    .filter((q) => typeof q === 'string' && q.trim())
    .slice(0, MAX_CLARIFY_QUESTIONS);
  if (!asked.length) return false; // 没有可问的问题，直接放行
  // 本轮轮次 = 该节点已有的 CLARIFY 轮次 + 1；kind='CLARIFY' 排除聊天消息（kind='CHAT'）
  const prev = await db.one(
    "SELECT COALESCE(MAX(round_no),0) r FROM clarifies WHERE requirement_id=? AND node_id=? AND kind='CLARIFY'",
    [reqId, node.id]
  );
  const round = Number(prev && prev.r ? prev.r : 0) + 1;
  if (round > MAX_CLARIFY_ROUNDS) {
    await addTimeline(reqId, 'CLARIFY_LIMIT', 'AI',
      `节点「${node.name}」澄清已达上限（${MAX_CLARIFY_ROUNDS} 轮），不再提问，继续流程`);
    return false;
  }
  // 去重：AI 重新评估时容易把已答过的问题再问一遍，同节点问过的不再重复入库。
  const exist = await db.many(
    "SELECT question FROM clarifies WHERE requirement_id=? AND node_id=? AND kind='CLARIFY'",
    [reqId, node.id]
  );
  const seen = new Set(exist.map((r) => normalizeQuestion(r.question)));
  const fresh = [];
  for (const q of asked) {
    const key = normalizeQuestion(q);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(q);
  }
  if (!fresh.length) {
    await addTimeline(reqId, 'CLARIFY_DEDUP', 'AI',
      `节点「${node.name}」本次问题与已问过的重复，跳过提问，继续流程`);
    return false;
  }
  for (const q of fresh) {
    await db.execute(
      'INSERT INTO clarifies(requirement_id,node_id,asked_by,question,round_no) VALUES(?,?,?,?,?)',
      [reqId, node.id, 'AI', q, round]
    );
  }
  await touchReq(reqId, { status: STATUS.CLARIFYING });
  await addTimeline(reqId, 'CLARIFY', 'AI',
    `${reason}（第 ${round}/${MAX_CLARIFY_ROUNDS} 轮，${fresh.length} 个问题）`);
  const req = await getReq(reqId);
  await notify(req.csm_id, `需求待澄清：${req.title}`, `AI 提出了 ${fresh.length} 个问题`, reqId,
    'CLARIFY', { req, questions: fresh });
  return true;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/* ------------ 对外动作 ------------ */

// 提交需求（DRAFT -> 第一个节点）
// P0 修复：跳过冗余的「CSM 提交需求」人工节点，直接进入第一个真正的流程节点，
// 避免 CSM 自己看到"该你处理了：CSM 提交需求"的待办提示。
async function submit(reqId, operator) {
  const req = await getReq(reqId);
  const nodes = await getNodes(req.template_id);
  if (!nodes.length) throw new Error('SOP 模板没有节点');
  const first = nodes[0];
  // 冗余 CSM 提交节点判定：HUMAN +（角色 CSM 或 名称含「CSM 提交」）
  const redundantCsmSubmit =
    first.node_type === 'HUMAN' &&
    (first.role === 'CSM' || (first.name && first.name.includes('CSM 提交')));
  // 跳过该节点：从 nodes[1] 起找第一个真正的入口节点；仅一个节点时兜底激活 first。
  const startNode = redundantCsmSubmit && nodes.length > 1 ? nodes[1] : first;
  // current_seq 直接跳到 startNode.seq：不留 seq=1 的中间值，避免前端残留错误待办态
  await touchReq(reqId, { current_seq: startNode.seq, status: 'SUBMITTED' });
  await addTimeline(reqId, 'SUBMIT', operator, '需求提交，进入流程', STATUS.DRAFT, 'SUBMITTED');
  if (startNode !== first) {
    await addTimeline(reqId, 'SUBMIT_SKIP', operator,
      `CSM 提交后跳过【${first.name}】，直接进入【${startNode.name}】`);
  }
  // 启动起始节点（AI 节点会后台跑 LLM；人工节点立即写 PENDING 状态并通知）。
  // fire-and-forget：返回前不等 LLM 完成，避免 60s+ 阻塞导致 CSM 重复点击。
  activateNode(reqId, startNode).catch((e) => console.error("[engine] bg_activate_node_failed", reqId, e.message));
}

// 重新跑当前 AI 节点：删该节点已有产物、记时间线、后台激活节点（fire-and-forget）。
// 用途：AI 评估/PRD/提示词不准时，CSM 或 ADMIN 主动重跑当前节点——不等用户走完整流程。
// 仅 AI 节点可重跑（人工节点没"重跑"语义），非 AI 节点报 400。
async function reevaluate(reqId, operator, targetSeq = null) {
  const req = await getReq(reqId);
  if (!req) throw new Error('需求不存在');

  // 选节点：传了 targetSeq 用指定 seq；否则：
  // 1) 当前节点是 AI → 重跑当前
  // 2) 当前是人工 → 找最近一个 AI 节点（产品场景：AI 评估已过但结果不准，要回炉重跑）
  let node;
  if (targetSeq != null) {
    node = await getNodeBySeq(req.template_id, targetSeq);
    if (!node) throw new Error(`seq=${targetSeq} 节点不存在`);
  } else {
    const cur = await getNodeBySeq(req.template_id, req.current_seq);
    if (cur && cur.node_type === 'AI') {
      node = cur;
    } else {
      // 找最近一个 AI 节点（按 seq 降序）
      const allNodes = await getNodes(req.template_id);
      const lastAI = [...allNodes].reverse().find((n) => n.node_type === 'AI');
      if (!lastAI) throw new Error('模板里没有任何 AI 节点');
      node = lastAI;
    }
  }
  if (node.node_type !== 'AI') {
    throw new Error(`节点「${node.name}」是人工节点，无可重跑的 AI 任务`);
  }
  // 删该节点所有产物（按 node_id）
  const del = await db.execute(
    'DELETE FROM artifacts WHERE requirement_id=? AND node_id=?',
    [reqId, node.id]
  );
  await addTimeline(reqId, 'REEVALUATE', operator,
    `重新评估节点「${node.name}」（${node.ai_action || 'CUSTOM'}），已清空 ${del.changes} 条产物`);
  // 把需求 current_seq 拉回该 AI 节点（如果是回炉重跑场景）
  if (req.current_seq !== node.seq) {
    // 交给 activateNode 统一切换为 AI_RUNNING；提前标记会被其防重复保护误判为已执行。
    await touchReq(reqId, { current_seq: node.seq, status: 'PENDING' });
  }
  // 后台激活（fire-and-forget）
  activateNode(reqId, node).catch((e) => console.error('[engine] bg_reevaluate_failed', reqId, e.message));
  return { deleted_artifacts: del.changes, node_name: node.name, action: node.ai_action || 'CUSTOM', node_seq: node.seq };
}

// 人工节点确认（或打回到 AI 节点后人工确认继续）
async function confirm(reqId, operator, note = '') {
  const req = await getReq(reqId);
  const node = await getNodeBySeq(req.template_id, req.current_seq);
  // 产品评审需求（PO 人工节点）确认流转前必须已有 PRD 产物；校验放在写 CONFIRM timeline 之前，
  // 校验失败的需求不留下「已确认」痕迹。AI 节点（挂起重执行）与 CSM/RD/QA 人工节点不做此校验。
  if (node?.node_type === 'HUMAN' && node.role === 'PO') {
    const prd = await latestArtifact(reqId, 'PRD');
    if (!prd || typeof prd.content !== 'string' || prd.content.trim() === '') {
      throw new Error('请补充 PRD 文档后确认流转');
    }
    // PO 节点 confirm 必须先指派研发（后端/前端任一）+ QA（用户需求：产品不指派不允许提交）
    const reqFresh = await getReq(reqId);
    if ((!reqFresh.rd_id && !reqFresh.fe_id) || !reqFresh.qa_id) {
      throw new Error('请先指派研发（后端/前端任一）和测试负责人后再提交');
    }
    // 产品节点必须关联 Jira 单号（用户需求：Jira 号为产品节点必填），可一键生成或手动填写
    if (!reqFresh.jira_url || !String(reqFresh.jira_url).trim()) {
      throw new Error('请先关联 Jira 单号后再提交');
    }
  }
  // 测试验证上线（QA 人工节点）：测试用例必须全部执行（结果非空）才允许流转。
  // 老版本漏了这个前置校验，出现过「一条用例都没点，直接确认进入上线」的漏测流转。
  if (node?.node_type === 'HUMAN' && node.role === 'QA') {
    const tc = await latestArtifact(reqId, 'TEST_CASE');
    let cases = null;
    if (tc && typeof tc.content === 'string' && tc.content.trim()) {
      try { const parsed = JSON.parse(tc.content); if (Array.isArray(parsed)) cases = parsed; } catch { cases = null; }
    }
    if (!cases || !cases.length) {
      throw new Error(tc
        ? '当前测试用例是旧版纯文本，无法记录执行结果；请在「测试用例」页重新生成后再流转'
        : '请先生成测试用例后再流转');
    }
    const pending = cases.filter((c) => !String(c?.result || '').trim()).length;
    if (pending > 0) {
      throw new Error(`还有 ${pending} 条测试用例未执行，请先填写执行结果（通过/失败）后再流转`);
    }
  }
  await addTimeline(reqId, 'CONFIRM', operator, note || `确认节点「${node?.name}」`, req.status, null);
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
    const reqFresh = await getReq(reqId);
    await notify(reqFresh.csm_id,
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
  const req = await getReq(reqId);
  const nodes = await getNodes(req.template_id);
  const idx = nodes.findIndex((n) => n.seq === req.current_seq);
  if (idx <= 0) throw new Error('已在第一个节点，无法打回');
  // 从当前节点向前找最近的 HUMAN 节点；前序全是 AI 属异常模板，抛错由提单人兜底
  let target = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (nodes[i].node_type === 'HUMAN') { target = nodes[i]; break; }
  }
  if (!target) throw new Error('打回失败：当前节点之前没有人工节点，请联系管理员处理');
  await touchReq(reqId, { current_seq: target.seq });
  await addTimeline(reqId, 'RETURN', operator, `打回到「${target.name}」：${reason}`, req.status, null);
  const uids = nodeAssigneeIds(req, target);
  for (const uid of (uids.length ? uids : [req.csm_id])) {
    await notify(uid, `需求被打回：${req.title}`, reason, reqId,
      'SEND_BACK', { req, node: target, targetName: target.name, reason, operator });
  }
  // target 是 HUMAN 节点，activateNode 走 PENDING + notify 分支，天然等待该负责人处理（不传 holdAI）
  await activateNode(reqId, target);
}

// 强制提交（从 CLARIFYING 状态跳过未回答问题，继续走）
async function forceSubmit(reqId, operator, note = '') {
  const req = await getReq(reqId);
  if (req.status !== STATUS.CLARIFYING) throw new Error('当前不在待澄清状态，无需强制提交');
  await db.execute(
    "UPDATE clarifies SET status='FORCED' WHERE requirement_id=? AND status='OPEN'",
    [reqId]
  );
  await addTimeline(reqId, 'FORCE_SUBMIT', operator, note || '未全部澄清，强制继续流程', req.status, null);
  await advance(reqId, operator);
}

// 回复澄清问题；全部回复完后自动重走当前 AI 节点
async function answerClarify(clarifyId, answer, operator) {
  const c = await db.one('SELECT * FROM clarifies WHERE id=?', [clarifyId]);
  if (!c) throw new Error('澄清问题不存在');
  await db.execute(
    "UPDATE clarifies SET answer=?, status='ANSWERED', answered_at=NOW() WHERE id=?",
    [answer, clarifyId]
  );
  await addTimeline(c.requirement_id, 'CLARIFY_ANSWER', operator, `回答问题 #${clarifyId}`);
  const open = (await db.one(
    "SELECT COUNT(*) n FROM clarifies WHERE requirement_id=? AND status='OPEN'",
    [c.requirement_id]
  )).n;
  if (open === 0) {
    const req = await getReq(c.requirement_id);
    // 只取「上一轮合并之后」回答的澄清，避免旧轮答案被重复并入描述（轮次之间隔着 AI 重新执行）。
    const lastDone = (await db.one(
      "SELECT MAX(created_at) t FROM timeline WHERE requirement_id=? AND action='CLARIFY_DONE'",
      [c.requirement_id]
    )).t;
    const answered = lastDone
      ? await db.many(
      "SELECT question,answer,round_no FROM clarifies WHERE requirement_id=? AND status='ANSWERED' AND answered_at > ? ORDER BY id",
      [c.requirement_id, lastDone]
    )
      : await db.many(
      "SELECT question,answer,round_no FROM clarifies WHERE requirement_id=? AND status='ANSWERED' ORDER BY id",
      [c.requirement_id]
    );
    const round = (answered[0] && answered[0].round_no) || c.round_no || 1;
    // 澄清结论单独成块并冠以「视为既定事实」：AI 重跑时把该块当作已确认口径，
    // 不再把同一问题换个说法重新提问（此前仅有文本精确去重，改写式重复拦不住，
    // 出现过第 2、3 轮问法不同但实质同一个问题的情况）。
    const block = clarifyFactBlock(round, answered);
    // status 必须从 CLARIFYING 复位为 PENDING，否则 activateNode 的"已在执行中"防重保护会跳过重跑。
    await touchReq(c.requirement_id, {
      description: `${req.description || ''}\n\n${block}`,
      status: STATUS.PENDING,
    });
    await addTimeline(c.requirement_id, 'CLARIFY_DONE', operator, '澄清完毕，重新执行当前节点');
    const node = await getNodeBySeq(req.template_id, req.current_seq);
    await activateNode(c.requirement_id, node);
  }
}

module.exports = {
  STATUS, submit, confirm, sendBack, forceSubmit, answerClarify, advance, reevaluate, skipAiNode,
  getNodes, getNodeBySeq, getReq, addTimeline, notify,
  saveArtifact, latestArtifact, touchReq, recoverOrphanedRuns,
  // authz.js 需要用同一份负责人解析规则做 403 判定，禁止在鉴权层另写一份
  assigneeForNode, nodeAssigneeIds,
  // migrate.js 升级存量澄清区块时复用同一文案，避免两处描述不一致
  CLARIFY_FACT_NOTE,
};
