// 用例权限 SSR 回归：渲染真实详情页与用例组件，验证角色/负责人/终态对应的可操作控件。
// 运行：cd web && node scripts/test-case-authz-ssr-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const temp = mkdtempSync(path.join(root, 'scripts/.test-case-authz-'));
const originalUseState = React.useState;

const cases = ['', 'PASS', 'FAIL'].map((result, i) => ({
  id: i + 1, type: '正常流', title: `权限用例${i}`, steps: '检查权限', expect: '结果符合权限', result,
}));
const artifact = { id: 1, kind: 'TEST_CASE', content: JSON.stringify(cases), version: 1 };
const requirement = {
  id: 10, req_no: 'AUTHZ-10', title: '用例权限回归', description: '', status: 'PENDING',
  csm_id: 2, po_id: 3, qa_id: 5, current_seq: 7,
  nodes: [{ id: 7, seq: 7, role: 'QA', node_type: 'HUMAN', name: '测试验证上线' }],
};

try {
  const out = path.join(temp, 'entry.cjs');
  await build({
    stdin: {
      contents: "export { AppCtx } from './src/App'; export { default as ReqDetail } from './src/pages/ReqDetail'; export { TestCaseView } from './src/pages/ReqViews';",
      resolveDir: root, loader: 'tsx',
    },
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', outfile: out,
    external: ['react', 'react-dom', 'react-dom/*', 'react/jsx-runtime'], logLevel: 'silent',
  });
  const { AppCtx, ReqDetail, TestCaseView } = require(out);
  let passed = 0;

  /** 注入已加载的详情状态，SSR 不执行请求副作用；角色判定和子组件渲染均使用真实业务代码。 */
  function renderDetail(user, overrides = {}) {
    const state = [{ ...requirement, ...overrides }, [artifact], [], 'TEST_CASE'];
    let index = 0;
    React.useState = (initial) => originalUseState(index < state.length ? state[index++] : initial);
    try {
      return renderToStaticMarkup(React.createElement(AppCtx.Provider, { value: { user, toast() {} } },
        React.createElement(ReqDetail, { id: 10, onBack() {} })));
    } finally {
      React.useState = originalUseState;
    }
  }

  /** 只读时保留用例内容和三种结果，但不暴露批量/单条编辑或保存入口。 */
  function verify(html, editable, label) {
    for (const text of ['一键勾选通过', '清空结果', '保存执行结果', '全选通过', '勾选=通过']) {
      assert.equal(html.includes(text), editable, `${label}: ${text}`);
    }
    for (const text of ['权限用例0', '权限用例1', '权限用例2', '未执行', '通过', '失败']) assert(html.includes(text), `${label}: ${text}`);
    if (!editable) {
      const table = html.match(/<table class="tbl">[\s\S]*?<\/table>/)?.[0];
      assert(table, label);
      assert(!/<input|<button|<select/.test(table), `${label}: 用例表应无可操作控件`);
      assert(html.includes('只读'), label);
    }
    passed++;
  }

  for (const [role, id, editable] of [['PO', 3, false], ['CSM', 2, false], ['RD', 4, false], ['FE', 7, false], ['QA', 6, false], ['QA', 5, true], ['ADMIN', 1, true]]) {
    verify(renderDetail({ role, id }), editable, `${role}#${id}`);
  }
  verify(renderDetail({ role: 'PO', id: 3 }, { qa_id: 3 }), false, '产品错误指派为测试仍只读');
  verify(renderDetail({ role: 'CSM', id: 2 }, { qa_id: null }), false, '无测试负责人时不回落提单人');
  verify(renderDetail({ role: 'QA', id: 5 }, { qa_id: null }), false, '无测试负责人时 QA 只读');
  verify(renderDetail({ role: 'ADMIN', id: 1 }, { qa_id: null }), true, '无测试负责人时管理员可维护');
  for (const status of ['DONE', 'CANCELLED']) {
    for (const user of [{ role: 'QA', id: 5 }, { role: 'ADMIN', id: 1 }]) {
      verify(renderDetail(user, { status }), false, `${status} ${user.role}`);
    }
  }
  const html = renderToStaticMarkup(React.createElement(AppCtx.Provider, { value: { toast() {} } },
    React.createElement(TestCaseView, { cases, reqId: 10, artifact, onSaved() {} })));
  verify(html, false, '未传编辑权限时默认只读');
  console.log(`PASS ${passed} 项详情页/用例组件权限 SSR 回归`);
} finally {
  React.useState = originalUseState;
  rmSync(temp, { recursive: true, force: true });
}
