// 临时只读探针：确认当前账号在哪些项目「可以创建」issue（createmeta 不含无创建权限的项目）。
'use strict';

const path = require('path');
require(path.join(__dirname, '../src/env'));
const { db } = require(path.join(__dirname, '../src/db'));
const jira = require(path.join(__dirname, '../src/jira'));

(async () => {
  const po = await db.one(
    `SELECT id, name, jira_base_url, jira_username FROM users
      WHERE jira_api_token_enc IS NOT NULL AND jira_api_token_enc <> '' ORDER BY id LIMIT 1`
  );
  const profile = await jira.getProfile(po.id, true);
  const auth = Buffer.from(`${profile.username}:${profile.api_token}`).toString('base64');
  const get = async (p) => {
    const r = await fetch(`${profile.base_url}${p}`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const all = await get('/rest/api/2/project');
  console.log('visible projects =', (all.body || []).map((p) => `${p.key}(${p.name})`).join(', '));
  const cm = await get('/rest/api/2/issue/createmeta');
  console.log('createmeta status =', cm.status, 'projects =', (cm.body?.projects || []).map((p) => `${p.key}(${p.name}) types=${(p.issuetypes || []).map((t) => t.name).join('|')}`).join(' ;; '));
})().catch((e) => console.error('PROBE ERROR:', e.message)).finally(() => process.exit(0));
