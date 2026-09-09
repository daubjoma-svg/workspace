/* 看板 SSR 验证（零浏览器环境）
 * 运行：cd web && node scripts/board-ssr-test.mjs
 * 覆盖：
 *   1) roleConfig 三角色（PO/RD/QA）+ CSM 的 todo 过滤：新字段契约下不会把别人节点的需求渲染进来
 *   2) 字段缺失（后端未就绪）时回退 isPending，保证不破
 *   3) ReqCardCompact（todo 精简卡）SSR 输出不含 FlowSteps；ReqCard（active 完整卡）含 FlowSteps
 */
import { build } from 'esbuild';
import { unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SRC = path.join(__dirname, '../src');

/** 卡组件 bundle 成 CJS（lucide-react 是 CJS 包，ESM bundle 会触发 dynamic require 报错） */
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

// ============ 1. roleConfig todo 过滤 ============
const cfgOut = path.join(__dirname, '.board-cfg-tmp.cjs');
await bundleCjs(path.join(SRC, 'pages/board/roleConfig.ts'), cfgOut);
const { roleCfg } = require(cfgOut);

const base = {
  req_no: 'R1', title: 'T', description: '', customer_name: 'C', priority: 'P1',
  status: 'PENDING', current_seq: 1, csm_id: 1, template_id: 1, created_at: '', updated_at: '',
};
const mk = (o) => ({ ...base, ...o });

const mine = [
  mk({ id: 1, current_node_role: 'PO', current_node_type: 'HUMAN' }),
  mk({ id: 2, current_node_role: 'RD', current_node_type: 'HUMAN' }),
  mk({ id: 3, current_node_role: 'PO', current_node_type: 'AI' }),
  mk({ id: 4, current_node_role: 'PO', current_node_type: 'HUMAN', status: 'SUBMITTED' }),
  mk({ id: 5, current_node_role: 'QA', current_node_type: 'HUMAN' }),
  mk({ id: 6, current_node_role: 'CSM', current_node_type: 'HUMAN' }),
  mk({ id: 7, current_node_role: null, current_node_type: null, status: 'DONE' }),
];
const ctx = { user: null, mine, all: [] };
const ids = (cfg) => cfg.todo(ctx).map((r) => r.id).sort((a, b) => a - b);

console.log('案例1：PO todo（新字段契约）');
const poIds = ids(roleCfg('PO', () => {}));
assert(poIds.includes(1), 'PO+HUMAN 的 PENDING 进入 PO todo');
assert(!poIds.includes(2), 'RD+HUMAN 不会进入 PO todo（不串节点）');
assert(!poIds.includes(3), 'PO+AI 节点不会进入 PO todo');
assert(!poIds.includes(4), '非 PENDING 不会进入 PO todo');
assert(!poIds.includes(5) && !poIds.includes(6), 'QA/CSM 节点不会进入 PO todo');

console.log('案例2：RD / QA todo');
const rdIds = ids(roleCfg('RD', () => {}));
assert(rdIds.includes(2) && !rdIds.includes(1), 'RD todo 只含 RD+HUMAN');
const qaIds = ids(roleCfg('QA', () => {}));
assert(qaIds.includes(5) && !qaIds.includes(2), 'QA todo 只含 QA+HUMAN');

console.log('案例3：CSM todo（统一新规则，移除 seq>=8 特殊路径）');
const csmIds = ids(roleCfg('CSM', () => {}));
assert(csmIds.includes(6), 'CSM+HUMAN 进入 CSM todo');
assert(!csmIds.includes(2), 'RD 节点不进入 CSM todo');
assert(!csmIds.includes(5), 'QA 节点（原 seq=8 场景）不再被 CSM 特殊纳入');

console.log('案例4：字段缺失容错（后端未就绪回退 PENDING）');
const legacy = [mk({ id: 10, status: 'PENDING' }), mk({ id: 11, status: 'DONE' })];
const legacyIds = roleCfg('PO', () => {}).todo({ user: null, mine: legacy, all: [] }).map((r) => r.id);
assert(legacyIds.includes(10) && !legacyIds.includes(11), '字段缺失时回退 isPending，PENDING 保留');
unlinkSync(cfgOut);

// ============ 2/3. 卡片 SSR 渲染 diff ============
const { default: ReactDOMServer } = await import('react-dom/server');
const { default: React } = await import('react');

const compactOut = path.join(__dirname, '.board-compact-tmp.cjs');
await bundleCjs(path.join(SRC, 'pages/board/ReqCardCompact.tsx'), compactOut);
const { ReqCardCompact } = require(compactOut);

const cardOut = path.join(__dirname, '.board-card-tmp.cjs');
await bundleCjs(path.join(SRC, 'pages/board/ReqCard.tsx'), cardOut);
const { ReqCard } = require(cardOut);

const r = {
  id: 9, req_no: 'R9', title: '订单中心改版', description: '', customer_name: '某客户',
  priority: 'P1', status: 'PENDING', current_seq: 4, csm_id: 1, template_id: 1,
  created_at: '', updated_at: '2025-01-01 12:00:00', po_name: '王五', open_clarifies: 0,
};
const nodes = [
  { id: 1, template_id: 1, seq: 1, node_type: 'HUMAN', name: '提交', role: 'CSM', state: 'done' },
  { id: 2, template_id: 1, seq: 2, node_type: 'AI', name: '评估', ai_action: 'EVALUATE', state: 'done' },
  { id: 3, template_id: 1, seq: 3, node_type: 'HUMAN', name: '产品评审', role: 'PO', state: 'current' },
  { id: 4, template_id: 1, seq: 4, node_type: 'HUMAN', name: '研发', role: 'RD', state: 'pending' },
];

console.log('案例5：精简卡不含 FlowSteps，完整卡含 FlowSteps');
const compactHtml = ReactDOMServer.renderToStaticMarkup(
  React.createElement(ReqCardCompact, { r, nodeName: '产品评审', totalNodes: 4, onOpen: () => {} }),
);
assert(compactHtml.includes('req-card-compact'), '精简卡带 req-card-compact 类');
assert(compactHtml.includes('rc-progress'), '精简卡含进度比例条');
assert(compactHtml.includes('产品评审'), '精简卡显示当前节点名');
assert(!compactHtml.includes('flow-step') && !compactHtml.includes('flow-ic'), '精简卡不含 FlowSteps 元素');

const fullHtml = ReactDOMServer.renderToStaticMarkup(
  React.createElement(ReqCard, { r, nodes, onOpen: () => {} }),
);
assert(fullHtml.includes('flow-step'), '完整卡含 FlowSteps 元素');
assert(fullHtml.includes('产品评审'), '完整卡保留节点名/流程');

unlinkSync(compactOut);
unlinkSync(cardOut);

if (failed) { console.error(`\n失败 ${failed} 项`); process.exit(1); }
console.log('\n全部通过 ✓');
