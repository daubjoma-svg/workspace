'use strict';
const path = require('path');
require(path.join(__dirname, '../src/env'));
const { db } = require(path.join(__dirname, '../src/db'));
(async () => {
  const s = await db.getSetting('jira.shared_meta', '');
  const m = JSON.parse(s || '{}');
  console.log('shared project_key=', m.project_key, '| issue_type=', m.issue_type, '| synced_at=', m.synced_at, '| synced_by=', JSON.stringify(m.synced_by));
  console.log('candidates=', JSON.stringify(m.project_candidates));
  console.log('unmapped=', JSON.stringify(m.unmapped_fields));
  const rows = await db.many("SELECT id,name,role,jira_project_key,jira_issue_type,jira_base_url,jira_username FROM users WHERE jira_base_url IS NOT NULL ORDER BY id");
  console.table(rows);
})().catch((e) => console.error('ERR', e.message)).finally(() => process.exit(0));
