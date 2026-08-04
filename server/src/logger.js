// 结构化日志：单行 key=value，便于 grep 与后续接入日志聚合。
// 约束：不打印任何凭据明文；调用方只传入已脱敏的字段。

'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function fmtValue(v) {
  if (v == null) return '-';
  if (v instanceof Error) return JSON.stringify(`${v.name}: ${v.message}`);
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return '"[unserializable]"'; }
  }
  if (typeof v === 'string') return /[\s="]/.test(v) ? JSON.stringify(v) : v;
  return String(v);
}

function emit(level, event, fields) {
  if (LEVELS[level] < MIN) return;
  const parts = [`ts=${new Date().toISOString()}`, `level=${level}`, `event=${event}`];
  for (const [k, v] of Object.entries(fields || {})) parts.push(`${k}=${fmtValue(v)}`);
  const line = parts.join(' ');
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  debug: (event, fields) => emit('debug', event, fields),
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};
