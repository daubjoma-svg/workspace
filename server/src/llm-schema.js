// B1 AI 节点契约：runAI 出口的唯一真值。
// 字段集合三源合并：engine.js 下游实际消费 + PRD v0.5.3 §6.2 锁定清单 + 现有 mock 产物形状。
//
// 每个 action 的出口类型由下游消费方式决定（证据见文件末尾 SHAPE_BY_ACTION 注释），
// 不做"为了统一而统一"——把 markdown 产物强包成 JSON 会打断前端渲染。

'use strict';

const { z } = require('zod');

/** 所有结构化产物共有的元信息，便于观测与兜底溯源 */
const Meta = z.object({
  _source: z.enum(['llm', 'mock', 'fallback']).optional(),
  _raw: z.string().optional(),
});

/** PRECHECK：engine.js 消费 pass / questions；前端 NoteView 消费 summary / issues */
const PrecheckResult = Meta.extend({
  pass: z.boolean(),
  questions: z.array(z.string()).default([]),
  issues: z.array(z.string()).default([]),
  summary: z.string().optional(),
});

const ImpactScopeItem = z.object({
  module: z.string(),
  files: z.array(z.string()).default([]),
  apis: z.array(z.string()).default([]),
  tables: z.array(z.string()).default([]),
  controllers: z.array(z.object({
    class: z.string(),
    methods: z.array(z.string()).default([]),
  })).default([]),
  confidence: z.number().optional(),
});

/**
 * EVALUATE：engine.js 消费 level / rationality.verdict / attention_points / questions；
 * 前端 EvaluationView 消费 summary / scheduling / rationality.reason / effort / attention_points。
 * verdict 只允许 FEASIBLE / NEEDS_ATTENTION（FEASIBLE=可直接进入产品评审；NEEDS_ATTENTION=有风险但继续走）。
 * 关键信息缺失时由 questions 非空表达：engine 会 raiseClarifies 卡在评估节点，等需求发起人补充后重跑。
 */
const EvaluateResult = Meta.extend({
  level: z.enum(['L1', 'L2', 'L3', 'L4']),
  rationality: z.object({
    verdict: z.enum(['FEASIBLE', 'NEEDS_ATTENTION']),
    reason: z.string().optional(),
    existing_capability: z.string().optional(),
  }),
  // 模板 A 首屏摘要：需求发起人先看到是否值得排期、问题在哪里。
  summary: z.string().optional(),
  // 阻断性问题：非空时评估节点挂起为待澄清，需求发起人补充后 AI 重新评估；信息充足时为空数组。
  questions: z.array(z.string()).default([]),
  // AI 自评置信度 0-1：engine 用它判断"信息是否已足够"（≥0.8 不再挂起澄清）。
  // 新评估必须返回真实自评分，漏传不能作为成功产物落库；历史产物由展示层兼容缺失。
  confidence: z.number().min(0).max(1),
  scheduling: z.object({
    status: z.enum(['FAST_TRACK', 'READY', 'NEEDS_CONFIRMATION', 'HOLD']),
    advice: z.string(),
  }).optional(),
  // 需求评审专家视角：站在客户/产品角度评估（不是技术评审）
  perspectives: z.object({
    customer: z.string().optional(),   // 客户视角：业务价值/对客户的意义
    product: z.string().optional(),    // 产品视角：是否符合产品方向/优先级
  }).optional(),
  attention_points: z.array(z.string()).max(6).default([]),
  // 开发时长评估（核心产出：难度 + 人日）
  effort: z.object({
    min_days: z.number(),
    max_days: z.number(),
    confidence: z.number().optional(),
    basis: z.string().optional(),
  }),
  // 风险（产品/交付角度：数据缺失、范围不清、依赖外部等）
  risks: z.array(z.union([
    z.string(),
    z.object({ description: z.string().default(''), level: z.string().optional() }),
  ])).default([]),
});

/** TEST_CASE：前端 TestCaseView 以 Array.isArray(obj) 为渲染前提，出口必须是数组 */
const TestCaseItem = z.object({
  id: z.union([z.number(), z.string()]).default(0),
  type: z.string().default('正常流'),
  title: z.string(),
  steps: z.string().default(''),
  expect: z.string().default(''),
  result: z.string().default(''),
});
const TestCaseResult = z.array(TestCaseItem).min(1);

/** 长文类（PRD_GEN / DEV_PROMPT / CUSTOM）：LLM 裸 string 包成 { text } 校验，出口再解包回 string */
const DocResult = Meta.extend({
  text: z.string().min(1),
});

const SCHEMA_BY_ACTION = {
  PRECHECK: PrecheckResult,
  EVALUATE: EvaluateResult,
  TEST_CASE: TestCaseResult,
  PRD_GEN: DocResult,
  DEV_PROMPT: DocResult,
  CUSTOM: DocResult,
};

/**
 * 出口形状约定（下游消费证据）：
 *   object → engine.js:112/118/119 按对象取属性；前端 EvaluationView / NoteView
 *   array  → 前端 ReqDetail.tsx:68 Array.isArray(obj) 才渲染 TestCaseView
 *   text   → 前端 ReqDetail.tsx:71 catch 分支按 markdown 渲染，包成 JSON 会退化成 <pre>
 */
const SHAPE_BY_ACTION = {
  PRECHECK: 'object',
  EVALUATE: 'object',
  TEST_CASE: 'array',
  PRD_GEN: 'text',
  DEV_PROMPT: 'text',
  CUSTOM: 'text',
};

function schemaFor(action) {
  return SCHEMA_BY_ACTION[action] || DocResult;
}
function shapeFor(action) {
  return SHAPE_BY_ACTION[action] || 'text';
}

/** 最小兜底对象：保证下游不崩、流程可继续。PRECHECK 保守放行，不误杀需求 */
function minimalFallback(action, raw) {
  const text = typeof raw === 'string' ? raw : '';
  switch (action) {
    case 'PRECHECK':
      return { pass: true, questions: [], issues: [], summary: text.slice(0, 500) || 'AI 预检未返回结构化结果，已放行。', _source: 'fallback', _raw: text };
    case 'EVALUATE':
      return {
        level: 'L3',
        rationality: { verdict: 'FEASIBLE', reason: text.slice(0, 500) || 'AI 未返回结构化评估，已按中位档兜底，请人工复核。' },
        summary: 'AI 未生成有效评估摘要，请人工复核后再安排排期。',
        scheduling: { status: 'NEEDS_CONFIRMATION', advice: '建议先补充需求范围与验收标准，再进入排期。' },
        perspectives: {},
        attention_points: [],
        questions: [],
        confidence: 0,
        effort: { min_days: 3, max_days: 5, confidence: 0, basis: '兜底：AI 未给出开发时长评估' },
        risks: [],
        _source: 'fallback', _raw: text,
      };
    case 'TEST_CASE':
      return [{ id: 1, type: '正常流', title: 'AI 未返回结构化用例，请人工补充', steps: text.slice(0, 500), expect: '', result: '' }];
    case 'PRD_GEN':
    case 'DEV_PROMPT':
    case 'CUSTOM':
      // text-shape 兜底：直接返回字符串（不是包成对象），避免前端展示 raw JSON
      return text || '（AI 未返回内容）';
    default:
      return { text: text || '（AI 未返回内容）', _source: 'fallback' };
  }
}

module.exports = {
  Meta, PrecheckResult, EvaluateResult, TestCaseResult, TestCaseItem, DocResult, ImpactScopeItem,
  SCHEMA_BY_ACTION, SHAPE_BY_ACTION, schemaFor, shapeFor, minimalFallback,
};
