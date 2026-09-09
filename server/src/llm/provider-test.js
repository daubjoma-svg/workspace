// AI Provider 连通性测试：用真实 base_url/model/key 发一次极简请求。
// 参照 llm-call.js 的调用方式（OpenAI 兼容 /v1/chat/completions；anthropic 走 /v1/messages）。
// 超时 10s；不重试、不降级——测试只回答"这个 Provider 现在能不能通"。
// api_key 只用于请求头，绝不落日志、绝不进返回值。

'use strict';

const REQUEST_TIMEOUT_MS = 10000;
const TEST_PROMPT = '用一句话介绍一下你自己（30字以内）';

/** mock 类型无真实 endpoint，直接回成功（离线演示语义） */
function mockResult(provider) {
  return {
    reply: 'Mock Provider 连接正常（离线演示，未发起真实请求）',
    model: provider.model || 'mock',
  };
}

function buildTestRequest(provider, apiKey) {
  const base = String(provider.base_url || '').replace(/\/+$/, '') || 'https://api.openai.com';
  if (provider.type === 'anthropic') {
    return {
      url: `${base}/v1/messages`,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: {
        model: provider.model || 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: TEST_PROMPT }],
      },
    };
  }
  return {
    url: `${base}/v1/chat/completions`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: {
      model: provider.model || 'gpt-4o-mini',
      max_tokens: 64,
      messages: [{ role: 'user', content: TEST_PROMPT }],
    },
  };
}

function extractReply(type, data) {
  if (!data) return '';
  if (type === 'anthropic') return (data.content || []).map((c) => c.text || '').join('\n');
  // OpenAI 兼容：content 为空时回退 reasoning_content（Kimi/DeepSeek 推理模型把思考放此字段）
  const msg = data.choices?.[0]?.message;
  const content = msg?.content ?? '';
  if (String(content).trim()) return content;
  const reasoning = msg?.reasoning_content ?? '';
  return String(reasoning).trim();
}

/**
 * 测试 Provider 连通性。
 * @returns {{ reply: string, model: string|null }}
 * @throws {Error} 任何失败（HTTP 非 2xx / 超时 / 返回格式异常），错误信息不含 api_key
 */
async function testProvider(provider, apiKey) {
  if (!provider || provider.type === 'mock') return mockResult(provider);
  // trae-cli：走本机 traecli 进程做一次真实调用（不依赖 HTTP API）
  if (provider.type === 'trae-cli') {
    const { execFile } = require('child_process');
    const bin = process.env.TRAECLI_BIN || '/Users/admin/.local/bin/traecli';
    return new Promise((resolve, reject) => {
      execFile(bin, ['--print', '--output-format', 'json', '--query-timeout', '40s', '只回复两个字：你好'], {
        timeout: 60000, // traecli 含登录 token 交换 + 模型推理，10s 不够；单独 60s
        env: { ...process.env, HOME: process.env.HOME || '/Users/admin', TRAECLI_PERSONAL_ACCESS_TOKEN: apiKey || '' },
        maxBuffer: 20 * 1024 * 1024,
      }, (err, stdout) => {
        if (err) return reject(new Error(`Trae CLI 调用失败：${String(err.message).slice(0, 150)}`));
        try {
          const data = JSON.parse(stdout);
          const reply = data?.message?.content;
          if (!reply) return reject(new Error('Trae CLI 返回无内容'));
          return resolve({ reply: String(reply).slice(0, 100), model: data?.message?.extra?._source_model || 'trae-cli' });
        } catch { return reject(new Error(`Trae CLI 输出解析失败：${String(stdout).slice(0, 150)}`)); }
      });
    });
  }
  const { url, headers, body } = buildTestRequest(provider, apiKey);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    // 网络层失败（连接拒绝 / 超时 / DNS）直接给可读信息，不暴露 api_key
    const cause = (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || '网络错误';
    throw new Error(`Provider 请求失败：${cause}`);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON 响应体，保留 text 供报错 */ }
  if (!res.ok) {
    const detail = (data && (data.error?.message || data.message))
      || text.slice(0, 300)
      || res.statusText;
    throw new Error(`Provider 测试失败 HTTP ${res.status}：${detail}`);
  }
  const reply = extractReply(provider.type, data);
  if (!reply) throw new Error(`Provider 返回格式异常：${text.slice(0, 200)}`);
  return { reply, model: provider.model || null };
}

module.exports = { testProvider, REQUEST_TIMEOUT_MS, buildTestRequest, extractReply };
