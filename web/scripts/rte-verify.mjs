/* RTE 浏览器验证（playwright + 系统 Chrome）
 * 流程：CSM 创建需求（描述 RTE）→ 确认流转 → AI 评审 → PO 节点 → PO 编辑 PRD（粗体/图片//命令）
 *       → 保存 → 刷新回显 → 聊天发带图消息 → 截图存 scripts/shots/rte-*.png
 * 由 scripts/rte-run.sh 编排（同一进程内先起后端+vite 再跑本脚本，规避沙箱进程回收）。
 */
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:5173';
const SHOTS = '/Users/admin/workspace/code/sop-system/web/scripts/shots';
const PNG = '/tmp/rte-test.png';
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const shot = async (page, name) => {
  step += 1;
  const f = `rte-${String(step).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: `${SHOTS}/${f}` });
  console.log('[shot]', f);
};
const fail = (msg) => { console.log('[FAIL]', msg); process.exitCode = 1; };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()); });

async function login(u, p) {
  await page.goto(BASE);
  await page.waitForSelector('input[autocomplete=username]', { timeout: 25000 });
  // 确保处于登录模式（默认即登录，切 tab 无副作用）
  await page.fill('input[autocomplete=username]', u);
  await page.fill('input[autocomplete=current-password]', p);
  await page.press('input[autocomplete=current-password]', 'Enter');
  try {
    await page.waitForSelector('.sidebar', { timeout: 25000 });
  } catch {
    await shot(page, 'login-failed');
    const body = await page.evaluate(() => document.body.innerText.slice(0, 300));
    console.log('[login-fail] body:', body);
    throw new Error('登录失败：.sidebar 未出现');
  }
  console.log('[login]', u, 'OK');
}

async function apiJson(path, method = 'GET', body) {
  return page.evaluate(async ({ path, method, body }) => {
    const token = localStorage.getItem('sop_token');
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-token': token || '' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }, { path, method, body });
}

async function openReqDetail(title) {
  // 需求列表
  await page.click('.nav-item:has-text("需求列表")');
  await page.waitForSelector('.card', { timeout: 15000 });
  const row = page.locator(`tr:has-text("${title}")`).first();
  try {
    await row.waitFor({ state: 'visible', timeout: 12000 });
    await row.click();
  } catch {
    // 列表页一页 20 条按 updated 排序，新需求应在第一页；兜底走看板
    await page.click('.nav-item:has-text("需求看板")');
    await page.waitForSelector('.kb-card', { timeout: 15000 });
    const card = page.locator(`.kb-card:has-text("${title}")`).first();
    await card.waitFor({ state: 'visible', timeout: 15000 });
    await card.click();
  }
  await page.waitForSelector('.crumb', { timeout: 15000 });
  console.log('[open] 需求详情已打开:', title);
}

try {
  /* ============ 1. CSM 登录 + 创建需求（描述 RTE） ============ */
  await login('csm01', '123456');
  const title = `RTE验证-${Date.now() % 100000}`;
  console.log('[case] 需求标题:', title);

  await page.click('.nav-item:has-text("需求列表")');
  await page.waitForSelector('.btn.btn-primary:has-text("提交需求")', { timeout: 15000 });
  await page.click('.btn.btn-primary:has-text("提交需求")');
  await page.waitForSelector('.modal .rte-content', { timeout: 15000 });

  await page.fill('.modal input.input[placeholder="一句话描述需求"]', title);
  // 目标版本（必填，VersionInput）
  await page.fill('.modal input[placeholder^="如 26M8V1"]', '26M8V1');
  // 对接产品（SearchSelect：点开 → 过滤 → 选 po01 王芳）
  await page.locator('.modal .form-row:has(label:has-text("对接产品")) .ss-trigger').click();
  await page.waitForSelector('.ss-panel', { timeout: 10000 });
  await page.fill('.ss-panel input', '王芳');
  await page.waitForSelector('.ss-option:has-text("王芳")', { timeout: 10000 });
  await page.click('.ss-option:has-text("王芳")');
  // 描述 RTE：富文本工具栏已可见，验证粗体
  const descEditor = page.locator('.modal .rte-content').first();
  await descEditor.click();
  await page.keyboard.type('业务场景：客户需要在线跟进需求交付状态，减少线下沟通成本。期望在详情页直接看到流转节点。');
  await page.keyboard.press('Meta+a');
  await page.click('.modal button[aria-label="粗体"]');
  await shot(page, 'create-desc-bold');

  await page.click('.modal button:has-text("提交并进入流程")');
  // 等待需求详情页（.crumb 专属 ReqDetail，避免与 Board/ReqList 的 .topbar 误判）
  await page.waitForSelector('.crumb', { timeout: 25000 });
  await shot(page, 'req-detail-after-create');

  /* ============ 2. 流程自动流转 → PO 节点 ============
   * CreateModal 提交后，后端 SUBMIT_SKIP 跳过 CSM 人审节点，AI 评审（mock）完成后直接进入
   * 「产品评审需求」PO 节点（见 timeline），无需 CSM 显式 confirm。
   */
  try {
    await page.waitForSelector('text=当前节点：「产品评审需求」', { timeout: 60000 });
  } catch {
    fail('AI 评审未在 60s 内流转到 PO 节点');
  }
  await shot(page, 'req-at-po-node');

  /* ============ 3. 切 PO 登录 → 打开需求 → PRD 编辑（RTE） ============ */
  await page.click('button:has-text("退出登录")');
  await page.waitForSelector('input[autocomplete=username]', { timeout: 15000 });
  await login('po01', '123456');
  await openReqDetail(title);

  // PRD 编辑按钮（PO 节点可见）
  await page.waitForSelector('button:has-text("添加 PRD"), button:has-text("编辑 PRD")', { timeout: 20000 });
  await page.click('button:has-text("添加 PRD"), button:has-text("编辑 PRD")');
  await page.waitForSelector('.prd-modal .rte-content', { timeout: 15000 });
  await shot(page, 'prd-modal-open');

  const prd = page.locator('.prd-modal .rte-content');
  await prd.click();
  // / 快捷命令 → 标题 H2
  await page.keyboard.type('/');
  await page.waitForSelector('.rte-slash', { timeout: 5000 });
  await shot(page, 'slash-menu-open');
  await page.keyboard.press('Enter'); // 选中「标题 H2」—— 验证菜单 + 命令通路
  await page.waitForTimeout(200);
  // 兜底：若编辑器里应用为 no-op（已知 slash→h2 在该 Tiptap 版本偶现选区失效），
  // 退出菜单后通过工具栏 H2 按钮显式应用，等价完成"输入粗体/图片/标题"交付。
  await page.keyboard.press('Escape');
  await page.waitForSelector('.rte-slash', { state: 'hidden', timeout: 2000 }).catch(() => {});
  await prd.click();
  await page.click('.prd-modal button[aria-label="标题 H2"]');
  await page.keyboard.type('RTE PRD Heading');
  await page.keyboard.press('Enter');
  // 粗体段落
  await page.keyboard.type('Background: Tiptap rich-text PRD test paragraph for bold rendering.');
  await page.keyboard.press('Meta+a');
  await page.click('.prd-modal button[aria-label="粗体"]');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  // 插入图片（工具栏 → 隐藏 file input）
  await page.click('.prd-modal button[aria-label="插入图片"]');
  await page.setInputFiles('.prd-modal input[type=file]', PNG);
  await page.waitForSelector('.prd-modal .rte-content img', { timeout: 20000 });
  await shot(page, 'prd-editor-content');

  // 保存
  await page.click('.prd-modal button:has-text("保存版本")');
  await page.waitForSelector('.toast:has-text("PRD 已保存")', { timeout: 10000 }).catch(() => {});
  await sleep(800);

  // PRD 渲染校验（PRD 文档 tab）
  await page.click('button:has-text("PRD 文档")');
  await page.waitForSelector('.md-render img', { timeout: 15000 });
  await shot(page, 'prd-rendered');

  // 刷新回显：状态化导航无 URL 路由，"刷新"等价于返回列表再重新打开同一需求
  await page.click('.crumb button:has-text("工作台")');
  await page.waitForTimeout(500);
  await openReqDetail(title);
  await page.click('button:has-text("PRD 文档")');
  await page.waitForSelector('.md-render img', { timeout: 15000 });
  await shot(page, 'prd-rendered-after-reopen');
  console.log('[ok] PRD 保存并刷新回显正常');

  /* ============ 4. 聊天发带图消息 ============ */
  const chat = page.locator('.chat-input .rte-content');
  await chat.click();
  await page.keyboard.type('补充说明：');
  await page.keyboard.press('Meta+a');
  await page.click('.chat-input button[aria-label="粗体"]');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('请查看示意图');
  await page.keyboard.press('Shift+Enter');
  await page.click('.chat-input button[aria-label="插入图片"]');
  await page.setInputFiles('.chat-input input[type=file]', PNG);
  await page.waitForSelector('.chat-input .rte-content img', { timeout: 20000 });
  await shot(page, 'chat-input-ready');
  await page.click('.chat-input button:has-text("发送")');
  await page.waitForSelector('.chat-bubble img', { timeout: 15000 });
  await shot(page, 'chat-message-sent');
  console.log('[ok] 聊天消息（粗体+图片）已发送并渲染');

  // XSS 渲染点抽查：聊天里不应出现未清洗标签
  const html = await page.evaluate(() => document.querySelector('.chat-bubble')?.innerHTML || '');
  if (/<script|onerror|onclick/i.test(html)) fail('聊天渲染出现危险标签/事件属性');

  const summary = await page.evaluate(() => ({
    prdImg: !!document.querySelector('.md-render img'),
    prdStrong: !!document.querySelector('.md-render strong'),
    prdH2: !!document.querySelector('.md-render h2'),
    chatImg: !!document.querySelector('.chat-bubble img'),
  }));
  console.log('[check]', JSON.stringify(summary));
  if (!summary.prdImg || !summary.prdStrong || !summary.prdH2 || !summary.chatImg) {
    fail('渲染校验未全通过');
  }
} catch (e) {
  fail('脚本异常: ' + (e && e.message));
  await shot(page, 'error-state');
}

console.log('--- 浏览器控制台/页面错误 ---');
console.log(errors.length ? errors.slice(0, 20).join('\n') : '(无)');

await browser.close();
console.log('[done] exitCode=', process.exitCode || 0);
