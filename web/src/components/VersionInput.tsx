import React from 'react';

/**
 * 目标版本输入（契约 v2：target_version 替代 expect_date）。
 * 格式：YYM月版本，如 '26M8V1'（26年8月V1版）；每月四版本 W1(小)/V1(大)/W2(小)/V2(大)。
 * 提供当前月四个版本的快捷选择，同时允许手动输入任意格式。
 */

/** 当前月的四个快捷版本（如 2026-08 → ['26M8W1','26M8V1','26M8W2','26M8V2']） */
export function currentMonthVersions(): string[] {
  const d = new Date();
  const mk = `${String(d.getFullYear()).slice(-2)}M${d.getMonth() + 1}`;
  return [`${mk}W1`, `${mk}V1`, `${mk}W2`, `${mk}V2`];
}

/** 与后端 routes.js TARGET_VERSION_RE 对齐：2xM(1-12)(W1|V1|W2|V2)，如 26M8V1 */
export const TARGET_VERSION_RE = /^2\dM(1[0-2]|[1-9])(W1|V1|W2|V2)$/;
export const isValidTargetVersion = (v: string): boolean =>
  typeof v === 'string' && TARGET_VERSION_RE.test(v.trim());

export interface VersionInputProps {
  value: string;
  onChange: (v: string) => void;
  /** 输入框 aria-label（表单可访问性） */
  label?: string;
}

export function VersionInput({ value, onChange, label = '目标版本' }: VersionInputProps) {
  const quick = currentMonthVersions();
  return (
    <div>
      <input
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="如 26M8V1（26年8月V1版）"
        aria-label={label}
      />
      <div className="hint">格式：YYM月版本；每月 W1/V1/W2/V2 四版本</div>
      <div className="chip-group version-quick" role="group" aria-label="本月快捷版本">
        {quick.map((v) => (
          <button
            key={v}
            type="button"
            className={`chip sm ${value === v ? 'on' : ''}`}
            onClick={() => onChange(v)}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}
