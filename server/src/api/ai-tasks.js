// B2：GET /admin/ai-tasks —— AI 调用记录（含降级原因，分页）。
// openapi.yaml:147（需 ADMIN，由 admin.js 的 admin.use(auth, adminOnly) 统一前置）。

'use strict';

const express = require('express');
const { ok, pageParams, pageBody } = require('./../http/envelope');
const aiTask = require('./../services/ai-task');

const router = express.Router();

router.get('/ai-tasks', (req, res) => {
  const { page, limit, offset } = pageParams(req.query, { defaultLimit: 20, maxLimit: 100 });
  const { items, total } = aiTask.listAiTasks({
    requirementId: req.query.requirement_id,
    status: req.query.status,
    limit,
    offset,
  });
  return ok(res, pageBody({ items, total, page, limit }));
});

module.exports = router;
