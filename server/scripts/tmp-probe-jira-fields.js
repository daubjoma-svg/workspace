// 临时只读探针：打印指定项目/类型 createmeta 的字段清单与 schema，并标注当前字段映射。
'use strict';

const path = require('path');
require(path.join(__dirname, '../src/env'));
const { db } = require(path.join(__dirname, '../src/db'));
const jira = require(path.join(__dirname, '../src/jira'));

const PROJECT = process.argv[2] || 'PINGTAI';
const TYPE = process.argv[3] || '产品需求';

(async () => {
  const po = await db.one(
    `SELECT id, name, jira_base_url, jira_username FROM users
      WHERE jira_api_token_enc IS NOT NULL AND jira_api_token_enc <> '' ORDER BY id LIMIT 1`
  );
  const profile = await jira.getProfile(po.id, true);
  const auth = Buffer.from(`${profile.username}:${profile.api_token}`).toString('base64');
  const r = await fetch(
    `${profile.base_url}/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(PROJECT)}&issuetypeNames=${encodeURIComponent(TYPE)}&expand=projects.issuetypes.fields`,
    { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
  );
  const body = await r.json().catch(() => null);
  const type = body?.projects?.[0]?.issuetypes?.[0];
  if (!type) { console.log('no issuetype found', r.status, JSON.stringify(body).slice(0, 400)); return; }
  console.log(`project=${PROJECT} type=${type.name} fieldCount=${Object.keys(type.fields || {}).length}`);
  const mapped = new Map(Object.entries(profile.field_mapping || {}).filter(([, v]) => v).map(([k, v]) => [v, k]));
  for (const [id, spec] of Object.entries(type.fields || {})) {
    const mark = mapped.has(id) ? ` <== ${mapped.get(id)}` : '';
    const s = spec.schema || {};
    console.log(
      `${id} | ${spec.name} | required=${!!spec.required} | hasDefault=${!!spec.hasDefaultValue} | type=${s.type} items=${s.items || ''} custom=${s.custom || ''}${mark}`
    );
  }
})().catch((e) => console.error('PROBE ERROR:', e.message)).finally(() => process.exit(0));
