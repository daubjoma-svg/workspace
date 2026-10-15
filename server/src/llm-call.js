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

/**
 * L3 抽取：先取代码围栏，再扫描字符串感知的平衡 JSON 片段。
 * Trae 有时会在最终 JSON 前后输出说明，或一次返回多个事件；直接取首个/末个括号会把多个对象拼成非法 JSON。
 */
function extractJsonBlock(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fenced ? [fenced[1]] : [];

  // 扫描所有平衡的对象/数组候选，忽略字符串中的括号，避免嵌套描述或多对象输出破坏截取范围。
  const scanBalanced = (source) => {
    const out = [];
    for (let start = 0; start < source.length; start += 1) {
      if (source[start] !== '{' && source[start] !== '[') continue;
      const stack = [];
      let quote = false;
      let escaped = false;
      for (let i = start; i < source.length; i += 1) {
        const ch = source[i];
        if (quote) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') quote = false;
          continue;
        }
        if (ch === '"') { quote = true; continue; }
        if (ch === '{' || ch === '[') stack.push(ch);
        else if (ch === '}' || ch === ']') {
          const open = stack.pop();
          if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) break;
          if (!stack.length) {
            out.push(source.slice(start, i + 1));
            break;
          }
        }
      }
    }
    return out;
  };

  candidates.push(...scanBalanced(text));
  candidates.push(text);
  for (const c of candidates) {
    try {
      const v = JSON.parse(String(c).trim());
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

/** traecli 内部注入的内容（系统提示 / 工具调用 JSON dump），不应作为用户可见输出 */
function isTraeInternalInject(s) {
  if (!s || typeof s !== 'string') return true;
  const t = s.trim();
  if (!t) return true;
  if (t.includes('<system-reminder>') || t.includes('\\u003csystem-reminder\\u003e')) return true;
  if (/^Deferred Tools Directory/i.test(t)) return true;
  if (/Additional tools from MCP servers/i.test(t) && t.length < 1200) return true;
  if (/^# Deferred Tools/i.test(t)) return true;
  if (/^\{"?tool(_call|_result)?"?\s*:/.test(t)) return true;
  return false;
}

/** 去掉 traecli 注入的 <system-reminder> 标签块 */
function cleanTraeContent(s) {
  return String(s || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/\\u003csystem-reminder\\u003e[\s\S]*?\\u003c\/system-reminder\\u003e/gi, '')
    .trim();
}

/**
 * 解析 traecli `exec --json` 的 JSONL 事件流，取最后一条 agent_message 作为最终回复。
 * 例：{"type":"item.completed","item":{"type":"agent_message","text":"你好"}}
 */
function parseTraeCliJsonl(stdout) {
  let content = '';
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev = null;
    try { ev = JSON.parse(t); } catch { continue; }
    if (!ev || ev.type !== 'item.completed') continue;
    const item = ev.item || {};
    if (item.type !== 'agent_message' || typeof item.text !== 'string') continue;
    const text = cleanTraeContent(item.text);
    if (!text || isTraeInternalInject(text)) continue;
    content = text;
  }
  return content;
}

/**
 * 运行本机 traecli，stdout/stderr 重定向到临时文件再读取。
 * 不能用 Node 的管道（execFile 默认）：traecli 2.x 在 Node socketpair 管道上启动阶段会卡死、
 * 零输出直到超时；重定向到普通文件则正常（shell 的 `> file` / `| head` 均可）。
 *
 * 沙箱：子进程一律经 spawnSandboxed 启动（Seatbelt 只读边界 + 隔离环境），
 * env 参数仅用于透传 TRAECLI_PERSONAL_ACCESS_TOKEN，绝不继承 process.env。
 */
function runTraeCli(bin, args, { timeoutMs, env, stdinFile } = {}) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSandboxed, sandboxEnv, REPOS_DIR } = require('./sandbox/seatbelt');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecli-'));
  const outPath = path.join(dir, 'out.jsonl');
  const errPath = path.join(dir, 'err.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  // 有 stdinFile 时把 prompt 用普通文件描述符喂给 stdin（不是 socketpair 管道，避免 2.x 启动卡死）
  const inFd = stdinFile ? fs.openSync(stdinFile, 'r') : null;
  return new Promise((resolve) => {
    let timedOut = false;
    let spawnError = null;
    const child = spawnSandboxed(bin, args, {
      env: sandboxEnv({ TRAECLI_PERSONAL_ACCESS_TOKEN: (env && env.TRAECLI_PERSONAL_ACCESS_TOKEN) || '' }),
      stdio: [inFd == null ? 'ignore' : inFd, outFd, errFd],
    });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Number(timeoutMs) || 70000);
    const finish = (code, signal) => {
      clearTimeout(timer);
      let stdout = '';
      let stderr = '';
      try { stdout = fs.readFileSync(outPath, 'utf8'); } catch { /* 读取失败按空处理 */ }
      try { stderr = fs.readFileSync(errPath, 'utf8'); } catch { /* 同上 */ }
      try { fs.closeSync(outFd); fs.closeSync(errFd); } catch { /* 已关闭 */ }
      if (inFd != null) { try { fs.closeSync(inFd); } catch { /* 已关闭 */ } }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
      resolve({ code, signal, stdout, stderr, timedOut, spawnError });
    };
    child.on('error', (e) => { spawnError = e.message; finish(-1, 'ERROR'); });
    child.on('exit', finish);
  });
}

/**
 * trae-cli 本地进程调用（Trae 没有公开 HTTP API，但 CLI 登录令牌 trae-lt-xxx 可用）。
 * traecli 2.x 非交互统一走 `exec` 子命令：`traecli exec --json [-m model] <prompt>`，
 * 输出 JSONL 事件流；旧的 `--print/--output-format/--query-timeout` 顶层参数已移除。
 * 返回与 OpenAI 兼容结构，让上游 extractContent / stepCall / aiChat 完全无感。
 */
async function traeCliOnce(req, timeoutMs) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { REPOS_DIR } = require('./sandbox/seatbelt');
  const bin = process.env.TRAECLI_BIN || '/Users/admin/.local/bin/traecli';
  const prompt = req.body.messages ? req.body.messages.map((m) => m.content || '').join('\n\n---\n\n') : (req.body?.prompt || '');
  const model = req.body?.model || '';
  // trae_cli：让 traecli 原生 Agent 能力（自主 grep/read/glob + 读图）跑起来的挂载参数
  //   cwd      主工作区（首选仓库快照，traecli 以它为 root 探索）
  //   addDirs  其余仓库快照（--add-dir，AI 可跨仓联查前后端）
  //   images   本地图片绝对路径（--image，视觉理解用户截图）
  //   sandbox  'read-only'：只读探索，杜绝 AI 改快照
  const opts = req.trae_cli || {};
  const images = (Array.isArray(opts.images) ? opts.images : []).filter((x) => typeof x === 'string' && x);
  const okResult = (content, extra = {}) => ({
    choices: [{ message: { role: 'assistant', content, reasoning_content: '' } }],
    model: model || 'trae-cli',
    usage: { prompt_tokens: null, completion_tokens: null },
    ...extra,
  });

  // ACP 传输：图片以 base64 content block 直接交给模型做多模态理解。
  // `exec -i` 会把本地图片转成内部 CDN 短路径，自定义 OpenAI 兼容 provider（如阿里云 MaaS）
  // 会以 `Unsupported image_url format` 拒绝；ACP 无此问题，且同样保留自主检索/读文件能力。
  if (opts.transport === 'acp' || images.length) {
    const { runAcpPrompt } = require('./agent/acp-client');
    const acp = await runAcpPrompt({
      bin,
      model,
      cwd: opts.cwd,
      addDirs: Array.isArray(opts.addDirs) ? opts.addDirs : [],
      // 不透传 bypass：acp-client 内部会强制降级为 default（只读探索）
      permissionMode: opts.permissionMode && !String(opts.permissionMode).startsWith('bypass')
        ? opts.permissionMode
        : undefined,
      prompt,
      images,
      timeoutMs: Math.max(Number(timeoutMs) || 0, 70000),
      env: { TRAECLI_PERSONAL_ACCESS_TOKEN: req.trae_token || '' },
    });
    if (acp.content) return okResult(acp.content, { _acp_usage: acp.usage || null, _stop_reason: acp.stopReason || null });
    return { ...okResult(''), _parse_failed: true };
  }

  const args = ['exec', '--skip-git-repo-check', '--json'];
  if (model) args.push('-m', model);
  // 只读策略：模型生成的 shell 命令一律按只读执行（Seatbelt 之外的第二道闸）
  args.push('-s', 'read-only');
  if (opts.permissionMode && !String(opts.permissionMode).startsWith('bypass')) {
    args.push('--permission-mode', String(opts.permissionMode));
  }
  // 工作目录：优先业务传入的仓库快照根；没有就落在 repos 根（绝不落到服务器目录）
  args.push('-C', String(opts.cwd || REPOS_DIR));
  for (const d of (Array.isArray(opts.addDirs) ? opts.addDirs : [])) {
    if (d) args.push('--add-dir', String(d));
  }
  args.push(prompt);
  // traecli 含登录 token 交换 + 模型推理，给足超时
  const result = await runTraeCli(bin, args, {
    timeoutMs: Math.max(Number(timeoutMs) || 0, 70000),
    env: { TRAECLI_PERSONAL_ACCESS_TOKEN: req.trae_token || '' },
  });
  const { code, stdout, stderr, timedOut, spawnError } = result;
  const content = parseTraeCliJsonl(stdout);
  if (content) return okResult(content);
  if (timedOut) throw new Error('traecli 调用超时（未在超时时间内返回）');
  if (spawnError) throw new Error(`traecli 启动失败: ${spawnError}`);
  if (code !== 0) throw new Error(`traecli 调用失败: ${String(stderr || `exit ${code}`).slice(0, 300)}`);
  // 兜底：退出码 0 但拿不到有效文本时返回明确失败，而不是把内部 JSON dump 出来
  return { ...okResult(''), _parse_failed: true };
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
  parseTraeCliJsonl, runTraeCli,
};
