import React from 'react';
import { Icon } from './Icon';

/* ============================================================
   DropdownPanel — SearchSelect 面板（搜索 + 选项列表）
   纯展示：所有交互状态（query / hl / value）由父组件 SearchSelect 持有，
   通过键盘 / 鼠标回调抛回去。本组件不持有状态，方便单测与复用。
   命名空间沿用 .ss-*，与 SearchSelect 视觉一致。
   ============================================================ */

export interface DropdownPanelOption {
  value: string | number;
  label: string;
  subLabel?: string;
}

export interface DropdownPanelProps {
  /** 面板根 div id（用于 aria-controls 关联触发器） */
  panelId: string;
  /** 选项 ul id（用于 combobox aria-controls） */
  listId: string;
  /** 列表 ul ref（用于「高亮项滚入可视区」） */
  listRef: React.RefObject<HTMLUListElement>;
  /** 搜索输入 ref（用于自动聚焦） */
  inputRef: React.RefObject<HTMLInputElement>;
  /** 过滤后选项 */
  filtered: DropdownPanelOption[];
  /** 当前高亮索引（受控） */
  hl: number;
  /** 当前选中值（用于右侧打勾） */
  value: string | number | null | undefined;
  /** 搜索关键字 */
  query: string;
  /** 空态文案 */
  emptyText: string;
  /** 搜索 placeholder */
  searchPlaceholder?: string;
  /** aria-label（透传触发器 placeholder） */
  ariaLabel: string;
  /** 选中回调 */
  onChoose: (opt: DropdownPanelOption) => void;
  /** 搜索输入变化 */
  onQueryChange: (v: string) => void;
  /** 搜索框键盘事件（↑↓ Enter Esc 由父组件处理） */
  onInputKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function DropdownPanel({
  panelId,
  listId,
  listRef,
  inputRef,
  filtered,
  hl,
  value,
  query,
  emptyText,
  searchPlaceholder = '搜索…',
  ariaLabel,
  onChoose,
  onQueryChange,
  onInputKeyDown,
}: DropdownPanelProps) {
  return (
    <div id={panelId} className="ss-panel" role="listbox" aria-label={ariaLabel}>
      <div className="ss-search">
        <input
          ref={inputRef}
          className="ss-search-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={filtered[hl] ? `ss-opt-${panelId}-${hl}` : undefined}
          value={query}
          placeholder={searchPlaceholder}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onInputKeyDown}
        />
      </div>
      {filtered.length === 0 ? (
        <div className="ss-empty">{emptyText}</div>
      ) : (
        <ul id={listId} ref={listRef} className="ss-list">
          {filtered.map((opt, i) => {
            const isSel = String(opt.value) === String(value ?? '');
            const isHl = i === hl;
            return (
              <li
                key={String(opt.value)}
                id={`ss-opt-${panelId}-${i}`}
                role="option"
                aria-selected={isSel}
                className={`ss-option${isHl ? ' hl' : ''}${isSel ? ' selected' : ''}`}
                onMouseDown={(e) => {
                  // 用 mousedown 抢在「点击外部关闭」之前选中
                  e.preventDefault();
                  onChoose(opt);
                }}
              >
                <span className="ss-opt-main">
                  <span className="ss-opt-label">{opt.label}</span>
                  {opt.subLabel && <span className="ss-opt-sub">{opt.subLabel}</span>}
                </span>
                {isSel && <Icon name="check" size={16} className="ss-opt-check" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}