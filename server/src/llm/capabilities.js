// Provider 结构化输出能力矩阵（架构文档 §3.5 的代码化）。
// "OpenAI 兼容"只保证基础字段兼容，response_format 支持度各家差异极大：
//   json_schema  强约束（OpenAI / Kimi / Anthropic output_config）
//   json_object  弱约束（DeepSeek / GLM / 通义）—— prompt 必须含 "json" 字面量，否则 400
//   prompt_only  接口无 response_format 字段（混元 / MiniMax / 未知自建网关）

'use strict';

const LEVELS = ['json_schema', 'json_object', 'prompt_only'];
const LEVEL_TO_TAG = { json_schema: 'L1', json_object: 'L2', prompt_only: 'L3' };

// base_url 关键词 → 能力。未命中的一律按最保守的 prompt_only 处理。
const ENDPOINT_HINTS = [
  [/deepseek/i, 'json_object'],
  [/bigmodel\.cn|open\.bigmodel|zhipu|glm/i, 'json_object'],
  [/dashscope|aliyuncs|bailian|qwen|tongyi/i, 'json_object'],
  [/moonshot|kimi/i, 'json_schema'],
  [/api\.openai\.com|azure.*openai/i, 'json_schema'],
  [/hunyuan|tencentcloudapi/i, 'prompt_only'],
  [/minimax/i, 'prompt_only'],
];

function isValidCapability(cap) {
  return LEVELS.includes(cap);
}

/** 按 endpoint 推断能力，用于存量 provider 回填与新建时给默认值 */
function inferCapability(type, baseUrl) {
  if (type === 'anthropic') return 'json_schema';
  if (type === 'mock') return 'json_schema';
  const url = String(baseUrl || '');
  for (const [re, cap] of ENDPOINT_HINTS) {
    if (re.test(url)) return cap;
  }
  return 'prompt_only';
}

/** 取生效能力：显式配置优先，非法值回落到推断值 */
function resolveCapability(provider) {
  if (!provider) return 'prompt_only';
  if (isValidCapability(provider.capability)) return provider.capability;
  return inferCapability(provider.type, provider.base_url);
}

function levelTag(capability) {
  return LEVEL_TO_TAG[capability] || 'L3';
}

module.exports = { LEVELS, isValidCapability, inferCapability, resolveCapability, levelTag };
