// Agent 证据收集：LLM 规划搜索 → 服务端多轮查证（semantic_search + grep + 命中窗口读文件）
// 升级：从纯 grep 改为 semantic_search（CN-EN 词典 + 命名变体生成），让 AI 能"按意思找代码"
//  - 搜索词由 LLM 按业务语义联想（或签→orSign/anyOne；在职状态→EmployeeStatus 枚举）
  // - semantic_search 自动生成驼峰/下划线/常量等命名变体，一次性多模式匹配
  // - grep 保留作为精确模式补充（LLM 给的精确类名/方法名直接搜）
//  - grep 命中后按命中数排序，对 top 文件做「命中行窗口」定向阅读，拿到真实类/方法/枚举定义
//  - plan 失败时回退到调用方给的兜底关键词，保证流程不中断

'use strict';

const logger = require('../logger');
const { requestOnce } = require('../llm-call');
const { executeTool } = require('./tools');

const PLAN_TIMEOUT_MS = 90000;
const MAX_KEYWORDS = 10;         // LLM 搜索词上限
const GREP_BUDGET_CHARS = 1200;  // 每个关键词的证据预算
const READ_BUDGET_CHARS = 3000;  // 单文件阅读预算
const MAX_HIT_FILES = 4;         // grep 命中 top 文件定向阅读数
const MAX_PLAN_FILES = 3;        // LLM 推荐候选文件阅读数
const TOTAL_BUDGET_CHARS = 24000;// 证据总预算（约 2-3 万 token，k2/trae 上下文可承受）

/** 正则转义（LLM 给的关键词可能含特殊字符） */
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** grep 命中行格式是 repo_path/rel:line: content；repo_path 本身含 /，用 repos 列表精确剥离 */
function stripRepoPrefix(hitPath, repos) {
  for (const r of repos) {
    if (hitPath.startsWith(r.repo_path + '/')) return hitPath.slice(r.repo_path.length + 1);
  }
  return null;
}

