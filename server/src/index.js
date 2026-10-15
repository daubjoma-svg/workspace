// 入口：只做装配（启动自检 → 迁移 → 种子 → 挂载路由 → 监听），不含业务逻辑。

'use strict';

// 必须最先加载：从 server/.env 补齐 DB/SOP_MASTER_KEY 等配置，供后续模块读取。
require('./env');

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const logger = require('./logger');
const secret = require('./crypto/secret');

// F1/AC-02：SOP_MASTER_KEY 缺失即 fail-fast 退出，绝不静默降级成明文存储。
// 必须在任何读写凭据的模块加载前执行。
secret.assertMasterKeyOrExit(logger);

const { health, setMasterKeyStatus } = require('./health');
const seed = require('./seed');
const { verifyConnection, close } = require('./db');
const { runSchemaMigrations } = require('./db-migrator');

const app = express();
// 上传接口的图片 base64 可达 ~6.7MB（5MB 图片经 base64 膨胀），超出全局 5mb 限制，
// 故在全局解析前为 /api/uploads 单独放宽到 8mb（body-parser 已解析过则后续解析器自动跳过）。
app.use('/api/uploads', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '5mb' }));

// 健康检查必须在 /api 前缀下：catch-all 只排除 /api，挂在别处会被 HTML 兜底成假绿。
app.use('/api', health);

// 图片上传目录：启动即保证存在；/uploads 只读静态托管，图片 URL 公开（前端拼 http://localhost:4000 前缀）
const uploadsDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// 生产模式：托管前端构建产物
const dist = path.join(__dirname, '..', '..', 'web', 'dist');
app.use(express.static(dist));
app.get(/^(?!\/api).*/, (req, res) => {
  const indexHtml = path.join(dist, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    return res.status(503).json({ error: '前端构建产物缺失，请先执行 web 构建（npm run build）' });
  }
  return res.sendFile(indexHtml);
});

// 兜底错误处理：不向客户端暴露堆栈，只回错误码
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) logger.error('unhandled_error', { path: req.path, reason: err.message });
  res.status(status).json({ error: status >= 500 ? '服务内部错误' : err.message });
});

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';

function lanIps() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if ((net.family === 'IPv4' || net.family === 4) && !net.internal) out.push(net.address);
    }
  }
  return out;
}

async function start() {
  await verifyConnection();
  await runSchemaMigrations();
  await seed();
  // 路由模块在表结构完成后再加载，避免启动期模块自检访问未建表数据库。
  // 数据迁移：存量库的 AI 节点提示词升级为「按需求规模裁剪」版本（幂等）。
  try {
    await require('./migrate').runMigrations();
  } catch (e) {
    logger.error('data_migration_failed', { reason: e.message });
  }
  const { router } = require('./routes');
  const admin = require('./admin');
  // 自愈：重启会杀掉进程内的 AI 执行，先把上次遗留的 AI_RUNNING 需求落成 AI_FAILED，
  // 否则它们没有 worker 会去结束，前端会永远显示「AI 处理中」。自愈失败不应阻断启动。
  try {
    await require('./engine').recoverOrphanedRuns();
  } catch (e) {
    logger.error('ai_orphan_recover_failed', { reason: e.message });
  }
  app.use('/api/v1', router);
  app.use('/api', router);
  app.use('/api/v1/admin', admin);
  app.use('/api/admin', admin);
  app.listen(PORT, HOST, () => {
    logger.info('server_started', { host: HOST, port: PORT, url: `http://localhost:${PORT}` });
    for (const ip of lanIps()) logger.info('lan_url', { url: `http://${ip}:${PORT}` });
  });
}

start().catch((error) => {
  logger.error('server_start_failed', { reason: error.message });
  close().catch(() => {});
  process.exitCode = 1;
});
