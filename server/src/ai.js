// AI 执行器：根据节点 ai_action 生成产物。
// B1 契约：runAI 的出口形状由 action 决定且恒定（llm-schema.shapeFor），
// 无论走真实 LLM(L1/L2/L3)、schema 兜底还是 mock，下游消费方式都不变 —— engine.js 零改。

'use strict';

const fs = require('fs');
const path = require('path');
const { buildCodeContext } = require('./repo');
const logger = require('./logger');
const { db } = require('./db');
const { schemaFor, shapeFor, minimalFallback } = require('./llm-schema');
const { callLLMStructured } = require('./llm-call');
const { activeProvider, resolveApiKey } = require('./llm/provider');
const { buildRequest, requestOnce, extractContent, extractJsonBlock } = require('./llm-call');
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
  EVALUATE: '请结合【code_context】(关联平台模块的真实代码:目录结构)做【代码可行性分析】:影响范围尽量精确到模块/文件/接口,评估需求在现有代码基础上的可实现性、复用点与技术风险。code_context.modules[].module_type 标识前端或后端，请按两端分别说明影响。',
  DEV_PROMPT: '请先透析问题并查证根因（优先验证全量加载、分页、搜索与刷新策略），再生成可直接交给研发 AI 的实现提示词。提示词必须说明推荐方案、前后端必要改动、跨业务影响与验收，禁止先罗列无关接口或文件。',
};

/** 把需求关联平台模块的代码上下文附加进 prompt。maxFiles 等预算参数必须透传（原实现丢弃）
 *  v0.7：业务模块 ID 从「requirement ↔ business_module」关联表取（req.module_ids 冗余列已被新架构替代，保留仅兼容老数据） */
async function withCodeContext(req, extra, opts = {}) {
  const midsFromRbm = (await db.many(
    'SELECT business_module_id FROM requirement_business_modules WHERE requirement_id=?',
    [req.id]
  )).map((r) => r.business_module_id);
  const midsCsv = (req.module_ids || '').split(',').map((s) => parseInt(s, 10)).filter(Number.isInteger);
  const mids = Array.from(new Set([...midsFromRbm, ...midsCsv]));
  const ctx = await buildCodeContext(mids, opts);
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
  const merged = action === 'EVALUATE' ? await withCodeContext(req, extra, { withFiles: false })
    : action === 'DEV_PROMPT' ? await withCodeContext(req, extra, { withFiles: false, maxFiles: 0 })  // DEV_PROMPT 只给模块列表+仓库路径，不嵌文件内容（避免 prompt 过大触发 traecli agent mode）
      : extra;
  // TEST_CASE 节点：注入研发提交物（分支 + 改动摘要），让 AI 能基于研发实际改的东西给测试建议
  const rdSub = (action === 'TEST_CASE')
    ? await db.one(
    'SELECT branch_url, pr_url, diff_summary, extra_docs, submitted_by, submitted_at FROM rd_submissions WHERE requirement_id=? ORDER BY id DESC LIMIT 1',
    [req.id]
  )
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

  const provider = await activeProvider();
  // 研发提示词必须来自真实模型与真实代码证据，禁止用 mock 内容伪造可执行开发方案。
  if (action === 'DEV_PROMPT' && (!provider || provider.type === 'mock')) {
    throw new Error('未配置可用的真实 AI 模型，无法生成研发提示词；请配置模型后重试。');
  }
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
    const repoRows = await db.many(`SELECT bm.name AS business_name, bmc.path_prefix, cm.*
      FROM requirement_business_modules rbm
      JOIN business_modules bm ON bm.id = rbm.business_module_id
      JOIN business_module_codes bmc ON bmc.business_module_id = bm.id
      JOIN code_modules cm ON cm.id = bmc.code_module_id
      WHERE rbm.requirement_id=? AND cm.sync_status='OK'`, [req.id]);
    const repos = buildRepoContexts(repoRows);
    // 用户要「快速失败」：单次跑 agent，超时立即 fallback，不重试
    const agentResult = await runAiNodeWithAgent({ action, req, extra, sys, usr, repos });
    if (agentResult) {
      agentResult.meta = { ...agentResult.meta, code_basis: codeBasis, code_files_used: filesUsed };
      return agentResult;
    }
    if (action === 'DEV_PROMPT') {
      throw new Error('研发提示词未获得有效的模型输出或代码证据，未生成兜底内容；请检查模型与代码快照后重试。');
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

  if (action === 'DEV_PROMPT') {
    throw new Error('研发提示词仅支持真实模型生成，未生成兜底内容；请配置模型后重试。');
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
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

/** 从问题文本（markdown 图片/裸 URL）与显式 images 里提取本地上传图片的绝对路径 */
function extractImagePaths(question, explicit) {
  const urls = [];
  const mdRe = /!?\[[^\]]*\]\(([^)\s]*\/uploads\/[^)\s]+)\)/g;
  let m;
  while ((m = mdRe.exec(String(question || ''))) !== null) urls.push(m[1]);
  const bareRe = /\/uploads\/[A-Za-z0-9._-]+/g;
  while ((m = bareRe.exec(String(question || ''))) !== null) urls.push(m[0]);
  for (const u of (Array.isArray(explicit) ? explicit : [])) {
    if (typeof u === 'string') urls.push(u);
  }
  const out = [];
  for (const u of urls) {
    const base = path.basename(String(u).split('?')[0]);
    if (!/^[A-Za-z0-9._-]+$/.test(base)) continue;
    const p = path.join(UPLOADS_DIR, base);
    if (p.startsWith(UPLOADS_DIR) && fs.existsSync(p) && fs.statSync(p).isFile()) out.push(p);
  }
  return [...new Set(out)];
}

