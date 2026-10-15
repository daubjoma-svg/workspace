// 授权层（P0-01 根治）：节点操作互斥的后端强制校验。
// 依据 SPEC-v1.0.md §10 L222「节点操作互斥后端强制校验（非负责人 403）」。
//
// 职责边界：
//   - 只判「这个人能不能对这张需求单执行这个动作」，判过了把 requirement 挂到 req 上给下游复用；
//   - 不改状态、不写 timeline、不碰 engine 的推进逻辑；
//   - engine.js 的 operator 参数继续收 req.user.name（展示名），鉴权在本层已经做完，engine 保持纯粹。
//
// 判定矩阵：
//   ADMIN                      -> 一律放行
//   submit / cancel            -> 需求所有权动作，仅提单人(csm_id)
//   confirm / return / force-submit
//     当前节点 HUMAN           -> 必须是 assigneeForNode(req, node)（node.role 对应的 *_id）
//     当前节点 AI（挂起态）    -> 按 engine.js sendBack 的既有语义「由提交人/管理员确认后继续」，仅提单人
//     HUMAN 节点未指派负责人   -> 回落到提单人兜底，避免需求卡死在无人可操作的节点（并打 warn 留痕）

'use strict';

const { db } = require('./db');
const engine = require('./engine');
const logger = require('./logger');

// 需求终态：不再接受任何流转动作。命中返回 400 而非 500（幂等保护）
const TERMINAL_STATUS = { DONE: '已完成', CANCELLED: '已取消' };

// scope: OWNER = 需求所有权动作；NODE = 当前节点负责人动作
const ACTIONS = {
  submit: { label: '提交需求', scope: 'OWNER' },
  cancel: { label: '取消需求', scope: 'OWNER' },
  confirm: { label: '确认节点', scope: 'NODE' },
  return: { label: '打回节点', scope: 'NODE' },
  'force-submit': { label: '强制提交', scope: 'NODE' },
};

const ROLE_LABEL = { CSM: 'CSM', PO: '产品', RD: '后端', FE: '前端', QA: '测试', ADMIN: '管理员' };

/** 取用户展示名，用于把 403 文案写清楚「负责人是谁」。查不到时退化成占位标识而非抛错 */
async function displayName(userId) {
  if (!userId) return '未指派';
  const u = await db.one('SELECT name,role FROM users WHERE id=?', [userId]);
  return u ? `${u.name}（${ROLE_LABEL[u.role] || u.role}）` : `用户#${userId}`;
}

function selfName(user) {
  return `${user.name}（${ROLE_LABEL[user.role] || user.role}）`;
}

function deny(req, res, message, ctx) {
  logger.warn('authz_denied', {
    user_id: req.user.id, user_role: req.user.role,
    path: req.originalUrl, ...ctx,
  });
  return res.status(403).json({ error: message });
}

/** 需求单前置校验：ID 合法性 / 存在性 / 终态。通过则返回需求行，否则已写响应返回 null */
async function loadRequirementOr4xx(req, res, actionLabel) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: '需求 ID 不合法' });
    return null;
  }
  const r = await engine.getReq(id);
  if (!r) {
    res.status(404).json({ error: `需求 #${id} 不存在` });
    return null;
  }
  const terminal = TERMINAL_STATUS[r.status];
  if (terminal) {
    res.status(400).json({ error: `需求「${r.req_no}」${terminal}，不能再执行「${actionLabel}」` });
    return null;
  }
  return r;
}

/** 需求所有权动作：仅提单人。ADMIN 已在外层放行 */
async function checkOwnerScope(req, res, next, r, spec) {
  if (r.csm_id === req.user.id) return next();
  return deny(req, res,
    `需求「${r.req_no}」的提单人是 ${await displayName(r.csm_id)}，你是 ${selfName(req.user)}，`
    + `无权执行「${spec.label}」（该操作仅提单人或管理员可执行）`,
    { requirement_id: r.id, action: spec.label, scope: 'OWNER', expect_user_id: r.csm_id });
}

/** 当前节点负责人动作 */
async function checkNodeScope(req, res, next, r, spec) {
  const node = await engine.getNodeBySeq(r.template_id, r.current_seq);
  if (!node) {
    // 模板被改过 / current_seq 越界：没有可比对的负责人，回落到需求所有权
    logger.warn('authz_node_missing', { requirement_id: r.id, current_seq: r.current_seq, template_id: r.template_id });
    return await checkOwnerScope(req, res, next, r, spec);
  }
  req.currentNode = node;

  if (node.node_type === 'HUMAN') {
    // 一个节点可能有多个负责人（如「研发开发」节点同时指派 RD 与 FE），任一负责人可操作
    const assignees = engine.nodeAssigneeIds(r, node);
    if (!assignees.length) {
      // HUMAN 节点但对应角色没指派（如 po_id 为空）：不能把需求锁死，交给提单人兜底
      logger.warn('authz_node_unassigned', {
        requirement_id: r.id, node_id: node.id, node_role: node.role,
      });
      return await checkOwnerScope(req, res, next, r, spec);
    }
    if (assignees.includes(req.user.id)) return next();
    const ownerNames = (await Promise.all(assignees.map((uid) => displayName(uid)))).join(' / ');
    return deny(req, res,
      `当前节点「${node.name}」的负责人是 ${ownerNames}，你是 ${selfName(req.user)}，`
      + `无权执行「${spec.label}」`,
      { requirement_id: r.id, node_id: node.id, action: spec.label, scope: 'NODE', expect_user_ids: assignees });
  }

  // AI 节点处于挂起态（打回 / 执行失败 / 待澄清）：engine.sendBack 的语义是「由提交人或管理员确认后继续」
  if (r.csm_id === req.user.id) return next();
  return deny(req, res,
    `当前节点「${node.name}」是 AI 节点，挂起后仅提单人 ${await displayName(r.csm_id)} 或管理员可执行「${spec.label}」，`
    + `你是 ${selfName(req.user)}`,
    { requirement_id: r.id, node_id: node.id, action: spec.label, scope: 'AI_NODE', expect_user_id: r.csm_id });
}

