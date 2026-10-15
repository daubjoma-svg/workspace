// AC-12 / F2 回显：把「AI 到底看了哪些文件」变成可核查的清单。
//
// 安全约束（B6 同族风险面）：本视图直接把仓库文件清单吐给前端，必须与 AI prompt 走【同一条】
// 过滤链 —— repo/code-context.buildCodeContext 内部已做 L1 isSensitiveFile 剔除 + L2 redactSecrets 脱敏。
// 这里绝不另开 fs 读取路径，只消费 buildCodeContext 的产物，并且【只回文件路径与字符数，不回文件内容】：
// 少一条内容通道就少一个泄漏面，回显的目的是让人判断可信度，不是让人在前端读源码。

'use strict';

const { db } = require('./../db');
const { buildCodeContext } = require('./../repo');
const { isSensitiveFile } = require('./../repo/sensitive');
const logger = require('./../logger');

// 与 ai.js runAI 的 DEV_PROMPT 预算保持一致，回显的清单才等于实际注入的清单
const DEV_PROMPT_OPTS = { withFiles: true, maxFiles: 6 };
const MAX_CHARS_PER_FILE = 2500;
const BUDGET_CHARS = 16000;      // SPEC §10：代码上下文注入 ≤16000 字符

async function mappingIdsOf(requirement) {
  // v0.7：业务模块 ID 替代旧 mapping_id（CSM 提单时选业务模块，AI 上下文按业务模块收集挂载的代码仓库）
  const rows = await db.many(
    'SELECT business_module_id FROM requirement_business_modules WHERE requirement_id=?',
    [requirement.id]
  );
  if (rows.length) return rows.map((r) => r.business_module_id);
  // 回落到冗余列（v0.6 是 mapping_id，新 v0.7 是 business_module_id）兼容历史数据
  return String(requirement.module_ids || '')
    .split(',').map((s) => Number.parseInt(s, 10)).filter(Number.isInteger);
}

/** 未同步 / 未关联模块时的空视图：字段齐全，前端不需要写 undefined 判断 */
function emptyView(note, modules = []) {
  return {
    generated_at: new Date().toISOString(),
    action: 'DEV_PROMPT',
    total_chars: 0,
    budget_chars: BUDGET_CHARS,
    truncated: false,
    note,
    modules,
  };
}

/**
 * 组装 openapi components.schemas.CodeContextResponse。
 * @returns {object} 永远返回对象；无可用上下文时 modules 为空数组并带 note
 */
async function buildCodeContextView(requirement) {
  const mids = await mappingIdsOf(requirement);
  if (!mids.length) return emptyView('该需求未关联平台模块，AI 未读取任何代码');

  const ctx = await buildCodeContext(mids, DEV_PROMPT_OPTS);
  if (!ctx) return emptyView('关联的平台模块已失效或不存在');
  if (!Array.isArray(ctx.modules) || !ctx.modules.length) return emptyView(ctx.note || '无可用代码快照');
  if (ctx.note) {
    // buildCodeContext 的"未同步"分支：只有 {platform, module, status}，没有文件清单
    return emptyView(ctx.note, ctx.modules.map((m) => ({
      platform: m.platform || null, module_key: null, branch: null, commit: null,
      sync_status: m.status || 'UNKNOWN', tree_entries: 0, files: [],
    })));
  }

  let total = 0;
  let truncated = false;
  let leaked = 0;
  const modules = ctx.modules.map((m) => {
    const files = (m.key_files || []).map((f) => {
      // 双保险：buildCodeContext 已经过滤过，这里再核一次；命中说明过滤链有洞，必须能报警
      if (isSensitiveFile(f.path)) { leaked += 1; return null; }
      const chars = (f.content || '').length;
      total += chars;
      const cut = chars >= MAX_CHARS_PER_FILE;
      if (cut) truncated = true;
      return { path: f.path, chars, truncated: cut };
    }).filter(Boolean);
    return {
      platform: m.platform || null,
      module_key: m.module_key || null,
      branch: m.branch || null,
      commit: m.commit || null,
      sync_status: 'OK',
      tree_entries: m.tree ? m.tree.split('\n').filter(Boolean).length : 0,
      files,
    };
  });

  if (leaked) {
    logger.error('code_context_sensitive_leak_blocked', { requirement_id: requirement.id, count: leaked });
  }
  if (total > BUDGET_CHARS) truncated = true;

  return {
    generated_at: new Date().toISOString(),
    action: 'DEV_PROMPT',
    total_chars: total,
    budget_chars: BUDGET_CHARS,
    truncated,
    modules,
  };
}

module.exports = { BUDGET_CHARS, buildCodeContextView, mappingIdsOf };