/** 快照仓库归类：后端（pom/gradle/java）优先，其次前端（package.json + 前端框架/tsx/vue 源码） */
function classifyRepo(root) {
  if (!root) return 'unknown';
  const has = (f) => { try { return fs.existsSync(path.join(root, f)); } catch { return false; } };
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts') || has('settings.gradle') || has('settings.gradle.kts')) return 'backend';
  try { if (fs.statSync(path.join(root, 'src/main/java')).isDirectory()) return 'backend'; } catch { /* 不存在 */ }
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.react || deps.vue || deps.next || deps.nuxt || deps.vite || deps.svelte || deps['@angular/core']) return 'frontend';
    } catch { /* package.json 解析失败继续用文件特征判断 */ }
    for (const d of ['src', 'app', 'pages']) {
      try {
        const dir = path.join(root, d);
        if (!fs.statSync(dir).isDirectory()) continue;
        if (fs.readdirSync(dir).some((f) => /\.(tsx|jsx|vue)$/.test(f))) return 'frontend';
      } catch { /* 目录不存在 */ }
    }
    return 'frontend';
  }
  return 'unknown';
}

/** 前端/后端 scope 归一化：接受 FE/RD/frontend/backend/server 等写法 */
function normalizeScope(s) {
  const v = String(s || '').trim().toLowerCase();
  if (v === 'fe' || v === 'frontend' || v === 'front' || v === '前端') return 'frontend';
  if (v === 'rd' || v === 'be' || v === 'backend' || v === 'server' || v === '后端' || v === '服务端') return 'backend';
  return null;
}

/** 按用户勾选的前端/后端 scope 过滤仓库；两个都选/都不选 = 全部。命中为空则退回全部（不把问题变成"无仓库可查"）。 */
function pickReposByScope(repos, scopes) {
  const want = new Set((Array.isArray(scopes) ? scopes : []).map(normalizeScope).filter(Boolean));
  if (want.size === 0 || want.size >= 2) return repos;
  const hit = repos.filter((r) => want.has(classifyRepo(r.root)));
  return hit.length ? hit : repos;
}

