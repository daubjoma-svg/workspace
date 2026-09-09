/* 模块管理页真实浏览器验证（playwright-core + 系统 Chrome，零浏览器下载）
 * 运行：node scripts/modules-verify.mjs（需后端 :4000 + vite dev :5173 已启动）
 * 流程：登录 admin → 模块管理 →
 *   1) 创建 PASTE 模块（粘贴代码）→ 列表来源 tag → 同步写快照
 *   2) GIT 表单验证（mock GitLab 项目 → 选项目 → branch=master 只读 → 创建）
 *   3) 平台挂 2 个模块 → 移除 1 个（同平台保留另一模块）
 * 截图：scripts/shots/modules-*.png
 */
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'shots');
mkdirSync(SHOTS, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://localhost:5173/';

let failed = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.error('  ✗ ' + msg); }
};

const TS = Date.now().toString(36).slice(-5);
const PASTE_KEY = `paste-demo-${TS}`;
const GIT_KEY = `git-demo-${TS}`;
const PLAT_KEY = `user-center-${TS}`;
const PLAT_NAME = '用户中心';

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-proxy-server', '--disable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 1600 } });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160)); });

const shot = (name) => page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
const gotoModules = async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  // 登录（默认 admin/admin123 已预填；按钮无显式 type=submit，按表单内唯一按钮定位）
  await page.waitForSelector('.login-panel form', { timeout: 15000 });
  await page.click('.login-panel form button');
  await page.waitForSelector('.sidebar .nav-group', { timeout: 15000 });
  // 管理后台分组默认展开 → 直接点「模块管理」
  await page.click('.nav-sub:has-text("模块管理")');
  await page.waitForSelector('h1:has-text("模块管理")', { timeout: 15000 });
  await page.waitForTimeout(400);
};

await gotoModules();
console.log('\n[1] PASTE 模块：粘贴代码创建');
// 切「粘贴代码」tab
await page.click('.seg-tabs [role="tab"]:has-text("粘贴代码")');
await page.waitForTimeout(200);
// 填模块 Key/名称
const pasteForm = page.locator('.card-pad:has-text("代码模块")').first();
await pasteForm.locator('input[placeholder="usercenter"]').fill(PASTE_KEY);
await pasteForm.locator('input[placeholder="用户中心"]').fill('粘贴演示模块');
// 粘贴内容（monospace textarea）
await pasteForm.locator('textarea.input.mono').fill(
  'services/user/\n  ├── api.js        // 用户 CRUD 接口\n  ├── README.md      // 模块说明\n  └── db.js          // 数据访问层\n\n关键接口：GET /api/users 返回用户列表，供 AI 评审做可行性分析。',
);
await shot('modules-01-paste-form.png');
// 断言 PASTE 表单 hint
assert(await page.locator('.hint:has-text("粘贴代码供 AI 读取")').count() > 0, 'PASTE 表单提示文案存在（不需要 GitLab 权限）');
await pasteForm.locator('button.btn-primary:has-text("创建代码模块")').click();
await page.waitForSelector(`.module-item .mi-key:has-text("${PASTE_KEY}")`, { timeout: 10000 });
await page.waitForTimeout(300);
const pasteItem = page.locator('.module-item', { hasText: PASTE_KEY });
assert((await pasteItem.locator('.tag-green:has-text("PASTE")').count()) === 1, '列表显示 PASTE 来源 tag（绿）');
assert(await pasteItem.locator('text=粘贴内容').count() > 0, '列表显示粘贴字符数');
await shot('modules-02-paste-created.png');

// 同步（写入快照）
await pasteItem.locator('button:has-text("写入快照")').click();
await page.waitForTimeout(1200);
await page.waitForSelector(`.module-item:has-text("${PASTE_KEY}") >> text=上次同步`, { timeout: 10000 });
await shot('modules-03-paste-synced.png');
console.log('  ✓ PASTE 同步成功（快照已写入，显示上次同步时间/文件数）');

