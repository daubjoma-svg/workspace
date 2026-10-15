// 临时只读探针：拦截 POST，打印 createIssue 真实会提交的字段，定位 400 根因。
'use strict';
const path = require('path');
require(path.join(__dirname, '../src/env'));
const { db } = require(path.join(__dirname, '../src/db'));
const jira = require(path.join(__dirname, '../src/jira'));

const realFetch = global.fetch;
let captured = null;
global.fetch = async (url, opts) => {
  if (opts && opts.method === 'POST' && String(url).includes('/rest/api/2/issue')) {
    captured = JSON.parse(opts.body);
    return { ok: true, status: 201, json: async () => ({ id: '1', key: 'PROBE-1', self: String(url) }) };
  }
  return realFetch(url, opts);
};

(async () => {
  const po = await db.one(
    `SELECT id FROM users WHERE jira_api_token_enc IS NOT NULL AND jira_api_token_enc <> '' ORDER BY id LIMIT 1`
  );
  const profile = await jira.getProfile(po.id, true);
  const auth = Buffer.from(`${profile.username}:${profile.api_token}`).toString('base64');
  const get = async (p) => (await realFetch(`${profile.base_url}${p}`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } })).json();

  const projectKey = process.argv[2] || 'PMOTEST';
  const req = await db.one(`
    SELECT r.*, c.name csm_name, p.name po_name, d.name rd_name, f.name fe_name, q.name qa_name
    FROM requirements r
    LEFT JOIN users c ON c.id=r.csm_id LEFT JOIN users p ON p.id=r.po_id
    LEFT JOIN users d ON d.id=r.rd_id LEFT JOIN users f ON f.id=r.fe_id LEFT JOIN users q ON q.id=r.qa_id
    WHERE r.po_id IS NOT NULL ORDER BY r.id DESC LIMIT 1`);

  const meta = await get(`/rest/api/2/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes.fields`);
  const type = (meta.projects?.[0]?.issuetypes || []).find((t) => t.name === '任务') || meta.projects?.[0]?.issuetypes?.[0];
  const schemas = type.fields || {};
  console.log('issuetype =', type.name);
  console.log('\n--- 所有自定义字段 ---');
  for (const [id, s] of Object.entries(schemas)) {
    if (s?.schema?.custom) console.log(`${id} | ${s.name} | type=${s.schema.type} items=${s.schema.items || ''} | required=${!!s.required} | custom=${s.schema.custom}`);
  }

  const result = await jira.createIssue(req, po.id, { project_key: projectKey });
  console.log('\nSENT FIELDS =', JSON.stringify(captured && captured.fields, null, 2));
})().catch((e) => console.error('PROBE ERROR:', e.message)).finally(() => process.exit(0));
