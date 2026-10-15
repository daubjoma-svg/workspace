// 临时只读探针：直接调用 getCreateForm，打印必填字段及其允许值，用于核对前端表单渲染。
'use strict';

const path = require('path');
require(path.join(__dirname, '../src/env'));
const { db } = require(path.join(__dirname, '../src/db'));
const jira = require(path.join(__dirname, '../src/jira'));

(async () => {
  const po = await db.one(
    `SELECT id, name FROM users WHERE jira_api_token_enc IS NOT NULL AND jira_api_token_enc <> '' ORDER BY id LIMIT 1`
  );
  const req = await db.one(`
    SELECT r.*, c.name csm_name, p.name po_name, d.name rd_name, f.name fe_name, q.name qa_name
    FROM requirements r
    LEFT JOIN users c ON c.id=r.csm_id LEFT JOIN users p ON p.id=r.po_id
    LEFT JOIN users d ON d.id=r.rd_id LEFT JOIN users f ON f.id=r.fe_id LEFT JOIN users q ON q.id=r.qa_id
    WHERE r.po_id IS NOT NULL ORDER BY r.id DESC LIMIT 1`);
  const project = process.argv[2] || 'PINGTAI';
  const type = process.argv[3] || '产品需求';
  const form = await jira.getCreateForm(po.id, req, project, type);
  console.log('issue_types =', form.issue_types.join(' | '));
  console.log('picked =', form.issue_type);
  for (const f of form.required_fields) {
    console.log(`\n${f.id} | ${f.name} | type=${f.type} items=${f.items} custom=${f.custom} | allowed=${f.allowed_values.length}`);
    if (f.allowed_values.length) console.log('  values =', f.allowed_values.slice(0, 8).map((v) => `${v.id}=${v.value}`).join(' , '));
  }
})().catch((e) => console.error('PROBE ERROR:', e.message)).finally(() => process.exit(0));