console.log('\n[2] GIT 模块：mock GitLab 项目 → 选项目 → 创建');
// 拦截 GitLab 项目列表（mock，避免依赖真实 GitLab）
await page.route('**/api/admin/gitlab/projects', (route) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { id: 1, path: 'group/demo-repo', name: 'Demo Repo' },
    { id: 2, path: 'group/order-svc', name: 'Order Service' },
  ]) }),
);
await page.locator('button:has-text("加载 GitLab 项目")').click();
await page.waitForTimeout(500);
// 切回 Git 拉取 tab（模块 Key/名称字段为表单共享状态，需重新填写 GIT 专用值）
await page.click('.seg-tabs [role="tab"]:has-text("Git 拉取")');
await page.waitForTimeout(200);
const gitForm = page.locator('.card-pad:has-text("代码模块")').first();
await gitForm.locator('input[placeholder="usercenter"]').fill(GIT_KEY);
await gitForm.locator('input[placeholder="用户中心"]').fill('Git 演示模块');
// branch 只读 = master
const branchInput = gitForm.locator('input[value="master"]');
assert((await branchInput.count()) === 1 && await branchInput.isDisabled(), 'branch 显示为只读 master');
assert(await gitForm.locator('.hint:has-text("服务端固定 master")').count() > 0, 'branch 固定 master 提示存在');
// 独立 Token 输入框（SecretInput 复用）
assert(await gitForm.locator('.secret-wrap input[type="password"]').count() >= 1, '独立 Git Token SecretInput 存在');
await shot('modules-04-git-form.png');
// 选 GitLab 项目
await gitForm.locator('.form-row:has-text("GitLab 项目")').locator('.ss-trigger').click();
await page.locator('.ss-option', { hasText: 'group/demo-repo' }).click();
await page.waitForTimeout(200);
await gitForm.locator('input[placeholder="如 services/user(留空取整个仓库)"]').fill('services/user');
await gitForm.locator('button.btn-primary:has-text("创建代码模块")').click();
await page.waitForSelector(`.module-item .mi-key:has-text("${GIT_KEY}")`, { timeout: 10000 });
const gitItem = page.locator('.module-item', { hasText: GIT_KEY });
assert((await gitItem.locator('.tag-blue:has-text("GIT")').count()) === 1, '列表显示 GIT 来源 tag（蓝）');
assert((await page.locator('.module-item').count()) >= 2, '列表包含 GIT + PASTE 两个模块');
await shot('modules-05-git-created.png');

console.log('\n[3] 平台映射：一平台挂 2 模块 → 移除 1 个');
const mapCard = page.locator('.card-pad:has-text("平台模块映射")').first();
await mapCard.locator('input[placeholder="user-center"]').fill(PLAT_KEY);
await mapCard.locator('input[placeholder="用户中心"]').fill(PLAT_NAME);
// 挂第 1 个：PASTE 模块
await mapCard.locator('.form-row:has-text("挂载代码模块")').locator('.ss-trigger').click();
await page.locator('.ss-option', { hasText: PASTE_KEY }).click();
await page.waitForTimeout(150);
await mapCard.locator('button.btn-primary:has-text("挂载模块")').click();
await page.waitForTimeout(600);
// 挂第 2 个：GIT 模块（同 platform_key 自动复用 platform_name）
await mapCard.locator('input[placeholder="user-center"]').fill(PLAT_KEY);
await mapCard.locator('.form-row:has-text("挂载代码模块")').locator('.ss-trigger').click();
await page.locator('.ss-option', { hasText: GIT_KEY }).click();
await page.waitForTimeout(150);
await mapCard.locator('button.btn-primary:has-text("挂载模块")').click();
await page.waitForTimeout(600);

const platGroup = page.locator('.module-item', { hasText: PLAT_KEY });
assert((await platGroup.locator('.chip').count()) === 2, `平台「${PLAT_NAME}」挂载 2 个模块`);
assert(await platGroup.locator('text=2 个模块').count() > 0, '分组显示模块数量（2 个模块）');
await shot('modules-06-mappings-2modules.png');

// 移除第 1 个（PASTE 模块映射），同平台保留 GIT
const firstChip = platGroup.locator('.chip').first();
const firstChipName = (await firstChip.textContent()).trim();
await firstChip.locator('.chip-x').click();
await page.waitForTimeout(700);
const platGroup2 = page.locator('.module-item', { hasText: PLAT_KEY });
assert((await platGroup2.locator('.chip').count()) === 1, `移除「${firstChipName}」后仅剩 1 个模块（同平台保留另一模块）`);
await shot('modules-07-mapping-removed.png');

console.log('\n(测试数据保留在库中，便于人工复核；键名带时间戳后缀不冲突)');

await browser.close();
console.log(failed ? `\n❌ ${failed} 项断言失败` : '\n✅ 全部断言通过');
process.exit(failed ? 1 : 0);
