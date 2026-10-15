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
    return `产物形状：{"summary":string,"scheduling":{"status":"FAST_TRACK"|"READY"|"NEEDS_CONFIRMATION"|"HOLD","advice":string},"level":"L1"|"L2"|"L3"|"L4","effort":{"min_days":number,"max_days":number},"rationality":{"verdict":"FEASIBLE"|"NEEDS_ATTENTION","reason":string},"attention_points":string[],"questions":string[],"confidence":number(0-1)}`;
  }
  if (action === 'PRD_GEN') {
    return `产物形状：{"goal":string, "background":string, "user_stories":string[], "acceptance_criteria":string[], "non_goals":string[], "open_questions":string[]}`;
  }
  if (action === 'DEV_PROMPT') {
    return `产物形状：{"summary":string, "steps":[{"step":number,"action":string,"detail":string,"files_to_touch":string[],"verify":string}], "env":{}, "risks":string[]}`;
  }
  if (action === 'TEST_CASE') {
    return `产物形状：[{"id":number,"type":"正常流"|"边界流"|"异常流","title":string(≤20字),"steps":string(编号短句最多3步),"expect":string(一句话预期),"result":""}]；共 5-10 条，只输出 JSON 数组。`;
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
  if (!o.summary) o.summary = o.rationality?.reason || '请结合需求范围与验收标准判断是否可以安排。';
  if (!o.scheduling) o.scheduling = {
    status: o.rationality?.verdict === 'NEEDS_ATTENTION' ? 'NEEDS_CONFIRMATION' : 'READY',
    advice: o.rationality?.verdict === 'NEEDS_ATTENTION' ? '建议先确认关注项，再进入排期。' : '可按当前优先级进入常规排期。',
  };
  if (o.impact_scope === undefined) o.impact_scope = [];
  if (o.risks === undefined) o.risks = [];
  if (o.suggested_test_focus === undefined) o.suggested_test_focus = [];
  if (o.perspectives === undefined) o.perspectives = { customer: '', product: '', engineering: '' };
  if (o.attention_points === undefined) o.attention_points = [];
  else if (Array.isArray(o.attention_points)) o.attention_points = o.attention_points.slice(0, 6);
  // 阻断性问题：模型未给时视为无阻断（不阻塞流程）；给出时最多 3 条，避免一次挂起太多问题。
  if (!Array.isArray(o.questions)) o.questions = [];
  else o.questions = o.questions.filter((q) => typeof q === 'string' && q.trim()).slice(0, 3);
  // confidence 仅作为是否达到 85% 通过线的依据，不能用固定分数冒充模型自评。
  return o;
}

