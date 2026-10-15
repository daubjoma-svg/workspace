/** 创建字段元数据回归：隔离数据库和 Jira，仅检查当前项目的默认值及缺失必填字段。 */
'use strict';

const assert = require('node:assert/strict');
const { db } = require('../src/db');
const secret = require('../src/crypto/secret');
const jira = require('../src/jira');

const original = { one: db.one, getSetting: db.getSetting, decrypt: secret.tryDecrypt, fetch: global.fetch };
const platformLine = '用户中心（组织架构、权限、消息、登录等）';
const fields = {
  customfield_11404: { name: '平台子业务线', required: true, schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' }, allowedValues: [{ id: '1', value: platformLine }] },
  customfield_11101: { name: '涉及的研发端', required: true, schema: { type: 'array', items: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes' }, allowedValues: [{ id: '2', value: '后端' }] },
  customfield_11904: { name: '归属BU', required: false, schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' }, allowedValues: [{ id: '3', value: '平台' }] },
};

async function verify() {
  db.getSetting = async () => '';
  db.one = async () => ({ jira_base_url: 'https://jira.example.com', jira_username: 'product', jira_api_token_enc: 'encrypted', jira_project_key: 'PINGTAI', jira_issue_type: '产品需求', jira_field_defaults: JSON.stringify({ customfield_11404: platformLine, customfield_11101: '后端', customfield_11904: '旧 BU' }) });
  secret.tryDecrypt = () => 'mock-token';
  let submitted;
  global.fetch = async (_url, options) => options?.method === 'POST'
    ? (submitted = JSON.parse(options.body), { ok: true, json: async () => ({ key: 'PINGTAI-1' }) })
    : ({ ok: true, json: async () => ({ projects: [{ key: 'PINGTAI', name: '平台系统需求池', issuetypes: [{ name: '产品需求', fields }] }] }) });
  const form = await jira.getCreateForm(36, { title: '测试需求' }, 'PINGTAI', '产品需求');
  assert.deepEqual(form.default_fields.map((field) => field.name), ['平台子业务线', '涉及的研发端', '归属BU']);
  assert.deepEqual(form.default_fields.map((field) => field.default_value), [platformLine, ['后端'], '']);
  assert.ok(!form.required_fields.some((field) => field.id === 'customfield_11404'), '完整候选值满足必填要求');
  assert.ok(!form.required_fields.some((field) => field.id === 'customfield_11101'), '合法默认值满足必填要求');
  await jira.createIssue({ title: '测试需求' }, 36, { project_key: 'PINGTAI' });
  assert.deepEqual(submitted.fields.customfield_11404, { value: platformLine }, '提交 Jira 时保留完整候选名称');
  fields.customfield_11101.allowedValues = [{ id: '4', value: '前端' }];
  const changed = await jira.getCreateForm(36, { title: '测试需求' }, 'PINGTAI', '产品需求');
  assert.ok(changed.required_fields.some((field) => field.id === 'customfield_11101'), '项目候选值变化后必须重新补填');
  assert.deepEqual(changed.default_fields.find((field) => field.id === 'customfield_11101').default_value, []);
  console.log('PASS: 含顿号的默认值完整回显并写入请求；失效默认值要求补填');
}

verify().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  db.one = original.one;
  db.getSetting = original.getSetting;
  secret.tryDecrypt = original.decrypt;
  global.fetch = original.fetch;
});
