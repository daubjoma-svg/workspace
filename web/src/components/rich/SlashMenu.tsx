/* `/` 快捷命令菜单（SlashMenu · .rte-slash-* 命名空间）
 *
 * 纯展示组件：菜单项定义 + 悬浮面板渲染。
 * 打开/定位/键盘导航/命令执行逻辑在 RichTextEditor（需要编辑器实例与选区坐标）。
 * 图标走 Icon 收口层，无 emoji；命令图标为描边风格，与工具栏一致。
 */
import type { IconName } from '../Icon';
import { Icon } from '../Icon';

export type SlashAction = 'h2' | 'ul' | 'ol' | 'code' | 'image' | 'hr';

export interface SlashItem {
  key: string;
  label: string;
  hint: string;
  icon: IconName;
  action: SlashAction;
}

export const SLASH_ITEMS: SlashItem[] = [
  { key: 'h2', label: '标题', hint: 'H2', icon: 'heading', action: 'h2' },
  { key: 'ul', label: '无序列表', hint: '• 列表', icon: 'list-bullet', action: 'ul' },
  { key: 'ol', label: '有序列表', hint: '1. 列表', icon: 'list-ordered', action: 'ol' },
  { key: 'code', label: '代码块', hint: '</>', icon: 'code', action: 'code' },
  { key: 'image', label: '图片', hint: '上传', icon: 'image', action: 'image' },
  { key: 'hr', label: '分割线', hint: '—', icon: 'minus', action: 'hr' },
];

/** 按输入过滤（label / hint / key 模糊匹配；空查询返回全部） */
export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((it) =>
    it.label.toLowerCase().includes(q) ||
    it.hint.toLowerCase().includes(q) ||
    it.key.includes(q),
  );
}

interface SlashMenuProps {
  x: number;
  y: number;
  items: SlashItem[];
  index: number;
  onSelect: (action: SlashAction) => void;
  onHover: (i: number) => void;
}

export function SlashMenu({ x, y, items, index, onSelect, onHover }: SlashMenuProps) {
  return (
    <div className="rte-slash" style={{ left: Math.max(0, x), top: Math.max(0, y + 6) }} role="listbox" aria-label="快捷命令">
      {items.length === 0 ? (
        <div className="rte-slash-empty">无匹配命令</div>
      ) : items.map((it, i) => (
        <button
          key={it.key}
          type="button"
          role="option"
          aria-selected={i === index}
          className={`rte-slash-item${i === index ? ' active' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onSelect(it.action)}
        >
          <span className="rte-slash-ic"><Icon name={it.icon} size={16} /></span>
          <span className="rte-slash-label">{it.label}</span>
          <span className="rte-slash-hint">{it.hint}</span>
        </button>
      ))}
    </div>
  );
}
