// Agent 工具集（代码查询）：AI 的"手脚"。
// 借鉴 deepseek-harness 的 tool registry 思想，落地为 Node 模块：
//  - 每个工具是 { name, desc, params, run } 结构，可注册可列举（LLM 通过描述知道怎么调）
//  - 全部路径操作限定在 REPOS_DIR 快照内（复用 isInside/safeJoin 越界防护）
//  - 敏感文件 L1 剔除 + 内容 L2 脱敏（复用 repo/sensitive，与 code-context 同一套防线）
//  - 纯函数、无副作用，观测结果直接回填 Agent 循环
//
// 语义搜索（semantic_search）：本地 CN-EN 业务词典 + 命名变体生成 → 多模式 grep → 相关性排序
// 让 AI 能"按意思找代码"而不是"按字面匹配"

'use strict';

const fs = require('fs');
const path = require('path');
const { isSensitiveFile, redactSecretsDetailed } = require('../repo/sensitive');
const { isInside, safeJoin } = require('../repo/paths');
const { REPOS_DIR } = require('../repo/archive');
const { walk } = require('../repo/archive');
const { CODE_EXT } = require('../repo/code-context');
const logger = require('../logger');

const MAX_READ_CHARS = 8000;   // 单文件读入预算
const MAX_GREP_HITS = 20;      // grep 命中上限
const MAX_LIST_ENTRIES = 80;   // 列目录上限
const MAX_SEMANTIC_HITS = 30;  // 语义搜索命中上限

/** 把仓库相对路径解析为快照内绝对路径；越界/不存在返回 null（不抛错，让 LLM 能继续探索）
 *  注意：rel='.'/'' 解析到仓库根本身是合法的（整仓库 grep 依赖它），
 *  isInside(root, root) 按定义为 false，必须显式放行 target === root。 */
function resolveRepoPath(repoRoot, rel) {
  if (rel == null || typeof rel !== 'string') return null;
  try {
    const rootAbs = path.resolve(repoRoot);
    const target = safeJoin(rootAbs, rel || '.', 'agent_tool');
    if (target !== rootAbs && !isInside(rootAbs, target)) return null;
    return fs.existsSync(target) ? target : null;
  } catch { return null; }
}

/** 仓库上下文：由外层构造（某需求的业务模块 → code_modules 快照根），Agent 只消费。
 *  注意：不做自动 git pull——AI 路径必须只读、不得写快照或碰主机 git 配置；
 *  快照更新走「模块管理」的管理员同步动作（repo/archive.js syncModule）。 */
function buildRepoContexts(rows) {
  return rows
    .filter((r) => r.sync_status === 'OK')
    .map((r) => {
      const dirKey = String(r.gitlab_project_id).replace(/[^A-Za-z0-9._-]/g, '_');
      const base = path.join(REPOS_DIR, dirKey);
      const root = fs.existsSync(base) ? base : null;
      return {
        repo_id: r.gitlab_project_id,
        repo_path: r.gitlab_project_path,
        business: r.business_name,
        root,
      };
    })
    .filter((r) => r.root);
}

/* ---------------- 工具实现 ---------------- */

function toolListTree({ repos, args }) {
  const lines = [];
  for (const repo of repos) {
    if (!repo.root) continue;
    lines.push(`# ${repo.repo_path} (${repo.repo_id})`);
    lines.push(`  顶层: ${fs.readdirSync(repo.root, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).map((e) => (e.isDirectory() ? `[D] ${e.name}` : e.name)).slice(0, 40).join('  ')}`);
  }
  return lines.join('\n') || '(无可用代码仓库快照)';
}

function toolListDir({ repos, args }) {
  const rel = String(args.path || '.');
  const out = [];
  for (const repo of repos) {
    if (!repo.root) continue;
    const dir = resolveRepoPath(repo.root, rel);
    if (!dir) continue;
    out.push(`# ${repo.repo_path}/${rel}`);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    let n = 0;
    for (const e of entries) {
      if (n >= MAX_LIST_ENTRIES) { out.push('  ...(截断)'); break; }
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const relFull = path.relative(repo.root, full);
      if (!e.isDirectory() && isSensitiveFile(relFull)) continue; // 敏感文件不暴露文件名
      out.push(`${e.isDirectory() ? '[D]' : '[F]'} ${e.name}`);
      n += 1;
    }
    if (out.length === 1) out.push('  (空目录或路径不存在)');
  }
  return out.join('\n') || '(路径不存在)';
}

