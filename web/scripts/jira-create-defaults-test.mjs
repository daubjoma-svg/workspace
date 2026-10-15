/** 创建 Jira 弹窗回归：拦截全部 API，提交只检查请求体，不创建真实单据。 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const url = process.env.SOP_TEST_URL || 'http://127.0.0.1:4000';
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
const screenshots = await mkdtemp(path.join(tmpdir(), 'sop-jira-create-'));
const platformLine = '用户中心（组织架构、权限、消息、登录等）';
const jiraUrl = 'https://jira.fenbeijinfu.com/browse/PINGTAI-12044';
const createdJiraUrl = 'https://jira.fenbeijinfu.com/browse/PINGTAI-1';
let submitted;
let assigned;
try {
  // 同时覆盖已有链接、首次创建和填写过草稿后创建，避免只测已有链接而漏掉初始编辑状态。
  for (const scenario of ['existing', 'empty', 'draft']) {
    let currentJiraUrl = scenario === 'existing' ? jiraUrl : null;
    let detailLoads = 0;
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('sop_token', 'mock-test-token'));
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const query = new URL(route.request().url()).searchParams;
      let body = [];
      if (path === '/api/me') body = { id: 36, name: '胡产品', role: 'PO' };
      else if (path === '/api/settings/theme') body = { primary: '', mode: 'light' };
      else if (path === '/api/notifications') body = [{ id: 1, title: '测试需求', content: '', created_at: '', read_flag: 1, requirement_id: 7 }];
      else if (path === '/api/requirements/7') {
        detailLoads++;
        body = { id: 7, req_no: 'REQ-7', title: '测试需求', status: 'PENDING', current_seq: 1, nodes: [{ id: 1, seq: 1, name: '产品确认', node_type: 'HUMAN', role: 'PO' }], po_id: 36, jira_url: currentJiraUrl };
      }
      else if (path === '/api/requirements/7/assign' && route.request().method() === 'POST') {
        assigned = route.request().postDataJSON();
        body = assigned;
      }
      else if (path === '/api/requirements/7/artifacts') body = [{ id: 1, kind: 'PRD', content: '测试 PRD' }];
      else if (path === '/api/requirements/7/jira-create-form') {
        const other = query.get('project_key') === 'OTHER';
        const field = (id, name, value, type = 'option', custom = 'select') => ({ id, name, type, items: type === 'array' ? 'option' : '', custom: `jira:${custom}`, allowed_values: [{ id: '1', value }, { id: '2', value: '另一个值' }], default_value: other ? '' : (type === 'array' ? [value] : value) });
        const common = [field('customfield_11404', '平台子业务线', platformLine), field('customfield_11101', '涉及的研发端', '后端', 'array', 'multicheckboxes'), field('customfield_11904', '归属BU', '平台')];
        const required = [
          { id: 'customfield_11811', name: '客户名称：', type: 'string', items: '', custom: 'jira:issue-picker-cf', allowed_values: [] },
          { id: 'customfield_12501', name: '簇群分类（多选）', type: 'array', items: 'option', custom: 'jira:multicheckboxes', allowed_values: [{ id: '1', value: '其他' }] },
        ];
        body = { project_key: other ? 'OTHER' : 'PINGTAI', issue_type: '产品需求', issue_types: ['产品需求', '任务'], default_fields: common, required_fields: other ? [common[0], ...required] : required };
      } else if (path === '/api/jira/issue-search') {
        body = [{ key: 'KHNAME-851', summary: '分贝通科技有限公司' }];
      } else if (path === '/api/users/me/jira-profile') body = { base_url: 'https://jira.example.com', username: 'product', token_configured: true, project_key: 'PINGTAI', issue_type: '产品需求', sync: { project_candidates: [{ key: 'PINGTAI', name: '平台系统需求池' }, { key: 'OTHER', name: '其他项目' }] } };
      else if (path === '/api/requirements/7/jira' && route.request().method() === 'POST') {
        submitted = route.request().postDataJSON();
        currentJiraUrl = createdJiraUrl;
        body = { url: createdJiraUrl };
      }
      await route.fulfill({ json: body });
    });
    await page.goto(url);
    await page.getByRole('button', { name: '通知中心' }).click();
    await page.getByRole('button', { name: '测试需求' }).click();
    await page.getByRole('button', { name: 'PRD 文档' }).click();
    const assignment = page.locator('#req-assign-anchor');
    const link = assignment.locator('a.jira-assignment-link');
    if (scenario === 'existing') {
      assert.equal(await link.getAttribute('href'), jiraUrl, '回显的 Jira 地址应为可跳转链接');
      assert.equal(await link.getAttribute('target'), '_blank');
      await assignment.screenshot({ path: path.join(screenshots, 'assignment-desktop.png') });
      await page.setViewportSize({ width: 375, height: 812 });
      await assignment.scrollIntoViewIfNeeded();
      const assignmentRect = await assignment.boundingBox();
      await assignment.screenshot({ path: path.join(screenshots, 'assignment-mobile.png') });
      const linkRect = await link.boundingBox();
      const editRect = await assignment.getByRole('button', { name: '修改' }).boundingBox();
      assert.ok(assignmentRect && linkRect && editRect && linkRect.x + linkRect.width <= editRect.x && editRect.x + editRect.width <= assignmentRect.x + assignmentRect.width, '窄屏链接与修改按钮不应重叠或超出指派区');
      await page.setViewportSize({ width: 1280, height: 900 });
      await assignment.getByRole('button', { name: '修改' }).click();
      await assignment.getByLabel('Jira 链接或单号 *').fill('PINGTAI-999');
      await assignment.getByRole('button', { name: '取消' }).click();
      assert.equal(await link.getAttribute('href'), jiraUrl, '取消修改后恢复原有链接');
      await assignment.getByRole('button', { name: '保存指派' }).click();
      assert.equal(assigned.jira_url, jiraUrl, '未编辑链接时保存指派应保留 Jira 地址');
    } else {
      const input = assignment.getByLabel('Jira 链接或单号 *');
      assert.equal(await input.inputValue(), '', '没有 Jira 时应显示空输入框');
    }
    if (scenario !== 'empty') {
      if (scenario === 'existing') await assignment.getByRole('button', { name: '修改' }).click();
      const input = assignment.getByLabel('Jira 链接或单号 *');
      await input.fill('PINGTAI-999');
      const beforePoll = detailLoads;
      await page.waitForResponse((response) => new URL(response.url()).pathname === '/api/requirements/7' && detailLoads > beforePoll);
      assert.equal(await input.inputValue(), 'PINGTAI-999', '普通详情轮询不应覆盖手动输入的草稿');
    }
    await assignment.getByRole('button', { name: '一键创建 Jira' }).click();
    const modal = page.locator('.jira-create-modal');
    for (const [name, value] of [['平台子业务线', platformLine], ['涉及的研发端', '后端'], ['归属BU', '平台']]) {
      const row = modal.locator('.jira-field').filter({ has: page.locator('label', { hasText: new RegExp(`^${name}$`) }) });
      await row.waitFor();
      assert.match(await row.locator('.ss-trigger').innerText(), new RegExp(value), `${name} 应预选产品默认值`);
    }
    const row = (name) => modal.locator('.jira-field').filter({ has: page.locator('label', { hasText: new RegExp(`^${name}(?: \\*)?$`) }) });
    await modal.screenshot({ path: path.join(screenshots, 'desktop.png') });
    assert.equal(await row('客户名称：').count(), 1, '其他必填字段仍可见');
    assert.equal(await row('簇群分类（多选）').count(), 1, '默认簇群分类仍可见');
    await row('归属BU').locator('.ss-trigger').click();
    await page.getByRole('option', { name: '另一个值' }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    for (const name of ['平台子业务线', '涉及的研发端', '归属BU']) {
      const field = row(name);
      await field.scrollIntoViewIfNeeded();
      const rect = await field.boundingBox();
      assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= 375, `${name} 不应横向溢出`);
    }
    await modal.screenshot({ path: path.join(screenshots, 'mobile.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await modal.locator('.form-row').filter({ has: page.locator('label', { hasText: /^项目 \*$/ }) }).locator('.ss-trigger').click();
    await page.getByRole('option', { name: /其他项目/ }).click();
    await row('平台子业务线').locator('.ss-trigger').waitFor();
    assert.match(await row('归属BU').locator('.ss-trigger').innerText(), /搜索并选择/, '切项目后不沿用旧项目默认值');
    assert.equal(await modal.locator('.modal-f .btn-primary').isDisabled(), true, '新项目必填字段为空时不可提交');
    await modal.locator('.form-row').filter({ has: page.locator('label', { hasText: /^项目 \*$/ }) }).locator('.ss-trigger').click();
    await page.getByRole('option', { name: /平台系统需求池/ }).click();
    await row('平台子业务线').locator('.ss-trigger').waitFor();
    await modal.locator('.modal-f .btn-primary').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.jira-create-modal .modal-f .btn-primary')?.hasAttribute('disabled'));
    await modal.locator('.modal-f .btn-primary').click();
    assert.equal(submitted.fields.customfield_11404, platformLine);
    assert.equal(submitted.fields.customfield_11101, '后端');
    assert.equal(submitted.fields.customfield_11904, '平台');
    await page.waitForFunction((url) => document.querySelector('#req-assign-anchor a.jira-assignment-link')?.getAttribute('href') === url, createdJiraUrl, { timeout: 10000 });
    assert.equal(await assignment.locator('input#assign-jira-url').count(), 0, '创建成功后退出编辑状态');
    assert.equal(await page.locator('a.jira-link').getAttribute('href'), createdJiraUrl, '需求信息区同步展示创建后的链接');
    await assignment.getByRole('button', { name: '保存指派' }).click();
    assert.equal(assigned.jira_url, createdJiraUrl, '创建后保存指派不得清空链接或回写旧草稿');
    assert.deepEqual(errors, []);
    console.log(`PASS: Jira ${scenario} 场景回显与保存`);
    await page.close();
  }
  console.log('PASS: Jira 链接跳转/修改/生成回显、默认值、切项目、必填校验与控件窄屏布局');
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser.close();
}
