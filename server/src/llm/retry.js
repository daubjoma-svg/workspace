// AC-05 / AC-11 重试策略（纯函数 + 一个 sleep，便于单测）。
//
// 两类重试，各自独立计一次预算，互不吞噬：
//   传输级（AC-05）：429 / 5xx / 超时  -> 退避后重试 1 次，仍失败才降级 Mock
//   内容级（AC-11）：schema 校验失败    -> 重试 1 次同级调用，二次失败才走 minimalFallback
// 4xx（除 429）不重试：鉴权错误、参数错误重试只会再错一遍并放大配额消耗。

'use strict';

const BASE_DELAY_MS = Number(process.env.LLM_RETRY_BASE_MS || 800);
const MAX_DELAY_MS = Number(process.env.LLM_RETRY_MAX_MS || 5000);

function isTimeout(err) {
  return !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** 传输层是否值得重试：限流、服务端错误、超时、以及 fetch 本身的网络异常（无 status） */
function isRetryableTransport(err) {
  if (!err) return false;
  if (isTimeout(err)) return true;
  const s = Number(err.status);
  if (!Number.isFinite(s)) return true;          // TypeError: fetch failed 之类的网络抖动
  return s === 429 || (s >= 500 && s <= 599);
}

/** Retry-After 支持「秒数」与「HTTP-date」两种形态，解析不出来返回 null 交给默认退避 */
function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_DELAY_MS);
  const ts = Date.parse(value);
  if (Number.isFinite(ts)) return Math.min(Math.max(ts - Date.now(), 0), MAX_DELAY_MS);
  return null;
}

/** 退避时长：优先服务端 Retry-After，否则按 attempt 指数退避，统一封顶 MAX_DELAY_MS */
function retryDelayMs(err, attempt = 1) {
  const fromHeader = parseRetryAfter(err && err.retryAfter);
  if (fromHeader != null) return fromHeader;
  return Math.min(BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)), MAX_DELAY_MS);
}

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/** 降级原因归一化，落进 ai_tasks.degraded_reason 供管理端聚合 */
function reasonOf(err) {
  if (!err) return 'unknown';
  if (isTimeout(err)) return 'timeout';
  if (err.status === 429) return 'rate_limited';
  if (Number.isFinite(Number(err.status))) return `http_${err.status}`;
  return err.name || 'network_error';
}

module.exports = {
  BASE_DELAY_MS, MAX_DELAY_MS,
  isTimeout, isRetryableTransport, parseRetryAfter, retryDelayMs, sleep, reasonOf,
};
