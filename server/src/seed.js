// 种子数据：默认管理员 + 各角色示例账号 + 默认 SOP 模板
const db = require('./db');
const { execute, getSetting, many, one, setSetting } = db;
const password = require('./crypto/password');
const { NODES } = require('./sop-template');

async function seed() {
  const hasUser = (await one('SELECT COUNT(*) n FROM users')).n > 0;
  if (!hasUser) {
    // 口令可逆加密入库（AES-256-GCM）：写明文会让 verify 解密失败，admin 开局锁死
    const seedUsers = [
      ['admin', 'admin123', '系统管理员', 'ADMIN'],
      ['csm01', '123456', '陈晨(CSM)', 'CSM'],
      ['po01', '123456', '王芳(产品)', 'PO'],
      ['rd01', '123456', '李工(研发)', 'RD'],
      ['fe01', '123456', '孙前(前端)', 'FE'],
      ['qa01', '123456', '赵测(测试)', 'QA'],
    ];
    for (const [username, plain, name, role] of seedUsers) {
      await execute('INSERT INTO users(username,password,name,role) VALUES(?,?,?,?)', [username, password.store(plain), name, role]);
    }
    console.log('[seed] 用户已创建(口令已可逆加密存储),请首次登录后立即修改默认口令');
  }

  const hasTpl = (await one('SELECT COUNT(*) n FROM sop_templates')).n > 0;
  if (!hasTpl) {
    const r = await db.execute(
      'INSERT INTO sop_templates(name,is_default,is_system) VALUES(?,1,1)',
      ['标准需求交付流程']
    );
    const tplId = r.lastInsertRowid;
    for (const [i, n] of NODES.entries()) {
      await execute('INSERT INTO sop_nodes(template_id,seq,node_type,name,role,ai_action,ai_prompt) VALUES(?,?,?,?,?,?,?)', [tplId, i + 1, n[0], n[1], n[2], n[3], n[4]]);
    }
    console.log('[seed] 标准需求交付流程(4 人工 + 3 AI)已创建');
  }

  if (!(await one('SELECT COUNT(*) n FROM ai_providers')).n) {
    await execute(
      "INSERT INTO ai_providers(name,type,enabled,capability) VALUES('内置 Mock(离线演示)','mock',1,'json_schema')",
      []
    );
  }
  // OPS-B5：seed() 每次启动都跑，无条件 setSetting 会把管理员改过的主题在重启时打回默认。
  // 只在 key 不存在时写入。默认值对齐 SPEC §8 锁定的 accent（Cyanotype Blue）。
  await setDefaultSetting('theme.primary', '#0E62A8');
  await setDefaultSetting('theme.mode', 'light');
}

async function setDefaultSetting(key, value) {
  if (await getSetting(key, null) == null) await setSetting(key, value);
}

if (require.main === module) { seed().catch(() => {}); console.log('[seed] done'); }
module.exports = seed;