/** 从 grep 观测文本统计命中文件 → [{rel, hits, firstLine}] 按命中数降序 */
function rankHitFiles(grepOutputs, repos) {
  const map = new Map();
  for (const text of grepOutputs) {
    for (const line of String(text).split('\n')) {
      const m = line.match(/^(.+?):(\d+):\s/);
      if (!m) continue;
      const rel = stripRepoPrefix(m[1], repos);
      if (!rel) continue;
      const cur = map.get(rel) || { rel, hits: 0, firstLine: +m[2] };
      cur.hits += 1;
      cur.firstLine = Math.min(cur.firstLine, +m[2]);
      map.set(rel, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.hits - a.hits);
}

/** Phase A：LLM 根据需求 + 仓库结构生成搜索计划（业务词 → 技术词联想） */
async function planSearch(apiKey, req, treeText, focus) {
  const desc = String(req.description || '').replace(/<[^>]+>/g, ' ').slice(0, 400);
  const focusLine = focus === 'evaluate'
    ? '目标是评估需求合理性与影响面，重点找：相关业务类、对外接口、状态枚举、表结构。'
    : '目标是先透析问题再写开发提示词：优先验证是否存在全量读取/全量展示、分页请求参数与分页返回、搜索策略、提交后刷新策略，以及同一能力被哪些页面复用；确认根因后才找直接相关的改动点与接口。';
  const prompt = [
    '你是 10 年经验研发负责人，要在下面的代码仓库里定位需求相关代码。' + focusLine,
    '给出搜索计划，只输出 JSON（不要输出其他文字）：',
    '{"keywords":["8-12 个搜索词：需求里的业务中文词 + 你联想的技术词（英文/驼峰/下划线/常量/枚举命名都要想到，如 或签→orSign/anyOne；在职状态→EmployeeStatus/employmentStatus；审批人→approver/candidate）"],"files":["你认为最可能相关的文件相对路径（按仓库结构推断，最多5个，没把握就给空数组）"]}',
    '',
    '注意：系统会自动把你给的中文词联想成英文并生成驼峰/下划线/常量等命名变体，所以你只需要给出业务概念词和直接联想到的技术词即可。',
    '需求标题：' + (req.title || ''),
    '需求描述：' + desc,
    '',
    '【仓库结构】',
    treeText,
  ].join('\n');
  try {
    const data = await requestOnce({
      body: { messages: [{ role: 'user', content: prompt }] },
      trae_token: apiKey || '',
      provider_type: 'trae-cli',
    }, PLAN_TIMEOUT_MS);
    const raw = data?.choices?.[0]?.message?.content || '';
    const first = raw.indexOf('{'); const last = raw.lastIndexOf('}');
    if (first < 0 || last < 0) return null;
    const plan = JSON.parse(raw.slice(first, last + 1));
    const keywords = (Array.isArray(plan.keywords) ? plan.keywords : [])
      .map((k) => String(k).trim()).filter((k) => k.length >= 2).slice(0, MAX_KEYWORDS);
    const files = (Array.isArray(plan.files) ? plan.files : [])
      .map((f) => String(f).trim()).filter(Boolean).slice(0, MAX_PLAN_FILES);
    if (!keywords.length && !files.length) return null;
    logger.info('evidence_plan', { req: req.id, keywords, files });
    return { keywords, files };
  } catch (e) {
    logger.warn('evidence_plan_failed', { req: req.id, reason: String(e.message || e).slice(0, 120) });
    return null;
  }
}

/** 读文件（LLM 推荐路径可能带仓库名前缀，读不到时剥掉首段重试一次） */
async function readWithFallback(repos, rel, offsetLine) {
  let out = await executeTool(repos, 'read_file', { path: rel, max_chars: READ_BUDGET_CHARS, offset_line: offsetLine || 1 });
  if (out.startsWith('[不存在]') && rel.includes('/')) {
    out = await executeTool(repos, 'read_file', { path: rel.slice(rel.indexOf('/') + 1), max_chars: READ_BUDGET_CHARS, offset_line: offsetLine || 1 });
  }
  return out;
}

/**
 * 收集证据：list_tree → LLM 搜索计划 → 逐词 grep → 命中窗口读文件
 * @returns {{ text: string, filesUsed: string[] }} 证据文本 + 实际读到的文件清单
 */
async function collectEvidence(apiKey, req, repos, { focus = 'dev', fallbackKeywords = [] } = {}) {
  const sections = [];
  const filesUsed = [];
  const tree = String(await executeTool(repos, 'list_tree', {}));
  sections.push('[仓库结构]\n' + tree.slice(0, 2500));

  const plan = await planSearch(apiKey, req, tree.slice(0, 2500), focus);
  const keywords = plan && plan.keywords.length ? plan.keywords : fallbackKeywords.slice(0, 6);

  // Phase B-1：用 semantic_search 做语义搜索（自动生成命名变体 + 相关性排序）
  const grepOuts = [];
  for (const kw of keywords) {
    // 中文业务词用 semantic_search（会自动联想英文 + 生成驼峰/下划线变体）
    // 英文精确词用 grep（LLM 给的类名/方法名直接搜，不扩散）
    const isChinese = /[一-龥]/.test(kw);
    const tool = isChinese ? 'semantic_search' : 'grep';
    const args = isChinese ? { query: kw, path: '' } : { pattern: escapeRe(kw), path: '' };
    const hits = String(await executeTool(repos, tool, args));
    grepOuts.push(hits);
    sections.push(`[${tool} ${kw}]\n` + hits.slice(0, GREP_BUDGET_CHARS));
  }

  // Phase B-2：定向阅读 —— grep 命中数 top 文件（命中行窗口）+ LLM 推荐文件
  const topHits = rankHitFiles(grepOuts, repos).slice(0, MAX_HIT_FILES);
  const readSet = new Set();
  for (const h of topHits) {
    if (readSet.has(h.rel)) continue;
    readSet.add(h.rel);
    const offset = Math.max(1, h.firstLine - 20);
    const content = await readWithFallback(repos, h.rel, offset);
    if (!content.startsWith('[不存在]')) filesUsed.push(h.rel);
    sections.push('[read ' + h.rel + ' · grep命中' + h.hits + '次 · 第' + offset + '行起]\n' + content);
  }
  for (const f of (plan ? plan.files : [])) {
    if (readSet.has(f)) continue;
    readSet.add(f);
    const content = await readWithFallback(repos, f, 1);
    if (!content.startsWith('[不存在]')) filesUsed.push(f);
    sections.push('[read ' + f + ' · LLM推荐]\n' + content);
  }

  // 总预算控制：超出部分截尾（优先保留前面的 grep 证据与仓库结构）
  let text = sections.join('\n\n');
  if (text.length > TOTAL_BUDGET_CHARS) text = text.slice(0, TOTAL_BUDGET_CHARS) + '\n...(证据超预算截断)';
  logger.info('evidence_collected', { req: req.id, chars: text.length, files: filesUsed });
  return { text, filesUsed };
}

module.exports = { collectEvidence };
