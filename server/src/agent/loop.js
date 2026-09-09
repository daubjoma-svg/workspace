// Agent 循环（ReAct：Reason → Act → Observation），借鉴 deepseek-harness 的设计思想：
//  - LLM 每步输出 JSON 动作（调工具 或 给最终回答），后端执行工具后把观测回填，循环直到 final
//  - 预算控制：maxSteps 上限；超步数时把已收集的观测交给 LLM 强制总结
//  - 复用现有 LLM 传输层（llm/provider + llm-call），与 runAI/aiChat 同一套 Provider/Key/超时/降级
//  - 工具执行失败不中断循环：失败原因作为观测回填，LLM 自己修正下一步

'use strict';

const logger = require('../logger');
const { activeProvider, resolveApiKey } = require('../llm/provider');
const { buildRequest, requestOnce, extractContent, extractJsonBlock } = require('../llm-call');
const { describeTools, executeTool } = require('./tools');

const DEFAULT_MAX_STEPS = 10;
const STEP_TIMEOUT_MS = 60000;      // 单步 LLM 调用超时
const FINAL_TIMEOUT_MS = 90000;     // 总结步超时（观测多时生成慢）

/** 从 LLM 原始输出解析动作：{tool,args} | {answer}；解析失败返回 null；输出"想调工具但没写 JSON"返回 {malformed:true} */
function parseAction(text) {
  const block = extractJsonBlock(text) || (() => {
    try { return JSON.parse(text.trim()); } catch { return null; }
  })();
  if (!block || typeof block !== 'object') {
    // 纯文本"调用 xxx(...)"= 想调工具但没按 JSON 输出 → 标记 malformed，让循环提示重写
    const t = String(text || '').trim();
    if (/^(调用|list_tree|list_dir|read_file|grep|glob|semantic_search)\s*[\(\s]/.test(t)) return { malformed: true, raw: t };
    // 其它纯文本视为最终回答（兜底）
    if (t && t.length > 2) return { answer: t.slice(0, 3000) };
    return null;
  }
  if (typeof block.answer === 'string' && block.answer.trim()) return { answer: block.answer.trim() };
  if (typeof block.tool === 'string' && block.tool.trim()) return { tool: block.tool.trim(), args: block.args || {} };
  const plain = String(text || '').trim();
  if (plain && plain.length > 2 && !plain.startsWith('{')) return { answer: plain.slice(0, 3000) };
  return null;
}

function buildSystemPrompt(sys, toolDesc) {
  return `${sys}

【Agent 工具协议】
你可以调用以下工具自主查询代码（这就是你的"手脚"），多步探索后再给出最终回答：
${toolDesc}

输出格式（严格 JSON，一次一个动作）：
- 调用工具：{"tool":"工具名","args":{"参数名":"值"}}
- 给出最终回答：{"answer":"你的回答"}
示例：
{"tool":"list_tree","args":{}}
{"tool":"grep","args":{"pattern":"JobLevel","path":"src/main/java"}}
{"tool":"semantic_search","args":{"query":"员工在职状态枚举"}}
{"tool":"read_file","args":{"path":"src/main/java/com/xx/JobLevelService.java"}}
{"answer":"职级相关的代码位于……"}
规则：
1. 每步只能输出一个 JSON 动作，不要解释、不要围栏外的文字、不要写"调用 xxx"这类自然语言。
2. 先 list_tree 了解仓库结构，再 semantic_search/grep/read_file/glob 深入。semantic_search 支持中文自然语言搜索（推荐首选），grep 用于精确类名/方法名匹配。
3. 只有信息足够时才输出 {"answer":...}；信息不足就继续调工具。
4. 所有回答用中文，引用具体文件路径与行号作为依据。`;
}

/** 单步 LLM 调用：prompt_only 非结构化，返回模型回复文本；失败返回 null */
async function callOnce(provider, apiKey, messages, sys, timeoutMs) {
  const userPayload = messages
    .map((m) => (m.role === 'user' ? m.content : `[${m.role === 'assistant' ? 'assistant' : 'observation'}]\n${m.content}`))
    .join('\n\n');
  const reqBody = buildRequest(provider, apiKey, sys, userPayload, 'AGENT', 'prompt_only');
  const data = await requestOnce(reqBody, timeoutMs);
  return extractContent(provider.type, data);
}

/**
 * 运行 Agent 循环。
 * @param {object} opts
 * @param {string} opts.sys        system prompt（场景描述 + 要求）
 * @param {string} opts.user       初始用户消息（需求上下文 + 问题）
 * @param {Array}  opts.repos      仓库上下文（buildRepoContexts 产物）
 * @param {number} [opts.maxSteps] 最大探索步数（预算）
 * @returns {Promise<{answer:string, steps:number, used_tools:string[]}>}
 */
async function runAgent({ sys, user, repos, maxSteps = DEFAULT_MAX_STEPS }) {
  const provider = activeProvider();
  const apiKey = provider && provider.type !== 'mock' ? resolveApiKey(provider) : null;
  // trae-cli 走本地进程（本机登录态），无需 API key；其他类型必须有 key
  if (!provider || provider.type === 'mock') {
    return { answer: '（当前未配置可用的 AI 模型，Agent 无法运行）可在「AI 配置」页启用模型后重试。', steps: 0, used_tools: [] };
  }
  if (provider.type !== 'trae-cli' && !apiKey) {
    return { answer: '（当前未配置可用的 AI 模型，Agent 无法运行）可在「AI 配置」页启用模型后重试。', steps: 0, used_tools: [] };
  }

  const toolDesc = describeTools();
  const system = buildSystemPrompt(sys, toolDesc);
  const messages = [{ role: 'user', content: user }];
  const usedTools = [];
  let steps = 0;

  for (; steps < maxSteps; steps += 1) {
    let raw;
    try { raw = await callOnce(provider, apiKey, messages, system, STEP_TIMEOUT_MS); }
    catch (e) {
      logger.warn('agent_step_failed', { reason: e.message, step: steps + 1 });
      // 单步失败：把错误作为观测，允许 LLM 换工具重试（最多再试 1 次）
      messages.push({ role: 'user', content: `[工具调用失败] ${e.message}\n请换一个工具或直接给出最终回答。` });
      continue;
    }
    const action = parseAction(raw);
    if (action && action.malformed) {
      messages.push({ role: 'user', content: `你的输出 "${action.raw.slice(0, 120)}" 不是 JSON 动作。工具调用必须严格写成 {"tool":"工具名","args":{...}}，不要用自然语言描述。` });
      continue;
    }
    if (!action) {
      messages.push({ role: 'user', content: `[解析失败] 你的输出不是合法 JSON 动作：${String(raw).slice(0, 200)}\n请只输出 {"tool":...} 或 {"answer":...} 格式的 JSON。` });
      continue;
    }
    if (action.answer) return { answer: action.answer, steps: steps + 1, used_tools: usedTools };
    usedTools.push(action.tool);
    const obs = await executeTool(repos, action.tool, action.args);
    messages.push({ role: 'assistant', content: `调用 ${action.tool}(${JSON.stringify(action.args)})` });
    messages.push({ role: 'user', content: `[观测]\n${obs}` });
    if (obs.includes('[未知工具]')) {
      // 工具名非法：不浪费步数，直接提示
      messages.push({ role: 'user', content: '请使用上面列出的可用工具名。' });
    }
    // 防重复：连续 2 次相同 (tool,args) → 强制换方向，避免 Agent 卡死
    if (usedTools.length >= 2) {
      const last = usedTools[usedTools.length - 1];
      const prev = usedTools[usedTools.length - 2];
      if (last === prev) {
        messages.push({ role: 'user', content: `你连续两次调用 ${last} 得到相同结果，请换一个角度（list_dir 看目录 / grep 换关键词 / 直接总结已有信息），不要重复同一调用。` });
      }
    }
  }

  // 预算耗尽：不重发全部历史（token 巨大且 LLM 易复述），只发最近 3 条观测 + 强制总结
  try {
    const tail = messages.slice(-6);
    const finalRaw = await callOnce(provider, apiKey, tail, system + '\n\n探索步数已达上限，请只输出最终回答：{"answer":"基于已获得观测的结论"}。', FINAL_TIMEOUT_MS);
    const action = parseAction(finalRaw);
    if (action && action.answer) return { answer: action.answer, steps, used_tools: usedTools };
    // 解析失败：把 LLM 原始输出剥掉 JSON 围栏后当回答（总比空强）
    const cleaned = String(finalRaw || '').replace(/```json|```/g, '').trim();
    return { answer: cleaned || '(Agent 未能在预算内给出结论)', steps, used_tools: usedTools };
  } catch (e) {
    return { answer: `(Agent 探索 ${steps} 步后未能给出结论：${e.message})`, steps, used_tools: usedTools };
  }
}

module.exports = { runAgent, parseAction };
