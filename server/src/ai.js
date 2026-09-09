// AI 执行器：根据节点 ai_action 生成产物。
// B1 契约：runAI 的出口形状由 action 决定且恒定（llm-schema.shapeFor），
// 无论走真实 LLM(L1/L2/L3)、schema 兜底还是 mock，下游消费方式都不变 —— engine.js 零改。

'use strict';

const { buildCodeContext } = require('./repo');
const logger = require('./logger');
const { db } = require('./db');
const { schemaFor, shapeFor, minimalFallback } = require('./llm-schema');
const { callLLMStructured } = require('./llm-call');
const { activeProvider, resolveApiKey } = require('./llm/provider');
const { buildRequest, requestOnce, extractContent } = require('./llm-call');
const { runAgent } = require('./agent/loop');
const { runAiNodeWithAgent } = require('./agent/run-action');
const { buildRepoContexts, executeTool } = require('./agent/tools');
const mock = require('./llm/mock');

const SCENE_LABEL = {
  PRECHECK: '需求完整性预检',
  EVALUATE: '需求评估',
  PRD_GEN: 'PRD 生成',
  DEV_PROMPT: '研发提示词生成',
  TEST_CASE: '测试用例生成',
  CUSTOM: '自定义 AI 处理',
};

const SCENE_PROMPTS = {
  EVALUATE: '请结合【code_context】(关联平台模块的真实代码:目录结构)做【代码可行性分析】:影响范围尽量精确到模块/文件/接口,评估需求在现有代码基础上的可实现性、复用点与技术风险。',
  DEV_PROMPT: '请结合【code_context】(关联平台模块的真实代码:目录结构 + 关键文件内容)生成【代码级】研发实现指引:明确建议改动/新增的文件位置、可复用的现有类/接口、需要新增的接口签名,产出可直接喂给 Cursor/Claude Code 的 prompt。',
};

/** 把需求关联平台模块的代码上下文附加进 prompt。maxFiles 等预算参数必须透传（原实现丢弃）
 *  v0.7：业务模块 ID 从「requirement ↔ business_module」关联表取（req.module_ids 冗余列已被新架构替代，保留仅兼容老数据） */
function withCodeContext(req, extra, opts = {}) {
  const midsFromRbm = db.prepare('SELECT business_module_id FROM requirement_business_modules WHERE requirement_id=?')
    .all(req.id).map((r) => r.business_module_id);
  const midsCsv = (req.module_ids || '').split(',').map((s) => parseInt(s, 10)).filter(Number.isInteger);
  const mids = Array.from(new Set([...midsFromRbm, ...midsCsv]));
  const ctx = buildCodeContext(mids, opts);
  if (!ctx) return extra;
  return { ...extra, code_context: ctx };
}

function buildSystemPrompt(action, extra) {
  const sceneHint = SCENE_PROMPTS[action] || '';
  const custom = extra.custom_prompt ? `\n\n【该节点的额外要求】\n${extra.custom_prompt}` : '';
  return `你是需求交付 SOP 系统中的 AI 助手,正在执行【${SCENE_LABEL[action] || action}】。请基于输入给出结构化、专业、可落地的输出。${sceneHint}${custom}`;
}

function buildMock(action, req, extra, codeCtx) {
  switch (action) {
    case 'PRECHECK': return mock.mockPrecheck(req);
    case 'EVALUATE': return mock.mockEvaluate(req, codeCtx);
    case 'PRD_GEN': return mock.mockPRD(req, extra.evaluation);
    case 'DEV_PROMPT': return mock.mockDevPrompt(req, extra.prd, codeCtx);
    case 'TEST_CASE': return mock.mockTestCase();
    default: return mock.mockCustom(req, SCENE_LABEL[action] || action);
  }
}

/**
 * mock 产物同样过 Zod：防止 mock 与 schema 漂移后，降级路径反而产出下游消费不了的形状。
 * text 型 action 的 mock 是字符串，先包成 { text } 再校验，出口再解包。
 */
