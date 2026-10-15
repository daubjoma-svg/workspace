/**
 * 临时回归脚本：AI 评估置信度链路。
 * 覆盖 ①schema 强制 confidence ②缺失不落库成功产物 ③mock/兜底产物合法
 * ④engine 门控阈值 ⑤前端展示判定。跑完即可删除。
 */
const assert = require('assert');
const { schemaFor, minimalFallback } = require('./src/llm-schema');
const mock = require('./src/llm/mock');
const { jsonSchemaFor, schemaHint } = require('./src/llm/json-schema');

let pass = 0; let fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { fail += 1; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const baseEval = {
  level: 'L2',
  rationality: { verdict: 'FEASIBLE', reason: '目标明确' },
  summary: '可以排期',
  scheduling: { status: 'READY', advice: '常规排期' },
  attention_points: [],
  questions: [],
  confidence: 0.85,
  effort: { min_days: 1, max_days: 3 },
  impact_scope: [], risks: [], suggested_test_focus: [], perspectives: {},
};

console.log('\n[1] Zod schema 强制 confidence');
const S = schemaFor('EVALUATE');
t('合法评估通过校验', () => assert.strictEqual(S.safeParse(baseEval).success, true));
t('缺 confidence 直接失败（不再当可选）', () => {
  const { confidence, ...noConf } = baseEval;
  const r = S.safeParse(noConf);
  assert.strictEqual(r.success, false);
  assert.ok(r.error.issues.some((i) => i.path.join('.') === 'confidence'));
});
t('confidence 为字符串失败', () => assert.strictEqual(S.safeParse({ ...baseEval, confidence: '0.9' }).success, false));
t('confidence 为 null 失败', () => assert.strictEqual(S.safeParse({ ...baseEval, confidence: null }).success, false));
t('confidence 超出 0-1 失败', () => {
  assert.strictEqual(S.safeParse({ ...baseEval, confidence: 1.2 }).success, false);
  assert.strictEqual(S.safeParse({ ...baseEval, confidence: -0.1 }).success, false);
});
t('confidence 边界 0 与 1 通过', () => {
  assert.strictEqual(S.safeParse({ ...baseEval, confidence: 0 }).success, true);
  assert.strictEqual(S.safeParse({ ...baseEval, confidence: 1 }).success, true);
});
t('attention_points 超过 6 条被拒', () => {
  const r = S.safeParse({ ...baseEval, attention_points: Array.from({ length: 7 }, (_, i) => `a${i}`) });
  assert.strictEqual(r.success, false);
});
t('questions 缺省为空数组', () => {
  const { questions, ...noQ } = baseEval;
  const r = S.safeParse(noQ);
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.data.questions, []);
});

console.log('\n[2] 供 LLM 的 JSON Schema 要求 confidence');
const ej = jsonSchemaFor('EVALUATE');
t('required 含 confidence', () => {
  assert.ok(ej.required.includes('confidence'), `required=${JSON.stringify(ej.required)}`);
});
t('confidence 声明为 number 且限定 0-1', () => {
  const p = ej.properties.confidence;
  assert.strictEqual(p.type, 'number');
  assert.strictEqual(p.minimum, 0);
  assert.strictEqual(p.maximum, 1);
});
t('summary/scheduling/questions 也在 required 内（模板 A 首屏字段）', () => {
  ['summary', 'scheduling', 'questions', 'attention_points'].forEach((k) => {
    assert.ok(ej.required.includes(k), `缺 ${k}`);
  });
});
t('注入 prompt 的 schemaHint 带上 confidence 说明', () => {
  const hint = schemaHint('EVALUATE');
  assert.ok(hint.includes('confidence'), 'schemaHint 未提到 confidence');
});

