/**
 * 临时回归脚本：parseAndValidate 对 EVALUATE 漏传 confidence 的处理。
 * run-action.js 未导出该函数，用 jscodeshift 无关的最小做法：读源码后在隔离模块里求值。
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

// 直接 require 内部模块拿到 parseAndValidate：改用注入方式暴露测试钩子过重，
// 这里用 Module.prototype.require 不改源码地取私有函数。
const runActionPath = path.join(__dirname, 'src/agent/run-action.js');
const src = require('fs').readFileSync(runActionPath, 'utf8');
const patched = src.replace(
  'module.exports = {',
  'module.exports = { __test: { parseAndValidate, completeEvaluationDefaults, normalizeVerdict },'
);
const m = new Module(runActionPath, null);
m.filename = runActionPath;
m.paths = Module._nodeModulePaths(path.dirname(runActionPath));
m._compile(patched, runActionPath);
const { parseAndValidate, completeEvaluationDefaults } = m.exports.__test;

let pass = 0; let fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { fail += 1; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const full = {
  level: 'L2',
  rationality: { verdict: 'FEASIBLE', reason: '目标明确' },
  summary: '可以排期',
  scheduling: { status: 'READY', advice: '常规排期' },
  attention_points: [], questions: [], confidence: 0.85,
  effort: { min_days: 1, max_days: 3 },
  impact_scope: [], risks: [], suggested_test_focus: [], perspectives: {},
};

console.log('\n[1] parseAndValidate：confidence 是硬门槛');
t('完整产物解析成功', () => {
  const r = parseAndValidate('EVALUATE', JSON.stringify(full));
  assert.ok(r, '应解析成功');
  assert.strictEqual(r.confidence, 0.85);
});
t('漏传 confidence → 返回 null（不落库成功产物）', () => {
  const { confidence, ...noConf } = full;
  assert.strictEqual(parseAndValidate('EVALUATE', JSON.stringify(noConf)), null);
});
t('confidence 为字符串 → null', () => {
  assert.strictEqual(parseAndValidate('EVALUATE', JSON.stringify({ ...full, confidence: '0.9' })), null);
});
t('confidence 越界 → null', () => {
  assert.strictEqual(parseAndValidate('EVALUATE', JSON.stringify({ ...full, confidence: 1.4 })), null);
});
t('只给 level/rationality/confidence 时其余字段补默认后成功', () => {
  const min = { level: 'L2', rationality: { verdict: 'FEASIBLE', reason: 'ok' }, confidence: 0.7 };
  const r = parseAndValidate('EVALUATE', JSON.stringify(min));
  assert.ok(r, '应补默认后成功');
  assert.strictEqual(r.confidence, 0.7);
  assert.ok(r.effort && r.effort.min_days > 0, '应有兜底工时');
  assert.deepStrictEqual(r.questions, []);
});
t('补默认不会凭空造 confidence', () => {
  const out = completeEvaluationDefaults({ level: 'L2', rationality: { verdict: 'FEASIBLE', reason: 'ok' } });
  assert.strictEqual(out.confidence, undefined, `不应补 confidence，实际=${out.confidence}`);
});
t('verdict 变体归一化后仍要求 confidence', () => {
  const v = { ...full, rationality: { verdict: 'FEASIBLE_WITH_CONDITION', reason: 'ok' } };
  const r = parseAndValidate('EVALUATE', JSON.stringify(v));
  assert.ok(r);
  assert.strictEqual(r.rationality.verdict, 'FEASIBLE');
  const { confidence, ...noConf } = v;
  assert.strictEqual(parseAndValidate('EVALUATE', JSON.stringify(noConf)), null);
});
t('围栏代码块内的合法 JSON 可解析', () => {
  const r = parseAndValidate('EVALUATE', '```json\n' + JSON.stringify(full) + '\n```');
  assert.ok(r);
  assert.strictEqual(r.confidence, 0.85);
});
t('思考文本（非 JSON）不会被当 text 产物落库', () => {
  assert.strictEqual(parseAndValidate('EVALUATE', 'Let me analyze this requirement...'), null);
});

console.log('\n[2] attention_points / questions 截断');
t('attention_points 超 6 条被截断而非整体失败', () => {
  const many = { ...full, attention_points: Array.from({ length: 9 }, (_, i) => `点${i}`) };
  const r = parseAndValidate('EVALUATE', JSON.stringify(many));
  assert.ok(r, '应截断后通过');
  assert.strictEqual(r.attention_points.length, 6);
});
t('questions 超 3 条被截断', () => {
  const many = { level: 'L2', rationality: { verdict: 'FEASIBLE', reason: 'ok' }, confidence: 0.3,
    questions: ['q1', 'q2', 'q3', 'q4', 'q5'] };
  const r = parseAndValidate('EVALUATE', JSON.stringify(many));
  assert.ok(r);
  assert.strictEqual(r.questions.length, 3);
});

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURE'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
