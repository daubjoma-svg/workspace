// AC-05 / AC-11 / B2 验证：用本地桩 LLM 服务跑真实 HTTP 调用，断言重试与 meta 落地。
//
// 覆盖：
//   1. 429 -> 重试 1 次 -> 成功        期望 status=OK, attempt=2, is_mock=false
//   2. 500 -> 重试 1 次 -> 仍 500      期望 降级 mock, is_mock=true, attempt=2, reason=http_500
//   3. 超时 -> 重试 1 次 -> 仍超时      期望 降级 mock, reason=timeout, attempt=2
//   4. schema 非法 -> 重试 1 次 -> 合法 期望 status=OK, attempt=2, is_mock=false
//   5. schema 非法 x2                   期望 status=DEGRADED, reason=schema_validation_failed, is_mock=false
//   6. 401                              期望 不重试(attempt=1), 降级 mock
//   7. code_basis                       关联已同步模块时必须是真实 module@branch+commit+file_count
//
// 用法：cd server && SOP_MASTER_KEY=<key> node scripts/verify-llm-retry.js

'use strict';

// 必须在 require 业务模块之前设置：retry.js / llm-call.js 在加载时读取这些环境变量
process.env.LLM_RETRY_BASE_MS = '30';
process.env.LLM_RETRY_MAX_MS = '60';
process.env.SOP_MASTER_KEY = process.env.SOP_MASTER_KEY
  || require('crypto').randomBytes(32).toString('base64');

const http = require('http');
const { db } = require('../src/db');
const secret = require('../src/crypto/secret');
const { runAI } = require('../src/ai');
const aiTask = require('../src/services/ai-task');

const PORT = 4599;
let mode = 'ok';
let hits = 0;

const VALID_EVALUATION = {
  rationality: { verdict: 'REASONABLE', reason: '桩服务返回的合规评估', existing_capability: '可复用现有模块' },
  clarify_questions: [],
  perspectives: { customer: '客户视角', product: '产品视角', engineering: '工程视角' },
  impact_scope: [{ module: 'stub', files: ['src/a.java'], apis: ['/api/stub'], tables: [], confidence: 0.8 }],
  level: 'L2',
  effort: { min_days: 1, max_days: 3, confidence: 0.7, basis: '桩服务' },
  risks: ['无'],
  suggested_test_focus: ['主流程'],
};

function reply(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
const chat = (content) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 11, completion_tokens: 22 } });

const server = http.createServer((req, res) => {
  hits += 1;
  if (mode === 'rate_limit_then_ok') {
    return hits === 1 ? reply(res, 429, { error: 'rate limited' }, { 'retry-after': '0' })
      : reply(res, 200, chat(JSON.stringify(VALID_EVALUATION)));
  }
  if (mode === 'always_500') return reply(res, 500, { error: 'upstream boom' });
  if (mode === 'always_401') return reply(res, 401, { error: 'invalid api key' });
  if (mode === 'timeout') return undefined;                       // 不响应，触发 AbortSignal.timeout
  if (mode === 'bad_then_ok') {
    return hits === 1 ? reply(res, 200, chat('这不是 JSON，只是一段闲聊'))
      : reply(res, 200, chat(JSON.stringify(VALID_EVALUATION)));
  }
  if (mode === 'always_bad') return reply(res, 200, chat('这不是 JSON，只是一段闲聊'));
  return reply(res, 200, chat(JSON.stringify(VALID_EVALUATION)));
});

let pass = 0; let fail = 0;
function check(label, actual, expected) {
  const okFlag = JSON.stringify(actual) === JSON.stringify(expected);
  if (okFlag) { pass += 1; console.log(`PASS  ${label.padEnd(52)} ${JSON.stringify(actual)}`); }
  else { fail += 1; console.log(`FAIL  ${label.padEnd(52)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`); }
}

/** 桩 provider 独占 enabled，跑完恢复现场 */
function installStubProvider(timeoutMs = 400) {
  const prev = db.prepare('SELECT id,enabled FROM ai_providers').all();
  db.prepare('UPDATE ai_providers SET enabled=0').run();
  const r = db.prepare(`INSERT INTO ai_providers(name,type,base_url,api_key_enc,model,enabled,capability,timeout_ms)
    VALUES(?,?,?,?,?,1,?,?)`)
    .run('__stub_verify__', 'openai-compat', `http://127.0.0.1:${PORT}`,
      secret.encrypt('stub-key'), 'stub-model', 'json_object', timeoutMs);
  return { stubId: r.lastInsertRowid, restore() {
    db.prepare('DELETE FROM ai_providers WHERE id=?').run(r.lastInsertRowid);
    const upd = db.prepare('UPDATE ai_providers SET enabled=? WHERE id=?');
    prev.forEach((p) => upd.run(p.enabled, p.id));
  } };
}

