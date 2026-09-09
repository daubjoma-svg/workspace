/* RichTextEditor 真实浏览器验证（playwright-core + 系统 Chrome，零浏览器下载）
 * 运行：node scripts/rte-playwright.mjs（需先启动 vite dev：npm run dev）
 * 截图输出：scripts/shots/rte-*.png
 */
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'shots');
mkdirSync(SHOTS, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://localhost:5173/rte-demo.html';

let failed = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.error('  ✗ ' + msg); }
};

/** 1x1 透明 PNG */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-proxy-server', '--disable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1500 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160)); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.rte-content', { timeout: 15000 });
// 截图装饰：1×1 透明 PNG 肉眼不可见，给所有 img 加红色背景 + 强制最小尺寸
// 让粘贴图在截图里可见（不影响 innerHTML / src 断言；仅视觉）
// chat-bubble img 用 !important 覆盖 max-width:100%，避免被父容器压成 1px
await page.addStyleTag({ content: `
  .rte img, .chat-bubble img { background: var(--danger); min-width: 120px; min-height: 48px; display: block !important; }
  .chat-bubble img { width: 160px !important; height: 64px !important; }
` });
console.log('案例0：页面加载，3 个编辑器挂载');
assert((await page.locator('.rte-content').count()) === 3, '3 个 RichTextEditor 实例（PRD/描述/聊天）');

