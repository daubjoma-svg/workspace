// 临时探针：用真实 createmeta + 真实库内配置，真正创建一个 issue 校验 payload 是否被接受，成功则立即删除。
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
  const call = async (method, p, body) => {
    const r = await fetch(`${profile.base_url}${p}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const projectKey = process.argv[2] || 'PMOTEST';
  const req = await db.one(`
    SELECT r.*, c.name csm_name, p.name po_name, d.name rd_name, f.name fe_name, q.name qa_name
    FROM requirements r
    LEFT JOIN users c ON c.id=r.csm_id LEFT JOIN users p ON p.id=r.po_id
    LEFT JOIN users d ON d.id=r.rd_id LEFT JOIN users f ON f.id=r.fe_id LEFT JOIN users q ON q.id=r.qa_id
    WHERE r.po_id IS NOT NULL ORDER BY r.id DESC LIMIT 1`);

  // 用 getCreateForm 拿到该项目的必填字段，并按合法形态自动补齐候选值。
  const form = await jira.getCreateForm(po.id, req, projectKey, undefined);
  console.log('project=', projectKey, 'issuetype=', form.issue_type, 'required=', form.required_fields.map((f) => `${f.id}:${f.name}`).join(' | '));

  const fields = {};
  for (const f of form.required_fields) {
    const suffix = f.custom ? f.custom.slice(f.custom.lastIndexOf(':') + 1) : '';
    if (f.allowed_values.length) {
      const v = f.allowed_values[0].value;
      fields[f.id] = (suffix === 'multicheckboxes' || suffix === 'multiselect' || f.type === 'array') ? [v] : v;
    } else if (suffix.includes('issue-picker')) {
      const res = await call('GET', `/rest/api/2/search?jql=${encodeURIComponent('project=KHNAME ORDER BY created DESC')}&fields=summary&maxResults=1`);
      const key = res.body?.issues?.[0]?.key;
      if (key) fields[f.id] = suffix === 'multiple-issue-picker-cf' ? [key] : key;
    }
  }
  console.log('probe extra fields =', JSON.stringify(fields));

  const result = await jira.createIssue(req, po.id, { project_key: projectKey, fields });
  console.log('CREATE OK =', result.key, result.url);

  const del = await call('DELETE', `/rest/api/2/issue/${result.key}`);
  console.log('DELETE status =', del.status, JSON.stringify(del.body || {}));
})().catch((e) => console.error('PROBE ERROR:', e.message)).finally(() => process.exit(0));
