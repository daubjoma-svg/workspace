// 启动期存量数据迁移（幂等，可反复执行）：
//   1. ai_providers.api_key 明文 → api_key_enc 密文，明文列清空
//   2. settings['gitlab.token'] 明文 → settings['gitlab.token_enc'] 密文
//   3. users.password 明文 → bcrypt 哈希
//   4. ai_providers.capability 按 type/base_url 回填
//   5. AI 节点提示词与存量澄清区块升级为「已澄清结论·视为既定事实」版本
// 前置：SOP_MASTER_KEY 已配置（index.js 在调用本模块前已 fail-fast 校验）。

'use strict';

const { db, getSetting, setSetting } = require('./db');
const secret = require('./crypto/secret');
const password = require('./crypto/password');
const logger = require('./logger');
const { inferCapability, isValidCapability } = require('./llm/capabilities');
const { TOKEN_KEY, TOKEN_ENC_KEY } = require('./repo/gitlab-api');
const { CLARIFY_FACT_NOTE } = require('./engine');

async function migrateProviderKeys() {
  const rows = await db.many('SELECT id,type,base_url,api_key,api_key_enc FROM ai_providers', []);
  let n = 0;
  for (const r of rows) {
    if (secret.isEncrypted(r.api_key_enc)) {
      if (r.api_key) await db.execute('UPDATE ai_providers SET api_key=NULL WHERE id=?', [r.id]); // 清残留明文
      continue;
    }
    if (!r.api_key) continue;
    await db.execute('UPDATE ai_providers SET api_key_enc=?, api_key=NULL WHERE id=?', [secret.encrypt(r.api_key), r.id]);
    n += 1;
  }
  return n;
}

async function migrateGitlabToken() {
  if (secret.isEncrypted(await getSetting(TOKEN_ENC_KEY, ''))) {
    if (await getSetting(TOKEN_KEY, '')) await setSetting(TOKEN_KEY, '');
    return 0;
  }
  const plain = (await getSetting(TOKEN_KEY, '')) || '';
  if (!plain) return 0;
  await setSetting(TOKEN_ENC_KEY, secret.encrypt(plain));
  await setSetting(TOKEN_KEY, '');
  return 1;
}

// 口令迁移：bcrypt 哈希（不可逆，保留）与可逆密文（新格式）都跳过；
// 只剩历史明文需要处理，转可逆加密（与新写入口径一致）
async function migrateUserPasswords() {
  const rows = await db.many('SELECT id,username,password FROM users', []);
  let n = 0;
  for (const u of rows) {
    if (password.isHashed(u.password) || secret.isEncrypted(u.password)) continue;
    await db.execute('UPDATE users SET password=? WHERE id=?', [password.store(u.password), u.id]);
    n += 1;
  }
  return n;
}

async function backfillCapability() {
  const rows = await db.many('SELECT id,type,base_url,capability FROM ai_providers', []);
  let n = 0;
  for (const r of rows) {
    if (isValidCapability(r.capability)) continue;
    await db.execute('UPDATE ai_providers SET capability=? WHERE id=?', [inferCapability(r.type, r.base_url), r.id]);
    n += 1;
  }
  return n;
}

/**
 * 主密钥自检：库里若已有 v1: 前缀密文，试解一条。
 * 解不开说明 SOP_MASTER_KEY 与加密时用的不是同一把 —— 必须与"未配置"区分开，
 * 否则运维侧"没配 key"和"key 配错了"表现完全一致（BLOCKER-2 同款盲区）。
 * @returns 'ok' | 'mismatch' | 'no_data'
 */
async function verifyMasterKey() {
  const samples = [];
  const row = await db.one(
    "SELECT api_key_enc FROM ai_providers WHERE api_key_enc LIKE 'v1:%' LIMIT 1",
    []
  );
  if (row) samples.push(row.api_key_enc);
  const token = await getSetting(TOKEN_ENC_KEY, '');
  if (secret.isEncrypted(token)) samples.push(token);
  if (!samples.length) return 'no_data';

  for (const payload of samples) {
    try {
      secret.decrypt(payload);
      return 'ok';
    } catch { /* 试下一条 */ }
  }
  logger.error('master_key_mismatch', {
    hint: 'SOP_MASTER_KEY 与存量密文不匹配，已加密的 api_key / gitlab token 无法解密',
    samples: samples.length,
  });
  return 'mismatch';
}

