// 代码上下文提取（供 AI）：目录树 + 关键文件挑选 + 预算控制。
// F2 在此落地：评分前用 isSensitiveFile 剔除，读取后用 redactSecrets 脱敏。
// P0 合规：目录树用 [D]/[F] 纯文本前缀，不使用 emoji（这段文本会直接进 LLM prompt）。

'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const logger = require('../logger');
const { walk, REPOS_DIR } = require('./archive');
const { isSensitiveFile, redactSecretsDetailed } = require('./sensitive');
const { moduleRoot, safeJoin } = require('./paths');

const CODE_EXT = ['.java', '.js', '.ts', '.tsx', '.jsx', '.go', '.py', '.sql', '.kt', '.vue', '.php', '.rb', '.xml', '.yml', '.yaml', '.properties'];
// 增强版优先级正则：覆盖更多业务关键层（controller/service/dao/entity/enum/config/router/middleware/converter/validator/strategy/factory/adapter...）
const PRIORITY_RE = /(controller|service|serviceimpl|entity|model|mapper|dao|api|handler|resource|route|config|application|bootstrap|main|index|enum|constant|constants|dto|vo|bo|po|converter|validator|strategy|factory|adapter|proxy|delegate|facade|interceptor|filter|middleware|aspect|aop|scheduler|listener|observer|repository|manager|helper|util|builder|provider|resolver|processor|executor|dispatcher|resolver|mapper|mapper\.xml|repository|domain)/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', 'vendor', '.idea']);

/** 解析模块快照根目录（含 sub_path），路径全部过安全校验。不存在返回 null */
function resolveRoot(mod) {
  try {
    // v0.7：code_modules 已 drop module_key；快照目录用 gitlab_project_id（archive.syncModule 同源规则）
    const dirKey = String(mod.gitlab_project_id).replace(/[^A-Za-z0-9._-]/g, '_');
    const base = moduleRoot(REPOS_DIR, dirKey);
    const root = safeJoin(base, mod.sub_path || '', 'sub_path');
    return fs.existsSync(root) ? root : null;
  } catch (e) {
    logger.warn('code_context_path_rejected', { module: mod.gitlab_project_id, reason: e.code || e.message });
    return null;
  }
}

/** 生成目录树（限制深度/条目控制 token）。目录 [D] / 文件 [F] */
function dirTree(mod, maxDepth = 3, maxEntries = 120) {
  const root = resolveRoot(mod);
  if (!root) return '(代码尚未拉取)';
  const lines = [];
  let count = 0;
  (function rec(dir, depth, prefix) {
    if (depth > maxDepth || count > maxEntries) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries = entries.filter((e) => !SKIP_DIRS.has(e.name) && !e.isSymbolicLink());
    for (const e of entries.slice(0, 40)) {
      if (count++ > maxEntries) return;
      const rel = path.relative(root, path.join(dir, e.name));
      if (!e.isDirectory() && isSensitiveFile(rel)) continue; // 敏感文件连文件名都不暴露
      lines.push(`${prefix}${e.isDirectory() ? '[D] ' : '[F] '}${e.name}`);
      if (e.isDirectory()) rec(path.join(dir, e.name), depth + 1, `${prefix}  `);
    }
  })(root, 1, '');
  return lines.join('\n') || '(空目录)';
}

/**
 * 挑关键代码文件并读取内容（截断），供评估/DevPrompt 注入。
 * 返回 { path, content }[]，形状与改造前一致（F9 打回流程零影响）。
 */
