// 桩 LLM 服务：给端到端验证提供一个可控、永远返回合法 schema 的 openai-compat 接口。
// 只在验证脚本里使用，不参与运行时。用法：node scripts/stub-llm.js [port]

'use strict';

const http = require('http');

const PORT = Number(process.argv[2] || 4600);

// 覆盖 EVALUATE / DEV_PROMPT / TEST_CASE 三类 AI 节点的 schema
const EVALUATION = {
  rationality: { verdict: 'REASONABLE', reason: '桩服务返回的合规评估结论', existing_capability: '可复用现有用户模块' },
  clarify_questions: [],
  perspectives: { customer: '客户视角说明', product: '产品视角说明', engineering: '工程视角说明' },
  impact_scope: [{ module: 'qatestrepo', files: ['src/main/java/com/demo/controller/UserController.java'], apis: ['/api/users'], tables: ['user'], confidence: 0.8 }],
  level: 'L2',
  effort: { min_days: 1, max_days: 3, confidence: 0.7, basis: '桩服务估算' },
  risks: ['无显著风险'],
  suggested_test_focus: ['用户列表主流程'],
};

const DEV_PROMPT = {
  background: '桩服务生成的背景说明',
  goal: '桩服务生成的目标说明',
  scope: { in: ['用户列表'], out: ['权限体系'] },
  tech_context: '基于 qatestrepo 的 Spring Boot 服务',
  acceptance: ['列表可分页'],
  constraints: ['不改动现有表结构'],
  steps: ['新增 controller 方法'],
};

const TEST_CASE = {
  cases: [{
    id: 'TC-001', title: '用户列表分页', priority: 'P1', type: 'FUNCTIONAL',
    preconditions: ['已登录'], steps: ['访问列表页'], expected: '返回第一页数据',
  }],
};

/** 按 prompt 里出现的关键词粗略判断场景，返回对应的合法结构 */
function pick(prompt) {
  const p = String(prompt || '');
  if (p.includes('测试用例') || p.includes('TEST_CASE') || p.includes('用例')) return TEST_CASE;
  if (p.includes('开发提示词') || p.includes('DEV_PROMPT') || p.includes('研发')) return DEV_PROMPT;
  return EVALUATION;
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    let prompt = '';
    try {
      const body = JSON.parse(raw || '{}');
      prompt = (body.messages || []).map((m) => m.content).join('\n');
    } catch { /* 解析失败就按默认场景返回 */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(pick(prompt)) } }],
      usage: { prompt_tokens: 128, completion_tokens: 256 },
    }));
  });
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`stub-llm listening on 127.0.0.1:${PORT}\n`);
});