// 存量库的 AI 节点提示词升级为「按需求规模裁剪 + 角色可读」版本。
// 只在识别到旧版标记时替换，管理员自定义过的提示词不受影响（幂等，可反复执行）。
const LEGACY_PROMPT_MARKERS = {
  // 上一版评估提示词（无 confidence、会重复追问）。新版已改为「已澄清结论视为既定事实 + 自评置信度」，
  // 标记必须只出现在旧版里，否则每次启动都会重写提示词、覆盖管理员的定制。
  EVALUATE: '若需求描述不清、目标或边界缺失',
  PRD_GEN: '全文控制在 800-1500 字',
  DEV_PROMPT: '产出可直接喂给 Cursor/Claude Code 的实现上下文',
  TEST_CASE: '需要重点测试的地方与注意点',
};

async function refreshSopNodePrompts() {
  const { NODES } = require('./sop-template');
  const tpl = await db.one('SELECT id FROM sop_templates WHERE is_default=1 ORDER BY id LIMIT 1', []);
  if (!tpl) return 0;
  let n = 0;
  for (const [i, node] of NODES.entries()) {
    const [, name, , action, prompt] = node;
    if (!action) continue; // 人工节点没有提示词
    const marker = LEGACY_PROMPT_MARKERS[action];
    if (!marker) continue;
    const row = await db.one(
      'SELECT id,ai_action,ai_prompt FROM sop_nodes WHERE template_id=? AND seq=?',
      [tpl.id, i + 1]
    );
    if (!row || row.ai_action !== action) continue;
    if (!String(row.ai_prompt || '').includes(marker)) continue;
    await db.execute('UPDATE sop_nodes SET name=?, ai_prompt=? WHERE id=?', [name, prompt, row.id]);
    n += 1;
  }
  return n;
}

async function runMigrations() {
  const stats = await db.transaction(async () => ({
    provider_keys: await migrateProviderKeys(),
    gitlab_token: await migrateGitlabToken(),
    user_passwords: await migrateUserPasswords(),
    capability: await backfillCapability(),
    sop_prompts: await refreshSopNodePrompts(),
    clarify_blocks: await refreshClarifyBlocks(),
  }));
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  if (total > 0) logger.info('migration_done', stats);
  return stats;
}

// 存量需求描述里的澄清区块升级：旧标记「【澄清补充·第 N 轮】」只陈述"这是补充"，
// AI 重跑时仍会把里面的问答当成待澄清的开放问题，换个说法重问一遍（156/157/158 都出现过）。
// 换成「已澄清结论·视为既定事实」并补一句"必须采信"，与 engine.js 新写入的格式对齐。
// 幂等：升级后描述里不再含旧标记，反复执行不会重复改写。
const LEGACY_CLARIFY_BLOCK = /【澄清补充·第 (\d+) 轮】/g;

async function refreshClarifyBlocks() {
  const rows = await db.many(
    "SELECT id, description FROM requirements WHERE description LIKE '%【澄清补充·第 %'",
    []
  );
  let n = 0;
  for (const row of rows) {
    const desc = String(row.description || '');
    const next = desc.replace(
      LEGACY_CLARIFY_BLOCK,
      (_m, round) => `【已澄清结论·视为既定事实（第 ${round} 轮）】\n${CLARIFY_FACT_NOTE}`
    );
    if (next === desc) continue;
    await db.execute('UPDATE requirements SET description=? WHERE id=?', [next, row.id]);
    n += 1;
  }
  return n;
}

module.exports = {
  runMigrations, verifyMasterKey,
  migrateProviderKeys, migrateGitlabToken, migrateUserPasswords, backfillCapability,
  refreshSopNodePrompts, refreshClarifyBlocks,
};