function keyFilesContent(mod, { maxFiles = 8, maxCharsPerFile = 2500, maxTotal = 16000, focusDirs = null } = {}) {
  const root = resolveRoot(mod);
  if (!root) return [];

  let skippedSensitive = 0;
  const candidates = [];
  for (const f of walk(root)) {
    if (!CODE_EXT.includes(path.extname(f).toLowerCase())) continue;
    const rel = path.relative(root, f);
    // focusDirs 指定时只收该目录下的文件（让 AI 能"查完整目录"，而不是全仓库随机挑几个）
    if (focusDirs && focusDirs.length) {
      const hit = focusDirs.some((d) => d && (rel === d || rel.startsWith(d.replace(/\/+$/, '') + path.sep)));
      if (!hit) continue;
    }
    if (isSensitiveFile(rel)) { skippedSensitive += 1; continue; }   // F2-L1：评分前剔除
    let score = 0;
    if (PRIORITY_RE.test(path.basename(f))) score += 10;
    score -= rel.split(path.sep).length; // 浅层优先
    candidates.push({ f, rel, score });
  }
  candidates.sort((a, b) => b.score - a.score);

  // focusDirs 指定 = "读该目录全部代码"：不按 maxFiles 挑，目录下所有文件都读（只受 maxTotal 总预算约束）
  const isFocus = focusDirs && focusDirs.length;
  const limit = isFocus ? candidates.length : maxFiles;
  const picked = [];
  let total = 0;
  let redactions = 0;
  for (const { f, rel } of candidates.slice(0, limit)) {
    try {
      let content = fs.readFileSync(f, 'utf8');
      const red = redactSecretsDetailed(content);                    // F2-L2：内容嗅探脱敏
      content = red.content;
      redactions += red.redactions;
      if (content.length > maxCharsPerFile) content = `${content.slice(0, maxCharsPerFile)}\n// ...(truncated)`;
      if (total + content.length > maxTotal) break;
      total += content.length;
      picked.push({ path: rel, content });
    } catch { /* 单文件读失败不影响整体上下文 */ }
  }
  if (skippedSensitive || redactions) {
    logger.info('code_context_filtered', { module: mod.module_key, skipped_sensitive: skippedSensitive, redactions });
  }
  return picked;
}

/** 组装：某需求关联的全部业务模块 → 各自挂载的代码模块上下文（v0.7）
 * 接受业务模块 ID 列表，自动 JOIN 出挂载的代码仓库；
 * 返回的 modules 每条对应一个 code_module，business_module_name 标注所属业务。
 */
async function buildCodeContext(businessModuleIds, opts = {}) {
  if (!businessModuleIds || !businessModuleIds.length) return null;
  // v0.7：business_module → business_module_codes 多对多 → code_modules
  const rows = await db.many(`
    SELECT bm.name AS business_name, bm.type AS business_module_type, bmc.path_prefix, cm.*
    FROM business_module_codes bmc
    JOIN business_modules bm ON bm.id = bmc.business_module_id
    JOIN code_modules cm ON cm.id = bmc.code_module_id
    WHERE bmc.business_module_id IN (${businessModuleIds.map(() => '?').join(',')})`, [...businessModuleIds]);
  if (!rows.length) return null;
  const synced = rows.filter((r) => r.sync_status === 'OK');
  if (!synced.length) {
    return {
      note: '关联的业务模块尚未同步代码(无可用快照)',
      modules: rows.map((r) => ({ business_module: r.business_name, module_type: r.business_module_type, repo: r.gitlab_project_path || r.gitlab_project_id, status: r.sync_status })),
    };
  }
  return {
    modules: synced.map((r) => {
      const mod = { ...r, sub_path: r.path_prefix || r.sub_path };
      return {
        business_module: r.business_name,
        module_type: r.business_module_type,
        repo_id: r.gitlab_project_id,
        repo_path: r.gitlab_project_path,
        branch: r.branch,
        commit: (r.commit_sha || '').slice(0, 8),
        // AC-09 代码依据需要"文件数"：取同步时统计的快照文件总数，随 code_basis 一起落进 artifact.meta
        file_count: r.file_count == null ? null : Number(r.file_count),
        tree: dirTree(mod),
        key_files: opts.withFiles ? keyFilesContent(mod, opts) : undefined,      };
    }),
  };
}

module.exports = { CODE_EXT, PRIORITY_RE, resolveRoot, dirTree, keyFilesContent, buildCodeContext };
