/** 管理员 Jira 默认值浏览器回归：API 全部拦截，不修改成员配置或创建真实 Jira 单据。 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const url = process.env.SOP_TEST_URL || 'http://127.0.0.1:4000';
const fields = [
  { id: 'customfield_11404', name: '平台子业务线', allowed_values: [
    { id: '1', value: '账号权限' },
    ...Array.from({ length: 18 }, (_, i) => ({ id: String(i + 2), value: `业务线-${i + 2}` })),
  ] },
  { id: 'customfield_11101', name: '涉及的研发端', allowed_values: [{ id: '2', value: '后端' }] },
  { id: 'customfield_11904', name: '归属BU', allowed_values: [
    { id: '3', value: '平台' },
    ...Array.from({ length: 16 }, (_, i) => ({ id: String(i + 4), value: `部门-${i + 4}` })),
  ] },
];
const admin = { id: 1, name: '管理员', username: 'admin', role: 'ADMIN' };
const users = [admin, { id: 36, name: '胡产品', username: 'product', role: 'PO', jira_configured: true },
  { id: 37, name: '测试成员', username: 'qa', role: 'QA' }];
const profile = {
  base_url: 'https://jira.example.com', username: 'product', token_configured: true,
  project_key: 'PINGTAI', issue_type: '产品需求',
  field_defaults: { customfield_99999: '其他默认值', customfield_11404: '业务线-19' },
  sync: { project_candidates: [{ key: 'PINGTAI', name: '平台系统需求池' }, { key: 'OTHER', name: '其他项目' }], create_fields: [] },
};
let submitted;
const browser = await chromium.launch({ headless: true });
const screenshots = await mkdtemp(path.join(tmpdir(), 'sop-jira-admin-defaults-'));
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('sop_token', 'mock-test-token'));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const parsed = new URL(request.url());
    let body = [];
    if (parsed.pathname === '/api/me') body = admin;
    else if (parsed.pathname === '/api/settings/theme') body = { primary: '', mode: 'light' };
    else if (parsed.pathname === '/api/users') body = users;
    else if (parsed.pathname.endsWith('/jira-default-fields')) {
      assert.equal(parsed.searchParams.get('issue_type'), '产品需求');
      body = parsed.searchParams.get('project_key') === 'OTHER' ? [] : fields;
    } else if (parsed.pathname.endsWith('/jira-profile')) {
      if (request.method() === 'PUT') {
        submitted = request.postDataJSON();
        profile.field_defaults = submitted.field_defaults;
      }
      body = profile;
    } else if (request.method() === 'PUT') body = { ok: true };
    await route.fulfill({ json: body });
  });
  await page.goto(url);
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  const open = async () => {
    await page.getByRole('button', { name: '编辑 胡产品', exact: true }).click();
    await page.getByRole('group', { name: fields[0].name, exact: true }).locator('button').waitFor();
  };
  const choose = async (name, value) => {
    const trigger = page.getByRole('group', { name, exact: true }).locator('button');
    await trigger.scrollIntoViewIfNeeded();
    // 等待定位产生的滚动事件结束，避免 SearchSelect 把迟到的外层滚动视为关闭操作。
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await trigger.press('Enter');
    const search = page.getByRole('combobox');
    await search.fill(value);
    await search.press('Enter');
  };
  await open();
  // 用户滚动到弹窗底部后，已选项很靠后也必须可以直接点开并滚动候选列表。
  const firstTrigger = page.getByRole('group', { name: fields[0].name, exact: true }).locator('button');
  await firstTrigger.scrollIntoViewIfNeeded();
  await firstTrigger.click();
  await page.waitForTimeout(120);
  assert.equal(await firstTrigger.getAttribute('aria-expanded'), 'true', '已选后段选项时下拉不会刚打开就关闭');
  const list = page.locator('.ss-panel-fixed .ss-list');
  const listBox = await list.boundingBox();
  await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(120);
  assert.equal(await firstTrigger.getAttribute('aria-expanded'), 'true', '滚动候选列表不能关闭下拉');
  assert.ok(await list.evaluate((el) => el.scrollTop) < 50, '滑轮应滚动候选列表');
  const modalBody = page.locator('.user-edit-modal .modal-b');
  const beforeScroll = await modalBody.evaluate((el) => el.scrollTop);
  await modalBody.evaluate((el) => { el.scrollTop = Math.max(0, el.scrollTop - 80); });
  await page.waitForTimeout(120);
  assert.ok(await modalBody.evaluate((el) => el.scrollTop) < beforeScroll, '弹窗内容可继续滚动');
  assert.equal(await firstTrigger.getAttribute('aria-expanded'), 'true', '弹窗滚动后候选列表保持展开');
  const anchor = await firstTrigger.boundingBox();
  const panel = await page.locator('.ss-panel-fixed').boundingBox();
  assert.ok(Math.min(Math.abs(panel.y - anchor.y - anchor.height - 6), Math.abs(panel.y + panel.height + 6 - anchor.y)) < 3,
    '弹窗滚动后面板仍锚定字段');
  await firstTrigger.press('Escape');
  console.log('PASS: 已选后段选项可点开，列表和弹窗可分别滚动且面板保持锚定');
  for (const name of ['默认项目', ...fields.map((f) => f.name)]) {
    const row = page.locator('.form-row').filter({ has: page.locator('label', { hasText: new RegExp(`^${name}$`) }) });
    const trigger = row.locator('.ss-trigger');
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await page.waitForTimeout(100);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true', `${name} 可用鼠标点开`);
    const panelRect = await page.locator('.ss-panel-fixed').boundingBox();
    assert.ok(panelRect && panelRect.y >= 0 && panelRect.y + panelRect.height <= 900, `${name} 选项不超出视口`);
    await page.getByRole('combobox').press('Escape');
  }
  console.log('PASS: 默认项目和三个默认字段均可用鼠标点开，面板未被视口裁切');
  const buMouseTrigger = page.getByRole('group', { name: '归属BU', exact: true }).locator('button');
  await buMouseTrigger.click();
  await page.getByRole('option', { name: '部门-8', exact: true }).click();
  assert.match(await buMouseTrigger.innerText(), /部门-8/, '归属BU 可用鼠标选择长列表中的项目');
  console.log('PASS: 长列表项目可直接用鼠标点击选择');
  for (const field of fields) await choose(field.name, field.allowed_values[0].value);
  await page.screenshot({ path: path.join(screenshots, 'desktop.png'), fullPage: true });
  await page.locator('.modal-f').getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.modal-mask').waitFor({ state: 'hidden' });
  for (const field of fields) assert.equal(submitted.field_defaults[field.id], field.allowed_values[0].value);
  assert.equal(submitted.field_defaults.customfield_99999, '其他默认值');
  assert.equal(submitted.project_key, 'PINGTAI');
  assert.equal(submitted.api_token, '__KEEP__');
  console.log('PASS: 三个默认字段可选择并提交，保留其他默认值和 Jira 密钥');

  await open();
  for (const field of fields) {
    assert.match(await page.getByRole('group', { name: field.name, exact: true }).innerText(), new RegExp(field.allowed_values[0].value));
  }
  console.log('PASS: 保存后重新打开三个字段回显');
  await choose(fields[0].name, '不设默认值');
  await page.locator('.modal-f').getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.modal-mask').waitFor({ state: 'hidden' });
  assert.equal(submitted.field_defaults[fields[0].id], undefined);
  assert.equal(submitted.field_defaults[fields[1].id], '后端');
  assert.equal(submitted.field_defaults.customfield_99999, '其他默认值');
  console.log('PASS: 可清空单个默认值，不影响其他字段');

  await open();
  const projectRow = page.locator('.form-row').filter({ has: page.locator('label', { hasText: /^默认项目$/ }) });
  await projectRow.locator('button').scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await projectRow.locator('button').press('Enter');
  await page.getByRole('combobox').fill('其他项目');
  await page.getByRole('combobox').press('Enter');
  await page.getByPlaceholder('该项目暂无此字段，请先保存 Jira 账号配置').first().waitFor();
  assert.equal(await page.getByPlaceholder('该项目暂无此字段，请先保存 Jira 账号配置').count(), 3);
  console.log('PASS: 切换项目重新读取字段，不使用旧项目选项');
  await page.locator('.modal-f').getByRole('button', { name: '取消', exact: true }).click();

  await page.setViewportSize({ width: 375, height: 812 });
  await open();
  for (const field of fields) {
    const group = page.getByRole('group', { name: field.name, exact: true });
    await group.scrollIntoViewIfNeeded();
    const box = await group.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 375, `${field.name} 不溢出手机弹窗`);
  }
  const buTrigger = page.getByRole('group', { name: '归属BU', exact: true }).locator('button');
  await buTrigger.click();
  await page.waitForTimeout(120);
  assert.equal(await buTrigger.getAttribute('aria-expanded'), 'true', '窄屏归属BU 可点开');
  const buList = page.locator('.ss-panel-fixed .ss-list');
  const buBox = await buList.boundingBox();
  await page.mouse.move(buBox.x + buBox.width / 2, buBox.y + buBox.height / 2);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(120);
  const buScroll = await buList.evaluate((el) => ({ top: el.scrollTop, total: el.scrollHeight, visible: el.clientHeight,
    pointed: document.elementFromPoint(el.getBoundingClientRect().left + el.clientWidth / 2, el.getBoundingClientRect().top + el.clientHeight / 2)?.className }));
  assert.ok(buScroll.top > 0, `窄屏归属BU 滚轮生效 ${JSON.stringify(buScroll)}`);
  assert.equal(await buTrigger.getAttribute('aria-expanded'), 'true', '窄屏滚轮滚动后列表保持展开');
  await page.screenshot({ path: path.join(screenshots, 'mobile-dropdown.png') });
  await page.getByRole('combobox').press('Escape');
  await page.screenshot({ path: path.join(screenshots, 'mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: 手机弹窗三个控件可访问且不溢出，无浏览器异常');
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser.close();
}
