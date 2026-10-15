// 临时只读探针：查明「客户名称」问题选择器的写入来源（字段定义 / 目标项目 / 可否按名称反查）。
'use strict';

const path = require('path');
require(path.join(__dirname, '../src/env'));
const { db } = require(path.join(__dirname, '../src/db'));
const jira = require(path.join(__dirname, '../src/jira'));

(async () => {
  const po = await db.one(
    `SELECT id FROM users WHERE jira_api_token_enc IS NOT NULL AND jira_api_token_enc <> '' ORDER BY id LIMIT 1`
  );
  const profile = await jira.getProfile(po.id, true);
  const auth = Buffer.from(`${profile.username}:${profile.api_token}`).toString('base64');
  const get = async (p) => {
    const r = await fetch(`${profile.base_url}${p}`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const fields = await get('/rest/api/2/field');
  const f = (fields.body || []).find((x) => x.id === 'customfield_11811');
  console.log('field def =', JSON.stringify(f));

  const jql = `summary ~ "上海微谱" AND issuetype in (故事, 产品规划)`;
  const r1 = await get(`/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=summary,project,issuetype&maxResults=5`);
  console.log('\nsearch summary ~ 上海微谱 status=', r1.status, 'total=', r1.body?.total);
  for (const it of r1.body?.issues || []) console.log(' ', it.key, it.fields.project?.key, it.fields.issuetype?.name, it.fields.summary);

  const proj = await get('/rest/api/2/project/KHNAME');
  console.log('\nproject KHNAME status=', proj.status, JSON.stringify({ key: proj.body?.key, name: proj.body?.name, id: proj.body?.id }));
})().catch((e) => console.error('PROBE ERROR:', e.message)).finally(() => process.exit(0));
