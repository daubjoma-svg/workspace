/* 注册表单 + 飞书配置页 SSR 验证（零浏览器环境）
 * 运行：cd web && node scripts/register-feishu-ssr-test.mjs
 * 覆盖：
 *   1) Login 登录/注册切换：seg-tabs 渲染，默认登录态字段齐全
 *   2) RegisterForm：姓名/登录名/密码/飞书字段齐全 + 选填提示文案
 *   3) Feishu 配置页：应用配置（App ID/App Secret/保存）、测试发送、使用说明 5 步
 * 注意：Login / Feishu 均 useApp() 取 toast，AppCtx 必须与组件同 bundle（同一模块实例）。
 */
import { build } from 'esbuild';
import { unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SRC = path.join(__dirname, '../src');

async function bundleCjs(entry, out) {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/*', 'react/jsx-runtime'],
    outfile: out,
    logLevel: 'silent',
  });
}

let failed = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.error('  ✗ ' + msg); }
};

const { default: ReactDOMServer } = await import('react-dom/server');
const { default: React } = await import('react');
const render = (el) => ReactDOMServer.renderToStaticMarkup(el);

const CTX_VALUE = { user: null, theme: { primary: '', mode: 'light' }, toast: () => {}, logout: () => {}, refreshTheme: () => {} };
const wrap = (Ctx, el) => render(React.createElement(Ctx.Provider, { value: CTX_VALUE }, el));

// ============ 1. Login 登录/注册切换 ============
const loginEntry = path.join(__dirname, '.rf-login-entry.ts');
const loginOut = path.join(__dirname, '.rf-login-tmp.cjs');
writeFileSync(loginEntry, [
  "import { AppCtx } from '../src/App';",
  "import Login, { RegisterForm } from '../src/pages/Login';",
  'export { AppCtx, Login, RegisterForm };',
  '',
].join('\n'));
await bundleCjs(loginEntry, loginOut);
const { AppCtx, Login, RegisterForm } = require(loginOut);

console.log('案例1：Login 默认登录态（切换控件 + 登录表单）');
const loginHtml = wrap(AppCtx, React.createElement(Login, { onLogin: () => {} }));
assert(loginHtml.includes('seg-tabs'), '登录/注册切换控件渲染');
assert(loginHtml.includes('登 录') && loginHtml.includes('注 册'), '切换项含「登 录」「注 册」');
assert(loginHtml.includes('欢迎回来'), '登录态标题渲染');
assert(loginHtml.includes('用户名') && loginHtml.includes('密码'), '登录字段齐全');
assert(loginHtml.includes('演示账号'), '演示账号提示保留');
assert(!loginHtml.includes('飞书 user_id 或邮箱'), '默认登录态不渲染注册字段');

console.log('案例2：RegisterForm 注册表单（字段齐全 + 角色自选 + 选填提示）');
const regHtml = wrap(AppCtx, React.createElement(RegisterForm, { onLogin: () => {} }));
assert(regHtml.includes('姓名') && regHtml.includes('登录名') && regHtml.includes('密码'), '注册字段：姓名/登录名/密码');
assert(regHtml.includes('角色'), '角色字段渲染');
assert(regHtml.includes('>CSM<') && regHtml.includes('产品') && regHtml.includes('研发') && regHtml.includes('测试'), '四角色选项齐全：CSM/产品/研发/测试');
assert(!regHtml.includes('管理员'), '不含管理员选项（ADMIN 仅后台分配）');
assert((regHtml.match(/aria-checked="true"/g) || []).length === 1, '角色默认选中一项（CSM）');
assert(regHtml.includes('飞书 user_id 或邮箱'), '飞书字段渲染');
assert(regHtml.includes('选填。填写后，需求流转到你负责的节点时将通过飞书应用发消息提醒；留空则只收站内通知'), '选填提示文案完整');
assert(regHtml.includes('注 册'), '注册提交按钮渲染');
assert((regHtml.match(/type="password"/g) || []).length === 1, '密码为 password 输入类型');

console.log('案例3：注册提交载荷（role 携带 + feishu_key 选填省略 / 填写时携带）');
// SSR 不触发事件，直接校验 Login.tsx 源码中 submit 载荷构造（契约字段锁定）
const loginSrc = await import('node:fs').then((fs) => fs.readFileSync(path.join(SRC, 'pages/Login.tsx'), 'utf8'));
assert(loginSrc.includes("'/api/auth/register'"), '注册接口路径为 /api/auth/register');
assert(loginSrc.includes('username: username.trim()') && loginSrc.includes('password') && loginSrc.includes('name: name.trim()'), '提交载荷含 username/password/name');
assert(loginSrc.includes('role,'), '提交载荷携带 role');
assert(loginSrc.includes("useState<'CSM' | 'PO' | 'RD' | 'QA'>('CSM')"), '角色默认值 CSM');
assert(loginSrc.includes('...(feishuKey.trim() ? { feishu_key: feishuKey.trim() } : {})'), 'feishu_key 选填：留空省略、填写时携带');
assert(!loginSrc.includes("{ value: 'ADMIN' }"), '角色选项不含 ADMIN');
unlinkSync(loginEntry);
unlinkSync(loginOut);

// ============ 4. Feishu 配置页 ============
const feishuEntry = path.join(__dirname, '.rf-feishu-entry.ts');
const feishuOut = path.join(__dirname, '.rf-feishu-tmp.cjs');
writeFileSync(feishuEntry, [
  "import { AppCtx } from '../src/App';",
  "import Feishu from '../src/pages/admin/Feishu';",
  'export { AppCtx, Feishu };',
  '',
].join('\n'));
await bundleCjs(feishuEntry, feishuOut);
// 注意：AppCtx 必须与 Feishu 出自同一 bundle（各自 bundle 的 context 是不同实例）
const { AppCtx: FeishuCtx, Feishu } = require(feishuOut);

console.log('案例4：Feishu 配置页（应用配置 / 测试发送 / 使用说明）');
const feishuHtml = wrap(FeishuCtx, React.createElement(Feishu));
assert(feishuHtml.includes('飞书通知'), '页面标题渲染');
assert(feishuHtml.includes('应用配置'), '应用配置区块渲染');
assert(feishuHtml.includes('App ID') && feishuHtml.includes('App Secret'), 'app_id / app_secret 字段齐全');
assert(feishuHtml.includes('保存配置'), '保存按钮渲染');
assert(feishuHtml.includes('未配置') || feishuHtml.includes('已配置'), '配置状态徽标渲染');
assert(feishuHtml.includes('测试发送'), '测试发送区块渲染');
assert(feishuHtml.includes('接收人（你的飞书 user_id 或邮箱）'), '测试接收人字段渲染');
assert(feishuHtml.includes('发送测试消息'), '测试按钮渲染');
assert(feishuHtml.includes('使用说明'), '使用说明区块渲染');
const steps = ['创建企业自建应用', 'im:message 发送权限', '填到此处', '飞书 user_id 或邮箱', '自动推送'];
steps.forEach((s) => assert(feishuHtml.includes(s), `使用说明步骤含「${s}」`));
assert((feishuHtml.match(/<li/g) || []).length === 5, '使用说明共 5 步编号列表');
unlinkSync(feishuEntry);
unlinkSync(feishuOut);

if (failed) { console.error(`\n失败 ${failed} 项`); process.exit(1); }
console.log('\n全部通过 ✓');
