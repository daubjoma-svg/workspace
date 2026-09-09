// AI 节点执行（runAI · Agent 模式）：多步查证代码 → 输出 schema 形状 JSON → Zod 校验
// 借鉴 deepseek-harness 的核心思想：节点产出不再"一次性 LLM 靠猜"，
// 而是 Agent 循环：先用工具（list_tree/list_dir/read_file/grep/glob）查代码，
// 证据充分后再输出结构化产物。所有输出都必须基于工具观测到的代码事实。
//
// 与 ai.js runAI 的兼容：
// - 返回 {content, model, meta} 形状不变（content 经 schemaFor(action) Zod 校验）
// - 失败（Agent 超时 / 解析失败 / 不符合 schema）走 ai.js 的 buildMock 兜底
// - meta 记录 is_mock/code_basis/code_files_used 与原路径一致

'use strict';

const logger = require('../logger');
const { activeProvider, resolveApiKey } = require('../llm/provider');
const { buildRequest, requestOnce, extractContent, extractJsonBlock } = require('../llm-call');
const { schemaFor, shapeFor, minimalFallback } = require('../llm-schema');
const { describeTools, executeTool, buildRepoContexts } = require('./tools');
const { collectEvidence } = require('./evidence');

const AGENT_MAX_STEPS = 6;          // 单节点最多 6 步：允许多轮 grep/read 查证后再答（质量优先）
const STEP_TIMEOUT_MS = 45000;      // 单步 LLM 45s（Kimi 偏慢，给足推理时间）
const TOTAL_TIMEOUT_MS = 180000;    // 整体 3 分钟（多轮查证的合理预算）
const TRAE_STEP_TIMEOUT_MS = 120000;// trae-cli 本地进程含 token 交换，单步需要更久

/** 让 LLM 看到 schema 形状描述（EVALUATE/PRECHECK/PRD_GEN/DEV_PROMPT/TEST_CASE 等都有 Zod schema） */
function schemaHintForShape(action) {
  const shape = shapeFor(action);
  if (shape === 'text') {
    return `产物形状是 text 字符串：{"text":"..."}`;
  }
  if (action === 'PRECHECK') {
    return `产物形状：{"pass": boolean, "questions": string[], "issues": string[], "summary": string}`;
  }
  if (action === 'EVALUATE') {
    return `产物形状：{"level":"L1"|"L2"|"L3", "rationality":{"verdict":"FEASIBLE"|"FEASIBLE_WITH_CONDITION"|"NEEDS_ATTENTION"|"INFEASIBLE","reason":string}, "attention_points":string[], "impact_scope":[{"module":"业务模块名","files":["pom.xml","..."],"apis":["对外REST路径"],"tables":["库表名"],"controllers":[{"class":"完整类名","methods":["方法名1","方法名2"]}],"confidence":0~1}], "risks":[{"description":string,"level":"高"|"中"|"低"}], "suggested_test_focus":string[]}`;
  }
  if (action === 'PRD_GEN') {
    return `产物形状：{"goal":string, "background":string, "user_stories":string[], "acceptance_criteria":string[], "non_goals":string[], "open_questions":string[]}`;
  }
  if (action === 'DEV_PROMPT') {
    return `产物形状：{"summary":string, "steps":[{"step":number,"action":string,"detail":string,"files_to_touch":string[],"verify":string}], "env":{}, "risks":string[]}`;
  }
  if (action === 'TEST_CASE') {
    return `产物形状：[{"id":number,"type":"正常流"|"异常流"|"边界", "title":string, "steps":string, "expect":string, "result":""}]`;
  }
  return '产物形状：按业务要求输出结构化 JSON。';
}

