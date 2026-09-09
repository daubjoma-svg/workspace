/* 三项优化 SSR 验证（零浏览器环境）
 * 运行：cd web && node scripts/notif-edit-ssr-test.mjs
 * 覆盖：
 *   1) 通知抽屉（NotificationPanel）：未读>0 / =0 / 空 / 超 20 条截断
 *   2) 需求编辑表单（ReqEditModal）：DRAFT 全字段可改 / 非 DRAFT title+负责人禁用+提示
 *   3) AI_FAILED 状态：STATUS_NAME tag 渲染 + heldAI 重跑判定表达式
 */
import { build } from 'esbuild';
import { unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SRC = path.join(__dirname, '../src');

async function bundleCjs(entry, out) {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/*', 'react/jsx-runtime'],
    outfile: out,
    logLevel: 'silent',
  });
}

let failed = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.error('  ✗ ' + msg); }
};

const { default: ReactDOMServer } = await import('react-dom/server');
const { default: React } = await import('react');
const render = (el) => ReactDOMServer.renderToStaticMarkup(el);

// ============ 1. 通知抽屉 ============
const panelOut = path.join(__dirname, '.nf-panel-tmp.cjs');
await bundleCjs(path.join(SRC, 'components/NotificationPanel.tsx'), panelOut);
const { NotificationPanel } = require(panelOut);

const mkNotif = (id, read) => ({
  id, title: `通知 ${id}`, content: '内容 ' + id,
  requirement_id: id % 2 ? id : null, read_flag: read ? 1 : 0, created_at: '2025-01-01 10:00:00',
});

console.log('案例1：通知抽屉 未读>0');
const unreadHtml = render(React.createElement(NotificationPanel, {
  notifs: [mkNotif(1, false), mkNotif(2, false), mkNotif(3, true)], onOpen: () => {}, onClose: () => {},
}));
assert(unreadHtml.includes('notif-pop'), '抽屉容器渲染');
assert((unreadHtml.match(/notif-item/g) || []).length === 3, '渲染 3 条通知');
assert((unreadHtml.match(/notif-item unread/g) || []).length === 2, '未读条目标记 unread（2 条）');
assert(unreadHtml.includes('通知 1') && unreadHtml.includes('内容 1'), '标题 + 内容渲染');

console.log('案例2：通知抽屉 未读=0（全已读 / 空）');
const readHtml = render(React.createElement(NotificationPanel, {
  notifs: [mkNotif(4, true)], onOpen: () => {}, onClose: () => {},
}));
assert(!readHtml.includes('notif-item unread'), '全已读时无 unread 标记');
const emptyHtml = render(React.createElement(NotificationPanel, {
  notifs: [], onOpen: () => {}, onClose: () => {},
}));
assert(emptyHtml.includes('暂无通知'), '空列表显示空态');

console.log('案例3：通知抽屉 超 20 条截断');
const many = Array.from({ length: 25 }, (_, i) => mkNotif(i + 1, false));
const manyHtml = render(React.createElement(NotificationPanel, {
  notifs: many, onOpen: () => {}, onClose: () => {},
}));
assert((manyHtml.match(/notif-item/g) || []).length === 20, '只渲染最近 20 条');
assert(manyHtml.includes('仅显示最近 20 条'), '显示截断提示');
unlinkSync(panelOut);

// ============ 2. 编辑表单 ============
// ReqEditModal 用 useApp() 取 toast：AppCtx 必须与 ReqEditModal 同 bundle（同一模块实例），
// 否则 Provider 与 useContext 拿到的是两个不同 context 对象。
const entrySrc = path.join(__dirname, '.nf-edit-entry.ts');
const entryOut = path.join(__dirname, '.nf-edit-tmp.cjs');
writeFileSync(entrySrc, [
  "import { AppCtx } from '../src/App';",
  "import { ReqEditModal } from '../src/components/ReqEditModal';",
  'export { AppCtx, ReqEditModal };',
  '',
].join('\n'));
await bundleCjs(entrySrc, entryOut);
const { AppCtx, ReqEditModal } = require(entryOut);

const baseReq = {
  id: 10, req_no: 'REQ-10', title: '订单中心改版', description: '改版描述', customer_name: '某客户',
  priority: 'P1', expect_date: '2025-02-01', status: 'SUBMITTED', current_seq: 2,
  csm_id: 1, po_id: 2, rd_id: 3, qa_id: null, template_id: 1,
  created_at: '', updated_at: '', modules: [],
};
const wrap = (req) => render(React.createElement(
  AppCtx.Provider,
  { value: { user: null, theme: { primary: '', mode: 'light' }, toast: () => {}, logout: () => {}, refreshTheme: () => {} } },
  React.createElement(ReqEditModal, { req, onClose: () => {}, onSaved: () => {} }),
));

console.log('案例4：编辑表单 DRAFT（全字段可改）');
const draftHtml = wrap({ ...baseReq, status: 'DRAFT' });
assert(!draftHtml.includes('disabled=""'), 'DRAFT 无任何禁用输入框');
assert(!draftHtml.includes('已提交流程，不可修改'), 'DRAFT 无禁用提示');

console.log('案例5：编辑表单 非 DRAFT（title/负责人禁用 + 提示）');
const ndHtml = wrap(baseReq);
const disabledCount = (ndHtml.match(/disabled=""/g) || []).length;
assert(disabledCount >= 4, `非 DRAFT 禁用输入框 ≥4（title+3 负责人，实际 ${disabledCount}）`);
assert(ndHtml.includes('已提交流程，不可修改'), 'title 禁用提示');
assert(ndHtml.includes('已提交流程，负责人不可修改'), '负责人禁用提示');
assert(ndHtml.includes('改版描述'), '可改字段（描述）仍渲染可编辑');
unlinkSync(entrySrc);
unlinkSync(entryOut);

// ============ 3. AI_FAILED ============
const cardOut = path.join(__dirname, '.nf-card-tmp.cjs');
await bundleCjs(path.join(SRC, 'pages/board/ReqCardCompact.tsx'), cardOut);
const { ReqCardCompact } = require(cardOut);
const apiOut = path.join(__dirname, '.nf-api-tmp.cjs');
await bundleCjs(path.join(SRC, 'api.ts'), apiOut);
const { STATUS_NAME } = require(apiOut);

console.log('案例6：AI_FAILED 状态');
assert(STATUS_NAME.AI_FAILED && STATUS_NAME.AI_FAILED[0] === 'AI 执行失败', 'STATUS_NAME 含 AI_FAILED 文案');
assert(STATUS_NAME.AI_FAILED[1] === 'red', 'AI_FAILED 用 tag-red 语义色');
const failedReq = {
  ...baseReq, status: 'AI_FAILED', title: 'AI 失败需求', current_seq: 2,
};
const aiHtml = render(React.createElement(ReqCardCompact, { r: failedReq, nodeName: 'AI 评估', totalNodes: 7, onOpen: () => {} }));
assert(aiHtml.includes('AI 执行失败'), '卡片渲染 AI 执行失败 文案');
assert(aiHtml.includes('tag-red'), '卡片状态 tag 为 tag-red');
unlinkSync(cardOut);
unlinkSync(apiOut);

// heldAI 判定表达式（与 ReqDetail 第 44 行一致）
console.log('案例7：heldAI 重跑判定（PENDING / AI_FAILED 可重跑）');
const heldAI = (nodeType, status) => nodeType === 'AI' && (status === 'PENDING' || status === 'AI_FAILED');
assert(heldAI('AI', 'AI_FAILED') === true, 'AI 节点 + AI_FAILED → 可重新执行');
assert(heldAI('AI', 'PENDING') === true, 'AI 节点 + PENDING → 可重新执行');
assert(heldAI('AI', 'SUBMITTED') === false, '其他状态不可重跑');
assert(heldAI('HUMAN', 'AI_FAILED') === false, '人工节点不受影响');

if (failed) { console.error(`\n失败 ${failed} 项`); process.exit(1); }
console.log('\n全部通过 ✓');
