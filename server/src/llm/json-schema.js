// 各 action 的 JSON Schema（手写，与 llm-schema.js 的 Zod 定义一一对应）。
// 不引入 zod-to-json-schema：仅 L1 需要 JSON Schema，手写版本可控且零新增依赖（风险 R-B1c）。
// 注意：json_schema 强约束模式要求根节点为 object，所以数组型产物（TEST_CASE）用 { cases: [] } 包一层，
// 解析后由 llm-call.js 的 normalizeToShape 解包回数组。

'use strict';

const strArray = { type: 'array', items: { type: 'string' } };

const PRECHECK = {
  type: 'object',
  properties: {
    pass: { type: 'boolean', description: '需求描述是否完整、可进入评估' },
    questions: { ...strArray, description: '需要 CSM 补充回答的澄清问题' },
    issues: { ...strArray, description: '发现的完整性问题' },
    summary: { type: 'string', description: '一句话预检结论' },
  },
  required: ['pass', 'questions', 'issues', 'summary'],
  additionalProperties: false,
};

const EVALUATE = {
  type: 'object',
  properties: {
    level: { type: 'string', enum: ['L1', 'L2', 'L3', 'L4', 'L5'], description: '改动等级' },
    rationality: {
      type: 'object',
      properties: {
        // P0 改造：AI 不再向 CSM 提问阻塞流程。FEASIBLE=可直接进入产品评审；NEEDS_ATTENTION=有风险但继续走
        verdict: { type: 'string', enum: ['FEASIBLE', 'NEEDS_ATTENTION'] },
        reason: { type: 'string' },
        existing_capability: { type: 'string' },
      },
      required: ['verdict', 'reason'],
      additionalProperties: false,
    },
    attention_points: {
      ...strArray,
      description: '给需求提出人的注意事项与需关注的地方，2-5 条，不提问只提示（可选）',
    },
    effort: {
      type: 'object',
      properties: {
        min_days: { type: 'number' }, max_days: { type: 'number' },
        confidence: { type: 'number' }, basis: { type: 'string' },
      },
      required: ['min_days', 'max_days'],
      additionalProperties: false,
    },
    impact_scope: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          module: { type: 'string' },
          files: { ...strArray, description: '必须是 code_context 中出现过的真实文件路径' },
          apis: strArray, tables: strArray, confidence: { type: 'number' },
        },
        required: ['module', 'files', 'apis', 'tables'],
        additionalProperties: false,
      },
    },
    risks: strArray,
    suggested_test_focus: strArray,
    perspectives: {
      type: 'object',
      properties: { customer: { type: 'string' }, product: { type: 'string' }, engineering: { type: 'string' } },
      required: ['customer', 'product', 'engineering'],
      additionalProperties: false,
    },
  },
  required: ['level', 'rationality', 'effort', 'impact_scope', 'risks', 'suggested_test_focus', 'perspectives'],
  additionalProperties: false,
};

const TEST_CASE = {
  type: 'object',
  properties: {
    cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          type: { type: 'string', description: '正常流 / 边界流 / 异常流 / 回归' },
          title: { type: 'string' }, steps: { type: 'string' }, expect: { type: 'string' },
          result: { type: 'string', description: '留空,由测试填写' },
        },
        required: ['id', 'type', 'title', 'steps', 'expect', 'result'],
        additionalProperties: false,
      },
    },
  },
  required: ['cases'],
  additionalProperties: false,
};

const DOC = {
  type: 'object',
  properties: { text: { type: 'string', description: 'Markdown 正文' } },
  required: ['text'],
  additionalProperties: false,
};

const BY_ACTION = { PRECHECK, EVALUATE, TEST_CASE, PRD_GEN: DOC, DEV_PROMPT: DOC, CUSTOM: DOC };

function jsonSchemaFor(action) {
  return BY_ACTION[action] || DOC;
}

/** 内嵌进 system prompt 的形状提示（L2/L3 用）。压成一行控制 token */
function schemaHint(action) {
  return [
    '输出格式要求：仅返回一个合法 JSON 对象，不要 markdown 代码块标记，不要任何解释性文字。',
    `JSON Schema 如下：${JSON.stringify(jsonSchemaFor(action))}`,
  ].join('\n');
}

module.exports = { jsonSchemaFor, schemaHint, BY_ACTION };
