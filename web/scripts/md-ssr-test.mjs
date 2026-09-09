/* Markdown 渲染函数 SSR 安全验证（零浏览器环境）
 * 运行：cd web && node scripts/md-ssr-test.mjs
 * 用 esbuild 把 lib/markdown.tsx 转成 ESM，react-dom/server 做静态渲染，断言：
 *   1) 正常 Markdown（标题/列表/链接/图片）被正确渲染
 *   2) <script>alert(1)</script> 注入被转义为文本、不产生 <script> 元素
 *   3) [x](javascript:...) 恶意链接被过滤，不产生 <a> / href="javascript:"
 */
import { transform } from 'esbuild';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, '../src/lib/markdown.tsx'), 'utf8');
const { code } = await transform(src, { loader: 'tsx', format: 'esm', jsx: 'automatic' });

const tmp = path.join(__dirname, '.md-ssr-test-tmp.mjs');
writeFileSync(tmp, code);

const mod = await import(new URL('file://' + tmp).href + '?t=' + Date.now());
const { renderMarkdown } = mod;
const { default: ReactDOMServer } = await import('react-dom/server');
const { default: React } = await import('react');

const render = (md) => ReactDOMServer.renderToStaticMarkup(React.createElement('div', null, renderMarkdown(md)));

let failed = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.error('  ✗ ' + msg); }
};

console.log('案例1：正常 Markdown（标题/列表/链接/图片）');
const normal = render(
  '# 标题一\n\n- 条目 A\n- 条目 B\n\n1. 一\n2. 二\n\n[文档](https://docs.example.com/a)\n\n![图](data:image/png;base64,iVBORw0KGgo=)'
);
assert(normal.includes('<h1>标题一</h1>'), 'h1 渲染');
assert(normal.includes('<ul>') && normal.includes('<li>条目 A</li>'), '无序列表渲染');
assert(normal.includes('<ol>') && normal.includes('<li>一</li>'), '有序列表渲染');
assert(normal.includes('<a href="https://docs.example.com/a"'), 'https 链接渲染为 <a>');
assert(normal.includes('<img src="data:image/png;base64'), 'data:image 图片渲染为 <img>');

console.log('案例2：<script> 注入');
const inj = render('正常文本\n\n<script>alert(1)</script>\n\n结束');
assert(!inj.includes('<script'), '输出中无 <script> 元素');
assert(inj.includes('&lt;script&gt;'), '注入内容被 React 转义为纯文本');

console.log('案例3：javascript: 恶意链接 / 图片');
const evil = render('[点我](javascript:alert(1))\n\n![图](javascript:alert(2))');
assert(!evil.includes('<a'), '恶意链接不产生 <a> 元素');
assert(!evil.includes('href="javascript'), '无 javascript: href 属性');
assert(!evil.includes('<img'), '恶意图片不产生 <img> 元素');

unlinkSync(tmp);
if (failed) { console.error(`\n失败 ${failed} 项`); process.exit(1); }
console.log('\n全部通过 ✓');
