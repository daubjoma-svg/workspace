// 测试用例权限回归：真实 HTTP 路由、认证和授权，持久化使用内存桩，不访问业务数据库。
// 运行：node server/scripts/verify-test-case-authz.js
'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');

const users = ['ADMIN', 'CSM', 'PO', 'RD', 'QA', 'OTHER_QA', 'FE'].map((token, i) => ({
  id: i + 1, name: token, role: token === 'OTHER_QA' ? 'QA' : token, token,
}));
const requirement = { id: 10, req_no: 'AUTHZ-10', status: 'PENDING', csm_id: 2, po_id: 3, qa_id: 5 };
const artifacts = [];
const timeline = [];
const logs = [];

/** 隔离数据库、AI 和旁支路由，确保回归测试不发起外部调用或改动真实数据。 */
function stub(name, exports) {
  const filename = require.resolve(`../src/${name}`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('db', { db: {
  one: async (sql, [value]) => {
    if (sql.includes('FROM sessions')) {
      const user = users.find((u) => u.token === value);
      return user ? { user_id: user.id } : null;
    }
    if (sql.includes('FROM users')) return users.find((u) => u.id === value);
    throw new Error(`非预期查询：${sql}`);
  },
  many: async () => artifacts,
} });
stub('engine', {
  getReq: async (id) => id === requirement.id ? requirement : null,
  saveArtifact: async (id, nodeId, kind, content, createdBy) => {
    artifacts.push({ requirement_id: id, kind, content, created_by: createdBy });
    return artifacts.length;
  },
  addTimeline: async (...args) => { timeline.push(args); },
});
stub('logger', Object.fromEntries(['info', 'warn', 'error'].map((level) => [level,
  (event, fields) => logs.push({ level, event, ...fields }),
])));
for (const name of ['crypto/password', 'ai', 'llm/provider', 'llm-call']) stub(name, {});
for (const name of ['api/code-context', 'api/requirement-actions', 'api/uploads', 'auth-register']) stub(name, express.Router());

const { router } = require('../src/routes');
const app = express();
app.use(express.json());
app.use('/api/v1', router);
app.use('/api', router);
app.use((error, req, res, next) => res.status(500).json({ error: error.message }));

/** 同时检查 HTTP 结果与持久化副作用，防止只返回 403 但仍写入数据。 */
async function verify(base, token, status, opts = {}) {
  const before = artifacts.length;
  const timelineBefore = timeline.length;
  const response = await fetch(`${base}/requirements/${opts.id ?? 10}/artifacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-token': token } : {}) },
    body: JSON.stringify({ kind: 'TEST_CASE', content: '[{"result":"PASS"}]', ...opts.body }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  assert.equal(response.status, status, `${token || '未登录'}: ${JSON.stringify(body)}`);
  assert.equal(artifacts.length, before + (status === 200 ? 1 : 0));
  assert.equal(timeline.length, timelineBefore + (status === 200 ? 1 : 0));
  if (status === 200) {
    assert.equal(body.version, artifacts.length);
    assert.equal(artifacts.at(-1).created_by, token);
  }
}

async function main() {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let passed = 0;
  try {
    for (const prefix of ['/api', '/api/v1']) {
      const base = `http://127.0.0.1:${server.address().port}${prefix}`;
      const check = async (...args) => { await verify(base, ...args); passed++; };
      requirement.status = 'PENDING';
      requirement.qa_id = 5;
      for (const token of ['PO', 'CSM', 'RD', 'FE', 'OTHER_QA']) await check(token, 403);
      await check('', 401);
      await check('INVALID_TOKEN', 401);
      await check('QA', 200);
      await check('ADMIN', 200);
      await check('PO', 403, { body: { qa_id: 3 } });
      // 角色变更或历史错误指派：只有负责人 ID 相等仍不足以获得 QA 权限。
      requirement.qa_id = 3;
      await check('PO', 403);
      requirement.qa_id = null;
      await check('CSM', 403);
      await check('QA', 403);
      await check('ADMIN', 200);
      requirement.qa_id = 5;
      for (const status of ['DONE', 'CANCELLED']) {
        requirement.status = status;
        await check('QA', 400);
        await check('ADMIN', 400);
      }
      requirement.status = 'PENDING';
      await check('QA', 404, { id: 999 });
      for (const id of ['invalid', '10e1', '10junk', 0, -1]) await check('QA', 400, { id });
      await check('QA', 400, { body: { content: '' } });
      for (const kind of ['test_case', 'TEST_CASE ', 'TEST_CASE\n', 'TÉST_CASE', ['TEST_CASE']]) {
        await check('PO', 400, { body: { kind } });
      }
      // 本次收紧仅针对测试用例写入；产品仍可保存 PRD、查看已有测试结果。
      await check('PO', 200, { body: { kind: 'PRD', content: '产品需求文档' } });
      const response = await fetch(`${base}/requirements/10/artifacts`, { headers: { 'x-token': 'PO' } });
      assert.equal(response.status, 200);
      assert((await response.json()).some((a) => a.kind === 'TEST_CASE'));
      passed++;
    }
    assert(logs.some((l) => l.level === 'warn' && l.event === 'authz_denied' && l.scope === 'TEST_CASE'));
    assert(logs.some((l) => l.level === 'info' && l.event === 'artifact_saved' && l.kind === 'TEST_CASE'));
    console.log(`PASS ${passed} 项 HTTP 权限回归（两组 API 前缀），拒绝写入无副作用，授权日志正常`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