/** LLM 输出的 answer 字段 → 解析 JSON → schema 校验 → content；返回 null 表示失败 */
function parseAndValidate(action, answerText) {
  if (!answerText) return null;
  const trimmed = String(answerText).trim();

  // 1. JSON 围栏块 / 平衡片段抽取
  const block = extractJsonBlock(trimmed);
  if (!block) {
    // 纯文本兜底：仅 text shape 接受
    if (shapeFor(action) === 'text') {
      const r = schemaFor(action).safeParse({ text: trimmed });
      return r.success ? r.data.text : null;
    }
    return null;
  }
  const candidate = shapeFor(action) === 'text' ? { text: typeof block === 'string' ? block : JSON.stringify(block) } : block;
  const parsed = schemaFor(action).safeParse(candidate);
  if (!parsed.success) {
    // 宽松归一化：① verdict 归一到 schema enum；② EVALUATE 缺的必填字段补默认值
    let fixed = normalizeVerdict(candidate);
    if (action === 'EVALUATE') fixed = completeEvaluationDefaults(fixed);
    if (fixed !== candidate) {
      const retry = schemaFor(action).safeParse(fixed);
      if (retry.success) return shapeFor(action) === 'text' ? retry.data.text : retry.data;
    }
    logger.warn('agent_schema_invalid', {
      action, issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}:${i.code}`).join(','),
    });
    return null;
  }
  return shapeFor(action) === 'text' ? parsed.data.text : parsed.data;
}

/** EVALUATE verdict 宽松归一化：FEASIBLE_WITH_CONDITION → FEASIBLE；NEEDS_ATTENTION_* → NEEDS_ATTENTION */
function normalizeVerdict(candidate) {
  try {
    const v = candidate?.rationality?.verdict;
    if (typeof v !== 'string') return candidate;
    const upper = v.toUpperCase();
    let next = v;
    if (upper.startsWith('FEASIBLE')) next = 'FEASIBLE';
    else if (upper.startsWith('NEEDS_ATTENTION')) next = 'NEEDS_ATTENTION';
    // L5 等其他自定义等级（前端会从颜色映射表取）
    if (next !== v) {
      return { ...candidate, rationality: { ...candidate.rationality, verdict: next } };
    }
  } catch { /* 保持原样 */ }
  return candidate;
}

/** EVALUATE 缺的必填字段补默认值（模型常只给 level/rationality，其余留空） */
function completeEvaluationDefaults(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const o = { ...obj };
  // L1-L5 改动等级 → 工时档位（人日）
  const effortByLevel = {
    L1: { min_days: 0.5, max_days: 1 },
    L2: { min_days: 1,   max_days: 3 },
    L3: { min_days: 3,   max_days: 7 },
    L4: { min_days: 7,   max_days: 15 },
    L5: { min_days: 15,  max_days: 30 },
  };
  if (o.effort === undefined) {
    const def = effortByLevel[o.level] || { min_days: 3, max_days: 7 };
    o.effort = { ...def, confidence: 0, basis: 'AI 未给出，按 level 中位档兜底，请人工复核' };
  }
  if (o.impact_scope === undefined) o.impact_scope = [];
  if (o.risks === undefined) o.risks = [];
  if (o.suggested_test_focus === undefined) o.suggested_test_focus = [];
  if (o.perspectives === undefined) o.perspectives = { customer: '', product: '', engineering: '' };
  if (o.attention_points === undefined) o.attention_points = [];
  return o;
}

/** 构造 Agent system prompt：可用工具 + 产物 schema + "无证据不得断言" 硬约束 */
function buildActionSystemPrompt(baseSys, action) {
  const toolDesc = describeTools();
  const schemaHint = schemaHintForShape(action);
  // 角色定位：EVALUATE=需求评审专家（不暴露技术类名/方法名/字段名/异常名）；DEV_PROMPT=技术实现专家
  const roleLine = action === 'EVALUATE'
    ? '你是【需求评审专家】，对接 CSM 和产品。【产物用业务语言】不要暴露具体类名、方法名、字段名、异常名（如 EmployeeAuthRank、UcFinHubExceptionMsgEnum、EMPLOYEE_RANK_NAME_EXISTS 等代码细节一概不出现）；用业务术语描述（如「职级导入新增」「权限校验冲突」）。【只回答 3 件事】1)需求合理性 + 价值；2)难度等级 + 大致人日；3)需要 CSM/产品决策的业务风险。技术细节留给研发阶段。'
    : action === 'DEV_PROMPT'
      ? '你是【技术实现专家】，给研发产出可执行的开发提示词（Markdown）。【必须基于真实代码】先查证再输出：所有改动点必须引用你实际用工具读到的文件路径与行号。**禁止凭常见模式编造**——仓库里没有的类/接口/表，一律标「未找到」，不许编造名字。'
      : '你是【业务专家】，给出该环节的结构化结论。';
  // DEV_PROMPT/PRD_GEN 也走 Agent 协议（必须真读代码），只是产物 shape 是 Markdown 文本
  const head = '\n\n【Agent 工具协议 · 强制】\n你必须先用工具查代码，再产出。**禁止靠推测、禁止编造**：所有结论必须引用具体文件路径与行号；仓库里没有的东西必须标「未找到」，禁止编造类名/接口名/表名。\n可用工具：\n';
  const middle = '\n\n【产物 schema 硬约束】\n';
  // DEV_PROMPT 产物是 Markdown 文本（shape=text），但要按结构输出；EVALUATE 等走 JSON
  const tail = action === 'DEV_PROMPT'
    ? '\n\n【输出协议】\n- 调工具：{"tool":"工具名","args":{...}}\n- 查证充分后输出最终答案：{"answer": "<Markdown 文本>"}\n\n【规则】\n1. 先 list_tree 了解仓库结构，再 grep/read_file 查证具体代码；**没有通过工具读到代码之前**禁止输出 answer。\n2. **每次工具调用只输出一个 JSON**；不要写围栏外文字。\n3. **产物必须全部基于工具读到的真实代码**：每个改动点都要写实际文件路径（如 usercenter-core/src/main/java/com/xxx/...），标注行号；读不到就写「未找到（需人工确认）」。\n4. 禁止出现仓库里不存在的类名/接口名/表名（如未读到的 GradeController 就是编造，禁止写）。\n5. 最终 Markdown 必须包含以下章节（按用户要求）：\n   ## 需求描述（完整复述原始需求 + PRD 关键内容）\n   ## 是否需要新增接口（基于已读代码判断：现有接口能否覆盖，若需新增列出方法与参数）\n   ## 是否需要新增数据库表（基于已读实体/表结构判断；如新增，给出字段设计：字段名/类型/注释/索引）\n   ## 前端改动点（页面/组件/API 调用，写实际文件路径）\n   ## 服务端改动点（Controller/Service/DAO，写实际文件路径与改动内容）\n   ## 是否关联其他模块（基于 grep 到的引用判断：是否影响薪资/组织/权限等，写明依赖关系）\n   ## 实现步骤与验证建议\n'
    : '\n\n【输出协议 · 每步严格 JSON，一次一个动作】\n- 调工具：{"tool":"工具名","args":{...}}\n- 给最终答案：{"answer": <符合上面 schema 的 JSON 对象/数组>}\n\n【规则】\n1. 先 list_tree 了解仓库结构，再 grep/read_file 查证具体代码；**没有通过工具读到代码之前**禁止输出 answer。\n2. 查证充分后输出 {"answer": ...}；answer 字段是符合 schema 的 JSON（对象/数组），不要写自然语言说明。\n3. 每次只输出一个 JSON 动作；不要写围栏外的文字、不要写"调用 xxx"自然语言。\n4. 代码里没有的功能就标 "未找到" 或降低置信度，不要凭印象回答。';
  return roleLine + '\n\n' + baseSys + head + toolDesc + middle + schemaHint + tail;
}

/** 单步 LLM 调用（prompt_only，期望 JSON 输出） */
async function stepCall(provider, apiKey, sys, userPayload, timeoutMs) {
  const reqBody = buildRequest(provider, apiKey, sys, userPayload, 'AGENT', 'prompt_only');
  const data = await requestOnce(reqBody, timeoutMs);
  return extractContent(provider.type, data);
}

/** DEV_PROMPT 节点：我们自己读代码（list_tree/grep/read_file 拿到真实路径），traecli 只当纯 LLM 生成 Markdown。
 * 关键：prompt 不能含"工具/查代码"等暗示（否则 traecli 进 agent loop 输出 session dump 不可用）。
 * 所以工具调用只在我们这边发生（executeTool），喂给 traecli 的是已读到的真实代码证据摘要。
 */
/** 兜底关键词（LLM 搜索计划失败时用）：需求文本中的业务词 + 常见技术词 */
function extractFallbackKeywords(req) {
  const text = String(req.title || '') + String(req.description || '').replace(/<[^>]+>/g, ' ').slice(0, 300);
  const cnWords = text.match(/[一-龥]{2,8}/g) || [];
  const bizWords = cnWords.filter((w) => ['职级', '导入', '导出', '批量', '组织', '岗位', '部门', '员工', '字典', '审批', '或签', '离职', '停用', '在职', '人员', '流程', '节点', '优先级', '权限', '角色'].includes(w)).slice(0, 3);
  const enWords = ['rank', 'grade', 'level', 'import', 'export', 'joblevel', 'authrank', 'approval', 'approver', 'audit', 'sign', 'flow', 'node', 'active', 'leave', 'disabled', 'employee'];
  return [...bizWords, ...enWords].slice(0, 6);
}

async function generateDevPromptDirect(provider, req, extra, repos) {
  const apiKey = resolveApiKey(provider);
  if (!repos || repos.length === 0) return null;
  const desc = String(req.description || '').replace(/<[^>]+>/g, ' ').slice(0, 300);
  // ---- 1. 收集证据：LLM 规划搜索词（业务词→技术词联想）→ grep → 命中窗口读真实代码 ----
  const ev = await collectEvidence(apiKey, req, repos, { focus: 'dev', fallbackKeywords: extractFallbackKeywords(req) });
  // ---- 2. 构造精简 prompt（无工具暗示）----
  const sys = '你是 10 年经验研发负责人，给手下研发写开发提示词。只输出研发看得懂的 3 部分内容，不要解释过程，不要调用工具。';
  const outReq = [
    '## 一、需求汇总',
    '用 2-3 句话概括需求：要解决什么问题、用户场景、预期效果。不要长篇复述。',
    '',
    '## 二、改动点',
    '按「前端 / 后端 / 其他」列出必须改的文件和改法。只引用【代码证据】中真实出现的文件路径（相对路径，禁止 /Users/ 绝对路径）；证据中没有的类/接口/表标「未找到」。新增文件写「新增：建议命名为 xxx（需研发确认）」。',
    '每条改动点格式：文件路径 + 做什么 + 关键代码行号/函数名。',
    '',
    '## 三、注意点',
    '列出 3-5 条研发容易踩的坑或必须遵守的规则：边界条件、幂等/事务、兼容性、权限、并发、测试重点。不要写空泛建议。',
  ].join('\n');
  const prompt = [
    sys,
    '\n需求标题：' + (req.title || ''),
    '需求描述：' + desc,
    '目标版本：' + (req.target_version || ''),
    '\n【代码证据】（已含 grep 命中与真实文件片段，片段中有完整类/方法/枚举定义）\n' + ev.text,
    '\n【硬约束】1) 只输出上面 3 个章节；不要数据库字段设计；不要完整复述需求文档。2) 改动点优先引用【代码证据】中真实读到的文件路径、类名、方法名、枚举值——证据里有的必须用上；仅当证据确实没有时才标「未找到」，禁止把证据里已有的内容说成未找到。',
    '\n【按此结构输出 Markdown】\n' + outReq,
  ].join('\n');
  // ---- 3. traecli 纯 LLM 生成 ----
  const reqBody = {
    body: { messages: [{ role: 'user', content: prompt }] },
    trae_token: apiKey || '',
    provider_type: 'trae-cli',
  };
  const data = await requestOnce(reqBody, 120000);
  let raw = data?.choices?.[0]?.message?.content || '';
  if (!raw) return null;
  raw = raw.replace(/^```(markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (raw.length < 200) return null;
  return { content: raw, model: data.model || 'trae-cli', meta: { status: 'OK', structured_level: 'agent', code_basis: ev.text.slice(0, 1500), code_files_used: ev.filesUsed } };
}

/** EVALUATE 节点：自读代码 + traecli 纯 LLM 输出 JSON（避免 traecli agent mode 输出 session dump）
 * 关键：prompt 不能含"工具/查代码"暗示
 */
async function generateEvaluateDirect(provider, req, extra, repos) {
  const apiKey = resolveApiKey(provider);
  if (!repos || repos.length === 0) return null;
  const desc = String(req.description || '').replace(/<[^>]+>/g, ' ').slice(0, 200);
  // ---- 1. 收集证据：LLM 规划搜索词 → grep → 命中窗口读真实代码 ----
  const ev = await collectEvidence(apiKey, req, repos, { focus: 'evaluate', fallbackKeywords: extractFallbackKeywords(req) });
  // ---- 2. traecli 纯 LLM 输出 JSON ----
  const sys = '你是需求评审专家，输出结构化 JSON。不要调用任何工具。';
  const schema = '{"level":"L1|L2|L3|L4|L5","rationality":{"verdict":"FEASIBLE|NEEDS_ATTENTION","reason":"业务语言描述，不暴露类名/方法名/字段名","existing_capability":"现有能力简述"},"attention_points":["需 CSM/产品决策的风险"],"effort":{"min_days":数字,"max_days":数字},"risks":["风险"],"suggested_test_focus":["测试要点"]}';
  const prompt = [
    sys,
    '\n需求标题：' + (req.title || ''),
    '需求描述：' + desc,
    '目标版本：' + (req.target_version || ''),
    '\n【代码证据】（已含 grep 命中与真实文件片段）\n' + ev.text,
    '\n【硬约束】1) 用业务语言描述，不暴露类名/方法名/字段名/异常名。2) 改动等级参考：L1 微小(0.5-1天) / L2 小(1-3天) / L3 中(3-7天) / L4 较大(7-15天) / L5 重大(15-30天)。3) 仅输出 JSON。',
    '\n【输出 JSON Schema】\n' + schema,
  ].join('\n');
  const reqBody = {
    body: { messages: [{ role: 'user', content: prompt }] },
    trae_token: apiKey || '',
    provider_type: 'trae-cli',
  };
  const data = await requestOnce(reqBody, 120000);
  let raw = data?.choices?.[0]?.message?.content || '';
  if (!raw) return null;
  raw = raw.replace(/^```(json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last < 0) return null;
  const json = raw.slice(first, last + 1);
  let candidate;
  try { candidate = JSON.parse(json); } catch { return null; }
  if (candidate.rationality && candidate.rationality.existing_capability) {
    candidate.rationality.existing_capability = String(candidate.rationality.existing_capability).slice(0, 200);
  }
  // 走正常 parseAndValidate：归一化（verdict 兼容 + 缺字段补默认）
  const validated = parseAndValidate('EVALUATE', JSON.stringify(candidate));
  if (!validated) return null;
  return { content: validated, model: data.model || 'trae-cli', meta: { status: 'OK', structured_level: 'self_read', code_basis: ev.text.slice(0, 1000), code_files_used: ev.filesUsed } };
}

/** 解析 LLM 输出：{tool,args} | {answer} | {malformed} | null */
function parseAction(text) {
  const trimmed = String(text || '').trim();
  // 自然语言"调用 xxx"= 想调工具但没写 JSON → malformed
  if (/^(调用|list_tree|list_dir|read_file|grep|glob|semantic_search|LS|Glob|Read|Grep|SemanticSearch|Bash)\s*[\(\s]/.test(trimmed)) return { malformed: true, raw: trimmed };
  const block = extractJsonBlock(trimmed) || (() => { try { return JSON.parse(trimmed); } catch { return null; } })();
  if (block && typeof block === 'object') {
    if (typeof block.answer !== 'undefined') return { answer: typeof block.answer === 'string' ? block.answer : JSON.stringify(block.answer) };
    if (typeof block.tool === 'string' && block.tool.trim()) return { tool: block.tool.trim(), args: block.args || {} };
  }
  // traecli 常一次返回多行 JSON（多个工具调用）→ 按行尝试，取第一个合法 JSON
  for (const line of trimmed.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object') {
        if (typeof obj.answer !== 'undefined') return { answer: typeof obj.answer === 'string' ? obj.answer : JSON.stringify(obj.answer) };
        if (typeof obj.tool === 'string' && obj.tool.trim()) return { tool: obj.tool.trim(), args: obj.args || {} };
      }
    } catch { /* 跳过非 JSON 行 */ }
  }
  // 兜底：纯文本视为 answer 候选（schema 校验会再判）
  if (trimmed && trimmed.length > 2) return { answer: trimmed };
  return null;
}

/**
 * 用 Agent 循环执行一个 AI 节点（带工具查证 + schema 强约束产物）
 * @param {object} opts
 * @param {string} opts.action       节点动作（EVALUATE/PRD_GEN/DEV_PROMPT/TEST_CASE/PRECHECK）
 * @param {object} opts.req          需求对象
 * @param {object} opts.extra         节点额外参数（如 PRD_GEN 传 evaluation）
 * @param {object} opts.sys           基础 system prompt（来自 buildSystemPrompt）
 * @param {string} opts.usr           初始 user payload（来自 ai.js 拼接的 requirement 上下文）
 * @param {Array}  opts.repos         仓库上下文（buildRepoContexts 产物，可为空）
 * @returns {Promise<{content: object, model: string, meta: object} | null>}
 *   返回 null 表示 Agent 失败（让 ai.js 走 buildMock 兜底）
 */
async function runAiNodeWithAgent({ action: outerAction, req, extra, sys, usr, repos }) {
  const provider = activeProvider();
  if (!provider || provider.type === 'mock') return null;
  const apiKey = resolveApiKey(provider);
  // trae-cli 走本地进程，无 key 也可用（本机登录态）；其他类型必须有 key
  if (!apiKey && provider.type !== 'trae-cli') return null;

  // DEV_PROMPT 节点走自驱动 Agent 循环（真读代码）：每步精简 prompt 避免 traecli agent mode 输出 session dump
  if (outerAction === 'DEV_PROMPT' && provider.type === 'trae-cli') {
    return await generateDevPromptDirect(provider, req, extra, repos);
  }
  if (outerAction === 'EVALUATE' && provider.type === 'trae-cli') {
    return await generateEvaluateDirect(provider, req, extra, repos);
  }

  const system = buildActionSystemPrompt(sys, outerAction);
  const messages = [{ role: 'user', content: usr }];
  const t0 = Date.now();
  // trae-cli 单次调用慢（本地进程含登录 token 交换 + 推理），单步/整体超时都放宽
  const totalBudget = provider.type === 'trae-cli' ? 300000 : TOTAL_TIMEOUT_MS;
  const stepTimeout = provider.type === 'trae-cli' ? TRAE_STEP_TIMEOUT_MS : STEP_TIMEOUT_MS;

  for (let step = 1; step <= AGENT_MAX_STEPS; step += 1) {
    if (Date.now() - t0 > totalBudget) {
      logger.warn('agent_total_timeout', { action: outerAction, req: req.id, ms: Date.now() - t0 });
      return null;
    }
    // 倒数第二步强制提示 LLM 出最终答案（避免 LLM 把 4 步全用完在调工具）
    if (step === AGENT_MAX_STEPS) {
      messages.push({ role: 'user', content: `【硬约束】第 ${AGENT_MAX_STEPS} 步是最后一步，必须输出最终答案，格式 {"answer": <符合 schema 的 JSON 对象>}。不要再调工具。` });
    }
    let raw;
    try { raw = await stepCall(provider, apiKey, system, messages.map((m) => m.content).join('\n\n'), stepTimeout); }
    catch (e) {
      // 单步失败（如 Kimi 慢 / 超时）直接 return null → 立即走 fallback，不浪费后续步数
      // 用户要的是「快速失败」，不是「等 60s 全部步数耗尽再兜底」
      logger.warn('agent_step_failed', { step, reason: e.message });
      return null;
    }
    // 调试：每步打印 LLM 原始输出，用于排查 AI 一直走兜底的根因
    logger.warn('agent_step_raw', { step, rawLen: String(raw).length, raw: String(raw).slice(0, 400) });
    const action = parseAction(raw);
    if (action && action.malformed) {
      messages.push({ role: 'user', content: `你的输出 "${action.raw.slice(0, 120)}" 不是 JSON 动作。工具调用必须严格写成 {"tool":"工具名","args":{...}}。` });
      continue;
    }
    if (!action) {
      messages.push({ role: 'user', content: `[解析失败] 你的输出不是合法 JSON：${String(raw).slice(0, 200)}` });
      continue;
    }
    if (action.answer !== undefined) {
      // 修复：第一个参数是外层 action 类型（函数参数 "EVALUATE" 等），不是 local action 对象的 answer 字段。
      // 之前的 parseAndValidate(action.answer, action.answer) 会让 shapeFor 找不到 enum 而 fallback 'text'，
      // 把 raw 思考文本（不是合法 JSON 形状）当成 text shape 合法产物落库 → EVALUATION content 变成英文 raw text 的 bug。
      // 这里的 action（line 145 shadow）已被 inner parseAction 结果覆盖，但 parseAndValidate 需要原始 action 类型，
      // 我们把外层 function 参数 `action` 重命名为 `outerAction` 避免 shadow。
      const content = parseAndValidate(outerAction, action.answer);
      if (content != null) {
        const codeBasis = null; // Agent 模式不写 code_basis（产物不强依赖 withCodeContext 注入）
        return {
          content,
          model: provider.model,
          meta: {
            provider_id: provider.id,
            provider_type: provider.type,
            model: provider.model,
            structured_level: 'agent',
            status: 'OK',
            degraded_reason: null,
            latency_ms: Date.now() - t0,
            attempt: step,
            is_mock: false,
            code_basis: codeBasis,
            code_files_used: [],
            agent_steps: step,
          },
        };
      }
      // 解析/校验失败：把原始 answer 当观测回填，让 LLM 调整后再答
      messages.push({ role: 'user', content: `[产物未通过 schema 校验] 你的 answer 不是合法的 ${action} JSON。请重新读工具或调整后输出 {"answer": <正确 JSON>}。` });
      continue;
    }
    // tool 调用
    if (!repos || !repos.length) {
      messages.push({ role: 'user', content: `[观测] 没有已同步的代码仓库快照，无法读代码。请直接给最终答案（基于通用知识，但请降低置信度或标注「未查证」）。` });
      continue;
    }
    const obs = await executeTool(repos, action.tool, action.args);
    messages.push({ role: 'assistant', content: `调用 ${action.tool}(${JSON.stringify(action.args)})` });
    messages.push({ role: 'user', content: `[观测]\n${obs}` });
    if (obs.includes('[未知工具]')) {
      messages.push({ role: 'user', content: '请使用列出的可用工具名。' });
    }
  }

  logger.warn('agent_steps_exhausted', { action: outerAction, req: req.id, ms: Date.now() - t0 });
  return null; // 步数耗尽：让 ai.js 走 buildMock 兜底
}

module.exports = { runAiNodeWithAgent, buildRepoContexts, generateDevPromptDirect, generateEvaluateDirect };