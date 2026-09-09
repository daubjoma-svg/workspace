import React, { useState } from 'react';
import { Icon } from './Icon';

export interface SecretInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
  /** 是否存在已存储的密文（编辑已保存过的配置时传 true，输入为空时眼睛可查看已存明文） */
  hasStored?: boolean;
  /** 拉取已存明文（GET 明文接口）。返回明文串；空串 = 未配置 */
  onReveal?: () => Promise<string>;
  /** 清除已存密文（由父组件在提交时把密文置空串处理） */
  onClear?: () => void;
}

/**
 * 密文输入 + 小眼睛（P0-1：图标走 Icon 收口层）。
 *
 * 行为契约：
 * - 输入框默认 type=password；hasStored 且未输入时，输入框显示密文掩码（••••••••），绝不空着。
 * - 眼睛点击：未输入 + hasStored → 拉取已存明文展示（下方只读区块 + 复制）；已输入 → 切换当前输入内容的明文/密文显示。
 * - 红线：明文只在用户主动点击眼睛时请求/展示，仅存于组件内存态，不做持久化显示。
 */
const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'; // 与后端 secret.MASK 一致：8 圆点

export function SecretInput({
  value, onChange, placeholder, autoComplete = 'new-password', disabled,
  hasStored, onReveal, onClear,
}: SecretInputProps) {
  /** 输入框可见性（type=text / password） */
  const [show, setShow] = useState(false);
  /** 是否已展示「已存明文」区块 */
  const [revealed, setRevealed] = useState(false);
  /** 已拉取到的明文（仅内存态，组件卸载即释放） */
  const [storedPlain, setStoredPlain] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // 已配置且未输入时：输入框显示密文掩码（不空着），提交时 value 仍为空串 = 保留原 key
  const displayValue = value || (hasStored ? MASK : '');

  const handleEye = async () => {
    // 输入框有内容（用户输入或正在看明文）：仅切换当前输入内容的可见性
    if (value.length > 0) { setShow((s) => !s); return; }
    // 无内容且已配置：切换「已存明文」区块
    if (!hasStored) return;
    if (revealed) { setRevealed(false); return; }
    if (!onReveal) return;
    setBusy(true);
    try {
      const plain = await onReveal();
      setStoredPlain(plain || '');
      setRevealed(true);
    } catch {
      setStoredPlain('');
      setRevealed(true);
    } finally { setBusy(false); }
  };

  const copy = async () => {
    if (!storedPlain) return;
    try {
      await navigator.clipboard.writeText(storedPlain);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* 剪贴板不可用时静默，用户可手动选中复制 */ }
  };

  const showing = show || revealed;

  return (
    <div>
      <div className="secret-wrap">
        <input
          className="input"
          type={show ? 'text' : 'password'}
          value={displayValue}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete={autoComplete}
          onChange={(e) => {
            // 掩码是显示占位不是真实值：用户未改动（值=掩码）或清空时传空串，父组件据此"保留原 key"
            const next = e.target.value;
            onChange(next === MASK ? '' : next);
          }}
        />
        {(value.length > 0 || hasStored) && (
          <button
            type="button"
            className="eye-btn"
            disabled={busy || disabled}
            onClick={handleEye}
            aria-label={showing ? '隐藏密文' : '显示密文'}
          >
            <Icon name={showing ? 'eye-off' : 'eye'} size={16} />
          </button>
        )}
      </div>
      {revealed && (
        <div className="secret-reveal">
          <span className="muted">已存明文</span>
          <code className="mono">{storedPlain || '（未配置）'}</code>
          {storedPlain && (
            <div className="secret-actions">
              <button type="button" className="btn btn-sm" onClick={copy}>
                <Icon name="copy" size={16} />
                {copied ? '已复制' : '复制'}
              </button>
              {onClear && (
                <button type="button" className="btn btn-sm btn-danger" onClick={onClear}>
                  清除 Key
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