function toolReadFile({ repos, args }) {
  const rel = String(args.path || '');
  const maxChars = Number(args.max_chars) || MAX_READ_CHARS;
  // offset_line：从第 N 行（1 起）开始读，配合 grep 命中行做「窗口阅读」，避免大文件只读到头部
  const offsetLine = Math.max(1, Number.parseInt(args.offset_line, 10) || 1);
  const out = [];
  for (const repo of repos) {
    if (!repo.root) continue;
    const file = resolveRepoPath(repo.root, rel);
    if (!file || !fs.statSync(file).isFile()) continue;
    if (isSensitiveFile(rel)) return `[拒绝] ${rel} 是敏感文件（密钥/凭据类），已跳过`;
    try {
      let content = fs.readFileSync(file, 'utf8');
      const red = redactSecretsDetailed(content); // L2 脱敏
      content = red.content;
      if (offsetLine > 1) {
        const lines = content.split('\n');
        const start = Math.min(offsetLine - 1, Math.max(0, lines.length - 1));
        content = `// (从第 ${start + 1} 行起读，共 ${lines.length} 行)\n` + lines.slice(start).join('\n');
      }
      if (content.length > maxChars) content = `${content.slice(0, maxChars)}\n// ...(截断, 共${fs.statSync(file).size}字节)`;
      out.push(`# === ${repo.repo_path}/${rel} ===\n${content}`);
      if (red.redactions > 0) out.push(`(已脱敏 ${red.redactions} 处)`);
    } catch (e) { out.push(`[读失败] ${rel}: ${e.message}`); }
  }
  return out.join('\n\n') || `[不存在] ${rel}`;
}

