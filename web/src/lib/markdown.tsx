/* 轻量 Markdown 渲染（PRD 编辑器预览 / PRD 产物展示共用）
 *
 * 零依赖：不引 marked / react-markdown。
 * 安全模型：不产出 HTML 字符串 —— 把源码解析成 token 数组再映射成 React 元素树，
 * 文本交给 React 自动转义，天然免 XSS；链接/图片协议再单独白名单校验。
 *
 * 支持：h1~h4、**粗体**、*斜体*、`行内代码`、```代码块```、有序/无序列表、
 *       [文字](链接)、![alt](链接) 或 ![](data:image/...)（粘贴图片）。
 */
import { createElement } from 'react';
import type { ReactNode } from 'react';

/** 链接白名单：仅 http/https（mailto / javascript: / 协议相对等一律不放行） */
function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** 图片白名单：http/https 或 data:image（粘贴图片转成的 base64 data URL） */
function isSafeImageSrc(src: string): boolean {
  return /^(https?:\/\/|data:image\/)/i.test(src.trim());
}

/* 行内 token（顺序即优先级）：图片 > 链接 > 行内代码 > 粗体 > 斜体
 * 注意：g1 是整个交替的整体匹配（恒有值），用 g2/g4/g6/g7/g8 判定命中的分支。
 * 用 matchAll（内部克隆正则）而非 exec + lastIndex：parseInline 会递归调用自身，
 * 共享全局正则的 lastIndex 会被递归清掉导致外层死循环。 */
const INLINE_RE =
  /(!\[([^\]]*)\]\(([^)]*)\)|\[([^\]]+)\]\(([^)]*)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;

function parseInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push(text.slice(last, idx));
    const k = `${keyBase}-${n++}`;
    if (m[2] !== undefined) {
      // 图片 ![alt](src)
      const alt = m[2];
      const src = m[3];
      if (isSafeImageSrc(src)) nodes.push(<img key={k} src={src} alt={alt || '图片'} />);
      else nodes.push(alt || m[0]); // 不安全 src → 只留文字（React 自动转义）
    } else if (m[4] !== undefined) {
      // 链接 [text](url)
      const label = m[4];
      const href = m[5];
      if (isSafeUrl(href)) {
        nodes.push(<a key={k} href={href} target="_blank" rel="noopener noreferrer">{parseInline(label, k)}</a>);
      } else {
        nodes.push(m[0]); // 不安全链接 → 保留原文，不生成 <a>
      }
    } else if (m[6] !== undefined) {
      // 行内代码
      nodes.push(<code key={k}>{m[6]}</code>);
    } else if (m[7] !== undefined) {
      // 粗体
      nodes.push(<strong key={k}>{parseInline(m[7], k)}</strong>);
    } else if (m[8] !== undefined) {
      // 斜体
      nodes.push(<em key={k}>{parseInline(m[8], k)}</em>);
    }
    last = idx + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const HEADING_RE = /^(#{1,4})\s+(.*)$/;
const UL_RE = /^\s*[-*+]\s+/;
const OL_RE = /^\s*\d+[.)]\s+/;

/** 将存量 Markdown 转成 Tiptap 可编辑的 HTML，避免 Markdown 源码被当作单行纯文本显示。 */
export function markdownToHtml(src: string): string {
  const escape = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const inline = (value: string) => {
    let out = escape(value);
    out = out.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/gi, '<img src="$2" alt="$1">');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, '<a href="$2">$1</a>');
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return out;
  };
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      i++;
      continue;
    }
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? OL_RE.test(lines[i]) : UL_RE.test(lines[i]))) {
        items.push(`<li>${inline(lines[i].replace(ordered ? OL_RE : UL_RE, ''))}</li>`);
        i++;
      }
      blocks.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const paragraph: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !HEADING_RE.test(lines[i]) && !/^```/.test(lines[i]) && !UL_RE.test(lines[i]) && !OL_RE.test(lines[i])) {
      paragraph.push(lines[i++]);
    }
    blocks.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return blocks.join('');
}

/** 把 Markdown 源码渲染为 React 元素数组（块级）。可直接放入 <div className="md md-render">。 */
export function renderMarkdown(src: string): ReactNode[] {
  const lines = String(src ?? '').split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  while (i < lines.length) {
    const line = lines[i];
    const k = `b${b++}`;

    // 代码块 ```lang ... ```
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过闭合 ```（若缺闭合，i 已到末尾）
      blocks.push(<pre key={k}><code>{buf.join('\n')}</code></pre>);
      continue;
    }

    // 标题 # ~ ####
    const h = line.match(HEADING_RE);
    if (h) {
      const tag = ('h' + h[1].length) as 'h1' | 'h2' | 'h3' | 'h4';
      blocks.push(createElement(tag, { key: k }, parseInline(h[2], k)));
      i++;
      continue;
    }

    // 无序列表
    if (UL_RE.test(line)) {
      const items: ReactNode[] = [];
      let n = 0;
      while (i < lines.length && UL_RE.test(lines[i])) {
        const itemText = lines[i].replace(UL_RE, '');
        items.push(<li key={`${k}-${n++}`}>{parseInline(itemText, `${k}-${n}`)}</li>);
        i++;
      }
      blocks.push(<ul key={k}>{items}</ul>);
      continue;
    }

    // 有序列表
    if (OL_RE.test(line)) {
      const items: ReactNode[] = [];
      let n = 0;
      while (i < lines.length && OL_RE.test(lines[i])) {
        const itemText = lines[i].replace(OL_RE, '');
        items.push(<li key={`${k}-${n++}`}>{parseInline(itemText, `${k}-${n}`)}</li>);
        i++;
      }
      blocks.push(<ol key={k}>{items}</ol>);
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 段落：合并直到空行或下一个块开始
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !HEADING_RE.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(<p key={k}>{parseInline(buf.join('\n'), k)}</p>);
  }
  return blocks;
}
