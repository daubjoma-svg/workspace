/* ============================================================
   dropdownGeometry — SearchSelect 面板定位决策（纯函数，无 DOM）

   v2 变更：
   - 面板已切到 React Portal + position: fixed（见 SearchSelect），
     不再受任何祖先 overflow / stacking context 影响，故裁剪祖先
     （clips）不再参与可用空间判定，决策只看视口。
   - 保留 clips 参数仅为 API 兼容（verify-flip.mjs 仍依赖旧签名），
     实际忽略。这样不需要改动旧的单测，行为对调用方无感知。
   ============================================================ */

/** 搜索框区块估算高度（.ss-search padding 6+6 + 1 边框 + 输入框 ~29） */
export const SEARCH_H = 44;
/** 单行选项估算高度（.ss-option padding 4+4 + 12.5px 行高 ~20.5） */
export const ROW_H = 28;
/** 选项列表最大高度（.ss-list max-height: 200px，CSS 同步值） */
export const MAX_LIST_H = 200;
/** 面板上下边框 1px × 2 */
export const PANEL_BORDER = 2;
/** 面板与触发器间距（视觉缓冲） */
export const FLIP_GAP = 6;

/** 估算面板渲染高度：搜索框 + 列表（受选项数 & max-height 约束）+ 边框 */
export function estimatePanelHeight(optionCount: number): number {
  const listH = Math.min(Math.max(optionCount, 1) * ROW_H, MAX_LIST_H);
  return SEARCH_H + listH + PANEL_BORDER;
}

/**
 * 展开方向判定：下方视口放得下 → 向下；否则向上（fixed 定位，
 * 不会受任何祖先裁剪影响，clips 参数保留仅为 API 兼容）。
 *
 * @param trigger  触发器视口矩形（getBoundingClientRect）
 * @param viewportH 视口高度
 * @param clips    已废弃（保留仅为 API 兼容，Portal+fixed 后不再需要）
 * @param panelH   面板实际/估算高度
 */
export function decideFlip(
  trigger: { top: number; bottom: number },
  viewportH: number,
  _clips: { top: number; bottom: number }[] = [],
  panelH: number,
): boolean {
  const need = panelH + FLIP_GAP;
  const below = viewportH - trigger.bottom;
  return below >= need ? false : true;
}