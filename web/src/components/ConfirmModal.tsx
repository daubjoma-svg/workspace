import React from 'react';
import { Icon } from './Icon';

/**
 * 统一确认弹窗（替代原生 window.confirm / window.prompt）。
 * 复用全局 .modal-mask / .modal 样式；danger 模式用于删除等破坏性操作。
 */
interface ConfirmModalProps {
  title: string;
  message?: React.ReactNode;
  confirmText?: string;
  danger?: boolean;
  /** 需要输入的场景（替代 prompt）：非空则显示输入框，onConfirm 回调携带输入值 */
  inputPlaceholder?: string;
  inputDefault?: string;
  onConfirm: (input?: string) => void;
  onCancel: () => void;
}

export function ConfirmModal({ title, message, confirmText = '确认', danger, inputPlaceholder, inputDefault, onConfirm, onCancel }: ConfirmModalProps) {
  const [input, setInput] = React.useState(inputDefault || '');
  const hasInput = inputPlaceholder != null;
  const submit = () => {
    if (hasInput && !input.trim()) return;
    onConfirm(hasInput ? input.trim() : undefined);
  };
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-h">
          {title}
          <button className="btn btn-sm btn-icon" onClick={onCancel} aria-label="关闭"><Icon name="close" size={16} /></button>
        </div>
        <div className="modal-b">
          {message && <div className="muted" style={{ lineHeight: 1.7 }}>{message}</div>}
          {hasInput && (
            <div className="form-row" style={{ marginTop: 12 }}>
              <input className="input" value={input} autoFocus
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
                placeholder={inputPlaceholder} />
            </div>
          )}
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={submit} disabled={hasInput && !input.trim()}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
