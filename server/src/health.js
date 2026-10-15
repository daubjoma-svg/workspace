// 健康检查（OPS-B3）：必须挂在 /api 前缀下。
// index.js 的 catch-all `app.get(/^(?!\/api).*/)` 只排除 /api，若挂 /health 会命中 catch-all
// 恒返回 200 + HTML，形成"数据库挂了监控还是绿灯"的假绿陷阱。
//
// 免认证：监控需要匿名探测。因此响应体只暴露 ok/fail，不含密钥值、长度、路径等任何敏感信息。

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');
const secret = require('./crypto/secret');
const logger = require('./logger');

const START_AT = Date.now();
const DIST_INDEX = path.join(__dirname, '..', '..', 'web', 'dist', 'index.html');

let VERSION = '0.0.0';
try { VERSION = require('../package.json').version || '0.0.0'; } catch { /* 保持默认 */ }

// 主密钥自检结论由启动期 setMasterKeyStatus 写入（试解一条存量密文）。
// 运维诉求：区分"没配 key"与"key 配错了"，不重蹈 BLOCKER-2 覆辙。
let masterKeyStatus = 'unknown';
function setMasterKeyStatus(status) { masterKeyStatus = status; }

/** db 探针：执行真实查询，不能只判断对象存在 */
async function checkDb() {
  try {
    const row = await db.one('SELECT 1 AS ok', []);
    return row && row.ok === 1 ? 'ok' : 'fail';
  } catch (e) {
    logger.error('health_db_fail', { reason: e.message });
    return 'fail';
  }
}

/** dist 探针：缺失时所有非 API 路由 sendFile 会 ENOENT 500，必须探得到 */
function checkDist() {
  return fs.existsSync(DIST_INDEX) ? 'ok' : 'fail';
}

/** master_key 探针：只回 ok/fail，绝不回显密钥值或长度 */
function checkMasterKey() {
  if (!secret.isConfigured()) return 'fail';
  return masterKeyStatus === 'mismatch' ? 'fail' : 'ok';
}

async function collect() {
  const checks = { db: await checkDb(), dist: checkDist(), master_key: checkMasterKey() };
  const healthy = Object.values(checks).every((v) => v === 'ok');
  return {
    status: healthy ? 'ok' : 'degraded',
    checks,
    uptime: Math.floor((Date.now() - START_AT) / 1000),
    version: VERSION,
  };
}

const health = express.Router();
health.get('/health', async (req, res) => {
  const body = await collect();
  if (body.status !== 'ok') logger.warn('health_degraded', body.checks);
  res.status(body.status === 'ok' ? 200 : 503).json(body);
});

module.exports = { health, collect, setMasterKeyStatus, checkDb, checkDist, checkMasterKey };
