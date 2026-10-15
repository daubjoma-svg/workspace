import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { decideFlip, FLIP_GAP, MAX_LIST_H, PANEL_BORDER, ROW_H } from '../lib/dropdownGeometry';

/* ============================================================
   CustomerInput — 客户名称「可选可输」组合框
   - 输入框本身就是自由文本：输入内容即最终值，不做白名单限制
   - 聚焦/输入时展示候选（该提单人历史需求里的客户名），可键盘/鼠标选择回填
   - 候选项来自 GET /customer-names（按账号隔离）；新客户名保存到需求后
     下次自动出现在候选里，无需单独维护列表
   面板复用 SearchSelect 的 .ss-* 视觉与 Portal + fixed 定位。
   ============================================================ */

export interface CustomerInputProps {
  value: string;
  onChange: (v: string) => void;
  /** 候选客户名称（已按提单人账号隔离） */
  options: string[];
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
}

const PANEL_MIN_W = 180;

const panelHeight = (n: number) => Math.min(Math.max(n, 1) * ROW_H, MAX_LIST_H) + PANEL_BORDER;

export function CustomerInput({
  value,
  onChange,
  options,
  placeholder = '请选择或输入客户名称',
  emptyText = '暂无历史客户，直接输入并保存后下次即可选用',
  disabled = false,
}: CustomerInputProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hl, setHl] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [flipUp, setFlipUp] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelElRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const panelId = useId();
  const listId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  const computePos = (estimatedH: number) => {
    const el = wrapRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const w = Math.max(r.width, PANEL_MIN_W);
    const up = decideFlip(r, window.innerHeight, [], estimatedH);
    const top = up ? r.top - estimatedH - FLIP_GAP : r.bottom + FLIP_GAP;
    const maxLeft = Math.max(8, window.innerWidth - w - 8);
    const left = Math.min(Math.max(8, r.left), maxLeft);
    return { top, left, width: w, up };
  };

  const openAt = (count: number) => {
    if (disabled) return;
    const p = computePos(panelHeight(count));
    if (p) {
      setPos({ top: p.top, left: p.left, width: p.width });
      setFlipUp(p.up);
    }
    setOpen(true);
  };

  const openAll = () => { if (!disabled) { setQuery(''); setHl(0); openAt(options.length); } };
  const closePanel = () => { setOpen(false); setQuery(''); };

  // 面板挂载后用真实高度校正位置（过滤变短 / 估算偏差时避免越界）
  useLayoutEffect(() => {
    if (!open || !panelElRef.current) return;
    const actualH = panelElRef.current.offsetHeight;
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const up = decideFlip(r, window.innerHeight, [], actualH);
    const top = up ? r.top - actualH - FLIP_GAP : r.bottom + FLIP_GAP;
    setPos((prev) => (prev ? { ...prev, top } : prev));
    if (up !== flipUp) setFlipUp(up);
  }, [open, hl, filtered.length, flipUp]);

  // 高亮项滚入可视区
  useEffect(() => {
    const el = listRef.current?.children[hl] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [hl, open]);

  useEffect(() => {
    if (filtered.length === 0) { setHl(0); return; }
    setHl((h) => (h >= filtered.length ? filtered.length - 1 : h));
  }, [filtered.length]);

  // 点击外部 / 滚动 / 视口变化关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (panelElRef.current?.contains(t)) return;
      closePanel();
    };
    const onScroll = () => closePanel();
    const onResize = () => closePanel();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const choose = (opt: string) => {
    onChange(opt);
    closePanel();
    inputRef.current?.focus();
  };

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    onChange(v);
    setQuery(v);
    setHl(0);
    if (!open) {
      const q = v.trim().toLowerCase();
      const n = q ? options.filter((o) => o.toLowerCase().includes(q)).length : options.length;
      openAt(n);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openAll();
      else setHl((h) => (filtered.length ? Math.min(h + 1, filtered.length - 1) : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) setHl((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && filtered[hl]) { e.preventDefault(); choose(filtered[hl]); }
      else closePanel();
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); closePanel(); }
    } else if (e.key === 'Tab') {
      closePanel();
    }
  };

  return (
    <div ref={wrapRef} className="ci-wrap">
      <input
        ref={inputRef}
        className="input ci-input"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && filtered[hl] ? `ci-opt-${panelId}-${hl}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={openAll}
        onMouseDown={() => { if (!open) openAll(); }}
      />
      <button
        type="button"
        className="ci-caret"
        tabIndex={-1}
        aria-label="展开客户名称候选"
        disabled={disabled}
        onMouseDown={(e) => {
          e.preventDefault();
          if (open) { closePanel(); } else { openAll(); inputRef.current?.focus(); }
        }}
      >
        <Icon name="chevron-down" size={16} />
      </button>

      {open && pos && createPortal(
        <div
          ref={(el) => { panelElRef.current = el; }}
          id={panelId}
          className={`ss-panel ss-panel-fixed${flipUp ? ' ss-panel-flip-up' : ''}`}
          style={{ top: pos.top, left: pos.left, width: pos.width }}
          role="listbox"
          aria-label="客户名称候选"
        >
          {filtered.length === 0 ? (
            <div className="ss-empty">{emptyText}</div>
          ) : (
            <ul id={listId} ref={listRef} className="ss-list">
              {filtered.map((opt, i) => {
                const isSel = opt === value;
                return (
                  <li
                    key={opt}
                    id={`ci-opt-${panelId}-${i}`}
                    role="option"
                    aria-selected={isSel}
                    className={`ss-option${i === hl ? ' hl' : ''}${isSel ? ' selected' : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); choose(opt); }}
                  >
                    <span className="ss-opt-main"><span className="ss-opt-label">{opt}</span></span>
                    {isSel && <Icon name="check" size={16} className="ss-opt-check" />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
