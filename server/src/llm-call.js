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
const { isTimeout, isRetryableTransport, retryDelayMs, sleep, reasonOf } = require('./llm/retry');

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
    max_tokens: Number(p.max_tokens) || DEFAULT_MAX_TOKENS,
  };
  // Kimi For Coding (api.kimi.com/coding) 的 k3 模型只允许 temperature=1，传 0.3 会 400
  // 其他 OpenAI 兼容模型保持默认 0.3（更稳定的 JSON 输出）
  const isKimiCoding = /kimi\.com\/coding/i.test(p.base_url || '');
  if (!isKimiCoding) body.temperature = 0.3;
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
  const req = p.type === 'anthropic'
    ? buildAnthropicRequest(p, apiKey, system, user, action, cap)
    : buildOpenAIRequest(p, apiKey, system, user, action, cap);
  // 透传 provider_type，让 requestOnce 能识别 CLI 类 provider（trae-cli）走本地进程调用
  req.provider_type = p.type;
  req.trae_token = apiKey || '';
  return req;
}

/* ---------------- 响应解析 ---------------- */

function extractContent(type, data) {
  if (!data) return '';
  if (type === 'anthropic') return (data.content || []).map((c) => c.text || '').join('\n');
  // OpenAI 兼容：content 为空时回退 reasoning_content（Kimi/DeepSeek 推理模型把思考放此字段）
  const msg = data.choices?.[0]?.message;
  const content = msg?.content ?? '';
  if (String(content).trim()) return content;
  const reasoning = msg?.reasoning_content ?? '';
  return String(reasoning).trim();
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

/**
 * trae-cli 本地进程调用（Trae 没有公开 HTTP API，但 CLI 登录令牌 trae-lt-xxx 可用）
 * 执行 `traecli --print --output-format json <prompt>`，返回与 OpenAI 兼容结构，
 * 让上游 extractContent / stepCall / aiChat 完全无感。
 */
async function traeCliOnce(req, timeoutMs) {
  const { execFile } = require('child_process');
  const bin = process.env.TRAECLI_BIN || '/Users/admin/.local/bin/traecli';
  const base = req.body.messages ? req.body.messages.map((m) => m.content || '').join('\n\n---\n\n') : (req.body?.prompt || '');
  const prompt = base;
  // traecli 单次含登录 token 交换 + 模型推理，15s 不够（实测 15s 会静默空输出）；固定 60s
  const timeoutSec = 60;
  // 调试：traecli 触发 agent mode 的阈值与 prompt 长度有关——打印 prompt 长度便于排查
  logger.warn('traecli_prompt_len', { len: prompt.length, head120: prompt.slice(0, 120).replace(/\n/g, ' ') });
  return new Promise((resolve, reject) => {
    execFile(bin, ['--print', '--output-format', 'json', '--query-timeout', `${timeoutSec}s`, prompt], {
      timeout: 70000, // traecli 固定 70s（query-timeout 60s + 缓冲），不受上层 15s fast-fail 影响
      env: { ...process.env, HOME: process.env.HOME || '/Users/admin', TRAECLI_PERSONAL_ACCESS_TOKEN: req.trae_token || '' },
      maxBuffer: 20 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) {
        reject(new Error(`traecli 调用失败: ${String(err.message).slice(0, 200)}`));
        return;
      }
      let data = null;
      try { data = JSON.parse(stdout); } catch { /* 非 JSON，取原文 */ }

      // 判断一段 content 是否是 traecli 内部注入的系统提示（不应作为用户可见输出）
      const isInternalInject = (s) => {
        if (!s || typeof s !== 'string') return true;
        const t = s.trim();
        if (!t) return true;
        if (t.includes('<system-reminder>') || t.includes('\\u003csystem-reminder\\u003e')) return true;
        if (/^Deferred Tools Directory/i.test(t)) return true;
        if (/Additional tools from MCP servers/i.test(t) && t.length < 1200) return true;
        if (/^# Deferred Tools/i.test(t)) return true;
        if (/^You must use (Chinese|中文)/i.test(t)) return true;
        // agent 内部的工具调用/结果 JSON dump
        if (/^\{"?tool(_call|_result)?"?\s*:/.test(t)) return true;
        return false;
      };
      // 判断一段 content 是否是用户原始 prompt（不要回显 prompt 本身当答案）
      const isUserPromptEcho = (s) => /^你是(全局管理员|CSM|产品经理|研发负责人|测试负责人)/.test(s);

      // 从一条消息对象里取出最可能是模型给用户看的纯文本
      const pickText = (m) => {
        if (!m) return '';
        // assistant 消息可能是字符串或 { type: 'text', text: ... } 数组
        let c = m.content;
        if (Array.isArray(c)) c = c.map((x) => (x && typeof x === 'object' ? (x.text || '') : String(x || ''))).join('\n');
        c = String(c || '').trim();
        // 去掉 traecli 注入的 <system-reminder>...</system-reminder> 标签块
        c = c.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
        c = c.replace(/\\u003csystem-reminder\\u003e[\s\S]*?\\u003c\/system-reminder\\u003e/gi, '').trim();
        return c;
      };

      let content = '';
      let model = 'trae-cli';
      if (data) {
        // 1) 遍历所有 agent_state 的所有 messages，取最后一条「真正的 assistant 回复」
        const states = Array.isArray(data.agent_states) ? data.agent_states : [];
        const candidates = [];
        for (const st of states) {
          const msgs = Array.isArray(st && st.messages) ? st.messages : [];
          for (let i = msgs.length - 1; i >= 0; i -= 1) {
            const m = msgs[i];
            if (!m) continue;
            const txt = pickText(m);
            if (!txt) continue;
            // assistant 消息且非内部注入、非 prompt 回显 → 最高优先级候选
            if (m.role === 'assistant' && !isInternalInject(txt) && !isUserPromptEcho(txt)) {
              candidates.push({ txt, src: m, agent: st });
            }
          }
        }
        if (candidates.length > 0) {
          // 取最后（最新）一条
          content = String(candidates[0].txt);
          const srcModel = candidates[0].src?.extra?._source_model
            || candidates[0].agent?._source_model
            || data.message?.extra?._source_model;
          if (srcModel) model = srcModel;
        } else {
          // 2) 顶层常见字段回退
          const topKeys = ['final_answer', 'final_result', 'answer', 'result', 'response', 'output', 'reply', 'text'];
          for (const k of topKeys) {
            const v = data[k];
            if (typeof v === 'string' && v.trim() && !isInternalInject(v)) { content = v.trim(); break; }
          }
          // 3) data.message.content（可能是完整 messages 数组，也可能是纯文本）
          if (!content) {
            const mc = data.message?.content;
            if (typeof mc === 'string') {
              const cleaned = pickText({ content: mc });
              if (!isInternalInject(cleaned) && !isUserPromptEcho(cleaned)) content = cleaned;
            } else if (Array.isArray(mc)) {
              for (let i = mc.length - 1; i >= 0; i -= 1) {
                const t = pickText(mc[i]);
                if (t && !isInternalInject(t) && !isUserPromptEcho(t)) { content = t; break; }
              }
            }
          }
        }
      }

      if (content) {
        resolve({
          choices: [{ message: { role: 'assistant', content, reasoning_content: '' } }],
          model,
          usage: { prompt_tokens: null, completion_tokens: null },
        });
        return;
      }
      // 兜底：拿不到有效文本时返回明确失败，而不是把内部 JSON dump 出来
      resolve({
        choices: [{ message: { role: 'assistant', content: '', reasoning_content: '' } }],
        model: 'trae-cli',
        _parse_failed: true,
        usage: { prompt_tokens: null, completion_tokens: null },
      });
    });
  });
}

async function requestOnce(req, timeoutMs) {
  // CLI 类 provider：走本地 traecli 进程（Trae 无公开 HTTP API）
  if (req.provider_type === 'trae-cli') {
    return traeCliOnce(req, timeoutMs);
  }
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
    // 429 退避时长以服务端 Retry-After 为准，不用本地拍脑袋的固定值
    err.retryAfter = typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null;
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

// 循环保护上限：能力降级最多 2 次 + 传输重试 1 次 + 内容重试 1 次 + 首次调用
const MAX_ATTEMPTS = 5;

/** 无 provider / 无密钥 / 全部重试耗尽时的统一失败出口，带上重试次数供 ai_tasks 记录 */
function failure(reason, attempt, provider, startedAt) {
  return {
    failed: true,
    meta: {
      provider_id: provider ? provider.id : null,
      provider_type: provider ? provider.type : null,
      model: provider ? provider.model : null,
      status: 'DEGRADED',
      degraded_reason: reason,
      attempt,
      latency_ms: startedAt ? Date.now() - startedAt : null,
    },
  };
}

/**
 * 结构化调用 LLM。
 * @returns { content, model, meta } 成功；或 { failed:true, meta } 失败（由 runAI 走 mock 降级）。
 *          meta.structured_level 用 capability 词表（json_schema/json_object/prompt_only），
 *          与 artifact.meta 锁定契约一致；L1/L2/L3 标签只用于日志。
 */
async function callLLMStructured(system, user, action, provider) {
  if (!provider || provider.type === 'mock') return failure('no_provider', 0, provider, null);
  const apiKey = resolveApiKey(provider);
  // trae-cli 走本地进程，无 key 也可用（本机登录态）
  if (!apiKey && provider.type !== 'trae-cli') {
    logger.warn('llm_no_api_key', { provider_id: provider.id, provider_type: provider.type });
    return failure('no_api_key', 0, provider, null);
  }

  let cap = resolveCapability(provider);
  const timeoutMs = timeoutFor(provider);
  const started = Date.now();
  let attempt = 0;
  let transportRetried = false;   // AC-05：429/5xx/超时 的一次重试预算
  let contentRetried = false;     // AC-11：schema 校验失败 的一次重试预算
  let lastErr = null;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    // L2/L3 靠 prompt 传递 schema；L1 由 API 原生强约束，无需重复内嵌
    const sys = cap === 'json_schema' ? system : `${system}\n\n${schemaHint(action)}`;
    const req = buildRequest(provider, apiKey, sys, user, action, cap);
    try {
      const data = await requestOnce(req, timeoutMs);
      const raw = extractContent(provider.type, data);
      const parsed = extractJsonBlock(raw);
      const logMeta = { provider_type: provider.type, structured_level: levelTag(cap) };
      const { content, degraded, reason } = validateOrFallback(action, normalizeToShape(action, parsed, raw), raw, logMeta);

      // AC-11：结构不合规先原级重试 1 次，第二次仍不合规才落 minimalFallback
      if (degraded && reason === 'schema_validation_failed' && !contentRetried) {
        contentRetried = true;
        logger.warn('llm_content_retry', {
          action, provider_type: provider.type, level: levelTag(cap), attempt,
          raw_preview: typeof raw === 'string' ? raw.slice(0, 200) : '',
        });
        await sleep(retryDelayMs(null, 1));
        continue;
      }

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
          structured_level: cap, latency_ms: latency, attempt,
          status: degraded ? 'DEGRADED' : 'OK', degraded_reason: reason || null,
          ...extractUsage(provider.type, data),
        },
      };
    } catch (e) {
      lastErr = e;
      logger.warn('llm_call_failed', {
        action, provider_type: provider.type, model: provider.model, level: levelTag(cap),
        status: e.status || null, timed_out: isTimeout(e), attempt, ms: Date.now() - started,
        reason: reasonOf(e),
      });
      if (!isTimeout(e) && shouldStepDown(e, cap)) {
        cap = stepDown(cap);
        logger.info('llm_capability_stepdown', { action, provider_id: provider.id, to: cap });
        continue;
      }
      // AC-05：限流/服务端错误/超时 退避后重试 1 次
      if (isRetryableTransport(e) && !transportRetried) {
        transportRetried = true;
        const wait = retryDelayMs(e, attempt);
        logger.info('llm_transport_retry', { action, provider_id: provider.id, reason: reasonOf(e), wait_ms: wait });
        await sleep(wait);
        continue;
      }
      break;
    }
  }
  const reason = reasonOf(lastErr);
  logger.warn('llm_degrade_to_mock', { action, provider_type: provider.type, reason, attempt });
  return failure(reason, attempt, provider, started);
}

module.exports = {
  DEFAULT_TIMEOUT_MS, JSON_LITERAL_HINT, MAX_ATTEMPTS,
  callLLMStructured, extractJsonBlock, extractContent, normalizeToShape,
  validateOrFallback, shouldStepDown, stepDown, buildRequest, requestOnce, failure,
};
