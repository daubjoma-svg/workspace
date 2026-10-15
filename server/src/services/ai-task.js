// B2 可观测性：AI 调用记录的唯一写入/读取出口 + artifact.meta 契约的唯一构造点。
//
// 为什么两件事放一起：ai_tasks 行与 artifact.meta 描述的是同一次调用。
// 分两处各写一份必然漂移（前端按 meta 判 mock、管理端按 ai_tasks 查降级，两边对不上就等于没有可观测性）。
// 这里由 normalize() 统一收口，落库和写 meta 都从同一份归一化结果出。

'use strict';

const { db } = require('./../db');
const logger = require('./../logger');

// 与 llm/capabilities.js 的能力词表对齐；mock 为第四态（未走真实模型）
const LEVEL_TO_TAG = { json_schema: 'L1', json_object: 'L2', prompt_only: 'L3', mock: 'mock' };

const STATUS = { OK: 'OK', DEGRADED: 'DEGRADED', FAILED: 'FAILED' };

/** null/undefined/'' 必须留 null，不能落成 0——Number(null)===0 会把「没测到延迟」伪装成「0ms」 */
function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * 把 runAI 返回的 meta 归一化成固定形状。缺字段一律补 null，不让 undefined 流进 JSON.stringify
 * （undefined 会被静默丢键，前端拿到的对象缺字段却查不出原因）。
 */
function normalize(meta = {}) {
  return {
    provider_id: meta.provider_id == null ? null : intOrNull(meta.provider_id),
    provider_type: meta.provider_type || null,
    model: meta.model || null,
    structured_level: meta.structured_level || null,
    status: meta.status === STATUS.OK || meta.status === STATUS.FAILED ? meta.status : STATUS.DEGRADED,
    degraded_reason: meta.degraded_reason || null,
    latency_ms: intOrNull(meta.latency_ms),
    attempt: intOrNull(meta.attempt) ?? 0,
    is_mock: meta.is_mock === true,
    code_basis: meta.code_basis || null,
    prompt_tokens: intOrNull(meta.prompt_tokens),
    completion_tokens: intOrNull(meta.completion_tokens),
    code_files_used: Array.isArray(meta.code_files_used) ? meta.code_files_used : [],
  };
}

/**
 * artifact.meta 的锁定契约（前后端共用，字段名不得增删改）：
 * { provider_id, provider_type, model, structured_level, status, degraded_reason,
 *   latency_ms, attempt, is_mock, code_basis }
 * @returns {string} 可直接写入 artifacts.meta 的 JSON 串
 */
function buildArtifactMeta(meta) {
  const n = normalize(meta);
  return JSON.stringify({
    provider_id: n.provider_id,
    provider_type: n.provider_type,
    model: n.model,
    structured_level: n.structured_level,
    status: n.status,
    degraded_reason: n.degraded_reason,
    latency_ms: n.latency_ms,
    attempt: n.attempt,
    is_mock: n.is_mock,
    code_basis: n.code_basis,
  });
}

const INSERT_SQL = `INSERT INTO ai_tasks
  (requirement_id,node_id,action,provider_id,provider_type,model,structured_level,status,
   degraded_reason,is_mock,latency_ms,attempt,prompt_tokens,completion_tokens,code_files_used,code_basis)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/**
 * 记录一次 AI 调用。落库失败绝不能把 AI 节点带崩——可观测性是旁路，不是主链路。
 * @returns {number|null} ai_tasks.id
 */
async function recordAiTask({ requirementId, nodeId = null, action, meta }) {
  const n = normalize(meta);
  try {
    const r = await db.execute(INSERT_SQL, [
      requirementId ?? null,
      nodeId,
      action,
      n.provider_id,
      n.provider_type,
      n.model,
      n.structured_level,
      n.status,
      n.degraded_reason,
      n.is_mock ? 1 : 0,
      n.latency_ms,
      n.attempt,
      n.prompt_tokens,
      n.completion_tokens,
      n.code_files_used.length ? JSON.stringify(n.code_files_used) : null,
      n.code_basis ? JSON.stringify(n.code_basis) : null
    ]);
    if (n.status !== STATUS.OK) {
      logger.warn('ai_task_degraded', {
        requirement_id: requirementId, action, status: n.status,
        reason: n.degraded_reason, is_mock: n.is_mock, level: n.structured_level,
      });
    }
    return r.lastInsertRowid;
  } catch (e) {
    logger.error('ai_task_record_failed', { requirement_id: requirementId, action, reason: e.message });
    return null;
  }
}

function safeParse(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/** 出参：openapi components.schemas.AiTask。structured_level 按 openapi 枚举给 L1/L2/L3/mock，
 *  同时保留 capability 原始词表，便于与 artifact.meta 对照排查。 */
function toPublic(row) {
  return {
    id: row.id,
    requirement_id: row.requirement_id,
    node_id: row.node_id,
    action: row.action,
    provider_id: row.provider_id,
    provider_type: row.provider_type,
    model: row.model,
    status: row.status,
    degraded_reason: row.degraded_reason,
    structured_level: LEVEL_TO_TAG[row.structured_level] || row.structured_level || null,
    capability: row.structured_level || null,
    is_mock: row.is_mock === 1,
    latency_ms: row.latency_ms,
    attempt: row.attempt,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    code_files_used: safeParse(row.code_files_used, []),
    code_basis: safeParse(row.code_basis, null),
    created_at: row.created_at,
  };
}

const VALID_STATUS = new Set(Object.values(STATUS));

/** 分页查询。requirement_id / status 为可选过滤条件，非法值直接忽略而不是报错 */
async function listAiTasks({ requirementId, status, limit, offset }) {
  const where = [];
  const args = [];
  const rid = Number.parseInt(requirementId, 10);
  if (Number.isInteger(rid) && rid > 0) { where.push('requirement_id=?'); args.push(rid); }
  if (VALID_STATUS.has(status)) { where.push('status=?'); args.push(status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.one(`SELECT COUNT(*) n FROM ai_tasks ${clause}`, [...args])).n;
  const rows = await db.many(
    `SELECT * FROM ai_tasks ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset]
  );
  return { items: rows.map(toPublic), total };
}

module.exports = { STATUS, normalize, buildArtifactMeta, recordAiTask, listAiTasks, toPublic };
