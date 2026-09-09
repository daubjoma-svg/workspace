import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { DropdownPanel, DropdownPanelOption } from './DropdownPanel';
import { decideFlip, estimatePanelHeight, FLIP_GAP } from '../lib/dropdownGeometry';

/* ============================================================
   SearchSelect — 通用可搜索单选下拉（v2 · Portal + fixed 定位）
   API 已锁死（team-lead 指定，勿改签名）。

   行为契约：
   - 触发器为按钮（.input 同款视觉），点击/键盘展开面板并自动聚焦搜索框
   - 输入实时过滤 options（label / subLabel 子串匹配，不区分大小写）
   - 键盘：↑↓ 在可见选项间移动高亮（首项默认高亮）/ Enter 确认 / Esc 关闭
     / Backspace 不拦截（交给输入框自然删除，面板不关闭）
   - 点击外部关闭；选中项右侧打勾；过滤为空显示 emptyText
   - 图标全部走 Icon 收口层（chevron-down / check），无 emoji

   v2 关键变更（治本修复）：
   - 面板改用 React Portal 挂到 document.body + position: fixed：
     彻底脱离任何祖先容器（.tbl-wrap / .modal / stacking context）的裁切与层叠，
     视觉上「浮在表格上」而非「嵌在表格里」。
   - 关闭面板在 scroll（capture） + resize 上：面板与触发器失去锚点会显得脱节，
     简单可靠，避免每次滚动都重新计算的复杂度。
   - 不再需要 .ss-flip-up 类（fixed 定位的展开方向由内联 top 决定）。
   ============================================================ */

export interface SearchSelectOption {
  value: string | number;
  label: string;
  subLabel?: string;
}

export interface SearchSelectProps {
  options: SearchSelectOption[];
  value?: string | number | null;
  onChange: (value: string | number) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  /** 可选自定义宽度；不传则 100% */
  width?: string | number;
  /** 外层附加样式 */
  style?: React.CSSProperties;
}

const PANEL_MIN_W = 200;

