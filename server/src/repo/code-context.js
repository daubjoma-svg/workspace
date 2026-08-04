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
const PRIORITY_RE = /(controller|service|serviceimpl|entity|model|mapper|dao|api|handler|resource|route|config|application|bootstrap|main|index)/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', 'vendor', '.idea']);

/** 解析模块快照根目录（含 sub_path），路径全部过安全校验。不存在返回 null */
function resolveRoot(mod) {
  try {
    const base = moduleRoot(REPOS_DIR, mod.module_key);
    const root = safeJoin(base, mod.sub_path || '', 'sub_path');
    return fs.existsSync(root) ? root : null;
  } catch (e) {
    logger.warn('code_context_path_rejected', { module: mod.module_key, reason: e.code || e.message });
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
function keyFilesContent(mod, { maxFiles = 8, maxCharsPerFile = 2500, maxTotal = 16000 } = {}) {
  const root = resolveRoot(mod);
  if (!root) return [];

  let skippedSensitive = 0;
  const candidates = [];
  for (const f of walk(root)) {
    if (!CODE_EXT.includes(path.extname(f).toLowerCase())) continue;
    const rel = path.relative(root, f);
    if (isSensitiveFile(rel)) { skippedSensitive += 1; continue; }   // F2-L1：评分前剔除
    let score = 0;
    if (PRIORITY_RE.test(path.basename(f))) score += 10;
    score -= rel.split(path.sep).length; // 浅层优先
    candidates.push({ f, rel, score });
  }
  candidates.sort((a, b) => b.score - a.score);

  const picked = [];
  let total = 0;
  let redactions = 0;
  for (const { f, rel } of candidates.slice(0, maxFiles)) {
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

/** 组装：某需求关联的全部平台模块 → 各代码模块的上下文 */
function buildCodeContext(mappingIds, opts = {}) {
  if (!mappingIds || !mappingIds.length) return null;
  const rows = db.prepare(`
    SELECT mm.platform_name, mm.path_prefix, cm.*
    FROM module_mappings mm JOIN code_modules cm ON cm.id = mm.code_module_id
    WHERE mm.id IN (${mappingIds.map(() => '?').join(',')})`).all(...mappingIds);
  if (!rows.length) return null;
  const synced = rows.filter((r) => r.sync_status === 'OK');
  if (!synced.length) {
    return {
      note: '关联的代码模块尚未同步(无可用快照)',
      modules: rows.map((r) => ({ platform: r.platform_name, module: r.name, status: r.sync_status })),
    };
  }
  return {
    modules: synced.map((r) => {
      const mod = { ...r, sub_path: r.path_prefix || r.sub_path };
      return {
        platform: r.platform_name,
        module_key: r.module_key,
        module_name: r.name,
        branch: r.branch,
        commit: (r.commit_sha || '').slice(0, 8),
        tree: dirTree(mod),
        key_files: opts.withFiles ? keyFilesContent(mod, opts) : undefined,
      };
    }),
  };
}

module.exports = { CODE_EXT, PRIORITY_RE, resolveRoot, dirTree, keyFilesContent, buildCodeContext };
