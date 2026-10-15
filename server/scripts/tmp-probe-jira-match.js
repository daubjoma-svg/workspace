// 临时只读探针：打印 matchSchemaFields 在指定项目下的匹配结果与字段类型，定位错误字段。
'use strict';
const path = require('path');
require(path.join(__dirname, '../src/env'));
const { db } = require(path.join(__dirname, '../src/db'));
const jiraMod = require(path.join(__dirname, '../src/jira'));
const jiraSrc = require('fs').readFileSync(path.join(__dirname, '../src/jira.js'), 'utf8');

(async () => {
  const po = await db.one(
    `SELECT id FROM users WHERE jira_api_token_enc IS NOT NULL AND jira_api_token_enc <> '' ORDER BY id LIMIT 1`
  );
  const profile = await jiraMod.getProfile(po.id, true);
  const auth = Buffer.from(`${profile.username}:${profile.api_token}`).toString('base64');
  const get = async (p) => (await fetch(`${profile.base_url}${p}`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } })).json();

  const projectKey = process.argv[2] || 'PINGTAI';
  const typeName = process.argv[3] || '产品需求';
  const meta = await get(`/rest/api/2/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes.fields`);
  const type = (meta.projects?.[0]?.issuetypes || []).find((t) => t.name === typeName);
  const schemas = type.fields || {};

  // 复刻 matchSchemaFields 的匹配逻辑，逐条打印命中的字段名与类型。
  const FIELD_ALIASES = {
    customer_name: ['客户名称', '客户名'],
    product_manager: ['产品经理', '产品负责人'],
    rd: ['研发负责人', '开发负责人', '后端负责人'],
    fe: ['前端负责人'],
    participants: ['参与人员', '参与人', '相关人员'],
    reporter: ['报告人', '提出人', '需求提出人'],
    qa: ['QA', '测试负责人', '测试人员', '测试'],
    online_time: ['上线时间', '计划上线时间', '期望上线时间'],
    priority: ['优先级'],
    modules: ['业务模块', '所属模块'],
  };
  const norm = (v) => String(v || '').replace(/\s+/g, '').toLowerCase();
  console.log(`=== ${projectKey}/${typeName} 匹配结果 ===`);
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
    const targets = aliases.map(norm);
    const candidates = Object.entries(schemas).filter(([, spec]) => {
      if (!spec?.schema?.custom) return false;
      const name = norm(spec.name);
      return targets.includes(name) || targets.some((t) => name.includes(t));
    });
    const hit = candidates.find(([, spec]) => spec.required) || candidates[0];
    if (hit) {
      const [id, spec] = hit;
      console.log(`${key} -> ${id} "${spec.name}" type=${spec.schema.type} items=${spec.schema.items || ''} custom=${spec.schema.custom} | 候选数=${candidates.length}`);
    } else console.log(`${key} -> (未命中)`);
  }
})().catch((e) => console.error('PROBE ERROR:', e.message)).finally(() => process.exit(0));
