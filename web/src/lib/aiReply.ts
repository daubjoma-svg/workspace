// AI 追问回复 → 富文本 HTML
// AI 输出常含 markdown 风格的转义字符（\n\n、\n#、\n-、**bold**），前端需转成可读的富文本（标题/列表/粗体/代码）。
// 输出经过 lib/sanitize 的白名单，sanitizeHtml 天然防 XSS。

import { safeRenderHtml } from './sanitize';

type CharMap = Record<string, string>;
const ESCAPE_MAP: CharMap = { '<': '&lt;', '&': '&amp;' };

/** 把 AI 回复字符串先转义再 markdown → HTML，最终走 sanitizeHtml 白名单 */
export function aiReplyToHtml(text: string): string {
  if (!text) return '';
  let s = String(text);

  // 1. 把字面 "\n" / "\t" 转成真换行/制表符（LLM 经常把换行 JSON 化成 "\n"）
  s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');

  // 2. 把 ```code``` 围栏代码块 → <pre><code>
  s = s.replace(/```([a-zA-Z0-9_+\-#]*)\n([\s\S]*?)```/g, (_: string, lang: string, code: string) => {
    const safe = String(code).replace(/[<&]/g, (c: string) => ESCAPE_MAP[c] ?? c);
    return `<pre class="ai-code"><code data-lang="${lang || ''}">${safe}</code></pre>`;
  });

  // 3. 行内 `code` → <code>（先做避免被下面的 ** 误匹配）
  s = s.replace(/`([^`\n]+)`/g, (_: string, c: string) => `<code class="ai-inline-code">${c.replace(/[<&]/g, (x: string) => ESCAPE_MAP[x] ?? x)}</code>`);

  // 4. 标题（# ## ###）—— 行首匹配
  s = s.replace(/^###\s+(.+)$/gm, '<h4 class="ai-h">$1</h4>');
  s = s.replace(/^##\s+(.+)$/gm, '<h3 class="ai-h">$1</h3>');
  s = s.replace(/^#\s+(.+)$/gm, '<h3 class="ai-h">$1</h3>');

  // 5. 加粗 **bold**
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  // 6. 列表项（"- item" / "* item"）—— 行首；连片合成 <ul>
  s = s.replace(/^[ \t]*[-*]\s+(.+)$/gm, '<li class="ai-li">$1</li>');
  s = s.replace(/(?:<li class="ai-li">[\s\S]*?<\/li>(?:\s*))+/g, (block: string) => `<ul class="ai-ul">${block.trim()}</ul>`);

  // 7. 段落换行：连续两个换行 → <br><br>；单个换行 → <br>
  s = s.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');

  // 8. 行内 file:line 这种「路径:行号」高亮（grep 类输出常见）
  s = s.replace(/(\b[\w./_-]+\.(?:java|xml|kt|js|ts|py|go|json|yml|yaml|sql|properties)\b:\d+)/g,
    '<span class="ai-path">$1</span>');

  // 9. 末尾交给 sanitize 白名单过滤（防 XSS；保留我们刚生成的标签类名）
  return safeRenderHtml(s) || "";
}