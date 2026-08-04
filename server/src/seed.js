// 种子数据：默认管理员 + 各角色示例账号 + 默认 SOP 模板
const { db, getSetting, setSetting } = require('./db');
const password = require('./crypto/password');

function seed() {
  const hasUser = db.prepare('SELECT COUNT(*) n FROM users').get().n > 0;
  if (!hasUser) {
    // OPS-B4：口令必须写 bcrypt 哈希。写明文会让全新部署的实例
    // 在 bcrypt.compare(明文, 明文) 上恒 false，admin 都进不去，系统开局锁死。
    const ins = db.prepare('INSERT INTO users(username,password,name,role) VALUES(?,?,?,?)');
    const seedUsers = [
      ['admin', 'admin123', '系统管理员', 'ADMIN'],
      ['csm01', '123456', '陈晨(CSM)', 'CSM'],
      ['po01', '123456', '王芳(产品)', 'PO'],
      ['rd01', '123456', '李工(研发)', 'RD'],
      ['qa01', '123456', '赵测(测试)', 'QA'],
    ];
    seedUsers.forEach(([username, plain, name, role]) => ins.run(username, password.hash(plain), name, role));
    console.log('[seed] 用户已创建(口令已 bcrypt 哈希),请首次登录后立即修改默认口令');
  }

  const hasTpl = db.prepare('SELECT COUNT(*) n FROM sop_templates').get().n > 0;
  if (!hasTpl) {
    const r = db.prepare('INSERT INTO sop_templates(name,is_default,is_system) VALUES(?,1,1)').run('标准需求交付流程');
    const tplId = r.lastInsertRowid;
    const ins = db.prepare('INSERT INTO sop_nodes(template_id,seq,node_type,name,role,ai_action,ai_prompt) VALUES(?,?,?,?,?,?,?)');
    // 4 个人工节点 + 3 个 AI 节点:测试上线后不再挂 AI
    const nodes = [
      ['HUMAN', 'CSM 提交需求', 'CSM', null, null],
      ['AI', 'AI·需求评审', null, 'EVALUATE',
        '你是资深需求评审专家。请结合客户原始诉求与其关联的业务模块,评审该需求的【合理性与可行性】:\n' +
        '1) 评估改动量(影响的功能点/接口/数据范围)并定级 L1-L4;\n' +
        '2) 估算工作量(最小-最大人日);\n' +
        '3) 若需求描述不清、目标或边界缺失,请向 CSM 提出具体的澄清问题;\n' +
        '4) 最后输出一段给产品的需求总结(背景、目标、范围、验收口径)。'],
      ['HUMAN', '产品评审需求', 'PO', null, null],
      ['AI', 'AI·研发提示词', null, 'DEV_PROMPT',
        '请汇总产品评审后的 PRD 文档与原始需求内容,结合关联模块的代码结构,生成给研发的【开发提示词】:\n' +
        '1) 明确建议改动/新增的文件与模块位置;\n' +
        '2) 列出可复用的现有类/接口与需要新增的接口签名;\n' +
        '3) 标注关键技术点、兼容与性能注意事项;\n' +
        '4) 产出可直接喂给 Cursor/Claude Code 的实现上下文。'],
      ['HUMAN', '研发开发', 'RD', null, null],
      ['AI', 'AI·测试标注', null, 'TEST_CASE',
        '研发已完成开发。请基于需求与改动内容,为测试标注【需要重点测试的地方与注意点】:\n' +
        '1) 主流程的功能验证点;\n' +
        '2) 边界与异常输入场景;\n' +
        '3) 受影响模块的回归测试范围;\n' +
        '4) 易出错的兼容/数据迁移风险点,并给出对应的测试用例建议。'],
      ['HUMAN', '测试验证上线', 'QA', null, null],
    ];
    nodes.forEach((n, i) => ins.run(tplId, i + 1, n[0], n[1], n[2], n[3], n[4]));
    console.log('[seed] 标准需求交付流程(4 人工 + 3 AI)已创建');
  }

  if (!db.prepare('SELECT COUNT(*) n FROM ai_providers').get().n) {
    db.prepare("INSERT INTO ai_providers(name,type,enabled,capability) VALUES('内置 Mock(离线演示)','mock',1,'json_schema')").run();
  }
  // OPS-B5：seed() 每次启动都跑，无条件 setSetting 会把管理员改过的主题在重启时打回默认。
  // 只在 key 不存在时写入。默认值对齐 SPEC §8 锁定的 accent（Cyanotype Blue）。
  setDefaultSetting('theme.primary', '#0E62A8');
  setDefaultSetting('theme.mode', 'light');
}

function setDefaultSetting(key, value) {
  if (getSetting(key, null) == null) setSetting(key, value);
}

if (require.main === module) { seed(); console.log('[seed] done'); }
module.exports = seed;