console.log('\n[3] mock 与兜底产物自身合法');
t('mockEvaluate 通过校验且带 confidence', () => {
  const m = mock.mockEvaluate({ id: 1, title: '普通需求', description: 'x' }, null);
  const r = S.safeParse(m);
  assert.strictEqual(r.success, true, JSON.stringify(r.error?.issues));
  assert.strictEqual(typeof m.confidence, 'number');
});
t('mock 有阻断问题时 confidence < 0.8（不会被门控放行）', () => {
  const m = mock.mockEvaluate({ id: 1, title: 'NEEDS_INFO 待补充', description: 'x' }, null);
  assert.ok(m.questions.length > 0, '应有阻断性问题');
  assert.ok(m.confidence < 0.8, `confidence=${m.confidence}`);
});
t('minimalFallback 通过校验且 confidence=0', () => {
  const f = minimalFallback('EVALUATE', 'AI 乱答');
  assert.strictEqual(S.safeParse(f).success, true);
  assert.strictEqual(f.confidence, 0);
});

console.log('\n[4] engine 澄清门控（复刻 engine.js 判定）');
const CLARIFY_MIN_CONFIDENCE = 0.8;
function gate(content) {
  const questions = Array.isArray(content.questions) ? content.questions.filter((q) => typeof q === 'string' && q.trim()) : [];
  const confidence = typeof content.confidence === 'number' ? content.confidence : null;
  const confident = confidence != null && confidence >= CLARIFY_MIN_CONFIDENCE;
  if (questions.length && confident) return 'SKIP';
  if (questions.length && !confident) return 'CLARIFY';
  return 'CONTINUE';
}
t('低置信 + 有问题 → 挂起澄清', () => assert.strictEqual(gate({ questions: ['q'], confidence: 0.4 }), 'CLARIFY'));
t('高置信 + 有问题 → 不再追问', () => assert.strictEqual(gate({ questions: ['q'], confidence: 0.9 }), 'SKIP'));
t('阈值 0.8 本身按足够处理', () => assert.strictEqual(gate({ questions: ['q'], confidence: 0.8 }), 'SKIP'));
t('无问题 → 直接推进', () => assert.strictEqual(gate({ questions: [], confidence: 0.5 }), 'CONTINUE'));
t('confidence 缺失且有问题 → 按不足挂起，不误放行', () => assert.strictEqual(gate({ questions: ['q'] }), 'CLARIFY'));
t('空白问题不触发澄清', () => assert.strictEqual(gate({ questions: ['  '], confidence: 0.3 }), 'CONTINUE'));

console.log('\n[5] 前端展示判定（复刻 ReqViews.tsx）');
function display(data) {
  const c = typeof data.confidence === 'number' && Number.isFinite(data.confidence)
    && data.confidence >= 0 && data.confidence <= 1 ? data.confidence : null;
  if (c === null) return { text: '本次评估未返回有效置信度，需重新评估', value: '—' };
  return { value: `${Math.round(c * 100)}%`, text: c >= 0.8 ? '信息已足够' : '信息仍有缺口，可能继续澄清' };
}
t('缺失时提示重新评估，不再说「升级前产出」', () => {
  const d = display({});
  assert.strictEqual(d.value, '—');
  assert.ok(!/升级前/.test(d.text), d.text);
  assert.ok(/重新评估/.test(d.text));
});
t('NaN / 字符串 / 越界都按缺失处理', () => {
  ['0.9', NaN, Infinity, null, 1.5, -0.2].forEach((v) => {
    assert.strictEqual(display({ confidence: v }).value, '—', `value=${v}`);
  });
});
t('高置信显示百分比与「信息已足够」', () => {
  const d = display({ confidence: 0.85 });
  assert.strictEqual(d.value, '85%');
  assert.strictEqual(d.text, '信息已足够');
});
t('低置信提示仍有缺口', () => {
  const d = display({ confidence: 0.35 });
  assert.strictEqual(d.value, '35%');
  assert.ok(/缺口/.test(d.text));
});
t('confidence=0 显示 0% 而非按缺失', () => assert.strictEqual(display({ confidence: 0 }).value, '0%'));
t('AI 置信度与工时置信度是不同字段', () => {
  assert.strictEqual(display({ effort: { confidence: 0.7 } }).value, '—');
});

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURE'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
