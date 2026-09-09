/**
 * 主题工具 — 与 design-system/design-tokens.css 单向对接。
 *
 * 设计要点：
 * 1. TS 侧不硬编码任何色值（P0-3）。默认主色一律从 Token 的 `--accent` 读取。
 * 2. Token 的 `--accent` 在浅/深两态取值不同（浅色 Cyanotype Blue，深色为提亮档）。
 *    Admin「外观主题」把主色以内联样式写在 <html> 上会同时压过两态，
 *    因此当存储值本身等于某一态的 Token 默认值时视为「跟随 Token」，
 *    移除内联覆盖，让深色模式拿到自己的提亮档（保证按钮文字对比度达标）。
 * 3. 管理员自定义主色仍然内联覆盖 `--primary`，主题色功能完全保留；
 *    styles/base.css 中 --primary-weak / -weaker / -strong 均由 --primary 派生，自动跟随。
 */

export type ThemeMode = 'light' | 'dark';

const MODES: ThemeMode[] = ['light', 'dark'];

export const normalizeMode = (mode?: string): ThemeMode => (mode === 'dark' ? 'dark' : 'light');

const sameColor = (a: string, b: string): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** 读取指定模式下 Token 的品牌强调色，读取过程不改变页面当前实际模式 */
export function readTokenAccent(mode: ThemeMode): string {
  const root = document.documentElement;
  const prev = root.dataset.mode;
  root.dataset.mode = mode;
  const value = getComputedStyle(root).getPropertyValue('--accent').trim();
  if (prev === undefined) delete root.dataset.mode;
  else root.dataset.mode = prev;
  return value;
}

/** 该主色是否等于 Token 默认（任一模式）——是则应交还给 Token 级联，不做内联覆盖 */
export function isTokenAccent(primary: string): boolean {
  if (!primary) return true;
  return MODES.some((m) => sameColor(primary, readTokenAccent(m)));
}

/** 落地主题：写 data-mode，并仅在「自定义主色」时内联覆盖 --primary */
export function applyTheme(primary: string, mode?: string): void {
  const root = document.documentElement;
  const next = normalizeMode(mode);
  root.style.removeProperty('--primary');
  const followToken = isTokenAccent(primary);
  root.dataset.mode = next;
  if (!followToken) root.style.setProperty('--primary', primary);
}

/** 当前生效主色（供色板 / 取色器回显）：自定义值优先，否则回落到 Token 默认 */
export function resolveAccent(primary: string, mode?: string): string {
  if (primary && !isTokenAccent(primary)) return primary;
  // Token 读取理论上不会为空（CSS 为渲染阻塞资源）；仍保留回落，避免受控色值输入拿到空串
  return readTokenAccent(normalizeMode(mode)) || primary;
}
