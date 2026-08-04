// AI 执行器：根据节点 ai_action 生成产物。
// B1 契约：runAI 的出口形状由 action 决定且恒定（llm-schema.shapeFor），
// 无论走真实 LLM(L1/L2/L3)、schema 兜底还是 mock，下游消费方式都不变 —— engine.js 零改。

'use strict';

const { buildCodeContext } = require('./repo');
const logger = require('./logger');
const { schemaFor, shapeFor, minimalFallback } = require('./llm-schema');
const { callLLMStructured } = require('./llm-call');
const { activeProvider } = require('./llm/provider');
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

/** 把需求关联平台模块的代码上下文附加进 prompt。maxFiles 等预算参数必须透传（原实现丢弃） */
function withCodeContext(req, extra, opts = {}) {
  const mids = (req.module_ids || '').split(',').map((s) => parseInt(s, 10)).filter(Number.isInteger);
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
 * 执行一个 AI 动作。
 * @returns { content, model, meta } —— content 类型见 llm-schema.SHAPE_BY_ACTION：
 *          PRECHECK/EVALUATE = object，TEST_CASE = array，PRD_GEN/DEV_PROMPT/CUSTOM = string
 */
async function runAI(action, req, extra = {}) {
  const sys = buildSystemPrompt(action, extra);
  const merged = action === 'EVALUATE' ? withCodeContext(req, extra, { withFiles: false })
    : action === 'DEV_PROMPT' ? withCodeContext(req, extra, { withFiles: true, maxFiles: 6 })
      : extra;
  const usr = JSON.stringify({ requirement: req, ...merged }, null, 2);
  const codeCtx = merged.code_context;

  const provider = activeProvider();
  if (provider && provider.type !== 'mock') {
    const structured = await callLLMStructured(sys, usr, action, provider);
    if (structured) return structured;
  }

  const content = validateMock(action, buildMock(action, req, extra, codeCtx));
  logger.info('ai_mock_used', { action, provider_type: provider ? provider.type : 'none' });
  return {
    content,
    model: 'mock',
    meta: {
      provider_id: provider ? provider.id : null,
      provider_type: provider ? provider.type : null,
      model: provider ? provider.model : null,
      structured_level: 'mock',
      status: 'DEGRADED',
      degraded_reason: provider && provider.type !== 'mock' ? 'llm_unavailable' : 'no_provider',
      code_files_used: (codeCtx?.modules || []).flatMap((m) => (m.key_files || []).map((f) => `${m.module_key}/${f.path}`)),
    },
  };
}

module.exports = { runAI, SCENE_LABEL, withCodeContext, validateMock };
