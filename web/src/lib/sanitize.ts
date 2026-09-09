/* 富文本 HTML 安全过滤（XSS 红线）
 *
 * 所有来自 Tiptap / 用户输入的 HTML，在渲染前必须过 sanitizeHtml。
 * - DOMPurify 白名单：仅放行富文本语义标签，禁 <script>/<iframe>/<style> 等
 * - 属性白名单 + 协议白名单：禁 on* 事件、禁 javascript: 链接、禁 data: 非图片
 * - 兼容老数据：isHtmlContent 判定「纯文本 vs HTML」，渲染层据此分流，不误伤存量纯文本
 */
import DOMPurify from 'dompurify';

/** 允许的标签：与 Tiptap StarterKit + Image + Link 输出对齐 */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'blockquote',
  'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre', 'span',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4',
  'a', 'img',
];

/** 允许的属性：href/src 走协议白名单；target/rel 由 Link 扩展生成 */
const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'target', 'rel'];

/**
 * 协议白名单：
 * - http/https/mailto 链接
 * - data:image/{png,jpeg,gif,webp};base64 （上传失败的 base64 兜底图）
 * - 相对路径（/uploads/xxx、./x、锚点）——后端返回的 /uploads/ 图片地址
 * - javascript: / vbscript: / data:text 一律拒绝（data: 仅放行上述图片格式）
 */
const SAFE_URI = /^(?:(?:https?|mailto):|data:image\/(?:png|jpe?g|gif|webp);base64,|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/** 判断字符串是否含 HTML 标签（用于老数据纯文本兼容分流） */
export function isHtmlContent(s: string): boolean {
  if (!s) return false;
  return /<\/?[a-z][^>]*>/i.test(s);
}

/** 判断富文本 HTML 是否为空（仅空段落/空白 → 视为空，便于表单校验与占位符） */
export function isEmptyHtml(html: string): boolean {
  if (!html) return true;
  const el = document.createElement('div');
  el.innerHTML = html;
  return !el.textContent?.trim() && !el.querySelector('img, hr');
}

/**
 * 富文本 HTML 安全清洗。返回可直接放入 dangerouslySetInnerHTML 的字符串。
 * DOMPurify 会剥离脚本、事件属性、危险协议，并补齐缺失的结束标签。
 */
export function sanitizeHtml(html: string): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: SAFE_URI,
  });
}

/**
 * 渲染任意内容（富文本 HTML 或存量纯文本）的安全入口：
 * - HTML → sanitizeHtml（可注入 dangerouslySetInnerHTML）
 * - 纯文本 → 原样返回（渲染层用 React 文本节点承载，天然转义）
 * 用法：const html = isHtmlContent(s) ? sanitizeHtml(s) : null; 配合 React 文本分支。
 */
export function safeRenderHtml(s: string): string | null {
  return isHtmlContent(s) ? sanitizeHtml(s) : null;
}
