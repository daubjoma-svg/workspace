// 临时只读探针：读取已有单据，查看 issue-picker 自定义字段在 REST 中的 JSON 形态（推断写入格式）。
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
  for (const cf of ['customfield_11811', 'customfield_11552', 'customfield_11679', 'customfield_11404', 'customfield_11904']) {
    const res = await get(`/rest/api/2/search?jql=${encodeURIComponent(`cf[${cf.slice('customfield_'.length)}] is not EMPTY`)}&fields=${cf}&maxResults=2`);
    const issues = res.body?.issues || [];
    console.log(`\n=== ${cf} status=${res.status} total=${res.body?.total} ===`);
    for (const it of issues) console.log(it.key, JSON.stringify(it.fields[cf]));
    if (!issues.length) console.log('  (no sample)', JSON.stringify(res.body).slice(0, 200));
  }
})().catch((e) => console.error('PROBE ERROR:', e.message)).finally(() => process.exit(0));
