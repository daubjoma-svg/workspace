// 入口：只做装配（启动自检 → 迁移 → 种子 → 挂载路由 → 监听），不含业务逻辑。

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const secret = require('./crypto/secret');

// F1/AC-02：SOP_MASTER_KEY 缺失即 fail-fast 退出，绝不静默降级成明文存储。
// 必须在任何读写凭据的模块加载前执行。
secret.assertMasterKeyOrExit(logger);

const { router } = require('./routes');
const admin = require('./admin');
const { health, setMasterKeyStatus } = require('./health');
const { runMigrations, verifyMasterKey } = require('./migrate');
const seed = require('./seed');

const app = express();
app.use(express.json({ limit: '5mb' }));

// 健康检查必须在 /api 前缀下：catch-all 只排除 /api，挂在别处会被 HTML 兜底成假绿。
app.use('/api', health);
// ADR-007：/api/v1 与 /api 双挂载，新端点以 /api/v1 为准，存量调用保持可用。
app.use('/api/v1', router);
app.use('/api', router);
app.use('/api/v1/admin', admin);
app.use('/api/admin', admin);

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

setMasterKeyStatus(verifyMasterKey());   // 先自检存量密文，再迁移（迁移只加密未加密的行）
runMigrations();
seed();

app.listen(PORT, () => logger.info('server_started', { port: PORT, url: `http://localhost:${PORT}` }));
