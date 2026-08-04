import React from 'react';
import { Icon, IconName } from './Icon';

export interface EmptyStateProps {
  icon: IconName;
  /** 一句话说明「空的是什么」 */
  title: string;
  /** 为什么空 */
  reason?: string;
  /** 可以怎么做 / 不处理的后果 */
  guide?: string;
  /** 主操作 + 次操作 */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * 空态三段式：为什么空 → 可以怎么做 → 后果。
 * 禁止只写「暂无数据」——空态是引导位，不是占位符。
 */
export function EmptyState({ icon, title, reason, guide, actions, className }: EmptyStateProps) {
  return (
    <div className={`empty-state ${className || ''}`}>
      <Icon name={icon} size={24} className="es-icon" />
      <div className="es-title">{title}</div>
      {reason && <p className="es-text">{reason}</p>}
      {guide && <p className="es-text">{guide}</p>}
      {actions && <div className="es-actions">{actions}</div>}
    </div>
  );
}