/**
 * 节点操作鉴权中间件工厂。
 * @param {'submit'|'confirm'|'return'|'force-submit'|'cancel'} action
 */
function requireNodeOwner(action) {
  const spec = ACTIONS[action];
  if (!spec) throw new Error(`requireNodeOwner: 未知动作 ${action}`);
  return async function nodeOwnerGuard(req, res, next) {
    const r = await loadRequirementOr4xx(req, res, spec.label);
    if (!r) return undefined;
    // 重复提交会把已在流程中的需求打回第一个节点（静默数据损坏），在鉴权层一并拦掉
    if (action === 'submit' && r.status !== engine.STATUS.DRAFT) {
      return res.status(400).json({ error: `需求「${r.req_no}」当前状态为 ${r.status}，不能重复提交` });
    }
    req.requirement = r;
    if (req.user.role === 'ADMIN') return next();
    return spec.scope === 'OWNER'
      ? await checkOwnerScope(req, res, next, r, spec)
      : await checkNodeScope(req, res, next, r, spec);
  };
}

/**
 * 澄清应答鉴权。
 * 应答人 = 提单人(csm_id) + ADMIN。理由：
 *   1) clarifies 全部由 AI 在 raiseClarifies 中提出，asked_by 恒为 'AI'，且只 notify(req.csm_id)，
 *      产品语义上就是「AI 向提单人要信息」，没有第二个收件人；
 *   2) answerClarify 会把答案回写进 requirements.description（需求正文），
 *      这是需求所有权范围内的修改，放开给当前节点负责人等于让 RD/QA 能改 CSM 的需求正文，是新的越权面；
 *   3) 澄清期间需求状态为 CLARIFYING、当前节点是挂起的 AI 节点，本就没有"当前人工负责人"可比对。
 */
function requireClarifyOwner() {
  return async function clarifyOwnerGuard(req, res, next) {
    const cid = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(cid) || cid <= 0) return res.status(400).json({ error: '澄清问题 ID 不合法' });
    const c = await db.one('SELECT * FROM clarifies WHERE id=?', [cid]);
    if (!c) return res.status(404).json({ error: `澄清问题 #${cid} 不存在` });
    if (c.status !== 'OPEN') {
      // 重复回答会二次触发 activateNode，重复追加澄清正文并重跑 AI 节点，属静默数据污染
      return res.status(400).json({ error: `澄清问题 #${cid} 已处理（${c.status}），不能重复回答` });
    }
    const r = await engine.getReq(c.requirement_id);
    if (!r) return res.status(404).json({ error: '澄清问题关联的需求不存在' });
    const terminal = TERMINAL_STATUS[r.status];
    if (terminal) return res.status(400).json({ error: `需求「${r.req_no}」${terminal}，不能再回答澄清问题` });

    req.clarify = c;
    req.requirement = r;
    if (req.user.role === 'ADMIN' || r.csm_id === req.user.id) return next();
    return deny(req, res,
      `澄清问题 #${cid} 属于需求「${r.req_no}」，应由提单人 ${await displayName(r.csm_id)} 回答，`
      + `你是 ${selfName(req.user)}`,
      { requirement_id: r.id, clarify_id: cid, scope: 'CLARIFY', expect_user_id: r.csm_id });
  };
}

/** 测试用例写入仅限本需求测试负责人或管理员；未指派时不回落到提单人，避免代填测试结果。 */
function requireTestCaseOwner() {
  return async function testCaseOwnerGuard(req, res, next) {
    if (req.body?.kind !== 'TEST_CASE') return next();
    // 防止 parseInt("10e1") 与写入时 Number("10e1") 指向不同需求，必须使用规范十进制 ID。
    if (!/^[1-9]\d*$/.test(req.params.id)) {
      logger.warn('test_case_invalid_id', { requirement_id: req.params.id, user_id: req.user.id });
      return res.status(400).json({ error: '需求 ID 不合法' });
    }
    try {
      const r = await loadRequirementOr4xx(req, res, '保存测试用例执行结果');
      if (!r) return undefined;
      req.requirement = r;
      if (req.user.role === 'ADMIN' || (req.user.role === 'QA' && r.qa_id === req.user.id)) return next();
      return deny(req, res, '仅该需求的测试负责人或管理员可修改测试用例执行结果', {
        requirement_id: r.id, action: '保存测试用例执行结果', scope: 'TEST_CASE', expect_user_id: r.qa_id,
      });
    } catch (error) {
      logger.error('test_case_authz_failed', { requirement_id: req.params.id, user_id: req.user.id, reason: error.message });
      return next(error);
    }
  };
}

module.exports = { requireNodeOwner, requireClarifyOwner, requireTestCaseOwner, TERMINAL_STATUS, ACTIONS };