function validateMock(action, raw) {
  const isText = shapeFor(action) === 'text';
  const candidate = isText ? { text: String(raw ?? ''), _source: 'mock' } : raw;
  const parsed = schemaFor(action).safeParse(candidate);
  if (parsed.success) return isText ? parsed.data.text : parsed.data;
  logger.warn('mock_schema_invalid', {
    action, issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}:${i.code}`).join(','),
  });
  const fb = minimalFallback(action, isText ? String(raw ?? '') : '');
  return isText ? fb.text : fb;
}

/**
 * code_basis：本次喂给 LLM 的代码依据（AC-09 要 "模块@分支 + commit + 文件数"）。
 * 只有真的把 code_context 注入了 prompt 才有值；未关联模块 / 模块未同步 一律 null，
 * 不造占位数据——前端拿到 null 就该显示"无代码依据"，而不是显示一份看起来可信的假引用。
 */
function buildCodeBasis(codeCtx) {
  // v0.7：code_modules 不再有 module_key；用 repo_path 作为标识
  const mods = (codeCtx && Array.isArray(codeCtx.modules) ? codeCtx.modules : [])
    .filter((m) => m && (m.repo_path || m.repo_id))
    .map((m) => ({
      business_module: m.business_module || null,
      repo_id: m.repo_id || null,
      repo_path: m.repo_path || null,
      branch: m.branch || null,
      commit: m.commit || null,
      file_count: Number.isFinite(Number(m.file_count)) ? Number(m.file_count) : null,
    }));
  return mods.length ? { modules: mods } : null;
}

function codeFilesUsed(codeCtx) {
  return (codeCtx?.modules || [])
    .flatMap((m) => (m.key_files || []).map((f) => `${m.repo_path || m.repo_id}/${f.path}`));
}

/**
 * 执行一个 AI 动作。
 * @returns { content, model, meta } —— content 类型见 llm-schema.SHAPE_BY_ACTION：
 *          PRECHECK/EVALUATE = object，TEST_CASE = array，PRD_GEN/DEV_PROMPT/CUSTOM = string
 *          meta 恒含 is_mock / code_basis（artifact.meta 锁定契约字段），由 engine 落库
 */
async function runAI(action, req, extra = {}) {
  const sys = buildSystemPrompt(action, extra);
  const merged = action === 'EVALUATE' ? withCodeContext(req, extra, { withFiles: false })
    : action === 'DEV_PROMPT' ? withCodeContext(req, extra, { withFiles: false, maxFiles: 0 })  // DEV_PROMPT 只给模块列表+仓库路径，不嵌文件内容（避免 prompt 过大触发 traecli agent mode）
      : extra;
  // TEST_CASE 节点：注入研发提交物（分支 + 改动摘要），让 AI 能基于研发实际改的东西给测试建议
  const rdSub = (action === 'TEST_CASE')
    ? db.prepare('SELECT branch_url, pr_url, diff_summary, extra_docs, submitted_by, submitted_at FROM rd_submissions WHERE requirement_id=? ORDER BY id DESC LIMIT 1').get(req.id)
    : null;
  const usr = action === 'DEV_PROMPT'
    ? JSON.stringify({
        requirement: { title: req.title, description: req.description, customer: req.customer_name, priority: req.priority, target_version: req.target_version },
        modules: (merged.code_context?.modules || []).map((m) => ({ business: m.business_module, repo: m.repo_path, branch: m.branch })),
        prd: (typeof extra?.prd === 'string' ? extra.prd : (extra?.prd?.text || '')).slice(0, 2000),
      }, null, 2)
    : action === 'TEST_CASE'
      ? JSON.stringify({
          requirement: req,
          rd_submission: rdSub ? { ...rdSub, extra_docs: rdSub.extra_docs ? (() => { try { return JSON.parse(rdSub.extra_docs); } catch { return []; } })() : [] } : null,
          ...merged,
        }, null, 2)
      : JSON.stringify({ requirement: req, ...merged }, null, 2);

  const codeCtx = merged.code_context;
  const codeBasis = buildCodeBasis(codeCtx);
  const filesUsed = codeFilesUsed(codeCtx);

  const provider = activeProvider();
  // TEST_CASE 自读代码 + traecli 纯 LLM（和 DEV_PROMPT 一致架构，避免 traecli agent mode 输出 dump）
  if (action === 'TEST_CASE' && provider && provider.type !== 'mock') {
    // 铁律：研发未提交 git 分支 → AI 不生成测试用例（阻断，需研发先补「开发提交」）
    if (!rdSub || !rdSub.branch_url) {
      throw new Error('研发尚未提交 git 分支，无法生成测试用例。请研发先在「开发提交」中填写分支名/链接后重试。');
    }
    const r = await generateTestCaseDirect(req, merged, rdSub);
    if (r) {
      r.meta = { ...r.meta, code_basis: codeBasis, code_files_used: filesUsed };
      return r;
    }
  }
  let failMeta = null;
  if (provider && provider.type !== 'mock') {
    // P0 改造：AI 节点走 Agent 循环（多步查证代码 → schema 形状产物）。
    // Agent 失败/无可用 repos 时再降级到一次性 callLLMStructured，最后兜底 mock。
    // 不走"一次性 LLM 靠猜"的快速路径 —— 产物必须基于真实代码证据。
    const repoRows = db.prepare(`SELECT bm.name AS business_name, bmc.path_prefix, cm.*
      FROM requirement_business_modules rbm
      JOIN business_modules bm ON bm.id = rbm.business_module_id
      JOIN business_module_codes bmc ON bmc.business_module_id = bm.id
      JOIN code_modules cm ON cm.id = bmc.code_module_id
      WHERE rbm.requirement_id=? AND cm.sync_status='OK'`).all(req.id);
    const repos = buildRepoContexts(repoRows);
    // 用户要「快速失败」：单次跑 agent，超时立即 fallback，不重试
    const agentResult = await runAiNodeWithAgent({ action, req, extra, sys, usr, repos });
    if (agentResult) {
      agentResult.meta = { ...agentResult.meta, code_basis: codeBasis, code_files_used: filesUsed };
      return agentResult;
    }
    // Agent 失败（无可用 repos / 步数耗尽 / 校验不过 / 工具都读不到代码）：
    // 不再回退一次性 callLLMStructured —— 那会让模型"靠猜"写产物，
    // 违反"有证据才输出"原则。直接走 minimalFallback（标 is_mock=true + DEGRADED），
    // 前端从 meta.is_mock / status 看出产物为兜底。
    failMeta = { degraded_reason: 'agent_no_evidence', is_mock: true };
    const fallback = minimalFallback(action, '');
    logger.warn('ai_agent_failed_fallback', {
      action, req: req.id, repos_count: repos.length, reason: 'agent_returned_null',
    });
    return {
      content: fallback,
      model: provider ? provider.model : null,
      meta: {
        provider_id: provider ? provider.id : null,
        provider_type: provider ? provider.type : null,
        model: provider ? provider.model : null,
        structured_level: 'fallback',
        status: 'DEGRADED',
        degraded_reason: 'agent_no_evidence',
        latency_ms: null,
        attempt: 0,
        is_mock: true,
        code_basis: codeBasis,
        code_files_used: filesUsed,
      },
    };
  }

  const content = validateMock(action, buildMock(action, req, extra, codeCtx));
  logger.info('ai_mock_used', {
    action, provider_type: provider ? provider.type : 'none',
    reason: failMeta ? failMeta.degraded_reason : 'no_provider',
  });
  return {
    content,
    model: 'mock',
    meta: {
      provider_id: provider ? provider.id : null,
      provider_type: provider ? provider.type : null,
      model: provider ? provider.model : null,
      structured_level: 'mock',
      status: 'DEGRADED',
      degraded_reason: failMeta ? failMeta.degraded_reason
        : (provider && provider.type !== 'mock' ? 'llm_unavailable' : 'no_provider'),
      latency_ms: failMeta ? failMeta.latency_ms : null,
      attempt: failMeta ? failMeta.attempt : 0,
      is_mock: true,
      code_basis: codeBasis,
      code_files_used: filesUsed,
    },
  };
}

/**
 * 与 AI 产物继续对话（AI 追问，不落产物、不推进流程）。
 * 基于需求上下文 + 最近 AI 产物回答用户追问；复用 provider / API Key / 传输层（buildRequest+requestOnce）。
 * 无 provider 或调用失败 → 返回降级提示文案（不 mock 假回答）。
 */
async function aiChat(req, question, artifactKind, focusPaths = null) {
  const row = artifactKind
    ? db.prepare('SELECT * FROM artifacts WHERE requirement_id=? AND kind=? ORDER BY id DESC LIMIT 1').get(req.id, artifactKind)
    : db.prepare('SELECT * FROM artifacts WHERE requirement_id=? ORDER BY id DESC LIMIT 1').get(req.id);
  const rawContent = row ? row.content : null;
  const artifactText = rawContent == null ? null
    : (typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent, null, 2)).slice(0, 6000);

  const sys = '你是需求交付流水线上的 AI 分析助手。你有"手脚"：可以自主调用工具查询代码仓库（list_tree/list_dir/read_file/grep/glob）。'
    + '工作流：先 list_tree 了解仓库结构 → grep 找相关代码 → read_file 读关键文件 → 多步探索后给出依据充分、带文件路径与行号的回答。'
    + '回答用中文、结构化，引用具体代码文件作为依据；用户问"看不到代码"时直接调用工具查证。';

  // 永远走 Agent：AI 自主探索代码仓库回答（deepseek-harness 式 Agent 循环 + 工具集）
  return aiChatWithAgent(req, question, row, artifactText, focusPaths, sys);
}

/** 追问：我们自己读代码（list_tree/grep/read_file 拿真实路径），traecli 只当纯 LLM 回答。
 * 关键：prompt 不能含"工具/查代码"暗示（否则 traecli 进自己的 agent loop，输出 session dump 而非模型回复）。
 */
async function aiChatWithAgent(req, question, artifactRow, artifactText, focusPaths, sys) {
  const rows = db.prepare(`
    SELECT bm.name AS business_name, bmc.path_prefix, cm.*
    FROM requirement_business_modules rbm
    JOIN business_modules bm ON bm.id = rbm.business_module_id
    JOIN business_module_codes bmc ON bmc.business_module_id = bm.id
    JOIN code_modules cm ON cm.id = bmc.code_module_id
    WHERE rbm.requirement_id=?`).all(req.id);
  const repos = buildRepoContexts(rows);
  if (!repos.length) {
    return { reply: '该需求没有已同步的代码仓库快照，Agent 无法查询代码。请在「模块管理」里同步代码后重试。', model: null, provider_type: null };
  }
  const provider = activeProvider();
  const apiKey = provider && provider.type !== 'mock' ? resolveApiKey(provider) : null;
  if (!provider || provider.type === 'mock') {
    return { reply: '（当前未配置可用的 AI 模型，Agent 无法运行）可在「AI 配置」页启用模型后重试。', model: provider?.model || null, provider_type: provider?.type || null };
  }
  if (provider.type !== 'trae-cli' && !apiKey) {
    return { reply: '（当前未配置可用的 AI 模型，Agent 无法运行）可在「AI 配置」页启用模型后重试。', model: provider.model, provider_type: provider.type };
  }

  // ---- 1. 我们读代码：仓库结构 + 问题关键词 grep + 命中文件内容 ----
  const evidence = [];
  try {
    const tree = await executeTool(repos, 'list_tree', {});
    evidence.push('[仓库结构]\n' + String(tree).slice(0, 800));
  } catch (e) { evidence.push('[仓库结构] 读取失败'); }

  const q = question + ' ' + (req.title || '');
  const kwCn = (q.match(/[\u4e00-\u9fa5]{2,8}/g) || [])
    .filter((w) => !['什么', '为什么', '如何', '怎么', '一下', '是否', '哪些', '这个', '那个', '我们', '你们', '如果', '没有', '可以', '需要', '相关', '请问', '现在', '问题', '需求'].includes(w))
    .slice(0, 3);
  const kwEn = (q.match(/[a-zA-Z]{3,}/g) || []).slice(0, 2);
  const patterns = [...kwCn, ...kwEn].slice(0, 4);
  const hitFiles = [];
  for (const p of patterns) {
    try {
      const hits = await executeTool(repos, 'grep', { pattern: p, path: '' });
      const s = String(hits);
      evidence.push('[grep ' + p + ']\n' + s.slice(0, 400));
      const m = s.match(/^([^\n:]+)\.(java|js|ts|tsx|vue|xml|yml|yaml|kt|go|py):/gm);
      if (m) hitFiles.push(...m.map((x) => x.slice(0, -1)));
    } catch (e) { /* 单次 grep 失败不阻断 */ }
  }
  const files = [...new Set(hitFiles)].slice(0, 3);
  for (const f of files) {
    try {
      const content = await executeTool(repos, 'read_file', { path: f, max_chars: 2500 });
      evidence.push('[文件 ' + f + ']\n' + String(content).slice(0, 700));
    } catch (e) { /* 跳过 */ }
  }

  // ---- 2. traecli 纯 LLM 回答（无工具暗示）----
  const sys2 = '你是需求交付流水线上的 AI 分析助手。基于下方【代码证据】回答用户问题。不要调用任何工具，不要解释过程。';
  const prompt = [
    sys2,
    '\n需求：' + (req.title || '') + '（' + (req.req_no || '') + '）',
    artifactText ? ('\n【相关产物摘要】\n' + artifactText.slice(0, 1500)) : '',
    '\n【代码证据】\n' + evidence.join('\n\n'),
    '\n用户问题：' + question,
    '\n【要求】1) 中文回答，结构化，给出具体结论与建议；2) 代码引用只允许来自【代码证据】中的真实路径；证据里没有的标「未找到」，禁止编造类名/文件名；3) 若证据不足，明确说「当前代码快照未找到相关实现」并给排查方向。',
  ].join('\n');

  const reqBody = {
    body: { messages: [{ role: 'user', content: prompt }] },
    trae_token: apiKey || '',
    provider_type: provider.type,
  };
  let data;
  try {
    data = await requestOnce(reqBody, 120000);
  } catch (e) {
    return { reply: 'AI 调用失败：' + String(e.message || e).slice(0, 120), model: provider.model, provider_type: provider.type };
  }
  let raw = data?.choices?.[0]?.message?.content || '';
  if (!raw || !String(raw).trim()) {
    return { reply: 'AI 暂无返回，请稍后重试。', model: data?.model || provider.model, provider_type: provider.type };
  }
  raw = raw.replace(/^```(markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
  return { reply: raw, model: data?.model || provider.model, provider_type: provider.type };
}

/**
 * TEST_CASE 自读代码 + traecli 纯 LLM 输出 Markdown。
 * 上下文：需求 + 研发提交物（branch_url / diff_summary / extra_docs）。
 * 可选增强：如果用户连接了 GitHub MCP，尝试拉取 branch_url 的真实 diff（PR 链接更优先）。
 */
async function generateTestCaseDirect(req, merged, rdSub) {
  const provider = activeProvider();
  const apiKey = provider && provider.type !== 'mock' ? resolveApiKey(provider) : null;
  if (!provider || provider.type === 'mock') return null;
  if (provider.type !== 'trae-cli' && !apiKey) return null;

  // 读代码（基于需求关联的 repos）
  const repoRows = db.prepare(`SELECT bm.name AS business_name, bmc.path_prefix, cm.*
    FROM requirement_business_modules rbm
    JOIN business_modules bm ON bm.id = rbm.business_module_id
    JOIN business_module_codes bmc ON bmc.business_module_id = bm.id
    JOIN code_modules cm ON cm.id = bmc.code_module_id
    WHERE rbm.requirement_id=? AND cm.sync_status='OK'`).all(req.id);
  const repos = buildRepoContexts(repoRows);

  const evidence = [];
  if (repos.length) {
    try {
      const tree = await executeTool(repos, 'list_tree', {});
      evidence.push('[仓库结构]\n' + String(tree).slice(0, 600));
    } catch {}
    // 关键词 grep：RD 改动摘要里的词 + 需求关键词
    const kwSource = (rdSub?.diff_summary || '') + ' ' + (req.title || '') + ' ' + (rdSub?.branch_url || '');
    const cnWords = (kwSource.match(/[\u4e00-\u9fa5]{2,8}/g) || [])
      .filter((w) => !['什么', '为什么', '如何', '怎么', '一下', '是否', '这些', '那个', '我们', '如果', '可以', '需要', '相关'].includes(w))
      .slice(0, 3);
    const enWords = (kwSource.match(/[a-zA-Z]{4,}/g) || []).slice(0, 2);
    const patterns = [...new Set([...cnWords, ...enWords])].slice(0, 4);
    for (const p of patterns) {
      try {
        const hits = await executeTool(repos, 'grep', { pattern: p, path: '' });
        evidence.push('[grep ' + p + ']\n' + String(hits).slice(0, 400));
      } catch {}
    }
  }

  // 可选：GitHub MCP 拉真实 diff（如已连接）
  let ghDiff = '';
  if (rdSub?.pr_url || rdSub?.branch_url) {
    // 注意：connector 调用需通过 host，不能在服务端直接 mcp__ 调用。
    // 这里留 hook：前端/外部可注入 extra.gh_diff；服务端自身无法触发 MCP。
    // MVP 阶段：依赖研发手动写的 diff_summary 即可；GitHub connector 启用后由前端在「研发提交」时拉 diff 存入 extra_docs 或新字段。
  }

  const sys = '你是测试工程师。基于【研发提交物】与【代码证据】，给出该分支/改动的测试用例建议与重点。不要调用任何工具。';
  const rdSec = rdSub ? [
    '\n【研发提交】',
    '分支：' + (rdSub.branch_url || '未填'),
    rdSub.pr_url ? ('PR：' + rdSub.pr_url) : '',
    '改动点摘要：' + (rdSub.diff_summary || ''),
    rdSub.extra_docs && rdSub.extra_docs.length ? ('补充文档：' + (Array.isArray(rdSub.extra_docs) ? rdSub.extra_docs.join('、') : '')) : '',
    '提交人：' + (rdSub.submitted_by || '') + '  提交时间：' + (rdSub.submitted_at || ''),
  ].filter(Boolean).join('\n') : '\n【研发提交】尚未提交分支与改动摘要（请基于需求与代码证据给测试建议，并在注意点中提醒研发补提交）。';

  const prompt = [
    sys,
    '\n需求：' + (req.title || '') + '（' + (req.req_no || '') + '）',
    rdSec,
    '\n【代码证据】\n' + (evidence.join('\n\n') || '（无关联代码仓库快照）'),
    '\n【要求】1) 输出 Markdown，按结构：\n## 改动概览\n## 重点测试场景（按主流程/边界/异常分类）\n## 回归测试范围（受影响模块）\n## 易踩坑与兼容风险\n## 给研发的反馈（如有提交物不完整/可疑改动）；2) 中文；3) 引用【代码证据】中的真实文件路径。',
  ].join('\n');

  const reqBody = {
    body: { messages: [{ role: 'user', content: prompt }] },
    trae_token: apiKey || '',
    provider_type: provider.type,
  };
  let data;
  try { data = await requestOnce(reqBody, 120000); } catch { return null; }
  let raw = data?.choices?.[0]?.message?.content || '';
  if (!raw) return null;
  raw = raw.replace(/^```(markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (raw.length < 200) return null;
  return { content: raw, model: data?.model || provider.model, meta: { status: 'OK', structured_level: 'self_read', code_basis: evidence.join('\n').slice(0, 800) } };
}

module.exports = { runAI, SCENE_LABEL, withCodeContext, validateMock, buildCodeBasis, codeFilesUsed, aiChat };