/** 构造 Agent system prompt：可用工具 + 产物 schema + "无证据不得断言" 硬约束 */
function buildActionSystemPrompt(baseSys, action) {
  const toolDesc = describeTools();
  const schemaHint = schemaHintForShape(action);
  // 角色定位：EVALUATE=需求评审专家（不暴露技术类名/方法名/字段名/异常名）；DEV_PROMPT=技术实现专家
  const roleLine = action === 'EVALUATE'
    ? '你是【需求评审专家】，对接 CSM 和产品。严格按“模板 A”评估：先用 1-2 句总结需求的问题与结论，再给可否快速排期、改动等级、预估人日、需求是否合理；最后只列 0-6 条真正需要关注的业务事项。若缺少推进评估所必需的信息（需求对象/范围/验收标准等不清），把要需求发起人补充的问题写进 questions（非空会挂起评估节点等其补充后重跑）；信息足够时 questions 必须为空数组，禁止为凑数提问；confidence 低于 0.85 时必须明确列出至少一个阻断性问题，不能因自评分数接近阈值而省略。需求描述中「【已澄清结论·视为既定事实】」的问答已由发起人确认，直接采信、不得重复提问，也不得与其冲突。同时自评 confidence（0-1）：信息完整、结论确定时给高分，≥0.85 表示信息已足够、questions 必须为空数组。产物只用业务语言，不出现类名、接口、文件路径、数据库、性能参数或任何技术实现细节。技术细节留给 AI 追问和研发阶段。'
    : action === 'DEV_PROMPT'
      ? '你是【技术实现专家】，给研发产出可执行的开发提示词（Markdown）。【必须基于真实代码】先查证再输出：所有改动点必须引用你实际用工具读到的文件路径与行号。**禁止凭常见模式编造**——仓库里没有的类/接口/表，一律标「未找到」，不许编造名字。'
      : '你是【业务专家】，给出该环节的结构化结论。';
  // DEV_PROMPT/PRD_GEN 也走 Agent 协议（必须真读代码），只是产物 shape 是 Markdown 文本
  const head = '\n\n【Agent 工具协议 · 强制】\n你必须先用工具查代码，再产出。**禁止靠推测、禁止编造**：所有结论必须引用具体文件路径与行号；仓库里没有的东西必须标「未找到」，禁止编造类名/接口名/表名。\n可用工具：\n';
  const middle = '\n\n【产物 schema 硬约束】\n';
  // DEV_PROMPT 产物是 Markdown 文本（shape=text），但要按结构输出；EVALUATE 等走 JSON
  const tail = action === 'DEV_PROMPT'
    ? '\n\n【输出协议】\n- 调工具：{"tool":"工具名","args":{...}}\n- 查证充分后输出最终答案：{"answer": "<Markdown 文本>"}\n\n【规则】\n1. 先 list_tree 了解仓库结构，再 grep/read_file 查证具体代码；**没有通过工具读到代码之前**禁止输出 answer。\n2. **每次工具调用只输出一个 JSON**；不要写围栏外文字。\n3. **产物必须全部基于工具读到的真实代码**：每个改动点都要写实际文件路径（如 usercenter-core/src/main/java/com/xxx/...），标注行号；读不到就写「未找到（需人工确认）」。\n4. 禁止出现仓库里不存在的类名/接口名/表名（如未读到的 GradeController 就是编造，禁止写）。\n5. 最终 Markdown 必须包含以下章节（按用户要求）：\n   ## 需求描述（完整复述原始需求 + PRD 关键内容）\n   ## 是否需要前端开发（先判断，明确写「是/否」+ 理由）\n   ## 是否需要新增接口（基于已读代码判断：现有接口能否覆盖，若需新增列出方法与参数）\n   ## 是否需要新增数据库表（基于已读实体/表结构判断；如新增，给出字段设计：字段名/类型/注释/索引）\n   ## 前端改动点（页面/组件/API 调用，写实际文件路径；不需要前端时写「本次无需前端开发」）\n   ## 后端改动点（Controller/Service/DAO，写实际文件路径与改动内容）\n   ## 是否关联其他模块（基于 grep 到的引用判断：是否影响薪资/组织/权限等，写明依赖关系）\n   ## 实现步骤与验证建议\n'
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
  const sys = '你是 10 年经验研发负责人，输出一份可直接复制给研发 AI 的执行提示词。必须先透析问题、验证根因，再设计方案；禁止一开始罗列接口、文件或“未找到”。只输出指定 Markdown 章节，不要解释生成过程，不要调用工具。';
  const outReq = [
    '# 研发 AI 执行提示词 — {需求标题}',
    '',
    '## 一、任务目标',
    '用 2-3 句写清用户场景、问题现象与完成标准。直接对研发 AI 说“请实现…”，不要复述需求全文。',
    '',
    '## 二、问题判断与查证结论',
    '先围绕真实证据回答：1) 是否存在全量读取/全量展示；2) 是否已有分页能力但未使用；3) 搜索、勾选、保存后刷新哪一步导致卡顿；4) 根因结论。每项必须标“已证实 / 未证实”，只写与问题直接相关的真实文件、函数或接口；没有证据时只留 1 条精准待确认项，不要堆“未找到”。',
    '',
    '## 三、推荐方案',
    '基于查证结论给出唯一优先方案。若确认无分页，说明如何新增分页；若已有分页，说明如何接入；若根因不是分页，明确给出替代方案。必须说明搜索、跨页勾选、提交成功后的列表刷新如何处理，避免只解决首次打开。不要在本章枚举无关接口。',
    '',
    '## 四、前端改动点与影响',
    '先明确是否需要前端开发。仅列解决根因所需的页面、组件、状态和请求改动；每条使用“真实相对路径：改什么、为什么、影响什么交互”。只在方案确实需要时说明接口入参与返回消费，禁止罗列无关接口。',
    '',
    '## 五、后端改动点与影响',
    '先说明是否需要后端改动。仅列直接支撑方案的查询、接口、业务逻辑；每条使用“真实相对路径：改什么、分页/查询/兼容策略、被哪些调用方影响”。只有确需新增或调整接口时才写接口，不要罗列 Controller/Service/DAO 清单。',
    '',
    '## 六、跨业务影响与兼容性',
    '查证同一成员选择、组织树或列表接口是否被其他业务复用。明确“会影响哪些场景 / 未发现其他复用 / 仍需确认什么”。说明旧调用方、权限、已有选中成员回显、搜索和保存语义如何保持兼容。',
    '',
    '## 七、实施步骤与验收',
    '给 3-6 个按顺序的实施步骤，以及可验证验收项。至少覆盖：大数据量、搜索、翻页或滚动、跨页勾选、保存、已有成员回显、其他复用场景回归。',
  ].join('\n');
  const prompt = [
    sys,
    '\n需求标题：' + (req.title || ''),
    '需求描述：' + desc,
    '目标版本：' + (req.target_version || ''),
    '\n【代码证据】（已含 grep 命中与真实文件片段，片段中有完整类/方法/枚举定义）\n' + ev.text,
    '\n【模板 A 硬约束】1) 必须按“问题判断与查证结论 → 推荐方案 → 前后端改动 → 跨业务影响 → 实施验收”的顺序输出，不能颠倒。2) 先验证全量加载与分页，不得把“员工数量过多”当作既定事实；没有证据只能写待确认。3) 仅列直接服务于推荐方案的接口和文件，禁止为了显得全面罗列 Controller/Service/DAO 或无关文件。4) 每个改动和影响必须来自【代码证据】；路径用相对路径，不暴露 /Users 绝对路径。5) 若证据不够，写一条最小待确认项后给出条件化方案，不得堆大量“未找到”。6) 最终内容直接给研发 AI 执行，不要出现“作为 AI”“建议研发自行排查”等空话。7) 【按需求规模裁剪】小需求（改动集中、单端）只保留「问题判断与查证结论 / 改动点 / 实施与验收」三章，不适用章节直接省略，全文 300-800 字；前端或后端无改动时一句话写「本次无需前端/后端改动」即可，不要展开。中大需求才输出完整七章，禁止为凑章节扩写。',
    '\n【按此结构输出 Markdown】\n' + outReq,
  ].join('\n');
  // ---- 3. traecli 纯 LLM 生成 ----
  const reqBody = {
    body: { messages: [{ role: 'user', content: prompt }], model: provider.model },
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
  // 澄清结论是追加在描述末尾的区块，早先这里只截 200 字符，等于把「已澄清结论」整块砍掉，
  // 模型看不到已确认口径就会把同一问题反复重问（156/157/158 的第 2、3 轮重复提问即由此产生）。
  const desc = String(req.description || '').replace(/<[^>]+>/g, ' ');
  // ---- 1. 收集证据：LLM 规划搜索词 → grep → 命中窗口读真实代码 ----
  const ev = await collectEvidence(apiKey, req, repos, { focus: 'evaluate', fallbackKeywords: extractFallbackKeywords(req) });
  // ---- 2. traecli 纯 LLM 输出 JSON ----
  const sys = '你是需求评审专家，输出结构化 JSON。不要调用任何工具。';
  const schema = '{"summary":"1-2句总结，说明问题和结论","scheduling":{"status":"FAST_TRACK|READY|NEEDS_CONFIRMATION|HOLD","advice":"一句排期建议"},"level":"L1|L2|L3|L4","effort":{"min_days":数字,"max_days":数字},"rationality":{"verdict":"FEASIBLE|NEEDS_ATTENTION","reason":"需求是否合理的业务说明"},"attention_points":["0-6条需关注事项"],"questions":["0-3条阻断性澄清问题，信息足够时必须为[]"],"confidence":0到1的小数}';
  const prompt = [
    sys,
    '\n需求标题：' + (req.title || ''),
    '需求描述：' + desc.slice(0, 4000),
    '目标版本：' + (req.target_version || ''),
    '\n【代码证据】（已含 grep 命中与真实文件片段）\n' + ev.text,
    '\n【模板 A 硬约束】1) 只输出：总结、排期建议、改动等级、预估人日、需求是否合理、需要关注、阻断性问题、置信度；不得输出客户/产品视角、测试重点、代码路径、接口、字段、数据库、技术方案。2) 总结必须让需求提出人一眼知道问题在哪、是否可排期。3) attention_points 最多 6 条；没有则 []，禁止为了凑数编造。4) questions 只在缺少推进评估所必需的信息（如需求对象/范围/验收标准不清）时填写，0-3 条、每条一个明确的补充问题；信息足够时必须为 []，禁止为凑数提问。5) 描述中「【已澄清结论·视为既定事实】」的问答已由需求发起人确认，直接采信：不得再问一遍，也不得与该结论冲突。6) 同时自评 confidence（0-1，本次评估结论的把握程度）：信息完整、结论确定时给高分；≥0.85 表示信息已足够，此时 questions 必须为 []。7) 用业务语言描述。8) 改动等级参考：L1 微小(0.5-1天) / L2 小(1-3天) / L3 中(3-7天) / L4 较大(7-15天)。9) 仅输出 JSON。',
    '\n【输出 JSON Schema】\n' + schema,
    // 节点提示词（管理员后台可改）必须进这条直连路径，否则节点上配的评审规则对 EVALUATE 完全失效
    (extra && extra.custom_prompt ? '\n【该节点的额外要求】\n' + extra.custom_prompt : ''),
  ].join('\n');
  const reqBody = {
    body: { messages: [{ role: 'user', content: prompt }], model: provider.model },
    trae_token: apiKey || '',
    provider_type: 'trae-cli',
  };
  const data = await requestOnce(reqBody, 120000);
  let raw = data?.choices?.[0]?.message?.content || '';
  if (!raw) {
    logger.warn('evaluate_direct_empty', { req: req.id, parse_failed: !!(data && data._parse_failed) });
    return null;
  }
  raw = raw.trim();
  const candidate = extractJsonBlock(raw);
  if (!candidate) {
    logger.warn('evaluate_direct_parse_fail', {
      req: req.id,
      raw_len: raw.length,
      raw: raw.slice(0, 300),
    });
    return null;
  }
  if (candidate.rationality && candidate.rationality.existing_capability) {
    candidate.rationality.existing_capability = String(candidate.rationality.existing_capability).slice(0, 200);
  }
  // prompt-only 模型可能漏传自评分。复用本轮需求、证据和评估，仅补评一次，不重新查代码。
  const confidenceSchema = schemaFor('EVALUATE').shape.confidence;
  if (!confidenceSchema.safeParse(candidate.confidence).success) {
    logger.warn('evaluate_confidence_missing_or_invalid', { req: req.id, value_type: typeof candidate.confidence });
    try {
      const supplement = await requestOnce({
        ...reqBody,
        body: {
          ...reqBody.body,
          messages: [{ role: 'user', content: [
            prompt,
            '\n【本轮评估结果】\n' + JSON.stringify(candidate),
            '\n【补充自评】本轮结果缺少合法的 confidence。请根据上述需求、已澄清结论、代码证据与本轮评估，自评结论的把握程度。',
            '只输出 {"confidence":0到1的小数}，必须是 JSON number，不得输出字符串、百分号或 null。不能仅按 questions 是否为空给固定分数；仍有阻断性问题时必须低于 0.85。',
          ].join('\n') }],
        },
      }, STEP_TIMEOUT_MS);
      const answer = extractJsonBlock(extractContent(provider.type, supplement));
      const confidence = confidenceSchema.safeParse(answer?.confidence);
      if (!confidence.success) {
        logger.warn('evaluate_confidence_repair_invalid', { req: req.id });
        return null;
      }
      candidate.confidence = confidence.data;
      logger.info('evaluate_confidence_recovered', { req: req.id, confidence: confidence.data });
    } catch (error) {
      logger.warn('evaluate_confidence_repair_failed', { req: req.id, reason: error.message });
      return null;
    }
  }
  // 走正常 parseAndValidate：归一化（verdict 兼容 + 缺字段补默认）
  const validated = parseAndValidate('EVALUATE', JSON.stringify(candidate));
  if (!validated) {
    logger.warn('evaluate_direct_schema_fail', { req: req.id, keys: Object.keys(candidate || {}).join(','), candidate: JSON.stringify(candidate).slice(0, 400) });
    return null;
  }
  return { content: validated, model: data.model || 'trae-cli', meta: { status: 'OK', structured_level: 'self_read', code_basis: ev.text.slice(0, 1000), code_files_used: ev.filesUsed } };
}

/** PRD 节点：产品文档不需要 Agent 查代码，直接基于需求与评估结果生成可粘贴到飞书的 Markdown。 */
async function generatePrdDirect(provider, req, extra) {
  const apiKey = resolveApiKey(provider);
  const evaluation = extra && extra.evaluation ? JSON.stringify(extra.evaluation, null, 2) : '暂无 AI 评估结果，请基于原始需求谨慎补齐待确认项。';
  const prompt = [
    '你是产品经理，请站在产品视角为以下需求起草一页纸 PRD。',
    '只输出可直接复制到飞书的 Markdown 正文，不要输出 JSON、代码围栏、解释性前言或生成过程。',
    '必须精准、简短、切中问题；只允许出现下面 6 个二级标题，禁止新增用户故事、接口设计、非功能要求、待确认问题等章节。',
    '【按需求规模控制篇幅】小需求（单点改动、描述清晰）全文 300-600 字，每章节 1-3 条即可；中大需求最多 800-1200 字。需求越简单，文档越短。',
    '每个标题下只写有需求依据的内容；该章节没有内容就写「无」，禁止为凑字数扩写、禁止复述需求全文、禁止编造业务背景。',
    '信息不足时在对应章节写“待确认：...”，禁止臆造客户承诺或技术实现。',
    '',
    '# PRD — ' + (req.title || '未命名需求'),
    '',
    '## 1. 背景',
    '说明当前现状、核心问题、触发原因和受影响的客户/用户，最多 3 条。',
    '',
    '## 2. 目标',
    '说明本次要解决什么问题和预期结果，最多 3 条。',
    '',
    '## 3. 业务流程',
    '只描述实现该目标的主流程，使用 3-6 个编号步骤；没有依据的细节不要补充。',
    '',
    '## 4. 影响范围与风险',
    '列出受影响的业务模块/角色，并明确“风险：无”或最多 3 条具体风险及应对。',
    '',
    '## 5. 验收标准',
    '使用 3-6 条可执行、可验证的复选框，不写空泛表述。',
    '',
    '## 6. 排期版本',
    '写目标版本、建议排期和前置条件；目标版本未知时写“待定”。',
    '',
    '【供模型参考的原始信息】',
    '需求标题：' + (req.title || ''),
    '需求描述：' + String(req.description || '').replace(/<[^>]+>/g, ' ').trim(),
    '客户：' + (req.customer_name || '未填写'),
    '目标版本：' + (req.target_version || '待定'),
    'AI 评估结果：' + evaluation,
  ].join('\n');
  const data = await requestOnce({
    body: { messages: [{ role: 'user', content: prompt }], model: provider.model },
    trae_token: apiKey || '',
    provider_type: 'trae-cli',
  }, 120000);
  let raw = data?.choices?.[0]?.message?.content || '';
  raw = String(raw).replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (raw.length < 200) {
    logger.warn('prd_direct_empty', { req: req.id, raw_len: raw.length });
    return null;
  }
  return {
    content: raw,
    model: data.model || 'trae-cli',
    meta: { status: 'OK', structured_level: 'direct', code_basis: null, code_files_used: [] },
  };
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
  const provider = await activeProvider();
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
  if (outerAction === 'PRD_GEN' && provider.type === 'trae-cli') {
    return await generatePrdDirect(provider, req, extra);
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
      messages.push({ role: 'user', content: `[产物未通过 schema 校验] 你的 answer 不是合法的 ${outerAction} JSON。${outerAction === 'EVALUATE' ? '必须包含模型自评 confidence，值为 0-1 的数字，不能省略或使用字符串。' : ''}请调整后输出 {"answer": <正确 JSON>}。` });
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

module.exports = { runAiNodeWithAgent, buildRepoContexts, generateDevPromptDirect, generateEvaluateDirect, generatePrdDirect };