/**
 * 与 AI 产物继续对话（AI 追问）。
 * 底层用 traecli 原生 Agent（deepseek-harness）：把仓库快照挂进工作区，AI 自主检索/读文件；
 * 用户截图通过 --image 交给模型做视觉理解。不再由服务端"猜关键词 grep 3 个文件"。
 */
async function aiChat(req, question, artifactKind, opts = {}) {
  const [row, evaluationRow, chatRows] = await Promise.all([
    artifactKind
    ? db.one(
    'SELECT * FROM artifacts WHERE requirement_id=? AND kind=? ORDER BY id DESC LIMIT 1',
    [req.id, artifactKind]
  )
    : db.one(
    'SELECT * FROM artifacts WHERE requirement_id=? ORDER BY id DESC LIMIT 1',
    [req.id]
  ),
    db.one(
      "SELECT content FROM artifacts WHERE requirement_id=? AND kind='EVALUATION' ORDER BY id DESC LIMIT 1",
      [req.id]
    ),
    // 最近 10 轮足以保持话题连续，同时避免历史无限增长挤占模型的代码检索空间。
    db.many(
      'SELECT question, reply FROM req_ai_chats WHERE requirement_id=? ORDER BY id DESC LIMIT 10',
      [req.id]
    ),
  ]);
  const rawContent = row ? row.content : null;
  const artifactText = rawContent == null ? null
    : (typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent, null, 2)).slice(0, 6000);
  const evaluationText = evaluationRow?.content == null ? null
    : (typeof evaluationRow.content === 'string' ? evaluationRow.content : JSON.stringify(evaluationRow.content, null, 2)).slice(0, 6000);
  const historyText = chatRows.reverse().map((chat, index) => [
    `第 ${index + 1} 轮用户追问：${String(chat.question || '').slice(0, 1200)}`,
    `第 ${index + 1} 轮 AI 回答：${String(chat.reply || '').slice(0, 1800)}`,
  ].join('\n')).join('\n\n');
  const scopes = Array.isArray(opts.scopes) ? opts.scopes : null;
  const images = Array.isArray(opts.images) ? opts.images : null;
  return aiChatWithAgent(req, question, { artifactText, evaluationText, historyText }, scopes, images);
}