export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = '请选择…',
  emptyText = '无匹配项',
  disabled = false,
  width,
  style,
}: SearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hl, setHl] = useState(0);
  /** 面板视口坐标（fixed 定位用）；null = 未计算 */
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  /** 已选时面板贴 trigger 上方 / 下方；驱动 caret 翻转与 popIn 动画方向 */
  const [flipUp, setFlipUp] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** 面板根 div（portal 内）：用于 measure 真实面板高度校正位置 */
  const panelElRef = useRef<HTMLDivElement | null>(null);

  const panelId = useId();
  const listId = useId();

  /** 触发按钮上展示的 label：选中项的 label，未选中为空（显示 placeholder） */
  const selectedLabel = useMemo(() => {
    const hit = options.find((o) => String(o.value) === String(value ?? ''));
    return hit ? hit.label : '';
  }, [options, value]);

  /** 过滤：label / subLabel 子串匹配，不区分大小写（label 也做空值保护，防 undefined.toLowerCase 白屏） */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        String(o.label || '').toLowerCase().includes(q) ||
        String(o.subLabel || '').toLowerCase().includes(q),
    );
  }, [options, query]);

  /** 计算面板位置（fixed）：根据 trigger 视口矩形 + 估算高度 + 视口判定翻转 */
  const computePos = (estimatedH: number) => {
    const trig = triggerRef.current;
    if (!trig) return null;
    const r = trig.getBoundingClientRect();
    const w = Math.max(r.width, PANEL_MIN_W);
    const up = decideFlip(r, window.innerHeight, [], estimatedH);
    const top = up ? r.top - estimatedH - FLIP_GAP : r.bottom + FLIP_GAP;
    /** 左：贴 trigger 左；若超出视口右侧则左移（不小于 8px 边距） */
    const maxLeft = Math.max(8, window.innerWidth - w - 8);
    const left = Math.min(Math.max(8, r.left), maxLeft);
    return { top, left, width: w, flipUp: up } as { top: number; left: number; width: number } & { flipUp?: boolean };
  };

  const openPanel = () => {
    if (disabled) return;
    const est = estimatePanelHeight(options.length);
    const p = computePos(est);
    if (p) {
      setPos({ top: p.top, left: p.left, width: p.width });
      setFlipUp(!!(p as any).flipUp);
    }
    setQuery('');
    const idx = filtered.findIndex((o) => String(o.value) === String(value ?? ''));
    setHl(idx >= 0 ? idx : 0);
    setOpen(true);
  };

  const closePanel = () => {
    setOpen(false);
    setQuery('');
  };

  // 打开 → 自动聚焦搜索框
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  // 面板挂载后用真实高度校正位置（估算偏差 / 过滤变短时纠正，避免越界）
  useLayoutEffect(() => {
    if (!open || !panelElRef.current) return;
    const actualH = panelElRef.current.offsetHeight;
    const trig = triggerRef.current;
    if (!trig) return;
    const r = trig.getBoundingClientRect();
    const up = decideFlip(r, window.innerHeight, [], actualH);
    const top = up ? r.top - actualH - FLIP_GAP : r.bottom + FLIP_GAP;
    setPos((prev) => (prev ? { ...prev, top } : prev));
    if (up !== flipUp) setFlipUp(up);
  }, [open, hl, filtered.length, flipUp]);

  // 高亮项滚入可视区（键盘导航时列表跟随）
  useEffect(() => {
    const el = listRef.current?.children[hl] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [hl, open]);

  // 过滤结果变化时把高亮收拢到有效区间（外部 options 更新 / 查询清空）
  useEffect(() => {
    if (filtered.length === 0) { setHl(0); return; }
    setHl((h) => (h >= filtered.length ? filtered.length - 1 : h));
  }, [filtered.length]);

  // 关闭条件：点击外部 / 滚动 / 视口变化 —— Portal 脱离 DOM 后无法仅靠事件冒泡，
  // 这里用 capture 监听 window 的滚动（capture 阶段捕获任何内部滚动）+ resize
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelElRef.current?.contains(t)) return;
      closePanel();
    };
    const onScroll = () => closePanel();
    const onResize = () => closePanel();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true); // capture: 捕获 .tbl-wrap 内部滚动
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const choose = (opt: DropdownPanelOption) => {
    onChange(opt.value);
    closePanel();
  };

  const handleInputChange = (v: string) => {
    setQuery(v);
    setHl(0);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHl((h) => (filtered.length ? Math.min(h + 1, filtered.length - 1) : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHl((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[hl] ?? filtered[0];
      if (opt) choose(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePanel();
    }
    // Backspace 不拦截
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openPanel();
    } else if (open && e.key === 'Escape') {
      e.preventDefault();
      closePanel();
    }
  };

  return (
    <div className="ss" style={{ position: 'relative', width, ...style }}>
      <button
        ref={triggerRef}
        type="button"
        className="ss-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? closePanel() : openPanel())}
        onKeyDown={handleTriggerKeyDown}
      >
        {selectedLabel ? (
          <span className="ss-value" title={selectedLabel}>{selectedLabel}</span>
        ) : (
          <span className="ss-placeholder">{placeholder}</span>
        )}
        <Icon name="chevron-down" size={16} className="ss-caret" />
      </button>

      {open && pos && createPortal(
        <div
          ref={(el) => { panelElRef.current = el; }}
          className={`ss-panel ss-panel-fixed${flipUp ? ' ss-panel-flip-up' : ''}`}
          style={{
            top: pos.top,
            left: pos.left,
            width: pos.width,
          }}
        >
          <DropdownPanel
            panelId={panelId}
            listId={listId}
            listRef={listRef}
            inputRef={inputRef}
            filtered={filtered}
            hl={hl}
            value={value}
            query={query}
            emptyText={emptyText}
            ariaLabel={placeholder}
            onChoose={choose}
            onQueryChange={handleInputChange}
            onInputKeyDown={handleInputKeyDown}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}