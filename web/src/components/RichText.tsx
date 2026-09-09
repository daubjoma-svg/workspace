/* 富文本渲染出口（RichText）—— 所有富文本内容（需求描述 / PRD / 聊天消息 / 回答）的唯一渲染入口
 *
 * XSS 红线：来自 Tiptap / 用户输入的 HTML 必须先 sanitizeHtml（DOMPurify 白名单）再进
 * dangerouslySetInnerHTML；存量纯文本（无 HTML 标签，老数据）走 React 文本节点天然转义。
 * - 含 HTML 标签 → sanitizeHtml 后 innerHTML
 * - 纯文本 → 原样文本节点（React 自动转义，不包标签语义）
 */
import type { CSSProperties } from 'react';
import { safeRenderHtml } from '../lib/sanitize';

interface RichTextProps {
  html: string;
  className?: string;
  style?: CSSProperties;
}

export function RichText({ html, className, style }: RichTextProps) {
  const safe = safeRenderHtml(html);
  if (safe) {
    return <div className={className} style={style} dangerouslySetInnerHTML={{ __html: safe }} />;
  }
  return <div className={className} style={style}>{html}</div>;
}