function toolGrep({ repos, args }) {
  const pattern = String(args.pattern || '');
  const relDir = String(args.path || '.');
  let re;
  try { re = new RegExp(pattern, 'i'); } catch { return `[参数错误] 无法解析正则: ${pattern}`; }
  const hits = [];
  for (const repo of repos) {
    if (!repo.root) continue;
    const dir = resolveRepoPath(repo.root, relDir);
    if (!dir) continue;
    for (const f of walk(dir)) {
      if (!CODE_EXT.includes(path.extname(f).toLowerCase())) continue;
      const rel = path.relative(repo.root, f);
      if (isSensitiveFile(rel)) continue;
      try {
        const lines = fs.readFileSync(f, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push(`${repo.repo_path}/${rel}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
            if (hits.length >= MAX_GREP_HITS) return hits.join('\n') + `\n...(命中超 ${MAX_GREP_HITS} 条截断)`;
          }
        }
      } catch { /* 单个文件读失败跳过 */ }
    }
  }
  return hits.length ? hits.join('\n') : `[无命中] ${pattern} in ${relDir}`;
}

function toolGlob({ repos, args }) {
  const pat = String(args.pattern || '');
  const baseName = path.basename(pat);
  const dirPat = path.dirname(pat);
  const re = new RegExp('^' + baseName.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  const out = [];
  for (const repo of repos) {
    if (!repo.root) continue;
    const dir = resolveRepoPath(repo.root, dirPat === '.' ? '.' : dirPat);
    if (!dir) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) continue;
      if (re.test(e.name)) {
        const rel = path.relative(repo.root, path.join(dir, e.name));
        if (!isSensitiveFile(rel)) out.push(`${repo.repo_path}/${rel}`);
      }
    }
  }
  return out.length ? out.join('\n') : `[无匹配] ${pat}`;
}

/* ---------------- 语义搜索 ---------------- */

// 中文业务术语 → 英文技术词映射表（覆盖本项目常见业务域）
const CN_EN_DICT = {
  '员工': ['employee', 'staff', 'user', 'person'],
  '职级': ['joblevel', 'job_level', 'rank', 'grade', 'authrank', 'auth_rank'],
  '导入': ['import', 'upload', 'batchImport', 'batch_import'],
  '导出': ['export', 'download', 'batchExport', 'batch_export'],
  '组织': ['organization', 'org', 'department', 'dept'],
  '部门': ['department', 'dept', 'org'],
  '岗位': ['position', 'job', 'post', 'role'],
  '审批': ['approval', 'approve', 'audit', 'workflow', 'flow'],
  '或签': ['orsign', 'anyOne', 'any_one', 'orSign', 'parallel'],
  '会签': ['countersign', 'coSign', 'co_sign'],
  '离职': ['resign', 'leave', 'dimission', 'departure'],
  '在职': ['active', 'employment', 'inService', 'in_service', 'onJob'],
  '停用': ['disabled', 'deactivate', 'inactive', 'frozen'],
  '权限': ['permission', 'auth', 'privilege', 'access'],
  '角色': ['role', 'character'],
  '字典': ['dictionary', 'dict', 'enum', 'constant'],
  '批量': ['batch', 'bulk', 'mass'],
  '流程': ['workflow', 'flow', 'process', 'pipeline'],
  '节点': ['node', 'step', 'stage'],
  '优先级': ['priority', 'urgency', 'weight'],
  '人员': ['person', 'member', 'employee', 'staff'],
  '薪酬': ['salary', 'compensation', 'pay', 'payroll'],
  '考勤': ['attendance', 'clock', 'checkin', 'punch'],
  '报销': ['reimbursement', 'expense', 'claim'],
  '发票': ['invoice', 'receipt', 'bill'],
  '合同': ['contract', 'agreement'],
  '签订': ['sign', 'execute', 'conclude'],
  '生效': ['effective', 'activate', 'enable'],
  '失效': ['expire', 'invalid', 'disable'],
  '状态': ['status', 'state', 'phase'],
  '枚举': ['enum', 'enumeration', 'constant', 'type'],
  '校验': ['validate', 'check', 'verify', 'validation'],
  '配置': ['config', 'configuration', 'setting', 'preference'],
  '日志': ['log', 'logger', 'audit', 'record'],
  '通知': ['notify', 'notification', 'message', 'alert'],
  '消息': ['message', 'msg', 'notice', 'notification'],
  '模板': ['template', 'tpl', 'pattern'],
  '报表': ['report', 'statistics', 'analytics'],
  '图表': ['chart', 'graph', 'diagram'],
  '同步': ['sync', 'synchronize', 'pull', 'push'],
  '迁移': ['migrate', 'migration', 'transfer'],
  '版本': ['version', 'release', 'tag'],
  '异常': ['exception', 'error', 'fault', 'fail'],
  '重试': ['retry', 'resend', 'replay'],
  '缓存': ['cache', 'buffer', 'pool'],
  '定时': ['schedule', 'cron', 'timer', 'job'],
  '任务': ['task', 'job', 'work', 'assignment'],
  '证书': ['certificate', 'cert', 'credential'],
  '证件': ['idcard', 'id_card', 'identity', 'idNumber'],
  '掩码': ['mask', 'masked', 'desensitize', 'desensitized'],
  '集团': ['group', 'corporate', 'conglomerate'],
  '企业': ['enterprise', 'company', 'corp'],
  '子公司': ['subsidiary', 'branch', 'subCorp'],
  '审批人': ['approver', 'candidate', 'assignee', 'auditor'],
  '发起人': ['initiator', 'starter', 'creator', 'applicant'],
  '抄送': ['cc', 'carbon_copy', 'notify'],
  '转交': ['transfer', 'delegate', 'forward'],
  '撤回': ['withdraw', 'revoke', 'cancel', 'recall'],
  '加签': ['addSign', 'add_sign', 'addNode'],
  '减签': ['removeSign', 'remove_sign'],
};

/** 英文单词 → 多种命名变体（camelCase / PascalCase / snake_case / CONSTANT_CASE / kebab） */
function namingVariants(word) {
  if (!word) return [];
  // 拆分复合词（camelCase → parts, snake_case → parts）
  const parts = word.replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  if (!parts.length) return [];

  const lower = parts.join('');
  const camel = parts.map((p, i) => i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)).join('');
  const pascal = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  const snake = parts.join('_');
  const constant = parts.join('_').toUpperCase();
  const kebab = parts.join('-');

  return [lower, camel, pascal, snake, constant, kebab];
}

/** 从自然语言查询中提取搜索词（中文→英文联想 + 命名变体生成） */
function extractQueryTerms(query) {
  if (!query || typeof query !== 'string') return [];
  const terms = new Set();

  // 1. 提取中文词 → 查词典 → 生成英文命名变体
  //    策略：先用 jieba 式的前缀切分（2-6字滑窗），保证"员工在职状态"能拆出"员工"+"在职"+"状态"
  const cnText = query.replace(/[^\u4e00-\u9fa5]/g, ''); // 纯中文
  const cnWordsFound = new Set();
  // 滑窗切分：从每个位置开始尝试 2-6 字的词
  for (let i = 0; i < cnText.length; i += 1) {
    for (let len = 6; len >= 2; len -= 1) {
      if (i + len > cnText.length) continue;
      const sub = cnText.slice(i, i + len);
      if (CN_EN_DICT[sub]) {
        cnWordsFound.add(sub);
        break; // 最长匹配，找到就不再试更短的
      }
    }
  }
  // 也尝试原始正则匹配的完整中文词（如业务自定义词不在词典里）
  const cnRawWords = query.match(/[一-龥]{2,8}/g) || [];
  for (const w of cnRawWords) {
    if (w.length >= 2) cnWordsFound.add(w);
  }

  for (const w of cnWordsFound) {
    const enWords = CN_EN_DICT[w];
    if (enWords) {
      for (const en of enWords) terms.add(en);
      for (const en of enWords) namingVariants(en).forEach((v) => terms.add(v));
    }
    // 也搜中文词本身
    if (w.length >= 2) terms.add(w);
  }

  // 2. 提取英文/驼峰词 → 生成命名变体
  const enWords = query.match(/[a-zA-Z][a-zA-Z0-9_]*/g) || [];
  for (const w of enWords) {
    if (w.length < 2) continue;
    terms.add(w);
    namingVariants(w).forEach((v) => terms.add(v));
  }

  // 过滤掉太短的（1字符）和空字符串
  return [...terms].filter((t) => t.length >= 2);
}

/** 语义搜索：自然语言 → 多模式 grep → 相关性排序 */
function toolSemanticSearch({ repos, args }) {
  const query = String(args.query || '');
  const relDir = String(args.path || '');
  if (!query.trim()) return '[参数错误] query 不能为空';
  const terms = extractQueryTerms(query);
  if (!terms.length) return `[无搜索词] 无法从"${query}"中提取有效搜索词`;
  // 构造 OR 正则：term1|term2|...
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  let re;
  try { re = new RegExp(pattern, 'i'); } catch { return `[正则错误] ${pattern.slice(0, 200)}`; }

  const fileHits = new Map(); // rel → { rel, hits: [], score: 0 }
  let totalHits = 0;
  for (const repo of repos) {
    if (!repo.root) continue;
    const dir = resolveRepoPath(repo.root, relDir);
    if (!dir) continue;
    for (const f of walk(dir)) {
      if (!CODE_EXT.includes(path.extname(f).toLowerCase())) continue;
      const rel = path.relative(repo.root, f);
      if (isSensitiveFile(rel)) continue;
      try {
        const lines = fs.readFileSync(f, 'utf8').split('\n');
        const matched = [];
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matched.push({ line: i + 1, content: lines[i].trim().slice(0, 160) });
            totalHits += 1;
            if (totalHits >= MAX_SEMANTIC_HITS * 3) break; // 防止超大仓库卡死
          }
        }
        if (matched.length > 0) {
          const key = `${repo.repo_path}/${rel}`;
          // 文件名也匹配 → 加分（说明文件本身就叫这个名字）
          const nameBonus = terms.some((t) => rel.toLowerCase().includes(t.toLowerCase())) ? 5 : 0;
          // 命中行分散度（越集中越相关）
          const proximityBonus = matched.length > 3 ? 2 : 0;
          fileHits.set(key, {
            rel: `${repo.repo_path}/${rel}`,
            hits: matched.slice(0, 8),
            score: matched.length + nameBonus + proximityBonus,
          });
        }
      } catch { /* 单文件读失败跳过 */ }
      if (totalHits >= MAX_SEMANTIC_HITS * 3) break;
    }
    if (totalHits >= MAX_SEMANTIC_HITS * 3) break;
  }

  // 按相关性排序
  const ranked = [...fileHits.values()].sort((a, b) => b.score - a.score).slice(0, MAX_SEMANTIC_HITS);
  if (!ranked.length) return `[无命中] 语义搜索"${query}"：${terms.length} 个变体均未匹配`;

  const out = ranked.map((f) => {
    const hitLines = f.hits.map((h) => `  L${h.line}: ${h.content}`).join('\n');
    return `### ${f.rel} (相关度: ${f.score}, 命中: ${f.hits.length})\n${hitLines}`;
  });
  return `[语义搜索] query="${query}" → ${terms.length} 个变体 (${terms.slice(0, 8).join(', ')}${terms.length > 8 ? '...' : ''})\n${out.join('\n\n')}`;
}

/* ---------------- 注册表 ---------------- */

const TOOLS = {
  list_tree: {
    desc: '列出当前仓库列表与各仓库顶层目录（第一步先看这个了解结构）',
    params: [],
    run: toolListTree,
  },
  list_dir: {
    desc: '列出仓库内某个目录的内容，path 是相对仓库根的目录路径，如 src/main/java/com/xxx',
    params: ['path'],
    run: toolListDir,
  },
  read_file: {
    desc: '读取某个文件的内容，path 是相对仓库根的路径；max_chars 控制读入预算（默认 8000）；offset_line 从第 N 行起读（配合 grep 命中行做窗口阅读，大文件必用）',
    params: ['path', 'max_chars', 'offset_line'],
    run: toolReadFile,
  },
  grep: {
    desc: '在指定目录递归搜正则/字符串（不区分大小写），返回文件:行号:内容。pattern 用正则（中文/英文/驼峰/下划线/相关业务词都列出来，OR 用 |）。path 可空（空=整仓库搜）或传子目录；整仓库搜会先命中常见词导致真正目标被截断，建议先用 list_tree 看仓库有哪些子目录再针对性搜。',
    params: ['pattern', 'path'],
    run: toolGrep,
  },
  glob: {
    desc: '按文件名模式匹配目录下的文件（支持 * 通配），如 *Controller.java',
    params: ['pattern', 'path'],
    run: toolGlob,
  },
  semantic_search: {
    desc: '语义搜索代码：用自然语言描述你要找的代码（如"员工在职状态枚举定义"、"职级导入导出逻辑"），会自动把中文业务词联想成英文技术词（或签→orSign/anyOne）并生成驼峰/下划线/常量等命名变体，一次性多模式匹配，按相关性排序返回。比 grep 更智能——grep 需要你猜准确的命名，semantic_search 帮你猜。',
    params: ['query', 'path'],
    run: toolSemanticSearch,
  },
};

/** 工具描述（喂给 LLM 的 JSON 协议说明） */
function describeTools() {
  return Object.entries(TOOLS).map(([name, t]) =>
    `- ${name}${t.params.length ? `(${t.params.join(', ')})` : '()'}: ${t.desc}`
  ).join('\n');
}

/** 执行一个工具调用；返回观测文本（绝不抛错，任何失败都转成观测让 Agent 继续） */
/**
 * trae-cli 工具名 → 我们的工具名映射（traecli 用大写 LS/Glob/Read，我们用小写 list_dir/glob/read_file）
 * Bash 禁止（安全考虑；traecli 走我们框架，不再需要直接 shell）
 */
const TRAE_TOOL_ALIAS = { LS: 'list_dir', Glob: 'glob', Read: 'read_file', Grep: 'grep', SemanticSearch: 'semantic_search', Bash: null };

/** traecli 给的绝对路径 → 相对仓库根路径（找不到匹配仓库返回 null） */
function adaptTraeCliPath(absolutePath, repos) {
  if (typeof absolutePath !== 'string' || !absolutePath.startsWith('/')) return absolutePath;
  for (const repo of repos) {
    if (!repo.root) continue;
    if (absolutePath === repo.root) return '.';
    if (absolutePath.startsWith(repo.root + '/')) return absolutePath.slice(repo.root.length + 1);
  }
  return null;
}

async function executeTool(repos, tool, args) {
  // trae-cli 工具名映射：LS→list_dir / Glob→glob / Read→read_file / Grep→grep / Bash→禁用
  const aliased = Object.prototype.hasOwnProperty.call(TRAE_TOOL_ALIAS, tool) ? TRAE_TOOL_ALIAS[tool] : tool;
  if (aliased === null) return `[拒绝] 工具 ${tool} 在 trae-cli 模式下禁用（安全考虑）`;
  // traecli 输出绝对路径 → 转相对路径（仅对 path 参数处理）
  if (aliased !== tool && args && typeof args.path === 'string' && args.path.startsWith('/')) {
    const rel = adaptTraeCliPath(args.path, repos);
    if (rel === null) return `[路径越界] ${args.path} 不在仓库内`;
    args = { ...args, path: rel };
  }
  const t = TOOLS[aliased];
  if (!t) return `[未知工具] ${tool}。可用工具:\n${describeTools()}`;
  try { return await t.run({ repos, args: args || {} }); }
  catch (e) { return `[工具执行失败] ${tool}: ${e.message}`; }
}

module.exports = {
  buildRepoContexts, describeTools, executeTool, TOOLS,
  MAX_READ_CHARS, MAX_GREP_HITS,
  extractQueryTerms, namingVariants, CN_EN_DICT,
};