const baseReq = {
  id: 0, title: '桩验证需求', description: '用于验证 LLM 重试与降级链路的桩需求描述。',
  customer_name: '内部', priority: 'P2', module_ids: '',
};

async function run(label, m, expected, reqOverride = {}) {
  mode = m; hits = 0;
  const { content, meta } = await runAI('EVALUATE', { ...baseReq, ...reqOverride });
  const actual = {
    status: meta.status, is_mock: meta.is_mock, attempt: meta.attempt,
    reason: meta.degraded_reason, http_calls: hits,
  };
  check(label, actual, expected);
  return { content, meta };
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const stub = installStubProvider();
  console.log('==============================================================');
  console.log(' AC-05 / AC-11 LLM 重试与降级 验证（桩服务 127.0.0.1:%d）', PORT);
  console.log('==============================================================');
  try {
    await run('1. 429 -> 退避重试 -> 成功 (AC-05)', 'rate_limit_then_ok',
      { status: 'OK', is_mock: false, attempt: 2, reason: null, http_calls: 2 });

    await run('2. 500 x2 -> 降级 mock (AC-05)', 'always_500',
      { status: 'DEGRADED', is_mock: true, attempt: 2, reason: 'http_500', http_calls: 2 });

    await run('3. 超时 x2 -> 降级 mock (AC-06)', 'timeout',
      { status: 'DEGRADED', is_mock: true, attempt: 2, reason: 'timeout', http_calls: 2 });

    await run('4. schema 非法 -> 重试 -> 合法 (AC-11)', 'bad_then_ok',
      { status: 'OK', is_mock: false, attempt: 2, reason: null, http_calls: 2 });

    await run('5. schema 非法 x2 -> Zod 兜底非 mock (AC-11)', 'always_bad',
      { status: 'DEGRADED', is_mock: false, attempt: 2, reason: 'schema_validation_failed', http_calls: 2 });

    await run('6. 401 不重试，直接降级', 'always_401',
      { status: 'DEGRADED', is_mock: true, attempt: 1, reason: 'http_401', http_calls: 1 });

    // 7. code_basis：挂上 QA 已同步的模块，验证不是占位而是真实快照元数据
    const mapping = db.prepare("SELECT mm.id FROM module_mappings mm JOIN code_modules cm ON cm.id=mm.code_module_id WHERE cm.sync_status='OK' LIMIT 1").get();
    if (mapping) {
      const { meta } = await run('7. code_basis 取真实模块快照', 'ok',
        { status: 'OK', is_mock: false, attempt: 1, reason: null, http_calls: 1 },
        { module_ids: String(mapping.id) });
      const cb = meta.code_basis;
      check('7a. code_basis.modules 非空', Array.isArray(cb?.modules) && cb.modules.length > 0, true);
      console.log(`      code_basis = ${JSON.stringify(cb)}`);
      const m0 = cb.modules[0];
      check('7b. 含 module_key/branch/commit/file_count',
        [!!m0.module_key, !!m0.branch, !!m0.commit, Number.isFinite(m0.file_count)], [true, true, true, true]);
    } else {
      console.log('SKIP  7. code_basis（当前无 sync_status=OK 的模块）');
    }

    // 8. artifact.meta 契约字段完整性
    const metaJson = JSON.parse(aiTask.buildArtifactMeta({
      provider_id: 9, provider_type: 'openai-compat', model: 'x', structured_level: 'json_object',
      status: 'OK', degraded_reason: null, latency_ms: 12, attempt: 1, is_mock: false, code_basis: null,
    }));
    check('8. artifact.meta 锁定契约 10 字段', Object.keys(metaJson).sort(), [
      'attempt', 'code_basis', 'degraded_reason', 'is_mock', 'latency_ms',
      'model', 'provider_id', 'provider_type', 'status', 'structured_level'].sort());
    check('8a. latency 缺失时为 null 而非 0',
      JSON.parse(aiTask.buildArtifactMeta({ status: 'DEGRADED' })).latency_ms, null);
  } finally {
    stub.restore();
    server.close();
  }
  console.log('==============================================================');
  console.log(` 结果: PASS=${pass}  FAIL=${fail}`);
  console.log('==============================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