/** 向指定编辑器分发粘贴图片事件（模拟 Ctrl+V） */
const pasteImageTo = (idx) => page.evaluate((i) => {
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const file = new File([bytes], 'pixel.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  document.querySelectorAll('.rte-content')[i].dispatchEvent(ev);
}, idx);

/* ============ ① PRD 编辑 ============ */
console.log('案例1：PRD 富文本编辑（粗体 / 粘贴图片 / / 菜单 / 链接 / 保存回显）');
const prd = page.locator('.rte').nth(0);
const prdContent = prd.locator('.rte-content');

// 清空初始内容
await prdContent.click();
await page.keyboard.press('Meta+A');
await page.keyboard.press('Backspace');

// 粗体
await prd.locator('.rte-toolbar button[aria-label="粗体"]').click();
await page.keyboard.type('粗体测试');
await prd.locator('.rte-toolbar button[aria-label="粗体"]').click();
let html = await prdContent.evaluate((el) => el.innerHTML);
assert(html.includes('<strong>粗体测试</strong>'), '工具栏粗体 → <strong>粗体测试</strong>');
await page.screenshot({ path: path.join(SHOTS, 'rte-01-prd-editor.png') });

// 粘贴图片（后端上传接口若不可用 → 降级 base64，图片仍应出现）
await prdContent.click();
await page.keyboard.press('End');
await page.keyboard.press('Enter');
await pasteImageTo(0);
await page.waitForFunction(() => document.querySelectorAll('.rte')[0].querySelector('img'), null, { timeout: 8000 });
html = await prdContent.evaluate((el) => el.innerHTML);
assert(/<img[^>]+src="(data:image\/png;base64|http:\/\/localhost:4000\/uploads)/.test(html), '粘贴图片 → <img> 出现（上传成功或 base64 降级）');
await page.screenshot({ path: path.join(SHOTS, 'rte-03-pasted-image.png') });

// `/` 快捷命令：新行输入 / → 菜单 → Enter 选标题
await prdContent.click();
await page.keyboard.press('End');
await page.keyboard.press('Enter');
await page.keyboard.type('/');
await page.waitForSelector('.rte-slash', { timeout: 4000 });
const slashText = await page.locator('.rte-slash').textContent();
assert(slashText.includes('标题') && slashText.includes('无序列表') && slashText.includes('分割线'), '/ 唤起快捷菜单（标题/列表/代码/图片/分割线）');
await page.screenshot({ path: path.join(SHOTS, 'rte-02-slash-menu.png') });
await page.keyboard.press('Enter'); // 选中第一项「标题 H2」
await page.waitForFunction(() => document.querySelectorAll('.rte')[0].querySelector('h2'), null, { timeout: 4000 });
html = await prdContent.evaluate((el) => el.innerHTML);
assert(html.includes('<h2>'), '/ 菜单 Enter → <h2> 标题块');

// 链接：输入文字 → 选中 → 弹窗填 URL
await prdContent.click();
await page.keyboard.press('End');
await page.keyboard.press('Enter');
await page.keyboard.type('访问文档');
for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
page.once('dialog', (d) => d.accept('https://example.com'));
await prd.locator('.rte-toolbar button[aria-label="插入链接"]').click();
html = await prdContent.evaluate((el) => el.innerHTML);
assert(/<a[^>]+href="https:\/\/example\.com"/.test(html), '链接插入 → <a href="https://example.com">');

// 保存 → 刷新回显
await page.locator('button:has-text("保存（写入 localStorage）")').click();
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.rte-content', { timeout: 15000 });
const prd2 = page.locator('.rte').nth(0).locator('.rte-content');
html = await prd2.evaluate((el) => el.innerHTML);
assert(html.includes('粗体测试') && html.includes('<strong>'), '刷新回显：粗体保留');
assert(html.includes('<h2>'), '刷新回显：标题保留');
assert(html.includes('<img'), '刷新回显：图片保留');
await page.screenshot({ path: path.join(SHOTS, 'rte-04-saved-render.png') });

/* ============ ② 需求描述（存量纯文本） ============ */
console.log('案例2：需求描述（存量纯文本加载）');
const descContent = page.locator('.rte').nth(1).locator('.rte-content');
const descText = await descContent.textContent();
assert(descText.includes('存量纯文本描述'), '存量纯文本正确载入编辑器');

/* ============ ③ 聊天（compact + Enter 发送 + 气泡富文本） ============ */
console.log('案例3：聊天（compact · 图片消息）');
const chat = page.locator('.rte').nth(2);
const chatContent = chat.locator('.rte-content');
await chatContent.click();
await page.keyboard.type('带图消息');
await pasteImageTo(2);
await page.waitForFunction(() => document.querySelectorAll('.rte')[2].querySelector('img'), null, { timeout: 8000 });
await page.keyboard.press('Enter'); // Enter 发送
await page.waitForFunction(() => document.querySelectorAll('.chat-bubble').length >= 3, null, { timeout: 4000 });
const bubbles = page.locator('.chat-bubble');
// 初始 2 条 + 新发 1 条 = 3 条；新消息是第 3 条（index 2）
const sentBubble = bubbles.nth(2);
assert((await sentBubble.locator('img').count()) === 1, '聊天气泡内包含图片');
assert((await sentBubble.textContent()).includes('带图消息'), '聊天气泡内包含文字');
// 截图前给气泡 img 强制 inline 尺寸（CSS 选择器可能被覆盖；inline style 必胜）
await sentBubble.locator('img').evaluateAll((imgs) => {
  for (const im of imgs) {
    im.style.cssText = 'width:160px;height:64px;background:var(--danger);display:block;border-radius:6px;';
  }
});
await page.screenshot({ path: path.join(SHOTS, 'rte-05-chat.png') });

/* ============ ④ XSS 渲染安全 ============ */
console.log('案例4：XSS 渲染安全（RichText 出口）');
const xssHtml = await bubbles.last().evaluate((el) => el.innerHTML);
assert(!/onerror/i.test(xssHtml), 'img onerror 事件被剥离');
assert(!/<script/i.test(xssHtml), '<script> 被剥离');
assert(!/href="javascript:/i.test(xssHtml), 'javascript: 链接被剥离');
assert(xssHtml.includes('<strong>安全粗体</strong>'), '安全内容正常保留');
assert(!(await page.evaluate(() => (window).__xss)), 'XSS 脚本未执行');
await page.screenshot({ path: path.join(SHOTS, 'rte-06-xss.png') });

await browser.close();
if (failed) { console.error(`\n失败 ${failed} 项`); process.exit(1); }
console.log('\n全部通过 ✓');
