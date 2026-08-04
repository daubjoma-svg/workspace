// B1：三级结构化输出降级 + Zod 统一出口 + 超时 + 结构化日志。
// L1 json_schema（原生强约束）→ L2 json_object（弱约束，自动注入 "json" 字面量）→ L3 prompt_only（抽取 JSON 块）。
// 出口保证：返回 null（无可用 provider / 调用失败，交给 mock 降级）或 { content, model, meta }，
// 其中 content 的类型由 llm-schema.shapeFor(action) 决定，恒定不随 provider 变化。

'use strict';

const logger = require('./logger');
const { schemaFor, shapeFor, minimalFallback } = require('./llm-schema');
const { resolveCapability, levelTag } = require('./llm/capabilities');
const { jsonSchemaFor, schemaHint } = require('./llm/json-schema');
const { resolveApiKey } = require('./llm/provider');

const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 60000);
const DEFAULT_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 4096);
const JSON_LITERAL_HINT = '你必须且只能输出一个合法的 json 对象，不要包含任何解释性文字或 markdown 代码块标记。';

function timeoutFor(provider) {
  const v = Number(provider && provider.timeout_ms);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

/* ---------------- 请求组装 ---------------- */

function buildAnthropicRequest(p, apiKey, system, user, action, cap) {
  const body = {
    model: p.model || 'claude-sonnet-4-5',
    max_tokens: Number(p.max_tokens) || DEFAULT_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (cap === 'json_schema') {
    body.output_config = { format: { type: 'json_schema', schema: jsonSchemaFor(action) } };
  }
  return {
    url: `${(p.base_url || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body,
  };
}

function buildOpenAIRequest(p, apiKey, system, user, action, cap) {
  const body = {
    model: p.model || 'gpt-4o-mini',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.3,
    max_tokens: Number(p.max_tokens) || DEFAULT_MAX_TOKENS,
  };
  if (cap === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: `sop_${action.toLowerCase()}`, strict: true, schema: jsonSchemaFor(action) },
    };
  } else if (cap === 'json_object') {
    // DeepSeek / GLM / 通义：prompt 不含 "json" 字面量会直接 400，这里强制注入
    body.messages[0].content += `\n\n${JSON_LITERAL_HINT}`;
    body.response_format = { type: 'json_object' };
  }
  return {
    url: `${(p.base_url || 'https://api.openai.com').replace(/\/+$/, '')}/v1/chat/completions`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body,
  };
}

function buildRequest(p, apiKey, system, user, action, cap) {
  return p.type === 'anthropic'
    ? buildAnthropicRequest(p, apiKey, system, user, action, cap)
    : buildOpenAIRequest(p, apiKey, system, user, action, cap);
}

/* ---------------- 响应解析 ---------------- */

function extractContent(type, data) {
  if (!data) return '';
  if (type === 'anthropic') return (data.content || []).map((c) => c.text || '').join('\n');
  return data.choices?.[0]?.message?.content ?? '';
}

function extractUsage(type, data) {
  const u = data?.usage || {};
  return type === 'anthropic'
    ? { prompt_tokens: u.input_tokens ?? null, completion_tokens: u.output_tokens ?? null }
    : { prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null };
}

/** L3 抽取：先取 ```json 围栏块，再退化到首个 { 到末个 } 的平衡片段 */
function extractJsonBlock(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s >= 0 && e > s) candidates.push(text.slice(s, e + 1));
  const as = text.indexOf('[');
  const ae = text.lastIndexOf(']');
  if (as >= 0 && ae > as) candidates.push(text.slice(as, ae + 1));
  candidates.push(text);
  for (const c of candidates) {
    try {
      const v = JSON.parse(c.trim());
      if (v && typeof v === 'object') return v;
    } catch { /* 试下一个候选 */ }
  }
  return null;
}

/** 把任意形态的原始返回归一化成 schema 期望的输入形状 */
function normalizeToShape(action, parsed, raw) {
  const shape = shapeFor(action);
  if (shape === 'text') {
    if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') return parsed;
    return { text: typeof raw === 'string' ? raw : '' };
  }
  if (shape === 'array') {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.cases)) return parsed.cases;
    if (parsed && Array.isArray(parsed.test_cases)) return parsed.test_cases;
    return null;
  }
  return parsed;
}

/** 出口解包：text 型产物还原成 markdown 字符串，下游按 string 消费（前端按 markdown 渲染） */
function unwrap(action, validated) {
  return shapeFor(action) === 'text' ? validated.text : validated;
}

/** 统一 Zod 出口：校验失败不抛错，返回最小兜底对象（B1 根治核心） */
function validateOrFallback(action, candidate, raw, meta) {
  const parsed = schemaFor(action).safeParse(candidate == null ? {} : candidate);
  if (parsed.success) {
    return { content: unwrap(action, parsed.data), degraded: false };
  }
  logger.warn('llm_schema_invalid', {
    action,
    provider_type: meta.provider_type,
    level: meta.structured_level,
    issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}:${i.code}`).join(','),
    raw_len: typeof raw === 'string' ? raw.length : 0,
  });
  const fb = minimalFallback(action, raw);
  const fbParsed = schemaFor(action).safeParse(fb);
  return {
    content: unwrap(action, fbParsed.success ? fbParsed.data : fb),
    degraded: true,
    reason: 'schema_validation_failed',
  };
}

/* ---------------- 主流程 ---------------- */

async function requestOnce(req, timeoutMs) {
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON 响应体，保留 text 供报错 */ }
  if (!res.ok) {
    const err = new Error(`LLM API ${res.status}: ${(text || res.statusText).slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return data;
}

/** 400 且报错提及 response_format / json_schema 时，说明该 endpoint 不支持当前级别，降一级重试 */
function shouldStepDown(err, cap) {
  if (err.status !== 400 || cap === 'prompt_only') return false;
  return /response_format|json_schema|output_config|schema|unsupported|unknown.*(field|parameter)/i.test(err.body || err.message || '');
}

function stepDown(cap) {
  return cap === 'json_schema' ? 'json_object' : 'prompt_only';
}

/**
 * 结构化调用 LLM。
 * @returns null（无 provider / 无密钥 / 调用失败，交由 runAI 走 mock）
 *          或 { content, model, meta:{ provider_type, model, structured_level, latency_ms, status, degraded_reason, usage } }
 */
async function callLLMStructured(system, user, action, provider) {
  if (!provider || provider.type === 'mock') return null;
  const apiKey = resolveApiKey(provider);
  if (!apiKey) {
    logger.warn('llm_no_api_key', { provider_id: provider.id, provider_type: provider.type });
    return null;
  }

  let cap = resolveCapability(provider);
  const timeoutMs = timeoutFor(provider);
  const started = Date.now();
  let attempt = 0;
  let lastErr = null;

  while (attempt < 2) {
    attempt += 1;
    // L2/L3 靠 prompt 传递 schema；L1 由 API 原生强约束，无需重复内嵌
    const sys = cap === 'json_schema' ? system : `${system}\n\n${schemaHint(action)}`;
    const req = buildRequest(provider, apiKey, sys, user, action, cap);
    try {
      const data = await requestOnce(req, timeoutMs);
      const raw = extractContent(provider.type, data);
      const parsed = extractJsonBlock(raw);
      const meta = { provider_type: provider.type, structured_level: levelTag(cap) };
      const { content, degraded, reason } = validateOrFallback(action, normalizeToShape(action, parsed, raw), raw, meta);
      const latency = Date.now() - started;
      logger.info('llm_call_ok', {
        action, provider_type: provider.type, model: provider.model, level: levelTag(cap),
        ms: latency, degraded, attempt,
      });
      return {
        content,
        model: degraded ? 'fallback' : 'llm',
        meta: {
          provider_id: provider.id, provider_type: provider.type, model: provider.model,
          structured_level: levelTag(cap), latency_ms: latency, attempt,
          status: degraded ? 'DEGRADED' : 'OK', degraded_reason: reason || null,
          ...extractUsage(provider.type, data),
        },
      };
    } catch (e) {
      lastErr = e;
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      logger.warn('llm_call_failed', {
        action, provider_type: provider.type, model: provider.model, level: levelTag(cap),
        status: e.status || null, timed_out: timedOut, attempt, ms: Date.now() - started,
        reason: timedOut ? 'timeout' : (e.status || e.name),
      });
      if (!timedOut && shouldStepDown(e, cap)) {
        cap = stepDown(cap);
        logger.info('llm_capability_stepdown', { action, provider_id: provider.id, to: cap });
        continue;
      }
      break;
    }
  }
  logger.warn('llm_degrade_to_mock', {
    action, provider_type: provider.type,
    reason: lastErr && (lastErr.name === 'TimeoutError' ? 'timeout' : (lastErr.status || lastErr.name)),
  });
  return null;
}

module.exports = {
  DEFAULT_TIMEOUT_MS, JSON_LITERAL_HINT,
  callLLMStructured, extractJsonBlock, extractContent, normalizeToShape,
  validateOrFallback, shouldStepDown, buildRequest,
};
