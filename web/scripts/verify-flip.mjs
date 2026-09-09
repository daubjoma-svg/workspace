/* ============================================================
   verify-flip.mjs — SearchSelect 下拉翻转逻辑验证（逻辑推演，无浏览器）
   编译 src/lib/dropdownGeometry.ts（真实代码）后用模拟几何跑断言。

   v2 变更：面板已切到 React Portal + position: fixed（见 SearchSelect），
   不再受任何祖先 overflow / stacking context 影响——故裁剪祖先（clips）
   不再参与可用空间判定（决定函数保留 clips 参数仅为 API 兼容）。

   几何基于实际页面（人员管理页）——viewport-only：
   - 视口高 800px；.main 顶部 ~26 + topbar ~70 → 表格（.tbl-wrap）top ≈ 96
   - 表头 ~43px；行高 ~66px（td padding 14×2 + trigger ~38）
   ============================================================ */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 1) 用 esbuild 把真实 TS 模块编译为 ESM（cwd 指向 web/ 根，源码用绝对路径）
const webRoot = join(import.meta.dirname, '..');
const outDir = mkdtempSync(join(tmpdir(), 'ss-flip-'));
const outFile = join(outDir, 'dropdownGeometry.mjs');
execFileSync('npx', ['esbuild', join(webRoot, 'src/lib/dropdownGeometry.ts'), '--format=esm', `--outfile=${outFile}`], { cwd: webRoot, stdio: 'inherit' });
const { decideFlip, estimatePanelHeight, FLIP_GAP } = await import(outFile);

let pass = 0, fail = 0;
function assert(name, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${actual}, want ${expected})`);
}

const VIEWPORT = 800;
const WRAP_TOP = 96;      // .tbl-wrap 顶部（视口坐标，未滚动）
const HEADER = 43;
const ROW_H = 66;
const TRIGGER_H = 38;
const N = 5;              // 角色数：CSM/PO/RD/QA/ADMIN
const tableBottom = (rows) => WRAP_TOP + HEADER + rows * ROW_H;
const wrapClip = (rows) => [{ top: WRAP_TOP, bottom: tableBottom(rows) }];
const rowTrigger = (row) => ({ top: WRAP_TOP + HEADER + (row - 1) * ROW_H, bottom: WRAP_TOP + HEADER + (row - 1) * ROW_H + TRIGGER_H });

console.log('--- 面板高度估算 ---');
assert('estimatePanelHeight(5)=186', estimatePanelHeight(5), 186);
assert('estimatePanelHeight(0)=74 (空态)', estimatePanelHeight(0), 74);
assert('estimatePanelHeight(20)=246 (封顶 200)', estimatePanelHeight(20), 246);

console.log('--- 场景 1：huwei（最后一行，5 行短表格，页面未滚动）---');
// v2 新逻辑（fixed 定位，不看 .tbl-wrap clip，只看视口）：
//   viewportH(800) - trigger.bottom(441) = 359 ≥ 面板需 196 → 向下展开足够 → 不翻转
// （旧版因 .tbl-wrap 下方仅 28px 会向上翻转；新版面板逃出 .tbl-wrap，无须翻转）
assert('huwei 应保持向下（fixed 后视口空间充足）', decideFlip(rowTrigger(5), VIEWPORT, wrapClip(5), estimatePanelHeight(N)), false);

console.log('--- 场景 2：po01（第 2 行，5 行短表格，页面未滚动）---');
// viewportH(800) - trigger.bottom(177) = 623 ≥ 196 → 向下
assert('po01 应保持向下', decideFlip(rowTrigger(2), VIEWPORT, wrapClip(5), estimatePanelHeight(N)), false);

console.log('--- 场景 3：长表格（20 行）已滚动到视口底部，点最后一行 ---');
// trigger 底部贴视口底 790；viewportH(800) - 790 = 10 < 196 → 向上
assert('滚动到底部最后一行应向上', decideFlip({ top: 752, bottom: 790 }, VIEWPORT, [{ top: -200, bottom: 900 }], estimatePanelHeight(N)), true);

console.log('--- 场景 4：20 行长表格第一行，页面未滚动 ---');
// viewportH(800) - 177 = 623 ≥ 196 → 向下
assert('第一行应保持向下', decideFlip({ top: 139, bottom: 177 }, VIEWPORT, [{ top: WRAP_TOP, bottom: 1459 }], estimatePanelHeight(N)), false);

console.log('--- 场景 5：弹窗内靠近弹窗底部的字段 ---');
// 弹窗不参与决策（fixed 不受 modal 裁切），仅看视口：
//   viewportH(800) - trigger.bottom(650) = 150 < 196 → 向上
assert('弹窗内底部字段应向上（视口判定）', decideFlip({ top: 612, bottom: 650 }, VIEWPORT, [{ top: 100, bottom: 700 }], estimatePanelHeight(N)), true);

console.log('--- 场景 6：真实面板高度校正（useLayoutEffect 用 offsetHeight 复算）---');
// 估算 186 触发 trigger.bottom=619：viewportH(800)-619=181 < 196 → 向上；
// 真实 160 触发 trigger.bottom=619：181 < 170 → 仍向上（差异变化不影响本例方向）
const corrTrigger = { top: 581, bottom: 619 };
assert('估算 186 时向上', decideFlip(corrTrigger, VIEWPORT, [{ top: WRAP_TOP, bottom: 799 }], estimatePanelHeight(N)), true);
// 紧贴视口底场景：真实 160 时 181 ≥ 170（170=160+10 FLIP_GAP） → 复算改为向下
const tightTrigger = { top: 600, bottom: 638 }; // 800-638=162, 162>=170? 改测 800-630=170
assert('真实 160 紧贴视口底时复算后向下', decideFlip({ top: 600, bottom: 630 }, VIEWPORT, [{ top: WRAP_TOP, bottom: 799 }], 160), false);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