async function aiChatWithAgent(req, question, context, scopes, explicitImages) {
  const { artifactText, evaluationText, historyText } = context;
  const provider = await activeProvider();
  const apiKey = provider && provider.type !== 'mock' ? resolveApiKey(provider) : null;
  if (!provider || provider.type === 'mock') {
    return { reply: '（当前未配置可用的 AI 模型，无法查询代码）可在「AI 配置」页启用模型后重试。', model: provider?.model || null, provider_type: provider?.type || null };
  }
  if (provider.type !== 'trae-cli' && !apiKey) {
    return { reply: '（当前未配置可用的 AI 模型，无法查询代码）可在「AI 配置」页启用模型后重试。', model: provider.model, provider_type: provider.type };
  }

  const rows = await db.many(`
    SELECT bm.name AS business_name, bmc.path_prefix, cm.*
    FROM requirement_business_modules rbm
    JOIN business_modules bm ON bm.id = rbm.business_module_id
    JOIN business_module_codes bmc ON bmc.business_module_id = bm.id
    JOIN code_modules cm ON cm.id = bmc.code_module_id
    WHERE rbm.requirement_id=? AND cm.sync_status='OK'`, [req.id]);
  const allRepos = buildRepoContexts(rows);
  const repos = pickReposByScope(allRepos, scopes);
  // 首轮需求描述里的截图与本轮追问图片同等重要：两者都要通过 ACP 传给视觉模型。
  // 过去只解析 question，导致已附在需求正文中的问题截图没有进入模型上下文。
  const images = extractImagePaths(`${req.description || ''}\n${question || ''}`, explicitImages);

  const scopeTags = new Set((Array.isArray(scopes) ? scopes : []).map(normalizeScope).filter(Boolean));
  const scopeLabel = scopeTags.size === 0 || scopeTags.size >= 2
    ? '全部（前端 + 服务端）'
    : (scopeTags.has('frontend') ? '仅前端' : '仅服务端');

  // 非 trae-cli（HTTP provider）无法挂工作区读代码，只能把图片线索+说明交给模型（降级）
  if (provider.type !== 'trae-cli') {
    return aiChatHttpFallback(provider, apiKey, req, question, context, images, scopeLabel);
  }

  if (!repos.length && !images.length) {
    return { reply: '该需求没有已同步的代码仓库快照，AI 无法查询代码。请在「模块管理」里同步代码后重试。', model: provider.model, provider_type: provider.type };
  }

  const primary = repos[0];
  const prompt = [
    '你是需求交付 SOP 流水线的 AI 分析助手。你现在已经处于该需求关联代码仓库的工作区里，请**自主使用你的检索/读取文件能力**查证后再回答，禁止凭空猜测。',
    '',
    '【需求】' + (req.title || '') + (req.req_no ? '（' + req.req_no + '）' : ''),
    req.description ? ('【需求描述】' + String(req.description).replace(/<[^>]+>/g, ' ').slice(0, 800)) : '',
    evaluationText ? ('【首轮上下文：AI 评估报告】\n' + evaluationText) : '【首轮上下文：AI 评估报告】暂未生成',
    artifactText ? ('【当前节点产物摘要】\n' + artifactText.slice(0, 1500)) : '',
    historyText ? ('【已保存的历史追问】\n' + historyText) : '',
    '',
    '【本次代码范围】' + scopeLabel + (repos.length ? ('；工作区仓库：' + repos.map((r) => r.repo_path || r.repo_id).join('、')) : '；本次没有可用的代码仓库快照，只能基于图片与需求文本作答'),
    '',
    images.length ? `【首轮需求截图】已随本次请求提供 ${images.length} 张，请优先查看需求正文中的截图，再结合当前追问分析。` : '',
    '【用户问题】' + question,
    '',
    '【要求】',
    '1. 如果用户提供了截图，请先查看并理解截图内容（界面、报错、字段等），把截图信息作为定位问题的关键线索。',
    '2. 必须真的检索并打开相关代码后再下结论；引用真实文件相对路径 + 行号（例如 `src/xxx/Foo.java:120`），不要编造类名/接口/文件名。',
    '3. 按「结论 → 代码依据（文件:行）→ 影响与建议」组织回答，用中文、Markdown，重点突出。',
    '4. 找不到对应实现时，明确写出「未找到」并给出下一步排查方向，不要含糊其辞。',
    '5. 只读探索，不要修改任何文件。',
  ].filter(Boolean).join('\n');

  const reqBody = {
    body: { messages: [{ role: 'user', content: prompt }], model: provider.model },
    trae_token: apiKey || '',
    provider_type: provider.type,
    trae_cli: {
      sandbox: 'read-only',
      cwd: primary ? primary.root : undefined,
      addDirs: repos.slice(1).map((r) => r.root).filter(Boolean),
      images,
    },
  };
  let data;
  try {
    data = await requestOnce(reqBody, 240000);
  } catch (e) {
    return { reply: 'AI 调用失败：' + String(e.message || e).slice(0, 160), model: provider.model, provider_type: provider.type };
  }
  let raw = data?.choices?.[0]?.message?.content || '';
  if (!raw || !String(raw).trim()) {
    return { reply: 'AI 暂无返回，请稍后重试。', model: data?.model || provider.model, provider_type: provider.type };
  }
  raw = raw.replace(/^```(markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
  return { reply: raw, model: data?.model || provider.model, provider_type: provider.type };
}

/** 非 CLI provider（无文件工作区能力）的降级：把截图说明交给多模态 LLM，并提示无法直接检索仓库 */
async function aiChatHttpFallback(provider, apiKey, req, question, context, images, scopeLabel) {
  const { artifactText, evaluationText, historyText } = context;
  const sys = '你是需求交付流水线上的 AI 分析助手。基于需求上下文与用户截图回答，不要编造代码类名/文件路径。';
  const prompt = [
    sys,
    '\n需求：' + (req.title || '') + (req.req_no ? '（' + req.req_no + '）' : ''),
    evaluationText ? ('\n【首轮上下文：AI 评估报告】\n' + evaluationText) : '',
    artifactText ? ('\n【相关产物摘要】\n' + artifactText.slice(0, 1500)) : '',
    historyText ? ('\n【已保存的历史追问】\n' + historyText) : '',
    '\n【代码范围】' + scopeLabel + '（当前模型无文件工作区，无法直接检索仓库，请说明这一点）',
    images.length ? ('\n【用户上传了 ' + images.length + ' 张截图】请结合截图内容回答。') : '',
    '\n用户问题：' + question,
  ].filter(Boolean).join('\n');
  const reqBody = {
    body: { messages: [{ role: 'user', content: prompt }] },
    trae_token: apiKey || '',
    provider_type: provider.type,
  };
  try {
    const data = await requestOnce(reqBody, 120000);
    let raw = data?.choices?.[0]?.message?.content || '';
    if (!raw.trim()) return { reply: 'AI 暂无返回，请稍后重试。', model: data?.model || provider.model, provider_type: provider.type };
    raw = raw.replace(/^```(markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
    return { reply: raw, model: data?.model || provider.model, provider_type: provider.type };
  } catch (e) {
    return { reply: 'AI 调用失败：' + String(e.message || e).slice(0, 160), model: provider.model, provider_type: provider.type };
  }
}

/**
 * 按产品意图生成/修改 PRD（产品在详情页手动触发，非 SOP 节点）。
 * 复用 trae-cli 工作区 + 截图视觉理解链路（同 aiChat）；已有 PRD 时以其为底稿按意图修改。
 * 只返回 Markdown 正文不落库：由前端预填进编辑器，产品检查修改后走既有产物接口保存为新版本。
 */
async function generatePrd(req, intent, explicitImages) {
  const [evaluationRow, prdRow] = await Promise.all([
    db.one("SELECT content FROM artifacts WHERE requirement_id=? AND kind='EVALUATION' ORDER BY id DESC LIMIT 1", [req.id]),
    db.one("SELECT content FROM artifacts WHERE requirement_id=? AND kind='PRD' ORDER BY id DESC LIMIT 1", [req.id]),
  ]);
  const evaluationText = evaluationRow?.content == null ? null
    : (typeof evaluationRow.content === 'string' ? evaluationRow.content : JSON.stringify(evaluationRow.content)).slice(0, 6000);
  const prdText = prdRow?.content == null ? null
    : (typeof prdRow.content === 'string' ? prdRow.content : JSON.stringify(prdRow.content)).slice(0, 12000);

  const provider = await activeProvider();
  const apiKey = provider && provider.type !== 'mock' ? resolveApiKey(provider) : null;
  if (!provider || provider.type === 'mock' || (provider.type !== 'trae-cli' && !apiKey)) {
    throw new Error('未配置可用的 AI 模型，无法生成 PRD；请在「AI 配置」启用模型后重试。');
  }

  const inWorkspace = provider.type === 'trae-cli';
  let repos = [];
  if (inWorkspace) {
    const rows = await db.many(`
      SELECT bm.name AS business_name, bmc.path_prefix, cm.*
      FROM requirement_business_modules rbm
      JOIN business_modules bm ON bm.id = rbm.business_module_id
      JOIN business_module_codes bmc ON bmc.business_module_id = bm.id
      JOIN code_modules cm ON cm.id = bmc.code_module_id
      WHERE rbm.requirement_id=? AND cm.sync_status='OK'`, [req.id]);
    repos = buildRepoContexts(rows);
  }
  // 需求正文里的截图与本轮随意图上传的截图同等对待，都要交给视觉模型
  const images = extractImagePaths(`${req.description || ''}\n${intent}`, explicitImages);

  const prompt = [
    '你是资深产品经理，在需求交付 SOP 系统中为下面的需求撰写 PRD 文档。',
    inWorkspace
      ? '你处于该需求关联代码仓库的工作区里，涉及现有实现时请先自主检索代码查证，引用真实文件路径，禁止编造接口/字段。'
      : '当前无法检索代码仓库，请基于需求描述与截图写作，不要编造具体文件路径或接口名。',
    '',
    '【需求】' + (req.title || '') + (req.req_no ? '（' + req.req_no + '）' : ''),
    req.description ? ('【需求描述】' + String(req.description).replace(/<[^>]+>/g, ' ').slice(0, 800)) : '',
    evaluationText ? ('【AI 评估报告】\n' + evaluationText) : '',
    prdText ? ('【现有 PRD 底稿】（产品要求在其基础上修改，未涉及意图的部分保持稳定）\n' + prdText) : '',
    '',
    '【产品意图】\n' + intent,
    images.length ? `\n【截图】已随请求提供 ${images.length} 张，涉及界面布局/字段/交互以截图为准，请先查看截图再写作。` : '',
    '',
    '【输出要求】',
    '1. 直接输出完整 PRD 正文（Markdown），不要任何解释性前后缀，不要用代码围栏包裹整篇。',
    '2. 结构：背景 → 目标 → 功能范围 → 功能详情（按模块/页面分节）→ 边界与异常 → 验收标准。',
    '3. 严格贯彻【产品意图】：有底稿时只修改意图涉及的部分，其余内容保持原样；无底稿时完整成文。',
    '4. 验收标准必须可验证；描述存量行为时以真实代码/截图为依据。',
  ].filter(Boolean).join('\n');

  const reqBody = inWorkspace ? {
    body: { messages: [{ role: 'user', content: prompt }], model: provider.model },
    trae_token: apiKey || '',
    provider_type: provider.type,
    trae_cli: {
      sandbox: 'read-only',
      cwd: repos[0] ? repos[0].root : undefined,
      addDirs: repos.slice(1).map((r) => r.root).filter(Boolean),
      images,
    },
  } : {
    body: { messages: [{ role: 'user', content: prompt }] },
    trae_token: apiKey || '',
    provider_type: provider.type,
  };
  const data = await requestOnce(reqBody, inWorkspace ? 300000 : 180000);
  let raw = data?.choices?.[0]?.message?.content || '';
  if (!String(raw).trim()) throw new Error('AI 暂无返回，请稍后重试。');
  raw = String(raw).replace(/^```(markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
  return { content: raw, model: data?.model || provider.model, provider_type: provider.type };
}

/**
 * TEST_CASE 自读代码 + traecli 纯 LLM 输出 Markdown。
 * 上下文：需求 + 研发提交物（branch_url / diff_summary / extra_docs）。
 * 可选增强：如果用户连接了 GitHub MCP，尝试拉取 branch_url 的真实 diff（PR 链接更优先）。
 */
async function generateTestCaseDirect(req, merged, rdSub) {
  const provider = await activeProvider();
  const apiKey = provider && provider.type !== 'mock' ? resolveApiKey(provider) : null;
  if (!provider || provider.type === 'mock') return null;
  if (provider.type !== 'trae-cli' && !apiKey) return null;

  // 读代码（基于需求关联的 repos）
  const repoRows = await db.many(`SELECT bm.name AS business_name, bmc.path_prefix, cm.*
    FROM requirement_business_modules rbm
    JOIN business_modules bm ON bm.id = rbm.business_module_id
    JOIN business_module_codes bmc ON bmc.business_module_id = bm.id
    JOIN code_modules cm ON cm.id = bmc.code_module_id
    WHERE rbm.requirement_id=? AND cm.sync_status='OK'`, [req.id]);
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

  const sys = '你是测试工程师。基于【研发提交物】与【代码证据】产出结构化测试用例。不要调用任何工具，只输出 JSON。';
  const rdSec = rdSub ? [
    '\n【研发提交】',
    '分支：' + (rdSub.branch_url || '未填'),
    rdSub.pr_url ? ('PR：' + rdSub.pr_url) : '',
    '改动点摘要：' + (rdSub.diff_summary || ''),
    rdSub.extra_docs && rdSub.extra_docs.length ? ('补充文档：' + (Array.isArray(rdSub.extra_docs) ? rdSub.extra_docs.join('、') : '')) : '',
    '提交人：' + (rdSub.submitted_by || '') + '  提交时间：' + (rdSub.submitted_at || ''),
  ].filter(Boolean).join('\n') : '\n【研发提交】尚未提交分支与改动摘要（请基于需求与代码证据给测试建议，并在注意点中提醒研发补提交）。';

  // 测试用例模板：固定 JSON 数组，前端按表格渲染并记录执行结果。
  // 硬约束「短句 + 编号步骤 + 一句话预期」，避免输出大段文字让测试看不懂重点。
  const template = [
    '{"id":1,"type":"正常流","title":"主流程一句话用例名","steps":"1) 前置操作；2) 执行动作；3) 查看结果","expect":"一句话说明正确表现","result":""}',
  ].join('\n');
  const rule = [
    '1) 只输出一个 JSON 数组，不要 Markdown、代码围栏、解释或前后缀文字。',
    '2) 每条固定 6 个字段：id(number，从 1 递增)、type(只能是「正常流」「边界流」「异常流」)、title(用例名，≤20 字)、steps(编号短句，最多 3 步，每步 ≤20 字)、expect(预期结果，一句话 ≤30 字)、result(固定空字符串)。',
    '3) 用例总数 5-10 条：正常流覆盖研发改动的主流程；边界流覆盖临界值/空值/最大最小；异常流覆盖错误输入、无权限、网络或依赖失败。',
    '4) 只写测试需要执行的动作和需要看到的结果，不要复述需求、不要写实现原理、不要罗列「未找到」。',
    '5) 优先覆盖研发【改动点摘要】里的功能；有代码证据时在 title 或 steps 中带上真实页面/接口名，没有证据就只写可观察的界面行为。',
    '6) 需求越小，用例越少（小需求 5 条左右即可），禁止为凑数造重复用例。',
  ].join('\n');
  const prompt = [
    sys,
    '\n需求：' + (req.title || '') + '（' + (req.req_no || '') + '）',
    rdSec,
    '\n【代码证据】\n' + (evidence.join('\n\n') || '（无关联代码仓库快照）'),
    '\n【输出格式（JSON 数组，元素形如）】\n' + template,
    '\n【硬约束】\n' + rule,
  ].join('\n');

  const reqBody = {
    body: { messages: [{ role: 'user', content: prompt }] },
    trae_token: apiKey || '',
    provider_type: provider.type,
  };
  let data;
  try { data = await requestOnce(reqBody, 120000); } catch { return null; }
  const raw = data?.choices?.[0]?.message?.content || '';
  if (!raw) return null;
  // 出口必须是数组：前端 TestCaseView 以 Array.isArray 为前提，给 Markdown 会退化成纯文本。
  const block = extractJsonBlock(String(raw).trim());
  const parsed = schemaFor('TEST_CASE').safeParse(block);
  if (!parsed.success) {
    logger.warn('test_case_direct_schema_fail', {
      req: req.id,
      issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}:${i.code}`).join(','),
    });
    return null;
  }
  return { content: parsed.data, model: data?.model || provider.model, meta: { status: 'OK', structured_level: 'self_read', code_basis: evidence.join('\n').slice(0, 800) } };
}

module.exports = { runAI, SCENE_LABEL, withCodeContext, validateMock, buildCodeBasis, codeFilesUsed, aiChat, generatePrd };
